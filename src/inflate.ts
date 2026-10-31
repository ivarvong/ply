// zlib (RFC 1950) + deflate (RFC 1951) inflate that reports bytes consumed.
// Pure at the boundary: inflateResult(buf, pos, opts) -> Result<{ out, consumed, stats }>; inflate is its throwing form.
// Pack objects are concatenated zlib streams with no length prefix; `consumed`
// is what positions the pack parser at the next object header.

import type { ErrorOf } from './errors.js';
import { plyError, orThrow } from './errors.js';
import type { Err, Result } from './result.js';
import { ok, err, assertNever } from './result.js';
import { DEFAULT_LIMITS, checkLimit } from './limits.js';
import { takeResult } from './bytes.js';
import {
  ZLIB_HEADER_BYTES, ZLIB_CM_DEFLATE, ZLIB_CM_MASK, ZLIB_FDICT, ZLIB_HEADER_MOD, ADLER_BYTES, ADLER_MOD,
  DEFLATE_BTYPE_BITS, DEFLATE_STORED_HEADER_BYTES, DEFLATE_STORED_LEN_MASK,
  DEFLATE_BIT_TABLE, DEFLATE_LITERALS, DEFLATE_EOB, DEFLATE_LENGTH_CODES,
  DEFLATE_HLIT_BASE, DEFLATE_HLIT_BITS, DEFLATE_HDIST_BASE, DEFLATE_HDIST_BITS, DEFLATE_HCLEN_BASE, DEFLATE_HCLEN_BITS,
  DEFLATE_HLIT_MAX, DEFLATE_HDIST_MAX, DEFLATE_CODELEN_CODES, DEFLATE_CODELEN_BITS,
  DEFLATE_REPEAT_PREV, DEFLATE_REPEAT_ZERO3,
  DEFLATE_REPEAT16_BASE, DEFLATE_REPEAT16_BITS, DEFLATE_REPEAT17_BASE, DEFLATE_REPEAT17_BITS,
  DEFLATE_REPEAT18_BASE, DEFLATE_REPEAT18_BITS, DEFLATE_BFINAL_BITS, BYTE_SHIFT, BE32_SHIFTS, ADLER_SHIFT, zlibBound,
} from './format.js';
/* oxlint-disable no-magic-numbers -- RFC 1951 §3.2.5 length/distance alphabets and the fixed Huffman assignment */
// The length and distance alphabets, built as RFC 1951 §3.2.5 defines them: each code's extra bits, and a base that is
// the previous base plus the previous code's range (2^extra). Length code 285 is the exception: 0 extra bits, base 258.
// test/mutant-kill.test.js holds these against the RFC's printed tables.
const LBASE: number[] = [];
const LEXT: number[] = [];
const DBASE: number[] = [];
const DEXT: number[] = [];
for (let i = 0, base = 3; i < 29; i++) { const x = i < 8 || i === 28 ? 0 : (i >> 2) - 1; LEXT.push(x); LBASE.push(i === 28 ? 258 : base); base += 1 << x; }
for (let i = 0, base = 1; i < 30; i++) { const x = i < 4 ? 0 : (i >> 1) - 1; DEXT.push(x); DBASE.push(base); base += 1 << x; }
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

export const DEFLATE_TABLES: { readonly LBASE: readonly number[]; readonly LEXT: readonly number[]; readonly DBASE: readonly number[]; readonly DEXT: readonly number[] } = /* @__PURE__ */ Object.freeze({ LBASE, LEXT, DBASE, DEXT });

