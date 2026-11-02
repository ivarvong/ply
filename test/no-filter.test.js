// A stock `git http-backend` repository: uploadpack.allowFilter unset, git's default. Its `fetch=` line advertises no
// `filter`, and its upload-pack dies on a `filter` argument with an empty response (no ERR, no flush). Every operation
// runs against such a repository and against its twin with allowFilter on (makeBareRepo's fixture), both seeded with
// the same commits: the answers must be equal (oids, trees, file bytes) and every write fsck --strict clean. Also: the
// learning (one advertisement probe per quirks record, the span attributes that say so, an advertisement in hand
// answering first), the pack limits on the wider unfiltered pack (limit_exceeded, never protocol), and an empty response
// from a server that does advertise `filter` staying the protocol error it is.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, fsckProblems } from './server.js';
import { startProxy } from './proxy.js';
import { editFile } from '../src/edit.js';
import { commitChanges } from '../src/changes.js';
import { pushTree } from '../src/tree.js';
import { readFile, listTree, readCommit } from '../src/read.js';
import { readLog } from '../src/log.js';
import { checkoutTree } from '../src/checkout.js';
import { mergeBranch } from '../src/merge.js';
import { rebaseBranch, cherryPick, revertCommit } from '../src/rebase.js';
import { discover } from '../src/discover.js';
import { createTransport } from '../src/http.js';
import { DEFAULT_LIMITS } from '../src/limits.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { unwrap } from './unwrap.js';

const T = 1_700_000_000;
const A = { name: 'Ada', email: 'ada@x', tz: '+0000', time: T };
let root, cleanup, srv, work, seeded, n = 0;
// 200 KB that no zlib level shrinks: the unfiltered snapshot is bigger than any filtered answer by this much
const noise = len => { const out = Buffer.alloc(len); for (let i = 0, b = Buffer.alloc(0); i < len; i += 32) { b = createHash('sha256').update(b).update(String(i)).digest(); b.copy(out, i); } return out; };

before(async () => {
  ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root);
  work = join(root, 'work'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  const put = files => { for (const [p, v] of Object.entries(files)) { mkdirSync(join(work, p, '..'), { recursive: true }); writeFileSync(join(work, p), v); } };
  const commit = (msg, i) => { git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', msg], { env: { ...process.env, GIT_AUTHOR_DATE: `${T - 100 + i} +0000`, GIT_COMMITTER_DATE: `${T - 100 + i} +0000` } }); return git(work, ['rev-parse', 'HEAD']).trim(); };
  put({ 'README.md': '# readme\n', 'a/b/c.txt': 'deep MARK\n', 'x.txt': 'x1\nx2\nx3\n', 'y.txt': 'y1\n', 'd/z.txt': 'z\n', 'big.bin': noise(200_000), 'run.sh': '#!/bin/sh\necho hi\n' });
  chmodSync(join(work, 'run.sh'), 0o755);
  const base = commit('base', 0);
  git(work, ['tag', '-a', '-m', 'v1', 'v1']);
  git(work, ['checkout', '-q', '-b', 'feat']); put({ 'x.txt': 'x1\nx2 feat\nx3\n' }); const feat = commit('feat', 1);
  git(work, ['checkout', '-q', '-b', 'feat2', base]); put({ 'd/z.txt': 'z feat2\n' }); const feat2 = commit('feat2', 2);
  git(work, ['checkout', '-q', 'main']); put({ 'y.txt': 'y1 main\n' }); const main = commit('main', 3);
  seeded = { base, feat, feat2, main };
});
after(async () => { await srv.close(); cleanup(); });

// Twin repositories with the same refs: `filter` (allowFilter on) and `stock` (git's defaults).
function twins() {
  const name = `t${n++}`;
  const out = {};
  for (const kind of ['filter', 'stock']) {
    const bare = makeBareRepo(root, `${name}-${kind}`, { stock: kind === 'stock' });
    git(work, ['push', '-q', bare, 'refs/heads/*:refs/heads/*', 'refs/tags/*:refs/tags/*']);
    out[kind] = { bare, url: `${srv.url}/${name}-${kind}.git` };
  }
  return out;
}
const drain = async stream => { const parts = []; for await (const c of stream) parts.push(Buffer.from(c)); return Buffer.concat(parts); };
const spansOf = ex => ex.lines.flatMap(flattenLine);
const traced = () => { const ex = arrayExporter(); return { ex, tracer: new Tracer({ exporter: ex }) }; };
// A result as compared across the twins: streams read to bytes, the file iterator drained, push sizes left out (the thin
// pack may pick other bases when the unfiltered fetch harvested more trees; what landed is compared by oid instead).
async function plain(v) {
  if (v instanceof ReadableStream) return (await drain(v)).toString('base64');
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  if (v && typeof v[Symbol.asyncIterator] === 'function') { const files = []; for await (const f of v) files.push({ ...f, stream: f.stream === null ? null : (await drain(f.stream)).toString('base64') }); return files; }
  if (Array.isArray(v)) return Promise.all(v.map(plain));
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) if (k !== 'pushBytes') o[k] = await plain(x); return o; }
  return v;
}

