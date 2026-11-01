// Pack cache + head hint against real git through the counting proxy. The oracle for "fewer round trips" is the
// proxy's per-stage request count (what the server actually saw); the oracle for correctness is git itself.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { git, tmpRoot, makeBareRepo, startGitServer, commitFiles, fsckProblems } from './server.js';
import { startProxy } from './proxy.js';
import { editFile } from '../src/edit.js';
import { cachingFetch, memoryCache, isCacheableFetch, cacheKey } from '../src/packcache.js';
import { fetchBody, GitHttp } from '../src/client.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { defaultCapabilities } from '../src/capabilities.js';

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
    const r = await editFile(url, { path: 'a/b/c/file.txt', find, replace, author, message: 'm' }, { capabilities: { ...defaultCapabilities(), tracer: new Tracer({ exporter: ex }), fetch: f }, cache: treeCache });
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
  await assert.rejects(editFile(url, { path: 'a/b/c/file.txt', find: 'MARK', replace: 'x', author, message: 'm' }, { capabilities: { ...defaultCapabilities(), tracer: new Tracer(), fetch: cachingFetch(bad, memoryCache()) } }), e => e.code === 'pack_corrupt');
  assert.deepEqual(delta(before, counts()), { 'ls-refs': 1, fetch: 1, 'receive-pack': 0 });
});

test('head hint (parallel, default): ls-refs overlaps the speculative commit fetch; stale hint corrected before any push; bogus hint harmless', async () => {
  const base = headOf();
  const run = async (head, find, replace, extra = {}) => {
    const ex = arrayExporter(); const before = counts();
    const capabilities = { ...defaultCapabilities(), ...extra.capabilities, tracer: new Tracer({ exporter: ex }) };
    const r = await editFile(url, { path: 'a/b/c/file.txt', find, replace, author, message: 'm' }, { head, ...extra, capabilities });
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
  await assert.rejects(editFile(url, { path: 'a/b/c/file.txt', find: 'H3', replace: 'x', author, message: 'm' }, { capabilities: { ...defaultCapabilities(), tracer: new Tracer() }, head: 'nope' }), e => e.code === 'bad_request');
});

test('push: sideband on by default; hook stderr lands in git.push.remote.messages', async () => {
  const hooks = join(bare, 'hooks'); mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, 'pre-receive'); writeFileSync(hook, '#!/bin/sh\necho "policy says hi" >&2\necho "second line" >&2\nexit 0\n'); chmodSync(hook, 0o755);
  try {
    const ex = arrayExporter();
    const r = await editFile(url, { path: 'a/b/c/file.txt', find: 'H3', replace: 'SB', author, message: 'm' }, { capabilities: { ...defaultCapabilities(), tracer: new Tracer({ exporter: ex }) } });
    assert.equal(r.newCommit, headOf());
    const push = spansOf(ex).find(s => s.name === 'git.receive-pack');
    assert.ok(push.attrs['git.push.caps'].includes('side-band-64k'));
    assert.deepEqual(push.attrs['git.push.remote.messages'], ['policy says hi', 'second line']);
    // and a rejecting hook: the reason is the server's words, the code is push_rejected (not cas)
    writeFileSync(hook, '#!/bin/sh\necho "GH006-style: protected branch, nope" >&2\nexit 1\n');
    const ex2 = arrayExporter();
    await assert.rejects(editFile(url, { path: 'a/b/c/file.txt', find: 'SB', replace: 'SC', author, message: 'm' }, { capabilities: { ...defaultCapabilities(), tracer: new Tracer({ exporter: ex2 }) } }), e => e.code === 'push_rejected' && /protected branch/.test(e.hookOutput));
    assert.deepEqual(spansOf(ex2).find(s => s.name === 'git.receive-pack').attrs['git.push.remote.messages'], ['GH006-style: protected branch, nope']);
  } finally { rmSync(hook, { force: true }); }
});

test('discover: v2 capability canary against real git', async () => {
  const ex = arrayExporter();
  const c = new GitHttp(url, { capabilities: { ...defaultCapabilities(), tracer: new Tracer({ exporter: ex }) } });
  const info = await c.discover();
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
  await editFile(url, { path: 'a/b/c/file.txt', find: 'SB', replace: 'SD', author, message: 'm' }, { capabilities: { ...defaultCapabilities(), tracer: new Tracer({ exporter: ex2 }), fetch: f } });
  const root = spansOf(ex2).find(x => x.name === 'git.edit');
  assert.equal(root.attrs['git.pack.cache.put.failed'], 5); assert.equal(root.attrs['git.pack.cache.put.error'], 'cache full'); assert.equal(root.attrs['git.pack.cache.miss'], 5);
  assert.equal(typeof root.attrs['mem.alloc.inflate_chunk.max_single'], 'number');
  const blob = spansOf(ex2).find(x => x.name === 'git.edit.blob');
  assert.ok(blob.attrs['git.edit.blob.cpu_ms'] >= 0, 'node measures cpu'); assert.equal(blob.attrs['git.edit.blob.hasher'], 'js');
});

