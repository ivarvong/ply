// The error taxonomy: a closed set of codes, each with the caller's retry policy. `satisfies` makes the table
// exhaustive both ways: a code without a policy, or a policy for an unknown code, does not compile.
// Descriptions live in errors-doc.ts (documentation, kept out of the runtime bundle).
//
// retry: 'yes'   — safe to retry as-is (nothing was changed on the server, or the change is idempotent)
//        'fresh' — retry from a fresh read (a compare-and-swap lost; the parent must be re-resolved)
//        'no'    — retrying the same request cannot succeed
//        'read'  — do not retry blindly: the server MAY have applied the change; read the ref back first
import type { ObjectTypeName } from './format.js';
import type { Err } from './result.js';
import { err, getOrElse } from './result.js';
import type { Input } from './absent.js';
import { field } from './absent.js';

export type Retry = 'yes' | 'fresh' | 'no' | 'read';

// The closed set of codes. A type costs nothing at run time; the names ship once, as RETRY's keys. The annotation
// makes the table exhaustive both ways: a code without a policy, or a policy for an unknown code, does not compile.
export type Code =
  | 'bad_request' | 'unsupported' | 'network' | 'timeout' | 'aborted' | 'http' | 'auth' | 'not_found' | 'rate_limited'
  | 'upstream_5xx' | 'not_git' | 'protocol' | 'pack_corrupt' | 'remote_error'
  | 'limit_exceeded' | 'match_count' | 'lfs_pointer' | 'cas_conflict' | 'push_rejected' | 'push_partial'
  | 'merge_conflict' | 'not_fast_forward' | 'not_linear' | 'unrelated_histories' | 'ambiguous' | 'internal';

export const RETRY: Readonly<Record<Code, Retry>> = Object.freeze({
  bad_request: 'no', unsupported: 'no', network: 'yes', timeout: 'yes', aborted: 'no', http: 'no', auth: 'no',
  not_found: 'no', rate_limited: 'yes', upstream_5xx: 'yes', not_git: 'no', protocol: 'yes',
  pack_corrupt: 'no', remote_error: 'no', limit_exceeded: 'no', match_count: 'no',
  lfs_pointer: 'no', cas_conflict: 'fresh', push_rejected: 'no', push_partial: 'no', merge_conflict: 'no',
  not_fast_forward: 'no', not_linear: 'no', unrelated_histories: 'no', ambiguous: 'read', internal: 'no',
});
// Object.keys widens to string[]; the keys of RETRY are exactly Code (its annotation says so).
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
export const CODES: readonly Code[] = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.keys(RETRY) as Code[]);

// Per-code payload: the fields a code always carries. A code not listed carries only code + message (+ Extra).
// Adding detail to a code is one line here, and every constructor and match site is re-checked. These are the
// fields today's call sites attach unconditionally (grep `fail('<code>'`); a converting module tightens its codes.
// Why a commit id is not a commit the remote will serve (#112, nested under Miss). `absent`: upload-pack said the oid
// is not its ref. `not_commit`: the object arrived and it is a tree, blob, or tag.
export type CommitMiss =
  | { readonly kind: 'absent'; readonly oid: string }
  | { readonly kind: 'not_commit'; readonly oid: string; readonly type: Exclude<ObjectTypeName, 'commit'> };

// Why a not_found missed (#115). Callers switch on `kind`. A corrupt pack stays pack_corrupt and carries none of these.
export type Miss =
  | { readonly kind: 'ref'; readonly ref: string; readonly candidates: readonly string[] }
  | { readonly kind: 'head_unborn'; readonly target: string }
  | { readonly kind: 'head_absent' }
  | { readonly kind: 'path'; readonly missing: string; readonly existingPath: string }
  | { readonly kind: 'not_directory'; readonly path: string; readonly mode: string }
  | { readonly kind: 'is_directory'; readonly path: string; readonly tree: string }
  | { readonly kind: 'submodule'; readonly path: string; readonly commit: string }
  | { readonly kind: 'commit'; readonly miss: CommitMiss }
  | { readonly kind: 'repository' };

