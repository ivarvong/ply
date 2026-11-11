// `npm run test:fuzz-pinned` is the last stage of `npm test`. A gate has to run the same cases every time, so every
// fuzzer command in it must name its seed (or its case) on the command line, and a failure must say how to replay it.
// The expectation here does not come from the runner. The owner's rule is that the gate is seeded by constants and
// runs exactly what package.json says, so the npm scripts are held to literal strings (GATE, RANDOM below): a flag or
// a shell operator added to the gate script changes what the gate runs and fails here. With the script known to be
// the bare runner, the runner's bare `--list` is the command list the gate runs, and it is judged against the rule
// "an explicit --seed <n> or --case <n> on every test/fuzz/*.mjs command", with the fuzzers' own sources saying
// which default to the clock.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNNER = 'test/fuzz/pinned.mjs';
const GATE = 'node test/fuzz/pinned.mjs'; // no flags: the list and its seeds are constants in the runner
const RANDOM = 'node test/fuzz/pinned.mjs --random'; // discovery by a fresh seed: nightly only
const scripts = JSON.parse(readFileSync(ROOT + 'package.json', 'utf8')).scripts;

// What is wrong with a package.json `scripts` object as the pinned gate. Empty: nothing.
function gateProblems(s) {
  const out = [];
  if (s['test:fuzz-pinned'] !== GATE) out.push(`test:fuzz-pinned must be exactly \`${GATE}\`, is \`${s['test:fuzz-pinned']}\``);
  if (s['test:fuzz-random'] !== RANDOM) out.push(`test:fuzz-random must be exactly \`${RANDOM}\`, is \`${s['test:fuzz-random']}\``);
  if (!String(s.test).endsWith(' && npm run test:fuzz-pinned')) out.push('`npm test` must end with `&& npm run test:fuzz-pinned`');
  return out;
}

function runner(args, path = RUNNER) {
  return spawnSync(process.execPath, [path, ...args], { cwd: ROOT, encoding: 'utf8' });
}
function list(extra = []) {
  const r = runner(['--list', ...extra]);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean);
}
// The commands the gate runs: the script is the bare runner (first test), so this is the runner's bare list.
const pinnedCommands = () => list().filter(l => l.includes('test/fuzz/'));

test('the gate script is the bare runner: no flag and no shell operator can change what it runs', () => {
  assert.deepEqual(gateProblems(scripts), []);
  // The guard has to reject a weakened gate. The first five left the previous guard green (review of b706d77).
  const weakened = [
    'node test/fuzz/pinned.mjs --random', 'node test/fuzz/pinned.mjs --list', 'node test/fuzz/pinned.mjs --only codec',
    'node test/fuzz/pinned.mjs || true', 'node test/fuzz/pinned.mjs --seed $RANDOM', 'node test/fuzz/pinned.mjs --timeout-s 1',
    'true', '',
  ];
  for (const w of weakened) assert.equal(gateProblems({ ...scripts, 'test:fuzz-pinned': w }).length, 1, `accepted: ${w}`);
  assert.equal(gateProblems({ ...scripts, test: scripts.test + ' || true' }).length, 1);
  assert.equal(gateProblems({ ...scripts, test: scripts.test.replace(' && npm run test:fuzz-pinned', '') }).length, 1);
  assert.equal(gateProblems({ ...scripts, 'test:fuzz-random': GATE }).length, 1);
});

