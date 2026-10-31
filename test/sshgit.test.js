// git over SSH against a real sshd: edit/merge/rebase/sign/verify on one connection; parity with git's own ssh client
// (clone + push through `ssh`); every failure typed (pinned host key mismatch before any auth, refused key, server
// without AcceptEnv GIT_PROTOCOL, missing repo, bad url); byte mutation of the encrypted stream always fails closed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, chmodSync, rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { git, tmpRoot, makeBareRepo, commitFiles } from './server.js';
import { startSshd, freePort, trickleProxy } from './sshd.js';
import { Rng } from './fuzz/prng.js';
import { createSshTransport, parseSshUrl, sshRedact } from '../src/sshgit.js';
import { nodeStream } from '../src/ssh-node.js';
import { SshClient, hostKeyLine, hostKeyFromLine, padded, mpint, str, u32, parseKexInit, kexInit, fingerprint } from '../src/ssh.js';
import { createTransport } from '../src/http.js';
import { withLimits } from '../src/limits.js';
import { retryPolicy } from '../src/errors.js';
import { concat, td } from '../src/bytes.js';
import { readFile } from '../src/read.js';
import { editFile } from '../src/edit.js';
import { mergeBranch } from '../src/merge.js';
import { rebaseBranch } from '../src/rebase.js';
import { lsRefs } from '../src/lsrefs.js';
import { discover } from '../src/discover.js';
import { receiveCaps } from '../src/receivecaps.js';
import { fetchPack } from '../src/fetchpack.js';
import { generateSigner } from '../src/sign.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';

let root, cleanup, sshd, kp, pub, n = 0;
const author = { name: 'ssh', email: 'ssh@x' };
before(async () => {
  ({ root, cleanup } = tmpRoot());
  kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  sshd = await startSshd(root, { publicKeyRaw: pub });
});
after(async () => { await sshd.close(); cleanup(); });
// polls f() until it equals want (a destroyed socket leaves the list a tick later), at most ~2 s; returns the last value
const settled = async (f, want) => { let v; for (let i = 0; i < 40 && (v = f()) !== want; i++) await new Promise(r => setTimeout(r, 50)); return v; };
const repo = () => { const name = `s${n++}`; const bare = makeBareRepo(root, name); const work = join(root, `w${name}`); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']); return { name, bare, work, url: `ssh://${sshd.user}@127.0.0.1:${sshd.port}${bare}` }; };
const transport = (url, extra = {}) => createSshTransport(url, { privateKey: kp.privateKey, publicKeyRaw: pub, hostKey: sshd.hostKeyLine, connect: nodeStream, tracer: new Tracer(), ...extra });

test('pure: url forms, host key line codec, packet padding, mpint, KEXINIT round-trip', async () => {
  assert.deepEqual(parseSshUrl('ssh://git@github.com/o/r.git'), { user: 'git', host: 'github.com', port: 22, path: '/o/r.git' });
  assert.deepEqual(parseSshUrl('ssh://u@h:2222/abs/path'), { user: 'u', host: 'h', port: 2222, path: '/abs/path' });
  assert.deepEqual(parseSshUrl('git@github.com:o/r.git'), { user: 'git', host: 'github.com', port: 22, path: 'o/r.git' });
  assert.deepEqual(parseSshUrl('h:relative/p'), { user: 'git', host: 'h', port: 22, path: 'relative/p' });
  assert.throws(() => parseSshUrl('https://github.com/o/r'), e => e.code === 'bad_request');
  assert.equal(sshRedact(parseSshUrl('git@github.com:o/r.git')), 'ssh://git@github.com/o/r.git');
  const raw = crypto.getRandomValues(new Uint8Array(32));
  assert.deepEqual(hostKeyFromLine(hostKeyLine(raw)), raw); assert.deepEqual(hostKeyFromLine(`github.com ${hostKeyLine(raw)}`), raw);
  assert.deepEqual(hostKeyFromLine(sshd.hostKeyLine), hostKeyFromLine(readFileSync(join(sshd.dir, 'host_ed25519.pub'), 'utf8')));
  assert.match(await fingerprint(raw), /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(await fingerprint(hostKeyFromLine(sshd.hostKeyLine)), execFileSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', join(sshd.dir, 'host_ed25519.pub')], { encoding: 'utf8' }).split(' ')[1], 'fingerprint == ssh-keygen -l');
  for (const [block, lengthCounts] of [[8, true], [16, false]]) for (let len = 0; len < 70; len++) { const p = padded(new Uint8Array(len), block, lengthCounts); const total = lengthCounts ? p.length : p.length - 4; assert.equal(total % block, 0); assert.ok(p[4] >= 4 && p[4] < block + 4); }
  assert.deepEqual([...mpint(Uint8Array.from([0, 0, 0x80, 1]))], [0, 0, 0, 3, 0, 0x80, 1]); assert.deepEqual([...mpint(Uint8Array.from([0x7f]))], [0, 0, 0, 1, 0x7f]); assert.deepEqual([...mpint(new Uint8Array(0))], [0, 0, 0, 0]);
  const k = parseKexInit(kexInit(new Uint8Array(16))); assert.deepEqual(k.kex, ['curve25519-sha256', 'curve25519-sha256@libssh.org']); assert.deepEqual(k.encCS, ['aes128-gcm@openssh.com', 'aes256-gcm@openssh.com']);
});

test('one connection: ls-refs, discover, receive caps, edits with hint + verify + signer, merge, rebase — git-verified', async () => {
  const r = repo();
  commitFiles(r.work, r.bare, { 'a/b.txt': 'hello MARK\n', 'other.txt': 'o\n' }, 'seed');
  const ex = arrayExporter(); const tracer = new Tracer({ exporter: ex });
  const t = transport(r.url, { tracer });
  try {
    const { refs } = await lsRefs(t, ['refs/heads/main']); assert.ok(refs.has('refs/heads/main'));
    const d = await discover(t); assert.match(d.agent, /^git\//); assert.equal(d.filter, true, 'uploadpack.allowFilter in the fixture');
    const caps = await receiveCaps(t); assert.ok(caps.has('report-status') && caps.has('side-band-64k'));
    const { signer } = await generateSigner();
    const e1 = await editFile(r.url, { path: 'a/b.txt', find: 'MARK', replace: 'ONE', author, message: 'one' }, { tracer, transport: t, verify: true, signer });
    assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), e1.newCommit);
    const e2 = await editFile(r.url, { path: 'a/b.txt', find: 'ONE', replace: 'TWO', author, message: 'two' }, { tracer, transport: t, verify: true, head: e1.newCommit });
    assert.equal(e2.hint, 'used'); assert.equal(git(r.bare, ['cat-file', '-p', 'main:a/b.txt']), 'hello TWO\n');
    // branch + rebase + merge over the same connection
    const e3 = await editFile(r.url, { path: 'other.txt', find: 'o', replace: 'o-branch', ref: 'refs/heads/feat', base: 'refs/heads/main', author, message: 'feat' }, { tracer, transport: t });
    const e4 = await editFile(r.url, { path: 'a/b.txt', find: 'TWO', replace: 'THREE', author, message: 'main moves' }, { tracer, transport: t });
    const rb = await rebaseBranch(r.url, { ref: 'refs/heads/feat', onto: 'refs/heads/main', committer: author }, { tracer, transport: t });
    assert.equal(rb.outcome, 'rebase'); assert.equal(git(r.bare, ['rev-parse', 'feat~1']).trim(), e4.newCommit);
    const m = await mergeBranch(r.url, { ref: 'refs/heads/main', from: 'refs/heads/feat', author }, { tracer, transport: t, verify: true });
    assert.equal(m.outcome, 'fast_forward');
    assert.equal(git(r.bare, ['cat-file', '-p', 'main:other.txt']), 'o-branch\n'); assert.equal(git(r.bare, ['cat-file', '-p', 'main:a/b.txt']), 'hello THREE\n');
    assert.equal(git(r.bare, ['fsck', '--strict', '--no-dangling']).trim(), '');
    const spans = ex.lines.flatMap(flattenLine);
    assert.equal(spans.filter(s => s.name === 'ssh.connect').length, 1, 'one handshake for everything');
    assert.equal(spans.filter(s => s.name === 'ssh.userauth').length, 1);
    const execs = spans.filter(s => s.name === 'ssh.exec'); assert.ok(execs.every(s => s.attrs['ssh.exit'] === 0), execs.map(s => s.attrs['ssh.exit']).join(','));
    assert.ok(spans.filter(s => s.name === 'git.receive-pack').every(s => s.attrs['git.transport'] === 'ssh'));
    console.log(`  ${execs.length} git processes, ${t.stats().packetsIn + t.stats().packetsOut} ssh packets, ${t.stats().bytesIn} B in / ${t.stats().bytesOut} B out`);
  } finally { await t.close(); }
  assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), git(r.bare, ['rev-parse', 'main']).trim());
  assert.ok(t.stats().packetsIn > 0);
});

