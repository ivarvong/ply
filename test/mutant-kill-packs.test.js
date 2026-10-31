// The packs cluster's errors as values (sem/packs): each cell would have caught the bug it names, and the Result cores
// are held to the same error the throwing wrapper throws. In the mutation suite (vitest.stryker.config.ts).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { takeResult, take, shortRead, encodeBytesResult, encodeBytes, HEXV, te, concat, decodeBytes as decodeBytesOf, decodeChunk as decodeChunkOf } from '../src/bytes.js';
import { pktResult, pktStepResult, pktFinishResult, pktInit, pktStep } from '../src/pktline.js';
import { inflateResult, inflate, DEFLATE_TABLES } from '../src/inflate.js';
import {
  readObjHeaderResult, readOfsDeltaResult, readUint32BEResult, parsePackResult, applyDeltaResult, resolvePackResult, resolvePack, parsePack,
} from '../src/packresolve.js';
import { buildPack, encodeObjHeader, spliceDelta } from '../src/pack.js';
import { fromHex, toHex } from '../src/sha1.js';
import { hashObject, TYPE } from '../src/objects.js';
import { withLimits } from '../src/limits.js';
import { PACK_HEADER_BYTES, OBJ_CONTINUE } from '../src/format.js';

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
  sr(takeResult(buf, 2, 2), 'pack_corrupt', 'short read: need 2 bytes at 2, have 3');
  sr(takeResult(buf, 0, 4, 'protocol'), 'protocol', 'short read: need 4 bytes at 0, have 3');
  sr(takeResult(undefined, 0, 0), 'pack_corrupt', 'short read: need 0 bytes at 0, have 0');
  sr(takeResult(buf, -1, 1), 'pack_corrupt', 'short read: need 1 bytes at -1, have 3');
  sr(takeResult(buf, 0.5, 1), 'pack_corrupt', 'short read: need 1 bytes at 0.5, have 3');
  sr(takeResult(buf, 0, -1), 'pack_corrupt', 'short read: need -1 bytes at 0, have 3');
  sr(takeResult(buf, 0, 1.5), 'pack_corrupt', 'short read: need 1.5 bytes at 0, have 3');
  assert.deepEqual(takeResult(buf, 1, 2), { ok: true, value: buf.subarray(1, 3) });
  assert.equal(takeResult(buf, 3, 0).value.length, 0);
  assert.throws(() => take(buf, 2, 2), e => e.reason === 'short_read' && e.code === 'pack_corrupt');
  assert.deepEqual(shortRead('protocol', 7, 2, 5), Object.assign(new Error('short read: need 2 bytes at 7, have 5'), { code: 'protocol', reason: 'short_read' }));
  // an object header cut anywhere is a short read (fetch.ts spStep waits for more bytes on exactly this reason)
  const h = encodeObjHeader(TYPE.BLOB, 2 ** 20 + 3);
  for (let i = 0; i < h.length; i++) sr(readObjHeaderResult(h.subarray(0, i), 0), 'pack_corrupt', `short read: need 1 bytes at ${i}, have ${i}`);
  assert.deepEqual(readObjHeaderResult(h, 0), { ok: true, value: { type: TYPE.BLOB, size: 2 ** 20 + 3, next: h.length } });
  sr(readOfsDeltaResult(Uint8Array.of(OBJ_CONTINUE), 0), 'pack_corrupt', 'short read: need 1 bytes at 1, have 1');
  sr(readUint32BEResult(buf, 0), 'pack_corrupt', 'short read: need 4 bytes at 0, have 3');
  sr(inflateResult(Uint8Array.of(0x78), 0), 'pack_corrupt', 'short read: need 2 bytes at 0, have 1');
  // a corrupt header is not a short read: no reason
  const long = new Uint8Array(12).fill(0x80);
  const e = errOf(readObjHeaderResult(long, 0), 'pack_corrupt', 'pack: size varint longer than 64 bits');
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
  const { pack } = await buildPack([{ type: TYPE.BLOB, data: d2, baseOid: id1 }, { type: TYPE.BLOB, data: d1, baseOid: id0 }]);
  const parsed = parsePack(pack);
  let asked = [];
  const r = resolvePackResult(parsed, o => { asked.push(o); return o === id0 ? { type: TYPE.BLOB, data: v0 } : undefined; });
  assert.equal(r.ok, true);
  assert.deepEqual([...r.value.objects.keys()].sort(), [id1, hashObject('blob', v2)].sort());
  assert.equal(r.value.stats.externalBases, 1);
  // the in-pack phase asks nothing; the external phase asks for each base still missing, in pack order (d2's id1 first,
  // which the pack itself supplies a pass later)
  assert.deepEqual(asked, [id1, id0]);
  // nothing external: the error names the base the first waiting object (d2, pack order) is missing, as it always has
  errOf(resolvePackResult(parsed), 'pack_corrupt', `pack: ref delta base ${id1} not found`);
  assert.throws(() => resolvePack(parsed), e => e.code === 'pack_corrupt' && e.message === `pack: ref delta base ${id1} not found`);
  // an error inside the chain is not mistaken for a missing base: a corrupt delta fails at once, even in the in-pack phase
  const bad = await buildPack([{ type: TYPE.BLOB, data: d2, baseOid: id1 }, { type: TYPE.BLOB, data: d1, baseOid: id0 }, { type: TYPE.BLOB, data: v0 }]);
  const p2 = parsePack(bad.pack);
  const broken = { ...p2, objects: p2.objects.map((o, i) => (i === 1 ? { ...o, data: Uint8Array.of(v0.length + 1, 1, 1, 0x41) } : o)) };
  errOf(resolvePackResult(broken), 'pack_corrupt', `delta: base size ${v0.length + 1} != ${v0.length}`);
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
  errOf(pktStepResult(pktInit(), te.encode('zzzz')), 'protocol', 'bad pkt-line length at byte 0');
  errOf(pktStepResult(pktInit(), te.encode('0003')), 'protocol', 'invalid pkt-line length 3');
  errOf(pktStepResult(pktInit(), te.encode('fff4')), 'protocol', 'bad pkt-line length 65520');
  assert.equal(pktStepResult(pktInit(), te.encode('fff3')).ok, true, '65523 is the longest frame git reads');
  const half = pktStep(pktInit(), te.encode('0005a000')).state;
  errOf(pktFinishResult(half), 'protocol', 'trailing 3 bytes after last pkt-line');
  const big = errOf(pktResult(new Uint8Array(65517)), 'bad_request', 'pkt-line payload too large: 65517 bytes, the most git frames is 65516');
  assert.deepEqual([big.what, big.got, big.max], ['pkt-line', 65517, 65516]);
  errOf(pktResult('\ud800'), 'bad_request', 'pkt-line: lone surrogate U+D800 is no byte sequence');
  errOf(encodeBytesResult(7, 'ref'), 'bad_request', 'ref must be a string');
  errOf(encodeBytesResult('\udcc3\udca9'), 'bad_request', 'string: escaped bytes spell well-formed UTF-8; pass the characters');
  assert.deepEqual(encodeBytesResult('a\udce9'), { ok: true, value: Uint8Array.of(0x61, 0xe9) });
  assert.throws(() => encodeBytes(7), e => e.code === 'bad_request' && e.what === 'string');

  const z = zlib.deflateSync(te.encode('hello hello hello'));
  errOf(inflateResult(z, 0, { maxOutput: Infinity }), 'bad_request', 'limits.maxObjectSize must be a finite non-negative number');
  const over = errOf(inflateResult(z, 0, { expectedSize: 17, maxOutput: 5 }), 'limit_exceeded', 'inflate: expected size 17 exceeds limit 5');
  assert.deepEqual([over.what, over.got, over.max], ['inflate expected size', 17, 5]);
  const grow = errOf(inflateResult(z, 0, { maxOutput: 5 }), 'limit_exceeded', 'inflate: output exceeds limit 5');
  assert.deepEqual([grow.what, grow.max], ['inflate output', 5]);
  assert.ok(grow.got > 5);
  // BTYPE 3 is reserved: the exhaustive block type has no member for it
  errOf(inflateResult(Uint8Array.of(0b111), 0, { raw: true }), 'pack_corrupt', 'inflate: invalid block type');
  assert.throws(() => inflate(Uint8Array.of(0b111), 0, { raw: true }), e => e.code === 'pack_corrupt' && e.message === 'inflate: invalid block type');
  // a bug inside the decoder is not swallowed into an Err: only the STOP sentinel is converted
  assert.throws(() => inflateResult(null, 0, { raw: true }), TypeError);

  const { pack } = await buildPack([{ type: TYPE.BLOB, data: te.encode('x') }]);
  errOf(parsePackResult(pack, { maxObjects: -1 }), 'bad_request', 'limits.maxPackObjects must be a finite non-negative number');
  errOf(parsePackResult(pack, { limits: withLimits({ maxObjectSize: NaN }) }), 'bad_request', 'limits.maxObjectSize must be a finite non-negative number');
  const lim = errOf(parsePackResult(pack, { maxObjects: 0 }), 'limit_exceeded', 'pack objects 1 exceeds limit 0');
  assert.deepEqual([lim.what, lim.got, lim.max], ['pack objects', 1, 0]);
  errOf(parsePackResult(pack.subarray(0, pack.length - 1)), 'pack_corrupt');
  errOf(applyDeltaResult(new Uint8Array(0), Uint8Array.of(0, 1, 0x81), { maxResult: -1 }), 'bad_request', 'limits.maxDeltaResult must be a finite non-negative number');
  errOf(resolvePackResult(parsePack(pack), undefined, withLimits({ maxDeltaChain: undefined })), 'bad_request', 'limits.maxDeltaChain must be a finite non-negative number');
});

