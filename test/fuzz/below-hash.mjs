// Below the hash check. hostile.mjs mutates the wire, so inflate, the trailer, or the oid check rejects the
// object before a parser runs. This stage mutates the decompressed object, re-hashes it, and serves that oid from a
// tiny v2 server. The oracle is `git fsck --strict` on the same bytes (`hash-object --literally`). ply must reject
// everything fsck rejects. A ply rejection of an object fsck accepts is reported; it fails the run only when the
// object is one git itself would write.
//
//   node test/fuzz/below-hash.mjs [--n 20] [--seed 1] [--case empty-mode|empty-name|<seed>]
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { concat, te } from '../../src/bytes.js';
import { fromHex } from '../../src/sha1.js';
import { hashObject, encodeCommit, encodeTag, encodeTree, ident, TYPE } from '../../src/objects.js';
import { validateIdent } from '../../src/validate.js';
import { buildPack } from '../../src/pack.js';
import { pkt, FLUSH } from '../../src/pktline.js';
import { listTree, readCommit } from '../../src/read.js';
import { createTransport } from '../../src/http.js';
import { fetchObject } from '../../src/fetch.js';
import { Tracer, arrayExporter } from '../../src/otel.js';
import { withLimits } from '../../src/limits.js';
import { Rng } from './prng.js';
import { OID_BYTES } from '../../src/format.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(x => x.length));
const N = parseInt(args.n ?? '20', 10);
const SEED = parseInt(args.seed ?? '1', 10);
const ONLY = args.case && args.case !== true ? String(args.case) : null;
const LIMITS = withLimits({ requestTimeoutMs: 4000 });
const AUTHOR = ident(validateIdent({ name: 'A', email: 'a@b.c', time: 1700000000 }));
const REJECT = new Set(['pack_corrupt', 'protocol', 'remote_error', 'not_found', 'unsupported']);

const entry = (mode, name, oid) => concat([te.encode(`${mode} ${name}\0`), oid]);
const blob = te.encode('hello\n');

