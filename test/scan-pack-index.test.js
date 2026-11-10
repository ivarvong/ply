// scanPackIndex (#236): a pack read from a stream, indexed without resolving deltas or keeping objects. Held to
// describePack (the buffered layout) field by field, to `git verify-pack -v` on packs git wrote (this repository's
// objects, OFS and REF deltas), and to itself across every chunking (whole, one byte, random cuts) and both source
// kinds (ReadableStream, AsyncIterable). Then the refusals: an OFS base off an entry boundary, truncation, a bad
// trailer, corrupt zlib, a selected object over the cap, and the source cancelled on each.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Rng, splitRandom } from './fuzz/prng.js';
import { scanPackIndex, SCAN_INDEX_ENTRY_BYTES } from '../src/packscanindex.js';
import { describePack, encodeObjHeader, zlibDeflate } from '../src/pack.js';
import { hashObject, TYPE } from '../src/objects.js';
import { Sha1, fromHex } from '../src/sha1.js';
import { concat, te } from '../src/bytes.js';
import { withLimits } from '../src/limits.js';
import { PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, UINT32_BYTES, OBJ_CONTINUE, OBJ_SIZE_NEXT_MASK, OBJ_SIZE_NEXT_BASE } from '../src/format.js';
import { buildPacks } from './space/pack-fixtures.js';

const must = r => { if (r.ok) return r.value; throw Object.assign(new Error(r.error.message), { code: r.error.code }); };

function encodeOfs(off) {
  const out = [off & OBJ_SIZE_NEXT_MASK];
  while ((off = Math.floor(off / OBJ_SIZE_NEXT_BASE)) > 0) out.unshift(OBJ_CONTINUE | (--off & OBJ_SIZE_NEXT_MASK));
  return Uint8Array.of(...out);
}
// entries: { type, data } whole, { data, baseOid } REF_DELTA, { data, baseIndex } OFS_DELTA to an earlier entry,
// { data, ofsDistance } an OFS_DELTA with a raw distance (to aim it off an entry boundary).
async function packOf(entries) {
  const parts = [Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION), new Uint8Array(UINT32_BYTES)];
  new DataView(parts[1].buffer).setUint32(0, entries.length);
  const offsets = [];
  let at = PACK_HEADER_BYTES;
  for (const e of entries) {
    offsets.push(at);
    const ofs = e.baseIndex !== undefined ? at - offsets[e.baseIndex] : e.ofsDistance;
    const type = e.baseOid ? TYPE.REF_DELTA : ofs !== undefined ? TYPE.OFS_DELTA : e.type;
    const entry = concat([
      encodeObjHeader(type, e.data.length),
      ...(e.baseOid ? [fromHex(e.baseOid)] : ofs !== undefined ? [encodeOfs(ofs)] : []),
      await zlibDeflate(e.data),
    ]);
    parts.push(entry);
    at += entry.length;
  }
  const body = concat(parts);
  return concat([body, new Sha1().update(body).digest()]);
}
// A delta from base to target: copy nothing, insert the target (valid instructions; the scan never applies them).
const insertDelta = (base, target) => {
  const varint = n => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
  const ops = [];
  for (let i = 0; i < target.length; i += 127) { const piece = target.subarray(i, i + 127); ops.push(piece.length, ...piece); }
  return Uint8Array.of(...varint(base.length), ...varint(target.length), ...ops);
};

// Sources over the same chunks.
const streamOf = (chunks, onCancel = () => {}) => {
  let i = 0;
  return new ReadableStream({ pull(c) { if (i < chunks.length) c.enqueue(chunks[i++]); else c.close(); }, cancel() { onCancel(); } });
};
async function* iterOf(chunks) { for (const c of chunks) yield c; }
const feedings = (bytes, rng) => [[bytes], Array.from(bytes, b => Uint8Array.of(b)), splitRandom(rng, bytes, { allowEmpty: false })];

const plain = e => ({ ...e });
const rows = idx => [...idx.entries()].map(plain);

