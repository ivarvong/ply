// A stored transfer plan is untrusted input (#238 review): the check is total and covers every field a step reads.
// The oracle is git http-backend behind a proxy that counts requests, and git's own view of the destination's refs:
//   - a generated corpus (every field of an honest plan, at every depth, deleted or replaced by a value of another
//     type) is refused as bad_request by checkTransferPlan, transferStatus, transferStep and runTransfer; none throws
//     and none sends a request. Expected value, by hand: each of these plans differs from the honest one in a field
//     the plan's hashes cover, so none of them is the plan that was made
//   - the same for right-typed edits with both hashes left as they were (a batch entry dropped, crossBatchRef flipped,
//     the budget, the trailer, the selection, a batch's byte count)
//   - the honest plan still runs: git shows the new ref at the source commit's tree
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, initRepo } from './server.js';
import { scanPackIndex } from '../src/packscanindex.js';
import { resolvePackRange } from '../src/packrangeresolve.js';
import { rangeFromBytes } from '../src/rangesource.js';
import { createTransport } from '../src/http.js';
import { planTransfer, checkTransferPlan } from '../src/transferplan.js';
import { transferStatus, transferStep, runTransfer } from '../src/transfer.js';
import { unwrap } from './unwrap.js';

const ident = ['-c', 'user.name=Ann Author', '-c', 'user.email=ann@x'];
const BUDGET = { maxRequestBytes: 200_000, maxObjects: 300, maxObjectBytes: 1 << 20, maxCompressedObjectBytes: 1 << 20, reserveBytes: 0, reserveObjects: 0 };
const COPY = 'refs/heads/copy';
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

let root, cleanup, srv, proxy, from, commit, sourceTree, honest, n = 0;
before(async () => {
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  proxy = await countingProxy(srv.url);
  const work = join(root, 'source');
  mkdirSync(join(work, 'a'), { recursive: true });
  initRepo(work);
  writeFileSync(join(work, 'a', 'one.txt'), 'one\n');
  writeFileSync(join(work, 'two.txt'), 'two\n');
  git(work, ['add', '.']);
  git(work, [...ident, 'commit', '-q', '-m', 'source']);
  const head = git(work, ['rev-parse', 'HEAD']).trim();
  sourceTree = git(work, ['rev-parse', 'HEAD^{tree}']).trim();
  const pack = new Uint8Array(gitBuf(work, ['pack-objects', '--stdout', '-q'], git(work, ['rev-list', '--objects', '--no-walk', head])));
  commit = new Uint8Array(gitBuf(work, ['cat-file', 'commit', head]));
  const scanned = unwrap(await scanPackIndex(streamOf(pack)));
  const source = rangeFromBytes(pack);
  from = { source, pack: scanned, resolved: unwrap(await resolvePackRange(scanned, source)) };
  honest = unwrap(planTransfer(from.pack, from.resolved, { budget: BUDGET, ref: COPY, commit }));
});
after(async () => { await proxy?.close(); await srv?.close(); cleanup?.(); });

function destination() {
  const name = `d${n++}`;
  const bare = makeBareRepo(root, name);
  return { bare, t: unwrap(createTransport(`${proxy.url}/${name}.git`)) };
}
const refsOf = bare => git(bare, ['for-each-ref', '--format=%(refname) %(objectname)']).trim();

// What each entry point answers for `plan`: the error code, or what it did instead (an ok value, a throw).
async function answers(t, plan) {
  const calls = [
    ['checkTransferPlan', () => checkTransferPlan(plan, { ref: COPY })],
    ['transferStatus', () => transferStatus(t, plan, { ref: COPY })],
    ['transferStep', () => transferStep(t, from, plan, 0, { commit: commit, ref: COPY })],
    ['runTransfer', () => runTransfer(t, from, plan, commit, { maxSteps: 1, retries: 0, ref: COPY })],
  ];
  const out = [];
  for (const [name, call] of calls) {
    try {
      const r = await call();
      out.push([name, r.ok ? `ok ${JSON.stringify(r.value)}` : r.error.code]);
    } catch (e) {
      out.push([name, `threw ${String(e)}`]);
    }
  }
  return out;
}
// Every plan in `plans` ([label, plan]) is refused by every entry point; nothing is sent; the destination has no refs.
async function allRefusedUnsent(plans) {
  const { bare, t } = destination();
  const before = proxy.count();
  const wrong = [];
  for (const [label, plan] of plans) {
    for (const [name, got] of await answers(t, plan)) if (got !== 'bad_request') wrong.push(`${label}: ${name}: ${got}`);
  }
  assert.deepEqual({ count: wrong.length, first: wrong.slice(0, 8) }, { count: 0, first: [] });
  assert.equal(proxy.count() - before, 0, 'no request was sent');
  assert.equal(refsOf(bare), '', 'the destination has no refs');
}

