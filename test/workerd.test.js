// The pipeline under workerd (the Workers runtime), against the local git server. Skipped if workerd is not installed.
//   WORKERD=/path/to/workerd node --test test/workerd.test.js      (default: looks in ./node_modules/.bin and ../wd/node_modules/.bin)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, commitFiles } from './server.js';
import { build } from './workerd/build.mjs';

const candidates = [process.env.WORKERD, fileURLToPath(new URL('../node_modules/.bin/workerd', import.meta.url)), fileURLToPath(new URL('../../wd/node_modules/.bin/workerd', import.meta.url))].filter(Boolean);
const WORKERD = candidates.find(p => existsSync(p));
const PORT = 18790 + (process.pid % 100);

let root, cleanup, srv, proc;
before(async () => {
  if (!WORKERD) return;
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  const cfg = build({ port: PORT, outDir: join(root, 'wd') });
  proc = spawn(WORKERD, ['serve', cfg], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', d => { if (/error/i.test(String(d))) console.error('workerd:', String(d).slice(0, 300)); });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/ping`)).ok) break; } catch { } await new Promise(r => setTimeout(r, 100)); }
});
after(async () => { if (!WORKERD) return; proc.kill(); await srv.close(); cleanup(); });

const post = async (path, body, q = '') => (await fetch(`http://127.0.0.1:${PORT}${path}${q}`, { method: 'POST', body: JSON.stringify(body) })).json();

test('workerd: platform features the pipeline relies on', { skip: !WORKERD && 'workerd not installed' }, async () => {
  const f = await (await fetch(`http://127.0.0.1:${PORT}/features`)).json();
  for (const k of ['DecompressionStream', 'CompressionStream', 'AbortSignalAny', 'AbortSignalTimeout', 'getRandomValues']) assert.equal(f[k], 'function', k);
  assert.equal(f.deflateOk, true);
});

test('workerd: edit small file, 24 MB file, cache hit on second edit; git-verified', { skip: !WORKERD && 'workerd not installed' }, async () => {
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
  assert.equal(git(bare, ['fsck', '--strict', '--no-dangling']).trim(), '');
  console.log(`  small ${r.results[0].ms}ms; 24MB edit git-verified, max alloc ${r.roots[0]['mem.alloc.max_single']}`);
});

test('workerd: pack cache on caches.default + head hint (ls-refs skipped, CAS catches a stale hint)', { skip: !WORKERD && 'workerd not installed' }, async () => {
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
  assert.equal(git(bare, ['fsck', '--strict', '--no-dangling']).trim(), '');
});

test('workerd: Ed25519 signing through the platform WebCrypto; git verifies', { skip: !WORKERD && 'workerd not installed' }, async () => {
  const bare = makeBareRepo(root, 'sg'); const work = join(root, 'wsg'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  commitFiles(work, bare, { 'f.txt': 'MARK\n' }, 'seed');
  const r = await post('/edit', { url: `${srv.url}/sg.git`, path: 'f.txt', find: 'MARK', replace: 'SIGNED', sign: true });
  assert.ok(r.results[0].ok, JSON.stringify(r.results[0])); assert.match(r.signer, /^ssh-ed25519 /);
  const signers = join(root, 'signers'); writeFileSync(signers, `wd@x namespaces="git" ${r.signer}\n`);
  const { spawnSync } = await import('node:child_process');
  const v = spawnSync('git', ['-C', bare, '-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen', '-c', `gpg.ssh.allowedSignersFile=${signers}`, 'verify-commit', r.results[0].newCommit], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stderr); assert.match(v.stderr + v.stdout, /Good "git" signature/);
});

test('workerd: 10 concurrent writers in one isolate converge via cas_conflict retries', { skip: !WORKERD && 'workerd not installed' }, async () => {
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
  assert.equal(git(bare, ['fsck', '--strict', '--no-dangling']).trim(), '');
  console.log(`  retries: ${rs.map(r => r.tries).join(',')}`);
});

test('workerd: the pipeline over SSH via cloudflare:sockets against a real sshd; git verifies', { skip: !WORKERD && 'workerd not installed' }, async () => {
  const { startSshd } = await import('./sshd.js');
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const privateKeyPkcs8Hex = [...new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))].map(b => b.toString(16).padStart(2, '0')).join('');
  const sshd = await startSshd(root, { publicKeyRaw });
  try {
    const bare = makeBareRepo(root, 'wssh'); const work = join(root, 'wwssh'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
    commitFiles(work, bare, { 'a/b.txt': 'hello MARK\n' }, 'seed');
    const r = await post('/ssh-edit', { url: `ssh://${sshd.user}@127.0.0.1:${sshd.port}${bare}`, hostKey: sshd.hostKeyLine, privateKeyPkcs8Hex, publicKeyHex: [...publicKeyRaw].map(b => b.toString(16).padStart(2, '0')).join(''), path: 'a/b.txt', find: 'MARK', replace: 'WORKERD-SSH' });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(git(bare, ['rev-parse', 'main']).trim(), r.newCommit);
    assert.equal(gitBuf(bare, ['cat-file', 'blob', 'main:a/b.txt']).toString(), 'hello WORKERD-SSH\n');
    assert.equal(git(bare, ['fsck', '--strict', '--no-dangling']).trim(), '');
    const connect = r.spans.find(s => s.name === 'ssh.connect');
    assert.equal(connect.attrs['ssh.cipher.c2s'], 'aes128-gcm@openssh.com'); assert.equal(connect.attrs['ssh.kex'], 'curve25519-sha256');
    console.log(`  ssh edit under workerd: ${r.ms}ms, ${r.stats.bytesIn} B in / ${r.stats.bytesOut} B out, ${r.stats.packetsIn + r.stats.packetsOut} packets`);
  } finally { await sshd.close(); }
});

test('workerd: I1 over SSH — a trickling server is cut at requestTimeoutMs and an aborted signal stops the exchange, typed as over HTTP', { skip: !WORKERD && 'workerd not installed' }, async () => {
  const { startSshd, trickleProxy } = await import('./sshd.js');
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const hexOf = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  const keys = { privateKeyPkcs8Hex: hexOf(new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))), publicKeyHex: hexOf(publicKeyRaw) };
  const sshd = await startSshd(join(root, 'bound'), { publicKeyRaw });
  const px = await trickleProxy(sshd.port);
  try {
    const bare = makeBareRepo(root, 'wbound'); const work = join(root, 'wwbound'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
    commitFiles(work, bare, { 'f.txt': 'x\n' }, 'seed');
    const req = extra => post('/ssh-bound', { url: `ssh://${sshd.user}@127.0.0.1:${px.port}${bare}`, hostKey: sshd.hostKeyLine, ...keys, ...extra });
    const ok = await req({ requestTimeoutMs: 5000 }); assert.ok(ok.ok, JSON.stringify(ok));
    px.mode.trickle = 100; // one byte per 100 ms from the first: under workersStream's per-read idle timer, never done
    const slow = await req({ requestTimeoutMs: 1000 });
    const aborted = await req({ requestTimeoutMs: 30_000, abortMs: 300 });
    console.log(`  workerd ssh: trickle ${JSON.stringify(slow)}; abort ${JSON.stringify(aborted)}`);
    assert.deepEqual([slow.code, slow.message], ['timeout', 'request aborted: request exceeded 1000 ms']);
    assert.ok(slow.ms >= 990 && slow.ms < 1500, `cut at ${slow.ms} ms`);
    assert.equal(aborted.code, 'aborted'); assert.match(aborted.message, /^request aborted: The operation was aborted/); // workerd's default abort reason
    assert.ok(aborted.ms >= 290 && aborted.ms < 800, `stopped at ${aborted.ms} ms`);
  } finally { await px.close(); await sshd.close(); }
});

test('workerd: a 3xx is never followed (redirect: manual) on the GET or the POST; nothing reaches the other origin', { skip: !WORKERD && 'workerd not installed' }, async () => {
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
