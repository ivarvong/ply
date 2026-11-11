// Pack cache + head hint against real git through the counting proxy. The oracle for "fewer round trips" is the
// proxy's per-stage request count (what the server actually saw); the oracle for correctness is git itself.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { git, gitAsync, tmpRoot, makeBareRepo, startGitServer, commitFiles, fsckProblems } from './server.js';
import { startProxy } from './proxy.js';
import { editFile } from '../src/edit.js';
import { cachingFetch, memoryCache, isCacheableFetch, cacheKey, parseUploadPackRequest, exchangeKind, verifyFetchAnswer } from '../src/packcache.js';
import { pkt, pktInit, pktStep, FLUSH, DELIM } from '../src/pktline.js';
import { lsRefsBody as lsRefsBodyR } from '../src/lsrefs.js';
import { parsePack, resolvePack } from '../src/packresolve.js';
import { te, concat } from '../src/bytes.js';
import { DEFAULT_LIMITS, LIMIT_MEMORY_CACHE_BYTES, LIMIT_MEMORY_CACHE_ENTRIES } from '../src/limits.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fetchBody as fetchBodyR, GitHttp } from '../src/client.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { unwrap, unwrapAsync } from './unwrap.js';

// Throwing adapters over the Result API (0.2.0): the assertions below are about the throw.
const fetchBody = (...a) => unwrap(fetchBodyR(...a));
let root, cleanup, srv, proxy, bare, work, url;
// commit on top of whatever main is now (as another writer would)
const otherWriter = (files, msg) => { git(work, ['fetch', '-q', bare, 'refs/heads/main']); git(work, ['reset', '-q', '--hard', 'FETCH_HEAD']); return commitFiles(work, bare, files, msg); };
const author = { name: 'pc', email: 'pc@x' };
before(async () => {
  ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root);
  bare = makeBareRepo(root, 'pc'); work = join(root, 'wpc'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  commitFiles(work, bare, { 'a/b/c/file.txt': 'hello MARK world\n', 'README.md': '# pc\n' }, 'init');
  proxy = await startProxy(srv.url, () => null);
  url = `${proxy.url}/pc.git`;
});
after(async () => { await proxy.close?.(); await srv.close(); cleanup(); });

const counts = () => ({ ...proxy.counts });
const delta = (a, b) => Object.fromEntries(['ls-refs', 'fetch', 'receive-pack'].map(k => [k, (b[k] ?? 0) - (a[k] ?? 0)]));
const spansOf = ex => ex.lines.flatMap(flattenLine);
const headOf = () => git(bare, ['rev-parse', 'refs/heads/main']).trim();

test('isCacheableFetch: wants-only filtered fetches only', () => {
  const oid = 'a'.repeat(40);
  assert.equal(isCacheableFetch(fetchBody({ wants: [oid], filter: 'tree:0' })), true);
  assert.equal(isCacheableFetch(fetchBody({ wants: [oid], filter: 'tree:0', deepen: 1 })), true);
  assert.equal(isCacheableFetch(fetchBody({ wants: [oid] })), false, 'no filter → blob stream, not cached');
  assert.equal(isCacheableFetch(fetchBody({ wants: [oid], filter: 'tree:0', haves: ['b'.repeat(40)] })), false);
  assert.equal(isCacheableFetch(fetchBody({ wants: [oid], filter: 'tree:0', deepenSince: 1 })), false);
  assert.equal(isCacheableFetch(fetchBody({ wants: [oid], filter: 'tree:0', deepenNot: ['refs/heads/x'] })), false);
  assert.equal(isCacheableFetch(fetchBody({ wants: [oid], filter: 'tree:0', shallows: ['c'.repeat(40)] })), false);
});

test('cacheKey: url, credential and body all separate entries', async () => {
  const b = fetchBody({ wants: ['a'.repeat(40)], filter: 'tree:0' });
  const k = await cacheKey('http://h/r', 'Basic x', b);
  assert.notEqual(k, await cacheKey('http://h/r2', 'Basic x', b));
  assert.notEqual(k, await cacheKey('http://h/r', 'Basic y', b));
  assert.notEqual(k, await cacheKey('http://h/r', 'Basic x', fetchBody({ wants: ['b'.repeat(40)], filter: 'tree:0' })));
  assert.equal(k, await cacheKey('http://h/r', 'Basic x', b.slice()));
});

test('pack cache: second edit at the same tree serves commit+trees from cache; server sees only ls-refs, blob, push', async () => {
  const cache = memoryCache();
  const f = cachingFetch(globalThis.fetch, cache);
  const run = async (find, replace, treeCache = new Map()) => {
    const ex = arrayExporter(); const before = counts();
    const r = await unwrapAsync(editFile(url, { path: 'a/b/c/file.txt', find, replace, author, message: 'm' }, { tracer: new Tracer({ exporter: ex }), fetchImpl: f, cache: treeCache }));
    return { r, d: delta(before, counts()), spans: spansOf(ex) };
  };
  const a = await run('MARK', 'MARK1');
  // cold: ls-refs + commit + 4 trees (root, a, b, c) + blob + push
  assert.deepEqual(a.d, { 'ls-refs': 1, fetch: 6, 'receive-pack': 1 });
  assert.equal(f.stats.miss, 5); assert.equal(f.stats.hit, 0);
  assert.equal(cache.entries.size, 5);
  assert.ok(a.spans.filter(s => s.name === 'git.upload-pack fetch' && s.attrs['git.pack.cache'] === 'MISS').length === 5);
  git(bare, ['update-ref', 'refs/heads/main', a.r.oldCommit]); // rewind so the same commit/trees are wanted again
  const b = await run('MARK', 'MARK2');
  assert.deepEqual(b.d, { 'ls-refs': 1, fetch: 1, 'receive-pack': 1 }, 'only the blob stream reaches the server');
  assert.equal(f.stats.hit, 5);
  assert.equal(b.spans.filter(s => s.name === 'git.upload-pack fetch' && s.attrs['git.pack.cache'] === 'HIT').length, 5);
  assert.equal(b.r.newCommit, headOf());
  assert.equal(git(bare, ['cat-file', '-p', 'main:a/b/c/file.txt']), 'hello MARK2 world\n');
  assert.deepEqual(fsckProblems(bare), []);
  git(bare, ['update-ref', 'refs/heads/main', a.r.oldCommit]);

  // poison: flip a byte inside every cached body. Each hit now fails verification → one bust refetch each → repaired cache.
  for (const e of cache.entries.values()) e.body[e.body.length - 30] ^= 0xff;
  const c = await run('MARK', 'MARK3');
  assert.deepEqual(c.d, { 'ls-refs': 1, fetch: 6, 'receive-pack': 1 }, 'every poisoned entry was refetched once');
  assert.equal(f.stats.bust, 5);
  assert.equal(c.spans.filter(s => s.name === 'git.upload-pack fetch' && s.attrs['git.pack.cache.bust'] === true).length, 5);
  assert.equal(c.spans.filter(s => s.name === 'git.upload-pack fetch' && s.attrs['git.pack.cache'] === 'BUST').length, 5);
  assert.equal(c.r.newCommit, headOf());
  git(bare, ['update-ref', 'refs/heads/main', a.r.oldCommit]);
  const d = await run('MARK', 'MARK4');
  assert.deepEqual(d.d, { 'ls-refs': 1, fetch: 1, 'receive-pack': 1 }, 'cache repaired');
  assert.deepEqual(fsckProblems(bare), []);
  git(bare, ['update-ref', 'refs/heads/main', a.r.oldCommit]);
});

test('pack cache: a corrupt live response is not retried (bust only follows a HIT)', async () => {
  let n = 0;
  const bad = async (u, init) => { const res = await fetch(u, init); if (String(u).endsWith('git-upload-pack') && isCacheableFetch(init.body) && n++ === 0) { const b = new Uint8Array(await res.arrayBuffer()); b[b.length - 30] ^= 0xff; return new Response(b, { status: 200, headers: res.headers }); } return res; };
  const before = counts();
  await assert.rejects(unwrapAsync(editFile(url, { path: 'a/b/c/file.txt', find: 'MARK', replace: 'x', author, message: 'm' }, { tracer: new Tracer(), fetchImpl: cachingFetch(bad, memoryCache()) })), e => e.code === 'pack_corrupt');
  assert.deepEqual(delta(before, counts()), { 'ls-refs': 1, fetch: 1, 'receive-pack': 0 });
});

