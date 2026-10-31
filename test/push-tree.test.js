// pushTree: a whole tree as one commit, judged by git. Every push lands on `git http-backend` with receive.fsckObjects;
// after each one: `git fsck --strict` on the server, the tree oid against git's own index (update-index --cacheinfo +
// write-tree over the same files), `git ls-tree -r` modes and oids, and a `git clone` whose checkout is compared byte
// for byte and mode for mode. A repeat push must carry exactly the objects `git rev-list --objects new ^old` names.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, symlinkSync, chmodSync, readFileSync, lstatSync, readlinkSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, commitFiles, fsckProblemsOf, fsckProblems } from './server.js';
import { startProxy } from './proxy.js';
import { pushTree, buildTree, fileEntries, selectObjects } from '../src/tree.js';
import { filesFromDir, pushDir } from '../src/tree-node.js';
import { encodeTree } from '../src/objects.js';
import { concat, te } from '../src/bytes.js';
import { fromHex } from '../src/sha1.js';
import { withLimits } from '../src/limits.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';

let root, cleanup, srv, n = 0;
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv.close(); cleanup(); });

const A = { name: 'deploy', email: 'deploy@x' };
const GITLINK = 'c0ffee'.padEnd(40, '0');
const traced = () => { const ex = arrayExporter(); return { ex, tracer: new Tracer({ exporter: ex }), spans: () => ex.lines.flatMap(flattenLine) }; };
const emptyRepo = () => { const name = `t${n++}`; const bare = makeBareRepo(root, name); return { name, bare, url: `${srv.url}/${name}.git` }; };
// counts requests per service; `before(kind)` runs ahead of each one (the CAS tests move the ref there)
const counting = (hook = () => {}) => {
  const c = { 'git-upload-pack': 0, 'git-receive-pack': 0 };
  const f = async (url, init) => { const kind = String(url).split('/').pop(); c[kind] = (c[kind] ?? 0) + 1; await hook(kind, c); return fetch(url, init); };
  return { c, f };
};
const fsck = bare => assert.deepEqual(fsckProblems(bare), []);

// deterministic incompressible-ish content (an LCG's hex), so pack sizes are stable across runs
const text = (seed, len) => { let x = (seed + 1) >>> 0, s = ''; while (s.length < len) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; s += x.toString(16).padStart(8, '0'); } return s.slice(0, len) + '\n'; };
// 200 files over 20 directories, plus the shapes that bite: exec bit, symlink, gitlink, dir-vs-file sort order, unicode
function site() {
  const files = {};
  for (let d = 0; d < 20; d++) for (let f = 0; f < 10; f++) files[`d${String(d).padStart(2, '0')}/f${f}.txt`] = text(d * 100 + f, 1024);
  Object.assign(files, {
    'bin/run.sh': { data: '#!/bin/sh\necho hi\n', mode: '100755' },
    'link': { mode: '120000', data: 'd00/f0.txt' },
    'vendor/lib': { mode: '160000', oid: GITLINK },
    'a.b': 'x\n', 'a/x': 'y\n', 'a0': 'z\n', 'a-b/c': 'w\n',
    'ünï/cödé.txt': 'unicode\n',
  });
  return files;
}
// path → { mode, oid } for the files, as `git ls-tree -r` reports them
const expected = files => new Map(fileEntries(files).map(e => [e.path, { mode: e.mode, oid: e.oid }]));
const lsTree = (bare, rev) => new Map(git(bare, ['-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', '--full-tree', rev]).split('\0').filter(Boolean).map(l => { const [meta, path] = l.split('\t'); const [mode, , oid] = meta.split(' '); return [path, { mode: mode.replace(/^0/, ''), oid }]; }));
// git's tree for the same files: its own index, built entry by entry, then write-tree
function gitWriteTree(files) {
  const dir = join(root, `wt${n++}`); git(root, ['init', '-q', dir]);
  for (const e of fileEntries(files)) {
    const oid = e.mode === '160000' ? e.oid : gitBuf(dir, ['hash-object', '-w', '--stdin'], Buffer.from(e.data)).toString().trim();
    git(dir, ['update-index', '--add', '--cacheinfo', `${e.mode},${oid},${e.path}`]);
  }
  return git(dir, ['write-tree']).trim();
}
// clone and compare the checkout with the files: bytes, the exec bit, symlink targets, nothing extra
function cloneMatches(bare, files) {
  const dir = join(root, `c${n++}`); git(root, ['clone', '-q', bare, dir]);
  const seen = new Set();
  const walk = rel => { for (const name of readdirSync(join(dir, rel))) { if (name === '.git') continue; const p = rel ? `${rel}/${name}` : name; const st = lstatSync(join(dir, p)); if (st.isDirectory() && !st.isSymbolicLink()) { if (readdirSync(join(dir, p)).length === 0) seen.add(p); else walk(p); } else seen.add(p); } };
  walk('');
  for (const e of fileEntries(files)) {
    const full = join(dir, e.path);
    assert.ok(seen.has(e.path), `${e.path} missing from the checkout`);
    if (e.mode === '160000') { assert.ok(lstatSync(full).isDirectory(), `${e.path}: a gitlink checks out as an empty directory`); continue; }
    if (e.mode === '120000') { assert.ok(lstatSync(full).isSymbolicLink(), `${e.path} is a symlink`); assert.equal(readlinkSync(full), Buffer.from(e.data).toString(), e.path); continue; }
    assert.deepEqual(new Uint8Array(readFileSync(full)), e.data, `${e.path} bytes`);
    assert.equal(!!(lstatSync(full).mode & 0o100), e.mode === '100755', `${e.path} exec bit`);
  }
  assert.equal(seen.size, fileEntries(files).length, `checkout has exactly the files: ${[...seen].filter(p => !(p in files)).join(', ')}`);
}
const receivePack = spans => spans.filter(s => s.name === 'git.receive-pack');

