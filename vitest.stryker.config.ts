// The suite Stryker runs per mutant (stryker.conf.json): the fast, mutation-killing files. Same settings as
// vitest.config.ts; quick sizes; push-outcome's quick space on the test's own thread (PUSH_SPACE_WORKERS=0), because
// Stryker records per-test coverage and the active mutant in the test process's main thread, and code reached only in
// a worker would count as uncovered. MUTATION=1 skips push-outcome's two tests that are not about src (the axis
// renderer table and the git-observed cells), which the mutation command left out before (--test-name-pattern).
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.ts';

export default mergeConfig(base, defineConfig({
  test: {
    include: [
      'test/format-facts.test.js',
      'test/prefix-closure.test.js',
      'test/props.test.js',
      'test/mutant-kill.test.js',
      'test/mutant-kill-tree.test.js',
      'test/space/push-outcome.test.js',
    ],
    env: { PROP_N: '4', PUSH_SPACE: 'quick', PUSH_SPACE_WORKERS: '0', MUTATION: '1' },
  },
}));