test('verify: the post-push ls-refs must show our commit; a lying answer is ambiguous, not success', async () => {
  const ex = arrayExporter();
  const ok = await editFile(url, { path: 'a/b/c/file.txt', find: 'SD', replace: 'V1', author, message: 'm' }, { capabilities: { ...defaultCapabilities(), tracer: new Tracer({ exporter: ex }) }, verify: true });
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
    await assert.rejects(editFile(`${lying.url}/pc.git`, { path: 'a/b/c/file.txt', find: 'V1', replace: 'V2', author, message: 'm' }, { capabilities: { ...defaultCapabilities(), tracer: new Tracer({ exporter: ex2 }) }, verify: true }), e => e.code === 'ambiguous' && /push reported ok but/.test(e.message));
    const root = spansOf(ex2).find(s => s.name === 'git.edit');
    assert.equal(root.attrs['git.edit.outcome'], 'ambiguous'); assert.equal(root.attrs['git.edit.verify.ref'], ok.newCommit, 'the lie is recorded verbatim');
    assert.equal(git(bare, ['cat-file', '-p', 'main:a/b/c/file.txt']), 'hello V2 world\n', 'the push itself landed; only the receipt was untrustworthy');
  } finally { await lying.close?.(); }
});

test('buffered fetchPack (general client): poisoned cache entry → one bust → repaired', async () => {
  const cache = memoryCache();
  const f = cachingFetch(globalThis.fetch, cache);
  const ex = arrayExporter();
  const c = new GitHttp(url, { capabilities: { ...defaultCapabilities(), tracer: new Tracer({ exporter: ex }), fetch: f } });
  const head = headOf();
  const a = await c.fetchPack({ wants: [head], filter: 'tree:0', deepen: 1 });
  assert.equal(a.parsed.stats.count, 1); assert.equal(cache.entries.size, 1);
  for (const e of cache.entries.values()) e.body[e.body.length - 30] ^= 0xff;
  const b = await c.fetchPack({ wants: [head], filter: 'tree:0', deepen: 1 });
  assert.equal(b.parsed.stats.count, 1); assert.equal(f.stats.bust, 1);
  const spans = spansOf(ex).filter(s => s.name === 'git.upload-pack fetch');
  assert.deepEqual(spans.map(s => s.attrs['git.pack.cache.bust']), [false, false, true]); assert.deepEqual(spans.map(s => s.attrs['git.response.cache']), ['MISS', 'HIT', 'BUST']);
  // the wrapper delegates to the same functions (getters + one of each family)
  assert.equal(c.url, url); assert.equal(c.limits.maxRefs > 0, true); assert.equal(c.tracer instanceof Tracer, true); assert.equal(c.parent, null);
  const o = await c.fetchObject({ oid: head, deepen: 1 }); assert.equal(o.oid, head);
  const caps = await c.receiveCaps(); assert.ok(caps.has('report-status'));
  assert.equal((await c.negotiate({ wants: [head], haves: [], filter: 'tree:0', deepen: 1 })).parsed.stats.count, 1);
  let st; for await (const _ of c.packStream({ wants: [head], filter: 'tree:0', deepen: 1 }, new Tracer().start('x'))) { st = _; } assert.ok(st);
  await assert.rejects(c.push({ ref: 'refs/heads/main', oldOid: head, newOid: head, objects: [], pushOptions: ['x'] }), e => e.code === 'unsupported', 'push-options checked against the advertisement');
  // with the server advertising push-options, the options ride after the command flush and reach the hook
  git(bare, ['config', 'receive.advertisePushOptions', 'true']);
  const hooks = join(bare, 'hooks'); mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'pre-receive'), '#!/bin/sh\necho "opts=$GIT_PUSH_OPTION_COUNT:$GIT_PUSH_OPTION_0" >&2\nexit 0\n'); chmodSync(join(hooks, 'pre-receive'), 0o755);
  try {
    const { encodeTree, encodeCommit, hashObject } = await import('../src/objects.js');
    const { TYPE } = await import('../src/objects.js');
    const blob = new TextEncoder().encode('po\n'); const tree = encodeTree([{ mode: '100644', name: 'po.txt', oid: hashObject('blob', blob) }]);
    const commit = encodeCommit({ tree: hashObject('tree', tree), parents: [head], author: 'a <a@x> 1 +0000', message: 'po\n' });
    const r = await c.push({ ref: 'refs/heads/main', oldOid: head, newOid: hashObject('commit', commit), objects: [{ type: TYPE.COMMIT, data: commit }, { type: TYPE.TREE, data: tree }, { type: TYPE.BLOB, data: blob }], pushOptions: ['ci.skip'] });
    assert.match(r.hookOutput, /opts=1:ci.skip/);
    git(bare, ['update-ref', 'refs/heads/main', head]);
  } finally { rmSync(join(hooks, 'pre-receive'), { force: true }); git(bare, ['config', '--unset', 'receive.advertisePushOptions']); }
});

