// Content-addressed cache for wants-only upload-pack responses (idea from gitgrep's pack-cache: a fetch with wants and
// no haves is a pure function of (url, body) — the object set is immutable and every object is hash-verified on
// arrival, so the response can be cached forever). Wraps a fetch; the cache is anything with the Cache API shape
// (match/put/delete) — `caches.default` on Workers, an in-memory map in tests.
//
// What is pure (exchangeKind 'pack'): POST …/git-upload-pack whose body parses (uprequest.ts parseUploadPackRequest) as
// a v2 fetch of exact oids with `done` and no `have`, `want-ref`, `shallow`, `deepen-since`/`deepen-not`/`deepen-relative`
// (date/ref/boundary relative → not a pure function of the body), `include-tag` (the tags depend on the refs),
// `packfile-uris`, `sideband-all` or `server-option`. ls-refs ('refs') and the advertisement ('discover') are the
// freshness source and never pure.
// What is cached by default: a pure fetch with a `filter` line (isCacheableFetch). The filter line is the size guard:
// ply's tree:0 commit/tree fetches carry one and are small; the streamed blob fetch carries none. With
// `verifyBeforeStore`, every pure fetch is cached.
// The key includes the Authorization header so a private repo's pack is never served to a different credential.
//
// What is stored, under either rule: only an answer verifyFetchAnswer accepted for the key's own request (a complete,
// successful answer: no ERR, a packfile section, the pack trailer, every want present). An in-band error, a cut answer
// or a lie is handed to the client and never stored, so one failed exchange is not replayed as a hit.
// What is served: the store is untrusted. A stored entry goes through the same check before it is a HIT; one that
// fails is evicted and the origin is asked instead (`x-ply-pack-cache: BUST`, counted in stats.bust). The client's own
// retry (`x-ply-cache: bust` after a HIT its checks refuse) stays as the second line.
// The response carries `x-ply-pack-cache: HIT|MISS|BUST` so spans can say which tier served it.
/* oxlint-disable import/max-dependencies -- the cache joins the request parser, the response reader and the pack resolver */
import type { Attrs } from './transport.js';
import type { FetchLike } from './http.js';
import type { Input } from './absent.js';
import type { LimitsInput } from './limits.js';
import type { PlyError } from './errors.js';
import type { FetchRequest } from './uprequest.js';
import type { Option, Result } from './result.js';
import { te, concat } from './bytes.js';
import { fail } from './errors.js';
import { DEFAULT_LIMITS, limitExceeded, parseLimits } from './limits.js';
import { pktInit, pktStep, pktFinish } from './pktline.js';
import { v2Init, v2Step, v2End } from './fetch.js';
import { parsePack, resolvePack, packParseOpts } from './packresolve.js';
import { parseUploadPackRequest } from './uprequest.js';
import { TYPE } from './objects.js';
import { cacheHeader } from './cachestatus.js';
import { fromNullish, mapGet, readKey, unwrapOrAbsent, withDefaults } from './absent.js';
import { err, getOrElse, mapOption, none, ok } from './result.js';
import { thrownText } from './boundary.js';

const CACHE_HEADER = 'x-ply-pack-cache';
export const CACHE_CONTROL_HEADER = 'x-ply-cache';
// Same literals as http.ts. createTransport sets the request header only on a fetchImpl that carries the brand;
// this wrapper strips it so the origin never sees the hint, and copies those response headers into the stored
// response. A HIT then replays them (the span marks http.response.headers.from_cache).
const RECORD_HEADERS_REQUEST = 'x-ply-record-headers';
const CACHING_FETCH_BRAND = 'plyCachingFetch';

export type { FetchRequest, LsRefsRequest, UploadPackRequest } from './uprequest.js';
export { parseUploadPackRequest } from './uprequest.js';

// A fetch whose answer is a function of its body: exact oids, no negotiation, nothing relative to the refs or to a
// shallow boundary the client holds, nothing the server may add from outside the object graph.
export const isPureFetch = (r: FetchRequest): boolean =>
  r.wants.length > 0 && r.done && r.haves.length === 0 && r.wantRefs.length === 0 && r.shallows.length === 0 && r.deepenSince === 0 &&
  r.deepenNot.length === 0 && !r.deepenRelative && !r.includeTag && r.packfileUris === '' && !r.sidebandAll && !r.caps.some(c => c.startsWith('server-option='));

