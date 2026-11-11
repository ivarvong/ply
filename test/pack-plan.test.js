// planPackBatches (#237): a spooled pack's entries split into pushes under a caller's budget, children first.
//   - deterministic, plain data (a JSON round trip keeps it and its hash), hash stable and moved by the budget
//   - every batch within every budget dimension; every per-object check made before any batch
//   - children first, against the trees themselves: every blob a tree names is in a batch no later than the tree's,
//     and every commit's tree no later than the commit's; within a batch every base before its delta
//   - delta families kept whole, or split in chain order with REF rewrites under crossBatchRef
//   - refusals: per-object limits, a family too big without crossBatchRef, trees that do not fit one push, a base
//     outside the selection, an unresolved entry, a bad selection or budget
//   - end to end against git http-backend with receive.fsckObjects: each batch packed (git pack-objects over exactly
//     the batch's oids, standing in for packSubset #235) with a generated temp tree and commit chained per batch,
//     pushed with pushPack, the final push atomic (create main, delete the temp ref); fsck --strict, every object
//   - planning time and memory at 200,000 entries
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomFillSync, createHash } from 'node:crypto';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, fsckProblems } from './server.js';
import { scanPackIndex } from '../src/packscanindex.js';
import { resolvePackRange, NO_BASE, THIN_BASE } from '../src/packrangeresolve.js';
import { rangeFromBytes } from '../src/rangesource.js';
import { planPackBatches, planHash, PLAN_VERSION } from '../src/packplan.js';
import { resolvePack, parsePack } from '../src/pack.js';
import { parseTree } from '../src/objects.js';
import { createTransport } from '../src/http.js';
import { pushPack } from '../src/receivecaps.js';
import { ZERO_OID } from '../src/push.js';
import { TYPE } from '../src/objects.js';
import { unwrap } from './unwrap.js';

const must = r => { if (r.ok) return r.value; throw Object.assign(new Error(r.error.message), { code: r.error.code }); };
const streamOf = bytes => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
const ident = ['-c', 'user.name=a', '-c', 'user.email=a@x'];
const BIG = { maxRequestBytes: 1 << 30, maxObjects: 1 << 20, maxObjectBytes: 1 << 30, maxCompressedObjectBytes: 1 << 30, reserveBytes: 0, reserveObjects: 0 };

let root, cleanup, srv, n = 0, work, packs;
// A source repository: incompressible blobs (so sizes are what they look like), a blob edited over several commits
// (a delta chain), nested trees; packed REF-only (as Artifacts sends) and with OFS deltas.
before(async () => {
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  work = join(root, 'source');
  mkdirSync(join(work, 'a', 'b'), { recursive: true });
  git(work, ['init', '-q', '-b', 'main']);
  for (let i = 0; i < 12; i++) {
    const blob = new Uint8Array(40_000 + i * 1000);
    randomFillSync(blob);
    writeFileSync(join(work, i % 3 === 0 ? 'a' : i % 3 === 1 ? join('a', 'b') : '.', `r${i}.bin`), blob);
  }
  const base = new Uint8Array(60_000);
  randomFillSync(base);
  for (let v = 0; v < 6; v++) {
    base[v * 997] ^= 0xff;
    writeFileSync(join(work, 'a', 'chain.bin'), base);
    writeFileSync(join(work, 'small.txt'), `version ${v}\n`.repeat(200));
    git(work, ['add', '.']);
    git(work, [...ident, 'commit', '-q', '-m', `v${v}`]);
  }
  const head = git(work, ['rev-parse', 'HEAD']).trim();
  const objs = git(work, ['rev-list', '--objects', head]);
  packs = {
    head,
    ref: new Uint8Array(gitBuf(work, ['pack-objects', '--stdout', '-q', '--depth=50'], objs)),
    ofs: new Uint8Array(gitBuf(work, ['pack-objects', '--stdout', '-q', '--depth=50', '--delta-base-offset'], objs)),
  };
});
after(async () => { await srv?.close(); cleanup?.(); });

