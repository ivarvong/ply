// Orders taken from git's own version-sort tests (t7004) and from for-each-ref on this corpus. The space test
// (test/space/version-refname.test.js) is the oracle over the whole product; this file is the fast check mutation runs.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { compareVersionRefnames } from '../src/refs.js';

const RELEASE = ['-alpha', '-beta', '', '-gamma', '-delta'];

/** @type {readonly { readonly suffixes: readonly string[], readonly order: readonly string[] }[]} */
const ORDERS = Object.freeze([
  { suffixes: [], order: ['foo1.3', 'foo1.6', 'foo1.10'] },
  { suffixes: ['-rc'], order: ['foo1.3', 'foo1.6-rc1', 'foo1.6-rc2', 'foo1.6', 'foo1.10'] },
  { suffixes: ['-before'], order: ['foo1.7-before1', 'foo1.7', 'foo1.7-after1'] },
  { suffixes: ['-before', '-after'], order: ['foo1.7-before1', 'foo1.7-after1', 'foo1.7'] },
  { suffixes: ['-bar', '-foo-baz', '-foo-bar'], order: ['foo1.8-foo-baz', 'foo1.8-foo-bar', 'foo1.8'] },
  { suffixes: ['-pre', '-prerelease'], order: ['foo1.9-pre1', 'foo1.9-pre2', 'foo1.9-prerelease1'] },
  { suffixes: RELEASE, order: ['foo1.10-alpha', 'foo1.10-beta', 'foo1.10', 'foo1.10-unlisted-suffix', 'foo1.10-gamma', 'foo1.10-delta'] },
  { suffixes: [], order: ['01', '1', '9', '10'] },
  { suffixes: [], order: ['v1.01', 'v1.1', 'v1.9', 'v1.10'] },
  { suffixes: [], order: ['1.01', '1.02', '1.1', '1.9', '1.10'] },
  { suffixes: [], order: ['99', '100'] },
  // Leading zeros are fractional (strverscmp S_Z): 00 < 01 < 0 < 1.
  { suffixes: [], order: ['00', '01', '0', '1'] },
  // UTF-8 bytes, not UTF-16 code units: U+E000 (EE 80 80) before U+10000 (F0 90 80 80). Code units put the surrogate first.
  { suffixes: [], order: ['a1', 'é1', '\uE0001', '\u{10000}1'] },
  { suffixes: ['-rc', ''], order: ['v1-rc1', 'v1-rc2', 'v1', 'v1-beta'] },
  { suffixes: ['', '-rc'], order: ['v1', 'v1-rc1', 'v1-rc2'] },
]);

function sorted(names, suffixes) {
  return [...names].sort((a, b) => compareVersionRefnames(a, b, { suffixes }));
}

test('compareVersionRefnames matches the version-sort orders git publishes', () => {
  for (const { suffixes, order } of ORDERS) {
    const shuffled = [...order].reverse();
    assert.deepEqual(sorted(shuffled, suffixes), [...order], `${JSON.stringify(suffixes)} ${order.join(' ')}`);
    for (let i = 0; i < order.length; i++) {
      assert.equal(compareVersionRefnames(order[i], order[i], { suffixes }), 0, order[i]);
      for (let j = i + 1; j < order.length; j++) {
        const cmp = compareVersionRefnames(order[i], order[j], { suffixes });
        const back = compareVersionRefnames(order[j], order[i], { suffixes });
        assert.ok(cmp < 0, `${order[i]} before ${order[j]} (${cmp})`);
        assert.ok(back > 0, `${order[j]} after ${order[i]} (${back})`);
        assert.equal(Math.sign(cmp), -Math.sign(back), `${order[i]} vs ${order[j]}`);
      }
    }
  }
});

