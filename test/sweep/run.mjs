// Sweep driver. `npm run sweep` (and `--ci`) runs the cells at or under 16 MiB and 65_536 entries.
// `npm run sweep -- --full` runs the rest as well: the nightly workflow does that.
// Each cell is a fresh node process, once on the default heap and once with --max-old-space-size=128.
// Cells that push, edit, or merge copy the bare repo first and the parent deletes the copy.
// A result that is not the desired one fails the run unless test/sweep/ratchet.json records it. A recorded
// break that now matches the desired result fails too: the ratchet only goes down, by deleting the line.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LIMITS } from '../../src/limits.js';
import { startGitServer } from '../server.js';
import { ensureFixtures } from './fixtures.mjs';
import { allCells, selectCells } from './matrix.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const HOOK = join(ROOT, 'test', 'ts-resolve.mjs');
const CELL = join(HERE, 'cell.mjs');
const RATCHET_PATH = join(HERE, 'ratchet.json');
const HEAP_FLAG = 128;
const TIMEOUT_MS = Number(process.env.SWEEP_TIMEOUT_MS ?? 240_000);
const PAR = Math.max(1, Number(process.env.SWEEP_PAR ?? 2));

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

if (flag('--ci') && flag('--full')) {
  process.stderr.write('pass one of --ci or --full\n');
  process.exit(2);
}
const full = flag('--full');
const filter = option('--filter');
const outDir = option('--out') ?? join(ROOT, 'reports', 'sweep');
const listOnly = flag('--list');

const selected = selectCells({ ci: full ? false : true, full, filter });
if (listOnly) {
  process.stdout.write(`${selected.length} cells (${selected.length * 2} with both heaps)\n`);
  for (const cell of selected) process.stdout.write(`${cell.id}\n`);
  process.exit(0);
}

/** @param {Record<string, unknown>} view @param {Record<string, unknown>} spec */
function covers(view, spec) {
  return Object.entries(spec).every(([key, value]) => view[key] === value);
}

/** @param {Record<string, unknown>} result */
function viewOf(result) {
  /** @type {Record<string, unknown>} */
  const view = { status: result.status };
  for (const key of ['code', 'what', 'got', 'max']) if (result[key] != null) view[key] = result[key];
  return view;
}

/** @param {import('./matrix.mjs').Cell} cell @param {{ wires: Record<string, number>, chains: Record<string, number>, inflated: number }} oracle */
function decorate(cell, oracle) {
  const next = { ...cell, limits: cell.limits ? { ...cell.limits } : undefined, expect: cell.expect ? { ...cell.expect } : undefined };
  if (cell.expectFrom === 'wire') {
    const wire = oracle.wires[cell.repo];
    if (typeof wire !== 'number') throw new Error(`${cell.id}: no wire size for ${cell.repo}`);
    const cap = cell.limits?.maxPackBytes ?? DEFAULT_LIMITS.maxPackBytes;
    next.wire = wire;
    next.expect = wire > cap
      ? { status: 'refused', code: 'limit_exceeded', what: 'pack bytes' }
      : { status: 'ok' };
  } else if (cell.expectFrom === 'chain' || cell.expectFrom === 'chain-limit') {
    const chain = oracle.chains[cell.pack];
    if (typeof chain !== 'number') throw new Error(`${cell.id}: no chain length for ${cell.pack}`);
    const cap = cell.limits?.maxDeltaChain ?? DEFAULT_LIMITS.maxDeltaChain;
    next.chain = chain;
    next.expect = chain > cap
      ? { status: 'refused', code: 'limit_exceeded', what: 'delta chain depth' }
      : { status: 'ok' };
  } else if (cell.expectFrom === 'inflated-at' || cell.expectFrom === 'inflated-under') {
    const sum = oracle.inflated;
    if (!sum) throw new Error(`${cell.id}: inflated sum was not measured`);
    const max = cell.expectFrom === 'inflated-at' ? sum : sum - 1;
    next.limits = { ...cell.limits, maxInflatedTotal: max };
    next.expect = cell.expectFrom === 'inflated-under'
      ? { status: 'refused', code: 'limit_exceeded', what: 'pack inflated bytes' }
      : { status: 'ok' };
    next.inflated = sum;
  }
  if (!next.expect) throw new Error(`${cell.id}: no expect`);
  return next;
}

/** @param {string} repo @param {string[]} args */
function gitText(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 }).trimEnd();
}

