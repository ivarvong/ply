// Sweep driver. `npm run sweep` (and `--ci`) runs the cells at or under 16 MiB and 65_536 entries.
// `npm run sweep -- --full` runs the rest as well: the nightly workflow does that.
// Each cell is a fresh node process, once on the default heap and once with --max-old-space-size=128; a workerd cell
// is one fresh workerd process instead (heap 'workerd'). Wire cells reach git through shim.mjs (slow, v0/v1, re-framed).
// Cells that push, edit, or merge copy the bare repo first and the parent deletes the copy.
// A result that is not the desired one fails the run unless test/sweep/ratchet.json records it. A recorded
// break that now matches the desired result fails too: the ratchet only goes down, by deleting the line.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LIMITS, LIMIT_OBJECT_OVERHEAD } from '../../src/limits.js';
import { startGitServer } from '../server.js';
import { ensureFixtures } from './fixtures.mjs';
import { allCells, selectCells } from './matrix.mjs';
import { startShim } from './shim.mjs';
import { build as buildWorker } from '../workerd/build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const HOOK = join(ROOT, 'test', 'ts-resolve.mjs');
const CELL = join(HERE, 'cell.mjs');
const RATCHET_PATH = join(HERE, 'ratchet.json');
const HEAP_FLAG = 128;
const TIMEOUT_MS = Number(process.env.SWEEP_TIMEOUT_MS ?? 240_000);
const PAR = Math.max(1, Number(process.env.SWEEP_PAR ?? 2));
const WORKERD = [process.env.WORKERD, join(ROOT, 'node_modules', '.bin', 'workerd')].filter(Boolean).find(p => existsSync(p)) ?? null;

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
  process.stdout.write(`${selected.length} cells (${selected.reduce((n, c) => n + (c.runtime === 'workerd' ? 1 : 2), 0)} runs)\n`);
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

/** @param {Uint8Array | string} data */
const pkt = data => {
  const b = Buffer.from(data);
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]);
};

// git's upload-pack, asked the cell's fetch directly: the lines of each section it answers before the packfile.
/** @param {string} url @param {{ wants: string[], haves?: string[], deepen?: number, done?: boolean, filter?: string }} req */
async function gitSections(url, req) {
  const lines = [pkt('command=fetch\n'), Buffer.from('0001'), ...req.wants.map(w => pkt(`want ${w}\n`)), ...(req.haves ?? []).map(h => pkt(`have ${h}\n`))];
  if (req.filter) lines.push(pkt(`filter ${req.filter}\n`));
  if (req.deepen) lines.push(pkt(`deepen ${req.deepen}\n`));
  if (req.done !== false) lines.push(pkt('done\n'));
  lines.push(Buffer.from('0000'));
  const res = await fetch(`${url}/git-upload-pack`, { method: 'POST', body: Buffer.concat(lines), headers: { 'Git-Protocol': 'version=2', 'Content-Type': 'application/x-git-upload-pack-request' } });
  const body = Buffer.from(await res.arrayBuffer());
  /** @type {Record<string, number>} */
  const counts = {};
  let section = null;
  for (let p = 0; p + 4 <= body.length;) {
    const len = parseInt(body.subarray(p, p + 4).toString(), 16);
    if (len < 4) { p += 4; if (len === 1) section = null; if (len === 0) break; continue; }
    const line = body.subarray(p + 4, p + len).toString().replace(/\n$/, '');
    p += len;
    if (section === null) { section = line; if (line === 'packfile') break; counts[line] = 0; continue; }
    counts[section] += 1;
  }
  return counts;
}

/** @param {string} repo @param {string} rev */
const revParse = (repo, rev) => gitText(repo, ['rev-parse', rev]);

/**
 * @param {import('./matrix.mjs').Cell} cell
 * @param {{ wires: Record<string, number>, chains: Record<string, number>, sums: Record<string, { inflated: number, objects: number }>, deltaMax: Record<string, number> }} oracle
 * @param {{ root: string, server: string, shim: string }} ctx
 */
