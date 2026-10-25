// Public viewer entry. No PLY_TOKEN, no git credential, no /v1 handler. Rate limit runs before any git fetch.
// This module does not import rate.ts: node tests must not load cloudflare:workers. The Worker re-exports the class.
import { createBudget } from './budget.ts';
import { VIEWER_CSS } from './css.ts';
import { safeFilename } from './escape.ts';
import { createViewerFetch, type FetchLike } from './fetchguard.ts';
import { renderError, renderHome, renderLoaded } from './html.ts';
import { VIEWER_CAPS, rateLimitFor, type RateBucket } from './limits.ts';
import type { RateDecision, TraceModel, ViewerEnv } from './model.ts';
import { parseViewerRoute, routeOptsFromEnv, type ViewerRoute } from './route.ts';
import { cachedFetch, makeTracer, plyCode, spanCollector } from './ply.ts';
import { VIEWER_CSP } from './script.ts';
import { loadRepo } from './session.ts';
import { buildTrace, traceHeader } from './traceview.ts';

const STATUS: Record<string, number> = {
  bad_request: 400, unsupported: 501, network: 502, timeout: 504, aborted: 499, http: 502, auth: 401, not_found: 404,
  rate_limited: 429, upstream_5xx: 502, not_git: 502, ssh: 502, host_key_mismatch: 502, protocol: 502, pack_corrupt: 502,
  remote_error: 502, limit_exceeded: 413, match_count: 422, lfs_pointer: 422, cas_conflict: 409, push_rejected: 409,
  merge_conflict: 409, not_fast_forward: 409, not_linear: 422, unrelated_histories: 422, ambiguous: 502, internal: 500,
};

const CSP = VIEWER_CSP;

const SECURITY = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
  'content-security-policy': CSP,
  'cross-origin-resource-policy': 'same-origin',
};

type EdgeSpan = { setAttribute?: (key: string, value: string | number | boolean) => void; end?: () => void };

type ViewerCtx = {
  waitUntil?: (promise: Promise<unknown>) => void;
  tracing?: { enterSpan?: (name: string) => EdgeSpan };
};

export type HandleOpts = {
  requestId?: string;
  fetchImpl?: FetchLike;
  now?: number;
  note?: (extra: Record<string, string | number>) => void;
  cache?: { match: (key: string) => Promise<Response | undefined>; put: (key: string, res: Response) => Promise<void>; delete: (key: string) => Promise<boolean> } | null;
};

const EMPTY: TraceModel = { bars: [], totalMs: 0, cfRay: '', requestId: '' };

function statusOf(err: { code?: string; status?: number }): number {
  if (err?.code === 'auth' && (err.status === 401 || err.status === 403)) return err.status;
  return STATUS[err?.code ?? ''] ?? 500;
}

function htmlResponse(status: number, body: string, trace: TraceModel, requestId: string, extra: Record<string, string> = {}): Response {
  const timing = [`total;dur=${Math.max(0, trace.totalMs)}`, traceHeader(trace)].filter(Boolean).join(', ').slice(0, 1800);
  const headers = new Headers({
    ...SECURITY,
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-ply-request-id': requestId,
    'server-timing': timing,
    'x-ply-trace': traceHeader(trace),
    ...extra,
  });
  return new Response(body, { status, headers });
}

function edgeSpan(ctx: ViewerCtx): EdgeSpan | null {
  try { return ctx.tracing?.enterSpan?.('ply.viewer') ?? null; }
  catch { return null; }
}

