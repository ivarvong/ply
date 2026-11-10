// One command for the worker-mem harness: build ply, bundle + deploy ply-memlab, run every cell N times, capture heap
// profiles under load, join each request to its Workers Observability invocation, and write reports/<run>.{json,md}.
//
//   npm run build && node bench/worker-mem/run.mjs [--runs 10] [--profiles 10] [--cells scan,read,bomb,index,pushpack]
//                                                  [--no-deploy] [--pending on] [--o11y-wait 90]
// Needs .data/seed.json from seed.mjs. See README.md.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildOutput, CPU_LIMIT_MS } from './build.mjs';
import { revokeAll, mint } from './seed.mjs';
import { DATA, REPORTS, ROOT, WORKER, HERE, NAMESPACE, cfRaw, cfJson, memlabToken, writeSecret, sleep, stamp, quantiles, redact } from './lib.mjs';

const { values: args } = parseArgs({
  options: {
    runs: { type: 'string', default: '10' },
    profiles: { type: 'string', default: '10' },
    cells: { type: 'string', default: 'scan,read,bomb,bombworker,index,pushpack' },
    'no-deploy': { type: 'boolean', default: false },
    pending: { type: 'string', default: 'off' },
    'o11y-wait': { type: 'string', default: '90' },
    url: { type: 'string', default: process.env.MEMLAB_URL ?? '' },
  },
});
const RUNS = Number(args.runs);
const PROFILES = Number(args.profiles);
const run = `ml-${stamp().toLowerCase()}`;
const seed = JSON.parse(readFileSync(join(DATA, 'seed.json'), 'utf8'));
if (seed.state !== 'seeded') throw new Error('seed repo is not seeded (run seed.mjs)');
const bearer = memlabToken();
mkdirSync(REPORTS, { recursive: true });
const log = (...a) => console.log(redact(a.join(' ')));

// The cells: route + query. bombworker is the bomb under WORKER_LIMITS.
const CELL_QUERY = {
  scan: { route: 'scan', q: { repo: seed.name, remote: seed.remote, commit: seed.head } },
  // The same scan with a heap profile captured while it runs. Reported apart: profiling adds overhead.
  scanprofiled: { route: 'scan', q: { repo: seed.name, remote: seed.remote, commit: seed.head } },
  read: { route: 'read', q: { repo: seed.name, remote: seed.remote, blob: seed.blob } },
  bomb: { route: 'bomb', q: { declared: String(1024 ** 3) } },
  bombworker: { route: 'bomb', q: { declared: String(1024 ** 3), limits: 'worker' } },
  index: { route: 'index', q: { repo: seed.name, remote: seed.remote, commit: seed.head } },
  pushpack: { route: 'pushpack', q: { repo: seed.name, remote: seed.remote } },
};

function versionsTagged(tag) {
  const listed = cfJson(['workers', 'versions', 'list', '--worker-id', WORKER, '--page', '1', '--per-page', '20']);
  const items = Array.isArray(listed) ? listed : (listed?.items ?? listed?.result ?? []);
  const hit = items.find(v => JSON.stringify(v).includes(tag));
  return hit?.id ?? null;
}

