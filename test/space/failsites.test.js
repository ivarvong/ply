// Gate c: every fail site in src/ was reached by at least one cell of a registered space, and every site the registry
// assigns to a merged space was reached by that space's runners. It reads the stacks test/space/failsite-hook.mjs
// recorded while the suite ran, so it runs after the suite, on the same PLY_FAILSITES directory:
//
//   rm -rf .failsites
//   PLY_FAILSITES=.failsites node --import ./test/space/failsite-hook.mjs --test <the unit tests>
//   PLY_FAILSITES=.failsites node --test test/space/failsites.test.js
//
// Without PLY_FAILSITES the gate is skipped (it has nothing to read); CI and `npm test` always set it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, isAbsolute } from 'node:path';
import { compute, judge, readRecords, ROOT } from './holes.js';
import { SAMPLED } from './registry.js';

const DIR = process.env.PLY_FAILSITES;
const records = DIR ? readRecords(isAbsolute(DIR) ? DIR : join(ROOT, DIR)) : null;
const skip = !DIR ? 'PLY_FAILSITES is not set: run the suite under test/space/failsite-hook.mjs first' : false;

const all = skip ? null : compute({ records: records ?? { frames: new Map(), runners: new Set() } });
const gate = (cat, what) => t => {
  const v = judge(cat, all.holes[cat]);
  t.diagnostic(`${cat}: ${v.mode} ${v.count} hole(s) (ratchet ${v.stored})${v.fixed.length ? `; ${v.fixed.length} fixed since the ratchet: lower it with \`node scripts/spaces.mjs --ratchet\`` : ''}`);
  for (const id of all.holes[cat].slice(0, 400)) t.diagnostic(`  ${v.problems.includes(id) ? 'NEW ' : ''}${id}`);
  assert.deepEqual(v.problems, [], `${cat}: ${v.problems.length} ${what} (${v.mode}):\n  ${v.problems.join('\n  ')}`);
};

test('the recorder ran: stacks were recorded by the runners of this suite', { skip }, t => {
  assert.ok(records && records.frames.size > 0, `no fail-site records under ${DIR}: was the suite run with --import ./test/space/failsite-hook.mjs?`);
  t.diagnostic(`${records.runners.size} runners recorded ${records.frames.size} distinct src frames; ${all.sites.length} fail sites, ${all.sites.length - all.holes.failsites.length - SAMPLED.length} reached`);
});
test('gate c: every fail() site in src/ is reached by a cell', { skip }, gate('failsites', 'fail site(s) no cell reached'));
test('gate c: every fail site the registry gives a merged space is reached by that space', { skip }, gate('claims', 'registry claim(s) the named space does not reach'));
