// #218: readFile / listTree fetch the commit and the path's first two tree levels in one request where the server takes
// `combine:blob:none+tree:K`. git is the oracle for every answer (`git show`, `git ls-tree`); the proxy in front of git
// http-backend counts the requests and the filters they carry. Servers: git with uploadpack.allowFilter (takes it), git
// configured as GitHub is (uploadpackfilter.tree.maxDepth=0, uploadpackfilter.combine.allow=false: GitHub's two refusals,
// byte for byte), git with maxDepth=1, an Artifacts-like proxy (every filter but blob:none is a 400), and a proxy that
// lies in the deep pack (each lie falls back to the tree:0 walk and still answers what git says).
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, commitFiles, initRepo } from './server.js';
import { startProxy } from './proxy.js';
import { readFile, listTree, walkCommit } from '../src/read.js';
import { createTransport } from '../src/http.js';
import { fetchObject } from '../src/fetch.js';
import { buildPack } from '../src/pack.js';
import { pkt, FLUSH } from '../src/pktline.js';
import { concat } from '../src/bytes.js';
import { TYPE } from '../src/objects.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { PATH_TREE_LEVELS, pathTreesFilter, isPathTreesRefusal } from '../src/pathtrees.js';
import { unwrap, unwrapAsync } from './unwrap.js';

const filterOf = body => /filter ([^\n]+)\n/.exec(Buffer.from(body).toString('latin1'))?.[1] ?? null;
const drain = async stream => { const parts = []; for await (const c of stream) parts.push(Buffer.from(c)); return Buffer.concat(parts); };
const lsTree = (bare, spec) => git(bare, ['ls-tree', '-z', spec]).split('\0').filter(Boolean).map(l => { const [meta, name] = l.split('\t'); const [mode, type, oid] = meta.split(' '); return { name, mode, oid, type }; });

const FILES = { 'README.md': '# root\n', 'a/x.txt': 'one\n', 'a/b/y.txt': 'two\n', 'a/b/c/z.txt': 'three\n', 'a/b/c/d/w.txt': 'four\n', 'q/r.txt': 'sibling\n' };
for (let i = 0; i < 12; i++) FILES[`wide/d${i}/f.txt`] = `f${i}\n`;
const READS = ['README.md', 'a/x.txt', 'a/b/y.txt', 'a/b/c/z.txt', 'a/b/c/d/w.txt'];
const LISTS = ['', 'a', 'a/b', 'a/b/c'];
const depth = p => (p === '' ? 0 : p.split('/').length);
// Round trips of a warm read on a server that takes the deep fetch: ls-refs, the commit with the first
// min(levels, PATH_TREE_LEVELS) tree levels, one fetch per level past them, and the blob for readFile.
const deepReadRequests = p => 1 + 1 + Math.max(0, depth(p) - PATH_TREE_LEVELS) + 1;
const deepListRequests = p => 1 + 1 + Math.max(0, depth(p) + 1 - PATH_TREE_LEVELS);
// ... and on one that does not (today's walk): ls-refs, the commit, one tree per level, the blob.
const narrowReadRequests = p => 1 + 1 + depth(p) + 1;
const narrowListRequests = p => 1 + 1 + depth(p) + 1;

let root, cleanup, srv, n = 0;
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv.close(); cleanup(); });

// A repository behind a recording proxy. `config`: upload-pack settings on top of makeBareRepo's. `lie(ctx)`: a fault
// for a deep fetch's answer (or null to pass it).
async function repo({ config = [], fault = null } = {}) {
  const name = `p${n++}`; const bare = makeBareRepo(root, name); const work = join(root, `w${name}`); mkdirSync(work); initRepo(work);
  for (const [k, v] of config) git(bare, ['config', k, v]);
  commitFiles(work, bare, FILES, 'seed');
  const seen = [];
  const proxy = await startProxy(srv.url, ctx => {
    if (ctx.phase === 'request') return fault ? fault(ctx) : null;
    seen.push({ stage: ctx.stage, filter: filterOf(ctx.reqBody), status: ctx.status });
    return fault ? fault(ctx) : { type: 'pass' };
  });
  return { bare, url: `${proxy.url}/${name}.git`, proxy, seen, mark: () => seen.length };
}
const since = (r, at) => r.seen.slice(at);
const deepFilters = reqs => reqs.filter(s => typeof s.filter === 'string' && s.filter.startsWith('combine:'));