async function indexed(pack) {
  const idx = must(await scanPackIndex(streamOf(pack)));
  const res = must(await resolvePackRange(idx, rangeFromBytes(pack)));
  return { idx, res };
}
const hexOf = (res, i) => res.oid(i).value;

// Every batch within the budget; every entry planned once; within a batch, every in-batch base before its delta.
function assertWithin(plan, idx, res, budget) {
  const seen = new Map();
  plan.batches.forEach((b, bi) => {
    assert.ok(b.packBytes + budget.reserveBytes <= budget.maxRequestBytes, `batch ${bi} bytes ${b.packBytes}`);
    assert.ok(b.objects + budget.reserveObjects <= budget.maxObjects, `batch ${bi} objects ${b.objects}`);
    assert.equal(b.objects, b.entries.length);
    b.entries.forEach((i, k) => { assert.equal(seen.has(i), false, `entry ${i} twice`); seen.set(i, { batch: bi, at: k }); });
  });
  for (const [i, where] of seen) {
    assert.ok(res.columns.size[i] <= budget.maxObjectBytes);
    assert.ok(idx.columns.compressed[i] <= budget.maxCompressedObjectBytes);
    const b = res.columns.base[i];
    if (b >= 0 && seen.has(b)) {
      const wb = seen.get(b);
      assert.ok(wb.batch < where.batch || (wb.batch === where.batch && wb.at < where.at), `base ${b} of ${i} not before it`);
    }
  }
  return seen;
}
// Children first, read from the objects: every tree's blobs and subtrees, and every commit's tree, in a batch no later.
function assertChildrenFirst(plan, pack, res, seen) {
  const objects = must(resolvePack(must(parsePack(pack)))).objects;
  const batchOfOid = new Map();
  for (const [i, w] of seen) batchOfOid.set(hexOf(res, i), w.batch);
  let edges = 0;
  for (const [oid, o] of objects) {
    const mine = batchOfOid.get(oid);
    if (mine === undefined) continue;
    const kids = o.type === TYPE.TREE ? must(parseTree(o.data)).map(e => e.oid)
      : o.type === TYPE.COMMIT ? [/^tree ([0-9a-f]{40})/.exec(new TextDecoder().decode(o.data))[1]] : [];
    for (const k of kids) {
      const theirs = batchOfOid.get(k);
      if (theirs === undefined) continue;
      edges++;
      assert.ok(theirs <= mine, `${oid} (batch ${mine}) names ${k} (batch ${theirs})`);
    }
  }
  return edges;
}

test('REF-only and OFS packs: every batch within every budget dimension, children first, families whole, deterministic', async () => {
  for (const kind of ['ref', 'ofs']) {
    const { idx, res } = await indexed(packs[kind]);
    const budget = { maxRequestBytes: 160_000, maxObjects: 40, maxObjectBytes: 1 << 20, maxCompressedObjectBytes: 1 << 20, reserveBytes: 2_000, reserveObjects: 2 };
    const plan = must(planPackBatches(idx, res, { budget }));
    assert.ok(plan.batches.length >= 3, `${kind}: ${plan.batches.length} batches`);
    assert.equal(plan.entries, idx.count);
    assert.equal(plan.version, PLAN_VERSION);
    assert.equal(plan.trailer, idx.trailer);
    assert.deepEqual(plan.batches.slice(0, -1).map(b => b.kind), plan.batches.slice(0, -1).map(() => 'blobs'));
    assert.equal(plan.batches.at(-1).kind, 'final');
    for (const b of plan.batches.slice(0, -1)) for (const i of b.entries) assert.equal(res.columns.type[i], TYPE.BLOB);
    const seen = assertWithin(plan, idx, res, budget);
    assert.equal(seen.size, idx.count);
    assert.ok(assertChildrenFirst(plan, packs[kind], res, seen) > 10);
    // families whole: no entry's in-pack base is in another batch
    for (const b of plan.batches) assert.equal(b.refRewrites, 0);
    for (const [i, w] of seen) { const base = res.columns.base[i]; if (base >= 0) assert.equal(seen.get(base).batch, w.batch); }
    // deterministic, plain data
    const again = must(planPackBatches(idx, res, { budget }));
    assert.deepEqual(again, plan);
    const round = JSON.parse(JSON.stringify(plan));
    assert.deepEqual(round, plan);
    const { hash, ...body } = round;
    assert.equal(planHash(body), hash);
    assert.match(hash, /^[0-9a-f]{40}$/);
  }
});

