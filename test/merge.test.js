// Merging, decided by git: fast-forward / up-to-date / merge-commit / conflict outcomes against `git merge-tree
// --write-tree` (the merged tree oid) and `git merge` in a clone (the commit), over hand-built cases and a seeded
// property run of random three-way edits. Branch create via editFile `base`, and delete, round-trip through receive-pack.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { git, tmpRoot, makeBareRepo, startGitServer, commitFiles, fsckProblems } from './server.js';
import { Rng } from './fuzz/prng.js';
import { oracleRediff } from './gitversion.js';
const rediff = oracleRediff();
import { editFile } from '../src/edit.js';
import { rebaseBranch } from '../src/rebase.js';
import { mergeBranch, deleteBranch, threeWay, bestBases, mergeMode, uniqueObjects, mergeBase } from '../src/merge.js';
import { DEFAULT_LIMITS } from '../src/limits.js';
import { attributesFor } from '../src/attributes.js';
import { createTransport } from '../src/http.js';
import { GitHttp } from '../src/client.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';

// the empty tree as attr.tree: git reads no .gitattributes (our default) whatever its version's bare-repo default is
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
let root, cleanup, srv, n = 0;
const author = { name: 'merger', email: 'merger@x' };
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv.close(); cleanup(); });

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'w', GIT_AUTHOR_EMAIL: 'w@x', GIT_COMMITTER_NAME: 'w', GIT_COMMITTER_EMAIL: 'w@x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' };
const sh = (cwd, args, input) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: ENV, input });
const repo = () => { const name = `m${n++}`; const bare = makeBareRepo(root, name); const work = join(root, `w${name}`); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']); return { name, bare, work, url: `${srv.url}/${name}.git` }; };
// write files on a branch in the work repo and push it
const branchCommit = (r, branch, from, files, msg) => {
  // the bare repo is the truth (our pushes move it); start from its current state of `from`, not the work repo's stale copy
  let start = from;
  if (!/^[0-9a-f]{40}/.test(from)) { const f = sh(r.work, ['fetch', '-q', r.bare, `refs/heads/${from}`]); assert.equal(f.status, 0, f.stderr); start = 'FETCH_HEAD'; }
  sh(r.work, ['checkout', '-q', '-B', branch, start]);
  for (const [p, v] of Object.entries(files)) { if (v === null) { rmSync(join(r.work, p), { force: true }); continue; } mkdirSync(join(r.work, p, '..'), { recursive: true }); writeFileSync(join(r.work, p), v); }
  sh(r.work, ['add', '-A']); const c = sh(r.work, ['commit', '-q', '--allow-empty', '-m', msg]); assert.equal(c.status, 0, c.stderr);
  const p = sh(r.work, ['push', '-q', r.bare, `HEAD:refs/heads/${branch}`]); assert.equal(p.status, 0, p.stderr);
  return sh(r.work, ['rev-parse', 'HEAD']).stdout.trim();
};
// git's answers
// --name-only output: <tree>\n<conflicted paths…>\n\n<informational messages>; exit 0 clean, 1 conflicts
const gitMergeTree = (bare, ours, theirs, attrTree = EMPTY_TREE) => { const r = sh(bare, ['-c', `attr.tree=${attrTree}`, 'merge-tree', '--write-tree', '--name-only', ours, theirs]); assert.ok(r.status === 0 || r.status === 1, r.stderr); const [head] = r.stdout.split('\n\n'); const lines = head.split('\n'); return { clean: r.status === 0, tree: lines[0].trim(), conflicts: lines.slice(1).filter(Boolean), info: r.stdout.split('\n\n').slice(1).join(' ').trim() }; };
const gitMerge = (bare, ref, from) => { const d = mkdtempSync(join(tmpdir(), 'gm-')); try { sh(d, ['clone', '-q', bare, '.']); sh(d, ['checkout', '-q', ref]); const m = sh(d, ['merge', '--no-edit', `origin/${from}`]); return { clean: m.status === 0, tree: sh(d, ['rev-parse', 'HEAD^{tree}']).stdout.trim(), parents: sh(d, ['rev-list', '--parents', '-n1', 'HEAD']).stdout.trim().split(' ').slice(1) }; } finally { rmSync(d, { recursive: true, force: true }); } };
const merge = (r, opts = {}, ex = arrayExporter()) => mergeBranch(r.url, { ref: 'refs/heads/main', from: 'refs/heads/feat', author, ...opts }, { tracer: new Tracer({ exporter: ex }), rediff });

test('threeWay: the trivial-merge rules, one directory', () => {
  const e = (name, oid, mode = '100644') => ({ name, oid, mode });
  const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
  const r = threeWay([e('same', A), e('ours-changed', A), e('theirs-changed', A), e('both-same', A), e('both-diff', A), e('theirs-deleted', A), e('ours-deleted', A), e('dir', A, '40000'), e('both-deleted', A)],
                     [e('same', A), e('ours-changed', B), e('theirs-changed', A), e('both-same', B), e('both-diff', B), e('theirs-deleted', A), e('dir', B, '40000'), e('ours-added', A)],
                     [e('same', A), e('ours-changed', A), e('theirs-changed', B), e('both-same', B), e('both-diff', C), e('ours-deleted', A), e('dir', C, '40000'), e('theirs-added', A), e('both-added-diff', A)]);
  const got = Object.fromEntries(r.entries.map(x => [x.name, x.oid]));
  assert.deepEqual(got, { same: A, 'ours-changed': B, 'theirs-changed': B, 'both-same': B, 'ours-added': A, 'theirs-added': A, 'both-added-diff': A });
  assert.deepEqual(r.recurse, ['dir']); assert.deepEqual(r.conflicts, []); assert.deepEqual(r.content, ['both-diff'], 'a regular file both sides changed goes to the line merge');
  assert.deepEqual(threeWay([e('d', A, '40000')], [], [e('d', B, '40000')]).recurse, ['d'], 'directory deleted on one side, changed on the other → per-file decision');
  assert.deepEqual(threeWay([e('d', A)], [e('d', B, '40000')], [e('d', C)]).conflicts, ['d'], 'file vs directory is a conflict');
  // delete vs modify is a conflict; add/add different is a conflict; mode change vs content change is a content merge (mode from one side)
  assert.deepEqual(threeWay([e('f', A)], [e('f', B)], []).conflicts, ['f']);
  assert.deepEqual(threeWay([], [e('f', A)], [e('f', B)]).conflicts, ['f']);
  assert.deepEqual(threeWay([e('f', A)], [e('f', A, '100755')], [e('f', B)]).content, ['f']);
  assert.equal(mergeMode('100644', '100755', '100644'), '100755'); assert.equal(mergeMode('100644', '100755', '120000'), null);
  // bestBases: git merge-base --all over a known commit graph (child → parents)
  const G = edges => new Map(Object.entries(edges).map(([c, parents]) => [c, { parents }]));
  assert.deepEqual(bestBases(G({ a: ['m'], b: ['m'], m: ['r'], r: [] }), 'a', 'b'), { best: ['m'], truncated: false });
  // criss-cross: two best bases
  assert.deepEqual(bestBases(G({ a: ['x', 'y'], b: ['y', 'x'], x: ['r'], y: ['r'], r: [] }), 'a', 'b').best, ['x', 'y']);
  // the summed-distance trap: a's first parent is old r, but y (a descendant of r) is also common → y is the only best base
  const trap = G({ a: ['r', 'p1'], p1: ['p2'], p2: ['p3'], p3: ['y'], b: ['y'], y: ['r'], r: [] });
  assert.deepEqual(bestBases(trap, 'a', 'b').best, ['y'], 'r is common but an ancestor of y');
  assert.deepEqual(bestBases(G({ a: ['r1'], r1: [], b: ['r2'], r2: [] }), 'a', 'b'), { best: [], truncated: false }, 'unrelated');
  // truncated: b's side runs into a commit whose parents are unknown, outside everything settled → may hide a base
  assert.equal(bestBases(G({ a: ['m'], b: ['q', 'm'], m: [] }), 'a', 'b').truncated, true);
  assert.equal(bestBases(G({ a: ['m'], b: ['m'], m: [] }), 'a', 'b').truncated, false, 'a frontier under a common ancestor does not matter');
  // a pack must not carry an object twice (git: "tried to add buffer twice"); first occurrence wins, order kept
  assert.deepEqual(uniqueObjects([{ oid: 'a', n: 1 }, { oid: 'b' }, { oid: 'a', n: 2 }]), [{ oid: 'a', n: 1 }, { oid: 'b' }]);
});

test('outcomes: up-to-date, fast-forward, ff-only refusal, no-ff merge commit, clean merge, conflict — each equal to git', async () => {
  const r = repo();
  const base = commitFiles(r.work, r.bare, { 'a.txt': 'a\n', 'd/x.txt': 'x\n', 'd/y.txt': 'y\n' }, 'base');
  // branch ahead of main by one commit → fast-forward
  const feat1 = branchCommit(r, 'feat', 'main', { 'b.txt': 'b\n' }, 'feat1');
  assert.equal((await merge(r, { from: 'refs/heads/main' })).outcome, 'up_to_date', 'merging main into itself');
  let m = await merge(r);
  assert.equal(m.outcome, 'fast_forward'); assert.equal(sh(r.bare, ['rev-parse', 'main']).stdout.trim(), feat1);
  assert.equal((await merge(r)).outcome, 'up_to_date');
  // no-ff: a merge commit even when a fast-forward was possible
  const feat2 = branchCommit(r, 'feat', 'feat', { 'c.txt': 'c\n' }, 'feat2');
  const ex = arrayExporter();
  m = await merge(r, { noFastForward: true }, ex);
  assert.equal(m.outcome, 'merge'); assert.deepEqual(sh(r.bare, ['rev-list', '--parents', '-n1', 'main']).stdout.trim().split(' ').slice(1), [feat1, feat2]);
  assert.equal(sh(r.bare, ['rev-parse', 'main^{tree}']).stdout.trim(), sh(r.bare, ['rev-parse', `${feat2}^{tree}`]).stdout.trim(), 'tree is theirs (ours unchanged)');
  assert.equal(m.newTrees, 0, 'no new tree objects needed');
  assert.match(sh(r.bare, ['log', '-1', '--format=%s', 'main']).stdout, /^Merge feat into main/);
  // diverged, disjoint: ours touched a.txt and d/x.txt, theirs added e.txt and changed d/y.txt → clean merge, tree == git merge-tree
  const ours3 = branchCommit(r, 'main', 'main', { 'a.txt': 'a2\n', 'd/x.txt': 'x2\n' }, 'ours3');
  const theirs3 = branchCommit(r, 'feat', 'feat', { 'e.txt': 'e\n', 'd/y.txt': 'y2\n' }, 'theirs3');
  await assert.rejects(merge(r, { fastForwardOnly: true }), e => e.code === 'not_fast_forward');
  const gmt = gitMergeTree(r.bare, ours3, theirs3); assert.ok(gmt.clean);
  const gm = gitMerge(r.bare, 'main', 'feat');
  const ex3 = arrayExporter();
  m = await merge(r, {}, ex3);
  assert.equal(m.outcome, 'merge'); assert.equal(m.tree, gmt.tree, 'our merged tree == git merge-tree'); assert.equal(m.tree, gm.tree, '== git merge');
  assert.deepEqual(sh(r.bare, ['rev-list', '--parents', '-n1', 'main']).stdout.trim().split(' ').slice(1), [ours3, theirs3]);
  assert.equal(sh(r.bare, ['cat-file', '-p', 'main:d/y.txt']).stdout, 'y2\n'); assert.equal(sh(r.bare, ['cat-file', '-p', 'main:a.txt']).stdout, 'a2\n');
  const rootSpan = ex3.lines.flatMap(flattenLine).find(s => s.name === 'git.merge');
  assert.equal(rootSpan.attrs['git.merge.base'], feat2); assert.equal(m.newTrees, 2, 'root + d/ rewritten'); assert.ok(rootSpan.attrs['git.merge.trees.fetched'] <= 6, 'only differing directories fetched');
  assert.deepEqual(fsckProblems(r.bare), []);
  // conflict: both modify a.txt differently
  const ours4 = branchCommit(r, 'main', 'main', { 'a.txt': 'a3\n' }, 'ours4');
  const theirs4 = branchCommit(r, 'feat', 'feat', { 'a.txt': 'a4\n', 'f.txt': 'f\n' }, 'theirs4');
  const gc = gitMergeTree(r.bare, ours4, theirs4); assert.equal(gc.clean, false); assert.deepEqual(gc.conflicts, ['a.txt']);
  const ex4 = arrayExporter();
  await assert.rejects(merge(r, {}, ex4), e => e.code === 'merge_conflict' && e.conflicts.length === 1 && e.conflicts[0] === 'a.txt');
  assert.equal(sh(r.bare, ['rev-parse', 'main']).stdout.trim(), ours4, 'nothing pushed on conflict');
  assert.deepEqual(ex4.lines.flatMap(flattenLine).find(s => s.name === 'git.merge').attrs['git.merge.conflicts'], ['a.txt']);
  // unrelated histories
  const r2 = repo(); commitFiles(r2.work, r2.bare, { 'z.txt': 'z\n' }, 'other root');
  sh(r.work, ['remote', 'add', 'o2', r2.bare]); sh(r.work, ['fetch', '-q', 'o2']); sh(r.work, ['push', '-q', r.bare, 'o2/main:refs/heads/unrelated']);
  await assert.rejects(merge(r, { from: 'refs/heads/unrelated' }), e => e.code === 'unrelated_histories');
});

test('line merge and renames, judged by git: disjoint edits to one file merge to git\'s bytes; same-line edits, binary, and rename shapes conflict', async () => {
  const body = (n, k = 30) => Array.from({ length: k }, (_, i) => `line ${i} of ${n}\n`).join('');
  const lines = body('a').split(/(?<=\n)/);
  const cases = [
    // [name, base files, ours files, theirs files, git clean?]
    ['disjoint edits', { 'a.txt': body('a') }, { 'a.txt': ['TOP\n', ...lines.slice(1)].join('') }, { 'a.txt': [...lines.slice(0, -1), 'BOTTOM\n'].join('') }, true],
    ['same line', { 'a.txt': body('a') }, { 'a.txt': ['OURS\n', ...lines.slice(1)].join('') }, { 'a.txt': ['THEIRS\n', ...lines.slice(1)].join('') }, false],
    ['identical insertions', { 'a.txt': body('a') }, { 'a.txt': [...lines.slice(0, 5), 'SAME\n', ...lines.slice(5)].join('') }, { 'a.txt': [...lines.slice(0, 5), 'SAME\n', ...lines.slice(5), 'END\n'].join('') }, true],
    ['no final newline', { 'a.txt': body('a') + 'tail' }, { 'a.txt': 'HEAD\n' + body('a').slice(lines[0].length) + 'tail' }, { 'a.txt': body('a') + 'tail2' }, true],
    ['binary', { 'b.bin': 'x\0' + body('b') }, { 'b.bin': 'y\0' + body('b') }, { 'b.bin': 'x\0' + body('b') + 'z\n' }, false],
    ['rename/rename(1to2)', { 'a.txt': body('a') }, { 'a.txt': null, 'b.txt': body('a') }, { 'a.txt': null, 'c.txt': body('a') }, false],
    ['rename/delete', { 'a.txt': body('a') }, { 'a.txt': null, 'b.txt': body('a') }, { 'a.txt': null }, false],
    ['dir rename + add', { 'd/x.txt': body('x'), 'd/y.txt': body('y') }, { 'd/x.txt': null, 'd/y.txt': null, 'e/x.txt': body('x'), 'e/y.txt': body('y') }, { 'd/new.txt': 'new\n' }, false],
  ];
  for (const [name, base, o, th, gitClean] of cases) {
    const r = repo();
    const b = commitFiles(r.work, r.bare, base, 'base');
    const theirs = branchCommit(r, 'feat', b, th, 'theirs'); const ours = branchCommit(r, 'main', b, o, 'ours');
    const g = gitMergeTree(r.bare, ours, theirs);
    assert.equal(g.clean, gitClean, `${name}: the case means what it says (git ${g.clean ? 'clean' : 'conflicts'})`);
    let m = null, err = null; try { m = await merge(r); } catch (e) { err = e; }
    if (gitClean) { assert.ok(m, `${name}: git merges cleanly, so must we (${err?.message})`); assert.equal(m.tree, g.tree, `${name}: tree == git merge-tree`); assert.deepEqual(fsckProblems(r.bare), []); }
    else assert.equal(err?.code, 'merge_conflict', `${name}: git conflicts, so must we`);
  }
});

test('limits: a file over maxMergeBlobBytes is a conflict with that reason (git would merge it: the cap is ours); merge-base search depth is bounded', async () => {
  const r = repo();
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i}\n`);
  const b = commitFiles(r.work, r.bare, { 'big.txt': lines.join('') }, 'base');
  branchCommit(r, 'feat', b, { 'big.txt': [...lines.slice(0, -1), 'END\n'].join('') }, 'theirs');
  const ours = branchCommit(r, 'main', b, { 'big.txt': ['TOP\n', ...lines.slice(1)].join('') }, 'ours');
  const limits = { ...DEFAULT_LIMITS, maxMergeBlobBytes: 1000 };
  await assert.rejects(mergeBranch(r.url, { ref: 'refs/heads/main', from: 'refs/heads/feat', author }, { tracer: new Tracer(), rediff, limits }), e => e.code === 'merge_conflict' && e.reasons['big.txt'] === 'too large to merge');
  assert.equal(sh(r.bare, ['rev-parse', 'main']).stdout.trim(), ours, 'nothing pushed');
  assert.equal((await merge(r)).outcome, 'merge', 'within the default cap the same merge is clean');
  assert.equal(sh(r.bare, ['cat-file', '-p', 'main:big.txt']).stdout, ['TOP\n', ...lines.slice(1, -1), 'END\n'].join(''));
  // two branches 10 commits from their common root, search capped at depth 8 → limit_exceeded (not a wrong answer)
  const r2 = repo(); const root = commitFiles(r2.work, r2.bare, { 'x': '0\n' }, 'root');
  let a = root, c = root; for (let i = 1; i <= 10; i++) { a = branchCommit(r2, 'a', a, { 'x': `a${i}\n` }, `a${i}`); c = branchCommit(r2, 'c', c, { 'x': `c${i}\n` }, `c${i}`); }
  const t = createTransport(r2.url, { tracer: new Tracer() });
  await assert.rejects(mergeBase(t, a, c, { maxDepth: 8 }), e => e.code === 'limit_exceeded');
  assert.equal((await mergeBase(t, a, c, { maxDepth: 16 })).base, root);
});

test('merge bases decided by git: criss-cross refuses (git builds a virtual base we do not), the summed-distance trap now picks git\'s base', async () => {
  const run = (w, args) => { const x = sh(w, args); assert.equal(x.status, 0, `${args.join(' ')}: ${x.stderr}`); return x.stdout.trim(); };
  const put = (w, p, v) => { writeFileSync(join(w, p), v); run(w, ['add', '-A']); };
  // criss-cross where the first-parent base is the wrong one: main = merge(C1, A1) keeps f=a; feat = merge(A1, C1) reverts f
  {
    const r = repo(); const w = r.work;
    put(w, 'f', 'x\n'); run(w, ['commit', '-qm', 'B']);
    run(w, ['checkout', '-qb', 'side']); put(w, 'g', 'g\n'); run(w, ['commit', '-qm', 'C1']); const C1 = run(w, ['rev-parse', 'HEAD']);
    run(w, ['checkout', '-q', 'main']); put(w, 'f', 'a\n'); run(w, ['commit', '-qm', 'A1']); const A1 = run(w, ['rev-parse', 'HEAD']);
    run(w, ['checkout', '-q', '--detach', C1]); run(w, ['merge', '-q', '--no-edit', A1]); const M = run(w, ['rev-parse', 'HEAD']);
    run(w, ['checkout', '-q', '--detach', A1]); sh(w, ['merge', '-q', '--no-commit', C1]); put(w, 'f', 'x\n'); run(w, ['commit', '-qm', 'F reverts f']); const F = run(w, ['rev-parse', 'HEAD']);
    run(w, ['push', '-q', '-f', r.bare, `${M}:refs/heads/main`, `${F}:refs/heads/feat`]);
    assert.equal(run(r.bare, ['merge-base', '--all', 'main', 'feat']).split('\n').length, 2);
    const g = gitMergeTree(r.bare, M, F); assert.ok(g.clean); assert.equal(run(r.bare, ['cat-file', '-p', `${g.tree}:f`]), 'x', 'git: virtual base → f=x');
    await assert.rejects(merge(r), e => e.code === 'merge_conflict' && e.bases.length === 2 && /criss-cross/.test(e.message));
    assert.equal(run(r.bare, ['rev-parse', 'main']), M, 'nothing pushed');
    await assert.rejects(rebaseBranch(r.url, { ref: 'refs/heads/feat', onto: 'refs/heads/main', committer: author }, { tracer: new Tracer() }), e => e.code === 'not_linear');
  }
  // the trap: main = merge(r, p3) with first parent the old root r, p3 ← … ← y ← r; feat ← y. Best base is y (r is its
  // ancestor). main's merge reverted f to r's content; feat left y's. git: base y → f=r. Base r would give f=y.
  {
    const r = repo(); const w = r.work;
    put(w, 'f', 'r\n'); run(w, ['commit', '-qm', 'r']); const R = run(w, ['rev-parse', 'HEAD']);
    put(w, 'f', 'y\n'); run(w, ['commit', '-qm', 'y']); const Y = run(w, ['rev-parse', 'HEAD']);
    run(w, ['checkout', '-qb', 'feat']); put(w, 'h', 'h\n'); run(w, ['commit', '-qm', 'feat']); const FT = run(w, ['rev-parse', 'HEAD']);
    run(w, ['checkout', '-q', '--detach', Y]); for (let i = 1; i <= 3; i++) { put(w, `p${i}`, `${i}\n`); run(w, ['commit', '-qm', `p${i}`]); } const P3 = run(w, ['rev-parse', 'HEAD']);
    run(w, ['checkout', '-q', '--detach', R]); sh(w, ['merge', '-q', '--no-ff', '--no-commit', P3]); put(w, 'f', 'r\n'); run(w, ['commit', '-qm', 'merge keeps r']); const MM = run(w, ['rev-parse', 'HEAD']);
    run(w, ['push', '-q', '-f', r.bare, `${MM}:refs/heads/main`, `${FT}:refs/heads/feat`]);
    assert.equal(run(r.bare, ['merge-base', '--all', 'main', 'feat']), Y);
    const g = gitMergeTree(r.bare, MM, FT); assert.ok(g.clean);
    const m = await merge(r); assert.equal(m.base, Y); assert.equal(m.tree, g.tree, 'tree == git merge-tree');
    assert.equal(run(r.bare, ['cat-file', '-p', 'main:f']), 'r');
  }
});

test('.gitattributes merge drivers, judged by git (attr.tree): union, -merge, binary macro, nested override; each attribute source', async () => {
  const L = n => Array.from({ length: n }, (_, i) => `entry ${i}\n`).join('');
  const rootAttrs = 'CHANGELOG merge=union\n*.lock -merge\nnotes.txt binary\ndocs/** merge=union\n';
  for (const [source, attrsOn] of [[null, null], ['ours', 'main'], ['theirs', 'feat'], ['base', 'base'], ['refs/heads/attrs', 'attrs']]) {
    const r = repo();
    // attributes live only where the case says, so each source gives a different verdict
    const withAttrs = side => attrsOn === side || (attrsOn === 'attrs' && false);
    const b = commitFiles(r.work, r.bare, { 'CHANGELOG': L(5), 'deps.lock': L(5), 'notes.txt': L(5), 'docs/a.md': L(5), 'plain.txt': L(5), ...(withAttrs('base') ? { '.gitattributes': rootAttrs, 'docs/.gitattributes': 'a.md -merge\n' } : {}) }, 'base');
    const theirs = branchCommit(r, 'feat', b, { 'CHANGELOG': L(5) + 'theirs entry\n', 'deps.lock': 'T\n' + L(5).slice(8), 'notes.txt': L(5) + 'T\n', 'docs/a.md': L(5) + 'T\n', ...(withAttrs('feat') ? { '.gitattributes': rootAttrs, 'docs/.gitattributes': 'a.md -merge\n' } : {}) }, 'theirs');
    const ours = branchCommit(r, 'main', b, { 'CHANGELOG': L(5) + 'ours entry\n', 'deps.lock': L(5) + 'O\n', 'notes.txt': 'O\n' + L(5).slice(8), 'docs/a.md': 'O\n' + L(5).slice(8), ...(withAttrs('main') ? { '.gitattributes': rootAttrs, 'docs/.gitattributes': 'a.md -merge\n' } : {}) }, 'ours');
    let attrRev = { null: EMPTY_TREE, ours, theirs, base: b }[String(source)];
    if (attrsOn === 'attrs') { attrRev = branchCommit(r, 'attrs', b, { '.gitattributes': rootAttrs, 'docs/.gitattributes': 'a.md -merge\n' }, 'attributes only'); }
    const g = gitMergeTree(r.bare, ours, theirs, attrRev);
    const ex = arrayExporter();
    let m = null, err = null; try { m = await mergeBranch(r.url, { ref: 'refs/heads/main', from: 'refs/heads/feat', author }, { tracer: new Tracer({ exporter: ex }), rediff, attributes: source }); } catch (e) { err = e; }
    const label = `attributes=${source}`;
    if (g.clean) { assert.ok(m, `${label}: git clean, we ${err?.message}`); assert.equal(m.tree, g.tree, `${label}: tree == git`); }
    else { assert.equal(err?.code, 'merge_conflict', `${label}: git conflicts on ${g.conflicts}`); for (const p of g.conflicts) assert.ok(err.conflicts.includes(p), `${label}: git conflicts on ${p}, we did not (${err.message})`); }
    if (source === null) assert.deepEqual(g.conflicts.sort(), ['CHANGELOG'], 'no attributes: only the changelog conflicts (line-level clash), the rest line-merge');
    else {
      // with the attributes: the changelog unions, the lock and notes.txt (binary macro) and docs/a.md (nested -merge) conflict
      assert.deepEqual(g.conflicts.sort(), ['deps.lock', 'docs/a.md', 'notes.txt'], `${label}: git's verdict is what the attributes say`);
      assert.equal(err.reasons['deps.lock'], 'binary (merge attribute)');
      assert.equal(ex.lines.flatMap(flattenLine).find(sp => sp.name === 'git.merge').attrs['git.merge.content.attr_binary'], 3);
    }
  }
  // the union result itself, byte for byte: a merge where only the changelog clashes
  const r = repo();
  const b = commitFiles(r.work, r.bare, { 'CHANGELOG': L(3), '.gitattributes': 'CHANGELOG merge=union\n' }, 'base');
  const theirs = branchCommit(r, 'feat', b, { 'CHANGELOG': L(3) + 'theirs 1\ntheirs 2' }, 'theirs'); // no final newline: union adds one between
  const ours = branchCommit(r, 'main', b, { 'CHANGELOG': L(3) + 'ours 1\nours 2' }, 'ours');
  const g = gitMergeTree(r.bare, ours, theirs, ours); assert.ok(g.clean);
  const m = await mergeBranch(r.url, { ref: 'refs/heads/main', from: 'refs/heads/feat', author }, { tracer: new Tracer(), rediff, attributes: 'ours' });
  assert.equal(m.tree, g.tree);
  assert.equal(sh(r.bare, ['cat-file', '-p', 'main:CHANGELOG']).stdout, L(3) + 'ours 1\nours 2\ntheirs 1\ntheirs 2');
  await assert.rejects(mergeBranch(r.url, { ref: 'refs/heads/main', from: 'refs/heads/feat', author }, { tracer: new Tracer(), attributes: 'nope nope' }), e => e.code === 'bad_request');
  await assert.rejects(mergeBranch(r.url, { ref: 'refs/heads/main', from: 'refs/heads/feat', author }, { tracer: new Tracer(), attributes: 42 }), e => e.code === 'bad_request');
});

