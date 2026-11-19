// Safe recovery from a concurrent writer and from a push whose answer was lost: a consumer recipe, run against
// `git http-backend` on localhost with every race and fault injected deterministically. No account, no network.
// usage: node examples/recover-push.mjs        (needs `git` on PATH: it is the server and the judge, never the client)
//
// The change is a read-modify-write: read ledger.txt at the tip, append one line, commit. Done twice it shows (the line
// is there twice), which is what a blind retry does.
//
// What ply guarantees, and what it leaves to the caller (src/changes.ts, src/edit.ts, src/tree.ts, src/push.ts):
//
// - PINNED: the caller names the tip its change was computed from. `commitChanges(…, { head })`, `editFile` / `pushTree`
//   / `pushDir` with `{ head, strictHead: true }`, `deleteBranch` / `deleteTag` with `expected`, and `push` with its
//   `oldOid`. The ref moves only from that tip. A ref that is elsewhere is `cas_conflict` (`error.actual` is the tip
//   that won) and ply does NOT redo it: the caller reads again and decides.
// - UNPINNED: no `head`. `commitChanges`, `editFile` and `pushTree` take whatever the tip is, and when their push loses
//   to another writer they read the ref again and redo the commit ONCE on the new tip, by themselves. For an `edit`
//   (find/replace) the change is applied again to the new content. For a `write` (or `pushTree`) the caller's bytes
//   replace the winner's: last writer wins, and the call answers ok. Case 1b shows it. A change computed from a read
//   must be pinned to the commit that read came from.
// - `ambiguous`: the push request was handed to the transport and no answer exactly as git's receive-pack writes it
//   came back. The ref may have moved or not. ply never sends such a push again in `commitChanges`, `editFile`,
//   `pushTree`: it is returned (RETRY.ambiguous is 'read': read the ref before anything else). The error does not
//   carry the id of the commit that was pushed, so the caller needs its own way to recognise its commit: here an
//   `Operation-Id:` trailer in the message plus the pinned parent.
//
// The recipe is `applyOnce` below, for one commit on one ref made by a pinned operation. Its limits are `settle`'s:
// it answers "is my commit in the ref's history now", from the ref's first-parent history. It says `unknown`, and
// sends nothing more, when that history cannot answer: the pinned commit is no longer in it (the ref was rewritten, or
// it is deeper than the window read), or a merge commit sits above the pin (a commit that landed and was then merged
// in as a second parent is not on the first-parent line). And "not landed" is only as final as the request is dead: a
// push still in flight on the server can land after the read. That is why every retry here is pinned too, and why
// the history is read again before each one.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { commitChanges, readFile, readLog, Tracer } from 'ply';
import { startGitServer, makeBareRepo, tmpRoot, initRepo, commitFiles, git, gitBuf, fsckProblems } from '../test/server.js';
import { startProxy } from '../test/proxy.js';

const REF = 'refs/heads/main', FILE = 'ledger.txt', SEED = 'opening balance\n';
const trailer = id => `Operation-Id: ${id}`;

// ---------------------------------------------------------------- the recipe ----------------------------------------

// One pinned attempt: read the file, append, commit on exactly the commit that was read.
async function attempt(url, op, opts) {
  const file = await readFile(url, { ref: REF, path: FILE }, opts);
  if (!file.ok) return { pinned: null, result: file };
  const before = Buffer.from(await new Response(file.value.stream).arrayBuffer());
  const pinned = file.value.commit;
  const result = await commitChanges(url, {
    ref: REF, author: op.author, time: op.time, message: `${op.summary}\n\n${trailer(op.id)}\n`,
    changes: [{ kind: 'write', path: FILE, content: Buffer.concat([before, Buffer.from(op.line)]) }],
  }, { ...opts, head: pinned });
  return { pinned, result };
}

// After an `ambiguous` push: is the commit of operation `id` in the ref's history? `pins` are the tips this operation's
// attempts were pinned to, oldest first. A pinned push lands only as a commit whose one parent is its pin.
//   landed      the commit is in the history (`commit`), wherever the tip is now
//   not_landed  the first-parent line from the tip down to the first pin is all single-parent commits, none of them ours
//   unknown     that history cannot answer (`why`); nothing may be concluded and nothing may be sent
async function settle(url, { id, pins }, opts, limit = 50) {
  const log = await readLog(url, { ref: REF, limit }, opts);
  if (!log.ok) return { state: 'unknown', why: `the ref could not be read (${log.error.code})` };
  const { commits, truncated, oid: tip } = log.value;
  const at = commits.findIndex(c => c.oid === pins[0]);
  const above = at < 0 ? commits : commits.slice(0, at);
  const mine = above.find(c => c.parents.length === 1 && pins.includes(c.parents[0]) && c.message.split('\n').includes(trailer(id)));
  if (mine) return { state: 'landed', commit: mine.oid, tip };
  if (at < 0) return { state: 'unknown', tip, why: truncated ? `the pinned commit is not within ${limit} first-parent commits of the tip` : 'the pinned commit is not in the ref\'s first-parent history: the ref was rewritten' };
  if (above.some(c => c.parents.length > 1)) return { state: 'unknown', tip, why: 'a merge commit is above the pinned commit: what it merged in is not on the first-parent line' };
  return { state: 'not_landed', tip };
}

