// Cells observed from git: for every cell whose reason git can be made to write, a real `git receive-pack
// --stateless-rpc` (what git http-backend runs) answers the cell's request in a repository arranged to produce the
// reason. The request is built here, byte for byte as a client sends it (commands, optional shallow lines, flush, pack
// from `git pack-objects`), because several reasons need requests ply refuses to send or never sends (shallow lines, a
// pack that lacks the new commit). For each cell: git's report bytes must equal the cell's derived report
// (space.gitReport) rendered with the same ref names; ply's outcome on git's bytes, through push() over the fake
// transport, must be the table's; and the repository's refs must agree with the outcome: landed → every ref moved,
// rejected → none, partial → exactly the landed ones, ambiguous → recorded (the truth ply did not claim).
import { spawn } from 'node:child_process';
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { mkdirSync, writeFileSync, chmodSync, cpSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitBuf, tmpRoot } from '../server.js';
import { pkt, FLUSH } from '../../src/pktline.js';
import { concat, te } from '../../src/bytes.js';
import * as space from './push-ng.space.js';

const ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const g = (cwd, args, opts = {}) => git(cwd, args, { env: ENV, ...opts }).trim();
// permission-based recipes cannot fail as root (CI runners are not root; a root run derives those cells instead)
const ROOT_USER = process.getuid?.() === 0;
// the local git's era (space axis `era`): a cell of the other era is derived on this run (CI runs git 2.56, a laptop may run 2.50)
import { gitVersion } from '../gitversion.js';
const [MAJ, MIN] = gitVersion();
export const LOCAL_ERA = MAJ > 2 || (MAJ === 2 && MIN >= 51) ? 'v2.51+' : 'v2.50';
export const GIT_VERSION = `${MAJ}.${MIN}`;

// ---- the fixture: one repository of commits, copied per cell ----
// A ← B ← C, A ← X (diverged), B ← D (never sent: the pack lacks it), B ← W (adds w: in the way of an untracked w);
// P ← Q ← R: a history a shallow client (boundary Q) pushes.
function fixture(root) {
  const src = join(root, 'src');
  mkdirSync(src); g(src, ['init', '-q', '-b', 'main']);
  const blob = text => g(src, ['hash-object', '-w', '--stdin'], { input: text });
  const tree = files => g(src, ['mktree'], { input: Object.entries(files).map(([n, t]) => `100644 blob ${blob(t)}\t${n}\n`).join('') });
  const commit = (files, msg, parent) => g(src, ['commit-tree', tree(files), ...(parent ? ['-p', parent] : []), '-m', msg]);
  const A = commit({ f: 'a\n' }, 'A'), B = commit({ f: 'b\n' }, 'B', A), C = commit({ f: 'c\n' }, 'C', B), X = commit({ f: 'x\n' }, 'X', A);
  const D = commit({ f: 'd\n' }, 'D', B), W = commit({ f: 'b\n', w: 'w\n' }, 'W', B);
  const P = commit({ p: 'p\n' }, 'P'), Q = commit({ p: 'q\n' }, 'Q', P), R = commit({ p: 'r\n' }, 'R', Q);
  const oids = { A, B, C, X, D, W, P, Q, R, U: 'dead'.repeat(10), zero: space.ZERO };
  // objects of a commit that the server (which has A and B) lacks
  const objectsOf = c => g(src, ['rev-list', '--objects', '--no-object-names', c, `^${B}`, ...(c === R ? [`^${P}`] : [])]).split('\n').filter(Boolean);
  const objects = { C: objectsOf(C), X: objectsOf(X), W: objectsOf(W), D: [], R: objectsOf(R) };
  // the bare template: refs main, r0, r1, r2 at B, HEAD → main; the non-bare one: the same, main checked out
  const bare = join(root, 'bare.git');
  g(root, ['init', '-q', '--bare', '-b', 'main', bare]);
  g(src, ['push', '-q', bare, `${B}:refs/heads/main`, `${B}:refs/heads/r0`, `${B}:refs/heads/r1`, `${B}:refs/heads/r2`]);
  const wt = join(root, 'wt');
  g(root, ['clone', '-q', bare, wt]);
  for (const r of ['r0', 'r1', 'r2']) g(wt, ['update-ref', `refs/heads/${r}`, B]);
  g(wt, ['remote', 'remove', 'origin']);
  return { src, oids, objects, bare, wt };
}

