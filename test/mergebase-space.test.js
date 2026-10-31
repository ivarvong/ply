// The space of merge-base outcomes, enumerated (#41, #42). Each dimension is a tagged union; the test walks their full
// product deterministically and judges every cell against git (`git merge-base --all`, `git merge-tree --write-tree`,
// `git rebase`), never against a model of what ply should do.
//
//   Position: where the best base(s) sit relative to mergeBase's first window (depth 8; a tip is depth 1). k counts
//   the commits strictly above the base on a side, the tip included:
//     above  k = 3 / 3    the base is inside the window
//     at     k = 8 / 8    the base is exactly at the cut: named by both sides' children, never fetched (#41)
//     below  k = 11 / 11  the base is past the first window (found at 16)
//     skew   k = 8 / 2    at the cut on one side, inside on the other
//   Multiplicity: how many best bases git finds, and whether a cut could fake a second one:
//     one          a single base B
//     two          a true criss-cross: X, Y; ours merges [X, Y], theirs [Y, X]
//     hidden-near  candidates c and z, z below c through 2 commits; both sides merge [c, z]: git has one base, c
//     hidden-far   the same with 12 commits between c and z: the first window cuts that link (#42)
//   Settled: the history below the base(s), where a cut lands inside the settled region:
//     none   the base(s) are roots
//     short  3 commits below
//     deep   40 commits below (more than the cap of 32 below: a walk to the root is limit_exceeded)
//   Server: the seven behaviours of test/fuzz/liar.mjs's merge-base family (test/fuzz/mergelies.js).
//   Op: mergeBase, mergeBranch; and rebaseBranch on the honest server where git has one base. Where the branch holds a
//   merge commit (the hidden shapes' [c, z]) git rebase linearizes it and ply refuses, typed (not_linear, rebase.js's
//   stated contract); every other rebase cell must equal `git rebase` tree for tree.
//
// Every tree is additive (each commit adds f/<name>), so every merge and rebase git performs is clean and the
// expected tree is git's, not ours. maxMergeDepth is 32 for every cell.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { tmpRoot, makeBareRepo, startGitServer, fsckProblems } from './server.js';
import { startProxy } from './proxy.js';
import { MERGE_LIES, mergeLie } from './fuzz/mergelies.js';
import { oracleRediff } from './gitversion.js';
import { mergeBase, mergeBranch } from '../src/merge.js';
import { rebaseBranch } from '../src/rebase.js';
import { createTransport } from '../src/http.js';
import { withLimits } from '../src/limits.js';
import { Tracer } from '../src/otel.js';
import { TYPE } from '../src/objects.js';

const rediff = oracleRediff();
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'w', GIT_AUTHOR_EMAIL: 'w@x', GIT_COMMITTER_NAME: 'w', GIT_COMMITTER_EMAIL: 'w@x', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' };
const sh = (cwd, args, input) => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: ENV, input, maxBuffer: 1 << 26 }); if (r.status !== 0 && !args.includes('merge-tree')) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r; };
const out = (cwd, args, input) => sh(cwd, args, input).stdout.trim();
const CAP = 32;
const CODES = new Set(['pack_corrupt', 'protocol', 'network', 'timeout', 'aborted', 'not_git', 'not_found', 'http', 'limit_exceeded', 'remote_error', 'cas_conflict', 'push_rejected', 'ambiguous', 'merge_conflict', 'unrelated_histories', 'not_fast_forward', 'not_linear']);

export const POSITION = { above: [3, 3], at: [8, 8], below: [11, 11], skew: [8, 2] };
export const MULTIPLICITY = { one: null, two: null, 'hidden-near': 2, 'hidden-far': 12 };
export const SETTLED = { none: 0, short: 3, deep: 40 };
const SERVERS = Object.keys(MERGE_LIES);

