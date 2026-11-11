// The packs cluster's errors as values (sem/packs): each cell would have caught the bug it names, and the Result cores
// are held to the same error the throwing wrapper throws. In the mutation suite (vitest.stryker.config.ts).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { take, shortRead, encodeBytes, HEXV, te, concat, decodeBytes as decodeBytesOf, decodeChunk as decodeChunkOf } from '../src/bytes.js';
import { pkt, pktStep, pktFinish, pktInit } from '../src/pktline.js';
import { inflate, DEFLATE_TABLES } from '../src/inflate.js';
import { readObjHeader, readOfsDelta, readUint32BE, parsePack, applyDelta, resolvePack, makeDelta } from '../src/packresolve.js';
import { buildPack, encodeObjHeader, spliceDelta } from '../src/pack.js';
import { fromHex, toHex } from '../src/sha1.js';
import { hashObject, TYPE } from '../src/objects.js';
import { withLimits, DEFAULT_LIMITS } from '../src/limits.js';
import { PACK_HEADER_BYTES, OBJ_CONTINUE } from '../src/format.js';
import { unwrap } from './unwrap.js';

const errOf = (r, code, message) => {
  assert.equal(r.ok, false, 'an Err');
  assert.equal(r.error.code, code, r.error.message);
  if (message !== undefined) assert.equal(r.error.message, message);
  assert.ok(r.error instanceof Error, 'a PlyError is an Error (a stack for whoever logs it)');
  return r.error;
};

// ---- #76: control flow on a typed reason, never on a message ----

test('#76 a short read carries reason short_read on every bounded reader, and nothing else does', () => {
  const buf = Uint8Array.of(1, 2, 3);
  const sr = (r, code, message) => assert.equal(errOf(r, code, message).reason, 'short_read');
  sr(take(buf, 2, 2), 'pack_corrupt', 'short read: need 2 bytes at 2, have 3');
  sr(take(buf, 0, 4, 'protocol'), 'protocol', 'short read: need 4 bytes at 0, have 3');
  sr(take(undefined, 0, 0), 'pack_corrupt', 'short read: need 0 bytes at 0, have 0');
  sr(take(buf, -1, 1), 'pack_corrupt', 'short read: need 1 bytes at -1, have 3');
  sr(take(buf, 0.5, 1), 'pack_corrupt', 'short read: need 1 bytes at 0.5, have 3');
  sr(take(buf, 0, -1), 'pack_corrupt', 'short read: need -1 bytes at 0, have 3');
  sr(take(buf, 0, 1.5), 'pack_corrupt', 'short read: need 1.5 bytes at 0, have 3');
  assert.deepEqual(take(buf, 1, 2), { ok: true, value: buf.subarray(1, 3) });
  assert.equal(take(buf, 3, 0).value.length, 0);
  assert.throws(() => unwrap(take(buf, 2, 2)), e => e.reason === 'short_read' && e.code === 'pack_corrupt');
  assert.deepEqual(shortRead('protocol', 7, 2, 5), Object.assign(new Error('short read: need 2 bytes at 7, have 5'), { code: 'protocol', reason: 'short_read' }));
  // an object header cut anywhere is a short read (fetch.ts spStep waits for more bytes on exactly this reason)
  const h = encodeObjHeader(TYPE.BLOB, 2 ** 20 + 3);
  for (let i = 0; i < h.length; i++) sr(readObjHeader(h.subarray(0, i), 0), 'pack_corrupt', `short read: need 1 bytes at ${i}, have ${i}`);
  assert.deepEqual(readObjHeader(h, 0), { ok: true, value: { type: TYPE.BLOB, size: 2 ** 20 + 3, next: h.length } });
  sr(readOfsDelta(Uint8Array.of(OBJ_CONTINUE), 0), 'pack_corrupt', 'short read: need 1 bytes at 1, have 1');
  sr(readUint32BE(buf, 0), 'pack_corrupt', 'short read: need 4 bytes at 0, have 3');
  sr(inflate(Uint8Array.of(0x78), 0), 'pack_corrupt', 'short read: need 2 bytes at 0, have 1');
  // a corrupt header is not a short read: no reason
  const long = new Uint8Array(12).fill(0x80);
  const e = errOf(readObjHeader(long, 0), 'pack_corrupt', 'pack: size varint longer than 64 bits');
  assert.equal(e.reason, undefined);
});

test('#76 a thin pack resolves through the external phase; a base missing from both is named, typed, and the first', async () => {
  const v0 = te.encode('base object, long enough to delta against\n');
  const v1 = te.encode('base object, long enough to delta against\nplus a line\n');
  const v2 = te.encode('base object, long enough to delta against\nplus a line\nand another\n');
  const d1 = spliceDelta({ baseLen: v0.length, off: v0.length, oldLen: 0, insert: v1.subarray(v0.length) }).delta;
  const d2 = spliceDelta({ baseLen: v1.length, off: v1.length, oldLen: 0, insert: v2.subarray(v1.length) }).delta;
  const id0 = hashObject('blob', v0), id1 = hashObject('blob', v1);
  // child first: d2 waits on d1 (in the pack) which waits on v0 (external only)
  const { pack } = await buildPack([{ type: TYPE.BLOB, data: d2, base: { tag: 'ref', oid: id1 } }, { type: TYPE.BLOB, data: d1, base: { tag: 'ref', oid: id0 } }]);
  const parsed = unwrap(parsePack(pack));
  let asked = [];
  const r = resolvePack(parsed, o => { asked.push(o); return o === id0 ? { type: TYPE.BLOB, data: v0 } : undefined; });
  assert.equal(r.ok, true);
  assert.deepEqual([...r.value.objects.keys()].sort(), [id1, hashObject('blob', v2)].sort());
  assert.equal(r.value.stats.externalBases, 1);
  // the in-pack phase asks nothing; the external phase asks for each base still missing, in pack order (d2's id1 first,
  // which the pack itself supplies a pass later)
  assert.deepEqual(asked, [id1, id0]);
  // nothing external: the error names the base the first waiting object (d2, pack order) is missing, as it always has
  errOf(resolvePack(parsed), 'pack_corrupt', `pack: ref delta base ${id1} not found`);
  assert.throws(() => unwrap(resolvePack(parsed)), e => e.code === 'pack_corrupt' && e.message === `pack: ref delta base ${id1} not found`);
  // an error inside the chain is not mistaken for a missing base: a corrupt delta fails at once, even in the in-pack phase
  const bad = await buildPack([{ type: TYPE.BLOB, data: d2, base: { tag: 'ref', oid: id1 } }, { type: TYPE.BLOB, data: d1, base: { tag: 'ref', oid: id0 } }, { type: TYPE.BLOB, data: v0 }]);
  const p2 = unwrap(parsePack(bad.pack));
  const broken = { ...p2, objects: p2.objects.map((o, i) => (i === 1 ? { ...o, data: Uint8Array.of(v0.length + 1, 1, 1, 0x41) } : o)) };
  errOf(resolvePack(broken), 'pack_corrupt', `delta: base size ${v0.length + 1} != ${v0.length}`);
});

