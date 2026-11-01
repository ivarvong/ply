// Smart-HTTP transport: one POST per git command, body chunks yielded as they arrive, every request a CLIENT span.
// Implements the contract in transport.js. `createTransport` is its constructor (the name every caller used first).
/* oxlint-disable require-unicode-regexp -- URL, header and credential text; `u` costs a byte per literal and changes what /i matches (U+017F, U+212A) */
import type { Code, Detail, Extra, PlyError } from './errors.js';
import type { Result } from './result.js';
import { fromNullable, fromNullish } from './absent.js';
import { assertNever } from './result.js';
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
// The named statuses (kept as a branded union for exhaustive type tests).
export type NamedHttpStatus = 401 | 403 | 404 | 429;

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
  const given = fromNullable(names);
  if (given.tag === 'none') return [];
  const list = given.value;
  if (!Array.isArray(list)) throw fail('bad_request', 'recordResponseHeaders: expected a list of header names', { what: 'recordResponseHeaders' });
  if (list.length > MAX_RECORDED_HEADERS) throw fail('bad_request', `recordResponseHeaders: at most ${MAX_RECORDED_HEADERS} names`, { what: 'recordResponseHeaders' });
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of list) {
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

// A 3xx is never followed unless the caller opts in (fetch `redirect: 'manual'` either way). Following hands the
// Authorization header to whatever the server names, under the runtime's own rules: undici strips it cross-origin,
// workerd 2026-10-23 forwards it (measured, SAFETY I6c). The default stays that refusal. `followRedirects: 'initial'`
// is git's `http.followRedirects=initial`: only the first GET info/refs is followed, and only when the Location keeps
// the `/info/refs?service=<service>` suffix (http.c update_url_from_redirect). The base URL is then rewritten and every
// later request, including a POST, uses it. A 3xx on a POST is still this error. A cross-origin rebase drops
// Authorization; the caller does not get the Location's userinfo installed as a credential. Browsers answer `manual`
// with an opaque redirect (status 0): same error. The error names where the server pointed (origin and path only, scrubbed).
// maxRedirects defaults to 3, the hop cap ply-web used, and is refused above 16 (under curl's default of 50).
export const DEFAULT_MAX_REDIRECTS = 3;
export const MAX_REDIRECT_HOPS = 16;
export type FollowRedirects = 'never' | 'initial';
export type AllowUrl = (url: URL) => Result<URL, PlyError>;
const shown = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null ? JSON.stringify(v) : typeof v);
export function redirectPolicy(follow: unknown, max: unknown): { readonly follow: FollowRedirects; readonly max: number } {
  const f = fromNullable(follow);
  if (f.tag === 'some' && f.value !== 'never' && f.value !== 'initial') throw fail('bad_request', `followRedirects must be 'never' or 'initial', got ${shown(f.value)}`, { what: 'followRedirects' });
  const m = fromNullable(max);
  const raw = m.tag === 'none' ? DEFAULT_MAX_REDIRECTS : m.value;
  const n = typeof raw === 'number' && Number.isSafeInteger(raw) ? raw : null;
  if (n === null || n < 0 || n > MAX_REDIRECT_HOPS) throw fail('bad_request', `maxRedirects must be an integer from 0 to ${MAX_REDIRECT_HOPS}`, { what: 'maxRedirects' });
  return { follow: f.tag === 'some' && f.value === 'initial' ? 'initial' : 'never', max: n };
}
// The new base is the Location with the asked URL's `/info/refs?service=` suffix removed. Anything else is not a
// rebase git would accept (update_url_from_redirect dies), so the caller gets the redirect error instead.
export function baseFromRedirect(asked: string, got: URL, service: string): string | null {
  const tail = `/info/refs?service=${service}`;
  if (!asked.endsWith(tail) || !got.href.endsWith(tail)) return null;
  const next = got.href.slice(0, got.href.length - tail.length).replace(/\/$/, '');
  try {
    const b = new URL(next);
    if (b.protocol !== 'http:' && b.protocol !== 'https:') return null;
    b.username = ''; b.password = ''; b.hash = '';
    return b.toString().replace(/\/$/, '');
  } catch { return null; }
}
// A caller may not return a Result even though the type says so. `ok` is read off an unknown object so a
// non-boolean still fails, which a boolean compare on the Result type cannot see.
function isUrlResult(v: unknown): v is Result<URL, PlyError> {
  if (v === null || typeof v !== 'object' || !('ok' in v)) return false;
  return (v as { ok: unknown }).ok === true || (v as { ok: unknown }).ok === false;
}
function useAllowed(allow: AllowUrl | undefined, url: URL): URL {
  if (!allow) return url;
  const got: unknown = allow(url);
  if (!isUrlResult(got)) throw fail('bad_request', 'allowUrl must return a Result', { what: 'allowUrl' });
  if (!got.ok) throw got.error;
  const next = got.value;
  if (!(next instanceof URL) || (next.protocol !== 'http:' && next.protocol !== 'https:')) throw fail('bad_request', 'allowUrl must return an http(s) URL', { what: 'allowUrl' });
  next.username = ''; next.password = ''; next.hash = '';
  return next;
}
// The Location ply would rebase to, or null when it does not keep the info/refs suffix (the caller then reports the
// redirect and does not request it). git's curl requests the Location first and update_url_from_redirect dies after;
// refusing first is that die, without handing the next host a request. allowUrl sees the Location and its URL is the
// one the suffix rule is applied to. Userinfo on the Location is removed and is never installed as a credential.
function locationBase(asked: string, location: string | null, service: string, allow: AllowUrl | undefined): string | null {
  if (location === null || location === '') return null;
  let got: URL;
  try { got = new URL(location, asked); } catch { return null; }
  got.username = ''; got.password = ''; got.hash = '';
  return baseFromRedirect(asked, useAllowed(allow, got), service);
}
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
type HttpOptionsFields = {
  readonly auth?: HttpAuth | null | undefined;
  readonly tracer?: Tracer | undefined;
  readonly parent?: Span | null | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly userAgent?: string | undefined;
  readonly limits?: Limits | undefined;
  readonly signal?: AbortSignal | null | undefined;
  readonly quirks?: Quirks | undefined;
};
// Response header names to copy onto each exchange span. Omission records none (the span contract is unchanged).
type RecordedHeaders = { readonly recordResponseHeaders: readonly string[] };
export type HttpOptions = HttpOptionsFields & Partial<RecordedHeaders>;
export type HttpTransport = Transport & { readonly kind: 'http'; readonly quirks: Quirks; readonly objects: NonNullable<Transport['objects']> };

