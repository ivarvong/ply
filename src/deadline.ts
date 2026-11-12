// The clock of one HTTP exchange (#255): a stall is refused, a long healthy stream is not.
//
//   firstByteTimeoutMs  from the request (or from the end of a streamed upload) to the response headers
//   idleTimeoutMs       the longest wait on the network with no progress: no upload piece taken by the platform, no
//                       response body chunk in
//   heldTimeoutMs       the longest the consumer may hold a chunk (from taking it to asking for the next) (#273)
//   requestTimeoutMs    the whole exchange, opt-in (0, the default, is no total cap)
//
// 0 turns a timer off. git has no total timeout either (http.lowSpeedLimit is off by default); a caller who needs a
// wall-clock bound passes requestTimeoutMs or its own signal.
//
// The clock is a pure state machine (`transition`, `deadlineOf`); `exchangeClock` only feeds it events and arms what it
// says. Two rules it cannot break: a state never moves backwards (headers seen means the first byte is satisfied for
// good, whatever the upload does after), and time is charged only while ply waits on the network: while the consumer
// holds a chunk, or has not asked for the next one (`held`), neither the first-byte nor the idle limit runs: the held
// limit does, from the take, so network idle and a stalled consumer are distinct limits with distinct names.
//
// One timer. An event moves the mark; the timer is set again only when none is pending or the new deadline is earlier
// than the pending one, and when it fires it re-arms for what is left: a body chunk costs no setTimeout and no
// clearTimeout (test/deadline.test.js counts them). While the consumer holds a chunk, a timer that fires re-arms for
// take + heldTimeoutMs (or the total cap, if earlier); with both 0 it is not set again until the consumer asks. The timer is the strong owner of the
// AbortController: AbortSignal.any holds its sources weakly and an AbortSignal.timeout is held only by its own weak
// timer, so after a GC it never fires and a stalled body hangs forever (Node 20/22; found by the calibration harness).
// A controller owned by a live timer cannot be collected. Date.now in a Worker advances only across I/O; every mark is
// taken after the I/O that made it.
import { field } from './absent.js';
import { MAX_TIMER_MS } from './limits.js';

export type TimeoutKey = 'firstByteTimeoutMs' | 'idleTimeoutMs' | 'heldTimeoutMs' | 'requestTimeoutMs';
// connecting: the request is out (a byte body), no headers yet. uploading: a streamed body is going out.
// awaiting_first_byte: the upload ended, no headers yet. streaming: headers seen, ply is waiting on the network.
// held: headers seen, the consumer holds a chunk or has not asked for the next. done: ended, nothing fires.
export type ClockState = 'connecting' | 'uploading' | 'awaiting_first_byte' | 'streaming' | 'held' | 'done';
// request_sent: the request went out again (the stale-memo retry). upload_started / upload_bytes / upload_ended: the
// streamed request body. headers: the response headers arrived. body_chunk: a body chunk arrived from the network.
// consumer_took: the chunk was handed to the consumer. consumer_asked: the consumer asked for the next. ended: over.
export type ClockEvent = 'request_sent' | 'upload_started' | 'upload_bytes' | 'upload_ended' | 'headers' | 'body_chunk' | 'consumer_took' | 'consumer_asked' | 'ended';
// The next state, and whether the event is network progress that restarts the wait (moves the mark).
type ClockStep = { readonly state: ClockState; readonly restart: boolean };
export type ExchangeTimeouts = { readonly firstByteMs: number; readonly idleMs: number; readonly heldMs: number; readonly totalMs: number };
export type ExchangeClock = {
  readonly signal: AbortSignal;
  readonly feed: (event: ClockEvent) => void;
  // the exchange ended: no timer fires after it (feed('ended'))
  readonly cancel: () => void;
};