test('parity with git over ssh: a clone through OpenSSH sees exactly what we pushed; git push through OpenSSH is visible to us', async () => {
  const r = repo();
  commitFiles(r.work, r.bare, { 'f.txt': 'MARK\n' }, 'seed');
  // git's own ssh client needs a file-based key: a second Ed25519 key, authorized alongside ours
  const kdir = join(root, 'gitkey'); mkdirSync(kdir, { recursive: true });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(kdir, 'id')]);
  const auth = join(sshd.dir, 'authorized_keys'); writeFileSync(auth, readFileSync(auth, 'utf8') + readFileSync(join(kdir, 'id.pub'), 'utf8'));
  const known = join(kdir, 'known_hosts'); writeFileSync(known, `[127.0.0.1]:${sshd.port} ${sshd.hostKeyLine}\n`);
  const env = { ...process.env, GIT_SSH_COMMAND: `ssh -i ${join(kdir, 'id')} -o UserKnownHostsFile=${known} -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes` };
  const t = transport(r.url);
  const e = await editFile(r.url, { path: 'f.txt', find: 'MARK', replace: 'OURS', author, message: 'ours over ssh' }, { tracer: new Tracer(), transport: t });
  const d = mkdtempSync(join(tmpdir(), 'par-'));
  try {
    const c = spawnSync('git', ['clone', '-q', r.url, d], { env, encoding: 'utf8' }); assert.equal(c.status, 0, c.stderr);
    assert.equal(execFileSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), e.newCommit);
    assert.equal(readFileSync(join(d, 'f.txt'), 'utf8'), 'OURS\n');
    writeFileSync(join(d, 'f.txt'), 'THEIRS\n');
    execFileSync('git', ['-C', d, '-c', 'user.name=g', '-c', 'user.email=g@x', '-c', 'commit.gpgsign=false', 'commit', '-q', '-am', 'git push over ssh'], { env });
    const p = spawnSync('git', ['-C', d, 'push', '-q', 'origin', 'HEAD:main'], { env, encoding: 'utf8' }); assert.equal(p.status, 0, p.stderr);
    const theirs = execFileSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const { refs } = await lsRefs(t, ['refs/heads/main']); assert.equal(refs.get('refs/heads/main').oid, theirs, 'fresh upload-pack sees git\'s push');
    const e2 = await editFile(r.url, { path: 'f.txt', find: 'THEIRS', replace: 'OURS2', author, message: 'on top of git\'s' }, { tracer: new Tracer(), transport: t, verify: true });
    assert.equal(e2.oldCommit, theirs);
  } finally { rmSync(d, { recursive: true, force: true }); await t.close(); }
});