export type Huffman = { readonly count: Uint16Array; readonly symbol: Uint16Array };
// Canonical Huffman table from code lengths (puff algorithm). Returns {count, symbol}.
// Indexed reads in this file are in range (each is bounded where it is read, as the comments there say), which
// noUncheckedIndexedAccess cannot see; `as number` says so at no runtime cost (a `?? 0` per read is bundle bytes).
/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- in-range indexed reads, see above (`as number`, not the `!` src/ forbids) */
export function huffBuild(lengths: ArrayLike<number>): Huffman {
  const count = new Uint16Array(DEFLATE_BIT_TABLE);
  const symbol = new Uint16Array(lengths.length);
  const offs = new Uint16Array(DEFLATE_BIT_TABLE);
  // Stryker disable next-line EqualityOperator: one past the end reads undefined, and count[0] is cleared on the next line
  // not `(count[k] as number)++`: Stryker drops the parentheses when it mutates that form and the file no longer parses
  for (let i = 0; i < lengths.length; i++) { const k = lengths[i] as number; count[k] = (count[k] as number) + 1; }
  count[0] = 0;
  // Stryker disable next-line EqualityOperator: offs is DEFLATE_BIT_TABLE long, so the extra index is ignored
  for (let l = 1; l < DEFLATE_BIT_TABLE; l++) offs[l] = (offs[l - 1] as number) + (count[l - 1] as number);
  // Stryker disable next-line EqualityOperator: lengths[lengths.length] is undefined and the if skips it
  for (let s = 0; s < lengths.length; s++) { const k = lengths[s] as number; if (k) { const at = offs[k] as number; offs[k] = at + 1; symbol[at] = s; } }
  return { count, symbol };
}

// lengths 0-143: 8, 144-255: 9, 256-279: 7, 280-287: 8
const FIXED_LIT = huffBuild(new Uint8Array(288).fill(8).fill(9, 144, 256).fill(7, 256, 280));
const FIXED_DIST = huffBuild(new Uint8Array(30).fill(5));
/* oxlint-enable no-magic-numbers */

export function adler32(bytes: Uint8Array, a = 1, b = 0): number {
  // oxlint-disable-next-line no-param-reassign -- a and b are the running sums a caller may seed; updating them is the algorithm
  for (let i = 0; i < bytes.length; i++) { a = (a + (bytes[i] as number)) % ADLER_MOD; b = (b + a) % ADLER_MOD; }
  return ((b << ADLER_SHIFT) | a) >>> 0;
}

export type InflateOptions = {
  readonly expectedSize?: number | undefined;
  readonly maxOutput?: number | undefined;
  readonly verifyAdler?: boolean | undefined;
  readonly raw?: boolean | undefined;
};
export type InflateStats = {
  blocks: number; stored: number; fixed: number; dynamic: number;
  literals: number; matches: number; matchBytes: number; maxDist: number; maxLen: number;
};
export type Inflated = { readonly out: Uint8Array; readonly consumed: number; readonly stats: InflateStats };
export type InflateError = ErrorOf<'pack_corrupt'> | ErrorOf<'limit_exceeded'> | ErrorOf<'bad_request'>;

// A deflate block's type (BTYPE, RFC 1951 §3.2.3), indexed by its two bits: 3 is reserved, an invalid block.
export type BlockType = 'stored' | 'fixed' | 'dynamic';
// DEFLATE_STORED, DEFLATE_FIXED, DEFLATE_DYNAMIC (format.ts) are these indices
const BLOCK_TYPE: ReadonlyArray<BlockType | undefined> = ['stored', 'fixed', 'dynamic'];
// Thrown only inside inflateResult, by the step that put its error in the slot, and caught there (below). One Error made
// once (lint: only errors are thrown); it carries nothing, the slot does.
const STOP: Error = new Error('inflate: stop');
const corrupt = (msg: string): Err<ErrorOf<'pack_corrupt'>> => err(plyError('pack_corrupt', msg));