test('#76 no src module in the packs cluster branches on an error message', () => {
  for (const f of ['bytes', 'pktline', 'pack', 'packresolve', 'inflate', 'sha1']) {
    const src = readFileSync(new URL(`../src/${f}.ts`, import.meta.url), 'utf8');
    assert.ok(!/\.message\b/.test(src.replace(/\/\/.*$/gm, '')), `${f}.ts reads an error's message`);
    assert.ok(!/\bcatch\s*\(/.test(src.replace(/\/\/.*$/gm, '')) || f === 'inflate', `${f}.ts catches (only inflate's STOP slot may)`);
  }
});

// ---- Result cores: Err values, never throws, the same error the wrapper throws ----

test('Result cores return Err for every refusal their wrappers throw', async () => {
  errOf(pktStep(pktInit(), te.encode('zzzz')), 'protocol', 'bad pkt-line length at byte 0');
  errOf(pktStep(pktInit(), te.encode('0003')), 'protocol', 'invalid pkt-line length 3');
  errOf(pktStep(pktInit(), te.encode('fff4')), 'protocol', 'bad pkt-line length 65520');
  assert.equal(pktStep(pktInit(), te.encode('fff3')).ok, true, '65523 is the longest frame git reads');
  const half = unwrap(pktStep(pktInit(), te.encode('0005a000'))).state;
  errOf(pktFinish(half), 'protocol', 'trailing 3 bytes after last pkt-line');
  const big = errOf(pkt(new Uint8Array(65517)), 'bad_request', 'pkt-line payload too large: 65517 bytes, the most git frames is 65516');
  assert.deepEqual([big.what, big.got, big.max], ['pkt-line', 65517, 65516]);
  errOf(pkt('\ud800'), 'bad_request', 'pkt-line: lone surrogate U+D800 is no byte sequence');
  errOf(encodeBytes(7, 'ref'), 'bad_request', 'ref must be a string');
  errOf(encodeBytes('\udcc3\udca9'), 'bad_request', 'string: escaped bytes spell well-formed UTF-8; pass the characters');
  assert.deepEqual(encodeBytes('a\udce9'), { ok: true, value: Uint8Array.of(0x61, 0xe9) });
  assert.throws(() => unwrap(encodeBytes(7)), e => e.code === 'bad_request' && e.what === 'string');

  const z = zlib.deflateSync(te.encode('hello hello hello'));
  errOf(inflate(z, 0, { maxOutput: Infinity }), 'bad_request', 'limits.maxObjectSize must be a finite non-negative number');
  const over = errOf(inflate(z, 0, { expectedSize: 17, maxOutput: 5 }), 'limit_exceeded', 'inflate: expected size 17 exceeds limit 5');
  assert.deepEqual([over.what, over.got, over.max], ['inflate expected size', 17, 5]);
  const grow = errOf(inflate(z, 0, { maxOutput: 5 }), 'limit_exceeded', 'inflate: output exceeds limit 5');
  assert.deepEqual([grow.what, grow.max], ['inflate output', 5]);
  assert.ok(grow.got > 5);
  // BTYPE 3 is reserved: the exhaustive block type has no member for it
  errOf(inflate(Uint8Array.of(0b111), 0, { raw: true }), 'pack_corrupt', 'inflate: invalid block type');
  assert.throws(() => unwrap(inflate(Uint8Array.of(0b111), 0, { raw: true })), e => e.code === 'pack_corrupt' && e.message === 'inflate: invalid block type');
  // a bug inside the decoder is not swallowed into an Err: only the STOP sentinel is converted
  assert.throws(() => inflate(null, 0, { raw: true }), TypeError);

  const { pack } = await buildPack([{ type: TYPE.BLOB, data: te.encode('x') }]);
  errOf(parsePack(pack, { maxObjects: -1 }), 'bad_request', 'limits.maxPackObjects must be a finite non-negative number');
  errOf(parsePack(pack, { limits: withLimits({ maxObjectSize: NaN }) }), 'bad_request', 'limits.maxObjectSize must be a finite non-negative number');
  errOf(parsePack(pack, { maxInflatedTotal: -1 }), 'bad_request', 'limits.maxInflatedTotal must be a finite non-negative number');
  errOf(parsePack(pack, { maxInflatedTotal: 1 }), 'limit_exceeded');
  errOf(parsePack(pack, { limits: { maxPackObjects: null } }), 'bad_request', 'limits.maxPackObjects must be a finite non-negative number');
  const lim = errOf(parsePack(pack, { maxObjects: 0 }), 'limit_exceeded', 'pack objects 1 exceeds limit 0');
  assert.deepEqual([lim.what, lim.got, lim.max], ['pack objects', 1, 0]);
  errOf(parsePack(pack.subarray(0, pack.length - 1)), 'pack_corrupt');
  errOf(applyDelta(new Uint8Array(0), Uint8Array.of(0, 1, 0x81), { maxResult: -1 }), 'bad_request', 'limits.maxDeltaResult must be a finite non-negative number');
  errOf(resolvePack(unwrap(parsePack(pack)), undefined, withLimits({ maxDeltaChain: null })), 'bad_request', 'limits.maxDeltaChain must be a finite non-negative number');
  // a key left out (or passed as the missing value) is the default (#156 parseLimits)
  assert.equal(resolvePack(unwrap(parsePack(pack)), undefined, withLimits({ maxDeltaChain: undefined })).ok, true);
});

test('applyDelta: a delta cut inside a copy opcode is a short read at its end, whichever byte is missing', () => {
  const base = new Uint8Array(300).fill(7);
  // copy off=0x0102 len=0x0201: opcode, two offset bytes, two length bytes
  const op = Uint8Array.of(0x80 | 0x01 | 0x02 | 0x10 | 0x20, 0x02, 0x01, 0x01, 0x02);
  const head = Uint8Array.of(0xac, 0x02, 0x80, 0x04); // base 300, result 512
  for (let cut = 1; cut < op.length; cut++) {
    const d = concat([head, op.subarray(0, cut)]);
    assert.equal(errOf(applyDelta(base, d), 'pack_corrupt', `short read: need 1 bytes at ${d.length}, have ${d.length}`).reason, 'short_read');
  }
});

test('ofs-delta offsets are capped like size varints: an endless continuation is corrupt within ten bytes', () => {
  const endless = new Uint8Array(4096).fill(0x80);
  errOf(readOfsDelta(endless, 0), 'pack_corrupt', 'pack: ofs delta offset longer than 64 bits');
  // ten bytes is the most a cap of 64 bits reads; the tenth may end it
  const ten = new Uint8Array(10).fill(0x80); ten[9] = 1;
  assert.equal(readOfsDelta(ten, 0).ok, true);
  const eleven = new Uint8Array(11).fill(0x80); eleven[10] = 1;
  errOf(readOfsDelta(eleven, 0), 'pack_corrupt', 'pack: ofs delta offset longer than 64 bits');
});

test('parsePack: the six pack types are accepted and 0 and 5 refused, by kind', async () => {
  const { pack } = await buildPack([{ type: TYPE.BLOB, data: te.encode('x') }]);
  for (const t of [0, 5]) {
    const p = Uint8Array.from(pack);
    p[PACK_HEADER_BYTES] = (p[PACK_HEADER_BYTES] & 0x8f) | (t << 4);
    errOf(parsePack(p, { verify: false }), 'pack_corrupt', `pack: bad object type ${t} at ${PACK_HEADER_BYTES}`);
  }
  const objs = [TYPE.COMMIT, TYPE.TREE, TYPE.BLOB, TYPE.TAG].map(type => ({ type, data: te.encode('') }));
  const all = await buildPack([...objs, { type: TYPE.BLOB, data: Uint8Array.of(0, 0), base: { tag: 'ref', oid: hashObject('tag', new Uint8Array(0)) } }]);
  const r = parsePack(all.pack);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.stats.byType, { commit: 1, tree: 1, blob: 1, tag: 1, ref_delta: 1 });
  assert.deepEqual([r.value.stats.full, r.value.stats.refDelta, r.value.stats.ofsDelta], [4, 1, 0]);
});

