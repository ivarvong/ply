// Minimal OTLP/JSON tracer. One ExportTraceServiceRequest per span per line (JSONL),
// so `grep '"key":"git.pack.objects"' trace.jsonl` works and the same lines can be
// POSTed to any OTLP/HTTP collector unchanged.

/* oxlint-disable max-classes-per-file -- Tracer and Span are one API: a Tracer starts Spans, a Span exports through its Tracer */
import { scrubError } from './errors.js';
import { thrownCode, thrownMessage, thrownName, thrownStack } from './boundary.js';
import { errorKind, getOrElse, none } from './result.js';
import type { Input } from './absent.js';
import { atOr, field, fromNullable, fromNullish, isMissing, withDefaults } from './absent.js';

// OTLP AnyValue: exactly one of these fields. `in` on the field name discriminates.
export type AnyValue =
  | { readonly stringValue: string }
  | { readonly boolValue: boolean }
  | { readonly intValue: string }
  | { readonly doubleValue: number }
  | { readonly bytesValue: string }
  | { readonly arrayValue: { readonly values: readonly AnyValue[] } };
export type KeyValue = { readonly key: string; readonly value: AnyValue };
// Span attributes as the caller writes them: scalars, bytes or arrays of them. A key holding the platform missing value
// is not exported (a caller's `{ x: maybe }` sets nothing); null is exported as the empty string.
export type Attrs = Readonly<Record<string, unknown>>;
export type Scrub = (s: string) => string;
// OTLP StatusCode: 0 unset, 1 ok, 2 error. Only an error carries a message.
export type Status = { readonly code: 0 } | { readonly code: 1 } | { readonly code: 2; readonly message: string };
export type SpanEvent = { readonly name: string; readonly timeUnixNano: string; readonly attributes: readonly KeyValue[] };
export type SpanLink = { readonly traceId: string; readonly spanId: string; readonly attributes: readonly KeyValue[] };
// A root span has no parentSpanId key at all (OTLP omits it); a child names its parent.
export type OtlpRootSpan = {
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
  readonly kind: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: readonly KeyValue[];
  readonly events: readonly SpanEvent[];
  readonly links: readonly SpanLink[];
  readonly status: Status;
  readonly droppedAttributesCount: number;
  readonly droppedEventsCount: number;
  readonly droppedLinksCount: number;
};
export type OtlpChildSpan = OtlpRootSpan & { readonly parentSpanId: string };
export type OtlpSpan = OtlpRootSpan | OtlpChildSpan;
export type Scope = { readonly name: string; readonly version: string };
export type ScopeSpans = { readonly scope: Scope; readonly spans: readonly OtlpSpan[] };
export type ResourceSpans = { readonly resource: { readonly attributes: readonly KeyValue[] }; readonly scopeSpans: readonly ScopeSpans[] };
export type ExportLine = { readonly resourceSpans: readonly ResourceSpans[] };
// Returns nothing ply reads. An async exporter's promise is watched: its rejection goes to onTelemetryError.
export type Exporter = (line: ExportLine) => unknown;
// A span as it ended, as plain values: exactly what `flattenLine` reads back from the OTLP line `end()` would export for
// it (attributes and event attributes scrubbed, an int as a number, bytes as base64, null as ''), plus its start and end
// times. `otlp()` builds that OTLP span on first call and returns the same object after. For an exporter that lives in
// the same process (a list kept for the request, a span mirrored onto a platform tracer): no OTLP is built for it.
export type EndedSpan = FlatSpan & {
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly otlp: () => OtlpSpan;
};
export type SpanSink = (span: EndedSpan) => unknown;

