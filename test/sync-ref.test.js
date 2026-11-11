// syncRef (#122): one ref mirrored from a source remote to a destination, both `git http-backend` bare repositories
// (the default fixture and a stock one: upload-pack at git's defaults). git builds the histories and judges:
//   - after every sync `git rev-parse <dstRef>` on the destination is the source's tip and `git fsck --strict` is clean;
//   - the pack ply sent (captured from the receive-pack request) is self-contained (git index-pack without --fix-thin
//     takes it) and its object set is exactly `git rev-list --objects <new> --not <old dst tip>` on the source: nothing
//     reachable from the destination's old tip is sent again;
//   - in_sync sends no fetch and no receive-pack; a refused non-fast-forward sends no receive-pack;
//   - a destination moved between ls-refs and receive-pack is cas_conflict naming the tip git holds.
import { readBody } from './body.js';
import { test, describe, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { git, tmpRoot, makeBareRepo, startGitServer, startAuthGate, fsckProblems, initRepo } from './server.js';
import * as ply from '../src/index.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';

const { syncRef } = ply;
const ZERO = '0'.repeat(40);
let root, cleanup, srv, n = 0;
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv.close(); cleanup(); });

const ID = ['-c', 'user.name=Mirror', '-c', 'user.email=mirror@example.com'];
const rev = (dir, r) => git(dir, ['rev-parse', '--verify', '-q', r]).trim();
const has = (dir, r) => spawnSync('git', ['rev-parse', '--verify', '-q', r], { cwd: dir }).status === 0;
const objectsOf = (dir, args) => new Set(git(dir, ['rev-list', '--objects', ...args]).trim().split('\n').filter(Boolean).map(l => l.slice(0, 40)));
const clean = bare => assert.deepEqual(fsckProblems(bare), [], 'git fsck --strict on the destination');
const errOf = r => { assert.equal(r.ok, false, 'expected an Err'); return r.error; };
const okOf = r => { assert.equal(r.ok, true, r.ok ? '' : `${r.error.code}: ${r.error.message}`); return r.value; };

// Per-side request log: every POST body's command (ls-refs / fetch / receive-pack) and every pack pushed.
function side(before = () => {}) {
  const log = { commands: [], packs: [] };
  const fetchImpl = async (url, given) => {
    const kind = String(url).split('/').pop();
    // a pack past INFLATE_CHUNK is a streamed body (src/packwrite.ts): read once, forwarded as its bytes
    const { bytes: body, init } = await readBody(given);
    if (init?.method === 'POST') {
      if (kind === 'git-receive-pack') {
        log.commands.push('receive-pack');
        const at = body.indexOf('0000PACK');
        log.packs.push(at < 0 ? null : body.subarray(at + 4));
        before();
      } else log.commands.push(/command=fetch/.test(body.toString('latin1')) ? 'fetch' : 'ls-refs');
    }
    return fetch(url, init);
  };
  return { log, fetchImpl };
}
// The pack's object ids as git reads it: index-pack (no --fix-thin: a thin pack is refused) in a fresh repository.
function packOids(pack) {
  const dir = mkdtempSync(join(root, 'ip-'));
  git(dir, ['init', '-q', '--bare']);
  const out = execFileSync('git', ['index-pack', '--stdin', '-v'], { cwd: dir, input: pack, stdio: ['pipe', 'pipe', 'pipe'] });
  const idx = join(dir, 'objects', 'pack', `pack-${out.toString().trim().split(/\s+/).pop()}.idx`);
  const rows = git(dir, ['verify-pack', '-v', idx]).trim().split('\n').filter(l => /^[0-9a-f]{40} /.test(l));
  return { oids: new Set(rows.map(l => l.slice(0, 40))), deltas: rows.filter(l => l.split(/\s+/).length >= 7).length };
}