async function checkRead(r, path, opts) {
  const got = await unwrapAsync(readFile(r.url, { path }, opts));
  assert.deepEqual(await drain(got.stream), gitBuf(r.bare, ['show', `main:${path}`]), path);
  assert.equal(got.blob, git(r.bare, ['rev-parse', `main:${path}`]).trim());
}
async function checkList(r, path, opts) {
  const got = await unwrapAsync(listTree(r.url, { path }, opts));
  assert.deepEqual(got.entries.map(e => [e.name, e.mode, e.oid, e.type]), lsTree(r.bare, path === '' ? 'main' : `main:${path}`).map(e => [e.name, e.mode, e.oid, e.type]), path || '/');
}

test('pathTreesFilter: the levels a walk reads, capped at PATH_TREE_LEVELS', () => {
  assert.equal(PATH_TREE_LEVELS, 2);
  assert.equal(pathTreesFilter(1), 'combine:blob:none+tree:1');
  assert.equal(pathTreesFilter(2), 'combine:blob:none+tree:2');
  assert.equal(pathTreesFilter(7), 'combine:blob:none+tree:2');
});

test('a server that takes it: first contact is tree:0, then one race, then the deep fetch alone; every answer is git\'s', async () => {
  const r = await repo();
  try {
    const quirks = {}; const tracer = new Tracer();
    // 1: nothing known: the tree:0 walk (tree:0 is settled by it)
    let at = r.mark(); await checkRead(r, 'a/b/y.txt', { tracer, quirks });
    assert.equal(since(r, at).length, narrowReadRequests('a/b/y.txt'));
    assert.equal(deepFilters(since(r, at)).length, 0, 'no deep fetch before tree:0 is known to be taken');
    // 2: tree:0 taken, the deep fetch not known: both commit fetches, concurrently; the deep one wins
    at = r.mark(); await checkRead(r, 'a/b/y.txt', { tracer, quirks });
    assert.equal(since(r, at).length, deepReadRequests('a/b/y.txt') + 1, 'the race adds the tree:0 commit fetch');
    assert.deepEqual(deepFilters(since(r, at)).map(s => s.filter), ['combine:blob:none+tree:2']);
    // 3+: taken: the deep fetch alone, every depth, readFile and listTree
    for (const p of READS) {
      at = r.mark(); await checkRead(r, p, { tracer, quirks });
      assert.equal(since(r, at).length, deepReadRequests(p), `readFile ${p}`);
      assert.deepEqual(deepFilters(since(r, at)).map(s => s.filter), [pathTreesFilter(depth(p))], `readFile ${p}`);
      assert.equal(since(r, at).filter(s => s.filter === 'tree:0').length, Math.max(0, depth(p) - PATH_TREE_LEVELS), `readFile ${p}: tree:0 only past the deep levels`);
    }
    for (const p of LISTS) {
      at = r.mark(); await checkList(r, p, { tracer, quirks });
      assert.equal(since(r, at).length, deepListRequests(p), `listTree ${p || '/'}`);
      assert.deepEqual(deepFilters(since(r, at)).map(s => s.filter), [pathTreesFilter(depth(p) + 1)], `listTree ${p || '/'}`);
    }
    assert.equal(quirks.treeFilter, 'tree:0', 'the public record is unchanged by what was learned');
    assert.deepEqual(Object.keys(quirks).toSorted(), ['blobWants', 'treeFilter']);
  } finally { await r.proxy.close(); }
});