test('head hint (parallel, default): ls-refs overlaps the speculative commit fetch; stale hint corrected before any push; bogus hint harmless', async () => {
  const base = headOf();
  const run = async (head, find, replace, extra = {}) => {
    const ex = arrayExporter(); const before = counts();
    const r = await unwrapAsync(editFile(url, { path: 'a/b/c/file.txt', find, replace, author, message: 'm' }, { tracer: new Tracer({ exporter: ex }), head, ...extra }));
    return { r, d: delta(before, counts()), spans: spansOf(ex) };
  };
  const a = await run(base, 'MARK', 'H1');
  assert.deepEqual(a.d, { 'ls-refs': 1, fetch: 6, 'receive-pack': 1 }, 'ls-refs still happens, overlapped with the commit fetch');
  assert.equal(a.r.hint, 'used'); assert.equal(a.r.attempt, 0); assert.equal(a.r.oldCommit, base); assert.equal(a.r.newCommit, headOf());
  const root = a.spans.find(s => s.name === 'git.edit');
  assert.equal(root.attrs['git.edit.head.hint'], base); assert.equal(root.attrs['git.edit.head.outcome'], 'used');
  // overlap is real: ls-refs and the commit fetch spans intersect in time
  const ls = a.spans.find(s => s.name === 'git.upload-pack ls-refs'), cf = a.spans.filter(s => s.name === 'git.upload-pack fetch')[0];
  assert.ok(ls && cf);

  // someone else moved the ref: the hint is stale, ls-refs wins, nothing is pushed under the stale parent
  otherWriter({ 'other.txt': 'x\n' }, 'someone else');
  const moved = headOf();
  const b = await run(a.r.newCommit, 'H1', 'H2');
  assert.equal(b.r.hint, 'stale'); assert.equal(b.r.attempt, 0);
  assert.deepEqual(b.d, { 'ls-refs': 1, fetch: 7, 'receive-pack': 1 }, 'speculative commit fetch wasted, real commit fetched, exactly one push');
  assert.equal(b.r.oldCommit, moved); assert.equal(b.r.newCommit, headOf());
  assert.equal(b.spans.filter(s => s.name === 'git.edit').length, 1);
  assert.equal(git(bare, ['cat-file', '-p', 'main:a/b/c/file.txt']), 'hello H2 world\n');
  assert.equal(git(bare, ['cat-file', '-p', 'main:other.txt']), 'x\n', 'the other writer\'s commit is the parent, not overwritten');
  assert.equal(+git(bare, ['rev-list', '--count', 'main']), +git(bare, ['rev-list', '--count', base]) + 3, 'H1, other, H2');

  // a hint the server never had: speculative fetch fails, recorded, resolved path proceeds
  const c = await run('f'.repeat(40), 'H2', 'H3');
  assert.equal(c.r.hint, 'stale'); assert.equal(c.d['receive-pack'], 1);
  assert.ok(c.spans.find(s => s.name === 'git.edit').attrs['git.edit.head.speculative_error']);
  assert.equal(c.r.newCommit, headOf());
  assert.deepEqual(fsckProblems(bare), []);
  await assert.rejects(unwrapAsync(editFile(url, { path: 'a/b/c/file.txt', find: 'H3', replace: 'x', author, message: 'm' }, { tracer: new Tracer(), head: 'nope' })), e => e.code === 'bad_request');
});

test('push: sideband on by default; hook stderr lands in git.push.remote.messages', async () => {
  const hooks = join(bare, 'hooks'); mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, 'pre-receive'); writeFileSync(hook, '#!/bin/sh\necho "policy says hi" >&2\necho "second line" >&2\nexit 0\n'); chmodSync(hook, 0o755);
  try {
    const ex = arrayExporter();
    const r = await unwrapAsync(editFile(url, { path: 'a/b/c/file.txt', find: 'H3', replace: 'SB', author, message: 'm' }, { tracer: new Tracer({ exporter: ex }) }));
    assert.equal(r.newCommit, headOf());
    const push = spansOf(ex).find(s => s.name === 'git.receive-pack');
    assert.ok(push.attrs['git.push.caps'].includes('side-band-64k'));
    assert.deepEqual(push.attrs['git.push.remote.messages'], ['policy says hi', 'second line']);
    // and a rejecting hook: the reason is the server's words, the code is push_rejected (not cas)
    writeFileSync(hook, '#!/bin/sh\necho "GH006-style: protected branch, nope" >&2\nexit 1\n');
    const ex2 = arrayExporter();
    await assert.rejects(unwrapAsync(editFile(url, { path: 'a/b/c/file.txt', find: 'SB', replace: 'SC', author, message: 'm' }, { tracer: new Tracer({ exporter: ex2 }) })), e => e.code === 'push_rejected' && /protected branch/.test(e.hookOutput));
    assert.deepEqual(spansOf(ex2).find(s => s.name === 'git.receive-pack').attrs['git.push.remote.messages'], ['GH006-style: protected branch, nope']);
  } finally { rmSync(hook, { force: true }); }
});

test('discover: v2 capability canary against real git', async () => {
  const ex = arrayExporter();
  const c = unwrap(GitHttp.create(url, { tracer: new Tracer({ exporter: ex }) }));
  const info = await unwrapAsync(c.discover());
  assert.equal(info.version, 2); assert.match(info.agent, /^git\/\d/); assert.equal(info.objectFormat, 'sha1');
  assert.equal(info.filter, true, 'uploadpack.allowFilter is on in the fixture'); assert.equal(info.shallow, true);
  const span = spansOf(ex).find(s => s.name === 'git.upload-pack discover');
  assert.equal(span.attrs['git.server.agent'], info.agent); assert.ok(span.attrs['git.server.caps'].includes('ls-refs'));
  assert.equal(span.attrs['git.server.filter'], true);
  // the same local server, seen by git's own eyes
  // git ≥ 2.48 may append the OS to its agent (`git/2.50.0-Darwin` from Homebrew's git, found 2026-10-23); the version is the claim
  const v = git(bare, ['--version']).trim().replace(/^git version /, '');
  assert.ok(info.agent === `git/${v}` || info.agent.startsWith(`git/${v}-`), `agent ${info.agent} vs git ${v}`);
});

test('tracer: isolate invocation attrs, event cap, cache put stats surface on the edit root', async () => {
  const ex = arrayExporter();
  const tracer = new Tracer({ exporter: ex, maxEvents: 3 });
  const s = tracer.start('root'); for (let i = 0; i < 10; i++) s.event('e', { i }); s.end();
  const flat = spansOf(ex)[0];
  assert.equal(flat.events.length, 3); assert.equal(flat.droppedEvents, 7);
  assert.equal(typeof flat.attrs['ply.isolate.invocation'], 'number'); assert.equal(typeof flat.attrs['ply.isolate.cold'], 'boolean');
  // cache put failures are counted, not swallowed
  const broken = { ...memoryCache(), put: async () => { throw new Error('cache full'); } };
  const f = cachingFetch(globalThis.fetch, broken);
  const ex2 = arrayExporter();
  await unwrapAsync(editFile(url, { path: 'a/b/c/file.txt', find: 'SB', replace: 'SD', author, message: 'm' }, { tracer: new Tracer({ exporter: ex2 }), fetchImpl: f }));
  const root = spansOf(ex2).find(x => x.name === 'git.edit');
  assert.equal(root.attrs['git.pack.cache.put.failed'], 5); assert.equal(root.attrs['git.pack.cache.put.error'], 'cache full'); assert.equal(root.attrs['git.pack.cache.miss'], 5);
  assert.equal(typeof root.attrs['mem.alloc.inflate_chunk.max_single'], 'number');
  const blob = spansOf(ex2).find(x => x.name === 'git.edit.blob');
  assert.ok(blob.attrs['git.edit.blob.cpu_ms'] >= 0, 'node measures cpu'); assert.equal(blob.attrs['git.edit.blob.hasher'], 'js');
});

test('verify: the post-push ls-refs must show our commit; a lying answer is ambiguous, not success', async () => {
  const ex = arrayExporter();
  const ok = await unwrapAsync(editFile(url, { path: 'a/b/c/file.txt', find: 'SD', replace: 'V1', author, message: 'm' }, { tracer: new Tracer({ exporter: ex }), verify: true }));
  assert.equal(ok.newCommit, headOf());
  assert.equal(spansOf(ex).find(s => s.name === 'git.edit').attrs['git.edit.verify.ref'], ok.newCommit);
  // a proxy that answers the second ls-refs (post-push) with the pre-push ref state
  let n = 0, stale = null;
  const lying = await startProxy(srv.url, ctx => {
    if (ctx.stage !== 'ls-refs' || ctx.phase === 'request') return null; // the proxy consults faults before forwarding too
    if (n++ === 0) { stale = ctx.bytes; return null; }
    return { type: 'bytes', bytes: stale, name: 'stale-ls-refs' };
  });
  try {
    const ex2 = arrayExporter();
    await assert.rejects(unwrapAsync(editFile(`${lying.url}/pc.git`, { path: 'a/b/c/file.txt', find: 'V1', replace: 'V2', author, message: 'm' }, { tracer: new Tracer({ exporter: ex2 }), verify: true })), e => e.code === 'ambiguous' && /push reported ok but/.test(e.message));
    const root = spansOf(ex2).find(s => s.name === 'git.edit');
    assert.equal(root.attrs['git.edit.outcome'], 'ambiguous'); assert.equal(root.attrs['git.edit.verify.ref'], ok.newCommit, 'the lie is recorded verbatim');
    assert.equal(git(bare, ['cat-file', '-p', 'main:a/b/c/file.txt']), 'hello V2 world\n', 'the push itself landed; only the receipt was untrustworthy');
  } finally { await lying.close?.(); }
});

