// The planner (planPackBatches) and the builder (packSubset) agree: every batch a plan holds is a pack the builder
// writes and stock git accepts on top of exactly the earlier batches. The judge is git, never ply:
//   - the source is a real git pack with deep OFS_DELTA chains (`git repack -adf --depth=50 --window=50` over a file
//     edited in every commit, plus many small files)
//   - for crossBatchRef off and on and several budgets, each planned batch is built by packSubset and fed to
//     `git index-pack --strict --fix-thin` in a repository holding only the batches before it
//   - after the last batch `git fsck --strict` passes and the repository's objects (git cat-file --batch-all-objects)
//     are the source's
//   - a resolved index without ids: the plan fails before anything is pushed, and the builder refuses the same cut
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomFillSync } from 'node:crypto';
import { git, gitBuf, tmpRoot, makeBareRepo } from './server.js';
import { scanPackIndex } from '../src/packscanindex.js';
import { resolvePackRange } from '../src/packrangeresolve.js';
import { rangeFromBytes } from '../src/rangesource.js';
import { planPackBatches } from '../src/packplan.js';
import { packSubset } from '../src/packsubset.js';
import { TYPE } from '../src/objects.js';
import { unwrap } from './unwrap.js';

const ident = ['-c', 'user.name=a', '-c', 'user.email=a@x'];
const BIG = { maxRequestBytes: 1 << 30, maxObjects: 1 << 20, maxObjectBytes: 1 << 30, maxCompressedObjectBytes: 1 << 30, reserveBytes: 0, reserveObjects: 0 };
const VERSIONS = 24;
let root, cleanup, work, n = 0;
const src = {};
const streamOf = bytes => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
const drain = async stream => {
  const parts = [];
  const reader = stream.getReader();
  for (;;) { const r = await reader.read(); if (r.done) break; parts.push(Buffer.from(r.value)); }
  return Buffer.concat(parts);
};
// every object a repository holds, as git lists them: "<oid> <type>" lines, sorted
const objectsOf = dir => git(dir, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']).trim().split('\n').toSorted();

before(async () => {
  ({ root, cleanup } = tmpRoot());
  work = join(root, 'source');
  mkdirSync(join(work, 'small'), { recursive: true });
  git(work, ['init', '-q', '-b', 'main']);
  for (let i = 0; i < 30; i++) writeFileSync(join(work, 'small', `s${i}.txt`), `small file ${i}\n`);
  // 20 KB that does not compress; every commit replaces 1 KB of it, so each version is a ~1 KB delta on the one before
  const chain = new Uint8Array(20_000);
  randomFillSync(chain);
  for (let v = 0; v < VERSIONS; v++) {
    randomFillSync(chain, (v * 733) % 19_000, 1000);
    writeFileSync(join(work, 'chain.bin'), chain);
    git(work, ['add', '.']);
    git(work, [...ident, 'commit', '-q', '-m', `v${v}`]);
  }
  git(work, ['repack', '-adf', '--depth=50', '--window=50', '-q']);
  const dir = join(work, '.git', 'objects', 'pack');
  const file = readdirSync(dir).find(f => f.endsWith('.pack'));
  src.bytes = new Uint8Array(readFileSync(join(dir, file)));
  src.objects = objectsOf(work);
  src.idx = unwrap(await scanPackIndex(streamOf(src.bytes)));
  src.resolved = unwrap(await resolvePackRange(src.idx, rangeFromBytes(src.bytes)));
}, 120_000);
after(() => cleanup());

// Each batch of the plan built by packSubset as a transfer builds it, and judged by git on top of the earlier batches.
async function pushAll(plan, label) {
  const dst = makeBareRepo(root, `d${n++}`);
  for (const [k, batch] of plan.batches.entries()) {
    const built = await packSubset(rangeFromBytes(src.bytes), src.idx, batch.entries, { outsideBase: plan.crossBatchRef ? 'ref' : 'refuse', resolved: src.resolved });
    assert.ok(built.ok, `${label}: batch ${k}/${plan.batches.length} (${batch.entries.length} entries, refRewrites ${batch.refRewrites}) was planned but not built: ${built.ok ? '' : built.error.message}`);
    const bytes = await drain(built.value.stream);
    assert.equal(bytes.length, built.value.length, `${label}: batch ${k} length`);
    assert.ok(bytes.length <= batch.packBytes, `${label}: batch ${k} is ${bytes.length} bytes, planned at most ${batch.packBytes}`);
    // throws (non-zero exit) when git refuses the pack
    gitBuf(dst, ['index-pack', '--strict', '--fix-thin', '--stdin'], bytes);
  }
  git(dst, ['fsck', '--strict', '--no-dangling']);
  return objectsOf(dst);
}

test('the fixture: git wrote OFS_DELTA chains deep enough to cut below a delta base', () => {
  const c = src.idx.columns;
  const ofsOnDelta = [...src.idx.entries()].filter(e => e.base.tag === 'ofs' && c.storedType[e.base.index] === TYPE.OFS_DELTA);
  assert.ok(ofsOnDelta.length >= 3, `OFS deltas whose base is a delta: ${ofsOnDelta.length}`);
  assert.ok(Math.max(...src.resolved.columns.depth) >= 3, 'a chain at least 3 deep');
});

test('every planned batch of the whole pack is built and accepted by strict git; the destination ends with the source objects', async () => {
  let split = 0;
  for (const crossBatchRef of [false, true]) {
    for (const maxRequestBytes of [1 << 30, 60_000, 34_000, 27_000]) {
      const label = `cross ${crossBatchRef}, ${maxRequestBytes} bytes`;
      const plan = planPackBatches(src.idx, src.resolved, { budget: { ...BIG, maxRequestBytes }, crossBatchRef });
      // a refusal at plan time is the planner's to make (nothing was pushed); a plan must be buildable
      if (!plan.ok) { assert.equal(plan.error.code, 'limit_exceeded', `${label}: ${plan.error.message}`); continue; }
      if (plan.value.batches.some(b => b.refRewrites > 0)) split++;
      assert.deepEqual(await pushAll(plan.value, label), src.objects, label);
    }
  }
  assert.ok(split >= 2, `budgets that cut a delta family: ${split}`);
}, 300_000);

test('blobs only, a few objects per push: every cut of the OFS chain is built and accepted by strict git', async () => {
  const type = src.resolved.columns.type;
  const blobs = [...Array(src.idx.count).keys()].filter(i => type[i] === TYPE.BLOB);
  const want = src.objects.filter(l => l.endsWith(' blob'));
  for (const maxObjects of [2, 7]) {
    const label = `blobs, ${maxObjects} per push`;
    const plan = unwrap(planPackBatches(src.idx, src.resolved, { budget: { ...BIG, maxObjects }, select: blobs, crossBatchRef: true }));
    assert.ok(plan.batches.some(b => b.refRewrites > 0), `${label}: the chain is cut`);
    assert.deepEqual(await pushAll(plan, label), want, label);
  }
}, 300_000);

test('a REF_DELTA selected before its delta base is written after it: git, already holding the base, accepts the pack', async () => {
  // the same objects REF-only (what Cloudflare Artifacts sends): pack-objects without --delta-base-offset
  const head = git(work, ['rev-parse', 'HEAD']).trim();
  const bytes = new Uint8Array(gitBuf(work, ['pack-objects', '--revs', '--stdout', '-q'], `${head}\n`));
  const idx = unwrap(await scanPackIndex(streamOf(bytes)));
  const resolved = unwrap(await resolvePackRange(idx, rangeFromBytes(bytes)));
  const base = resolved.columns.base;
  // C rests on B, B is itself a delta on A; A is left out, so the pack is thin
  const cIdx = [...Array(idx.count).keys()].find(i => idx.columns.storedType[i] === TYPE.REF_DELTA && base[i] >= 0 && idx.columns.storedType[base[i]] === TYPE.REF_DELTA);
  assert.ok(cIdx !== undefined, 'a REF delta on a REF delta');
  const built = unwrap(await packSubset(rangeFromBytes(bytes), idx, [cIdx, base[cIdx]], { resolved }));
  const out = await drain(built.stream);
  assert.equal(out.length, built.length);
  // the receiver already has every object (B included). Stock git refuses the pack when C precedes B: resolving C it
  // appends B from its own store, then meets B in the pack ("The same object ... appears twice in the pack")
  const dst = makeBareRepo(root, `o${n++}`);
  gitBuf(dst, ['index-pack', '--stdin'], Buffer.from(bytes));
  gitBuf(dst, ['index-pack', '--strict', '--fix-thin', '--stdin'], out);
});

test('with `resolved`, a base at entry 0 selected after its delta is moved first (the base-first walk starts at index 0)', async () => {
  // a one-delta pack whose base is entry 0: an OFS delta on a whole object, the two written base first
  const base = src.resolved.columns.base;
  const d = [...Array(src.idx.count).keys()].find(i => src.idx.columns.storedType[i] === TYPE.OFS_DELTA && base[i] >= 0 && src.idx.columns.storedType[base[i]] !== TYPE.OFS_DELTA);
  assert.ok(d !== undefined, 'an OFS delta on a whole object');
  const two = unwrap(await packSubset(rangeFromBytes(src.bytes), src.idx, [base[d], d], {}));
  const bytes = new Uint8Array(await drain(two.stream));
  const idx = unwrap(await scanPackIndex(streamOf(bytes)));
  const resolved = unwrap(await resolvePackRange(idx, rangeFromBytes(bytes)));
  assert.deepEqual([idx.columns.storedType[1], resolved.columns.base[1]], [TYPE.OFS_DELTA, 0], 'entry 1 rests on entry 0');
  // the delta selected first: base first puts entry 0 before it, so the OFS base is written earlier and nothing is refused
  const built = unwrap(await packSubset(rangeFromBytes(bytes), idx, [1, 0], { resolved }));
  const out = await drain(built.stream);
  assert.equal(out.length, built.length);
  assert.deepEqual(Buffer.from(out), Buffer.from(bytes), 'the same two entries in the same order as the source pack');
  gitBuf(makeBareRepo(root, `z${n++}`), ['index-pack', '--strict', '--stdin'], out);
});

test('a resolved index that cannot name a cut base fails the plan (nothing is pushed), as the builder refuses it', async () => {
  const type = src.resolved.columns.type;
  const blobs = [...Array(src.idx.count).keys()].filter(i => type[i] === TYPE.BLOB);
  // a resolved index read back without its ids: the builder cannot write a REF_DELTA to a base it cannot name
  const noIds = { ...src.resolved, oid: () => ({ tag: 'none' }) };
  const plan = planPackBatches(src.idx, noIds, { budget: { ...BIG, maxObjects: 2 }, select: blobs, crossBatchRef: true });
  assert.equal(plan.ok, false);
  assert.equal(plan.error.code, 'bad_request');
  assert.match(plan.error.message, /OFS_DELTA cut from its base/);
  // and the builder, asked for such a cut without ids, refuses too (the two share one rule)
  const base = src.idx.columns.baseIndex;
  const cut = blobs.find(i => src.idx.columns.storedType[i] === TYPE.OFS_DELTA && src.idx.columns.storedType[base[i]] === TYPE.OFS_DELTA);
  const built = await packSubset(rangeFromBytes(src.bytes), src.idx, [cut], { outsideBase: 'ref', resolved: noIds });
  assert.equal(built.ok, false);
  assert.equal(built.error.code, 'bad_request');
  // a resolved index of another pack (another entry count) is refused before anything is read
  const other = await packSubset(rangeFromBytes(src.bytes), src.idx, [0], { resolved: { ...src.resolved, count: src.idx.count + 1 } });
  assert.equal(other.ok, false);
  assert.equal(other.error.what, 'pack subset resolved');
});

test('an id is asked of `resolved` only for a base outside the batch: none when every base is written beside its delta', async () => {
  // Expected values by hand: with one batch (or the whole pack selected) every OFS base is written in the same pack,
  // so no entry is rewritten as a REF_DELTA and no base id is ever needed: 0 lookups. main read an id only there.
  let asked = 0;
  const counting = { ...src.resolved, oid: i => { asked++; return src.resolved.oid(i); } };
  const whole = unwrap(planPackBatches(src.idx, counting, { budget: BIG, crossBatchRef: false }));
  assert.equal(whole.batches.reduce((a, b) => a + b.refRewrites, 0), 0);
  assert.equal(asked, 0, 'planPackBatches, families whole');
  unwrap(planPackBatches(src.idx, counting, { budget: BIG, crossBatchRef: true }));
  assert.equal(asked, 0, 'planPackBatches, crossBatchRef on, nothing cut');
  const all = [...Array(src.idx.count).keys()];
  const built = unwrap(await packSubset(rangeFromBytes(src.bytes), src.idx, all, { outsideBase: 'ref', resolved: counting }));
  assert.equal(asked, 0, 'packSubset, the whole pack');
  await built.stream.cancel();
  // and when the chain is cut the ids are asked for (the lookup is lazy, not gone)
  const type = src.resolved.columns.type;
  const blobs = all.filter(i => type[i] === TYPE.BLOB);
  const cut = unwrap(planPackBatches(src.idx, counting, { budget: { ...BIG, maxObjects: 2 }, select: blobs, crossBatchRef: true }));
  assert.ok(cut.batches.some(b => b.refRewrites > 0));
  assert.ok(asked > 0, 'a cut base is looked up');
});

test('a resolved index whose oid() is missing, throws, or answers anything but 40 lowercase hex is refused before a byte is read', async () => {
  const c = src.idx.columns;
  const type = src.resolved.columns.type;
  const all = [...Array(src.idx.count).keys()];
  const blobs = all.filter(i => type[i] === TYPE.BLOB);
  // an OFS_DELTA on an OFS_DELTA: selected alone, its base is outside the pack and can only be named by `resolved`
  const cut = blobs.find(i => c.storedType[i] === TYPE.OFS_DELTA && c.storedType[c.baseIndex[i]] === TYPE.OFS_DELTA);
  assert.ok(cut !== undefined);
  // the base's id as git names it (verify-pack -v lists "<oid> <type> <size> <size-in-pack> <offset> ..."), not ply
  const dir = join(work, '.git', 'objects', 'pack');
  const listed = git(work, ['verify-pack', '-v', join(dir, readdirSync(dir).find(f => f.endsWith('.idx')))]).split('\n').map(l => l.split(/\s+/u));
  const real = listed.find(f => Number(f[4]) === c.offset[c.baseIndex[cut]])[0];
  assert.match(real, /^[0-9a-f]{40}$/u);
  let reads = 0;
  const bytes = rangeFromBytes(src.bytes);
  const source = { size: bytes.size, read: (o, l) => { reads++; return bytes.read(o, l); } };
  const some = value => () => ({ tag: 'some', value });
  const bad = {
    'no oid()': undefined,
    'oid is not a function': real,
    'oid() throws': () => { throw new Error('boom'); },
    'oid() answers nothing': () => undefined,
    'not hex': some('z'.repeat(40)),
    '39 hex': some(real.slice(1)),
    '41 hex': some(`${real}0`),
    'uppercase hex': some('ABCDEF0123'.repeat(4)),
    'hex with a newline': some(`${real.slice(1)}\n`),
    'a number': some(7),
    'bytes': some(new Uint8Array(20)),
  };
  for (const [label, oid] of Object.entries(bad)) {
    const resolved = { ...src.resolved, oid };
    const plan = planPackBatches(src.idx, resolved, { budget: { ...BIG, maxObjects: 2 }, select: blobs, crossBatchRef: true });
    assert.equal(plan.ok, false, `${label}: planned`);
    assert.equal(plan.error.code, 'bad_request', label);
    const built = await packSubset(source, src.idx, [cut], { outsideBase: 'ref', resolved });
    assert.equal(built.ok, false, `${label}: built`);
    assert.equal(built.error.code, 'bad_request', label);
    assert.equal(built.error.what, 'pack subset base', label);
  }
  assert.equal(reads, 0, 'nothing was read for a refused selection');
  // the control: the same cut with git's own id is planned, built, and a pack strict git accepts on top of the source
  const built = unwrap(await packSubset(source, src.idx, [cut], { outsideBase: 'ref', resolved: { ...src.resolved, oid: some(real) } }));
  const out = await drain(built.stream);
  assert.equal(out.length, built.length);
  const dst = makeBareRepo(root, `v${n++}`);
  gitBuf(dst, ['index-pack', '--stdin'], Buffer.from(src.bytes));
  gitBuf(dst, ['index-pack', '--strict', '--fix-thin', '--stdin'], out);
});

test('an id is asked of `resolved` once per rewritten entry, and the answer that was checked is the one the header carries', async () => {
  const c = src.idx.columns;
  const type = src.resolved.columns.type;
  const blobs = [...Array(src.idx.count).keys()].filter(i => type[i] === TYPE.BLOB);
  const cut = blobs.find(i => c.storedType[i] === TYPE.OFS_DELTA && c.storedType[c.baseIndex[i]] === TYPE.OFS_DELTA);
  assert.ok(cut !== undefined);
  // the base's id as git names it (verify-pack -v: "<oid> <type> <size> <size-in-pack> <offset> ..."), not ply
  const dir = join(work, '.git', 'objects', 'pack');
  const listed = git(work, ['verify-pack', '-v', join(dir, readdirSync(dir).find(f => f.endsWith('.idx')))]).split('\n').map(l => l.split(/\s+/u));
  const real = listed.find(f => Number(f[4]) === c.offset[c.baseIndex[cut]])[0];
  assert.match(real, /^[0-9a-f]{40}$/u);
  // oid() answers git's id on its first `valid` calls, then `later`: not an id, or the well-formed id of no object
  for (const [valid, later] of [[1, 'z'.repeat(40)], [2, 'z'.repeat(40)], [1, '1'.repeat(40)]]) {
    const label = `${valid} valid, then ${later.slice(0, 4)}`;
    let calls = 0;
    const resolved = { ...src.resolved, oid: () => ({ tag: 'some', value: ++calls <= valid ? real : later }) };
    // a Result API: a rejection (a TypeError out of the layout) fails the test here, an errored stream at drain
    const built = await packSubset(rangeFromBytes(src.bytes), src.idx, [cut], { outsideBase: 'ref', resolved });
    assert.equal(built.ok, true, `${label}: ${built.ok ? '' : built.error.message}`);
    const out = await drain(built.value.stream);
    // by hand: one entry is selected and it is rewritten, so one id is asked for, once
    assert.equal(calls, 1, `${label}: oid() calls`);
    assert.equal(out.length, built.value.length, label);
    // the 20 bytes git names the base by are in the one header written
    assert.ok(out.includes(Buffer.from(real, 'hex')), `${label}: the header carries git's id`);
    const dst = makeBareRepo(root, `w${n++}`);
    gitBuf(dst, ['index-pack', '--stdin'], Buffer.from(src.bytes));
    gitBuf(dst, ['index-pack', '--strict', '--fix-thin', '--stdin'], out);
  }
});

test('an exception out of resolved.oid() is the cause of a coded refusal from packSubset and planPackBatches, never swallowed', async () => {
  const c = src.idx.columns;
  const type = src.resolved.columns.type;
  const blobs = [...Array(src.idx.count).keys()].filter(i => type[i] === TYPE.BLOB);
  const budget = { ...BIG, maxObjects: 2 };
  // an honest plan says which entry is cut from its base (an OFS_DELTA whose stored base is in another batch)
  const honest = unwrap(planPackBatches(src.idx, src.resolved, { budget, select: blobs, crossBatchRef: true }));
  const batchOf = new Map(honest.batches.flatMap((b, k) => b.entries.map(i => [i, k])));
  const cut = blobs.find(i => c.storedType[i] === TYPE.OFS_DELTA && batchOf.get(c.baseIndex[i]) !== batchOf.get(i));
  assert.ok(cut !== undefined);
  const cutBase = c.baseIndex[cut];
  // the expected cause is the test's own object: the refusal must carry this very Error, not a copy or its message
  const marker = new Error('caller boom');
  const throwers = {
    'for every entry': () => { throw marker; },
    'only for the cut base': i => { if (i === cutBase) throw marker; return src.resolved.oid(i); },
  };
  for (const [label, oid] of Object.entries(throwers)) {
    const resolved = { ...src.resolved, oid };
    const built = await packSubset(rangeFromBytes(src.bytes), src.idx, [cut], { outsideBase: 'ref', resolved });
    assert.equal(built.ok, false, `packSubset, oid() throws ${label}`);
    assert.equal(built.error.code, 'bad_request', label);
    assert.equal(built.error.what, 'pack subset base', label);
    assert.equal(built.error.cause, marker, `packSubset, oid() throws ${label}: the cause`);
    const plan = planPackBatches(src.idx, resolved, { budget, select: blobs, crossBatchRef: true });
    assert.equal(plan.ok, false, `planPackBatches, oid() throws ${label}`);
    assert.equal(plan.error.code, 'bad_request', label);
    assert.equal(plan.error.cause, marker, `planPackBatches, oid() throws ${label}: the cause`);
  }
});

test('an oid() that returns nothing is refused with a message that says so, not one that says it threw', async () => {
  const c = src.idx.columns;
  const type = src.resolved.columns.type;
  const blobs = [...Array(src.idx.count).keys()].filter(i => type[i] === TYPE.BLOB);
  const budget = { ...BIG, maxObjects: 2 };
  const honest = unwrap(planPackBatches(src.idx, src.resolved, { budget, select: blobs, crossBatchRef: true }));
  const batchOf = new Map(honest.batches.flatMap((b, k) => b.entries.map(i => [i, k])));
  const cut = blobs.find(i => c.storedType[i] === TYPE.OFS_DELTA && batchOf.get(c.baseIndex[i]) !== batchOf.get(i));
  assert.ok(cut !== undefined);
  // The expected words are the owner's decision, not the code's: nothing was thrown, so the refusal neither says
  // 'threw' nor carries a cause (the TypeError ply itself would raise reading `.tag` of nothing is not the caller's).
  for (const [label, oid] of Object.entries({ 'undefined': () => undefined, 'null': () => null })) {
    const resolved = { ...src.resolved, oid };
    const built = await packSubset(rangeFromBytes(src.bytes), src.idx, [cut], { outsideBase: 'ref', resolved });
    const plan = planPackBatches(src.idx, resolved, { budget, select: blobs, crossBatchRef: true });
    for (const [api, r] of [['packSubset', built], ['planPackBatches', plan]]) {
      assert.equal(r.ok, false, `${api}, oid() returns ${label}`);
      assert.equal(r.error.code, 'bad_request', `${api}, ${label}`);
      assert.match(r.error.message, /oid\(\) returned nothing/u, `${api}, ${label}`);
      assert.doesNotMatch(r.error.message, /threw/u, `${api}, ${label}`);
      assert.equal('cause' in r.error && r.error.cause !== undefined, false, `${api}, ${label}: no cause, nothing was thrown`);
    }
    assert.equal(built.error.what, 'pack subset base', label);
  }
});
