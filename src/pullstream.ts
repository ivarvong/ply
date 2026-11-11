// Async-iterable adapters over the pull decoders (#241): scanPack (packstream.ts), pktFrames (pktline.ts) and
// inflateChunks (inflatestream.ts). The pull API stays the base; these are the read loop every streaming caller wrote
// around it, once:
//
//   for await (const piece of scanPack(response.body, { limits })) { ... }
//
// - The adapter reads its source only when the decoder answers `need`: one chunk per need, nothing ahead, so a slow
//   consumer is the source's backpressure. What it holds is the decoder's hold (streambound.ts) and the one chunk fed.
// - Each returns a ReadableStream of the decoder's items (async-iterable on node and workerd), with a high-water mark of
//   0. It feeds, closes the decoder when the source ends, and closes at the decoder's end. `need` and `end` are never
//   items.
// - A decoder refusal errors the stream with the decoder's typed PlyError (the value its pull returns) and cancels the
//   source: results never throw, streams error, so `for await` throws it and a reader's read() rejects with it. A source
//   that errors errors the stream with its own error; a chunk that is not a Uint8Array is `bad_request`.
// - Cancelling (a `break` or a throw in a `for await` body, reader.cancel()) cancels the source: a ReadableStream's
//   reader is cancelled (its underlying source sees cancel(reason)), an AsyncIterable's iterator gets return().
// - A pack chunk and an inflate chunk are the caller's (copies); a pkt-line payload is a copy too (pktStep).
// - A source chunk is read only until the adapter asks for the next one: a decoder that answers `need` has copied the
//   few unread bytes it keeps (packstream.ts ownCarry, inflatestream.ts own; pktStep copies its carry), so a source may
//   refill one buffer for every chunk. test/scan-pack-index.test.js holds scanPackIndex to git on such a source;
//   scanPack shares its decoder. (A ReadableStream that queues ahead of its reader must not reuse a queued chunk.)
import type { ErrorOf } from './errors.js';
import { plyError } from './errors.js';
import type { Option, Result } from './result.js';
import { ok, err, some, none, assertNever } from './result.js';
import { withDefaults, at as itemAt } from './absent.js';
import type { LimitsInput } from './limits.js';
import { DEFAULT_LIMITS } from './limits.js';
import type { PackError, PackPiece, ScanBudget } from './packstream.js';
import { RETAIN_BUDGET, parsePackInit, parsePackFeed, parsePackClose, parsePackPull } from './packstream.js';
import type { PktFrame, PktState } from './pktline.js';
import { pktInit, pktStep, pktFinish } from './pktline.js';
import type { InflateError, InflateStreamOpts } from './inflatestream.js';
import { inflateInit, inflateFeed, inflatePull, inflateEnd, inflateUnread, cappedBound, zlibWrap } from './inflatestream.js';

export type ByteSource = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

// One decoder event, as the driver sees it.
type Event<T> = { readonly kind: 'need' } | { readonly kind: 'item'; readonly value: T } | { readonly kind: 'end' };
const NEED: Event<never> = Object.freeze({ kind: 'need' });
const END: Event<never> = Object.freeze({ kind: 'end' });
const item = <T>(value: T): Event<T> => ({ kind: 'item', value });
// A pull decoder behind one shape: pull the next event (or its refusal), feed a chunk, close the input.
type Decoder<T, E> = {
  readonly pull: () => Result<Event<T>, E>;
  readonly feed: (bytes: Uint8Array) => void;
  readonly close: () => void;
};

