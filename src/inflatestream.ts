// Pull inflate (RFC 1950 + RFC 1951): bytes in as they arrive, output out in chunks of at most INFLATE_CHUNK, a 32 KiB
// window kept for back-references and nothing else. Peak is the window, one chunk, two 1 KiB code tables and the unread
// bytes the caller fed; never the inflated object, never the zlib member (issue #172).
//
// Codes are looked up INFLATE_FAST_BITS at a time in a table built by puff's own walk (huffFast), from a bit buffer
// read up to 24 bits ahead; a longer code goes a bit at a time. The bytes read ahead are not consumed: they go back to
// the input before a byte boundary, at the end and with a full chunk, so the output, `consumed` and every refusal are
// what a bit-at-a-time decoder gives (test/packstream.test.js holds both to the oracle in every chunking).
//
// One owner, one mutable record: an immutable record per symbol would retain every prefix and blow the bound this module
// exists to hold. A pull runs atomic steps. A step that runs out of input puts back the bits it took (the mark) and the
// pull answers `need`, so a step never resumes halfway and there is no sentinel to throw. Refusals are values: a step
// stores its PlyError on the record and the pull returns it (and keeps returning it).
//
// The one deflate decoder in ply: inflate() (inflate.ts) is a collector over this pull, so the buffered and the streamed
// paths give the same answer by construction. On input no git writes, the decoder refuses what zlib and git refuse:
//   - a back-reference past the window CINFO declares is pack_corrupt, and CINFO > 7 is `zlib: window size N is not a
//     zlib window` (after the method check and before the header checksum);
//   - a stored block whose declared length is past the output cap is refused at its header, before its bytes arrive;
//   - a member cut inside its zlib header is a short read of the bytes fed.
// The Huffman tables, the alphabets and Adler-32 live here too; inflate.ts re-exports them.
import type { ErrorOf } from './errors.js';
import { fail, plyError } from './errors.js';
import type { Result } from './result.js';
import { ok, err, assertNever } from './result.js';
import { shortRead } from './bytes.js';
import { DEFAULT_LIMITS, checkLimit } from './limits.js';
import type { Attrs } from './otel.js';
import {
  ZLIB_HEADER_BYTES, ZLIB_CM_DEFLATE, ZLIB_CM_MASK, ZLIB_FDICT, ZLIB_HEADER_MOD, ZLIB_CINFO_SHIFT, ZLIB_CINFO_MAX, ZLIB_WINDOW_EXPONENT,
  ADLER_BYTES, ADLER_MOD, ADLER_NMAX, ADLER_SHIFT, BYTE_SHIFT, BE32_SHIFTS, zlibBound,
  DEFLATE_BFINAL_BITS, DEFLATE_BTYPE_BITS, DEFLATE_STORED, DEFLATE_FIXED, DEFLATE_DYNAMIC,
  DEFLATE_STORED_HEADER_BYTES, DEFLATE_STORED_LEN_MASK,
  DEFLATE_BIT_TABLE, DEFLATE_LITERALS, DEFLATE_EOB, DEFLATE_LENGTH_CODES,
  DEFLATE_HLIT_BASE, DEFLATE_HLIT_BITS, DEFLATE_HDIST_BASE, DEFLATE_HDIST_BITS, DEFLATE_HCLEN_BASE, DEFLATE_HCLEN_BITS,
  DEFLATE_HLIT_MAX, DEFLATE_HDIST_MAX, DEFLATE_CODELEN_CODES, DEFLATE_CODELEN_BITS,
  DEFLATE_REPEAT_PREV, DEFLATE_REPEAT_ZERO3,
  DEFLATE_REPEAT16_BASE, DEFLATE_REPEAT16_BITS, DEFLATE_REPEAT17_BASE, DEFLATE_REPEAT17_BITS,
  DEFLATE_REPEAT18_BASE, DEFLATE_REPEAT18_BITS,
  INFLATE_WINDOW, INFLATE_CHUNK, INFLATE_FAST_BITS, INFLATE_FAST_SYMBOL_BITS, INFLATE_LOOKAHEAD_BITS,
} from './format.js';

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
// Indexed reads in this file are in range (a length check, a mask, or a table built to the alphabet's size bounds each
// one), which noUncheckedIndexedAccess cannot see; `as number` says so (src/ forbids the `!` form).
/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- in-range indexed reads, see above */
// Canonical Huffman table from code lengths (puff algorithm). Returns {count, symbol}.
export function huffBuild(lengths: ArrayLike<number>): Huffman {
  const count = new Uint16Array(DEFLATE_BIT_TABLE);
  const symbol = new Uint16Array(lengths.length);
  const offs = new Uint16Array(DEFLATE_BIT_TABLE);
  // Stryker disable next-line EqualityOperator: one past the end reads past the array (a key a typed array ignores), and count[0] is cleared on the next line
  for (let i = 0; i < lengths.length; i++) { const l = lengths[i] as number; count[l] = (count[l] as number) + 1; }
  count[0] = 0;
  // Stryker disable next-line EqualityOperator: offs is DEFLATE_BIT_TABLE long, so the extra index is ignored
  for (let l = 1; l < DEFLATE_BIT_TABLE; l++) offs[l] = (offs[l - 1] as number) + (count[l - 1] as number);
  // Stryker disable next-line EqualityOperator: lengths[lengths.length] is past the end and the if skips it
  for (let s = 0; s < lengths.length; s++) { const l = lengths[s] as number; if (l) { const at = offs[l] as number; symbol[at] = s; offs[l] = at + 1; } }
  return { count, symbol };
}

