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
// What is stored, under either rule: the origin's answer streams into cache.put through a verifier (answerGate) that
// holds O(chunk) state and errors the stream at the first violation or at the end, so the put never commits an answer
// that failed: pkt-line framing complete to the final flush, no ERR packet, no sideband channel-3 message, and when
// there is a packfile section, a valid pack header and a trailing SHA-1 equal to a running SHA-1 of the pack bytes (no
// inflate, no delta resolution). Nothing on the cache path holds a whole answer. A store whose put cannot be aborted
// by an errored body gets a delete after the failed verification (stats.verifyFailed / verifyError).
// What is served: the store is untrusted, and a HIT is streamed with no pass of its own. The check is the client's
// parse of the replayed answer (pack checksum, every object hashed); a HIT the client refuses is deleted and asked for
// once more from the origin (`x-ply-cache: bust` -> `x-ply-pack-cache: BUST`, counted in stats.bust).
// The response carries `x-ply-pack-cache: HIT|MISS|BUST` so spans can say which tier served it.
/* oxlint-disable import/max-dependencies -- the cache joins the request parser, the response reader and the pack resolver */
import type { Attrs } from './transport.js';
import type { FetchLike } from './http.js';
import type { Input } from './absent.js';
import type { CheckedLimits, LimitsInput } from './limits.js';
import type { PlyError } from './errors.js';
import type { FetchRequest } from './uprequest.js';
import type { Option, Result } from './result.js';
import { te, concat } from './bytes.js';
import { fail } from './errors.js';
import { DEFAULT_LIMITS, LIMIT_MEMORY_CACHE_BYTES, LIMIT_MEMORY_CACHE_ENTRIES, limitExceeded, parseLimits } from './limits.js';
import { streamingSha1, toHex } from './sha1.js';
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
  readonly match: (key: string) => Promise<ReturnType<Map<string, Response>['get']>>; // Cache['match'], without naming the DOM-lib `Cache`
  readonly put: (key: string, res: Response) => Promise<unknown>;
  readonly delete: (key: string) => Promise<unknown>;
};
export type CachingConfig = {
  readonly waitUntil: ((p: Promise<unknown>) => void) | null;
  readonly namespace: string;
  readonly shouldCache: (body: Uint8Array) => boolean;
  readonly maxAge: number;
  // the default rule caches every pure fetch, not only the filtered ones (every answer passes the streaming verifier on its way to the store, with or without this)
  readonly verifyBeforeStore: boolean;
  // any subset (a key left out is the default); a bad value stores nothing and is counted in verifyFailed (cachingFetch returns no Result)
  readonly limits: LimitsInput;
};
export type CachingOptions = Input<CachingConfig>;
const isPureFetchBody = (body: Uint8Array): boolean => pureFetchOf(body) !== null;
const cachingDefaults = (verify: boolean): CachingConfig => ({ waitUntil: null, namespace: NAMESPACE, shouldCache: verify ? isPureFetchBody : isCacheableFetch, maxAge: 31_536_000, verifyBeforeStore: verify, limits: DEFAULT_LIMITS });
// verifyOk: answers the streaming verifier passed to the end. verifyFailed / verifyError: answers it refused (the put's
// body was errored and the key deleted), with the last refusal's message. bust: evictions asked for by the client.
export type CacheStats = { hit: number; miss: number; bust: number; bypass: number; putOk: number; putFailed: number; putError: string; verifyOk: number; verifyFailed: number; verifyError: string };
// The fetch ply's HTTP transport calls (http.ts FetchLike), with the cache's counters. `init` and `prefix` may be left out.
export type CachingFetch = ((url: string | URL, ...init: [] | [RequestInit]) => Promise<Response>) & { stats: CacheStats; counters: { parsed: number }; attrs: (...prefix: [] | [string]) => Attrs };

