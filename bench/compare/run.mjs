// ply against native git, end to end, on this machine (#323). No account, no deployment: deterministic fixtures served
// by `git http-backend` (test/server.js), every client measured from outside as its own process tree, every sample
// verified on the server repository before it counts.
//
//   npm run bench:compare                       # builds dist/, runs the default matrix, prints the table
//   node bench/compare/run.mjs [--full | --matrix default|full|smoke] [--reps 5] [--seed 323] [--ply dist|src]
//        [--server filter|stock] [--clients ply,git-full,...] [--tasks read,edit] [--modes fresh,reused] [--cells <substring>]
//        [--out <dir>] [--machine "<description>"] [--no-memory] [--interval <ms>] [--keep]
//   node bench/compare/run.mjs --render <results.json>     # the table again, from a results file
//
// Writes <out>/results.json and <out>/results.md (default out: bench/compare/out, not tracked), and prints the Markdown.
// Exits 1 when any sample failed (the failure is in the JSON and the table either way). bench/compare/README.md says
// what each number means and what it does not.
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip, deflateSync } from 'node:zlib';
import { fsckProblems, git, makeBareRepo, startGitServer, tmpRoot } from '../../test/server.js';
import {
  CAVEATS, CLIENTS, CLIENT_IDS, DEFAULT_SEED, MATRICES, METRICS, METRIC_DEFINITIONS, MODES, POLICY, REF, SCHEMA, TASKS,
  compare, editedContent, fastImportStream, fillStep, gitClientEnv, renderMarkdown, sha256, stats, strategyCommands,
  summarize, targetContent, targetCommits, targetPath, validateResults,
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const MEASURE = join(HERE, 'measure.mjs');
const PLY_CLIENT = join(HERE, 'ply-client.mjs');
const TS_RESOLVE = join(REPO, 'test', 'ts-resolve.mjs');
const RUN_TIMEOUT_MS = 600_000;

// ---- what was measured: the commit, and whether the tree it was built from differs from it -------------------------
export function sourceIdentity(repo = REPO) {
  const commit = git(repo, ['rev-parse', 'HEAD']).trim();
  const status = git(repo, ['status', '--porcelain', '--untracked-files=all']);
  if (!status.trim()) return { commit, dirty: false, dirtySha256: null, dirtyPaths: [] };
  const h = createHash('sha256');
  h.update(execFileSync('git', ['diff', 'HEAD', '--binary'], { cwd: repo, maxBuffer: 1 << 28 }));
  const untracked = git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort();
  for (const p of untracked) { h.update(`\0${p}\0`); h.update(readFileSync(join(repo, p))); }
  return { commit, dirty: true, dirtySha256: h.digest('hex'), dirtyPaths: status.split('\n').filter(Boolean).map(l => l.slice(3)) };
}

// ---- fixtures ------------------------------------------------------------------------------------------------------
function dirBytes(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? dirBytes(join(dir, e.name)) : statSync(join(dir, e.name)).size;
  return n;
}
// The served repository for one cell, and a copy whose main is one commit behind (the reused-state mode clones that).
// fast-import reads its stream from a file (CONTEXT.md: a large `input` pipe to a git child has hung under load), and
// the result is repacked into one pack by a single thread, so the server state is the same bytes on every run.
export function buildFixture(root, cell, seed, { stock = false } = {}) {
  const dir = makeBareRepo(root, `fixture-${cell.id}`, { stock });
  const stream = join(root, `fixture-${cell.id}.fi`);
  const fd = openSync(stream, 'w');
  try { for (const piece of fastImportStream(seed, cell)) writeSync(fd, piece); } finally { closeSync(fd); }
  const input = openSync(stream, 'r');
  try { execFileSync('git', ['fast-import', '--quiet', '--done'], { cwd: dir, stdio: [input, 'pipe', 'pipe'] }); } finally { closeSync(input); }
  rmSync(stream);
  git(dir, ['-c', 'pack.threads=1', 'repack', '-a', '-d', '-f', '-q']);
  git(dir, ['pack-refs', '--all']);
  const problems = fsckProblems(dir);
  if (problems.length) throw new Error(`fixture ${cell.id} fails git fsck --strict: ${problems.join(' | ')}`);
  const head = git(dir, ['rev-parse', REF]).trim(), prevHead = git(dir, ['rev-parse', `${REF}~1`]).trim();
  const revs = targetCommits(cell).length;
  const current = targetContent(seed, cell, revs - 1), previous = targetContent(seed, cell, Math.max(0, revs - 2));
  const prev = join(root, `fixture-${cell.id}-prev.git`);
  cpSync(dir, prev, { recursive: true });
  git(prev, ['update-ref', REF, prevHead]);
  const counted = Object.fromEntries(git(dir, ['count-objects', '-v']).trim().split('\n').map(l => l.split(': ')));
  return {
    dir, prev, path: targetPath(cell), head, prevHead,
    headSha256: sha256(current), headBytes: current.length, editedSha256: sha256(editedContent(current)),
    prevSha256: sha256(previous), prevEditedSha256: sha256(editedContent(previous)),
    zlibRatio: deflateSync(current).length / current.length,
    packBytes: Number(counted['size-pack']) * 1024, objects: Number(counted['in-pack']), repoBytes: dirBytes(dir),
  };
}

// ---- HTTP accounting, at the server, the same for every client -----------------------------------------------------
// pkt-line walk that never holds a payload: the callback gets each packet's length and its first bytes.
function pktWalker(onPkt) {
  let head = '', left = 0, first = null, len = 0, raw = false, rawBytes = 0;
  return {
    get rawBytes() { return rawBytes; },
    raw() { raw = true; },
    push(buf) {
      let i = 0;
      while (i < buf.length) {
        if (raw) { rawBytes += buf.length - i; return; }
        if (left === 0) {
          const take = Math.min(4 - head.length, buf.length - i);
          head += buf.toString('latin1', i, i + take); i += take;
          if (head.length < 4) return;
          len = parseInt(head, 16); head = '';
          if (Number.isNaN(len)) throw new Error('not a pkt-line');
          if (len < 4) { onPkt(len, null); continue; }
          left = len - 4; first = [];
          if (left === 0) onPkt(len, Buffer.alloc(0));
          continue;
        }
        const take = Math.min(left, buf.length - i);
        if (first !== null && first.length < 16) first.push(...buf.subarray(i, i + Math.min(take, 16 - first.length)));
        left -= take; i += take;
        if (left === 0) { onPkt(len, Buffer.from(first)); first = null; }
      }
    },
  };
}
export function attachCounter(server) {
  let records = [];
  server.prependListener('request', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const rec = {
      repo: url.pathname.split('/')[1] ?? '', method: req.method, path: url.pathname + url.search, status: null,
      requestHeadBytes: Buffer.byteLength(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`) + req.rawHeaders.reduce((n, v) => n + Buffer.byteLength(v) + 2, 0) + 2,
      requestBodyBytes: 0, responseHeadBytes: null, responseBodyBytes: 0, fetchPackBytes: null, pushPackBytes: null, parseError: null,
    };
    records.push(rec);
    const fail = e => { rec.parseError = String(e?.message ?? e); };
    // request: receive-pack's body is `commands, flush, pack`; gunzip first when the client gzip-encoded it
    const isPush = req.method === 'POST' && url.pathname.endsWith('/git-receive-pack');
    let settle = () => {};
    rec.done = isPush ? new Promise(r => { settle = r; }) : Promise.resolve();
    if (isPush) {
      const walker = pktWalker(len => { if (len === 0) walker.raw(); });
      const finish = () => { rec.pushPackBytes = walker.rawBytes; settle(); };
      const feed = d => { try { walker.push(d); } catch (e) { fail(e); } };
      if (req.headers['content-encoding'] === 'gzip') {
        const gz = createGunzip();
        gz.on('data', feed); gz.on('end', finish); gz.on('error', e => { fail(e); settle(); });
        req.on('data', d => gz.write(d)); req.on('end', () => gz.end());
      } else { req.on('data', feed); req.on('end', finish); }
      req.on('close', settle);
    }
    req.on('data', d => { rec.requestBodyBytes += d.length; });
    // response: in a v2 upload-pack answer the pack is side-band channel 1 after the `packfile` section header
    const isFetch = req.method === 'POST' && url.pathname.endsWith('/git-upload-pack');
    let inPack = false, pack = 0, broken = false;
    const walker = pktWalker((len, first) => {
      if (first === null) return;
      if (!inPack) { if (len === 13 && first.toString('latin1').startsWith('packfile\n')) inPack = true; return; }
      if (first[0] === 1) pack += len - 5;
    });
    const count = chunk => {
      if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      rec.responseBodyBytes += b.length;
      if (isFetch && !broken) try { walker.push(b); } catch (e) { broken = true; fail(e); }
    };
    const write = res.write.bind(res), end = res.end.bind(res);
    res.write = (chunk, ...rest) => { count(chunk); return write(chunk, ...rest); };
    res.end = (chunk, ...rest) => { count(chunk); return end(chunk, ...rest); };
    res.on('finish', () => {
      rec.status = res.statusCode;
      // node keeps the serialized head it sent in _header; without it the head size is unknown, not guessed
      rec.responseHeadBytes = typeof res._header === 'string' ? Buffer.byteLength(res._header) : null;
      if (isFetch && inPack && !broken) rec.fetchPackBytes = pack;
    });
  });
  return {
    reset() { records = []; },
    async take(repo) {
      await Promise.all(records.map(r => r.done));
      return records.filter(r => r.repo === repo).map(({ done: _done, ...r }) => r);
    },
  };
}
const sumOrNull = xs => (xs.some(x => x !== null) ? xs.reduce((a, x) => a + (x ?? 0), 0) : null);
export function httpTotals(records) {
  const headKnown = records.every(r => r.responseHeadBytes !== null);
  return {
    requests: records.length,
    requestBytes: records.reduce((n, r) => n + r.requestHeadBytes + r.requestBodyBytes, 0),
    responseBytes: headKnown ? records.reduce((n, r) => n + r.responseHeadBytes + r.responseBodyBytes, 0) : null,
    requestBodyBytes: records.reduce((n, r) => n + r.requestBodyBytes, 0),
    responseBodyBytes: records.reduce((n, r) => n + r.responseBodyBytes, 0),
    fetchPackBytes: sumOrNull(records.map(r => r.fetchPackBytes)),
    pushPackBytes: sumOrNull(records.map(r => r.pushPackBytes)),
    statuses: records.map(r => r.status),
    parseErrors: records.map(r => r.parseError).filter(Boolean),
  };
}

// ---- verification: independent of both clients, on the server repository -------------------------------------------
export function verifySample({ task, repoDir, fixture, contentFile }) {
  const checks = [];
  const check = (name, ok, detail = '') => { checks.push({ name, ok: Boolean(ok), ...(ok ? {} : { detail: String(detail).slice(0, 400) }) }); };
  const attempt = (name, fn) => { try { fn(); } catch (e) { check(name, false, e?.stderr || e?.message || e); } };
  let commit = null;
  if (task === 'read') {
    attempt('content: the bytes the client produced are the file at the ref (sha256)', () => {
      const got = readFileSync(contentFile);
      check('content: the bytes the client produced are the file at the ref (sha256)', got.length === fixture.headBytes && sha256(got) === fixture.headSha256, `got ${got.length} B sha256 ${sha256(got)}, want ${fixture.headBytes} B ${fixture.headSha256}`);
    });
    attempt('parentage: a read leaves the ref where it was', () => {
      const tip = git(repoDir, ['rev-parse', REF]).trim();
      check('parentage: a read leaves the ref where it was', tip === fixture.head, `main is ${tip}, was ${fixture.head}`);
    });
  } else {
    attempt('parentage: main is one new commit whose only parent is the previous head', () => {
      const line = git(repoDir, ['rev-list', '--parents', '-n', '1', REF]).trim().split(' ');
      commit = line[0];
      check('parentage: main is one new commit whose only parent is the previous head', line.length === 2 && line[1] === fixture.head && line[0] !== fixture.head, `rev-list --parents: ${line.join(' ')}; previous head ${fixture.head}`);
    });
    attempt('content: the blob at main:<path> is the intended final content (sha256)', () => {
      const got = execFileSync('git', ['cat-file', 'blob', `${REF}:${fixture.path}`], { cwd: repoDir, maxBuffer: 1 << 30 });
      check('content: the blob at main:<path> is the intended final content (sha256)', sha256(got) === fixture.editedSha256, `got ${got.length} B sha256 ${sha256(got)}, want ${fixture.editedSha256}`);
    });
    attempt('scope: the commit changes the target path and nothing else', () => {
      const changed = git(repoDir, ['diff-tree', '-r', '--no-commit-id', '--name-status', fixture.head, REF]).trim();
      check('scope: the commit changes the target path and nothing else', changed === `M\t${fixture.path}`, changed);
    });
    attempt('policy: author, committer, date and message are the stated ones', () => {
      const raw = git(repoDir, ['cat-file', 'commit', REF]);
      const who = p => `${p.name} <${p.email}> ${POLICY.time} ${POLICY.tz}`;
      const want = [`author ${who(POLICY.author)}`, `committer ${who(POLICY.committer)}`];
      const [header, ...body] = raw.split('\n\n');
      check('policy: author, committer, date and message are the stated ones', want.every(l => header.split('\n').includes(l)) && body.join('\n\n') === `${POLICY.message}\n`, raw);
    });
    attempt('refs: no ref other than main exists', () => {
      const refs = git(repoDir, ['for-each-ref', '--format=%(refname)']).trim();
      check('refs: no ref other than main exists', refs === REF, refs);
    });
  }
  attempt('fsck: git fsck --strict reports nothing on the server repository', () => {
    const problems = fsckProblems(repoDir);
    check('fsck: git fsck --strict reports nothing on the server repository', problems.length === 0, problems.join(' | '));
  });
  return { ok: checks.every(c => c.ok), checks, commit };
}

// ---- one measured run ----------------------------------------------------------------------------------------------
const execAsync = (file, args, opts) => new Promise(resolve => {
  execFile(file, args, { maxBuffer: 1 << 26, ...opts }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
});
async function measure(dir, steps, opts) {
  const spec = join(dir, 'measure.json');
  writeFileSync(spec, JSON.stringify({ steps, intervalMs: opts.intervalMs, memory: opts.memory }));
  const r = await execAsync(process.execPath, [MEASURE, spec], { timeout: RUN_TIMEOUT_MS, env: { PATH: process.env.PATH } });
  try { return JSON.parse(r.stdout); } catch { return { ok: false, steps: [], harnessError: `measure.mjs: ${r.error?.message ?? 'no output'} ${r.stderr}`.slice(0, 600) }; }
}
const failedStep = m => { const s = m.steps?.find(x => x.status !== 0); return m.harnessError ?? (s ? `\`${s.argv0}\` exited ${s.status ?? s.signal ?? s.error}: ${(s.stderr || s.stdout).trim().split('\n').slice(-3).join(' / ')}` : 'client failed'); };
const plyNode = build => [process.execPath, ...(build.ext === 'ts' ? ['--disable-warning=ExperimentalWarning', '--import', TS_RESOLVE] : []), PLY_CLIENT];

async function runSample(ctx, cell, fixture, task, mode, clientId, rep) {
  const client = CLIENTS[clientId];
  const base = { cell: cell.id, task, mode, client: clientId, rep };
  if (client.needsFilter && !ctx.server.filter) return { ...base, status: 'unsupported', reason: 'the server does not advertise `filter` (uploadpack.allowFilter is off); git would ignore --filter and clone unfiltered, which is another strategy\'s cell' };
  const name = `t${String(ctx.seq++).padStart(5, '0')}`;
  const repoDir = join(ctx.served, `${name}.git`), prevDir = join(ctx.served, `${name}-prev.git`), work = join(ctx.work, name);
  mkdirSync(join(work, 'home'), { recursive: true });
  // reset: every sample gets its own copy of the fixture, so nothing a previous sample pushed or packed is there
  cpSync(fixture.dir, repoDir, { recursive: true });
  if (mode === 'reused') cpSync(fixture.prev, prevDir, { recursive: true });
  const vars = { url: `${ctx.url}/${name}.git`, prev: `${ctx.url}/${name}-prev.git`, dir: join(work, 'clone'), path: fixture.path, out: join(work, 'out.bin') };
  try {
    let steps, contentFile = vars.out;
    if (client.kind === 'ply') {
      const job = join(work, 'job.json');
      writeFileSync(job, JSON.stringify({ build: ctx.build.dir, buildExt: ctx.build.ext, task, url: vars.url, warmupUrl: mode === 'reused' ? vars.prev : null, path: fixture.path, out: vars.out, policy: POLICY }));
      steps = [{ argv: [...plyNode(ctx.build), job], cwd: work, env: { PATH: process.env.PATH, HOME: join(work, 'home') } }];
    } else {
      const plan = client.tasks[task][mode], env = gitClientEnv(join(work, 'home'), ctx.gitPath);
      for (const s of plan.setup ?? []) {
        const f = fillStep(s, vars);
        const r = await execAsync(f.argv[0], f.argv.slice(1), { cwd: work, env });
        if (r.error) return { ...base, status: 'failed', reason: `set-up \`${f.argv.slice(0, 3).join(' ')}\` failed: ${String(r.stderr || r.error.message).trim().slice(-300)}` };
        if (f.stdout) writeFileSync(f.stdout, r.stdout);
      }
      steps = plan.steps.map(s => ({ ...fillStep(s, vars), cwd: work, env }));
      if (plan.content) contentFile = fillStep([plan.content], vars).argv[0];
    }
    ctx.counter.reset();
    const m = await measure(work, steps, ctx);
    const records = await ctx.counter.take(`${name}.git`);
    const http = httpTotals(records);
    const ply = client.kind === 'ply' ? (() => { try { return JSON.parse(m.steps?.[0]?.stdout ?? ''); } catch { return null; } })() : null;
    const memory = m.memory ?? { available: false, unavailable: 'the measuring process produced no result' };
    const timing = { processTreeMs: m.elapsedMs ?? null, plyCallMs: ply?.opMs ?? null, plyWarmupMs: ply?.warmupMs ?? null, steps: (m.steps ?? []).map(s => ({ argv0: s.argv0, ms: s.ms })) };
    const sample = { ...base, repo: name, timing, memory, http: { ...http, requestsDetail: records.map(r => ({ method: r.method, path: r.path.replace(`/${name}.git`, ''), status: r.status, requestBytes: r.requestHeadBytes + r.requestBodyBytes, responseBytes: (r.responseHeadBytes ?? 0) + r.responseBodyBytes })) } };
    if (!m.ok) return { ...sample, status: 'failed', reason: failedStep(m) };
    if (client.kind === 'ply' && (!ply || typeof ply.opMs !== 'number')) return { ...sample, status: 'failed', reason: 'the ply client printed no result' };
    if (http.parseErrors.length) return { ...sample, status: 'failed', reason: `HTTP accounting could not parse an exchange: ${http.parseErrors[0]}` };
    const verification = verifySample({ task, repoDir, fixture, contentFile });
    const metrics = {
      elapsedMs: client.kind === 'ply' && mode === 'reused' ? ply.opMs : m.elapsedMs,
      peakPssBytes: memory.available ? memory.peakPssBytes : null,
      peakRssSumBytes: memory.available ? memory.peakRssSumBytes : null,
      maxProcessHwmBytes: memory.available ? memory.maxProcessHwmBytes : null,
      plySelfMaxRssBytes: ply?.selfMaxRssBytes ?? null,
      requests: http.requests, requestBytes: http.requestBytes, responseBytes: http.responseBytes,
      fetchPackBytes: http.fetchPackBytes, pushPackBytes: http.pushPackBytes,
    };
    if (!verification.ok) return { ...sample, metrics, verification, status: 'failed', reason: `verification failed: ${verification.checks.filter(c => !c.ok).map(c => `${c.name} (${c.detail})`).join('; ')}` };
    if (ply?.newCommit && ply.newCommit !== verification.commit) return { ...sample, metrics, verification, status: 'failed', reason: `ply reported commit ${ply.newCommit}; the server has ${verification.commit}` };
    return { ...sample, metrics, verification, status: 'ok' };
  } finally {
    if (!ctx.keep) for (const d of [repoDir, prevDir, work]) rmSync(d, { recursive: true, force: true });
  }
}

// ---- baselines: what the runtimes cost before any work, and whether the sampler sees a known allocation ------------
async function baselines(ctx, reps) {
  if (!ctx.memory) return { unavailable: 'memory sampling disabled (--no-memory)' };
  const dir = join(ctx.work, 'baseline');
  mkdirSync(dir, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: dir };
  const job = join(dir, 'job.json');
  writeFileSync(job, JSON.stringify({ build: ctx.build.dir, buildExt: ctx.build.ext, task: 'idle' }));
  const HOLD = 64 * 1024 * 1024;
  const kinds = {
    nodeIdle: [{ argv: [...plyNode(ctx.build), job], cwd: dir, env }],
    nodeEmpty: [{ argv: [process.execPath, '-e', ''], cwd: dir, env }],
    nodeHolding64MiB: [{ argv: [process.execPath, '-e', `const b = Buffer.alloc(${HOLD}, 1); setTimeout(() => b.length, 300);`], cwd: dir, env }],
    gitIdle: [{ argv: ['git', '--version'], cwd: dir, env: gitClientEnv(dir, ctx.gitPath) }],
  };
  const raw = Object.fromEntries(Object.keys(kinds).map(k => [k, []]));
  for (let i = 0; i < reps; i++) for (const [k, steps] of Object.entries(kinds)) raw[k].push(await measure(dir, steps, ctx));
  const first = raw.nodeIdle[0];
  if (!first?.memory?.available) return { unavailable: first?.memory?.unavailable ?? first?.harnessError ?? 'not measured' };
  const fold = runs => ({
    elapsedMs: stats(runs.map(r => r.elapsedMs)),
    peakPssBytes: stats(runs.map(r => r.memory?.peakPssBytes)), peakRssSumBytes: stats(runs.map(r => r.memory?.peakRssSumBytes)),
    maxProcessHwmBytes: stats(runs.map(r => r.memory?.maxProcessHwmBytes)),
    plySelfMaxRssBytes: stats(runs.map(r => { try { return JSON.parse(r.steps[0].stdout).selfMaxRssBytes; } catch { return null; } })),
  });
  const out = Object.fromEntries(Object.entries(raw).map(([k, runs]) => [k, fold(runs)]));
  const seen = out.nodeHolding64MiB.peakPssBytes.median - out.nodeEmpty.peakPssBytes.median;
  out.samplerCheck = {
    heldBytes: HOLD, measuredDeltaBytes: seen, relativeError: (seen - HOLD) / HOLD,
    summary: `a node child that fills a 64 MiB buffer and holds it 300 ms measured ${(seen / 1048576).toFixed(1)} MiB of peak PSS above an empty node child (64.0 MiB expected; medians of n = ${reps}).`,
  };
  return out;
}

// ---- the run -------------------------------------------------------------------------------------------------------
async function serverAdvertisesFilter(url, repo) {
  const r = await fetch(`${url}/${repo}/info/refs?service=git-upload-pack`, { headers: { 'git-protocol': 'version=2' } });
  return /fetch=[^\n]*\bfilter\b/.test(await r.text());
}
const gitDirOnPath = path => dirname(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: { PATH: path } }).trim());

export async function runBenchmark(options = {}) {
  const o = {
    matrix: 'default', reps: 5, seed: DEFAULT_SEED, ply: 'dist', server: 'filter', clients: CLIENT_IDS, tasks: TASKS, modes: MODES,
    cells: null, only: null, machine: 'not described (pass --machine)', memory: true, intervalMs: 1, keep: false, log: () => {}, command: 'node bench/compare/run.mjs', ...options,
  };
  const started = Date.now(), loadBefore = os.loadavg();
  const build = o.ply === 'src' ? { dir: join(REPO, 'src'), ext: 'ts', label: 'src/ (TypeScript, run through node\'s type stripping; slower to start than dist/)' } : { dir: join(REPO, 'dist'), ext: 'js', label: 'dist/ (tsc output of this tree, as a consumer imports it)' };
  if (!existsSync(join(build.dir, `edit.${build.ext}`))) throw new Error(`${build.dir} has no build: run \`npm run build\` first (npm run bench:compare does)`);
  const cells = MATRICES[o.matrix]?.filter(c => !o.cells || c.id.includes(o.cells));
  if (!cells?.length) throw new Error(`no cells: matrix ${o.matrix}${o.cells ? `, filter ${o.cells}` : ''}`);
  const source = sourceIdentity();
  const tmp = tmpRoot();
  const fixturesDir = join(tmp.root, 'fixtures'), served = join(tmp.root, 'served'), work = join(tmp.root, 'work');
  for (const d of [fixturesDir, served, work]) mkdirSync(d);
  const server = await startGitServer(served);
  // The clients' git is the one on PATH with the harness's own wrapper directories removed, so a test shim's `-c`
  // flags never reach a measured client; what the measured clients are configured with is GIT_CLIENT_CONFIG alone.
  const ctx = { url: server.url, served, work, build, counter: attachCounter(server.server), seq: 0, memory: o.memory, intervalMs: o.intervalMs, keep: o.keep, gitPath: (process.env.PATH ?? '').split(':').filter(p => !p.endsWith('/test/git-shim')).join(':'), server: { filter: false } };
  const samples = [], cellRecords = [];
  let loadMax = loadBefore[0];
  let base, serverConfig = {};
  try {
    for (const [i, cell] of cells.entries()) {
      const t0 = Date.now();
      const fixture = buildFixture(fixturesDir, cell, o.seed, { stock: o.server === 'stock' });
      if (i === 0) {
        cpSync(fixture.dir, join(served, 'probe.git'), { recursive: true });
        ctx.server.filter = await serverAdvertisesFilter(server.url, 'probe.git');
        rmSync(join(served, 'probe.git'), { recursive: true, force: true });
        serverConfig = Object.fromEntries(git(fixture.dir, ['config', '--local', '--list']).trim().split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]).filter(([k]) => !k.startsWith('core.')));
        o.log('baselines');
        base = await baselines(ctx, o.reps);
      }
      o.log(`cell ${cell.id}: fixture built in ${Date.now() - t0} ms (head ${fixture.head.slice(0, 10)}, pack ${fixture.packBytes} B)`);
      for (const task of TASKS.filter(t => o.tasks.includes(t))) for (const mode of MODES.filter(m => o.modes.includes(m))) {
        if (mode === 'reused' && !cell.reused) continue;
        // `only` (tests) narrows the plan further: (cell id, task, mode, client id) => boolean
        const ids = CLIENT_IDS.filter(c => o.clients.includes(c) && (!o.only || o.only(cell.id, task, mode, c)));
        if (!ids.length) continue;
        // repetitions outermost and the client order rotated by one each repetition: a change in the machine's load
        // during a cell falls on every client, and no client always runs first or right after the same neighbour
        for (let rep = 0; rep < o.reps; rep++) for (let k = 0; k < ids.length; k++) {
          const s = await runSample(ctx, cell, fixture, task, mode, ids[(k + rep) % ids.length], rep);
          samples.push(s);
          if (s.status === 'failed') o.log(`  FAILED ${cell.id} ${task}/${mode} ${s.client} rep ${rep}: ${s.reason}`);
        }
        o.log(`  ${task}/${mode}: ${samples.filter(s => s.cell === cell.id && s.task === task && s.mode === mode && s.status === 'ok').length}/${o.reps * ids.length} accepted`);
      }
      loadMax = Math.max(loadMax, os.loadavg()[0]);
      const edits = samples.filter(s => s.cell === cell.id && s.task === 'edit' && s.status === 'ok');
      const ids = [...new Set(edits.map(s => s.verification.commit))];
      const { dir: _d, prev: _p, ...fx } = fixture;
      cellRecords.push({ id: cell.id, params: { commits: cell.commits, fileBytes: cell.fileBytes, content: cell.content, depth: cell.depth, reusedMode: cell.reused }, fixture: fx, commitAgreement: edits.length ? { agreed: ids.length === 1, commits: ids, samples: edits.length } : null });
      rmSync(fixture.dir, { recursive: true, force: true }); rmSync(fixture.prev, { recursive: true, force: true });
    }
  } finally {
    await server.close();
    if (!o.keep) tmp.cleanup();
  }
  const summary = summarize(samples);
  const count = st => samples.filter(s => s.status === st).length;
  return {
    schema: SCHEMA,
    generatedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    command: o.command,
    source,
    environment: {
      node: process.version, git: execFileSync('git', ['--version'], { encoding: 'utf8', env: { PATH: ctx.gitPath } }).trim(), gitPath: gitDirOnPath(ctx.gitPath),
      os: { platform: os.platform(), release: os.release(), arch: os.arch(), version: os.version() },
      cpus: { count: os.cpus().length, model: os.cpus()[0]?.model ?? 'unknown' }, totalMemBytes: os.totalmem(),
      loadavg: { before: loadBefore, after: os.loadavg(), max1m: Math.max(loadMax, os.loadavg()[0]) }, machine: o.machine,
    },
    config: {
      seed: o.seed, repetitions: o.reps, matrix: o.matrix, plyBuild: build.label, clients: CLIENT_IDS.filter(c => o.clients.includes(c)), tasks: o.tasks, modes: o.modes,
      cellFilter: o.cells, memorySampling: o.memory, sampleIntervalMs: o.intervalMs, order: 'per cell, task and mode: repetitions outermost, client order rotated by one each repetition; one client at a time',
      reset: 'every sample runs against its own fresh copy of the cell\'s fixture repository and in an empty client directory',
    },
    server: {
      kind: 'git http-backend behind the Node CGI shim test/server.js startGitServer, HTTP/1.1 on 127.0.0.1, no TLS, no auth',
      filter: ctx.server.filter, gitConfig: serverConfig, clientGitConfig: Object.fromEntries(Object.entries(gitClientEnv('<home>', '<path>')).filter(([k]) => k !== 'PATH' && k !== 'HOME')),
      accounting: 'request and response sizes are counted inside the server process for every client alike (attachCounter in bench/compare/run.mjs)',
    },
    policy: POLICY,
    metrics: METRICS,
    metricDefinitions: METRIC_DEFINITIONS,
    statistics: 'median, min, max, q1, q3 of the accepted samples; quantiles by linear interpolation between order statistics (R type 7). n is `accepted`.',
    caveats: CAVEATS,
    strategies: strategyCommands(),
    baselines: base ?? { unavailable: 'not measured' },
    cells: cellRecords,
    samples,
    summary,
    comparisons: compare(summary),
    totals: { samples: samples.length, accepted: count('ok'), failed: count('failed'), unsupported: count('unsupported') },
  };
}

