// Resumable transfer (#238): one commit's tree, from a spooled pack, to a fresh repository as a new root commit, in
// pushes under a cap. The oracle is git http-backend with receive.fsckObjects and transfer.fsckObjects on:
//   - end to end (REF-only and OFS packs, several batches): the ref is the planned head, no temp ref is left,
//     fsck --strict is clean, exactly the tree's objects and the one new commit are reachable, ls-tree -r is the
//     source's, the commit has no parents and keeps the source's author, committer and message
//   - an OFS pack whose delta chain a small budget cuts below a delta base (crossBatchRef): done in one run and after
//     a pause and resume, no temp ref, the same checks
//   - resume: paused after every single push and resumed, the same head; a push that dies mid-stream (the spool
//     fails) leaves the refs where they were and the next run finishes; a step already landed, sent again, is refused
//     and moves nothing
//   - refusals before any push: a budget an object cannot fit, a tree not in the pack, a commit that does not parse;
//     at a step: an edited plan, another pack, other resolved ids, other commit bytes, a step not in the plan; at
//     status: the ref already at another commit, a temp ref the plan never writes; a step that never lands
//   - the commit policy (signatures dropped, other headers kept) and the deterministic ids
//   - sweepTransfers removes what an abandoned transfer left, keeping what it is told to
//   - the plan's types: batch steps carry their temp commit, the final step none; prev is an Option; refs are refused
//     unless git would push them; a plan read back with a malformed step, id or ref is refused
//   - ls-refs that lags a push (a host that acknowledges before its reads show it): settled by reading the refs again,
//     never by sending the step again; a lag longer than the reads pauses the run ('settling'); a step sent again after a
//     lagging read is refused by the server, and the refs, settled, show it landed, so the run goes on
//   - a done run reports a temp ref left behind (tempLeft); the spans each function writes, with the plan hash
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomFillSync } from 'node:crypto';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, fsckProblems } from './server.js';
import { scanPackIndex } from '../src/packscanindex.js';
import { resolvePackRange } from '../src/packrangeresolve.js';
import { rangeFromBytes } from '../src/rangesource.js';
import { createTransport } from '../src/http.js';
import { planTransfer, checkTransferPlan, rootCommit, batchTrees, TRANSFER_REF_PREFIX } from '../src/transferplan.js';
import { transferStatus, transferStep, runTransfer, copyTree, sweepTransfers } from '../src/transfer.js';
import { te } from '../src/bytes.js';
import { TYPE } from '../src/objects.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { unwrap } from './unwrap.js';

const must = r => { if (r.ok) return r.value; throw Object.assign(new Error(r.error.message), { code: r.error.code }); };
const streamOf = bytes => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
const ident = ['-c', 'user.name=Ann Author', '-c', 'user.email=ann@x'];
const REF = 'refs/heads/main';
// 300 objects a push (258 of them ply's generated objects), 200 KB a request: several batches of ~40 KB blobs
const BUDGET = { maxRequestBytes: 200_000, maxObjects: 300, maxObjectBytes: 1 << 20, maxCompressedObjectBytes: 1 << 20, reserveBytes: 0, reserveObjects: 0 };

let root, cleanup, srv, n = 0, work, src;
before(async () => {
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  work = join(root, 'source');
  mkdirSync(join(work, 'a', 'b'), { recursive: true });
  git(work, ['init', '-q', '-b', 'main']);
  for (let i = 0; i < 10; i++) {
    const blob = new Uint8Array(40_000 + i * 500);
    randomFillSync(blob);
    writeFileSync(join(work, i % 3 === 0 ? 'a' : i % 3 === 1 ? join('a', 'b') : '.', `r${i}.bin`), blob);
  }
  // near-copies, so the pack holds delta chains (REF on REF in the REF-only pack)
  const base = new Uint8Array(30_000);
  randomFillSync(base);
  for (let v = 0; v < 5; v++) { base[v * 991] ^= 0xff; writeFileSync(join(work, 'a', `chain${v}.bin`), base); }
  writeFileSync(join(work, 'small.txt'), 'hello\n');
  git(work, ['add', '.']);
  git(work, [...ident, 'commit', '-q', '-m', 'one']);
  writeFileSync(join(work, 'small.txt'), 'hello again\n');
  git(work, ['add', '.']);
  git(work, [...ident, 'commit', '-q', '-m', 'two\n\nbody line\n']);
  const head = git(work, ['rev-parse', 'HEAD']).trim();
  // a depth-1 pack: the commit and its tree's objects, nothing of the parent
  const objs = git(work, ['rev-list', '--objects', '--no-walk', head]);
  src = {
    head,
    commit: new Uint8Array(gitBuf(work, ['cat-file', 'commit', head])),
    lsTree: git(work, ['ls-tree', '-r', head]),
    tree: git(work, ['rev-parse', `${head}^{tree}`]).trim(),
    packs: {
      ref: new Uint8Array(gitBuf(work, ['pack-objects', '--stdout', '-q', '--depth=50'], objs)),
      ofs: new Uint8Array(gitBuf(work, ['pack-objects', '--stdout', '-q', '--depth=50', '--delta-base-offset'], objs)),
    },
  };
});
after(async () => { await srv?.close(); cleanup?.(); });

