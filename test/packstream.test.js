// Streaming pkt-line, sideband, inflate, and pack scan. The pull is the codec: inflate() only joins its chunks.
// A match past the zlib window is pack_corrupt (the same pull the whole-buffer entry uses). Packs git writes stay inside it.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { concat, te, td } from '../src/bytes.js';
import { pkt, pktInit, pktStep } from '../src/pktline.js';
import { deflateOpen, deflatePull, zlibDeflate, encodeObjHeader, buildPack } from '../src/pack.js';
import { parsePack } from '../src/packresolve.js';
import { adler32, huffBuild, DEFLATE_TABLES } from '../src/inflate.js';
import {
  inflate, inflateInit, inflateFeed, inflatePull, inflateEnd, inflateRelease, inflateUnread,
  cappedBound, declaredBound, zlibWrap, rawWrap, streamInflateAttrs,
} from '../src/inflatestream.js';
import {
  parsePackInit, parsePackFeed, parsePackClose, parsePackPull, parsePackEnd, packScanOpts,
  sidebandInit, sidebandStep, streamPackAttrs, streamSidebandAttrs,
} from '../src/packstream.js';
import { peakBound } from '../src/streambound.js';
import { hashObject, TYPE } from '../src/objects.js';
import { withLimits, DEFAULT_LIMITS } from '../src/limits.js';
import { Sha1 } from '../src/sha1.js';
import { git, gitBuf, tmpRoot } from './server.js';
import {
  PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, PACK_TRAILER_BYTES, PKT_MAX_SIZE, INFLATE_WINDOW, INFLATE_CHUNK,
  SIDEBAND_PACK, SIDEBAND_PROGRESS, SIDEBAND_ERROR, SIDEBAND_PROGRESS_KEEP, ZLIB_CINFO_MAX, ZLIB_WINDOW_EXPONENT, zlibBound,
} from '../src/format.js';

const HOLD = INFLATE_WINDOW + INFLATE_CHUNK + PKT_MAX_SIZE;
const opts = { bound: cappedBound(), wrap: zlibWrap(true) };
const rawOpts = { bound: cappedBound(), wrap: rawWrap() };