async function deploy() {
  const sh = spawnSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8' });
  if (sh.status !== 0) throw new Error(`npm run build failed: ${sh.stderr.slice(0, 400)}`);
  // The last commit that touched ply's source (src/): the harness's own commits (bench/, package.json scripts) are not ply.
  const plySha = spawnSync('git', ['log', '-1', '--format=%H', '--', 'src'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const built = await buildOutput({ pendingCells: args.pending, plySha });
  const secrets = join(DATA, 'secrets.json');
  writeSecret(secrets, JSON.stringify({ MEMLAB_TOKEN: bearer }));
  let r;
  try {
    r = cfRaw(['deploy', '--prebuilt', '--secrets-file', secrets, '--tag', run, '--message', `memlab ${run} ply ${plySha.slice(0, 12)}`], { cwd: HERE });
  } finally { rmSync(secrets, { force: true }); }
  if (r.code !== 0) throw new Error(`cf deploy failed: ${r.stderr.slice(0, 800)} ${redact(r.stdout).slice(-800)}`);
  const out = `${r.stdout}\n${r.stderr}`;
  const url = args.url || (out.match(/https:\/\/ply-memlab\.[a-z0-9-]+\.workers\.dev/) ?? [])[0];
  const version = (out.match(/Version ID:\s*([0-9a-f-]{36})/i) ?? [])[1] ?? versionsTagged(run);
  if (!url || !version) throw new Error(`deploy output had no url/version: ${redact(out).slice(-1200)}`);
  for (let i = 0; i < 60; i++) {
    const h = await fetch(`${url}/health`).catch(() => null);
    if (h && h.headers.get('x-memlab-version') === version) return { url, version, plySha, cpuLimitMs: CPU_LIMIT_MS, bundleBytes: built.bundleBytes };
    await sleep(2000);
  }
  throw new Error(`version ${version} never answered /health at ${url}`);
}

async function current() {
  const url = args.url;
  if (!url) throw new Error('--no-deploy needs --url or MEMLAB_URL');
  const h = await fetch(`${url}/health`);
  return { url, version: h.headers.get('x-memlab-version'), plySha: h.headers.get('x-memlab-ply'), cpuLimitMs: Number(h.headers.get('x-memlab-cpu-limit-ms')) || null, bundleBytes: null };
}

async function callCell(target, name, i, extra = {}) {
  const { route, q } = CELL_QUERY[name];
  const qs = new URLSearchParams({ ...q, ...extra, run, i: String(i), label: name });
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  let res;
  try {
    res = await fetch(`${target.url}/cell/${route}?${qs}`, { headers: { authorization: `Bearer ${bearer}` } });
  } catch (e) {
    return { cell: name, i, ok: false, clientError: String(e), clientMs: Date.now() - t0, startedAt };
  }
  const ray = res.headers.get('cf-ray');
  const text = await res.text().catch(e => `{"final":true,"ok":false,"clientError":${JSON.stringify(String(e))}}`);
  const lines = text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { raw: l.slice(0, 200) }; } });
  const final = lines.find(l => l.final) ?? { ok: false, truncated: true, status: res.status, tail: text.slice(-300) };
  return { ...final, cell: name, i, status: res.status, ray, clientMs: Date.now() - t0, progressLines: lines.filter(l => l.progress).length, startedAt, endedAt: new Date().toISOString() };
}

// Heap profiles: start a scan (cell `scanprofiled`), capture `cf workers versions profile --profile-type heap` while it
// runs, and record the overlap. The profiled scans go into the results under their own label.
async function profiles(target, n, results) {
  const dir = join(REPORTS, `${run}-profiles`);
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  const out = [];
  for (let k = 0; k < n; k++) {
    const scan = callCell(target, 'scanprofiled', k);
    await sleep(4000);
    const file = join(dir, `heap-${k}.pb`);
    let captured = null;
    let window = null;
    for (let attempt = 1; attempt <= 3 && !captured; attempt++) {
      const t0 = new Date().toISOString();
      const r = spawnSync('cf', ['workers', 'versions', 'profile', target.version, '--worker-id', WORKER, '--profile-type', 'heap', '--duration-ms', '10000'], { env, maxBuffer: 256 * 1024 * 1024 });
      window = { from: t0, to: new Date().toISOString(), attempt };
      if (r.status === 0 && r.stdout.length > 0) { writeFileSync(file, r.stdout); captured = file; } else { log(`profile ${k} attempt ${attempt}: ${String(r.stderr).slice(0, 200)}`); await sleep(2000); }
    }
    const s = await scan;
    results.push(s);
    const overlapped = Boolean(captured && window && s.startedAt <= window.from && (s.endedAt ?? '') >= window.to);
    out.push({ k, file: captured, window, overlapped, scan: { i: s.i, ok: s.ok, packBytes: s.packBytes, wallMs: s.wallMs, startedAt: s.startedAt, endedAt: s.endedAt, version: s.version, ray: s.ray }, ...(captured ? pprofTotals(captured) : {}) });
    log(`profile ${k}: ${captured ? 'captured' : 'failed'} overlapped=${overlapped} scan ok=${s.ok} pack=${s.packBytes}`);
  }
  return out;
}

