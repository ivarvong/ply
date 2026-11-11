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

// digest() and hex() are snapshots (a running pack checksum reads the hash so far and keeps hashing): called any number
// of times they give the SHA-1 of the bytes fed so far, and update() continues from there. The expected value is
// node:crypto's over the same prefix, never the hasher's own earlier answer. Before this held, digest() padded the live
// state, so a second call hashed the message plus its padding: for 'abc', ec7a3886... where SHA-1 is a9993e36....
test('digest/hex are non-destructive snapshots: twice in a row, at random points of a stream, updates continuing', () => {
  // FIPS 180-1 appendix A's vector, so the first cell needs no oracle at all
  const abc = new Sha1().update(new TextEncoder().encode('abc'));
  assert.equal(abc.hex(), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(abc.hex(), 'a9993e364706816aba3e25717850c26c9cd0d89d', 'the second hex() of the same input');
  assert.equal(toHex(abc.digest()), 'a9993e364706816aba3e25717850c26c9cd0d89d', 'digest() after two hex()');
  // every buffered length 0..130 (both padding shapes, the block edges): digest twice, then keep hashing
  for (let n = 0; n <= 130; n++) {
    const b = bytes(n + 70, n + 11);
    const h = new Sha1().update(b.subarray(0, n));
    assert.equal(h.hex(), want(b.subarray(0, n)), `first, length ${n}`);
    assert.equal(toHex(h.digest()), want(b.subarray(0, n)), `second, length ${n}`);
    assert.equal(h.update(b.subarray(n)).hex(), want(b), `update after digest, length ${n}`);
  }
  // random streams: random chunk sizes, a snapshot (sometimes two) at random points, against node:crypto of the prefix
  let r = 0x9e3779b9;
  const next = () => { r ^= r << 13; r >>>= 0; r ^= r >>> 17; r ^= r << 5; r >>>= 0; return r; };
  for (let round = 0; round < 200; round++) {
    const n = next() % 5000;
    const b = bytes(n, round + 1);
    const h = new Sha1();
    let o = 0, snaps = 0;
    while (o < n) {
      const k = Math.min(n - o, next() % 300);
      h.update(b.subarray(o, o + k));
      o += k;
      if (next() % 3 === 0) {
        snaps++;
        assert.equal(h.hex(), want(b.subarray(0, o)), `round ${round}: snapshot at ${o} of ${n}`);
        if (next() % 2 === 0) assert.equal(toHex(h.digest()), want(b.subarray(0, o)), `round ${round}: again at ${o}`);
      }
    }
    assert.equal(h.hex(), want(b), `round ${round}: the whole input after ${snaps} snapshots`);
    assert.equal(h.hex(), want(b), `round ${round}: and once more`);
  }
});

test('the streaming hasher\'s hex() can be awaited twice (pure-JS path)', async () => {
  const b = bytes(1000, 5);
  const s = streamingSha1();
  await s.update(b);
  assert.equal(await s.hex(), want(b));
  assert.equal(await s.hex(), want(b));
});

// The native path (Workers' crypto.DigestStream), which node does not have: a stand-in with DigestStream's shape (a
// WritableStream whose `digest` promise settles on close) backed by node:crypto, so the expected value is still
// node:crypto's. Closing a closed writer rejects, which is what a second hex() used to do.
test('the streaming hasher\'s hex() can be awaited twice (native DigestStream path)', async () => {
  class FakeDigestStream extends WritableStream {
    constructor(algorithm) {
      const h = createHash(algorithm.replace('-', '').toLowerCase());
      let settle;
      const digest = new Promise(res => { settle = res; });
      super({ write(chunk) { h.update(chunk); }, close() { const d = h.digest(); settle(d.buffer.slice(d.byteOffset, d.byteOffset + d.length)); } });
      this.digest = digest;
    }
  }
  Object.defineProperty(globalThis.crypto, 'DigestStream', { value: FakeDigestStream, configurable: true });
  try {
    const b = bytes(5000, 9);
    const s = streamingSha1();
    assert.equal(s.kind, 'digeststream');
    await s.update(b.subarray(0, 1234));
    await s.update(b.subarray(1234));
    const first = s.hex(), second = s.hex();
    assert.equal(await first, want(b));
    assert.equal(await second, want(b));
    assert.equal(await s.hex(), want(b), 'and after both settled');
  } finally {
    delete globalThis.crypto.DigestStream;
  }
  assert.equal(streamingSha1().kind, 'js', 'the stand-in is gone');
});
