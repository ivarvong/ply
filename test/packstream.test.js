// The pull codecs (issue #172) against the buffered ones on the same bytes: inflatePull against inflate(), the pack
// scan against parsePack, for every chunking (whole, one byte at a time, small and random cuts). Same output bytes,
// consumed count, stats, objects and trailer; same refusal (code and message) wherever the two refuse the same way, and
// the named differences (inflatestream.ts header) where they do not. Then pktStep's copied payload and sidebandStep.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { Rng, splitRandom } from './fuzz/prng.js';
import { concat, te } from '../src/bytes.js';
import { pkt, pktInit, pktStep } from '../src/pktline.js';
import { buildPack, encodeObjHeader, makeDelta } from '../src/pack.js';
import { parsePack } from '../src/packresolve.js';
import { inflate, huffBuild } from '../src/inflate.js';
import {
  inflateInit, inflateReset, inflateFeed, inflatePull, inflateEnd, inflateUnread, cappedBound, declaredBound, zlibWrap, rawWrap, streamInflateAttrs,
} from '../src/inflatestream.js';
import { parsePackInit, parsePackFeed, parsePackClose, parsePackPull, parsePackEnd, packScanOpts, streamPackAttrs } from '../src/packstream.js';
import { sidebandStep, v2Init } from '../src/fetch.js';
import { peakBound } from '../src/streambound.js';
import { hashObject, TYPE } from '../src/objects.js';
import { withLimits, DEFAULT_LIMITS, LIMIT_OBJECT_OVERHEAD as OV } from '../src/limits.js';
import { Sha1 } from '../src/sha1.js';

import { buildPacks } from './space/pack-fixtures.js';
import { PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, PKT_MAX_SIZE, INFLATE_WINDOW, INFLATE_CHUNK, zlibBound } from '../src/format.js';

const N = parseInt(process.env.PROP_N ?? '200', 10);
const SEED = parseInt(process.env.SEED ?? '1', 10);
const forAll = (name, fn, n = N) => test(name, async () => { for (let i = 0; i < n; i++) { const rng = new Rng(SEED * 1000003 + i); try { await fn(rng, i); } catch (e) { e.message = `[case ${i} seed ${SEED}] ${e.message}`; throw e; } } });

const must = r => { if (r.ok) return r.value; throw Object.assign(new Error(r.error.message), { code: r.error.code }); };
const refusal = r => (r.ok ? 'ok' : `${r.error.code}: ${r.error.message}`);
// inflate()'s options as the pull's: a declared size or a cap, a zlib member or raw deflate.
const streamOpts = (o = {}) => ({
  bound: o.expectedSize !== undefined ? declaredBound(o.expectedSize, o.maxOutput ?? DEFAULT_LIMITS.maxObjectSize) : cappedBound(o.maxOutput ?? DEFAULT_LIMITS.maxObjectSize),
  wrap: o.raw ? rawWrap() : zlibWrap(o.verifyAdler !== false),
});

// Pull a member fed in `pieces`, closing the input after the last: { ok, value: { out, consumed, stats } } or the Err.
function pullMember(pieces, opts) {
  const opened = inflateInit(opts);
  if (!opened.ok) return opened;
  const st = opened.value;
  const parts = [];
  let next = 0;
  for (;;) {
    const r = next < pieces.length ? inflatePull(st) : inflateEnd(st);
    if (!r.ok) return r;
    const p = r.value;
    if (p.kind === 'chunk') { assert.ok(p.bytes.length > 0 && p.bytes.length <= INFLATE_CHUNK, `chunk of ${p.bytes.length}`); parts.push(p.bytes); continue; }
    if (p.kind === 'end') return { ok: true, value: { out: concat(parts), consumed: p.consumed, stats: p.stats, st } };
    inflateFeed(st, pieces[next]);
    next += 1;
  }
}
const cuts = (buf, rng) => [
  [buf],
  Array.from({ length: buf.length }, (_, i) => buf.subarray(i, i + 1)),
  Array.from({ length: Math.ceil(buf.length / 3) }, (_, i) => buf.subarray(i * 3, i * 3 + 3)),
  splitRandom(rng, buf, { maxChunks: 40 }),
];
// The pull and inflate() on the same bytes, in every chunking: the same answer.
function same(buf, o = {}, rng = new Rng(7)) {
  const want = inflate(buf, 0, o);
  for (const pieces of cuts(buf, rng)) {
    const got = pullMember(pieces, streamOpts(o));
    assert.equal(refusal(got), refusal(want), `${pieces.length} pieces`);
    if (!want.ok) continue;
    assert.deepEqual(got.value.out, new Uint8Array(want.value.out), `${pieces.length} pieces: output`);
    assert.equal(got.value.consumed, want.value.consumed, `${pieces.length} pieces: consumed`);
    assert.deepEqual(got.value.stats, want.value.stats, `${pieces.length} pieces: stats`);
  }
  return want;
}
// The pull alone, in every chunking: the same answer each time.
function pulled(buf, opts, rng = new Rng(9)) {
  const answers = cuts(buf, rng).map(pieces => pullMember(pieces, opts));
  for (const a of answers) assert.equal(refusal(a), refusal(answers[0]));
  return answers[0];
}

