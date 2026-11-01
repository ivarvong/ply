// One sweep cell, in its own process. The parent passes --max-old-space-size when the cell is the 128 MiB heap.
// argv[2] is the cell JSON. One JSON line on stdout; exit 0 even on a typed refusal so the parent can tell a
// refusal from a crash. Peak RSS is the kernel's maxRSS (KiB on Linux). ArrayBuffers are sampled because they
// sit outside the V8 heap the flag caps.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, listTree } from '../../src/read.js';
import { readLog } from '../../src/log.js';
import { editFile } from '../../src/edit.js';
import { pushTree } from '../../src/tree.js';
import { mergeBranch } from '../../src/merge.js';
import { GitHttp } from '../../src/client.js';
import { parsePack, resolvePack } from '../../src/pack.js';
import { Tracer } from '../../src/otel.js';
import { withLimits } from '../../src/limits.js';

const cell = JSON.parse(process.argv[2]);
const opts = { tracer: new Tracer(), limits: withLimits(cell.limits ?? {}) };
const author = { name: 'sweep', email: 'sweep@example.com' };
const when = 1700000000;

let heapPeak = 0;
let abPeak = 0;
const sample = setInterval(() => {
  const m = process.memoryUsage();
  if (m.heapUsed > heapPeak) heapPeak = m.heapUsed;
  if (m.arrayBuffers > abPeak) abPeak = m.arrayBuffers;
}, 5);
sample.unref();

/** @param {ReadableStream<Uint8Array>} stream */
async function drain(stream) {
  let len = 0;
  for await (const chunk of stream) len += chunk.byteLength;
  return len;
}

const ops = {
  async readFile() {
    const r = await readFile(cell.url, { ref: cell.ref ?? null, path: cell.path }, opts);
    const len = await drain(r.stream);
    return { blob: r.blob, size: r.size, len };
  },
  async listTree() {
    const r = await listTree(cell.url, { ref: cell.ref ?? null, path: cell.path ?? '' }, opts);
    return { tree: r.tree, n: r.entries.length };
  },
  async readLog() {
    const r = await readLog(cell.url, { ref: cell.ref ?? 'main', limit: cell.limit }, opts);
    return { n: r.commits.length, truncated: r.truncated };
  },
  async lsRefs() {
    const r = await new GitHttp(cell.url, opts).lsRefs(cell.prefixes ?? []);
    return { n: r.refs.size, head: r.head };
  },
  async editFile() {
    const r = await editFile(cell.url, { path: cell.path, find: cell.find, replace: cell.replace, author, message: 'sweep', time: when }, opts);
    return { commit: r.newCommit };
  },
  async pushTree() {
    /** @type {Record<string, Uint8Array>} */
    const files = {};
    for (let i = 0; i < cell.nfiles; i++) files[`f/${String(i).padStart(7, '0')}.bin`] = new Uint8Array(cell.size).fill((i + 1) & 255);
    const r = await pushTree(cell.url, { ref: 'refs/heads/main', files, author, message: 'sweep', time: when }, opts);
    return { commit: r.newCommit, noop: r.noop };
  },
  async merge() {
    const r = await mergeBranch(cell.url, { ref: 'refs/heads/main', from: cell.from, author, message: 'sweep merge', time: when }, opts);
    return { outcome: r.outcome, base: r.base };
  },
  async pack() {
    const buf = new Uint8Array(readFileSync(cell.pack));
    const parsed = parsePack(buf, { limits: opts.limits });
    const resolved = resolvePack(parsed, () => null, opts.limits);
    const hash = createHash('sha1');
    for (const oid of [...resolved.objects.keys()].sort()) hash.update(oid);
    return { n: resolved.objects.size, maxChain: resolved.stats.maxChain, oidsHash: hash.digest('hex') };
  },
};

const t0 = performance.now();
const cpu0 = process.cpuUsage();
/** @type {Record<string, unknown>} */
let res;
try {
  const op = ops[cell.op];
  if (!op) throw new Error(`unknown op ${cell.op}`);
  res = { status: 'ok', ...(await op()) };
} catch (e) {
  const err = /** @type {{ code?: unknown, name?: string, message?: string, got?: unknown, max?: unknown, what?: unknown }} */ (e);
  const typed = !!err && typeof err.code === 'string' && err.name !== 'TypeError' && err.name !== 'RangeError';
  res = {
    status: typed ? 'refused' : 'crash',
    code: typeof err?.code === 'string' ? err.code : null,
    name: err?.name ?? null,
    what: typeof err?.what === 'string' ? err.what : null,
    got: typeof err?.got === 'number' ? err.got : null,
    max: typeof err?.max === 'number' ? err.max : null,
    msg: String(err?.message ?? e).slice(0, 300),
  };
} finally {
  clearInterval(sample);
}
const cpu = process.cpuUsage(cpu0);
res.ms = Math.round(performance.now() - t0);
res.cpuMs = Math.round((cpu.user + cpu.system) / 1000);
// Linux: ru_maxrss is kilobytes. That is the peak the kernel saw, including ArrayBuffers the heap flag does not cap.
res.rssPeakMB = Math.round(process.resourceUsage().maxRSS / 1024);
res.heapPeakMB = Math.round(heapPeak / (1024 * 1024));
res.abPeakMB = Math.round(abPeak / (1024 * 1024));
process.stdout.write(`${JSON.stringify(res)}\n`);
process.exit(0);
