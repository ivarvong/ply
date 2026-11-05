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
