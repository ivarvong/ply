// The rename guard's one-sided removal trigger, decided by git. ply does not detect renames; when both sides changed a
// directory identically, the merge takes it unread, and a rename both sides made inside it stays hidden. That is safe
// only while neither side added or removed a path of its own: a file one side alone deleted is a second rename source
// on that side, so git may pair the shared add with it there and with the shared delete on the other side, and report
// CONFLICT (rename/delete). The guard therefore enters the shared subtrees when a side removed a path, not only when a
// side added one. These shapes have no add outside the shared subtree and no conflict in the walk: the removal is the
// only thing that makes ply look.
//
// The oracle is `git merge-tree --write-tree` (exit status, tree id and messages, git's defaults) on three trees built
// with git plumbing, run here for every case; `git diff-tree -M` says the stand-down shape hides a rename. Nothing is
// expected from ply that git did not say first:
//
//   git conflict  ⇒ ply merge_conflict
//   ply ok        ⇒ git clean, and the same tree id
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpRoot, makeBareRepo, startGitServer } from './server.js';
import { oracleRediff } from './gitversion.js';
import { mergeBranch } from '../src/merge.js';
import { Tracer, arrayExporter } from '../src/otel.js';

const rediff = oracleRediff();
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'w', GIT_AUTHOR_EMAIL: 'w@x', GIT_COMMITTER_NAME: 'w', GIT_COMMITTER_EMAIL: 'w@x', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' };
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const author = { name: 'm', email: 'm@x', time: 1700000001 };
const opts = () => ({ tracer: new Tracer({ exporter: arrayExporter() }), rediff });

let root, cleanup, srv, bare, url, seq = 0;
const blobs = new Map();
const sh = (args, input, env = {}) => spawnSync('git', ['-C', bare, ...args], { encoding: 'utf8', env: { ...ENV, ...env }, input, maxBuffer: 1 << 26 });
const must = (args, input, env) => { const r = sh(args, input, env); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); bare = makeBareRepo(root, 'rnrm'); url = `${srv.url}/rnrm.git`; });
after(async () => { await srv?.close(); cleanup?.(); });

// a tree from { path: content }, with git: hash-object per distinct content, one update-index, write-tree
const blob = data => { let oid = blobs.get(data); if (oid === undefined) { oid = must(['hash-object', '-w', '--stdin'], data); blobs.set(data, oid); } return oid; };
const tree = files => {
  const env = { GIT_INDEX_FILE: join(root, `idx${seq++}`) };
  must(['update-index', '--add', '--index-info'], Object.keys(files).map(p => `100644 ${blob(files[p])}\t${p}\n`).join(''), env);
  return must(['write-tree'], undefined, env);
};
const commit = (t, parents, msg) => must(['commit-tree', t, ...parents.flatMap(p => ['-p', p]), '-m', msg]);

// One three-way case: git's verdict and ply's, side by side. Each case has its own pair of refs.
async function both(base, ours, theirs) {
  const cb = commit(tree(base), [], 'base'); const co = commit(tree(ours), [cb], 'ours'); const ct = commit(tree(theirs), [cb], 'theirs');
  const id = seq++;
  must(['update-ref', `refs/heads/o${id}`, co]); must(['update-ref', `refs/heads/t${id}`, ct]);
  const gm = sh(['-c', `attr.tree=${EMPTY_TREE}`, 'merge-tree', '--write-tree', '--name-only', co, ct]);
  assert.ok(gm.status === 0 || gm.status === 1, gm.stderr);
  const git = { clean: gm.status === 0, tree: gm.stdout.split('\n')[0].trim(), info: gm.stdout.split('\n\n').slice(1).join(' ').replace(/\s+/g, ' ').trim() };
  const r = await mergeBranch(url, { ref: `refs/heads/o${id}`, from: `refs/heads/t${id}`, author }, opts());
  return { git, r, commits: { base: cb, ours: co, theirs: ct } };
}

