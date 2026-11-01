// The only file under src/ that may spell the platform's missing value, an optional member (`?:`),
// optional chaining, or nullish coalescing. Mutation sharding assumes a flat src/ (scripts/mutate.mjs), so
// this boundary stays here rather than in a subdirectory.
//
// Oid's brand is `string & { readonly [brand] }`. The same intersection on the platform missing value is
// `never` (TypeScript 7), so it cannot carry a phantom. The brand is this file: every platform read comes
// through a function here, and what leaves is Option from result.ts (the one Option). Null stays a wire value.
import { none, some, type Option } from './result.js';

function isMissing(value: unknown): value is undefined {
  return value === undefined;
}

// Drops only the platform missing value. Null stays Some(null).
export function fromNullable<T>(value: T): Option<Exclude<T, undefined>> {
  if (isMissing(value)) return none;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the missing value is excluded; a generic T does not narrow
  return some(value as Exclude<T, undefined>);
}

// `?.` and `??` collapse null and the platform missing value. That collapse happens here, once.
export function fromNullish<T>(value: T): Option<Exclude<T, null | undefined>> {
  if (value === null || isMissing(value)) return none;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- null and the missing value are excluded; a generic T does not narrow
  return some(value as Exclude<T, null | undefined>);
}

// A field typed as Option that a JavaScript caller omitted. A real Option passes through; omission is None.
export function asOption<T>(value: Option<T> | undefined): Option<T> {
  if (isMissing(value)) return none;
  return value;
}

// A platform API that still demands its missing value. The word stays in this file; callers pass the result on.
export function unwrapOrAbsent<T>(value: Option<T>): T | undefined {
  if (value.tag === 'none') return undefined;
  return value.value;
}

// Direct index read: a negative index is absent, not the element from the end (that is Array#at's other behaviour).
type Indexed<T> = ArrayLike<T> & { at(index: number): T | undefined };

export function at<T>(items: Indexed<T>, index: number): Option<T> {
  // A non-integer or a negative index is absent. Array#at would coerce 1.5 to 1 and wrap -1 to the last element.
  // Past the end is a missing read, which fromNullable turns into None (no separate length test: it would be the same result).
  if (!Number.isInteger(index) || index < 0) return none;
  return fromNullable(items.at(index));
}

// Same read, with the caller's domain fallback. Does not allocate an Option (hot paths: hex tables, byte scans).
export function atOr<T>(items: Indexed<T>, index: number, fallback: T): T {
  if (!Number.isInteger(index) || index < 0) return fallback;
  const value = items.at(index);
  if (isMissing(value)) return fallback;
  return value;
}

export function mapGet<K, V>(table: ReadonlyMap<K, V>, key: K): Option<V> {
  return fromNullable(table.get(key));
}

export function readKey<T extends object, K extends keyof T>(obj: T, key: K): Option<Exclude<T[K], undefined>> {
  return fromNullable(obj[key]);
}

// Invalid JSON is None. JSON null is Some(null); callers that want null as absence use fromNullish on the value.
export function jsonDecode(text: string): Option<unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return fromNullable(value);
  } catch {
    return none;
  }
}

// A byte index is in [lo, hi]. Out of range, a non-integer index, and a hole are not. No Option allocation:
// UTF-8 and the pack parsers ask this per byte.
export function byteInRange(buf: Uint8Array, index: number, lo: number, hi: number): boolean {
  if (!Number.isInteger(index) || index < 0) return false;
  const value = buf.at(index);
  // Stryker disable next-line LogicalOperator: a missing byte compared with >= is false, so dropping the missing test changes no result (it is there for the type)
  return value !== undefined && value >= lo && value <= hi;
}
