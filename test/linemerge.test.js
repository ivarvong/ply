// The ported xdiff merge, judged by git (`git merge-tree --write-tree`) on hand-built edge cases. The random campaign is
// test/fuzz/linemerge.mjs; this file pins the boundaries: the histogram hash-chain limit (64 clean, 65 → git fails),
// binary sniffing, the size cap, CRLF, a last line without '\n', and identical changes on both sides.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeLines, isBinary, records, classifier, diffScript, compact, maxWorkOf } from '../src/linemerge.js';
import { DEFAULT_LIMITS, WORKER_LIMITS } from '../src/limits.js';
import { retryPolicy, isPlyCode } from '../src/errors.js';
import { oracleRediff } from './gitversion.js';
const rediff = oracleRediff();

let dir;
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'w', GIT_AUTHOR_EMAIL: 'w@x', GIT_COMMITTER_NAME: 'w', GIT_COMMITTER_EMAIL: 'w@x', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000' };
const git = (a, input) => spawnSync(process.env.GIT_BIN ?? 'git', ['-C', dir, ...a], { input, env: ENV, maxBuffer: 1 << 26 });
before(() => { dir = mkdtempSync(join(tmpdir(), 'lmt-')); git(['init', '-q', '--bare']); });
after(() => rmSync(dir, { recursive: true, force: true }));
const enc = s => (typeof s === 'string' ? new TextEncoder().encode(s) : s);
const commit = (bytes, p) => { const b = git(['hash-object', '-w', '--stdin'], Buffer.from(bytes)).stdout.toString().trim(); const t = git(['mktree'], `100644 blob ${b}\tf\n`).stdout.toString().trim(); return git(['commit-tree', t, ...(p ? ['-p', p] : []), '-m', 'c']).stdout.toString().trim(); };
const commitAttr = (bytes, p) => { const b = git(['hash-object', '-w', '--stdin'], Buffer.from(bytes)).stdout.toString().trim(); const a = git(['hash-object', '-w', '--stdin'], 'f merge=union\n').stdout.toString().trim(); const t = git(['mktree'], `100644 blob ${a}\t.gitattributes\n100644 blob ${b}\tf\n`).stdout.toString().trim(); return git(['commit-tree', t, ...(p ? ['-p', p] : []), '-m', 'c']).stdout.toString().trim(); };
// a merged blob's bytes; a failed cat-file is an error, never an empty file that could equal an empty merge
const blobAt = spec => { const r = git(['cat-file', 'blob', spec]); assert.equal(r.status, 0, `cat-file ${spec}: ${r.stderr}`); return new Uint8Array(r.stdout); };
// git's verdict: { status: 'clean', data } | { status: 'conflict' } | { status: 'failed' } (exit 128: the merge itself failed)
function gitMerge(base, ours, theirs) {
  const cb = commit(base), r = git(['merge-tree', '--write-tree', '--name-only', commit(ours, cb), commit(theirs, cb)]);
  if (r.status === 0) return { status: 'clean', data: blobAt(`${r.stdout.toString().split('\n')[0]}:f`) };
  return { status: r.status === 1 ? 'conflict' : 'failed', stderr: r.stderr.toString() };
}
function judge(name, base, ours, theirs, expect) {
  const [B, O, T] = [base, ours, theirs].map(enc);
  const g = gitMerge(B, O, T), m = mergeLines(B, O, T, { rediff });
  assert.equal(g.status, expect.git, `${name}: git says ${g.status} ${g.stderr ?? ''}`);
  if (g.status === 'clean' && m.clean) assert.deepEqual(m.data, g.data, `${name}: bytes == git`);
  else if (m.clean) assert.fail(`${name}: we merged cleanly, git ${g.status}`);
  if (expect.ours) assert.equal(m.clean ? 'clean' : m.reason, expect.ours, `${name}: our verdict`);
  return m;
}

test('histogram hash-chain limit: 64 colliding lines merge (== git), 65 make git fail and us answer undecided', () => {
  // class index = first-occurrence order (base first); 70 lines whose indices share bucket 0 for a 2^7-bucket region
  const P = Array.from({ length: 10000 }, (_, i) => `p${i}\n`);
  for (const [K, gitStatus, ours] of [[64, 'clean', 'clean'], [65, 'failed', 'undecided']]) {
    const R = Array.from({ length: K }, (_, k) => P[(k + 1) * 128 + ((128 - ((k + 1) % 128)) % 128)]);
    const X = Array.from({ length: K }, (_, i) => `x${i}\n`);
    const doc = (mid, tail) => [...P, 'ANCHOR1\n', ...mid, 'ANCHOR2\n', tail].join('');
    const m = judge(`chain ${K}`, doc(R, 'tail\n'), doc(X, 'tail\n'), doc(R, 'tail changed\n'), { git: gitStatus, ours });
    if (!m.clean) assert.match(m.detail, /chain limit/);
  }
});

