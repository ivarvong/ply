// Pull inflate (RFC 1950 + RFC 1951). One owner, one mutable record: an immutable record per byte would retain every
// prefix and blow the bound this module exists to hold. Peak is the 32 KiB window, one yielded chunk, and whatever
// unread carry the caller has fed — never the inflated object.
//
// Same refusals as a whole-buffer inflate, except a back-reference past the zlib window (CINFO). A materializing
// caller keeps the whole output, so a distance that lands in that buffer would succeed; this inflater has already
// dropped those bytes. Packs git writes stay inside the window zlib itself would use. Distances past it are pack_corrupt.
//
// Pieces are a closed union: a chunk, a request for more input, or the end of the member. There is no missing value.

import type { ErrorOf, PlyError } from './errors.js';
import { plyError, isPlyError, orThrow } from './errors.js';
import type { Result } from './result.js';
import { ok, err, assertNever } from './result.js';
import { shortRead } from './bytes.js';
import { DEFAULT_LIMITS, checkLimit } from './limits.js';
import type { Huffman, InflateStats, InflateError, Inflated } from './inflate.js';
import { huffBuild, FIXED_LIT, FIXED_DIST, CLORDER, DEFLATE_TABLES } from './inflate.js';

export type { InflateStats } from './inflate.js';

// noUncheckedIndexedAccess cannot see a Uint8Array index that a length check already proved.
/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- in-range indexed reads (`as number`; src/ forbids a bang assertion) */
import type { Attrs } from './otel.js';
import {
  ZLIB_HEADER_BYTES, ZLIB_CM_DEFLATE, ZLIB_CM_MASK, ZLIB_FDICT, ZLIB_HEADER_MOD, ZLIB_CINFO_SHIFT, ZLIB_CINFO_MAX, ZLIB_WINDOW_EXPONENT,
  ADLER_BYTES, ADLER_MOD, ADLER_SHIFT, BYTE_SHIFT, BE32_SHIFTS, zlibBound,
  DEFLATE_BFINAL_BITS, DEFLATE_BTYPE_BITS, DEFLATE_STORED, DEFLATE_FIXED, DEFLATE_DYNAMIC,
  DEFLATE_STORED_HEADER_BYTES, DEFLATE_STORED_LEN_MASK, DEFLATE_STORED_LEN_OFF, DEFLATE_STORED_NLEN_OFF,
  DEFLATE_BIT_TABLE, DEFLATE_LITERALS, DEFLATE_EOB, DEFLATE_LENGTH_CODES,
  DEFLATE_HLIT_BASE, DEFLATE_HLIT_BITS, DEFLATE_HDIST_BASE, DEFLATE_HDIST_BITS, DEFLATE_HCLEN_BASE, DEFLATE_HCLEN_BITS,
  DEFLATE_HLIT_MAX, DEFLATE_HDIST_MAX, DEFLATE_CODELEN_CODES, DEFLATE_CODELEN_BITS,
  DEFLATE_REPEAT_PREV, DEFLATE_REPEAT_ZERO3,
  DEFLATE_REPEAT16_BASE, DEFLATE_REPEAT16_BITS, DEFLATE_REPEAT17_BASE, DEFLATE_REPEAT17_BITS,
  DEFLATE_REPEAT18_BASE, DEFLATE_REPEAT18_BITS,
  INFLATE_WINDOW, INFLATE_CHUNK,
} from './format.js';

const { LBASE, LEXT, DBASE, DEXT } = DEFLATE_TABLES;
const WINDOW_MASK: number = INFLATE_WINDOW - 1;
const NEED: unique symbol = Symbol('need');
const INFLATE_EMPTY = new Uint8Array(0);
// A rep that is neither a fill nor an extra reads the next code-length symbol. `{}` does the same, so the literal
// lives outside the parser: the comparison is the behavior.
const REP_IDLE: RepState = { kind: 'idle' };

export type StreamBound =
  | { readonly kind: 'declared'; readonly size: number; readonly maxOutput: number }
  | { readonly kind: 'capped'; readonly maxOutput: number };
