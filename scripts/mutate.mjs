// Mutation gate. A full run on main; on a pull request, the mutants lying wholly inside the src lines the PR changed,
// plus every line the gate judges strictly (gatedRanges: each parser function, each bounds file), whatever the PR
// changed; the full run on every push to main catches the rest. Surviving or uncovered mutants inside a parser or a
// bounds check fail the build. An equivalent mutant is allowed only as
// `// Stryker disable next-line <Mutator>: <reason>` on that line — never `Stryker disable all`, and never a parser file
// dropped from stryker.conf.json.
//
//   node scripts/mutate.mjs                  run and judge in one process (local, or unsharded CI)
//   node scripts/mutate.mjs --shard i/N      run shard i of N; write reports/mutation/shard-i.json; no verdict
//   node scripts/mutate.mjs --merge DIR --shards N
//                                            merge the N shard reports found under DIR and judge them
//   node scripts/mutate.mjs --plan N         print the N-way partition (units, planned seconds, mutant counts) and exit
//   node scripts/mutate.mjs --check          judge an existing reports/mutation/mutation.json
//   node scripts/mutate.mjs --weights [REPORT...]  rewrite scripts/mutate-weights.json from full-run reports
//   node scripts/mutate.mjs --weights-pr REPORT...  rewrite scripts/mutate-weights-pr.json from pull request shard
//                                            reports, newest first (a pull request plans from this table)
//
// The rules live only in this file. Every mode judges with the same summarize() and the same
// verdict(); a shard only runs Stryker. The merge recomputes the partition from the commit and
// refuses a missing, extra, duplicated or partial shard, so a lost artifact cannot pass the gate.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPORT = 'reports/mutation/mutation.json';
// A converted decoder keeps its gate: `xResult` is the Result core of the throwing wrapper `x` (docs/STACK.md).
const PARSER = /^(parse[A-Z]\w*|readObjHeader|readOfsDelta|readUint32BE|readVarint|applyDelta|inflate\w*|huffBuild|adler32|pktStep|pktFinish|pktHeader|spStep|spFinish|v2Step|parseSideband|sidebandStep|member[A-Z]\w*|take|assertFetched|splitHeaders|checkIdent)(Result)?$/;
// Either extension: a file keeps its gate when it converts to TypeScript. The pull codecs (#172) are decoders in every
// function, their step helpers included: the whole file is gated.
// The large-repo stack reads stored and remote state (a spooled pack, a saved index, a plan read back, a host's report)
// and bounds what it holds by configuration: the scan index, the range resolver, the subset cutter, the batch planner,
// the pull codecs and the exchange deadline are gated whole, like the files above. So are the names a plan read back is
// checked with (transfernames.ts), the resume loop that classifies each step's outcome (transfer.ts: landed, refused,
// ambiguous, resend) and the loader that decides whether a saved index is used (transferload.ts).
const BOUNDS_FILES = new Set([
  'src/bytes.js', 'src/format.js', 'src/bytes.ts', 'src/format.ts', 'src/inflatestream.ts', 'src/packstream.ts',
  'src/packscanindex.ts', 'src/packrangeresolve.ts', 'src/packsubset.ts', 'src/packplan.ts', 'src/pullstream.ts', 'src/deadline.ts',
  'src/transfernames.ts', 'src/transfer.ts', 'src/transferload.ts',
]);
// Files gated by owner. The rule is fail-safe: every top-level owner of a file listed here is strict (the lines above
// the first one too, as <module>) unless its name is exempt, so a new or renamed function is judged strictly until
// someone writes down why it is not. Each entry says what is exempt and why a survivor there is left to the full run's
// threshold. test/mutate-plan.test.js holds both lists by hand and fails when a file gains an owner that is in neither.
const EXEMPT_OWNERS = new Map([
  // The saved index. Exempt: its encoder (it writes this process's own, trusted state; decodeSavedIndex round-trips
  // it in test/pack-saved.test.js) and the refusal's text for people (no decision reads it). Strict: everything the
  // decoder is made of: the layout, the cursor, the type checks, the refusals, the constants it checks against, and
  // the pack identity read from the source.
  ['src/packsaved.ts', /^(putF64s|putI32s|putBytes|encodeSavedIndex|describeRefusal)$/],
  // The transfer plan. Exempt: the planner, which builds a plan from the caller's own resolved index (its objects and
  // steps are compared with real ones in test/transfer.test.js). Strict: the check of a plan read back and the
  // canonical form and hash under it (TRANSFER_VERSION, optionJson, stepJson, canonical, transferPlanHash, edited,
  // wellFormedStep, checkTransferPlan).
  ['src/transferplan.ts', /^(OBJ_BLOB|OBJ_COMMIT|OBJ_TREE|MODE_BLOB|MODE_TREE|TRANSFER_REF_PREFIX|TRANSFER_IDENT|TRANSFER_GENERATED_OBJECTS|GEN_BYTES_PER_OBJECT|GEN_BYTES_FIXED|SIGNATURE_HEADERS|outOfRange|entryAt|batchTrees|commitObject|tempCommit|unsigned|rootCommit|reserved|treeEntries|tempFor|planSteps|planTransfer|transferKey)$/],
  // push. Exempt: building the request from the caller's own options (commands, caps, bodies, the plan), the drivers
  // that only move bytes between the transport and the decoders below, and span attributes. Strict: everything that
  // reads the host's answer or turns it into an outcome: the sideband and report decoders and their caps, the unpack
  // and ng classes and their tables, the too-large parse, the outcome decision and its Result, and the resolution of
  // an ambiguous push (a wrong class turns a refusal into a retry, or a landed push into a failure).
  ['src/push.ts', /^(SHORT_OID|isParsed|nonEmpty|pkts|pushBody|pushDefaults|requestCap|requestCaps|unchecked|checkBases|planPush|requestBody|readResponse|outcomeAttrs|objectTypeAttr|bodyOf|send|receivePack|push|isPackLength|planPackPush|sendSource|pushPackChecked)$/],
  // The receive-pack advertisement and the capability check before a push (checkPushCaps, pushPack: a missing
  // capability is `unsupported` before any byte is sent). Exempt: the problem's text for people and the length of the
  // line preview inside it.
  ['src/receivecaps.ts', /^(LINE_PREVIEW|problemText)$/],
]);
// Left out, and why: src/packwrite.ts (streamPack and its helpers encode a pack from objects this process already
// holds, the write side; test/packwrite.test.js compares its bytes with the buffered writer's) and src/rangesource.ts
// (the storage interface and its in-memory adapter over the caller's own bytes; it decodes nothing). Neither decodes
// or classifies stored or remote state; both stay under the full run's threshold.
const MODULE = '<module>';
// The one rule both the plan (gatedRanges) and the verdict (summarize) ask: is this owner of this file judged strictly?
const isStrict = (file, fn) => BOUNDS_FILES.has(file) || PARSER.test(fn) || (EXEMPT_OWNERS.has(file) && !EXEMPT_OWNERS.get(file).test(fn));
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
  if (/!\s*src\/(objects|bytes|format|pack|packresolve|pktline|inflate|fetch|lsrefs|packsaved|packscanindex|packrangeresolve|packsubset|packplan|transferplan|transfernames|transferload|transfer|receivecaps|pullstream|deadline|push)\.(?:js|ts)/.test(cfg)) {
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
  let name = MODULE;
  for (const fn of fns) if (fn.line <= line) name = fn.name;
  return name;
}

