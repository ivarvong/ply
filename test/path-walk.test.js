// The requests of a path walk, exactly, against git http-backend (src/pathtrees.ts): readFile, listTree and editFile at
// path depths 1 to 8, on a first contact (nothing known of the server) and on a record that has learned the server
// takes `combine:blob:none+tree:K`; the same on a server configured as GitHub is (the filter refused), on an
// Artifacts-like one, and with the budget at 0 (the walk as it was: one tree per level). git is the oracle for every
// answer, and an edit must write the commit the per-level walk writes, byte for byte. A directory too wide for
// limits.maxPathTreesBytes is not used and the walk reads one tree per level from there; a server that substitutes a
// tree in a path-trees pack is caught by the object's own hash. The decision table itself (state × outcome, the limits a
// fetch runs under) is test/path-walk-unit.test.js.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpSync, mkdirSync } from 'node:fs';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, commitFiles, initRepo, fsckProblems } from './server.js';
import { startProxy } from './proxy.js';
import { readFile, listTree } from '../src/read.js';
import { editFile } from '../src/edit.js';
import { buildPack } from '../src/pack.js';
import { pkt, FLUSH } from '../src/pktline.js';
import { concat } from '../src/bytes.js';
import { TYPE } from '../src/objects.js';
import { LIMIT_OBJECT_OVERHEAD, LIMIT_PATH_TREES } from '../src/limits.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { unwrap, unwrapAsync } from './unwrap.js';

const filterOf = body => /filter ([^\n]+)\n/.exec(Buffer.from(body).toString('latin1'))?.[1] ?? null;
const drain = async stream => { const parts = []; for await (const c of stream) parts.push(Buffer.from(c)); return Buffer.concat(parts); };
const D1 = 'combine:blob:none+tree:1', D2 = 'combine:blob:none+tree:2';
const MAX_DEPTH = 8;
// The file at path depth n (n components): l1/l2/…/f<n>.txt, each holding MARK once; every directory has a sibling.
const pathAt = n => [...Array.from({ length: n - 1 }, (_, i) => `l${i + 1}`), `f${n}.txt`].join('/');
const dirAt = n => Array.from({ length: n }, (_, i) => `l${i + 1}`).join('/');
const FILES = {};
for (let n = 1; n <= MAX_DEPTH; n++) { FILES[pathAt(n)] = `depth ${n}: MARK\n`; FILES[`${n > 1 ? `${dirAt(n - 1)}/` : ''}side${n}/s.txt`] = `side ${n}\n`; }
const AUTHOR = { name: 'Walk', email: 'walk@example.invalid', time: 1_750_000_000, tz: '+0000' };

let root, cleanup, srv, n = 0;
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv.close(); cleanup(); });

// A repository behind a recording proxy: `seen` is every request as [stage, filter], in the order they were answered.
// `copyOf`: another repository's bare directory, copied (the same objects and the same commit).
async function repo({ config = [], fault = null, files = FILES, copyOf = null } = {}) {
  const name = `k${n++}`;
  let bare;
  if (copyOf === null) {
    bare = makeBareRepo(root, name); const work = join(root, `w${name}`); mkdirSync(work); initRepo(work);
    for (const [k, v] of config) git(bare, ['config', k, v]);
    commitFiles(work, bare, files, 'seed');
  } else {
    bare = join(root, `${name}.git`);
    cpSync(copyOf, bare, { recursive: true });
  }
  const seen = [];
  const proxy = await startProxy(srv.url, ctx => {
    if (ctx.phase === 'request') return fault ? fault(ctx) : null;
    seen.push([ctx.stage, ctx.stage === 'fetch' ? filterOf(ctx.reqBody) : null]);
    return fault ? fault(ctx) : { type: 'pass' };
  });
  return { bare, url: `${proxy.url}/${name}.git`, proxy, seen, take: () => seen.splice(0) };
}
const GITHUB_LIKE = [['uploadpackfilter.tree.maxDepth', '0'], ['uploadpackfilter.combine.allow', 'false']];
const LS = ['ls-refs', null], BLOB = ['fetch', null], PUSH = ['receive-pack', null];
const fetches = filters => filters.map(f => ['fetch', f]);
// The tree fetches of a walk of `levels` tree levels where the server takes the filter: the commit with two levels, then
// two levels per fetch, the last level alone when one is left.
const ladder = levels => { const out = [levels >= 2 ? D2 : D1]; for (let left = levels - 2; left > 0; left -= 2) out.push(left === 1 ? 'tree:0' : D1); return out; };
// ... and one object per fetch: the commit, then each level.
const perLevel = levels => Array.from({ length: levels + 1 }, () => 'tree:0');
// A first contact: the commit is asked both ways at once (the two arrive in either order), then the same walk.
const firstContact = (seen, levels) => {
  assert.deepEqual(seen.slice(1, 3).toSorted(), fetches([ladder(levels)[0], 'tree:0']).toSorted(), 'the commit, both ways at once');
  return [seen[0], ...seen.slice(3)];
};