export type Detail = {
  readonly http: { readonly status: number };
  // read/resolve, and a 404: which thing was absent. Required, so a not_found cannot be told apart by its message.
  readonly not_found: { readonly miss: Miss };
  readonly limit_exceeded: { readonly what: string; readonly got: number; readonly max: number };
  readonly cas_conflict: { readonly expected: string | null; readonly actual: string | null };
  readonly match_count: { readonly matches: number };
  readonly merge_conflict: { readonly conflicts: readonly string[] };
  // push.ts: the refs that moved, and the refused ones with git's reason
  readonly push_partial: { readonly landed: readonly string[]; readonly rejected: ReadonlyArray<{ readonly ref: string; readonly reason: string }> };
};
// `unknown` is the identity of `&`: a code without a payload adds nothing to its member.
type DetailOf<C extends Code> = C extends keyof Detail ? Detail[C] : unknown;

// Context any error may carry: what was checked, the offending path, the underlying cause (a platform error, or
// another PlyError for `ambiguous`), and the code an `ambiguous` replaced. The fields are total here; Extra, the bag a
// constructor takes, is Input<ExtraFields> (a caller attaches the ones it has). Unconverted modules attach more ad-hoc
// fields to thrown errors; they are not part of the typed surface until their module converts.
export type ExtraFields = {
  readonly what: string;
  readonly path: string;
  readonly got: unknown;
  readonly max: number;
  readonly cause: unknown;
  readonly original: unknown;
  // objects.ts: git fsck's message id on a refused commit, tag or duplicate header; the name a tree carries twice
  readonly msgId: string;
  readonly entry: string;
  // edit.ts: the span attributes of a failed tree lookup (lookupEntry)
  readonly attrs: Readonly<Record<string, unknown>>;
  // push.ts: the receive-pack report as classified (null when it was not git's) and band 2 (hook stderr) as received
  readonly report: { readonly tag: string; readonly refs: ReadonlyArray<{ readonly ref: string; readonly ok: boolean; readonly reason: string }> } | null;
  readonly hookOutput: string;
  // receivecaps.ts: the capabilities the server advertised, beside an `unsupported` push
  readonly caps: readonly string[];
  // A machine-readable sub-reason a caller switches on instead of matching the message (#76). Closed: a new reason is
  // a member here. 'short_read': a bounded read ran past the buffer (bytes.ts take), so more bytes may complete it.
  // 'not_our_ref': upload-pack's ERR or band 3 said the wanted oid is not its ref (v2Step). Any other remote_error has none.
  // 'empty_response': a fetch response with no section in it, not even its flush (v2End): what git's upload-pack sends
  // when it dies on an argument it did not advertise (fetch.ts filterAdvertised).
  readonly reason: Reason;
  // pack_corrupt only (#300-5): 'remote' when the corrupt bytes came from the server over a fetch (operation() sets it
  // once an upload-pack request was handed to the transport), so a retry may get good bytes. Absent: the bytes were the
  // caller's own (bytes, a RangeSource, a saved spool, a pure codec), and retrying them cannot succeed.
  readonly origin: 'remote';
};
// The error context bag: one of the two places Input is allowed (docs/STACK.md, Absence). Any subset of the fields.
export type Extra = Input<ExtraFields>;
export type Reason = 'short_read' | 'not_our_ref' | 'empty_response';

// A PlyError is a value: returned in an Err, matched on `code`, never thrown by converted code. At run time it is an
// Error instance carrying its fields (a stack for whoever logs it, and the exact shape today's thrown errors have, so
// the migration boundary below is the identity). Its type is the discriminated union; nothing reads it as a class.
export type PlyError = {
  readonly [C in Code]: Error & { readonly code: C; readonly message: string } & Extra & DetailOf<C>;
}[Code];
export type ErrorOf<C extends Code> = Extract<PlyError, { readonly code: C }>;