test('the fixture: the stock twin advertises no filter on fetch=, the other does (what the bug report saw)', async () => {
  const { stock, filter } = twins();
  const info = async url => unwrap(await discover(unwrap(createTransport(url, { tracer: new Tracer() }))));
  assert.equal((await info(stock.url)).filter, false);
  assert.equal((await info(filter.url)).filter, true);
});

test('reads: readFile, listTree, readCommit, readLog, checkoutTree answer the same on both; one probe, then no filter', async () => {
  const { stock, filter } = twins();
  const reads = async (url, quirks, tracer) => {
    const o = () => ({ tracer, quirks });
    const out = {};
    for (const path of ['README.md', 'a/b/c.txt', 'big.bin', 'run.sh']) out[`readFile ${path}`] = await plain(unwrap(await readFile(url, { path }, o())));
    out['readFile v1:x.txt'] = await plain(unwrap(await readFile(url, { ref: 'v1', path: 'x.txt' }, o())));
    for (const path of ['', 'a', 'a/b', 'd']) out[`listTree ${path}`] = await plain(unwrap(await listTree(url, { ref: 'feat2', path }, o())));
    out.readCommit = await plain(unwrap(await readCommit(url, { ref: 'main' }, o())));
    out['readCommit oid'] = await plain(unwrap(await readCommit(url, { ref: seeded.feat }, o())));
    out.readLog = await plain(unwrap(await readLog(url, { ref: 'main', limit: 3 }, o())));
    out.checkoutTree = await plain(unwrap(await checkoutTree(url, { ref: 'main' }, o())));
    out['checkoutTree a'] = await plain(unwrap(await checkoutTree(url, { ref: 'feat', path: 'a' }, o())));
    return out;
  };
  const fq = {}, sq = {};
  const want = await reads(filter.url, fq, new Tracer());
  const t = traced();
  const got = await reads(stock.url, sq, t.tracer);
  assert.deepEqual(got, want);
  assert.equal(got['readFile big.bin'].stream, gitBuf(stock.bare, ['show', 'main:big.bin']).toString('base64'));
  assert.equal(fq.treeFilter, 'tree:0');
  assert.equal(sq.treeFilter, 'none');
  const spans = spansOf(t.ex);
  const probes = spans.filter(s => s.name === 'git.upload-pack discover');
  assert.equal(probes.length, 1, 'one advertisement read for the whole sequence (one quirks record)');
  assert.equal(probes[0].attrs['git.server.filter'], false);
  assert.ok(!probes[0].attrs['git.server.fetch'].includes('filter'));
  const fetches = spans.filter(s => s.name === 'git.upload-pack fetch');
  const filtered = fetches.filter(s => s.attrs['git.fetch.filter'] !== '');
  assert.equal(filtered.length, 1, 'the one filtered request is the one the server died on');
  assert.equal(filtered[0].attrs['error.type'], 'protocol');
  assert.equal(filtered[0].attrs['error.kind'], 'empty_response');
  const learned = fetches.filter(s => s.attrs['git.fetch.filter.learned'] === true);
  assert.equal(learned.length, 1);
  assert.equal(learned[0].attrs['git.fetch.filter.fallback'], 'none');
  assert.equal(learned[0].attrs['git.fetch.filter.requested'], 'tree:0');
  for (const s of fetches.filter(x => 'git.fetch.filter.fallback' in x.attrs)) assert.equal(s.attrs['git.fetch.filter.fallback'], 'none');
  // checkoutTree's blobs came with its unfiltered trees pack: no blob fetch of its own
  for (const b of spans.filter(s => s.name === 'git.checkout.blobs')) assert.equal(b.attrs['git.checkout.blobs.fetches'], 0, JSON.stringify(b.attrs));
});