/** @param {ReturnType<typeof decorate>} cell @param {string} repoDir @param {Record<string, unknown>} result */
function checkOracle(cell, repoDir, result) {
  if (result.status !== 'ok') return null;
  if (cell.op === 'readFile') {
    const rev = `${cell.ref ?? 'main'}:${cell.path}`;
    const oid = gitText(repoDir, ['rev-parse', rev]);
    const size = Number(gitText(repoDir, ['cat-file', '-s', oid]));
    const match = result.blob === oid && result.size === size && result.len === size;
    return match ? null : `readFile ${rev}: ply ${result.blob} size ${result.size} len ${result.len}, git ${oid} size ${size}`;
  }
  if (cell.op === 'listTree') {
    const spec = cell.path ? `main:${cell.path}` : 'main';
    const text = gitText(repoDir, ['ls-tree', '--name-only', spec]);
    const n = text === '' ? 0 : text.split('\n').length;
    return result.n === n ? null : `listTree ${spec}: ply ${result.n}, git ${n}`;
  }
  if (cell.op === 'readLog') {
    const text = gitText(repoDir, ['rev-list', '--first-parent', 'main']);
    const count = text === '' ? 0 : text.split('\n').length;
    const n = Math.min(count, cell.limit);
    const truncated = count > cell.limit;
    return result.n === n && result.truncated === truncated ? null : `readLog n${cell.history} l${cell.limit}: ply ${result.n} truncated ${result.truncated}, git ${n} truncated ${truncated}`;
  }
  if (cell.op === 'lsRefs') {
    const text = gitText(repoDir, ['ls-remote', '.']);
    const n = text === '' ? 0 : text.split('\n').length;
    return result.n === n ? null : `lsRefs: ply ${result.n}, git ls-remote ${n}`;
  }
  if (cell.op === 'merge') {
    const base = gitText(repoDir, ['merge-base', 'main', 'feat']);
    return result.base === base ? null : `merge-base: ply ${result.base}, git ${base}`;
  }
  if (cell.op === 'pack') {
    if (typeof cell.chain !== 'number') return null;
    return result.maxChain === cell.chain ? null : `pack chain: ply ${result.maxChain}, verify-pack ${cell.chain}`;
  }
  if (cell.op === 'editFile' || cell.op === 'pushTree') {
    const fsck = execFileSync('git', ['-C', repoDir, 'fsck', '--strict', '--no-dangling'], { encoding: 'utf8' });
    return fsck.trim() === '' ? null : `fsck: ${fsck.trim().slice(0, 200)}`;
  }
  return null;
}

/**
 * @param {ReturnType<typeof decorate>} cell
 * @param {'default' | '128'} heap
 * @param {string} origin
 * @param {string} root
 */
