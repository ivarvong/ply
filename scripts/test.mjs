// The CI test suite, split across N runners by measured duration.
//
//   node scripts/test.mjs --shard i/N FILE...   run shard i of N of FILE... (every test file, in any order)
//   node scripts/test.mjs --plan N FILE...      print the N-way partition and exit
//
// Every file runs as its own `node --test FILE` process (what one `node --test a b c` does anyway: one child per file),
// up to availableParallelism - 1 at once, heaviest first. A file's output is printed whole when it finishes; any file
// failing fails the shard. The partition is longest-processing-time first over test/durations.json (seconds per file,
// as this script measured them on a CI runner); a file with no entry weighs as the heaviest known file
// (a runner nearly to itself) until its weight is recorded; each shard's log ends with the weights it measured. The plan is a pure function of the file list and the
// weights, so the N shards of one commit cover every file exactly once; the workflow derives i and N from the matrix
// (strategy.job-index, strategy.job-total), so the count cannot disagree with the matrix.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';

const WEIGHTS = 'test/durations.json';

function plan(files, n) {
  const known = existsSync(WEIGHTS) ? JSON.parse(readFileSync(WEIGHTS, 'utf8')) : {};
  const heaviest = Math.max(1, ...Object.values(known));
  const uniq = [...new Set(files)].sort();
  if (uniq.length !== files.length) throw new Error('test: a file is listed twice');
  for (const f of uniq) if (!existsSync(f)) throw new Error(`test: no such file ${f}`);
  const weighted = uniq.map(file => ({ file, weight: known[file] ?? heaviest }))
    .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));
  const shards = Array.from({ length: n }, () => ({ files: [], weight: 0 }));
  for (const { file, weight } of weighted) {
    let best = 0;
    for (let i = 1; i < n; i++) if (shards[i].weight < shards[best].weight) best = i;
    shards[best].files.push(file); // heaviest first: the run order too
    shards[best].weight += weight;
  }
  return shards;
}

function runFile(file) {
  return new Promise(resolve => {
    const t0 = performance.now();
    const child = spawn(process.execPath, ['--test', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => out.push(d));
    child.on('close', (code, signal) => resolve({ file, code, signal, seconds: (performance.now() - t0) / 1000, output: Buffer.concat(out).toString() }));
  });
}

async function runShard(files, i, n) {
  const shards = plan(files, n);
  const mine = shards[i - 1];
  console.log(`test: shard ${i}/${n}, ${mine.files.length} of ${files.length} file(s); planned seconds per shard ${shards.map(s => Math.round(s.weight)).join(', ')}`);
  const width = Math.max(1, availableParallelism() - 1);
  const queue = [...mine.files];
  const results = [];
  const t0 = performance.now();
  await Promise.all(Array.from({ length: Math.min(width, queue.length) }, async () => {
    while (queue.length) {
      const r = await runFile(queue.shift());
      results.push(r);
      const ok = r.code === 0;
      console.log(`::group::${ok ? 'ok' : 'FAILED'} ${r.file} (${r.seconds.toFixed(1)} s)`);
      console.log(r.output);
      console.log('::endgroup::');
      if (!ok) console.log(`::error title=${r.file}::exited ${r.code ?? r.signal}\n${r.output.split('\n').filter(l => /^\s*(✖|not ok|error|Error)/.test(l)).slice(0, 40).join('\n')}`);
    }
  }));
  console.log(`\nper-file seconds (shard ${i}/${n}, ${((performance.now() - t0) / 1000).toFixed(1)} s wall, ${width} at once)`);
  for (const r of results.sort((a, b) => b.seconds - a.seconds)) console.log(`  ${r.seconds.toFixed(1).padStart(7)}  ${r.code === 0 ? 'ok    ' : 'FAILED'}  ${r.file}`);
  console.log(`weights: ${JSON.stringify(Object.fromEntries(results.map(r => [r.file, Math.round(r.seconds)])))}`);
  const failed = results.filter(r => r.code !== 0);
  if (failed.length) {
    console.error(`\n${failed.length} file(s) failed: ${failed.map(r => r.file).join(', ')}`);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const flag = args[0];
if (flag === '--plan') {
  const n = Number(args[1]);
  if (!(n >= 1)) { console.error('test: --plan wants N >= 1'); process.exit(2); }
  console.log(JSON.stringify(plan(args.slice(2), n), null, 2));
} else if (flag === '--shard') {
  const m = /^(\d+)\/(\d+)$/.exec(args[1] ?? '');
  const i = m ? Number(m[1]) : NaN, n = m ? Number(m[2]) : NaN;
  if (!(n >= 1 && i >= 1 && i <= n)) { console.error(`test: --shard wants i/N with 1 <= i <= N, got ${args[1]}`); process.exit(2); }
  if (args.length < 3) { console.error('test: no test files given'); process.exit(2); }
  await runShard(args.slice(2), i, n);
} else {
  console.error('usage: node scripts/test.mjs --shard i/N FILE... | --plan N FILE...');
  process.exit(2);
}
