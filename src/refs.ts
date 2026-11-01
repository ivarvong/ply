// git's `version:refname` order (tag --sort=version:refname, for-each-ref). versioncmp.c is glibc strverscmp
// (the state names below are its S_N / S_I / S_F / S_Z) plus versionsort.suffix: a configured suffix that touches
// the first byte where the two names differ sorts before a name without it, and earlier in the suffix list sorts
// first. The empty suffix is the release itself, so it can sit between prereleases.
//
// Names are compared as the bytes git stores. A well-formed string is its UTF-8 (bytewise UTF-8 order is code-point
// order, which is not UTF-16 code-unit order for a character outside the BMP). A surrogate-escaped string from
// decodeBytes is the original bytes. An interior NUL ends the comparison, as versioncmp stops on the C string.
// Pure: no I/O, so no span. A tag list's span belongs to the ls-refs that fetched the names.
//
// A suffix list that places the release among prereleases makes versioncmp not a strict weak order.
// With ['-alpha', '-beta', '', '-gamma', '-delta'], 00.1-gamma < 00.2-alpha < 00.10-alpha and 00.10-alpha < 00.1-gamma.
// With ['', '-rc'], 00.1-rc1 < 00.2 < 00.10 and 00.10 < 00.1-rc1. The names differ once inside a digit run
// (the longer run wins) and once at a suffix the list reorders.
// Two names are versioncmp, which is the order `git tag -l --sort=version:refname` prints for those two names.
// A longer listing is git's qsort of that relation, and a cyclic relation has no listing that keeps every pair,
// so a whole tag list sorted here follows versioncmp.
import { encodeBytes } from './bytes.js';

/** `versionsort.suffix`, in the order git config lists them. `''` is the release, placed among the suffixes. */
export type VersionRefnameOrder = {
  readonly suffixes?: readonly string[];
};

// glibc strverscmp, as versioncmp.c carries it. The state is the row (normal, integral, fractional, leading zeros)
// plus the class of the byte just read: not a digit, a non-zero digit, or '0'. Rows are 3 apart so the class fits
// in the low part of the index (versioncmp.c's S_N=0, S_I=3, S_F=6, S_Z=9).
const S_N = 0;
const S_I = 3;
const S_F = 6;
const S_Z = 9;
const CLASS_X = 0;
const CLASS_D = 1;
const CLASS_Z = 2;
const CMP = 2;
const LEN = 3;
const NUL = 0;
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;

// Next row after consuming a byte of the given class. Index = row + class.
const NEXT_ROW: readonly number[] = Object.freeze([
  S_N, S_I, S_Z, // S_N, then x / d / 0
  S_N, S_I, S_I, // S_I
  S_N, S_F, S_F, // S_F
  S_N, S_F, S_Z, // S_Z
]);

// How the first differing bytes decide. Index = (row + class of the left byte) * 3 + class of the right byte.
// CMP: the byte difference. LEN: the longer remaining digit run wins, else the byte difference.
// -1 / +1: that side wins regardless of the bytes (a leading zero against an integral digit).
const RESULT: readonly number[] = Object.freeze([
  CMP, CMP, CMP, CMP, LEN, CMP, CMP, CMP, CMP, // S_N
  CMP, -1, -1, 1, LEN, LEN, 1, LEN, LEN, // S_I
  CMP, CMP, CMP, CMP, CMP, CMP, CMP, CMP, CMP, // S_F
  CMP, 1, 1, -1, CMP, CMP, -1, CMP, CMP, // S_Z
]);

type ResultKind = -1 | 1 | typeof CMP | typeof LEN;

function byteAt(bytes: Uint8Array, i: number): number {
  if (i >= bytes.length) return NUL;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- i < bytes.length
  return bytes[i] as number;
}

// '0' is its own class: a leading zero is fractional, not a longer integer.
function digitClass(c: number): number {
  if (c === DIGIT_ZERO) return CLASS_Z;
  // Stryker disable next-line EqualityOperator: '0' already returned CLASS_Z above
  if (c > DIGIT_ZERO && c <= DIGIT_NINE) return CLASS_D;
  return CLASS_X;
}

function isDigit(c: number): boolean {
  return c >= DIGIT_ZERO && c <= DIGIT_NINE;
}

// The row those bytes leave us in. `state` is always a NEXT_ROW index (0..11): it starts as a class and then
// becomes a row plus the next byte's class.
function nextRow(state: number): number {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- see above
  return NEXT_ROW[state] as number;
}

function resultKind(state: number, class2: number): ResultKind {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- state is 0..11 and class2 is 0..2, so the index is 0..35
  const kind = RESULT[(state * 3) + class2] as ResultKind;
  return kind;
}