const bodyBytes = (body: string | Uint8Array): Uint8Array => (typeof body === 'string' ? te.encode(body) : body);
const pureFetchOf = (body: string | Uint8Array): FetchRequest | null => {
  const r = parseUploadPackRequest(bodyBytes(body));
  return r.ok && r.value.command === 'fetch' && isPureFetch(r.value) ? r.value : null;
};

// The default cache rule: a pure fetch with a filter line (the size guard above).
export function isCacheableFetch(body: string | Uint8Array): boolean {
  const r = pureFetchOf(body);
  return r !== null && r.filter !== '';
}

// What one smart-HTTP exchange is: 'pack' (a pure fetch: cacheable forever), 'refs' (ls-refs), 'discover' (the
// upload-pack advertisement), or null (a negotiation, receive-pack, anything else: not classified, never cached).
export type ExchangeKind = 'pack' | 'refs' | 'discover';
export function exchangeKind(method: string, url: string | URL, body: string | Uint8Array | null): ExchangeKind | null {
  const u = String(url);
  const q = u.indexOf('?');
  const path = q < 0 ? u : u.slice(0, q);
  const query = q < 0 ? '' : u.slice(q + 1);
  const m = method.toUpperCase();
  if (m === 'GET' && path.endsWith('/info/refs')) return query.split('&').includes('service=git-upload-pack') ? 'discover' : null;
  if (m !== 'POST' || !path.endsWith('/git-upload-pack') || body === null) return null;
  const r = parseUploadPackRequest(bodyBytes(body));
  if (!r.ok) return null;
  if (r.value.command === 'ls-refs') return 'refs';
  return isPureFetch(r.value) ? 'pack' : null;
}

// The whole check a buffered answer to a pure fetch must pass before it is stored as immutable: framed as pkt-lines,
// read as a v2 fetch response, its pack parsed (trailer SHA-1) and delta-resolved (every object hashed: an object is
// known only by the oid its bytes hash to), every want present, and the deepen contract kept (no shallow-info without
// a deepen; every shallow boundary a commit of the pack; no unshallow for a client that sent no shallow).
const noBase = (): null => null;
export type VerifiedAnswer = { readonly objects: number };
// oxlint-disable-next-line complexity -- one check per clause of the contract above
export function verifyFetchAnswer(request: FetchRequest, answer: Uint8Array, given: LimitsInput = DEFAULT_LIMITS): Result<VerifiedAnswer, PlyError> {
  const checked = parseLimits(given);
  if (!checked.ok) return checked;
  const limits = checked.value;
  const read = pktStep(pktInit(), answer);
  if (!read.ok) return read;
  const fin = pktFinish(read.value.state);
  if (!fin.ok) return fin;
  let st = v2Init(limits);
  const parts: Uint8Array[] = [];
  for (const f of read.value.frames) {
    const r = v2Step(st, f);
    if (!r.ok) return r;
    st = r.value.state;
    if (r.value.pack) parts.push(r.value.pack);
  }
  const end = v2End(st);
  if (!end.ok) return end;
  if (st.phase !== 'pack') return fail('protocol', 'answer: no packfile section');
  const opts = packParseOpts(limits);
  if (!opts.ok) return opts;
  const parsed = parsePack(concat(parts), opts.value);
  if (!parsed.ok) return parsed;
  const resolved = resolvePack(parsed.value, noBase, limits);
  if (!resolved.ok) return resolved;
  const objects = resolved.value.objects;
  for (const w of request.wants) if (!objects.has(w.toLowerCase())) return fail('pack_corrupt', `answer: want ${w} is not in the pack (${objects.size} objects)`);
  if (request.deepen === 0 && st.shallow.length > 0) return fail('pack_corrupt', 'answer: shallow-info for a request without deepen');
  for (const s of st.shallow) {
    const o = mapGet(objects, s.toLowerCase());
    if (o.tag === 'none' || o.value.type !== TYPE.COMMIT) return fail('pack_corrupt', `answer: shallow ${s} is not a commit of the pack`);
  }
  if (request.shallows.length === 0 && st.unshallow.length > 0) return fail('pack_corrupt', 'answer: unshallow for a request without shallow');
  return ok({ objects: objects.size });
}