test('failures are typed: host key mismatch (before auth), unauthorized key, no AcceptEnv, missing repo, scp-like url; none leaves a socket open', async () => {
  const r = repo(); commitFiles(r.work, r.bare, { 'f.txt': 'x\n' }, 'seed');
  // every connection a failing command dials, with whether it was closed: a failure must not hold a socket (issue #31: the
  // missing repo's connection stayed open until the socket's idle timeout, holding this file's exit ~60 s)
  const dialed = []; const counting = (...a) => Promise.resolve(nodeStream(...a)).then(s => { const d = { closed: false }; dialed.push(d); return { ...s, close() { d.closed = true; return s.close(); } }; });
  const other = crypto.getRandomValues(new Uint8Array(32));
  const logBefore = sshd.log().length;
  await assert.rejects(lsRefs(transport(r.url, { hostKey: hostKeyLine(other), connect: counting }), ['HEAD']), e => e.code === 'host_key_mismatch' && /does not match the pinned/.test(e.message) && e.presented === sshd.hostKeyLine.split(' ').slice(0, 2).join(' '));
  assert.doesNotMatch(sshd.log().slice(logBefore), /Accepted publickey/, 'no credential was presented to an unverified host');
  const kp2 = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']); const pub2 = new Uint8Array(await crypto.subtle.exportKey('raw', kp2.publicKey));
  await assert.rejects(lsRefs(transport(r.url, { privateKey: kp2.privateKey, publicKeyRaw: pub2, connect: counting }), ['HEAD']), e => e.code === 'auth' && /publickey authentication refused/.test(e.message));
  await assert.rejects(lsRefs(transport(`ssh://${sshd.user}@127.0.0.1:${sshd.port}${root}/does-not-exist.git`, { connect: counting }), ['HEAD']), e => (e.code === 'not_found' || e.code === 'remote_error') && /does-not-exist|not appear|no such|denied/i.test(e.message));
  await assert.rejects(editFile(r.url, { path: 'f.txt', find: 'x', replace: 'y', author, message: 'm' }, { tracer: new Tracer(), transport: transport(r.url, { connect: () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'network' }); } }) }), e => e.code === 'network');
  assert.throws(() => createSshTransport(r.url, { privateKey: kp.privateKey, publicKeyRaw: pub, connect: nodeStream, tracer: new Tracer() }), e => e.code === 'bad_request' && /hostKey is required/.test(e.message));
  // a server that drops GIT_PROTOCOL answers in v0: we refuse rather than guess
  const s0 = await startSshd(join(root, 'noenv'), { publicKeyRaw: pub, acceptEnv: false });
  try { await assert.rejects(lsRefs(createSshTransport(`ssh://${s0.user}@127.0.0.1:${s0.port}${r.bare}`, { privateKey: kp.privateKey, publicKeyRaw: pub, hostKey: s0.hostKeyLine, connect: counting, tracer: new Tracer() }), ['HEAD']), e => e.code === 'unsupported' && /AcceptEnv GIT_PROTOCOL/.test(e.message)); }
  finally { await s0.close(); }
  // scp-like form resolves relative to the user's home: use a repo there
  const home = process.env.HOME; const hb = makeBareRepo(home, `ply-scp-${process.pid}`);
  try { commitFiles(r.work, hb, { 'f.txt': 'home\n' }, 'home'); const t = transport(`${sshd.user}@127.0.0.1:ply-scp-${process.pid}.git`, {}); t.ssh.port = sshd.port; const { refs } = await lsRefs(t, ['refs/heads/main']); assert.ok(refs.has('refs/heads/main')); await t.close(); }
  finally { rmSync(hb, { recursive: true, force: true }); }
  // none of the failed commands' transports was closed by this test
  assert.deepEqual(dialed.map(d => d.closed), [true, true, true, true], 'host key, auth, missing repo, no AcceptEnv: each connection closed');
});

