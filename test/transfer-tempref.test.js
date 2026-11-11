// A stored transfer plan is untrusted input (#238 review): its temp ref is not a free field. The oracle is git
// http-backend behind a proxy that counts requests, and git's own view of the destination's refs afterwards:
//   - a plan whose tempRef is pointed at an existing branch (refs/heads/victim), with a fake batch step at that
//     branch's commit and both hashes recomputed (they are unkeyed: anyone can), is refused as bad_request by
//     checkTransferPlan, transferStatus, transferStep and runTransfer before any request is sent, and the branch is
//     still where git put it
//   - a temp ref under the transfer prefix that is not the one the plan's key names is refused the same way
//   - a plan for another ref than the one the caller names on the call is refused the same way
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
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
// Every entry point refuses `plan` with bad_request, sends nothing, and leaves the destination's refs as git shows them.
async function refusedUnsent(plan, opts = {}) {
  const { bare, victim, t } = destination();
  const before = proxy.count();
  const answers = [
    await transferStatus(t, plan, opts),
    await transferStep(t, from, plan, 0, { ...opts, commit }),
    await transferStep(t, from, plan, 1, { ...opts, commit }),
    // the bare-bytes form of the last argument holds the plan to the defaults: only asked when the call names nothing
    ...(Object.keys(opts).length === 0 ? [await transferStep(t, from, plan, 0, commit)] : []),
    await runTransfer(t, from, plan, commit, opts),
  ];
  for (const [i, r] of answers.entries()) assert.equal(r.ok ? JSON.stringify(r.value) : r.error.code, 'bad_request', `entry point ${i}`);
  assert.equal(proxy.count() - before, 0, 'no request was sent');
  assert.equal(refsOf(bare), `${VICTIM} ${victim}`, 'the destination is as git left it');
}

test('a stored plan whose temp ref is an existing branch, hashes recomputed, is refused before any request and the branch stays', async () => {
  const honest = unwrap(planTransfer(from.pack, from.resolved, { budget: BUDGET, ref: COPY, commit }));
  const { victim } = destination();
  const stored = structuredClone(honest);
  stored.tempRef = VICTIM;
  stored.steps = [{ kind: 'batch', temp: victim, prev: { tag: 'none' } }, { kind: 'final', prev: { tag: 'some', value: victim } }];
  stored.pack.batches = [{ kind: 'blobs', entries: [], packBytes: 32, objects: 0, refRewrites: 0 }, ...stored.pack.batches];
  rehashed(stored);
  assert.equal(checkTransferPlan(stored).ok, false, 'checkTransferPlan refuses it');
  await refusedUnsent(stored);
});

test('a temp ref under the prefix that the plan\'s key does not name, and a plan for another ref than the caller names, are refused unsent', async () => {
  const honest = unwrap(planTransfer(from.pack, from.resolved, { budget: BUDGET, ref: COPY, commit }));
  const moved = structuredClone(honest);
  moved.tempRef = `refs/ply/transfer/${'a'.repeat(40)}`;
  await refusedUnsent(rehashed(moved));
  // the honest plan is for refs/heads/copy; this call names another ref
  assert.ok(checkTransferPlan(structuredClone(honest), { ref: COPY }).ok);
  assert.equal(checkTransferPlan(structuredClone(honest), { ref: VICTIM }).ok, false);
  await refusedUnsent(structuredClone(honest), { ref: 'refs/heads/elsewhere' });
  // a plan made with another temp prefix is this plan only to a caller that names that prefix
  const custom = unwrap(planTransfer(from.pack, from.resolved, { budget: BUDGET, ref: COPY, commit, tempPrefix: 'refs/x/y/' }));
  assert.equal(checkTransferPlan(custom).ok, false);
  assert.ok(checkTransferPlan(custom, { tempPrefix: 'refs/x/y/' }).ok);
});
