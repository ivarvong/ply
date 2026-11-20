// The path walk's reads (src/pathtrees.ts pathWalk) over a fake transport, fast enough for the mutation run
// (vitest.stryker.config.ts): which requests a walk sends for its commit and for each tree, under which limits, what is
// learned on the quirks record, what stops the walk asking, and which answer is returned, for every state × outcome.
// What git does with each request, and editFile, are test/path-walk.test.js's. The fake answers a want as git does
// (probed against git 2.43, loose and bitmap: a commit want with tree:K is the commit and its trees at depth < K; a tree
// want with tree:K is the tree and K levels under it).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { pathWalk, commitForWalk, pathTreesFilter, SUBTREES_FILTER, PATH_TREE_LEVELS } from '../src/pathtrees.js';
import { walkCommit, walkPath } from '../src/read.js';
import { fetchObject } from '../src/fetch.js';
import { asTransport, pathTreesOf, learnPathTrees, freshQuirks, harvestBytes } from '../src/transport.js';
import { buildPack } from '../src/pack.js';
import { encodeTree, encodeCommit, hashObject, TYPE } from '../src/objects.js';
import { concat, td, te } from '../src/bytes.js';
import { DEFAULT_LIMITS, WORKER_LIMITS, LIMIT_OBJECT_OVERHEAD, LIMIT_PATH_TREES, parseLimits } from '../src/limits.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { SIDEBAND_PACK } from '../src/format.js';
import { unwrap } from './unwrap.js';

