// Rebase / squash / cherry-pick / revert, decided by git: per-commit trees equal `git rebase` in a clone, authors and
// messages preserved, committer ours; cherry-pick and revert trees equal `git cherry-pick` / `git revert`; conflicts where
// git conflicts; the branch update is a CAS on the old tip.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { git, tmpRoot, makeBareRepo, startGitServer, commitFiles, fsckProblems } from './server.js';
import { rebaseBranch, cherryPick, revertCommit, linearChain, carriedExtra, squashMessage } from '../src/rebase.js';
import { mergeBranch } from '../src/merge.js';
import { editFile } from '../src/edit.js';
import { generateSigner } from '../src/sign.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { oracleRediff } from './gitversion.js';
import { unwrap, unwrapAsync } from './unwrap.js';
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
  assert.deepEqual(unwrap(linearChain(c, '3', '0')).map(x => x.oid), ['1', '2', '3']);
  assert.deepEqual(unwrap(linearChain(c, '3', '3')), []);
  assert.throws(() => unwrap(linearChain(c, 'm', '0')), e => e.code === 'not_linear');
  assert.deepEqual(carriedExtra(['encoding utf8', 'gpgsig -----BEGIN', ' abc', ' def', 'x y']), ['encoding utf8', 'x y']);
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
  const res = await unwrapAsync(rebaseBranch(r.url, { ref: 'refs/heads/feat', onto: 'refs/heads/main', committer }, { tracer: new Tracer({ exporter: ex }) }));
  assert.equal(res.outcome, 'rebase'); assert.equal(res.commits, 3); assert.equal(res.oldTip, tip); assert.equal(res.onto, mainNow); assert.equal(res.base, base);
  assert.equal(ok(sh(r.bare, ['rev-parse', 'feat'])), res.oid);
  const ours = log(r.bare, `main..feat`);
  assert.deepEqual(ours, gitLog, 'tree|author|email|subject per commit == git rebase');
  assert.equal(ok(sh(r.bare, ['log', '-1', '--format=%cn <%ce>', 'feat'])), 'rebaser <rebaser@x>');
  assert.equal(ok(sh(r.bare, ['rev-parse', 'feat~3'])), mainNow, 'replayed on top of main');
  assert.deepEqual(fsckProblems(r.bare), []);
  const rootSpan = ex.lines.flatMap(flattenLine).find(s => s.name === 'git.rebase'); assert.equal(rootSpan.attrs['git.rebase.commits'], 3);
  // up to date now; and a stale view of the tip is refused by the CAS
  assert.equal((await unwrapAsync(rebaseBranch(r.url, { ref: 'refs/heads/feat', onto: 'refs/heads/main', committer }, T()))).outcome, 'up_to_date');
  // land it: fast-forward
  const m = await unwrapAsync(mergeBranch(r.url, { ref: 'refs/heads/main', from: 'refs/heads/feat', author: committer }, T()));
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
  await assert.rejects(unwrapAsync(rebaseBranch(r.url, { ref: 'refs/heads/feat', onto: 'refs/heads/main', committer }, T())), e => e.code === 'merge_conflict' && e.conflicts[0] === 'a.txt' && e.replayed.length === 0);
  assert.equal(ok(sh(r.bare, ['rev-parse', 'feat'])), tip, 'untouched');
  // resolve on main's side by taking feat's a.txt, then squash
  commitOn(r, 'main', 'main', { 'a.txt': 'a-feat\n' }, 'main takes feat a');
  const d2 = clone(r.bare); ok(sh(d2, ['checkout', '-q', 'feat'])); ok(sh(d2, ['rebase', '-q', 'origin/main'])); const gitTree = treeOf(d2, 'HEAD'); rmSync(d2, { recursive: true, force: true });
  const s = await unwrapAsync(rebaseBranch(r.url, { ref: 'refs/heads/feat', onto: 'refs/heads/main', committer, squash: true, message: 'feat squashed' }, T()));
  assert.equal(s.outcome, 'squash'); assert.equal(treeOf(r.bare, 'feat'), gitTree, 'squash tree == git rebase tip tree');
  assert.equal(ok(sh(r.bare, ['rev-list', '--count', 'main..feat'])), '1'); assert.equal(ok(sh(r.bare, ['log', '-1', '--format=%s', 'feat'])), 'feat squashed');
  // a branch strictly behind main: rebase makes it equal main
  ok(sh(r.work, ['push', '-q', r.bare, `${ok(sh(r.bare, ['rev-parse', 'main~1']))}:refs/heads/old`]));
  const b = await unwrapAsync(rebaseBranch(r.url, { ref: 'refs/heads/old', onto: 'refs/heads/main', committer }, T()));
  assert.equal(b.outcome, 'fast_forward'); assert.equal(ok(sh(r.bare, ['rev-parse', 'old'])), ok(sh(r.bare, ['rev-parse', 'main'])));
  assert.deepEqual(fsckProblems(r.bare), []);
});