test('resolvePack parses a hand-built object at its edge: a type, a base, and data, or bad_request before hashing', () => {
  const data = te.encode('x');
  const at = PACK_HEADER_BYTES;
  errOf(resolvePack({ objects: [{ offset: at, type: 5, size: data.length, compressed: 0, data }] }), 'bad_request', `resolvePack: object at ${at} has type 5 and no base`);
  // a delta type with no base is not a stored object either; a stored type with an explicit none base is one
  errOf(resolvePack({ objects: [{ offset: at, type: TYPE.OFS_DELTA, data, base: { tag: 'none' } }] }), 'bad_request', `resolvePack: object at ${at} has type 6 and no base`);
  const one = unwrap(resolvePack({ objects: [{ offset: at, type: TYPE.BLOB, data, base: { tag: 'none' } }] }));
  const r = one.objects.get(hashObject('blob', data));
  assert.deepEqual({ type: r.type, size: r.size, compressed: r.compressed, packBase: r.packBase, chain: r.chain }, { type: TYPE.BLOB, size: 1, compressed: 0, packBase: { tag: 'none' }, chain: 0 });
  errOf(resolvePack({ objects: [{ offset: at, type: TYPE.BLOB, data, base: { tag: 'odd' } }] }), 'bad_request', `resolvePack: object at ${at} has base tag "odd"`);
  errOf(resolvePack({ objects: [{ offset: at, type: TYPE.BLOB, data, base: {} }] }), 'bad_request', `resolvePack: object at ${at} has base tag undefined`);
  for (const offset of [-1, 1.5, Number.NaN, 2 ** 53]) {
    errOf(resolvePack({ objects: [{ offset: 40, type: TYPE.OFS_DELTA, data, base: { tag: 'ofs', offset } }] }), 'bad_request', `resolvePack: object at 40 has ofs base ${offset}`);
  }
  for (const oid of ['A'.repeat(40), 'a'.repeat(39), 7]) {
    errOf(resolvePack({ objects: [{ offset: 40, type: TYPE.REF_DELTA, data, base: { tag: 'ref', oid } }] }), 'bad_request', `resolvePack: object at 40 has ref base ${JSON.stringify(oid)}, not an object id`);
  }
  errOf(resolvePack({ objects: [{ offset: 40, type: TYPE.BLOB, data: 'x' }] }), 'bad_request', 'resolvePack: object at 40 has no data');
  errOf(resolvePack({ objects: [{ offset: 40, type: TYPE.BLOB }] }), 'bad_request', 'resolvePack: object at 40 has no data');
  // the offset 0 and the largest safe one are offsets (a base that is not an object there is the resolver's corrupt)
  errOf(resolvePack({ objects: [{ offset: 40, type: TYPE.OFS_DELTA, data, base: { tag: 'ofs', offset: 0 } }] }), 'pack_corrupt', 'pack: ofs delta base not at object boundary 0');
  errOf(resolvePack({ objects: [{ offset: 40, type: TYPE.OFS_DELTA, data, base: { tag: 'ofs', offset: 2 ** 53 - 1 } }] }), 'pack_corrupt', `pack: ofs delta base not at object boundary ${2 ** 53 - 1}`);
  // a left-out size is the data's length, a left-out compressed count 0; given ones are kept
  const sized = unwrap(resolvePack({ objects: [{ offset: at, type: TYPE.BLOB, data, size: 9, compressed: 4 }] })).objects.get(hashObject('blob', data));
  assert.deepEqual([sized.size, sized.compressed], [9, 4]);
  // a REF base as a plain lowercase string is parsed into the Oid the lookup is asked for
  const asked = [];
  const base = te.encode('base');
  const delta = makeDelta(base, te.encode('based')).delta;
  const id = hashObject('blob', base);
  const thin = unwrap(resolvePack({ objects: [{ offset: at, type: TYPE.REF_DELTA, data: delta, base: { tag: 'ref', oid: id } }] }, o => { asked.push(o); return { type: TYPE.BLOB, data: base }; }));
  assert.deepEqual(asked, [id]);
  assert.deepEqual([...thin.objects.values()].map(o => [o.type, o.packBase]), [[TYPE.BLOB, { tag: 'ref', oid: id }]]);
});

