// The streamed pack writer push sends (#172). The pack is deflated twice and never held:
//   measurePack (pass 1)  deflates every object, keeping only its length, its SHA-1 and each entry's numbers, so a pack
//                         over the cap is refused before the first request byte (push.ts, I36);
//   streamPack (pass 2)   deflates them again into the request body as it is read, and ends the body with the trailer
//                         only when this pass gave the same length and SHA-1 as the first.
// A pack no longer than INFLATE_CHUNK is kept from pass 1 and sent as bytes (no second pass). Either way the writer holds
// at most one deflate chunk and the pieces under INFLATE_CHUNK beside the caller's objects: a push whose largest object
// is L peaks at L + INFLATE_CHUNK.
// Both passes feed CompressionStream the same input in the same INFLATE_CHUNK slices, so zlib (deterministic for a fixed
// input sequence and parameters) writes the same bytes (test/packwrite.test.js, node and workerd). If it ever did not,
// pass 2 errors its stream before the trailer: the server is never handed a pack that is whole, and push reports it.
// The bytes are buildPack's (pack.ts) for the same objects: the same headers, bases and zlib streams.
import { streamingSha1, fromHex, toHex } from './sha1.js';
import { builtEntry, entryHead, packHeader } from './pack.js';
import type { BuiltEntry, PackInput } from './pack.js';
import { bufferSource, concat } from './bytes.js';
import { plyError } from './errors.js';
import type { ErrorOf } from './errors.js';
import { INFLATE_CHUNK, PACK_HEADER_BYTES, PACK_TRAILER_BYTES } from './format.js';

// One object's zlib stream, pulled: the object goes into CompressionStream in INFLATE_CHUNK slices as the output is read
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
      const end = Math.min(next + INFLATE_CHUNK, bytes.length);
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