async function spooled(pack) {
  const p = must(await scanPackIndex(streamOf(pack)));
  const source = rangeFromBytes(pack);
  return { source, pack: p, resolved: must(await resolvePackRange(p, source)) };
}
function repo(options = {}) {
  const name = `t${n++}`;
  const bare = makeBareRepo(root, name);
  return { bare, t: unwrap(createTransport(`${srv.url}/${name}.git`, options)) };
}
// A destination whose ls-refs lags its pushes: after each receive-pack, the next `lag()` ls-refs answer what the read
// before the push saw (the refs as they were). Everything else is the real transport.
function lagging(t, lag) {
  let stale = 0, last = null, reads = 0;
  const view = Object.create(t);
  view.frames = function frames(service, body, span, hints) {
    const real = t.frames.call(this, service, body, span, hints);
    if (service !== 'git-upload-pack') { stale = lag(); return real; }
    reads++;
    if (stale > 0 && last !== null) { stale--; const kept = last; return (async function* replay() { yield* kept; })(); }
    return (async function* record() { const got = []; for await (const f of real) { got.push(f); yield f; } last = got; })();
  };
  return { t: view, reads: () => reads };
}
const refsOf = bare => git(bare, ['for-each-ref', '--format=%(refname) %(objectname)']).trim();
const objectsOf = (dir, rev) => git(dir, ['rev-list', '--objects', rev]).split('\n').filter(Boolean).map(l => l.slice(0, 40)).sort();

function assertCopied(bare, plan) {
  assert.equal(git(bare, ['rev-parse', REF]).trim(), plan.head);
  assert.equal(git(bare, ['for-each-ref', 'refs/ply']).trim(), '', 'no temp ref left');
  assert.deepEqual(fsckProblems(bare, { args: ['--strict'] }), []);
  assert.equal(git(bare, ['ls-tree', '-r', REF]), src.lsTree);
  assert.equal(git(bare, ['rev-list', '--parents', '-n1', REF]).trim(), plan.head, 'a root commit');
  const want = [...git(work, ['rev-list', '--objects', '--no-walk', src.tree]).split('\n').filter(Boolean).map(l => l.slice(0, 40)), plan.head].sort();
  assert.deepEqual(objectsOf(bare, REF), want, 'exactly the tree and the new commit');
  for (const f of ['%an <%ae> %at %ai', '%cn <%ce> %ct', '%B']) assert.equal(git(bare, ['log', '-1', `--format=${f}`, REF]), git(work, ['log', '-1', `--format=${f}`, src.head]));
}

test('end to end, REF-only and OFS packs: several pushes under the cap, fsck --strict, exactly the tree, a root commit', async () => {
  for (const kind of ['ref', 'ofs']) {
    const from = await spooled(src.packs[kind]);
    const { bare, t } = repo();
    const { plan, run } = must(await copyTree(t, from, { budget: BUDGET, ref: REF, commit: src.commit }));
    assert.ok(plan.steps.length >= 4, `${kind}: ${plan.steps.length} steps`);
    assert.equal(run.tag, 'done');
    assert.equal(run.pushes, plan.steps.length);
    assert.equal(plan.tempRef.startsWith(TRANSFER_REF_PREFIX), true);
    for (const b of plan.pack.batches) assert.ok(b.packBytes <= BUDGET.maxRequestBytes);
    assertCopied(bare, plan);
    // deterministic: planned again, the same plan and hash
    assert.deepEqual(must(planTransfer(from.pack, from.resolved, { budget: BUDGET, ref: REF, commit: src.commit })), plan);
    // a plan survives JSON (a store between Worker requests)
    assert.ok(checkTransferPlan(JSON.parse(JSON.stringify(plan))).ok);
    assert.deepEqual(must(await transferStatus(t, plan)), { tag: 'done', head: plan.head, tempLeft: false });
  }
});