test('applyDelta: a delta cut inside a copy opcode is a short read at its end, whichever byte is missing', () => {
  const base = new Uint8Array(300).fill(7);
  // copy off=0x0102 len=0x0201: opcode, two offset bytes, two length bytes
  const op = Uint8Array.of(0x80 | 0x01 | 0x02 | 0x10 | 0x20, 0x02, 0x01, 0x01, 0x02);
  const head = Uint8Array.of(0xac, 0x02, 0x80, 0x04); // base 300, result 512
  for (let cut = 1; cut < op.length; cut++) {
    const d = concat([head, op.subarray(0, cut)]);
    assert.equal(errOf(applyDeltaResult(base, d), 'pack_corrupt', `short read: need 1 bytes at ${d.length}, have ${d.length}`).reason, 'short_read');
  }
});

test('ofs-delta offsets are capped like size varints: an endless continuation is corrupt within ten bytes', () => {
  const endless = new Uint8Array(4096).fill(0x80);
  errOf(readOfsDeltaResult(endless, 0), 'pack_corrupt', 'pack: ofs delta offset longer than 64 bits');
  // ten bytes is the most a cap of 64 bits reads; the tenth may end it
  const ten = new Uint8Array(10).fill(0x80); ten[9] = 1;
  assert.equal(readOfsDeltaResult(ten, 0).ok, true);
  const eleven = new Uint8Array(11).fill(0x80); eleven[10] = 1;
  errOf(readOfsDeltaResult(eleven, 0), 'pack_corrupt', 'pack: ofs delta offset longer than 64 bits');
});

