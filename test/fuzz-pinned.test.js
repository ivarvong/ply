// `npm run test:fuzz-pinned` is the last stage of `npm test`. A gate has to run the same cases every time, so every
// fuzzer command in it must name its seed (or its case) on the command line, and a failure must say how to replay it.
// The expectation here does not come from the runner: the command list is read from package.json (expanded through
// the runner's --list when the script delegates to it) and judged against the rule "an explicit --seed <n> or
// --case <n> on every test/fuzz/*.mjs command", with the fuzzers' own sources saying which default to the clock.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNNER = 'test/fuzz/pinned.mjs';
const script = JSON.parse(readFileSync(ROOT + 'package.json', 'utf8')).scripts['test:fuzz-pinned'];

function list(extra = []) {
  const r = spawnSync(process.execPath, [RUNNER, '--list', ...extra], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean);
}
// The commands the npm script really runs: its own && chain, or the runner's list when it hands over to the runner.
function pinnedCommands() {
  return script.includes(RUNNER) ? list().filter(l => l.includes('test/fuzz/')) : script.split('&&').map(s => s.trim());
}
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
