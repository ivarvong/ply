// What the entry modules (edit, read, log, checkout, tree) read that no converted module declares. The types go in the
// A pass (A7), when the entries stop catching thrown values. The readers below are the runtime: one narrowing per
// field, so a catch does not cast.
import type { Attrs, Tracer } from './otel.js';
import type { OperationConfig } from './operation.js';
import type { FetchLike } from './http.js';
import type { Option } from './result.js';
import { getOrElse, none, some } from './result.js';
import { isPlyCode } from './errors.js';
import type { Input } from './absent.js';
import { field } from './absent.js';

// A thrown value is `unknown`: any field may be missing, and a primitive has none. Errors become values in the A pass;
// until then a `catch` reads them through the functions below, each one Option-returning read of one field.

// A field of a thrown value: None when the value is not an object, lacks the field, or holds null or the platform
// missing value there (what the JS's loose read collapsed). A primitive has none of these fields.
const thrownField = field;
export const thrownCode = (e: unknown): Option<unknown> => thrownField(e, 'code');
export const thrownReason = (e: unknown): Option<unknown> => thrownField(e, 'reason');
export const thrownMessage = (e: unknown): Option<unknown> => thrownField(e, 'message');
export const thrownName = (e: unknown): Option<unknown> => thrownField(e, 'name');
export const thrownStack = (e: unknown): Option<unknown> => thrownField(e, 'stack');
// Span attributes are a record. A missing or non-object `attrs` is None, which is what `if (e.attrs) span.set` skipped.
const isAttrs = (v: unknown): v is Attrs => v !== null && typeof v === 'object';
export const thrownAttrs = (e: unknown): Option<Attrs> => { const a = thrownField(e, 'attrs'); return a.tag === 'some' && isAttrs(a.value) ? some(a.value) : none; };
// The thrown value's code when it has one, else `fallback`.
export const thrownCodeOr = (e: unknown, fallback: unknown): unknown => getOrElse(thrownCode(e), fallback);
export const thrownCodeIs = (e: unknown, code: string): boolean => { const c = thrownCode(e); return c.tag === 'some' && c.value === code; };
export const thrownReasonIs = (e: unknown, reason: string): boolean => { const r = thrownReason(e); return r.tag === 'some' && r.value === reason; };
// A thrown value that already carries one of ply's codes (typed: keep it), as opposed to a platform failure to wrap.
export const isPlyThrown = (e: unknown): boolean => { const c = thrownCode(e); return c.tag === 'some' && isPlyCode(c.value); };
// What a thrown value says: its message, or the value itself as String() renders it.
export const thrownText = (e: unknown): string => String(getOrElse(thrownMessage(e), e));
// A message that is not a string is tested as String() renders it; a value with no message matches nothing.
export const thrownMessageMatches = (e: unknown, re: RegExp): boolean => {
  const message = thrownMessage(e);
  if (message.tag === 'none') return false;
  return typeof message.value === 'string' ? re.test(message.value) : re.test(String(message.value));
};

// What a cachingFetch adds to a fetch (packcache.ts): the attributes the edit reports. A plain fetch has none.
export type EntryFetch = FetchLike & Input<{ readonly attrs: () => Attrs }>;
// operation.ts's options as the entries take them, total. The entries parse their options as the JS did, so `tracer`
// is a member a caller may leave out here though operation() needs it at run time (it starts the root span on it); each
// entry hands its options to operation() through one assertion. fetchImpl may be packcache's cachingFetch.
export type EntryConfig = Pick<OperationConfig, 'auth' | 'parent' | 'limits' | 'signal' | 'quirks' | 'transport'> & {
  readonly tracer: Tracer;
  readonly fetchImpl: EntryFetch;
};
// A public entry's option record (one of the two places Input is allowed): any of EntryConfig.
export type EntryOptions = Input<EntryConfig>;

// objects.ts TYPE_NAME, indexed by a type number read off the wire. Total over the numbers it names; an index read of
// any other number misses (noUncheckedIndexedAccess types that read), so a lookup still handles the miss.
export type TypeNames = Readonly<Record<number, string>>;
