// The streamed pack writer (src/packwrite.ts, #172): two deflate passes, never a held pack. Pure: no server.
//   pass 1 (measurePack) and pass 2 (streamPack) write the same bytes, and those are buildPack's (the buffered writer)
//   a pack pass 1 can keep (<= keep bytes) is held; a larger one is not
//   pass 2 refuses to finish a pack that is not pass 1's: longer, shorter, or the same length with other bytes. The
//   trailer is never written then, and never more than pass 1's length
//   deflatePull feeds INFLATE_CHUNK slices and stops when its reader stops
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { randomFillSync } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { measurePack, streamPack, deflatePull } from '../src/packwrite.js';
import { buildPack, parsePack, resolvePack } from '../src/pack.js';
import { TYPE } from '../src/objects.js';
import { INFLATE_CHUNK, PACK_HEADER_BYTES, PACK_TRAILER_BYTES } from '../src/format.js';
import { Sha1 } from '../src/sha1.js';
import { unwrap } from './unwrap.js';

const fill = (n, kind) => {
  const d = new Uint8Array(n);
  if (kind === 'random') randomFillSync(d);
  if (kind === 'text') for (let i = 0; i < n; i++) d[i] = 97 + ((i * 7) % 13);
  return d;
};
const readAll = async (stream) => {
  const parts = []; const reader = stream.getReader();
  for (;;) { const r = await reader.read(); if (r.done) break; parts.push(r.value); }
  return Buffer.concat(parts);
};
// what a stream yields before it errors, and the error
const readUntilError = async (stream) => {
  const parts = []; const reader = stream.getReader();
  try { for (;;) { const r = await reader.read(); if (r.done) return { bytes: Buffer.concat(parts), error: null }; parts.push(r.value); } }
  catch (e) { return { bytes: Buffer.concat(parts), error: e }; }
};
const prefix = Uint8Array.of(1, 2, 3);

test('both passes write buildPack\'s bytes, for every size around the chunk and every kind of content', async () => {
  for (const n of [0, 1, 100, INFLATE_CHUNK - 1, INFLATE_CHUNK, INFLATE_CHUNK + 1, 3 * INFLATE_CHUNK + 7, 1 << 20]) {
    for (const kind of ['random', 'zero', 'text']) {
      const d = fill(n, kind);
      const objects = [{ type: TYPE.BLOB, data: d }, { type: TYPE.BLOB, data: d.subarray(0, n >> 1) }, { type: TYPE.TREE, data: fill(40, 'text') }];
      const built = await buildPack(objects);
      const m = await measurePack(objects, 0);
      assert.equal(m.held, null, `${n} ${kind}: keep 0 holds nothing`);
      assert.equal(m.bytes, built.pack.length, `${n} ${kind}`);
      assert.equal(m.body, built.pack.length - PACK_TRAILER_BYTES);
      assert.deepEqual(m.entries, built.entries, `${n} ${kind}`);
      assert.deepEqual(Buffer.from(m.digest), Buffer.from(built.pack.subarray(built.pack.length - PACK_TRAILER_BYTES)));
      const s = streamPack(m, prefix);
      assert.equal(s.length, prefix.length + built.pack.length);
      const got = await readAll(s.stream);
      assert.deepEqual(got, Buffer.concat([prefix, built.pack]), `${n} ${kind}`);
      assert.equal(s.failure(), null);
    }
  }
});

test('pass 2 is the same bytes every time (CompressionStream is deterministic for the same slices)', async () => {
  const objects = [{ type: TYPE.BLOB, data: fill(5 * INFLATE_CHUNK + 3, 'random') }, { type: TYPE.BLOB, data: fill(9 * INFLATE_CHUNK, 'text') }];
  const m = await measurePack(objects, 0);
  const a = await readAll(streamPack(m, prefix).stream);
  const b = await readAll(streamPack(m, prefix).stream);
  assert.deepEqual(a, b);
  assert.equal(new Sha1().update(a.subarray(prefix.length, a.length - PACK_TRAILER_BYTES)).hex(), Buffer.from(m.digest).toString('hex'));
});