test('writes: editFile, commitChanges, pushTree, mergeBranch, rebaseBranch, cherryPick, revertCommit land the same commits; fsck --strict clean', async () => {
  const { stock, filter } = twins();
  const writes = async (url, quirks) => {
    const o = () => ({ tracer: new Tracer(), quirks });
    const out = {};
    out.editFile = await plain(unwrap(await editFile(url, { path: 'a/b/c.txt', find: 'MARK', replace: 'EDITED', author: A, message: 'edit', time: T }, { ...o(), verify: true })));
    out.commitChanges = await plain(unwrap(await commitChanges(url, { ref: 'refs/heads/main', changes: [{ kind: 'create', path: 'd/new.txt', content: 'new\n' }, { kind: 'rename', from: 'README.md', to: 'd/README.md' }], author: A, message: 'changes', time: T }, o())));
    out.pushTree = await plain(unwrap(await pushTree(url, { ref: 'refs/heads/deploy', base: 'refs/heads/main', files: { 'index.html': '<h1>hi</h1>\n', 'a/b/c.txt': 'site\n' }, author: A, message: 'deploy', time: T }, o())));
    out.pushTreeAgain = await plain(unwrap(await pushTree(url, { ref: 'refs/heads/deploy', files: { 'index.html': '<h1>hi</h1>\n', 'a/b/c.txt': 'site 2\n' }, author: A, message: 'deploy 2', time: T }, o())));
    out.mergeBranch = await plain(unwrap(await mergeBranch(url, { ref: 'refs/heads/main', from: 'refs/heads/feat', author: A, message: 'merge feat', time: T }, o())));
    out.rebaseBranch = await plain(unwrap(await rebaseBranch(url, { ref: 'refs/heads/feat2', onto: 'refs/heads/main', committer: A, time: T }, o())));
    out.cherryPick = await plain(unwrap(await cherryPick(url, { ref: 'refs/heads/main', commit: seeded.feat2, committer: A, time: T }, o())));
    out.revertCommit = await plain(unwrap(await revertCommit(url, { ref: 'refs/heads/main', commit: out.cherryPick.oid, committer: A, time: T }, o())));
    return out;
  };
  const fq = {}, sq = {};
  const want = await writes(filter.url, fq);
  const got = await writes(stock.url, sq);
  assert.deepEqual(got, want);
  assert.equal(sq.treeFilter, 'none');
  assert.equal(want.mergeBranch.outcome, 'merge');
  assert.equal(want.rebaseBranch.outcome, 'rebase');
  for (const ref of ['main', 'feat', 'feat2', 'deploy']) assert.equal(git(stock.bare, ['rev-parse', ref]).trim(), git(filter.bare, ['rev-parse', ref]).trim(), ref);
  assert.equal(gitBuf(stock.bare, ['show', 'main:a/b/c.txt']).toString(), 'deep EDITED\n');
  assert.equal(want.mergeBranch.tree, git(stock.bare, ['rev-parse', `${want.mergeBranch.oid}^{tree}`]).trim());
  assert.deepEqual(fsckProblems(stock.bare), []);
  assert.deepEqual(fsckProblems(filter.bare), []);
});

test('an advertisement in hand answers first: discover() sets the quirk, the reads that follow send no filter', async () => {
  const { stock, filter } = twins();
  const t = traced();
  const tr = unwrap(createTransport(stock.url, { tracer: t.tracer }));
  const info = unwrap(await discover(tr));
  assert.equal(info.filter, false);
  assert.equal(tr.quirks.treeFilter, 'none');
  const quirks = tr.quirks;
  const rd = unwrap(await readFile(stock.url, { ref: 'main', path: 'a/b/c.txt' }, { tracer: t.tracer, quirks }));
  assert.equal((await drain(rd.stream)).toString(), 'deep MARK\n');
  const fetches = spansOf(t.ex).filter(s => s.name === 'git.upload-pack fetch');
  assert.ok(fetches.length > 0 && fetches.every(s => s.attrs['git.fetch.filter'] === ''), 'no filtered request at all');
  assert.ok(fetches.some(s => s.attrs['git.fetch.filter.fallback'] === 'none' && s.attrs['git.fetch.filter.learned'] === false));
  assert.equal(spansOf(t.ex).filter(s => s.name === 'git.upload-pack discover').length, 1, 'no second probe');
  // a host that advertises filter undoes a stale 'none'; a learned blob:none is left alone (Artifacts advertises filter)
  const back = { treeFilter: 'none' };
  unwrap(await discover(unwrap(createTransport(filter.url, { tracer: new Tracer(), quirks: back }))));
  assert.equal(back.treeFilter, 'tree:0');
  const art = { treeFilter: 'blob:none' };
  unwrap(await discover(unwrap(createTransport(filter.url, { tracer: new Tracer(), quirks: art }))));
  assert.equal(art.treeFilter, 'blob:none');
});