test('an OFS pack cut below a delta base (crossBatchRef): the transfer finishes and resumes; git holds exactly the tree', async () => {
  const from = await spooled(src.packs.ofs);
  const c = from.pack.columns;
  // 258 generated objects and 3 of the pack's entries a push (the three trees need that): the chain0..4 family (a blob
  // and deltas on deltas) cannot fit one push, so it is refused without crossBatchRef and cut in chain order with it
  const budget = { ...BUDGET, maxObjects: 261 };
  assert.equal(planTransfer(from.pack, from.resolved, { budget, ref: REF, commit: src.commit }).error.code, 'limit_exceeded');
  const plan = must(planTransfer(from.pack, from.resolved, { budget, ref: REF, commit: src.commit, crossBatchRef: true }));
  // the fixture, read from git's pack and the plan's batches: an OFS_DELTA whose base is itself an OFS_DELTA, pushed in
  // an earlier batch. Its base id is not in the scan index (a delta's id is known only once it is applied).
  const batchOf = new Map(plan.pack.batches.flatMap((b, k) => b.entries.map(i => [i, k])));
  const cut = [...batchOf.keys()].filter(i => c.storedType[i] === TYPE.OFS_DELTA && c.storedType[c.baseIndex[i]] === TYPE.OFS_DELTA && batchOf.get(c.baseIndex[i]) < batchOf.get(i));
  assert.ok(cut.length >= 1, `OFS deltas cut from a delta base: ${cut.length}`);
  const lastCut = Math.max(...cut.map(i => batchOf.get(i)));
  // one run to the end
  const whole = repo();
  const run = must(await runTransfer(whole.t, from, plan, src.commit));
  assert.deepEqual(run, { tag: 'done', head: plan.head, pushes: plan.steps.length, tempLeft: false });
  assertCopied(whole.bare, plan);
  // paused before the last cut batch, then resumed: the temp ref is there in between, gone at the end
  const { bare, t } = repo();
  const paused = must(await runTransfer(t, from, plan, src.commit, { maxSteps: lastCut }));
  assert.equal(paused.tag, 'paused');
  assert.equal(paused.pushes, lastCut);
  assert.match(refsOf(bare), new RegExp(`^${plan.tempRef} [0-9a-f]{40}$`, 'u'));
  const resumed = must(await runTransfer(t, from, plan, src.commit));
  assert.equal(resumed.tag, 'done');
  assert.equal(resumed.pushes, plan.steps.length - lastCut);
  assert.equal(resumed.tempLeft, false);
  assertCopied(bare, plan);
});

