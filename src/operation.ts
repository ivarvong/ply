// What every operation (edit, merge, rebase, pick) has in common, written once: a root span named `git.<op>` with the
// operation's attributes, a transport (built for the url, or the caller's — re-parented under the root for its spans),
// the outcome attribute on success or failure, and the one rule about confirmation: after a push is acknowledged, any
// failure to read the ref back as expected is `ambiguous`.
//
//   operation('merge', url, opts, async ({ t, root, outcome }) => { …; return outcome('merge', result, attrs); })
//
// The body returns a Result. Ok comes from `outcome(name, result, attrs)`, which stamps `git.<op>.outcome`, ends the
// span and returns ok(result). An Err stamps the error's code as the outcome, is recorded on the root, carries the root
// as `span` (a caller links a retry to it) and is returned. operation() itself returns the Result; it never throws.
import type { ErrorOf, Extra, PlyError } from './errors.js';
import type { CheckedLimits, LimitsInput } from './limits.js';
import type { Span } from './otel.js';
import { Tracer } from './otel.js';
import type { Attrs, Quirks, Transport, TransportInput } from './transport.js';
import type { FetchLike, HttpAuth } from './http.js';
import { createTransport, redactUrl } from './http.js';
import { transportFrom, withParent } from './transport.js';
import { lsRefs } from './lsrefs.js';
import type { LsRefsResult } from './lsrefs.js';
import { fail, isPlyError } from './errors.js';
import { DEFAULT_LIMITS, parseLimits } from './limits.js';
import type { Input } from './absent.js';
import { field, mapGet, withDefaults } from './absent.js';
import type { Ok, Option, Result } from './result.js';
import { err, flatMapOption, getOrElse, map, mapOption, ok } from './result.js';
import { thrownCode, thrownMessage } from './boundary.js';

// Everything an operation takes besides the url and the body, total. `null` is "none": no credential, no parent span,
// no abort signal, no caller transport (build one for the url), no retry link, no finishing attributes.
export type OperationConfig = {
  readonly auth: HttpAuth | null;
  readonly parent: Span | null;
  readonly fetchImpl: FetchLike | null;
  // any subset (a key left out is the default), parsed once before the transport is made
  readonly limits: LimitsInput;
  readonly signal: AbortSignal | null;
  readonly quirks: Input<Quirks> | null;
  readonly transport: TransportInput | null;
  readonly attrs: Attrs;
  readonly link: { readonly span: Span; readonly kind: string } | null;
  readonly onFinish: (() => Attrs) | null;
};
// What callers pass: any of the config, and the tracer the root span starts on.
export type OperationOpts = Input<OperationConfig & { readonly tracer: Tracer }>;
const operationDefaults = (): { -readonly [K in keyof OperationConfig]: OperationConfig[K] } => ({
  auth: null, parent: null, fetchImpl: null, limits: DEFAULT_LIMITS, signal: null, quirks: null, transport: null, attrs: {}, link: null, onFinish: null,
});
// outcome(kind, result) or outcome(kind, result, attrs): the attributes stamped on the root beside the outcome; ok(result).
export type Outcome = <R>(kind: string, result: R, ...extra: [] | [Attrs]) => Ok<R>;
export type OperationBody<R> = (ctx: { readonly t: Transport; readonly root: Span; readonly outcome: Outcome; readonly limits: CheckedLimits }) => Promise<Result<R, PlyError>>;

