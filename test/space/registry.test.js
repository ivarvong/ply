// Gates a and b, the registry's own consistency, and SPACES.md drift. See test/space/holes.js for the categories and the
// ratchet; `npm run spaces --` prints the same report.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compute, judge, registryProblems, ROOT, ratchet, frameOf } from './holes.js';
import { SPACES, DECISIONS, SAMPLED } from './registry.js';
import { renderMd } from '../../scripts/spaces.mjs';

const all = compute();
const show = (cat, v) => {
  console.log(`${cat}: ${v.mode} ${v.count} hole(s) (ratchet ${v.stored})${v.fixed.length ? `; ${v.fixed.length} fixed since the ratchet: lower it with \`npm run spaces -- --ratchet\`` : ''}`);
  for (const id of (v.mode === 'ENFORCE' ? v.problems : all.holes[cat]).slice(0, 400)) console.log(`  ${v.problems.includes(id) ? 'NEW ' : ''}${id}`);
};
const gate = (cat, what) => () => {
  const v = judge(cat, all.holes[cat]);
  show(cat, v);
  assert.deepEqual(v.problems, [], `${cat}: ${v.problems.length} ${what} (${v.mode}):\n  ${v.problems.join('\n  ')}`);
};

test('the ratchet: REPORT passes known holes and fails a new one; ENFORCE (stored 0) fails any; a fixed hole passes', () => {
  const report = judge('x', ['a', 'b'], { count: 3, ids: ['a', 'b', 'c'] });
  assert.equal(report.mode, 'REPORT');
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.fixed, ['c']);
  assert.deepEqual(judge('x', ['a', 'd'], { count: 3, ids: ['a', 'b', 'c'] }).problems, ['d'], 'a hole not in the ratchet fails even when the count went down');
  const enforce = judge('x', ['a'], { count: 0, ids: [] });
  assert.equal(enforce.mode, 'ENFORCE');
  assert.deepEqual(enforce.problems, ['a']);
});

test('the registry is well-formed: every rule names a registered space and one of its axes, or gives a reason', () => {
  assert.deepEqual(registryProblems(), []);
});

test('a pending space whose runners are all in the tree is a registry problem (it is merged)', () => {
  const base = { kind: 'curated', run: 'ci', oracle: 'hand', axes: [{ tag: 'x' }] };
  // this very file exists, so a space that names it as its runner cannot be pending
  assert.deepEqual(registryProblems([{ ...base, name: 'synthetic', status: 'pending', pending: '#1', runners: ['test/space/registry.test.js'] }]),
    ["space synthetic: pending (#1) but every runner is in the tree; it is merged: status: 'main'"]);
  // a runner that is not in the tree yet: still pending, no problem
  assert.deepEqual(registryProblems([{ ...base, name: 'synthetic', status: 'pending', pending: '#1', runners: ['test/not-written-yet.test.js'] }]), []);
});

test('claims: a site claimed by a space whose runner ran without reaching it is a hole, pending or merged', () => {
  // One real fail site, claimed by exact rule (an exact rule wins over every glob) for a synthetic space with one
  // runner. Expected values are stated here, not derived from compute(): the runner ran and reached nothing, so the
  // one claim is the one hole; once that runner's record holds the site's frame, there is none.
  const sampled = new Set(SAMPLED.map(s => s.id));
  const site = all.sites.find(p => !sampled.has(p.id));
  const runner = 'test/synthetic-runner.test.js';
  for (const status of ['pending', 'main']) {
    const spaces = [...SPACES, { name: 'synthetic', status, pending: '#1', kind: 'curated', run: 'manual', oracle: 'hand', axes: [{ tag: 'x' }], runners: [runner] }];
    // last in the list: among exact rules for one id the later wins (resolve() keeps a Map by match)
    const decisions = [...DECISIONS, { match: site.id, space: 'synthetic', axisTag: 'x' }];
    const ran = { frames: new Map(), runners: new Set([runner]), platforms: new Map() };
    assert.deepEqual(compute({ records: ran, spaces, decisions }).holes.claims.filter(h => h.endsWith(' -> synthetic')), [`${site.id} -> synthetic`], `${status}: reached by nobody`);
    const other = { frames: new Map([[frameOf(site), new Set(['test/some-other.test.js'])]]), runners: new Set([runner, 'test/some-other.test.js']), platforms: new Map() };
    assert.deepEqual(compute({ records: other, spaces, decisions }).holes.claims.filter(h => h.endsWith(' -> synthetic')), [`${site.id} -> synthetic`], `${status}: reached only by another runner`);
    const reached = { frames: new Map([[frameOf(site), new Set([runner])]]), runners: new Set([runner]), platforms: new Map() };
    assert.deepEqual(compute({ records: reached, spaces, decisions }).holes.claims.filter(h => h.endsWith(' -> synthetic')), [], `${status}: reached by its runner`);
  }
});

test('gate a: every decision point in src/ is in the registry', gate('decisions', 'decision point(s) not in test/space/registry.js DECISIONS'));
test('gate b: every git-manifest entry is covered by a space or excluded with a reason', gate('git', 'git check(s) neither covered nor excluded in test/space/registry.js GIT'));
test('no stale rules: every registry rule still names something', gate('stale', 'registry rule(s) that match nothing'));

test('the git manifest is the pinned git version and the ratchet lists every category', () => {
  assert.equal(all.man.git.tag, 'v2.50.0');
  assert.ok(all.man.entries.length > 300, 'the manifest lost entries');
  for (const c of ['decisions', 'git', 'failsites', 'claims', 'linux', 'stale']) assert.ok(ratchet().categories[c], `ratchet.json has no ${c}`);
});

test('SPACES.md is generated from the registry (npm run spaces -- --md)', () => {
  assert.equal(readFileSync(join(ROOT, 'SPACES.md'), 'utf8'), renderMd(all));
});
