// The pull codecs (issue #172) against the buffered ones on the same bytes: inflatePull and inflate() (a collector over
// the pull) against the decoder ply had before (test/oracle/inflate-ref.ts, an independent oracle), the pack scan
// against parsePack, for every chunking (whole, one byte at a time, small and random cuts). Same output bytes,
// consumed count, stats, objects and trailer; same refusal (code and message) wherever the two refuse the same way, and
// the named differences (inflatestream.ts header) where they do not. Then pktStep's copied payload and sidebandStep.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { Rng, splitRandom } from './fuzz/prng.js';
import { concat, te } from '../src/bytes.js';
import { pkt, pktInit, pktStep } from '../src/pktline.js';
import { buildPack, encodeObjHeader, encodeOfsDistance, makeDelta, spliceDelta, encodeDeltaOps } from '../src/pack.js';
import { parsePack } from '../src/packresolve.js';
import { inflate, huffBuild, adler32, DEFLATE_TABLES, FIXED_LIT, FIXED_DIST } from '../src/inflate.js';
import { inflateRef } from './oracle/inflate-ref.js';
import { parsePackRef } from './oracle/pack-ref.js';
import {
  inflateInit, inflateReset, inflateFeed, inflatePull, inflateEnd, inflateUnread, cappedBound, declaredBound, zlibWrap, rawWrap, streamInflateAttrs, huffFast,
} from '../src/inflatestream.js';
import { parsePackInit, parsePackFeed, parsePackClose, parsePackPull, parsePackEnd, packScanOpts, streamPackAttrs, workBudget, WORK_BUDGET, RETAIN_BUDGET } from '../src/packstream.js';
import { sidebandStep, v2Init, fetchObject, spInit, spStep } from '../src/fetch.js';
import { fetchPack } from '../src/fetchpack.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { parseDelta, applyDelta, applyProgram, deltaOps, readObjHeader, packCollectOpen, packCollectFeed, packCollectEnd, resolvePack } from '../src/packresolve.js';
import { transport, v2PackResponse, frame, cat, FLUSH } from './space/wire.js';
import { peakBound } from '../src/streambound.js';
import { hashObject, TYPE } from '../src/objects.js';
import { withLimits, DEFAULT_LIMITS, LIMIT_OBJECT_OVERHEAD as OV } from '../src/limits.js';
import { createTransport as createTransportR } from '../src/http.js';
import { Sha1 } from '../src/sha1.js';

import { buildPacks } from './space/pack-fixtures.js';
import { PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, PKT_MAX_SIZE, INFLATE_WINDOW, INFLATE_CHUNK, zlibBound } from '../src/format.js';

const N = parseInt(process.env.PROP_N ?? '200', 10);
const SEED = parseInt(process.env.SEED ?? '1', 10);
const forAll = (name, fn, n = N) => test(name, async () => { for (let i = 0; i < n; i++) { const rng = new Rng(SEED * 1000003 + i); try { await fn(rng, i); } catch (e) { e.message = `[case ${i} seed ${SEED}] ${e.message}`; throw e; } } });

const must = r => { if (r.ok) return r.value; throw Object.assign(new Error(r.error.message), { code: r.error.code }); };
const refusal = r => (r.ok ? 'ok' : `${r.error.code}: ${r.error.message}`);
// createTransport under these limits: 'ok', or its refusal
const made = limits => refusal(createTransportR('https://git.example/repo.git', { limits: withLimits(limits) }));
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
// The same, feeding the next piece after every answer, a chunk too (not only after a need): the pull must leave every
// unused byte in its carry whatever it answered.
function pullEager(pieces, opts) {
  const st = must(inflateInit(opts));
  const parts = [];
  let next = 0;
  for (;;) {
    const r = next < pieces.length ? inflatePull(st) : inflateEnd(st);
    if (!r.ok) return r;
    if (r.value.kind === 'end') return { ok: true, value: { out: concat(parts), consumed: r.value.consumed, stats: r.value.stats, st } };
    if (r.value.kind === 'chunk') parts.push(r.value.bytes);
    if (next < pieces.length) { inflateFeed(st, pieces[next]); next += 1; }
  }
}
const cuts = (buf, rng) => [
  [buf],
  Array.from({ length: buf.length }, (_, i) => buf.subarray(i, i + 1)),
  Array.from({ length: Math.ceil(buf.length / 3) }, (_, i) => buf.subarray(i * 3, i * 3 + 3)),
  splitRandom(rng, buf, { maxChunks: 40 }),
];
// The pull (in every chunking) and inflate() against the oracle on the same bytes: the same answer.
// The oracle is the decoder ply had before, and it builds a table from any code lengths. zlib refuses an over-subscribed
// or incomplete set (inftrees.c), and so does the pull now: where node:zlib refuses the bytes with one of those three
// messages, ply must refuse too, and with zlib's message unless it refused earlier for a reason the oracle shares
// (a declared size, the input bound). zlib is the expected value there; the oracle everywhere else.
const CODE_SETS = ['invalid code lengths set', 'invalid literal/lengths set', 'invalid distances set'];
function zlibCodeSet(buf, o) {
  try { (o.raw ? zlib.inflateRawSync : zlib.inflateSync)(buf); } catch (e) { return CODE_SETS.includes(e.message) ? e.message : null; }
  return null;
}
function same(buf, o = {}, rng = new Rng(7)) {
  const whole = inflate(buf, 0, o);
  const set = zlibCodeSet(buf, o);
  if (set !== null) assert.equal(whole.ok, false, `zlib refuses (${set}), inflate() accepts`);
  const want = set !== null && refusal(whole) === `pack_corrupt: inflate: ${set}` ? whole : inflateRef(buf, 0, o);
  assert.equal(refusal(whole), refusal(want), 'inflate()');
  if (want.ok) {
    assert.deepEqual(new Uint8Array(whole.value.out), new Uint8Array(want.value.out), 'inflate(): output');
    assert.equal(whole.value.consumed, want.value.consumed, 'inflate(): consumed');
    assert.deepEqual(whole.value.stats, want.value.stats, 'inflate(): stats');
  }
  for (const pieces of cuts(buf, rng)) {
    for (const got of [pullMember(pieces, streamOpts(o)), pullEager(pieces, streamOpts(o))]) {
      assert.equal(refusal(got), refusal(want), `${pieces.length} pieces`);
      if (!want.ok) continue;
      assert.deepEqual(got.value.out, new Uint8Array(want.value.out), `${pieces.length} pieces: output`);
      assert.equal(got.value.consumed, want.value.consumed, `${pieces.length} pieces: consumed`);
      assert.deepEqual(got.value.stats, want.value.stats, `${pieces.length} pieces: stats`);
    }
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
  // The code-length sets are complete (zlib refuses any other: test/inflate-codesets.test.js), so each member reaches
  // the refusal it is here for. head is the lengths of the code-length symbols 16, 17, 18, 0. With 16 or 18 and 0 at one
  // bit each, the canonical codes are 0 → `0` and the other → `1`.
  assert.equal(refusal(same(repeat({ head: [1, 0, 0, 1], body: [[1, 1]] }), { raw: true })), 'pack_corrupt: inflate: repeat with no previous');
  assert.equal(refusal(same(repeat({ head: [0, 0, 1, 1], body: [[1, 1], [127, 7], [1, 1], [127, 7]] }), { raw: true })), 'pack_corrupt: inflate: repeat overflow');
  assert.equal(refusal(same(repeat({ head: [0, 0, 1, 1], body: [[1, 1], [127, 7], [1, 1], [120 - 11, 7]] }), { raw: true })), 'pack_corrupt: inflate: no end-of-block code');
  // all four at two bits: 0 → `00`, 16 → `01`, 17 → `10`, 18 → `11` (a code's first bit is sent first, so put() takes
  // it reversed). A zero, 16 repeating it 3 times, 17 for 10 zeros, 18 for 138 and 18 for 106: 258 zero lengths, the
  // whole of the 257 + 1 the header declares, and so no end-of-block code.
  assert.equal(refusal(same(repeat({ head: [2, 2, 2, 2], body: [[0, 2], [2, 2], [0, 2], [1, 2], [7, 3], [3, 2], [127, 7], [3, 2], [106 - 11, 7]] }), { raw: true })), 'pack_corrupt: inflate: no end-of-block code');
  const hole = [];
  const putHole = (v, n) => { for (let i = 0; i < n; i++) hole.push((v >> i) & 1); };
  // A hole in a code zlib permits: the literal/length set is the end-of-block code alone at one bit (inftrees.c lets a
  // single 1-bit code be incomplete; any other incomplete set is refused at the header), and the bit read is the unused
  // `1`. 18 code-length lengths in the RFC's order: symbols 0 (4th) and 1 (18th) at one bit, so 0 → `0`, 1 → `1`.
  putHole(1, 1); putHole(2, 2); putHole(0, 5); putHole(0, 5); putHole(14, 4);
  for (const n of [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]) putHole(n, 3);
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

test('inflate pull and inflate(): the zlib window (the refusals the old decoder did not make), and the input bound', () => {
  const d = crypto.randomBytes(5000);
  const z = new Uint8Array(zlib.deflateSync(Buffer.concat([d, d])));
  // CINFO 8 is no zlib window (git and zlib refuse it); the old decoder checked only the header sum. inflate() is the
  // pull, so it refuses it too (the owner's ruling on #172)
  const cmf8 = z.slice(); cmf8[0] = 0x88; cmf8[1] = 31 - ((0x88 * 256) % 31);
  assert.equal(inflateRef(cmf8).ok, true, 'the old decoder took it');
  assert.equal(refusal(pulled(cmf8, streamOpts())), 'pack_corrupt: zlib: window size 8 is not a zlib window');
  assert.equal(refusal(inflate(cmf8)), 'pack_corrupt: zlib: window size 8 is not a zlib window');
  // after the method check, before the header checksum: CINFO 7 with a bad sum is the checksum, CINFO 8 with a bad sum
  // the window, and a bad method with CINFO 8 the method
  assert.equal(refusal(inflate(Uint8Array.of(0x78, 0x00))), 'pack_corrupt: zlib: bad header check');
  assert.equal(refusal(inflate(Uint8Array.of(0x88, 0x00))), 'pack_corrupt: zlib: window size 8 is not a zlib window');
  assert.equal(refusal(inflate(Uint8Array.of(0xf8, 0x00))), 'pack_corrupt: zlib: window size 15 is not a zlib window');
  assert.equal(refusal(inflate(Uint8Array.of(0x89, 0x00))), 'pack_corrupt: zlib: unsupported method 9');
  // a back-reference past the window CINFO declares (here 256 bytes, the match 5000 back) is read: stock zlib does not
  // enforce the declared window (inflate.c reads dmax only under INFLATE_STRICT), so node:zlib and git take the member
  // and the pull and inflate() answer zlib's bytes (the owner's ruling, 2026-11-11: git is the judge of a member; this
  // case pinned a refusal before; test/inflate-zlib-git.test.js holds it to git cat-file)
  const small = z.slice(); small[0] = 0x08; small[1] = 31 - ((0x08 * 256) % 31);
  assert.equal(inflateRef(small).ok, true, 'the old decoder took it (it checked only that the distance is inside the output)');
  const smallWant = new Uint8Array(zlib.inflateSync(small));
  assert.deepEqual(smallWant, new Uint8Array(Buffer.concat([d, d])));
  assert.deepEqual(pulled(small, streamOpts()).value.out, smallWant);
  assert.deepEqual(inflate(small).value.out, smallWant);
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
  assert.equal(sizes[0], 16 * 1024, 'a pull yields at most half the 32 KiB window: 16 KiB');
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
        objects.push({ offset: cur.offset, headerBytes: cur.headerBytes, type: cur.type, size: cur.size, compressed: p.compressed, data: concat(cur.parts), base: cur.base, inflate: p.stats });
        cur = null;
        break;
      case 'trailer': trailer = p.trailer; break;
      case 'end': return { ok: true, value: { header, objects, trailer, st } };
    }
  }
}
const asParsed = o => ({ ...o, data: new Uint8Array(o.data) });
// The old parser's record (test/oracle/pack-ref.ts) as a tagged base.
const refBase = o => (o.baseOffset !== null ? { tag: 'ofs', offset: o.baseOffset } : o.baseOid !== null ? { tag: 'ref', oid: o.baseOid } : { tag: 'none' });
const fromRef = ({ baseOffset, baseOid, ...o }) => ({ ...o, data: new Uint8Array(o.data), base: refBase({ baseOffset, baseOid }) });
// The scan (in every chunking) and parsePack (a collector over the scan) against the old buffered parser: the same
// objects, trailer and header; the same refusal as parsePack, and the same code as the old parser (the zlib window
// refusals the old inflate did not make are pack_corrupt on both sides, in other words).
function sameScan(buf, parseOpts, scanOpts, rng = new Rng(5)) {
  const want = parsePack(buf, parseOpts);
  const old = parsePackRef(buf, parseOpts);
  assert.equal(want.ok ? 'ok' : want.error.code, old.ok ? 'ok' : old.error.code, `parsePack ${refusal(want)} vs the old parser ${refusal(old)}`);
  if (want.ok) {
    assert.deepEqual(want.value.objects.map(asParsed), old.value.objects.map(fromRef), 'parsePack objects vs the old parser');
    assert.deepEqual([want.value.trailer, want.value.bytes], [old.value.trailer, old.value.bytes]);
    assert.deepEqual(want.value.stats, old.value.stats);
  }
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
      objects.push({ type, data: makeDelta(data, target).delta, base: { tag: 'ref', oid: hashObject(['', 'commit', 'tree', 'blob', 'tag'][type], data) } });
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
  assert.deepEqual(got.objects[0].base, { tag: 'none' });
  const ofs = must(scan([packs.ofs.bytes]));
  assert.ok(ofs.objects.some(o => o.base.tag === 'ofs'));
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

// ---- edges: the boundaries and paths the properties above meet only by chance ----
// A deflate bit writer: fixed-Huffman blocks (literals, matches, end of block) and stored blocks, LSB first.
const LIT = huffCodes(huffBuild(Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8))));
const DIST = huffCodes(huffBuild(Array.from({ length: 30 }, () => 5)));
function deflateBits() {
  const bits = [];
  const put = (v, n) => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); };
  const code = rec => { for (let i = rec.len - 1; i >= 0; i--) bits.push((rec.code >> i) & 1); };
  const w = {
    fixed(final, ...ops) {
      put(final ? 1 : 0, 1); put(1, 2);
      for (const op of ops) {
        if (typeof op === 'number') { code(LIT.get(op)); continue; }
        const li = DEFLATE_TABLES.LBASE.findLastIndex(b => b <= op.len);
        code(LIT.get(257 + li)); put(op.len - DEFLATE_TABLES.LBASE[li], DEFLATE_TABLES.LEXT[li]);
        const di = DEFLATE_TABLES.DBASE.findLastIndex(b => b <= op.dist);
        code(DIST.get(di)); put(op.dist - DEFLATE_TABLES.DBASE[di], DEFLATE_TABLES.DEXT[di]);
      }
      code(LIT.get(256));
      return w;
    },
    stored(final, data) {
      put(final ? 1 : 0, 1); put(0, 2);
      while (bits.length % 8) bits.push(0);
      const n = data.length, nlen = (~n) & 0xffff;
      for (const b of [n & 0xff, n >> 8, nlen & 0xff, nlen >> 8, ...data]) put(b, 8);
      return w;
    },
    bytes: () => packBits(bits),
  };
  return w;
}
const zlibOf = raw => { const out = inflateRef(raw, 0, { raw: true }); const a = adler32Of(out.ok ? out.value.out : new Uint8Array(0)); return concat([Uint8Array.of(0x78, 0x01), raw, a]); };
const adler32Of = d => { let a = 1, b = 0; for (const x of d) { a = (a + x) % 65521; b = (b + a) % 65521; } const t = new Uint8Array(4); new DataView(t.buffer).setUint32(0, ((b << 16) | a) >>> 0); return t; };