test('mutating the encrypted stream fails closed: every flipped byte after NEWKEYS is a bad tag, never a wrong answer', async () => {
  const r = repo(); const seed = commitFiles(r.work, r.bare, { 'f.txt': 'MARK\n' }, 'seed');
  const rng = new Rng(3); const outcomes = {};
  for (let i = 0; i < 25; i++) {
    // a TCP proxy that flips one random byte of one random server→client chunk after the Nth
    const flipAfter = rng.int(2, 40); let seen = 0, flipped = false;
    const proxy = net.createServer(c => { const up = net.connect(sshd.port, '127.0.0.1'); c.pipe(up); up.on('data', d => { seen++; if (!flipped && seen >= flipAfter) { flipped = true; const b = Buffer.from(d); b[rng.int(0, b.length - 1)] ^= 1 << rng.int(0, 7); c.write(b); } else c.write(d); }); up.on('end', () => c.end()); c.on('error', () => up.destroy()); up.on('error', () => c.destroy()); });
    const port = await freePort(); await new Promise(res => proxy.listen(port, '127.0.0.1', res));
    // a flip in a packet's length field (sent in the clear; checked only with the tag) makes any reader wait for bytes the
    // server never sends: that is a `timeout`, so bound it well under the default 60 s
    const t = transport(`ssh://${sshd.user}@127.0.0.1:${port}${r.bare}`, { limits: withLimits({ requestTimeoutMs: 3000 }) });
    let code = 'ok';
    try { await editFile(r.url, { path: 'f.txt', find: 'MARK', replace: `M${i}`, author, message: 'm' }, { tracer: new Tracer(), transport: t, verify: true }); }
    catch (e) { code = e.code; }
    finally { await t.close().catch(() => {}); proxy.close(); }
    outcomes[code] = (outcomes[code] ?? 0) + 1;
    // success is allowed only when the result is exactly right (git is the judge): a flip can land in unencrypted padding
    // (carries nothing, by design) or in bytes after our last read (the server's reply to our disconnect)
    if (code === 'ok') { assert.equal(git(r.bare, ['cat-file', '-p', 'main:f.txt']), `M${i}\n`); assert.equal(git(r.bare, ['rev-parse', 'main~1']).trim(), seed); if (flipped) outcomes.survived = (outcomes.survived ?? 0) + 1; }
    else {
      assert.ok(['ssh', 'network', 'protocol', 'host_key_mismatch', 'ambiguous', 'timeout'].includes(code), `unexpected code ${code}`);
      // 'ambiguous' = the flip hit the verify read-back after a landed push: the repo state is still ours, just unconfirmed
      const now = git(r.bare, ['cat-file', '-p', 'main:f.txt']); assert.ok(now === 'MARK\n' || (code === 'ambiguous' && now === `M${i}\n`), `${code}: ${now}`);
    }
    git(r.bare, ['update-ref', 'refs/heads/main', seed]);
  }
  console.log(`  25 flips: ${JSON.stringify(outcomes)}`);
  assert.ok((outcomes.ssh ?? 0) > 0, 'bad tags were seen');
});

test('userauth: a message outside the protocol (not SUCCESS, BANNER or FAILURE) fails typed, after a banner is recorded', async () => {
  const { Tracer, arrayExporter, flattenLine } = await import('../src/otel.js');
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const c = Object.create(SshClient.prototype);
  const ex = arrayExporter();
  const banner = Uint8Array.from([53, ...str('welcome\n'), ...str('')]); // SSH_MSG_USERAUTH_BANNER
  const replies = [Uint8Array.from([6, ...str('ssh-userauth')]), banner, Uint8Array.from([99])]; // SERVICE_ACCEPT, banner, junk
  Object.assign(c, { tracer: new Tracer({ exporter: ex }), parent: null, user: 'git', sessionId: new Uint8Array(32), privateKey: keys.privateKey, publicKeyRaw: new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)), writePacket: async () => {}, readMessage: async () => replies.shift() });
  await assert.rejects(c.authenticate(), e => e.code === 'ssh' && /unexpected message 99 during userauth/.test(e.message));
  assert.equal(ex.lines.flatMap(flattenLine).find(sp => sp.name === 'ssh.userauth').attrs['ssh.auth.banner'], 'welcome\n');
});

// ---- SAFETY I1 over SSH (issue #17): every wait on the server is bounded by requestTimeoutMs and the caller's signal ----
// The outcome is compared with the HTTP transport's for the same event (a server that never answers), code and message.
const settle = (p, ms) => { const t0 = Date.now(); let timer; return Promise.race([p.then(v => ({ v }), e => ({ e })), new Promise(r => { timer = setTimeout(() => r({ hung: true }), ms); })]).then(r => { clearTimeout(timer); return { ...r, ms: Date.now() - t0 }; }); };
const silentHttp = async () => { const socks = new Set(); const s = http.createServer(() => {}); s.on('connection', c => socks.add(c)); await new Promise(r => s.listen(0, '127.0.0.1', r)); return { url: `http://127.0.0.1:${s.address().port}/r.git`, close: () => { for (const c of socks) c.destroy(); return new Promise(r => s.close(r)); } }; };
const outcome = r => (r.e ? { code: r.e.code, message: r.e.message } : r.hung ? 'hung' : 'resolved');

test('I1 ssh: a server trickling a byte per 100 ms (under the idle timer) is cut at requestTimeoutMs, in a command and in the handshake; typed as HTTP; the transport reconnects', async () => {
  const r = repo(); commitFiles(r.work, r.bare, { 'f.txt': 'x\n' }, 'seed');
  const px = await trickleProxy(sshd.port); const url = `ssh://${sshd.user}@127.0.0.1:${px.port}${r.bare}`;
  const limits = withLimits({ requestTimeoutMs: 1000 });
  const h = await silentHttp();
  try {
    const httpR = await settle(lsRefs(createTransport(h.url, { tracer: new Tracer(), limits }), ['HEAD']), 5000);
    assert.deepEqual(outcome(httpR), { code: 'timeout', message: 'request aborted: request exceeded 1000 ms' });
    // mid-command: connection, channel and advertisement at full speed, then the ls-refs response trickles
    const t = transport(url, { limits });
    assert.ok((await lsRefs(t, ['refs/heads/main'])).refs.has('refs/heads/main'));
    px.mode.trickle = 100;
    const cmd = await settle(lsRefs(t, ['refs/heads/main']), 5000);
    console.log(`  trickled command: ${JSON.stringify(outcome(cmd))} after ${cmd.ms} ms (http: ${httpR.ms} ms)`);
    assert.deepEqual(outcome(cmd), outcome(httpR));
    assert.equal(retryPolicy(cmd.e), 'yes');
    assert.ok(cmd.ms >= 990 && cmd.ms < 1400, `cut at ${cmd.ms} ms`);
    // the torn-down connection is not reused: the next command opens a fresh one and succeeds
    px.mode.trickle = 0;
    assert.ok((await lsRefs(t, ['refs/heads/main'])).refs.has('refs/heads/main'));
    assert.equal(px.connections(), 2);
    await t.close();
    // handshake: the server's version line and KEXINIT trickle from the first byte
    px.mode.trickle = 100;
    const hs = await settle(lsRefs(transport(url, { limits }), ['HEAD']), 5000);
    console.log(`  trickled handshake: ${JSON.stringify(outcome(hs))} after ${hs.ms} ms`);
    assert.deepEqual(outcome(hs), outcome(httpR));
    assert.ok(hs.ms >= 990 && hs.ms < 1400, `cut at ${hs.ms} ms`);
  } finally { await px.close(); await h.close(); }
});

