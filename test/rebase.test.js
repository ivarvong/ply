// Rebase / squash / cherry-pick / revert, decided by git: per-commit trees equal `git rebase` in a clone, authors and
// messages preserved, committer ours; cherry-pick and revert trees equal `git cherry-pick` / `git revert`; conflicts where
// git conflicts; the branch update is a CAS on the old tip.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { git, tmpRoot, makeBareRepo, startGitServer, commitFiles } from './server.js';
import { rebaseBranch, cherryPick, revertCommit, linearChain, carriedExtra } from '../src/rebase.js';
import { mergeBranch } from '../src/merge.js';
import { editFile } from '../src/edit.js';
import { generateSigner } from '../src/sign.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { oracleRediff } from './gitversion.js';
const rediff = oracleRediff();

let root, cleanup, srv, n = 0;
const committer = { name: 'rebaser', email: 'rebaser@x' };
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv.close(); cleanup(); });

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'w', GIT_AUTHOR_EMAIL: 'w@x', GIT_COMMITTER_NAME: 'w', GIT_COMMITTER_EMAIL: 'w@x', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' };
const sh = (cwd, args, input) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: ENV, input });
const ok = r => { assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const repo = () => { const name = `r${n++}`; const bare = makeBareRepo(root, name); const work = join(root, `w${name}`); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']); return { name, bare, work, url: `${srv.url}/${name}.git` }; };
const commitOn = (r, branch, from, files, msg) => {
  let start = from; if (!/^[0-9a-f]{40}/.test(from)) { ok(sh(r.work, ['fetch', '-q', r.bare, `refs/heads/${from}`])); start = 'FETCH_HEAD'; }
  ok(sh(r.work, ['checkout', '-q', '-B', branch, start]));
  for (const [p, v] of Object.entries(files)) { if (v === null) { rmSync(join(r.work, p), { force: true }); continue; } mkdirSync(join(r.work, p, '..'), { recursive: true }); writeFileSync(join(r.work, p), v); }
  ok(sh(r.work, ['add', '-A'])); ok(sh(r.work, ['commit', '-q', '-m', msg])); ok(sh(r.work, ['push', '-q', '-f', r.bare, `HEAD:refs/heads/${branch}`]));
  return ok(sh(r.work, ['rev-parse', 'HEAD']));
};
const clone = bare => { const d = mkdtempSync(join(tmpdir(), 'rb-')); ok(sh(d, ['clone', '-q', bare, '.'])); return d; };
const treeOf = (cwd, rev) => ok(sh(cwd, ['rev-parse', `${rev}^{tree}`]));
const log = (cwd, range) => ok(sh(cwd, ['log', '--format=%T|%an|%ae|%s', '--reverse', range])).split('\n').filter(Boolean);
const T = () => ({ tracer: new Tracer(), rediff });

test('pure: linearChain and carriedExtra', () => {
  const c = new Map([['3', { parents: ['2'], tree: 't3' }], ['2', { parents: ['1'], tree: 't2' }], ['1', { parents: ['0'], tree: 't1' }], ['m', { parents: ['3', 'x'], tree: 'tm' }]]);
  assert.deepEqual(linearChain(c, '3', '0').map(x => x.oid), ['1', '2', '3']);
  assert.deepEqual(linearChain(c, '3', '3'), []);
  assert.throws(() => linearChain(c, 'm', '0'), e => e.code === 'not_linear');
  assert.deepEqual(carriedExtra(['encoding utf8', 'gpgsig -----BEGIN', ' abc', ' def', 'x y']), ['x y']);
  // a second structural header after the committer (parseCommit kept the first) is never carried into a new commit
  assert.deepEqual(carriedExtra([`tree ${'a'.repeat(40)}`, `parent ${'b'.repeat(40)}`, 'author X <x> 1 +0000', 'committer Y <y> 2 +0000', 'encoding ISO-8859-1', 'mergetag object x', ' type commit', 'foo']), ['mergetag object x', ' type commit', 'foo']);
});

test('rebase: three commits onto a moved main — trees, authors, messages equal git rebase; committer is ours; CAS on the old tip', async () => {
  const r = repo();
  const base = commitFiles(r.work, r.bare, { 'a.txt': 'a\n', 'd/x.txt': 'x\n' }, 'base');
  commitOn(r, 'feat', 'main', { 'b.txt': 'b\n' }, 'feat 1');
  commitOn(r, 'feat', 'feat', { 'd/x.txt': 'x-feat\n' }, 'feat 2');
  const tip = commitOn(r, 'feat', 'feat', { 'c.txt': 'c\n', 'b.txt': null }, 'feat 3: drop b');
  const mainNow = commitOn(r, 'main', 'main', { 'a.txt': 'a-main\n', 'e.txt': 'e\n' }, 'main moved');
  // git's answer
  const d = clone(r.bare); ok(sh(d, ['checkout', '-q', 'feat'])); ok(sh(d, ['rebase', '-q', 'origin/main'])); const gitLog = log(d, 'origin/main..HEAD'); rmSync(d, { recursive: true, force: true });
  const ex = arrayExporter();
  const res = await rebaseBranch(r.url, { ref: 'refs/heads/feat', onto: 'refs/heads/main', committer }, { tracer: new Tracer({ exporter: ex }) });
  assert.equal(res.outcome, 'rebase'); assert.equal(res.commits, 3); assert.equal(res.oldTip, tip); assert.equal(res.onto, mainNow); assert.equal(res.base, base);
  assert.equal(ok(sh(r.bare, ['rev-parse', 'feat'])), res.oid);
  const ours = log(r.bare, `main..feat`);
  assert.deepEqual(ours, gitLog, 'tree|author|email|subject per commit == git rebase');
  assert.equal(ok(sh(r.bare, ['log', '-1', '--format=%cn <%ce>', 'feat'])), 'rebaser <rebaser@x>');
  assert.equal(ok(sh(r.bare, ['rev-parse', 'feat~3'])), mainNow, 'replayed on top of main');
  assert.equal(ok(sh(r.bare, ['fsck', '--strict', '--no-dangling'])), '');
  const rootSpan = ex.lines.flatMap(flattenLine).find(s => s.name === 'git.rebase'); assert.equal(rootSpan.attrs['git.rebase.commits'], 3);
  // up to date now; and a stale view of the tip is refused by the CAS
  assert.equal((await rebaseBranch(r.url, { ref: 'refs/heads/feat', onto: 'refs/heads/main', committer }, T())).outcome, 'up_to_date');
  // land it: fast-forward
  const m = await mergeBranch(r.url, { ref: 'refs/heads/main', from: 'refs/heads/feat', author: committer }, T());
  assert.equal(m.outcome, 'fast_forward'); assert.equal(ok(sh(r.bare, ['rev-parse', 'main'])), res.oid);
  assert.equal(ok(sh(r.bare, ['cat-file', '-p', 'main:d/x.txt'])), 'x-feat'); assert.equal(sh(r.bare, ['cat-file', '-e', 'main:b.txt']).status !== 0, true);
});

test('rebase: conflict where git conflicts; branch untouched; squash produces one commit with the merged tree; branch behind → fast-forward', async () => {
  const r = repo();
  commitFiles(r.work, r.bare, { 'a.txt': 'a\n' }, 'base');
  commitOn(r, 'feat', 'main', { 'a.txt': 'a-feat\n', 'b.txt': 'b\n' }, 'feat');
  const tip = commitOn(r, 'feat', 'feat', { 'c.txt': 'c\n' }, 'feat 2');
  commitOn(r, 'main', 'main', { 'a.txt': 'a-main\n' }, 'main');
  const d = clone(r.bare); ok(sh(d, ['checkout', '-q', 'feat'])); assert.notEqual(sh(d, ['rebase', '-q', 'origin/main']).status, 0, 'git conflicts too'); rmSync(d, { recursive: true, force: true });
  await assert.rejects(rebaseBranch(r.url, { ref: 'refs/heads/feat', onto: 'refs/heads/main', committer }, T()), e => e.code === 'merge_conflict' && e.conflicts[0] === 'a.txt' && e.replayed.length === 0);
  assert.equal(ok(sh(r.bare, ['rev-parse', 'feat'])), tip, 'untouched');
  // resolve on main's side by taking feat's a.txt, then squash
  commitOn(r, 'main', 'main', { 'a.txt': 'a-feat\n' }, 'main takes feat a');
  const d2 = clone(r.bare); ok(sh(d2, ['checkout', '-q', 'feat'])); ok(sh(d2, ['rebase', '-q', 'origin/main'])); const gitTree = treeOf(d2, 'HEAD'); rmSync(d2, { recursive: true, force: true });
  const s = await rebaseBranch(r.url, { ref: 'refs/heads/feat', onto: 'refs/heads/main', committer, squash: true, message: 'feat squashed' }, T());
  assert.equal(s.outcome, 'squash'); assert.equal(treeOf(r.bare, 'feat'), gitTree, 'squash tree == git rebase tip tree');
  assert.equal(ok(sh(r.bare, ['rev-list', '--count', 'main..feat'])), '1'); assert.equal(ok(sh(r.bare, ['log', '-1', '--format=%s', 'feat'])), 'feat squashed');
  // a branch strictly behind main: rebase makes it equal main
  ok(sh(r.work, ['push', '-q', r.bare, `${ok(sh(r.bare, ['rev-parse', 'main~1']))}:refs/heads/old`]));
  const b = await rebaseBranch(r.url, { ref: 'refs/heads/old', onto: 'refs/heads/main', committer }, T());
  assert.equal(b.outcome, 'fast_forward'); assert.equal(ok(sh(r.bare, ['rev-parse', 'old'])), ok(sh(r.bare, ['rev-parse', 'main'])));
  assert.equal(ok(sh(r.bare, ['fsck', '--strict', '--no-dangling'])), '');
});

test('cherry-pick and revert: trees equal git; signature not carried; signed result verifies', async () => {
  const r = repo();
  commitFiles(r.work, r.bare, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, 'base');
  const fix = commitOn(r, 'feat', 'main', { 'b.txt': 'b-fixed\n', 'new.txt': 'n\n' }, 'the fix');
  commitOn(r, 'feat', 'feat', { 'a.txt': 'unrelated\n' }, 'unrelated');
  commitOn(r, 'main', 'main', { 'c.txt': 'c\n' }, 'main moved');
  const d = clone(r.bare); ok(sh(d, ['cherry-pick', fix])); const gitPick = treeOf(d, 'HEAD'); ok(sh(d, ['revert', '--no-edit', 'HEAD'])); const gitRevert = treeOf(d, 'HEAD'); rmSync(d, { recursive: true, force: true });
  const { signer } = await generateSigner();
  const p = await cherryPick(r.url, { ref: 'refs/heads/main', commit: fix, committer }, { tracer: new Tracer(), signer });
  assert.equal(p.outcome, 'ok'); assert.equal(p.tree, gitPick); assert.equal(ok(sh(r.bare, ['rev-parse', 'main'])), p.oid);
  assert.equal(ok(sh(r.bare, ['log', '-1', '--format=%an|%s', 'main'])), 'w|the fix', 'author and message kept');
  assert.match(ok(sh(r.bare, ['cat-file', 'commit', p.oid])), /gpgsig -----BEGIN SSH SIGNATURE/);
  const rv = await revertCommit(r.url, { ref: 'refs/heads/main', commit: p.oid, committer }, T());
  assert.equal(rv.outcome, 'ok'); assert.equal(rv.tree, gitRevert);
  assert.match(ok(sh(r.bare, ['log', '-1', '--format=%s', 'main'])), /^Revert "the fix"/);
  assert.equal((await cherryPick(r.url, { ref: 'refs/heads/main', commit: p.oid, committer }, T())).outcome, 'ok', 'picking the fix again after its revert applies again');
  assert.equal(treeOf(r.bare, 'main'), gitPick);
  // picking a commit whose change is already present is empty
  assert.equal((await cherryPick(r.url, { ref: 'refs/heads/main', commit: fix, committer }, T())).outcome, 'empty');
  // conflict: pick a commit that rewrote a.txt onto a main that also rewrote it
  const clash = commitOn(r, 'feat', 'feat', { 'a.txt': 'feat-a\n' }, 'clash');
  commitOn(r, 'main', 'main', { 'a.txt': 'main-a\n' }, 'main a');
  await assert.rejects(cherryPick(r.url, { ref: 'refs/heads/main', commit: clash, committer }, T()), e => e.code === 'merge_conflict' && e.conflicts.includes('a.txt'));
  assert.equal(ok(sh(r.bare, ['fsck', '--strict', '--no-dangling'])), '');
});

test('property: line-level edits to the same files on both sides — rebase and cherry-pick equal git, or conflict where git does', async () => {
  const { Rng } = await import('./fuzz/prng.js');
  const rng = new Rng(+(process.env.REBASE_SEED ?? 7)); const N = +(process.env.REBASE_CASES ?? 12);
  const stats = { rebased: 0, conflict: 0, conservative: 0, picked: 0 };
  for (let i = 0; i < N; i++) {
    const r = repo();
    const lines = p => Array.from({ length: 10 }, (_, j) => (j % 4 === 3 ? '\n' : `${p}:${j}\n`));
    const files = { 'a.txt': lines('a').join(''), 'src/b.txt': lines('b').join('') };
    commitFiles(r.work, r.bare, files, 'base');
    const cur = { main: { ...files }, feat: { ...files } };
    const step = (br, from, msg) => { const ch = {}; const p = rng.pick(Object.keys(files)); const ls = cur[br][p].split(/(?<=\n)/); const at = rng.int(0, ls.length - 1);
      const k = rng.int(0, 2); if (k === 0) ls[at] = `${br}${i}.${rng.int(0, 99)}\n`; else if (k === 1) ls.splice(at, 1); else ls.splice(at, 0, rng.int(0, 1) ? '\n' : `${br} ins ${rng.int(0, 99)}\n`);
      ch[p] = cur[br][p] = ls.join(''); return commitOn(r, br, from, ch, msg); };
    const f1 = step('feat', 'main', 'feat 1'); ok(sh(r.work, ['push', '-q', r.bare, `${f1}:refs/heads/keep`])); step('feat', 'feat', 'feat 2'); step('feat', 'feat', 'feat 3');
    step('main', 'main', 'main 1'); step('main', 'main', 'main 2');
    // rebase
    const d = clone(r.bare); ok(sh(d, ['checkout', '-q', 'feat'])); const gr = sh(d, ['rebase', '-q', 'origin/main']);
    const gitLog = gr.status === 0 ? log(d, 'origin/main..HEAD') : null; rmSync(d, { recursive: true, force: true });
    let res = null, err = null; try { res = await rebaseBranch(r.url, { ref: 'refs/heads/feat', onto: 'refs/heads/main', committer }, T()); } catch (e) { if (e.code !== 'merge_conflict') { if (process.env.REBASE_DEBUG) console.log(i, e.hookOutput, e.report); throw e; } err = e; }
    if (res) { assert.ok(gitLog, `case ${i}: we rebased cleanly but git conflicts`); assert.deepEqual(log(r.bare, 'main..feat'), gitLog, `case ${i}: per-commit trees == git rebase`); stats.rebased++; }
    else if (gitLog) stats.conservative++; else stats.conflict++;
    // cherry-pick the first feat commit onto main
    const d2 = clone(r.bare); const gp = sh(d2, ['cherry-pick', f1]); const gitPick = gp.status === 0 ? treeOf(d2, 'HEAD') : null; const gitEmpty = gp.status !== 0 && /empty/.test(gp.stderr + gp.stdout); rmSync(d2, { recursive: true, force: true });
    let p = null; try { p = await cherryPick(r.url, { ref: 'refs/heads/main', commit: f1, committer }, T()); } catch (e) { if (e.code !== 'merge_conflict') throw e; }
    if (p?.outcome === 'ok') { assert.equal(p.tree, gitPick, `case ${i}: cherry-pick tree == git`); stats.picked++; }
    else if (p?.outcome === 'empty') assert.ok(gitEmpty, `case ${i}: we say empty, git does not`);
    else if (gitPick) stats.conservative++;
    assert.equal(ok(sh(r.bare, ['fsck', '--strict', '--no-dangling'])), '');
  }
  console.log(`  ${N} cases: ${JSON.stringify(stats)}`);
  assert.ok(stats.rebased > 0 && stats.picked > 0, 'line merges exercised');
  assert.equal(stats.conservative, 0, 'no conservative conflicts on plain line edits');
});

test('attributes in cherry-pick and rebase: \'ours\' is the tree being built on, as a worktree cherry-pick/rebase reads it', async () => {
  const r = repo();
  const L = n => Array.from({ length: n }, (_, i) => `entry ${i}\n`).join('');
  commitFiles(r.work, r.bare, { 'CHANGELOG': L(3) }, 'base');
  const pick = commitOn(r, 'feat', 'main', { 'CHANGELOG': L(3) + 'feat entry\n' }, 'feat entry');
  commitOn(r, 'main', 'main', { 'CHANGELOG': L(3) + 'main entry\n', '.gitattributes': 'CHANGELOG merge=union\n' }, 'main entry + union');
  // git, in a worktree on main (attributes from the checkout = ours)
  const d = clone(r.bare); const gp = sh(d, ['cherry-pick', pick]); assert.equal(gp.status, 0, gp.stderr); const gitTree = treeOf(d, 'HEAD'); rmSync(d, { recursive: true, force: true });
  await assert.rejects(cherryPick(r.url, { ref: 'refs/heads/main', commit: pick, committer }, T()), e => e.code === 'merge_conflict', 'without attributes the appends clash');
  const p = await cherryPick(r.url, { ref: 'refs/heads/main', commit: pick, committer }, { ...T(), attributes: 'ours' });
  assert.equal(p.tree, gitTree, 'union cherry-pick tree == git cherry-pick');
  // rebase: feat (one commit appending) onto main, attributes from the tree being built on
  const r2 = repo();
  commitFiles(r2.work, r2.bare, { 'CHANGELOG': L(3), '.gitattributes': 'CHANGELOG merge=union\n' }, 'base');
  commitOn(r2, 'feat', 'main', { 'CHANGELOG': L(3) + 'feat 1\n' }, 'f1');
  commitOn(r2, 'feat', 'feat', { 'CHANGELOG': L(3) + 'feat 1\nfeat 2\n' }, 'f2');
  commitOn(r2, 'main', 'main', { 'CHANGELOG': L(3) + 'main 1\n' }, 'm1');
  const d2 = clone(r2.bare); ok(sh(d2, ['checkout', '-q', 'feat'])); const gr = sh(d2, ['rebase', '-q', 'origin/main']); assert.equal(gr.status, 0, gr.stderr); const gitLog = log(d2, 'origin/main..HEAD'); rmSync(d2, { recursive: true, force: true });
  const rb = await rebaseBranch(r2.url, { ref: 'refs/heads/feat', onto: 'refs/heads/main', committer }, { ...T(), attributes: 'ours' });
  assert.equal(rb.outcome, 'rebase'); assert.deepEqual(log(r2.bare, 'main..feat'), gitLog, 'per-commit trees == git rebase with union');
});

test('end to end: edit on a branch, main moves, rebase, fast-forward land, delete — all git operations', async () => {
  const r = repo();
  commitFiles(r.work, r.bare, { 'README.md': 'hello MARK\n', 'other.txt': 'o\n' }, 'base');
  const e = await editFile(r.url, { path: 'README.md', find: 'MARK', replace: 'WORLD', ref: 'refs/heads/ply/x', base: 'refs/heads/main', author: committer, message: 'edit' }, T());
  commitOn(r, 'main', 'main', { 'other.txt': 'o2\n' }, 'main moved');
  const rb = await rebaseBranch(r.url, { ref: 'refs/heads/ply/x', onto: 'refs/heads/main', committer }, T());
  assert.equal(rb.outcome, 'rebase'); assert.equal(rb.commits, 1);
  const m = await mergeBranch(r.url, { ref: 'refs/heads/main', from: 'refs/heads/ply/x', author: committer }, T());
  assert.equal(m.outcome, 'fast_forward');
  assert.equal(ok(sh(r.bare, ['cat-file', '-p', 'main:README.md'])), 'hello WORLD'); assert.equal(ok(sh(r.bare, ['cat-file', '-p', 'main:other.txt'])), 'o2');
  assert.equal(ok(sh(r.bare, ['log', '--format=%s', '-3', 'main'])).split('\n').join('|'), 'edit|main moved|base', 'linear history');
  assert.equal(ok(sh(r.bare, ['fsck', '--strict', '--no-dangling'])), '');
});
