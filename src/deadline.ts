// The clock of one HTTP exchange (#255): a stall is refused, a long healthy stream is not.
//
//   firstByteTimeoutMs  from the request (or from the end of a streamed upload) to the response headers
//   idleTimeoutMs       the longest gap with no progress: upload chunks pulled, response body chunks read
//   requestTimeoutMs    the whole exchange, opt-in (0, the default, is no total cap)
//
// 0 turns a timer off. git has no total timeout either (http.lowSpeedLimit is off by default); a caller who needs a
// wall-clock bound passes requestTimeoutMs or its own signal.
//
// One timer, re-armed only when the phase changes. Progress only moves a mark; the timer, when it fires, re-arms for what
// is left if progress came since. The timer is the strong owner of the AbortController: AbortSignal.any holds its
// sources weakly and an AbortSignal.timeout is held only by its own weak timer, so after a GC it never fires and a
// stalled body hangs forever (Node 20/22; found by the calibration harness). A controller owned by a live timer cannot
// be collected. Date.now in a Worker advances only across I/O; every mark is taken after the I/O that made it.
import { field } from './absent.js';

export type TimeoutKey = 'firstByteTimeoutMs' | 'idleTimeoutMs' | 'requestTimeoutMs';
// upload: a streamed request body is being sent; first_byte: waiting for the response headers; body: reading the body.
export type ClockPhase = 'upload' | 'first_byte' | 'body';
export type ExchangeTimeouts = { readonly firstByteMs: number; readonly idleMs: number; readonly totalMs: number };
export type ExchangeClock = {
  readonly signal: AbortSignal;
  // a chunk moved (an upload pull, a response body chunk). Ignored while waiting for headers.
  readonly progress: () => void;
  readonly phase: (next: ClockPhase) => void;
  // the exchange ended: no timer fires after it
  readonly cancel: () => void;
};

// Node's timer has unref (the DOM lib types it as a number); a Worker's has none.
const unref = (timer: unknown): void => {
  const f = field(timer, 'unref');
  if (f.tag === 'some' && typeof f.value === 'function') Reflect.apply(f.value, timer, []);
};

const MESSAGES: Readonly<Record<TimeoutKey, (ms: number) => string>> = {
  firstByteTimeoutMs: ms => `no response within ${ms} ms (limits.firstByteTimeoutMs)`,
  idleTimeoutMs: ms => `no bytes moved for ${ms} ms (limits.idleTimeoutMs)`,
  requestTimeoutMs: ms => `request exceeded ${ms} ms`,
};
// The abort reason: a TimeoutError, as the platform's own, naming the limit that fired (wrapNet reads `limit`).
export function timeoutReason(key: TimeoutKey, ms: number): DOMException {
  return Object.assign(new DOMException(MESSAGES[key](ms), 'TimeoutError'), { limit: key });
}
// The limit a timeout reason names, or none.
export function timeoutLimit(reason: unknown): TimeoutKey | null {
  const f = field(reason, 'limit');
  return f.tag === 'some' && (f.value === 'firstByteTimeoutMs' || f.value === 'idleTimeoutMs' || f.value === 'requestTimeoutMs') ? f.value : null;
}

type Due = { readonly at: number; readonly key: TimeoutKey; readonly ms: number };
const earlier = (a: Due | null, b: Due | null): Due | null => {
  if (a === null) return b;
  if (b === null) return a;
  return a.at <= b.at ? a : b;
};

// `onFire` runs once, before the abort, with the limit that fired (the span records it). `now` is the clock (tests).
export function exchangeClock(t: ExchangeTimeouts, outer: AbortSignal | null, onFire: (key: TimeoutKey, ms: number) => void, now: () => number = Date.now): ExchangeClock {
  const ac = new AbortController();
  const start = now();
  let phase: ClockPhase = 'first_byte';
  let mark = start;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  const due = (): Due | null => {
    const total: Due | null = t.totalMs > 0 ? { at: start + t.totalMs, key: 'requestTimeoutMs', ms: t.totalMs } : null;
    const waiting = phase === 'first_byte';
    const ms = waiting ? t.firstByteMs : t.idleMs;
    const step: Due | null = ms > 0 ? { at: mark + ms, key: waiting ? 'firstByteTimeoutMs' : 'idleTimeoutMs', ms } : null;
    return earlier(total, step);
  };
  const clear = (): void => { if (timer !== null) clearTimeout(timer); timer = null; };
  const arm = (): void => {
    clear();
    const d = due();
    if (done || d === null) return;
    // oxlint-disable-next-line no-use-before-define -- fire re-arms: the two refer to each other
    timer = setTimeout(fire, Math.max(0, d.at - now()));
    unref(timer);
  };
  function fire(): void {
    timer = null;
    const d = due();
    if (done || d === null) return;
    if (now() < d.at) { arm(); return; }
    done = true;
    onFire(d.key, d.ms);
    ac.abort(timeoutReason(d.key, d.ms));
  }
  arm();
  return {
    signal: outer ? AbortSignal.any([ac.signal, outer]) : ac.signal,
    progress: () => { if (phase !== 'first_byte') mark = now(); },
    phase: (next: ClockPhase) => { phase = next; mark = now(); arm(); },
    cancel: () => { done = true; clear(); },
  };
}

// A streamed request body whose pulls are the upload's progress. It reads the source only when the platform pulls it
// (no buffer of its own: highWaterMark 0), and the source is locked only from the first pull, so a request that never
// reads it leaves it as it was. Its end starts the wait for the response headers.
export function watchedUpload(source: ReadableStream<Uint8Array>, clock: ExchangeClock): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(c: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
      if (reader === null) reader = source.getReader();
      const r = await reader.read();
      if (r.done) { clock.phase('first_byte'); c.close(); return; }
      clock.progress();
      c.enqueue(r.value);
    },
    cancel: async (reason: unknown): Promise<void> => { await (reader === null ? source.cancel(reason) : reader.cancel(reason)); },
  }, { highWaterMark: 0 });
}

// A response body read that the exchange's signal ends, whether or not the platform (or a fetch wrapper, or a double)
// ties the body to the signal: on abort the read is cancelled and the chunks end, and `cut()` says so; the caller
// reports the abort (wrapNet of the signal). Leaving early cancels the body, as a for-await over the stream does.
export type AbortableRead = { readonly chunks: AsyncGenerator<Uint8Array, void, unknown>; readonly cut: () => boolean };
export function readAbortable(stream: ReadableStream<Uint8Array>, signal: AbortSignal): AbortableRead {
  let cut = false;
  async function* chunks(): AsyncGenerator<Uint8Array, void, unknown> {
    // a fetch double may hand back an async iterable that is not a stream: read it as it is
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- not every body a double returns has getReader
    if (typeof stream.getReader !== 'function') { yield* stream; return; }
    const reader = stream.getReader();
    const stop = (): void => { reader.cancel(signal.reason).catch(() => { /* the abort is the outcome */ }); };
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
    let finished = false;
    try {
      // oxlint-disable no-await-in-loop -- one chunk at a time is the point
      for (;;) {
        const r = await reader.read();
        if (signal.aborted) { cut = true; finished = true; return; }
        if (r.done) { finished = true; return; }
        yield r.value;
      }
      // oxlint-enable no-await-in-loop
    } finally {
      signal.removeEventListener('abort', stop);
      if (finished) reader.releaseLock(); else await reader.cancel().catch(() => { /* already ended */ });
    }
  }
  return { chunks: chunks(), cut: () => cut };
}
