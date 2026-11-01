// Adding a member to a closed union fails typecheck at the handler. A used @ts-expect-error that is not an
// error fails `tsc`, so each incomplete switch below has to stay an error. The complete ones are the pattern:
// every member, no default, assertNever as the next statement.
import { assertNever } from '../../src/result.js';
import type { PackCacheStatus } from '../../src/cachestatus.js';
import type { PackKind } from '../../src/format.js';
import type { FetchFeature, KnownObjectFormat, RequiredV2Cap } from '../../src/closed.js';
import type { NamedHttpStatus } from '../../src/http.js';

const cacheLabel = (s: PackCacheStatus): string => {
  switch (s) {
    case 'HIT': return 'hit';
    case 'MISS': return 'miss';
    case 'BUST': return 'bust';
    case '': return 'none';
  }
  return assertNever(s);
};
void cacheLabel;

const cacheMissing = (s: PackCacheStatus): string => {
  switch (s) {
    case 'HIT': return 'hit';
    case 'MISS': return 'miss';
    case 'BUST': return 'bust';
  }
  // @ts-expect-error '' is still possible, so s is not never
  return assertNever(s);
};
void cacheMissing;

const typeLabel = (t: PackKind): string => {
  switch (t) {
    case 'commit': case 'tree': case 'blob': case 'tag': case 'ofs_delta': case 'ref_delta': return t;
  }
  return assertNever(t);
};
void typeLabel;

const typeMissing = (t: PackKind): string => {
  switch (t) {
    case 'commit': case 'tree': case 'blob': case 'tag': case 'ofs_delta': return t;
  }
  // @ts-expect-error 'ref_delta' is still possible, so t is not never
  return assertNever(t);
};
void typeMissing;

const featureLabel = (f: FetchFeature): string => {
  switch (f) {
    case 'filter': case 'shallow': case 'wait-for-done': case 'ref-in-want': case 'sideband-all': return f;
  }
  return assertNever(f);
};
void featureLabel;

const featureMissing = (f: FetchFeature): string => {
  switch (f) {
    case 'filter': return f;
  }
  // @ts-expect-error the other fetch features are still possible, so f is not never
  return assertNever(f);
};
void featureMissing;

const formatLabel = (f: KnownObjectFormat): string => {
  switch (f) {
    case 'sha1': case 'sha256': return f;
  }
  return assertNever(f);
};
void formatLabel;

const formatMissing = (f: KnownObjectFormat): string => {
  switch (f) {
    case 'sha1': return f;
  }
  // @ts-expect-error 'sha256' is still possible, so f is not never
  return assertNever(f);
};
void formatMissing;

const capLabel = (c: RequiredV2Cap): string => {
  switch (c) {
    case 'ls-refs': case 'fetch': return c;
  }
  return assertNever(c);
};
void capLabel;

const capMissing = (c: RequiredV2Cap): string => {
  switch (c) {
    case 'ls-refs': return c;
  }
  // @ts-expect-error 'fetch' is still possible, so c is not never
  return assertNever(c);
};
void capMissing;

const statusLabel = (s: NamedHttpStatus): string => {
  switch (s) {
    case 401: case 403: case 404: case 429: return String(s);
  }
  return assertNever(s);
};
void statusLabel;

const statusMissing = (s: NamedHttpStatus): string => {
  switch (s) {
    case 401: case 403: case 404: return String(s);
  }
  // @ts-expect-error 429 is still possible, so s is not never
  return assertNever(s);
};
void statusMissing;