function must(r) {
  if (r.ok) return r.value;
  throw new Error(`${r.error.code}: ${r.error.message}`);
}
function throws(fn, code, message) {
  assert.throws(fn, e => e.code === code && e.message === message);
}
function packHead(count) {
  const b = new Uint8Array(PACK_HEADER_BYTES);
  b.set(PACK_SIGNATURE);
  const view = new DataView(b.buffer);
  view.setUint32(PACK_SIGNATURE.length, PACK_VERSION);
  view.setUint32(PACK_SIGNATURE.length + 4, count);
  return b;
}
function drive(buf, scan, cut) {
  const opened = parsePackInit(scan);
  if (!opened.ok) return { kind: 'err', error: opened.error };
  const st = opened.value;
  const pieces = [];
  let off = 0;
  let closed = false;
  for (;;) {
    const step = parsePackPull(st);
    if (!step.ok) return { kind: 'err', error: step.error };
    if (step.value.kind === 'need') {
      if (off < buf.length) {
        const n = Math.min(cut, buf.length - off);
        parsePackFeed(st, buf.subarray(off, off + n));
        off += n;
        continue;
      }
      if (!closed) { parsePackClose(st); closed = true; continue; }
      throw new Error('need after close');
    }
    pieces.push(step.value);
    if (step.value.kind === 'end') return { kind: 'ok', pieces, scan: st };
  }
}
function taken(pieces) {
  const out = [];
  let cur = null;
  for (const p of pieces) {
    if (p.kind === 'object') cur = { type: p.type, size: p.size, offset: p.offset, base: p.base, parts: [] };
    else if (p.kind === 'chunk' && cur) cur.parts.push(p.bytes);
    else if (p.kind === 'object-end' && cur) {
      out.push({ type: cur.type, size: cur.size, offset: cur.offset, base: cur.base, data: concat(cur.parts) });
      cur = null;
    }
  }
  return out;
}
function pullMember(bytes, streamOpts, cut) {
  const st = must(inflateInit(streamOpts));
  const parts = [];
  let off = 0;
  let closed = false;
  for (;;) {
    const step = closed ? inflateEnd(st) : inflatePull(st);
    closed = false;
    if (!step.ok) return step;
    if (step.value.kind === 'chunk') { parts.push(step.value.bytes); continue; }
    if (step.value.kind === 'end') return { ok: true, value: { out: concat(parts), consumed: step.value.consumed, stats: step.value.stats, st } };
    if (off < bytes.length) {
      const n = Math.min(cut, bytes.length - off);
      inflateFeed(st, bytes.subarray(off, off + n));
      off += n;
      continue;
    }
    closed = true;
  }
}
function storedBlock(data, final) {
  const len = data.length;
  const nlen = (~len) & 0xffff;
  return concat([Uint8Array.of(final ? 1 : 0, len & 0xff, len >> 8, nlen & 0xff, (nlen >> 8) & 0xff), data]);
}
function streamOf(data, gaps) {
  const parts = [Uint8Array.of(0x78, 0x01)];
  for (let i = 0; i < gaps; i++) parts.push(Uint8Array.of(0, 0, 0, 0xff, 0xff));
  parts.push(storedBlock(data, true));
  const tail = new Uint8Array(4);
  new DataView(tail.buffer).setUint32(0, adler32(data));
  parts.push(tail);
  return concat(parts);
}
function huffCodes(h) {
  const map = new Map();
  let code = 0;
  let index = 0;
  for (let len = 1; len < 16; len++) {
    for (let i = 0; i < h.count[len]; i++) { map.set(h.symbol[index + i], { len, code }); code++; }
    index += h.count[len];
    code <<= 1;
  }
  return map;
}
function packBits(bits) {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3] |= 1 << (i & 7);
  return out;
}
const litTab = huffCodes(huffBuild(Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8))));
const distTab = huffCodes(huffBuild(Array.from({ length: 30 }, () => 5)));
function fixed(ops, final = true, bits = []) {
  const put = (v, n) => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); };
  const putCode = rec => { for (let i = rec.len - 1; i >= 0; i--) bits.push((rec.code >> i) & 1); };
  put(final ? 1 : 0, 1); put(1, 2);
  for (const op of ops) {
    if (op.kind === 'lit') putCode(litTab.get(op.lit));
    else if (op.kind === 'match') {
      putCode(litTab.get(op.sym));
      if (op.extraBits > 0) put(op.extra, op.extraBits);
      putCode(distTab.get(op.dist));
      if (op.distExtraBits > 0) put(op.distExtra, op.distExtraBits);
    } else putCode(litTab.get(256));
  }
  return packBits(bits);
}
function distOf(distance) {
  const { DBASE, DEXT } = DEFLATE_TABLES;
  for (let i = 0; i < DBASE.length; i++) {
    const base = DBASE[i];
    const bits = DEXT[i];
    const span = 1 << bits;
    if (distance < base + span) return { dist: i, distExtra: distance - base, distExtraBits: bits };
  }
  throw new Error(`no distance code for ${distance}`);
}
function dyn(hlit, hdist) {
  const bits = [];
  const put = (v, n) => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); };
  put(1, 1); put(2, 2); put(hlit, 5); put(hdist, 5); put(0, 4);
  return packBits(bits);
}
function repeat(head, body) {
  const bits = [];
  const put = (v, n) => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); };
  put(1, 1); put(2, 2); put(0, 5); put(0, 5); put(0, 4);
  for (const n of head) put(n, 3);
  for (const [v, n] of body) put(v, n);
  return packBits(bits);
}
async function deflateAll(bytes) {
  const session = deflateOpen(bytes);
  const parts = [];
  for (;;) {
    const step = await deflatePull(session);
    if (step.kind === 'end') return concat(parts);
    parts.push(step.bytes);
  }
}

test('peak bounds are the window, one chunk, and one frame', () => {
  assert.equal(peakBound({ kind: 'inflate' }), HOLD);
  assert.equal(peakBound({ kind: 'pack-scan' }), HOLD);
  assert.equal(peakBound({ kind: 'blob-read' }), HOLD);
  assert.equal(peakBound({ kind: 'pkt' }), PKT_MAX_SIZE + PKT_MAX_SIZE);
  assert.equal(peakBound({ kind: 'sideband' }), PKT_MAX_SIZE + PKT_MAX_SIZE);
  assert.equal(peakBound({ kind: 'fetch-object', output: 10 }), HOLD + 10);
  assert.equal(peakBound({ kind: 'fetch-pack', retained: 10 }), HOLD + 10);
  assert.equal(peakBound({ kind: 'push', largest: 10 }), INFLATE_CHUNK + 10);
});

test('a pkt-line payload is a copy, so the chunk can be dropped', () => {
  const chunk = pkt('hello').slice();
  const stepped = pktStep(pktInit(), chunk);
  const payload = stepped.frames[0].payload;
  chunk[4] = 0x58;
  assert.equal(payload[0], 0x68);
  assert.equal(td.decode(payload), 'hello');
});

test('deflatePull collected twice matches zlibDeflate and node:zlib', async () => {
  const bytes = te.encode('hello hello hello hello');
  const once = await deflateAll(bytes);
  const twice = await deflateAll(bytes);
  const joined = await zlibDeflate(bytes);
  assert.deepEqual(once, twice);
  assert.deepEqual(once, joined);
  assert.deepEqual(Buffer.from(once), zlib.deflateSync(bytes));
});

