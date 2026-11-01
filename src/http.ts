// Smart-HTTP transport: one POST per git command, body chunks yielded as they arrive, every request a CLIENT span.
// Implements the contract in transport.js. `createTransport` is its constructor (the name every caller used first).
/* oxlint-disable require-unicode-regexp -- URL, header and credential text; `u` costs a byte per literal and changes what /i matches (U+017F, U+212A) */
import type { Code, Detail, Extra } from './errors.js';
import type { Limits } from './limits.js';
import type { Span, Tracer } from './otel.js';
import type { Attrs, Frame, Hints, Quirks, Scrub, Transport } from './transport.js';
import { thrown as fail } from './errors.js';
import { pktInit, pktStep, pktFinish, pktAttrs } from './pktline.js';
import { bufferSource, concat, td, te } from './bytes.js';
import { scrubber, secretShaped, secretUser } from './scrub.js';
import { DEFAULT_LIMITS, requireLimit, limitError } from './limits.js';
import { validateWire } from './validate.js';
import { UA, wrapNet } from './transport.js';

export const redactUrl = (u: string | URL): string => { try { const x = new URL(u); x.username = ''; x.password = ''; return x.toString(); } catch { return '<invalid url>'; } };
export type HttpCode = Extract<Code, 'auth' | 'not_found' | 'rate_limited' | 'upstream_5xx' | 'http'>;
export const httpCode = (status: number): HttpCode => {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return status >= 500 ? 'upstream_5xx' : 'http';
};

// An error page is quoted, not stored. Past this many bytes the rest cannot change the message and must not be buffered.
const ERROR_PREVIEW = 4096;
const ERROR_QUOTE = 200;

// Opt-in response headers on the exchange span (`http.response.header.<lowercased name>`). A name has to be a token the
// telemetry key grammar already allows (letters, digits, `.`, `_`, `-`): that is an RFC 7230 tchar subset, and a name
// outside it would mint an attribute key no dashboard contract accepts. Values are scrubbed (the transport's credential
// scrub, same as every other span string) then cut. The cap is a support id (cf-ray, x-github-request-id, x-request-id),
// not a body. Too many names is a caller's bug and is refused before any request.
export const HEADER_VALUE_MAX = 128;
export const MAX_RECORDED_HEADERS = 8;
const HEADER_NAME = /^[0-9A-Za-z._-]+$/;
// Private channel to cachingFetch (packcache.ts keeps the same literals). The edit bundle must not import that module.
// The hint is set only when fetchImpl is cachingFetch, and that wrapper strips it before the origin fetch.
const RECORD_HEADERS_REQUEST = 'x-ply-record-headers';
const CACHING_FETCH_BRAND = 'plyCachingFetch';
const PACK_CACHE_HEADER = 'x-ply-pack-cache';