test('parsePack: the six pack types are accepted and 0 and 5 refused, by kind', async () => {
  const { pack } = await buildPack([{ type: TYPE.BLOB, data: te.encode('x') }]);
  for (const t of [0, 5]) {
    const p = Uint8Array.from(pack);
    p[PACK_HEADER_BYTES] = (p[PACK_HEADER_BYTES] & 0x8f) | (t << 4);
    errOf(parsePackResult(p, { verify: false }), 'pack_corrupt', `pack: bad object type ${t} at ${PACK_HEADER_BYTES}`);
  }
  const objs = [TYPE.COMMIT, TYPE.TREE, TYPE.BLOB, TYPE.TAG].map(type => ({ type, data: te.encode('') }));
  const all = await buildPack([...objs, { type: TYPE.BLOB, data: Uint8Array.of(0, 0), baseOid: hashObject('tag', new Uint8Array(0)) }]);
  const r = parsePackResult(all.pack);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.stats.byType, { commit: 1, tree: 1, blob: 1, tag: 1, ref_delta: 1 });
  assert.deepEqual([r.value.stats.full, r.value.stats.refDelta, r.value.stats.ofsDelta], [4, 1, 0]);
});

test('resolvePack hashes each full object once', async () => {
  const { pack } = await buildPack(Array.from({ length: 5 }, (_, i) => ({ type: TYPE.BLOB, data: te.encode(`blob ${i}`) })));
  const parsed = parsePack(pack);
  let reads = 0;
  // count reads of `data` on full objects: hashing reads it once; a second hash would read it again
  const counted = { ...parsed, objects: parsed.objects.map(o => { let d = o.data; return Object.defineProperty({ ...o }, 'data', { get() { reads++; return d; }, enumerable: true }); }) };
  const r = resolvePack(counted);
  assert.equal(r.objects.size, 5);
  assert.equal(reads, 10, 'each full object: one read to hash it, one to keep it as the resolved data');
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
      const got = inflate(z, 0, { expectedSize: data.length }).out;
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
        const back = encodeBytesResult(s);
        if (!back.ok || Buffer.compare(Buffer.from(back.value), Buffer.from(b)) !== 0) assert.fail(`encodeBytes does not invert decodeBytes on ${[...b].map(x => x.toString(16)).join(' ')}`);
      }
    }
  }
});

