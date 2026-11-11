// runTransfer's result is the class of what happened at the destination (the only commit point). The oracle is git
// http-backend (fsck on) and git itself reading the bare repository; the faults are injected in a fetch wrapper:
//   - a push whose response is dropped after the server applied it: the refs show it, the run goes on to done
//   - a push that never gets an answer and never lands, with maxSteps: the run is `ambiguous`, never `paused`
//   - the final push applied, its response dropped, and the read after it failing: `ambiguous`, never the read's error
//   - two runners on one plan at once, 20 times: both end done, the destination is the planned head, fsck clean
//   - two runners on one plan, gated so the second's push of every step reaches git only after the first's landed, on
//     a destination whose pre-receive hook refuses a push of what is already there: both end done; with the loser's
//     reads failing after its last refusal, the loser is `ambiguous` (never paused, aborted or the refusal)
//   - one runner whose push of every step k is overtaken: before its k-th receive-pack POST is forwarded, step k is
//     landed through a second clean transport. Git itself then refuses the runner's push because the ref moved (a lost
//     compare-and-swap, no hook), or a pre-receive hook installed for that one request declines it: done either way
//   - atomic off, the temp ref's delete refused by an update hook while the create lands: done with tempLeft
//   - a real AbortSignal fired during the final push (after git applied it, and before the request was forwarded):
//     `ambiguous`, never `aborted`; git shows which of the two happened and a resume ends done
//   - a sweep deleting the temp ref just before the final push: atomic off, the branch is published and the run is
//     done; atomic on, git refuses the whole push, nothing is published and the run reports a definite refusal
// Each expectation is the fault the wrapper injected and what git shows in the bare repository, not ply's output.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomFillSync } from 'node:crypto';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, fsckProblems } from './server.js';
import { scanPackIndex } from '../src/packscanindex.js';
import { resolvePackRange } from '../src/packrangeresolve.js';
import { rangeFromBytes } from '../src/rangesource.js';
import { createTransport } from '../src/http.js';
import { planTransfer } from '../src/transferplan.js';
import { runTransfer, transferStep, sweepTransfers } from '../src/transfer.js';
import * as entry from '../src/index.js';
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
    const run = await runTransfer(t, from, p, src.commit, { settle: FAST, ref: REF });
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
    const run = await runTransfer(t, from, p, src.commit, { maxSteps, settle: FAST, ref: REF });
    assert.equal(f.seen.lost - before, maxSteps, 'every push the run was allowed was sent and lost');
    assert.equal(run.ok, false, `a run whose only pushes have an unknown outcome reported ${JSON.stringify(run.ok ? run.value : null)}`);
    assert.equal(run.error.code, 'ambiguous');
    assert.equal(refsOf(bare), '', 'nothing landed');
  }
  // a clean run that stops at maxSteps: paused, and the pause says its last push landed (git: the temp ref moved)
  const clean = repo();
  const paused = must(await runTransfer(clean.t, from, p, src.commit, { maxSteps: 1, settle: FAST, ref: REF }));
  assert.deepEqual(paused, { tag: 'paused', step: 1, pushes: 1, reason: 'max_steps', lastPush: 'acknowledged', lastStep: 'landed' });
  assert.equal(refsOf(clean.bare), `${p.tempRef} ${p.steps[0].temp}`);
  // no push at all
  assert.deepEqual(must(await runTransfer(clean.t, from, p, src.commit, { maxSteps: 0, ref: REF })), { tag: 'paused', step: 1, pushes: 0, reason: 'max_steps', lastPush: 'none', lastStep: 'none' });
});