// The mutants summarize() judges strictly, as line ranges: file -> [[from, to], ...] (1-based, inclusive). A bounds
// file is the whole file; elsewhere a range is a PARSER-named owner from its declaration line up to the line before the
// next owner's (owner() gives a mutant to the last declaration at or above its first line, so these are exactly the
// lines a strict mutant can start on). A pull request mutates them all, changed or not: a PR that only moves a parser,
// or changes a test it relies on, changes no line of it, and its survivors would first show on main (41976594897: five
// in parseHttpOptions and parseLsRefLine after #198 moved them). Same functions(), owner rule, PARSER and BOUNDS_FILES
// as the verdict, so the two cannot drift.
function gatedRanges(files) {
  const out = new Map();
  for (const file of files) {
    const last = readFileSync(file, 'utf8').split('\n').length;
    if (BOUNDS_FILES.has(file)) { out.set(file, [[1, last]]); continue; }
    // owner() gives the lines above the first declaration to <module>: a range of its own, strict in an owner-gated file.
    const declared = functions(file);
    const fns = declared[0]?.line === 1 ? declared : [{ name: MODULE, line: 1 }, ...declared];
    const rs = fns.flatMap((fn, k) => (isStrict(file, fn.name) ? [[fn.line, (fns[k + 1]?.line ?? last + 1) - 1]] : []));
    if (rs.length) out.set(file, rs);
  }
  return out;
}