test('rebase and squash when the merge base sits exactly at the first window\'s cut (8 commits above both tips): equal to git, not a TypeError', async () => {
  // mergeBase names the root through its children on both sides without ever fetching it (depth 8 holds the 8 commits
  // above it); rebase read commits.get(base).tree → "Cannot read properties of undefined" on an honest server (#41).
  // 7 a side: the base is inside the window (the control); 8: it is exactly at the cut.
  for (const n of [7, 8]) for (const squash of [false, true]) {
    const r = repo();
    const base = commitFiles(r.work, r.bare, { 'f.txt': 'root\n' }, 'root');
    let tip = base, main = base;
    for (let i = 1; i <= n; i++) { tip = commitOn(r, 'feat', tip, { [`t${i}.txt`]: `${i}\n` }, `feat ${i}`); main = commitOn(r, 'main', main, { [`m${i}.txt`]: `${i}\n` }, `main ${i}`); }
    const d = clone(r.bare); ok(sh(d, ['checkout', '-q', 'feat'])); ok(sh(d, ['rebase', '-q', 'origin/main'])); const gitTree = treeOf(d, 'HEAD'); const gitLog = log(d, 'origin/main..HEAD'); rmSync(d, { recursive: true, force: true });
    const res = await unwrapAsync(rebaseBranch(r.url, { ref: 'refs/heads/feat', onto: 'refs/heads/main', committer, squash }, T()));
    assert.equal(res.outcome, squash ? 'squash' : 'rebase', `n=${n}`); assert.equal(res.base, base); assert.equal(res.commits, n);
    assert.equal(ok(sh(r.bare, ['rev-parse', 'feat'])), res.oid);
    assert.equal(treeOf(r.bare, 'feat'), gitTree, `${squash ? 'squash' : 'rebase'}: tip tree == git rebase`);
    if (!squash) assert.deepEqual(log(r.bare, 'main..feat').map(l => l.split('|')[0]), gitLog.map(l => l.split('|')[0]), 'every replayed tree == git');
    assert.deepEqual(fsckProblems(r.bare), []);
  }
});