// The cache branch of a tee, read whole (verifyBeforeStore), or refused once it outgrows what any answer v2Step would
// accept: maxPackBytes of pack and as much progress, plus framing.
async function readCapped(body: ReadableStream<Uint8Array>, cap: number): Promise<Result<Uint8Array<ArrayBuffer>, PlyError>> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // A stream that fails part way (the origin dropped, a cache read broke) is a refusal, never a rejection: the store
    // runs unawaited beside the client's own branch.
    // oxlint-disable-next-line no-await-in-loop -- one stream, read in order
    const step = await reader.read().then((r): Result<ReadableStreamReadResult<Uint8Array>, PlyError> => ok(r), (e: unknown): Result<ReadableStreamReadResult<Uint8Array>, PlyError> => fail('protocol', `answer: the body failed while it was read: ${thrownText(e).slice(0, 200)}`));
    if (!step.ok) return step;
    const { value, done } = step.value;
    if (done) return ok(concat(parts));
    total += value.length;
    // oxlint-disable-next-line no-await-in-loop -- the loop ends here
    if (total > cap) { await reader.cancel().catch(() => null); return err(limitExceeded('cached answer bytes', total, cap)); }
    parts.push(value);
  }
}

const NAMESPACE = 'https://ply.pack/';
// `auth` null (or left out by a JS caller) is no Authorization header: the empty string in the key.
export async function cacheKey(url: string, auth: string | null, body: Uint8Array, namespace: string = NAMESPACE): Promise<string> {
  const prefix = te.encode(`ply-pack/1\n${url}\n${getOrElse(fromNullish(auth), '')}\n`);
  const all = new Uint8Array(prefix.length + body.length); all.set(prefix); all.set(body, prefix.length);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  let hex = ''; for (const b of d) hex += b.toString(16).padStart(2, '0');
  return namespace + hex;
}

// A plain-object header bag is matched case-insensitively. (An array of pairs reads as its indices, as it always has.)
const headerOf = (given: Option<HeadersInit>, name: string): string | null => {
  if (given.tag === 'none') return null;
  const headers = given.value;
  if (headers instanceof Headers) return headers.get(name);
  const hit = Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase());
  // oxlint-disable-next-line typescript/no-unsafe-return -- Object.entries of the HeadersInit union is [string, any]: a matching key is a plain bag's, whose values are strings (an array's keys are indices, never a header name)
  return hit ? getOrElse(fromNullish(hit[1]), null) : null;
};
const headersOf = (init: RequestInit): Option<HeadersInit> => readKey(init, 'headers');

function peelRecordHeaders(init: RequestInit): { readonly init: RequestInit; readonly names: readonly string[] } {
  const raw = headerOf(headersOf(init), RECORD_HEADERS_REQUEST);
  if (raw === null || raw === '') return { init, names: [] };
  const names = raw.split(',').map(s => s.trim().toLowerCase()).filter(s => s !== '');
  const headers = new Headers(init.headers);
  headers.delete(RECORD_HEADERS_REQUEST);
  return { init: { ...init, headers }, names };
}

