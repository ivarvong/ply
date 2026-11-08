import assert from 'node:assert/strict';
import { test } from 'vitest';
import { BLOB_CACHE_MAX_BYTES, BLOB_CACHE_MAX_AGE_SECONDS, BLOB_CACHE_HEADER, BLOB_OID_HEADER } from '../src/blobcache.js';

test('blob cache tunables: 32 MiB cap and 7d TTL (Workers Cache lives in ply-web)', () => {
  assert.equal(BLOB_CACHE_MAX_BYTES, 32 * 1024 * 1024);
  assert.equal(BLOB_CACHE_MAX_AGE_SECONDS, 7 * 24 * 60 * 60);
  assert.equal(BLOB_CACHE_HEADER, 'x-ply-blob-cache');
  assert.equal(BLOB_OID_HEADER, 'x-ply-blob-oid');
});

test('guardrail: ply src never uses the Cache API', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  async function* walk(dir) {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) yield* walk(p);
      else if (/\.(ts|js|mjs)$/.test(ent.name)) yield p;
    }
  }
  for await (const f of walk(new URL('../src', import.meta.url).pathname)) {
    const text = await readFile(f, 'utf8');
    // Comments may name the ban; fail on executable Cache API access.
    const code = text.split('\n').filter(l => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l)).join('\n');
    assert.equal(/\bcaches\s*\.\s*(default|open)\b/.test(code), false, `${f} uses the Cache API`);
  }
});
