// vitest setup file for gate c (test/space/failsite-hook.mjs), added by vitest.config.ts only when PLY_FAILSITES is
// set: names the test file a vitest fork is running as the runner of the stacks it records, and exports it to the
// worker threads and child processes the file starts (they inherit the environment).
import { beforeAll } from 'vitest';
import { relative } from 'node:path';
import { ROOT, KEY } from './failsite-instrument.mjs';

beforeAll(({}, suite) => { // oxlint-disable-line no-empty-pattern -- vitest reads the first parameter as a fixture pattern
  const file = relative(ROOT, suite.file?.filepath ?? suite.filepath);
  process.env['PLY_FAILSITE_RUNNER'] = file;
  globalThis[KEY]?.runner(file);
});
