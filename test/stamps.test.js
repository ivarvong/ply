// Author and committer stamps, decided by git (#103 item 4): each stamp carries its own name, email, time and zone, and
// merge `from` / rebase `onto` take a 40-hex commit id as well as a branch. For every stamp pair and every operation, ply
// writes the commit(s) against a bare repository and git writes them in a clone of the same repository with
// GIT_AUTHOR_* / GIT_COMMITTER_* set to the same stamps; the raw objects (`git cat-file -p`) must be byte-equal.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { git, tmpRoot, makeBareRepo, startGitServer } from './server.js';
import { oracleRediff } from './gitversion.js';
import { mergeBranch } from '../src/merge.js';
import { rebaseBranch, cherryPick, revertCommit } from '../src/rebase.js';
import { Tracer } from '../src/otel.js';

const rediff = oracleRediff();
const BASE_ENV = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' };
const as = (a, c) => ({ ...BASE_ENV, GIT_AUTHOR_NAME: a.name, GIT_AUTHOR_EMAIL: a.email, GIT_AUTHOR_DATE: `@${a.time} ${a.tz ?? '+0000'}`, GIT_COMMITTER_NAME: c.name, GIT_COMMITTER_EMAIL: c.email, GIT_COMMITTER_DATE: `@${c.time} ${c.tz ?? '+0000'}` });
const run = (cwd, args, env) => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}${r.stdout}`); return r.stdout.trim(); };

// the history's own commits, by someone else at another time
const ORIG = { name: 'orig', email: 'orig@x', time: 1400000000, tz: '+0200' };
// stamp pairs: author, committer — zones either side of UTC, the civil extremes, a half and a quarter hour, and an
// omitted zone (+0000)
export const PAIRS = [
  [{ name: 'Ann', email: 'ann@x', time: 1700000000, tz: '+0530' }, { name: 'Cid', email: 'cid@x', time: 1700003600, tz: '-0800' }],
  [{ name: 'Ann', email: 'ann@x', time: 1600000000, tz: '-1200' }, { name: 'Cid', email: 'cid@x', time: 1600000123, tz: '+1400' }],
  [{ name: 'Ann', email: 'ann@x', time: 1500000000 }, { name: 'Cid', email: 'cid@x', time: 1500000001, tz: '+0545' }],
];
export const OPS = ['merge from a branch', 'merge from a commit id', 'rebase onto a branch', 'rebase onto a commit id', 'squash', 'cherry-pick', 'revert'];

let root, cleanup, srv, n = 0;
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv?.close(); cleanup?.(); });

// base ← main (m.txt); base ← feat (a.txt, then b.txt). Returns the bare repo and the oids.
function build() {
  const name = `st${n++}`; const bare = makeBareRepo(root, name); const w = join(root, `w${name}`); mkdirSync(w);
  const env = as(ORIG, ORIG);
  git(w, ['init', '-q', '-b', 'main']);
  const commit = (file, msg) => { writeFileSync(join(w, file), `${file}\n`); run(w, ['add', '-A'], env); run(w, ['commit', '-q', '-m', msg], env); return run(w, ['rev-parse', 'HEAD'], env); };
  const base = commit('f.txt', 'base');
  const main = commit('m.txt', 'm');
  run(w, ['checkout', '-q', '-b', 'feat', base], env);
  commit('a.txt', 'a'); const feat = commit('b.txt', 'b');
  run(w, ['push', '-q', bare, 'refs/heads/main', 'refs/heads/feat'], env);
  rmSync(w, { recursive: true, force: true });
  return { name, bare, url: `${srv.url}/${name}.git`, main, feat };
}
const clone = (bare, branch) => { const d = mkdtempSync(join(tmpdir(), 'st-')); run(d, ['clone', '-q', '-b', branch, bare, '.'], BASE_ENV); return d; };
const raw = (repo, oid) => run(repo, ['cat-file', '-p', oid], BASE_ENV);
// the commits from..to, oldest first, as raw objects
const range = (repo, from, to) => run(repo, ['rev-list', '--reverse', `${from}..${to}`], BASE_ENV).split('\n').filter(Boolean).map(o => raw(repo, o));

// one cell: [ply's raw commits, git's raw commits]
async function cell(op, a, c) {
  const r = build(); const opts = { tracer: new Tracer(), rediff };
  const d = clone(r.bare, op.startsWith('rebase') || op === 'squash' ? 'feat' : 'main');
  try {
    const env = as(a, c);
    if (op.startsWith('merge')) {
      const from = op === 'merge from a branch' ? 'refs/heads/feat' : r.feat;
      const res = await mergeBranch(r.url, { ref: 'refs/heads/main', from, author: a, committer: c, message: 'merge msg', noFastForward: true }, opts);
      run(d, ['merge', '--no-ff', '-q', '-m', 'merge msg', r.feat], env);
      return [[raw(r.bare, res.oid)], [raw(d, 'HEAD')]];
    }
    if (op.startsWith('rebase')) {
      const onto = op === 'rebase onto a branch' ? 'refs/heads/main' : r.main;
      const res = await rebaseBranch(r.url, { ref: 'refs/heads/feat', onto, committer: c }, opts);
      run(d, ['rebase', '-q', r.main], env);
      return [range(r.bare, r.main, res.oid), range(d, r.main, 'HEAD')];
    }
    if (op === 'squash') {
      const res = await rebaseBranch(r.url, { ref: 'refs/heads/feat', onto: 'refs/heads/main', committer: c, author: a, squash: true, message: 'squash msg\n' }, opts);
      run(d, ['checkout', '-q', '-B', 'sq', r.main], env); run(d, ['merge', '--squash', '-q', r.feat], env); run(d, ['commit', '-q', '-m', 'squash msg'], env);
      return [[raw(r.bare, res.oid)], [raw(d, 'HEAD')]];
    }
    if (op === 'cherry-pick') {
      const res = await cherryPick(r.url, { ref: 'refs/heads/main', commit: r.feat, committer: c }, opts);
      run(d, ['cherry-pick', r.feat], env);
      return [[raw(r.bare, res.oid)], [raw(d, 'HEAD')]];
    }
    const res = await revertCommit(r.url, { ref: 'refs/heads/main', commit: r.main, committer: c, author: a }, opts);
    run(d, ['revert', '--no-edit', r.main], env);
    return [[raw(r.bare, res.oid)], [raw(d, 'HEAD')]];
  } finally { rmSync(d, { recursive: true, force: true }); }
}

test('author and committer stamps with zones, from/onto by commit id: every commit byte-equal to git\'s', { timeout: 10 * 60_000 }, async () => {
  const bad = []; let cells = 0, commits = 0;
  for (const [i, [a, c]] of PAIRS.entries()) for (const op of OPS) {
    const [ours, theirs] = await cell(op, a, c); cells++; commits += theirs.length;
    assert.ok(theirs.length > 0, `${op}: git wrote nothing`);
    if (JSON.stringify(ours) !== JSON.stringify(theirs)) bad.push(`pair ${i} ${op}:\n  ply: ${JSON.stringify(ours)}\n  git: ${JSON.stringify(theirs)}`);
  }
  console.log(`# stamps: ${cells} cells (${PAIRS.length} stamp pairs × ${OPS.length} operations), ${commits} commits compared, ${bad.length} differ`);
  assert.deepEqual(bad, []);
});

