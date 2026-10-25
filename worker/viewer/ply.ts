// ply's library is JavaScript. TypeScript infers an unannotated default as that default's literal
// type (`signal = null` becomes `null`), so legal callers fail to typecheck. These wrappers are the boundary.
import { discover as discoverJs } from '../../src/discover.js';
import { isPlyCode as isPlyCodeJs } from '../../src/errors.js';
import { fetchObject as fetchObjectJs, isFilterRejection as isFilterRejectionJs, packStream as packStreamJs, spFinish as spFinishJs, spInit as spInitJs, spStep as spStepJs } from '../../src/fetch.js';
import { fetchPack as fetchPackJs } from '../../src/fetchpack.js';
import { createTransport as createTransportJs } from '../../src/http.js';
import { inflate as inflateJs } from '../../src/inflate.js';
import { lsRefs as lsRefsJs } from '../../src/lsrefs.js';
import { cachingFetch as cachingFetchJs } from '../../src/packcache.js';
import { Tracer as TracerJs, arrayExporter as arrayExporterJs } from '../../src/otel.js';
import { commitView as commitViewJs, entryType as entryTypeJs, lsMode as lsModeJs, refCandidates as refCandidatesJs } from '../../src/read.js';
import type { FetchLike } from './fetchguard.ts';
import type { ParsedPack } from './packmap.ts';

function loose<T>(fn: unknown): T {
  return fn as T;
}

export type GitTransport = object;

export type ViewerSpan = {
  set: (attrs: Record<string, unknown>) => ViewerSpan;
  end: () => ViewerSpan;
  error: (err: unknown) => ViewerSpan;
};

export type ViewerTracer = {
  start: (name: string, opts?: { parent?: unknown; kind?: number; attrs?: Record<string, unknown> }) => ViewerSpan;
};

export type DiscoverInfo = {
  version: number;
  agent: string;
  objectFormat: string;
  caps: Map<string, string>;
  fetch: string[];
  filter: boolean;
};

export type PackCursor = { phase: string; type: number; size: number };

type Fetched = { type: number; data: Uint8Array; oid: string; size: number };
type CommitView = {
  tree: string | null;
  parents: string[];
  author: { name?: string; email?: string; time?: string | null; tz?: string } | null;
  message: string | null;
  signed: boolean;
};

export function createGitTransport(url: string, opts: {
  tracer: ViewerTracer;
  fetchImpl: FetchLike;
  userAgent: string;
  limits: object;
  signal: AbortSignal;
  quirks: { treeFilter?: 'blob:none' };
}): GitTransport {
  return loose<(url: string, opts: object) => GitTransport>(createTransportJs)(url, opts);
}

export const discoverRepo: (transport: GitTransport) => Promise<DiscoverInfo> = loose(discoverJs);
export const listRefs: (transport: GitTransport, prefixes: string[]) => Promise<{ refs: Map<string, { oid: string; peeled?: string }>; head: string | null }> = loose(lsRefsJs);
export const candidates: (ref: string | null) => string[] = loose(refCandidatesJs);
export const viewCommit: (data: Uint8Array) => CommitView = loose(commitViewJs);
export const treeEntryType: (mode: string) => string = loose(entryTypeJs);
export const treeMode: (mode: string) => string = loose(lsModeJs);
export const readObject: (transport: GitTransport, opts: { oid: string; filter?: string; deepen?: number; expectType?: number | null }) => Promise<Fetched> = loose(fetchObjectJs);
export const readPack: (transport: GitTransport, opts: object, extra?: { resolve?: boolean; attrs?: Record<string, unknown> }) => Promise<{ parsed: ParsedPack | null }> = loose(fetchPackJs);
export const filterRejected: (err: unknown) => boolean = loose(isFilterRejectionJs);
export const streamPack: (transport: GitTransport, opts: object, span: ViewerSpan) => AsyncIterable<Uint8Array> = loose(packStreamJs);
export const cursorInit: () => PackCursor = loose(spInitJs);
export const cursorStep: (cursor: PackCursor, chunk: Uint8Array) => { state: PackCursor; zlib: Uint8Array[] } = loose(spStepJs);
export const cursorFinish: (cursor: PackCursor) => PackCursor = loose(spFinishJs);
export const inflateObject: (buf: Uint8Array, offset: number, opts: { expectedSize: number; maxOutput: number }) => { out: Uint8Array } = loose(inflateJs);
export const plyCode: (code: unknown) => boolean = loose(isPlyCodeJs);

export function spanCollector(): { lines: unknown[]; exporter: (line: unknown) => void } {
  const exporter = loose<() => { lines: unknown[] } & ((line: unknown) => void)>(arrayExporterJs)();
  return { lines: exporter.lines, exporter };
}

export function makeTracer(exporter: (line: unknown) => void, opts: { maxEvents: number; resource: Record<string, string> }): ViewerTracer {
  return new (TracerJs as unknown as new (options: object) => ViewerTracer)({ exporter, maxEvents: opts.maxEvents, resource: opts.resource });
}

export function cachedFetch(inner: FetchLike, cache: object, waitUntil: (promise: Promise<unknown>) => void): FetchLike {
  return loose<(fetchImpl: FetchLike, cache: object, opts: { waitUntil: (promise: Promise<unknown>) => void }) => FetchLike>(cachingFetchJs)(inner, cache, { waitUntil });
}
