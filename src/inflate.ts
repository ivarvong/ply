// zlib (RFC 1950) + deflate (RFC 1951) inflate that reports bytes consumed.
// Pure at the boundary: inflate(buf, pos, opts) -> { out, consumed, stats }.
// Pack objects are concatenated zlib streams with no length prefix; `consumed`
// is what positions the pack parser at the next object header.

import type { Thrown } from './errors.js';
import { thrown as fail } from './errors.js';
import { take } from './bytes.js';
import { DEFAULT_LIMITS, requireLimit, finiteLimit } from './limits.js';
import {
  ZLIB_HEADER_BYTES, ZLIB_CM_DEFLATE, ZLIB_CM_MASK, ZLIB_FDICT, ZLIB_HEADER_MOD, ADLER_BYTES, ADLER_MOD,
  DEFLATE_BTYPE_BITS, DEFLATE_STORED, DEFLATE_FIXED, DEFLATE_DYNAMIC, DEFLATE_STORED_HEADER_BYTES, DEFLATE_STORED_LEN_MASK,
  DEFLATE_BIT_TABLE, DEFLATE_LITERALS, DEFLATE_EOB, DEFLATE_LENGTH_CODES,
  DEFLATE_HLIT_BASE, DEFLATE_HLIT_BITS, DEFLATE_HDIST_BASE, DEFLATE_HDIST_BITS, DEFLATE_HCLEN_BASE, DEFLATE_HCLEN_BITS,
  DEFLATE_HLIT_MAX, DEFLATE_HDIST_MAX, DEFLATE_CODELEN_CODES, DEFLATE_CODELEN_BITS,
  DEFLATE_REPEAT_PREV, DEFLATE_REPEAT_ZERO3,
  DEFLATE_REPEAT16_BASE, DEFLATE_REPEAT16_BITS, DEFLATE_REPEAT17_BASE, DEFLATE_REPEAT17_BITS,
  DEFLATE_REPEAT18_BASE, DEFLATE_REPEAT18_BITS, DEFLATE_BFINAL_BITS, BYTE_SHIFT, BE32_SHIFTS, ADLER_SHIFT, zlibBound,
} from './format.js';
// BE32_SHIFTS has four entries (format.js); the defaults only satisfy the checker
const [SHIFT0 = 0, SHIFT1 = 0, SHIFT2 = 0] = BE32_SHIFTS;
const bad = (msg: string): Thrown => fail('pack_corrupt', msg);
/* oxlint-disable no-magic-numbers -- RFC 1951 §3.2.5 length/distance alphabets and the fixed Huffman assignment */
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12_289, 16_385, 24_577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

export type Huffman = { readonly count: Uint16Array; readonly symbol: Uint16Array };
// Canonical Huffman table from code lengths (puff algorithm). Returns {count, symbol}.
// Every index below is in range (a length is < DEFLATE_BIT_TABLE); `?? 0` only satisfies the checker.
export function huffBuild(lengths: ArrayLike<number>): Huffman {
  const count = new Uint16Array(DEFLATE_BIT_TABLE);
  const symbol = new Uint16Array(lengths.length);
  const offs = new Uint16Array(DEFLATE_BIT_TABLE);
  // Stryker disable next-line EqualityOperator: one past the end reads undefined, and count[0] is cleared on the next line
  for (let i = 0; i < lengths.length; i++) { const l = lengths[i] ?? 0; count[l] = (count[l] ?? 0) + 1; }
  count[0] = 0;
  // Stryker disable next-line EqualityOperator: offs is DEFLATE_BIT_TABLE long, so the extra index is ignored
  for (let l = 1; l < DEFLATE_BIT_TABLE; l++) offs[l] = (offs[l - 1] ?? 0) + (count[l - 1] ?? 0);
  // Stryker disable next-line EqualityOperator: lengths[lengths.length] is undefined and the if skips it
  for (let s = 0; s < lengths.length; s++) { const l = lengths[s] ?? 0; if (l) { const at = offs[l] ?? 0; symbol[at] = s; offs[l] = at + 1; } }
  return { count, symbol };
}

// lengths 0-143: 8, 144-255: 9, 256-279: 7, 280-287: 8
const FIXED_LIT = huffBuild(new Uint8Array(288).fill(8).fill(9, 144, 256).fill(7, 256, 280));
const FIXED_DIST = huffBuild(new Uint8Array(30).fill(5));
/* oxlint-enable no-magic-numbers */

