// resolvePackRange (#248): every entry's oid, type and chain depth, applied over a RangeSource. Held to `git verify-pack
// -v` on packs git wrote (this repository's objects, REF-only as Artifacts sends them and with OFS deltas), to
// resolvePack (the buffered resolver) on a thin pack with its bases, and to itself across cache sizes and scans with
// oids on and off. Then the refusals: a thin pack without bases, a REF cycle, a chain past maxDeltaChain, work past the
// budget, a delta against the wrong base size, a spool that changed between reads, a source of the wrong size.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';
import { scanPackIndex } from '../src/packscanindex.js';
import { resolvePackRange, RESOLVED_ENTRY_BYTES, NO_BASE, THIN_BASE } from '../src/packrangeresolve.js';
import { rangeFromBytes } from '../src/rangesource.js';
import { parsePack, resolvePack, encodeObjHeader, zlibDeflate } from '../src/pack.js';
import { hashObject, TYPE } from '../src/objects.js';
import { Sha1, fromHex } from '../src/sha1.js';
import { concat, te } from '../src/bytes.js';
import { withLimits } from '../src/limits.js';
import { ok } from '../src/result.js';
import { RETAIN_BUDGET } from '../src/packstream.js';
import { PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, UINT32_BYTES, OBJ_CONTINUE, OBJ_SIZE_NEXT_MASK, OBJ_SIZE_NEXT_BASE } from '../src/format.js';
import { buildPacks } from './space/pack-fixtures.js';

const must = r => { if (r.ok) return r.value; throw Object.assign(new Error(r.error.message), { code: r.error.code }); };
const streamOf = bytes => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
const scan = (pack, oids = true) => scanPackIndex(streamOf(pack), { oids });
async function resolved(pack, opts = {}, oids = true) {
  return resolvePackRange(must(await scan(pack, oids)), rangeFromBytes(pack), opts);
}