test('edges, each decided by git', () => {
  const L = Array.from({ length: 12 }, (_, i) => `l${i}\n`);
  const j = a => a.join('');
  judge('disjoint', j(L), j(['TOP\n', ...L.slice(1)]), j([...L.slice(0, -1), 'END\n']), { git: 'clean', ours: 'clean' });
  judge('adjacent lines', j(L), j([...L.slice(0, 5), 'A\n', ...L.slice(6)]), j([...L.slice(0, 6), 'B\n', ...L.slice(7)]), { git: 'conflict', ours: 'content' });
  judge('identical change both sides + one more', j(L), j([...L.slice(0, 3), 'S\n', ...L.slice(4)]), j([...L.slice(0, 3), 'S\n', ...L.slice(4, -1), 'Z\n']), { git: 'clean', ours: 'clean' });
  judge('no final newline, edited tail', j(L) + 'last', 'H\n' + j(L.slice(1)) + 'last', j(L) + 'last!', { git: 'clean', ours: 'clean' });
  judge('adding a final newline vs a head edit', j(L) + 'last', 'H\n' + j(L.slice(1)) + 'last', j(L) + 'last\n', { git: 'clean', ours: 'clean' });
  judge('CRLF lines', L.map(x => x.replace('\n', '\r\n')).join(''), ['T\r\n', ...L.slice(1).map(x => x.replace('\n', '\r\n'))].join(''), L.map(x => x.replace('\n', '\r\n')).join('') + 'E\r\n', { git: 'clean', ours: 'clean' });
  judge('CRLF vs LF on the same line', j(L), j(['l0\r\n', ...L.slice(1)]), j(['L0\n', ...L.slice(1)]), { git: 'conflict', ours: 'content' });
  judge('empty base, both add different', '', 'a\n', 'b\n', { git: 'conflict', ours: 'content' });
  judge('repeated braces', '{\n}\n{\n}\n{\n}\n', '{\n}\n{\nx\n}\n{\n}\n', '{\n}\n{\n}\n{\ny\n}\n', { git: 'clean', ours: 'clean' });
  judge('binary (NUL in the first 8000 bytes)', 'a\0\nb\n', 'a\0\nB\n', 'A\0\nb\n', { git: 'conflict', ours: 'binary' });
  const far = Array.from({ length: 2000 }, (_, i) => `x${i}\n`).join(''); // > 8000 bytes: a NUL after it is text to git
  assert.ok(far.length > 8000);
  judge('NUL past the sniff window is text', far + '\0z\n', 'TOP\n' + far.slice(3) + '\0z\n', far + '\0Z\n', { git: 'clean', ours: 'clean' });
  assert.equal(isBinary(enc(far + '\0')), false); assert.equal(isBinary(enc('\0')), true);
  // a region whose every common line occurs > 64 times sends git's histogram to classic Myers (ported: classicDiff)
  // merge=union edges, judged by git with the attribute read from the ours tree
  for (const [name, b, o, t] of [['one line, no newline', 'a', 'b', 'c'], ['CRLF union', 'x\r\ny\r\n', 'x\r\nO', 'x\r\nT\r\n'], ['empty ours side', 'a\nb\n', 'b\n', 'a\nc\n']]) {
    const [B, O, T] = [b, o, t].map(enc);
    const cb = commitAttr(B), co = commitAttr(O, cb), ct = commitAttr(T, cb);
    const r = git(['-c', `attr.tree=${co}`, 'merge-tree', '--write-tree', '--name-only', co, ct]);
    assert.equal(r.status, 0, `${name}: git unions cleanly`);
    const gitBytes = blobAt(`${r.stdout.toString().split('\n')[0]}:f`);
    const m = mergeLines(B, O, T, { rediff, driver: 'union' });
    assert.ok(m.clean, name); assert.deepEqual(m.data, gitBytes, `${name}: union bytes == git`);
  }
  const run = 'x\n'.repeat(200);
  judge('long run of one line (histogram → Myers)', run, 'TOP\n' + run.slice(2), run + 'END\n', { git: 'clean', ours: 'clean' });
  judge('long runs, edits inside', 'x\n'.repeat(100) + 'y\n'.repeat(100), 'x\n'.repeat(50) + 'A\n' + 'x\n'.repeat(50) + 'y\n'.repeat(100), 'x\n'.repeat(100) + 'y\n'.repeat(60) + 'B\n' + 'y\n'.repeat(40), { git: 'clean' });
});

