// resolvePackRange's work bound and rebuild cost, on packs built here with node:zlib and node:crypto (no ply encoder):
// a delta bomb is refused at limits.maxResolveWork under each preset, and a forked delta family larger than the cache
// resolves within a small multiple of its object bytes.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TYPE } from '../src/objects.js';
import { scanPackIndex } from '../src/packscanindex.js';
import { resolvePackRange } from '../src/packrangeresolve.js';
import { rangeFromBytes } from '../src/rangesource.js';
import { DEFAULT_LIMITS, WORKER_LIMITS, withLimits, parseLimits } from '../src/limits.js';
import { RETAIN_BUDGET } from '../src/packstream.js';

const MIB = 1 << 20;
const cat = parts => { const o = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let at = 0; for (const p of parts) { o.set(p, at); at += p.length; } return o; };
const oidOf = data => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
function entryHeader(type, size) { const out = []; let b = (type << 4) | (size & 15); size = Math.floor(size / 16); while (size > 0) { out.push(b | 0x80); b = size & 0x7f; size = Math.floor(size / 128); } out.push(b); return Uint8Array.from(out); }
function ofsEnc(n) { const out = [n & 0x7f]; n = Math.floor(n / 128); while (n > 0) { n -= 1; out.unshift(0x80 | (n & 0x7f)); n = Math.floor(n / 128); } return Uint8Array.from(out); }
function varint(n) { const out = []; while (n >= 128) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } out.push(n); return out; }
function copyOp(off, size) { const bytes = []; let cmd = 0x80; for (let i = 0; i < 4; i++) { const v = (off >>> (8 * i)) & 0xff; if (v) { cmd |= 1 << i; bytes.push(v); } } for (let i = 0; i < 3; i++) { const v = (size >>> (8 * i)) & 0xff; if (v) { cmd |= 0x10 << i; bytes.push(v); } } return [cmd, ...bytes]; }
// entries: { data } (a blob) or { ofs: index of the base, delta }
function buildPack(entries) {
  const n = entries.length;
  const parts = [Uint8Array.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])];
  let at = 12; const offs = [];
  for (const e of entries) {
    offs.push(at);
    const body = deflateSync(e.ofs === undefined ? e.data : e.delta, { level: 1 });
    const head = e.ofs === undefined ? entryHeader(3, e.data.length) : cat([entryHeader(6, e.delta.length), ofsEnc(at - offs[e.ofs])]);
    parts.push(head, body); at += head.length + body.length;
  }
  const all = cat(parts);
  return cat([all, createHash('sha1').update(all).digest()]);
}
const streamOf = bytes => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });

// One `unit`-byte blob of zeros and `n` deltas on it, each a list of whole-blob copies declaring `result` bytes, the
// last 4 naming the delta so every result is a distinct object.
function bomb(n, unit, result) {
  const entries = [{ data: new Uint8Array(unit) }];
  for (let i = 0; i < n; i++) {
    const ops = [];
    for (let k = 0; k < result / unit - 1; k++) ops.push(...copyOp(0, unit));
    ops.push(...copyOp(0, unit - 4), 4, i & 255, (i >> 8) & 255, 0x55, 0xaa);
    entries.push({ ofs: 0, delta: Uint8Array.from([...varint(unit), ...varint(result), ...ops]) });
  }
  return buildPack(entries);
}
async function resolveBomb(pack, limits) {
  const idx = await scanPackIndex(streamOf(pack), { limits });
  assert.equal(idx.ok, true, idx.ok ? '' : idx.error.message);
  return resolvePackRange(idx.value, rangeFromBytes(pack), { limits });
}
// The refusal: at the ceiling, having done at most one delta (its instructions and its result) more than the ceiling.
function assertRefusedAt(r, ceiling, result) {
  assert.equal(r.ok, false, 'the bomb resolved');
  assert.equal(r.error.code, 'limit_exceeded');
  assert.equal(r.error.what, 'resolve work bytes');
  assert.equal(r.error.max, ceiling);
  assert.ok(r.error.got <= ceiling + result + 1024, `work ${r.error.got} ran past ${ceiling} by more than one delta`);
}