forAll('inflate pull == inflate(): bytes, consumed and stats for every level, strategy, window and chunking, junk after', rng => {
  const n = rng.pick([0, 1, 2, 100, 3000, 40000, 70000]);
  const kind = rng.int(0, 2);
  const d = kind === 0 ? rng.bytes(n) : kind === 1 ? new Uint8Array(n).fill(rng.int(0, 255)) : Uint8Array.from({ length: n }, (_, j) => (j * 7 + (j >> 5)) & 0x3f);
  const z = new Uint8Array(zlib.deflateSync(d, { level: rng.int(0, 9), strategy: rng.int(0, 4), windowBits: rng.int(9, 15), memLevel: rng.int(1, 9) }));
  const buf = concat([z, rng.bytes(rng.int(0, 9))]);
  const r = same(buf, rng.bool() ? { expectedSize: d.length } : {}, rng);
  assert.deepEqual(new Uint8Array(r.value.out), d);
  assert.equal(r.value.consumed, z.length);
}, Math.min(60, N));

forAll('inflate pull == inflate(): raw deflate, a cut member, a flipped bit', rng => {
  const d = rng.bytes(rng.int(0, 3000));
  same(concat([new Uint8Array(zlib.deflateRawSync(d, { level: rng.int(0, 9) })), rng.bytes(3)]), { raw: true }, rng);
  const z = new Uint8Array(zlib.deflateSync(d, { level: rng.int(0, 9) }));
  // a member cut anywhere past its header: both refuse, with the same words (inside the header the pull counts from
  // the bytes it was fed and inflate() from its `pos`: both 0 here, so even that matches)
  const cut = z.subarray(0, rng.int(0, z.length - 1));
  assert.equal(same(cut, {}, rng).ok, false);
  const flipped = z.slice();
  flipped[rng.int(2, z.length - 1)] ^= 1 << rng.int(0, 7);
  same(flipped, rng.bool() ? { expectedSize: d.length } : { verifyAdler: rng.bool() }, rng);
}, Math.min(60, N));

