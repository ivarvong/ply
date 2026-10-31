// The error taxonomy: a closed set of codes, each with the caller's retry policy. `satisfies` makes the table
// exhaustive both ways: a code without a policy, or a policy for an unknown code, does not compile.
// Descriptions live in errors-doc.ts (documentation, kept out of the runtime bundle).
//
// retry: 'yes'   — safe to retry as-is (nothing was changed on the server, or the change is idempotent)
//        'fresh' — retry from a fresh read (a compare-and-swap lost; the parent must be re-resolved)
//        'no'    — retrying the same request cannot succeed
//        'read'  — do not retry blindly: the server MAY have applied the change; read the ref back first
import type { Err, Result } from './result.ts';
import { err } from './result.ts';

export type Retry = 'yes' | 'fresh' | 'no' | 'read';

// The closed set of codes. A type costs nothing at run time; the names ship once, as RETRY's keys. The annotation
// makes the table exhaustive both ways: a code without a policy, or a policy for an unknown code, does not compile.
export type Code =
  | 'bad_request' | 'unsupported' | 'network' | 'timeout' | 'aborted' | 'http' | 'auth' | 'not_found' | 'rate_limited'
  | 'upstream_5xx' | 'not_git' | 'ssh' | 'host_key_mismatch' | 'protocol' | 'pack_corrupt' | 'remote_error'
  | 'limit_exceeded' | 'match_count' | 'lfs_pointer' | 'cas_conflict' | 'push_rejected' | 'push_partial'
  | 'merge_conflict' | 'not_fast_forward' | 'not_linear' | 'unrelated_histories' | 'ambiguous' | 'internal';

export const RETRY: Readonly<Record<Code, Retry>> = Object.freeze({
  bad_request: 'no', unsupported: 'no', network: 'yes', timeout: 'yes', aborted: 'no', http: 'no', auth: 'no',
  not_found: 'no', rate_limited: 'yes', upstream_5xx: 'yes', not_git: 'no', ssh: 'yes', host_key_mismatch: 'no',
  protocol: 'yes', pack_corrupt: 'yes', remote_error: 'no', limit_exceeded: 'no', match_count: 'no',
  lfs_pointer: 'no', cas_conflict: 'fresh', push_rejected: 'no', push_partial: 'no', merge_conflict: 'no',
  not_fast_forward: 'no', not_linear: 'no', unrelated_histories: 'no', ambiguous: 'read', internal: 'no',
});
// Object.keys widens to string[]; the keys of a literal object are exactly Code.
export const CODES: readonly Code[] = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.keys(RETRY) as Code[]);

// Per-code payload: the fields a code always carries. A code not listed carries only code + message (+ Extra).
// Adding detail to a code is one line here, and every constructor and match site is re-checked. These are the
// fields today's call sites attach unconditionally (grep `fail('<code>'`); a converting module tightens its codes.
export type Detail = {
  readonly http: { readonly status: number };
  readonly limit_exceeded: { readonly what: string; readonly got: number; readonly max: number };
  readonly cas_conflict: { readonly expected: string | null; readonly actual: string | null };
  readonly match_count: { readonly matches: number };
  readonly merge_conflict: { readonly conflicts: readonly string[] };
};
type DetailOf<C extends Code> = C extends keyof Detail ? Detail[C] : Record<never, never>;

// Optional context any error may carry: what was checked, the offending path, the underlying cause (a platform
// error, or another PlyError for `ambiguous`), and the code an `ambiguous` replaced. Unconverted modules attach
// more ad-hoc fields to thrown errors; they are not part of the typed surface until their module converts.
export type Extra = {
  readonly what?: string;
  readonly path?: string;
  readonly got?: unknown;
  readonly max?: number;
  readonly cause?: unknown;
  readonly original?: Code | undefined;
};

// A PlyError is a value: returned in an Err, matched on `code`, never thrown by converted code. At run time it is an
// Error instance carrying its fields (a stack for whoever logs it, and the exact shape today's thrown errors have, so
// the migration boundary below is the identity). Its type is the discriminated union; nothing reads it as a class.
export type PlyError = {
  readonly [C in Code]: Error & { readonly code: C; readonly message: string } & Extra & DetailOf<C>;
}[Code];
export type ErrorOf<C extends Code> = Extract<PlyError, { readonly code: C }>;