test('cherry-pick and revert: trees equal git; signature not carried; signed result verifies', async () => {
  const r = repo();
  commitFiles(r.work, r.bare, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, 'base');
  const fix = commitOn(r, 'feat', 'main', { 'b.txt': 'b-fixed\n', 'new.txt': 'n\n' }, 'the fix');
  commitOn(r, 'feat', 'feat', { 'a.txt': 'unrelated\n' }, 'unrelated');
  commitOn(r, 'main', 'main', { 'c.txt': 'c\n' }, 'main moved');
  const d = clone(r.bare); ok(sh(d, ['cherry-pick', fix])); const gitPick = treeOf(d, 'HEAD'); ok(sh(d, ['revert', '--no-edit', 'HEAD'])); const gitRevert = treeOf(d, 'HEAD'); rmSync(d, { recursive: true, force: true });
  const { signer } = await generateSigner();
  const p = await unwrapAsync(cherryPick(r.url, { ref: 'refs/heads/main', commit: fix, committer }, { tracer: new Tracer(), signer }));
  assert.equal(p.outcome, 'ok'); assert.equal(p.tree, gitPick); assert.equal(ok(sh(r.bare, ['rev-parse', 'main'])), p.oid);
  assert.equal(ok(sh(r.bare, ['log', '-1', '--format=%an|%s', 'main'])), 'w|the fix', 'author and message kept');
  assert.match(ok(sh(r.bare, ['cat-file', 'commit', p.oid])), /gpgsig -----BEGIN SSH SIGNATURE/);
  const rv = await unwrapAsync(revertCommit(r.url, { ref: 'refs/heads/main', commit: p.oid, committer }, T()));
  assert.equal(rv.outcome, 'ok'); assert.equal(rv.tree, gitRevert);
  assert.match(ok(sh(r.bare, ['log', '-1', '--format=%s', 'main'])), /^Revert "the fix"/);
  assert.equal((await unwrapAsync(cherryPick(r.url, { ref: 'refs/heads/main', commit: p.oid, committer }, T()))).outcome, 'ok', 'picking the fix again after its revert applies again');
  assert.equal(treeOf(r.bare, 'main'), gitPick);
  // picking a commit whose change is already present is empty
  assert.equal((await unwrapAsync(cherryPick(r.url, { ref: 'refs/heads/main', commit: fix, committer }, T()))).outcome, 'empty');
  // conflict: pick a commit that rewrote a.txt onto a main that also rewrote it
  const clash = commitOn(r, 'feat', 'feat', { 'a.txt': 'feat-a\n' }, 'clash');
  commitOn(r, 'main', 'main', { 'a.txt': 'main-a\n' }, 'main a');
  await assert.rejects(unwrapAsync(cherryPick(r.url, { ref: 'refs/heads/main', commit: clash, committer }, T())), e => e.code === 'merge_conflict' && e.conflicts.includes('a.txt'));
  assert.deepEqual(fsckProblems(r.bare), []);
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
    let res = null, err = null; try { res = await unwrapAsync(rebaseBranch(r.url, { ref: 'refs/heads/feat', onto: 'refs/heads/main', committer }, T())); } catch (e) { if (e.code !== 'merge_conflict') { if (process.env.REBASE_DEBUG) console.log(i, e.hookOutput, e.report); throw e; } err = e; }
    if (res) { assert.ok(gitLog, `case ${i}: we rebased cleanly but git conflicts`); assert.deepEqual(log(r.bare, 'main..feat'), gitLog, `case ${i}: per-commit trees == git rebase`); stats.rebased++; }
    else if (gitLog) stats.conservative++; else stats.conflict++;
    // cherry-pick the first feat commit onto main
    const d2 = clone(r.bare); const gp = sh(d2, ['cherry-pick', f1]); const gitPick = gp.status === 0 ? treeOf(d2, 'HEAD') : null; const gitEmpty = gp.status !== 0 && /empty/.test(gp.stderr + gp.stdout); rmSync(d2, { recursive: true, force: true });
    let p = null; try { p = await unwrapAsync(cherryPick(r.url, { ref: 'refs/heads/main', commit: f1, committer }, T())); } catch (e) { if (e.code !== 'merge_conflict') throw e; }
    if (p?.outcome === 'ok') { assert.equal(p.tree, gitPick, `case ${i}: cherry-pick tree == git`); stats.picked++; }
    else if (p?.outcome === 'empty') assert.ok(gitEmpty, `case ${i}: we say empty, git does not`);
    else if (gitPick) stats.conservative++;
    assert.deepEqual(fsckProblems(r.bare), []);
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
  await assert.rejects(unwrapAsync(cherryPick(r.url, { ref: 'refs/heads/main', commit: pick, committer }, T())), e => e.code === 'merge_conflict', 'without attributes the appends clash');
  const p = await unwrapAsync(cherryPick(r.url, { ref: 'refs/heads/main', commit: pick, committer }, { ...T(), attributes: 'ours' }));
  assert.equal(p.tree, gitTree, 'union cherry-pick tree == git cherry-pick');
  // rebase: feat (one commit appending) onto main, attributes from the tree being built on
  const r2 = repo();
  commitFiles(r2.work, r2.bare, { 'CHANGELOG': L(3), '.gitattributes': 'CHANGELOG merge=union\n' }, 'base');
  commitOn(r2, 'feat', 'main', { 'CHANGELOG': L(3) + 'feat 1\n' }, 'f1');
  commitOn(r2, 'feat', 'feat', { 'CHANGELOG': L(3) + 'feat 1\nfeat 2\n' }, 'f2');
  commitOn(r2, 'main', 'main', { 'CHANGELOG': L(3) + 'main 1\n' }, 'm1');
  const d2 = clone(r2.bare); ok(sh(d2, ['checkout', '-q', 'feat'])); const gr = sh(d2, ['rebase', '-q', 'origin/main']); assert.equal(gr.status, 0, gr.stderr); const gitLog = log(d2, 'origin/main..HEAD'); rmSync(d2, { recursive: true, force: true });
  const rb = await unwrapAsync(rebaseBranch(r2.url, { ref: 'refs/heads/feat', onto: 'refs/heads/main', committer }, { ...T(), attributes: 'ours' }));
  assert.equal(rb.outcome, 'rebase'); assert.deepEqual(log(r2.bare, 'main..feat'), gitLog, 'per-commit trees == git rebase with union');
});

