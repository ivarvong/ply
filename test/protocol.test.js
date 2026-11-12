// Exhaustive protocol matrix against real git. Not sampled: the full product of
//   want kind × have kind × deepen × filter × server mode   (thin, ofs-delta, done and client-shallow cycle deterministically)
// Every cell checks: required ⊆ got ⊆ required ∪ had (model bound), got == pack-objects (git oracle), object
// types/sizes, shallow/unshallow lines, thin bases derivable from haves, no OFS when not requested, chain ≤ pack.depth.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { packObjectsArgs } from './fuzz/packobjects.js';
import { plan, WANT_KEYS, HAVE_KEYS, DEEPEN_KEYS, FILTER } from './protocol-matrix.js';

// The matrix enumerates four dimensions and cycles three flags with the cell number. A cycle whose period divides a
// dimension's stride makes the flag a function of that dimension: `i % 3` under a 9-value innermost filter loop asked
// for thin-pack with three filters only and never with no filter. The rule is stated here, not read off the plan:
// every value of every enumerated dimension, every (deepen, filter) pair and every (want, have) pair meets thin-pack
// on and off, ofs-delta on and off, done and negotiate, and all four (thin-pack, ofs-delta) combinations.
test('matrix plan: no cycled flag is a function of an enumerated dimension', () => {
  const groups = new Map();
  let cells = 0;
  for (const c of plan()) {
    cells++;
    const f = c.filter ?? '-';
    for (const g of [`want=${c.wk}`, `have=${c.hk}`, `deepen=${c.dk}`, `filter=${f}`, `deepen=${c.dk} filter=${f}`, `want=${c.wk} have=${c.hk}`]) {
      const seen = groups.get(g) ?? new Set();
      for (const k of [`thin=${c.thinPack}`, `ofs=${c.ofsDelta}`, `done=${c.done}`, `thin=${c.thinPack} ofs=${c.ofsDelta}`]) seen.add(k);
      groups.set(g, seen);
    }
  }
  // 8 wants x 11 haves x 6 deepens x 9 filters, counted by hand from SAFETY.md's dimension list
  assert.deepEqual([WANT_KEYS.length, HAVE_KEYS.length, DEEPEN_KEYS.length, FILTER.length, cells], [8, 11, 6, 9, 4752]);
  assert.equal(groups.size, 8 + 11 + 6 + 9 + 6 * 9 + 8 * 11);
  const want = ['thin=true', 'thin=false', 'ofs=true', 'ofs=false', 'done=true', 'done=false', 'thin=true ofs=true', 'thin=true ofs=false', 'thin=false ofs=true', 'thin=false ofs=false'];
  const missing = [];
  for (const [g, seen] of groups) for (const k of want) if (!seen.has(k)) missing.push(`${g}: never ${k}`);
  assert.deepEqual(missing.slice(0, 12), [], `${missing.length} (group, flag) combinations never run`);
});

test('pack-objects argv: git 2.55 create_pack_file, git 2.56 odb_source_files_generate_pack', () => {
  const full = { thinPack: true, shallows: ['aa'], ofsDelta: true, filter: 'blob:none' };
  assert.equal(packObjectsArgs({ ...full, version: [2, 55, 0] }).join(' '), '--revs --thin --stdout --shallow --delta-base-offset --filter=blob:none');
  assert.equal(packObjectsArgs({ ...full, version: [2, 56, 0] }).join(' '), '--revs --stdout --thin --shallow --delta-base-offset --quiet --filter=blob:none');
  assert.equal(packObjectsArgs({ thinPack: false, shallows: [], ofsDelta: false, version: [2, 43, 0] }).join(' '), '--revs --stdout');
  assert.equal(packObjectsArgs({ thinPack: false, shallows: [], ofsDelta: false, version: [2, 56, 0] }).join(' '), '--revs --stdout --quiet');
});

test('exhaustive fetch matrix: wants × haves × deepen × filter × server', async () => {
  // One worker thread per server mode (test/protocol-matrix.js): the same cells and checks, the modes side by side.
  const runs = await Promise.all(['loose', 'packed', 'bitmap'].map(mode => new Promise((resolve, reject) => {
    const w = new Worker(new URL('./protocol-matrix.js', import.meta.url), { workerData: { mode } });
    w.once('message', resolve); w.once('error', reject);
    w.once('exit', code => reject(new Error(`${mode} worker exited ${code} without a result`)));
  })));
  for (const r of runs) if (!r.ok) assert.fail(r.error);
  const stats = { cells: 0, modelExact: 0, oracleExact: 0, invocationExact: 0, degenerate: 0, crash: 0 };
  for (const r of runs) for (const k of Object.keys(stats)) stats[k] += r.stats[k];
  const seen = new Map(runs.flatMap(r => r.seen));
  console.log(`  cells=${stats.cells} oracleExact=${stats.oracleExact} invocationExact=${stats.invocationExact} modelExact=${stats.modelExact} degenerate=${stats.degenerate} serverCrash=${stats.crash}`);
  // No cell is excused for a refusal: a remote_error fails its cell in the worker (the server refuses no request of the plan).
  assert.equal(stats.cells, 3 * 4752, 'three server modes, every cell of the plan');
  assert.equal(stats.oracleExact, stats.cells - stats.degenerate - stats.crash, 'every non-degenerate cell is pack-objects-exact');
  assert.ok(stats.crash + stats.degenerate < stats.cells * 0.25, 'degenerate deepen-since/not combos stay a minority (each one is only accepted when the degeneracy predicate holds)');
  // the three server modes must agree wherever bitmaps cannot be used (deepen present or unsupported filter)
  let disagree = 0, compared = 0;
  for (const [k, v] of seen) if (k.startsWith('loose|')) { const kp = k.replace('loose|', 'packed|'); if (seen.has(kp)) { compared++; if (seen.get(kp) !== v) disagree++; } }
  assert.equal(disagree, 0, `loose vs packed(no bitmap) must be identical: ${disagree}/${compared} differ`);
});