// Payload fields required by the code are required here; a code without a payload takes only Extra.
type Payload<C extends Code> = Record<never, never> extends DetailOf<C> ? [extra?: Extra] : [detail: DetailOf<C> & Extra];

// The one constructor, typed (plyError) and untyped (thrown, below). The code check guards untyped callers.
const make = (code: string, message: string, extra?: object): Thrown => {
  if (!isPlyCode(code)) throw new Error(`internal: unknown error code ${code}`);
  // The one cast at the boundary: Object.assign returns Error & the extra fields, and `code` was checked above.
  return Object.assign(new Error(message), { code, ...extra }) as Thrown;
};
// The error value for `code`; `fail` wraps it in an Err for a function returning Result.
// Same function as `make`: the rest parameter is at most one object, so the arities agree.
export const plyError: <C extends Code>(code: C, message: string, ...detail: Payload<C>) => ErrorOf<C> =
  make as unknown as <C extends Code>(code: C, message: string, ...detail: Payload<C>) => ErrorOf<C>;
export const fail = <C extends Code>(code: C, message: string, ...detail: Payload<C>): Err<ErrorOf<C>> =>
  err(plyError(code, message, ...detail));

export const isPlyCode = (code: unknown): code is Code => typeof code === 'string' && Object.hasOwn(RETRY, code);
// Accepts a thrown value too (the public API throws until the Result cut-over; see docs/STACK.md).
type Loose = { readonly code?: unknown; readonly message?: unknown } | null | undefined;
export const retryPolicy = (e: unknown): Retry => {
  const code = (e as Loose)?.code;
  return isPlyCode(code) ? RETRY[code] : 'no';
};
export const isRetryable = (e: unknown): boolean => retryPolicy(e) === 'yes';

// ---- Migration boundary -------------------------------------------------------------------------------------
// Unconverted modules (the ratchet in scripts/ts-ratchet.json) throw. These turn a value into the thrown shape
// they and the public API use today: an Error whose own fields are the PlyError's. Delete with the last .js file.

export type Thrown = Error & { readonly code: Code; readonly [field: string]: unknown };
// The legacy constructor (`throw thrown(code, message, extra)`); unconverted modules import it as `fail`.
export const thrown: (code: string, message: string, extra?: Readonly<Record<string, unknown>>) => Thrown = make;
// A converted function's Result, at a call site that still throws. The error is already an Error: throw it as is.
export const orThrow = <T>(r: Result<T, PlyError>): T => {
  if (r.ok) return r.value;
  throw r.error;
};

// After a push body is on the wire, any failure to obtain a trustworthy report means the ref MAY have moved.
// That includes our own limits: a report too large to read says nothing about whether the ref moved.
export const ambiguousAfterPush = (e: unknown, message = 'push outcome unknown'): Thrown => {
  const code = (e as Loose)?.code;
  return code === 'ambiguous' ? (e as Thrown) : thrown('ambiguous', `${message}: ${String((e as Loose)?.message ?? e)}`, { cause: e, original: code });
};

// Rewrite every string an error carries through `scrub`, in place: message, stack, own fields, nested plain objects,
// prototype-less maps (merge reasons, report options) and arrays (a push report, hook output) and the cause chain.
// Anything else (a Span on `e.span`, bytes) is left alone. Mutation is the contract: the caller rethrows `e`.
export function scrubError<E>(e: E, scrub?: ((s: string) => string) | null): E {
  if (!scrub) return e;
  const seen = new Set<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return scrub(v);
    if (v === null || typeof v !== 'object' || seen.has(v)) return v;
    const isErr = v instanceof Error;
    const proto: unknown = Object.getPrototypeOf(v);
    if (!isErr && !Array.isArray(v) && proto !== Object.prototype && proto !== null) return v; // null: a map keyed by names the server or repo chose
    seen.add(v);
    const keys = new Set(Object.keys(v));
    if (isErr) for (const k of ['message', 'stack', 'cause']) if (k in v) keys.add(k);
    for (const k of keys) {
      try { (v as Record<string, unknown>)[k] = walk((v as Record<string, unknown>)[k]); } catch { /* read-only */ }
    }
    return v;
  };
  return walk(e) as E;
}
