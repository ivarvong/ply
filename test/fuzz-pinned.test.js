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
import { readFileSync, readdirSync, mkdtempSync, symlinkSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
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

// codec.mjs hung under load with node waiting inside execFileSync and its git oracle waiting on stdin (no ply code
// involved: the same call hangs in a script that imports no ply). The oracle here is a stand-in `git` that
// initialises a repository and then never answers. The fuzzer has to kill it, fail the case by name and exit 1; the
// expected lines come from that rule, not from the fuzzer. Without the oracle timeout this run never ends and the
// 40 s limit below kills it (status null).
test('codec: a git oracle that never answers is killed and fails the case, it does not hang the fuzzer', () => {
  const bin = mkdtempSync(join(tmpdir(), 'ply-deaf-git-'));
  try {
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nfor a in "$@"; do [ "$a" = init ] && exit 0; done\nexec sleep 600\n');
    chmodSync(join(bin, 'git'), 0o755);
    const r = spawnSync(process.execPath, ['--import', './test/ts-resolve.mjs', 'test/fuzz/codec.mjs', '--n', '150', '--seed', '1', '--oracle-timeout-s', '1'],
      { cwd: ROOT, encoding: 'utf8', timeout: 40_000, killSignal: 'SIGKILL', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(r.status, 1, `exit status; signal=${r.signal}; output: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /FAIL #\d+ delta-git: oracle did not answer: git hash-object -w --stdin had not exited after 1 s and was killed/);
    assert.match(r.stdout, /150 cases in \d+s, [1-9]\d* failures/);
    // Every FAIL line names the seed and the command that replays it. codec draws one stream from --seed, so case
    // #i is the (i+1)th case of that stream: `--n <i+1> --seed <seed>` (the rule scripts/nightly-fuzz.mjs applies).
    const failLines = r.stdout.split('\n').filter(l => l.startsWith('FAIL'));
    assert.ok(failLines.length > 0);
    for (const l of failLines) {
      const i = Number(/^FAIL #(\d+) /.exec(l)[1]);
      assert.ok(l.includes(' seed=1 ') && l.endsWith(`replay: node --import ./test/ts-resolve.mjs test/fuzz/codec.mjs --n ${i + 1} --seed 1`), l);
    }
  } finally { rmSync(bin, { recursive: true, force: true }); }
}, 60_000);

// Owner decision (1) covers a fuzzer run directly, not only through the runner: `npm run fuzz:codec` passes no
// --seed, so the seed comes from the clock and a failure can be replayed only if the run named it. Which fuzzers
// fall back to the clock is read from their sources (the seven at ec337c5). Each is run with no --seed and a small
// --n, and the first line it prints has to name a seed. Nothing here depends on which seed the clock gave or on
// whether the run found a failure.
const direct = (name, args, env = process.env) => spawnSync(process.execPath, ['--import', './test/ts-resolve.mjs', `test/fuzz/${name}.mjs`, ...args],
  { cwd: ROOT, encoding: 'utf8', timeout: 240_000, killSignal: 'SIGKILL', env });
const firstLine = out => out.split('\n').find(l => l.trim() !== '') ?? '';

test('every clock-seeded fuzzer, run directly with no --seed, names its seed on its first line', () => {
  const clock = readdirSync(`${ROOT}test/fuzz`).filter(f => f.endsWith('.mjs') && /args\.seed \?\?[^\n]*Date\.now\(\)/.test(readFileSync(`${ROOT}test/fuzz/${f}`, 'utf8'))).map(f => f.slice(0, -4)).sort();
  assert.deepEqual(clock, ['codec', 'hostile', 'liar', 'packgen', 'packs', 'protocol', 'run']);
  for (const name of clock) {
    const n = name === 'codec' ? '200' : '2';
    const r = direct(name, ['--n', n]);
    // The run seed by name, not any `seed=`: a case line's seed=<case seed> matched the old /\bseed[= ]\d+/ and hid
    // that packgen never logged its run seed (#308, CI 43164297129: both cases were noop edits and printed nothing).
    assert.match(firstLine(r.stdout), new RegExp(`^${name}: seed \\d+, n ${n}\\b`), `${name} with no --seed: first line names no run seed (signal=${r.signal}): ${r.stdout.slice(0, 300)}${r.stderr.slice(0, 300)}`);
  }
}, 900_000);

// #308: the same rule with no case to lean on. With --n 0 a fuzzer runs no case, so only a run-level line can name
// the seed: a fuzzer that drops it fails here on every run, not on the 0.57% of clock seeds whose first two packgen
// cases were noop edits. Run once from the clock and once with --seed 4242; the second line must carry 4242 and the
// replay command that reproduces the run.
test('#308 every clock-seeded fuzzer names its run seed and replay before any case (--n 0, clock and --seed)', () => {
  const clock = readdirSync(`${ROOT}test/fuzz`).filter(f => f.endsWith('.mjs') && /args\.seed \?\?[^\n]*Date\.now\(\)/.test(readFileSync(`${ROOT}test/fuzz/${f}`, 'utf8'))).map(f => f.slice(0, -4)).sort();
  assert.ok(clock.length >= 7, clock.join(' '));
  for (const name of clock) {
    const a = direct(name, ['--n', '0']);
    assert.equal(a.status, 0, `${name} --n 0: exit ${a.status} signal=${a.signal}: ${a.stdout.slice(0, 300)}${a.stderr.slice(0, 300)}`);
    assert.match(firstLine(a.stdout), new RegExp(`^${name}: seed \\d+, n 0\\b`), `${name} --n 0 with no --seed: ${a.stdout.slice(0, 300)}`);
    const b = direct(name, ['--n', '0', '--seed', '4242']);
    assert.equal(b.status, 0, `${name} --n 0 --seed 4242: exit ${b.status}: ${b.stdout.slice(0, 300)}${b.stderr.slice(0, 300)}`);
    const line = firstLine(b.stdout);
    assert.match(line, new RegExp(`^${name}: seed 4242, n 0\\b`), `${name} --seed 4242: ${line}`);
    assert.ok(line.endsWith(`replay: node --import ./test/ts-resolve.mjs test/fuzz/${name}.mjs --n 0 --seed 4242`), `${name}: ${line}`);
  }
}, 300_000);

// #308 pinned: run seed 963345382 draws two noop edits as packgen's first two cases (the CI 43164297129 shape). The
// run still names its seed first, each skipped case names its case seed, and the summary counts 0 run, 2 skipped.
test('#308 packgen: a run whose every case is a noop edit still names its seed and counts the skips', () => {
  const r = direct('packgen', ['--n', '2', '--seed', '963345382']);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const lines = r.stdout.split('\n').filter(l => l.trim() !== '');
  assert.match(lines[0], /^packgen: seed 963345382, n 2 {2}replay: node --import \.\/test\/ts-resolve\.mjs test\/fuzz\/packgen\.mjs --n 2 --seed 963345382$/);
  assert.equal(lines.filter(l => /^skip #\s*\d+ seed=\d+ noop edit /.test(l)).length, 2, r.stdout);
  assert.ok(lines.includes('0 cases, 2 skipped (noop edit), 0 failures (seed 963345382)'), r.stdout);
}, 60_000);

test('codec: the seed it prints is the seed it ran, a replay with it draws the same cases', () => {
  const a = direct('codec', ['--n', '200']);
  const seed = /^codec: seed (\d+), n 200\b/.exec(firstLine(a.stdout))?.[1];
  assert.ok(seed, `first line: ${firstLine(a.stdout)}`);
  // The table after the summary counts every generator and codec choice the run drew: a different seed gives a
  // different table, the same seed the same one. Only the elapsed seconds are cut.
  const table = out => out.slice(out.indexOf(' cases in ')).replace(/ cases in \d+s/, '');
  const b = direct('codec', ['--n', '200', '--seed', seed]);
  assert.equal(b.status, a.status);
  assert.equal(table(b.stdout), table(a.stdout));
  assert.notEqual(table(direct('codec', ['--n', '200', '--seed', String(Number(seed) + 1)]).stdout), table(a.stdout));
}, 120_000);

// below-hash defaults its seed to the constant 1 (its usage line). It still says so on start, and a failure names
// the seed and its replay. The failure is made by the oracle, not by ply: a stand-in `git` whose fsck rejects every
// object, so each object ply accepts is a DIVERGE. The replay expected for a case is its usage line's: a fixed case
// by name, a random case `kind#<seed>` by that seed, with the run's --n and --seed (they decide which cases exist).
// Under vitest `command -v git` is test/git-shim, which strips its own directory from PATH and execs `git`: the
// stand-in hands git the PATH without itself, or the shim finds the stand-in again and the two exec each other forever.
test('below-hash: prints its seed on start, and a failure names the seed and the command that replays it', () => {
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = mkdtempSync(join(tmpdir(), 'ply-no-fsck-'));
  try {
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = fsck ] && { echo "error: stand-in fsck rejects every object"; exit 1; }; done\nPATH='${process.env.PATH}' exec "${realGit}" "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const r = direct('below-hash', ['--n', '2'], { ...process.env, PATH: `${bin}:${process.env.PATH}` });
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(firstLine(r.stdout), /^below-hash: seed 1, n 2\b/);
    const failed = r.stdout.split('\n').filter(l => /^(FAIL|DIVERGE|STRICT-NORMAL)\s/.test(l));
    assert.ok(failed.some(l => /^DIVERGE\s+valid\s/.test(l)), r.stdout);
    for (const l of failed) {
      const name = /^\S+\s+(\S+?):?\s/.exec(l)[1], id = /#(\d+)$/.exec(name)?.[1] ?? name;
      assert.ok(l.includes(' seed=1 ') && l.endsWith(`replay: node --import ./test/ts-resolve.mjs test/fuzz/below-hash.mjs --n 2 --seed 1 --case ${id}`), l);
    }
  } finally { rmSync(bin, { recursive: true, force: true }); }
}, 300_000);

// Owner decision (4). To execFileSync a timeout of 0 means no timeout, so `--oracle-timeout-s 0` switched the hang
// guard off; a negative or non-numeric value reached it as an invalid timeout and came back as one RangeError FAIL
// line per judged case; `5abc` and `1.5` were read as 5 and 1. The flag takes a whole number of seconds, 1 or more.
// Anything else is a usage error before any case runs: one line on stderr naming the flag, exit status 2, nothing
// on stdout. The deaf oracle is on PATH so that a value that slips through shows as a FAIL line or a hang, not as
// a clean run.
test('codec: --oracle-timeout-s 0, negative, fractional or non-numeric is a one-line usage error, exit 2', () => {
  const bin = mkdtempSync(join(tmpdir(), 'ply-deaf-git-'));
  try {
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nfor a in "$@"; do [ "$a" = init ] && exit 0; done\nexec sleep 600\n');
    chmodSync(join(bin, 'git'), 0o755);
    for (const bad of [['0'], ['-1'], ['abc'], ['5abc'], ['1.5'], ['']]) {
      const r = spawnSync(process.execPath, ['--import', './test/ts-resolve.mjs', 'test/fuzz/codec.mjs', '--n', '150', '--seed', '1', '--oracle-timeout-s', ...bad],
        { cwd: ROOT, encoding: 'utf8', timeout: 40_000, killSignal: 'SIGKILL', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      const what = `--oracle-timeout-s ${JSON.stringify(bad[0])}: status=${r.status} signal=${r.signal} stdout=${r.stdout.slice(0, 300)} stderr=${r.stderr.slice(0, 300)}`;
      assert.equal(r.status, 2, what);
      assert.match(r.stderr, /^[^\n]*--oracle-timeout-s[^\n]*\n$/, what);
      assert.equal(r.stdout, '', what);
    }
  } finally { rmSync(bin, { recursive: true, force: true }); }
}, 300_000);
