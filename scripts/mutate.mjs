// Mutation gate. A full run on main; on a pull request, only the mutants lying wholly inside the src lines the PR
// changed (a PR that does not touch src still passes); the full run on every push to main catches the rest. Surviving
// or uncovered mutants inside a parser or a bounds check fail the build. An equivalent mutant is allowed
// only as `// Stryker disable next-line <Mutator>: <reason>` on that line — never
// `Stryker disable all`, and never a parser file dropped from stryker.conf.json.
//
//   node scripts/mutate.mjs                  run and judge in one process (local, or unsharded CI)
//   node scripts/mutate.mjs --shard i/N      run shard i of N; write reports/mutation/shard-i.json; no verdict
//   node scripts/mutate.mjs --merge DIR --shards N
//                                            merge the N shard reports found under DIR and judge them
//   node scripts/mutate.mjs --plan N         print the N-way partition (files and mutant counts) and exit
//   node scripts/mutate.mjs --check          judge an existing reports/mutation/mutation.json
//   node scripts/mutate.mjs --weights [REPORT...]  rewrite scripts/mutate-weights.json from full-run reports
//
// The rules live only in this file. Every mode judges with the same summarize() and the same
// verdict(); a shard only runs Stryker. The merge recomputes the partition from the commit and
// refuses a missing, extra, duplicated or partial shard, so a lost artifact cannot pass the gate.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPORT = 'reports/mutation/mutation.json';
// A converted decoder keeps its gate: `xResult` is the Result core of the throwing wrapper `x` (docs/STACK.md).
const PARSER = /^(parse[A-Z]\w*|readObjHeader|readOfsDelta|readUint32BE|readVarint|applyDelta|inflate|huffBuild|adler32|pktStep|pktFinish|pktHeader|spStep|spFinish|v2Step|parseSideband|take|assertFetched|splitHeaders|checkIdent)(Result)?$/;
// Either extension: a file keeps its gate when it converts to TypeScript.
const BOUNDS_FILES = new Set(['src/bytes.js', 'src/format.js', 'src/bytes.ts', 'src/format.ts']);
const SRC = /\.(?:js|ts)$/;
// A test file that exits non-zero without reporting a failed test (a mutant that throws while its module loads, or one
// that trips Stryker's hit limit, an infinite loop, there) is a RuntimeError to the tap runner. The test failed: the
// mutant is detected, as it was under the command runner, where any non-zero exit was Killed.
const DETECTED = new Set(['Killed', 'Timeout', 'RuntimeError']);

function commentProblems() {
  const bad = [];
  for (const file of readdirSync('src').filter(f => SRC.test(f))) {
    readFileSync(join('src', file), 'utf8').split('\n').forEach((line, i) => {
      if (/Stryker disable all\b/.test(line)) bad.push(`${file}:${i + 1} uses a blanket Stryker disable`);
      if (/Stryker disable next-line/.test(line)) {
        const reason = line.slice(line.indexOf(':') + 1).trim();
        const named = /Stryker disable next-line\s+\S[^:]*:/.test(line);
        if (!named || reason.length < 8) bad.push(`${file}:${i + 1} equivalent mutant needs "Stryker disable next-line <Mutator>: <reason>"`);
      }
    });
  }
  const cfg = readFileSync('stryker.conf.json', 'utf8');
  if (/!\s*src\/(objects|bytes|format|pack|packresolve|pktline|inflate|fetch|lsrefs)\.(?:js|ts)/.test(cfg)) {
    bad.push('stryker.conf.json excludes a parser or bounds file');
  }
  return bad;
}

function functions(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const fns = [];
  for (let i = 0; i < lines.length; i++) {
    // A top-level const starts a new owner. Otherwise pktAttrs, sitting under pktFinish, would be
    // scored as a parser survivor.
    const m = lines[i].match(/^(?:export )?(?:async )?function (\w+)/)
      || lines[i].match(/^(?:export )?const (\w+)\s*[:=]/);
    if (m) fns.push({ name: m[1], line: i + 1 });
  }
  return fns;
}

function owner(fns, line) {
  let name = '<module>';
  for (const fn of fns) if (fn.line <= line) name = fn.name;
  return name;
}

