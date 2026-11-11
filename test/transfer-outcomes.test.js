// runTransfer's result is the class of what happened at the destination (the only commit point). The oracle is git
// http-backend (fsck on) and git itself reading the bare repository; the faults are injected in a fetch wrapper:
//   - a push whose response is dropped after the server applied it: the refs show it, the run goes on to done
//   - a push that never gets an answer and never lands, with maxSteps: the run is `ambiguous`, never `paused`
//   - the final push applied, its response dropped, and the read after it failing: `ambiguous`, never the read's error
//   - two runners on one plan at once, 20 times: both end done, the destination is the planned head, fsck clean
//   - atomic off, the temp ref's delete refused by an update hook while the create lands: done with tempLeft
// Each expectation is the fault the wrapper injected and what git shows in the bare repository, not ply's output.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomFillSync } from 'node:crypto';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, fsckProblems } from './server.js';
import { scanPackIndex } from '../src/packscanindex.js';
import { resolvePackRange } from '../src/packrangeresolve.js';
import { rangeFromBytes } from '../src/rangesource.js';
import { createTransport } from '../src/http.js';
import { planTransfer } from '../src/transferplan.js';
import { runTransfer } from '../src/transfer.js';
import { unwrap } from './unwrap.js';

const must = r => { if (r.ok) return r.value; throw Object.assign(new Error(r.error.message), { code: r.error.code }); };
const streamOf = bytes => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
const REF = 'refs/heads/main';
const BUDGET = { maxRequestBytes: 200_000, maxObjects: 300, maxObjectBytes: 1 << 20, maxCompressedObjectBytes: 1 << 20, reserveBytes: 0, reserveObjects: 0 };
const FAST = { reads: 3, delayMs: 0 };

let root, cleanup, srv, n = 0, src, from;
before(async () => {
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  const work = join(root, 'source');
  mkdirSync(work, { recursive: true });
  git(work, ['init', '-q', '-b', 'main']);
  for (let i = 0; i < 10; i++) {
    const blob = new Uint8Array(40_000 + i * 500);
    randomFillSync(blob);
    writeFileSync(join(work, `r${i}.bin`), blob);
  }
  git(work, ['add', '.']);
  git(work, ['-c', 'user.name=Ann Author', '-c', 'user.email=ann@x', 'commit', '-q', '-m', 'one']);
  const head = git(work, ['rev-parse', 'HEAD']).trim();
  const objs = git(work, ['rev-list', '--objects', '--no-walk', head]);
  const pack = new Uint8Array(gitBuf(work, ['pack-objects', '--stdout', '-q'], objs));
  src = { commit: new Uint8Array(gitBuf(work, ['cat-file', 'commit', head])) };
  const p = must(await scanPackIndex(streamOf(pack)));
  const source = rangeFromBytes(pack);
  from = { source, pack: p, resolved: must(await resolvePackRange(p, source)) };
});
after(async () => { await srv?.close(); cleanup?.(); });

// A fetch that injects faults by request: `push(i)` for the i-th receive-pack POST (0-based), `read()` for every
// upload-pack POST (ls-refs). 'drop': the server gets the whole request and answers, the answer is thrown away (the
// client sees a network failure after the server applied the push); 'lose': the request never reaches the server.
function faulty({ push = () => 'pass', read = () => 'pass' } = {}) {
  const seen = { pushes: 0, dropped: 0, lost: 0, readsFailed: 0 };
  const fetchImpl = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = init?.method ?? (typeof input === 'string' ? 'GET' : input.method);
    if (method === 'POST' && url.endsWith('/git-upload-pack') && read() === 'fail') { seen.readsFailed++; throw new TypeError('injected: read failed'); }
    if (method !== 'POST' || !url.endsWith('/git-receive-pack')) return fetch(input, init);
    const what = push(seen.pushes++);
    if (what === 'lose') {
      // read the body so the client has sent the whole push, then fail without the server ever seeing it
      const body = init?.body ?? (typeof input === 'string' ? null : input.body);
      if (body && typeof body.getReader === 'function') { const r = body.getReader(); for (;;) { const { done } = await r.read(); if (done) break; } }
      seen.lost++;
      throw new TypeError('injected: request lost');
    }
    const res = await fetch(input, init);
    if (what !== 'drop') return res;
    await res.arrayBuffer(); // the server has applied the push and written its whole report
    seen.dropped++;
    throw new TypeError('injected: response dropped');
  };
  return { fetchImpl, seen };
}
function repo(options = {}) {
  const name = `o${n++}`;
  const bare = makeBareRepo(root, name);
  return { bare, url: `${srv.url}/${name}.git`, t: unwrap(createTransport(`${srv.url}/${name}.git`, options)) };
}
const plan = (opts = {}) => must(planTransfer(from.pack, from.resolved, { budget: BUDGET, ref: REF, commit: src.commit, ...opts }));
// The destination as git sees it.
const refsOf = bare => git(bare, ['for-each-ref', '--format=%(refname) %(objectname)']).trim();
const lsRemote = bare => git(bare, ['ls-remote', bare]).trim();
function assertPublished(bare, p, { temp = false } = {}) {
  assert.equal(refsOf(bare), temp ? `${REF} ${p.head}\n${p.tempRef} ${git(bare, ['rev-parse', p.tempRef]).trim()}` : `${REF} ${p.head}`);
  assert.match(lsRemote(bare), new RegExp(`^${p.head}\\t${REF}$`, 'm'));
  assert.deepEqual(fsckProblems(bare, { args: ['--strict'] }), []);
}

