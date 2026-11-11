// A Result-returning API never throws or rejects when a caller-supplied operation callback does (README "never a
// throw"). Each row makes one callback throw or reject and asserts the promise resolves to a Result whose outcome class
// is the one the protocol dictates, judged by real git on the bare repository:
//   - definite (any code but 'ambiguous'): the callback failed before a receive-pack request existed, so the ref cannot
//     have moved, and git rev-parse says it did not.
//   - 'ambiguous': the callback failed after the receive-pack request was handed to the transport. In the end-to-end
//     row the transport really delivers the push and then throws, and git says the ref DID move: 'ambiguous' (retry:
//     read) is the only honest class there; a definite failure would be a lie.
// Expected codes are the contract, hand-derived, not ply's output: bad_request (retry 'no') names the caller's failing
// callback in `what` and carries the thrown value as `cause`.
import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { editFile, commitChanges, readCommit, createTransport, Tracer } from '../src/index.js';
import { filesFromDir, pushDir } from '../src/tree-node.js';
import { operation } from '../src/operation.js';
import { tmpRoot, makeBareRepo, git, commitFiles, startGitServer } from './server.js';

let server; let bare; let url; let cleanup; let root;
const author = { name: 'T', email: 't@example.com' };
const head = () => git(bare, ['rev-parse', 'refs/heads/main']).trim();
beforeAll(async () => {
  const tmp = tmpRoot(); cleanup = tmp.cleanup; root = tmp.root;
  bare = makeBareRepo(tmp.root, 'r');
  const work = join(tmp.root, 'work'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  commitFiles(work, bare, { 'a.txt': 'one\n' });
  server = await startGitServer(tmp.root);
  url = `${server.url}/r.git`;
});
afterAll(async () => { await server.close(); cleanup(); });

// what the callback throws: a fresh value per row (ply may tag a transport's thrown error with a code in place)
let boom = new Error('boom');
const edit = (opts, n) => editFile(url, { ref: 'refs/heads/main', path: 'a.txt', find: 'one', replace: `two-${n}`, author, message: 'm' }, opts);
// a write that does not depend on what earlier rows left in the repository
const write = (opts, n) => commitChanges(url, { ref: 'refs/heads/main', changes: [{ kind: 'write', path: `f-${n}.txt`, content: `row ${n}\n` }], author, message: 'm' }, opts);
// a caller's transport: the real one with one method replaced
const transportWith = replace => { const made = createTransport(url, { tracer: new Tracer() }); assert.equal(made.ok, true); return { ...made.value, ...replace(made.value) }; };
const dir = () => { const d = mkdtempSync(join(root, 'd-')); writeFileSync(join(d, 'f'), 'x'); return d; };

// [label, run, expected code (null: any definite code; 'ok': the callback is not on this path), expected `what` (null: not asserted), class]
const rows = [
  ['signer.sign rejects (editFile)', n => edit({ signer: { sign: async () => { await null; throw boom; }, publicKey: 'x' } }, n), 'bad_request', 'signer', 'definite'],
  ['signer.sign throws synchronously (commitChanges)', n => write({ signer: { sign: () => { throw boom; }, publicKey: 'x' } }, n), 'bad_request', 'signer', 'definite'],
  ['pushDir filter throws', () => pushDir(url, { dir: dir(), ref: 'refs/heads/main', author, message: 'm', filter: () => { throw boom; } }, {}), 'bad_request', 'filter', 'definite'],
  ['caller transport: frames throws on upload-pack', n => write({ transport: transportWith(() => ({ frames: () => { throw boom; } })) }, n), null, null, 'definite'],
  ['caller transport: frames throws after delivering the push', n => write({ transport: transportWith(real => ({
    // the real request is made and fully read (the push lands), then the caller's code throws
    frames: (service, body, span, hints) => service !== 'git-receive-pack' ? real.frames(service, body, span, hints) : (async function* () { const all = []; for await (const f of real.frames(service, body, span, hints)) all.push(f); throw boom; })(),
  })) }, n), 'ambiguous', null, 'landed'],
  // advertise is consulted only to confirm a refused push; a healthy push never calls it, so its failure changes nothing
  ['caller transport: advertise rejects', n => write({ transport: transportWith(() => ({ advertise: async () => { await null; throw boom; } })) }, n), 'ok', null, 'ok'],
  ['fetchImpl throws synchronously (read)', () => readCommit(url, { ref: 'main' }, { fetchImpl: () => { throw boom; } }), null, null, 'definite'],
  ['fetchImpl rejects (write)', n => write({ fetchImpl: async () => { await null; throw boom; } }, n), null, null, 'definite'],
  // operation()'s own edge, for any callback not wrapped where it is called: the body stands in for one
  ['operation(): a foreign throw before any request', () => operation('probe', url, {}, async () => { await null; throw boom; }), 'bad_request', 'callback', 'definite'],
  ['operation(): a foreign throw after an upload-pack request only', () => operation('probe', url, {}, async ({ t, root: span }) => { await null; t.frames('git-upload-pack', new Uint8Array(0), span, {}); throw boom; }), 'bad_request', 'callback', 'definite'],
  // hand-derived: the body gave a receive-pack request to the transport, so ply cannot say the ref did not move
  ['operation(): a foreign throw after the push request was handed to the transport', () => operation('probe', url, {}, async ({ t, root: span }) => { await null; t.frames('git-receive-pack', new Uint8Array(0), span, {}); throw boom; }), 'ambiguous', 'callback', 'handed-over'],
];

rows.forEach(([label, run, code, what, cls], n) => {
  test(`${label}: ${code === 'ok' ? 'unaffected' : `a coded Err (${code === null ? 'definite' : code})`}, never a throw`, async () => {
    const before = head();
    boom = new Error(`boom ${n}`);
    let r;
    try { r = await run(n); } catch (e) { assert.fail(`the Result API threw/rejected: ${String(e)}`); }
    if (cls === 'ok') { assert.equal(r.ok, true); assert.equal(head(), r.value.oid, 'git: the ref is at the commit reported'); return; }
    assert.equal(r.ok, false, 'a failing callback cannot be ok');
    if (code === null) assert.notEqual(r.error.code, 'ambiguous', 'nothing was pushed: a definite failure'); else assert.equal(r.error.code, code);
    if (what !== null) {
      assert.equal(r.error.what, what, 'the Err names the callback');
      assert.equal(r.error.cause, boom, 'the Err carries the very value the callback threw as its cause');
    }
    if (cls === 'landed') assert.notEqual(head(), before, 'this row delivers the push before throwing: git says the ref moved, so only ambiguous is honest');
    else assert.equal(head(), before, 'git says the ref did not move');
  });
});

// The file system's own failures are not throws either (README: never a throw). The expected `cause.code` is node:fs's
// errno name for the condition set up here (a path that does not exist: ENOENT; a file with no read permission:
// EACCES), not anything ply computes. Definite: the walk precedes any request, and the bare repository's ref is unmoved.
const fsRows = [
  ['a missing directory', () => join(root, 'no-such-dir'), 'ENOENT'],
  ['an unreadable file', () => { const d = dir(); chmodSync(join(d, 'f'), 0o000); return d; }, 'EACCES'],
];
for (const [label, makeDir, errno] of fsRows) {
  test(`pushDir and filesFromDir on ${label}: a coded Err (bad_request, what 'dir') carrying node:fs's ${errno}, never a throw`, async ctx => {
    // root reads any file: the unreadable row cannot be set up there
    if (errno === 'EACCES' && process.getuid?.() === 0) { ctx.skip(); return; }
    const before = head();
    const d = makeDir();
    for (const run of [() => pushDir(url, { dir: d, ref: 'refs/heads/main', author, message: 'm' }, {}), () => filesFromDir(d)]) {
      let r;
      try { r = await run(); } catch (e) { assert.fail(`the Result API threw/rejected: ${String(e)}`); }
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'bad_request');
      assert.equal(r.error.what, 'dir', 'the Err names the directory walk');
      assert.equal(r.error.cause.code, errno, "the cause is node:fs's own error");
    }
    assert.equal(head(), before, 'the ref did not move');
  });
}