test('end to end: edit on a branch, main moves, rebase, fast-forward land, delete — all git operations', async () => {
  const r = repo();
  commitFiles(r.work, r.bare, { 'README.md': 'hello MARK\n', 'other.txt': 'o\n' }, 'base');
  const e = await unwrapAsync(editFile(r.url, { path: 'README.md', find: 'MARK', replace: 'WORLD', ref: 'refs/heads/ply/x', base: 'refs/heads/main', author: committer, message: 'edit' }, T()));
  commitOn(r, 'main', 'main', { 'other.txt': 'o2\n' }, 'main moved');
  const rb = await unwrapAsync(rebaseBranch(r.url, { ref: 'refs/heads/ply/x', onto: 'refs/heads/main', committer }, T()));
  assert.equal(rb.outcome, 'rebase'); assert.equal(rb.commits, 1);
  const m = await unwrapAsync(mergeBranch(r.url, { ref: 'refs/heads/main', from: 'refs/heads/ply/x', author: committer }, T()));
  assert.equal(m.outcome, 'fast_forward');
  assert.equal(ok(sh(r.bare, ['cat-file', '-p', 'main:README.md'])), 'hello WORLD'); assert.equal(ok(sh(r.bare, ['cat-file', '-p', 'main:other.txt'])), 'o2');
  assert.equal(ok(sh(r.bare, ['log', '--format=%s', '-3', 'main'])).split('\n').join('|'), 'edit|main moved|base', 'linear history');
  assert.deepEqual(fsckProblems(r.bare), []);
});

// The default squash message is built from commit messages, which whoever can push to the branch writes.
test('squash message: exact values worked by hand; interior blank lines are the commit\'s own and stay', () => {
  // each message loses only its trailing newlines; null and all-newline messages contribute nothing; one blank line
  // between the rest; one final newline
  assert.equal(squashMessage(['a\n', 'b\n\n\n', null, '\n\n', '', 'c']), 'a\n\nb\n\nc\n');
  assert.equal(squashMessage(['subject\n\nbody 1\n\n\n\nbody 2\n']), 'subject\n\nbody 1\n\n\n\nbody 2\n');
  assert.equal(squashMessage(['\n\nlead\n', ' \n']), '\n\nlead\n\n \n');
  assert.equal(squashMessage([]), '\n'); assert.equal(squashMessage([null, '\n']), '\n');
  assert.equal(squashMessage(['x\r\n']), 'x\r\n', 'only LF is stripped: CR LF keeps its CR, then one LF is added');
});

