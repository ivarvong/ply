// Pure property tests: chunking invariance of every step function, codec roundtrips, oracle vs node:zlib/crypto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { Rng, splitRandom } from './fuzz/prng.js';
import { genBlob, genFind, genReplace, KNOBS, countOccurrences } from './fuzz/gen.js';
import { pkt, pkts, FLUSH, DELIM, pktInit, pktStep, pktFinish } from '../src/pktline.js';
import { inflate } from '../src/inflate.js';
import { Sha1, toHex } from '../src/sha1.js';
import { encodeObjHeader, applyDelta, spliceDelta, makeDelta, parsePack, resolvePack, buildPack } from '../src/pack.js';
import { parseTree, encodeTree, treeSort, hashObject, parseCommit, encodeCommit } from '../src/objects.js';
import { spInit, spStep, spFinish, scanInit, scanStep, scanFinish, MATCH_OFFSETS_KEPT } from '../src/edit.js';
import { v2Init, v2Step } from '../src/client.js';
import { concat, indexOfBytes } from '../src/bytes.js';

const N = parseInt(process.env.PROP_N ?? '200', 10);
const SEED = parseInt(process.env.SEED ?? '1', 10);
const forAll = (name, fn, n = N) => test(name, async () => { for (let i = 0; i < n; i++) { const rng = new Rng(SEED * 1000003 + i); try { await fn(rng, i); } catch (e) { e.message = `[case ${i} seed ${SEED}] ${e.message}`; throw e; } } });

forAll('sha1: chunked == node crypto', rng => {
  const d = rng.bytes(rng.int(0, 3000));
  const h = new Sha1(); for (const c of splitRandom(rng, d)) h.update(c);
  assert.equal(h.hex(), crypto.createHash('sha1').update(d).digest('hex'));
});

forAll('inflate: consumed exact, content equal, any level, trailing junk ignored', rng => {
  const cls = rng.pick(['tiny', 'text', 'random', 'repetitive', 'boundary', 'empty', 'binaryish']);
  const d = Buffer.from(genBlob(rng, cls));
  const level = rng.int(-1, 9);
  const z = zlib.deflateSync(d, { level, strategy: rng.pick([0, 0, 1, 2, 3, 4]) });
  const pre = rng.bytes(rng.int(0, 5)), junk = rng.bytes(rng.int(0, 40));
  const buf = concat([pre, z, junk]);
  const r = inflate(buf, pre.length, rng.bool() ? { expectedSize: d.length } : {});
  assert.equal(r.consumed, z.length);
  assert.ok(Buffer.from(r.out).equals(d));
  if (level === 0 && d.length) assert.ok(r.stats.stored > 0);
  // truncation must throw, never hang
  if (z.length > 3) assert.throws(() => inflate(buf.subarray(0, pre.length + z.length - rng.int(1, 3)), pre.length));
});

forAll('inflate: raw deflate', rng => {
  const d = rng.bytes(rng.int(0, 2000));
  const z = zlib.deflateRawSync(d);
  const r = inflate(concat([z, rng.bytes(3)]), 0, { raw: true });
  assert.equal(r.consumed, z.length); assert.deepEqual([...r.out], [...d]);
});

forAll('pkt-line: decode is chunking-invariant and inverts encode', rng => {
  const frames = Array.from({ length: rng.int(0, 30) }, () => rng.weighted([[{ kind: 'data', payload: rng.bytes(rng.pick([0, 1, 5, 100, 65516, rng.int(0, 65516)])) }, 6], [{ kind: 'flush' }, 2], [{ kind: 'delim' }, 1], [{ kind: 'end' }, 1]]));
  const enc = concat(frames.map(f => f.kind === 'data' ? pkt(f.payload) : f.kind === 'flush' ? FLUSH : f.kind === 'delim' ? DELIM : new TextEncoder().encode('0002')));
  let st = pktInit(); const got = [];
  for (const c of splitRandom(rng, enc)) { const r = pktStep(st, c); st = r.state; got.push(...r.frames); assert.ok(!st.carry || st.carry.length < 65520); }
  pktFinish(st);
  assert.equal(got.length, frames.length);
  got.forEach((g, i) => { assert.equal(g.kind, frames[i].kind); if (g.kind === 'data') assert.deepEqual([...g.payload], [...frames[i].payload]); });
  assert.equal(st.bytes, enc.length);
});

