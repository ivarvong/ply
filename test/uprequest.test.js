// parseUploadPackRequest is the inverse of fetchBody / lsRefsBody (#120): every request ply encodes parses back to the
// spec it was built from (seeded property over generated requests), every refusal is typed, and exchangeKind / isPureFetch
// classify the result. The real-git side (requests git itself sends, verifyFetchAnswer, cachingFetch) is in
// test/packcache.test.js.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { te, concat, decodeBytes } from '../src/bytes.js';
import { pkt, FLUSH, DELIM } from '../src/pktline.js';
import { fetchBody as fetchBodyR } from '../src/fetch.js';
import { lsRefsBody as lsRefsBodyR } from '../src/lsrefs.js';
import { parseUploadPackRequest, exchangeKind, isPureFetch, isCacheableFetch } from '../src/packcache.js';
import { unwrap } from './unwrap.js';

const fetchBody = o => unwrap(fetchBodyR(o));
const lsRefsBody = (p, o) => unwrap(lsRefsBodyR(p, o));
const parse = b => unwrap(parseUploadPackRequest(b));

// mulberry32: the same seed is the same 2,000 requests
const rng = seed => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const R = rng(20261104);
const int = n => Math.floor(R() * n);
const pick = xs => xs[int(xs.length)];
const bool = () => R() < 0.5;
const many = (n, f) => Array.from({ length: int(n + 1) }, f);
const oid = () => Array.from({ length: 40 }, () => '0123456789abcdefABCDEF'[int(22)]).join('');
// names as ply reads them: ASCII, non-ASCII, and an escaped non-UTF-8 byte (decodeBytes, #43)
const name = () => pick(['refs/heads/main', 'refs/tags/v1.0', 'refs/heads/é', decodeBytes(new Uint8Array([0x72, 0x65, 0x66, 0x73, 0x2f, 0xff])), `refs/heads/b${int(1000)}`]);

const fetchSpec = () => ({
  wants: many(3, oid), haves: many(2, oid), shallows: many(2, oid),
  filter: pick(['', 'tree:0', 'blob:none', 'blob:limit=1k', 'combine:tree:0+blob:none']),
  deepen: pick([0, 0, 1, 7, 2 ** 31]), deepenSince: pick([0, 0, 1, 1761955200]), deepenNot: many(2, name),
  deepenRelative: bool(), thinPack: bool(), ofsDelta: bool(), includeTag: bool(), noProgress: bool(), done: bool(),
});
// what the parser hands back for a spec: the spec with git's extra arguments absent
const parsedFetch = s => ({ command: 'fetch', caps: [], wantRefs: [], sidebandAll: false, waitForDone: false, packfileUris: '', ...s });

test('round trip: parseUploadPackRequest(fetchBody(x)) is x, over 2,000 generated fetch requests', () => {
  for (let i = 0; i < 2000; i++) {
    const s = fetchSpec();
    // a want is parsed once into an id, lowercased (git reads either case as one object, #156); haves and shallows are wire fields
    assert.deepEqual(parse(fetchBody(s)), parsedFetch({ ...s, wants: s.wants.map(w => w.toLowerCase()) }), JSON.stringify(s));
  }
  // left-out arguments read as fetchBody's defaults (ofs-delta, no-progress and done on)
  assert.deepEqual(parse(fetchBody({ wants: ['a'.repeat(40)] })), parsedFetch({ wants: ['a'.repeat(40)], haves: [], shallows: [], filter: '', deepen: 0, deepenSince: 0, deepenNot: [], deepenRelative: false, thinPack: false, ofsDelta: true, includeTag: false, noProgress: true, done: true }));
});

test('round trip: parseUploadPackRequest(lsRefsBody(p, o)) is (p, o), over 500 generated ls-refs requests', () => {
  for (let i = 0; i < 500; i++) {
    const prefixes = many(4, () => pick(['', 'HEAD', 'refs/heads/', 'refs/tags/', name()]));
    const o = { peel: bool(), symrefs: bool(), unborn: bool() };
    assert.deepEqual(parse(lsRefsBody(prefixes, o)), { command: 'ls-refs', caps: [], prefixes, ...o });
  }
});

// a request framed by hand: lines (strings), DELIM and FLUSH markers, in order
const raw = (...parts) => concat(parts.map(p => (p === DELIM || p === FLUSH ? p : unwrap(pkt(p)))));
const W = 'b'.repeat(40);

test('requests git itself writes: capability lines, chomped and unchomped lines, every fetch argument', () => {
  const r = parse(raw('command=fetch\n', 'agent=git/2.50.0\n', 'object-format=sha1', DELIM, `want ${W}`, 'want-ref refs/heads/main\n', 'sideband-all\n', 'wait-for-done\n', 'packfile-uris https,http\n', 'thin-pack', FLUSH));
  assert.deepEqual(r.caps, ['agent=git/2.50.0', 'object-format=sha1']);
  assert.deepEqual(r.wants, [W]); assert.deepEqual(r.wantRefs, ['refs/heads/main']);
  assert.equal(r.sidebandAll, true); assert.equal(r.waitForDone, true); assert.equal(r.packfileUris, 'https,http'); assert.equal(r.thinPack, true);
  // a request with no arguments ends at the flush after its capabilities
  assert.deepEqual(parse(raw('command=ls-refs\n', 'agent=x\n', FLUSH)), { command: 'ls-refs', caps: ['agent=x'], prefixes: [], peel: false, symrefs: false, unborn: false });
});

