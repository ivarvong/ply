// Caps for the public viewer. They are not environment-tunable: a mis-set var must not raise them.
// Rate limits are the exception (tests lower them); even those are clamped.
import { withLimits } from '../../src/limits.js';

export const VIEWER_UA = 'ply-viewer/0.1.0';

export const VIEWER_CAPS = Object.freeze({
  maxUpstreamBytes: 4 * 1024 * 1024,
  maxPackBytes: 2 * 1024 * 1024,
  maxPackObjects: 400,
  maxInflatedTotal: 4 * 1024 * 1024,
  maxObjectSize: 1 * 1024 * 1024,
  maxFileDisplayBytes: 256 * 1024,
  maxDeltaChain: 32,
  maxDeltaResult: 1 * 1024 * 1024,
  requestTimeoutMs: 12_000,
  pageTimeoutMs: 20_000,
  maxSubrequests: 16,
  maxRedirects: 2,
  maxRefs: 2_000,
  maxBranchesShown: 200,
  maxTreeShown: 500,
  maxLogCommits: 5,
  maxPreviewChars: 2_000,
  maxUrlLength: 2_048,
  maxLineRows: 4_000,
  ratePerMinute: 60,
  packRatePerMinute: 20,
  rateWindowMs: 60_000,
  rateCeiling: 1_000,
});

export const VIEWER_GIT_LIMITS = withLimits({
  maxObjectSize: VIEWER_CAPS.maxObjectSize,
  maxPackBytes: VIEWER_CAPS.maxPackBytes,
  maxHarvestBytes: VIEWER_CAPS.maxPackBytes,
  maxDeltaResult: VIEWER_CAPS.maxDeltaResult,
  maxDeltaChain: VIEWER_CAPS.maxDeltaChain,
  maxRefs: VIEWER_CAPS.maxRefs,
  maxTreeEntries: 2_000,
  requestTimeoutMs: VIEWER_CAPS.requestTimeoutMs,
  maxPackObjects: VIEWER_CAPS.maxPackObjects,
  maxInflatedTotal: VIEWER_CAPS.maxInflatedTotal,
});

export type RateBucket = 'page' | 'pack';

export function rateLimitFor(bucket: RateBucket, raw: string | undefined): number {
  const fallback = bucket === 'pack' ? VIEWER_CAPS.packRatePerMinute : VIEWER_CAPS.ratePerMinute;
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  if (n < 1) return 1;
  if (n > VIEWER_CAPS.rateCeiling) return VIEWER_CAPS.rateCeiling;
  return n;
}
