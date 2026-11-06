// The tree-entry name checks (src/validate.ts isDotGitName, isDotFileName, and isHfsDot through checkoutPathRefusal)
// answer exactly what they answered before #207 made them allocation-free (test/oracle/dotnames-ref.ts, the c91c9cf
// code): every byte string up to two bytes, short strings over the bytes the checks branch on, every spelling × prefix ×
// tail with its truncations, one-byte substitutions, deletions, doublings and ignorables inserted, and random names.
// Under the mutation run (MUTATION=1) the same generators at smaller sizes. The large campaign (every 3-byte string,
// 4 bytes over the alphabet, every head and tail, 10^7 random names) is test/fuzz/dotnames.mjs. Both sides are held to
// git by test/space/fsck-tree.test.js.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ALPHABET, ALL_BYTES, exhaustive, targeted, rng, randomName, judge, hfsGitmodules } from './dotnames-corpus.js';

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
  const alphabet = QUICK ? ALPHABET.subarray(0, 24) : ALPHABET.subarray(0, 40);
  agree(exhaustive(alphabet, 3), `alphabet(${alphabet.length}) ≤ 3`);
});

test('every spelling, truncated, substituted, shortened, doubled and with ignorables inserted', () => {
  const s = QUICK
    ? agree(targeted(['', 'a\\'], ['', ':x', '\\x'], ALPHABET.subarray(0, 24)), 'targeted', 1_000)
    : agree(targeted(['', 'a\\'], ['', '. .', ':x', '\\x', '\0', 'x']), 'targeted', 10_000);
  assert.ok(s.n > (QUICK ? 50_000 : 500_000), `targeted corpus is ${s.n} names`);
});

test('random names from spelling fragments (seeded)', () => {
  const r = rng(Number(process.env.DOTNAMES_SEED ?? 207));
  const n = QUICK ? 5_000 : 30_000;
  agree((function* () { for (let i = 0; i < n; i++) yield randomName(r); })(), 'random', QUICK ? 10 : 100);
});

test('checkoutPathRefusal reads isHfsDot(.gitmodules) as before, on every targeted name it can be asked about', () => {
  let asked = 0, hits = 0;
  for (const b of targeted(['', 'a\\'], QUICK ? ['', 'x'] : ['', '. .', ':x', '\\x', 'x'], ALPHABET.subarray(0, 24))) {
    const v = hfsGitmodules(b);
    if (v === null) continue;
    asked++; if (v.want) hits++;
    assert.equal(v.got, v.want, [...b].map(x => x.toString(16)).join(' '));
  }
  assert.ok(asked > 10_000 && hits > 20, `asked ${asked}, ${hits} spell .gitmodules on HFS+`);
});