test('limits hold on the unfiltered pack: limit_exceeded (pack bytes), never protocol; the filtered twin is under them', async () => {
  const { stock, filter } = twins();
  const limits = { ...DEFAULT_LIMITS, maxPackBytes: 100_000 };
  const o = () => ({ tracer: new Tracer(), limits });
  const small = unwrap(await readFile(filter.url, { ref: 'main', path: 'README.md' }, o()));
  assert.equal((await drain(small.stream)).toString(), '# readme\n');
  for (const [what, run] of [
    ['readFile', () => readFile(stock.url, { ref: 'main', path: 'README.md' }, o())],
    ['readCommit', () => readCommit(stock.url, { ref: 'main' }, o())],
    ['readLog', () => readLog(stock.url, { ref: 'main', limit: 2 }, o())],
    ['checkoutTree', () => checkoutTree(stock.url, { ref: 'main' }, o())],
    ['editFile', () => editFile(stock.url, { path: 'a/b/c.txt', find: 'MARK', replace: 'X', author: A, message: 'm' }, o())],
  ]) {
    const r = await run();
    assert.equal(r.ok, false, what);
    assert.equal(r.error.code, 'limit_exceeded', `${what}: ${r.error.code} ${r.error.message}`);
    assert.equal(r.error.what, 'pack bytes', what);
  }
  assert.equal(git(stock.bare, ['rev-parse', 'main']).trim(), seeded.main, 'nothing pushed');
});

test('a server that advertises filter and answers a filtered fetch with an empty body: protocol, the quirk unchanged', async () => {
  const { filter } = twins();
  const proxy = await startProxy(srv.url, ctx => (ctx.stage === 'fetch' && /filter /.test(ctx.reqBody.toString('latin1')) ? { type: 'bytes', noForward: true, bytes: new Uint8Array(0) } : { type: 'pass' }));
  try {
    const t = traced(); const quirks = {};
    const url = `${proxy.url}/${filter.url.split('/').pop()}`;
    const r = await readFile(url, { ref: 'main', path: 'a/b/c.txt' }, { tracer: t.tracer, quirks });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'protocol');
    assert.equal(r.error.reason, 'empty_response');
    assert.equal(r.error.message, 'v2: response ended without flush');
    assert.equal(quirks.treeFilter, 'tree:0');
    const probes = spansOf(t.ex).filter(s => s.name === 'git.upload-pack discover');
    assert.equal(probes.length, 1);
    assert.equal(probes[0].attrs['git.server.filter'], true);
    // an empty answer to an unfiltered request is not a reason to probe: it is the protocol error, no advertisement read
    const t2 = traced();
    const blob = git(filter.bare, ['rev-parse', 'main:a/b/c.txt']).trim();
    const proxy2 = await startProxy(srv.url, ctx => (ctx.stage === 'fetch' && ctx.reqBody.length > 0 && !/command=ls-refs/.test(ctx.reqBody.toString('latin1')) ? { type: 'bytes', noForward: true, bytes: new Uint8Array(0) } : { type: 'pass' }));
    try {
      const tr = unwrap(createTransport(`${proxy2.url}/${filter.url.split('/').pop()}`, { tracer: t2.tracer }));
      const { fetchObject } = await import('../src/fetch.js');
      const got = await fetchObject(tr, { oid: blob, filter: '' });
      assert.equal(got.ok, false);
      assert.equal(got.error.code, 'protocol');
      assert.equal(spansOf(t2.ex).filter(s => s.name === 'git.upload-pack discover').length, 0);
    } finally { await proxy2.close(); }
  } finally { await proxy.close(); }
});

test('an advertisement the probe cannot read (cut inside a pkt) decides nothing: the empty response stays protocol', async () => {
  const { stock } = twins();
  // GET info/refs (no request body) loses its last two bytes, inside the closing flush; the fetch is the stock server's own
  const proxy = await startProxy(srv.url, ctx => (ctx.reqBody.length === 0 && ctx.bytes.length > 0 ? { type: 'bytes', bytes: ctx.bytes.subarray(0, ctx.bytes.length - 2) } : { type: 'pass' }));
  try {
    const t = traced(); const quirks = {};
    const r = await readFile(`${proxy.url}/${stock.url.split('/').pop()}`, { ref: 'main', path: 'a/b/c.txt' }, { tracer: t.tracer, quirks });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'protocol');
    assert.equal(r.error.reason, 'empty_response');
    assert.equal(quirks.treeFilter, 'tree:0', 'nothing learned');
    const probe = spansOf(t.ex).filter(s => s.name === 'git.upload-pack discover');
    assert.equal(probe.length, 1);
    assert.equal(probe[0].attrs['error.type'], 'protocol');
    assert.equal(probe[0].status.message, 'trailing 2 bytes after last pkt-line');
  } finally { await proxy.close(); }
});