// ---- recipes: how to make git write each observed reason ----
// setup(ctx) arranges the copied repository; ctx: { dir (the git dir), work (the worktree or null), names, culprits,
// cell, oids, hook(name, body), cfg(k, v) }. new: the commit the culprit pushes instead of the shape's. shallow: shallow
// lines sent before the commands. args: extra receive-pack arguments. pack(bytes): a fault in the pack.
const sh = body => `#!/bin/sh\n${body}\n`;
const caseOf = names => names.map(n => n.replace(/[^A-Za-z0-9/_-]/g, '?')).join('|');
const PROC_HOOK = mode => `#!${process.execPath}
// a proc-receive hook (receive-pack.c run_proc_receive_hook): version negotiation, then the commands, then a status per command
const fs = require('node:fs');
let buf = Buffer.alloc(0);
const readPkt = () => { while (buf.length < 4) { const b = Buffer.alloc(65536); const n = fs.readSync(0, b); if (!n) return null; buf = Buffer.concat([buf, b.subarray(0, n)]); }
  const len = parseInt(buf.subarray(0, 4).toString(), 16); if (len === 0) { buf = buf.subarray(4); return ''; }
  while (buf.length < len) { const b = Buffer.alloc(65536); const n = fs.readSync(0, b); if (!n) return null; buf = Buffer.concat([buf, b.subarray(0, n)]); }
  const p = buf.subarray(4, len).toString(); buf = buf.subarray(len); return p; };
const out = s => fs.writeSync(1, s === '' ? '0000' : (s.length + 4).toString(16).padStart(4, '0') + s);
while (readPkt()) {} out('version=1\\n'); out('');
const cmds = []; for (let l; (l = readPkt());) cmds.push(l.trim().split(' ')[2]);
${mode === 'ng' ? "for (const r of cmds) out('ng ' + r + '\\n');" : ''}
out('');
`;
const DENY_UPDATE_INSTEAD = ctx => { ctx.cfg('receive.denyCurrentBranch', 'updateInstead'); };
const unbornIfCreate = ctx => { if (ctx.cell.command.tag === 'create') { g(ctx.work, ['read-tree', '--empty']); rmSync(join(ctx.work, 'f')); } };
export const RECIPES = {
  'eof before pack header was fully read': { pack: b => b.subarray(0, 6) },
  'protocol error (pack signature mismatch detected)': { pack: b => concat([te.encode('JUNK'), b.subarray(4)]) },
  'protocol error (pack version unsupported)': { pack: b => { const c = b.slice(); c[7] = 4; return c; } },
  'unable to create temporary object directory': { root: true, setup: ctx => { chmodSync(join(ctx.dir, 'objects'), 0o555); }, cleanup: ctx => chmodSync(join(ctx.dir, 'objects'), 0o755) },
  'unpack-objects abnormal exit': { setup: ctx => ctx.cfg('receive.unpackLimit', '1000'), pack: b => { const c = b.slice(); c[c.length - 25] ^= 0xff; return c; } },
  'index-pack abnormal exit': { setup: ctx => ctx.cfg('receive.unpackLimit', '1'), pack: b => { const c = b.slice(); c[c.length - 25] ^= 0xff; return c; } },
  'missing necessary objects': { new: 'D' },
  'deny updating a hidden ref': { setup: ctx => { for (const i of ctx.culprits) ctx.cfg('receive.hideRefs', ctx.names[i], true); } },
  'deny deleting a hidden ref': { setup: ctx => { for (const i of ctx.culprits) ctx.cfg('receive.hideRefs', ctx.names[i], true); } },
  'broken symref': { setup: ctx => { for (const i of ctx.culprits) { const n = ctx.names[i]; g(ctx.dir, ['update-ref', '-d', n]); g(ctx.dir, ['symbolic-ref', n, `${n}-loop`]); g(ctx.dir, ['symbolic-ref', `${n}-loop`, n]); } } },
  'inconsistent aliased update': { setup: ctx => { for (const i of ctx.culprits) { g(ctx.dir, ['update-ref', '-d', ctx.names[i]]); g(ctx.dir, ['symbolic-ref', ctx.names[i], ctx.names[0]]); } } },
  'shallow update not allowed': { new: 'R', shallow: 'Q' },
  'funny refname': {},
  'branch is currently checked out': { work: true, head: true },
  'bad pack': { new: 'D', args: ['--skip-connectivity-check'] },
  'deletion prohibited': { setup: ctx => ctx.cfg('receive.denyDeletes', 'true') },
  'deletion of the current branch prohibited': { head: true },
  'bad ref': { setup: ctx => ctx.cfg('receive.denyNonFastForwards', 'true') },
  'non-fast-forward': { setup: ctx => ctx.cfg('receive.denyNonFastForwards', 'true') },
  'hook declined': { setup: ctx => ctx.hook('update', sh(`case "$1" in ${caseOf(ctx.culprits.map(i => ctx.names[i]))}) exit 1;; esac\nexit 0`)) },
  'Up-to-date check failed': { work: true, head: true, setup: ctx => { DENY_UPDATE_INSTEAD(ctx); unbornIfCreate(ctx); writeFileSync(join(ctx.dir, 'index.lock'), ''); } },
  'Working directory has unstaged changes': { work: true, head: true, setup: ctx => { DENY_UPDATE_INSTEAD(ctx); writeFileSync(join(ctx.work, 'f'), 'dirty\n'); } },
  'Working directory has staged changes': { work: true, head: true, setup: ctx => { DENY_UPDATE_INSTEAD(ctx); unbornIfCreate(ctx); writeFileSync(join(ctx.work, 'f'), 'staged\n'); g(ctx.work, ['add', 'f']); } },
  'Could not update working tree to new HEAD': { work: true, head: true, new: 'W', setup: ctx => { DENY_UPDATE_INSTEAD(ctx); unbornIfCreate(ctx); writeFileSync(join(ctx.work, 'w'), 'untracked\n'); } },
  'push-to-checkout hook declined': { work: true, head: true, setup: ctx => { DENY_UPDATE_INSTEAD(ctx); ctx.hook('push-to-checkout', sh('exit 1')); } },
  'failed to update ref#2': {},
  'atomic transaction failed': {},
  'pre-receive hook declined': { setup: ctx => ctx.hook('pre-receive', sh('exit 1')) },
  'unable to migrate objects to permanent storage': { root: true, setup: ctx => { ctx.cfg('receive.unpackLimit', '1'); ctx.hook('pre-receive', sh('chmod a-w objects/pack')); }, cleanup: ctx => chmodSync(join(ctx.dir, 'objects', 'pack'), 0o755) },
  'fail to run proc-receive hook': { setup: ctx => ctx.cfg('receive.procReceiveRefs', 'refs/for') },
  'proc-receive failed to report status': { setup: ctx => { ctx.cfg('receive.procReceiveRefs', 'refs/for'); ctx.hook('proc-receive', PROC_HOOK('silent')); } },
  'failed': { setup: ctx => { ctx.cfg('receive.procReceiveRefs', 'refs/for'); ctx.hook('proc-receive', PROC_HOOK('ng')); } },
};
// observable on some git (SPACE.md counts these); observable here: on this run's git, as this user
export const observableAnywhere = c => !c.reason.reason.derived;
export const observable = c => observableAnywhere(c) && c.era.tag === LOCAL_ERA && !(RECIPES[c.reason.tag]?.root && ROOT_USER);

