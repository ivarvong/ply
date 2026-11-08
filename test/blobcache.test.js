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
  assert.ok(k.startsWith('https://ply.blob/v3/'));
});

test('scope isolation: a hit under repo A is a miss under repo B (same oid)', async () => {
  const store = memoryCache();
  const binding = { store, waitUntil: null, maxBytes: BLOB_CACHE_MAX_BYTES, maxAge: BLOB_CACHE_MAX_AGE_SECONDS };
  const body = te.encode('hello-from-a');
  let put = '';
  storeBlobCache(
    { binding, scope: SCOPE_A, oid: OID, size: body.byteLength, bytes: body, key: await blobCacheKey(SCOPE_A, OID) },
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

test('oversize bypass: storeBlobCache does not put when size > maxBytes', async () => {
  const store = memoryCache();
  const binding = { store, waitUntil: null, maxBytes: 8, maxAge: 60 };
  let outcome = 'none';
  const body = te.encode('0123456789ABCDEF');
  storeBlobCache({ binding, scope: SCOPE_A, oid: OID, size: 16, bytes: body, key: await blobCacheKey(SCOPE_A, OID) }, (o) => { outcome = o; });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(store.entries.size, 0, 'oversize must not be stored');
  assert.equal(outcome, 'none', 'no put_ok/put_error when bypassed');
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
    { binding, scope: SCOPE_A, oid: OID, size: payload.byteLength, bytes: payload, key: await blobCacheKey(SCOPE_A, OID) },
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

test('poisoned size-0 entry for a non-empty oid is a miss and is evicted', async () => {
  const store = memoryCache();
  const binding = { store, waitUntil: null, maxBytes: BLOB_CACHE_MAX_BYTES, maxAge: 60 };
  const key = await blobCacheKey(SCOPE_A, OID);
  await store.put(key, new Response(new Uint8Array(), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream', 'content-length': '0', [BLOB_OID_HEADER]: OID },
  }));
  const looked = await lookupBlobCache(binding, SCOPE_A, OID);
  assert.equal(looked.outcome, 'miss');
  assert.equal(store.entries.has(key), false, 'poisoned size-0 entry must be deleted');
});

test('short fill: byteLength !== size is put_error and stores nothing', async () => {
  const store = memoryCache();
  const binding = { store, waitUntil: null, maxBytes: BLOB_CACHE_MAX_BYTES, maxAge: 60 };
  let outcome = '';
  let err = '';
  storeBlobCache(
    { binding, scope: SCOPE_A, oid: OID, size: 10, bytes: te.encode('short'), key: await blobCacheKey(SCOPE_A, OID) },
    (o, e) => { outcome = o; err = e; },
  );
  assert.equal(outcome, 'put_error');
  assert.match(err, /short fill/);
  assert.equal(store.entries.size, 0);
});

test('poisoned empty body with non-zero Content-Length is a miss and is evicted', async () => {
  const store = memoryCache();
  const binding = { store, waitUntil: null, maxBytes: BLOB_CACHE_MAX_BYTES, maxAge: 60 };
  const key = await blobCacheKey(SCOPE_A, OID);
  // Mirrors Workers Cache after a tee/put race: declared CL kept, body empty (#229 residual).
  await store.put(key, new Response(new Uint8Array(), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream', 'content-length': '6', [BLOB_OID_HEADER]: OID },
  }));
  // memoryCache stores the actual empty body + the CL header as given.
  store.entries.set(key, { body: new Uint8Array(), headers: { 'content-type': 'application/octet-stream', 'content-length': '6', [BLOB_OID_HEADER]: OID } });
  const looked = await lookupBlobCache(binding, SCOPE_A, OID);
  assert.equal(looked.outcome, 'miss', 'body length must match Content-Length');
  assert.equal(store.entries.has(key), false, 'mismatched entry must be deleted');
});

test('tee+FixedLengthStream race: streaming put can store empty body with declared CL; buffer fill cannot', async () => {
  // Repro of the #228/#229 failure mode without workerd: client drains one tee branch through a
  // FixedLengthStream-shaped cancel, then cache.put reads the cancelled twin (empty) while headers
  // still declare Content-Length = size.
  const payload = te.encode('hello\n');
  const size = payload.byteLength;

  function holdLastChunk(source) {
    let held = null;
    return source.pipeThrough(new TransformStream({
      transform(chunk, ctl) {
        if (chunk.byteLength === 0) return;
        if (held) ctl.enqueue(held);
        held = chunk;
      },
      flush(ctl) {
        if (held) ctl.enqueue(held);
        held = null;
      },
    }));
  }

  // --- buggy path (tee + put stream) ---
  const storeBad = memoryCache();
  const keyBad = 'https://ply.blob/test/tee-race';
  const srcBad = new ReadableStream({
    start(c) { c.enqueue(payload); c.close(); },
  });
  const [toClient, toCache] = srcBad.tee();
  // Simulate FixedLengthStream: read exactly `size` bytes then cancel upstream.
  const clientParts = [];
  const reader = holdLastChunk(toClient).getReader();
  let got = 0;
  while (got < size) {
    const { done, value } = await reader.read();
    if (done) break;
    clientParts.push(value);
    got += value.byteLength;
  }
  await reader.cancel(); // FixedLengthStream closes → cancel remainder
  // Put starts after the client finished (or concurrently after cancel) — body may already be empty.
  await storeBad.put(keyBad, new Response(toCache, {
    status: 200,
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(size), [BLOB_OID_HEADER]: OID },
  }));
  // Force the poison shape Workers produced: empty body, declared CL.
  const stored = storeBad.entries.get(keyBad);
  assert.ok(stored);
  // If the race fired, body is short; either way overwrite to the prod-observed poison to assert lookup.
  if (stored.body.byteLength !== size) {
    storeBad.entries.set(keyBad, { body: new Uint8Array(), headers: { ...stored.headers, 'content-length': String(size) } });
  } else {
    // Even if this runtime's tee did not cancel the twin, inject the observed Workers poison.
    storeBad.entries.set(keyBad, { body: new Uint8Array(), headers: { 'content-type': 'application/octet-stream', 'content-length': String(size), [BLOB_OID_HEADER]: OID } });
  }
  const bindingBad = { store: storeBad, waitUntil: null, maxBytes: BLOB_CACHE_MAX_BYTES, maxAge: 60 };
  // Stash under a real key so lookupBlobCache finds it.
  const realKey = await blobCacheKey(SCOPE_A, OID);
  storeBad.entries.set(realKey, storeBad.entries.get(keyBad));
  const lookedBad = await lookupBlobCache(bindingBad, SCOPE_A, OID);
  assert.equal(lookedBad.outcome, 'miss', 'poisoned empty+CL must not be a hit');

  // --- fixed path (buffer put) ---
  const storeGood = memoryCache();
  const bindingGood = { store: storeGood, waitUntil: null, maxBytes: BLOB_CACHE_MAX_BYTES, maxAge: 60 };
  let put = '';
  storeBlobCache(
    { binding: bindingGood, scope: SCOPE_A, oid: OID, size, bytes: payload, key: await blobCacheKey(SCOPE_A, OID) },
    (o) => { put = o; },
  );
  await new Promise(r => setTimeout(r, 0));
  assert.equal(put, 'put_ok');
  const lookedGood = await lookupBlobCache(bindingGood, SCOPE_A, OID);
  assert.equal(lookedGood.outcome, 'hit');
  const parts = [];
  const r = lookedGood.stream.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    parts.push(value);
  }
  assert.equal(Buffer.concat(parts.map(u => Buffer.from(u))).toString(), 'hello\n');
});
