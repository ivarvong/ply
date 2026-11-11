// A random-access byte source: `size` bytes, read as a stream of [offset, offset + length). The one storage interface
// the pack-over-a-spool code takes (#235, #248), so the same code works over a file, a memory buffer or an object store
// (an R2 ranged GET). A read past `size`, or a negative or fractional bound, is the source's refusal to make; the stream
// yields exactly `length` bytes or errors.
import type { PlyError } from './errors.js';
import { fail } from './errors.js';
import type { Result } from './result.js';
import { ok } from './result.js';

// `signal` aborts when the reader no longer wants the range (its consumer cancelled): a source that can abandon a read in
// flight does; one that ignores it (a read of two parameters is still a RangeSource) is never waited for by packSubset.
export type RangeSource = { readonly size: number; read(offset: number, length: number, signal: AbortSignal): Promise<Result<ReadableStream<Uint8Array>, PlyError>> };

// The signal of a read that nothing can cancel yet: its caller takes no abort signal and has no consumer to cancel it
// (packIdentity, resolvePackRange, loadTransferPack). A source that never answers one of these is waited for.
export const UNCANCELLABLE: AbortSignal = new AbortController().signal;

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
