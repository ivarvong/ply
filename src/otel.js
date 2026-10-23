// Minimal OTLP/JSON tracer. One ExportTraceServiceRequest per span per line (JSONL),
// so `grep '"key":"git.pack.objects"' trace.jsonl` works and the same lines can be
// POSTed to any OTLP/HTTP collector unchanged.

// Platform clocks are probed, not type-checked: newer Workers compatibility dates define a `process` global whose
// `hrtime`/`cpuUsage` exist but throw "not implemented" (found under workerd 2026-10-18, compat date 2026-10-18).
const probe = (make, fallback) => { try { const f = make(); f(); return f; } catch { return fallback; } };
const now = probe(() => { const base = BigInt(Date.now()) * 1000000n - process.hrtime.bigint(); return () => (base + process.hrtime.bigint()).toString(); }, () => (BigInt(Date.now()) * 1000000n).toString());

// CPU clock: real on node (process.cpuUsage), null on Workers where no clock advances during synchronous work. Spans
// record cpu_ms only where it is measured; the edge carries calibrated estimates instead (see edit.js CPU_RATE).
export const cpuNow = probe(() => () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }, () => null);
export const cpuSince = t0 => (t0 === null ? null : cpuNow() - t0);

// Isolate-lifetime invocation counter: module scope survives across requests inside one isolate (workerd, node), so the
// first root span of an isolate is the one that paid connection setup, JIT warmup and cache misses.
let invocations = 0;

const rand = n => { const b = new Uint8Array(n); crypto.getRandomValues(b); return Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); };

// OTLP AnyValue encoding (pure)
export function anyValue(v) {
  if (v === null || v === undefined) return { stringValue: '' };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'bigint') return { intValue: v.toString() };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (v instanceof Uint8Array) return { bytesValue: btoa(String.fromCharCode(...v.subarray(0, 4096))) };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(anyValue) } };
  return { stringValue: String(v) }; // objects are stringified: attribute values are scalars or arrays of scalars
}
export const kvs = obj => Object.entries(obj).filter(([, v]) => v !== undefined).map(([key, value]) => ({ key, value: anyValue(value) }));

export const KIND = Object.freeze({ INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 });

export class Tracer {
  constructor({ exporter = () => {}, resource = {}, scope = { name: 'ply', version: '0.1.0' }, maxEvents = 256 } = {}) {
    this.exporter = exporter;
    this.maxEvents = maxEvents;
    this.resource = { attributes: kvs({ 'service.name': 'ply', 'telemetry.sdk.name': 'ply-otel', 'telemetry.sdk.language': 'javascript', ...resource }) };
    this.scope = scope;
    this.count = 0;
  }
  start(name, { parent = null, kind = KIND.INTERNAL, attrs = {} } = {}) {
    return new Span(this, { name, kind, attrs, parent });
  }
  // Run fn(span) with automatic end/status.
  async span(name, opts, fn) {
    const s = this.start(name, opts);
    try { const r = await fn(s); s.end(); return r; }
    catch (e) { s.error(e); s.end(); throw e; }
  }
  export(span) {
    this.count++;
    this.exporter({ resourceSpans: [{ resource: this.resource, scopeSpans: [{ scope: this.scope, spans: [span] }] }] });
  }
}

export class Span {
  constructor(tracer, { name, kind, attrs, parent }) {
    this.tracer = tracer;
    this.traceId = parent ? parent.traceId : rand(16);
    this.spanId = rand(8);
    this.parentSpanId = parent ? parent.spanId : undefined;
    this.name = name;
    this.kind = kind;
    this.start = now();
    this.attrs = { ...attrs };
    if (!parent) { invocations++; this.attrs['ply.isolate.invocation'] = invocations; this.attrs['ply.isolate.cold'] = invocations === 1; }
    this.events = [];
    this.links = [];
    this.droppedEvents = 0;
    this.status = { code: 0 };
    this.ended = false;
  }
  set(attrs) { Object.assign(this.attrs, attrs); return this; }
  // Bounded: a pack with 10k objects must not produce a 10k-event span. The count of dropped events is exported.
  event(name, attrs = {}) {
    if (this.events.length >= this.tracer.maxEvents) { this.droppedEvents++; return this; }
    this.events.push({ name, timeUnixNano: now(), attributes: kvs(attrs) }); return this;
  }
  // OTLP span link: a causal relation to a span that is not the parent (e.g. the attempt this one retries).
  link(span, attrs = {}) { this.links.push({ traceId: span.traceId, spanId: span.spanId, attributes: kvs(attrs) }); return this; }
  error(e, type) {
    this.status = { code: 2, message: String(e?.message ?? e) };
    this.set({ 'error.type': type ?? e?.code ?? e?.name ?? 'Error' });
    this.event('exception', { 'exception.type': e?.name ?? 'Error', 'exception.message': String(e?.message ?? e), 'exception.stacktrace': String(e?.stack ?? '') });
    return this;
  }
  ok() { if (this.status.code === 0) this.status = { code: 1 }; return this; }
  end() {
    if (this.ended) return this;
    this.ended = true;
    this.ok();
    this.tracer.export({
      traceId: this.traceId, spanId: this.spanId, parentSpanId: this.parentSpanId, name: this.name, kind: this.kind,
      startTimeUnixNano: this.start, endTimeUnixNano: now(),
      attributes: kvs(this.attrs), events: this.events, links: this.links, status: this.status,
      droppedAttributesCount: 0, droppedEventsCount: this.droppedEvents, droppedLinksCount: 0,
    });
    return this;
  }
}

// ---- exporters ----
export const arrayExporter = (arr = []) => Object.assign(line => { arr.push(line); }, { lines: arr });
export const consoleExporter = (log = console.log) => line => log(JSON.stringify(line));
// ---- reading side (pure): flatten a JSONL line back to {name, attrs, events, ...} ----
export function fromAny(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('boolValue' in v) return v.boolValue;
  if ('arrayValue' in v) return v.arrayValue.values.map(fromAny);
  return v.bytesValue;
}
export const flattenKvs = list => Object.fromEntries((list ?? []).map(({ key, value }) => [key, fromAny(value)]));
export function flattenLine(line) {
  return line.resourceSpans.flatMap(rs => rs.scopeSpans.flatMap(ss => ss.spans.map(s => ({
    traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId, name: s.name, kind: s.kind,
    durationMs: Number(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1e6,
    status: s.status, attrs: flattenKvs(s.attributes), droppedEvents: s.droppedEventsCount ?? 0,
    events: s.events.map(e => ({ name: e.name, attrs: flattenKvs(e.attributes) })),
    links: (s.links ?? []).map(l => ({ traceId: l.traceId, spanId: l.spanId, attrs: flattenKvs(l.attributes) })),
  }))));
}