const run = (args, input) => new Promise((resolve, reject) => {
  const p = spawn('git', args, { env: ENV });
  const out = [], err = [];
  p.stdout.on('data', d => out.push(d)); p.stderr.on('data', d => err.push(d));
  p.stdin.on('error', () => {}); // receive-pack may stop reading a bad pack early
  p.on('error', reject);
  p.on('close', code => resolve({ code, out: new Uint8Array(Buffer.concat(out)), err: Buffer.concat(err).toString() }));
  p.stdin.end(input);
});

const refsOf = dir => {
  const out = new Map();
  for (const l of g(dir, ['for-each-ref', '--format=%(refname) %(objectname)'], { stdio: ['pipe', 'pipe', 'ignore'] }).split('\n').filter(Boolean)) { const [r, o] = l.split(' '); out.set(r, o); }
  return out;
};

// filter(cell): observe only some cells (debugging: PUSH_NG_ONLY=<reason tag> in push-ng.test.js). shard [k, w]: every w-th.
async function observeShard({ concurrency = 4, filter = () => true, shard = [0, 1] } = {}) {
  const { root, cleanup } = tmpRoot();
  try {
    const fx = fixture(root);
    const packCache = new Map();
    const packFor = news => {
      const key = [...news].sort().join(',');
      // a push of D alone sends an empty pack (D is the object it lacks)
      const list = [...new Set([...news].flatMap(k => fx.objects[k]))];
      if (!packCache.has(key)) packCache.set(key, news.size ? new Uint8Array(gitBuf(fx.src, ['pack-objects', '--stdout', '-q'], list.map(o => `${o}\n`).join(''))) : null);
      return packCache.get(key);
    };
    const todo = space.cells().filter(c => observable(c) && filter(c)).filter((_, i) => i % shard[1] === shard[0]);
    const results = [];
    let next = 0, k = 0;
    const one = async c => {
      const rec = RECIPES[c.reason.tag];
      if (!rec) throw new Error(`no recipe for ${c.reason.tag}`);
      const cellDir = join(root, `c${k++}`);
      cpSync(rec.work ? fx.wt : fx.bare, cellDir, { recursive: true });
      const dir = rec.work ? join(cellDir, '.git') : cellDir, work = rec.work ? cellDir : null;
      const names = space.refNames(c), culprits = space.culprits(c);
      const cmds = space.commandsOf(c).map((x, i) => ({ ref: x.ref, old: fx.oids[x.old], new: x.new === 'zero' ? space.ZERO : fx.oids[culprits.includes(i) && rec.new ? rec.new : x.new], newKey: x.new === 'zero' ? null : culprits.includes(i) && rec.new ? rec.new : x.new }));
      const ctx = {
        dir, work, names, culprits, cell: c, oids: fx.oids,
        cfg: (key, v, add = false) => g(dir, ['config', ...(add ? ['--add'] : []), key, v]),
        hook: (name, body) => { mkdirSync(join(dir, 'hooks'), { recursive: true }); const p = join(dir, 'hooks', name); writeFileSync(p, body); chmodSync(p, 0o755); },
      };
      // the shape's server state: a create's ref is absent
      for (const i of culprits) if ((c.command.tag === 'create' || c.command.tag === 'gone') && /^refs\/heads\/r\d$/.test(names[i])) g(dir, ['update-ref', '-d', names[i]]);
      if (rec.head) g(dir, ['symbolic-ref', 'HEAD', names[culprits[0]]]);
      rec.setup?.(ctx);
      const before = refsOf(dir);
      const news = new Set(cmds.map(x => x.newKey).filter(Boolean));
      let pack = packFor(news);
      if (pack && rec.pack) pack = rec.pack(pack);
      const caps = ['report-status', ...(c.atomic.tag === 'on' ? ['atomic'] : []), ...(cmds.some(x => x.new === space.ZERO) ? ['delete-refs'] : [])];
      const req = concat([
        ...(rec.shallow ? [pkt(te.encode(`shallow ${fx.oids[rec.shallow]}\n`))] : []),
        ...cmds.map((x, i) => pkt(te.encode(`${x.old} ${x.new} ${x.ref}${i === 0 ? '\0' + caps.join(' ') : ''}\n`))),
        FLUSH, ...(pack ? [pack] : []),
      ]);
      const res = await run(['receive-pack', '--stateless-rpc', ...(rec.args ?? []), dir], req);
      const after = refsOf(dir);
      rec.cleanup?.(ctx);
      if (rec.work) try { unlinkSync(join(dir, 'index.lock')); } catch { /* only Up-to-date check failed leaves one */ }
      const moved = cmds.filter(x => before.get(x.ref) !== after.get(x.ref)).map(x => x.ref);
      const commands = cmds.map(x => ({ ref: x.ref, oldOid: x.old, newOid: x.new }));
      rmSync(cellDir, { recursive: true, force: true });
      return { id: space.cellId(c), commands, bytes: res.out, stderr: res.err, exit: res.code, moved };
    };
    const worker = async () => { while (next < todo.length) { const c = todo[next++]; results.push(await one(c)); } };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return results;
  } finally { cleanup(); }
}

// The cells' setup runs git synchronously, so the cells are split across worker threads (PUSH_NG_WORKERS sets how many).
// filter is a reason tag or null (a function cannot cross into a worker).
export async function observeAll({ only = null, workers = +(process.env.PUSH_NG_WORKERS ?? Math.min(8, availableParallelism())) } = {}) {
  const shards = await Promise.all(Array.from({ length: workers }, (_, k) => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { pushNg: true, k, w: workers, only } });
    w.once('message', resolve); w.once('error', reject);
  })));
  const byId = new Map(space.cells().map(c => [space.cellId(c), c]));
  const results = shards.flat().map(o => ({ ...o, cell: byId.get(o.id) }));
  return { results, derived: space.cells().filter(c => !observable(c)), rootUser: ROOT_USER, era: LOCAL_ERA, version: GIT_VERSION };
}
if (!isMainThread && workerData?.pushNg) {
  const { k, w, only } = workerData;
  observeShard({ shard: [k, w], filter: c => !only || c.reason.tag === only }).then(r => parentPort.postMessage(r));
}
