// pushRepo (ply/repo-node): a local repository, with its history, pushed to `git http-backend` with no git on the
// client side (git builds the fixture and judges; pushRepo reads `.git` itself). Two servers: the default fixture and a
// stock one (upload-pack at git's defaults). The local repository has packed and loose objects, packed and loose refs,
// an annotated and a lightweight tag, an executable, a symlink, a gitlink (not followed) and a file edited in every
// commit, so the pack carries OFS deltas.
//
// After every push: the objects sent are exactly `git rev-list --objects <new> --not <what the remote had>` (what git
// push sends), the captured pack passes `git index-pack --strict` on its own (non-thin) or `--fix-thin` against the
// remote (thin), the remote passes `git fsck --strict`, and its refs equal the local refs pushed. At the end a
// `git clone --mirror` of the remote passes fsck and has the same refs. The pack size is measured against
// `git pack-objects --revs --thin --delta-base-offset`, which is what `git push` runs.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, symlinkSync, chmodSync, rmSync, appendFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { readBody } from './body.js';
import { git, gitBuf, gitAsync, tmpRoot, makeBareRepo, startGitServer, fsckProblems } from './server.js';
import { pushRepo, readConfig } from '../src/repo-node.js';
import { encodeDelta, planDeltas } from '../src/delta.js';
import { applyDelta, buildPack, encodeOfsDistance, parsePack, resolvePack, readOfsDelta } from '../src/pack.js';
import { hashObject, TYPE } from '../src/objects.js';
import { DEFAULT_LIMITS, withLimits } from '../src/limits.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';

const ZERO = '0'.repeat(40);
let root, cleanup, srv, n = 0;
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv.close(); cleanup(); });

const ID = ['-c', 'user.name=Local', '-c', 'user.email=local@example.com'];
const remoteRepo = stock => { const name = `r${n++}`; const bare = makeBareRepo(root, name, { stock }); return { bare, url: `${srv.url}/${name}.git` }; };
const rev = (dir, r) => git(dir, ['rev-parse', r]).trim();
const refsOf = dir => new Map(git(dir, ['for-each-ref', '--format=%(refname) %(objectname)']).trim().split('\n').filter(Boolean).map(l => l.split(' ')));
const objectsOf = (dir, args) => new Set(git(dir, ['rev-list', '--objects', ...args]).trim().split('\n').filter(Boolean).map(l => l.slice(0, 40)));
const fsck = bare => assert.deepEqual(fsckProblems(bare), []);
// What the remote lacks: everything reachable from `tips` minus everything reachable from the remote's refs, as an exact
// set difference. `rev-list --objects tips --not remoteTips` is not that: it excludes only the trees of the boundary
// commits, so a blob an older commit already holds and a newer one brings back is counted again (on this repository's
// own history, tsconfig.isolated.json at 5ce754b: rev-list 1783, the remote lacks 1782, pushRepo sends 1782).
const wouldSend = (local, tips, remoteTips) => {
  const want = objectsOf(local, tips);
  if (remoteTips.length) for (const o of objectsOf(local, remoteTips)) want.delete(o);
  return want;
};
// requests by service, and every receive-pack body (the pack is what follows the commands' flush)
const counting = () => {
  const c = { 'git-upload-pack': 0, 'git-receive-pack': 0, packs: [] };
  const fetchImpl = async (url, given) => {
    const kind = String(url).split('/').pop();
    c[kind] = (c[kind] ?? 0) + 1;
    // a pack past INFLATE_CHUNK is a streamed body (src/packwrite.ts): read once, forwarded as its bytes
    const { bytes: body, init, streamed } = await readBody(given);
    if (kind === 'git-receive-pack') { const at = body.indexOf('0000PACK'); c.packs.push(at < 0 ? null : body.subarray(at + 4)); c.streamed = (c.streamed ?? 0) + (streamed ? 1 : 0); }
    return fetch(url, init);
  };
  return { c, fetchImpl };
};
const traced = () => { const ex = arrayExporter(); return { tracer: new Tracer({ exporter: ex }), spans: () => ex.lines.flatMap(flattenLine) }; };
// The pack's objects as git index-pack --strict reads it: in a fresh repository (a self-contained pack), or in `dir`
// (the remote after the push: --strict checks every object the pack names is there). Never --fix-thin: a thin base
// would fail it.
function indexPack(pack, into = null) {
  const dir = into ?? mkdtempSync(join(root, 'ip-'));
  if (into === null) git(dir, ['init', '-q', '--bare']);
  const out = execFileSync('git', ['index-pack', '--strict', '--stdin', '-v'], { cwd: dir, input: pack, stdio: ['pipe', 'pipe', 'pipe'] });
  const idx = join(dir, 'objects', 'pack', `pack-${out.toString().trim().split(/\s+/).pop()}.idx`);
  const rows = git(dir, ['verify-pack', '-v', idx]).trim().split('\n').filter(l => /^[0-9a-f]{40} /.test(l));
  return { oids: new Set(rows.map(l => l.slice(0, 40))), deltas: rows.filter(l => l.split(/\s+/).length >= 7).length };
}