test('first push creates the ref: tree == git write-tree, ls-tree modes/oids, fsck --strict, clone matches', async () => {
  const r = emptyRepo(), files = site(), t = traced();
  const res = await pushTree(r.url, { ref: 'refs/heads/main', files, author: A, message: 'deploy 1' }, { tracer: t.tracer, verify: true });
  assert.equal(res.oldCommit, null); assert.equal(res.attempt, 0); assert.equal(res.noop, false);
  assert.equal(git(r.bare, ['rev-parse', 'refs/heads/main']).trim(), res.newCommit);
  assert.equal(git(r.bare, ['rev-list', '--count', 'main']).trim(), '1', 'a root commit');
  assert.equal(res.newTree, gitWriteTree(files), 'tree oid equals git\'s index for the same files');
  assert.deepEqual(lsTree(r.bare, 'main'), expected(files));
  fsck(r.bare); cloneMatches(r.bare, files);
  const rp = receivePack(t.spans())[0].attrs;
  // every blob (200 + 6 regular + 1 symlink, none shared) + every tree (20 + bin a a-b vendor ünï + root) + the commit
  assert.equal(rp['git.push.pack.objects'], 207 + 26 + 1);
  assert.equal(res.objects.sent, 234); assert.equal(res.objects.treeDeltas, 0);
  console.log(`  push 1 (create): ${rp['git.push.pack.objects']} objects, ${rp['git.push.pack.bytes']} B pack`);
  // span names follow the written convention (test/pure.test.js), and the root carries its outcome
  const NAME = /^(git\.(upload-pack|receive-pack)( [a-z-]+)?|git\.[a-z_]+(\.[a-z_]+)?|ssh\.[a-z]+)$/;
  for (const s of t.spans()) assert.match(s.name, NAME);
  assert.equal(t.spans().find(s => s.name === 'git.push_tree').attrs['git.push_tree.outcome'], 'ok');
});