test('the final push applied, its response dropped, the read after it failing: ambiguous, never the read\'s error', async () => {
  const p = plan();
  const final = p.steps.length - 1;
  let failReads = false;
  const f = faulty({ push: i => { if (i !== final) return 'pass'; failReads = true; return 'drop'; }, read: () => (failReads ? 'fail' : 'pass') });
  const { bare, t } = repo({ fetchImpl: f.fetchImpl });
  const run = await runTransfer(t, from, p, src.commit, { settle: FAST, ref: REF });
  assert.equal(f.seen.dropped, 1);
  assert.ok(f.seen.readsFailed >= 1);
  assertPublished(bare, p); // git: the branch is published
  assert.equal(run.ok, false);
  assert.equal(run.error.code, 'ambiguous', `the push landed and its outcome was unknown to the client; the run said ${run.error.code}: ${run.error.message}`);
  assert.equal(run.error.cause?.code, 'ambiguous', 'carries the push\'s own outcome');
  // a clean resume: done, nothing sent
  failReads = false;
  assert.deepEqual(must(await runTransfer(t, from, p, src.commit, { ref: REF })), { tag: 'done', head: p.head, pushes: 0, tempLeft: false });
});

test('two runners on one plan at once, 20 times: both end done; the destination is the planned head', async () => {
  const p = plan();
  for (let rep = 0; rep < 20; rep++) {
    const { bare, url } = repo();
    const runs = await Promise.all([0, 1].map(() => runTransfer(unwrap(createTransport(url)), from, p, src.commit, { ref: REF })));
    assertPublished(bare, p);
    for (const r of runs) {
      assert.equal(r.ok, true, `rep ${rep}: a runner reported ${r.ok ? '' : `${r.error.code}: ${r.error.message}`} though git shows the transfer complete`);
      assert.equal(r.value.tag, 'done');
      assert.equal(r.value.head, p.head);
    }
  }
}, 240_000);

// Two runners, one plan, one destination, one interleaving (no clock): per step k, runner A's push is forwarded only
// once runner B's push of k is waiting at B's gate (so both chose step k from the same refs), and B's push is forwarded
// only once A's has its whole answer (so git has applied A's). The destination's pre-receive hook refuses a push whose
// new value the ref already has, a refusal that is not a compare-and-swap reason ('pre-receive hook declined':
// push_rejected). So every push B makes is refused by real git while the refs show that step landed.
function gatedRunners(steps, { failReadsAfterLast = false } = {}) {
  const defer = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
  const arrived = Array.from({ length: steps }, defer); // B's push k is at its gate
  const answered = Array.from({ length: steps }, defer); // A's push k has its whole report
  const seen = { a: 0, b: 0, reports: [], readsFailed: 0 };
  const kind = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = init?.method ?? (typeof input === 'string' ? 'GET' : input.method);
    if (method !== 'POST') return 'other';
    if (url.endsWith('/git-receive-pack')) return 'push';
    return url.endsWith('/git-upload-pack') ? 'read' : 'other';
  };
  // the whole report read (the server has applied or refused the push) before anyone is told; the caller gets `res`
  const whole = async res => new TextDecoder().decode(await res.clone().arrayBuffer());
  const a = async (input, init) => {
    if (kind(input, init) !== 'push') return fetch(input, init);
    const k = seen.a++;
    await arrived[k].p;
    const res = await fetch(input, init);
    await whole(res);
    answered[k].open();
    return res;
  };
  const b = async (input, init) => {
    const what = kind(input, init);
    if (what === 'read' && failReadsAfterLast && seen.reports.length === steps) { seen.readsFailed++; throw new TypeError('injected: read failed'); }
    if (what !== 'push') return fetch(input, init);
    const k = seen.b++;
    arrived[k].open();
    await answered[k].p;
    const res = await fetch(input, init);
    seen.reports.push(await whole(res));
    return res;
  };
  // a runner that ends early must not leave the other waiting at a gate
  const release = { a: () => answered.forEach(g => g.open()), b: () => arrived.forEach(g => g.open()) };
  return { a, b, seen, release };
}
// pre-receive: refuse a command whose new value is what the ref already is (a delete is never that).
const REFUSE_LANDED = `#!/bin/sh
while read old new ref; do
  [ "$new" = 0000000000000000000000000000000000000000 ] && continue
  cur=$(git rev-parse -q --verify "$ref" 2>/dev/null)
  if [ "$cur" = "$new" ]; then echo "already there: $ref" >&2; exit 1; fi
done
exit 0
`;
async function raceGated(p, opts) {
  const { bare, url } = repo();
  mkdirSync(join(bare, 'hooks'), { recursive: true });
  writeFileSync(join(bare, 'hooks', 'pre-receive'), REFUSE_LANDED);
  chmodSync(join(bare, 'hooks', 'pre-receive'), 0o755);
  const g = gatedRunners(p.steps.length, opts);
  const [runA, runB] = await Promise.all([
    runTransfer(unwrap(createTransport(url, { fetchImpl: g.a })), from, p, src.commit, { settle: FAST, ref: REF }).finally(g.release.a),
    runTransfer(unwrap(createTransport(url, { fetchImpl: g.b })), from, p, src.commit, { settle: FAST, ref: REF }).finally(g.release.b),
  ]);
  return { bare, g, runA, runB };
}
const say = r => (r.ok ? JSON.stringify(r.value) : `${r.error.code}: ${r.error.message}`);
const DECLINED = /ng refs\/[^\n]*pre-receive hook declined/u;

