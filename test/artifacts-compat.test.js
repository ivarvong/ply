// Servers that behave like Cloudflare Artifacts (observed 2026-10-23, lab_notebook/ply-artifacts-eval-2026-10-23.md):
//   1. `fetch=filter` advertised, but every filter except blob:none → HTTP 400 "Unsupported Git fetch filter; only
//      blob:none is supported." ply falls back to blob:none (learned from that answer, remembered on the transport).
//   2. every ref-update rejection is `ng <ref> stale ref` → must classify as cas_conflict (editFile's fresh retry fires).
// Mimicked by test/proxy.js in front of git http-backend; git is the judge of every result.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, commitFiles } from './server.js';
import { startProxy } from './proxy.js';
import { editFile } from '../src/edit.js';
import { readFile, listTree } from '../src/read.js';
import { mergeBranch } from '../src/merge.js';
import { rebaseBranch, cherryPick, revertCommit } from '../src/rebase.js';
import { parseReportStatus, rejectionCode } from '../src/push.js';
import { pkt, FLUSH } from '../src/pktline.js';
import { concat } from '../src/bytes.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';

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

test('stale ref (Artifacts wording) is cas_conflict; git\'s wordings unchanged', () => {
  assert.equal(rejectionCode(parseReportStatus(['unpack ok', 'ng refs/heads/main stale ref'])), 'cas_conflict');
  assert.equal(rejectionCode(parseReportStatus(['unpack ok', 'ng refs/heads/a stale ref', 'ng refs/heads/b stale ref'])), 'cas_conflict', 'every multi-ref push is atomic on Artifacts');
  assert.equal(rejectionCode(parseReportStatus(['unpack ok', 'ng refs/heads/main failed to update ref'])), 'cas_conflict');
  assert.equal(rejectionCode(parseReportStatus(['unpack ok', 'ng refs/heads/main incorrect old value provided'])), 'cas_conflict');
  assert.equal(rejectionCode(parseReportStatus(['unpack ok', 'ng refs/heads/main refname conflict'])), 'push_rejected');
  assert.equal(rejectionCode(parseReportStatus(['unpack ok', 'ng refs/heads/main pre-receive hook declined'])), 'push_rejected');
  assert.equal(rejectionCode(parseReportStatus(['unpack ok', 'ng refs/heads/main stale ref', 'ng refs/heads/x pre-receive hook declined'])), 'push_rejected');
});

test('editFile: a stale-ref rejection on the first push is retried from a fresh ls-refs and lands', async () => {
  let pushes = 0;
  const staleOnce = ctx => {
    if (ctx.stage !== 'receive-pack' || ctx.phase !== 'request' || pushes++ > 0) return null;
    const report = concat([pkt('unpack ok\n'), pkt('ng refs/heads/main stale ref\n'), FLUSH]);
    return { type: 'bytes', noForward: true, name: 'stale-ref', bytes: concat([pkt(concat([new Uint8Array([1]), report])), FLUSH]) };
  };
  const r = await repo({ 'f.txt': 'MARK\n' }, artifactsFault(staleOnce));
  try {
    const res = await editFile(r.url, { path: 'f.txt', find: 'MARK', replace: 'DONE', author: A, message: 'm' }, { tracer: new Tracer() });
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
    const res = await editFile(r.url, { path: 'a/b/c/d/deep.txt', find: 'MARK', replace: 'EDITED', author: A, message: 'm' }, { tracer, quirks, verify: true });
    assert.equal(quirks.treeFilter, 'blob:none');
    assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), res.newCommit);
    assert.equal(gitBuf(r.bare, ['cat-file', 'blob', 'main:a/b/c/d/deep.txt']).toString(), 'deep EDITED\n');
    assert.equal(git(r.bare, ['fsck', '--strict', '--no-dangling']).trim(), '');
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
    const rd = await readFile(r.url, { path: 'a/b/c/d/deep.txt' }, { tracer: new Tracer(), quirks });
    const chunks = []; for await (const c of rd.stream) chunks.push(Buffer.from(c));
    assert.ok(Buffer.concat(chunks).equals(gitBuf(r.bare, ['show', 'main:a/b/c/d/deep.txt'])));
    const ls = await listTree(r.url, { path: 'many' }, { tracer: new Tracer(), quirks });
    assert.equal(ls.entries.length, 40); assert.equal(ls.tree, git(r.bare, ['rev-parse', 'main:many']).trim());
    assert.equal(r.proxy.log.filter(l => l.spec === 'status').length, before400, 'no further 400s');
    // a fresh transport without the quirks object learns it again (one more 400) and still answers correctly
    const rd2 = await readFile(r.url, { path: 'README.md' }, { tracer: new Tracer() });
    for await (const _ of rd2.stream); // eslint-disable-line no-unused-vars
    assert.equal(r.proxy.log.filter(l => l.spec === 'status').length, before400 + 1);
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
    const mg = await mergeBranch(url, { ref: 'refs/heads/main', from: 'refs/heads/feat', author: A, message: 'merge' }, opts());
    assert.equal(mg.outcome, 'merge');
    assert.equal(mg.tree, git(bare, ['merge-tree', '--write-tree', m1, f1]).trim().split('\n')[0]);
    assert.equal(tree(bare, 'main'), mg.tree);
    // rebase feat2 (one commit on base) onto main
    git(work, ['checkout', '-q', '-b', 'feat2', base]); const f2 = commitTo('refs/heads/feat2', { 'd/z.txt': 'z feat2\n' }, 'feat2');
    const rb = await rebaseBranch(url, { ref: 'refs/heads/feat2', onto: 'refs/heads/main', committer: A }, opts());
    assert.equal(rb.outcome, 'rebase');
    assert.equal(tree(bare, 'feat2'), git(bare, ['merge-tree', '--write-tree', `--merge-base=${base}`, mg.oid, f2]).trim().split('\n')[0]);
    // cherry-pick f2 onto main, then revert it
    const cp = await cherryPick(url, { ref: 'refs/heads/main', commit: f2, committer: A }, opts());
    assert.equal(cp.tree, git(bare, ['merge-tree', '--write-tree', `--merge-base=${base}`, mg.oid, f2]).trim().split('\n')[0]);
    const rv = await revertCommit(url, { ref: 'refs/heads/main', commit: cp.oid, committer: A }, opts());
    assert.equal(rv.tree, mg.tree, 'revert restores the pre-pick tree');
    assert.equal(git(bare, ['fsck', '--strict', '--no-dangling']).trim(), '');
    assert.equal(quirks.treeFilter, 'blob:none');
  } finally { await r.proxy.close(); }
});

test('git-default server: no fallback attributes, tree:0 throughout (the fallback never triggers by itself)', async () => {
  const r = await repo({ 'a/b.txt': 'MARK\n' }, () => ({ type: 'pass' }));
  try {
    const ex = arrayExporter(); const quirks = {};
    await editFile(r.url, { path: 'a/b.txt', find: 'MARK', replace: 'X', author: A, message: 'm' }, { tracer: new Tracer({ exporter: ex }), quirks });
    assert.equal(quirks.treeFilter, undefined);
    for (const s of spansOf(ex).filter(s => s.name === 'git.upload-pack fetch')) assert.ok(!('git.fetch.filter.fallback' in s.attrs));
  } finally { await r.proxy.close(); }
});