// lengths 0-143: 8, 144-255: 9, 256-279: 7, 280-287: 8
export const FIXED_LIT: Huffman = huffBuild(new Uint8Array(288).fill(8).fill(9, 144, 256).fill(7, 256, 280));
export const FIXED_DIST: Huffman = huffBuild(new Uint8Array(30).fill(5));
/* oxlint-enable no-magic-numbers */

// A table of every INFLATE_FAST_BITS-bit lookahead, in the order the bits are read (the first bit read is bit 0): the
// symbol puff's decode gives for it and the length of its code, or 0 where the code is longer or no code matches (the
// decoder then goes a bit at a time, as before). Built from the same count and symbol arrays and the same walk as
// decode, so a table lookup and decode agree on every input, an incomplete or over-subscribed code included: at length
// `len` decode answers the codes first..first+count-1 that fit in len bits, and a code at one length never starts with
// a shorter one's bits (each length's first code is past the previous length's last, shifted).
export type FastTable = Uint16Array;
const FAST_SIZE: number = 1 << INFLATE_FAST_BITS;
const FAST_MASK: number = FAST_SIZE - 1;
const FAST_SYMBOL_MASK: number = (1 << INFLATE_FAST_SYMBOL_BITS) - 1;
// The len low bits of code, reversed: the code's first bit (its highest) is the first bit read.
function reversed(code: number, len: number): number {
  let r = 0;
  for (let i = 0; i < len; i++) r = (r << 1) | ((code >> i) & 1);
  return r;
}
export function huffFast(h: Huffman, into: FastTable = new Uint16Array(FAST_SIZE)): FastTable {
  into.fill(0);
  let first = 0;
  let index = 0;
  for (let len = 1; len <= INFLATE_FAST_BITS; len++) {
    const c = h.count[len] as number;
    // the codes of this length that fit in len bits (an over-subscribed length has more than fit; decode never reads them)
    const fit = Math.min(c, (1 << len) - first);
    for (let j = 0; j < fit; j++) {
      const entry = (len << INFLATE_FAST_SYMBOL_BITS) | (h.symbol[index + j] as number);
      // every lookahead whose first len bits are this code
      // Stryker disable next-line EqualityOperator: into[FAST_SIZE] is past the end, which a typed array ignores
      for (let k = reversed(first + j, len); k < FAST_SIZE; k += 1 << len) into[k] = entry;
    }
    index += c;
    first = (first + c) << 1;
  }
  return into;
}
const FIXED_LIT_FAST: FastTable = huffFast(FIXED_LIT);
const FIXED_DIST_FAST: FastTable = huffFast(FIXED_DIST);

// The sums are reduced every ADLER_NMAX bytes, not every byte: a and b stay exact in a double either way, so the result
// is the same and the loop does one add pair per byte.
export function adler32(bytes: Uint8Array, a = 1, b = 0): number {
  let sa = a;
  let sb = b;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(i + ADLER_NMAX, bytes.length);
    for (; i < end; i++) { sa += bytes[i] as number; sb += sa; }
    sa %= ADLER_MOD;
    sb %= ADLER_MOD;
  }
  return ((sb << ADLER_SHIFT) | sa) >>> 0;
}

export type InflateStats = {
  blocks: number; stored: number; fixed: number; dynamic: number;
  literals: number; matches: number; matchBytes: number; maxDist: number; maxLen: number;
};
export type InflateError = ErrorOf<'pack_corrupt'> | ErrorOf<'limit_exceeded'> | ErrorOf<'bad_request'>;

const WINDOW_MASK: number = INFLATE_WINDOW - 1;
const EMPTY: Uint8Array = new Uint8Array(0);
// The two decode results that are not a symbol. A symbol is a Uint16, so both are below zero.
const SYM_NEED = -1;
const SYM_NO_CODE = -2;

// How the output is bounded: a declared size (a pack header's; the output must be exactly that long) or only a cap.
export type StreamBound =
  | { readonly kind: 'declared'; readonly size: number; readonly maxOutput: number }
  | { readonly kind: 'capped'; readonly maxOutput: number };
// A zlib member (header and Adler-32 trailer) or a raw deflate stream.
export type StreamWrap =
  | { readonly kind: 'zlib'; readonly verifyAdler: boolean }
  | { readonly kind: 'raw' };
export type InflateStreamOpts = { readonly bound: StreamBound; readonly wrap: StreamWrap };

export const zlibWrap = (verifyAdler: boolean): StreamWrap => ({ kind: 'zlib', verifyAdler });
export const rawWrap = (): StreamWrap => ({ kind: 'raw' });
export const cappedBound = (maxOutput: number = DEFAULT_LIMITS.maxObjectSize): StreamBound => ({ kind: 'capped', maxOutput });
export const declaredBound = (size: number, maxOutput: number = DEFAULT_LIMITS.maxObjectSize): StreamBound => ({ kind: 'declared', size, maxOutput });