// The source, read a chunk at a time. Its reader is taken on the first read, so an iterator that is never pulled
// leaves the stream unlocked.
type Reader = {
  readonly read: () => Promise<Option<unknown>>;
  readonly cancel: (why: unknown) => Promise<void>;
};
function readerOf(source: ByteSource): Reader {
  if ('getReader' in source) {
    let held: Option<ReadableStreamDefaultReader<Uint8Array>> = none;
    const take = (): ReadableStreamDefaultReader<Uint8Array> => {
      if (held.tag === 'some') return held.value;
      const r = source.getReader();
      held = some(r);
      return r;
    };
    return {
      read: async () => { const r = await take().read(); return r.done ? none : some(r.value); },
      // a stream never read is cancelled without a reader; a source whose cancel fails changes nothing for the caller
      cancel: async why => { await (held.tag === 'some' ? held.value.cancel(why) : source.cancel(why)).catch(() => null); },
    };
  }
  const it = source[Symbol.asyncIterator]();
  return {
    read: async () => { const r = await it.next(); return r.done === true ? none : some(r.value); },
    cancel: async () => { if (typeof it.return === 'function') await Promise.resolve(it.return()).catch(() => null); },
  };
}

type Round = 'settled' | 'reading';
// The driver, as a stream of the decoder's items with a high-water mark of 0: it pulls only while a read is waiting,
// so it reads its source one chunk per need and never ahead. A refusal errors the stream (and cancels the source); a
// source that rejects errors it with its own error; cancel (a `break`) cancels the source.
function drive<T, E>(source: ByteSource, opened: Result<Decoder<T, E>, E>): ReadableStream<T> {
  const reader = readerOf(source);
  // one chunk in: the decoder's input, its close, or a refusal for a chunk that is not bytes
  const feedFrom = (dec: Decoder<T, E>, got: Option<unknown>): Result<true, ErrorOf<'bad_request'>> => {
    if (got.tag === 'none') { dec.close(); return ok(true); }
    if (!(got.value instanceof Uint8Array)) return err(plyError('bad_request', `stream source: a chunk is ${typeof got.value}, not a Uint8Array`));
    dec.feed(got.value);
    return ok(true);
  };
  // Pull until one item is out or the decoder ended. A need reads one chunk and goes round again from the read's
  // callback: each round starts afresh, so a long run of needs (a frame fed a byte at a time) holds nothing per round.
  // A cancel while a read is out stops the round that read would start.
  let cancelled = false;
  const deliver = async (dec: Decoder<T, E>, c: ReadableStreamDefaultController<T>): Promise<void> => {
    await new Promise<void>(settled => {
      const stop = (why: unknown): void => {
        c.error(why);
        reader.cancel(why).then(settled).catch(settled);
      };
      const failed = (why: unknown): void => { c.error(why); settled(); };
      // `input` is the chunk the last need read (none on the first round). The answer says whether this round settled
      // the pull or left a read out.
      const round = (input: Option<Option<unknown>>): Round => {
        if (cancelled) { settled(); return 'settled'; }
        if (input.tag === 'some') {
          const r = feedFrom(dec, input.value);
          if (!r.ok) { stop(r.error); return 'settled'; }
        }
        const got = dec.pull();
        if (!got.ok) { stop(got.error); return 'settled'; }
        const ev = got.value;
        switch (ev.kind) {
          case 'item': c.enqueue(ev.value); settled(); return 'settled';
          case 'end': c.close(); settled(); return 'settled';
          case 'need': reader.read().then(chunk => round(some(chunk))).catch(failed); return 'reading';
        }
        // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: unreachable, the compiler's exhaustiveness check
        return assertNever(ev);
      };
      round(none);
    });
  };
  return new ReadableStream<T>({
    async pull(c) {
      if (!opened.ok) {
        c.error(opened.error);
        await reader.cancel(opened.error);
        return;
      }
      await deliver(opened.value, c);
    },
    async cancel(why) {
      cancelled = true;
      await reader.cancel(why);
    },
  }, new CountQueuingStrategy({ highWaterMark: 0 }));
}