test('the hash names the plan: stable across runs, moved by the budget, the options and the source pack', async () => {
  const { idx, res } = await indexed(packs.ref);
  const budget = { maxRequestBytes: 160_000, maxObjects: 40, maxObjectBytes: 1 << 20, maxCompressedObjectBytes: 1 << 20, reserveBytes: 2_000, reserveObjects: 2 };
  const h = must(planPackBatches(idx, res, { budget })).hash;
  assert.equal(must(planPackBatches(idx, res, { budget })).hash, h);
  const moved = new Set([h]);
  for (const k of Object.keys(budget)) moved.add(must(planPackBatches(idx, res, { budget: { ...budget, [k]: budget[k] + 1 } })).hash);
  assert.equal(moved.size, 1 + Object.keys(budget).length, 'each budget field moves the hash');
  assert.notEqual(must(planPackBatches(idx, res, { budget, crossBatchRef: true })).hash, h);
  assert.notEqual(must(planPackBatches(idx, res, { budget, select: [...Array(idx.count).keys()] })).hash, h);
  const ofs = await indexed(packs.ofs);
  assert.notEqual(must(planPackBatches(ofs.idx, ofs.res, { budget })).hash, h);
  // and the canonical form is what is hashed: a tampered plan no longer matches
  const plan = must(planPackBatches(idx, res, { budget }));
  const { hash, ...body } = plan;
  assert.notEqual(planHash({ ...body, batches: [...body.batches].reverse() }), hash);
  assert.notEqual(planHash({ ...body, trailer: '0'.repeat(40) }), hash);
});

test('one big batch when everything fits; blobs merge into the final batch when they fit beside the trees', async () => {
  const { idx, res } = await indexed(packs.ref);
  const plan = must(planPackBatches(idx, res, { budget: BIG }));
  assert.equal(plan.batches.length, 1);
  assert.equal(plan.batches[0].kind, 'final');
  assert.equal(plan.batches[0].objects, idx.count);
  const packBytes = idx.columns.compressed.reduce((s, c, i) => s + c + idx.columns.headerBytes[i], 0) + 32;
  assert.equal(plan.batches[0].packBytes, packBytes, 'REF entries are counted as stored');
  // only blobs selected: no final batch
  const blobs = [...Array(idx.count).keys()].filter(i => res.columns.type[i] === TYPE.BLOB);
  const p2 = must(planPackBatches(idx, res, { budget: BIG, select: blobs }));
  assert.deepEqual(p2.batches.map(b => b.kind), ['blobs']);
  // nothing selected: no batches
  assert.deepEqual(must(planPackBatches(idx, res, { budget: BIG, select: [] })).batches, []);
});

test('OFS distances are counted at the length the largest distance in a push needs (header growth)', async () => {
  const { idx, res } = await indexed(packs.ofs);
  const ofs = [...Array(idx.count).keys()].filter(i => idx.columns.storedType[i] === TYPE.OFS_DELTA);
  assert.ok(ofs.length > 3);
  const plan = must(planPackBatches(idx, res, { budget: BIG }));
  const stored = idx.columns.compressed.reduce((s, c, i) => s + c + idx.columns.headerBytes[i], 0) + 32;
  // maxRequestBytes 2^30 needs a 5-byte distance; every OFS entry counts that, whatever its stored distance was
  let grown = 0;
  for (const i of ofs) {
    const d = idx.columns.offset[i] - idx.columns.offset[idx.columns.baseIndex[i]];
    let len = 1;
    for (let r = Math.floor(d / 128); r > 0; r = Math.floor((r - 1) / 128)) len++;
    grown += 5 - len;
  }
  assert.equal(plan.batches[0].packBytes, stored + grown);
});