// Totals per sample type from `go tool pprof -top` (the "of X total" line), in bytes.
function pprofTotals(file) {
  const res = {};
  const toBytes = s => {
    const m = /^([\d.]+)([kMG]?B)$/.exec(s);
    if (!m) return null;
    return Math.round(Number(m[1]) * ({ B: 1, kB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 })[m[2]]);
  };
  for (const idx of ['inuse_space', 'alloc_space', 'space']) {
    const r = spawnSync('go', ['tool', 'pprof', `-sample_index=${idx}`, '-top', '-nodecount=8', file], { encoding: 'utf8' });
    const m = /of ([\d.]+[kMG]?B) total/.exec(r.stdout ?? '');
    if (m) res[idx] = toBytes(m[1]);
    if (idx === 'alloc_space') res[`${idx}_top`] = (r.stdout ?? '').split('\n').slice(0, 14).join('\n');
  }
  return res;
}

// Every invocation of this version in the window, joined to cells by the worker's `memlab` log line (same request id).
async function o11y(target, from, to) {
  const page = offset => {
    const body = { queryId: 'ply-memlab', timeframe: { from, to }, view: 'events', limit: 2000, ...(offset ? { offset } : {}),
      parameters: { filters: [{ key: '$metadata.service', operation: 'eq', type: 'string', value: WORKER }] } };
    const r = cfRaw(['o11y', 'telemetry', 'query', '--body', JSON.stringify(body)]);
    if (r.code !== 0) throw new Error(`o11y query failed: ${r.stderr.slice(0, 300)}`);
    const d = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    return d?.events?.events ?? [];
  };
  const events = [];
  for (let offset = null, n = 0; n < 20; n++) {
    const got = page(offset);
    events.push(...got);
    if (got.length < 2000) break;
    offset = got[got.length - 1]?.$metadata?.id;
  }
  const byReq = new Map();
  for (const e of events) {
    const id = e.$metadata?.requestId ?? e.$workers?.requestId;
    if (!id) continue;
    const slot = byReq.get(id) ?? {};
    const w = e.$workers ?? {};
    if (typeof w.cpuTimeMs === 'number' || typeof w.wallTimeMs === 'number') Object.assign(slot, { cpuMs: w.cpuTimeMs, wallMs: w.wallTimeMs, outcome: w.outcome, version: w.scriptVersion?.id });
    const msg = e.source?.message ?? e.$metadata?.message ?? '';
    const src = typeof e.source === 'object' && e.source?.memlab ? e.source : null;
    const parsed = src ?? (() => { try { const j = JSON.parse(msg); return j.memlab ? j : null; } catch { return null; } })();
    if (parsed) Object.assign(slot, { cell: parsed.label, run: parsed.run, i: parsed.i });
    byReq.set(id, slot);
  }
  const rows = [...byReq.values()].filter(r => r.run === run && (!r.version || r.version === target.version));
  return { events: events.length, rows, sample: events.find(e => e.$workers?.cpuTimeMs !== undefined) ?? events[0] ?? null };
}

function summarize(target, results, telemetry, profs) {
  const cells = {};
  for (const name of new Set(results.map(r => r.cell))) {
    const rs = results.filter(r => r.cell === name);
    const tel = telemetry.rows.filter(r => r.cell === name && rs.some(x => x.i === r.i));
    cells[name] = {
      n: rs.length,
      ok: rs.filter(r => r.ok).length,
      pending: rs.filter(r => r.pending).length,
      why: rs.find(r => r.pending)?.why ?? null,
      errors: [...new Set(rs.filter(r => r.error).map(r => `${r.error.code}: ${String(r.error.message).slice(0, 160)}`))],
      workerWallMs: quantiles(rs.map(r => r.wallMs ?? r.scanMs)),
      clientMs: quantiles(rs.map(r => r.clientMs)),
      cpuMs: quantiles(tel.map(r => r.cpuMs)),
      platformWallMs: quantiles(tel.map(r => r.wallMs)),
      outcomes: tel.reduce((a, r) => ({ ...a, [r.outcome]: (a[r.outcome] ?? 0) + 1 }), {}),
      telemetryJoined: tel.length,
      packBytes: quantiles(rs.map(r => r.packBytes)),
      inflated: quantiles(rs.map(r => r.inflated)),
      objects: quantiles(rs.map(r => r.objects)),
      bytes: quantiles(rs.map(r => r.bytes)),
      maxChunk: quantiles(rs.map(r => r.maxChunk)),
    };
  }
  // cf's heap profile is allocation sampling (alloc_objects / alloc_space over the capture window), not in-use memory.
  const heap = {
    captured: profs.filter(p => p.file).length,
    overlapped: profs.filter(p => p.overlapped).map(p => p.k),
    allocatedBytesPerCapture: quantiles(profs.map(p => p.alloc_space)),
  };
  return { run, version: target.version, url: target.url, plySha: target.plySha, cpuLimitMs: target.cpuLimitMs, seed: { name: seed.name, head: seed.head, objects: seed.objects, localPackBytes: seed.localPackBytes }, cells, heap };
}