const author = 'Ada <ada@ex> 1700000000 +0000';
// root/{a/{b/{c/{d/{w}, z}, y}, s1/{f}, s2/{g}, x}, q/{r}, r}: the path a/b/c/d/w, with siblings beside a and b.
// Built on first use inside a test, never while the file loads (#307, as test/path-trees-unit.test.js).
let fixtureMemo = null;
const fixture = () => (fixtureMemo ??= (() => {
  const objects = new Map(); const names = new Map(); const children = new Map();
  const blob = text => hashObject('blob', te.encode(text));
  const tree = (name, entries) => {
    const data = unwrap(encodeTree(entries)); const oid = hashObject('tree', data);
    objects.set(oid, { type: TYPE.TREE, data }); names.set(oid, name); children.set(oid, entries.filter(e => e.mode === '40000').map(e => e.oid));
    return oid;
  };
  const file = (name, text = name) => ({ mode: '100644', name, oid: blob(text) });
  const dir = (name, oid) => ({ mode: '40000', name, oid });
  const d = tree('d', [file('w')]);
  const c = tree('c', [dir('d', d), file('z')]);
  const b = tree('b', [dir('c', c), file('y')]);
  const s1 = tree('s1', [file('f')]);
  const s2 = tree('s2', [file('g')]);
  const a = tree('a', [dir('b', b), dir('s1', s1), dir('s2', s2), file('x')]);
  const q = tree('q', [file('r', 'q/r')]);
  const root = tree('root', [dir('a', a), dir('q', q), file('r')]);
  const commitData = unwrap(encodeCommit({ tree: root, parents: [], author, message: 'root\n' }));
  const tip = hashObject('commit', commitData);
  objects.set(tip, { type: TYPE.COMMIT, data: commitData }); names.set(tip, 'commit');
  // the tree and `levels` levels under it
  const under = (oid, levels) => [oid, ...(levels > 0 ? children.get(oid).flatMap(k => under(k, levels - 1)) : [])];
  const charge = oids => oids.reduce((n, oid) => n + objects.get(oid).data.length + LIMIT_OBJECT_OVERHEAD, 0);
  return { objects, names, under, charge, tip, root, a, b, c, d, s1, s2, q, commitData };
})());
const dat = s => ({ kind: 'data', payload: typeof s === 'string' ? te.encode(s) : s });
const FL = { kind: 'flush' };
async function* packFrames(objects) {
  const { pack } = await buildPack(objects);
  yield dat('packfile\n');
  for (let i = 0; i < pack.length; i += 60_000) yield dat(concat([Uint8Array.of(SIDEBAND_PACK), pack.subarray(i, i + 60_000)]));
  yield FL;
}
const DEEP = /^combine:blob:none\+tree:(\d+)$/;
// What git answers: the oids of the pack for `want` under `filter`.
function answerOf(want, filter) {
  const f = fixture();
  const isCommit = want === f.tip;
  const deep = DEEP.exec(filter);
  if (filter === 'tree:0') return [want];
  if (deep !== null) { const k = Number(deep[1]); return isCommit ? [want, ...(k > 0 ? f.under(f.root, k - 1) : [])] : f.under(want, k); }
  // blob:none and no filter: everything under the want
  return isCommit ? [want, ...f.under(f.root, 9)] : f.under(want, 9);
}
// deep: what a combine request is answered with: 'ok' (git's answer), 'refuse' / 'depth' (git's ERR lines), 'http400'
// (Artifacts' refusal), 'empty' (an upload-pack that takes no filter), 'drop' (network), 'http500', 'timeout', or a function
// (want, filter, oids) → objects for a lying pack, or the frames themselves. `log` is every request: [the want's name, the filter, and the two pack
// bounds of the transport it was sent on].
function fake({ deep = 'ok', limits = DEFAULT_LIMITS, tracer = new Tracer(), quirks = freshQuirks() } = {}) {
  const f = fixture();
  const log = [];
  const t = asTransport({
    kind: 'http', url: 'http://h/r.git', tracer, parent: null, limits, signal: null, quirks, objects: null, scrub: null,
    async *frames(_service, body) {
      const text = td.decode(body);
      const filter = (/filter (\S+)/.exec(text) ?? [])[1] ?? '';
      const want = /want ([0-9a-f]{40})/.exec(text)[1];
      log.push([f.names.get(want), filter, this.limits.maxPackBytes, this.limits.maxInflatedTotal, Number((/deepen (\d+)/.exec(text) ?? [0, 0])[1])]);
      const oids = answerOf(want, filter);
      if (!DEEP.test(filter) || deep === 'ok') { yield* packFrames(oids.map(o => f.objects.get(o))); return; }
      if (typeof deep === 'function') { const lie = deep(want, filter, oids); yield* (Array.isArray(lie) ? packFrames(lie) : lie); return; }
      switch (deep) {
        case 'refuse': yield dat("ERR filter 'combine' not supported\n"); yield FL; return;
        case 'depth': yield dat('ERR tree filter allows max depth 0, but got 1\n'); yield FL; return;
        case 'http400': throw Object.assign(new Error('HTTP 400 git-upload-pack: Unsupported Git fetch filter; only blob:none is supported.'), { code: 'http', status: 400 });
        case 'http500': throw Object.assign(new Error('HTTP 500 git-upload-pack: oops'), { code: 'http', status: 500 });
        case 'drop': throw Object.assign(new Error('network: socket hang up'), { code: 'network' });
        case 'timeout': throw Object.assign(new Error('request aborted: firstByteTimeoutMs'), { code: 'timeout', what: 'firstByteTimeoutMs' });
        case 'empty': return;
      }
      throw new Error(`no answer for ${deep}`);
    },
    async advertise() { return { ok: false, error: { code: 'http', message: 'none' } }; },
  }, unwrap(parseLimits(limits)));
  // the requests since the last call, as [name, filter]
  let seen = 0;
  const sent = () => { const out = log.slice(seen).map(([name, filter]) => [name, filter]); seen = log.length; return out; };
  return { t, log, sent };
}
const D1 = 'combine:blob:none+tree:1', D2 = 'combine:blob:none+tree:2';
const sameObject = (r, oid) => { const f = fixture(); assert.equal(r.ok, true, r.ok ? '' : `${r.error.code} ${r.error.message}`); assert.equal(r.value.oid, oid); assert.equal(r.value.type, f.objects.get(oid).type); assert.deepEqual(r.value.data, f.objects.get(oid).data); };
const held = t => [...t.objects.keys()].map(o => fixture().names.get(o)).toSorted();
const taken = () => { const x = fake(); learnPathTrees(x.t.quirks, 'taken'); return x; };

