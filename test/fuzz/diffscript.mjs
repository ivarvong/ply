// The diff under the merge, hunk by hunk against `git diff --histogram --no-indent-heuristic -U1` (changed lines rebuilt from the hunk bodies) — a stronger oracle than
// merge verdicts for the Myers fallback's heuristics (snake sampling past cost 256, the mxcost cutoff), which only fire on
// big, heavily edited, low-variety regions. --rediff skip models git releases without the compaction re-diff (the 2.43 oracle here).
//   node test/fuzz/diffscript.mjs [--n 200] [--seed 1] [--snake|--huge] [--rediff skip]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rng } from './prng.js';
import { records, classifier, diffScript } from '../../src/linemerge.js';

import { oracleRediff } from '../gitversion.js';
const REDIFF = process.argv.includes('--rediff') ? process.argv[process.argv.indexOf('--rediff') + 1] : oracleRediff(); // default: whatever the oracle git does
const GIT_BIN = process.env.GIT_BIN ?? 'git'; // GIT_BIN=/path/to/git: judge against another git build
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : +process.argv[i + 1]; };
const N = arg('n', 200), SEED = arg('seed', 1), SNAKE = process.argv.includes('--snake'), HUGE = process.argv.includes('--huge'); // --huge: ndiags ≥ 65536 so mxcost > 256 and the snake heuristic can fire
const dir = mkdtempSync(join(tmpdir(), 'ds-'));
const counts = { same: 0, differ: 0, undecided: 0 }; const bad = [];
const rng0 = new Rng(SEED);
for (let c = 0; c < N; c++) {
  const rng = new Rng(rng0.u32());
  const vocab = Array.from({ length: rng.int(1, 6) }, (_, i) => `v${i}\n`);
  const n = HUGE ? rng.int(34000, 40000) : SNAKE ? rng.int(3000, 8000) : rng.int(50, 3000);
  // --snake: long runs (snakes > 20) with many edits (cost > 256), where xdl_split samples diagonals heuristically
  const a = SNAKE || HUGE ? Array.from({ length: n }, (_, i) => vocab[Math.floor(i / rng.int(25, 40)) % vocab.length]) : Array.from({ length: n }, () => rng.pick(vocab));
  const b = a.slice(); const edits = HUGE ? rng.int(400, 3000) : SNAKE ? rng.int(300, 900) : rng.int(1, Math.max(2, n >> rng.int(1, 5)));
  for (let k = 0; k < edits; k++) { const at = rng.int(0, b.length); const kind = rng.int(0, 2); if (kind === 0) b.splice(at, rng.int(1, 4)); else if (kind === 1) b.splice(at, 0, ...Array.from({ length: rng.int(1, 4) }, () => (rng.int(0, 3) ? rng.pick(vocab) : `n${rng.int(0, 9)}\n`))); else b[at] = rng.pick(vocab); }
  const A = a.join(''), B = b.join('');
  writeFileSync(join(dir, 'a'), A); writeFileSync(join(dir, 'b'), B);
  // -U1, not -U0: with zero context xdi_diff runs trim_common_tail first (a merge never does), which moves where a pure
  // insertion inside a run of identical lines lands. Changed lines are rebuilt from the hunk bodies.
  const g = spawnSync(GIT_BIN, ['diff', '--no-index', '--no-color', '--histogram', '--no-indent-heuristic', '-U1', 'a', 'b'], { cwd: dir, maxBuffer: 1 << 26 }).stdout.toString();
  const gitCh = { a: [], b: [] }; let la = 0, lb = 0, inHunk = false;
  for (const line of g.split('\n')) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) { inHunk = true; la = h[2] === '0' ? +h[1] : +h[1] - 1; lb = h[4] === '0' ? +h[3] : +h[3] - 1; continue; } // 0-based next line
    if (!inHunk) continue;
    if (line[0] === '-') gitCh.a.push(la++); else if (line[0] === '+') gitCh.b.push(lb++); else if (line[0] === ' ') { la++; lb++; }
  }
  const cl = classifier(); const enc = s => new TextEncoder().encode(s);
  let ours;
  try {
    const sc = diffScript(records(enc(A), cl), records(enc(B), cl), { rediff: REDIFF }); const oa = [], ob = [];
    for (const x of [...sc].sort((p, q) => p.i1 - q.i1)) { for (let k = 0; k < x.chg1; k++) oa.push(x.i1 + k); for (let k = 0; k < x.chg2; k++) ob.push(x.i2 + k); }
    ours = { a: oa, b: ob };
  } catch (e) { if (e?.undecided) { counts.undecided++; continue; } throw e; }
  const gh = gitCh;
  const same = JSON.stringify(ours) === JSON.stringify(gh);
  counts[same ? 'same' : 'differ']++;
  if (!same && bad.length < 3) { bad.push(c); console.log(`case ${c}: n=${n} vocab=${vocab.length} edits=${edits}\n  git : ${JSON.stringify(gh).slice(0, 300)}\n  ours: ${JSON.stringify(ours).slice(0, 300)}`); }
}
rmSync(dir, { recursive: true, force: true });
console.log(`${N} diffs (seed ${SEED}, rediff ${REDIFF}): ${JSON.stringify(counts)}`);
if (counts.differ) process.exit(1);
