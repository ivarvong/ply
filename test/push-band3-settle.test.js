// An empty side-band band 3 after a push, settled by reading the ref (push.ts settleByTip; SAFETY.md I36).
//
// The defect this file pins: the server applied the push, answered with an empty band 3, and another writer advanced
// the ref before ply read it back. ply said `cas_conflict` (retry class `fresh`: do it again) for a push that had
// landed, so the change was applied twice. The rule now, one test a row:
//
//   the tip is newOid                                   landed
//   the tip is what the command expected                ambiguous (the update can still be applied)
//   the ref is gone (an update)                         cas_conflict
//   newOid is an ancestor of the tip                    landed (the ref moved on)
//   every line of the tip's history ends at a parent    cas_conflict (the ref moved and does not hold the commit)
//   of newOid or at a root, none at newOid (and, for
//   an update, the walk met oldOid)
//   anything else: the walk's bound, a failed read, a   ambiguous
//   push that does not carry the commit, a tip that
//   never meets oldOid, several refs, a delete
//
// Every case runs against real git (http-backend): the first receive-pack request is applied or dropped, its answer
// replaced with an empty band 3, and the other writer acts before ply's read-back. Native git judges the result.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { git, tmpRoot, makeBareRepo, startGitServer, commitFiles, initRepo } from './server.js';
import { push, ZERO_OID } from '../src/push.js';
import { createTransport } from '../src/http.js';
import { hashObject, TYPE } from '../src/objects.js';
import { commitChanges } from '../src/changes.js';
import { editFile } from '../src/edit.js';
import { verifyPushed } from '../src/operation.js';
import { lsRefs } from '../src/lsrefs.js';
import { RETRY } from '../src/errors.js';
import { DEFAULT_LIMITS, WORKER_LIMITS, LIMIT_PUSH_SETTLE_COMMITS } from '../src/limits.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { unwrap } from './unwrap.js';

const te = new TextEncoder();
const td = new TextDecoder();
const MAIN = 'refs/heads/main';
const WHO = ['-c', 'user.name=other', '-c', 'user.email=other@x'];
let root, cleanup, srv, n = 0;
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv.close(); cleanup(); });