// @decoder inflateResult prefix=inflate
// oxlint-disable-next-line eslint/complexity -- one decoder (header, blocks by exhaustive block type, trailer)
export function inflateResult(buf: Uint8Array, pos = 0, opts: InflateOptions = {}): Result<Inflated, InflateError> {
  const { expectedSize, verifyAdler = true, raw = false } = opts;
  // Omitted means the object cap. An explicit Infinity used to disable the check (`n > Infinity` is false).
  let maxOutput = DEFAULT_LIMITS.maxObjectSize;
  if (opts.maxOutput !== undefined) {
    const m = checkLimit(opts.maxOutput, 'maxObjectSize');
    if (!m.ok) return m;
    maxOutput = m.value;
  }
  // The error slot. The bit reader, the Huffman decoder and the block loop are a hot loop of small closures: a Result
  // per bit would allocate per bit, so a failing step puts its error here and throws STOP, the one value the try
  // around the loop turns back into an Err. Anything else thrown is a bug and propagates.
  let failure: InflateError | undefined;
  const bad = (msg: string): Error => { failure = plyError('pack_corrupt', msg); return STOP; };
  const over = (msg: string, what: string, got: number): Error => { failure = plyError('limit_exceeded', msg, { what, got, max: maxOutput }); return STOP; };
  const start = pos;
  const stats: InflateStats = { blocks: 0, stored: 0, fixed: 0, dynamic: 0, literals: 0, matches: 0, matchBytes: 0, maxDist: 0, maxLen: 0 };
  // bit reader (LSB-first); p is also the zlib header's cursor
  let p = pos;
  let bitbuf = 0;
  let bitcnt = 0;
  if (!raw) {
    const hdr = takeResult(buf, p, ZLIB_HEADER_BYTES);
    if (!hdr.ok) return hdr;
    const cmf = hdr.value[0] as number;
    const flg = hdr.value[1] as number;
    if ((cmf & ZLIB_CM_MASK) !== ZLIB_CM_DEFLATE) return corrupt(`zlib: unsupported method ${cmf & ZLIB_CM_MASK}`);
    if (((cmf << BYTE_SHIFT) | flg) % ZLIB_HEADER_MOD !== 0) return corrupt('zlib: bad header check');
    if (flg & ZLIB_FDICT) return corrupt('zlib: preset dictionary not supported');
    p += ZLIB_HEADER_BYTES;
  }
  // Stryker disable next-line ConditionalExpression: an omitted expected size is not greater than the limit, so treating this check as true changes nothing
  if (expectedSize !== undefined && expectedSize > maxOutput) return err(plyError('limit_exceeded', `inflate: expected size ${expectedSize} exceeds limit ${maxOutput}`, { what: 'inflate expected size', got: expectedSize, max: maxOutput }));
  // The stream may not run past zlibBound of the size it will produce (format.js): a run of non-final empty stored blocks
  // (5 bytes in, 0 out) used to be consumed to the end of the buffer, so a pack's bytes bounded its CPU, not its objects.
  // Without an expected size the output cap stands in. Checked where a block starts (so an endless stream is refused a
  // few bytes past the bound, before any more of it is read) and when the stream ends (a last block may be long).
  const declared = expectedSize ?? maxOutput;
  const maxInput = zlibBound(declared);
  const tooLongMsg = (n: number): string => `inflate: zlib stream longer than its declared size allows (${n} > ${maxInput} for ${declared} bytes)`;
  // Stryker disable next-line ArithmeticOperator,MethodExpression: the buffer is grown until it holds the output, so a different positive initial guess yields the same bytes
  const guess = Math.max(256, (buf.length - p) * 3); // oxlint-disable-line no-magic-numbers -- output-buffer growth, not a wire-format fact
  let out = new Uint8Array(expectedSize ?? Math.min(maxOutput, guess));
  let o = 0;
  const ensure = (n: number): void => {
    if (o + n <= out.length) return;
    if (expectedSize !== undefined) throw bad(`inflate: output exceeds expected ${expectedSize}`);
    if (o + n > maxOutput) throw over(`inflate: output exceeds limit ${maxOutput}`, 'inflate output', o + n);
    // Stryker disable next-line ArithmeticOperator,MethodExpression: o+n is already refused past maxOutput, so a larger spare capacity returns the same bytes
    let cap = Math.min(maxOutput, out.length * 2); // oxlint-disable-line no-magic-numbers -- output-buffer growth, not a wire-format fact
    // Stryker disable next-line ArithmeticOperator,MethodExpression: doubling stops once the buffer holds o+n, which is already within maxOutput
    while (cap < o + n) cap = Math.min(maxOutput, cap * 2); // oxlint-disable-line no-magic-numbers -- output-buffer growth, not a wire-format fact
    const nb = new Uint8Array(cap); nb.set(out.subarray(0, o)); out = nb;
  };

  const bits = (n: number): number => {
    let v = bitbuf;
    while (bitcnt < n) {
      if (p >= buf.length) throw bad('inflate: unexpected end of input');
      v |= (buf[p++] as number) << bitcnt; bitcnt += BYTE_SHIFT;
    }
    bitbuf = v >>> n; bitcnt -= n;
    return v & ((1 << n) - 1);
  };
  // puff's decode, one code bit at a time, the bit read inline: a call to bits(1) per code bit was the hot spot (PR body)
  const decode = (h: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < DEFLATE_BIT_TABLE; len++) {
      if (bitcnt === 0) {
        if (p >= buf.length) throw bad('inflate: unexpected end of input');
        bitbuf = buf[p++] as number; bitcnt = BYTE_SHIFT;
      }
      code |= bitbuf & 1; bitbuf >>>= 1; bitcnt--; // oxlint-disable-line oxc/bad-bitwise-operator -- puff's decode: the next bit goes in at bit 0
      const c = h.count[len] as number;
      if (code - first < c) return h.symbol[index + code - first] as number;
      index += c; first = (first + c) << 1; code <<= 1;
    }
    throw bad('inflate: invalid huffman code');
  };
  const codes = (lit: Huffman, dist: Huffman): void => {
    for (;;) {
      const sym = decode(lit);
      if (sym < DEFLATE_LITERALS) { ensure(1); out[o++] = sym; stats.literals++; continue; }
      if (sym === DEFLATE_EOB) return;
      const li = sym - DEFLATE_HLIT_BASE;
      if (li >= DEFLATE_LENGTH_CODES) throw bad('inflate: bad length symbol');
      const len = (LBASE[li] as number) + bits(LEXT[li] as number);
      const di = decode(dist);
      // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral: ndist cannot exceed DEFLATE_HDIST_MAX, so a distance symbol is never out of that table
      if (di >= DEFLATE_HDIST_MAX) throw bad('inflate: bad distance symbol');
      const d = (DBASE[di] as number) + bits(DEXT[di] as number);
      if (d > o) throw bad('inflate: distance too far back');
      ensure(len);
      stats.matches++; stats.matchBytes += len;
      // Stryker disable next-line EqualityOperator: writing the same maximum when the distance is equal does not change the stat
      if (d > stats.maxDist) stats.maxDist = d;
      // Stryker disable next-line EqualityOperator: writing the same maximum when the length is equal does not change the stat
      if (len > stats.maxLen) stats.maxLen = len;
      // A match that does not overlap its own output is one copy; an overlapping one repeats its last d bytes, so it is
      // copied byte by byte (the overlap is the encoding: `d = 1, len = 258` is a run of one byte).
      if (d >= len) { out.copyWithin(o, o - d, o - d + len); o += len; }
      else { let from = o - d; for (let i = 0; i < len; i++) out[o++] = out[from++] as number; }
    }
  };
  // One block: its header bits are read, then its body by its type, exhaustively.
  const block = (type: BlockType | undefined): void => {
    switch (type) {
      case 'stored': {
        stats.stored++;
        bitbuf = 0; bitcnt = 0; // discard to byte boundary
        if (p + DEFLATE_STORED_HEADER_BYTES > buf.length) throw bad('inflate: truncated stored header');
        const sh = buf.subarray(p, p + DEFLATE_STORED_HEADER_BYTES); // in range: checked on the line above
        const len = (sh[0] as number) | ((sh[1] as number) << BYTE_SHIFT);
        const nlen = (sh[2] as number) | ((sh[3] as number) << BYTE_SHIFT);
        if (len !== (~nlen & DEFLATE_STORED_LEN_MASK)) throw bad('inflate: stored length check failed');
        p += DEFLATE_STORED_HEADER_BYTES;
        if (p + len > buf.length) throw bad('inflate: truncated stored block');
        ensure(len); out.set(buf.subarray(p, p + len), o); o += len; p += len; // in range: "truncated stored block" above
        return;
      }
      case 'fixed':
        stats.fixed++;
        codes(FIXED_LIT, FIXED_DIST);
        return;
      case 'dynamic': {
        stats.dynamic++;
        const nlen = bits(DEFLATE_HLIT_BITS) + DEFLATE_HLIT_BASE;
        const ndist = bits(DEFLATE_HDIST_BITS) + DEFLATE_HDIST_BASE;
        const ncode = bits(DEFLATE_HCLEN_BITS) + DEFLATE_HCLEN_BASE;
        if (nlen > DEFLATE_HLIT_MAX || ndist > DEFLATE_HDIST_MAX) throw bad('inflate: bad dynamic counts');
        const lengths = new Uint8Array(DEFLATE_HLIT_MAX + DEFLATE_HDIST_MAX);
        for (let i = 0; i < ncode; i++) lengths[CLORDER[i] as number] = bits(DEFLATE_CODELEN_BITS);
        const lencode = huffBuild(lengths.subarray(0, DEFLATE_CODELEN_CODES));
        let i = 0;
        while (i < nlen + ndist) {
          const sym = decode(lencode);
          if (sym < DEFLATE_REPEAT_PREV) { lengths[i++] = sym; continue; }
          let rep: number;
          let val = 0;
          if (sym === DEFLATE_REPEAT_PREV && i === 0) throw bad('inflate: repeat with no previous');
          if (sym === DEFLATE_REPEAT_PREV) { val = lengths[i - 1] as number; rep = DEFLATE_REPEAT16_BASE + bits(DEFLATE_REPEAT16_BITS); }
          else if (sym === DEFLATE_REPEAT_ZERO3) rep = DEFLATE_REPEAT17_BASE + bits(DEFLATE_REPEAT17_BITS);
          else rep = DEFLATE_REPEAT18_BASE + bits(DEFLATE_REPEAT18_BITS); // 18: lencode has 19 symbols, 0-18
          if (i + rep > nlen + ndist) throw bad('inflate: repeat overflow');
          while (rep--) lengths[i++] = val;
        }
        if (lengths[DEFLATE_EOB] === 0) throw bad('inflate: no end-of-block code');
        codes(huffBuild(Array.from(lengths.subarray(0, nlen))), huffBuild(Array.from(lengths.subarray(nlen, nlen + ndist))));
        return;
      }
      case undefined: throw bad('inflate: invalid block type');
      default: assertNever(type);
    }
  };

  try {
    let last: number;
    do {
      if (p - start > maxInput) throw bad(tooLongMsg(p - start));
      last = bits(DEFLATE_BFINAL_BITS);
      const type = BLOCK_TYPE[bits(DEFLATE_BTYPE_BITS)];
      stats.blocks++;
      block(type);
    } while (!last);
  } catch (e) {
    if (e === STOP && failure) return err(failure);
    throw e;
  }

  const result = out.subarray(0, o);
  if (!raw) {
    if (p + ADLER_BYTES > buf.length) return corrupt('inflate: truncated adler32');
    const ad = buf.subarray(p, p + ADLER_BYTES); // in range: checked on the line above
    const want = (((ad[0] as number) << (BE32_SHIFTS[0] as number)) | ((ad[1] as number) << (BE32_SHIFTS[1] as number)) | ((ad[2] as number) << (BE32_SHIFTS[2] as number)) | (ad[3] as number)) >>> 0;
    if (verifyAdler && adler32(result) !== want) return corrupt('inflate: adler32 mismatch');
    p += ADLER_BYTES;
  }
  if (expectedSize !== undefined && o !== expectedSize) return corrupt(`inflate: size ${o} != expected ${expectedSize}`);
  if (p - start > maxInput) return corrupt(tooLongMsg(p - start));
  return ok({ out: result, consumed: p - start, stats });
}
// @decoder inflate prefix=inflate
export function inflate(buf: Uint8Array, pos = 0, opts: InflateOptions = {}): Inflated { return orThrow(inflateResult(buf, pos, opts)); }