test('inflate pull matches the materializer, node:zlib, and every cut', () => {
  const hello = te.encode('hello hello hello');
  const samples = [
    zlib.deflateSync(hello),
    zlib.deflateSync(hello, { level: 0 }),
    zlib.deflateSync(Buffer.from('a'.repeat(4000))),
    zlib.deflateRawSync(hello),
  ];
  const wraps = [zlibWrap(true), zlibWrap(true), zlibWrap(true), rawWrap()];
  for (let s = 0; s < samples.length; s++) {
    const z = new Uint8Array(samples[s]);
    const streamOpts = { bound: declaredBound(s === 2 ? 4000 : hello.length), wrap: wraps[s] };
    const whole = inflate(z, 0, streamOpts);
    const node = s === 3 ? zlib.inflateRawSync(z) : zlib.inflateSync(z);
    assert.deepEqual(Buffer.from(whole.out), node);
    for (const cut of [1, 3, 7, 64, z.length]) {
      const pulled = pullMember(z, streamOpts, cut);
      assert.equal(pulled.ok, true);
      assert.deepEqual(Buffer.from(pulled.value.out), node);
      assert.equal(pulled.value.consumed, whole.consumed);
      assert.deepEqual(pulled.value.stats, whole.stats);
    }
  }
  const z = new Uint8Array(zlib.deflateSync(hello));
  const junk = te.encode('junk!!!');
  const prefixed = inflate(concat([junk, z, Uint8Array.of(1, 2, 3)]), junk.length, opts);
  assert.equal(prefixed.consumed, z.length);
  assert.ok(Buffer.from(prefixed.out).equals(Buffer.from(hello)));
  const st = must(inflateInit(opts));
  inflateFeed(st, z);
  must(inflateEnd(st));
  const attrs = streamInflateAttrs(st);
  assert.equal(attrs['git.inflate.ended'], true);
  assert.equal(typeof attrs['git.inflate.phase'], 'string');
});

