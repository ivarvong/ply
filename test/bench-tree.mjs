// CPU and allocation of parseTree over real trees: every tree of a repository at a pinned commit, parsed as a read
// does. Each run is its own node process (a fresh heap), and the trees under comparison are run interleaved, so a load
// change on the machine hits all of them alike.
//   node test/bench-tree.mjs [--runs 7] [--corpus <repo>@<rev> ...] [--tree <dir> ...] [--op parse|fetched]
// A corpus is every tree object `git ls-tree -r -t <rev>` names plus the root, read with `git cat-file --batch` from a
// local clone and cached in the temp dir; the default is this checkout at HEAD. A tree is any ply checkout (an older
// commit's worktree too), whose src/ is imported through its own ts-resolve.
//   parse    parseTree(data) of every tree, once per pass
//   fetched  what a read pays per fetched tree: assertFetched(data) then parseTree(data) (before #2), or the parse
//            assertFetched hands over (after it), whichever the tree exports (`checkFetched`)
// Per run: CPU (process.cpuUsage, user + system) per pass after warm-up passes, reported as ns per entry; and bytes
// allocated per entry, read as the heap growth over one pass under a young generation large enough that no GC runs
// in it (the run says so if one did: then the number is a lower bound and is printed with `gc!`).
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { PerformanceObserver } from 'node:perf_hooks';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const opts = (k) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []));

// ---- the corpus: [u32 length][bytes]... of every tree at <repo>@<rev> ----
function corpusFile(spec) {
  const at = spec.lastIndexOf('@');
  const repo = resolve(at < 0 ? spec : spec.slice(0, at));
  const rev = at < 0 ? 'HEAD' : spec.slice(at + 1);
  const git = (args, input) => {
    const p = spawnSync('git', ['-C', repo, ...args], { input, maxBuffer: 1 << 30 });
    if (p.status !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr}`);
    return p.stdout;
  };
  const sha = git(['rev-parse', `${rev}^{commit}`]).toString().trim();
  const dir = join(tmpdir(), 'ply-bench-tree');
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${basename(repo)}-${sha.slice(0, 12)}.trees`);
  if (existsSync(f)) return { file: f, name: `${basename(repo)}@${sha.slice(0, 7)}` };
  const root = git(['rev-parse', `${sha}^{tree}`]).toString().trim();
  const oids = [root, ...git(['ls-tree', '-r', '-t', sha]).toString().split('\n').filter((l) => l.startsWith('040000 tree ')).map((l) => l.slice(12, 52))];
  const out = git(['cat-file', '--batch'], `${oids.join('\n')}\n`);
  const parts = [];
  let p = 0;
  while (p < out.length) {
    const nl = out.indexOf(10, p);
    const [, type, size] = out.subarray(p, nl).toString().split(' ');
    if (type !== 'tree') throw new Error(`not a tree: ${out.subarray(p, nl)}`);
    const n = Number(size);
    const len = Buffer.alloc(4); len.writeUInt32BE(n);
    parts.push(len, out.subarray(nl + 1, nl + 1 + n));
    p = nl + 1 + n + 1;
  }
  writeFileSync(f, Buffer.concat(parts));
  return { file: f, name: `${basename(repo)}@${sha.slice(0, 7)}` };
}
function readCorpus(file) {
  const b = readFileSync(file);
  const trees = [];
  for (let p = 0; p < b.length;) { const n = b.readUInt32BE(p); trees.push(new Uint8Array(b.subarray(p + 4, p + 4 + n))); p += 4 + n; }
  return trees;
}