// The fields describePack and the scan share: the layout, and the resolved type and oid where the scan can know them.
function assertMatchesLayout(idx, layout) {
  assert.equal(idx.count, layout.count);
  assert.equal(idx.trailer, layout.trailer);
  assert.equal(idx.columns.offset.length, layout.objects.length);
  for (const [i, o] of layout.objects.entries()) {
    const found = idx.entry(i);
    assert.equal(found.tag, 'some', `entry ${i}`);
    const e = found.value;
    assert.equal(e.index, i);
    assert.equal(e.offset, o.offset, `offset of ${i}`);
    assert.equal(e.headerBytes, o.headerBytes, `headerBytes of ${i}`);
    assert.equal(e.compressed, o.compressed, `compressed of ${i}`);
    assert.equal(e.size, o.size, `size of ${i}`);
    assert.equal(e.storedType, o.wireType, `stored type of ${i}`);
    assert.equal(e.base.tag, o.base.tag, `base of ${i}`);
    if (o.base.tag === 'ofs') { assert.equal(e.base.offset, o.base.offset); assert.equal(idx.columns.offset[e.base.index], o.base.offset); }
    if (o.base.tag === 'ref') assert.equal(e.base.oid, o.base.oid);
    if (e.type !== null) assert.equal(e.type, o.type, `resolved type of ${i}`);
    if (e.oid !== null) assert.equal(e.oid, o.oid, `oid of ${i}`);
    if (o.base.tag === 'none') { assert.equal(e.type, o.wireType); assert.equal(e.base.tag, 'none'); }
  }
}

test('a pack of every whole type and an OFS chain matches describePack, for every chunking and both source kinds', async () => {
  const base = te.encode('the quick brown fox '.repeat(40));
  const v2 = te.encode('the quick brown fox jumps '.repeat(40));
  const v3 = te.encode('the quick brown fox jumps over '.repeat(40));
  const pack = await packOf([
    { type: TYPE.COMMIT, data: te.encode('tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor A <a@b> 0 +0000\ncommitter A <a@b> 0 +0000\n\nm\n') },
    { type: TYPE.TREE, data: new Uint8Array(0) },
    { type: TYPE.BLOB, data: base },
    { type: TYPE.TAG, data: te.encode('object 4b825dc642cb6eb9a060e54bf8d69288fbee4904\ntype tree\ntag t\ntagger A <a@b> 0 +0000\n\nt\n') },
    { data: insertDelta(base, v2), baseIndex: 2 },
    { data: insertDelta(v2, v3), baseIndex: 4 },
  ]);
  const layout = must(describePack(pack));
  const rng = new Rng(236);
  let reference = null;
  for (let round = 0; round < 8; round++) {
    for (const chunks of feedings(pack, rng)) {
      for (const source of [streamOf(chunks), iterOf(chunks)]) {
        const idx = must(await scanPackIndex(source, { oids: true }));
        assertMatchesLayout(idx, layout);
        assert.deepEqual([...idx.columns.type], [TYPE.COMMIT, TYPE.TREE, TYPE.BLOB, TYPE.TAG, TYPE.BLOB, TYPE.BLOB]);
        assert.equal(idx.bytes, pack.length);
        if (reference === null) reference = rows(idx);
        else assert.deepEqual(rows(idx), reference);
      }
    }
  }
});

