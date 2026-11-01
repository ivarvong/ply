// What the entry modules (edit, read, log, checkout, tree) read that no converted module declares. The types go in the
// A pass (A7), when the entries stop catching thrown values. The readers below are the runtime: one narrowing per
// field, so a catch does not cast.
import type { Attrs } from './otel.js';
import type { OperationOpts } from './operation.js';

// A thrown value, read loosely as the JS did (`e?.code`): any field may be missing, and a primitive has none. Errors
// become values in the A pass; until then a `catch` reads them through the functions below, which are that read.
export type Caught = { readonly code?: unknown; readonly message: string; readonly attrs?: Attrs } | null | undefined;

// The same read as `e?.field` (optional chaining: null and undefined have no fields, a primitive has none of these).
const isObject = (e: unknown): e is object => typeof e === 'object' && e !== null;
export const thrownCode = (e: unknown): unknown => (isObject(e) && 'code' in e ? e.code : undefined);
export const thrownReason = (e: unknown): unknown => (isObject(e) && 'reason' in e ? e.reason : undefined);
export const thrownMessage = (e: unknown): unknown => (isObject(e) && 'message' in e ? e.message : undefined);
export const thrownName = (e: unknown): unknown => (isObject(e) && 'name' in e ? e.name : undefined);
export const thrownStack = (e: unknown): unknown => (isObject(e) && 'stack' in e ? e.stack : undefined);
// Span attributes are a record. A missing or non-object `attrs` is absent, which is what `if (e.attrs) span.set` skipped.
const isAttrs = (v: unknown): v is Attrs => v !== null && typeof v === 'object';
export const thrownAttrs = (e: unknown): Attrs | undefined => (isObject(e) && 'attrs' in e && isAttrs(e.attrs) ? e.attrs : undefined);
// RegExp#test coerces a non-string the way the entries did (a thrown message is not always a string). A string is tested as itself.
export const thrownMessageMatches = (e: unknown, re: RegExp): boolean => {
  const message = thrownMessage(e);
  return typeof message === 'string' ? re.test(message) : re.test(String(message));
};

// operation.ts's options as the entries take them. `capabilities` is required (a total record). The entries add
// `attrs`, `onFinish` and `link` when they call operation(), and hand the object through one assertion.
export type EntryOptions = Omit<OperationOpts, 'attrs' | 'onFinish' | 'link'>;

// objects.ts TYPE_NAME, indexed by a type number read off the wire (any number: a lookup may miss).
export type TypeNames = Readonly<Record<number, string | undefined>>;