test('inflate pull == inflate() on every hand-built member the buffered tests refuse or accept', () => {
  const stored = (bytes, final) => {
    const out = new Uint8Array(1 + 4 + bytes.length);
    out[0] = final ? 1 : 0;
    out[1] = bytes.length & 255; out[2] = bytes.length >> 8; out[3] = ~out[1] & 255; out[4] = ~out[2] & 255;
    out.set(bytes, 5);
    return out;
  };
  const two = same(concat([stored(Uint8Array.of(1, 2), false), stored(Uint8Array.of(3), true)]), { raw: true });
  assert.deepEqual([...two.value.out], [1, 2, 3]);
  same(Uint8Array.of(1), { raw: true });
  const badLen = stored(Uint8Array.of(1), true); badLen[3] ^= 1;
  assert.equal(refusal(same(badLen, { raw: true })), 'pack_corrupt: inflate: stored length check failed');
  assert.equal(refusal(same(Uint8Array.of(7), { raw: true })), 'pack_corrupt: inflate: invalid block type');
  assert.equal(refusal(same(stored(Uint8Array.of(1, 2, 3), true).subarray(0, 6), { raw: true })), 'pack_corrupt: inflate: truncated stored block');
  const hello = te.encode('hello hello hello hello');
  const helloZ = new Uint8Array(zlib.deflateSync(hello));
  same(helloZ);
  same(new Uint8Array(zlib.deflateSync(hello, { level: 0 })));
  assert.equal(refusal(same(helloZ, { expectedSize: 1 })), 'pack_corrupt: inflate: output exceeds expected 1');
  assert.equal(refusal(same(helloZ, { expectedSize: hello.length + 10, maxOutput: 4 })), `limit_exceeded: inflate: expected size ${hello.length + 10} exceeds limit 4`);
  assert.equal(refusal(same(new Uint8Array(zlib.deflateSync(Buffer.from('a'.repeat(1000)))), { maxOutput: 100 })), 'limit_exceeded: inflate: output exceeds limit 100');
  assert.equal(refusal(same(Uint8Array.of(0x01, 0x00))), 'pack_corrupt: zlib: unsupported method 1');
  assert.equal(refusal(same(Uint8Array.of(0x78, 0x00))), 'pack_corrupt: zlib: bad header check');
  assert.equal(refusal(same(Uint8Array.of(0x78, 0x20))), 'pack_corrupt: zlib: preset dictionary not supported');
  assert.equal(refusal(same(Uint8Array.of(0x78))), 'pack_corrupt: short read: need 2 bytes at 0, have 1');
  assert.equal(refusal(same(helloZ.subarray(0, 8))), 'pack_corrupt: inflate: unexpected end of input');
  const mismatch = helloZ.slice(); mismatch[mismatch.length - 1] ^= 1;
  assert.equal(refusal(same(mismatch)), 'pack_corrupt: inflate: adler32 mismatch');
  assert.equal(same(mismatch, { verifyAdler: false }).value.out.length, hello.length);
  same(new Uint8Array(zlib.deflateRawSync(hello)).subarray(0, 1), { raw: true });
  assert.equal(refusal(same(helloZ, { expectedSize: hello.length + 10 })), `pack_corrupt: inflate: size ${hello.length} != expected ${hello.length + 10}`);
  assert.equal(refusal(same(concat([Uint8Array.of(0x78, 0x9c), Uint8Array.of(1, 0, 0, 255, 255)]))), 'pack_corrupt: inflate: truncated adler32');
  assert.equal(same(Uint8Array.of(1, 0, 0, 255, 255), { raw: true }).value.out.length, 0);

  const litTab = huffCodes(huffBuild(Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8))));
  const distTab = huffCodes(huffBuild(Array.from({ length: 30 }, () => 5)));
  const fixed = (...ops) => {
    const bits = [];
    const put = (v, n) => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); };
    const putCode = rec => { for (let i = rec.len - 1; i >= 0; i--) bits.push((rec.code >> i) & 1); };
    put(1, 1); put(1, 2);
    for (const op of ops) {
      if (op.lit !== undefined) putCode(litTab.get(op.lit));
      else if (op.len) { putCode(litTab.get(op.sym)); if (op.extra) put(op.extra, op.extraBits); putCode(op.distCode ?? distTab.get(op.dist)); if (op.distExtra !== undefined) put(op.distExtra, op.distExtraBits); }
      else putCode(litTab.get(256));
    }
    return packBits(bits);
  };
  assert.equal(refusal(same(fixed({ lit: 97 }), { raw: true })), 'pack_corrupt: inflate: unexpected end of input');
  assert.equal(refusal(same(fixed({ sym: 286, len: true, dist: 0 }), { raw: true, maxOutput: 64 })), 'pack_corrupt: inflate: bad length symbol');
  assert.equal(refusal(same(fixed({ sym: 257, len: true, dist: 0 }), { raw: true, maxOutput: 64 })), 'pack_corrupt: inflate: distance too far back');
  // distance codes 30 and 31 have a 5-bit fixed code and no meaning: no code of the table matches
  assert.equal(refusal(same(fixed({ lit: 97 }, { sym: 257, len: true, distCode: { len: 5, code: 30 } }, { lit: 0 }, { lit: 0 }), { raw: true })), 'pack_corrupt: inflate: invalid huffman code');
  assert.deepEqual([...same(fixed({ lit: 97 }, { sym: 257, len: true, dist: 0 }, {}), { raw: true }).value.out], [97, 97, 97, 97]);
  assert.equal(same(fixed(...[...'abcdef'].map(ch => ({ lit: ch.charCodeAt(0) })), { sym: 257, len: true, dist: 4, distExtra: 1, distExtraBits: 1 }, { sym: 257, len: true, dist: 0 }, {}), { raw: true }).value.stats.maxDist, 6);
  assert.equal(same(fixed({ lit: 97 }, { sym: 284, len: true, extra: 29, extraBits: 5, dist: 0 }, {}), { raw: true, maxOutput: 257 }).value.out.length, 257);
  assert.equal(refusal(same(fixed({ lit: 97 }, { sym: 284, len: true, extra: 29, extraBits: 5, dist: 0 }, {}), { raw: true, maxOutput: 256 })), 'limit_exceeded: inflate: output exceeds limit 256');
  assert.equal(refusal(same(fixed({ lit: 97 }, { lit: 98 }, {}), { raw: true, expectedSize: 1 })), 'pack_corrupt: inflate: output exceeds expected 1');
  same(fixed({ lit: 97 }, { sym: 284, len: true, extra: 27, extraBits: 5, dist: 0 }, { sym: 285, len: true, dist: 0 }, {}), { raw: true });
  const big = new Uint8Array(305);
  big[0] = 1; big[1] = 300 & 255; big[2] = 300 >> 8; const nlen = (~300) & 0xffff; big[3] = nlen & 255; big[4] = nlen >> 8; big.fill(7, 5);
  assert.equal(refusal(same(big, { raw: true, maxOutput: 100 })), 'limit_exceeded: inflate: output exceeds limit 100');
  assert.equal(refusal(same(big, { raw: true, expectedSize: 100 })), 'pack_corrupt: inflate: output exceeds expected 100');

  const dyn = (hlit, hdist) => { const bits = []; const put = (v, n) => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); }; put(1, 1); put(2, 2); put(hlit, 5); put(hdist, 5); put(0, 4); return packBits(bits); };
  assert.equal(refusal(same(dyn(30, 0), { raw: true })), 'pack_corrupt: inflate: bad dynamic counts');
  assert.equal(refusal(same(dyn(0, 30), { raw: true })), 'pack_corrupt: inflate: bad dynamic counts');
  assert.equal(refusal(same(dyn(0, 0).subarray(0, 1), { raw: true })), 'pack_corrupt: inflate: unexpected end of input');
  const repeat = extras => {
    const bits = []; const put = (v, n) => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); };
    put(1, 1); put(2, 2); put(0, 5); put(0, 5); put(0, 4);
    for (const n of extras.head) put(n, 3);
    for (const [v, n] of extras.body) put(v, n);
    return packBits(bits);
  };
  assert.equal(refusal(same(repeat({ head: [1, 0, 0, 0], body: [[0, 1]] }), { raw: true })), 'pack_corrupt: inflate: repeat with no previous');
  assert.equal(refusal(same(repeat({ head: [0, 0, 1, 0], body: [[0, 1], [127, 7], [0, 1], [127, 7]] }), { raw: true })), 'pack_corrupt: inflate: repeat overflow');
  assert.equal(refusal(same(repeat({ head: [0, 0, 1, 0], body: [[0, 1], [127, 7], [0, 1], [120 - 11, 7]] }), { raw: true })), 'pack_corrupt: inflate: no end-of-block code');
  // code-length codes for 16 (repeat previous, 2 bits) and 17 (zeros, 3 bits) as well as 18 and a length of 1
  assert.equal(refusal(same(repeat({ head: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2], body: [[0, 2], [3, 2], [1, 2], [7, 3], [0, 2]] }), { raw: true })), refusal(inflate(repeat({ head: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2], body: [[0, 2], [3, 2], [1, 2], [7, 3], [0, 2]] }), 0, { raw: true })));
  const hole = [];
  const putHole = (v, n) => { for (let i = 0; i < n; i++) hole.push((v >> i) & 1); };
  putHole(1, 1); putHole(2, 2); putHole(0, 5); putHole(0, 5); putHole(6, 4);
  for (const n of [0, 0, 0, 1, 1, 0, 0, 0, 0, 0]) putHole(n, 3);
  for (let i = 0; i < 256; i++) putHole(0, 1);
  putHole(1, 1); putHole(0, 1);
  for (let i = 0; i < 15; i++) putHole(1, 1);
  assert.equal(refusal(same(packBits(hole), { raw: true, maxOutput: 32 })), 'pack_corrupt: inflate: invalid huffman code');
  // a dynamic block node:zlib writes for varied text, two dynamic blocks in a row (the code lengths start over)
  let varied = '';
  for (let i = 0; i < 40000; i++) varied += `word${(i * 7919) % 1500} `;
  const multi = same(new Uint8Array(zlib.deflateSync(Buffer.from(varied), { memLevel: 1 })));
  assert.ok(multi.value.stats.dynamic > 1, `${multi.value.stats.dynamic} dynamic blocks`);
});

