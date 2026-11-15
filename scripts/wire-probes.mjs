// HTTP-level probes (test/probes/wire-plans.ts): every plan against the reference (git http-backend with Artifacts'
// known policy, asked directly) and, with --artifacts, against a fresh Artifacts repository per plan, by every sender
// that can send it (raw socket, curl, stock git, ply). Same rules as scripts/probes.mjs: --artifacts is opt-in and
// private, ply-loadgen only, one repository at a time, results to <private dir>/wire-<run-id>.json outside this
// repository, every token revoked and proven dead, every repository deleted and checked by listing.
//
//   node --import ./test/ts-resolve.mjs scripts/wire-probes.mjs [--only <substring>[,...]]
//   PLY_PROBES_CF=<cf binary> PLY_PROBES_CF_CWD=<dir> \
//   node --import ./test/ts-resolve.mjs scripts/wire-probes.mjs --artifacts --out <private dir> [--only ...]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WIRE, WIRE_ALLOW, cornersOf, onReference } from '../test/probes/wire-plans.ts';
import { REFERENCE_POLICY, gitEnv, newTracer, run } from '../test/probes/runner.mjs';
import { startGitServer } from '../test/server.js';
import { WIRE_REFERENCE_CONFIG, referenceAuth, runWirePlan, seedOf, tempRoot, v2Caps, wireDiffs, wireSeed } from '../test/probes/wire.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] ?? null; };
const artifacts = process.argv.includes('--artifacts');
const only = arg('--only');
const outDir = arg('--out');
if (artifacts && (outDir === null || !relative(ROOT, resolve(outDir)).startsWith('..'))) { console.error('--artifacts needs --out <dir> outside this repository (results are private)'); process.exit(2); }
const stamp = new Date().toISOString().replace(/[-:]/g, '').toLowerCase().slice(0, 13);
const runId = arg('--run-id') ?? `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
const plyCommit = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return null; } })();
const SOURCES = ['test/probes/wire-plans.ts', 'test/probes/wire.mjs', 'test/probes/artifacts.mjs', 'test/probes/runner.mjs', 'scripts/wire-probes.mjs'];
const sourceHash = createHash('sha256').update(Buffer.concat(SOURCES.map(f => readFileSync(join(ROOT, f))))).digest('hex').slice(0, 16);
const versions = { git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(), curl: execFileSync('curl', ['--version'], { encoding: 'utf8' }).split('\n')[0], node: process.version };

const audit = [];
let art = null, scrub = s => String(s);
if (artifacts) {
  const bin = process.env.PLY_PROBES_CF, cwd = process.env.PLY_PROBES_CF_CWD;
  if (!bin || !cwd) { console.error('--artifacts needs PLY_PROBES_CF (the cf CLI) and PLY_PROBES_CF_CWD'); process.exit(2); }
  const env = { ...process.env }; delete env.CLOUDFLARE_API_TOKEN;
  const mod = await import('../test/probes/artifacts.mjs');
  scrub = mod.scrub;
  art = mod.artifactsTarget({ cli: { bin, cwd, env }, runId: `w${runId}`, log: r => audit.push(r) });
}

const plans = WIRE.filter(p => only === null || only.split(',').some(o => p.id.includes(o)));
const root = tempRoot();
mkdirSync(join(root, 'repos'));
const srv = await startGitServer(join(root, 'repos'));
const ws = await wireSeed(root);
let n = 0;
async function referenceRepo(plan) {
  const name = `w${n++}`;
  const dir = join(root, 'repos', `${name}.git`);
  const env = gitEnv(root);
  await run('git', ['init', '-q', '--bare', '-b', 'main', dir], { env });
  for (const [k, v] of [...REFERENCE_POLICY, ...WIRE_REFERENCE_CONFIG]) await run('git', ['config', k, v], { cwd: dir, env });
  const url = `${srv.url}/${name}.git`;
  const p = await run('git', ['push', '-q', url, ...(await seedOf(plan, ws)).specs], { cwd: ws.dir, env: ws.env });
  if (p.status !== 0) throw new Error(`reference seed: ${p.stderr.trim().slice(0, 200)}`);
  return url;
}

let open = null, closing = null;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, async () => {
  console.error(`${sig}: closing the open repository`);
  if (open !== null) { const h = await open.catch(() => null); if (h !== null) await h.close(); }
  if (closing !== null) await closing.catch(() => {});
  process.exit(130);
});

const records = [], diffs = [], errors = [], used = new Set();
const t0 = Date.now();
for (const plan of plans) {
  const byTarget = {};
  const record = { id: plan.id, expect: plan.expect, targets: {} };
  for (const t of artifacts ? ['ref', 'art'] : ['ref']) {
    if (t === 'ref' && !onReference(plan)) continue;
    const { tracer } = newTracer();
    let handle = null;
    const started = Date.now();
    try {
      let target;
      if (t === 'art') {
        open = art.open(`wire ${plan.id}`); handle = await open;
        const side = `${handle.proxy.url}/side${handle.repoPath}`;
        const p = await run('git', ['push', '-q', side, ...(await seedOf(plan, ws)).specs], { cwd: ws.dir, env: ws.env });
        if (p.status !== 0) throw new Error(`artifacts seed: ${p.stderr.trim().slice(0, 200)}`);
        target = { name: 'art', url: handle.wireAuth.url('write'), judgeUrl: `${handle.proxy.url}/judge${handle.repoPath}`, auth: handle.wireAuth };
      } else { const url = await referenceRepo(plan); target = { name: 'ref', url, judgeUrl: url, auth: referenceAuth(url) }; }
      const unrunnable = plan.request.tag === 'credential' && plan.request.credential === 'revoked' && !target.auth.hasRevoked();
      const corners = unrunnable ? [] : cornersOf(plan);
      const capsR = await v2Caps(target.url, target.auth);
      const r = await runWirePlan(plan, corners, target, ws, { root, tracer, caps: capsR.caps });
      for (const x of r.results) {
        const a = WIRE_ALLOW.find(e => e.plan === plan.id && e.target === t && e.corner === x.corner);
        if (a !== undefined && !x.meets && x.cls === a.cls) { used.add(a); x.allowed = a.reason; }
      }
      byTarget[t] = r;
      record.targets[t] = { ms: Date.now() - started, repo: handle?.name ?? target.url, caps: capsR.caps, capsRay: capsR.ray, ...r, judgeExchanges: handle === null ? [] : handle.proxy.exchanges };
    } catch (e) {
      errors.push({ plan: plan.id, target: t, error: scrub(e?.message ?? e) });
      record.targets[t] = { ms: Date.now() - started, error: scrub(e?.message ?? e) };
    } finally {
      open = null;
      if (handle !== null) { closing = handle.close(); await closing; closing = null; }
    }
    const st = record.targets[t];
    console.log(`${plan.id.padEnd(60)} ${t} ${String(st.ms).padStart(6)} ms  ${st.error ? `ERROR ${st.error}` : st.results.map(x => `${x.corner}:${x.meets ? 'ok' : x.allowed ? 'allowed' : 'MISS'}(${x.cls.slice(0, 40)})`).join(' ')}`);
  }
  diffs.push(...wireDiffs(plan.id, byTarget).filter(d => !(d.field === 'meets' && Object.values(byTarget).flatMap(b => b.results).some(x => x.allowed))));
  records.push(record);
}
await srv.close();
rmSync(root, { recursive: true, force: true });

const misses = records.flatMap(r => Object.entries(r.targets).flatMap(([t, v]) => (v.results ?? []).filter(x => !x.meets && !x.allowed).map(x => ({ plan: r.id, target: t, corner: x.corner, cls: x.cls, rays: x.rays }))));
const ran = new Set(records.flatMap(r => Object.entries(r.targets).flatMap(([t, v]) => (v.results ?? []).map(x => `${r.id}|${t}|${x.corner}`))));
const unused = WIRE_ALLOW.filter(a => ran.has(`${a.plan}|${a.target}|${a.corner}`) && !used.has(a));
const tokensOk = art === null || art.tokens.every(t => t.revoked && (t.label === 'leftover' || t.probe === 403));
const reposOk = art === null || art.repos.every(r => r.deleted && r.listedAfter === false);
console.log(`\n${plans.length} plans in ${((Date.now() - t0) / 1000).toFixed(0)} s; ${misses.length} results off their answer; ${diffs.length} differences; ${unused.length} unused allow entries; ${errors.length} run errors`);
for (const m of misses) console.log(`  MISS ${m.plan} ${m.target}-${m.corner}: ${m.cls.slice(0, 140)}`);
for (const d of diffs) console.log(`  DIFF ${d.plan} ${d.pair} ${d.field}${d.minor ? ' (minor)' : ''}: ${String(d.left).slice(0, 120)} vs ${String(d.right).slice(0, 120)}`);
for (const a of unused) console.log(`  UNUSED allow entry ${a.plan} ${a.target} ${a.corner}`);
for (const e of errors) console.log(`  ERROR ${e.plan} ${e.target}: ${e.error}`);
if (art !== null) console.log(`tokens: ${art.tokens.length} minted (auto ${art.tokens.filter(t => t.label.startsWith('auto')).length}), revoked ${art.tokens.filter(t => t.revoked).length}, proven 403 ${art.tokens.filter(t => t.probe === 403).length}; repos: ${art.repos.length} created, ${art.repos.filter(r => r.deleted).length} deleted, ${art.repos.filter(r => r.listedAfter === false).length} confirmed gone`);
if (outDir !== null) {
  mkdirSync(outDir, { recursive: true });
  const checks = artifacts ? plans.flatMap(p => cornersOf(p).map(c => `${p.id}/art-${c}`)) : [];
  const out = { runId: `wire-${runId}`, startedAt: new Date(t0).toISOString(), plyCommit, sourceHash, versions, checks, misses, differences: diffs, unused, errors, tokens: art?.tokens ?? [], repos: art?.repos ?? [], controlPlane: audit, plans: records };
  const file = join(outDir, `wire-${runId}.json`);
  writeFileSync(file, scrub(JSON.stringify(out, null, 1)), { mode: 0o600 });
  console.log(`results: ${file}`);
}
process.exit(unused.length || errors.length || !tokensOk || !reposOk ? 1 : 0);
