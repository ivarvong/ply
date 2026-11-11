// commitChanges with a 40-hex base on a target that exists at that commit, while another writer DELETES the target
// between two of the call's requests. Both paths: the single streamed edit and the in-memory change list.
//
// Expected values are hand-derived from the contract (README, "One commit from a change list"), not from the code:
//   - no `head`: the call is last-writer-wins. Whatever request the delete lands before, the call ends with its
//     commit on the ref. The ref was absent when that commit was pushed, so the call created it: created true,
//     oldOid null, and the commit's parent is the base commit (a 40-hex base is that commit). A delete that lands
//     after the call's first read of the target (N >= 2) costs one redo, reported as git.commit.attempt 1.
//   - `head` pinned to the base commit: the caller asked for exactly that tip. The ref is not there, so every
//     window is cas_conflict (expected the pin, actual null: deleted) and the ref stays deleted.
//   - the two paths answer the same race the same way (one expectation, both lists).
// Judge of the repository: git in the bare repo (rev-parse, cat-file).
// The other writer is injected by a fetchImpl wrapper that runs `git update-ref -d` just before request N, so every
// window between two requests is covered by a counter, not by timing.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpSync, writeFileSync } from 'node:fs';
import { git, tmpRoot, makeBareRepo, startGitServer } from './server.js';
import { commitChanges } from '../src/changes.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';

const AUTHOR = { name: 'Ada', email: 'ada@x', tz: '+0000', time: 1700000000 };
const REF = 'refs/heads/feature';
const EDIT = [{ kind: 'edit', path: 'plain.txt', find: 'plain', replace: 'edited' }];
const LISTS = [['single edit (streamed)', EDIT], ['two changes (in memory)', [...EDIT, { kind: 'write', path: 'extra.txt', content: 'e\n' }]]];

let root, cleanup, srv, tpl, baseCommit, n = 0;
before(async () => {
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  const seed = join(root, 'seed');
  git(root, ['init', '-q', '-b', 'main', seed]);
  for (const [k, v] of [['user.name', 's'], ['user.email', 's@x'], ['commit.gpgsign', 'false']]) git(seed, ['config', k, v]);
  writeFileSync(join(seed, 'plain.txt'), 'plain\n');
  git(seed, ['add', '-A']); git(seed, ['commit', '-q', '-m', 'seed']);
  git(seed, ['branch', 'feature', 'main']);
  tpl = makeBareRepo(root, 'tpl'); git(seed, ['push', '-q', tpl, 'main', 'feature']);
  baseCommit = git(seed, ['rev-parse', 'main']).trim();
});
after(async () => { await srv.close(); cleanup(); });

const tipOf = bare => { try { return git(bare, ['rev-parse', '--verify', '-q', REF]).trim(); } catch { return null; } };

// One run: the target exists at the base commit; the other writer deletes it just before request N.
async function raceAt(list, pin, N) {
  const name = `del${n++}`; const bare = join(root, `${name}.git`);
  cpSync(tpl, bare, { recursive: true });
  assert.equal(tipOf(bare), baseCommit);
  let seen = 0, fired = false;
  const fetchImpl = async (...args) => {
    seen++;
    if (seen === N) { git(bare, ['update-ref', '-d', REF]); fired = true; }
    return fetch(...args);
  };
  const exporter = arrayExporter();
  const r = await commitChanges(`${srv.url}/${name}.git`, { ref: REF, base: baseCommit, author: AUTHOR, message: 'm', changes: list }, { tracer: new Tracer({ exporter }), fetchImpl, ...(pin ? { head: baseCommit } : {}) });
  const span = exporter.lines.flatMap(flattenLine).find(s => s.name === 'git.commit');
  return { r, fired, bare, span };
}

for (const [what, list] of LISTS) {
  test(`no head: a target deleted mid-call is committed again on the base, created: ${what}`, async () => {
    const windows = [];
    for (let N = 1; N <= 16; N++) {
      // oxlint-disable-next-line no-await-in-loop -- one run per window, in order
      const { r, fired, bare, span } = await raceAt(list, false, N);
      if (!fired) break; // the call finished in fewer than N requests: every window is covered
      assert.equal(r.ok ? 'ok' : `${r.error.code}: ${r.error.message}`, 'ok', `window ${N} (ref deleted just before request ${N})`);
      assert.equal(r.value.outcome, 'commit', `window ${N}: outcome`);
      assert.equal(r.value.created, true, `window ${N}: created`);
      assert.equal(r.value.oldOid, null, `window ${N}: oldOid`);
      assert.equal(r.value.parent, baseCommit, `window ${N}: parent`);
      const tip = tipOf(bare);
      assert.equal(tip, r.value.oid, `window ${N}: the ref is at the reported commit`);
      assert.equal(git(bare, ['rev-parse', `${tip}^`]).trim(), baseCommit, `window ${N}: git's parent of the tip`);
      assert.equal(git(bare, ['cat-file', '-p', `${tip}:plain.txt`]), 'edited\n', `window ${N}: the edit is in the commit`);
      // the first request is the call's read of the target: a delete before it is simply an absent ref (no redo)
      assert.equal(span.attrs['git.commit.attempt'], N === 1 ? 0 : 1, `window ${N}: the redo is reported`);
      windows.push(N);
    }
    // the first read and at least one later window were exercised (a call is never one request)
    assert.ok(windows.length >= 2, `windows covered: ${windows.join(' ')}`);
  });

  test(`head pinned to the base: a target deleted mid-call is cas_conflict and stays deleted: ${what}`, async () => {
    const windows = [];
    for (let N = 1; N <= 16; N++) {
      // oxlint-disable-next-line no-await-in-loop -- one run per window, in order
      const { r, fired, bare } = await raceAt(list, true, N);
      if (!fired) break;
      const got = r.ok ? `ok(created=${r.value.created},oldOid=${r.value.oldOid})` : r.error.code;
      assert.equal(got, 'cas_conflict', `window ${N} (ref deleted just before request ${N})`);
      assert.equal(r.error.expected, baseCommit, `window ${N}: expected is the pin`);
      assert.equal(r.error.actual, null, `window ${N}: actual is null (deleted)`);
      assert.equal(tipOf(bare), null, `window ${N}: the ref stays deleted`);
      windows.push(N);
    }
    assert.ok(windows.length >= 2, `windows covered: ${windows.join(' ')}`);
  });
}
