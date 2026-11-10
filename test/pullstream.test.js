// The async-iterable adapters over the pull decoders (#241, src/pullstream.ts): scanPack, pktFrames, inflateChunks.
//   - identical items to the pull API over every chunking (whole, one byte at a time, seeded random cuts), from a
//     ReadableStream and from an AsyncIterable
//   - a break, a throw in the loop body and reader.cancel() cancel the source (cancel(reason) / return() observed)
//   - a refusal errors the stream with the decoder's typed PlyError and cancels the source; malformed input of every
//     kind each decoder refuses; a source that errors errors the stream with its own error; a chunk that is not bytes
//   - backpressure: the source is read one chunk per need and never ahead; a consumer that stops stops the reads
// Memory (the adapters hold the decoders' bound) is measured in test/stream-memory.test.js (scan-iter, inflate-iter).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { Rng, splitRandom } from './fuzz/prng.js';
import { concat, te } from '../src/bytes.js';
import { pkt, pktInit, pktStep, pktFinish, FLUSH, DELIM } from '../src/pktline.js';
import { buildPack, makeDelta } from '../src/pack.js';
import { inflateInit, inflateFeed, inflatePull, inflateEnd, cappedBound, declaredBound, zlibWrap, rawWrap } from '../src/inflatestream.js';
import { parsePackInit, parsePackFeed, parsePackPull, parsePackEnd, WORK_BUDGET } from '../src/packstream.js';
import { scanPack, pktFrames, inflateChunks } from '../src/pullstream.js';
import * as index from '../src/index.js';
import { isPlyError } from '../src/errors.js';
import { hashObject, TYPE } from '../src/objects.js';
import { withLimits } from '../src/limits.js';
import { unwrap } from './unwrap.js';

// ---- sources
// A ReadableStream over `chunks` that records every pull and its cancel; highWaterMark 0, so a pull is a read.
function recorded(chunks) {
  const log = { pulls: 0, cancelled: [], closed: false };
  let i = 0;
  const stream = new ReadableStream({
    pull(c) { log.pulls += 1; if (i < chunks.length) c.enqueue(chunks[i++]); else { log.closed = true; c.close(); } },
    cancel(why) { log.cancelled.push(why); },
  }, { highWaterMark: 0 });
  return { stream, log };
}
// An AsyncIterable over `chunks` that records next() and return().
function iterable(chunks) {
  const log = { nexts: 0, returned: 0 };
  return {
    log,
    source: {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          async next() { log.nexts += 1; return i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }; },
          async return() { log.returned += 1; return { done: true, value: undefined }; },
        };
      },
    },
  };
}
const chunkings = bytes => {
  const out = [['whole', [bytes]], ['bytes', Array.from(bytes, b => Uint8Array.of(b))]];
  for (const seed of [1, 2, 3, 20261110]) out.push([`random ${seed}`, splitRandom(new Rng(seed), bytes, { maxChunks: 64 })]);
  return out;
};
async function collect(stream) { const out = []; for await (const x of stream) out.push(x); return out; }
async function failure(stream) {
  const seen = [];
  try { for await (const x of stream) seen.push(x); } catch (e) { return { e, seen }; }
  return assert.fail(`no error after ${seen.length} items`);
}
const ply = (e, code) => { assert.ok(isPlyError(e), `not a PlyError: ${e}`); assert.equal(e.code, code, e.message); };
const copy = p => (p.kind === 'chunk' ? { ...p, bytes: Uint8Array.from(p.bytes) } : p);

// ---- the reference drivers: the pull API, by hand
function pullPack(chunks, opts) {
  const st = unwrap(parsePackInit(opts));
  const out = [];
  const drain = p => { for (;;) { const r = p ?? parsePackPull(st); p = undefined; if (!r.ok) return r.error; if (r.value.kind === 'need') return null; if (r.value.kind === 'end') return 'end'; out.push(copy(r.value)); } };
  for (const c of chunks) { parsePackFeed(st, c); const d = drain(); if (d !== null) return { out, end: d }; }
  return { out, end: drain(parsePackEnd(st)) };
}
function pullPkt(chunks) {
  let st = pktInit();
  const out = [];
  for (const c of chunks) { const r = pktStep(st, c); if (!r.ok) return { out, end: r.error }; st = r.value.state; out.push(...r.value.frames); }
  const f = pktFinish(st);
  return { out, end: f.ok ? 'end' : f.error };
}

