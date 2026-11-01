// Every public entry that talks to a remote, with the tracer omitted and with one passed (issue #137).
// Each cell's answer is git's: reads against `git rev-parse` / `show` / `ls-tree` / `rev-list`, writes against
// `write-tree`, `merge-tree --write-tree`, `rebase`, `cherry-pick` and `revert` on a clone of the same history.
// A frozen clock stamps the commit and zeroes the HTTP durations; an explicit time wins over the clock.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, tmpRoot, makeBareRepo, startGitServer, commitFiles, fsckProblems } from './server.js';
import { readCommit, readFile, listTree } from '../src/read.js';
import { readLog } from '../src/log.js';
import { editFile } from '../src/edit.js';
import { pushTree } from '../src/tree.js';
import { checkoutTree } from '../src/checkout.js';
import { mergeBranch, fastForward, deleteBranch } from '../src/merge.js';
import { rebaseBranch, cherryPick, revertCommit, pickCommit } from '../src/rebase.js';
import { discover } from '../src/discover.js';
import { GitHttp, lsRefs } from '../src/client.js';
import { lsRefs as lsRefsWire } from '../src/lsrefs.js';
import { operation } from '../src/operation.js';
import { createTransport } from '../src/http.js';
import { freshStorage } from '../src/capabilities.js';
import { TYPE } from '../src/objects.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';

const MODES = ['omit', 'with'];
const ENTRIES = [
  'readCommit', 'readFile', 'listTree', 'readLog', 'checkoutTree',
  'editFile', 'pushTree', 'mergeBranch', 'rebaseBranch', 'cherryPick', 'revertCommit', 'pickCommit',
  'fastForward', 'deleteBranch', 'discover', 'lsRefs', 'GitHttp.lsRefs', 'GitHttp.discover', 'operation',
];
const AUTHOR = { name: 'Cap', email: 'cap@x', tz: '+0000' };
const TIME = 1_700_000_000;
const FROZEN = 1_700_000_000_000;

let root, cleanup, srv, bare, url, want, mainOid;

const text = async stream => Buffer.from(await new Response(stream).arrayBuffer()).toString();
const oidOf = (refs, name) => { const row = refs.get(name); return typeof row === 'object' && row !== null ? row.oid : ''; };
const spansOf = ex => ex.lines.flatMap(flattenLine);
const ref = (entry, mode) => `refs/heads/${entry}-${mode}`;

function tracing(mode) {
  if (mode === 'omit') return { opts: {} };
  const ex = arrayExporter();
  return { opts: { tracer: new Tracer({ exporter: ex }) }, ex };
}
function assertSpan(mode, pack, name) {
  if (mode !== 'with') return;
  const names = spansOf(pack.ex).map(s => s.name);
  assert.ok(names.includes(name), `${name} exported, saw ${names.join(',')}`);
}

