// The suite Stryker runs per mutant (stryker.conf.json): the fast, mutation-killing files. Same settings as
// vitest.config.ts; quick sizes; push-outcome's quick space on the test's own thread (PUSH_SPACE_WORKERS=0), because
// Stryker records per-test coverage and the active mutant in the test process's main thread, and code reached only in
// a worker would count as uncovered. MUTATION=1 skips push-outcome's two tests that are not about src (the axis
// renderer table and the git-observed cells), which the mutation command left out before (--test-name-pattern).
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.ts';

// Every test process of the mutation run gets test/stryker-parent-guard.cjs: a mutant can grow a process past 23 GB
// (src/pktline.js:22 without out.set: the memory was node:assert's diff of two 65,516-element arrays in a test, now
// test/bytes-assert.js, #85) or orphan it; the guard SIGKILLs a test process past 3 GB resident or once its
// parent is gone, and Stryker counts the dead process as a detected mutant (scripts/mutate.mjs DETECTED).
const guard = `--require=${fileURLToPath(new URL('./test/stryker-parent-guard.cjs', import.meta.url))}`;
if (!(process.env['NODE_OPTIONS'] ?? '').includes(guard)) process.env['NODE_OPTIONS'] = [process.env['NODE_OPTIONS'], guard].filter(Boolean).join(' ');

// mergeConfig concatenates arrays, so `include` is set on the merged result: these files only, not base's glob too.
const MUTATION_FILES = [
  'test/format-facts.test.js',
  'test/prefix-closure.test.js',
  'test/props.test.js',
  'test/mutant-kill.test.js',
  'test/mutant-kill-tree.test.js',
  'test/mutant-kill-packs.test.js',
  'test/packstream.test.js',
  'test/pack-resolve-linear.test.js',
  'test/delta-bound.test.js',
  'test/packwrite.test.js',
  'test/push-commands.test.js',
  'test/push-unpack-host.test.js',
  'test/http-options.test.js',
  'test/describe-pack.test.js',
  'test/packindex.test.js',
  'test/space/push-outcome.test.js',
  'test/result.test.js',
  'test/option.test.js',
  'test/version-refname.test.js',
  'test/uprequest.test.js',
  'test/parse-once.test.js',
  'test/want-oracle.test.js',
  'test/dotnames.test.js',
  'test/parsetree.test.js',
  'test/otel-ended.test.js',
  'test/sha1.test.js',
  'test/lsrefs-step.test.js',
  'test/path-trees-unit.test.js',
  'test/pullstream.test.js',
  'test/inflate-codesets.test.js',
  'test/inflate-pos.test.js',
];
// A test that hangs under a mutant fails at its own timeout, not at Stryker's per-mutant one. vitest.config.ts turns both
// timers off (0), so a hung await ran until Stryker's timeout: 2 × the covering tests' dry-run time + 8 s
// (stryker.conf.json timeoutFactor, timeoutMS), and for a mutant every test reaches (a static one) that is about 2 × 48 s
// + 8 s on a CI runner. 622 of the 29,604 mutants of a full run timed out (#307: shard 5 of 3502eef held 21 of them
// and hit the 90-minute job limit at 692/698). 60 s is 5× the slowest mutation test (push-outcome `every cell`,
// 11.8 s on an M-series Mac, 2026-11-12) and above Stryker's own bound for any single test (2 × 11.8 + 8 s), so no
// test a mutant leaves correct but slower is cut sooner than Stryker would cut it; a cut test is a failed test, a
// detected mutant, exactly as a Timeout is (scripts/mutate.mjs DETECTED).
const MUTATION_TEST_TIMEOUT_MS = 60_000;
const config = mergeConfig(base, defineConfig({
  test: {
    env: { PROP_N: '4', PUSH_SPACE: 'quick', PUSH_SPACE_WORKERS: '0', MUTATION: '1' },
    testTimeout: MUTATION_TEST_TIMEOUT_MS,
    hookTimeout: MUTATION_TEST_TIMEOUT_MS,
  },
}));
config.test = { ...config.test, include: MUTATION_FILES };
export default config;