// ---- a pack with every kind of piece: whole objects, an OFS and a REF delta, a large blob of several chunks
const blob = n => Uint8Array.from({ length: n }, (_, i) => (i * 7 + (i >> 8)) & 255);
async function samplePack() {
  const base = te.encode('line\n'.repeat(400));
  const next = te.encode('line\n'.repeat(399) + 'changed\n');
  const big = blob(80_000);
  return (await buildPack([
    { type: TYPE.BLOB, data: base },
    { type: TYPE.BLOB, data: makeDelta(base, next).delta, base: { tag: 'ofs', index: 0 } },
    { type: TYPE.BLOB, data: big },
    { type: TYPE.BLOB, data: makeDelta(base, te.encode('x')).delta, base: { tag: 'ref', oid: hashObject('blob', base) } },
    { type: TYPE.COMMIT, data: te.encode('tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor a <a@x> 1 +0000\ncommitter a <a@x> 1 +0000\n\nm\n') },
  ])).pack;
}

test('scanPack: the same pieces as the pull API over every chunking, from a ReadableStream and an AsyncIterable', async () => {
  const pack = await samplePack();
  for (const [name, chunks] of chunkings(pack)) {
    const want = pullPack(chunks, { verify: true, limits: withLimits({}) });
    assert.equal(want.end, 'end', name);
    const kinds = new Set(want.out.map(p => p.kind));
    assert.deepEqual([...kinds].sort(), ['chunk', 'header', 'object', 'object-end', 'trailer'], name);
    const fromStream = (await collect(scanPack(recorded(chunks).stream))).map(copy);
    const fromIter = (await collect(scanPack(iterable(chunks).source))).map(copy);
    assert.deepEqual(fromStream, want.out, `${name}: stream`);
    assert.deepEqual(fromIter, want.out, `${name}: iterable`);
    assert.ok(!fromStream.some(p => p.kind === 'need' || p.kind === 'end'), 'need and end are never items');
  }
});

test('scanPack: options reach the scan (WORK_BUDGET reads a blob past maxObjectSize; verify off skips the trailer check)', async () => {
  const pack = await samplePack();
  const tight = withLimits({ maxObjectSize: 1024 });
  ply((await failure(scanPack(recorded([pack]).stream, { limits: tight }))).e, 'limit_exceeded');
  const worked = await collect(scanPack(recorded([pack]).stream, { limits: tight, budget: WORK_BUDGET }));
  assert.equal(worked.filter(p => p.kind === 'object-end').length, 5);
  const bad = Uint8Array.from(pack); bad[bad.length - 1] ^= 1;
  ply((await failure(scanPack(recorded([bad]).stream))).e, 'pack_corrupt');
  assert.equal((await collect(scanPack(recorded([bad]).stream, { verify: false }))).at(-1).kind, 'trailer');
});

test('scanPack: every refusal is the pull API\'s, typed, after the pieces before it; the source is cancelled with it', async () => {
  const pack = await samplePack();
  const flip = (at) => { const b = Uint8Array.from(pack); b[at] ^= 0xff; return b; };
  const cases = [
    ['bad signature', flip(0), 'pack_corrupt'],
    ['bad version', flip(7), 'pack_corrupt'],
    ['truncated', pack.subarray(0, pack.length - 30), 'pack_corrupt'],
    ['trailer', flip(pack.length - 1), 'pack_corrupt'],
    ['corrupt member', flip(40), 'pack_corrupt'],
    ['empty', new Uint8Array(0), 'pack_corrupt'],
    ['too many objects', pack, 'limit_exceeded', withLimits({ maxPackObjects: 2 })],
    ['inflated total', pack, 'limit_exceeded', withLimits({ maxInflatedTotal: 10_000 })],
  ];
  for (const [name, bytes, code, limits] of cases) {
    for (const [cut, chunks] of chunkings(bytes).slice(0, 3)) {
      const want = pullPack(chunks, { verify: true, limits: limits ?? withLimits({}) });
      assert.notEqual(want.end, 'end', `${name} ${cut}: the pull API refuses`);
      const { stream, log } = recorded(chunks);
      const { e, seen } = await failure(scanPack(stream, limits ? { limits } : {}));
      ply(e, code);
      assert.equal(e.message, want.end.message, `${name} ${cut}`);
      assert.deepEqual(seen.map(copy), want.out, `${name} ${cut}: the pieces before the refusal`);
      if (!log.closed) assert.deepEqual(log.cancelled, [e], `${name} ${cut}: the source is cancelled with the refusal`);
    }
  }
});