// A shape as an ordered list of [name, parents] (parents first), the tips, and the bases git must find (by name).
function shape(pos, mult, settled) {
  const spec = []; const add = (n, ps) => spec.push([n, ps]);
  const below = SETTLED[settled];
  const under = prefix => { // a chain of `below` commits under the base(s); returns the name to hang them on (or null)
    if (!below) return null;
    for (let i = below; i >= 1; i--) add(`${prefix}${i}`, i < below ? [`${prefix}${i + 1}`] : []);
    return `${prefix}1`;
  };
  const side = (tag, k, top) => { // k commits above `top` (an array of parents for the lowest), the tip is `${tag}1`
    for (let i = k; i >= 1; i--) add(`${tag}${i}`, i === k ? top : [`${tag}${i + 1}`]);
    return `${tag}1`;
  };
  const [ko, kt] = POSITION[pos];
  let bases, ours, theirs;
  if (mult === 'one') {
    const s = under('s'); add('B', s ? [s] : []); bases = ['B'];
    ours = side('o', ko, ['B']); theirs = side('t', kt, ['B']);
  } else if (mult === 'two') {
    const s = under('s'); add('X', s ? [s] : []); add('Y', s ? [s] : []); bases = ['X', 'Y'];
    ours = side('o', ko, ['X', 'Y']); theirs = side('t', kt, ['Y', 'X']);
  } else {
    const L = MULTIPLICITY[mult];
    const s = under('s'); add('z', s ? [s] : []);
    for (let i = L; i >= 1; i--) add(`h${i}`, [i === L ? 'z' : `h${i + 1}`]);
    add('c', ['h1']); bases = ['c'];
    ours = side('o', ko, ['c', 'z']); theirs = side('t', kt, ['c', 'z']);
  }
  return { spec, ours, theirs, bases, k: [ko, kt] };
}

// The shape as a real repository: fast-import, one commit per spec entry, each adding f/<name> to the union of its
// parents' files. Returns name → oid and the lie target (dag.js model shape, commit and tree bytes).
function build(root, name, { spec, ours, theirs }) {
  const bare = makeBareRepo(root, name);
  const files = new Map(); const mark = new Map(); let stream = '';
  const data = s => `data ${Buffer.byteLength(s)}\n${s}\n`;
  spec.forEach(([n, ps], i) => {
    const f = new Set([`f/${n}`]); for (const p of ps) for (const x of files.get(p)) f.add(x); files.set(n, f);
    mark.set(n, i + 1);
    stream += `reset refs/tmp/b\ncommit refs/tmp/b\nmark :${i + 1}\nauthor w <w@x> 1700000000 +0000\ncommitter w <w@x> 1700000000 +0000\n${data(n)}`;
    if (ps.length) stream += `from :${mark.get(ps[0])}\n`; for (const p of ps.slice(1)) stream += `merge :${mark.get(p)}\n`;
    stream += 'deleteall\n'; for (const x of [...f].sort()) stream += `M 100644 inline ${x}\n${data(x.slice(2))}`;
  });
  const marks = join(bare, 'marks');
  sh(bare, ['fast-import', '--quiet', `--export-marks=${marks}`], stream);
  const byMark = new Map(readFileSync(marks, 'utf8').trim().split('\n').map(l => { const [m, o] = l.split(' '); return [+m.slice(1), o]; }));
  const oid = new Map(spec.map(([n], i) => [n, byMark.get(i + 1)]));
  sh(bare, ['update-ref', '-d', 'refs/tmp/b']);
  sh(bare, ['update-ref', 'refs/heads/main', oid.get(ours)]); sh(bare, ['update-ref', 'refs/heads/feat', oid.get(theirs)]);
  // the lie target: commits as dag.js readModel gives them, and every commit's and root tree's bytes, read in one batch
  const all = [...oid.values()];
  const batch = r => { const buf = spawnSync('git', ['-C', bare, 'cat-file', '--batch'], { input: r.join('\n') + '\n', maxBuffer: 1 << 26 }).stdout; const res = []; let p = 0;
    while (p < buf.length) { const nl = buf.indexOf(10, p); const [, , size] = buf.subarray(p, nl).toString().split(' '); const s = +size; res.push(new Uint8Array(buf.subarray(nl + 1, nl + 1 + s))); p = nl + 1 + s + 1; } return res; };
  const cdata = batch(all); const commitData = new Map(all.map((o, i) => [o, cdata[i]]));
  const commits = new Map(all.map((o, i) => { const txt = Buffer.from(cdata[i]).toString('latin1'); return [o, { tree: /^tree ([0-9a-f]{40})/.exec(txt)[1], parents: [...txt.matchAll(/^parent ([0-9a-f]{40})$/gm)].map(m => m[1]), date: 1700000000 }]; }));
  const treeList = [...new Set([...commits.values()].map(c => c.tree))]; const tdata = batch(treeList); const trees = new Map(treeList.map((t, i) => [t, tdata[i]]));
  return { bare, oid, target: { model: { commits }, commitData, treeOf: c => trees.get(commits.get(c).tree) } };
}