function markdown(s, profs) {
  const fmt = q => (q ? `${q.p50} / ${q.p90} / ${q.max} (n=${q.n})` : '—');
  const L = [`# ply-memlab ${s.run}`, '', `Version \`${s.version}\`, ply \`${s.plySha ?? '?'}\`, configured CPU limit ${s.cpuLimitMs ?? '?'} ms per request, seed \`${s.seed.name}\` (head ${s.seed.head?.slice(0, 12)}, ${s.seed.objects} objects, local pack ${s.seed.localPackBytes} B).`, '',
    '| cell | ok / n | CPU ms p50/p90/max | platform wall ms | in-worker wall ms | outcomes | errors |', '|---|---|---|---|---|---|---|'];
  for (const [name, c] of Object.entries(s.cells)) L.push(`| ${name} | ${c.ok} / ${c.n}${c.pending ? ` (pending: ${c.why})` : ''} | ${fmt(c.cpuMs)} | ${fmt(c.platformWallMs)} | ${fmt(c.workerWallMs)} | ${JSON.stringify(c.outcomes)} | ${c.errors.join('; ') || '—'} |`);
  L.push('', '| cell | pack bytes p50 | inflated p50 | objects p50 | max chunk p50 |', '|---|---|---|---|---|');
  for (const [name, c] of Object.entries(s.cells)) L.push(`| ${name} | ${c.packBytes?.p50 ?? c.bytes?.p50 ?? '—'} | ${c.inflated?.p50 ?? '—'} | ${c.objects?.p50 ?? '—'} | ${c.maxChunk?.p50 ?? '—'} |`);
  L.push('', `Heap profiles (version \`${s.version}\`, each during a \`scanprofiled\` run): ${s.heap.captured}/${profs.length} captured, overlapping runs ${JSON.stringify(s.heap.overlapped)}; bytes allocated per 10 s capture (allocation sampling, not in-use memory) ${fmt(s.heap.allocatedBytesPerCapture)}.`);
  if (s.relay) L.push('', `pushpack destination \`${s.relay.dst}\`: verify ${JSON.stringify(s.relay.verify)}; cleanup ${JSON.stringify(s.relay.cleanup)}.`);
  const top = profs.find(p => p.alloc_space_top);
  if (top) L.push('', '```', top.alloc_space_top, '```');
  return `${L.join('\n')}\n`;
}