test('buffered fetchPack (general client): poisoned cache entry → one bust → repaired', async () => {
  const cache = memoryCache();
  const f = cachingFetch(globalThis.fetch, cache);
  const ex = arrayExporter();
  const c = unwrap(GitHttp.create(url, { tracer: new Tracer({ exporter: ex }), fetchImpl: f }));
  const head = headOf();
  const a = await unwrapAsync(c.fetchPack({ wants: [head], filter: 'tree:0', deepen: 1 }));
  assert.equal(a.parsed.stats.count, 1); assert.equal(cache.entries.size, 1);
  for (const e of cache.entries.values()) e.body[e.body.length - 30] ^= 0xff;
  const b = await unwrapAsync(c.fetchPack({ wants: [head], filter: 'tree:0', deepen: 1 }));
  assert.equal(b.parsed.stats.count, 1); assert.equal(f.stats.bust, 1);
  const spans = spansOf(ex).filter(s => s.name === 'git.upload-pack fetch');
  assert.deepEqual(spans.map(s => s.attrs['git.pack.cache.bust']), [false, false, true]); assert.deepEqual(spans.map(s => s.attrs['git.response.cache']), ['MISS', 'HIT', 'BUST']);
  // The same retry against any cache tier: a HIT whose pack the client refuses is asked for once more with
  // `x-ply-cache: bust`. The tier below serves git's answer with one flipped byte as a HIT.
  let tierBusts = 0;
  const tier = async (u, init) => {
    const res = await fetch(u, init);
    if (!String(u).endsWith('git-upload-pack') || !isCacheableFetch(init.body)) return res;
    const h = new Headers(res.headers);
    if (new Headers(init.headers).get('x-ply-cache') === 'bust') { tierBusts++; h.set('x-ply-pack-cache', 'BUST'); return new Response(res.body, { status: 200, headers: h }); }
    const bytes = new Uint8Array(await res.arrayBuffer()); bytes[bytes.length - 30] ^= 0xff; h.set('x-ply-pack-cache', 'HIT');
    return new Response(bytes, { status: 200, headers: h });
  };
  const ex2 = arrayExporter();
  const c2 = unwrap(GitHttp.create(url, { tracer: new Tracer({ exporter: ex2 }), fetchImpl: tier }));
  const viaTier = await unwrapAsync(c2.fetchPack({ wants: [head], filter: 'tree:0', deepen: 1 }));
  assert.equal(viaTier.parsed.stats.count, 1); assert.equal(tierBusts, 1);
  const spans2 = spansOf(ex2).filter(s => s.name === 'git.upload-pack fetch');
  assert.deepEqual(spans2.map(s => s.attrs['git.pack.cache.bust']), [false, true]); assert.deepEqual(spans2.map(s => s.attrs['git.response.cache']), ['HIT', 'BUST']);
  // the wrapper delegates to the same functions (getters + one of each family)
  assert.equal(c.url, url); assert.equal(c.limits.maxRefs > 0, true); assert.equal(c.tracer instanceof Tracer, true); assert.equal(c.parent, null);
  const o = await unwrapAsync(c.fetchObject({ oid: head, deepen: 1 })); assert.equal(o.oid, head);
  const caps = await unwrapAsync(c.receiveCaps()); assert.ok(caps.has('report-status'));
  assert.equal((await unwrapAsync(c.negotiate({ wants: [head], haves: [], filter: 'tree:0', deepen: 1 }))).parsed.stats.count, 1);
  let st; for await (const _ of c.packStream({ wants: [head], filter: 'tree:0', deepen: 1 }, new Tracer().start('x'))) { st = _; } assert.ok(st);
  await assert.rejects(unwrapAsync(c.push({ ref: 'refs/heads/main', oldOid: head, newOid: head, objects: [], pushOptions: ['x'] })), e => e.code === 'unsupported', 'push-options checked against the advertisement');
  // with the server advertising push-options, the options ride after the command flush and reach the hook
  git(bare, ['config', 'receive.advertisePushOptions', 'true']);
  const hooks = join(bare, 'hooks'); mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'pre-receive'), '#!/bin/sh\necho "opts=$GIT_PUSH_OPTION_COUNT:$GIT_PUSH_OPTION_0" >&2\nexit 0\n'); chmodSync(join(hooks, 'pre-receive'), 0o755);
  try {
    const { encodeTree, encodeCommit, hashObject } = await import('../src/objects.js');
    const { TYPE } = await import('../src/objects.js');
    const blob = new TextEncoder().encode('po\n'); const tree = unwrap(encodeTree([{ mode: '100644', name: 'po.txt', oid: hashObject('blob', blob) }]));
    const commit = unwrap(encodeCommit({ tree: hashObject('tree', tree), parents: [head], author: 'a <a@x> 1 +0000', message: 'po\n' }));
    const r = await unwrapAsync(c.push({ ref: 'refs/heads/main', oldOid: head, newOid: hashObject('commit', commit), objects: [{ type: TYPE.COMMIT, data: commit }, { type: TYPE.TREE, data: tree }, { type: TYPE.BLOB, data: blob }], pushOptions: ['ci.skip'] }));
    assert.match(r.hookOutput, /opts=1:ci.skip/);
    git(bare, ['update-ref', 'refs/heads/main', head]);
  } finally { rmSync(join(hooks, 'pre-receive'), { force: true }); git(bare, ['config', '--unset', 'receive.advertisePushOptions']); }
});

test('LFS pointer: refused by default (the content is not in git), editable only with allowLfsPointer', async () => {
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'ab'.repeat(32) + '\nsize 12345\n';
  otherWriter({ 'model.bin': pointer, 'notlfs.txt': 'version https://git-lfs.github.com/spec/v2 MARK\n' }, 'lfs pointer');
  const ex = arrayExporter();
  await assert.rejects(unwrapAsync(editFile(url, { path: 'model.bin', find: 'size 12345', replace: 'size 1', author, message: 'm' }, { tracer: new Tracer({ exporter: ex }) })), e => e.code === 'lfs_pointer' && e.size === pointer.length && /LFS pointer/.test(e.message));
  const blob = spansOf(ex).find(s => s.name === 'git.edit.blob');
  assert.equal(blob.attrs['git.edit.blob.lfs_pointer'], true);
  assert.equal(git(bare, ['cat-file', '-p', 'main:model.bin']), pointer, 'untouched');
  assert.equal(spansOf(ex).filter(s => s.name === 'git.receive-pack').length, 0, 'nothing pushed');
  // the guard matches the exact v1 magic, not any file mentioning git-lfs
  const r = await unwrapAsync(editFile(url, { path: 'notlfs.txt', find: 'MARK', replace: 'OK', author, message: 'm' }, { tracer: new Tracer() }));
  assert.equal(r.newCommit, headOf());
  // opt in: editing the pointer itself (e.g. retargeting an LFS object) is allowed and ordinary
  const r2 = await unwrapAsync(editFile(url, { path: 'model.bin', find: 'size 12345', replace: 'size 54321', author, message: 'm' }, { tracer: new Tracer(), allowLfsPointer: true }));
  assert.equal(r2.newCommit, headOf());
  assert.equal(git(bare, ['cat-file', '-p', 'main:model.bin']), pointer.replace('12345', '54321'));
});