// Apply `op` exactly once. `trail` is every typed outcome on the way, `errors` the PlyError behind each failed attempt.
//   cas_conflict  definite: the ref is elsewhere and does not hold our commit. Read again, apply to the new tip, pin
//                 to it.
//   ambiguous     unknown: from then on the history is read (`settle`) before every further attempt.
//   anything else is returned as it is.
export async function applyOnce(url, op, opts = {}, maxAttempts = 3) {
  const pins = [], trail = [], errors = [];
  let unconfirmed = false;
  for (let n = 0; ; n++) {
    if (unconfirmed) {
      const seen = await settle(url, { id: op.id, pins }, opts);
      trail.push(`settle:${seen.state}`);
      if (seen.state !== 'not_landed') return { ...seen, pins, trail, errors };
    }
    if (n === maxAttempts) return { state: unconfirmed ? 'not_landed' : 'conflict', pins, trail, errors };
    const { pinned, result } = await attempt(url, op, opts);
    if (pinned !== null) pins.push(pinned);
    if (result.ok) return { state: 'landed', commit: result.value.oid, tip: result.value.oid, pins, trail: [...trail, 'ok'], errors };
    trail.push(result.error.code); errors.push(result.error);
    switch (result.error.code) {
      case 'cas_conflict': break;
      case 'ambiguous': unconfirmed = true; break;
      default: return { state: 'failed', pins, trail, errors };
    }
  }
}

// ---------------------------------------------------------------- the cases -----------------------------------------

const { root, cleanup } = tmpRoot();
const srv = await startGitServer(root);
const closers = [() => srv.close()];
let n = 0;

const op = who => ({ id: `op-${who}`, line: `${who}: +1\n`, summary: `${who} appends`, author: { name: who, email: `${who}@example.com` }, time: 1_700_000_000 });
const isReceivePack = input => String(input).endsWith('/git-receive-pack');

