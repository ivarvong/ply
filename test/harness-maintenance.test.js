// The harness's repositories start no background maintenance: observed, not read from config.
//
// Why it matters: a test reads the object store right after a push returns (fsckProblems, ls-tree). git 2.56 on CI
// failed that fsck with "packfile … index not opened" while a repack started by receive-pack was renaming packs (ci
// runs 43067401434 and 43070027886). makeBareRepo sets gc.auto=0, maintenance.auto=false, receive.autoGc=false.
//
// The observation: two pushes over git http-backend into a repository with receive.unpackLimit=1 (each push stays a
// pack) under GIT_TRACE2_EVENT, which every git process the server starts inherits and appends to. trace2's
// `child_start` event carries the argv of each child a git process spawns; none may be `maintenance`, `gc` or `repack`.
//
// The forcing: the environment (GIT_CONFIG_COUNT/KEY_n/VALUE_n) sets gc.auto=1 and gc.autoPackLimit=1, so that any
// `maintenance run --auto` that does start has work on the first pack and goes on to `gc --auto` and `repack`.
// Environment config outranks the repository's file, so this DEFEATS the repository's gc.auto=0 on purpose: what is
// left standing is receive.autoGc=false and maintenance.auto=false, which the environment does not name and which
// stop the process before any task condition is asked. gc.auto=0 by itself is therefore not what this test proves
// (it is the third line of defence, for a maintenance run somebody starts by hand); the test proves that the settings
// that stop the spawn are present and are enough even when the gc task is willing.
//
// The control (same file, same forcing, same pushes): a repository made the same way with the three keys unset again
// must show the `maintenance` child. Without it, an empty list could mean "trace2 did not record" or "this git never
// starts maintenance from receive-pack" (git before 2.29 ran `gc --auto` there instead; the control accepts either
// name). If the control shows no child on some git, the test fails rather than passing vacuously.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitAsync, tmpRoot, makeBareRepo, startGitServer, NO_MAINTENANCE, initRepo } from './server.js';

// PLY_TEST_AUTO_MAINTENANCE=1: test/git-shim/git (below) stands aside for the server's git processes, so the first two
// tests observe the repository's own settings and nothing else.
const SHIM_OFF = { PLY_TEST_AUTO_MAINTENANCE: '1' };
const FORCED = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'gc.auto', GIT_CONFIG_VALUE_0: '1', GIT_CONFIG_KEY_1: 'gc.autoPackLimit', GIT_CONFIG_VALUE_1: '1' };
const MAINTENANCE = new Set(['maintenance', 'gc', 'repack']);

let root, cleanup, n = 0;
before(() => { ({ root, cleanup } = tmpRoot()); });
after(() => cleanup());

// Two pushes into `bare` through a server whose git processes trace to one file. Returns the trace's events.
async function pushTwice(bare, name) {
  const trace = join(root, `trace-${name}.jsonl`);
  const srv = await startGitServer(root, { ...FORCED, ...SHIM_OFF, GIT_TRACE2_EVENT: trace });
  try {
    const work = join(root, `work${n++}`); mkdirSync(work);
    initRepo(work);
    for (const k of [1, 2]) {
      writeFileSync(join(work, 'f.txt'), `${k}\n`);
      git(work, ['add', 'f.txt']);
      git(work, ['-c', 'user.name=t', '-c', 'user.email=t@x', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `c${k}`]);
      const pushed = await gitAsync(work, ['push', '-q', `${srv.url}/${name}.git`, 'HEAD:refs/heads/main']); // async: the server is this process
      assert.equal(pushed.status, 0, pushed.stderr);
    }
  } finally { await srv.close(); }
  assert.ok(existsSync(trace), 'the server-side git processes wrote a trace2 event file');
  const events = readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  // Each push stayed a pack (receive.unpackLimit=1): the state gc.autoPackLimit=1 calls "too many packs".
  const packs = git(bare, ['count-objects', '-v']).match(/^packs: (\d+)$/m);
  assert.equal(packs && packs[1], '2', 'two pushes left two packs: nothing repacked them, and the forcing had packs to see');
  return events;
}
// argv[1] of each child a traced git process started that is a git maintenance command ("git maintenance run --auto",
// "git gc --auto", "git repack -d -l"), and the commands that ran, to show receive-pack is in the trace at all.
const children = events => events.filter(e => e.event === 'child_start' && Array.isArray(e.argv)).map(e => e.argv.filter(a => !a.startsWith('-')).slice(0, 3)).filter(argv => argv.some(a => MAINTENANCE.has(a))).map(argv => argv.join(' '));
const ranReceivePack = events => events.some(e => e.event === 'cmd_name' && e.name === 'receive-pack');

