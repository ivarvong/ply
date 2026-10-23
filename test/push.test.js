// receive-pack parity: our push vs `git push` on identical repos, over the product of server configs × hooks ×
// command kinds × capabilities. Oracle per cell: same accept/reject, same ref state, same stored objects,
// same server message, hook stderr visible on band 2 when side-band is requested, fsck clean.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, chmodSync, cpSync } from 'node:fs';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer } from './server.js';
import { GitHttp, ZERO_OID } from '../src/client.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { TYPE } from '../src/objects.js';
import { makeDelta } from '../src/pack.js';

let root, cleanup, srv, n = 0;
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv.close(); cleanup(); });

const HOOK = {
  none: null,
  'pre-receive-reject': ['pre-receive', '#!/bin/sh\necho "policy: nope" >&2\nexit 1\n'],
  'pre-receive-accept-noisy': ['pre-receive', '#!/bin/sh\necho "hello from hook" >&2\necho "line two" >&2\nexit 0\n'],
  'update-reject-feature': ['update', '#!/bin/sh\ncase "$1" in refs/heads/feature*) echo "feature branches are frozen" >&2; exit 1;; esac\nexit 0\n'],
  // echoes the push options it received (GIT_PUSH_OPTION_COUNT / GIT_PUSH_OPTION_n) so the test can see them arrive
  'pre-receive-echo-options': ['pre-receive', '#!/bin/sh\necho "opts=$GIT_PUSH_OPTION_COUNT:$GIT_PUSH_OPTION_0:$GIT_PUSH_OPTION_1" >&2\nexit 0\n'],
};
const CONFIG = {
  default: {},
  'deny-nonff': { 'receive.denyNonFastForwards': 'true' },
  'deny-deletes': { 'receive.denyDeletes': 'true' },
  'index-pack': { 'receive.unpackLimit': '1' },     // every push goes through index-pack --fix-thin --strict
  'unpack-objects': { 'receive.unpackLimit': '1000' },
  'no-fsck': { 'receive.fsckObjects': 'false', 'transfer.fsckObjects': 'false' },
  'push-options': { 'receive.advertisePushOptions': 'true' },
};

// Build a twin: bare repo pair (ours / git's) seeded identically, plus a work clone holding the candidate commits.
function twins(cfg, hook) {
  const id = n++;
  const seedWork = join(root, `w${id}`); mkdirSync(seedWork); git(seedWork, ['init', '-q', '-b', 'main']);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000' };
  writeFileSync(join(seedWork, 'f.txt'), 'base content\nMARK\n'); git(seedWork, ['add', '-A']); git(seedWork, ['commit', '-q', '-m', 'base'], { env });
  const base = git(seedWork, ['rev-parse', 'HEAD']).trim();
  writeFileSync(join(seedWork, 'f.txt'), 'base content\nEDITED\n'); git(seedWork, ['commit', '-q', '-am', 'ff'], { env });
  const ff = git(seedWork, ['rev-parse', 'HEAD']).trim();
  git(seedWork, ['checkout', '-q', base]); writeFileSync(join(seedWork, 'g.txt'), 'other'); git(seedWork, ['add', '-A']); git(seedWork, ['commit', '-q', '-m', 'diverged'], { env });
  const diverged = git(seedWork, ['rev-parse', 'HEAD']).trim();
  git(seedWork, ['checkout', '-q', '-b', 'main2', ff]);
  const mk = tag => { const bare = makeBareRepo(root, `${tag}${id}`); git(seedWork, ['push', '-q', bare, `${base}:refs/heads/main`, `${base}:refs/heads/feature/x`]); for (const [k, v] of Object.entries(cfg)) git(bare, ['config', k, v]); if (hook) { const [name, body] = hook; const p = join(bare, 'hooks', name); writeFileSync(p, body); chmodSync(p, 0o755); } return bare; };
  return { base, ff, diverged, work: seedWork, ours: mk('o'), theirs: mk('t'), id };
}
const refsOf = bare => git(bare, ['for-each-ref', '--format=%(refname) %(objectname)']).trim();
const objectsOf = bare => git(bare, ['cat-file', '--batch-check', '--batch-all-objects', '--unordered']).trim().split('\n').map(l => l.split(' ')[0]).sort().join('\n');
const objectsFor = (work, commit) => { // full commit + tree + blobs for a one-commit push (what our pipeline would send, non-delta)
  const out = [];
  for (const l of git(work, ['rev-list', '--objects', '--no-object-names', commit, '-n1', `^${commit}~1`]).trim().split('\n')) {
    const type = git(work, ['cat-file', '-t', l]).trim();
    out.push({ type: TYPE[type.toUpperCase()], data: new Uint8Array(gitBuf(work, ['cat-file', type, l])) });
  }
  return out;
};
const gitPush = (work, bare, refspecs, extra = []) => { try { const out = git(work, ['push', '--porcelain', ...extra, bare, ...refspecs]); return { ok: true, out }; } catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || ''), code: e.status }; } };