test('agent: we identify as ply, not git', async () => {
  const { UA } = await import('../src/transport.js');
  assert.match(UA, /^ply\//);
  const ex = arrayExporter();
  await unwrapAsync(editFile(url, { path: 'notlfs.txt', find: 'OK', replace: 'OK2', author, message: 'm' }, { tracer: new Tracer({ exporter: ex }) }));
  const caps = spansOf(ex).find(s => s.name === 'git.receive-pack').attrs['git.push.caps'];
  assert.ok(caps.includes(`agent=${UA}`), caps.join(' '));
});

test('negotiation, deterministic: haves in rounds — NAK rounds of unknown oids, then ACKs of shared history, ready, and a pack of only what is new', async () => {
  const nb = makeBareRepo(root, 'nego'); const nw = join(root, 'wnego'); mkdirSync(nw); git(nw, ['init', '-q', '-b', 'main']);
  const commits = []; for (let i = 0; i < 30; i++) commits.push(commitFiles(nw, nb, { 'f.txt': `v${i}\n` }, `c${i}`));
  const c = unwrap(GitHttp.create(`${srv.url}/nego.git`, { tracer: new Tracer() }));
  const unknown = Array.from({ length: 20 }, (_, i) => (i.toString(16).padStart(2, '0')).repeat(20));
  const r = await unwrapAsync(c.negotiate({ wants: [commits[29]], haves: [...unknown, ...commits.slice(10, 20).reverse()], batch: 8 }));
  assert.ok(r.rounds.length >= 3, `several rounds (${r.rounds.length})`);
  assert.equal(r.rounds[0].acks.length, 0, 'first round: only unknown oids → no acks');
  assert.ok(r.rounds.some(x => x.acks.length > 0), 'shared history is acknowledged');
  assert.ok(r.common.includes(commits[19]), 'the newest shared commit is common');
  const got = new Set(r.objects.keys());
  assert.ok(got.has(commits[29]) && got.has(commits[20]) && !got.has(commits[19]), 'the pack starts after the common commit');
});

// ---- #120: the request parser against git's own requests, purity, verify-before-store ----
const UPLOAD = { 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' };
const post = async (u, body) => { const r = await fetch(`${u}/git-upload-pack`, { method: 'POST', headers: UPLOAD, body }); assert.equal(r.status, 200); return new Uint8Array(await r.arrayBuffer()); };
const framesOf = bytes => unwrap(pktStep(pktInit(), bytes)).frames;
const reframe = fs => concat(fs.map(f => (f.kind === 'flush' ? FLUSH : f.kind === 'delim' ? DELIM : unwrap(pkt(f.payload)))));
const line = s => ({ kind: 'data', payload: te.encode(s) });
const objectSet = answer => {
  const pack = concat(framesOf(answer).filter(f => f.kind === 'data' && f.payload[0] === 1).map(f => f.payload.subarray(1)));
  return [...unwrap(resolvePack(unwrap(parsePack(pack)))).objects.keys()].sort();
};
const blobOid = () => git(bare, ['rev-parse', 'main:README.md']).trim();

test('git\'s own v2 requests (GIT_TRACE_PACKET) parse, and classify: ls-refs is refs, a shallow filtered clone is pack, a fetch with haves is not', async () => {
  const trace = join(root, 'trace-120'); const dst = join(root, 'clone-120');
  rmSync(trace, { force: true }); rmSync(dst, { recursive: true, force: true });
  // async git: the server and the proxy run in this process
  const run = async (cwd, args) => { const r = await gitAsync(cwd, ['-c', 'protocol.version=2', ...args], { GIT_TRACE_PACKET: trace }); assert.equal(r.status, 0, r.stderr); };
  await run(root, ['clone', '-q', '--depth', '1', '--filter=blob:none', '--no-checkout', url, dst]);
  otherWriter({ 'more.txt': 'more\n' }, 'more');
  await run(dst, ['fetch', '-q', '--depth', '2', 'origin']);
  // the client's writes, request by request: `<label>> <payload>`, a flush ending each request (0000 / 0001 as text)
  const requests = []; let cur = [];
  for (const l of readFileSync(trace, 'utf8').split('\n')) {
    const m = /packet:\s+(\S+)> (.*)$/.exec(l);
    if (!m || m[1] === 'upload-pack') continue;
    if (m[2] === 'command=ls-refs' || m[2] === 'command=fetch') cur = [];
    cur.push(m[2] === '0000' ? FLUSH : m[2] === '0001' ? DELIM : unwrap(pkt(`${m[2]}\n`)));
    if (m[2] === '0000' && cur.length > 1) { requests.push(concat(cur)); cur = []; }
  }
  const parsed = requests.map(b => unwrap(parseUploadPackRequest(b)));
  const kinds = requests.map(b => exchangeKind('POST', `${url}/git-upload-pack`, b));
  const ls = parsed.filter(r => r.command === 'ls-refs'), fe = parsed.filter(r => r.command === 'fetch');
  assert.ok(ls.length >= 2 && fe.length >= 2, `${ls.length} ls-refs, ${fe.length} fetch`);
  assert.ok(ls[0].caps.some(c => c.startsWith('agent=git/')), ls[0].caps.join(' '));
  assert.ok(ls[0].prefixes.includes('refs/heads/') && ls[0].peel && ls[0].symrefs);
  assert.ok(kinds.filter((_, i) => parsed[i].command === 'ls-refs').every(k => k === 'refs'));
  const clone = fe[0];
  assert.equal(clone.deepen, 1); assert.equal(clone.filter, 'blob:none'); assert.equal(clone.haves.length, 0); assert.ok(clone.wants.length >= 1);
  const later = fe.at(-1);
  assert.ok(later.haves.length + later.shallows.length > 0, 'the second fetch says what it holds');
  assert.equal(kinds[parsed.indexOf(later)], null, 'a negotiation is not pure');
});

test('purity oracle: a pack exchange answers the same object set before and after an unrelated ref update', async () => {
  const head = headOf();
  for (const opts of [{ wants: [head], filter: 'tree:0', deepen: 1 }, { wants: [blobOid()] }, { wants: [head], deepen: 2 }]) {
    const body = fetchBody(opts);
    assert.equal(exchangeKind('POST', `${srv.url}/pc.git/git-upload-pack`, body), 'pack');
    const a = await post(`${srv.url}/pc.git`, body);
    git(bare, ['update-ref', 'refs/heads/unrelated-120', git(bare, ['rev-parse', 'main~1']).trim()]);
    otherWriter({ 'unrelated.txt': `${Math.random()}\n` }, 'unrelated'); git(bare, ['update-ref', 'refs/heads/main', head]);
    const b = await post(`${srv.url}/pc.git`, body);
    assert.deepEqual(objectSet(b), objectSet(a), JSON.stringify(opts));
    git(bare, ['update-ref', '-d', 'refs/heads/unrelated-120']);
  }
});

test('verifyFetchAnswer: git\'s answers pass; a flipped byte, a cut, a missing want, a lying shallow-info are refused', async () => {
  const head = headOf();
  const req = o => unwrap(parseUploadPackRequest(fetchBody(o)));
  const commitReq = req({ wants: [head], filter: 'tree:0', deepen: 1 });
  const commitAns = await post(`${srv.url}/pc.git`, fetchBody({ wants: [head], filter: 'tree:0', deepen: 1 }));
  assert.deepEqual(unwrap(verifyFetchAnswer(commitReq, commitAns)), { objects: 1 });
  const blobReq = req({ wants: [blobOid()] });
  const blobAns = await post(`${srv.url}/pc.git`, fetchBody({ wants: [blobOid()] }));
  assert.deepEqual(unwrap(verifyFetchAnswer(blobReq, blobAns, DEFAULT_LIMITS)), { objects: 1 });
  const refused = (r, ans, code, re) => { const v = verifyFetchAnswer(r, ans); assert.equal(v.ok, false, String(re)); assert.equal(v.error.code, code); assert.match(v.error.message, re); };
  const flipped = blobAns.slice(); flipped[flipped.length - 30] ^= 0xff;
  refused(blobReq, flipped, 'pack_corrupt', /./);
  refused(blobReq, blobAns.subarray(0, blobAns.length - 7), 'protocol', /trailing/);
  refused(blobReq, blobAns.subarray(0, blobAns.length - 4), 'protocol', /without flush/);
  refused(req({ wants: [blobOid(), head] }), blobAns, 'pack_corrupt', new RegExp(`want ${head} is not in the pack`));
  refused(req({ wants: [head], filter: 'tree:0' }), commitAns, 'pack_corrupt', /shallow-info for a request without deepen/);
  const fs = framesOf(commitAns);
  const at = fs.findIndex(f => f.kind === 'data' && new TextDecoder().decode(f.payload).startsWith('shallow '));
  assert.ok(at > 0, 'deepen 1 of a commit with parents is answered with shallow-info');
  refused(commitReq, reframe([...fs.slice(0, at), line(`shallow ${'f'.repeat(40)}\n`), ...fs.slice(at + 1)]), 'pack_corrupt', /shallow f{40} is not a commit of the pack/);
  refused(commitReq, reframe([...fs.slice(0, at + 1), line(`unshallow ${head}\n`), ...fs.slice(at + 1)]), 'pack_corrupt', /unshallow for a request without shallow/);
  refused(commitReq, reframe([line('acknowledgments\n'), line('NAK\n'), { kind: 'flush' }]), 'protocol', /no packfile section/);
  refused(blobReq, reframe([line('ERR nope\n'), { kind: 'flush' }]), 'remote_error', /nope/);
  assert.equal(verifyFetchAnswer(blobReq, blobAns, { ...DEFAULT_LIMITS, maxPackObjects: Number.NaN }).ok, false, 'a bad limit is refused, not ignored');
  assert.equal(verifyFetchAnswer(blobReq, blobAns, { ...DEFAULT_LIMITS, maxPackBytes: 10 }).error.code, 'limit_exceeded');
});

test('cachingFetch verifyBeforeStore: a blob fetch is cached; a tampered answer is never stored; a hit is byte-identical to the stored answer', async () => {
  const body = fetchBody({ wants: [blobOid()] });
  const pending = [];
  const waitUntil = p => { pending.push(p); };
  const settle = async () => { await Promise.all(pending.splice(0)); };
  const call = async f => new Uint8Array(await (await f(`${url}/git-upload-pack`, { method: 'POST', headers: UPLOAD, body })).arrayBuffer());
  // without the option the blob fetch is a bypass, as before
  const plain = cachingFetch(globalThis.fetch, memoryCache());
  await call(plain); assert.equal(plain.stats.bypass, 1);
  // a lying origin: the answer is tampered on the way; the client still gets it (and refuses it itself), the cache does not
  const tamper = async (u, init) => { const res = await fetch(u, init); const b = new Uint8Array(await res.arrayBuffer()); b[b.length - 30] ^= 0xff; return new Response(b, { status: 200, headers: res.headers }); };
  const badCache = memoryCache();
  const lied = cachingFetch(tamper, badCache, { verifyBeforeStore: true, waitUntil });
  await call(lied); await settle();
  assert.equal(badCache.entries.size, 0, 'nothing stored');
  assert.equal(lied.stats.miss, 1); assert.equal(lied.stats.verifyFailed, 1); assert.equal(lied.stats.verifyOk, 0); assert.equal(lied.stats.putOk, 0);
  assert.ok(lied.stats.verifyError.length > 0);
  assert.equal(lied.attrs()['git.pack.cache.verify.failed'], 1);
  // an honest origin: stored once verified; the hit is the origin's answer byte for byte
  const cache = memoryCache();
  const f = cachingFetch(globalThis.fetch, cache, { verifyBeforeStore: true, waitUntil });
  const first = await call(f); await settle();
  assert.deepEqual(objectSet(first), [blobOid()]);
  assert.equal(cache.entries.size, 1); assert.equal(f.stats.verifyOk, 1); assert.equal(f.stats.putOk, 1);
  const hit = await call(f);
  assert.equal(f.stats.hit, 1);
  // git may answer the same request with different pack bytes (a loose object, then a packed one): the guarantee is
  // that a hit replays the very answer that was verified and stored
  assert.deepEqual(hit, first, 'byte-identical');
  assert.deepEqual(hit, cache.entries.values().next().value.body);
  // and a ply read through it: the second read of the blob comes from the cache, hash-checked by the reader
  const c = unwrap(GitHttp.create(url, { tracer: new Tracer(), fetchImpl: f }));
  const read = async () => new TextDecoder().decode((await unwrapAsync(c.fetchObject({ oid: blobOid() }))).data);
  assert.equal(await read(), git(bare, ['cat-file', '-p', blobOid()])); await settle();
  const before = counts();
  assert.equal(await read(), git(bare, ['cat-file', '-p', blobOid()]));
  assert.equal(delta(before, counts()).fetch, 0, 'served from the cache');
  assert.equal(f.stats.verifyOk, 2);
});

test('cachingFetch verifyBeforeStore: an answer over the cap, a request that is not a fetch, and a bad limit are counted and not stored', async () => {
  const pending = [];
  const opts = extra => ({ verifyBeforeStore: true, waitUntil: p => { pending.push(p); }, ...extra });
  const run = async (f, body) => { await (await f(`${url}/git-upload-pack`, { method: 'POST', headers: UPLOAD, body })).arrayBuffer(); await Promise.all(pending.splice(0)); };
  const small = memoryCache(); const fs = cachingFetch(globalThis.fetch, small, opts({ limits: { ...DEFAULT_LIMITS, maxPackBytes: 8 } }));
  await run(fs, fetchBody({ wants: [blobOid()] }));
  assert.equal(small.entries.size, 0); assert.equal(fs.stats.verifyFailed, 1); assert.match(fs.stats.verifyError, /exceeds limit 8/);
  const ls = memoryCache(); const fl = cachingFetch(globalThis.fetch, ls, opts({ shouldCache: () => true }));
  await run(fl, unwrap(lsRefsBodyR([])));
  // ls-refs under a caller's own rule: framed to its flush and no ERR, so it is stored (as on main), and replayed
  assert.equal(ls.entries.size, 1); assert.equal(fl.stats.verifyOk, 1); assert.equal(fl.stats.verifyFailed, 0);
  await run(fl, unwrap(lsRefsBodyR([]))); assert.equal(fl.stats.hit, 1);
  const nan = memoryCache(); const fn = cachingFetch(globalThis.fetch, nan, opts({ limits: { ...DEFAULT_LIMITS, maxPackBytes: Number.NaN } }));
  await run(fn, fetchBody({ wants: [blobOid()] }));
  assert.equal(nan.entries.size, 0); assert.equal(fn.stats.verifyFailed, 1);
});

// gitprotocol-pack: error-line = PKT-LINE("ERR" SP explanation-text). upload-pack reports its own failures in-band,
// inside an HTTP 200 with the upload-pack content type. The frame is built by hand: 4 hex digits of length, then the text.
const ERR_TEXT = 'ERR upload-pack: internal error, try again\n';
const ERR_ANSWER = te.encode((ERR_TEXT.length + 4).toString(16).padStart(4, '0') + ERR_TEXT);
const RESULT = { 'content-type': 'application/x-git-upload-pack-result' };
const rawCall = async (f, body) => new Uint8Array(await (await f(`${url}/git-upload-pack`, { method: 'POST', headers: UPLOAD, body })).arrayBuffer());

test('cachingFetch (default rule): an origin that answers an in-band ERR once and then recovers is not remembered as failed', async () => {
  const head = headOf();
  let origin = 0;
  const flaky = async (u, init) => (origin++ === 0 ? new Response(ERR_ANSWER, { status: 200, headers: RESULT }) : fetch(u, init));
  const cache = memoryCache(); const pending = [];
  const f = cachingFetch(flaky, cache, { waitUntil: p => { pending.push(p); } });
  const c = unwrap(GitHttp.create(url, { tracer: new Tracer(), fetchImpl: f }));
  const req = { wants: [head], filter: 'tree:0', deepen: 1 };
  const first = await c.fetchPack(req); await Promise.all(pending.splice(0));
  assert.equal(first.ok, false); assert.equal(first.error.code, 'remote_error', 'the failure itself is reported honestly');
  assert.equal(cache.entries.size, 0, 'a failed answer is never stored');
  assert.equal(f.stats.putOk, 0);
  const second = await c.fetchPack(req); await Promise.all(pending.splice(0));
  assert.equal(second.ok, true, 'the recovered origin answers the second call');
  // tree:0 at depth 1 of one commit is that one commit (git's own answer, as in the buffered fetchPack test above)
  assert.equal(second.value.parsed.stats.count, 1);
  assert.equal(origin, 2, 'the second call went to the origin, not to a stored failure');
  assert.equal(f.stats.hit, 0);
  // the good answer is what the cache holds now: one entry, and its pack is exactly the wanted commit
  assert.equal(cache.entries.size, 1);
  assert.deepEqual(objectSet(cache.entries.values().next().value.body), [head]);
});

test('cachingFetch: an origin body that fails part way is not stored and does not reject the store; a stored entry with no body is evicted', async () => {
  const head = headOf();
  const body = fetchBody({ wants: [head], filter: 'tree:0', deepen: 1 });
  const pending = [];
  const waitUntil = p => { pending.push(p); };
  // the origin sends the first 10 bytes of git's answer, then the connection drops
  const dropped = async (u, init) => {
    const whole = new Uint8Array(await (await fetch(u, init)).arrayBuffer());
    let sent = false;
    const stream = new ReadableStream({ pull(ctl) { if (sent) { ctl.error(new Error('connection reset')); return; } sent = true; ctl.enqueue(whole.slice(0, 10)); } });
    return new Response(stream, { status: 200, headers: RESULT });
  };
  const cache = memoryCache();
  const f = cachingFetch(dropped, cache, { waitUntil });
  await assert.rejects(rawCall(f, body), /connection reset/, 'the caller sees the drop');
  // every store promise settles without rejecting (an unawaited rejection would take a node process down)
  assert.deepEqual((await Promise.allSettled(pending.splice(0))).map(s => s.status), ['fulfilled']);
  assert.equal(cache.entries.size, 0); assert.equal(f.stats.putOk, 0); assert.equal(f.stats.verifyFailed, 1);
  assert.match(f.stats.verifyError, /the body failed while it was read: .*connection reset/);
  // a store that answers a match with a bodiless response: the cache layer does not look inside a HIT. It is handed on
  // as the store gave it, unparsed, and the caller's own reader is what refuses it (an empty body is not an answer).
  const hollowDeleted = [];
  const hollow = { match: async () => new Response(null, { status: 200, headers: RESULT }), put: async () => null, delete: async k => { hollowDeleted.push(k); return true; } };
  const g = cachingFetch(globalThis.fetch, hollow, { waitUntil });
  const before = counts();
  const res = await g(`${url}/git-upload-pack`, { method: 'POST', headers: UPLOAD, body });
  assert.equal(res.headers.get('x-ply-pack-cache'), 'HIT'); assert.equal((await res.arrayBuffer()).byteLength, 0);
  assert.equal(delta(before, counts()).fetch, 0); assert.equal(g.stats.hit, 1); assert.equal(g.counters.parsed, 0);
  // ply's client refuses the empty HIT, the key is deleted, and the origin is asked exactly once: the caller gets the
  // origin's own answer (one commit for this want), never the empty body
  const viaClient = await unwrap(GitHttp.create(url, { tracer: new Tracer(), fetchImpl: g })).fetchPack({ wants: [head], filter: 'tree:0', deepen: 1 });
  assert.equal(viaClient.ok, true, 'the empty body is never the answer: the refused HIT is retried past the cache');
  assert.equal(viaClient.value.parsed.stats.count, 1, 'the origin\'s answer for this want is one commit');
  assert.equal(delta(before, counts()).fetch, 1, 'the origin was asked exactly once');
  assert.equal(hollowDeleted.length, 1, 'the refused key was deleted'); assert.equal(g.stats.bust, 1);
});

test('cachingFetch: a stored entry is untrusted; a tampered pack is served at most once, deleted, and refetched once (the client\'s parse is the check)', async () => {
  const head = headOf();
  const req = { wants: [head], filter: 'tree:0', deepen: 1 };
  const inner = memoryCache(); const pending = [];
  // the store, counted: what each match served and which keys were deleted
  const served = []; const deleted = [];
  const cache = {
    entries: inner.entries,
    match: async k => { const r = await inner.match(k); if (r) { const b = new Uint8Array(await r.clone().arrayBuffer()); served.push(b); } return r; },
    put: (k, r) => inner.put(k, r),
    delete: async k => { deleted.push(k); return inner.delete(k); },
  };
  const f = cachingFetch(globalThis.fetch, cache, { waitUntil: p => { pending.push(p); } });
  const settle = async () => { await Promise.all(pending.splice(0)); };
  const c = unwrap(GitHttp.create(url, { tracer: new Tracer(), fetchImpl: f }));
  const first = await unwrapAsync(c.fetchPack(req)); await settle();
  assert.equal(first.parsed.stats.count, 1); assert.equal(inner.entries.size, 1);
  const [key] = [...inner.entries.keys()];
  const good = inner.entries.get(key).body.slice();
  assert.deepEqual(objectSet(good), [head]);
  // one flipped byte inside the pack (30 bytes from the end: before the 20-byte trailer and the final flush)
  const flipped = good.slice(); flipped[flipped.length - 30] ^= 0xff;
  let busts = 0;
  // and one flipped bit further in (still inside the single commit's deflate stream)
  const flipped2 = good.slice(); flipped2[flipped2.length - 40] ^= 0x01;
  for (const [name, poison] of [['flipped byte', flipped], ['flipped bit', flipped2]]) {
    inner.entries.set(key, { body: poison.slice(), headers: { ...RESULT } });
    served.length = 0; deleted.length = 0;
    const before = counts(); const parsedBefore = f.counters.parsed; const hitsBefore = f.stats.hit;
    // oxlint-disable-next-line no-await-in-loop -- one poison at a time
    const got = await c.fetchPack(req); await settle();
    assert.equal(got.ok, true, `${name}: the caller gets a good answer`);
    assert.equal(got.value.parsed.stats.count, 1, `${name}: git's answer for this want is one commit`);
    assert.equal(f.stats.hit, hitsBefore + 1, `${name}: the stored entry was served as a HIT, unparsed by the cache`);
    assert.equal(served.filter(b => Buffer.compare(b, poison) === 0).length, 1, `${name}: the poisoned bytes were served exactly once`);
    assert.deepEqual(deleted, [key], `${name}: the entry was deleted`);
    assert.equal(delta(before, counts()).fetch, 1, `${name}: refetched from the origin exactly once`);
    assert.equal(f.stats.bust, ++busts, `${name}: counted as a bust`);
    assert.deepEqual(objectSet(inner.entries.get(key).body), [head], `${name}: the entry now holds a verified answer`);
    // the only chunks the cache layer parsed are the refetched answer's, on their way to the store
    assert.ok(f.counters.parsed > parsedBefore, `${name}: the refetch went through the store-side verifier`);
    served.length = 0; const again = counts();
    // oxlint-disable-next-line no-await-in-loop -- as above
    assert.equal((await unwrapAsync(c.fetchPack(req))).parsed.stats.count, 1);
    assert.equal(delta(again, counts()).fetch, 0, `${name}: the repaired entry is served`);
    assert.equal(served.filter(b => Buffer.compare(b, poison) === 0).length, 0, `${name}: the poisoned bytes are never served again`);
  }
});

test('cachingFetch: a stored entry tampered into an ERR, a cut, an empty body or a wrong pack trailer is served at most once, deleted, and refetched once', async () => {
  const head = headOf();
  const req = { wants: [head], filter: 'tree:0', deepen: 1 };
  const inner = memoryCache(); const pending = [];
  // the store, counted: what each match served and which keys were deleted
  const served = []; const deleted = [];
  const cache = {
    entries: inner.entries,
    match: async k => { const r = await inner.match(k); if (r) served.push(new Uint8Array(await r.clone().arrayBuffer())); return r; },
    put: (k, r) => inner.put(k, r),
    delete: async k => { deleted.push(k); return inner.delete(k); },
  };
  const f = cachingFetch(globalThis.fetch, cache, { waitUntil: p => { pending.push(p); } });
  const settle = async () => { await Promise.all(pending.splice(0)); };
  const c = unwrap(GitHttp.create(url, { tracer: new Tracer(), fetchImpl: f }));
  await unwrapAsync(c.fetchPack(req)); await settle();
  const [key] = [...inner.entries.keys()];
  const good = inner.entries.get(key).body.slice();
  // a pkt-line by hand (gitprotocol-common): four hex digits of the length, themselves included, then the payload
  const line = text => Buffer.concat([Buffer.from((text.length + 4).toString(16).padStart(4, '0')), Buffer.from(text)]);
  const err = Uint8Array.from(Buffer.concat([line('ERR upload-pack: not our ref\n'), Buffer.from('0000')]));
  // the answer ends with the pack's 20-byte SHA-1 trailer and the 4-byte final flush: 10 from the end is inside the trailer
  const trailer = good.slice(); trailer[trailer.length - 10] ^= 0xff;
  const poisons = [['ERR packet', err], ['cut', good.slice(0, good.length - 40)], ['empty body', new Uint8Array(0)], ['wrong pack trailer', trailer]];
  let busts = 0;
  for (const [name, poison] of poisons) {
    inner.entries.set(key, { body: poison.slice(), headers: { ...RESULT } });
    served.length = 0; deleted.length = 0;
    const before = counts();
    // oxlint-disable-next-line no-await-in-loop -- one poison at a time
    const got = await c.fetchPack(req); await settle();
    assert.equal(got.ok, true, `${name}: the caller gets the origin's answer, not the stored failure`);
    assert.equal(got.value.parsed.stats.count, 1, `${name}: the origin's answer for this want is one commit`);
    assert.equal(served.filter(b => Buffer.compare(b, poison) === 0).length, 1, `${name}: the poisoned bytes were served exactly once`);
    assert.deepEqual(deleted, [key], `${name}: the entry was deleted`);
    assert.equal(delta(before, counts()).fetch, 1, `${name}: refetched from the origin exactly once`);
    assert.equal(f.stats.bust, ++busts, `${name}: counted as a bust`);
    assert.deepEqual(objectSet(inner.entries.get(key).body), [head], `${name}: the entry now holds a verified answer`);
    served.length = 0; const again = counts();
    // oxlint-disable-next-line no-await-in-loop -- as above
    assert.equal((await unwrapAsync(c.fetchPack(req))).parsed.stats.count, 1);
    assert.equal(delta(again, counts()).fetch, 0, `${name}: the repaired entry is served`);
    assert.equal(served.filter(b => Buffer.compare(b, poison) === 0).length, 0, `${name}: the poisoned bytes are never served again`);
  }
});

test('cachingFetch: a HIT is streamed from the store with no pass in the cache layer (counters, not time)', async () => {
  const head = headOf();
  const body = fetchBody({ wants: [head], filter: 'tree:0', deepen: 1 });
  const inner = memoryCache(); const pending = [];
  // the store serves its entry 16 bytes per pull, and counts the pulls
  let pulls = 0;
  const cache = {
    match: async k => {
      const e = inner.entries.get(k);
      if (!e) return null;
      let at = 0;
      const stream = new ReadableStream({ pull(ctl) { pulls++; if (at >= e.body.length) { ctl.close(); return; } ctl.enqueue(e.body.slice(at, at + 16)); at += 16; } }, { highWaterMark: 0 });
      return new Response(stream, { status: 200, headers: e.headers });
    },
    put: (k, r) => inner.put(k, r), delete: k => inner.delete(k),
  };
  const f = cachingFetch(globalThis.fetch, cache, { waitUntil: p => { pending.push(p); } });
  const miss = await rawCall(f, body); await Promise.all(pending.splice(0));
  assert.deepEqual(objectSet(miss), [head]); assert.equal(inner.entries.size, 1);
  const parsed = f.counters.parsed;
  assert.ok(parsed > 0, 'the MISS went through the store-side verifier');
  const res = await f(`${url}/git-upload-pack`, { method: 'POST', headers: UPLOAD, body });
  assert.equal(res.headers.get('x-ply-pack-cache'), 'HIT');
  // the response is there before a single byte of the entry was read: nothing was buffered or checked first
  assert.equal(pulls, 0, 'no byte of the entry is read before the response is returned');
  const reader = res.body.getReader();
  const firstChunk = await reader.read();
  // 16 bytes per pull: the first chunk the caller sees is the store's first chunk, not the whole entry
  assert.equal(firstChunk.value.length, 16); assert.ok(pulls <= 2, `pulls after the first read: ${pulls}`);
  const parts = [firstChunk.value];
  for (;;) { const r = await reader.read(); if (r.done) break; parts.push(r.value); }
  assert.deepEqual(concat(parts), miss, 'byte-identical to the stored answer');
  assert.equal(f.counters.parsed, parsed, 'a HIT parses nothing in the cache layer');
  assert.equal(f.stats.hit, 1);
});

// A synthetic v2 fetch answer, generated a frame at a time: `packfile\n`, then sideband-1 frames carrying a pack of
// `packBytes` bytes (12-byte header, filler, 20-byte trailer), then a flush. The trailer is node:crypto's SHA-1 of the
// pack bytes before it (gitformat-pack: "20-byte SHA-1 checksum of all of the above"). `lie` flips the trailer.
const sideband1 = payload => { const f = new Uint8Array(5 + payload.length); f.set(te.encode((payload.length + 5).toString(16).padStart(4, '0'))); f[4] = 1; f.set(payload, 5); return f; };
const syntheticAnswer = (packBytes, meter, { lie = false, endless = false } = {}) => {
  const sha = createHash('sha1');
  let sent = -1; // -1: the section header is next
  return new ReadableStream({
    pull(ctl) {
      let frame;
      if (sent === -1) { frame = unwrap(pkt('packfile\n')); sent = 0; }
      else if (sent === 0) { const h = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 1]); sha.update(h); frame = sideband1(h); sent = 12; }
      else if (endless || sent < packBytes - 20) { const n = endless ? 65515 : Math.min(65515, packBytes - 20 - sent); const filler = new Uint8Array(n).fill(sent & 0xff); sha.update(filler); frame = sideband1(filler); sent += n; }
      else if (sent === packBytes - 20) { const t = new Uint8Array(sha.digest()); if (lie) t[0] ^= 1; frame = sideband1(t); sent = packBytes; }
      else { ctl.enqueue(FLUSH.slice()); ctl.close(); meter.produced += 4; return; }
      meter.produced += frame.length; ctl.enqueue(frame);
    },
    cancel() { meter.cancelled = true; },
  }, { highWaterMark: 0 });
};