test('inflate refusals name the same failures a whole member hits', () => {
  const hello = te.encode('hello');
  const z = new Uint8Array(zlib.deflateSync(hello));
  throws(() => inflate(Uint8Array.of(0x01, 0x00), 0, opts), 'pack_corrupt', 'zlib: unsupported method 1');
  throws(() => inflate(Uint8Array.of(0x88, 0x00), 0, opts), 'pack_corrupt', `zlib: window size ${ZLIB_CINFO_MAX + 1} is not a zlib window`);
  throws(() => inflate(Uint8Array.of(0x78, 0x00), 0, opts), 'pack_corrupt', 'zlib: bad header check');
  throws(() => inflate(Uint8Array.of(0x78, 0x20), 0, opts), 'pack_corrupt', 'zlib: preset dictionary not supported');
  throws(() => inflate(z.subarray(0, z.length - 2), 0, opts), 'pack_corrupt', 'inflate: truncated adler32');
  throws(() => inflate(concat([Uint8Array.of(0x78, 0x9c), Uint8Array.of(1, 0, 0, 255, 255)]), 0, opts), 'pack_corrupt', 'inflate: truncated adler32');
  const mismatch = z.slice();
  mismatch[mismatch.length - 1] ^= 1;
  throws(() => inflate(mismatch, 0, opts), 'pack_corrupt', 'inflate: adler32 mismatch');
  assert.equal(inflate(mismatch, 0, { bound: cappedBound(), wrap: zlibWrap(false) }).out.length, hello.length);
  throws(() => inflate(z, 0, { bound: declaredBound(1), wrap: zlibWrap(true) }), 'pack_corrupt', 'inflate: output exceeds expected 1');
  throws(() => inflate(z, 0, { bound: declaredBound(hello.length + 3), wrap: zlibWrap(true) }), 'pack_corrupt', `inflate: size ${hello.length} != expected ${hello.length + 3}`);
  throws(() => inflate(z, 0, { bound: declaredBound(DEFAULT_LIMITS.maxObjectSize + 1), wrap: zlibWrap(true) }), 'limit_exceeded', `inflate: expected size ${DEFAULT_LIMITS.maxObjectSize + 1} exceeds limit ${DEFAULT_LIMITS.maxObjectSize}`);
  const empty = new Uint8Array(0);
  const tooLong = streamOf(empty, 1);
  throws(() => inflate(tooLong, 0, { bound: declaredBound(0), wrap: zlibWrap(true) }), 'pack_corrupt', `inflate: zlib stream longer than its declared size allows (${tooLong.length} > ${zlibBound(0)} for 0 bytes)`);
  throws(() => inflate(Uint8Array.of(0b111), 0, rawOpts), 'pack_corrupt', 'inflate: invalid block type');
  throws(() => inflate(Uint8Array.of(1), 0, rawOpts), 'pack_corrupt', 'inflate: truncated stored header');
  throws(() => inflate(Uint8Array.of(0b001, 1, 0, 0xfe, 0xfe, 0x41), 0, rawOpts), 'pack_corrupt', 'inflate: stored length check failed');
  throws(() => inflate(storedBlock(Uint8Array.of(1, 2, 3), true).subarray(0, 6), 0, rawOpts), 'pack_corrupt', 'inflate: truncated stored block');
  const grown = new Uint8Array(305);
  grown[0] = 1; grown[1] = 300 & 255; grown[2] = 300 >> 8;
  const nlen = (~300) & 0xffff; grown[3] = nlen & 255; grown[4] = nlen >> 8;
  grown.fill(7, 5);
  throws(() => inflate(grown, 0, { bound: cappedBound(100), wrap: rawWrap() }), 'limit_exceeded', 'inflate: output exceeds limit 100');
  throws(() => inflate(fixed([{ kind: 'lit', lit: 97 }]), 0, rawOpts), 'pack_corrupt', 'inflate: unexpected end of input');
  const twoBits = [];
  fixed([{ kind: 'lit', lit: 97 }, { kind: 'eob' }], false, twoBits);
  fixed([{ kind: 'lit', lit: 98 }, { kind: 'eob' }], true, twoBits);
  assert.deepEqual([...inflate(packBits(twoBits), 0, rawOpts).out], [97, 98]);
  const partial = storedBlock(Uint8Array.of(1, 2, 3, 4, 5), true);
  const mid = must(inflateInit(rawOpts));
  inflateFeed(mid, partial.subarray(0, 6));
  const oneByte = must(inflatePull(mid));
  assert.equal(oneByte.kind, 'chunk');
  assert.equal(oneByte.bytes[0], 1);
  const waiting = inflatePull(mid);
  assert.equal(waiting.ok, true);
  assert.equal(waiting.value.kind, 'need');
  throws(() => inflate(fixed([{ kind: 'match', sym: 286, extra: 0, extraBits: 0, dist: 0, distExtra: 0, distExtraBits: 0 }]), 0, rawOpts), 'pack_corrupt', 'inflate: bad length symbol');
  throws(() => inflate(fixed([{ kind: 'match', sym: 257, extra: 0, extraBits: 0, dist: 0, distExtra: 0, distExtraBits: 0 }]), 0, rawOpts), 'pack_corrupt', 'inflate: distance too far back');
  throws(() => inflate(dyn(30, 0), 0, rawOpts), 'pack_corrupt', 'inflate: bad dynamic counts');
  throws(() => inflate(repeat([1, 0, 0, 0], [[0, 1]]), 0, rawOpts), 'pack_corrupt', 'inflate: repeat with no previous');
  throws(() => inflate(repeat([0, 0, 1, 0], [[0, 1], [127, 7], [0, 1], [127, 7]]), 0, rawOpts), 'pack_corrupt', 'inflate: repeat overflow');
  throws(() => inflate(repeat([0, 0, 1, 0], [[0, 1], [127, 7], [0, 1], [120 - 11, 7]]), 0, rawOpts), 'pack_corrupt', 'inflate: no end-of-block code');
  const bits = [];
  const put = (v, n) => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); };
  put(1, 1); put(2, 2); put(0, 5); put(0, 5); put(1, 4);
  put(0, 3); put(0, 3); put(0, 3); put(1, 3); put(1, 3);
  for (let i = 0; i < 256; i++) put(0, 1);
  put(1, 1); put(0, 1);
  for (let i = 0; i < 16; i++) put(1, 1);
  throws(() => inflate(packBits(bits), 0, { bound: cappedBound(1024), wrap: rawWrap() }), 'pack_corrupt', 'inflate: invalid huffman code');
});

test('a match past the zlib window is refused; the same bytes inside the window inflate', () => {
  const distance = (1 << ZLIB_WINDOW_EXPONENT) + 1;
  const far = distOf(distance);
  const ops = [];
  for (let i = 0; i < distance; i++) ops.push({ kind: 'lit', lit: 97 });
  ops.push({ kind: 'match', sym: 257, extra: 0, extraBits: 0, dist: far.dist, distExtra: far.distExtra, distExtraBits: far.distExtraBits });
  ops.push({ kind: 'eob' });
  const raw = fixed(ops);
  const data = must(pullMember(raw, { bound: cappedBound(distance + 3), wrap: rawWrap() }, raw.length));
  assert.equal(data.out.length, distance + 3);
  const adler = new Uint8Array(4);
  new DataView(adler.buffer).setUint32(0, adler32(data.out));
  const narrow = concat([Uint8Array.of(0x08, 0x1d), raw, adler]);
  throws(() => inflate(narrow, 0, { bound: cappedBound(distance + 3), wrap: zlibWrap(true) }), 'pack_corrupt', 'inflate: distance too far back');
  const wide = concat([Uint8Array.of(0x78, 0x01), raw, adler]);
  assert.equal(inflate(wide, 0, { bound: cappedBound(distance + 3), wrap: zlibWrap(true) }).out.length, distance + 3);
  // Distance equal to the declared window is still inside it. `>=` would refuse a byte the window still holds.
  const exact = 1 << ZLIB_WINDOW_EXPONENT;
  const at = distOf(exact);
  const exactOps = [];
  for (let i = 0; i < exact; i++) exactOps.push({ kind: 'lit', lit: 97 });
  exactOps.push({ kind: 'match', sym: 257, extra: 0, extraBits: 0, dist: at.dist, distExtra: at.distExtra, distExtraBits: at.distExtraBits }, { kind: 'eob' });
  const exactRaw = fixed(exactOps);
  const exactOut = must(pullMember(exactRaw, { bound: cappedBound(exact + 3), wrap: rawWrap() }, exactRaw.length));
  const exactAdler = new Uint8Array(4);
  new DataView(exactAdler.buffer).setUint32(0, adler32(exactOut.out));
  const atWindow = concat([Uint8Array.of(0x08, 0x1d), exactRaw, exactAdler]);
  const kept = inflate(atWindow, 0, { bound: cappedBound(exact + 3), wrap: zlibWrap(true) });
  assert.equal(kept.out.length, exact + 3);
  assert.equal(kept.stats.maxDist, exact);
});

