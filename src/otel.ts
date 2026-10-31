// Minimal OTLP/JSON tracer. One ExportTraceServiceRequest per span per line (JSONL),
// so `grep '"key":"git.pack.objects"' trace.jsonl` works and the same lines can be
// POSTed to any OTLP/HTTP collector unchanged.

/* oxlint-disable max-classes-per-file -- Tracer and Span are one API: a Tracer starts Spans, a Span exports through its Tracer */
import { scrubError } from './errors.js';
import { thrownCode, thrownMessage, thrownName, thrownStack } from './boundary.js';

// OTLP AnyValue: exactly one of these fields. `in` on the field name discriminates.
export type AnyValue =
  | { readonly stringValue: string }
  | { readonly boolValue: boolean }
  | { readonly intValue: string }
  | { readonly doubleValue: number }
  | { readonly bytesValue: string }
  | { readonly arrayValue: { readonly values: readonly AnyValue[] } };
export type KeyValue = { readonly key: string; readonly value: AnyValue };
// Span attributes as the caller writes them: scalars, bytes or arrays of them; undefined means "not set".
export type Attrs = Readonly<Record<string, unknown>>;
export type Scrub = (s: string) => string;
// 0 unset, 1 ok, 2 error (OTLP StatusCode).
export type Status = { readonly code: number; readonly message?: string };
export type SpanEvent = { readonly name: string; readonly timeUnixNano: string; readonly attributes: readonly KeyValue[] };
export type SpanLink = { readonly traceId: string; readonly spanId: string; readonly attributes: readonly KeyValue[] };
export type OtlpSpan = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly name: string;
  readonly kind: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: readonly KeyValue[];
  readonly events: readonly SpanEvent[];
  // optional on the reading side: a line from another producer may leave them out
  readonly links?: readonly SpanLink[];
  readonly status: Status;
  readonly droppedAttributesCount?: number;
  readonly droppedEventsCount?: number;
  readonly droppedLinksCount?: number;
};
export type Scope = { readonly name: string; readonly version?: string };
export type ScopeSpans = { readonly scope: Scope; readonly spans: readonly OtlpSpan[] };
export type ResourceSpans = { readonly resource: { readonly attributes: readonly KeyValue[] }; readonly scopeSpans: readonly ScopeSpans[] };
export type ExportLine = { readonly resourceSpans: readonly ResourceSpans[] };
export type Exporter = (line: ExportLine) => void;

// Platform clocks are probed, not type-checked: newer Workers compatibility dates define a `process` global whose
// `hrtime`/`cpuUsage` exist but throw "not implemented" (found under workerd 2026-10-18, compat date 2026-10-18).
const probe = <F extends () => unknown>(make: () => F, fallback: F): F => { try { const f = make(); f(); return f; } catch { return fallback; } };
const now = probe((): (() => string) => { const base = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint(); return () => (base + process.hrtime.bigint()).toString(); }, () => (BigInt(Date.now()) * 1_000_000n).toString());

// CPU clock: real on node (process.cpuUsage), null on Workers where no clock advances during synchronous work. Spans
// record cpu_ms only where it is measured; the edge carries calibrated estimates instead (see edit.js CPU_RATE).
export const cpuNow: () => number | null = probe((): (() => number | null) => () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }, () => null);
// t0 is non-null only where the clock is real, so cpuNow() is a number there.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- see above (and no `!`: docs/STACK.md)
export const cpuSince = (t0: number | null): number | null => (t0 === null ? null : (cpuNow() as number) - t0);

// Isolate-lifetime invocation counter: module scope survives across requests inside one isolate (workerd, node), so the
// first root span of an isolate is the one that paid connection setup, JIT warmup and cache misses.
let invocations = 0;

const rand = (n: number): string => { const b = new Uint8Array(n); crypto.getRandomValues(b); return Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); };

