// The unit, oracle and space suites. Fuzzers (test/fuzz/*.mjs) stay node scripts; test/workerd.test.js runs on its own
// (`npm run test:workerd`: it needs the workerd binary and is not in CI's suite).
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { defineConfig } from 'vitest/config';

// Source keeps `.js` specifiers for .ts files. vitest maps them itself; plain node does not, so every process the
// suite starts (the forks below, worker_threads the space tests spawn, `node` child processes) inherits the resolve
// hook through NODE_OPTIONS. Set before any pool starts, so the forks get it too (harmless there).
const hook = `--import=${fileURLToPath(new URL('./test/ts-resolve.mjs', import.meta.url))}`;
if (!(process.env['NODE_OPTIONS'] ?? '').includes(hook)) process.env['NODE_OPTIONS'] = [process.env['NODE_OPTIONS'], hook].filter(Boolean).join(' ');

// `--shard i/N` by measured duration, not vitest's count-based split: longest-processing-time first over
// test/durations.json (seconds per file on a CI runner, from ci/fast #72). A file with no entry weighs as the heaviest
// known file until it is measured. The plan is a pure function of the file list and the weights, so the N shards of one
// commit cover every file exactly once. Within a shard, files start heaviest first.
const WEIGHTS = 'test/durations.json';
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const weights = (): Readonly<Record<string, number>> => (existsSync(WEIGHTS) ? JSON.parse(readFileSync(WEIGHTS, 'utf8')) : {});
const fileOf = (spec: TestSpecification): string => relative(ROOT, spec.moduleId).split('\\').join('/');

class WeightedSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard ?? { index: 1, count: 1 };
    const known = weights();
    const heaviest = Math.max(1, ...Object.values(known));
    const weighted = files.map(spec => ({ spec, file: fileOf(spec), weight: known[fileOf(spec)] ?? heaviest }))
      .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));
    const shards = Array.from({ length: count }, () => ({ specs: [] as TestSpecification[], weight: 0 }));
    for (const { spec, weight } of weighted) {
      let best = 0;
      for (let i = 1; i < count; i++) if (shards[i]!.weight < shards[best]!.weight) best = i;
      shards[best]!.specs.push(spec);
      shards[best]!.weight += weight;
    }
    return shards[index - 1]!.specs;
  }
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const known = weights();
    return [...files].sort((a, b) => (known[fileOf(b)] ?? 0) - (known[fileOf(a)] ?? 0));
  }
}

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    exclude: ['test/workerd.test.js', '**/node_modules/**'],
    // node:test had no default timeout and the space/oracle tests run for minutes; a test that needs a bound states it
    // in its own options ({ timeout }), exactly as before. 0 disables vitest's 5 s / 10 s defaults.
    testTimeout: 0,
    hookTimeout: 0,
    // One file per child process, files in parallel (node --test's model). The tests spawn git, http servers and
    // worker_threads that load src/*.ts under node's type stripping; `forks` measured faster than `threads` here
    // (scripts/to-vitest.mjs header, PR body) and keeps process-global state (process.on('exit'), env) per file.
    pool: 'forks',
    fileParallelism: true,
    // Tests run in declaration order within a file, as under node:test.
    sequence: { concurrent: false, sequencer: WeightedSequencer },
  },
});
