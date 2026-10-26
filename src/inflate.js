// zlib (RFC 1950) + deflate (RFC 1951) inflate that reports bytes consumed.
// Pure at the boundary: inflate(buf, pos, opts) -> { out, consumed, stats }.
// Pack objects are concatenated zlib streams with no length prefix; `consumed`
// is what positions the pack parser at the next object header.

import { fail } from './errors.js';
import { take } from './bytes.js';
import {
  ZLIB_HEADER_BYTES, ZLIB_CM_DEFLATE, ZLIB_CM_MASK, ZLIB_FDICT, ZLIB_HEADER_MOD, ADLER_BYTES, ADLER_MOD,
  DEFLATE_BTYPE_BITS, DEFLATE_STORED, DEFLATE_FIXED, DEFLATE_DYNAMIC, DEFLATE_STORED_HEADER_BYTES, DEFLATE_STORED_LEN_MASK,
  DEFLATE_BIT_TABLE, DEFLATE_LITERALS, DEFLATE_EOB, DEFLATE_LENGTH_CODES,
  DEFLATE_HLIT_BASE, DEFLATE_HLIT_BITS, DEFLATE_HDIST_BASE, DEFLATE_HDIST_BITS, DEFLATE_HCLEN_BASE, DEFLATE_HCLEN_BITS,
  DEFLATE_HLIT_MAX, DEFLATE_HDIST_MAX, DEFLATE_CODELEN_CODES, DEFLATE_CODELEN_BITS,
  DEFLATE_REPEAT_PREV, DEFLATE_REPEAT_ZERO3,
  DEFLATE_REPEAT16_BASE, DEFLATE_REPEAT16_BITS, DEFLATE_REPEAT17_BASE, DEFLATE_REPEAT17_BITS,
  DEFLATE_REPEAT18_BASE, DEFLATE_REPEAT18_BITS, DEFLATE_BFINAL_BITS, BYTE_SHIFT, BE32_SHIFTS, ADLER_SHIFT,
} from './format.js';
const bad = msg => fail('pack_corrupt', msg);
/* oxlint-disable no-magic-numbers -- RFC 1951 §3.2.5 length/distance alphabets and the fixed Huffman assignment */
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Canonical Huffman table from code lengths (puff algorithm). Returns {count, symbol}.
export function huffBuild(lengths) {
  const count = new Uint16Array(DEFLATE_BIT_TABLE), symbol = new Uint16Array(lengths.length), offs = new Uint16Array(DEFLATE_BIT_TABLE);
  // Stryker disable next-line EqualityOperator: one past the end reads undefined, and count[0] is cleared on the next line
  for (let i = 0; i < lengths.length; i++) count[lengths[i]]++;
  count[0] = 0;
  // Stryker disable next-line EqualityOperator: offs is DEFLATE_BIT_TABLE long, so the extra index is ignored
  for (let l = 1; l < DEFLATE_BIT_TABLE; l++) offs[l] = offs[l - 1] + count[l - 1];
  // Stryker disable next-line EqualityOperator: lengths[lengths.length] is undefined and the if skips it
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbol[offs[lengths[s]]++] = s;
  return { count, symbol };
}

const FIXED_LIT = huffBuild(Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)));
const FIXED_DIST = huffBuild(new Array(30).fill(5));
/* oxlint-enable no-magic-numbers */

export function adler32(bytes, a = 1, b = 0) {
  for (let i = 0; i < bytes.length; i++) { a = (a + bytes[i]) % ADLER_MOD; b = (b + a) % ADLER_MOD; }
  return ((b << ADLER_SHIFT) | a) >>> 0;
}

// @decoder inflate prefix=inflate

