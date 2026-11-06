// #218, the decision table of commitForWalk (src/pathtrees.ts) over a fake transport, fast enough for the mutation run
// (vitest.stryker.config.ts). What git does with each request is test/path-trees.test.js's; this file pins which
// requests are sent, what is learned, and which answer is returned, for every state × outcome.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { commitForWalk, isPathTreesRefusal, pathTreesFilter, PATH_TREE_LEVELS } from '../src/pathtrees.js';
import { asTransport, pathTreesOf, learnPathTrees, tree0Taken, freshQuirks } from '../src/transport.js';
import { buildPack } from '../src/pack.js';
import { encodeTree, encodeCommit, hashObject, TYPE } from '../src/objects.js';
import { concat, td, te } from '../src/bytes.js';
import { DEFAULT_LIMITS, parseLimits } from '../src/limits.js';
import { Tracer } from '../src/otel.js';
import { SIDEBAND_PACK } from '../src/format.js';
import { unwrap } from './unwrap.js';

const author = 'Ada <ada@ex> 1700000000 +0000';
const blob = hashObject('blob', te.encode('x\n'));
const sub = unwrap(encodeTree([{ mode: '100644', name: 'f.txt', oid: blob }]));
const subId = hashObject('tree', sub);
const rootTree = unwrap(encodeTree([{ mode: '40000', name: 'a', oid: subId }, { mode: '100644', name: 'r.txt', oid: blob }]));
const rootId = hashObject('tree', rootTree);
const commit = unwrap(encodeCommit({ tree: rootId, parents: [], author, message: 'root\n' }));
const tip = hashObject('commit', commit);
const dat = s => ({ kind: 'data', payload: typeof s === 'string' ? te.encode(s) : s });
const FL = { kind: 'flush' };
async function* packFrames(objects) {
  const { pack } = await buildPack(objects);
  yield dat('packfile\n'); yield dat(concat([Uint8Array.of(SIDEBAND_PACK), pack])); yield FL;
}
const C = { type: TYPE.COMMIT, data: commit };
const T = { type: TYPE.TREE, data: rootTree };
const S = { type: TYPE.TREE, data: sub };

// deep(filter): the answer to a combine request: 'ok' (commit + both trees), 'refuse' (git's ERR), 'depth' (git's depth
// ERR), 'http400' (Artifacts' refusal), 'commitOnly', 'broken' (a pack without the commit), 'drop' (network).
function fake(deep) {
  const log = [];
  const t = asTransport({
    kind: 'http', url: 'http://h/r.git', tracer: new Tracer(), parent: null, limits: DEFAULT_LIMITS, signal: null, quirks: freshQuirks(), objects: null, scrub: null,
    async *frames(_service, body) {
      const text = td.decode(body);
      const filter = (text.match(/filter (\S+)/) ?? [])[1] ?? '';
      log.push(filter);
      if (filter === 'tree:0') { yield* packFrames([C]); return; }
      switch (deep) {
        case 'ok': yield* packFrames([C, T, S]); return;
        case 'commitOnly': yield* packFrames([C]); return;
        case 'broken': yield* packFrames([T, S]); return;
        case 'refuse': yield dat("ERR filter 'combine' not supported\n"); yield FL; return;
        case 'depth': yield dat('ERR tree filter allows max depth 0, but got 2\n'); yield FL; return;
        case 'http400': throw Object.assign(new Error('HTTP 400 git-upload-pack: Unsupported Git fetch filter; only blob:none is supported.'), { code: 'http', status: 400 });
        case 'drop': throw Object.assign(new Error('network: socket hang up'), { code: 'network' });
      }
      throw new Error(`no answer for ${deep}`);
    },
    async advertise() { return { ok: false, error: { code: 'http', message: 'none' } }; },
  }, unwrap(parseLimits(DEFAULT_LIMITS)));
  return { t, log };
}
// Settle tree:0 on the record (the first contact): a tree:0 commit fetch.
const settle = async t => { assert.equal((await commitForWalk(t, tip, 0)).ok, true); assert.equal(tree0Taken(t.quirks), true); };
const sameCommit = r => { assert.equal(r.ok, true); assert.equal(r.value.oid, tip); assert.deepEqual(r.value.data, commit); assert.equal(r.value.commit.tree, rootId); };

test('pathTreesFilter and PATH_TREE_LEVELS', () => {
  assert.equal(PATH_TREE_LEVELS, 2);
  assert.deepEqual([1, 2, 3, 9].map(pathTreesFilter), ['combine:blob:none+tree:1', 'combine:blob:none+tree:2', 'combine:blob:none+tree:2', 'combine:blob:none+tree:2']);
});