test('the filters: a commit want counts the root as depth 0, a tree want counts its entries as depth 0', () => {
  assert.equal(PATH_TREE_LEVELS, 2);
  assert.deepEqual([1, 2, 3, 9].map(pathTreesFilter), [D1, D2, D2, D2]);
  assert.equal(SUBTREES_FILTER, D1);
});

test('commit: no levels is the tree:0 fetch; a first contact is the race; taken is the deep fetch alone, K from levels', async () => {
  const f = fixture();
  const x = fake();
  sameObject(await pathWalk(x.t).commit(f.tip, 0), f.tip);
  sameObject(await pathWalk(x.t).commit(f.tip, -1), f.tip);
  assert.deepEqual(x.sent(), [['commit', 'tree:0'], ['commit', 'tree:0']], 'levels 0 never asks');
  assert.equal(pathTreesOf(x.t.quirks), null);
  sameObject(await pathWalk(x.t).commit(f.tip, 1), f.tip);
  assert.deepEqual(x.sent().toSorted(), [['commit', D1], ['commit', 'tree:0']], 'not known: both at once');
  assert.equal(pathTreesOf(x.t.quirks), 'taken');
  assert.deepEqual(held(x.t), ['root'], 'the root came with the commit; the wanted commit is the answer, not harvested');
  sameObject(await pathWalk(x.t).commit(f.tip, 5), f.tip);
  assert.deepEqual(x.sent(), [['commit', D2]], 'taken: alone, capped at two levels');
  assert.deepEqual(held(x.t), ['a', 'q', 'root']);
});

test('tree: nothing below, or a harvested tree, is the tree:0 read; else the tree comes with the level below it', async () => {
  const f = fixture();
  // not known: the race, on a first contact too
  const x = fake();
  sameObject(await pathWalk(x.t).tree(f.a, 0), f.a);
  sameObject(await pathWalk(x.t).tree(f.a, -1), f.a);
  assert.deepEqual(x.sent(), [['a', 'tree:0'], ['a', 'tree:0']], 'nothing below: never asks');
  assert.equal(pathTreesOf(x.t.quirks), null);
  const raced = await pathWalk(x.t).tree(f.a, 1);
  sameObject(raced, f.a);
  assert.equal(raced.value.wide, true, 'the deep answer is the one used');
  assert.deepEqual(x.sent().toSorted(), [['a', D1], ['a', 'tree:0']]);
  assert.equal(pathTreesOf(x.t.quirks), 'taken');
  assert.deepEqual(held(x.t), ['b', 's1', 's2'], 'the level below, harvested; the wanted tree is the answer');
  // taken: alone, one level below whatever the walk still reads
  sameObject(await pathWalk(x.t).tree(f.c, 7), f.c);
  assert.deepEqual(x.sent(), [['c', D1]]);
  assert.deepEqual(held(x.t), ['b', 'd', 's1', 's2']);
  // harvested: answered from the store, no request, whatever is below
  const stored = await pathWalk(x.t).tree(f.b, 3);
  sameObject(stored, f.b);
  assert.equal(stored.value.harvested, true);
  assert.deepEqual(x.sent(), []);
});