export function inflate(buf, pos = 0, { expectedSize, verifyAdler = true, raw = false, maxOutput = Infinity } = {}) {
  const start = pos;
  const stats = { blocks: 0, stored: 0, fixed: 0, dynamic: 0, literals: 0, matches: 0, matchBytes: 0, maxDist: 0, maxLen: 0 };
  if (!raw) {
    const hdr = take(buf, pos, ZLIB_HEADER_BYTES);
    const cmf = hdr[0], flg = hdr[1];
    if ((cmf & ZLIB_CM_MASK) !== ZLIB_CM_DEFLATE) throw bad(`zlib: unsupported method ${cmf & ZLIB_CM_MASK}`);
    if (((cmf << BYTE_SHIFT) | flg) % ZLIB_HEADER_MOD !== 0) throw bad('zlib: bad header check');
    if (flg & ZLIB_FDICT) throw bad('zlib: preset dictionary not supported');
    pos += ZLIB_HEADER_BYTES;
  }
  if (expectedSize !== undefined && expectedSize > maxOutput) throw fail('limit_exceeded', `inflate: expected size ${expectedSize} exceeds limit ${maxOutput}`);
  // oxlint-disable-next-line no-magic-numbers -- output-buffer growth, not a wire-format fact
  let out = new Uint8Array(expectedSize ?? Math.min(maxOutput, Math.max(256, (buf.length - pos) * 3)));
  let o = 0;
  const ensure = n => {
    if (o + n <= out.length) return;
    if (expectedSize !== undefined) throw bad(`inflate: output exceeds expected ${expectedSize}`);
    if (o + n > maxOutput) throw fail('limit_exceeded', `inflate: output exceeds limit ${maxOutput}`);
    // oxlint-disable-next-line no-magic-numbers -- output-buffer growth, not a wire-format fact
    let cap = Math.min(maxOutput, out.length * 2); while (cap < o + n) cap = Math.min(maxOutput, cap * 2);
    const nb = new Uint8Array(cap); nb.set(out.subarray(0, o)); out = nb;
  };

  // bit reader (LSB-first)
  let p = pos, bitbuf = 0, bitcnt = 0;
  const bits = n => {
    let v = bitbuf;
    while (bitcnt < n) {
      if (p >= buf.length) throw bad('inflate: unexpected end of input');
      v |= buf[p++] << bitcnt; bitcnt += BYTE_SHIFT;
    }
    bitbuf = v >>> n; bitcnt -= n;
    return v & ((1 << n) - 1);
  };
  const decode = h => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < DEFLATE_BIT_TABLE; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - first < c) return h.symbol[index + code - first];
      index += c; first = (first + c) << 1; code <<= 1;
    }
    throw bad('inflate: invalid huffman code');
  };
  const codes = (lit, dist) => {
    for (;;) {
      const sym = decode(lit);
      if (sym < DEFLATE_LITERALS) { ensure(1); out[o++] = sym; stats.literals++; continue; }
      if (sym === DEFLATE_EOB) return;
      const li = sym - DEFLATE_HLIT_BASE;
      if (li >= DEFLATE_LENGTH_CODES) throw bad('inflate: bad length symbol');
      const len = LBASE[li] + bits(LEXT[li]);
      const di = decode(dist);
      if (di >= DEFLATE_HDIST_MAX) throw bad('inflate: bad distance symbol');
      const d = DBASE[di] + bits(DEXT[di]);
      if (d > o) throw bad('inflate: distance too far back');
      ensure(len);
      stats.matches++; stats.matchBytes += len;
      // Stryker disable next-line EqualityOperator: writing the same maximum when the distance is equal does not change the stat
      if (d > stats.maxDist) stats.maxDist = d;
      // Stryker disable next-line EqualityOperator: writing the same maximum when the length is equal does not change the stat
      if (len > stats.maxLen) stats.maxLen = len;
      let from = o - d;
      for (let i = 0; i < len; i++) out[o++] = out[from++]; // overlap is intentional
    }
  };

  let last;
  do {
    last = bits(DEFLATE_BFINAL_BITS);
    const type = bits(DEFLATE_BTYPE_BITS);
    stats.blocks++;
    if (type === DEFLATE_STORED) {
      stats.stored++;
      bitbuf = 0; bitcnt = 0; // discard to byte boundary
      if (p + DEFLATE_STORED_HEADER_BYTES > buf.length) throw bad('inflate: truncated stored header');
      const sh = take(buf, p, DEFLATE_STORED_HEADER_BYTES);
      const len = sh[0] | (sh[1] << BYTE_SHIFT), nlen = sh[2] | (sh[3] << BYTE_SHIFT);
      if (len !== (~nlen & DEFLATE_STORED_LEN_MASK)) throw bad('inflate: stored length check failed');
      p += DEFLATE_STORED_HEADER_BYTES;
      if (p + len > buf.length) throw bad('inflate: truncated stored block');
      ensure(len); out.set(take(buf, p, len), o); o += len; p += len;
    } else if (type === DEFLATE_FIXED) {
      stats.fixed++;
      codes(FIXED_LIT, FIXED_DIST);
    } else if (type === DEFLATE_DYNAMIC) {
      stats.dynamic++;
      const nlen = bits(DEFLATE_HLIT_BITS) + DEFLATE_HLIT_BASE, ndist = bits(DEFLATE_HDIST_BITS) + DEFLATE_HDIST_BASE, ncode = bits(DEFLATE_HCLEN_BITS) + DEFLATE_HCLEN_BASE;
      if (nlen > DEFLATE_HLIT_MAX || ndist > DEFLATE_HDIST_MAX) throw bad('inflate: bad dynamic counts');
      const lengths = new Uint8Array(DEFLATE_HLIT_MAX + DEFLATE_HDIST_MAX);
      for (let i = 0; i < ncode; i++) lengths[CLORDER[i]] = bits(DEFLATE_CODELEN_BITS);
      const lencode = huffBuild(lengths.subarray(0, DEFLATE_CODELEN_CODES));
      let i = 0;
      while (i < nlen + ndist) {
        let sym = decode(lencode);
        if (sym < DEFLATE_REPEAT_PREV) { lengths[i++] = sym; continue; }
        let rep, val = 0;
        if (sym === DEFLATE_REPEAT_PREV) { if (i === 0) throw bad('inflate: repeat with no previous'); val = lengths[i - 1]; rep = DEFLATE_REPEAT16_BASE + bits(DEFLATE_REPEAT16_BITS); }
        else if (sym === DEFLATE_REPEAT_ZERO3) rep = DEFLATE_REPEAT17_BASE + bits(DEFLATE_REPEAT17_BITS);
        else rep = DEFLATE_REPEAT18_BASE + bits(DEFLATE_REPEAT18_BITS);
        if (i + rep > nlen + ndist) throw bad('inflate: repeat overflow');
        while (rep--) lengths[i++] = val;
      }
      if (lengths[DEFLATE_EOB] === 0) throw bad('inflate: no end-of-block code');
      codes(huffBuild(Array.from(lengths.subarray(0, nlen))), huffBuild(Array.from(lengths.subarray(nlen, nlen + ndist))));
    } else throw bad('inflate: invalid block type');
  } while (!last);

  const result = out.subarray(0, o);
  if (!raw) {
    if (p + ADLER_BYTES > buf.length) throw bad('inflate: truncated adler32');
    const ad = take(buf, p, ADLER_BYTES);
    const want = ((ad[0] << BE32_SHIFTS[0]) | (ad[1] << BE32_SHIFTS[1]) | (ad[2] << BE32_SHIFTS[2]) | ad[3]) >>> 0;
    if (verifyAdler && adler32(result) !== want) throw bad('inflate: adler32 mismatch');
    p += ADLER_BYTES;
  }
  if (expectedSize !== undefined && o !== expectedSize) throw bad(`inflate: size ${o} != expected ${expectedSize}`);
  return { out: result, consumed: p - start, stats };
}