// Sorted, overlapping or adjacent ranges joined: each mutant lies inside at most one, so the plan counts it once.
function mergeRanges(rs) {
  const merged = [];
  for (const r of [...rs].sort((x, y) => x[0] - y[0])) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else merged.push([...r]);
  }
  return merged;
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
  for (const [f, rs] of ranges) ranges.set(f, mergeRanges(rs));
  return ranges;
}

// What a pull request mutates: the lines it changed and every strictly gated line (gatedRanges), merged per file.
// null on a full run.
function prRanges() {
  const changed = changedRanges();
  if (!changed) return null;
  const out = new Map(changed);
  for (const [f, rs] of gatedRanges(allSrc())) out.set(f, mergeRanges([...(out.get(f) ?? []), ...rs]));
  return out;
}

// Stryker applies `thresholds.break` itself, to whatever it mutated. On a pull request that is the changed and gated
// lines only, so the full-library break would fail any PR touching a file the quick suites do not reach (read.js,
// checkout.js: 0%).
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
// pull request, a range of lines the PR changed or the gate judges strictly (prRanges; Stryker's --mutate file:a-b
// mutates the mutants lying wholly inside it). A unit costing more than a shard's share is cut into ranges at lines no
// mutant inside it spans past (push.js runs the push-outcome space for every mutant it reaches); a function whose body
// is one block mutant cannot be cut, so the heaviest gated parser (parseTree) bounds a pull request's shard time. The
// plan records how many mutants each file's units hold; the merge checks the reports against that count.
async function plan(n) {
  const ranges = prRanges();
  const files = (ranges ? [...ranges.keys()] : allSrc()).filter(f => existsSync(f)).sort();
  const counts = await mutantCounts(files);
  const cost = costModel(ranges !== null);
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
  return { full: ranges === null, files, expected, shards };
}

// A unit as k ranges of about equal measured cost, each ending on a line none of its mutants spans past. k <= 1, or a
// unit with no such line near a cut, stays whole. A slice no mutant lies wholly inside is dropped: line cost counts
// every mutant that *starts* on the line, including one that ends outside the changed range (Stryker's --mutate
// range keeps only a mutant wholly inside it). Such a slice mutates nothing, the report has no file entry, and the
// merge rejects it (http.ts:106 and http.ts:228 on #133).
function split({ file, from, to, whole, inside, byLine, weight }, k) {
  const label = (a, b) => (whole && a === from && b === to ? file : `${file}:${a}-${b}`);
  const held = (a, b) => inside.some(([s, e]) => s >= a && e <= b);
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
  return bounds.slice(1).flatMap((b, i) => {
    const start = bounds[i] + 1;
    if (!held(start, b)) return [];
    return [{ unit: label(start, b), weight: upTo.get(b) - upTo.get(bounds[i]) }];
  });
}

const unitFile = unit => unit.replace(/:\d+-\d+$/, '');