test('a family too big for one push: refused, or split in chain order with REF rewrites under crossBatchRef', async () => {
  for (const kind of ['ref', 'ofs']) {
    const { idx, res } = await indexed(packs[kind]);
    // the chain.bin family is the deepest; size a push to hold its root but not the whole family
    let deepest = 0;
    for (let i = 0; i < idx.count; i++) if (res.columns.depth[i] > res.columns.depth[deepest]) deepest = i;
    assert.ok(res.columns.depth[deepest] >= 2, `${kind}: chain depth ${res.columns.depth[deepest]}`);
    let r = deepest;
    while (res.columns.base[r] >= 0) r = res.columns.base[r];
    const family = [...Array(idx.count).keys()].filter(i => { let u = i; while (res.columns.base[u] >= 0) u = res.columns.base[u]; return u === r; });
    assert.ok(family.length >= 4, `${kind}: family of ${family.length}`);
    // counted at the OFS length a push of about this size needs (the count depends on maxRequestBytes)
    const big = must(planPackBatches(idx, res, { budget: BIG, select: family })).batches[0].packBytes;
    const whole = must(planPackBatches(idx, res, { budget: { ...BIG, maxRequestBytes: big }, select: family })).batches[0].packBytes;
    const budget = { ...BIG, maxObjects: family.length, maxRequestBytes: whole - 1 };
    const select = family;
    const refused = planPackBatches(idx, res, { budget, select });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'limit_exceeded');
    assert.match(refused.error.message, /delta family bytes/);
    const plan = must(planPackBatches(idx, res, { budget, select, crossBatchRef: true }));
    assert.ok(plan.batches.length >= 2, `${kind}: ${plan.batches.length}`);
    assert.ok(plan.batches.slice(1).some(b => b.refRewrites > 0));
    assertWithin(plan, idx, res, budget);
    // a family over the object budget is refused by objects
    const byObjects = planPackBatches(idx, res, { budget: { ...BIG, maxObjects: family.length - 1 }, select });
    assert.equal(byObjects.ok, false);
    assert.match(byObjects.error.message, /delta family objects/);
    const splitByObjects = must(planPackBatches(idx, res, { budget: { ...BIG, maxObjects: 2 }, select, crossBatchRef: true }));
    assert.ok(splitByObjects.batches.every(b => b.objects <= 2));
    assert.equal(splitByObjects.batches.reduce((s, b) => s + b.objects, 0), family.length);
  }
});