export async function operation<R>(op: string, url: string | URL, opts: OperationOpts, body: OperationBody<R>): Promise<Result<R, PlyError>> {
  // `tracer` is optional (boundary.ts EntryOptions): a caller who passes none gets a Tracer with no exporter, whose spans
  // are dropped. Anything given that is not a tracer (no start()) is that caller's bug, named in a bad_request.
  const passed = field(opts, 'tracer');
  const start = flatMapOption(passed, t => field(t, 'start'));
  if (passed.tag === 'some' && typeof getOrElse(start, null) !== 'function') return fail('bad_request', `git.${op}: opts.tracer must be a Tracer (new Tracer() from ply)`, { what: 'tracer' });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked just above: it has start()
  const tracer: Tracer = passed.tag === 'some' ? (passed.value as Tracer) : new Tracer();
  const { auth, parent, fetchImpl, limits, signal, quirks, transport, attrs, link, onFinish } = withDefaults(opts, operationDefaults());
  const name = `git.${op}`;
  const root = tracer.start(name, { parent, attrs: { [`${name}.url`]: transport === null ? redactUrl(url) : transport.url, ...attrs } });
  if (link !== null) root.link(link.span, { 'ply.link': link.kind });
  // onFinish only adds attributes: what it throws is telemetry's failure (tracer.onTelemetryError), never the operation's
  const finish = (extra: Attrs): Span => { if (onFinish !== null) tracer.guard('onFinish', name, () => { root.set(onFinish()); }); root.set(extra); return root; };
  const outcome: Outcome = (kind, result, ...extra) => { const [given = {}] = extra; finish({ ...given, [`${name}.outcome`]: kind }).end(); return ok(result); };
  // An Err leaves through here: the outcome and error.type are its code (read before root.error scrubs it), the error is
  // recorded on the root, and it carries the root span for a caller's retry link.
  const failed = (e: PlyError): Result<R, PlyError> => {
    finish({ [`${name}.outcome`]: e.code }).error(e, e.code).end();
    Object.assign(e, { span: root });
    return err(e);
  };
  let r: Result<R, PlyError>;
  try {
    // Inside the try: a transport that cannot be built (a bad URL, an unusable credential) ends the root with the
    // error recorded, like any other failure, instead of leaving it open and missing from the trace.
    // The limits, parsed once (#156): a bad one is refused here, before the transport exists or any request is sent.
    const checked = parseLimits(limits);
    if (!checked.ok) return failed(checked.error);
    const made: Result<Transport, PlyError> = transport === null ? createTransport(url, { auth, tracer, parent: root, fetchImpl: fetchImpl === null ? globalThis.fetch : fetchImpl, limits: checked.value, signal, ...(quirks === null ? {} : { quirks }) }) : map(transportFrom(transport), given => withParent(given, root));
    if (!made.ok) return failed(made.error);
    const t = made.value;
    // The root and every span under it redact the credential; root.error(e) below scrubs the error the caller gets.
    if (t.scrub !== null) root.scrub = t.scrub;
    r = await body({ t, root, outcome, limits: checked.value });
  } catch (e) {
    // Every ply failure is the body's Err. What still arrives as a throw is not ply's: the caller's own callback (a
    // signer, a fetchImpl, a transport) raised it. A PlyError raised that way is still that body's Err; anything else
    // is recorded on the root and rethrown unchanged, so the caller gets back exactly what its own code threw.
    if (isPlyError(e)) return failed(e);
    const code = thrownCode(e);
    const type: [] | [unknown] = code.tag === 'some' ? [code.value] : [];
    finish({ [`${name}.outcome`]: getOrElse<unknown>(code, 'error') }).error(e, ...type).end();
    if (typeof e === 'object' && e !== null) Object.assign(e, { span: root });
    throw e;
  }
  return r.ok ? r : failed(r.error);
}

// The code an `ambiguous` replaced, when the thrown value had one (no key at all when it had none).
const originalCode = (e: unknown): Pick<Extra, 'original'> => { const c = thrownCode(e); return c.tag === 'some' ? { original: c.value } : {}; };

// After an acknowledged push: read `ref` back and require `expected`. A transport error here, or any other value, is
// 'ambiguous' — the push may have landed. Records `<prefix>.verify.ref` on `root` (empty when the ref is absent).
export async function verifyRef(t: Transport, root: Span, prefix: string, ref: string, expected: string): Promise<Result<string, ErrorOf<'ambiguous'>>> {
  // An Err, or anything a broken transport throws: either is a failed read-back.
  const read: Result<LsRefsResult, unknown> = await lsRefs(t, [ref]).then(r => r, (e: unknown) => err(e));
  if (!read.ok) {
    const e = read.error;
    // A thrown null has no `.message`: any failure to read the ref back is `ambiguous` (I25), whatever was thrown.
    const message = String(getOrElse<unknown>(thrownMessage(e), e));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- expected is an ad-hoc error field (errors.ts Extra); A3 moves it into Detail
    return fail('ambiguous', `push reported ok but the verification read-back failed: ${message}`, { cause: e, ...originalCode(e), expected } as Extra);
  }
  const seen: Option<string> = mapOption(mapGet(read.value.refs, ref), r => r.oid);
  root.set({ [`${prefix}.verify.ref`]: getOrElse(seen, '') });
  if (seen.tag === 'some' && seen.value === expected) return ok(seen.value);
  // `seen` is null on the error when the ref is absent, as the wire says it.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ad-hoc error fields (errors.ts Extra); A3 moves them into Detail
  return fail('ambiguous', `push reported ok but ${ref} is ${getOrElse(seen, 'absent')}, not ${expected}`, { seen: getOrElse<string | null>(seen, null), expected } as Extra);
}