test('names that are Object.prototype members (#16): a directory rename + add inside `constructor`/`__proto__`/…, a rename onto `__proto__`, a `__proto__` content conflict — each judged by git', async () => {
  const body = (n, k = 30) => Array.from({ length: k }, (_, i) => `line ${i} of ${n}\n`).join('');
  const lines = body('a').split(/(?<=\n)/);
  // computed keys: a literal `__proto__:` key would set the prototype, not name a file
  const cases = [];
  for (const d of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    cases.push([`dir rename + add in ${d}/`, { [`${d}/x.txt`]: body('x'), [`${d}/y.txt`]: body('y') }, { [`${d}/x.txt`]: null, [`${d}/y.txt`]: null, ['e/x.txt']: body('x'), ['e/y.txt']: body('y') }, { [`${d}/new.txt`]: 'new\n' }]);
    cases.push([`dir rename + add in ${d}/ (theirs renames)`, { [`${d}/x.txt`]: body('x'), [`${d}/y.txt`]: body('y') }, { [`${d}/new.txt`]: 'new\n' }, { [`${d}/x.txt`]: null, [`${d}/y.txt`]: null, ['e/x.txt']: body('x'), ['e/y.txt']: body('y') }]);
  }
  cases.push(['rename/delete onto __proto__', { ['a.txt']: body('a') }, { ['a.txt']: null, ['__proto__']: body('a') }, { ['a.txt']: null }]);
  cases.push(['same line in __proto__', { ['__proto__']: body('a') }, { ['__proto__']: ['OURS\n', ...lines.slice(1)].join('') }, { ['__proto__']: ['THEIRS\n', ...lines.slice(1)].join('') }]);
  cases.push(['same line in constructor/__proto__', { ['constructor/__proto__']: body('a') }, { ['constructor/__proto__']: ['OURS\n', ...lines.slice(1)].join('') }, { ['constructor/__proto__']: ['THEIRS\n', ...lines.slice(1)].join('') }]);
  for (const [name, base, o, th] of cases) {
    const r = repo();
    const b = commitFiles(r.work, r.bare, base, 'base');
    const theirs = branchCommit(r, 'feat', b, th, 'theirs'); const ours = branchCommit(r, 'main', b, o, 'ours');
    const g = gitMergeTree(r.bare, ours, theirs);
    assert.equal(g.clean, false, `${name}: git conflicts (the case means what it says)`);
    let m = null, err = null; try { m = await merge(r); } catch (e) { err = e; }
    assert.equal(err?.code, 'merge_conflict', `${name}: git conflicts on ${g.conflicts} (${g.info}), so must we — we merged to ${m?.tree}`);
    for (const p of g.conflicts) assert.ok(err.conflicts.includes(p) || Object.values(err.reasons).some(x => /directory rename/.test(x)), `${name}: git conflicts on ${p}, we did not (${err.message})`);
    for (const p of err.conflicts) assert.equal(typeof Object.getOwnPropertyDescriptor(err.reasons, p)?.value, 'string', `${name}: ${p} has its own reason (${err.message})`);
    assert.equal(sh(r.bare, ['rev-parse', 'main']).stdout.trim(), ours, `${name}: nothing pushed on conflict`);
  }
});