test('squash message: time is linear in the message (64x the newlines costs under 300x the time, best of 5)', () => {
  // 'feat' + N newlines + 'tail' + N newlines: the interior run is where `\n+$` went quadratic (the engine retries the
  // run from every newline in it), the trailing run is the work a linear strip does. A quadratic step costs 4096x.
  const msg = n => `feat${'\n'.repeat(n)}tail${'\n'.repeat(n)}`;
  // by hand: each of the two copies keeps 'feat' + n newlines + 'tail' (n + 8 chars), '\n\n' between, '\n' after
  const best = (n) => { const m = msg(n); let b = Infinity; for (let i = 0; i < 5; i++) { const t0 = performance.now(); const out = squashMessage([m, m]); b = Math.min(b, performance.now() - t0); assert.equal(out.length, 2 * (n + 8) + 3); } return b; };
  for (let i = 0; i < 50; i++) squashMessage([msg(200), msg(200)]); // warm the JIT on a size neither measurement uses
  const ts = best(500); const tb = best(32_000);
  assert.ok(tb < 300 * ts, `64x the input cost ${(tb / ts).toFixed(0)}x the time (${ts.toFixed(4)} ms -> ${tb.toFixed(4)} ms)`);
});

test('limits: maxRebaseCommits governs a rebase above maxMergeDepth too: a chain of exactly the limit rebases as git does, one more is refused as the rebase chain', async () => {
  const { DEFAULT_LIMITS } = await import('../src/limits.js');
  const r = repo();
  commitFiles(r.work, r.bare, { 'a.txt': 'a\n' }, 'base');
  for (let i = 1; i <= 13; i++) commitOn(r, 'feat', i === 1 ? 'main' : 'feat', { [`f${i}.txt`]: `${i}\n` }, `feat ${i}`);
  ok(sh(r.work, ['push', '-q', r.bare, 'HEAD~1:refs/heads/feat12'])); // the same branch without its last commit: 12 above the base
  const tip13 = ok(sh(r.bare, ['rev-parse', 'feat']));
  commitOn(r, 'main', 'main', { 'e.txt': 'e\n' }, 'main moved');
  // git's answer: it rebases both; 12 and 13 are the counts of commits made above
  const d = clone(r.bare);
  ok(sh(d, ['checkout', '-q', 'feat'])); ok(sh(d, ['rebase', '-q', 'origin/main'])); assert.equal(ok(sh(d, ['rev-list', '--count', 'origin/main..HEAD'])), '13');
  ok(sh(d, ['checkout', '-q', 'feat12'])); ok(sh(d, ['rebase', '-q', 'origin/main'])); const gitLog = log(d, 'origin/main..HEAD'); rmSync(d, { recursive: true, force: true });
  assert.equal(gitLog.length, 12);
  const refused = (ref, limits, what, got, max) => assert.rejects(unwrapAsync(rebaseBranch(r.url, { ref, onto: 'refs/heads/main', committer }, { ...T(), limits: { ...DEFAULT_LIMITS, ...limits } })), e => { assert.deepEqual({ code: e.code, what: e.what, got: e.got, max: e.max }, { code: 'limit_exceeded', what, got, max }); return true; });
  // the rebase limit below, at and above the merge depth: each time it is the bound that fires, one commit over
  await refused('refs/heads/feat', { maxMergeDepth: 64, maxRebaseCommits: 12 }, 'rebase chain', 13, 12);
  await refused('refs/heads/feat', { maxMergeDepth: 12, maxRebaseCommits: 12 }, 'rebase chain', 13, 12);
  await refused('refs/heads/feat', { maxMergeDepth: 4, maxRebaseCommits: 12 }, 'rebase chain', 13, 12);
  assert.equal(ok(sh(r.bare, ['rev-parse', 'feat'])), tip13, 'a refused rebase leaves the branch');
  const res = await unwrapAsync(rebaseBranch(r.url, { ref: 'refs/heads/feat12', onto: 'refs/heads/main', committer }, { ...T(), limits: { ...DEFAULT_LIMITS, maxMergeDepth: 4, maxRebaseCommits: 12 } }));
  assert.equal(res.outcome, 'rebase'); assert.equal(res.commits, 12);
  assert.deepEqual(log(r.bare, 'main..feat12'), gitLog, 'tree, author and subject of every replayed commit == git rebase');
  assert.deepEqual(fsckProblems(r.bare), []);
});

