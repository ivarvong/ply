// CPU benchmark of the byte paths a Worker is billed for: inflate() of one member, a parsePack collection, and the pack
// a push writes. Each case runs in its own node process (a fresh heap, so one case's garbage is not the next one's GC),
// and the trees under comparison are run interleaved, so a load change on the machine hits all of them alike.
//   node test/bench.mjs [--runs 5] [--case <substring>] [--tree <dir> ...]   (default tree: this checkout)
// A tree is any ply checkout (an older commit's worktree too): the cases import its src/ through its own ts-resolve,
// using only APIs every tree since #172 has (inflate, parsePack, buildPack or measurePack/streamPack).
// CPU is process.cpuUsage() (user + system, every thread: CompressionStream's zlib runs on libuv's pool) per iteration,
// after a warm-up. `rss+` is the peak resident size during one operation over the size after a gc() and a pause before
// it, sampled every millisecond from a worker thread: what the operation held, its garbage included (the output of an
// inflate() is in it). The memory bound itself is test/stream-memory.test.js's and test/push-stream.test.js's.
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const KIB = 1024;
const MIB = KIB * KIB;
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const opts = (k) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []));

// ---- deterministic inputs (the same bytes for every tree) ----
function prng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
}
function randomBytes(n, seed) {
  const r = prng(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 4) { const v = r(); out[i] = v; out[i + 1] = v >>> 8; out[i + 2] = v >>> 16; out[i + 3] = v >>> 24; }
  return out;
}
// Source-like text: lines of words from a 2,000-word vocabulary (deflates about 3:1 with matches and literals mixed).
function textBytes(n, seed) {
  const r = prng(seed);
  const words = Array.from({ length: 2000 }, (_, i) => `w${(i * 2654435761 >>> 0).toString(36).slice(0, 2 + (i % 7))}`);
  const out = new Uint8Array(n);
  let o = 0;
  while (o < n) {
    let line = '  '.repeat(r() % 4);
    const k = 3 + (r() % 9);
    for (let j = 0; j < k; j++) line += `${words[r() % words.length]}${j + 1 < k ? ' ' : ''}`;
    line += r() % 5 === 0 ? ';\n' : '\n';
    for (let j = 0; j < line.length && o < n; j++) out[o++] = line.charCodeAt(j);
  }
  return out;
}
const dataOf = (kind, n, seed) => (kind === 'rand' ? randomBytes(n, seed) : textBytes(n, seed));