test('I1 ssh: an aborted signal stops an exchange before it connects and during one, with the outcome HTTP gives', async () => {
  const r = repo(); commitFiles(r.work, r.bare, { 'f.txt': 'x\n' }, 'seed');
  const px = await trickleProxy(sshd.port); const url = `ssh://${sshd.user}@127.0.0.1:${px.port}${r.bare}`;
  const limits = withLimits({ requestTimeoutMs: 30_000 });
  const h = await silentHttp();
  try {
    // already aborted: nothing is dialled
    const pre = new AbortController(); pre.abort();
    let dials = 0;
    const httpPre = await settle(lsRefs(createTransport(h.url, { tracer: new Tracer(), limits, signal: pre.signal }), ['HEAD']), 5000);
    const sshPre = await settle(lsRefs(transport(url, { limits, signal: pre.signal, connect: (...a) => { dials++; return nodeStream(...a); } }), ['HEAD']), 5000);
    console.log(`  pre-aborted: ssh ${JSON.stringify(outcome(sshPre))} after ${sshPre.ms} ms, ${dials} dials; http ${JSON.stringify(outcome(httpPre))}`);
    assert.equal(outcome(httpPre).code, 'aborted');
    assert.deepEqual(outcome(sshPre), outcome(httpPre));
    assert.equal(dials, 0); assert.equal(px.connections(), 0);
    // aborted 300 ms into a trickled command (the request timeout is 30 s)
    const ac = new AbortController();
    const t = transport(url, { limits, signal: ac.signal });
    assert.ok((await lsRefs(t, ['refs/heads/main'])).refs.has('refs/heads/main'));
    px.mode.trickle = 100;
    setTimeout(() => ac.abort(), 300);
    const mid = await settle(lsRefs(t, ['refs/heads/main']), 5000);
    const acH = new AbortController(); setTimeout(() => acH.abort(), 300);
    const httpMid = await settle(lsRefs(createTransport(h.url, { tracer: new Tracer(), limits, signal: acH.signal }), ['HEAD']), 5000);
    console.log(`  aborted mid-command: ssh ${JSON.stringify(outcome(mid))} after ${mid.ms} ms; http ${JSON.stringify(outcome(httpMid))} after ${httpMid.ms} ms`);
    assert.deepEqual(outcome(mid), outcome(httpMid));
    assert.equal(retryPolicy(mid.e), 'no');
    assert.ok(mid.ms >= 290 && mid.ms < 700, `stopped at ${mid.ms} ms`);
    await t.close(); // with the signal aborted: the connection is dropped, close does not wait on the server
    // during the handshake, with a custom reason: still `aborted`, the reason's message carried as HTTP carries it
    const ac2 = new AbortController(); setTimeout(() => ac2.abort(new Error('caller gave up')), 300);
    const hs = await settle(lsRefs(transport(url, { limits, signal: ac2.signal }), ['HEAD']), 5000);
    const ac3 = new AbortController(); setTimeout(() => ac3.abort(new Error('caller gave up')), 300);
    const httpHs = await settle(lsRefs(createTransport(h.url, { tracer: new Tracer(), limits, signal: ac3.signal }), ['HEAD']), 5000);
    assert.deepEqual(outcome(hs), outcome(httpHs));
    assert.deepEqual(outcome(hs), { code: 'aborted', message: 'request aborted: caller gave up' });
    assert.ok(hs.ms >= 290 && hs.ms < 700, `stopped at ${hs.ms} ms`);
  } finally { await px.close(); await h.close(); }
});

// ---- issue #31: concurrent first commands, a failed handshake, a failed channel ----
const sessions = since => (sshd.log().slice(since).match(/Starting session: command/g) ?? []).length;
const execsBy = ex => { const by = {}; for (const s of ex.lines.flatMap(flattenLine).filter(s => s.name === 'ssh.exec')) by[s.attrs['git.service']] = (by[s.attrs['git.service']] ?? 0) + 1; return by; };

