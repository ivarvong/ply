// One sweep cell, in its own process. The parent passes --max-old-space-size when the cell is the 128 MiB heap.
// argv[2] is the cell JSON. One JSON line on stdout; exit 0 even on a typed refusal so the parent can tell a
// refusal from a crash. Peak RSS is the kernel's VmHWM for this process (vmHwmKiB below). ArrayBuffers are sampled because they
// sit outside the V8 heap the flag caps.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { GitHttp } from '../../src/client.js';
import { parsePack, resolvePack } from '../../src/pack.js';
import { pushRepo } from '../../src/repo-node.js';
import { Tracer } from '../../src/otel.js';
import { unwrap, unwrapAsync } from '../unwrap.js';
import { failure, fetchOps } from './ops.mjs';

const cell = JSON.parse(process.argv[2]);
// the cell's limits as written: the keys it sets, every other key the default (parseLimits, where the client is made)
const opts = { tracer: new Tracer(), limits: cell.limits ?? {} };

let heapPeak = 0;
let abPeak = 0;
const sample = setInterval(() => {
  const m = process.memoryUsage();
  if (m.heapUsed > heapPeak) heapPeak = m.heapUsed;
  if (m.arrayBuffers > abPeak) abPeak = m.arrayBuffers;
}, 5);
sample.unref();

/** @param {Iterable<string>} oids */
function oidsHash(oids) {
  const hash = createHash('sha1');
  for (const oid of [...oids].sort()) hash.update(oid);
  return hash.digest('hex');
}

// KiB. /proc/self/status VmHWM is this image's own high-water mark (reset by exec); elsewhere, ru_maxrss.
function vmHwmKiB() {
  try {
    const m = /VmHWM:\s+(\d+)\s+kB/.exec(readFileSync('/proc/self/status', 'utf8'));
    if (m) return Number(m[1]);
  } catch {
    // not Linux
  }
  return process.resourceUsage().maxRSS;
}

const TYPE_ID = { commit: 1, tree: 2, blob: 3, tag: 4 };

const ops = {
  ...fetchOps(cell, opts),
  async pack() {
    const buf = new Uint8Array(readFileSync(cell.pack));
    const parsed = unwrap(parsePack(buf, { limits: opts.limits }));
    const resolved = unwrap(resolvePack(parsed, () => null, opts.limits));
    return { n: resolved.objects.size, maxChain: resolved.stats.maxChain, oidsHash: oidsHash(resolved.objects.keys()) };
  },
  // A thin fetch: the server deltas against the haves, and the bases come from the local store (`cell.store`, a bare
  // repo holding the haves) through the external lookup, the way a client with those objects resolves them.
  async fetchThin() {
    const external = (/** @type {string} */ oid) => {
      try {
        const type = execFileSync('git', ['-C', cell.store, 'cat-file', '-t', oid], { encoding: 'utf8' }).trim();
        const data = execFileSync('git', ['-C', cell.store, 'cat-file', type, oid], { maxBuffer: 1 << 28 });
        return { type: TYPE_ID[type], data: new Uint8Array(data) };
      } catch {
        return null;
      }
    };
    const c = unwrap(GitHttp.create(cell.url, opts));
    const r = await unwrapAsync(c.fetchPack({ wants: cell.wants, haves: cell.haves, thinPack: true }, { external }));
    const objects = r.resolved?.objects ?? r.objects ?? new Map();
    return { n: objects.size, refDelta: r.parsed?.stats.refDelta ?? 0, oidsHash: oidsHash(objects.keys()) };
  },
  async pushRepo() {
    const r = await unwrapAsync(pushRepo(cell.local, cell.url, cell.spec ?? {}, opts));
    return { updates: r.updates.length, objects: r.objects, thinDeltas: r.thinDeltas, upToDate: r.upToDate };
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
  res = failure(e);
} finally {
  clearInterval(sample);
}
const cpu = process.cpuUsage(cpu0);
res.ms = Math.round(performance.now() - t0);
res.cpuMs = Math.round((cpu.user + cpu.system) / 1000);
// The peak the kernel saw, including ArrayBuffers the heap flag does not cap. VmHWM, not ru_maxrss: ru_maxrss survives
// exec, so a cell spawned by a driver that had grown to 500 MB building fixtures reported 500 MB whatever it used.
res.rssPeakMB = Math.round(vmHwmKiB() / 1024);
res.heapPeakMB = Math.round(heapPeak / (1024 * 1024));
res.abPeakMB = Math.round(abPeak / (1024 * 1024));
process.stdout.write(`${JSON.stringify(res)}\n`);
process.exit(0);
