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
import { editFile, commitChanges, readCommit, checkoutTree, createTransport, cachingFetch, memoryCache, Tracer } from '../src/index.js';
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
  // A caller's transport, fetchImpl and pack-cache callbacks are named like the signer (README "Your own code failing").
  // Hand-derived: an upload-pack request only reads, so a frames() failure there is definite (bad_request: the caller's
  // code); a receive-pack request was handed to the transport when frames() was called for it, so it is ambiguous.
  ['caller transport: frames throws on upload-pack', n => write({ transport: transportWith(() => ({ frames: () => { throw boom; } })) }, n), 'bad_request', 'transport.frames', 'definite'],
  ['caller transport: frames rejects on iteration (upload-pack)', n => write({ transport: transportWith(() => ({ frames: () => (async function* () { await null; throw boom; })() })) }, n), 'bad_request', 'transport.frames', 'definite'],
  ['caller transport: frames throws when called for receive-pack', n => write({ transport: transportWith(real => ({ frames: (service, body, span, hints) => { if (service === 'git-receive-pack') throw boom; return real.frames(service, body, span, hints); } })) }, n), 'ambiguous', 'transport.frames', 'handed-over'],
  ['caller transport: frames throws after delivering the push', n => write({ transport: transportWith(real => ({
    // the real request is made and fully read (the push lands), then the caller's code throws
    frames: (service, body, span, hints) => service !== 'git-receive-pack' ? real.frames(service, body, span, hints) : (async function* () { const all = []; for await (const f of real.frames(service, body, span, hints)) all.push(f); throw boom; })(),
  })) }, n), 'ambiguous', 'transport.frames', 'landed'],
  // advertise is consulted only to confirm a refused push; a healthy push never calls it, so its failure changes nothing
  ['caller transport: advertise rejects', n => write({ transport: transportWith(() => ({ advertise: async () => { await null; throw boom; } })) }, n), 'ok', null, 'ok'],
  // an advertise() that ply does call: the body asks the caller's transport for the upload-pack advertisement
  ['caller transport: advertise rejects when called', () => operation('probe', url, { transport: transportWith(() => ({ advertise: async () => { await null; throw boom; } })) }, async ({ t, root: span }) => t.advertise('git-upload-pack', span)), 'bad_request', 'transport.advertise', 'definite'],
  // A fetch that fails is a network failure (README's error table: `network`), whoever supplied the fetch; a supplied one is named.
  ['fetchImpl throws synchronously (read)', () => readCommit(url, { ref: 'main' }, { fetchImpl: () => { throw boom; } }), 'network', 'fetchImpl', 'definite'],
  ['fetchImpl rejects (write)', n => write({ fetchImpl: async () => { await null; throw boom; } }, n), 'network', 'fetchImpl', 'definite'],
  // the pack cache's callbacks run on upload-pack (read) requests only: definite, the caller's code (bad_request)
  ['cachingFetch: shouldCache throws (read)', () => readCommit(url, { ref: 'main' }, { fetchImpl: cachingFetch(globalThis.fetch, memoryCache(), { shouldCache: () => { throw boom; } }) }), 'bad_request', 'shouldCache', 'definite'],
  ['cachingFetch: cache.match throws synchronously (read)', () => readCommit(url, { ref: 'main' }, { fetchImpl: cachingFetch(globalThis.fetch, { ...memoryCache(), match: () => { throw boom; } }) }), 'bad_request', 'cache.match', 'definite'],
  ['cachingFetch: waitUntil throws (read)', () => readCommit(url, { ref: 'main' }, { fetchImpl: cachingFetch(globalThis.fetch, memoryCache(), { shouldCache: () => true, waitUntil: () => { throw boom; } }) }), 'bad_request', 'waitUntil', 'definite'],
  // the put of a miss is called inside the fetch that missed, before it answers
  ['cachingFetch: cache.put throws synchronously (read)', () => readCommit(url, { ref: 'main' }, { fetchImpl: cachingFetch(globalThis.fetch, { ...memoryCache(), put: () => { throw boom; } }) }), 'bad_request', 'cache.put', 'definite'],
  // main's split store calls the put inside the fetch on every miss, verifyBeforeStore or not (the verified bytes are
  // streamed to it as the client reads), so a put or waitUntil that throws when called is this read's own named Err
  ['cachingFetch verifyBeforeStore: cache.put throws synchronously (read)', () => readCommit(url, { ref: 'main' }, { fetchImpl: cachingFetch(globalThis.fetch, { ...memoryCache(), put: () => { throw boom; } }, { verifyBeforeStore: true }) }), 'bad_request', 'cache.put', 'definite'],
  ['cachingFetch verifyBeforeStore: waitUntil throws (read)', () => readCommit(url, { ref: 'main' }, { fetchImpl: cachingFetch(globalThis.fetch, memoryCache(), { verifyBeforeStore: true, waitUntil: () => { throw boom; } }) }), 'bad_request', 'waitUntil', 'definite'],
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
      assert.notEqual(r.error, boom, "the Err is ply's own object, not the caller's thrown value");
      // a fresh Error has no own enumerable keys (the language): ply wrote none on the caller's object
      assert.deepEqual(Object.keys(boom), [], "ply wrote nothing on the caller's thrown Error");
    }
    if (cls === 'landed') assert.notEqual(head(), before, 'this row delivers the push before throwing: git says the ref moved, so only ambiguous is honest');
    else assert.equal(head(), before, 'git says the ref did not move');
  });
});