before(async () => {
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  bare = makeBareRepo(root, 'cap');
  url = `${srv.url}/cap.git`;
  const work = join(root, 'work');
  mkdirSync(work);
  git(work, ['init', '-q', '-b', 'main']);
  const first = commitFiles(work, bare, { 'README.md': 'hello\n' }, 'one');
  git(work, ['checkout', '-q', '-b', 'side']);
  writeFileSync(join(work, 'README.md'), 'side\n');
  git(work, ['add', 'README.md']);
  git(work, ['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-q', '-m', 'side']);
  git(work, ['push', '-q', bare, 'HEAD:refs/heads/side']);
  git(work, ['checkout', '-q', 'main']);
  commitFiles(work, bare, { 'OTHER.txt': 'other\n' }, 'two');
  mainOid = git(bare, ['rev-parse', 'refs/heads/main']).trim();
  for (const mode of MODES) {
    git(bare, ['branch', `editFile-${mode}`, 'main']);
    git(bare, ['branch', `mergeBranch-${mode}`, 'main']);
    git(bare, ['branch', `rebaseBranch-${mode}`, 'side']);
    git(bare, ['branch', `cherryPick-${mode}`, 'main']);
    git(bare, ['branch', `revertCommit-${mode}`, 'main']);
    git(bare, ['branch', `pickCommit-${mode}`, 'main']);
    git(bare, ['branch', `fastForward-${mode}`, first]);
    git(bare, ['branch', `deleteBranch-${mode}`, 'main']);
  }
  git(bare, ['branch', 'clock-edit', 'main']);
  git(bare, ['branch', 'clock-push', 'main']);
  git(bare, ['branch', 'clock-explicit', 'main']);
  git(bare, ['branch', 'clock-merge', 'main']);
  git(bare, ['branch', 'clock-rebase', 'side']);
  const wt = join(root, 'oracle');
  git(root, ['clone', '-q', bare, wt]);
  git(wt, ['config', 'user.name', 'Cap']);
  git(wt, ['config', 'user.email', 'cap@x']);
  writeFileSync(join(wt, 'README.md'), 'edited\n');
  git(wt, ['add', 'README.md']);
  const editTree = git(wt, ['write-tree']).trim();
  git(wt, ['restore', '--source=HEAD', '--staged', '--worktree', 'README.md']);
  const noteBlob = git(bare, ['hash-object', '-w', '--stdin'], { input: 'note\n' }).trim();
  const noteTree = git(bare, ['mktree'], { input: `100644 blob ${noteBlob}\tNOTE.txt\n` }).trim();
  const mergeTree = git(wt, ['merge-tree', '--write-tree', 'main', 'origin/side']).trim().split('\n')[0];
  git(wt, ['checkout', '-q', '-b', 'reb', 'origin/side']);
  git(wt, ['rebase', '-q', 'main']);
  const rebaseTree = git(wt, ['rev-parse', 'HEAD^{tree}']).trim();
  git(wt, ['checkout', '-q', '-B', 'cp', 'main']);
  git(wt, ['cherry-pick', 'origin/side']);
  const cherryTree = git(wt, ['rev-parse', 'HEAD^{tree}']).trim();
  git(wt, ['checkout', '-q', '-B', 'rv', 'main']);
  git(wt, ['revert', '--no-edit', 'HEAD']);
  const revertTree = git(wt, ['rev-parse', 'HEAD^{tree}']).trim();
  const ls = git(bare, ['ls-tree', 'main']).trim().split('\n').map(l => {
    const [meta, name] = l.split('\t');
    const [mode, type, oid] = meta.split(' ');
    return `${mode} ${type} ${oid} ${name}`;
  }).sort();
  want = {
    mainOid, first, editTree, noteTree, mergeTree, rebaseTree, cherryTree, revertTree, ls,
    readme: git(bare, ['show', 'main:README.md']),
    other: git(bare, ['show', 'main:OTHER.txt']),
    tree: git(bare, ['rev-parse', 'main^{tree}']).trim(),
    log: git(bare, ['rev-list', '--first-parent', '-n', '2', 'main']).trim().split('\n'),
  };
});
after(async () => { await srv.close(); cleanup(); });

