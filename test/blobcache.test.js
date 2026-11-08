// Inflated-blob Workers Cache: keying, scope isolation, oversize bypass, corrupted-fill rejection.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { blobCacheKey, lookupBlobCache, storeBlobCache, BLOB_CACHE_MAX_BYTES, BLOB_CACHE_MAX_AGE_SECONDS, BLOB_OID_HEADER } from '../src/blobcache.js';
import { memoryCache } from '../src/packcache.js';
import { te } from '../src/bytes.js';

const OID = 'a'.repeat(40);
const OID2 = 'b'.repeat(40);
const SCOPE_A = 'https://artifacts.example/git/ns/repo-a.git';
const SCOPE_B = 'https://artifacts.example/git/ns/repo-b.git';

test('blobCacheKey: scope and oid separate entries; oid case-normalized', async () => {
  const k = await blobCacheKey(SCOPE_A, OID);
  assert.notEqual(k, await blobCacheKey(SCOPE_B, OID), 'different repos must not share a key');
  assert.notEqual(k, await blobCacheKey(SCOPE_A, OID2), 'different oids must not share a key');
  assert.equal(k, await blobCacheKey(SCOPE_A, OID.toUpperCase()), 'oid hex is case-insensitive');
  assert.ok(k.startsWith('https://ply.blob/'));
});

test('scope isolation: a hit under repo A is a miss under repo B (same oid)', async () => {
  const store = memoryCache();
  const binding = { store, waitUntil: null, maxBytes: BLOB_CACHE_MAX_BYTES, maxAge: BLOB_CACHE_MAX_AGE_SECONDS };
  const body = te.encode('hello-from-a');
  let put = '';
  storeBlobCache(
    { binding, scope: SCOPE_A, oid: OID, size: body.byteLength, body: new ReadableStream({ start(c) { c.enqueue(body); c.close(); } }) },
    (o) => { put = o; },
  );
  await new Promise(r => setTimeout(r, 0));
  assert.equal(put, 'put_ok');
  const hitA = await lookupBlobCache(binding, SCOPE_A, OID);
  assert.equal(hitA.outcome, 'hit');
  assert.equal(hitA.size, body.byteLength);
  const missB = await lookupBlobCache(binding, SCOPE_B, OID);
  assert.equal(missB.outcome, 'miss', 'token for B must not see A\'s cached object');
});

test('oversize bypass: storeBlobCache cancels and does not put when size > maxBytes', async () => {
  const store = memoryCache();
  const binding = { store, waitUntil: null, maxBytes: 8, maxAge: 60 };
  let outcome = 'none';
  const chunks = [];
  const body = new ReadableStream({
    start(c) { c.enqueue(te.encode('0123456789ABCDEF')); c.close(); },
    cancel() { chunks.push('cancelled'); },
  });
  storeBlobCache({ binding, scope: SCOPE_A, oid: OID, size: 16, body }, (o) => { outcome = o; });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(store.entries.size, 0, 'oversize must not be stored');
  assert.equal(outcome, 'none', 'no put_ok/put_error when bypassed');
  assert.ok(chunks.includes('cancelled'));
});

test('corrupted-fill rejection: mismatched oid header is treated as miss and evicted', async () => {
  const store = memoryCache();
  const binding = { store, waitUntil: null, maxBytes: BLOB_CACHE_MAX_BYTES, maxAge: 60 };
  const key = await blobCacheKey(SCOPE_A, OID);
  await store.put(key, new Response(te.encode('poison'), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream', 'content-length': '6', [BLOB_OID_HEADER]: OID2 },
  }));
  const looked = await lookupBlobCache(binding, SCOPE_A, OID);
  assert.equal(looked.outcome, 'miss');
  assert.equal(store.entries.has(key), false, 'poisoned entry must be deleted');
});

test('fill then hit: verified bytes round-trip', async () => {
  const store = memoryCache();
  const binding = { store, waitUntil: (p) => { void p; }, maxBytes: 1024, maxAge: 60 };
  const payload = te.encode('verified-bytes');
  storeBlobCache(
    { binding, scope: SCOPE_A, oid: OID, size: payload.byteLength, body: new ReadableStream({ start(c) { c.enqueue(payload); c.close(); } }) },
    () => {},
  );
  await new Promise(r => setTimeout(r, 0));
  const hit = await lookupBlobCache(binding, SCOPE_A, OID);
  assert.equal(hit.outcome, 'hit');
  const reader = hit.stream.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const got = Buffer.concat(parts.map(u => Buffer.from(u))).toString();
  assert.equal(got, 'verified-bytes');
});
