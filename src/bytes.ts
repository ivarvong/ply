// Byte helpers.
import type { ErrorOf } from './errors.js';
import { fail, plyError, orThrow } from './errors.js';
import type { Result } from './result.js';
import { ok, err } from './result.js';
import { BYTE_VALUES, PKT_HEX_BASE } from './format.js';

export const te: TextEncoder = new TextEncoder();
// git keeps every byte: a leading U+FEFF is part of a tree entry's name (`git ls-tree` prints it, `show HEAD:README`
// does not find `<U+FEFF>README`), so no decoder here swallows it the way the default one does (#43). `td` is for text
// git itself only prints (sideband progress, remote errors): an invalid sequence there becomes U+FFFD.
export const td: TextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// ---- git bytes as strings, losslessly (#43) ----
// Names, messages, idents and ref names are bytes to git; it never requires UTF-8 and never interprets a BOM. ply hands
// them out as strings, so the mapping must be a bijection on bytes: well-formed UTF-8 decodes as UTF-8 (a BOM anywhere
// stays), and each byte of an ill-formed sequence (Latin-1, an overlong, an encoded surrogate, a truncated or stray
// continuation byte) becomes the lone surrogate U+DC00 + byte (U+DC80..U+DCFF), which no UTF-8 decode can produce
// (PEP 383's surrogateescape). `encodeBytes` is the inverse, so a name read from a tree goes back into a tree, a ref,
// or a commit as the bytes git had. A string `encodeBytes` cannot map back exactly is a typed refusal, never U+FFFD.
/* oxlint-disable no-magic-numbers -- UTF-8 is Unicode Table 3-7: lead and continuation byte ranges and sequence lengths */
const LEAD2 = 0xc2;
const LEAD3 = 0xe0;
const LEAD4 = 0xf0;
const LEAD_END = 0xf4;
const CONT = 0x80;
const CONT_END = 0xbf;
const ASCII_END = 0x80;
const ESCAPE = 0xdc_00;
const ESCAPE_LO = 0xdc_80;
const ESCAPE_HI = 0xdc_ff;
const SUR_LO = 0xd8_00;
const SUR_HI = 0xdf_ff;
const HIGH_END = 0xdb_ff;
// Stryker disable next-line ConditionalExpression: `undefined >= lo` is false, so dropping the undefined test changes no result (it is there for the type)
const inRange = (b: number | undefined, lo: number, hi: number): boolean => b !== undefined && b >= lo && b <= hi;
// Length of the well-formed UTF-8 sequence at i (Unicode Table 3-7), or 0. `i` is always < b.length (both callers).
function wellFormedAt(b: Uint8Array, i: number): number {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- in range, see above
  const c = b[i] as number;
  if (c < ASCII_END) return 1;
  if (c < LEAD2) return 0;
  if (c < LEAD3) return inRange(b[i + 1], CONT, CONT_END) ? 2 : 0;
  // E0 needs A0..BF (no overlong), ED needs 80..9F (no surrogate); F0 needs 90..BF (no overlong), F4 needs 80..8F (≤ U+10FFFF)
  if (c < LEAD4) return inRange(b[i + 1], c === LEAD3 ? 0xa0 : CONT, c === 0xed ? 0x9f : CONT_END) && inRange(b[i + 2], CONT, CONT_END) ? 3 : 0;
  if (c <= LEAD_END) return inRange(b[i + 1], c === LEAD4 ? 0x90 : CONT, c === LEAD_END ? 0x8f : CONT_END) && inRange(b[i + 2], CONT, CONT_END) && inRange(b[i + 3], CONT, CONT_END) ? 4 : 0;
  return 0;
}

export function decodeBytes(b: Uint8Array): string {
  // Stryker disable next-line BlockStatement: the fast path; the loop below returns the same string for well-formed bytes
  try { return strict.decode(b); } catch { /* ill-formed: escape byte by byte below */ }
  let s = '';
  let run = 0;
  let i = 0;
  while (i < b.length) {
    const n = wellFormedAt(b, i);
    if (n) { i += n; continue; }
    s += strict.decode(b.subarray(run, i)) + String.fromCodePoint(ESCAPE + (b[i] as number)); // oxlint-disable-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- i < b.length (the loop)
    run = ++i;
  }
  return s + strict.decode(b.subarray(run));
}