// ---- CLI -----------------------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const o = {}, list = v => v.split(',').map(s => s.trim()).filter(Boolean);
  const take = { '--matrix': v => { o.matrix = v; }, '--reps': v => { o.reps = Number(v); }, '--seed': v => { o.seed = Number(v); }, '--ply': v => { o.ply = v; }, '--server': v => { o.server = v; }, '--clients': v => { o.clients = list(v); }, '--tasks': v => { o.tasks = list(v); }, '--modes': v => { o.modes = list(v); }, '--cells': v => { o.cells = v; }, '--out': v => { o.out = v; }, '--machine': v => { o.machine = v; }, '--interval': v => { o.intervalMs = Number(v); }, '--render': v => { o.render = v; } };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--full') o.matrix = 'full';
    else if (a === '--no-memory') o.memory = false;
    else if (a === '--keep') o.keep = true;
    else if (take[a] && i + 1 < argv.length) take[a](argv[++i]);
    else throw new Error(`unknown or incomplete argument ${a} (see the header of bench/compare/run.mjs)`);
  }
  if (o.reps !== undefined && !(Number.isInteger(o.reps) && o.reps > 0)) throw new Error('--reps takes a positive integer');
  if (o.seed !== undefined && !Number.isInteger(o.seed)) throw new Error('--seed takes an integer');
  if (o.ply !== undefined && !['dist', 'src'].includes(o.ply)) throw new Error('--ply takes dist or src');
  if (o.server !== undefined && !['filter', 'stock'].includes(o.server)) throw new Error('--server takes filter or stock');
  for (const [k, all] of [['clients', CLIENT_IDS], ['tasks', TASKS], ['modes', MODES]]) for (const v of o[k] ?? []) if (!all.includes(v)) throw new Error(`--${k}: unknown ${v} (one of ${all.join(', ')})`);
  return o;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const o = parseArgs(process.argv.slice(2));
  if (o.render) {
    const r = JSON.parse(readFileSync(o.render, 'utf8'));
    const bad = validateResults(r);
    if (bad.length) { process.stderr.write(`${o.render} is not a ${SCHEMA} file:\n  ${bad.join('\n  ')}\n`); process.exit(1); }
    process.stdout.write(`${renderMarkdown(r)}\n`);
  } else {
    const out = o.out ?? join(HERE, 'out');
    const results = await runBenchmark({ ...o, command: `node bench/compare/run.mjs ${process.argv.slice(2).map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`.trim(), log: line => process.stderr.write(`${line}\n`) });
    mkdirSync(out, { recursive: true });
    const file = join(out, 'results.json');
    writeFileSync(file, `${JSON.stringify(results, null, 1)}\n`);
    // the table is made from the file just written, not from the object in memory
    const reread = JSON.parse(readFileSync(file, 'utf8'));
    const bad = validateResults(reread);
    const md = renderMarkdown(reread);
    writeFileSync(join(out, 'results.md'), `${md}\n`);
    process.stdout.write(`${md}\n`);
    process.stderr.write(`\nwrote ${file} and ${join(out, 'results.md')}\n`);
    if (bad.length) { process.stderr.write(`results do not match the documented schema:\n  ${bad.join('\n  ')}\n`); process.exitCode = 1; }
    if (reread.totals.failed) { process.stderr.write(`${reread.totals.failed} sample(s) failed; they are listed under "Failures"\n`); process.exitCode = 1; }
  }
}
