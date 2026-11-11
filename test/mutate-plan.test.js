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

// The large-repo stack (saved index, scan index, range resolve, subset, pack plan, transfer plan, pull codecs, deadline,
// host report classes) decodes stored and remote state. Until this test its mutants could only end NoCoverage or
// Survived without failing anything: none of its tests were in the mutation suite (vitest.stryker.config.ts) and none of
// its owners were judged strictly (review finding tests-gates/mutation-gate-blind-to-new-stack). The expectations are
// the owner's list, written out here by hand: [file, an owner that decodes or bounds untrusted input, its test file].
const STACK = [
  ['src/packsaved.ts', 'checkEntry', 'test/pack-saved.test.js'],
  ['src/packsaved.ts', 'decodeSavedIndex', 'test/pack-saved.test.js'],
  ['src/packscanindex.ts', 'scanPackIndex', 'test/scan-pack-index.test.js'],
  ['src/packrangeresolve.ts', 'readMember', 'test/pack-range-resolve.test.js'],
  ['src/packsubset.ts', 'headerOf', 'test/pack-subset.test.js'],
  ['src/packplan.ts', 'checkBudget', 'test/pack-plan.test.js'],
  ['src/transferplan.ts', 'checkTransferPlan', 'test/transfer.test.js'],
  ['src/pullstream.ts', 'scanPack', 'test/pullstream.test.js'],
  ['src/deadline.ts', 'exchangeClock', 'test/deadline.test.js'],
  ['src/push.ts', 'ngClass', 'test/push-unpack-host.test.js'],
  ['src/push.ts', 'unpackReasonMatches', 'test/push-unpack-host.test.js'],
];
const STACK_FILES = [...new Set(STACK.map(([file]) => file))];

// 1-based line of a top-level declaration, found in the file's own text (not by scripts/mutate.mjs)
function declaredAt(file, name) {
  const text = readFileSync(join(ROOT, file), 'utf8').split('\n');
  const at = text.findIndex(l => new RegExp(`^(?:export )?(?:async )?(?:function|const) ${name}\\b`).test(l));
  assert.ok(at >= 0, `${file}: no top-level ${name}`);
  return at + 1;
}

function stackCheckout() {
  const dir = mkdtempSync(join(tmpdir(), 'ply-mutate-stack-'));
  mkdirSync(join(dir, 'src'));
  copyFileSync(join(ROOT, 'stryker.conf.json'), join(dir, 'stryker.conf.json'));
  for (const file of STACK_FILES) copyFileSync(join(ROOT, file), join(dir, file));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

test('the mutation suite runs the large-repo stack\'s tests', () => {
  const suite = readFileSync(join(ROOT, 'vitest.stryker.config.ts'), 'utf8');
  const missing = [...new Set(STACK.map(([, , t]) => t))].filter(t => !suite.includes(`'${t}'`));
  assert.deepEqual(missing, []);
});

test('a pull request that changes nothing still mutates the large-repo stack\'s decoders', () => {
  const dir = stackCheckout();
  try {
    const env = { ...process.env, GITHUB_EVENT_NAME: 'pull_request', MUTATE_BASE: 'HEAD' };
    delete env.MUTATE_FULL;
    // one shard: no unit is cut, so a gated owner is one range from its declaration line
    const r = spawnSync(process.execPath, [SCRIPT, '--plan', '1'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.full, false);
    const ungated = STACK.filter(([file, name]) => {
      const at = declaredAt(file, name);
      return !unitRanges(plan, file).some(([a, b]) => a <= at && b >= at);
    }).map(([file, name]) => `${file} ${name}`);
    assert.deepEqual(ungated, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test('a surviving or uncovered mutant in a large-repo stack decoder fails the verdict; a killed one passes', () => {
  const dir = stackCheckout();
  try {
    mkdirSync(join(dir, 'reports/mutation'), { recursive: true });
    // a pull request's verdict: the parser/bounds rule alone, without the full-library break threshold
    const env = { ...process.env, GITHUB_EVENT_NAME: 'pull_request' };
    delete env.MUTATE_FULL;
    const judge = (file, line, status) => {
      const mutant = { id: '1', mutatorName: 'EqualityOperator', replacement: 'x', status, location: { start: { line, column: 1 }, end: { line, column: 2 } } };
      writeFileSync(join(dir, 'reports/mutation/mutation.json'), JSON.stringify({ files: { [file]: { mutants: [mutant] } } }));
      return spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: dir, env, encoding: 'utf8' });
    };
    const wrong = [];
    for (const [file, name] of STACK) {
      const at = declaredAt(file, name);
      for (const [status, want] of [['Survived', 1], ['NoCoverage', 1], ['Killed', 0], ['Timeout', 0]]) {
        const r = judge(file, at, status);
        if (r.status !== want) wrong.push(`${file}:${at} ${name} ${status}: exit ${r.status}, want ${want}`);
        else if (want === 1 && !r.stderr.includes(`${file}:${at} ${name} EqualityOperator ${status}`)) wrong.push(`${file}:${at} ${name} ${status}: not named in ${r.stderr}`);
      }
    }
    assert.deepEqual(wrong, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
