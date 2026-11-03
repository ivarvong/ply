// Servers that behave like Cloudflare Artifacts (observed 2026-10-23, lab_notebook/ply-artifacts-eval-2026-10-23.md):
//   1. `fetch=filter` advertised, but every filter except blob:none → HTTP 400 "Unsupported Git fetch filter; only
//      blob:none is supported." ply falls back to blob:none (learned from that answer, remembered on the transport).
//   2. every ref-update rejection is `ng <ref> stale ref` → must classify as cas_conflict (editFile's fresh retry fires).
// Mimicked by test/proxy.js in front of git http-backend; git is the judge of every result.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, commitFiles, fsckProblems } from './server.js';
import { startProxy } from './proxy.js';
import { editFile } from '../src/edit.js';
import { readFile, listTree } from '../src/read.js';
import { mergeBranch } from '../src/merge.js';
import { rebaseBranch, cherryPick, revertCommit } from '../src/rebase.js';
import { readLog } from '../src/log.js';
import { checkoutTree } from '../src/checkout.js';
import { forgetQuirks } from '../src/transport.js';
import { classifyReport, decideOutcome } from '../src/push.js';
import { pkt, FLUSH } from '../src/pktline.js';
import { concat } from '../src/bytes.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { unwrap, unwrapAsync } from './unwrap.js';

const REJECT = 'Unsupported Git fetch filter; only blob:none is supported.';
const filterOf = body => /filter ([^\n]+)\n/.exec(Buffer.from(body).toString('latin1'))?.[1] ?? null;
// Artifacts mode: any filter other than blob:none is a 400 (the upstream's answer is discarded)
const artifactsFault = (extra = () => null) => ctx => extra(ctx) ?? (ctx.stage === 'fetch' && filterOf(ctx.reqBody) && filterOf(ctx.reqBody) !== 'blob:none' ? { type: 'status', status: 400, contentType: 'text/plain; charset=utf-8', body: REJECT } : { type: 'pass' });

let root, cleanup, srv, n = 0;
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv.close(); cleanup(); });
const A = { name: 'c', email: 'c@x' };
async function repo(files, fault = artifactsFault()) {
  const name = `a${n++}`; const bare = makeBareRepo(root, name); const work = join(root, `w${name}`); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  commitFiles(work, bare, files, 'seed');
  const proxy = await startProxy(srv.url, fault);
  return { name, bare, work, url: `${proxy.url}/${name}.git`, proxy };
}
const spansOf = ex => ex.lines.flatMap(flattenLine);
const tree = (bare, rev) => git(bare, ['rev-parse', `${rev}^{tree}`]).trim();

// the rejection code of an all-ng report (the refs it names are the commands)
const outcomeOf = lines => decideOutcome(classifyReport(['unpack ok', ...lines].map(l => new TextEncoder().encode(`${l}\n`)), lines.map(l => ({ ref: l.split(' ')[1] })))).code;
test('stale ref (Artifacts wording) is cas_conflict; git\'s wordings unchanged', () => {
  assert.equal(outcomeOf(['ng refs/heads/main stale ref']), 'cas_conflict');
  assert.equal(outcomeOf(['ng refs/heads/a stale ref', 'ng refs/heads/b stale ref']), 'cas_conflict', 'every multi-ref push is atomic on Artifacts');
  assert.equal(outcomeOf(['ng refs/heads/main failed to update ref']), 'cas_conflict');
  assert.equal(outcomeOf(['ng refs/heads/main incorrect old value provided']), 'cas_conflict');
  assert.equal(outcomeOf(['ng refs/heads/main refname conflict']), 'push_rejected');
  assert.equal(outcomeOf(['ng refs/heads/main pre-receive hook declined']), 'push_rejected');
  assert.equal(outcomeOf(['ng refs/heads/main stale ref', 'ng refs/heads/x pre-receive hook declined']), 'push_rejected');
});