export type InflatePhase =
  | 'header' | 'block' | 'stored-header' | 'stored' | 'dyn-header' | 'dyn-clen' | 'dyn-lens' | 'codes' | 'adler' | 'end';
// Running, or stopped by a refusal that every later pull returns again.
export type InflateHalt = { readonly tag: 'running' } | { readonly tag: 'failed'; readonly error: InflateError };
// Stryker disable next-line ObjectLiteral,StringLiteral: halt is read only as tag === 'failed'; any other record runs
const RUNNING: InflateHalt = { tag: 'running' };
// What a pull answers: a chunk of output (a copy the caller owns), a request for more input, or the end of the member
// with the bytes it consumed. After the end every pull answers the end again.
export type InflatePiece =
  | { readonly kind: 'need' }
  | { readonly kind: 'chunk'; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'end'; readonly consumed: number; readonly stats: InflateStats };

// Single owner. The fields are mutable so a pull can resume; two pulls on one record at once is a bug.
export type InflateStream = {
  phase: InflatePhase;
  halt: InflateHalt;
  bound: StreamBound;
  wrap: StreamWrap;
  maxOutput: number;
  declared: number;
  maxInput: number;
  windowSize: number;
  ended: boolean;
  // input: `carry` from `p`, bits not yet used in `bitbuf` (`bitcnt` of them); `base` bytes came before this carry.
  // The bit buffer may hold whole bytes read ahead (decodeFast). They are not consumed (consumedOf), and they go back to
  // the carry (settle) before a byte boundary is read (align), at the end (finish), and when a full chunk is answered,
  // so a feed after a chunk joins the carry behind them. After a need they stay: the step that needed more input
  // rewound to the start of a symbol whose bits run past them, so the bits are all used before the next boundary.
  carry: Uint8Array;
  p: number;
  base: number;
  bitbuf: number;
  bitcnt: number;
  // the mark a step returns to when it runs out of input
  markP: number;
  markBuf: number;
  markCnt: number;
  // output: the window ring (`w` is the next write), the chunk being filled, and what the Adler sums have seen of it
  window: Uint8Array;
  w: number;
  out: Uint8Array;
  outLen: number;
  summed: number;
  adler: number;
  emitted: number;
  stats: InflateStats;
  // the block being read
  final: boolean;
  storedLeft: number;
  nlen: number;
  ndist: number;
  ncode: number;
  lensI: number;
  lengths: Uint8Array;
  lencode: Huffman;
  lit: Huffman;
  dist: Huffman;
  // the fast tables of lencode (litTab's buffer, before the literal table is built in it), lit and dist: a fixed
  // block's are shared constants, a dynamic block's are built in this record's two buffers
  lenFast: FastTable;
  litFast: FastTable;
  distFast: FastTable;
  litTab: FastTable;
  distTab: FastTable;
  copyLeft: number;
  copyDist: number;
};

// A step's answer. A refusal is stored on the record first (`refuse`), so the answer itself is a number.
const CONT = 0;
const CHUNK = 1;
const END = 2;
const NEED = 3;
const FAILED = 4;
type Drive = typeof CONT | typeof CHUNK | typeof END | typeof NEED | typeof FAILED;

function refuse(st: InflateStream, error: InflateError): Drive {
  st.halt = { tag: 'failed', error };
  return FAILED;
}
// The bytes the decoder has used: a byte read ahead into the bit buffer and not used is not consumed.
const consumedOf = (st: InflateStream): number => st.base + st.p - Math.floor(st.bitcnt / BYTE_SHIFT);
// The member bytes used so far, for a caller that weighs output against input (packstream.ts chargeWork).
export const inflateConsumed: (st: InflateStream) => number = consumedOf;
const tooLong = (st: InflateStream): ErrorOf<'pack_corrupt'> =>
  plyError('pack_corrupt', `inflate: zlib stream longer than its declared size allows (${consumedOf(st)} > ${st.maxInput} for ${st.declared} bytes)`);

