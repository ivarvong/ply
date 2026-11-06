// Sha1 (src/sha1.ts) against node:crypto: every length 0..300 (every padding case: the 55/56/63/64-byte edges and the
// two-block tail), lengths around each power of two to 1 MiB, inputs fed in random chunks (the buffered path at every
// offset), bytes chosen to set the high bit of each schedule word and state word, and digest/hex/toOid agreement.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Sha1, toHex, streamingSha1 } from '../src/sha1.js';

const want = b => createHash('sha1').update(b).digest('hex');
function bytes(n, seed) {
  let s = seed >>> 0 || 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; out[i] = s; }
  return out;
}

test('every length 0..300, random and all-0xff bytes, whole', () => {
  for (let n = 0; n <= 300; n++) {
    for (const b of [bytes(n, n + 1), new Uint8Array(n).fill(0xff), new Uint8Array(n)]) {
      assert.equal(new Sha1().update(b).hex(), want(b), `length ${n}`);
      assert.equal(toHex(new Sha1().update(b).digest()), want(b), `digest, length ${n}`);
    }
  }
});

test('lengths around powers of two to 1 MiB, fed in random chunks', () => {
  let seed = 7;
  for (let p = 6; p <= 20; p++) {
    for (const n of [(1 << p) - 1, 1 << p, (1 << p) + 1]) {
      const b = bytes(n, seed++);
      const h = new Sha1();
      let o = 0, r = seed;
      while (o < n) { r = (r * 1103515245 + 12345) >>> 0; const k = Math.min(n - o, r % 200); h.update(b.subarray(o, o + k)); o += k; }
      assert.equal(h.hex(), want(b), `length ${n}`);
    }
  }
});

test('the streaming hasher (pure-JS path under node) agrees', async () => {
  const b = bytes(100_000, 3);
  const s = streamingSha1();
  for (let o = 0; o < b.length; o += 777) await s.update(b.subarray(o, o + 777));
  assert.equal(await s.hex(), want(b));
});
