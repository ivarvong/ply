// Peak byte-buffer bound for each streamed operation, in terms of its inputs.
// A pkt-line or sideband frame keeps the chunk it was cut from and one copied frame.
// Inflate, a pack scan that drops each object, and a blob read that drops each chunk keep the deflate
// window, one yielded chunk, and one pkt-line of unread input.
// A fetch that returns an object also keeps that object. A fetch that retains R bytes of the pack keeps R.
// A push keeps the largest object and one deflate chunk: the pack is deflated twice so the size is known
// before the first byte goes out, and the bytes are not held as a second copy.

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
  | { readonly kind: 'fetch-pack'; readonly retained: number }
  | { readonly kind: 'push'; readonly largest: number };

export function peakBound(q: PeakQuery): number {
  switch (q.kind) {
    case 'pkt': return FRAME;
    case 'sideband': return FRAME;
    case 'inflate': return HOLD;
    case 'pack-scan': return HOLD;
    case 'blob-read': return HOLD;
    case 'fetch-object': return q.output + HOLD;
    case 'fetch-pack': return q.retained + HOLD;
    case 'push': return q.largest + INFLATE_CHUNK;
    default: return assertNever(q);
  }
}
