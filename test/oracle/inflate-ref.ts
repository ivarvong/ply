// The buffered decoder ply had before #172 made inflate() a collector over the pull (src/inflatestream.ts), tables and
// all: kept in test/ as an independent oracle. test/packstream.test.js holds the one decoder in src/ to it (bytes,
// consumed count, stats) for every chunking, so a mutant there cannot pass by changing both sides of the comparison.
// It does not know the zlib window (a back-reference past CINFO's window is taken if it lands in the output) and reads
// CINFO 8..15 as the header checksum alone; the pull refuses both, and the tests name the difference.

import type { ErrorOf } from '../../src/errors.js';
import { fail } from '../../src/errors.js';
import type { Err, Result } from '../../src/result.js';
import { ok, assertNever, getOrElse } from '../../src/result.js';
import { fromNullable, fromNullish, type Input } from '../../src/absent.js';
import { DEFAULT_LIMITS, checkLimit } from '../../src/limits.js';
import { take } from '../../src/bytes.js';
import {
  ZLIB_HEADER_BYTES, ZLIB_CM_DEFLATE, ZLIB_CM_MASK, ZLIB_FDICT, ZLIB_HEADER_MOD, ADLER_BYTES, ADLER_MOD,
  DEFLATE_BTYPE_BITS, DEFLATE_STORED, DEFLATE_FIXED, DEFLATE_DYNAMIC,
  DEFLATE_STORED_HEADER_BYTES, DEFLATE_STORED_LEN_MASK,
  DEFLATE_BIT_TABLE, DEFLATE_LITERALS, DEFLATE_EOB, DEFLATE_LENGTH_CODES,
  DEFLATE_HLIT_BASE, DEFLATE_HLIT_BITS, DEFLATE_HDIST_BASE, DEFLATE_HDIST_BITS, DEFLATE_HCLEN_BASE, DEFLATE_HCLEN_BITS,
  DEFLATE_HLIT_MAX, DEFLATE_HDIST_MAX, DEFLATE_CODELEN_CODES, DEFLATE_CODELEN_BITS,
  DEFLATE_REPEAT_PREV, DEFLATE_REPEAT_ZERO3,
  DEFLATE_REPEAT16_BASE, DEFLATE_REPEAT16_BITS, DEFLATE_REPEAT17_BASE, DEFLATE_REPEAT17_BITS,
  DEFLATE_REPEAT18_BASE, DEFLATE_REPEAT18_BITS, DEFLATE_BFINAL_BITS, BYTE_SHIFT, BE32_SHIFTS, ADLER_SHIFT, zlibBound,
} from '../../src/format.js';
/* oxlint-disable no-magic-numbers -- RFC 1951 §3.2.5 length/distance alphabets and the fixed Huffman assignment */
// The length and distance alphabets, built as RFC 1951 §3.2.5 defines them: each code's extra bits, and a base that is
// the previous base plus the previous code's range (2^extra). Length code 285 is the exception: 0 extra bits, base 258.
// test/mutant-kill.test.js holds these against the RFC's printed tables.
const LBASE: number[] = [];
const LEXT: number[] = [];
const DBASE: number[] = [];
const DEXT: number[] = [];
for (let base = 3, i = 0; i < 29; i++) { const x = i < 8 || i === 28 ? 0 : (i >> 2) - 1; LEXT.push(x); LBASE.push(i === 28 ? 258 : base); base += 1 << x; }
for (let base = 1, i = 0; i < 30; i++) { const x = i < 4 ? 0 : (i >> 1) - 1; DEXT.push(x); DBASE.push(base); base += 1 << x; }
export const CLORDER: readonly number[] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

export const DEFLATE_TABLES: { readonly LBASE: readonly number[]; readonly LEXT: readonly number[]; readonly DBASE: readonly number[]; readonly DEXT: readonly number[] } = /* @__PURE__ */ Object.freeze({ LBASE, LEXT, DBASE, DEXT });