test('the size cap is ours (a Worker\'s memory), reported as a reason, never a wrong merge', () => {
  const big = enc('a\n'.repeat(1024)), m = mergeLines(big, enc('b\n' + 'a\n'.repeat(1023)), enc('a\n'.repeat(1023) + 'c\n'), { maxBytes: 1000 });
  assert.deepEqual(m, { clean: false, reason: 'too large to merge' });
});

test('git 2.54 changed compaction: the smallest input that separates the two modes, each pinned to its git', () => {
  // a b c → c a a c. Recorded with `git diff --histogram --no-indent-heuristic`:
  //   git 2.43: -a -b +c +a +a  c        (one hunk: 2 lines replaced by 3)              = rediff 'skip'
  //   git 2.56: +c  a -b +a  c           (insert c; b → a; the shifted group re-diffed) = rediff 'myers' (default)
  const enc = s => new TextEncoder().encode(s), cl = classifier();
  const A = records(enc('a\nb\nc\n'), cl), B = records(enc('c\na\na\nc\n'), cl);
  const hunks = mode => diffScript(A, B, { rediff: mode }).value.map(x => [x.i1, x.chg1, x.i2, x.chg2]).sort((p, q) => p[0] - q[0]);
  assert.deepEqual(hunks('skip'), [[0, 2, 0, 3]]);
  assert.deepEqual(hunks('myers'), [[0, 0, 0, 1], [1, 1, 2, 1]]);
  // declining is a value, not a thrown non-Error (#80)
  assert.deepEqual(diffScript(A, B, { rediff: 'undecided' }), { ok: false, error: { undecided: true, detail: 'compaction needs the classic-diff fallback' } });
  assert.deepEqual(mergeLines(enc('a\nb\nc\n'), enc('c\na\na\nc\n'), enc('a\nb\nc\nZ\n'), { rediff: 'undecided' }), { clean: false, reason: 'undecided', detail: 'compaction needs the classic-diff fallback' });
  assert.deepEqual(hunks(undefined), hunks('myers'), 'default follows current git');
  // and the installed git agrees with the mode its version implies (the shape of its -U1 hunk body)
  writeFileSync(join(dir, 'A'), 'a\nb\nc\n'); writeFileSync(join(dir, 'B'), 'c\na\na\nc\n');
  const out = spawnSync(process.env.GIT_BIN ?? 'git', ['diff', '--no-index', '--no-color', '--histogram', '--no-indent-heuristic', '-U1', 'A', 'B'], { cwd: dir }).stdout.toString();
  const body = out.slice(out.indexOf('@@')).split('\n').slice(1).filter(Boolean).map(l => l[0]).join('');
  assert.equal(body, rediff === 'myers' ? '+ -+ ' : '--+++ ', `git's hunk shape matches rediff '${rediff}'`);
});

test('a broken invariant of the port is a typed internal error, never a bare Error (#80)', () => {
  // compact's two sides must hold the same number of unchanged lines; feed it sides that do not
  const ids = Int32Array.of(1, 2); const ch = new Uint8Array(4); const chO = new Uint8Array(3);
  assert.throws(() => compact(ids, ch, 2, Int32Array.of(1), chO, 1, 'myers'), e => e instanceof Error && isPlyCode(e.code) && e.code === 'internal' && retryPolicy(e) === 'no' && e.message === 'linemerge: groups out of step');
});

