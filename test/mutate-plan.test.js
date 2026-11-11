// scripts/mutate.mjs on a pull request mutates every line the gate judges strictly, not only the lines the PR changed.
// #198 moved parseHttpOptions and parseLsRefLine without changing their text: no line of theirs was in the diff, the PR's
// mutation run never reached them, and main's full run found five survivors there (run 41976594897). Here a PR that
// only moves a helper past a parser leaves the parser's lines out of the diff; the plan still holds all of them, and
// still leaves out an ungated function the PR did not change.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/mutate.mjs');

// parseFrame is gated (PARSER); helper and other are not. 40 statements, so git's diff moves the 3-line helper, not
// the parser.
const parser = [
  'export function parseFrame(b: Uint8Array): number {',
  '  let n = 0;',
  ...Array.from({ length: 40 }, (_, i) => `  if (b[${i}] === ${i + 1}) n += ${i + 2};`),
  '  return n;',
  '}',
];
const helper = ['export function helper(x: number): number {', '  return x > 1 ? x * 2 : x - 3;', '}'];
const other = ['export function other(x: number): number {', '  return x < 4 ? x + 5 : x * 6;', '}'];
const lines = parts => parts.flat().join('\n') + '\n';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function prPlan(cwd, base) {
  const env = { ...process.env, GITHUB_EVENT_NAME: 'pull_request', MUTATE_BASE: base };
  delete env.MUTATE_FULL;
  const r = spawnSync(process.execPath, [SCRIPT, '--plan', '4'], { cwd, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// [from, to] ranges of a file's units in a plan
const unitRanges = (plan, file) => plan.shards.flatMap(s => s.files)
  .filter(u => u === file || u.startsWith(`${file}:`))
  .map(u => (u === file ? [1, Infinity] : u.slice(file.length + 1).split('-').map(Number)));
const covers = (ranges, from, to) => ranges.some(([a, b]) => a <= from && b >= to);

test('a pull request that only moves code past a parser still mutates every line of the parser', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ply-mutate-plan-'));
  try {
    mkdirSync(join(dir, 'src'));
    copyFileSync(join(ROOT, 'stryker.conf.json'), join(dir, 'stryker.conf.json'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 't');
    writeFileSync(join(dir, 'src/a.ts'), lines([helper, parser, other]));
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    const base = git(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(dir, 'src/a.ts'), lines([parser, helper, other]));
    git(dir, 'commit', '-q', '-am', 'move helper below the parser');

    // the parser's lines on the PR side: 1..parser.length. The changed lines (a pure deletion borders the lines on
    // either side of it, as in changedRanges) do not cover them: changed lines alone would not mutate the parser.
    const from = 1, to = parser.length;
    const hunks = git(dir, 'diff', '-U0', `${base}...HEAD`).split('\n').filter(l => l.startsWith('@@'));
    const changed = hunks.map(h => /\+(\d+)(?:,(\d+))?/.exec(h)).map(m => {
      const at = Number(m[1]), len = Number(m[2] ?? 1);
      return len === 0 ? [Math.max(1, at), at + 1] : [at, at + len - 1];
    });
    assert.ok(!covers(changed, from, to), `the diff changes the parser: ${hunks.join(' ')}`);
    assert.ok(changed.every(([a, b]) => b <= from || a > to), `the diff changes the parser: ${hunks.join(' ')}`);

    const plan = prPlan(dir, base);
    assert.equal(plan.full, false);
    const ranges = unitRanges(plan, 'src/a.ts');
    assert.ok(covers(ranges, from, to), `parseFrame ${from}-${to} not in the plan: ${JSON.stringify(ranges)}`);
    // the moved helper is there too (changed lines), the untouched ungated function is not
    const helperAt = parser.length + 1;
    assert.ok(covers(ranges, helperAt, helperAt + helper.length - 1), JSON.stringify(ranges));
    const otherAt = parser.length + helper.length + 1;
    assert.ok(!ranges.some(([a, b]) => a <= otherAt + 1 && b >= otherAt + 1), `other() is in the plan: ${JSON.stringify(ranges)}`);
    // each planned mutant once: the parser's 40 conditions alone are well over 40
    assert.ok(plan.mutants > 40, String(plan.mutants));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

// The large-repo stack (saved index, scan index, range resolve, subset, pack plan, transfer plan, pull codecs, deadline,
// host report classes) decodes stored and remote state. Until this test its mutants could only end NoCoverage or
// Survived without failing anything: none of its tests were in the mutation suite (vitest.stryker.config.ts) and none of
// its owners were judged strictly (review finding tests-gates/mutation-gate-blind-to-new-stack). The expectations are
// the owner's list, written out here by hand: [file, an owner that decodes or bounds untrusted input, its test file].
const STACK = [
  ['src/packsaved.ts', 'checkEntry', 'test/pack-saved.test.js'],
  ['src/packsaved.ts', 'decodeSavedIndex', 'test/pack-saved.test.js'],
  ['src/packscanindex.ts', 'scanPackIndex', 'test/scan-pack-index.test.js'],
  ['src/packrangeresolve.ts', 'readMember', 'test/pack-range-resolve.test.js'],
  ['src/packsubset.ts', 'headerOf', 'test/pack-subset.test.js'],
  ['src/packplan.ts', 'checkBudget', 'test/pack-plan.test.js'],
  ['src/transferplan.ts', 'checkTransferPlan', 'test/transfer.test.js'],
  ['src/pullstream.ts', 'scanPack', 'test/pullstream.test.js'],
  ['src/deadline.ts', 'exchangeClock', 'test/deadline.test.js'],
  ['src/push.ts', 'ngClass', 'test/push-unpack-host.test.js'],
  ['src/push.ts', 'unpackReasonMatches', 'test/push-unpack-host.test.js'],
  // what those outer functions decide with (review of a8b920fc, required changes 2 and 4)
  ['src/packsaved.ts', 'layoutOf', 'test/pack-saved.test.js'],
  ['src/packsaved.ts', 'isWhole', 'test/pack-saved.test.js'],
  ['src/packsaved.ts', 'malformed', 'test/pack-saved.test.js'],
  ['src/transferplan.ts', 'transferPlanHash', 'test/transfer.test.js'],
  ['src/transferplan.ts', 'canonical', 'test/transfer.test.js'],
  ['src/transfernames.ts', 'isOid', 'test/transfer.test.js'],
  ['src/transfernames.ts', 'targetRef', 'test/transfer.test.js'],
  ['src/push.ts', 'rejectionCode', 'test/push-unpack-host.test.js'],
  ['src/push.ts', 'decideOutcome', 'test/push-unpack-host.test.js'],
  ['src/push.ts', 'reportStep', 'test/push-unpack-host.test.js'],
  ['src/transfer.ts', 'refusedResend', 'test/transfer.test.js'],
  ['src/transferload.ts', 'fromSaved', 'test/pack-saved.test.js'],
  ['src/receivecaps.ts', 'checkPushCaps', 'test/push-commands.test.js'],
  ['src/receivecaps.ts', 'pushPack', 'test/pack-plan.test.js'],
];
const STACK_FILES = [...new Set(STACK.map(([file]) => file))];

// 1-based line of a top-level declaration, found in the file's own text (not by scripts/mutate.mjs)
function declaredAt(file, name) {
  const text = readFileSync(join(ROOT, file), 'utf8').split('\n');
  const at = text.findIndex(l => new RegExp(`^(?:export )?(?:async )?(?:function|const) ${name}\\b`).test(l));
  assert.ok(at >= 0, `${file}: no top-level ${name}`);
  return at + 1;
}

function stackCheckout() {
  const dir = mkdtempSync(join(tmpdir(), 'ply-mutate-stack-'));
  mkdirSync(join(dir, 'src'));
  copyFileSync(join(ROOT, 'stryker.conf.json'), join(dir, 'stryker.conf.json'));
  for (const file of STACK_FILES) copyFileSync(join(ROOT, file), join(dir, file));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

test('the mutation suite runs the large-repo stack\'s tests', () => {
  const suite = readFileSync(join(ROOT, 'vitest.stryker.config.ts'), 'utf8');
  const missing = [...new Set(STACK.map(([, , t]) => t))].filter(t => !suite.includes(`'${t}'`));
  assert.deepEqual(missing, []);
});

test('a pull request that changes nothing still mutates the large-repo stack\'s decoders', () => {
  const dir = stackCheckout();
  try {
    const env = { ...process.env, GITHUB_EVENT_NAME: 'pull_request', MUTATE_BASE: 'HEAD' };
    delete env.MUTATE_FULL;
    // one shard: no unit is cut, so a gated owner is one range from its declaration line
    const r = spawnSync(process.execPath, [SCRIPT, '--plan', '1'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.full, false);
    const ungated = STACK.filter(([file, name]) => {
      const at = declaredAt(file, name);
      return !unitRanges(plan, file).some(([a, b]) => a <= at && b >= at);
    }).map(([file, name]) => `${file} ${name}`);
    assert.deepEqual(ungated, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test('a surviving or uncovered mutant in a large-repo stack decoder fails the verdict; a killed one passes', () => {
  const dir = stackCheckout();
  try {
    mkdirSync(join(dir, 'reports/mutation'), { recursive: true });
    // a pull request's verdict: the parser/bounds rule alone, without the full-library break threshold
    const env = { ...process.env, GITHUB_EVENT_NAME: 'pull_request' };
    delete env.MUTATE_FULL;
    const judge = (file, line, status) => {
      const mutant = { id: '1', mutatorName: 'EqualityOperator', replacement: 'x', status, location: { start: { line, column: 1 }, end: { line, column: 2 } } };
      writeFileSync(join(dir, 'reports/mutation/mutation.json'), JSON.stringify({ files: { [file]: { mutants: [mutant] } } }));
      return spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: dir, env, encoding: 'utf8' });
    };
    const wrong = [];
    for (const [file, name] of STACK) {
      const at = declaredAt(file, name);
      for (const [status, want] of [['Survived', 1], ['NoCoverage', 1], ['Killed', 0], ['Timeout', 0]]) {
        const r = judge(file, at, status);
        if (r.status !== want) wrong.push(`${file}:${at} ${name} ${status}: exit ${r.status}, want ${want}`);
        else if (want === 1 && !r.stderr.includes(`${file}:${at} ${name} EqualityOperator ${status}`)) wrong.push(`${file}:${at} ${name} ${status}: not named in ${r.stderr}`);
      }
    }
    assert.deepEqual(wrong, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

// The owner rule is fail-safe (review of a8b920fc, required change 3): in an owner-gated file every top-level owner is
// strict unless scripts/mutate.mjs names it exempt. These are the two lists written out by hand, from reading each
// file: `exempt` is what a survivor may live in (encoders of trusted state, request building from the caller's own
// options, drivers, text and span attributes); `strict` is everything that decodes or classifies stored or remote
// state. A new or renamed top-level declaration is in neither list and fails the test below until someone decides.
const words = s => s.split(/\s+/).filter(Boolean);
const OWNERS = {
  'src/packsaved.ts': {
    strict: words(`SAVED_INDEX_VERSION MAGIC HEADER CHECK FLAG_OIDS FLAG_REFS FLAG_RESOLVED FLAGS_KNOWN PACK_HEADER_BYTES
      RESOLVED_BYTES STATS STATS_BYTES SAVED_INDEX_ENTRY_BYTES SAVED_INDEX_FIXED_BYTES refused malformed isWhole isStored
      readAll packIdentity layoutOf cursorOf getF64s getI32s getBytes readHeader regionsOf bad checkEntry checkIndex
      checkResolved statsOf decodeSavedIndex`),
    exempt: words('putF64s putI32s putBytes encodeSavedIndex describeRefusal'),
  },
  'src/transferplan.ts': {
    strict: words('TRANSFER_VERSION optionJson stepJson canonical transferPlanHash edited wellFormedStep checkTransferPlan'),
    exempt: words(`OBJ_BLOB OBJ_COMMIT OBJ_TREE MODE_BLOB MODE_TREE TRANSFER_REF_PREFIX TRANSFER_IDENT
      TRANSFER_GENERATED_OBJECTS GEN_BYTES_PER_OBJECT GEN_BYTES_FIXED SIGNATURE_HEADERS outOfRange entryAt batchTrees
      commitObject tempCommit unsigned rootCommit reserved treeEntries tempFor planSteps planTransfer transferKey`),
  },
  'src/push.ts': {
    strict: words(`BAND_TAIL BAND_ATTR REPORT_KEEP UNPACK OK_REF NG_REF parseCommand parseEach parseCommands parseSideband
      broken streamInit streamStep streamFinish GIT_UNPACK_ERROR_LIST GIT_UNPACK_ERRORS seenUnpack isGitUnpackError
      UNPACKER_ERROR PRINTABLE HOST_UNPACK_ALIASES unpackReasonMatches echoedFailure TOO_LARGE KIB MIB
      parseReceivePackTooLarge malformed splitOnce reportInit reportStep reportFinish classifyReport KNOWN_NG knownNgClass
      HOST_CAS ngClass refused rejectionCode decideOutcome outcomeResult bandLines REPORT_V2_OPTION_LINES reportLineCap
      NOT_RUN codeOf refusedBeforeReceivePack serviceRefused unpackOf resolveAmbiguousByTip isEmptyBand3Ambiguous
      finishPush decide`),
    exempt: words(`SHORT_OID isParsed nonEmpty pkts pushBody pushDefaults requestCap requestCaps unchecked checkBases
      planPush requestBody readResponse outcomeAttrs objectTypeAttr bodyOf send receivePack push isPackLength
      planPackPush sendSource pushPackChecked`),
  },
  'src/receivecaps.ts': {
    strict: words(`frameAt dataAt serviceHeaderEnd SHA1_HEX OID_HEX refLine shallowLine FORMAT objectFormat
      parseReceiveAdvert receiveCaps noWants capsProblem checkPushCaps pushWithOptions pushPack`),
    exempt: words('LINE_PREVIEW problemText'),
  },
};
// Gated whole: every top-level owner is strict, whatever it is called.
const WHOLE = ['src/transfernames.ts', 'src/transfer.ts', 'src/transferload.ts'];

// Every top-level declaration of a file with its 1-based line, read from the file's own text with a wider pattern
// than scripts/mutate.mjs's owner rule (generators, let, var, class, export default): one the script cannot see is
// reported as `unseen`, since its mutants would be judged as the owner above it.
function census(file) {
  const seen = [], unseen = [];
  readFileSync(join(ROOT, file), 'utf8').split('\n').forEach((l, i) => {
    const m = /^(?:export )?(?:default )?(?:async )?(function\*?|const|let|var|class)\s+(\w+)/.exec(l);
    if (m) (m[1] === 'function' || m[1] === 'const' ? seen : unseen).push({ name: m[2], line: i + 1 });
    else if (/^export default\b/.test(l)) unseen.push({ name: 'default', line: i + 1 });
  });
  return { seen, unseen };
}

test('every top-level owner of an owner-gated file is listed strict or exempt, and the verdict agrees', () => {
  const problems = [];
  const want = [];
  const mutants = {};
  for (const file of [...Object.keys(OWNERS), ...WHOLE]) {
    const { seen, unseen } = census(file);
    for (const u of unseen) problems.push(`${file}:${u.line} ${u.name}: a top-level declaration the owner rule does not see`);
    const lists = OWNERS[file] ?? { strict: seen.map(o => o.name), exempt: [] };
    const listed = new Set([...lists.strict, ...lists.exempt]);
    const names = new Set(seen.map(o => o.name));
    for (const o of seen) if (!listed.has(o.name)) problems.push(`${file}:${o.line} ${o.name}: neither strict nor exempt (decide, and list it here)`);
    for (const n of listed) if (!names.has(n)) problems.push(`${file} ${n}: listed, but no such top-level owner (renamed or removed)`);
    for (const n of lists.strict) if (lists.exempt.includes(n)) problems.push(`${file} ${n}: listed both strict and exempt`);
    if (lists.strict.length === 0) problems.push(`${file}: no strict owner`);
    const strict = new Set(lists.strict);
    mutants[file] = seen.map((o, k) => ({ id: String(k), mutatorName: 'ConditionalExpression', replacement: 'false', status: 'Survived', location: { start: { line: o.line, column: 1 }, end: { line: o.line, column: 2 } } }));
    for (const o of seen) if (strict.has(o.name)) want.push(`${file}:${o.line} ${o.name}`);
  }
  assert.deepEqual(problems, []);

  // one Survived mutant on every owner's declaration line, judged once as a pull request would be
  const dir = mkdtempSync(join(tmpdir(), 'ply-mutate-owners-'));
  try {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'reports/mutation'), { recursive: true });
    copyFileSync(join(ROOT, 'stryker.conf.json'), join(dir, 'stryker.conf.json'));
    for (const file of Object.keys(mutants)) copyFileSync(join(ROOT, file), join(dir, file));
    writeFileSync(join(dir, 'reports/mutation/mutation.json'), JSON.stringify({ files: Object.fromEntries(Object.entries(mutants).map(([f, ms]) => [f, { mutants: ms }])) }));
    const env = { ...process.env, GITHUB_EVENT_NAME: 'pull_request' };
    delete env.MUTATE_FULL;
    const r = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stderr);
    const fatal = r.stderr.split('\n').map(l => /^(src\/\S+:\d+ \S+) ConditionalExpression Survived/.exec(l)?.[1]).filter(Boolean);
    assert.deepEqual(fatal.sort(), want.sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

// One run names everything there is to kill: a full run whose score is below the break still prints every fatal
// survivor (file:line, owner, mutator, status, replacement) in one list in source order, and exits non-zero once.
// Before, verdict() exited at the break message and the list was never printed. The report is written by hand: two
// survivors in two gated files, given out of order, and nothing killed, so the score (0) is below any break.
test('a full run below the break still lists every fatal survivor, in source order, and exits once', () => {
  const dir = stackCheckout();
  try {
    mkdirSync(join(dir, 'reports/mutation'), { recursive: true });
    const env = { ...process.env };
    delete env.GITHUB_EVENT_NAME;
    delete env.MUTATE_FULL;
    const mutant = (line, mutatorName, replacement) => ({ id: `${line}`, mutatorName, replacement, status: 'Survived', location: { start: { line, column: 1 }, end: { line, column: 2 } } });
    const entry = declaredAt('src/packsaved.ts', 'checkEntry'), layout = declaredAt('src/packsaved.ts', 'layoutOf');
    const check = declaredAt('src/transferplan.ts', 'checkTransferPlan');
    assert.ok(layout < entry);
    writeFileSync(join(dir, 'reports/mutation/mutation.json'), JSON.stringify({ files: {
      'src/transferplan.ts': { mutants: [mutant(check, 'EqualityOperator', 'a !== b')] },
      'src/packsaved.ts': { mutants: [mutant(entry, 'ConditionalExpression', 'false'), mutant(layout, 'ArithmeticOperator', 'n - 1')] },
    } }));
    const r = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /mutation score 0\.00 is below the break threshold/);
    const listed = r.stderr.split('\n').filter(l => l.startsWith('src/'));
    assert.deepEqual(listed, [
      `src/packsaved.ts:${layout} layoutOf ArithmeticOperator Survived → n - 1`,
      `src/packsaved.ts:${entry} checkEntry ConditionalExpression Survived → false`,
      `src/transferplan.ts:${check} checkTransferPlan EqualityOperator Survived → a !== b`,
    ]);
    assert.match(r.stderr, /\n3 surviving mutant\(s\) in a parser or bounds check:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