test('no levels, tree:0 not settled, or a non-tree:0 record: the tree:0 commit fetch alone, nothing learned', async () => {
  const a = fake('ok');
  sameCommit(await commitForWalk(a.t, tip, 0));
  assert.deepEqual(a.log, ['tree:0']);
  sameCommit(await commitForWalk(a.t, tip, 0));
  assert.deepEqual(a.log, ['tree:0', 'tree:0'], 'levels 0 never asks, settled or not');
  assert.equal(pathTreesOf(a.t.quirks), null);
  const b = fake('ok');
  sameCommit(await commitForWalk(b.t, tip, 2));
  assert.deepEqual(b.log, ['tree:0'], 'first contact: tree:0 alone');
  assert.equal(pathTreesOf(b.t.quirks), null);
  for (const filter of ['blob:none', 'none']) {
    const c = fake('ok'); await settle(c.t); c.t.quirks.treeFilter = filter;
    assert.equal(tree0Taken(c.t.quirks), false, filter);
  }
});

test('settled, not known: the race; ok is taken and the deep answer is used (its trees harvested)', async () => {
  const f = fake('ok'); await settle(f.t); f.log.length = 0;
  const r = await commitForWalk(f.t, tip, 2);
  sameCommit(r);
  assert.deepEqual(f.log.toSorted(), ['combine:blob:none+tree:2', 'tree:0']);
  assert.equal(pathTreesOf(f.t.quirks), 'taken');
  assert.equal(f.t.objects.get(rootId)?.type, TYPE.TREE);
  assert.equal(f.t.objects.get(subId)?.type, TYPE.TREE);
  assert.equal(f.t.objects.has(tip), false, 'the wanted commit is the answer, not harvested');
  // taken: the deep fetch alone, K from levels
  f.log.length = 0;
  sameCommit(await commitForWalk(f.t, tip, 1));
  assert.deepEqual(f.log, ['combine:blob:none+tree:1']);
});

test('settled, not known: a refusal (each kind) is learned refused and the tree:0 answer is used', async () => {
  for (const kind of ['refuse', 'depth', 'http400']) {
    const f = fake(kind); await settle(f.t); f.log.length = 0;
    sameCommit(await commitForWalk(f.t, tip, 2));
    assert.deepEqual(f.log.toSorted(), ['combine:blob:none+tree:2', 'tree:0'], kind);
    assert.equal(pathTreesOf(f.t.quirks), 'refused', kind);
    assert.equal(f.t.objects.size, 0, kind);
    f.log.length = 0;
    sameCommit(await commitForWalk(f.t, tip, 2));
    assert.deepEqual(f.log, ['tree:0'], `${kind}: refused, never asked again`);
  }
});

test('settled, not known: any other failure is not learned and not used', async () => {
  for (const kind of ['broken', 'drop']) {
    const f = fake(kind); await settle(f.t); f.log.length = 0;
    sameCommit(await commitForWalk(f.t, tip, 2));
    assert.equal(pathTreesOf(f.t.quirks), null, kind);
    assert.equal(f.t.objects.size, 0, kind);
  }
});

test('taken: a refusal falls back and is learned; another failure falls back and stays taken', async () => {
  for (const [kind, learned] of [['refuse', 'refused'], ['depth', 'refused'], ['http400', 'refused'], ['broken', 'taken'], ['drop', 'taken']]) {
    const f = fake(kind); await settle(f.t); learnPathTrees(f.t.quirks, 'taken'); f.log.length = 0;
    sameCommit(await commitForWalk(f.t, tip, 2));
    assert.deepEqual(f.log, ['combine:blob:none+tree:2', 'tree:0'], kind);
    assert.equal(pathTreesOf(f.t.quirks), learned, kind);
  }
  // the commit alone: taken, used, nothing to harvest
  const f = fake('commitOnly'); await settle(f.t); learnPathTrees(f.t.quirks, 'taken'); f.log.length = 0;
  sameCommit(await commitForWalk(f.t, tip, 2));
  assert.deepEqual(f.log, ['combine:blob:none+tree:2']);
  assert.equal(f.t.objects.size, 0);
});

test('isPathTreesRefusal', () => {
  const e = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
  assert.equal(isPathTreesRefusal(e('remote_error', "remote: filter 'combine' not supported")), true);
  assert.equal(isPathTreesRefusal(e('remote_error', 'remote: tree filter allows max depth 1, but got 2')), true);
  assert.equal(isPathTreesRefusal(e('http', 'HTTP 400 git-upload-pack: Unsupported Git fetch filter; only blob:none is supported.', { status: 400 })), true);
  assert.equal(isPathTreesRefusal(e('protocol', 'v2: response ended without flush', { reason: 'empty_response' })), true);
  assert.equal(isPathTreesRefusal(e('protocol', 'v2: response ended without flush')), false);
  assert.equal(isPathTreesRefusal(e('remote_error', 'remote: something else')), false);
  assert.equal(isPathTreesRefusal(e('pack_corrupt', 'tree filter allows max depth 0')), false);
  assert.equal(isPathTreesRefusal(e('http', 'HTTP 500 only blob:none is supported', { status: 500 })), false);
  assert.equal(isPathTreesRefusal(e('timeout', 'timed out')), false);
});
