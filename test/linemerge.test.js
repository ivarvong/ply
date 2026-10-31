// The ported xdiff merge, judged by git (`git merge-tree --write-tree`) on hand-built edge cases. The random campaign is
// test/fuzz/linemerge.mjs; this file pins the boundaries: the histogram hash-chain limit (64 clean, 65 → git fails),
// binary sniffing, the size cap, CRLF, a last line without '\n', and identical changes on both sides.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeLines, isBinary, records, classifier, diffScript } from '../src/linemerge.js';
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
  const hunks = mode => diffScript(A, B, { rediff: mode }).map(x => [x.i1, x.chg1, x.i2, x.chg2]).sort((p, q) => p[0] - q[0]);
  assert.deepEqual(hunks('skip'), [[0, 2, 0, 3]]);
  assert.deepEqual(hunks('myers'), [[0, 0, 0, 1], [1, 1, 2, 1]]);
  assert.throws(() => diffScript(A, B, { rediff: 'undecided' }), e => e.undecided === true);
  assert.deepEqual(hunks(undefined), hunks('myers'), 'default follows current git');
  // and the installed git agrees with the mode its version implies (the shape of its -U1 hunk body)
  writeFileSync(join(dir, 'A'), 'a\nb\nc\n'); writeFileSync(join(dir, 'B'), 'c\na\na\nc\n');
  const out = spawnSync(process.env.GIT_BIN ?? 'git', ['diff', '--no-index', '--no-color', '--histogram', '--no-indent-heuristic', '-U1', 'A', 'B'], { cwd: dir }).stdout.toString();
  const body = out.slice(out.indexOf('@@')).split('\n').slice(1).filter(Boolean).map(l => l[0]).join('');
  assert.equal(body, rediff === 'myers' ? '+ -+ ' : '--+++ ', `git's hunk shape matches rediff '${rediff}'`);
});
