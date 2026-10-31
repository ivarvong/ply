// Issue #46: the blob:none fallback applies the caller's limits to the objects the caller asked for, never to the
// extras the widening brought. One sibling directory over maxTreeEntries used to fail every read on a blob:none-only
// host (Cloudflare Artifacts: curl's tests/data, 2,135 entries, under the viewer's 2,000) while a tree:0 server answered.
//
// The space, as tagged unions, and every cell of their product (5 × 3 × 4 × 2 = 120), each on a fresh copy of the repo:
//   server:  tree0 (git http-backend as is) | blobnone (a proxy that 400s every filter but blob:none, as Artifacts does)
//   wanted:  small (a tree under the limit: small/) | big (a tree over the limit: big/) | blob (top.txt; only the root
//            tree is on the way to it)
//   sibling: none | over (huge/, over the limit) | malformed (bad/, entries out of order: git fsck refuses it)
//            | many (huge1..3 over the limit beside ok1, ok2 under it)
//   op:      readFile | listTree | editFile | checkoutTree | merge (mergeBranch: the merge-base walk, fetchPackTree0,
//            then the tree merge), each pointed at `wanted` (a file in it, the directory itself, or edits in it)
// Expected outcome per cell (`expected` below):
//   - a malformed sibling on blobnone: pack_corrupt (#18/#37: a server that sent it is not trusted), except
//     checkoutTree, whose own blob:none pack parses only the trees it walks (on both servers);
//   - else wanted big: limit_exceeded (the wanted tree gets the caller's limits, also when it was skipped from an
//     earlier wide pack and is now fetched on its own);
//   - else listTree/checkoutTree of the file top.txt: not_found;
//   - else ok, and git agrees (cat-file, ls-tree, the edited blob, merge-tree --write-tree).
// Wherever the sibling is not malformed, tree0 and blobnone give the same answer, oid for oid.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, fsckProblems } from './server.js';
import { startProxy } from './proxy.js';
import { editFile } from '../src/edit.js';
import { readFile, listTree } from '../src/read.js';
import { checkoutTree } from '../src/checkout.js';
import { mergeBranch } from '../src/merge.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { withLimits } from '../src/limits.js';

const L = 10; // maxTreeEntries; every "over" directory holds L + 1 entries, the issue's core cell (limit = size − 1)
const LIMITS = withLimits({ maxTreeEntries: L });
const A = { name: 'w', email: 'w@x' };
const TIME = 1_700_000_000;
const ENV = { GIT_AUTHOR_NAME: 's', GIT_AUTHOR_EMAIL: 's@x', GIT_AUTHOR_DATE: `${TIME} +0000`, GIT_COMMITTER_NAME: 's', GIT_COMMITTER_EMAIL: 's@x', GIT_COMMITTER_DATE: `${TIME} +0000` };
const REJECT = 'Unsupported Git fetch filter; only blob:none is supported.';
const filterOf = body => /filter ([^\n]+)\n/.exec(Buffer.from(body).toString('latin1'))?.[1] ?? null;
const artifactsFault = ctx => (ctx.stage === 'fetch' && filterOf(ctx.reqBody) && filterOf(ctx.reqBody) !== 'blob:none' ? { type: 'status', status: 400, contentType: 'text/plain; charset=utf-8', body: REJECT } : { type: 'pass' });

export const SERVERS = ['tree0', 'blobnone'];
export const WANTED = ['small', 'big', 'blob'];
export const SIBLINGS = ['none', 'over', 'malformed', 'many'];
export const OPS = ['readFile', 'listTree', 'editFile', 'checkoutTree', 'merge'];

export function expected({ server, op, wanted, sibling }) {
  if (sibling === 'malformed' && server === 'blobnone' && op !== 'checkoutTree') return 'pack_corrupt';
  if (wanted === 'big') return 'limit_exceeded';
  if (wanted === 'blob' && (op === 'listTree' || op === 'checkoutTree')) return 'not_found';
  return 'ok';
}
const overCount = ({ wanted, sibling }) => (wanted === 'big' ? 1 : 0) + ({ none: 0, over: 1, malformed: 0, many: 3 })[sibling];