export type StreamWrap =
  | { readonly kind: 'zlib'; readonly verifyAdler: boolean }
  | { readonly kind: 'raw' };
export type InflateStreamOpts = { readonly bound: StreamBound; readonly wrap: StreamWrap };

export const zlibWrap = (verifyAdler: boolean): StreamWrap => ({ kind: 'zlib', verifyAdler });
export const rawWrap = (): StreamWrap => ({ kind: 'raw' });
export const cappedBound = (maxOutput: number = DEFAULT_LIMITS.maxObjectSize): StreamBound => ({ kind: 'capped', maxOutput });
export const declaredBound = (size: number, maxOutput: number = DEFAULT_LIMITS.maxObjectSize): StreamBound => ({ kind: 'declared', size, maxOutput });

export type InflatePhase =
  | 'header' | 'block-final' | 'block-type'
  | 'stored-header' | 'stored'
  | 'dyn-nlen' | 'dyn-ndist' | 'dyn-ncode' | 'dyn-clen' | 'dyn-lens'
  | 'codes' | 'adler' | 'end';
export type CodeSym = 'lit' | 'len' | 'dist' | 'dextra';
export type RepState =
  | { kind: 'idle' }
  | { kind: 'extra'; sym: number; val: number }
  | { kind: 'fill'; val: number; left: number };

// Single owner. Fields are mutable so a pull can resume; sharing the record across pulls that run at once is a bug.
export type InflateStream = {
  phase: InflatePhase;
  bound: StreamBound;
  wrap: StreamWrap;
  maxOutput: number;
  declared: number;
  maxInput: number;
  windowSize: number;
  ended: boolean;
  carry: Uint8Array;
  p: number;
  bitbuf: number;
  bitcnt: number;
  consumed: number;
  emitted: number;
  window: Uint8Array;
  w: number;
  out: Uint8Array;
  outLen: number;
  adlerA: number;
  adlerB: number;
  stats: InflateStats;
  blockFinal: number;
  headerFill: number;
  headerBytes: Uint8Array;
  storedFill: number;
  storedBytes: Uint8Array;
  storedLeft: number;
  nlen: number;
  ndist: number;
  ncode: number;
  lengths: Uint8Array;
  lencode: Huffman;
  lensI: number;
  rep: RepState;
  lit: Huffman;
  dist: Huffman;
  sym: CodeSym;
  li: number;
  di: number;
  curLen: number;
  copyLeft: number;
  copyDist: number;
  inCode: boolean;
  dCode: number;
  dFirst: number;
  dIndex: number;
  dLen: number;
  adlerStarted: boolean;
  adlerFill: number;
  adlerBytes: Uint8Array;
};

export type InflatePiece =
  | { readonly kind: 'need' }
  | { readonly kind: 'chunk'; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'end'; readonly consumed: number; readonly stats: InflateStats };

type Drive = { readonly kind: 'cont' } | { readonly kind: 'chunk' } | { readonly kind: 'end' };
const CONT: Drive = { kind: 'cont' };
const CHUNK: Drive = { kind: 'chunk' };
const END: Drive = { kind: 'end' };

function inflateRefuse(msg: string): never {
  throw plyError('pack_corrupt', msg);
}
function inflateTooLong(st: InflateStream): never {
  inflateRefuse(`inflate: zlib stream longer than its declared size allows (${st.consumed} > ${st.maxInput} for ${st.declared} bytes)`);
}
function inflateLimit(st: InflateStream, got: number): never {
  throw plyError('limit_exceeded', `inflate: output exceeds limit ${st.maxOutput}`, { what: 'inflate output', got, max: st.maxOutput });
}

function inflateCopyStats(s: InflateStats): InflateStats {
  return {
    blocks: s.blocks, stored: s.stored, fixed: s.fixed, dynamic: s.dynamic,
    literals: s.literals, matches: s.matches, matchBytes: s.matchBytes, maxDist: s.maxDist, maxLen: s.maxLen,
  };
}
function inflateEndPiece(st: InflateStream): InflatePiece {
  return { kind: 'end', consumed: st.consumed, stats: inflateCopyStats(st.stats) };
}
function inflateTakeChunk(st: InflateStream): Uint8Array<ArrayBuffer> {
  const bytes = st.out.subarray(0, st.outLen).slice();
  st.outLen = 0;
  return bytes;
}