// Anything with the Cache API's shape: `caches.default` on Workers, memoryCache() in tests.
// match answers as the Cache API does: the response, or the platform's missing value on a miss.
export type PackCache = {
  readonly match: (key: string) => ReturnType<Cache['match']>;
  readonly put: (key: string, res: Response) => Promise<unknown>;
  readonly delete: (key: string) => Promise<unknown>;
};
export type CachingConfig = {
  readonly waitUntil: ((p: Promise<unknown>) => void) | null;
  readonly namespace: string;
  readonly shouldCache: (body: Uint8Array) => boolean;
  readonly maxAge: number;
  // the default rule caches every pure fetch, not only the filtered ones (every answer is verified before it is stored, with or without this)
  readonly verifyBeforeStore: boolean;
  // any subset (a key left out is the default); parsed where an answer is verified (cachingFetch returns no Result)
  readonly limits: LimitsInput;
};
export type CachingOptions = Input<CachingConfig>;
const isPureFetchBody = (body: Uint8Array): boolean => pureFetchOf(body) !== null;
const cachingDefaults = (verify: boolean): CachingConfig => ({ waitUntil: null, namespace: NAMESPACE, shouldCache: verify ? isPureFetchBody : isCacheableFetch, maxAge: 31_536_000, verifyBeforeStore: verify, limits: DEFAULT_LIMITS });
// verifyOk: answers verified and handed to the store. verifyFailed / verifyError: answers refused before the store and
// stored entries refused on read (with the last refusal's message). bust: evictions, the client's and the cache's own.
export type CacheStats = { hit: number; miss: number; bust: number; bypass: number; putOk: number; putFailed: number; putError: string; verifyOk: number; verifyFailed: number; verifyError: string };
// The fetch ply's HTTP transport calls (http.ts FetchLike), with the cache's counters. `init` and `prefix` may be left out.
export type CachingFetch = ((url: string | URL, ...init: [] | [RequestInit]) => Promise<Response>) & { stats: CacheStats; attrs: (...prefix: [] | [string]) => Attrs };

// The one gate between a body and the cache, in both directions. An origin's answer is stored only if it passes; a
// stored entry is untrusted storage and is served only if it passes. The body is read whole (capped) and checked by
// verifyFetchAnswer against the request the key was made from: framed, no ERR, a packfile section, the pack trailer,
// every object hashed, every want present. Never rejects.
async function readVerified(stream: ReadableStream<Uint8Array> | null, body: Uint8Array, given: LimitsInput): Promise<Result<Uint8Array<ArrayBuffer>, PlyError>> {
  if (stream === null) return fail('protocol', 'answer: no body');
  const request = parseUploadPackRequest(body);
  const limits = parseLimits(given);
  if (!limits.ok) { await stream.cancel().catch(() => null); return limits; }
  // pack and progress are each held to maxPackBytes by v2Step; a pkt-line header per 65516-byte frame and the sections
  // fit in one more maxPackBytes
  const bytes = await readCapped(stream, limits.value.maxPackBytes * 3);
  if (!bytes.ok) return bytes;
  const verified = request.ok && request.value.command === 'fetch' ? verifyFetchAnswer(request.value, bytes.value, limits.value) : fail('protocol', 'answer: the request is not a fetch');
  return verified.ok ? ok(bytes.value) : verified;
}
const refused = (stats: CacheStats, e: PlyError): void => { stats.verifyFailed++; stats.verifyError = e.message.slice(0, 200); };

// The cache branch of the tee: stored only once readVerified accepted it. A refused answer is counted and dropped: the
// client's own branch still carries it, and the client's own checks refuse it.
async function verifiedStore(toCache: ReadableStream<Uint8Array>, body: Uint8Array, given: LimitsInput, stats: CacheStats, store: (entry: BodyInit) => Promise<void>): Promise<void> {
  const answer = await readVerified(toCache, body, given);
  if (!answer.ok) { refused(stats, answer.error); return; }
  stats.verifyOk++;
  await store(answer.value);
}