test('resolvePack reads each object once at its edge', async () => {
  const { pack } = await buildPack(Array.from({ length: 5 }, (_, i) => ({ type: TYPE.BLOB, data: te.encode(`blob ${i}`) })));
  const parsed = unwrap(parsePack(pack));
  let reads = 0;
  // count reads of `data` on full objects: hashing reads it once; a second hash would read it again
  const counted = { ...parsed, objects: parsed.objects.map(o => { let d = o.data; return Object.defineProperty({ ...o }, 'data', { get() { reads++; return d; }, enumerable: true }); }) };
  const r = unwrap(resolvePack(counted));
  assert.equal(r.objects.size, 5);
  assert.equal(reads, 5, 'each object: one read, where the resolver parses its input (the entry holds the bytes from there)');
});

// ---- tables and codecs held to their definitions ----

test('the deflate length/distance tables are RFC 1951 §3.2.5, as printed', () => {
  assert.deepEqual(DEFLATE_TABLES.LBASE, [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]);
  assert.deepEqual(DEFLATE_TABLES.LEXT, [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]);
  assert.deepEqual(DEFLATE_TABLES.DBASE, [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]);
  assert.deepEqual(DEFLATE_TABLES.DEXT, [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]);
});

test('inflate: non-overlapping and overlapping matches, at every distance/length relation, equal zlib', () => {
  for (const len of [3, 4, 10, 257, 258]) {
    for (const d of [1, 2, len - 1, len, len + 1, 300]) {
      if (d < 1) continue;
      const seed = Uint8Array.from({ length: d }, (_, i) => (i * 37 + 11) & 0xff);
      const data = concat([seed, new Uint8Array(len).map((_, i) => seed[i % d])]);
      const z = zlib.deflateSync(data, { level: 9 });
      const got = unwrap(inflate(z, 0, { expectedSize: data.length })).out;
      assert.equal(Buffer.compare(Buffer.from(got), Buffer.from(data)), 0, `len ${len} distance ${d}`);
    }
  }
});

test('fromHex: the table reads every pair parseInt reads, and garbage pairs as parseInt did', () => {
  const ref = h => { const o = new Uint8Array(h.length >> 1); for (let i = 0; i < o.length; i++) o[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16); return o; };
  const chars = '0123456789abcdefABCDEFgxz -+ Āİ０';
  for (const a of chars) for (const b of chars) assert.deepEqual(fromHex(a + b), ref(a + b), JSON.stringify(a + b));
  for (let n = 0; n < 256; n++) assert.deepEqual(fromHex(n.toString(16).padStart(2, '0')), Uint8Array.of(n));
  assert.deepEqual(fromHex('abc'), Uint8Array.of(0xab), 'an odd last digit is dropped');
  const id = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3';
  assert.equal(toHex(fromHex(id)), id);
  assert.equal(toHex(fromHex(id.toUpperCase())), id);
  for (let c = 0; c < 256; c++) {
    const want = /[0-9a-f]/i.test(String.fromCharCode(c)) ? Number.parseInt(String.fromCharCode(c), 16) : -1;
    assert.equal(HEXV[c], want, `HEXV[${c}]`);
  }
});

// ---- #84: bytes.ts survivors, killed by an independent oracle (the platform's strict UTF-8 decoder) ----

const strictDec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const looseDec = new TextDecoder('utf-8', { ignoreBOM: true });
const memo = new Map();
// The one character these bytes are as UTF-8, or null (memoised: the decoder signals ill-formed bytes by throwing).
function oneChar(bytes) {
  const k = bytes.join();
  if (!memo.has(k)) {
    let v = null;
    try { const t = strictDec.decode(bytes); if ([...t].length === 1) v = t; } catch { /* ill-formed */ }
    memo.set(k, v);
  }
  return memo.get(k);
}
// PEP 383 surrogateescape, by the platform's decoder: at each byte, the shortest prefix that decodes to one code point is
// a character; a byte that starts none is escaped as U+DC00 + byte.
function refDecode(b) {
  let s = '';
  for (let i = 0; i < b.length;) {
    let took = 0;
    for (let n = 1; n <= 4 && i + n <= b.length && !took; n++) {
      const t = oneChar(b.subarray(i, i + n));
      if (t !== null) { s += t; took = n; }
    }
    if (!took) { s += String.fromCharCode(0xdc00 + b[i]); took = 1; }
    i += took;
  }
  return s;
}
const EDGES = [0x00, 0x41, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc1, 0xc2, 0xdf, 0xe0, 0xed, 0xef, 0xf0, 0xf4, 0xf5, 0xff];

test('#84 decodeBytes is surrogateescape over every lead byte and boundary continuation, and encodeBytes inverts it', () => {
  for (let lead = 0; lead < 256; lead++) {
    for (const b1 of EDGES) for (const b2 of [0x7f, 0x80, 0xbf, 0xc0]) for (const b3 of [0x80, 0xbf, 0x41]) {
      // an ill-formed byte on either side keeps the strict fast path out, so the escape loop decides every byte
      for (const b of [Uint8Array.of(lead, b1, b2, b3, 0xff), Uint8Array.of(0xff, lead, b1, b2, b3), Uint8Array.of(0xff, lead, b1)]) {
        const s = decodeBytesOf(b);
        if (s !== refDecode(b)) assert.fail(`decodeBytes(${[...b].map(x => x.toString(16)).join(' ')}) = ${JSON.stringify(s)}, want ${JSON.stringify(refDecode(b))}`);
        const back = encodeBytes(s);
        if (!back.ok || Buffer.compare(Buffer.from(back.value), Buffer.from(b)) !== 0) assert.fail(`encodeBytes does not invert decodeBytes on ${[...b].map(x => x.toString(16)).join(' ')}`);
      }
    }
  }
});