async function read(r, path, opts) {
  const got = await unwrapAsync(readFile(r.url, { path }, { tracer: new Tracer(), ...opts }));
  assert.deepEqual(await drain(got.stream), gitBuf(r.bare, ['show', `main:${path}`]), path);
  assert.equal(got.blob, git(r.bare, ['rev-parse', `main:${path}`]).trim());
}
async function list(r, path, opts) {
  const got = await unwrapAsync(listTree(r.url, { path }, { tracer: new Tracer(), ...opts }));
  assert.deepEqual(got.entries.map(e => `${e.mode} ${e.type} ${e.oid}\t${e.name}`), git(r.bare, ['ls-tree', path === '' ? 'main' : `main:${path}`]).trim().split('\n'), path || '/');
}
// An edit that lands: the ref is the new commit, whose only change is the path, and the repository passes fsck.
async function edit(r, path, opts, replace = 'DONE') {
  const before = git(r.bare, ['rev-parse', 'main']).trim();
  const old = gitBuf(r.bare, ['show', `main:${path}`]).toString();
  const got = await unwrapAsync(editFile(r.url, { path, find: 'MARK', replace, author: AUTHOR, committer: AUTHOR, message: `edit ${path}` }, { tracer: new Tracer(), ...opts }));
  assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), got.newCommit, path);
  assert.equal(git(r.bare, ['rev-parse', 'main~1']).trim(), before, path);
  assert.equal(gitBuf(r.bare, ['show', `main:${path}`]).toString(), old.replace('MARK', replace), path);
  assert.deepEqual(git(r.bare, ['diff', '--name-only', 'main~1', 'main']).trim().split('\n'), [path]);
  assert.deepEqual(fsckProblems(r.bare), []);
  return got;
}

test('readFile, depth 1 to 8: a first contact is ls-refs, the commit both ways at once, two tree levels per fetch, the blob; a learned record drops the second commit fetch', async () => {
  const r = await repo();
  try {
    const counts = { first: [], learned: [], perLevel: [] };
    for (let depth = 1; depth <= MAX_DEPTH; depth++) {
      const path = pathAt(depth);
      // a first contact: a fresh quirks record
      await read(r, path, { quirks: {} });
      const first = r.take();
      counts.first.push(first.length);
      assert.deepEqual(firstContact(first, depth), [LS, ...fetches(ladder(depth).slice(1)), BLOB], `first contact, depth ${depth}`);
    }
    const quirks = {};
    await read(r, pathAt(1), { quirks }); r.take();
    for (let depth = 1; depth <= MAX_DEPTH; depth++) {
      await read(r, pathAt(depth), { quirks });
      const learned = r.take();
      counts.learned.push(learned.length);
      assert.deepEqual(learned, [LS, ...fetches(ladder(depth)), BLOB], `learned, depth ${depth}`);
      // the budget at 0: the walk as it was before, one object per fetch
      await read(r, pathAt(depth), { quirks, limits: { maxPathTreesBytes: 0 } });
      const narrow = r.take();
      counts.perLevel.push(narrow.length);
      assert.deepEqual(narrow, [LS, ...fetches(perLevel(depth)), BLOB], `budget 0, depth ${depth}`);
    }
    // the request counts by depth 1..8, stated (bench/compare/README.md, README "Reading without a clone")
    assert.deepEqual(counts.perLevel, [4, 5, 6, 7, 8, 9, 10, 11]);
    assert.deepEqual(counts.first, [4, 4, 5, 5, 6, 6, 7, 7]);
    assert.deepEqual(counts.learned, [3, 3, 4, 4, 5, 5, 6, 6]);
  } finally { await r.proxy.close(); }
});

