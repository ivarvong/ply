// Streaming SHA-1. Needed because crypto.subtle.digest is whole-buffer only,
// and pack trailers / object ids must be computed over data we never hold at once.

import { encodeBytes } from './bytes.js';

// Workers' crypto.DigestStream: a WritableStream whose `digest` is a promise of the ArrayBuffer. Not in lib.dom, and
// absent on node and in browsers, hence optional.
declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- augments lib.dom's Crypto: merging needs an interface
  interface Crypto {
    readonly DigestStream?: new (algorithm: string) => WritableStream<Uint8Array> & { readonly digest: Promise<ArrayBuffer> };
  }
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
export function toHex(bytes: Uint8Array): string {
  let s = '';
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- a byte indexes HEX (256 entries); `as`, not the `!` src/ forbids
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i] as number] as string;
  return s;
}
export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export class Sha1 {
  private readonly h = new Uint32Array([0x67_45_23_01, 0xef_cd_ab_89, 0x98_ba_dc_fe, 0x10_32_54_76, 0xc3_d2_e1_f0]);
  private readonly buf = new Uint8Array(64);
  private bufLen = 0;
  private len = 0;
  private readonly w = new Uint32Array(80);

  public update(data: string | Uint8Array): this {
    const bytes = typeof data === 'string' ? encodeBytes(data) : data;
    this.len += bytes.length;
    let i = 0;
    if (this.bufLen) {
      const n = Math.min(64 - this.bufLen, bytes.length);
      this.buf.set(bytes.subarray(0, n), this.bufLen);
      this.bufLen += n;
      i = n;
      if (this.bufLen < 64) return this;
      this.block(this.buf, 0);
      this.bufLen = 0;
    }
    for (; i + 64 <= bytes.length; i += 64) this.block(bytes, i);
    if (i < bytes.length) {
      this.buf.set(bytes.subarray(i));
      this.bufLen = bytes.length - i;
    }
    return this;
  }

  // Every index below is in range (p holds 64 bytes at o, w is 80 words, h is 5), which noUncheckedIndexedAccess cannot
  // see; `as number` says so at no runtime cost (a `?? 0` per read is bundle bytes and a branch in the hot loop).
  /* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- in-range indexed reads, see above (`as number`, not the `!` src/ forbids) */
  private block(p: Uint8Array, o: number): void {
    const w = this.w;
    const h = this.h;
    for (let i = 0; i < 16; i++) {
      w[i] = ((p[o + 4 * i] as number) << 24) | ((p[o + 4 * i + 1] as number) << 16) | ((p[o + 4 * i + 2] as number) << 8) | (p[o + 4 * i + 3] as number);
    }
    for (let i = 16; i < 80; i++) {
      const x = (w[i - 3] as number) ^ (w[i - 8] as number) ^ (w[i - 14] as number) ^ (w[i - 16] as number);
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a_82_79_99; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6e_d9_eb_a1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f_1b_bc_dc; }
      else { f = b ^ c ^ d; k = 0xca_62_c1_d6; }
      // `| 0` is the 32-bit wrap SHA-1 adds modulo, not a truncation
      // oxlint-disable-next-line unicorn/prefer-math-trunc -- see above
      const t = (((a << 5) | (a >>> 27)) + f + e + k + (w[i] as number)) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    (h[0] as number) += a; (h[1] as number) += b; (h[2] as number) += c; (h[3] as number) += d; (h[4] as number) += e;
  }
  /* oxlint-enable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style */

  public digest(): Uint8Array {
    const bits = this.len * 8;
    const padLen = this.bufLen < 56 ? 56 - this.bufLen : 120 - this.bufLen;
    const tail = new Uint8Array(padLen + 8);
    tail[0] = 0x80;
    const hi = Math.floor(bits / 0x1_00_00_00_00);
    const lo = bits >>> 0;
    const dv = new DataView(tail.buffer);
    dv.setUint32(padLen, hi);
    dv.setUint32(padLen + 4, lo);
    this.update(tail);
    const out = new Uint8Array(20);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 5; i++) odv.setUint32(i * 4, this.h[i] as number); // oxlint-disable-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- i < 5, h is 5 words
    return out;
  }

  public hex(): string { return toHex(this.digest()); }
}


export type StreamingSha1 =
  | { readonly kind: 'digeststream'; readonly update: (b: Uint8Array) => Promise<void>; readonly hex: () => Promise<string> }
  | { readonly kind: 'js'; readonly update: (b: Uint8Array) => void; readonly hex: () => Promise<string> };

// Streaming hasher with a native fast path: Workers expose crypto.DigestStream (a WritableStream that digests
// incrementally at native speed); node and browsers do not, so the pure-JS Sha1 above is the fallback. Same interface,
// async because the native one is. SHA-1 is ~80% of the streamed-edit CPU (test/calibrate.mjs), so this is the lever.
export function streamingSha1(): StreamingSha1 {
  if (typeof crypto !== 'undefined' && typeof crypto.DigestStream === 'function') {
    const ds = new crypto.DigestStream('SHA-1'); // it IS a WritableStream; `digest` is a promise of the ArrayBuffer
    const w = ds.getWriter();
    // update hands back the writer's own promise (no extra tick per chunk)
    // oxlint-disable-next-line typescript/promise-function-async -- see above
    return { kind: 'digeststream', update: b => w.write(b), hex: async () => { await w.close(); return toHex(new Uint8Array(await ds.digest)); } };
  }
  const h = new Sha1();
  // async to match the native hasher's interface
  // oxlint-disable-next-line eslint/require-await, typescript/require-await -- see above
  return { kind: 'js', update: b => { h.update(b); }, hex: async () => h.hex() };
}
