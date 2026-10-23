// Semantic-lie fuzz: the server answers with WELL-FORMED protocol bytes that are wrong. No corruption the parsers
// can see — only the client's content checks (oid verification, size contracts, CAS) stand between a lie and a bad push.
// Every lie is built from real objects taken from a second repo or an older commit of the same repo.
//   node test/fuzz/liar.mjs [--n 200] [--seed 1] [--case <seed>]
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, commitFiles } from '../server.js';
import { startProxy } from '../proxy.js';
import { Rng } from './prng.js';
import { editFile } from '../../src/edit.js';
import { Tracer, arrayExporter, flattenLine } from '../../src/otel.js';
import { withLimits } from '../../src/limits.js';
import { buildPack } from '../../src/pack.js';
import { TYPE } from '../../src/objects.js';
import { concat, te } from '../../src/bytes.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? true] : []).filter(x => x.length));
const N = parseInt(args.n ?? '200', 10), SEED = parseInt(args.seed ?? String(Date.now() % 1e9), 10), ONLY = args.case ? parseInt(args.case, 10) : null;
const CODES = new Set(['pack_corrupt', 'protocol', 'network', 'timeout', 'aborted', 'not_git', 'auth', 'not_found', 'rate_limited', 'upstream_5xx', 'http', 'limit_exceeded', 'remote_error', 'match_count', 'cas_conflict', 'push_rejected', 'bad_request', 'unsupported', 'ambiguous']);