// Platform clocks are probed, not type-checked: newer Workers compatibility dates define a `process` global whose
// `hrtime`/`cpuUsage` exist but throw "not implemented" (found under workerd 2026-10-18, compat date 2026-10-18).
const probe = <F extends () => unknown>(make: () => F, fallback: F): F => { try { const f = make(); f(); return f; } catch { return fallback; } };
const nowNs = probe((): (() => bigint) => { const base = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint(); return () => base + process.hrtime.bigint(); }, () => BigInt(Date.now()) * 1_000_000n);
const now = (): string => nowNs().toString();

// CPU clock: real on node (process.cpuUsage), null on Workers where no clock advances during synchronous work. Spans
// record cpu_ms only where it is measured; the edge carries calibrated estimates instead (see edit.js CPU_RATE).
export const cpuNow: () => number | null = probe((): (() => number | null) => () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }, () => null);
// t0 is non-null only where the clock is real, so cpuNow() is a number there.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- see above (and no `!`: docs/STACK.md)
export const cpuSince = (t0: number | null): number | null => (t0 === null ? null : (cpuNow() as number) - t0);

// Isolate-lifetime invocation counter: module scope survives across requests inside one isolate (workerd, node), so the
// first root span of an isolate is the one that paid connection setup, JIT warmup and cache misses.
let invocations = 0;

// Span and trace ids: `words` random 32-bit words as lowercase hex, 8 digits each. The words come from a pool filled 256
// at a time (one getRandomValues call per 42 spans, not one per id), each word used once. Filled on first use, never at
// module load: Workers refuse getRandomValues in the global scope.
const POOL_WORDS = 256;
const pool = new Uint32Array(POOL_WORDS);
let pooled = POOL_WORDS;
const rand = (words: number): string => {
  let hex = '';
  for (let i = 0; i < words; i++) {
    // Stryker disable next-line ConditionalExpression: refilling for every word gives ids of the same form (the pool is the fast path)
    if (pooled === POOL_WORDS) { crypto.getRandomValues(pool); pooled = 0; }
    hex += atOr(pool, pooled++, 0).toString(16).padStart(8, '0');
  }
  return hex;
};

// OTLP AnyValue encoding (pure)
export function anyValue(v: unknown): AnyValue {
  if (fromNullish(v).tag === 'none') return { stringValue: '' };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'bigint') return { intValue: v.toString() };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  // bytes are code units 0-255, where fromCharCode and fromCodePoint agree
  // oxlint-disable-next-line unicorn/prefer-code-point -- see above
  if (v instanceof Uint8Array) return { bytesValue: btoa(String.fromCharCode(...v.subarray(0, 4096))) };
  // oxlint-disable-next-line unicorn/no-array-callback-reference -- bundle budget: anyValue takes one argument, so map's index and array are ignored
  if (Array.isArray(v)) return { arrayValue: { values: v.map(anyValue) } };
  // objects are stringified: attribute values are scalars or arrays of scalars
  // oxlint-disable-next-line typescript/no-base-to-string -- a caller's object renders as String() renders it, as before
  return { stringValue: String(v) };
}
export const kvs = (obj: Attrs): KeyValue[] => Object.entries(obj).filter(([, v]) => fromNullable(v).tag === 'some').map(([key, value]) => ({ key, value: anyValue(value) }));
const scrubAny = (v: AnyValue, scrub: Scrub): AnyValue => {
  if ('stringValue' in v) return { stringValue: scrub(v.stringValue) };
  return 'arrayValue' in v ? { arrayValue: { values: v.arrayValue.values.map(x => scrubAny(x, scrub)) } } : v;
};
const scrubKvs = (list: readonly KeyValue[], scrub: Scrub): KeyValue[] => list.map(({ key, value }) => ({ key, value: scrubAny(value, scrub) }));