test('#84 encodeBytes: surrogate pairs at the edges are characters, lone ones outside the escape range are refused', () => {
  const ok = (s, bytes) => assert.deepEqual([...encodeBytes(s).value], bytes, JSON.stringify(s));
  ok('􏿿\udce9', [0xf4, 0x8f, 0xbf, 0xbf, 0xe9]); // U+10FFFF, the last pair, beside an escape
  ok('𐀀\udc80', [0xf0, 0x90, 0x80, 0x80, 0x80]);
  ok('\udc80\udcff', [0x80, 0xff]);
  const lone = (s, u) => assert.equal(errOf(encodeBytes(s, 'name'), 'bad_request', `name: lone surrogate U+${u} is no byte sequence`).what, 'name');
  lone('\ud800􏳩', 'D800'); // a high surrogate followed by a high one is no pair
  lone('\ud800', 'D800'); // nor followed by a code unit past the low surrogates (U+E000)
  lone('\udc7f', 'DC7F');
  lone('\udd00', 'DD00');
  lone('\udbff', 'DBFF');
  assert.equal(errOf(encodeBytes('\udcc3\udca9', 'name'), 'bad_request', 'name: escaped bytes spell well-formed UTF-8; pass the characters').what, 'name');
  assert.equal(errOf(encodeBytes(null), 'bad_request', 'string must be a string').what, 'string');
});

test('#84 decodeChunk: any split of any byte stream gives the whole stream\'s text, and carries only an unfinished sequence', () => {
  const need = c => (c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : 2);
  const streams = [];
  for (const lead of EDGES) for (let n = 0; n <= 4; n++) for (const cont of [0x80, 0x82, 0xbf, 0x41]) streams.push(Uint8Array.of(0x61, lead, ...new Array(n).fill(cont)));
  streams.push(te.encode('é€😀a'), Uint8Array.of(0xe2, 0x80, 0x80, 0xf0, 0x9f, 0x98, 0x80));
  for (const s of streams) {
    for (let cut = 0; cut <= s.length; cut++) for (let cut2 = cut; cut2 <= s.length; cut2++) {
      let carry = new Uint8Array(0);
      let text = '';
      for (const piece of [s.subarray(0, cut), s.subarray(cut, cut2), s.subarray(cut2)]) {
        const r = decodeChunkOf(carry, piece);
        text += r.text; carry = r.carry;
        if (carry.length) {
          const where = `${[...s].map(x => x.toString(16)).join(' ')} cut ${cut}/${cut2}`;
          assert.ok(carry[0] >= 0xc2 && carry.length < need(carry[0]), `carry starts a sequence it has not finished: ${where}`);
          assert.ok(carry.subarray(1).every(c => c >= 0x80 && c <= 0xbf), `carry holds only continuation bytes after its lead: ${where}`);
        }
      }
      text += looseDec.decode(carry);
      if (text !== looseDec.decode(s)) assert.fail(`split ${cut}/${cut2} of ${[...s].map(x => x.toString(16)).join(' ')}: ${JSON.stringify(text)}`);
    }
  }
});

test('pktFinish refuses only a carry; parsePack refuses an ofs delta naming itself', async () => {
  assert.equal(pktFinish(pktInit()).ok, true);
  assert.equal(pktFinish(unwrap(pktStep(pktInit(), te.encode('0000'))).state).ok, true);
  // a one-object pack whose object is an OFS_DELTA with offset 0
  const body = concat([te.encode('PACK'), Uint8Array.of(0, 0, 0, 2, 0, 0, 0, 1), Uint8Array.of(0x62, 0x00), zlib.deflateSync(Uint8Array.of(0, 0))]);
  const sha = (await import('node:crypto')).createHash('sha1').update(body).digest();
  errOf(parsePack(concat([body, sha])), 'pack_corrupt', `pack: ofs delta at ${PACK_HEADER_BYTES} is its own base`);
});

test('parsePack passes each part\'s Err through: object header, ofs offset, ref id, zlib body', () => {
  const crypto = globalThis.process.getBuiltinModule('node:crypto');
  const packOf = (...obj) => { const body = concat([te.encode('PACK'), Uint8Array.of(0, 0, 0, 2, 0, 0, 0, 1), ...obj]); return concat([body, crypto.createHash('sha1').update(body).digest()]); };
  // an object header that never ends: the varint cap, not a TypeError on a missing header
  errOf(parsePack(packOf(new Uint8Array(12).fill(0x80))), 'pack_corrupt', 'pack: size varint longer than 64 bits');
  // an ofs delta whose offset never ends
  errOf(parsePack(packOf(Uint8Array.of(0x62), new Uint8Array(12).fill(0x80))), 'pack_corrupt', 'pack: ofs delta offset longer than 64 bits');
  // a ref delta whose base id runs into the trailer: the id is read (the trailer is 20 bytes, an id's length), and the
  // object then has no zlib body before the end
  errOf(parsePack(packOf(Uint8Array.of(0x72), new Uint8Array(4))), 'pack_corrupt');
  // a blob whose zlib body is not zlib
  errOf(parsePack(packOf(Uint8Array.of(0x32), Uint8Array.of(0x78, 0x00, 0, 0, 0, 0))), 'pack_corrupt', 'zlib: bad header check');
});

test('inflate converts only its own STOP: a bug inside the block loop propagates', () => {
  // a plain array has no subarray: the stored block's copy throws a TypeError inside the loop, which is not an Err
  assert.throws(() => inflate([0b001, 1, 0, 0xfe, 0xff, 0x41], 0, { raw: true }), TypeError);
  // and a refusal is an Err, not a throw, from the same place
  errOf(inflate(Uint8Array.of(0b001, 1, 0, 0xfe, 0xfe, 0x41), 0, { raw: true }), 'pack_corrupt', 'inflate: stored length check failed');
  assert.equal(inflate(Uint8Array.of(0b001, 1, 0, 0xfe, 0xff, 0x41), 0, { raw: true }).value.out[0], 0x41);
});

