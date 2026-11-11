// A random-access byte source: `size` bytes, read as a stream of [offset, offset + length). The one storage interface
// the pack-over-a-spool code takes (#235, #248), so the same code works over a file, a memory buffer or an object store
// (an R2 ranged GET). A read past `size`, or a negative or fractional bound, is the source's refusal to make; the stream
// yields exactly `length` bytes or errors.
import type { SignalArg } from './absent.js';
import type { PlyError } from './errors.js';
import { fail, plyError } from './errors.js';
import type { Result } from './result.js';
import { ok } from './result.js';

// `signal` aborts when the reader no longer wants the range (its consumer cancelled, or the operation's own signal
// aborted): a source that can abandon a read in flight does. It is optional in the type (SignalArg, absent.ts): an
// implementer may ignore it (a read of two parameters is a RangeSource), a direct caller may omit it, and a wrapper may
// pass on the optional signal it was given, so a read that takes it has to work without one. ply always passes one, and
// never waits for a source that ignores it.
export type RangeRead = (offset: number, length: number, ...signal: SignalArg) => Promise<Result<ReadableStream<Uint8Array>, PlyError>>;
export type RangeSource = { readonly size: number; readonly read: RangeRead };

// The signal that never aborts: the default `signal` of an operation whose caller gave none (resolvePackRange,
// scanPackIndex, loadTransferPack, packIdentity). Only then is a source that never answers waited for.
export const UNCANCELLABLE: AbortSignal = new AbortController().signal;

// One operation's stop, for every await it makes on storage it does not own (opening a range, reading a chunk, asking a
// stream to cancel, a caller's lookup). The storage may never answer; an operation whose signal aborts settles all the
// same, with the coded `aborted` outcome, because none of those awaits is made bare: each goes through `race`.
//   race(p, late)   p's outcome, or HALTED as soon as the signal aborts, whether or not p ever settles. What p answers
//                   after that goes to `late` (a range that opened late is cancelled there); a late rejection goes
//                   nowhere, and is handled, so it is never an unhandled rejection.
//   reading(range)  the stream being read (null: none): cancelled when the signal aborts, asked and not waited for.
//   release()       the operation is over: stop listening to the caller's signal (which may outlive it).
// Held: one waker per await in flight (removed when it settles), never a reaction per chunk on a long-lived promise.
// With UNCANCELLABLE nothing can halt, so `race` is the promise's own outcome: no waker, no listener, no extra promise
// held on the path that takes no signal.
export const HALTED: unique symbol = Symbol('halted');
export type Halted = typeof HALTED;
type Cancellable = { readonly cancel: (reason: unknown) => Promise<unknown> };
export type Halt = {
  // given to every source.read: a source that can abandon a read does
  readonly signal: AbortSignal;
  readonly halted: () => boolean;
  readonly race: <T>(p: Promise<T>, late: (v: T) => void) => Promise<T | Halted>;
  readonly reading: (range: Cancellable | null) => void;
  readonly release: () => void;
};
export const drop = (): void => { /* the operation is halted or already refused: its outcome is decided without this */ };
// Asks a range to stop, without waiting for the source to say it has. The range is the caller's: a cancel() that throws
// where it stands, or answers with something that is not a promise, is its own failure to cancel and changes nothing
// (thrown from here it would leave the abort listener below, past every caller, with its wakers not woken).
export const cancelRange = (range: Cancellable, reason: unknown): void => {
  try { Promise.resolve(range.cancel(reason)).catch(drop); } catch { drop(); }
};
// A range that opened after the operation stopped waiting for it: cancelled, not left open.
export const cancelLate = (opened: Result<ReadableStream<Uint8Array>, PlyError>): void => { if (opened.ok) cancelRange(opened.value, null); };
export const aborted = (what: string): PlyError => plyError('aborted', `${what}: aborted while waiting for the caller's storage`);
export function haltOn(signal: AbortSignal): Halt {
  let range: Cancellable | null = null;
  const wakers = new Set<(halted: Halted) => void>();
  const onAbort = (): void => {
    if (range !== null) cancelRange(range, signal.reason);
    range = null;
    for (const wake of wakers) wake(HALTED);
    wakers.clear();
  };
  if (signal !== UNCANCELLABLE && !signal.aborted) signal.addEventListener('abort', onAbort, { once: true });
  return {
    signal,
    halted: () => signal.aborted,
    reading(r) {
      if (r !== null && signal.aborted) cancelRange(r, signal.reason);
      else range = r;
    },
    // oxlint-disable-next-line typescript/promise-function-async -- an async wrapper is a promise and two hops more per chunk read
    race<T>(p: Promise<T>, late: (v: T) => void): Promise<T | Halted> {
      // `p` is typed a promise, but a source written in JavaScript may answer with the value itself, which the bare await
      // this replaces took. Promise.resolve gives a platform promise back as it is (no promise, no hop added) and makes
      // one of anything else, so what is returned is always a promise and `then` below is always there.
      const answer = Promise.resolve(p);
      if (signal === UNCANCELLABLE) return answer;
      // One promise per await, settled by whichever comes first: p (one reaction on it) or the abort listener, through
      // this await's waker (its resolve). No Promise.race and no second promise to lose: a chunk read costs one promise and one hop.
      return new Promise<T | Halted>((resolve, reject) => {
        // still waited for (the waker is there to take): p's outcome is the race's. No longer: a value goes to `late`,
        // and what `late` throws goes nowhere. A rejection is handled here whenever it comes: before the halt the
        // race carries it, after it nothing does.
        // oxlint-disable-next-line promise/catch-or-return -- both outcomes are taken here; neither reaction can throw
        answer.then(v => {
          const waited = wakers.delete(resolve);
          resolve(v);
          if (!waited) { try { late(v); } catch { drop(); } }
          return null;
        }, (e: unknown) => {
          wakers.delete(resolve);
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- p's own rejection, passed on as it came
          reject(e);
          return null;
        });
        if (signal.aborted) resolve(HALTED);
        else wakers.add(resolve);
      });
    },
    release() {
      signal.removeEventListener('abort', onAbort);
      range = null;
      wakers.clear();
    },
  };
}

// A RangeSource over bytes in memory (tests, and a pack small enough to hold): each read is one chunk, a view (no copy).
export function rangeFromBytes(bytes: Uint8Array): RangeSource {
  return {
    size: bytes.length,
    read: async (offset, length) => {
      await Promise.resolve();
      if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
        return fail('bad_request', `range ${offset}+${length} outside ${bytes.length} bytes`);
      }
      const view = bytes.subarray(offset, offset + length);
      return ok(new ReadableStream<Uint8Array>({ start(c) { if (view.length > 0) c.enqueue(view); c.close(); } }));
    },
  };
}
