// The line merge against git itself. Each case is three versions of one file (base, ours, theirs) built as commits with
// plumbing in one bare repo; git's answer is `git merge-tree --write-tree` (merge-ort: histogram diff, zealous level).
// Verdicts per case:
//   agree-clean     both clean, identical bytes
//   agree-conflict  both conflict
//   conservative    git clean, we conflict (allowed: superset of git's conflicts) — split by our reason
//   WRONG           we clean and git conflicts, or both clean with different bytes — must be zero
//   node test/fuzz/linemerge.mjs [--n 2000] [--seed 1] [--big|--runs] [--rediff skip]
//   --rediff skip: model git without the compaction re-diff (2.43, the oracle here) — then conservative must be 0 too
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rng } from './prng.js';
import { mergeLines } from '../../src/linemerge.js';

import { oracleRediff } from '../gitversion.js';
const REDIFF = process.argv.includes('--rediff') ? process.argv[process.argv.indexOf('--rediff') + 1] : oracleRediff(); // default: whatever the oracle git does
const GIT_BIN = process.env.GIT_BIN ?? 'git'; // GIT_BIN=/path/to/git: judge against another git build
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : +process.argv[i + 1]; };
const N = arg('n', 2000), SEED = arg('seed', 1), ONLY = arg('case', -1);
// --driver union|binary: the file carries `merge=<driver>` in a .gitattributes git reads via attr.tree=<ours>
const DRIVER = process.argv.includes('--driver') ? process.argv[process.argv.indexOf('--driver') + 1] : 'text';
const dir = mkdtempSync(join(tmpdir(), 'lm-'));
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'w', GIT_AUTHOR_EMAIL: 'w@x', GIT_COMMITTER_NAME: 'w', GIT_COMMITTER_EMAIL: 'w@x', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000' };
const git = (args, input) => { const r = spawnSync(GIT_BIN, ['-C', dir, ...args], { input, env: ENV, maxBuffer: 1 << 26 }); return { status: r.status, out: r.stdout, err: r.stderr.toString() }; };
git(['init', '-q', '--bare']);
const commit = (bytes, parent) => {
  const blob = git(['hash-object', '-w', '--stdin'], bytes).out.toString().trim();
  const attrs = DRIVER === 'text' ? '' : `100644 blob ${git(['hash-object', '-w', '--stdin'], `f.txt merge=${DRIVER}\n`).out.toString().trim()}\t.gitattributes\n`;
  const tree = git(['mktree'], `${attrs}100644 blob ${blob}\tf.txt\n`).out.toString().trim();
  return git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'c']).out.toString().trim();
};