// A source and a destination on the same server, and a work repository that pushes to the source.
function pair(stock) {
  const id = n++;
  const src = makeBareRepo(root, `src${id}`, { stock });
  const dst = makeBareRepo(root, `dst${id}`, { stock });
  const work = join(root, `work${id}`);
  initRepo(work);
  return { src, dst, work, srcUrl: `${srv.url}/src${id}.git`, dstUrl: `${srv.url}/dst${id}.git` };
}
const body = (seed, count) => Array.from({ length: count }, (_, i) => `export const v${i} = ${(i * 2654435761 + seed) >>> 0};`);
// A commit in `work` that edits one line of a 200-line file (so packs carry deltas) and adds a file.
function commit(work, i, msg = `c${i}`) {
  const lines = body(1, 200);
  lines[(i * 37) % lines.length] = `// edited in ${i}`;
  writeFileSync(join(work, 'main.js'), `${lines.join('\n')}\n`);
  writeFileSync(join(work, `f${i}.txt`), `file ${i}\n`);
  git(work, ['add', '-A']);
  git(work, [...ID, 'commit', '-q', '-m', msg]);
  return rev(work, 'HEAD');
}
const pushTo = (work, bare, spec) => git(work, ['push', '-q', '-f', bare, spec]);
// What the pack must hold: everything reachable from `to` that `from` does not reach (all of it for a create).
const needed = (src, to, from) => objectsOf(src, [to, ...(from === null ? [] : ['--not', from])]);
// After a sync that pushed: dst ref is the source tip, fsck is clean, one receive-pack whose pack is exactly `needed`
// and disjoint from everything the destination's old tip reaches.
function judgePush(p, log, { ref = 'refs/heads/main', dstRef = ref, to, from }) {
  assert.equal(rev(p.dst, dstRef), to, 'git rev-parse on the destination is the source tip');
  clean(p.dst);
  assert.equal(log.packs.length, 1, 'one receive-pack');
  const { oids, deltas } = packOids(log.packs[0]);
  assert.deepEqual([...oids].sort(), [...needed(p.src, to, from)].sort(), 'the pack is rev-list --objects new --not old');
  if (from !== null) for (const o of objectsOf(p.src, [from])) assert.equal(oids.has(o), false, `${o} is reachable from the old tip and was sent again`);
  return { oids, deltas };
}

