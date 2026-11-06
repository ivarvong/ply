// The large differential run of parseTree (#207): src/objects.ts against the parser before it (test/oracle/parsetree-ref.ts)
// on random trees (test/parsetree-corpus.js). Prints how many were accepted and each refusal's count, so a green run
// is known not to be vacuous, and the first disagreement as hex.
//   node --import ./test/ts-resolve.mjs test/fuzz/parsetree.mjs [--n 1000000] [--seed 207]
import { rng } from '../dotnames-corpus.js';
import { randomTree, judgeTrees } from '../parsetree-corpus.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? true] : [])).filter(x => x.length));
const N = Number(args.n ?? 1_000_000), SEED = Number(args.seed ?? 207);
const r = rng(SEED);
const t0 = Date.now();
const stats = { n: 0, accepted: 0, refused: {} };
const bad = judgeTrees((function* () { for (let i = 0; i < N; i++) yield randomTree(r); })(), stats);
console.log(`parseTree seed ${SEED}: ${stats.n} trees, ${stats.accepted} accepted, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
for (const [why, n] of Object.entries(stats.refused).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(8)}  ${why}`);
if (bad) { console.log(`DISAGREE ${JSON.stringify(bad)}`); process.exit(1); }
