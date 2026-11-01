// What the entry modules (edit, read, log, checkout, tree) read that no converted module declares. The types go in the
// A pass (A7), when the entries stop catching thrown values. The readers below are the runtime: one narrowing per
// field, so a catch does not cast.
import type { Attrs, Tracer } from './otel.js';
import type { OperationOpts } from './operation.js';
import type { FetchLike } from './http.js';
import type { Option } from './result.js';
import { getOrElse, none, some } from './result.js';
import { isPlyCode } from './errors.js';
import { field } from './absent.js';

// A thrown value, read loosely as the JS did (`e?.code`): any field may be missing, and a primitive has none. Errors
// become values in the A pass; until then a `catch` reads them through the functions below, which are that read.
export type Caught = { readonly code?: unknown; readonly message: string; readonly attrs?: Attrs } | null | undefined;

// A field of a thrown value: None when the value is not an object, lacks the field, or holds null or the platform
// missing value there (what `e?.field ?? …` collapsed). A primitive has none of these fields.
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

// operation.ts's options as the entries take them. The entries default their options to {} as the JS did, so `tracer`
// stays optional here though operation() needs it at run time (it starts the root span on it); each entry hands its
// options to operation() through one assertion. fetchImpl may be packcache's cachingFetch, whose attrs() the edit
// reports.
export type EntryOptions = Omit<OperationOpts, 'tracer' | 'fetchImpl' | 'attrs' | 'onFinish' | 'link'> & {
  readonly tracer?: Tracer | undefined;
  readonly fetchImpl?: (FetchLike & { readonly attrs?: () => Attrs }) | undefined;
};

// objects.ts TYPE_NAME, indexed by a type number read off the wire (any number: a lookup may miss).
export type TypeNames = Readonly<Record<number, string | undefined>>;