test('a `resolved` whose oid() answers an id, then something else: one id asked per rewritten entry; too few is a coded refusal, never a rejection', async () => {
  const from = await spooled(src.packs.ofs);
  const c = from.pack.columns;
  const budget = { ...BUDGET, maxObjects: 261 };
  const plan = must(planTransfer(from.pack, from.resolved, { budget, ref: REF, commit: src.commit, crossBatchRef: true }));
  // from git's pack columns and the plan: an OFS_DELTA whose base is not in its own batch is rewritten as a REF_DELTA,
  // and each rewrite needs one id. Counted per batch.
  const batchOf = new Map(plan.pack.batches.flatMap((b, k) => b.entries.map(i => [i, k])));
  const rewrites = plan.pack.batches.map((b, k) => b.entries.filter(i => c.storedType[i] === TYPE.OFS_DELTA && batchOf.get(c.baseIndex[i]) !== k).length);
  const total = rewrites.reduce((a, b) => a + b, 0);
  assert.ok(total >= 1, `rewrites: ${total}`);
  const lastCut = rewrites.findLastIndex(r => r > 0);
  const isRewrite = (i, k) => c.storedType[i] === TYPE.OFS_DELTA && batchOf.get(c.baseIndex[i]) !== k;
  // How often each entry's id is needed to push `steps`, by hand: once for its line in its batch's temp tree
  // (transferplan's entryAt, as on main), and once for each REF_DELTA header that names it as a base.
  const needed = steps => {
    const m = new Map();
    const add = i => m.set(i, (m.get(i) ?? 0) + 1);
    for (const k of steps) for (const i of plan.pack.batches[k].entries) { add(i); if (isRewrite(i, k)) add(c.baseIndex[i]); }
    return m;
  };
  // an index that answers honestly as often as `allow` says (one time fewer for `shortOn`), then with what is not an id
  const flipping = (allow, shortOn = -1) => {
    const state = { lies: 0 };
    const asked = new Map();
    const oid = i => {
      const nth = (asked.get(i) ?? 0) + 1;
      asked.set(i, nth);
      if (nth <= (allow.get(i) ?? 0) - (i === shortOn ? 1 : 0)) return from.resolved.oid(i);
      state.lies++;
      return { tag: 'some', value: 'z'.repeat(40) };
    };
    return { state, from: { ...from, resolved: { ...from.resolved, oid } } };
  };
  const everyStep = plan.pack.batches.map((_, k) => k);
  // a base a rewritten entry of the last cut batch rests on
  const lastBase = c.baseIndex[plan.pack.batches[lastCut].entries.find(i => isRewrite(i, lastCut))];
  // runTransfer with exactly the answers needed: done without one lie told, and git holds exactly the tree
  const whole = repo();
  const enough = flipping(needed(everyStep));
  const run = await runTransfer(whole.t, enough.from, plan, src.commit);
  assert.equal(run.ok, true, run.ok ? '' : `${run.error.code}: ${run.error.message}`);
  assert.deepEqual(run.value, { tag: 'done', head: plan.head, pushes: plan.steps.length, tempLeft: false });
  assert.equal(enough.state.lies, 0, 'an id was asked for more often than once per use');
  assertCopied(whole.bare, plan);
  // one honest answer too few for that base: the run ends with the builder's refusal (a Result); the ref is not created
  const short = repo();
  const few = await runTransfer(short.t, flipping(needed(everyStep), lastBase).from, plan, src.commit);
  assert.equal(few.ok, false);
  assert.equal(few.error.code, 'bad_request');
  assert.equal(few.error.what, 'pack subset base');
  assert.equal(git(short.bare, ['for-each-ref', REF]).trim(), '');
  // transferStep on the last cut batch: too few answers is the same refusal and nothing moves; enough, and it lands
  const { bare, t } = repo();
  must(await runTransfer(t, from, plan, src.commit, { maxSteps: lastCut }));
  const step = must(await transferStatus(t, plan)).step;
  assert.equal(step, lastCut);
  const before = refsOf(bare);
  const refused = await transferStep(t, flipping(needed([lastCut]), lastBase).from, plan, step, src.commit);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'bad_request');
  assert.equal(refused.error.what, 'pack subset base');
  assert.equal(refsOf(bare), before);
  const landed = await transferStep(t, flipping(needed([lastCut])).from, plan, step, src.commit);
  assert.equal(landed.ok, true, landed.ok ? '' : `${landed.error.code}: ${landed.error.message}`);
  assert.equal(must(await runTransfer(t, from, plan, src.commit)).tag, 'done');
  assertCopied(bare, plan);
});

test('everything in one push: no temp ref; atomic off: one plain push', async () => {
  const from = await spooled(src.packs.ref);
  const big = { ...BUDGET, maxRequestBytes: 10_000_000 };
  for (const atomic of [true, false]) {
    const { bare, t } = repo();
    const { plan, run } = must(await copyTree(t, from, { budget: big, ref: REF, commit: src.commit, atomic }));
    assert.equal(plan.steps.length, 1);
    assert.equal(run.pushes, 1);
    assertCopied(bare, plan);
  }
  const { bare, t } = repo();
  const { plan } = must(await copyTree(t, from, { budget: BUDGET, ref: REF, commit: src.commit, atomic: false }));
  assertCopied(bare, plan);
});

