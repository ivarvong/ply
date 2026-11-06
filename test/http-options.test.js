// HttpOptions are parsed once (#156): parseHttpOptions makes every check the transport makes of its options, and the
// transport reads only the settings. The limits record is parsed there (parseLimits): a bad key, among them the two
// it reads on every request (requestTimeoutMs, maxPackBytes), is refused when the transport is made, with no request,
// and is the same bad_request a request used to fail with. Every refusal keeps its order (the limits come last; among
// the limits, DEFAULT_LIMITS order). A key left out is the default.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createTransport, parseHttpOptions } from '../src/http.js';
import { GitHttp } from '../src/client.js';
import { readFile } from '../src/read.js';
import { DEFAULT_LIMITS, withLimits } from '../src/limits.js';
import { unwrap } from './unwrap.js';

const counting = () => { const c = { n: 0 }; c.fetchImpl = async () => { c.n++; return new Response('', { status: 500 }); }; return c; };

test('a bad request timeout or pack cap is refused when the transport is made, before any request', async () => {
  for (const [key, value] of [['requestTimeoutMs', NaN], ['requestTimeoutMs', -1], ['maxPackBytes', Infinity], ['maxPackBytes', '1']]) {
    const c = counting();
    const r = createTransport('https://h/r.git', { fetchImpl: c.fetchImpl, limits: withLimits({ [key]: value }) });
    assert.equal(r.ok, false, key);
    assert.deepEqual([r.error.code, r.error.what, r.error.got], ['bad_request', key, value], key);
    assert.equal(GitHttp.create('https://h/r.git', { limits: withLimits({ [key]: value }) }).ok, false);
    // through an operation: the same refusal, still no request
    const op = await readFile('https://h/r.git', { ref: 'refs/heads/main', path: 'a' }, { fetchImpl: c.fetchImpl, limits: withLimits({ [key]: value }) });
    assert.deepEqual([op.ok, op.error?.code, op.error?.what], [false, 'bad_request', key]);
    assert.equal(c.n, 0, key);
  }
  // a key given as null is given, and refused (got: null)
  const partial = createTransport('https://h/r.git', { limits: { ...DEFAULT_LIMITS, requestTimeoutMs: null } });
  assert.deepEqual([partial.error.code, partial.error.what, partial.error.got], ['bad_request', 'requestTimeoutMs', null]);
  // a key left out is the default (#156: it used to be refused at its first read)
  const { requestTimeoutMs: _left, ...rest } = DEFAULT_LIMITS;
  const filled = parseHttpOptions('https://h/r.git', { limits: { ...rest, maxPackBytes: 7 } }).value;
  assert.deepEqual([filled.requestTimeoutMs, filled.maxPackBytes, filled.limits.requestTimeoutMs], [DEFAULT_LIMITS.requestTimeoutMs, 7, DEFAULT_LIMITS.requestTimeoutMs]);
  assert.deepEqual({ ...parseHttpOptions('https://h/r.git', { limits: {} }).value.limits }, { ...DEFAULT_LIMITS });
});

test('the limits come after every other refusal, as the first request used to', () => {
  const bad = withLimits({ requestTimeoutMs: NaN });
  assert.equal(createTransport('https://h/r', { followRedirects: 'always', limits: bad }).error.what, 'followRedirects');
  assert.equal(createTransport('https://h/r', { userAgent: 'a\nb', limits: bad }).error.message.startsWith('invalid user agent'), true);
  assert.equal(createTransport('https://h/r', { recordResponseHeaders: ['a b'], limits: bad }).error.what, 'recordResponseHeaders');
  assert.equal(createTransport('not a url', { limits: bad }).error.what, 'url');
  assert.equal(createTransport('https://h/r', { auth: { user: 'u' }, limits: bad }).error.what, 'auth');
  assert.equal(createTransport('https://h/r', { allowUrl: () => ({ ok: false, error: { code: 'bad_request', what: 'mine' } }), limits: bad }).error.what, 'mine');
  // the first bad key in DEFAULT_LIMITS order: maxPackBytes before requestTimeoutMs
  assert.equal(createTransport('https://h/r', { limits: withLimits({ requestTimeoutMs: NaN, maxPackBytes: NaN }) }).error.what, 'maxPackBytes');
  assert.equal(createTransport('https://h/r', { limits: withLimits({ requestTimeoutMs: NaN, maxMergeBlobBytes: -1 }) }).error.what, 'maxMergeBlobBytes');
});

