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
  'test/space/push-outcome.test.js',
  'test/result.test.js',
  'test/version-refname.test.js',
];
const config = mergeConfig(base, defineConfig({
  test: {
    env: { PROP_N: '4', PUSH_SPACE: 'quick', PUSH_SPACE_WORKERS: '0', MUTATION: '1' },
  },
}));
config.test = { ...config.test, include: MUTATION_FILES };
export default config;
