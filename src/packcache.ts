// Content-addressed cache for wants-only upload-pack responses (idea from gitgrep's pack-cache: a fetch with wants and
// no haves is a pure function of (url, body) — the object set is immutable and every object is hash-verified on
// arrival, so the response can be cached forever). Wraps a fetch; the cache is anything with the Cache API shape
// (match/put/delete) — `caches.default` on Workers, an in-memory map in tests.
//
// What is cached: POST …/git-upload-pack whose body is a v2 fetch with no `have`, no `want-ref`, no `deepen-since`/
// `deepen-not` (date/ref relative → not a pure function of the body) and a `filter` line. The filter line is the
// size guard: ply's tree:0 commit/tree fetches carry one and are small; the streamed blob fetch carries none.
// The key includes the Authorization header so a private repo's pack is never served to a different credential.
//
// Poison: a cached body that fails verification is evicted and refetched once (`x-ply-cache: bust` from the
// client). The response carries `x-ply-pack-cache: HIT|MISS|BUST` so spans can say which tier served it.
/* oxlint-disable require-unicode-regexp -- ASCII pkt-line text; `u` costs a byte per literal */
import type { Attrs, Loose } from './transport.js';
import type { FetchLike } from './http.js';
import { te, td } from './bytes.js';
import { cacheHeader } from './cachestatus.js';

const CACHE_HEADER = 'x-ply-pack-cache';
export const CACHE_CONTROL_HEADER = 'x-ply-cache';
// Same literals as http.ts. createTransport sets the request header only on a fetchImpl that carries the brand;
// this wrapper strips it so the origin never sees the hint, and copies those response headers into the stored
// response. A HIT then replays them (the span marks http.response.headers.from_cache).
const RECORD_HEADERS_REQUEST = 'x-ply-record-headers';
const CACHING_FETCH_BRAND = 'plyCachingFetch';

export function isCacheableFetch(body: string | Uint8Array): boolean {
  const t: string = typeof body === 'string' ? body : td.decode(body);
  // pkt-lines: each line is 4 hex + payload; match on payloads, anchored to the hex prefix so "have" inside a message can't fool it
  const has = (re: RegExp): boolean => re.test(t);
  return has(/[0-9a-f]{4}command=fetch\n/) && !has(/[0-9a-f]{4}have [0-9a-f]{40}\n/) && !has(/[0-9a-f]{4}want-ref /) && !has(/[0-9a-f]{4}deepen-(since|not) /) && !has(/[0-9a-f]{4}shallow [0-9a-f]{40}\n/) && has(/[0-9a-f]{4}filter /);
}

export async function cacheKey(url: string, auth: string | null | undefined, body: Uint8Array, namespace = 'https://ply.pack/'): Promise<string> {
  const prefix = te.encode(`ply-pack/1\n${url}\n${auth ?? ''}\n`);
  const all = new Uint8Array(prefix.length + body.length); all.set(prefix); all.set(body, prefix.length);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  let hex = ''; for (const b of d) hex += b.toString(16).padStart(2, '0');
  return namespace + hex;
}

// A plain-object header bag is matched case-insensitively. (An array of pairs reads as its indices, as it always has.)
const headerOf = (headers: HeadersInit | undefined, name: string): string | null => headers instanceof Headers ? headers.get(name) : (Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] ?? null);

function peelRecordHeaders(init: RequestInit): { readonly init: RequestInit; readonly names: readonly string[] } {
  const raw = headerOf(init.headers, RECORD_HEADERS_REQUEST);
  if (raw === null || raw === '') return { init, names: [] };
  const names = raw.split(',').map(s => s.trim().toLowerCase()).filter(s => s !== '');
  const headers = new Headers(init.headers);
  headers.delete(RECORD_HEADERS_REQUEST);
  return { init: { ...init, headers }, names };
}

// Anything with the Cache API's shape: `caches.default` on Workers, memoryCache() in tests.
export type PackCache = {
  readonly match: (key: string) => Promise<Response | undefined>;
  readonly put: (key: string, res: Response) => Promise<unknown>;
  readonly delete: (key: string) => Promise<unknown>;
};
export type CachingOptions = {
  readonly waitUntil?: ((p: Promise<unknown>) => void) | null;
  readonly namespace?: string;
  readonly shouldCache?: (body: Uint8Array) => boolean;
  readonly maxAge?: number;
};
export type CacheStats = { hit: number; miss: number; bust: number; bypass: number; putOk: number; putFailed: number; putError: string };
// The fetch ply's HTTP transport calls (http.ts FetchLike), with the cache's counters.
export type CachingFetch = ((url: string | URL, init?: RequestInit) => Promise<Response>) & { stats: CacheStats; attrs: (prefix?: string) => Attrs };