test('#84 encodeBytes: surrogate pairs at the edges are characters, lone ones outside the escape range are refused', () => {
  const ok = (s, bytes) => assert.deepEqual([...encodeBytesResult(s).value], bytes, JSON.stringify(s));
  ok('􏿿\udce9', [0xf4, 0x8f, 0xbf, 0xbf, 0xe9]); // U+10FFFF, the last pair, beside an escape
  ok('𐀀\udc80', [0xf0, 0x90, 0x80, 0x80, 0x80]);
  ok('\udc80\udcff', [0x80, 0xff]);
  const lone = (s, u) => assert.equal(errOf(encodeBytesResult(s, 'name'), 'bad_request', `name: lone surrogate U+${u} is no byte sequence`).what, 'name');
  lone('\ud800􏳩', 'D800'); // a high surrogate followed by a high one is no pair
  lone('\udc7f', 'DC7F');
  lone('\udd00', 'DD00');
  lone('\udbff', 'DBFF');
  assert.equal(errOf(encodeBytesResult('\udcc3\udca9', 'name'), 'bad_request', 'name: escaped bytes spell well-formed UTF-8; pass the characters').what, 'name');
  assert.equal(errOf(encodeBytesResult(null), 'bad_request', 'string must be a string').what, 'string');
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
  assert.equal(pktFinishResult(pktInit()).ok, true);
  assert.equal(pktFinishResult(pktStep(pktInit(), te.encode('0000')).state).ok, true);
  // a one-object pack whose object is an OFS_DELTA with offset 0
  const body = concat([te.encode('PACK'), Uint8Array.of(0, 0, 0, 2, 0, 0, 0, 1), Uint8Array.of(0x62, 0x00), zlib.deflateSync(Uint8Array.of(0, 0))]);
  const sha = (await import('node:crypto')).createHash('sha1').update(body).digest();
  errOf(parsePackResult(concat([body, sha])), 'pack_corrupt', `pack: ofs delta at ${PACK_HEADER_BYTES} is its own base`);
});

test('parsePackResult passes each part\'s Err through: object header, ofs offset, ref id, zlib body', () => {
  const crypto = globalThis.process.getBuiltinModule('node:crypto');
  const packOf = (...obj) => { const body = concat([te.encode('PACK'), Uint8Array.of(0, 0, 0, 2, 0, 0, 0, 1), ...obj]); return concat([body, crypto.createHash('sha1').update(body).digest()]); };
  // an object header that never ends: the varint cap, not a TypeError on a missing header
  errOf(parsePackResult(packOf(new Uint8Array(12).fill(0x80))), 'pack_corrupt', 'pack: size varint longer than 64 bits');
  // an ofs delta whose offset never ends
  errOf(parsePackResult(packOf(Uint8Array.of(0x62), new Uint8Array(12).fill(0x80))), 'pack_corrupt', 'pack: ofs delta offset longer than 64 bits');
  // a ref delta whose base id runs into the trailer: the id is read (the trailer is 20 bytes, an id's length), and the
  // object then has no zlib body before the end
  errOf(parsePackResult(packOf(Uint8Array.of(0x72), new Uint8Array(4))), 'pack_corrupt');
  // a blob whose zlib body is not zlib
  errOf(parsePackResult(packOf(Uint8Array.of(0x32), Uint8Array.of(0x78, 0x00, 0, 0, 0, 0))), 'pack_corrupt', 'zlib: bad header check');
});

test('inflateResult converts only its own STOP: a bug inside the block loop propagates', () => {
  // a plain array has no subarray: the stored block's copy throws a TypeError inside the loop, which is not an Err
  assert.throws(() => inflateResult([0b001, 1, 0, 0xfe, 0xff, 0x41], 0, { raw: true }), TypeError);
  // and a refusal is an Err, not a throw, from the same place
  errOf(inflateResult(Uint8Array.of(0b001, 1, 0, 0xfe, 0xfe, 0x41), 0, { raw: true }), 'pack_corrupt', 'inflate: stored length check failed');
  assert.equal(inflateResult(Uint8Array.of(0b001, 1, 0, 0xfe, 0xff, 0x41), 0, { raw: true }).value.out[0], 0x41);
});

test('readOfsDelta: an empty buffer is a short read, not offset 0', () => {
  assert.equal(errOf(readOfsDeltaResult(new Uint8Array(0), 0), 'pack_corrupt', 'short read: need 1 bytes at 0, have 0').reason, 'short_read');
  assert.equal(errOf(readOfsDeltaResult(Uint8Array.of(1, 2), 2), 'pack_corrupt', 'short read: need 1 bytes at 2, have 2').reason, 'short_read');
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
    const got = inflateResult(raw, 0, { raw: true });
    assert.equal(got.ok, true, `k=${k}: ${got.error?.message}`);
    assert.equal(Buffer.compare(Buffer.from(got.value.out), want), 0, `k=${k}`);
    assert.equal(got.value.consumed, raw.length, `k=${k}`);
  }
});