test('walkCommit (#222): the commit and the path\'s first two levels in one fetch, the rest per level; git is the oracle', async () => {
  const r = await repo();
  try {
    const quirks = {}; const tracer = new Tracer();
    const head = git(r.bare, ['rev-parse', 'main']).trim();
    const rev = spec => git(r.bare, ['rev-parse', spec]).trim();
    const t = unwrap(createTransport(r.url, { tracer, quirks }));
    // first contact: nothing known, so the commit (tree:0) and one tree per level, as readFile's first walk
    let at = r.mark();
    let cache = new Map();
    const cold = await unwrapAsync(walkCommit(t, head, ['a', 'b'], { cache }));
    assert.deepEqual(since(r, at).map(s => s.filter), ['tree:0', 'tree:0', 'tree:0']);
    assert.equal(cold.entry.oid, rev('main:a/b'));
    // tree:0 is now known to be taken: the deep fetch races the commit's tree:0 fetch once and is learned
    await unwrapAsync(walkCommit(t, head, ['a'], { cache: new Map() }));
    at = r.mark(); cache = new Map();
    const w = await unwrapAsync(walkCommit(t, head, ['a', 'b'], { cache }));
    assert.deepEqual(since(r, at).map(s => s.filter), ['combine:blob:none+tree:2'], 'one request: the commit, the root and a/');
    assert.equal(w.commit, head);
    assert.deepEqual(Buffer.from(w.data), gitBuf(r.bare, ['cat-file', 'commit', head]));
    assert.equal(w.tree, rev('main^{tree}'));
    assert.deepEqual([w.entry.name, w.entry.mode, w.entry.oid], ['b', '40000', rev('main:a/b')]);
    assert.deepEqual([...cache.keys()].toSorted(), [rev('main^{tree}'), rev('main:a')].toSorted());
    assert.deepEqual(Buffer.from(cache.get(rev('main:a'))), gitBuf(r.bare, ['cat-file', 'tree', rev('main:a')]));
    // a depth-1 tree the walk did not read came with the commit: fetchObject answers it without a request
    at = r.mark();
    const sibling = await unwrapAsync(fetchObject(t, { oid: rev('main:q'), filter: 'tree:0' }));
    assert.deepEqual(Buffer.from(sibling.data), gitBuf(r.bare, ['cat-file', 'tree', rev('main:q')]));
    assert.equal(since(r, at).length, 0);
    // levels: the default is comps.length + 1 (root listing: tree:1), 0 is the commit alone (its root tree is still in the
    // transport's harvest from the deep fetches above), past 2 is capped at 2
    for (const [comps, levels, filters] of [
      [[], undefined, ['combine:blob:none+tree:1']],
      [['a'], 0, ['tree:0']],
      [['a', 'b', 'c', 'd'], undefined, ['combine:blob:none+tree:2', 'tree:0', 'tree:0']],
      [['a', 'b', 'c', 'd'], 9, ['combine:blob:none+tree:2', 'tree:0', 'tree:0']],
      [['a'], 1, ['combine:blob:none+tree:1']],
    ]) {
      at = r.mark();
      const got = await unwrapAsync(walkCommit(t, head, comps, { cache: new Map(), levels }));
      assert.deepEqual(since(r, at).map(s => s.filter), filters, `${comps.join('/')} levels ${levels}`);
      assert.equal(got.entry === null ? got.tree : got.entry.oid, rev(comps.length === 0 ? 'main^{tree}' : `main:${comps.join('/')}`));
    }
    // no options at all: the default cache and levels
    at = r.mark();
    assert.equal((await unwrapAsync(walkCommit(t, head, ['q']))).entry.oid, rev('main:q'));
    assert.deepEqual(since(r, at).map(s => s.filter), ['combine:blob:none+tree:2']);
    // a missing component is walkPath's not_found, with its miss
    const missing = await walkCommit(t, head, ['a', 'nope']);
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'not_found');
    assert.deepEqual(missing.error.miss, { kind: 'path', missing: 'nope', existingPath: 'a' });
    // refused before any request: an oid that is not 40 hex, levels that is not a non-negative integer
    at = r.mark();
    for (const [oid, levels] of [['HEAD', 1], [head.slice(1), 1], [head, -1], [head, 1.5], [head, Number.NaN], [head, '2']]) {
      const bad = await walkCommit(t, oid, ['a'], { levels });
      assert.equal(bad.ok, false, `${oid} ${levels}`);
      assert.equal(bad.error.code, 'bad_request', `${oid} ${levels}`);
    }
    assert.match((await walkCommit(t, head, [], { levels: -1 })).error.message, /^walkCommit: levels must be a non-negative integer, got -1$/);
    assert.equal(since(r, at).length, 0);
    // a blob is not a commit
    const notCommit = await walkCommit(t, rev('main:README.md'), []);
    assert.equal(notCommit.ok, false);
  } finally { await r.proxy.close(); }
});

