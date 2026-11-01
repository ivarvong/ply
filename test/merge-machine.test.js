// The merge cluster's machines, pure and at their one effect: the merge-base search (searchStep, #79's cap
// clamp) and attributeDrivers' shared lookups (#79: a failed lookup is not remembered).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { searchStep, attributeDrivers } from '../src/merge.js';
import { encodeTree, hashObject, TYPE } from '../src/objects.js';
import { buildPack } from '../src/pack.js';
import { te, concat } from '../src/bytes.js';
import { SIDEBAND_PACK } from '../src/format.js';
import { plyError } from '../src/errors.js';
import { DEFAULT_LIMITS } from '../src/limits.js';
import { Tracer } from '../src/otel.js';

const G = o => new Map(Object.entries(o).map(([k, parents]) => [k, { parents }]));

test('merge-base search: windows double from 8 and the last step is the cap itself (#79)', () => {
  // a graph that stays truncated at every window (b runs into an unfetched q), driven to the end
  const cut = G({ a: ['m'], b: ['q', 'm'], m: [] });
  const walk = c => { const cap = Math.floor(c); const seen = []; let s = cap < 1 ? { tag: 'capped' } : { tag: 'searching', depth: Math.min(8, cap) }; while (s.tag === 'searching') { seen.push(s.depth); s = searchStep(s.depth, cap, cut, 'a', 'b'); } return [...seen, s.tag]; };
  assert.deepEqual(walk(100), [8, 16, 32, 64, 100, 'capped'], 'cap 100 searches 100 (it stopped at 64)');
  assert.deepEqual(walk(64), [8, 16, 32, 64, 'capped']);
  assert.deepEqual(walk(32.9), [8, 16, 32, 'capped'], 'whole commits');
  assert.deepEqual(walk(9), [8, 9, 'capped']);
  assert.deepEqual(walk(8), [8, 'capped']);
  assert.deepEqual(walk(3), [3, 'capped'], 'a cap under the first window is the window (no search at all before)');
  assert.deepEqual(walk(1), [1, 'capped']);
  assert.deepEqual(walk(0.5), ['capped']);
  assert.deepEqual(walk(0), ['capped']);
  // the verdicts of a whole graph, at whatever window it was read
  assert.deepEqual(searchStep(8, 32, G({ a: ['m'], b: ['m'], m: ['r'], r: [] }), 'a', 'b'), { tag: 'found', depth: 8, base: 'm', bases: ['m'] });
  assert.deepEqual(searchStep(16, 32, G({ a: ['x', 'y'], b: ['y', 'x'], x: ['r'], y: ['r'], r: [] }), 'a', 'b'), { tag: 'criss-cross', depth: 16, bases: ['x', 'y'] });
  assert.deepEqual(searchStep(8, 32, G({ a: ['r1'], r1: [], b: ['r2'], r2: [] }), 'a', 'b'), { tag: 'unrelated', depth: 8, bases: [] });
  // #42: {c, z} with a cut below c is not yet criss-cross: search deeper
  assert.deepEqual(searchStep(8, 32, G({ a: ['c', 'z'], b: ['c', 'z'], c: ['x'], z: [] }), 'a', 'b'), { tag: 'searching', depth: 16 });
  assert.deepEqual(searchStep(32, 32, G({ a: ['c', 'z'], b: ['c', 'z'], c: ['x'], z: [] }), 'a', 'b'), { tag: 'capped', depth: 32 });
});

// A transport serving one blob for any fetch, failing the first `failures` requests with a transient network error.
function blobServer(data, failures) {
  const line = s => ({ kind: 'data', payload: te.encode(s) });
  const sideband = b => ({ kind: 'data', payload: concat([Uint8Array.of(SIDEBAND_PACK), b]) });
  const t = {
    limits: DEFAULT_LIMITS,
    tracer: new Tracer(),
    parent: null,
    objects: new Map(),
    quirks: {},
    url: 'stub://attrs',
    requests: 0,
    async *frames() {
      t.requests++;
      if (t.requests <= failures) throw plyError('network', 'connection reset');
      const { pack } = await buildPack([{ type: TYPE.BLOB, data }]);
      yield line('packfile\n'); yield sideband(pack); yield { kind: 'flush' };
    }
  };
  return t;
}

test('attributeDrivers: a failed lookup is forgotten, a successful one shared (#79)', async () => {
  const attrs = te.encode('*.bin -merge\n*.u merge=union\n');
  const blob = hashObject('blob', attrs);
  const root = encodeTree([{ mode: '100644', name: '.gitattributes', oid: blob }]);
  const tree = hashObject('tree', root);
  const t = blobServer(attrs, 1);
  const driverFor = attributeDrivers(t, new Map([[tree, root]]), tree);
  await assert.rejects(driverFor('a.bin'), e => e.code === 'network');
  // it answered the cached rejection for every later path of the directory; now it asks again
  assert.equal(await driverFor('a.bin'), 'binary');
  assert.equal(t.requests, 2);
  assert.equal(await driverFor('b.u'), 'union');
  assert.equal(await driverFor('c.txt'), 'text');
  assert.equal(t.requests, 2, 'the successful lookup is shared by every later path');
  // concurrent lookups share one pending request, and a failure reaches each of them
  const u = blobServer(attrs, 1);
  const shared = attributeDrivers(u, new Map([[tree, root]]), tree);
  const both = await Promise.allSettled([shared('x.bin'), shared('y.bin')]);
  assert.deepEqual(both.map(r => r.status), ['rejected', 'rejected']);
  assert.equal(u.requests, 1);
  assert.deepEqual(await Promise.all([shared('x.bin'), shared('y.u')]), ['binary', 'union']);
  assert.equal(u.requests, 2);
});