function mark(st: InflateStream): void {
  st.markP = st.p;
  st.markBuf = st.bitbuf;
  st.markCnt = st.bitcnt;
}
// Put back what the step took, and ask for more input.
function rewind(st: InflateStream): Drive {
  st.p = st.markP;
  st.bitbuf = st.markBuf;
  st.bitcnt = st.markCnt;
  return NEED;
}
// At least n bits in the bit buffer, or false (input ran out; the bytes pulled so far stay in the buffer).
function fill(st: InflateStream, n: number): boolean {
  while (st.bitcnt < n) {
    if (st.p >= st.carry.length) return false;
    st.bitbuf |= (st.carry[st.p] as number) << st.bitcnt;
    st.p += 1;
    st.bitcnt += BYTE_SHIFT;
  }
  return true;
}
// n bits the caller has filled.
function take(st: InflateStream, n: number): number {
  const v = st.bitbuf & ((1 << n) - 1);
  st.bitbuf >>>= n;
  st.bitcnt -= n;
  return v;
}
// puff's decode, one code bit at a time, from the bit buffer decodeFast filled: a symbol, SYM_NEED, or SYM_NO_CODE. That
// buffer holds every byte there is up to INFLATE_LOOKAHEAD_BITS, more than the longest code, so running out of bits here
// is running out of input.
function decode(st: InflateStream, h: Huffman): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len < DEFLATE_BIT_TABLE; len++) {
    if (st.bitcnt <= 0) return SYM_NEED;
    code |= st.bitbuf & 1; // oxlint-disable-line oxc/bad-bitwise-operator -- puff's decode: the next bit goes in at bit 0
    st.bitbuf >>>= 1;
    st.bitcnt -= 1;
    const c = h.count[len] as number;
    if (code - first < c) return h.symbol[index + code - first] as number;
    index += c;
    first = (first + c) << 1;
    code <<= 1;
  }
  return SYM_NO_CODE;
}
// Whole bytes the bit buffer holds go back to the carry (they were read from it in this pull), and the bits left are
// fewer than 8: what reading bit by bit would have left. A pull settles before it answers, so a feed after any answer
// keeps every unused byte.
function settle(st: InflateStream): void {
  const whole = Math.floor(st.bitcnt / BYTE_SHIFT);
  st.p -= whole;
  st.bitcnt -= whole * BYTE_SHIFT;
  st.bitbuf &= (1 << st.bitcnt) - 1;
}
// A byte boundary (a stored block's header, the Adler-32 trailer): the bytes read ahead go back, the rest of the
// current byte is padding.
function align(st: InflateStream): void {
  settle(st);
  st.bitbuf = 0;
  st.bitcnt = 0;
}
// decode by the fast table: the bit buffer topped up to INFLATE_LOOKAHEAD_BITS (fewer at the end of the input), its next
// INFLATE_FAST_BITS bits looked up at once. A code the table does not hold, or one longer than the bits there are, goes
// to decode, which reads the same bits from the buffer first.
function decodeFast(st: InflateStream, h: Huffman, table: FastTable): number {
  const c = st.carry;
  // Stryker disable next-line EqualityOperator: at 24 bits one more byte still fits 32, and a settle returns it unused
  while (st.bitcnt < INFLATE_LOOKAHEAD_BITS && st.p < c.length) {
    st.bitbuf |= (c[st.p] as number) << st.bitcnt;
    st.p += 1;
    st.bitcnt += BYTE_SHIFT;
  }
  const entry = table[st.bitbuf & FAST_MASK] as number;
  const len = entry >>> INFLATE_FAST_SYMBOL_BITS;
  // Stryker disable next-line ConditionalExpression,EqualityOperator: decode reads the same bits to the same symbol (the fast table is a shortcut; test/packstream.test.js holds it to puff's walk)
  if (entry === 0 || len > st.bitcnt) return decode(st, h);
  st.bitbuf >>>= len;
  st.bitcnt -= len;
  return entry & FAST_SYMBOL_MASK;
}
// A decode that did not give a symbol: the input ran out (rewind), or no code matched.
const undecoded = (st: InflateStream, sym: number): Drive =>
  (sym === SYM_NEED ? rewind(st) : refuse(st, plyError('pack_corrupt', 'inflate: invalid huffman code')));

const ROOM: Result<null, never> = ok(null);
// Room for n more output bytes, as inflate.ts's ensure decides it: past a declared size is pack_corrupt, past the cap
// limit_exceeded.
function room(st: InflateStream, n: number): Result<null, InflateError> {
  const next = st.emitted + n;
  switch (st.bound.kind) {
    case 'declared':
      if (next > st.bound.size) return fail('pack_corrupt', `inflate: output exceeds expected ${st.bound.size}`);
      return ROOM;
    case 'capped':
      if (next > st.maxOutput) return fail('limit_exceeded', `inflate: output exceeds limit ${st.maxOutput}`, { what: 'inflate output', got: next, max: st.maxOutput });
      return ROOM;
  }
  // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(st.bound);
}
function emit(st: InflateStream, b: number): void {
  st.window[st.w] = b;
  st.w = (st.w + 1) & WINDOW_MASK;
  st.out[st.outLen] = b;
  st.outLen += 1;
  st.emitted += 1;
}
const full = (st: InflateStream): boolean => st.outLen === INFLATE_CHUNK;
const ADLER_HALF: number = (1 << ADLER_SHIFT) - 1;
// The Adler sums over output they have not seen yet. adler32 takes the two sums the packed value holds.
function sum(st: InflateStream): void {
  st.adler = adler32(st.out.subarray(st.summed, st.outLen), st.adler & ADLER_HALF, st.adler >>> ADLER_SHIFT);
  st.summed = st.outLen;
}
function takeChunk(st: InflateStream): Uint8Array<ArrayBuffer> {
  sum(st);
  const bytes = st.out.slice(0, st.outLen);
  st.outLen = 0;
  st.summed = 0;
  return bytes;
}