test('the settings: the URL without userinfo, the credential resolved once, the fetch bound, the stream redirect mode', () => {
  const s = parseHttpOptions('https://tok@h.example/org/r.git#frag');
  assert.equal(s.ok, true);
  const v = s.value;
  assert.equal(v.url.toString(), 'https://h.example/org/r.git');
  assert.equal(v.authorization, `Basic ${btoa('tok:')}`);
  assert.equal(v.crossOrigin, false);
  assert.deepEqual(v.policy, { follow: 'never', max: 3 });
  assert.equal(v.userAgent, 'ply/0.2.0');
  assert.deepEqual([v.requestTimeoutMs, v.maxPackBytes], [DEFAULT_LIMITS.requestTimeoutMs, DEFAULT_LIMITS.maxPackBytes]);
  assert.equal(v.streamRedirect, 'error', 'undici takes redirect error');
  assert.notEqual(v.fetch, globalThis.fetch, 'the platform fetch is bound');
  const own = async () => new Response('');
  assert.equal(parseHttpOptions('https://h/r', { fetchImpl: own }).value.fetch, own);
  const moved = parseHttpOptions('https://h/r', { allowUrl: u => ({ ok: true, value: new URL('https://other.example/r') }) }).value;
  assert.equal(moved.crossOrigin, true);
  const explicit = parseHttpOptions('https://h/r', { auth: { token: 't', user: 'me' } }).value;
  assert.deepEqual([explicit.authorization, explicit.explicitBasic], [`Basic ${btoa('me:t')}`, { user: 'me', pass: 't' }]);
});