test('pkt-line: garbage throws', () => { assert.throws(() => pktStep(pktInit(), new TextEncoder().encode('zzzz'))); assert.throws(() => pktStep(pktInit(), new TextEncoder().encode('0003'))); });

forAll('objHeader: encode/parse roundtrip incl. huge sizes', rng => {
  const type = rng.int(1, 7), size = rng.pick([0, 1, 15, 16, 127, 128, 2 ** 20, 2 ** 31 + 5, 2 ** 40 + 3, rng.int(0, 1e9)]);
  const h = encodeObjHeader(type, size);
  let p = 0, c = h[p++], t = (c >> 4) & 7, s = c & 15, shift = 4;
  while (c & 0x80) { c = h[p++]; s += (c & 0x7f) * 2 ** shift; shift += 7; }
  assert.equal(t, type); assert.equal(s, size); assert.equal(p, h.length);
});

forAll('delta: spliceDelta/makeDelta ∘ applyDelta == reference splice', rng => {
  const base = genBlob(rng, rng.pick(['empty', 'tiny', 'text', 'random', 'repetitive', 'boundary']));
  const off = rng.int(0, base.length), oldLen = rng.int(0, base.length - off);
  const insert = rng.bytes(rng.pick([0, 1, 127, 128, 255, rng.int(0, 3000)]));
  const ref = concat([base.subarray(0, off), insert, base.subarray(off + oldLen)]);
  const d1 = spliceDelta({ baseLen: base.length, off, oldLen, insert });
  assert.equal(d1.resultLen, ref.length);
  // git's patch_delta rejects deltas < 4 bytes (DELTA_SIZE_MIN); applyDelta mirrors that so a pack we would reject, git rejects too
  if (d1.delta.length < 4) { assert.throws(() => applyDelta(base, d1.delta), /DELTA_SIZE_MIN/); assert.equal(ref.length, 0); return; }
  assert.deepEqual([...applyDelta(base, d1.delta).out], [...ref]);
  const d2 = makeDelta(base, ref);
  assert.deepEqual([...applyDelta(base, d2.delta).out], [...ref]);
  assert.ok(d2.delta.length <= insert.length + 2 * Math.ceil(base.length / 65536) * 8 + 20 + Math.ceil(insert.length / 127));
});

test('delta: 64K copy boundary and 0x10000 encoding', () => {
  const base = new Uint8Array(0x20001).map((_, i) => i & 0xff);
  const d = spliceDelta({ baseLen: base.length, off: 0x10000, oldLen: 0, insert: Uint8Array.of(9) });
  const r = applyDelta(base, d.delta);
  assert.equal(r.out.length, base.length + 1); assert.equal(r.out[0x10000], 9); assert.equal(r.ops.copy, 3);
});

forAll('scan: chunking-invariant, equals replace-all, offsets exact, carry bounded', rng => {
  const find = genFind(rng, rng.pick(KNOBS.find)), replace = genReplace(rng, rng.pick(KNOBS.replace), find);
  // build data with k occurrences at random spots (possibly adjacent/overlapping-adjacent)
  const k = rng.int(0, 4);
  let data = genBlob(rng, rng.pick(['empty', 'tiny', 'text', 'random', 'boundary']));
  if (countOccurrences(data, find)) data = rng.bytes(10);
  for (let i = 0; i < k; i++) { const o = rng.int(0, data.length); data = concat([data.subarray(0, o), find, data.subarray(o)]); }
  // reference
  const refOffs = []; const refParts = []; let p = 0, i;
  while ((i = indexOfBytes(data, find, p)) >= 0) { refOffs.push(i); refParts.push(data.subarray(p, i), replace); p = i + find.length; }
  refParts.push(data.subarray(p));
  const ref = concat(refParts);
  let st = scanInit({ find, replace }); const out = [];
  for (const c of splitRandom(rng, data, { maxChunks: 64 })) { const r = scanStep(st, c); st = r.state; out.push(...r.emit); assert.ok(st.carry.length <= find.length - 1); }
  const f = scanFinish(st); st = f.state; out.push(...f.emit);
  const got = concat(out);
  assert.deepEqual([...got], [...ref]);
  assert.deepEqual(st.matches, refOffs.slice(0, MATCH_OFFSETS_KEPT));
  assert.equal(st.count, refOffs.length);
  assert.equal(st.emitted, ref.length);
});