// ---- child: one op over one corpus on one tree ----
async function child() {
  const tree = resolve(opt('tree', '.'));
  const op = opt('op', 'parse');
  const trees = readCorpus(opt('file', ''));
  const { parseTree, assertFetched } = await import(`${tree}/src/objects.ts`);
  const objects = await import(`${tree}/src/objects.ts`);
  let entries = 0;
  for (const t of trees) { const r = parseTree(t); if (!r.ok) throw new Error(r.error.message); entries += r.value.length; }
  let sink = 0;
  const pass = op === 'parse'
    ? () => { for (const t of trees) sink += parseTree(t).value.length; }
    // after #2 the fetch path keeps assertFetched's parse (checkFetched returns it); before, the reader parsed again
    : typeof objects.checkFetched === 'function'
      ? () => { for (const t of trees) sink += objects.checkFetched('tree', t).value.tree.length; }
      : () => { for (const t of trees) { if (!assertFetched('tree', t).ok) throw new Error('tree'); sink += parseTree(t).value.length; } };
  for (let i = 0; i < 5; i++) pass(); // warm-up: every function optimized
  // allocation: one pass between two full GCs, no GC inside it (counted)
  let gcs = 0;
  const obs = new PerformanceObserver((l) => { gcs += l.getEntries().length; });
  obs.observe({ entryTypes: ['gc'] });
  globalThis.gc();
  await new Promise((r) => setTimeout(r, 50));
  gcs = 0;
  const h0 = process.memoryUsage().heapUsed;
  pass();
  const h1 = process.memoryUsage().heapUsed;
  await new Promise((r) => setTimeout(r, 50));
  const allocGcs = gcs;
  obs.disconnect();
  const passes = Number(opt('passes', '20'));
  const c0 = process.cpuUsage();
  for (let i = 0; i < passes; i++) pass();
  const cpu = process.cpuUsage(c0);
  process.stdout.write(`${JSON.stringify({ ns: ((cpu.user + cpu.system) * 1000) / passes / entries, bytes: (h1 - h0) / entries, gcs: allocGcs, entries, trees: trees.length, sink })}\n`);
}

// ---- parent: every corpus × op × tree × run, interleaved ----
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function parent() {
  const trees = opts('tree').map((t) => resolve(t));
  if (trees.length === 0) trees.push(resolve('.'));
  const corpora = (opts('corpus').length ? opts('corpus') : ['.']).map(corpusFile);
  const ops = opts('op').length ? opts('op') : ['parse'];
  const runs = Number(opt('runs', '7'));
  const passes = opt('passes', '20');
  const res = new Map();
  for (let r = 0; r < runs; r++) {
    for (const c of corpora) {
      for (const op of ops) {
        for (const tree of trees) {
          const p = spawnSync(process.execPath, ['--expose-gc', '--max-semi-space-size=512', '--min-semi-space-size=512', '--import', `${tree}/test/ts-resolve.mjs`, import.meta.filename, '--child', '--tree', tree, '--file', c.file, '--op', op, '--passes', passes], { encoding: 'utf8', maxBuffer: 1 << 20 });
          if (p.status !== 0) throw new Error(`${c.name} ${op} on ${tree}: ${p.stderr}`);
          const key = `${c.name}\t${op}\t${tree}`;
          res.set(key, [...(res.get(key) ?? []), JSON.parse(p.stdout)]);
        }
      }
    }
  }
  console.log(`node ${process.version}; load after ${loadavg().map((x) => x.toFixed(2)).join(' ')}; ${runs} runs × ${passes} passes; ns/entry median [min–max]; B/entry allocated (median)`);
  for (const c of corpora) {
    for (const op of ops) {
      for (const tree of trees) {
        const xs = res.get(`${c.name}\t${op}\t${tree}`);
        const ns = xs.map((x) => x.ns);
        const gc = xs.some((x) => x.gcs > 0) ? ' gc!' : '';
        console.log(`${c.name.padEnd(22)} ${op.padEnd(8)} ${tree.split('/').pop().padEnd(18)} ${xs[0].trees} trees ${xs[0].entries} entries  ${median(ns).toFixed(1).padStart(7)} ns [${Math.min(...ns).toFixed(1)}–${Math.max(...ns).toFixed(1)}]  ${median(xs.map((x) => x.bytes)).toFixed(0).padStart(5)} B${gc}`);
      }
    }
  }
}

if (argv.includes('--child')) await child();
else parent();
