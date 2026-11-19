// The ply side of the comparison, as one node process (bench/compare/run.mjs starts it under measure.mjs).
//   node bench/compare/ply-client.mjs <job.json>
// job: { build, task: 'read' | 'edit' | 'idle', url, warmupUrl?, path, out?, policy }
// `build` is the directory holding ply's entry points (dist/, or src/ under test/ts-resolve.mjs). Only ply/read and
// ply/edit are imported, as an application doing these two tasks would. `idle` imports them and does nothing: the
// baseline a node process costs before any work. With `warmupUrl` the same task runs there first, unmeasured, and the
// measured call follows in the same process (the reused-state mode). Prints one JSON line.
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { readFile } = await import(pathToFileURL(join(job.build, job.buildExt === 'ts' ? 'read.ts' : 'read.js')).href);
const { editFile } = await import(pathToFileURL(join(job.build, job.buildExt === 'ts' ? 'edit.ts' : 'edit.js')).href);

async function read(url, out) {
  const r = await readFile(url, { ref: 'main', path: job.path });
  if (!r.ok) throw new Error(`readFile: ${r.error.code} ${r.error.message}`);
  const fd = openSync(out, 'w');
  try { for await (const chunk of r.value.stream) writeSync(fd, chunk); } finally { closeSync(fd); }
  return { size: r.value.size };
}
async function edit(url) {
  const p = job.policy;
  const r = await editFile(url, {
    ref: 'refs/heads/main', path: job.path, find: p.find, replace: p.replace, message: p.message,
    author: { ...p.author, time: p.time, tz: p.tz }, committer: { ...p.committer, time: p.time, tz: p.tz },
  });
  if (!r.ok) throw new Error(`editFile: ${r.error.code} ${r.error.message}`);
  return { newCommit: r.value.newCommit };
}
const task = url => (job.task === 'read' ? read(url, job.out) : edit(url));

const result = { ok: true, task: job.task };
try {
  if (job.task !== 'idle') {
    if (job.warmupUrl) {
      const w0 = performance.now();
      await (job.task === 'read' ? read(job.warmupUrl, `${job.out}.warmup`) : edit(job.warmupUrl));
      result.warmupMs = performance.now() - w0;
    }
    const t0 = performance.now();
    Object.assign(result, await task(job.url));
    result.opMs = performance.now() - t0;
  }
} catch (e) {
  result.ok = false;
  result.error = String(e?.message ?? e);
}
result.selfMaxRssBytes = process.resourceUsage().maxRSS * 1024;
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.ok ? 0 : 1;