forAll('single-object pack stream: chunking-invariant, trailer verified, zlib bytes exact', async rng => {
  const data = genBlob(rng, rng.pick(['empty', 'tiny', 'text', 'random', 'boundary']));
  const { pack } = await buildPack([{ type: 3, data }]);
  let st = spInit(); const z = [];
  for (const c of splitRandom(rng, pack, { maxChunks: 40 })) { const r = spStep(st, c); st = r.state; z.push(...r.zlib); assert.ok(st.lag.length <= 20); }
  st = spFinish(st);
  const hdrLen = 12 + encodeObjHeader(3, data.length).length;
  assert.deepEqual([...concat(z)], [...pack.subarray(hdrLen, pack.length - 20)]);
  assert.equal(st.size, data.length); assert.equal(st.type, 3); assert.equal(st.trailer, toHex(pack.subarray(-20)));
  // corrupt one byte → must throw
  const bad = pack.slice(); bad[rng.int(0, bad.length - 1)] ^= 0x01;
  assert.throws(() => { let s = spInit(); const r = spStep(s, bad); s = r.state; spFinish(s); });
}, Math.min(60, N));

forAll('pack: buildPack ∘ parsePack ∘ resolvePack is identity (full + ref-delta + thin)', async rng => {
  const base = genBlob(rng, rng.pick(['tiny', 'text', 'random']));
  const target = concat([base.subarray(0, base.length >> 1), rng.bytes(rng.int(0, 200)), base.subarray(base.length >> 1)]);
  const baseOid = hashObject('blob', base);
  const inPack = rng.bool();
  const objs = [...(inPack ? [{ type: 3, data: base }] : []), { type: 3, data: makeDelta(base, target).delta, baseOid }, { type: 2, data: encodeTree([{ mode: '100644', name: 'f', oid: baseOid }]) }];
  const { pack } = await buildPack(objs);
  const parsed = parsePack(pack);
  assert.equal(parsed.stats.count, objs.length); assert.equal(parsed.stats.refDelta, 1);
  const r = resolvePack(parsed, oid => (oid === baseOid && !inPack ? { type: 3, data: base } : undefined));
  const t = r.objects.get(hashObject('blob', target));
  assert.ok(t); assert.deepEqual([...t.data], [...target]); assert.equal(t.chain, 1);
  assert.equal(r.stats.externalBases, inPack ? 0 : 1);
  // trailer corruption
  const bad = pack.slice(); bad[bad.length - 1] ^= 1; assert.throws(() => parsePack(bad));
}, Math.min(60, N));

forAll('tree: parse ∘ encode roundtrip and sort is total order with dir-as-slash rule', rng => {
  const names = ['a', 'a-b', 'a.b', 'a0', 'a_b', 'ab', 'A', 'a~', 'z', 'é', 'a b', 'a--', '-a', '.h', 'ä', '한', '🚀', 'b', 'a.', 'a/'.slice(0, 1)];
  const entries = []; const seen = new Set();
  for (let i = rng.int(1, 12); i > 0; i--) {
    const name = rng.pick(names); const mode = rng.pick(['100644', '100755', '40000', '120000', '160000']);
    const key = (mode === '40000' ? name + '/' : name); if (seen.has(key) || seen.has(name) || seen.has(name + '/')) continue; seen.add(key);
    entries.push({ mode, name, oid: toHex(rng.bytes(20)) });
  }
  const enc = encodeTree(entries);
  const parsed = parseTree(enc);
  assert.deepEqual(parsed.map(e => [e.mode, e.name, e.oid]), treeSort(entries).map(e => [e.mode, e.name, e.oid]));
  assert.deepEqual([...encodeTree(parsed)], [...enc]);
  parsed.forEach(e => assert.equal(toHex(enc.subarray(e.oidOffset, e.oidOffset + 20)), e.oid));
});