function runOne(cell, heap, origin, root) {
  return new Promise(resolve => {
    let repoName = cell.repo ?? null;
    let copyDir = null;
    if (cell.writes && cell.repo) {
      repoName = `w-${cell.id.replace(/[^a-zA-Z0-9]+/g, '_')}-${heap}`;
      copyDir = join(root, `${repoName}.git`);
      rmSync(copyDir, { recursive: true, force: true });
      cpSync(join(root, `${cell.repo}.git`), copyDir, { recursive: true });
    }
    const payload = {
      ...cell,
      url: repoName ? `${origin}/${repoName}.git` : null,
      pack: cell.pack ? join(root, 'packs', `${cell.pack}.pack`) : null,
    };
    const args = ['--import', HOOK];
    if (heap === '128') args.push(`--max-old-space-size=${HEAP_FLAG}`);
    args.push(CELL, JSON.stringify(payload));
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err = (err + d).slice(-4000); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      /** @type {Record<string, unknown>} */
      let result;
      const line = out.trim().split('\n').filter(Boolean).at(-1);
      let parsed = null;
      if (line) {
        try { parsed = JSON.parse(line); } catch { parsed = null; }
      }
      const oom = /JavaScript heap out of memory|Allocation failed|heap limit/i.test(err);
      if (timedOut) result = { status: 'hang', code: null, msg: `killed after ${TIMEOUT_MS}ms` };
      else if (parsed && !oom) result = parsed;
      else if (oom) result = { status: 'oom', code: null, msg: err.trim().split('\n').at(-1) ?? 'oom' };
      else result = { status: 'crash', code: null, msg: `exit ${code} signal ${signal}: ${(line ?? err).slice(0, 300)}` };
      // Merge-base is read on the untouched fixture. A merge writes a merge commit into the copy, and
      // merge-base on that copy is a different question. edit and push are judged by fsck of the copy.
      const oracleDir = cell.op === 'editFile' || cell.op === 'pushTree' ? copyDir : (cell.repo ? join(root, `${cell.repo}.git`) : null);
      if (result.status === 'ok' && (cell.op === 'pack' || oracleDir)) {
        try {
          const problem = checkOracle(cell, cell.op === 'pack' ? root : oracleDir, result);
          if (problem) result.oracle = problem;
        } catch (e) {
          result.oracle = `oracle: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      if (copyDir) rmSync(copyDir, { recursive: true, force: true });
      result.id = cell.id;
      result.heap = heap;
      result.param = cell.param;
      result.op = cell.op;
      result.expect = cell.expect;
      resolve(result);
    });
  });
}

/** @param {unknown[]} items @param {number} n @param {(item: unknown) => Promise<void>} fn */
async function pool(items, n, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function markdown(results, failures, stale) {
  const by = new Map();
  for (const r of results) by.set(r.status, (by.get(r.status) ?? 0) + 1);
  const lines = [
    '# limit sweep',
    '',
    `${results.length} runs. ${[...by.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}.`,
    '',
  ];
  if (failures.length === 0 && stale.length === 0) lines.push('No divergence outside the ratchet.', '');
  if (failures.length) {
    lines.push('## Divergences', '', '| cell | heap | expect | actual |', '|---|---|---|---|');
    for (const f of failures) lines.push(`| \`${f.id}\` | ${f.heap} | ${JSON.stringify(f.expect)} | ${JSON.stringify(viewOf(f))} ${f.oracle ?? ''} |`);
    lines.push('');
  }
  if (stale.length) {
    lines.push('## Ratchet lines the cell no longer hits', '');
    for (const s of stale) lines.push(`- \`${s.id}\` heap ${s.heap}: delete it from test/sweep/ratchet.json`);
    lines.push('');
  }
  const ranked = [...results].sort((a, b) => (b.rssPeakMB ?? 0) - (a.rssPeakMB ?? 0)).slice(0, 20);
  lines.push('## Peak RSS (top 20)', '', '| cell | heap | status | RSS MiB | ArrayBuffers MiB | heap MiB | ms |', '|---|---|---|---:|---:|---:|---:|');
  for (const r of ranked) lines.push(`| \`${r.id}\` | ${r.heap} | ${r.status} | ${r.rssPeakMB ?? ''} | ${r.abPeakMB ?? ''} | ${r.heapPeakMB ?? ''} | ${r.ms ?? ''} |`);
  lines.push('');
  return lines.join('\n');
}

const ratchet = JSON.parse(readFileSync(RATCHET_PATH, 'utf8'));
const known = new Map(ratchet.entries.map(e => [`${e.id}\t${e.heap}`, e]));
const matrixIds = new Set(allCells().map(c => c.id));
for (const entry of ratchet.entries) {
  if (!matrixIds.has(entry.id)) {
    process.stderr.write(`ratchet names ${entry.id}, which the matrix does not build\n`);
    process.exit(1);
  }
}

const fixtureRoot = join(outDir, 'fixtures');
process.stderr.write(`sweep: ${selected.length} cells × 2 heaps, fixtures ${fixtureRoot}\n`);
const oracle = await ensureFixtures(fixtureRoot, selected);
const cells = selected.map(cell => decorate(cell, oracle));
const server = await startGitServer(fixtureRoot);
/** @type {Record<string, unknown>[]} */
const results = [];
let done = 0;
const jobs = cells.flatMap(cell => ['default', '128'].map(heap => ({ cell, heap })));
try {
  await pool(jobs, PAR, async ({ cell, heap }) => {
    const result = await runOne(cell, heap, server.url, fixtureRoot);
    results.push(result);
    done += 1;
    process.stderr.write(`[${done}/${jobs.length}] ${heap} ${cell.id} ${result.status}${result.code ? ` ${result.code}` : ''} rss ${result.rssPeakMB ?? '-'}MB\n`);
  });
} finally {
  await server.close();
}

const failures = [];
const stale = [];
const ratcheted = [];
for (const result of results) {
  const key = `${result.id}\t${result.heap}`;
  const entry = known.get(key);
  const view = viewOf(result);
  const matched = covers(view, result.expect);
  if (result.oracle) failures.push(result);
  else if (matched && entry) stale.push(result);
  else if (!matched && entry && covers(view, entry.actual)) ratcheted.push(result);
  else if (!matched) failures.push(result);
}
for (const entry of ratchet.entries) {
  if (!results.some(r => r.id === entry.id && r.heap === entry.heap)) continue;
  // executed above
}

mkdirSync(outDir, { recursive: true });
const jsonl = results.map(r => JSON.stringify(r)).join('\n') + '\n';
writeFileSync(join(outDir, 'results.jsonl'), jsonl);
writeFileSync(join(outDir, 'report.md'), markdown(results, failures, stale));
process.stderr.write(`report ${join(outDir, 'report.md')}\n`);
process.stderr.write(`ratchet held ${ratcheted.length}, divergences ${failures.length}, stale ${stale.length}\n`);
if (failures.length || stale.length) process.exit(1);
