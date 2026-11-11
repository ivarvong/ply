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
import { editFile, commitChanges, readCommit, checkoutTree, createTransport, Tracer } from '../src/index.js';
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

// operation() hands the body a view of the caller's transport (it records the push hand-over), and ply hands each
// sub-exchange a further view (withParent(t, span)). A caller's frames() runs as a method of the view it was called on,
// so `this.parent` is that exchange's span. Expected names are the spans a checkout opens, by the README's span table
// and as on main: the root git.checkout (the tree listing) and git.checkout.blobs (the blob fetch).
test("a caller transport's frames() is called on the exchange's view: this.parent is that exchange's span", async () => {
  const made = createTransport(url, { tracer: new Tracer() }); assert.equal(made.ok, true);
  const real = made.value; const parents = new Set();
  const transport = { ...real, frames(service, body, span, hints) { parents.add(this.parent.name); return real.frames(service, body, span, hints); } };
  const r = await checkoutTree(url, { ref: 'main' }, { transport });
  assert.equal(r.ok, true);
  for await (const f of r.value.files) void f;
  assert.deepEqual([...parents].sort(), ['git.checkout', 'git.checkout.blobs']);
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

// Describing a thrown value never throws, whatever the value. Each value below has no string form, or cannot be read
// at all. The oracle is the language, not ply: reading `.message` or calling String() on each one throws (asserted per
// row, so a row is never vacuous), and the contract above still holds: a coded Err that names the callback, carries
// the very value as `cause` and has a string message, with the ref where git says it was.
const hostile = {
  'a null-prototype object': () => Object.create(null),
  'an object whose message getter throws': () => ({ get message() { throw new Error('getter'); } }),
  'an object whose toString throws': () => ({ toString() { throw new Error('toString'); } }),
  'a revoked Proxy': () => { const p = Proxy.revocable({}, {}); p.revoke(); return p.proxy; },
};
// [where the value is thrown, run(value, n), expected code, expected `what`]: hand-derived as in the rows above
const sites = [
  ['operation() before any request', v => operation('probe', url, {}, async () => { await null; throw v; }), 'bad_request', 'callback'],
  ['operation() after the push request was handed to the transport', v => operation('probe', url, {}, async ({ t, root: span }) => { await null; t.frames('git-receive-pack', new Uint8Array(0), span, {}); throw v; }), 'ambiguous', 'callback'],
  ['signer.sign (editFile)', (v, n) => edit({ signer: { sign: () => { throw v; }, publicKey: 'x' } }, `hostile-${n}`), 'bad_request', 'signer'],
  ['the filesFromDir filter', v => filesFromDir(dir(), { filter: () => { throw v; } }), 'bad_request', 'filter'],
];
Object.entries(hostile).forEach(([name, make], i) => {
  sites.forEach(([where, run, code, what], j) => {
    test(`${where} throws ${name}: a coded Err (${code}) naming '${what}', never a throw`, async () => {
      const before = head();
      const v = make();
      assert.throws(() => String(v.message ?? v), 'the language: this value cannot be described by reading its message or by String()');
      let r;
      try { r = await run(v, `${i}-${j}`); } catch (e) { assert.fail(`the Result API threw/rejected: ${e instanceof Error ? e.message : 'a value with no string form'}`); }
      assert.equal(r.ok, false, 'a failing callback cannot be ok');
      assert.equal(r.error.code, code);
      assert.equal(r.error.what, what, 'the Err names the callback');
      assert.ok(r.error.cause === v, 'the Err carries the very value the callback threw as its cause');
      assert.equal(typeof r.error.message, 'string');
      assert.equal(head(), before, 'git says the ref did not move');
    });
  });
});

// The same for the directory itself: filesFromDir's Err describes `dir`, and a `dir` that is not a string may have no
// string form either. node:fs refuses it with a TypeError of its own, and README's row for node:fs failures applies:
// bad_request, what: 'dir', node's error as the cause.
for (const [name, make] of [['a Symbol', () => Symbol('d')], ...Object.entries(hostile).filter(([n]) => n !== 'an object whose message getter throws')]) {
  test(`filesFromDir and pushDir with ${name} as dir: bad_request naming 'dir', never a throw`, async () => {
    const before = head();
    for (const run of [d => filesFromDir(d), d => pushDir(url, { dir: d, ref: 'refs/heads/main', author, message: 'm' }, {})]) {
      const d = make();
      assert.throws(() => `${d}`, 'the language: this value has no string form');
      let r;
      try { r = await run(d); } catch (e) { assert.fail(`the Result API threw/rejected: ${e instanceof Error ? e.message : 'a value with no string form'}`); }
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'bad_request');
      assert.equal(r.error.what, 'dir');
      // node's ERR_INVALID_ARG_TYPE, or for the revoked Proxy the engine's own refusal to read it: a TypeError either way
      assert.ok(r.error.cause instanceof TypeError, "the cause is node's refusal of the argument, not something ply made");
    }
    assert.equal(head(), before, 'git says the ref did not move');
  });
}