// ---- the work bound (review: merge/histogram-quadratic-under-blob-cap) ----
// The reviewer's shape: base is n unique lines, ours swaps each adjacent pair, theirs appends one line. Every line occurs
// once, so xhistogram's find_lcs takes the first common line of the region, splits two lines off the front and rescans
// what is left of base: sum over k < n/2 of (n - 2k) ≈ n²/4 scanA steps for the base→ours diff alone, whatever the
// implementation (git does the same work, in C). The expectations below are that arithmetic, not ply's output.
const swapCase = n => {
  const L = Array.from({ length: n }, (_, i) => `w${i}`), o = [...L];
  for (let i = 0; i + 1 < n; i += 2) [o[i], o[i + 1]] = [o[i + 1], o[i]];
  return [L, o, [...L, 'tail']].map(l => enc(l.join('\n') + '\n'));
};
// The absolute budgets (maxWork) these tests pass: a number of steps per line of base + ours + theirs, plus 1024 lines.
// That was the budget's own rule before Limits.maxMergeWork; here it is only how each test sizes a budget for its input.
const FLOOR_LINES = 1024;
const budgetOf = (n, perLine) => perLine * (n + n + n + 1 + FLOOR_LINES);
test('work bound: pair swaps past the step budget are refused as too large, within the budget', () => {
  // n = 2000 needs ≥ 2000²/4 = 1,000,000 steps; the budget is 64 × (6001 + 1024) = 449,600.
  const [B, O, T] = swapCase(2000), meter = { steps: 0 };
  assert.deepEqual(mergeLines(B, O, T, { rediff, maxWork: budgetOf(2000, 64), meter }), { clean: false, reason: 'too large to merge' });
  assert.ok(meter.steps > budgetOf(2000, 64), `stopped by the budget: ${meter.steps} steps`);
  assert.ok(meter.steps <= budgetOf(2000, 64) * 1.05, `overshoot is one region's scan at most: ${meter.steps} steps`);
});
test('work bound: unbudgeted steps quadruple when the input doubles, budgeted steps stop at the budget whatever the input', () => {
  const steps = (n, maxWork) => { const [B, O, T] = swapCase(n), meter = { steps: 0 }; mergeLines(B, O, T, { rediff, maxWork, meter }); return meter.steps; };
  const free = [steps(1000, Number.MAX_SAFE_INTEGER), steps(2000, Number.MAX_SAFE_INTEGER)];
  assert.ok(free[0] >= 1000 ** 2 / 4 && free[1] >= 2000 ** 2 / 4, `the algorithm's own cost is ≥ n²/4: ${free}`);
  assert.ok(free[1] / free[0] > 3.5, `quadratic without the budget: ${free}`);
  // one absolute budget (449,600) for both sizes: each stops past it by one region's scan at most (≤ 2n lines, under 2%)
  const held = [steps(2000, budgetOf(2000, 64)), steps(4000, budgetOf(2000, 64))];
  for (const h of held) assert.ok(h > budgetOf(2000, 64) && h <= budgetOf(2000, 64) * 1.05, `stopped at the budget: ${held}`);
});
// The smallest pair-swap file whose base→ours scan alone (≥ n²/4 steps, above) passes a budget: n > 2 × sqrt(budget).
const swapLinesPast = budget => 2 * Math.ceil(Math.sqrt(budget)) + 2;
test('work bound: a pair-swap file whose scan needs more than WORKER_LIMITS.maxMergeWork is refused at that budget', () => {
  const max = WORKER_LIMITS.maxMergeWork, n = swapLinesPast(max);
  assert.ok(n ** 2 / 4 > max);
  const [B, O, T] = swapCase(n), meter = { steps: 0 };
  assert.ok(Math.max(B.length, O.length, T.length) <= WORKER_LIMITS.maxMergeBlobBytes, 'under the Worker blob cap: only the work budget refuses it');
  assert.deepEqual(mergeLines(B, O, T, { rediff, maxBytes: WORKER_LIMITS.maxMergeBlobBytes, maxWork: max, meter }), { clean: false, reason: 'too large to merge' });
  assert.ok(meter.steps > max && meter.steps <= max * 1.05, `${meter.steps} steps`);
});
test('work bound: the same shape under the budget is git\'s merge, byte for byte', () => {
  // pairs swapped in the first half only, so theirs' appended line is far from ours' hunks: git merges it cleanly
  const L = Array.from({ length: 400 }, (_, i) => `w${i}`), o = [...L];
  for (let i = 0; i + 1 < 200; i += 2) [o[i], o[i + 1]] = [o[i + 1], o[i]];
  const [B, O, T] = [L, o, [...L, 'tail']].map(l => enc(l.join('\n') + '\n'));
  const g = gitMerge(B, O, T), meter = { steps: 0 }, m = mergeLines(B, O, T, { rediff, meter });
  assert.equal(g.status, 'clean');
  assert.equal(m.clean, true);
  assert.deepEqual(m.data, g.data);
  assert.ok(meter.steps > 0 && meter.steps < budgetOf(400, 1024), `${meter.steps} steps`);
});
// ---- an ordinary bulk edit merges under the defaults (review R3) ----
// The reviewer's case, from fixed constants: 70,000 lines, ours changes every 20th line (3,500 one-line hunks: a sed
// across a big file), theirs changes line 6. git merges it cleanly, and the expected bytes are `git merge-file`'s
// (xdiff with the histogram diff, which is what merge-ort runs), not ply's.
test('work bound: the 70,000-line / 3,500-hunk bulk edit merges cleanly under DEFAULT_LIMITS, byte for byte git merge-file', () => {
  const N = 70000, EVERY = 20;
  const L = Array.from({ length: N }, (_, i) => `line ${i} of the file`), o = [...L], t = [...L];
  for (let i = EVERY - 1; i < N; i += EVERY) o[i] = `changed ${i}`;
  t[5] = 'theirs edit';
  const [B, O, T] = [L, o, t].map(l => enc(l.join('\n') + '\n'));
  for (const [name, bytes] of [['bulk-base', B], ['bulk-ours', O], ['bulk-theirs', T]]) writeFileSync(join(dir, name), bytes);
  const g = spawnSync(process.env.GIT_BIN ?? 'git', ['merge-file', '-p', '--diff-algorithm=histogram', join(dir, 'bulk-ours'), join(dir, 'bulk-base'), join(dir, 'bulk-theirs')], { maxBuffer: 1 << 26 });
  assert.equal(g.status, 0, `git merge-file merges it cleanly: ${g.stderr}`);
  const meter = { steps: 0 };
  const m = mergeLines(B, O, T, { rediff, maxBytes: DEFAULT_LIMITS.maxMergeBlobBytes, maxWork: DEFAULT_LIMITS.maxMergeWork, meter });
  assert.equal(m.clean, true, `ply: ${m.reason} after ${meter.steps} steps of ${DEFAULT_LIMITS.maxMergeWork}`);
  assert.ok(Buffer.from(m.data).equals(g.stdout), `merged bytes are git's (${m.data.length} against ${g.stdout.length})`);
  // the sizing rule: the default is at least twice what this case counts
  assert.ok(DEFAULT_LIMITS.maxMergeWork >= 2 * meter.steps, `${meter.steps} steps against a default of ${DEFAULT_LIMITS.maxMergeWork}`);
  // under the Worker preset it does not fit (README says so): the same input is refused there, never merged wrongly
  assert.deepEqual(mergeLines(B, O, T, { rediff, maxBytes: WORKER_LIMITS.maxMergeBlobBytes, maxWork: WORKER_LIMITS.maxMergeWork }), { clean: false, reason: 'too large to merge' });
});

