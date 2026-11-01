// version:refname (issue #124). Two products, both judged by `git tag -l --sort=version:refname`.
//
// Pairs: every unordered pair of names from left × mid × end, plus a unicode slice, under every versionsort.suffix
// list. A cell is one pair under one list. The oracle is two-name git, which is versioncmp. A suffix list that puts
// the release between prereleases makes versioncmp cyclic (00.1-gamma < 00.2-alpha < 00.10-alpha < 00.1-gamma), so
// those cells are pairs, not a listing.
//
// Ranks: every name of the larger product under every list. Where versioncmp orders the whole list, git's listing
// equals a sort by compareVersionRefnames. Where it cycles, the listing inverts at least one cycle edge, and
// two-name git on that edge agrees with versioncmp.

/** @type {readonly string[]} */
export const PAIR_LEFTS = Object.freeze(['0', '00', '1', '2', '10', '01']);
/** @type {readonly string[]} */
export const PAIR_MIDS = Object.freeze(['', '.1', '.2', '.10', '.01']);
/** @type {readonly string[]} */
export const PAIR_ENDS = Object.freeze(['', '-rc1', '-alpha', '-gamma']);

/** @type {readonly string[]} */
export const UNICODE_PREFIXES = Object.freeze(['é', '\uE000', '\u{10000}']);
/** @type {readonly string[]} */
export const UNICODE_LEFTS = Object.freeze(['1', '10']);
/** @type {readonly string[]} */
export const UNICODE_MIDS = Object.freeze(['', '.1']);
/** @type {readonly string[]} */
export const UNICODE_ENDS = Object.freeze(['', '-alpha']);

/** @type {readonly string[]} */
export const PREFIXES = Object.freeze(['', 'a', 'b', 'v', 'foo', 'é', '\uE000', '\u{10000}']);
/** @type {readonly string[]} */
export const LEFTS = Object.freeze(['0', '00', '1', '2', '9', '10', '01', '99', '100']);
/** @type {readonly string[]} */
export const MIDS = Object.freeze(['', '.0', '.1', '.2', '.3', '.6', '.7', '.8', '.9', '.10', '.01']);
/** @type {readonly string[]} */
export const ENDS = Object.freeze([
  '', '-rc1', '-rc2', '-alpha', '-beta', '-gamma', '-delta',
  '-pre1', '-pre2', '-prerelease1', '-before1', '-after1', '-foo-bar', '-foo-baz', '-unlisted-suffix',
]);

// Each list is versionsort.suffix in config order. '' is the release, placed among the suffixes (git's own tests).
/** @type {readonly { readonly tag: string, readonly suffixes: readonly string[] }[]} */
export const SUFFIX_CONFIGS = Object.freeze([
  { tag: 'none', suffixes: [] },
  { tag: 'rc', suffixes: ['-rc'] },
  { tag: 'before', suffixes: ['-before'] },
  { tag: 'before-after', suffixes: ['-before', '-after'] },
  { tag: 'pre', suffixes: ['-pre', '-prerelease'] },
  { tag: 'foo-bar', suffixes: ['-bar', '-foo-baz', '-foo-bar'] },
  { tag: 'release-between', suffixes: ['-alpha', '-beta', '', '-gamma', '-delta'] },
  { tag: 'release-first', suffixes: ['', '-rc'] },
  { tag: 'rc-then-release', suffixes: ['-rc', ''] },
]);

// versioncmp's order under release-between. The three edges cannot all hold in one listing.
/** @type {readonly (readonly [string, string])[]} */
export const CYCLE = Object.freeze([
  ['00.1-gamma', '00.2-alpha'],
  ['00.2-alpha', '00.10-alpha'],
  ['00.10-alpha', '00.1-gamma'],
]);
export const CYCLIC_SUFFIX = 'release-between';

const choose2 = n => (n * (n - 1)) / 2;

export const PAIR_NAME_COUNT = PAIR_LEFTS.length * PAIR_MIDS.length * PAIR_ENDS.length;
export const UNICODE_NAME_COUNT = UNICODE_PREFIXES.length * UNICODE_LEFTS.length * UNICODE_MIDS.length * UNICODE_ENDS.length;
export const PAIR_CELL_COUNT = (choose2(PAIR_NAME_COUNT) + choose2(UNICODE_NAME_COUNT)) * SUFFIX_CONFIGS.length;
export const NAME_COUNT = PREFIXES.length * LEFTS.length * MIDS.length * ENDS.length;
export const RANK_CELL_COUNT = NAME_COUNT * SUFFIX_CONFIGS.length;
export const CELL_COUNT = PAIR_CELL_COUNT + RANK_CELL_COUNT;

/** @param {readonly string[]} prefixes @param {readonly string[]} lefts @param {readonly string[]} mids @param {readonly string[]} ends */
export function product(prefixes, lefts, mids, ends) {
  const out = [];
  for (const prefix of prefixes) {
    for (const left of lefts) {
      for (const mid of mids) {
        for (const end of ends) out.push(`${prefix}${left}${mid}${end}`);
      }
    }
  }
  return out;
}

/** Every name of the rank product, in axis order. */
export function names() {
  return product(PREFIXES, LEFTS, MIDS, ENDS);
}

/** The pair-product names (no prefix). */
export function pairNames() {
  return product([''], PAIR_LEFTS, PAIR_MIDS, PAIR_ENDS);
}

/** The unicode slice of the pair product. */
export function unicodeNames() {
  return product(UNICODE_PREFIXES, UNICODE_LEFTS, UNICODE_MIDS, UNICODE_ENDS);
}

/** @param {readonly string[]} list */
export function pairsOf(list) {
  /** @type {[string, string][]} */
  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) out.push([list[i], list[j]]);
  }
  return out;
}