// With per-test coverage a mutant's cost is the test files that reach it, not 1: linemerge.js (13% of the mutants) is all
// NoCoverage and free, while a push.js mutant can run the push-outcome space. scripts/mutate-weights.json holds measured
// seconds of test time per file and per line (by the line a mutant starts on), from full-run reports (refresh with
// --weights REPORT...; the first report holding a file wins). A line with no entry costs the file's mean seconds per
// mutant for each mutant starting there; a file with no entry, the median known rate. Committed, so every shard and the
// gate compute the same plan.
// A pull request has its own table, scripts/mutate-weights-pr.json, measured from pull request shard reports
// (--weights-pr REPORT...): the same line costs a different amount in the two modes, so one table cannot plan both.
// On #243/#244 the PR runs cost attributes.ts:235-300 at 5,943-6,604 s (the full-run table said 413 s, so the
// planner never cut it and one shard ran 36-51 min) and objects.ts:279-347 at 11 s (the full run measured 3,688 s).
// A pull request plans from its table, falling back per line to the full-run table, then to a rate.
const WEIGHTS = 'scripts/mutate-weights.json';
const WEIGHTS_PR = 'scripts/mutate-weights-pr.json';
const readWeights = path => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
function costModel(pr) {
  const full = readWeights(WEIGHTS);
  const tables = pr ? [readWeights(WEIGHTS_PR), full] : [full];
  const rates = Object.values(full).filter(w => w.mutants > 0).map(w => w.seconds / w.mutants).sort((a, b) => a - b);
  const median = rates.length ? rates[rates.length >> 1] : 1;
  // Seconds per line for this file's current mutants (spans from the instrumenter).
  return (file, { spans }) => {
    const ws = tables.map(t => t[file]);
    const known = ws.find(w => w?.mutants);
    const rate = known ? known.seconds / known.mutants : median;
    const startsAt = new Map();
    for (const [a] of spans) startsAt.set(a, (startsAt.get(a) ?? 0) + 1);
    const byLine = new Map();
    for (const [line, n] of startsAt) byLine.set(line, ws.map(w => w?.byLine?.[line]).find(s => s !== undefined) ?? n * rate);
    return byLine;
  };
}

// Measured seconds per file and per line (by the line a mutant starts on). Merged by line: the first report holding a
// line wins it, so a file a full run split across shards, or that several pull requests each covered in part, keeps
// every measured line (holding only a file's first report dropped the rest: inflatestream.ts on main's 16-way plan).
// seconds and mutants are the totals over the kept lines.
function writeWeights(paths, target) {
  const out = {};
  for (const path of paths) {
    const files = JSON.parse(readFileSync(path, 'utf8')).files ?? {};
    for (const [file, info] of Object.entries(files)) {
      const lines = new Map();
      for (const m of info.mutants ?? []) {
        const l = m.location.start.line;
        const e = lines.get(l) ?? { s: 0, n: 0 };
        e.s += (m.duration ?? 0) / 1000;
        if (m.status !== 'Ignored') e.n += 1;
        lines.set(l, e);
      }
      const w = (out[file] ??= { seconds: 0, mutants: 0, byLine: {} });
      for (const [l, { s, n }] of lines) {
        if (w.byLine[l] !== undefined) continue;
        w.byLine[l] = Math.round(s * 10) / 10;
        w.seconds += s;
        w.mutants += n;
      }
    }
  }
  for (const w of Object.values(out)) w.seconds = Math.round(w.seconds * 10) / 10;
  const sorted = Object.fromEntries(Object.keys(out).sort().map(k => [k, out[k]]));
  writeFileSync(target, JSON.stringify(sorted) + '\n');
  console.log(`mutate: wrote ${target} from ${paths.length} report(s) (${Object.keys(out).length} files)`);
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
  console.log(`mutate: shard ${i}/${n} of ${p.full ? 'full src/' : `${p.files.length} file(s): changed and gated lines`}; planned seconds per shard ${p.shards.map(s => Math.round(s.weight)).join(', ')}`);
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
  console.log(`mutate: merged ${n} shard report(s), ${Object.keys(merged.files).length} file(s), every planned mutant once, of ${p.full ? 'full src/' : `the changed and gated lines of ${p.files.length} file(s)`}`);
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
      const strict = isStrict(file, fn);
      if (strict && (status === 'Survived' || status === 'NoCoverage')) {
        violations.push({ file, line, column: m.location?.start?.column ?? 0, text: `${file}:${line} ${fn} ${m.mutatorName} ${status}${m.replacement ? ` → ${String(m.replacement).replace(/\s+/g, ' ').slice(0, 120)}` : ''}` });
      }
    }
    const det = (counts.Killed ?? 0) + (counts.Timeout ?? 0) + (counts.RuntimeError ?? 0);
    const sur = (counts.Survived ?? 0) + (counts.NoCoverage ?? 0);
    const score = det + sur === 0 ? 100 : (100 * det) / (det + sur);
    rows.push({ file, score, killed: counts.Killed ?? 0, timeout: counts.Timeout ?? 0, survived: counts.Survived ?? 0, noCoverage: counts.NoCoverage ?? 0, ignored: counts.Ignored ?? 0, total: mutants.length });
  }
  rows.sort((a, b) => a.file.localeCompare(b.file));
  const score = detected + survived === 0 ? 100 : (100 * detected) / (detected + survived);
  // One list in source order (file, line, column), whatever order the shard reports were merged in; one line each.
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  return { rows, violations: violations.map(v => v.text), score, detected, survived, ignored };
}