test('deltas: OFS and REF bases as buildPack writes them (one entry encoder, pack.ts entryHead), and the pack resolves', async () => {
  const base = fill(3000, 'text');
  const objects = [
    { type: TYPE.BLOB, data: base },
    { type: TYPE.BLOB, data: Uint8Array.of(0xb8, 0x17, 0xb8, 0x17, 0x91, 0, 0xb8, 0x17), base: { tag: 'ofs', index: 0 } }, // copy all 3000 bytes
    { type: TYPE.BLOB, data: Uint8Array.of(1, 1, 1, 0x61), base: { tag: 'ref', oid: 'ab'.repeat(20) } },
    { type: TYPE.BLOB, data: fill(10, 'text'), base: { tag: 'none' } },
    { type: TYPE.BLOB, data: fill(10, 'zero'), base: undefined }, // left out: none
    { type: TYPE.BLOB, data: Uint8Array.of(0xb8, 0x17, 0xb8, 0x17, 0x91, 0, 0xb8, 0x17), base: { tag: 'ofs', index: 1 } },
  ];
  const built = await buildPack(objects);
  const m = await measurePack(objects, 0);
  assert.deepEqual(m.entries, built.entries);
  assert.deepEqual(m.entries.map(e => [e.type, e.typeName, e.baseOid]), [[TYPE.BLOB, 'blob', null], [TYPE.OFS_DELTA, 'ofs_delta', null], [TYPE.REF_DELTA, 'ref_delta', 'ab'.repeat(20)], [TYPE.BLOB, 'blob', null], [TYPE.BLOB, 'blob', null], [TYPE.OFS_DELTA, 'ofs_delta', null]]);
  const got = await readAll(streamPack(m, new Uint8Array(0)).stream);
  assert.deepEqual(got, Buffer.from(built.pack));
  const parsed = unwrap(parsePack(new Uint8Array(got)));
  assert.equal(parsed.objects.length, 6);
  // each base as the reader reads it back: the OFS distance names the entry it was given, the REF id as given
  assert.deepEqual(parsed.objects.map(o => o.base), [{ tag: 'none' }, { tag: 'ofs', offset: built.entries[0].offset }, { tag: 'ref', oid: 'ab'.repeat(20) }, { tag: 'none' }, { tag: 'none' }, { tag: 'ofs', offset: built.entries[1].offset }]);
});

test('an unknown type id is written as given, with no type name (buildPack\'s typeNameOf)', async () => {
  const m = await measurePack([{ type: 5, data: fill(3, 'text') }], 0);
  assert.deepEqual([m.entries[0].type, m.entries[0].typeName], [5, null]);
});

test('pass 1 holds the pack exactly when it fits in keep (default INFLATE_CHUNK)', async () => {
  const small = [{ type: TYPE.BLOB, data: fill(100, 'text') }];
  const m = await measurePack(small);
  const built = await buildPack(small);
  assert.deepEqual(Buffer.from(m.held), Buffer.from(built.pack));
  // a keep of exactly the pack's length holds it; one less does not
  assert.notEqual((await measurePack(small, built.pack.length)).held, null);
  assert.equal((await measurePack(small, built.pack.length - 1)).held, null);
  // an empty pack is 32 bytes and is held
  const empty = await measurePack([]);
  assert.equal(empty.bytes, PACK_HEADER_BYTES + PACK_TRAILER_BYTES);
  assert.deepEqual(Buffer.from(empty.held), Buffer.from((await buildPack([])).pack));
  // an incompressible object past the chunk is not held by default
  const big = await measurePack([{ type: TYPE.BLOB, data: fill(INFLATE_CHUNK, 'random') }]);
  assert.equal(big.held, null);
  assert.ok(big.bytes > INFLATE_CHUNK);
});