test('inflate pull: the refusals inflate() does not make, and the input bound', () => {
  const d = crypto.randomBytes(5000);
  const z = new Uint8Array(zlib.deflateSync(Buffer.concat([d, d])));
  // CINFO 8 is no zlib window (git and zlib refuse it); inflate() checks only the header sum
  const cmf8 = z.slice(); cmf8[0] = 0x88; cmf8[1] = 31 - ((0x88 * 256) % 31);
  assert.equal(refusal(pulled(cmf8, streamOpts())), 'pack_corrupt: zlib: window size 8 is not a zlib window');
  // a back-reference past the window CINFO declares: here 256 bytes, the match 5000 back
  const small = z.slice(); small[0] = 0x08; small[1] = 31 - ((0x08 * 256) % 31);
  assert.equal(inflate(small).ok, true, 'inflate() takes it (it checks only that the distance is inside the output)');
  assert.equal(refusal(pulled(small, streamOpts())), 'pack_corrupt: inflate: distance too far back');
  // the same member at CINFO 7 is fine
  assert.deepEqual(pulled(z, streamOpts()).value.out, new Uint8Array(Buffer.concat([d, d])));
  // a declared size past the cap: after the zlib header (inflate()'s order), or before anything for a raw stream
  assert.equal(refusal(pulled(z, { bound: declaredBound(100, 50), wrap: zlibWrap(true) })), 'limit_exceeded: inflate: expected size 100 exceeds limit 50');
  assert.equal(refusal(pulled(Uint8Array.of(0x01, 0x00), { bound: declaredBound(100, 50), wrap: zlibWrap(true) })), 'pack_corrupt: zlib: unsupported method 1');
  assert.equal(refusal(inflateInit({ bound: declaredBound(100, 50), wrap: rawWrap() })), 'limit_exceeded: inflate: expected size 100 exceeds limit 50');
  assert.equal(refusal(inflateInit({ bound: cappedBound(Infinity), wrap: rawWrap() })), 'bad_request: limits.maxObjectSize must be a finite non-negative number');
  // empty non-final stored blocks: an endless member is refused where a block starts past zlibBound(declared) ...
  const empty = Uint8Array.of(0, 0, 0, 0xff, 0xff);
  const endless = concat([Uint8Array.of(0x78, 0x01), ...Array.from({ length: 6 }, () => empty)]);
  assert.equal(refusal(pulled(endless, streamOpts({ expectedSize: 0 }))), `pack_corrupt: inflate: zlib stream longer than its declared size allows (17 > ${zlibBound(0)} for 0 bytes)`);
  assert.equal(refusal(same(endless, { expectedSize: 0 })), `pack_corrupt: inflate: zlib stream longer than its declared size allows (17 > ${zlibBound(0)} for 0 bytes)`);
  // ... and a member whose last block ends past the bound is refused at its end
  const longEnd = concat([Uint8Array.of(0x78, 0x01), empty, empty, Uint8Array.of(1, 0, 0, 0xff, 0xff), Uint8Array.of(0, 0, 0, 1)]);
  assert.equal(refusal(same(longEnd, { expectedSize: 0 })), `pack_corrupt: inflate: zlib stream longer than its declared size allows (21 > ${zlibBound(0)} for 0 bytes)`);
  // a refusal sticks: every later pull returns it
  const st = must(inflateInit(streamOpts()));
  inflateFeed(st, Uint8Array.of(0x01, 0x00));
  assert.equal(refusal(inflatePull(st)), 'pack_corrupt: zlib: unsupported method 1');
  inflateFeed(st, z);
  assert.equal(refusal(inflatePull(st)), 'pack_corrupt: zlib: unsupported method 1');
  assert.equal(refusal(inflateEnd(st)), 'pack_corrupt: zlib: unsupported method 1');
});

