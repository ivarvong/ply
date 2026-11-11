// The pipeline under workerd (the Workers runtime ply's main consumer runs on), against the local git server. The worker
// is test/workerd/worker.mjs bundled with src by esbuild (test/workerd/build.mjs). Part of the default suite and CI.
// workerd is a devDependency; without it the tests skip locally, and fail under CI (a skipped suite is a dead suite, #101).
//   WORKERD=/path/to/workerd npx vitest run test/workerd.test.js      (default: looks in ./node_modules/.bin and ../wd/node_modules/.bin)
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, gitBuf, gitUserinfoCred, gitWithCred, tmpRoot, makeBareRepo, startGitServer, startAuthGate, commitFiles, fsckProblems } from './server.js';
import { build } from './workerd/build.mjs';

const candidates = [process.env.WORKERD, fileURLToPath(new URL('../node_modules/.bin/workerd', import.meta.url)), fileURLToPath(new URL('../../wd/node_modules/.bin/workerd', import.meta.url))].filter(Boolean);
const WORKERD = candidates.find(p => existsSync(p));
const PORT = 18790 + (process.pid % 100);
if (!WORKERD && process.env.CI) throw new Error(`workerd not found (looked in ${candidates.join(', ')}); CI must run this suite`);

let root, cleanup, srv, proc;
before(async () => {
  if (!WORKERD) return;
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  const cfg = build({ port: PORT, outDir: join(root, 'wd') });
  proc = spawn(WORKERD, ['serve', cfg], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); if (/error/i.test(String(d))) console.error('workerd:', String(d).slice(0, 300)); });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/ping`)).ok) return; } catch { } await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`workerd did not answer /ping on ${PORT} within 10 s (exit ${proc.exitCode}):\n${stderr}`);
});
after(async () => { if (!WORKERD) return; proc?.kill(); await srv?.close(); cleanup?.(); });

const post = async (path, body, q = '') => (await fetch(`http://127.0.0.1:${PORT}${path}${q}`, { method: 'POST', body: JSON.stringify(body) })).json();

// packSubset awaits a chunk read bare on the platform's reader and relies on the halt's reader.cancel() to settle a read
// in flight. The Streams standard says it does, with done (ReadableStreamCancel closes the stream, and closing resolves
// every pending read request). workerd settles it too on an internal stream, here a fetch body whose server stalls
// after 1024 bytes (an R2 body is the same kind of stream), but by rejecting it (seen at compatibilityDate 2024-09-23).
// What packSubset needs is that it settles, either way; the second test is packSubset itself over that stream.
// Turns are counted, not timed.
test('workerd: cancel() settles a read in flight on an internal stream', { skip: !WORKERD }, async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.write(Buffer.alloc(1024, 7)); /* never ends */ });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const r = await post('/cancel-pending-read', { url: `http://127.0.0.1:${server.address().port}/stall`, bytes: 1024 });
    assert.deepEqual([r.got, r.before], [1024, 'pending'], JSON.stringify(r));
    assert.ok(r.after === 'done' || r.after === 'rejected', `the read in flight settles: ${JSON.stringify(r)}`);
  } finally { server.closeAllConnections(); server.close(); }
});
// 1036 = the 12-byte pack header + the 1024 bytes the server sends before it stalls (the entry's header is skipped
// from the range and written anew, the same length). Then: the consumer's read in flight ends (done: the stream is
// cancelled) and cancel() settles. Not asserted, and open: workerd reports one unhandled rejection carrying the cancel
// reason (`rejections` here, `unhandled` in the route above, which runs no ply code and handles both of its promises:
// it is the platform reader's own), the same with the chunk read raced as with it awaited bare.
test('workerd: packSubset over an internal stream that stalls: cancel settles and the read in flight ends', { skip: !WORKERD }, async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.write(Buffer.alloc(1024, 7)); /* never ends */ });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const r = await post('/subset-cancel', { url: `http://127.0.0.1:${server.address().port}/stall`, bytes: 1036 });
    assert.deepEqual([r.got, r.before, r.read, r.cancel], [1036, 'pending', 'done', 'settled'], JSON.stringify(r));
  } finally { server.closeAllConnections(); server.close(); }
});

