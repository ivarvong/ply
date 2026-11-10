// A range reader: the one storage interface for a pack (or any bytes) too large to hold. `size` is the whole length;
// `read(offset, length)` streams exactly `length` bytes starting at `offset`, or refuses. The same interface serves a
// file, a memory buffer or an object store (an R2 ranged get), so the pack-subset builder (#235) and the streaming
// index-pack (#248) work over whatever a caller spools into.
import type { PlyError } from './errors.js';
import { fail } from './errors.js';
import type { Result } from './result.js';
import { ok } from './result.js';

export type RangeSource = { readonly size: number; read(offset: number, length: number): Promise<Result<ReadableStream<Uint8Array>, PlyError>> };

const RANGE_CHUNK = 64 * 1024;

// Bytes held in memory as a RangeSource (tests, small packs): each read is a stream of views into `bytes`, never a copy.
export function rangeFromBytes(bytes: Uint8Array): RangeSource {
  return {
    size: bytes.length,
    // async: the interface is a promise, whatever the backing store
    // oxlint-disable-next-line eslint/require-await, typescript/require-await -- see above
    async read(offset: number, length: number): Promise<Result<ReadableStream<Uint8Array>, PlyError>> {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
        return fail('bad_request', `range read: [${offset}, ${offset + length}) is outside 0..${bytes.length}`, { what: 'range' });
      }
      let at = offset;
      const end = offset + length;
      return ok(new ReadableStream<Uint8Array>({
        pull(c): void {
          if (at >= end) { c.close(); return; }
          const next = Math.min(end, at + RANGE_CHUNK);
          c.enqueue(bytes.subarray(at, next));
          at = next;
        },
      }, { highWaterMark: 0 }));
    },
  };
}
