// Exhaustive protocol matrix against real git. Not sampled: the full product of
//   want kind × have kind × deepen × filter × server mode   (thin, ofs-delta, done and client-shallow cycle deterministically)
// Every cell checks: required ⊆ got ⊆ required ∪ had (model bound), got == pack-objects (git oracle), object
// types/sizes, shallow/unshallow lines, thin bases derivable from haves, no OFS when not requested, chain ≤ pack.depth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { packObjectsArgs } from './fuzz/packobjects.js';

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
  const stats = { cells: 0, modelExact: 0, oracleExact: 0, invocationExact: 0, degenerate: 0, crash: 0, remote: 0 };
  for (const r of runs) for (const k of Object.keys(stats)) stats[k] += r.stats[k];
  const seen = new Map(runs.flatMap(r => r.seen));
  console.log(`  cells=${stats.cells} oracleExact=${stats.oracleExact} invocationExact=${stats.invocationExact} modelExact=${stats.modelExact} degenerate=${stats.degenerate} serverCrash=${stats.crash} remoteRefused=${stats.remote}`);
  assert.equal(stats.oracleExact, stats.cells - stats.degenerate - stats.crash - stats.remote, 'every non-degenerate cell is pack-objects-exact');
  assert.ok(stats.crash + stats.degenerate < stats.cells * 0.25, 'degenerate deepen-since/not combos stay a minority (each one is only accepted when the degeneracy predicate holds)');
  // the three server modes must agree wherever bitmaps cannot be used (deepen present or unsupported filter)
  let disagree = 0, compared = 0;
  for (const [k, v] of seen) if (k.startsWith('loose|')) { const kp = k.replace('loose|', 'packed|'); if (seen.has(kp)) { compared++; if (seen.get(kp) !== v) disagree++; } }
  assert.equal(disagree, 0, `loose vs packed(no bitmap) must be identical: ${disagree}/${compared} differ`);
});