test('a walk: the commit with two levels, then two levels per fetch, the last alone; every tree is the repository\'s', async () => {
  const f = fixture();
  const path = ['a', 'b', 'c', 'd', 'w'];
  // per levels read: the requests of a walk on a record that takes it
  const expected = {
    1: [['commit', D1]],
    2: [['commit', D2]],
    3: [['commit', D2], ['b', 'tree:0']],
    4: [['commit', D2], ['b', D1]],
    5: [['commit', D2], ['b', D1], ['d', 'tree:0']],
  };
  for (const [levels, requests] of Object.entries(expected)) {
    const x = taken();
    const cache = new Map();
    const comps = path.slice(0, Number(levels));
    const got = unwrap(await walkCommit(x.t, f.tip, comps, { cache, levels: Number(levels) }));
    assert.deepEqual(x.sent(), requests, `levels ${levels}`);
    assert.equal(got.tree, f.root);
    assert.equal(got.entry.name, comps.at(-1));
    assert.deepEqual([...cache.keys()].map(o => f.names.get(o)), ['root', 'a', 'b', 'c', 'd'].slice(0, Number(levels)), `levels ${levels}: every tree read is cached`);
    for (const [oid, data] of cache) assert.deepEqual(data, f.objects.get(oid).data);
  }
  // listTree's shape: one level more than the path's components (the listed directory), read after the walk
  const x = taken();
  unwrap(await walkCommit(x.t, f.tip, ['a', 'b'], { levels: 3 }));
  assert.deepEqual(x.sent(), [['commit', D2]], 'the walk reads root and a; b is the caller\'s read');
  unwrap(await walkCommit(x.t, f.tip, ['a', 'b', 'c'], { levels: 4 }));
  assert.deepEqual(x.sent(), [['commit', D2], ['b', D1]], 'b is asked with c, the listed directory');
  sameObject(await fetchObject(x.t, { oid: f.c, filter: 'tree:0' }), f.c);
  assert.deepEqual(x.sent(), [], 'c is in the harvest');
  // the first contact of a walk: the race on the commit only, then the same requests
  const y = fake();
  unwrap(await walkCommit(y.t, f.tip, path, { levels: 5 }));
  assert.deepEqual([y.sent().slice(0, 2).toSorted(), y.log.slice(2).map(([n, fl]) => [n, fl])], [[['commit', D2], ['commit', 'tree:0']], [['b', D1], ['d', 'tree:0']]]);
  // walkPath starts from a tree: its levels are its components
  const z = taken();
  const walked = unwrap(await walkPath(z.t, f.root, ['a', 'b', 'c']));
  assert.equal(walked.entry.oid, f.c);
  assert.deepEqual(z.sent(), [['root', D1], ['b', 'tree:0']]);
  // a caller's cache answers a level with no request; the level after it is asked as the walk's next
  const w = taken();
  const warm = new Map([[f.root, f.objects.get(f.root).data], [f.a, f.objects.get(f.a).data]]);
  unwrap(await walkPath(w.t, f.root, ['a', 'b', 'c', 'd'], { cache: warm }));
  assert.deepEqual(w.sent(), [['b', D1]]);
});

test('the budget: a path-trees fetch runs under maxPathTreesBytes for its pack and for what it holds, and nothing else changes', async () => {
  const f = fixture();
  assert.equal(LIMIT_PATH_TREES, 1024 * 1024);
  assert.equal(DEFAULT_LIMITS.maxPathTreesBytes, LIMIT_PATH_TREES);
  assert.equal(WORKER_LIMITS.maxPathTreesBytes, LIMIT_PATH_TREES);
  const x = taken();
  let seenLimits = null;
  const inner = Object.getPrototypeOf(x.t).frames;
  Object.getPrototypeOf(x.t).frames = function frames(...args) { seenLimits = this.limits; return inner.apply(this, args); };
  sameObject(await pathWalk(x.t).commit(f.tip, 2), f.tip);
  sameObject(await pathWalk(x.t).tree(f.b, 1), f.b);
  sameObject(await pathWalk(x.t).tree(f.d, 0), f.d);
  // (the last column is the depth sent: 1 with a commit want, none with a tree want, on either kind of fetch)
  assert.deepEqual(x.log, [
    ['commit', D2, LIMIT_PATH_TREES, LIMIT_PATH_TREES, 1],
    ['b', D1, LIMIT_PATH_TREES, LIMIT_PATH_TREES, 0],
    ['d', 'tree:0', DEFAULT_LIMITS.maxPackBytes, DEFAULT_LIMITS.maxInflatedTotal, 0],
  ]);
  const plain = fake({ limits: { maxPathTreesBytes: 0 } });
  sameObject(await pathWalk(plain.t).commit(f.tip, 2), f.tip);
  assert.deepEqual(plain.log, [['commit', 'tree:0', DEFAULT_LIMITS.maxPackBytes, DEFAULT_LIMITS.maxInflatedTotal, 1]]);
  // the view lowers those two keys only (the last request was a tree:0 one: the transport's own record)
  assert.equal(seenLimits, x.t.limits);
  await pathWalk(x.t).tree(f.d, 1);
  for (const key of Object.keys(DEFAULT_LIMITS)) assert.equal(seenLimits[key], key === 'maxPackBytes' || key === 'maxInflatedTotal' ? LIMIT_PATH_TREES : DEFAULT_LIMITS[key], key);
  // a budget above the caller's own pack bounds lowers nothing
  const y = fake({ limits: { maxPathTreesBytes: 100_000, maxPackBytes: 70_000, maxInflatedTotal: 80_000 } }); learnPathTrees(y.t.quirks, 'taken');
  sameObject(await pathWalk(y.t).commit(f.tip, 2), f.tip);
  assert.deepEqual(y.log, [['commit', D2, 70_000, 80_000, 1]]);
});

