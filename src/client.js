// The full client as one object: every wire operation (ls-refs, fetch, negotiate, push, advertisements) over one
// transport. Convenience for scripts and tests; bundles that care about size import the free functions directly
// (transport.js, lsrefs.js, fetch.js, push.js...) — a class cannot be tree-shaken, a function can.
import { createTransport } from './http.js';
import { lsRefs } from './lsrefs.js';
import { packStream, fetchObject } from './fetch.js';
import { fetchPack } from './fetchpack.js';
import { negotiate } from './negotiate.js';
import { push } from './push.js';
import { receiveCaps, pushWithOptions } from './receivecaps.js';
import { discover } from './discover.js';

export { createTransport, redactUrl } from './http.js';
export { UA, withParent } from './transport.js';
export { lsRefsBody, lsRefs } from './lsrefs.js';
export { fetchBody, v2Init, v2Step, v2Attrs, packStream, fetchObject, spInit, spStep, spFinish } from './fetch.js';
export { fetchPack, packAttrs } from './fetchpack.js';
export { negotiate } from './negotiate.js';
export { ZERO_OID, pushBody, parseReportStatus, classifyReport, decideOutcome, push } from './push.js';
export { receiveCaps, pushCapsProblem, pushWithOptions } from './receivecaps.js';
export { discover, parseCapabilitiesV2, capLookup } from './discover.js';

export class GitHttp {
  constructor(url, opts = {}) { this.t = createTransport(url, opts); }
  get url() { return this.t.url; }
  get limits() { return this.t.limits; }
  get tracer() { return this.t.tracer; }
  get parent() { return this.t.parent; }
  lsRefs(prefixes) { return lsRefs(this.t, prefixes); }
  packStream(opts, span) { return packStream(this.t, opts, span); }
  fetchObject(opts) { return fetchObject(this.t, opts); }
  fetchPack(opts, extra) { return fetchPack(this.t, opts, extra); }
  negotiate(opts, extra) { return negotiate(this.t, opts, extra); }
  push(opts) { return opts.atomic || opts.pushOptions?.length ? pushWithOptions(this.t, opts) : push(this.t, opts); }
  receiveCaps() { return receiveCaps(this.t); }
  discover() { return discover(this.t); }
}
// ci/fast probe 2: whole-file mutation of every src file (reverted in the next commit)