// The store-side verifier: every chunk on its way to cache.put passes through it. State is O(chunk): the pkt-line
// carry (at most one frame), the v2 section state (bounded by maxSectionLines), 12 header bytes, the last 20 pack
// bytes and a running SHA-1. For a fetch: v2Step is the client's own reader (an ERR line and a sideband channel-3
// message are refused there, pack and progress are each held to maxPackBytes), the pack header must be PACK v2/v3,
// and the last 20 pack bytes must be the SHA-1 of the ones before. An acknowledgments-only answer has no pack to
// check. For any other command a caller's shouldCache admits (ls-refs): framed to a final flush, no ERR line.
type Verdict = Result<null, PlyError>;
type Gate = { readonly step: (chunk: Uint8Array) => Promise<Verdict>; readonly end: () => Promise<Verdict> };
const PACK_HEADER = 12;
const PACK_TRAILER = 20;
// "ERR " (gitprotocol-pack error-line)
const isErrLine = (p: Uint8Array): boolean => p.length >= 4 && p[0] === 0x45 && p[1] === 0x52 && p[2] === 0x52 && p[3] === 0x20;
// "PACK", then a big-endian version of 2 or 3
const isPackHeader = (h: Uint8Array): boolean => h[0] === 0x50 && h[1] === 0x41 && h[2] === 0x43 && h[3] === 0x4b && h[4] === 0 && h[5] === 0 && h[6] === 0 && (h[7] === 2 || h[7] === 3);
function answerGate(isFetch: boolean, limits: CheckedLimits): Gate {
  let ps = pktInit();
  let vs = v2Init(limits);
  let flushed = false;
  const head = new Uint8Array(PACK_HEADER); let headLen = 0;
  const tail = new Uint8Array(PACK_TRAILER); let tailLen = 0;
  const sha = streamingSha1();
  // Everything but the last 20 pack bytes is hashed as it passes; the last 20 seen so far wait in `tail`.
  const pack = async (piece: Uint8Array): Promise<Verdict> => {
    if (headLen < PACK_HEADER) {
      const n = Math.min(PACK_HEADER - headLen, piece.length);
      head.set(piece.subarray(0, n), headLen); headLen += n;
      if (headLen === PACK_HEADER && !isPackHeader(head)) return fail('pack_corrupt', 'answer: the packfile section does not start with a PACK v2/v3 header');
    }
    if (piece.length >= PACK_TRAILER) {
      if (tailLen > 0) await sha.update(tail.slice(0, tailLen));
      if (piece.length > PACK_TRAILER) await sha.update(piece.subarray(0, piece.length - PACK_TRAILER));
      tail.set(piece.subarray(piece.length - PACK_TRAILER)); tailLen = PACK_TRAILER;
      return ok(null);
    }
    const over = tailLen + piece.length - PACK_TRAILER;
    if (over > 0) { await sha.update(tail.slice(0, over)); tail.copyWithin(0, over, tailLen); tailLen -= over; }
    tail.set(piece, tailLen); tailLen += piece.length;
    return ok(null);
  };
  const step = async (chunk: Uint8Array): Promise<Verdict> => {
    const read = pktStep(ps, chunk);
    if (!read.ok) return read;
    ps = read.value.state;
    for (const f of read.value.frames) {
      if (!isFetch) {
        if (f.kind === 'data' && isErrLine(f.payload)) return fail('protocol', 'answer: an ERR packet');
        flushed = f.kind === 'flush';
        continue;
      }
      const r = v2Step(vs, f);
      if (!r.ok) return r;
      vs = r.value.state;
      if (r.value.pack) {
        // oxlint-disable-next-line no-await-in-loop -- the pack bytes are hashed in order
        const p = await pack(r.value.pack);
        if (!p.ok) return p;
      }
    }
    return ok(null);
  };
  const end = async (): Promise<Verdict> => {
    const fin = pktFinish(ps);
    if (!fin.ok) return fin;
    if (!isFetch) return flushed ? ok(null) : fail('protocol', 'answer: ended without a flush');
    const e = v2End(vs);
    if (!e.ok) return e;
    if (vs.phase !== 'pack') return ok(null);
    if (headLen < PACK_HEADER || tailLen < PACK_TRAILER) return fail('pack_corrupt', 'answer: the pack ends before its trailer');
    const want = toHex(tail);
    const got: string = await sha.hex();
    return got === want ? ok(null) : fail('pack_corrupt', `answer: the pack trailer ${want} is not the SHA-1 of the pack (${got})`);
  };
  return { step, end };
}
const refused = (stats: CacheStats, e: PlyError): void => { stats.verifyFailed++; stats.verifyError = e.message.slice(0, 200); };