// Payload fields required by the code are required here; a code without a payload takes Extra or nothing.
type Payload<C extends Code> = unknown extends DetailOf<C> ? [] | [extra: Extra] : [detail: DetailOf<C> & Extra];

// `in`, as before: RETRY's keys are the codes (inherited names such as 'toString' also pass, as they always have).
export const isPlyCode = (code: unknown): code is Code => typeof code === 'string' && code in RETRY;
// A PlyError is the Error plyError builds. A thrown number, a string, or an Error with no code is not one.
export const isPlyError = (e: unknown): e is PlyError => e instanceof Error && 'code' in e && isPlyCode(e.code);
// Accepts a thrown value too (the public API throws until the Result cut-over; see docs/STACK.md). Any value is read
// loosely, through absent.ts `field`: a primitive, null, or an object without a code has none, and that is 'no'.
export const retryPolicy = (e: unknown): Retry => {
  const code = field(e, 'code');
  if (code.tag !== 'some' || !isPlyCode(code.value)) return 'no';
  if (code.value === 'pack_corrupt') return getOrElse(field(e, 'origin'), null) === 'remote' ? 'yes' : 'no';
  return RETRY[code.value];
};
export const isRetryable = (e: unknown): boolean => retryPolicy(e) === 'yes';

// The one constructor. The typed signature is the error value for `code` with exactly its payload; `fail` wraps it in
// an Err. A JS caller reaches the untyped signature; the code check is for that caller (an unknown code is a bug).
// An overload, not a cast: the implementation returns Error & { code }, which each member of the union refines.
export function plyError<C extends Code>(code: C, message: string, ...detail: Payload<C>): ErrorOf<C>;
export function plyError(code: string, message: string, ...extra: [] | [object]): Thrown {
  if (!isPlyCode(code)) throw new Error(`internal: unknown error code ${code}`);
  // No bag spreads nothing; a JS caller's missing bag spreads nothing too, as it did.
  return Object.assign(new Error(message), { code, ...extra[0] });
}
export const fail = <C extends Code>(code: C, message: string, ...detail: Payload<C>): Err<ErrorOf<C>> =>
  err(plyError(code, message, ...detail));

// plyError's untyped signature: an Error carrying one of ply's codes.
export type Thrown = Error & { readonly code: Code };

// After a push body is on the wire, any failure to obtain a trustworthy report means the ref MAY have moved.
// That includes our own limits: a report too large to read says nothing about whether the ref moved.
export const ambiguousAfterPush = (e: unknown, message = 'push outcome unknown'): unknown => {
  const code = field(e, 'code');
  if (code.tag === 'some' && code.value === 'ambiguous') return e;
  // A thrown value of any type renders as String() renders it. `original` is the code it replaced; none, no key.
  return plyError('ambiguous', `${message}: ${String(getOrElse(field(e, 'message'), e))}`, { cause: e, ...(code.tag === 'some' ? { original: code.value } : {}) });
};

// What a thrown value says, for a message: its `message` when it has one, else the value as String() renders it.
// Never throws. Reading a caller's value can itself throw (a `message` getter that throws, a revoked Proxy, an object
// with no string form such as a null-prototype one): the description then says only that; the value is the `cause`.
export function describeThrown(e: unknown): string {
  try { return String(getOrElse(field(e, 'message'), e)); } catch { return 'a value with no string form'; }
}

// A caller-supplied callback that is part of an operation (a signer, a pushDir filter, a transport) threw or rejected
// before any push request was handed to a transport: a definite failure. The Err names the callback (`what`) and
// carries what it threw (`cause`). bad_request (retry 'no'): the failure is in the caller's code; the caller reads `cause`.
export const callbackFailed = (what: string, e: unknown): ErrorOf<'bad_request'> =>
  plyError('bad_request', `caller-supplied ${what} threw: ${describeThrown(e)}`, { what, cause: e });