test('a delta bomb under WORKER_LIMITS is refused at 512 MiB of work, whatever the pack declares', { timeout: 120_000 }, async () => {
  // 40 deltas each declaring 16 MiB (WORKER_LIMITS.maxDeltaResult): 640 MiB of results from a pack of a few KB
  const pack = bomb(40, MIB, 16 * MIB);
  assert.ok(pack.length < 8192, `pack is ${pack.length} bytes`);
  // by hand: 8 x maxInflatedTotal (64 MiB) = 536,870,912
  assertRefusedAt(await resolveBomb(pack, WORKER_LIMITS), 536_870_912, 16 * MIB);
});

test('a delta bomb under DEFAULT_LIMITS is refused at 2 GiB of work', { timeout: 300_000 }, async () => {
  // 40 deltas each declaring 64 MiB (DEFAULT_LIMITS.maxDeltaResult): 2.5 GiB of results
  const pack = bomb(40, MIB, 64 * MIB);
  // by hand: 8 x maxInflatedTotal (256 MiB) = 2,147,483,648
  assertRefusedAt(await resolveBomb(pack, DEFAULT_LIMITS), 2_147_483_648, 64 * MIB);
});

test('the work ceiling follows the limits a caller gives: left out, it is 8 x their maxInflatedTotal', async () => {
  const pack = bomb(40, 64 * 1024, MIB);
  // by hand: 8 x 4 MiB = 33,554,432, for a partial record and for withLimits alike
  const partial = { maxInflatedTotal: 4 * MIB, maxDeltaResult: MIB, maxObjectSize: MIB };
  assertRefusedAt(await resolveBomb(pack, partial), 33_554_432, MIB);
  assertRefusedAt(await resolveBomb(pack, withLimits(partial)), 33_554_432, MIB);
  // given, it is what was given: 40 MiB of results pass under 64 MiB and are refused under 6 MiB
  const roomy = await resolveBomb(pack, { ...partial, maxResolveWork: 64 * MIB });
  assert.equal(roomy.ok, true);
  assert.equal(roomy.value.stats.workMax, 64 * MIB);
  assertRefusedAt(await resolveBomb(pack, { ...partial, maxResolveWork: 6 * MIB }), 6 * MIB, MIB);
  // given below the record's maxInflatedTotal (4 MiB), the bound is maxInflatedTotal: by hand, max(2 MiB, 4 MiB) = 4,194,304
  assertRefusedAt(await resolveBomb(pack, { ...partial, maxResolveWork: 2 * MIB }), 4_194_304, MIB);
  assert.equal(DEFAULT_LIMITS.maxResolveWork, 2_147_483_648);
  assert.equal(WORKER_LIMITS.maxResolveWork, 536_870_912);
});

test('maxResolveWork: null is the derived value, the same as leaving it out', async () => {
  // by hand: 8 x 4 MiB = 33,554,432, whatever the record is spread from
  const partial = { maxInflatedTotal: 4 * MIB, maxDeltaResult: MIB, maxObjectSize: MIB };
  for (const record of [{ ...partial, maxResolveWork: null }, { ...WORKER_LIMITS, ...partial, maxResolveWork: null }, { ...DEFAULT_LIMITS, ...partial, maxResolveWork: null }]) {
    const parsed = parseLimits(record);
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error.message);
    assert.equal(parsed.value.maxResolveWork, 33_554_432);
  }
  assert.equal(withLimits({ ...partial, maxResolveWork: null }).maxResolveWork, 33_554_432);
  assertRefusedAt(await resolveBomb(bomb(40, 64 * 1024, MIB), { ...partial, maxResolveWork: null }), 33_554_432, MIB);
});