test('resume: paused after every push and resumed, the same head; a step already landed, sent again, moves nothing', async () => {
  const from = await spooled(src.packs.ref);
  const plan = must(planTransfer(from.pack, from.resolved, { budget: BUDGET, ref: REF, commit: src.commit }));
  const { bare, t } = repo();
  let runs = 0;
  for (;;) {
    const r = must(await runTransfer(t, from, plan, src.commit, { maxSteps: 1 }));
    runs++;
    if (r.tag === 'done') break;
    assert.equal(r.pushes, 1);
    const at = r.step;
    // the step the destination is on, sent again: refused (stale ref), the refs unchanged
    if (at > 0) {
      const before = refsOf(bare);
      const again = await transferStep(t, from, plan, at - 1, src.commit);
      assert.equal(again.ok, false);
      assert.equal(refsOf(bare), before);
    }
  }
  // one push a run; the run that pushes the last step reads the refs back and is done
  assert.equal(runs, plan.steps.length);
  assertCopied(bare, plan);
});

test('a push that dies mid-stream moves nothing; the next run finishes; a step that never lands is ambiguous', async () => {
  const from = await spooled(src.packs.ref);
  const plan = must(planTransfer(from.pack, from.resolved, { budget: BUDGET, ref: REF, commit: src.commit }));
  const { bare, t } = repo();
  must(await runTransfer(t, from, plan, src.commit, { maxSteps: 2 }));
  const before = refsOf(bare);
  // a spool that fails partway through every read: the pack stream errors, the push cannot have landed
  const dying = { ...from, source: { size: from.source.size, read: async (o, l) => {
    const r = await from.source.read(o, l);
    if (!r.ok) return r;
    let sent = 0;
    const reader = r.value.getReader();
    return { ok: true, value: new ReadableStream({ async pull(c) {
      const { done, value } = await reader.read();
      if (done) { c.close(); return; }
      sent += value.length;
      if (sent > l / 2 && l > 1000) { c.error(new Error('spool died')); return; }
      c.enqueue(value);
    } }) };
  } } };
  const died = await transferStep(t, dying, plan, must(await transferStatus(t, plan)).step, src.commit);
  assert.equal(died.ok, false);
  assert.equal(refsOf(bare), before, 'the refs where they were');
  const stuck = await runTransfer(t, dying, plan, src.commit, { retries: 1 });
  assert.equal(stuck.ok, false);
  assert.equal(stuck.error.code, 'ambiguous');
  assert.match(stuck.error.message, /did not land after 2 tries/);
  assert.equal(refsOf(bare), before);
  const done = must(await runTransfer(t, from, plan, src.commit));
  assert.equal(done.tag, 'done');
  assertCopied(bare, plan);
});

test('refusals before any push: an object over the budget, a tree not in the pack, a commit that does not parse', async () => {
  const from = await spooled(src.packs.ref);
  const { bare, t } = repo();
  const small = await copyTree(t, from, { budget: { ...BUDGET, maxObjectBytes: 1000 }, ref: REF, commit: src.commit });
  assert.equal(small.error.code, 'limit_exceeded');
  const otherTree = te.encode(`tree ${'1'.repeat(40)}\nauthor a <a@x> 0 +0000\ncommitter a <a@x> 0 +0000\n\nx\n`);
  const noTree = planTransfer(from.pack, from.resolved, { budget: BUDGET, ref: REF, commit: otherTree });
  assert.equal(noTree.error.code, 'bad_request');
  assert.match(noTree.error.message, /is not a tree in the pack/);
  assert.equal(planTransfer(from.pack, from.resolved, { budget: BUDGET, ref: REF, commit: te.encode('not a commit') }).error.code, 'pack_corrupt');
  assert.equal(refsOf(bare), '', 'nothing pushed');
});

