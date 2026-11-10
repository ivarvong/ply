// A push whose pack is past INFLATE_CHUNK goes out as a stream (#172): pass 1 measures, pass 2 is the request body.
// Against `git http-backend` (the oracle: the ref moves, fsck is clean, the objects are the ones sent):
//   - the body is a ReadableStream with duplex 'half', chunked, of the length span git.request.bytes says
//   - a pack at most INFLATE_CHUNK is sent as bytes with a Content-Length, as before
//   - over maxPackBytes: limit_exceeded with no receive-pack request, `got` the measured pack
//   - an object that changes between the passes: pass 2 refuses to finish the pack; the push is ambiguous (original
//     internal) and git did not move the ref (it never got a whole pack)
//   - a 3xx on the streamed POST is not followed and nothing reaches the other origin
//   - pushRepo's delta pack streams the same way
//   - memory: a 32 MiB push holds well under one copy of the object (child process, --expose-gc)
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { MEMORY_CELL_FLAGS } from './memcell.js';
import { randomFillSync } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { git, tmpRoot, makeBareRepo, startGitServer, fsckProblems } from './server.js';
import { createTransport } from '../src/http.js';
import { push, ZERO_OID } from '../src/push.js';
import { pushRepo } from '../src/repo-node.js';
import { hashObject, encodeTree, encodeCommit, TYPE } from '../src/objects.js';
import { withLimits } from '../src/limits.js';
import { INFLATE_CHUNK } from '../src/format.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { unwrap } from './unwrap.js';
import { readBody } from './body.js';

let root, cleanup, srv, n = 0;
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv.close(); cleanup(); });

const random = size => { const d = new Uint8Array(size); for (let i = 0; i < size; i += 65536) randomFillSync(d, i, Math.min(65536, size - i)); return d; };
const commitOf = blob => {
  const tree = unwrap(encodeTree([{ mode: '100644', name: 'big.bin', oid: hashObject('blob', blob) }]));
  const commit = unwrap(encodeCommit({ tree: hashObject('tree', tree), author: 'a <a@x> 1700000000 +0000', message: 'm\n' }));
  return { oid: hashObject('commit', commit), objects: [{ type: TYPE.BLOB, data: blob }, { type: TYPE.TREE, data: tree }, { type: TYPE.COMMIT, data: commit }] };
};
const repo = () => { const name = `s${n++}`; return { bare: makeBareRepo(root, name), url: `${srv.url}/${name}.git` }; };
const tipOf = (bare, ref = 'refs/heads/main') => { try { return git(bare, ['rev-parse', '--verify', '-q', ref]).trim(); } catch { return null; } };
// every receive-pack request: whether its body was a stream, its duplex, its bytes; then the real request
const capture = (before = () => {}) => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    if (!String(url).endsWith('/git-receive-pack')) return fetch(url, init);
    before(init);
    const streamed = typeof init.body?.getReader === 'function';
    seen.push({ streamed, duplex: init.duplex ?? null, redirect: init.redirect });
    return fetch(url, init);
  };
  return { seen, fetchImpl };
};
const traced = () => { const ex = arrayExporter(); return { tracer: new Tracer({ exporter: ex }), spans: () => ex.lines.flatMap(flattenLine) }; };

test('a pack past INFLATE_CHUNK is streamed: duplex half, redirect error, chunked; git takes it', async () => {
  const { bare, url } = repo();
  const c = commitOf(random(4 << 20));
  const { seen, fetchImpl } = capture();
  const { tracer, spans } = traced();
  const t = unwrap(createTransport(url, { fetchImpl, tracer }));
  const r = await push(t, { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: c.oid, objects: c.objects });
  assert.equal(r.ok, true, r.error?.message);
  assert.deepEqual(seen, [{ streamed: true, duplex: 'half', redirect: 'error' }]);
  assert.equal(tipOf(bare), c.oid);
  assert.deepEqual(fsckProblems(bare), []);
  const sent = spans().find(s => s.name === 'git.receive-pack');
  const exchange = sent;
  assert.equal(sent.attrs['git.push.pack.bytes'], r.value.packBytes);
  // the commands' pkt-line (oid oid ref\0caps\n) and the flush, then the pack
  assert.ok(exchange.attrs['git.request.bytes'] > r.value.packBytes && exchange.attrs['git.request.bytes'] < r.value.packBytes + 400, `${exchange.attrs['git.request.bytes']}`);
});

