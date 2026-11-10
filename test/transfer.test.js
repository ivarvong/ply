// Resumable transfer (#238): one commit's tree, from a spooled pack, to a fresh repository as a new root commit, in
// pushes under a cap. The oracle is git http-backend with receive.fsckObjects and transfer.fsckObjects on:
//   - end to end (REF-only and OFS packs, several batches): the ref is the planned head, no temp ref is left,
//     fsck --strict is clean, exactly the tree's objects and the one new commit are reachable, ls-tree -r is the
//     source's, the commit has no parents and keeps the source's author, committer and message
//   - resume: paused after every single push and resumed, the same head; a push that dies mid-stream (the spool
//     fails) leaves the refs where they were and the next run finishes; a step already landed, sent again, is refused
//     and moves nothing
//   - refusals before any push: a budget an object cannot fit, a tree not in the pack, a commit that does not parse;
//     at a step: an edited plan, another pack, other resolved ids, other commit bytes, a step not in the plan; at
//     status: the ref already at another commit, a temp ref the plan never writes; a step that never lands
//   - the commit policy (signatures dropped, other headers kept) and the deterministic ids
//   - sweepTransfers removes what an abandoned transfer left, keeping what it is told to
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
function repo() {
  const name = `t${n++}`;
  const bare = makeBareRepo(root, name);
  return { bare, t: unwrap(createTransport(`${srv.url}/${name}.git`)) };
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
  const lying = { ...from, resolved: { ...from.resolved, columns: { ...from.resolved.columns, oid: ids } } };
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
  const trees = must(batchTrees(from.resolved, all));
  const rootTree = trees.at(-1);
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
