// Content-addressed cache of *verified, inflated* blob bytes in the Workers Cache API shape
// (`caches.default` on Workers, memoryCache() in tests — same PackCache surface as packcache.ts).
//
// Why this exists: a wants-only blob fetch has no filter line, so the pack HTTP cache (GitCache /
// packcache) bypasses it. Inflating a 20 MiB blob from a ~50 KiB zlib pack dominates read/big20m
// wall time (loop 2026-11-08 variance: r(client, inflate) ≈ 0.86). Caching the verified inflated
// bytes skips inflate+hash on a hit.
//
// Security (scope isolation): the cache key is sha256("ply-blob/2\n" + scope + "\n" + oid), where
// `scope` is the transport's credential-free remote URL (t.url). openBlob is only reached after
// the caller has authenticated that remote (operation → createTransport with the request's token).
// A token for repo A never builds a transport whose url is repo B, so it cannot match B's keys.
// Auth therefore runs before the cache lookup, and the key includes the authorized repo. Tests in
// test/blobcache.test.js prove cross-scope isolation.
//
// Integrity: the OID *is* the content hash. Only bytes that passed openBlob's OID verify (fill path)
// are ever written (cache.put runs from the verified outbound stream after flush succeeds; a verify
// failure errors the stream and the put does not complete). A hit is trusted: the key names the oid
// and only verified bytes are stored. Pack-trailer verification is not enough on its own (trailer ≠
// content oid); that check stays on the miss/fill path.
//
// Tunables (dated predictions, 2026-11-08 America/New_York):
//   maxCacheableBytes = 32 MiB — source: cf o11y git.read.blob.size, service=ply, last 24h, n=307;
//     p50=18, p90=p99=max=20_971_520. Headroom ×1.53 → 32 MiB so the observed max (big/20m.bin) is
//     cacheable. Status: calibrated from that window.
//   maxAgeSeconds = 604_800 (7d) — content-addressed (immutable oid). Not from the size distribution;
//     PRIOR for retention until hit-age telemetry exists. 7d keeps warm across CD dwells.
//
// Streaming: on a miss the key is awaited first, then the verified ReadableStream is tee'd — one
// branch to the caller, one to cache.put(Response) under waitUntil. Put must start reading before the
// client drains the twin (a prior await-before-put stored empty bodies with Content-Length rewritten to 0).

import type { PackCache } from './packcache.js';
import { te } from './bytes.js';
import { fromNullish } from './absent.js';
import type { Option } from './result.js';
import { getOrElse, none } from './result.js';

export type { PackCache };

/** Calibrated 2026-11-08 from o11y git.read.blob.size (n=307, max=20 MiB) × ~1.5 headroom. */
export const BLOB_CACHE_MAX_BYTES: number = 32 * 1024 * 1024;
/** PRIOR (uncalibrated retention): 7d; content-addressed. Revisit from hit-age once emitted. */
export const BLOB_CACHE_MAX_AGE_SECONDS: number = 7 * 24 * 60 * 60;

export const BLOB_CACHE_HEADER = 'x-ply-blob-cache';
export const BLOB_OID_HEADER = 'x-ply-blob-oid';
export const BLOB_CACHE_NAMESPACE = 'https://ply.blob/v2/';

export type BlobCacheOutcome = 'hit' | 'miss' | 'bypass_oversize' | 'put_error' | 'bypass';

export type BlobCacheBinding = {
  readonly store: PackCache;
  readonly waitUntil: ((p: Promise<unknown>) => void) | null;
  readonly maxBytes: number;
  readonly maxAge: number;
};

/** Key: namespace + hex(sha256("ply-blob/2\\nscope\\noid\\n")). Scope is the authorized remote URL. */
export async function blobCacheKey(scope: string, oid: string, namespace: string = BLOB_CACHE_NAMESPACE): Promise<string> {
  const material = te.encode(`ply-blob/2\n${scope}\n${oid.toLowerCase()}\n`);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', material));
  let hex = '';
  for (const b of d) hex += b.toString(16).padStart(2, '0');
  return namespace + hex;
}