test('pass 2 refuses a pack that is not pass 1\'s, before its trailer and never past pass 1\'s length', async () => {
  // the caller's object changes between the passes: same length, other bytes (the SHA-1 differs)
  const same = fill(3 * INFLATE_CHUNK, 'random');
  const m1 = await measurePack([{ type: TYPE.BLOB, data: same }], 0);
  same[7] ^= 1;
  const s1 = streamPack(m1, prefix);
  const r1 = await readUntilError(s1.stream);
  assert.equal(r1.error?.code, 'internal');
  assert.equal(r1.error, s1.failure());
  assert.match(r1.error.message, /second deflate pass wrote another pack; it was not sent whole/);
  assert.equal(r1.bytes.length, prefix.length + m1.body, 'every byte but the trailer');
  assert.deepEqual([r1.error.what, r1.error.got, r1.error.max], ['push pack', m1.body, m1.body]);
  assert.equal(Object.hasOwn(r1.error, 'cause'), false, 'a refusal of its own has no cause');

  // compressible at pass 1, incompressible at pass 2: longer. Refused on the chunk that would pass pass 1's length
  const grows = fill(8 * INFLATE_CHUNK, 'zero');
  const m2 = await measurePack([{ type: TYPE.BLOB, data: grows }], 0);
  randomFillSync(grows);
  const s2 = streamPack(m2, prefix);
  const r2 = await readUntilError(s2.stream);
  assert.match(r2.error.message, /ran longer than the first/);
  assert.ok(r2.bytes.length <= prefix.length + m2.body, `${r2.bytes.length} <= ${prefix.length + m2.body}`);
  assert.ok(s2.failure().got > m2.body);

  // the other way: shorter
  const shrinks = fill(8 * INFLATE_CHUNK, 'random');
  const m3 = await measurePack([{ type: TYPE.BLOB, data: shrinks }], 0);
  shrinks.fill(0);
  const r3 = await readUntilError(streamPack(m3, prefix).stream);
  assert.match(r3.error.message, /ran shorter than the first/);
  assert.ok(r3.bytes.length < prefix.length + m3.body);

  // a pack whose objects did not change is not refused, and the failure stays null
  const s4 = streamPack(m3, prefix);
  assert.equal(s4.failure(), null);
});

test('pass 2 records a deflate that fails as its failure, with the cause', async () => {
  const m = await measurePack([{ type: TYPE.BLOB, data: fill(10, 'text') }], 0);
  // an object whose data is not bytes any more: CompressionStream refuses the chunk
  const broken = { ...m, objects: [{ type: TYPE.BLOB, data: { length: 10, buffer: new ArrayBuffer(10), subarray: () => { throw new Error('not bytes'); } } }] };
  const s = streamPack(broken, prefix);
  const r = await readUntilError(s.stream);
  assert.equal(r.error.code, 'internal');
  assert.match(r.error.message, /second deflate pass failed/);
  assert.ok(r.error.cause instanceof Error);
  assert.equal(r.error, s.failure());
  assert.deepEqual(r.bytes.subarray(0, prefix.length), Buffer.from(prefix));
  assert.ok(r.bytes.length < prefix.length + m.bytes, 'no trailer');
});

test('the prefix comes first, alone, and the stream reads nothing ahead', async () => {
  const objects = [{ type: TYPE.BLOB, data: fill(4 * INFLATE_CHUNK, 'random') }];
  const m = await measurePack(objects, 0);
  const s = streamPack(m, prefix);
  const reader = s.stream.getReader();
  const first = await reader.read();
  assert.deepEqual(Buffer.from(first.value), Buffer.from(prefix));
  const second = await reader.read();
  assert.equal(second.value.length, PACK_HEADER_BYTES, 'then the pack header');
  await reader.cancel();
  assert.equal(s.failure(), null, 'a cancel is not a failure');
});

test('deflatePull: a zlib stream of the object, chunk by chunk; a reader that stops stops it', async () => {
  for (const n of [0, 5, INFLATE_CHUNK * 3 + 1]) {
    const d = fill(n, 'random');
    const parts = [];
    for await (const z of deflatePull(d)) parts.push(z);
    assert.deepEqual(new Uint8Array(inflateSync(Buffer.concat(parts))), d, `${n}`);
  }
  const it = deflatePull(fill(64 * INFLATE_CHUNK, 'random'));
  const one = await it.next();
  assert.equal(one.done, false);
  const done = await it.return();
  assert.equal(done.done, true);
  assert.equal((await it.next()).done, true);
});