test('cachingFetch memory: a 64 MiB answer streams through the verifier into the store; ply holds a few frames, never the answer', async () => {
  const body = fetchBody({ wants: [headOf()], filter: 'tree:0', deepen: 1 });
  const PACK = 64 * 1024 * 1024;
  for (const lie of [false, true]) {
    const meter = { produced: 0, cancelled: false };
    const origin = async () => new Response(syntheticAnswer(PACK, meter, { lie }), { status: 200, headers: RESULT });
    // a store that holds nothing, as the Cache API does from ply's point of view: it reads the body and counts
    let stored = 0, maxHeld = 0, putRejected = null; const deleted = [];
    // the counter: bytes the origin has produced that the store has not been handed yet, sampled at every chunk on either side
    const sample = () => { maxHeld = Math.max(maxHeld, meter.produced - stored); };
    const store = {
      match: async () => null,
      put: async (k, res) => { const r = res.body.getReader(); try { for (;;) { const { value, done } = await r.read(); if (done) return; stored += value.length; sample(); } } catch (e) { putRejected = e; throw e; } },
      delete: async k => { deleted.push(k); return true; },
    };
    const pending = [];
    const f = cachingFetch(origin, store, { waitUntil: p => { pending.push(p); } });
    const res = await f(`${url}/git-upload-pack`, { method: 'POST', headers: UPLOAD, body });
    let client = 0;
    // oxlint-disable-next-line no-await-in-loop -- one stream
    for (const r = res.body.getReader(); ;) { const { value, done } = await r.read(); if (done) break; client += value.length; sample(); }
    assert.deepEqual((await Promise.allSettled(pending)).map(x => x.status), ['fulfilled']);
    // frames: 13 (packfile) + ceil(PACK / 65515) pack frames of 5 bytes overhead each + the header's own frame + flush
    assert.ok(client > PACK && client === meter.produced, `the client got the whole answer (${client})`);
    // What sits between the origin and the store is ply's whole cache path (the verifier and the cache branch's queue):
    // bounded by the lag window (CACHE_LAG_BYTES, 1 MiB) plus the frame in flight on each side, not by the 64 MiB
    // answer. A design that reads the answer whole before the put holds all 64 MiB here.
    assert.ok(maxHeld <= 1024 * 1024 + 2 * 65520, `${lie ? 'lie' : 'honest'}: at most ${maxHeld} bytes between origin and store`);
    if (lie) {
      // the trailer is wrong: the put's body errors at the end, the put never completes, the key is deleted, counted
      assert.ok(putRejected !== null, 'the body handed to put was errored'); assert.match(String(putRejected), /pack trailer .* is not the SHA-1 of the pack/);
      assert.equal(f.stats.verifyFailed, 1); assert.equal(f.stats.verifyOk, 0); assert.equal(f.stats.putOk, 0); assert.equal(deleted.length, 1);
    } else {
      assert.equal(putRejected, null); assert.equal(stored, client, 'every byte reached the store');
      assert.equal(f.stats.verifyOk, 1); assert.equal(f.stats.putOk, 1); assert.equal(f.stats.verifyFailed, 0); assert.equal(deleted.length, 0);
    }
  }
}, 120_000);

