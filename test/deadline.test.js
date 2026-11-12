// #255: the exchange clock. A stall is refused (first byte, idle); a long healthy stream is not cut for its duration;
// requestTimeoutMs is an opt-in whole-exchange cap. Small real timers; every case names the limit that fired.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createTransport } from '../src/http.js';
import { withLimits, DEFAULT_LIMITS } from '../src/limits.js';
import { exchangeClock, watchedUpload, timeoutLimit, transition, deadlineOf } from '../src/deadline.js';
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
  assert.deepEqual([DEFAULT_LIMITS.firstByteTimeoutMs, DEFAULT_LIMITS.idleTimeoutMs, DEFAULT_LIMITS.heldTimeoutMs, DEFAULT_LIMITS.requestTimeoutMs], [60_000, 60_000, 240_000, 0]);
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

test('a request body whose source stops producing is refused as idleTimeoutMs: no more pieces reach the platform', async () => {
  const t = createTransport('https://h/r', { fetchImpl: reading(0), limits: withLimits(T) }).value;
  const t0 = Date.now();
  const e = await refusal(drain(t, { stream: uploading(12, 10, 2), length: 12 * 1024 }));
  assert.deepEqual([e.code, e.what], ['timeout', 'idleTimeoutMs']);
  assert.ok(Date.now() - t0 < 1500);
});

test('pushPack: a pack stream that stops producing partway ends as idleTimeoutMs, as the ambiguous push it is', async () => {
  const t = createTransport('https://h/r', { fetchImpl: reading(0), limits: withLimits({ ...T, maxPackBytes: 1 << 20 }) }).value;
  const t0 = Date.now();
  const r = await pushPack(t, { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: 'a'.repeat(40), pack: uploading(64, 5, 4), length: 64 * 1024 });
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
  // the pack was partly sent: the server may have applied it, so the outcome is ambiguous, never the retryable `timeout`
  assert.deepEqual([r.error.code, r.error.original, r.error.cause?.code, r.error.cause?.what], ['ambiguous', 'timeout', 'timeout', 'idleTimeoutMs']);
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
  const c = exchangeClock({ firstByteMs: 80, idleMs: 1000, heldMs: 0, totalMs: 0 }, null, k => { fired = k; });
  const iv = setInterval(() => c.feed('upload_bytes'), 10);
  await sleep(200);
  clearInterval(iv);
  assert.equal(fired, 'firstByteTimeoutMs');
  assert.equal(timeoutLimit(c.signal.reason), 'firstByteTimeoutMs');
  assert.equal(c.signal.reason.name, 'TimeoutError');
  const d = exchangeClock({ firstByteMs: 40, idleMs: 40, heldMs: 0, totalMs: 40 }, null, () => { fired = 'late'; });
  d.cancel();
  await sleep(100);
  assert.equal(d.signal.aborted, false);
  assert.notEqual(fired, 'late');
});

test('exchangeClock: idle progress re-arms; the body phase fires only after a real gap', async () => {
  let fired = null;
  const c = exchangeClock({ firstByteMs: 50, idleMs: 60, heldMs: 0, totalMs: 0 }, null, k => { fired = k; });
  c.feed('headers');
  for (let i = 0; i < 8; i++) { await sleep(30); c.feed('body_chunk'); }
  assert.equal(fired, null);
  await sleep(150);
  assert.equal(fired, 'idleTimeoutMs');
});

