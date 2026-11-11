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