test('readOfsDelta: an empty buffer is a short read, not offset 0', () => {
  assert.equal(errOf(readOfsDelta(new Uint8Array(0), 0), 'pack_corrupt', 'short read: need 1 bytes at 0, have 0').reason, 'short_read');
  assert.equal(errOf(readOfsDelta(Uint8Array.of(1, 2), 2), 'pack_corrupt', 'short read: need 1 bytes at 2, have 2').reason, 'short_read');
});

// The bit reader must not read a byte it does not need: a stored block drops the bits left in the current byte and reads
// its LEN at the next byte boundary, so one byte read ahead is one byte lost. Every count of bits left over by the block
// before it (8 here, by 0..7 nine-bit literals), against zlib.
test('inflate: a stored block after a fixed one, at every leftover bit count, equals zlib', () => {
  for (let k = 0; k < 8; k++) {
    const bitsOut = [];
    const put = (v, n) => { for (let i = 0; i < n; i++) bitsOut.push((v >> i) & 1); };
    const putCode = (code, n) => { for (let i = n - 1; i >= 0; i--) bitsOut.push((code >> i) & 1); }; // Huffman codes MSB first
    put(0, 1); put(1, 2); // not final, fixed
    for (let i = 0; i < k; i++) putCode(0b110010000 + (0x90 - 144), 9); // literal 0x90: 9-bit code 110010000 + (lit - 144)
    putCode(0, 7); // end of block (256): 7-bit 0000000
    put(1, 1); put(0, 2); // final, stored
    while (bitsOut.length % 8) bitsOut.push(0);
    const head = Uint8Array.from({ length: bitsOut.length / 8 }, (_, i) => bitsOut.slice(i * 8, i * 8 + 8).reduce((a, b, j) => a | (b << j), 0));
    const raw = concat([head, Uint8Array.of(2, 0, 0xfd, 0xff, 0x5a, 0x59)]);
    const want = zlib.inflateRawSync(raw);
    const got = inflate(raw, 0, { raw: true });
    assert.equal(got.ok, true, `k=${k}: ${got.error?.message}`);
    assert.equal(Buffer.compare(Buffer.from(got.value.out), want), 0, `k=${k}`);
    assert.equal(got.value.consumed, raw.length, `k=${k}`);
  }
});

// ---- inflate: a stream cut exactly where each read of the block loop runs out ----
// Every read in the block loop (the bit reader and the Huffman decoder) is checked where it is made. Without that check
// the loop goes on with a negative value: the stream may still be refused, but with another message (a bad block type,
// bad dynamic counts, a repeat with no previous, a repeat overflow, no end-of-block code, a distance too far back), or
// not at all (a distance symbol that is not there reads as zero bytes). Each stream below is hand-built (stored, fixed
// and dynamic blocks) and ends at one read with fewer bits left than that read needs, or with bits that match no code.

// LSB-first bit writer (RFC 1951 §3.1.1): header fields and extra bits in value order, Huffman codes MSB first.
class DeflateBits {
  constructor() { this.out = []; }
  bits(v, n) { for (let i = 0; i < n; i++) this.out.push((v >> i) & 1); return this; }
  code([c, len]) { for (let i = len - 1; i >= 0; i--) this.out.push((c >> i) & 1); return this; }
  // the bits left in the last byte after what was written
  get left() { return (8 - (this.out.length % 8)) % 8; }
  // as bytes; a partial last byte is padded with `pad`, LSB first
  done(pad = 0) {
    const bits = [...this.out];
    for (let i = 0; bits.length % 8; i++) bits.push((pad >> i) & 1);
    return Uint8Array.from({ length: bits.length / 8 }, (_, k) => bits.slice(k * 8, k * 8 + 8).reduce((a, b, i) => a | (b << i), 0));
  }
}
// Canonical Huffman codes from code lengths (RFC 1951 §3.2.2): symbol -> [code, length], null for a symbol with none.
function canonicalCodes(lengths) {
  const max = Math.max(0, ...lengths);
  const count = new Array(max + 1).fill(0);
  for (const l of lengths) if (l) count[l]++;
  const next = [];
  for (let code = 0, bits = 1; bits <= max; bits++) { code = (code + count[bits - 1]) << 1; next[bits] = code; }
  return lengths.map(l => (l ? [next[l]++, l] : null));
}
const FIXED_LIT = canonicalCodes(Array.from({ length: 288 }, (_, s) => (s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8)));
const FIXED_DIST = canonicalCodes(new Array(30).fill(5));
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
// A final dynamic block's header through the code length code lengths (HCLEN covers the last one given); returns that code.
function dynamicHeader(w, { hlit, hdist, clens }) {
  let hclen = 19;
  while (hclen > 4 && !clens[CLORDER[hclen - 1]]) hclen--;
  w.bits(1, 1).bits(2, 2).bits(hlit, 5).bits(hdist, 5).bits(hclen - 4, 4);
  for (let i = 0; i < hclen; i++) w.bits(clens[CLORDER[i]] ?? 0, 3);
  return canonicalCodes(Array.from({ length: 19 }, (_, s) => clens[s] ?? 0));
}
const fixedBlock = final => new DeflateBits().bits(final, 1).bits(1, 2);

