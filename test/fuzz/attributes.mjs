// .gitattributes against git itself: random trees with random .gitattributes files at the root and in subdirectories,
// every path's full attribute set from attributes.js compared with `git check-attr --source=<commit> -a -z`.
//   node test/fuzz/attributes.mjs [--n 200] [--seed 1] [--case <i>]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rng } from './prng.js';
import { attributesFor, bytesToStr } from '../../src/attributes.js';
import { gitVersion } from '../gitversion.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : +process.argv[i + 1]; };
const N = arg('n', 200), SEED = arg('seed', 1), ONLY = arg('case', -1);
const GIT_BIN = process.env.GIT_BIN ?? 'git';
const [MAJ, MIN] = gitVersion(GIT_BIN); const reserveBuiltin = MAJ > 2 || MIN >= 44; // git 2.44 reserved builtin_*
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'w', GIT_AUTHOR_EMAIL: 'w@x', GIT_COMMITTER_NAME: 'w', GIT_COMMITTER_EMAIL: 'w@x', GIT_CONFIG_NOSYSTEM: '1', HOME: tmpdir() };

const NAMES = ['ab', 'bb', 'x.txt', 'y.txt', 'z.bin', 'Makefile', 'lock.json', 'pkg.lock', 'read me.md', 'a.b.c', '[x]', 'q*', 'é.txt', '-dash', '!bang', '#hash', 'tab\there'];
const DIRS = ['', 'a', 'a/b', 'docs', 'docs/a', 'src/x', 'a b'];
const ATTRS = ['merge', 'merge', 'merge', 'diff', 'text', 'binary', 'lock', 'custom', 'eol', 'x-y.z'];
// not classes: git's wildmatch aborts the pattern; Object.prototype members must not read as classes (#16)
const BOGUS_CLASSES = ['bogus', 'constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf'];
function genPattern(rng) {
  const lit = () => rng.pick(['a', 'b', 'x', 'txt', 'bin', 'lock', 'json', 'docs', 'src', 'é', 'read me', 'q']);
  const parts = [];
  const n = rng.int(1, 3);
  for (let i = 0; i < n; i++) {
    const k = rng.int(0, 13);
    parts.push(k < 3 ? lit() : k < 5 ? '*' : k === 5 ? '?' : k === 6 ? '**' : k === 7 ? '[a-c]' : k === 8 ? '[!x]' : k === 9 ? '[[:alpha:]]' : k === 10 ? '\\*' : k === 11 ? '.' : k === 12 ? '[^a]' : `[[:${rng.pick(BOGUS_CLASSES)}:]]`);
    if (i < n - 1) parts.push(rng.int(0, 2) ? '' : '/');
  }
  let p = parts.join('');
  const deco = rng.int(0, 9);
  if (deco === 0) p = '/' + p; else if (deco === 1) p = p + '/'; else if (deco === 2) p = '**/' + p; else if (deco === 3) p = '!' + p;
  return p;
}
function genState(rng) {
  const a = rng.pick(ATTRS); const k = rng.int(0, 5);
  return k === 0 ? `-${a}` : k === 1 ? `!${a}` : k === 2 ? `${a}=${rng.pick(['union', 'binary', 'text', 'foo', 'lf'])}` : k === 3 && !rng.int(0, 6) ? rng.pick(['Bad^name', 'builtin_x', '-']) : a;
}
function genFile(rng, isRoot) {
  const lines = []; const n = rng.int(1, 8);
  for (let i = 0; i < n; i++) {
    const k = rng.int(0, 13);
    const states = Array.from({ length: rng.int(0, 3) }, () => genState(rng)).join(rng.pick([' ', '\t', '  ']));
    if (k === 0) lines.push('# comment');
    else if (k === 1) lines.push('');
    else if (k === 2) lines.push(`[attr]${rng.pick(['lock', 'custom', 'binary', 'gen'])} ${states}`); // honoured only in the root file
    else if (k === 3) lines.push(`"${genPattern(rng).replace(/\\/g, '\\\\').replace(/ /g, '\\040')}${rng.pick(['', '\\t', '\\101', '\\08', '\\q', '\\"x'])}${rng.int(0, 8) ? '"' : ''} ${states}`); // escapes, octal, bad escapes, unterminated
    else if (k === 4 && !rng.int(0, 4)) lines.push(`${'x'.repeat(2050)} merge`);
    else lines.push(`${rng.pick(['', ' ', '\t'])}${genPattern(rng)} ${states}`);
  }
  return lines.join(rng.int(0, 5) ? '\n' : '\r\n') + (rng.int(0, 3) ? '\n' : '');
}