function git(dir, argv, input) {
  const r = spawnSync('git', argv, { cwd: dir, input, encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

// Errors about the object itself. Broken links and dangling tips are not a structural rejection: a well-formed
// tree whose target was never written still upsets fsck, and that is not the parser's question.
function fsckErrors(dir) {
  const r = git(dir, ['fsck', '--strict']);
  return r.out.split('\n').map(l => l.trim()).filter(l => /^error\b/i.test(l) && !/broken link/i.test(l));
}

function writeChain(objects) {
  const dir = mkdtempSync(join(tmpdir(), 'ply-fsck-'));
  git(dir, ['init', '-q', '-b', 'main']);
  const oids = [];
  for (const o of objects) {
    const r = git(dir, ['hash-object', '-t', o.type, '--literally', '-w', '--stdin'], Buffer.from(o.data));
    const oid = r.out.trim().split('\n').filter(Boolean).pop();
    if (r.code !== 0 || !oid) throw new Error(`hash-object ${o.type} failed: ${r.out}`);
    const ours = hashObject(o.type, o.data);
    if (ours !== oid) throw new Error(`hash diverged for ${o.type}: ply ${ours} git ${oid}`);
    oids.push(oid);
  }
  const errors = fsckErrors(dir);
  rmSync(dir, { recursive: true, force: true });
  return { oids, errors, rejected: errors.length > 0 };
}

let current = null;
async function packResponse(obj) {
  const { pack } = await buildPack([{ type: TYPE[obj.type.toUpperCase()], data: obj.data }]);
  const parts = [pkt('packfile\n')];
  for (let i = 0; i < pack.length; i += 65000) parts.push(pkt(concat([Uint8Array.of(1), pack.subarray(i, Math.min(i + 65000, pack.length))])));
  parts.push(FLUSH);
  return concat(parts);
}
const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('latin1');
    let bytes;
    if (body.includes('command=ls-refs')) {
      bytes = concat([
        pkt(`${current.head} HEAD symref-target:refs/heads/main\n`),
        pkt(`${current.head} refs/heads/main\n`),
        FLUSH,
      ]);
    } else if (body.includes('command=fetch')) {
      const want = body.match(/want ([0-9a-f]{40})/);
      const obj = want && current.byOid.get(want[1]);
      bytes = obj ? await packResponse(obj) : concat([pkt('ERR not our ref\n'), FLUSH]);
    } else bytes = concat([pkt('ERR\n'), FLUSH]);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-store' });
    res.end(Buffer.from(bytes));
  } catch (e) {
    res.writeHead(500);
    res.end(String(e?.message ?? e));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/hostile.git`;

async function plyAccepts(focus, head) {
  const tracer = new Tracer({ exporter: arrayExporter() });
  try {
    if (focus === 'tree') await listTree(url, { ref: 'refs/heads/main' }, { tracer, limits: LIMITS });
    else if (focus === 'commit') await readCommit(url, { ref: 'refs/heads/main' }, { tracer, limits: LIMITS });
    else {
      const t = createTransport(url, { tracer, limits: LIMITS });
      await fetchObject(t, { oid: head, filter: 'blob:none', expectType: TYPE.TAG });
    }
    return { accepted: true };
  } catch (e) {
    return { accepted: false, code: e?.code, message: e?.message ?? String(e) };
  }
}

function mutate(rng, bytes) {
  const b = new Uint8Array(bytes);
  const kind = rng.int(0, 4);
  if (!b.length || kind === 4) return concat([b, Uint8Array.of(rng.int(0, 255))]);
  const i = rng.int(0, b.length - 1);
  if (kind === 0) { b[i] ^= 1 << rng.int(0, 7); return b; }
  if (kind === 1) return concat([b.subarray(0, i), b.subarray(i + 1)]);
  if (kind === 2) return concat([b.subarray(0, i), Uint8Array.of(rng.int(0, 255)), b.subarray(i)]);
  return b.subarray(0, rng.int(0, b.length));
}

function validTree(blobOid) {
  return encodeTree([{ mode: '100644', name: 'a', oid: blobOid }]);
}

const cases = [];
function add(name, spec) { cases.push({ name, ...spec }); }

const blobOid = hashObject('blob', blob);
const blobBytes = fromHex(blobOid);
const treeOk = validTree(blobOid);
const treeOid = hashObject('tree', treeOk);
const commitOk = encodeCommit({ tree: treeOid, author: AUTHOR, message: 'm\n' });
const commitOid = hashObject('commit', commitOk);

add('valid', { objects: [{ type: 'blob', data: blob }, { type: 'tree', data: treeOk }, { type: 'commit', data: commitOk }], focus: 'tree', normal: true });
add('empty-tree', {
  objects: [{ type: 'blob', data: blob }, { type: 'tree', data: new Uint8Array(0) }, { type: 'commit', data: encodeCommit({ tree: hashObject('tree', new Uint8Array(0)), author: AUTHOR, message: 'm\n' }) }],
  focus: 'tree', normal: true,
});
for (const [name, tree] of [
  ['empty-mode', concat([te.encode(' a\0'), blobBytes])],
  ['empty-name', concat([te.encode('100644 \0'), blobBytes])],
  ['truncated-oid', concat([te.encode('100644 a\0'), blobBytes.subarray(0, OID_BYTES - 1)])],
  ['zero-padded-mode', concat([te.encode('0100644 a\0'), blobBytes])],
  ['full-pathname', concat([te.encode('100644 a/b\0'), blobBytes])],
  ['dot', concat([te.encode('100644 .\0'), blobBytes])],
  ['dotdot', concat([te.encode('100644 ..\0'), blobBytes])],
  ['dotgit', concat([te.encode('100644 .git\0'), blobBytes])],
  ['unsorted', concat([entry('100644', 'b', blobBytes), entry('100644', 'a', blobBytes)])],
  ['duplicate', concat([entry('100644', 'a', blobBytes), entry('100644', 'a', blobBytes)])],
  ['bad-filemode', concat([te.encode('100664 a\0'), blobBytes])],
]) {
  const oid = hashObject('tree', tree);
  add(name, {
    objects: [{ type: 'blob', data: blob }, { type: 'tree', data: tree }, { type: 'commit', data: encodeCommit({ tree: oid, author: AUTHOR, message: 'm\n' }) }],
    focus: 'tree', normal: false,
  });
}
add('missing-author', {
  objects: [{ type: 'blob', data: blob }, { type: 'tree', data: treeOk }, { type: 'commit', data: te.encode(`tree ${treeOid}\ncommitter ${AUTHOR}\n\nm\n`) }],
  focus: 'commit', normal: false,
});
add('bad-email', {
  objects: [{ type: 'blob', data: blob }, { type: 'tree', data: treeOk }, { type: 'commit', data: te.encode(`tree ${treeOid}\nauthor Ada 1700000000 +0000\ncommitter ${AUTHOR}\n\nm\n`) }],
  focus: 'commit', normal: false,
});
add('bad-date', {
  objects: [{ type: 'blob', data: blob }, { type: 'tree', data: treeOk }, { type: 'commit', data: te.encode(`tree ${treeOid}\nauthor Ada <a@b.c> soon +0000\ncommitter ${AUTHOR}\n\nm\n`) }],
  focus: 'commit', normal: false,
});
add('valid-commit', { objects: [{ type: 'blob', data: blob }, { type: 'tree', data: treeOk }, { type: 'commit', data: commitOk }], focus: 'commit', normal: true });
{
  const tag = encodeTag({ object: commitOid, type: 'commit', tag: 'v1', tagger: AUTHOR, message: 'rel\n' });
  add('valid-tag', { objects: [{ type: 'blob', data: blob }, { type: 'tree', data: treeOk }, { type: 'commit', data: commitOk }, { type: 'tag', data: tag }], focus: 'tag', normal: true });
  const emptyName = encodeTag({ object: commitOid, type: 'commit', tag: '', tagger: AUTHOR, message: 'rel\n' });
  add('empty-tag-name', { objects: [{ type: 'blob', data: blob }, { type: 'tree', data: treeOk }, { type: 'commit', data: commitOk }, { type: 'tag', data: emptyName }], focus: 'tag', normal: false });
}

const randoms = [];
for (let i = 0; i < N; i++) {
  const seed = (SEED * 1000003 + i) >>> 0;
  const rng = new Rng(seed);
  if (rng.bool()) {
    const tree = mutate(rng, treeOk);
    const oid = hashObject('tree', tree);
    randoms.push({ name: `tree#${seed}`, seed, objects: [{ type: 'blob', data: blob }, { type: 'tree', data: tree }, { type: 'commit', data: encodeCommit({ tree: oid, author: AUTHOR, message: 'm\n' }) }], focus: 'tree', normal: false });
  } else {
    const commit = mutate(rng, commitOk);
    randoms.push({ name: `commit#${seed}`, seed, objects: [{ type: 'blob', data: blob }, { type: 'tree', data: treeOk }, { type: 'commit', data: commit }], focus: 'commit', normal: false });
  }
}

let selected = [...cases, ...randoms];
if (ONLY !== null) {
  const asSeed = Number(ONLY);
  selected = Number.isInteger(asSeed) && String(asSeed) === ONLY
    ? randoms.filter(c => c.seed === asSeed)
    : cases.filter(c => c.name === ONLY);
  if (!selected.length) { console.error(`no case ${ONLY}`); process.exit(2); }
}

const fails = [];
const stricter = [];
const rows = [];
try {
  for (const c of selected) {
    const judged = writeChain(c.objects);
    const head = judged.oids[c.focus === 'tag' ? judged.oids.length - 1 : judged.oids.length - 1];
    const byOid = new Map(judged.oids.map((oid, i) => [oid, c.objects[i]]));
    current = { head, byOid };
    const ply = await plyAccepts(c.focus, head);
    if (!ply.accepted && !REJECT.has(ply.code)) {
      fails.push(c.name);
      console.log(`FAIL ${c.name}: untyped ${ply.code}: ${ply.message}`);
      continue;
    }
    const fsckNo = judged.rejected;
    const plyNo = !ply.accepted;
    let verdict = 'ok';
    if (fsckNo && !plyNo) { verdict = 'DIVERGE'; fails.push(c.name); }
    else if (!fsckNo && plyNo && c.normal) { verdict = 'STRICT-NORMAL'; fails.push(c.name); }
    else if (!fsckNo && plyNo) { verdict = 'stricter'; stricter.push({ name: c.name, code: ply.code, message: ply.message, fsck: judged.errors }); }
    rows.push(verdict);
    const detail = verdict === 'ok' ? '' : ` fsck=${judged.errors[0] ?? 'accept'} ply=${ply.accepted ? 'accept' : ply.code + ' ' + String(ply.message).slice(0, 80)}`;
    console.log(`${verdict.padEnd(13)} ${c.name.padEnd(22)} ${c.focus.padEnd(6)}${detail}`);
  }
} finally {
  await new Promise(resolve => server.close(resolve));
}

console.log(`\n${selected.length} cases, ${fails.length} failures, ${stricter.length} stricter (ply rejects, fsck accepts)`);
for (const s of stricter) console.log(`  stricter ${s.name}: ${s.code}: ${String(s.message).slice(0, 120)}`);
process.exit(fails.length ? 1 : 0);