test('the runner refuses what it does not understand instead of running the list', () => {
  // `--randm` used to be ignored (the pinned list ran); a seed past 2^53 used to be rounded.
  const bad = [['--list', '--randm'], ['--list', 'extra'], ['--list', '--seed', '99999999999999999999'], ['--list', '--seed'],
    ['--list', '--seed', '-1'], ['--list', '--only'], ['--only', 'nosuchfuzzer'], ['--list', '--timeout-s', '0'], ['--list', '--timeout-s', 'x']];
  for (const args of bad) {
    const r = runner(args);
    assert.equal(r.status, 2, `${args.join(' ')}: exit ${r.status}\n${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, '', `${args.join(' ')} listed something`);
    assert.notEqual(r.stderr, '');
  }
});

test('the runner runs when it is reached through a symlink (it used to print nothing and exit 0)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ply-pinned-link-'));
  try {
    symlinkSync(ROOT.replace(/\/$/, ''), join(tmp, 'linkrepo'));
    const linked = join(tmp, 'linkrepo', RUNNER);
    const bogus = runner(['--only', 'nosuchfuzzer'], linked);
    assert.equal(bogus.status, 2, `exit ${bogus.status}: ${bogus.stdout}${bogus.stderr}`);
    assert.match(bogus.stderr, /no such fuzzer/);
    const listed = runner(['--list'], linked);
    assert.equal(listed.status, 0);
    assert.deepEqual(listed.stdout.split('\n').filter(Boolean), list());
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('every entry prints its fuzzer and its seed before it starts', async () => {
  const { runPinned, PINNED } = await import('./fuzz/pinned.mjs');
  const events = [];
  runPinned(PINNED, { spawn: argv => { events.push({ run: argv.join(' ') }); return 0; }, log: l => events.push({ log: l }) });
  assert.equal(events.filter(e => e.run).length, PINNED.length);
  for (const [i, e] of events.entries()) {
    if (!e.run) continue;
    const before = events[i - 1]?.log ?? '', n = /--(seed|case) (\d+)/.exec(e.run);
    assert.ok(before.includes(`${n[1]}=${n[2]}`) && before.includes(fuzzer(e.run)), `no start line before ${e.run}: ${before}`);
  }
});

test('a fuzzer that never exits is killed at the per-entry timeout and reported as a failure with its seed', async () => {
  const { runPinned, spawnEntry } = await import('./fuzz/pinned.mjs');
  assert.equal(typeof spawnEntry, 'function', 'the runner exports spawnEntry(argv, timeoutMs)');
  // A real child that never exits (a timer that outlives any test run). Whatever the timeout, the outcome is a
  // hang: nothing asserted here depends on how long anything takes.
  const forever = ['-e', 'setInterval(() => {}, 1 << 30)'];
  const hung = spawnEntry(forever, 250);
  assert.equal(hung.hung, true);
  assert.notEqual(hung.status, 0);
  assert.deepEqual(spawnEntry(['-e', 'process.exit(0)'], 120_000), { status: 0, hung: false });
  assert.deepEqual(spawnEntry(['-e', 'process.exit(3)'], 120_000), { status: 3, hung: false });
  const lines = [], ran = [];
  const status = runPinned([{ fuzzer: 'codec', args: ['--n', '5'], seed: 77 }, { fuzzer: 'run', args: [], seed: 78 }],
    { spawn: argv => { ran.push(argv); return spawnEntry(forever, 250); }, log: l => lines.push(l) });
  assert.equal(status, 1);
  assert.equal(ran.length, 1, 'nothing runs after a hang');
  const report = lines.join('\n');
  assert.match(report, /FUZZ-PINNED FAIL {2}codec {2}seed=77 {2}hang/);
  assert.ok(report.includes('replay: node --import ./test/ts-resolve.mjs test/fuzz/codec.mjs --n 5 --seed 77'), report);
});

const fuzzer = cmd => /test\/fuzz\/([\w-]+)\.mjs/.exec(cmd)?.[1];
const seeded = cmd => /--(seed|case) \d+(\s|$)/.test(cmd);

test('test:fuzz-pinned names a seed or a case on every fuzzer command', () => {
  const cmds = pinnedCommands();
  assert.ok(cmds.length >= 19, `the pinned stage ran 19 fuzzer commands at ec337c5; found ${cmds.length}`);
  const unseeded = cmds.filter(c => !seeded(c));
  // Which of those would differ between two runs: the ones whose script falls back to the clock.
  const clock = unseeded.filter(c => /Date\.now\(\)/.test(readFileSync(`${ROOT}test/fuzz/${fuzzer(c)}.mjs`, 'utf8')));
  assert.deepEqual(clock.map(fuzzer), [], `clock-seeded commands in test:fuzz-pinned:\n  ${clock.join('\n  ')}`);
  assert.deepEqual(unseeded, [], 'every pinned command states its seed, also where the script has a fixed default');
});

test('the pinned list is the same on every run; --random is a separate mode that prints its seed and its replay', () => {
  assert.deepEqual(list(), list());
  const out = list(['--random']);
  const m = /^fuzz-pinned: random mode, seed=(\d+)\s+replay: (node .*test\/fuzz\/pinned\.mjs --seed (\d+))$/.exec(out[0]);
  assert.ok(m, `first line of --random names the seed and the replay command, got: ${out[0]}`);
  assert.equal(m[1], m[3]);
  const cmds = out.slice(1);
  assert.ok(cmds.some(c => c.includes(`--seed ${m[1]}`)), 'the random seed reaches the fuzzers');
  // A replay (--seed n) is the same list the random run printed.
  assert.deepEqual(list(['--seed', m[1]]).filter(l => l.includes('test/fuzz/') && !l.startsWith('fuzz-pinned:')), cmds);
  // Fixed regression cases (--case) keep their case in every mode.
  assert.ok(cmds.some(c => c.includes('hostile.mjs --case 2366521731')));
});

test('a failing fuzzer stops the run and prints its seed and the exact command that replays it', async () => {
  const { runPinned, PINNED } = await import('./fuzz/pinned.mjs');
  const ran = [], lines = [];
  // The second command fails: nothing after it may run, and the report must carry that command verbatim.
  const status = runPinned(PINNED, { spawn: argv => { ran.push(argv.join(' ')); return ran.length === 2 ? 1 : 0; }, log: l => lines.push(l) });
  assert.equal(status, 1);
  assert.equal(ran.length, 2);
  const failed = ran[1], seed = /--(?:seed|case) (\d+)/.exec(failed)[1];
  const report = lines.join('\n');
  assert.ok(report.includes(`seed=${seed}`) || report.includes(`case=${seed}`), report);
  assert.ok(report.includes(`replay: node ${failed}`), report);
});