test('inflate pull edges: a bit buffer already full, a stored block into a part-filled chunk, the window ring', () => {
  // 3 + 3 × 9 + 7 = 37 bits: the next block header finds exactly the 3 bits it needs and pulls no byte (a pulled byte
  // would be dropped with the stored block's alignment)
  const exact = deflateBits().fixed(false, 200, 201, 202).stored(true, te.encode('xyz')).bytes();
  assert.deepEqual([...same(exact, { raw: true }).value.out], [200, 201, 202, 120, 121, 122]);
  // a stored block that starts in a chunk a literal began, and is longer than the chunk's rest
  const big = crypto.randomBytes(40000);
  const ring = deflateBits().fixed(false, 7).stored(false, big).fixed(true, { len: 258, dist: 32768 }, { len: 3, dist: 1000 }, { len: 100, dist: 40001 - 32768 }, 9).bytes();
  const r = same(ring, { raw: true });
  assert.equal(r.value.out.length, 1 + 40000 + 258 + 3 + 100 + 1);
  assert.deepEqual(r.value.out.subarray(40001, 40001 + 258), new Uint8Array(r.value.out.subarray(40001 - 32768, 40001 - 32768 + 258)));
  assert.equal(r.value.stats.maxDist, 32768, 'a match exactly one window back is inside the window');
  // fed 1000 bytes at a time a partial chunk goes out at each need, so a stored copy runs across the window's end; a
  // later match reads the bytes written past it (7201 back from 40001 is 32800)
  const wrap = deflateBits().fixed(false, 7).stored(false, big).fixed(true, { len: 258, dist: 7201 }).bytes();
  const want = inflateRef(wrap, 0, { raw: true });
  const byK = pullMember(Array.from({ length: Math.ceil(wrap.length / 1000) }, (_, i) => wrap.subarray(i * 1000, i * 1000 + 1000)), streamOpts({ raw: true }));
  assert.deepEqual(byK.value.out, new Uint8Array(want.value.out));
  same(zlibOf(ring));
  // a dynamic block with all 30 distance codes, and binary dynamic blocks one after another (each starts its code
  // length code lengths from zero)
  const far = new Uint8Array(70000);
  far.set(crypto.randomBytes(far.length));
  let at = 33000;
  for (const d of DEFLATE_TABLES.DBASE) { far.copyWithin(at, at - d, at - d + 40); at += 1000; }
  assert.equal(same(new Uint8Array(zlib.deflateSync(far, { level: 9 }))).ok, true);
  // every byte value, skewed so Huffman codes pay: dynamic blocks whose literal lengths are nonzero everywhere
  const skewed = n => { const a = crypto.randomBytes(n), b = crypto.randomBytes(n); return a.map((x, i) => x & b[i]); };
  const mixed = concat(Array.from({ length: 400 }, (_, i) => (i % 2 ? skewed(400) : te.encode(`line ${i % 7} of the text `.repeat(4)))));
  const multi = same(new Uint8Array(zlib.deflateSync(mixed, { memLevel: 3 })));
  assert.ok(multi.value.stats.dynamic > 1, `${multi.value.stats.dynamic} dynamic blocks`);
  // where the input ran out: between blocks, in a dynamic header, its code length codes, its code lengths
  assert.equal(refusal(same(Uint8Array.of(0, 0, 0, 0xff, 0xff), { raw: true })), 'pack_corrupt: inflate: unexpected end of input');
  const dynamicZ = new Uint8Array(zlib.deflateRawSync(mixed.subarray(0, 3000)));
  const phases = new Set();
  for (let cut = 1; cut < 200; cut++) {
    const r2 = pullMember([dynamicZ.subarray(0, cut)], streamOpts({ raw: true }));
    assert.equal(refusal(r2), 'pack_corrupt: inflate: unexpected end of input');
    const st = must(inflateInit(streamOpts({ raw: true })));
    inflateFeed(st, dynamicZ.subarray(0, cut));
    while (must(inflatePull(st)).kind !== 'need') { /* to where it stops */ }
    phases.add(streamInflateAttrs(st)['git.inflate.phase']);
  }
  assert.deepEqual([...phases].sort(), ['codes', 'dyn-clen', 'dyn-header', 'dyn-lens']);
});