test('watchedUpload: no buffer of its own, the source locked only from the first pull, cancel reaches the source', async () => {
  const c = exchangeClock({ firstByteMs: 0, idleMs: 0, heldMs: 0, totalMs: 0 }, null, () => {});
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

// The machine, every state and event pair. Written by hand from the rules, not from the code:
//   - nothing moves a state backwards; an event a state has no use for leaves it as it is
//   - headers seen (from any state before them) is `streaming`: the first byte is satisfied for good
//   - `restart` (the wait starts again) only on network progress: the request sent again, upload bytes while uploading
//     or streaming, the upload's end before the headers, the headers, a body chunk, the consumer asking for more
//   - consumer_took parks the clock (`held`) without a restart: the hold runs from the last network mark (#273 review);
//     only consumer_asked resumes it; `ended` and `done` are final
const STATES = ['connecting', 'uploading', 'awaiting_first_byte', 'streaming', 'held', 'done'];
const EVENTS = ['request_sent', 'upload_started', 'upload_bytes', 'upload_ended', 'headers', 'body_chunk', 'consumer_took', 'consumer_asked', 'ended'];
// next state per event, in EVENTS order; a trailing `!` is a restart
const TABLE = {
  connecting: ['connecting!', 'uploading!', 'connecting', 'connecting', 'streaming!', 'connecting', 'connecting', 'connecting', 'done'],
  uploading: ['uploading', 'uploading', 'uploading!', 'awaiting_first_byte!', 'streaming!', 'uploading', 'uploading', 'uploading', 'done'],
  awaiting_first_byte: ['awaiting_first_byte', 'awaiting_first_byte', 'awaiting_first_byte', 'awaiting_first_byte', 'streaming!', 'awaiting_first_byte', 'awaiting_first_byte', 'awaiting_first_byte', 'done'],
  streaming: ['streaming', 'streaming', 'streaming!', 'streaming', 'streaming', 'streaming!', 'held', 'streaming', 'done'],
  held: ['held', 'held', 'held', 'held', 'held', 'held', 'held', 'streaming!', 'done'],
  done: ['done', 'done', 'done', 'done', 'done', 'done', 'done', 'done', 'done'],
};
test('transition: every state and event pair', () => {
  assert.deepEqual(Object.keys(TABLE), STATES);
  for (const state of STATES) {
    assert.equal(TABLE[state].length, EVENTS.length);
    EVENTS.forEach((event, i) => {
      const want = TABLE[state][i];
      assert.deepEqual(transition(state, event), { state: want.replace('!', ''), restart: want.endsWith('!') }, `${state} + ${event}`);
    });
  }
});

test('transition: no event moves a state backwards', () => {
  // the order of an exchange; `streaming` and `held` alternate, so they share a rank
  const rank = { connecting: 0, uploading: 1, awaiting_first_byte: 2, streaming: 3, held: 3, done: 4 };
  for (const state of STATES) for (const event of EVENTS) assert.ok(rank[transition(state, event).state] >= rank[state], `${state} + ${event}`);
});

test('deadlineOf: first byte before the headers, idle while on the network, nothing while held, the total throughout', () => {
  const t = { firstByteMs: 100, idleMs: 20, heldMs: 0, totalMs: 0 };
  // mark 1000, start 400: the step deadline is mark + its limit
  const at = state => { const d = deadlineOf(state, 1000, 400, t); return d === null ? null : [d.key, d.at, d.ms]; };
  assert.deepEqual(STATES.map(at), [['firstByteTimeoutMs', 1100, 100], ['idleTimeoutMs', 1020, 20], ['firstByteTimeoutMs', 1100, 100], ['idleTimeoutMs', 1020, 20], null, null]);
  // an opt-in total of 650 from start 400 is 1050: earlier than the first-byte wait, later than the idle one, and the
  // only limit while the consumer holds a chunk
  const capped = state => { const d = deadlineOf(state, 1000, 400, { ...t, totalMs: 650 }); return d === null ? null : [d.key, d.at]; };
  assert.deepEqual(STATES.map(capped), [['requestTimeoutMs', 1050], ['idleTimeoutMs', 1020], ['requestTimeoutMs', 1050], ['idleTimeoutMs', 1020], ['requestTimeoutMs', 1050], null]);
  // 0 turns a limit off
  assert.equal(deadlineOf('streaming', 1000, 400, { firstByteMs: 100, idleMs: 0, heldMs: 0, totalMs: 0 }), null);
  // #273: while held, the hold runs from the take (the mark): mark + held, unless the total is earlier
  assert.deepEqual(capped('held') && [deadlineOf('held', 1000, 400, { ...t, heldMs: 30 }).key, deadlineOf('held', 1000, 400, { ...t, heldMs: 30 }).at], ['heldTimeoutMs', 1030]);
  assert.equal(deadlineOf('held', 1000, 400, { ...t, heldMs: 30, totalMs: 620 }).key, 'requestTimeoutMs');
});

// The hot loop (#255 review, R2). One timer is left pending: past the headers a deadline only moves later, so the
// pending timer is early enough and re-arms for what is left when it fires. The expected count is the rule's: zero
// timer calls per chunk (main ec337c5 made none either), whatever the limits.
const countingTimers = async run => {
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  const calls = { set: 0, clear: 0 };
  globalThis.setTimeout = (...a) => { calls.set++; return realSet(...a); };
  globalThis.clearTimeout = (...a) => { calls.clear++; return realClear(...a); };
  try { await run(calls); } finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; }
};
test('a consumer that keeps up costs no setTimeout and no clearTimeout per body chunk', async () => {
  await countingTimers(calls => {
    for (const totalMs of [0, 120_000]) {
      const c = exchangeClock({ firstByteMs: 60_000, idleMs: 60_000, heldMs: 240_000, totalMs }, null, () => {});
      c.feed('headers');
      calls.set = 0; calls.clear = 0;
      for (let i = 0; i < 1000; i++) { c.feed('body_chunk'); c.feed('consumer_took'); c.feed('consumer_asked'); }
      assert.deepEqual([totalMs, calls.set, calls.clear], [totalMs, 0, 0]);
      c.cancel();
    }
  });
});
test('frames() makes the same number of timer calls for 10 body chunks as for 1000', async () => {
  const fetchOf = n => () => { let i = 0; return Promise.resolve(new Response(new ReadableStream({ pull(c) { if (i++ === n) { c.enqueue(te.encode('0000')); c.close(); return; } c.enqueue(te.encode('0008abcd')); } }, { highWaterMark: 0 }), { status: 200, headers: RESULT })); };
  const timerCalls = async n => {
    const seen = { set: 0, clear: 0, frames: 0 };
    await countingTimers(async calls => {
      const t = createTransport('https://h/r', { fetchImpl: fetchOf(n) }).value;
      for await (const _ of t.frames('git-upload-pack', new Uint8Array(4), spanOf(), { bypassCache: false })) seen.frames++;
      seen.set = calls.set; seen.clear = calls.clear;
    });
    return seen;
  };
  const few = await timerCalls(10), many = await timerCalls(1000);
  assert.deepEqual([few.frames, many.frames], [11, 1001]);
  assert.deepEqual([many.set, many.clear], [few.set, few.clear]);
});

// A manual scheduler (#255 re-review, REQ 1): setTimeout, clearTimeout and Date.now are replaced and time moves only in
// `advance`, so nothing sleeps and every fire time is exact.
const manualTimers = async run => {
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout, realNow = Date.now;
  let T = 0;
  const q = new Map();
  globalThis.setTimeout = (fn, ms) => { const id = { unref() {} }; q.set(id, { at: T + (ms ?? 0), fn }); return id; };
  globalThis.clearTimeout = id => { q.delete(id); };
  Date.now = () => T;
  // run every timer due by `to`, earliest first, each at its own time
  const advance = to => {
    for (;;) {
      let best = null;
      for (const e of q) if (e[1].at <= to && (best === null || e[1].at < best[1].at)) best = e;
      if (best === null) break;
      q.delete(best[0]); T = Math.max(T, best[1].at); best[1].fn();
    }
    T = to;
  };
  try { await run({ advance, time: () => T, pending: () => q.size }); } finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; Date.now = realNow; }
};
// Expected times are the documented rule worked by hand, not read from the clock: idleTimeoutMs is the longest wait on
// the network with no progress, and the wait starts again when the consumer asks. So after an ask at A with no further
// bytes the cut is at A + idle, named idleTimeoutMs, unless start + requestTimeoutMs is earlier; a consumer that never
// asks is cut only at start + requestTimeoutMs.
test('exchangeClock: with requestTimeoutMs set, the idle limit survives a timer that fires while the consumer holds a chunk', async () => {
  await manualTimers(({ advance, time }) => {
    const run = (t, script) => {
      const t0 = time();
      let fired = 'none';
      const c = exchangeClock(t, null, key => { fired = `${key}@${time() - t0}`; });
      script(c, ms => { advance(t0 + ms); });
      c.cancel();
      return fired;
    };
    const capped = { firstByteMs: 1000, idleMs: 1000, heldMs: 0, totalMs: 100_000 };
    // headers at 10, a chunk taken at 20; the timer set for 10 + 1000 fires while the consumer holds; ask at 1500, then
    // silence: 1500 + 1000
    assert.equal(run(capped, (c, at) => { at(10); c.feed('headers'); at(20); c.feed('body_chunk'); c.feed('consumer_took'); at(1500); c.feed('consumer_asked'); at(200_000); }), 'idleTimeoutMs@2500');
    // five holds of 1490 ms, each across a firing, each followed by 10 ms on the network; the last ask is at
    // 10 + 4 * 1500 + 1490 = 7500, then silence: 7500 + 1000
    assert.equal(run(capped, (c, at) => {
      at(10); c.feed('headers');
      for (let i = 0; i < 5; i++) { c.feed('consumer_took'); at(10 + i * 1500 + 1490); c.feed('consumer_asked'); at(10 + (i + 1) * 1500); }
      at(200_000);
    }), 'idleTimeoutMs@8500');
    // the total cap is earlier than ask + idle (1500 + 1000): the cap fires, at its own time
    assert.equal(run({ ...capped, totalMs: 2000 }, (c, at) => { at(10); c.feed('headers'); at(20); c.feed('consumer_took'); at(1500); c.feed('consumer_asked'); at(200_000); }), 'requestTimeoutMs@2000');
    // a consumer that never asks again is not charged idle time: only the total cap bounds it
    assert.equal(run({ ...capped, totalMs: 5000 }, (c, at) => { at(10); c.feed('headers'); at(20); c.feed('consumer_took'); at(200_000); }), 'requestTimeoutMs@5000');
  });
});
// What README Limits and SAFETY.md I1 say about a held chunk (re-review REQ 3): a timer may still be pending, but with
// no total cap it cuts nothing, and once it has fired it is not set again until the consumer asks.
test('exchangeClock: with heldTimeoutMs 0, while the consumer holds a chunk a timer may be pending, and without requestTimeoutMs it cuts nothing', async () => {
  await manualTimers(({ advance, pending }) => {
    let fired = 'none';
    const c = exchangeClock({ firstByteMs: 60_000, idleMs: 60_000, heldMs: 0, totalMs: 0 }, null, key => { fired = key; });
    advance(10); c.feed('headers'); advance(20); c.feed('body_chunk'); c.feed('consumer_took');
    // the one timer, set before the consumer took the chunk
    assert.equal(pending(), 1);
    // a day later the consumer still holds the chunk: nothing was cut, and the timer that fired was not set again
    advance(86_400_000);
    assert.deepEqual([fired, c.signal.aborted, pending()], ['none', false, 0]);
    // the ask puts ply back on the network: the idle wait runs from here (86 400 000 + 60 000)
    c.feed('consumer_asked');
    assert.equal(pending(), 1);
    advance(86_459_999);
    assert.equal(fired, 'none');
    advance(86_460_000);
    assert.equal(fired, 'idleTimeoutMs');
  });
});
test('frames(): with requestTimeoutMs set, a server that stalls after the consumer held a frame across a timer firing is cut at ask + idle', async () => {
  await manualTimers(async ({ advance, time }) => {
    // the server: one frame at once, then silence
    let pulls = 0;
    const body = new ReadableStream({ pull(c) { if (pulls++ === 0) { c.enqueue(te.encode('0008abcd')); return undefined; } return new Promise(() => {}); } }, { highWaterMark: 0 });
    const t = createTransport('https://h/r', { fetchImpl: () => Promise.resolve(new Response(body, { status: 200, headers: RESULT })), limits: withLimits({ firstByteTimeoutMs: 300, idleTimeoutMs: 300, requestTimeoutMs: 6000 }) }).value;
    let firedAt = null;
    const attrs = {};
    const span = { attrs, set: a => { if ('git.timeout.limit' in a) firedAt = time(); Object.assign(attrs, a); }, event() {}, error() {} };
    const frames = t.frames('git-upload-pack', new Uint8Array(4), span, { bypassCache: false })[Symbol.asyncIterator]();
    // everything up to the first frame happens at time 0; the consumer then holds it for 700 ms, across the timer set
    // for 0 + 300
    assert.equal((await frames.next()).done, false);
    advance(700);
    assert.equal(firedAt, null, 'the consumer is not charged idle time');
    // the ask, at 700: the server has 300 ms from here, so the cut is at 1000 (the total cap is 6000)
    const next = refusal(frames.next());
    await new Promise(r => setImmediate(r));
    advance(999);
    assert.equal(firedAt, null);
    advance(200_000);
    const e = await next;
    assert.deepEqual([firedAt, e.code, e.what, attrs['git.timeout.limit']], [1000, 'timeout', 'idleTimeoutMs', 'idleTimeoutMs']);
  });
});
// #273 (option B): a consumer that holds a chunk is bounded by limits.heldTimeoutMs, apart from network idle. Expected
// values are the issue's contract worked by hand: the held wait starts when the consumer takes the chunk (time 0 here)
// and the cut is at take + heldTimeoutMs, named heldTimeoutMs, with the upstream body cancelled; a hold just under it
// is not cut; while held, idleTimeoutMs (300, shorter than the hold) is never charged.
test('defaults: heldTimeoutMs is 4 x the idle default (README Limits)', () => {
  assert.equal(DEFAULT_LIMITS.heldTimeoutMs, 240_000);
});
test('frames(): a consumer that holds a chunk past heldTimeoutMs is cut as timeout/heldTimeoutMs and the upstream is cancelled; just under is not cut', async () => {
  await manualTimers(async ({ advance, time }) => {
    const exchange = () => {
      let pulls = 0, cancelled = null;
      const body = new ReadableStream({ pull(c) { pulls++; c.enqueue(te.encode('0008abcd')); }, cancel(r) { cancelled = r ?? 'cancelled'; } }, { highWaterMark: 0 });
      const t = createTransport('https://h/r', { fetchImpl: () => Promise.resolve(new Response(body, { status: 200, headers: RESULT })), limits: withLimits({ firstByteTimeoutMs: 300, idleTimeoutMs: 300, heldTimeoutMs: 1000 }) }).value;
      const attrs = {};
      let firedAt = null;
      const span = { attrs, set: a => { if ('git.timeout.limit' in a) firedAt = time(); Object.assign(attrs, a); }, event() {}, error() {} };
      return { frames: t.frames('git-upload-pack', new Uint8Array(4), span, { bypassCache: false })[Symbol.asyncIterator](), attrs, fired: () => firedAt, cancelled: () => cancelled, pulls: () => pulls };
    };
    // held just under: 999 ms (three idle limits long), then the ask is served: not cut
    const a = exchange();
    const t0 = time();
    assert.equal((await a.frames.next()).done, false);
    advance(t0 + 999);
    assert.equal(a.fired(), null, 'network idle is not charged while held, and 999 < heldTimeoutMs');
    assert.equal((await a.frames.next()).done, false);
    assert.equal(a.fired(), null);
    await a.frames.return();
    // held past it: cut at take + 1000
    const b = exchange();
    const t1 = time();
    assert.equal((await b.frames.next()).done, false);
    advance(t1 + 999);
    assert.equal(b.fired(), null);
    advance(t1 + 1000);
    assert.equal(b.fired(), t1 + 1000);
    await new Promise(r => setImmediate(r));
    assert.notEqual(b.cancelled(), null, 'the upstream body is cancelled when the hold is cut');
    const e = await refusal(b.frames.next());
    assert.deepEqual([e.code, e.what, b.attrs['git.timeout.limit']], ['timeout', 'heldTimeoutMs', 'heldTimeoutMs']);
    // the span names the hold limit beside its siblings (README Limits), and the message says what was held and for how long
    assert.equal(b.attrs['git.limits.held_timeout_ms'], 1000);
    assert.match(e.message, /held a chunk for 1000 ms .*limits\.heldTimeoutMs/);
  });
});
test('exchangeClock: heldTimeoutMs runs from the last network mark before the take and stops at consumer_asked; 0 turns it off', async () => {
  await manualTimers(({ advance, time }) => {
    const run = (t, script) => {
      const t0 = time();
      let fired = 'none';
      const c = exchangeClock(t, null, key => { fired = `${key}@${time() - t0}`; });
      script(c, ms => { advance(t0 + ms); });
      c.cancel();
      return fired;
    };
    const lim = { firstByteMs: 1000, idleMs: 1000, heldMs: 4000, totalMs: 0 };
    // took at 20, never asks: 20 + 4000
    assert.equal(run(lim, (c, at) => { at(10); c.feed('headers'); at(20); c.feed('body_chunk'); c.feed('consumer_took'); at(200_000); }), 'heldTimeoutMs@4020');
    // held 3990 each time, five times, the network answering at once: never cut; then silence after the last ask at
    // 10 + 5 * 3990 = 19960: idle at 19960 + 1000
    assert.equal(run(lim, (c, at) => {
      at(10); c.feed('headers');
      for (let i = 1; i <= 5; i++) { c.feed('body_chunk'); c.feed('consumer_took'); at(10 + i * 3990); c.feed('consumer_asked'); }
      at(200_000);
    }), 'idleTimeoutMs@20960');
    // held shorter than idle: the held limit is earlier than the pending idle timer and still fires on time. The take
    // at 20 reads no clock: the hold runs from the last network mark (the headers at 10), so 10 + 200, a delivery time
    // (10 ms) early, as README Limits states
    assert.equal(run({ ...lim, heldMs: 200 }, (c, at) => { at(10); c.feed('headers'); at(20); c.feed('consumer_took'); at(200_000); }), 'heldTimeoutMs@210');
    // 0 turns it off: only the total cap bounds the hold
    assert.equal(run({ ...lim, heldMs: 0, totalMs: 9000 }, (c, at) => { at(10); c.feed('headers'); at(20); c.feed('consumer_took'); at(200_000); }), 'requestTimeoutMs@9000');
  });
});
// #273 review (owner decision): the hold adds no clock read per chunk. A chunk's cycle in frames() is consumer_took then
// consumer_asked; on main (8e3939db) that is one Date.now (the ask's restart), and it must stay one: the hold runs from
// the mark the clock already took (the ask, or the headers for the first chunk), not from a new read at the take.
test('exchangeClock: a chunk (consumer_took + consumer_asked) reads the clock once, as on main', () => {
  let reads = 0;
  const c = exchangeClock({ firstByteMs: 60_000, idleMs: 60_000, heldMs: 240_000, totalMs: 0 }, null, () => {}, () => { reads++; return 0; });
  c.feed('headers');
  const before = reads;
  for (let i = 0; i < 1000; i++) { c.feed('consumer_took'); c.feed('consumer_asked'); }
  c.cancel();
  assert.equal(reads - before, 1000);
});