test('from / onto: the zero oid is refused before any request; an oid that is not a commit is not_found', async () => {
  const r = build(); const opts = { tracer: new Tracer(), rediff };
  const zero = '0'.repeat(40);
  await assert.rejects(mergeBranch(r.url, { from: zero, author: PAIRS[0][0] }, opts), e => e.code === 'bad_request' && e.what === 'from');
  await assert.rejects(rebaseBranch(r.url, { ref: 'refs/heads/feat', onto: zero, committer: PAIRS[0][1] }, opts), e => e.code === 'bad_request' && e.what === 'onto');
  const tree = run(r.bare, ['rev-parse', 'main^{tree}'], BASE_ENV);
  await assert.rejects(mergeBranch(r.url, { from: tree, author: PAIRS[0][0] }, opts), e => e.code === 'not_found' && e.what === 'from' && e.miss?.kind === 'commit' && e.miss.miss.kind === 'not_commit' && e.miss.miss.type === 'tree' && e.miss.miss.oid === tree);
  const onto = 'f'.repeat(40);
  await assert.rejects(rebaseBranch(r.url, { ref: 'refs/heads/feat', onto, committer: PAIRS[0][1] }, opts), e => e.code === 'not_found' && e.what === 'onto' && e.miss?.kind === 'commit' && e.miss.miss.kind === 'absent' && e.miss.miss.oid === onto);
  assert.equal(run(r.bare, ['rev-parse', 'main'], BASE_ENV), r.main, 'nothing pushed');
  assert.equal(run(r.bare, ['rev-parse', 'feat'], BASE_ENV), r.feat, 'nothing pushed');
});
