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
import { unwrap, unwrapAsync } from './unwrap.js';

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
  const r = await unwrapAsync(editFile(url, { path: 'f.txt', find: 'MARK', replace: 'SIGNED', author, message: 'signed edit' }, { tracer: new Tracer({ exporter: ex }), signer }));
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
  assert.equal(unwrap(parseCommit(new TextEncoder().encode(raw))).message, 'signed edit\n');
  // 3. ssh-keygen over the exact payload git signs (the commit without its gpgsig header)
  const payload = raw.split('\n').filter((l, i, a) => !(l.startsWith('gpgsig ') || (i > ci + 1 && l.startsWith(' ') && a.slice(ci + 1, i).every(x => x.startsWith('gpgsig ') || x.startsWith(' '))))).join('\n');
  const sigText = headers.slice(ci + 1).map(l => l.replace(/^gpgsig /, '').replace(/^ /, '')).join('\n') + '\n';
  const sigFile = join(root, 'c.sig'); writeFileSync(sigFile, sigText);
  const sk = execFileSync('ssh-keygen', ['-Y', 'verify', '-f', signers, '-I', author.email, '-n', 'git', '-s', sigFile], { input: payload, encoding: 'utf8' });
  assert.match(sk, /Good "git" signature/);
  // 4. tamper: same signature over a different message must fail
  const bad = unwrap(withGpgsig(unwrap(encodeCommit({ ...unwrap(parseCommit(new TextEncoder().encode(payload))), author: unwrap(parseCommit(new TextEncoder().encode(payload))).author, committer: unwrap(parseCommit(new TextEncoder().encode(payload))).committer, message: 'tampered\n' })), sigText));
  const badOid = execFileSync('git', ['-C', bare, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input: bad, encoding: 'utf8' }).trim();
  const tampered = verifyCommit(badOid);
  assert.equal(tampered.ok, false); assert.match(tampered.out, /incorrect signature/, 'rejected for the signature, not for some other reason');
  // 5. fsck is clean with the signed commit in history
  assert.deepEqual(fsckProblems(bare), []);
  assert.equal(git(bare, ['cat-file', '-p', 'main:f.txt']), 'hello SIGNED\n');
});

test('withCommitData keeps trees/blob objects and recomputes identity; armor wraps at 70 like ssh-keygen', async () => {
  const commit = unwrap(encodeCommit({ tree: 'a'.repeat(40), parents: [], author: 'n <e@x> 1 +0000', committer: 'n <e@x> 1 +0000', message: 'm\n' }));
  const built = { commitData: commit, newCommit: hashObject('commit', commit), objects: [{ type: 1, data: commit }, { type: 2, data: new Uint8Array(5), base: { tag: 'ref', oid: 'b'.repeat(40) } }], trees: [], newTree: 'a'.repeat(40) };
  const { signer } = await generateSigner();
  const signed = await unwrapAsync(signCommit(commit, signer));
  const w = withCommitData(built, signed);
  assert.equal(w.newCommit, hashObject('commit', signed)); assert.notEqual(w.newCommit, built.newCommit);
  assert.equal(w.objects.length, 2); assert.equal(w.objects[1], built.objects[1]);
  const text = new TextDecoder().decode(signed);
  assert.ok(text.includes('\ncommitter n <e@x> 1 +0000\ngpgsig -----BEGIN SSH SIGNATURE-----\n '));
  const a = armor(new Uint8Array(200)); for (const l of a.split('\n').slice(1, -2)) assert.ok(l.length <= 70);
  assert.throws(() => unwrap(withGpgsig(new TextEncoder().encode('tree x\n\nm'), 'sig')), e => e.code === 'bad_request');
});

// objects/signcommit-null-message-bad-signature: a commit with no body section (encodeCommit's default, message null)
// ends after its last header line. What is signed is that commit, so the signed object with its gpgsig header taken
// out again must be those bytes exactly, and git's own verdict on the signature (verify-commit) is the judge.
test('signCommit on a commit with no body section: git verify-commit accepts it and the payload is the unsigned commit', async () => {
  const { signer } = await generateSigner();
  writeFileSync(signers, `${author.email} namespaces="git" ${signer.publicKeyLine}\n`);
  const tree = git(bare, ['rev-parse', 'main^{tree}']).trim();
  const who = `${author.name} <${author.email}> 1700000000 +0000`;
  for (const [what, more] of [['no body section', {}], ['no body section, with an encoding', { encoding: 'ISO-8859-1' }], ['no body section, with an extra header', { extra: ['x-note 1'] }]]) {
    const unsigned = unwrap(encodeCommit({ tree, author: who, ...more }));
    const text = new TextDecoder().decode(unsigned);
    assert.ok(text.endsWith('\n') && !text.includes('\n\n'), `${what}: the unsigned commit has no blank line`);
    const signed = unwrap(await signCommit(unsigned, signer));
    // the payload git verifies: the object without the gpgsig header and its continuation lines (taken out by hand)
    const lines = new TextDecoder().decode(signed).split('\n');
    const at = lines.findIndex(l => l.startsWith('gpgsig '));
    let end = at + 1;
    while (lines[end].startsWith(' ')) end++;
    lines.splice(at, end - at);
    assert.equal(lines.join('\n'), text, `${what}: the signed commit without its gpgsig header is the commit that was signed`);
    const oid = execFileSync('git', ['-C', bare, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input: signed, encoding: 'utf8' }).trim();
    const v = verifyCommit(oid);
    assert.ok(v.ok, `${what}: git verify-commit: ${v.out}`);
    assert.match(v.out, /GOODSIG|Good "git" signature/);
    // still no body section, as the unsigned commit had none
    assert.equal(unwrap(parseCommit(signed)).message, null, what);
  }
});