// One attribute value as the reading side sees it: fromAny(scrubAny(anyValue(v))) without building the AnyValue, so an
// in-process consumer pays neither encoding. Each branch is anyValue's, in its order; test/otel-ended.test.js holds the
// two equal over every kind of value.
const text = (s: string, scrub: Scrub | null): string => (scrub === null ? s : scrub(s));
function flatValue(v: unknown, scrub: Scrub | null): FlatValue {
  if (v === null || isMissing(v)) return text('', scrub);
  // Stryker disable next-line ConditionalExpression,StringLiteral: a string skipped here reaches the String(v) branch below, which returns the same text
  if (typeof v === 'string') return text(v, scrub);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return Number(v.toString());
  // an integer goes out as intValue String(v) and comes back through Number(): only -0 changes (to 0)
  if (typeof v === 'number') return v === 0 ? 0 : v;
  // bytes are not scrubbed: they leave as base64, which no credential pattern matches
  // oxlint-disable-next-line unicorn/prefer-code-point -- code units 0-255, as anyValue
  if (v instanceof Uint8Array) return btoa(String.fromCharCode(...v.subarray(0, 4096)));
  if (Array.isArray(v)) return v.map(x => flatValue(x, scrub));
  // oxlint-disable-next-line typescript/no-base-to-string -- a caller's object renders as String() renders it, as anyValue
  return text(String(v), scrub);
}
// A plain record, keyed as Object.fromEntries keys it: an own `__proto__` key is a property, not the prototype.
function flatAttrs(attrs: Attrs, scrub: Scrub | null): FlatAttrs {
  const out: FlatAttrs = {};
  for (const key of Object.keys(attrs)) {
    const v = attrs[key];
    if (isMissing(v)) continue;
    // Stryker disable next-line ConditionalExpression: defining every key as a property gives the same record (the assignment is the fast path)
    if (key === '__proto__') Object.defineProperty(out, key, { value: flatValue(v, scrub), enumerable: true, writable: true, configurable: true });
    else out[key] = flatValue(v, scrub);
  }
  return out;
}

// The default exporter: spans are dropped. end() checks for it, so a tracer without an exporter builds no OTLP.
const dropSpans: Exporter = () => { /* spans are dropped */ };

export const KIND: Readonly<{ INTERNAL: 1; SERVER: 2; CLIENT: 3; PRODUCER: 4; CONSUMER: 5 }> = Object.freeze({ INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 });

// `onEnd`: called with each span as it ends (an EndedSpan), before the exporter. `exporter`: the OTLP/JSON line per span.
// A tracer with only `onEnd` builds no OTLP unless a consumer calls `otlp()`; one with neither builds nothing.
// `onTelemetryError`: telemetry never changes an operation's outcome. A throw or a rejected promise from `onEnd`, from
// `exporter` (or an overridden `export`) or from an operation's `onFinish` is caught where ply calls it, counted in
// `tracer.telemetryErrors` and handed to this hook (null: only counted). What the hook itself throws is dropped.
export type TelemetryHook = 'onEnd' | 'exporter' | 'onFinish';
export type TelemetryErrorSink = (error: unknown, at: { readonly hook: TelemetryHook; readonly span: string }) => unknown;
export type TracerConfig = { readonly exporter: Exporter; readonly onEnd: SpanSink | null; readonly onTelemetryError: TelemetryErrorSink | null; readonly resource: Attrs; readonly scope: Scope; readonly maxEvents: number };
export type TracerOptions = Input<TracerConfig>;
// How a span starts: under `parent`, or following `follows` (never both), with the credential scrubber it inherits.
export type StartConfig = { readonly parent: Span | null; readonly follows: Span | null; readonly kind: number; readonly attrs: Attrs; readonly scrub: Scrub | null };
export type StartOptions = Input<StartConfig>;
type SpanInit = StartConfig & { readonly name: string };
// A span's scrubber: its own, else its parent's, else the span it follows.
const inheritedScrub = ({ scrub, parent, follows }: StartConfig): Scrub | null => {
  if (scrub !== null) return scrub;
  if (parent !== null) return parent.scrub;
  return follows === null ? null : follows.scrub;
};
// A thrown field rendered the way String() renders it (a stack, a message). A string is itself.
const asText = (v: unknown): string => (typeof v === 'string' ? v : String(v));