// On a pull request, the src lines it changed: file -> [[from, to], ...] (1-based, inclusive, the PR's side; a pure
// deletion borders the lines on either side of it). null on a full run (main, nightly, local, or MUTATE_FULL=1).
function changedRanges() {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request' || process.env.MUTATE_FULL === '1') return null;
  const base = process.env.MUTATE_BASE || 'origin/main';
  // --diff-filter=d: a file the PR deletes has nothing left to mutate.
  const diff = spawnSync('git', ['diff', '-U0', '--no-color', '--diff-filter=d', `${base}...HEAD`, '--', 'src'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (diff.status !== 0) {
    console.error(diff.stderr || diff.stdout);
    process.exit(diff.status || 1);
  }
  const ranges = new Map();
  let file = null;
  for (const line of diff.stdout.split('\n')) {
    if (line.startsWith('+++ ')) { const f = line.slice(4).replace(/^b\//, ''); file = f.startsWith('src/') && SRC.test(f) ? f : null; continue; }
    const h = file && /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!h) continue;
    const from = Number(h[1]), len = h[2] === undefined ? 1 : Number(h[2]);
    const r = len === 0 ? [Math.max(1, from), from + 1] : [from, from + len - 1];
    if (!ranges.has(file)) ranges.set(file, []);
    ranges.get(file).push(r);
  }
  for (const [f, rs] of ranges) {
    rs.sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const r of rs) { const last = merged.at(-1); if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else merged.push([...r]); }
    ranges.set(f, merged);
  }
  return ranges;
}
const filesToMutate = () => { const r = changedRanges(); return r && [...r.keys()].sort(); };

// Stryker applies `thresholds.break` itself, to whatever it mutated. On a pull request that is the changed files only,
// so the full-library break would fail any PR touching a file the quick suites do not reach (read.js, checkout.js: 0%).
// The PR run gets the same config with the break off; the parser/bounds rule below is its gate. A shard is a subset
// too, so it gets the same config: the break is applied by verdict() over the merged report of a full run.
function noBreakConfig(path, extra = {}) {
  const cfg = JSON.parse(readFileSync('stryker.conf.json', 'utf8'));
  mkdirSync('reports', { recursive: true });
  writeFileSync(path, JSON.stringify({ ...cfg, $schema: undefined, thresholds: { ...cfg.thresholds, break: null }, ...extra }, null, 2));
  return path;
}

function runStryker(files) {
  const args = ['stryker', 'run'];
  if (files) args.push(noBreakConfig('reports/stryker.pr.conf.json'), '--mutate', files.join(','));
  const r = spawnSync('npx', args, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// Mutants per file, from Stryker's own instrumenter with the config's mutator options: the same mutants a run would
// test, counted without running a test (about half a second for all of src/). The count is an upper bound on the cost:
// with coverageAnalysis "perTest" a mutant no quick test reaches costs nothing (NoCoverage), and a covered one runs only
// the test files that reach it.
async function mutantCounts(files) {
  const { Instrumenter } = await import('@stryker-mutator/instrumenter');
  const quiet = () => false;
  const noop = () => {};
  const logger = { isTraceEnabled: quiet, isDebugEnabled: quiet, isInfoEnabled: quiet, isWarnEnabled: quiet, isErrorEnabled: quiet, isFatalEnabled: quiet, trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
  const mutator = JSON.parse(readFileSync('stryker.conf.json', 'utf8')).mutator ?? {};
  const counts = new Map();
  for (const file of files) {
    const { mutants } = await new Instrumenter(logger).instrument([{ name: file, content: readFileSync(file, 'utf8'), mutate: true }], { plugins: null, excludedMutations: [], ...mutator, ignorers: [] });
    // The instrumenter's lines are 0-based; Stryker's --mutate ranges and its report are 1-based.
    const spans = mutants.map(m => [m.location.start.line + 1, m.location.end.line + 1]);
    counts.set(file, { total: mutants.length, active: mutants.filter(m => !m.ignoreReason).length, spans, lines: readFileSync(file, 'utf8').split('\n').length });
  }
  return counts;
}

function allSrc() {
  // The config's mutate globs are src/**/*.{js,ts}; src/ has no subdirectories today. Refuse to guess if that changes.
  const cfg = JSON.parse(readFileSync('stryker.conf.json', 'utf8'));
  if (JSON.stringify(cfg.mutate) !== JSON.stringify(['src/**/*.js', 'src/**/*.ts'])) throw new Error('mutate: sharding assumes stryker.conf.json mutate is ["src/**/*.js", "src/**/*.ts"]');
  const entries = readdirSync('src');
  if (entries.some(e => statSync(join('src', e)).isDirectory())) throw new Error('mutate: sharding assumes src/ has no subdirectories');
  return entries.filter(f => SRC.test(f)).map(f => `src/${f}`).sort();
}

// Longest-processing-time first: heaviest unit to the lightest shard. Deterministic (ties by name, then by shard index),
// so every shard and the gate compute the same plan from the same commit. A unit is a whole file on a full run; on a
// pull request, a range of lines the PR changed (Stryker's --mutate file:a-b mutates the mutants lying wholly inside
// it). A unit costing more than a shard's share is cut into ranges at lines no mutant inside it spans past (push.js runs
// the push-outcome space for every mutant it reaches). The plan records how many mutants each file's units hold; the
// merge checks the reports against that count.
async function plan(n) {
  const ranges = changedRanges();
  const files = (ranges ? [...ranges.keys()] : allSrc()).filter(f => existsSync(f)).sort();
  const counts = await mutantCounts(files);
  const cost = costModel();
  const expected = new Map();
  const costed = [];
  for (const f of files) {
    const c = counts.get(f);
    const byLine = cost(f, c);
    for (const [from, to] of ranges?.get(f) ?? [[1, c.lines]]) {
      const inside = c.spans.filter(([a, b]) => a >= from && b <= to);
      if (!inside.length) continue;
      expected.set(f, (expected.get(f) ?? 0) + inside.length);
      let weight = 0;
      for (let l = from; l <= to; l++) weight += byLine.get(l) ?? 0;
      costed.push({ file: f, from, to, whole: !ranges, inside, byLine, weight });
    }
  }
  const share = costed.reduce((t, u) => t + u.weight, 0) / n;
  const units = costed.flatMap(u => split(u, Math.ceil(u.weight / share - 1e-9)))
    .sort((a, b) => b.weight - a.weight || a.unit.localeCompare(b.unit));
  const shards = Array.from({ length: n }, () => ({ files: [], weight: 0 }));
  for (const { unit, weight } of units) {
    let best = 0;
    for (let i = 1; i < n; i++) if (shards[i].weight < shards[best].weight) best = i;
    shards[best].files.push(unit);
    shards[best].weight += weight;
  }
  for (const s of shards) s.files.sort();
  return { full: ranges === null, changed: ranges && files, files, expected, shards };
}

// A unit as k ranges of about equal measured cost, each ending on a line none of its mutants spans past. k <= 1, or a
// unit with no such line near a cut, stays whole.
function split({ file, from, to, whole, inside, byLine, weight }, k) {
  const label = (a, b) => (whole && a === from && b === to ? file : `${file}:${a}-${b}`);
  if (k <= 1) return [{ unit: label(from, to), weight }];
  const crossed = new Set();
  for (const [a, b] of inside) for (let l = a; l < b; l++) crossed.add(l);
  const upTo = new Map([[from - 1, 0]]); // cost of the unit's lines up to and including l
  for (let l = from; l <= to; l++) upTo.set(l, upTo.get(l - 1) + (byLine.get(l) ?? 0));
  const cuts = [];
  for (let j = 1; j < k; j++) {
    const want = (j * weight) / k, prev = upTo.get(cuts.at(-1) ?? from - 1);
    let best = null;
    for (let b = (cuts.at(-1) ?? from - 1) + 1; b < to; b++) {
      if (crossed.has(b) || upTo.get(b) <= prev || upTo.get(b) >= weight) continue;
      if (best === null || Math.abs(upTo.get(b) - want) < Math.abs(upTo.get(best) - want)) best = b;
    }
    if (best !== null) cuts.push(best);
  }
  const bounds = [from - 1, ...cuts, to];
  return bounds.slice(1).map((b, i) => ({ unit: label(bounds[i] + 1, b), weight: upTo.get(b) - upTo.get(bounds[i]) }));
}

const unitFile = unit => unit.replace(/:\d+-\d+$/, '');

// With per-test coverage a mutant's cost is the test files that reach it, not 1: linemerge.js (13% of the mutants) is all
// NoCoverage and free, while a push.js mutant can run the push-outcome space. scripts/mutate-weights.json holds measured
// seconds of test time per file and per line (by the line a mutant starts on), from full-run reports (refresh with
// --weights REPORT...; the first report holding a file wins). A line with no entry costs the file's mean seconds per
// mutant for each mutant starting there; a file with no entry, the median known rate. Committed, so every shard and the
// gate compute the same plan.
const WEIGHTS = 'scripts/mutate-weights.json';
function costModel() {
  const known = existsSync(WEIGHTS) ? JSON.parse(readFileSync(WEIGHTS, 'utf8')) : {};
  const rates = Object.values(known).filter(w => w.mutants > 0).map(w => w.seconds / w.mutants).sort((a, b) => a - b);
  const median = rates.length ? rates[rates.length >> 1] : 1;
  // Seconds per line for this file's current mutants (spans from the instrumenter).
  return (file, { spans }) => {
    const w = known[file];
    const rate = w?.mutants ? w.seconds / w.mutants : median;
    const startsAt = new Map();
    for (const [a] of spans) startsAt.set(a, (startsAt.get(a) ?? 0) + 1);
    const byLine = new Map();
    for (const [line, n] of startsAt) byLine.set(line, w?.byLine?.[line] ?? n * rate);
    return byLine;
  };
}

function writeWeights(paths) {
  const out = {};
  for (const path of paths) {
    const files = JSON.parse(readFileSync(path, 'utf8')).files ?? {};
    for (const [file, info] of Object.entries(files)) {
      if (out[file]) continue;
      const mutants = info.mutants ?? [];
      const byLine = {};
      for (const m of mutants) byLine[m.location.start.line] = (byLine[m.location.start.line] ?? 0) + (m.duration ?? 0) / 1000;
      for (const k of Object.keys(byLine)) byLine[k] = Math.round(byLine[k] * 10) / 10;
      out[file] = { seconds: Math.round(mutants.reduce((t, m) => t + (m.duration ?? 0), 0) / 100) / 10, mutants: mutants.filter(m => m.status !== 'Ignored').length, byLine };
    }
  }
  const sorted = Object.fromEntries(Object.keys(out).sort().map(k => [k, out[k]]));
  writeFileSync(WEIGHTS, JSON.stringify(sorted) + '\n');
  console.log(`mutate: wrote ${WEIGHTS} from ${paths.join(', ')} (${Object.keys(out).length} files)`);
}

function parseShard(arg) {
  const m = /^(\d+)\/(\d+)$/.exec(arg ?? '');
  const i = m ? Number(m[1]) : NaN, n = m ? Number(m[2]) : NaN;
  if (!(n >= 1 && i >= 1 && i <= n)) {
    console.error(`mutate: --shard wants i/N with 1 <= i <= N, got ${arg}`);
    process.exit(2);
  }
  return { i, n };
}

const shardReport = i => `reports/mutation/shard-${i}.json`;

async function runShard(i, n) {
  const p = await plan(n);
  const mine = p.shards[i - 1];
  console.log(`mutate: shard ${i}/${n} of ${p.full ? 'full src/' : `${p.changed.length} changed file(s)`}; planned seconds per shard ${p.shards.map(s => Math.round(s.weight)).join(', ')}`);
  mkdirSync('reports/mutation', { recursive: true });
  if (mine.files.length === 0) {
    writeFileSync(shardReport(i), JSON.stringify({ shard: { i, n, files: [] }, files: {} }));
    console.log(`mutate: shard ${i}/${n} has no files; wrote an empty report`);
    return;
  }
  console.log(`${mine.files.join('\n')}\n(${Math.round(mine.weight)} planned seconds)`);
  // Own report path and temp dir (under .stryker-tmp, which ignorePatterns already excludes), so shards can run side
  // by side in one checkout.
  const cfg = noBreakConfig(`reports/stryker.shard-${i}.conf.json`, {
    tempDirName: `.stryker-tmp/shard-${i}`,
    jsonReporter: { fileName: shardReport(i) },
  });
  const r = spawnSync('npx', ['stryker', 'run', cfg, '--mutate', mine.files.join(',')], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  const report = JSON.parse(readFileSync(shardReport(i), 'utf8'));
  report.shard = { i, n, files: mine.files };
  writeFileSync(shardReport(i), JSON.stringify(report));
}

function findReports(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...findReports(p));
    else if (/^shard-\d+\.json$/.test(e)) out.push(p);
  }
  return out;
}

// Union of the shard reports, after checking that together they are exactly the plan: each shard once, each shard's
// files exactly its planned files, each planned file in one report. Anything else fails the gate.
async function mergeReports(dir, n) {
  const p = await plan(n);
  const bad = [];
  const seen = new Map();
  for (const path of findReports(dir)) {
    const r = JSON.parse(readFileSync(path, 'utf8'));
    const i = r.shard?.i;
    if (r.shard?.n !== n || !(i >= 1 && i <= n)) { bad.push(`${path}: shard ${JSON.stringify(r.shard)} is not one of ${n}`); continue; }
    if (seen.has(i)) { bad.push(`${path}: shard ${i} reported twice (also ${seen.get(i).path})`); continue; }
    seen.set(i, { path, r });
  }
  const merged = { files: {} };
  for (let i = 1; i <= n; i++) {
    const want = p.shards[i - 1].files;
    const got = seen.get(i);
    if (!got) { bad.push(`shard ${i}/${n}: no report (planned ${want.length} file(s))`); continue; }
    const { r } = got;
    if (JSON.stringify(r.shard.files) !== JSON.stringify(want)) bad.push(`shard ${i}/${n}: ran ${JSON.stringify(r.shard.files)}, plan is ${JSON.stringify(want)}`);
    const keys = Object.keys(r.files ?? {}).sort();
    const wantFiles = [...new Set(want.map(unitFile))].sort();
    if (JSON.stringify(keys) !== JSON.stringify(wantFiles)) bad.push(`shard ${i}/${n}: report covers ${JSON.stringify(keys)}, plan is ${JSON.stringify(wantFiles)}`);
    for (const [file, info] of Object.entries(r.files ?? {})) {
      if (merged.files[file]) merged.files[file] = { ...merged.files[file], mutants: [...merged.files[file].mutants, ...(info.mutants ?? [])] };
      else merged.files[file] = info;
    }
    for (const k of Object.keys(r)) if (k !== 'files' && k !== 'shard' && !(k in merged)) merged[k] = r[k];
  }
  // Every mutant of every planned file exactly once: a lost range, or a mutant no range held, is a short count.
  for (const file of new Set(p.shards.flatMap(sh => sh.files.map(unitFile)))) {
    const ms = merged.files[file]?.mutants ?? [];
    const keys = new Set(ms.map(m => `${m.location.start.line}:${m.location.start.column}-${m.location.end.line}:${m.location.end.column} ${m.mutatorName} ${m.replacement}`));
    if (ms.length !== p.expected.get(file) || keys.size !== ms.length) bad.push(`${file}: ${ms.length} mutant(s) reported (${keys.size} distinct), the plan's ranges hold ${p.expected.get(file)}`);
  }
  if (bad.length) {
    console.error(`mutate: shard reports do not match the plan\n${bad.join('\n')}`);
    process.exit(1);
  }
  console.log(`mutate: merged ${n} shard report(s), ${Object.keys(merged.files).length} file(s), every planned mutant once, of ${p.full ? 'full src/' : `the lines ${p.changed.length} changed file(s) changed`}`);
  mkdirSync('reports/mutation', { recursive: true });
  writeFileSync(REPORT, JSON.stringify(merged));
  return merged;
}

function loadReport() {
  if (!existsSync(REPORT)) {
    console.error(`no mutation report at ${REPORT}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(REPORT, 'utf8'));
}

function summarize(report) {
  const fileMap = report.files ?? {};
  const rows = [];
  const violations = [];
  let detected = 0, survived = 0, ignored = 0;
  for (const [file, info] of Object.entries(fileMap)) {
    const mutants = info.mutants ?? [];
    const fns = existsSync(file) ? functions(file) : [];
    const counts = {};
    for (const m of mutants) {
      const status = m.status;
      counts[status] = (counts[status] ?? 0) + 1;
      if (DETECTED.has(status)) detected++;
      else if (status === 'Ignored') ignored++;
      else survived++;
      const line = m.location?.start?.line ?? 0;
      const fn = owner(fns, line);
      const strict = BOUNDS_FILES.has(file) || PARSER.test(fn);
      if (strict && (status === 'Survived' || status === 'NoCoverage')) {
        violations.push(`${file}:${line} ${fn} ${m.mutatorName} ${status}${m.replacement ? ` → ${String(m.replacement).slice(0, 60)}` : ''}`);
      }
    }
    const det = (counts.Killed ?? 0) + (counts.Timeout ?? 0) + (counts.RuntimeError ?? 0);
    const sur = (counts.Survived ?? 0) + (counts.NoCoverage ?? 0);
    const score = det + sur === 0 ? 100 : (100 * det) / (det + sur);
    rows.push({ file, score, killed: counts.Killed ?? 0, timeout: counts.Timeout ?? 0, survived: counts.Survived ?? 0, noCoverage: counts.NoCoverage ?? 0, ignored: counts.Ignored ?? 0, total: mutants.length });
  }
  rows.sort((a, b) => a.file.localeCompare(b.file));
  const score = detected + survived === 0 ? 100 : (100 * detected) / (detected + survived);
  return { rows, violations, score, detected, survived, ignored };
}

function verdict(report) {
  const { rows, violations, score, detected, survived, ignored } = summarize(report);
  const breakAt = JSON.parse(readFileSync('stryker.conf.json', 'utf8')).thresholds?.break;
  // A pull request mutates only the files it changed. That subset's percentage is not
  // comparable to the full-library break, so the threshold applies to a full run.
  const fullRun = process.env.GITHUB_EVENT_NAME !== 'pull_request' || process.env.MUTATE_FULL === '1';
  printRows(rows);
  console.log(`\nscore ${score.toFixed(2)}  (${detected} detected, ${survived} survived/uncovered, ${ignored} ignored)`);
  if (fullRun && breakAt !== null && breakAt !== undefined && score + 1e-9 < breakAt) {
    console.error(`mutation score ${score.toFixed(2)} is below the break threshold ${breakAt}`);
    process.exit(1);
  }
  if (violations.length) {
    console.error(`\n${violations.length} surviving mutant(s) in a parser or bounds check:`);
    console.error(violations.join('\n'));
    process.exit(1);
  }
}

function printRows(rows) {
  console.log('\nper-file mutation score');
  console.log('file                         score   killed  timeout  survived  uncovered  ignored');
  for (const r of rows) {
    console.log(`${r.file.padEnd(28)} ${r.score.toFixed(1).padStart(5)}  ${String(r.killed).padStart(6)}  ${String(r.timeout).padStart(7)}  ${String(r.survived).padStart(8)}  ${String(r.noCoverage).padStart(9)}  ${String(r.ignored).padStart(7)}`);
  }
}

function argValue(flag) {
  const k = process.argv.indexOf(flag);
  return k === -1 ? undefined : process.argv[k + 1];
}

const problems = commentProblems();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

if (process.argv.includes('--weights')) {
  const k = process.argv.indexOf('--weights');
  const paths = process.argv.slice(k + 1).filter(a => !a.startsWith('--'));
  writeWeights(paths.length ? paths : [REPORT]);
} else if (process.argv.includes('--plan')) {
  const n = Number(argValue('--plan'));
  if (!(n >= 1)) {
    console.error('mutate: --plan wants N >= 1');
    process.exit(2);
  }
  const p = await plan(n);
  console.log(JSON.stringify({ full: p.full, shards: p.shards }, null, 2));
} else if (process.argv.includes('--shard')) {
  const { i, n } = parseShard(argValue('--shard'));
  await runShard(i, n);
  // Per-shard table for the log only. The verdict is the merge's.
  printRows(summarize(JSON.parse(readFileSync(shardReport(i), 'utf8'))).rows);
} else if (process.argv.includes('--merge')) {
  const dir = argValue('--merge');
  const n = Number(argValue('--shards'));
  if (!dir || !existsSync(dir) || !(n >= 1)) {
    console.error('mutate: --merge wants an existing directory and --shards N');
    process.exit(2);
  }
  verdict(await mergeReports(dir, n));
} else {
  if (!process.argv.includes('--check')) {
    const units = filesToMutate() && (await plan(1)).shards[0].files;
    if (units && units.length === 0) {
      console.log('mutate: pull request changes no mutable src/ line; skipping');
      process.exit(0);
    }
    if (units) console.log(`mutate: the lines the pull request changed\n${units.join('\n')}`);
    else console.log('mutate: full src/');
    runStryker(units);
  }
  verdict(loadReport());
}