test('scanPack: bad options error the stream on the first read and cancel the source', async () => {
  const { stream, log } = recorded([new Uint8Array(1)]);
  const { e } = await failure(scanPack(stream, { limits: { maxPackObjects: -1 } }));
  ply(e, 'bad_request');
  assert.deepEqual(log.cancelled, [e]);
  assert.equal(log.pulls, 0, 'nothing was read');
  const { e: e2 } = await failure(scanPack(recorded([]).stream, { budget: { tag: 'work', ratio: Number.NaN, capObjects: false } }));
  ply(e2, 'bad_request');
});

test('a source that errors errors the stream with its own error (all three adapters, both source kinds)', async () => {
  const boom = new Error('source died');
  const pack = await samplePack();
  const make = first => [
    () => new ReadableStream({ start(c) { c.enqueue(first); }, pull(c) { c.error(boom); } }),
    () => ({ [Symbol.asyncIterator]() { let n = 0; return { async next() { if (n++ === 0) return { done: false, value: first }; throw boom; } }; } }),
  ];
  for (const [adapter, first] of [[scanPack, pack.subarray(0, 40)], [pktFrames, unwrap(pkt('a\n'))], [inflateChunks, zlib.deflateSync(blob(100)).subarray(0, 10)]]) {
    for (const src of make(first)) {
      const { e } = await failure(adapter(src()));
      assert.equal(e, boom, `${adapter.name}: the source's own error`);
    }
  }
});

test('a chunk that is not a Uint8Array is bad_request (string, array, ArrayBuffer), and the source is cancelled', async () => {
  for (const adapter of [scanPack, pktFrames, inflateChunks]) {
    for (const junk of ['PACK', [1, 2, 3], new ArrayBuffer(4), 7]) {
      const { stream, log } = recorded([junk]);
      const { e } = await failure(adapter(stream));
      ply(e, 'bad_request');
      assert.match(e.message, /not a Uint8Array/);
      assert.deepEqual(log.cancelled, [e], `${adapter.name} ${typeof junk}`);
    }
  }
});

test('break, a throw in the loop body, and reader.cancel() cancel the source; iteration after that is over', async () => {
  const pack = await samplePack();
  const frames = concat([unwrap(pkt('a\n')), unwrap(pkt('b\n')), FLUSH]);
  const member = zlib.deflateSync(blob(200_000));
  for (const [adapter, bytes] of [[scanPack, pack], [pktFrames, frames], [inflateChunks, member]]) {
    const chunks = splitRandom(new Rng(9), bytes, { maxChunks: 16, allowEmpty: false });
    // break after the first item
    { const { stream, log } = recorded(chunks); let n = 0; for await (const _ of adapter(stream)) { n++; break; } assert.equal(n, 1); assert.equal(log.cancelled.length, 1, `${adapter.name}: break`); assert.ok(log.pulls < chunks.length + 1, 'not read to the end'); }
    // a throw in the body
    { const { stream, log } = recorded(chunks); const oops = new Error('body'); await assert.rejects((async () => { for await (const _ of adapter(stream)) throw oops; })(), e => e === oops); assert.equal(log.cancelled.length, 1, `${adapter.name}: throw`); }
    // AsyncIterable source: return() is called
    { const { source, log } = iterable(chunks); for await (const _ of adapter(source)) break; assert.equal(log.returned, 1, `${adapter.name}: iterable return()`); }
    // reader.cancel(reason) passes the reason through, and the stream reads done after it
    { const { stream, log } = recorded(chunks); const s = adapter(stream); const r = s.getReader(); assert.equal((await r.read()).done, false); const why = new Error('stop'); await r.cancel(why); assert.deepEqual(log.cancelled, [why]); assert.equal((await r.read()).done, true); }
    // cancel before any read: the source is cancelled without being read
    { const { stream, log } = recorded(chunks); await adapter(stream).cancel('early'); assert.deepEqual(log.cancelled, ['early']); assert.equal(log.pulls, 0); }
  }
});

