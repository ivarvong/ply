// What ply writes on `x-ply-pack-cache`, and the only reading of that header that decides a retry.
// The span keeps the raw header (an unknown value is observable). A retry treats only HIT as a hit:
// MISS, BUST, a missing header, and anything a cache may add later (EXPIRED) are not.
import { assertNever } from './result.js';

/** `''` is a response the cache did not stamp. */
export type PackCacheStatus = 'HIT' | 'MISS' | 'BUST' | '';
type CacheRead = { readonly tag: 'known'; readonly status: PackCacheStatus } | { readonly tag: 'other' };

export function cacheHeader(status: PackCacheStatus): PackCacheStatus {
  switch (status) {
    case 'HIT':
    case 'MISS':
    case 'BUST':
    case '':
      return status;
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(status);
}

function readCacheStatus(raw: unknown): CacheRead {
  switch (raw) {
    case 'HIT':
    case 'MISS':
    case 'BUST':
    case '':
      return { tag: 'known', status: raw };
    default:
      return { tag: 'other' };
  }
}

function knownHit(status: PackCacheStatus): boolean {
  switch (status) {
    case 'HIT': return true;
    case 'MISS':
    case 'BUST':
    case '':
      return false;
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(status);
}

// Unknown is not a hit, same as a comparison against HIT (a hostile or newer cache header must not bust-retry).
export function isCacheHit(raw: unknown): boolean {
  const read = readCacheStatus(raw);
  switch (read.tag) {
    case 'other': return false;
    case 'known': return knownHit(read.status);
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(read);
}

// Own `cacheStatus` on a thrown value. A missing object or field is the unstamped header, not a hit.
export function thrownCacheStatus(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !Object.hasOwn(error, 'cacheStatus')) return '';
  return Reflect.get(error, 'cacheStatus');
}

// True only for pack_corrupt served from a cache HIT: the one case fetch retries once.
export function corruptCacheHit(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !Object.hasOwn(error, 'code')) return false;
  if (Reflect.get(error, 'code') !== 'pack_corrupt') return false;
  return isCacheHit(thrownCacheStatus(error));
}