test('listTree, depth 0 to 7: the listed directory is one more level of the same walk', async () => {
  const r = await repo();
  try {
    const quirks = {};
    await list(r, '', { quirks }); r.take();
    const counts = [];
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      await list(r, dirAt(depth), { quirks });
      const learned = r.take();
      counts.push(learned.length);
      assert.deepEqual(learned, [LS, ...fetches(ladder(depth + 1))], `learned, depth ${depth}`);
      await list(r, dirAt(depth), { quirks: {} });
      assert.deepEqual(firstContact(r.take(), depth + 1), [LS, ...fetches(ladder(depth + 1).slice(1))], `first contact, depth ${depth}`);
      await list(r, dirAt(depth), { quirks, limits: { maxPathTreesBytes: 0 } });
      assert.deepEqual(r.take(), [LS, ...fetches(perLevel(depth + 1))], `budget 0, depth ${depth}`);
    }
    assert.deepEqual(counts, [2, 2, 3, 3, 4, 4, 5, 5]);
  } finally { await r.proxy.close(); }
});

test('editFile, depth 1 to 8: the same walk, then the blob and the push; the commit is the one the per-level walk writes', async () => {
  // three copies of one repository: a first contact per edit, one learned record, and the budget at 0
  const first = await repo(); const learned = await repo({ copyOf: first.bare }), narrow = await repo({ copyOf: first.bare });
  try {
    const quirks = {};
    await read(learned, pathAt(1), { quirks }); learned.take();
    const counts = { first: [], learned: [], perLevel: [] };
    for (let depth = 1; depth <= MAX_DEPTH; depth++) {
      const path = pathAt(depth);
      const a = await edit(first, path, { quirks: {} });
      const seenFirst = first.take();
      counts.first.push(seenFirst.length);
      assert.deepEqual(firstContact(seenFirst, depth), [LS, ...fetches(ladder(depth).slice(1)), BLOB, PUSH], `first contact, depth ${depth}`);
      const ex = arrayExporter();
      const b = await edit(learned, path, { quirks, tracer: new Tracer({ exporter: ex }) });
      const seenLearned = learned.take();
      counts.learned.push(seenLearned.length);
      assert.deepEqual(seenLearned, [LS, ...fetches(ladder(depth)), BLOB, PUSH], `learned, depth ${depth}`);
      const exNarrow = arrayExporter();
      const c = await edit(narrow, path, { quirks: {}, limits: { maxPathTreesBytes: 0 }, tracer: new Tracer({ exporter: exNarrow }) });
      const seenNarrow = narrow.take();
      counts.perLevel.push(seenNarrow.length);
      assert.deepEqual(seenNarrow, [LS, ...fetches(perLevel(depth)), BLOB, PUSH], `budget 0, depth ${depth}`);
      // one parent, one tree, one identity and one message: the three must be one commit, with one tree and one blob
      for (const key of ['oldCommit', 'newCommit', 'oldTree', 'newTree', 'oldBlob', 'newBlob']) assert.deepEqual([a[key], b[key]], [c[key], c[key]], `${key}, depth ${depth}`);
      // what the edit counts as held (mem.alloc.object.*) is the commit and the path's trees, as git sizes them, on both
      // walks: the trees a two-level fetch brought beside the path's are in the transport's harvest, not in this count
      const sizeOf = spec => Number(git(narrow.bare, ['cat-file', '-s', spec]).trim());
      const onPath = [c.oldCommit, `${c.oldCommit}^{tree}`, ...Array.from({ length: depth - 1 }, (_, i) => `${c.oldCommit}:${dirAt(i + 1)}`)];
      for (const [name, lines] of [['learned', ex.lines], ['budget 0', exNarrow.lines]]) {
        const attrs = lines.flatMap(flattenLine).find(sp => sp.name === 'git.edit').attrs;
        assert.equal(attrs['mem.alloc.object.count'], 1 + depth, `${name}: the commit and ${depth} trees, depth ${depth}`);
        assert.equal(attrs['mem.alloc.object.bytes'], onPath.reduce((sum, spec) => sum + sizeOf(spec), 0), `${name}: their bytes, depth ${depth}`);
        assert.equal(attrs['git.edit.tree.fetches'], depth, `${name}, depth ${depth}`);
      }
    }
    assert.deepEqual(counts.perLevel, [5, 6, 7, 8, 9, 10, 11, 12]);
    assert.deepEqual(counts.first, [5, 5, 6, 6, 7, 7, 8, 8]);
    assert.deepEqual(counts.learned, [4, 4, 5, 5, 6, 6, 7, 7]);
    // a caller's tree cache: the edit fills it with every tree it read and every tree it wrote, and the next edit of the
    // path reads no tree at all. Its commit is still asked with two levels: the root's id is not known before the commit is.
    const cache = new Map();
    const cold = await unwrapAsync(editFile(learned.url, { path: pathAt(5), find: 'DONE', replace: 'CACHED', author: AUTHOR, message: 'cached' }, { tracer: new Tracer(), quirks, cache }));
    assert.deepEqual(learned.take(), [LS, ...fetches(ladder(5)), BLOB, PUSH]);
    const treesAt = commit => [`${commit}^{tree}`, ...Array.from({ length: 4 }, (_, i) => `${commit}:${dirAt(i + 1)}`)].map(spec => git(learned.bare, ['rev-parse', spec]).trim());
    assert.deepEqual([...cache.keys()].toSorted(), [...treesAt(cold.oldCommit), ...treesAt(cold.newCommit)].toSorted());
    for (const [oid, data] of cache) assert.deepEqual(Buffer.from(data), gitBuf(learned.bare, ['cat-file', 'tree', oid]), oid);
    const exWarm = arrayExporter();
    const warm = await unwrapAsync(editFile(learned.url, { path: pathAt(5), find: 'CACHED', replace: 'WARM', author: AUTHOR, message: 'warm' }, { tracer: new Tracer({ exporter: exWarm }), quirks, cache }));
    assert.deepEqual(learned.take(), [LS, ['fetch', D2], BLOB, PUSH]);
    assert.equal(git(learned.bare, ['rev-parse', 'main']).trim(), warm.newCommit);
    const warmAttrs = exWarm.lines.flatMap(flattenLine).find(sp => sp.name === 'git.edit').attrs;
    assert.deepEqual([warmAttrs['git.edit.tree.cache_hits'], warmAttrs['git.edit.tree.fetches'], warmAttrs['mem.alloc.object.count']], [5, 0, 1]);
    assert.deepEqual(fsckProblems(learned.bare), []);
    // a head hint: the hinted commit is the walk's commit, asked with its two levels beside ls-refs
    const head = git(learned.bare, ['rev-parse', 'main']).trim();
    const hinted = await unwrapAsync(editFile(learned.url, { path: pathAt(4), find: 'DONE', replace: 'HINTED', author: AUTHOR, message: 'hinted', head }, { tracer: new Tracer(), quirks }));
    assert.equal(hinted.oldCommit, head);
    assert.equal(gitBuf(learned.bare, ['show', `main:${pathAt(4)}`]).toString(), 'depth 4: HINTED\n');
    const seen = learned.take();
    assert.deepEqual(seen.slice(0, 2).toSorted(), [['fetch', D2], LS].toSorted());
    assert.deepEqual(seen.slice(2), [['fetch', D1], BLOB, PUSH]);
  } finally { await first.proxy.close(); await learned.proxy.close(); await narrow.proxy.close(); }
});