// Every path into a JSON value: its keys and indices from the top.
function* pathsOf(v, here = []) {
  if (typeof v !== 'object' || v === null) return;
  for (const k of Object.keys(v)) {
    yield [...here, k];
    yield* pathsOf(v[k], [...here, k]);
  }
}
const DELETE = Symbol('delete');
// Values of every JSON type, with the near misses of the plan's own shapes (a negative or fractional count, an Option
// without a value, a list holding null).
const WRONG = [DELETE, null, 0, -1, 1.5, 'x', true, [], {}, [null], { tag: 'some' }, { tag: 'some', value: 7 }];
function mutated(plan, path, value) {
  const copy = structuredClone(plan);
  let o = copy;
  for (const k of path.slice(0, -1)) o = o[k];
  const last = path.at(-1);
  if (value !== DELETE) o[last] = value;
  else if (Array.isArray(o)) o.splice(Number(last), 1);
  else delete o[last];
  return copy;
}

test('a generated corpus of missing and wrong-type fields is refused with bad_request by every entry point: no throw, no request', async () => {
  const same = JSON.stringify(honest);
  const corpus = [];
  for (const path of pathsOf(honest)) {
    for (const value of WRONG) {
      const plan = mutated(honest, path, value);
      // a value that is the honest one (0 for a zero reserve) is not a mutation
      if (JSON.stringify(plan) !== same) corpus.push([`${path.join('.')} = ${value === DELETE ? 'deleted' : JSON.stringify(value)}`, plan]);
    }
  }
  for (const value of [null, 0, 'x', true, [], {}]) corpus.push([`plan = ${JSON.stringify(value)}`, value]);
  assert.ok(corpus.length > 300, `the corpus covers the plan (${corpus.length} plans)`);
  await allRefusedUnsent(corpus);
});

test('a right-typed edit of any field a step reads, both hashes left as stored, is refused unsent', async () => {
  const edit = (label, change) => {
    const plan = structuredClone(honest);
    change(plan);
    return [label, plan];
  };
  const final = p => p.pack.batches.at(-1);
  await allRefusedUnsent([
    edit('a final-batch entry dropped', p => { final(p).entries.pop(); }),
    edit('the final batch emptied', p => { final(p).entries = []; }),
    edit('crossBatchRef flipped', p => { p.pack.crossBatchRef = !p.pack.crossBatchRef; }),
    edit('budget raised', p => { p.pack.budget.maxRequestBytes += 1; }),
    edit('trailer replaced', p => { p.pack.trailer = 'f'.repeat(40); }),
    edit('selection shortened', p => { p.pack.select.pop(); }),
    edit('a batch byte count changed', p => { final(p).packBytes += 1; }),
    edit('atomic turned off', p => { p.atomic = false; }),
  ]);
});

test('the honest plan, read back from JSON, passes the check and runs: git shows the ref at the source tree', async () => {
  const stored = JSON.parse(JSON.stringify(honest));
  assert.ok(checkTransferPlan(stored, { ref: COPY }).ok);
  const { bare, t } = destination();
  const run = unwrap(await runTransfer(t, from, stored, commit, { ref: COPY }));
  assert.equal(run.tag, 'done');
  assert.equal(git(bare, ['rev-parse', `${COPY}^{tree}`]).trim(), sourceTree);
  git(bare, ['fsck', '--strict']);
});
