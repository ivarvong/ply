// Rename shapes, decided by git. ply does not detect renames; its promise is to refuse wherever git's rename detection
// could change the result. The oracle is `git merge-tree --write-tree` (exit status and tree id, git's defaults) on
// three trees built with git plumbing, and `git cherry-pick` for the pick. The property, for hand shapes and for a
// seeded generator (moves across directories with identical and edited content, deletes, both-side deletes, a file
// replaced by a directory and the reverse, directory renames, subtrees identical on both sides):
//
//   ply ok        ⇒ git clean, and the same tree id
//   git conflict  ⇒ ply merge_conflict
//
// ply conflicting where git is clean is its documented superset; the generated run counts it.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpRoot, makeBareRepo, startGitServer } from './server.js';
import { oracleRediff } from './gitversion.js';
import { mergeBranch } from '../src/merge.js';
import { cherryPick } from '../src/rebase.js';
import { Tracer, arrayExporter } from '../src/otel.js';
import { generateCase } from './fuzz/renames.js';

const rediff = oracleRediff();
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'w', GIT_AUTHOR_EMAIL: 'w@x', GIT_COMMITTER_NAME: 'w', GIT_COMMITTER_EMAIL: 'w@x', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' };
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const author = { name: 'm', email: 'm@x', time: 1700000001 };
const opts = () => ({ tracer: new Tracer({ exporter: arrayExporter() }), rediff });

let root, cleanup, srv, bare, url, seq = 0;
const blobs = new Map();
const sh = (cwd, args, input, env = {}) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...ENV, ...env }, input, maxBuffer: 1 << 26 });
const must = (cwd, args, input, env) => { const r = sh(cwd, args, input, env); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); bare = makeBareRepo(root, 'rn'); url = `${srv.url}/rn.git`; });
after(async () => { await srv?.close(); cleanup?.(); });

// a tree from { path: content }, with git: hash-object per distinct content, one update-index, write-tree
const blob = data => { let oid = blobs.get(data); if (oid === undefined) { oid = must(bare, ['hash-object', '-w', '--stdin'], data); blobs.set(data, oid); } return oid; };
const tree = files => {
  const paths = Object.keys(files); if (paths.length === 0) return EMPTY_TREE;
  const env = { GIT_INDEX_FILE: join(root, `idx${seq++}`) };
  must(bare, ['update-index', '--add', '--index-info'], paths.map(p => `100644 ${blob(files[p])}\t${p}\n`).join(''), env);
  return must(bare, ['write-tree'], undefined, env);
};
const commit = (t, parents, msg) => must(bare, ['commit-tree', t, ...parents.flatMap(p => ['-p', p]), '-m', msg]);

// One three-way case: git's verdict and ply's, side by side.
async function both(base, ours, theirs) {
  const cb = commit(tree(base), [], 'base'); const co = commit(tree(ours), [cb], 'ours'); const ct = commit(tree(theirs), [cb], 'theirs');
  const id = seq++;
  must(bare, ['update-ref', `refs/heads/o${id}`, co]); must(bare, ['update-ref', `refs/heads/t${id}`, ct]);
  const gm = sh(bare, ['-c', `attr.tree=${EMPTY_TREE}`, 'merge-tree', '--write-tree', '--name-only', co, ct]);
  assert.ok(gm.status === 0 || gm.status === 1, gm.stderr);
  const git = { clean: gm.status === 0, tree: gm.stdout.split('\n')[0].trim(), info: gm.stdout.split('\n\n').slice(1).join(' ').replace(/\s+/g, ' ').trim() };
  const r = await mergeBranch(url, { ref: `refs/heads/o${id}`, from: `refs/heads/t${id}`, author }, opts());
  // a merged ref is left behind; each case has its own pair
  return { git, r };
}
// the property; returns 'equal' | 'both-conflict' | 'superset'
function judge(name, { git, r }) {
  if (r.ok) {
    assert.equal(r.value.outcome, 'merge', `${name}: outcome`);
    assert.ok(git.clean, `${name}: ply merged clean (tree ${r.value.tree}) where git conflicts: ${git.info}`);
    assert.equal(r.value.tree, git.tree, `${name}: ply's clean tree differs from git's`);
    return 'equal';
  }
  assert.equal(r.error.code, 'merge_conflict', `${name}: ${r.error.code} ${r.error.message}`);
  return git.clean ? 'superset' : 'both-conflict';
}