test('inflate pull: chunks, need, the end, what follows the member, a reset record, and the attrs', () => {
  const d = new Uint8Array(3 * INFLATE_CHUNK + 5).map((_, i) => i * 31);
  const z = new Uint8Array(zlib.deflateSync(d, { level: 0 }));
  const st = must(inflateInit(streamOpts({ expectedSize: d.length })));
  assert.deepEqual(must(inflatePull(st)), { kind: 'need' });
  assert.equal(streamInflateAttrs(st)['git.inflate.phase'], 'header');
  inflateFeed(st, concat([z, Uint8Array.of(9, 8, 7)]));
  const sizes = [];
  let end = null;
  for (;;) {
    const p = must(inflatePull(st));
    if (p.kind === 'chunk') { sizes.push(p.bytes.length); continue; }
    end = p; break;
  }
  assert.deepEqual(sizes, [INFLATE_CHUNK, INFLATE_CHUNK, INFLATE_CHUNK, 5]);
  assert.equal(end.kind, 'end');
  assert.equal(end.consumed, z.length);
  assert.deepEqual([...inflateUnread(st)], [9, 8, 7]);
  assert.deepEqual(must(inflatePull(st)), end, 'the end again');
  assert.deepEqual(streamInflateAttrs(st), { 'git.inflate.phase': 'end', 'git.inflate.consumed': z.length, 'git.inflate.emitted': d.length, 'git.inflate.window': INFLATE_WINDOW, 'git.inflate.ended': false });
  // a chunk is a copy the caller owns: the record's buffers go on being written
  const st2 = must(inflateInit(streamOpts()));
  inflateFeed(st2, z.subarray(0, 2 + 5 + INFLATE_CHUNK + 10));
  const first = must(inflatePull(st2));
  assert.equal(first.kind, 'chunk');
  const copy = first.bytes.slice();
  inflateFeed(st2, z.subarray(2 + 5 + INFLATE_CHUNK + 10));
  for (let p = must(inflatePull(st2)); p.kind !== 'end'; p = must(inflatePull(st2))) assert.notEqual(p.kind, 'need');
  assert.deepEqual(first.bytes, copy);
  // the input ran out with output pending: the pending bytes come out first, then the request for more
  const st3 = must(inflateInit(streamOpts()));
  inflateFeed(st3, z.subarray(0, 100));
  assert.equal(must(inflatePull(st3)).bytes.length, 100 - 2 - 5);
  assert.deepEqual(must(inflatePull(st3)), { kind: 'need' });
  // a reset record inflates the next member the same, its window and stats starting over
  const other = new Uint8Array(zlib.deflateSync(te.encode('abcabcabcabc')));
  must(inflateReset(st, streamOpts({ expectedSize: 12 })));
  inflateFeed(st, other);
  const again = [];
  for (let p = must(inflateEnd(st)); p.kind !== 'end'; p = must(inflatePull(st))) again.push(p.bytes);
  assert.equal(new TextDecoder().decode(concat(again)), 'abcabcabcabc');
  assert.equal(streamInflateAttrs(st)['git.inflate.ended'], true);
  // dropping every chunk holds the window, one chunk and the fed input: nothing grows with the member
  assert.equal(peakBound({ kind: 'inflate' }), INFLATE_WINDOW + INFLATE_CHUNK + PKT_MAX_SIZE);
  assert.equal(peakBound({ kind: 'fetch-object', output: 10 }), 10 + INFLATE_WINDOW + INFLATE_CHUNK + PKT_MAX_SIZE);
  assert.equal(peakBound({ kind: 'fetch-pack', retained: 7 }), 7 + INFLATE_WINDOW + INFLATE_CHUNK + PKT_MAX_SIZE);
  assert.equal(peakBound({ kind: 'pack-scan' }), peakBound({ kind: 'blob-read' }));
  assert.equal(peakBound({ kind: 'pkt' }), 2 * PKT_MAX_SIZE);
  assert.equal(peakBound({ kind: 'sideband' }), 2 * PKT_MAX_SIZE);
});

// ---- the pack scan against parsePack ----
// Feed `pieces`, close, collect: { objects (as parsePack records them), trailer, pieces } or the Err.
function scan(pieces, opts = packScanOpts()) {
  const opened = parsePackInit(opts);
  if (!opened.ok) return opened;
  const st = opened.value;
  const objects = [];
  let cur = null;
  let trailer = null;
  let header = null;
  let next = 0;
  for (;;) {
    const r = next < pieces.length ? parsePackPull(st) : parsePackEnd(st);
    if (!r.ok) return r;
    const p = r.value;
    switch (p.kind) {
      case 'need': parsePackFeed(st, pieces[next]); next += 1; break;
      case 'header': header = p; break;
      case 'object': assert.equal(p.index, objects.length); cur = { ...p, parts: [] }; break;
      case 'chunk': assert.equal(p.index, cur.index); cur.parts.push(p.bytes); break;
      case 'object-end':
        objects.push({ offset: cur.offset, headerBytes: cur.headerBytes, type: cur.type, size: cur.size, compressed: p.compressed, data: concat(cur.parts), baseOffset: cur.base.kind === 'ofs' ? cur.base.offset : null, baseOid: cur.base.kind === 'oid' ? cur.base.oid : null, inflate: p.stats });
        cur = null;
        break;
      case 'trailer': trailer = p.trailer; break;
      case 'end': return { ok: true, value: { header, objects, trailer, st } };
    }
  }
}
const asParsed = o => ({ ...o, data: new Uint8Array(o.data) });
function sameScan(buf, parseOpts, scanOpts, rng = new Rng(5)) {
  const want = parsePack(buf, parseOpts);
  for (const pieces of cuts(buf, rng).slice(buf.length > 4000 ? 2 : 0)) {
    const got = scan(pieces, scanOpts);
    assert.equal(refusal(got), refusal(want), `${pieces.length} pieces`);
    if (!want.ok) continue;
    assert.deepEqual(got.value.objects, want.value.objects.map(asParsed), `${pieces.length} pieces: objects`);
    assert.equal(got.value.trailer, want.value.trailer);
    assert.deepEqual(got.value.header, { kind: 'header', version: want.value.stats.version, count: want.value.stats.count });
  }
  return want;
}

