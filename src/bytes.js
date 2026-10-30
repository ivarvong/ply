// Byte helpers.
import { fail } from './errors.js';

export const te = new TextEncoder();
// git keeps every byte: a leading U+FEFF is part of a tree entry's name (`git ls-tree` prints it, `show HEAD:README`
// does not find `\ufeffREADME`), so the decoder must not swallow it the way the default one does.
export const td = new TextDecoder('utf-8', { ignoreBOM: true });

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