// A fresh remote with one commit, and git as the judge of it.
function remote() {
  const name = `ledger${n++}`, bare = makeBareRepo(root, name);
  const seed = commitFiles(initRepo(join(root, `${name}-seed`)), bare, { [FILE]: SEED });
  const rev = r => git(bare, ['rev-parse', '--verify', r]).trim();
  return {
    bare, seed, url: `${srv.url}/${name}.git`, rev,
    bytes: () => gitBuf(bare, ['cat-file', 'blob', `${REF}:${FILE}`]).toString(),
    // the ref's whole history above the seed, newest first, each commit with its parents: `git rev-list --parents`
    history: () => git(bare, ['rev-list', '--parents', `${seed}..${REF}`]).trim().split('\n').filter(Boolean).map(l => l.split(' ')),
    isAncestor: (a, b) => { try { git(bare, ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } },
    opCommits: id => git(bare, ['rev-list', '--all', '-F', `--grep=${trailer(id)}`]).trim().split('\n').filter(Boolean),
    sound: () => assert.deepEqual(fsckProblems(bare), [], 'git fsck --strict'),
    isCommit: oid => assert.equal(git(bare, ['cat-file', '-t', oid]).trim(), 'commit'),
  };
}
// The remote behind test/proxy.js. `drop`: the first receive-pack reaches the server, which answers; the client's
// connection is destroyed before a byte of that answer. `unsent`: the first receive-pack never reaches the server.
async function faulty(r, kind) {
  const proxy = await startProxy(srv.url, ctx => {
    if (ctx.stage !== 'receive-pack' || ctx.n !== 0) return { type: 'pass' };
    if (kind === 'drop') return ctx.phase === 'request' ? null : { type: 'drop', after: 0 };
    return ctx.phase === 'request' ? { type: 'bytes', noForward: true, bytes: new Uint8Array(0) } : { type: 'pass' };
  });
  closers.push(() => proxy.close());
  return { url: r.url.replace(srv.url, proxy.url), pushes: () => proxy.counts['receive-pack'] ?? 0 };
}
const opts = (extra = {}) => ({ tracer: new Tracer(), ...extra });
const once = (line, text) => assert.equal(text.split(line).length - 1, 1, `${JSON.stringify(line)} is in the file exactly once`);
const say = (name, r, what) => console.log(`${name}: ${what}\n   outcomes: ${r.trail.join(' -> ')}; state: ${r.state}`);

try {
  // 1. Two writers read the same tip and pin to it. The winner's push is made to land between the loser's read and
  //    the loser's receive-pack (a gate in the loser's fetch, so the order is fixed, not raced).
  {
    const r = remote(), a = op('alice'), b = op('bob');
    let won = null;
    const gate = async (input, init) => {
      if (isReceivePack(input) && won === null) won = await applyOnce(r.url, a, opts());
      return fetch(input, init);
    };
    const lost = await applyOnce(r.url, b, opts({ fetchImpl: gate }));
    assert.deepEqual(won.trail, ['ok']);
    assert.deepEqual(lost.trail, ['cas_conflict', 'ok'], 'the loser sees one typed conflict, then lands on the new tip');
    assert.deepEqual([lost.errors[0].expected, lost.errors[0].actual], [r.seed, won.commit], 'the conflict names the pinned tip and the tip that won');
    assert.deepEqual(lost.pins, [r.seed, won.commit], 'both read the seed; the loser\'s second attempt is pinned to the winner');
    assert.equal(r.bytes(), SEED + a.line + b.line, 'the winner\'s line is kept and the loser\'s follows it');
    assert.deepEqual(r.history(), [[lost.commit, won.commit], [won.commit, r.seed]]);
    assert.equal(r.rev(REF), lost.commit);
    for (const o of [a, b]) assert.equal(r.opCommits(o.id).length, 1, `${o.id} is one commit`);
    r.isCommit(lost.commit); r.sound();
    say('1  pinned writers', lost, 'the loser re-read and re-applied; both lines kept');
  }

  // 1b. The contrast: the same race with the loser unpinned. ply redoes the lost commit once on the winner's tip by
  //     itself, the caller's stale bytes replace the winner's file, and the call answers ok.
  {
    const r = remote(), a = op('alice'), b = op('bob');
    let won = null;
    const gate = async (input, init) => {
      if (isReceivePack(input) && won === null) won = await applyOnce(r.url, a, opts());
      return fetch(input, init);
    };
    const stale = await commitChanges(r.url, { ref: REF, author: b.author, time: b.time, message: b.summary, changes: [{ kind: 'write', path: FILE, content: SEED + b.line }] }, opts({ fetchImpl: gate }));
    assert.equal(stale.ok, true, 'no conflict is reported');
    assert.equal(stale.value.parent, won.commit, 'the commit was redone on the winner\'s tip');
    assert.equal(r.bytes(), SEED + b.line, 'the winner\'s line is gone from the file');
    assert.deepEqual(r.history(), [[stale.value.oid, won.commit], [won.commit, r.seed]], 'its commit is still in the history');
    r.sound();
    console.log('1b unpinned writer (contrast): ok, redone on the winner\'s tip; the winner\'s line was overwritten');
  }

  // 2. The server applies the push and the answer is lost. The history says the commit landed; nothing is sent again.
  {
    const r = remote(), b = op('bob'), via = await faulty(r, 'drop');
    const done = await applyOnce(via.url, b, opts());
    once(b.line, r.bytes()); assert.equal(r.bytes(), SEED + b.line);
    assert.equal(r.opCommits(b.id).length, 1, 'the operation is one commit');
    assert.deepEqual(done.trail, ['ambiguous', 'settle:landed']);
    assert.equal(via.pushes(), 1, 'one receive-pack request, ever');
    assert.equal(r.rev(REF), done.commit);
    assert.deepEqual(r.history(), [[done.commit, r.seed]], 'one commit, on the pinned tip');
    assert.deepEqual(r.opCommits(b.id), [done.commit]);
    r.isCommit(done.commit); r.sound();
    say('2  answer lost, push landed', done, 'found in the history; not sent again');
  }

  // 2b. The other answer to the same question: the request never reached the server. The history says so, and the
  //     retry (pinned) is the first and only application.
  {
    const r = remote(), b = op('bob'), via = await faulty(r, 'unsent');
    const done = await applyOnce(via.url, b, opts());
    assert.deepEqual(done.trail, ['ambiguous', 'settle:not_landed', 'ok']);
    assert.equal(via.pushes(), 2);
    assert.equal(r.bytes(), SEED + b.line); once(b.line, r.bytes());
    assert.deepEqual(r.history(), [[done.commit, r.seed]]);
    assert.deepEqual(r.opCommits(b.id), [done.commit]);
    r.sound();
    say('2b answer lost, push did not land', done, 'absent from the history; applied once by the pinned retry');
  }

  // 3. As 2, and another writer moves the ref before the caller looks. The tip is not the caller's commit, yet the push
  //    landed: the commit is an ancestor of the tip. (The gate: the first request after the receive-pack waits for carol.)
  {
    const r = remote(), b = op('bob'), c = op('carol'), via = await faulty(r, 'drop');
    let pushed = false, after = null;
    const gate = async (input, init) => {
      if (pushed && after === null) after = await applyOnce(r.url, c, opts());
      if (isReceivePack(input)) pushed = true;
      return fetch(input, init);
    };
    const done = await applyOnce(via.url, b, opts({ fetchImpl: gate }));
    once(b.line, r.bytes()); once(c.line, r.bytes());
    assert.equal(r.opCommits(b.id).length, 1, 'the operation is one commit');
    assert.deepEqual(after.trail, ['ok']);
    assert.deepEqual(done.trail, ['ambiguous', 'settle:landed']);
    assert.equal(via.pushes(), 1, 'one receive-pack request, ever');
    assert.notEqual(r.rev(REF), done.commit, 'the tip is not the commit that was pushed');
    assert.equal(r.rev(REF), after.commit);
    assert.equal(done.tip, after.commit);
    assert.ok(r.isAncestor(done.commit, r.rev(REF)), 'git: the pushed commit is an ancestor of the tip');
    assert.deepEqual(r.history(), [[after.commit, done.commit], [done.commit, r.seed]]);
    assert.equal(r.bytes(), SEED + b.line + c.line);
    assert.deepEqual(r.opCommits(b.id), [done.commit]);
    r.isCommit(done.commit); r.sound();
    say('3  answer lost, push landed, ref moved on', done, 'tip is another writer\'s commit; ours is its ancestor; not sent again');
  }

  // 3b. A limit: after the lost answer the ref is rewritten to a history without the pinned commit. Whether the push
  //     landed cannot be read from the ref any more. That is said, and nothing is sent.
  {
    const r = remote(), b = op('bob'), via = await faulty(r, 'drop');
    let pushed = false, orphan = null;
    const gate = async (input, init) => {
      if (pushed && orphan === null) {
        orphan = git(r.bare, ['commit-tree', `${r.seed}^{tree}`, '-m', 'rewritten'], { env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@example.com', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@example.com' } }).trim();
        git(r.bare, ['update-ref', REF, orphan]);
      }
      if (isReceivePack(input)) pushed = true;
      return fetch(input, init);
    };
    const done = await applyOnce(via.url, b, opts({ fetchImpl: gate }));
    assert.deepEqual(done.trail, ['ambiguous', 'settle:unknown']);
    assert.equal(done.state, 'unknown'); assert.match(done.why, /rewritten/);
    assert.equal(via.pushes(), 1, 'nothing was sent after the unknown');
    assert.equal(r.rev(REF), orphan, 'the ref is as the rewrite left it');
    assert.equal(r.bytes(), SEED);
    r.sound();
    say('3b answer lost, ref rewritten', done, `cannot be established (${done.why}); surfaced, not retried`);
  }

  // 3c. The other limit: the push landed and was then merged in as a second parent. The commit is reachable from the
  //     tip (git says so), but it is not on the first-parent line `settle` reads, and the merge above the pin is how
  //     `settle` knows it cannot tell. It must not say not_landed: a retry would apply the line twice.
  {
    const r = remote(), b = op('bob'), via = await faulty(r, 'drop');
    const env = { ...process.env, GIT_AUTHOR_NAME: 'dave', GIT_AUTHOR_EMAIL: 'dave@example.com', GIT_COMMITTER_NAME: 'dave', GIT_COMMITTER_EMAIL: 'dave@example.com' };
    let pushed = false, merge = null, landed = null;
    const gate = async (input, init) => {
      if (pushed && merge === null) {
        landed = r.rev(REF);
        const side = git(r.bare, ['commit-tree', `${r.seed}^{tree}`, '-p', r.seed, '-m', 'dave\'s own work'], { env }).trim();
        merge = git(r.bare, ['commit-tree', `${landed}^{tree}`, '-p', side, '-p', landed, '-m', 'merge main'], { env }).trim();
        git(r.bare, ['update-ref', REF, merge]);
      }
      if (isReceivePack(input)) pushed = true;
      return fetch(input, init);
    };
    const done = await applyOnce(via.url, b, opts({ fetchImpl: gate }));
    once(b.line, r.bytes());
    assert.deepEqual(done.trail, ['ambiguous', 'settle:unknown']);
    assert.match(done.why, /merge commit/);
    assert.equal(via.pushes(), 1, 'nothing was sent after the unknown');
    assert.deepEqual(r.opCommits(b.id), [landed], 'git: the push had landed');
    assert.ok(r.isAncestor(landed, r.rev(REF)), 'git: and it is reachable from the tip, through the merge\'s second parent');
    assert.equal(r.bytes(), SEED + b.line);
    r.sound();
    say('3c answer lost, push landed, merged in as a second parent', done, `cannot be established (${done.why}); surfaced, not retried`);
  }
  console.log('all cases hold');
} finally {
  for (const close of closers.reverse()) await close();
  cleanup();
}