// git rebase leaves out a commit whose patch id equals an upstream commit's before it replays anything (its default,
// --no-reapply-cherry-picks). ply has no patch ids: it replays every commit and drops the ones that come out empty.
// The two agree while the upstream copy is in place and differ once upstream has reverted it; this pins both, each
// against the git command it equals, so the day patch ids are ported the second half changes knowingly.
test('rebase of a commit whose patch is already upstream: dropped as git rebase drops it while the copy stands; after an upstream revert ply is git rebase --reapply-cherry-picks', async () => {
  const r = repo();
  commitFiles(r.work, r.bare, { f: 'base\n' }, 'base');
  const t1 = commitOn(r, 'topic', 'main', { f: 'base\nfeature\n' }, 'T1');
  ok(sh(r.work, ['push', '-q', r.bare, `${t1}:refs/heads/topic2`]));
  commitOn(r, 'main', 'main', { g: 'g\n' }, 'unrelated');
  ok(sh(r.work, ['cherry-pick', t1])); ok(sh(r.work, ['push', '-q', r.bare, 'HEAD:refs/heads/main']));
  assert.notEqual(ok(sh(r.work, ['rev-parse', 'HEAD'])), t1, 'the upstream copy is another commit, so the branch is not simply behind');
  const gitRebase = (branch, flags) => { const d = clone(r.bare); ok(sh(d, ['checkout', '-q', branch])); ok(sh(d, ['rebase', '-q', ...flags, 'origin/main'])); const out = { tree: treeOf(d, 'HEAD'), commits: log(d, 'origin/main..HEAD') }; rmSync(d, { recursive: true, force: true }); return out; };
  // the copy stands: git rewrites nothing and the branch is main
  const g1 = gitRebase('topic', []); assert.deepEqual(g1.commits, []);
  const p1 = await unwrapAsync(rebaseBranch(r.url, { ref: 'refs/heads/topic', onto: 'refs/heads/main', committer }, T()));
  assert.equal(p1.outcome, 'rebase'); assert.deepEqual(p1.dropped, [t1]); assert.deepEqual(p1.replayed, []);
  assert.equal(treeOf(r.bare, 'topic'), g1.tree); assert.deepEqual(log(r.bare, 'main..topic'), g1.commits); assert.equal(p1.oid, ok(sh(r.bare, ['rev-parse', 'main'])));
  // upstream reverts the copy and moves on
  ok(sh(r.work, ['revert', '--no-edit', 'HEAD'])); ok(sh(r.work, ['push', '-q', r.bare, 'HEAD:refs/heads/main'])); commitOn(r, 'main', 'main', { h: 'h\n' }, 'later');
  const gDefault = gitRebase('topic2', []); const gReapply = gitRebase('topic2', ['--reapply-cherry-picks']);
  assert.deepEqual(gDefault.commits, [], 'git by default: T1 is left out (its patch id is upstream)'); assert.equal(gReapply.commits.length, 1);
  const p2 = await unwrapAsync(rebaseBranch(r.url, { ref: 'refs/heads/topic2', onto: 'refs/heads/main', committer }, T()));
  assert.deepEqual(p2.dropped, []); assert.deepEqual(p2.replayed.map(x => x.from), [t1]);
  assert.equal(treeOf(r.bare, 'topic2'), gReapply.tree); assert.deepEqual(log(r.bare, 'main..topic2'), gReapply.commits);
  assert.notEqual(gReapply.tree, gDefault.tree, 'the known difference from git\'s default (README: rebase)');
  assert.deepEqual(fsckProblems(r.bare), []);
});