test('a push applied whose response is dropped: the refs show it, the run goes on to done', async () => {
  const p = plan();
  assert.ok(p.steps.length >= 3);
  for (const nth of [1, p.steps.length - 1]) {
    const f = faulty({ push: i => (i === nth ? 'drop' : 'pass') });
    const { bare, t } = repo({ fetchImpl: f.fetchImpl });
    const run = await runTransfer(t, from, p, src.commit, { settle: FAST });
    assert.equal(f.seen.dropped, 1);
    assert.equal(run.ok, true, run.ok ? '' : `${run.error.code}: ${run.error.message}`);
    // every step was sent exactly once (the dropped one landed: git shows the head), so pushes is the step count
    assert.deepEqual(run.value, { tag: 'done', head: p.head, pushes: p.steps.length, tempLeft: false });
    assertPublished(bare, p);
  }
});

test('maxSteps: a push that gets no answer and does not land is ambiguous, never paused; a pause names its last push', async () => {
  const p = plan();
  // every push is lost before the server: the client sent it whole and has no report (the protocol's unknown outcome)
  const f = faulty({ push: () => 'lose' });
  const { bare, t } = repo({ fetchImpl: f.fetchImpl });
  for (const maxSteps of [1, 1, 2]) {
    const before = f.seen.lost;
    const run = await runTransfer(t, from, p, src.commit, { maxSteps, settle: FAST });
    assert.equal(f.seen.lost - before, maxSteps, 'every push the run was allowed was sent and lost');
    assert.equal(run.ok, false, `a run whose only pushes have an unknown outcome reported ${JSON.stringify(run.ok ? run.value : null)}`);
    assert.equal(run.error.code, 'ambiguous');
    assert.equal(refsOf(bare), '', 'nothing landed');
  }
  // a clean run that stops at maxSteps: paused, and the pause says its last push landed (git: the temp ref moved)
  const clean = repo();
  const paused = must(await runTransfer(clean.t, from, p, src.commit, { maxSteps: 1, settle: FAST }));
  assert.deepEqual(paused, { tag: 'paused', step: 1, pushes: 1, reason: 'max_steps', last: 'landed' });
  assert.equal(refsOf(clean.bare), `${p.tempRef} ${p.steps[0].temp}`);
  // no push at all
  assert.deepEqual(must(await runTransfer(clean.t, from, p, src.commit, { maxSteps: 0 })), { tag: 'paused', step: 1, pushes: 0, reason: 'max_steps', last: 'none' });
});

test('the final push applied, its response dropped, the read after it failing: ambiguous, never the read\'s error', async () => {
  const p = plan();
  const final = p.steps.length - 1;
  let failReads = false;
  const f = faulty({ push: i => { if (i !== final) return 'pass'; failReads = true; return 'drop'; }, read: () => (failReads ? 'fail' : 'pass') });
  const { bare, t } = repo({ fetchImpl: f.fetchImpl });
  const run = await runTransfer(t, from, p, src.commit, { settle: FAST });
  assert.equal(f.seen.dropped, 1);
  assert.ok(f.seen.readsFailed >= 1);
  assertPublished(bare, p); // git: the branch is published
  assert.equal(run.ok, false);
  assert.equal(run.error.code, 'ambiguous', `the push landed and its outcome was unknown to the client; the run said ${run.error.code}: ${run.error.message}`);
  assert.equal(run.error.cause?.code, 'ambiguous', 'carries the push\'s own outcome');
  // a clean resume: done, nothing sent
  failReads = false;
  assert.deepEqual(must(await runTransfer(t, from, p, src.commit)), { tag: 'done', head: p.head, pushes: 0, tempLeft: false });
});

test('two runners on one plan at once, 20 times: both end done; the destination is the planned head', async () => {
  const p = plan();
  for (let rep = 0; rep < 20; rep++) {
    const { bare, url } = repo();
    const runs = await Promise.all([0, 1].map(() => runTransfer(unwrap(createTransport(url)), from, p, src.commit)));
    assertPublished(bare, p);
    for (const r of runs) {
      assert.equal(r.ok, true, `rep ${rep}: a runner reported ${r.ok ? '' : `${r.error.code}: ${r.error.message}`} though git shows the transfer complete`);
      assert.equal(r.value.tag, 'done');
      assert.equal(r.value.head, p.head);
    }
  }
}, 240_000);

test('atomic off, the temp ref\'s delete refused by a hook while the create lands: done, tempLeft', async () => {
  const p = plan({ atomic: false });
  const { bare, t } = repo();
  // update hook: refuse deleting anything under refs/ply/ (new value all zeros), allow everything else
  const hook = join(bare, 'hooks', 'update');
  mkdirSync(join(bare, 'hooks'), { recursive: true });
  writeFileSync(hook, '#!/bin/sh\ncase "$1" in refs/ply/*) [ "$3" = 0000000000000000000000000000000000000000 ] && exit 1 ;; esac\nexit 0\n');
  chmodSync(hook, 0o755);
  const run = await runTransfer(t, from, p, src.commit, { settle: FAST });
  assertPublished(bare, p, { temp: true }); // git: the branch at the planned head, the temp ref still there
  assert.equal(run.ok, true, run.ok ? '' : `the branch is published; the run said ${run.error.code}: ${run.error.message}`);
  assert.deepEqual(run.value, { tag: 'done', head: p.head, pushes: p.steps.length, tempLeft: true });
});
