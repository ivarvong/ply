// encodeTree is the one way ply writes a tree, and it must not write one `git fsck --strict` refuses.
// Every expectation here is git's: `git fsck --strict` over a fresh repository holding one hand-built tree object
// (written with `git hash-object --literally`, which checks nothing) is the verdict on each cell, `git mktree` builds
// git's own tree from the same entries, and `git ls-tree` reads back what was written. Where git has no say (a mode
// or an oid that is not a string) the expected refusal is derived by hand and said in a comment.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeTree, encodeEntries, treeSort } from '../src/objects.js';

const BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'; // git's empty blob
const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git's empty tree
const NULL = '0'.repeat(40);
const TYPE_OF = { 100644: 'blob', 100755: 'blob', 120000: 'blob', 40000: 'tree', 160000: 'commit' };

function git(dir, args, input) {
  const r = spawnSync('git', ['-C', dir, ...args], { input, maxBuffer: 1 << 28 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}`, err: `${r.stderr ?? ''}` };
}
function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ply-enc-tree-'));
  try {
    assert.equal(git(dir, ['init', '-q', '-b', 'main']).code, 0);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// One tree entry's bytes, written by hand from the format (`<mode> <name>\0<20 raw oid bytes>`): not ply's encoder.
const rawEntry = (mode, name, oid) => Buffer.concat([Buffer.from(`${mode} `, 'latin1'), Buffer.from(name, 'utf8'), Buffer.from([0]), Buffer.from(oid, 'hex')]);
// git's verdict on one tree object: `git fsck --strict` over a fresh repository that holds the tree and the empty
// blob and tree its entries point at (so a refusal is about the tree, never a broken link). hash-object's own check is
// not this verdict: it refuses INFO-level ids (gitattributesSymlink) that fsck --strict accepts and cannot see the
// ones fsck decides at the end of the run (gitmodulesBlob, gitattributesBlob).
const seed = dir => {
  assert.equal(git(dir, ['hash-object', '-t', 'blob', '-w', '--stdin'], '').out.trim(), BLOB);
  assert.equal(git(dir, ['hash-object', '-t', 'tree', '-w', '--stdin'], '').out.trim(), TREE);
};
const fsckAccepts = bytes => withRepo(dir => {
  seed(dir);
  const w = git(dir, ['hash-object', '-t', 'tree', '-w', '--stdin', '--literally'], bytes);
  assert.equal(w.code, 0, w.err);
  return git(dir, ['fsck', '--strict']);
});

// name, mode, oid: one entry each. Git decides which are refused.
const CELLS = [
  ['a', '100644', BLOB], ['a b', '100755', BLOB], ['-', '120000', BLOB], ['d', '40000', TREE], ['sub', '160000', BLOB],
  ['é', '100644', BLOB], ['日本', '40000', TREE], ['...', '100644', BLOB], ['git~2', '100644', BLOB], ['.gitx', '100644', BLOB],
  ['.gitmodules', '100644', BLOB], ['.gitattributes', '100644', BLOB], ['.gitattributes', '120000', BLOB], ['.gitignore', '120000', BLOB],
  // fsck.c fsck_tree, one cell per message id
  ['', '100644', BLOB], ['a/b', '100644', BLOB], ['a/', '40000', TREE], ['a\0b', '100644', BLOB], ['.', '100644', BLOB], ['..', '40000', TREE],
  ['.git', '40000', TREE], ['.GIT', '100644', BLOB], ['.Git', '100644', BLOB], ['.git ', '100644', BLOB], ['.git.', '100644', BLOB], ['git~1', '100644', BLOB],
  ['GIT~1', '40000', TREE], ['.g‌it', '100644', BLOB], ['.git::$INDEX_ALLOCATION', '100644', BLOB], ['a\\.git', '100644', BLOB],
  ['.gitmodules', '120000', BLOB], ['.gitmodules', '40000', TREE], ['.gitmodules', '160000', 'c'.repeat(40)], ['.GITMODULES.', '120000', BLOB], ['gitmod~1', '120000', BLOB],
  ['.gitmodu‌les', '120000', BLOB], ['.gitattributes', '40000', TREE], ['.gitattributes', '160000', 'c'.repeat(40)],
  ['a', '100644', NULL], ['d', '40000', NULL], ['sub', '160000', NULL],
  ['x'.repeat(4096), '100644', BLOB], ['x'.repeat(4097), '100644', BLOB],
];

test('encodeTree refuses exactly the single entries git fsck refuses, and writes git\'s bytes for the rest', () => {
  {
    const wrong = [];
    let refused = 0;
    for (const [name, mode, oid] of CELLS) {
      const want = fsckAccepts(rawEntry(mode, name, oid));
      if (want.code !== 0) refused += 1;
      const got = encodeTree([{ mode, name, oid }]);
      const label = `${mode} ${JSON.stringify(name.length > 40 ? `${name.slice(0, 8)}…(${name.length})` : name)} ${oid === NULL ? 'null-oid' : ''}`;
      if (got.ok !== (want.code === 0)) { wrong.push(`${label}: git ${want.code === 0 ? 'accepts' : `refuses (${want.err.trim().split('\n')[0]})`}, ply ${got.ok ? 'encodes' : `refuses (${got.error.message})`}`); continue; }
      if (got.ok) assert.deepEqual([...got.value], [...rawEntry(mode, name, oid)], label);
      else assert.equal(got.error.code, 'bad_request', label);
    }
    assert.ok(refused >= 25, `git refused only ${refused} cells: the oracle is not judging`);
    assert.deepEqual(wrong, []);
  }
});

// Modes, at the encoder itself (encodeEntries: what pushTree, commitChanges, merge and memtree call with a typed entry).
// The type says Mode; a JavaScript caller's value is whatever it is. Git decides each string cell: the entry's bytes are
// written by hand with that mode (UTF-8) and `git fsck --strict` accepts or refuses the tree. No cell holds a space or a
// NUL: those bytes would move the mode/name boundary and git would be judging a different entry.
const MODE_CELLS = [
  ['100644', BLOB], ['100755', BLOB], ['120000', BLOB], ['40000', TREE], ['160000', BLOB],
  // fsck zeroPaddedFilemode, badFilemode (100664 is an error under --strict), and modes decode_tree_entry cannot read
  ['0100644', BLOB], ['040000', TREE], ['100664', BLOB], ['100000', BLOB], ['644', BLOB], ['0', BLOB], ['', BLOB], ['abc', BLOB], ['100648', BLOB],
  // not ASCII: fullwidth digits (3 bytes each in UTF-8, 1 UTF-16 unit), one fullwidth digit among ASCII, an astral digit
  ['１００６４４', BLOB], ['10064４', BLOB], ['𝟏00644', BLOB], ['é', BLOB],
];
// Git's verdict on a mode has three values, and ply encodes only the first: `clean` (fsck --strict accepts and says
// nothing: the five modes git writes), `notice` (fsck --strict accepts and reports badFilemode, an INFO id that
// --strict does not raise: 100664, 100000, 644; git never writes these, canon_mode rewrites them), `refused`.
test('encodeEntries checks the mode itself: it encodes exactly the modes git fsck --strict passes without a badFilemode notice, with git\'s bytes, and never throws', () => {
  const wrong = [];
  const seen = { clean: [], notice: [], refused: [] };
  for (const [mode, oid] of MODE_CELLS) {
    const raw = Buffer.concat([Buffer.from(`${mode} a`, 'utf8'), Buffer.from([0]), Buffer.from(oid, 'hex')]);
    const want = fsckAccepts(raw);
    const verdict = want.code !== 0 ? 'refused' : /badFilemode/.test(`${want.out}${want.err}`) ? 'notice' : 'clean';
    seen[verdict].push(mode);
    const label = `mode ${JSON.stringify(mode)}`;
    let got;
    try { got = encodeEntries([{ mode, name: 'a', oid }]); } catch (x) { wrong.push(`${label}: encodeEntries throws ${x}`); continue; }
    if (got.ok !== (verdict === 'clean')) { wrong.push(`${label}: git ${verdict} (${`${want.err}${want.out}`.trim().split('\n')[0]}), ply ${got.ok ? `encodes ${JSON.stringify(Buffer.from(got.value).toString('latin1').slice(0, 12))}` : `refuses (${got.error.message})`}`); continue; }
    if (got.ok) assert.deepEqual([...got.value], [...raw], label);
    else assert.deepEqual([got.error.code, got.error.what, got.error.entry], ['bad_request', 'mode', 'a'], label);
  }
  // the oracle is judging: git passes its own five modes clean, and only those
  assert.deepEqual(seen.clean, ['100644', '100755', '120000', '40000', '160000']);
  assert.deepEqual(seen.notice, ['100664', '100000', '644']);
  assert.equal(seen.refused.length, MODE_CELLS.length - 8);
  assert.deepEqual(wrong, []);
});

test('encodeEntries checks every field itself: a mode or an oid that is not what the type says is bad_request, never a throw or a written tree', () => {
  // By hand: a tree entry's mode is one of five ASCII strings and its id is 20 bytes, written from 40 lowercase hex
  // digits. Nothing else has an encoding, so each of these has exactly one honest outcome: bad_request naming the field.
  const cyclic = {}; cyclic.self = cyclic;
  const cells = [
    ['mode', { mode: 100644, name: 'a', oid: BLOB }], ['mode', { mode: undefined, name: 'a', oid: BLOB }], ['mode', { mode: null, name: 'a', oid: BLOB }],
    ['mode', { mode: {}, name: 'a', oid: BLOB }], ['mode', { mode: 10n, name: 'a', oid: BLOB }], ['mode', { mode: cyclic, name: 'a', oid: BLOB }], ['mode', { mode: ['100644'], name: 'a', oid: BLOB }],
    ['oid', { mode: '100644', name: 'a', oid: 'abc' }], ['oid', { mode: '100644', name: 'a', oid: BLOB.toUpperCase() }], ['oid', { mode: '100644', name: 'a', oid: `${BLOB}0` }],
    ['oid', { mode: '100644', name: 'a', oid: BLOB.slice(1) }], ['oid', { mode: '100644', name: 'a', oid: `${BLOB.slice(0, 39)}g` }], ['oid', { mode: '100644', name: 'a', oid: 5 }],
    ['oid', { mode: '100644', name: 'a', oid: undefined }], ['oid', { mode: '100644', name: 'a', oid: '１'.repeat(40) }],
    // a name that is not a string, with a bad mode beside it: quoting the name must not throw either (a BigInt, a cycle)
    ['mode', { mode: '644', name: 5n, oid: BLOB }], ['mode', { mode: '644', name: cyclic, oid: BLOB }],
  ];
  const wrong = [];
  for (const [what, entry] of cells) {
    for (const [fn, encode] of [['encodeEntries', encodeEntries], ['encodeTree', encodeTree]]) {
      const label = `${fn} ${what} mode:${typeof entry.mode} name:${typeof entry.name} oid:${typeof entry.oid === 'string' ? entry.oid.length : typeof entry.oid}`;
      let got;
      try { got = encode([entry]); } catch (x) { wrong.push(`${label}: throws ${x}`); continue; }
      if (got.ok) { wrong.push(`${label}: encodes ${got.value.length} bytes`); continue; }
      // a name that is not a string is refused for the name by the encoder and for the mode by treeEntryOf: either names a field
      if (got.error.code !== 'bad_request' || (got.error.what !== what && got.error.what !== 'tree entry name')) wrong.push(`${label}: ${got.error.code} what=${got.error.what}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('encodeTree of one entry never writes a tree git reads as other entries (a NUL in the name)', () => {
  withRepo(dir => {
    // "a", NUL, 20 chosen bytes, then a second entry's mode and name: the caller's one name frames two entries
    const name = `a\0${'B'.repeat(20)}100644 evil`;
    const got = encodeTree([{ mode: '100644', name, oid: BLOB }]);
    if (!got.ok) { assert.equal(got.error.code, 'bad_request'); assert.equal(got.error.entry, name); return; }
    const written = git(dir, ['hash-object', '-t', 'tree', '-w', '--stdin', '--literally'], got.value);
    assert.equal(written.code, 0, written.err);
    const listed = git(dir, ['ls-tree', '-z', written.out.trim()]).out.split('\0').filter(Boolean);
    assert.deepEqual(listed, [`100644 blob ${BLOB}\ta`], 'one entry in, one entry out');
  });
});

// A small deterministic generator (mulberry32): the corpus is the same on every run
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Names that are prefixes of each other, bytes on both sides of '/' (0x2f): '-' '.' below it, '0' above; non-ASCII
const PIECES = ['a', 'ab', 'a.', 'a-', 'a0', 'a+', 'A', 'b', '.x', '-', '0', 'é', 'é', '日本', '😀', 'z', '~', ' ', '_', 'a b', 'ÿ', 'aa'];
function corpus(seed, count) {
  const next = rng(seed);
  const pick = list => list[Math.floor(next() * list.length)];
  const trees = [];
  for (let t = 0; t < count; t++) {
    const names = new Set();
    const n = 1 + Math.floor(next() * 40);
    while (names.size < n) names.add(Array.from({ length: 1 + Math.floor(next() * 3) }, () => pick(PIECES)).join(''));
    trees.push([...names].map(name => { const mode = pick(['100644', '100755', '120000', '40000', '40000', '160000']); return { mode, name, oid: mode === '40000' ? TREE : BLOB }; }));
  }
  return trees;
}

test('a generated corpus: ply encodes the tree git mktree builds, git fsck accepts it, and treeSort is git ls-tree\'s order', () => {
  withRepo(dir => {
    for (const entries of corpus(20261111, 150)) {
      const stdin = entries.map(e => `${e.mode} ${TYPE_OF[e.mode]} ${e.oid}\t${e.name}\0`).join('');
      const made = git(dir, ['mktree', '-z', '--missing'], stdin);
      assert.equal(made.code, 0, made.err);
      const want = made.out.trim();
      const enc = encodeTree(entries);
      assert.ok(enc.ok, enc.ok ? '' : enc.error.message);
      const hashed = git(dir, ['hash-object', '-t', 'tree', '-w', '--stdin'], enc.value);
      assert.equal(hashed.code, 0, `git refuses what ply encoded: ${hashed.err}`);
      assert.equal(hashed.out.trim(), want, 'the oid git mktree gives the same entries');
      const order = git(dir, ['ls-tree', '-z', '--name-only', want]).out.split('\0').filter(Boolean);
      const sorted = treeSort(entries);
      assert.ok(sorted.ok);
      assert.deepEqual(sorted.value.map(e => e.name), order);
    }
    seed(dir);
    const all = git(dir, ['fsck', '--strict']);
    assert.equal(all.code, 0, `git fsck --strict over every tree ply encoded: ${all.err}`);
  });
});
