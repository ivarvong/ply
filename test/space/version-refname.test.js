// The version:refname space (version-refname.space.js, #124).
//
// Pair cells: two-name `git tag -l --sort=version:refname` is versioncmp, suffixes included. That is the contract,
// because a suffix list with the release between prereleases makes versioncmp cyclic and git's qsort of a longer
// list then parts from versioncmp.
// Rank cells: the same command over the whole 11,880-name list. Where the order is total, the listing equals a sort
// by compareVersionRefnames. Where it cycles, every inverted edge is checked again as two names.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  names, pairNames, unicodeNames, pairsOf, SUFFIX_CONFIGS, CYCLE, CYCLIC_SUFFIX,
  NAME_COUNT, PAIR_NAME_COUNT, UNICODE_NAME_COUNT, PAIR_CELL_COUNT, RANK_CELL_COUNT, CELL_COUNT,
  PREFIXES, LEFTS, MIDS, ENDS, PAIR_LEFTS, PAIR_MIDS, PAIR_ENDS,
  UNICODE_PREFIXES, UNICODE_LEFTS, UNICODE_MIDS, UNICODE_ENDS,
} from './version-refname.space.js';
import { compareVersionRefnames } from '../../src/refs.js';

// The product is byte strings. An Err is a test bug, not a cell.
function cmp(a, b, suffixes) {
  const r = compareVersionRefnames(a, b, { suffixes });
  if (!r.ok) throw r.error;
  return r.value;
}

const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C.UTF-8',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x',
  GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000',
};

const POOL = 16;
const SHOW = 8;

function git(args, opts = {}) {
  const r = spawnSync('git', args, { env: ENV, encoding: 'utf8', maxBuffer: 1 << 26, ...opts });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** @param {string[]} args */
function gitText(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { env: ENV });
    const out = [];
    const err = [];
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(`git ${args.join(' ')}: ${Buffer.concat(err).toString('utf8')}`));
      else resolve(Buffer.concat(out).toString('utf8'));
    });
  });
}

/** @param {number} workers @param {number} count @param {(i: number) => Promise<void>} fn */
async function pool(workers, count, fn) {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed) {
      const i = next++;
      if (i >= count) return;
      try {
        await fn(i);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
}

/** @param {string} dir @param {readonly string[]} tags */
function initTags(dir, tags) {
  git(['init', '-q', dir]);
  git(['commit', '-q', '--allow-empty', '-m', 'c'], { cwd: dir });
  const head = git(['rev-parse', 'HEAD'], { cwd: dir }).trim();
  git(['update-ref', '--stdin'], { cwd: dir, input: tags.map(name => `create refs/tags/${name} ${head}\n`).join('') });
}

/** @param {readonly string[]} suffixes */
function suffixArgs(suffixes) {
  const args = ['-c', 'core.quotepath=false'];
  for (const suffix of suffixes) args.push('-c', `versionsort.suffix=${suffix}`);
  return args;
}

/** @param {string} dir @param {readonly string[]} suffixes */
function gitList(dir, suffixes) {
  const out = git([...suffixArgs(suffixes), '-C', dir, 'tag', '-l', '--sort=version:refname']);
  return out.split('\n').filter(line => line.length > 0);
}

// Pairs git's listing orders the other way from ply's listing, found while sorting ply's ranks (up to `limit`).
// `a` is the name git lists first.
/** @param {readonly string[]} gitNames @param {ReadonlyMap<string, number>} plyRank @param {number} limit */
function listingInversions(gitNames, plyRank, limit) {
  /** @type {{ name: string, rank: number }[]} */
  const items = gitNames.map(name => ({ name, rank: plyRank.get(name) ?? -1 }));
  /** @type {[string, string][]} */
  const found = [];
  /** @param {{ name: string, rank: number }[]} arr */
  const sort = arr => {
    if (arr.length <= 1) return arr;
    const mid = arr.length >> 1;
    const left = sort(arr.slice(0, mid));
    const right = sort(arr.slice(mid));
    /** @type {{ name: string, rank: number }[]} */
    const merged = [];
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
      if (left[i].rank <= right[j].rank) merged.push(left[i++]);
      else {
        if (found.length < limit) {
          for (let k = i; k < left.length && found.length < limit; k++) found.push([left[k].name, right[j].name]);
        }
        merged.push(right[j++]);
      }
    }
    for (; i < left.length; i++) merged.push(left[i]);
    for (; j < right.length; j++) merged.push(right[j]);
    return merged;
  };
  sort(items);
  return found;
}