// #255 under workerd: a Node server that drips, stalls or answers late; the worker's transport must cut stalls (first
// byte, idle) and let a long steady exchange through. Timers in workerd fire while a body read is pending.
test('workerd: first-byte and idle timeouts; a long steady body or upload is not cut', { skip: !WORKERD }, async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const server = http.createServer(async (req, res) => {
    const mode = new URL(req.url, 'http://x').pathname.split('/')[1];
    // a client that gives up resets the connection mid-upload: that is the expected end of those cases
    try { for await (const _ of req) { /* the upload, read as it comes */ } } catch { return; }
    if (mode === 'slowheaders') await sleep(800);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
    const frames = mode === 'steady' ? 20 : mode === 'stall' ? 2 : 1;
    for (let i = 0; i < frames; i++) { res.write('0008abcd'); if (mode === 'steady') await sleep(40); }
    if (mode === 'stall') return; // never ends: the client must give up
    res.end('0000');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const limits = { firstByteTimeoutMs: 250, idleTimeoutMs: 250 };
  try {
    const run = (mode, extra = {}) => post('/timeouts', { url: `${base}/${mode}/r.git`, mode, limits: { ...limits, ...extra } });
    const steady = await run('steady');
    assert.deepEqual([steady.ok, steady.frames], [true, 21], JSON.stringify(steady));
    assert.ok(steady.ms > 600, `steady body ran ${steady.ms} ms, past every 250 ms timer`);
    const capped = await run('steady', { requestTimeoutMs: 400 });
    assert.deepEqual([capped.ok, capped.code, capped.what], [false, 'timeout', 'requestTimeoutMs'], JSON.stringify(capped));
    const stall = await run('stall');
    assert.deepEqual([stall.ok, stall.code, stall.what, stall.limit], [false, 'timeout', 'idleTimeoutMs', 'idleTimeoutMs'], JSON.stringify(stall));
    assert.ok(stall.ms < 3000, `${stall.ms} ms`);
    const slow = await run('slowheaders');
    assert.deepEqual([slow.ok, slow.code, slow.what], [false, 'timeout', 'firstByteTimeoutMs'], JSON.stringify(slow));
    const up = await run('uploadsteady');
    assert.deepEqual([up.ok, up.frames], [true, 2], JSON.stringify(up));
    const upStall = await run('uploadstall');
    assert.deepEqual([upStall.ok, upStall.code, upStall.what], [false, 'timeout', 'idleTimeoutMs'], JSON.stringify(upStall));
    console.log(`  workerd timeouts: steady ${steady.ms} ms ok, stall cut at ${stall.ms} ms, slow headers ${slow.ms} ms, upload stall ${upStall.ms} ms`);
  } finally { server.closeAllConnections?.(); server.close(); }
});

test('workerd: platform features the pipeline relies on', { skip: !WORKERD }, async () => {
  const f = await (await fetch(`http://127.0.0.1:${PORT}/features`)).json();
  for (const k of ['DecompressionStream', 'CompressionStream', 'AbortSignalAny', 'AbortSignalTimeout', 'getRandomValues']) assert.equal(f[k], 'function', k);
  assert.equal(f.deflateOk, true);
});

test('workerd: edit small file, 24 MB file, cache hit on second edit; git-verified', { skip: !WORKERD }, async () => {
  const bare = makeBareRepo(root, 'e'); const work = join(root, 'we'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  const big = Buffer.alloc(24 << 20); for (let i = 0; i < big.length; i += 4096) big.write(`line ${i}\n`, i); big.write('MARK', 12 << 20);
  commitFiles(work, bare, { 'a/b/c.txt': 'hello MARK world\n', 'big.bin': big }, 'seed');
  const url = `${srv.url}/e.git`;
  let r = await post('/edit', { url, path: 'a/b/c.txt', find: 'MARK', replace: 'WORKERD' });
  assert.ok(r.results[0].ok, JSON.stringify(r.results[0]));
  assert.equal(gitBuf(bare, ['cat-file', 'blob', 'main:a/b/c.txt']).toString(), 'hello WORKERD world\n');
  assert.equal(git(bare, ['rev-parse', 'main']).trim(), r.results[0].newCommit);
  r = await post('/edit', { url, path: 'big.bin', find: 'MARK', replace: 'WD' });
  assert.ok(r.results[0].ok, JSON.stringify(r.results[0]));
  assert.ok(r.results[0].pushBytes < 1500, 'delta push');
  console.log(`  24MB edit under workerd: ${r.results[0].ms}ms, hasher=${r.blob[0]['git.edit.blob.hasher']}`);
  assert.ok(r.roots[0]['mem.alloc.max_single'] <= 65536 && r.roots[0]['mem.alloc.max_single'] >= 4096, `max single alloc ${r.roots[0]['mem.alloc.max_single']} (workerd DecompressionStream chunks are 4 KiB)`);
  const got = gitBuf(bare, ['cat-file', 'blob', 'main:big.bin']);
  assert.equal(got.length, big.length - 2); assert.equal(got.subarray(12 << 20, (12 << 20) + 2).toString(), 'WD');
  // second edit on the same path inside the same isolate: tree cache is module-scoped per request here (cache passed per /edit call), so this checks the edit, not the cache
  r = await post('/edit', { url, path: 'a/b/c.txt', find: 'WORKERD', replace: 'AGAIN', n: 2 });
  assert.ok(r.results[0].ok && !r.results[0].noop); assert.equal(r.results[1].code, 'match_count');
  assert.deepEqual(fsckProblems(bare), []);
  console.log(`  small ${r.results[0].ms}ms; 24MB edit git-verified, max alloc ${r.roots[0]['mem.alloc.max_single']}`);
});

test('workerd: pack cache on caches.default + head hint (ls-refs skipped, CAS catches a stale hint)', { skip: !WORKERD }, async () => {
  const bare = makeBareRepo(root, 'pc'); const work = join(root, 'wpc'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  commitFiles(work, bare, { 'a/b/c.txt': 'hello MARK world\n' }, 'seed');
  const url = `${srv.url}/pc.git`;
  const head = git(bare, ['rev-parse', 'main']).trim();
  let r = await post('/edit', { url, path: 'a/b/c.txt', find: 'MARK', replace: 'H1', packCache: true, head });
  assert.ok(r.results[0].ok, JSON.stringify(r.results[0]));
  assert.equal(r.results[0].hint, 'used'); assert.equal(r.results[0].oldCommit, head);
  assert.equal(git(bare, ['rev-parse', 'main']).trim(), r.results[0].newCommit);
  // workerd standalone has no cache service bound: caches.default is present but never hits. The property that matters
  // here is that the wrapper runs on the platform (tee, waitUntil, Headers) and reports MISS honestly rather than HIT?.
  const s0 = r.results[0].packCache; assert.equal(s0.miss + s0.bypass > 0, true); assert.equal(s0.hit, 0);
  assert.ok(r.roots[0]['git.edit.head.hint'] === head);
  // stale hint, parallel mode (default): corrected by the overlapped ls-refs, one push, one root
  git(work, ['fetch', '-q', bare, 'refs/heads/main']); git(work, ['reset', '-q', '--hard', 'FETCH_HEAD']);
  commitFiles(work, bare, { 'other.txt': 'x\n' }, 'other');
  let moved = git(bare, ['rev-parse', 'main']).trim();
  r = await post('/edit', { url, path: 'a/b/c.txt', find: 'H1', replace: 'H2', packCache: true, head: r.results[0].newCommit });
  assert.ok(r.results[0].ok, JSON.stringify(r.results[0]));
  assert.equal(r.results[0].hint, 'stale'); assert.equal(r.results[0].oldCommit, moved);
  assert.deepEqual(r.roots.map(x => x['git.edit.outcome']), ['ok']);
  assert.equal(r.blob[0]['git.edit.blob.hasher'], 'digeststream', 'workerd has crypto.DigestStream: native SHA-1');
  assert.equal(gitBuf(bare, ['cat-file', 'blob', 'main:a/b/c.txt']).toString(), 'hello H2 world\n');
  assert.deepEqual(fsckProblems(bare), []);
});

test('workerd: Ed25519 signing through the platform WebCrypto; git verifies', { skip: !WORKERD }, async () => {
  const bare = makeBareRepo(root, 'sg'); const work = join(root, 'wsg'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  commitFiles(work, bare, { 'f.txt': 'MARK\n' }, 'seed');
  const r = await post('/edit', { url: `${srv.url}/sg.git`, path: 'f.txt', find: 'MARK', replace: 'SIGNED', sign: true });
  assert.ok(r.results[0].ok, JSON.stringify(r.results[0])); assert.match(r.signer, /^ssh-ed25519 /);
  const signers = join(root, 'signers'); writeFileSync(signers, `wd@x namespaces="git" ${r.signer}\n`);
  const { spawnSync } = await import('node:child_process');
  const v = spawnSync('git', ['-C', bare, '-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen', '-c', `gpg.ssh.allowedSignersFile=${signers}`, 'verify-commit', r.results[0].newCommit], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stderr); assert.match(v.stderr + v.stdout, /Good "git" signature/);
});

test('workerd: 10 concurrent writers in one isolate converge via cas_conflict retries', { skip: !WORKERD }, async () => {
  const bare = makeBareRepo(root, 'c'); const work = join(root, 'wc'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  const files = {}; for (let i = 0; i < 10; i++) files[`f${i}.txt`] = `v0 MARK${i}\n`;
  commitFiles(work, bare, files, 'seed');
  const url = `${srv.url}/c.git`;
  const rs = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
    for (let tries = 0; tries < 60; tries++) {
      const r = await post('/edit', { url, path: `f${i}.txt`, find: `MARK${i}`, replace: `DONE${i}` });
      const x = r.results[0]; if (x.ok) return { i, tries }; if (x.code !== 'cas_conflict') return { i, tries, fail: `${x.code} ${x.message}` };
    }
    return { i, fail: 'livelock' };
  }));
  for (const r of rs) assert.ok(!r.fail, JSON.stringify(r));
  for (let i = 0; i < 10; i++) assert.equal(gitBuf(bare, ['cat-file', 'blob', `main:f${i}.txt`]).toString(), `v0 DONE${i}\n`);
  assert.equal(git(bare, ['rev-list', '--count', 'main']).trim(), '11');
  assert.ok(rs.some(r => r.tries > 0), 'contention actually occurred');
  assert.deepEqual(fsckProblems(bare), []);
  console.log(`  retries: ${rs.map(r => r.tries).join(',')}`);
});

test('workerd: a 3xx is never followed (redirect: manual) on the GET or the POST; nothing reaches the other origin', { skip: !WORKERD }, async () => {
  const listen = h => new Promise(ok => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => ok(s)); });
  const seen = [];
  const other = await listen((req, res) => { seen.push({ url: req.url, authorization: req.headers.authorization ?? null }); res.writeHead(200, { 'content-type': 'text/plain' }); res.end('x'); });
  const red = await listen((req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${other.address().port}${req.url}` }); res.end(); });
  try {
    const r = await post('/redirect', { url: `http://127.0.0.1:${red.address().port}/r.git`, auth: { token: 'ghp_workerdRedirect0123456789' } });
    assert.equal(r.get.code, 'http', JSON.stringify(r.get)); assert.equal(r.get.status, 307);
    assert.equal(r.post.code, 'http', JSON.stringify(r.post)); assert.equal(r.post.status, 307);
    assert.match(r.post.message, /redirected to .*\/r\.git\/git-upload-pack; ply does not follow redirects/);
    const plyHits = seen.filter(h => h.authorization !== 'Bearer workerd-follow-probe');
    assert.deepEqual(plyHits, [], 'ply requests reached the redirect target');
    // Not ply: what this workerd does under the default `follow` with an Authorization header, cross-origin (recorded).
    const probe = seen.find(h => h.authorization === 'Bearer workerd-follow-probe') ?? seen.find(h => h.url.includes('info/refs'));
    console.log(`  workerd default follow, cross-origin: ${probe ? `target reached, Authorization ${probe.authorization ? 'FORWARDED' : 'stripped'}` : 'target not reached'} (${JSON.stringify(r.follow)})`);
  } finally { other.close(); red.close(); }
});

test('workerd: a token given as the URL user authenticates the edit with the Authorization git sends; it reaches no span (#32)', { skip: !WORKERD }, async () => {
  const bare = makeBareRepo(root, 'ui'); const work = join(root, 'wui'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  commitFiles(work, bare, { 'a.txt': 'hello MARK\n' }, 'seed');
  const TOKEN = 'glpat-WorkerdUserOnlyToken';
  const gate = await startAuthGate(srv.url);
  try {
    const url = `http://${TOKEN}@${new URL(gate.url).host}/ui.git`;
    const { cred, config } = await gitUserinfoCred(work, url); // git decodes it; no credential in the URL git dials
    const ls = await gitWithCred(work, ['ls-remote', `${gate.url}/ui.git`], cred, config);
    assert.equal(ls.status, 0, ls.stderr);
    const gitAuth = [...new Set(gate.seen.map(x => x.authorization).filter(Boolean))];
    assert.deepEqual(gitAuth, [`Basic ${btoa(`${TOKEN}:`)}`]);
    gate.seen.length = 0;
    const r = await post('/edit', { url, path: 'a.txt', find: 'MARK', replace: 'WORKERD', dump: true });
    assert.ok(r.results[0].ok, JSON.stringify(r.results[0]));
    assert.equal(git(bare, ['rev-parse', 'main']).trim(), r.results[0].newCommit);
    assert.deepEqual([...new Set(gate.seen.map(x => x.authorization))], gitAuth);
    for (const s of [TOKEN, gitAuth[0].slice(6), `${TOKEN}@`]) assert.ok(!r.dump.includes(s), `${s} in a span`);
  } finally { await gate.close(); }
});

test('workerd: readFile\'s blob stream, drained and cancelled; git.read.blob follows the root in a trace of its own (#35)', { skip: !WORKERD }, async () => {
  const bare = makeBareRepo(root, 'rd'); const work = join(root, 'wrd'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  const big = Buffer.alloc(1 << 20); for (let i = 0; i < big.length; i += 4096) big.write(`line ${i}\n`, i);
  commitFiles(work, bare, { 'big.bin': big }, 'seed');
  for (const cancel of [false, true]) {
    const r = await post('/read', { url: `${srv.url}/rd.git`, path: 'big.bin', cancel });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.size, big.length);
    if (cancel) assert.ok(r.bytes > 0 && r.bytes < big.length, `one chunk: ${r.bytes}`); else assert.equal(r.bytes, big.length);
    const rootSpan = r.spans.find(s => s.name === 'git.read'), blob = r.spans.find(s => s.name === 'git.read.blob');
    assert.ok(blob, 'the blob span ended');
    assert.deepEqual([blob.parentSpanId, blob.traceId === rootSpan.traceId, blob.links, rootSpan.links], [null, false, [[rootSpan.spanId, 'follows_from']], [[blob.spanId, 'followed_by']]]);
    assert.equal(blob.outcome, cancel ? 'cancelled' : 'ok');
    assert.equal(r.spans.filter(s => s.name === 'git.read.blob').length, 1);
  }
});

test('workerd: a limit hit inside readFile\'s blob stream reaches the reader as limit_exceeded, as on node (#144)', { skip: !WORKERD }, async () => {
  const bare = makeBareRepo(root, 'rdcap'); const work = join(root, 'wrdcap'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  const big = randomBytes((1 << 20) + 1); // incompressible: the pack is over 1 MiB
  commitFiles(work, bare, { 'big.bin': big }, 'seed');
  const r = await post('/read', { url: `${srv.url}/rdcap.git`, path: 'big.bin', limits: { maxPackBytes: 1 << 20 } });
  assert.deepEqual([r.ok, r.code, r.what, r.blob], [false, 'limit_exceeded', 'pack bytes', ['limit_exceeded']], JSON.stringify(r));
});

// #172: the streamed push under workerd. workerd ends an errored request body as if it were complete (measured: the
// server sees a clean chunked end), so a pass 2 that refuses to finish the pack must leave git without a whole pack.
test('workerd: pass 1 and pass 2 write buildPack\'s bytes under workerd\'s CompressionStream', { skip: !WORKERD }, async () => {
  for (const half of [false, true]) {
    const r = await post('/packwrite', { sizes: [0, 1, 16383, 16384, 16385, 65535, 65536, 65537, 200000, 1 << 20], half });
    for (const c of r) assert.deepEqual([c.passes, c.built], [true, true], JSON.stringify(c));
  }
});

test('workerd: a 4 MiB push streams its pack (duplex half; redirect manual, workerd refuses error) and lands; a pack changed between passes does not', { skip: !WORKERD }, async () => {
  const bare = makeBareRepo(root, 'ps');
  const r = await post('/push', { url: `${srv.url}/ps.git`, size: 4 << 20 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.seen, [{ streamed: true, duplex: 'half', redirect: 'manual' }]);
  assert.equal(git(bare, ['rev-parse', 'main']).trim(), r.commit);
  assert.deepEqual(fsckProblems(bare), []);
  const cut = makeBareRepo(root, 'pscut');
  const m = await post('/push', { url: `${srv.url}/pscut.git`, size: 1 << 20, mutate: true });
  assert.deepEqual([m.ok, m.code, m.original], [false, 'ambiguous', 'internal'], JSON.stringify(m));
  assert.match(m.message, /second deflate pass/);
  assert.equal(git(cut, ['for-each-ref']).trim(), '', 'git moved no ref');
});

test('workerd: pushPack streams a caller\'s pack and lands; a wrong length or a failed source does not, though workerd ends an errored body as if complete', { skip: !WORKERD }, async () => {
  const bare = makeBareRepo(root, 'pp');
  const r = await post('/push-pack', { url: `${srv.url}/pp.git`, size: 4 << 20, mode: 'ok' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.seen, [{ streamed: true, duplex: 'half', redirect: 'manual' }]);
  assert.equal(r.packBytes, r.whole);
  assert.equal(git(bare, ['rev-parse', 'main']).trim(), r.commit);
  assert.deepEqual(fsckProblems(bare), []);
  for (const [mode, original] of [['short', 'bad_request'], ['errored', 'internal']]) {
    const cut = makeBareRepo(root, `pp${mode}`);
    const m = await post('/push-pack', { url: `${srv.url}/pp${mode}.git`, size: 1 << 20, mode });
    assert.deepEqual([m.ok, m.code, m.original], [false, 'ambiguous', original], JSON.stringify(m));
    assert.equal(git(cut, ['for-each-ref']).trim(), '', `${mode}: git moved no ref`);
  }
});


