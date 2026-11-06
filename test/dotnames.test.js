// The tree-entry name checks (src/validate.ts isDotGitName, isDotFileName, and isHfsDot through checkoutPathRefusal)
// answer exactly what they answered before #207 made them allocation-free (test/oracle/dotnames-ref.ts, the c91c9cf
// code): every byte string up to two bytes, short strings over the bytes the checks branch on, every spelling × prefix ×
// tail with its truncations, one-byte substitutions, deletions, doublings and ignorables inserted, and random names.
// Under the mutation run (MUTATION=1) the same generators at smaller sizes. The large campaign (every 3-byte string,
// 4 bytes over the branch bytes, every head and tail, 10^7 random names) is test/fuzz/dotnames.mjs. Both sides are
// held to git by test/space/fsck-tree.test.js.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ALPHABET, ALL_BYTES, BRANCH_BYTES, BYTE_TAILS, exhaustive, targeted, rng, randomName, judge, hfsGitmodules } from './dotnames-corpus.js';
import { checkoutPathRefusal } from '../src/validate.js';
import { unwrap } from './unwrap.js';

const QUICK = process.env.MUTATION === '1';
const agree = (names, label, minHits = 0) => {
  const stats = { n: 0, hits: 0 };
  const bad = judge(names, stats);
  assert.equal(bad, null, `${label}: ${JSON.stringify(bad)}`);
  assert.ok(stats.hits >= minHits, `${label}: only ${stats.hits} of ${stats.n} names spell anything (expected ≥ ${minHits}): the corpus is vacuous`);
  return stats;
};

test('every byte string up to 2 bytes (1 under mutation)', () => {
  agree(exhaustive(ALL_BYTES, QUICK ? 1 : 2), 'all bytes');
});

test('every string up to 3 bytes over the bytes the checks branch on', () => {
  // no spelling is that short: this holds the first-byte exit and the tail and NUL branches on near misses
  agree(exhaustive(QUICK ? BRANCH_BYTES : ALPHABET.subarray(0, 40), 3), 'branch bytes ≤ 3');
});

test('every spelling, truncated, substituted, shortened, doubled and with ignorables inserted', () => {
  if (QUICK) {
    // every spelling with the short tails, substituted by the branch bytes; the UTF-8 byte tails after one of each kind
    const s = agree(targeted([''], ['', ':x', '\\x'], BRANCH_BYTES, []), 'targeted', 1_000);
    const u = agree(targeted([''], [], BRANCH_BYTES.subarray(0, 0), BYTE_TAILS, ['.git', 'git~1', '.gitmodules', 'gitmod~1', 'gi7eba~1', '~1234567']), 'targeted utf-8 tails', 100);
    assert.ok(s.n + u.n > 50_000, `targeted corpus is ${s.n + u.n} names`);
    return;
  }
  const s = agree(targeted(['', 'a\\'], ['', '. .', ':x', '\\x', '\0', 'x']), 'targeted', 10_000);
  assert.ok(s.n > 500_000, `targeted corpus is ${s.n} names`);
});

test('random names from spelling fragments (seeded)', () => {
  const r = rng(Number(process.env.DOTNAMES_SEED ?? 207));
  const n = QUICK ? 5_000 : 30_000;
  agree((function* () { for (let i = 0; i < n; i++) yield randomName(r); })(), 'random', QUICK ? 10 : 100);
});

test('checkoutPathRefusal reads isHfsDot(.gitmodules) as before, on every targeted name it can be asked about', () => {
  let asked = 0, hits = 0;
  for (const b of targeted([''], QUICK ? ['', 'x'] : ['', '. .', ':x', '\\x', 'x'], BRANCH_BYTES, QUICK ? [] : BYTE_TAILS)) {
    const v = hfsGitmodules(b);
    if (v === null) continue;
    asked++; if (v.want) hits++;
    assert.equal(v.got, v.want, [...b].map(x => x.toString(16)).join(' '));
  }
  assert.ok(asked > 10_000 && hits > 20, `asked ${asked}, ${hits} spell .gitmodules on HFS+`);
});

test('checkoutPathRefusal: a symlink at a spelling of .gitmodules, by platform and position', () => {
  const why = (path, mode, platform) => { const r = unwrap(checkoutPathRefusal(path, mode, platform)); return r.tag === 'some' ? r.value : null; };
  const LINK = 'a symlink at a spelling of .gitmodules';
  // exactly .gitmodules (any case), anywhere, any platform
  assert.equal(why('a/.GITMODULES', '120000', 'linux'), LINK);
  assert.equal(why('.gitmodules/x', '120000', 'linux'), LINK);
  // not a symlink: no refusal
  assert.equal(why('.gitmodules', '100644', 'darwin'), null);
  assert.equal(why('.g‌itmodules', '100644', 'darwin'), null);
  // the HFS+ spelling: on macOS only, at any component
  assert.equal(why('.g‌itmodules/x', '120000', 'darwin'), LINK);
  assert.equal(why('.g‌itmodules/x', '120000', 'linux'), null);
  // the NTFS spellings: at the last component only (and the HFS+ one there, on every platform)
  assert.equal(why('a/gitmod~1', '120000', 'linux'), LINK);
  assert.equal(why('gitmod~1/x', '120000', 'linux'), null);
  assert.equal(why('a/.g‌itmodules', '120000', 'linux'), LINK);
  assert.equal(why('x/.gitmodulesx', '120000', 'darwin'), null);
});