// OTLP AnyValue encoding (pure)
export function anyValue(v: unknown): AnyValue {
  if (v === null || v === undefined) return { stringValue: '' };
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
export const kvs = (obj: Attrs): KeyValue[] => Object.entries(obj).filter(([, v]) => v !== undefined).map(([key, value]) => ({ key, value: anyValue(value) }));
const scrubAny = (v: AnyValue, scrub: Scrub): AnyValue => {
  if ('stringValue' in v) return { stringValue: scrub(v.stringValue) };
  return 'arrayValue' in v ? { arrayValue: { values: v.arrayValue.values.map(x => scrubAny(x, scrub)) } } : v;
};
const scrubKvs = (list: readonly KeyValue[], scrub: Scrub): KeyValue[] => list.map(({ key, value }) => ({ key, value: scrubAny(value, scrub) }));

export const KIND: Readonly<{ INTERNAL: 1; SERVER: 2; CLIENT: 3; PRODUCER: 4; CONSUMER: 5 }> = Object.freeze({ INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 });

export type TracerOptions = {
  readonly exporter?: Exporter;
  readonly resource?: Attrs;
  readonly scope?: Scope;
  readonly maxEvents?: number;
};
export type StartOptions = {
  readonly parent?: Span | null;
  readonly follows?: Span | null;
  readonly kind?: number;
  readonly attrs?: Attrs;
  readonly scrub?: Scrub | null;
};
type SpanInit = {
  readonly name: string;
  readonly kind: number;
  readonly attrs: Attrs;
  readonly parent: Span | null;
  readonly follows?: Span | null;
  readonly scrub?: Scrub | null;
};
// A thrown field rendered the way String() renders it (a stack, a message). A string is itself.
const asText = (v: unknown): string => (typeof v === 'string' ? v : String(v));

// `declare` fields: assigned in the constructor, so they emit nothing (the JS is the constructor body as before).
// A span under an authenticated transport carries the transport's `scrub` (http.js), and every child inherits it. At
// export every string (attributes, event attributes, status) passes through it, and `error(e)` scrubs the error object
// itself in place, so neither the trace nor the error the caller catches holds a credential a server echoed back.
export class Span {
  public declare tracer: Tracer;
  public declare traceId: string;
  public declare spanId: string;
  public declare parentSpanId: string | undefined;
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
  public constructor(tracer: Tracer, { name, kind, attrs, parent, follows = null, scrub = null }: SpanInit) {
    if (parent && follows) throw new TypeError('a span has a parent or follows one, not both');
    this.tracer = tracer;
    this.traceId = parent ? parent.traceId : rand(16);
    this.spanId = rand(8);
    this.parentSpanId = parent ? parent.spanId : undefined;
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
    this.scrub = scrub ?? parent?.scrub ?? follows?.scrub ?? null;
    if (follows) { this.link(follows, { 'ply.link': 'follows_from' }); if (!follows.ended) follows.link(this, { 'ply.link': 'followed_by' }); }
  }
  public set(attrs: Attrs): this { Object.assign(this.attrs, attrs); return this; }
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
  public error(e: unknown, type?: unknown): this {
    scrubError(e, this.scrub);
    // a thrown value of any type: the readers are the optional-chained reads, so a primitive or null reads as nothing
    const message = thrownMessage(e);
    const code = thrownCode(e);
    const name = thrownName(e);
    this.status = { code: 2, message: asText(message ?? e) };
    this.set({ 'error.type': type ?? code ?? name ?? 'Error' });
    this.event('exception', { 'exception.type': name ?? 'Error', 'exception.message': asText(message ?? e), 'exception.stacktrace': asText(thrownStack(e) ?? '') });
    return this;
  }
  public ok(): this { if (this.status.code === 0) this.status = { code: 1 }; return this; }
  public end(): this {
    if (this.ended) return this;
    this.ended = true;
    this.ok();
    const s = this.scrub;
    this.tracer.export({
      traceId: this.traceId, spanId: this.spanId, parentSpanId: this.parentSpanId, name: this.name, kind: this.kind,
      startTimeUnixNano: this.start, endTimeUnixNano: now(),
      attributes: s ? scrubKvs(kvs(this.attrs), s) : kvs(this.attrs),
      events: s ? this.events.map(ev => ({ ...ev, attributes: scrubKvs(ev.attributes, s) })) : this.events,
      // oxlint-disable-next-line typescript/strict-boolean-expressions -- as before: an empty status message is left unscrubbed
      links: this.links, status: s && this.status.message ? { ...this.status, message: s(this.status.message) } : this.status,
      droppedAttributesCount: 0, droppedEventsCount: this.droppedEvents, droppedLinksCount: this.droppedLinks,
    });
    return this;
  }
}

export class Tracer {
  public declare exporter: Exporter;
  public declare maxEvents: number;
  public declare resource: { attributes: KeyValue[] };
  public declare scope: Scope;
  public declare count: number;
  public constructor({ exporter = () => { /* spans are dropped */ }, resource = {}, scope = { name: 'ply', version: '0.1.0' }, maxEvents = 256 }: TracerOptions = {}) {
    this.exporter = exporter;
    this.maxEvents = maxEvents;
    this.resource = { attributes: kvs({ 'service.name': 'ply', 'telemetry.sdk.name': 'ply-otel', 'telemetry.sdk.language': 'javascript', ...resource }) };
    this.scope = scope;
    this.count = 0;
  }
  // `follows`: start a span that measures work the caller drives after `follows` returns (a stream it reads, an iterator
  // it drains). It is the root of a trace of its own with a 'follows_from' link to `follows` (and, while `follows` is
  // still open, a 'followed_by' link back), so no child outlives its parent: README "Span lifetimes".
  public start(name: string, { parent = null, follows = null, kind = KIND.INTERNAL, attrs = {}, scrub = null }: StartOptions = {}): Span {
    return new Span(this, { name, kind, attrs, parent, follows, scrub });
  }
  // Run fn(span) with automatic end/status.
  public async span<T>(name: string, opts: StartOptions | undefined, fn: (s: Span) => T | PromiseLike<T>): Promise<T> {
    const s = this.start(name, opts);
    try { const r = await fn(s); s.end(); return r; }
    catch (e) { s.error(e); s.end(); throw e; }
  }
  public export(span: OtlpSpan): void {
    this.count++;
    this.exporter({ resourceSpans: [{ resource: this.resource, scopeSpans: [{ scope: this.scope, spans: [span] }] }] });
  }
}

// ---- exporters ----
export type ArrayExporter = Exporter & { readonly lines: ExportLine[] };
export const arrayExporter = (arr: ExportLine[] = []): ArrayExporter => Object.assign((line: ExportLine) => { arr.push(line); }, { lines: arr });
// the console exporter's default sink is the console; bundle budget: the JS's arrow, byte for byte
// oxlint-disable-next-line no-console, typescript/no-confusing-void-expression -- see above
export const consoleExporter = (log: (s: string) => void = console.log): Exporter => line => log(JSON.stringify(line));
// ---- reading side (pure): flatten a JSONL line back to {name, attrs, events, ...} ----
export type FlatValue = string | number | boolean | readonly FlatValue[];
export type FlatAttrs = Record<string, FlatValue>;
export type FlatSpan = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly name: string;
  readonly kind: number;
  readonly durationMs: number;
  readonly status: Status;
  readonly attrs: FlatAttrs;
  readonly droppedEvents: number;
  readonly events: ReadonlyArray<{ readonly name: string; readonly attrs: FlatAttrs }>;
  readonly links: ReadonlyArray<{ readonly traceId: string; readonly spanId: string; readonly attrs: FlatAttrs }>;
};
export function fromAny(v: AnyValue): FlatValue {
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('boolValue' in v) return v.boolValue;
  if ('arrayValue' in v) return v.arrayValue.values.map(fromAny);
  return v.bytesValue;
}
export const flattenKvs = (list: readonly KeyValue[] | null | undefined): FlatAttrs => Object.fromEntries((list ?? []).map(({ key, value }) => [key, fromAny(value)]));
export function flattenLine(line: ExportLine): FlatSpan[] {
  return line.resourceSpans.flatMap(rs => rs.scopeSpans.flatMap(ss => ss.spans.map(s => ({
    traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId, name: s.name, kind: s.kind,
    durationMs: Number(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1e6,
    status: s.status, attrs: flattenKvs(s.attributes), droppedEvents: s.droppedEventsCount ?? 0,
    events: s.events.map(e => ({ name: e.name, attrs: flattenKvs(e.attributes) })),
    links: (s.links ?? []).map(l => ({ traceId: l.traceId, spanId: l.spanId, attrs: flattenKvs(l.attributes) })),
  }))));
}