test('refusals at a step and at status: an edited plan, another pack, other ids, other commit bytes, a step not in the plan, a ref taken', async () => {
  const from = await spooled(src.packs.ref);
  const other = await spooled(src.packs.ofs);
  const plan = must(planTransfer(from.pack, from.resolved, { budget: BUDGET, ref: REF, commit: src.commit }));
  const { bare, t } = repo();
  const edited = await transferStep(t, from, { ...plan, ref: 'refs/heads/other' }, 0, src.commit);
  assert.match(edited.error.message, /does not match its hash/);
  assert.match((await transferStep(t, other, plan, 0, src.commit)).error.message, /is not the planned one/);
  const ids = Uint8Array.from(from.resolved.columns.oid);
  ids.fill(0x11, 0, 20 * from.resolved.count);
  const lyingOid = i => (Number.isInteger(i) && i >= 0 && i < from.resolved.count ? { tag: 'some', value: '11'.repeat(20) } : { tag: 'none' });
  const lying = { ...from, resolved: { ...from.resolved, oid: lyingOid, columns: { ...from.resolved.columns, oid: ids } } };
  assert.match((await transferStep(t, lying, plan, 0, src.commit)).error.message, /the pack is not the one planned/);
  const last = plan.steps.length - 1;
  const wrongCommit = te.encode(new TextDecoder().decode(src.commit).replace('two', 'three'));
  assert.match((await transferStep(t, from, plan, last, wrongCommit)).error.message, /does not give the planned head/);
  assert.equal((await transferStep(t, from, plan, last, te.encode('junk'))).error.code, 'pack_corrupt');
  assert.match((await transferStep(t, from, plan, plan.steps.length, src.commit)).error.message, /is not in the plan/);
  assert.equal(refsOf(bare), '', 'nothing pushed');
  // a temp ref this plan never writes, then the target taken by another commit
  git(work, ['push', '-q', bare, `${src.head}:${plan.tempRef}`]);
  const foreign = await transferStatus(t, plan);
  assert.equal(foreign.error.code, 'cas_conflict');
  git(bare, ['update-ref', '-d', plan.tempRef]);
  git(work, ['push', '-q', bare, `${src.head}:${REF}`]);
  const taken = await runTransfer(t, from, plan, src.commit);
  assert.equal(taken.error.code, 'cas_conflict');
  assert.match(taken.error.message, /already exists/);
});

test('commit policy: signatures dropped (with their continuation lines), other headers and the encoding kept', () => {
  const text = [
    `tree ${src.tree}`, `parent ${src.head}`, 'author Ann <a@x> 1700000000 +0100', 'committer Cy <c@x> 1700000001 -0500',
    'encoding ISO-8859-1', 'gpgsig -----BEGIN PGP SIGNATURE-----', ' line two', ' -----END PGP SIGNATURE-----',
    'x-custom kept', ' continued', 'mergetag object 1', ' more', '', 'subject', '',
  ].join('\n');
  const made = must(rootCommit(te.encode(text))).commit;
  const out = new TextDecoder().decode(made.data);
  assert.equal(out, [`tree ${src.tree}`, 'author Ann <a@x> 1700000000 +0100', 'committer Cy <c@x> 1700000001 -0500', 'encoding ISO-8859-1', 'x-custom kept', ' continued', '', 'subject', ''].join('\n'));
  assert.equal(made.oid, git(work, ['hash-object', '-t', 'commit', '--stdin'], { input: out }).trim());
});

test('temp trees: fanned out by the first two hex digits, ids git agrees with', async () => {
  const from = await spooled(src.packs.ref);
  const all = [...Array(from.pack.count).keys()].filter(i => from.resolved.columns.type[i] === 3);
  const { subtrees, root: rootTree } = must(batchTrees(from.resolved, all));
  const trees = [...subtrees, rootTree];
  const scratch = makeBareRepo(root, `scratch${n++}`);
  for (const o of trees) assert.equal(git(scratch, ['hash-object', '-w', '-t', 'tree', '--stdin'], { input: Buffer.from(o.data) }).trim(), o.oid);
  const names = git(scratch, ['ls-tree', rootTree.oid]).split('\n').filter(Boolean).map(l => l.split('\t')[1]);
  assert.ok(names.every(x => /^[0-9a-f]{2}$/.test(x)));
  assert.equal(trees.length, names.length + 1);
});

test('sweepTransfers: removes an abandoned transfer\'s temp ref, keeps what it is told to', async () => {
  const from = await spooled(src.packs.ref);
  const plan = must(planTransfer(from.pack, from.resolved, { budget: BUDGET, ref: REF, commit: src.commit }));
  const { bare, t } = repo();
  assert.deepEqual(must(await sweepTransfers(t)), []);
  must(await runTransfer(t, from, plan, src.commit, { maxSteps: 2 }));
  assert.deepEqual(must(await sweepTransfers(t, { keep: [plan.tempRef] })), []);
  assert.deepEqual(must(await sweepTransfers(t)), [plan.tempRef]);
  assert.equal(git(bare, ['for-each-ref', 'refs/ply']).trim(), '');
});

