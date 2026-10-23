// Byte helpers.

export const te = new TextEncoder();
export const td = new TextDecoder();

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
  const first = needle[0], last = hay.length - n;
  outer: for (let i = from; i <= last; i++) {
    if (hay[i] !== first) continue;
    for (let j = 1; j < n; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function bytesOf(x) {
  return typeof x === 'string' ? te.encode(x) : x;
}