test('repeat pushes are thin: only changed blobs and the trees on their paths (as REF_DELTAs), == rev-list --objects new ^old', async () => {
  const r = emptyRepo(), files = site();
  const first = await pushTree(r.url, { files, author: A, message: 'deploy 1' }, { tracer: new Tracer() });
  const t1 = traced(); const { c, f } = counting(); const cache = new Map();
  // change one file, add one, delete one, in three different directories
  const next = { ...files, 'd07/f3.txt': text(9999, 1024), 'd11/new.txt': 'new\n' }; delete next['d03/f5.txt'];
  const second = await pushTree(r.url, { files: next, author: A, message: 'deploy 2' }, { tracer: t1.tracer, fetchImpl: f, cache });
  assert.equal(second.oldCommit, first.newCommit);
  assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), second.newCommit);
  const want = git(r.bare, ['rev-list', '--objects', '--no-object-names', second.newCommit, `^${first.newCommit}`]).trim().split('\n');
  const rp = receivePack(t1.spans())[0].attrs;
  assert.equal(want.length, 7, 'commit + root, d03, d07, d11 trees + 2 blobs');
  assert.equal(rp['git.push.pack.objects'], want.length, `pack carries exactly git's new objects (${want.length})`);
  assert.equal(second.objects.sentBlobs, 2); assert.equal(second.objects.sentTrees, 4); assert.equal(second.objects.treeDeltas, 4, 'every changed tree is a delta against the one it replaces');
  assert.equal(second.treesRead, 4, 'the parent\'s root and the three changed directories, nothing else');
  assert.equal(c['git-upload-pack'], 1 + 1 + 4, 'ls-refs, the parent commit, four trees');
  assert.deepEqual(lsTree(r.bare, 'main'), expected(next)); assert.equal(second.newTree, gitWriteTree(next));
  fsck(r.bare); cloneMatches(r.bare, next);

  // push 3, a one-byte change, with the head hint and push 2's cache: no tree is fetched, the commit fetch overlaps ls-refs
  const third = { ...next, 'd19/f9.txt': next['d19/f9.txt'].replace(/^./, '#') };
  const t2 = traced(); const warm = counting();
  const res3 = await pushTree(r.url, { files: third, author: A, message: 'deploy 3' }, { tracer: t2.tracer, cache, head: second.newCommit, fetchImpl: warm.f });
  assert.equal(res3.hint, 'used'); assert.equal(res3.oldCommit, second.newCommit);
  assert.equal(res3.treesRead, 0, 'root and d19 come from the cache');
  assert.equal(warm.c['git-upload-pack'], 2, 'ls-refs and the hinted commit, concurrently');
  const rp3 = receivePack(t2.spans())[0].attrs;
  assert.equal(rp3['git.push.pack.objects'], 4, 'commit + root + d19 + one blob');
  console.log(`  push 2 (3 changes, cold): ${rp['git.push.pack.objects']} objects, ${rp['git.push.pack.bytes']} B pack, ${c['git-upload-pack']} upload-pack requests; push 3 (1 byte, hint + cache): ${rp3['git.push.pack.objects']} objects, ${rp3['git.push.pack.bytes']} B pack, ${warm.c['git-upload-pack']} upload-pack requests`);
  assert.ok(rp['git.push.pack.bytes'] < 2_000, `push 2 pack ${rp['git.push.pack.bytes']} B`);
  fsck(r.bare); cloneMatches(r.bare, third);

  // push 4 restores push 1's files. Only the parent's trees are consulted: the three blobs push 1 had and push 3 does not
  // (d03/f5, d07/f3, d19/f9) are on the server in older history but are sent again. Correct, not minimal.
  const back = await pushTree(r.url, { files, author: A, message: 'revert to 1' }, { tracer: new Tracer() });
  assert.equal(back.newTree, first.newTree, 'same files, same tree as push 1');
  assert.equal(back.objects.sentBlobs, 3); assert.equal(back.objects.sentTrees, 5, 'root, d03, d07, d11, d19');
  fsck(r.bare);
});