test('a pack streamed through resolvePack is the objects given', async () => {
  const objects = [{ type: TYPE.BLOB, data: fill(2 * INFLATE_CHUNK + 9, 'text') }, { type: TYPE.COMMIT, data: fill(200, 'text') }];
  const got = await readAll(streamPack(await measurePack(objects, 0), new Uint8Array(0)).stream);
  const resolved = unwrap(resolvePack(unwrap(parsePack(new Uint8Array(got)))));
  assert.deepEqual([...resolved.objects.values()].map(o => Buffer.from(o.data)).sort(Buffer.compare), objects.map(o => Buffer.from(o.data)).sort(Buffer.compare));
});

// push over a transport double that reads the body as receive-pack would and answers git's report (no side-band):
// which body it got, and what push decided.
import { push } from '../src/push.js';
import { pkt, FLUSH, pktInit, pktStep } from '../src/pktline.js';
import { withLimits } from '../src/limits.js';

const spanStub = { set() {}, event() {}, error() {} };
const reportFor = ref => Buffer.concat([unwrap(pkt('unpack ok\n')), unwrap(pkt(`ok ${ref}\n`)), FLUSH]);
const doubleTransport = (limits = {}) => {
  const t = {
    limits: withLimits(limits), tracer: { span: async (_n, _o, fn) => fn(spanStub) }, parent: null, got: [],
    async *frames(_service, body) {
      const streamed = !(body instanceof Uint8Array);
      const read = streamed ? await readUntilError(body.stream) : { bytes: Buffer.from(body), error: null };
      t.got.push({ streamed, length: body.length, read: read.bytes.length, error: read.error });
      yield* unwrap(pktStep(pktInit(), reportFor('refs/heads/main'))).frames;
    },
  };
  return t;
};
const oid = c => c.repeat(40);

test('push: a pack past INFLATE_CHUNK goes to the transport as a stream of the declared length; a small one as bytes', async () => {
  for (const [size, streamed] of [[100, false], [4 * INFLATE_CHUNK, true]]) {
    const t = doubleTransport();
    const r = await push(t, { ref: 'refs/heads/main', oldOid: oid('0'), newOid: oid('a'), objects: [{ type: TYPE.BLOB, data: fill(size, 'random') }], sideband: false });
    assert.equal(r.ok, true, r.error?.message);
    assert.equal(t.got.length, 1);
    assert.equal(t.got[0].streamed, streamed, `${size}`);
    assert.equal(t.got[0].read, t.got[0].length, `${size}: the declared length is what was read`);
    assert.equal(t.got[0].error, null);
    assert.ok(r.value.packBytes > 0 && t.got[0].length > r.value.packBytes);
  }
});