// ---- the budget is the module's own counter (review R4): a caller's meter is written, never read ----
// a/b/c/d/e with line 1 changed on ours and line 5 on theirs: git merges it cleanly (the oracle below), and two diffs
// of 5 lines against 5 are a few dozen steps, so under 1000 by any count.
const five = () => ['a\nb\nc\nd\ne\n', 'A\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n'].map(enc);
test('work bound: a caller\'s meter never decides a merge: reused, pre-loaded or malformed, the answer is git\'s and nothing throws', () => {
  const [b, o, t] = five(), g = gitMerge(b, o, t);
  assert.equal(g.status, 'clean');
  for (const meter of [{ steps: 1e12 }, { steps: NaN }, {}, null, 7, 'x', Object.freeze({ steps: 0 })]) {
    const m = mergeLines(b, o, t, { rediff, meter });
    assert.equal(m.clean, true, `meter ${JSON.stringify(meter)}: ${JSON.stringify(m.reason)}`);
    assert.deepEqual(m.data, g.data);
    assert.equal(diffScript(records(b, classifier()), records(o, classifier()), { rediff, meter }).ok, true);
  }
  // one meter over two files: the first is refused (2000 swapped pairs need >= 1,000,000 steps, 449,600 allowed), the
  // second is git's clean merge, and the meter then holds the second call's own total
  const meter = { steps: 0 }, [B, O, T] = swapCase(2000);
  assert.deepEqual(mergeLines(B, O, T, { rediff, maxWork: budgetOf(2000, 64), meter }), { clean: false, reason: 'too large to merge' });
  assert.ok(meter.steps > budgetOf(2000, 64));
  assert.equal(mergeLines(b, o, t, { rediff, maxWork: budgetOf(2000, 64), meter }).clean, true);
  assert.ok(meter.steps > 0 && meter.steps < 1000, `${meter.steps} steps`);
});
test('work bound: no meter and no maxWork switches the bound off', () => {
  const [B, O, T] = swapCase(2000); // >= 1,000,000 steps against 449,600
  for (const meter of [{}, { steps: NaN }, { steps: -1e12 }, null, 7]) assert.deepEqual(mergeLines(B, O, T, { rediff, maxWork: budgetOf(2000, 64), meter }), { clean: false, reason: 'too large to merge' }, `meter ${JSON.stringify(meter)}`);
  // a maxWork that is not a non-negative finite number is the default (DEFAULT_LIMITS.maxMergeWork): neither no bound nor a zero budget
  for (const bad of [NaN, Infinity, -1, null, '64', {}]) assert.equal(maxWorkOf(bad), DEFAULT_LIMITS.maxMergeWork, String(bad));
  assert.equal(maxWorkOf(0), 0); assert.equal(maxWorkOf(64), 64);
  const [b, o, t] = five();
  for (const maxWork of [NaN, -1, null, '64']) assert.equal(mergeLines(b, o, t, { rediff, maxWork }).clean, true, String(maxWork));
  // end to end at the default: a pair-swap file whose scan alone needs more than DEFAULT_LIMITS.maxMergeWork steps is
  // refused, within 5% of it, when maxWork is a value that would bound nothing
  const max = DEFAULT_LIMITS.maxMergeWork, [B6, O6, T6] = swapCase(swapLinesPast(max));
  for (const maxWork of [NaN, Infinity]) {
    const meter = { steps: 0 };
    assert.deepEqual(mergeLines(B6, O6, T6, { rediff, maxWork, meter }), { clean: false, reason: 'too large to merge' }, String(maxWork));
    assert.ok(meter.steps > max && meter.steps <= max * 1.05, `${maxWork}: ${meter.steps} steps`);
  }
});