test('refusals before any batch: per-object limits, an entry no push holds, trees over one push, bases outside the selection', async () => {
  const { idx, res } = await indexed(packs.ref);
  const biggest = Math.max(...res.columns.size);
  const big = planPackBatches(idx, res, { budget: { ...BIG, maxObjectBytes: biggest - 1 } });
  assert.equal(big.error.code, 'limit_exceeded');
  assert.match(big.error.message, /object bytes/);
  assert.equal(big.error.got, biggest);
  assert.equal(big.error.max, biggest - 1);
  assert.ok(must(planPackBatches(idx, res, { budget: { ...BIG, maxObjectBytes: biggest } })));
  const comp = Math.max(...idx.columns.compressed);
  const c = planPackBatches(idx, res, { budget: { ...BIG, maxCompressedObjectBytes: comp - 1 } });
  assert.match(c.error.message, /compressed object bytes/);
  assert.equal(c.error.got, comp);
  assert.ok(must(planPackBatches(idx, res, { budget: { ...BIG, maxCompressedObjectBytes: comp } })));
  // trees, commits and tags must fit one push
  const rest = [...Array(idx.count).keys()].filter(i => res.columns.type[i] !== TYPE.BLOB);
  const restBytes = rest.reduce((s, i) => s + idx.columns.compressed[i] + idx.columns.headerBytes[i], 32);
  const trees = planPackBatches(idx, res, { budget: { ...BIG, maxRequestBytes: restBytes - 1 }, select: rest });
  assert.equal(trees.error.code, 'limit_exceeded');
  assert.match(trees.error.message, /tree batch bytes/);
  assert.equal(trees.error.got, restBytes);
  assert.ok(must(planPackBatches(idx, res, { budget: { ...BIG, maxRequestBytes: restBytes }, select: rest })));
  const treeObjs = planPackBatches(idx, res, { budget: { ...BIG, maxObjects: rest.length }, select: rest, crossBatchRef: false });
  assert.ok(treeObjs.ok);
  const treeObjs2 = planPackBatches(idx, res, { budget: { ...BIG, maxObjects: rest.length, reserveObjects: 1 }, select: rest });
  assert.match(treeObjs2.error.message, /tree batch objects/);
  assert.equal(treeObjs2.error.got, rest.length + 1);
  // an entry no push holds even alone: crossBatchRef splits families, never one object
  const wholeBlobs = [...Array(idx.count).keys()].filter(i => res.columns.type[i] === TYPE.BLOB && res.columns.base[i] === NO_BASE);
  const fat = wholeBlobs.reduce((a, i) => (idx.columns.compressed[i] > idx.columns.compressed[a] ? i : a), wholeBlobs[0]);
  const fatBytes = 32 + idx.columns.headerBytes[fat] + idx.columns.compressed[fat];
  const noPush = planPackBatches(idx, res, { budget: { ...BIG, maxRequestBytes: fatBytes - 1 }, select: [fat], crossBatchRef: true });
  assert.equal(noPush.error.code, 'limit_exceeded');
  assert.match(noPush.error.message, /entry bytes \(entry \d+\)/);
  assert.equal(noPush.error.got, fatBytes);
  assert.ok(must(planPackBatches(idx, res, { budget: { ...BIG, maxRequestBytes: fatBytes }, select: [fat], crossBatchRef: true })));
  // a delta selected without its base needs crossBatchRef
  const delta = [...Array(idx.count).keys()].find(i => res.columns.base[i] >= 0);
  const lone = planPackBatches(idx, res, { budget: BIG, select: [delta] });
  assert.equal(lone.error.code, 'bad_request');
  assert.match(lone.error.message, /base is not in the selection/);
  const loneOk = must(planPackBatches(idx, res, { budget: BIG, select: [delta], crossBatchRef: true }));
  assert.equal(loneOk.batches.at(-1).refRewrites, 1);
});

test('refusals of input: selection, budget, an index that does not match, an entry with no resolved type, a thin base', async () => {
  const { idx, res } = await indexed(packs.ref);
  for (const select of [[-1], [idx.count], [0.5], [0, 0]]) assert.equal(planPackBatches(idx, res, { budget: BIG, select }).error.code, 'bad_request', JSON.stringify(select));
  for (const k of Object.keys(BIG)) for (const v of [-1, 1.5, Number.NaN, 2 ** 60]) {
    assert.equal(planPackBatches(idx, res, { budget: { ...BIG, [k]: v } }).error.code, 'bad_request', `${k}=${v}`);
  }
  assert.match(planPackBatches(idx, res, { budget: { ...BIG, maxObjects: 3, reserveObjects: 3 } }).error.message, /reserveObjects/);
  assert.ok(planPackBatches(idx, res, { budget: { ...BIG, maxObjects: 3, reserveObjects: 2 }, select: [] }).ok);
  assert.match(planPackBatches(idx, res, { budget: { ...BIG, maxRequestBytes: 132, reserveBytes: 100 } }).error.message, /reserveBytes/);
  assert.ok(planPackBatches(idx, res, { budget: { ...BIG, maxRequestBytes: 133, reserveBytes: 100 }, select: [] }).ok);
  assert.match(planPackBatches(idx, { ...res, count: res.count - 1 }, { budget: BIG }).error.message, /resolved index has/);
  const untyped = { ...res, columns: { ...res.columns, type: Uint8Array.from(res.columns.type, (t, i) => (i === 3 ? 0 : t)) } };
  assert.match(planPackBatches(idx, untyped, { budget: BIG }).error.message, /entry 3 has no resolved type/);
  assert.ok(planPackBatches(idx, untyped, { budget: BIG, select: [0, 1, 2].filter(i => res.columns.base[i] < 0) }).ok);
  const delta = [...Array(idx.count).keys()].find(i => res.columns.base[i] >= 0);
  const thin = { ...res, columns: { ...res.columns, base: Int32Array.from(res.columns.base, (b, i) => (i === delta ? THIN_BASE : b)) } };
  assert.match(planPackBatches(idx, thin, { budget: BIG }).error.message, /base is not in the selection/);
  const thinPlan = must(planPackBatches(idx, thin, { budget: BIG, crossBatchRef: true }));
  assert.equal(thinPlan.batches[0].refRewrites, 1);
  assert.equal(NO_BASE, -1);
});