test('tree: rejects truncated OIDs, including a missing final byte', () => {
  assert.deepEqual(parseTree(new Uint8Array(0)), []);
  const entries = ['a', 'b'].map(name => ({ mode: '100644', name, oid: 'ab'.repeat(20) }));
  for (const count of [1, 2]) {
    const data = encodeTree(entries.slice(0, count));
    assert.deepEqual(parseTree(data).map(({ mode, name, oid }) => ({ mode, name, oid })), entries.slice(0, count));
    for (let missing = 1; missing <= 20; missing++) {
      assert.throws(() => parseTree(data.subarray(0, data.length - missing)), { code: 'pack_corrupt' }, `${count} entries, missing ${missing} OID bytes`);
    }
  }
});

forAll('commit: parse ∘ encode', rng => {
  const c = { tree: toHex(rng.bytes(20)), parents: Array.from({ length: rng.int(0, 3) }, () => toHex(rng.bytes(20))), author: 'A <a@x> 1700000000 +0000', committer: 'B <b@x> 1700000001 -0500', message: rng.pick(['m', 'multi\nline\n', 'no newline', '']) };
  const p = parseCommit(encodeCommit(c));
  assert.equal(p.tree, c.tree); assert.deepEqual(p.parents, c.parents); assert.equal(p.author, c.author); assert.equal(p.committer, c.committer);
  assert.equal(p.message.replace(/\n$/, ''), c.message.replace(/\n$/, ''));
});

test('v2 fetch state machine: sections → sideband → flush; band 3 throws; ERR throws', () => {
  const te = new TextEncoder();
  let st = v2Init(); const chunks = [];
  const feed = f => { const r = v2Step(st, f); st = r.state; if (r.pack) chunks.push(r.pack); };
  feed({ kind: 'data', payload: te.encode('shallow-info\n') }); feed({ kind: 'data', payload: te.encode('shallow abc\n') }); feed({ kind: 'delim' });
  feed({ kind: 'data', payload: te.encode('packfile\n') });
  feed({ kind: 'data', payload: concat([Uint8Array.of(1), te.encode('PACK')]) }); feed({ kind: 'data', payload: concat([Uint8Array.of(2), te.encode('progress')]) });
  feed({ kind: 'flush' });
  assert.deepEqual(st.shallow, ['abc']); assert.deepEqual(st.sections, ['shallow-info', 'packfile']); assert.equal(st.band1, 4); assert.equal(st.band2, 8); assert.ok(st.done);
  assert.equal(new TextDecoder().decode(concat(chunks)), 'PACK');
  assert.throws(() => v2Step(st, { kind: 'data', payload: te.encode('x') }));
  assert.throws(() => v2Step({ ...v2Init(), phase: 'pack' }, { kind: 'data', payload: concat([Uint8Array.of(3), te.encode('boom')]) }), /remote: boom/);
  assert.throws(() => v2Step(v2Init(), { kind: 'data', payload: te.encode('ERR nope\n') }), /remote: nope/);
});

test('ls-refs: sha256 object ids are rejected as unsupported before any fetch', async () => {
  const te2 = new TextEncoder();
  const body = concat([pkt(te2.encode(`${'ab'.repeat(32)} refs/heads/main\n`)), FLUSH]);
  const { GitHttp } = await import('../src/client.js');
  const { Tracer } = await import('../src/otel.js');
  const c = new GitHttp('http://x.invalid/r.git', { tracer: new Tracer(), fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' } }) });
  await assert.rejects(c.lsRefs(['refs/heads/main']), e => e.code === 'unsupported');
});