// ---- reading a value back (shared by the reading side below and EndedSpan) ----
export function fromAny(v: AnyValue): FlatValue {
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('boolValue' in v) return v.boolValue;
  if ('arrayValue' in v) return v.arrayValue.values.map(fromAny);
  return v.bytesValue;
}
export const flattenKvs = (list: readonly KeyValue[]): FlatAttrs => Object.fromEntries(list.map(({ key, value }) => [key, fromAny(value)]));

// an error's message (even empty) is a string the scrubber must see; ok and unset carry none
const scrubbedStatus = (status: Status, s: Scrub | null): Status => (s !== null && status.code === 2 ? { code: 2, message: s(status.message) } : status);

// What the OTLP span is built from: a live span, or an ended span's fields as they were when it ended.
type SpanFields = Pick<Span, 'traceId' | 'spanId' | 'parentSpanId' | 'name' | 'kind' | 'start' | 'attrs' | 'events' | 'links' | 'status' | 'droppedEvents' | 'droppedLinks' | 'scrub'>;

// The OTLP span end() exports.
function otlpSpan(span: SpanFields, endTimeUnixNano: string): OtlpSpan {
  const s = span.scrub;
  return {
    ...(span.parentSpanId === null ? {} : { parentSpanId: span.parentSpanId }),
    traceId: span.traceId, spanId: span.spanId, name: span.name, kind: span.kind,
    startTimeUnixNano: span.start, endTimeUnixNano,
    attributes: s ? scrubKvs(kvs(span.attrs), s) : kvs(span.attrs),
    events: s ? span.events.map(ev => ({ ...ev, attributes: scrubKvs(ev.attributes, s) })) : span.events,
    links: span.links, status: scrubbedStatus(span.status, s),
    droppedAttributesCount: 0, droppedEventsCount: span.droppedEvents, droppedLinksCount: span.droppedLinks,
  };
}

const flatEvent = (ev: SpanEvent, s: Scrub | null): FlatSpan['events'][number] => ({ name: ev.name, attrs: flattenKvs(s ? scrubKvs(ev.attributes, s) : ev.attributes) });
const flatLink = (l: SpanLink): FlatSpan['links'][number] => ({ traceId: l.traceId, spanId: l.spanId, attrs: flattenKvs(l.attributes) });
// A list as it stands, for a span that may still be written to after it ended. Most spans have no events or links.
// Stryker disable next-line ConditionalExpression: slicing an empty list is a fresh empty list too (the test is the fast path)
const copied = <T>(list: T[]): T[] => (list.length === 0 ? [] : list.slice());

// The EndedSpan of a span that just ended. Its OTLP form is built on first call from the span's fields as they were at
// end: the attributes record (set() after end writes a copy), and copies of the event and link lists.
function endedSpan(span: Span, end: bigint): EndedSpan {
  const s = span.scrub;
  const endTimeUnixNano = end.toString();
  const fields: SpanFields = {
    traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId, name: span.name, kind: span.kind, start: span.start,
    attrs: span.attrs, events: copied(span.events), links: copied(span.links), status: span.status,
    droppedEvents: span.droppedEvents, droppedLinks: span.droppedLinks, scrub: s,
  };
  let built: OtlpSpan | null = null;
  const otlp = (): OtlpSpan => {
    if (built === null) built = otlpSpan(fields, endTimeUnixNano);
    return built;
  };
  return {
    traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId, name: span.name, kind: span.kind,
    durationMs: Number(end - BigInt(span.start)) / 1e6,
    status: scrubbedStatus(span.status, s), attrs: flatAttrs(span.attrs, s), droppedEvents: span.droppedEvents,
    events: fields.events.map(ev => flatEvent(ev, s)), links: fields.links.map(flatLink),
    startTimeUnixNano: span.start, endTimeUnixNano, otlp,
  };
}