test('two gated runners, the loser\'s every push refused by git after the winner\'s landed: both done, refs as planned', async () => {
  const p = plan();
  const n = p.steps.length;
  assert.ok(n >= 3);
  const { bare, g, runA, runB } = await raceGated(p);
  // git: the transfer is complete and nothing else is there
  assertPublished(bare, p);
  // the protocol: git refused every push the loser made (its own report-status); the winner made one push per step
  assert.equal(g.seen.a, n);
  assert.equal(g.seen.reports.length, g.seen.b);
  for (const report of g.seen.reports) assert.match(report, DECLINED);
  // the winner pushed every step once; the loser pushed every step once, each refused, each shown landed by the refs
  assert.deepEqual(runA.ok && runA.value, { tag: 'done', head: p.head, pushes: n, tempLeft: false }, `winner: ${say(runA)}`);
  assert.equal(runB.ok, true, `git shows every step the loser pushed landed and the transfer complete; the loser said ${say(runB)}`);
  assert.deepEqual(runB.value, { tag: 'done', head: p.head, pushes: n, tempLeft: false });
  assert.equal(g.seen.b, n);
});

test('two gated runners, the loser\'s reads failing after its last refused push: ambiguous with the refusal as cause, never paused or aborted', async () => {
  const p = plan();
  const n = p.steps.length;
  const { bare, g, runA, runB } = await raceGated(p, { failReadsAfterLast: true });
  assertPublished(bare, p);
  assert.deepEqual(runA.ok && runA.value, { tag: 'done', head: p.head, pushes: n, tempLeft: false }, `winner: ${say(runA)}`);
  assert.equal(g.seen.b, n);
  assert.match(g.seen.reports[n - 1], DECLINED);
  assert.ok(g.seen.readsFailed >= 1);
  // the loser's last push was refused and it could not read the refs: where the destination stands is unknown to it
  assert.equal(runB.ok, false, `the loser could not read the destination after a refused push; it said ${say(runB)}`);
  assert.equal(runB.error.code, 'ambiguous', say(runB));
  assert.equal(runB.error.cause?.code, 'push_rejected', 'carries the push\'s own outcome');
});

