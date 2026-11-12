// Scripted storage that stops answering, for the abort cells each pack space runs in its own runner (README: Abort
// contract: an operation its caller aborts settles `aborted` when the signal fires, not when the storage answers).
// Nothing here sleeps: a hang is proved by a step counter, not a clock.
import { rangeFromBytes } from '../src/rangesource.js';

// `turns` event-loop turns pass while the promise is still pending: 'pending', else 'settled'.
export const settledWithin = async (promise, turns = 50) => {
  let state = 'pending';
  promise.then(() => { state = 'settled'; }, () => { state = 'settled'; });
  for (let i = 0; i < turns && state === 'pending'; i++) await new Promise(r => setImmediate(r));
  return state;
};

// Read number `at` (0-based) stops answering; earlier reads are served from the bytes. 'never' leaves read() itself
// pending for ever (the operation is parked at the read), 'stall' opens a range whose first chunk never comes (parked at
// the stream read). `parked` resolves when the source is in that state; the counters say what it was told afterwards.
export function stallAt(bytes, at, how) {
  const real = rangeFromBytes(bytes);
  const state = { reads: 0, cancelled: 0, aborted: 0 };
  let reached;
  const parked = new Promise(r => { reached = r; });
  return {
    state, parked, size: bytes.length,
    read(offset, length, signal) {
      const i = state.reads++;
      if (i < at) return real.read(offset, length, signal);
      signal?.addEventListener('abort', () => { state.aborted++; });
      if (how === 'never') { reached(); return new Promise(() => {}); }
      return Promise.resolve({ ok: true, value: new ReadableStream({
        pull() { reached(); return new Promise(() => {}); },
        cancel() { state.cancelled++; },
      }, { highWaterMark: 0 }) });
    },
  };
}

export const abortedBefore = () => { const ac = new AbortController(); ac.abort(new Error('before')); return ac.signal; };
export const codeOf = r => (r.ok ? 'ok' : r.error.code);
