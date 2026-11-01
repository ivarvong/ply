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
import { lsRefs as lsRefsWire, parseUnbornLine } from './lsrefs.js';
import { packStream, fetchObject } from './fetch.js';
import { fetchPack } from './fetchpack.js';
import { negotiate } from './negotiate.js';
import type { PushResult as PushOk } from './push.js';
// oxlint-disable-next-line import/max-dependencies -- the one module that gathers every wire operation
import { receiveCaps, pushWithOptions } from './receivecaps.js';
import type { CheckedPushOptions } from './receivecaps.js';
import { discover } from './discover.js';

// A3: the audit deletes the unused re-exports below; they are public API until then.
export { createTransport, redactUrl } from './http.js';
export { UA, withParent } from './transport.js';
export { lsRefsBody, parseUnbornLine } from './lsrefs.js';
export type { LsRef, LsRefsResult, LsRefsUnborn } from './lsrefs.js';
export { fetchBody, v2Init, v2Step, v2Attrs, packStream, fetchObject, spInit, spStep, spFinish, isFilterRejection, isFilterRefusal } from './fetch.js';
export { fetchPack, fetchPackFiltered, packAttrs } from './fetchpack.js';
export { negotiate } from './negotiate.js';
export { ZERO_OID, pushBody, classifyReport, decideOutcome, push } from './push.js';
export { receiveCaps, capsProblem, checkPushCaps, pushWithOptions } from './receivecaps.js';
export { discover, parseCapabilitiesV2, capLookup } from './discover.js';

// lsRefs options. unborn: ask for the unborn HEAD (an empty repository's `HEAD -> refs/heads/main`), as git's clone does:
// the argument is sent only when the server's advertisement lists `ls-refs=unborn` (connect.c: server_supports_feature),
// so asking costs one advertisement round trip unless `info` (a discover() result already in hand) answers it. A server
// that does not advertise it gets no argument, and `unborn` is null.
export type LsRefsOptions = { readonly unborn?: boolean; readonly info?: Pick<DiscoverInfo, 'lsRefsUnborn'> };

// ls-refs over `t`. The edit and read paths call the wire exchange (lsrefs.ts) directly: they never ask for the unborn
// HEAD, so the advertisement parser stays out of their bundles.
export async function lsRefs(t: Transport, prefixes: readonly string[] = [], { unborn = false, info }: LsRefsOptions = {}): Promise<LsRefsResult> {
  const ask = unborn && (info ?? await discover(t)).lsRefsUnborn;
  return lsRefsWire(t, prefixes, ask ? { unborn: parseUnbornLine } : {});
}

// push options as GitHttp.push takes them: atomic and push options are checked against the advertisement (receivecaps.ts).
export type PushOpts = CheckedPushOptions;
type PushResult = Promise<PushOk>;
type ReceiveCaps = ReturnType<typeof receiveCaps>;

/* oxlint-disable typescript/promise-function-async -- pass-throughs: each returns the free function's own promise (an argument that throws synchronously still does) */
export class GitHttp {
  declare public readonly t: Transport;
  public constructor(url: string, opts: HttpOptions = {}) { this.t = createTransport(url, opts); }
  public get url(): string { return this.t.url; }
  public get limits(): Limits { return this.t.limits; }
  public get tracer(): Tracer { return this.t.tracer; }
  public get parent(): Span | null { return this.t.parent; }
  public lsRefs(prefixes?: readonly string[], opts?: LsRefsOptions): Promise<LsRefsResult> { return lsRefs(this.t, prefixes, opts); }
  public packStream(opts: FetchOpts, span: Span): PackFetch { return packStream(this.t, opts, span); }
  public fetchObject(opts: ObjectWant): Promise<FetchedObject> { return fetchObject(this.t, opts); }
  public fetchPack(opts: FetchOpts, extra?: FetchPackExtra): Promise<FetchPackResult> { return fetchPack(this.t, opts, extra); }
  public negotiate(opts: NegotiateOpts, extra?: Pick<FetchPackExtra, 'external' | 'resolve'>): Promise<NegotiateResult> { return negotiate(this.t, opts, extra); }
  // pushWithOptions reads the advertisement only when the push asks for atomic or push options
  public push(opts: PushOpts): PushResult { return pushWithOptions(this.t, opts); }
  public receiveCaps(): ReceiveCaps { return receiveCaps(this.t); }
  public discover(): Promise<DiscoverInfo> { return discover(this.t); }
}
/* oxlint-enable typescript/promise-function-async */
