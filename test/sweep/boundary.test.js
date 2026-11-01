import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LIMITS } from '../../src/limits.js';
import { boundaryValues } from './boundary.mjs';
import { PARAMS } from './params.mjs';
import { CI_BYTES, CI_ENTRIES, allCells, isCi } from './matrix.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ratchet = JSON.parse(readFileSync(join(here, 'ratchet.json'), 'utf8'));

test('boundary values are 0, 1, the limit, both neighbours, and powers of two through the first power past it', () => {
  assert.deepEqual(boundaryValues(0), [0, 1]);
  assert.deepEqual(boundaryValues(1), [0, 1, 2]);
  assert.deepEqual(boundaryValues(8), [0, 1, 2, 4, 7, 8, 9, 16]);
  const tree = boundaryValues(DEFAULT_LIMITS.maxTreeEntries);
  for (const n of [0, 1, 199_999, 200_000, 200_001, 262_144]) assert.ok(tree.includes(n), String(n));
  assert.equal(tree.includes(524_288), false);
  assert.equal(boundaryValues(DEFAULT_LIMITS.maxDeltaChain).includes(65), true);
});

test('every Limits key is in the param registry', () => {
  assert.deepEqual(PARAMS.map(p => p.key).sort(), Object.keys(DEFAULT_LIMITS).sort());
  for (const row of PARAMS) {
    assert.equal(row.limit, DEFAULT_LIMITS[row.key]);
    assert.equal(row.later, row.probe === null);
  }
});

test('pass-2 limits are registered and have no cells yet', () => {
  const later = new Set(PARAMS.filter(p => p.later).map(p => p.key));
  for (const key of ['maxHarvestBytes', 'maxDeltaResult', 'maxPackObjects', 'maxSectionLines', 'maxRebaseCommits', 'maxReportLines', 'maxCommitParents', 'requestTimeoutMs']) {
    assert.equal(later.has(key), true, key);
  }
  for (const cell of allCells()) assert.equal(later.has(cell.param), false, cell.id);
});

test('CI keeps cells up to 16 MiB and 65536 entries; the known large boundaries are nightly', () => {
  const cells = allCells();
  const ids = new Set(cells.map(c => c.id));
  for (const id of ['refs.lsRefs.10000', 'refs.lsRefs.10001', 'depth.mergebase.k1024', 'depth.mergebase.k1025', 'depth.mergebase.k2048', 'tree.listTree.65536']) {
    assert.equal(ids.has(id), true, id);
    assert.equal(isCi(cells.find(c => c.id === id)), true, id);
  }
  for (const id of ['tree.listTree.199999', 'tree.listTree.200000', 'tree.listTree.200001', 'tree.listTree.262144', 'push.total.3x50331648', 'delta.ofs.d299']) {
    assert.equal(ids.has(id), true, id);
    assert.equal(isCi(cells.find(c => c.id === id)), false, id);
  }
  for (const cell of cells) {
    if (!isCi(cell)) continue;
    assert.ok((cell.bytes ?? 0) <= CI_BYTES, `${cell.id} bytes ${cell.bytes}`);
    assert.ok((cell.entries ?? 0) <= CI_ENTRIES, `${cell.id} entries ${cell.entries}`);
  }
  assert.ok(cells.length > 80, `matrix has ${cells.length} cells`);
});

test('the ratchet names cells the matrix builds, and only goes down by deleting a line', () => {
  const ids = new Set(allCells().map(c => c.id));
  assert.ok(Array.isArray(ratchet.entries));
  for (const entry of ratchet.entries) {
    assert.equal(ids.has(entry.id), true, entry.id);
    assert.ok(entry.heap === 'default' || entry.heap === '128', entry.heap);
    assert.equal(typeof entry.why, 'string');
    assert.ok(entry.why.length > 12, entry.id);
    assert.equal(typeof entry.actual?.status, 'string');
  }
});