// Every reason the run fails is printed before the one exit: a score below the break does not hide the list of fatal
// survivors (it used to exit first), so one run names everything there is to kill.
function verdict(report) {
  const { rows, violations, score, detected, survived, ignored } = summarize(report);
  const breakAt = JSON.parse(readFileSync('stryker.conf.json', 'utf8')).thresholds?.break;
  // A pull request mutates only the files it changed. That subset's percentage is not
  // comparable to the full-library break, so the threshold applies to a full run.
  const fullRun = process.env.GITHUB_EVENT_NAME !== 'pull_request' || process.env.MUTATE_FULL === '1';
  printRows(rows);
  console.log(`\nscore ${score.toFixed(2)}  (${detected} detected, ${survived} survived/uncovered, ${ignored} ignored)`);
  let failed = false;
  if (fullRun && breakAt !== null && breakAt !== undefined && score + 1e-9 < breakAt) {
    console.error(`mutation score ${score.toFixed(2)} is below the break threshold ${breakAt}`);
    failed = true;
  }
  if (violations.length) {
    console.error(`\n${violations.length} surviving mutant(s) in a parser or bounds check:`);
    console.error(violations.join('\n'));
    failed = true;
  }
  if (failed) process.exit(1);
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

if (process.argv.includes('--weights-pr')) {
  const k = process.argv.indexOf('--weights-pr');
  const paths = process.argv.slice(k + 1).filter(a => !a.startsWith('--'));
  if (!paths.length) {
    console.error('mutate: --weights-pr wants pull request shard reports (newest first)');
    process.exit(2);
  }
  writeWeights(paths, WEIGHTS_PR);
} else if (process.argv.includes('--weights')) {
  const k = process.argv.indexOf('--weights');
  const paths = process.argv.slice(k + 1).filter(a => !a.startsWith('--'));
  writeWeights(paths.length ? paths : [REPORT], WEIGHTS);
} else if (process.argv.includes('--plan')) {
  const n = Number(argValue('--plan'));
  if (!(n >= 1)) {
    console.error('mutate: --plan wants N >= 1');
    process.exit(2);
  }
  const p = await plan(n);
  const mutants = [...p.expected.values()].reduce((t, k) => t + k, 0);
  console.log(JSON.stringify({ full: p.full, mutants, expected: Object.fromEntries(p.expected), shards: p.shards }, null, 2));
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
    const p = await plan(1);
    const units = p.full ? null : p.shards[0].files;
    if (units && units.length === 0) {
      console.log('mutate: pull request changes no mutable src/ line and no line is gated; skipping');
      process.exit(0);
    }
    if (units) console.log(`mutate: the lines the pull request changed, and every gated line\n${units.join('\n')}`);
    else console.log('mutate: full src/');
    runStryker(units);
  }
  verdict(loadReport());
}