test('end to end: each batch pushed with pushPack to git http-backend (receive.fsckObjects), final push atomic; fsck --strict, every object', async () => {
  for (const kind of ['ref', 'ofs']) {
    const name = `e2e${n++}`;
    const bare = makeBareRepo(root, name);
    const url = `${srv.url}/${name}.git`;
    const { idx, res } = await indexed(packs[kind]);
    const budget = { maxRequestBytes: 160_000, maxObjects: 40, maxObjectBytes: 1 << 20, maxCompressedObjectBytes: 1 << 20, reserveBytes: 8_000, reserveObjects: 2 };
    const plan = must(planPackBatches(idx, res, { budget }));
    assert.ok(plan.batches.length >= 3);
    const tempRef = `refs/ply/transfer/${plan.hash}`;
    const t = unwrap(createTransport(url));
    let prevTemp = ZERO_OID;
    for (const [bi, b] of plan.batches.entries()) {
      const oids = b.entries.map(i => hexOf(res, i));
      const commands = [];
      let extra = [];
      if (b.kind === 'blobs') {
        // the generated temp tree (this batch's blobs, named by oid) and commit, chained on the last one
        const tree = git(work, ['mktree'], { input: oids.map(o => `100644 blob ${o}\t${o}\n`).join('') }).trim();
        const commit = git(work, [...ident, 'commit-tree', tree, ...(prevTemp === ZERO_OID ? [] : ['-p', prevTemp]), '-m', `batch ${bi} of ${plan.hash}`]).trim();
        extra = [tree, commit];
        commands.push({ ref: tempRef, oldOid: prevTemp, newOid: commit });
        prevTemp = commit;
      } else {
        commands.push({ ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: packs.head });
        if (prevTemp !== ZERO_OID) commands.push({ ref: tempRef, oldOid: prevTemp, newOid: ZERO_OID });
      }
      // stand-in for packSubset (#235): exactly these objects, deltas only among them (or, under fsck, the temp chain)
      const pack = new Uint8Array(gitBuf(work, ['pack-objects', '--stdout', '-q', ...(kind === 'ofs' ? ['--delta-base-offset'] : [])], [...oids, ...extra].join('\n') + '\n'));
      assert.ok(pack.length + budget.reserveBytes <= budget.maxRequestBytes + 4_000, `batch ${bi}: ${pack.length}`);
      const r = await pushPack(t, { commands, pack: streamOf(pack), length: pack.length, atomic: b.kind === 'final' });
      assert.ok(r.ok, `${kind} batch ${bi}: ${r.ok ? '' : r.error.message}`);
    }
    assert.equal(git(bare, ['rev-parse', 'refs/heads/main']).trim(), packs.head);
    assert.equal(git(bare, ['for-each-ref', 'refs/ply']).trim(), '');
    assert.deepEqual(fsckProblems(bare, { args: ['--strict'] }), []);
    const want = git(work, ['rev-list', '--objects', packs.head]).split('\n').filter(Boolean).map(l => l.slice(0, 40)).sort();
    const got = git(bare, ['rev-list', '--objects', 'refs/heads/main']).split('\n').filter(Boolean).map(l => l.slice(0, 40)).sort();
    assert.deepEqual(got, want);
  }
});

