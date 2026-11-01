// Closed sets ply decides on. A wire string stays open: unknown is the behaviour it has today (unsupported
// object-format, a capability that is stored and not required). Adding a member breaks the switch that handles it.
import { assertNever } from './result.js';

export type FetchFeature = 'filter' | 'shallow' | 'wait-for-done' | 'ref-in-want' | 'sideband-all';

export type FetchFeatureFlags = {
  readonly filter: boolean;
  readonly shallow: boolean;
  readonly waitForDone: boolean;
  readonly refInWant: boolean;
  readonly sidebandAll: boolean;
};

// Every feature ply copies onto DiscoverInfo. A feature without a field, or a field without a feature, does not compile.
const FETCH_FEATURE_FIELD = {
  filter: 'filter',
  shallow: 'shallow',
  'wait-for-done': 'waitForDone',
  'ref-in-want': 'refInWant',
  'sideband-all': 'sidebandAll',
} as const satisfies Record<FetchFeature, keyof FetchFeatureFlags>;

const featureOn = (features: readonly string[], feature: FetchFeature): boolean => {
  switch (feature) {
    case 'filter':
    case 'shallow':
    case 'wait-for-done':
    case 'ref-in-want':
    case 'sideband-all':
      return features.includes(feature);
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(feature);
};

export function fetchFeatureFlags(features: readonly string[]): FetchFeatureFlags {
  const field = FETCH_FEATURE_FIELD;
  return {
    [field.filter]: featureOn(features, 'filter'),
    [field.shallow]: featureOn(features, 'shallow'),
    [field['wait-for-done']]: featureOn(features, 'wait-for-done'),
    [field['ref-in-want']]: featureOn(features, 'ref-in-want'),
    [field['sideband-all']]: featureOn(features, 'sideband-all'),
  };
}

export type RequiredV2Cap = 'ls-refs' | 'fetch';
export type RequiredCapCheck = { readonly tag: 'ok' } | { readonly tag: 'missing'; readonly cap: RequiredV2Cap };

// Source order is the order discover reports a missing capability (ls-refs, then fetch).
const REQUIRED_V2 = ['ls-refs', 'fetch'] as const;
type ClosedList<U, T extends readonly U[]> = [U] extends [T[number]] ? T : never;
const requiredV2: ClosedList<RequiredV2Cap, typeof REQUIRED_V2> = REQUIRED_V2;

export function checkRequiredV2(has: (key: string) => boolean): RequiredCapCheck {
  for (const cap of requiredV2) {
    switch (cap) {
      case 'ls-refs':
      case 'fetch':
        if (!has(cap)) return { tag: 'missing', cap };
        continue;
    }
    // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
    return assertNever(cap);
  }
  return { tag: 'ok' };
}

export type KnownObjectFormat = 'sha1' | 'sha256';
export type FormatDecision = { readonly tag: 'ok' } | { readonly tag: 'refused'; readonly format: string };

function decideKnownFormat(format: KnownObjectFormat): FormatDecision {
  switch (format) {
    case 'sha1': return { tag: 'ok' };
    case 'sha256': return { tag: 'refused', format };
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(format);
}

// sha1 is the format ply speaks. sha256 and any format this client has not named are refused by that name.
export function decideObjectFormat(raw: string): FormatDecision {
  switch (raw) {
    case 'sha1':
    case 'sha256':
      return decideKnownFormat(raw);
    default:
      return { tag: 'refused', format: raw };
  }
}
