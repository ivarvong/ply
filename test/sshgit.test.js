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
import { git, tmpRoot, makeBareRepo, commitFiles } from './server.js';
import { startSshd, freePort } from './sshd.js';
import { Rng } from './fuzz/prng.js';
import { createSshTransport, parseSshUrl, sshRedact } from '../src/sshgit.js';
import { nodeStream } from '../src/ssh-node.js';
import { SshClient, hostKeyLine, hostKeyFromLine, padded, mpint, str, parseKexInit, kexInit, fingerprint } from '../src/ssh.js';
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

test('failures are typed: host key mismatch (before auth), unauthorized key, no AcceptEnv, missing repo, scp-like url', async () => {
  const r = repo(); commitFiles(r.work, r.bare, { 'f.txt': 'x\n' }, 'seed');
  const other = crypto.getRandomValues(new Uint8Array(32));
  const logBefore = sshd.log().length;
  await assert.rejects(lsRefs(transport(r.url, { hostKey: hostKeyLine(other) }), ['HEAD']), e => e.code === 'host_key_mismatch' && /does not match the pinned/.test(e.message) && e.presented === sshd.hostKeyLine.split(' ').slice(0, 2).join(' '));
  assert.doesNotMatch(sshd.log().slice(logBefore), /Accepted publickey/, 'no credential was presented to an unverified host');
  const kp2 = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']); const pub2 = new Uint8Array(await crypto.subtle.exportKey('raw', kp2.publicKey));
  await assert.rejects(lsRefs(transport(r.url, { privateKey: kp2.privateKey, publicKeyRaw: pub2 }), ['HEAD']), e => e.code === 'auth' && /publickey authentication refused/.test(e.message));
  await assert.rejects(lsRefs(transport(`ssh://${sshd.user}@127.0.0.1:${sshd.port}${root}/does-not-exist.git`), ['HEAD']), e => (e.code === 'not_found' || e.code === 'remote_error') && /does-not-exist|not appear|no such|denied/i.test(e.message));
  await assert.rejects(editFile(r.url, { path: 'f.txt', find: 'x', replace: 'y', author, message: 'm' }, { tracer: new Tracer(), transport: transport(r.url, { connect: () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'network' }); } }) }), e => e.code === 'network');
  assert.throws(() => createSshTransport(r.url, { privateKey: kp.privateKey, publicKeyRaw: pub, connect: nodeStream, tracer: new Tracer() }), e => e.code === 'bad_request' && /hostKey is required/.test(e.message));
  // a server that drops GIT_PROTOCOL answers in v0: we refuse rather than guess
  const s0 = await startSshd(join(root, 'noenv'), { publicKeyRaw: pub, acceptEnv: false });
  try { await assert.rejects(lsRefs(createSshTransport(`ssh://${s0.user}@127.0.0.1:${s0.port}${r.bare}`, { privateKey: kp.privateKey, publicKeyRaw: pub, hostKey: s0.hostKeyLine, connect: nodeStream, tracer: new Tracer() }), ['HEAD']), e => e.code === 'unsupported' && /AcceptEnv GIT_PROTOCOL/.test(e.message)); }
  finally { await s0.close(); }
  // scp-like form resolves relative to the user's home: use a repo there
  const home = process.env.HOME; const hb = makeBareRepo(home, `ply-scp-${process.pid}`);
  try { commitFiles(r.work, hb, { 'f.txt': 'home\n' }, 'home'); const t = transport(`${sshd.user}@127.0.0.1:ply-scp-${process.pid}.git`, {}); t.ssh.port = sshd.port; const { refs } = await lsRefs(t, ['refs/heads/main']); assert.ok(refs.has('refs/heads/main')); await t.close(); }
  finally { rmSync(hb, { recursive: true, force: true }); }
});

test('mutating the encrypted stream fails closed: every flipped byte after NEWKEYS is a bad tag, never a wrong answer', async () => {
  const r = repo(); const seed = commitFiles(r.work, r.bare, { 'f.txt': 'MARK\n' }, 'seed');
  const rng = new Rng(3); const outcomes = {};
  for (let i = 0; i < 25; i++) {
    // a TCP proxy that flips one random byte of one random server→client chunk after the Nth
    const flipAfter = rng.int(2, 40); let seen = 0, flipped = false;
    const proxy = net.createServer(c => { const up = net.connect(sshd.port, '127.0.0.1'); c.pipe(up); up.on('data', d => { seen++; if (!flipped && seen >= flipAfter) { flipped = true; const b = Buffer.from(d); b[rng.int(0, b.length - 1)] ^= 1 << rng.int(0, 7); c.write(b); } else c.write(d); }); up.on('end', () => c.end()); c.on('error', () => up.destroy()); up.on('error', () => c.destroy()); });
    const port = await freePort(); await new Promise(res => proxy.listen(port, '127.0.0.1', res));
    const t = transport(`ssh://${sshd.user}@127.0.0.1:${port}${r.bare}`);
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