async function decorate(cell, oracle, ctx) {
  const next = { ...cell, limits: cell.limits ? { ...cell.limits } : undefined, expect: cell.expect ? { ...cell.expect } : undefined };
  const repoDir = cell.repo ? join(ctx.root, `${cell.repo}.git`) : null;
  const refusedAs = (/** @type {Record<string, unknown>} */ spec) => ({ status: 'refused', code: 'limit_exceeded', ...spec });
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
  } else if (cell.expectFrom === 'charged') {
    // what parsePack charges: verify-pack's inflated sum plus LIMIT_OBJECT_OVERHEAD per object it lists
    const m = oracle.sums?.[cell.pack];
    if (!m) throw new Error(`${cell.id}: no verify-pack sum for ${cell.pack}`);
    const charged = m.inflated + m.objects * LIMIT_OBJECT_OVERHEAD;
    const cap = cell.limits?.maxInflatedTotal ?? DEFAULT_LIMITS.maxInflatedTotal;
    next.inflated = charged;
    next.expect = charged > cap ? { status: 'refused', code: 'limit_exceeded', what: 'pack inflated bytes' } : { status: 'ok' };
  } else if (cell.expectFrom === 'objects') {
    // verify-pack's object count is the boundary; capDelta sets the cap beside it
    const count = oracle.sums?.[cell.pack]?.objects;
    if (typeof count !== 'number') throw new Error(`${cell.id}: no verify-pack count for ${cell.pack}`);
    if (typeof cell.capDelta === 'number') next.limits = { ...cell.limits, maxPackObjects: count + cell.capDelta };
    const cap = next.limits?.maxPackObjects ?? DEFAULT_LIMITS.maxPackObjects;
    next.objects = count;
    next.expect = count > cap ? refusedAs({ what: 'pack objects', got: count, max: cap }) : { status: 'ok' };
  } else if (cell.expectFrom === 'delta-result') {
    const R = oracle.deltaMax?.[cell.pack];
    if (typeof R !== 'number' || R <= 0) throw new Error(`${cell.id}: no delta in ${cell.pack}`);
    next.limits = { ...cell.limits, maxDeltaResult: R + (cell.capDelta ?? 0) };
    next.deltaMax = R;
    next.expect = R > next.limits.maxDeltaResult ? refusedAs({ what: 'delta result size', got: R }) : { status: 'ok' };
  } else if (cell.expectFrom === 'harvest') {
    // what a full window of this repository holds in commits and trees, by git's sizes
    let sum = 0;
    for (const line of gitText(repoDir, ['cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectsize)']).split('\n')) {
      const [type, size] = line.split(' ');
      if (type === 'commit' || type === 'tree') sum += Number(size);
    }
    next.limits = { ...cell.limits, maxHarvestBytes: sum + (cell.capDelta ?? 0) };
    next.harvest = sum;
    next.expect = { status: 'ok' };
  } else if (cell.expectFrom === 'sections') {
    const revs = gitText(repoDir, ['rev-list', 'main']).split('\n');
    next.wants = cell.wantCount ? revs.slice(0, cell.wantCount) : [revs[0]];
    next.haves = cell.haveCount ? revs.slice(1, 1 + cell.haveCount) : [];
    const counts = await gitSections(`${ctx.server}/${cell.repo}.git`, { wants: next.wants, haves: next.haves, deepen: cell.deepen, done: cell.done, filter: cell.filter });
    const cap = cell.limits?.maxSectionLines ?? DEFAULT_LIMITS.maxSectionLines;
    next.gitSections = counts;
    const acks = counts.acknowledgments ?? 0;
    const shallow = counts['shallow-info'] ?? 0;
    if (acks > cap) next.expect = refusedAs({ what: 'acknowledgment lines', got: cap + 1, max: cap });
    else if (shallow > cap) next.expect = refusedAs({ what: 'shallow-info lines', got: cap + 1, max: cap });
    else next.expect = { status: 'ok' };
  } else if (cell.expectFrom === 'git-clone') {
    // git's client through the same shim URL: what it accepts, ply accepts
    const dest = join(ctx.root, `clone-${cell.id.replace(/[^a-zA-Z0-9]+/g, '_')}`);
    rmSync(dest, { recursive: true, force: true });
    // async: the shim and the server answering this clone run in this process
    const r = await new Promise(resolve => {
      const child = spawn('git', ['-c', 'protocol.version=2', 'clone', '-q', '--bare', `${ctx.shim}/~${cell.shim}/${cell.repo}.git`, dest], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      let stderr = '';
      child.stderr.on('data', d => { stderr += d; });
      child.on('close', status => resolve({ status, stderr }));
    });
    rmSync(dest, { recursive: true, force: true });
    next.gitClone = r.status === 0 ? 'ok' : r.stderr.trim().split('\n').at(-1)?.slice(0, 200) ?? `exit ${r.status}`;
    next.expect = r.status === 0 ? { status: 'ok' } : { status: 'refused', code: 'protocol' };
  } else if (cell.expectFrom === 'thin' || cell.expectFrom === 'thin-missing') {
    const remote = join(ctx.root, 'thin-remote.git');
    next.wants = [revParse(repoDir, 'main')];
    next.haves = [revParse(remote, 'main')];
    const list = gitText(repoDir, ['rev-list', '--objects', 'main', `^${next.haves[0]}`]).split('\n').map(l => l.slice(0, 40)).sort();
    const hash = createHash('sha1');
    for (const oid of list) hash.update(oid);
    next.thinOids = hash.digest('hex');
    if (cell.expectFrom === 'thin') next.expect = { status: 'ok' };
  } else if (cell.expectFrom === 'inflated-at' || cell.expectFrom === 'inflated-under') {
    // the aggregate is the inflated sum plus LIMIT_OBJECT_OVERHEAD per object (#142)
    const m = oracle.sums?.[cell.pack];
    if (!m) throw new Error(`${cell.id}: inflated sum was not measured`);
    const sum = m.inflated + m.objects * LIMIT_OBJECT_OVERHEAD;
    const max = cell.expectFrom === 'inflated-at' ? sum : sum - 1;
    next.limits = { ...cell.limits, maxInflatedTotal: max };
    next.expect = cell.expectFrom === 'inflated-under'
      ? { status: 'refused', code: 'limit_exceeded', what: 'pack inflated bytes' }
      : { status: 'ok' };
    next.inflated = sum;
  }
  if (cell.local) next.localDir = join(ctx.root, `${cell.local}.git`);
  if (cell.store) next.storeDir = join(ctx.root, `${cell.store}.git`);
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
    if (typeof cell.objects === 'number' && result.n !== cell.objects) return `pack objects: ply ${result.n}, verify-pack ${cell.objects}`;
    if (typeof cell.chain !== 'number') return null;
    return result.maxChain === cell.chain ? null : `pack chain: ply ${result.maxChain}, verify-pack ${cell.chain}`;
  }
  if (cell.op === 'fetchPack') {
    const g = cell.gitSections ?? {};
    // git's acknowledgments section is the ACKs then `ready`; ply reports the ACKs and the ready flag
    const acks = Math.max(0, (g.acknowledgments ?? 0) - (result.ready ? 1 : 0));
    const shallow = g['shallow-info'] ?? 0;
    return result.acks === acks && result.shallow === shallow ? null : `sections: ply acks ${result.acks} shallow ${result.shallow}, git ${JSON.stringify(g)}`;
  }
  if (cell.op === 'fetchThin') {
    if (result.refDelta < 1) return `thin fetch: no REF_DELTA in the pack, the external path was not exercised`;
    return result.oidsHash === cell.thinOids ? null : `thin fetch: ply objects ${result.n} differ from git rev-list --objects`;
  }
  if (cell.op === 'pushRepo') {
    const heads = (/** @type {string} */ dir) => gitText(dir, ['for-each-ref', '--format=%(refname) %(objectname)', ...(cell.spec?.all ? ['refs/heads/'] : ['refs/heads/main'])]);
    const local = heads(cell.localDir);
    const remote = heads(repoDir);
    if (local !== remote) return `pushRepo: remote refs differ from local (${remote.split('\n').length} vs ${local.split('\n').length})`;
    if (cell.thin === true && !(result.thinDeltas > 0)) return 'pushRepo thin: no delta against the remote was sent';
    const fsck = execFileSync('git', ['-C', repoDir, 'fsck', '--strict', '--no-dangling'], { encoding: 'utf8' });
    return fsck.trim() === '' ? null : `fsck: ${fsck.trim().slice(0, 200)}`;
  }
  if (cell.op === 'rebase') {
    const count = Number(gitText(repoDir, ['rev-list', '--count', 'main..feat']));
    const onMain = spawnSync('git', ['-C', repoDir, 'merge-base', '--is-ancestor', 'main', 'feat']).status === 0;
    if (count !== cell.rebased || !onMain) return `rebase: git sees ${count} commits main..feat (want ${cell.rebased}), main ${onMain ? 'is' : 'is not'} an ancestor of feat`;
    const fsck = execFileSync('git', ['-C', repoDir, 'fsck', '--strict', '--no-dangling'], { encoding: 'utf8' });
    return fsck.trim() === '' ? null : `fsck: ${fsck.trim().slice(0, 200)}`;
  }
  if (cell.op === 'editFile' || cell.op === 'pushTree') {
    const fsck = execFileSync('git', ['-C', repoDir, 'fsck', '--strict', '--no-dangling'], { encoding: 'utf8' });
    return fsck.trim() === '' ? null : `fsck: ${fsck.trim().slice(0, 200)}`;
  }
  return null;
}