// ---- steps: each takes all the input it needs or none of it ----
function declaredFits(bound: StreamBound, maxOutput: number): Result<null, ErrorOf<'limit_exceeded'>> {
  // Stryker disable next-line ConditionalExpression: a capped bound has no size, and the missing size is not greater than the cap
  if (bound.kind === 'declared' && bound.size > maxOutput) return fail('limit_exceeded', `inflate: expected size ${bound.size} exceeds limit ${maxOutput}`, { what: 'inflate expected size', got: bound.size, max: maxOutput });
  return ROOM;
}
function stepHeader(st: InflateStream): Drive {
  // nothing is consumed before the header is whole, so the carry starts at it (p is 0)
  if (st.carry.length < ZLIB_HEADER_BYTES) return NEED;
  const cmf = st.carry[st.p] as number;
  const flg = st.carry[st.p + 1] as number;
  const method = cmf & ZLIB_CM_MASK;
  if (method !== ZLIB_CM_DEFLATE) return refuse(st, plyError('pack_corrupt', `zlib: unsupported method ${method}`));
  const cinfo = cmf >> ZLIB_CINFO_SHIFT;
  if (cinfo > ZLIB_CINFO_MAX) return refuse(st, plyError('pack_corrupt', `zlib: window size ${cinfo} is not a zlib window`));
  if (((cmf << BYTE_SHIFT) | flg) % ZLIB_HEADER_MOD !== 0) return refuse(st, plyError('pack_corrupt', 'zlib: bad header check'));
  if ((flg & ZLIB_FDICT) !== 0) return refuse(st, plyError('pack_corrupt', 'zlib: preset dictionary not supported'));
  st.p += ZLIB_HEADER_BYTES;
  st.windowSize = 1 << (cinfo + ZLIB_WINDOW_EXPONENT);
  // inflate.ts refuses a declared size past the cap after the header, so a bad header is reported first here too
  const declared = declaredFits(st.bound, st.maxOutput);
  if (!declared.ok) return refuse(st, declared.error);
  st.phase = 'block';
  return CONT;
}
function finish(st: InflateStream): Drive {
  // a raw stream ends inside its last byte: the bytes read past it are what follows the stream
  settle(st);
  if (st.bound.kind === 'declared' && st.emitted !== st.bound.size) return refuse(st, plyError('pack_corrupt', `inflate: size ${st.emitted} != expected ${st.bound.size}`));
  if (consumedOf(st) > st.maxInput) return refuse(st, tooLong(st));
  st.phase = 'end';
  return CONT;
}
function endBlock(st: InflateStream): Drive {
  if (!st.final) {
    st.phase = 'block';
    return CONT;
  }
  switch (st.wrap.kind) {
    case 'zlib':
      // the trailer is byte-aligned: the rest of the last byte is padding
      align(st);
      st.phase = 'adler';
      return CONT;
    case 'raw':
      return finish(st);
  }
  // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(st.wrap);
}
function stepBlock(st: InflateStream): Drive {
  // where a block starts, as inflate.ts checks it: an endless run of empty blocks is refused a few bytes past the bound
  if (consumedOf(st) > st.maxInput) return refuse(st, tooLong(st));
  if (!fill(st, DEFLATE_BFINAL_BITS + DEFLATE_BTYPE_BITS)) return NEED;
  st.final = take(st, DEFLATE_BFINAL_BITS) === 1;
  const btype = take(st, DEFLATE_BTYPE_BITS);
  st.stats.blocks += 1;
  switch (btype) {
    case DEFLATE_STORED:
      st.stats.stored += 1;
      // a stored block starts on a byte boundary: the rest of this byte is discarded
      align(st);
      st.phase = 'stored-header';
      return CONT;
    case DEFLATE_FIXED:
      st.stats.fixed += 1;
      st.lit = FIXED_LIT;
      st.dist = FIXED_DIST;
      st.litFast = FIXED_LIT_FAST;
      st.distFast = FIXED_DIST_FAST;
      st.phase = 'codes';
      return CONT;
    case DEFLATE_DYNAMIC:
      st.stats.dynamic += 1;
      st.phase = 'dyn-header';
      return CONT;
    default:
      return refuse(st, plyError('pack_corrupt', 'inflate: invalid block type'));
  }
}
function stepStoredHeader(st: InflateStream): Drive {
  if (st.carry.length - st.p < DEFLATE_STORED_HEADER_BYTES) return NEED;
  const c = st.carry;
  const at = st.p;
  const len = (c[at] as number) | ((c[at + 1] as number) << BYTE_SHIFT);
  // LEN, then NLEN, each two bytes little-endian (RFC 1951 §3.2.4)
  // oxlint-disable-next-line no-magic-numbers -- NLEN's first byte is the header's third
  const nlen = (c[at + 2] as number) | ((c[at + DEFLATE_STORED_HEADER_BYTES - 1] as number) << BYTE_SHIFT);
  if (len !== (~nlen & DEFLATE_STORED_LEN_MASK)) return refuse(st, plyError('pack_corrupt', 'inflate: stored length check failed'));
  const fits = room(st, len);
  if (!fits.ok) return refuse(st, fits.error);
  st.p += DEFLATE_STORED_HEADER_BYTES;
  st.storedLeft = len;
  st.phase = 'stored';
  return CONT;
}
// Copy what is here of the stored block, up to the end of the chunk.
function stepStored(st: InflateStream): Drive {
  if (st.storedLeft === 0) return endBlock(st);
  const n = Math.min(st.storedLeft, st.carry.length - st.p, INFLATE_CHUNK - st.outLen);
  if (n === 0) return full(st) ? CHUNK : NEED;
  const src = st.carry.subarray(st.p, st.p + n);
  st.out.set(src, st.outLen);
  // the window takes the same bytes, in at most two pieces around its end
  const head = Math.min(n, INFLATE_WINDOW - st.w);
  st.window.set(src.subarray(0, head), st.w);
  st.window.set(src.subarray(head), 0);
  st.w = (st.w + n) & WINDOW_MASK;
  st.outLen += n;
  st.emitted += n;
  st.p += n;
  st.storedLeft -= n;
  return full(st) ? CHUNK : CONT;
}
function stepDynHeader(st: InflateStream): Drive {
  if (!fill(st, DEFLATE_HLIT_BITS + DEFLATE_HDIST_BITS + DEFLATE_HCLEN_BITS)) return NEED;
  st.nlen = take(st, DEFLATE_HLIT_BITS) + DEFLATE_HLIT_BASE;
  st.ndist = take(st, DEFLATE_HDIST_BITS) + DEFLATE_HDIST_BASE;
  st.ncode = take(st, DEFLATE_HCLEN_BITS) + DEFLATE_HCLEN_BASE;
  if (st.nlen > DEFLATE_HLIT_MAX || st.ndist > DEFLATE_HDIST_MAX) return refuse(st, plyError('pack_corrupt', 'inflate: bad dynamic counts'));
  st.lengths.fill(0);
  st.lensI = 0;
  st.phase = 'dyn-clen';
  return CONT;
}
function stepDynClen(st: InflateStream): Drive {
  while (st.lensI < st.ncode) {
    if (!fill(st, DEFLATE_CODELEN_BITS)) return NEED;
    st.lengths[CLORDER[st.lensI] as number] = take(st, DEFLATE_CODELEN_BITS);
    st.lensI += 1;
  }
  st.lencode = huffBuild(st.lengths.subarray(0, DEFLATE_CODELEN_CODES));
  st.lenFast = huffFast(st.lencode, st.litTab);
  st.lensI = 0;
  st.phase = 'dyn-lens';
  return CONT;
}
// One code length symbol and its repeat bits, or none of them.
function stepDynLens(st: InflateStream): Drive {
  const total = st.nlen + st.ndist;
  if (st.lensI >= total) {
    if (st.lengths[DEFLATE_EOB] === 0) return refuse(st, plyError('pack_corrupt', 'inflate: no end-of-block code'));
    st.lit = huffBuild(Array.from(st.lengths.subarray(0, st.nlen)));
    st.dist = huffBuild(Array.from(st.lengths.subarray(st.nlen, total)));
    st.litFast = huffFast(st.lit, st.litTab);
    st.distFast = huffFast(st.dist, st.distTab);
    st.phase = 'codes';
    return CONT;
  }
  mark(st);
  const sym = decodeFast(st, st.lencode, st.lenFast);
  if (sym < 0) return undecoded(st, sym);
  if (sym < DEFLATE_REPEAT_PREV) {
    st.lengths[st.lensI] = sym;
    st.lensI += 1;
    return CONT;
  }
  if (sym === DEFLATE_REPEAT_PREV && st.lensI === 0) return refuse(st, plyError('pack_corrupt', 'inflate: repeat with no previous'));
  let base = DEFLATE_REPEAT18_BASE;
  let bits = DEFLATE_REPEAT18_BITS;
  let val = 0;
  if (sym === DEFLATE_REPEAT_PREV) {
    val = st.lengths[st.lensI - 1] as number;
    base = DEFLATE_REPEAT16_BASE;
    bits = DEFLATE_REPEAT16_BITS;
  } else if (sym === DEFLATE_REPEAT_ZERO3) {
    base = DEFLATE_REPEAT17_BASE;
    bits = DEFLATE_REPEAT17_BITS;
  }
  if (!fill(st, bits)) return rewind(st);
  const rep = base + take(st, bits);
  if (st.lensI + rep > total) return refuse(st, plyError('pack_corrupt', 'inflate: repeat overflow'));
  st.lengths.fill(val, st.lensI, st.lensI + rep);
  st.lensI += rep;
  return CONT;
}
// The pending match's bytes that fit in the chunk, through the window (a match may overlap its own output: the bytes it
// reads are the ones it has just written).
function copyMatch(st: InflateStream): void {
  const n = Math.min(st.copyLeft, INFLATE_CHUNK - st.outLen);
  const win = st.window;
  const out = st.out;
  let w = st.w;
  let from = (w - st.copyDist) & WINDOW_MASK;
  let o = st.outLen;
  for (let i = 0; i < n; i++) {
    const b = win[from] as number;
    win[w] = b;
    out[o] = b;
    o += 1;
    w = (w + 1) & WINDOW_MASK;
    from = (from + 1) & WINDOW_MASK;
  }
  st.w = w;
  st.outLen = o;
  st.emitted += n;
  st.copyLeft -= n;
}
// Symbols until the chunk is full, the block ends, the input runs out or a refusal: each time round the pending match
// first, then one literal, end of block, or length/distance pair (all of its bits or none).
function stepCodes(st: InflateStream): Drive {
  for (;;) {
    copyMatch(st);
    // a literal needs one byte of chunk, a match's copy at least one: a full chunk goes out before the next symbol
    if (full(st)) return CHUNK;
    mark(st);
    const sym = decodeFast(st, st.lit, st.litFast);
    if (sym < 0) return undecoded(st, sym);
    if (sym < DEFLATE_LITERALS) {
      const fits = room(st, 1);
      if (!fits.ok) return refuse(st, fits.error);
      emit(st, sym);
      st.stats.literals += 1;
      continue;
    }
    if (sym === DEFLATE_EOB) return endBlock(st);
    const li = sym - DEFLATE_HLIT_BASE;
    if (li >= DEFLATE_LENGTH_CODES) return refuse(st, plyError('pack_corrupt', 'inflate: bad length symbol'));
    const lbits = LEXT[li] as number;
    // Stryker disable next-line ConditionalExpression: short extra bits mean the input is spent, so the distance decode below finds no bits (decode answers need) and rewinds to the same mark
    if (!fill(st, lbits)) return rewind(st);
    const len = (LBASE[li] as number) + take(st, lbits);
    const di = decodeFast(st, st.dist, st.distFast);
    if (di < 0) return undecoded(st, di);
    // a distance table is built from at most DEFLATE_HDIST_MAX lengths (FIXED_DIST from 30), so di indexes DBASE and DEXT
    const dbits = DEXT[di] as number;
    if (!fill(st, dbits)) return rewind(st);
    const d = (DBASE[di] as number) + take(st, dbits);
    if (d > st.emitted || d > st.windowSize) return refuse(st, plyError('pack_corrupt', 'inflate: distance too far back'));
    const fits = room(st, len);
    if (!fits.ok) return refuse(st, fits.error);
    st.stats.matches += 1;
    st.stats.matchBytes += len;
    // Stryker disable next-line EqualityOperator: writing the same maximum when the distance is equal does not change the stat
    if (d > st.stats.maxDist) st.stats.maxDist = d;
    // Stryker disable next-line EqualityOperator: writing the same maximum when the length is equal does not change the stat
    if (len > st.stats.maxLen) st.stats.maxLen = len;
    st.copyLeft = len;
    st.copyDist = d;
  }
}
function stepAdler(st: InflateStream): Drive {
  if (st.carry.length - st.p < ADLER_BYTES) return NEED;
  const c = st.carry;
  const at = st.p;
  // oxlint-disable-next-line no-magic-numbers -- at + 2 is the third byte of the four BE32_SHIFTS places
  const want = (((c[at] as number) << (BE32_SHIFTS[0] as number)) | ((c[at + 1] as number) << (BE32_SHIFTS[1] as number)) | ((c[at + 2] as number) << (BE32_SHIFTS[2] as number)) | (c[at + ADLER_BYTES - 1] as number)) >>> 0;
  sum(st);
  // a raw stream never reaches this phase (endBlock)
  // Stryker disable next-line ConditionalExpression: a raw stream never reaches this phase, so its kind is always zlib here
  if (st.wrap.kind === 'zlib' && st.wrap.verifyAdler && st.adler !== want) return refuse(st, plyError('pack_corrupt', 'inflate: adler32 mismatch'));
  st.p += ADLER_BYTES;
  return finish(st);
}