export type Huffman = { readonly count: Uint16Array; readonly symbol: Uint16Array };
// Canonical Huffman table from code lengths (puff algorithm). Returns {count, symbol}.
// Indexed reads in this file are in range (each is bounded where it is read, as the comments there say), which
// noUncheckedIndexedAccess cannot see; `as number` says so at no runtime cost (a fallback per read is bundle bytes).
/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- in-range indexed reads, see above (`as number`, not the `!` src/ forbids) */
export function huffBuild(lengths: ArrayLike<number>): Huffman {
  const count = new Uint16Array(DEFLATE_BIT_TABLE);
  const symbol = new Uint16Array(lengths.length);
  const offs = new Uint16Array(DEFLATE_BIT_TABLE);
  for (let i = 0; i < lengths.length; i++) { const l = lengths[i] as number; count[l] = (count[l] as number) + 1; }
  count[0] = 0;
  for (let l = 1; l < DEFLATE_BIT_TABLE; l++) offs[l] = (offs[l - 1] as number) + (count[l - 1] as number);
  for (let s = 0; s < lengths.length; s++) { const l = lengths[s] as number; if (l) { const at = offs[l] as number; symbol[at] = s; offs[l] = at + 1; } }
  return { count, symbol };
}

// lengths 0-143: 8, 144-255: 9, 256-279: 7, 280-287: 8
export const FIXED_LIT: Huffman = huffBuild(new Uint8Array(288).fill(8).fill(9, 144, 256).fill(7, 256, 280));
export const FIXED_DIST: Huffman = huffBuild(new Uint8Array(30).fill(5));
/* oxlint-enable no-magic-numbers */

export function adler32(bytes: Uint8Array, a = 1, b = 0): number {
  // oxlint-disable-next-line no-param-reassign -- a and b are the running sums a caller may seed; updating them is the algorithm
  for (let i = 0; i < bytes.length; i++) { a = (a + (bytes[i] as number)) % ADLER_MOD; b = (b + a) % ADLER_MOD; }
  return ((b << ADLER_SHIFT) | a) >>> 0;
}

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
export type InflateStats = {
  blocks: number; stored: number; fixed: number; dynamic: number;
  literals: number; matches: number; matchBytes: number; maxDist: number; maxLen: number;
};
export type Inflated = { readonly out: Uint8Array; readonly consumed: number; readonly stats: InflateStats };
export type InflateError = ErrorOf<'pack_corrupt'> | ErrorOf<'limit_exceeded'> | ErrorOf<'bad_request'>;

// A deflate block's type (BTYPE, RFC 1951 §3.2.3). Bit value 3 is reserved and invalid.
export type BlockType = 'stored' | 'fixed' | 'dynamic';
type BlockKind = BlockType | 'invalid';
// DEFLATE_STORED, DEFLATE_FIXED, DEFLATE_DYNAMIC (format.ts) are BTYPE 0, 1, 2.
const blockKind = (btype: number): BlockKind => {
  switch (btype) {
    case DEFLATE_STORED: return 'stored';
    case DEFLATE_FIXED: return 'fixed';
    case DEFLATE_DYNAMIC: return 'dynamic';
    default: return 'invalid';
  }
};
type Corrupt = ErrorOf<'pack_corrupt'>;
const corrupt = (msg: string): Err<Corrupt> => fail('pack_corrupt', msg);
// What one step of the block loop returns: done (the shared DONE, so a step that succeeds allocates nothing), or the
// refusal that ends the stream.
type Step = Result<null, InflateError>;
const DONE: Step = ok(null);
// The bit reader and the Huffman decoder return a value, or one of these in its place. A value is never negative (bits
// are masked to fewer than 31 of them, a symbol is a Uint16), so `< 0` is the check, and the check is at every read.
const END = -1; // the input ran out
const NO_CODE = -2; // no code of any length matched
const ended = (): Err<Corrupt> => corrupt('inflate: unexpected end of input');
const unread = (v: number): Err<Corrupt> => (v === NO_CODE ? corrupt('inflate: invalid huffman code') : ended());