// A repository whose main is seed <- base, the two commits every case starts from.
function repo() {
  const name = `r${n++}`;
  const bare = makeBareRepo(root, name);
  const work = initRepo(join(root, `${name}-w`));
  const seed = commitFiles(work, bare, { 'ledger.txt': 'opening\n' }, 'seed');
  const base = commitFiles(work, bare, { 'ledger.txt': 'opening\nbase\n' }, 'base');
  const tree = git(bare, ['rev-parse', `${base}^{tree}`]).trim();
  // another writer's commit, made in the bare repository itself: on `parents`, not yet on any ref
  const commit = (parents, msg = 'other') => git(bare, [...WHO, 'commit-tree', tree, ...parents.flatMap(p => ['-p', p]), '-m', msg]).trim();
  const set = (oid, ref = MAIN) => git(bare, ['update-ref', ref, oid]);
  const tip = (ref = MAIN) => { try { return git(bare, ['rev-parse', '--verify', '-q', ref]).trim(); } catch { return null; } };
  const isAncestor = (a, b) => { try { git(bare, ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } };
  return { bare, url: `${srv.url}/${name}.git`, seed, base, tree, commit, set, tip, isAncestor };
}
// A commit ply builds and carries in its push: `tree` on `parents`.
function carried(tree, parents, msg = 'mine') {
  const data = te.encode(`tree ${tree}\n${parents.map(p => `parent ${p}\n`).join('')}author me <me@x> 1700000000 +0000\ncommitter me <me@x> 1700000000 +0000\n\n${msg}\n`);
  return { oid: hashObject('commit', data), objects: [{ type: TYPE.COMMIT, data }] };
}
const band3 = (text = '') => new Response(Buffer.concat([Buffer.from((5 + text.length).toString(16).padStart(4, '0') + '\x03' + text, 'latin1'), Buffer.from('0000')]), { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' } });
// The fault: the first receive-pack request is applied (`apply`) or dropped, `then` runs (the other writer), and the
// answer is an empty band 3 (or `said`). `failing` names a read-back request to fail ('ls-refs' or 'fetch'): `how`
// says in which way.
function fault({ apply, then = () => {}, said = '', failing = null, how = () => new Response('no', { status: 500 }) }) {
  const seen = { pushes: 0, reads: [], prefixes: [] };
  const fetchImpl = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/git-receive-pack')) {
      seen.pushes += 1;
      if (seen.pushes > 1) return fetch(input, init);
      if (apply) { const res = await fetch(input, init); assert.equal(res.status, 200); assert.match(td.decode(await res.arrayBuffer()), /unpack ok/); }
      await then();
      return band3(said);
    }
    if (seen.pushes === 1 && url.endsWith('/git-upload-pack')) {
      const body = td.decode(init.body);
      const kind = /command=(\S+)/.exec(body)[1];
      seen.reads.push(kind);
      if (kind === 'ls-refs') seen.prefixes.push(...body.matchAll(/ref-prefix (\S+)/gu).map(m => m[1]));
      if (kind === failing) return how(input, init);
    }
    return fetch(input, init);
  };
  return { seen, fetchImpl };
}
// One push through the fault. Returns the Result, the receive-pack span's attributes and what was requested.
async function pushed(r, options, f, limits = {}) {
  const ex = arrayExporter();
  const { seen, fetchImpl } = fault(f);
  const made = unwrap(createTransport(r.url, { tracer: new Tracer({ exporter: ex }), fetchImpl, limits, ...(f.signal ? { signal: f.signal } : {}) }));
  // `raising`: a transport (a caller's own) whose named field raises once the push has been sent
  const t = f.raising ? Object.create(made, { [f.raising]: { get() { if (seen.pushes > 0) throw new Error(`${f.raising} raised`); return made[f.raising]; } } }) : made;
  const res = await push(t, options);
  const span = ex.lines.flatMap(flattenLine).find(s => s.name === 'git.receive-pack');
  return { res, attrs: span.attrs, seen, t };
}
const resolved = out => out.attrs['git.push.ambiguous.resolved'];
// The three outcomes, each with what a caller reads off it.
function landed(out, readBack, how) {
  assert.ok(out.res.ok, out.res.ok ? '' : `${out.res.error.code}: ${out.res.error.message}`);
  assert.deepEqual(out.res.value.report, { tag: 'statuses', refs: [{ ref: out.attrs['git.push.ref'], ok: true, reason: '' }] });
  assert.equal(out.res.value.readBack, readBack);
  // the rest of a PushResult is the push's own: the pack it sent, no hook output
  assert.deepEqual([out.res.value.packBytes, out.res.value.entries.length, out.res.value.hookOutput], [out.attrs['git.push.pack.bytes'], out.attrs['git.push.pack.objects'], '']);
  assert.equal(resolved(out), how);
  assert.deepEqual([out.attrs['git.push.ok'], out.attrs['git.push.outcome'], out.attrs['git.push.ng.reason'], out.attrs['git.push.verify.ref']], [true, 'landed', '', readBack]);
}
function conflict(out, expected, actual) {
  assert.equal(out.res.ok, false);
  const e = out.res.error;
  assert.deepEqual([e.code, e.message, e.expected, e.actual, e.original, RETRY[e.code]], ['cas_conflict', 'push rejected: stale ref', expected, actual, 'ambiguous', 'fresh']);
  assert.equal(e.cause.code, 'ambiguous');
  assert.equal(resolved(out), 'cas_conflict');
  assert.deepEqual([out.attrs['git.push.ok'], out.attrs['git.push.outcome'], out.attrs['git.push.ng.reason'], out.attrs['git.push.verify.ref']], [false, 'rejected', 'stale ref', actual ?? '']);
}
function unknown(out, how) {
  assert.equal(out.res.ok, false);
  const e = out.res.error;
  assert.deepEqual([e.code, e.message, RETRY[e.code]], ['ambiguous', 'push outcome unknown: remote: : band 3', 'read']);
  assert.equal(resolved(out), how);
  assert.deepEqual([out.attrs['git.push.ok'], out.attrs['git.push.outcome']], [false, 'ambiguous']);
}

test('the limit: 8 commits by default and in a Worker', () => {
  assert.equal(LIMIT_PUSH_SETTLE_COMMITS, 8);
  assert.equal(DEFAULT_LIMITS.maxPushSettleCommits, 8);
  assert.equal(WORKER_LIMITS.maxPushSettleCommits, 8);
});

test('the tip is newOid: landed, the report was lost', async () => {
  const r = repo();
  const mine = carried(r.tree, [r.base]);
  const out = await pushed(r, { ref: MAIN, oldOid: r.base, newOid: mine.oid, objects: mine.objects }, { apply: true });
  landed(out, mine.oid, 'landed');
  assert.equal(r.tip(), mine.oid);
  assert.deepEqual(out.seen.reads, ['ls-refs'], 'one read: the tip says it all');
  assert.deepEqual(out.seen.prefixes, [MAIN], 'and it asks for that ref alone');
});

test('the tip is what the command expected: ambiguous, never cas_conflict (the update can still be applied)', async () => {
  const r = repo();
  const mine = carried(r.tree, [r.base]);
  const options = { ref: MAIN, oldOid: r.base, newOid: mine.oid, objects: mine.objects };
  const out = await pushed(r, options, { apply: false });
  unknown(out, 'unchanged');
  assert.equal(out.attrs['git.push.verify.ref'], r.base);
  assert.deepEqual(out.seen.reads, ['ls-refs']);
  // the retry class is `read`: the ref is where it was, so the same push is sent again, and lands once
  assert.equal(r.tip(), r.base);
  const again = await push(out.t, options);
  assert.ok(again.ok);
  assert.equal(again.value.readBack, null, 'a push its report settled carries no read-back');
  assert.equal(r.tip(), mine.oid);
  // a create whose ref is still absent is the same
  const made = await pushed(r, { ref: 'refs/heads/new', oldOid: ZERO_OID, newOid: mine.oid, objects: [] }, { apply: false });
  unknown(made, 'unchanged');
  assert.equal(made.attrs['git.push.verify.ref'], '');
});

test('newOid is an ancestor of the tip: landed, the ref moved on (the defect: this was cas_conflict)', async () => {
  const r = repo();
  const mine = carried(r.tree, [r.base]);
  let other;
  const out = await pushed(r, { ref: MAIN, oldOid: r.base, newOid: mine.oid, objects: mine.objects }, { apply: true, then: () => { other = r.commit([mine.oid]); r.set(other); } });
  landed(out, other, 'ancestor');
  assert.ok(r.isAncestor(mine.oid, r.tip()));
  assert.deepEqual(out.seen.reads, ['ls-refs', 'fetch'], 'the tip, then the one commit that names newOid');
});

test('the walk is bounded by maxPushSettleCommits: at the bound it answers, one short it is ambiguous', async () => {
  for (const [max, want] of [[2, 'ancestor'], [1, 'unknown'], [0, 'unknown']]) {
    const r = repo();
    const mine = carried(r.tree, [r.base]);
    let tip;
    const out = await pushed(r, { ref: MAIN, oldOid: r.base, newOid: mine.oid, objects: mine.objects }, { apply: true, then: () => { tip = r.commit([r.commit([mine.oid])]); r.set(tip); } }, { maxPushSettleCommits: max });
    if (want === 'ancestor') landed(out, tip, 'ancestor'); else unknown(out, 'unknown');
    assert.equal(out.seen.reads.filter(k => k === 'fetch').length, max, `max ${max}: no more commits read than the limit`);
    assert.ok(r.isAncestor(mine.oid, r.tip()));
  }
  // the same on the other verdict: two commits past oldOid
  for (const [max, want] of [[2, 'cas_conflict'], [1, 'unknown']]) {
    const r = repo();
    const mine = carried(r.tree, [r.base]);
    let tip;
    const out = await pushed(r, { ref: MAIN, oldOid: r.base, newOid: mine.oid, objects: mine.objects }, { apply: false, then: () => { tip = r.commit([r.commit([r.base])]); r.set(tip); } }, { maxPushSettleCommits: max });
    if (want === 'cas_conflict') conflict(out, r.base, tip); else unknown(out, 'unknown');
  }
});

test('the ref moved and does not hold the commit: cas_conflict (a lost race, an overwrite, a deleted ref)', async () => {
  // the Artifacts race: the push was refused, the winner's commit is on oldOid
  const lost = repo();
  const mine = carried(lost.tree, [lost.base]);
  let winner;
  const out = await pushed(lost, { ref: MAIN, oldOid: lost.base, newOid: mine.oid, objects: mine.objects }, { apply: false, then: () => { winner = lost.commit([lost.base]); lost.set(winner); } });
  conflict(out, lost.base, winner);
  assert.deepEqual(out.seen.reads, ['ls-refs', 'fetch'], 'one commit read: the winner names oldOid');
  // the retry class is `fresh`: the same change on the new tip lands, and is in the history once
  const redo = carried(lost.tree, [winner]);
  assert.ok((await push(out.t, { ref: MAIN, oldOid: winner, newOid: redo.oid, objects: redo.objects })).ok);
  assert.equal(git(lost.bare, ['rev-list', '--count', '--author=me', MAIN]).trim(), '1');

  // applied, then overwritten by a commit on oldOid: the ref does not hold it either, and doing it again applies it once
  const over = repo();
  const mine2 = carried(over.tree, [over.base]);
  let forced;
  const out2 = await pushed(over, { ref: MAIN, oldOid: over.base, newOid: mine2.oid, objects: mine2.objects }, { apply: true, then: () => { forced = over.commit([over.base]); over.set(forced); } });
  conflict(out2, over.base, forced);
  assert.equal(over.isAncestor(mine2.oid, over.tip()), false);

  // the ref is gone: nothing holds the commit, and nothing is walked
  const gone = repo();
  const mine3 = carried(gone.tree, [gone.base]);
  const out3 = await pushed(gone, { ref: 'refs/heads/topic', oldOid: gone.base, newOid: mine3.oid, objects: mine3.objects }, { apply: false });
  conflict(out3, gone.base, null);
  assert.deepEqual(out3.seen.reads, ['ls-refs']);
});

test('a pushed commit that is not a child of oldOid (a rewrite): the walk stops at its own parents', async () => {
  // seed <- base (oldOid); the push replaces base with a commit on seed. Refused, and another writer commits on base:
  // tip -> base (oldOid, met; not a stop, so it is read) -> seed (a parent of newOid: the line ends). Two commits read
  for (const [max, want] of [[2, 'cas_conflict'], [1, 'unknown']]) {
    const w = repo();
    const rewrite = carried(w.tree, [w.seed]);
    let tip;
    const out = await pushed(w, { ref: MAIN, oldOid: w.base, newOid: rewrite.oid, objects: rewrite.objects }, { apply: false, then: () => { tip = w.commit([w.base]); w.set(tip); } }, { maxPushSettleCommits: max });
    if (want === 'cas_conflict') conflict(out, w.base, tip); else unknown(out, 'unknown');
    assert.deepEqual(out.seen.reads, ['ls-refs', ...Array(max).fill('fetch')]);
  }
  // the tip is a parent of newOid itself and not oldOid: it cannot hold newOid, but it is no tip that came after
  // oldOid either (the ref was set back): ambiguous, and nothing is read
  const back = repo();
  const rewrite = carried(back.tree, [back.seed]);
  const out = await pushed(back, { ref: MAIN, oldOid: back.base, newOid: rewrite.oid, objects: rewrite.objects }, { apply: false, then: () => back.set(back.seed) });
  unknown(out, 'unknown');
  assert.deepEqual(out.seen.reads, ['ls-refs']);
  // applied (git takes the non-fast-forward), then built on: landed
  const on = repo();
  const rewrite2 = carried(on.tree, [on.seed]);
  let tip2;
  const out2 = await pushed(on, { ref: MAIN, oldOid: on.base, newOid: rewrite2.oid, objects: rewrite2.objects }, { apply: true, then: () => { tip2 = on.commit([rewrite2.oid]); on.set(tip2); } });
  landed(out2, tip2, 'ancestor');
  // a merge pushed on oldOid: the other parent ends a line too. tip <- (x on base, y on side): base is oldOid, side
  // is the merge's second parent, and neither line is read past them
  const m = repo();
  const side = m.commit([m.seed], 'side');
  m.set(side, 'refs/heads/side');
  const merge = carried(m.tree, [m.base, side]);
  let tip3;
  const out3 = await pushed(m, { ref: MAIN, oldOid: m.base, newOid: merge.oid, objects: merge.objects }, { apply: false, then: () => { tip3 = m.commit([m.commit([m.base], 'x'), m.commit([side], 'y')]); m.set(tip3); } }, { maxPushSettleCommits: 3 });
  conflict(out3, m.base, tip3);
  assert.deepEqual(out3.seen.reads, ['ls-refs', 'fetch', 'fetch', 'fetch'], 'tip, x, y: side is not read');
});

test('a merge at the tip: every parent is followed, each commit read once', async () => {
  // one parent leads to newOid: landed
  const a = repo();
  const mine = carried(a.tree, [a.base]);
  let merge;
  const out = await pushed(a, { ref: MAIN, oldOid: a.base, newOid: mine.oid, objects: mine.objects }, { apply: true, then: () => { merge = a.commit([a.commit([a.base]), a.commit([mine.oid])]); a.set(merge); } });
  landed(out, merge, 'ancestor');
  // a diamond over oldOid without newOid: tip <- (left, right) <- join <- base. Four commits, each read once
  for (const [max, want] of [[4, 'cas_conflict'], [3, 'unknown']]) {
    const d = repo();
    const mine2 = carried(d.tree, [d.base]);
    let tip;
    const out2 = await pushed(d, { ref: MAIN, oldOid: d.base, newOid: mine2.oid, objects: mine2.objects }, { apply: false, then: () => { const join_ = d.commit([d.base], 'join'); tip = d.commit([d.commit([join_], 'left'), d.commit([join_], 'right')]); d.set(tip); } }, { maxPushSettleCommits: max });
    if (want === 'cas_conflict') conflict(out2, d.base, tip); else unknown(out2, 'unknown');
    assert.equal(out2.seen.reads.filter(k => k === 'fetch').length, Math.min(max, 4));
  }
  // one line ends at oldOid, the other at a root of its own: still whole, still without newOid
  const u = repo();
  const mine3 = carried(u.tree, [u.base]);
  let tip3;
  const out3 = await pushed(u, { ref: MAIN, oldOid: u.base, newOid: mine3.oid, objects: mine3.objects }, { apply: false, then: () => { tip3 = u.commit([u.commit([u.base]), u.commit([], 'a root')]); u.set(tip3); } });
  conflict(out3, u.base, tip3);
});

test('a tip that never meets oldOid proves nothing: ambiguous (a read that lags, a ref set back)', async () => {
  // the ref reads as an ancestor of oldOid: its whole history is read, newOid is not in it, and that says nothing
  // about a push made on oldOid
  const r = repo();
  const mine = carried(r.tree, [r.base]);
  const out = await pushed(r, { ref: MAIN, oldOid: r.base, newOid: mine.oid, objects: mine.objects }, { apply: true, then: () => r.set(r.seed) });
  unknown(out, 'unknown');
  assert.deepEqual(out.seen.reads, ['ls-refs', 'fetch']);
  assert.equal(out.attrs['git.push.verify.ref'], r.seed);
  // a tip with parents, none of them oldOid: an unrelated history, read whole (its root and one commit on it)
  const u = repo();
  const mine2 = carried(u.tree, [u.base]);
  const out2 = await pushed(u, { ref: MAIN, oldOid: u.base, newOid: mine2.oid, objects: mine2.objects }, { apply: false, then: () => u.set(u.commit([u.commit([], 'a root')])) });
  unknown(out2, 'unknown');
  assert.deepEqual(out2.seen.reads, ['ls-refs', 'fetch', 'fetch']);
});

test('a push that carries no commit to answer for: ambiguous, nothing walked', async () => {
  // a ref moved to a commit the server already has: its being under the tip is not this push having landed
  const r = repo();
  const side = r.commit([r.base], 'side');
  r.set(side, 'refs/heads/side');
  let tip;
  const out = await pushed(r, { ref: MAIN, oldOid: r.base, newOid: side, objects: [] }, { apply: true, then: () => { tip = r.commit([side]); r.set(tip); } });
  unknown(out, 'unproven');
  assert.deepEqual(out.seen.reads, ['ls-refs']);
  assert.equal(out.attrs['git.push.verify.ref'], tip);
  // a commit carried beside the one pushed is not the one pushed
  const b = repo();
  const beside = carried(b.tree, [b.base]);
  const out3 = await pushed(b, { ref: MAIN, oldOid: b.base, newOid: carried(b.tree, [b.base], 'not sent').oid, objects: beside.objects }, { apply: false, then: () => b.set(b.commit([b.base])) });
  unknown(out3, 'unproven');
  // the commit's bytes sent as another type, or as a delta's instructions, are not the commit sent whole
  for (const entry of [data => ({ type: TYPE.BLOB, data }), data => ({ type: TYPE.COMMIT, data, base: { tag: 'ref', oid: 'c'.repeat(40) } })]) {
    const x = repo();
    const mine = carried(x.tree, [x.base]);
    const out5 = await pushed(x, { ref: MAIN, oldOid: x.base, newOid: mine.oid, objects: mine.objects.map(o => entry(o.data)) }, { apply: false, then: () => x.set(x.commit([x.base])) });
    unknown(out5, 'unproven');
    assert.deepEqual(out5.seen.reads, ['ls-refs']);
  }
  // a tag object: not a commit
  const g = repo();
  const data = te.encode(`object ${g.base}\ntype commit\ntag v1\ntagger me <me@x> 1700000000 +0000\n\nv1\n`);
  const tag = hashObject('tag', data);
  const out4 = await pushed(g, { ref: 'refs/tags/v1', oldOid: ZERO_OID, newOid: tag, objects: [{ type: TYPE.TAG, data }] }, { apply: false, then: () => g.set(g.base, 'refs/tags/v1') });
  unknown(out4, 'unproven');
  assert.deepEqual(out4.seen.reads, ['ls-refs']);
});

test('a create: landed at or under the tip; cas_conflict only when the whole history of the tip is without it', async () => {
  const ref = 'refs/heads/new';
  const create = (r, f, limits = {}) => { const mine = carried(r.tree, [r.base]); return pushed(r, { ref, oldOid: ZERO_OID, newOid: mine.oid, objects: mine.objects }, f(mine.oid), limits).then(out => ({ out, mine: mine.oid })); };
  const a = repo();
  const made = await create(a, () => ({ apply: true }));
  landed(made.out, made.mine, 'landed');
  // created, then moved on
  const b = repo();
  let tip;
  const moved = await create(b, mine => ({ apply: true, then: () => { tip = b.commit([mine]); b.set(tip, ref); } }));
  landed(moved.out, tip, 'ancestor');
  // another writer made the ref first, at the commit ours was made on (two branches from one base): the tip is a
  // parent of newOid, so it cannot hold it, and nothing is read
  const c = repo();
  const { out } = await create(c, () => ({ apply: false, then: () => c.set(c.base, ref) }));
  conflict(out, null, c.base);
  assert.deepEqual(out.seen.reads, ['ls-refs']);
  // ... or one commit past it
  const c2 = repo();
  let past;
  const { out: outPast } = await create(c2, () => ({ apply: false, then: () => { past = c2.commit([c2.base]); c2.set(past, ref); } }));
  conflict(outPast, null, past);
  assert.deepEqual(outPast.seen.reads, ['ls-refs', 'fetch']);
  // ... or at a commit below it: the seed's history is whole (a root) and without newOid
  const c3 = repo();
  const { out: outBelow } = await create(c3, () => ({ apply: false, then: () => c3.set(c3.seed, ref) }));
  conflict(outBelow, null, c3.seed);
  assert.deepEqual(outBelow.seen.reads, ['ls-refs', 'fetch']);
  // a root commit created where another root already is
  const c4 = repo();
  const first = carried(c4.tree, []);
  const outRoot = await pushed(c4, { ref, oldOid: ZERO_OID, newOid: first.oid, objects: first.objects }, { apply: false, then: () => c4.set(c4.commit([], 'their root'), ref) });
  conflict(outRoot, null, c4.tip(ref));
  // history that does not end within the bound: not the whole history
  const d = repo();
  unknown((await create(d, () => ({ apply: false, then: () => d.set(d.commit([d.commit([d.seed])]), ref) }), { maxPushSettleCommits: 2 })).out, 'unknown');
  // a tip that is not a commit (an annotated tag) cannot be walked
  const e = repo();
  const mine = carried(e.tree, [e.base]);
  const out2 = await pushed(e, { ref: 'refs/tags/v1', oldOid: ZERO_OID, newOid: mine.oid, objects: mine.objects }, { apply: false, then: () => git(e.bare, [...WHO, 'tag', '-a', '-m', 'v1', 'v1', e.base]) });
  unknown(out2, 'unknown');
});

test('a read-back that fails leaves it ambiguous: the ref, a commit of the walk, an abort', async () => {
  const run = async f => {
    const r = repo();
    const mine = carried(r.tree, [r.base]);
    const out = await pushed(r, { ref: MAIN, oldOid: r.base, newOid: mine.oid, objects: mine.objects }, { apply: true, then: () => r.set(r.commit([mine.oid])), ...f });
    assert.ok(r.isAncestor(mine.oid, r.tip()), 'the push had landed');
    return out;
  };
  const unread = await run({ failing: 'ls-refs' });
  unknown(unread, 'unread');
  assert.equal(unread.attrs['git.push.verify.ref'], undefined);
  unknown(await run({ failing: 'fetch' }), 'unknown');
  // a transport that throws
  unknown(await run({ failing: 'ls-refs', how: () => { throw new TypeError('socket'); } }), 'unread');
  unknown(await run({ failing: 'fetch', how: () => { throw new TypeError('socket'); } }), 'unknown');
  // a transport that raises instead of answering, at the ref and at the walk
  unknown(await run({ raising: 'limits' }), 'unread');
  const raised = await run({ raising: 'objects' });
  unknown(raised, 'unknown');
  assert.deepEqual(raised.seen.reads, ['ls-refs']);
  // the caller's signal fires during the walk: the push was sent, so this is ambiguous, not aborted
  const ac = new AbortController();
  const aborted = await run({ failing: 'fetch', how: () => { ac.abort(); throw ac.signal.reason; }, signal: ac.signal });
  unknown(aborted, 'unknown');
  // another commit served for the one asked (a forged line of history: a commit on oldOid, whose history is whole and
  // without newOid, which walked would be cas_conflict for a push that landed) is refused by its hash, never walked
  const r = repo();
  const decoy = r.commit([r.base], 'decoy');
  r.set(decoy, 'refs/heads/decoy');
  const wants = [];
  const forge = (input, init) => { const body = td.decode(init.body); wants.push(/want ([0-9a-f]{40})/u.exec(body)[1]); return fetch(input, { ...init, body: te.encode(body.replace(/want [0-9a-f]{40}/u, `want ${decoy}`)) }); };
  const mine = carried(r.tree, [r.base]);
  const forged = await pushed(r, { ref: MAIN, oldOid: r.base, newOid: mine.oid, objects: mine.objects }, { apply: true, then: () => r.set(r.commit([mine.oid])), failing: 'fetch', how: forge });
  unknown(forged, 'unknown');
  assert.deepEqual(wants, [r.tip()], 'the tip was asked for, the seed served');
});

test('several refs, a delete, and a band 3 that says something stay ambiguous with no read-back', async () => {
  const r = repo();
  const mine = carried(r.tree, [r.base]);
  r.set(r.base, 'refs/heads/side');
  const two = await pushed(r, { commands: [{ ref: MAIN, oldOid: r.base, newOid: mine.oid }, { ref: 'refs/heads/side', oldOid: r.base, newOid: mine.oid }], objects: mine.objects }, { apply: true, then: () => r.set(r.commit([mine.oid])) });
  assert.deepEqual([two.res.error.code, two.seen.reads, resolved(two)], ['ambiguous', [], undefined]);
  const del = await pushed(r, { ref: 'refs/heads/side', oldOid: mine.oid, newOid: ZERO_OID }, { apply: true });
  assert.deepEqual([del.res.error.code, del.seen.reads, resolved(del)], ['ambiguous', [], undefined]);
  const busy = await pushed(r, { ref: MAIN, oldOid: mine.oid, newOid: carried(r.tree, [mine.oid]).oid, objects: carried(r.tree, [mine.oid]).objects }, { apply: false, said: 'busy' });
  assert.deepEqual([busy.res.error.code, busy.res.error.message, busy.seen.reads, resolved(busy)], ['ambiguous', 'push outcome unknown: remote: busy: band 3', [], undefined]);
});

// ---- the operations: what a caller of commitChanges / editFile sees, and what following the retry class does ----
const who = name => ({ name, email: `${name}@x` });
const count = (r, message) => Number(git(r.bare, ['rev-list', '--count', `--grep=^${message}$`, MAIN]).trim());
const BOB = { ref: MAIN, author: who('bob'), message: 'bob appends', changes: [{ kind: 'write', path: 'ledger.txt', content: 'opening\nbase\nbob\n' }] };
const carol = r => async () => { const c = await commitChanges(r.url, { ref: MAIN, author: who('carol'), message: 'carol', changes: [{ kind: 'write', path: 'other.txt', content: 'x\n' }] }, {}); assert.ok(c.ok); };
const rootSpan = (ex, name) => ex.lines.flatMap(flattenLine).find(s => s.name === name);

test('commitChanges: a landed push whose ref moved on is ok, pinned or not, and the change is in the history once', async () => {
  for (const pinned of [true, false]) for (const verify of [false, true]) {
    const r = repo();
    const ex = arrayExporter();
    const { seen, fetchImpl } = fault({ apply: true, then: carol(r) });
    const res = await commitChanges(r.url, BOB, { tracer: new Tracer({ exporter: ex }), fetchImpl, verify, ...(pinned ? { head: r.base } : {}) });
    assert.ok(res.ok, res.ok ? '' : `pinned ${pinned} verify ${verify}: ${res.error.code}: ${res.error.message}`);
    assert.equal(seen.pushes, 1, 'nothing was sent again');
    assert.ok(r.isAncestor(res.value.oid, r.tip()), 'the commit ply names is in the ref');
    assert.notEqual(res.value.oid, r.tip());
    assert.equal(count(r, 'bob appends'), 1);
    assert.equal(git(r.bare, ['show', `${MAIN}:ledger.txt`]), 'opening\nbase\nbob\n');
    assert.equal(git(r.bare, ['show', `${MAIN}:other.txt`]), 'x\n');
    const span = rootSpan(ex, 'git.commit');
    assert.equal(span.attrs['git.commit.outcome'], 'commit');
    // verify: the tip push read is the read-back (the ref is not read again, and is not required to be the commit)
    assert.equal(span.attrs['git.commit.verify.ref'], verify ? r.tip() : undefined);
    assert.deepEqual(seen.reads.slice(-2), ['ls-refs', 'fetch']);
  }
});

test('editFile with verify: the same landed push is ok, not ambiguous', async () => {
  const r = repo();
  const ex = arrayExporter();
  const { seen, fetchImpl } = fault({ apply: true, then: carol(r) });
  const res = await editFile(r.url, { ref: MAIN, path: 'ledger.txt', find: 'base\n', replace: 'base\nbob\n', author: who('bob'), message: 'bob appends' }, { tracer: new Tracer({ exporter: ex }), fetchImpl, verify: true, head: r.base, strictHead: true });
  assert.ok(res.ok, res.ok ? '' : `${res.error.code}: ${res.error.message}`);
  assert.equal(seen.pushes, 1);
  assert.ok(r.isAncestor(res.value.newCommit, r.tip()));
  assert.equal(count(r, 'bob appends'), 1);
  assert.equal(rootSpan(ex, 'git.edit').attrs['git.edit.verify.ref'], r.tip());
});

test('commitChanges: a lost race is cas_conflict pinned and redone once unpinned; either way the change lands once', async () => {
  // unpinned: commitChanges follows `fresh` itself
  const u = repo();
  const f = fault({ apply: false, then: carol(u) });
  const res = await commitChanges(u.url, BOB, { fetchImpl: f.fetchImpl });
  assert.ok(res.ok, res.ok ? '' : `${res.error.code}: ${res.error.message}`);
  assert.equal(f.seen.pushes, 2);
  assert.equal(res.value.oid, u.tip());
  assert.equal(count(u, 'bob appends'), 1);
  // pinned: the caller is told, and follows `fresh` (re-resolve, apply on the new tip)
  const p = repo();
  const g = fault({ apply: false, then: carol(p) });
  const lost = await commitChanges(p.url, BOB, { fetchImpl: g.fetchImpl, head: p.base });
  assert.equal(lost.ok, false);
  assert.deepEqual([lost.error.code, RETRY[lost.error.code], lost.error.expected, lost.error.actual], ['cas_conflict', 'fresh', p.base, p.tip()]);
  assert.equal(count(p, 'bob appends'), 0, 'cas_conflict: the change is not in the ref');
  const again = await commitChanges(p.url, BOB, { head: p.tip() });
  assert.ok(again.ok);
  assert.equal(count(p, 'bob appends'), 1);
});

test('commitChanges: an unmoved ref is ambiguous; reading the ref back and applying on it lands the change once', async () => {
  for (const apply of [false, true]) {
    const r = repo();
    // apply: the push lands and the answer is lost (the tip is the commit: ok). Not applied: the ref has not moved
    const f = fault({ apply });
    const res = await commitChanges(r.url, BOB, { fetchImpl: f.fetchImpl, head: r.base });
    assert.equal(f.seen.pushes, 1);
    if (apply) { assert.ok(res.ok); assert.equal(res.value.oid, r.tip()); }
    else {
      assert.deepEqual([res.ok, res.error.code, RETRY[res.error.code]], [false, 'ambiguous', 'read']);
      // `read`: the ref is still the head the change was made on, so it did not land; it is applied on that head
      const now = unwrap(await lsRefs(unwrap(createTransport(r.url, {})), [MAIN])).refs.get(MAIN).oid;
      assert.equal(now, r.base);
      assert.ok((await commitChanges(r.url, BOB, { head: now })).ok);
    }
    assert.equal(count(r, 'bob appends'), 1);
  }
});

test('verifyPushed: a read-back push already made is the verification, and nothing is requested', async () => {
  const attrs = {};
  const t = { get limits() { throw new Error('no request may be made'); } };
  const seen = await verifyPushed(t, { set: a => Object.assign(attrs, a) }, { prefix: 'git.x', ref: MAIN, expected: 'a'.repeat(40) }, 'b'.repeat(40));
  assert.deepEqual([seen, attrs], [{ ok: true, value: 'b'.repeat(40) }, { 'git.x.verify.ref': 'b'.repeat(40) }]);
});