/** @param {string} dir @param {readonly string[]} suffixes @param {string} a @param {string} b */
async function gitPair(dir, suffixes, a, b) {
  const out = await gitText([...suffixArgs(suffixes), '-C', dir, 'tag', '-l', '--sort=version:refname', '--', a, b]);
  return out.split('\n').filter(line => line.length > 0);
}

test('version:refname: two-name git tag -l is versioncmp, and a total listing matches it', { timeout: 180_000 }, async () => {
  const ranked = names();
  const paired = pairNames();
  const unicode = unicodeNames();
  assert.equal(PREFIXES.length * LEFTS.length * MIDS.length * ENDS.length, NAME_COUNT);
  assert.equal(PAIR_LEFTS.length * PAIR_MIDS.length * PAIR_ENDS.length, PAIR_NAME_COUNT);
  assert.equal(UNICODE_PREFIXES.length * UNICODE_LEFTS.length * UNICODE_MIDS.length * UNICODE_ENDS.length, UNICODE_NAME_COUNT);
  assert.equal(ranked.length, NAME_COUNT);
  assert.equal(new Set(ranked).size, ranked.length, 'two rank axes built one name');
  assert.equal(paired.length, PAIR_NAME_COUNT);
  assert.equal(new Set(paired).size, paired.length, 'two pair axes built one name');
  assert.equal(new Set(unicode).size, unicode.length, 'two unicode axes built one name');
  for (const [a, b] of CYCLE) assert.ok(paired.includes(a) && paired.includes(b), `${a} / ${b} missing from the pair product`);
  const pairs = [...pairsOf(paired), ...pairsOf(unicode)];
  assert.equal(pairs.length * SUFFIX_CONFIGS.length, PAIR_CELL_COUNT);
  assert.equal(ranked.length * SUFFIX_CONFIGS.length, RANK_CELL_COUNT);
  assert.equal(PAIR_CELL_COUNT + RANK_CELL_COUNT, CELL_COUNT);

  const pairRoot = mkdtempSync(join(tmpdir(), 'ply-version-refname-pair-'));
  const rankRoot = mkdtempSync(join(tmpdir(), 'ply-version-refname-rank-'));
  try {
    initTags(pairRoot, [...paired, ...unicode]);
    initTags(rankRoot, ranked);
    const t0 = performance.now();
    const wrong = [];

    for (const config of SUFFIX_CONFIGS) {
      await pool(POOL, pairs.length, async i => {
        if (wrong.length >= SHOW) return;
        const [a, b] = pairs[i];
        const ordered = cmp(a, b, config.suffixes);
        const lines = await gitPair(pairRoot, config.suffixes, a, b);
        const want = ordered < 0 ? [a, b] : ordered > 0 ? [b, a] : null;
        if (!want || lines.length !== 2 || lines[0] !== want[0] || lines[1] !== want[1]) {
          wrong.push(`${config.tag}: compare(${JSON.stringify(a)}, ${JSON.stringify(b)}) = ${ordered}, git tag -l [${lines.map(s => JSON.stringify(s)).join(', ')}]`);
        }
      });
      if (wrong.length >= SHOW) break;
    }
    assert.deepEqual(wrong, []);
    const pairMs = performance.now() - t0;

    let rankCells = 0;
    let inverted = 0;
    /** @type {string[]} */
    const listingNotes = [];
    for (const config of SUFFIX_CONFIGS) {
      const gitNames = gitList(rankRoot, config.suffixes);
      assert.equal(gitNames.length, ranked.length, `${config.tag}: git listed every tag`);
      assert.equal(new Set(gitNames).size, gitNames.length, `${config.tag}: git listed a tag twice`);
      const plyNames = [...ranked].sort((a, b) => cmp(a, b, config.suffixes));
      const at = plyNames.findIndex((name, i) => name !== gitNames[i]);
      // Pairs the two listings order differently: git's qsort and a JS sort of a cyclic versioncmp.
      // Each one is checked as two names. Two-name git is versioncmp, whichever listing placed it first.
      /** @type {[string, string][]} */
      const disagreed = [];
      if (at !== -1) {
        const plyRank = new Map(plyNames.map((name, i) => [name, i]));
        disagreed.push(...listingInversions(gitNames, plyRank, 24));
        assert.ok(disagreed.length >= 1, `${config.tag}: listings differ at ${at} and no inversion was found`);
      }
      if (config.tag === CYCLIC_SUFFIX) {
        const pos = new Map(gitNames.map((name, i) => [name, i]));
        let backwards = 0;
        for (const [a, b] of CYCLE) {
          const ia = pos.get(a);
          const ib = pos.get(b);
          assert.equal(typeof ia, 'number', `${config.tag}: ${a}`);
          assert.equal(typeof ib, 'number', `${config.tag}: ${b}`);
          if (ib < ia) {
            backwards += 1;
            disagreed.push([b, a]);
          }
        }
        assert.ok(backwards >= 1, `${config.tag}: the cycle has an inverted edge in git's listing`);
      }
      const seen = new Set();
      for (const [a, b] of disagreed) {
        const key = `${a}\0${b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const ordered = cmp(a, b, config.suffixes);
        assert.notEqual(ordered, 0, `${config.tag}: ${a} and ${b}`);
        const lines = await gitPair(rankRoot, config.suffixes, a, b);
        const want = ordered < 0 ? [a, b] : [b, a];
        assert.deepEqual(lines, want, `${config.tag}: listings disagree on ${JSON.stringify(a)} / ${JSON.stringify(b)}; two-name git [${lines.map(s => JSON.stringify(s)).join(', ')}], compare = ${ordered}`);
        inverted += 1;
      }
      listingNotes.push(`${config.tag}: ${at === -1 ? 'listing matches' : `listing differs at ${at} (${disagreed.length} pairs checked)`}`);
      rankCells += gitNames.length;
    }
    const ms = performance.now() - t0;
    console.log(`version-refname: ${PAIR_CELL_COUNT} pair cells in ${pairMs.toFixed(0)} ms, ${rankCells} rank cells, ${inverted} listing disagreements confirmed by two-name git, ${ms.toFixed(0)} ms`);
    console.log(`version-refname listings: ${listingNotes.join('; ')}`);
    assert.equal(rankCells, RANK_CELL_COUNT);
    assert.ok(inverted >= 1);
  } finally {
    rmSync(pairRoot, { recursive: true, force: true });
    rmSync(rankRoot, { recursive: true, force: true });
  }
});

// Each refusal kind. git versioncmp is only defined on bytes: the byte strings those refusals stand next to
// (`1`, `é`) sort the same as `git tag -l --sort=version:refname`.
test('version:refname refusals are typed, and the byte string git sorts still matches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ply-version-refname-refuse-'));
  try {
    initTags(dir, ['1', 'a', 'é']);
    const gitNames = gitList(dir, []);
    const plyNames = ['1', 'a', 'é'].sort((a, b) => cmp(a, b, []));
    assert.deepEqual(plyNames, gitNames);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const cases = [
    [1, 'a', undefined, 'not_string', 'left'],
    ['a', 1, undefined, 'not_string', 'right'],
    ['a', 'b', [1], 'not_string', 'suffix'],
    ['\uD800', 'a', undefined, 'not_bytes', 'left'],
    ['a', '\uD800', undefined, 'not_bytes', 'right'],
    ['a', 'b', ['\uD800'], 'not_bytes', 'suffix'],
    ['\udcc3\udca9', 'a', undefined, 'not_bytes', 'left'],
  ];
  for (const [a, b, suffixes, kind, which] of cases) {
    const r = compareVersionRefnames(a, b, suffixes === undefined ? undefined : { suffixes });
    assert.equal(r.ok, false, `${kind} ${which}`);
    assert.equal(r.error.kind, kind);
    assert.equal(r.error.which, which);
    assert.equal(r.error.code, 'bad_request');
  }
});