test('the plan: a tagged step per batch, prev an Option, refs git would push; a malformed plan read back is refused', async () => {
  const from = await spooled(src.packs.ref);
  const plan = must(planTransfer(from.pack, from.resolved, { budget: BUDGET, ref: REF, commit: src.commit }));
  const last = plan.steps.length - 1;
  plan.steps.forEach((s, i) => {
    assert.equal(s.kind, i === last ? 'final' : 'batch');
    if (i === 0) assert.deepEqual(s.prev, { tag: 'none' });
    else assert.deepEqual(s.prev, { tag: 'some', value: plan.steps[i - 1].temp });
    if (s.kind === 'final') assert.equal('temp' in s, false);
    else assert.match(s.temp, /^[0-9a-f]{40}$/);
  });
  // one push: the final step alone, no temp ref to delete
  const one = must(planTransfer(from.pack, from.resolved, { budget: { ...BUDGET, maxRequestBytes: 10_000_000 }, ref: REF, commit: src.commit }));
  assert.deepEqual(one.steps, [{ kind: 'final', prev: { tag: 'none' } }]);
  for (const ref of ['main', 'refs/heads', 'refs/@', 'refs/heads/a..b', 7]) {
    const r = planTransfer(from.pack, from.resolved, { budget: BUDGET, ref, commit: src.commit });
    assert.equal(r.error.code, 'bad_request', String(ref));
    assert.equal(r.error.what, 'ref');
  }
  for (const tempPrefix of ['refs/ply', 'refs/', 'nope/', 'refs/ply/transfer']) assert.equal(planTransfer(from.pack, from.resolved, { budget: BUDGET, ref: REF, commit: src.commit, tempPrefix }).error.what, 'tempPrefix', tempPrefix);
  assert.ok(must(planTransfer(from.pack, from.resolved, { budget: BUDGET, ref: REF, commit: src.commit, tempPrefix: 'refs/x/y/' })).tempRef.startsWith('refs/x/y/'));
  // an index the resolved columns do not hold: refused, not read past the end
  const outside = batchTrees(from.resolved, [from.resolved.count]);
  assert.equal(outside.error.code, 'bad_request');
  assert.match(outside.error.message, /is not in the resolved index/);
  const longer = planTransfer({ ...from.pack, count: from.pack.count + 1 }, from.resolved, { budget: BUDGET, ref: REF, commit: src.commit });
  assert.match(longer.error.message, /entry \d+ is not in the resolved index/);
  // read back: each malformed shape refused, even with its hash recomputed by hand
  const json = JSON.parse(JSON.stringify(plan));
  const bad = [
    p => { p.steps[0] = { ...p.steps[0], prev: null }; },
    p => { p.steps[0] = { ...p.steps[0], temp: null }; },
    p => { p.steps[last] = { ...p.steps[last], temp: p.steps[0].temp }; },
    p => { p.steps[0] = { ...p.steps[0], kind: 'final' }; },
    p => { p.steps[last] = { ...p.steps[last], kind: 'batch' }; },
    p => { p.steps.push({ kind: 'final', prev: { tag: 'none' } }); },
    p => { p.steps = {}; },
    p => { p.steps[1] = { ...p.steps[1], prev: { tag: 'some', value: 'x' } }; },
    p => { p.head = 'HEAD'; },
    p => { p.ref = 'main'; },
    p => { p.tempRef = 'refs/@'; },
  ];
  for (const edit of bad) {
    const p = structuredClone(json);
    edit(p);
    assert.equal(checkTransferPlan(p).ok, false, String(edit));
  }
  assert.ok(checkTransferPlan(json).ok);
});