export function adler32(bytes: Uint8Array, a0 = 1, b0 = 0): number {
  let a = a0;
  let b = b0;
  for (let i = 0; i < bytes.length; i++) { a = (a + (bytes[i] ?? 0)) % ADLER_MOD; b = (b + a) % ADLER_MOD; }
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

// @decoder inflate prefix=inflate

// oxlint-disable-next-line eslint/complexity -- one decoder (header, blocks, trailer); the A1 pass makes it a block state machine
export function inflate(buf: Uint8Array, pos = 0, opts: InflateOptions = {}): Inflated {
  const { expectedSize, verifyAdler = true, raw = false } = opts;
  // Omitted means the object cap. An explicit Infinity used to disable the check (`n > Infinity` is false).
  const maxOutput = opts.maxOutput === undefined ? requireLimit(DEFAULT_LIMITS, 'maxObjectSize') : finiteLimit(opts.maxOutput, 'maxObjectSize');
  const start = pos;
  // bit reader (LSB-first); p is also the zlib header's cursor
  let p = pos;
  let bitbuf = 0;
  let bitcnt = 0;
  const stats: InflateStats = { blocks: 0, stored: 0, fixed: 0, dynamic: 0, literals: 0, matches: 0, matchBytes: 0, maxDist: 0, maxLen: 0 };
  if (!raw) {
    const hdr = take(buf, p, ZLIB_HEADER_BYTES);
    const cmf = hdr[0] ?? 0;
    const flg = hdr[1] ?? 0;
    if ((cmf & ZLIB_CM_MASK) !== ZLIB_CM_DEFLATE) throw bad(`zlib: unsupported method ${cmf & ZLIB_CM_MASK}`);
    if (((cmf << BYTE_SHIFT) | flg) % ZLIB_HEADER_MOD !== 0) throw bad('zlib: bad header check');
    if (flg & ZLIB_FDICT) throw bad('zlib: preset dictionary not supported');
    p += ZLIB_HEADER_BYTES;
  }
  // limit_exceeded without the what/got/max its Detail requires: the untyped call this module always made, kept for the
  // A1 pass (listed in the PR body); hence the cast here and in ensure() below.
  // Stryker disable next-line ConditionalExpression: an omitted expected size is not greater than the limit, so treating this check as true changes nothing
  if (expectedSize !== undefined && expectedSize > maxOutput) throw (fail as (code: 'limit_exceeded', message: string) => Thrown)('limit_exceeded', `inflate: expected size ${expectedSize} exceeds limit ${maxOutput}`); // oxlint-disable-line typescript/no-unsafe-type-assertion -- see above
  // The stream may not run past zlibBound of the size it will produce (format.js): a run of non-final empty stored blocks
  // (5 bytes in, 0 out) used to be consumed to the end of the buffer, so a pack's bytes bounded its CPU, not its objects.
  // Without an expected size the output cap stands in. Checked where a block starts (so an endless stream is refused a
  // few bytes past the bound, before any more of it is read) and when the stream ends (a last block may be long).
  const declared = expectedSize ?? maxOutput;
  const maxInput = zlibBound(declared);
  const tooLong = (n: number): Thrown => bad(`inflate: zlib stream longer than its declared size allows (${n} > ${maxInput} for ${declared} bytes)`);
  // Stryker disable next-line ArithmeticOperator,MethodExpression: the buffer is grown until it holds the output, so a different positive initial guess yields the same bytes
  const guess = Math.max(256, (buf.length - p) * 3); // oxlint-disable-line no-magic-numbers -- output-buffer growth, not a wire-format fact
  let out = new Uint8Array(expectedSize ?? Math.min(maxOutput, guess));
  let o = 0;
  const ensure = (n: number): void => {
    if (o + n <= out.length) return;
    if (expectedSize !== undefined) throw bad(`inflate: output exceeds expected ${expectedSize}`);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- limit_exceeded without its Detail, as above
    if (o + n > maxOutput) throw (fail as (code: 'limit_exceeded', message: string) => Thrown)('limit_exceeded', `inflate: output exceeds limit ${maxOutput}`);
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
      v |= (buf[p++] ?? 0) << bitcnt; bitcnt += BYTE_SHIFT;
    }
    bitbuf = v >>> n; bitcnt -= n;
    return v & ((1 << n) - 1);
  };
  const decode = (h: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < DEFLATE_BIT_TABLE; len++) {
      code |= bits(1); // oxlint-disable-line oxc/bad-bitwise-operator -- puff's decode: the next bit goes in at bit 0
      const c = h.count[len] ?? 0;
      if (code - first < c) return h.symbol[index + code - first] ?? 0;
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
      const len = (LBASE[li] ?? 0) + bits(LEXT[li] ?? 0);
      const di = decode(dist);
      // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral: ndist cannot exceed DEFLATE_HDIST_MAX, so a distance symbol is never out of that table
      if (di >= DEFLATE_HDIST_MAX) throw bad('inflate: bad distance symbol');
      const d = (DBASE[di] ?? 0) + bits(DEXT[di] ?? 0);
      if (d > o) throw bad('inflate: distance too far back');
      ensure(len);
      stats.matches++; stats.matchBytes += len;
      // Stryker disable next-line EqualityOperator: writing the same maximum when the distance is equal does not change the stat
      if (d > stats.maxDist) stats.maxDist = d;
      // Stryker disable next-line EqualityOperator: writing the same maximum when the length is equal does not change the stat
      if (len > stats.maxLen) stats.maxLen = len;
      let from = o - d;
      for (let i = 0; i < len; i++) out[o++] = out[from++] ?? 0; // overlap is intentional
    }
  };

  let last: number;
  do {
    if (p - start > maxInput) throw tooLong(p - start);
    last = bits(DEFLATE_BFINAL_BITS);
    const type = bits(DEFLATE_BTYPE_BITS);
    stats.blocks++;
    if (type === DEFLATE_STORED) {
      stats.stored++;
      bitbuf = 0; bitcnt = 0; // discard to byte boundary
      if (p + DEFLATE_STORED_HEADER_BYTES > buf.length) throw bad('inflate: truncated stored header');
      const sh = buf.subarray(p, p + DEFLATE_STORED_HEADER_BYTES); // in range: checked on the line above
      const len = (sh[0] ?? 0) | ((sh[1] ?? 0) << BYTE_SHIFT);
      const nlen = (sh[2] ?? 0) | ((sh[3] ?? 0) << BYTE_SHIFT);
      if (len !== (~nlen & DEFLATE_STORED_LEN_MASK)) throw bad('inflate: stored length check failed');
      p += DEFLATE_STORED_HEADER_BYTES;
      if (p + len > buf.length) throw bad('inflate: truncated stored block');
      ensure(len); out.set(buf.subarray(p, p + len), o); o += len; p += len; // in range: "truncated stored block" above
    } else if (type === DEFLATE_FIXED) {
      stats.fixed++;
      codes(FIXED_LIT, FIXED_DIST);
    } else if (type === DEFLATE_DYNAMIC) {
      stats.dynamic++;
      const nlen = bits(DEFLATE_HLIT_BITS) + DEFLATE_HLIT_BASE;
      const ndist = bits(DEFLATE_HDIST_BITS) + DEFLATE_HDIST_BASE;
      const ncode = bits(DEFLATE_HCLEN_BITS) + DEFLATE_HCLEN_BASE;
      if (nlen > DEFLATE_HLIT_MAX || ndist > DEFLATE_HDIST_MAX) throw bad('inflate: bad dynamic counts');
      const lengths = new Uint8Array(DEFLATE_HLIT_MAX + DEFLATE_HDIST_MAX);
      for (let i = 0; i < ncode; i++) lengths[CLORDER[i] ?? 0] = bits(DEFLATE_CODELEN_BITS);
      const lencode = huffBuild(lengths.subarray(0, DEFLATE_CODELEN_CODES));
      let i = 0;
      while (i < nlen + ndist) {
        const sym = decode(lencode);
        if (sym < DEFLATE_REPEAT_PREV) { lengths[i++] = sym; continue; }
        let rep: number;
        let val = 0;
        if (sym === DEFLATE_REPEAT_PREV && i === 0) throw bad('inflate: repeat with no previous');
        if (sym === DEFLATE_REPEAT_PREV) { val = lengths[i - 1] ?? 0; rep = DEFLATE_REPEAT16_BASE + bits(DEFLATE_REPEAT16_BITS); }
        else if (sym === DEFLATE_REPEAT_ZERO3) rep = DEFLATE_REPEAT17_BASE + bits(DEFLATE_REPEAT17_BITS);
        else rep = DEFLATE_REPEAT18_BASE + bits(DEFLATE_REPEAT18_BITS);
        if (i + rep > nlen + ndist) throw bad('inflate: repeat overflow');
        while (rep--) lengths[i++] = val;
      }
      if (lengths[DEFLATE_EOB] === 0) throw bad('inflate: no end-of-block code');
      codes(huffBuild(Array.from(lengths.subarray(0, nlen))), huffBuild(Array.from(lengths.subarray(nlen, nlen + ndist))));
    } else throw bad('inflate: invalid block type');
  } while (!last);

  const result = out.subarray(0, o);
  if (!raw) {
    if (p + ADLER_BYTES > buf.length) throw bad('inflate: truncated adler32');
    const ad = buf.subarray(p, p + ADLER_BYTES); // in range: checked on the line above
    const want = (((ad[0] ?? 0) << SHIFT0) | ((ad[1] ?? 0) << SHIFT1) | ((ad[2] ?? 0) << SHIFT2) | (ad[3] ?? 0)) >>> 0;
    if (verifyAdler && adler32(result) !== want) throw bad('inflate: adler32 mismatch');
    p += ADLER_BYTES;
  }
  if (expectedSize !== undefined && o !== expectedSize) throw bad(`inflate: size ${o} != expected ${expectedSize}`);
  if (p - start > maxInput) throw tooLong(p - start);
  return { out: result, consumed: p - start, stats };
}