/** @param {number} pid */
function procCost(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const hwm = Number(/VmHWM:\s+(\d+)/.exec(status)?.[1] ?? 0);
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // utime and stime are fields 14 and 15 of /proc/pid/stat, in clock ticks (100 per second on Linux)
    const ticks = Number(fields[11]) + Number(fields[12]);
    return { rssPeakMB: Math.round(hwm / 1024), cpuMs: ticks * 10 };
  } catch {
    return { rssPeakMB: null, cpuMs: null };
  }
}

let wdPort = 19100 + (process.pid % 200) * 4;
/** @type {{ dir: string, config: string } | null} */
let wdBuild = null;

// A workerd cell: a fresh workerd process serving test/workerd/worker.mjs, one POST /sweep, then its peak RSS (VmHWM)
// and CPU from /proc before it is killed. Those are the isolate's cost: the process holds nothing else.
/** @param {Record<string, unknown>} payload */
async function runWorkerd(payload) {
  if (!WORKERD) return { status: 'crash', code: null, msg: 'workerd not found (node_modules/.bin/workerd or $WORKERD)' };
  if (!wdBuild) throw new Error('workerd bundle was not built');
  const port = wdPort++;
  const config = join(wdBuild.dir, `config-${port}.capnp`);
  writeFileSync(config, wdBuild.config.replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${port}`));
  const child = spawn(WORKERD, ['serve', config], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', d => { err = (err + d).slice(-2000); });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try { up = (await fetch(`${base}/ping`)).ok; } catch { await new Promise(r => setTimeout(r, 50)); }
    }
    if (!up) return { status: 'crash', code: null, msg: `workerd did not answer: ${err.slice(-300)}` };
    const t0 = performance.now();
    const res = await fetch(`${base}/sweep`, { method: 'POST', body: JSON.stringify(payload), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const out = /** @type {Record<string, unknown>} */ (await res.json());
    return { ...out, ms: Math.round(performance.now() - t0), ...procCost(child.pid ?? 0) };
  } catch (e) {
    return { status: 'crash', code: null, msg: `workerd: ${e instanceof Error ? e.message : String(e)} ${err.slice(-300)}` };
  } finally {
    child.kill('SIGKILL');
    rmSync(config, { force: true });
  }
}

/** @param {any} cell @param {string} origin @param {string} shimOrigin @param {string} root */
function urlOf(cell, repoName, origin, shimOrigin) {
  if (!repoName) return null;
  return cell.shim ? `${shimOrigin}/~${cell.shim}/${repoName}.git` : `${origin}/${repoName}.git`;
}

/**
 * @param {Awaited<ReturnType<typeof decorate>>} cell
 * @param {'default' | '128' | 'workerd'} heap
 * @param {{ server: string, shim: string }} origins
 * @param {string} root
 */
function runOne(cell, heap, origins, root) {
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
      url: urlOf(cell, repoName, origins.server, origins.shim),
      pack: cell.pack ? join(root, 'packs', `${cell.pack}.pack`) : null,
      local: cell.localDir ?? null,
      store: cell.storeDir ?? null,
    };
    if (heap === 'workerd') {
      runWorkerd(payload).then(result => finish(result));
      return;
    }
    const args = ['--import', HOOK];
    if (heap === '128') args.push(`--max-old-space-size=${HEAP_FLAG}`);
    args.push(CELL, JSON.stringify(payload));
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    const limit = cell.timeoutMs ?? TIMEOUT_MS;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, limit);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err = (err + d).slice(-4000); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      /** @type {Record<string, any>} */
      let result;
      const line = out.trim().split('\n').filter(Boolean).at(-1);
      let parsed = null;
      if (line) {
        try { parsed = JSON.parse(line); } catch { parsed = null; }
      }
      const oom = /JavaScript heap out of memory|Allocation failed|heap limit/i.test(err);
      if (timedOut) result = { status: 'hang', code: null, msg: `killed after ${limit}ms` };
      else if (parsed && !oom) result = parsed;
      else if (oom) result = { status: 'oom', code: null, msg: err.trim().split('\n').at(-1) ?? 'oom' };
      else result = { status: 'crash', code: null, msg: `exit ${code} signal ${signal}: ${(line ?? err).slice(0, 300)}` };
      finish(result);
    });
    /** @param {Record<string, any>} result */
    function finish(result) {
      // Merge-base is read on the untouched fixture. A merge writes a merge commit into the copy, and
      // merge-base on that copy is a different question. edit and push are judged by fsck of the copy.
      const oracleDir = ['editFile', 'pushTree', 'pushRepo', 'rebase'].includes(cell.op) ? copyDir : (cell.repo ? join(root, `${cell.repo}.git`) : null);
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
    }
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
const server = await startGitServer(fixtureRoot);
const shim = await startShim(server.url);
/** @type {Awaited<ReturnType<typeof decorate>>[]} */
const cells = [];
for (const cell of selected) cells.push(await decorate(cell, oracle, { root: fixtureRoot, server: server.url, shim: shim.url }));
if (WORKERD && cells.some(c => c.runtime === 'workerd')) {
  const dir = join(fixtureRoot, 'wd');
  const config = buildWorker({ port: 0, outDir: dir });
  wdBuild = { dir, config: readFileSync(config, 'utf8') };
}
/** @type {Record<string, unknown>[]} */
const results = [];
let done = 0;
const jobs = cells.flatMap(cell => (cell.runtime === 'workerd' ? ['workerd'] : ['default', '128']).map(heap => ({ cell, heap })));
try {
  await pool(jobs, PAR, async ({ cell, heap }) => {
    const result = await runOne(cell, heap, { server: server.url, shim: shim.url }, fixtureRoot);
    results.push(result);
    done += 1;
    process.stderr.write(`[${done}/${jobs.length}] ${heap} ${cell.id} ${result.status}${result.code ? ` ${result.code}` : ''} rss ${result.rssPeakMB ?? '-'}MB\n`);
  });
} finally {
  await shim.close();
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