const root = mkdtempSync(join(tmpdir(), 'attr-')); let paths = 0, bad = 0; const seen = { withAttrs: 0, mergeSet: 0, mergeUnset: 0, mergeValue: 0, fromMacro: 0 };
const rng0 = new Rng(SEED);
for (let c = 0; c < N; c++) {
  const seed = rng0.u32(); if (ONLY >= 0 && c !== ONLY) continue;
  const rng = new Rng(seed); const w = join(root, `w${c}`); mkdirSync(w);
  const git = (args, cwd = w) => spawnSync(GIT_BIN, ['-C', cwd, ...args], { env: ENV, maxBuffer: 1 << 26 });
  git(['init', '-q']);
  const files = new Map(); const all = [];
  for (const d of DIRS) {
    if (d && !rng.int(0, 2)) continue;
    mkdirSync(join(w, d), { recursive: true });
    for (const nm of NAMES) if (rng.int(0, 2)) { const p = d ? `${d}/${nm}` : nm; writeFileSync(join(w, p), 'x\n'); all.push(p); }
    if (!d || rng.int(0, 2)) { const t = genFile(rng, !d); writeFileSync(join(w, d, '.gitattributes'), t); files.set(bytesToStr(new TextEncoder().encode(d)), bytesToStr(new TextEncoder().encode(t))); }
  }
  git(['add', '-A']); git(['commit', '-qm', 'c']);
  // git's answer for every path at once: -z output is path NUL attr NUL value NUL ...
  const res = spawnSync(GIT_BIN, ['-C', w, 'check-attr', '--source=HEAD', '-a', '-z', '--stdin'], { env: ENV, input: all.join('\0') + '\0', maxBuffer: 1 << 26 });
  if (res.status !== 0) { console.log(`case ${c}: check-attr failed: ${res.stderr}`); process.exit(1); }
  const fields = bytesToStr(res.stdout).split('\0'); const gitAttrs = new Map(all.map(p => [bytesToStr(new TextEncoder().encode(p)), new Map()]));
  for (let i = 0; i + 2 < fields.length; i += 3) gitAttrs.get(fields[i])?.set(fields[i + 1], fields[i + 2]);
  for (const [p, g] of gitAttrs) {
    const ours = new Map([...attributesFor(p, files, { reserveBuiltin })].filter(([, v]) => v !== null).map(([k, v]) => [k, v === true ? 'set' : v === false ? 'unset' : v]));
    const same = ours.size === g.size && [...ours].every(([k, v]) => g.get(k) === v);
    paths++;
    if (g.size) seen.withAttrs++; const mg = g.get('merge'); if (mg === 'set') seen.mergeSet++; else if (mg === 'unset') seen.mergeUnset++; else if (mg) seen.mergeValue++; if (g.get('binary') === 'set' || g.get('lock') === 'set' || g.get('gen') === 'set') seen.fromMacro++;
    if (!same) { bad++; if (bad <= 5) console.log(`case ${c} (seed ${seed}) path ${JSON.stringify(p)}:\n  git : ${JSON.stringify([...g])}\n  ours: ${JSON.stringify([...ours])}\n  files: ${JSON.stringify([...files])}`); }
  }
  rmSync(w, { recursive: true, force: true });
}
rmSync(root, { recursive: true, force: true });
console.log(`${N} trees, ${paths} paths (seed ${SEED}): ${paths - bad} equal to git check-attr, ${bad} different; exercised ${JSON.stringify(seen)}`);
if (bad) process.exit(1);