function dispatch(st: InflateStream): Drive {
  switch (st.phase) {
    case 'header': return stepHeader(st);
    case 'block': return stepBlock(st);
    case 'stored-header': return stepStoredHeader(st);
    case 'stored': return stepStored(st);
    case 'dyn-header': return stepDynHeader(st);
    case 'dyn-clen': return stepDynClen(st);
    case 'dyn-lens': return stepDynLens(st);
    case 'codes': return stepCodes(st);
    case 'adler': return stepAdler(st);
    case 'end': return st.outLen > 0 ? CHUNK : END;
  }
  // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(st.phase);
}

// Input closed inside the member: which truncation it is, by where it stopped (inflate.ts's messages).
function truncated(st: InflateStream): ErrorOf<'pack_corrupt'> {
  switch (st.phase) {
    // nothing is consumed before the header is whole: every byte fed is unread
    case 'header': return shortRead('pack_corrupt', 0, ZLIB_HEADER_BYTES, st.carry.length);
    case 'stored-header': return plyError('pack_corrupt', 'inflate: truncated stored header');
    case 'stored': return plyError('pack_corrupt', 'inflate: truncated stored block');
    case 'adler': return plyError('pack_corrupt', 'inflate: truncated adler32');
    // Stryker disable next-line ConditionalExpression,StringLiteral: an ended member never asks for input, so 'end' is never truncated
    case 'end':
    case 'block': case 'dyn-header': case 'dyn-clen': case 'dyn-lens': case 'codes':
      return plyError('pack_corrupt', 'inflate: unexpected end of input');
  }
  // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(st.phase);
}

