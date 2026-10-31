// K concurrent writers on one repo, each editing its own file, retrying on cas_conflict.
// Property: every edit lands exactly once, history is linear, the ref is a CAS chain, nothing else changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { git, tmpRoot, makeBareRepo, startGitServer, commitFiles, fsckProblems } from './server.js';
import { editFile } from '../src/edit.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';

test('concurrent CAS writers converge; conflicts are observed and retried, never lost', async () => {
  const { root, cleanup } = tmpRoot();
  const srv = await startGitServer(root);
  try {
    const bare = makeBareRepo(root, 'cc');
    const work = join(root, 'w'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
    const K = 6, ROUNDS = 3;
    const files = Object.fromEntries(Array.from({ length: K }, (_, i) => [`dir${i % 2}/f${i}.txt`, `v0 marker${i} end\n`]));
    const base = commitFiles(work, bare, files, 'seed');
    const exporter = arrayExporter();
    const tracer = new Tracer({ exporter });
    const attempts = [];
    const writer = async i => {
      const cache = new Map();
      for (let r = 1; r <= ROUNDS; r++) {
        for (let tries = 0; ; tries++) {
          try {
            const res = await editFile(`${srv.url}/cc.git`, { path: `dir${i % 2}/f${i}.txt`, find: `v${r - 1} marker${i}`, replace: `v${r} marker${i}`, author: { name: `w${i}`, email: `w${i}@x` }, message: `w${i} r${r}` }, { tracer, cache });
            attempts.push({ i, r, tries, ok: true, res }); break;
          } catch (e) {
            if (e.code !== 'cas_conflict') throw e;
            attempts.push({ i, r, tries, ok: false });
            if (tries > 50) throw new Error('livelock');
          }
        }
      }
    };
    await Promise.all(Array.from({ length: K }, (_, i) => writer(i)));
    // all edits landed
    for (let i = 0; i < K; i++) assert.equal(git(bare, ['cat-file', '-p', `main:dir${i % 2}/f${i}.txt`]), `v${ROUNDS} marker${i} end\n`);
    // linear history: exactly K*ROUNDS commits above base, each with one parent, each touching exactly one file
    const log = git(bare, ['rev-list', '--first-parent', `${base}..main`]).trim().split('\n');
    assert.equal(log.length, K * ROUNDS);
    for (const c of log) {
      assert.equal(git(bare, ['rev-list', '--parents', '-n1', c]).trim().split(' ').length, 2);
      assert.equal(git(bare, ['diff-tree', '--no-commit-id', '--name-only', '-r', c]).trim().split('\n').length, 1);
    }
    assert.deepEqual(fsckProblems(bare), []); // losers' packs were unpacked before the CAS failed: dangling by design
    // conflicts were real: with 6 writers racing, at least one cas_conflict must have occurred and been retried
    // editFile redoes a cas_conflict once internally (attempt 1, span-linked); what the caller sees is only the conflicts
    // that lost twice. Every lost CAS, internal or surfaced, is one failed receive-pack span and one failed git.edit root.
    const surfaced = attempts.filter(a => !a.ok).length;
    const spans = exporter.lines.flatMap(flattenLine);
    const ngSpans = spans.filter(s => s.name === 'git.receive-pack' && s.attrs['git.push.ok'] === false);
    const lostRoots = spans.filter(s => s.name === 'git.edit' && s.attrs['git.edit.outcome'] === 'cas_conflict');
    const retried = spans.filter(s => s.name === 'git.edit' && s.attrs['git.edit.attempt'] === 1);
    assert.equal(ngSpans.length, lostRoots.length, 'every lost CAS is a failed receive-pack span and a failed root');
    assert.equal(retried.length, lostRoots.filter(s => s.attrs['git.edit.attempt'] === 0).length, 'every attempt-0 loss was retried once');
    assert.ok(retried.every(s => s.links.length === 1), 'retries link to the attempt they retry');
    assert.equal(surfaced, lostRoots.filter(s => s.attrs['git.edit.attempt'] === 1).length, 'callers see only double losses');
    const conflicts = ngSpans.length;
    assert.ok(ngSpans.every(s => /failed to update ref|fetch first|non-fast-forward|lock|incorrect old value provided/.test(s.attrs['git.push.ng.reason'])), ngSpans.map(s => s.attrs['git.push.ng.reason']).join('|'));
    assert.ok(conflicts > 0, 'expected at least one CAS conflict under contention');
    // successful pushes == landed commits
    assert.equal(spans.filter(s => s.name === 'git.receive-pack' && s.attrs['git.push.ok'] === true).length, K * ROUNDS);
  } finally { await srv.close(); cleanup(); }
});