test('.gitattributes [:class:] names that are Object.prototype members (#16): attributes == git check-attr, merge drivers == git merge-tree, never an untyped error', async () => {
  const L = n => Array.from({ length: n }, (_, i) => `entry ${i}\n`).join('');
  const attrs = 'x[[:hasOwnProperty:]] -merge\n*[[:constructor:]]* -merge\n*[[:toString:]]* merge=union\n*[[:__proto__:]]* -merge\n*[[:valueOf:]] merge=union\n*[[:alpha:]].log merge=union\n';
  const paths = ['a.txt', 'xy', 'x1', 'constructor', 'toString.md', 'b.log', '__proto__', 'd/a.txt', 'd/x:'];
  // check-attr: git's verdict for every path, against attributesFor
  const r = repo();
  const b = commitFiles(r.work, r.bare, { '.gitattributes': attrs, ...Object.fromEntries(paths.map(p => [p, L(5)])) }, 'base');
  const res = sh(r.work, ['check-attr', `--source=${b}`, '-a', '-z', '--stdin'], paths.join('\0') + '\0');
  assert.equal(res.status, 0, res.stderr);
  const fields = res.stdout.split('\0'), want = new Map(paths.map(p => [p, []]));
  for (let i = 0; i + 2 < fields.length; i += 3) want.get(fields[i]).push([fields[i + 1], fields[i + 2]]);
  for (const p of paths) {
    const ours = [...attributesFor(p, new Map([['', attrs]]))].filter(([, v]) => v !== null).map(([k, v]) => [k, v === true ? 'set' : v === false ? 'unset' : v]);
    assert.deepEqual(ours.sort(), want.get(p).sort(), `${p}: attributes == git check-attr`);
  }
  assert.deepEqual(want.get('b.log'), [['merge', 'union']], 'a real class still matches');
  // merge: every file changes the same line on both sides; only b.log (union) is clean in git
  const theirs = branchCommit(r, 'feat', b, Object.fromEntries(paths.map(p => [p, L(5) + 'theirs\n'])), 'theirs');
  const ours = branchCommit(r, 'main', b, Object.fromEntries(paths.map(p => [p, L(5) + 'ours\n'])), 'ours');
  const g = gitMergeTree(r.bare, ours, theirs, ours);
  let err = null; try { await mergeBranch(r.url, { ref: 'refs/heads/main', from: 'refs/heads/feat', author }, { tracer: new Tracer(), rediff, attributes: 'ours' }); } catch (e) { err = e; }
  assert.equal(err?.code, 'merge_conflict', `git conflicts on ${g.conflicts}; we: ${err?.code} ${err?.message}`);
  assert.deepEqual([...err.conflicts].sort(), [...g.conflicts].sort(), 'conflicts == git merge-tree');
  for (const p of err.conflicts) assert.match(err.reasons[p], /^content/, `${p}: a text conflict, not -merge from a pattern git does not match`);
});