test('squash message equals the one git rebase -i (pick, squash, squash) writes, byte for byte', async () => {
  const r = repo();
  commitFiles(r.work, r.bare, { 'a.txt': 'a\n' }, 'base');
  commitOn(r, 'feat', 'main', { 'b.txt': 'b\n' }, 'feat 1: subject only');
  commitOn(r, 'feat', 'feat', { 'c.txt': 'c\n' }, 'feat 2: with a body\n\nfirst paragraph\nsecond line\n\nsecond paragraph');
  commitOn(r, 'feat', 'feat', { 'd.txt': 'd\n' }, 'feat 3');
  commitOn(r, 'main', 'main', { 'e.txt': 'e\n' }, 'main moved');
  // git's answer: squash every commit after the first into it; the editor accepts the prepared message as it is
  const d = clone(r.bare); ok(sh(d, ['checkout', '-q', 'feat']));
  const rb = spawnSync('git', ['-C', d, 'rebase', '-q', '-i', 'origin/main'], { encoding: 'utf8', env: { ...ENV, GIT_SEQUENCE_EDITOR: 'sed -i.bak -e "2,\\$s/^pick/squash/"', GIT_EDITOR: 'true' } });
  assert.equal(rb.status, 0, rb.stderr); assert.equal(ok(sh(d, ['rev-list', '--count', 'origin/main..HEAD'])), '1');
  const body = (cwd, rev) => { const raw = sh(cwd, ['cat-file', 'commit', rev]); assert.equal(raw.status, 0, raw.stderr); return raw.stdout.slice(raw.stdout.indexOf('\n\n') + 2); };
  const gitMessage = body(d, 'HEAD'); const gitTree = treeOf(d, 'HEAD'); rmSync(d, { recursive: true, force: true });
  assert.equal(gitMessage, 'feat 1: subject only\n\nfeat 2: with a body\n\nfirst paragraph\nsecond line\n\nsecond paragraph\n\nfeat 3\n', 'what git writes (pinned so a git that words it otherwise is noticed)');
  const s = await unwrapAsync(rebaseBranch(r.url, { ref: 'refs/heads/feat', onto: 'refs/heads/main', committer, squash: true }, T()));
  assert.equal(s.outcome, 'squash'); assert.equal(body(r.bare, 'feat'), gitMessage); assert.equal(treeOf(r.bare, 'feat'), gitTree);
});

// A linear branch of `n` commits above a one-commit base, and main moved one commit, by fast-import (commitOn costs
// four git processes a commit). Each branch commit rewrites one file in a directory, so a replay reads the commit's
// root tree and that directory's tree.
const longBranch = (r, n) => {
  const L = []; let at = 1_700_000_000;
  const commit = (ref, mark, msg, from, path, body) => [`commit ${ref}`, `mark :${mark}`, `committer s <s@x> ${at++} +0000`, `data ${msg.length}`, msg, ...(from ? [`from :${from}`] : []), `M 100644 inline ${path}`, `data ${body.length}`, body];
  L.push(...commit('refs/heads/main', 1, 'base', 0, 'a.txt', 'a'));
  for (let i = 2; i <= n + 1; i++) L.push(...commit('refs/heads/feat', i, `f${i}`, i - 1, 'd/f.txt', `${i}`));
  L.push(...commit('refs/heads/main', n + 2, 'moved', 1, 'e.txt', 'e'));
  ok(sh(r.bare, ['fast-import', '--quiet'], `${L.join('\n')}\n`));
};
// the transport's requests, counted where they leave: every HTTP request of the operation
const counting = () => { const c = { n: 0, fetchImpl: (u, i) => { c.n++; return fetch(u, i); } }; return c; };