test('the budget: an answer that fits exactly is used; one byte over is not, and that walk asks one object at a time from there', async () => {
  const f = fixture();
  // the commit, the root and its two children, each charged its size and the per-object overhead before it is inflated
  const exact = f.charge([f.tip, ...f.under(f.root, 1)]);
  const fits = fake({ limits: { maxPathTreesBytes: exact } }); learnPathTrees(fits.t.quirks, 'taken');
  sameObject(await pathWalk(fits.t).commit(f.tip, 2), f.tip);
  assert.deepEqual(fits.sent(), [['commit', D2]]);
  assert.deepEqual(held(fits.t), ['a', 'q', 'root']);
  const ex = arrayExporter();
  const over = fake({ limits: { maxPathTreesBytes: exact - 1 }, tracer: new Tracer({ exporter: ex }) }); learnPathTrees(over.t.quirks, 'taken');
  const walk = pathWalk(over.t);
  sameObject(await walk.commit(f.tip, 2), f.tip);
  assert.deepEqual(over.sent(), [['commit', D2], ['commit', 'tree:0']], 'the answer over the budget is dropped; the tree:0 fetch answers');
  assert.deepEqual(held(over.t), [], 'nothing of it is kept');
  assert.equal(pathTreesOf(over.t.quirks), 'taken', 'how wide one directory is says nothing about the server');
  const refused = ex.lines.flatMap(flattenLine).find(s => s.attrs['git.fetch.path_trees'] === D2);
  assert.equal(refused.attrs['error.type'], 'limit_exceeded');
  // the rest of this walk: tree:0 per level, though a/ and its three children would fit the budget
  assert.ok(f.charge(f.under(f.a, 1)) < exact - 1);
  sameObject(await walk.tree(f.root, 4), f.root);
  sameObject(await walk.tree(f.a, 3), f.a);
  sameObject(await walk.commit(f.tip, 2), f.tip);
  assert.deepEqual(over.sent(), [['root', 'tree:0'], ['a', 'tree:0'], ['commit', 'tree:0']]);
  // another walk asks again
  sameObject(await pathWalk(over.t).tree(f.a, 3), f.a);
  assert.deepEqual(over.sent(), [['a', D1]]);
  // through a whole walk: one unused answer, then one tree per level, and the answer is the same
  const whole = fake({ limits: { maxPathTreesBytes: exact - 1 } }); learnPathTrees(whole.t.quirks, 'taken');
  assert.equal(unwrap(await walkCommit(whole.t, f.tip, ['a', 'b', 'c', 'd', 'w'], { levels: 5 })).entry.name, 'w');
  assert.deepEqual(whole.sent(), [['commit', D2], ['commit', 'tree:0'], ['root', 'tree:0'], ['a', 'tree:0'], ['b', 'tree:0'], ['c', 'tree:0'], ['d', 'tree:0']]);
});