// ---- scanPack: the pack scan's pieces (packstream.ts), never `need` or `end`.
export type ScanPiece = Exclude<PackPiece, { readonly kind: 'need' } | { readonly kind: 'end' }>;
export type ScanPackOpts = { readonly limits: LimitsInput; readonly verify: boolean; readonly budget: ScanBudget };
const scanDefaults = (): ScanPackOpts => ({ limits: DEFAULT_LIMITS, verify: true, budget: RETAIN_BUDGET });
export function scanPack(source: ByteSource, input: Partial<ScanPackOpts> = {}): ReadableStream<ScanPiece> {
  const opts = withDefaults(input, scanDefaults());
  const st = parsePackInit({ limits: opts.limits, verify: opts.verify, budget: opts.budget });
  const opened: Result<Decoder<ScanPiece, PackError>, PackError> = st.ok ? ok({
    pull: () => {
      const p = parsePackPull(st.value);
      if (!p.ok) return p;
      const v = p.value;
      if (v.kind === 'need') return ok(NEED);
      return ok(v.kind === 'end' ? END : item(v));
    },
    feed: bytes => { parsePackFeed(st.value, bytes); },
    close: () => { parsePackClose(st.value); },
  }) : st;
  return drive(source, opened);
}

// ---- pktFrames: pkt-line frames (pktline.ts). The source ending inside a frame is pktFinish's refusal.
type Protocol = ErrorOf<'protocol'>;
export function pktFrames(source: ByteSource): ReadableStream<PktFrame> {
  let st: PktState = pktInit();
  // the frames of the last chunk not handed out yet, last first: a frame handed out is popped, so it is the caller's
  // alone (holding it here too would keep one more frame than peakBound('pkt') counts)
  let ready: PktFrame[] = [];
  let closed = false;
  let failed: Option<Protocol> = none;
  const dec: Decoder<PktFrame, Protocol> = {
    pull: () => {
      if (failed.tag === 'some') return err(failed.value);
      const f = itemAt(ready, ready.length - 1);
      if (f.tag === 'some') { ready.pop(); return ok(item(f.value)); }
      if (!closed) return ok(NEED);
      const fin = pktFinish(st);
      return fin.ok ? ok(END) : fin;
    },
    feed: bytes => {
      const r = pktStep(st, bytes);
      if (!r.ok) { failed = some(r.error); return; }
      st = r.value.state;
      ready = r.value.frames.toReversed();
    },
    close: () => { closed = true; },
  };
  return drive(source, ok(dec));
}

// ---- inflateChunks: one zlib member's (or raw deflate stream's) output (inflatestream.ts). The source must end with
// the member: a byte after it is pack_corrupt, as a truncated member is.
export type InflateChunksOpts = InflateStreamOpts;
const trailing = (n: number): ErrorOf<'pack_corrupt'> => plyError('pack_corrupt', `inflate: ${n} bytes after the end of the stream`);
const inflateDefaults = (): InflateChunksOpts => ({ bound: cappedBound(), wrap: zlibWrap(true) });
export function inflateChunks(source: ByteSource, input: Partial<InflateChunksOpts> = {}): ReadableStream<Uint8Array> {
  const opts = withDefaults(input, inflateDefaults());
  const opened = inflateInit(opts);
  if (!opened.ok) return drive(source, opened);
  const st = opened.value;
  let closed = false;
  // After the member's end the inflater stays at its end and holds what it is fed after (inflateUnread): the next pull
  // returns 'end' again and reads that as trailing bytes, so a byte after the member is refused whichever chunk brought it.
  const dec: Decoder<Uint8Array, InflateError> = {
    pull: () => {
      const p = closed ? inflateEnd(st) : inflatePull(st);
      if (!p.ok) return p;
      switch (p.value.kind) {
        case 'chunk': return ok(item(p.value.bytes));
        case 'need': return ok(NEED);
        case 'end': {
          const left = inflateUnread(st).length;
          if (left > 0) return err(trailing(left));
          return ok(closed ? END : NEED);
        }
      }
      // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: unreachable, the compiler's exhaustiveness check
      return assertNever(p.value);
    },
    feed: bytes => { inflateFeed(st, bytes); },
    close: () => { closed = true; },
  };
  return drive(source, ok(dec));
}
