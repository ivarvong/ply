// empty: 'keep' against stock git (#117). git is the only judge of the commit bytes.
//
//   cherry-pick, the change already applied   git cherry-pick --keep-redundant-commits
//   cherry-pick, the commit was empty         git cherry-pick --allow-empty (and --keep-redundant-commits; same bytes)
//   cherry-pick of a root                     the parent side is the empty tree; already-contained → --keep-redundant-commits
//   revert, including of a root               git revert --no-edit
//   revert that is already applied            git revert --no-edit stops; git commit --allow-empty --no-edit writes the
//                                             message revert prepared (git 2.43 revert has no --allow-empty)
//
// Author and committer are different people, times and zones. A cherry-pick keeps the picked commit's author line;
// a revert's author is the person reverting. Both use the caller's committer.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { git, tmpRoot, makeBareRepo, startGitServer } from './server.js';
import { oracleRediff } from './gitversion.js';
import { cherryPick, revertCommit, pickCommit } from '../src/rebase.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';

const rediff = oracleRediff();
const BASE_ENV = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' };
const ORIG = { name: 'orig', email: 'orig@x', time: 1400000000, tz: '+0200' };
const PAIRS = [
  [{ name: 'Ann', email: 'ann@x', time: 1700000000, tz: '+0530' }, { name: 'Cid', email: 'cid@x', time: 1700003600, tz: '-0800' }],
  [{ name: 'Ann', email: 'ann@x', time: 1500000000 }, { name: 'Cid', email: 'cid@x', time: 1500000001, tz: '+0545' }],
];
const envOf = (a, c) => ({ ...BASE_ENV, GIT_AUTHOR_NAME: a.name, GIT_AUTHOR_EMAIL: a.email, GIT_AUTHOR_DATE: `@${a.time} ${a.tz ?? '+0000'}`, GIT_COMMITTER_NAME: c.name, GIT_COMMITTER_EMAIL: c.email, GIT_COMMITTER_DATE: `@${c.time} ${c.tz ?? '+0000'}` });
const sh = (cwd, args, env = BASE_ENV) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env });
const ok = (cwd, args, env = BASE_ENV) => { const r = sh(cwd, args, env); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}${r.stdout}`); return r.stdout.trim(); };

let root, cleanup, srv, n = 0;
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv?.close(); cleanup?.(); });

const workOf = () => { const name = `pe${n++}`; const bare = makeBareRepo(root, name); const w = join(root, `w${name}`); mkdirSync(w); const env = envOf(ORIG, ORIG); git(w, ['init', '-q', '-b', 'main']); return { name, bare, w, env, url: `${srv.url}/${name}.git` }; };
const commit = (b, msg) => { ok(b.w, ['add', '-A'], b.env); ok(b.w, ['commit', '-q', '--allow-empty', '-m', msg], b.env); return ok(b.w, ['rev-parse', 'HEAD'], b.env); };
const put = (b, file, text) => writeFileSync(join(b.w, file), text);
const clone = (bare, branch) => { const d = mkdtempSync(join(tmpdir(), 'pe-')); ok(d, ['clone', '-q', '-b', branch, bare, '.']); return d; };
const raw = (repo, rev) => ok(repo, ['cat-file', '-p', rev]);
const tip = (bare, branch) => ok(bare, ['rev-parse', branch]);
const opts = tracer => ({ tracer, rediff });
const who = (a, c) => ({ author: a, committer: c });

// same-content history: root (f.txt), main (m.txt), feat (b.txt, not on main), an empty commit on feat.
function contentRepo() {
  const b = workOf();
  put(b, 'f.txt', 'f\n'); const rootOid = commit(b, 'base');
  put(b, 'm.txt', 'm\n'); const main = commit(b, 'add m');
  ok(b.w, ['checkout', '-q', '-b', 'feat', rootOid], b.env);
  put(b, 'b.txt', 'b\n'); const feat = commit(b, 'add b');
  const empty = commit(b, 'intentionally empty');
  ok(b.w, ['push', '-q', b.bare, 'refs/heads/main', 'refs/heads/feat'], b.env);
  rmSync(b.w, { recursive: true, force: true });
  return { ...b, rootOid, main, feat, empty };
}

// rename already applied on dst, the same rename sitting on src.
function renameRepo() {
  const b = workOf();
  put(b, 'old.txt', 'old\n'); const base = commit(b, 'base');
  ok(b.w, ['checkout', '-q', '-b', 'src', base], b.env);
  ok(b.w, ['mv', 'old.txt', 'new.txt'], b.env); const renamed = commit(b, 'rename');
  ok(b.w, ['checkout', '-q', '-b', 'dst', base], b.env);
  ok(b.w, ['mv', 'old.txt', 'new.txt'], b.env); commit(b, 'also rename');
  ok(b.w, ['push', '-q', b.bare, 'refs/heads/src', 'refs/heads/dst'], b.env);
  rmSync(b.w, { recursive: true, force: true });
  return { ...b, renamed };
}

// root, its child main, and an unrelated orphan `other` (x.txt only).
function rootRepo() {
  const b = workOf();
  put(b, 'f.txt', 'f\n'); const rootOid = commit(b, 'base');
  put(b, 'm.txt', 'm\n'); const main = commit(b, 'add m');
  ok(b.w, ['checkout', '-q', '--orphan', 'other'], b.env);
  ok(b.w, ['rm', '-qrf', '.'], b.env);
  put(b, 'x.txt', 'x\n'); const other = commit(b, 'other');
  ok(b.w, ['push', '-q', b.bare, 'refs/heads/main', 'refs/heads/other'], b.env);
  rmSync(b.w, { recursive: true, force: true });
  return { ...b, rootOid, main, other };
}

function gitPick(dir, oid, env, flag) {
  const args = ['cherry-pick', ...(flag ? [flag] : []), oid];
  return sh(dir, args, env);
}
// A revert git completed, or — when it stopped because the tree did not change — the commit
// `git commit --allow-empty --no-edit` writes from the message revert left behind.
function gitRevert(dir, oid, env, keep) {
  const before = ok(dir, ['rev-parse', 'HEAD'], env);
  const r = sh(dir, ['revert', '--no-edit', oid], env);
  if (r.status === 0) return { wrote: true, before };
  assert.match(`${r.stdout}${r.stderr}`, /nothing to commit|working tree clean/u, `git revert ${oid}: ${r.stderr}`);
  assert.equal(ok(dir, ['rev-parse', 'HEAD'], env), before, 'an empty revert must not move HEAD');
  if (!keep) return { wrote: false, before };
  const c = sh(dir, ['commit', '--allow-empty', '--no-edit'], env);
  assert.equal(c.status, 0, `git commit --allow-empty: ${c.stderr}${c.stdout}`);
  return { wrote: true, before };
}

test('cherry-pick --keep-redundant-commits and --allow-empty: commit bytes match git, stop writes nothing', async () => {
  for (const [a, c] of PAIRS) {
    const env = envOf(a, c);
    const r = contentRepo();
    const d = clone(r.bare, 'main');
    try {
      // `add m` is already the tip: its patch is contained, so the pick is empty
      const stopped = await cherryPick(r.url, { ref: 'refs/heads/main', commit: r.main, committer: c, empty: 'stop' }, opts(new Tracer()));
      assert.equal(stopped.outcome, 'empty');
      assert.equal(stopped.oid, r.main);
      assert.equal(tip(r.bare, 'main'), r.main);
      const plain = gitPick(d, r.main, env);
      assert.notEqual(plain.status, 0);
      assert.equal(ok(d, ['rev-parse', 'HEAD'], env), r.main);
      ok(d, ['cherry-pick', '--abort'], env);

      const kept = await cherryPick(r.url, { ref: 'refs/heads/main', commit: r.main, committer: c, empty: 'keep' }, opts(new Tracer()));
      assert.equal(kept.outcome, 'kept_empty');
      assert.equal(kept.onto, r.main);
      assert.equal(kept.tree, ok(r.bare, ['rev-parse', 'main^{tree}']));
      const g = gitPick(d, r.main, env, '--keep-redundant-commits');
      assert.equal(g.status, 0, g.stderr);
      assert.equal(raw(r.bare, kept.oid), raw(d, 'HEAD'));

      // an initially empty commit: --allow-empty and --keep-redundant-commits write the same object
      const d2 = clone(r.bare, 'main');
      try {
        const emptyStop = await cherryPick(r.url, { ref: 'refs/heads/main', commit: r.empty, committer: c }, opts(new Tracer()));
        assert.equal(emptyStop.outcome, 'empty');
        assert.equal(tip(r.bare, 'main'), kept.oid, 'stop does not move the ref the keep just wrote');
        const allow = gitPick(d2, r.empty, env, '--allow-empty');
        assert.equal(allow.status, 0, allow.stderr);
        const d3 = clone(r.bare, 'main');
        try {
          // both clones start at the kept redundant commit; the empty stop above did not move main.
          const again = gitPick(d3, r.empty, env, '--keep-redundant-commits');
          assert.equal(again.status, 0, again.stderr);
          assert.equal(raw(d2, 'HEAD'), raw(d3, 'HEAD'));
          const emptyKept = await cherryPick(r.url, { ref: 'refs/heads/main', commit: r.empty, committer: c, empty: 'keep' }, opts(new Tracer()));
          assert.equal(emptyKept.outcome, 'kept_empty');
          assert.equal(raw(r.bare, emptyKept.oid), raw(d2, 'HEAD'));
        } finally { rmSync(d3, { recursive: true, force: true }); }
      } finally { rmSync(d2, { recursive: true, force: true }); }
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
});

test('revert of a change already absent: stop writes nothing; keep matches git commit --allow-empty --no-edit', async () => {
  for (const [a, c] of PAIRS) {
    const env = envOf(a, c);
    const r = contentRepo();
    // first revert removes m.txt; the second is empty
    const first = await revertCommit(r.url, { ref: 'refs/heads/main', commit: r.main, ...who(a, c) }, opts(new Tracer()));
    assert.equal(first.outcome, 'ok');
    const d = clone(r.bare, 'main');
    try {
      gitRevert(d, r.main, env, false);
      assert.equal(raw(r.bare, first.oid), raw(d, 'HEAD'));
      const before = tip(r.bare, 'main');
      const stopped = await revertCommit(r.url, { ref: 'refs/heads/main', commit: r.main, ...who(a, c), empty: 'stop' }, opts(new Tracer()));
      assert.equal(stopped.outcome, 'empty');
      assert.equal(stopped.oid, before);
      assert.equal(tip(r.bare, 'main'), before);
      gitRevert(d, r.main, env, false);
      assert.equal(ok(d, ['rev-parse', 'HEAD'], env), first.oid);
      // git 2.43's empty revert exits without a sequencer (REVERT_HEAD is absent); MERGE_MSG is what --allow-empty reads.
      const kept = await revertCommit(r.url, { ref: 'refs/heads/main', commit: r.main, ...who(a, c), empty: 'keep' }, opts(new Tracer()));
      assert.equal(kept.outcome, 'kept_empty');
      assert.equal(kept.tree, ok(r.bare, ['rev-parse', `${before}^{tree}`]));
      gitRevert(d, r.main, env, true);
      assert.equal(raw(r.bare, kept.oid), raw(d, 'HEAD'));
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
});

test('already-applied rename: keep matches git cherry-pick --keep-redundant-commits', async () => {
  const [a, c] = PAIRS[0];
  const env = envOf(a, c);
  const r = renameRepo();
  const d = clone(r.bare, 'dst');
  try {
    const stopped = await cherryPick(r.url, { ref: 'refs/heads/dst', commit: r.renamed, committer: c }, opts(new Tracer()));
    assert.equal(stopped.outcome, 'empty');
    const plain = gitPick(d, r.renamed, env);
    assert.notEqual(plain.status, 0, 'git without the flag must not write the empty rename pick');
    ok(d, ['cherry-pick', '--abort'], env);
    const kept = await cherryPick(r.url, { ref: 'refs/heads/dst', commit: r.renamed, committer: c, empty: 'keep' }, opts(new Tracer()));
    assert.equal(kept.outcome, 'kept_empty');
    const g = gitPick(d, r.renamed, env, '--keep-redundant-commits');
    assert.equal(g.status, 0, g.stderr);
    assert.equal(raw(r.bare, kept.oid), raw(d, 'HEAD'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('root commit: cherry-pick and revert match git, including an empty keep onto a descendant', async () => {
  for (const [a, c] of PAIRS) {
    const env = envOf(a, c);
    const r = rootRepo();
    const onto = clone(r.bare, 'other');
    const down = clone(r.bare, 'main');
    try {
      const picked = await cherryPick(r.url, { ref: 'refs/heads/other', commit: r.rootOid, committer: c }, opts(new Tracer()));
      assert.equal(picked.outcome, 'ok');
      const g = gitPick(onto, r.rootOid, env);
      assert.equal(g.status, 0, g.stderr);
      assert.equal(raw(r.bare, picked.oid), raw(onto, 'HEAD'));
      const reverted = await revertCommit(r.url, { ref: 'refs/heads/other', commit: r.rootOid, ...who(a, c) }, opts(new Tracer()));
      assert.equal(reverted.outcome, 'ok');
      gitRevert(onto, r.rootOid, env, false);
      assert.equal(raw(r.bare, reverted.oid), raw(onto, 'HEAD'));

      // the root's patch is already in main: stop writes nothing, keep matches --keep-redundant-commits
      const stopped = await cherryPick(r.url, { ref: 'refs/heads/main', commit: r.rootOid, committer: c, empty: 'stop' }, opts(new Tracer()));
      assert.equal(stopped.outcome, 'empty');
      assert.equal(tip(r.bare, 'main'), r.main);
      const plain = gitPick(down, r.rootOid, env);
      assert.notEqual(plain.status, 0);
      ok(down, ['cherry-pick', '--abort'], env);
      const kept = await cherryPick(r.url, { ref: 'refs/heads/main', commit: r.rootOid, committer: c, empty: 'keep' }, opts(new Tracer()));
      assert.equal(kept.outcome, 'kept_empty');
      const gk = gitPick(down, r.rootOid, env, '--keep-redundant-commits');
      assert.equal(gk.status, 0, gk.stderr);
      assert.equal(raw(r.bare, kept.oid), raw(down, 'HEAD'));
    } finally { rmSync(onto, { recursive: true, force: true }); rmSync(down, { recursive: true, force: true }); }
  }
});

test('a caller message on an empty keep replaces git\'s message; the author line does not change', async () => {
  const [, c] = PAIRS[0];
  const r = contentRepo();
  const d = clone(r.bare, 'main');
  try {
    const env = envOf(ORIG, c);
    const kept = await cherryPick(r.url, { ref: 'refs/heads/main', commit: r.main, committer: c, empty: 'keep', message: 'custom\n' }, opts(new Tracer()));
    assert.equal(kept.outcome, 'kept_empty');
    const g = gitPick(d, r.main, env, '--keep-redundant-commits');
    assert.equal(g.status, 0, g.stderr);
    const tree = ok(d, ['rev-parse', 'HEAD^{tree}'], env);
    const parent = ok(d, ['rev-parse', 'HEAD^'], env);
    const rewritten = ok(d, ['commit-tree', tree, '-p', parent, '-m', 'custom'], env);
    assert.equal(raw(r.bare, kept.oid), raw(d, rewritten));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('empty other than stop or keep is bad_request; a merge commit is not_linear', async () => {
  const r = contentRepo();
  const c = PAIRS[0][1];
  await assert.rejects(pickCommit(r.url, { ref: 'refs/heads/main', commit: r.feat, committer: c, empty: 'drop' }, opts(new Tracer())), e => e.code === 'bad_request' && e.what === 'empty');
  assert.equal(tip(r.bare, 'main'), r.main);
  // a merge: two parents, refused before any transplant. git cherry-pick without -m refuses it too.
  const w = join(root, 'merge-src'); mkdirSync(w);
  const env = envOf(ORIG, ORIG);
  ok(w, ['clone', '-q', r.bare, '.'], env);
  ok(w, ['checkout', '-q', '-b', 'side'], env);
  writeFileSync(join(w, 's.txt'), 's\n');
  ok(w, ['add', '-A'], env); ok(w, ['commit', '-q', '-m', 'side'], env);
  ok(w, ['checkout', '-q', 'main'], env);
  ok(w, ['merge', '--no-ff', '-q', '-m', 'merge', 'side'], env);
  const merge = ok(w, ['rev-parse', 'HEAD'], env);
  ok(w, ['push', '-q', r.bare, 'HEAD:refs/heads/main'], env);
  const d = clone(r.bare, 'main');
  try {
    await assert.rejects(cherryPick(r.url, { ref: 'refs/heads/main', commit: merge, committer: c }, opts(new Tracer())), e => e.code === 'not_linear');
    const g = gitPick(d, merge, envOf(PAIRS[0][0], c));
    assert.notEqual(g.status, 0);
    assert.match(`${g.stderr}`, /is a merge but no -m option was given/u);
  } finally { rmSync(d, { recursive: true, force: true }); rmSync(w, { recursive: true, force: true }); }
});

test('spans record empty stop or keep, and a kept commit carries the same result attributes as a written one', async () => {
  const r = contentRepo();
  const c = PAIRS[0][1];
  const stopEx = arrayExporter();
  const stopped = await cherryPick(r.url, { ref: 'refs/heads/main', commit: r.main, committer: c, empty: 'stop' }, opts(new Tracer({ exporter: stopEx })));
  assert.equal(stopped.outcome, 'empty');
  const stopRoot = stopEx.lines.flatMap(flattenLine).find(s => s.name === 'git.cherry_pick');
  assert.equal(stopRoot.attrs['git.cherry_pick.empty'], 'stop');
  assert.equal(stopRoot.attrs['git.cherry_pick.outcome'], 'empty');
  assert.equal(stopRoot.attrs['git.cherry_pick.new'], undefined);
  const keepEx = arrayExporter();
  const kept = await cherryPick(r.url, { ref: 'refs/heads/main', commit: r.main, committer: c, empty: 'keep' }, opts(new Tracer({ exporter: keepEx })));
  assert.equal(kept.outcome, 'kept_empty');
  const keepRoot = keepEx.lines.flatMap(flattenLine).find(s => s.name === 'git.cherry_pick');
  assert.equal(keepRoot.attrs['git.cherry_pick.empty'], 'keep');
  assert.equal(keepRoot.attrs['git.cherry_pick.outcome'], 'kept_empty');
  assert.equal(keepRoot.attrs['git.cherry_pick.new'], kept.oid);
  assert.equal(keepRoot.attrs['git.cherry_pick.tree'], kept.tree);
  assert.equal(typeof keepRoot.attrs['git.cherry_pick.push.bytes'], 'number');
  assert.equal(typeof keepRoot.attrs['git.cherry_pick.trees.fetched'], 'number');
});