test('the budget bounds the pack on the wire: band 1 is read to the budget and no further, whatever the server sends after the pack', async () => {
  const f = fixture();
  // git's answer, then 300 KB more of band 1. The pack scan has its refusal by then, and a refused scan still reads the
  // response to its end (fetch.ts collectWire): the band-1 bound is what ends the read.
  const pulled = { bytes: 0 };
  const padded = (_want, _filter, oids) => packFrames(oids.map(o => f.objects.get(o)));
  const junk = (_want, _filter, oids) => (async function* frames() {
    for await (const frame of packFrames(oids.map(o => f.objects.get(o)))) if (frame.kind === 'data') yield frame;
    for (let i = 0; i < 30; i++) { pulled.bytes += 10_000; yield dat(concat([Uint8Array.of(SIDEBAND_PACK), new Uint8Array(10_000)])); }
    yield FL;
  })();
  const ex = arrayExporter();
  const x = fake({ deep: junk, limits: { maxPathTreesBytes: 100_000 }, tracer: new Tracer({ exporter: ex }) }); learnPathTrees(x.t.quirks, 'taken');
  sameObject(await pathWalk(x.t).commit(f.tip, 2), f.tip);
  assert.deepEqual(x.sent(), [['commit', D2], ['commit', 'tree:0']]);
  assert.deepEqual(held(x.t), []);
  const span = ex.lines.flatMap(flattenLine).find(s => s.attrs['git.fetch.path_trees'] === D2);
  assert.equal(span.attrs['error.type'], 'limit_exceeded');
  assert.match(span.status.message, /^pack bytes \d+ exceeds limit 100000$/);
  assert.ok(pulled.bytes >= 90_000 && pulled.bytes <= 110_000, `the response was left at the budget (${pulled.bytes} of 300000 junk bytes pulled)`);
  // the same answer without the junk is used
  const y = fake({ deep: padded, limits: { maxPathTreesBytes: 100_000 } }); learnPathTrees(y.t.quirks, 'taken');
  sameObject(await pathWalk(y.t).commit(f.tip, 2), f.tip);
  assert.deepEqual(y.sent(), [['commit', D2]]);
});

test('never asked: a budget of 0, a harvest without room for a whole budget, a record that is not tree:0 or is refused', async () => {
  const f = fixture();
  const walkAll = async x => { const w = pathWalk(x.t); sameObject(await w.commit(f.tip, 2), f.tip); sameObject(await w.tree(f.a, 2), f.a); return x.sent(); };
  for (const known of [null, 'taken']) {
    const zero = fake({ limits: { maxPathTreesBytes: 0 } }); if (known) learnPathTrees(zero.t.quirks, known);
    assert.deepEqual(await walkAll(zero), [['commit', 'tree:0'], ['a', 'tree:0']], `budget 0, ${known}`);
    assert.equal(pathTreesOf(zero.t.quirks), known);
  }
  const refused = fake(); learnPathTrees(refused.t.quirks, 'refused');
  assert.deepEqual(await walkAll(refused), [['commit', 'tree:0'], ['a', 'tree:0']]);
  for (const [filter, sentAs] of [['blob:none', 'blob:none'], ['none', '']]) {
    const x = fake({ quirks: { treeFilter: filter, blobWants: 'many' } }); learnPathTrees(x.t.quirks, 'taken');
    const w = pathWalk(x.t);
    sameObject(await w.commit(f.tip, 2), f.tip);
    assert.deepEqual(x.sent(), [['commit', sentAs]], filter);
  }
  // the harvest: what is held plus a whole budget must fit maxHarvestBytes
  const budget = 50_000;
  const fill = (t, bytes) => { t.objects.set('f'.repeat(40), { type: TYPE.TREE, data: new Uint8Array(bytes) }); assert.equal(harvestBytes(t.objects), bytes); };
  const room = fake({ limits: { maxPathTreesBytes: budget, maxHarvestBytes: budget + 1000 } }); learnPathTrees(room.t.quirks, 'taken');
  fill(room.t, 1000);
  sameObject(await pathWalk(room.t).tree(f.a, 1), f.a);
  assert.deepEqual(room.sent(), [['a', D1]], 'exactly room for the budget: asked');
  const full = fake({ limits: { maxPathTreesBytes: budget, maxHarvestBytes: budget + 1000 } }); learnPathTrees(full.t.quirks, 'taken');
  fill(full.t, 1001);
  sameObject(await pathWalk(full.t).tree(f.a, 1), f.a);
  sameObject(await pathWalk(full.t).commit(f.tip, 2), f.tip);
  assert.deepEqual(full.sent(), [['a', 'tree:0'], ['commit', 'tree:0']], 'one byte short: not asked');
  assert.equal(pathTreesOf(full.t.quirks), 'taken');
});