test('ls-refs that lags a push: settled by reading again, not by sending again; a longer lag pauses; a resend refused after a lag goes on', async () => {
  const from = await spooled(src.packs.ref);
  const plan = must(planTransfer(from.pack, from.resolved, { budget: BUDGET, ref: REF, commit: src.commit }));
  // every push shows two reads late; three reads settle it: no step is sent twice
  {
    const { bare, t } = repo();
    const lag = lagging(t, () => 2);
    const run = must(await runTransfer(lag.t, from, plan, src.commit, { settle: { reads: 3, delayMs: 0 } }));
    assert.deepEqual(run, { tag: 'done', head: plan.head, pushes: plan.steps.length, tempLeft: false });
    assertCopied(bare, plan);
  }
  // a lag longer than the reads: the run pauses at the step it pushed ('settling'), the refs already past it
  const { bare, t } = repo();
  let lagNext = 4;
  const lag = lagging(t, () => lagNext);
  const paused = must(await runTransfer(lag.t, from, plan, src.commit, { settle: { reads: 2, delayMs: 0 } }));
  assert.deepEqual(paused, { tag: 'paused', step: 0, pushes: 1, reason: 'settling' });
  assert.equal(git(bare, ['rev-parse', plan.tempRef]).trim(), plan.steps[0].temp, 'the push landed');
  // the next run's first read still lags: it sends step 0 again, the server refuses it (stale), the refs settled show
  // step 0 landed, and the run goes on to the end
  lagNext = 0;
  const before = lag.reads();
  const resumed = must(await runTransfer(lag.t, from, plan, src.commit, { settle: { reads: 3, delayMs: 0 } }));
  assert.equal(resumed.tag, 'done');
  assert.equal(resumed.pushes, plan.steps.length, 'one resend, refused, then every other step once');
  assert.ok(lag.reads() > before);
  assertCopied(bare, plan);
  // a refusal the refs do not explain stands: the target taken by another commit, read after the push
  const other = repo();
  git(work, ['push', '-q', other.bare, `${src.head}:${REF}`]);
  assert.equal((await runTransfer(other.t, from, plan, src.commit)).error.code, 'cas_conflict');
});

test('done reports a temp ref left behind; the spans: run > status, step, settle, each with the plan hash and an outcome', async () => {
  const from = await spooled(src.packs.ref);
  const plan = must(planTransfer(from.pack, from.resolved, { budget: BUDGET, ref: REF, commit: src.commit }));
  const ex = arrayExporter();
  const { bare, t } = repo({ tracer: new Tracer({ exporter: ex }) });
  const run = must(await runTransfer(t, from, plan, src.commit, { settle: { reads: 1, delayMs: 0 } }));
  assert.equal(run.tempLeft, false);
  const spans = ex.lines.flatMap(flattenLine);
  const named = name => spans.filter(s => s.name === name);
  const [root] = named('git.transfer.run');
  assert.equal(root.attrs['git.transfer.outcome'], 'done');
  assert.equal(root.attrs['git.transfer.pushes'], plan.steps.length);
  assert.equal(root.attrs['git.transfer.plan.hash'], plan.hash);
  assert.equal(root.attrs['git.transfer.ref'], REF);
  const steps = named('git.transfer.step');
  assert.deepEqual(steps.map(s => s.attrs['git.transfer.step']), plan.steps.map((_, i) => i));
  for (const [i, s] of steps.entries()) {
    assert.equal(s.parentSpanId, root.spanId);
    assert.equal(s.attrs['git.transfer.plan.hash'], plan.hash);
    assert.equal(s.attrs['git.transfer.step.kind'], plan.steps[i].kind);
    assert.equal(s.attrs['git.transfer.step.outcome'], 'landed');
    assert.equal(s.attrs['git.transfer.batch.entries'], plan.pack.batches[i].entries.length);
    assert.ok(s.attrs['git.transfer.batch.bytes'] > 0 && s.attrs['git.transfer.batch.bytes'] <= plan.pack.batches[i].packBytes + 300 * 68 + 32 * 1024);
    assert.ok(spans.some(w => w.parentSpanId === s.spanId), 'the push\'s wire spans under the step');
  }
  const settles = named('git.transfer.settle');
  assert.equal(settles.length, plan.steps.length);
  assert.ok(settles.every(s => s.attrs['git.transfer.settle.outcome'] === 'moved' && s.parentSpanId === root.spanId));
  assert.ok(named('git.transfer.status').every(s => s.attrs['git.transfer.plan.hash'] === plan.hash && typeof s.attrs['git.transfer.status.outcome'] === 'string'));
  // a temp ref still on the destination after the ref was created (a host that kept it): done, tempLeft
  git(bare, ['update-ref', plan.tempRef, plan.steps[0].temp]);
  assert.deepEqual(must(await runTransfer(t, from, plan, src.commit)), { tag: 'done', head: plan.head, pushes: 0, tempLeft: true });
  assert.deepEqual(must(await sweepTransfers(t)), [plan.tempRef]);
  const [sweep] = named('git.transfer.sweep').length ? named('git.transfer.sweep') : ex.lines.flatMap(flattenLine).filter(s => s.name === 'git.transfer.sweep');
  assert.equal(sweep.attrs['git.transfer.sweep.deleted'], 1);
});