test('identical files: noop, no receive-pack; base ≠ ref with identical files still creates the branch', async () => {
  const r = emptyRepo(), files = { 'a.txt': 'a\n' };
  const first = await pushTree(r.url, { files, author: A, message: 'one' }, { tracer: new Tracer() });
  const t = traced();
  const again = await pushTree(r.url, { files, author: A, message: 'two' }, { tracer: t.tracer });
  assert.equal(again.noop, true); assert.equal(again.newCommit, first.newCommit);
  assert.equal(receivePack(t.spans()).length, 0);
  assert.equal(t.spans().find(s => s.name === 'git.push_tree').attrs['git.push_tree.outcome'], 'noop');
  const branch = await pushTree(r.url, { ref: 'refs/heads/preview', base: 'refs/heads/main', files, author: A, message: 'preview' }, { tracer: new Tracer() });
  assert.equal(branch.objects.sent, 1, 'only the commit: the server has the tree');
  assert.equal(git(r.bare, ['rev-parse', 'preview^']).trim(), first.newCommit);
  fsck(r.bare);
  // create is a CAS on "absent": a second create of the same branch is cas_conflict on both attempts
  await assert.rejects(pushTree(r.url, { ref: 'refs/heads/preview', base: 'refs/heads/main', files: { 'b.txt': 'b' }, author: A, message: 'again' }, { tracer: new Tracer() }), e => e.code === 'cas_conflict' && e.attempt === 1);
  await assert.rejects(pushTree(r.url, { ref: 'refs/heads/x', base: 'refs/heads/nope', files, author: A, message: 'm' }, { tracer: new Tracer() }), e => e.code === 'not_found');
});

test('cas_conflict: a ref moved between ls-refs and receive-pack is redone once from a fresh head; strictHead is not', async () => {
  const r = emptyRepo();
  const first = await pushTree(r.url, { files: { 'a.txt': 'one\n' }, author: A, message: 'one' }, { tracer: new Tracer() });
  const work = join(root, `w${n++}`); git(root, ['clone', '-q', r.bare, work]);
  let moved = null;
  const { f } = counting(kind => { if (kind === 'git-receive-pack' && moved === null) moved = commitFiles(work, r.bare, { 'theirs.txt': 'theirs\n' }, 'competitor'); });
  const t = traced();
  const res = await pushTree(r.url, { files: { 'a.txt': 'ours\n' }, author: A, message: 'ours' }, { tracer: t.tracer, fetchImpl: f, verify: true });
  assert.equal(res.attempt, 1, 'retried once');
  assert.equal(res.oldCommit, moved, 'the retry\'s parent is the commit that won the race');
  assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), res.newCommit);
  assert.deepEqual([...lsTree(r.bare, 'main').keys()], ['a.txt'], 'the tree is exactly `files`; the competitor stays in history');
  assert.equal(git(r.bare, ['rev-parse', 'main~2']).trim(), first.newCommit);
  const roots = t.spans().filter(s => s.name === 'git.push_tree');
  assert.deepEqual(roots.map(s => s.attrs['git.push_tree.outcome']), ['cas_conflict', 'ok']);
  assert.equal(receivePack(t.spans()).map(s => s.attrs['git.push.ok']).join(), 'false,true');
  fsck(r.bare);

  // strictHead: the hint is a precondition. Stale before the push → cas_conflict with no receive-pack; lost race → not retried.
  const stale = counting();
  await assert.rejects(pushTree(r.url, { files: { 'a.txt': 'x\n' }, author: A, message: 'x' }, { tracer: new Tracer(), head: first.newCommit, strictHead: true, fetchImpl: stale.f }), e => e.code === 'cas_conflict' && e.actual === res.newCommit);
  assert.equal(stale.c['git-receive-pack'], 0);
  let moved2 = null;
  const race = counting(kind => { if (kind === 'git-receive-pack' && moved2 === null) { git(work, ['pull', '-q', '--ff-only', r.bare, 'main']); moved2 = commitFiles(work, r.bare, { 'again.txt': 'x\n' }, 'competitor 2'); } });
  await assert.rejects(pushTree(r.url, { files: { 'a.txt': 'y\n' }, author: A, message: 'y' }, { tracer: new Tracer(), head: res.newCommit, strictHead: true, fetchImpl: race.f }), e => e.code === 'cas_conflict' && e.attempt === 0);
  assert.equal(race.c['git-receive-pack'], 1);
  assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), moved2);
  fsck(r.bare);
});