export function cachingFetch(fetchImpl: FetchLike, cache: PackCache, { waitUntil = null, namespace, shouldCache = isCacheableFetch, maxAge = 31_536_000 }: CachingOptions = {}): CachingFetch {
  const inner = fetchImpl === globalThis.fetch ? fetchImpl.bind(globalThis) : fetchImpl;
  const stats: CacheStats = { hit: 0, miss: 0, bust: 0, bypass: 0, putOk: 0, putFailed: 0, putError: '' };
  const f = async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    const { init: wire, names } = peelRecordHeaders(init);
    const body = wire.body;
    if (wire.method !== 'POST' || !String(url).endsWith('/git-upload-pack') || !(body instanceof Uint8Array) || !shouldCache(body)) { stats.bypass++; return inner(url, wire); }
    const mode = headerOf(wire.headers, CACHE_CONTROL_HEADER);
    const key = await cacheKey(String(url), headerOf(wire.headers, 'authorization'), body, namespace);
    // oxlint-disable-next-line unicorn/no-useless-undefined -- a failed delete is ignored
    if (mode === 'bust') { stats.bust++; await cache.delete(key).catch(() => undefined); }
    else {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- a failed match is a miss
      const hit = await cache.match(key).catch(() => undefined);
      if (hit) {
        stats.hit++;
        const h = new Headers(hit.headers); h.set(CACHE_HEADER, cacheHeader('HIT'));
        return new Response(hit.body, { status: 200, headers: h });
      }
    }
    const res = await inner(url, wire);
    const ct = res.headers.get('content-type') ?? '';
    const h = new Headers(res.headers); h.set(CACHE_HEADER, cacheHeader(mode === 'bust' ? 'BUST' : 'MISS'));
    if (!res.ok || !ct.startsWith('application/x-git-upload-pack-result') || !res.body) return new Response(res.body, { status: res.status, headers: h });
    stats.miss++;
    const [toClient, toCache] = res.body.tee();
    const stored = new Headers();
    for (const name of names) { const v = res.headers.get(name); if (v !== null) stored.set(name, v); }
    stored.set('content-type', ct);
    stored.set('cache-control', `public, max-age=${maxAge}, immutable`);
    // The put's fate is observable: a cache that silently refuses to store would otherwise look like a permanent miss rate.
    // oxlint-disable-next-line promise/always-return -- the counters are the outcome; the promise's value is unused (waitUntil)
    const put = cache.put(key, new Response(toCache, { status: 200, headers: stored })).then(() => { stats.putOk++; }, (e: unknown) => { stats.putFailed++; stats.putError = String((e as Loose)?.message ?? e).slice(0, 200); }); // oxlint-disable-line typescript/no-unsafe-type-assertion -- see Loose (transport.ts)
    if (waitUntil) waitUntil(put);
    return new Response(toClient, { status: 200, headers: h });
  };
  Object.defineProperty(f, CACHING_FETCH_BRAND, { value: true });
  f.stats = stats;
  f.attrs = (prefix = 'git.pack.cache') => ({ [`${prefix}.hit`]: stats.hit, [`${prefix}.miss`]: stats.miss, [`${prefix}.bust`]: stats.bust, [`${prefix}.bypass`]: stats.bypass, [`${prefix}.put.ok`]: stats.putOk, [`${prefix}.put.failed`]: stats.putFailed, [`${prefix}.put.error`]: stats.putError });
  return f;
}

// Cache-API-shaped in-memory cache for tests and node. Bodies are buffered; `entries` is exposed so tests can poison one.
export type MemoryCache = PackCache & { readonly entries: Map<string, { body: Uint8Array; headers: Record<string, string> }> };
export function memoryCache(): MemoryCache {
  const entries: MemoryCache['entries'] = new Map();
  return {
    entries,
    // oxlint-disable-next-line require-await, typescript/require-await -- the Cache API's shape: every method returns a promise
    async match(key) { const e = entries.get(key); return e ? new Response(e.body.slice(), { status: 200, headers: e.headers }) : undefined; },
    async put(key, res) { entries.set(key, { body: new Uint8Array(await res.arrayBuffer()), headers: Object.fromEntries(res.headers) }); },
    // oxlint-disable-next-line require-await, typescript/require-await -- as above
    async delete(key) { return entries.delete(key); },
  };
}