const gitIn = (cwd, args, input) => execFileSync('git', args, { cwd, input, maxBuffer: 1 << 30 });
// git verify-pack -v, by offset: oid, type, and the chain depth (0 for a whole object).
function verifyPack(pack) {
  const dir = mkdtempSync(join(tmpdir(), 'ply-range-resolve-'));
  try {
    const file = join(dir, 'p.pack');
    writeFileSync(file, pack);
    gitIn(dir, ['index-pack', file]);
    const out = gitIn(dir, ['verify-pack', '-v', join(dir, 'p.idx')]).toString();
    const byOffset = new Map();
    for (const line of out.split('\n')) {
      const m = /^([0-9a-f]{40}) (commit|tree|blob|tag)\s+\d+ \d+ (\d+)(?: (\d+) ([0-9a-f]{40}))?/.exec(line);
      if (m) byOffset.set(Number(m[3]), { oid: m[1], type: TYPE[m[2].toUpperCase()], depth: m[4] === undefined ? 0 : Number(m[4]), base: m[5] ?? null });
    }
    return byOffset;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
// Every entry against git: oid, type, depth, and the base it was applied to.
function assertMatchesGit(pack, idx, res) {
  const git = verifyPack(pack);
  assert.equal(git.size, res.count);
  for (let i = 0; i < res.count; i++) {
    const g = git.get(idx.columns.offset[i]);
    assert.ok(g, `git has no object at ${idx.columns.offset[i]}`);
    assert.equal(res.oid(i).value, g.oid, `oid of entry ${i}`);
    assert.equal(res.type(i).value, g.type, `type of entry ${i}`);
    assert.equal(res.columns.depth[i], g.depth, `depth of entry ${i}`);
    const b = res.columns.base[i];
    if (g.base === null) assert.equal(b, NO_BASE);
    else assert.equal(res.oid(b).value, g.base, `base of entry ${i}`);
    assert.equal(res.find(g.oid).value, i);
  }
}
// This repository's history up to a fixed commit, not HEAD: the work a pack costs to resolve grows with the history
// packed while the default work limit (256 MiB) does not, so a pack of HEAD turns these tests red at some length of
// history. Measured with git 2.50: at this commit (318 commits, 3846 objects) the 64 KiB cache below does 239.8 MB of
// work and the default cache 69.2 MB; 17 commits later (3969 objects) they do 272.5 MB, past the limit, and 71.5 MB.
// Every full clone has the commit. A clone without it (a shallow one) packs its tip commit alone, which is all a
// depth-1 clone holds and does not grow with the history either.
const PACKED_COMMIT = 'ec337c5258839576e354ca9ea12d4f2404a3a75f';
const repoPack = args => {
  const held = gitIn(process.cwd(), ['cat-file', '--batch-check'], `${PACKED_COMMIT}\n`).toString().startsWith(`${PACKED_COMMIT} commit `);
  const objects = gitIn(process.cwd(), ['rev-list', '--objects', ...(held ? [PACKED_COMMIT] : ['--max-count=1', 'HEAD'])]);
  return new Uint8Array(gitIn(process.cwd(), ['pack-objects', '--stdout', '-q', '--depth=50', ...args], objects));
};

test("this repository's pack, REF_DELTA only (what Artifacts sends): every oid, type, depth and base matches git verify-pack", async () => {
  const pack = repoPack([]);
  const idx = must(await scan(pack));
  assert.equal([...idx.columns.storedType].includes(TYPE.OFS_DELTA), false);
  const unknownToScan = [...idx.columns.type].filter(t => t === 0).length;
  const t0 = performance.now();
  const res = must(await resolvePackRange(idx, rangeFromBytes(pack)));
  const ms = performance.now() - t0;
  assertMatchesGit(pack, idx, res);
  const deepest = Math.max(...res.columns.depth);
  console.log(JSON.stringify({ entries: res.count, packBytes: pack.length, unknownToScan, deepest, ms: Math.round(ms), mbPerS: +(pack.length / 1e6 / (ms / 1000)).toFixed(1), resolvedMBPerS: +(res.stats.applied / 1e6 / (ms / 1000)).toFixed(1), stats: res.stats }));
  assert.ok(res.count > 100, `only ${res.count} objects`);
  // CI's shallow checkout may hold no chain deeper than one; a full clone holds thousands
  if (unknownToScan > 0) assert.ok(deepest > 1);
  assert.equal(res.heldBytes, res.count * RESOLVED_ENTRY_BYTES);
});

test("this repository's pack with OFS deltas matches git verify-pack; scanned with oids off, the roots are hashed here", async () => {
  const pack = repoPack(['--delta-base-offset']);
  const idx = must(await scan(pack, false));
  const res = must(await resolvePackRange(idx, rangeFromBytes(pack)));
  assertMatchesGit(pack, idx, res);
});

test('the same result at every cache size, down to none (every base rebuilt over its chain)', async () => {
  const { packs } = buildPacks();
  // With no cache a chain is rebuilt from its root for every entry popped: quadratic in depth, so this repository's
  // pack (depth 50) runs at a small cache, not none. That cost is what the work budget bounds.
  for (const [bytes, sizes] of [[packs.chain.bytes, [0, 1024, 1 << 20]], [packs.ref.bytes, [0, 1024]], [repoPack([]), [64 << 10, 1 << 20]]]) {
    const idx = must(await scan(bytes));
    const full = must(await resolvePackRange(idx, rangeFromBytes(bytes)));
    for (const cacheBytes of sizes) {
      const r = must(await resolvePackRange(idx, rangeFromBytes(bytes), { cacheBytes }));
      assert.deepEqual(r.columns.oid, full.columns.oid);
      assert.deepEqual(r.columns.type, full.columns.type);
      assert.deepEqual(r.columns.depth, full.columns.depth);
      assert.deepEqual(r.columns.base, full.columns.base);
      assert.ok(r.stats.rebuilt >= full.stats.rebuilt, `cache ${cacheBytes}: rebuilt ${r.stats.rebuilt} < ${full.stats.rebuilt}`);
    }
  }
});

// Hand-built packs: { type, data } whole, { data, baseOid } REF_DELTA, { data, baseIndex } OFS_DELTA.
function encodeOfs(off) {
  const out = [off & OBJ_SIZE_NEXT_MASK];
  while ((off = Math.floor(off / OBJ_SIZE_NEXT_BASE)) > 0) out.unshift(OBJ_CONTINUE | (--off & OBJ_SIZE_NEXT_MASK));
  return Uint8Array.of(...out);
}
async function packOf(entries) {
  const parts = [Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION), new Uint8Array(UINT32_BYTES)];
  new DataView(parts[1].buffer).setUint32(0, entries.length);
  const offsets = [];
  let at = PACK_HEADER_BYTES;
  for (const e of entries) {
    offsets.push(at);
    const ofs = e.baseIndex !== undefined ? at - offsets[e.baseIndex] : undefined;
    const type = e.baseOid ? TYPE.REF_DELTA : ofs !== undefined ? TYPE.OFS_DELTA : e.type;
    const entry = concat([encodeObjHeader(type, e.data.length), ...(e.baseOid ? [fromHex(e.baseOid)] : ofs !== undefined ? [encodeOfs(ofs)] : []), await zlibDeflate(e.data)]);
    parts.push(entry);
    at += entry.length;
  }
  const body = concat(parts);
  return concat([body, new Sha1().update(body).digest()]);
}
const varint = n => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
// base -> target: copy the base's first `keep` bytes, insert the rest
function editDelta(base, target, keep = 0) {
  const ops = [];
  if (keep > 0) ops.push(0x80 | 0x10, keep & 0xff);
  for (let i = keep; i < target.length; i += 127) { const piece = target.subarray(i, i + 127); ops.push(piece.length, ...piece); }
  return Uint8Array.of(...varint(base.length), ...varint(target.length), ...ops);
}
// a REF chain of `depth` blobs, written deepest first so every delta's base comes later in the pack
function refChain(depth, seed = 'v') {
  const versions = Array.from({ length: depth + 1 }, (_, i) => te.encode(`${seed} ${'x'.repeat(40)} version ${i}\n`));
  const oids = versions.map(v => hashObject('blob', v));
  const entries = [];
  for (let i = depth; i >= 1; i--) entries.push({ data: editDelta(versions[i - 1], versions[i], 40), baseOid: oids[i - 1] });
  entries.push({ type: TYPE.BLOB, data: versions[0] });
  return { entries, versions, oids };
}

test('a REF chain 100 deep, every base later in the pack: resolved at maxDeltaChain 128, refused past maxDeltaChain', async () => {
  const { entries, oids } = refChain(100);
  const pack = await packOf(entries);
  const idx = must(await scan(pack));
  // the scan knows only the delta resting directly on the whole object
  assert.equal([...idx.columns.type].filter(t => t === 0).length, 99);
  const limits = withLimits({ maxDeltaChain: 128 });
  for (const cacheBytes of [0, 16 << 20]) {
    const res = must(await resolvePackRange(idx, rangeFromBytes(pack), { limits, cacheBytes }));
    for (let i = 0; i < 100; i++) {
      assert.equal(res.oid(i).value, oids[100 - i]);
      assert.equal(res.columns.depth[i], 100 - i);
      assert.equal(res.type(i).value, TYPE.BLOB);
    }
    assert.equal(res.oid(100).value, oids[0]);
    assert.equal(res.columns.depth[100], 0);
  }
  const deep = await resolvePackRange(idx, rangeFromBytes(pack), { limits: withLimits({ maxDeltaChain: 64 }) });
  assert.equal(deep.ok, false);
  assert.equal(deep.error.code, 'limit_exceeded');
  assert.equal(deep.error.what, 'delta chain depth');
});

test('a thin pack: refused without bases; with them, matches resolvePack (oid and chain at every offset)', async () => {
  const { packs, bases } = buildPacks();
  const pack = packs.thin.bytes;
  const without = await resolved(pack);
  assert.equal(without.ok, false);
  assert.equal(without.error.code, 'pack_corrupt');
  assert.match(without.error.message, /not found \(a thin pack needs bases\)/);
  const lookup = async oid => { await Promise.resolve(); const b = bases.get(oid); return b ? { type: TYPE[b.type.toUpperCase()], data: b.data } : null; };
  const res = must(await resolved(pack, { bases: lookup }));
  const oracle = must(resolvePack(must(parsePack(pack)), oid => { const b = bases.get(oid); return b ? { type: TYPE[b.type.toUpperCase()], data: b.data } : null; }));
  const idx = must(await scan(pack));
  const byOffset = new Map([...oracle.objects.values()].map(o => [o.offset, o]));
  for (let i = 0; i < res.count; i++) {
    const o = byOffset.get(idx.columns.offset[i]);
    assert.equal(res.oid(i).value, o.oid);
    assert.equal(res.columns.depth[i], o.chain);
  }
  assert.ok([...res.columns.base].includes(THIN_BASE));
  assert.ok(res.stats.thinBases > 0);
  // a base whose bytes do not hash to the oid that named it is refused
  const lying = await resolved(pack, { bases: oid => (bases.has(oid) ? { type: TYPE.BLOB, data: te.encode('not it') } : null) });
  assert.equal(lying.error.code, 'pack_corrupt');
  assert.match(lying.error.message, /hashes to/);
});

test('a thin base asked too early: the REF id named first is an in-pack delta that waits on the thin base', async () => {
  // b rests (REF) on a; a rests (REF) on z, which is outside the pack. Sorted by base id, b may be asked first.
  const z = te.encode(`zeta ${'z'.repeat(40)}\n`);
  const a = te.encode(`zeta ${'z'.repeat(40)}\nalpha\n`);
  const b = te.encode(`zeta ${'z'.repeat(40)}\nalpha\nbeta\n`);
  const [zo, ao] = [hashObject('blob', z), hashObject('blob', a)];
  const pack = await packOf([{ data: editDelta(a, b, 10), baseOid: ao }, { data: editDelta(z, a, 10), baseOid: zo }]);
  const asked = [];
  const res = must(await resolved(pack, { bases: oid => { asked.push(oid); return oid === zo ? { type: TYPE.BLOB, data: z } : null; } }));
  assert.equal(res.oid(0).value, hashObject('blob', b));
  assert.equal(res.oid(1).value, ao);
  assert.equal(res.columns.base[1], THIN_BASE);
  assert.equal(res.columns.base[0], 1);
  assert.ok(asked.includes(zo));
});

test('refusals: a REF cycle, work past the budget, a delta against the wrong base size, a source of the wrong size, a bad cacheBytes', async () => {
  // two deltas naming each other: neither oid can be known, so neither resolves
  const x = te.encode('x'.repeat(50));
  const cyc = await packOf([{ data: editDelta(x, x), baseOid: 'aa'.repeat(20) }, { data: editDelta(x, x), baseOid: 'bb'.repeat(20) }]);
  const r1 = await resolved(cyc);
  assert.equal(r1.error.code, 'pack_corrupt');
  assert.match(r1.error.message, /unresolved: ref delta base [0-9a-f]{40} not found/);
  // work: maxInflatedTotal is the budget when the pack is small; the chain needs more
  const { entries } = refChain(30);
  const chain = await packOf(entries);
  const r2 = await resolved(chain, { limits: withLimits({ maxInflatedTotal: 2000 }), budget: RETAIN_BUDGET, cacheBytes: 0 });
  assert.equal(r2.error.code, 'limit_exceeded');
  assert.equal(r2.error.what, 'resolve work bytes');
  // a delta whose declared base size is not its base's
  const base = te.encode('base bytes here');
  const wrong = await packOf([{ type: TYPE.BLOB, data: base }, { data: editDelta(te.encode('other length!'), base), baseIndex: 0 }]);
  const r3 = await resolved(wrong);
  assert.equal(r3.error.code, 'pack_corrupt');
  assert.match(r3.error.message, /delta: base size/);
  // the source is not the bytes the index read
  const idx = must(await scan(chain));
  const r4 = await resolvePackRange(idx, rangeFromBytes(chain.subarray(1)));
  assert.equal(r4.error.code, 'bad_request');
  const r5 = await resolvePackRange(idx, rangeFromBytes(chain), { cacheBytes: -1 });
  assert.equal(r5.error.code, 'bad_request');
});

test('a spool that changed between reads: a base read back again with other bytes is pack_corrupt, not a wrong oid', async () => {
  // a whole object with two OFS deltas resting on a third: with no cache, the whole object is read more than once
  const v0 = te.encode(`version zero ${'q'.repeat(60)}\n`);
  const v1 = te.encode(`version zero ${'q'.repeat(60)}\none\n`);
  const v2 = te.encode(`version zero ${'q'.repeat(60)}\none\ntwo\n`);
  const pack = await packOf([{ type: TYPE.BLOB, data: v0 }, { data: editDelta(v0, v1, 20), baseIndex: 0 }, { data: editDelta(v1, v2, 20), baseIndex: 1 }]);
  const idx = must(await scan(pack));
  const good = rangeFromBytes(pack);
  // the scan hashed v0; serve a different zlib member of the same length there on every read
  const altered = pack.slice();
  const first = { at: idx.columns.offset[0] + idx.columns.headerBytes[0], len: idx.columns.compressed[0] };
  const other = await zlibDeflate(te.encode(`version zerO ${'q'.repeat(60)}\n`));
  assert.equal(other.length, first.len, 'same-length member');
  altered.set(other, first.at);
  const changed = { size: pack.length, read: (o, l) => (o === first.at ? rangeFromBytes(altered).read(o, l) : good.read(o, l)) };
  const r = await resolvePackRange(idx, changed, { cacheBytes: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'pack_corrupt');
  assert.match(r.error.message, /read back as/);
  // the range source's own refusal is passed through
  const refusing = { size: pack.length, read: async () => ({ ok: false, error: Object.assign(new Error('gone'), { code: 'network' }) }) };
  assert.equal((await resolvePackRange(idx, refusing)).error.code, 'network');
  // and a well-behaved one resolves
  assert.equal(must(await resolvePackRange(idx, good, { cacheBytes: 0 })).oid(2).value, hashObject('blob', v2));
  void ok;
});

test('refusals at the read: work past the budget on a whole base, a member that ends early, a source that serves more, a thin base of a delta type or gone when asked again', async () => {
  const v0 = te.encode(`base ${Array.from({ length: 60 }, (_, i) => (i * 7919) % 1009).join(',')}\n`);
  const v1 = concat([v0, te.encode('one\n')]);
  const pack = await packOf([{ type: TYPE.BLOB, data: v0 }, { data: editDelta(v0, v1, 20), baseIndex: 0 }]);
  const idx = must(await scan(pack));
  const good = rangeFromBytes(pack);
  const first = { at: idx.columns.offset[0] + idx.columns.headerBytes[0], len: idx.columns.compressed[0] };
  const serving = (at, bytes) => ({ size: pack.length, read: (o, l) => (o === at ? Promise.resolve(ok(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }))) : good.read(o, l)) });
  // the whole base read back to apply the delta is, alone, past the work budget
  const work = await resolvePackRange(idx, good, { limits: withLimits({ maxInflatedTotal: v0.length - 1 }), budget: RETAIN_BUDGET, cacheBytes: 0 });
  assert.equal(work.error.code, 'limit_exceeded');
  assert.equal(work.error.what, 'resolve work bytes');
  // a zlib member that ends before the length the index gives (the rest of the range is junk)
  const short = await zlibDeflate(new Uint8Array(v0.length));
  assert.ok(short.length < first.len, 'a shorter member');
  const padded = new Uint8Array(first.len);
  padded.set(short);
  const early = await resolvePackRange(idx, serving(first.at, padded), { cacheBytes: 0 });
  assert.equal(early.error.code, 'pack_corrupt');
  assert.match(early.error.message, /zlib member is \d+ of \d+ bytes read, the index says \d+/);
  // a source that serves more than the range it was asked for
  const more = await resolvePackRange(idx, { size: pack.length, read: (o, l) => good.read(o, o === first.at ? l + 3 : l) }, { cacheBytes: 0 });
  assert.equal(more.error.code, 'pack_corrupt');
  assert.match(more.error.message, /range source gave more than \d+ bytes/);
  // b rests (REF) on a, a on z outside the pack: z handed back as a delta type, then z found once and not again
  const z = te.encode(`thin ${'t'.repeat(40)}\n`);
  const a = concat([z, te.encode('alpha\n')]);
  const b = concat([a, te.encode('beta\n')]);
  const [zo, ao] = [hashObject('blob', z), hashObject('blob', a)];
  const thin = await packOf([{ data: editDelta(a, b, 10), baseOid: ao }, { data: editDelta(z, a, 10), baseOid: zo }]);
  const typed = await resolved(thin, { bases: oid => (oid === zo ? { type: TYPE.OFS_DELTA, data: z } : null) });
  assert.equal(typed.error.code, 'pack_corrupt');
  assert.match(typed.error.message, /ref delta base [0-9a-f]{40} has type 6/);
  // Two chains rest on z. The last result something rests on is pinned and never made again; the other is, with no
  // cache, rebuilt from z, which is asked for a second time. (Before the pin, one chain was enough to ask twice.)
  const a2 = concat([z, te.encode('gamma\n')]);
  const b2 = concat([a2, te.encode('delta\n')]);
  const forked = await packOf([{ data: editDelta(a, b, 10), baseOid: ao }, { data: editDelta(z, a, 10), baseOid: zo }, { data: editDelta(a2, b2, 10), baseOid: hashObject('blob', a2) }, { data: editDelta(z, a2, 10), baseOid: zo }]);
  let answered = 0;
  const gone = await resolved(forked, { cacheBytes: 0, bases: oid => (oid === zo && answered++ === 0 ? { type: TYPE.BLOB, data: z } : null) });
  assert.equal(gone.error.code, 'pack_corrupt');
  assert.match(gone.error.message, /not found when asked again/);
});

