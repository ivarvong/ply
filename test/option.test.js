// Option laws (map, flatMap, getOrElse) and the platform-absence boundary. PROP_N shrinks the loop under mutation.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { some, none, mapOption, flatMapOption, getOrElse, matchOption } from '../src/result.js';
import {
  fromNullable, fromNullish, at, atOr, mapGet, readKey, jsonDecode, byteInRange,
  asOption, unwrapOrAbsent,
} from '../src/absent.js';
import { Rng } from './fuzz/prng.js';
import { compareCounts } from '../scripts/absence-ratchet.mjs';

const N = parseInt(process.env.PROP_N ?? '200', 10);
const SEED = 1;
const genInt = rng => rng.int(-30, 30);
const genOpt = rng => (rng.bool() ? some(genInt(rng)) : none);
const genPlain = rng => { const k = rng.int(-4, 4); return n => n + k; };
const genFn = rng => {
  const k = rng.int(-4, 4);
  const drop = rng.bool();
  return n => (drop && n % 2 === 0 ? none : some(n + k));
};

test('Option: none skips the continuation; some applies it', () => {
  const boom = () => { throw new Error('ran'); };
  assert.equal(mapOption(none, boom), none);
  assert.equal(flatMapOption(none, boom), none);
  assert.equal(getOrElse(none, 7), 7);
  assert.deepEqual(mapOption(some(2), n => n + 1), some(3));
  assert.deepEqual(flatMapOption(some(2), n => some(n + 1)), some(3));
  assert.equal(flatMapOption(some(2), () => none), none);
  assert.equal(getOrElse(some(2), 7), 2);
  assert.equal(matchOption(some(2), { some: n => n + 1, none: () => 0 }), getOrElse(mapOption(some(2), n => n + 1), 0));
});

test('Option laws: map identity and composition, flatMap identities and associativity, getOrElse', () => {
  for (let i = 0; i < N; i++) {
    const rng = new Rng(SEED * 1000003 + i);
    const o = genOpt(rng);
    const f = genPlain(rng);
    const g = genPlain(rng);
    assert.deepEqual(mapOption(o, x => x), o);
    assert.deepEqual(mapOption(mapOption(o, f), g), mapOption(o, x => g(f(x))));
    const ff = genFn(rng);
    const gg = genFn(rng);
    assert.deepEqual(flatMapOption(flatMapOption(o, ff), gg), flatMapOption(o, x => flatMapOption(ff(x), gg)));
    const a = genInt(rng);
    assert.deepEqual(flatMapOption(some(a), ff), ff(a));
    assert.deepEqual(flatMapOption(o, some), o);
    if (o.tag === 'none') {
      assert.equal(mapOption(o, f), none);
      assert.equal(flatMapOption(o, ff), none);
    }
    const fallback = genInt(rng);
    assert.equal(getOrElse(o, fallback), matchOption(o, { some: v => v, none: () => fallback }));
  }
});

test('boundary: platform absence becomes Option, null stays a value, indexes do not wrap', () => {
  assert.deepEqual(fromNullable(0), some(0));
  assert.deepEqual(fromNullable(false), some(false));
  assert.deepEqual(fromNullable(''), some(''));
  assert.equal(fromNullable(undefined), none);
  assert.deepEqual(fromNullable(null), some(null));
  assert.equal(fromNullish(undefined), none);
  assert.equal(fromNullish(null), none);
  assert.deepEqual(fromNullish(0), some(0));
  assert.deepEqual(fromNullish(false), some(false));
  assert.deepEqual(fromNullish(''), some(''));
  assert.equal(asOption(undefined), none);
  assert.equal(asOption(none), none);
  assert.deepEqual(asOption(some(1)), some(1));
  assert.equal(unwrapOrAbsent(some(4)), 4);
  assert.equal(unwrapOrAbsent(none), undefined);
  assert.deepEqual(at([10, 20], 1), some(20));
  assert.equal(at([10], 1), none);
  assert.equal(at([10], -1), none);
  assert.equal(at([10, 20], 1.5), none);
  assert.equal(at([10, 20], Number.NaN), none);
  const hole = [10, 20, 30];
  hole[1] = undefined;
  assert.equal(at(hole, 1), none);
  assert.equal(atOr(hole, 1, 9), 9);
  assert.deepEqual(at(Uint8Array.of(4, 5), 0), some(4));
  assert.equal(atOr([1], 5, 9), 9);
  assert.equal(atOr([1], 0, 9), 1);
  assert.equal(atOr([1], -1, 9), 9);
  assert.equal(atOr([1, 2], 1.5, 9), 9);
  const table = new Map([['a', 1]]);
  assert.deepEqual(mapGet(table, 'a'), some(1));
  assert.equal(mapGet(table, 'b'), none);
  assert.deepEqual(readKey({ a: 1 }, 'a'), some(1));
  assert.equal(readKey({}, 'a'), none);
  assert.deepEqual(jsonDecode('{"a":1}'), some({ a: 1 }));
  assert.deepEqual(jsonDecode('null'), some(null));
  assert.deepEqual(jsonDecode('0'), some(0));
  assert.equal(jsonDecode('nope'), none);
  assert.equal(jsonDecode(''), none);
  const bytes = Uint8Array.of(0, 7, 255);
  assert.equal(byteInRange(bytes, 0, 0, 0), true);
  assert.equal(byteInRange(bytes, 1, 0, 6), false);
  assert.equal(byteInRange(bytes, 1, 7, 7), true);
  assert.equal(byteInRange(bytes, 3, 0, 255), false);
  assert.equal(byteInRange(bytes, -1, 0, 255), false);
  assert.equal(byteInRange(bytes, 1.5, 0, 255), false);
});

test('absence ratchet holds, and a rise or a silent drop is rejected', () => {
  execFileSync(process.execPath, ['scripts/absence-ratchet.mjs'], { stdio: 'pipe' });
  const base = { boundary: 'src/absent.ts', undefined: 3, optional: 2, chain: 1, coalesce: 1 };
  assert.deepEqual(compareCounts({ ...base }, base), []);
  assert.ok(compareCounts({ ...base, undefined: 4 }, base).some(line => line.includes('rose')));
  assert.ok(compareCounts({ ...base, optional: 1 }, base).some(line => line.includes('fell')));
  assert.ok(compareCounts({ ...base, boundary: 'src/other.ts' }, base).length > 0);
});