test('a server configured as GitHub (combine refused, tree depth 0): one refused request in the race, then today\'s walk', async () => {
  const r = await repo({ config: [['uploadpackfilter.tree.maxDepth', '0'], ['uploadpackfilter.combine.allow', 'false']] });
  try {
    const quirks = {}; const ex = arrayExporter(); const tracer = new Tracer({ exporter: ex });
    for (let round = 0; round < 2; round++) {
      for (const p of READS) await checkRead(r, p, { tracer, quirks });
      for (const p of LISTS) await checkList(r, p, { tracer, quirks });
    }
    const deep = deepFilters(r.seen);
    assert.equal(deep.length, 1, 'refused once, never asked again on this record');
    // the refusal is git's ERR, inside a 200: remote_error, recognised as a refusal (isPathTreesRefusal)
    const spans = ex.lines.flatMap(flattenLine).filter(s => s.name === 'git.upload-pack fetch' && s.attrs['git.fetch.filter'] === deep[0].filter);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].attrs['error.type'], 'remote_error');
    // after the race every read is today's: no more requests than the tree:0 walk
    const at = r.mark();
    for (const p of READS) await checkRead(r, p, { tracer, quirks });
    for (const p of LISTS) await checkList(r, p, { tracer, quirks });
    assert.equal(since(r, at).length, READS.reduce((s, p) => s + narrowReadRequests(p), 0) + LISTS.reduce((s, p) => s + narrowListRequests(p), 0));
  } finally { await r.proxy.close(); }
});

test('a server whose tree depth is capped at 1: a K=2 refusal is learned as refused, answers stay git\'s', async () => {
  const r = await repo({ config: [['uploadpackfilter.tree.maxDepth', '1']] });
  try {
    const quirks = {}; const tracer = new Tracer();
    await checkRead(r, 'README.md', { tracer, quirks }); // settles tree:0
    await checkRead(r, 'README.md', { tracer, quirks }); // race, K = 1: taken
    let at = r.mark(); await checkRead(r, 'README.md', { tracer, quirks });
    assert.equal(since(r, at).length, deepReadRequests('README.md'));
    // K = 2 is past the cap: refused (git: "tree filter allows max depth 1, but got 2"), the walk falls back
    at = r.mark(); await checkRead(r, 'a/b/y.txt', { tracer, quirks });
    assert.deepEqual(since(r, at).map(s => s.filter).filter(Boolean)[0], 'combine:blob:none+tree:2');
    at = r.mark(); await checkRead(r, 'README.md', { tracer, quirks });
    assert.equal(deepFilters(since(r, at)).length, 0, 'one bit per record: refused for every K from then on');
    assert.equal(since(r, at).length, narrowReadRequests('README.md'));
  } finally { await r.proxy.close(); }
});

