// Deterministic PRNG (splitmix32) + generator combinators. Every case is reproducible from its seed.
export class Rng {
  constructor(seed) { this.s = (seed >>> 0) || 0x9e3779b9; }
  u32() { let z = (this.s = (this.s + 0x9e3779b9) >>> 0); z = Math.imul(z ^ (z >>> 16), 0x21f0aaad); z = Math.imul(z ^ (z >>> 15), 0x735a2d97); return (z ^ (z >>> 15)) >>> 0; }
  float() { return this.u32() / 0x100000000; }
  int(lo, hi) { return lo + (this.u32() % (hi - lo + 1)); } // inclusive
  bool(p = 0.5) { return this.float() < p; }
  pick(arr) { return arr[this.u32() % arr.length]; }
  weighted(pairs) { // [[value, weight], ...]
    const total = pairs.reduce((a, [, w]) => a + w, 0);
    let r = this.float() * total;
    for (const [v, w] of pairs) { r -= w; if (r <= 0) return v; }
    return pairs[pairs.length - 1][0];
  }
  bytes(n) { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = this.u32() & 0xff; return b; }
  fork() { return new Rng(this.u32()); }
}

// Random split of a buffer into chunks — used for chunking-invariance properties.
export function splitRandom(rng, buf, { maxChunks = 32, allowEmpty = true } = {}) {
  if (buf.length === 0) return [buf];
  const n = rng.int(1, Math.min(maxChunks, buf.length + (allowEmpty ? 3 : 0)));
  const cuts = new Set();
  for (let i = 0; i < n - 1; i++) cuts.add(rng.int(0, buf.length));
  const pts = [0, ...[...cuts].sort((a, b) => a - b), buf.length];
  const out = [];
  for (let i = 1; i < pts.length; i++) out.push(buf.subarray(pts[i - 1], pts[i]));
  return out;
}