const lines = (n, f = i => `line ${i}`) => `${Array.from({ length: n }, (_, i) => f(i)).join('\n')}\n`;
const C = lines(30);
// C with every third line changed: similar enough for git to pair it with C (over 50%), not identical
const P = lines(30, i => (i % 3 === 0 ? `changed ${i}` : `line ${i}`));
const K = { keep: 'keep\n' };

// In each shape both sides replace x/f (C) with x/g (P), so x is one tree on ours and theirs, and one side alone
// deletes a file whose bytes are exactly x/g's. On that side git pairs x/g with the exact twin and x/f is a plain
// delete; on the other side x/g pairs with x/f. git: rename/delete.
const REMOVALS = [
  ['V0 ours alone deletes the root file y', { ...K, 'x/f': C, 'x/h': 'h\n', y: P }, { ...K, 'x/g': P, 'x/h': 'h\n' }, { ...K, 'x/g': P, 'x/h': 'h\n', y: P }],
  ['V1 theirs alone deletes the root file y', { ...K, 'x/f': C, 'x/h': 'h\n', y: P }, { ...K, 'x/g': P, 'x/h': 'h\n', y: P }, { ...K, 'x/g': P, 'x/h': 'h\n' }],
  ['V2 the deleted file sits in a directory only ours changed (y/t)', { ...K, 'x/f': C, 'x/h': 'h\n', 'y/t': P, 'y/k': 'k\n' }, { ...K, 'x/g': P, 'x/h': 'h\n', 'y/k': 'k\n' }, { ...K, 'x/g': P, 'x/h': 'h\n', 'y/t': P, 'y/k': 'k\n' }],
];
for (const [name, base, ours, theirs] of REMOVALS) {
  test(`one-sided removal beside a rename hidden in a shared subtree == git merge-tree: ${name}`, async () => {
    const { git, r } = await both(base, ours, theirs);
    // the shape is what its name says, by git
    assert.equal(git.clean, false, `git merges this clean (tree ${git.tree})`);
    assert.match(git.info, /CONFLICT \(rename\/delete\): x\/f renamed to x\/g/, git.info);
    // so ply must refuse
    assert.equal(r.ok, false, `${name}: ply merged clean (tree ${r.ok ? r.value.tree : ''}) where git conflicts: ${git.info}`);
    assert.equal(r.error.code, 'merge_conflict', `${name}: ${r.error.code} ${r.error.message}`);
  });
}

test('the guard stands down over a rename hidden in a shared subtree when the sides differ only by edits elsewhere: the same tree as git merge-tree', async () => {
  // V0 with y kept on both sides: the same hidden rename, and nothing added or removed by one side alone. Both sides
  // give rename detection the same sources and targets, so git pairs x/f with x/g on both and merges clean.
  const { git, r, commits } = await both(
    { ...K, 'x/f': C, 'x/h': 'h\n', y: P, a: 'a\n', b: 'b\n' },
    { ...K, 'x/g': P, 'x/h': 'h\n', y: P, a: 'a2\n', b: 'b\n' },
    { ...K, 'x/g': P, 'x/h': 'h\n', y: P, a: 'a\n', b: 'b2\n' });
  // the rename is there, by git, on each side
  for (const side of [commits.ours, commits.theirs]) assert.match(must(['diff-tree', '-r', '-M', '--name-status', commits.base, side]), /^R\d+\tx\/f\tx\/g$/m);
  assert.equal(git.clean, true, `git: ${git.info}`);
  assert.equal(r.ok, true, `git is clean and no side added or removed a path of its own, so must ply be (${r.ok ? '' : `${r.error.code} ${JSON.stringify(r.error.reasons)}`})`);
  assert.equal(r.value.outcome, 'merge');
  assert.equal(r.value.tree, git.tree, 'ply\'s clean tree differs from git\'s');
});