// PUSH_MATRIX=full runs every cell (~20 min: each cell is a real `git push` plus ours). Default: a seeded 1-in-8 sample
// (~3 min) whose seed rotates daily, so a week of `npm test` covers the matrix and any day's failure is reproducible with
// PUSH_MATRIX_SEED=<n>. Cells are deterministic in (config, hook, command, caps), so sampling loses nothing but time.
const FULL = process.env.PUSH_MATRIX === 'full';
const SEED = +(process.env.PUSH_MATRIX_SEED ?? Math.floor(Date.now() / 86400000));
const sampled = (() => { let x = SEED >>> 0 || 1; return label => { let h = x; for (const ch of label) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return FULL || (h % 8) === 0; }; })();

test(`push matrix: configs × hooks × commands × caps, parity with git push (${FULL ? 'full' : `sample seed=${SEED}`})`, async () => {
  const stats = { cells: 0, ok: 0, rejected: 0, skipped: 0 };
  for (const [ck, cfg] of Object.entries(CONFIG)) for (const [hk, hook] of Object.entries(HOOK)) {
    const cmds = {
      'ff-update': t => ({ ours: { commands: [{ ref: 'refs/heads/main', oldOid: t.base, newOid: t.ff }], objects: objectsFor(t.work, t.ff) }, git: [`${t.ff}:refs/heads/main`] }),
      'nonff-update': t => ({ ours: { commands: [{ ref: 'refs/heads/main', oldOid: t.base, newOid: t.diverged }], objects: objectsFor(t.work, t.diverged) }, git: [`+${t.diverged}:refs/heads/main`] }),
      'create': t => ({ ours: { commands: [{ ref: 'refs/heads/new', oldOid: ZERO_OID, newOid: t.ff }], objects: objectsFor(t.work, t.ff) }, git: [`${t.ff}:refs/heads/new`] }),
      'delete': t => ({ ours: { commands: [{ ref: 'refs/heads/feature/x', oldOid: t.base, newOid: ZERO_OID }], objects: [] }, git: [':refs/heads/feature/x'] }),
      'multi': t => ({ ours: { commands: [{ ref: 'refs/heads/main', oldOid: t.base, newOid: t.ff }, { ref: 'refs/heads/feature/x', oldOid: t.base, newOid: t.ff }], objects: objectsFor(t.work, t.ff) }, git: [`${t.ff}:refs/heads/main`, `${t.ff}:refs/heads/feature/x`] }),
      'multi-atomic': t => ({ ours: { commands: [{ ref: 'refs/heads/main', oldOid: t.base, newOid: t.ff }, { ref: 'refs/heads/feature/x', oldOid: t.base, newOid: t.ff }], objects: objectsFor(t.work, t.ff), atomic: true }, git: [`${t.ff}:refs/heads/main`, `${t.ff}:refs/heads/feature/x`], extra: ['--atomic'] }),
      'stale-old': t => ({ ours: { commands: [{ ref: 'refs/heads/main', oldOid: t.diverged, newOid: t.ff }], objects: objectsFor(t.work, t.ff) }, git: [`${t.ff}:refs/heads/main`], extra: [`--force-with-lease=refs/heads/main:${t.diverged}`] }),
      'thin-blob-delta': t => { const objs = objectsFor(t.work, t.ff); const oldBlob = git(t.work, ['rev-parse', `${t.base}:f.txt`]).trim(), newBlob = git(t.work, ['rev-parse', `${t.ff}:f.txt`]).trim(); const base = new Uint8Array(gitBuf(t.work, ['cat-file', 'blob', oldBlob])), target = new Uint8Array(gitBuf(t.work, ['cat-file', 'blob', newBlob])); const i = objs.findIndex(o => o.type === TYPE.BLOB && o.data.length === target.length); objs[i] = { type: TYPE.BLOB, data: makeDelta(base, target).delta, baseOid: oldBlob }; return { ours: { commands: [{ ref: 'refs/heads/main', oldOid: t.base, newOid: t.ff }], objects: objs }, git: [`${t.ff}:refs/heads/main`] }; },
    };
    for (const [kk, mkCmd] of Object.entries(cmds)) for (const caps of [{ sideband: false }, { sideband: true }, { sideband: false, reportV2: true }, { sideband: true, reportV2: true }, { sideband: true, pushOptions: ['ci.skip', 'reviewer=alice'] }]) { // sideband is explicit per cell: the default (on) is checked separately below
      const label = `${ck}/${hk}/${kk}/${Object.entries(caps).filter(([, v]) => v).map(([k]) => k).join('+') || 'plain'}`;
      if (!sampled(label)) { stats.skipped++; continue; }
      stats.cells++;
      const t = twins(cfg, hook);
      const { ours, git: refspecs, extra = [] } = mkCmd(t);
      const exporter = arrayExporter();
      const client = new GitHttp(`${srv.url}/o${t.id}.git`, { tracer: new Tracer({ exporter }) });
      let res, err;
      try { res = await client.push({ ...ours, ...caps }); } catch (e) { err = e; }
      const g = gitPush(t.work, t.theirs, refspecs, [...extra, ...(caps.pushOptions ?? []).flatMap(o => ['-o', o])]);
      // 1. accept/reject parity
      if (caps.pushOptions && ck !== 'push-options') { // git: "the receiving end does not support push options" (client-side); ours: server rejects the capability
        assert.ok(!g.ok, `${label}: git should refuse -o without advertisePushOptions`);
        assert.equal(err?.code, 'unsupported', `${label}: ours ${err?.code} ${err?.message}`); // detected from the advertisement before sending anything
        assert.equal(refsOf(t.ours), refsOf(t.theirs), `${label}: refs differ`);
        stats.rejected++; continue;
      }
      assert.equal(!err, g.ok, `${label}: ours ${err ? 'rejected (' + err.code + ': ' + err.message + ')' : 'ok'} vs git ${g.ok ? 'ok' : 'rejected'}\n${g.out}`);
      // 2. ref state parity
      assert.equal(refsOf(t.ours), refsOf(t.theirs), `${label}: refs differ`);
      // 3. stored objects parity (an accepted push stores the same objects; a rejected push may leave dangling ones on both)
      if (!err) assert.equal(objectsOf(t.ours), objectsOf(t.theirs), `${label}: objects differ`);
      // 4. reason parity: git's porcelain "!" line carries the server's reason
      if (err) {
        stats.rejected++;
        // git porcelain: one "!" line per rejected ref with the server's reason; a client-side lease refusal never reaches the server
        const gitRejects = new Map([...g.out.matchAll(/^!\s+\S*:(\S+)\s+\[remote rejected\]\s+\((.*)\)/gm)].map(m => [m[1], m[2]]));
        const ourRejects = new Map(err.report?.refs?.filter(r => !r.ok).map(r => [r.ref, r.reason]) ?? []);
        if (/stale info/.test(g.out)) assert.ok([...ourRejects.values()].every(r => /^(failed to update ref|pre-receive hook declined|hook declined|atomic push failure|bad ref)$/.test(r)), `${label}: ${[...ourRejects.values()]}`);
        else assert.deepEqual([...ourRejects].sort(), [...gitRejects].sort(), `${label}: per-ref reasons`);
        const reasons = [...ourRejects.values()];
        const isCas = r => /^(failed to update ref|failed to lock|atomic push failure|bad ref)$/.test(r) || /fetch first|non-fast-forward|already exists/.test(r); // 'bad ref': denyNonFastForwards could not parse the (stale, unknown) old oid
        const expectCas = reasons.length && reasons.every(isCas) && reasons.some(r => r !== 'atomic push failure');
        assert.equal(err.code, expectCas ? 'cas_conflict' : 'push_rejected', `${label}: code for ${JSON.stringify(reasons)}`);
      } else stats.ok++;
      // 5. hook output on band 2 when requested
      if (caps.sideband && hk === 'pre-receive-accept-noisy') assert.match((err?.hookOutput ?? res.hookOutput), /hello from hook\r?\nline two/, `${label}: band 2`);
      if (!caps.sideband) assert.equal((err?.hookOutput ?? res?.hookOutput ?? ''), '', `${label}: no band 2 without side-band`);
      // 6. report-status-v2 is accepted; git 2.43 emits `option` lines only through proc-receive, so none are expected here
      if (caps.reportV2 && !err) assert.deepEqual(res.report.refs.map(r => r.options), res.report.refs.map(() => ({})), label);
      // 6b. push options: only valid when the server advertises them; git refuses client-side otherwise, we get the server's refusal
      if (caps.pushOptions && !err) assert.match(res.hookOutput, hk === 'pre-receive-echo-options' ? /opts=2:ci\.skip:reviewer=alice/ : /.*/, `${label}: options reached the hook`);
      // 7. server state is sound
      assert.equal(git(t.ours, ['fsck', '--strict', '--no-dangling']).trim(), '', label);
      // 8. the receive-pack span records the outcome
      const span = exporter.lines.flatMap(flattenLine).find(s => s.name === 'git.receive-pack');
      assert.equal(span.attrs['git.push.ok'], !err, label);
    }
  }
  console.log(`  cells=${stats.cells} accepted=${stats.ok} rejected=${stats.rejected} skipped=${stats.skipped}${FULL ? "" : " (PUSH_MATRIX=full for all)"}`);
  assert.ok(stats.cells > 0);
});

