// resolvePackRange's memory bound (#248), measured: each cell is its own process (test/stream/resolve-cell.mjs,
// --expose-gc) under a 64 MiB V8 heap. The pack is on disk and read back through a file RangeSource, so live
// arrayBuffers count what the resolver holds, not the pack. The bound the README states is one base, one pinned result,
// one result, one delta's instructions and the cache: max(maxObjectSize, maxDeltaResult) + 3 x maxDeltaResult +
// cacheBytes, whatever the pack's size, depth or shape. Linear chains hold less (a base, its result and the cache): the
// pack grows four times between the two cells and the peak must not. A forked family larger than the cache
// (test/stream/resolve-fork-cell.mjs) is the shape that pins a result and rebuilds bases, held to the stated bound.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { MEMORY_CELL_FLAGS } from './memcell.js';

const MIB = 1024 * 1024;
const SIZE = 4 * MIB;
const CACHE = 8 * MIB;
const DEPTH = 10;
function cell(chains) {
  const r = spawnSync(process.execPath, [...MEMORY_CELL_FLAGS, '--max-old-space-size=64', '--import', './test/ts-resolve.mjs', 'test/stream/resolve-cell.mjs', String(chains), String(DEPTH), String(SIZE), String(CACHE)], { encoding: 'utf8', env: process.env, maxBuffer: 1 << 20 });
  assert.equal(r.status, 0, `chains ${chains}: exit ${r.status}\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

test('resolving chains of 4 MiB objects holds one base, one result and the cache, however large the pack', () => {
  const small = cell(2);
  const large = cell(8);
  console.log(JSON.stringify({ small, large }));
  assert.ok(large.packBytes >= 4 * small.packBytes - MIB);
  assert.equal(large.stats.applied, 8 * DEPTH * SIZE);
  // a base and its result; the cache holds those same buffers (or others up to CACHE), and a 64 KiB read piece
  const bound = 2 * SIZE + CACHE + MIB;
  for (const r of [small, large]) assert.ok(r.abDelta <= bound, `${r.chains} chains held ${r.abDelta} > ${bound}`);
  assert.ok(Math.abs(large.abDelta - small.abDelta) <= MIB, `the peak grew with the pack: ${small.abDelta} -> ${large.abDelta}`);
});

test('a forked family of 2 MiB objects larger than the cache resolves to the right oids inside the stated bound', () => {
  const FORK_SIZE = 2 * MIB;
  const FORK_DEPTH = 12;
  const r = spawnSync(process.execPath, [...MEMORY_CELL_FLAGS, '--max-old-space-size=64', '--import', './test/ts-resolve.mjs', 'test/stream/resolve-fork-cell.mjs', String(FORK_DEPTH), String(FORK_SIZE), String(CACHE)], { encoding: 'utf8', env: process.env, maxBuffer: 1 << 20 });
  assert.equal(r.status, 0, `fork cell: exit ${r.status}\n${r.stderr}`);
  const got = JSON.parse(r.stdout.trim().split('\n').at(-1));
  console.log(JSON.stringify(got));
  // by hand: a root and, at each of 12 levels, two deltas on the spine and a leaf: 37 objects, 74 MiB against an 8 MiB cache
  assert.equal(got.entries, 37);
  assert.equal(got.wanted, 37);
  assert.ok(got.entries * FORK_SIZE > 4 * CACHE, 'the family fits the cache');
  // every oid is node:crypto's over the bytes the edits describe (the cell compares them)
  assert.equal(got.oidsRight, 37);
  // the fork did miss the cache: bases were made again
  assert.ok(got.stats.rebuilt > 0, 'nothing was rebuilt: the family fit the cache');
  // by hand, with maxObjectSize = maxDeltaResult = 2 MiB: 2 MiB + 3 x 2 MiB + 8 MiB = 16,777,216
  const bound = Math.max(FORK_SIZE, FORK_SIZE) + 3 * FORK_SIZE + CACHE;
  assert.equal(bound, 16_777_216);
  assert.ok(got.abDelta <= bound, `the forked family held ${got.abDelta} > ${bound}`);
});