test('refusals are typed: framing, order, command, every argument rule', () => {
  const refused = (body, re) => { const r = parseUploadPackRequest(body); assert.equal(r.ok, false); assert.equal(r.error.code, 'protocol'); assert.match(r.error.message, re); };
  refused(te.encode('zzzz'), /bad pkt-line length/);
  refused(te.encode('0010command=fe'), /trailing/);
  refused(raw('command=fetch\n', DELIM, `want ${W}\n`), /no flush ends the request/);
  refused(new Uint8Array(0), /no flush ends the request/);
  refused(concat([raw('command=fetch\n', DELIM, FLUSH), FLUSH]), /flush after the flush/);
  refused(concat([raw('command=fetch\n', DELIM), te.encode('0002'), FLUSH]), /response-end inside a request/);
  refused(raw(DELIM, 'command=fetch\n', FLUSH), /delim before the command line/);
  refused(raw('want x\n', FLUSH), /not command=<name>/);
  refused(raw('command=object-info\n', FLUSH), /unsupported command "object-info"/);
  refused(raw('command=fetch\n', DELIM, DELIM, FLUSH), /a second delim/);
  const arg = (line, re, command = 'fetch') => refused(raw(`command=${command}\n`, DELIM, line, FLUSH), re);
  arg('want xyz\n', /want must be a 40-hex oid/);
  arg(`have ${W}0\n`, /have must be a 40-hex oid/);
  arg('frobnicate\n', /unknown fetch argument "frobnicate"/);
  arg('frobnicate 1\n', /unknown fetch argument "frobnicate"/);
  arg('want-ref \n', /want-ref needs a value/);
  arg('filter \n', /filter must be given once/);
  refused(raw('command=fetch\n', DELIM, 'filter tree:0\n', 'filter blob:none\n', FLUSH), /filter must be given once/);
  arg('deepen 0\n', /deepen must be a positive integer/);
  arg('deepen -1\n', /deepen must be a positive integer/);
  arg('deepen-since 1e3\n', /deepen-since must be a positive integer/);
  arg('deepen 99999999999999999999\n', /deepen must be a positive integer/);
  refused(raw('command=fetch\n', DELIM, 'deepen 1\n', 'deepen 2\n', FLUSH), /a second deepen/);
  arg('ref-prefix\n', /unknown ls-refs argument "ref-prefix"/, 'ls-refs');
  arg('peel 1\n', /unknown ls-refs argument "peel"/, 'ls-refs');
});

test('exchangeKind: a pure fetch is pack, ls-refs is refs, the advertisement is discover, the rest is null', () => {
  const u = 'https://h/r.git/git-upload-pack';
  const pure = fetchBody({ wants: [W], filter: 'tree:0', deepen: 1 });
  assert.equal(exchangeKind('POST', u, pure), 'pack');
  assert.equal(exchangeKind('post', new URL(u), fetchBody({ wants: [W] })), 'pack', 'a blob fetch with no filter is pure too');
  assert.equal(exchangeKind('POST', u, decodeBytes(pure)), 'pack', 'a string body');
  assert.equal(exchangeKind('POST', u, lsRefsBody(['refs/heads/'])), 'refs');
  assert.equal(exchangeKind('GET', 'https://h/r.git/info/refs?service=git-upload-pack', null), 'discover');
  assert.equal(exchangeKind('GET', 'https://h/r.git/info/refs?service=git-receive-pack', null), null);
  assert.equal(exchangeKind('GET', 'https://h/r.git/info/refs', null), null);
  assert.equal(exchangeKind('POST', 'https://h/r.git/git-receive-pack', pure), null);
  assert.equal(exchangeKind('POST', u, null), null);
  assert.equal(exchangeKind('POST', u, te.encode('garbage')), null);
  assert.equal(exchangeKind('PUT', u, pure), null);
  // each impurity on its own
  for (const extra of [{ haves: [W] }, { shallows: [W] }, { deepenSince: 1 }, { deepenNot: ['refs/heads/x'] }, { deepenRelative: true }, { includeTag: true }, { done: false }]) {
    assert.equal(exchangeKind('POST', u, fetchBody({ wants: [W], ...extra })), null, JSON.stringify(extra));
  }
  assert.equal(exchangeKind('POST', u, fetchBody({ wants: [] })), null, 'no want');
  for (const line of ['want-ref refs/heads/main\n', 'packfile-uris https\n', 'sideband-all\n']) assert.equal(exchangeKind('POST', u, raw('command=fetch\n', DELIM, `want ${W}\n`, line, 'done\n', FLUSH)), null, line);
  assert.equal(exchangeKind('POST', u, raw('command=fetch\n', 'server-option=x\n', DELIM, `want ${W}\n`, 'done\n', FLUSH)), null, 'a server option');
  assert.equal(exchangeKind('POST', u, raw('command=fetch\n', 'agent=git/2.50.0\n', DELIM, `want ${W}\n`, 'done\n', FLUSH)), 'pack', 'an agent is not an impurity');
  assert.equal(isPureFetch(parse(pure)), true);
  // the default cache rule is unchanged: a pure fetch with a filter line
  assert.equal(isCacheableFetch(pure), true);
  assert.equal(isCacheableFetch(fetchBody({ wants: [W] })), false);
  assert.equal(isCacheableFetch(lsRefsBody([])), false);
});