export type BlobCacheHit = {
  readonly outcome: 'hit';
  readonly size: number;
  readonly stream: ReadableStream<Uint8Array>;
  readonly bytes: number;
};

export type BlobCacheLookup =
  | BlobCacheHit
  | { readonly outcome: 'miss' };

/** Lookup. A mismatched oid header is treated as a miss (and the entry is deleted). */
export async function lookupBlobCache(
  binding: BlobCacheBinding,
  scope: string,
  oid: string,
): Promise<BlobCacheLookup> {
  const key = await blobCacheKey(scope, oid);
  const hit: Option<Response> = await binding.store.match(key).then(fromNullish, (): Option<Response> => none);
  // oxlint-disable-next-line typescript/strict-boolean-expressions -- Cache API: falsy is a miss
  if (hit.tag === 'none' || !hit.value) return { outcome: 'miss' };
  const res = hit.value;
  const body = res.body;
  if (body === null) return { outcome: 'miss' };
  const gotOid = getOrElse(fromNullish(res.headers.get(BLOB_OID_HEADER)), '').toLowerCase();
  // Content-Length must be present: Number('') === 0 would false-hit an empty body after a failed fill.
  const lenHdrOpt = fromNullish(res.headers.get('content-length'));
  if (lenHdrOpt.tag === 'none' || lenHdrOpt.value === '') {
    await binding.store.delete(key).catch(() => null);
    return { outcome: 'miss' };
  }
  const size = Number(lenHdrOpt.value);
  if (gotOid !== oid.toLowerCase() || !Number.isInteger(size) || size < 0) {
    await binding.store.delete(key).catch(() => null);
    return { outcome: 'miss' };
  }
  // Poisoned fills rewrote Content-Length to 0 with an empty body (tee/put race, 2026-11-08).
  // A real empty blob is only the well-known empty-tree-file oid; anything else at size 0 is a miss.
  const EMPTY_BLOB_OID = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
  if (size === 0 && gotOid !== EMPTY_BLOB_OID) {
    await binding.store.delete(key).catch(() => null);
    return { outcome: 'miss' };
  }
  return { outcome: 'hit', size, stream: body, bytes: size };
}

export type StoreBlobArgs = {
  readonly binding: BlobCacheBinding;
  readonly scope: string;
  readonly oid: string;
  readonly size: number;
  readonly body: ReadableStream<Uint8Array>;
  /** Precomputed blobCacheKey — must be awaited before tee so put starts reading immediately. */
  readonly key: string;
};

/**
 * Store verified inflated bytes. Caller must only pass a stream that completes after OID verify.
 * Oversize → cancel body, no put. Errors → onOutcome('put_error').
 */
export function storeBlobCache(args: StoreBlobArgs, onOutcome: (o: 'put_ok' | 'put_error', errText: string) => void): void {
  const { binding, oid, size, body, key } = args;
  if (size > binding.maxBytes) {
    const cancel = body.cancel().catch(() => null);
    if (binding.waitUntil) binding.waitUntil(cancel);
    return;
  }
  // Put must start reading `body` before the caller's tee twin drains — any await before
  // Response construction lets the client cancel this branch and we store an empty entry.
  const headers = new Headers({
    'content-type': 'application/octet-stream',
    'content-length': String(size),
    [BLOB_OID_HEADER]: oid.toLowerCase(),
    'cache-control': `public, max-age=${binding.maxAge}, immutable`,
    [BLOB_CACHE_HEADER]: 'MISS',
  });
  // oxlint-disable-next-line promise/always-return -- onOutcome is the result; put's value is unused (waitUntil)
  const put = (async (): Promise<void> => {
    try {
      await binding.store.put(key, new Response(body, { status: 200, headers }));
      onOutcome('put_ok', '');
    } catch (e) {
      onOutcome('put_error', e instanceof Error ? e.message.slice(0, 200) : 'put failed');
      await body.cancel().catch(() => null);
    }
  })();
  if (binding.waitUntil) binding.waitUntil(put);
}
