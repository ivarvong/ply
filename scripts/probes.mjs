// Differential probes (t229u days 3-4): every scenario in src/probe-scenarios.ts against the reference (git
// http-backend with Artifacts' known policy) by ply and by stock git, and with --artifacts against Cloudflare Artifacts
// too; compared by src/probe-evaluate.ts; expected differences from src/probe-allow.ts.
//
//   node --import ./test/ts-resolve.mjs scripts/probes.mjs [--only <substring>[,...]]               reference only
//   PLY_PROBES_CF=<cf binary> PLY_PROBES_CF_CWD=<dir> \
//   node --import ./test/ts-resolve.mjs scripts/probes.mjs --artifacts --out <private dir> [--only <substring>]
//
// --artifacts is opt-in and private: one fresh repository per scenario run, in the ply-loadgen namespace only, one at a
// time; results (outcomes, findings, cf-ray of every request) go to <private dir>/<run-id>.json, which must be outside
// this repository. CI runs the reference only (test/probes/probes.test.js). Exit 1 on any finding, unused allow entry,
// run error, token not proven revoked, or repository not deleted.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from '../src/probe-scenarios.ts';
import { ALLOW } from '../src/probe-allow.ts';
import { compareScenario, evaluablePairs, judge, runsFor } from '../src/probe-evaluate.ts';
import { startReference, runScenario, newTracer } from '../test/probes/runner.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] ?? null; };
const artifacts = process.argv.includes('--artifacts');
const only = arg('--only');
const outDir = arg('--out');
if (artifacts && (outDir === null || !relative(ROOT, resolve(outDir)).startsWith('..'))) { console.error('--artifacts needs --out <dir> outside this repository (results are private)'); process.exit(2); }
const stamp = new Date().toISOString().replace(/[-:]/g, '').toLowerCase().slice(0, 13); // UTC, e.g. 20261114t1737
const runId = arg('--run-id') ?? `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
const plyCommit = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return null; } })();
const gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();
// The probe code that ran, as one hash (the run may be made before the commit that cites it).
const SOURCES = ['src/probe-types.ts', 'src/probe-scenarios.ts', 'src/probe-evaluate.ts', 'src/probe-allow.ts', 'test/probes/git-outcome.ts', 'test/probes/runner.mjs', 'test/probes/artifacts.mjs', 'scripts/probes.mjs'];
const sourceHash = createHash('sha256').update(SOURCES.map(f => readFileSync(join(ROOT, f))).reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0))).digest('hex').slice(0, 16);

const audit = [];
let art = null, scrub = s => String(s);
if (artifacts) {
  const bin = process.env.PLY_PROBES_CF, cwd = process.env.PLY_PROBES_CF_CWD;
  if (!bin || !cwd) { console.error('--artifacts needs PLY_PROBES_CF (the cf CLI) and PLY_PROBES_CF_CWD'); process.exit(2); }
  const env = { ...process.env }; delete env.CLOUDFLARE_API_TOKEN;
  const mod = await import('../test/probes/artifacts.mjs');
  scrub = mod.scrub;
  art = mod.artifactsTarget({ cli: { bin, cwd, env }, runId, log: r => audit.push(r) });
}

const scenarios = SCENARIOS.filter(s => only === null || only.split(',').some(o => s.id.includes(o)));
const targets = artifacts ? ['ref-ply', 'ref-git', 'art-ply', 'art-git'] : ['ref-ply', 'ref-git'];
const ref = await startReference();
const results = [], diffs = [], evaluated = [], errors = [];
// An interrupted run still revokes the open repository's tokens and deletes it. `open` is set before the repository
// is created (a signal during art.open used to leave it behind, run 20261114t2200-full) and `closing` until the close
// has finished, so a signal at any point waits for the repository to be opened and then closes it.
let open = null, closing = null;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, async () => {
  console.error(`${sig}: closing the open repository`);
  if (open !== null) { const h = await open.catch(() => null); if (h !== null) await h.close(); }
  if (closing !== null) await closing.catch(() => {});
  process.exit(130);
});
const t0 = Date.now();
for (const s of scenarios) {
  const runs = {}, record = { id: s.id, targets: {} };
  let names = {};
  // a scenario one client cannot send at all is not run for it (no repository is created for it)
  for (const t of targets.filter(x => runsFor(s, x.endsWith('-git') ? 'git' : 'ply'))) {
    const root = mkdtempSync(join(tmpdir(), 'ply-probe-'));
    const { tracer, spans } = newTracer();
    let handle = null, proxy = ref.proxy, repoPath, before = ref.proxy.exchanges.length;
    const started = Date.now();
    try {
      if (t.startsWith('art-')) { open = art.open(`${s.id}/${t}`); handle = await open; proxy = handle.proxy; repoPath = handle.repoPath; before = 0; }
      else repoPath = (await ref.repo(s)).repoPath;
      const r = await runScenario(s, { name: t, client: t.slice(4), proxy, repoPath }, { tracer, root });
      runs[t] = r.observation; names = r.byOid;
      record.targets[t] = { ms: Date.now() - started, repo: handle?.name ?? repoPath, observation: r.observation, stepExchanges: r.stepExchanges };
    } catch (e) {
      errors.push({ scenario: s.id, target: t, error: scrub(e?.message ?? e) });
      record.targets[t] = { ms: Date.now() - started, repo: handle?.name ?? repoPath, error: scrub(e?.message ?? e) };
    } finally {
      record.targets[t].exchanges = proxy.exchanges.slice(before);
      record.targets[t].spans = spans();
      open = null;
      if (handle !== null) { closing = handle.close(); await closing; closing = null; }
      rmSync(root, { recursive: true, force: true });
    }
    const st = record.targets[t];
    const shown = st.error ? `ERROR ${st.error}` : st.observation.steps.map(x => x.outcomes.map(o => o.outcome).join(',')).join(' ; ');
    console.log(`${s.id.padEnd(58)} ${t.padEnd(8)} ${String(st.ms).padStart(6)} ms  ${shown}`);
  }
  record.names = names;
  const d = compareScenario(s, runs, names);
  diffs.push(...d);
  evaluated.push({ scenario: s.id, pairs: evaluablePairs(runs) });
  results.push(record);
}
await ref.close();
const verdict = judge(SCENARIOS, diffs, ALLOW, evaluated);
const tokensOk = art === null || art.tokens.every(t => t.revoked && (t.label === 'leftover' || t.probe === 403));
const reposOk = art === null || art.repos.every(r => r.deleted && r.listedAfter === false);

console.log(`\n${scenarios.length} scenarios x ${targets.length} targets in ${((Date.now() - t0) / 1000).toFixed(0)} s; ${diffs.length} differences: ${verdict.expected.length} expected, ${verdict.findings.length} findings; ${verdict.unused.length} unused allow entries; ${errors.length} run errors`);
for (const f of verdict.findings) console.log(`  FINDING [${f.class}] ${f.scenario} ${f.pair} ${f.field}: ${f.left.slice(0, 160)} vs ${f.right.slice(0, 160)} (${f.why})`);
for (const e of verdict.expected) console.log(`  expected ${e.difference.scenario} ${e.difference.pair} ${e.difference.field}: ${e.reason}`);
for (const a of verdict.unused) console.log(`  UNUSED allow entry ${a.scenario} ${a.pair} ${a.field}`);
for (const e of errors) console.log(`  ERROR ${e.scenario} ${e.target}: ${e.error}`);
if (art !== null) console.log(`tokens: ${art.tokens.length} minted (auto ${art.tokens.filter(t => t.label.startsWith('auto')).length}), revoked ${art.tokens.filter(t => t.revoked).length}, proven 403 ${art.tokens.filter(t => t.probe === 403).length}; repos: ${art.repos.length} created, ${art.repos.filter(r => r.deleted).length} deleted, ${art.repos.filter(r => r.listedAfter === false).length} confirmed gone`);

if (outDir !== null) {
  mkdirSync(outDir, { recursive: true });
  const checks = artifacts ? scenarios.flatMap(s => ['art-ply', 'art-git'].filter(t => runsFor(s, t === 'art-git' ? 'git' : 'ply')).map(t => `${s.id}/${t}`)) : [];
  // each finding with the cf-ray of every request the client under test made in the scenario's steps, per target
  const raysOf = (id, t) => (results.find(x => x.id === id)?.targets[t]?.stepExchanges ?? []).flat().filter(e => e.channel === 'main').map(e => ({ method: e.method, status: e.status, cfRay: e.cfRay, fault: e.fault }));
  const findings = verdict.findings.map(f => ({ ...f, rays: Object.fromEntries(f.pair.split('~').filter(t => t.startsWith('art-')).map(t => [t, raysOf(f.scenario, t)])) }));
  const out = { runId: `probes-${runId}`, startedAt: new Date(t0).toISOString(), plyCommit, sourceHash, gitVersion, node: process.version, targets, checks, verdict: { ...verdict, findings }, differences: diffs, errors, tokens: art?.tokens ?? [], repos: art?.repos ?? [], controlPlane: audit, scenarios: results };
  const file = join(outDir, `probes-${runId}.json`);
  writeFileSync(file, scrub(JSON.stringify(out, null, 1)), { mode: 0o600 });
  console.log(`results: ${file}`);
}
process.exit(verdict.findings.length || verdict.unused.length || errors.length || !tokensOk || !reposOk ? 1 : 0);
