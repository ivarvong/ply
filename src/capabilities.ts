// What an operation needs from the platform, named and always present. An omitted capability is the typed default
// below; `undefined` is not a value any of them can take (exactOptionalPropertyTypes on the option fields). The
// no-op tracer is a plain record, not `new Tracer()`: the edit bundle tree-shakes the Tracer class, and a missing
// tracer must still start spans that scrub errors the way a real span's `error` does.
import type { Attrs, Exporter, OtlpSpan, Span, StartOptions, Tracer } from './otel.js';
import { cpuNow, KIND } from './otel.js';
import { scrubError } from './errors.js';
import type { Harvest } from './transport.js';

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
// What a caller may pass. Each field is absent or a value; `undefined` is not in the type.
export type CapabilitySource = {
  readonly tracer?: Tracer;
  readonly fetch?: FetchFn;
  // The name callers already pass. It may be explicitly undefined (a spread of an options object); `fetch` may not.
  readonly fetchImpl?: FetchFn | undefined;
  readonly clock?: Clock;
  readonly storage?: Storage;
};

export const systemClock: Clock = Object.freeze({
  now: (): number => Date.now(),
  cpu: cpuNow,
});
// oxlint-disable-next-line typescript/promise-function-async -- the platform promise, returned as is: the call stays `globalThis.fetch(...)` so workerd does not throw Illegal invocation
export const platformFetch: FetchFn = (url, init) => globalThis.fetch(url, init);
export const freshStorage = (): Storage => new Map();

// A clock the caller passed, or the system clock. `null` and `undefined` are both "not passed" (a loose options
// bag from a module whose options are still an index signature). Anything else is the caller's clock.
export const clockOf = (value: unknown): Clock => {
  if (value === undefined || value === null) return systemClock;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a loose options bag (merge, rebase) carries clock as unknown; the typed entries pass a Clock, and a wrong one fails at now()
  return value as Clock;
};

// Commit timestamps are integer seconds. An explicit `time` wins; an omitted one is the clock.
export const commitUnix = (clock: Clock, given: number | undefined): number => given ?? Math.floor(clock.now() / 1000);

const drop: Exporter = () => { /* spans are not exported */ };
const ZERO_TRACE = '00000000000000000000000000000000';
const ZERO_SPAN = '0000000000000000';

function noopSpan(tracer: Tracer, name: string, opts: StartOptions): Span {
  const span: Span = {
    tracer,
    traceId: opts.parent ? opts.parent.traceId : ZERO_TRACE,
    spanId: ZERO_SPAN,
    parentSpanId: opts.parent ? opts.parent.spanId : undefined,
    name,
    kind: opts.kind ?? KIND.INTERNAL,
    start: '0',
    attrs: { ...opts.attrs },
    events: [],
    links: [],
    droppedEvents: 0,
    droppedLinks: 0,
    status: { code: 0 },
    ended: false,
    scrub: opts.scrub ?? opts.parent?.scrub ?? null,
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
// cannot hit `Cannot read properties of undefined (reading 'start')`.
export const noopTracer: Tracer = {
  exporter: drop,
  maxEvents: 0,
  resource: { attributes: [] },
  scope: { name: 'ply', version: '0.1.0' },
  count: 0,
  start(name: string, opts: StartOptions = {}): Span { return noopSpan(this, name, opts); },
  async span<T>(name: string, opts: StartOptions | undefined, fn: (s: Span) => T | PromiseLike<T>): Promise<T> {
    const s = this.start(name, opts ?? {});
    try { const r = await fn(s); s.end(); return r; }
    catch (e) { s.error(e); s.end(); throw e; }
  },
  export(_span: OtlpSpan): void { this.count += 1; this.exporter({ resourceSpans: [] }); },
};

export function resolveCapabilities(input: CapabilitySource = {}): Capabilities {
  return {
    tracer: input.tracer ?? noopTracer,
    fetch: input.fetch ?? input.fetchImpl ?? platformFetch,
    clock: input.clock ?? systemClock,
    storage: input.storage ?? freshStorage(),
  };
}