test('branch workflow: editFile creates the branch from main (CAS: must not exist), merge lands it, delete removes it', async () => {
  const r = repo();
  const base = commitFiles(r.work, r.bare, { 'README.md': 'hello MARK\n' }, 'base');
  const e = await editFile(r.url, { path: 'README.md', find: 'MARK', replace: 'EDITED', ref: 'refs/heads/ply/edit-1', base: 'refs/heads/main', author, message: 'edit on a branch' }, { tracer: new Tracer() });
  assert.equal(e.oldCommit, base); assert.equal(sh(r.bare, ['rev-parse', 'refs/heads/ply/edit-1']).stdout.trim(), e.newCommit);
  assert.equal(sh(r.bare, ['rev-parse', 'main']).stdout.trim(), base, 'main untouched');
  assert.equal(sh(r.bare, ['rev-parse', `${e.newCommit}^`]).stdout.trim(), base, 'parent is main\'s head');
  await assert.rejects(editFile(r.url, { path: 'README.md', find: 'MARK', replace: 'AGAIN', ref: 'refs/heads/ply/edit-1', base: 'refs/heads/main', author, message: 'm' }, { tracer: new Tracer() }), e => e.code === 'cas_conflict', 'branch exists → create refused');
  const m = await mergeBranch(r.url, { ref: 'refs/heads/main', from: 'refs/heads/ply/edit-1', author }, { tracer: new Tracer() });
  assert.equal(m.outcome, 'fast_forward'); assert.equal(sh(r.bare, ['rev-parse', 'main']).stdout.trim(), e.newCommit);
  assert.equal(sh(r.bare, ['cat-file', '-p', 'main:README.md']).stdout, 'hello EDITED\n');
  const t = createTransport(r.url, { tracer: new Tracer() });
  await deleteBranch(t, { ref: 'refs/heads/ply/edit-1', oid: e.newCommit });
  assert.notEqual(sh(r.bare, ['show-ref', '--verify', 'refs/heads/ply/edit-1']).status, 0, 'branch gone');
  // deleting with a stale oid is a CAS failure; deleting the current branch is refused by policy (receive.denyDeleteCurrent)
  sh(r.work, ['push', '-q', r.bare, `${base}:refs/heads/tmp`]);
  await assert.rejects(deleteBranch(t, { ref: 'refs/heads/tmp', oid: e.newCommit }), e => e.code === 'cas_conflict', 'stale oid');
  assert.equal(sh(r.bare, ['rev-parse', 'refs/heads/tmp']).stdout.trim(), base, 'tmp still there');
  await assert.rejects(deleteBranch(t, { ref: 'refs/heads/main', oid: e.newCommit }), e => e.code === 'push_rejected' && /current branch/.test(e.message));
  assert.equal(sh(r.bare, ['rev-parse', 'main']).stdout.trim(), e.newCommit, 'main still there');
  assert.deepEqual(fsckProblems(r.bare), []);
});