test('a pack scan at every cut matches parsePack, and git cat-file matches a non-delta object', async () => {
  const blob = te.encode('hello-stream');
  const other = te.encode('hello-stream!');
  const { pack } = await buildPack([{ type: TYPE.BLOB, data: blob }, { type: TYPE.BLOB, data: other }]);
  const parsed = parsePack(pack);
  for (const cut of [1, 5, pack.length]) {
    const driven = drive(pack, packScanOpts(), cut);
    assert.equal(driven.kind, 'ok');
    const objs = taken(driven.pieces);
    assert.equal(objs.length, parsed.objects.length);
    for (let i = 0; i < objs.length; i++) {
      assert.equal(objs[i].type, parsed.objects[i].type);
      assert.equal(objs[i].offset, parsed.objects[i].offset);
      assert.deepEqual(objs[i].data, parsed.objects[i].data);
      assert.equal(objs[i].base.kind, 'none');
    }
    assert.equal(driven.pieces.at(-1).kind, 'end');
    const attrs = streamPackAttrs(driven.scan);
    assert.equal(attrs['git.pack.objects'], 2);
    assert.equal(attrs['git.pack.ended'], true);
  }
  const base = 'ab'.repeat(20);
  const ref = await buildPack([
    { type: TYPE.BLOB, data: te.encode('base-bytes') },
    { type: TYPE.BLOB, data: te.encode('delta-bytes'), baseOid: base },
  ]);
  const refScan = drive(ref.pack, packScanOpts(), 3);
  assert.equal(refScan.kind, 'ok');
  const refObjs = taken(refScan.pieces);
  assert.equal(refObjs[1].base.kind, 'oid');
  assert.equal(refObjs[1].base.oid, base);
  assert.equal(td.decode(refObjs[1].data), 'delta-bytes');

  const { root, cleanup } = tmpRoot();
  try {
    const sub = join(root, 's');
    mkdirSync(sub);
    git(sub, ['init', '-q', '-b', 'main']);
    writeFileSync(join(sub, 'a.txt'), 'hello-stream\n');
    writeFileSync(join(sub, 'b.txt'), 'other\n');
    git(sub, ['add', '-A']);
    git(sub, ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'c']);
    const packed = new Uint8Array(gitBuf(sub, ['pack-objects', '--window=0', '--all', '--stdout', '--revs'], 'HEAD\n'));
    const scanned = drive(packed, packScanOpts(), 1);
    assert.equal(scanned.kind, 'ok', scanned.kind === 'err' ? scanned.error.message : '');
    const objs = taken(scanned.pieces);
    const listed = git(sub, ['cat-file', '--batch-check', '--batch-all-objects']).trim().split('\n');
    assert.equal(objs.length, listed.length);
    for (const o of objs) {
      if (o.base.kind !== 'none') continue;
      const name = o.type === TYPE.COMMIT ? 'commit' : o.type === TYPE.TREE ? 'tree' : o.type === TYPE.BLOB ? 'blob' : 'tag';
      const oid = hashObject(name, o.data);
      assert.ok(Buffer.from(o.data).equals(gitBuf(sub, ['cat-file', name, oid])));
    }
    const packPath = join(root, 'p.pack');
    writeFileSync(packPath, packed);
    git(sub, ['index-pack', '--strict', packPath]);
  } finally { cleanup(); }
});