// puff's decode of the bits a lookahead holds (the first bit read is bit 0): [length, symbol] within `max` bits, or null.
function puffDecode(h, look, max) {
  let code = 0, first = 0, index = 0;
  for (let len = 1; len <= max; len++) {
    code |= (look >> (len - 1)) & 1;
    const c = h.count[len];
    if (code - first < c) return [len, h.symbol[index + code - first]];
    index += c; first = (first + c) << 1; code <<= 1;
  }
  return null;
}
test('the fast table: every 9-bit lookahead decodes as puff does, complete, incomplete and over-subscribed codes', () => {
  const rng = new Rng(11);
  const sets = [
    FIXED_LIT, FIXED_DIST, huffBuild([]), huffBuild([0, 0, 0]), huffBuild([1]), huffBuild([1, 1]), huffBuild([1, 1, 1]),
    huffBuild([2, 1, 3, 3]), huffBuild([10, 10, 11, 12, 15, 1]), huffBuild([9, 9, 9, 9]), huffBuild(Array.from({ length: 300 }, () => 8)),
    huffBuild(Array.from({ length: 19 }, () => 7)), huffBuild([...Array.from({ length: 30 }, () => 5), 1]),
    ...Array.from({ length: 300 }, () => huffBuild(Array.from({ length: rng.int(1, 288) }, () => (rng.bool() ? 0 : rng.int(0, 15))))),
    ...Array.from({ length: 100 }, () => huffBuild(Array.from({ length: rng.int(1, 30) }, () => rng.int(1, 4)))),
  ];
  const reused = new Uint16Array(512).fill(0xffff);
  let short = 0, long = 0;
  for (const h of sets) {
    const t = huffFast(h);
    assert.equal(t.length, 512);
    for (let v = 0; v < 512; v++) {
      const want = puffDecode(h, v, 9);
      assert.equal(t[v], want === null ? 0 : (want[0] << 9) | want[1], `lookahead ${v}`);
      if (want === null) long += 1; else short += 1;
    }
    // a table built into a buffer that held another is the same table
    assert.deepEqual(huffFast(h, reused), t);
  }
  assert.ok(short > 0 && long > 0);
});

test('inflate pull: the bytes read ahead are not consumed: a match whose bits are here, a raw stream\'s end, a chunk then a feed', () => {
  // 3 + 9 + 7 + 5 = 24 bits: a literal and a match whose distance code ends on the third byte's last bit (0 extra bits).
  // Fed those three bytes, the pull copies the match before it asks for more: one chunk of all four bytes.
  const z = deflateBits().fixed(true, 200, { len: 3, dist: 1 }).bytes();
  const st = must(inflateInit(streamOpts({ raw: true })));
  inflateFeed(st, z.subarray(0, 3));
  assert.deepEqual([...must(inflatePull(st)).bytes], [200, 200, 200, 200]);
  assert.equal(must(inflatePull(st)).kind, 'need');
  inflateFeed(st, z.subarray(3));
  assert.deepEqual(must(inflateEnd(st)), { kind: 'end', consumed: z.length, stats: must(inflate(z, 0, { raw: true })).stats });
  // a raw stream followed by other bytes, fed whole: the bytes after it are unread, though the decoder looked at them
  const raw = new Uint8Array(zlib.deflateRawSync(te.encode('raw stream, then the next thing '.repeat(20))));
  const tail = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9);
  const r = must(inflateInit(streamOpts({ raw: true })));
  inflateFeed(r, concat([raw, tail]));
  let p;
  do p = must(inflatePull(r)); while (p.kind === 'chunk');
  assert.equal(p.kind, 'end');
  assert.equal(p.consumed, raw.length);
  assert.deepEqual([...inflateUnread(r)], [...tail]);
  assert.equal(streamInflateAttrs(r)['git.inflate.consumed'], raw.length);
  // the same with no output: the end is the first answer
  const empty = must(inflateInit(streamOpts({ raw: true })));
  inflateFeed(empty, concat([deflateBits().fixed(true).bytes(), tail]));
  assert.deepEqual(must(inflatePull(empty)).consumed, 2);
  assert.deepEqual([...inflateUnread(empty)], [...tail]);
  // every cut of members whose last blocks hold a long match, a stored block or the trailer: fed in two pieces, or the
  // rest a byte at a time, with or without a feed after each chunk, the oracle's answer
  const lits = Array.from({ length: 16384 }, (_, i) => 97 + (i % 20));
  const streams = [
    zlibOf(deflateBits().fixed(true, ...lits, { len: 258, dist: 16000 }, { len: 3, dist: 9000 }).bytes()),
    zlibOf(deflateBits().fixed(false, ...lits.slice(0, 16383), { len: 4, dist: 16000 }).stored(true, te.encode('stored tail')).bytes()),
    concat([deflateBits().fixed(false, 1, 2).fixed(true, ...lits.slice(0, 16381), { len: 7, dist: 12345 }).bytes(), tail]),
    // a dynamic block of one-bit literals filling the chunk to its last byte: the bits read ahead at the chunk hold the
    // end of block, so the trailer follows bytes the chunk's pull read ahead
    new Uint8Array(zlib.deflateSync(Uint8Array.from({ length: 16384 }, (_, i) => (i % 97 === 5 ? 98 : 97)), { strategy: zlib.constants.Z_HUFFMAN_ONLY })),
  ];
  for (const [k, z2] of streams.entries()) {
    const o = k === 2 ? { raw: true } : {};
    const want = inflateRef(z2, 0, o);
    assert.equal(want.ok, true);
    for (let cut = z2.length - 40; cut < z2.length; cut++) {
      const pieces = [z2.subarray(0, cut), z2.subarray(cut)];
      const bytewise = [z2.subarray(0, cut), ...Array.from(z2.subarray(cut), b => Uint8Array.of(b))];
      for (const got of [pullMember(pieces, streamOpts(o)), pullEager(pieces, streamOpts(o)), pullEager(bytewise, streamOpts(o))]) {
        assert.equal(refusal(got), 'ok', `stream ${k} cut ${cut}`);
        assert.deepEqual(got.value.out, new Uint8Array(want.value.out), `stream ${k} cut ${cut}`);
        assert.equal(got.value.consumed, want.value.consumed, `stream ${k} cut ${cut}`);
      }
    }
  }
});

test('adler32: the sums reduced every 5552 bytes are the sums reduced every byte, from any seed', () => {
  const naive = (d, a, b) => { for (const x of d) { a = (a + x) % 65521; b = (b + a) % 65521; } return ((b << 16) | a) >>> 0; };
  const rng = new Rng(3);
  for (const n of [0, 1, 255, 5551, 5552, 5553, 11104, 11105, 40000]) {
    for (const [a, b] of [[1, 0], [65520, 65520], [0, 0], [rng.int(0, 65520), rng.int(0, 65520)]]) {
      const d = n === 40000 ? new Uint8Array(n).fill(255) : rng.bytes(n);
      assert.equal(adler32(d, a, b), naive(d, a, b), `${n} bytes from ${a}, ${b}`);
    }
  }
  // seeds past the modulus (a packed value's halves are below 2^16): reduced as the per-byte sums reduce them
  assert.equal(adler32(Uint8Array.of(0), 65535, 65535), naive(Uint8Array.of(0), 65535, 65535));
  assert.equal(adler32(new Uint8Array(0), 65535, 65535), 0xffffffff);
});

forAll('inflate pull == the oracle on random bits after a block header: dynamic code sets git never writes, every chunking', rng => {
  // a final or not, fixed or dynamic block header, then random bits: incomplete and over-subscribed code length sets,
  // codes longer than the fast table, a refusal anywhere; the pull and inflate() must give the oracle's answer
  const head = rng.int(0, 1) | (rng.pick([1, 2, 2]) << 1);
  const buf = concat([Uint8Array.of(head | (rng.int(0, 31) << 3)), rng.bytes(rng.int(0, 400))]);
  same(buf, { raw: true }, rng);
  same(buf, { raw: true, expectedSize: rng.int(0, 64) }, rng);
}, Math.min(300, N * 2));