// strverscmp's LEN: p1 and p2 already point past the first differing digits. A longer run of digits is greater;
// the same length keeps the byte difference. The increments match versioncmp.c, including the byte each side
// consumes while testing the run.
function byDigitLength(left: Uint8Array, i1: number, right: Uint8Array, i2: number, diff: number): number {
  let a = i1;
  let b = i2;
  while (isDigit(byteAt(left, a))) {
    a += 1;
    if (!isDigit(byteAt(right, b))) return 1;
    b += 1;
  }
  return isDigit(byteAt(right, b)) ? -1 : diff;
}

type SuffixHit = { readonly confPos: number; readonly start: number; readonly len: number };

const noHit = (off: number): SuffixHit => ({ confPos: -1, start: off, len: -1 });

function startsWithAt(tag: Uint8Array, i: number, suffix: Uint8Array): boolean {
  for (let k = 0; k < suffix.length; k++) {
    if (byteAt(tag, i + k) !== byteAt(suffix, k)) return false;
  }
  return true;
}

// A better hit starts earlier, or at the same offset and longer (versioncmp.c find_better_matching_suffix).
// The search runs left to right and keeps the first hit inside that window, so the earliest start wins and an
// equal-length suffix does not replace one already found.
function betterHit(tag: Uint8Array, suffix: Uint8Array, start: number, confPos: number, hit: SuffixHit): SuffixHit {
  const end = hit.len < suffix.length ? hit.start : hit.start - 1;
  for (let i = start; i <= end; i++) {
    if (startsWithAt(tag, i, suffix)) return { confPos, start: i, len: suffix.length };
  }
  return hit;
}

// Non-null when a configured suffix touches `off` (the first differing byte) on one side only, or the two sides
// matched different suffixes: the result is then the suffix-list order, not the bytes.
function suffixOrder(left: Uint8Array, right: Uint8Array, off: number, suffixes: readonly Uint8Array[]): number | null {
  let hitL = noHit(off);
  let hitR = noHit(off);
  let i = 0;
  for (const suffix of suffixes) {
    // Stryker disable next-line EqualityOperator,ConditionalExpression: a start before 0 reads no suffix byte, and a suffix as long as the offset already starts at 0
    const start = suffix.length < off ? off - suffix.length : 0;
    hitL = betterHit(left, suffix, start, i, hitL);
    hitR = betterHit(right, suffix, start, i, hitR);
    i += 1;
  }
  // Stryker disable next-line ConditionalExpression: both misses share one confPos, and the next comparison returns null
  if (hitL.confPos < 0 && hitR.confPos < 0) return null;
  if (hitL.confPos === hitR.confPos) return null;
  if (hitL.confPos >= 0 && hitR.confPos >= 0) return hitL.confPos - hitR.confPos;
  return hitL.confPos >= 0 ? -1 : 1;
}

function versioncmp(left: Uint8Array, right: Uint8Array, suffixes: readonly Uint8Array[]): number {
  let i1 = 0;
  let i2 = 0;
  let c1 = byteAt(left, i1);
  let c2 = byteAt(right, i2);
  i1 += 1;
  i2 += 1;
  let state = S_N + digitClass(c1);
  let diff = c1 - c2;
  while (diff === 0) {
    if (c1 === NUL) return 0;
    state = nextRow(state);
    c1 = byteAt(left, i1);
    c2 = byteAt(right, i2);
    i1 += 1;
    i2 += 1;
    state += digitClass(c1);
    diff = c1 - c2;
  }
  const ordered = suffixOrder(left, right, i1 - 1, suffixes);
  if (ordered !== null) return ordered;
  const kind = resultKind(state, digitClass(c2));
  if (kind === LEN) return byDigitLength(left, i1, right, i2, diff);
  if (kind === CMP) return diff;
  return kind;
}

/**
 * git `versioncmp` for two refnames, with `versionsort.suffix` applied.
 * Negative when `a` sorts first. The value is versioncmp's own: a byte difference, a longer digit run, or the
 * distance between two matched suffixes. Equal names compare equal.
 * A non-string, or a lone surrogate that is not a byte, is `bad_request` (the same refusal as any other ref byte string).
 */
export function compareVersionRefnames(a: string, b: string, order?: VersionRefnameOrder): number {
  const listed = order?.suffixes ?? [];
  // Stryker disable next-line ArrayDeclaration: a non-byte element never equals a suffix byte, so it matches no name
  const suffixes: Uint8Array[] = [];
  for (const suffix of listed) suffixes.push(encodeBytes(suffix, 'versionsort.suffix'));
  return versioncmp(encodeBytes(a, 'refname'), encodeBytes(b, 'refname'), suffixes);
}