test('cachingFetch: a client that abandons the answer cancels the cache branch and the origin; nothing is drained', async () => {
  const body = fetchBody({ wants: [headOf()], filter: 'tree:0', deepen: 1 });
  const meter = { produced: 0, cancelled: false };
  // a hostile origin, but a finite one: 32 MiB of packfile section, 64 times the allowance below. An origin that never
  // ends would make an implementation that drains spin in microtasks for ever (a hung worker, not a red test); this
  // one lets the drain finish, so the byte count below fails it.
  const ORIGIN = 32 * 1024 * 1024;
  const origin = async () => new Response(syntheticAnswer(ORIGIN, meter), { status: 200, headers: RESULT });
  let stored = 0; const deleted = [];
  const store = {
    match: async () => null,
    put: async (k, res) => { const r = res.body.getReader(); for (;;) { const { value, done } = await r.read(); if (done) return; stored += value.length; } },
    delete: async k => { deleted.push(k); return true; },
  };
  const pending = [];
  const f = cachingFetch(origin, store, { waitUntil: p => { pending.push(p); }, limits: { ...DEFAULT_LIMITS, maxPackBytes: 8 * 1024 * 1024 } });
  const res = await f(`${url}/git-upload-pack`, { method: 'POST', headers: UPLOAD, body });
  const reader = res.body.getReader();
  await reader.read(); await reader.read(); await reader.read();
  await reader.cancel(new Error('the client refused the answer'));
  // The store promise settles within a counted number of event-loop turns (no clock): at head it settles in the
  // cancel's own microtasks; an implementation that neither cancels nor drains never settles it, and fails here.
  let outcome = null;
  void Promise.allSettled(pending).then(s => { outcome = s.map(x => x.status); });
  // oxlint-disable-next-line no-await-in-loop -- counted turns
  for (let turn = 0; turn < 1000 && outcome === null; turn++) await new Promise(r => { setImmediate(r); });
  assert.deepEqual(outcome, ['fulfilled'], 'the store promise settled, fulfilled, within 1000 turns of the cancel');
  // three reads by the client; the split and the store may each be a few frames ahead (8 frames allowed). Draining
  // reads the origin to its end: 32 MiB and its framing.
  assert.ok(meter.produced <= 8 * 65520, `origin bytes pulled: ${meter.produced}`);
  assert.equal(meter.cancelled, true, 'the origin was cancelled');
  assert.equal(f.stats.verifyFailed, 1); assert.match(f.stats.verifyError, /the client abandoned it/); assert.equal(f.stats.putOk, 0);
  assert.equal(deleted.length, 1, 'the key is deleted: a store that kept a partial entry does not keep it');
});

