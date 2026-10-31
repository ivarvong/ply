// The fsck oracle's own mutation test: every suite's "git fsck --strict is clean" goes through fsckProblems /
// fsckProblemsOf in test/server.js, so each must report each way git 2.50 says an object is bad. Feed it known-bad
// objects (duplicate entry, zero-padded mode, bad mode, bad ident, missing tagger, missing object, damaged object
// file, dangling) and it must say so; a clean store must say nothing. The old `l.startsWith('error:')` filter returned
// [] for every one of these object problems, so its `assert.deepEqual(..., [])` could not fail.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitBuf, fsck, fsckProblems, fsckProblemsOf } from './server.js';

const run = (dir, args, input) => gitBuf(dir, args, input).toString().trim();
const lit = (dir, type, data) => run(dir, ['hash-object', '-t', type, '-w', '--stdin', '--literally'], Buffer.from(data));
const entry = (mode, name, oid) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')]);
const ident = 'A <a@b.c> 1700000000 +0000';

function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ply-fsck-oracle-'));
  try {
    run(dir, ['init', '-q', '-b', 'main']);
    const blob = run(dir, ['hash-object', '-w', '--stdin'], Buffer.from('x\n'));
    return fn(dir, blob);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
// a commit over `tree`, on main, so the object is reachable and connectivity is checked too
const onMain = (dir, tree, who = ident) => { const c = lit(dir, 'commit', `tree ${tree}\nauthor ${who}\ncommitter ${who}\n\nm\n`); run(dir, ['update-ref', 'refs/heads/main', c]); return c; };

test('a clean store: [] from both, exit 0', () => withRepo((dir, blob) => {
  const tree = lit(dir, 'tree', entry('100644', 'a', blob));
  const c = onMain(dir, tree);
  assert.equal(fsck(dir, ['--no-dangling']).status, 0);
  assert.deepEqual(fsckProblems(dir), []);
  assert.deepEqual(fsckProblemsOf(dir, tree), []);
  assert.deepEqual(fsckProblemsOf(dir, c), []);
}));

// [label, build(dir, blob) → oid of the bad object, the msgId git reports, the exit fsck --strict gives]
const BAD = [
  ['duplicate tree entry', (d, b) => lit(d, 'tree', Buffer.concat([entry('100644', 'a', b), entry('100644', 'a', b)])), /^error in tree [0-9a-f]{40}: duplicateEntries: /, 1],
  ['zero-padded mode', (d, b) => lit(d, 'tree', entry('0100644', 'a', b)), /^error in tree [0-9a-f]{40}: zeroPaddedFilemode: /, 1],
  ['tree entries out of order', (d, b) => lit(d, 'tree', Buffer.concat([entry('100644', 'b', b), entry('100644', 'a', b)])), /^error in tree [0-9a-f]{40}: treeNotSorted: /, 1],
  ['.git in a tree', (d, b) => lit(d, 'tree', entry('100644', '.git', b)), /^error in tree [0-9a-f]{40}: hasDotgit: /, 1],
  // an INFO id: still a warning under --strict, and fsck exits 0 — an exit-code-only oracle misses it
  ['bad file mode 100664', (d, b) => lit(d, 'tree', entry('100664', 'a', b)), /^warning in tree [0-9a-f]{40}: badFilemode: /, 0],
  ['bad ident (no "<")', (d, b) => { const t = lit(d, 'tree', entry('100644', 'a', b)); return onMain(d, t, 'A a@b.c> 1700000000 +0000'); }, /^error in commit [0-9a-f]{40}: badName: /, 1],
  ['bad timezone', (d, b) => { const t = lit(d, 'tree', entry('100644', 'a', b)); return onMain(d, t, 'A <a@b.c> 1700000000 +00'); }, /^error in commit [0-9a-f]{40}: badTimezone: /, 1],
  ['tag without a tagger', (d, b) => { const t = lit(d, 'tree', entry('100644', 'a', b)); const c = onMain(d, t); const tag = lit(d, 'tag', `object ${c}\ntype commit\ntag v1\n\nm\n`); run(d, ['update-ref', 'refs/tags/v1', tag]); return tag; }, /^warning in tag [0-9a-f]{40}: missingTaggerEntry: /, 0],
  // stdout, not stderr; exit 2
  ['missing tree', d => onMain(d, 'a'.repeat(40)), /^broken link from +commit [0-9a-f]{40} to +tree a{40}$/, 2],
];

for (const [label, build, report, exit] of BAD) {
  test(`the oracle can fail: ${label}`, () => withRepo((dir, blob) => {
    const oid = build(dir, blob);
    const { status, lines } = fsck(dir, ['--no-dangling']);
    assert.equal(status, exit, lines.join('\n'));
    assert.ok(lines.some(l => report.test(l)), `git's report: ${lines.join(' | ')}`);
    assert.ok(!lines.some(l => l.startsWith('error:')), 'git 2.50 never prefixes an object problem with "error:" (what the old filter required)');
    const all = fsckProblems(dir);
    assert.notDeepEqual(all, [], 'fsckProblems reports it');
    assert.ok(all.some(l => report.test(l)), all.join(' | '));
    assert.ok(fsckProblemsOf(dir, oid).some(l => report.test(l)), 'fsckProblemsOf pins it to the object');
  }));
}

test('the oracle can fail: a damaged loose object file (the `error:` shape)', () => withRepo((dir, blob) => {
  const tree = lit(dir, 'tree', entry('100644', 'a', blob));
  onMain(dir, tree);
  const path = join(dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
  chmodSync(path, 0o644); writeFileSync(path, Buffer.from('not zlib'));
  const p = fsckProblems(dir);
  assert.ok(p.some(l => l.startsWith('error:')), p.join(' | '));
  assert.ok(p.some(l => /exit [1-9]/.test(l)), p.join(' | '));
}));

test('dangling objects: silenced by default, reported with dangling: true', () => withRepo((dir, blob) => {
  onMain(dir, lit(dir, 'tree', entry('100644', 'a', blob)));
  const stray = run(dir, ['hash-object', '-w', '--stdin'], Buffer.from('stray\n'));
  assert.deepEqual(fsckProblems(dir), []);
  assert.deepEqual(fsckProblems(dir, { dangling: true }), [`dangling blob ${stray}`]);
}));

test('fsckProblemsOf: one bad object does not taint a good one in the same store', () => withRepo((dir, blob) => {
  const bad = lit(dir, 'tree', Buffer.concat([entry('100644', 'a', blob), entry('100644', 'a', blob)]));
  const good = lit(dir, 'tree', entry('100644', 'b', blob));
  assert.notDeepEqual(fsckProblems(dir), []);
  assert.deepEqual(fsckProblemsOf(dir, good), []);
  assert.equal(fsckProblemsOf(dir, bad).length, 1);
}));

test('refusals: --connectivity-only (skips every format check) and an abbreviated oid', () => withRepo((dir, blob) => {
  const bad = lit(dir, 'tree', Buffer.concat([entry('100644', 'a', blob), entry('100644', 'a', blob)]));
  onMain(dir, bad);
  // the fact behind the refusal: git itself passes a reachable duplicate-entry tree under --connectivity-only
  assert.equal(run(dir, ['fsck', '--strict', '--connectivity-only', '--no-dangling']), '');
  assert.throws(() => fsck(dir, ['--connectivity-only']), /not an oracle/);
  assert.throws(() => fsckProblemsOf(dir, bad.slice(0, 7)), /full oid/);
}));