// Rewrite every string an error carries through `scrub`, in place: message, stack, own fields, nested plain objects,
// prototype-less maps (merge reasons, report options) and arrays (a push report, hook output) and the cause chain.
// Anything else (a Span on `e.span`, bytes) is left alone. A prototype of null marks a map keyed by names the server
// or repo chose. Mutation is the contract: the caller rethrows what this returns (`e` itself unless e is a string).
// No scrubber (null, the default) leaves `e` as it is.
export function scrubError(e: unknown, scrub: ((s: string) => string) | null = null): unknown {
  if (!scrub) return e;
  const seen = new Set<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return scrub(v);
    if (v === null || typeof v !== 'object' || seen.has(v)) return v;
    const isErr = v instanceof Error;
    const proto: unknown = Object.getPrototypeOf(v);
    if (!isErr && !Array.isArray(v) && proto !== Object.prototype && proto !== null) return v;
    seen.add(v);
    const keys = new Set(Object.keys(v));
    if (isErr) for (const k of ['message', 'stack', 'cause']) if (k in v) keys.add(k);
    // A plain object or an Error, so its fields are a record. A read-only field stays as it is.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    const rec = v as Record<string, unknown>;
    for (const k of keys) {
      try { rec[k] = walk(rec[k]); } catch { /* read-only */ }
    }
    return v;
  };
  return walk(e);
}

// Remote-written text on its way into an error message or a span attribute. The sites that pass it through one of
// these two are listed in SAFETY.md I43 and counted by test/remote-text.test.js: ERR lines, band 3, the HTTP error body
// and content-type, refused protocol lines, v2End's section names, the too-large push reason and the
// git.push.band2.tail attribute. Not every field does: I43 also lists the ones that still carry remote text as received
// (hookOutput, git.push.remote.messages, git.push.ng.reason, fetch progress, the lines / rejected detail fields, an ng
// reason quoted in a push message). A server chooses these bytes, and whoever prints the error to a terminal or a log
// must not be driven by them. The text is cut to `max` UTF-16 units (after the scrub, where a site passes one), so the
// result is bounded whatever the line's size; then every control (Cc: C0, DEL, C1), format
// character (Cf: bidi overrides, zero-width and tag characters), line or paragraph separator and lone surrogate (a cut
// pair, or ill-formed input) is written as \uXXXX (\u{XXXXX} above the BMP). Invalid UTF-8 has already decoded to U+FFFD, which
// is printable and kept.
//   remoteText   — running text (an ERR message, hook output, an error page): tab and newline stay, as in git's own
//                  reports (usage.c vreportf masks every other control).
//   remoteQuoted — one line shown in quotes: JSON's quoting (so `"`, `\`, tab and newline are escaped too), then the
//                  characters JSON leaves raw (DEL, C1, format characters, U+2028/9).
export const REMOTE_TEXT_MAX = 1024;
const HEX = 16;
const UNIT_DIGITS = 4;
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;
// one match is one code point: a BMP character is \uXXXX (as JSON writes it), an astral one \u{XXXXX}
const escaped = (c: string): string => { const hex = Number(c.codePointAt(0)).toString(HEX); return c.length === 1 ? `\\u${hex.padStart(UNIT_DIGITS, '0')}` : `\\u{${hex}}`; };
// `scrub` (a transport's credential scrubber, or null) runs BEFORE the cut, on the whole text: a cut that falls inside
// an echoed credential would leave a remainder too short for the scrubber to recognise afterwards. Where it is passed
// the text is one pkt-line payload (at most 65516 bytes), so the scrub is bounded too.
export const remoteText = (text: string, max: number = REMOTE_TEXT_MAX, scrub: ((s: string) => string) | null = null): string =>
  (typeof scrub === 'function' ? scrub(text) : text).slice(0, max).replaceAll(UNPRINTABLE, c => (c === '\n' || c === '\t' ? c : escaped(c)));
export const remoteQuoted = (text: string, max: number = REMOTE_TEXT_MAX): string => JSON.stringify(text.slice(0, max)).replaceAll(UNPRINTABLE, escaped);