test('property: random three-way tree edits — clean merges equal git merge-tree; our conflicts ⊇ git\'s, and never a wrong tree', async () => {
  const rng = new Rng(+(process.env.MERGE_SEED ?? 11));
  const N = +(process.env.MERGE_CASES ?? 24);
  const stats = { clean: 0, conflict: 0, conservative: 0, nonRename: 0, lineMerged: 0, criss: 0, shapes: [0, 0, 0], withAttrs: 0, unioned: 0, attrBinary: 0 };
  for (let i = 0; i < N; i++) {
    const r = repo();
    const dirs = ['', 'a/', 'a/b/', 'c/']; const names = ['f1', 'f2', 'f3', 'f4'];
    // multi-line files: line-level edits make both sides touch the same file in different places, so git (and we) line-merge
    const body = p => Array.from({ length: 8 }, (_, j) => (j % 3 === 2 ? '}\n' : `${p} line ${j}\n`));
    const files = {}; for (const d of dirs) for (const nm of names) if (rng.int(0, 2)) files[`${d}${nm}.txt`] = body(`${d}${nm}`).join('');
    if (!Object.keys(files).length) files['f.txt'] = body('f').join('');
    // .gitattributes at the root and in a/ (some cases), naming merge drivers for some of the files
    const attrLine = () => `${rng.pick(['*.txt', 'f1.txt', 'f2.txt', '**/f3.txt', 'b/*', '/f4.txt', 'new*.txt'])} ${rng.pick(['merge=union', '-merge', 'binary', 'merge', 'merge=text', '!merge', 'merge=custom'])}\n`;
    if (rng.int(0, 1)) files['.gitattributes'] = Array.from({ length: rng.int(1, 3) }, attrLine).join('');
    if (rng.int(0, 2) === 0) files['a/.gitattributes'] = Array.from({ length: rng.int(1, 2) }, attrLine).join('');
    const attrSource = rng.pick([null, null, 'ours', 'theirs', 'base']);
    commitFiles(r.work, r.bare, files, 'base');
    const lineEdit = p => { const ls = files[p].split(/(?<=\n)/); const at = rng.int(0, ls.length - 1); const k = rng.int(0, 2);
      if (k === 0) ls[at] = `${p} edit ${rng.int(0, 9)}\n`; else if (k === 1) ls.splice(at, 1); else ls.splice(at, 0, rng.int(0, 1) ? '}\n' : `ins ${rng.int(0, 9)}\n`); return ls.join(''); };
    const edit = () => { const ch = {}; for (const p of [...Object.keys(files), `${dirs[rng.int(0, 3)]}new${rng.int(0, 3)}.txt`]) { const k = rng.int(0, 7); if (k <= 1) ch[p] = files[p] ? lineEdit(p) : `${p} new ${rng.int(0, 9)}\n`; else if (k === 2 && files[p]) ch[p] = null; else if (k === 3 && files[p] && !rng.int(0, 3)) { ch[p] = null; ch[`${dirs[rng.int(0, 3)]}moved-${p.replace(/\//g, '_')}`] = lineEdit(p); } } return ch; };
    const o = edit(), th = edit();
    const base = sh(r.bare, ['rev-parse', 'main']).stdout.trim();
    let theirs = Object.keys(th).length ? branchCommit(r, 'feat', base, th, 'theirs') : (sh(r.work, ['push', '-q', r.bare, `${base}:refs/heads/feat`]), base);
    let ours = Object.keys(o).length ? branchCommit(r, 'main', base, o, 'ours') : base;
    // history shapes: 0 plain; 1 main already merged feat once (merge commits in ours' history); 2 criss-cross (each side
    // merged the other's tip); after 1 and 2 both sides edit again. A merge resolves content with -X ours|theirs and
    // anything left (modify/delete) by taking the working tree as is.
    const shape = ours !== base && theirs !== base ? rng.int(0, 2) : 0;
    if (shape) {
      const mergeAt = (branch, at, other, x) => {
        sh(r.work, ['checkout', '-q', '--detach', at]);
        if (sh(r.work, ['merge', '-q', '--no-ff', '--no-edit', `-X${x}`, other]).status !== 0) { sh(r.work, ['add', '-A']); sh(r.work, ['commit', '-qm', `merge ${other.slice(0, 7)}`]); }
        const c = sh(r.work, ['rev-parse', 'HEAD']).stdout.trim(); sh(r.work, ['push', '-q', '-f', r.bare, `${c}:refs/heads/${branch}`]); return c;
      };
      const o0 = ours, t0 = theirs;
      ours = mergeAt('main', o0, t0, rng.pick(['ours', 'theirs']));
      let t1 = t0; if (shape === 2) t1 = mergeAt('feat', t0, o0, rng.pick(['ours', 'theirs']));
      const o2 = edit(), t2 = edit();
      if (Object.keys(o2).length) ours = branchCommit(r, 'main', ours, o2, 'ours again');
      if (Object.keys(t2).length) t1 = branchCommit(r, 'feat', t1, t2, 'theirs again');
      theirs = t1; stats.shapes[shape]++;
    }
    const nBases = sh(r.bare, ['merge-base', '--all', ours, theirs]).stdout.trim().split('\n').filter(Boolean).length;
    const baseOid = sh(r.bare, ['merge-base', ours, theirs]).stdout.trim();
    const g = gitMergeTree(r.bare, ours, theirs, attrSource === null ? EMPTY_TREE : { ours, theirs, base: baseOid }[attrSource]);
    const ex = arrayExporter();
    let m, err = null; try { m = await mergeBranch(r.url, { ref: 'refs/heads/main', from: 'refs/heads/feat', author }, { tracer: new Tracer({ exporter: ex }), rediff, attributes: attrSource }); } catch (e) { err = e; }
    if (attrSource) stats.withAttrs++;
    { const a = ex.lines.flatMap(flattenLine).find(sp => sp.name === 'git.merge')?.attrs ?? {}; stats.unioned += a['git.merge.content.unioned'] ?? 0; stats.attrBinary += a['git.merge.content.attr_binary'] ?? 0; }
    stats.lineMerged += ex.lines.flatMap(flattenLine).find(s => s.name === 'git.merge')?.attrs['git.merge.content.merged'] ?? 0;
    if (err && err.code !== 'merge_conflict') throw err;
    if (!err) {
      stats.clean++;
      assert.ok(g.clean, `case ${i}: we merged cleanly but git conflicts on ${g.conflicts}`);
      const tree = m.outcome === 'merge' ? m.tree : sh(r.bare, ['rev-parse', `${m.oid}^{tree}`]).stdout.trim();
      assert.equal(tree, g.tree, `case ${i}: tree differs from git merge-tree (outcome ${m.outcome})`);
      assert.deepEqual(fsckProblems(r.bare), []);
    } else if (nBases > 1) {
      // criss-cross: git merges the bases into a virtual one; we refuse, whatever git's verdict
      assert.ok(err.bases?.length === nBases, `case ${i}: ${nBases} merge bases must be refused as such (${err.message})`); stats.criss++;
    } else {
      stats.conflict++;
      // our conflicts are a superset of git's: where git is clean and we are not, that is the Myers-fallback abort
      if (g.clean) { stats.conservative++; if (!Object.values(err.reasons ?? {}).some(x => /rename/.test(x))) stats.nonRename++; if (process.env.MERGE_DEBUG) console.log(`  conservative ${i}: ${err.message}`); }
      // per path: every path git conflicts on is one of ours — except a directory-rename target, a path git computes
      // from the rename (G2 reports the added path instead, with its reason)
      else for (const p of g.conflicts) assert.ok(err.conflicts.some(q => q === p || (q.endsWith('/') && p.startsWith(q))) || (/directory rename/.test(g.info) && Object.values(err.reasons ?? {}).some(x => /directory rename/.test(x))), `case ${i}: git conflicts on ${p}, we did not (ours: ${err.message}; git: ${g.conflicts} ${g.info ?? ''})`);
    }
  }
  console.log(`  ${N} cases (shapes plain/merged/criss-cross ${N - stats.shapes[1] - stats.shapes[2]}/${stats.shapes[1]}/${stats.shapes[2]}): clean=${stats.clean} conflict=${stats.conflict} criss-cross refused=${stats.criss} attr-source cases=${stats.withAttrs} (union-resolved files=${stats.unioned}, merge-attribute binary conflicts=${stats.attrBinary}) (conservative: ${stats.conservative}, not from a rename guard: ${stats.nonRename}) files line-merged: ${stats.lineMerged}`);
  assert.ok(stats.clean > 0 && stats.conflict > 0 && stats.lineMerged > 0, 'the line merge was exercised');
  assert.equal(stats.nonRename, 0, 'outside the rename guards, never conservative: the line merge is git\'s');
});