function recordResponseHeaderNames(names: unknown): readonly string[] {
  if (names === undefined) return [];
  if (!Array.isArray(names)) throw fail('bad_request', 'recordResponseHeaders: expected a list of header names', { what: 'recordResponseHeaders' });
  if (names.length > MAX_RECORDED_HEADERS) throw fail('bad_request', `recordResponseHeaders: at most ${MAX_RECORDED_HEADERS} names`, { what: 'recordResponseHeaders' });
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (typeof name !== 'string' || !HEADER_NAME.test(name)) {
      const shown = typeof name === 'string' ? JSON.stringify(name) : 'not a string';
      throw fail('bad_request', `recordResponseHeaders: ${shown} is not a header name`, { what: 'recordResponseHeaders' });
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

// Scrub the whole value, then cap: slicing first could leave a secret fragment shorter than the scrubber's window.
function recordedHeaderAttrs(res: Response, names: readonly string[], scrub: Scrub | null): Attrs {
  const attrs: Attrs = {};
  for (const name of names) {
    const raw = res.headers.get(name);
    if (raw === null) continue;
    const text = scrub ? scrub(raw) : raw;
    attrs[`http.response.header.${name}`] = text.length > HEADER_VALUE_MAX ? text.slice(0, HEADER_VALUE_MAX) : text;
  }
  if (res.headers.get(PACK_CACHE_HEADER) === 'HIT') attrs['http.response.headers.from_cache'] = true;
  return attrs;
}

const headerField = (value: string | null | undefined, what: string): void => { if (value !== null && value !== undefined) validateWire(value, what); };

// URL userinfo → the bytes git sends for it (git 2.50, measured against http-backend behind Basic auth), as a byte
// string `btoa` takes as is: `%XX` is that byte (`%FF` → 0xFF, UTF-8 as its bytes), anything else as written (`%ZZ`
// stays `%ZZ`; WHATWG URL has already percent-encoded every non-ASCII character). A NUL, CR or LF is refused: git
// refuses LF ("credential url cannot be parsed") and NUL (curl: "bad/illegal format") and sends CR; Basic would carry
// any of them, but no host means one.
const userinfo = (s: string): string => {
  // oxlint-disable-next-line unicorn/prefer-string-replace-all, unicorn/prefer-number-properties, unicorn/prefer-code-point -- same results (a /g regex; one global parseInt; bytes 0-255), fewer bytes
  const b = s.replace(/%([0-9a-f]{2})/gi, (_: string, h: string) => String.fromCharCode(parseInt(h, 16)));
  if (/[\0\r\n]/.test(b)) throw fail('bad_request', 'invalid url userinfo: must not contain NUL, CR, or LF', { what: 'url userinfo' });
  return b;
};
// WHATWG URL drops an empty userinfo (`http://@h`, `http://:@h` → `http://h/`); git sends Basic `:` for both (measured).
// A `\` ends the authority of a special URL, as `/` does.
const emptyUserinfo = (url: string | URL): boolean => /^[a-z][a-z0-9+.-]*:\/\/[^/?#\\]*@/i.test(String(url));
// oxlint-disable-next-line unicorn/prefer-code-point -- a byte, 0-255
const latin1 = (bytes: Uint8Array): string => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return s; };
// oxlint-disable-next-line unicorn/prefer-code-point -- atob() output: one char per byte, 0-255
const utf8 = (b: string): string => td.decode(Uint8Array.from(b, c => c.charCodeAt(0)));
// An Authorization value or a Bearer token goes on the wire as written: printable ASCII (and tab) only. A raw
// non-ASCII or control character is refused before any request: fetch throws an untyped TypeError on a character past
// U+00FF, git sends UTF-8 as raw bytes (measured, `http.extraHeader`) that no grammar for either scheme admits, and a
// control character is a 400 from a strict server (measured: git's `Bearer t\x01k` → HTTP 400). Basic credentials are
// any text (below).
const ASCII_VALUE = /^[\t -~]+$/; // tab, and space (0x20) through tilde (0x7E)
const noCredential = (why: string): ReturnType<typeof fail<'bad_request'>> => fail('bad_request', `invalid auth: ${why}`, { what: 'auth' });

// The explicit `auth` → [Authorization value, its Basic parts or null]. Every form yields a credential or is refused:
// an `auth` that sends nothing is the silent trap #32 was (every request anonymous, a 401 saying nothing about why).
//   { header }        the value verbatim (a proxy forwarding its caller's credential)
//   { token, user? }  Basic `user:token`, user defaulting to `x-access-token`; the text is sent as its UTF-8 bytes, as git
//                     sends a credential helper's (measured: `username=tëst password=päss` → those bytes)
//   { bearer }        Bearer
//   { user }          refused. git's own credential API asks for the password when a helper gives a user alone (measured:
//                     "could not read Password", nothing sent) and a library cannot ask; `token: ''` is the explicit
//                     empty password and sends `user:` (git, helper `password=` empty: `ivar:`), the URL `user@` form.
// The explicit credential forms (below). A null field is the same as an absent one.
export type HttpAuth = { readonly header?: string | null; readonly token?: string | null; readonly user?: string | null; readonly bearer?: string | null };
type Basic = { readonly user: string; readonly pass: string };
function explicitAuth({ header, token, user, bearer }: HttpAuth): [string, Basic | null] {
  if (header !== null && header !== undefined) {
    if (!ASCII_VALUE.test(header)) throw noCredential('the authorization header must be non-empty printable ASCII');
    return [header, null];
  }
  if (token !== null && token !== undefined) {
    if (token === '' && (user === null || user === undefined)) throw noCredential('an empty token with no user carries no credential');
    const name = user ?? 'x-access-token';
    return [`Basic ${btoa(latin1(te.encode(`${name}:${token}`)))}`, { user: name, pass: token }];
  }
  if (bearer !== null && bearer !== undefined) {
    if (!ASCII_VALUE.test(bearer)) throw noCredential('the bearer token must be non-empty printable ASCII');
    return [`Bearer ${bearer}`, null];
  }
  if (user !== null && user !== undefined) throw noCredential('a user with no token; pass the token, or token: \'\' to send the user alone (Basic `user:`)');
  throw noCredential('no token, bearer or header; omit auth to send none');
}

// A 3xx is never followed (fetch `redirect: 'manual'`), same-origin or not. Following hands the Authorization header to
// whatever the server names, under the runtime's own rules: undici strips it cross-origin, workerd 2026-10-23 forwards it
// (measured, SAFETY I6c). A 301/302 also turns the POST into a GET, which surfaced as a content-type error. git follows
// only on the initial info/refs and then rebases every request on the new URL; ply's first request is usually the v2
// POST, so following on the GET alone would not make a moved repository work. A moved remote is a URL the caller
// updates: the error names where the server pointed (origin and path only, scrubbed). Browsers answer `manual` with an
// opaque redirect (status 0): same error.
const isRedirect = (res: Response): boolean => res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
// A body a test double may not implement `cancel` on, and a real one whose `cancel()` rejects. The rejection is the
// body's, not the caller's: it must be awaited, or it is an unhandled rejection the surrounding `try` cannot catch.
type Cancelable = { readonly cancel?: (() => void | Promise<void>) | undefined };
async function cancelBody(body: Cancelable | null | undefined): Promise<void> {
  try { await body?.cancel?.(); } catch { /* unopened or already closed */ }
}
// A 2xx whose body is missing never reached the pkt-line parser. Iterating it threw TypeError, and wrapNet reported
// `network`. There is no git message to parse: that is `protocol`.
function missingBody(body: unknown): body is null | undefined {
  return body === null || body === undefined;
}
async function redirectError(res: Response, url: string, what: string, scrub: Scrub | null): Promise<ReturnType<typeof fail<'http'>>> {
  let to = '';
  const loc = res.headers.get('location');
  // oxlint-disable-next-line typescript/strict-boolean-expressions -- null and '' are no Location, as before
  if (loc) try { const x = new URL(loc, url); to = `${x.origin}${x.pathname}`; } catch { /* unparseable Location */ }
  if (scrub) to = scrub(to);
  await cancelBody(res.body);
  return fail('http', `HTTP ${res.status} ${what}: redirected${to ? ` to ${to}` : ''}; ply does not follow redirects (update the remote URL)`, { status: res.status, location: to } as Detail['http'] & Extra);
}

// Read a body without ever holding more than `max` bytes. `truncate` keeps a prefix (error pages);
// otherwise the first chunk that would pass the cap throws and is not retained.
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number, { what = 'response bytes', truncate = false }: { readonly what?: string; readonly truncate?: boolean } = {}): Promise<Uint8Array> {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- a fetch double may hand back a body that is not async-iterable
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for await (const chunk of body) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (n + bytes.length > max) {
        if (!truncate) throw limitError(what, n + bytes.length, max);
        if (max > n) chunks.push(bytes.subarray(0, max - n));
        break;
      }
      chunks.push(bytes);
      n += bytes.length;
    }
  } finally { await cancelBody(body); }
  return concat(chunks);
}

