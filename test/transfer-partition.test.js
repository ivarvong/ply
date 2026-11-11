// A stored transfer plan is untrusted input (#238 review): what its steps push is checked against the pack index, so a
// writer of the plan store who edits the batches and recomputes both hashes (planHash and transferPlanHash are public
// and unkeyed) is still refused before any request. The source is large enough for a plan of several batches.
// The oracle is git http-backend behind a proxy that counts requests, and git's own view of the destination's refs.
// Expected values, by hand: the transfer copies the commit's trees and blobs, each once. Every edit below names a set
// of entries that is not that (one missing, one twice, one that is not in the pack, the commit itself), so none of
// them can be the plan planTransfer made, whatever its hashes say: bad_request, no request, no ref.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomFillSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer } from './server.js';
import { scanPackIndex } from '../src/packscanindex.js';
import { resolvePackRange } from '../src/packrangeresolve.js';
import { rangeFromBytes } from '../src/rangesource.js';
import { createTransport } from '../src/http.js';
import { planHash } from '../src/packplan.js';
import { planTransfer, checkTransferPlan, transferPlanHash, transferKey, tempFor, TRANSFER_REF_PREFIX } from '../src/transferplan.js';
import { transferStatus, transferStep, runTransfer } from '../src/transfer.js';
import { unwrap } from './unwrap.js';

const ident = ['-c', 'user.name=Ann Author', '-c', 'user.email=ann@x'];
// ply reserves 300 * 68 + 32 KiB of each request for generated objects, so about 46 kB is left for entries: one
// 30 kB incompressible blob a batch
const BUDGET = { maxRequestBytes: 100_000, maxObjects: 300, maxObjectBytes: 1 << 20, maxCompressedObjectBytes: 1 << 20, reserveBytes: 0, reserveObjects: 0 };
const COPY = 'refs/heads/copy';
const BLOBS = 5;
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

let root, cleanup, srv, proxy, from, commit, sourceTree, honest, commitIndex, n = 0;
before(async () => {
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  proxy = await countingProxy(srv.url);
  const work = join(root, 'source');
  mkdirSync(join(work, 'a'), { recursive: true });
  git(work, ['init', '-q', '-b', 'main']);
  for (let i = 0; i < BLOBS; i++) {
    const blob = new Uint8Array(30_000);
    randomFillSync(blob);
    writeFileSync(join(work, i % 2 === 0 ? 'a' : '.', `r${i}.bin`), blob);
  }
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
  // the pack's one commit: the entry the plan's selection leaves out (git rev-list --objects --no-walk names one)
  const found = from.resolved.find(head);
  assert.equal(found.tag, 'some');
  commitIndex = found.value;
});
after(async () => { await proxy?.close(); await srv?.close(); cleanup?.(); });

function destination() {
  const name = `d${n++}`;
  const bare = makeBareRepo(root, name);
  return { bare, t: unwrap(createTransport(`${proxy.url}/${name}.git`)) };
}
const refsOf = bare => git(bare, ['for-each-ref', '--format=%(refname) %(objectname)']).trim();
// Everything a writer of the plan store can recompute over an edited plan, in the order planTransfer derives it: the
// pack plan's hash, the key and the temp ref it names, each batch step's temp commit (where the batch's entries are in
// the pack at all), the transfer's hash.
function rehashed(plan) {
  const { hash: _packHash, ...packBody } = plan.pack;
  plan.pack.hash = planHash(packBody);
  const key = transferKey(plan);
  plan.tempRef = `${TRANSFER_REF_PREFIX}${key}`;
  let prev = { tag: 'none' };
  for (const [i, s] of plan.steps.entries()) {
    s.prev = prev;
    if (s.kind !== 'batch') continue;
    const made = tempFor(from.resolved, plan.pack.batches[i].entries, { key, step: i, steps: plan.steps.length, prev });
    if (made.ok) s.temp = made.value.commit.oid;
    prev = { tag: 'some', value: s.temp };
  }
  const { hash: _hash, ...body } = plan;
  plan.hash = transferPlanHash(body);
  return plan;
}
const edit = (label, change, rehash = true) => {
  const plan = structuredClone(honest);
  change(plan);
  return [label, rehash ? rehashed(plan) : plan];
};
const ENTRY_POINTS = {
  checkTransferPlan: (_t, plan) => checkTransferPlan(plan, { ref: COPY }),
  transferStatus: (t, plan) => transferStatus(t, plan, { ref: COPY }),
  transferStep: (t, plan) => transferStep(t, from, plan, 0, { commit, ref: COPY }),
  'transferStep (last)': (t, plan) => transferStep(t, from, plan, honest.steps.length - 1, { commit, ref: COPY }),
  runTransfer: (t, plan) => runTransfer(t, from, plan, commit, { maxSteps: 1, retries: 0, ref: COPY }),
};
// Every plan in `plans` ([label, plan]) is refused as bad_request by each named entry point; none throws; nothing is
// sent; the destination has no refs.
async function allRefusedUnsent(plans, names = Object.keys(ENTRY_POINTS)) {
  const { bare, t } = destination();
  const sentBefore = proxy.count();
  const wrong = [];
  for (const [label, plan] of plans) {
    for (const name of names) {
      let got;
      try {
        const r = await ENTRY_POINTS[name](t, plan);
        got = r.ok ? `ok ${JSON.stringify(r.value)}` : r.error.code;
      } catch (e) {
        got = `threw ${String(e)}`;
      }
      if (got !== 'bad_request') wrong.push(`${label}: ${name}: ${got}`);
    }
  }
  assert.deepEqual({ count: wrong.length, first: wrong.slice(0, 12) }, { count: 0, first: [] });
  assert.equal(proxy.count() - sentBefore, 0, 'no request was sent');
  assert.equal(refsOf(bare), '', 'the destination has no refs');
}
const final = p => p.pack.batches.at(-1);

