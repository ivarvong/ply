// scripts/mutate.mjs on a pull request mutates every line the gate judges strictly, not only the lines the PR changed.
// #198 moved parseHttpOptions and parseLsRefLine without changing their text: no line of theirs was in the diff, the PR's
// mutation run never reached them, and main's full run found five survivors there (run 41976594897). Here a PR that
// only moves a helper past a parser leaves the parser's lines out of the diff; the plan still holds all of them, and
// still leaves out an ungated function the PR did not change.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/mutate.mjs');

// parseFrame is gated (PARSER); helper and other are not. 40 statements, so git's diff moves the 3-line helper, not
// the parser.
const parser = [
  'export function parseFrame(b: Uint8Array): number {',
  '  let n = 0;',
  ...Array.from({ length: 40 }, (_, i) => `  if (b[${i}] === ${i + 1}) n += ${i + 2};`),
  '  return n;',
  '}',
];
const helper = ['export function helper(x: number): number {', '  return x > 1 ? x * 2 : x - 3;', '}'];
const other = ['export function other(x: number): number {', '  return x < 4 ? x + 5 : x * 6;', '}'];
const lines = parts => parts.flat().join('\n') + '\n';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function prPlan(cwd, base) {
  const env = { ...process.env, GITHUB_EVENT_NAME: 'pull_request', MUTATE_BASE: base };
  delete env.MUTATE_FULL;
  const r = spawnSync(process.execPath, [SCRIPT, '--plan', '4'], { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// [from, to] ranges of a file's units in a plan
const unitRanges = (plan, file) => plan.shards.flatMap(s => s.files)
  .filter(u => u === file || u.startsWith(`${file}:`))
  .map(u => (u === file ? [1, Infinity] : u.slice(file.length + 1).split('-').map(Number)));
const covers = (ranges, from, to) => ranges.some(([a, b]) => a <= from && b >= to);

test('a pull request that only moves code past a parser still mutates every line of the parser', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ply-mutate-plan-'));
  try {
    mkdirSync(join(dir, 'src'));
    copyFileSync(join(ROOT, 'stryker.conf.json'), join(dir, 'stryker.conf.json'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 't');
    writeFileSync(join(dir, 'src/a.ts'), lines([helper, parser, other]));
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    const base = git(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(dir, 'src/a.ts'), lines([parser, helper, other]));
    git(dir, 'commit', '-q', '-am', 'move helper below the parser');

    // the parser's lines on the PR side: 1..parser.length. The changed lines (a pure deletion borders the lines on
    // either side of it, as in changedRanges) do not cover them: changed lines alone would not mutate the parser.
    const from = 1, to = parser.length;
    const hunks = git(dir, 'diff', '-U0', `${base}...HEAD`).split('\n').filter(l => l.startsWith('@@'));
    const changed = hunks.map(h => /\+(\d+)(?:,(\d+))?/.exec(h)).map(m => {
      const at = Number(m[1]), len = Number(m[2] ?? 1);
      return len === 0 ? [Math.max(1, at), at + 1] : [at, at + len - 1];
    });
    assert.ok(!covers(changed, from, to), `the diff changes the parser: ${hunks.join(' ')}`);
    assert.ok(changed.every(([a, b]) => b <= from || a > to), `the diff changes the parser: ${hunks.join(' ')}`);

    const plan = prPlan(dir, base);
    assert.equal(plan.full, false);
    const ranges = unitRanges(plan, 'src/a.ts');
    assert.ok(covers(ranges, from, to), `parseFrame ${from}-${to} not in the plan: ${JSON.stringify(ranges)}`);
    // the moved helper is there too (changed lines), the untouched ungated function is not
    const helperAt = parser.length + 1;
    assert.ok(covers(ranges, helperAt, helperAt + helper.length - 1), JSON.stringify(ranges));
    const otherAt = parser.length + helper.length + 1;
    assert.ok(!ranges.some(([a, b]) => a <= otherAt + 1 && b >= otherAt + 1), `other() is in the plan: ${JSON.stringify(ranges)}`);
    // each planned mutant once: the parser's 40 conditions alone are well over 40
    assert.ok(plan.mutants > 40, String(plan.mutants));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

// #313: a shard of 43232620788 planned at 9,322 s ran 19,065 s (84 of 90 minutes), because its weights were measured on
// a runner whose dry run took 28 s and it ran on one taking 50 s. --weights scales every duration to the reference
// runner by the dry-run time of the runner that measured it, and refuses a report that does not say.
const mutant = (line, ms) => ({ id: String(line), mutatorName: 'BooleanLiteral', replacement: 'true', status: 'Killed', duration: ms, location: { start: { line, column: 3 }, end: { line, column: 9 } } });
const shardReport = (dryRunNetMs, mutants) => JSON.stringify({ shard: { i: 1, n: 1, files: ['src/a.ts'], dryRunNetMs }, files: { 'src/a.ts': { mutants } } });

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ply-mutate-weights-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  copyFileSync(join(ROOT, 'stryker.conf.json'), join(dir, 'stryker.conf.json'));
  writeFileSync(join(dir, 'src/a.ts'), lines([other]));
  return dir;
}
const run = (cwd, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: { ...process.env, GITHUB_EVENT_NAME: 'push' }, encoding: 'utf8' });

test('--weights stores seconds on the reference runner, scaled by each report\'s runner, and refuses an unscaled report', () => {
  const dir = scratch();
  try {
    // 10 s on a 25 s runner is 20 s on the 50 s reference; 10 s on a 100 s runner is 5 s
    writeFileSync(join(dir, 'fast.json'), shardReport(25_000, [mutant(2, 10_000)]));
    writeFileSync(join(dir, 'slow.json'), shardReport(100_000, [mutant(1, 10_000)]));
    const ok = run(dir, '--weights', 'fast.json', 'slow.json');
    assert.equal(ok.status, 0, ok.stderr);
    const w = JSON.parse(readFileSync(join(dir, 'scripts/mutate-weights.json'), 'utf8'))['src/a.ts'];
    assert.deepEqual(w, { seconds: 25, mutants: 2, byLine: { 2: 20, 1: 5 } });

    writeFileSync(join(dir, 'old.json'), shardReport(undefined, [mutant(2, 10_000)]));
    const refused = run(dir, '--weights', 'old.json');
    assert.equal(refused.status, 2, refused.stdout);
    assert.match(refused.stderr, /without their runner's dry-run time/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test('--budget fails when the heaviest planned shard, on a runner twice as slow as the reference, passes 2/3 of mutate.yml\'s timeout-minutes', () => {
  const dir = scratch();
  try {
    const yml = limit => `jobs:\n  mutate-shard:\n    timeout-minutes: ${limit}\n    strategy:\n      matrix:\n        shard: [1, 2]\n  mutate:\n    timeout-minutes: 5\n`;
    // src/a.ts at 3,000 s (all on line 2) on the reference runner is 2.15 + 3000 / 3.76 / 60 = 15.45 min in one shard
    // (a unit is cut only at a line no mutant spans past, and the function's block mutant spans lines 1-3), 30.9 min on
    // a 2x runner (RUNNER_WORST)
    writeFileSync(join(dir, 'scripts/mutate-weights.json'), JSON.stringify({ 'src/a.ts': { seconds: 3000, mutants: 6, byLine: { 1: 0, 2: 3000, 3: 0 } } }));
    writeFileSync(join(dir, '.github/workflows/mutate.yml'), yml(47)); // cap 2/3 of 47 = 31.3 min
    const fits = run(dir, '--budget');
    assert.equal(fits.status, 0, fits.stderr);
    assert.match(fits.stdout, /in 2 shards; .* max 15\.4, .* on a 2x runner max 30\.9; cap 31\.3 \(67% of timeout-minutes 47\)/);
    writeFileSync(join(dir, '.github/workflows/mutate.yml'), yml(46)); // cap 30.7 min
    const over = run(dir, '--budget');
    assert.equal(over.status, 1, over.stdout);
    assert.match(over.stderr, /plans 15\.4 min, 30\.9 on a 2x runner, over 30\.7: src\/a\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