async function cell(entry, mode) {
  const pack = tracing(mode);
  const { opts } = pack;
  const name = ref(entry, mode);
  if (entry === 'readCommit') {
    const r = await readCommit(url, { ref: 'refs/heads/main' }, opts);
    assert.equal(r.oid, want.mainOid);
    assert.equal(r.tree, want.tree);
    assertSpan(mode, pack, 'git.read_commit');
    return;
  }
  if (entry === 'readFile') {
    const r = await readFile(url, { ref: 'refs/heads/main', path: 'README.md' }, opts);
    assert.equal(await text(r.stream), want.readme);
    assertSpan(mode, pack, 'git.read');
    return;
  }
  if (entry === 'listTree') {
    const r = await listTree(url, { ref: 'refs/heads/main' }, opts);
    const got = r.entries.map(e => `${e.mode} ${e.type} ${e.oid} ${e.name}`).sort();
    assert.deepEqual(got, want.ls);
    assertSpan(mode, pack, 'git.ls_tree');
    return;
  }
  if (entry === 'readLog') {
    const r = await readLog(url, { ref: 'refs/heads/main', limit: 2 }, opts);
    assert.deepEqual(r.commits.map(c => c.oid), want.log);
    assertSpan(mode, pack, 'git.read_log');
    return;
  }
  if (entry === 'checkoutTree') {
    const r = await checkoutTree(url, { ref: 'refs/heads/main' }, opts);
    const got = new Map();
    for await (const f of r.files) if (f.stream) got.set(f.path, await text(f.stream));
    assert.equal(got.get('README.md'), want.readme);
    assert.equal(got.get('OTHER.txt'), want.other);
    assertSpan(mode, pack, 'git.checkout');
    return;
  }
  if (entry === 'editFile') {
    const r = await editFile(url, { ref: name, path: 'README.md', find: 'hello\n', replace: 'edited\n', author: AUTHOR, message: 'edit\n', time: TIME }, opts);
    assert.equal(r.newTree, want.editTree);
    assert.equal(git(bare, ['rev-parse', `${name}^{tree}`]).trim(), want.editTree);
    assertSpan(mode, pack, 'git.edit');
    return;
  }
  if (entry === 'pushTree') {
    const r = await pushTree(url, { ref: name, base: 'refs/heads/main', files: { 'NOTE.txt': 'note\n' }, author: AUTHOR, message: 'push\n', time: TIME }, opts);
    assert.equal(r.newTree, want.noteTree);
    assert.equal(git(bare, ['rev-parse', `${name}^{tree}`]).trim(), want.noteTree);
    assertSpan(mode, pack, 'git.push_tree');
    return;
  }
  if (entry === 'mergeBranch') {
    const r = await mergeBranch(url, { ref: name, from: 'refs/heads/side', author: AUTHOR, message: 'merge\n', time: TIME }, opts);
    assert.equal(r.outcome, 'merge');
    assert.equal(r.tree, want.mergeTree);
    assert.equal(git(bare, ['rev-parse', `${name}^{tree}`]).trim(), want.mergeTree);
    assertSpan(mode, pack, 'git.merge');
    return;
  }
  if (entry === 'rebaseBranch') {
    const r = await rebaseBranch(url, { ref: name, onto: 'refs/heads/main', committer: AUTHOR, time: TIME }, opts);
    assert.equal(r.outcome, 'rebase');
    assert.equal(git(bare, ['rev-parse', `${r.oid}^{tree}`]).trim(), want.rebaseTree);
    assertSpan(mode, pack, 'git.rebase');
    return;
  }
  if (entry === 'cherryPick') {
    const r = await cherryPick(url, { ref: name, commit: git(bare, ['rev-parse', 'refs/heads/side']).trim(), committer: AUTHOR, time: TIME }, opts);
    assert.equal(r.outcome, 'ok');
    assert.equal(r.tree, want.cherryTree);
    assertSpan(mode, pack, 'git.cherry_pick');
    return;
  }
  if (entry === 'revertCommit') {
    const r = await revertCommit(url, { ref: name, commit: want.mainOid, committer: AUTHOR, time: TIME }, opts);
    assert.equal(r.outcome, 'ok');
    assert.equal(r.tree, want.revertTree);
    assertSpan(mode, pack, 'git.revert');
    return;
  }
  if (entry === 'pickCommit') {
    const r = await pickCommit(url, { ref: name, commit: git(bare, ['rev-parse', 'refs/heads/side']).trim(), committer: AUTHOR, time: TIME }, opts);
    assert.equal(r.outcome, 'ok');
    assert.equal(r.tree, want.cherryTree);
    assertSpan(mode, pack, 'git.cherry_pick');
    return;
  }
  if (entry === 'fastForward') {
    const t = createTransport(url, opts);
    await fastForward(t, { ref: name, from: want.first, to: want.mainOid });
    assert.equal(git(bare, ['rev-parse', name]).trim(), want.mainOid);
    assertSpan(mode, pack, 'git.receive-pack');
    return;
  }
  if (entry === 'deleteBranch') {
    const t = createTransport(url, opts);
    await deleteBranch(t, { ref: name, oid: want.mainOid });
    assert.throws(() => git(bare, ['rev-parse', '--verify', name]));
    assertSpan(mode, pack, 'git.receive-pack');
    return;
  }
  if (entry === 'discover') {
    const info = await discover(createTransport(url, opts));
    assert.equal(info.version, 2);
    assert.equal(info.objectFormat, 'sha1');
    assertSpan(mode, pack, 'git.upload-pack discover');
    return;
  }
  if (entry === 'lsRefs') {
    const r = await lsRefs(createTransport(url, opts), ['refs/heads/main']);
    assert.equal(oidOf(r.refs, 'refs/heads/main'), want.mainOid);
    assertSpan(mode, pack, 'git.upload-pack ls-refs');
    return;
  }
  if (entry === 'GitHttp.lsRefs') {
    const r = await new GitHttp(url, opts).lsRefs(['refs/heads/main']);
    assert.equal(oidOf(r.refs, 'refs/heads/main'), want.mainOid);
    assertSpan(mode, pack, 'git.upload-pack ls-refs');
    return;
  }
  if (entry === 'GitHttp.discover') {
    const info = await new GitHttp(url, opts).discover();
    assert.equal(info.version, 2);
    assert.equal(info.objectFormat, 'sha1');
    assertSpan(mode, pack, 'git.upload-pack discover');
    return;
  }
  if (entry === 'operation') {
    const oid = await operation('cap', url, opts, async ({ t, outcome }) => outcome('ok', oidOf((await lsRefsWire(t, ['refs/heads/main'])).refs, 'refs/heads/main')));
    assert.equal(oid, want.mainOid);
    assertSpan(mode, pack, 'git.cap');
    return;
  }
  throw new Error(`no oracle for ${entry}`);
}