test('atomic off, the temp ref\'s delete refused by a hook while the create lands: done, tempLeft', async () => {
  const p = plan({ atomic: false });
  const { bare, t } = repo();
  // update hook: refuse deleting anything under refs/ply/ (new value all zeros), allow everything else
  const hook = join(bare, 'hooks', 'update');
  mkdirSync(join(bare, 'hooks'), { recursive: true });
  writeFileSync(hook, '#!/bin/sh\ncase "$1" in refs/ply/*) [ "$3" = 0000000000000000000000000000000000000000 ] && exit 1 ;; esac\nexit 0\n');
  chmodSync(hook, 0o755);
  const run = await runTransfer(t, from, p, src.commit, { settle: FAST, ref: REF });
  assertPublished(bare, p, { temp: true }); // git: the branch at the planned head, the temp ref still there
  assert.equal(run.ok, true, run.ok ? '' : `the branch is published; the run said ${run.error.code}: ${run.error.message}`);
  assert.deepEqual(run.value, { tag: 'done', head: p.head, pushes: p.steps.length, tempLeft: true });
});

// One runner, overtaken at every step (no clock, no second runner to schedule): before the runner's k-th receive-pack
// POST is forwarded, `before(k)` runs (it lands step k through a second, clean transport), then the request goes to
// git and its whole report is read before the runner sees it. The runner's k-th push is step k: it reads the refs
// after every push, and they show the step the clean transport landed.
const isPush = (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = init?.method ?? (typeof input === 'string' ? 'GET' : input.method);
  return method === 'POST' && url.endsWith('/git-receive-pack');
};
function overtaken(before, around = { enter() {}, leave() {} }) {
  const seen = { pushes: 0, reports: [] };
  const fetchImpl = async (input, init) => {
    if (!isPush(input, init)) return fetch(input, init);
    await before(seen.pushes++);
    around.enter();
    try {
      const res = await fetch(input, init);
      // the hook (if any) stays until git has written its whole report: git runs it after the pack is in
      seen.reports.push(new TextDecoder().decode(await res.clone().arrayBuffer()));
      return res;
    } finally { around.leave(); }
  };
  return { fetchImpl, seen };
}
const NG = /ng refs\/\S+ /u;

test('a runner whose every push is overtaken by another transport landing that step: git refuses each push (the ref moved, or a hook declines), the refs show the step, the run is done', async () => {
  const p = plan();
  const n = p.steps.length;
  assert.ok(n >= 3, 'batch steps and a final step');
  for (const how of ['cas', 'hook']) {
    const { bare, url } = repo();
    const clean = unwrap(createTransport(url));
    const hook = join(bare, 'hooks', 'pre-receive');
    const around = how === 'hook'
      ? { enter() { mkdirSync(join(bare, 'hooks'), { recursive: true }); writeFileSync(hook, '#!/bin/sh\nexit 1\n'); chmodSync(hook, 0o755); }, leave() { rmSync(hook, { force: true }); } }
      : undefined;
    const landed = [];
    const o = overtaken(async k => {
      // the other writer: step k through a clean transport, and git's own view of the ref it moved
      landed.push(must(await transferStep(clean, from, p, k, { commit: src.commit, ref: REF })).step);
      assert.equal(refsOf(bare), k < n - 1 ? `${p.tempRef} ${p.steps[k].temp}` : `${REF} ${p.head}`);
    }, around);
    const run = await runTransfer(unwrap(createTransport(url, { fetchImpl: o.fetchImpl })), from, p, src.commit, { settle: FAST, ref: REF });
    assert.equal(run.ok, true, `${how}: git refused the runner's push of a step the other transport had landed (the refs show it); the runner said ${say(run)}`);
    // the other transport landed every step, in order, before the runner's push of it reached git
    assert.deepEqual(landed, Array.from({ length: n }, (_, k) => k), how);
    // the protocol: git refused every push the runner made, in its own report-status
    assert.equal(o.seen.reports.length, n, how);
    for (const report of o.seen.reports) {
      assert.match(report, NG, how);
      // 'cas': no hook exists, the refusal is git's own (the ref is not at the old value the command names)
      if (how === 'hook') assert.match(report, DECLINED); else assert.doesNotMatch(report, /hook declined/u);
    }
    assertPublished(bare, p);
    assert.deepEqual(run.value, { tag: 'done', head: p.head, pushes: n, tempLeft: false }, how);
  }
});