test('editFile: a stale-ref rejection on the first push is retried from a fresh ls-refs and lands', async () => {
  let pushes = 0;
  const staleOnce = ctx => {
    if (ctx.stage !== 'receive-pack' || ctx.phase !== 'request' || pushes++ > 0) return null;
    const report = concat([unwrap(pkt('unpack ok\n')), unwrap(pkt('ng refs/heads/main stale ref\n')), FLUSH]);
    return { type: 'bytes', noForward: true, name: 'stale-ref', bytes: concat([unwrap(pkt(concat([new Uint8Array([1]), report]))), FLUSH]) };
  };
  const r = await repo({ 'f.txt': 'MARK\n' }, artifactsFault(staleOnce));
  try {
    const res = await unwrapAsync(editFile(r.url, { path: 'f.txt', find: 'MARK', replace: 'DONE', author: A, message: 'm' }, { tracer: new Tracer() }));
    assert.equal(res.attempt, 1, 'retried once');
    assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), res.newCommit);
    assert.equal(gitBuf(r.bare, ['cat-file', 'blob', 'main:f.txt']).toString(), 'DONE\n');
  } finally { await r.proxy.close(); }
});

test('blob:none fallback: edit (deep path) and read match git; learned once, remembered via quirks, extra bytes on the span', async () => {
  const files = { 'a/b/c/d/deep.txt': 'deep MARK\n', 'README.md': '# hi\n', 'big.bin': Buffer.alloc(200_000, 7) };
  for (let i = 0; i < 40; i++) files[`many/d${i}/f.txt`] = `f${i}\n`;
  const r = await repo(files);
  try {
    const quirks = {}; const ex = arrayExporter(); const tracer = new Tracer({ exporter: ex });
    const res = await unwrapAsync(editFile(r.url, { path: 'a/b/c/d/deep.txt', find: 'MARK', replace: 'EDITED', author: A, message: 'm' }, { tracer, quirks, verify: true }));
    assert.equal(quirks.treeFilter, 'blob:none');
    assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), res.newCommit);
    assert.equal(gitBuf(r.bare, ['cat-file', 'blob', 'main:a/b/c/d/deep.txt']).toString(), 'deep EDITED\n');
    assert.deepEqual(fsckProblems(r.bare), []);
    const fetches = spansOf(ex).filter(s => s.name === 'git.upload-pack fetch');
    const wide = fetches.filter(s => s.attrs['git.fetch.filter.fallback'] === 'blob:none');
    assert.equal(wide.length, 1, 'one wide commit fetch; every tree level came from the harvest');
    assert.equal(wide[0].attrs['git.fetch.filter.learned'], true);
    assert.ok(wide[0].attrs['git.fetch.wide.extra_objects'] > 40 && wide[0].attrs['git.fetch.wide.extra_bytes'] > 0, JSON.stringify(wide[0].attrs));
    assert.equal(wide[0].attrs['git.fetch.wide.blobs'], 0);
    const rejected = r.proxy.log.filter(l => l.spec === 'status').length;
    assert.equal(rejected, 1, 'one 400, then remembered');
    // second operation, same quirks object: no 400 at all; read == git show
    const before400 = rejected;
    const rd = await unwrapAsync(readFile(r.url, { path: 'a/b/c/d/deep.txt' }, { tracer: new Tracer(), quirks }));
    const chunks = []; for await (const c of rd.stream) chunks.push(Buffer.from(c));
    assert.ok(Buffer.concat(chunks).equals(gitBuf(r.bare, ['show', 'main:a/b/c/d/deep.txt'])));
    const ls = await unwrapAsync(listTree(r.url, { path: 'many' }, { tracer: new Tracer(), quirks }));
    assert.equal(ls.entries.length, 40); assert.equal(ls.tree, git(r.bare, ['rev-parse', 'main:many']).trim());
    assert.equal(r.proxy.log.filter(l => l.spec === 'status').length, before400, 'no further 400s');
    // without a quirks object: the remote's remembered record (#136). The calls above kept theirs in the caller's
    // object, so the remote's record learns it once (one more 400), and every later call without one pays none
    const statuses = () => r.proxy.log.filter(l => l.spec === 'status').length;
    for (const want of [before400 + 1, before400 + 1]) {
      const rd2 = await unwrapAsync(readFile(r.url, { path: 'README.md' }, { tracer: new Tracer() }));
      for await (const _ of rd2.stream); // eslint-disable-line no-unused-vars
      assert.equal(statuses(), want, 'remembered per remote');
    }
    // a caller's own fresh record opts out: it learns again (one more 400)
    const rd3 = await unwrapAsync(readFile(r.url, { path: 'README.md' }, { tracer: new Tracer(), quirks: {} }));
    for await (const _ of rd3.stream); // eslint-disable-line no-unused-vars
    assert.equal(statuses(), before400 + 2);
  } finally { await r.proxy.close(); }
});