let root, cleanup, srv, decoy;
before(async () => {
  ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root);
  // the unrelated commit for mb:extra-foreign
  const d = makeBareRepo(root, 'decoy');
  sh(d, ['fast-import', '--quiet'], 'commit refs/heads/main\ncommitter d <d@x> 1700000000 +0000\ndata 6\ndecoy\nM 100644 inline decoy.txt\ndata 6\ndecoy\n\n');
  const head = out(d, ['rev-parse', 'main']);
  decoy = { type: TYPE.COMMIT, data: new Uint8Array(spawnSync('git', ['-C', d, 'cat-file', 'commit', head]).stdout) };
});
after(async () => { await srv?.close(); cleanup?.(); });

// One cell: run `op` behind `server` on a fresh copy of the shape's refs; return the problems git finds with it.
async function cell(S, R, server, op, seed, git) {
  const M = { ...R.target, decoy, lied: 0, omitted: 0 };
  const ours = R.oid.get(S.ours), theirs = R.oid.get(S.theirs);
  sh(R.bare, ['update-ref', 'refs/heads/main', ours]); sh(R.bare, ['update-ref', 'refs/heads/feat', theirs]);
  const proxy = await startProxy(srv.url, mergeLie(M, server, seed));
  const url = `${proxy.url}/${R.name}.git`; const limits = withLimits({ requestTimeoutMs: 5000, maxMergeDepth: CAP });
  let res = null, err = null;
  try {
    if (op === 'mergeBase') res = await mergeBase(createTransport(url, { tracer: new Tracer(), limits }), ours, theirs, { maxDepth: CAP });
    else if (op === 'mergeBranch') res = await mergeBranch(url, { ref: 'refs/heads/main', from: 'refs/heads/feat', author: { name: 'm', email: 'm@x' } }, { tracer: new Tracer(), limits, rediff });
    else res = await rebaseBranch(url, { ref: 'refs/heads/main', onto: 'refs/heads/feat', committer: { name: 'r', email: 'r@x' }, time: 1700000000 }, { tracer: new Tracer(), limits, rediff });
  } catch (e) { err = e; }
  await proxy.close();
  const p = []; const lied = M.lied > 0;
  const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
  const now = out(R.bare, ['rev-parse', 'refs/heads/main']);
  if (err) {
    if (!CODES.has(err.code)) p.push(`untyped ${err.code ?? err.name}: ${err.message}`);
    if (now !== ours) p.push('ref moved on error');
    const ok = err.code === 'pack_corrupt' || err.code === 'limit_exceeded' ? lied // a lie, caught or run to the cap
      : err.code === 'merge_conflict' ? git.bases.length > 1 && same([...(err.bases ?? [])].sort(), git.bases) // criss-cross refusal, git's bases
        : err.code === 'not_linear' ? op === 'rebaseBranch' && git.branchMerges > 0 : false; // ply rebases linear branches only
    if (!ok) p.push(`${err.code} (${lied ? 'lied to' : 'HONEST'}): ${err.message}`);
  } else if (op === 'mergeBase') {
    if (!same([...res.bases].sort(), git.bases)) p.push(`bases ${res.bases.map(x => x.slice(0, 8))} != git ${git.bases.map(x => x.slice(0, 8))} (${lied ? 'lied to' : 'HONEST'}, depth ${res.depth})`);
  } else if (op === 'mergeBranch') {
    if (git.bases.length !== 1) p.push(`merged (${res.outcome}) where git has ${git.bases.length} bases`);
    else if (res.outcome !== 'merge' || res.base !== git.bases[0] || res.tree !== git.mergeTree) p.push(`merge ${res.outcome} base ${String(res.base).slice(0, 8)} tree ${String(res.tree).slice(0, 8)}; git: base ${git.bases[0].slice(0, 8)} tree ${git.mergeTree.slice(0, 8)}`);
    else if (!same(out(R.bare, ['rev-list', '--parents', '-n1', 'main']).split(' ').slice(1), [ours, theirs])) p.push('merge commit parents are not [ours, theirs]');
  } else if (git.branchMerges > 0) p.push(`rebased a branch with ${git.branchMerges} merge commit(s): ply's contract is not_linear`);
  else {
    const trees = out(R.bare, ['log', '--format=%T', '--reverse', `${theirs}..main`]).split('\n');
    if (!same(trees, git.rebaseTrees)) p.push(`rebase trees ${trees.length} != git rebase ${git.rebaseTrees.length} (or differ)`);
  }
  if (!err && op !== 'mergeBase') { const f = fsckProblems(R.bare); if (f.length) p.push(`fsck: ${f[0]}`); }
  // lies the pack itself contradicts are pack_corrupt whenever they fired
  if (lied && ['mb:omit-want', 'mb:extra-foreign'].includes(server) && err?.code !== 'pack_corrupt') p.push(`${server} fired but outcome ${err ? err.code : 'success'}`);
  return { problems: p, lied, outcome: err ? (err.code ?? `untyped ${err.name}`) : op === 'mergeBase' ? `ok(${res.bases.length})@${res.depth}` : `ok:${res.outcome}` };
}