for (const stock of [false, true]) describe(stock ? 'stock upload-pack' : 'default fixture', () => {
  test('create, incremental update, then in_sync (no fetch, no push)', async () => {
    const p = pair(stock);
    for (let i = 1; i <= 4; i++) commit(p.work, i);
    pushTo(p.work, p.src, 'HEAD:refs/heads/main');
    const c4 = rev(p.work, 'HEAD');
    const s = side();
    const created = okOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'refs/heads/main' }, { dst: { fetchImpl: s.fetchImpl } }));
    assert.equal(created.outcome, 'created');
    assert.equal(created.from, null);
    assert.equal(created.to, c4);
    assert.equal(created.forced, false);
    const first = judgePush(p, s.log, { to: c4, from: null });
    assert.equal(created.objects, first.oids.size);
    assert.ok(first.deltas > 0, 'the source\'s deltas are forwarded');
    assert.equal(created.pushBytes, s.log.packs[0].length);

    for (let i = 5; i <= 7; i++) commit(p.work, i);
    pushTo(p.work, p.src, 'HEAD:refs/heads/main');
    const c7 = rev(p.work, 'HEAD');
    const s2 = side();
    const src2 = side();
    const updated = okOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'refs/heads/main' }, { src: { fetchImpl: src2.fetchImpl }, dst: { fetchImpl: s2.fetchImpl } }));
    assert.deepEqual({ outcome: updated.outcome, from: updated.from, to: updated.to, forced: updated.forced }, { outcome: 'updated', from: c4, to: c7, forced: false });
    const inc = judgePush(p, s2.log, { to: c7, from: c4 });
    assert.equal(updated.objects, inc.oids.size);
    assert.ok(inc.oids.size < first.oids.size + 12, 'incremental: only the three new commits, their trees and blobs');
    assert.deepEqual(src2.log.commands, ['ls-refs', 'fetch'], 'source: one ls-refs, one fetch');
    assert.deepEqual(s2.log.commands, ['ls-refs', 'receive-pack'], 'destination: one ls-refs, one receive-pack');

    const s3 = side();
    const src3 = side();
    const same = okOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'refs/heads/main' }, { src: { fetchImpl: src3.fetchImpl }, dst: { fetchImpl: s3.fetchImpl } }));
    assert.deepEqual(same, { outcome: 'in_sync', ref: 'refs/heads/main', dstRef: 'refs/heads/main', oid: c7 });
    assert.deepEqual(src3.log.commands, ['ls-refs'], 'in_sync: no fetch');
    assert.deepEqual(s3.log.commands, ['ls-refs'], 'in_sync: no receive-pack');
  });

  test('a rewritten source: not_fast_forward with nothing pushed, then force follows it (only what dst lacks)', async () => {
    const p = pair(stock);
    for (let i = 1; i <= 3; i++) commit(p.work, i);
    pushTo(p.work, p.src, 'HEAD:refs/heads/main');
    okOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'refs/heads/main' }));
    const old = rev(p.dst, 'refs/heads/main');
    git(p.work, ['reset', '-q', '--hard', 'HEAD~1']);
    commit(p.work, 9, 'rewritten');
    pushTo(p.work, p.src, 'HEAD:refs/heads/main');
    const rewritten = rev(p.work, 'HEAD');
    const s = side();
    const refused = errOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'refs/heads/main' }, { dst: { fetchImpl: s.fetchImpl } }));
    assert.equal(refused.code, 'not_fast_forward', refused.message);
    assert.deepEqual(refused.got, ['refs/heads/main']);
    assert.deepEqual(s.log.commands, ['ls-refs'], 'nothing pushed');
    assert.equal(rev(p.dst, 'refs/heads/main'), old, 'untouched');
    const s2 = side();
    const forced = okOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'refs/heads/main', force: true }, { dst: { fetchImpl: s2.fetchImpl } }));
    assert.deepEqual({ outcome: forced.outcome, from: forced.from, to: forced.to, forced: forced.forced }, { outcome: 'updated', from: old, to: rewritten, forced: true });
    judgePush(p, s2.log, { to: rewritten, from: old });
  });

  test('a destination ahead of the source is not a fast-forward; forced, it rewinds with an empty pack (the source knows the tip)', async () => {
    const p = pair(stock);
    for (let i = 1; i <= 2; i++) commit(p.work, i);
    pushTo(p.work, p.src, 'HEAD:refs/heads/main');
    const tip = rev(p.work, 'HEAD');
    commit(p.work, 3);
    pushTo(p.work, p.dst, 'HEAD:refs/heads/main');
    pushTo(p.work, p.src, 'HEAD:refs/heads/ahead');  // the source has the commit (on another branch): it ACKs the have
    const ahead = rev(p.work, 'HEAD');
    assert.equal(errOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'refs/heads/main' })).code, 'not_fast_forward');
    const s = side();
    const r = okOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'refs/heads/main', force: true }, { dst: { fetchImpl: s.fetchImpl } }));
    assert.deepEqual({ outcome: r.outcome, from: r.from, to: r.to, forced: r.forced, objects: r.objects }, { outcome: 'updated', from: ahead, to: tip, forced: true, objects: 0 });
    judgePush(p, s.log, { to: tip, from: ahead });
  });

  test('unrelated histories, forced: the source NAKs the unknown have and the whole history goes; dst ends equal', async () => {
    const p = pair(stock);
    commit(p.work, 1);
    pushTo(p.work, p.src, 'HEAD:refs/heads/main');
    const tip = rev(p.work, 'HEAD');
    const other = join(root, `other${n++}`);
    initRepo(other);
    commit(other, 50, 'unrelated');
    pushTo(other, p.dst, 'HEAD:refs/heads/main');
    const theirs = rev(other, 'HEAD');
    assert.equal(errOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'refs/heads/main' })).code, 'not_fast_forward');
    const s = side();
    const r = okOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'refs/heads/main', force: true }, { dst: { fetchImpl: s.fetchImpl } }));
    assert.equal(r.from, theirs);
    assert.equal(rev(p.dst, 'refs/heads/main'), tip);
    clean(p.dst);
    assert.deepEqual([...packOids(s.log.packs[0]).oids].sort(), [...objectsOf(p.src, [tip])].sort(), 'everything reachable from the source tip');
  });

  test('a lost race (dst moved between ls-refs and receive-pack) is cas_conflict naming the tip git holds', async () => {
    const p = pair(stock);
    commit(p.work, 1);
    pushTo(p.work, p.src, 'HEAD:refs/heads/main');
    okOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'refs/heads/main' }));
    const old = rev(p.dst, 'refs/heads/main');
    commit(p.work, 2);
    pushTo(p.work, p.dst, 'HEAD:refs/heads/side');
    const winner = rev(p.work, 'HEAD');
    git(p.work, ['reset', '-q', '--hard', 'HEAD~1']);
    commit(p.work, 3);
    pushTo(p.work, p.src, 'HEAD:refs/heads/main');
    const racing = side(() => git(p.dst, ['update-ref', 'refs/heads/main', winner]));
    const lost = errOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'refs/heads/main' }, { dst: { fetchImpl: racing.fetchImpl } }));
    assert.equal(lost.code, 'cas_conflict', lost.message);
    assert.equal(lost.expected, old, 'the tip ls-refs read');
    assert.equal(lost.actual, winner, 'the tip the winner left, read back');
    assert.equal(rev(p.dst, 'refs/heads/main'), winner, 'not clobbered');
    // a create that loses: the ref appears between ls-refs and receive-pack
    const createRace = side(() => git(p.dst, ['update-ref', 'refs/heads/new', winner]));
    const lostCreate = errOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'refs/heads/main', dstRef: 'refs/heads/new' }, { dst: { fetchImpl: createRace.fetchImpl } }));
    assert.equal(lostCreate.code, 'cas_conflict', lostCreate.message);
    assert.equal(lostCreate.expected, ZERO);
    assert.equal(lostCreate.actual, winner);
    // deleted by the winner: actual null
    const delRace = side(() => git(p.dst, ['update-ref', '-d', 'refs/heads/main']));
    const gone = errOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'refs/heads/main', force: true }, { dst: { fetchImpl: delRace.fetchImpl } }));
    assert.equal(gone.code, 'cas_conflict', gone.message);
    assert.equal(gone.expected, winner);
    assert.equal(gone.actual, null);
    assert.equal(has(p.dst, 'refs/heads/main'), false);
  });
});