// Line vocabularies chosen to stress alignment: many repeated lines (braces, blanks), a few unique ones, CRLF, no final newline.
const VOCAB = ['{\n', '}\n', '\n', '\n', '  return x;\n', 'a\n', 'b\n', 'c\n', '// x\n', 'end\n'];
const BIG = process.argv.includes('--big'), RUNS = process.argv.includes('--runs'); // --runs: long runs of a few lines → histogram's Myers fallback // long files with >64 copies of a line: histogram's own Myers fallback (max_chain_length)
function genRuns(rng) {
  const lines = []; const k = rng.int(1, 6);
  for (let r = 0; r < k; r++) { const l = rng.pick(['x\n', 'y\n', '\n', '}\n', `u${rng.int(0, 5)}\n`]); for (let j = rng.int(1, 120); j > 0; j--) lines.push(l); }
  return lines;
}
function genFile(rng) {
  if (RUNS) return genRuns(rng);
  const n = BIG ? rng.int(100, 400) : rng.int(0, 40), lines = [];
  for (let i = 0; i < n; i++) {
    const k = rng.int(0, 9);
    if (BIG && (k < 9 || rng.int(0, 3))) { lines.push(rng.pick(['{\n', '}\n', '\n'])); continue; } // a low-variety file: every line repeats >64 times
    lines.push(k < 5 ? rng.pick(VOCAB) : k < 8 ? `line ${rng.int(0, 60)}\n` : k < 9 ? `crlf ${rng.int(0, 9)}\r\n` : `u${rng.int(0, 1e6)}\n`);
  }
  if (lines.length && rng.int(0, 5) === 0) lines[lines.length - 1] = lines[lines.length - 1].replace(/\r?\n$/, '');
  return lines;
}
function edit(rng, base, other) {
  const out = base.slice(); const ops = rng.int(1, 4);
  for (let k = 0; k < ops; k++) {
    const at = rng.int(0, out.length), len = rng.int(0, 3), kind = rng.int(0, 5);
    const fresh = () => (rng.int(0, 2) === 0 ? rng.pick(VOCAB) : `new ${rng.int(0, 40)}\n`);
    if (kind === 0) out.splice(at, len);                                                      // delete
    else if (kind === 1) out.splice(at, 0, ...Array.from({ length: rng.int(1, 3) }, fresh));  // insert
    else if (kind === 2) out.splice(at, len, ...Array.from({ length: rng.int(1, 3) }, fresh)); // replace
    else if (kind === 3 && other) { const s = rng.int(0, other.length); out.splice(at, len, ...other.slice(s, s + rng.int(1, 3))); } // borrow lines
    else if (kind === 4 && out.length) { const s = rng.int(0, out.length - 1); out.splice(at, 0, out[s]); } // duplicate a line
  }
  return out;
}
const bytes = lines => new TextEncoder().encode(lines.join(''));
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const counts = { 'agree-clean': 0, 'agree-conflict': 0, conservative: 0, WRONG: 0 }; const why = {}; const wrong = [];
const rng0 = new Rng(SEED);
for (let i = 0; i < N; i++) {
  const seed = rng0.u32(); if (ONLY >= 0 && i !== ONLY) continue;
  const rng = new Rng(seed);
  const baseL = genFile(rng); const oursL = edit(rng, baseL); const sameAsOurs = rng.int(0, 9) === 0;
  const theirsL = sameAsOurs ? oursL.slice() : edit(rng, baseL, oursL);
  const B = bytes(baseL), O = bytes(oursL), T = bytes(theirsL);
  if (eq(B, O) || eq(B, T) || eq(O, T)) continue; // trivial: git never runs a content merge
  const cb = commit(B), co = commit(O, cb), ct = commit(T, cb);
  const g = git(['-c', `attr.tree=${co}`, 'merge-tree', '--write-tree', '--name-only', co, ct]);
  const gitClean = g.status === 0;
  const gitBytes = gitClean ? git(['cat-file', 'blob', `${g.out.toString().split('\n')[0]}:f.txt`]).out : null;
  const m = mergeLines(B, O, T, { rediff: REDIFF, driver: DRIVER });
  let v;
  if (m.clean && gitClean) v = eq(m.data, new Uint8Array(gitBytes)) ? 'agree-clean' : 'WRONG';
  else if (!m.clean && !gitClean) v = 'agree-conflict';
  else if (!m.clean && gitClean) { v = 'conservative'; const k = m.detail ? `${m.reason}: ${m.detail}` : m.reason; why[k] = (why[k] ?? 0) + 1; }
  else v = 'WRONG';
  counts[v]++;
  if (v === 'WRONG') { wrong.push(i); if (wrong.length <= 3) console.log(`WRONG case ${i}: ours ${m.clean ? 'clean' : m.reason}, git ${gitClean ? 'clean' : 'conflict'}\n  base=${JSON.stringify(baseL.join(''))}\n  ours=${JSON.stringify(oursL.join(''))}\n  theirs=${JSON.stringify(theirsL.join(''))}\n  gitout=${gitBytes ? JSON.stringify(gitBytes.toString()) : '-'}\n  ourout=${m.clean ? JSON.stringify(new TextDecoder().decode(m.data)) : '-'}`); }
}
rmSync(dir, { recursive: true, force: true });
const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`${total} non-trivial cases (seed ${SEED}, rediff ${REDIFF}, driver ${DRIVER}): ${JSON.stringify(counts)}  conservative by reason: ${JSON.stringify(why)}`);
if (wrong.length) { console.log(`WRONG cases: ${wrong.slice(0, 20).join(',')} — repro: --seed ${SEED} --case <i>`); process.exit(1); }
