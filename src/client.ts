// The full client as one object: every wire operation (ls-refs, fetch, negotiate, push, advertisements) over one
// transport. Convenience for scripts and tests; bundles that care about size import the free functions directly
// (transport.js, lsrefs.js, fetch.js, push.js...) — a class cannot be tree-shaken, a function can.
import type { Limits } from './limits.js';
import type { Span, Tracer } from './otel.js';
import type { Transport } from './transport.js';
import type { HttpOptions } from './http.js';
import type { FetchOpts, ObjectWant, FetchedObject, PackFetch } from './fetch.js';
import type { FetchPackExtra, FetchPackResult } from './fetchpack.js';
import type { NegotiateOpts, NegotiateResult } from './negotiate.js';
import type { LsRefsResult } from './lsrefs.js';
import type { DiscoverInfo } from './discover.js';
import { createTransport } from './http.js';
import { lsRefs } from './lsrefs.js';
import { packStream, fetchObject } from './fetch.js';
import { fetchPack } from './fetchpack.js';
import { negotiate } from './negotiate.js';
import { push } from './push.js';
// oxlint-disable-next-line import/max-dependencies -- the one module that gathers every wire operation
import { receiveCaps, pushWithOptions } from './receivecaps.js';
import type { PushOptions } from './push.js';
import { discover } from './discover.js';

// A3: the audit deletes the unused re-exports below; they are public API until then.
export { createTransport, redactUrl } from './http.js';
export { UA, withParent } from './transport.js';
export { lsRefsBody, lsRefs } from './lsrefs.js';
export { fetchBody, v2Init, v2Step, v2Attrs, packStream, fetchObject, spInit, spStep, spFinish } from './fetch.js';
export { fetchPack, packAttrs } from './fetchpack.js';
export { negotiate } from './negotiate.js';
export { ZERO_OID, pushBody, parseReportStatus, classifyReport, decideOutcome, push } from './push.js';
export { receiveCaps, pushCapsProblem, pushWithOptions } from './receivecaps.js';
export { discover, parseCapabilitiesV2, capLookup } from './discover.js';

// push.js and receivecaps.js are not converted yet: the options as push.js documents them, its results as it declares them.
export type PushOpts = PushOptions;
type PushResult = ReturnType<typeof push>;
type ReceiveCaps = ReturnType<typeof receiveCaps>;

/* oxlint-disable typescript/promise-function-async -- pass-throughs: each returns the free function's own promise (an argument that throws synchronously still does) */
export class GitHttp {
  declare public readonly t: Transport;
  public constructor(url: string, opts: HttpOptions = {}) { this.t = createTransport(url, opts); }
  public get url(): string { return this.t.url; }
  public get limits(): Limits { return this.t.limits; }
  public get tracer(): Tracer { return this.t.tracer; }
  public get parent(): Span | null { return this.t.parent; }
  public lsRefs(prefixes?: readonly string[]): Promise<LsRefsResult> { return lsRefs(this.t, prefixes); }
  public packStream(opts: FetchOpts, span: Span): PackFetch { return packStream(this.t, opts, span); }
  public fetchObject(opts: ObjectWant): Promise<FetchedObject> { return fetchObject(this.t, opts); }
  public fetchPack(opts: FetchOpts, extra?: FetchPackExtra): Promise<FetchPackResult> { return fetchPack(this.t, opts, extra); }
  public negotiate(opts: NegotiateOpts, extra?: Pick<FetchPackExtra, 'external' | 'resolve'>): Promise<NegotiateResult> { return negotiate(this.t, opts, extra); }
  // A4: the audit's CheckedCaps; this duplicates pushWithOptions' routing (receivecaps.js).
  // oxlint-disable-next-line typescript/strict-boolean-expressions, typescript/no-unsafe-type-assertion -- an empty option list is no options, as before; push.js infers its options from their defaults until its cluster converts
  public push(opts: PushOpts): PushResult { return opts.atomic || opts.pushOptions?.length ? pushWithOptions(this.t, opts) : push(this.t, opts); }
  public receiveCaps(): ReceiveCaps { return receiveCaps(this.t); }
  public discover(): Promise<DiscoverInfo> { return discover(this.t); }
}
/* oxlint-enable typescript/promise-function-async */