function inflatePullByte(st: InflateStream): number {
  // oxlint-disable-next-line typescript/only-throw-error -- NEED is a sentinel the pull loop catches; it is not an error value
  if (st.p >= st.carry.length) throw NEED;
  const b = st.carry[st.p] as number;
  st.p += 1;
  st.consumed += 1;
  return b;
}
function inflateBits(st: InflateStream, n: number): number {
  while (st.bitcnt < n) {
    const b = inflatePullByte(st);
    st.bitbuf |= b << st.bitcnt;
    st.bitcnt += BYTE_SHIFT;
  }
  const v = st.bitbuf & ((1 << n) - 1);
  st.bitbuf >>>= n;
  st.bitcnt -= n;
  return v;
}
// puff's decode, one code bit at a time. `inCode` keeps the bit already taken when the carry runs out, so the same
// Huffman table is resumed (the caller stays in the phase that chose it).
function inflateDecode(st: InflateStream, h: Huffman): number {
  if (!st.inCode) {
    st.inCode = true;
    st.dCode = 0;
    st.dFirst = 0;
    st.dIndex = 0;
    st.dLen = 1;
  }
  while (st.dLen < DEFLATE_BIT_TABLE) {
    if (st.bitcnt === 0) {
      st.bitbuf = inflatePullByte(st);
      st.bitcnt = BYTE_SHIFT;
    }
    st.dCode |= st.bitbuf & 1;
    st.bitbuf >>>= 1;
    st.bitcnt -= 1;
    const count = h.count[st.dLen] as number;
    if (st.dCode - st.dFirst < count) {
      const sym = h.symbol[st.dIndex + st.dCode - st.dFirst] as number;
      st.inCode = false;
      return sym;
    }
    st.dIndex += count;
    st.dFirst = (st.dFirst + count) << 1;
    st.dCode <<= 1;
    st.dLen += 1;
  }
  // Stryker disable next-line BooleanLiteral: the refusal throws before the next symbol, and a pull that returned Err is not resumed
  st.inCode = false;
  return inflateRefuse('inflate: invalid huffman code');
}
function inflateEmit(st: InflateStream, b: number): boolean {
  const next = st.emitted + 1;
  switch (st.bound.kind) {
    case 'declared':
      if (next > st.bound.size) inflateRefuse(`inflate: output exceeds expected ${st.bound.size}`);
      break;
    case 'capped':
      break;
    // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
    default: return assertNever(st.bound);
  }
  if (next > st.maxOutput) inflateLimit(st, next);
  st.adlerA = (st.adlerA + b) % ADLER_MOD;
  st.adlerB = (st.adlerB + st.adlerA) % ADLER_MOD;
  st.window[st.w] = b;
  st.w = (st.w + 1) & WINDOW_MASK;
  st.out[st.outLen] = b;
  st.outLen += 1;
  st.emitted = next;
  return st.outLen === INFLATE_CHUNK;
}
function inflateWindowByte(st: InflateStream): number {
  const from = (st.w - st.copyDist) & WINDOW_MASK;
  return st.window[from] as number;
}
function inflateFinishBlock(st: InflateStream): void {
  if (st.blockFinal !== 0) {
    st.phase = st.wrap.kind === 'raw' ? 'end' : 'adler';
    return;
  }
  st.phase = 'block-final';
}
function inflateFinishStream(st: InflateStream): void {
  if (st.bound.kind === 'declared' && st.emitted !== st.bound.size) inflateRefuse(`inflate: size ${st.emitted} != expected ${st.bound.size}`);
  if (st.consumed > st.maxInput) inflateTooLong(st);
  st.phase = 'end';
}
function inflateU16(b: Uint8Array, off: number): number {
  return (b[off] as number) | ((b[off + 1] as number) << BYTE_SHIFT);
}

