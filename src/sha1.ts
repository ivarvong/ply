// Streaming SHA-1. Needed because crypto.subtle.digest is whole-buffer only,
// and pack trailers / object ids must be computed over data we never hold at once.

import { HEXV, td, te } from './bytes.js';
import { atOr, field } from './absent.js';
import { flatMapOption } from './result.js';
import { digestOid } from './oid.js';
import type { Oid } from './oid.js';
// toOid's and hex()'s result, for a reader of digests that needs no other part of oid.ts
export type { Oid };

// Workers' crypto.DigestStream: a WritableStream whose `digest` is a promise of the ArrayBuffer. Not in lib.dom, and
// not on node or in browsers, so it is read as a field of the global (None there), never declared on Crypto.
type DigestStream = new (algorithm: string) => WritableStream<Uint8Array> & { readonly digest: Promise<ArrayBuffer> };
const isDigestStream = (ctor: unknown): ctor is DigestStream => typeof ctor === 'function';

// The digits go into one buffer, decoded once: a flat string. Appending 20 two-character pieces built a rope (a V8
// ConsString, ~15 cells): ~480 B per oid instead of ~57, and a listTree of 200 000 entries keeps one per entry, which
// was 110 MiB retained and an OOM at a 128 MiB heap (#140).
const DIGITS = te.encode('0123456789abcdef');
export function toHex(bytes: Uint8Array): string {
  const out = new Uint8Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- i < bytes.length, and a nibble indexes DIGITS (16 entries); `as`, not the `!` src/ forbids
    const b = bytes[i] as number, hi = DIGITS[b >> 4] as number, lo = DIGITS[b & 15] as number;
    out[2 * i] = hi;
    out[2 * i + 1] = lo;
  }
  return td.decode(out);
}
// OID_BYTES bytes in hand (a tree entry's id, a REF_DELTA base) as the Oid they spell: two lowercase digits per byte.
// The caller holds exactly OID_BYTES (a take or a view the frame check placed).
export const toOid = (bytes: Uint8Array): Oid => digestOid(toHex(bytes));
// Table-driven (bytes.ts HEXV): 4.8× faster than parseInt per byte (PR body). A pair that is not two hex digits keeps
// parseInt's reading, so any string maps to the bytes it always did; fromHex has never validated (callers check oids).
export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- a code unit indexes the byte table; one past it reads -1
    const hi = atOr(HEXV, hex.charCodeAt(2 * i), -1);
    // oxlint-disable-next-line unicorn/prefer-code-point -- see above
    const lo = atOr(HEXV, hex.charCodeAt(2 * i + 1), -1);
    out[i] = (hi | lo) < 0 ? Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16) : (hi << 4) | lo;
  }
  return out;
}

// The state is five int32 fields and the schedule a 16-word Int32Array ring (#214): a Uint32Array read of a word at or
// above 2^31 is not a small integer to V8, so every round boxed a number (the profile's SHA-1 heap share), and an
// 80-word schedule was 64 more stores and loads per block. Same digest (test/sha1.test.js holds it to node:crypto).
export class Sha1 {
  // H0..H4 as int32: 0xefcdab89, 0x98badcfe and 0xc3d2e1f0 less 2^32
  private h0 = 0x67_45_23_01;
  private h1 = -0x10_32_54_77;
  private h2 = -0x67_45_23_02;
  private h3 = 0x10_32_54_76;
  private h4 = -0x3c_2d_1e_10;
  private readonly buf = new Uint8Array(64);
  private bufLen = 0;
  private len = 0;
  private readonly w = new Int32Array(16);

  // Bytes only: a string has no bytes until a caller encodes it (bytes.ts encodeBytes, a Result).
  public update(bytes: Uint8Array): this {
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

  // Every index below is in range (p holds 64 bytes at o, w is 16 words and every index is masked to 15), which
  // noUncheckedIndexedAccess cannot see; `as number` says so at no runtime cost (a fallback per read is bundle bytes and
  // a branch in the hot loop). `| 0` is the 32-bit wrap SHA-1 adds modulo, not a truncation.
  /* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style, unicorn/prefer-math-trunc -- in-range indexed reads and the 32-bit wrap, see above (`as number`, not the `!` src/ forbids) */
  private block(p: Uint8Array, o: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      w[i] = ((p[o + 4 * i] as number) << 24) | ((p[o + 4 * i + 1] as number) << 16) | ((p[o + 4 * i + 2] as number) << 8) | (p[o + 4 * i + 3] as number);
    }
    let a = this.h0;
    let b = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;
    // One loop with a branch per round; the schedule word for round i >= 16 is computed in place in the ring (w[i & 15]
    // held w[i - 16])
    for (let i = 0; i < 80; i++) {
      let x: number;
      if (i < 16) x = w[i] as number;
      else {
        const y = (w[(i - 3) & 15] as number) ^ (w[(i - 8) & 15] as number) ^ (w[(i - 14) & 15] as number) ^ (w[i & 15] as number);
        x = (y << 1) | (y >>> 31);
        w[i & 15] = x;
      }
      let f: number;
      let k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a_82_79_99; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6e_d9_eb_a1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f_1b_bc_dc | 0; }
      else { f = b ^ c ^ d; k = 0xca_62_c1_d6 | 0; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + x) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    this.h0 = (this.h0 + a) | 0; this.h1 = (this.h1 + b) | 0; this.h2 = (this.h2 + c) | 0; this.h3 = (this.h3 + d) | 0; this.h4 = (this.h4 + e) | 0;
  }
  /* oxlint-enable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style, unicorn/prefer-math-trunc */

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
    // setInt32 writes the same four bytes setUint32 wrote for the unsigned word
    odv.setInt32(0, this.h0); odv.setInt32(4, this.h1); odv.setInt32(8, this.h2); odv.setInt32(12, this.h3); odv.setInt32(16, this.h4);
    return out;
  }

  // A digest is OID_BYTES bytes: its hex is an Oid (an object id, or a pack trailer, which is the same shape).
  public hex(): Oid { return digestOid(toHex(this.digest())); }
}


export type StreamingSha1 =
  | { readonly kind: 'digeststream'; readonly update: (b: Uint8Array) => Promise<void>; readonly hex: () => Promise<Oid> }
  | { readonly kind: 'js'; readonly update: (b: Uint8Array) => void; readonly hex: () => Promise<Oid> };

// Streaming hasher with a native fast path: Workers expose crypto.DigestStream (a WritableStream that digests
// incrementally at native speed); node and browsers do not, so the pure-JS Sha1 above is the fallback. Same interface,
// async because the native one is. SHA-1 is ~80% of the streamed-edit CPU (test/calibrate.mjs), so this is the lever.
export function streamingSha1(): StreamingSha1 {
  const native = flatMapOption(field(globalThis, 'crypto'), c => field(c, 'DigestStream'));
  if (native.tag === 'some' && isDigestStream(native.value)) {
    const ds = new native.value('SHA-1'); // it IS a WritableStream; `digest` is a promise of the ArrayBuffer
    const w = ds.getWriter();
    // update hands back the writer's own promise (no extra tick per chunk)
    // oxlint-disable-next-line typescript/promise-function-async -- see above
    return { kind: 'digeststream', update: b => w.write(b), hex: async () => { await w.close(); return digestOid(toHex(new Uint8Array(await ds.digest))); } };
  }
  const h = new Sha1();
  // async to match the native hasher's interface
  // oxlint-disable-next-line eslint/require-await, typescript/require-await -- see above
  return { kind: 'js', update: b => { h.update(b); }, hex: async () => h.hex() };
}