test('a failed path-trees fetch: a refusal or a timeout is learned on the record, anything else is not; either way that walk asks no more and the tree:0 answer is used', async () => {
  const f = fixture();
  const kinds = [['refuse', 'refused'], ['depth', 'refused'], ['http400', 'refused'], ['empty', 'refused'], ['timeout', 'refused'], ['drop', null], ['http500', null]];
  for (const [deep, learned] of kinds) {
    for (const known of [null, 'taken']) {
      const x = fake({ deep }); if (known) learnPathTrees(x.t.quirks, known);
      const walk = pathWalk(x.t);
      sameObject(await walk.tree(f.a, 2), f.a);
      const first = x.sent();
      // not known: both at once; taken: the deep fetch, then the tree:0 one
      assert.deepEqual(known ? first : first.toSorted(), [['a', D1], ['a', 'tree:0']], `${deep} ${known}`);
      assert.equal(pathTreesOf(x.t.quirks), learned ?? known, `${deep} ${known}`);
      assert.deepEqual(held(x.t), [], `${deep} ${known}`);
      // this walk: no more
      sameObject(await walk.tree(f.b, 1), f.b);
      sameObject(await walk.commit(f.tip, 2), f.tip);
      assert.deepEqual(x.sent(), [['b', 'tree:0'], ['commit', 'tree:0']], `${deep} ${known}: the walk stopped asking`);
      // the next walk: asks again unless the record says refused
      sameObject(await pathWalk(x.t).tree(f.b, 1), f.b);
      const next = x.sent();
      if (learned === 'refused') assert.deepEqual(next, [['b', 'tree:0']], `${deep} ${known}: refused, never asked again`);
      else assert.deepEqual(known ? next : next.toSorted(), [['b', D1], ['b', 'tree:0']], `${deep} ${known}: asked again`);
    }
  }
  // the commit's deep fetch failing stops the walk's trees too (walkCommit shares one walk)
  const x = fake({ deep: 'drop' }); learnPathTrees(x.t.quirks, 'taken');
  unwrap(await walkCommit(x.t, f.tip, ['a', 'b', 'c', 'd'], { levels: 4 }));
  assert.deepEqual(x.sent(), [['commit', D2], ['commit', 'tree:0'], ['root', 'tree:0'], ['a', 'tree:0'], ['b', 'tree:0'], ['c', 'tree:0']]);
});

