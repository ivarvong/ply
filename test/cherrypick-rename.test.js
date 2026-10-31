// Cherry-pick of a rename, decided by git (#103 item 3). The picked commit P renames old.txt → new.txt, edits line 5 of
// it and line 2 of a.txt (optionally making new.txt executable). The target branch made its own changes from the same
// base; every cell of the product
//
//   R  what the target did to old.txt   same (→ new.txt) | other (→ other.txt) | delete | keep
//                                       | same+copy (same, and adds copy.txt = old.txt's base bytes: git can pair old → copy)
//                                       | same+drop (same, and deletes x.txt = P's new.txt bytes: git can pair x → new)
//   C  its content on the target        same (P's edits) | none (untouched) | different (line 8) | further (line 5 past P's)
//   M  the executable bit               none | both (P and the target chmod +x) | ours (the target only)
//
// is cherry-picked with `git cherry-pick` in a clone and with pickCommit against the same bare repository. git's
// outcome class (clean with a tree, empty, conflict) is the expectation; ply may conflict where git is clean only with a
// rename-guard reason (its documented superset: ply does not detect renames), never the other way, and every clean pick
// must be git's tree.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, chmodSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { git, tmpRoot, makeBareRepo, startGitServer } from './server.js';
import { oracleRediff } from './gitversion.js';
import { cherryPick } from '../src/rebase.js';
import { Tracer } from '../src/otel.js';

const rediff = oracleRediff();
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'w', GIT_AUTHOR_EMAIL: 'w@x', GIT_COMMITTER_NAME: 'w', GIT_COMMITTER_EMAIL: 'w@x', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' };
const sh = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: ENV });
const ok = (cwd, args) => { const r = sh(cwd, args); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };

export const R = ['same', 'other', 'delete', 'keep', 'same+copy', 'same+drop'];
export const C = ['same', 'none', 'different', 'further'];
export const M = ['none', 'both', 'ours'];

const lines = (p, edits = {}) => Array.from({ length: 10 }, (_, i) => `${edits[i + 1] ?? `${p}${i + 1}`}\n`).join('');
const OLD = lines('o');
const A = lines('a');

let root, cleanup, srv, n = 0;
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv?.close(); cleanup?.(); });

// One cell's repository: base, the picked commit P on `src`, the target on `dst`. Returns the bare repo and P.
function build(r, c, m) {
  const name = `cp${n++}`; const bare = makeBareRepo(root, name); const w = join(root, `w${name}`); mkdirSync(w);
  git(w, ['init', '-q', '-b', 'main']);
  const put = (p, v) => writeFileSync(join(w, p), v);
  const commit = msg => { ok(w, ['add', '-A']); ok(w, ['commit', '-q', '--allow-empty', '-m', msg]); return ok(w, ['rev-parse', 'HEAD']); };
  put('a.txt', A); put('old.txt', OLD); put('x.txt', lines('o', { 5: 'P5' })); const base = commit('base');
  // P: rename + edit line 5, a.txt line 2, optionally +x
  ok(w, ['checkout', '-q', '-b', 'src', base]);
  renameSync(join(w, 'old.txt'), join(w, 'new.txt')); put('new.txt', lines('o', { 5: 'P5' })); put('a.txt', lines('a', { 2: 'A2' }));
  if (m === 'both') chmodSync(join(w, 'new.txt'), 0o755);
  const p = commit('P');
  // the target
  ok(w, ['checkout', '-q', '-b', 'dst', base]);
  const to = { same: 'new.txt', other: 'other.txt', delete: null, keep: 'old.txt', 'same+copy': 'new.txt', 'same+drop': 'new.txt' }[r];
  if (r === 'same+copy') put('copy.txt', OLD);
  if (r === 'same+drop') rmSync(join(w, 'x.txt'));
  if (to !== 'old.txt') rmSync(join(w, 'old.txt'));
  const content = { same: lines('o', { 5: 'P5' }), none: OLD, different: lines('o', { 8: 'O8' }), further: lines('o', { 5: 'P5' }) }[c];
  if (to) { put(to, content); if (m !== 'none') chmodSync(join(w, to), 0o755); }
  if (c !== 'none') put('a.txt', lines('a', { 2: 'A2' }));
  commit('target');
  if (c === 'further' && to) { put(to, lines('o', { 5: 'Q5' })); commit('target further'); }
  ok(w, ['push', '-q', bare, 'refs/heads/src', 'refs/heads/dst']);
  rmSync(w, { recursive: true, force: true });
  return { name, bare, p };
}