// The byte-array rule: every input is a plain `Uint8Array` (any backing buffer); a function that allocates returns
// `Uint8Array<ArrayBuffer>`. The one exception is a Web API typed `BufferSource` (Blob, fetch's body, a stream writer,
// crypto.subtle), which takes only ArrayBuffer-backed views: this is the single cast, and it is sound because a view of
// anything else (a SharedArrayBuffer) is copied into a fresh ArrayBuffer first. Every ply buffer takes the no-copy branch.
export const bufferSource = (b: Uint8Array): Uint8Array<ArrayBuffer> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked: the view's buffer is an ArrayBuffer
  b.buffer instanceof ArrayBuffer ? b as Uint8Array<ArrayBuffer> : b.slice();

export function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function encodeBytesResult(s: unknown, what = 'string'): Result<Uint8Array<ArrayBuffer>, ErrorOf<'bad_request'>> {
  if (typeof s !== 'string') return fail('bad_request', `${what} must be a string`, { what });
  // Stryker disable next-line ConditionalExpression: the fast path; the loop below writes the same bytes for a well-formed string
  if (s.isWellFormed()) return ok(te.encode(s));
  const parts: Uint8Array[] = [];
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    // UTF-16 code units, not code points: the loop looks at each surrogate on its own
    const c = s.charCodeAt(i); // oxlint-disable-line unicorn/prefer-code-point -- see above
    if (c < SUR_LO || c > SUR_HI) continue;
    if (c <= HIGH_END && inRange(s.charCodeAt(i + 1), HIGH_END + 1, SUR_HI)) { i++; continue; } // oxlint-disable-line unicorn/prefer-code-point -- see above
    if (c < ESCAPE_LO || c > ESCAPE_HI) return fail('bad_request', `${what}: lone surrogate U+${c.toString(16).toUpperCase()} is no byte sequence`, { what });
    // Stryker disable next-line ArithmeticOperator: c ± 0xDC00 are one byte mod 256 (0xDC00 is a multiple of 256), which is what the array keeps
    parts.push(te.encode(s.slice(run, i)), Uint8Array.of(c - ESCAPE));
    run = i + 1;
  }
  parts.push(te.encode(s.slice(run)));
  const bytes = concat(parts);
  // `\udcc3\udca9` would write C3 A9, which reads back as `é`: two strings, one byte sequence. Refuse the spelling no read returns.
  if (decodeBytes(bytes) !== s) return fail('bad_request', `${what}: escaped bytes spell well-formed UTF-8; pass the characters`, { what });
  return ok(bytes);
}
// The throwing form, for callers not yet on Result (docs/STACK.md, migration path step 2).
export const encodeBytes = (s: unknown, what?: string): Uint8Array<ArrayBuffer> => orThrow(encodeBytesResult(s, what));

// Text that arrives in pieces (sideband band 2): a sequence cut by a frame boundary waits in `carry` for its
// tail instead of decoding as two U+FFFD. Pure: returns { text, carry }.
export function decodeChunk(carry: Uint8Array, chunk: Uint8Array): { text: string; carry: Uint8Array } {
  // Stryker disable next-line ConditionalExpression,EqualityOperator: concat of an empty carry is a copy of the chunk, the same bytes
  const buf = carry.length > 0 ? concat([carry, chunk]) : chunk;
  let cut = buf.length;
  // Stryker disable next-line ConditionalExpression,LogicalOperator: past k = 3 a lead needs at most 4 ≤ k bytes (no cut), and past the start a read is undefined (neither branch)
  for (let k = 1; k <= 3 && k <= buf.length; k++) {
    const c = buf[buf.length - k] as number; // oxlint-disable-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- k <= buf.length (the loop)
    if (c < ASCII_END) break;
    // the lead byte's sequence length (Table 3-7) in one expression, as git-facing hot paths keep it small
    // oxlint-disable-next-line no-nested-ternary -- see above
    if (c >= LEAD2) { if (k < (c >= LEAD4 ? 4 : c >= LEAD3 ? 3 : 2)) cut = buf.length - k; break; }
  }
  return { text: td.decode(buf.subarray(0, cut)), carry: buf.slice(cut) };
}
/* oxlint-enable no-magic-numbers */