function inflateStepHeader(st: InflateStream): Drive {
  while (st.headerFill < ZLIB_HEADER_BYTES) {
    st.headerBytes[st.headerFill] = inflatePullByte(st);
    st.headerFill += 1;
  }
  const cmf = st.headerBytes[0] as number;
  const flg = st.headerBytes[1] as number;
  const method = cmf & ZLIB_CM_MASK;
  if (method !== ZLIB_CM_DEFLATE) inflateRefuse(`zlib: unsupported method ${method}`);
  const cinfo = cmf >> ZLIB_CINFO_SHIFT;
  if (cinfo > ZLIB_CINFO_MAX) inflateRefuse(`zlib: window size ${cinfo} is not a zlib window`);
  if (((cmf << BYTE_SHIFT) | flg) % ZLIB_HEADER_MOD !== 0) inflateRefuse('zlib: bad header check');
  if ((flg & ZLIB_FDICT) !== 0) inflateRefuse('zlib: preset dictionary not supported');
  st.windowSize = 1 << (cinfo + ZLIB_WINDOW_EXPONENT);
  st.phase = 'block-final';
  return CONT;
}
function inflateStepBlockFinal(st: InflateStream): Drive {
  if (st.consumed > st.maxInput) inflateTooLong(st);
  st.blockFinal = inflateBits(st, DEFLATE_BFINAL_BITS);
  st.phase = 'block-type';
  return CONT;
}
function inflateBeginStored(st: InflateStream): Drive {
  st.stats.stored += 1;
  st.bitbuf = 0;
  st.bitcnt = 0;
  st.storedFill = 0;
  st.phase = 'stored-header';
  return CONT;
}
function inflateBeginFixed(st: InflateStream): Drive {
  st.stats.fixed += 1;
  st.lit = FIXED_LIT;
  st.dist = FIXED_DIST;
  st.sym = 'lit';
  st.copyLeft = 0;
  st.inCode = false;
  st.phase = 'codes';
  return CONT;
}
function inflateBeginDynamic(st: InflateStream): Drive {
  st.stats.dynamic += 1;
  st.phase = 'dyn-nlen';
  return CONT;
}
function inflateStepBlockType(st: InflateStream): Drive {
  const btype = inflateBits(st, DEFLATE_BTYPE_BITS);
  st.stats.blocks += 1;
  if (btype === DEFLATE_STORED) return inflateBeginStored(st);
  if (btype === DEFLATE_FIXED) return inflateBeginFixed(st);
  if (btype === DEFLATE_DYNAMIC) return inflateBeginDynamic(st);
  return inflateRefuse('inflate: invalid block type');
}
function inflateStepStoredHeader(st: InflateStream): Drive {
  if (st.storedFill < DEFLATE_STORED_HEADER_BYTES) {
    st.storedBytes[st.storedFill] = inflatePullByte(st);
    st.storedFill += 1;
    return CONT;
  }
  const len = inflateU16(st.storedBytes, DEFLATE_STORED_LEN_OFF);
  const nlen = inflateU16(st.storedBytes, DEFLATE_STORED_NLEN_OFF);
  if (len !== (~nlen & DEFLATE_STORED_LEN_MASK)) inflateRefuse('inflate: stored length check failed');
  st.storedLeft = len;
  st.phase = 'stored';
  return CONT;
}
function inflateStepStored(st: InflateStream): Drive {
  if (st.storedLeft > 0) {
    const b = inflatePullByte(st);
    st.storedLeft -= 1;
    if (inflateEmit(st, b)) return CHUNK;
    return CONT;
  }
  inflateFinishBlock(st);
  return CONT;
}
function inflateStepDynNlen(st: InflateStream): Drive {
  st.nlen = inflateBits(st, DEFLATE_HLIT_BITS) + DEFLATE_HLIT_BASE;
  st.phase = 'dyn-ndist';
  return CONT;
}
function inflateStepDynNdist(st: InflateStream): Drive {
  st.ndist = inflateBits(st, DEFLATE_HDIST_BITS) + DEFLATE_HDIST_BASE;
  st.phase = 'dyn-ncode';
  return CONT;
}
function inflateStepDynNcode(st: InflateStream): Drive {
  st.ncode = inflateBits(st, DEFLATE_HCLEN_BITS) + DEFLATE_HCLEN_BASE;
  if (st.nlen > DEFLATE_HLIT_MAX || st.ndist > DEFLATE_HDIST_MAX) inflateRefuse('inflate: bad dynamic counts');
  st.lengths = new Uint8Array(DEFLATE_HLIT_MAX + DEFLATE_HDIST_MAX);
  st.lensI = 0;
  st.phase = 'dyn-clen';
  return CONT;
}
function inflateStepDynClen(st: InflateStream): Drive {
  if (st.lensI < st.ncode) {
    const idx = CLORDER[st.lensI] as number;
    st.lengths[idx] = inflateBits(st, DEFLATE_CODELEN_BITS);
    st.lensI += 1;
    return CONT;
  }
  st.lencode = huffBuild(st.lengths.subarray(0, DEFLATE_CODELEN_CODES));
  st.lensI = 0;
  st.rep = REP_IDLE;
  st.phase = 'dyn-lens';
  return CONT;
}
function inflateRepFill(st: InflateStream, rep: { kind: 'fill'; val: number; left: number }): Drive {
  st.lengths[st.lensI] = rep.val;
  st.lensI += 1;
  const left = rep.left - 1;
  st.rep = left > 0 ? { kind: 'fill', val: rep.val, left } : REP_IDLE;
  return CONT;
}
function inflateRepSymbol(st: InflateStream): Drive {
  const sym = inflateDecode(st, st.lencode);
  if (sym < DEFLATE_REPEAT_PREV) {
    st.lengths[st.lensI] = sym;
    st.lensI += 1;
    return CONT;
  }
  if (sym === DEFLATE_REPEAT_PREV && st.lensI === 0) inflateRefuse('inflate: repeat with no previous');
  const val = sym === DEFLATE_REPEAT_PREV ? st.lengths[st.lensI - 1] as number : 0;
  st.rep = { kind: 'extra', sym, val };
  return CONT;
}
function inflateRepExtra(st: InflateStream, rep: { kind: 'extra'; sym: number; val: number }): Drive {
  let n = DEFLATE_REPEAT18_BASE;
  let bits = DEFLATE_REPEAT18_BITS;
  if (rep.sym === DEFLATE_REPEAT_PREV) {
    n = DEFLATE_REPEAT16_BASE;
    bits = DEFLATE_REPEAT16_BITS;
  } else if (rep.sym === DEFLATE_REPEAT_ZERO3) {
    n = DEFLATE_REPEAT17_BASE;
    bits = DEFLATE_REPEAT17_BITS;
  }
  n += inflateBits(st, bits);
  if (st.lensI + n > st.nlen + st.ndist) inflateRefuse('inflate: repeat overflow');
  st.rep = { kind: 'fill', val: rep.val, left: n };
  return CONT;
}
function inflateFinishDyn(st: InflateStream): Drive {
  const eob = st.lengths[DEFLATE_EOB] as number;
  if (eob === 0) inflateRefuse('inflate: no end-of-block code');
  st.lit = huffBuild(st.lengths.subarray(0, st.nlen));
  st.dist = huffBuild(st.lengths.subarray(st.nlen, st.nlen + st.ndist));
  st.sym = 'lit';
  st.copyLeft = 0;
  st.inCode = false;
  st.phase = 'codes';
  return CONT;
}
function inflateStepDynLens(st: InflateStream): Drive {
  if (st.rep.kind === 'fill') return inflateRepFill(st, st.rep);
  if (st.rep.kind === 'extra') return inflateRepExtra(st, st.rep);
  if (st.lensI >= st.nlen + st.ndist) return inflateFinishDyn(st);
  return inflateRepSymbol(st);
}
function inflateStepLit(st: InflateStream): Drive {
  const sym = inflateDecode(st, st.lit);
  if (sym < DEFLATE_LITERALS) {
    st.stats.literals += 1;
    if (inflateEmit(st, sym)) return CHUNK;
    return CONT;
  }
  if (sym === DEFLATE_EOB) {
    inflateFinishBlock(st);
    return CONT;
  }
  const li = sym - DEFLATE_HLIT_BASE;
  if (li >= DEFLATE_LENGTH_CODES) inflateRefuse('inflate: bad length symbol');
  st.li = li;
  st.sym = 'len';
  return CONT;
}
function inflateStepLen(st: InflateStream): Drive {
  st.curLen = (LBASE[st.li] as number) + inflateBits(st, LEXT[st.li] as number);
  st.sym = 'dist';
  return CONT;
}
function inflateStepDist(st: InflateStream): Drive {
  const di = inflateDecode(st, st.dist);
  // A distance table is built from at most DEFLATE_HDIST_MAX lengths, so the decoded symbol is inside that table.
  st.di = di;
  st.sym = 'dextra';
  return CONT;
}
function inflateStepDextra(st: InflateStream): Drive {
  const d = (DBASE[st.di] as number) + inflateBits(st, DEXT[st.di] as number);
  if (d > st.emitted || d > st.windowSize) inflateRefuse('inflate: distance too far back');
  st.stats.matches += 1;
  st.stats.matchBytes += st.curLen;
  // Stryker disable next-line EqualityOperator: an equal distance stores the same maximum
  if (d > st.stats.maxDist) st.stats.maxDist = d;
  // Stryker disable next-line EqualityOperator: an equal length stores the same maximum
  if (st.curLen > st.stats.maxLen) st.stats.maxLen = st.curLen;
  st.copyDist = d;
  st.copyLeft = st.curLen;
  st.sym = 'lit';
  return CONT;
}
function inflateStepCodes(st: InflateStream): Drive {
  if (st.copyLeft > 0) {
    const b = inflateWindowByte(st);
    st.copyLeft -= 1;
    if (inflateEmit(st, b)) return CHUNK;
    return CONT;
  }
  switch (st.sym) {
    case 'lit': return inflateStepLit(st);
    case 'len': return inflateStepLen(st);
    case 'dist': return inflateStepDist(st);
    case 'dextra': return inflateStepDextra(st);
    // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
    default: return assertNever(st.sym);
  }
}
function inflateStepAdler(st: InflateStream): Drive {
  // Adler bytes are read with inflatePullByte, which does not consult the bit buffer, so clearing it changes no sum.
  // Stryker disable next-line BooleanLiteral,ConditionalExpression,BlockStatement: skipping the clear still reads the same four bytes
  if (!st.adlerStarted) {
    st.bitbuf = 0;
    st.bitcnt = 0;
    st.adlerStarted = true;
    st.adlerFill = 0;
  }
  if (st.adlerFill < ADLER_BYTES) {
    st.adlerBytes[st.adlerFill] = inflatePullByte(st);
    st.adlerFill += 1;
    return CONT;
  }
  const want = (((st.adlerBytes[0] as number) << (BE32_SHIFTS[0] as number)) | ((st.adlerBytes[1] as number) << (BE32_SHIFTS[1] as number)) | ((st.adlerBytes[2] as number) << (BE32_SHIFTS[2] as number)) | (st.adlerBytes[BE32_SHIFTS.length - 1] as number)) >>> 0;
  const got = ((st.adlerB << ADLER_SHIFT) | st.adlerA) >>> 0;
  switch (st.wrap.kind) {
    case 'zlib':
      if (st.wrap.verifyAdler && got !== want) inflateRefuse('inflate: adler32 mismatch');
      break;
    // Stryker disable next-line ConditionalExpression,StringLiteral: a raw member never enters the adler phase
    case 'raw': break;
    // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
    default: return assertNever(st.wrap);
  }
  inflateFinishStream(st);
  return CONT;
}
function inflateDispatch(st: InflateStream): Drive {
  switch (st.phase) {
    case 'end': return st.outLen > 0 ? CHUNK : END;
    case 'header': return inflateStepHeader(st);
    case 'block-final': return inflateStepBlockFinal(st);
    case 'block-type': return inflateStepBlockType(st);
    case 'stored-header': return inflateStepStoredHeader(st);
    case 'stored': return inflateStepStored(st);
    case 'dyn-nlen': return inflateStepDynNlen(st);
    case 'dyn-ndist': return inflateStepDynNdist(st);
    case 'dyn-ncode': return inflateStepDynNcode(st);
    case 'dyn-clen': return inflateStepDynClen(st);
    case 'dyn-lens': return inflateStepDynLens(st);
    case 'codes': return inflateStepCodes(st);
    case 'adler': return inflateStepAdler(st);
    // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
    default: return assertNever(st.phase);
  }
}
function inflateLoop(st: InflateStream): Drive {
  for (;;) {
    const step = inflateDispatch(st);
    if (step.kind !== 'cont') return step;
  }
}
function inflateEnded(st: InflateStream): ErrorOf<'pack_corrupt'> {
  if (st.phase === 'header') return shortRead('pack_corrupt', 0, ZLIB_HEADER_BYTES, st.headerFill);
  if (st.phase === 'adler') return plyError('pack_corrupt', 'inflate: truncated adler32');
  if (st.phase === 'stored-header') return plyError('pack_corrupt', 'inflate: truncated stored header');
  if (st.phase === 'stored') return plyError('pack_corrupt', 'inflate: truncated stored block');
  return plyError('pack_corrupt', 'inflate: unexpected end of input');
}