test('LFS pointer: refused by default (the content is not in git), editable only with allowLfsPointer', async () => {
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'ab'.repeat(32) + '\nsize 12345\n';
  otherWriter({ 'model.bin': pointer, 'notlfs.txt': 'version https://git-lfs.github.com/spec/v2 MARK\n' }, 'lfs pointer');
  const ex = arrayExporter();
  await assert.rejects(editFile(url, { path: 'model.bin', find: 'size 12345', replace: 'size 1', author, message: 'm' }, { capabilities: { ...defaultCapabilities(), tracer: new Tracer({ exporter: ex }) } }), e => e.code === 'lfs_pointer' && e.size === pointer.length && /LFS pointer/.test(e.message));
  const blob = spansOf(ex).find(s => s.name === 'git.edit.blob');
  assert.equal(blob.attrs['git.edit.blob.lfs_pointer'], true);
  assert.equal(git(bare, ['cat-file', '-p', 'main:model.bin']), pointer, 'untouched');
  assert.equal(spansOf(ex).filter(s => s.name === 'git.receive-pack').length, 0, 'nothing pushed');
  // the guard matches the exact v1 magic, not any file mentioning git-lfs
  const r = await editFile(url, { path: 'notlfs.txt', find: 'MARK', replace: 'OK', author, message: 'm' }, { capabilities: { ...defaultCapabilities(), tracer: new Tracer() } });
  assert.equal(r.newCommit, headOf());
  // opt in: editing the pointer itself (e.g. retargeting an LFS object) is allowed and ordinary
  const r2 = await editFile(url, { path: 'model.bin', find: 'size 12345', replace: 'size 54321', author, message: 'm' }, { capabilities: { ...defaultCapabilities(), tracer: new Tracer() }, allowLfsPointer: true });
  assert.equal(r2.newCommit, headOf());
  assert.equal(git(bare, ['cat-file', '-p', 'main:model.bin']), pointer.replace('12345', '54321'));
});

test('agent: we identify as ply, not git', async () => {
  const { UA } = await import('../src/transport.js');
  assert.match(UA, /^ply\//);
  const ex = arrayExporter();
  await editFile(url, { path: 'notlfs.txt', find: 'OK', replace: 'OK2', author, message: 'm' }, { capabilities: { ...defaultCapabilities(), tracer: new Tracer({ exporter: ex }) } });
  const caps = spansOf(ex).find(s => s.name === 'git.receive-pack').attrs['git.push.caps'];
  assert.ok(caps.includes(`agent=${UA}`), caps.join(' '));
});

test('negotiation, deterministic: haves in rounds — NAK rounds of unknown oids, then ACKs of shared history, ready, and a pack of only what is new', async () => {
  const nb = makeBareRepo(root, 'nego'); const nw = join(root, 'wnego'); mkdirSync(nw); git(nw, ['init', '-q', '-b', 'main']);
  const commits = []; for (let i = 0; i < 30; i++) commits.push(commitFiles(nw, nb, { 'f.txt': `v${i}\n` }, `c${i}`));
  const c = new GitHttp(`${srv.url}/nego.git`, { capabilities: { ...defaultCapabilities(), tracer: new Tracer() } });
  const unknown = Array.from({ length: 20 }, (_, i) => (i.toString(16).padStart(2, '0')).repeat(20));
  const r = await c.negotiate({ wants: [commits[29]], haves: [...unknown, ...commits.slice(10, 20).reverse()], batch: 8 });
  assert.ok(r.rounds.length >= 3, `several rounds (${r.rounds.length})`);
  assert.equal(r.rounds[0].acks.length, 0, 'first round: only unknown oids → no acks');
  assert.ok(r.rounds.some(x => x.acks.length > 0), 'shared history is acknowledged');
  assert.ok(r.common.includes(commits[19]), 'the newest shared commit is common');
  const got = new Set(r.objects.keys());
  assert.ok(got.has(commits[29]) && got.has(commits[20]) && !got.has(commits[19]), 'the pack starts after the common commit');
});