test('withLimits(null) is the frozen defaults: null from an untyped caller is no overrides, it does not throw', () => {
  // every value written out from the documented defaults (README Limits; MiB = 1,048,576), none read from DEFAULT_LIMITS
  const defaults = {
    maxMergeBlobBytes: 8_388_608, maxObjectSize: 67_108_864, maxHarvestBytes: 33_554_432, maxPackBytes: 134_217_728, maxPushBytes: 134_217_728,
    maxDeltaResult: 67_108_864, maxDeltaChain: 64, maxInflatedTotal: 268_435_456, maxResolveWork: 2_147_483_648, maxPackObjects: 100_000,
    maxRefs: 10_000, maxRebaseCommits: 10_000, maxSectionLines: 1000, maxTreeEntries: 200_000, maxPathDepth: 128, maxPathComponent: 4096,
    maxMergeDepth: 1024, maxReportLines: 10_000, maxCommitParents: 10_000, maxLsRefsBytes: 134_217_728, requestTimeoutMs: 0,
    firstByteTimeoutMs: 60_000, idleTimeoutMs: 60_000,
  };
  const made = withLimits(null);
  assert.deepEqual({ ...made }, defaults);
  assert.equal(Object.isFrozen(made), true);
  const parsed = parseLimits(withLimits(null));
  assert.equal(parsed.ok, true);
  assert.deepEqual({ ...parsed.value }, defaults);
});

test('maxResolveWork is a limits key like any other: NaN, Infinity or negative is bad_request under either budget, and the refusal names limits.maxResolveWork', async () => {
  const pack = bomb(2, 1024, 1024);
  const idx = await scanPackIndex(streamOf(pack), {});
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, '100']) {
    for (const budget of [RETAIN_BUDGET, { tag: 'work', ratio: 32, capObjects: false }]) {
      const r = await resolvePackRange(idx.value, rangeFromBytes(pack), { limits: { maxResolveWork: bad }, budget });
      assert.equal(r.ok, false, `maxResolveWork ${bad} was accepted under ${budget.tag}`);
      assert.equal(r.error.code, 'bad_request');
      assert.equal(r.error.message, 'limits.maxResolveWork must be a finite non-negative number');
      assert.equal(r.error.what, 'maxResolveWork');
    }
    assert.equal(parseLimits({ maxResolveWork: bad }).ok, false);
  }
});

test('a forked family larger than the cache: a sibling that missed the cache costs one pass, not its whole chain again', async () => {
  // A spine 50 deep; at each level a second delta on the same base (written first) with one leaf on it: 151 distinct
  // objects of S bytes, depth 51, every one zeros but its last 4 bytes. The cache holds 16 of them.
  const S = 64 * 1024; const D = 50;
  const entries = [{ data: new Uint8Array(S) }];
  const want = [oidOf(new Uint8Array(S))];
  let tag = 1;
  const edit = () => {
    const t = tag++;
    const obj = new Uint8Array(S); obj.set([t & 255, (t >> 8) & 255, 0x55, 0xaa], S - 4);
    want.push(oidOf(obj));
    return Uint8Array.from([...varint(S), ...varint(S), ...copyOp(0, S - 4), 4, t & 255, (t >> 8) & 255, 0x55, 0xaa]);
  };
  let spine = 0;
  for (let k = 1; k <= D; k++) {
    entries.push({ ofs: spine, delta: edit() }); const e = entries.length - 1;
    entries.push({ ofs: spine, delta: edit() }); const s = entries.length - 1;
    entries.push({ ofs: e, delta: edit() });
    spine = s;
  }
  const pack = buildPack(entries);
  const idx = await scanPackIndex(streamOf(pack), {});
  assert.equal(idx.ok, true);
  const inner = rangeFromBytes(pack);
  let reads = 0;
  const source = { size: inner.size, read: (o, l) => { reads += 1; return inner.read(o, l); } };
  const r = await resolvePackRange(idx.value, source, { cacheBytes: 16 * S });
  assert.equal(r.ok, true, r.ok ? '' : r.error.message);
  // every oid, from node:crypto over the bytes the edits describe
  for (let i = 0; i < want.length; i++) assert.equal(r.value.oid(i).value, want[i], `oid of entry ${i}`);
  // by hand: 151 entries, 151 x S object bytes. Each object must be read and made once; twice that is the bound.
  assert.equal(want.length, 151);
  assert.ok(reads <= 2 * 151, `${reads} range reads for 151 entries`);
  assert.ok(r.value.stats.work <= 2 * 151 * S, `${r.value.stats.work} work bytes for ${151 * S} bytes of objects`);
});

