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
import { te } from './bytes.js';

const CACHE_HEADER = 'x-ply-pack-cache';
export const CACHE_CONTROL_HEADER = 'x-ply-cache';

export function isCacheableFetch(body) {
  const t = typeof body === 'string' ? body : new TextDecoder().decode(body);
  // pkt-lines: each line is 4 hex + payload; match on payloads, anchored to the hex prefix so "have" inside a message can't fool it
  const has = re => re.test(t);
  return has(/[0-9a-f]{4}command=fetch\n/) && !has(/[0-9a-f]{4}have [0-9a-f]{40}\n/) && !has(/[0-9a-f]{4}want-ref /) && !has(/[0-9a-f]{4}deepen-(since|not) /) && !has(/[0-9a-f]{4}shallow [0-9a-f]{40}\n/) && has(/[0-9a-f]{4}filter /);
}

export async function cacheKey(url, auth, body, namespace = 'https://ply.pack/') {
  const prefix = te.encode(`ply-pack/1\n${url}\n${auth ?? ''}\n`);
  const all = new Uint8Array(prefix.length + body.length); all.set(prefix); all.set(body, prefix.length);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  let hex = ''; for (const b of d) hex += b.toString(16).padStart(2, '0');
  return namespace + hex;
}

const headerOf = (headers, name) => headers instanceof Headers ? headers.get(name) : (Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] ?? null);

export function cachingFetch(fetchImpl, cache, { waitUntil = null, namespace, shouldCache = isCacheableFetch, maxAge = 31536000 } = {}) {
  const inner = fetchImpl === globalThis.fetch ? fetchImpl.bind(globalThis) : fetchImpl;
  const stats = { hit: 0, miss: 0, bust: 0, bypass: 0, putOk: 0, putFailed: 0, putError: '' };
  const f = async (url, init = {}) => {
    const body = init.body;
    if (init.method !== 'POST' || !String(url).endsWith('/git-upload-pack') || !(body instanceof Uint8Array) || !shouldCache(body)) { stats.bypass++; return inner(url, init); }
    const mode = headerOf(init.headers, CACHE_CONTROL_HEADER);
    const key = await cacheKey(String(url), headerOf(init.headers, 'authorization'), body, namespace);
    if (mode === 'bust') { stats.bust++; await cache.delete(key).catch(() => {}); }
    else {
      const hit = await cache.match(key).catch(() => undefined);
      if (hit) {
        stats.hit++;
        const h = new Headers(hit.headers); h.set(CACHE_HEADER, 'HIT');
        return new Response(hit.body, { status: 200, headers: h });
      }
    }
    const res = await inner(url, init);
    const ct = res.headers.get('content-type') ?? '';
    const h = new Headers(res.headers); h.set(CACHE_HEADER, mode === 'bust' ? 'BUST' : 'MISS');
    if (!res.ok || !ct.startsWith('application/x-git-upload-pack-result') || !res.body) return new Response(res.body, { status: res.status, headers: h });
    stats.miss++;
    const [toClient, toCache] = res.body.tee();
    // The put's fate is observable: a cache that silently refuses to store would otherwise look like a permanent miss rate.
    const put = cache.put(key, new Response(toCache, { status: 200, headers: { 'content-type': ct, 'cache-control': `public, max-age=${maxAge}, immutable` } })).then(() => { stats.putOk++; }, e => { stats.putFailed++; stats.putError = String(e?.message ?? e).slice(0, 200); });
    if (waitUntil) waitUntil(put);
    return new Response(toClient, { status: 200, headers: h });
  };
  f.stats = stats;
  f.attrs = (prefix = 'git.pack.cache') => ({ [`${prefix}.hit`]: stats.hit, [`${prefix}.miss`]: stats.miss, [`${prefix}.bust`]: stats.bust, [`${prefix}.bypass`]: stats.bypass, [`${prefix}.put.ok`]: stats.putOk, [`${prefix}.put.failed`]: stats.putFailed, [`${prefix}.put.error`]: stats.putError });
  return f;
}

// Cache-API-shaped in-memory cache for tests and node. Bodies are buffered; `entries` is exposed so tests can poison one.
export function memoryCache() {
  const entries = new Map();
  return {
    entries,
    async match(key) { const e = entries.get(key); return e ? new Response(e.body.slice(), { status: 200, headers: e.headers }) : undefined; },
    async put(key, res) { entries.set(key, { body: new Uint8Array(await res.arrayBuffer()), headers: Object.fromEntries(res.headers) }); },
    async delete(key) { return entries.delete(key); },
  };
}