test('pack scan refusals are the three short signatures, the caps, and the trailer', () => {
  const limits = withLimits({ maxPackObjects: 4, maxObjectSize: 40, maxInflatedTotal: 4 });
  const short1 = parsePackEnd(must(parsePackInit(packScanOpts())));
  parsePackFeed(must(parsePackInit(packScanOpts())), new Uint8Array(4));
  const st1 = must(parsePackInit(packScanOpts()));
  parsePackFeed(st1, new Uint8Array(4));
  const bad1 = parsePackEnd(st1);
  assert.equal(bad1.ok, false);
  assert.equal(bad1.error.message, 'pack: bad signature');
  assert.equal(short1.ok, false);
  const st2 = must(parsePackInit(packScanOpts()));
  parsePackFeed(st2, new Uint8Array(PACK_HEADER_BYTES + 8));
  const bad2 = parsePackEnd(st2);
  assert.equal(bad2.ok, false);
  assert.equal(bad2.error.message, 'pack: bad signature');
  const st3 = must(parsePackInit(packScanOpts()));
  parsePackFeed(st3, new Uint8Array(PACK_HEADER_BYTES + PACK_TRAILER_BYTES));
  const bad3 = parsePackPull(st3);
  assert.equal(bad3.ok, false);
  assert.equal(bad3.error.message, 'pack: bad signature');

  const version = packHead(0);
  new DataView(version.buffer).setUint32(PACK_SIGNATURE.length, PACK_VERSION + 1);
  const stV = must(parsePackInit(packScanOpts()));
  parsePackFeed(stV, version);
  const badV = parsePackPull(stV);
  assert.equal(badV.ok, false);
  assert.equal(badV.error.message, `pack: unsupported version ${PACK_VERSION + 1}`);

  const counted = must(parsePackInit(packScanOpts(limits)));
  parsePackFeed(counted, packHead(5));
  const badC = parsePackPull(counted);
  assert.equal(badC.ok, false);
  assert.equal(badC.error.message, 'pack objects 5 exceeds limit 4');

  const typed = must(parsePackInit(packScanOpts()));
  parsePackFeed(typed, concat([packHead(1), Uint8Array.of(0)]));
  assert.equal(must(parsePackPull(typed)).kind, 'header');
  const badT = parsePackPull(typed);
  assert.equal(badT.ok, false);
  assert.equal(badT.error.message, 'pack: bad object type 0 at 12');

  const own = must(parsePackInit(packScanOpts()));
  parsePackFeed(own, concat([packHead(1), encodeObjHeader(TYPE.OFS_DELTA, 1), Uint8Array.of(0)]));
  assert.equal(must(parsePackPull(own)).kind, 'header');
  const badO = parsePackPull(own);
  assert.equal(badO.ok, false);
  assert.equal(badO.error.message, 'pack: ofs delta at 12 is its own base');

  const before = must(parsePackInit(packScanOpts()));
  parsePackFeed(before, concat([packHead(1), encodeObjHeader(TYPE.OFS_DELTA, 1), Uint8Array.of(1)]));
  assert.equal(must(parsePackPull(before)).kind, 'header');
  const badB = parsePackPull(before);
  assert.equal(badB.ok, false);
  assert.equal(badB.error.message, 'pack: ofs delta base before pack start at 12');

  const sized = must(parsePackInit(packScanOpts(limits)));
  parsePackFeed(sized, concat([packHead(1), encodeObjHeader(TYPE.BLOB, 50)]));
  assert.equal(must(parsePackPull(sized)).kind, 'header');
  const badS = parsePackPull(sized);
  assert.equal(badS.ok, false);
  assert.equal(badS.error.message, 'pack object size 50 exceeds limit 40');

  const body = packHead(0);
  const trailer = new Sha1().update(body).digest();
  const empty = concat([body, trailer]);
  const early = must(parsePackInit(packScanOpts()));
  parsePackFeed(early, body);
  assert.equal(must(parsePackPull(early)).kind, 'header');
  parsePackFeed(early, new Uint8Array(10));
  parsePackClose(early);
  const badE = parsePackPull(early);
  assert.equal(badE.ok, false);
  assert.equal(badE.error.message, `pack: expected trailer at ${PACK_HEADER_BYTES}, pack length ${PACK_HEADER_BYTES + 10}`);

  const flipped = empty.slice();
  flipped[flipped.length - 1] ^= 1;
  const mismatch = drive(flipped, packScanOpts(), flipped.length);
  assert.equal(mismatch.kind, 'err');
  assert.match(mismatch.error.message, /^pack: trailer sha mismatch /);

  const extra = must(parsePackInit(packScanOpts()));
  parsePackFeed(extra, empty);
  assert.equal(must(parsePackPull(extra)).kind, 'header');
  assert.equal(must(parsePackPull(extra)).kind, 'trailer');
  parsePackFeed(extra, Uint8Array.of(1));
  const badA = parsePackPull(extra);
  assert.equal(badA.ok, false);
  assert.match(badA.error.message, /^pack: expected trailer at /);
});

test('a truncated zlib member inside a pack is unexpected end, and the inflated total is charged up front', async () => {
  const { pack } = await buildPack([{ type: TYPE.BLOB, data: te.encode('abcd') }, { type: TYPE.BLOB, data: te.encode('ef') }]);
  const over = drive(pack, packScanOpts(withLimits({ maxInflatedTotal: 4 })), pack.length);
  assert.equal(over.kind, 'err');
  assert.equal(over.error.message, 'pack inflated bytes 6 exceeds limit 4');
  const cut = pack.subarray(0, pack.length - PACK_TRAILER_BYTES - 1);
  const trunc = drive(cut, packScanOpts(), cut.length);
  assert.equal(trunc.kind, 'err');
  assert.equal(trunc.error.code, 'pack_corrupt');
});