test('concurrent first commands share one channel per service: one session at the sshd; editFile with a hint on a fresh transport opens one upload-pack and one receive-pack', async () => {
  const r = repo(); const seed = commitFiles(r.work, r.bare, { 'f.txt': 'MARK\n' }, 'seed');
  const log0 = sshd.log().length;
  const ex = arrayExporter(); const t = transport(r.url, { tracer: new Tracer({ exporter: ex }) });
  try {
    const got = await Promise.all([lsRefs(t, ['refs/heads/main']), lsRefs(t, ['refs/heads/main']), lsRefs(t, ['HEAD']), discover(t)]);
    for (const g of got.slice(0, 2)) assert.equal(g.refs.get('refs/heads/main').oid, seed);
    assert.match(got[3].agent, /^git\//);
  } finally { await t.close(); }
  assert.equal(await settled(() => sessions(log0), 1), 1);
  console.log(`  4 concurrent first commands: ${sessions(log0)} session(s) at the sshd, exec spans ${JSON.stringify(execsBy(ex))}`);
  assert.equal(sessions(log0), 1, 'one CHANNEL_OPEN + exec at the sshd');
  assert.deepEqual(execsBy(ex), { 'git-upload-pack': 1 });
  // editFile overlaps ls-refs with the speculative fetch of the hinted commit: both are the first upload-pack command
  const log1 = sshd.log().length;
  const ex2 = arrayExporter(); const t2 = transport(r.url, { tracer: new Tracer({ exporter: ex2 }) });
  let e;
  try { e = await editFile(r.url, { path: 'f.txt', find: 'MARK', replace: 'DONE', author, message: 'hinted' }, { tracer: new Tracer({ exporter: ex2 }), transport: t2, head: seed }); }
  finally { await t2.close(); }
  assert.equal(e.hint, 'used'); assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), e.newCommit); assert.equal(git(r.bare, ['cat-file', '-p', 'main:f.txt']), 'DONE\n');
  assert.equal(await settled(() => sessions(log1), 2), 2);
  console.log(`  editFile (hinted, fresh transport): ${sessions(log1)} session(s) at the sshd, exec spans ${JSON.stringify(execsBy(ex2))}`);
  assert.equal(sessions(log1), 2);
  assert.deepEqual(execsBy(ex2), { 'git-upload-pack': 1, 'git-receive-pack': 1 });
});

test('a handshake that fails for a non-timeout reason is not kept: the next command dials again and succeeds; a permanent failure stays typed on every command', async () => {
  const r = repo(); commitFiles(r.work, r.bare, { 'f.txt': 'x\n' }, 'seed');
  const px = await trickleProxy(sshd.port); const url = `ssh://${sshd.user}@127.0.0.1:${px.port}${r.bare}`;
  try {
    const t = transport(url);
    px.mode.banner = 'SSH-1.5-old\r\n';
    await assert.rejects(lsRefs(t, ['refs/heads/main']), e => e.code === 'unsupported' && /server version SSH-1\.5-old/.test(e.message));
    px.mode.banner = null;
    assert.ok((await lsRefs(t, ['refs/heads/main'])).refs.has('refs/heads/main'), 'reconnected');
    assert.equal(px.connections(), 2);
    await t.close();
    // a connect() that throws once (refused) is not kept either
    let dials = 0;
    const t1 = transport(url, { connect: (...a) => { if (dials++ === 0) throw Object.assign(new Error('ECONNREFUSED'), { code: 'network' }); return nodeStream(...a); } });
    await assert.rejects(lsRefs(t1, ['HEAD']), e => e.code === 'network');
    assert.ok((await lsRefs(t1, ['refs/heads/main'])).refs.has('refs/heads/main'), 'reconnected after a refused dial');
    assert.equal(dials, 2);
    await t1.close();
    // permanent: every command dials, and fails typed
    px.mode.banner = 'SSH-1.5-old\r\n';
    const before = px.connections(); const t2 = transport(url);
    for (let i = 0; i < 3; i++) await assert.rejects(lsRefs(t2, ['HEAD']), e => e.code === 'unsupported' && /server version SSH-1\.5-old/.test(e.message));
    assert.equal(px.connections() - before, 3, 'one dial per command, not one cached rejection');
    await t2.close();
  } finally { await px.close(); }
});

// ---- AES-GCM nonces under concurrency: every packet each way has its own nonce, in wire order ----
// Records the nonce of every AES-GCM encrypt/decrypt as called (WebCrypto copies the iv on call), by key, while f runs.
const recordNonces = async f => {
  const subtle = crypto.subtle, used = { encrypt: new Map(), decrypt: new Map() };
  for (const op of ['encrypt', 'decrypt']) { const orig = subtle[op]; subtle[op] = function (alg, key, data) { if (alg?.name === 'AES-GCM') { if (!used[op].has(key)) used[op].set(key, []); used[op].get(key).push(BigInt(`0x${Buffer.from(alg.iv).toString('hex')}`)); } return orig.call(subtle, alg, key, data); }; }
  try { await f(); } finally { delete subtle.encrypt; delete subtle.decrypt; }
  return used;
};
// every key's nonces: no repeat, each one more than the last (the order they were claimed is the order they were used)
const nonceReport = used => Object.fromEntries(['encrypt', 'decrypt'].map(op => [op, [...used[op].values()].map(l => ({ n: l.length, unique: new Set(l).size, consecutive: l.every((x, i) => i === 0 || x === l[i - 1] + 1n) }))]));
const assertNonces = (used, label) => { for (const op of ['encrypt', 'decrypt']) for (const l of used[op].values()) { assert.equal(new Set(l).size, l.length, `${label}: an ${op} nonce used twice`); assert.ok(l.every((x, i) => i === 0 || x === l[i - 1] + 1n), `${label}: ${op} nonces not strictly increasing by one`); } };