// What became of the body handed to cache.put: 'ok' (every chunk passed and the end check held), 'refused' (the gate,
// a failed origin body, or the client abandoned the answer: the body was errored), 'behind' (the store fell further
// behind the client than CACHE_LAG_BYTES: the body was errored), 'unread' (the store itself stopped reading: its own
// decision, nothing to verify).
type Fate = { readonly kind: 'ok' } | { readonly kind: 'refused'; readonly error: PlyError } | { readonly kind: 'behind'; readonly bytes: number } | { readonly kind: 'unread' };
type Split = { readonly client: ReadableStream<Uint8Array>; readonly cache: ReadableStream<Uint8Array>; readonly fate: Promise<Fate>; readonly unread: () => void };
// The most the cache branch may queue for a store that reads slower than the client. Past it the put is given up
// (errored, the key deleted, counted in putFailed): the client is never paced or stalled by the store, and what ply
// holds for the store is bounded by this, never by the answer.
export const CACHE_LAG_BYTES: number = 1024 * 1024;
// One reader on the origin, driven by the client's reads. Each chunk goes to the client, then through the gate into
// the cache stream's queue (bounded by CACHE_LAG_BYTES). Unlike ReadableStream.tee, whose slower branch queues without
// bound, nothing here holds more than the lag window. A client that cancels (it refused the answer, or went away)
// cancels the origin and errors the cache branch: nothing is drained. Neither stream's failure rejects anything here.
function splitVerified(source: ReadableStream<Uint8Array>, gate: Gate, counters: { parsed: number }): Split {
  const reader = source.getReader();
  let settled = false;
  // the executor runs at once, so `resolve` is there before anything can finish
  const out: { resolve: ((f: Fate) => void) | null } = { resolve: null };
  const fate = new Promise<Fate>(resolve => { out.resolve = resolve; });
  const finish = (f: Fate): void => { if (!settled && out.resolve !== null) { settled = true; out.resolve(f); } };
  const held: { ctl: ReadableStreamDefaultController<Uint8Array> | null } = { ctl: null };
  const cache = new ReadableStream<Uint8Array>({
    start(ctl) { held.ctl = ctl; },
    cancel() { finish({ kind: 'unread' }); },
  }, { highWaterMark: CACHE_LAG_BYTES, size: chunk => chunk.length });
  const stop = (f: Fate, message: string): void => {
    if (settled) return;
    finish(f);
    if (held.ctl) held.ctl.error(new Error(message));
  };
  const refuse = (error: PlyError): void => { stop({ kind: 'refused', error }, error.message); };
  const toStore = async (chunk: Uint8Array): Promise<void> => {
    if (settled) return;
    counters.parsed++;
    const step = await gate.step(chunk);
    const ctl = held.ctl;
    if (settled || ctl === null) return;
    if (!step.ok) { refuse(step.error); return; }
    ctl.enqueue(chunk);
    // desiredSize is the window minus what the store has not taken yet
    const room = getOrElse(fromNullish(ctl.desiredSize), 0);
    if (room < 0) stop({ kind: 'behind', bytes: CACHE_LAG_BYTES - room }, 'the store fell behind the client');
  };
  const finishStore = async (): Promise<void> => {
    if (settled) return;
    const end = await gate.end();
    const ctl = held.ctl;
    if (settled || ctl === null) return;
    if (!end.ok) { refuse(end.error); return; }
    finish({ kind: 'ok' }); ctl.close();
  };
  const client = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      const read = await reader.read().then((r): Option<ReadableStreamReadResult<Uint8Array>> => ({ tag: 'some', value: r }), (e: unknown): Option<ReadableStreamReadResult<Uint8Array>> => {
        refuse(fail('protocol', `answer: the body failed while it was read: ${thrownText(e).slice(0, 200)}`).error);
        // the client sees the origin's own failure
        ctl.error(e);
        return none;
      });
      if (read.tag === 'none') return;
      if (read.value.done) { ctl.close(); await finishStore(); return; }
      ctl.enqueue(read.value.value);
      await toStore(read.value.value);
    },
    async cancel(reason) {
      refuse(fail('protocol', 'answer: the client abandoned it').error);
      await reader.cancel(reason).catch(() => null);
    },
  }, { highWaterMark: 0 });
  return { client, cache, fate, unread: () => { finish({ kind: 'unread' }); } };
}

