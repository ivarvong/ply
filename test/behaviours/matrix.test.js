// The coverage matrix is checked, not remembered: every op is an export of its module, every test anchor is text in its
// file, reference-git evidence cites a file that runs real git, run evidence names a recorded run and check, and
// COVERAGE.md is the matrix rendered. The types (test/behaviours/types.ts, types.typetest.ts) refuse the rest.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BEHAVIOURS } from './matrix.ts';
import { RUNS } from './runs.ts';
import { AREAS, EVIDENCE_KINDS } from './types.ts';
import { renderMd, evidenceOf } from '../../scripts/coverage-matrix.mjs';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Test sources write an apostrophe inside a quoted name as \' : an anchor matches either spelling.
const contains = (src, anchor) => src.includes(anchor) || src.includes(anchor.replace(/'/g, "\\'"));

test('COVERAGE.md is `npm run coverage-matrix -- --md` of the matrix', () => {
  assert.equal(read('COVERAGE.md'), renderMd(), 'COVERAGE.md is stale: run `npm run coverage-matrix -- --md`');
});

test('ids are unique, each id is `<area>.<slug>`, and every area has behaviours', () => {
  const ids = BEHAVIOURS.map(b => b.id);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'duplicate ids');
  for (const b of BEHAVIOURS) {
    assert.ok(AREAS.includes(b.area), `${b.id}: unknown area ${b.area}`);
    assert.match(b.id, new RegExp(`^${escapeRe(b.area)}\\.[a-z0-9]+(-[a-z0-9]+)*$`), `${b.id}: id must be ${b.area}.<kebab-slug>`);
  }
  for (const a of AREAS) assert.ok(BEHAVIOURS.some(b => b.area === a), `area ${a} has no behaviours`);
});

test('the status rules hold at run time too: verified has evidence, unsupported names no op and says why', () => {
  for (const b of BEHAVIOURS) {
    if (b.status.tag === 'verified') assert.ok(b.status.evidence.length > 0, `${b.id}: verified with no evidence`);
    if (b.status.tag === 'unsupported') {
      assert.equal(b.ops.length, 0, `${b.id}: unsupported but names ops`);
      assert.ok(b.status.why.trim().length > 0, `${b.id}: unsupported with no reason`);
    } else assert.ok(b.ops.length > 0, `${b.id}: ${b.status.tag} names no ply op`);
    for (const e of evidenceOf(b)) assert.ok(EVIDENCE_KINDS.includes(e.kind), `${b.id}: unknown evidence kind ${e.kind}`);
  }
});

test('every ply op is an export of its src module (grep, not memory)', () => {
  const bad = [];
  for (const b of BEHAVIOURS) for (const o of b.ops) {
    if (!existsSync(join(ROOT, o.module))) { bad.push(`${b.id}: ${o.module} does not exist`); continue; }
    const re = new RegExp(`export\\s+(async\\s+)?(function\\*?|const|let|class)\\s+${escapeRe(o.symbol)}\\b`);
    if (!re.test(read(o.module))) bad.push(`${b.id}: ${o.module} does not export ${o.symbol}`);
  }
  assert.deepEqual(bad, []);
});

test('every cited test exists and contains its anchor', () => {
  const bad = [];
  for (const b of BEHAVIOURS) {
    const refs = [...b.tests, ...evidenceOf(b).filter(e => e.ref.tag === 'test').map(e => e.ref)];
    for (const r of refs) {
      if (!existsSync(join(ROOT, r.path))) { bad.push(`${b.id}: ${r.path} does not exist`); continue; }
      if (!contains(read(r.path), r.anchor)) bad.push(`${b.id}: ${r.path} does not contain ${JSON.stringify(r.anchor)}`);
    }
  }
  assert.deepEqual(bad, []);
});

// A file runs real git if it, or a test helper it imports directly (a module under test/, never src/), starts the git
// http-backend server or spawns git.
const RUNS_GIT = /\bstartGitServer\(|(spawnSync|execFileSync|spawn|execFile)\(\s*['"]git['"]/;
const runsGit = path => {
  const src = read(path);
  if (RUNS_GIT.test(src)) return true;
  const local = [...src.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)].map(m => join(dirname(path), m[1]));
  return local.filter(p => p.startsWith('test/')).some(p => {
    const candidates = [p, p.replace(/\.js$/, '.ts')];
    return candidates.some(c => existsSync(join(ROOT, c)) && RUNS_GIT.test(read(c)));
  });
};

test('ply_vs_reference_git evidence cites a file that runs real git', () => {
  const bad = [];
  for (const b of BEHAVIOURS) for (const e of evidenceOf(b)) {
    if (e.kind === 'ply_vs_reference_git' && !runsGit(e.ref.path)) bad.push(`${b.id}: ${e.ref.path} runs no git`);
  }
  assert.deepEqual(bad, []);
});

test('run evidence names a recorded run, a check that run recorded, and a kind the run can back', () => {
  const bad = [];
  for (const b of BEHAVIOURS) for (const e of evidenceOf(b)) {
    if (e.ref.tag !== 'run') continue;
    const run = RUNS[e.ref.run];
    if (run === undefined) { bad.push(`${b.id}: no run ${e.ref.run}`); continue; }
    if (!run.checks.includes(e.ref.check)) bad.push(`${b.id}: ${e.ref.run} recorded no check ${JSON.stringify(e.ref.check)}`);
    if (!run.kinds.includes(e.kind)) bad.push(`${b.id}: ${e.ref.run} cannot back ${e.kind}`);
  }
  assert.deepEqual(bad, []);
});