test('inflate pull edges: the input bound at its boundary, a capped bound, limit details, no copy of a fed buffer', () => {
  // empty blocks: F a fixed block (10 bits), S a stored one (aligned, 5 bytes); the last one final, then the Adler-32
  const empties = (seq, last) => {
    const w = deflateBits();
    for (const k of seq) { if (k === 'F') w.fixed(false); else w.stored(false, new Uint8Array(0)); }
    if (last === 'F') w.fixed(true); else w.stored(true, new Uint8Array(0));
    return concat([Uint8Array.of(0x78, 0x01), w.bytes(), Uint8Array.of(0, 0, 0, 1)]);
  };
  // ends exactly at zlibBound(0): accepted
  const atBound = empties('S', 'F');
  assert.equal(atBound.length, zlibBound(0));
  assert.equal(same(atBound, { expectedSize: 0 }).ok, true);
  // a block that starts exactly at the bound may start; the member is refused when it ends past it
  const startsAt = empties('FSS', 'F');
  assert.equal(refusal(same(startsAt, { expectedSize: 0 })), `pack_corrupt: inflate: zlib stream longer than its declared size allows (${startsAt.length} > ${zlibBound(0)} for 0 bytes)`);
  // empty fixed blocks without end: refused where a block starts, the bytes read ahead not counted as consumed
  const fixedRun = empties('F'.repeat(40), 'F');
  assert.match(refusal(same(fixedRun, { maxOutput: 0 })), /^pack_corrupt: inflate: zlib stream longer than its declared size allows \(1[0-9] > /);
  // a cap stands in for a declared size
  const endless = empties('SSSSSS', 'S');
  assert.equal(refusal(same(endless, { maxOutput: 0 })), `pack_corrupt: inflate: zlib stream longer than its declared size allows (17 > ${zlibBound(0)} for 0 bytes)`);
  // the limit's details, and a declared size equal to the cap
  const over = pulled(new Uint8Array(zlib.deflateSync(new Uint8Array(100))), { bound: cappedBound(99), wrap: zlibWrap(true) });
  assert.deepEqual([over.error.what, over.error.got, over.error.max], ['inflate output', 100, 99]);
  const big = pulled(Uint8Array.of(0x78, 0x01), { bound: declaredBound(100, 99), wrap: zlibWrap(true) });
  assert.deepEqual([big.error.what, big.error.got, big.error.max], ['inflate expected size', 100, 99]);
  assert.equal(pulled(new Uint8Array(zlib.deflateSync(new Uint8Array(100))), { bound: declaredBound(100, 100), wrap: zlibWrap(true) }).ok, true);
  // a buffer fed to an exhausted record is taken as it is; one fed behind an unread tail is joined once
  const st = must(inflateInit(streamOpts()));
  const first = Uint8Array.of(0x78);
  inflateFeed(st, first);
  assert.equal(inflateUnread(st).buffer, first.buffer);
  const second = Uint8Array.of(0x01, 0x01);
  inflateFeed(st, second);
  assert.notEqual(inflateUnread(st).buffer, second.buffer);
  assert.deepEqual([...inflateUnread(st)], [0x78, 0x01, 0x01]);
  must(inflatePull(st));
  const third = Uint8Array.of(0, 0, 0xff, 0xff, 0, 0, 0, 1);
  inflateFeed(st, third);
  assert.equal(inflateUnread(st).buffer, third.buffer, 'the header and block byte were consumed: no copy');
});

test('pack scan edges: boundaries of each cap, OFS and REF deltas, refusals before the input closes, input after the end', () => {
  const base = te.encode('the base object, long enough to be a delta base. '.repeat(4));
  const target = concat([base, te.encode('and one more line')]);
  const delta = makeDelta(base, target).delta;
  const baseObj = concat([encodeObjHeader(TYPE.BLOB, base.length), new Uint8Array(zlib.deflateSync(base))]);
  const ofsObj = concat([encodeObjHeader(TYPE.OFS_DELTA, delta.length), encodeOfsDistance(baseObj.length), new Uint8Array(zlib.deflateSync(delta))]);
  const ofsPack = sealed(concat([packHead(2), baseObj, ofsObj]));
  const ofs = sameScan(ofsPack, {}, packScanOpts());
  assert.deepEqual(ofs.value.objects[1].base, { tag: 'ofs', offset: 12 }, 'a base at the first object offset is inside the pack');
  const refObj = concat([encodeObjHeader(TYPE.REF_DELTA, delta.length), Uint8Array.from(Buffer.from(hashObject('blob', base), 'hex')), new Uint8Array(zlib.deflateSync(delta))]);
  const refPack = sealed(concat([packHead(2), baseObj, refObj]));
  assert.deepEqual(sameScan(refPack, {}, packScanOpts()).value.objects[1].base, { tag: 'ref', oid: hashObject('blob', base) });
  // caps at their boundary
  const at = (limits, buf = ofsPack) => sameScan(buf, { limits: withLimits(limits) }, packScanOpts(withLimits(limits)));
  assert.equal(at({ maxPackObjects: 2 }).ok, true);
  assert.equal(at({ maxObjectSize: base.length }).ok, true);
  const both = base.length + delta.length + 2 * OV;
  assert.equal(at({ maxInflatedTotal: both }).ok, true);
  assert.equal(refusal(at({ maxInflatedTotal: both - 1 })), `limit_exceeded: pack inflated bytes ${both} exceeds limit ${both - 1}`);
  // a whole empty pack is read without waiting for the input to close
  const empty = must(parsePackInit(packScanOpts()));
  parsePackFeed(empty, sealed(packHead(0)));
  assert.equal(must(parsePackPull(empty)).kind, 'header');
  // a refusal that is not a short read does not wait for the close
  const bad = must(parsePackInit(packScanOpts()));
  parsePackFeed(bad, sealed(concat([packHead(1), encodeObjHeader(TYPE.OFS_DELTA, 3), new Uint8Array(12).fill(0x80), new Uint8Array(30)])));
  assert.equal(must(parsePackPull(bad)).kind, 'header');
  assert.equal(parsePackPull(bad).ok, false);
  // input that ends right after a REF_DELTA's base oid: the oid is read, the member is what is short
  assert.equal(refusal(scan([refPack.subarray(0, 12 + baseObj.length + encodeObjHeader(TYPE.REF_DELTA, delta.length).length + 20)])), 'pack_corrupt: short read: need 2 bytes at 0, have 0');
  // a full object's base is none
  assert.deepEqual(must(scan([ofsPack])).objects.map(o => o.base), [{ tag: 'none' }, { tag: 'ofs', offset: 12 }]);
  const firstObject = must(parsePackInit(packScanOpts()));
  parsePackFeed(firstObject, ofsPack);
  must(parsePackPull(firstObject));
  assert.deepEqual(must(parsePackPull(firstObject)).base, { tag: 'none' });
  // a REF_DELTA base oid cut by the chunk waits for the rest
  const cutRef = must(parsePackInit(packScanOpts()));
  parsePackFeed(cutRef, refPack.subarray(0, 12 + baseObj.length + 1 + 10));
  for (let p = must(parsePackPull(cutRef)); ; p = must(parsePackPull(cutRef))) if (p.kind === 'need') break;
  parsePackFeed(cutRef, refPack.subarray(12 + baseObj.length + 1 + 10));
  for (let p = must(parsePackEnd(cutRef)); p.kind !== 'end'; p = must(parsePackPull(cutRef))) { /* to the end */ }
  // a buffer fed to an exhausted scan is taken as it is; input after the end is not kept
  const st = must(parsePackInit(packScanOpts()));
  const whole = ofsPack.slice();
  parsePackFeed(st, whole);
  assert.equal(st.carry, whole);
  for (let p = must(parsePackPull(st)); p.kind !== 'need'; p = must(parsePackPull(st))) { /* to the trailer */ }
  for (let p = must(parsePackEnd(st)); p.kind !== 'end'; p = must(parsePackPull(st))) { /* the trailer */ }
  const carried = st.carry;
  parsePackFeed(st, new Uint8Array(100));
  assert.equal(st.carry, carried);
});

test('fetchObject streams the member: the blob in one buffer, trailing bytes, a held refusal, the size cap at its boundary', async () => {
  const blob = crypto.randomBytes(3 * INFLATE_CHUNK + 77);
  const oid = hashObject('blob', blob);
  const z = new Uint8Array(zlib.deflateSync(blob));
  const packOf = (member, size = blob.length) => sealed(concat([packHead(1), encodeObjHeader(TYPE.BLOB, size), member]));
  const get = async (pack, { chunk = 8192, limits = {} } = {}) => fetchObject(transport(() => ({ bytes: v2PackResponse(pack, { chunk }) }), limits), { oid, filter: '', expectType: TYPE.BLOB });
  const got = await get(packOf(z));
  assert.equal(refusal(got), 'ok');
  assert.deepEqual(got.value.data, new Uint8Array(blob));
  assert.equal((await get(packOf(z), { limits: { maxObjectSize: blob.length } })).ok, true);
  // the declared size is refused where the object header is read (readObjHeader, #156), before a body byte
  assert.equal(refusal(await get(packOf(z), { limits: { maxObjectSize: blob.length - 1 } })), `limit_exceeded: pack object size ${blob.length} exceeds limit ${blob.length - 1}`);
  // bytes after the member: in the chunk it ends in, and in later chunks
  assert.equal(refusal(await get(packOf(concat([z, Uint8Array.of(1, 2, 3)])))), 'pack_corrupt: pack: 3 trailing bytes after object');
  assert.equal(refusal(await get(packOf(concat([z, new Uint8Array(40)])), { chunk: 7 })), 'pack_corrupt: pack: 40 trailing bytes after object');
  // an inflate refusal is held until the pack's own checks have run: a bad trailer is reported first
  const badAdler = z.slice(); badAdler[badAdler.length - 1] ^= 1;
  assert.equal(refusal(await get(packOf(badAdler))), 'pack_corrupt: inflate: adler32 mismatch');
  const both = packOf(badAdler); both[both.length - 1] ^= 1;
  assert.match(refusal(await get(both)), /^pack_corrupt: pack: trailer [0-9a-f]{40} != [0-9a-f]{40}$/);
  // a member refused at its first byte, its other bytes still arriving
  const badHead = z.slice(); badHead[0] = 0x79;
  assert.equal(refusal(await get(packOf(badHead), { chunk: 100 })), 'pack_corrupt: zlib: unsupported method 9');
  // a declared size past the cap is refused before a buffer of that size exists
  const huge = sealed(concat([packHead(1), encodeObjHeader(TYPE.BLOB, 2 ** 40), z]));
  assert.equal(refusal(await get(huge)), `limit_exceeded: pack object size ${2 ** 40} exceeds limit ${DEFAULT_LIMITS.maxObjectSize}`);
  // a member cut short inside a pack whose trailer is right: the end of input finishes the member and refuses it
  assert.equal(refusal(await get(packOf(z.subarray(0, z.length - 2)))), 'pack_corrupt: inflate: truncated adler32');
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


// ---- the fetches over the scan (#172): fetchWide, fetchPack and a commit want's tag + commit, read as they arrive ----
const AUTH = 'A <a@b.c> 1 +0000';
const treeOf = (...names) => concat(names.flatMap(n => [te.encode(`100644 ${n}\0`), new Uint8Array(20).fill(n.length)]));
const commitOf = tree => te.encode(`tree ${tree}\nauthor ${AUTH}\ncommitter ${AUTH}\n\nm\n`);
const tagOf = commit => te.encode(`object ${commit}\ntype commit\ntag v1\ntagger ${AUTH}\n\nt\n`);
// A transport whose every upload-pack answer is `pack` (band-1 frames of `chunk` bytes), and the spans it exported.
function wire(pack, { chunk = 64, quirks = {}, limits = {}, response = null } = {}) {
  const exporter = arrayExporter();
  const t = transport(() => ({ bytes: response ?? v2PackResponse(pack, { chunk }) }), limits, { tracer: new Tracer({ exporter }), quirks });
  const span = name => exporter.lines.flatMap(flattenLine).find(s => s.name === name);
  return { t, span };
}

test('fetchWide: a tree want keeps the trees and drops the blobs and their deltas as their headers arrive', async () => {
  const tA = treeOf('a'), tB = treeOf('b', 'bb');
  const blob = te.encode('x'.repeat(300)), blob2 = te.encode(`${'x'.repeat(300)}y`), blob3 = te.encode(`${'x'.repeat(300)}z`);
  const { pack } = await buildPack([
    { type: TYPE.TREE, data: tA },
    { type: TYPE.BLOB, data: blob },
    { type: TYPE.BLOB, data: makeDelta(blob, blob2).delta, base: { tag: 'ofs', index: 1 } },
    // an OFS delta on a dropped delta: a blob too
    { type: TYPE.BLOB, data: makeDelta(blob2, blob3).delta, base: { tag: 'ofs', index: 2 } },
    // a REF delta on a dropped blob: unresolved, a blob it left out
    { type: TYPE.BLOB, data: makeDelta(blob, blob3).delta, base: { tag: 'ref', oid: hashObject('blob', blob) } },
    { type: TYPE.TREE, data: tB },
  ]);
  for (const quirks of [{ treeFilter: 'blob:none' }, { treeFilter: 'none' }]) {
    const { t, span } = wire(pack, { quirks });
    const got = await fetchObject(t, { oid: hashObject('tree', tA), filter: 'tree:0', expectType: TYPE.TREE });
    assert.equal(refusal(got), 'ok');
    assert.deepEqual([got.value.data, got.value.wide], [tA, true]);
    assert.deepEqual([...t.objects.keys()], [hashObject('tree', tB)], 'the other tree is harvested, no blob is');
    const a = span('git.upload-pack fetch').attrs;
    assert.deepEqual([a['git.fetch.wide.objects'], a['git.fetch.wide.extra_objects'], a['git.fetch.wide.blobs'], a['git.pack.objects'], a['git.pack.bytes']], [6, 5, 4, 6, pack.length]);
    assert.equal(a['git.fetch.wide.extra_bytes'], tB.length + blob.length + makeDelta(blob, blob2).delta.length + makeDelta(blob2, blob3).delta.length, 'the kept tree, and what was dropped at its declared size');
  }
});

test('fetchWide: a want that may be a blob keeps every object; nothing dropped, a missing base is refused', async () => {
  const blob = te.encode('b'.repeat(100));
  const tree = treeOf('t');
  const { pack } = await buildPack([{ type: TYPE.TREE, data: tree }, { type: TYPE.BLOB, data: blob }]);
  // expectType null (any object) under a filter the host does not take: the blob is the want
  const { t, span } = wire(pack, { quirks: { treeFilter: 'none' } });
  const got = await fetchObject(t, { oid: hashObject('blob', blob), filter: 'blob:limit=1m' });
  assert.equal(refusal(got), 'ok');
  assert.deepEqual([got.value.type, got.value.data], [TYPE.BLOB, blob]);
  assert.deepEqual([span('git.upload-pack fetch').attrs['git.fetch.wide.blobs'], span('git.upload-pack fetch').attrs['git.fetch.wide.objects']], [1, 2]);
  // a tree want whose pack holds no blob drops nothing: a REF base outside the pack is the resolver's refusal, as before
  const thin = await buildPack([{ type: TYPE.TREE, data: tree }, { type: TYPE.TREE, data: makeDelta(tree, treeOf('u')).delta, base: { tag: 'ref', oid: hashObject('tree', treeOf('t', 'x')) } }]);
  const missing = await fetchObject(wire(thin.pack, { quirks: { treeFilter: 'blob:none' } }).t, { oid: hashObject('tree', tree), filter: 'tree:0', expectType: TYPE.TREE });
  assert.equal(refusal(missing), `pack_corrupt: pack: ref delta base ${hashObject('tree', treeOf('t', 'x'))} not found`);
  // a want that is not in the pack counts what was dropped too
  const other = await fetchObject(wire(pack, { quirks: { treeFilter: 'none' } }).t, { oid: hashObject('tree', treeOf('zz')), filter: 'tree:0', expectType: TYPE.TREE });
  assert.equal(refusal(other), `pack_corrupt: object ${hashObject('tree', treeOf('zz'))} not in the unfiltered pack (2 objects)`);
});

test('fetchWide and fetchPack: a scan refusal is held until the response is read, so the response\'s own refusal comes first', async () => {
  const tree = treeOf('a');
  const { pack } = await buildPack([{ type: TYPE.TREE, data: tree }]);
  const bad = pack.slice(); bad[0] = 0x51;
  const cut = v2PackResponse(bad).subarray(0, v2PackResponse(bad).length - 4); // no flush: the response is the error
  for (const response of [cut, null]) {
    const { t } = wire(bad, { quirks: { treeFilter: 'blob:none' }, response });
    const got = await fetchObject(t, { oid: hashObject('tree', tree), filter: 'tree:0', expectType: TYPE.TREE });
    assert.equal(refusal(got), response === null ? 'pack_corrupt: pack: bad signature' : 'protocol: v2: response ended without flush');
    const fp = await fetchPack(wire(bad, { response }).t, { wants: [hashObject('tree', tree)] });
    assert.equal(refusal(fp), response === null ? 'pack_corrupt: pack: bad signature' : 'protocol: v2: response ended without flush');
  }
  // fetchPack keeps every object and its parse: the objects, the parsed records, the acks
  const fp = await fetchPack(wire(pack, { chunk: 5 }).t, { wants: [hashObject('tree', tree)] });
  assert.equal(refusal(fp), 'ok');
  assert.deepEqual([fp.value.parsed.objects.length, fp.value.parsed.bytes, [...fp.value.objects.keys()]], [1, pack.length, [hashObject('tree', tree)]]);
  // an acknowledgments-only answer has no pack to parse
  const acksOnly = cat([frame('acknowledgments\n'), frame('NAK\n'), FLUSH]);
  const neg = await fetchPack(wire(pack, { response: acksOnly }).t, { wants: [hashObject('tree', tree)] });
  assert.deepEqual([refusal(neg), neg.value.parsed, neg.value.nak], ['ok', null, true]);
});

test('a commit want read as it arrives: one object, a tag and its commit, a pack without the commit, a short answer', async () => {
  const tree = hashObject('tree', treeOf('a'));
  const commit = commitOf(tree);
  const cid = hashObject('commit', commit);
  const tag = tagOf(cid);
  const want = { oid: cid, filter: 'tree:0', deepen: 1, expectType: TYPE.COMMIT };
  // one object: the single-object parser, in any chunking
  for (const chunk of [1, 5, 13, 64]) {
    const single = await buildPack([{ type: TYPE.COMMIT, data: commit }]);
    const got = await fetchObject(wire(single.pack, { chunk }).t, want);
    assert.deepEqual([refusal(got), got.ok && got.value.data], ['ok', commit], `chunk ${chunk}`);
    // two objects: the tag and the commit it peels to, collected and resolved
    const both = await buildPack([{ type: TYPE.TAG, data: tag }, { type: TYPE.COMMIT, data: commit }]);
    const { t, span } = wire(both.pack, { chunk });
    const peeled = await fetchObject(t, want);
    assert.deepEqual([refusal(peeled), peeled.ok && peeled.value.data], ['ok', commit], `chunk ${chunk}`);
    assert.deepEqual([span('git.upload-pack fetch').attrs['git.pack.objects'], span('git.upload-pack fetch').attrs['git.object.type']], [2, 'commit']);
  }
  // a multi-object pack that does not hold the commit: the single-object parser's refusal of the count
  const tags = await buildPack([{ type: TYPE.TAG, data: tag }, { type: TYPE.TAG, data: tagOf(hashObject('commit', commitOf(hashObject('tree', treeOf('b'))))) }]);
  assert.equal(refusal(await fetchObject(wire(tags.pack, { chunk: 3 }).t, want)), 'pack_corrupt: pack: expected 1 object, got 2');
  // the commit id names a tree: not_found, from the resolved pack
  const treeData = treeOf('a');
  const asTree = await buildPack([{ type: TYPE.TAG, data: tag }, { type: TYPE.TREE, data: treeData }]);
  assert.equal(refusal(await fetchObject(wire(asTree.pack).t, { ...want, oid: tree })), `not_found: ${tree} is not a commit`);
  // a resolve or parse refusal of the multi-object pack is the fetch's, after the response was read
  const corrupt = tags.pack.slice(); corrupt[corrupt.length - 1] ^= 1;
  assert.match(refusal(await fetchObject(wire(corrupt, { chunk: 7 }).t, want)), /^pack_corrupt: pack: trailer sha mismatch/);
  const noFlush = v2PackResponse(corrupt).subarray(0, v2PackResponse(corrupt).length - 4);
  assert.equal(refusal(await fetchObject(wire(corrupt, { response: noFlush }).t, want)), 'protocol: v2: response ended without flush');
  const thin = await buildPack([{ type: TYPE.TAG, data: tag }, { type: TYPE.COMMIT, data: makeDelta(commitOf(hashObject('tree', treeOf('q'))), commit).delta, base: { tag: 'ref', oid: hashObject('commit', commitOf(hashObject('tree', treeOf('q')))) } }]);
  assert.equal(refusal(await fetchObject(wire(thin.pack).t, want)), `pack_corrupt: pack: ref delta base ${hashObject('commit', commitOf(hashObject('tree', treeOf('q'))))} not found`);
  // shorter than a pack header and its first object byte: decided on what came (one object and too short; two and no pack)
  const head1 = packHead(1), head2 = packHead(2);
  assert.equal(refusal(await fetchObject(wire(head1).t, want)), 'pack_corrupt: pack: truncated before object header');
  assert.equal(refusal(await fetchObject(wire(head2).t, want)), 'pack_corrupt: pack: bad signature');
  assert.equal(refusal(await fetchObject(wire(new Uint8Array(0)).t, want)), 'pack_corrupt: pack: truncated before object header');
  // an oversized commit is refused at its header, whichever way the pack is read
  const big = await buildPack([{ type: TYPE.COMMIT, data: commit }]);
  assert.equal(refusal(await fetchObject(wire(big.pack, { limits: { maxObjectSize: commit.length - 1 } }).t, want)), `limit_exceeded: pack object size ${commit.length} exceeds limit ${commit.length - 1}`);
  assert.equal(refusal(await fetchObject(wire(big.pack, { limits: { maxObjectSize: commit.length } }).t, want)), 'ok');
  const bigTag = await buildPack([{ type: TYPE.TAG, data: tag }, { type: TYPE.COMMIT, data: commit }]);
  assert.equal(refusal(await fetchObject(wire(bigTag.pack, { limits: { maxObjectSize: commit.length - 1 } }).t, want)), `limit_exceeded: pack object size ${tag.length > commit.length - 1 ? tag.length : commit.length} exceeds limit ${commit.length - 1}`);
  // a cap that bounds nothing is refused when the transport is made (#156 parseLimits), whatever the answer would be
  assert.equal(made({ maxPackObjects: Infinity }), 'bad_request: limits.maxPackObjects must be a finite non-negative number');
  // a single-object answer is still read without the pack caps: a multi-object answer is held to them
  assert.equal(refusal(await fetchObject(wire(big.pack, { limits: { maxPackObjects: 0 } }).t, want)), 'ok');
  assert.equal(refusal(await fetchObject(wire(bigTag.pack, { limits: { maxPackObjects: 1 } }).t, want)), 'limit_exceeded: pack objects 2 exceeds limit 1');
});

test('readObjHeader and spInit: the declared size against the cap, at the cap and one past it, after the type', () => {
  const h = encodeObjHeader(TYPE.BLOB, 300);
  assert.equal(must(readObjHeader(h, 0, 0, 300)).size, 300);
  assert.equal(refusal(readObjHeader(h, 0, 0, 299)), 'limit_exceeded: pack object size 300 exceeds limit 299');
  assert.equal(must(readObjHeader(h, 0)).size, 300, 'no cap: a streamed blob is bounded by its reader');
  assert.equal(refusal(readObjHeader(Uint8Array.of(0x50 | 0x0f, 0x7f), 0, 0, 1)), 'pack_corrupt: pack: bad object type 5 at 0');
  const e = readObjHeader(h, 0, 0, 299).error;
  assert.deepEqual([e.what, e.got, e.max], ['pack object size', 300, 299]);
  const pack = sealed(concat([packHead(1), h, new Uint8Array(zlib.deflateSync(new Uint8Array(300)))]));
  assert.equal(refusal(spStep(spInit(299), pack)), 'limit_exceeded: pack object size 300 exceeds limit 299');
  assert.equal(must(spStep(spInit(300), pack)).state.size, 300);
  assert.equal(must(spStep(spInit(), pack)).state.size, 300);
});

test('parseDelta: a delta parsed once, its instructions walked and applied; the base size checked by applyProgram', () => {
  const base = te.encode('hello world, hello delta');
  const target = te.encode('hello there, hello delta!');
  const { delta, program: ops } = spliceDelta({ baseLen: base.length, off: 6, oldLen: 5, insert: te.encode('there') });
  const p = must(parseDelta(delta));
  assert.deepEqual([p.srcSize, p.dstSize, p.ops], [base.length, base.length, { copy: 2, insert: 1, copyBytes: base.length - 5, insertBytes: 5 }]);
  assert.deepEqual([...deltaOps(p)], ops.map(o => (o.tag === 'insert' ? { tag: 'insert', bytes: o.bytes } : o)));
  assert.deepEqual(must(applyProgram(base, p)), must(applyDelta(base, delta)).out);
  assert.equal(refusal(applyProgram(base.subarray(1), p)), `pack_corrupt: delta: base size ${base.length} != ${base.length - 1}`);
  assert.equal(refusal(parseDelta(delta, {}, base.length + 1)), `pack_corrupt: delta: base size ${base.length} != ${base.length + 1}`);
  assert.equal(refusal(parseDelta(delta, { maxResult: base.length - 1 })), `limit_exceeded: delta result size ${base.length} exceeds limit ${base.length - 1}`);
  assert.equal(must(parseDelta(delta, { maxResult: base.length })).dstSize, base.length);
  // makeDelta's instructions encode to what it returns, and every long copy and insert splits into opcodes
  const m = makeDelta(base, target);
  assert.deepEqual(m.delta, encodeDeltaOps(base.length, target.length, m.program));
  assert.deepEqual(must(applyProgram(base, must(parseDelta(m.delta)))), target);
  const long = new Uint8Array(0x10000 * 2 + 5).map((_, i) => i * 7);
  const big = encodeDeltaOps(long.length, long.length + 300, [{ tag: 'copy', off: 0, len: long.length }, { tag: 'insert', bytes: new Uint8Array(300).fill(9) }]);
  const bp = must(parseDelta(big));
  assert.deepEqual(bp.ops, { copy: 3, insert: 3, copyBytes: long.length, insertBytes: 300 });
  assert.deepEqual([...deltaOps(bp)].map(o => o.tag === 'copy' ? [o.tag, o.off, o.len] : [o.tag, o.bytes.length]), [['copy', 0, 0x10000], ['copy', 0x10000, 0x10000], ['copy', 0x20000, 5], ['insert', 127], ['insert', 127], ['insert', 46]]);
  assert.deepEqual(must(applyProgram(long, bp)), concat([long, new Uint8Array(300).fill(9)]));
  // an empty program (a zero-length result) walks nothing
  const empty = must(parseDelta(encodeDeltaOps(2 ** 14, 0, [])));
  assert.deepEqual([[...deltaOps(empty)], must(applyProgram(new Uint8Array(2 ** 14), empty)).length], [[], 0]);
});

test('inflate(): the output buffer, declared or grown, and a cap that bounds nothing', () => {
  const d = new Uint8Array(5 * INFLATE_CHUNK + 3).map((_, i) => i * 13 + (i >> 8));
  const z = new Uint8Array(zlib.deflateSync(d));
  const sized = must(inflate(z, 0, { expectedSize: d.length }));
  assert.deepEqual([sized.out.length, sized.out.buffer.byteLength], [d.length, d.length], 'one buffer of the declared size');
  assert.deepEqual(new Uint8Array(sized.out), d);
  // without a size: the first buffer is the input's length (or 256), doubled until it holds the output
  const grown = must(inflate(z, 0));
  assert.deepEqual(new Uint8Array(grown.out), d);
  assert.ok(grown.out.buffer.byteLength >= d.length && grown.out.buffer.byteLength < 2 * d.length + 2 * z.length, `${grown.out.buffer.byteLength}`);
  const capped = must(inflate(z, 0, { maxOutput: d.length }));
  assert.equal(capped.out.buffer.byteLength, d.length, 'growth stops at the cap');
  assert.equal(refusal(inflate(z, 0, { maxOutput: d.length - 1 })), `limit_exceeded: inflate: output exceeds limit ${d.length - 1}`);
  assert.equal(refusal(inflate(z, 0, { maxOutput: null })), 'bad_request: limits.maxObjectSize must be a finite non-negative number');
  assert.equal(refusal(inflate(z, 0, { maxOutput: -1 })), 'bad_request: limits.maxObjectSize must be a finite non-negative number');
  // a member at `pos` counts from there; the tiny member's first buffer is GUESS_MIN
  const tiny = new Uint8Array(zlib.deflateSync(Uint8Array.of(7)));
  const at = must(inflate(concat([Uint8Array.of(9, 9), tiny]), 2));
  assert.deepEqual([[...at.out], at.consumed, at.out.buffer.byteLength], [[7], tiny.length, 256]);
  assert.deepEqual([...must(inflate(new Uint8Array(zlib.deflateSync(new Uint8Array(0))), 0)).out], []);
  assert.deepEqual([...must(inflate(new Uint8Array(zlib.deflateSync(new Uint8Array(0))), 0, { expectedSize: 0 })).out], []);
  // a stored member's output is its input's length: one buffer, never grown
  const st = new Uint8Array(zlib.deflateSync(d, { level: 0 }));
  assert.equal(must(inflate(st, 0)).out.buffer.byteLength, st.length);
});

test('the pack collector: a dropped object is counted, never held', () => {
  const a = te.encode('kept'), b = te.encode('dropped bytes');
  const body = concat([packHead(2), encodeObjHeader(TYPE.BLOB, a.length), new Uint8Array(zlib.deflateSync(a)), encodeObjHeader(TYPE.TREE, b.length), new Uint8Array(zlib.deflateSync(b))]);
  const pack = sealed(body);
  const seen = [];
  const c = must(packCollectOpen({ maxObjects: 2, maxInflatedTotal: 2 * OV + 100, maxObjectSize: 100 }, true, h => { seen.push([h.offset, h.type, h.size, h.base.tag]); return h.type === TYPE.BLOB; }));
  for (let i = 0; i < pack.length; i += 3) must(packCollectFeed(c, pack.subarray(i, i + 3)));
  const r = must(packCollectEnd(c));
  assert.deepEqual(seen, [[12, TYPE.BLOB, a.length, 'none'], [12 + 1 + zlib.deflateSync(a).length, TYPE.TREE, b.length, 'none']]);
  assert.deepEqual(r.objects.map(o => [o.type, [...o.data]]), [[TYPE.BLOB, [...a]]]);
  assert.deepEqual([r.stats.count, r.stats.full, r.stats.byType, r.stats.inflated, r.bytes], [2, 2, { blob: 1, tree: 1 }, a.length + b.length, pack.length]);
  assert.equal(r.stats.compressed, zlib.deflateSync(a).length + zlib.deflateSync(b).length);
  // a refusal in a later feed is the feed's; the end returns it again
  const bad = must(packCollectOpen({ maxObjects: 1, maxInflatedTotal: 1e6, maxObjectSize: 100 }, true));
  assert.equal(refusal(packCollectFeed(bad, pack)), 'limit_exceeded: pack objects 2 exceeds limit 1');
  assert.equal(refusal(packCollectEnd(bad)), 'limit_exceeded: pack objects 2 exceeds limit 1');
});

test('spliceDelta: the instructions it builds, each only when it is not empty, and the opcode counts', () => {
  const ins = te.encode('XY');
  const cases = [
    [{ baseLen: 10, off: 0, oldLen: 0, insert: ins }, [{ tag: 'insert', bytes: ins }, { tag: 'copy', off: 0, len: 10 }], { copy: 1, insert: 1 }],
    [{ baseLen: 10, off: 10, oldLen: 0, insert: new Uint8Array(0) }, [{ tag: 'copy', off: 0, len: 10 }], { copy: 1, insert: 0 }],
    [{ baseLen: 10, off: 3, oldLen: 7, insert: ins }, [{ tag: 'copy', off: 0, len: 3 }, { tag: 'insert', bytes: ins }], { copy: 1, insert: 1 }],
    [{ baseLen: 10, off: 0, oldLen: 10, insert: ins }, [{ tag: 'insert', bytes: ins }], { copy: 0, insert: 1 }],
    [{ baseLen: 3 * 0x10000 + 1, off: 0x10000 + 1, oldLen: 0, insert: new Uint8Array(300) }, [{ tag: 'copy', off: 0, len: 0x10001 }, { tag: 'insert', bytes: new Uint8Array(300) }, { tag: 'copy', off: 0x10001, len: 0x20000 }], { copy: 4, insert: 3 }],
  ];
  for (const [splice, program, ops] of cases) {
    const d = spliceDelta(splice);
    assert.deepEqual(d.program, program);
    assert.deepEqual(d.ops, ops);
    assert.equal(d.resultLen, splice.baseLen - splice.oldLen + splice.insert.length);
    const p = must(parseDelta(d.delta));
    assert.deepEqual([p.ops.copy, p.ops.insert], [ops.copy, ops.insert], 'the counts are the opcodes on the wire');
  }
});

test('the collector and the resolver edge: a cap that bounds nothing, a hand-built pack without stats, a deep chain', () => {
  assert.equal(refusal(packCollectOpen({ maxObjects: 1, maxInflatedTotal: 1, maxObjectSize: Infinity }, true)), 'bad_request: limits.maxObjectSize must be a finite non-negative number');
  const bad = resolvePack({ objects: [{ offset: 12, type: 5, data: new Uint8Array(1) }] });
  assert.deepEqual([bad.error.code, bad.error.what], ['bad_request', 'object']);
  // without stats the bytes held are the data's: the room left for a delta result is the cap less them and the overhead
  const base = te.encode('A'.repeat(40)), target = te.encode(`${'A'.repeat(40)}B`);
  const delta = makeDelta(base, target).delta;
  const objects = [{ offset: 12, type: TYPE.BLOB, data: base }, { offset: 60, type: TYPE.OFS_DELTA, data: delta, base: { tag: 'ofs', offset: 12 } }];
  const held = base.length + delta.length + 2 * OV;
  assert.equal(refusal(resolvePack({ objects }, undefined, withLimits({ maxInflatedTotal: held + target.length }))), 'ok');
  assert.equal(refusal(resolvePack({ objects }, undefined, withLimits({ maxInflatedTotal: held + target.length - 1 }))), `limit_exceeded: delta result size ${target.length} exceeds limit ${target.length - 1}`);
  // given stats, their inflated count is what is held (a collector that dropped objects still counted them)
  assert.equal(refusal(resolvePack({ objects, stats: { inflated: base.length + delta.length + 1 } }, undefined, withLimits({ maxInflatedTotal: held + target.length }))), `limit_exceeded: delta result size ${target.length} exceeds limit ${target.length - 1}`);
  assert.equal(refusal(resolvePack({ objects, stats: { inflated: 0 } }, undefined, withLimits({ maxInflatedTotal: 2 * OV + target.length }))), 'ok');
  // a chain listed child-first is walked by recursion: the depth bound stops it at the cap, not at the stack's end
  const chain = [];
  const n = 20000;
  for (let i = n; i >= 1; i--) chain.push({ offset: 12 + i, type: TYPE.OFS_DELTA, data: delta, base: { tag: 'ofs', offset: 12 + i - 1 } });
  chain.push({ offset: 12, type: TYPE.BLOB, data: base });
  assert.equal(refusal(resolvePack({ objects: chain }, undefined, withLimits({ maxDeltaChain: 64 }))), 'limit_exceeded: delta chain depth 65 exceeds limit 64');
  const refChain = [];
  let prev = base;
  const ids = [hashObject('blob', base)];
  const steps = [];
  for (let i = 1; i <= 3; i++) { const next = concat([prev, te.encode(String(i))]); steps.push(makeDelta(prev, next).delta); ids.push(hashObject('blob', next)); prev = next; }
  // REF deltas child-first, each base in the pack: resolved from the pack, the external lookup never asked
  for (let i = 3; i >= 1; i--) refChain.push({ offset: 100 + i, type: TYPE.REF_DELTA, data: steps[i - 1], base: { tag: 'ref', oid: ids[i - 1] } });
  refChain.push({ offset: 12, type: TYPE.BLOB, data: base });
  const asked = [];
  const r = must(resolvePack({ objects: refChain }, o => { asked.push(o); return null; }));
  assert.deepEqual([r.objects.size, r.stats.externalBases, r.stats.maxChain, asked], [4, 0, 3, []]);
  // a REF delta on an in-pack REF delta whose own base is missing: the first waiting object's base is the refusal
  const orphan = [refChain[0], refChain[1]];
  assert.equal(refusal(resolvePack({ objects: orphan })), `pack_corrupt: pack: ref delta base ${ids[2]} not found`);
  // an external base that is not a stored object, or does not hash to the id it was asked for
  const thin = [{ offset: 12, type: TYPE.REF_DELTA, data: steps[0], base: { tag: 'ref', oid: ids[0] } }];
  assert.equal(refusal(resolvePack({ objects: thin }, () => ({ type: TYPE.OFS_DELTA, data: base }))), `pack_corrupt: pack: ref delta base ${ids[0]} has type 6`);
  assert.equal(refusal(resolvePack({ objects: thin }, () => ({ type: TYPE.BLOB, data: target }))), `pack_corrupt: pack: ref delta base ${ids[0]} hashes to ${hashObject('blob', target)}`);
  assert.equal(refusal(resolvePack({ objects: thin }, () => ({ type: TYPE.TREE, data: base }))), `pack_corrupt: pack: ref delta base ${ids[0]} hashes to ${hashObject('tree', base)}`);
  assert.equal(refusal(resolvePack({ objects: thin }, () => ({ type: TYPE.BLOB, data: base }))), 'ok');
});

test('the wide and multi-object fetches read the caller\'s pack caps, verify the trailer, and count what they skipped', async () => {
  const tA = treeOf('a');
  const { pack } = await buildPack([{ type: TYPE.TREE, data: tA }, { type: TYPE.TREE, data: treeOf('b') }]);
  const want = { oid: hashObject('tree', tA), filter: 'tree:0', expectType: TYPE.TREE };
  const wide = { quirks: { treeFilter: 'blob:none' } };
  for (const [limits, msg] of [[{ maxPackObjects: 1 }, 'limit_exceeded: pack objects 2 exceeds limit 1']]) {
    assert.equal(refusal(await fetchObject(wire(pack, { ...wide, limits }).t, want)), msg);
    assert.equal(refusal(await fetchPack(wire(pack, { limits }).t, { wants: [want.oid] })), msg);
  }
  // a cap that bounds nothing never reaches a fetch: the transport is not made (#156 parseLimits)
  assert.equal(made({ maxPackObjects: Infinity }), 'bad_request: limits.maxPackObjects must be a finite non-negative number');
  const cid = hashObject('commit', commitOf(hashObject('tree', tA)));
  const flipped = pack.slice(); flipped[flipped.length - 1] ^= 1;
  assert.match(refusal(await fetchObject(wire(flipped, wide).t, want)), /^pack_corrupt: pack: trailer sha mismatch/);
  assert.match(refusal(await fetchPack(wire(flipped).t, { wants: [want.oid] })), /^pack_corrupt: pack: trailer sha mismatch/);
  // a commit want through the fallback drops the blobs too; an extra tree over a limit is skipped and counted
  const commit = commitOf(hashObject('tree', tA));
  const big = treeOf('x', 'y', 'z');
  const blob = te.encode('blob bytes');
  const blob2 = te.encode('blob bytes, and more of them');
  const d2 = makeDelta(blob, blob2).delta;
  const withBlob = await buildPack([{ type: TYPE.COMMIT, data: commit }, { type: TYPE.TREE, data: tA }, { type: TYPE.BLOB, data: blob }, { type: TYPE.TREE, data: big }, { type: TYPE.BLOB, data: d2, base: { tag: 'ofs', index: 2 } }]);
  const { t, span } = wire(withBlob.pack, { ...wide, limits: { maxTreeEntries: 2 } });
  const got = await fetchObject(t, { oid: cid, filter: 'tree:0', deepen: 1, expectType: TYPE.COMMIT });
  assert.equal(refusal(got), 'ok');
  const a = span('git.upload-pack fetch').attrs;
  assert.deepEqual([a['git.fetch.wide.objects'], a['git.fetch.wide.extra_objects'], a['git.fetch.wide.blobs'], a['git.fetch.wide.skipped'], a['git.fetch.wide.extra_bytes']], [5, 4, 2, 1, tA.length + blob.length + big.length + d2.length]);
  assert.notEqual(d2.length, blob2.length, 'a dropped delta counts at its declared size, not its result\'s');
  assert.deepEqual([...t.objects.keys()], [hashObject('tree', tA)]);
});

test('fetchPack: one span event per object, its base as the event names it', async () => {
  const base = te.encode('B'.repeat(64));
  const next = te.encode(`${'B'.repeat(64)}!`);
  const { pack } = await buildPack([{ type: TYPE.BLOB, data: base }, { type: TYPE.BLOB, data: makeDelta(base, next).delta, base: { tag: 'ofs', index: 0 } }]);
  const refPack = await buildPack([{ type: TYPE.BLOB, data: makeDelta(base, next).delta, base: { tag: 'ref', oid: hashObject('blob', base) } }]);
  const ev = async (p, extra = {}) => {
    const { t, span } = wire(p);
    must(await fetchPack(t, { wants: [hashObject('blob', next)] }, extra));
    return span('git.upload-pack fetch').events.filter(e => e.name === 'git.pack.object').map(e => [e.attrs['git.object.base.offset'], e.attrs['git.object.base.oid']]);
  };
  assert.deepEqual(await ev(pack), [[-1, ''], [12, '']]);
  assert.deepEqual(await ev(refPack.pack, { external: () => ({ type: TYPE.BLOB, data: base }) }), [[-1, hashObject('blob', base)]]);
});

// ---- the work budget (#240): a scan that keeps nothing is charged what inflating costs ----
const member = (data, level = 9) => new Uint8Array(zlib.deflateSync(data, { level }));
const blobEntry = data => concat([encodeObjHeader(TYPE.BLOB, data.length), member(data)]);
const packOf = datas => sealed(concat([packHead(datas.length), ...datas.map(blobEntry)]));
// Feed `pieces` one at a time and drain; the inflated bytes delivered and the outcome (the end, or the refusal).
function drain(pieces, opts) {
  const opened = parsePackInit(opts);
  if (!opened.ok) return { inflated: 0, objects: 0, r: opened };
  const st = opened.value;
  let inflated = 0, objects = 0, next = 0;
  for (;;) {
    const r = next < pieces.length ? parsePackPull(st) : parsePackEnd(st);
    if (!r.ok) return { inflated, objects, r };
    if (r.value.kind === 'need') { if (next < pieces.length) parsePackFeed(st, pieces[next++]); continue; }
    if (r.value.kind === 'chunk') inflated += r.value.bytes.length;
    if (r.value.kind === 'object-end') objects += 1;
    if (r.value.kind === 'end') return { inflated, objects, r };
  }
}
const feedings = (bytes, rng) => [[bytes], Array.from(bytes, b => Uint8Array.of(b)), splitRandom(rng, bytes)];

test('work budget: a bomb is refused within one chunk of its budget, in every feeding, before the object ends', () => {
  const bomb = packOf([new Uint8Array(8 * 1024 * 1024)]);
  assert.ok(bomb.length < 16 * 1024, 'the fixture is a bomb');
  const rng = new Rng(240);
  const floor = 256 * 1024;
  const limits = withLimits({ maxInflatedTotal: floor });
  for (const pieces of feedings(bomb, rng)) {
    const { inflated, objects, r } = drain(pieces, packScanOpts(limits, true, workBudget(4)));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'limit_exceeded');
    assert.equal(r.error.what, 'pack inflated work');
    assert.equal(objects, 0);
    // the refusal is the pull that would have handed over the chunk past the budget: nothing past it reaches the caller
    assert.ok(inflated <= floor, `delivered ${inflated} > ${floor}`);
    assert.ok(r.error.got <= floor + 16 * 1024, `charged ${r.error.got}`);
  }
});

test('work budget: the budget is the larger of maxInflatedTotal and ratio times the pack bytes consumed, on bytes actually inflated', () => {
  const data = new Uint8Array(16_000);
  const entry = blobEntry(data);
  const pack = sealed(concat([packHead(1), entry]));
  const header = encodeObjHeader(TYPE.BLOB, data.length).length;
  const consumed = 12 + entry.length;
  assert.equal(consumed, 12 + header + member(data).length);
  const at = (maxInflatedTotal, budget) => refusal(drain([pack], packScanOpts(withLimits({ maxInflatedTotal }), true, budget)).r);
  // the ratio alone: 2 x consumed (the header, the object's header and its whole member)
  assert.equal(at(0, workBudget(2)), `limit_exceeded: pack inflated work 16000 exceeds limit ${2 * consumed}`);
  // the floor when it is the larger
  assert.equal(at(2 * consumed + 1, workBudget(2)), `limit_exceeded: pack inflated work 16000 exceeds limit ${2 * consumed + 1}`);
  // exactly the budget passes, either way it is reached
  assert.equal(at(16_000, workBudget(0)), 'ok');
  assert.equal(at(15_999, workBudget(0)), 'limit_exceeded: pack inflated work 16000 exceeds limit 15999');
  assert.equal(at(0, workBudget(16_000 / consumed)), 'ok');
  assert.equal(at(0, workBudget(1000)), 'ok');
});

test('work budget: charges accumulate across objects, with no per-object overhead and no declared-size charge', () => {
  const a = new Uint8Array(1000).fill(1), b = new Uint8Array(2000).fill(2);
  const pack = packOf([a, b]);
  const at = n => drain([pack], packScanOpts(withLimits({ maxInflatedTotal: n }), true, workBudget(0)));
  assert.equal(at(3000).r.ok, true);
  assert.equal(at(3000).objects, 2);
  assert.equal(refusal(at(2999).r), 'limit_exceeded: pack inflated work 3000 exceeds limit 2999');
  assert.equal(at(2999).objects, 1);
  // retain charges the declared sizes and their overhead for the same pack, before any byte inflates
  const retained = drain([pack], packScanOpts(withLimits({ maxInflatedTotal: 3000 + 2 * OV - 1 })));
  assert.equal(refusal(retained.r), `limit_exceeded: pack inflated bytes ${3000 + 2 * OV} exceeds limit ${3000 + 2 * OV - 1}`);
  assert.equal(retained.inflated, 1000);
});

test('work budget: an honest pack over every retain cap passes with no caps raised, the same objects as a retain scan', () => {
  const rng = new Rng(2400);
  const incompressible = crypto.randomBytes(40_000);
  const data = [new Uint8Array(incompressible), te.encode('tree text\n'.repeat(3000)), new Uint8Array(0)];
  const pack = packOf(data);
  const tight = withLimits({ maxObjectSize: 100, maxInflatedTotal: 1000 });
  assert.equal(drain([pack], packScanOpts(tight)).r.ok, false);
  const total = data.reduce((n, d) => n + d.length, 0);
  const reference = drain([pack], packScanOpts());
  assert.equal(reference.r.ok, true);
  for (const pieces of feedings(pack, rng)) {
    const got = drain(pieces, packScanOpts(tight, true, WORK_BUDGET));
    assert.equal(got.r.ok, true, refusal(got.r));
    assert.equal(got.inflated, total);
    assert.equal(got.objects, reference.objects);
  }
});

test('work budget: maxObjectSize applies only when asked for, and a size past a safe integer is still refused', () => {
  const data = new Uint8Array(4096).fill(7);
  const pack = packOf([data]);
  const limits = withLimits({ maxObjectSize: 4095 });
  assert.equal(drain([pack], packScanOpts(limits, true, WORK_BUDGET)).r.ok, true);
  assert.equal(drain([pack], packScanOpts(limits, true, workBudget(32))).r.ok, true);
  assert.equal(refusal(drain([pack], packScanOpts(limits, true, workBudget(32, true))).r), 'limit_exceeded: pack object size 4096 exceeds limit 4095');
  assert.equal(drain([pack], packScanOpts(withLimits({ maxObjectSize: 4096 }), true, workBudget(32, true))).r.ok, true);
  // type blob, 4 + 7 x 7 + 7 = 60 bits of size
  const huge = sealed(concat([packHead(1), Uint8Array.of(0xbf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f), member(data)]));
  const r = drain([huge], packScanOpts(DEFAULT_LIMITS, true, WORK_BUDGET));
  assert.equal(r.r.error.code, 'limit_exceeded');
  assert.equal(r.r.error.what, 'pack object size');
  assert.equal(r.r.error.max, Number.MAX_SAFE_INTEGER);
});

test('work budget: maxPackObjects, corruption and the trailer are still refused', () => {
  const pack = packOf([new Uint8Array(10), new Uint8Array(11)]);
  assert.equal(refusal(drain([pack], packScanOpts(withLimits({ maxPackObjects: 1 }), true, WORK_BUDGET)).r), 'limit_exceeded: pack objects 2 exceeds limit 1');
  const flipped = pack.slice();
  flipped[flipped.length - 1] ^= 1;
  assert.match(refusal(drain([flipped], packScanOpts(DEFAULT_LIMITS, true, WORK_BUDGET)).r), /^pack_corrupt: pack: trailer sha mismatch/);
  assert.equal(drain([pack.subarray(0, pack.length - 25)], packScanOpts(DEFAULT_LIMITS, true, WORK_BUDGET)).r.error.code, 'pack_corrupt');
});

test('work budget: a ratio that bounds nothing is refused where the scan opens', () => {
  for (const ratio of [Infinity, NaN, -1, '32']) {
    assert.equal(refusal(parsePackInit(packScanOpts(DEFAULT_LIMITS, true, workBudget(ratio)))), 'bad_request: limits.workRatio must be a finite non-negative number');
  }
  assert.equal(parsePackInit(packScanOpts(DEFAULT_LIMITS, true, workBudget(0))).ok, true);
});

test('the default budget is retain: a record with no budget, and packScanOpts with none, refuse as parsePack does', () => {
  assert.deepEqual(RETAIN_BUDGET, { tag: 'retain' });
  assert.deepEqual(WORK_BUDGET, { tag: 'work', ratio: 32, capObjects: false });
  assert.deepEqual(workBudget(5, true), { tag: 'work', ratio: 5, capObjects: true });
  assert.deepEqual(packScanOpts().budget, RETAIN_BUDGET);
  const data = new Uint8Array(100);
  const pack = packOf([data]);
  const limits = withLimits({ maxInflatedTotal: 100 + OV - 1 });
  const expected = `limit_exceeded: pack inflated bytes ${100 + OV} exceeds limit ${100 + OV - 1}`;
  assert.equal(refusal(parsePack(pack, { limits })), expected);
  assert.equal(refusal(drain([pack], { verify: true, limits }).r), expected);
  assert.equal(refusal(drain([pack], { verify: true, limits, budget: undefined }).r), expected);
  assert.equal(refusal(drain([pack], { verify: true, limits, budget: null }).r), expected);
  assert.equal(refusal(drain([pack], packScanOpts(limits)).r), expected);
});