// ---- the local repository ----
const lines = (seed, count) => Array.from({ length: count }, (_, i) => `export const v${i} = ${(i * 2654435761 + seed) >>> 0}; // line ${i}`);
function makeLocal(name = `local${n++}`) {
  const dir = join(root, name);
  git(root, ['init', '-q', '-b', 'main', dir]);
  const src = lines(1, 300);
  const commit = (msg, edit) => {
    edit();
    git(dir, ['add', '-A']);
    git(dir, [...ID, 'commit', '-q', '-m', msg]);
  };
  const put = (p, d) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), d); };
  commit('one', () => { put('src/main.js', `${src.join('\n')}\n`); put('README.md', '# local\n'); put('bin/run', '#!/bin/sh\necho run\n'); chmodSync(join(dir, 'bin/run'), 0o755); symlinkSync('src/main.js', join(dir, 'link')); });
  for (let i = 2; i <= 6; i++) {
    commit(`edit ${i}`, () => {
      src[(i * 41) % src.length] = `// changed in ${i}`;
      src.splice((i * 17) % src.length, 0, `// inserted in ${i}`);
      put('src/main.js', `${src.join('\n')}\n`);
      put(`docs/note${i}.md`, `note ${i}\n${lines(i, 20).join('\n')}\n`);
    });
    if (i === 3) {
      git(dir, ['branch', 'old']);
      git(dir, ['tag', 'lw']);
      git(dir, ['repack', '-adq']); // the history so far is packed; what follows is loose
      git(dir, ['pack-refs', '--all']);
    }
  }
  // a gitlink: in the tree, never followed (its commit is not in this repository)
  git(dir, ['update-index', '--add', '--cacheinfo', `160000,${'c0ffee'.padEnd(40, '0')},vendor/sub`]);
  git(dir, [...ID, 'commit', '-q', '-m', 'submodule']);
  git(dir, [...ID, 'tag', '-a', 'v1', '-m', 'release 1', 'main~1']);
  git(dir, ['branch', 'topic', 'main~2']);
  return dir;
}

