// The large differential campaign of the tree-entry name checks (#207): src/validate.ts against the version before it
// (test/oracle/dotnames-ref.ts), on isDotGitName, isDotFileName × 4 and checkoutPathRefusal's isHfsDot(.gitmodules).
//   node --import ./test/ts-resolve.mjs test/fuzz/dotnames.mjs [--n 10000000] [--seed 207] [--stage all|exhaustive|targeted|random]
// Stages: every byte string up to 3 bytes (16.8 M); every string up to 4 bytes over 38 bytes (FOUR); every spelling × head ×
// tail with its truncations, substitutions by the alphabet, deletions, doublings and ignorables inserted; random names
// from spelling fragments. Prints each stage's count, how many names spell something (so a green run is known not to be
// vacuous), and the first disagreement as hex bytes.
// Stage `git` is the one whose oracle is not ply: every --git-stride-th targeted name and the first --git-n random
// names of the seed, each a one-entry symlink tree judged by `git fsck --strict` (test/fuzz/git-names.mjs), against
// src/validate.ts. The other stages compare src with the pre-#207 ply and prove only that the rewrite changed nothing.
//   node --import ./test/ts-resolve.mjs test/fuzz/dotnames.mjs --stage git [--git-n 20000] [--git-stride 997] [--seed 207]
import { ALPHABET, ALL_BYTES, exhaustive, targeted, rng, randomName, judge, hfsGitmodules, verdicts } from '../dotnames-corpus.js';
import { gitNameVerdicts, MSG_IDS } from './git-names.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? true] : [])).filter(x => x.length));
const N = Number(args.n ?? 10_000_000), SEED = Number(args.seed ?? 207), STAGE = args.stage ?? 'all';
const GIT_N = Number(args['git-n'] ?? 20_000), GIT_STRIDE = Number(args['git-stride'] ?? 997);
console.log(`dotnames: seed=${SEED} n=${N} stage=${STAGE} git-n=${GIT_N} git-stride=${GIT_STRIDE}`);
let failed = false;
const stage = (name, names) => {
  if (STAGE !== 'all' && !name.startsWith(STAGE)) return;
  const t0 = Date.now();
  const stats = { n: 0, hits: 0 };
  const bad = judge(names, stats);
  console.log(`${name.padEnd(26)} ${String(stats.n).padStart(11)} names  ${String(stats.hits).padStart(9)} spell something  ${((Date.now() - t0) / 1000).toFixed(1)} s${bad ? `  DISAGREE ${JSON.stringify(bad)}` : ''}`);
  if (bad) failed = true;
};
stage('exhaustive all bytes ≤ 3', exhaustive(ALL_BYTES, 3));
// 4 bytes reach `.git`, `~1`+tail and an ignorable + `.`: the separators, `~`, digits at the range edges, the letters of
// git and of the short names, and the UTF-8 bytes of the ignorables and their neighbours
const FOUR = Uint8Array.from([0x00, 0x20, 0x2e, 0x2f, 0x3a, 0x5c, 0x7e, 0x30, 0x31, 0x34, 0x35, 0x39, 0x67, 0x69, 0x74, 0x47, 0x49, 0x54, 0x6d, 0x4d, 0x37, 0x65, 0x62, 0x61, 0x78, 0x80, 0x81, 0x8c, 0x8f, 0xae, 0xbb, 0xbf, 0xc2, 0xe2, 0xed, 0xef, 0xf0, 0xff]);
stage(`exhaustive alphabet(${FOUR.length}) ≤ 4`, exhaustive(FOUR, 4));
stage('targeted', targeted());
const r = rng(SEED);
stage(`random seed ${SEED}`, (function* () { for (let i = 0; i < N; i++) yield randomName(r); })());
if (STAGE === 'all' || STAGE === 'hfs') {
  let asked = 0, hits = 0, bad = null;
  for (const b of targeted(undefined, undefined, ALPHABET.subarray(0, 24))) {
    const v = hfsGitmodules(b);
    if (v === null) continue;
    asked++; if (v.want) hits++;
    if (v.got !== v.want) { bad = [...b].map(x => x.toString(16)).join(' '); break; }
  }
  console.log(`hfs .gitmodules (checkout) ${String(asked).padStart(11)} names  ${String(hits).padStart(9)} spell something${bad ? `  DISAGREE ${bad}` : ''}`);
  if (bad) failed = true;
}
if (STAGE === 'all' || STAGE === 'git') {
  const t0 = Date.now();
  const names = [];
  let k = 0;
  // 997 is prime, so the sample is not the same position of every base's run of variants
  for (const b of targeted()) if (k++ % GIT_STRIDE === 0) names.push(b);
  const rg = rng(SEED);
  for (let i = 0; i < GIT_N; i++) names.push(randomName(rg));
  const git = gitNameVerdicts(names);
  let judged = 0, hits = 0, bad = null;
  for (let i = 0; i < names.length; i++) {
    const want = git[i];
    if (want === null) continue;
    judged++; if (want !== '00000') hits++;
    const got = verdicts(names[i], 'src');
    if (got !== want && !bad) bad = { bytes: [...names[i]].map(x => x.toString(16).padStart(2, '0')).join(' '), git: want, ply: got, order: MSG_IDS.join(',') };
  }
  console.log(`${'git fsck --strict'.padEnd(26)} ${String(judged).padStart(11)} names  ${String(hits).padStart(9)} spell something  ${((Date.now() - t0) / 1000).toFixed(1)} s${bad ? `  DISAGREE ${JSON.stringify(bad)}` : ''}`);
  // a green run with nothing judged, or nothing git objects to, proves nothing
  if (judged === 0 || hits === 0) { console.log('git stage is vacuous: no name judged, or none that git flags'); failed = true; }
  if (bad) failed = true;
}
if (failed) {
  console.log(`FAIL dotnames seed=${SEED}  replay: node --import ./test/ts-resolve.mjs test/fuzz/dotnames.mjs --seed ${SEED} --n ${N} --stage ${STAGE} --git-n ${GIT_N} --git-stride ${GIT_STRIDE}`);
  process.exit(1);
}