test('inflate: a stream cut at each read of the block loop is refused with that read\'s message', () => {
  const END = 'inflate: unexpected end of input';
  const NO_CODE = 'inflate: invalid huffman code';
  const refused = (name, w, left, pad, message) => {
    assert.equal(w.left, left, `${name}: bits left in the last byte`);
    const bytes = w.done(pad);
    errOf(inflate(bytes, 0, { raw: true }), 'pack_corrupt', message);
    assert.throws(() => zlib.inflateRawSync(bytes), Error, `${name}: zlib refuses it too`);
  };
  // BFINAL: a non-final empty stored block, then nothing
  errOf(inflate(Uint8Array.of(0b000, 0, 0, 0xff, 0xff), 0, { raw: true }), 'pack_corrupt', END);
  // BTYPE: a non-final fixed block of four 9-bit literals (3 + 36 + 7 = 46 bits): BFINAL takes one of the 2 bits left
  {
    const w = fixedBlock(0);
    for (const c of [0x90, 0x91, 0x92, 0x93]) w.code(FIXED_LIT[c]);
    refused('btype', w.code(FIXED_LIT[256]), 2, 0b01, END);
  }
  // HDIST: after a 28-bit fixed block, BFINAL, BTYPE and HLIT (31, a count no stream may give) leave 4 bits: HDIST needs
  // 5 (HCLEN, 4, would be there)
  refused('hdist', fixedBlock(0).code(FIXED_LIT[0x90]).code(FIXED_LIT[0x91]).code(FIXED_LIT[256]).bits(1, 1).bits(2, 2).bits(31, 5), 4, 0b1111, END);
  // HCLEN: BFINAL, BTYPE, HLIT (31) and HDIST end on bit 13 of 16: HCLEN needs 4 of the 3 left
  refused('hclen', new DeflateBits().bits(1, 1).bits(2, 2).bits(31, 5).bits(0, 5), 3, 0b111, END);
  // a code length code length: 16 and 17 (one bit each) are read, the third needs 3 bits and 1 is left
  refused('clen', new DeflateBits().bits(1, 1).bits(2, 2).bits(0, 5).bits(0, 5).bits(0, 4).bits(1, 3).bits(1, 3), 1, 0, END);
  // a code length symbol: 266 zeros (138 + 128, entry 256 among them) of 271 entries; the 3 padding bits are three more
  // ('0' is symbol 0), then the next symbol runs out
  {
    const w = new DeflateBits();
    const cl = dynamicHeader(w, { hlit: 13, hdist: 0, clens: { 0: 1, 18: 1 } });
    refused('code length', w.code(cl[18]).bits(127, 7).code(cl[18]).bits(117, 7), 3, 0, END);
  }
  // a code length symbol that matches no code: the code length code has no codes at all, the one incomplete
  // code-length set zlib builds a table for (inftrees.c: "no symbols, but wait for decoding to report error"; a single
  // code is `invalid code lengths set` at the header); fifteen 1 bits
  {
    const w = new DeflateBits();
    dynamicHeader(w, { hlit: 0, hdist: 0, clens: {} });
    refused('code length, no code', w.bits(0x7fff, 15), 4, 0, NO_CODE);
  }
  // a repeat's extra bits: 249 zeros (138 + 111) of 258 entries, then an 18 whose 7 extra bits are not there
  {
    const w = new DeflateBits();
    const cl = dynamicHeader(w, { hlit: 0, hdist: 0, clens: { 0: 1, 18: 1 } });
    refused('repeat', w.code(cl[18]).bits(127, 7).code(cl[18]).bits(100, 7).code(cl[18]), 2, 0, END);
  }
  // a length's extra bits: a dynamic block (literal/length 256: '0', 281: '1'; distances 0: '0', 1: '1') whose first
  // symbol is 281 (5 extra bits); 4 are left, the first of them a distance code
  {
    const w = new DeflateBits();
    const cl = dynamicHeader(w, { hlit: 25, hdist: 1, clens: { 1: 1, 18: 1 } });
    w.code(cl[18]).bits(127, 7).code(cl[18]).bits(107, 7); // 0..255: 256 zeros
    w.code(cl[1]); // 256
    w.code(cl[18]).bits(13, 7); // 257..280: 24 zeros
    w.code(cl[1]).code(cl[1]).code(cl[1]); // 281, distances 0 and 1
    const lit = canonicalCodes(Array.from({ length: 282 }, (_, s) => (s === 256 || s === 281 ? 1 : 0)));
    refused('length extra', w.code(lit[281]), 4, 0, END);
  }
  // a distance symbol: fixed, two 9-bit literals and length 3 (3 + 18 + 7 = 28 bits): 4 of its 5 bits are left
  refused('distance', fixedBlock(1).code(FIXED_LIT[0x90]).code(FIXED_LIT[0x91]).code(FIXED_LIT[257]), 4, 0, END);
  // a distance symbol that matches no code: fixed distance codes 30 and 31 do not exist (11111 and ten more 1 bits)
  refused('distance, no code', fixedBlock(1).code(FIXED_LIT[0x41]).code(FIXED_LIT[257]).bits(0x7fff, 15), 7, 0, NO_CODE);
  // a distance's extra bits: one 9-bit literal, length 3, distance symbol 4 (one extra bit): 3 + 9 + 7 + 5 = 24 bits
  refused('distance extra', fixedBlock(1).code(FIXED_LIT[0x90]).code(FIXED_LIT[257]).code(FIXED_DIST[4]), 0, 0, END);
});

// ---- the 0.2.0 cut-over: what the former throwing wrappers refused is an Err, named for what was encoded or parsed ----

test('a string with no byte form is refused naming the field: commit, tag, tree entry name, ref, path, message, checkout path', async () => {
  const { encodeCommit, encodeTag, encodeTree } = await import('../src/objects.js');
  const { validateRef, validatePath, validateMessage, checkoutPathRefusal } = await import('../src/validate.js');
  const { utf8ToStr } = await import('../src/attributes.js');
  const lone = what => `${what}: lone surrogate U+D800 is no byte sequence`;
  const tree = '1'.repeat(40);
  errOf(encodeCommit({ tree, author: 'a <a@b> 0 +0000', message: '\ud800' }), 'bad_request', lone('commit'));
  errOf(encodeTag({ object: tree, type: 'commit', tag: 'v1', tagger: 'a <a@b> 0 +0000', message: '\ud800' }), 'bad_request', lone('tag'));
  errOf(encodeTree([{ mode: '100644', name: '\ud800', oid: tree }]), 'bad_request', lone('tree entry name'));
  errOf(validateRef('refs/heads/\ud800'), 'bad_request', lone('ref'));
  errOf(validatePath('a/\ud800', withLimits()), 'bad_request', lone('path'));
  errOf(validateMessage('m\ud800'), 'bad_request', lone('message'));
  errOf(checkoutPathRefusal('a/\ud800', '100644', 'linux'), 'bad_request', lone('checkout path'));
  // a tree name's escaped bytes are matched as those bytes (one char per byte); a lone surrogate has none
  assert.deepEqual(utf8ToStr('a\udce9/é'), { ok: true, value: 'a\xe9/\xc3\xa9' });
  errOf(utf8ToStr('\ud800'), 'bad_request', lone('path'));
});

