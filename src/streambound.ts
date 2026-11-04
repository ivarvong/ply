// Peak byte-buffer bound of each streamed operation, in terms of its inputs (issue #172). What a caller keeps (the
// object it asked for, the pack bytes it retains) is on top; what the stream itself holds is this.
//   pkt-line, sideband: the chunk a frame was cut from and the one copied frame (pktStep copies a payload).
//   inflate, a pack scan that drops each object, a blob read that drops each chunk: the 32 KiB window, one yielded
//     chunk, and one pkt-line of unread input.
//   fetch of one object of S bytes (fetchSingle): S, written into one buffer, plus the inflate hold.
//   fetch that retains R bytes of a pack: R plus the inflate hold.
// test/stream-memory.test.js measures each against these.
import { assertNever } from './result.js';
import { INFLATE_WINDOW, INFLATE_CHUNK, PKT_MAX_SIZE } from './format.js';

const HOLD: number = INFLATE_WINDOW + INFLATE_CHUNK + PKT_MAX_SIZE;
const FRAME: number = PKT_MAX_SIZE + PKT_MAX_SIZE;

export type PeakQuery =
  | { readonly kind: 'pkt' }
  | { readonly kind: 'sideband' }
  | { readonly kind: 'inflate' }
  | { readonly kind: 'pack-scan' }
  | { readonly kind: 'blob-read' }
  | { readonly kind: 'fetch-object'; readonly output: number }
  | { readonly kind: 'fetch-pack'; readonly retained: number };

export function peakBound(q: PeakQuery): number {
  switch (q.kind) {
    case 'pkt': case 'sideband': return FRAME;
    case 'inflate': case 'pack-scan': case 'blob-read': return HOLD;
    case 'fetch-object': return q.output + HOLD;
    case 'fetch-pack': return q.retained + HOLD;
  }
  // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(q);
}