test('merge-base outcome space: position × multiplicity × settled × server × op, every cell equal to git', { timeout: 15 * 60_000 }, async () => {
  const shapes = []; for (const pos of Object.keys(POSITION)) for (const mult of Object.keys(MULTIPLICITY)) for (const settled of Object.keys(SETTLED)) shapes.push({ pos, mult, settled });
  const fails = [], fired = new Map(SERVERS.map(s => [s, 0])), tally = new Map(); let cells = 0, seq = 0;
  const runShape = async ({ pos, mult, settled }, idx) => {
    const S = shape(pos, mult, settled); const name = `s${idx}`; const R = { ...build(root, name, S), name };
    const ours = R.oid.get(S.ours), theirs = R.oid.get(S.theirs);
    // git's answer, and the tags checked against it: the multiplicity's base count and the position's k on each side
    const bases = out(R.bare, ['merge-base', '--all', ours, theirs]).split('\n').sort();
    assert.deepEqual(bases, S.bases.map(n => R.oid.get(n)).sort(), `${pos}/${mult}/${settled}: git's bases are the shape's`);
    const excl = bases.map(b => `^${b}`);
    assert.deepEqual([+out(R.bare, ['rev-list', '--count', ours, ...excl]), +out(R.bare, ['rev-list', '--count', theirs, ...excl])], S.k, `${pos}/${mult}/${settled}: k above the base(s)`);
    const mt = sh(R.bare, ['merge-tree', '--write-tree', ours, theirs]); assert.equal(mt.status, 0, 'git merges cleanly');
    // merges on the rebased branch (git rebase drops them and linearizes; ply refuses: not_linear, its stated contract)
    const git = { bases, mergeTree: mt.stdout.split('\n')[0].trim(), rebaseTrees: null, branchMerges: +out(R.bare, ['rev-list', '--count', '--merges', ours, ...excl]) };
    if (bases.length === 1) {
      const d = mkdtempSync(join(tmpdir(), 'mbs-')); sh(d, ['clone', '-q', R.bare, '.']); sh(d, ['rebase', '-q', 'origin/feat']);
      git.rebaseTrees = out(d, ['log', '--format=%T', '--reverse', 'origin/feat..HEAD']).split('\n'); rmSync(d, { recursive: true, force: true });
    }
    for (const server of SERVERS) for (const op of ['mergeBase', 'mergeBranch', ...(server === 'mb:honest' && bases.length === 1 ? ['rebaseBranch'] : [])]) {
      const seed = (idx * 7919 + SERVERS.indexOf(server) * 104729 + op.length) >>> 0;
      const r = await cell(S, R, server, op, seed, git); cells++; seq++;
      if (r.lied) fired.set(server, fired.get(server) + 1);
      const key = `${server} ${op} → ${r.outcome.replace(/@\d+$/, '')}`; tally.set(key, (tally.get(key) ?? 0) + 1);
      if (r.problems.length) fails.push(`${pos}/${mult}/${settled} ${server} ${op}: ${r.problems.join('; ')}`);
    }
  };
  // shapes in parallel (each has its own repository), cells of one shape in sequence (they share its refs)
  let next = 0; await Promise.all(Array.from({ length: 6 }, async () => { while (next < shapes.length) { const i = next++; await runShape(shapes[i], i); } }));
  const expected = shapes.length * (SERVERS.length * 2) + shapes.filter(s => s.mult !== 'two').length;
  console.log(`# merge-base space: ${shapes.length} shapes, ${cells} cells (expected ${expected}), ${fails.length} failures`);
  console.log([...tally].sort().map(([k, v]) => `#   ${String(v).padStart(4)} ${k}`).join('\n'));
  assert.equal(cells, expected);
  for (const s of SERVERS) if (s !== 'mb:honest') assert.ok(fired.get(s) > 0, `${s} fired in some cell`);
  assert.deepEqual(fails, []);
});