// A synthetic index of `n` entries: blob families of a root and a chain of deltas, a tree per 50 blobs, one commit.
// `stored` is how the deltas are stored: REF_DELTA (a 23-byte header: 3 of type and size, a 20-byte id) or OFS_DELTA (4:
// 2 of type and size for a 40-byte delta, and a 2-byte distance, since the entry before is 203..383 bytes away).
function synthetic(count, stored = TYPE.REF_DELTA) {
  const offset = new Float64Array(count), headerBytes = new Uint8Array(count).fill(3), compressed = new Float64Array(count), size = new Float64Array(count);
  const storedType = new Uint8Array(count), type = new Uint8Array(count), baseIndex = new Int32Array(count).fill(-1);
  const rbase = new Int32Array(count).fill(-1), depth = new Int32Array(count), rsize = new Float64Array(count);
  let at = 12;
  for (let i = 0; i < count; i++) {
    const isCommit = i === count - 1;
    const isTree = !isCommit && i % 50 === 49;
    const famPos = i % 5;
    const delta = !isCommit && !isTree && famPos > 0 && i % 50 !== 0;
    offset[i] = at;
    compressed[i] = 200 + (i % 17) * 10;
    size[i] = delta ? 40 : 400;
    rsize[i] = 400;
    storedType[i] = isCommit ? TYPE.COMMIT : isTree ? TYPE.TREE : delta ? stored : TYPE.BLOB;
    type[i] = isCommit ? TYPE.COMMIT : isTree ? TYPE.TREE : TYPE.BLOB;
    if (delta) { rbase[i] = i - 1; depth[i] = depth[i - 1] + 1; headerBytes[i] = stored === TYPE.OFS_DELTA ? 4 : 23; }
    if (delta && stored === TYPE.OFS_DELTA) baseIndex[i] = i - 1;
    at += headerBytes[i] + compressed[i];
  }
  const idx = { version: 2, count, trailer: createHash('sha1').update(String(count)).digest('hex'), bytes: at + 20, columns: { offset, headerBytes, compressed, size, storedType, type, baseIndex } };
  const res = { count, columns: { oid: new Uint8Array(count * 20), type, base: rbase, depth, size: rsize } };
  return { idx, res };
}

test('planning time and memory at 200,000 entries, REF_DELTA and OFS_DELTA packs', () => {
  const N = 200_000;
  const budget = { maxRequestBytes: 64 * 1024 * 1024 - 64 * 1024, maxObjects: 50_000, maxObjectBytes: 32 * 1024 * 1024, maxCompressedObjectBytes: 32 * 1024 * 1024, reserveBytes: 64 * 1024, reserveObjects: 300 };
  const kinds = [['ref', synthetic(N)], ['ofs', synthetic(N, TYPE.OFS_DELTA)]];
  const times = { ref: [], ofs: [] };
  const first = {};
  // the two kinds alternate, so load on the machine falls on both; the figure reported is each kind's median
  for (let round = 0; round < 5; round++) {
    for (const [kind, { idx, res }] of kinds) {
      globalThis.gc?.();
      const before = process.memoryUsage().heapUsed;
      const t0 = performance.now();
      const plan = must(planPackBatches(idx, res, { budget, crossBatchRef: false }));
      const ms = performance.now() - t0;
      const after = process.memoryUsage().heapUsed;
      assert.equal(plan.entries, N);
      for (const b of plan.batches) assert.ok(b.objects + budget.reserveObjects <= budget.maxObjects && b.packBytes + budget.reserveBytes <= budget.maxRequestBytes);
      // whole families: nothing is rewritten, whichever way the deltas are stored
      assert.equal(plan.batches.reduce((sum, b) => sum + b.refRewrites, 0), 0);
      assert.ok(ms < 5_000, `${kind}: ${ms} ms`);
      times[kind].push(ms);
      first[kind] ??= { batches: plan.batches.length, heapDeltaMB: +((after - before) / 1e6).toFixed(1), planJsonMB: +(JSON.stringify(plan).length / 1e6).toFixed(2) };
    }
  }
  const median = a => Math.round(a.toSorted((x, y) => x - y)[Math.floor(a.length / 2)]);
  for (const [kind] of kinds) console.log(JSON.stringify({ kind, entries: N, medianMs: median(times[kind]), runsMs: times[kind].map(Math.round), ...first[kind] }));
});