// pushpack: a throwaway destination repo, one relay request per seed commit (in order), then a stock git clone of the
// destination with fsck --strict, then the repo and every token on it are removed.
function createDst() {
  const name = `ply-memlab-dst-${run}`;
  const c = cfJson(['artifacts', 'namespaces', 'repos', 'create', NAMESPACE, '--name', name, '--default-branch', 'main', '--description', 'ply bench/worker-mem pushpack destination (deleted after the run)']);
  const remote = c.remote ?? c.result?.remote;
  if (!/^https:\/\/[a-z0-9]+\.artifacts\.cloudflare\.net\/git\//.test(remote ?? '')) throw new Error('dst create returned no remote');
  revokeAll(name);
  return { name, remote };
}

function verifyDst(dst) {
  const t = mint(dst.name, 'read', 1800);
  const auth = join(DATA, 'verify-auth.gitconfig');
  writeSecret(auth, `[http]\n\textraHeader = Authorization: Basic ${Buffer.from(`x:${t.token}`).toString('base64')}\n`);
  const dir = join(DATA, 'verify.git');
  rmSync(dir, { recursive: true, force: true });
  const g = (cwd, a) => spawnSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = { cloned: false };
  try {
    const t0 = Date.now();
    const c = g(DATA, ['-c', `include.path=${auth}`, 'clone', '--mirror', '--quiet', dst.remote, dir]);
    out.cloneMs = Date.now() - t0;
    out.cloned = c.status === 0;
    if (!out.cloned) { out.cloneError = redact(c.stderr).slice(0, 400); return out; }
    const f = g(dir, ['fsck', '--strict', '--no-dangling']);
    out.fsck = { status: f.status, stderr: redact(f.stderr).slice(0, 400) };
    out.head = g(dir, ['rev-parse', 'refs/heads/main']).stdout.trim();
    out.headMatches = out.head === seed.head;
    out.objects = g(dir, ['rev-list', '--objects', '--all']).stdout.trim().split('\n').length;
    out.objectsMatch = out.objects === seed.objects;
    out.treeMatches = g(dir, ['rev-parse', `${seed.head}^{tree}`]).stdout.trim().length === 40;
    return out;
  } finally {
    rmSync(auth, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

function deleteDst(dst) {
  const revoked = revokeAll(dst.name);
  const r = cfRaw(['artifacts', 'namespaces', 'repos', 'delete', dst.name, '--namespace', NAMESPACE, '--force']);
  return { revoked, deleted: r.code === 0, error: r.code === 0 ? null : r.stderr.slice(0, 200) };
}

const target = args['no-deploy'] ? await current() : await deploy();
log(`run ${run} version ${target.version} url ${target.url}`);
const from = Date.now() - 60_000;
const results = [];
let relay = null;
for (const name of args.cells.split(',').filter(Boolean)) {
  if (name === 'pushpack') {
    const commits = seed.pushes ?? [];
    const dst = createDst();
    relay = { dst: dst.name, commits: commits.length };
    try {
      for (let i = 0; i < Math.min(RUNS, commits.length); i++) {
        const r = await callCell(target, name, i, { dst: dst.name, dstRemote: dst.remote, old: i ? commits[i - 1].sha : '0'.repeat(40), new: commits[i].sha });
        results.push(r);
        log(`pushpack #${i}: ok=${r.ok}${r.pending ? ' pending' : ''} pack=${r.packBytes} client=${r.clientMs} ${r.error ? JSON.stringify(r.error).slice(0, 240) : ''}`);
        if (r.pending || !r.ok) break;
      }
      const pushedAll = results.filter(r => r.cell === 'pushpack' && r.ok).length === commits.length;
      relay.verify = pushedAll ? verifyDst(dst) : { skipped: 'not every commit was relayed' };
      log(`pushpack verify: ${JSON.stringify(relay.verify).slice(0, 400)}`);
    } finally {
      relay.cleanup = deleteDst(dst);
      log(`pushpack cleanup: ${JSON.stringify(relay.cleanup)}`);
    }
    continue;
  }
  for (let i = 0; i < RUNS; i++) {
    const r = await callCell(target, name, i);
    results.push(r);
    log(`${name} #${i}: ok=${r.ok}${r.pending ? ' pending' : ''} wall=${r.wallMs ?? r.scanMs ?? '-'} client=${r.clientMs} ${r.error ? JSON.stringify(r.error).slice(0, 200) : ''}`);
    if (r.pending) break;
  }
}
const profs = PROFILES > 0 ? await profiles(target, PROFILES, results) : [];
log(`waiting ${args['o11y-wait']} s for Workers Observability ingest`);
await sleep(Number(args['o11y-wait']) * 1000);
const telemetry = await o11y(target, from, Date.now());
const summary = { ...summarize(target, results, telemetry, profs), relay };
const base = join(REPORTS, run);
writeFileSync(`${base}.json`, JSON.stringify({ summary, results, profiles: profs.map(({ alloc_space_top: _a, ...p }) => p), telemetry: { events: telemetry.events, rows: telemetry.rows, sample: telemetry.sample } }, null, 1));
writeFileSync(`${base}.md`, markdown(summary, profs));
log(`report ${base}.md`);
if (!existsSync(`${base}.md`)) process.exit(1);
