// The streamed-body cells the #36 matrix does not reach (#81): a declared size one under, at, and one over the
// inflated length, on read and edit; a header that fails before any body byte; and the blob:none object cap against
// a delta whose resolved size is past the base. git index-pack is the oracle for every pack. A dropped connection
// has no pack; its oracle is the stated code.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tmpRoot, makeBareRepo, startGitServer, commitFiles, git } from '../server.js';
import { editFile } from '../../src/edit.js';
import { readFile, openBlob } from '../../src/read.js';
import { fetchObject } from '../../src/fetch.js';
import { Tracer } from '../../src/otel.js';
import { withLimits, DEFAULT_LIMITS } from '../../src/limits.js';
import { buildPack, encodeObjHeader, spliceDelta, zlibDeflate } from '../../src/pack.js';
import { hashObject, TYPE } from '../../src/objects.js';
import { Sha1 } from '../../src/sha1.js';
import { concat, te } from '../../src/bytes.js';
import { pkt, FLUSH } from '../../src/pktline.js';

const FIND = 'M';
const AUTHOR = { name: 'adv', email: 'adv@x' };
const FRAME = 8;
const ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

const contentOf = n => { const b = new Uint8Array(n); if (n) b[0] = 0x4d; for (let i = 1; i < n; i++) b[i] = 0x78; return b; };

async function liePack(content, declared) {
  const z = await zlibDeflate(content);
  const body = concat([Uint8Array.of(0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 1), encodeObjHeader(TYPE.BLOB, declared), z]);
  return concat([body, new Sha1().update(body).digest()]);
}