// oxlint-disable-next-line complexity -- the constructor resolves every credential form in one place
export function createTransport(url: string | URL, options: HttpOptions = {}): HttpTransport {
  const { auth, tracer, parent = null, fetchImpl = globalThis.fetch, userAgent = UA, limits = DEFAULT_LIMITS, signal = null, quirks = {}, recordResponseHeaders } = options as HttpOptions;
  const extra = options as unknown as { followRedirects?: FollowRedirects; allowUrl?: AllowUrl; maxRedirects?: number };
  const policy = redirectPolicy(extra.followRedirects, extra.maxRedirects);
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
  u.username = ''; u.password = ''; u.hash = '';
  // allowUrl runs before any request, including the base. A different origin does not inherit this transport's credential.
  const offeredOrigin = u.origin;
  const approvedUrl = useAllowed(extra.allowUrl, u);
  let base = approvedUrl.toString().replace(/\/$/, '');
  const baseCrossOrigin = approvedUrl.origin !== offeredOrigin;
  // Workers: fetch is a method of the global and throws "Illegal invocation" when called detached; bind it (found under workerd)
  const f = fetchImpl === globalThis.fetch ? fetchImpl.bind(globalThis) : fetchImpl;
  // cachingFetch reads this and strips it (packcache.ts). Any other fetchImpl must not see it: it would go to the origin.
  const recordHint = (): Record<string, string> => recordNames.length > 0 && Object.hasOwn(f, CACHING_FETCH_BRAND) ? { [RECORD_HEADERS_REQUEST]: recordNames.join(',') } : {};
  // Whatever form, the value never reaches a span or an error message (`scrub`), even echoed.
  // oxlint-disable-next-line no-nested-ternary -- three forms, one pair
  const [authorization, given]: [string | null, Basic | null] = fromUrl ? [`Basic ${btoa(`${fromUrl.user}:${fromUrl.pass}`)}`, null] : auth !== null && auth !== undefined ? explicitAuth(auth) : [null, null];
  // The credential sent from here on. A cross-origin rebase (or an allowUrl that moved the base) clears it; the
  // scrubber above still redacts the original, so an echo of it cannot leak.
  let liveAuth = baseCrossOrigin ? null : authorization;
  let rebasedFrom: string | null = null;
  let redirectCount = 0;
  let initialSettled = false;
  // The Basic parts as a server would echo them (UTF-8 text). From a header they are decoded, as bytes and as UTF-8.
  const decoded = ((): Basic | null => { if (authorization === null || !/^Basic\s/i.test(authorization)) return null; try { const d = atob(authorization.replace(/^Basic\s+/i, '')); const c = d.indexOf(':'); return c < 0 ? { user: d, pass: '' } : { user: d.slice(0, c), pass: d.slice(c + 1) }; } catch { return null; } })();
  const basic = given ?? (decoded && { user: utf8(decoded.user), pass: utf8(decoded.pass) });
  const a = fromNullish(auth);
  const userOpt = a.tag === 'some' ? fromNullish(a.value.user) : { tag: 'none' as const };
  const user = userOpt.tag === 'some' ? userOpt.value : (basic ? basic.user : null);
  const userSecret = basic ? secretUser(basic.user, basic.pass !== '') : secretShaped(user);
  // Every string a server can send back (error bodies, ERR lines, band-2/3 text, ng reasons, hook output) passes through
  // `scrub` before it reaches an error or a span: the transport carries it (`t.scrub`) and otel.js applies it.
  const tokOpt = a.tag === 'some' ? fromNullable(a.value.token) : { tag: 'none' as const };
  const bearOpt = a.tag === 'some' ? fromNullable(a.value.bearer) : { tag: 'none' as const };
  const authHeaderScrub = authorization === null ? null : authorization.replace(/^\S+\s+/, '');
  const basicPass = basic ? basic.pass : null;
  const decodedPass = decoded ? decoded.pass : null;
  const basicUser = userSecret ? (basic ? basic.user : user ?? null) : null;
  const decodedUser = userSecret ? (decoded ? decoded.user : null) : null;
  const scrub = scrubber([authorization, tokOpt.tag === 'some' ? tokOpt.value : null, bearOpt.tag === 'some' ? bearOpt.value : null, authHeaderScrub, basicPass, decodedPass, basicUser, decodedUser, secretShaped(user) ? (user ?? null) : null]);
  const hostOf = (): string => new URL(base).host;
  // Only once a redirect was actually followed, so a transport that never rebases keeps today's span shape.
  const redirectAttrs = (): Attrs => {
    if (redirectCount === 0 || rebasedFrom === null) return {};
    const from = redactUrl(rebasedFrom);
    return { 'http.redirect.count': redirectCount, 'git.remote.rebased_from': scrub ? scrub(from) : from };
  };
  const rebase = (next: string): void => {
    if (new URL(next).origin !== new URL(base).origin) liveAuth = null;
    if (rebasedFrom === null) rebasedFrom = base;
    base = next;
    redirectCount += 1;
  };
  const headers = (service: string, extra: Record<string, string> = {}): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': `application/x-${service}-request`, Accept: `application/x-${service}-result`, 'User-Agent': userAgent, ...extra };
    // oxlint-disable-next-line typescript/strict-boolean-expressions -- null and '' send no Authorization, as before
    if (liveAuth) h['Authorization'] = liveAuth;
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

  const fetchAdvertisement = async (asked: string, service: string, span: Span, sig: AbortSignal): Promise<Response> => {
    const t0 = Date.now();
    let res: Response;
    try { res = await f(asked, { headers: headers(service, { 'Git-Protocol': 'version=2', ...recordHint() }), signal: sig, redirect: 'manual' }); }
    catch (e) { throw wrapNet(e, sig); }
    span.set({ 'http.response.status_code': res.status, 'http.response.ttfb_ms': Date.now() - t0, 'http.response.header.content-type': res.headers.get('content-type') ?? '' });
    return res;
  };
  const advertisementBody = async (res: Response, service: string, span: Span): Promise<Uint8Array> => {
    if (!res.ok) throw fail(httpCode(res.status), `HTTP ${res.status} ${service} advertisement`, { status: res.status, ...(res.status === 404 ? { miss: { kind: 'repository' as const } } : {}) } as Detail['http'] & Extra);
    if (!(res.headers.get('content-type') ?? '').startsWith(`application/x-${service}-advertisement`)) throw fail('not_git', `unexpected content-type from ${service} advertisement`);
    const maxPack = requireLimit(limits, 'maxPackBytes');
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxPack) {
      await cancelBody(res.body);
      throw limitError('advertisement bytes', declared, maxPack);
    }
    if (missingBody(res.body)) throw fail('protocol', `${service} advertisement: HTTP ${res.status} response has no body`);
    const buf = await readCapped(res.body, maxPack, { what: 'advertisement bytes' });
    span.set({ 'git.response.bytes': buf.length, 'http.response.body.size': buf.length, ...redirectAttrs() });
    return buf;
  };
  // A 3xx on the initial GET. Returns the next base, or null when `res` is not a redirect. A redirect that is not
  // followed (the default, a hop past maxRedirects, a Location that fails the suffix rule) is the existing http error.
  async function redirectHop(res: Response, asked: string, service: string, following: boolean): Promise<string | null> {
    if (!isRedirect(res)) return null;
    const room = following && redirectCount < policy.max;
    if (!room) {
      initialSettled = true;
      throw await redirectError(res, asked, `${service} advertisement`, scrub);
    }
    let next: string | null = null;
    try { next = locationBase(asked, res.headers.get('location'), service, extra.allowUrl); }
    catch (e) { await cancelBody(res.body); throw e; }
    if (next === null) {
      initialSettled = true;
      throw await redirectError(res, asked, `${service} advertisement`, scrub);
    }
    await cancelBody(res.body);
    return next;
  }
  // GET info/refs?service=… . With followRedirects 'initial' and no settled exchange yet, a suffix-preserving 3xx
  // rebases `base` (up to maxRedirects) and the GET is retried there. A network failure leaves the exchange unsettled
  // so a retry continues from the base already reached.
  async function advertise(service: string, span: Span): Promise<Uint8Array> {
    const following = policy.follow === 'initial' && !initialSettled;
    // Each hop's URL is the previous response's Location, so the next GET cannot start until this one has been read.
    // oxlint-disable no-await-in-loop
    for (;;) {
      const asked = `${base}/info/refs?service=${service}`;
      span.set({ 'git.transport': 'http', 'http.request.method': 'GET', 'url.full': redactUrl(asked), 'server.address': hostOf(), ...redirectAttrs() });
      const sig = requestSignal();
      try {
        const res = await fetchAdvertisement(asked, service, span, sig.signal);
        if (recordNames.length > 0) span.set(recordedHeaderAttrs(res, recordNames, scrub));
        const next = await redirectHop(res, asked, service, following);
        if (next !== null) { rebase(next); continue; }
        initialSettled = true;
        return await advertisementBody(res, service, span);
      } finally { sig.cancel(); }
    }
    // oxlint-enable no-await-in-loop
  }
  // POST and yield body chunks, filling span with HTTP attrs. Async generator keeps memory at one chunk.
  async function* post(service: string, body: Uint8Array, span: Span, hints: Hints): AsyncGenerator<Uint8Array, void, undefined> {
    if (policy.follow === 'initial' && !initialSettled) await advertise(service, span);
    const target = `${base}/${service}`;
    // oxlint-disable-next-line typescript/strict-boolean-expressions -- an absent hint is no hint
    const extra = { 'Git-Protocol': 'version=2', ...recordHint(), ...(hints.bypassCache ? { 'x-ply-cache': 'bust' } : {}) };
    span.set({ 'git.transport': 'http', 'http.request.method': 'POST', 'url.full': redactUrl(target), 'server.address': hostOf(), 'git.request.bytes': body.length, 'http.request.body.size': body.length, 'git.service': service, 'git.limits.request_timeout_ms': limits.requestTimeoutMs, ...redirectAttrs() });
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
      throw fail(httpCode(res.status), `HTTP ${res.status} ${service}: ${(scrub ? scrub(preview) : preview).slice(0, ERROR_QUOTE)}`, { status: res.status, ...(res.status === 404 ? { miss: { kind: 'repository' as const } } : {}) } as Detail['http'] & Extra);
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
    kind: 'http', get url(): string { return base; }, tracer: tracer as Tracer, parent, limits, signal, quirks, objects: new Map(), scrub,
    async *frames(service: string, body: Uint8Array, span: Span, hints: Hints = {}): AsyncGenerator<Frame, void, undefined> {
      let st: ReturnType<typeof pktStep>['state'] = pktInit();
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pktline.js is untyped until its cluster converts; its frames are Frame
      for await (const chunk of post(service, body, span, hints)) { const r = pktStep(st, chunk); st = r.state; yield* r.frames as Frame[]; }
      pktFinish(st);
      span.set(pktAttrs(st));
    },
    // GET info/refs?service=… (capability advertisements). Returns the whole body; advertisements are small.
    advertise,
  };
}
