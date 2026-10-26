// Branch and message assertions for the mutation gate. Prefix and round-trip tests kill the happy path;
// these kill a mutant that deletes one check, flips one comparison, or empties one error string.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { take, indexOfBytes, bytesOf, te, td, concat } from '../src/bytes.js';
import {
  parseTree, parseCommit, parseTag, parseIdent, assertFetched, encodeTree, encodeCommit, encodeTag, TYPE, hashObject,
} from '../src/objects.js';
import { pkt, pktInit, pktStep, pktFinish, FLUSH, DELIM } from '../src/pktline.js';
import {
  parsePack, applyDelta, makeDelta, readObjHeader, readOfsDelta, readUint32BE,
} from '../src/packresolve.js';
import { encodeObjHeader, encodeVarint, buildPack, zlibDeflate, copyOp } from '../src/pack.js';
import { inflate, huffBuild, adler32 } from '../src/inflate.js';
import { v2Init, v2Step, parseSideband, spInit, spStep, spFinish } from '../src/fetch.js';
import { parseLsRefLine } from '../src/lsrefs.js';
import { parseReportStatus } from '../src/push.js';
import { parseLine, parseFile, UNSET } from '../src/attributes.js';
import { kexInit, parseKexInit } from '../src/ssh.js';
import { parseSshUrl } from '../src/sshgit.js';
import { withLimits } from '../src/limits.js';
import {
  OID_BYTES, OID_HEX_CHARS, PACK_SIGNATURE, PACK_HEADER_BYTES, PACK_VERSION,
  DELTA_COPY, DELTA_COPY_OFF1, DELTA_COPY_OFF2, DELTA_COPY_OFF3, DELTA_COPY_OFF4,
  DELTA_COPY_LEN1, DELTA_COPY_LEN2, DELTA_COPY_LEN3, DELTA_SIZE_MIN, SIDEBAND_PACK, SIDEBAND_PROGRESS,
} from '../src/format.js';

const oid = n => (n.toString(16).padStart(2, '0').repeat(OID_BYTES));
const oidBytes = n => Uint8Array.from({ length: OID_BYTES }, () => n);
const throws = (fn, code, message) => assert.throws(fn, e => {
  assert.equal(e.code, code, e.message);
  assert.equal(e.message, message);
  return true;
});
const data = (...parts) => concat(parts.map(p => typeof p === 'string' ? te.encode(p) : p));

test('take, indexOfBytes, and bytesOf reject every out-of-range shape', () => {
  const buf = Uint8Array.of(1, 2, 3, 4);
  assert.deepEqual([...take(buf, 1, 2)], [2, 3]);
  assert.equal(take(buf, 4, 0).length, 0);
  assert.equal(take(buf, 0, 1, 'protocol')[0], 1);
  for (const [off, n] of [[1.5, 1], [0, 1.5], [NaN, 1], [0, NaN], [-1, 1], [0, -1], [3, 2], [5, 0]]) {
    throws(() => take(buf, off, n), 'pack_corrupt', `short read: need ${n} bytes at ${off}, have 4`);
  }
  throws(() => take(undefined, 0, 1), 'pack_corrupt', 'short read: need 1 bytes at 0, have 0');
  throws(() => take(null, 0, 1, 'protocol'), 'protocol', 'short read: need 1 bytes at 0, have 0');

  const hay = Uint8Array.of(1, 2, 1, 2, 3);
  assert.equal(indexOfBytes(hay, new Uint8Array(), 3), 3);
  assert.equal(indexOfBytes(hay, Uint8Array.of(9)), -1);
  assert.equal(indexOfBytes(hay, Uint8Array.of(1)), 0);
  assert.equal(indexOfBytes(hay, Uint8Array.of(2, 3)), 3);
  assert.equal(indexOfBytes(hay, Uint8Array.of(1, 2, 3), 1), 2);
  assert.equal(indexOfBytes(hay, Uint8Array.of(1, 9)), -1);

  const text = te.encode('ab');
  assert.deepEqual(bytesOf('ab'), text);
  assert.equal(bytesOf(text), text);
  assert.equal(bytesOf('').length, 0);
});

test('parseTree error strings and the boundaries next to them', () => {
  const id = oidBytes(4);
  const raw = (text, extra = id) => data(text, extra);
  const bad = [
    ['100644a\0', 'tree: malformed entry'],
    [' a\0', 'tree: empty mode'],
    ['100644 \0', 'tree: empty name'],
    ['8 a\0', 'tree: malformed mode'],
    ['19 a\0', 'tree: malformed mode'],
    ['0 a\0', 'tree: zero-padded mode'],
    ['0100644 a\0', 'tree: zero-padded mode'],
    ['100644 /x\0', 'tree: full pathname'],
    ['100644 a/b\0', 'tree: full pathname'],
    ['100644 .\0', 'tree: bad name'],
    ['100644 ..\0', 'tree: bad name'],
    ['100644 .git\0', 'tree: bad name'],
    ['100644 .GIT\0', 'tree: bad name'],
  ];
  for (const [text, message] of bad) throws(() => parseTree(raw(text)), 'pack_corrupt', message);
  throws(() => parseTree(raw('100644 a\0', id.subarray(0, OID_BYTES - 1))), 'pack_corrupt', `short read: need ${OID_BYTES} bytes at ${'100644 a\0'.length}, have ${'100644 a\0'.length + OID_BYTES - 1}`);
  throws(() => parseTree(data(raw('100644 b\0'), raw('100644 a\0'))), 'pack_corrupt', 'tree: not strictly sorted');
  throws(() => parseTree(data(raw('100644 a\0'), raw('100644 a\0', oidBytes(5)))), 'pack_corrupt', 'tree: not strictly sorted');
  assert.equal(parseTree(new Uint8Array(0)).length, 0);
  assert.equal(parseTree(raw('100664 a\0'))[0].mode, '100664');
  const tree = encodeTree([{ mode: '40000', name: 'd', oid: oid(1) }, { mode: '100644', name: 'd', oid: oid(2) }]);
  assert.deepEqual(parseTree(tree).map(e => e.name), ['d', 'd']);
});