test('after an acknowledged push, a failed read-back is ambiguous and the ref is at our commit', async () => {
  const r = emptyRepo();
  const { f } = counting((kind, c) => { if (kind === 'git-upload-pack' && c['git-receive-pack'] > 0) throw new TypeError('fetch failed'); });
  const err = await pushTree(r.url, { files: { 'a.txt': 'a\n' }, author: A, message: 'm' }, { tracer: new Tracer(), fetchImpl: f, verify: true }).catch(e => e);
  assert.equal(err.code, 'ambiguous'); assert.equal(err.original, 'network');
  assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), err.expected, 'the push landed');
  fsck(r.bare);
});

test('a pack over maxPackBytes is refused with its measured size before receive-pack is contacted', async () => {
  const r = emptyRepo();
  const files = {}; for (let i = 0; i < 100; i++) files[`f${i}.bin`] = text(i, 2048);
  const t = traced(); const { c, f } = counting();
  const max = 64 * 1024;
  const err = await pushTree(r.url, { files, author: A, message: 'big' }, { tracer: t.tracer, fetchImpl: f, limits: withLimits({ maxPackBytes: max }) }).catch(e => e);
  assert.equal(err.code, 'limit_exceeded'); assert.equal(err.what, 'push pack bytes'); assert.equal(err.max, max);
  assert.ok(err.got > max, `measured ${err.got}`);
  assert.equal(c['git-receive-pack'], 0, 'nothing uploaded');
  assert.equal(receivePack(t.spans())[0].attrs['git.push.pack.bytes'], err.got, 'the span records the size that was refused');
  assert.equal(git(r.bare, ['for-each-ref']).trim(), '', 'ref not created');
  // the same files under the default cap land
  await pushTree(r.url, { files, author: A, message: 'big' }, { tracer: new Tracer() }); fsck(r.bare);
});