test('the source gives a plan of at least three batches, and it runs: one push a batch, git shows the ref at the source tree', async () => {
  // BLOBS incompressible 30 kB blobs under a budget that fits one a batch, then the trees
  assert.ok(honest.pack.batches.length >= 3, `batches: ${honest.pack.batches.length}`);
  assert.equal(honest.pack.batches.filter(b => b.kind === 'blobs').length, honest.pack.batches.length - 1);
  const stored = JSON.parse(JSON.stringify(honest));
  assert.ok(checkTransferPlan(stored, { ref: COPY }).ok);
  const { bare, t } = destination();
  const run = unwrap(await runTransfer(t, from, stored, commit, { ref: COPY }));
  assert.deepEqual({ tag: run.tag, pushes: run.pushes }, { tag: 'done', pushes: honest.steps.length });
  assert.equal(git(bare, ['rev-parse', `${COPY}^{tree}`]).trim(), sourceTree);
  assert.equal(refsOf(bare).split('\n').length, 1, 'no temp ref left');
  git(bare, ['fsck', '--strict']);
});

test('batches that do not partition the selection, both hashes recomputed, are refused by every entry point before any request', async () => {
  await allRefusedUnsent([
    edit('the final batch cut to one entry', p => { final(p).entries = final(p).entries.slice(0, 1); final(p).objects = 1; }),
    edit('the final batch emptied', p => { final(p).entries = []; final(p).objects = 0; }),
    edit('a blob batch emptied', p => { p.pack.batches[0].entries = []; p.pack.batches[0].objects = 0; }),
    edit('an entry in two batches', p => { final(p).entries.push(p.pack.batches[0].entries[0]); final(p).objects += 1; }),
    edit('an entry twice in one batch', p => { final(p).entries.push(final(p).entries[0]); final(p).objects += 1; }),
    edit('an entry past the pack', p => { final(p).entries.push(p.pack.entries + 7); final(p).objects += 1; }),
    edit('the pack\'s commit in a batch', p => { final(p).entries.push(commitIndex); final(p).objects += 1; }),
    edit('a batch\'s object count not its entries', p => { p.pack.batches[1].objects += 1; }),
    edit('an entry count that is not the selection\'s', p => { p.pack.entries += 1; }),
    edit('the selection out of pack order', p => { p.pack.select.reverse(); }),
    edit('no selection', p => { p.pack.select = null; }),
    edit('a step fewer than batches', p => { p.steps.splice(0, 1); p.steps[0].prev = { tag: 'none' }; }),
    edit('one final batch without entries', p => { p.pack.batches = [{ kind: 'final' }]; p.steps = [{ kind: 'final', prev: { tag: 'none' } }]; }, false),
  ]);
});

test('a selection that is not the pack\'s trees and blobs, both hashes recomputed, is refused by a step and a run before any request', async () => {
  // checkTransferPlan and transferStatus hold no pack; the entry points that push do, and check against its index
  await allRefusedUnsent([
    edit('the pack\'s commit selected and pushed', p => { p.pack.select = [...p.pack.select, commitIndex].sort((a, b) => a - b); p.pack.entries += 1; final(p).entries.push(commitIndex); final(p).objects += 1; }),
    edit('a selected entry dropped everywhere, the counts kept consistent', p => { const gone = final(p).entries.pop(); final(p).objects -= 1; p.pack.select = p.pack.select.filter(i => i !== gone); p.pack.entries -= 1; }),
  ], ['transferStep', 'transferStep (last)', 'runTransfer']);
});

// Every path into a JSON value: its keys and indices from the top.
function* pathsOf(v, here = []) {
  if (typeof v !== 'object' || v === null) return;
  for (const k of Object.keys(v)) {
    yield [...here, k];
    yield* pathsOf(v[k], [...here, k]);
  }
}
const DELETE = Symbol('delete');
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