// Every step there is, made once: the machine runs per body chunk and allocates nothing.
const steps = (restart: boolean): Readonly<Record<ClockState, ClockStep>> => ({
  connecting: { state: 'connecting', restart }, uploading: { state: 'uploading', restart }, awaiting_first_byte: { state: 'awaiting_first_byte', restart },
  streaming: { state: 'streaming', restart }, held: { state: 'held', restart }, done: { state: 'done', restart },
});
const STAY = steps(false);
const GO = steps(true);
const stay = (state: ClockState): ClockStep => STAY[state];
const go = (state: ClockState): ClockStep => GO[state];
// The whole machine. An event a state has no use for leaves it as it is: nothing moves a state backwards.
export function transition(state: ClockState, event: ClockEvent): ClockStep {
  if (state === 'done' || event === 'ended') return stay('done');
  if (state === 'connecting') {
    if (event === 'request_sent') return go('connecting');
    if (event === 'upload_started') return go('uploading');
    return event === 'headers' ? go('streaming') : stay(state);
  }
  if (state === 'uploading') {
    if (event === 'upload_bytes') return go('uploading');
    if (event === 'upload_ended') return go('awaiting_first_byte');
    return event === 'headers' ? go('streaming') : stay(state);
  }
  if (state === 'awaiting_first_byte') return event === 'headers' ? go('streaming') : stay(state);
  if (state === 'streaming') {
    // bytes moved either way; an upload that ends here ends nothing the clock waits for
    if (event === 'upload_bytes' || event === 'body_chunk') return go('streaming');
    return event === 'consumer_took' ? go('held') : stay(state);
  }
  // held: the hold runs from the take (go above); only the consumer's ask puts ply back on the network, and the wait
  // starts then
  return event === 'consumer_asked' ? go('streaming') : stay(state);
}

// Node's timer has unref (the DOM lib types it as a number); a Worker's has none.
const unref = (timer: unknown): void => {
  const f = field(timer, 'unref');
  if (f.tag === 'some' && typeof f.value === 'function') Reflect.apply(f.value, timer, []);
};

const MESSAGES: Readonly<Record<TimeoutKey, (ms: number) => string>> = {
  firstByteTimeoutMs: ms => `no response within ${ms} ms (limits.firstByteTimeoutMs)`,
  idleTimeoutMs: ms => `no bytes moved for ${ms} ms (limits.idleTimeoutMs)`,
  heldTimeoutMs: ms => `the consumer held a chunk for ${ms} ms without asking for the next (limits.heldTimeoutMs)`,
  requestTimeoutMs: ms => `request exceeded ${ms} ms`,
};
// The abort reason: a TimeoutError, as the platform's own, naming the limit that fired (wrapNet reads `limit`).
export function timeoutReason(key: TimeoutKey, ms: number): DOMException {
  return Object.assign(new DOMException(MESSAGES[key](ms), 'TimeoutError'), { limit: key });
}
// The limit a timeout reason names, or none.
export function timeoutLimit(reason: unknown): TimeoutKey | null {
  const f = field(reason, 'limit');
  return f.tag === 'some' && (f.value === 'firstByteTimeoutMs' || f.value === 'idleTimeoutMs' || f.value === 'heldTimeoutMs' || f.value === 'requestTimeoutMs') ? f.value : null;
}

type Due = { readonly at: number; readonly key: TimeoutKey; readonly ms: number };
const earlier = (a: Due | null, b: Due | null): Due | null => {
  if (a === null) return b;
  if (b === null) return a;
  return a.at <= b.at ? a : b;
};
// The deadline to arm in `state`, whose wait began at `mark`, in an exchange that began at `start`; null is none.
export function deadlineOf(state: ClockState, mark: number, start: number, t: ExchangeTimeouts): Due | null {
  if (state === 'done') return null;
  const total: Due | null = t.totalMs > 0 ? { at: start + t.totalMs, key: 'requestTimeoutMs', ms: t.totalMs } : null;
  if (state === 'held') return earlier(total, t.heldMs > 0 ? { at: mark + t.heldMs, key: 'heldTimeoutMs', ms: t.heldMs } : null);
  const waiting = state === 'connecting' || state === 'awaiting_first_byte';
  const ms = waiting ? t.firstByteMs : t.idleMs;
  const step: Due | null = ms > 0 ? { at: mark + ms, key: waiting ? 'firstByteTimeoutMs' : 'idleTimeoutMs', ms } : null;
  return earlier(total, step);
}

const pastHeaders = (state: ClockState): boolean => state === 'streaming' || state === 'held';
// Past the headers, whether `state`'s own step deadline (from `mark`) is earlier than a timer pending for `armedFor`.
const steppedEarlier = (state: ClockState, t: ExchangeTimeouts, mark: number, armedFor: number): boolean => {
  const ms = state === 'held' ? t.heldMs : t.idleMs;
  return ms > 0 && armedFor > mark + ms;
};

