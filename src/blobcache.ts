// Inflated-blob size/TTL tunables shared with ply-web's Workers Cache BlobCache entrypoint.
//
// Caching itself is NOT here: Workers Cache (never the Cache API / caches.default) sits in front of
// ply-web's named BlobCache entrypoint (ctx.exports). See developers.cloudflare.com/workers/cache/
// and ply-web src/blob-cache.ts. This module only publishes the application caps so both sides agree.

/** Soft cap for a cacheable inflated blob (source: o11y). Above this, ply-web returns no-store. */
export const BLOB_CACHE_MAX_BYTES: number = 32 * 1024 * 1024;

/** Workers Cache max-age for verified inflated blobs (7 days). */
export const BLOB_CACHE_MAX_AGE_SECONDS: number = 7 * 24 * 60 * 60;

/** Front-door / BlobCache header carrying Cf-Cache-Status (HIT|MISS|…). */
export const BLOB_CACHE_HEADER = 'x-ply-blob-cache';

/** Blob oid echoed on a BlobCache response (for outer /v1/read stamping). */
export const BLOB_OID_HEADER = 'x-ply-blob-oid';