test('a pause after this run\'s push was refused and another runner landed the step says both: lastPush refused, lastStep landed', async () => {
  const p = plan();
  // refused: step 0 is landed through a clean transport before the runner's push of it reaches git (no hook: git's own
  // compare-and-swap refusal). The two facts are the test's own: the report git sent the runner, and git's refs.
  const refused = repo();
  const clean = unwrap(createTransport(refused.url));
  const o = overtaken(async k => { must(await transferStep(clean, from, p, k, { commit: src.commit, ref: REF })); });
  const paused = must(await runTransfer(unwrap(createTransport(refused.url, { fetchImpl: o.fetchImpl })), from, p, src.commit, { maxSteps: 1, settle: FAST, ref: REF }));
  assert.equal(o.seen.reports.length, 1);
  assert.match(o.seen.reports[0], NG, 'git refused this run\'s push');
  assert.equal(refsOf(refused.bare), `${p.tempRef} ${p.steps[0].temp}`, 'git shows step 0 landed');
  assert.deepEqual(paused, { tag: 'paused', step: 1, pushes: 1, reason: 'max_steps', lastPush: 'refused', lastStep: 'landed' });
  // unanswered: the push applied, its report dropped before the runner saw it; git shows the step landed
  const f = faulty({ push: () => 'drop' });
  const dropped = repo({ fetchImpl: f.fetchImpl });
  const unanswered = must(await runTransfer(dropped.t, from, p, src.commit, { maxSteps: 1, settle: FAST, ref: REF }));
  assert.equal(f.seen.dropped, 1);
  assert.equal(refsOf(dropped.bare), `${p.tempRef} ${p.steps[0].temp}`);
  assert.deepEqual(unanswered, { tag: 'paused', step: 1, pushes: 1, reason: 'max_steps', lastPush: 'unanswered', lastStep: 'landed' });
  // the package entry exports the runner. This is a value check only: the LastPush and LastStep type exports and the
  // paused shape are pinned by test/types/entry.typetest.ts (compiled by tsconfig.check.json in `npm run typecheck`)
  assert.equal(entry.runTransfer, runTransfer);
});

test('a real AbortSignal fired during the final push: ambiguous, never aborted; git decides what landed', async () => {
  const p = plan();
  const n = p.steps.length;
  // 'applied': the signal fires once git has written its whole report for the final push (it landed);
  // 'unsent': it fires before the final push is forwarded (git never saw it). The runner cannot tell them apart.
  for (const when of ['applied', 'unsent']) {
    const controller = new AbortController();
    const seen = { pushes: 0, fired: 0 };
    const fetchImpl = async (input, init) => {
      if (!isPush(input, init) || seen.pushes++ !== n - 1) return fetch(input, init);
      if (when === 'unsent') { seen.fired++; controller.abort(); return fetch(input, init); }
      const res = await fetch(input, init);
      await res.clone().arrayBuffer();
      seen.fired++;
      controller.abort();
      return res;
    };
    const { bare, url } = repo();
    const run = await runTransfer(unwrap(createTransport(url, { fetchImpl, signal: controller.signal })), from, p, src.commit, { settle: FAST, ref: REF });
    assert.equal(seen.fired, 1, when);
    assert.equal(controller.signal.aborted, true);
    // git decides what landed: the branch published, or the temp ref still at the last batch step
    if (when === 'applied') assertPublished(bare, p);
    else assert.equal(refsOf(bare), `${p.tempRef} ${p.steps[n - 2].temp}`);
    assert.equal(run.ok, false, `${when}: the final push's outcome is not known to the runner; it said ${say(run)}`);
    assert.equal(run.error.code, 'ambiguous', `${when}: ${say(run)}`);
    // a resume without the signal: nothing to send when it had landed, the one final push when it had not
    const resumed = must(await runTransfer(unwrap(createTransport(url)), from, p, src.commit, { settle: FAST, ref: REF }));
    assert.deepEqual(resumed, { tag: 'done', head: p.head, pushes: when === 'applied' ? 0 : 1, tempLeft: false }, when);
    assertPublished(bare, p);
  }
});