test('duplicate names: encodeTree refuses them (git fsck duplicateEntries); pushTree refuses before any I/O; case-only twins are git-valid', async () => {
  const oid = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
  assert.throws(() => encodeTree([{ mode: '100644', name: 'a', oid }, { mode: '100644', name: 'a', oid }]), e => e.code === 'bad_request' && e.entry === 'a');
  assert.throws(() => encodeTree([{ mode: '100644', name: 'a', oid }, { mode: '100644', name: 'a.b', oid }, { mode: '40000', name: 'a', oid: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' }]), e => e.code === 'bad_request' && e.entry === 'a', 'file a and dir a are not neighbours in tree order');
  // git's verdict on the bytes encodeTree no longer produces: a file `a` twice, and a file `a` beside a directory `a`
  const dir = join(root, `dup${n++}`); git(root, ['init', '-q', '--bare', dir]);
  const entry = (mode, name, o) => concat([te.encode(`${mode} ${name}\0`), fromHex(o)]);
  gitBuf(dir, ['hash-object', '-w', '--stdin'], Buffer.alloc(0));
  gitBuf(dir, ['hash-object', '-w', '-t', 'tree', '--stdin'], Buffer.alloc(0));
  for (const bytes of [concat([entry('100644', 'a', oid), entry('100644', 'a', oid)]), concat([entry('100644', 'a', oid), entry('100644', 'a.b', oid), entry('40000', 'a', '4b825dc642cb6eb9a060e54bf8d69288fbee4904')])]) {
    const tree = gitBuf(dir, ['hash-object', '--literally', '-w', '-t', 'tree', '--stdin'], Buffer.from(bytes)).toString().trim();
    const out = fsckProblemsOf(dir, tree);
    assert.ok(out.some(l => /^error in tree [0-9a-f]{40}: duplicateEntries: /.test(l)), `git fsck rejects it: ${out.join(' | ')}`);
  }
  // pushTree: the same mistakes in `files` are bad_request before a request is made
  const { c, f } = counting();
  const r = emptyRepo();
  const bad = [
    { 'a': 'x', 'a/b': 'y' },
    [{ path: 'a/b', data: 'x' }, { path: 'a', data: 'y' }],
    [{ path: 'p', data: 'x' }, { path: 'p', data: 'y' }],
    { 'x': { mode: '100600', data: 'x' } },
    { 'x': { mode: '160000', oid: 'nope' } },
    { 'x': { mode: '120000', data: '' } },
    { '.git/config': 'x' }, { 'a//b': 'x' }, { 'a/../b': 'x' },
  ];
  for (const files of bad) await assert.rejects(pushTree(r.url, { files, author: A, message: 'm' }, { tracer: new Tracer(), fetchImpl: f }), e => e.code === 'bad_request', JSON.stringify(files));
  assert.deepEqual(c, { 'git-upload-pack': 0, 'git-receive-pack': 0 });
  // README and readme are two names to git: fsck --strict accepts the tree; they collide only on a case-insensitive checkout
  const res = await pushTree(r.url, { files: { README: 'upper\n', readme: 'lower\n' }, author: A, message: 'case' }, { tracer: new Tracer() });
  fsck(r.bare);
  assert.deepEqual([...lsTree(r.bare, res.newCommit).keys()].sort(), ['README', 'readme']);
});

test('the pure steps: buildTree equals git for edge orders; selectObjects skips what the server has', () => {
  const files = { 'a/x': '1', 'a.b': '2', 'a0': '3', 'a-b/c': '4', 'b': { mode: '120000', data: 'a/x' } };
  assert.equal(buildTree(fileEntries(files)).root, gitWriteTree(files));
  assert.equal(buildTree([]).root, '4b825dc642cb6eb9a060e54bf8d69288fbee4904', 'no files is git\'s empty tree');
  assert.equal(buildTree(fileEntries(new Map([['m', 'x']]))).root, buildTree(fileEntries({ m: 'x' })).root, 'a Map is the object form');
  const built = buildTree(fileEntries({ 'x/1': 'same', 'y/1': 'same', 'z': 'other' }));
  const all = selectObjects(built);
  assert.equal(all.blobs.length, 2, 'one blob at two paths is sent once'); assert.equal(all.trees.length, 2, 'x and y are one tree: root + that tree');
  const none = selectObjects(built, { have: new Set([built.root]) });
  assert.equal(none.trees.length + none.blobs.length, 0);
  assert.throws(() => fileEntries({ a: 'x' }, withLimits({ maxObjectSize: 0 })), e => e.code === 'limit_exceeded' && e.what === 'object size');
  assert.throws(() => fileEntries({ a: 'x', b: 'y' }, withLimits({ maxPackObjects: 1 })), e => e.code === 'limit_exceeded' && e.what === 'files');
  assert.throws(() => buildTree(fileEntries({ a: 'x', b: 'y' }), withLimits({ maxTreeEntries: 1 })), e => e.code === 'limit_exceeded' && e.what === 'tree entries');
  assert.throws(() => fileEntries(null), e => e.code === 'bad_request');
});

test('Artifacts-like host (blob:none only): the repeat push reads the parent\'s trees from one wide fetch', async () => {
  const r = emptyRepo(), files = site();
  const filterOf = body => /filter ([^\n]+)\n/.exec(Buffer.from(body).toString('latin1'))?.[1] ?? null;
  const proxy = await startProxy(srv.url, ctx => (ctx.stage === 'fetch' && filterOf(ctx.reqBody) && filterOf(ctx.reqBody) !== 'blob:none' ? { type: 'status', status: 400, contentType: 'text/plain; charset=utf-8', body: 'Unsupported Git fetch filter; only blob:none is supported.' } : { type: 'pass' }));
  try {
    const url = `${proxy.url}/${r.name}.git`;
    await pushTree(url, { files, author: A, message: 'one' }, { tracer: new Tracer() });
    const next = { ...files, 'd07/f3.txt': 'changed\n' };
    const t = traced(), quirks = {};
    const res = await pushTree(url, { files: next, author: A, message: 'two' }, { tracer: t.tracer, quirks });
    assert.equal(quirks.treeFilter, 'blob:none');
    const fetches = t.spans().filter(s => s.name === 'git.upload-pack fetch');
    assert.equal(fetches.filter(s => s.attrs['git.fetch.filter.fallback'] === 'blob:none').length, 1, 'one blob:none fetch');
    assert.equal(res.treesRead, 2, 'root and d07, both answered from the harvest');
    assert.equal(receivePack(t.spans())[0].attrs['git.push.pack.objects'], 4);
    fsck(r.bare); cloneMatches(r.bare, next);
  } finally { await proxy.close(); }
});

test('filesFromDir/pushDir (Node): exec bit, symlinks as 120000, nested dirs, .git and empty dirs skipped, filter; FIFO refused', async () => {
  const src = join(root, `src${n++}`);
  const put = (p, data, mode) => { mkdirSync(join(src, p, '..'), { recursive: true }); writeFileSync(join(src, p), data); if (mode) chmodSync(join(src, p), mode); };
  put('index.html', '<h1>hi</h1>\n'); put('assets/app.js', 'console.log(1)\n'); put('bin/build', '#!/bin/sh\n', 0o755);
  put('deep/a/b/c/d.txt', 'deep\n'); put('.git/config', 'not ours\n'); put('node_modules/x/index.js', 'skip me\n');
  put('owner-noexec', 'x\n', 0o644); put('group-exec-only', 'x\n', 0o654);
  mkdirSync(join(src, 'empty'));
  symlinkSync('assets/app.js', join(src, 'app-link')); symlinkSync('../index.html', join(src, 'assets/up'));
  symlinkSync('does/not/exist', join(src, 'dangling'));
  const filter = path => !path.startsWith('node_modules');
  const files = await filesFromDir(src, { filter });
  const byPath = new Map(files.map(e => [e.path, e]));
  assert.deepEqual([...byPath.keys()].sort(), ['app-link', 'assets/app.js', 'assets/up', 'bin/build', 'dangling', 'deep/a/b/c/d.txt', 'group-exec-only', 'index.html', 'owner-noexec']);
  assert.equal(byPath.get('bin/build').mode, '100755'); assert.equal(byPath.get('group-exec-only').mode, '100644', 'git looks at the owner\'s execute bit only');
  assert.equal(byPath.get('app-link').mode, '120000'); assert.equal(Buffer.from(byPath.get('dangling').data).toString(), 'does/not/exist');
  const r = emptyRepo();
  const res = await pushDir(r.url, { dir: src, filter, author: A, message: 'dir' }, { tracer: new Tracer() });
  assert.equal(res.newTree, gitWriteTree(files));
  // git's own reading of the same directory: `git add -A` in a copy (minus node_modules) writes the same tree
  const wt = join(root, `addA${n++}`); execFileSync('cp', ['-R', src, wt]); execFileSync('rm', ['-rf', join(wt, '.git'), join(wt, 'node_modules')]);
  git(wt, ['init', '-q']); git(wt, ['add', '-A']);
  assert.equal(git(wt, ['write-tree']).trim(), res.newTree, 'same tree as git add -A');
  fsck(r.bare); cloneMatches(r.bare, Object.fromEntries(files.map(e => [e.path, { mode: e.mode, data: e.data }])));
  execFileSync('mkfifo', [join(src, 'pipe')]);
  await assert.rejects(filesFromDir(src), e => e.code === 'bad_request' && e.path === 'pipe');
  await assert.rejects(filesFromDir(src, { limits: withLimits({ maxObjectSize: 8 }), filter: p => p !== 'pipe' }), e => e.code === 'limit_exceeded' && e.what === 'object size');
});