test('sideband demux copies the body, caps each band, and names a remote error', () => {
  const st = must(sidebandInit(withLimits({ maxPackBytes: 4 })));
  const flush = sidebandStep(st, { kind: 'flush' });
  assert.equal(flush.ok, false);
  assert.equal(flush.error.message, 'sideband: flush is not a sideband frame');
  const empty = sidebandStep(st, { kind: 'data', payload: new Uint8Array(0) });
  assert.equal(empty.ok, false);
  assert.equal(empty.error.message, 'short read: need 1 bytes at 0, have 0');
  const payload = Uint8Array.of(SIDEBAND_PACK, 1, 2);
  const pack = sidebandStep(st, { kind: 'data', payload });
  assert.equal(pack.ok, true);
  assert.equal(pack.value.piece.kind, 'pack');
  payload[1] = 9;
  assert.equal(pack.value.piece.body[0], 1);
  const exact = must(sidebandInit(withLimits({ maxPackBytes: 2 })));
  const filled = sidebandStep(exact, { kind: 'data', payload: Uint8Array.of(SIDEBAND_PACK, 1, 2) });
  assert.equal(filled.ok, true);
  assert.equal(filled.value.piece.kind, 'pack');
  const over = sidebandStep(pack.value.state, { kind: 'data', payload: Uint8Array.of(SIDEBAND_PACK, 1, 2, 3) });
  assert.equal(over.ok, false);
  assert.equal(over.error.message, 'pack bytes 5 exceeds limit 4');
  const progress = sidebandStep(st, { kind: 'data', payload: concat([Uint8Array.of(SIDEBAND_PROGRESS), te.encode('hi')]) });
  assert.equal(progress.ok, true);
  assert.equal(progress.value.piece.kind, 'progress');
  assert.equal(progress.value.piece.text, 'hi');
  assert.equal(progress.value.state.progress, 'hi');
  const progressRoom = must(sidebandInit(withLimits({ maxPackBytes: 2 })));
  const progressFull = sidebandStep(progressRoom, { kind: 'data', payload: concat([Uint8Array.of(SIDEBAND_PROGRESS), te.encode('hi')]) });
  assert.equal(progressFull.ok, true);
  const more = sidebandStep(st, { kind: 'data', payload: concat([Uint8Array.of(SIDEBAND_PROGRESS), te.encode('hello')]) });
  assert.equal(more.ok, false);
  assert.equal(more.error.message, 'progress bytes 5 exceeds limit 4');
  const euro = sidebandStep(st, { kind: 'data', payload: Uint8Array.of(SIDEBAND_PROGRESS, 0xe2) });
  assert.equal(euro.ok, true);
  const euro2 = sidebandStep(euro.value.state, { kind: 'data', payload: Uint8Array.of(SIDEBAND_PROGRESS, 0x82, 0xac) });
  assert.equal(euro2.ok, true);
  assert.equal(euro2.value.piece.text, '€');
  const remote = sidebandStep(st, { kind: 'data', payload: concat([Uint8Array.of(SIDEBAND_ERROR), te.encode('not our ref')]) });
  assert.equal(remote.ok, false);
  assert.equal(remote.error.code, 'remote_error');
  assert.equal(remote.error.reason, 'not_our_ref');
  assert.equal(remote.error.message, 'remote: not our ref');
  const other = sidebandStep(st, { kind: 'data', payload: concat([Uint8Array.of(SIDEBAND_ERROR), te.encode('fatal: boom')]) });
  assert.equal(other.ok, false);
  assert.equal(other.error.message, 'remote: fatal: boom');
  assert.notEqual(other.error.reason, 'not_our_ref');
  const prefixed = sidebandStep(st, { kind: 'data', payload: concat([Uint8Array.of(SIDEBAND_ERROR), te.encode('not our ref abc')]) });
  assert.equal(prefixed.ok, false);
  assert.equal(prefixed.error.reason, 'not_our_ref');
  const upload = sidebandStep(st, { kind: 'data', payload: concat([Uint8Array.of(SIDEBAND_ERROR), te.encode('upload-pack: not our ref abc')]) });
  assert.equal(upload.ok, false);
  assert.equal(upload.error.reason, 'not_our_ref');
  const uploadExact = sidebandStep(st, { kind: 'data', payload: concat([Uint8Array.of(SIDEBAND_ERROR), te.encode('upload-pack: not our ref')]) });
  assert.equal(uploadExact.ok, false);
  assert.equal(uploadExact.error.reason, 'not_our_ref');
  const spaced = sidebandStep(st, { kind: 'data', payload: concat([Uint8Array.of(SIDEBAND_ERROR), te.encode('fatal: boom\n')]) });
  assert.equal(spaced.ok, false);
  assert.equal(spaced.error.message, 'remote: fatal: boom');
  const roomy = must(sidebandInit(withLimits({ maxPackBytes: SIDEBAND_PROGRESS_KEEP + 64 })));
  const long = 'x'.repeat(SIDEBAND_PROGRESS_KEEP + 20);
  const tail = sidebandStep(roomy, { kind: 'data', payload: concat([Uint8Array.of(SIDEBAND_PROGRESS), te.encode(long)]) });
  assert.equal(tail.ok, true);
  assert.equal(tail.value.piece.text, long);
  assert.equal(tail.value.state.progress, long.slice(-512));
  const bad = sidebandStep(st, { kind: 'data', payload: Uint8Array.of(9) });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.message, 'sideband: bad sideband 9');
  const attrs = streamSidebandAttrs(euro2.value.state);
  assert.equal(typeof attrs['git.sideband.progress.tail'], 'string');
});