for (const stock of [false, true]) {
  test(`pushRepo ${stock ? 'stock' : 'default'}: first push, incremental, no-op, non-fast-forward, force, tags, delete, dry run, all — judged by git`, async () => {
    const local = makeLocal();
    const { bare, url } = remoteRepo(stock);
    const push = async (spec, opts = {}) => { const k = counting(); const r = await pushRepo(local, url, spec, { fetchImpl: k.fetchImpl, ...opts }); return { r, k }; };
    const sent = (k, i = 0) => indexPack(k.c.packs[i], bare);

    // 1. an empty remote: `old` (three commits) as main; the pack is self-contained and deltified
    let { r, k } = await push({ refspecs: ['old:main'] });
    assert.ok(r.ok, r.ok || r.error.message);
    assert.deepEqual(r.value.updates, [{ ref: 'refs/heads/main', oldOid: ZERO, newOid: rev(local, 'old'), kind: 'create' }]);
    let want = wouldSend(local, ['old'], []);
    let pack = sent(k);
    assert.deepEqual(pack.oids, want, 'the objects git push would send');
    assert.equal(r.value.objects, want.size);
    assert.ok(pack.deltas > 0 && pack.deltas === r.value.deltas, `deltas: ${pack.deltas} in the pack, ${r.value.deltas} planned`);
    assert.equal(k.c['git-receive-pack'], 1);
    fsck(bare);
    assert.equal(rev(bare, 'refs/heads/main'), rev(local, 'old'));

    // 2. incremental: main on top sends main --not old, nothing the remote has
    ({ r, k } = await push({ refspecs: ['main'] }));
    assert.ok(r.ok, r.ok || r.error.message);
    assert.equal(r.value.updates[0].kind, 'update');
    want = wouldSend(local, ['main'], [rev(local, 'old')]);
    pack = sent(k);
    assert.deepEqual(pack.oids, want);
    assert.ok(![...pack.oids].includes('c0ffee'.padEnd(40, '0')), 'the gitlink is not followed');
    fsck(bare);
    assert.equal(rev(bare, 'refs/heads/main'), rev(local, 'main'));
    const gitPackBytes = execFileSync('git', ['pack-objects', '--stdout', '--revs', '--thin', '--delta-base-offset', '-q'], { cwd: local, input: `main\n^old\n` }).length;
    console.log(`  ${stock ? 'stock' : 'default'}: incremental ${r.value.objects} objects, ${r.value.deltas} deltas, ${r.value.packBytes} B (git push: ${gitPackBytes} B, thin)`);

    // 3. again: up to date, no receive-pack request
    const { tracer, spans } = traced();
    ({ r, k } = await push({ refspecs: ['main'] }, { tracer }));
    assert.ok(r.ok);
    assert.equal(r.value.upToDate, true);
    assert.deepEqual(r.value.current, ['refs/heads/main']);
    assert.deepEqual(r.value.updates, []);
    assert.equal(k.c['git-receive-pack'], 0, 'no receive-pack request');
    assert.ok(!spans().some(s => s.name === 'git.receive-pack' || s.name === 'git.push_repo.read'), 'no push and no object read');
    assert.equal(spans().find(s => s.name === 'git.push_repo').attrs['git.push_repo.outcome'], 'up_to_date');

    // 4. an older commit over main: refused locally, nothing sent; `+` and force push it
    ({ r, k } = await push({ refspecs: ['old:main'] }));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'not_fast_forward');
    assert.match(r.error.message, /refs\/heads\/main \(non-fast-forward\)/);
    assert.equal(k.c['git-receive-pack'], 0);
    assert.equal(rev(bare, 'refs/heads/main'), rev(local, 'main'));
    ({ r } = await push({ refspecs: ['+old:main'] }));
    assert.ok(r.ok);
    assert.deepEqual(r.value.updates, [{ ref: 'refs/heads/main', oldOid: rev(local, 'main'), newOid: rev(local, 'old'), kind: 'force' }]);
    assert.equal(r.value.objects, 0);
    assert.equal(rev(bare, 'refs/heads/main'), rev(local, 'old'));
    ({ r } = await push({ refspecs: ['main'] }));
    assert.ok(r.ok);
    assert.equal(r.value.updates[0].kind, 'update');
    ({ r } = await push({ refspecs: ['old:main'], force: true }));
    assert.ok(r.ok);
    assert.equal(r.value.updates[0].kind, 'force');
    ({ r } = await push({ refspecs: ['main'] }));
    assert.ok(r.ok);
    fsck(bare);

    // a tip this repository does not have (someone else pushed): git's "fetch first"
    const other = join(root, `other${n++}`);
    git(root, ['clone', '-q', bare, other]);
    writeFileSync(join(other, 'theirs.txt'), 'theirs\n');
    git(other, ['add', '-A']); git(other, [...ID, 'commit', '-q', '-m', 'theirs']); git(other, ['push', '-q', 'origin', 'HEAD:refs/heads/ahead']);
    ({ r, k } = await push({ refspecs: ['main:refs/heads/ahead'] }));
    assert.equal(r.error.code, 'not_fast_forward');
    assert.match(r.error.message, /refs\/heads\/ahead \(fetch first\)/);
    assert.equal(k.c['git-receive-pack'], 0);

    // 5. tags: the annotated tag's object is the only new object; the lightweight tag names a commit the remote has
    ({ r, k } = await push({ tags: true }));
    assert.ok(r.ok, r.ok || r.error.message);
    assert.deepEqual(r.value.updates.map(u => [u.ref, u.kind]).sort(), [['refs/tags/lw', 'create'], ['refs/tags/v1', 'create']]);
    assert.deepEqual(sent(k).oids, new Set([rev(local, 'refs/tags/v1')]));
    assert.equal(git(bare, ['cat-file', '-t', 'refs/tags/v1']).trim(), 'tag');
    assert.equal(rev(bare, 'refs/tags/v1'), rev(local, 'refs/tags/v1'));
    fsck(bare);
    // a tag that moved locally: git refuses it (already exists) unless forced
    git(local, [...ID, 'tag', '-f', '-a', 'v1', '-m', 'release 1 again', 'main']);
    ({ r, k } = await push({ tags: true }));
    assert.equal(r.error.code, 'not_fast_forward');
    assert.match(r.error.message, /refs\/tags\/v1 \(already exists\)/);
    assert.equal(k.c['git-receive-pack'], 0);
    ({ r } = await push({ refspecs: ['+v1'] }));
    assert.ok(r.ok, r.ok || r.error.message);
    assert.equal(r.value.updates[0].kind, 'force');
    assert.equal(rev(bare, 'refs/tags/v1'), rev(local, 'refs/tags/v1'));

    // 6. delete with :dst (a short name the remote has)
    ({ r } = await push({ refspecs: ['topic'] }));
    assert.ok(r.ok);
    assert.equal(r.value.objects, 0, 'topic is an ancestor of main: nothing new');
    assert.equal(rev(bare, 'refs/heads/topic'), rev(local, 'topic'));
    const del = traced();
    ({ r, k } = await push({ refspecs: [':topic'] }, { tracer: del.tracer }));
    assert.ok(r.ok, r.ok || r.error.message);
    assert.ok(!del.spans().some(s => s.name === 'git.push_repo.read'), 'a delete reads no objects');
    assert.deepEqual(r.value.updates, [{ ref: 'refs/heads/topic', oldOid: rev(local, 'topic'), newOid: ZERO, kind: 'delete' }]);
    assert.deepEqual(k.c.packs, [null], 'a delete sends no pack');
    assert.ok(!refsOf(bare).has('refs/heads/topic'));
    ({ r } = await push({ refspecs: [':nope'] }));
    assert.equal(r.error.code, 'not_found');
    assert.equal(r.error.miss.kind, 'ref');

    // 7. dry run: the same decisions, no receive-pack request, the remote unchanged
    git(local, ['checkout', '-q', '-b', 'feature']);
    writeFileSync(join(local, 'feature.txt'), 'feature\n');
    git(local, ['add', '-A']); git(local, [...ID, 'commit', '-q', '-m', 'feature']);
    ({ r, k } = await push({ dryRun: true }));
    assert.ok(r.ok, r.ok || r.error.message);
    assert.equal(r.value.dryRun, true);
    assert.deepEqual(r.value.updates, [{ ref: 'refs/heads/feature', oldOid: ZERO, newOid: rev(local, 'feature'), kind: 'create' }]);
    assert.equal(r.value.objects, wouldSend(local, ['feature'], [rev(local, 'main')]).size);
    assert.equal(r.value.packBytes, 0);
    assert.equal(k.c['git-receive-pack'], 0);
    assert.ok(!refsOf(bare).has('refs/heads/feature'));
    // the default refspec is the current branch, to the same name
    ({ r } = await push({}));
    assert.ok(r.ok);
    assert.equal(rev(bare, 'refs/heads/feature'), rev(local, 'feature'));

    // 8. all: every branch, one request; then the mirror has exactly the local refs
    ({ r, k } = await push({ all: true }));
    assert.ok(r.ok, r.ok || r.error.message);
    assert.deepEqual(r.value.updates.map(u => u.ref).sort(), ['refs/heads/old', 'refs/heads/topic']);
    assert.equal(k.c['git-receive-pack'], 1);
    const mirror = join(root, `mirror${n++}`);
    git(root, ['clone', '-q', '--mirror', '--no-local', bare, mirror]);
    fsck(mirror);
    const remoteRefs = refsOf(mirror);
    const localRefs = refsOf(local);
    for (const [ref, oid] of remoteRefs) if (ref !== 'refs/heads/ahead') assert.equal(oid, localRefs.get(ref), ref);
    for (const [ref, oid] of localRefs) assert.equal(remoteRefs.get(ref), oid, ref);
    assert.equal(git(mirror, ['count-objects', '-v']).match(/in-pack: (\d+)/)[1], String(objectsOf(mirror, ['--all']).size));
  });
}