// git's answer: clean (tree), empty, or conflict
function gitPick(bare, p) {
  const d = mkdtempSync(join(tmpdir(), 'cp-'));
  try {
    ok(d, ['clone', '-q', '-b', 'dst', bare, '.']);
    const before = ok(d, ['rev-parse', 'HEAD']);
    const r = sh(d, ['cherry-pick', p]);
    const said = r.stdout + r.stderr;
    if (r.status === 0) { const head = ok(d, ['rev-parse', 'HEAD']); return head === before ? { cls: 'empty' } : { cls: 'clean', tree: ok(d, ['rev-parse', 'HEAD^{tree}']) }; }
    if (/is now empty|nothing to commit/u.test(said)) return { cls: 'empty' };
    return { cls: 'conflict', said: said.split('\n').filter(l => l.startsWith('CONFLICT')).join('; ') };
  } finally { rmSync(d, { recursive: true, force: true }); }
}

async function plyPick(url, p) {
  try {
    const res = await cherryPick(url, { ref: 'refs/heads/dst', commit: p, committer: { name: 'w', email: 'w@x' }, time: 1700000000 }, { tracer: new Tracer(), rediff });
    return res.outcome === 'empty' ? { cls: 'empty' } : { cls: 'clean', tree: res.tree };
  } catch (e) {
    if (e.code !== 'merge_conflict') throw e;
    return { cls: 'conflict', reasons: Object.values(e.reasons ?? {}) };
  }
}

const GUARD = /^possible (rename|directory rename)/u;
// Where git and ply part, by name and why. The target made the rename executable and P did not: git follows the rename on
// both sides, merges the modes (one side changed it) and the pick is empty; rename-blind, the two sides add new.txt with
// different modes, an add/add ply cannot resolve without rename detection.
export const KNOWN = { 'same/same/ours': 'git empty, ply conflict: add/add of new.txt with different modes (rename-blind)' };
test('cherry-pick of a rename: R × C × M, each cell against git cherry-pick', { timeout: 10 * 60_000 }, async () => {
  const tally = new Map(); const bad = []; const superset = []; const known = [];
  for (const r of R) for (const c of C) for (const m of M) {
    const cell = `${r}/${c}/${m}`;
    const { name, bare, p } = build(r, c, m);
    const g = gitPick(bare, p);
    const y = await plyPick(`${srv.url}/${name}.git`, p);
    const key = `git ${g.cls} / ply ${y.cls}`; tally.set(key, (tally.get(key) ?? 0) + 1);
    if (g.cls === y.cls) { if (g.cls === 'clean' && g.tree !== y.tree) bad.push(`${cell}: tree ${y.tree} != git ${g.tree}`); continue; }
    // ply's documented superset (merge.ts): a conflict git does not have, because ply does not detect renames — the
    // rename guard, or the modify/delete a rename-blind merge sees. Recorded with its reasons; never an empty pick.
    if (g.cls === 'clean' && y.cls === 'conflict' && y.reasons.length > 0) { superset.push(`${cell} (${[...new Set(y.reasons.map(x => (GUARD.test(x) ? 'guard' : x)))].join(', ')})`); continue; }
    if (KNOWN[cell] && g.cls === 'empty' && y.cls === 'conflict') { known.push(cell); continue; }
    bad.push(`${cell}: git ${g.cls}${g.said ? ` (${g.said})` : ''}, ply ${y.cls}${y.reasons ? ` (${[...new Set(y.reasons)].join('; ')})` : ''}`);
  }
  console.log(`# cherry-pick rename space: ${R.length * C.length * M.length} cells`);
  console.log([...tally].sort().map(([k, v]) => `#   ${String(v).padStart(3)} ${k}`).join('\n'));
  console.log(`# ply's superset (git clean, ply conflict), ${superset.length}: ${superset.join('; ') || 'none'}`);
  console.log(`# known disagreements: ${known.map(k => `${k} (${KNOWN[k]})`).join('; ') || 'none'}`);
  assert.deepEqual(bad, []);
  assert.deepEqual(known, Object.keys(KNOWN), 'every known disagreement still happens (else drop it from KNOWN)');
});