test('a generated corpus over every field of a multi-batch plan (missing, wrong type, negative, fractional) is refused unsent by every entry point; with everything recomputed the check still never throws', async () => {
  const same = JSON.stringify(honest);
  const corpus = [];
  const forged = [];
  for (const path of pathsOf(honest)) {
    for (const value of WRONG) {
      const plan = mutated(honest, path, value);
      if (JSON.stringify(plan) === same) continue;
      const label = `${path.join('.')} = ${value === DELETE ? 'deleted' : JSON.stringify(value)}`;
      corpus.push([label, plan]);
      // the same edit by a writer who recomputes everything derived, where that can be computed at all (an edit the
      // recomputing undoes gives the honest plan back, and one that stays self-consistent is a plan: only the check's
      // totality is asserted for these)
      try { forged.push([label, rehashed(structuredClone(plan))]); } catch { /* not hashable: the stored form above stands */ }
    }
  }
  for (const [label, plan] of forged) {
    let got;
    try {
      const r = checkTransferPlan(plan, { ref: COPY });
      got = r.ok ? 'ok' : r.error.code;
    } catch (e) {
      got = `threw ${String(e)}`;
    }
    assert.ok(got === 'ok' || got === 'bad_request', `${label} (rehashed): checkTransferPlan: ${got}`);
  }
  assert.ok(corpus.length > 1000, `the corpus covers the plan (${corpus.length} plans)`);
  await allRefusedUnsent(corpus);
});

// A hole in an array of the plan (an index below its length that is not an element). JSON cannot hold one, but a
// structured-clone store (Durable Object storage, IndexedDB) hands one back: structuredClone below is that round trip,
// and the hole is asserted to survive it. Expected value, by the rule and not from the code: a plan with a hole is not
// one planTransfer made (it writes every element), so it is a corrupt plan: bad_request, what 'plan', from every
// entry point, no throw, no request, with the hashes as stored and with everything a writer can recompute recomputed.
const HOLED = {
  steps: p => p.steps,
  'pack.batches': p => p.pack.batches,
  'pack.select': p => p.pack.select,
  'a blobs batch\'s entries': p => p.pack.batches[0].entries,
  'the final batch\'s entries': p => final(p).entries,
};
// The hashes and the temp ref over a plan with a hole, as a writer of the store recomputes them (the public, unkeyed
// functions; a hole is hashed as JSON writes it, null).
function resealed(plan) {
  const { hash: _packHash, ...packBody } = plan.pack;
  plan.pack.hash = planHash(packBody);
  plan.tempRef = `${TRANSFER_REF_PREFIX}${transferKey(plan)}`;
  const { hash: _hash, ...body } = plan;
  plan.hash = transferPlanHash(body);
  return plan;
}
test('a plan with a hole in steps, pack.batches, pack.select or a batch\'s entries is refused as a corrupt plan by every entry point: no throw, no request', async () => {
  const { bare, t } = destination();
  const sentBefore = proxy.count();
  const wrong = [];
  let cases = 0;
  for (const [name, arrayOf] of Object.entries(HOLED)) {
    const length = arrayOf(honest).length;
    // the first element, the last, and one past the end (a trailing hole: the length is one more than the elements)
    for (const place of new Set([0, length - 1, length])) {
      for (const reseal of [false, true]) {
        const plan = structuredClone(honest);
        const list = arrayOf(plan);
        if (place === length) list.length = length + 1;
        else delete list[place];
        const stored = structuredClone(reseal ? resealed(plan) : plan);
        assert.equal(Object.hasOwn(arrayOf(stored), place), false, `${name}: the hole at ${place} survives a structured clone`);
        assert.equal(arrayOf(stored).length, Math.max(length, place + 1));
        cases++;
        for (const [entry, call] of Object.entries(ENTRY_POINTS)) {
          let got;
          try {
            const r = await call(t, stored);
            got = r.ok ? `ok ${JSON.stringify(r.value)}` : `${r.error.code} ${r.error.what}`;
          } catch (e) {
            got = `threw ${String(e)}`;
          }
          if (got !== 'bad_request plan') wrong.push(`${name}[${place}]${reseal ? ' resealed' : ''}: ${entry}: ${got}`);
        }
      }
    }
  }
  // 5 arrays, 3 places each (2 where an array has one element), hashes as stored and recomputed
  assert.ok(cases >= 20, `cases: ${cases}`);
  assert.deepEqual({ count: wrong.length, first: wrong.slice(0, 12) }, { count: 0, first: [] });
  assert.equal(proxy.count() - sentBefore, 0, 'no request was sent');
  assert.equal(refsOf(bare), '', 'the destination has no refs');
});