export function cachingFetch(fetchImpl: FetchLike, cache: PackCache, options: CachingOptions = {}): CachingFetch {
  const { waitUntil, namespace, shouldCache, maxAge, limits } = withDefaults(options, cachingDefaults(getOrElse(readKey(options, 'verifyBeforeStore'), false)));
  const inner = fetchImpl === globalThis.fetch ? fetchImpl.bind(globalThis) : fetchImpl;
  const stats: CacheStats = { hit: 0, miss: 0, bust: 0, bypass: 0, putOk: 0, putFailed: 0, putError: '', verifyOk: 0, verifyFailed: 0, verifyError: '' };
  // chunks the cache layer itself parsed (the store-side gate); a HIT adds none
  const counters = { parsed: 0 };
  const checked = parseLimits(limits);
  const f = async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    const { init: wire, names } = peelRecordHeaders(init);
    const body = wire.body;
    if (wire.method !== 'POST' || !String(url).endsWith('/git-upload-pack') || !(body instanceof Uint8Array) || !shouldCache(body)) { stats.bypass++; return inner(url, wire); }
    const mode = headerOf(headersOf(wire), CACHE_CONTROL_HEADER);
    const key = await cacheKey(String(url), headerOf(headersOf(wire), 'authorization'), body, namespace);
    // a failed delete is ignored
    if (mode === 'bust') { stats.bust++; await cache.delete(key).catch(() => null); }
    else {
      // a failed match is a miss
      const hit = await cache.match(key).then(fromNullish, (): Option<Response> => none);
      // A HIT is streamed as stored, with no pass here: the store is untrusted and the client's own parse is the check
      // (a refused HIT comes back as `x-ply-cache: bust`, above).
      // oxlint-disable-next-line typescript/strict-boolean-expressions -- a falsy answer is a miss, as before
      if (hit.tag === 'some' && hit.value) {
        stats.hit++;
        const h = new Headers(hit.value.headers); h.set(CACHE_HEADER, cacheHeader('HIT'));
        return new Response(hit.value.body, { status: 200, headers: h });
      }
    }
    const res = await inner(url, wire);
    const ct = getOrElse(fromNullish(res.headers.get('content-type')), '');
    const h = new Headers(res.headers); h.set(CACHE_HEADER, cacheHeader(mode === 'bust' ? 'BUST' : 'MISS'));
    if (!res.ok || !ct.startsWith('application/x-git-upload-pack-result') || !res.body) return new Response(res.body, { status: res.status, headers: h });
    stats.miss++;
    // limits that do not parse: nothing can be verified, so nothing is stored
    if (!checked.ok) { refused(stats, checked.error); return new Response(res.body, { status: 200, headers: h }); }
    const stored = new Headers();
    for (const name of names) { const v = res.headers.get(name); if (v !== null) stored.set(name, v); }
    stored.set('content-type', ct);
    stored.set('cache-control', `public, max-age=${maxAge}, immutable`);
    const request = parseUploadPackRequest(body);
    const split = splitVerified(res.body, answerGate(request.ok && request.value.command === 'fetch', checked.value), counters);
    // The put's fate is observable: a cache that silently refuses to store would otherwise look like a permanent miss rate.
    const store = async (): Promise<void> => {
      const failure = await cache.put(key, new Response(split.cache, { status: 200, headers: stored })).then((): Option<string> => none, (e: unknown): Option<string> => ({ tag: 'some', value: thrownText(e).slice(0, 200) }));
      // a store that settled without reading the answer to its end decided for itself
      split.unread();
      const fate = await split.fate;
      if (fate.kind === 'ok') stats.verifyOk++;
      if (fate.kind === 'ok' || fate.kind === 'unread') {
        if (failure.tag === 'some') { stats.putFailed++; stats.putError = failure.value; } else stats.putOk++;
        return;
      }
      // PackCache.put takes no abort signal: the errored body is the only abort, and a store need not honour it. The
      // delete makes sure nothing of a refused or given-up answer stays, and the reason is counted.
      if (fate.kind === 'refused') refused(stats, fate.error);
      else { stats.putFailed++; stats.putError = `the store fell ${fate.bytes} bytes behind the client (window ${CACHE_LAG_BYTES})`; }
      // a failed delete is ignored, whether it rejects or throws before it returns a promise
      await Promise.resolve().then(async () => { await cache.delete(key); return null; }).catch(() => null);
    };
    const put = store();
    if (waitUntil) waitUntil(put);
    return new Response(split.client, { status: 200, headers: h });
  };
  Object.defineProperty(f, CACHING_FETCH_BRAND, { value: true });
  f.stats = stats;
  f.counters = counters;
  f.attrs = (prefix = 'git.pack.cache') => ({ [`${prefix}.hit`]: stats.hit, [`${prefix}.miss`]: stats.miss, [`${prefix}.bust`]: stats.bust, [`${prefix}.bypass`]: stats.bypass, [`${prefix}.put.ok`]: stats.putOk, [`${prefix}.put.failed`]: stats.putFailed, [`${prefix}.put.error`]: stats.putError, [`${prefix}.verify.ok`]: stats.verifyOk, [`${prefix}.verify.failed`]: stats.verifyFailed, [`${prefix}.verify.error`]: stats.verifyError });
  return f;
}