describe('refs, options and refusals', () => {
  test('dstRef, an annotated tag (created, then a moved tag refused unless forced), verify', async () => {
    const p = pair(false);
    commit(p.work, 1);
    git(p.work, [...ID, 'tag', '-a', '-m', 'one', 'v1']);
    pushTo(p.work, p.src, 'HEAD:refs/heads/main');
    pushTo(p.work, p.src, 'refs/tags/v1');
    const tracer = (() => { const ex = arrayExporter(); return { tracer: new Tracer({ exporter: ex }), spans: () => ex.lines.flatMap(flattenLine) }; })();
    const mirrored = okOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'refs/heads/main', dstRef: 'refs/heads/mirror' }, { verify: true, tracer: tracer.tracer }));
    assert.equal(mirrored.dstRef, 'refs/heads/mirror');
    assert.equal(rev(p.dst, 'refs/heads/mirror'), rev(p.src, 'refs/heads/main'));
    assert.equal(has(p.dst, 'refs/heads/main'), false);
    const rootSpan = tracer.spans().find(s => s.name === 'git.sync_ref');
    assert.equal(rootSpan.attrs['git.sync_ref.outcome'], 'created');
    assert.equal(rootSpan.attrs['git.sync_ref.verify.ref'], mirrored.to);
    const tag = okOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'refs/tags/v1' }));
    assert.equal(tag.outcome, 'created');
    assert.equal(rev(p.dst, 'refs/tags/v1'), rev(p.src, 'refs/tags/v1'));
    assert.equal(git(p.dst, ['cat-file', '-t', 'refs/tags/v1']).trim(), 'tag');
    clean(p.dst);
    commit(p.work, 2);
    git(p.work, [...ID, 'tag', '-f', '-a', '-m', 'one again', 'v1']);
    pushTo(p.work, p.src, 'refs/tags/v1');
    const moved = errOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'refs/tags/v1' }));
    assert.equal(moved.code, 'not_fast_forward', moved.message);
    assert.match(moved.message, /tag already exists/);
    const s = side();
    const forced = okOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'refs/tags/v1', force: true }, { dst: { fetchImpl: s.fetchImpl } }));
    assert.equal(forced.forced, true);
    judgePush(p, s.log, { ref: 'refs/tags/v1', to: rev(p.src, 'refs/tags/v1'), from: tag.to });
  });

  test('each side its own credential: the destination behind a gate sees only its token, the root span neither', async () => {
    const p = pair(false);
    commit(p.work, 1);
    pushTo(p.work, p.src, 'HEAD:refs/heads/main');
    const dstToken = 'dst-secret-token';
    const srcToken = 'src-secret-token';
    const gate = await startAuthGate(srv.url, a => a === `Basic ${Buffer.from(`x-access-token:${dstToken}`).toString('base64')}`);
    try {
      const gatedDst = `${gate.url}/${p.dstUrl.split('/').pop()}`;
      const ex = arrayExporter();
      // without the destination's credential the gate refuses: the source's token is not sent there
      const denied = errOf(await syncRef(p.srcUrl, gatedDst, { ref: 'refs/heads/main' }, { src: { auth: { token: srcToken } }, tracer: new Tracer({ exporter: ex }) }));
      assert.equal(denied.code, 'auth');
      assert.ok(gate.seen.every(s => s.authorization === null), 'the source credential never reaches the destination');
      const r = okOf(await syncRef(p.srcUrl, gatedDst, { ref: 'refs/heads/main' }, { src: { auth: { token: srcToken } }, dst: { auth: { token: dstToken } }, tracer: new Tracer({ exporter: ex }) }));
      assert.equal(r.outcome, 'created');
      assert.equal(rev(p.dst, 'refs/heads/main'), rev(p.src, 'refs/heads/main'));
      const exported = JSON.stringify(ex.lines);
      assert.equal(exported.includes(dstToken), false, 'the destination token is scrubbed');
      assert.equal(exported.includes(srcToken), false, 'the source token is scrubbed');
    } finally { await gate.close(); }
  });

  test('refusals before anything is sent: bad refs, force not boolean, top-level auth; a missing source ref is not_found', async () => {
    const p = pair(false);
    commit(p.work, 1);
    pushTo(p.work, p.src, 'HEAD:refs/heads/main');
    const s = side();
    const o = { src: { fetchImpl: s.fetchImpl }, dst: { fetchImpl: s.fetchImpl } };
    assert.equal(errOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'main' }, o)).code, 'bad_request');
    assert.equal(errOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'refs/heads/main', dstRef: 'refs/heads/a..b' }, o)).code, 'bad_request');
    const force = errOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'refs/heads/main', force: 'yes' }, o));
    assert.equal(force.what, 'force');
    const auth = errOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'refs/heads/main' }, { ...o, auth: { token: 't' } }));
    assert.deepEqual([auth.code, auth.what], ['bad_request', 'auth']);
    assert.deepEqual(s.log.commands, [], 'nothing sent');
    const missing = errOf(await syncRef(p.srcUrl, p.dstUrl, { ref: 'refs/heads/nope' }, o));
    assert.equal(missing.code, 'not_found');
    assert.deepEqual(missing.miss, { kind: 'ref', ref: 'refs/heads/nope', candidates: ['refs/heads/nope'] });
    assert.equal(has(p.dst, 'refs/heads/nope'), false);
    // a destination that is not a repository: its ls-refs error, nothing pushed
    assert.equal(errOf(await syncRef(p.srcUrl, `${srv.url}/absent-repo.git`, { ref: 'refs/heads/main' })).code, 'not_found');
    // the caller's own transports, one per side
    const srcT = ply.createTransport(p.srcUrl);
    const dstT = ply.createTransport(p.dstUrl);
    const viaTransport = okOf(await syncRef('ignored', 'ignored', { ref: 'refs/heads/main' }, { src: { transport: srcT.value }, dst: { transport: dstT.value } }));
    assert.equal(viaTransport.outcome, 'created');
    assert.equal(rev(p.dst, 'refs/heads/main'), rev(p.src, 'refs/heads/main'));
  });

  test('the README example runs as written', async () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const [, code] = readme.match(/```js\n\/\/ sync-ref example\n([\s\S]*?)```/);
    const p = pair(true);
    commit(p.work, 1);
    pushTo(p.work, p.src, 'HEAD:refs/heads/main');
    const printed = [];
    const quiet = { log: (...a) => printed.push(a) };
    const AsyncFunction = (async () => {}).constructor;
    const run = new AsyncFunction('syncRef', 'srcUrl', 'dstUrl', 'process', 'console', code.replace(/^import .*\n/m, ''));
    const env = { env: { SRC_TOKEN: 'read-token', DST_TOKEN: 'write-token' } };  // http-backend ignores them
    await run(syncRef, p.srcUrl, p.dstUrl, env, quiet);
    assert.equal(printed[0][0], 'created');
    assert.equal(rev(p.dst, 'refs/heads/main'), rev(p.src, 'refs/heads/main'));
    await run(syncRef, p.srcUrl, p.dstUrl, env, quiet);
    assert.deepEqual(printed[1], ['in sync at', rev(p.src, 'refs/heads/main')]);
    clean(p.dst);
  });
});