// `declare` fields: assigned in the constructor, so they emit nothing (the JS is the constructor body as before).
// A span under an authenticated transport carries the transport's `scrub` (http.js), and every child inherits it. At
// export every string (attributes, event attributes, status) passes through it, and `error(e)` scrubs the error object
// itself in place, so neither the trace nor the error the caller catches holds a credential a server echoed back.
export class Span {
  public declare tracer: Tracer;
  public declare traceId: string;
  public declare spanId: string;
  public declare parentSpanId: string | null;
  public declare name: string;
  public declare kind: number;
  public declare start: string;
  public declare attrs: Record<string, unknown>;
  public declare events: SpanEvent[];
  public declare links: SpanLink[];
  public declare droppedEvents: number;
  public declare droppedLinks: number;
  public declare status: Status;
  public declare ended: boolean;
  public declare scrub: Scrub | null;
  public constructor(tracer: Tracer, init: SpanInit) {
    const { name, kind, attrs, parent, follows } = init;
    if (parent && follows) throw new TypeError('a span has a parent or follows one, not both');
    this.tracer = tracer;
    this.traceId = parent ? parent.traceId : rand(4);
    this.spanId = rand(2);
    this.parentSpanId = parent ? parent.spanId : null;
    this.name = name;
    this.kind = kind;
    this.start = now();
    this.attrs = { ...attrs };
    if (!parent && !follows) { invocations++; this.attrs['ply.isolate.invocation'] = invocations; this.attrs['ply.isolate.cold'] = invocations === 1; }
    this.events = [];
    this.links = [];
    this.droppedEvents = 0;
    this.droppedLinks = 0;
    this.status = { code: 0 };
    this.ended = false;
    this.scrub = inheritedScrub(init);
    if (follows) { this.link(follows, { 'ply.link': 'follows_from' }); if (!follows.ended) follows.link(this, { 'ply.link': 'followed_by' }); }
  }
  // After end() the record an EndedSpan's otlp() reads is left as it ended: a late set() writes to a copy.
  public set(attrs: Attrs): this { if (this.ended) this.attrs = { ...this.attrs }; Object.assign(this.attrs, attrs); return this; }
  // Bounded: a pack with 10k objects must not produce a 10k-event span. The count of dropped events is exported.
  public event(name: string, attrs: Attrs = {}): this {
    if (this.events.length >= this.tracer.maxEvents) { this.droppedEvents++; return this; }
    this.events.push({ name, timeUnixNano: now(), attributes: kvs(attrs) }); return this;
  }
  // OTLP span link: a causal relation to a span that is not the parent (e.g. the attempt this one retries). Bounded like
  // events: a checkout that streams 10k blobs must not produce a 10k-link span.
  public link(span: Span, attrs: Attrs = {}): this {
    if (this.links.length >= this.tracer.maxEvents) { this.droppedLinks++; return this; }
    this.links.push({ traceId: span.traceId, spanId: span.spanId, attributes: kvs(attrs) }); return this;
  }
  // `type`: the error.type to record (a caller's code); without one, or with null, the thrown value's code or name.
  public error(e: unknown, ...type: [] | [unknown]): this {
    scrubError(e, this.scrub);
    // a thrown value of any type: a primitive or null has none of these fields
    const message = asText(getOrElse(thrownMessage(e), e));
    const name = getOrElse<unknown>(thrownName(e), 'Error');
    const given = type.length === 0 ? none : fromNullish(type[0]);
    this.status = { code: 2, message };
    // error.type stays the taxonomy code (or the type the caller passed). error.kind is the closed discriminant
    // callers switch on: miss.kind, then kind, then reason, then code (#157).
    this.set({ 'error.type': getOrElse(given, getOrElse(thrownCode(e), name)), 'error.kind': errorKind(e) });
    this.event('exception', { 'exception.type': name, 'exception.message': message, 'exception.stacktrace': asText(getOrElse<unknown>(thrownStack(e), '')) });
    return this;
  }
  public ok(): this { if (this.status.code === 0) this.status = { code: 1 }; return this; }
  // Ends the span once. The tracer's onEnd gets the EndedSpan; its exporter (or an override of export) gets the OTLP
  // span. With neither, nothing is built: the span is only counted.
  public end(): this {
    if (this.ended) return this;
    this.ended = true;
    this.ok();
    const end = nowNs();
    const tracer = this.tracer;
    const sink = tracer.onEnd;
    // a subclass that overrides export (a tracer that mirrors spans elsewhere) still gets every span
    // oxlint-disable-next-line no-use-before-define -- Span and Tracer are one API (see the top of this file); this runs after both exist
    const exports = tracer.exporter !== dropSpans || tracer.export !== Tracer.prototype.export;
    // Every call below into the caller's code (onEnd, the exporter, an overridden export) is guarded: end() never throws.
    if (sink === null) {
      // oxlint-disable-next-line typescript/no-confusing-void-expression -- an override of export may be async: guard watches what it returns
      if (exports) tracer.guard('exporter', this.name, (): unknown => tracer.export(otlpSpan(this, end.toString())));
      else tracer.count++;
      return this;
    }
    const ended = endedSpan(this, end);
    tracer.guard('onEnd', this.name, (): unknown => sink(ended));
    // oxlint-disable-next-line typescript/no-confusing-void-expression -- as above
    if (exports) tracer.guard('exporter', this.name, (): unknown => tracer.export(ended.otlp()));
    else tracer.count++;
    return this;
  }
}

