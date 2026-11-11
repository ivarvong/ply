// The exported treeSort against git's own ordering, and against a counter: each entry's key is computed once.
// The order is git's: `git mktree` builds the tree from the entries (given in a shuffled order) and `git ls-tree`
// lists it. The names differ only by what git's directory rule decides: a directory `a` sorts as `a/` (0x2f), so it
// goes after `a-` (0x2d) and `a.` (0x2e), before `a0` (0x30), and after the file that is only a longer name's prefix.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { treeSort } from '../src/objects.js';

const BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'; // git's empty blob
const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git's empty tree
const TYPE_OF = { 100644: 'blob', 100755: 'blob', 120000: 'blob', 40000: 'tree', 160000: 'commit' };

function git(dir, args, input) {
  const r = spawnSync('git', ['-C', dir, ...args], { input, maxBuffer: 1 << 28 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}`, err: `${r.stderr ?? ''}` };
}
// git's order for these entries: what ls-tree lists for the tree mktree built from them
function gitOrder(dir, entries) {
  const stdin = entries.map(e => `${e.mode} ${TYPE_OF[e.mode]} ${e.mode === '40000' ? TREE : BLOB}\t${e.name}\0`).join('');
  const made = git(dir, ['mktree', '-z', '--missing'], stdin);
  assert.equal(made.code, 0, made.err);
  return git(dir, ['ls-tree', '-z', '--name-only', made.out.trim()]).out.split('\0').filter(Boolean);
}
// mulberry32: the same shuffle on every run
function shuffled(list, seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

test('treeSort is git ls-tree\'s order on names that differ only by the directory slash rule', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ply-tree-sort-'));
  try {
    assert.equal(git(dir, ['init', '-q', '-b', 'main']).code, 0);
    let moved = 0;
    for (const base of ['a', 'ab', 'é', '日本', 'a b', '😀']) {
      // the bytes on both sides of '/' after the base, and longer names the base is a prefix of
      const around = ['-', '.', '0', '+', ' ', '~', '\u0001', 'é', '-x', '.x', '0x'].map(s => `${base}${s}`);
      for (const baseMode of ['40000', '100644', '160000', '120000']) {
        for (const otherMode of ['100644', '40000']) {
          const entries = shuffled([{ mode: baseMode, name: base }, ...around.map(name => ({ mode: otherMode, name }))], base.length + around.length);
          const want = gitOrder(dir, entries);
          const got = treeSort(entries);
          assert.ok(got.ok);
          assert.deepEqual(got.value.map(e => e.name), want, `${base} as ${baseMode} among ${otherMode}`);
          // the entries themselves come back, not copies
          for (const e of got.value) assert.ok(entries.includes(e));
          if (want[0] !== base) moved += 1;
        }
      }
    }
    // the rule is exercised: a directory base does not sort first (`a-`, `a.` and more go before `a/`), a file base does
    assert.ok(moved >= 12, `the base moved in only ${moved} trees`);
    // a larger tree: 3 000 names in three shapes, a third of them directories
    const big = shuffled(Array.from({ length: 3000 }, (_, i) => ({ mode: i % 3 === 0 ? '40000' : '100644', name: `${['n', 'n.', 'n-'][i % 3]}${i % 7}${i}` })), 3000);
    const sorted = treeSort(big);
    assert.ok(sorted.ok);
    assert.deepEqual(sorted.value.map(e => e.name), gitOrder(dir, big));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('treeSort computes each key once: an entry\'s name is read once, however many comparisons the sort makes', () => {
  // The expected count is the definition, not a measurement: n entries, n reads. A sort that builds its keys inside the
  // comparator reads each name about 2 log2(n) times (2 000 entries: over 40 000 reads).
  for (const n of [1, 2, 50, 2000]) {
    let reads = 0;
    const entries = shuffled(Array.from({ length: n }, (_, i) => {
      const name = `f${i}`;
      return { mode: i % 2 === 0 ? '40000' : '100644', get name() { reads += 1; return name; } };
    }), n);
    const got = treeSort(entries);
    assert.ok(got.ok);
    assert.equal(got.value.length, n);
    assert.equal(reads, n, `${n} entries`);
  }
});

test('treeSort refuses the first entry, in the caller\'s order, whose name has no byte form: every key is computed, compared or not', () => {
  const e = (name, mode = '100644') => ({ mode, name });
  // By hand: U+D800 to U+D803 are lone surrogates; the refusal names the first one in the list as given
  const lone = hex => ({ ok: false, error: `tree entry name: lone surrogate U+${hex} is no byte sequence` });
  const run = entries => { const r = treeSort(entries); return r.ok ? { ok: true } : { ok: false, error: r.error.message }; };
  assert.deepEqual(run([e('\ud800')]), lone('D800'), 'one entry: its key is computed too');
  assert.deepEqual(run([e('a'), e('\ud801')]), lone('D801'));
  assert.deepEqual(run([e('\ud801'), e('\ud800')]), lone('D801'));
  assert.deepEqual(run([e('z'), e('\ud802'), e('a'), e('\ud803', '40000')]), lone('D802'));
  assert.deepEqual(run([e('z'), e('y'), e('x'), e('w'), e('v'), e('u'), e('t'), e('s'), e('r'), e('q'), e('p'), e('\ud803', '40000'), e('\ud800')]), lone('D803'));
  assert.deepEqual(run([]), { ok: true });
});

test('treeSort refuses a name that is not a string, and an entry that is no object, as bad_request at 1, 2 and 3 entries: it never throws', () => {
  // By hand, from the rule: a name that is not a string is refused as `tree entry name must be a string`, whatever the
  // mode, the position and the list length. None of this is computed by the code under test.
  const WANT = { ok: false, code: 'bad_request', message: 'tree entry name must be a string', what: 'tree entry name' };
  const run = entries => {
    try {
      const r = treeSort(entries);
      return r.ok ? { ok: true, names: r.value.map(e => e.name) } : { ok: false, code: r.error.code, message: r.error.message, what: r.error.what };
    } catch (error) {
      return { threw: String(error) };
    }
  };
  const a = { mode: '100644', name: 'a' };
  const b = { mode: '40000', name: 'b' };
  let conversions = 0;
  // the four kinds of name: the last two cannot be turned into a string at all
  const kinds = {
    null: () => null,
    undefined: () => undefined,
    'a Symbol': () => Symbol('s'),
    'an object whose toString throws': () => ({ toString() { conversions += 1; throw new Error('boom'); } }),
  };
  let cases = 0;
  for (const [kind, make] of Object.entries(kinds)) {
    // a directory's key is its name and a `/` (where the name used to be concatenated), a file's key is its name
    for (const mode of ['40000', '100644']) {
      const bad = () => ({ mode, name: make() });
      // every position of the bad entry, in a list of one, of two and of three
      const lists = { 1: [[bad()]], 2: [[bad(), a], [a, bad()]], 3: [[bad(), a, b], [a, bad(), b], [a, b, bad()]] };
      for (const [length, sameLength] of Object.entries(lists)) {
        for (const [at, list] of sameLength.entries()) {
          assert.equal(list.length, Number(length));
          assert.deepEqual(run(list), WANT, `name ${kind}, mode ${mode}, ${length} entries, bad entry at ${at}`);
          cases += 1;
        }
      }
    }
  }
  // 4 kinds x 2 modes x (1 + 2 + 3) lists
  assert.equal(cases, 48);
  assert.equal(conversions, 0, 'a name that is not a string is never converted to one');
  // an entry that is no object has no name: the same refusal, at the same three lengths
  for (const none of [null, undefined]) {
    assert.deepEqual(run([none]), WANT, `[${none}]`);
    assert.deepEqual(run([none, a]), WANT, `[${none}, a]`);
    assert.deepEqual(run([a, none]), WANT, `[a, ${none}]`);
    assert.deepEqual(run([none, a, b]), WANT, `[${none}, a, b]`);
    assert.deepEqual(run([a, none, b]), WANT, `[a, ${none}, b]`);
    assert.deepEqual(run([a, b, none]), WANT, `[a, b, ${none}]`);
  }
  // the refusal is still the first entry in the caller's order: U+D800 is a lone surrogate, a string with no byte form
  const lone = { mode: '100644', name: '\ud800' };
  assert.deepEqual(run([lone, { mode: '40000', name: null }]), { ...WANT, message: 'tree entry name: lone surrogate U+D800 is no byte sequence' });
  assert.deepEqual(run([{ mode: '40000', name: null }, lone]), WANT);
  // and string names are sorted as before, at the same lengths. By hand: the directory b is `b/`; `a` (0x61) < `b` (0x62),
  // and `b-` (0x2d after the b) < `b/` (0x2f)
  assert.deepEqual(run([b]), { ok: true, names: ['b'] });
  assert.deepEqual(run([b, a]), { ok: true, names: ['a', 'b'] });
  assert.deepEqual(run([b, { mode: '100644', name: 'b-' }, a]), { ok: true, names: ['a', 'b-', 'b'] });
});