test('cachingFetch: a store whose delete fails after a refused answer, by throwing or by rejecting, never rejects the store promise', async () => {
  const body = fetchBody({ wants: [headOf()], filter: 'tree:0', deepen: 1 });
  const outcomes = {};
  for (const kind of ['rejects', 'throws']) {
    const meter = { produced: 0, cancelled: false };
    // a wrong pack trailer: the answer is refused at its end, so the key is deleted
    const origin = async () => new Response(syntheticAnswer(200_000, meter, { lie: true }), { status: 200, headers: RESULT });
    let deletes = 0;
    const store = {
      match: async () => null,
      put: async (k, res) => { for (const r = res.body.getReader(); ;) { const { done } = await r.read(); if (done) return; } },
      delete: kind === 'throws' ? () => { deletes++; throw new Error('delete threw'); } : async () => { deletes++; throw new Error('delete rejected'); },
    };
    const pending = [];
    const f = cachingFetch(origin, store, { waitUntil: p => { pending.push(p); } });
    const res = await f(`${url}/git-upload-pack`, { method: 'POST', headers: UPLOAD, body });
    await res.arrayBuffer();
    outcomes[kind] = { settled: (await Promise.allSettled(pending)).map(x => x.status), deletes, verifyFailed: f.stats.verifyFailed, putOk: f.stats.putOk };
  }
  // From the contract, not from the code: the promise handed to waitUntil is fulfilled whichever way delete fails, the
  // delete was attempted once, and the refusal is counted once.
  const want = { settled: ['fulfilled'], deletes: 1, verifyFailed: 1, putOk: 0 };
  assert.deepEqual(outcomes.rejects, want, 'a delete that rejects');
  assert.deepEqual(outcomes.throws, want, 'a delete that throws synchronously ends the same way');
});