export class Tracer {
  public declare exporter: Exporter;
  public declare onEnd: SpanSink | null;
  public declare onTelemetryError: TelemetryErrorSink | null;
  // how many calls into the caller's telemetry code (onEnd, exporter, onFinish) threw or rejected
  public declare telemetryErrors: number;
  public declare maxEvents: number;
  public declare resource: { attributes: KeyValue[] };
  public declare scope: Scope;
  public declare count: number;
  public constructor(options: TracerOptions = {}) {
    const { exporter, onEnd, onTelemetryError, resource, scope, maxEvents } = withDefaults(options, { exporter: dropSpans, onEnd: null, onTelemetryError: null, resource: {}, scope: { name: 'ply', version: '0.2.0' }, maxEvents: 256 });
    this.exporter = exporter;
    this.onEnd = onEnd;
    this.onTelemetryError = onTelemetryError;
    this.telemetryErrors = 0;
    this.maxEvents = maxEvents;
    this.resource = { attributes: kvs({ 'service.name': 'ply', 'telemetry.sdk.name': 'ply-otel', 'telemetry.sdk.language': 'javascript', ...resource }) };
    this.scope = scope;
    this.count = 0;
  }
  // `follows`: start a span that measures work the caller drives after `follows` returns (a stream it reads, an iterator
  // it drains). It is the root of a trace of its own with a 'follows_from' link to `follows` (and, while `follows` is
  // still open, a 'followed_by' link back), so no child outlives its parent: README "Span lifetimes".
  public start(name: string, options: StartOptions = {}): Span {
    return new Span(this, { name, ...withDefaults<StartConfig>(options, { parent: null, follows: null, kind: KIND.INTERNAL, attrs: {}, scrub: null }) });
  }
  // Run fn(span) with automatic end/status.
  public async span<T>(name: string, opts: StartOptions, fn: (s: Span) => T | PromiseLike<T>): Promise<T> {
    const s = this.start(name, opts);
    try { const r = await fn(s); s.end(); return r; }
    catch (e) { s.error(e); s.end(); throw e; }
  }
  public export(span: OtlpSpan): void {
    this.count++;
    const line: ExportLine = { resourceSpans: [{ resource: this.resource, scopeSpans: [{ scope: this.scope, spans: [span] }] }] };
    // guarded here as well as in Span.end(): an async exporter's rejection is caught where its promise is returned
    this.guard('exporter', span.name, (): unknown => this.exporter(line));
  }
  // The boundary around the caller's telemetry code: run `call`; a throw, or a rejection of the promise it returns (an
  // async exporter), is counted and reported, and never reaches the operation that ended the span.
  public guard(hook: TelemetryHook, span: string, call: () => unknown): void {
    try {
      const returned = call();
      // an async exporter returns a promise (any thenable is an object): its rejection is this hook's failure too
      if (typeof returned === 'object' && returned !== null) Promise.resolve(returned).catch((e: unknown) => { this.telemetryFailed(e, hook, span); });
    } catch (e) { this.telemetryFailed(e, hook, span); }
  }
  private telemetryFailed(thrown: unknown, hook: TelemetryHook, span: string): void {
    this.telemetryErrors++;
    const report = this.onTelemetryError;
    if (report === null) return;
    try {
      const returned = report(thrown, { hook, span });
      if (typeof returned === 'object' && returned !== null) Promise.resolve(returned).catch(() => { /* the reporter is telemetry too */ });
    } catch { /* the reporter is telemetry too: what it throws is dropped */ }
  }
}