const NEED_PIECE: InflatePiece = { kind: 'need' };
// The next piece: a chunk when one is full (or the input ran out with output pending), the end, or a request for input.
// A refusal (FAILED) is on the record: the loop goes round once more and returns it.
export function inflatePull(st: InflateStream): Result<InflatePiece, InflateError> {
  for (;;) {
    if (st.halt.tag === 'failed') return err(st.halt.error);
    const d = dispatch(st);
    // a full chunk leaves the carry holding the bytes not used: the caller may feed before the next need (see
    // InflateStream); the end has settled (finish)
    if (d === CHUNK) {
      settle(st);
      return ok({ kind: 'chunk', bytes: takeChunk(st) });
    }
    if (d === END) return ok({ kind: 'end', consumed: consumedOf(st), stats: { ...st.stats } });
    if (d === NEED) {
      if (st.outLen > 0) return ok({ kind: 'chunk', bytes: takeChunk(st) });
      if (!st.ended) return ok(NEED_PIECE);
      refuse(st, truncated(st));
    }
  }
}
// No more input will come: the pull from here on finishes the member or reports where it was cut.
export function inflateEnd(st: InflateStream): Result<InflatePiece, InflateError> {
  st.ended = true;
  return inflatePull(st);
}

// Append input. An exhausted carry is replaced by `bytes` itself (no copy); a leftover tail (at most the few bytes one
// step needs) is copied in front of it once, so the caller may drop what it fed before.
export function inflateFeed(st: InflateStream, bytes: Uint8Array): void {
  if (st.p >= st.carry.length) {
    st.base += st.p;
    st.carry = bytes;
    st.p = 0;
    return;
  }
  const tail = st.carry.subarray(st.p);
  const joined = new Uint8Array(tail.length + bytes.length);
  joined.set(tail, 0);
  joined.set(bytes, tail.length);
  st.base += st.p;
  st.carry = joined;
  st.p = 0;
}
// Bytes fed and not consumed: after the end, what follows the member. A view, valid until the next feed or reset.
export function inflateUnread(st: InflateStream): Uint8Array {
  return st.carry.subarray(st.p);
}

