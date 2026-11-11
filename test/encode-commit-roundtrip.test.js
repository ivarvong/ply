// encodeCommit is held to the reader (objects/encodecommit-not-held-to-parsecommit): what it returns ok, git stores as
// is and parseCommit reads back as the commit that was given; anything else is bad_request, never a throw.
// The judges are git's: `git hash-object -t commit --stdin` (fsck) on bytes built here by hand from the commit format,
// `git cat-file commit` for what git stored, and `git show -s --format` for how git reads it.
import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeCommit, parseCommit } from '../src/objects.js';

let dir;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ply-enc-commit-'));
  assert.equal(spawnSync('git', ['-C', dir, 'init', '-q', '-b', 'main']).status, 0);
  // the empty tree, so `git show` can read a commit that points at it
  assert.equal(`${spawnSync('git', ['-C', dir, 'hash-object', '-t', 'tree', '-w', '--stdin'], { input: '' }).stdout}`.trim(), TREE);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
function git(args, input) {
  const r = spawnSync('git', ['-C', dir, ...args], { input, maxBuffer: 1 << 26 });
  return { code: r.status ?? 1, out: r.stdout ?? Buffer.alloc(0), err: `${r.stderr ?? ''}`.trim() };
}

const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git's empty tree
const WHO = 'A U Thor <a@example.com> 1700000000 +0000';
// The commit object format, written out by hand (not ply's encoder): tree, parents, author, committer, encoding, the
// other header lines, then a blank line and the message when there is one.
function handBuilt({ tree, parents = [], author, committer = author, encoding = null, extra = [], message = null }) {
  const lines = [`tree ${tree}`, ...parents.map(p => `parent ${p}`), `author ${author}`, `committer ${committer}`];
  if (encoding !== null) lines.push(`encoding ${encoding}`);
  return Buffer.from(`${[...lines, ...extra].join('\n')}\n${message === null ? '' : `\n${message}`}`, 'utf8');
}

// [what, input, git's verdict on the hand-built bytes, why ply refuses when git accepts]
const REFUSED = [
  ['author with no email or date', { author: 'garbage' }, 'refuses'],
  ['author timezone of two digits', { author: 'A <a@b> 1 +00' }, 'refuses'],
  ['author with a negative time', { author: 'A <a@b> -5 +0000' }, 'refuses'],
  ['committer with a zero-padded time', { author: WHO, committer: 'A <a@b> 01 +0000' }, 'refuses'],
  ['author time past 2^63 - 1', { author: 'A <a@b> 99999999999999999999 +0000' }, 'refuses'],
  ['author with no space before the email', { author: 'A<a@b> 1 +0000' }, 'refuses'],
  // fsck reads only the first tree / author / committer line, so git stores these; cat-file then shows a second one
  // that %an, %T and %P do not. parseCommit refuses that object (duplicateHeader), so ply must not build it.
  ['extra line that is a second tree', { author: WHO, extra: [`tree ${'1'.repeat(40)}`] }, 'accepts', 'shadow'],
  ['extra line that is a second author', { author: WHO, extra: ['author Evil <e@x> 1 +0000'] }, 'accepts', 'shadow'],
  ['extra line that is a second committer', { author: WHO, extra: ['committer Evil <e@x> 1 +0000'] }, 'accepts', 'shadow'],
  ['extra line that is a late parent', { author: WHO, extra: [`parent ${'2'.repeat(40)}`] }, 'accepts', 'shadow'],
  ['encoding given twice', { author: WHO, encoding: 'UTF-8', extra: ['encoding ISO-8859-1'] }, 'accepts', 'shadow'],
  // git stores these too, and reads back another commit than the one given: the blank line ends the header, so the
  // lines after it are message text; an `encoding ` extra line is the encoding the caller said was absent.
  // (with no message the bytes are those of another input, no extra line and an empty message: one object, two inputs)
  ['empty extra line, no message', { author: WHO, extra: [''] }, 'accepts', 'alias'],
  ['empty extra line before another', { author: WHO, extra: ['', 'x-later 1'], message: 'hello\n' }, 'accepts', 'body'],
  ['empty extra line between two', { author: WHO, extra: ['x-first 1', '', 'x-later 1'], message: 'hello\n' }, 'accepts', 'body'],
  ['encoding as an extra line', { author: WHO, extra: ['encoding ISO-8859-1'], message: 'hello\n' }, 'accepts', 'encoding'],
];

