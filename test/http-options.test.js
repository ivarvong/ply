// HttpOptions are parsed once (#156): parseHttpOptions makes every check the transport makes of its options, and the
// transport reads only the settings. The two limits it reads on every request (requestTimeoutMs, maxPackBytes) are
// read there: a bad one is now refused when the transport is made, with no request, and is the same bad_request a
// request used to fail with. Every refusal keeps its order (the limits come last).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createTransport, parseHttpOptions } from '../src/http.js';
import { GitHttp } from '../src/client.js';
import { readFile } from '../src/read.js';
import { DEFAULT_LIMITS, withLimits } from '../src/limits.js';

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
  // a limits record missing one of them reads it as missing (got: the missing value)
  const partial = createTransport('https://h/r.git', { limits: { ...DEFAULT_LIMITS, requestTimeoutMs: null } });
  assert.deepEqual([partial.error.code, partial.error.what], ['bad_request', 'requestTimeoutMs']);
});

test('the limits come after every other refusal, as the first request used to', () => {
  const bad = withLimits({ requestTimeoutMs: NaN });
  assert.equal(createTransport('https://h/r', { followRedirects: 'always', limits: bad }).error.what, 'followRedirects');
  assert.equal(createTransport('https://h/r', { userAgent: 'a\nb', limits: bad }).error.message.startsWith('invalid user agent'), true);
  assert.equal(createTransport('https://h/r', { recordResponseHeaders: ['a b'], limits: bad }).error.what, 'recordResponseHeaders');
  assert.equal(createTransport('not a url', { limits: bad }).error.what, 'url');
  assert.equal(createTransport('https://h/r', { auth: { user: 'u' }, limits: bad }).error.what, 'auth');
  assert.equal(createTransport('https://h/r', { allowUrl: () => ({ ok: false, error: { code: 'bad_request', what: 'mine' } }), limits: bad }).error.what, 'mine');
  // requestTimeoutMs before maxPackBytes
  assert.equal(createTransport('https://h/r', { limits: withLimits({ requestTimeoutMs: NaN, maxPackBytes: NaN }) }).error.what, 'requestTimeoutMs');
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
