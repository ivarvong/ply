// #255: the exchange clock. A stall is refused (first byte, idle); a long healthy stream is not cut for its duration;
// requestTimeoutMs is an opt-in whole-exchange cap. Small real timers; every case names the limit that fired.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createTransport } from '../src/http.js';
import { withLimits, DEFAULT_LIMITS } from '../src/limits.js';
import { exchangeClock, watchedUpload, timeoutLimit } from '../src/deadline.js';
import { pushPack } from '../src/receivecaps.js';
import { ZERO_OID } from '../src/push.js';

const te = new TextEncoder();
const RESULT = { 'content-type': 'application/x-git-upload-pack-result' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const spanOf = () => { const attrs = {}; return { attrs, set: a => Object.assign(attrs, a), event() {}, error() {} }; };
const T = { firstByteTimeoutMs: 150, idleTimeoutMs: 150 };

// a body of `n` data frames, one every `gapMs`, then a flush; `stallAfter` frames and then nothing
const dripping = (n, gapMs, stallAfter = Infinity) => {
  let i = 0;
  return new ReadableStream({
    async pull(c) {
      if (i >= stallAfter) { await new Promise(() => {}); return; }
      if (i >= n) { c.enqueue(te.encode('0000')); c.close(); return; }
      if (i > 0) await sleep(gapMs);
      i++; c.enqueue(te.encode('0008abcd'));
    },
  }, { highWaterMark: 0 });
};
// a fetch double that honours the signal: the response after `headersMs`, with `body()` as its body
const answering = (headersMs, body) => (_u, init) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve(new Response(body(init), { status: 200, headers: RESULT })), headersMs);
  init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
});
const drain = async (t, body = new Uint8Array(0), span = spanOf()) => {
  let frames = 0;
  for await (const _ of t.frames('git-upload-pack', body, span, { bypassCache: false })) frames++;
  return { frames, span };
};
const refusal = async (p) => { try { await p; } catch (e) { return e; } assert.fail('expected a refusal'); };

test('defaults: first byte and idle 60 s, no total cap', () => {
  assert.deepEqual([DEFAULT_LIMITS.firstByteTimeoutMs, DEFAULT_LIMITS.idleTimeoutMs, DEFAULT_LIMITS.requestTimeoutMs], [60_000, 60_000, 0]);
});

test('a slow but steady body runs far past every timer and is not cut', async () => {
  // 20 frames 40 ms apart: 760 ms of body, five times each 150 ms timer
  const t = createTransport('https://h/r', { fetchImpl: answering(20, () => dripping(20, 40)), limits: withLimits(T) }).value;
  const t0 = Date.now();
  const { frames, span } = await drain(t);
  assert.equal(frames, 21);
  assert.ok(Date.now() - t0 > 600, `${Date.now() - t0} ms`);
  assert.equal(span.attrs['git.timeout.limit'], undefined);
  assert.deepEqual([span.attrs['git.limits.first_byte_timeout_ms'], span.attrs['git.limits.idle_timeout_ms'], span.attrs['git.limits.request_timeout_ms']], [150, 150, 0]);
});

test('the same body under an opt-in requestTimeoutMs is cut at the total', async () => {
  const t = createTransport('https://h/r', { fetchImpl: answering(20, () => dripping(20, 40)), limits: withLimits({ ...T, requestTimeoutMs: 300 }) }).value;
  const span = spanOf();
  const e = await refusal(drain(t, new Uint8Array(0), span));
  assert.deepEqual([e.code, e.what], ['timeout', 'requestTimeoutMs']);
  assert.match(e.message, /request exceeded 300 ms/);
  assert.deepEqual([span.attrs['git.timeout.limit'], span.attrs['git.timeout.ms']], ['requestTimeoutMs', 300]);
});