const CELLS = ENTRIES.flatMap(entry => MODES.map(mode => [entry, mode]));
test.each(CELLS)('%s with tracer %s matches git', async (entry, mode) => { await cell(entry, mode); });

test('a frozen clock stamps the commit and zeroes HTTP durations; an explicit time wins', async () => {
  const clock = { now: () => FROZEN, cpu: () => 0 };
  const ex = arrayExporter();
  const edited = await editFile(url, { ref: 'refs/heads/clock-edit', path: 'README.md', find: 'hello\n', replace: 'clock\n', author: AUTHOR, message: 'clock\n' }, { clock, tracer: new Tracer({ exporter: ex }) });
  assert.equal(git(bare, ['log', '-1', '--format=%at', 'refs/heads/clock-edit']).trim(), String(TIME));
  assert.equal(git(bare, ['log', '-1', '--format=%ct', 'refs/heads/clock-edit']).trim(), String(TIME));
  const posted = spansOf(ex).find(s => typeof s.attrs['http.response.duration_ms'] === 'number');
  assert.equal(Number(posted.attrs['http.response.duration_ms']), 0);
  assert.equal(Number(posted.attrs['http.response.ttfb_ms']), 0);
  assert.equal(edited.newCommit.length, 40);
  await editFile(url, { ref: 'refs/heads/clock-explicit', path: 'README.md', find: 'hello\n', replace: 'pin\n', author: AUTHOR, message: 'pin\n', time: 1_600_000_000 }, { clock });
  assert.equal(git(bare, ['log', '-1', '--format=%at', 'refs/heads/clock-explicit']).trim(), '1600000000');
  await pushTree(url, { ref: 'refs/heads/clock-push', files: { 'NOTE.txt': 'note\n' }, author: AUTHOR, message: 'push\n' }, { clock });
  assert.equal(git(bare, ['log', '-1', '--format=%at', 'refs/heads/clock-push']).trim(), String(TIME));
  await mergeBranch(url, { ref: 'refs/heads/clock-merge', from: 'refs/heads/side', author: AUTHOR, message: 'merge\n' }, { clock });
  assert.equal(git(bare, ['log', '-1', '--format=%at', 'refs/heads/clock-merge']).trim(), String(TIME));
  assert.equal(git(bare, ['log', '-1', '--format=%ct', 'refs/heads/clock-merge']).trim(), String(TIME));
  await rebaseBranch(url, { ref: 'refs/heads/clock-rebase', onto: 'refs/heads/main', committer: AUTHOR }, { clock });
  assert.equal(git(bare, ['log', '-1', '--format=%ct', 'refs/heads/clock-rebase']).trim(), String(TIME));
});

test('storage passed to readLog is the map the wide pack is harvested into', async () => {
  const storage = freshStorage();
  const r = await readLog(url, { ref: 'refs/heads/main', limit: 2 }, { storage, quirks: { treeFilter: 'blob:none' } });
  const held = storage.get(r.oid);
  assert.equal(typeof held === 'object' && held !== null ? held.type : 0, TYPE.COMMIT);
  assert.ok(held.data.byteLength > 0);
});

test('the bare repo fsck is clean after every cell', () => {
  assert.deepEqual(fsckProblems(bare), []);
});
