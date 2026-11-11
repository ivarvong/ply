// The exchange clock through the transport, on a fake clock (vitest's timers: setTimeout and Date.now; no real sleeps).
// Every expectation is worked out by hand from the rules: time is charged only while ply waits on the network; headers
// seen means the first byte is satisfied for good; upload progress is bytes moved.
import { test, vi, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { createTransport } from '../src/http.js';
import { withLimits } from '../src/limits.js';

const te = new TextEncoder();
const RESULT = { 'content-type': 'application/x-git-upload-pack-result' };
const spanOf = () => { const attrs = {}; return { attrs, set: a => Object.assign(attrs, a), event() {}, error() {} }; };
const T = { firstByteTimeoutMs: 300, idleTimeoutMs: 300 };
const advance = ms => vi.advanceTimersByTimeAsync(ms);
// a stream the test feeds by hand
const manual = () => { let ctl; const stream = new ReadableStream({ start(c) { ctl = c; } }); const quiet = f => { try { f(); } catch { /* the transport cancelled it: the outcome says so */ } };
  return { stream, push: b => quiet(() => ctl.enqueue(b)), close: () => quiet(() => ctl.close()) }; };
// the outcome of draining frames, never a rejection: { frames } or { frames, error }
const drain = async (t, body = new Uint8Array(0), each = async () => {}) => {
  let frames = 0;
  try { for await (const _ of t.frames('git-upload-pack', body, spanOf(), { bypassCache: false })) { frames++; await each(frames); } } catch (error) { return { frames, error }; }
  return { frames };
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

// a server that answers its headers at once (as git http-backend does) while it is still reading the request body
const earlyHeaders = (response) => (_u, init) => {
  (async () => { const rd = init.body.getReader(); for (;;) { const r = await rd.read(); if (r.done) break; } })().catch(() => {});
  init.signal.addEventListener('abort', () => { /* the body read is cut by the transport */ }, { once: true });
  return Promise.resolve(new Response(response.stream, { status: 200, headers: RESULT }));
};

test('an upload that ends after the response headers does not put the clock back into the first-byte wait', async () => {
  const upload = manual(), response = manual();
  const t = createTransport('https://h/r', { fetchImpl: earlyHeaders(response), limits: withLimits(T) }).value;
  const run = drain(t, { stream: upload.stream, length: 2048 });
  await advance(0);
  upload.push(new Uint8Array(1024)); await advance(50);
  upload.push(new Uint8Array(1024)); upload.close(); await advance(50);
  // 20 frames 100 ms apart: 2000 ms after the upload's end, nearly seven first-byte timeouts, and no gap over 100 ms.
  // By the rules (headers seen, bytes moving every 100 ms < idle 300) nothing may fire.
  for (let i = 0; i < 20; i++) { response.push(te.encode('0008abcd')); await advance(100); }
  response.push(te.encode('0000')); response.close();
  await advance(0);
  assert.deepEqual(await run, { frames: 21 });
});

test('after such an upload a body that then stalls ends at the idle timeout, named as idle', async () => {
  const upload = manual(), response = manual();
  const t = createTransport('https://h/r', { fetchImpl: earlyHeaders(response), limits: withLimits(T) }).value;
  const run = drain(t, { stream: upload.stream, length: 1024 });
  await advance(0);
  upload.push(new Uint8Array(1024)); upload.close(); await advance(50);
  for (let i = 0; i < 5; i++) { response.push(te.encode('0008abcd')); await advance(100); }
  // the last frame arrived at 450 ms, taken at once; 100 ms have passed. Silence until 300 ms after it: 200 ms more.
  await advance(199);
  const still = await Promise.race([run, Promise.resolve('running')]);
  assert.equal(still, 'running');
  await advance(2);
  const r = await run;
  assert.deepEqual([r.frames, r.error?.code, r.error?.what], [5, 'timeout', 'idleTimeoutMs']);
});

test('a consumer that holds each frame for three idle timeouts gets a complete response and no timeout', async () => {
  // the whole answer is there at once: three data frames and the flush, one chunk each
  const whole = () => new ReadableStream({ start(c) { for (const f of ['0008abcd', '0008abcd', '0008abcd', '0000']) c.enqueue(te.encode(f)); c.close(); } });
  const t = createTransport('https://h/r', { fetchImpl: () => Promise.resolve(new Response(whole(), { status: 200, headers: RESULT })), limits: withLimits(T) }).value;
  // 900 ms per frame is the consumer's time, not the server's silence: 4 frames, no error
  assert.deepEqual(await drain(t, new Uint8Array(0), () => advance(900)), { frames: 4 });
});

test('a server that stalls while a slow consumer is waiting for the next chunk is still cut, idle counted from the ask', async () => {
  const response = manual();
  const t = createTransport('https://h/r', { fetchImpl: () => Promise.resolve(new Response(response.stream, { status: 200, headers: RESULT })), limits: withLimits(T) }).value;
  response.push(te.encode('0008abcd'));
  // the consumer holds the one frame 900 ms (three idle timeouts, not charged) and asks again at 900; nothing comes:
  // the cut is 300 ms after the ask, at 1200, and not a millisecond before
  const run = drain(t, new Uint8Array(0), () => new Promise(res => setTimeout(res, 900)));
  await advance(900);
  await advance(299);
  assert.equal(await Promise.race([run, Promise.resolve('running')]), 'running');
  await advance(2);
  const r = await run;
  assert.deepEqual([r.frames, r.error?.code, r.error?.what], [1, 'timeout', 'idleTimeoutMs']);
});

test('a server that never answers is cut at the first-byte timeout', async () => {
  const never = (_u, init) => new Promise((_res, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }); });
  const t = createTransport('https://h/r', { fetchImpl: never, limits: withLimits(T) }).value;
  const run = drain(t);
  await advance(299);
  assert.equal(await Promise.race([run, Promise.resolve('running')]), 'running');
  await advance(2);
  const r = await run;
  assert.deepEqual([r.frames, r.error?.code, r.error?.what], [0, 'timeout', 'firstByteTimeoutMs']);
});

test('one 4 MiB upload chunk on a slow, steady link is progress in bytes, not one mark per chunk', async () => {
  // The link drains 64 KiB every 25 ms and never stops: 4 MiB takes 64 * 25 = 1600 ms, over five idle timeouts, with
  // no gap in byte movement longer than 25 ms. It must be sent whole and answered.
  const seen = { bytes: 0 };
  const slowLink = (_u, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    (async () => {
      const rd = init.body.getReader();
      for (;;) {
        const r = await rd.read();
        if (r.done) break;
        seen.bytes += r.value.length;
        await new Promise(res => setTimeout(res, 25 * Math.ceil(r.value.length / 65536)));
      }
      resolve(new Response(new ReadableStream({ start(c) { c.enqueue(te.encode('0000')); c.close(); } }), { status: 200, headers: RESULT }));
    })().catch(reject);
  });
  const t = createTransport('https://h/r', { fetchImpl: slowLink, limits: withLimits(T) }).value;
  const one = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4 << 20)); c.close(); } });
  const run = drain(t, { stream: one, length: 4 << 20 });
  await advance(1700);
  const r = await run;
  assert.deepEqual([r.frames, r.error?.what, seen.bytes], [1, undefined, 4 << 20]);
});
