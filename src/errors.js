// The error taxonomy, in one place. Every error ply throws has a `code` from this table; the table says what the
// caller may do about it. `fail` is the only constructor; `limitError` (limits.js) builds `limit_exceeded`.
// Descriptions live in errors-doc.js (documentation, kept out of the runtime bundle).
//
// retry: 'yes'   — safe to retry as-is (nothing was changed on the server, or the change is idempotent)
//        'fresh' — retry from a fresh read (a compare-and-swap lost; the parent must be re-resolved)
//        'no'    — retrying the same request cannot succeed
//        'read'  — do not retry blindly: the server MAY have applied the change; read the ref back first
export const RETRY = Object.freeze({
  bad_request: 'no',
  unsupported: 'no',
  network: 'yes',
  timeout: 'yes',
  aborted: 'no',
  http: 'no',
  auth: 'no',
  not_found: 'no',
  rate_limited: 'yes',
  upstream_5xx: 'yes',
  not_git: 'no',
  ssh: 'yes',
  host_key_mismatch: 'no',
  protocol: 'yes',
  pack_corrupt: 'yes',
  remote_error: 'no',
  limit_exceeded: 'no',
  match_count: 'no',
  lfs_pointer: 'no',
  cas_conflict: 'fresh',
  push_rejected: 'no',
  push_partial: 'no',
  merge_conflict: 'no',
  not_fast_forward: 'no',
  not_linear: 'no',
  unrelated_histories: 'no',
  ambiguous: 'read',
  internal: 'no',
});
export const CODES = Object.freeze(Object.keys(RETRY));

export const fail = (code, message, extra = {}) => {
  if (!(code in RETRY)) throw new Error(`internal: unknown error code ${code}`);
  return Object.assign(new Error(message), { code, ...extra });
};
export const isPlyCode = code => typeof code === 'string' && code in RETRY;
export const retryPolicy = e => RETRY[e?.code] ?? 'no';
export const isRetryable = e => retryPolicy(e) === 'yes';
// After a push body is on the wire, any failure to obtain a trustworthy report means the ref MAY have moved.
// That includes our own limits: a report too large to read says nothing about whether the ref moved.
export const ambiguousAfterPush = (e, message = 'push outcome unknown') => (e?.code === 'ambiguous' ? e : fail('ambiguous', `${message}: ${e?.message ?? e}`, { cause: e, original: e?.code }));

// Rewrite every string an error carries through `scrub`, in place: message, stack, own fields, nested plain objects,
// prototype-less maps (merge reasons, report options) and arrays (a push report, hook output) and the cause chain.
// Anything else (a Span on `e.span`, bytes) is left alone.
export function scrubError(e, scrub) {
  if (!scrub) return e;
  const seen = new Set();
  const walk = v => {
    if (typeof v === 'string') return scrub(v);
    if (v === null || typeof v !== 'object' || seen.has(v)) return v;
    const isErr = v instanceof Error;
    const proto = Object.getPrototypeOf(v);
    if (!isErr && !Array.isArray(v) && proto !== Object.prototype && proto !== null) return v; // null: a map keyed by names the server or repo chose
    seen.add(v);
    const keys = new Set(Object.keys(v));
    if (isErr) for (const k of ['message', 'stack', 'cause']) if (k in v) keys.add(k);
    for (const k of keys) { try { v[k] = walk(v[k]); } catch { /* read-only */ } }
    return v;
  };
  return walk(e);
}
// ci/fast probe 2: whole-file mutation of every src file (reverted in the next commit)
