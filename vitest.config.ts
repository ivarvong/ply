// The unit, oracle and space suites. Fuzzers (test/fuzz/*.mjs) stay node scripts; test/workerd.test.js runs on its own
// (`npm run test:workerd`: it needs the workerd binary and is not in CI's suite).
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Source keeps `.js` specifiers for .ts files. vitest maps them itself; plain node does not, so every process the
// suite starts (the forks below, worker_threads the space tests spawn, `node` child processes) inherits the resolve
// hook through NODE_OPTIONS. Set before any pool starts, so the forks get it too (harmless there).
const hook = `--import=${fileURLToPath(new URL('./test/ts-resolve.mjs', import.meta.url))}`;
if (!(process.env['NODE_OPTIONS'] ?? '').includes(hook)) process.env['NODE_OPTIONS'] = [process.env['NODE_OPTIONS'], hook].filter(Boolean).join(' ');

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    exclude: ['test/workerd.test.js', '**/node_modules/**'],
    // node:test had no default timeout and the space/oracle tests run for minutes; a test that needs a bound states it
    // in its own options ({ timeout }), exactly as before. 0 disables vitest's 5 s / 10 s defaults.
    testTimeout: 0,
    hookTimeout: 0,
    // One file per child process, files in parallel (node --test's model). The tests spawn git, sshd, http servers and
    // worker_threads that load src/*.ts under node's type stripping; `forks` measured faster than `threads` here
    // (scripts/to-vitest.mjs header, PR body) and keeps process-global state (process.on('exit'), env) per file.
    pool: 'forks',
    fileParallelism: true,
    // Tests run in declaration order within a file, as under node:test.
    sequence: { concurrent: false },
  },
});