test('commit and tag headers, idents, and assertFetched', () => {
  const author = 'Ada <ada@ex> 1700000000 +0000';
  const tree = oid(1);
  throws(() => parseCommit(te.encode('tree')), 'pack_corrupt', 'commit: truncated header line');
  throws(() => parseCommit(te.encode('nospace\n')), 'pack_corrupt', 'commit: truncated header line');
  const cont = parseCommit(te.encode(`tree ${tree}\n parent-sig\n\n`));
  assert.deepEqual(cont.extra, [' parent-sig']);
  assert.equal(cont.message, '');
  const blankFirst = parseCommit(te.encode('\n\nbody'));
  assert.deepEqual(blankFirst.head ?? blankFirst.extra, []);
  assert.equal(blankFirst.message, 'body');
  assert.equal(parseCommit(te.encode(`tree ${tree}\n`)).message, null);

  const commit = encodeCommit({ tree, parents: [oid(2)], author, message: 'hi\n' });
  assert.equal(parseCommit(commit).tree, tree);
  assert.deepEqual(parseCommit(commit).parents, [oid(2)]);
  throws(() => assertFetched('commit', te.encode(`author ${author}\ncommitter ${author}\n\n`)), 'pack_corrupt', 'commit: missing or bad tree');
  throws(() => assertFetched('commit', te.encode(`tree zz\nauthor ${author}\ncommitter ${author}\n\n`)), 'pack_corrupt', 'commit: missing or bad tree');
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\nparent zz\nauthor ${author}\ncommitter ${author}\n\n`)), 'pack_corrupt', 'commit: bad parent');
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\ncommitter ${author}\n\n`)), 'pack_corrupt', 'commit: missing author');
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\nauthor ${author}\n\n`)), 'pack_corrupt', 'commit: missing committer');
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\nauthor Ada\ncommitter ${author}\n\n`)), 'pack_corrupt', 'author: missing email');
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\nauthor Ada <ada@ex>\ncommitter ${author}\n\n`)), 'pack_corrupt', 'author: bad date');
  assertFetched('commit', commit);
  assert.equal(assertFetched('blob', te.encode('x')), undefined);
  assert.equal(assertFetched('ofs_delta', te.encode('x')), undefined);
  assert.equal(assertFetched('ref_delta', te.encode('x')), undefined);
  throws(() => assertFetched('submodule', te.encode('x')), 'pack_corrupt', 'object: bad type submodule');
  throws(() => assertFetched('tree', data(' a\0', oidBytes(1))), 'pack_corrupt', 'tree: empty mode');

  const tagger = author;
  const tag = encodeTag({ object: oid(3), type: 'commit', tag: 'v1', tagger, message: 'rel\n' });
  assert.equal(parseTag(tag).tag, 'v1');
  const first = parseTag(te.encode(`object ${oid(3)}\nobject ${oid(4)}\ntype commit\ntag v1\ntagger ${tagger}\n\n`));
  assert.equal(first.object, oid(3));
  assert.equal(first.type, 'commit');
  throws(() => assertFetched('tag', te.encode(`type commit\ntag v1\ntagger ${tagger}\n\n`)), 'pack_corrupt', 'tag: missing or bad object');
  throws(() => assertFetched('tag', te.encode(`object ${oid(3)}\ntag v1\ntagger ${tagger}\n\n`)), 'pack_corrupt', 'tag: missing type');
  throws(() => assertFetched('tag', te.encode(`object ${oid(3)}\ntype commit\ntagger ${tagger}\n\n`)), 'pack_corrupt', 'tag: missing name');
  throws(() => assertFetched('tag', te.encode(`object ${oid(3)}\ntype commit\ntag v1\n\n`)), 'pack_corrupt', 'tag: missing tagger');
  throws(() => assertFetched('tag', te.encode(`object ${oid(3)}\ntype commit\ntag v1\ntagger Ada\n\n`)), 'pack_corrupt', 'tagger: missing email');
  assertFetched('tag', tag);
  assert.equal(parseTag(te.encode(`object ${oid(3)}\ntype commit\ntag \ntagger ${tagger}\n\n`)).tag, '');

  assert.equal(parseIdent(1), null);
  assert.deepEqual(parseIdent('  bare name  '), { name: 'bare name', email: '', time: null, tz: '' });
  assert.deepEqual(parseIdent('foo >bar'), { name: 'foo >bar', email: '', time: null, tz: '' });
  assert.deepEqual(parseIdent('<ada@ex> 1700000000 +0000'), { name: '', email: 'ada@ex', time: '1700000000', tz: '+0000' });
  assert.deepEqual(parseIdent(' Ada <ada@ex> 1700000000 +0000'), { name: ' Ada', email: 'ada@ex', time: '1700000000', tz: '+0000' });
  assert.deepEqual(parseIdent('Ada  <ada@ex> nope +0100'), { name: 'Ada', email: 'ada@ex', time: null, tz: '+0100' });
});

test('pkt-line kinds, counters, and length errors', () => {
  const step = chunk => pktStep(pktInit(), chunk);
  throws(() => step(te.encode('zzzz')), 'protocol', 'bad pkt-line length at byte 0');
  throws(() => step(te.encode('0003')), 'protocol', 'invalid pkt-line length 3');
  const one = step(concat([te.encode('0002'), FLUSH, DELIM, pkt('ab')]));
  assert.deepEqual(one.frames.map(f => f.kind), ['end', 'flush', 'delim', 'data']);
  assert.equal(td.decode(one.frames[3].payload), 'ab');
  assert.equal(one.state.end, 1);
  assert.equal(one.state.flush, 1);
  assert.equal(one.state.delim, 1);
  assert.equal(one.state.data, 1);
  assert.equal(one.state.maxPayload, 2);
  const partial = pktStep(pktInit(), te.encode('000'));
  assert.equal(partial.frames.length, 0);
  throws(() => pktFinish(partial.state), 'protocol', 'trailing 3 bytes after last pkt-line');
  assert.equal(pktFinish(one.state).frames, 4);
  const longer = pktStep(one.state, pkt('abcd'));
  assert.equal(longer.state.maxPayload, 4);
  assert.equal(longer.state.data, 2);
});

test('pack header, ofs base, delta opcodes, and trailer', async () => {
  const blob = te.encode('hello');
  const { pack } = await buildPack([{ type: TYPE.BLOB, data: blob }]);
  const parsed = parsePack(pack);
  assert.equal(parsed.stats.version, PACK_VERSION);
  assert.equal(parsed.stats.count, 1);
  assert.equal(parsed.stats.full, 1);
  assert.equal(parsed.stats.ofsDelta, 0);
  assert.equal(parsed.stats.byType.blob, 1);
  assert.equal(parsed.stats.inflated, blob.length);
  assert.ok(parsed.stats.inflate.blocks >= 1);
  assert.deepEqual(parsed.objects[0].data, blob);

  const badSig = pack.slice();
  badSig.set(PACK_SIGNATURE.map((b, i) => (i === 0 ? b : 0)));
  throws(() => parsePack(badSig), 'pack_corrupt', 'pack: bad signature');
  const badVer = pack.slice();
  badVer[7] = 3;
  throws(() => parsePack(badVer), 'pack_corrupt', 'pack: unsupported version 3');
  throws(() => parsePack(pack.subarray(0, 4)), 'pack_corrupt', 'pack: bad signature');

  const za = await zlibDeflate(blob);
  const ha = encodeObjHeader(TYPE.BLOB, blob.length);
  const other = te.encode('hello!');
  const delta = makeDelta(blob, other).delta;
  const zd = await zlibDeflate(delta);
  const hd = encodeObjHeader(TYPE.OFS_DELTA, delta.length);
  const second = PACK_HEADER_BYTES + ha.length + za.length;
  const ofs = second - PACK_HEADER_BYTES;
  assert.ok(ofs < 128);
  const body = concat([
    Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION, 0, 0, 0, 2),
    ha, za, hd, Uint8Array.of(ofs), zd,
  ]);
  const { Sha1 } = await import('../src/sha1.js');
  const ofsPack = concat([body, new Sha1().update(body).digest()]);
  const ofsParsed = parsePack(ofsPack);
  assert.equal(ofsParsed.stats.full, 1);
  assert.equal(ofsParsed.stats.ofsDelta, 1);
  assert.equal(ofsParsed.objects[1].baseOffset, PACK_HEADER_BYTES);

  const early = concat([
    Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION, 0, 0, 0, 1),
    hd, Uint8Array.of(1), zd,
  ]);
  throws(() => parsePack(concat([early, new Sha1().update(early).digest()])), 'pack_corrupt', `pack: ofs delta base before pack start at ${PACK_HEADER_BYTES}`);

  const t5 = encodeObjHeader(5, blob.length);
  const badTypeBody = concat([Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION, 0, 0, 0, 1), t5, za]);
  throws(() => parsePack(concat([badTypeBody, new Sha1().update(badTypeBody).digest()])), 'pack_corrupt', `pack: bad object type 5 at ${PACK_HEADER_BYTES}`);
  throws(() => parsePack(pack, { limits: withLimits({ maxObjectSize: blob.length - 1 }) }), 'limit_exceeded', `pack object size ${blob.length} exceeds limit ${blob.length - 1}`);
  const flipped = ofsPack.slice();
  flipped[flipped.length - 1] ^= 1;
  assert.throws(() => parsePack(flipped), e => e.code === 'pack_corrupt' && /^pack: trailer sha mismatch [0-9a-f]{40} != [0-9a-f]{40}$/.test(e.message));
  assert.equal(parsePack(flipped, { verify: false }).objects.length, 2);
  const extra = concat([pack, Uint8Array.of(0)]);
  assert.throws(() => parsePack(extra), /expected trailer at/);

  assert.equal(readUint32BE(Uint8Array.of(0, 0, 1, 2), 0), 258);
  const hdr = readObjHeader(encodeObjHeader(TYPE.BLOB, 300), 0);
  assert.equal(hdr.type, TYPE.BLOB);
  assert.equal(hdr.size, 300);
  const ofsHdr = readOfsDelta(Uint8Array.of(0x81, 2), 0);
  assert.equal(ofsHdr.off, 258);

  throws(() => applyDelta(blob, new Uint8Array(DELTA_SIZE_MIN - 1)), 'pack_corrupt', 'delta: shorter than DELTA_SIZE_MIN');
  const four = new Uint8Array(DELTA_SIZE_MIN);
  throws(() => applyDelta(new Uint8Array(0), four), 'pack_corrupt', 'delta: reserved opcode 0');
  throws(() => applyDelta(te.encode('no'), delta), 'pack_corrupt', `delta: base size ${blob.length} != 2`);
  const applied = applyDelta(blob, makeDelta(blob, other).delta);
  assert.deepEqual(applied.out, other);
  assert.equal(applied.ops.insert + applied.ops.copy >= 1, true);

  const base = Uint8Array.of(9, 8, 7);
  const op = Uint8Array.of(
    DELTA_COPY | DELTA_COPY_OFF1 | DELTA_COPY_OFF2 | DELTA_COPY_OFF3 | DELTA_COPY_OFF4 | DELTA_COPY_LEN1 | DELTA_COPY_LEN2 | DELTA_COPY_LEN3,
    1, 0, 0, 0, 2, 0, 0,
  );
  const copyDelta = concat([encodeVarint(base.length), encodeVarint(2), op]);
  const copied = applyDelta(base, copyDelta);
  assert.deepEqual([...copied.out], [8, 7]);
  assert.equal(copied.ops.copy, 1);
  assert.equal(copied.ops.copyBytes, 2);
  throws(() => applyDelta(base, concat([encodeVarint(base.length), encodeVarint(1), Uint8Array.of(DELTA_COPY | DELTA_COPY_OFF1 | DELTA_COPY_LEN1, 5, 1)])), 'pack_corrupt', 'delta: copy out of range');
  throws(() => applyDelta(base, concat([encodeVarint(base.length), encodeVarint(1), Uint8Array.of(2, 9)])), 'pack_corrupt', 'delta: insert out of range');
  throws(() => applyDelta(base, concat([encodeVarint(base.length), encodeVarint(2), Uint8Array.of(1, 1)])), 'pack_corrupt', 'delta: produced 1 != 2');
  throws(() => applyDelta(base, makeDelta(base, base).delta, { maxResult: 0 }), 'limit_exceeded', `delta result size ${base.length} exceeds limit 0`);
  assert.ok(copyOp(1, 1)[0] & DELTA_COPY);
});

test('inflate stored, fixed, dynamic, and the header checks', () => {
  const h = huffBuild(Uint8Array.of(1, 2, 0, 2));
  assert.deepEqual([...h.count].slice(0, 4), [0, 1, 2, 0]);
  assert.deepEqual([...h.symbol].slice(0, 3), [0, 1, 3]);
  assert.equal(adler32(Uint8Array.of(1, 2, 3)), 851975);

  const stored = (bytes, final) => {
    const out = new Uint8Array(1 + 4 + bytes.length);
    out[0] = final ? 1 : 0;
    out[1] = bytes.length & 255;
    out[2] = bytes.length >> 8;
    out[3] = ~out[1] & 255;
    out[4] = ~out[2] & 255;
    out.set(bytes, 5);
    return out;
  };
  const two = inflate(concat([stored(Uint8Array.of(1, 2), false), stored(Uint8Array.of(3), true)]), 0, { raw: true });
  assert.deepEqual([...two.out], [1, 2, 3]);
  assert.equal(two.stats.blocks, 2);
  assert.equal(two.stats.stored, 2);
  throws(() => inflate(Uint8Array.of(1), 0, { raw: true }), 'pack_corrupt', 'inflate: truncated stored header');
  const badLen = stored(Uint8Array.of(1), true);
  badLen[3] ^= 1;
  throws(() => inflate(badLen, 0, { raw: true }), 'pack_corrupt', 'inflate: stored length check failed');
  throws(() => inflate(Uint8Array.of(7), 0, { raw: true }), 'pack_corrupt', 'inflate: invalid block type');
  throws(() => inflate(stored(Uint8Array.of(1, 2, 3), true).subarray(0, 6), 0, { raw: true }), 'pack_corrupt', 'inflate: truncated stored block');

  const hello = te.encode('hello hello hello hello');
  const fixed = inflate(new Uint8Array(zlib.deflateSync(hello)));
  assert.equal(fixed.stats.fixed, 1);
  assert.equal(fixed.stats.dynamic, 0);
  assert.equal(td.decode(fixed.out), td.decode(hello));
  assert.equal(fixed.stats.literals, 7);
  assert.equal(fixed.stats.matches, 1);
  assert.equal(fixed.stats.maxDist, 6);
  assert.equal(fixed.stats.maxLen, 16);
  const level0 = inflate(new Uint8Array(zlib.deflateSync(hello, { level: 0 })));
  assert.equal(level0.stats.stored, 1);
  let varied = '';
  for (let i = 0; i < 4000; i++) varied += `word${i % 700} `;
  const dynamic = inflate(new Uint8Array(zlib.deflateSync(Buffer.from(varied))));
  assert.equal(dynamic.stats.dynamic, 1);
  assert.equal(td.decode(dynamic.out), varied);

  const grown = inflate(new Uint8Array(zlib.deflateSync(Buffer.from('a'.repeat(10000)))));
  assert.equal(grown.out.length, 10000);
  throws(() => inflate(new Uint8Array(zlib.deflateSync(hello)), 0, { expectedSize: 1 }), 'pack_corrupt', 'inflate: output exceeds expected 1');
  assert.throws(() => inflate(new Uint8Array(zlib.deflateSync(hello)), 0, { expectedSize: hello.length + 10, maxOutput: 4 }), e => e.code === 'limit_exceeded' && e.message === `inflate: expected size ${hello.length + 10} exceeds limit 4`);
  throws(() => inflate(new Uint8Array(zlib.deflateSync(Buffer.from('a'.repeat(1000)))), 0, { maxOutput: 100 }), 'limit_exceeded', 'inflate: output exceeds limit 100');

  throws(() => inflate(Uint8Array.of(0x01, 0x00)), 'pack_corrupt', 'zlib: unsupported method 1');
  throws(() => inflate(Uint8Array.of(0x78, 0x00)), 'pack_corrupt', 'zlib: bad header check');
  throws(() => inflate(Uint8Array.of(0x78, 0x20)), 'pack_corrupt', 'zlib: preset dictionary not supported');
  const chopped = new Uint8Array(zlib.deflateSync(hello)).subarray(0, 8);
  throws(() => inflate(chopped), 'pack_corrupt', 'inflate: unexpected end of input');
  const mismatch = new Uint8Array(zlib.deflateSync(hello));
  mismatch[mismatch.length - 1] ^= 1;
  throws(() => inflate(mismatch), 'pack_corrupt', 'inflate: adler32 mismatch');
  assert.equal(inflate(mismatch, 0, { verifyAdler: false }).out.length, hello.length);
  const rawCut = new Uint8Array(zlib.deflateRawSync(hello)).subarray(0, 1);
  throws(() => inflate(rawCut, 0, { raw: true }), 'pack_corrupt', 'inflate: unexpected end of input');
});

test('v2 sections, sideband, and the single-object pack stream', async () => {
  const limits = withLimits({ maxSectionLines: 2 });
  let st = v2Init(limits);
  const feed = frame => { const r = v2Step(st, frame); st = r.state; return r; };
  const line = s => ({ kind: 'data', payload: te.encode(s) });
  throws(() => feed(line('ERR boom\n')), 'remote_error', 'remote: boom');
  st = v2Init(limits);
  assert.equal(feed(line('packfile')).state.phase, 'pack');
  assert.deepEqual(feed({ kind: 'flush' }).state.done, true);
  throws(() => feed(line('x')), 'protocol', 'v2: frame after flush');

  st = v2Init(limits);
  feed(line('acknowledgments'));
  assert.equal(feed(line('NAK')).state.acks[0], 'NAK');
  assert.equal(feed(line('ready')).state.ready, true);
  assert.equal(st.acks.length, 1);
  assert.equal(feed(line('NAK')).state.acks.length, 2);
  throws(() => feed(line('NAK')), 'limit_exceeded', 'acknowledgment lines 3 exceeds limit 2');

  st = v2Init();
  feed(line('shallow-info'));
  const id = oid(7);
  assert.deepEqual(feed(line(`shallow ${id}`)).state.shallow, [id]);
  assert.deepEqual(feed(line(`shallow ${id}`)).state.shallow, [id]);
  assert.deepEqual(feed(line(`unshallow ${oid(8)}`)).state.unshallow, [oid(8)]);
  assert.deepEqual(feed(line(`unshallow ${oid(8)}`)).state.unshallow, [oid(8)]);
  assert.equal(feed(line('other')).state.shallow.length, 1);
  st = v2Init(withLimits({ maxSectionLines: 1 }));
  feed(line('shallow-info'));
  feed(line(`shallow ${id}`));
  throws(() => feed(line('other')), 'limit_exceeded', 'shallow-info lines 2 exceeds limit 1');

  st = v2Init(limits);
  feed(line('wanted-refs'));
  const kept = feed(line('abc'));
  assert.equal(kept.state.section, 'wanted-refs');
  assert.equal(kept.pack, null);
  assert.equal(feed({ kind: 'delim' }).state.section, null);
  assert.equal(feed({ kind: 'end' }).state.done, false);

  st = v2Init(limits);
  feed(line('packfile'));
  assert.equal(feed({ kind: 'delim' }).pack, null);
  const body = te.encode('xyz');
  const band = n => ({ kind: 'data', payload: concat([Uint8Array.of(n), body]) });
  const pack = feed(band(SIDEBAND_PACK));
  assert.deepEqual(pack.pack, body);
  assert.equal(pack.state.band1, 3);
  assert.equal(pack.state.packFrames, 1);
  const progress = te.encode('p'.repeat(600));
  const prog = feed({ kind: 'data', payload: concat([Uint8Array.of(SIDEBAND_PROGRESS), progress]) });
  assert.equal(prog.state.band2, 600);
  assert.equal(prog.state.band2Frames, 1);
  assert.equal(prog.state.progress.length, 512);
  throws(() => feed({ kind: 'data', payload: te.encode('\x03  boom \n') }), 'remote_error', 'remote: boom');
  throws(() => feed({ kind: 'data', payload: Uint8Array.of(9, 1) }), 'protocol', 'v2: bad sideband 9');
  throws(() => parseSideband(new Uint8Array(0)), 'protocol', 'short read: need 1 bytes at 0, have 0');
  assert.equal(parseSideband(Uint8Array.of(SIDEBAND_PACK)).body.length, 0);
  assert.deepEqual(parseSideband(concat([Uint8Array.of(SIDEBAND_PROGRESS), te.encode('z')])).body, te.encode('z'));

  const blob = te.encode('pack-obj');
  const { pack: bytes } = await buildPack([{ type: TYPE.BLOB, data: blob }]);
  let sp = spInit();
  const early = spStep(sp, bytes.subarray(0, PACK_HEADER_BYTES));
  assert.equal(early.state.phase, 'header');
  const mid = spStep(early.state, bytes.subarray(PACK_HEADER_BYTES));
  sp = mid.state;
  const finished = spFinish(sp);
  assert.equal(finished.phase, 'body');
  assert.equal(finished.trailer.length, 40);
  throws(() => spFinish(spInit()), 'pack_corrupt', 'pack: truncated before object header');
  const sig = bytes.slice();
  sig[0] ^= 0xff;
  throws(() => spStep(spInit(), sig), 'pack_corrupt', 'pack: bad signature');
  const ver = bytes.slice();
  ver[7] = 9;
  throws(() => spStep(spInit(), ver), 'pack_corrupt', 'pack: bad version');
  const { pack: two } = await buildPack([{ type: TYPE.BLOB, data: blob }, { type: TYPE.BLOB, data: blob }]);
  throws(() => spStep(spInit(), two), 'pack_corrupt', 'pack: expected 1 object, got 2');
  const { pack: ref } = await buildPack([{ type: TYPE.BLOB, data: blob, baseOid: oid(1) }]);
  throws(() => spStep(spInit(), ref), 'pack_corrupt', 'pack: single-object pack is a delta');
  const torn = bytes.slice();
  torn[torn.length - 1] ^= 1;
  let bad = spInit();
  bad = spStep(bad, torn).state;
  assert.throws(() => spFinish(bad), e => e.code === 'pack_corrupt' && e.message.startsWith('pack: trailer ') && e.message.includes(' != '));
});

test('ls-refs lines and report-status', () => {
  const id = oid(4);
  assert.deepEqual(parseLsRefLine(`${id} refs/heads/main`), { oid: id, name: 'refs/heads/main' });
  assert.deepEqual(parseLsRefLine(`${id} HEAD symref-target:refs/heads/main peeled:${id}`), {
    oid: id, name: 'HEAD', 'symref-target': 'refs/heads/main', peeled: id,
  });
  assert.deepEqual(parseLsRefLine(`${id} refs/tags/v1 bare`), { oid: id, name: 'refs/tags/v1', bare: '' });
  throws(() => parseLsRefLine('ERR no such ref'), 'remote_error', 'remote: no such ref');
  throws(() => parseLsRefLine('nope'), 'protocol', 'ls-refs: malformed line "nope"');
  throws(() => parseLsRefLine(`${id} `), 'protocol', `ls-refs: malformed line ${JSON.stringify(`${id} `)}`);
  throws(() => parseLsRefLine(`${'ab'.repeat(32)} refs/heads/main`), 'unsupported', 'unsupported object-format: only sha1 repositories are supported');
  const upper = 'ab'.repeat(20).toUpperCase();
  throws(() => parseLsRefLine(`${upper} refs/heads/main`), 'protocol', `ls-refs: malformed line ${JSON.stringify(`${upper} refs/heads/main`)}`);
  const long = 'not a ref line '.repeat(8);
  throws(() => parseLsRefLine(long), 'protocol', `ls-refs: malformed line ${JSON.stringify(long.slice(0, 60))}`);

  const ok = parseReportStatus(['unpack ok', 'ok refs/heads/main', 'ok refs/heads/other']);
  assert.equal(ok.ok, true);
  assert.equal(ok.unpack, 'ok');
  assert.equal(ok.refs.length, 2);
  const ng = parseReportStatus(['unpack ok', 'ok refs/heads/main', 'ng refs/heads/other failed to lock', 'option old-oid abc', 'option quiet']);
  assert.equal(ng.ok, false);
  assert.equal(ng.refs[1].ref, 'refs/heads/other');
  assert.equal(ng.refs[1].reason, 'failed to lock');
  assert.equal(ng.refs[1].options['old-oid'], 'abc');
  assert.equal(ng.refs[1].options.quiet, true);
  assert.equal(parseReportStatus(['unpack error']).ok, false);
  assert.equal(parseReportStatus(['unpack ok']).unpack, 'ok');
  assert.equal(parseReportStatus(['ok refs/heads/main']).ok, false);
  assert.equal(parseReportStatus(['unpackok', 'ok refs/heads/main']).unpack, null);
});

test('ssh url, kex, and gitattributes lines', () => {
  assert.deepEqual(parseSshUrl('ssh://host/path'), { user: 'git', host: 'host', port: 22, path: '/path' });
  assert.deepEqual(parseSshUrl('ssh://u@host/p'), { user: 'u', host: 'host', port: 22, path: '/p' });
  assert.deepEqual(parseSshUrl('ssh://host:2222/p'), { user: 'git', host: 'host', port: 2222, path: '/p' });
  assert.deepEqual(parseSshUrl('ssh://u@h:2222/a/b'), { user: 'u', host: 'h', port: 2222, path: '/a/b' });
  assert.deepEqual(parseSshUrl('git@github.com:o/r.git'), { user: 'git', host: 'github.com', port: 22, path: 'o/r.git' });
  assert.deepEqual(parseSshUrl('host:name'), { user: 'git', host: 'host', port: 22, path: 'name' });
  throws(() => parseSshUrl('https://x/y'), 'bad_request', 'not an ssh git url: https://x/y');
  throws(() => parseSshUrl('ssh://host'), 'bad_request', 'not an ssh git url: ssh://host');
  throws(() => parseSshUrl('host:22/foo'), 'bad_request', 'not an ssh git url: host:22/foo');
  const cookie = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
  const kex = parseKexInit(kexInit(cookie));
  assert.deepEqual(kex.kex, ['curve25519-sha256', 'curve25519-sha256@libssh.org']);
  assert.deepEqual(kex.hostKey, ['ssh-ed25519']);
  assert.equal(kex.firstFollows, false);
  assert.deepEqual(kex.langCS, []);
  throws(() => parseKexInit(Uint8Array.of(1)), 'ssh', 'ssh: expected KEXINIT');

  const no = { macrosOk: false };
  const yes = { macrosOk: true };
  assert.deepEqual(parseLine('*.txt text', no), { pat: { pattern: '*.txt', negative: false, mustBeDir: false, nodir: true, prefix: 0, endsWith: true }, states: [['text', true]] });
  assert.deepEqual(parseLine('  *.txt text', no).pat.pattern, '*.txt');
  assert.equal(parseLine('# comment', no), null);
  assert.equal(parseLine('', no), null);
  assert.equal(parseLine('!*.txt text', no), null);
  assert.equal(parseLine('docs/ text', no).pat.mustBeDir, true);
  assert.equal(parseLine('docs/ text', no).pat.pattern, 'docs');
  assert.equal(parseLine('dir/file text', no).pat.nodir, false);
  assert.deepEqual(parseLine('*.c diff=cpp', no).states, [['diff', 'cpp']]);
  assert.deepEqual(parseLine('*.c -text', no).states, [['text', false]]);
  assert.deepEqual(parseLine('*.c !text', no).states, [['text', UNSET]]);
  assert.equal(parseLine('"*.txt" text', no).pat.pattern, '*.txt');
  assert.deepEqual(parseLine('[attr]binary -diff -merge -text', yes), { macro: 'binary', states: [['diff', false], ['merge', false], ['text', false]] });
  assert.equal(parseLine('[attr]binary -diff', no), null);
  assert.equal(parseLine('[attr] text', yes).pat.pattern, '[attr]');
  assert.equal(parseLine('*.c -', no), null);
  assert.equal(parseLine('*.c =novalue', no), null);
  assert.equal(parseLine('*.c builtin_x', no), null);
  assert.deepEqual(parseLine('*.c builtin_x', { macrosOk: false, reserveBuiltin: false }).states, [['builtin_x', true]]);
  assert.equal(parseLine('x'.repeat(2048), no), null);
  assert.equal(parseLine('x'.repeat(2047), no).pat.pattern.length, 2047);
  const file = parseFile('*.txt text\n*.c -text\n# c\n\n*.bin binary\0junk\n');
  assert.deepEqual(file.map(l => l.pat.pattern), ['*.txt', '*.c', '*.bin']);
  assert.deepEqual(parseFile(''), []);
  assert.equal(parseFile('*.txt text').length, 1);
  assert.equal(hashObject('blob', te.encode('x')).length, OID_HEX_CHARS);
});

test('boundaries between a thrown error and its neighbour', async () => {
  const author = 'Ada <ada@ex> 1700000000 +0000';
  const tree = oid(1);
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\nauthor Ada >x 1 +0000\ncommitter ${author}\n\n`)), 'pack_corrupt', 'author: missing email');
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\nauthor Ada <ada@ex 1 +0000\ncommitter ${author}\n\n`)), 'pack_corrupt', 'author: missing email');
  assertFetched('commit', te.encode(`tree ${tree}\nauthor <ada@ex> 1700000000 +0000\ncommitter ${author}\n\n`));
  assert.equal(parseCommit(new Uint8Array(0)).message, null);
  throws(() => parseTree(data('100644 a', oidBytes(4))), 'pack_corrupt', 'tree: malformed entry');
  throws(() => parseTree(data('g7 a\0', oidBytes(4))), 'pack_corrupt', 'tree: malformed mode');
  throws(() => parseTag(te.encode('tag')), 'pack_corrupt', 'tag: truncated header line');
  const extra = parseTag(te.encode(`object ${oid(3)}\ntype commit\ntag v1\nfoo bar\n\n`));
  assert.equal(extra.tagger, null);
  assert.deepEqual(extra.extra, ['foo bar']);
  const taggers = parseTag(te.encode(`object ${oid(3)}\ntype commit\ntag v1\ntagger ${author}\ntagger second <s@ex> 1 +0000\n\n`));
  assert.equal(taggers.tagger, author);
  assert.deepEqual(parseIdent('>a <b@c> 1 +0000'), { name: '>a', email: 'b@c', time: '1', tz: '+0000' });
  assert.deepEqual(parseIdent('Ada <a@b>'), { name: 'Ada', email: 'a@b', time: null, tz: '' });
  assert.deepEqual(parseIdent('Ada <a@b> 1  +0100'), { name: 'Ada', email: 'a@b', time: '1', tz: '+0100' });
  assert.equal(parseIdent('Ada <a@b> 12abc +0000').time, null);
  assert.equal(parseIdent('Ada <a@b> x12 +0000').time, null);
  assert.deepEqual(parseIdent('Ada <ada@ex'), { name: 'Ada <ada@ex', email: '', time: null, tz: '' });

  const blob = te.encode('hello');
  const { pack } = await buildPack([{ type: TYPE.BLOB, data: blob }]);
  assert.equal(parsePack(pack, { limits: withLimits({ maxObjectSize: blob.length }) }).objects.length, 1);
  const emptyBody = Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION, 0, 0, 0, 0);
  const { Sha1 } = await import('../src/sha1.js');
  const emptyPack = concat([emptyBody, new Sha1().update(emptyBody).digest()]);
  assert.equal(emptyPack.length, PACK_HEADER_BYTES + OID_BYTES);
  assert.equal(parsePack(emptyPack).stats.count, 0);
  const commitBytes = te.encode(`tree ${tree}\nauthor ${author}\ncommitter ${author}\n\n`);
  const tagBytes = te.encode(`object ${oid(3)}\ntype commit\ntag v\ntagger ${author}\n\n`);
  for (const [type, bytes] of [[TYPE.COMMIT, commitBytes], [TYPE.TAG, tagBytes], [0, blob]]) {
    const z = await zlibDeflate(bytes);
    const h = encodeObjHeader(type, bytes.length);
    const body = concat([Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION, 0, 0, 0, 1), h, z]);
    const built = concat([body, new Sha1().update(body).digest()]);
    if (type === 0) throws(() => parsePack(built), 'pack_corrupt', `pack: bad object type 0 at ${PACK_HEADER_BYTES}`);
    else assert.equal(parsePack(built).stats.full, 1);
  }
  const parsed = parsePack(pack);
  assert.ok(parsed.objects[0].headerBytes > 0 && parsed.objects[0].headerBytes < 16);
  assert.equal(parsed.stats.compressed > 0, true);
  assert.equal(parsed.stats.inflate.blocks > 0, true);

  const base = Uint8Array.of(1, 2, 3, 4);
  const exact = makeDelta(base, base).delta;
  assert.deepEqual(applyDelta(base, exact, { maxResult: base.length }).out, base);
  const inserted = applyDelta(base, concat([encodeVarint(base.length), encodeVarint(1), Uint8Array.of(1, 9)]));
  assert.equal(inserted.ops.insertBytes, 1);

  let sp = spInit();
  const opened = spStep(sp, pack.subarray(0, PACK_HEADER_BYTES + 1));
  assert.equal(opened.state.phase, 'body');
  assert.equal(spStep(spInit(), pack).state.bytes, pack.length);
  throws(() => spFinish(opened.state), 'pack_corrupt', 'pack: missing trailer');
  const streamed = spStep(opened.state, pack.subarray(PACK_HEADER_BYTES + 1));
  assert.equal(spFinish(streamed.state).zlibBytes, streamed.state.zlibBytes);
  assert.ok(streamed.state.zlibBytes > 0);

  throws(() => parseSshUrl('xsssh://host/path'), 'bad_request', 'not an ssh git url: xsssh://host/path');
  assert.equal(parseSshUrl('ssh://ab@host/p').user, 'ab');
  throws(() => parseSshUrl('/git@github.com:o/r.git'), 'bad_request', 'not an ssh git url: /git@github.com:o/r.git');
  throws(() => parseSshUrl('host:22'), 'bad_request', 'not an ssh git url: host:22');

  const no = { macrosOk: false };
  const yes = { macrosOk: true };
  assert.equal(parseLine('*.txt text=v', no).states[0][1], 'v');
  assert.equal(parseLine('*.txt eq=at=mid', no).states[0][1], 'at=mid');
  assert.equal(parseLine('"*.c" diff', no).pat.pattern, '*.c');
  assert.equal(parseLine('[attr]-no -text', yes), null);
  assert.equal(parseLine('[attr]ok -text', yes).macro, 'ok');
  assert.equal(parseFile('*.c text\0ignored').length, 1);
  assert.equal(parseFile('*.c text').length, 1);
  assert.deepEqual(parseFile('*.c text', { maxFile: 8 }), []);
  assert.equal(parseFile('*.c text', { maxFile: 9 }).length, 1);

  const id = oid(9);
  throws(() => parseLsRefLine(` ${id}`), 'protocol', `ls-refs: malformed line ${JSON.stringify(` ${id}`)}`);
  assert.equal(parseLsRefLine(`${id} refs/heads/a`).name, 'refs/heads/a');
  assert.equal(parseLsRefLine(`${id} refs/heads/a sym:val`).sym, 'val');
  const report = parseReportStatus(['unpack ok', 'ok refs/heads/main']);
  assert.equal(report.ok, true);
  assert.equal(report.refs[0].ref, 'refs/heads/main');
  const opted = parseReportStatus(['unpack ok', 'ok refs/heads/main', 'option alone']);
  assert.equal(opted.refs[0].options.alone, true);
  assert.equal(parseReportStatus(['option alone']).refs.length, 0);

  let st = v2Init();
  const line = s => ({ kind: 'data', payload: te.encode(s) });
  const end = v2Step(st, { kind: 'end' });
  assert.equal(end.state.done, false);
  st = v2Step(st, line('shallow-info')).state;
  st = v2Step(st, line(`unshallow ${id}`)).state;
  assert.deepEqual(st.unshallow, [id]);
  const nl = v2Step(st, line('shallow x\n')).state;
  assert.equal(nl.shallow[0], 'x');
});
