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
import type { Attrs, Quirks, Transport, TransportInput } from './transport.js';
import type { FetchLike, HttpAuth } from './http.js';
import { createTransport, redactUrl } from './http.js';
import { asTransport, withParent } from './transport.js';
import { lsRefs } from './lsrefs.js';
import { thrown as fail } from './errors.js';
import { DEFAULT_LIMITS } from './limits.js';
import type { Input } from './absent.js';
import { mapGet, withDefaults } from './absent.js';
import { getOrElse, mapOption } from './result.js';
import { thrownCode, thrownMessage } from './boundary.js';

// Everything an operation takes besides the url and the body, total. `null` is "none": no credential, no parent span,
// no abort signal, no caller transport (build one for the url), no retry link, no finishing attributes.
export type OperationConfig = {
  readonly auth: HttpAuth | null;
  readonly parent: Span | null;
  readonly fetchImpl: FetchLike | null;
  readonly limits: Limits;
  readonly signal: AbortSignal | null;
  readonly quirks: Input<Quirks> | null;
  readonly transport: TransportInput | null;
  readonly attrs: Attrs;
  readonly link: { readonly span: Span; readonly kind: string } | null;
  readonly onFinish: (() => Attrs) | null;
};
// What callers pass: any of the config, and the tracer the root span starts on.
export type OperationOpts = Input<OperationConfig> & { readonly tracer: Tracer };
const operationDefaults = (): { -readonly [K in keyof OperationConfig]: OperationConfig[K] } => ({
  auth: null, parent: null, fetchImpl: null, limits: DEFAULT_LIMITS, signal: null, quirks: null, transport: null, attrs: {}, link: null, onFinish: null,
});
// outcome(kind, result) or outcome(kind, result, attrs): the attributes stamped on the root beside the outcome.
export type Outcome = <R>(kind: string, result: R, ...extra: [] | [Attrs]) => R;
export type OperationBody<R> = (ctx: { readonly t: Transport; readonly root: Span; readonly outcome: Outcome; readonly limits: Limits }) => Promise<R>;

export async function operation<R>(op: string, url: string | URL, opts: OperationOpts, body: OperationBody<R>): Promise<R> {
  const { tracer } = opts;
  const { auth, parent, fetchImpl, limits, signal, quirks, transport, attrs, link, onFinish } = withDefaults(opts, operationDefaults());
  const name = `git.${op}`;
  const root = tracer.start(name, { parent, attrs: { [`${name}.url`]: transport === null ? redactUrl(url) : transport.url, ...attrs } });
  if (link !== null) root.link(link.span, { 'ply.link': link.kind });
  const finish = (extra: Attrs): Span => { if (onFinish !== null) root.set(onFinish()); root.set(extra); return root; };
  const outcome: Outcome = (kind, result, ...extra) => { const [given = {}] = extra; finish({ ...given, [`${name}.outcome`]: kind }).end(); return result; };
  try {
    // Inside the try: a transport that cannot be built (a bad URL, an unusable credential) ends the root with the
    // error recorded, like any other failure, instead of leaving it open and missing from the trace.
    const t = transport === null ? createTransport(url, { auth, tracer, parent: root, fetchImpl: fetchImpl === null ? globalThis.fetch : fetchImpl, limits, signal, ...(quirks === null ? {} : { quirks }) }) : withParent(asTransport(transport), root);
    // The root and every span under it redact the credential; root.error(e) below scrubs the error the caller gets.
    if (t.scrub !== null) root.scrub = t.scrub;
    return await body({ t, root, outcome, limits });
  } catch (e) {
    const code = thrownCode(e);
    finish({ [`${name}.outcome`]: getOrElse<unknown>(code, 'error') }).error(e, getOrElse<unknown>(code, null)).end();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- any thrown object carries the root span, for a caller's retry link
    if (Boolean(e) && typeof e === 'object') (e as { span?: Span }).span = root;
    throw e;
  }
}

// The code an `ambiguous` replaced, when the thrown value had one (no key at all when it had none).
const originalCode = (e: unknown): Pick<Extra, 'original'> => { const c = thrownCode(e); return c.tag === 'some' ? { original: c.value } : {}; };

// After an acknowledged push: read `ref` back and require `expected`. A transport error here, or any other value, is
// 'ambiguous' — the push may have landed. Records `<prefix>.verify.ref` on `root`.
export async function verifyRef(t: Transport, root: Span, prefix: string, ref: string, expected: string): Promise<string> {
  let seen: string | null;
  try { seen = getOrElse<string | null>(mapOption(mapGet((await lsRefs(t, [ref])).refs, ref), r => r.oid), null); }
  catch (e) {
    // A thrown null has no `.message`: any failure to read the ref back is `ambiguous` (I25), whatever was thrown.
    const message = getOrElse<unknown>(thrownMessage(e), e);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/restrict-template-expressions -- the thrown value renders as String() renders it; expected is Extra
    throw fail('ambiguous', `push reported ok but the verification read-back failed: ${message}`, { cause: e, ...originalCode(e), expected } as Extra);
  }
  root.set({ [`${prefix}.verify.ref`]: seen === null ? '' : seen });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ad-hoc error fields (errors.ts Extra); A3 moves them into Detail
  if (seen !== expected) throw fail('ambiguous', `push reported ok but ${ref} is ${seen === null ? 'absent' : seen}, not ${expected}`, { seen, expected } as Extra);
  return seen;
}