test('a body that stalls is refused after the idle timeout, not before', async () => {
  const t = createTransport('https://h/r', { fetchImpl: answering(10, () => dripping(20, 40, 3)), limits: withLimits(T) }).value;
  const t0 = Date.now();
  const span = spanOf();
  const e = await refusal(drain(t, new Uint8Array(0), span));
  const took = Date.now() - t0;
  assert.deepEqual([e.code, e.what], ['timeout', 'idleTimeoutMs']);
  assert.match(e.message, /no bytes moved for 150 ms/);
  assert.ok(took >= 200 && took < 1500, `${took} ms`);
  assert.equal(span.attrs['git.timeout.limit'], 'idleTimeoutMs');
});

test('slow headers are refused by the first-byte timeout', async () => {
  const t = createTransport('https://h/r', { fetchImpl: answering(600, () => dripping(1, 0)), limits: withLimits(T) }).value;
  const t0 = Date.now();
  const e = await refusal(drain(t));
  assert.deepEqual([e.code, e.what], ['timeout', 'firstByteTimeoutMs']);
  assert.ok(Date.now() - t0 < 500);
});

test('an advertisement GET is bounded the same way: slow headers, then a stalled body', async () => {
  const advert = stall => () => new ReadableStream({ async pull(c) { if (stall) await new Promise(() => {}); c.enqueue(te.encode('001e# service=git-upload-pack\n0000')); c.close(); } });
  const fetchImpl = (headersMs, stall) => (_u, init) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response(advert(stall)(), { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } })), headersMs);
    init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
  });
  const slow = await createTransport('https://h/r', { fetchImpl: fetchImpl(600, false), limits: withLimits(T) }).value.advertise('git-upload-pack', spanOf());
  assert.deepEqual([slow.ok, slow.error?.code, slow.error?.what], [false, 'timeout', 'firstByteTimeoutMs']);
  const stalled = await createTransport('https://h/r', { fetchImpl: fetchImpl(10, true), limits: withLimits(T) }).value.advertise('git-upload-pack', spanOf());
  assert.deepEqual([stalled.ok, stalled.error?.code, stalled.error?.what], [false, 'timeout', 'idleTimeoutMs']);
  const fine = await createTransport('https://h/r', { fetchImpl: fetchImpl(10, false), limits: withLimits(T) }).value.advertise('git-upload-pack', spanOf());
  assert.equal(fine.ok, true);
});

// a fetch double that reads the request body as a server would, then answers `afterMs` after the body ends
const reading = (afterMs, seen = {}) => (_u, init) => new Promise((resolve, reject) => {
  init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  (async () => {
    const reader = init.body.getReader();
    let bytes = 0;
    for (;;) { const r = await reader.read(); if (r.done) break; bytes += r.value.length; }
    seen.bytes = bytes;
    await sleep(afterMs);
    resolve(new Response(dripping(1, 0), { status: 200, headers: RESULT }));
  })().catch(reject);
});
// an upload of `n` chunks `gapMs` apart; `stallAfter` chunks and then nothing
const uploading = (n, gapMs, stallAfter = Infinity) => {
  let i = 0;
  return new ReadableStream({
    async pull(c) {
      if (i >= stallAfter) { await new Promise(() => {}); return; }
      if (i >= n) { c.close(); return; }
      if (i > 0) await sleep(gapMs);
      i++; c.enqueue(new Uint8Array(1024));
    },
  }, { highWaterMark: 0 });
};

test('a long steady upload passes; the first-byte wait starts when the upload ends', async () => {
  // 12 chunks 40 ms apart (440 ms of upload), then the server answers 100 ms later: under 150 ms from the upload's end
  const seen = {};
  const t = createTransport('https://h/r', { fetchImpl: reading(100, seen), limits: withLimits(T) }).value;
  const { frames } = await drain(t, { stream: uploading(12, 40), length: 12 * 1024 });
  assert.deepEqual([frames, seen.bytes], [2, 12 * 1024]);
});

test('a stalled upload is refused by the idle timeout', async () => {
  const t = createTransport('https://h/r', { fetchImpl: reading(0), limits: withLimits(T) }).value;
  const t0 = Date.now();
  const e = await refusal(drain(t, { stream: uploading(12, 10, 2), length: 12 * 1024 }));
  assert.deepEqual([e.code, e.what], ['timeout', 'idleTimeoutMs']);
  assert.ok(Date.now() - t0 < 1500);
});