export function inflateInit(opts: InflateStreamOpts): Result<InflateStream, InflateError> {
  const max = checkLimit(opts.bound.maxOutput, 'maxObjectSize');
  if (!max.ok) return max;
  switch (opts.bound.kind) {
    case 'declared':
      if (opts.bound.size > max.value) {
        return err(plyError('limit_exceeded', `inflate: expected size ${opts.bound.size} exceeds limit ${max.value}`, { what: 'inflate expected size', got: opts.bound.size, max: max.value }));
      }
      break;
    case 'capped':
      break;
    // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
    default: return assertNever(opts.bound);
  }
  const declared = opts.bound.kind === 'declared' ? opts.bound.size : max.value;
  const st: InflateStream = {
    phase: opts.wrap.kind === 'raw' ? 'block-final' : 'header',
    bound: opts.bound, wrap: opts.wrap, maxOutput: max.value, declared, maxInput: zlibBound(declared),
    windowSize: INFLATE_WINDOW, ended: false, carry: INFLATE_EMPTY, p: 0, bitbuf: 0, bitcnt: 0, consumed: 0, emitted: 0,
    window: new Uint8Array(INFLATE_WINDOW), w: 0, out: new Uint8Array(INFLATE_CHUNK), outLen: 0,
    adlerA: 1, adlerB: 0,
    stats: { blocks: 0, stored: 0, fixed: 0, dynamic: 0, literals: 0, matches: 0, matchBytes: 0, maxDist: 0, maxLen: 0 },
    blockFinal: 0, headerFill: 0, headerBytes: new Uint8Array(ZLIB_HEADER_BYTES),
    storedFill: 0, storedBytes: new Uint8Array(DEFLATE_STORED_HEADER_BYTES), storedLeft: 0,
    nlen: 0, ndist: 0, ncode: 0, lengths: INFLATE_EMPTY, lencode: FIXED_LIT, lensI: 0, rep: REP_IDLE,
    lit: FIXED_LIT, dist: FIXED_DIST,
    // Stryker disable next-line StringLiteral: beginFixed and inflateFinishDyn set the symbol again before a code is read
    sym: 'lit',
    li: 0, di: 0, curLen: 0, copyLeft: 0, copyDist: 0,
    // Stryker disable next-line BooleanLiteral: dCode, dFirst, dIndex and dLen are already the reset values
    inCode: false,
    dCode: 0, dFirst: 0, dIndex: 0, dLen: 1,
    // Stryker disable next-line BooleanLiteral: adler bytes are pulled with inflatePullByte, which ignores the bit buffer
    adlerStarted: false,
    adlerFill: 0, adlerBytes: new Uint8Array(ADLER_BYTES),
  };
  return ok(st);
}