const freshStats = (): InflateStats => ({ blocks: 0, stored: 0, fixed: 0, dynamic: 0, literals: 0, matches: 0, matchBytes: 0, maxDist: 0, maxLen: 0 });
// The record's buffers. inflateReset sets every other field a member reads before its first pull (blank's values are
// placeholders, so Stryker's changes to them are equivalent).
function blank(): InflateStream {
  return {
    // Stryker disable next-line all: placeholders, see above
    phase: 'header', halt: RUNNING, bound: cappedBound(), wrap: rawWrap(), maxOutput: 0, declared: 0, maxInput: 0,
    // Stryker disable next-line all: placeholders, see above
    windowSize: INFLATE_WINDOW, ended: false, carry: EMPTY, p: 0, base: 0, bitbuf: 0, bitcnt: 0, markP: 0, markBuf: 0, markCnt: 0,
    window: new Uint8Array(INFLATE_WINDOW), w: 0, out: new Uint8Array(INFLATE_CHUNK), outLen: 0, summed: 0, adler: 1, emitted: 0,
    // Stryker disable next-line all: placeholders, see above (a block header sets `final` and the counts before they are read)
    stats: freshStats(), final: false, storedLeft: 0, nlen: 0, ndist: 0, ncode: 0, lensI: 0,
    lengths: new Uint8Array(DEFLATE_HLIT_MAX + DEFLATE_HDIST_MAX), lencode: FIXED_LIT, lit: FIXED_LIT, dist: FIXED_DIST,
    // Stryker disable next-line all: placeholders, see above (a block header sets the tables before they are read)
    lenFast: FIXED_LIT_FAST, litFast: FIXED_LIT_FAST, distFast: FIXED_DIST_FAST,
    litTab: new Uint16Array(FAST_SIZE), distTab: new Uint16Array(FAST_SIZE), copyLeft: 0, copyDist: 0,
  };
}
// Start a member on an existing record: the window and chunk buffers are kept (a pack scan inflates one member per
// object), everything else starts over. The old carry is dropped.
export function inflateReset(st: InflateStream, opts: InflateStreamOpts): Result<InflateStream, InflateError> {
  const max = checkLimit(opts.bound.maxOutput, 'maxObjectSize');
  if (!max.ok) return max;
  // a raw stream has no header to report first (inflate.ts checks this before reading a block)
  if (opts.wrap.kind === 'raw') {
    const declared = declaredFits(opts.bound, max.value);
    if (!declared.ok) return declared;
  }
  const declared = opts.bound.kind === 'declared' ? opts.bound.size : max.value;
  st.phase = opts.wrap.kind === 'raw' ? 'block' : 'header';
  st.halt = RUNNING;
  st.bound = opts.bound;
  st.wrap = opts.wrap;
  st.maxOutput = max.value;
  st.declared = declared;
  st.maxInput = zlibBound(declared);
  st.windowSize = INFLATE_WINDOW;
  st.ended = false;
  st.carry = EMPTY;
  st.p = 0;
  st.base = 0;
  st.bitbuf = 0;
  st.bitcnt = 0;
  st.w = 0;
  st.outLen = 0;
  st.summed = 0;
  st.adler = 1;
  st.emitted = 0;
  st.stats = freshStats();
  st.storedLeft = 0;
  st.copyLeft = 0;
  st.copyDist = 0;
  return ok(st);
}
export function inflateInit(opts: InflateStreamOpts): Result<InflateStream, InflateError> {
  return inflateReset(blank(), opts);
}

export const streamInflateAttrs = (st: InflateStream): Attrs => ({
  'git.inflate.phase': st.phase, 'git.inflate.consumed': consumedOf(st), 'git.inflate.emitted': st.emitted,
  'git.inflate.window': st.windowSize, 'git.inflate.ended': st.ended,
});
