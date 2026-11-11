// git is the judge of what a zlib member may be: ply's inflate accepts a member if and only if stock zlib, as git links
// it, accepts it. The expected value of every case is node:zlib's answer on the same bytes and, for the hand-built
// loose objects, `git cat-file`'s: never ply's.
//
// What stock zlib does with the header's window (zlib inflate.c, HEAD state; git calls inflateInit, so wbits is 15):
//   len = BITS(4) + 8; if (len > 15 || len > state->wbits) "invalid window size"; state->dmax = 1U << len;
// and dmax is read only under `#ifdef INFLATE_STRICT` (inflate.c DIST state, inffast.c), which a stock build does not
// define. So CINFO > 7 is refused, and a smaller CINFO is not enforced: a distance is refused only when it reaches
// before the output produced so far (`state->offset > state->whave + out - left`, "invalid distance too far back").
import { test } from 'vitest';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflate } from '../src/inflate.js';

function bitWriter() {
  const bits = [];
  return {
    put(v, n) { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); },        // a field: least significant bit first
    code(c, n) { for (let i = n - 1; i >= 0; i--) bits.push((c >> i) & 1); },  // a Huffman code: most significant first
    bytes() { const out = new Uint8Array(Math.ceil(bits.length / 8)); bits.forEach((b, i) => { out[i >> 3] |= b << (i & 7); }); return out; },
  };
}
// RFC 1950 §2.2: CMF = CINFO << 4 | 8 (deflate), FLG the smallest value making CMF * 256 + FLG a multiple of 31
// (FLEVEL 0, no FDICT). CINFO 0 gives 08 1d.
const zlibHeader = cinfo => { const cmf = (cinfo << 4) | 8; return Uint8Array.from([cmf, (31 - ((cmf << 8) % 31)) % 31]); };
const adler32 = bytes => { let a = 1, b = 0; for (const x of bytes) { a = (a + x) % 65521; b = (b + a) % 65521; } const out = Buffer.alloc(4); out.writeUInt32BE(((b << 16) | a) >>> 0); return out; };
// RFC 1951 §3.2.5 distance codes (5 bits each in a fixed block): [code, base, extra bits]
const DIST = { 300: [16, 257, 7], 301: [16, 257, 7], 32768: [29, 24577, 13] };
// A member: `stored` in one non-final stored block, then a final fixed block holding one match of length 3 (symbol 257,
// 7-bit code 0000001, no extra bits) at `distance` and end-of-block (symbol 256, 0000000). It inflates to `stored`
// followed by the 3 bytes `distance` back from its end.
function member(cinfo, stored, distance) {
  const [code, base, extra] = DIST[distance];
  const len = Buffer.alloc(4); len.writeUInt16LE(stored.length, 0); len.writeUInt16LE(~stored.length & 0xffff, 2);
  const w = bitWriter();
  w.put(1, 1); w.put(1, 2);
  w.code(1, 7);
  w.code(code, 5); w.put(distance - base, extra);
  w.code(0, 7);
  const at = stored.length - distance;
  const out = at < 0 ? null : Buffer.concat([stored, stored.subarray(at, at + 3)]);
  return { out, bytes: Buffer.concat([zlibHeader(cinfo), Buffer.from([0]), len, stored, w.bytes(), adler32(out ?? stored)]) };
}
const zlibSays = bytes => { try { return { ok: true, out: zlib.inflateSync(bytes) }; } catch (e) { return { ok: false, why: e.message }; } };
// A loose object whose file is exactly `bytes`; git reads it with its own zlib. `inflated` is "blob N\0" + content.
function gitReads(bytes, inflated) {
  const dir = mkdtempSync(join(tmpdir(), 'ply-loose-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q', '--bare', dir]).status, 0);
    const oid = crypto.createHash('sha1').update(inflated).digest('hex');
    mkdirSync(join(dir, 'objects', oid.slice(0, 2)), { recursive: true });
    writeFileSync(join(dir, 'objects', oid.slice(0, 2), oid.slice(2)), bytes);
    const r = spawnSync('git', ['-C', dir, 'cat-file', 'blob', oid]);
    return { ok: r.status === 0, out: r.stdout, why: r.stderr.toString().trim() };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
// "blob 294\0" (9 bytes) + 291 content bytes = 300 stored bytes; the match adds the first 3 ("blo"): 294 content bytes
const LOOSE = Buffer.concat([Buffer.from('blob 294\0'), Buffer.from(Array.from({ length: 291 }, (_, i) => 32 + (i * 7) % 90))]);

test('a back-reference past the window CINFO declares is accepted, as zlib and git accept it', () => {
  const { bytes, out } = member(0, LOOSE, 300);
  assert.deepEqual([bytes[0], bytes[1]], [0x08, 0x1d]);
  const z = zlibSays(bytes);
  assert.equal(z.ok, true, z.why);
  assert.deepEqual(z.out, out);
  const g = gitReads(bytes, out);
  assert.equal(g.ok, true, g.why);
  assert.deepEqual(g.out, out.subarray(9));
  const got = inflate(bytes, 0, { expectedSize: out.length });
  assert.equal(got.ok, true, got.ok ? '' : `${got.error.code}: ${got.error.message}`);
  assert.deepEqual(Buffer.from(got.value.out), out);
  assert.equal(got.value.consumed, bytes.length);
});

test('every CINFO 0..7 with a distance of 300 and of 32768: ply answers what zlib answers', () => {
  const far = Buffer.from(Array.from({ length: 32768 }, (_, i) => (i * 31 + (i >> 8)) & 255));
  for (let cinfo = 0; cinfo <= 7; cinfo++) for (const [stored, distance] of [[LOOSE, 300], [far, 32768]]) {
    const { bytes, out } = member(cinfo, stored, distance);
    const z = zlibSays(bytes);
    assert.equal(z.ok, true, `CINFO ${cinfo} distance ${distance}: zlib ${z.why}`);
    const got = inflate(bytes, 0);
    assert.equal(got.ok, true, `CINFO ${cinfo} distance ${distance}: zlib accepts, ply refuses ${got.ok ? '' : got.error.message}`);
    assert.deepEqual(Buffer.from(got.value.out), z.out);
    assert.deepEqual(z.out, out);
  }
});

test('what zlib and git refuse stays refused: CINFO 8, and a distance before the first byte of output', () => {
  // CINFO 8 (88 1c): zlib "invalid window size"
  const wide = member(8, LOOSE, 300);
  assert.deepEqual([wide.bytes[0], wide.bytes[1]], [0x88, 0x1c]);
  assert.deepEqual(zlibSays(wide.bytes), { ok: false, why: 'invalid window size' });
  assert.equal(gitReads(wide.bytes, wide.out).ok, false);
  const w = inflate(wide.bytes, 0);
  assert.equal(w.ok, false);
  assert.equal(w.error.code, 'pack_corrupt');
  // distance 301 with 300 bytes of output: zlib "invalid distance too far back"
  const before = member(7, LOOSE, 301);
  assert.deepEqual(zlibSays(before.bytes), { ok: false, why: 'invalid distance too far back' });
  assert.equal(gitReads(before.bytes, LOOSE).ok, false);
  const b = inflate(before.bytes, 0);
  assert.equal(b.ok, false);
  assert.equal(`${b.error.code}: ${b.error.message}`, 'pack_corrupt: inflate: distance too far back');
});