async function clientKey(req: Request): Promise<string> {
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ply-viewer-rate/1\n${ip}`));
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

async function admit(req: Request, env: ViewerEnv, bucket: RateBucket, now: number): Promise<RateDecision | 'unconfigured' | 'unavailable'> {
  const ns = env.VIEWER_RATE;
  if (!ns) return 'unconfigured';
  try {
    const stub = ns.get(ns.idFromName(await clientKey(req)));
    return await stub.admit(bucket, now, rateLimitFor(bucket, bucket === 'pack' ? env.VIEWER_PACK_RATE_PER_MIN : env.VIEWER_RATE_PER_MIN), VIEWER_CAPS.rateWindowMs);
  } catch {
    return 'unavailable';
  }
}

function defaultCache(): HandleOpts['cache'] {
  const g = globalThis as { caches?: { default?: HandleOpts['cache'] } };
  return g.caches?.default ?? null;
}

function isText(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; }
  catch { return false; }
}

export async function handleViewer(req: Request, env: ViewerEnv, ctx: ViewerCtx = {}, opts: HandleOpts = {}): Promise<Response> {
  const requestId = opts.requestId ?? crypto.randomUUID();
  const cfRay = req.headers.get('cf-ray') ?? '';
  const url = new URL(req.url);
  const span = edgeSpan(ctx);
  const finish = (res: Response, fields: Record<string, string | number | boolean>) => {
    try {
      for (const [key, value] of Object.entries(fields)) span?.setAttribute?.(key, value);
      span?.end?.();
    } catch { /* tracing is optional */ }
    return res;
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return finish(new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8', ...SECURITY } }), { 'http.status_code': 405 });
  }
  let route: ViewerRoute;
  try {
    route = parseViewerRoute(url, routeOptsFromEnv(env));
  } catch (err) {
    const code = plyCode((err as { code?: string })?.code) ? (err as { code: string }).code : 'bad_request';
    const message = code === 'internal' ? 'The viewer hit an internal error.' : String((err as { message?: string })?.message ?? err).slice(0, 500);
    const trace = { ...EMPTY, cfRay, requestId };
    opts.note?.({ code, status: statusOf(err as { code?: string }) });
    const res = htmlResponse(statusOf({ code }), renderError(statusOf({ code }), code, message, trace), trace, requestId);
    return finish(req.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res, { 'http.status_code': res.status, 'error.type': code });
  }
  if (route.kind === 'css') {
    const res = new Response(req.method === 'HEAD' ? null : VIEWER_CSS, { status: 200, headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=3600', ...SECURITY, 'x-ply-request-id': requestId } });
    return finish(res, { 'http.status_code': 200, 'ply.viewer.route': 'css' });
  }
  const bucket: RateBucket = route.kind === 'repo' && route.pack ? 'pack' : 'page';
  const decision = await admit(req, env, bucket, opts.now ?? Date.now());
  if (decision === 'unconfigured' || decision === 'unavailable') {
    const trace = { ...EMPTY, cfRay, requestId };
    const message = decision === 'unconfigured' ? 'The viewer rate limiter is not configured.' : 'The viewer rate limiter is unavailable.';
    opts.note?.({ code: 'rate_unavailable', status: 503 });
    const res = htmlResponse(503, renderError(503, 'unavailable', message, trace), trace, requestId);
    return finish(req.method === 'HEAD' ? new Response(null, { status: 503, headers: res.headers }) : res, { 'http.status_code': 503 });
  }
  if (!decision.ok) {
    const retry = String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
    const trace = { ...EMPTY, cfRay, requestId };
    opts.note?.({ code: 'rate_limited', status: 429 });
    const res = htmlResponse(429, renderError(429, 'rate_limited', `Too many viewer requests. Retry after ${retry}s.`, trace), trace, requestId, { 'retry-after': retry });
    return finish(req.method === 'HEAD' ? new Response(null, { status: 429, headers: res.headers }) : res, { 'http.status_code': 429 });
  }
  if (route.kind === 'home') {
    const trace = { ...EMPTY, cfRay, requestId };
    const res = htmlResponse(200, renderHome(null), trace, requestId);
    return finish(req.method === 'HEAD' ? new Response(null, { status: 200, headers: res.headers }) : res, { 'http.status_code': 200, 'ply.viewer.route': 'home' });
  }
  if (route.kind === 'redirect') {
    const res = new Response(null, { status: 302, headers: { location: route.location, 'cache-control': 'no-store', ...SECURITY, 'x-ply-request-id': requestId } });
    return finish(res, { 'http.status_code': 302 });
  }
  const collected = spanCollector();
  const tracer = makeTracer(collected.exporter, { maxEvents: 48, resource: { 'service.name': 'ply-viewer' } });
  const budget = createBudget();
  const pageSignal = AbortSignal.timeout(VIEWER_CAPS.pageTimeoutMs);
  const guard = createViewerFetch(opts.fetchImpl ?? globalThis.fetch, route.loc.url, route.loc.allowedHosts, budget, pageSignal);
  const cache = opts.cache === undefined ? (env.PACK_CACHE === 'off' ? null : defaultCache()) : opts.cache;
  const fetchImpl = cache ? cachedFetch(guard, cache, promise => { try { ctx.waitUntil?.(promise); } catch { /* already settled */ } }) : guard;
  try {
    const loaded = await loadRepo(route, { tracer, fetchImpl, signal: pageSignal, budget });
    const trace = buildTrace(collected.lines, cfRay, requestId);
    opts.note?.({ host: route.loc.host, rtt: trace.bars.length, bytes: budget.bytes, code: 'ok' });
    if (loaded.kind === 'raw') {
      const text = isText(loaded.bytes);
      const headers = new Headers({
        ...SECURITY,
        'content-type': text ? 'text/plain; charset=utf-8' : 'application/octet-stream',
        'content-disposition': `${text ? 'inline' : 'attachment'}; filename="${safeFilename(loaded.filename)}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-ply-request-id': requestId,
        'x-ply-trace': traceHeader(trace),
      });
      const copy = new ArrayBuffer(loaded.bytes.byteLength);
      new Uint8Array(copy).set(loaded.bytes);
      const res = new Response(req.method === 'HEAD' ? null : new Blob([copy]), { status: 200, headers });
      return finish(res, { 'http.status_code': 200, 'ply.viewer.route': 'raw', 'server.address': route.loc.host });
    }
    const res = htmlResponse(200, renderLoaded(loaded, trace), trace, requestId);
    return finish(req.method === 'HEAD' ? new Response(null, { status: 200, headers: res.headers }) : res, {
      'http.status_code': 200,
      'ply.viewer.route': loaded.kind,
      'server.address': route.loc.host,
      'ply.viewer.ref': loaded.header.ref,
      'ply.viewer.upstream_spans': trace.bars.length,
    });
  } catch (err) {
    const code = plyCode((err as { code?: string })?.code) ? (err as { code: string }).code : 'internal';
    const status = statusOf(err as { code?: string; status?: number });
    const message = code === 'internal' ? 'The viewer hit an internal error.' : String((err as { message?: string })?.message ?? err).slice(0, 500);
    const trace = buildTrace(collected.lines, cfRay, requestId);
    opts.note?.({ host: route.loc.host, code, status, rtt: trace.bars.length });
    const res = htmlResponse(code === 'internal' ? 500 : status, renderError(code === 'internal' ? 500 : status, code, message, trace, route.loc.host, route.loc.repoPath, route.ref), trace, requestId);
    return finish(req.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res, { 'http.status_code': res.status, 'error.type': code, 'server.address': route.loc.host });
  }
}