forAll('pack scan == parsePack: objects, trailer, and the refusal of a cut or flipped pack, for every chunking', async rng => {
  const n = rng.int(0, 6);
  const objects = [];
  for (let j = 0; j < n; j++) {
    const data = rng.bool(0.3) ? new Uint8Array(rng.int(0, 40000)).fill(rng.int(0, 255)) : rng.bytes(rng.int(0, 3000));
    const type = rng.pick([TYPE.COMMIT, TYPE.TREE, TYPE.BLOB, TYPE.TAG]);
    objects.push({ type, data });
    if (rng.bool(0.3) && data.length > 0) {
      const target = concat([data, rng.bytes(rng.int(1, 50))]);
      objects.push({ type, data: makeDelta(data, target).delta, baseOid: hashObject(['', 'commit', 'tree', 'blob', 'tag'][type], data) });
    }
  }
  const built = await buildPack(objects);
  const pack = built.pack ?? built;
  const limits = rng.bool(0.2) ? withLimits({ maxObjectSize: rng.int(0, 5000), maxInflatedTotal: rng.int(0, 60000) }) : DEFAULT_LIMITS;
  const verify = rng.bool(0.8);
  const parseOpts = { limits, verify };
  const scanOpts = packScanOpts(limits, verify);
  sameScan(pack, parseOpts, scanOpts, rng);
  sameScan(pack.subarray(0, rng.int(0, pack.length - 1)), parseOpts, scanOpts, rng);
  const flipped = pack.slice();
  flipped[rng.int(0, pack.length - 1)] ^= 1 << rng.int(0, 7);
  sameScan(flipped, parseOpts, scanOpts, rng);
  sameScan(concat([pack, rng.bytes(rng.int(1, 30))]), parseOpts, scanOpts, rng);
}, Math.min(40, N));

// git builds the packs: an oracle, not a mutant killer (MUTATION=1 skips it, as push-outcome skips its git cells)
test('pack scan == parsePack on git pack-objects output: every type, OFS and REF deltas, an OFS chain, a thin pack', { skip: process.env.MUTATION === '1' }, () => {
  const { packs, single } = buildPacks();
  const rng = new Rng(11);
  for (const p of [...Object.values(packs), ...Object.values(single)]) {
    const r = sameScan(p.bytes, {}, packScanOpts(), rng);
    assert.equal(r.ok, true);
    for (let i = 0; i < 12; i++) sameScan(p.bytes.subarray(0, rng.int(0, p.bytes.length - 1)), {}, packScanOpts(), rng);
  }
  // the scanned blob is the blob git stored: git hash-object agrees on what the chunks spell
  const got = must(scan([single.blob.bytes]));
  assert.equal(hashObject('blob', got.objects[0].data), single.blob.want);
  assert.equal(got.objects[0].baseOffset, null);
  const ofs = must(scan([packs.ofs.bytes]));
  assert.ok(ofs.objects.some(o => o.baseOffset !== null));
});

const packHead = (count, version = PACK_VERSION) => {
  const b = new Uint8Array(PACK_HEADER_BYTES);
  b.set(PACK_SIGNATURE);
  new DataView(b.buffer).setUint32(4, version);
  new DataView(b.buffer).setUint32(8, count);
  return b;
};
const sealed = body => concat([body, new Sha1().update(body).digest()]);

