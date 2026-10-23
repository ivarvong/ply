// Bounds on everything an untrusted server can size. All allocations driven by wire data check these first.
import { fail } from './errors.js';
export const DEFAULT_LIMITS = Object.freeze({
  maxMergeBlobBytes: 8 * 1024 * 1024, // each side of a line merge (git's own cap is ~1 GiB; a Worker's memory is not)
  maxObjectSize: 64 * 1024 * 1024,   // inflated size of any single non-streamed object (trees, commits, metadata blobs)
  maxHarvestBytes: 32 * 1024 * 1024, // commits/trees kept per transport from over-wide packs (the blob:none fallback, fetch.js)
  maxPackBytes: 128 * 1024 * 1024,   // total band-1 bytes buffered by fetchPack
  maxDeltaResult: 64 * 1024 * 1024,  // result size claimed by a delta header
  maxDeltaChain: 64,
  maxRefs: 10000,                    // ls-refs lines
  maxSectionLines: 1000,             // shallow/ack lines per fetch
  maxTreeEntries: 200000,
  maxPathDepth: 128,
  maxPathComponent: 4096,
  requestTimeoutMs: 60000,           // per HTTP exchange incl. body streaming
});
export const withLimits = (o = {}) => Object.freeze({ ...DEFAULT_LIMITS, ...o });
export const limitError = (what, got, max) => fail('limit_exceeded', `${what} ${got} exceeds limit ${max}`, { what, got, max });
