// zlib (RFC 1950) + deflate (RFC 1951) tables. The pull inflater and the whole-buffer driver live in inflatestream.ts;
// this module is the Huffman tables, Adler-32, and the result types they share.

import type { ErrorOf } from './errors.js';
import { ADLER_MOD, DEFLATE_BIT_TABLE, ADLER_SHIFT } from './format.js';
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
// noUncheckedIndexedAccess cannot see; `as number` says so at no runtime cost (a `?? 0` per read is bundle bytes).
/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- in-range indexed reads, see above (`as number`, not the `!` src/ forbids) */
export function huffBuild(lengths: ArrayLike<number>): Huffman {
  const count = new Uint16Array(DEFLATE_BIT_TABLE);
  const symbol = new Uint16Array(lengths.length);
  const offs = new Uint16Array(DEFLATE_BIT_TABLE);
  // Stryker disable next-line EqualityOperator: one past the end reads undefined, and count[0] is cleared on the next line
  for (let i = 0; i < lengths.length; i++) { const l = lengths[i] as number; count[l] = (count[l] as number) + 1; }
  count[0] = 0;
  // Stryker disable next-line EqualityOperator: offs is DEFLATE_BIT_TABLE long, so the extra index is ignored
  for (let l = 1; l < DEFLATE_BIT_TABLE; l++) offs[l] = (offs[l - 1] as number) + (count[l - 1] as number);
  // Stryker disable next-line EqualityOperator: lengths[lengths.length] is undefined and the if skips it
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

export type InflateStats = {
  blocks: number; stored: number; fixed: number; dynamic: number;
  literals: number; matches: number; matchBytes: number; maxDist: number; maxLen: number;
};
export type Inflated = { readonly out: Uint8Array; readonly consumed: number; readonly stats: InflateStats };
export type InflateError = ErrorOf<'pack_corrupt'> | ErrorOf<'limit_exceeded'> | ErrorOf<'bad_request'>;

// A deflate block's type (BTYPE, RFC 1951 §3.2.3). 3 is reserved, an invalid block.
export type BlockType = 'stored' | 'fixed' | 'dynamic';
