// An error never grows with a caller's text: the tree encoder quotes at most 200 UTF-16 units of a name (or a mode)
// and says the true length. The bound below is derived by hand from the message's shape, not read from the code:
//   `tree: entry "` + 200 units, each at most 6 characters once JSON-escaped (\uXXXX) + `"… (N UTF-16 units)` + `: ` +
//   a fixed reason (the longest is under 100 characters) + a second quoted value of the same shape for a mode.
// 2 × (200 × 6 + 40) + 200 = 2680 characters, whatever the caller sends.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { encodeTree, encodeEntries, treeEntryOf } from '../src/objects.js';

const BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const BOUND = 2680;
const QUOTE = 200;
// every string the error holds: the message and each field
const held = error => Math.max(error.message.length, ...Object.values(error).filter(v => typeof v === 'string').map(v => v.length));

test('a tree refusal is the same size for a 5 000 and a 1 000 000 character name: the name is cut to 200 units and its length said', () => {
  const cells = [
    ['large pathname', n => ({ mode: '100644', name: 'x'.repeat(n), oid: BLOB })],
    ['NUL in name', n => ({ mode: '100644', name: `a\0${'B'.repeat(n)}`, oid: BLOB })],
    ['full pathname', n => ({ mode: '100644', name: `a/${'b'.repeat(n)}`, oid: BLOB })],
    ['bad name', n => ({ mode: '100644', name: `.git${' '.repeat(n)}`, oid: BLOB })],
    ['invalid mode, long name', n => ({ mode: '644', name: '\u0001'.repeat(n), oid: BLOB })],
    ['invalid mode, long mode', n => ({ mode: '7'.repeat(n), name: 'a', oid: BLOB })],
    ['oid, long name and oid', n => ({ mode: '100644', name: 'é'.repeat(n), oid: 'f'.repeat(n) })],
  ];
  const wrong = [];
  for (const [reason, make] of cells) {
    for (const [fn, encode] of [['encodeTree', e => encodeTree([e])], ['encodeEntries', e => encodeEntries([e])], ['treeEntryOf', treeEntryOf]]) {
      const sizes = [];
      for (const n of [5000, 1000000]) {
        const entry = make(n);
        const got = encode(entry);
        // treeEntryOf checks the mode and the oid only: the name's own refusals are the encoder's
        if (got.ok) { if (fn !== 'treeEntryOf') wrong.push(`${fn} ${reason} n=${n}: encoded`); continue; }
        assert.equal(got.error.code, 'bad_request');
        if (held(got.error) > BOUND) wrong.push(`${fn} ${reason} n=${n}: the error holds a ${held(got.error)}-character string`);
        if (typeof got.error.entry === 'string' && got.error.entry.length > QUOTE) wrong.push(`${fn} ${reason} n=${n}: entry field is ${got.error.entry.length} units`);
        // the true length of whatever was cut is in the message
        for (const text of [entry.name, entry.mode]) {
          if (text.length > QUOTE && !got.error.message.includes(`(${text.length} UTF-16 units)`)) wrong.push(`${fn} ${reason} n=${n}: the message does not say the length ${text.length}: ${got.error.message.slice(0, 100)}`);
        }
        sizes.push(got.error.message.length);
      }
      // 5 000 and 1 000 000 differ by three digits in each reported length and by nothing else
      if (sizes.length === 2 && sizes[1] - sizes[0] > 2 * 3) wrong.push(`${fn} ${reason}: the message grew ${sizes[0]} -> ${sizes[1]}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('a short name is quoted whole, exactly as before; 200 units is not cut and 201 is; a duplicate is cut the same way', () => {
  const short = encodeTree([{ mode: '100644', name: 'a/b', oid: BLOB }]);
  assert.deepEqual([short.error.message, short.error.entry], ['tree: entry "a/b": full pathname', 'a/b']);
  const at = 'n'.repeat(200);
  const edge = encodeTree([{ mode: '644', name: at, oid: BLOB }]);
  assert.deepEqual([edge.error.message, edge.error.entry], [`tree: entry "${at}": invalid mode "644"`, at]);
  const over = encodeTree([{ mode: '644', name: `${at}Z`, oid: BLOB }]);
  assert.deepEqual([over.error.message, over.error.entry], [`tree: entry "${at}"… (201 UTF-16 units): invalid mode "644"`, at]);
  const name = 'd'.repeat(3000);
  const dup = encodeTree([{ mode: '100644', name, oid: BLOB }, { mode: '40000', name, oid: BLOB }]);
  assert.deepEqual([dup.error.message, dup.error.entry], [`tree: duplicate entry "${'d'.repeat(200)}"… (3000 UTF-16 units)`, 'd'.repeat(200)]);
});

test('the cut never ends on the first half of a surrogate pair: a well-formed name gives a well-formed message and `entry`', () => {
  // By hand: 199 `a`, then U+1F600 (the pair d83d de00, units 199 and 200), then ten `b`: 211 units. A cut at 200 units
  // ends on d83d alone: a string with no byte form, in an error about a name that has one. The cut stops before the
  // pair, at 199 units, and the length said is still the name's own.
  const head = 'a'.repeat(199);
  const name = `${head}\u{1F600}${'b'.repeat(10)}`;
  for (const [fn, encode] of [['encodeTree', e => encodeTree([e])], ['encodeEntries', e => encodeEntries([e])], ['treeEntryOf', treeEntryOf]]) {
    const got = encode({ mode: '644', name, oid: BLOB });
    assert.deepEqual([got.error.message, got.error.entry], [`tree: entry "${head}"… (211 UTF-16 units): invalid mode "644"`, head], fn);
  }
  // a pair that ends exactly at unit 200 is kept whole: 198 `a` and the pair are the 200 units quoted
  const fits = `${'a'.repeat(198)}\u{1F600}`;
  const kept = encodeTree([{ mode: '644', name: `${fits}bbb`, oid: BLOB }]);
  assert.deepEqual([kept.error.message, kept.error.entry], [`tree: entry "${fits}"… (203 UTF-16 units): invalid mode "644"`, fits]);
  // a mode is cut by the same rule
  const mode = encodeTree([{ mode: `${'7'.repeat(199)}\u{1F600}7`, name: 'a', oid: BLOB }]);
  assert.equal(mode.error.message, `tree: entry "a": invalid mode "${'7'.repeat(199)}"… (202 UTF-16 units)`);
  // The edges of the high-surrogate range, d800 to dbff, at unit 199: U+10000 is d800 dc00 and U+10FFFF is dbff dfff
  // (cut before them: 199 units). U+D7FF and U+E000 are ordinary characters, and a low surrogate with no high one
  // before it is the caller's own ill-formed name: none is the first half of a pair, so 200 units are kept.
  for (const [at, units] of [['\u{10000}', 199], ['\u{10FFFF}', 199], ['퟿b', 200], ['\udc00b', 200], ['b', 200]]) {
    const got = encodeTree([{ mode: '644', name: `${head}${at}bbbb`, oid: BLOB }]);
    assert.equal(got.error.entry, `${head}${at}`.slice(0, units), `U+${at.codePointAt(0).toString(16)}`);
    assert.equal(got.error.entry.isWellFormed(), at.charCodeAt(0) !== 0xdc00, `U+${at.codePointAt(0).toString(16)}`);
  }
});
