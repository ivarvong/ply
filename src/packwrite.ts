// The streamed pack writer push sends (#172). The pack is deflated twice and never held:
//   measurePack (pass 1)  deflates every object, keeping only its length, its SHA-1 and each entry's numbers, so a pack
//                         over the cap is refused before the first request byte (push.ts, I36);
//   streamPack (pass 2)   deflates them again into the request body as it is read, and ends the body with the trailer
//                         only when this pass gave the same length and SHA-1 as the first.
// A pack no longer than INFLATE_CHUNK is kept from pass 1 and sent as bytes (no second pass). Either way the writer holds,
// beside the caller's objects and zlib's own state, the deflate output of at most one DEFLATE_SLICE slice: the slice and
// the one block of earlier input zlib may still be holding (level 6 ends a block every 16 Ki symbols), so a push whose
// largest object is L peaks at about L + DEFLATE_SLICE + 16 KiB (81,940 B measured on random input, node and workerd;
// 32,776 B with the 16 KiB slices before).
// Both passes feed CompressionStream the same input in the same DEFLATE_SLICE slices, so zlib (deterministic for a fixed
// input sequence and parameters) writes the same bytes (test/packwrite.test.js, node and workerd). If it ever did not,
// pass 2 errors its stream before the trailer: the server is never handed a pack that is whole, and push reports it.
// The bytes are buildPack's (pack.ts) for the same objects: the same headers, bases and zlib streams.
import { streamingSha1, fromHex, toHex } from './sha1.js';
import { builtEntry, entryHead, packHeader } from './pack.js';
import type { BuiltEntry, PackInput } from './pack.js';
import { bufferSource, concat } from './bytes.js';
import { plyError } from './errors.js';
import type { ErrorOf, PlyError } from './errors.js';
import { limitExceeded } from './limits.js';
import { DEFLATE_SLICE, INFLATE_CHUNK, PACK_HEADER_BYTES, PACK_TRAILER_BYTES } from './format.js';

// One object's zlib stream, pulled: the object goes into CompressionStream in DEFLATE_SLICE slices as the output is read
// (a source with no read-ahead), so nothing but zlib's own state and one output chunk is held.
// No read-ahead of slices.
// Stryker disable next-line ObjectLiteral: equivalent. A slice is a view of the caller's object (subarray, no copy), so a source queue of one costs no bytes, and CompressionStream gets the same slices in the same order
const SLICE_QUEUE: QueuingStrategy<Uint8Array<ArrayBuffer>> = { highWaterMark: 0 };
const slices = (data: Uint8Array): ReadableStream<Uint8Array<ArrayBuffer>> => {
  const bytes = bufferSource(data);
  let next = 0;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(c): void {
      if (next >= bytes.length) { c.close(); return; }
      const end = Math.min(next + DEFLATE_SLICE, bytes.length);
      c.enqueue(bytes.subarray(next, end));
      next = end;
    },
  }, SLICE_QUEUE);
};
export async function* deflatePull(data: Uint8Array): AsyncGenerator<Uint8Array, void, unknown> {
  const reader = slices(data).pipeThrough(new CompressionStream('deflate')).getReader();
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- a pull: each chunk is read when the consumer asks for it
      const r = await reader.read();
      if (r.done) return;
      yield r.value;
    }
  } finally {
    // a consumer that stopped early (pass 2's body cancelled) stops the deflate; after the end this is a no-op
    await reader.cancel();
  }
}