test('the tree:0 fetch\'s own errors are the walk\'s: a refused deep fetch never replaces them, and commitForWalk names a missing commit', async () => {
  const missing = 'c'.repeat(40);
  const x = fake({ deep: 'refuse' });
  const inner = Object.getPrototypeOf(x.t).frames;
  Object.getPrototypeOf(x.t).frames = async function* frames(service, body, ...rest) {
    if (td.decode(body).includes(missing)) { yield dat(`ERR upload-pack: not our ref ${missing}\n`); yield FL; return; }
    yield* inner.call(this, service, body, ...rest);
  };
  const got = await commitForWalk(x.t, missing, 2);
  assert.equal(got.ok, false);
  assert.equal(got.error.code, 'not_found');
  assert.deepEqual(got.error.miss, { kind: 'commit', miss: { kind: 'absent', oid: missing } });
  const raw = await pathWalk(x.t).commit(missing, 2);
  assert.equal(raw.error.code, 'remote_error', 'the walk itself returns the fetch\'s error (editFile reads it as it is)');
  const tree = await pathWalk(x.t).tree(missing, 2);
  assert.equal(tree.error.code, 'remote_error');
});

test('a lying path-trees pack for a tree: every object is keyed by its computed hash, so a substituted tree is never read as the wanted one or as its child', async () => {
  const f = fixture();
  const o = oid => f.objects.get(oid);
  const lies = {
    // another tree where the wanted one should be: the pack does not hold the want
    'substituted want': () => [o(f.q), o(f.c)],
    // the wanted tree, and another valid tree where its child should be: kept under its own hash, never read as c
    'forged child': () => [o(f.b), o(f.s1)],
    // the wanted tree alone
    'want only': () => [o(f.b)],
    // a commit where a tree was asked
    'a commit': () => [o(f.tip)],
    // a malformed extra (an entry named .git): nothing of the answer is used
    'malformed extra': () => [o(f.b), o(f.c), { type: TYPE.TREE, data: concat([te.encode('100644 .git\0'), new Uint8Array(20).fill(7)]) }],
  };
  for (const [name, lie] of Object.entries(lies)) {
    const ex = arrayExporter();
    const x = fake({ deep: (want, _filter, oids) => (want === f.b ? lie() : oids.map(o)), tracer: new Tracer({ exporter: ex }) }); learnPathTrees(x.t.quirks, 'taken');
    const cache = new Map();
    const got = unwrap(await walkCommit(x.t, f.tip, ['a', 'b', 'c', 'd', 'w'], { cache, levels: 5 }));
    assert.equal(got.entry.oid, hashObject('blob', te.encode('w')), name);
    for (const [oid, data] of cache) assert.equal(hashObject('tree', data), oid, `${name}: a cached tree is the tree of its id`);
    assert.deepEqual([...cache.keys()].map(k => f.names.get(k)), ['root', 'a', 'b', 'c', 'd'], name);
    const sent = x.sent();
    assert.deepEqual(sent.slice(0, 2), [['commit', D2], ['b', D1]], name);
    const used = name === 'forged child' || name === 'want only';
    // used (the want is in it): b is the answer and c, which did not come, is fetched by its level, with d (the walk goes on asking)
    // not used: b by its level, and the walk asks no more
    assert.deepEqual(sent.slice(2), used ? [['c', D1]] : [['b', 'tree:0'], ['c', 'tree:0'], ['d', 'tree:0']], name);
    const span = ex.lines.flatMap(flattenLine).find(s => s.attrs['git.fetch.path_trees'] === D1);
    assert.equal(span.attrs['error.type'] ?? null, used ? null : 'pack_corrupt', name);
  }
});

test('spans: a path-trees fetch names its filter on a commit want and on a tree want; a tree:0 fetch does not', async () => {
  const f = fixture();
  const ex = arrayExporter();
  const x = fake({ tracer: new Tracer({ exporter: ex }) }); learnPathTrees(x.t.quirks, 'taken');
  unwrap(await walkCommit(x.t, f.tip, ['a', 'b', 'c', 'd', 'w'], { levels: 5 }));
  const fetches = ex.lines.flatMap(flattenLine).filter(s => s.name === 'git.upload-pack fetch');
  assert.deepEqual(fetches.map(s => [s.attrs['git.fetch.path_trees'] ?? null, s.attrs['git.object.type'], s.attrs['git.fetch.wide.harvested'] ?? null]), [[D2, 'commit', 3], [D1, 'tree', 1], [null, 'tree', null]]);
});
