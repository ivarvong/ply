// What every operation (edit, merge, rebase, pick) has in common, written once: a root span named `git.<op>` with the
// operation's attributes, a transport (built for the url, or the caller's — re-parented under the root for its spans),
// the outcome attribute on success or failure, and the one rule about confirmation: after a push is acknowledged, any
// failure to read the ref back as expected is `ambiguous`.
//
//   operation('merge', url, opts, async ({ t, root, outcome }) => { …; return outcome('merge', result, attrs); })
//
// The body returns via `outcome(name, result, attrs)`, which stamps `git.<op>.outcome` and ends the span. Thrown errors
// stamp the error's code as the outcome and are rethrown with `e.span = root` so a caller can link a retry to it.
import type { Extra } from './errors.js';
import type { Limits } from './limits.js';
import type { Span, Tracer } from './otel.js';
import type { Attrs, Loose, Quirks, Transport } from './transport.js';
import type { FetchLike, HttpAuth } from './http.js';
import { createTransport, redactUrl } from './http.js';
import { withParent } from './transport.js';
import { clockOf, commitUnix, resolveCapabilities } from './capabilities.js';
import type { Clock, FetchFn, Storage } from './capabilities.js';
import { lsRefs } from './lsrefs.js';
import { thrown as fail } from './errors.js';
import { DEFAULT_LIMITS } from './limits.js';

export type OperationOpts = {
  readonly auth?: HttpAuth | null | undefined;
  // Absent means the typed default (resolveCapabilities). `undefined` is not a member: a missing tracer is the no-op.
  readonly tracer?: Tracer;
  readonly fetch?: FetchFn;
  readonly clock?: Clock;
  readonly storage?: Storage;
  readonly parent?: Span | null | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly limits?: Limits | undefined;
  readonly signal?: AbortSignal | null | undefined;
  readonly quirks?: Quirks | undefined;
  readonly transport?: Transport | null | undefined;
  readonly attrs?: Attrs | undefined;
  readonly link?: { readonly span: Span; readonly kind: string } | null | undefined;
  readonly onFinish?: (() => Attrs) | null | undefined;
};
// Commit unix seconds for an operation that stamps a commit before its transport exists. An explicit time wins;
// otherwise the clock (the system clock when the caller omitted one, including a loose options bag's missing field).
export const operationTime = (clock: unknown, given: number | undefined): number => commitUnix(clockOf(clock), given);

export type Outcome = <R>(kind: string, result: R, extra?: Attrs) => R;
export type OperationBody<R> = (ctx: { readonly t: Transport; readonly root: Span; readonly outcome: Outcome; readonly limits: Limits }) => Promise<R>;

export async function operation<R>(op: string, url: string | URL, input: OperationOpts, body: OperationBody<R>): Promise<R> {
  const caps = resolveCapabilities(input);
  const { auth, parent = null, limits = DEFAULT_LIMITS, signal = null, quirks, transport = null, attrs = {}, link = null, onFinish = null } = input;
  const { tracer } = caps;
  const name = `git.${op}`;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- otel.js infers `parent` from its default (null) until its cluster converts
  const root = tracer.start(name, { parent: parent as null, attrs: { [`${name}.url`]: transport?.url ?? redactUrl(url), ...attrs } });
  if (link) root.link(link.span, { 'ply.link': link.kind });
  const finish = (extra: Attrs): Span => { if (onFinish) root.set(onFinish()); root.set(extra); return root; };
  const outcome: Outcome = (kind, result, extra = {}) => { finish({ ...extra, [`${name}.outcome`]: kind }).end(); return result; };
  try {
    // Inside the try: a transport that cannot be built (a bad URL, an unusable credential) ends the root with the
    // error recorded, like any other failure, instead of leaving it open and missing from the trace.
    const t = transport ? withParent(transport, root) : createTransport(url, { auth, tracer, parent: root, fetchImpl: caps.fetch, clock: caps.clock, storage: caps.storage, limits, signal, quirks });
    // The root and every span under it redact the credential; root.error(e) below scrubs the error the caller gets.
    if (t.scrub) root.scrub = t.scrub;
    return await body({ t, root, outcome, limits });
  } catch (e) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see Loose (transport.ts)
    finish({ [`${name}.outcome`]: (e as Loose)?.code ?? 'error' }).error(e, (e as Loose)?.code).end();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- any thrown object carries the root span, for a caller's retry link
    if (Boolean(e) && typeof e === 'object') (e as { span?: Span }).span = root;
    throw e;
  }
}

// After an acknowledged push: read `ref` back and require `expected`. A transport error here, or any other value, is
// 'ambiguous' — the push may have landed. Records `<prefix>.verify.ref` on `root`.
export async function verifyRef(t: Transport, root: Span, prefix: string, ref: string, expected: string): Promise<string> {
  let seen;
  try { seen = (await lsRefs(t, [ref])).refs.get(ref)?.oid; }
  catch (e) {
    // A thrown null or undefined has no `.message`. Reading it threw TypeError and the acknowledged push escaped
    // unclassified (I25: any failure to read the ref back is `ambiguous`). The same loose read as ambiguousAfterPush.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a thrown value of any type
    const loose = e as Loose;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/restrict-template-expressions -- message and cause are the thrown value; expected is Extra
    throw fail('ambiguous', `push reported ok but the verification read-back failed: ${loose?.message ?? e}`, { cause: e, original: loose?.code, expected } as Extra);
  }
  root.set({ [`${prefix}.verify.ref`]: seen ?? '' });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ad-hoc error fields (errors.ts Extra); A3 moves them into Detail
  if (seen !== expected) throw fail('ambiguous', `push reported ok but ${ref} is ${seen ?? 'absent'}, not ${expected}`, { seen: seen ?? null, expected } as Extra);
  return seen;
}