// What one pass wrote: every entry, the bytes before the trailer, and their SHA-1 (the trailer).
type Tally = { readonly entries: readonly BuiltEntry[]; readonly body: number; readonly digest: Uint8Array };
// The pack before its trailer, piece by piece (the header, each object's header and base, its zlib chunks), each
// hashed as it is yielded. The headers and entries are buildPack's (pack.ts entryHead, builtEntry). The hash is
// streamingSha1's: Workers' native DigestStream where there is one (each pass hashes the whole pack, so the pure-JS
// SHA-1 was a pass's largest cost after zlib), the pure-JS Sha1 elsewhere.
async function* pieces(objects: readonly PackInput[]): AsyncGenerator<Uint8Array, Tally, unknown> {
  const sha = streamingSha1();
  const hdr = packHeader(objects.length);
  await sha.update(hdr);
  yield hdr;
  const entries: BuiltEntry[] = [];
  const offsets: number[] = [];
  let offset = PACK_HEADER_BYTES;
  for (const o of objects) {
    // buildPack's header for the entry (pack.ts entryHead): the same type, header and base bytes
    const h = entryHead(o, offset, offsets);
    // oxlint-disable-next-line no-await-in-loop -- in pack order
    await sha.update(h.head);
    yield h.head;
    let compressed = 0;
    // one object at a time, in pack order
    // oxlint-disable-next-line no-await-in-loop -- see above
    for await (const z of deflatePull(o.data)) { await sha.update(z); compressed += z.length; yield z; }
    const entry = builtEntry(h, o.data.length, compressed, offset);
    entries.push(entry);
    offsets.push(offset);
    offset += entry.bytes;
  }
  return { entries, body: offset, digest: fromHex(await sha.hex()) };
}

// Pass 1. `bytes` is the whole pack (trailer included), what the server would receive; `held` is the pack itself when
// it is at most `keep` bytes (null otherwise: pass 2 writes it).
export type MeasuredPack = {
  readonly objects: readonly PackInput[]; readonly entries: readonly BuiltEntry[]; readonly bytes: number;
  readonly body: number; readonly digest: Uint8Array; readonly held: Uint8Array | null;
};
export async function measurePack(objects: readonly PackInput[], keep: number = INFLATE_CHUNK): Promise<MeasuredPack> {
  const it = pieces(objects);
  // the pieces while the pack still fits in `keep` (n only grows: once past it, nothing more is kept)
  const kept: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- pass 1 reads its own pieces in order
    const r = await it.next();
    if (r.done === true) {
      const { entries, body, digest } = r.value;
      const bytes = body + PACK_TRAILER_BYTES;
      return { objects, entries, bytes, body, digest, held: bytes <= keep ? concat([...kept, digest]) : null };
    }
    n += r.value.length;
    if (n + PACK_TRAILER_BYTES <= keep) kept.push(r.value);
  }
}

// Pass 2: `prefix` (the commands, and push options) and then the pack, as a stream read at the reader's pace. `failure`
// is null until this pass refuses to finish the pack (a length or SHA-1 that is not pass 1's) or the deflate fails; the
// stream is then errored before the trailer, whatever the runtime does with an errored request body (undici aborts the
// request; workerd ends it as if complete, measured), so the server never gets a whole pack.
export type StreamedPack = { readonly stream: ReadableStream<Uint8Array>; readonly length: number; readonly failure: () => ErrorOf<'internal'> | null };
export function streamPack(m: MeasuredPack, prefix: Uint8Array): StreamedPack {
  const it = pieces(m.objects);
  let failed: ErrorOf<'internal'> | null = null;
  let started = false;
  let sent = 0;
  const refuse = (c: ReadableStreamDefaultController<Uint8Array>, why: string, cause: unknown = null): void => {
    failed = plyError('internal', `push: the pack's second deflate pass ${why}; it was not sent whole`, { what: 'push pack', got: sent, max: m.body, ...(cause === null ? {} : { cause }) });
    c.error(failed);
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(c): Promise<void> {
      if (!started) { started = true; c.enqueue(prefix); return; }
      let r: IteratorResult<Uint8Array, Tally>;
      try { r = await it.next(); } catch (e) { refuse(c, 'failed', e); return; }
      if (r.done === true) {
        if (r.value.body !== m.body) { refuse(c, 'ran shorter than the first'); return; }
        if (toHex(r.value.digest) !== toHex(m.digest)) { refuse(c, 'wrote another pack'); return; }
        c.enqueue(r.value.digest);
        c.close();
        return;
      }
      sent += r.value.length;
      // never more than pass 1 measured: the cap push checked is the cap the wire sees
      if (sent > m.body) { refuse(c, 'ran longer than the first'); return; }
      c.enqueue(r.value);
    },
    // the value handed to return() becomes the finished generator's result, which nothing reads
    // Stryker disable next-line ObjectLiteral,ArrayDeclaration: equivalent, see above
    async cancel(): Promise<void> { await it.return({ entries: [], body: 0, digest: new Uint8Array(0) }); },
  }, { highWaterMark: 0 });
  return { stream, length: prefix.length + m.bytes, failure: () => failed };
}