// Magnitudes, not only signs: versioncmp returns the byte difference or the distance in the suffix list.
test('compareVersionRefnames returns versioncmp\'s difference, not only its sign', () => {
  assert.equal(compareVersionRefnames('b', 'a'), 1);
  assert.equal(compareVersionRefnames('a', 'c'), -2);
  assert.equal(compareVersionRefnames('10', '9'), 1);
  assert.equal(compareVersionRefnames('9', '10'), -1);
  assert.equal(compareVersionRefnames('100', '99'), 1);
  assert.equal(compareVersionRefnames('99', '100'), -1);
  assert.equal(compareVersionRefnames('12', '13'), -1);
  assert.equal(compareVersionRefnames('01', '1'), -1);
  assert.equal(compareVersionRefnames('1a', '12'), -1);
  assert.equal(compareVersionRefnames('12', '1a'), 1);
  // The length scan stops at '9' and at the first byte past '9'. 'a' and a missing '9' both change which run is longer.
  assert.equal(compareVersionRefnames('119', '12a'), 1);
  assert.equal(compareVersionRefnames('12a', '119'), -1);
  assert.equal(compareVersionRefnames('199', '20'), 1);
  assert.equal(compareVersionRefnames('19', '2'), 1);
  assert.equal(compareVersionRefnames('2', '19'), -1);
  const suffixes = RELEASE;
  assert.equal(compareVersionRefnames('v1-alpha', 'v1-gamma', { suffixes }), -3);
  assert.equal(compareVersionRefnames('v1-gamma', 'v1-alpha', { suffixes }), 3);
  // Both sides match a suffix (alpha at 0, the empty release at 2), so the value is the distance, not the one-sided ±1.
  assert.equal(compareVersionRefnames('v1-alpha', 'v1', { suffixes }), -2);
  assert.equal(compareVersionRefnames('v1', 'v1-alpha', { suffixes }), 2);
  assert.equal(compareVersionRefnames('v1', 'v1-gamma', { suffixes }), -1);
  assert.equal(compareVersionRefnames('v1-gamma', 'v1', { suffixes }), 1);
  // No suffix list: the byte difference, '-' against the end of the string.
  assert.equal(compareVersionRefnames('v1-alpha', 'v1'), 45);
  assert.equal(compareVersionRefnames('v1', 'v1-alpha'), -45);
  assert.equal(compareVersionRefnames('v1-alpha', 'v1', {}), 45);
  assert.equal(compareVersionRefnames('v1-alpha', 'v1', { suffixes: [] }), 45);
  // An equal-length duplicate does not replace the suffix already found, so the distance stays 0 against 2.
  assert.equal(compareVersionRefnames('v1-alpha', 'v1-gamma', { suffixes: ['-alpha', '-alpha', '-gamma'] }), -2);
  // versioncmp is not a strict weak order once the release sits between prereleases.
  assert.equal(compareVersionRefnames('00.1-gamma', '00.2-alpha', { suffixes }), -1);
  assert.equal(compareVersionRefnames('00.2-alpha', '00.1-gamma', { suffixes }), 1);
  assert.equal(compareVersionRefnames('00.2-alpha', '00.10-alpha', { suffixes }), -1);
  assert.equal(compareVersionRefnames('00.10-alpha', '00.2-alpha', { suffixes }), 1);
  assert.equal(compareVersionRefnames('00.1-gamma', '00.10-alpha', { suffixes }), 1);
  assert.equal(compareVersionRefnames('00.10-alpha', '00.1-gamma', { suffixes }), -1);
  const releaseFirst = ['', '-rc'];
  assert.equal(compareVersionRefnames('00.1-rc1', '00.2', { suffixes: releaseFirst }), -1);
  assert.equal(compareVersionRefnames('00.2', '00.10', { suffixes: releaseFirst }), -1);
  assert.equal(compareVersionRefnames('00.1-rc1', '00.10', { suffixes: releaseFirst }), 1);
  assert.equal(compareVersionRefnames('00.10', '00.1-rc1', { suffixes: releaseFirst }), -1);
  // versioncmp stops at the C string's NUL.
  assert.equal(compareVersionRefnames('a\0b', 'a\0c'), 0);
  assert.equal(compareVersionRefnames('a\0b', 'a'), 0);
  assert.equal(compareVersionRefnames('a\0', 'b'), -1);
  assert.equal(compareVersionRefnames('v1', 'v1'), 0);
  assert.equal(compareVersionRefnames('', ''), 0);
  assert.equal(compareVersionRefnames('', 'a'), -97);
  // The omitted suffix list is empty. A placeholder suffix in that default would put this name first.
  assert.equal(compareVersionRefnames('xStryker was here', 'x'), 83);
  assert.equal(compareVersionRefnames('x', 'xStryker was here'), -83);
});

test('compareVersionRefnames refuses a value that is not a ref byte string', () => {
  assert.throws(() => compareVersionRefnames(/** @type {string} */ (1), 'a'), e => e.code === 'bad_request' && e.what === 'refname');
  assert.throws(() => compareVersionRefnames('a', /** @type {string} */ (1)), e => e.code === 'bad_request' && e.what === 'refname');
  assert.throws(() => compareVersionRefnames('a', 'b', { suffixes: [/** @type {string} */ (1)] }), e => e.code === 'bad_request' && e.what === 'versionsort.suffix');
  assert.throws(() => compareVersionRefnames('\uD800', 'a'), e => e.code === 'bad_request');
});
