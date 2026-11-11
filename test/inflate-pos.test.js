// inflate(buf, pos): pos is a position in buf, a non-negative safe integer no greater than buf.length. Anything else is
// the caller's mistake and is refused as `bad_request` before a byte is read: never a throw out of the Result, and never
// a read from somewhere pos does not name (Uint8Array.subarray reads a negative offset from the END and coerces a
// string or a fraction, so an unchecked pos inflated bytes the caller never pointed at and answered ok).
//
// Expected values come from outside the code under test: the members are node:zlib's, a valid pos must give the bytes
// node:zlib inflates from the same offset and the length of the member node:zlib wrote, and a pos at the very end is a
// valid position holding no bytes, which zlib itself calls a cut stream (Z_BUF_ERROR, "unexpected end of file"), not a
// bad argument. The refused cells are the contract's: each names a value that is not an index into the buffer.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { inflate } from '../src/inflate.js';

const text = new TextEncoder().encode('hello, pos');
const member = zlib.deflateSync(text);
const junk = new Uint8Array(8).fill(0x78);
// junk, then a member, then an EMPTY member as the last bytes: the tail a negative pos would read
const empty = zlib.deflateSync(new Uint8Array(0));
const buf = new Uint8Array([...junk, ...member, ...empty]);

// never throws: a throw is reported as a failed cell with the thrown value, not as the test's own crash
const run = pos => {
  try { return inflate(buf, pos); } catch (e) { return { ok: false, threw: e }; }
};

test('a pos that is not a position in the buffer is bad_request: no throw, no read', () => {
  // The third column is what the message calls the value, written out by hand: a number is named as JavaScript prints
  // it, anything else by its type alone (a string's content never reaches the message, so the message is bounded
  // whatever the caller passed). buf is 8 + member + empty bytes long; its length is spelled from the parts.
  const cells = [
    ['negative', -1, '-1'],
    ['negative, the length of the trailing member (subarray reads it from the end)', -8, '-8'],
    ['fractional', 1.5, '1.5'],
    ['fractional, a hair past a valid position', 8.5, '8.5'],
    ['NaN', Number.NaN, 'NaN'],
    ['Infinity', Number.POSITIVE_INFINITY, 'Infinity'],
    ['-Infinity', Number.NEGATIVE_INFINITY, '-Infinity'],
    ['past the end by one', buf.length + 1, String(8 + member.length + empty.length + 1)],
    ['past the end, not a safe integer', 2 ** 53, '9007199254740992'],
    ['a string that spells a valid position', '8', 'string'],
    ['a string that spells zero', '0', 'string'],
    ['an empty string', '', 'string'],
    ['a long string', 'x'.repeat(10_000), 'string'],
    ['null', null, 'object'],
    ['a bigint', 8n, 'bigint'],
    ['an object with valueOf', { valueOf: () => junk.length }, 'object'],
  ];
  assert.equal(empty.length, 8, 'node:zlib\'s empty member is 8 bytes (2 header, 2 block, 4 adler), the -8 cell\'s premise');
  for (const [name, pos, named] of cells) {
    const r = run(pos);
    assert.equal(r.threw, undefined, `${name}: threw ${r.threw}`);
    assert.equal(r.ok, false, `${name}: answered ok (${r.ok ? `${r.value.out.length} B, consumed ${r.value.consumed}` : ''})`);
    assert.equal(r.error.code, 'bad_request', `${name}: ${r.error.code}: ${r.error.message}`);
    assert.equal(r.error.message, `inflate: pos (${named}) is not a position in a buffer of ${8 + member.length + empty.length} bytes`, name);
  }
});

test('a valid pos inflates the member there: node:zlib\'s bytes and the member\'s length', () => {
  for (const [pos, want, len] of [[junk.length, text, member.length], [junk.length + member.length, new Uint8Array(0), empty.length]]) {
    const r = run(pos);
    assert.equal(r.ok, true, `pos ${pos}: ${r.ok ? '' : r.error?.message ?? r.threw}`);
    assert.deepEqual([...r.value.out], [...want]);
    assert.deepEqual([...r.value.out], [...zlib.inflateSync(buf.subarray(pos, pos + len))], 'node:zlib from the same offset');
    assert.equal(r.value.consumed, len, 'consumed is the length of the member node:zlib wrote');
  }
  // omitted and -0 are position 0
  const whole = inflate(member);
  assert.equal(whole.ok && whole.value.consumed, member.length);
  const negZero = inflate(member, -0);
  assert.equal(negZero.ok && negZero.value.consumed, member.length);
});

test('pos exactly at the end is a valid position with no bytes: a cut member (zlib: unexpected end of file), not bad_request', () => {
  // the oracle: zlib on the same (empty) input reports a truncated stream
  assert.throws(() => zlib.inflateSync(buf.subarray(buf.length)), /unexpected end of file/);
  const r = run(buf.length);
  assert.equal(r.threw, undefined);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'pack_corrupt');
  // the same answer as an empty buffer at position 0
  const e = inflate(new Uint8Array(0), 0);
  assert.equal(e.ok, false);
  assert.equal(e.error.code, 'pack_corrupt');
  assert.equal(r.error.message, e.error.message);
});