// Append bytes. When the previous carry is exhausted the new buffer is taken as-is (no copy). A leftover tail is
// copied once and the previous buffer can be dropped by the caller.
export function inflateFeed(st: InflateStream, bytes: Uint8Array): void {
  if (st.p >= st.carry.length) {
    st.carry = bytes;
    st.p = 0;
    return;
  }
  const tail = st.carry.subarray(st.p);
  const n = new Uint8Array(tail.length + bytes.length);
  n.set(tail, 0);
  n.set(bytes, tail.length);
  st.carry = n;
  st.p = 0;
}
// Drop the carry after the caller has taken the unread tail, so the fed buffer can be collected.
export function inflateRelease(st: InflateStream): void {
  st.carry = INFLATE_EMPTY;
  st.p = 0;
}
// Bytes fed but not consumed. A view: valid until the next feed or release.
export function inflateUnread(st: InflateStream): Uint8Array {
  return st.carry.subarray(st.p);
}

// The loop throws only its own refusals. Anything else is a bug and stays thrown.
function isStreamRefusal(e: PlyError): e is InflateError {
  return e.code === 'pack_corrupt' || e.code === 'limit_exceeded' || e.code === 'bad_request';
}

export function inflatePull(st: InflateStream): Result<InflatePiece, InflateError> {
  try {
    const step = inflateLoop(st);
    if (step.kind === 'chunk') return ok({ kind: 'chunk', bytes: inflateTakeChunk(st) });
    return ok(inflateEndPiece(st));
  } catch (e) {
    if (e === NEED) {
      if (st.outLen > 0) return ok({ kind: 'chunk', bytes: inflateTakeChunk(st) });
      if (st.ended) return err(inflateEnded(st));
      return ok({ kind: 'need' });
    }
    // Stryker disable next-line LogicalOperator: a non-PlyError has no refusal code, so both forms rethrow it
    if (isPlyError(e) && isStreamRefusal(e)) return err(e);
    throw e;
  }
}
export function inflateEnd(st: InflateStream): Result<InflatePiece, InflateError> {
  st.ended = true;
  return inflatePull(st);
}

