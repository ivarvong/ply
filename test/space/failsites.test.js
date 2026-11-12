// Gate c: every fail site in src/ was reached by at least one cell of a registered space, and every site the registry
// assigns to a merged space was reached by that space's runners. It reads the stacks test/space/failsite-hook.mjs
// recorded while the suite ran, so it runs after the suite, on the same PLY_FAILSITES directory:
//
//   rm -rf .failsites
//   PLY_FAILSITES=.failsites NODE_OPTIONS=--import=./test/space/failsite-hook.mjs vitest run
//   PLY_FAILSITES=.failsites PLY_FAILSITES_GATE=1 vitest run test/space/failsites.test.js
//
// The gate runs only with PLY_FAILSITES_GATE=1: the suite run that records includes this file too (vitest's glob), and
// there it would judge a half-written directory. CI's `test` job and `npm test` set both.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { join, isAbsolute } from 'node:path';
import { compute, judge, readRecords, ROOT } from './holes.js';
import { SAMPLED } from './registry.js';

const DIR = process.env.PLY_FAILSITES;
const records = DIR ? readRecords(isAbsolute(DIR) ? DIR : join(ROOT, DIR)) : null;
const skip = !DIR || !process.env['PLY_FAILSITES_GATE'];

const all = skip ? null : compute({ records: records ?? { frames: new Map(), runners: new Set() } });
const gate = (cat, what) => () => {
  const v = judge(cat, all.holes[cat]);
  console.log(`${cat}: ${v.mode} ${v.count} hole(s) (ratchet ${v.stored})${v.fixed.length ? `; ${v.fixed.length} fixed since the ratchet: lower it with \`npm run spaces -- --ratchet\`` : ''}`);
  for (const id of all.holes[cat].slice(0, 400)) console.log(`  ${v.problems.includes(id) ? 'NEW ' : ''}${id}`);
  assert.deepEqual(v.problems, [], `${cat}: ${v.problems.length} ${what} (${v.mode}):\n  ${v.problems.join('\n  ')}`);
};

test('the recorder ran: stacks were recorded by the runners of this suite', { skip }, () => {
  assert.ok(records && records.frames.size > 0, `no fail-site records under ${DIR}: was the suite run with --import ./test/space/failsite-hook.mjs?`);
  console.log(`${records.runners.size} runners recorded ${records.frames.size} distinct src frames; ${all.sites.length} fail sites, ${all.sites.length - all.holes.failsites.length - SAMPLED.length} reached`);
});
test('gate c: every fail() site in src/ is reached by a cell', { skip }, gate('failsites', 'fail site(s) no cell reached'));
test('gate c: every fail site the registry gives a merged space is reached by that space', { skip }, gate('claims', 'registry claim(s) the named space does not reach'));
// Reached is not judged. This prints the sites that were reached while no test read the error; it does not fail yet:
// the category has no baseline in test/space/ratchet.json (it needs one recorded run of the whole suite).
test('gate c, report only: reached fail sites whose error no test read', { skip }, () => {
  if (all.holes.observed === null) { console.log('observed: these records carry no observation data; not judged'); return; }
  console.log(`observed: ${all.holes.observed.length} of ${all.sites.length - all.holes.failsites.length - SAMPLED.length} reached fail site(s) had their error read by no test (report only, no ratchet baseline yet)`);
  for (const id of all.holes.observed.slice(0, 400)) console.log(`  ${id}`);
});
// CI is Linux. A macOS pass hides cells (APFS cannot store a non-UTF-8 ref name as a file, #43), so it never counts.
const notLinux = !skip && all.holes.linux === null;
if (notLinux) console.log(`these records are from ${[...new Set([...records.platforms.values()].flatMap(p => [...p]))].join(', ')}, not Linux: this pass does not count for the Linux gate (CI decides)`);
test('every merged CI space has run on Linux (each of its runners recorded on linux)', { skip: skip || notLinux }, gate('linux', 'merged CI space runner(s) with no Linux record'));