// Cache-API-shaped in-memory cache for tests and node. Bodies are buffered; `entries` is exposed so tests can poison one.
// Bounded: at most `maxBytes` of body bytes and header text and at most `maxEntries` entries, the least recently used
// evicted first (a match or a put makes its key the most recent). An entry larger than the whole byte budget is not
// stored, and its body is not read past the budget. A finite non-negative budget is floored; any other value is the default.
type MemoryEntry = { body: Uint8Array; headers: Record<string, string> };
export type MemoryCache = PackCache & { readonly entries: Map<string, MemoryEntry> };
export type MemoryCacheConfig = { readonly maxBytes: number; readonly maxEntries: number };
export type MemoryCacheOptions = Input<MemoryCacheConfig>;
const entryBytes = (e: MemoryEntry): number => Object.entries(e.headers).reduce((n, [k, v]) => n + k.length + v.length, e.body.length);
// A finite, non-negative budget is floored (100.5 bytes is 100). Anything else (NaN, a negative, an infinity) is not a
// budget: memoryCache returns no Result, so it falls back to the default, which is itself a bound.
const budgetOf = (given: number, fallback: number): number => (Number.isFinite(given) && given >= 0 ? Math.floor(given) : fallback);
export function memoryCache(options: MemoryCacheOptions = {}): MemoryCache {
  const given = withDefaults(options, { maxBytes: LIMIT_MEMORY_CACHE_BYTES, maxEntries: LIMIT_MEMORY_CACHE_ENTRIES });
  const maxBytes = budgetOf(given.maxBytes, LIMIT_MEMORY_CACHE_BYTES);
  const maxEntries = budgetOf(given.maxEntries, LIMIT_MEMORY_CACHE_ENTRIES);
  const entries: MemoryCache['entries'] = new Map();
  // The Map's insertion order is the recency order: eviction takes from the front. The total is counted from the
  // entries themselves on each put (at most maxEntries + 1 of them), so an entry written straight into `entries` counts.
  const evict = (): void => {
    let total = 0;
    for (const e of entries.values()) total += entryBytes(e);
    for (const [key, e] of entries) {
      if (total <= maxBytes && entries.size <= maxEntries) return;
      entries.delete(key);
      total -= entryBytes(e);
    }
  };
  return {
    entries,
    // oxlint-disable-next-line require-await, typescript/require-await -- the Cache API's shape: every method returns a promise
    async match(key) {
      const hit = mapGet(entries, key);
      if (hit.tag === 'some') { entries.delete(key); entries.set(key, hit.value); }
      return unwrapOrAbsent(mapOption(hit, e => new Response(e.body.slice(), { status: 200, headers: e.headers })));
    },
    async put(key, res) {
      // a put replaces: whatever was under the key is gone, whether or not the new entry fits
      entries.delete(key);
      const body = res.body === null ? ok(new Uint8Array(0)) : await readCapped(res.body, maxBytes);
      if (!body.ok) return;
      const entry: MemoryEntry = { body: body.value, headers: Object.fromEntries(res.headers) };
      if (entryBytes(entry) > maxBytes) return;
      entries.set(key, entry);
      evict();
    },
    // oxlint-disable-next-line require-await, typescript/require-await -- as above
    async delete(key) { return entries.delete(key); },
  };
}