test('pushRepo thin: the first version of each path deltas against the remote\'s copy (REF_DELTA), and receive-pack accepts it', async () => {
  const local = makeLocal();
  for (const stock of [false, true]) {
    const { bare, url } = remoteRepo(stock);
    let r = await pushRepo(local, url, { refspecs: ['old:main'], thin: true });
    assert.ok(r.ok);
    assert.equal(r.value.thinDeltas, 0, 'nothing on the remote yet');
    const k = counting();
    r = await pushRepo(local, url, { refspecs: ['main'], thin: true }, { fetchImpl: k.fetchImpl });
    assert.ok(r.ok, r.ok || r.error.message);
    assert.ok(r.value.thinDeltas > 0, 'src/main.js deltas against the remote\'s version');
    const thick = await pushRepo(local, url, { refspecs: ['main'], dryRun: true });
    assert.equal(thick.value.upToDate, true);
    fsck(bare);
    // the pack is thin: index-pack needs --fix-thin and the remote's objects to complete it
    const fixed = execFileSync('git', ['index-pack', '--strict', '--stdin', '--fix-thin'], { cwd: bare, input: k.c.packs[0] }).toString();
    assert.match(fixed, /^pack\t[0-9a-f]{40}/);
    assert.equal(rev(bare, 'refs/heads/main'), rev(local, 'main'));
  }
});