test('the server reads the streamed body chunked, and the bytes it got are the length declared', async () => {
  const { bare } = repo();
  const name = bare.split('/').pop();
  let got = null;
  const front = http.createServer((req, res) => {
    if (!req.url.endsWith('/git-receive-pack')) { req.pipe(http.request(`${srv.url}${req.url}`, { method: req.method, headers: req.headers }, up => { res.writeHead(up.statusCode, up.headers); up.pipe(res); })); return; }
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      got = { te: req.headers['transfer-encoding'] ?? null, cl: req.headers['content-length'] ?? null, bytes: Buffer.concat(chunks) };
      const { 'transfer-encoding': _te, ...headers } = req.headers;
      const up = http.request(`${srv.url}${req.url}`, { method: 'POST', headers: { ...headers, 'content-length': String(got.bytes.length) } }, u => { res.writeHead(u.statusCode, u.headers); u.pipe(res); });
      up.end(got.bytes);
    });
  });
  await new Promise(r => front.listen(0, '127.0.0.1', r));
  try {
    const c = commitOf(random(INFLATE_CHUNK * 4));
    const { tracer, spans } = traced();
    const t = unwrap(createTransport(`http://127.0.0.1:${front.address().port}/${name}`, { tracer }));
    const r = await push(t, { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: c.oid, objects: c.objects });
    assert.equal(r.ok, true, r.error?.message);
    assert.equal(got.te, 'chunked');
    assert.equal(got.cl, null);
    const exchange = spans().find(s => s.name === 'git.receive-pack');
    assert.equal(got.bytes.length, exchange.attrs['git.request.bytes']);
    assert.equal(tipOf(bare), c.oid);
  } finally { await new Promise(r => front.close(r)); }
});

test('a pack at most INFLATE_CHUNK is sent as bytes, redirect manual, as before', async () => {
  const { bare, url } = repo();
  const c = commitOf(new TextEncoder().encode('small\n'));
  const { seen, fetchImpl } = capture();
  const t = unwrap(createTransport(url, { fetchImpl }));
  const r = await push(t, { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: c.oid, objects: c.objects });
  assert.equal(r.ok, true, r.error?.message);
  assert.deepEqual(seen, [{ streamed: false, duplex: null, redirect: 'manual' }]);
  assert.ok(r.value.packBytes <= INFLATE_CHUNK);
  assert.equal(tipOf(bare), c.oid);
});

test('a streamed pack over maxPackBytes is refused with no receive-pack request; got is the measured pack', async () => {
  const { bare, url } = repo();
  const c = commitOf(random(1 << 20));
  const { seen, fetchImpl } = capture();
  const t = unwrap(createTransport(url, { fetchImpl, limits: withLimits({ maxPackBytes: 1 << 20 }) }));
  const r = await push(t, { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: c.oid, objects: c.objects });
  assert.equal(r.ok, false);
  assert.deepEqual([r.error.code, r.error.what, r.error.max], ['limit_exceeded', 'push pack bytes', 1 << 20]);
  assert.ok(r.error.got > 1 << 20);
  assert.equal(seen.length, 0);
  assert.equal(tipOf(bare), null);
});

test('an object that changes between the passes: pass 2 refuses, the push is ambiguous, git did not move the ref', async () => {
  for (const shape of ['same length', 'longer']) {
    const { bare, url } = repo();
    // 'longer': random then zeros (pass 1 is past INFLATE_CHUNK, so it streams), the zeros random by pass 2
    const blob = random(INFLATE_CHUNK * 8);
    if (shape === 'longer') blob.fill(0, INFLATE_CHUNK * 2);
    const c = commitOf(blob);
    // after pass 1 (the request is being made), before pass 2 reads the blob
    const { seen, fetchImpl } = capture(() => { if (shape === 'longer') randomFillSync(blob, INFLATE_CHUNK * 2); else blob[100] ^= 1; });
    const t = unwrap(createTransport(url, { fetchImpl }));
    const r = await push(t, { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: c.oid, objects: c.objects });
    assert.equal(r.ok, false, shape);
    assert.equal(r.error.code, 'ambiguous', shape);
    assert.equal(r.error.original, 'internal', shape);
    assert.match(r.error.message, /second deflate pass/, shape);
    assert.equal(seen.length, 1, shape);
    assert.equal(tipOf(bare), null, `${shape}: git refused the cut pack`);
  }
});

