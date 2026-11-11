// A stored transfer plan is untrusted input (#238 review): its temp ref is not a free field. The oracle is git
// http-backend behind a proxy that counts requests, and git's own view of the destination's refs afterwards:
//   - a plan whose tempRef is pointed at an existing branch (refs/heads/victim), with a fake batch step at that
//     branch's commit and both hashes recomputed (they are unkeyed: anyone can), is refused as bad_request by
//     checkTransferPlan, transferStatus, transferStep and runTransfer before any request is sent, and the branch is
//     still where git put it
//   - a temp ref under the transfer prefix that is not the one the plan's key names is refused the same way
//   - a plan for another ref than the one the caller names on the call is refused the same way, and so is every call
//     that names no ref: the caller, never the stored plan, says which ref the pushes create
//   - each refusal is by the rule it states (the error's `what`: tempRef, ref, plan, commit)
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer } from './server.js';
import { scanPackIndex } from '../src/packscanindex.js';
import { resolvePackRange } from '../src/packrangeresolve.js';
import { rangeFromBytes } from '../src/rangesource.js';
import { createTransport } from '../src/http.js';
import { planHash } from '../src/packplan.js';
import { planTransfer, checkTransferPlan, transferPlanHash } from '../src/transferplan.js';
import { transferStatus, transferStep, runTransfer } from '../src/transfer.js';
import { unwrap } from './unwrap.js';

const ident = ['-c', 'user.name=Ann Author', '-c', 'user.email=ann@x'];
const BUDGET = { maxRequestBytes: 200_000, maxObjects: 300, maxObjectBytes: 1 << 20, maxCompressedObjectBytes: 1 << 20, reserveBytes: 0, reserveObjects: 0 };
const COPY = 'refs/heads/copy';
const VICTIM = 'refs/heads/victim';
const streamOf = bytes => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });

// A proxy in front of the git server that counts the requests it is sent.
function countingProxy(upstream) {
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    const to = new URL(req.url, upstream);
    const up = http.request(to, { method: req.method, headers: { ...req.headers, host: to.host } }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(up);
  });
  return new Promise(resolve => { server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, count: () => count, close: () => new Promise(done => { server.close(done); }) })); });
}

let root, cleanup, srv, proxy, from, commit, n = 0;
before(async () => {
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  proxy = await countingProxy(srv.url);
  const work = join(root, 'source');
  mkdirSync(join(work, 'a'), { recursive: true });
  git(work, ['init', '-q', '-b', 'main']);
  writeFileSync(join(work, 'a', 'one.txt'), 'one\n');
  writeFileSync(join(work, 'two.txt'), 'two\n');
  git(work, ['add', '.']);
  git(work, [...ident, 'commit', '-q', '-m', 'source']);
  const head = git(work, ['rev-parse', 'HEAD']).trim();
  const pack = new Uint8Array(gitBuf(work, ['pack-objects', '--stdout', '-q'], git(work, ['rev-list', '--objects', '--no-walk', head])));
  commit = new Uint8Array(gitBuf(work, ['cat-file', 'commit', head]));
  const scanned = unwrap(await scanPackIndex(streamOf(pack)));
  const source = rangeFromBytes(pack);
  from = { source, pack: scanned, resolved: unwrap(await resolvePackRange(scanned, source)) };
});
after(async () => { await proxy?.close(); await srv?.close(); cleanup?.(); });

// A destination with a branch the transfer has no business with: an unrelated history, pushed by git.
function destination() {
  const name = `d${n++}`;
  const bare = makeBareRepo(root, name);
  const other = join(root, `${name}-other`);
  mkdirSync(other);
  git(other, ['init', '-q', '-b', 'main']);
  writeFileSync(join(other, 'precious.txt'), 'only copy\n');
  git(other, ['add', '.']);
  git(other, [...ident, 'commit', '-q', '-m', 'victim']);
  git(other, ['push', '-q', bare, `HEAD:${VICTIM}`]);
  return { bare, victim: git(bare, ['rev-parse', VICTIM]).trim(), t: unwrap(createTransport(`${proxy.url}/${name}.git`)) };
}
const refsOf = bare => git(bare, ['for-each-ref', '--format=%(refname) %(objectname)']).trim();
// Both hashes recomputed over the edited plan, as a writer of the plan store can.
function rehashed(plan) {
  const { hash: _packHash, ...packBody } = plan.pack;
  plan.pack.hash = planHash(packBody);
  const { hash: _hash, ...body } = plan;
  plan.hash = transferPlanHash(body);
  return plan;
}
// Every entry point refuses `plan` with bad_request and the stated `what` (which rule refused it), sends nothing, and
// leaves the destination's refs as git shows them. Each call names the ref, as every stored-plan call must.
const answerOf = r => (r.ok ? JSON.stringify(r.value) : [r.error.code, r.error.what]);
async function refusedUnsent(plan, what, opts = { ref: COPY }) {
  const { bare, victim, t } = destination();
  const before = proxy.count();
  const answers = [
    checkTransferPlan(plan, opts),
    await transferStatus(t, plan, opts),
    await transferStep(t, from, plan, 0, { ...opts, commit }),
    await transferStep(t, from, plan, 1, { ...opts, commit }),
    await runTransfer(t, from, plan, commit, opts),
  ];
  for (const [i, r] of answers.entries()) assert.deepEqual(answerOf(r), ['bad_request', what], `entry point ${i}`);
  assert.equal(proxy.count() - before, 0, 'no request was sent');
  assert.equal(refsOf(bare), `${VICTIM} ${victim}`, 'the destination is as git left it');
}
const planned = (opts = {}) => unwrap(planTransfer(from.pack, from.resolved, { budget: BUDGET, ref: COPY, commit, ...opts }));