test('a cancel while a read of the source is out: the read\'s chunk is not decoded and nothing is enqueued after', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  let cancelled = 0;
  const stream = new ReadableStream({ async pull(c) { await gate; c.enqueue(unwrap(pkt('late\n'))); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
  const r = pktFrames(stream).getReader();
  const pending = r.read();
  await new Promise(res => setTimeout(res, 10));
  await r.cancel('stop');
  release();
  assert.equal((await pending).done, true);
  assert.equal(cancelled, 1);
});

test('backpressure: one source read per need, none ahead; a consumer that stops reading stops the reads', async () => {
  const pack = await samplePack();
  const bytes1 = Array.from(pack, b => Uint8Array.of(b));
  const { stream, log } = recorded(bytes1);
  const r = scanPack(stream).getReader();
  const header = await r.read();
  assert.equal(header.value.kind, 'header');
  // the scan decides the header on 32 bytes (a header and a trailer's worth, as parsePack): exactly that many reads
  assert.equal(log.pulls, 32);
  await new Promise(res => setTimeout(res, 30));
  assert.equal(log.pulls, 32, 'no read while nobody reads');
  const object = await r.read();
  assert.equal(object.value.kind, 'object');
  assert.ok(log.pulls <= 34, `the first object header: ${log.pulls} reads`);
  // pkt-lines: a frame read a byte at a time is read to its last byte and no further
  const two = concat([unwrap(pkt('x'.repeat(1000))), unwrap(pkt('y'))]);
  const p = recorded(Array.from(two, b => Uint8Array.of(b)));
  const pr = pktFrames(p.stream).getReader();
  assert.equal((await pr.read()).value.payload.length, 1000);
  assert.equal(p.log.pulls, 1004);
  await pr.cancel();
  // inflate: a 1 MiB member fed in 4 KiB chunks, the consumer takes one chunk: the reads stop at what one chunk needed
  const member = zlib.deflateSync(blob(1 << 20), { level: 0 });
  const m = recorded(Array.from({ length: Math.ceil(member.length / 4096) }, (_, i) => member.subarray(i * 4096, (i + 1) * 4096)));
  const mr = inflateChunks(m.stream).getReader();
  await mr.read();
  assert.ok(m.log.pulls <= 6, `one 16 KiB chunk out: ${m.log.pulls} 4 KiB reads`);
  await mr.cancel();
});

test('a byte at a time across a 65,516-byte pkt-line: no per-need hold (the reads run as fresh rounds)', async () => {
  const big = unwrap(pkt(new Uint8Array(65_516).fill(97)));
  const frames = await collect(pktFrames(recorded([...Array.from(big, b => Uint8Array.of(b)), FLUSH]).stream));
  assert.deepEqual(frames.map(f => f.kind), ['data', 'flush']);
  assert.equal(frames[0].payload.length, 65_516);
});

test('pktFrames: the same frames as pktStep over every chunking; data, flush, delim, response-end', async () => {
  const wire = concat([unwrap(pkt('version 2\n')), DELIM, unwrap(pkt(new Uint8Array(3000).fill(1))), FLUSH, te.encode('0002'), unwrap(pkt('done'))]);
  for (const [name, chunks] of chunkings(wire)) {
    const want = pullPkt(chunks);
    assert.equal(want.end, 'end');
    assert.deepEqual(await collect(pktFrames(recorded(chunks).stream)), want.out, name);
    assert.deepEqual(await collect(pktFrames(iterable(chunks).source)), want.out, name);
  }
});

test('pktFrames: malformed input is pktStep\'s protocol refusal (bad hex, 0003, past LARGE_PACKET_MAX, cut inside a frame)', async () => {
  const good = unwrap(pkt('ok\n'));
  const cases = [
    ['bad hex', concat([good, te.encode('00zz')])],
    ['0003', concat([good, te.encode('0003')])],
    ['too long', concat([good, te.encode('fff5'), new Uint8Array(65_520)])],
    ['cut in a payload', concat([good, te.encode('000aab')])],
    ['cut in a length', concat([good, te.encode('00')])],
  ];
  for (const [name, bytes] of cases) {
    for (const [cut, chunks] of chunkings(bytes).slice(0, 3)) {
      const want = pullPkt(chunks);
      assert.notEqual(want.end, 'end', name);
      const { stream, log } = recorded(chunks);
      const { e, seen } = await failure(pktFrames(stream));
      ply(e, 'protocol');
      assert.equal(e.message, want.end.message, `${name} ${cut}`);
      assert.deepEqual(seen, want.out, `${name} ${cut}`);
      if (!log.closed) assert.deepEqual(log.cancelled, [e]);
    }
  }
});

test('inflateChunks: the output zlib inflates to, over every chunking; zlib and raw, capped and declared', async () => {
  const data = concat([blob(70_000), te.encode('tail '.repeat(5000))]);
  const variants = [
    ['zlib capped', zlib.deflateSync(data), {}],
    ['zlib stored', zlib.deflateSync(data, { level: 0 }), {}],
    ['zlib declared', zlib.deflateSync(data, { level: 9 }), { bound: declaredBound(data.length) }],
    ['raw', zlib.deflateRawSync(data), { wrap: rawWrap(), bound: cappedBound() }],
    ['empty', zlib.deflateSync(new Uint8Array(0)), {}],
  ];
  for (const [name, member, opts] of variants) {
    const want = name === 'empty' ? new Uint8Array(0) : data;
    for (const [cut, chunks] of chunkings(member)) {
      if (cut === 'bytes' && member.length > 20_000) continue;
      const out = await collect(inflateChunks(recorded(chunks).stream, opts));
      assert.deepEqual(Buffer.from(concat(out)), Buffer.from(want), `${name} ${cut}`);
      assert.ok(out.every(c => c.length <= 16_384), 'chunks of at most INFLATE_CHUNK');
      assert.deepEqual(Buffer.from(concat(await collect(inflateChunks(iterable(chunks).source, opts)))), Buffer.from(want), `${name} ${cut}: iterable`);
    }
  }
  // a member fed one byte at a time, the slow path
  const small = zlib.deflateSync(te.encode('hello, '.repeat(300)));
  assert.equal(new TextDecoder().decode(concat(await collect(inflateChunks(recorded(Array.from(small, b => Uint8Array.of(b))).stream)))), 'hello, '.repeat(300));
});

test('inflateChunks: corrupt, truncated, trailing, oversized and mis-declared members are typed refusals', async () => {
  const data = blob(50_000);
  const member = zlib.deflateSync(data);
  const flip = at => { const b = Uint8Array.from(member); b[at] ^= 0xff; return b; };
  const cases = [
    ['bad header', flip(0), 'pack_corrupt', {}],
    ['bad adler', flip(member.length - 1), 'pack_corrupt', {}],
    ['truncated', member.subarray(0, member.length - 5), 'pack_corrupt', {}],
    ['empty', new Uint8Array(0), 'pack_corrupt', {}],
    ['trailing byte, same chunk', concat([member, Uint8Array.of(0)]), 'pack_corrupt', {}],
    ['trailing member', concat([member, member]), 'pack_corrupt', {}],
    ['past maxOutput', member, 'limit_exceeded', { bound: cappedBound(10_000) }],
    ['declared shorter', member, 'pack_corrupt', { bound: declaredBound(1000) }],
    ['declared longer', member, 'pack_corrupt', { bound: declaredBound(60_000) }],
  ];
  for (const [name, bytes, code, opts] of cases) {
    for (const [cut, chunks] of chunkings(bytes).slice(0, 3)) {
      if (cut === 'bytes' && bytes.length > 2000) continue;
      const { stream, log } = recorded(chunks);
      const { e } = await failure(inflateChunks(stream, opts));
      ply(e, code);
      if (!log.closed) assert.deepEqual(log.cancelled, [e], `${name} ${cut}`);
    }
  }
  // a trailing byte in a later chunk than the member's end
  const { e } = await failure(inflateChunks(recorded([member, Uint8Array.of(1)]).stream));
  ply(e, 'pack_corrupt');
  assert.match(e.message, /1 bytes after the end/);
  // empty chunks after the end are not bytes after it
  assert.equal(concat(await collect(inflateChunks(recorded([member, new Uint8Array(0), new Uint8Array(0)]).stream))).length, data.length);
  // bad options: the stream errors on the first read
  ply((await failure(inflateChunks(recorded([member]).stream, { bound: cappedBound(-1) }))).e, 'bad_request');
});

test('inflateChunks agrees with the pull API on the same member (same chunks, byte for byte)', async () => {
  const member = zlib.deflateSync(blob(100_000));
  const st = unwrap(inflateInit({ bound: cappedBound(), wrap: zlibWrap(true) }));
  const want = [];
  inflateFeed(st, member);
  for (let p = unwrap(inflatePull(st)); p.kind !== 'end'; p = unwrap(p.kind === 'need' ? inflateEnd(st) : inflatePull(st))) if (p.kind === 'chunk') want.push(p.bytes);
  assert.deepEqual(await collect(inflateChunks(recorded([member]).stream)), want);
});

test('the adapters are exported from the package root', () => {
  assert.equal(index.scanPack, scanPack);
  assert.equal(index.pktFrames, pktFrames);
  assert.equal(index.inflateChunks, inflateChunks);
});