test('pushRepo pack size: this repository\'s own history, main~50 then main, against git push\'s pack', async () => {
  // The issue's measurement (#186). Skipped where the checkout has no history to push.
  const repo = join(import.meta.dirname, '..');
  let count = 0;
  try { count = Number(git(repo, ['rev-list', '--count', 'HEAD']).trim()); } catch { count = 0; }
  if (count < 60 || git(repo, ['rev-parse', '--is-shallow-repository']).trim() === 'true') return;
  const local = join(root, `self${n++}`);
  git(root, ['clone', '-q', '--no-local', '--single-branch', repo, local]);
  git(local, ['checkout', '-q', '-B', 'main', rev(repo, 'HEAD')]);
  for (const t of git(local, ['tag', '-l']).trim().split('\n').filter(Boolean)) git(local, ['tag', '-d', t]);
  const { url } = remoteRepo(true);
  const base = rev(local, 'HEAD~50');
  const gitPack = revs => execFileSync('git', ['pack-objects', '--stdout', '--revs', '--thin', '--delta-base-offset', '-q'], { cwd: local, input: `${revs.join('\n')}\n`, maxBuffer: 1 << 30 }).length;
  const first = await pushRepo(local, url, { refspecs: [`${base}:refs/heads/main`] });
  assert.ok(first.ok, first.ok || first.error.message);
  const firstGit = gitPack([base]);
  const incr = await pushRepo(local, url, { refspecs: ['main'], dryRun: false, thin: true });
  assert.ok(incr.ok, incr.ok || incr.error.message);
  const incrGit = gitPack(['main', `^${base}`]);
  console.log(`  this repository: first push ${first.value.objects} objects ${first.value.packBytes} B (git ${firstGit} B, ×${(first.value.packBytes / firstGit).toFixed(2)}); incremental thin ${incr.value.objects} objects ${incr.value.packBytes} B (git ${incrGit} B, ×${(incr.value.packBytes / incrGit).toFixed(2)})`);
  assert.equal(first.value.objects, wouldSend(local, [base], []).size);
  assert.equal(incr.value.objects, wouldSend(local, ['main'], [base]).size);
  assert.ok(first.value.packBytes < 1.5 * firstGit, 'first push well under 2× git');
  assert.ok(incr.value.packBytes < 1.5 * incrGit, 'incremental (thin) well under 2× git');
}, 120_000);

// ---- refusals ----
const NOWHERE = 'http://127.0.0.1:9/never.git';
const refused = async (dir, spec, what, opts = {}) => {
  const r = await pushRepo(dir, NOWHERE, spec, opts);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'bad_request', r.error.message);
  assert.equal(r.error.what, what, r.error.message);
  return r.error;
};

test('pushRepo refuses, before any request, what it does not read: not a repository, a bad spec, SHA-256, reftable, a partial clone, alternates, shallow, a bad ref', async () => {
  const local = makeLocal();
  const empty = join(root, `empty${n++}`); mkdirSync(empty);
  await refused(empty, {}, 'dir');
  await refused('', {}, 'dir');
  await refused(local, { all: true, refspecs: ['main'] }, 'spec');
  await refused(local, { refspecs: 'main' }, 'spec');
  await refused(local, { dryRun: 'yes' }, 'spec');
  // sha256: git's own repository format
  const sha256 = join(root, `sha256-${n++}`);
  git(root, ['init', '-q', '--object-format=sha256', sha256]);
  assert.match((await refused(sha256, {}, 'objectFormat')).message, /sha256/);
  // the format extensions, as git writes them
  const copy = what => { const d = join(root, `${what}${n++}`); git(root, ['clone', '-q', '--no-local', local, d]); return d; };
  const reftable = copy('reftable');
  appendFileSync(join(reftable, '.git', 'config'), '[extensions]\n\trefStorage = reftable\n');
  await refused(reftable, {}, 'refStorage');
  const partial = copy('partial');
  appendFileSync(join(partial, '.git', 'config'), '[extensions]\n\tpartialClone = origin\n');
  await refused(partial, {}, 'partialClone');
  const shared = join(root, `shared${n++}`);
  git(root, ['clone', '-q', '--shared', local, shared]);
  await refused(shared, {}, 'alternates');
  const shallow = join(root, `shallow${n++}`);
  git(root, ['clone', '-q', '--depth', '1', `file://${local}`, shallow]);
  await refused(shallow, {}, 'shallow');
  const badRef = copy('badref');
  writeFileSync(join(badRef, '.git', 'refs', 'heads', 'broken'), 'not an id\n');
  await refused(badRef, {}, 'ref');
  // a symbolic ref that ends nowhere is left out, as git keeps it
  const dangling = copy('dangling');
  mkdirSync(join(dangling, '.git', 'refs', 'remotes', 'gone'), { recursive: true });
  writeFileSync(join(dangling, '.git', 'refs', 'remotes', 'gone', 'HEAD'), 'ref: refs/remotes/gone/main\n');
  const { url } = remoteRepo(false);
  const ok = await pushRepo(dangling, url, { refspecs: ['main'] });
  assert.ok(ok.ok, ok.ok || ok.error.message);
  // limits.maxRefs bounds the refs read
  const many = await pushRepo(local, NOWHERE, {}, { limits: withLimits({ maxRefs: 2 }) });
  assert.equal(many.error.code, 'limit_exceeded');
  assert.equal(many.error.what, 'local refs');
  // a bare repository and a work tree whose .git is a file (a linked worktree) are read the same way
  const bareLocal = join(root, `bare${n++}`);
  git(root, ['clone', '-q', '--bare', local, bareLocal]);
  const wt = join(root, `wt${n++}`);
  git(local, ['worktree', 'add', '-q', wt, 'topic']);
  for (const [dir, ref] of [[bareLocal, 'main'], [wt, 'topic']]) {
    const remote = remoteRepo(false);
    const r = await pushRepo(dir, remote.url, { refspecs: [ref] });
    assert.ok(r.ok, r.ok || r.error.message);
    assert.equal(rev(remote.bare, `refs/heads/${ref}`), rev(local, ref));
    fsck(remote.bare);
  }
});

