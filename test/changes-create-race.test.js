// commitChanges creating a ref from a base, while another writer creates that same ref AT THE BASE COMMIT between two
// of the call's requests. The compare-and-swap is the one the call resolved when it read the target (its first
// request): "absent" pushes with the zero old oid, on the streamed single-edit path as on the in-memory path.
//
// Expected values are hand-derived from the contract (README, "One commit from a change list"), not from the code:
//   - the call's first request reads the target ref. A ref the other writer made BEFORE it (N = 1) is seen:
//     a ref base, or head pinned to the zero id, is cas_conflict; a 40-hex base equal to that tip with no pin is an
//     ordinary commit on the existing ref (created false, oldOid the tip).
//   - a ref made AFTER it (N >= 2) is not what the call read. The call must not report it created the ref:
//     cas_conflict, expected the zero id, actual the oid that won.
// Judge of the repository: git rev-parse in the bare repo (the ref is where the other writer put it).
// The other writer is injected by a fetchImpl wrapper that runs `git update-ref` just before request N, so every
// window between two requests is covered by a counter, not by timing.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpSync, writeFileSync } from 'node:fs';
import { git, tmpRoot, makeBareRepo, startGitServer } from './server.js';
import { commitChanges } from '../src/changes.js';
import { Tracer } from '../src/otel.js';

const AUTHOR = { name: 'Ada', email: 'ada@x', tz: '+0000', time: 1700000000 };
const ZERO = '0'.repeat(40);
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
  git(seed, ['tag', '-a', '-m', 'v1', 'v1', 'main']); git(seed, ['tag', 'lw', 'main']);
  tpl = makeBareRepo(root, 'tpl'); git(seed, ['push', '-q', tpl, 'main', 'v1', 'lw']);
  baseCommit = git(seed, ['rev-parse', 'main']).trim();
  // the annotated tag is a tag object, not the commit: the base the call must peel
  assert.notEqual(git(seed, ['rev-parse', 'v1']).trim(), baseCommit);
  assert.equal(git(seed, ['rev-parse', 'v1^{commit}']).trim(), baseCommit);
});
after(async () => { await srv.close(); cleanup(); });

// One run: the other writer creates refs/heads/feature at the base commit just before request N.
async function raceAt(base, list, pin, N) {
  const name = `race${n++}`; const bare = join(root, `${name}.git`);
  cpSync(tpl, bare, { recursive: true });
  let seen = 0, fired = false;
  const fetchImpl = async (...args) => {
    seen++;
    if (seen === N) { git(bare, ['update-ref', 'refs/heads/feature', baseCommit]); fired = true; }
    return fetch(...args);
  };
  const r = await commitChanges(`${srv.url}/${name}.git`, { ref: 'refs/heads/feature', base, author: AUTHOR, message: 'm', changes: list }, { tracer: new Tracer(), fetchImpl, ...(pin ? { head: ZERO } : {}) });
  return { r, fired, bare, requests: seen };
}

for (const baseKind of ['refs/heads/main', 'refs/tags/lw', 'refs/tags/v1', '40-hex commit']) {
  for (const [what, list] of LISTS) {
    for (const pin of [false, true]) {
      test(`a ref created by another writer between requests is cas_conflict: base ${baseKind}, ${what}${pin ? ', head pinned to absent' : ''}`, async () => {
        const base = baseKind === '40-hex commit' ? baseCommit : baseKind;
        const windows = [];
        for (let N = 1; N <= 16; N++) {
          // oxlint-disable-next-line no-await-in-loop -- one run per window, in order
          const { r, fired, bare } = await raceAt(base, list, pin, N);
          if (!fired) break; // the call finished in fewer than N requests: every window is covered
          const tip = git(bare, ['rev-parse', 'refs/heads/feature']).trim();
          const seenBeforeFirstRead = N === 1 && baseKind === '40-hex commit' && !pin;
          if (seenBeforeFirstRead) {
            // the ref existed at the base commit before the call read it: an ordinary commit on an existing ref
            assert.equal(r.ok ? 'ok' : `${r.error.code}: ${r.error.message}`, 'ok', `window ${N}`);
            assert.equal(r.value.created, false, `window ${N}: created`);
            assert.equal(r.value.oldOid, baseCommit, `window ${N}: oldOid`);
            assert.equal(git(bare, ['rev-parse', `${tip}^`]).trim(), baseCommit, `window ${N}: parent`);
            windows.push(`${N}:ok`);
            continue;
          }
          const got = r.ok ? `ok(created=${r.value.created},oldOid=${r.value.oldOid})` : r.error.code;
          assert.equal(got, 'cas_conflict', `window ${N} (ref created just before request ${N})`);
          assert.equal(r.error.expected, ZERO, `window ${N}: expected`);
          assert.equal(r.error.actual, baseCommit, `window ${N}: actual is the oid that won`);
          assert.equal(tip, baseCommit, `window ${N}: the ref is where the other writer put it`);
          windows.push(`${N}:cas_conflict`);
        }
        // the first read and at least one later window were exercised (a call is never one request)
        assert.ok(windows.length >= 2, `windows covered: ${windows.join(' ')}`);
      });
    }
  }
}