// A pack built here with node's zlib (not the tree's writer), cached by name: every tree parses the same bytes.
function objHeader(type, size) {
  const out = [];
  let c = (type << 4) | (size & 15);
  let s = Math.floor(size / 16);
  while (s > 0) { out.push(c | 0x80); c = s & 0x7f; s = Math.floor(s / 128); }
  out.push(c);
  return Uint8Array.from(out);
}
function buildTestPack(objects) {
  const parts = [];
  const hdr = new Uint8Array(12);
  hdr.set([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2]);
  new DataView(hdr.buffer).setUint32(8, objects.length);
  parts.push(hdr);
  for (const o of objects) { parts.push(objHeader(o.type, o.data.length)); parts.push(new Uint8Array(deflateSync(o.data))); }
  const body = Buffer.concat(parts);
  return new Uint8Array(Buffer.concat([body, createHash('sha1').update(body).digest()]));
}
function treeBytes(n, seed) {
  const r = prng(seed);
  const out = new Uint8Array(n);
  let o = 0;
  for (let e = 0; o < n; e++) {
    const head = `100644 file-${e}-${r() % 100000}.txt\0`;
    for (let j = 0; j < head.length && o < n; j++) out[o++] = head.charCodeAt(j);
    for (let j = 0; j < 20 && o < n; j++) out[o++] = r() & 0xff;
  }
  return out;
}
const PACKS = {
  tiny: () => Array.from({ length: 100_000 }, (_, i) => ({ type: 3, data: new TextEncoder().encode(`blob ${i}\n`) })),
  trees: () => Array.from({ length: 2000 }, (_, i) => ({ type: 2, data: treeBytes(4 * KIB, i + 1) })),
  big: () => [{ type: 3, data: textBytes(64 * MIB, 7) }],
};
function packFile(name) {
  const dir = join(tmpdir(), 'ply-bench');
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${name}.pack`);
  if (!existsSync(f)) writeFileSync(f, buildTestPack(PACKS[name]()));
  return new Uint8Array(readFileSync(f));
}

// ---- the cases: setup (untimed) returns the operation; iters is per timed run ----
const sizes = { '64k': 64 * KIB, '1m': MIB, '64m': 64 * MIB };
const iters = { '64k': 400, '1m': 20, '64m': 1 };
const BIG_LIMITS = { maxObjectSize: 128 * MIB, maxInflatedTotal: 1024 * MIB, maxPackObjects: 200_000 };
const CASES = {};
for (const kind of ['rand', 'text']) {
  for (const [sz, n] of Object.entries(sizes)) {
    CASES[`inflate-${kind}-${sz}`] = {
      iters: iters[sz],
      async setup(tree) {
        const { inflate } = await import(`${tree}/src/inflate.ts`);
        const data = dataOf(kind, n, 3);
        const z = new Uint8Array(deflateSync(data));
        return () => { const r = inflate(z, 0, { expectedSize: n, maxOutput: 128 * MIB }); if (!r.ok || r.value.out.length !== n) throw new Error('inflate'); };
      },
    };
  }
}
for (const [name, n] of [['tiny', 1], ['trees', 2], ['big', 1]]) {
  CASES[`parsePack-${name}`] = {
    iters: n,
    async setup(tree) {
      const { parsePack } = await import(`${tree}/src/packresolve.ts`);
      const { DEFAULT_LIMITS } = await import(`${tree}/src/limits.ts`);
      const pack = packFile(name);
      const limits = { ...DEFAULT_LIMITS, ...BIG_LIMITS };
      return () => { const r = parsePack(pack, { limits }); if (!r.ok) throw new Error(r.error.message); };
    },
  };
}
for (const [kind, sz] of [['text', '1m'], ['text', '64m'], ['rand', '64m']]) {
  CASES[`push-${kind}-${sz}`] = {
    iters: sz === '1m' ? 10 : 1,
    async setup(tree) {
      const objects = [{ type: 3, data: dataOf(kind, sizes[sz], 5) }];
      if (existsSync(`${tree}/src/packwrite.ts`)) {
        const { measurePack, streamPack } = await import(`${tree}/src/packwrite.ts`);
        return async () => {
          const m = await measurePack(objects);
          const reader = streamPack(m, new Uint8Array(0)).stream.getReader();
          let n = 0;
          for (;;) { const r = await reader.read(); if (r.done) break; n += r.value.length; }
          if (n !== m.bytes) throw new Error('push length');
        };
      }
      const { buildPack } = await import(`${tree}/src/pack.ts`);
      return async () => { await buildPack(objects); };
    },
  };
}

// SHA-1 alone (#214): one 1 MiB buffer, and hashObject over 2,000 4 KiB trees (an object id per fetched object)
CASES['sha1-1m'] = {
  iters: 50,
  async setup(tree) {
    const { Sha1 } = await import(`${tree}/src/sha1.ts`);
    const data = dataOf('rand', MIB, 9);
    return () => { new Sha1().update(data).hex(); };
  },
};
CASES['hashObject-trees'] = {
  iters: 20,
  async setup(tree) {
    const { hashObject } = await import(`${tree}/src/objects.ts`);
    const trees = Array.from({ length: 2000 }, (_, i) => treeBytes(4 * KIB, i + 1));
    return () => { for (const t of trees) hashObject('tree', t); };
  },
};

// ---- child: one case on one tree ----
async function child() {
  const tree = resolve(opt('tree', '.'));
  const c = CASES[opt('case', '')];
  const op = await c.setup(tree);
  await op(); // warm-up
  globalThis.gc();
  await new Promise((r) => setTimeout(r, 200));
  const peak = new BigInt64Array(new SharedArrayBuffer(16));
  const base = process.memoryUsage.rss();
  // the sampler: the largest resident size seen until slot 1 says stop
  const sampler = new Worker(`const { workerData: p, parentPort } = require('node:worker_threads');
    parentPort.postMessage('up');
    while (Atomics.load(p, 1) === 0n) { const r = BigInt(process.memoryUsage.rss()); if (r > Atomics.load(p, 0)) Atomics.store(p, 0, r); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); }`, { eval: true, workerData: peak });
  await new Promise((r) => sampler.once('message', r));
  await op(); // the memory sample
  Atomics.store(peak, 1, 1n);
  await new Promise((r) => sampler.once('exit', r));
  const rssPeak = Math.max(Number(peak[0]), process.memoryUsage.rss());
  const n = c.iters;
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await op(); // oxlint-disable-line no-await-in-loop -- timed in sequence
  const cpu = process.cpuUsage(c0);
  const wall = performance.now() - t0;
  process.stdout.write(`${JSON.stringify({ cpu: (cpu.user + cpu.system) / 1000 / n, wall: wall / n, rss: rssPeak - base })}\n`);
}

// ---- parent: every case × tree × run, interleaved ----
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function parent() {
  const trees = opts('tree').map((t) => resolve(t));
  if (trees.length === 0) trees.push(resolve('.'));
  const runs = Number(opt('runs', '5'));
  const only = opt('case', '');
  const names = Object.keys(CASES).filter((k) => k.includes(only));
  for (const name of names.filter((k) => k.startsWith('parsePack-'))) packFile(name.slice('parsePack-'.length));
  const res = new Map();
  for (let r = 0; r < runs; r++) {
    for (const name of names) {
      for (const tree of trees) {
        const p = spawnSync(process.execPath, ['--expose-gc', '--import', `${tree}/test/ts-resolve.mjs`, import.meta.filename, '--child', '--tree', tree, '--case', name], { encoding: 'utf8', maxBuffer: 1 << 20 });
        if (p.status !== 0) throw new Error(`${name} on ${tree}: ${p.stderr}`);
        const key = `${name}\t${tree}`;
        res.set(key, [...(res.get(key) ?? []), JSON.parse(p.stdout)]);
      }
    }
  }
  const load = loadavg().map((x) => x.toFixed(2)).join(' ');
  console.log(`load after: ${load}; ${runs} runs; cpu ms per op: median [min–max]; rss+ MiB median`);
  for (const name of names) {
    for (const tree of trees) {
      const xs = res.get(`${name}\t${tree}`);
      const cpu = xs.map((x) => x.cpu);
      console.log(`${name.padEnd(20)} ${tree.split('/').pop().padEnd(14)} ${median(cpu).toFixed(2).padStart(9)} [${Math.min(...cpu).toFixed(2)}–${Math.max(...cpu).toFixed(2)}]  wall ${median(xs.map((x) => x.wall)).toFixed(2)}  rss+ ${(median(xs.map((x) => x.rss)) / MIB).toFixed(1)}`);
    }
  }
}

if (argv.includes('--child')) await child();
else parent();