test('treeSort: the first name in the caller\'s order that has no byte form is the refusal, compared or not', async () => {
  const { treeSort } = await import('../src/objects.js');
  const e = (name, mode = '100644') => ({ mode, name });
  assert.deepEqual(treeSort([e('b'), e('a', '40000'), e('a.c')]), { ok: true, value: [e('a.c'), e('a', '40000'), e('b')] });
  // Deliberate change (perf/treesort-reencodes-keys-per-comparison): treeSort computes each key once, before the sort,
  // so every name is encoded. One entry used to be returned unencoded because the sort never compared it; it is now
  // refused like any other name with no byte form, which is what encodeTree does with the same entry.
  errOf(treeSort([e('\ud800')]), 'bad_request', 'tree entry name: lone surrogate U+D800 is no byte sequence');
  // the oracle: walk the entries in the order given and stop at the first name that cannot be encoded. It was "the
  // first name a throwing comparator meets", which depended on the order the engine's sort compares in.
  const thrownBy = entries => {
    try {
      for (const a of entries) unwrap(encodeBytes(a.mode === '40000' ? `${a.name}/` : a.name));
    } catch (x) { return x.message; }
    return null;
  };
  for (const entries of [[e('\ud800'), e('a')], [e('a'), e('\ud801')], [e('\ud800'), e('\ud801')], [e('\ud801'), e('\ud800')], [e('z'), e('\ud802'), e('a'), e('\ud803', '40000')]]) {
    const want = thrownBy(entries);
    assert.match(want, /^string: lone surrogate U\+D80[0-3] is no byte sequence$/);
    errOf(treeSort(entries), 'bad_request', want.replace(/^string/, 'tree entry name'));
  }
});

test('packParseOpts parses limits and reads the two pack caps out of them; a key left out is the default', async () => {
  const { packParseOpts } = await import('../src/packresolve.js');
  const limits = withLimits({ maxPackObjects: 3, maxInflatedTotal: 7 });
  assert.deepEqual(packParseOpts(limits), { ok: true, value: { limits, maxObjects: 3, maxInflatedTotal: 7 } });
  assert.deepEqual(unwrap(packParseOpts({})), { limits: { ...DEFAULT_LIMITS }, maxObjects: DEFAULT_LIMITS.maxPackObjects, maxInflatedTotal: DEFAULT_LIMITS.maxInflatedTotal });
  assert.deepEqual(unwrap(packParseOpts({ maxPackObjects: 1 })).maxObjects, 1);
  errOf(packParseOpts({ maxPackObjects: -1 }), 'bad_request', 'limits.maxPackObjects must be a finite non-negative number');
  errOf(packParseOpts({ maxPackObjects: 1, maxInflatedTotal: NaN }), 'bad_request', 'limits.maxInflatedTotal must be a finite non-negative number');
  // a key the parser does not read is ignored
  assert.equal(packParseOpts({ maxPackObjects: 1, notALimit: NaN }).ok, true);
});

test('parseRefname, parseBranchName, parseTagName, parsePath: the refusal names what was parsed; the validator\'s error is its cause', async () => {
  const { parseRefname, parseBranchName, parseTagName } = await import('../src/refname.js');
  const { parsePath } = await import('../src/path.js');
  const full = 'invalid ref: must be a full ref name starting with refs/';
  for (const [r, what, message] of [
    [parseRefname('main'), 'ref', full],
    [parseBranchName('main'), 'branch', full],
    // a branch is checked as a ref a push creates: one level after refs/ is receive-pack's funny refname
    [parseBranchName('refs/heads'), 'branch', 'invalid ref: receive-pack refuses it (funny refname)'],
    [parseTagName('v1'), 'tag', full],
    [parsePath(''), 'path', 'invalid path: must be a non-empty string'],
  ]) {
    const x = errOf(r, 'bad_request', message);
    assert.equal(x.what, what, message);
    assert.equal(x.cause.code, 'bad_request');
    assert.equal(x.cause.message, message);
  }
  // a valid ref outside the namespace is the parser's own refusal, with no cause
  for (const [r, what, message] of [
    [parseBranchName('refs/tags/v1.2.3'), 'branch', 'must start with refs/heads/'],
    [parseTagName('refs/heads/main'), 'tag', 'must start with refs/tags/'],
  ]) {
    const x = errOf(r, 'bad_request', message);
    assert.equal(x.what, what, message);
    assert.equal(x.cause, undefined);
  }
});

test('planDeltas gives each delta its tagged base and counts them: ofs against an earlier object, ref against a thin base', async () => {
  const { planDeltas } = await import('../src/delta.js');
  const v1 = new TextEncoder().encode(Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join(''));
  const v2 = new TextEncoder().encode(Array.from({ length: 40 }, (_, i) => `line ${i === 7 ? 'x' : i}\n`).join(''));
  const p = planDeltas([{ type: TYPE.BLOB, data: v1, path: 'a' }, { type: TYPE.BLOB, data: v2, path: 'a' }]);
  assert.deepEqual([p.ofs, p.ref, p.objects[0].base, p.objects[1].base], [1, 0, undefined, { tag: 'ofs', index: 0 }]);
  const base = hashObject('blob', v1);
  const thin = planDeltas([{ type: TYPE.BLOB, data: v2, path: 'a' }], { thinBase: () => ({ oid: base, data: v1 }) });
  assert.deepEqual([thin.ofs, thin.ref, thin.objects[0].base], [0, 1, { tag: 'ref', oid: base }]);
  const whole = planDeltas([{ type: TYPE.BLOB, data: v2, path: 'a' }]);
  assert.deepEqual([whole.ofs, whole.ref, whole.objects[0].base], [0, 0, undefined]);
});