test('a sweep deleting the temp ref just before the final push: atomic off, published and done; atomic on, nothing published and a definite refusal', async () => {
  for (const atomic of [false, true]) {
    const p = plan({ atomic });
    const n = p.steps.length;
    const { bare, url } = repo();
    const clean = unwrap(createTransport(url));
    const swept = [];
    const o = overtaken(async k => {
      if (k !== n - 1) return;
      assert.equal(refsOf(bare), `${p.tempRef} ${p.steps[n - 2].temp}`);
      swept.push(...must(await sweepTransfers(clean)));
      assert.equal(refsOf(bare), '', 'git: the sweep deleted the temp ref');
    });
    const run = await runTransfer(unwrap(createTransport(url, { fetchImpl: o.fetchImpl })), from, p, src.commit, { settle: FAST, ref: REF });
    assert.deepEqual(swept, [p.tempRef]);
    assert.equal(o.seen.reports.length, n);
    assert.match(o.seen.reports[n - 1], NG, `atomic ${atomic}: git refused the delete of a ref that is gone`);
    if (atomic) {
      // one transaction: the create is refused with the delete, so git shows nothing and the run must not say done
      assert.equal(refsOf(bare), '', 'git: an atomic push refused publishes nothing');
      assert.equal(run.ok, false, `nothing is published; the run said ${say(run)}`);
      assert.notEqual(run.error.code, 'ambiguous', 'git answered the push: a definite refusal');
    } else {
      // two updates: the create lands, the delete is refused; git shows the branch and no temp ref
      assertPublished(bare, p);
      assert.equal(run.ok, true, `the branch is published; the run said ${say(run)}`);
      assert.deepEqual(run.value, { tag: 'done', head: p.head, pushes: n, tempLeft: false });
      assert.deepEqual(must(await runTransfer(clean, from, p, src.commit, { ref: REF })), { tag: 'done', head: p.head, pushes: 0, tempLeft: false });
    }
  }
});

// A failure before any push request (REQ A): nothing was sent to receive-pack, so nothing can have landed and ply knows
// it. It is reported as what it is, with no settle reads. Oracle: this wrapper's own counts of the runner's requests
// (receive-pack POSTs, ls-refs reads, receive-pack advertisement GETs) and git's refs. `read(nth)` and `advert()` inject
// the faults; `landed(nth)` runs once the nth read's whole answer is in.
function counted({ read = () => 'pass', advert = () => 'pass', landed = async () => {} } = {}) {
  const seen = { posts: 0, reads: 0, adverts: 0, postsAfterAdvert: 0, readsAfterAdvert: 0 };
  let down = false;
  const fetchImpl = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = init?.method ?? (typeof input === 'string' ? 'GET' : input.method);
    if (isPush(input, init)) { seen.posts++; if (seen.adverts > 0) seen.postsAfterAdvert++; }
    if (method === 'GET' && url.includes('service=git-receive-pack')) { seen.adverts++; if (advert() === 'down') down = true; }
    if (method === 'POST' && url.endsWith('/git-upload-pack')) {
      const nth = seen.reads++;
      if (seen.adverts > 0) seen.readsAfterAdvert++;
      if (down || read(nth) === 'fail') throw new TypeError('injected: read failed');
      const res = await fetch(input, init);
      await res.clone().arrayBuffer();
      await landed(nth);
      return res;
    }
    if (down) throw new TypeError('injected: host down');
    return fetch(input, init);
  };
  return { fetchImpl, seen };
}
const codeOf = r => (r.ok ? `ok ${JSON.stringify(r.value)}` : r.error.code);

