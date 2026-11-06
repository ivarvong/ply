// parseTree answers exactly what it answered before #207 (test/oracle/parsetree-ref.ts, the c91c9cf parser): the same
// entries (mode, name, oid, offsets) or the same refusal (code and message), on random trees built to reach every
// refusal: bad and canonicalized modes, missing separators, short ids, null ids, every .git/.gitmodules spelling,
// duplicates, order with directory keys, and the entry cap. The large run is test/fuzz/parsetree.mjs.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { rng } from './dotnames-corpus.js';
import { randomTree, judgeTrees } from './parsetree-corpus.js';
import { assertFetched, parseTree, encodeTree, encodeCommit } from '../src/objects.js';
import { treeEntries } from '../src/fetch.js';
import { DEFAULT_LIMITS, parseLimits } from '../src/limits.js';
import { unwrap } from './unwrap.js';

// A fetched tree is parsed once (#208): assertFetched's answer is the tree's entries (none for any other type), and
// treeEntries hands that very array to the reader when its entry cap is the one the check ran under, else parses.
const tree = unwrap(encodeTree([{ mode: '100644', name: 'a', oid: '1'.repeat(40) }, { mode: '40000', name: 'd', oid: '2'.repeat(40) }]));
test('assertFetched answers a tree with its entries, any other type with none', () => {
  const r = unwrap(assertFetched('tree', tree));
  assert.equal(r.tag, 'some');
  assert.deepEqual(r.value.map(e => [e.mode, e.name, e.oid]), unwrap(parseTree(tree)).map(e => [e.mode, e.name, e.oid]));
  const commit = unwrap(encodeCommit({ tree: '3'.repeat(40), author: 'a <a@b> 0 +0000' }));
  for (const [type, data] of [['blob', tree], ['commit', commit], ['ofs_delta', tree], ['ref_delta', tree]]) assert.deepEqual(unwrap(assertFetched(type, data)), { tag: 'none' }, type);
  // a refusal is still the refusal
  assert.equal(assertFetched('tree', tree.subarray(0, tree.length - 1)).ok, false);
});
test('treeEntries: the check parse when the entry cap matches, the reader\'s own parse when it does not', () => {
  const checked = unwrap(assertFetched('tree', tree)).value;
  const fetched = (t, max) => ({ type: 2, data: tree, oid: '4'.repeat(40), size: tree.length, bust: false, tree: t === null ? { tag: 'none' } : { tag: 'some', value: { entries: t, maxTreeEntries: max } } });
  const limits = unwrap(parseLimits(DEFAULT_LIMITS));
  assert.equal(unwrap(treeEntries(fetched(checked, limits.maxTreeEntries), limits)), checked, 'the same array: not parsed again');
  const other = unwrap(treeEntries(fetched(checked, limits.maxTreeEntries + 1), limits));
  assert.notEqual(other, checked, 'another cap: parsed under the reader\'s limits');
  assert.deepEqual(other.map(e => e.name), ['a', 'd']);
  const harvested = unwrap(treeEntries(fetched(null, 0), limits));
  assert.deepEqual(harvested.map(e => e.name), ['a', 'd']);
  // the reader's cap binds when it is not the check's: one entry allowed
  const one = unwrap(parseLimits({ maxTreeEntries: 1 }));
  assert.equal(treeEntries(fetched(checked, limits.maxTreeEntries), one).error.code, 'limit_exceeded');
});

test('random trees: the same entries or the same refusal as before (seeded)', () => {
  const r = rng(Number(process.env.PARSETREE_SEED ?? 207));
  const n = process.env.MUTATION === '1' ? 4_000 : 40_000;
  const stats = { n: 0, accepted: 0, refused: {} };
  const bad = judgeTrees((function* () { for (let i = 0; i < n; i++) yield randomTree(r); })(), stats);
  assert.equal(bad, null, JSON.stringify(bad));
  // not vacuous: trees are accepted, and every refusal parseTree has is reached
  assert.ok(stats.accepted > n / 20, `${stats.accepted} accepted`);
  for (const why of ['tree: malformed entry', 'tree: empty mode', 'tree: malformed mode', 'tree: empty name', 'tree: zero-padded mode', 'tree: full pathname', 'tree: bad name', 'tree: large pathname', 'tree: null shaN', 'tree: .gitmodules is a symbolic link', 'tree: .gitmodules is not a blob', 'tree: .gitattributes is not a blob', 'tree: duplicate entry "…"', 'tree: not strictly sorted']) {
    assert.ok(stats.refused[why] > 0, `${why} never reached: ${JSON.stringify(stats.refused)}`);
  }
  assert.ok(Object.keys(stats.refused).some(k => k.startsWith('short read')), 'short read never reached');
  assert.ok(Object.keys(stats.refused).some(k => k.startsWith('tree entries')), 'entry cap never reached');
});