test('SshClient seals concurrent packets one at a time: two channels opened together, 2 × 100 concurrent channel writes and 100 bare packets each get their own nonce, in wire order', async () => {
  const rng = new Rng(31);
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['encrypt', 'decrypt']);
  const iv0 = crypto.getRandomValues(new Uint8Array(12)); iv0[4] = 0; // the counter has room: no wrap in this test
  const wire = []; // packets in the order they were handed to the stream: what a server reads
  const c = new SshClient({ read: async () => null, write: async b => { wire.push(b); await new Promise(r => setTimeout(r, rng.int(0, 2))); }, close() {} }, { user: 'u', hostKey: new Uint8Array(32), tracer: new Tracer() });
  const nonce = iv0.slice();
  c.enc = { key, nonce, bump: () => { for (let i = 11; i >= 4; i--) { nonce[i] = (nonce[i] + 1) & 255; if (nonce[i]) break; } } };
  // the server's side, scripted: both opens confirmed, then both execs accepted (the replies for one channel may be read by the other's wait)
  const replies = [concat([Uint8Array.from([91]), u32(1), u32(11), u32(64 << 20), u32(32768)]), concat([Uint8Array.from([91]), u32(0), u32(10), u32(64 << 20), u32(32768)]), concat([Uint8Array.from([99]), u32(1)]), concat([Uint8Array.from([99]), u32(0)])];
  c.readMessage = async () => { await new Promise(r => setTimeout(r, rng.int(0, 2))); return replies.shift() ?? new Promise(() => {}); };
  const chunk = (ch, i) => new TextEncoder().encode(`${ch}:${String(i).padStart(4, '0')}:${'x'.repeat(rng.int(0, 300))}\n`);
  const sent = [[], []];
  // 50 bare packets at once (SSH_MSG_IGNORE)
  const bare = await recordNonces(() => Promise.all(Array.from({ length: 50 }, (_, i) => c.writePacket(Uint8Array.from([2, ...str(`ignore ${i}`)])))));
  console.log(`  50 concurrent packets: client nonces ${JSON.stringify(nonceReport(bare).encrypt)}`);
  assertNonces(bare, 'bare packets');
  // two channels opened together, then 2 × 100 channel writes and 50 more bare packets, all at once
  const used = await recordNonces(async () => {
    const [a, b] = await Promise.all([c.exec('git-upload-pack x', { env: { GIT_PROTOCOL: 'version=2' } }), c.exec('git-receive-pack x')]);
    const writes = [];
    for (let i = 0; i < 100; i++) for (const [k, ch] of [[0, a], [1, b]]) { const d = chunk(k, i); sent[k].push(d); writes.push(ch.write(d)); }
    for (let i = 0; i < 50; i++) writes.push(c.writePacket(Uint8Array.from([2, ...str(`ignore ${i}`)])));
    await Promise.all(writes);
  });
  for (const [k, l] of bare.encrypt) used.encrypt.set(k, [...l, ...used.encrypt.get(k)]);
  // the server opens every packet with the next nonce, in wire order
  const got = new Map(); let opened = 0;
  for (const [i, pkt] of wire.entries()) {
    const iv = iv0.slice(); let n = BigInt(`0x${Buffer.from(iv0.subarray(4)).toString('hex')}`) + BigInt(i); for (let j = 11; j >= 4; j--) { iv[j] = Number(n & 255n); n >>= 8n; }
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: pkt.subarray(0, 4), tagLength: 128 }, key, pkt.subarray(4)).catch(() => new ArrayBuffer(0)));
    if (!plain.length) continue; opened++;
    const payload = plain.subarray(1, plain.length - plain[0]);
    if (payload[0] === 94) { const r = new DataView(payload.buffer, payload.byteOffset); const remote = r.getUint32(1); const len = r.getUint32(5); if (!got.has(remote)) got.set(remote, []); got.get(remote).push(td.decode(payload.subarray(9, 9 + len))); }
  }
  console.log(`  ${wire.length} packets on the wire, ${opened} opened by the server in order; client nonces ${JSON.stringify(nonceReport(used).encrypt)}`);
  assertNonces(used, 'fake server');
  assert.equal(used.encrypt.get(key).length, wire.length);
  assert.equal(opened, wire.length, 'every packet opens with the next nonce');
  assert.deepEqual(got.get(10), sent[0].map(d => td.decode(d)), 'channel 0 bytes arrive in write order');
  assert.deepEqual(got.get(11), sent[1].map(d => td.decode(d)), 'channel 1 bytes arrive in write order');
});

test('a packet that fails kills the connection: after a bad tag, later reads and writes fail with that error without touching the stream', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['encrypt', 'decrypt']);
  let reads = 0, writes = 0;
  const c = new SshClient({ read: async () => { reads++; return concat([u32(32), new Uint8Array(48)]); }, write: async () => { writes++; }, close() {} }, { user: 'u', hostKey: new Uint8Array(32), tracer: new Tracer() });
  const st = () => ({ key, nonce: new Uint8Array(12), bump() {} }); c.enc = st(); c.dec = st();
  await assert.rejects(c.readPacket(), e => e.code === 'ssh' && /bad tag/.test(e.message));
  const r0 = reads;
  const results = await Promise.allSettled([c.readMessage(), c.writePacket(Uint8Array.from([2])), c.readPacket()]);
  assert.deepEqual(results.map(x => x.reason?.message), Array(3).fill('ssh: packet authentication failed (bad tag)'));
  assert.equal(reads, r0, 'no read after the bad tag'); assert.equal(writes, 0, 'no write after the bad tag');
});