test('pushRepo refspecs: git\'s syntax and resolution, and what it refuses', async () => {
  const local = makeLocal();
  const { bare, url } = remoteRepo(false);
  const go = spec => pushRepo(local, url, spec);
  const bad = async (spec, re) => { const r = await go(spec); assert.equal(r.ok, false, JSON.stringify(spec)); assert.equal(r.error.code, 'bad_request', r.error.message); assert.match(r.error.message, re); };
  await bad({ refspecs: ['a:b:c'] }, /not src, src:dst/);
  await bad({ refspecs: ['main:'] }, /not src, src:dst/);
  await bad({ refspecs: ['nope'] }, /does not match any local ref/);
  git(local, ['branch', 'dup']); git(local, ['tag', 'dup']);
  await bad({ refspecs: ['dup'] }, /matches more than one ref/);
  await bad({ refspecs: [rev(local, 'old')] }, /needs a destination/);
  await bad({ refspecs: [`${rev(local, 'old')}:short`] }, /is not a full refname/);
  await bad({ refspecs: ['main:x', 'old:x'] }, /destination of two refspecs/);
  await bad({ refspecs: ['main:refs/heads/a b'] }, /not src, src:dst/);
  await bad({ refspecs: ['main:refs/heads/bad..name'] }, /ref/);
  // a 40-hex id to a full name; HEAD to its branch; a short destination the remote has; the same refspec twice
  let r = await go({ refspecs: [`${rev(local, 'old')}:refs/heads/from-id`, 'HEAD', 'HEAD'] });
  assert.ok(r.ok, r.ok || r.error.message);
  assert.deepEqual(r.value.updates.map(u => u.ref).sort(), ['refs/heads/from-id', 'refs/heads/main']);
  r = await go({ refspecs: ['old:from-id'] });
  assert.ok(r.ok);
  assert.deepEqual(r.value.current, ['refs/heads/from-id']);
  // a detached HEAD has no default
  git(local, ['checkout', '-q', '--detach', 'old']);
  await bad({}, /HEAD is not a branch/);
  r = await go({ refspecs: ['HEAD:refs/heads/detached'] });
  assert.ok(r.ok);
  assert.equal(rev(bare, 'refs/heads/detached'), rev(local, 'old'));
  fsck(bare);
});