// ---- exporters ----
export type ArrayExporter = Exporter & { readonly lines: ExportLine[] };
export const arrayExporter = (arr: ExportLine[] = []): ArrayExporter => Object.assign((line: ExportLine) => { arr.push(line); }, { lines: arr });
// the console exporter's default sink is the console; bundle budget: the JS's arrow, byte for byte
// oxlint-disable-next-line no-console, typescript/no-confusing-void-expression -- see above
export const consoleExporter = (log: (s: string) => void = console.log): Exporter => request => log(JSON.stringify(request));
// ---- reading side (pure): flatten a JSONL line back to {name, attrs, events, ...} ----
export type FlatValue = string | number | boolean | readonly FlatValue[];
export type FlatAttrs = Record<string, FlatValue>;
export type FlatSpan = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly kind: number;
  readonly durationMs: number;
  readonly status: Status;
  readonly attrs: FlatAttrs;
  readonly droppedEvents: number;
  readonly events: ReadonlyArray<{ readonly name: string; readonly attrs: FlatAttrs }>;
  readonly links: ReadonlyArray<{ readonly traceId: string; readonly spanId: string; readonly attrs: FlatAttrs }>;
};
// The reading side takes lines from any producer: parentSpanId, links and the dropped counts may be missing there.
const foreignString = (s: OtlpSpan, key: string): string | null => { const v = field(s, key); return v.tag === 'some' && typeof v.value === 'string' ? v.value : null; };
const foreignCount = (s: OtlpSpan, key: string): number => { const v = field(s, key); return v.tag === 'some' && typeof v.value === 'number' ? v.value : 0; };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a foreign line's links, when it has a list there, are OTLP links
const foreignLinks = (s: OtlpSpan): readonly SpanLink[] => { const v = field(s, 'links'); return v.tag === 'some' && Array.isArray(v.value) ? v.value as SpanLink[] : []; };
export function flattenLine(line: ExportLine): FlatSpan[] {
  return line.resourceSpans.flatMap(rs => rs.scopeSpans.flatMap(ss => ss.spans.map(s => ({
    traceId: s.traceId, spanId: s.spanId, parentSpanId: foreignString(s, 'parentSpanId'), name: s.name, kind: s.kind,
    durationMs: Number(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1e6,
    status: s.status, attrs: flattenKvs(s.attributes), droppedEvents: foreignCount(s, 'droppedEventsCount'),
    events: s.events.map(e => ({ name: e.name, attrs: flattenKvs(e.attributes) })),
    links: foreignLinks(s).map(l => ({ traceId: l.traceId, spanId: l.spanId, attrs: flattenKvs(l.attributes) })),
  }))));
}
