// Mutation gate. A full run on main; on a pull request, only the src files the PR
// changed (a PR that does not touch src still passes). Surviving or uncovered mutants
// inside a parser or a bounds check fail the build. An equivalent mutant is allowed
// only as `// Stryker disable next-line <Mutator>: <reason>` on that line — never
// `Stryker disable all`, and never a parser file dropped from stryker.conf.json.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPORT = 'reports/mutation/mutation.json';
const PARSER = /^(parse[A-Z]\w*|readObjHeader|readOfsDelta|readUint32BE|readVarint|applyDelta|inflate|huffBuild|adler32|pktStep|pktFinish|spStep|spFinish|v2Step|parseSideband|take|assertFetched|splitHeaders|checkIdent)$/;
const BOUNDS_FILES = new Set(['src/bytes.js', 'src/format.js']);

function commentProblems() {
  const bad = [];
  for (const file of readdirSync('src').filter(f => f.endsWith('.js'))) {
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
  if (/!\s*src\/(objects|bytes|format|pack|packresolve|pktline|inflate|fetch|lsrefs)\.js/.test(cfg)) {
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
      || lines[i].match(/^(?:export )?const (\w+)\s*=/);
    if (m) fns.push({ name: m[1], line: i + 1 });
  }
  return fns;
}

function owner(fns, line) {
  let name = '<module>';
  for (const fn of fns) if (fn.line <= line) name = fn.name;
  return name;
}

function filesToMutate() {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') return null;
  const base = process.env.MUTATE_BASE || 'origin/main';
  const diff = spawnSync('git', ['diff', '--name-only', `${base}...HEAD`, '--', 'src'], { encoding: 'utf8' });
  if (diff.status !== 0) {
    console.error(diff.stderr || diff.stdout);
    process.exit(diff.status || 1);
  }
  return diff.stdout.split('\n').map(s => s.trim()).filter(f => f.startsWith('src/') && f.endsWith('.js'));
}

function runStryker(files) {
  const args = ['stryker', 'run'];
  if (files) args.push('--mutate', files.join(','));
  const r = spawnSync('npx', args, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
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
      if (status === 'Killed' || status === 'Timeout') detected++;
      else if (status === 'Ignored') ignored++;
      else survived++;
      const line = m.location?.start?.line ?? 0;
      const fn = owner(fns, line);
      const strict = BOUNDS_FILES.has(file) || PARSER.test(fn);
      if (strict && (status === 'Survived' || status === 'NoCoverage')) {
        violations.push(`${file}:${line} ${fn} ${m.mutatorName} ${status}${m.replacement ? ` → ${String(m.replacement).slice(0, 60)}` : ''}`);
      }
    }
    const det = (counts.Killed ?? 0) + (counts.Timeout ?? 0);
    const sur = (counts.Survived ?? 0) + (counts.NoCoverage ?? 0);
    const score = det + sur === 0 ? 100 : (100 * det) / (det + sur);
    rows.push({ file, score, killed: counts.Killed ?? 0, timeout: counts.Timeout ?? 0, survived: counts.Survived ?? 0, noCoverage: counts.NoCoverage ?? 0, ignored: counts.Ignored ?? 0, total: mutants.length });
  }
  rows.sort((a, b) => a.file.localeCompare(b.file));
  const score = detected + survived === 0 ? 100 : (100 * detected) / (detected + survived);
  return { rows, violations, score, detected, survived, ignored };
}

const problems = commentProblems();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

const checkOnly = process.argv.includes('--check');
if (!checkOnly) {
  const files = filesToMutate();
  if (files && files.length === 0) {
    console.log('mutate: pull request does not change src/; skipping');
    process.exit(0);
  }
  if (files) console.log(`mutate: ${files.length} changed file(s)\n${files.join('\n')}`);
  else console.log('mutate: full src/');
  runStryker(files);
}

const { rows, violations, score, detected, survived, ignored } = summarize(loadReport());
const breakAt = JSON.parse(readFileSync('stryker.conf.json', 'utf8')).thresholds?.break;
// A pull request mutates only the files it changed. That subset's percentage is not
// comparable to the full-library break, so the threshold applies to a full run.
const fullRun = process.env.GITHUB_EVENT_NAME !== 'pull_request';
console.log('\nper-file mutation score');
console.log('file                         score   killed  timeout  survived  uncovered  ignored');
for (const r of rows) {
  console.log(`${r.file.padEnd(28)} ${r.score.toFixed(1).padStart(5)}  ${String(r.killed).padStart(6)}  ${String(r.timeout).padStart(7)}  ${String(r.survived).padStart(8)}  ${String(r.noCoverage).padStart(9)}  ${String(r.ignored).padStart(7)}`);
}
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