// ---- the classic-Myers fallback counts its real work (review R1) ----
// Three distinct lines, each far more than 64 times: find_lcs has no anchor it may use and the region goes to classic
// Myers (xdl_fall_back_diff), whose xdl_cleanup_records looks, for every line whose class is frequent in the other
// file, at up to 100 neighbours each way (xdl_clean_mmatch, XDL_SIMSCAN_WINDOW). With no line discarded or kept
// before it, line k of a file is compared with min(k, 100) earlier lines: 4950 + 100 x (n - 100) for an n-line file.
// That is xdiff's arithmetic (git does the same work in C), not ply's output, and the count must hold at least it.
const lowVariety = (n, seed) => { let s = seed; const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s % 3; }; return Array.from({ length: n }, () => 'abc'[rnd()]); };
const scanFloor = n => 2 * (4950 + 100 * (n - 100)); // both files
const diffSteps = (base, side, options = {}) => { const cl = classifier(), meter = { steps: 0 }; const d = diffScript(records(enc(base.join('\n') + '\n'), cl), records(enc(side.join('\n') + '\n'), cl), { rediff, meter, ...options }); return { d, steps: meter.steps }; };
const LOWVAR_10K_STEPS = 5_370_282; // measured: the two 10,000-line files below (main counted nothing; 23f01d1 counted the diagonals only)
test('work bound: the classic-Myers fallback counts the cleanup scan, not only the diagonals', () => {
  // a 3000-line a/b/c file with its first and last lines changed: nothing trims, every line is frequent in the other
  // file (about 1000 times against a threshold of bogosqrt(3000) = 64), and the two-line edit itself is one long snake
  const L = lowVariety(3000, 7), o = [...L];
  o[0] = L[0] === 'a' ? 'b' : 'a'; o[2999] = L[2999] === 'a' ? 'b' : 'a';
  const { d, steps } = diffSteps(L, o);
  assert.equal(d.ok, true);
  assert.ok(steps >= scanFloor(3000), `the neighbour scans alone are ${scanFloor(3000)} line visits: ${steps} steps counted`);
});
test('work bound: a low-variety file (random a/b/c) costs under 3x when it doubles, and is refused within the budget', () => {
  // two unrelated random files: Myers under xdl_split's cost cutoff (mxcost = bogosqrt(diagonals), at least 256) is
  // about n^1.5, so doubling the input is at most 2^1.5 = 2.83x the work, never the 4x of a quadratic diff
  const at = n => diffSteps(lowVariety(n, 0x9e3779b9), lowVariety(n, 0x1234567)).steps;
  const [s1, s2] = [at(10000), at(20000)];
  assert.ok(s1 >= scanFloor(10000) - 2 * 100 * 100, `${s1} steps`); // up to 100 lines of each file may trim
  assert.ok(s2 / s1 > 1.8 && s2 / s1 < 3, `doubling ratio ${s2 / s1}: ${s1} -> ${s2}`);
  assert.equal(s1, LOWVAR_10K_STEPS, 'the fixed case\'s count (pinned: a change here is a change in what is counted)');
  // the same files under a budget of (20000 + 1024) x 64 = 1,345,536 steps: the stop is within 5% of it
  const held = diffSteps(lowVariety(10000, 0x9e3779b9), lowVariety(10000, 0x1234567), { maxWork: 1_345_536 });
  assert.deepEqual(held.d, { ok: false, error: { undecided: true, detail: 'line diff step budget exceeded' } });
  assert.ok(held.steps > 1_345_536 && held.steps <= 1_345_536 * 1.05, `${held.steps} steps`);
});