// What the transport calls: the platform fetch, or a wrapper with its signature (packcache.ts cachingFetch).
export type FetchLike = (url: string | URL, init: RequestInit) => Promise<Response>;
export type HttpOptions = {
  readonly auth?: HttpAuth | null | undefined;
  readonly tracer?: Tracer | undefined;
  readonly parent?: Span | null | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly userAgent?: string | undefined;
  readonly limits?: Limits | undefined;
  readonly signal?: AbortSignal | null | undefined;
  readonly quirks?: Quirks | undefined;
  // Response header names to copy onto each exchange span. Default: none (the span contract is unchanged).
  readonly recordResponseHeaders?: readonly string[] | undefined;
};
export type HttpTransport = Transport & { readonly kind: 'http'; readonly quirks: Quirks; readonly objects: NonNullable<Transport['objects']> };

// oxlint-disable-next-line complexity -- the constructor resolves every credential form in one place
export function createTransport(url: string | URL, { auth, tracer, parent = null, fetchImpl = globalThis.fetch, userAgent = UA, limits = DEFAULT_LIMITS, signal = null, quirks = {}, recordResponseHeaders }: HttpOptions = {}): HttpTransport {
  headerField(userAgent, 'user agent');
  const recordNames = recordResponseHeaderNames(recordResponseHeaders);
  headerField(auth?.header, 'authorization');
  headerField(auth?.token, 'token');
  headerField(auth?.bearer, 'bearer');
  headerField(auth?.user, 'auth user');
  // `new URL` puts what it was given on the TypeError (`input`): a credential in a malformed URL would ride out on it.
  let u: URL;
  try { u = new URL(url); } catch { throw fail('bad_request', 'invalid url: not an absolute URL', { what: 'url' }); }
  // userinfo in the URL becomes the Basic credential git sends for it, byte for byte: `user:password`; a user alone is
  // `user:` (a token given as the user, which GitHub and GitLab accept; git sends it without asking for a password and
  // asks only once it is refused), a password alone `:password`, an empty userinfo `:`. Explicit `auth` wins. It never
  // appears again: not in requests, not in spans, not in error messages.
  const fromUrl = (auth === null || auth === undefined) && (u.username || u.password || emptyUserinfo(url)) ? { user: userinfo(u.username), pass: userinfo(u.password) } : null;
  u.username = ''; u.password = '';
  const base = u.toString().replace(/\/$/, '');
  // Workers: fetch is a method of the global and throws "Illegal invocation" when called detached; bind it (found under workerd)
  const f = fetchImpl === globalThis.fetch ? fetchImpl.bind(globalThis) : fetchImpl;
  // cachingFetch reads this and strips it (packcache.ts). Any other fetchImpl must not see it: it would go to the origin.
  const recordHint = (): Record<string, string> => recordNames.length > 0 && Object.hasOwn(f, CACHING_FETCH_BRAND) ? { [RECORD_HEADERS_REQUEST]: recordNames.join(',') } : {};
  // Whatever form, the value never reaches a span or an error message (`scrub`), even echoed.
  // oxlint-disable-next-line no-nested-ternary -- three forms, one pair
  const [authorization, given]: [string | null, Basic | null] = fromUrl ? [`Basic ${btoa(`${fromUrl.user}:${fromUrl.pass}`)}`, null] : auth !== null && auth !== undefined ? explicitAuth(auth) : [null, null];
  // The Basic parts as a server would echo them (UTF-8 text). From a header they are decoded, as bytes and as UTF-8.
  const decoded = ((): Basic | null => { if (authorization === null || !/^Basic\s/i.test(authorization)) return null; try { const d = atob(authorization.replace(/^Basic\s+/i, '')); const c = d.indexOf(':'); return c < 0 ? { user: d, pass: '' } : { user: d.slice(0, c), pass: d.slice(c + 1) }; } catch { return null; } })();
  const basic = given ?? (decoded && { user: utf8(decoded.user), pass: utf8(decoded.pass) });
  const user = auth?.user ?? basic?.user;
  const userSecret = basic ? secretUser(basic.user, basic.pass !== '') : secretShaped(user);
  // Every string a server can send back (error bodies, ERR lines, band-2/3 text, ng reasons, hook output) passes through
  // `scrub` before it reaches an error or a span: the transport carries it (`t.scrub`) and otel.js applies it.
  const scrub = scrubber([authorization, auth?.token, auth?.bearer, authorization?.replace(/^\S+\s+/, ''), basic?.pass, decoded?.pass, userSecret ? basic?.user ?? user : null, userSecret ? decoded?.user : null, secretShaped(user) ? user : null]);
  const headers = (service: string, extra: Record<string, string> = {}): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': `application/x-${service}-request`, Accept: `application/x-${service}-result`, 'User-Agent': userAgent, ...extra };
    // oxlint-disable-next-line typescript/strict-boolean-expressions -- null and '' send no Authorization, as before
    if (authorization) h['Authorization'] = authorization;
    return h;
  };
  // Not AbortSignal.any([AbortSignal.timeout(ms)]): the composite holds its sources weakly and the timeout signal is held
  // only by its own (weak) timer, so after a GC the timeout never fires and a stalled body hangs forever (Node 20/22;
  // found by the calibration harness: `hang` fault + head hint). A controller owned by a live timer cannot be collected.
  // The timer is the strong owner of `ac`. It stays scheduled for the whole exchange (so a GC cannot drop it)
  // and is cleared when the exchange ends, so a finished request does not abort later.
  const requestSignal = (): { readonly signal: AbortSignal; readonly cancel: () => void } => {
    const ms = requireLimit(limits, 'requestTimeoutMs');
    const ac = new AbortController();
    // Node's timer has unref (the DOM lib types it as a number); a Worker's has none.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    const timer = setTimeout(() => { ac.abort(new DOMException(`request exceeded ${ms} ms`, 'TimeoutError')); }, ms) as ReturnType<typeof setTimeout> & { unref?: () => void };
    timer?.unref?.();
    const sig = signal ? AbortSignal.any([ac.signal, signal]) : ac.signal;
    return { signal: sig, cancel: () => { clearTimeout(timer); } };
  };

  // POST and yield body chunks, filling span with HTTP attrs. Async generator keeps memory at one chunk.
  async function* post(service: string, body: Uint8Array, span: Span, hints: Hints): AsyncGenerator<Uint8Array, void, undefined> {
    const target = `${base}/${service}`;
    // oxlint-disable-next-line typescript/strict-boolean-expressions -- an absent hint is no hint
    const extra = { 'Git-Protocol': 'version=2', ...recordHint(), ...(hints.bypassCache ? { 'x-ply-cache': 'bust' } : {}) };
    span.set({ 'git.transport': 'http', 'http.request.method': 'POST', 'url.full': redactUrl(target), 'server.address': u.host, 'git.request.bytes': body.length, 'http.request.body.size': body.length, 'git.service': service, 'git.limits.request_timeout_ms': limits.requestTimeoutMs });
    const t0 = Date.now();
    const sig = requestSignal();
    let res: Response;
    try {
    try { res = await f(target, { method: 'POST', headers: headers(service, extra), body: bufferSource(body), signal: sig.signal, redirect: 'manual' }); }
    catch (e) { throw wrapNet(e, sig.signal); }
    const cache = res.headers.get(PACK_CACHE_HEADER) ?? '';
    span.set({ 'http.response.status_code': res.status, 'http.response.header.content-type': res.headers.get('content-type') ?? '', 'http.response.ttfb_ms': Date.now() - t0, 'git.response.cache': cache, 'git.pack.cache': cache });
    if (recordNames.length > 0) span.set(recordedHeaderAttrs(res, recordNames, scrub));
    if (isRedirect(res)) throw await redirectError(res, target, service, scrub);
    if (!res.ok) {
      // Keep a prefix for the message (and for credential scrubbing). The rest of a huge error page is cancelled.
      const preview = td.decode(await readCapped(res.body, ERROR_PREVIEW, { truncate: true }));
      throw fail(httpCode(res.status), `HTTP ${res.status} ${service}: ${(scrub ? scrub(preview) : preview).slice(0, ERROR_QUOTE)}`, { status: res.status } as Detail['http'] & Extra);
    }
    let bytes = 0, chunks = 0, first: number | null = null, maxChunk = 0;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.startsWith(`application/x-${service}-result`)) throw fail('not_git', `unexpected content-type ${JSON.stringify(ct)} from ${service}`);
    if (missingBody(res.body)) throw fail('protocol', `${service}: HTTP ${res.status} response has no body`);
    try { for await (const chunk of res.body) {
      first ??= Date.now() - t0;
      bytes += chunk.length; chunks++; if (chunk.length > maxChunk) maxChunk = chunk.length;
      yield chunk;
    } } catch (e) { throw wrapNet(e, sig.signal); }
    span.set({ 'git.response.bytes': bytes, 'git.response.first_byte_ms': first ?? -1, 'git.response.duration_ms': Date.now() - t0, 'http.response.body.size': bytes, 'http.response.chunks': chunks, 'http.response.chunk.max': maxChunk, 'http.response.first_byte_ms': first ?? -1, 'http.response.duration_ms': Date.now() - t0 });
    } finally { sig.cancel(); }
  }

  return {
    // quirks: what this server was found to need (shared by every view of the transport; a caller may pass one object to
    // many transports for the same server). objects: commits/trees harvested from over-wide packs (fetch.js).
    // scrub: the credential's forms → '[redacted]' (null without auth); spans under this transport apply it (otel.js).
    // A transport without a tracer fails on its first span, as it always has. A3: require it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- see above
    kind: 'http', url: base, tracer: tracer as Tracer, parent, limits, signal, quirks, objects: new Map(), scrub,
    async *frames(service: string, body: Uint8Array, span: Span, hints: Hints = {}): AsyncGenerator<Frame, void, undefined> {
      let st: ReturnType<typeof pktStep>['state'] = pktInit();
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pktline.js is untyped until its cluster converts; its frames are Frame
      for await (const chunk of post(service, body, span, hints)) { const r = pktStep(st, chunk); st = r.state; yield* r.frames as Frame[]; }
      pktFinish(st);
      span.set(pktAttrs(st));
    },
    // GET info/refs?service=… (capability advertisements). Returns the whole body; advertisements are small.
    async advertise(service: string, span: Span): Promise<Uint8Array> {
      const target = `${base}/info/refs?service=${service}`;
      span.set({ 'git.transport': 'http', 'http.request.method': 'GET', 'url.full': redactUrl(target), 'server.address': u.host });
      const sig = requestSignal();
      try {
      const t0 = Date.now();
      let res: Response;
      try { res = await f(target, { headers: headers(service, { 'Git-Protocol': 'version=2', ...recordHint() }), signal: sig.signal, redirect: 'manual' }); } catch (e) { throw wrapNet(e, sig.signal); }
      span.set({ 'http.response.status_code': res.status, 'http.response.ttfb_ms': Date.now() - t0, 'http.response.header.content-type': res.headers.get('content-type') ?? '' });
      if (recordNames.length > 0) span.set(recordedHeaderAttrs(res, recordNames, scrub));
      if (isRedirect(res)) throw await redirectError(res, target, `${service} advertisement`, scrub);
      if (!res.ok) throw fail(httpCode(res.status), `HTTP ${res.status} ${service} advertisement`, { status: res.status } as Detail['http'] & Extra);
      if (!(res.headers.get('content-type') ?? '').startsWith(`application/x-${service}-advertisement`)) throw fail('not_git', `unexpected content-type from ${service} advertisement`);
      const maxPack = requireLimit(limits, 'maxPackBytes');
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxPack) {
        await cancelBody(res.body);
        throw limitError('advertisement bytes', declared, maxPack);
      }
      if (missingBody(res.body)) throw fail('protocol', `${service} advertisement: HTTP ${res.status} response has no body`);
      // Stream into the cap. arrayBuffer() would allocate the whole body before the check could run.
      const buf = await readCapped(res.body, maxPack, { what: 'advertisement bytes' });
      span.set({ 'git.response.bytes': buf.length, 'http.response.body.size': buf.length });
      return buf;
      } finally { sig.cancel(); }
    },
  };
}