const pktLine = s => { const b = typeof s === 'string' ? te.encode(s) : s; return concat([te.encode((b.length + 4).toString(16).padStart(4, '0')), b]); };
const FLUSH = te.encode('0000');
// a v2 fetch response carrying exactly these objects (full, no deltas) as a sideband pack
async function fetchResponse(objs, { shallow = [] } = {}) {
  const { pack } = await buildPack(objs);
  const parts = [];
  if (shallow.length) { parts.push(pktLine('shallow-info\n')); for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`)); parts.push(te.encode('0001')); }
  parts.push(pktLine('packfile\n'));
  for (let i = 0; i < pack.length; i += 65000) parts.push(pktLine(concat([Uint8Array.of(1), pack.subarray(i, Math.min(i + 65000, pack.length))])));
  parts.push(FLUSH);
  return concat(parts);
}
const obj = (bare, oid) => { const t = git(bare, ['cat-file', '-t', oid]).trim(); return { type: TYPE[t.toUpperCase()], data: new Uint8Array(gitBuf(bare, ['cat-file', t, oid])) }; };

const FILE = 'a/b/target.txt', ORIG = 'before MARK after\n', EXPECTED = 'before XX after\n';

// Lies. Each takes the real repo state + a decoy repo and returns a fault function for the proxy.
const LIES = {
  // ls-refs points at an older commit (server lagging / replica split-brain). Legit: edit lands on that base; CAS protects.
  'ls-refs:old-commit': (R, D) => ctx => ctx.stage === 'ls-refs' ? { type: 'bytes', bytes: concat([pktLine(`${R.older} refs/heads/main\n`), FLUSH]), name: 'ls-refs old' } : { type: 'pass' },
  // ls-refs points at a commit from an unrelated repo (that the server does not have).
  'ls-refs:foreign-commit': (R, D) => ctx => ctx.stage === 'ls-refs' ? { type: 'bytes', bytes: concat([pktLine(`${D.head} refs/heads/main\n`), FLUSH]), name: 'ls-refs foreign' } : { type: 'pass' },
  // ls-refs says one thing, then the push's CAS must notice the server never had that commit as main.
  'ls-refs:fabricated-oid': (R, D) => ctx => ctx.stage === 'ls-refs' ? { type: 'bytes', bytes: concat([pktLine(`${'a'.repeat(40)} refs/heads/main\n`), FLUSH]), name: 'ls-refs fake' } : { type: 'pass' },
  // commit fetch returns a different (older) commit object than the one wanted.
  'commit:wrong-object': (R, D) => ctx => ctx.stage === 'fetch' && ctx.n === 0 ? { type: 'bytes', bytes: fetchResponse([obj(R.bare, R.older)], { shallow: [R.older] }), name: 'wrong commit' } : { type: 'pass' },
  // commit fetch returns the decoy repo's commit: wrong oid, wrong tree.
  'commit:foreign-object': (R, D) => ctx => ctx.stage === 'fetch' && ctx.n === 0 ? { type: 'bytes', bytes: fetchResponse([obj(D.bare, D.head)], { shallow: [D.head] }), name: 'foreign commit' } : { type: 'pass' },
  // tree fetch at some level returns a tree with the same name present but pointing at a different blob (decoy content).
  'tree:swapped-entry': (R, D) => ctx => ctx.stage === 'fetch' && ctx.n === R.leafLevel ? { type: 'bytes', bytes: fetchResponse([obj(D.bare, D.leafTree)]), name: 'swapped tree' } : { type: 'pass' },
  // tree fetch returns the right tree bytes but for the wrong level (root instead of leaf).
  'tree:wrong-level': (R, D) => ctx => ctx.stage === 'fetch' && ctx.n === R.leafLevel ? { type: 'bytes', bytes: fetchResponse([obj(R.bare, R.rootTree)]), name: 'wrong level' } : { type: 'pass' },
  // blob fetch returns a different blob of the SAME size (so header size matches; only content differs).
  'blob:same-size-other-content': (R, D) => ctx => ctx.stage === 'fetch' && ctx.n === R.blobFetch ? { type: 'bytes', bytes: fetchResponse([{ type: TYPE.BLOB, data: te.encode(ORIG.replace('MARK', 'MARX')) }]), name: 'blob same size' } : { type: 'pass' },
  // blob fetch returns a same-size blob whose content still contains the needle elsewhere: the client scans, finds exactly one
  // match, computes a delta against the CLAIMED base oid and pushes. The server holds the real base: the delta's base-size
  // check or the resulting object hash must fail. Outcome must be a rejection, never a committed wrong file.
  'blob:same-size-needle-kept': (R, D) => ctx => ctx.stage === 'fetch' && ctx.n === R.blobFetch ? { type: 'bytes', bytes: fetchResponse([{ type: TYPE.BLOB, data: te.encode('MARK before after\n') }]), name: 'blob needle kept' } : { type: 'pass' },
  // blob fetch returns a DIFFERENT-size blob with the needle: size contract vs header is what must catch it.
  'blob:other-size-needle-kept': (R, D) => ctx => ctx.stage === 'fetch' && ctx.n === R.blobFetch ? { type: 'bytes', bytes: fetchResponse([{ type: TYPE.BLOB, data: te.encode('x MARK y\n') }]), name: 'blob other size' } : { type: 'pass' },
  // blob fetch returns the OLD version of the file (server serving stale object store).
  'blob:stale-version': (R, D) => ctx => ctx.stage === 'fetch' && ctx.n === R.blobFetch ? { type: 'bytes', bytes: fetchResponse([obj(R.bare, R.olderBlob)]), name: 'stale blob' } : { type: 'pass' },
  // blob fetch returns a tree object instead.
  'blob:tree-instead': (R, D) => ctx => ctx.stage === 'fetch' && ctx.n === R.blobFetch ? { type: 'bytes', bytes: fetchResponse([obj(R.bare, R.rootTree)]), name: 'tree for blob' } : { type: 'pass' },
  // blob fetch returns two objects (the blob plus junk) in a well-formed pack.
  'blob:extra-object': (R, D) => ctx => ctx.stage === 'fetch' && ctx.n === R.blobFetch ? { type: 'bytes', bytes: fetchResponse([obj(R.bare, R.blob), obj(R.bare, R.rootTree)]), name: 'extra object' } : { type: 'pass' },
  // every fetch answers with an empty (0-object) well-formed pack.
  'fetch:empty-pack': (R, D) => ctx => ctx.stage === 'fetch' ? { type: 'bytes', bytes: fetchResponse([]), name: 'empty pack' } : { type: 'pass' },
  // receive-pack says ok but did nothing (lying report).
  'push:fake-ok': (R, D) => ctx => ctx.stage === 'receive-pack' ? { type: 'bytes', bytes: concat([pktLine('unpack ok\n'), pktLine('ok refs/heads/main\n'), FLUSH]), name: 'fake ok', noForward: true } : { type: 'pass' },
  // receive-pack reports ok for a different ref than we pushed.
  'push:ok-other-ref': (R, D) => ctx => ctx.stage === 'receive-pack' ? { type: 'bytes', bytes: concat([pktLine('unpack ok\n'), pktLine('ok refs/heads/other\n'), FLUSH]), name: 'ok other ref' } : { type: 'pass' },
  // receive-pack reports ok AND ng for the same ref.
  'push:ok-and-ng': (R, D) => ctx => ctx.stage === 'receive-pack' ? { type: 'bytes', bytes: concat([pktLine('unpack ok\n'), pktLine('ok refs/heads/main\n'), pktLine('ng refs/heads/main later\n'), FLUSH]), name: 'ok+ng' } : { type: 'pass' },
  // receive-pack: unpack ok but no ref lines at all.
  'push:no-ref-lines': (R, D) => ctx => ctx.stage === 'receive-pack' ? { type: 'bytes', bytes: concat([pktLine('unpack ok\n'), FLUSH]), name: 'no ref lines' } : { type: 'pass' },
  // two lies: ls-refs old commit AND blob stale (consistent with each other: a fully lagging replica).
  'replica:consistent-lag': (R, D) => ctx => ctx.stage === 'ls-refs' ? { type: 'bytes', bytes: concat([pktLine(`${R.older} refs/heads/main\n`), FLUSH]), name: 'lag' } : { type: 'pass' },
};

const { root, cleanup } = tmpRoot();
const srv = await startGitServer(root);
const outcomes = {}, fails = [];
try {
  const names = Object.keys(LIES);
  const seeds = ONLY !== null ? [ONLY] : Array.from({ length: N }, (_, i) => (SEED * 7919 + i * 104729) >>> 0);
  for (let i = 0; i < seeds.length; i++) {
    const rng = new Rng(seeds[i]);
    const lie = names[rng.int(0, names.length - 1)];
    const name = `l${i}`;
    // real repo: two commits so there is an "older" version of everything
    const bare = makeBareRepo(root, name); const work = join(root, `w${i}`); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
    const older = commitFiles(work, bare, { [FILE]: 'old MARK old\n', 'z.txt': 'z' }, 'older');
    const head = commitFiles(work, bare, { [FILE]: ORIG }, 'head');
    const R = { bare, head, older, rootTree: git(bare, ['rev-parse', 'main^{tree}']).trim(), blob: git(bare, ['rev-parse', 'main:' + FILE]).trim(), olderBlob: git(bare, [`rev-parse`, `${older}:${FILE}`]).trim(), leafLevel: 1 + 2, blobFetch: 1 + 3 };
    // decoy repo: same path, different content
    const dbare = makeBareRepo(root, 'd' + name); const dwork = join(root, `dw${i}`); mkdirSync(dwork); git(dwork, ['init', '-q', '-b', 'main']);
    const dhead = commitFiles(dwork, dbare, { [FILE]: 'decoy MARK decoy\n' }, 'decoy');
    const D = { bare: dbare, head: dhead, leafTree: git(dbare, ['rev-parse', 'main:a/b']).trim() };
    const proxy = await startProxy(srv.url, LIES[lie](R, D));
    const exporter = arrayExporter();
    let result = null, error = null;
    const verify = rng.bool(0.5);
    try { result = await editFile(`${proxy.url}/${name}.git`, { path: FILE, find: 'MARK', replace: 'XX', author: { name: 'l', email: 'l@x' }, message: 'l' }, { tracer: new Tracer({ exporter }), limits: withLimits({ requestTimeoutMs: 3000 }), verify }); }
    catch (e) { error = e; }
    await proxy.close();
    const problems = [];
    const nowHead = git(bare, ['rev-parse', 'main']).trim();
    const content = gitBuf(bare, ['cat-file', 'blob', `main:${FILE}`]).toString();
    const fsck = git(bare, ['fsck', '--strict', '--no-dangling']).trim();
    if (fsck) problems.push(`fsck: ${fsck.split('\n')[0]}`);
    if (error) {
      if (!CODES.has(error.code)) problems.push(`untyped ${error.code}: ${error.message}`);
      if (error.code === 'ambiguous') { if (nowHead !== head && content !== EXPECTED) problems.push(`ambiguous but ref moved to wrong content ${JSON.stringify(content)}`); }
      else if (nowHead !== head) problems.push(`ref moved on error to ${nowHead.slice(0, 8)} (content ${JSON.stringify(content)})`);
    } else {
      // a success must be a TRUE success: ref == our commit, content == expected splice of the REAL head blob
      if (nowHead !== result.newCommit) { if (!(lie === 'push:fake-ok' && !verify)) problems.push(`claimed success but ref is ${nowHead.slice(0, 8)} not ${result.newCommit.slice(0, 8)}`); }
      else if (content !== EXPECTED) problems.push(`claimed success with WRONG CONTENT ${JSON.stringify(content)}`);
      else { const parent = (() => { try { return git(bare, ['rev-parse', `${result.newCommit}^`]).trim(); } catch { return null; } })(); if (parent !== head && lie !== 'ls-refs:old-commit' && lie !== 'replica:consistent-lag') problems.push('new commit parent is not the real head'); }
    }
    // a lying 'ok' must be caught whenever verify is on (the proxy's fake report never reaches the real server)
    if (lie === 'push:fake-ok') { if (verify && !error) problems.push('verify=on but forged ok was believed'); if (verify && error && error.code !== 'ambiguous') problems.push(`verify=on: expected ambiguous, got ${error.code}`); }
    const code = error ? error.code : 'ok';
    outcomes[`${lie} → ${code}`] = (outcomes[`${lie} → ${code}`] ?? 0) + 1;
    process.stdout.write(`${problems.length ? 'FAIL' : 'ok  '} #${String(i).padStart(3)} seed=${seeds[i]} ${(lie + (verify ? ' +verify' : '')).padEnd(38)} → ${code.padEnd(13)} ${error ? error.message.slice(0, 70) : ''}\n`);
    if (problems.length) { fails.push(seeds[i]); console.log('     ' + problems.join('\n     ') + `\n     repro: node test/fuzz/liar.mjs --case ${seeds[i]}`); }
    rmSync(work, { recursive: true, force: true }); rmSync(dwork, { recursive: true, force: true });
  }
} finally { await srv.close(); cleanup(); }
console.log(`\n${N} cases, ${fails.length} failures\n` + Object.entries(outcomes).sort().map(([k, v]) => `${String(v).padStart(4)} ${k}`).join('\n'));
process.exit(fails.length ? 1 : 0);
