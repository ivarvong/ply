// zlib (RFC 1950) + deflate (RFC 1951) inflate that reports bytes consumed.
// Pure at the boundary: inflate(buf, pos, opts) -> { out, consumed, stats }.
// Pack objects are concatenated zlib streams with no length prefix; `consumed`
// is what positions the pack parser at the next object header.

import { fail } from './errors.js';
const bad = msg => fail('pack_corrupt', msg);
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Canonical Huffman table from code lengths (puff algorithm). Returns {count, symbol}.
export function huffBuild(lengths) {
  const count = new Uint16Array(16), symbol = new Uint16Array(lengths.length), offs = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i++) count[lengths[i]]++;
  count[0] = 0;
  for (let l = 1; l < 16; l++) offs[l] = offs[l - 1] + count[l - 1];
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbol[offs[lengths[s]]++] = s;
  return { count, symbol };
}

const FIXED_LIT = huffBuild(Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)));
const FIXED_DIST = huffBuild(new Array(30).fill(5));

export function adler32(bytes, a = 1, b = 0) {
  for (let i = 0; i < bytes.length; i++) { a = (a + bytes[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

export function inflate(buf, pos = 0, { expectedSize, verifyAdler = true, raw = false, maxOutput = Infinity } = {}) {
  const start = pos;
  const stats = { blocks: 0, stored: 0, fixed: 0, dynamic: 0, literals: 0, matches: 0, matchBytes: 0, maxDist: 0, maxLen: 0 };
  if (!raw) {
    const cmf = buf[pos], flg = buf[pos + 1];
    if ((cmf & 0x0f) !== 8) throw bad(`zlib: unsupported method ${cmf & 0x0f}`);
    if (((cmf << 8) | flg) % 31 !== 0) throw bad('zlib: bad header check');
    if (flg & 0x20) throw bad('zlib: preset dictionary not supported');
    pos += 2;
  }
  if (expectedSize !== undefined && expectedSize > maxOutput) throw fail('limit_exceeded', `inflate: expected size ${expectedSize} exceeds limit ${maxOutput}`);
  let out = new Uint8Array(expectedSize ?? Math.min(maxOutput, Math.max(256, (buf.length - pos) * 3)));
  let o = 0;
  const ensure = n => {
    if (o + n <= out.length) return;
    if (expectedSize !== undefined) throw bad(`inflate: output exceeds expected ${expectedSize}`);
    if (o + n > maxOutput) throw fail('limit_exceeded', `inflate: output exceeds limit ${maxOutput}`);
    let cap = Math.min(maxOutput, out.length * 2); while (cap < o + n) cap = Math.min(maxOutput, cap * 2);
    const nb = new Uint8Array(cap); nb.set(out.subarray(0, o)); out = nb;
  };

  // bit reader (LSB-first)
  let p = pos, bitbuf = 0, bitcnt = 0;
  const bits = n => {
    let v = bitbuf;
    while (bitcnt < n) {
      if (p >= buf.length) throw bad('inflate: unexpected end of input');
      v |= buf[p++] << bitcnt; bitcnt += 8;
    }
    bitbuf = v >>> n; bitcnt -= n;
    return v & ((1 << n) - 1);
  };
  const decode = h => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
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
      if (sym < 256) { ensure(1); out[o++] = sym; stats.literals++; continue; }
      if (sym === 256) return;
      const li = sym - 257;
      if (li >= 29) throw bad('inflate: bad length symbol');
      const len = LBASE[li] + bits(LEXT[li]);
      const di = decode(dist);
      if (di >= 30) throw bad('inflate: bad distance symbol');
      const d = DBASE[di] + bits(DEXT[di]);
      if (d > o) throw bad('inflate: distance too far back');
      ensure(len);
      stats.matches++; stats.matchBytes += len;
      if (d > stats.maxDist) stats.maxDist = d;
      if (len > stats.maxLen) stats.maxLen = len;
      let from = o - d;
      for (let i = 0; i < len; i++) out[o++] = out[from++]; // overlap is intentional
    }
  };

  let last;
  do {
    last = bits(1);
    const type = bits(2);
    stats.blocks++;
    if (type === 0) {
      stats.stored++;
      bitbuf = 0; bitcnt = 0; // discard to byte boundary
      if (p + 4 > buf.length) throw bad('inflate: truncated stored header');
      const len = buf[p] | (buf[p + 1] << 8), nlen = buf[p + 2] | (buf[p + 3] << 8);
      if (len !== (~nlen & 0xffff)) throw bad('inflate: stored length check failed');
      p += 4;
      if (p + len > buf.length) throw bad('inflate: truncated stored block');
      ensure(len); out.set(buf.subarray(p, p + len), o); o += len; p += len;
    } else if (type === 1) {
      stats.fixed++;
      codes(FIXED_LIT, FIXED_DIST);
    } else if (type === 2) {
      stats.dynamic++;
      const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
      if (nlen > 286 || ndist > 30) throw bad('inflate: bad dynamic counts');
      const lengths = new Uint8Array(320);
      for (let i = 0; i < ncode; i++) lengths[CLORDER[i]] = bits(3);
      const lencode = huffBuild(lengths.subarray(0, 19));
      let i = 0;
      while (i < nlen + ndist) {
        let sym = decode(lencode);
        if (sym < 16) { lengths[i++] = sym; continue; }
        let rep, val = 0;
        if (sym === 16) { if (i === 0) throw bad('inflate: repeat with no previous'); val = lengths[i - 1]; rep = 3 + bits(2); }
        else if (sym === 17) rep = 3 + bits(3);
        else rep = 11 + bits(7);
        if (i + rep > nlen + ndist) throw bad('inflate: repeat overflow');
        while (rep--) lengths[i++] = val;
      }
      if (lengths[256] === 0) throw bad('inflate: no end-of-block code');
      codes(huffBuild(Array.from(lengths.subarray(0, nlen))), huffBuild(Array.from(lengths.subarray(nlen, nlen + ndist))));
    } else throw bad('inflate: invalid block type');
  } while (!last);

  const result = out.subarray(0, o);
  if (!raw) {
    if (p + 4 > buf.length) throw bad('inflate: truncated adler32');
    const want = ((buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]) >>> 0;
    if (verifyAdler && adler32(result) !== want) throw bad('inflate: adler32 mismatch');
    p += 4;
  }
  if (expectedSize !== undefined && o !== expectedSize) throw bad(`inflate: size ${o} != expected ${expectedSize}`);
  return { out: result, consumed: p - start, stats };
}