// index-pack --strict in a fresh bare repo. Returns the status.
const indexPack = bytes => {
  const dir = mkdtempSync(join(tmpdir(), 'ply-idx-'));
  try {
    spawnSync('git', ['init', '-q', '--bare', dir], { env: ENV });
    const file = join(dir, 'p.pack');
    writeFileSync(file, bytes);
    const r = spawnSync('git', ['index-pack', '--strict', file], { cwd: dir, env: ENV, encoding: 'utf8' });
    return r.status;
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

const catBlob = (pack, oid) => {
  const dir = mkdtempSync(join(tmpdir(), 'ply-cat-'));
  try {
    spawnSync('git', ['init', '-q', '--bare', dir], { env: ENV });
    // index-pack of a named file writes only the .idx beside it; --stdin installs the pack where cat-file reads it
    const r = spawnSync('git', ['index-pack', '--strict', '--stdin'], { cwd: dir, env: ENV, input: pack });
    assert.equal(r.status, 0, String(r.stderr));
    const cat = spawnSync('git', ['cat-file', 'blob', oid], { cwd: dir, env: ENV });
    assert.equal(cat.status, 0, String(cat.stderr));
    return cat.stdout;
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

// Band-1 frames of `pack`, 8 bytes at a time, after the packfile section. The real server answers everything else.
function intercept(oid, pack) {
  return async (url, init) => {
    const req = init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('latin1') : '';
    if (!req.includes('command=fetch\n') || req.includes('filter ') || !req.includes(`want ${oid}\n`)) return fetch(url, init);
    const frames = [pkt(te.encode('packfile\n'))];
    for (let i = 0; i < pack.length; i += FRAME) frames.push(pkt(concat([Uint8Array.of(1), pack.subarray(i, i + FRAME)])));
    frames.push(FLUSH);
    let i = 0;
    const stream = new ReadableStream({
      pull(c) { if (i >= frames.length) { c.close(); return; } c.enqueue(frames[i++]); },
    }, { highWaterMark: 0 });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' } });
  };
}

let root, cleanup, srv;
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv.close(); cleanup(); });

test('declared size one under, at, and one over the inflated length, on read and edit', { timeout: 120_000 }, async () => {
  const cells = [];
  for (const n of [0, 1, 64]) for (const declared of (n === 0 ? [0, 1] : [n - 1, n, n + 1])) for (const path of ['read', 'edit']) cells.push({ n, declared, path });
  assert.equal(cells.length, 16);
  const packs = new Map();
  for (const { n, declared } of cells) {
    const key = `${n}:${declared}`;
    if (!packs.has(key)) packs.set(key, await liePack(contentOf(n), declared));
  }
  for (const [key, pack] of packs) {
    const [n, declared] = key.split(':').map(Number);
    const status = indexPack(pack);
    assert.equal(status === 0, n === declared, `index-pack ${key} status ${status}`);
  }
  for (const { n, declared, path } of cells) {
    const data = contentOf(n);
    const name = `lie${n}d${declared}${path}`;
    const bare = makeBareRepo(root, name);
    const work = join(root, `w${name}`);
    mkdirSync(work);
    git(work, ['init', '-q', '-b', 'main']);
    const head = commitFiles(work, bare, { 'a.bin': Buffer.from(data) }, 'lie');
    const oid = hashObject('blob', data);
    const url = `${srv.url}/${name}.git`;
    const fetchImpl = intercept(oid, packs.get(`${n}:${declared}`));
    const opts = { tracer: new Tracer(), fetchImpl };
    const where = `${path} n=${n} declared=${declared}`;
    let err = null, got = null;
    if (path === 'read') {
      const res = await readFile(url, { path: 'a.bin' }, opts);
      const parts = [];
      try { for await (const c of res.stream) parts.push(c); got = concat(parts); } catch (e) { err = e; }
    } else {
      try { got = await editFile(url, { path: 'a.bin', find: FIND, replace: 'N', author: AUTHOR, message: 'lie' }, opts); }
      catch (e) { err = e; }
    }
    // each cell has its own bare repo; read the ref the operation left, then put main back only so a later
    // assertion cannot observe a push from this cell
    const ref = git(bare, ['rev-parse', 'main']).trim();
    if (ref !== head) git(bare, ['update-ref', 'refs/heads/main', head]);
    if (n === declared && path === 'read') {
      assert.equal(err, null, where);
      assert.ok(Buffer.from(got).equals(Buffer.from(data)), where);
    } else if (n === declared && path === 'edit' && n === 0) {
      assert.equal(err?.code, 'match_count', `${where}: ${err?.message}`);
      assert.equal(ref, head, where);
    } else if (n === declared) {
      assert.equal(err, null, `${where}: ${err?.message}`);
      assert.notEqual(ref, head, where);
    } else if (declared < n) {
      assert.equal(err?.code, 'pack_corrupt', `${where}: ${err?.message}`);
      assert.equal(err.message, `server streamed more than the ${declared} bytes it declared`, where);
      assert.equal(ref, head, where);
    } else {
      assert.equal(err?.code, 'pack_corrupt', `${where}: ${err?.message}`);
      assert.equal(err.message, path === 'read' ? `inflated ${n} != declared ${declared}` : `inflated ${n} != header size ${declared}`, where);
      assert.equal(ref, head, where);
    }
  }
});

test('a header that fails before the body: a raw reset, and a bad signature git also refuses', async () => {
  const tracer = new Tracer();
  const parent = tracer.start('p');
  const oid = 'a'.repeat(40);
  const limits = DEFAULT_LIMITS;
  const transport = frames => ({
    kind: 'http', url: 'http://fake/r.git', tracer, parent: null, limits, signal: null, quirks: {}, scrub: null,
    frames, advertise: async () => { throw new Error('unused'); },
  });
  const reset = await openBlob(transport(async function* () { throw new Error('reset'); }), tracer, parent, oid).then(() => null, e => e);
  assert.equal(reset?.code, 'pack_corrupt');
  assert.equal(reset.message, 'blob stream: reset');
  const bad = te.encode('NOPE not a pack!!!!');
  assert.notEqual(indexPack(bad), 0);
  const frames = async function* () {
    yield { kind: 'data', payload: te.encode('packfile\n') };
    yield { kind: 'data', payload: concat([Uint8Array.of(1), bad]) };
    yield { kind: 'flush' };
  };
  const sig = await openBlob(transport(frames), tracer, parent, oid).then(() => null, e => e);
  assert.equal(sig?.code, 'pack_corrupt');
  assert.equal(sig.message, 'pack: bad signature');
});

test('blob:none object cap: one under, at, and one past each size the pack meets', { timeout: 60_000 }, async () => {
  // A ref-delta's header size is the delta's, not the resolved object's. parsePack refuses a header over maxObjectSize
  // ('pack object size') before fetchWide can see the resolved bytes ('object size', and only while maxDeltaResult
  // stays at its default, above the result). Caps are one under, at, and one past the base header, the delta header,
  // and the resolved length. git index-pack accepts every pack; cat-file is the byte oracle.
  const bases = [8, 32], expands = [2, 16];
  const built = [];
  for (const baseN of bases) for (const extraN of expands) {
    const base = new Uint8Array(baseN).fill(0x41);
    const extra = new Uint8Array(extraN).fill(0x42);
    const result = concat([base, extra]);
    const { delta } = spliceDelta({ baseLen: baseN, off: baseN, oldLen: 0, insert: extra });
    const { pack, entries } = await buildPack([{ type: TYPE.BLOB, data: base }, { type: TYPE.BLOB, data: delta, baseOid: hashObject('blob', base) }]);
    const oid = hashObject('blob', result);
    const where = `base ${baseN} +${extraN}`;
    assert.ok(Buffer.from(catBlob(pack, oid)).equals(Buffer.from(result)), where);
    const deltaN = entries[1].size;
    assert.equal(deltaN, delta.length, where);
    built.push({ pack, result, oid, baseN, extraN, deltaN, resultN: result.length });
  }
  const cells = [];
  for (const b of built) {
    const caps = new Set();
    for (const n of [b.baseN, b.deltaN, b.resultN]) for (const cap of [n - 1, n, n + 1]) caps.add(cap);
    for (const cap of [...caps].sort((a, c) => a - c)) cells.push({ ...b, cap });
  }
  assert.equal(cells.length, 32);
  const tracer = new Tracer();
  let resolved = 0;
  for (const b of cells) {
    const limits = withLimits({ maxObjectSize: b.cap });
    const frames = async function* () {
      yield { kind: 'data', payload: te.encode('packfile\n') };
      for (let i = 0; i < b.pack.length; i += FRAME) yield { kind: 'data', payload: concat([Uint8Array.of(1), b.pack.subarray(i, i + FRAME)]) };
      yield { kind: 'flush' };
    };
    const t = {
      kind: 'http', url: 'http://fake/r.git', tracer, parent: null, limits, signal: null, quirks: { treeFilter: 'blob:none' }, scrub: null, frames,
      advertise: async () => { throw new Error('unused') },
    };
    const where = `base ${b.baseN} +${b.extraN} delta ${b.deltaN} result ${b.resultN} cap ${b.cap}`;
    const res = await fetchObject(t, { oid: b.oid }).then(v => ({ v }), e => ({ e }));
    // the base is the first object, so a cap under it never reaches the delta header
    const refused = b.cap < b.baseN ? ['pack object size', b.baseN] : b.cap < b.deltaN ? ['pack object size', b.deltaN] : b.cap < b.resultN ? ['object size', b.resultN] : null;
    if (refused) {
      assert.equal(res.e?.code, 'limit_exceeded', `${where}: ${res.e?.message}`);
      assert.equal(res.e.what, refused[0], where);
      assert.equal(res.e.got, refused[1], where);
      assert.equal(res.e.max, b.cap, where);
    } else {
      assert.equal(res.e, undefined, `${where}: ${res.e?.message}`);
      assert.ok(Buffer.from(res.v.data).equals(Buffer.from(b.result)), where);
    }
    if (res.e?.what === 'object size') resolved++;
  }
  assert.ok(resolved > 0, 'a cap between the headers and the resolved length');
});