test('a stored plan whose temp ref is an existing branch, hashes recomputed, is refused before any request and the branch stays', async () => {
  const honest = planned();
  const { victim } = destination();
  const stored = structuredClone(honest);
  stored.tempRef = VICTIM;
  stored.steps = [{ kind: 'batch', temp: victim, prev: { tag: 'none' } }, { kind: 'final', prev: { tag: 'some', value: victim } }];
  stored.pack.batches = [{ kind: 'blobs', entries: [], packBytes: 32, objects: 0, refRewrites: 0 }, ...stored.pack.batches];
  rehashed(stored);
  await refusedUnsent(stored, 'tempRef');
});

test('a temp ref under the prefix that the plan\'s key does not name, and a plan for another ref than the caller names, are refused unsent', async () => {
  const honest = planned();
  const moved = structuredClone(honest);
  moved.tempRef = `refs/ply/transfer/${'a'.repeat(40)}`;
  await refusedUnsent(rehashed(moved), 'tempRef');
  // the honest plan is for refs/heads/copy; this call names another ref
  assert.ok(checkTransferPlan(structuredClone(honest), { ref: COPY }).ok);
  await refusedUnsent(structuredClone(honest), 'ref', { ref: 'refs/heads/elsewhere' });
  // the store's plan swapped for a whole, self-consistent one that creates another ref (planTransfer made it: every
  // hash, key and temp ref is right); the caller still names refs/heads/copy
  for (const ref of ['refs/heads/main', 'refs/tags/v9.9.9']) await refusedUnsent(planned({ ref }), 'ref');
  // a plan made with another temp prefix is this plan only to a caller that names that prefix
  const custom = planned({ tempPrefix: 'refs/x/y/' });
  await refusedUnsent(custom, 'tempRef');
  assert.ok(checkTransferPlan(custom, { ref: COPY, tempPrefix: 'refs/x/y/' }).ok);
  const { bare, t } = destination();
  assert.equal(unwrap(await runTransfer(t, from, custom, commit, { ref: COPY, tempPrefix: 'refs/x/y/' })).tag, 'done');
  assert.equal(git(bare, ['rev-parse', COPY]).trim(), custom.head);
});

test('a call that does not name the ref is refused unsent: a stored plan never chooses the ref its pushes create', async () => {
  // owner decision: transferStatus, transferStep and runTransfer take the destination ref from the caller on every
  // call. The plan here is honest and would run, so the only reason to refuse is the missing name
  const honest = planned();
  const { bare, victim, t } = destination();
  const before = proxy.count();
  const answers = [
    checkTransferPlan(honest), checkTransferPlan(honest, {}), checkTransferPlan(honest, { ref: '' }), checkTransferPlan(honest, { ref: 5 }), checkTransferPlan(honest, null),
    await transferStatus(t, honest), await transferStatus(t, honest, {}),
    // the bare-bytes form of the last argument names no ref
    await transferStep(t, from, honest, 0, commit), await transferStep(t, from, honest, 0, { commit }),
    await runTransfer(t, from, honest, commit), await runTransfer(t, from, honest, commit, { maxSteps: 1 }),
  ];
  for (const [i, r] of answers.entries()) assert.deepEqual(answerOf(r), ['bad_request', 'ref'], `call ${i}`);
  assert.equal(proxy.count() - before, 0, 'no request was sent');
  assert.equal(refsOf(bare), `${VICTIM} ${victim}`, 'the destination is as git left it');
});

test('on a finished destination a plan that does not pass is still refused, not answered done; a commit that does not give the planned head is refused unsent', async () => {
  const honest = planned();
  const { bare, victim, t } = destination();
  assert.equal(unwrap(await runTransfer(t, from, honest, commit, { ref: COPY })).tag, 'done');
  const finished = refsOf(bare);
  assert.equal(finished, `${COPY} ${honest.head}\n${VICTIM} ${victim}`);
  const before = proxy.count();
  const badHash = { ...structuredClone(honest), hash: 'f'.repeat(40) };
  const otherRef = { ...structuredClone(honest), ref: 'refs/heads/other' };
  const { pack: _pack, ...noPack } = structuredClone(honest);
  const { steps: _steps, ...noSteps } = structuredClone(honest);
  for (const [label, plan] of [['hash', badHash], ['ref edited', otherRef], ['no pack', noPack], ['no steps', noSteps]]) {
    for (const r of [await transferStatus(t, plan, { ref: COPY }), await runTransfer(t, from, plan, commit, { ref: COPY })]) {
      assert.deepEqual(answerOf(r), ['bad_request', 'plan'], label);
    }
  }
  // the source commit with more message is another commit: git hash-object gives its id, which is not the planned head
  const other = new Uint8Array([...commit, ...new TextEncoder().encode('more\n')]);
  const otherHead = execFileSync('git', ['hash-object', '-t', 'commit', '--stdin'], { input: other, encoding: 'utf8' }).trim();
  assert.notEqual(otherHead, honest.head);
  assert.deepEqual(answerOf(await runTransfer(t, from, honest, other, { ref: COPY })), ['bad_request', 'commit']);
  assert.equal(proxy.count() - before, 0, 'no request was sent');
  assert.equal(refsOf(bare), finished);
});
