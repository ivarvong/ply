// resolvePackRange's memory bound (#248), measured: each cell is its own process (test/stream/resolve-cell.mjs,
// --expose-gc) under a 64 MiB V8 heap. The pack is on disk and read back through a file RangeSource, so live
// arrayBuffers count what the resolver holds, not the pack. The bound is one base + one result + the cache; the pack
// grows four times between the two cells and the peak must not.
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
