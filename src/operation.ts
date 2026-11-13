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
import { Tracer, guardTelemetry } from './otel.js';
import type { Attrs, Frame, Hints, Quirks, RequestBody, Transport, TransportInput } from './transport.js';
import type { FetchLike, HttpAuth } from './http.js';
import { createTransport, redactUrl } from './http.js';
import { plyMade, transportFrom, withParent } from './transport.js';
import { lsRefs } from './lsrefs.js';
import type { LsRefsResult } from './lsrefs.js';
import { callbackFailed, describeThrown, fail, isPlyError, plyError } from './errors.js';
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
// The code an `ambiguous` replaced, when the thrown value had one (no key at all when it had none).
const originalCode = (e: unknown): Pick<Extra, 'original'> => { const c = thrownCode(e); return c.tag === 'some' ? { original: c.value } : {}; };
// What operation()'s catch needs of a thrown value, read without throwing: is it a PlyError, and the code it carries.
// A value that cannot be read (a revoked Proxy, a `code` getter that throws) is not a PlyError and has no code.
const readThrown = (e: unknown): { readonly known: PlyError | null; readonly original: Pick<Extra, 'original'> } => {
  try { return { known: isPlyError(e) ? e : null, original: originalCode(e) }; } catch { return { known: null, original: {} }; }
};
// The service whose request only reads. The protocol has one other, the push service, and it is named only in the push
// modules (a read-only bundle carries no push string: test/bundle.test.js). Once a request for any service but this
// one is handed to a transport, a failure is no longer definite.
const UPLOAD_PACK = 'git-upload-pack';
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
  // onFinish only adds attributes: what it throws is telemetry's failure (reported to the tracer's onTelemetryError when
  // it has one), never the operation's. The guard is ply's function, not a method of `tracer`: the check above
  // guarantees start() and nothing else (a start/span wrapper, a Tracer from another copy of ply).
  const finish = (extra: Attrs): Span => { if (onFinish !== null) guardTelemetry(tracer, 'onFinish', name, () => { root.set(onFinish()); }); root.set(extra); return root; };
  const outcome: Outcome = (kind, result, ...extra) => { const [given = {}] = extra; finish({ ...given, [`${name}.outcome`]: kind }).end(); return ok(result); };
  // An Err leaves through here: the outcome and error.type are its code (read before root.error scrubs it), the error is
  // recorded on the root, and it carries the root span for a caller's retry link.
  let fetchHandedOver = false;
  // A pack_corrupt after an upload-pack request was handed over may be the server's bytes: origin 'remote' makes it
  // retryable (errors.ts retryPolicy). Before that, the corrupt bytes were the caller's own and it stays 'no'.
  const failed = (e: PlyError): Result<R, PlyError> => {
    if (e.code === 'pack_corrupt' && fetchHandedOver) Object.assign(e, { origin: 'remote' });
    finish({ [`${name}.outcome`]: e.code }).error(e, e.code).end();
    Object.assign(e, { span: root });
    return err(e);
  };
  let r: Result<R, PlyError>;
  let pushHandedOver = false;
  try {
    // Inside the try: a transport that cannot be built (a bad URL, an unusable credential) ends the root with the
    // error recorded, like any other failure, instead of leaving it open and missing from the trace.
    // The limits, parsed once (#156): a bad one is refused here, before the transport exists or any request is sent.
    const checked = parseLimits(limits);
    if (!checked.ok) return failed(checked.error);
    const made: Result<Transport, PlyError> = transport === null ? createTransport(url, { auth, tracer, parent: root, fetchImpl: fetchImpl === null ? globalThis.fetch : fetchImpl, limits: checked.value, signal, ...(quirks === null ? {} : { quirks }) }) : map(transportFrom(transport), given => withParent(given, root));
    if (!made.ok) return failed(made.error);
    // The one fact the catch below needs: was a push request handed to a transport? From that call on the request may
    // be on the wire (a caller's transport may send before it yields a frame), so a throw is no longer a definite failure.
    const given = made.value;
    // frames() is called with the receiver it was called on, not `given`: ply hands each exchange a further view
    // (withParent(t, span); merge lowers `limits` the same way), and a caller's frames() reads `this.parent` from it.
    // plyMade: this frames() is ply's own over an already guarded `given`, so an operation handed `t` guards nothing again.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.create returns any; a view of `given` (like withParent) whose frames() records the hand-over
    const t = plyMade(Object.create(given, { frames: { enumerable: true, value: function frames(this: Transport, service: string, sent: RequestBody, span: Span, hints: Hints): AsyncIterable<Frame> {
      if (service === UPLOAD_PACK) fetchHandedOver = true; else pushHandedOver = true;
      return given.frames.call(this, service, sent, span, hints);
    } } }) as Transport);
    // The root and every span under it redact the credential; root.error(e) below scrubs the error the caller gets.
    if (t.scrub !== null) root.scrub = t.scrub;
    r = await body({ t, root, outcome, limits: checked.value });
  } catch (e) {
    // Every ply failure is the body's Err. What still arrives as a throw is not ply's: the caller's own callback (a
    // transport, a pack cache, any function it passed) raised it. operation() returns a Result all the same (README:
    // never a throw), with one honest outcome. Once a push request was handed to a transport the ref may have moved:
    // `ambiguous` (retry: read the ref back), carrying the thrown value as `cause`. Before that nothing was pushed: a
    // thrown PlyError is that Err, and anything else is bad_request naming 'callback' with the thrown value as `cause`.
    const { known, original } = readThrown(e);
    if (pushHandedOver && !(known !== null && known.code === 'ambiguous')) return failed(plyError('ambiguous', `${name}: a caller-supplied callback threw after the push request was handed to the transport, push outcome unknown: ${describeThrown(e)}`, { what: 'callback', cause: e, ...original }));
    return failed(known === null ? callbackFailed('callback', e) : known);
  }
  return r.ok ? r : failed(r.error);
}

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