test('pushPack: a pack stream that stalls mid-upload ends at the idle timeout, as the ambiguous push it is', async () => {
  const t = createTransport('https://h/r', { fetchImpl: reading(0), limits: withLimits({ ...T, maxPackBytes: 1 << 20 }) }).value;
  const t0 = Date.now();
  const r = await pushPack(t, { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: 'a'.repeat(40), pack: uploading(64, 5, 4), length: 64 * 1024 });
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
  const chain = [r.error, r.error.original, r.error.cause].filter(Boolean);
  assert.ok(chain.some(e => e.code === 'timeout' || e === 'timeout') || /idleTimeoutMs/.test(r.error.message), JSON.stringify({ code: r.error.code, original: r.error.original, message: r.error.message }));
});

test('the caller signal aborts as aborted, not timeout', async () => {
  const ac = new AbortController();
  const t = createTransport('https://h/r', { fetchImpl: answering(10, () => dripping(50, 40)), limits: withLimits(T), signal: ac.signal }).value;
  setTimeout(() => ac.abort(), 120);
  const e = await refusal(drain(t));
  assert.equal(e.code, 'aborted');
  assert.equal(e.what, undefined);
});

test('0 turns a timer off: a stalled body with idle 0 runs until the opt-in total', async () => {
  const t = createTransport('https://h/r', { fetchImpl: answering(10, () => dripping(20, 40, 2)), limits: withLimits({ firstByteTimeoutMs: 150, idleTimeoutMs: 0, requestTimeoutMs: 400 }) }).value;
  const t0 = Date.now();
  const e = await refusal(drain(t));
  assert.deepEqual([e.code, e.what], ['timeout', 'requestTimeoutMs']);
  assert.ok(Date.now() - t0 >= 350);
});

test('exchangeClock: progress while waiting for headers does not extend the first-byte wait; cancel fires nothing', async () => {
  let fired = null;
  const c = exchangeClock({ firstByteMs: 80, idleMs: 1000, totalMs: 0 }, null, k => { fired = k; });
  const iv = setInterval(() => c.progress(), 10);
  await sleep(200);
  clearInterval(iv);
  assert.equal(fired, 'firstByteTimeoutMs');
  assert.equal(timeoutLimit(c.signal.reason), 'firstByteTimeoutMs');
  assert.equal(c.signal.reason.name, 'TimeoutError');
  const d = exchangeClock({ firstByteMs: 40, idleMs: 40, totalMs: 40 }, null, () => { fired = 'late'; });
  d.cancel();
  await sleep(100);
  assert.equal(d.signal.aborted, false);
  assert.notEqual(fired, 'late');
});

test('exchangeClock: idle progress re-arms; the body phase fires only after a real gap', async () => {
  let fired = null;
  const c = exchangeClock({ firstByteMs: 50, idleMs: 60, totalMs: 0 }, null, k => { fired = k; });
  c.phase('body');
  for (let i = 0; i < 8; i++) { await sleep(30); c.progress(); }
  assert.equal(fired, null);
  await sleep(150);
  assert.equal(fired, 'idleTimeoutMs');
});

test('watchedUpload: no buffer of its own, the source locked only from the first pull, cancel reaches the source', async () => {
  const c = exchangeClock({ firstByteMs: 0, idleMs: 0, totalMs: 0 }, null, () => {});
  let pulls = 0, cancelled = null;
  const source = new ReadableStream({ pull(ctl) { pulls++; ctl.enqueue(new Uint8Array(1)); }, cancel(r) { cancelled = r; } }, { highWaterMark: 0 });
  const w = watchedUpload(source, c);
  await sleep(20);
  assert.deepEqual([pulls, source.locked], [0, false]);
  const reader = w.getReader();
  await reader.read();
  assert.equal(source.locked, true);
  await reader.cancel('stop');
  assert.equal(cancelled, 'stop');
  const untouched = new ReadableStream({ cancel(r) { cancelled = `untouched:${r}`; } });
  await watchedUpload(untouched, c).cancel('x');
  assert.equal(cancelled, 'untouched:x');
});