// A pack the caller already has, as the request body after `prefix` (commands, and push options): read at the reader's
// pace, never buffered or teed, one chunk held back. `length` is the pack's own length when the caller knows it (null:
// it does not); SourcedPack.length is the whole body, the prefix and that pack (only the prefix when unknown: the real
// count is `sent()`, for the span).
// The last chunk is released only once the source has ended and its length has passed, and a chunk that would go over
// `length` or `maxPack` is never released, so a refused pack never reaches the server whole, whatever the runtime does
// with an errored request body (undici aborts the request; workerd ends it as if complete, measured: streamPack above).
// `failure` is null until the pack is refused or the source fails; `release` cancels a source the request did not finish
// (asked once, not waited for).
export type SourcedPack = {
  readonly stream: ReadableStream<Uint8Array>; readonly length: number;
  readonly failure: () => PlyError | null; readonly sent: () => number; readonly release: () => Promise<void>;
};
export function streamSource(source: ReadableStream<Uint8Array>, prefix: Uint8Array, length: number | null, maxPack: number): SourcedPack {
  const reader = source.getReader();
  let failed: PlyError | null = null;
  let started = false;
  let open = true;
  let held: Uint8Array | null = null;
  let read = 0;
  let sent = 0;
  // The source is the caller's: it is asked to cancel and never waited for, so a cancel() that never settles cannot hold
  // the push past its outcome (its report, its abort, its timeout). A source that fails to cancel changes nothing.
  // oxlint-disable-next-line eslint/require-await -- async for the callers that await it; nothing here waits
  const release = async (why: unknown = null): Promise<void> => {
    if (!open) return;
    open = false;
    // a cancel() that throws where it stands, or answers with something that is not a promise, changes nothing either
    try { Promise.resolve(reader.cancel(why)).catch(() => null); } catch { /* the source's own failure to cancel: nothing waits on it */ }
  };
  const refuse = async (c: ReadableStreamDefaultController<Uint8Array>, e: PlyError): Promise<void> => { failed = e; c.error(e); await release(e); };
  const mismatch = (want: number): ErrorOf<'bad_request'> => plyError('bad_request', `pushPack: the pack stream yielded ${read} bytes where length said ${want}; it was not sent whole`, { what: 'push pack length', got: read, max: want });
  const emit = (c: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array): void => { sent += chunk.length; c.enqueue(chunk); };
  const stream = new ReadableStream<Uint8Array>({
    async pull(c): Promise<void> {
      if (!started) { started = true; c.enqueue(prefix); return; }
      for (;;) {
        let r: ReadableStreamReadResult<Uint8Array>;
        // oxlint-disable-next-line no-await-in-loop -- one chunk at a time, at the request's pace
        try { r = await reader.read(); } catch (e) { open = false; await refuse(c, plyError('internal', 'pushPack: the pack stream failed; it was not sent whole', { what: 'push pack', got: read, cause: e })); return; }
        if (r.done) {
          open = false;
          // oxlint-disable-next-line no-await-in-loop -- this refusal ends the loop
          if (length !== null && read !== length) { await refuse(c, mismatch(length)); return; }
          if (held !== null) emit(c, held);
          c.close();
          return;
        }
        const chunk: unknown = r.value;
        // oxlint-disable-next-line no-await-in-loop -- each refusal ends the loop
        if (!(chunk instanceof Uint8Array)) { await refuse(c, plyError('bad_request', 'pushPack: the pack stream yielded something other than bytes', { what: 'push pack chunk' })); return; }
        read += chunk.length;
        // oxlint-disable-next-line no-await-in-loop -- see above
        if (read > maxPack) { await refuse(c, limitExceeded('push pack bytes', read, maxPack)); return; }
        // oxlint-disable-next-line no-await-in-loop -- see above
        if (length !== null && read > length) { await refuse(c, mismatch(length)); return; }
        if (chunk.length > 0) {
          const out = held;
          held = chunk;
          if (out !== null) { emit(c, out); return; }
        }
      }
    },
    async cancel(why): Promise<void> { await release(why); },
  }, { highWaterMark: 0 });
  return { stream, length: prefix.length + (length === null ? 0 : length), failure: () => failed, sent: () => sent, release };
}