test('a spread of WORKER_LIMITS with maxInflatedTotal raised to 1 GiB resolves a real git history of more than 512 MiB: the work bound is never below the record\'s maxInflatedTotal', { timeout: 600_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ply-range-spread-'));
  try {
    const git = (args, input) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.compression=1', ...args], { cwd: dir, input, maxBuffer: 1 << 30 });
    git(['init', '-q', '.']);
    // a lockfile-like text file of about 13 MB (under WORKER_LIMITS.maxObjectSize, 16 MiB); each commit changes one line
    const lines = Array.from({ length: 108_000 }, (_, i) => `    "pkg-${i}": { "version": "1.0.${i}", "integrity": "sha512-${((i * 2654435761) >>> 0).toString(16).padStart(8, '0').repeat(8)}" },`);
    for (let c = 0; c < 48; c++) {
      lines[(c * 449) % lines.length] = `    "edited-${c}": { "version": "2.0.${c}" },`;
      writeFileSync(join(dir, 'package-lock.json'), lines.join('\n'));
      git(['add', 'package-lock.json']);
      git(['commit', '-q', '-m', `edit ${c}`]);
    }
    const pack = new Uint8Array(git(['pack-objects', '--all', '--stdout', '-q', '--delta-base-offset'], ''));
    // git's own list of the repository's objects: oid, type, size
    const want = git(['cat-file', '--batch-all-objects', '--batch-check']).toString().trim().split('\n');
    const sum = want.reduce((a, l) => a + Number(l.split(' ')[2]), 0);
    // the case needs objects summing past the preset's maxResolveWork (512 MiB) and under the raised maxInflatedTotal (1 GiB)
    assert.ok(sum > 536_870_912 && sum < 1_073_741_824, `history ${sum} bytes in a pack of ${pack.length}`);
    // a consumer that never heard of maxResolveWork: the preset, with one key raised
    const limits = { ...WORKER_LIMITS, maxInflatedTotal: 1024 * MIB };
    const idx = await scanPackIndex(streamOf(pack), { limits });
    assert.equal(idx.ok, true, idx.ok ? '' : idx.error.message);
    const r = await resolvePackRange(idx.value, rangeFromBytes(pack), { limits });
    assert.equal(r.ok, true, r.ok ? '' : `${r.error.code}: ${r.error.message}`);
    const nameOf = { [TYPE.COMMIT]: 'commit', [TYPE.TREE]: 'tree', [TYPE.BLOB]: 'blob', [TYPE.TAG]: 'tag' };
    const got = Array.from({ length: r.value.count }, (_, i) => `${r.value.oid(i).value} ${nameOf[r.value.type(i).value]} ${r.value.columns.size[i]}`);
    assert.deepEqual(got.toSorted(), want.toSorted());
    // by hand: max(maxResolveWork 512 MiB, maxInflatedTotal 1 GiB) = 1,073,741,824, the bound main ec337c5 gave this record
    assert.equal(r.value.stats.workMax, 1_073_741_824);
    assert.ok(r.value.stats.work > 536_870_912, `work ${r.value.stats.work} did not pass the preset's 512 MiB`);
    console.log(`spread history: pack ${pack.length} B, ${r.value.count} objects, sum of sizes ${sum}, work ${r.value.stats.work}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