/**
 * Bounded read. `subarray` / `slice` clamp a range that runs past the end and return a short view; parsers that
 * trusted that view accepted truncated fields (the tree-oid off-by-one). `takeResult` returns the typed short read
 * instead, so the length is the bound. The error carries `reason: 'short_read'`: a stream parser that may get more
 * bytes switches on that, never on the message (#76). An absent buffer is a short read of an empty one.
 */
export type ShortReadCode = 'pack_corrupt' | 'protocol';
const shortReadMessage = (off: number, n: number, have: number): string => `short read: need ${n} bytes at ${off}, have ${have}`;
// The short-read error itself, for a parser that reads byte by byte without a take() per byte.
export const shortRead = <C extends ShortReadCode>(code: C, off: number, n: number, have: number): ErrorOf<C> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- plyError's member for C; the compiler cannot resolve Payload<C> for a type parameter
  plyError<ShortReadCode>(code, shortReadMessage(off, n, have), { reason: 'short_read' }) as ErrorOf<C>;
const inBounds = (buf: Uint8Array | null | undefined, off: number, n: number): buf is Uint8Array =>
  buf !== null && buf !== undefined && Number.isInteger(off) && Number.isInteger(n) && off >= 0 && n >= 0 && off + n <= buf.length;
export function takeResult<C extends ShortReadCode = 'pack_corrupt'>(buf: Uint8Array | null | undefined, off: number, n: number, code?: C): Result<Uint8Array, ErrorOf<C>> {
  const have = buf?.length ?? 0;
  // an omitted code is C's default, 'pack_corrupt'; the compiler cannot tie a default value to a type parameter
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  return inBounds(buf, off, n) ? ok(buf.subarray(off, off + n)) : err(shortRead(code ?? 'pack_corrupt' as C, off, n, have));
}
// The throwing form (docs/STACK.md, migration path step 2). Its own plyError, with the code its caller picks, so the
// decision-point inventory (scripts/decision-points.mjs) sees every take() call as a site, as before.
export function take(buf: Uint8Array | null | undefined, off: number, n: number, code: ShortReadCode = 'pack_corrupt'): Uint8Array {
  const have = buf?.length ?? 0;
  if (!inBounds(buf, off, n)) throw plyError(code, shortReadMessage(off, n, have), { reason: 'short_read' });
  return buf.subarray(off, off + n);
}

// Hex digit value of each byte value, either case; -1 for a byte that is not a hex digit. The one hex table: the
// pkt-line length reader and fromHex (sha1.ts) read it.
// oxlint-disable-next-line no-magic-numbers -- sentinel: this byte is not a hex digit
export const HEXV: Int8Array = new Int8Array(BYTE_VALUES).fill(-1);
// ASCII digits: a code unit is the code point
// Stryker disable next-line EqualityOperator: one more pass reads charCodeAt(16), NaN, and a typed array ignores a NaN key
for (let i = 0; i < PKT_HEX_BASE; i++) { HEXV['0123456789abcdef'.charCodeAt(i)] = i; HEXV['0123456789ABCDEF'.charCodeAt(i)] = i; } // oxlint-disable-line unicorn/prefer-code-point -- see above

// First index of needle in hay at or after from; -1 if none.
export function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  const n = needle.length;
  if (n === 0) return from;
  const first = needle[0];
  // Stryker disable next-line ArithmeticOperator: an end index past hay only reads undefined, which is never a needle byte
  const last = hay.length - n;
  outer: for (let i = from; i <= last; i++) {
    if (hay[i] !== first) continue;
    for (let j = 1; j < n; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  // oxlint-disable-next-line no-magic-numbers -- not-found sentinel, the same value String#indexOf returns
  return -1;
}

export function bytesOf(x: string | Uint8Array): Uint8Array {
  return typeof x === 'string' ? te.encode(x) : x;
}