test('blob:none fallback: merge, rebase, cherry-pick, revert trees equal git merge-tree', async () => {
  const r = await repo({ 'x.txt': 'x1\nx2\nx3\n', 'y.txt': 'y1\n', 'd/z.txt': 'z\n' });
  try {
    const { work, bare, url } = r; const quirks = {};
    const { writeFileSync } = await import('node:fs');
    const commitTo = (ref, files, msg) => { for (const [p, v] of Object.entries(files)) writeFileSync(join(work, p), v); git(work, ['add', '-A']); git(work, ['-c', 'user.name=s', '-c', 'user.email=s@x', 'commit', '-q', '-m', msg]); git(work, ['push', '-q', '-f', bare, `HEAD:${ref}`]); return git(work, ['rev-parse', 'HEAD']).trim(); };
    const base = git(work, ['rev-parse', 'HEAD']).trim();
    git(work, ['checkout', '-q', '-b', 'feat']); const f1 = commitTo('refs/heads/feat', { 'x.txt': 'x1\nx2 feat\nx3\n' }, 'feat');
    git(work, ['checkout', '-q', 'main']);
    const m1 = commitTo('refs/heads/main', { 'y.txt': 'y1 main\n' }, 'main');
    const opts = () => ({ tracer: new Tracer(), quirks });
    const mg = await unwrapAsync(mergeBranch(url, { ref: 'refs/heads/main', from: 'refs/heads/feat', author: A, message: 'merge' }, opts()));
    assert.equal(mg.outcome, 'merge');
    assert.equal(mg.tree, git(bare, ['merge-tree', '--write-tree', m1, f1]).trim().split('\n')[0]);
    assert.equal(tree(bare, 'main'), mg.tree);
    // rebase feat2 (one commit on base) onto main
    git(work, ['checkout', '-q', '-b', 'feat2', base]); const f2 = commitTo('refs/heads/feat2', { 'd/z.txt': 'z feat2\n' }, 'feat2');
    const rb = await unwrapAsync(rebaseBranch(url, { ref: 'refs/heads/feat2', onto: 'refs/heads/main', committer: A }, opts()));
    assert.equal(rb.outcome, 'rebase');
    assert.equal(tree(bare, 'feat2'), git(bare, ['merge-tree', '--write-tree', `--merge-base=${base}`, mg.oid, f2]).trim().split('\n')[0]);
    // cherry-pick f2 onto main, then revert it
    const cp = await unwrapAsync(cherryPick(url, { ref: 'refs/heads/main', commit: f2, committer: A }, opts()));
    assert.equal(cp.tree, git(bare, ['merge-tree', '--write-tree', `--merge-base=${base}`, mg.oid, f2]).trim().split('\n')[0]);
    const rv = await unwrapAsync(revertCommit(url, { ref: 'refs/heads/main', commit: cp.oid, committer: A }, opts()));
    assert.equal(rv.tree, mg.tree, 'revert restores the pre-pick tree');
    assert.deepEqual(fsckProblems(bare), []);
    assert.equal(quirks.treeFilter, 'blob:none');
  } finally { await r.proxy.close(); }
});

test('git-default server: no fallback attributes, tree:0 throughout (the fallback never triggers by itself)', async () => {
  const r = await repo({ 'a/b.txt': 'MARK\n' }, () => ({ type: 'pass' }));
  try {
    const ex = arrayExporter(); const quirks = {};
    await unwrapAsync(editFile(r.url, { path: 'a/b.txt', find: 'MARK', replace: 'X', author: A, message: 'm' }, { tracer: new Tracer({ exporter: ex }), quirks }));
    assert.equal(quirks.treeFilter, 'tree:0'); // the caller's record states what the server took
    for (const s of spansOf(ex).filter(s => s.name === 'git.upload-pack fetch')) assert.ok(!('git.fetch.filter.fallback' in s.attrs));
  } finally { await r.proxy.close(); }
});