test('limits: a chain over maxRebaseCommits is refused as the rebase chain (max the limit, got one past it) however far over, at no more requests than the merge-base search cost before; maxMergeDepth still bounds the onto walk', async () => {
  const { DEFAULT_LIMITS } = await import('../src/limits.js');
  const r = repo(); longBranch(r, 30);
  const tip = ok(sh(r.bare, ['rev-parse', 'feat']));
  assert.equal(ok(sh(r.bare, ['rev-list', '--count', 'main..feat'])), '30'); // git: the chain is 30 commits
  const run = async (limits) => { const c = counting(); const e = await unwrapAsync(rebaseBranch(r.url, { ref: 'refs/heads/feat', onto: 'refs/heads/main', committer }, { ...T(), fetchImpl: c.fetchImpl, limits: { ...DEFAULT_LIMITS, ...limits } })).then(() => null, x => x); return { code: e?.code, what: e?.what, got: e?.got, max: e?.max, requests: c.n }; };
  // ten over the limit, the merge depth below, at and above it: the chain limit is the one named, and max is the
  // caller's own number. Requests, by hand: ls-refs, the branch walk at 8, 16 and 22 (the limit + 2), and the onto
  // walk once (main is two commits: whole at the first depth). Before: ls-refs + two walks at each of 8, 16, 22 = 7.
  for (const maxMergeDepth of [16, 20, 1024]) assert.deepEqual(await run({ maxMergeDepth, maxRebaseCommits: 20 }), { code: 'limit_exceeded', what: 'rebase chain', got: 21, max: 20, requests: 5 }, `maxMergeDepth ${maxMergeDepth}`);
  // maxMergeDepth 0 allows no merge-base search: refused after ls-refs alone, as mergeBranch is
  assert.deepEqual(await run({ maxMergeDepth: 0, maxRebaseCommits: 40 }), { code: 'limit_exceeded', what: 'merge-base search depth', got: 1, max: 0, requests: 1 });
  assert.equal(ok(sh(r.bare, ['rev-parse', 'feat'])), tip, 'a refused rebase leaves the branch');
});

test('limits: WORKER_LIMITS.maxRebaseCommits, the cheapest shape of chain (every commit changes one file onto did not touch): at the limit the rebase equals git and takes at most 800 requests; one commit over is refused as the rebase chain', async () => {
  const { WORKER_LIMITS } = await import('../src/limits.js');
  const N = WORKER_LIMITS.maxRebaseCommits;
  assert.ok(N <= 800, `WORKER_LIMITS.maxRebaseCommits is ${N}: a replay costs at least one request a commit`);
  const r = repo(); longBranch(r, N + 1);
  ok(sh(r.bare, ['update-ref', 'refs/heads/atlimit', 'feat~1']));
  assert.equal(ok(sh(r.bare, ['rev-list', '--count', 'main..atlimit'])), String(N));
  const over = counting();
  const e = await unwrapAsync(rebaseBranch(r.url, { ref: 'refs/heads/feat', onto: 'refs/heads/main', committer }, { ...T(), fetchImpl: over.fetchImpl, limits: WORKER_LIMITS })).then(() => null, x => x);
  assert.deepEqual({ code: e?.code, what: e?.what, got: e?.got, max: e?.max }, { code: 'limit_exceeded', what: 'rebase chain', got: N + 1, max: N });
  // 17: ls-refs + two walks at each of 8 depths (8 … 1024), what the search cost before the chain limit governed it
  assert.ok(over.n <= 17, `refusing took ${over.n} requests`);
  // git's answer for the chain at the limit
  const d = clone(r.bare); ok(sh(d, ['checkout', '-q', 'atlimit'])); ok(sh(d, ['rebase', '-q', 'origin/main'])); const gitTree = treeOf(d, 'HEAD'); const gitCount = ok(sh(d, ['rev-list', '--count', 'origin/main..HEAD'])); rmSync(d, { recursive: true, force: true });
  const at = counting();
  const res = await unwrapAsync(rebaseBranch(r.url, { ref: 'refs/heads/atlimit', onto: 'refs/heads/main', committer }, { ...T(), fetchImpl: at.fetchImpl, limits: WORKER_LIMITS }));
  assert.equal(res.outcome, 'rebase'); assert.equal(String(res.commits), gitCount); assert.equal(treeOf(r.bare, 'atlimit'), gitTree);
  // a Worker request may make 1,000 subrequests (standard plan); 800 leaves the caller room for its own
  assert.ok(at.n <= 800, `a ${N}-commit rebase took ${at.n} requests`);
  console.log(`WORKER_LIMITS rebase: ${N} commits, ${at.n} requests; refusing ${N + 1}: ${over.n} requests`);
}, 300_000);