test('a server configured as GitHub: the first commit fetch is refused beside the tree:0 one, and every walk from then on is one tree per level', async () => {
  const r = await repo({ config: GITHUB_LIKE });
  try {
    const quirks = {};
    await read(r, pathAt(5), { quirks });
    const first = r.take();
    assert.deepEqual(first.slice(1, 3).toSorted(), fetches([D2, 'tree:0']).toSorted());
    // the refusal costs that one request: the walk goes on per level, with no round trip more than before
    assert.deepEqual([first[0], ...first.slice(3)], [LS, ...fetches(perLevel(5).slice(1)), BLOB]);
    for (let depth = 1; depth <= MAX_DEPTH; depth++) {
      await read(r, pathAt(depth), { quirks });
      assert.deepEqual(r.take(), [LS, ...fetches(perLevel(depth)), BLOB], `read depth ${depth}`);
      await list(r, dirAt(depth - 1), { quirks });
      assert.deepEqual(r.take(), [LS, ...fetches(perLevel(depth))], `list depth ${depth - 1}`);
    }
    await edit(r, pathAt(6), { quirks });
    assert.deepEqual(r.take(), [LS, ...fetches(perLevel(6)), BLOB, PUSH]);
    // an edit as the first contact
    await edit(r, pathAt(3), { quirks: {} });
    const edited = r.take();
    assert.deepEqual(edited.slice(1, 3).toSorted(), fetches([D2, 'tree:0']).toSorted());
    assert.deepEqual([edited[0], ...edited.slice(3)], [LS, ...fetches(perLevel(3).slice(1)), BLOB, PUSH]);
  } finally { await r.proxy.close(); }
});