test('REF_DELTA: a whole base earlier or later in the pack resolves with oids on; absent, a delta base, or oids off is unknown', async () => {
  const a = te.encode('alpha '.repeat(30));
  const b = te.encode('alpha beta '.repeat(30));
  const c = te.encode('alpha beta gamma '.repeat(30));
  const aOid = hashObject('blob', a);
  const bOid = hashObject('blob', b);
  const absent = 'ab'.repeat(20);
  const pack = await packOf([
    { data: insertDelta(a, b), baseOid: aOid },        // 0: base later (entry 1)
    { type: TYPE.BLOB, data: a },                      // 1: whole
    { data: insertDelta(a, c), baseOid: aOid },        // 2: base earlier
    { data: insertDelta(a, te.encode('three')), baseOid: absent },   // 3: base absent (thin)
    { data: insertDelta(b, te.encode('four')), baseOid: bOid },      // 4: base is entry 0, a delta: unknown without resolving
    // distinct results: describePack keys resolved objects by oid, and git never packs one object twice
    { data: insertDelta(c, te.encode('five')), baseIndex: 2 },   // 5: OFS onto a resolved REF delta
    { data: insertDelta(c, te.encode('six')), baseIndex: 3 },    // 6: OFS onto an unknown one
  ]);
  const on = must(await scanPackIndex(streamOf([pack]), { oids: true }));
  assert.deepEqual([...on.columns.type], [TYPE.BLOB, TYPE.BLOB, TYPE.BLOB, 0, 0, TYPE.BLOB, 0]);
  assert.deepEqual([...on.columns.baseIndex], [1, -1, 1, -1, -1, 2, 3]);
  const e0 = on.entry(0);
  assert.equal(e0.tag, 'some');
  assert.deepEqual(e0.value.base, { tag: 'ref', oid: aOid, index: 1 });
  assert.equal(e0.value.oid, null);
  assert.equal(on.entry(1).value.oid, aOid);
  assert.equal(on.entry(3).value.type, null);
  assert.equal(on.heldBytes, 7 * (SCAN_INDEX_ENTRY_BYTES + 20 + 20));
  const off = must(await scanPackIndex(streamOf([pack]), { oids: false }));
  assert.deepEqual([...off.columns.type], [0, TYPE.BLOB, 0, 0, 0, 0, 0]);
  assert.equal(off.entry(1).value.oid, null);
  assert.equal(off.heldBytes, 7 * (SCAN_INDEX_ENTRY_BYTES + 20));
  assertMatchesLayout(on, must(describePack(pack)));
  assert.equal(on.entry(7).tag, 'none');
  assert.equal(on.entry(-1).tag, 'none');
  assert.equal(on.entry(0.5).tag, 'none');
});

