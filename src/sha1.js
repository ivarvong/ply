// Streaming SHA-1. Needed because crypto.subtle.digest is whole-buffer only,
// and pack trailers / object ids must be computed over data we never hold at once.

import { encodeBytes } from './bytes.js';

export class Sha1 {
  constructor() {
    this.h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
    this.buf = new Uint8Array(64);
    this.bufLen = 0;
    this.len = 0;
    this.w = new Uint32Array(80);
  }

  update(data) {
    if (typeof data === 'string') data = encodeBytes(data);
    this.len += data.length;
    let i = 0;
    if (this.bufLen) {
      const n = Math.min(64 - this.bufLen, data.length);
      this.buf.set(data.subarray(0, n), this.bufLen);
      this.bufLen += n;
      i = n;
      if (this.bufLen < 64) return this;
      this._block(this.buf, 0);
      this.bufLen = 0;
    }
    for (; i + 64 <= data.length; i += 64) this._block(data, i);
    if (i < data.length) {
      this.buf.set(data.subarray(i));
      this.bufLen = data.length - i;
    }
    return this;
  }

  _block(p, o) {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      w[i] = (p[o + 4 * i] << 24) | (p[o + 4 * i + 1] << 16) | (p[o + 4 * i + 2] << 8) | p[o + 4 * i + 3];
    }
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = this.h[0], b = this.h[1], c = this.h[2], d = this.h[3], e = this.h[4];
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    this.h[0] += a; this.h[1] += b; this.h[2] += c; this.h[3] += d; this.h[4] += e;
  }

  digest() {
    const bits = this.len * 8;
    const padLen = this.bufLen < 56 ? 56 - this.bufLen : 120 - this.bufLen;
    const tail = new Uint8Array(padLen + 8);
    tail[0] = 0x80;
    const hi = Math.floor(bits / 0x100000000), lo = bits >>> 0;
    const dv = new DataView(tail.buffer);
    dv.setUint32(padLen, hi);
    dv.setUint32(padLen + 4, lo);
    this.update(tail);
    const out = new Uint8Array(20);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 5; i++) odv.setUint32(i * 4, this.h[i]);
    return out;
  }

  hex() { return toHex(this.digest()); }
}


const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
export function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
  return s;
}
export function fromHex(hex) {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// Streaming hasher with a native fast path: Workers expose crypto.DigestStream (a WritableStream that digests
// incrementally at native speed); node and browsers do not, so the pure-JS Sha1 above is the fallback. Same interface,
// async because the native one is. SHA-1 is ~80% of the streamed-edit CPU (test/calibrate.mjs), so this is the lever.
export function streamingSha1() {
  if (typeof crypto !== 'undefined' && typeof crypto.DigestStream === 'function') {
    const ds = new crypto.DigestStream('SHA-1'); // it IS a WritableStream; `digest` is a promise of the ArrayBuffer
    const w = ds.getWriter();
    return { kind: 'digeststream', update: b => w.write(b), hex: async () => { await w.close(); return toHex(new Uint8Array(await ds.digest)); } };
  }
  const h = new Sha1();
  return { kind: 'js', update: b => { h.update(b); }, hex: async () => h.hex() };
}