test('a server whose tree depth is capped at 0 but takes combine, and one that takes no filter at all: each learned from its answer, every result git\'s', async () => {
  const capped = await repo({ config: [['uploadpackfilter.tree.maxDepth', '0']] });
  try {
    const quirks = {};
    for (let depth = 1; depth <= 4; depth++) { await read(capped, pathAt(depth), { quirks }); await edit(capped, pathAt(depth), { quirks }); }
    assert.equal(capped.seen.filter(([, f]) => f !== null && f.startsWith('combine:')).length, 1, 'refused once');
  } finally { await capped.proxy.close(); }
  const stock = await repo({ config: [['uploadpack.allowFilter', 'false']] });
  try {
    const quirks = {};
    for (let depth = 1; depth <= 4; depth++) { await read(stock, pathAt(depth), { quirks }); await edit(stock, pathAt(depth), { quirks }); }
    assert.equal(quirks.treeFilter, 'none');
    assert.equal(stock.seen.filter(([, f]) => f !== null && f.startsWith('combine:')).length, 1, 'asked once, beside the first tree:0 fetch');
    assert.equal(stock.seen.filter(([, f]) => f === 'tree:0').length, 1);
  } finally { await stock.proxy.close(); }
});

test('an Artifacts-like server (every filter but blob:none is a 400): an edit as the first contact sends one path-trees request, then blob:none only', async () => {
  const REJECT = 'Unsupported Git fetch filter; only blob:none is supported.';
  const r = await repo({ fault: ctx => (ctx.phase !== 'request' && ctx.stage === 'fetch' && filterOf(ctx.reqBody) && filterOf(ctx.reqBody) !== 'blob:none' ? { type: 'status', status: 400, contentType: 'text/plain; charset=utf-8', body: REJECT } : null) });
  try {
    const quirks = {};
    await edit(r, pathAt(5), { quirks });
    const first = r.take();
    assert.deepEqual(first.slice(1, 3).toSorted(), fetches([D2, 'tree:0']).toSorted());
    // the tree:0 fetch's refusal is answered by one blob:none fetch that brings every tree: no fetch per level
    assert.deepEqual([first[0], ...first.slice(3)], [LS, ['fetch', 'blob:none'], BLOB, PUSH]);
    assert.equal(quirks.treeFilter, 'blob:none');
    await edit(r, pathAt(7), { quirks });
    await read(r, pathAt(8), { quirks });
    assert.deepEqual(r.take(), [LS, ['fetch', 'blob:none'], BLOB, PUSH, LS, ['fetch', 'blob:none'], BLOB]);
  } finally { await r.proxy.close(); }
});

test('a directory too wide for the budget: its answer is not used, the walk reads one tree per level from there, and the result is git\'s', async () => {
  // x/big holds 400 directories: asked with its children, x/big is 401 trees, each charged LIMIT_OBJECT_OVERHEAD
  const WIDE = 400;
  assert.ok((WIDE + 1) * LIMIT_OBJECT_OVERHEAD > LIMIT_PATH_TREES, 'the default budget holds fewer trees than that');
  const files = { 'x/big/d7/sub/deep/f.txt': 'wide: MARK\n', 'x/other.txt': 'o\n', 'top.txt': 't\n' };
  for (let i = 0; i < WIDE; i++) files[`x/big/w${i}/f.txt`] = `w${i}\n`;
  const r = await repo({ files });
  try {
    const path = 'x/big/d7/sub/deep/f.txt';
    const quirks = {}; const ex = arrayExporter(); const tracer = new Tracer({ exporter: ex });
    await read(r, 'top.txt', { quirks }); r.take();
    // levels: root, x (with the commit), big asked with its children (over), then big, d7, sub, deep by their level
    await read(r, path, { quirks, tracer });
    assert.deepEqual(r.take(), [LS, ...fetches([D2, D1, 'tree:0', 'tree:0', 'tree:0', 'tree:0']), BLOB]);
    const over = ex.lines.flatMap(flattenLine).filter(s => s.name === 'git.upload-pack fetch' && s.attrs['git.fetch.path_trees'] === D1);
    assert.equal(over.length, 1);
    assert.equal(over[0].attrs['error.type'], 'limit_exceeded');
    assert.match(over[0].status.message, new RegExp(`^pack inflated bytes \\d+ exceeds limit ${LIMIT_PATH_TREES}$`));
    // the refused answer was left before its end: fewer bytes read than the budget, far fewer than held trees would be
    assert.ok(over[0].attrs['git.response.bytes'] <= LIMIT_PATH_TREES, `${over[0].attrs['git.response.bytes']} response bytes`);
    // the server is still known to take the filter: the next walk asks again, and one beside the wide directory uses it
    await read(r, 'x/other.txt', { quirks });
    assert.deepEqual(r.take(), [LS, ['fetch', D2], BLOB]);
    // an edit through it lands, by the same requests and the push
    await edit(r, path, { quirks });
    assert.deepEqual(r.take(), [LS, ...fetches([D2, D1, 'tree:0', 'tree:0', 'tree:0', 'tree:0']), BLOB, PUSH]);
    // a tree on the path over the caller's own limit is the edit's error on either walk, and nothing is pushed
    const head = git(r.bare, ['rev-parse', 'main']).trim();
    for (const limits of [{ maxTreeEntries: 100 }, { maxTreeEntries: 100, maxPathTreesBytes: 0 }]) {
      const refused = await editFile(r.url, { path, find: 'DONE', replace: 'NEVER', author: AUTHOR, message: 'never' }, { tracer: new Tracer(), quirks, limits });
      assert.equal(refused.ok, false);
      assert.deepEqual([refused.error.code, refused.error.what], ['limit_exceeded', 'tree entries']);
      assert.ok(!r.take().some(([stage]) => stage === 'receive-pack'));
    }
    assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), head);
    // a budget with room for the 401 trees: used, and the answer is the same
    await read(r, path, { quirks, limits: { maxPathTreesBytes: 4 * LIMIT_PATH_TREES } });
    assert.deepEqual(r.take(), [LS, ...fetches([D2, D1, D1]), BLOB]);
    await list(r, 'x/big', { quirks, limits: { maxPathTreesBytes: 4 * LIMIT_PATH_TREES } });
    assert.deepEqual(r.take(), [LS, ...fetches([D2, 'tree:0'])]);
  } finally { await r.proxy.close(); }
});