const lines = (n, f = i => `line ${i}`) => `${Array.from({ length: n }, (_, i) => f(i)).join('\n')}\n`;
const C = lines(30);
const D = lines(30, i => `totally different ${i * 7}`);
// C with every third line changed: similar enough for git to pair it with C (over 50%), not identical
const P = lines(30, i => (i % 3 === 0 ? `changed ${i}` : `line ${i}`));
const K = { keep: 'keep\n' };

// Each shape: [name, base, ours, theirs, what git says]. `conflict` shapes are the review findings: git names a rename
// conflict, so ply must refuse. `clean` shapes are their controls: no rename for git to find, so the trees must be equal.
const SHAPES = [
  // a file both sides deleted inside a subtree that is the same tree on both sides
  ['C1 rename out of a subtree identical on both sides vs delete', { ...K, 'x/f': C, 'x/h': 'h\n' }, { ...K, 'x/h': 'h\n', w: C }, { ...K, 'x/h': 'h\n' }, 'conflict'],
  ['C2 rename/rename(1to2) out of an identical subtree', { ...K, 'x/f': C, 'x/h': 'h\n' }, { ...K, 'x/h': 'h\n', w1: C }, { ...K, 'x/h': 'h\n', w2: C }, 'conflict'],
  ['C3 src/util.js -> lib/util.js vs delete', { ...K, 'src/util.js': C, 'src/main.js': 'main\n', 'lib/a.js': 'a\n' }, { ...K, 'src/main.js': 'main\n', 'lib/a.js': 'a\n', 'lib/util.js': C }, { ...K, 'src/main.js': 'main\n', 'lib/a.js': 'a\n' }, 'conflict'],
  ['C4 a directory both sides collapsed to the same file, its content moved', { ...K, 'x/f': C }, { ...K, x: 'now a file\n', w: C }, { ...K, x: 'now a file\n' }, 'conflict'],
  // the same with unrelated bytes at w: no rename for git. ply cannot tell without reading blobs, so it refuses, as it
  // always has for the flat form of this shape (G1 is by path, not by similarity): the documented superset
  ['ctl C1 unrelated add', { ...K, 'x/f': C, 'x/h': 'h\n' }, { ...K, 'x/h': 'h\n', w: D }, { ...K, 'x/h': 'h\n' }, 'clean, refused'],
  ['ctl C1 nothing added', { ...K, 'x/f': C, 'x/h': 'h\n' }, { ...K, 'x/h': 'h\n' }, { ...K, 'x/h': 'h\n', keep: 'kept\n' }, 'clean'],
  // a base file replaced by a directory of the same name
  ['H1 file -> directory rename vs delete', { ...K, d: C }, { ...K, 'd/x': C }, { ...K }, 'conflict'],
  ['H2 file -> directory rename/rename(1to2)', { ...K, d: C }, { ...K, 'd/x': C }, { ...K, 'd/y': C }, 'conflict'],
  // the "rename already applied" stand-down: different renames inside a directory new on both sides
  ['H3 different renames inside one new directory', { ...K, a: C }, { ...K, 'dir/q': C, 'dir/p': P }, { ...K, 'dir/p': P }, 'conflict'],
  ['ctl H3 the same rename on both sides (#103)', { ...K, a: C }, { ...K, 'dir/q': C }, { ...K, 'dir/q': C }, 'clean'],
];
for (const [name, base, ours, theirs, expected] of SHAPES) {
  test(`rename shape == git merge-tree: ${name}`, async () => {
    const got = await both(base, ours, theirs);
    // the shape is what its name says, by git
    assert.equal(got.git.clean, expected !== 'conflict', `git: ${got.git.info}`);
    if (expected === 'conflict') assert.match(got.git.info, /CONFLICT \(rename\//, 'git reports a rename conflict');
    const verdict = judge(name, got);
    if (expected === 'clean, refused') assert.equal(verdict, 'superset');
    if (expected === 'clean') assert.equal(verdict, 'equal', `${name}: git is clean with no rename in play, so must ply be (${got.r.ok ? '' : JSON.stringify(got.r.error.reasons)})`);
  });
}

test('cherry-pick of a delete onto a branch that moved the file: git cherry-pick conflicts (rename/delete), so the pick is not ok', async () => {
  const name = 'rnpick'; const b = makeBareRepo(root, name); const w = join(root, `w${name}`); mkdirSync(join(w, 'src'), { recursive: true }); mkdirSync(join(w, 'lib'));
  must(w, ['init', '-q', '-b', 'main']);
  const ci = msg => { must(w, ['add', '-A']); must(w, ['commit', '-q', '-m', msg]); return must(w, ['rev-parse', 'HEAD']); };
  writeFileSync(join(w, 'src/util.js'), C); writeFileSync(join(w, 'src/main.js'), 'main\n'); writeFileSync(join(w, 'lib/a.js'), 'a\n'); ci('base');
  must(w, ['checkout', '-q', '-b', 'topic']); rmSync(join(w, 'src/util.js')); const del = ci('delete util');
  must(w, ['checkout', '-q', 'main']); must(w, ['mv', 'src/util.js', 'lib/util.js']); ci('move util');
  must(w, ['push', '-q', b, 'main', 'topic']);
  const gp = sh(w, ['cherry-pick', del]);
  assert.equal(gp.status, 1, 'git cherry-pick stops'); assert.match(gp.stdout + gp.stderr, /CONFLICT \(rename\/delete\)/);
  const p = await cherryPick(`${srv.url}/${name}.git`, { ref: 'refs/heads/main', commit: del, committer: author }, opts());
  assert.equal(p.ok, false, `git conflicts, ply answered ok (${p.ok ? p.value.outcome : ''})`);
  assert.equal(p.error.code, 'merge_conflict');
});

// Tree reads, counted at the transport: every upload-pack request ply sends is recorded with the ids it wants, and git
// says which of those are trees. The expected numbers are counted by hand from the shape (each tree named below); a
// tree wanted twice is a tree fetched twice.
async function wanted(base, ours, theirs) {
  const wants = []; const flights = [];
  const fetch = async (input, init) => {
    const body = init?.body;
    const text = typeof body === 'string' ? body : body instanceof Uint8Array ? Buffer.from(body).toString('latin1') : body instanceof ArrayBuffer || ArrayBuffer.isView(body) ? Buffer.from(body.buffer ?? body).toString('latin1') : '';
    const mine = [...text.matchAll(/want ([0-9a-f]{40})/g)].map(m => m[1]);
    wants.push(...mine); flights.push([mine, 1]);
    try { return await globalThis.fetch(input, init); } finally { flights.push([mine, -1]); }
  };
  const cb = commit(tree(base), [], 'base'); const co = commit(tree(ours), [cb], 'ours'); const ct = commit(tree(theirs), [cb], 'theirs');
  const id = seq++;
  must(bare, ['update-ref', `refs/heads/o${id}`, co]); must(bare, ['update-ref', `refs/heads/t${id}`, ct]);
  const gm = sh(bare, ['-c', `attr.tree=${EMPTY_TREE}`, 'merge-tree', '--write-tree', '--name-only', co, ct]);
  const r = await mergeBranch(url, { ref: `refs/heads/o${id}`, from: `refs/heads/t${id}`, author }, { ...opts(), fetchImpl: fetch });
  const trees = wants.filter(oid => must(bare, ['cat-file', '-t', oid]) === 'tree');
  // the most tree requests ever open at once: a request is open from the call until its response headers arrive
  const isTree = new Set(trees); let open = 0; let peak = 0;
  for (const [oids, d] of flights) if (oids.some(oid => isTree.has(oid))) { open += d; peak = Math.max(peak, open); }
  return { r, git: { clean: gm.status === 0, tree: gm.stdout.split('\n')[0].trim(), info: gm.stdout }, trees, peak };
}
const wide = (n, tag, pre = 'pkg') => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${pre}${i}/f`, `${tag} ${i}\n`]));
const once = (name, trees) => assert.equal(new Set(trees).size, trees.length, `${name}: a tree was fetched twice (${trees.length} fetches of ${new Set(trees).size} trees)`);

test('tree reads: 40 directories both sides changed identically, ordinary edits and nothing added or removed, read the three roots and nothing else', async () => {
  // the roots of base, ours and theirs: 3. Every pkgN is the same tree on ours and theirs, so the merge takes it unread,
  // and no path was added or removed, so there is no rename to guard: main read these 3 trees
  const { r, git, trees } = await wanted({ ...K, ...wide(40, 'v1'), a: 'a\n', b: 'b\n' }, { ...K, ...wide(40, 'v2'), a: 'a2\n', b: 'b\n' }, { ...K, ...wide(40, 'v2'), a: 'a\n', b: 'b2\n' });
  assert.ok(r.ok && git.clean, 'clean on both'); assert.equal(r.value.tree, git.tree);
  once('40 dirs', trees);
  assert.equal(trees.length, 3);
});

test('tree reads: a both-sides delete inside a shared subtree beside an added file (C1) reads each tree once', async () => {
  // 3 roots + base's x + the one x ours and theirs share = 5 distinct trees; the shared x is one tree, read once
  const { r, git, trees } = await wanted({ ...K, 'x/f': C, 'x/h': 'h\n' }, { ...K, 'x/h': 'h\n', w: C }, { ...K, 'x/h': 'h\n' });
  assert.equal(git.clean, false); assert.equal(r.ok, false); assert.equal(r.error.code, 'merge_conflict');
  once('C1', trees);
  assert.equal(trees.length, 5);
});

test('tree reads: 40 shared directories and a file added on each side read base and the shared copy of each, once', async () => {
  // an added file could be a rename target, so the shared directories are entered: 3 roots + 40 x (base's, the shared one)
  const { r, git, trees } = await wanted({ ...K, ...wide(40, 'v1') }, { ...K, ...wide(40, 'v2'), mine: 'o\n' }, { ...K, ...wide(40, 'v2'), yours: 't\n' });
  assert.ok(r.ok && git.clean, 'clean on both'); assert.equal(r.value.tree, git.tree);
  once('40 dirs + adds', trees);
  assert.equal(trees.length, 83);
});

// The gate's cost when directories changed identically on both sides (shared) sit beside directories one side alone
// changed (owner decision 4). G1 needs both a path lost on both sides inside a shared subtree and a path one side alone
// added or removed, so one "no" settles it; the gate asks the question with fewer directories to read first: the shared
// subtrees when they are fewer than the one-side-changed directories, the one-side-changed directories otherwise.
// Every count below is derived by hand from that rule and the shape; main read 3 (the roots) in each of the first three.
test('tree reads (COST-A): 40 shared directories beside 40 only ours edited read the roots and the 40 one-sided pairs, several at a time', async () => {
  // 40 shared is not fewer than 40 one-sided, so the one-sided question is asked: 3 roots + base's and ours' copy of
  // each own<i> (40 x 2) = 83. No add or removal there, so the shared pkg<i> are never read.
  const { r, git, trees, peak } = await wanted({ ...K, ...wide(40, 'v1'), ...wide(40, 'o1', 'own') }, { ...K, ...wide(40, 'v2'), ...wide(40, 'o2', 'own') }, { ...K, ...wide(40, 'v2'), ...wide(40, 'o1', 'own') });
  assert.ok(r.ok && git.clean, 'clean on both'); assert.equal(r.value.tree, git.tree);
  once('COST-A', trees);
  assert.equal(trees.length, 83);
  // sibling directories are read 8 at a time, two trees each (base's and ours'): never more than 16 tree requests
  // open, and more than the 3 a one-after-another descent has (the three roots; then 2 per directory)
  assert.ok(peak > 3 && peak <= 16, `tree requests open at once: ${peak}`);
});

test('tree reads (COST-B): 1 shared directory beside 80 one side edited reads the roots and the shared pair', async () => {
  // 1 shared is fewer than 80 one-sided, so the shared subtree is entered: 3 roots + base's sh + the one sh ours and
  // theirs share = 5. Nothing was lost on both sides in it, so no one-sided directory is read.
  const { r, git, trees } = await wanted({ ...K, 'sh/f': 'v1\n', ...wide(40, 'o1', 'own'), ...wide(40, 't1', 'thr') }, { ...K, 'sh/f': 'v2\n', ...wide(40, 'o2', 'own'), ...wide(40, 't1', 'thr') }, { ...K, 'sh/f': 'v2\n', ...wide(40, 'o1', 'own'), ...wide(40, 't2', 'thr') });
  assert.ok(r.ok && git.clean, 'clean on both'); assert.equal(r.value.tree, git.tree);
  once('COST-B', trees);
  assert.equal(trees.length, 5);
});

test('tree reads (COST-C): no shared directory, 80 one side edited: the three roots, as main', async () => {
  // no directory changed identically on both sides: the gate is not reached; each own<i> / thr<i> is taken from the
  // side that changed it, unread
  const { r, git, trees } = await wanted({ ...K, ...wide(40, 'o1', 'own'), ...wide(40, 't1', 'thr') }, { ...K, ...wide(40, 'o2', 'own'), ...wide(40, 't1', 'thr') }, { ...K, ...wide(40, 'o1', 'own'), ...wide(40, 't2', 'thr') });
  assert.ok(r.ok && git.clean, 'clean on both'); assert.equal(r.value.tree, git.tree);
  once('COST-C', trees);
  assert.equal(trees.length, 3);
});

test('tree reads: C2 reads 5 trees and C3 reads 7, each once', async () => {
  // C2: 1 shared (x), no one-sided directory, so the one-sided question is asked and the roots answer it (w1 is new on
  // ours): nothing read. The shared x is then entered: 3 roots + base's x + the shared x = 5
  const c2 = await wanted({ ...K, 'x/f': C, 'x/h': 'h\n' }, { ...K, 'x/h': 'h\n', w1: C }, { ...K, 'x/h': 'h\n', w2: C });
  assert.match(c2.git.info, /CONFLICT \(rename\/rename\)/); assert.equal(c2.r.ok, false); assert.equal(c2.r.error.code, 'merge_conflict');
  once('C2', c2.trees);
  assert.equal(c2.trees.length, 5);
  // C3: 1 shared (src) is not fewer than 1 one-sided (lib), so lib is read first (base's and ours': lib/util.js is new),
  // then the shared src (base's and the shared one): 3 roots + 2 + 2 = 7
  const c3 = await wanted({ ...K, 'src/util.js': C, 'src/main.js': 'main\n', 'lib/a.js': 'a\n' }, { ...K, 'src/main.js': 'main\n', 'lib/a.js': 'a\n', 'lib/util.js': C }, { ...K, 'src/main.js': 'main\n', 'lib/a.js': 'a\n' });
  assert.match(c3.git.info, /CONFLICT \(rename\/delete\)/); assert.equal(c3.r.ok, false); assert.equal(c3.r.error.code, 'merge_conflict');
  once('C3', c3.trees);
  assert.equal(c3.trees.length, 7);
});

test('a directory both sides replaced with different files (git: add/add) is listed once, with the walk\'s reason', async () => {
  const got = await both({ ...K, 'x/f': C }, { ...K, x: 'A\n' }, { ...K, x: 'B\n' });
  assert.equal(got.git.clean, false); assert.match(got.git.info, /CONFLICT \(add\/add\)/);
  assert.equal(got.r.ok, false);
  assert.deepEqual(got.r.error.conflicts, ['x']);
  assert.equal(got.r.error.reasons.x, 'tree');
});

// The generated run. RENAME_SEED / RENAME_CASES pick the run; the default is small enough for the suite. This test is
// the only run of the generator: it is not part of the pinned fuzz run (npm run test:fuzz-pinned).
test('property: generated rename shapes — ply ok ⇒ git clean with the same tree; git conflict ⇒ ply conflict', async () => {
  const seed = Number(process.env.RENAME_SEED ?? 7); const cases = Number(process.env.RENAME_CASES ?? 120);
  const tally = { equal: 0, 'both-conflict': 0, superset: 0 };
  for (let i = 0; i < cases; i++) {
    const c = generateCase(seed, i);
    // oxlint-disable-next-line eslint/no-await-in-loop -- one case at a time against one repository
    tally[judge(`seed ${seed} case ${i} [${c.ops.join('; ')}]`, await both(c.base, c.ours, c.theirs))]++;
  }
  if (process.env.RENAME_TALLY) writeFileSync(process.env.RENAME_TALLY, `${JSON.stringify({ seed, cases, ...tally })}\n`);
  // the generator reaches both verdicts, or the property proves nothing
  assert.ok(tally.equal > 0 && tally['both-conflict'] > 0, JSON.stringify(tally));
}, 600_000);
