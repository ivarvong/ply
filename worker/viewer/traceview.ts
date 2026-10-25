import { fromAny } from '../../src/otel.js';
import type { FilterName, TraceBar, TraceModel } from './model.ts';

type Kv = { key: string; value: unknown };

type RawSpan = {
  name: string;
  startMs: number;
  durMs: number;
  status: 'ok' | 'error';
  message: string;
  attrs: Record<string, unknown>;
};

const SHOW = [
  'http.response.status_code', 'git.response.bytes', 'git.response.cache', 'git.response.duration_ms',
  'git.fetch.filter', 'git.fetch.filter.requested', 'git.fetch.filter.fallback', 'git.fetch.filter.learned',
  'git.fetch.wants', 'git.fetch.haves.count', 'git.fetch.deepen', 'git.fetch.thin_pack', 'git.fetch.ofs_delta',
  'git.server.agent', 'git.server.object_format', 'git.server.caps', 'git.server.fetch', 'git.protocol.version',
  'git.pkt.frames', 'git.pkt.data', 'git.pkt.flush', 'git.pkt.delim', 'git.pkt.bytes', 'git.pkt.payload.max',
  'git.sideband.band1.bytes', 'git.sideband.band2.bytes', 'git.sideband.band3.bytes', 'git.sideband.progress.tail',
  'git.pack.objects', 'git.pack.bytes', 'git.pack.ofs_delta', 'git.pack.ref_delta', 'git.pack.chain.max', 'git.pack.trailer',
  'git.pack.full', 'git.fetch.wide.objects', 'git.fetch.wide.extra_bytes', 'git.fetch.wide.blobs',
  'git.ls_refs.count', 'git.ls_refs.head', 'error.type', 'git.viewer.blob.too_big', 'git.viewer.blob.size',
] as const;

function flattenAttrs(list: Kv[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of list ?? []) out[entry.key] = fromAny(entry.value);
  return out;
}

function spansOf(lines: unknown[]): RawSpan[] {
  const spans: RawSpan[] = [];
  for (const line of lines) {
    const resourceSpans = (line as { resourceSpans?: { scopeSpans?: { spans?: Record<string, unknown>[] }[] }[] }).resourceSpans ?? [];
    for (const resource of resourceSpans) {
      for (const scope of resource.scopeSpans ?? []) {
        for (const span of scope.spans ?? []) {
          const start = BigInt(String(span.startTimeUnixNano ?? '0'));
          const end = BigInt(String(span.endTimeUnixNano ?? start));
          const status = span.status as { code?: number; message?: string } | undefined;
          spans.push({
            name: String(span.name ?? ''),
            startMs: Number(start / 1_000_000n),
            durMs: Math.max(0, Number((end - start) / 1_000_000n)),
            status: status?.code === 2 ? 'error' : 'ok',
            message: String(status?.message ?? '').slice(0, 180),
            attrs: flattenAttrs(span.attributes as Kv[] | undefined),
          });
        }
      }
    }
  }
  spans.sort((a, b) => a.startMs - b.startMs || a.name.localeCompare(b.name));
  return spans;
}

function summarise(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length > 8) return `${value.length} items`;
    return value.map(item => summarise(item)).join(' ');
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function wantOf(attrs: Record<string, unknown>): string | null {
  const wants = attrs['git.fetch.wants'];
  const first = Array.isArray(wants) ? wants[0] : wants;
  return typeof first === 'string' && /^[0-9a-f]{40}$/.test(first) ? first : null;
}

function filterOf(attrs: Record<string, unknown>): FilterName | null {
  const fallback = attrs['git.fetch.filter.fallback'];
  const filter = typeof fallback === 'string' && fallback ? fallback : attrs['git.fetch.filter'];
  if (filter === 'tree:0' || filter === 'blob:none') return filter;
  return null;
}

function linesFor(span: RawSpan): string[] {
  const lines: string[] = [];
  for (const key of SHOW) {
    const value = span.attrs[key];
    if (value === undefined || value === '' || value === null) continue;
    lines.push(`${key}=${summarise(value)}`);
  }
  if (span.status === 'error' && span.message) lines.push(`error=${span.message}`);
  return lines;
}

function isRoundTrip(name: string): boolean {
  return name.startsWith('git.upload-pack') || name.startsWith('git.receive-pack');
}

export function buildTrace(lines: unknown[], cfRay: string, requestId: string): TraceModel {
  const raw = spansOf(lines);
  const trips = raw.filter(span => isRoundTrip(span.name));
  const shown = trips.length ? trips : raw;
  const bars: TraceBar[] = shown.map(span => {
    const http = span.attrs['http.response.status_code'];
    const bytes = span.attrs['git.response.bytes'];
    const cache = span.attrs['git.response.cache'];
    const fetch = span.name === 'git.upload-pack fetch';
    return {
      name: span.name,
      startMs: span.startMs,
      durMs: span.durMs,
      status: span.status,
      httpStatus: typeof http === 'number' ? http : null,
      bytes: typeof bytes === 'number' ? bytes : null,
      cache: typeof cache === 'string' ? cache : '',
      lines: linesFor(span),
      packWant: fetch ? wantOf(span.attrs) : null,
      packFilter: fetch ? filterOf(span.attrs) : null,
    };
  });
  const start = bars.reduce((min, bar) => Math.min(min, bar.startMs), bars[0]?.startMs ?? 0);
  const end = bars.reduce((max, bar) => Math.max(max, bar.startMs + bar.durMs), start);
  return { bars: bars.map(bar => ({ ...bar, startMs: bar.startMs - start })), totalMs: Math.max(0, end - start), cfRay, requestId };
}

export function traceHeader(trace: TraceModel): string {
  const parts = trace.bars.slice(0, 16).map(bar => {
    const name = bar.name.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'span';
    return `${name};dur=${Math.round(bar.durMs)}`;
  });
  return parts.join(', ').slice(0, 1500);
}