test('an Artifacts-like server (only blob:none): never asked for the deep fetch; one 400 per record, as #136', async () => {
  const REJECT = 'Unsupported Git fetch filter; only blob:none is supported.';
  const r = await repo({ fault: ctx => (ctx.phase !== 'request' && ctx.stage === 'fetch' && filterOf(ctx.reqBody) && filterOf(ctx.reqBody) !== 'blob:none' ? { type: 'status', status: 400, contentType: 'text/plain; charset=utf-8', body: REJECT } : null) });
  try {
    const quirks = {}; const tracer = new Tracer();
    for (let round = 0; round < 2; round++) {
      for (const p of READS) await checkRead(r, p, { tracer, quirks });
      for (const p of LISTS) await checkList(r, p, { tracer, quirks });
    }
    assert.equal(quirks.treeFilter, 'blob:none');
    assert.equal(deepFilters(r.seen).length, 0);
    assert.equal(r.seen.filter(s => s.filter === 'tree:0').length, 1, 'tree:0 refused once');
  } finally { await r.proxy.close(); }
});

test('limits: a depth-1 directory over maxTreeEntries is dropped from the deep pack, and every outcome equals the tree:0 server\'s', async () => {
  // wide/ holds 12 entries; the cap is 10. Reads beside it succeed; reads through it are limit_exceeded, as on tree:0.
  const limits = { maxTreeEntries: 10 };
  const outcome = async thunk => { try { const r = await unwrapAsync(thunk()); if (r.stream) await drain(r.stream); return r.entries ? `ok ${r.entries.length}` : `ok ${r.blob}`; } catch (e) { return `${e.code} ${e.what ?? ''}`; } };
  const ops = [
    ['read README.md', (url, o) => readFile(url, { path: 'README.md' }, { limits, ...o })],
    ['read a/b/y.txt', (url, o) => readFile(url, { path: 'a/b/y.txt' }, { limits, ...o })],
    ['read wide/d1/f.txt', (url, o) => readFile(url, { path: 'wide/d1/f.txt' }, { limits, ...o })],
    ['list /', (url, o) => listTree(url, { path: '' }, { limits, ...o })],
    ['list wide', (url, o) => listTree(url, { path: 'wide' }, { limits, ...o })],
    ['list a', (url, o) => listTree(url, { path: 'a' }, { limits, ...o })],
  ];
  const deep = await repo(); const narrow = await repo({ config: [['uploadpackfilter.tree.maxDepth', '0'], ['uploadpackfilter.combine.allow', 'false']] });
  try {
    const answers = {};
    for (const r of [deep, narrow]) {
      const quirks = {}; const ex = arrayExporter(); const tracer = new Tracer({ exporter: ex });
      for (let round = 0; round < 3; round++) for (const [name, fn] of ops) answers[`${r === deep ? 'deep' : 'narrow'} ${round} ${name}`] = await outcome(() => fn(r.url, { tracer, quirks }));
      if (r === deep) {
        const fetches = ex.lines.flatMap(flattenLine).filter(s => s.name === 'git.upload-pack fetch' && s.attrs['git.fetch.path_trees']);
        assert.ok(fetches.some(s => s.attrs['git.fetch.wide.skipped'] === 1 && s.attrs['git.fetch.wide.skipped_reason'] === 'tree entries'), 'the over-limit sibling was dropped, counted on the span');
      }
    }
    for (const [name] of ops) for (let round = 0; round < 3; round++) assert.equal(answers[`deep ${round} ${name}`], answers[`narrow ${round} ${name}`], `${name} round ${round}`);
    assert.match(answers['deep 2 read wide/d1/f.txt'], /^limit_exceeded/);
    assert.match(answers['deep 2 list wide'], /^limit_exceeded/);
    assert.match(answers['deep 2 read a/b/y.txt'], /^ok /);
  } finally { await deep.proxy.close(); await narrow.proxy.close(); }
});

