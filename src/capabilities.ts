// What an operation needs from the platform. Every field is present. The no-op tracer is a plain record, not
// `new Tracer()`: the edit bundle tree-shakes the Tracer class, and a caller who does not pass a tracer still starts
// spans that scrub errors the way a real span's `error` does.
import type { Attrs, Exporter, OtlpSpan, Scrub, Span, StartOptions, Tracer } from './otel.js';
import { cpuNow, KIND } from './otel.js';
import { scrubError } from './errors.js';
import type { Harvest } from './transport.js';
import { assertNever } from './result.js';

// Wall time in milliseconds, and CPU time in milliseconds (null where the platform has no CPU clock: Workers).
export type Clock = {
  readonly now: () => number;
  readonly cpu: () => number | null;
};
// The platform fetch. A wrapper, not `globalThis.fetch` detached: workerd throws Illegal invocation on a bare fetch.
export type FetchFn = (url: string | URL, init: RequestInit) => Promise<Response>;
// Commits and trees harvested from a wide pack. One fresh map per operation unless the caller passes one.
export type Storage = Harvest;

export type Capabilities = {
  readonly tracer: Tracer;
  readonly fetch: FetchFn;
  readonly clock: Clock;
  readonly storage: Storage;
};

// Commit timestamps are integer seconds. The caller names an instant, or the clock supplies one.
export type CommitTime =
  | { readonly tag: 'clock' }
  | { readonly tag: 'at'; readonly seconds: number };

export const systemClock: Clock = Object.freeze({
  now: (): number => Date.now(),
  cpu: cpuNow,
});
// oxlint-disable-next-line typescript/promise-function-async -- the platform promise, returned as is: the call stays `globalThis.fetch(...)` so workerd does not throw Illegal invocation
export const platformFetch: FetchFn = (url, init) => globalThis.fetch(url, init);
export const freshStorage = (): Storage => new Map();

const isRecord = (value: unknown): value is object => typeof value === 'object' && value !== null;

export const commitTimeOf = (value: unknown): CommitTime =>
  typeof value === 'number' ? { tag: 'at', seconds: value } : { tag: 'clock' };

export const commitUnix = (clock: Clock, time: CommitTime): number => {
  switch (time.tag) {
    case 'at': return time.seconds;
    case 'clock': return Math.floor(clock.now() / 1000);
    default: return assertNever(time);
  }
};

const drop: Exporter = () => { /* spans are not exported */ };
const ZERO_TRACE = '00000000000000000000000000000000';
const ZERO_SPAN = '0000000000000000';

function parentSpan(opts: StartOptions): Span | null {
  const parent = opts.parent;
  if (!isRecord(parent) || !('spanId' in parent)) return null;
  return parent;
}

function noopSpan(tracer: Tracer, name: string, opts: StartOptions): Span {
  const parent = parentSpan(opts);
  const parentScrub: Scrub | null = parent !== null && typeof parent.scrub === 'function' ? parent.scrub : null;
  const scrub = typeof opts.scrub === 'function' ? opts.scrub : parentScrub;
  const span: Span = {
    tracer,
    traceId: parent === null ? ZERO_TRACE : parent.traceId,
    spanId: ZERO_SPAN,
    parentSpanId: parent === null ? '' : parent.spanId,
    name,
    kind: typeof opts.kind === 'number' ? opts.kind : KIND.INTERNAL,
    start: '0',
    attrs: { ...opts.attrs },
    events: [],
    links: [],
    droppedEvents: 0,
    droppedLinks: 0,
    status: { code: 0 },
    ended: false,
    scrub,
    set(attrs: Attrs): Span { Object.assign(this.attrs, attrs); return this; },
    event(): Span { return this; },
    link(): Span { return this; },
    // The same scrub as Span.error: the error the caller catches must not keep a credential a server echoed.
    error(e: unknown): Span { scrubError(e, this.scrub); return this; },
    ok(): Span { return this; },
    end(): Span { this.ended = true; return this; },
  };
  return span;
}

// One shared tracer. Its exporter drops every span; `start` still returns a span, so a caller that omits `tracer`
// cannot hit a missing `.start`.
export const noopTracer: Tracer = {
  exporter: drop,
  maxEvents: 0,
  resource: { attributes: [] },
  scope: { name: 'ply', version: '0.1.0' },
  count: 0,
  start(name: string, opts: StartOptions): Span {
    return noopSpan(this, name, isRecord(opts) ? opts : {});
  },
  async span<T>(name: string, opts: StartOptions, fn: (s: Span) => T | PromiseLike<T>): Promise<T> {
    const s = this.start(name, opts);
    try {
      const r = await fn(s);
      s.end();
      return r;
    } catch (e) {
      s.error(e);
      s.end();
      throw e;
    }
  },
  export(_span: OtlpSpan): void {
    this.count += 1;
    this.exporter({ resourceSpans: [] });
  },
};

export const defaultCapabilities = (): Capabilities => ({
  tracer: noopTracer,
  fetch: platformFetch,
  clock: systemClock,
  storage: freshStorage(),
});