test('a push refused here before any push request (the transport\'s maxPackBytes under the batch): limit_exceeded as it is, one read, no push request; never ambiguous, never a refused push', async () => {
  const p = plan();
  // every batch carries 40 KB blobs of random bytes, so 10 KB is under each: pushPack's plan refuses step 0 locally
  const limits = { maxPackBytes: 10_000 };
  // the refs readable
  const a = counted();
  const fine = repo({ fetchImpl: a.fetchImpl, limits });
  const r1 = await runTransfer(fine.t, from, p, src.commit, { settle: FAST, ref: REF });
  assert.equal(codeOf(r1), 'limit_exceeded', say(r1));
  assert.deepEqual([a.seen.posts, a.seen.reads], [0, 1], 'no push request; the one status read before the step and no settle read');
  assert.equal(refsOf(fine.bare), '');
  // every read after the first failing: still the refusal, and no read was made to fail
  const b = counted({ read: nth => (nth >= 1 ? 'fail' : 'pass') });
  const unreadable = repo({ fetchImpl: b.fetchImpl, limits });
  const r2 = await runTransfer(unreadable.t, from, p, src.commit, { settle: FAST, ref: REF });
  assert.equal(codeOf(r2), 'limit_exceeded', say(r2));
  assert.deepEqual([b.seen.posts, b.seen.reads], [0, 1]);
  assert.equal(refsOf(unreadable.bare), '');
  // another runner (a clean transport) lands step 0 right after this run's first read; maxSteps 1. This run made no
  // push: it is not a pause counting one, and not `lastPush: 'refused'` (no server refused anything)
  const other = { land: async () => {} };
  const c = counted({ landed: async nth => { if (nth === 0) await other.land(); } });
  const raced = repo({ fetchImpl: c.fetchImpl, limits });
  const clean = unwrap(createTransport(raced.url, {}));
  other.land = async () => { must(await transferStep(clean, from, p, 0, { commit: src.commit, ref: REF })); };
  const r3 = await runTransfer(raced.t, from, p, src.commit, { maxSteps: 1, settle: FAST, ref: REF });
  assert.equal(refsOf(raced.bare), `${p.tempRef} ${p.steps[0].temp}`, 'git shows the other runner landed step 0');
  assert.equal(codeOf(r3), 'limit_exceeded', say(r3));
  assert.deepEqual([c.seen.posts, c.seen.reads], [0, 1]);
});

test('the final push\'s advertisement GET failing (a real AbortSignal; the host down): aborted or network as it is, no push request for that step, no settle read', async () => {
  const p = plan();
  const n = p.steps.length;
  assert.equal(p.atomic, true);
  assert.ok(n >= 2 && p.steps[n - 2].kind === 'batch', 'the final step follows a batch: only it reads the advertisement');
  for (const [fault, code] of [['abort', 'aborted'], ['down', 'network']]) {
    const controller = new AbortController();
    const c = counted({ advert: () => { if (fault === 'abort') controller.abort(); return fault === 'down' ? 'down' : 'pass'; } });
    const { bare, t } = repo({ fetchImpl: c.fetchImpl, signal: controller.signal });
    const r = await runTransfer(t, from, p, src.commit, { settle: FAST, ref: REF });
    assert.equal(codeOf(r), code, `${fault}: ${say(r)}`);
    assert.ok(c.seen.adverts >= 1, 'the fault was at the advertisement GET');
    assert.equal(c.seen.posts, n - 1, `${fault}: the batch steps' pushes only`);
    assert.deepEqual([c.seen.postsAfterAdvert, c.seen.readsAfterAdvert], [0, 0], `${fault}: no push request and no read after the failed GET`);
    assert.equal(refsOf(bare), `${p.tempRef} ${p.steps[n - 2].temp}`, `${fault}: git shows the last batch and no published ref`);
  }
});