test('encodeCommit refuses, as bad_request, every commit git refuses or reads back as another commit', () => {
  const wrong = [];
  for (const [what, fields, verdict, why] of REFUSED) {
    const input = { tree: TREE, ...fields };
    const theirs = git(['hash-object', '-t', 'commit', '-w', '--stdin'], handBuilt(input));
    assert.equal(theirs.code === 0 ? 'accepts' : 'refuses', verdict, `${what}: git ${theirs.err}`);
    if (why === 'body') {
      // git's own reading of the message is not the message that was given
      const body = `${git(['show', '-s', '--format=%B', `${theirs.out}`.trim()]).out}`;
      assert.notEqual(body.replace(/\n$/u, ''), (input.message ?? '').replace(/\n$/u, ''), `${what}: git reads the given message back`);
    }
    if (why === 'alias') assert.deepEqual(handBuilt(input), handBuilt({ tree: TREE, author: WHO, message: '' }), `${what}: the bytes of another input`);
    if (why === 'encoding') assert.equal(`${git(['show', '-s', '--format=%e', `${theirs.out}`.trim()]).out}`.trim(), 'ISO-8859-1', `${what}: git reads an encoding the caller did not give`);
    let ours;
    try { ours = encodeCommit(input); } catch (e) { wrong.push(`${what}: encodeCommit threw ${e}`); continue; }
    if (ours.ok) wrong.push(`${what}: git ${verdict}${theirs.err ? ` (${theirs.err})` : ''}, ply encodes ${ours.value.length} bytes`);
    else if (ours.error.code !== 'bad_request') wrong.push(`${what}: ${ours.error.code}`);
    // owner decision: an error never grows with the caller's text
    else assert.ok(ours.error.message.length < 200, ours.error.message);
  }
  assert.deepEqual(wrong, []);
});

// mulberry32: a fixed seed, so a failure names a reproducible case.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const IDENTS = [
  WHO, 'A <a@b> 0 +0000', 'Ünï Çødé <u@x.y> 1700000000 -0730', 'A B C <> 9223372036854775807 +9999', 'x <a b@c>  12 -0000', 'tree <author@parent> 1 +1400',
];
const EXTRAS = [
  'x-custom value', 'mergetag object 1111111111111111111111111111111111111111', ' type commit', ' tag v1', 'gpgsig -----BEGIN SSH SIGNATURE-----', ' AAAA', ' -----END SSH SIGNATURE-----',
  'x', 'HG:rename-source hg', 'encodingx y', 'treex z', 'authorship 1', 'parents 2', 'committers 3', 'ünï cødé',
];
const MESSAGES = [null, '', 'hello\n', 'no newline', '\n\nleading blank lines\n', 'ünï cødé\n', 'tree fake\nauthor fake\n\nparent fake\n', 'subject\n\nbody\n\n\n'];
const ENCODINGS = [null, null, 'UTF-8', 'ISO-8859-1'];

test('generated commits round-trip both ways: encodeCommit writes what git stores, and parseCommit of git\'s bytes encodes back to them', () => {
  const rand = prng(0xC0FFEE);
  const pick = list => list[Math.floor(rand() * list.length)];
  const hex = () => Array.from({ length: 40 }, () => Math.floor(rand() * 16).toString(16)).join('');
  for (let i = 0; i < 80; i++) {
    const given = {
      tree: hex(), parents: Array.from({ length: Math.floor(rand() * 4) }, hex), author: pick(IDENTS), committer: pick(IDENTS),
      encoding: pick(ENCODINGS), extra: Array.from({ length: Math.floor(rand() * 4) }, () => pick(EXTRAS)), message: pick(MESSAGES),
    };
    const label = `case ${i}: ${JSON.stringify(given)}`;
    const expected = handBuilt(given);
    // git's verdict and git's stored bytes for the hand-built object
    const stored = git(['hash-object', '-t', 'commit', '-w', '--stdin'], expected);
    assert.equal(stored.code, 0, `${label}: git refuses a generated commit: ${stored.err}`);
    const oid = `${stored.out}`.trim();
    const cat = git(['cat-file', 'commit', oid]).out;
    assert.deepEqual(cat, expected, `${label}: git stores the hand-built bytes`);
    // one way: encodeCommit writes exactly those bytes
    const ours = encodeCommit(given);
    assert.equal(ours.ok, true, `${label}: ${ours.ok ? '' : ours.error.message}`);
    assert.deepEqual(Buffer.from(ours.value), cat, `${label}: encodeCommit's bytes are git's`);
    // the other way: parseCommit of git's bytes is the commit that was given, and encodes back to git's bytes
    const parsed = parseCommit(new Uint8Array(cat));
    assert.equal(parsed.ok, true, `${label}: ${parsed.ok ? '' : parsed.error.message}`);
    assert.deepEqual({ ...parsed.value }, given, label);
    const again = encodeCommit(parsed.value);
    assert.equal(again.ok, true, label);
    assert.deepEqual(Buffer.from(again.value), cat, `${label}: parse then encode is git's bytes`);
  }
});