// A path-trees answer replaced by a pack of `objects`, framed as upload-pack frames it.
async function packAnswer(objects) {
  const { pack } = await buildPack(objects);
  const parts = [unwrap(pkt('packfile\n'))];
  for (let i = 0; i < pack.length; i += 65000) parts.push(unwrap(pkt(concat([Uint8Array.of(1), pack.subarray(i, Math.min(i + 65000, pack.length))]))));
  parts.push(FLUSH);
  return concat(parts);
}
const obj = (bare, spec) => ({ type: TYPE.TREE, data: new Uint8Array(gitBuf(bare, ['cat-file', 'tree', spec])) });

test('a server that substitutes a tree in a path-trees answer: the tree is kept under its own hash, never read in place of the path\'s, and the read and the edit are git\'s', async () => {
  // l1/l2 is asked with its children. The lies: another directory in its place; itself with another directory in place
  // of its child l3 (a valid tree, with a file of the name the walk looks up one level down)
  const lies = {
    'another tree for the want': bare => [obj(bare, 'main:side1'), obj(bare, 'main:l1/l2/l3')],
    'another tree for the child': bare => [obj(bare, 'main:l1/l2'), obj(bare, 'main:l1/l2/side3')],
  };
  for (const [name, lie] of Object.entries(lies)) {
    let bare = null;
    const r = await repo({ fault: ctx => (ctx.phase !== 'request' && filterOf(ctx.reqBody) === D1 ? { type: 'bytes', name, bytes: packAnswer(lie(bare)) } : null) });
    bare = r.bare;
    try {
      const quirks = {}; const ex = arrayExporter(); const tracer = new Tracer({ exporter: ex });
      await read(r, pathAt(2), { quirks });
      r.take();
      await read(r, pathAt(4), { quirks, tracer });
      const seen = r.take();
      const lied = ex.lines.flatMap(flattenLine).filter(s => s.name === 'git.upload-pack fetch' && s.attrs['git.fetch.path_trees'] === D1);
      assert.equal(lied.length, 1, name);
      if (name === 'another tree for the want') {
        assert.equal(lied[0].attrs['error.type'], 'pack_corrupt', name);
        assert.deepEqual(seen, [LS, ...fetches([D2, D1, 'tree:0', 'tree:0']), BLOB], `${name}: l2 and l3 by their level`);
      } else {
        assert.deepEqual(seen, [LS, ...fetches([D2, D1, 'tree:0']), BLOB], `${name}: l3 did not come, so it is fetched by its level`);
      }
      await edit(r, pathAt(4), { quirks });
      await edit(r, pathAt(6), { quirks });
    } finally { await r.proxy.close(); }
  }
});