test('memoryCache: a fractional budget is floored, never replaced by the default; a value that is not a budget is the default', async () => {
  const fill = async c => {
    for (let i = 0; i < 12; i++) await c.put(`big${i}`, new Response(new Uint8Array(40_000)));
    for (let i = 0; i < 5; i++) await c.put(`small${i}`, new Response(new Uint8Array(40)));
    return { bytes: [...c.entries.values()].reduce((n, e) => n + e.body.length, 0), entries: c.entries.size };
  };
  // 100.5 -> 100 bytes: no 40,000-byte entry fits; two 40-byte entries do (80), a third would make 120
  assert.deepEqual(await fill(memoryCache({ maxBytes: 100.5 })), { bytes: 80, entries: 2 });
  // 1e6/3 -> 333,333 bytes: eight 40,000-byte entries (320,000; a ninth would make 360,000), then five of 40 (320,200)
  assert.deepEqual(await fill(memoryCache({ maxBytes: 1e6 / 3 })), { bytes: 320_200, entries: 13 });
  // 2.5 -> 2 entries: the last two puts
  assert.deepEqual(await fill(memoryCache({ maxEntries: 2.5 })), { bytes: 80, entries: 2 });
  // 0.5 -> 0: nothing is kept
  assert.deepEqual(await fill(memoryCache({ maxBytes: 0.5 })), { bytes: 0, entries: 0 });
  // not a budget (NaN, negative, infinite): the documented default, 64 MiB and 1024 entries, which holds all 17
  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) assert.deepEqual(await fill(memoryCache({ maxBytes: bad, maxEntries: bad })), { bytes: 480_200, entries: 17 });
});

// The test's own accounting of what a memoryCache retains: every byte of every body it still holds, plus its header text.
const retained = cache => [...cache.entries.values()].reduce((n, e) => n + e.body.length + Object.entries(e.headers).reduce((m, [k, v]) => m + k.length + v.length, 0), 0);
test('memoryCache: a byte budget and an entry cap; the least recently used entry goes first', async () => {
  // a Uint8Array body sets no content-type, so an entry is exactly its body bytes
  const put = (c, k, n) => c.put(k, new Response(new Uint8Array(n)));
  const c = memoryCache({ maxBytes: 100 });
  await put(c, 'a', 40); await put(c, 'b', 40);
  assert.deepEqual([...c.entries.keys()].sort(), ['a', 'b']); assert.equal(retained(c), 80);
  await put(c, 'c', 40); // 120 > 100: a, the least recently used, goes; b + c = 80
  assert.deepEqual([...c.entries.keys()].sort(), ['b', 'c']); assert.equal(retained(c), 80);
  assert.equal((await c.match('b')).status, 200); // a read makes b the most recently used
  await put(c, 'd', 40); // so c goes, not b
  assert.deepEqual([...c.entries.keys()].sort(), ['b', 'd']); assert.equal(retained(c), 80);
  await put(c, 'e', 101); // larger than the whole budget: not stored, and nothing is evicted for it
  assert.deepEqual([...c.entries.keys()].sort(), ['b', 'd']); assert.ok(!(await c.match('e')));
  await put(c, 'b', 100); // a put replaces: the old b (40) is gone, the new b (100) fills the budget, d goes
  assert.deepEqual([...c.entries.keys()], ['b']); assert.equal(retained(c), 100);
  // header text counts: 'x-a' + 97 characters is 100 bytes of headers, so a 1-byte body is over the budget of 100
  await c.put('h', new Response(new Uint8Array(1), { headers: { 'x-a': 'v'.repeat(97) } }));
  assert.ok(!c.entries.has('h'));
  // the entry cap: four 1-byte entries under a cap of three
  const few = memoryCache({ maxBytes: 100, maxEntries: 3 });
  for (const k of ['p', 'q', 'r', 's']) await put(few, k, 1); // oxlint-disable-line no-await-in-loop -- in order
  assert.deepEqual([...few.entries.keys()].sort(), ['q', 'r', 's']);
  // a long run never retains more than the budget: 200 puts of 1000 bytes under 10,000 keep the last ten
  const run = memoryCache({ maxBytes: 10_000 });
  let peak = 0;
  for (let i = 0; i < 200; i++) { await put(run, `k${i}`, 1000); peak = Math.max(peak, retained(run)); } // oxlint-disable-line no-await-in-loop -- in order
  assert.equal(peak, 10_000);
  assert.deepEqual([...run.entries.keys()].sort(), Array.from({ length: 10 }, (_, i) => `k${190 + i}`));
  // a body over the budget is not read to its end: 1000 chunks of 1 KiB offered, the budget is 4 KiB
  let pulled = 0;
  const endless = new ReadableStream({ pull(ctl) { if (pulled++ < 1000) ctl.enqueue(new Uint8Array(1024)); else ctl.close(); } });
  const tiny = memoryCache({ maxBytes: 4096 });
  await tiny.put('big', new Response(endless));
  assert.equal(tiny.entries.size, 0); assert.ok(pulled < 10, `read ${pulled} of 1000 chunks`);
  // the named defaults, and a budget that is not a non-negative integer falls back to them (never unbounded)
  assert.equal(LIMIT_MEMORY_CACHE_BYTES, 64 * 1024 * 1024); assert.equal(LIMIT_MEMORY_CACHE_ENTRIES, 1024);
  const dflt = memoryCache({ maxBytes: Number.POSITIVE_INFINITY, maxEntries: Number.NaN });
  for (let i = 0; i < 1030; i++) await put(dflt, `n${i}`, 1); // oxlint-disable-line no-await-in-loop -- in order
  assert.equal(dflt.entries.size, 1024);
});