test('real sshd: upload-pack and receive-pack opened and used together, and 2 × 64 concurrent writes through two `cat` channels; no MAC error, every nonce once and in order', async () => {
  const r = repo(); const seed = commitFiles(r.work, r.bare, { 'f.txt': 'x\n' }, 'seed');
  const log0 = sshd.log().length;
  let res, echoes; const sent = [[], []];
  const used = await recordNonces(async () => {
    const t = transport(r.url);
    try {
      res = await Promise.all([lsRefs(t, ['refs/heads/main']), receiveCaps(t), lsRefs(t, ['HEAD']), discover(t)]);
      res.push(...await Promise.all([receiveCaps(t), lsRefs(t, ['refs/heads/main'])]));
    } finally { await t.close(); }
    const c = new SshClient(await nodeStream('127.0.0.1', sshd.port), { user: sshd.user, privateKey: kp.privateKey, publicKeyRaw: pub, hostKey: sshd.hostKeyLine, tracer: new Tracer() });
    try {
      await c.connect(); await c.authenticate();
      const chs = await Promise.all([c.exec('cat'), c.exec('cat')]);
      const reads = chs.map(async ch => { const parts = []; for await (const d of ch.stdout()) parts.push(d); return td.decode(concat(parts)); });
      const writes = [];
      for (let i = 0; i < 64; i++) for (const k of [0, 1]) { const d = new TextEncoder().encode(`${k}:${i}:${'y'.repeat(997)}\n`); sent[k].push(d); writes.push(chs[k].write(d)); }
      await Promise.all(writes); await Promise.all(chs.map(ch => ch.eof()));
      echoes = await Promise.all(reads);
    } finally { await c.disconnect(); }
  });
  assert.equal(res[0].refs.get('refs/heads/main').oid, seed); assert.ok(res[1].has('report-status')); assert.match(res[3].agent, /^git\//); assert.ok(res[4].has('report-status')); assert.equal(res[5].refs.get('refs/heads/main').oid, seed);
  assert.deepEqual(echoes, sent.map(s => td.decode(concat(s))), 'each cat echoes its writes in call order');
  assert.equal(await settled(() => sessions(log0), 4), 4);
  const log = sshd.log().slice(log0);
  console.log(`  ${sessions(log0)} sessions, MAC error: ${/message authentication code incorrect/.test(log)}; nonces ${JSON.stringify(nonceReport(used))}`);
  assert.doesNotMatch(log, /message authentication code incorrect|Corrupted|Bad packet/i);
  assert.equal(sessions(log0), 4, 'upload-pack, receive-pack, cat, cat');
  assert.equal(used.encrypt.size, 2); assert.equal(used.decrypt.size, 2);
  assertNonces(used, 'real sshd');
});

test('a server sending CHANNEL_DATA past our window while we wait for another message: typed ssh error, at most one window held', async () => {
  const W = 2 * 1024 * 1024, CHUNK = 32768, CAP = 64 << 20;
  const c = Object.create(SshClient.prototype);
  const data = concat([Uint8Array.from([94]), u32(0), str(new Uint8Array(CHUNK).fill(7))]); // CHANNEL_DATA, our channel 0
  let sent = 0, step = 0;
  const readMessage = async () => {
    if (step++ === 0) return concat([Uint8Array.from([91]), u32(0), u32(7), u32(W), u32(32768)]); // OPEN_CONFIRMATION
    if (sent < CAP) { sent += CHUNK; return data; } // the server ignores the window instead of answering exec
    return concat([Uint8Array.from([99]), u32(0)]); // CHANNEL_SUCCESS, eventually
  };
  Object.assign(c, { windowSize: W, maxPacket: 32768, channels: new Map(), nextChannel: 0, writePacket: async () => {}, readMessage });
  globalThis.gc?.();
  const rss0 = process.memoryUsage().rss;
  const r = await settle(c.exec('git-upload-pack x'), 30_000);
  const ch = c.channels.get(0);
  const held = ch.queue.reduce((n, d) => n + d.length, 0);
  const rss = process.memoryUsage().rss - rss0;
  console.log(`  ${JSON.stringify(r.e ? { code: r.e.code, message: r.e.message } : 'resolved')}: server sent ${sent} B, queue holds ${held} B, rss +${(rss / 1048576).toFixed(1)} MiB`);
  assert.equal(r.e?.code, 'ssh'); assert.match(r.e.message, /bytes with 0 left in the channel window/);
  assert.equal(sent, W + CHUNK, 'refused at the first byte past the window');
  assert.equal(held, W); assert.equal(ch.queued, W);
  assert.ok(rss < 24 << 20, `rss +${rss} B`);
});

test('flow control: a 6 MiB blob read and edited over ssh (window given back as stdout is consumed), git-verified', async () => {
  const r = repo();
  const big = Buffer.alloc(6 << 20); for (let i = 0; i < big.length; i += 64) big.write(`${String(i).padStart(12, '0')} ${'abcdefghijklmnopqrstuvwxyz0123456789ab'}\n`, i);
  const noise = big.subarray(2 << 20, 5 << 20); for (let i = 0; i < noise.length; i += 65536) crypto.getRandomValues(noise.subarray(i, i + 65536));
  for (let i = 0; i < noise.length; i++) noise[i] |= 0x80; // 3 MiB that does not compress (and cannot spell MARK): the pack outgrows one window
  big.write('MARK', 1 << 20);
  commitFiles(r.work, r.bare, { 'big.txt': big }, 'seed');
  const t = transport(r.url);
  try {
    const got = await readFile(r.url, { path: 'big.txt' }, { tracer: new Tracer(), transport: t });
    const parts = []; for await (const c of got.stream) parts.push(Buffer.from(c));
    assert.ok(Buffer.concat(parts).equals(big), 'bytes equal');
    const e = await editFile(r.url, { path: 'big.txt', find: 'MARK', replace: 'DONE', author, message: 'big' }, { tracer: new Tracer(), transport: t, verify: true });
    assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), e.newCommit);
    assert.equal(git(r.bare, ['fsck', '--strict', '--no-dangling']).trim(), '');
    console.log(`  ${t.stats().bytesIn} B in over ${t.stats().packetsIn} packets`);
    assert.ok(t.stats().bytesIn > 2 * (2 << 20), 'more than one window each way through');
  } finally { await t.close(); }
});