// The cache's delete is called only on a bust (the transport's one refetch after a poisoned hit, `x-ply-cache: bust`),
// so the fetch is called here as the transport calls it. A fetch reports a failure by rejecting: the rejection is the
// named Err, which the transport returns as it is (the cache.match row above shows that path end to end).
test("cachingFetch: cache.delete throws synchronously on a bust: the fetch rejects with bad_request naming 'cache.delete'", async () => {
  const thrown = new Error('boom delete');
  const f = cachingFetch(globalThis.fetch, { ...memoryCache(), delete: () => { throw thrown; } }, { shouldCache: () => true });
  const e = await f(`${url}/git-upload-pack`, { method: 'POST', headers: { 'x-ply-cache': 'bust' }, body: new Uint8Array(4) }).then(() => assert.fail('the fetch resolved'), x => x);
  assert.deepEqual([e.code, e.what], ['bad_request', 'cache.delete']);
  assert.equal(e.cause, thrown, 'the Err carries the very value the callback threw as its cause');
  assert.notEqual(e, thrown, "the Err is ply's own object, not the caller's thrown value");
  assert.deepEqual(Object.keys(thrown), [], "ply wrote nothing on the caller's thrown Error");
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
  ["a caller transport's frames() (readCommit)", v => readCommit(url, { ref: 'main' }, { transport: transportWith(() => ({ frames: () => { throw v; } })) }), 'bad_request', 'transport.frames'],
  ["a caller transport's frames() (commitChanges)", (v, n) => write({ transport: transportWith(() => ({ frames: () => { throw v; } })) }, `hostile-${n}`), 'bad_request', 'transport.frames'],
  ['fetchImpl (readCommit)', v => readCommit(url, { ref: 'main' }, { fetchImpl: () => { throw v; } }), 'network', 'fetchImpl'],
  ['a rejecting fetchImpl (commitChanges)', (v, n) => write({ fetchImpl: async () => { await null; throw v; } }, `hostile-${n}`), 'network', 'fetchImpl'],
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

// A put or waitUntil that throws when called ends the fetch with the named Err, and the answer is abandoned first
// (src/packcache.ts): the origin's body is cancelled before the rejection, and nothing of it stays stored. The origin
// here is a stream that records its own cancel(); the order of events is the oracle (the WHATWG Streams standard:
// cancelling a reader calls the underlying source's cancel), not anything ply reports. The origin sends one chunk and
// then holds the stream open, so only a cancel can end it.
for (const [what, cacheOf, optionsOf] of [
  ['cache.put', thrown => ({ ...memoryCache(), put: () => { throw thrown; } }), () => ({})],
  ['waitUntil', () => memoryCache(), thrown => ({ waitUntil: () => { throw thrown; } })],
]) {
  test(`cachingFetch: ${what} throws synchronously: the origin is cancelled before the fetch rejects with bad_request naming '${what}', and nothing stays stored`, async () => {
    const thrown = new Error(`boom ${what}`);
    const events = [];
    const origin = async () => {
      await null;
      const body = new ReadableStream({
        start(ctl) { ctl.enqueue(new Uint8Array([0x30, 0x30, 0x30, 0x38, 0x4e, 0x41, 0x4b, 0x0a])); },
        pull() { return new Promise(() => null); },
        cancel() { events.push('origin cancelled'); },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' } });
    };
    const cache = cacheOf(thrown);
    const f = cachingFetch(origin, cache, { shouldCache: () => true, ...optionsOf(thrown) });
    const e = await f(`${url}/git-upload-pack`, { method: 'POST', body: new Uint8Array(4) }).then(() => assert.fail('the fetch resolved'), x => { events.push('rejected'); return x; });
    assert.deepEqual([e.code, e.what], ['bad_request', what]);
    assert.equal(e.cause, thrown, 'the Err carries the very value the callback threw as its cause');
    assert.deepEqual(events, ['origin cancelled', 'rejected'], "the origin's body is cancelled before the fetch rejects");
    // let a store that was started (the waitUntil row) settle and clean up
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
    assert.equal(cache.entries.size, 0, 'nothing of the abandoned answer stays stored');
  });
}
