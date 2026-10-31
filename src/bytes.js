// Byte helpers.
import { thrown as fail } from './errors.ts';

export const te = new TextEncoder();
// git keeps every byte: a leading U+FEFF is part of a tree entry's name (`git ls-tree` prints it, `show HEAD:README`
// does not find `\ufeffREADME`), so no decoder here swallows it the way the default one does (#43). `td` is for text
// git itself only prints (sideband progress, remote errors, ssh banners): an invalid sequence there becomes U+FFFD.
export const td = new TextDecoder('utf-8', { ignoreBOM: true });
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
// Well-formed UTF-8 or a throw; a leading BOM is kept (it is a byte of the text to git, #43).
export const decodeStrict = b => strict.decode(b);

// ---- git bytes as strings, losslessly (#43) ----
// Names, messages, idents and ref names are bytes to git; it never requires UTF-8 and never interprets a BOM. ply hands
// them out as strings, so the mapping must be a bijection on bytes: well-formed UTF-8 decodes as UTF-8 (a BOM anywhere
// stays), and each byte of an ill-formed sequence (Latin-1, an overlong, an encoded surrogate, a truncated or stray
// continuation byte) becomes the lone surrogate U+DC00 + byte (U+DC80..U+DCFF), which no UTF-8 decode can produce
// (PEP 383's surrogateescape). `encodeBytes` is the inverse, so a name read from a tree goes back into a tree, a ref,
// or a commit as the bytes git had. A string `encodeBytes` cannot map back exactly is a typed refusal, never U+FFFD.
/* oxlint-disable no-magic-numbers -- UTF-8 is Unicode Table 3-7: lead and continuation byte ranges and sequence lengths */
const LEAD2 = 0xc2, LEAD3 = 0xe0, LEAD4 = 0xf0, LEAD_END = 0xf4, CONT = 0x80, CONT_END = 0xbf, ASCII_END = 0x80;
const ESCAPE = 0xdc00, ESCAPE_LO = 0xdc80, ESCAPE_HI = 0xdcff, SUR_LO = 0xd800, SUR_HI = 0xdfff, HIGH_END = 0xdbff;
const inRange = (b, lo, hi) => b !== undefined && b >= lo && b <= hi;
// Length of the well-formed UTF-8 sequence at i (Unicode Table 3-7), or 0.
function wellFormedAt(b, i) {
  const c = b[i];
  if (c < ASCII_END) return 1;
  if (c < LEAD2) return 0;
  if (c < LEAD3) return inRange(b[i + 1], CONT, CONT_END) ? 2 : 0;
  // E0 needs A0..BF (no overlong), ED needs 80..9F (no surrogate); F0 needs 90..BF (no overlong), F4 needs 80..8F (≤ U+10FFFF)
  if (c < LEAD4) return inRange(b[i + 1], c === LEAD3 ? 0xa0 : CONT, c === 0xed ? 0x9f : CONT_END) && inRange(b[i + 2], CONT, CONT_END) ? 3 : 0;
  if (c <= LEAD_END) return inRange(b[i + 1], c === LEAD4 ? 0x90 : CONT, c === LEAD_END ? 0x8f : CONT_END) && inRange(b[i + 2], CONT, CONT_END) && inRange(b[i + 3], CONT, CONT_END) ? 4 : 0;
  return 0;
}

export function decodeBytes(b) {
  try { return strict.decode(b); } catch { /* ill-formed: escape byte by byte below */ }
  let s = '', run = 0, i = 0;
  while (i < b.length) {
    const n = wellFormedAt(b, i);
    if (n) { i += n; continue; }
    s += strict.decode(b.subarray(run, i)) + String.fromCharCode(ESCAPE + b[i]);
    run = ++i;
  }
  return s + strict.decode(b.subarray(run));
}

export function encodeBytes(s, what = 'string') {
  if (typeof s !== 'string') throw fail('bad_request', `${what} must be a string`, { what });
  if (s.isWellFormed()) return te.encode(s);
  const parts = [];
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < SUR_LO || c > SUR_HI) continue;
    if (c <= HIGH_END && inRange(s.charCodeAt(i + 1), HIGH_END + 1, SUR_HI)) { i++; continue; }
    if (c < ESCAPE_LO || c > ESCAPE_HI) throw fail('bad_request', `${what}: lone surrogate U+${c.toString(16).toUpperCase()} is no byte sequence`, { what });
    parts.push(te.encode(s.slice(run, i)), Uint8Array.of(c - ESCAPE));
    run = i + 1;
  }
  parts.push(te.encode(s.slice(run)));
  const bytes = concat(parts);
  // `\udcc3\udca9` would write C3 A9, which reads back as `é`: two strings, one byte sequence. Refuse the spelling no read returns.
  if (decodeBytes(bytes) !== s) throw fail('bad_request', `${what}: escaped bytes spell well-formed UTF-8; pass the characters`, { what });
  return bytes;
}

// Text that arrives in pieces (sideband band 2, ssh stderr): a sequence cut by a frame boundary waits in `carry` for its
// tail instead of decoding as two U+FFFD. Pure: returns { text, carry }.
export function decodeChunk(carry, chunk) {
  const buf = carry.length ? concat([carry, chunk]) : chunk;
  let cut = buf.length;
  for (let k = 1; k <= 3 && k <= buf.length; k++) {
    const c = buf[buf.length - k];
    if (c < ASCII_END) break;
    if (c >= LEAD2) { if (k < (c >= LEAD4 ? 4 : c >= LEAD3 ? 3 : 2)) cut = buf.length - k; break; }
  }
  return { text: td.decode(buf.subarray(0, cut)), carry: buf.slice(cut) };
}
/* oxlint-enable no-magic-numbers */

/**
 * Bounded read. `subarray` / `slice` clamp a range that runs past the end and return a short view; parsers that
 * trusted that view accepted truncated fields (the tree-oid off-by-one). `take` throws the typed short-read error
 * instead, so the length is the bound.
 */
export function take(buf, off, n, code = 'pack_corrupt') {
  const len = buf?.length ?? 0;
  if (!Number.isInteger(off) || !Number.isInteger(n) || off < 0 || n < 0 || off + n > len) {
    throw fail(code, `short read: need ${n} bytes at ${off}, have ${len}`);
  }
  return buf.subarray(off, off + n);
}

export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}


// First index of needle in hay at or after from; -1 if none.
export function indexOfBytes(hay, needle, from = 0) {
  const n = needle.length;
  if (n === 0) return from;
  // Stryker disable next-line ArithmeticOperator: an end index past hay only reads undefined, which is never a needle byte
  const first = needle[0], last = hay.length - n;
  outer: for (let i = from; i <= last; i++) {
    if (hay[i] !== first) continue;
    for (let j = 1; j < n; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  // oxlint-disable-next-line no-magic-numbers -- not-found sentinel, the same value String#indexOf returns
  return -1;
}

export function bytesOf(x) {
  return typeof x === 'string' ? te.encode(x) : x;
}
