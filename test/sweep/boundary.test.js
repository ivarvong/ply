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

test('every Limits key has cells, and each limit is crossed in CI: a cell at or under the boundary and one past it', () => {
  const cells = allCells();
  assert.deepEqual(PARAMS.filter(p => p.later).map(p => p.key), []);
  for (const { key } of PARAMS) {
    const mine = cells.filter(c => c.param === key);
    assert.ok(mine.length >= 3, `${key}: ${mine.length} cells`);
    assert.ok(mine.some(c => isCi(c)), `${key}: no CI cell`);
  }
});

test('second-pass cells (#144) exist: thin packs, protocol v0/v1, pkt-line lengths, caps, timeout, workerd', () => {
  const ids = new Set(allCells().map(c => c.id));
  for (const id of [
    'objects.pack.tiny-99898', 'objects.pack.tiny-99899', 'section.acks.h999', 'section.acks.h1000', 'section.shallow.k1000', 'section.shallow.k1001',
    'thin.push.thin', 'thin.fetch.external', 'proto.v0.lsRefs', 'proto.v1.readFile', 'pktline.frame-4.readFile.1024', 'pktline.frame-65520.readFile',
    'pktline.frame-65521.readFile', 'caps.nofilter.readFile', 'timeout.cap1000.lsRefs.stall-2500', 'timeout.lsRefs.delay-65000', 'workerd.readFile.16777216',
    'delta.ofs.d65', 'parents.octo-10001', 'report.n10000', 'rebase.cap8.k9',
  ]) assert.equal(ids.has(id), true, id);
  const wd = allCells().filter(c => c.runtime === 'workerd');
  assert.ok(wd.length >= 8 && wd.filter(c => isCi(c)).length >= 6, `workerd cells ${wd.length}`);
  // the slow-server cells at the default 60 s timers are nightly; CI crosses a 1 s cap (#255: one per timer)
  const timers = ['requestTimeoutMs', 'firstByteTimeoutMs', 'idleTimeoutMs', 'heldTimeoutMs'];
  for (const c of allCells().filter(c => timers.includes(c.param) && !c.id.startsWith('parse.') && !c.limits?.[c.param])) assert.equal(isCi(c), false, c.id);
  for (const key of timers) assert.ok(allCells().some(c => c.param === key && isCi(c) && c.limits?.[key] === 1000), `a CI cell crosses a 1 s ${key}`);
});

test('every Limits key is parsed where it enters (#156): a CI cell per key refuses a value that bounds nothing at an operation that never reads it', () => {
  const cells = allCells();
  for (const { key } of PARAMS) {
    const mine = cells.filter(c => c.id.startsWith(`parse.${key}.`));
    assert.equal(mine.length, 2, key);
    for (const c of mine) {
      assert.ok(isCi(c), c.id);
      assert.equal(c.op, 'lsRefs', c.id);
      assert.deepEqual(Object.keys(c.limits), [key], c.id);
      // null is a value on every key, refused like -1 (#271)
      assert.deepEqual(c.expect, { status: 'refused', code: 'bad_request', what: key }, c.id);
    }
  }
  const work = cells.filter(c => c.id.startsWith('parse.maxResolveWork.'));
  assert.deepEqual(work.map(c => [c.id, c.limits.maxResolveWork, c.expect.status]), [['parse.maxResolveWork.negative', -1, 'refused'], ['parse.maxResolveWork.null', null, 'refused']]);
  assert.deepEqual(cells.find(c => c.id === 'parse.none').expect, { status: 'ok' });
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
    const cell = allCells().find(c => c.id === entry.id);
    assert.ok(cell?.runtime === 'workerd' ? entry.heap === 'workerd' : entry.heap === 'default' || entry.heap === '128', `${entry.id} heap ${entry.heap}`);
    assert.equal(typeof entry.why, 'string');
    assert.ok(entry.why.length > 12, entry.id);
    assert.match(entry.why, /#\d+/, `${entry.id}: the reason cites an issue`);
    assert.equal(typeof entry.actual?.status, 'string');
  }
});