// --- the work bound (review of ec337c5): what a resolve costs, counted by the test's own RangeSource ---
const TYPE_OF = { [TYPE.COMMIT]: 'commit', [TYPE.TREE]: 'tree', [TYPE.BLOB]: 'blob', [TYPE.TAG]: 'tag' };
// A source that counts the range reads made for each entry (by the offset its zlib member starts at).
function countingSource(pack, idx) {
  const memberAt = new Map();
  for (let i = 0; i < idx.columns.offset.length; i++) memberAt.set(idx.columns.offset[i] + idx.columns.headerBytes[i], i);
  const reads = new Map();
  const inner = rangeFromBytes(pack);
  return { reads, source: { size: inner.size, read: (offset, length) => { const i = memberAt.get(offset); reads.set(i, (reads.get(i) ?? 0) + 1); return inner.read(offset, length); } } };
}

test('one large file edited 80 times (real git history) resolves on default options: every oid, type and size is git\'s, and the work is within 2x the sum of object sizes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ply-range-history-'));
  try {
    const git = (args, input) => gitIn(dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.compression=1', ...args], input);
    git(['init', '-q', '.']);
    // a lockfile-like text file of about 4.3 MB; each commit changes one line
    const lines = Array.from({ length: 36000 }, (_, i) => `    "pkg-${i}": { "version": "1.0.${i}", "integrity": "sha512-${((i * 2654435761) >>> 0).toString(16).padStart(8, '0').repeat(8)}" },`);
    for (let c = 0; c < 80; c++) {
      lines[(c * 449) % lines.length] = `    "edited-${c}": { "version": "2.0.${c}" },`;
      writeFileSync(join(dir, 'package-lock.json'), lines.join('\n'));
      git(['add', 'package-lock.json']);
      git(['commit', '-q', '-m', `edit ${c}`]);
    }
    const pack = new Uint8Array(git(['pack-objects', '--all', '--stdout', '-q', '--delta-base-offset'], ''));
    // git's own list of the repository's objects: oid, type, size
    const want = git(['cat-file', '--batch-all-objects', '--batch-check']).toString().trim().split('\n');
    const sizeOf = new Map(want.map(l => { const [oid, , size] = l.split(' '); return [oid, Number(size)]; }));
    const sum = [...sizeOf.values()].reduce((a, b) => a + b, 0);
    // the defect needs a history whose objects sum past the old flat allowance (256 MiB) in a pack 32x smaller
    assert.ok(sum > 256 * 1024 * 1024 && pack.length * 32 < 256 * 1024 * 1024, `history ${sum} bytes in a pack of ${pack.length}`);
    const idx = must(await scan(pack));
    const { reads, source } = countingSource(pack, idx);
    const res = must(await resolvePackRange(idx, source));
    const got = Array.from({ length: res.count }, (_, i) => `${res.oid(i).value} ${TYPE_OF[res.type(i).value]} ${res.columns.size[i]}`);
    assert.deepEqual(got.toSorted(), want.toSorted());
    assertMatchesGit(pack, idx, res);
    // work, counted here: each read inflates its member (size by node:zlib) and, for a delta, produces its object (size by git)
    const byOffset = verifyPack(pack);
    let work = 0;
    for (const [i, times] of reads) {
      const at = idx.columns.offset[i];
      const member = inflateSync(pack.subarray(at + idx.columns.headerBytes[i], at + idx.columns.headerBytes[i] + idx.columns.compressed[i])).length;
      const g = byOffset.get(at);
      work += times * (member + (g.base === null ? 0 : sizeOf.get(g.oid)));
    }
    console.log(`large-file history: pack ${pack.length} B, ${res.count} objects, sum of sizes ${sum}, work ${work} (${(work / sum).toFixed(3)}x sum, ${(work / pack.length).toFixed(1)}x pack), reads ${[...reads.values()].reduce((a, b) => a + b, 0)}`);
    assert.ok(work <= 2 * sum, `work ${work} is over twice the sum of object sizes ${sum}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 600_000);

test('a linear chain of objects larger than the cache: every entry is read once, not once per link above it', async () => {
  const { entries, oids } = refChain(30);
  const pack = await packOf(entries);
  const idx = must(await scan(pack));
  const { reads, source } = countingSource(pack, idx);
  // each version is over 50 bytes, so none fits a 16-byte cache
  const res = must(await resolvePackRange(idx, source, { cacheBytes: 16 }));
  for (const oid of oids) assert.equal(res.find(oid).tag, 'some');
  // by hand: 31 entries (the root and 30 deltas); the root is read to start the chain and each delta once, to be
  // applied to the result made just before it
  assert.equal([...reads.values()].reduce((a, b) => a + b, 0), 31);
  assert.deepEqual([...new Set(reads.values())], [1]);
});

test('budget fields are checked where they enter: a ratio or work ceiling that is NaN, Infinity or negative is bad_request', async () => {
  const pack = await packOf(refChain(3).entries);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const ratio = await resolved(pack, { budget: { tag: 'work', ratio: bad, capObjects: false } });
    assert.equal(ratio.ok, false, `ratio ${bad} was accepted`);
    assert.equal(ratio.error.code, 'bad_request');
    const ceiling = await resolved(pack, { limits: { maxResolveWork: bad } });
    assert.equal(ceiling.ok, false, `maxResolveWork ${bad} was accepted`);
    assert.equal(ceiling.error.code, 'bad_request');
  }
  // the ceiling is hard: a chain that needs more work than it allows is refused. The ceiling is never below the
  // record's maxInflatedTotal, so both are lowered: max(10, 10) = 10
  const low = await resolved(pack, { limits: { maxResolveWork: 10, maxInflatedTotal: 10 } });
  assert.equal(low.error.code, 'limit_exceeded');
  assert.equal(low.error.what, 'resolve work bytes');
});

test('a range source that throws, rejects or errors its stream mid-read is a coded error, not a rejection', async () => {
  const pack = await packOf(refChain(3).entries);
  const idx = must(await scan(pack));
  const inner = rangeFromBytes(pack);
  const sources = {
    rejects: { size: inner.size, read: () => Promise.reject(new Error('connection reset')) },
    throws: { size: inner.size, read: () => { throw new Error('connection reset'); } },
    'errors its stream': { size: inner.size, read: async () => ok(new ReadableStream({ pull(c) { c.error(new Error('connection reset')); } })) },
  };
  for (const [name, source] of Object.entries(sources)) {
    const r = await resolvePackRange(idx, source);
    assert.equal(r.ok, false, name);
    assert.equal(r.error.code, 'network', name);
    assert.match(r.error.message, /connection reset/, name);
  }
  // a thin-base lookup that throws is the same kind of failure
  const thin = await packOf([{ data: editDelta(te.encode('x'.repeat(50)), te.encode('y'.repeat(50))), baseOid: 'aa'.repeat(20) }]);
  const t = await resolved(thin, { bases: () => { throw new Error('store down'); } });
  assert.equal(t.ok, false);
  assert.equal(t.error.code, 'network');
});