function inflateJoin(parts: ReadonlyArray<Uint8Array<ArrayBuffer>>, total: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// The whole-buffer entry. It feeds `buf` from `pos` and pulls until the member ends, so a caller that already
// holds the zlib bytes and wants the object gets one buffer. Chunked callers use inflatePull and drop each chunk.
// @decoder inflateResult prefix=inflate
export function inflateResult(buf: Uint8Array, pos: number, opts: InflateStreamOpts): Result<Inflated, InflateError> {
  const init = inflateInit(opts);
  if (!init.ok) return init;
  const st = init.value;
  inflateFeed(st, pos === 0 ? buf : buf.subarray(pos));
  st.ended = true;
  const parts: Array<Uint8Array<ArrayBuffer>> = [];
  let total = 0;
  for (;;) {
    const step = inflatePull(st);
    if (!step.ok) return step;
    switch (step.value.kind) {
      case 'chunk':
        parts.push(step.value.bytes);
        total += step.value.bytes.length;
        continue;
      case 'end':
        return ok({ out: inflateJoin(parts, total), consumed: step.value.consumed, stats: step.value.stats });
      // Stryker disable next-line BlockStatement,ConditionalExpression,StringLiteral,ObjectLiteral,CallExpression: ended is set above, so a short member is an Err before this
      case 'need': return err(plyError('pack_corrupt', 'inflate: unexpected end of input'));
      // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
      default: return assertNever(step.value);
    }
  }
}
// @decoder inflate prefix=inflate
export function inflate(buf: Uint8Array, pos: number, opts: InflateStreamOpts): Inflated {
  return orThrow(inflateResult(buf, pos, opts));
}

export function streamInflateAttrs(st: InflateStream): Attrs {
  return {
    'git.inflate.phase': st.phase,
    'git.inflate.consumed': st.consumed,
    'git.inflate.emitted': st.emitted,
    'git.inflate.window': st.windowSize,
    'git.inflate.ended': st.ended,
  };
}