// #136: with no quirks passed, the refused filter is asked for at most once per remote, whatever the order of the
// operations. Counted at the fetchImpl: every upload-pack request that carries `filter tree:0` (Artifacts' 400).
// The contrast: a fresh `quirks: {}` per operation (each call its own record, ply before #136) pays one per operation.
const OPS = ['edit', 'read', 'checkout', 'log', 'merge'];
const orders = [...OPS.map((_, i) => [...OPS.slice(i), ...OPS.slice(0, i)]), [...OPS].reverse()];
async function sweep(order, perCall) {
  const r = await repo({ 'a/f.txt': 'MARK\n', 'README.md': '# hi\n' });
  git(r.work, ['checkout', '-q', '-b', 'feat']); git(r.work, ['rm', '-q', 'README.md']);
  git(r.work, ['-c', 'user.name=s', '-c', 'user.email=s@x', 'commit', '-q', '-m', 'feat']); git(r.work, ['push', '-q', r.bare, 'HEAD:refs/heads/feat']);
  let refused = 0;
  const fetchImpl = (url, init) => {
    if (String(url).endsWith('/git-upload-pack') && init?.body && Buffer.from(init.body).toString('latin1').includes('filter tree:0')) refused++;
    return globalThis.fetch(url, init);
  };
  const o = () => ({ tracer: new Tracer(), fetchImpl, ...(perCall ? { quirks: {} } : {}) });
  const run = {
    edit: async () => assert.ok((await unwrapAsync(editFile(r.url, { path: 'a/f.txt', find: 'MARK', replace: 'DONE', author: A, message: 'e' }, { ...o(), verify: true }))).newCommit),
    read: async () => { const rd = await unwrapAsync(readFile(r.url, { path: 'a/f.txt' }, o())); for await (const _ of rd.stream); }, // eslint-disable-line no-unused-vars
    checkout: async () => { const co = await unwrapAsync(checkoutTree(r.url, { ref: 'main' }, o())); for await (const f of co.files) if (f.stream) for await (const _ of f.stream); }, // eslint-disable-line no-unused-vars
    log: async () => assert.ok((await unwrapAsync(readLog(r.url, { ref: 'main', limit: 5 }, o()))).commits.length >= 1),
    merge: async () => assert.ok((await unwrapAsync(mergeBranch(r.url, { ref: 'refs/heads/main', from: 'refs/heads/feat', author: A, message: 'm' }, o()))).outcome),
  };
  try {
    for (const op of order) await run[op]();
    assert.deepEqual(fsckProblems(r.bare), []);
    return { refused, status: r.proxy.log.filter(l => l.spec === 'status').length };
  } finally { await r.proxy.close(); }
}
test('#136: no quirks passed, any order of edit/read/checkout/log/merge: tree:0 is refused at most once per remote', async () => {
  forgetQuirks();
  for (const order of orders) {
    const { refused, status } = await sweep(order, false);
    assert.equal(refused, 1, `${order}: one tree:0 request for the remote`);
    assert.equal(status, 1, `${order}: one 400`);
  }
  const before = await sweep(OPS, true);
  assert.ok(before.refused >= 4, `a fresh record per call pays per operation: ${before.refused}`);
  assert.equal(before.status, before.refused);
});

test('#136: forgetQuirks clears one remote or all; the key never holds the credential', async () => {
  const { quirksKey, rememberedQuirks } = await import('../src/transport.js');
  assert.equal(quirksKey('https://user:tok@h.example/o/r.git/?x=1#y'), 'https://h.example/o/r.git');
  assert.equal(quirksKey('not a url'), null);
  const q = rememberedQuirks(quirksKey('https://h.example/o/r.git'));
  q.treeFilter = 'blob:none';
  assert.equal(rememberedQuirks(quirksKey('https://other:x@h.example/o/r.git/')), q, 'same remote, other credential: same record');
  forgetQuirks('https://h.example/o/r.git');
  assert.notEqual(rememberedQuirks(quirksKey('https://h.example/o/r.git')), q);
  assert.equal(rememberedQuirks(quirksKey('https://h.example/o/r.git')).treeFilter, 'tree:0');
  forgetQuirks();
});