test('inflate pull yields a half-window chunk, and a second feed keeps bytes the first pull has not consumed', () => {
  assert.deepEqual(cappedBound(), { kind: 'capped', maxOutput: DEFAULT_LIMITS.maxObjectSize });
  assert.deepEqual(declaredBound(3, 5), { kind: 'declared', size: 3, maxOutput: 5 });
  assert.deepEqual(zlibWrap(false), { kind: 'zlib', verifyAdler: false });
  assert.deepEqual(rawWrap(), { kind: 'raw' });
  const badPack = parsePackInit(packScanOpts(withLimits({ maxPackObjects: Number.NaN })));
  assert.equal(badPack.ok, false);
  assert.equal(badPack.error.code, 'bad_request');
  const badTotal = parsePackInit(packScanOpts(withLimits({ maxInflatedTotal: Number.NaN })));
  assert.equal(badTotal.ok, false);
  assert.equal(badTotal.error.message, 'limits.maxInflatedTotal must be a finite non-negative number');
  const badSize = parsePackInit(packScanOpts(withLimits({ maxObjectSize: Number.NaN })));
  assert.equal(badSize.ok, false);
  assert.equal(badSize.error.message, 'limits.maxObjectSize must be a finite non-negative number');
  const unverified = must(parsePackInit(packScanOpts(DEFAULT_LIMITS, false)));
  assert.equal(unverified.hash.kind, 'off');
  assert.equal(unverified.baseRef.kind, 'none');
  assert.equal(unverified.inf.kind, 'closed');
  const held = new Uint8Array(4);
  const fresh = must(parsePackInit(packScanOpts()));
  parsePackFeed(fresh, held);
  assert.equal(fresh.carry.buffer, held.buffer);
  const badBand = sidebandInit(withLimits({ maxPackBytes: -1 }));
  assert.equal(badBand.ok, false);
  assert.equal(badBand.error.code, 'bad_request');

  const hello = te.encode('hello');
  const z = new Uint8Array(zlib.deflateSync(hello));
  const one = must(inflateInit(opts));
  const fed = z.slice();
  inflateFeed(one, fed);
  assert.equal(inflateUnread(one).buffer, fed.buffer);
  const pieces = [];
  for (;;) {
    const step = must(inflatePull(one));
    pieces.push(step.kind === 'chunk' ? step.bytes.length : step.kind);
    if (step.kind === 'end') break;
  }
  assert.deepEqual(pieces, [hello.length, 'end']);

  const big = Buffer.alloc(20_000, 7);
  const zb = new Uint8Array(zlib.deflateSync(big));
  const st = must(inflateInit({ bound: declaredBound(big.length), wrap: zlibWrap(true) }));
  const head = zb.subarray(0, zb.length - 1);
  inflateFeed(st, head);
  const first = must(inflatePull(st));
  assert.equal(first.kind, 'chunk');
  assert.equal(first.bytes.length, 16384);
  assert.ok(inflateUnread(st).length > 0);
  inflateFeed(st, zb.subarray(zb.length - 1));
  const rest = [first.bytes];
  for (;;) {
    const step = must(inflatePull(st));
    if (step.kind === 'chunk') rest.push(step.bytes);
    else {
      assert.equal(step.kind, 'end');
      assert.equal(step.consumed, zb.length);
      break;
    }
  }
  assert.equal(concat(rest).length, big.length);

  const dropped = must(inflateInit(opts));
  inflateFeed(dropped, z);
  inflateRelease(dropped);
  assert.equal(inflateUnread(dropped).length, 0);
  const waiting = inflatePull(dropped);
  assert.equal(waiting.ok, true);
  assert.equal(waiting.value.kind, 'need');
  const closed = inflateEnd(dropped);
  assert.equal(closed.ok, false);
  assert.equal(closed.error.message, 'short read: need 2 bytes at 0, have 0');
});