test('pack scan: each refusal, where parsePack makes it', () => {
  const blob = te.encode('hello pack scan');
  const z = new Uint8Array(zlib.deflateSync(blob));
  const obj = concat([encodeObjHeader(TYPE.BLOB, blob.length), z]);
  const one = sealed(concat([packHead(1), obj]));
  sameScan(one, {}, packScanOpts());
  assert.equal(refusal(sameScan(one.subarray(0, 20), {}, packScanOpts())), 'pack_corrupt: pack: bad signature');
  const badSig = one.slice(); badSig[0] = 0x51;
  assert.equal(refusal(sameScan(badSig, {}, packScanOpts())), 'pack_corrupt: pack: bad signature');
  assert.equal(refusal(sameScan(sealed(concat([packHead(1, 3), obj])), {}, packScanOpts())), 'pack_corrupt: pack: unsupported version 3');
  assert.equal(refusal(sameScan(sealed(concat([packHead(5), obj])), { limits: withLimits({ maxPackObjects: 4 }) }, packScanOpts(withLimits({ maxPackObjects: 4 })))), 'limit_exceeded: pack objects 5 exceeds limit 4');
  assert.equal(refusal(sameScan(sealed(concat([packHead(1), Uint8Array.of(0x05 << 4 | 1), z])), {}, packScanOpts())), 'pack_corrupt: pack: bad object type 5 at 12');
  // OFS_DELTA: an offset of 0, a base before the pack, a varint past 64 bits
  const ofsObj = off => concat([encodeObjHeader(TYPE.OFS_DELTA, blob.length), off, z]);
  assert.equal(refusal(sameScan(sealed(concat([packHead(1), ofsObj(Uint8Array.of(0))])), {}, packScanOpts())), 'pack_corrupt: pack: ofs delta at 12 is its own base');
  assert.equal(refusal(sameScan(sealed(concat([packHead(1), ofsObj(Uint8Array.of(5))])), {}, packScanOpts())), 'pack_corrupt: pack: ofs delta base before pack start at 12');
  sameScan(sealed(concat([packHead(1), ofsObj(new Uint8Array(12).fill(0x80))])), {}, packScanOpts());
  // REF_DELTA cut inside its base oid: there is no room for a trailer either
  const refCut = concat([packHead(1), encodeObjHeader(TYPE.REF_DELTA, 3), new Uint8Array(19)]);
  assert.equal(refusal(scan([refCut])), `pack_corrupt: pack: expected trailer at ${refCut.length - 19}, pack length ${refCut.length}`);
  assert.equal(refusal(scan(Array.from(refCut, (_, i) => refCut.subarray(i, i + 1)))), `pack_corrupt: pack: expected trailer at ${refCut.length - 19}, pack length ${refCut.length}`);
  // the caps on the declared size, before an inflated byte
  assert.equal(refusal(sameScan(one, { limits: withLimits({ maxObjectSize: blob.length - 1 }) }, packScanOpts(withLimits({ maxObjectSize: blob.length - 1 })))), `limit_exceeded: pack object size ${blob.length} exceeds limit ${blob.length - 1}`);
  const tight = withLimits({ maxInflatedTotal: blob.length + OV - 1 });
  assert.equal(refusal(sameScan(one, { limits: tight }, packScanOpts(tight))), `limit_exceeded: pack inflated bytes ${blob.length + OV} exceeds limit ${blob.length + OV - 1}`);
  const fits = withLimits({ maxInflatedTotal: blob.length + OV });
  assert.equal(sameScan(one, { limits: fits }, packScanOpts(fits)).ok, true);
  // the trailer: missing, long, wrong; with verify off a wrong one is the trailer read
  assert.equal(refusal(sameScan(one.subarray(0, one.length - 1), {}, packScanOpts())), `pack_corrupt: pack: expected trailer at ${one.length - 20}, pack length ${one.length - 1}`);
  assert.equal(refusal(sameScan(concat([one, Uint8Array.of(0)]), {}, packScanOpts())), `pack_corrupt: pack: expected trailer at ${one.length - 20}, pack length ${one.length + 1}`);
  const wrong = one.slice(); wrong[wrong.length - 1] ^= 1;
  assert.match(refusal(sameScan(wrong, {}, packScanOpts())), /^pack_corrupt: pack: trailer sha mismatch [0-9a-f]{40} != [0-9a-f]{40}$/);
  assert.equal(must(scan([wrong], packScanOpts(DEFAULT_LIMITS, false))).trailer, sameScan(wrong, { verify: false }, packScanOpts(DEFAULT_LIMITS, false)).value.trailer);
  // an inflate refusal inside an object is the pack's
  const shrunk = sealed(concat([packHead(1), encodeObjHeader(TYPE.BLOB, 1), z]));
  assert.equal(refusal(sameScan(shrunk, {}, packScanOpts())), 'pack_corrupt: inflate: output exceeds expected 1');
  // a caller's limit that bounds nothing
  for (const key of ['maxPackObjects', 'maxInflatedTotal', 'maxObjectSize']) {
    assert.equal(refusal(parsePackInit(packScanOpts(withLimits({ [key]: Infinity })))), `bad_request: limits.${key} must be a finite non-negative number`);
  }
  // an empty pack, and a refusal that sticks
  const empty = must(scan([sealed(packHead(0))]));
  assert.deepEqual([empty.objects, empty.header.count], [[], 0]);
  const st = must(parsePackInit(packScanOpts()));
  parsePackFeed(st, badSig);
  parsePackClose(st);
  assert.equal(refusal(parsePackPull(st)), 'pack_corrupt: pack: bad signature');
  assert.equal(refusal(parsePackPull(st)), 'pack_corrupt: pack: bad signature');
});