// ---- the repository, built with plumbing so both servers' copies (and every run) have the same oids ----
const hashBlob = (bare, text) => gitBuf(bare, ['hash-object', '-w', '--stdin'], Buffer.from(text)).toString().trim();
function writeTree(bare, spec) {
  const lines = Object.entries(spec).map(([name, v]) => {
    if (typeof v === 'string') return `100644 blob ${hashBlob(bare, v)}\t${name}`;
    if (v.raw) return `040000 tree ${v.raw}\t${name}`;
    return `040000 tree ${writeTree(bare, v)}\t${name}`;
  });
  return gitBuf(bare, ['mktree'], Buffer.from(lines.join('\n') + '\n')).toString().trim();
}
// A tree git fsck refuses (treeNotSorted) but upload-pack serves: written --literally, entries b then a.
function badTree(bare) {
  const e = (name, oid) => Buffer.concat([Buffer.from(`100644 ${name}\0`), Buffer.from(oid, 'hex')]);
  return gitBuf(bare, ['hash-object', '-t', 'tree', '--literally', '-w', '--stdin'], Buffer.concat([e('b', hashBlob(bare, 'b\n')), e('a', hashBlob(bare, 'a\n'))])).toString().trim();
}
const commit = (bare, tree, parents, msg) => git(bare, ['commit-tree', tree, ...parents.flatMap(p => ['-p', p]), '-m', msg], { env: { ...process.env, ...ENV } }).trim();
const dirOf = (tag, n = L + 1) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}.txt`, `${tag}${i}\nmore\n`]));

// The target, per `wanted`: the file each op reads or edits, the directory listTree/checkoutTree name, and the two
// non-overlapping edits the merge's sides make.
const TARGET = {
  small: { file: 'small/a.txt', find: 'a1', dir: 'small', feat: s => { s.small['a.txt'] = 'a1 feat\na2\na3\n'; }, main: s => { s.small['b.txt'] = 'b main\n'; } },
  big: { file: 'big/f0.txt', find: 'big0', dir: 'big', feat: s => { s.big['f0.txt'] = 'big0 feat\nmore\n'; }, main: s => { s.big['f1.txt'] = 'big1 main\nmore\n'; } },
  blob: { file: 'top.txt', find: 'l1', dir: 'top.txt', feat: s => { s['top.txt'] = 'l1 feat\nl2\nl3\nl4\nl5\n'; }, main: s => { s['top.txt'] = 'l1\nl2\nl3\nl4\nl5 main\n'; } },
};
function spec(wanted, sibling, bad) {
  const s = { 'top.txt': 'l1\nl2\nl3\nl4\nl5\n', small: { 'a.txt': 'a1\na2\na3\n', 'b.txt': 'b\n' } };
  if (wanted === 'big') s.big = dirOf('big');
  if (sibling === 'over') s.huge = dirOf('huge');
  if (sibling === 'malformed') s.bad = { raw: bad };
  if (sibling === 'many') { for (const k of [1, 2, 3]) s[`huge${k}`] = dirOf(`huge${k}_`); s.ok1 = { 'x.txt': 'x\n' }; s.ok2 = { 'y.txt': 'y\n' }; }
  return s;
}
// base C0; feat = C0 + the feat edit; main = C0 + the main edit (merge merges feat into main; the rest read main)
function template(root, wanted, sibling) {
  const name = `tpl-${wanted}-${sibling}`; const bare = makeBareRepo(root, name);
  const bad = sibling === 'malformed' ? badTree(bare) : null;
  const c0 = commit(bare, writeTree(bare, spec(wanted, sibling, bad)), [], 'base');
  const f = spec(wanted, sibling, bad); TARGET[wanted].feat(f); const c1 = commit(bare, writeTree(bare, f), [c0], 'feat');
  const m = spec(wanted, sibling, bad); TARGET[wanted].main(m); const c2 = commit(bare, writeTree(bare, m), [c0], 'main');
  git(bare, ['update-ref', 'refs/heads/main', c2]); git(bare, ['update-ref', 'refs/heads/feat', c1]);
  if (sibling === 'malformed') assert.match(fsckErr(bare), /treeNotSorted|not properly sorted/, 'git refuses the bad tree');
  return bare;
}
const fsckErr = bare => fsckProblems(bare).join('\n');

// ---- one cell ----
const sha = b => createHash('sha256').update(b).digest('hex').slice(0, 12);
const drain = async stream => { const out = []; for await (const c of stream) out.push(Buffer.from(c)); return Buffer.concat(out); };
async function runOp(op, url, wanted, opts) {
  const T = TARGET[wanted];
  if (op === 'readFile') { const r = await readFile(url, { path: T.file }, opts); const b = await drain(r.stream); return { answer: `blob ${r.blob} ${sha(b)}`, check: bare => assert.ok(b.equals(gitBuf(bare, ['show', `main:${T.file}`]))) }; }
  if (op === 'listTree') {
    const r = await listTree(url, { path: T.dir }, opts);
    return { answer: `tree ${r.tree} ${sha(JSON.stringify(r.entries))}`, check: bare => assert.deepEqual(r.entries.map(e => `${e.mode} ${e.type} ${e.oid}\t${e.name}`), git(bare, ['ls-tree', `main:${T.dir}`]).trim().split('\n')) };
  }
  if (op === 'editFile') {
    const r = await editFile(url, { path: T.file, find: T.find, replace: `${T.find}X`, author: A, message: 'edit', time: TIME }, opts);
    return { answer: `commit ${r.newCommit}`, check: bare => { assert.equal(git(bare, ['rev-parse', 'main']).trim(), r.newCommit); assert.ok(gitBuf(bare, ['show', `main:${T.file}`]).toString().startsWith(`${T.find}X`)); } };
  }
  if (op === 'checkoutTree') {
    const r = await checkoutTree(url, { path: T.dir }, opts);
    const files = []; for await (const f of r.files) files.push(`${f.path} ${f.oid} ${sha(await drain(f.stream))}`);
    return { answer: `tree ${r.tree} ${sha(files.join('\n'))}`, check: bare => assert.deepEqual(r.entries.map(e => `${e.mode} blob ${e.oid}\t${e.path}`), git(bare, ['ls-tree', '-r', `main:${T.dir}`]).trim().split('\n')) };
  }
  const r = await mergeBranch(url, { ref: 'refs/heads/main', from: 'refs/heads/feat', author: A, message: 'merge', time: TIME }, opts);
  return { answer: `${r.outcome} ${r.oid} ${r.tree}`, check: bare => { assert.equal(r.outcome, 'merge'); assert.equal(r.tree, git(bare, ['merge-tree', '--write-tree', `${r.oid}^1`, `${r.oid}^2`]).trim().split('\n')[0]); assert.equal(git(bare, ['rev-parse', 'main']).trim(), r.oid); } };
}

let root, cleanup, srv, proxy, n = 0;
const templates = new Map();
before(async () => {
  ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); proxy = await startProxy(srv.url, artifactsFault);
  for (const w of WANTED) for (const s of SIBLINGS) templates.set(`${w}/${s}`, template(root, w, s));
});
after(async () => { await proxy.close(); await srv.close(); cleanup(); });

async function cell(c) {
  const name = `c${n++}`; const bare = join(root, `${name}.git`);
  cpSync(templates.get(`${c.wanted}/${c.sibling}`), bare, { recursive: true });
  const ex = arrayExporter(); const quirks = {};
  const url = `${c.server === 'tree0' ? srv.url : proxy.url}/${name}.git`;
  let got, answer = null, err = null;
  try { const r = await runOp(c.op, url, c.wanted, { tracer: new Tracer({ exporter: ex }), limits: LIMITS, quirks }); answer = r.answer; r.check(bare); got = 'ok'; }
  catch (e) { if (e?.code === 'ERR_ASSERTION') throw e; err = e; got = e?.code ?? String(e); answer = `${e?.code}: ${String(e?.message).replace(/[0-9a-f]{40}/g, '<oid>')}`; }
  const fetches = ex.lines.flatMap(flattenLine).filter(s => s.name === 'git.upload-pack fetch');
  const wide = fetches.filter(s => s.attrs['git.fetch.filter.fallback'] === 'blob:none');
  const skipped = wide.map(s => s.attrs['git.fetch.wide.skipped'] ?? 0);
  return { ...c, got, answer, err, skipped, wide, learned: quirks.treeFilter ?? '' };
}

test('#46 every cell of server × wanted × sibling × op: the caller\'s limits bind what it asked for, never the extras; tree:0 and blob:none agree', { timeout: 300_000 }, async t => {
  const rows = [];
  for (const op of OPS) for (const wanted of WANTED) for (const sibling of SIBLINGS) for (const server of SERVERS) rows.push(await cell({ server, op, wanted, sibling }));
  const wrong = [];
  const by = new Map(rows.map(r => [`${r.server}/${r.op}/${r.wanted}/${r.sibling}`, r]));
  for (const r of rows) {
    const want = expected(r);
    if (r.got !== want) wrong.push(`${r.server} ${r.op} ${r.wanted} ${r.sibling}: expected ${want}, got ${r.answer}`);
    if (r.server === 'blobnone' && r.op !== 'checkoutTree' && r.learned !== 'blob:none') wrong.push(`${r.op} ${r.wanted} ${r.sibling}: blob:none not learned`);
    if (r.server === 'tree0' && r.wide.length) wrong.push(`tree0 ${r.op} ${r.wanted} ${r.sibling}: a blob:none fallback against a tree:0 server`);
    // the skipped extras are on the span: exactly the over-limit trees in the first wide pack of a single-tip read, any
    // in the walk's; none at all where there are none
    if (r.server === 'blobnone' && r.op !== 'checkoutTree' && r.sibling !== 'malformed') {
      const k = overCount(r), total = r.skipped.reduce((a, b) => a + b, 0);
      if (['readFile', 'listTree', 'editFile'].includes(r.op) && r.skipped[0] !== k) wrong.push(`${r.op} ${r.wanted} ${r.sibling}: first wide fetch skipped ${r.skipped[0]}, expected ${k}`);
      if (k === 0 && total !== 0) wrong.push(`${r.op} ${r.wanted} ${r.sibling}: skipped ${total} with nothing over the limit`);
      if (k > 0 && !(total > 0 && r.wide.some(s => s.attrs['git.fetch.wide.skipped_reason'] === 'tree entries'))) wrong.push(`${r.op} ${r.wanted} ${r.sibling}: over-limit extras not counted as skipped (tree entries)`);
    }
  }
  // parity: wherever the sibling is well formed, the two servers give the same answer (oids, bytes, error code)
  for (const op of OPS) for (const wanted of WANTED) for (const sibling of SIBLINGS) {
    if (sibling === 'malformed') continue;
    const a = by.get(`tree0/${op}/${wanted}/${sibling}`), b = by.get(`blobnone/${op}/${wanted}/${sibling}`);
    const key = x => (x.got === 'ok' ? x.answer : x.got);
    if (key(a) !== key(b)) wrong.push(`parity ${op} ${wanted} ${sibling}: tree0 ${a.answer} | blobnone ${b.answer}`);
  }
  t.diagnostic(`cells ${rows.length}, as expected ${rows.length - new Set(wrong.filter(w => !w.startsWith('parity')).map(w => w.split(':')[0])).size}`);
  for (const r of rows) t.diagnostic(`CELL ${r.op.padEnd(12)} ${r.wanted.padEnd(5)} ${r.sibling.padEnd(9)} ${r.server.padEnd(8)} expect ${expected(r).padEnd(14)} got ${r.got.padEnd(14)} skipped [${r.skipped}] ${r.got === 'ok' ? '' : r.answer.slice(0, 90)}`);
  assert.deepEqual(wrong, []);
});