test('harness: a makeBareRepo repository starts no maintenance, gc or repack child after a push, with the gc task forced willing', async () => {
  const bare = makeBareRepo(root, 'quiet');
  git(bare, ['config', 'receive.unpackLimit', '1']);
  const events = await pushTwice(bare, 'quiet');
  assert.ok(ranReceivePack(events), 'receive-pack is in the trace');
  assert.deepEqual(children(events), []);
});

test('harness control: the same repository with the three keys unset does start maintenance (the observation can see it)', async () => {
  const bare = makeBareRepo(root, 'loud');
  git(bare, ['config', 'receive.unpackLimit', '1']);
  for (const [k] of NO_MAINTENANCE) git(bare, ['config', '--unset', k]);
  // One push is enough: receive-pack starts the child whatever the pack count. The two-pack check of pushTwice is
  // not asked here, because this repository may be repacked in the background (the defect itself).
  const trace = join(root, 'trace-loud.jsonl');
  const srv = await startGitServer(root, { ...FORCED, ...SHIM_OFF, GIT_TRACE2_EVENT: trace });
  try {
    const work = join(root, `work${n++}`); mkdirSync(work);
    initRepo(work);
    writeFileSync(join(work, 'f.txt'), '1\n');
    git(work, ['add', 'f.txt']);
    git(work, ['-c', 'user.name=t', '-c', 'user.email=t@x', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'c1']);
    const pushed = await gitAsync(work, ['push', '-q', `${srv.url}/loud.git`, 'HEAD:refs/heads/main']);
    assert.equal(pushed.status, 0, pushed.stderr);
  } finally { await srv.close(); }
  const events = readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(ranReceivePack(events), 'receive-pack is in the trace');
  const seen = children(events);
  assert.ok(seen.some(c => /\b(maintenance|gc)\b/.test(c)), `receive-pack started maintenance without the three keys; saw ${JSON.stringify(seen)}`);
});

// ---- every git process the suite starts (test/git-shim/git, first on PATH from vitest.config.ts) ----
// The files that make their own repositories hand git an environment of their own: GIT_* scrubbed and
// GIT_CONFIG_GLOBAL=/dev/null (test/space/refname.test.js, push-oid.test.js), or their own GIT_CONFIG_COUNT
// (test/stamps.test.js, merge.test.js, rebase.test.js). This is that environment, with the gc task forced willing the
// same way, in a repository made by a bare `git init` that nothing configured: `git commit` starts
// `git maintenance run --auto` there by git's default (builtin/commit.c: run_auto_maintenance), which the control
// (the same steps with the shim told to stand aside) must show.
function commitTraced(name, extraEnv = {}) {
  const dir = join(root, name), trace = join(root, `trace-${name}.jsonl`);
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...FORCED, PLY_TEST_AUTO_MAINTENANCE: '', GIT_TRACE2_EVENT: trace, ...extraEnv };
  mkdirSync(dir);
  git(dir, ['init', '-q', '-b', 'main'], { env });
  writeFileSync(join(dir, 'f.txt'), '1\n');
  git(dir, ['add', 'f.txt'], { env });
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@x', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'c1'], { env });
  const events = readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(events.some(e => e.event === 'cmd_name' && e.name === 'commit'), 'commit is in the trace');
  return children(events);
}

test('harness: git commit in an unconfigured repository, under a scrubbed environment with its own GIT_CONFIG_COUNT, starts no maintenance child', () => {
  assert.deepEqual(commitTraced('bare-init'), []);
});

test('harness control: the same commit with PLY_TEST_AUTO_MAINTENANCE=1 does start maintenance', () => {
  const seen = commitTraced('bare-init-loud', { PLY_TEST_AUTO_MAINTENANCE: '1' });
  assert.ok(seen.some(c => /\b(maintenance|gc)\b/.test(c)), `git commit started maintenance by default; saw ${JSON.stringify(seen)}`);
});