test('a 3xx on the streamed POST is not followed: nothing reaches the other origin, the push is ambiguous', async () => {
  let other = 0;
  const target = http.createServer((req, res) => { other++; req.resume(); res.end(); });
  await new Promise(r => target.listen(0, '127.0.0.1', r));
  const { bare } = repo();
  const name = bare.split('/').pop();
  const front = http.createServer((req, res) => {
    if (req.method === 'POST') { req.resume(); res.writeHead(307, { location: `http://127.0.0.1:${target.address().port}/x/git-receive-pack` }); res.end(); return; }
    req.pipe(http.request(`${srv.url}${req.url}`, { method: req.method, headers: req.headers }, up => { res.writeHead(up.statusCode, up.headers); up.pipe(res); }));
  });
  await new Promise(r => front.listen(0, '127.0.0.1', r));
  try {
    const c = commitOf(random(INFLATE_CHUNK * 3));
    const t = unwrap(createTransport(`http://127.0.0.1:${front.address().port}/${name}`));
    const r = await push(t, { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: c.oid, objects: c.objects });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'ambiguous');
    assert.equal(r.error.original, 'network');
    assert.equal(other, 0);
    assert.equal(tipOf(bare), null);
  } finally { await new Promise(r => front.close(r)); await new Promise(r => target.close(r)); }
});

test('pushRepo streams its delta pack: the history lands, fsck clean', async () => {
  const { bare, url } = repo();
  const work = join(root, `w${n++}`); mkdirSync(work);
  git(work, ['init', '-q', '-b', 'main']);
  const base = Buffer.from(random(512 << 10));
  for (let i = 0; i < 3; i++) {
    base.write(`version ${i}\n`, 1000 * i);
    writeFileSync(join(work, 'data.bin'), base);
    git(work, ['add', '.']); git(work, ['-c', 'user.name=L', '-c', 'user.email=l@x', 'commit', '-q', '-m', `c${i}`]);
  }
  const { seen, fetchImpl } = capture();
  const r = await pushRepo(work, url, { refspecs: ['main'] }, { fetchImpl });
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(r.value.deltas, 2, 'two OFS deltas against the previous version');
  assert.deepEqual(seen.map(s => s.streamed), [true]);
  assert.equal(tipOf(bare), git(work, ['rev-parse', 'main']).trim());
  assert.deepEqual(fsckProblems(bare), []);
});

test('the bytes of a captured streamed body are the request a buffered push would send', async () => {
  const { url } = repo();
  const c = commitOf(random(INFLATE_CHUNK * 2));
  let bytes = null;
  const fetchImpl = async (u, init) => { if (!String(u).endsWith('/git-receive-pack')) return fetch(u, init); const b = await readBody(init); bytes = b.bytes; assert.equal(b.streamed, true); return fetch(u, b.init); };
  const t = unwrap(createTransport(url, { fetchImpl }));
  assert.equal((await push(t, { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: c.oid, objects: c.objects })).ok, true);
  const { buildPack } = await import('../src/pack.js');
  const pack = (await buildPack(c.objects)).pack;
  assert.deepEqual(bytes.subarray(bytes.length - pack.length), Buffer.from(pack));
  assert.equal(bytes.subarray(bytes.length - pack.length - 4, bytes.length - pack.length).toString(), '0000');
});

const runChild = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [...MEMORY_CELL_FLAGS, '--import', './test/ts-resolve.mjs', 'test/push-stream-child.mjs', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', errText = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { errText += d; });
  child.on('close', status => { try { resolve({ status, ...JSON.parse(out) }); } catch { resolve({ status, out, err: errText }); } });
  child.on('error', reject);
});

test('memory: a 32 MiB streamed push holds well under one copy of the object (live arrayBuffers, gc-sampled)', async () => {
  const { bare, url } = repo();
  const L = 32 << 20;
  const r = await runChild([url, String(L)]);
  assert.equal(r.status, 0, r.err ?? r.out);
  console.log(JSON.stringify(r));
  assert.equal(r.ok, true, r.error);
  assert.equal(tipOf(bare), r.commit);
  // measured: 80 KB to 2.3 MB live beyond the object (socket and zlib buffers in flight); the buffered writer held about 4 L
  assert.ok(r.liveDelta < L / 8, `live arrayBuffers delta ${r.liveDelta}`);
  assert.ok(r.rssDelta < L, `rss delta ${r.rssDelta}`);
});
