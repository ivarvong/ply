// Signed commits: our SSH/Ed25519 signature must verify with git (which shells out to ssh-keygen -Y verify) and with
// ssh-keygen directly over the exact bytes git signs; a tampered commit must not verify; fsck must stay clean.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { git, tmpRoot, makeBareRepo, startGitServer, commitFiles, fsckProblems } from './server.js';
import { editFile, buildCommitObjects, withCommitData } from '../src/edit.js';
import { generateSigner, signCommit, withGpgsig, armor } from '../src/sign.js';
import { encodeCommit, hashObject, parseCommit } from '../src/objects.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { defaultCapabilities } from '../src/capabilities.js';

let root, cleanup, srv, bare, work, url, signers;
const author = { name: 'signer', email: 'signer@x' };
before(async () => {
  ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root);
  bare = makeBareRepo(root, 'sg'); work = join(root, 'wsg'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  commitFiles(work, bare, { 'f.txt': 'hello MARK\n' }, 'seed');
  url = `${srv.url}/sg.git`;
  signers = join(root, 'allowed_signers');
});
after(async () => { await srv.close(); cleanup(); });

// the real ssh-keygen: some environments point gpg.ssh.program at a signing-only shim
const G = () => ['-C', bare, '-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen', '-c', `gpg.ssh.allowedSignersFile=${signers}`];
const verifyCommit = oid => { const r = spawnSync('git', [...G(), 'verify-commit', '--raw', oid], { encoding: 'utf8' }); return { ok: r.status === 0, out: r.stdout + r.stderr }; }; // git prints the verdict on stderr

test('editFile with a signer: git verify-commit accepts the commit; ssh-keygen verifies the raw signature; tampering is caught', async () => {
  const { signer, publicKeyRaw } = await generateSigner();
  writeFileSync(signers, `${author.email} namespaces="git" ${signer.publicKeyLine}\n`);
  const ex = arrayExporter();
  const r = await editFile(url, { path: 'f.txt', find: 'MARK', replace: 'SIGNED', author, message: 'signed edit' }, { capabilities: { ...defaultCapabilities(), tracer: new Tracer({ exporter: ex }) }, signer });
  assert.equal(git(bare, ['rev-parse', 'main']).trim(), r.newCommit);
  const rootSpan = ex.lines.flatMap(flattenLine).find(s => s.name === 'git.edit');
  assert.equal(rootSpan.attrs['git.edit.commit.signed'], 'ssh-ed25519'); assert.equal(rootSpan.attrs['git.edit.commit.signer'], signer.publicKeyLine);
  // 1. git's verdict
  const v = verifyCommit(r.newCommit);
  assert.ok(v.ok, v.out); assert.match(v.out, /GOODSIG|Good "git" signature/);
  assert.equal(execFileSync('git', [...G(), 'log', '-1', '--format=%G?', r.newCommit], { encoding: 'utf8' }).trim(), 'G', '%G? = G (good)');
  // 2. header layout: gpgsig right after committer, continuation lines space-prefixed, body intact
  const raw = execFileSync('git', ['-C', bare, 'cat-file', 'commit', r.newCommit], { encoding: 'utf8' });
  const headers = raw.slice(0, raw.indexOf('\n\n')).split('\n');
  const ci = headers.findIndex(l => l.startsWith('committer ')); assert.ok(headers[ci + 1].startsWith('gpgsig -----BEGIN SSH SIGNATURE-----'));
  assert.ok(headers.slice(ci + 2).every(l => l.startsWith(' ')), 'continuation lines');
  assert.equal(parseCommit(new TextEncoder().encode(raw)).message, 'signed edit\n');
  // 3. ssh-keygen over the exact payload git signs (the commit without its gpgsig header)
  const payload = raw.split('\n').filter((l, i, a) => !(l.startsWith('gpgsig ') || (i > ci + 1 && l.startsWith(' ') && a.slice(ci + 1, i).every(x => x.startsWith('gpgsig ') || x.startsWith(' '))))).join('\n');
  const sigText = headers.slice(ci + 1).map(l => l.replace(/^gpgsig /, '').replace(/^ /, '')).join('\n') + '\n';
  const sigFile = join(root, 'c.sig'); writeFileSync(sigFile, sigText);
  const sk = execFileSync('ssh-keygen', ['-Y', 'verify', '-f', signers, '-I', author.email, '-n', 'git', '-s', sigFile], { input: payload, encoding: 'utf8' });
  assert.match(sk, /Good "git" signature/);
  // 4. tamper: same signature over a different message must fail
  const bad = withGpgsig(encodeCommit({ ...parseCommit(new TextEncoder().encode(payload)), author: parseCommit(new TextEncoder().encode(payload)).author, committer: parseCommit(new TextEncoder().encode(payload)).committer, message: 'tampered\n' }), sigText);
  const badOid = execFileSync('git', ['-C', bare, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input: bad, encoding: 'utf8' }).trim();
  const tampered = verifyCommit(badOid);
  assert.equal(tampered.ok, false); assert.match(tampered.out, /incorrect signature/, 'rejected for the signature, not for some other reason');
  // 5. fsck is clean with the signed commit in history
  assert.deepEqual(fsckProblems(bare), []);
  assert.equal(git(bare, ['cat-file', '-p', 'main:f.txt']), 'hello SIGNED\n');
});

test('withCommitData keeps trees/blob objects and recomputes identity; armor wraps at 70 like ssh-keygen', async () => {
  const commit = encodeCommit({ tree: 'a'.repeat(40), parents: [], author: 'n <e@x> 1 +0000', committer: 'n <e@x> 1 +0000', message: 'm\n' });
  const built = { commitData: commit, newCommit: hashObject('commit', commit), objects: [{ type: 1, data: commit }, { type: 2, data: new Uint8Array(5), baseOid: 'b'.repeat(40) }], trees: [], newTree: 'a'.repeat(40) };
  const { signer } = await generateSigner();
  const signed = await signCommit(commit, signer);
  const w = withCommitData(built, signed);
  assert.equal(w.newCommit, hashObject('commit', signed)); assert.notEqual(w.newCommit, built.newCommit);
  assert.equal(w.objects.length, 2); assert.equal(w.objects[1], built.objects[1]);
  const text = new TextDecoder().decode(signed);
  assert.ok(text.includes('\ncommitter n <e@x> 1 +0000\ngpgsig -----BEGIN SSH SIGNATURE-----\n '));
  const a = armor(new Uint8Array(200)); for (const l of a.split('\n').slice(1, -2)) assert.ok(l.length <= 70);
  assert.throws(() => withGpgsig(new TextEncoder().encode('tree x\n\nm'), 'sig'), e => e.code === 'bad_request');
});