// git's own packs: the fixtures (every type, OFS, REF, an OFS chain, a thin pack) and this repository's objects, with
// and without --delta-base-offset, against describePack and `git verify-pack -v`.
const gitIn = (cwd, args, input) => execFileSync('git', args, { cwd, input, maxBuffer: 1 << 30 });
function verifyPack(pack) {
  const dir = mkdtempSync(join(tmpdir(), 'ply-scan-index-'));
  try {
    const file = join(dir, 'p.pack');
    writeFileSync(file, pack);
    gitIn(dir, ['index-pack', file]);
    const out = gitIn(dir, ['verify-pack', '-v', join(dir, 'p.idx')]).toString();
    const byOffset = new Map();
    for (const line of out.split('\n')) {
      const m = /^([0-9a-f]{40}) (commit|tree|blob|tag)\s+(\d+) (\d+) (\d+)/.exec(line);
      if (m) byOffset.set(Number(m[5]), { oid: m[1], type: TYPE[m[2].toUpperCase()], inPack: Number(m[4]) });
    }
    return byOffset;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
async function againstGit(pack) {
  const idx = must(await scanPackIndex(iterOf(splitRandom(new Rng(pack.length), pack, { allowEmpty: false })), { oids: true }));
  assertMatchesLayout(idx, must(describePack(pack)));
  const git = verifyPack(pack);
  assert.equal(git.size, idx.count);
  let known = 0;
  for (const e of idx.entries()) {
    const g = git.get(e.offset);
    assert.ok(g, `git has no object at ${e.offset}`);
    assert.equal(e.headerBytes + e.compressed, g.inPack, `size in pack at ${e.offset}`);
    if (e.oid !== null) assert.equal(e.oid, g.oid);
    if (e.type !== null) { assert.equal(e.type, g.type, `type at ${e.offset}`); known += 1; }
  }
  return { idx, known };
}

test('git-written fixture packs: every type, OFS, REF, an OFS chain, match describePack and git verify-pack', async () => {
  const { packs } = buildPacks();
  for (const name of ['full', 'ofs', 'ref', 'chain']) {
    const { idx, known } = await againstGit(packs[name].bytes);
    assert.equal(known, idx.count, `${name}: every type is known`);
  }
  // a thin pack: its REF bases are outside it, so those types are unknown, never guessed
  const thin = must(await scanPackIndex(streamOf([packs.thin.bytes]), { oids: true }));
  assertMatchesLayout(thin, must(describePack(packs.thin.bytes)));
  for (const e of thin.entries()) if (e.base.tag === 'ref' && e.base.index === -1) assert.equal(e.type, null);
});

test("this repository's objects, packed by git with OFS and with REF deltas, match describePack and git verify-pack", async () => {
  const objects = gitIn(process.cwd(), ['rev-list', '--objects', 'HEAD', '-n', '400']);
  for (const args of [['--delta-base-offset'], []]) {
    const pack = new Uint8Array(gitIn(process.cwd(), ['pack-objects', '--stdout', '-q', ...args], objects));
    const { idx, known } = await againstGit(pack);
    // CI checks out shallow: a few hundred objects there, thousands in a full clone
    assert.ok(idx.count > 100, `only ${idx.count} objects`);
    // OFS chains rest on whole objects in the pack: all known. REF chains know every type whose base is whole.
    if (args.length > 0) assert.equal(known, idx.count);
    else assert.ok(known > 0);
  }
});

test('a REF_DELTA-only pack (what Artifacts sends) resolves every depth-1 delta by default, at 71 bytes per entry', async () => {
  const objects = gitIn(process.cwd(), ['rev-list', '--objects', 'HEAD', '-n', '400']);
  const pack = new Uint8Array(gitIn(process.cwd(), ['pack-objects', '--stdout', '-q', '--depth=1', '--no-reuse-delta'], objects));
  const idx = must(await scanPackIndex(iterOf(splitRandom(new Rng(7), pack, { allowEmpty: false }))));
  const stored = [...idx.columns.storedType];
  assert.equal(stored.includes(TYPE.OFS_DELTA), false);
  const refs = stored.filter(t => t === TYPE.REF_DELTA).length;
  assert.ok(refs > 0, 'git wrote no REF deltas');
  // depth 1: every base is a whole object in the pack, so every type is known
  assert.equal([...idx.columns.type].filter(t => t === 0).length, 0);
  assert.equal(idx.heldBytes, idx.count * (SCAN_INDEX_ENTRY_BYTES + 20 + 20));
  const git = verifyPack(pack);
  for (const e of idx.entries()) assert.equal(e.type, git.get(e.offset).type);
});

test('selected content: whole objects the caller picks, in pack order, with their oid; others are not buffered', async () => {
  const { packs } = buildPacks();
  const seen = [];
  const idx = must(await scanPackIndex(streamOf([packs.full.bytes]), {
    oids: true,
    content: {
      select: h => h.type === TYPE.COMMIT || h.type === TYPE.TAG,
      take: async (o, data) => { await Promise.resolve(); seen.push({ ...o, data: new TextDecoder().decode(data) }); },
    },
  }));
  assert.deepEqual(seen.map(s => s.type), [TYPE.COMMIT, TYPE.TAG]);
  for (const s of seen) {
    const e = idx.entry(s.index).value;
    assert.equal(s.oid, e.oid);
    assert.equal(hashObject(s.type === TYPE.COMMIT ? 'commit' : 'tag', te.encode(s.data)), s.oid);
    assert.equal(s.size, e.size);
  }
  // over maxObjectSize: refused before it is buffered, the source cancelled
  let cancelled = 0;
  const big = must(describePack(packs.full.bytes)).objects.reduce((m, o) => Math.max(m, o.size), 0);
  const r = await scanPackIndex(streamOf(splitRandom(new Rng(3), packs.full.bytes, { allowEmpty: false }), () => { cancelled += 1; }), {
    limits: withLimits({ maxObjectSize: big - 1 }),
    content: { select: () => true, take: () => {} },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'limit_exceeded');
  assert.equal(r.error.what, 'selected object bytes');
  assert.equal(cancelled, 1);
});

test('refusals: OFS base off an entry boundary, truncation at every cut, a bad trailer, corrupt zlib; each cancels the source', async () => {
  const a = te.encode('alpha '.repeat(30));
  const good = await packOf([{ type: TYPE.BLOB, data: a }, { type: TYPE.BLOB, data: te.encode('b') }]);
  // the second object's OFS distance lands one byte into the first entry
  const off = await packOf([{ type: TYPE.BLOB, data: a }, { data: insertDelta(a, a), ofsDistance: 0 }]);
  const firstLen = must(describePack(good)).objects[0].headerBytes + must(describePack(good)).objects[0].compressed;
  const offBoundary = await packOf([{ type: TYPE.BLOB, data: a }, { data: insertDelta(a, a), ofsDistance: firstLen - 1 }]);
  const run = async bytes => scanPackIndex(streamOf([bytes]));
  const r1 = await run(offBoundary);
  assert.equal(r1.ok, false);
  assert.equal(r1.error.code, 'pack_corrupt');
  assert.match(r1.error.message, /ofs delta base not at object boundary 13/);
  assert.equal((await run(off)).error.code, 'pack_corrupt');
  // every truncation of a good pack is pack_corrupt
  for (let cut = 0; cut < good.length; cut++) {
    const r = await run(good.subarray(0, cut));
    assert.equal(r.ok, false, `cut ${cut}`);
    assert.equal(r.error.code, 'pack_corrupt', `cut ${cut}`);
  }
  const badTrailer = good.slice(); badTrailer[badTrailer.length - 1] ^= 1;
  assert.match((await run(badTrailer)).error.message, /trailer sha mismatch/);
  // verify off: the trailer is reported, not checked
  assert.equal(must(await scanPackIndex(streamOf([badTrailer]), { verify: false })).count, 2);
  const badZlib = good.slice(); badZlib[PACK_HEADER_BYTES + 3] ^= 0xff;
  assert.equal((await run(badZlib)).error.code, 'pack_corrupt');
  // a header that claims more objects than arrive
  const lying = good.slice(); new DataView(lying.buffer).setUint32(8, 3);
  assert.equal((await run(lying)).error.code, 'pack_corrupt');
  // a refusal before the input ends cancels the source: the rest of it is never read
  let cancelled = 0;
  let pulled = 0;
  const oneByte = Array.from(offBoundary, b => Uint8Array.of(b));
  const counting = new ReadableStream({ pull(c) { if (pulled < oneByte.length) c.enqueue(oneByte[pulled++]); else c.close(); }, cancel() { cancelled += 1; } });
  assert.equal((await scanPackIndex(counting)).error.code, 'pack_corrupt');
  assert.equal(cancelled, 1);
  assert.ok(pulled < oneByte.length, `read ${pulled} of ${oneByte.length} bytes`);
  // an AsyncIterable source is closed (return()) on a refusal
  let closed = false;
  async function* gen() { try { yield offBoundary; } finally { closed = true; } }
  assert.equal((await scanPackIndex(gen())).ok, false);
  assert.equal(closed, true);
  // limits a caller passes are checked before anything is read
  const badLimits = await scanPackIndex(streamOf([good]), { limits: { maxPackObjects: -1 } });
  assert.equal(badLimits.ok, false);
});

test('maxPackObjects refuses at the header; the columns never exceed the count that arrived', async () => {
  const pack = await packOf(Array.from({ length: 3000 }, (_, i) => ({ type: TYPE.BLOB, data: te.encode(`${i}`) })));
  const r = await scanPackIndex(streamOf([pack]), { limits: withLimits({ maxPackObjects: 2999 }) });
  assert.equal(r.error.code, 'limit_exceeded');
  // the options of one call never leak into the next: the defaults are a fresh record each time
  const idx = must(await scanPackIndex(streamOf([pack])));
  // oids on by default: 31 bytes of columns and a 20-byte oid per entry
  assert.equal(idx.heldBytes, 3000 * (SCAN_INDEX_ENTRY_BYTES + 20));
  assert.equal(idx.columns.size.length, 3000);
});