test('pushRepo fails closed: limits, a missing or corrupt object, a tree entry of the wrong type', async () => {
  // loose objects only, so the store's own bounds decide
  const loose = join(root, `loose${n++}`);
  git(root, ['init', '-q', '-b', 'main', loose]);
  writeFileSync(join(loose, 'big.txt'), 'x'.repeat(5000));
  writeFileSync(join(loose, 'small.txt'), 'small\n');
  git(loose, ['add', '-A']); git(loose, [...ID, 'commit', '-q', '-m', 'one']);
  const { url } = remoteRepo(false);
  const limited = async (limits, what) => { const r = await pushRepo(loose, url, {}, { limits: withLimits(limits) }); assert.equal(r.ok, false); assert.equal(r.error.code, 'limit_exceeded', r.error.message); assert.equal(r.error.what, what); };
  await limited({ maxInflatedTotal: 1000 }, 'local objects bytes');
  await limited({ maxPackObjects: 2 }, 'local objects');
  await limited({ maxObjectSize: 4990 }, 'object size');
  // packed, the pack's own bounds decide (parsePack, resolvePack), still limit_exceeded
  const packed = makeLocal();
  const p = await pushRepo(packed, url, { refspecs: ['old'] }, { limits: withLimits({ maxInflatedTotal: 2000 }) });
  assert.equal(p.error.code, 'limit_exceeded');
  // a missing object
  const blob = rev(loose, 'HEAD:small.txt');
  rmSync(join(loose, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  let r = await pushRepo(loose, url, {});
  assert.equal(r.error.code, 'bad_request');
  assert.equal(r.error.what, 'object');
  assert.match(r.error.message, /small\.txt\) is missing from the local repository/);
  // a loose object whose bytes do not hash to its name
  writeFileSync(join(loose, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), deflateSync(Buffer.from('blob 6\0SMALL\n')));
  r = await pushRepo(loose, url, {});
  assert.equal(r.error.code, 'pack_corrupt');
  assert.match(r.error.message, /bad header or hash/);
  // a tree entry that says tree and names a blob
  const wrong = join(root, `wrong${n++}`);
  git(root, ['init', '-q', '-b', 'main', wrong]);
  const b = git(wrong, ['hash-object', '-w', '--stdin'], { input: 'blob\n' }).trim();
  const tree = gitBuf(wrong, ['hash-object', '-t', 'tree', '-w', '--stdin', '--literally'], Buffer.concat([Buffer.from('40000 dir\0'), Buffer.from(b, 'hex')])).toString().trim();
  const c = git(wrong, [...ID, 'commit-tree', tree, '-m', 'wrong']).trim();
  git(wrong, ['update-ref', 'refs/heads/main', c]);
  r = await pushRepo(wrong, url, {});
  assert.equal(r.error.code, 'pack_corrupt');
  assert.match(r.error.message, new RegExp(`${b} is a blob, not a tree`));
});

// ---- the delta generator and the pack encoding ----
test('encodeDelta: applyDelta (and git index-pack) rebuild the target; null when the delta would not be smaller', async () => {
  let seed = 7;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  for (let t = 0; t < 400; t++) {
    const base = Uint8Array.from({ length: Math.floor(rnd() * 4000) }, () => Math.floor(rnd() * (rnd() < 0.5 ? 3 : 256)));
    const out = [...base];
    for (let e = 0; e < 1 + rnd() * 6; e++) {
      const p = Math.floor(rnd() * out.length), k = rnd();
      if (k < 0.3) out.splice(p, Math.floor(rnd() * 60));
      else if (k < 0.6) out.splice(p, 0, ...Array.from({ length: Math.floor(rnd() * 200) }, () => Math.floor(rnd() * 256)));
      else out.splice(p, 0, ...base.subarray(Math.floor(rnd() * base.length), Math.floor(rnd() * base.length)));
    }
    const target = Uint8Array.from(out);
    const d = encodeDelta(base, target, Infinity);
    if (d === null) { assert.ok(base.length < 16 || target.length < 16); continue; }
    assert.deepEqual(Buffer.from(applyDelta(base, d).value.out), Buffer.from(target));
    const capped = encodeDelta(base, target, d.length);
    assert.equal(capped, null, 'a delta of maxSize bytes or more is null');
  }
  // a chain of 70 versions of one path: depth bounded by maxDepth, OFS bases before their deltas, git accepts it
  const objs = [];
  const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(i % 40)}\n`);
  for (let v = 0; v < 70; v++) { text[(v * 37) % 300] = `changed ${v}\n`; objs.push({ type: TYPE.BLOB, data: Buffer.from(text.join('')), path: 'a.txt' }); }
  const plan = planDeltas(objs, { maxDepth: 10 });
  assert.ok(plan.ofs > 50);
  const depth = [];
  for (const [i, o] of plan.objects.entries()) { const ofs = o.base?.tag === 'ofs'; assert.ok(o.base === undefined || (ofs && o.base.index < i)); depth.push(ofs ? depth[o.base.index] + 1 : 0); }
  assert.ok(Math.max(...depth) <= 10);
  const { pack } = await buildPack(plan.objects);
  const resolved = resolvePack(parsePack(pack).value);
  assert.ok(objs.every(o => resolved.value.objects.has(hashObject('blob', o.data))));
  const verify = indexPack(pack);
  assert.equal(verify.oids.size, new Set(objs.map(o => hashObject('blob', o.data))).size);
  assert.equal(verify.deltas, plan.ofs);
  assert.equal(planDeltas(objs, { maxDepth: 0 }).ofs, 0);
  // the OFS distance encoding round-trips through the reader
  for (const d of [1, 127, 128, 16511, 16512, 2113663, 2113664, 1 << 30]) {
    const enc = encodeOfsDistance(d);
    assert.equal(readOfsDelta(enc, 0).value.off, d, String(d));
  }
});

test('readConfig: sections, subsections, case, comments, a bare key', () => {
  const c = readConfig('[core]\n\tbare = false ; comment\n[Extensions]\n\tObjectFormat = sha256\n[remote "origin"]\n\turl = x\n# c\n[x]\n\tflag\n');
  assert.equal(c.get('core.bare'), 'false');
  assert.equal(c.get('extensions.objectformat'), 'sha256');
  assert.equal(c.get('remote.origin.url'), 'x');
  assert.equal(c.get('x.flag'), 'true');
});

// ---- git is the judge of how a local repository is read: the same push, from the same directory, by git 2.50 ----
// git's verdict: its exit status, its stderr, and the commands `git push --dry-run --porcelain` reports, in the shape
// of pushRepo's dry run. Each new oid is git's own reading of the source ref it printed (rev-parse), so nothing
// expected here comes from ply. Only creates are compared (the remote is empty): porcelain's `*` flag.
const byRef = (a, b) => (a.ref < b.ref ? -1 : 1);
const gitDryRun = async (dir, url, args) => {
  const r = await gitAsync(dir, ['push', '--dry-run', '--porcelain', url, ...args]);
  const rows = r.stdout.split('\n').filter(l => l.includes('\t')).map(l => l.split('\t'));
  const updates = rows.map(([flag, pair]) => { const [src, dst] = pair.split(':'); return { ref: dst, newOid: rev(dir, src), kind: flag === '*' ? 'create' : flag }; });
  return { status: r.status, stderr: r.stderr, updates: updates.sort(byRef) };
};
const plyDryRun = async (dir, url, spec) => {
  const r = await pushRepo(dir, url, { ...spec, dryRun: true });
  return r.ok ? { ok: true, updates: r.value.updates.map(u => ({ ref: u.ref, newOid: u.newOid, kind: u.kind })).sort(byRef) } : { ok: false, error: r.error };
};
// both sides on one push: git performs it, and pushRepo's commands are git's
const sameAsGit = async (dir, url, args, spec) => {
  const g = await gitDryRun(dir, url, args);
  assert.equal(g.status, 0, `git push ${args.join(' ')}: ${g.stderr}`);
  const p = await plyDryRun(dir, url, spec);
  assert.ok(p.ok, p.ok || `pushRepo ${JSON.stringify(spec)}: ${p.error.code}: ${p.error.message}`);
  assert.deepEqual(p.updates, g.updates, `git push ${args.join(' ')}`);
  return g.updates;
};
// a work tree with one commit: main, topic and a lightweight tag v1, all loose
const smallLocal = () => {
  const dir = join(root, `small${n++}`);
  git(root, ['init', '-q', '-b', 'main', dir]);
  writeFileSync(join(dir, 'f'), 'one\n');
  git(dir, ['add', '-A']);
  git(dir, [...ID, 'commit', '-q', '-m', 'one']);
  git(dir, ['branch', 'topic']);
  git(dir, ['tag', 'v1']);
  return dir;
};

test('pushRepo vs git: a file under refs/ that is not a ref (Finder\'s .DS_Store, a dot directory, a name check-ref-format refuses) is ignored', async () => {
  const local = smallLocal();
  const { url } = remoteRepo(false);
  const refsDir = join(local, '.git', 'refs');
  writeFileSync(join(refsDir, 'heads', '.DS_Store'), '\x00\x00\x00\x01Bud1');
  writeFileSync(join(refsDir, '.DS_Store'), '\x00\x00\x00\x01Bud1');
  mkdirSync(join(refsDir, 'heads', '.hidden'));
  writeFileSync(join(refsDir, 'heads', '.hidden', 'x'), 'junk\n');
  writeFileSync(join(refsDir, 'tags', 'bad~name'), 'junk\n');
  const head = rev(local, 'main');
  assert.deepEqual(await sameAsGit(local, url, ['main'], { refspecs: ['main'] }), [{ ref: 'refs/heads/main', newOid: head, kind: 'create' }]);
  assert.deepEqual((await sameAsGit(local, url, ['--all'], { all: true })).map(u => u.ref), ['refs/heads/main', 'refs/heads/topic']);
  assert.deepEqual((await sameAsGit(local, url, ['--tags'], { tags: true })).map(u => u.ref), ['refs/tags/v1']);
});

test('pushRepo vs git: a short source is ambiguous as git counts it (remote.c count_refspec_match): a branch or a tag wins over refs/remotes', async () => {
  const local = smallLocal();
  const { url } = remoteRepo(false);
  // a branch named as a remote is (refs/remotes/foo/HEAD), a tag named as a remote-tracking ref, and a remote alone
  git(local, ['branch', 'foo']);
  git(local, ['update-ref', 'refs/remotes/foo/main', 'HEAD']);
  git(local, ['symbolic-ref', 'refs/remotes/foo/HEAD', 'refs/remotes/foo/main']);
  git(local, ['tag', 'bar']);
  git(local, ['update-ref', 'refs/remotes/bar', 'HEAD']);
  git(local, ['update-ref', 'refs/remotes/baz/main', 'HEAD']);
  git(local, ['symbolic-ref', 'refs/remotes/baz/HEAD', 'refs/remotes/baz/main']);
  assert.deepEqual((await sameAsGit(local, url, ['foo'], { refspecs: ['foo'] })).map(u => u.ref), ['refs/heads/foo']);
  assert.deepEqual((await sameAsGit(local, url, ['bar'], { refspecs: ['bar'] })).map(u => u.ref), ['refs/tags/bar']);
  assert.deepEqual((await sameAsGit(local, url, ['baz:refs/heads/from-baz'], { refspecs: ['baz:refs/heads/from-baz'] })).map(u => u.ref), ['refs/heads/from-baz']);
  // two strong matches (a branch and a tag) stay ambiguous on both sides
  git(local, ['branch', 'dup']);
  git(local, ['tag', 'dup']);
  const g = await gitDryRun(local, url, ['dup']);
  assert.notEqual(g.status, 0);
  assert.match(g.stderr, /src refspec dup matches more than one/);
  const p = await plyDryRun(local, url, { refspecs: ['dup'] });
  assert.equal(p.ok, false);
  assert.equal(p.error.code, 'bad_request');
  assert.match(p.error.message, /matches more than one ref \(refs\/tags\/dup, refs\/heads\/dup\)/);
});