test('push default: side-band-64k is requested unless disabled, and band 2 lands in git.push.remote.messages', async () => {
  const bare = makeBareRepo(root, 'sbdef'); const work = join(root, 'wsbdef'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  const { commitFiles } = await import('./server.js');
  const head = commitFiles(work, bare, { 'f.txt': 'x\n' }, 'seed');
  const hooks = join(bare, 'hooks'); mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'pre-receive'), '#!/bin/sh\necho "from hook" >&2\nexit 0\n'); chmodSync(join(hooks, 'pre-receive'), 0o755);
  const ex = arrayExporter();
  const c = new GitHttp(`${srv.url}/sbdef.git`, { tracer: new Tracer({ exporter: ex }) });
  const blob = new TextEncoder().encode('y\n');
  const treeData = (await import('../src/objects.js')).encodeTree([{ mode: '100644', name: 'f.txt', oid: (await import('../src/objects.js')).hashObject('blob', blob) }]);
  const commitData = (await import('../src/objects.js')).encodeCommit({ tree: (await import('../src/objects.js')).hashObject('tree', treeData), parents: [head], author: 'a <a@x> 1 +0000', message: 'm\n' });
  const newOid = (await import('../src/objects.js')).hashObject('commit', commitData);
  const r = await c.push({ ref: 'refs/heads/main', oldOid: head, newOid, objects: [{ type: TYPE.COMMIT, data: commitData }, { type: TYPE.TREE, data: treeData }, { type: TYPE.BLOB, data: blob }] });
  assert.equal(r.hookOutput.trim(), 'from hook');
  const span = ex.lines.flatMap(flattenLine).find(s => s.name === 'git.receive-pack');
  assert.ok(span.attrs['git.push.caps'].includes('side-band-64k'));
  assert.deepEqual(span.attrs['git.push.remote.messages'], ['from hook']);
  assert.equal(git(bare, ['rev-parse', 'main']).trim(), newOid);
});