// ---- the two presets, sized (decisions 2 and 6) ----
// WORKER_LIMITS: the worst inputs under its 2 MiB blob cap, one per path, each needing far more than any budget near it:
//   histogram: 250,000 lines with every adjacent pair swapped (1.80 MiB): the base->ours scan alone is >= n²/4 =
//     1.56e10 steps (swapCase, above);
//   classic fallback: three unrelated random a/b/c files of 1,048,576 lines (2 MiB exactly, the most lines the cap
//     admits): the neighbour scans alone are scanFloor(n) = 209,705,100 line visits.
// Both are refused, and by the counter: at most 2^26 steps (the sized value, written out here so that a larger preset
// fails this test) plus one loop's slack, which is one pass over the two files being diffed plus two neighbour windows
// of 100 lines.
// CPU to the refusal at 2^26, this machine (16 cores, about 25 other test processes; process.cpuUsage, median of 3):
// 1,037 ms for the swaps and 1,397 ms for a/b/c (1,744 ms for the slowest shape found, 60 copies each of 8,733
// three-byte lines shuffled three ways, which finishes in 113,620,667 steps without a budget). Of that, parsing the
// three sides into records, which no step budget covers, is 434 ms and 894 ms; a budget of 0 refuses them in 553 ms
// and 1,058 ms. At 2^27 the same refusals took 1,452 ms and 1,478 ms.
const WORKER_SIZED = 2 ** 26;
test('work bound: the worst inputs under the Worker blob cap, on each path, are refused within WORKER_LIMITS.maxMergeWork steps and one loop', () => {
  const max = WORKER_LIMITS.maxMergeWork, cap = WORKER_LIMITS.maxMergeBlobBytes;
  const text = l => enc(l.join('\n') + '\n');
  const shapes = [
    ['pair swaps', 250000, swapCase(250000)],
    ['random a/b/c', 1048576, [lowVariety(1048576, 0x9e3779b9), lowVariety(1048576, 0x1234567), lowVariety(1048576, 0x7654321)].map(text)],
  ];
  assert.ok(250000 ** 2 / 4 > 4 * WORKER_SIZED && scanFloor(1048576) > 2 * WORKER_SIZED, 'each needs more than the budget, by arithmetic');
  for (const [name, lines, [B, O, T]] of shapes) {
    assert.ok(Math.max(B.length, O.length, T.length) <= cap, `${name}: under the Worker blob cap, so only the work budget refuses it`);
    const meter = { steps: 0 };
    assert.deepEqual(mergeLines(B, O, T, { rediff, maxBytes: cap, maxWork: max, meter }), { clean: false, reason: 'too large to merge' }, name);
    assert.ok(meter.steps > max, `${name}: stopped by the budget, ${meter.steps} steps`);
    assert.ok(meter.steps <= WORKER_SIZED + 2 * lines + 200, `${name}: ${meter.steps} steps against ${WORKER_SIZED} and one loop`);
  }
});
// DEFAULT_LIMITS: what git merges cleanly in about 5 s here is merged. 40,000 lines with every adjacent pair swapped
// but the last four, and a line appended on theirs: `git merge-file` exits 0 in 3.4 s on this machine (60,000 lines:
// 7.9 s, so about 48,000 lines is git's 5 s), and the two scans are 0.75 n² = 1.2e9 steps (10,000 lines: 74,970,022
// counted, 0.7497 n²), which is over 2^30. The expected bytes are git's.
test('work bound: 40,000 lines of swapped pairs, which git merges cleanly in under 5 s, merge under DEFAULT_LIMITS byte for byte', () => {
  const N = 40000, L = Array.from({ length: N }, (_, i) => `w${i}`), o = [...L];
  for (let i = 0; i + 1 < N - 8; i += 2) [o[i], o[i + 1]] = [o[i + 1], o[i]];
  const [B, O, T] = [L, o, [...L, 'tail']].map(l => enc(l.join('\n') + '\n'));
  for (const [name, bytes] of [['swap-base', B], ['swap-ours', O], ['swap-theirs', T]]) writeFileSync(join(dir, name), bytes);
  const g = spawnSync(process.env.GIT_BIN ?? 'git', ['merge-file', '-p', '--diff-algorithm=histogram', join(dir, 'swap-ours'), join(dir, 'swap-base'), join(dir, 'swap-theirs')], { maxBuffer: 1 << 26 });
  assert.equal(g.status, 0, `git merge-file merges it cleanly: ${g.stderr}`);
  const meter = { steps: 0 };
  const m = mergeLines(B, O, T, { rediff, maxBytes: DEFAULT_LIMITS.maxMergeBlobBytes, maxWork: DEFAULT_LIMITS.maxMergeWork, meter });
  assert.equal(m.clean, true, `ply: ${m.reason} after ${meter.steps} steps of ${DEFAULT_LIMITS.maxMergeWork}`);
  assert.ok(Buffer.from(m.data).equals(g.stdout), `merged bytes are git's (${m.data.length} against ${g.stdout.length})`);
});
// The same promise on the other shape, a bulk edit, where a step is cheaper for git (about 1.7 ns against the swaps'
// 2.9), so git's 5 s is more steps. 130,000 lines, ours changes every 10th (13,000 one-line hunks), theirs changes
// line 6: `git merge-file` exits 0 in 4.1 s on this machine (143,000 lines: 5.0 s, 2,965,798,566 steps) and the merge
// counts 2,451,130,516 steps, which is over 2^31: a default of 2^31, sized from the swaps alone, refused it. The
// expected bytes are git's.
test('work bound: the 130,000-line / 13,000-hunk bulk edit, which git merges cleanly in under 5 s, merges under DEFAULT_LIMITS byte for byte', () => {
  const N = 130000, EVERY = 10;
  const L = Array.from({ length: N }, (_, i) => `line ${i} of the file`), o = [...L], t = [...L];
  for (let i = EVERY - 1; i < N; i += EVERY) o[i] = `changed ${i}`;
  t[5] = 'theirs edit';
  const [B, O, T] = [L, o, t].map(l => enc(l.join('\n') + '\n'));
  for (const [name, bytes] of [['bulk10-base', B], ['bulk10-ours', O], ['bulk10-theirs', T]]) writeFileSync(join(dir, name), bytes);
  const g = spawnSync(process.env.GIT_BIN ?? 'git', ['merge-file', '-p', '--diff-algorithm=histogram', join(dir, 'bulk10-ours'), join(dir, 'bulk10-base'), join(dir, 'bulk10-theirs')], { maxBuffer: 1 << 26 });
  assert.equal(g.status, 0, `git merge-file merges it cleanly: ${g.stderr}`);
  assert.ok(Math.max(B.length, O.length, T.length) <= DEFAULT_LIMITS.maxMergeBlobBytes, 'under the default blob cap: only the work budget could refuse it');
  const meter = { steps: 0 };
  const m = mergeLines(B, O, T, { rediff, maxBytes: DEFAULT_LIMITS.maxMergeBlobBytes, maxWork: DEFAULT_LIMITS.maxMergeWork, meter });
  assert.equal(m.clean, true, `ply: ${m.reason} after ${meter.steps} steps of ${DEFAULT_LIMITS.maxMergeWork}`);
  assert.ok(Buffer.from(m.data).equals(g.stdout), `merged bytes are git's (${m.data.length} against ${g.stdout.length})`);
});