test('push: a stream pass 2 refused is ambiguous (original internal) even when the server answers ok', async () => {
  const data = fill(4 * INFLATE_CHUNK, 'random');
  const t = doubleTransport();
  const real = t.frames;
  t.frames = async function* (service, body) { data[5] ^= 1; yield* real.call(t, service, body); };
  const r = await push(t, { ref: 'refs/heads/main', oldOid: oid('0'), newOid: oid('a'), objects: [{ type: TYPE.BLOB, data }], sideband: false });
  assert.equal(r.ok, false);
  assert.deepEqual([r.error.code, r.error.original], ['ambiguous', 'internal']);
  assert.match(r.error.message, /^push outcome unknown: push: the pack's second deflate pass wrote another pack/);
  assert.equal(t.got[0].error.code, 'internal');
});

test('push: the cap is pass 1\'s measured pack, checked before the transport is asked', async () => {
  const data = fill(4 * INFLATE_CHUNK, 'random');
  const m = await measurePack([{ type: TYPE.BLOB, data }]);
  for (const [max, ok] of [[m.bytes, true], [m.bytes - 1, false]]) {
    const t = doubleTransport({ maxPackBytes: max });
    const r = await push(t, { ref: 'refs/heads/main', oldOid: oid('0'), newOid: oid('a'), objects: [{ type: TYPE.BLOB, data }], sideband: false });
    assert.equal(r.ok, ok, `${max}`);
    assert.equal(t.got.length, ok ? 1 : 0);
    if (!ok) assert.deepEqual([r.error.code, r.error.got, r.error.max], ['limit_exceeded', m.bytes, max]);
    else assert.equal(r.value.packBytes, m.bytes);
  }
});

// CompressionStream as a spy: what it was fed (each slice's length), and whether its output was cancelled. pipeThrough
// takes any { writable, readable } pair, so the real stream does the work.
const spyDeflate = async (body) => {
  const Real = globalThis.CompressionStream;
  const seen = { slices: [], cancelled: 0 };
  globalThis.CompressionStream = class {
    constructor(format) {
      const real = new Real(format);
      const w = real.writable.getWriter();
      this.writable = new WritableStream({ write: c => { seen.slices.push(c.length); return w.write(c); }, close: () => w.close(), abort: e => w.abort(e) });
      const r = real.readable.getReader();
      this.readable = new ReadableStream({ pull: async c => { const x = await r.read(); if (x.done) c.close(); else c.enqueue(x.value); }, cancel: e => { seen.cancelled++; return r.cancel(e); } }, { highWaterMark: 0 });
    }
  };
  try { await body(seen); } finally { globalThis.CompressionStream = Real; }
};
// a Uint8Array that counts the slices taken of it (the writer reads an object only through subarray)
class Counted extends Uint8Array { constructor(n) { super(n); this.taken = 0; } subarray(a, b) { this.taken++; return new Uint8Array(this.buffer, this.byteOffset + a, (b ?? this.length) - a); } }
const settle = () => new Promise(r => setTimeout(r, 20));

test('deflatePull feeds CompressionStream slices of at most INFLATE_CHUNK, and stops it when its reader stops', async () => {
  await spyDeflate(async seen => {
    const parts = [];
    for await (const z of deflatePull(fill(5 * INFLATE_CHUNK + 3, 'random'))) parts.push(z);
    assert.deepEqual(seen.slices, [INFLATE_CHUNK, INFLATE_CHUNK, INFLATE_CHUNK, INFLATE_CHUNK, INFLATE_CHUNK, 3]);
    assert.equal(seen.cancelled, 0);
    const it = deflatePull(fill(64 * INFLATE_CHUNK, 'random'));
    await it.next();
    await it.return();
    assert.equal(seen.cancelled, 1, 'the deflate is cancelled');
  });
});

test('nothing is read ahead: an object is sliced only when its zlib bytes are asked for', async () => {
  const data = new Counted(4 * INFLATE_CHUNK);
  randomFillSync(data);
  const it = deflatePull(data);
  await settle();
  assert.equal(data.taken, 0, 'not before the first read');
  await it.next();
  const after = data.taken;
  await settle();
  assert.equal(data.taken, after, 'not past what the read needed');
  await it.return();

  const m = await measurePack([{ type: TYPE.BLOB, data }], 0);
  data.taken = 0;
  const reader = streamPack(m, prefix).stream.getReader();
  for (let i = 0; i < 3; i++) await reader.read(); // the prefix, the pack header, the object's header
  await settle();
  assert.equal(data.taken, 0, 'the stream pulled nothing past the object header');
  await reader.read();
  assert.ok(data.taken > 0);
  await reader.cancel();
});

test('cancelling pass 2 stops its deflate', async () => {
  await spyDeflate(async seen => {
    const m = await measurePack([{ type: TYPE.BLOB, data: fill(16 * INFLATE_CHUNK, 'random') }], 0);
    seen.cancelled = 0;
    const s = streamPack(m, prefix);
    const reader = s.stream.getReader();
    for (let i = 0; i < 4; i++) await reader.read();
    await reader.cancel();
    assert.equal(seen.cancelled, 1);
    assert.equal(s.failure(), null);
  });
});

test('push: a delete-only push measures no pack and reports no entries', async () => {
  const t = doubleTransport();
  const r = await push(t, { ref: 'refs/heads/main', oldOid: oid('a'), newOid: oid('0'), objects: [], sideband: false });
  assert.equal(r.ok, true, r.error?.message);
  assert.deepEqual([r.value.packBytes, r.value.entries], [0, []]);
  assert.equal(t.got[0].streamed, false);
});
