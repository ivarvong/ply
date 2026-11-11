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
});