// ---- the meter write-out (re-review REQ 4 and REQ 5): it cannot throw, and every return path writes ----
// Oracles: git for the result (the five-line merge is git's clean merge; the base -> ours script is one line for one
// line, by hand), arithmetic for the totals (a call that returns before any diff has done 0 steps).
const hostileMeters = () => {
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  return {
    'a throwing setter': { set steps(_v) { throw new Error('boom-setter'); } },
    'a Proxy whose set trap throws': new Proxy({}, { set() { throw new Error('boom-proxy'); } }),
    'a revoked Proxy': revoked.proxy,
  };
};
test('meter: one whose write throws (a setter, a Proxy set trap, a revoked Proxy) leaves the result unchanged, in mergeLines and diffScript', () => {
  const [b, o, t] = five(), g = gitMerge(b, o, t), bin = enc('a\0b\n');
  assert.equal(g.status, 'clean');
  for (const [name, meter] of Object.entries(hostileMeters())) {
    const m = mergeLines(b, o, t, { rediff, meter });
    assert.equal(m.clean, true, name);
    assert.deepEqual(m.data, g.data, name);
    const cl = classifier();
    assert.deepEqual(diffScript(records(b, cl), records(o, cl), { rediff, meter }), { ok: true, value: [{ i1: 0, i2: 0, chg1: 1, chg2: 1 }] }, name);
    // the returns before any diff write the meter too
    assert.deepEqual(mergeLines(bin, bin, bin, { rediff, meter }), { clean: false, reason: 'binary' }, name);
    assert.deepEqual(mergeLines(b, o, t, { rediff, meter, maxBytes: 4 }), { clean: false, reason: 'too large to merge' }, name);
    assert.deepEqual(mergeLines(b, o, t, { rediff, meter, driver: 'binary' }), { clean: false, reason: 'binary (merge attribute)' }, name);
  }
});
test('meter: a call that returns before any diff (binary content, an input over maxBytes, driver binary) sets a reused meter to 0', () => {
  const [b, o, t] = five(), bin = enc('a\0b\n'), meter = { steps: 0 };
  assert.equal(mergeLines(b, o, t, { rediff, meter }).clean, true);
  const first = meter.steps;
  assert.ok(first > 0, `the five-line merge diffs: ${first} steps`);
  const early = [
    ['binary content', () => mergeLines(bin, bin, bin, { rediff, meter }), { clean: false, reason: 'binary' }],
    ['an input over maxBytes', () => mergeLines(b, o, t, { rediff, meter, maxBytes: 4 }), { clean: false, reason: 'too large to merge' }],
    ['driver binary', () => mergeLines(b, o, t, { rediff, meter, driver: 'binary' }), { clean: false, reason: 'binary (merge attribute)' }],
  ];
  for (const [name, call, expected] of early) {
    meter.steps = first; // what the previous file's call left
    assert.deepEqual(call(), expected, name);
    assert.equal(meter.steps, 0, `${name}: no diff ran, so the call's total is 0, not the previous call's ${first}`);
  }
});