test('isPathTreesRefusal: git\'s refusals, an Artifacts 400, an empty answer; not a timeout, a 500 or not_our_ref', () => {
  const e = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
  assert.equal(isPathTreesRefusal(e('remote_error', "remote: filter 'combine' not supported")), true);
  assert.equal(isPathTreesRefusal(e('remote_error', 'remote: tree filter allows max depth 0, but got 2')), true);
  assert.equal(isPathTreesRefusal(e('http', 'HTTP 400 git-upload-pack: Unsupported Git fetch filter; only blob:none is supported.', { status: 400 })), true);
  assert.equal(isPathTreesRefusal(e('protocol', 'v2: response ended without flush', { reason: 'empty_response' })), true);
  assert.equal(isPathTreesRefusal(e('timeout', 'request timed out')), false);
  assert.equal(isPathTreesRefusal(e('http', 'HTTP 500 tree filter allows max depth 0', { status: 500 })), false);
  assert.equal(isPathTreesRefusal(e('remote_error', 'remote: upload-pack: not our ref 1234', { reason: 'not_our_ref' })), false);
});

// ---- a server that lies in the deep pack ----
// The deep fetch's answer replaced by a pack of `objects` (each { type, data }), framed as upload-pack frames it.
async function packAnswer(objects) {
  const { pack } = await buildPack(objects);
  const parts = [unwrap(pkt('packfile\n'))];
  for (let i = 0; i < pack.length; i += 65000) parts.push(unwrap(pkt(concat([Uint8Array.of(1), pack.subarray(i, Math.min(i + 65000, pack.length))]))));
  parts.push(FLUSH);
  return concat(parts);
}
const obj = (bare, type, spec) => ({ type: TYPE[type.toUpperCase()], data: new Uint8Array(gitBuf(bare, ['cat-file', type, spec])) });
// A tree git's fsck refuses and ply's assertFetched does too: an entry named `.git`.
const badTree = blob => ({ type: TYPE.TREE, data: concat([new TextEncoder().encode('100644 .git\0'), Buffer.from(blob, 'hex')]) });

test('a lying deep pack is never used: each lie falls back to the tree:0 walk and the answer is git\'s', async () => {
  const lies = {
    // only the commit: the walk finds no tree in the harvest and fetches each level
    'commit only': bare => [obj(bare, 'commit', 'main')],
    // no commit: not this walk's commit
    'no commit': bare => [obj(bare, 'tree', 'main^{tree}'), obj(bare, 'tree', 'main:a')],
    // another commit and its trees: keyed by their own hashes, the wanted commit is not there
    'another commit': bare => [obj(bare, 'commit', 'main~1'), obj(bare, 'tree', 'main~1^{tree}')],
    // the commit and a valid tree that is not its root (a forged root): keyed by its own hash, never read as the root
    'forged root': bare => [obj(bare, 'commit', 'main'), obj(bare, 'tree', 'main:a/b')],
    // a malformed extra: the response is not trusted at all (#18), nothing from it is used
    'malformed extra': bare => [obj(bare, 'commit', 'main'), obj(bare, 'tree', 'main^{tree}'), badTree(git(bare, ['rev-parse', 'main:README.md']).trim())],
  };
  for (const [name, lie] of Object.entries(lies)) {
    let bare = null;
    const r = await repo({ fault: ctx => (ctx.phase !== 'request' && filterOf(ctx.reqBody)?.startsWith('combine:') ? { type: 'bytes', name, bytes: packAnswer(lie(bare)) } : null) });
    bare = r.bare;
    if (name === 'another commit') commitFiles(join(root, `w${r.url.split('/').pop().replace('.git', '')}`), bare, { 'later.txt': 'later\n' }, 'later');
    try {
      const quirks = {}; const ex = arrayExporter(); const tracer = new Tracer({ exporter: ex });
      for (let i = 0; i < 3; i++) for (const p of READS) await checkRead(r, p, { tracer, quirks });
      for (const p of LISTS) await checkList(r, p, { tracer, quirks });
      const deep = ex.lines.flatMap(flattenLine).filter(s => s.name === 'git.upload-pack fetch' && String(s.attrs['git.fetch.filter']).startsWith('combine:'));
      assert.ok(deep.length > 0, `${name}: the deep fetch was asked`);
      if (name === 'malformed extra') assert.ok(deep.every(s => s.attrs['error.type'] === 'pack_corrupt'), `${name}: the deep fetch failed on the malformed object`);
    } finally { await r.proxy.close(); }
  }
});