// oxlint-disable-next-line eslint/complexity -- one decoder (header, blocks by exhaustive block type, trailer)
export function inflateRef(buf: Uint8Array, pos = 0, opts: InflateOptions = {}): Result<Inflated, InflateError> {
  const { verifyAdler = true, raw = false } = opts;
  const expected = fromNullish(opts.expectedSize);
  // Omitted means the object cap. An explicit Infinity used to disable the check (`n > Infinity` is false).
  let maxOutput = DEFAULT_LIMITS.maxObjectSize;
  const givenMax = fromNullable(opts.maxOutput);
  if (givenMax.tag === 'some') {
    const m = checkLimit(givenMax.value, 'maxObjectSize');
    if (!m.ok) return m;
    maxOutput = m.value;
  }
  const over = (msg: string, what: string, got: number): Err<ErrorOf<'limit_exceeded'>> => fail('limit_exceeded', msg, { what, got, max: maxOutput });
  const start = pos;
  const stats: InflateStats = { blocks: 0, stored: 0, fixed: 0, dynamic: 0, literals: 0, matches: 0, matchBytes: 0, maxDist: 0, maxLen: 0 };
  // bit reader (LSB-first); p is also the zlib header's cursor
  let p = pos;
  let bitbuf = 0;
  let bitcnt = 0;
  if (!raw) {
    const hdr = take(buf, p, ZLIB_HEADER_BYTES);
    if (!hdr.ok) return hdr;
    const cmf = hdr.value[0] as number;
    const flg = hdr.value[1] as number;
    if ((cmf & ZLIB_CM_MASK) !== ZLIB_CM_DEFLATE) return corrupt(`zlib: unsupported method ${cmf & ZLIB_CM_MASK}`);
    if (((cmf << BYTE_SHIFT) | flg) % ZLIB_HEADER_MOD !== 0) return corrupt('zlib: bad header check');
    if (flg & ZLIB_FDICT) return corrupt('zlib: preset dictionary not supported');
    p += ZLIB_HEADER_BYTES;
  }
  if (expected.tag === 'some' && expected.value > maxOutput) return fail('limit_exceeded', `inflate: expected size ${expected.value} exceeds limit ${maxOutput}`, { what: 'inflate expected size', got: expected.value, max: maxOutput });
  // The stream may not run past zlibBound of the size it will produce (format.js): a run of non-final empty stored blocks
  // (5 bytes in, 0 out) used to be consumed to the end of the buffer, so a pack's bytes bounded its CPU, not its objects.
  // Without an expected size the output cap stands in. Checked where a block starts (so an endless stream is refused a
  // few bytes past the bound, before any more of it is read) and when the stream ends (a last block may be long).
  const declared = getOrElse(expected, maxOutput);
  const maxInput = zlibBound(declared);
  const tooLong = (n: number): Err<Corrupt> => corrupt(`inflate: zlib stream longer than its declared size allows (${n} > ${maxInput} for ${declared} bytes)`);
  const guess = Math.max(256, (buf.length - p) * 3); // oxlint-disable-line no-magic-numbers -- output-buffer growth, not a wire-format fact
  let out = new Uint8Array(getOrElse(expected, Math.min(maxOutput, guess)));
  let o = 0;
  const ensure = (n: number): Step => {
    if (o + n <= out.length) return DONE;
    if (expected.tag === 'some') return corrupt(`inflate: output exceeds expected ${expected.value}`);
    if (o + n > maxOutput) return over(`inflate: output exceeds limit ${maxOutput}`, 'inflate output', o + n);
    let cap = Math.min(maxOutput, out.length * 2); // oxlint-disable-line no-magic-numbers -- output-buffer growth, not a wire-format fact
    while (cap < o + n) cap = Math.min(maxOutput, cap * 2); // oxlint-disable-line no-magic-numbers -- output-buffer growth, not a wire-format fact
    const nb = new Uint8Array(cap); nb.set(out.subarray(0, o)); out = nb;
    return DONE;
  };

  // n bits, or END. The block loop is a hot loop of small closures, so a read returns a number, never a Result.
  const bits = (n: number): number => {
    let v = bitbuf;
    while (bitcnt < n) {
      if (p >= buf.length) return END;
      v |= (buf[p++] as number) << bitcnt; bitcnt += BYTE_SHIFT;
    }
    bitbuf = v >>> n; bitcnt -= n;
    return v & ((1 << n) - 1);
  };
  // puff's decode, one code bit at a time, the bit read inline: a call to bits(1) per code bit was the hot spot (PR body).
  // A symbol, END, or NO_CODE.
  const decode = (h: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < DEFLATE_BIT_TABLE; len++) {
      if (bitcnt === 0) {
        if (p >= buf.length) return END;
        bitbuf = buf[p++] as number; bitcnt = BYTE_SHIFT;
      }
      code |= bitbuf & 1; bitbuf >>>= 1; bitcnt--; // oxlint-disable-line oxc/bad-bitwise-operator -- puff's decode: the next bit goes in at bit 0
      const c = h.count[len] as number;
      if (code - first < c) return h.symbol[index + code - first] as number;
      index += c; first = (first + c) << 1; code <<= 1;
    }
    return NO_CODE;
  };
  const codes = (lit: Huffman, dist: Huffman): Step => {
    for (;;) {
      const sym = decode(lit);
      if (sym < 0) return unread(sym);
      if (sym < DEFLATE_LITERALS) {
        const room = ensure(1);
        if (!room.ok) return room;
        out[o++] = sym; stats.literals++;
        continue;
      }
      if (sym === DEFLATE_EOB) return DONE;
      const li = sym - DEFLATE_HLIT_BASE;
      if (li >= DEFLATE_LENGTH_CODES) return corrupt('inflate: bad length symbol');
      const lx = bits(LEXT[li] as number);
      if (lx < 0) return ended();
      const len = (LBASE[li] as number) + lx;
      const di = decode(dist);
      if (di < 0) return unread(di);
      if (di >= DEFLATE_HDIST_MAX) return corrupt('inflate: bad distance symbol');
      const dx = bits(DEXT[di] as number);
      if (dx < 0) return ended();
      const d = (DBASE[di] as number) + dx;
      if (d > o) return corrupt('inflate: distance too far back');
      const room = ensure(len);
      if (!room.ok) return room;
      stats.matches++; stats.matchBytes += len;
      if (d > stats.maxDist) stats.maxDist = d;
      if (len > stats.maxLen) stats.maxLen = len;
      // A match that does not overlap its own output is one copy; an overlapping one repeats its last d bytes, so it is
      // copied byte by byte (the overlap is the encoding: `d = 1, len = 258` is a run of one byte).
      if (d >= len) { out.copyWithin(o, o - d, o - d + len); o += len; }
      else { let from = o - d; for (let i = 0; i < len; i++) out[o++] = out[from++] as number; }
    }
  };
  // A dynamic block's code length codes, then the literal/length and distance code lengths they encode (RFC 1951
  // §3.2.7), then the block's symbols.
  const dynamic = (): Step => {
    const hlit = bits(DEFLATE_HLIT_BITS);
    const hdist = bits(DEFLATE_HDIST_BITS);
    const hclen = bits(DEFLATE_HCLEN_BITS);
    // A read that runs out reads no byte, so the next read of as many bits or more runs out too: HLIT's failure is
    // HDIST's (5 bits each). HCLEN (4) can still be there after HDIST ran out, so both are checked.
    if (hdist < 0 || hclen < 0) return ended();
    const nlen = hlit + DEFLATE_HLIT_BASE;
    const ndist = hdist + DEFLATE_HDIST_BASE;
    const ncode = hclen + DEFLATE_HCLEN_BASE;
    if (nlen > DEFLATE_HLIT_MAX || ndist > DEFLATE_HDIST_MAX) return corrupt('inflate: bad dynamic counts');
    const lengths = new Uint8Array(DEFLATE_HLIT_MAX + DEFLATE_HDIST_MAX);
    for (let i = 0; i < ncode; i++) {
      const l = bits(DEFLATE_CODELEN_BITS);
      if (l < 0) return ended();
      lengths[CLORDER[i] as number] = l;
    }
    const lencode = huffBuild(lengths.subarray(0, DEFLATE_CODELEN_CODES));
    let i = 0;
    while (i < nlen + ndist) {
      const sym = decode(lencode);
      if (sym < 0) return unread(sym);
      if (sym < DEFLATE_REPEAT_PREV) { lengths[i++] = sym; continue; }
      let base: number;
      let rx: number;
      let val = 0;
      if (sym === DEFLATE_REPEAT_PREV && i === 0) return corrupt('inflate: repeat with no previous');
      if (sym === DEFLATE_REPEAT_PREV) { val = lengths[i - 1] as number; base = DEFLATE_REPEAT16_BASE; rx = bits(DEFLATE_REPEAT16_BITS); }
      else if (sym === DEFLATE_REPEAT_ZERO3) { base = DEFLATE_REPEAT17_BASE; rx = bits(DEFLATE_REPEAT17_BITS); }
      else { base = DEFLATE_REPEAT18_BASE; rx = bits(DEFLATE_REPEAT18_BITS); } // 18: lencode has 19 symbols, 0-18
      if (rx < 0) return ended();
      let rep = base + rx;
      if (i + rep > nlen + ndist) return corrupt('inflate: repeat overflow');
      while (rep--) lengths[i++] = val;
    }
    if (lengths[DEFLATE_EOB] === 0) return corrupt('inflate: no end-of-block code');
    return codes(huffBuild(Array.from(lengths.subarray(0, nlen))), huffBuild(Array.from(lengths.subarray(nlen, nlen + ndist))));
  };
  // One block: its header bits are read, then its body by its type, exhaustively.
  const block = (type: BlockKind): Step => {
    switch (type) {
      case 'stored': {
        stats.stored++;
        bitbuf = 0; bitcnt = 0; // discard to byte boundary
        if (p + DEFLATE_STORED_HEADER_BYTES > buf.length) return corrupt('inflate: truncated stored header');
        const sh = buf.subarray(p, p + DEFLATE_STORED_HEADER_BYTES); // in range: checked on the line above
        const len = (sh[0] as number) | ((sh[1] as number) << BYTE_SHIFT);
        const nlen = (sh[2] as number) | ((sh[3] as number) << BYTE_SHIFT);
        if (len !== (~nlen & DEFLATE_STORED_LEN_MASK)) return corrupt('inflate: stored length check failed');
        p += DEFLATE_STORED_HEADER_BYTES;
        if (p + len > buf.length) return corrupt('inflate: truncated stored block');
        const room = ensure(len);
        if (!room.ok) return room;
        out.set(buf.subarray(p, p + len), o); o += len; p += len; // in range: "truncated stored block" above
        return DONE;
      }
      case 'fixed':
        stats.fixed++;
        return codes(FIXED_LIT, FIXED_DIST);
      case 'dynamic':
        stats.dynamic++;
        return dynamic();
      case 'invalid': return corrupt('inflate: invalid block type');
    }
    return assertNever(type);
  };

  let last: number;
  do {
    if (p - start > maxInput) return tooLong(p - start);
    last = bits(DEFLATE_BFINAL_BITS);
    const btype = bits(DEFLATE_BTYPE_BITS);
    // BFINAL (1 bit) that ran out leaves BTYPE (2) nothing to read: BTYPE's check is BFINAL's too
    if (btype < 0) return ended();
    stats.blocks++;
    const done = block(blockKind(btype));
    if (!done.ok) return done;
  } while (!last);

  const result = out.subarray(0, o);
  if (!raw) {
    if (p + ADLER_BYTES > buf.length) return corrupt('inflate: truncated adler32');
    const ad = buf.subarray(p, p + ADLER_BYTES); // in range: checked on the line above
    const want = (((ad[0] as number) << (BE32_SHIFTS[0] as number)) | ((ad[1] as number) << (BE32_SHIFTS[1] as number)) | ((ad[2] as number) << (BE32_SHIFTS[2] as number)) | (ad[3] as number)) >>> 0;
    if (verifyAdler && adler32(result) !== want) return corrupt('inflate: adler32 mismatch');
    p += ADLER_BYTES;
  }
  if (expected.tag === 'some' && o !== expected.value) return corrupt(`inflate: size ${o} != expected ${expected.value}`);
  if (p - start > maxInput) return tooLong(p - start);
  return ok({ out: result, consumed: p - start, stats });
}