export function cachingFetch(fetchImpl: FetchLike, cache: PackCache, options: CachingOptions = {}): CachingFetch {
  const { waitUntil, namespace, shouldCache, maxAge, limits } = withDefaults(options, cachingDefaults(getOrElse(readKey(options, 'verifyBeforeStore'), false)));
  const inner = fetchImpl === globalThis.fetch ? fetchImpl.bind(globalThis) : fetchImpl;
  const stats: CacheStats = { hit: 0, miss: 0, bust: 0, bypass: 0, putOk: 0, putFailed: 0, putError: '', verifyOk: 0, verifyFailed: 0, verifyError: '' };
  const f = async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    const { init: wire, names } = peelRecordHeaders(init);
    const body = wire.body;
    if (wire.method !== 'POST' || !String(url).endsWith('/git-upload-pack') || !(body instanceof Uint8Array) || !shouldCache(body)) { stats.bypass++; return inner(url, wire); }
    const mode = headerOf(headersOf(wire), CACHE_CONTROL_HEADER);
    const key = await cacheKey(String(url), headerOf(headersOf(wire), 'authorization'), body, namespace);
    // a failed delete is ignored
    let evicted = mode === 'bust';
    if (evicted) { stats.bust++; await cache.delete(key).catch(() => null); }
    else {
      // a failed match is a miss
      const hit = await cache.match(key).then(fromNullish, (): Option<Response> => none);
      // oxlint-disable-next-line typescript/strict-boolean-expressions -- a falsy answer is a miss, as before
      if (hit.tag === 'some' && hit.value) {
        const entry = await readVerified(hit.value.body, body, limits);
        if (entry.ok) {
          stats.hit++;
          const h = new Headers(hit.value.headers); h.set(CACHE_HEADER, cacheHeader('HIT'));
          return new Response(entry.value, { status: 200, headers: h });
        }
        // Untrusted storage: an entry that is not a verified answer to this request is evicted, and the origin is asked.
        refused(stats, entry.error); stats.bust++; evicted = true;
        await cache.delete(key).catch(() => null);
      }
    }
    const res = await inner(url, wire);
    const ct = getOrElse(fromNullish(res.headers.get('content-type')), '');
    const h = new Headers(res.headers); h.set(CACHE_HEADER, cacheHeader(evicted ? 'BUST' : 'MISS'));
    if (!res.ok || !ct.startsWith('application/x-git-upload-pack-result') || !res.body) return new Response(res.body, { status: res.status, headers: h });
    stats.miss++;
    const [toClient, toCache] = res.body.tee();
    const stored = new Headers();
    for (const name of names) { const v = res.headers.get(name); if (v !== null) stored.set(name, v); }
    stored.set('content-type', ct);
    stored.set('cache-control', `public, max-age=${maxAge}, immutable`);
    // The put's fate is observable: a cache that silently refuses to store would otherwise look like a permanent miss rate.
    const store = async (entry: BodyInit): Promise<void> => {
      // oxlint-disable-next-line promise/always-return -- the counters are the outcome; the promise's value is unused (waitUntil)
      await cache.put(key, new Response(entry, { status: 200, headers: stored })).then(() => { stats.putOk++; }, (e: unknown) => { stats.putFailed++; stats.putError = thrownText(e).slice(0, 200); });
    };
    const put = verifiedStore(toCache, body, limits, stats, store);
    if (waitUntil) waitUntil(put);
    return new Response(toClient, { status: 200, headers: h });
  };
  Object.defineProperty(f, CACHING_FETCH_BRAND, { value: true });
  f.stats = stats;
  f.attrs = (prefix = 'git.pack.cache') => ({ [`${prefix}.hit`]: stats.hit, [`${prefix}.miss`]: stats.miss, [`${prefix}.bust`]: stats.bust, [`${prefix}.bypass`]: stats.bypass, [`${prefix}.put.ok`]: stats.putOk, [`${prefix}.put.failed`]: stats.putFailed, [`${prefix}.put.error`]: stats.putError, [`${prefix}.verify.ok`]: stats.verifyOk, [`${prefix}.verify.failed`]: stats.verifyFailed, [`${prefix}.verify.error`]: stats.verifyError });
  return f;
}

// Cache-API-shaped in-memory cache for tests and node. Bodies are buffered; `entries` is exposed so tests can poison one.
export type MemoryCache = PackCache & { readonly entries: Map<string, { body: Uint8Array; headers: Record<string, string> }> };
export function memoryCache(): MemoryCache {
  const entries: MemoryCache['entries'] = new Map();
  return {
    entries,
    // oxlint-disable-next-line require-await, typescript/require-await -- the Cache API's shape: every method returns a promise
    async match(key) { return unwrapOrAbsent(mapOption(mapGet(entries, key), e => new Response(e.body.slice(), { status: 200, headers: e.headers }))); },
    async put(key, res) { entries.set(key, { body: new Uint8Array(await res.arrayBuffer()), headers: Object.fromEntries(res.headers) }); },
    // oxlint-disable-next-line require-await, typescript/require-await -- as above
    async delete(key) { return entries.delete(key); },
  };
}