test('pack scan: events in order, the attrs, and an object read without keeping it', () => {
  const a = new Uint8Array(2 * INFLATE_CHUNK + 1).fill(3);
  const b = te.encode('second');
  const body = concat([packHead(2), encodeObjHeader(TYPE.BLOB, a.length), new Uint8Array(zlib.deflateSync(a)), encodeObjHeader(TYPE.BLOB, b.length), new Uint8Array(zlib.deflateSync(b))]);
  const pack = sealed(body);
  const st = must(parsePackInit(packScanOpts()));
  assert.deepEqual(must(parsePackPull(st)), { kind: 'need' });
  parsePackFeed(st, pack.subarray(0, 40));
  assert.deepEqual(must(parsePackPull(st)), { kind: 'header', version: 2, count: 2 });
  const kinds = [];
  let fed = 40;
  for (;;) {
    const p = must(fed < pack.length ? parsePackPull(st) : parsePackEnd(st));
    if (p.kind === 'need') { parsePackFeed(st, pack.subarray(fed, fed + 1000)); fed += 1000; continue; }
    kinds.push(p.kind === 'chunk' ? `chunk${p.index}:${p.bytes.length}` : p.kind);
    if (p.kind === 'end') break;
  }
  assert.deepEqual(kinds.filter(k => !k.startsWith('chunk')), ['object', 'object-end', 'object', 'object-end', 'trailer', 'end']);
  assert.equal(kinds.filter(k => k.startsWith('chunk0')).reduce((n, k) => n + Number(k.split(':')[1]), 0), a.length);
  assert.deepEqual(kinds.filter(k => k.startsWith('chunk1')), [`chunk1:${b.length}`]);
  assert.deepEqual(must(parsePackPull(st)), { kind: 'end' });
  assert.deepEqual(streamPackAttrs(st), { 'git.pack.phase': 'end', 'git.pack.objects': 2, 'git.pack.offset': pack.length - 20, 'git.pack.bytes': pack.length, 'git.pack.ended': true });
  // bytes fed after the objects end are counted, not kept: a long tail is the trailer refusal at close
  const tailed = must(parsePackInit(packScanOpts()));
  parsePackFeed(tailed, pack);
  for (let p = must(parsePackPull(tailed)); p.kind !== 'need'; p = must(parsePackPull(tailed))) { /* drain */ }
  parsePackFeed(tailed, new Uint8Array(5000));
  assert.equal(tailed.carry.length < 5000, true);
  assert.equal(refusal(parsePackEnd(tailed)), `pack_corrupt: pack: expected trailer at ${pack.length - 20}, pack length ${pack.length + 5000}`);
});

// ---- pkt-line and sideband ----
test('pktStep copies a data payload: the chunk can be dropped or reused', () => {
  const chunk = concat([must(pkt('hello\n')), must(pkt('world\n'))]);
  const stepped = must(pktStep(pktInit(), chunk));
  chunk.fill(0x30);
  assert.deepEqual(stepped.frames.map(f => new TextDecoder().decode(f.payload)), ['hello\n', 'world\n']);
  assert.equal(stepped.frames[0].payload.buffer.byteLength, 6, 'its own buffer, not a view of the chunk');
});

test('sidebandStep: band 1 is pack bytes, band 2 progress, band 3 the remote error; each band held to the cap', () => {
  const frame = (b, body) => ({ kind: 'data', payload: concat([Uint8Array.of(b), typeof body === 'string' ? te.encode(body) : body]) });
  let st = v2Init();
  const one = must(sidebandStep(st, frame(1, Uint8Array.of(1, 2, 3)), 10));
  assert.deepEqual(one.piece, { kind: 'pack', body: Uint8Array.of(1, 2, 3) });
  assert.deepEqual([one.state.band1, one.state.packFrames, one.state.band2], [3, 1, 0]);
  st = one.state;
  // a character cut by a frame boundary waits for the next frame
  const euro = te.encode('€');
  const half = must(sidebandStep(st, frame(2, euro.subarray(0, 2)), 10));
  assert.deepEqual(half.piece, { kind: 'progress', text: '' });
  const whole = must(sidebandStep(half.state, frame(2, euro.subarray(2)), 10));
  assert.deepEqual([whole.piece.text, whole.state.progress, whole.state.band2, whole.state.band2Frames], ['€', '€', 3, 2]);
  assert.equal(must(sidebandStep(whole.state, frame(2, 'x'.repeat(7)), 10)).state.progress, '€xxxxxxx');
  assert.equal(must(sidebandStep({ ...whole.state, progress: 'p'.repeat(600) }, frame(2, 'z'), 10)).state.progress.length, 512);
  assert.equal(refusal(sidebandStep(whole.state, frame(2, 'x'.repeat(8)), 10)), 'limit_exceeded: progress bytes 11 exceeds limit 10');
  assert.equal(refusal(sidebandStep(st, frame(1, new Uint8Array(8)), 10)), 'limit_exceeded: pack bytes 11 exceeds limit 10');
  assert.equal(must(sidebandStep(st, frame(1, new Uint8Array(7)), 10)).state.band1, 10);
  const remote = sidebandStep(st, frame(3, 'upload-pack: not our ref abc\n'), 10);
  assert.equal(refusal(remote), 'remote_error: remote: upload-pack: not our ref abc');
  assert.equal(remote.error.reason, 'not_our_ref');
  assert.equal(sidebandStep(st, frame(3, 'disk full'), 10).error.reason, undefined);
  assert.equal(refusal(sidebandStep(st, frame(4, 'x'), 10)), 'protocol: v2: bad sideband 4');
  assert.equal(refusal(sidebandStep(st, { kind: 'data', payload: new Uint8Array(0) }, 10)), 'protocol: short read: need 1 bytes at 0, have 0');
  assert.equal(refusal(sidebandStep(st, { kind: 'delim' }, 10)), 'protocol: v2: delim inside the packfile section');
});

function huffCodes(h) {
  const map = new Map();
  let code = 0, index = 0;
  for (let len = 1; len < 16; len++) {
    for (let i = 0; i < h.count[len]; i++) { map.set(h.symbol[index + i], { len, code }); code++; }
    index += h.count[len];
    code <<= 1;
  }
  return map;
}
function packBits(bits) {
  return Uint8Array.from(Array.from({ length: Math.ceil(bits.length / 8) }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((b, v, j) => b | (v << j), 0)));
}