// `onFire` runs once, before the abort, with the limit that fired (the span records it). `now` is the clock (tests).
export function exchangeClock(t: ExchangeTimeouts, outer: AbortSignal | null, onFire: (key: TimeoutKey, ms: number) => void, now: () => number = Date.now): ExchangeClock {
  const ac = new AbortController();
  const start = now();
  let state: ClockState = 'connecting';
  let mark = start;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // when the pending timer fires
  let armedFor = 0;
  const due = (): Due | null => deadlineOf(state, mark, start, t);
  const clear = (): void => { if (timer !== null) clearTimeout(timer); timer = null; };
  // A pending timer that fires no later than the deadline is left alone: fire() re-arms for what is left. So is one
  // pending when there is nothing to wait for (held, no total cap): it finds that out when it fires and is not set again.
  const arm = (): void => {
    if (state === 'done') { clear(); return; }
    const d = due();
    if (d === null) return;
    if (timer !== null && armedFor <= d.at) return;
    clear();
    const at = now();
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, d.at - at));
    armedFor = at + delay;
    // oxlint-disable-next-line no-use-before-define -- fire re-arms: the two refer to each other
    timer = setTimeout(fire, delay);
    unref(timer);
  };
  function fire(): void {
    timer = null;
    const d = due();
    if (d === null) return;
    if (now() < d.at) { arm(); return; }
    state = 'done';
    onFire(d.key, d.ms);
    ac.abort(timeoutReason(d.key, d.ms));
  }
  const feed = (event: ClockEvent): void => {
    const from = state;
    const next = transition(from, event);
    state = next.state;
    if (next.restart) mark = now();
    // The per-chunk path makes no timer call: a pending timer that fires no later than the new deadline is left alone
    // and re-arms for what is left when it fires. That covers a restart inside a state (marks only advance) and
    // a move between streaming and held whose new step deadline (mark + idle, or mark + held) is no earlier than the
    // pending timer. A move between them that brings the deadline earlier (a timer set for take + held, or the total
    // cap, and then the ask; or a held limit shorter than the pending idle one) is the one that sets it again.
    if (timer !== null && (state === from || (pastHeaders(from) && pastHeaders(state) && !steppedEarlier(state, t, mark, armedFor)))) return;
    arm();
  };
  arm();
  return { signal: outer ? AbortSignal.any([ac.signal, outer]) : ac.signal, feed, cancel: () => { feed('ended'); } };
}

// The most bytes handed to the platform at once.
const UPLOAD_PIECE = 65_536;
// A streamed request body whose pulls by the platform are the upload's progress marks. A source chunk goes to the
// platform in views of at most UPLOAD_PIECE (no copy), so one large chunk is many marks, not one. It reads the source
// only when the platform pulls it (no buffer of its own: highWaterMark 0), and the source is locked only from the first
// pull, so a request that never reads it leaves it as it was. Its end is the upload's end.
//
// What a mark proves, and what it does not. A pull says the platform took another piece into its own buffers, not that
// the piece reached the server: ply cannot see below fetch. The platform pulls when its buffers have room (on Node,
// undici's socket queue and the kernel's send buffer), so on a slow link the marks come in bursts a buffer apart, and
// the last piece is handed over while a buffered tail is still going out. Measured with the real fetch on Node 24 over
// loopback, 4 MiB to a server reading 64 KiB per 25 ms: 64 pulls in 8 bursts, the longest gap between pulls 473 ms
// while the server never paused for more than 31 ms, and the last pull 1.7 s before the server's last read. So:
//   - while pieces remain, idleTimeoutMs fires when the platform takes no piece for that long, so that limit must be
//     longer than the link takes to drain one burst of the platform's buffers (not one 64 KiB piece);
//   - once the last piece is handed over the upload has ended for the clock, and firstByteTimeoutMs, which starts
//     there, covers sending the buffered tail as well as the server's answer. A link too slow to drain the tail in
//     that time fails as firstByteTimeoutMs: no response arrived in time, which is all ply can observe by then.
// Neither measures upload progress below fetch. The bound on a stalled upload as a whole, whatever the platform has
// buffered, is requestTimeoutMs (off by default) or the caller's signal.
// test/upload-progress-socket.test.js holds all three on a real socket.
export function watchedUpload(source: ReadableStream<Uint8Array>, clock: ExchangeClock): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let rest: Uint8Array | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(c: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
      let chunk = rest;
      if (chunk === null) {
        if (reader === null) reader = source.getReader();
        const r = await reader.read();
        if (r.done) { clock.feed('upload_ended'); c.close(); return; }
        chunk = r.value;
      }
      rest = chunk.length > UPLOAD_PIECE ? chunk.subarray(UPLOAD_PIECE) : null;
      clock.feed('upload_bytes');
      c.enqueue(rest === null ? chunk : chunk.subarray(0, UPLOAD_PIECE));
    },
    cancel: async (reason: unknown): Promise<void> => { rest = null; await (reader === null ? source.cancel(reason) : reader.cancel(reason)); },
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