test('the transport reads the parsed timeout: the span carries it and a stalled request ends at it', async () => {
  const spans = [];
  const tracer = { span: async (_n, _o, fn) => fn({ set: a => spans.push(a), event() {}, error() {} }) };
  const stall = (_u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const t = createTransport('https://h/r', { fetchImpl: stall, limits: withLimits({ requestTimeoutMs: 50 }) }).value;
  const t0 = Date.now();
  await assert.rejects(async () => { for await (const _ of t.frames('git-upload-pack', new Uint8Array(0), { set: a => spans.push(a), event() {} }, { bypassCache: false })) { /* none */ } }, e => e.code === 'timeout');
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(spans.some(a => a['git.limits.request_timeout_ms'] === 50));
  void tracer;
});

import { streamRedirect } from '../src/http.js';

test('streamRedirect: error where new Request takes it, manual where it throws (workerd) or reads back another mode', () => {
  assert.equal(streamRedirect(), 'error');
  const Real = globalThis.Request;
  try {
    globalThis.Request = class { constructor() { throw new TypeError('Invalid redirect value'); } };
    assert.equal(streamRedirect(), 'manual');
    globalThis.Request = class { constructor() { this.redirect = 'follow'; } };
    assert.equal(streamRedirect(), 'manual');
  } finally { globalThis.Request = Real; }
});

test('the settings carry the module brand (one symbol key, true), and the base drops one trailing slash', () => {
  const v = parseHttpOptions('https://h/org/r.git/').value;
  const keys = Object.getOwnPropertySymbols(v);
  assert.equal(keys.length, 1);
  assert.equal(v[keys[0]], true);
  assert.equal(createTransport('https://h/org/r.git/').value.url, 'https://h/org/r.git');
  assert.equal(createTransport('https://h/org/r.git').value.url, 'https://h/org/r.git');
});

// a fetch double: records each request's init and answers a git result (a flush) or an advertisement
const recorder = (answer = () => new Response(new Uint8Array([0x30, 0x30, 0x30, 0x30]), { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' } })) => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url: String(url), init }); return answer(url, init); };
  return { seen, fetchImpl };
};
const spanOf = () => { const attrs = {}; return { attrs, set: a => Object.assign(attrs, a), event() {}, error() {} }; };
const drain = async (t, body, span = spanOf()) => { for await (const _ of t.frames('git-receive-pack', body, span, { bypassCache: false })) { /* frames */ } return span; };

test('post: bytes go as a POST body with redirect manual; a stream goes with duplex half and the stream redirect mode', async () => {
  const r = recorder();
  const t = createTransport('https://h/r', { fetchImpl: r.fetchImpl }).value;
  const bytes = Uint8Array.of(1, 2, 3);
  const span = await drain(t, bytes);
  const [a] = r.seen;
  assert.equal(a.url, 'https://h/r/git-receive-pack');
  assert.deepEqual([a.init.method, a.init.redirect, a.init.duplex, Buffer.from(a.init.body).toString('hex')], ['POST', 'manual', undefined, '010203']);
  assert.deepEqual([span.attrs['git.transport'], span.attrs['http.request.method'], span.attrs['git.request.bytes'], span.attrs['http.request.body.size']], ['http', 'POST', 3, 3]);
  const stream = new ReadableStream({ start(c) { c.enqueue(Uint8Array.of(9)); c.close(); } });
  const span2 = await drain(t, { stream, length: 1 });
  const b = r.seen[1];
  assert.deepEqual([b.init.method, b.init.redirect, b.init.duplex, b.init.body === stream], ['POST', 'error', 'half', true]);
  assert.equal(span2.attrs['git.request.bytes'], 1);
});

test('a finished exchange clears its timer: the request signal does not fire after it (advertise and post)', async () => {
  const adv = () => new Response('001e# service=git-upload-pack\n0000', { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
  const r = recorder((url) => (String(url).includes('info/refs') ? adv() : new Response(new Uint8Array([0x30, 0x30, 0x30, 0x30]), { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' } })));
  const t = createTransport('https://h/r', { fetchImpl: r.fetchImpl, limits: withLimits({ requestTimeoutMs: 60 }) }).value;
  assert.equal((await t.advertise('git-upload-pack', spanOf())).ok, true);
  await drain(t, Uint8Array.of(0));
  await new Promise(res => setTimeout(res, 150));
  assert.deepEqual(r.seen.map(s => s.init.signal.aborted), [false, false]);
});

test('a body that fails mid-read is the network error it is', async () => {
  const failing = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('0008abcd')); }, pull(c) { c.error(new TypeError('socket hang up')); } }), { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' } });
  const t = createTransport('https://h/r', { fetchImpl: recorder(failing).fetchImpl }).value;
  await assert.rejects(drain(t, Uint8Array.of(0)), e => e.code === 'network');
});

test('the advertisement: its GET asks redirect manual; a foreign content type is not_git; the Content-Length cap is inclusive', async () => {
  const adv = (ct, length = null) => () => new Response('001e# service=git-upload-pack\n0000', { status: 200, headers: { 'content-type': ct, ...(length === null ? {} : { 'content-length': String(length) }) } });
  const r = recorder(adv('application/x-git-upload-pack-advertisement'));
  const t = createTransport('https://h/r', { fetchImpl: r.fetchImpl }).value;
  assert.equal((await t.advertise('git-upload-pack', spanOf())).ok, true);
  assert.equal(r.seen[0].init.redirect, 'manual');
  for (const ct of ['text/html', 'text/plain; application/x-git-upload-pack-advertisement', '']) {
    const bad = await createTransport('https://h/r', { fetchImpl: recorder(adv(ct)).fetchImpl }).value.advertise('git-upload-pack', spanOf());
    assert.deepEqual([bad.ok, bad.error.code, bad.error.message], [false, 'not_git', 'unexpected content-type from git-upload-pack advertisement'], ct);
  }
  const body = '001e# service=git-upload-pack\n0000'.length;
  const at = await createTransport('https://h/r', { fetchImpl: recorder(adv('application/x-git-upload-pack-advertisement', body)).fetchImpl, limits: withLimits({ maxPackBytes: body }) }).value.advertise('git-upload-pack', spanOf());
  assert.equal(at.ok, true, 'a Content-Length equal to the cap is read');
  const over = await createTransport('https://h/r', { fetchImpl: recorder(adv('application/x-git-upload-pack-advertisement', body)).fetchImpl, limits: withLimits({ maxPackBytes: body - 1 }) }).value.advertise('git-upload-pack', spanOf());
  assert.deepEqual([over.ok, over.error.code, over.error.got, over.error.max], [false, 'limit_exceeded', body, body - 1]);
});

// The other places a limits record enters (#156): syncRef parses it once for both remotes, and a transport handed in
// has its record parsed (transportFrom) before the operation sends anything.
test('syncRef and a handed-in transport parse their limits before any request; a complete transport is kept as it is', async () => {
  const { syncRef } = await import('../src/sync.js');
  const { asTransport, transportFrom } = await import('../src/transport.js');
  const { parseLimits, lowered } = await import('../src/limits.js');
  const c = counting();
  const r = await syncRef('https://h/a.git', 'https://h/b.git', { ref: 'refs/heads/main' }, { fetchImpl: c.fetchImpl, limits: { maxRefs: -1 } });
  assert.deepEqual([r.ok, r.error.code, r.error.what, c.n], [false, 'bad_request', 'maxRefs', 0]);
  const t = createTransport('https://h/r.git', { fetchImpl: c.fetchImpl }).value;
  // every field present and the limits the transport's own: the transport itself
  assert.equal(asTransport(t, t.limits), t);
  assert.equal(transportFrom(t).value, t);
  // other limits: a view of it with those limits, the caller's state shared
  const low = lowered(t.limits, 'maxRefs', 3);
  const view = asTransport(t, low);
  assert.notEqual(view, t);
  assert.deepEqual([view.limits, view.quirks, view.objects, view.scrub, view.url], [low, t.quirks, t.objects, t.scrub, t.url]);
  // a hand-built record: its plain limits parsed (a key left out is the default), its missing state filled
  const hand = { kind: 'http', url: 'x', tracer: t.tracer, parent: null, signal: null, frames: t.frames, advertise: t.advertise, limits: { maxRefs: 5 } };
  const made = transportFrom(hand).value;
  assert.deepEqual([made.limits.maxRefs, made.limits.maxObjectSize, unwrap(parseLimits(made.limits)) === made.limits], [5, DEFAULT_LIMITS.maxObjectSize, true]);
  assert.deepEqual([made.quirks, made.objects.size, made.scrub], [{ treeFilter: 'tree:0', blobWants: 'many' }, 0, null]);
  // only a record with all three fields and these limits is kept as it is
  const full = { ...hand, quirks: t.quirks, objects: t.objects, scrub: null, limits: t.limits };
  assert.equal(asTransport(full, t.limits), full);
  assert.notEqual(asTransport(full, low), full);
  for (const drop of ['quirks', 'objects', 'scrub']) {
    const { [drop]: _gone, ...rec } = full;
    const v = asTransport(rec, t.limits);
    assert.notEqual(v, rec, drop);
    assert.deepEqual([v.quirks, v.objects instanceof Map, v.scrub, v.limits], [drop === 'quirks' ? { treeFilter: 'tree:0', blobWants: 'many' } : t.quirks, true, null, t.limits], drop);
  }
  for (const [key, value] of [['quirks', null], ['objects', null]]) assert.notEqual(asTransport({ ...full, [key]: value }, t.limits), full, key);
  assert.deepEqual([transportFrom({ ...hand, limits: { maxRefs: NaN } }).error.what, c.n], ['maxRefs', 0]);
});

test('a URL that does not parse, and a NUL, CR or LF in its userinfo, are refused with their own message and what', () => {
  const bad = createTransport('not a url', {});
  assert.deepEqual([bad.error.code, bad.error.message, bad.error.what], ['bad_request', 'invalid url: not an absolute URL', 'url']);
  for (const url of ['https://u%0a:p@h/r.git', 'https://u:p%0d@h/r.git', 'https://u%00@h/r.git']) {
    const r = parseHttpOptions(url, {});
    assert.deepEqual([r.ok, r.error?.code, r.error?.what], [false, 'bad_request', 'url userinfo'], url);
  }
  // explicit auth wins: the URL's userinfo is not read, so it is not refused either
  assert.equal(parseHttpOptions('https://u%0a@h/r.git', { auth: { token: 't' } }).ok, true);
});

// The redirect memo (ply-web#117), against a fetch double. `moves` maps a path prefix to where its info/refs (and, with
// `all`, every request) is sent with a 301; everything else answers an advertisement or an empty upload-pack result.
// Each test uses its own host name, so the module memo is not shared between tests.
import { forgetQuirks, QUIRKS_MEMO_MAX } from '../src/transport.js';
const UP = 'git-upload-pack';
const ADV = '000eversion 2\n0000';
const memoHost = (moves = new Map(), { throwOnStreamRedirect = false } = {}) => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    seen.push({ line: `${method} ${u.host}${u.pathname}`, auth: new Headers(init.headers).get('authorization') });
    const repo = u.pathname.slice(0, u.pathname.lastIndexOf(u.pathname.endsWith('/info/refs') ? '/info/refs' : '/'));
    const move = moves.get(`${u.host}${repo}`);
    if (move !== undefined && (move.all || method === 'GET')) {
      if (throwOnStreamRedirect && init.redirect === 'error') throw new TypeError('fetch failed: redirect mode is error');
      return new Response(null, { status: 301, headers: { location: `${move.to}${u.pathname.slice(repo.length)}${u.search}` } });
    }
    if (method === 'GET') return new Response(ADV, { status: 200, headers: { 'content-type': `application/x-${UP}-advertisement` } });
    return new Response('0000', { status: 200, headers: { 'content-type': `application/x-${UP}-result` } });
  };
  return { seen, fetchImpl, lines: () => seen.map(s => s.line), clear: () => { seen.length = 0; } };
};
const memoT = (url, h, opts = {}) => createTransport(url, { fetchImpl: h.fetchImpl, followRedirects: 'initial', ...opts });
const postUp = async (t, body = Uint8Array.of(0x30, 0x30, 0x30, 0x30), span = spanOf()) => { for await (const _ of t.frames(UP, body, span, { bypassCache: false })) { /* frames */ } return span; };

test('memo: the second transport for a remote makes no GET and posts to the settled base; its span says it was rebased', async () => {
  const h = memoHost(new Map([['m1/old', { to: 'https://m1/new', all: false }]]));
  const first = memoT('https://m1/old', h, { auth: { bearer: 'tok' } }).value;
  await postUp(first);
  assert.deepEqual(h.lines(), ['GET m1/old/info/refs', 'GET m1/new/info/refs', 'POST m1/new/git-upload-pack']);
  h.clear();
  const second = memoT('https://m1/old/', h, { auth: { bearer: 'tok' } }).value;
  const span = await postUp(second);
  assert.deepEqual(h.lines(), ['POST m1/new/git-upload-pack']);
  assert.equal(second.url, 'https://m1/new');
  assert.deepEqual(h.seen.map(s => s.auth), ['Bearer tok']);
  assert.deepEqual([span.attrs['http.redirect.count'], span.attrs['git.remote.rebased_from'], span.attrs['url.full']], [1, 'https://m1/old', 'https://m1/new/git-upload-pack']);
  // a settled transport does not replay again; an advertise on a memo base that answers is the confirmation
  h.clear();
  await postUp(second);
  assert.equal((await memoT('https://m1/old', h).value.advertise(UP, spanOf())).ok, true);
  assert.deepEqual(h.lines(), ['POST m1/new/git-upload-pack', 'GET m1/new/info/refs']);
  // no redirect is remembered too; another service is its own entry
  h.clear();
  await postUp(memoT('https://m1/plain', h).value);
  await postUp(memoT('https://m1/plain', h).value);
  assert.equal((await memoT('https://m1/plain', h).value.advertise('git-receive-pack', spanOf())).ok, false, 'the double answers upload-pack only');
  assert.deepEqual(h.lines(), ['GET m1/plain/info/refs', 'POST m1/plain/git-upload-pack', 'POST m1/plain/git-upload-pack', 'GET m1/plain/info/refs']);
});

test('memo: never neither reads nor writes it; a list past maxRedirects is not replayed; a failed advertisement is not remembered', async () => {
  const h = memoHost(new Map([['m2/old', { to: 'https://m2/a', all: false }], ['m2/a', { to: 'https://m2/b', all: false }]]));
  await postUp(memoT('https://m2/old', h).value);
  assert.deepEqual(h.lines(), ['GET m2/old/info/refs', 'GET m2/a/info/refs', 'GET m2/b/info/refs', 'POST m2/b/git-upload-pack']);
  h.clear();
  await postUp(createTransport('https://m2/old', { fetchImpl: h.fetchImpl }).value);
  assert.deepEqual(h.lines(), ['POST m2/old/git-upload-pack'], 'never: no memo');
  h.clear();
  const one = memoT('https://m2/old', h, { maxRedirects: 1 }).value;
  await assert.rejects(postUp(one), e => e.code === 'http');
  assert.deepEqual(h.lines(), ['GET m2/old/info/refs', 'GET m2/a/info/refs'], 'two hops remembered, one allowed: asked again');
  h.clear();
  await postUp(memoT('https://m2/old', h, { maxRedirects: 2 }).value);
  assert.deepEqual(h.lines(), ['POST m2/b/git-upload-pack'], 'exactly maxRedirects hops: replayed');
  // never writes: a fresh remote asked through `never` first is still unknown to 'initial'
  h.clear();
  await postUp(createTransport('https://m2/fresh', { fetchImpl: h.fetchImpl }).value);
  await postUp(memoT('https://m2/fresh', h).value);
  assert.deepEqual(h.lines(), ['POST m2/fresh/git-upload-pack', 'GET m2/fresh/info/refs', 'POST m2/fresh/git-upload-pack']);
  // a 404 advertisement settles nothing to remember
  const gone = { ...h, fetchImpl: async (url, init) => (init.method === undefined ? new Response('no', { status: 404 }) : h.fetchImpl(url, init)) };
  await assert.rejects(postUp(memoT('https://m2/gone', gone).value), e => e.code === 'not_found');
  h.clear();
  await postUp(memoT('https://m2/gone', h).value);
  assert.deepEqual(h.lines(), ['GET m2/gone/info/refs', 'POST m2/gone/git-upload-pack']);
});

test('memo: each Location goes through the new transport\'s allowUrl; a refusal or a non-rebase asks the network; a cross-origin replay drops the credential', async () => {
  const h = memoHost(new Map([['m3/old', { to: 'https://m3x/new', all: false }]]));
  await postUp(memoT('https://m3/old', h, { auth: { bearer: 'tok' } }).value);
  assert.deepEqual(h.seen.map(s => [s.line, s.auth]), [['GET m3/old/info/refs', 'Bearer tok'], ['GET m3x/new/info/refs', null], ['POST m3x/new/git-upload-pack', null]]);
  h.clear();
  await postUp(memoT('https://m3/old', h, { auth: { bearer: 'tok' } }).value);
  assert.deepEqual(h.seen.map(s => [s.line, s.auth]), [['POST m3x/new/git-upload-pack', null]], 'replayed: still no credential on the other origin');
  const calls = [];
  const deny = url => { calls.push(url.href); return url.host === 'm3x' ? { ok: false, error: Object.assign(new Error('denied'), { code: 'auth' }) } : { ok: true, value: url }; };
  h.clear();
  await assert.rejects(postUp(memoT('https://m3/old', h, { allowUrl: deny }).value), e => e.message === 'denied');
  assert.deepEqual(calls, ['https://m3/old', `https://m3x/new/info/refs?service=${UP}`, `https://m3x/new/info/refs?service=${UP}`]);
  assert.deepEqual(h.lines(), ['GET m3/old/info/refs']);
  // an allowUrl whose answer drops the suffix: the replay cannot rebase, so the network is asked (and refuses the same)
  h.clear();
  const strip = url => ({ ok: true, value: url.host === 'm3x' ? new URL('https://m3x/elsewhere') : url });
  await assert.rejects(postUp(memoT('https://m3/old', h, { allowUrl: strip }).value), e => e.code === 'http');
  assert.deepEqual(h.lines(), ['GET m3/old/info/refs']);
  // an allowUrl that rewrites: the replay takes its answer
  h.clear();
  const rename = url => ({ ok: true, value: url.host === 'm3x' ? new URL(`https://m3x/renamed/info/refs?service=${UP}`) : url });
  const t = memoT('https://m3/old', h, { allowUrl: rename }).value;
  await postUp(t);
  assert.equal(t.url, 'https://m3x/renamed');
  assert.deepEqual(h.lines(), ['POST m3x/renamed/git-upload-pack']);
});

test('memo: stale on a POST (bytes re-sent once after the GET), on a GET (starts over), and on a stream (the error; the entry is dropped)', async () => {
  const moves = new Map([['m4/old', { to: 'https://m4/a', all: false }]]);
  const h = memoHost(moves);
  await postUp(memoT('https://m4/old', h).value);
  moves.set('m4/old', { to: 'https://m4/b', all: false });
  moves.set('m4/a', { to: 'https://m4/b', all: true });
  h.clear();
  const t = memoT('https://m4/old', h).value;
  const span = await postUp(t);
  assert.deepEqual(h.lines(), ['POST m4/a/git-upload-pack', 'GET m4/old/info/refs', 'GET m4/b/info/refs', 'POST m4/b/git-upload-pack']);
  assert.equal(h.seen[3].line, 'POST m4/b/git-upload-pack');
  assert.deepEqual([t.url, span.attrs['url.full'], span.attrs['http.redirect.count']], ['https://m4/b', 'https://m4/b/git-upload-pack', 1]);
  h.clear();
  await postUp(memoT('https://m4/old', h).value);
  assert.deepEqual(h.lines(), ['POST m4/b/git-upload-pack'], 're-learned');
  // a stale memo whose fresh GET fails: that failure is the answer, and nothing is sent twice
  moves.set('m4/b', { to: 'https://m4/c', all: true });
  const down = { ...h, fetchImpl: async (url, init) => (init.method === 'POST' || !String(url).includes('m4/old') ? h.fetchImpl(url, init) : new Response('down', { status: 503 })) };
  h.clear();
  await assert.rejects(postUp(memoT('https://m4/old', down).value), e => e.code === 'upstream_5xx');
  assert.deepEqual(h.lines(), ['POST m4/b/git-upload-pack']);
  // stale on the GET of an advertise: starts over from the original base
  moves.set('m4/old', { to: 'https://m4/c', all: false });
  await postUp(memoT('https://m4/old', h).value);
  moves.set('m4/c', { to: 'https://m4/d', all: true });
  moves.set('m4/old', { to: 'https://m4/d', all: false });
  h.clear();
  const d = memoT('https://m4/old', h).value;
  assert.equal((await d.advertise(UP, spanOf())).ok, true);
  assert.deepEqual(h.lines(), ['GET m4/c/info/refs', 'GET m4/old/info/refs', 'GET m4/d/info/refs']);
  assert.equal(d.url, 'https://m4/d');
  // a stream is not re-sent: a 3xx answer is the redirect error, and the entry is dropped
  moves.set('m4/d', { to: 'https://m4/e', all: true });
  h.clear();
  const stream = () => ({ stream: new ReadableStream({ start(c) { c.enqueue(Uint8Array.of(0x30, 0x30, 0x30, 0x30)); c.close(); } }), length: 4 });
  await assert.rejects(postUp(memoT('https://m4/old', h).value, stream()), e => e.code === 'http' && e.status === 301 && e.location === 'https://m4/e/git-upload-pack');
  assert.deepEqual(h.lines(), ['POST m4/d/git-upload-pack']);
  moves.set('m4/old', { to: 'https://m4/f', all: false });
  h.clear();
  await postUp(memoT('https://m4/old', h).value);
  assert.deepEqual(h.lines(), ['GET m4/old/info/refs', 'GET m4/f/info/refs', 'POST m4/f/git-upload-pack'], 'dropped');
  // where a stream's 3xx is a network failure (redirect 'error'), the entry is dropped all the same; bytes that fail on
  // the network keep it (a dead link is not a stale memo)
  moves.set('m4/f', { to: 'https://m4/g', all: true });
  const strict = memoHost(moves, { throwOnStreamRedirect: true });
  await assert.rejects(postUp(memoT('https://m4/old', strict).value, stream()), e => e.code === 'network');
  const flaky = { ...strict, fetchImpl: async () => { throw new TypeError('fetch failed'); } };
  moves.set('m4/old', { to: 'https://m4/h', all: false });
  strict.clear();
  await postUp(memoT('https://m4/old', strict).value);
  assert.deepEqual(strict.lines(), ['GET m4/old/info/refs', 'GET m4/h/info/refs', 'POST m4/h/git-upload-pack'], 'dropped');
  await assert.rejects(postUp(memoT('https://m4/old', flaky).value), e => e.code === 'network');
  strict.clear();
  await postUp(memoT('https://m4/old', strict).value);
  assert.deepEqual(strict.lines(), ['POST m4/h/git-upload-pack'], 'kept');
});

test('memo: forgetQuirks forgets one remote or all; the memo is bounded like the quirks memo, least recently used first', async () => {
  const h = memoHost();
  for (const r of ['a', 'b']) await postUp(memoT(`https://m5/${r}`, h).value);
  forgetQuirks('https://m5/a');
  h.clear();
  for (const r of ['a', 'b']) await postUp(memoT(`https://m5/${r}`, h).value);
  assert.deepEqual(h.lines(), ['GET m5/a/info/refs', 'POST m5/a/git-upload-pack', 'POST m5/b/git-upload-pack']);
  forgetQuirks('not a url');
  forgetQuirks();
  h.clear();
  await postUp(memoT('https://m5/b', h).value);
  assert.deepEqual(h.lines(), ['GET m5/b/info/refs', 'POST m5/b/git-upload-pack']);
  // fill to the bound: touching the first keeps it; the second-oldest is the one dropped
  forgetQuirks();
  for (let i = 0; i < QUIRKS_MEMO_MAX; i++) await postUp(memoT(`https://m5/r${i}`, h).value);
  await postUp(memoT('https://m5/r0', h).value);
  await postUp(memoT('https://m5/over', h).value);
  h.clear();
  for (const r of ['r0', 'over', 'r1']) await postUp(memoT(`https://m5/${r}`, h).value);
  assert.deepEqual(h.lines(), ['POST m5/r0/git-upload-pack', 'POST m5/over/git-upload-pack', 'GET m5/r1/info/refs', 'POST m5/r1/git-upload-pack']);
  forgetQuirks();
});
