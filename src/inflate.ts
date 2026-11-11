// zlib (RFC 1950) + deflate (RFC 1951) inflate of a buffer in hand, reporting the bytes it consumed: a collector over the
// pull decoder (inflatestream.ts), which is the only deflate decoder in ply (#172). Pack objects are concatenated zlib
// streams with no length prefix; `consumed` is what positions a buffered reader at the next object header.
import type { Result } from './result.js';
import { ok, assertNever } from './result.js';
import { fail } from './errors.js';
import { fromNullable, fromNullish, type Input } from './absent.js';
import { DEFAULT_LIMITS } from './limits.js';
import type { InflateStats, InflateError } from './inflatestream.js';
import { inflateInit, inflateFeed, inflateEnd, declaredBound, cappedBound, zlibWrap, rawWrap } from './inflatestream.js';

export type { Huffman, InflateStats, InflateError } from './inflatestream.js';
export { huffBuild, adler32, FIXED_LIT, FIXED_DIST, CLORDER, DEFLATE_TABLES } from './inflatestream.js';

// expectedSize: the size the output must have (a pack header's); maxOutput: the cap on the output (limits.maxObjectSize
// when left out); verifyAdler: check the zlib trailer's checksum (default true); raw: a deflate stream with no zlib
// header or trailer (default false).
export type InflateConfig = {
  readonly expectedSize: number;
  readonly maxOutput: number;
  readonly verifyAdler: boolean;
  readonly raw: boolean;
};
export type InflateOptions = Input<InflateConfig>;
// The first output buffer without a declared size: at least this, or the input's length (a stored member's output).
const GUESS_MIN = 256;
// The output buffer doubles when it is full.
const GROWTH = 2;
export type Inflated = { readonly out: Uint8Array; readonly consumed: number; readonly stats: InflateStats };

// The member at buf[pos..], whole: the input is closed once it is fed, so the pull ends the member or says where it was
// cut. With a declared size the output is one buffer of that size; without one, the chunks joined once at the end.
// pos is a position in buf: a non-negative safe integer no greater than buf.length (at the end there are no bytes, a
// cut member). Anything else is `bad_request` before a byte is read: subarray reads a negative offset from the end of
// the buffer and coerces a string or a fraction, so an unchecked pos inflated bytes the caller never named (or threw).
// @decoder inflate prefix=inflate
export function inflate(buf: Uint8Array, pos = 0, opts: InflateOptions = {}): Result<Inflated, InflateError> {
  // isSafeInteger is false for every non-number (no coercion); the message names the type, never an unbounded value
  if (!Number.isSafeInteger(pos) || pos < 0 || pos > buf.length) return fail('bad_request', `inflate: pos (${typeof pos === 'number' ? String(pos) : typeof pos}) is not a position in a buffer of ${buf.length} bytes`);
  const { verifyAdler = true, raw = false } = opts;
  const expected = fromNullish(opts.expectedSize);
  // Omitted means the object cap; a given cap is checked by the pull (inflateInit), so `null` is bad_request there.
  const givenMax = fromNullable(opts.maxOutput);
  const maxOutput = givenMax.tag === 'some' ? givenMax.value : DEFAULT_LIMITS.maxObjectSize;
  const bound = expected.tag === 'some' ? declaredBound(expected.value, maxOutput) : cappedBound(maxOutput);
  const opened = inflateInit({ bound, wrap: raw ? rawWrap() : zlibWrap(verifyAdler) });
  if (!opened.ok) return opened;
  const st = opened.value;
  inflateFeed(st, buf.subarray(pos));
  // A declared size: the pull never yields past it, so the chunks land in one buffer of that size, made when the first
  // chunk arrives (a size past the cap is refused at the zlib header, before anything is allocated). Without one the
  // buffer starts at a guess and doubles, held to the cap (the pull refuses output past it before the buffer grows).
  let out = new Uint8Array(0);
  let o = 0;
  const room = (n: number): void => {
    // Stryker disable next-line EqualityOperator: at an exact fit, `<` grows a new buffer and copies the output into it: the same bytes come out
    if (o + n <= out.length) return;
    // Stryker disable next-line ArithmeticOperator,MethodExpression,ConditionalExpression: the buffer is grown until it holds the output, so a different positive first size yields the same bytes
    let cap = expected.tag === 'some' ? expected.value : Math.min(maxOutput, Math.max(out.length * GROWTH, GUESS_MIN, buf.length - pos));
    // Stryker disable next-line ArithmeticOperator,MethodExpression,EqualityOperator: doubling stops once the buffer holds o+n, which the pull held within the cap
    while (cap < o + n) cap = Math.min(maxOutput, cap * GROWTH);
    const grown = new Uint8Array(cap);
    grown.set(out.subarray(0, o));
    out = grown;
  };
  for (;;) {
    const r = inflateEnd(st);
    if (!r.ok) return r;
    const piece = r.value;
    switch (piece.kind) {
      case 'end': return ok({ out: out.subarray(0, o), consumed: piece.consumed, stats: piece.stats });
      case 'chunk':
        room(piece.bytes.length);
        out.set(piece.bytes, o);
        o += piece.bytes.length;
        continue;
      // Stryker disable next-line all: a closed input never answers `need` (inflateEnd refuses the cut instead)
      case 'need': continue;
    }
    // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: unreachable, the compiler's exhaustiveness check
    return assertNever(piece);
  }
}
