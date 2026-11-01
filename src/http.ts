// Smart-HTTP transport: one POST per git command, body chunks yielded as they arrive, every request a CLIENT span.
// Implements the contract in transport.js. `createTransport` is its constructor (the name every caller used first).
// The checks (credential forms, redirect policy, header names, the Location rule, status and redirect errors, capped
// reads) return Result; the transport's two methods and its constructor are the edge that throws.
/* oxlint-disable require-unicode-regexp -- URL, header and credential text; `u` costs a byte per literal and changes what /i matches (U+017F, U+212A) */
import type { Code, Detail, ErrorOf, Extra, PlyError } from './errors.js';
import type { Result } from './result.js';
import { field, fillIn, fromNullable, withDefaults } from './absent.js';
import type { Input } from './absent.js';
import { assertNever, err, ok } from './result.js';
import type { Limits } from './limits.js';
import type { Span, Tracer } from './otel.js';
import type { Attrs, Frame, Hints, Quirks, Scrub, Transport } from './transport.js';
import { fail, orThrow, thrown } from './errors.js';
import { pktInit, pktStepResult, pktFinishResult, pktAttrs } from './pktline.js';
import type { PktState } from './pktline.js';
import { bufferSource, concat, td, te } from './bytes.js';
import { scrubber, secretShaped, secretUser } from './scrub.js';
import { DEFAULT_LIMITS, limitExceeded, readLimit } from './limits.js';
import { validateWire } from './validate.js';
import { NO_HINTS, UA, freshQuirks, wrapNet } from './transport.js';

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
type BadRequest = ErrorOf<'bad_request'>;

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

// A response header's value, '' when the response did not send it.
const headerText = (res: Response, name: string): string => { const v = res.headers.get(name); return v === null ? '' : v; };

function recordResponseHeaderNames(list: unknown): Result<readonly string[], BadRequest> {
  if (!Array.isArray(list)) return fail('bad_request', 'recordResponseHeaders: expected a list of header names', { what: 'recordResponseHeaders' });
  if (list.length > MAX_RECORDED_HEADERS) return fail('bad_request', `recordResponseHeaders: at most ${MAX_RECORDED_HEADERS} names`, { what: 'recordResponseHeaders' });
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of list) {
    if (typeof name !== 'string' || !HEADER_NAME.test(name)) {
      const shown = typeof name === 'string' ? JSON.stringify(name) : 'not a string';
      return fail('bad_request', `recordResponseHeaders: ${shown} is not a header name`, { what: 'recordResponseHeaders' });
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return ok(out);
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

// A header field the caller gave (null: none given) is one line. validateWire (validate.ts) throws until its cluster converts.
const headerField = (value: string | null, what: string): void => { if (value !== null) validateWire(value, what); };

// URL userinfo → the bytes git sends for it (git 2.50, measured against http-backend behind Basic auth), as a byte
// string `btoa` takes as is: `%XX` is that byte (`%FF` → 0xFF, UTF-8 as its bytes), anything else as written (`%ZZ`
// stays `%ZZ`; WHATWG URL has already percent-encoded every non-ASCII character). A NUL, CR or LF is refused: git
// refuses LF ("credential url cannot be parsed") and NUL (curl: "bad/illegal format") and sends CR; Basic would carry
// any of them, but no host means one.
const userinfo = (s: string): Result<string, BadRequest> => {
  // oxlint-disable-next-line unicorn/prefer-string-replace-all, unicorn/prefer-number-properties, unicorn/prefer-code-point -- same results (a /g regex; one global parseInt; bytes 0-255), fewer bytes
  const b = s.replace(/%([0-9a-f]{2})/gi, (_: string, h: string) => String.fromCharCode(parseInt(h, 16)));
  if (/[\0\r\n]/.test(b)) return fail('bad_request', 'invalid url userinfo: must not contain NUL, CR, or LF', { what: 'url userinfo' });
  return ok(b);
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
const noCredential = (why: string): Result<never, BadRequest> => fail('bad_request', `invalid auth: ${why}`, { what: 'auth' });

// The explicit `auth` → [Authorization value, its Basic parts or null]. Every form yields a credential or is refused:
// an `auth` that sends nothing is the silent trap #32 was (every request anonymous, a 401 saying nothing about why).
//   { header }        the value verbatim (a proxy forwarding its caller's credential)
//   { token, user? }  Basic `user:token`, user defaulting to `x-access-token`; the text is sent as its UTF-8 bytes, as git
//                     sends a credential helper's (measured: `username=tëst password=päss` → those bytes)
//   { bearer }        Bearer
//   { user }          refused. git's own credential API asks for the password when a helper gives a user alone (measured:
//                     "could not read Password", nothing sent) and a library cannot ask; `token: ''` is the explicit
//                     empty password and sends `user:` (git, helper `password=` empty: `ivar:`), the URL `user@` form.
// The explicit credential forms, total: null is a form not given. A caller may leave any of them out (HttpAuth).
export type HttpAuthConfig = { readonly header: string | null; readonly token: string | null; readonly user: string | null; readonly bearer: string | null };
export type HttpAuth = Input<HttpAuthConfig>;
const noAuth = (): HttpAuthConfig => ({ header: null, token: null, user: null, bearer: null });
type Basic = { readonly user: string; readonly pass: string };
function explicitAuth({ header, token, user, bearer }: HttpAuthConfig): Result<[string, Basic | null], BadRequest> {
  if (header !== null) {
    if (!ASCII_VALUE.test(header)) return noCredential('the authorization header must be non-empty printable ASCII');
    return ok([header, null]);
  }
  if (token !== null) {
    if (token === '' && user === null) return noCredential('an empty token with no user carries no credential');
    const name = user === null ? 'x-access-token' : user;
    return ok([`Basic ${btoa(latin1(te.encode(`${name}:${token}`)))}`, { user: name, pass: token }]);
  }
  if (bearer !== null) {
    if (!ASCII_VALUE.test(bearer)) return noCredential('the bearer token must be non-empty printable ASCII');
    return ok([`Bearer ${bearer}`, null]);
  }
  if (user !== null) return noCredential('a user with no token; pass the token, or token: \'\' to send the user alone (Basic `user:`)');
  return noCredential('no token, bearer or header; omit auth to send none');
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
export type RedirectPolicy = { readonly follow: FollowRedirects; readonly max: number };
const shown = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null ? JSON.stringify(v) : typeof v);
export function redirectPolicyResult(follow: unknown, max: unknown): Result<RedirectPolicy, BadRequest> {
  const f = fromNullable(follow);
  if (f.tag === 'some' && f.value !== 'never' && f.value !== 'initial') return fail('bad_request', `followRedirects must be 'never' or 'initial', got ${shown(f.value)}`, { what: 'followRedirects' });
  const m = fromNullable(max);
  const raw = m.tag === 'none' ? DEFAULT_MAX_REDIRECTS : m.value;
  const n = typeof raw === 'number' && Number.isSafeInteger(raw) ? raw : null;
  if (n === null || n < 0 || n > MAX_REDIRECT_HOPS) return fail('bad_request', `maxRedirects must be an integer from 0 to ${MAX_REDIRECT_HOPS}`, { what: 'maxRedirects' });
  return ok({ follow: f.tag === 'some' && f.value === 'initial' ? 'initial' : 'never', max: n });
}
export const redirectPolicy = (follow: unknown, max: unknown): RedirectPolicy => orThrow(redirectPolicyResult(follow, max));
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
  return v.ok === true || v.ok === false;
}
// The caller's allowUrl, applied. Its own Err is the answer as given; an allowUrl that throws throws through.
function useAllowed(allow: AllowUrl | null, url: URL): Result<URL, PlyError> {
  if (allow === null) return ok(url);
  const got: unknown = allow(url);
  if (!isUrlResult(got)) return fail('bad_request', 'allowUrl must return a Result', { what: 'allowUrl' });
  if (!got.ok) return got;
  const next = got.value;
  if (!(next instanceof URL) || (next.protocol !== 'http:' && next.protocol !== 'https:')) return fail('bad_request', 'allowUrl must return an http(s) URL', { what: 'allowUrl' });
  next.username = ''; next.password = ''; next.hash = '';
  return ok(next);
}
// The Location ply would rebase to, or null when it does not keep the info/refs suffix (the caller then reports the
// redirect and does not request it). git's curl requests the Location first and update_url_from_redirect dies after;
// refusing first is that die, without handing the next host a request. allowUrl sees the Location and its URL is the
// one the suffix rule is applied to. Userinfo on the Location is removed and is never installed as a credential.
function locationBase(asked: string, location: string | null, service: string, allow: AllowUrl | null): Result<string | null, PlyError> {
  if (location === null || location === '') return ok(null);
  let got: URL;
  try { got = new URL(location, asked); } catch { return ok(null); }
  got.username = ''; got.password = ''; got.hash = '';
  const allowed = useAllowed(allow, got);
  if (!allowed.ok) return allowed;
  return ok(baseFromRedirect(asked, allowed.value, service));
}
const isRedirect = (res: Response): boolean => res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
// A body a test double may not implement `cancel` on, and a real one whose `cancel()` rejects. The rejection is the
// body's, not the caller's: it must be awaited, or it is an unhandled rejection the surrounding `try` cannot catch.
async function cancelBody(body: unknown): Promise<void> {
  const cancel = field(body, 'cancel');
  // A `cancel` that is not a function was a TypeError, caught here: skipping it is the same outcome.
  try { if (cancel.tag === 'some' && typeof cancel.value === 'function') await Reflect.apply(cancel.value, body, []); } catch { /* unopened or already closed */ }
}
// A 2xx whose body is missing never reached the pkt-line parser. Iterating it threw TypeError, and wrapNet reported
// `network`. There is no git message to parse: that is `protocol`. A body is present or it is not: no third reading.
type Body = { readonly tag: 'body'; readonly stream: ReadableStream<Uint8Array> } | { readonly tag: 'missing' };
const bodyOf = (res: Response): Body => {
  const b = field(res, 'body');
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a present Response body is its stream
  return b.tag === 'some' ? { tag: 'body', stream: b.value as ReadableStream<Uint8Array> } : { tag: 'missing' };
};
async function redirectError(res: Response, url: string, what: string, scrub: Scrub | null): Promise<ErrorOf<'http'>> {
  let to = '';
  const loc = res.headers.get('location');
  // oxlint-disable-next-line typescript/strict-boolean-expressions -- null and '' are no Location, as before
  if (loc) try { const x = new URL(loc, url); to = `${x.origin}${x.pathname}`; } catch { /* unparseable Location */ }
  if (scrub) to = scrub(to);
  await cancelBody(res.body);
  return thrown('http', `HTTP ${res.status} ${what}: redirected${to ? ` to ${to}` : ''}; ply does not follow redirects (update the remote URL)`, { status: res.status, location: to } as Detail['http'] & Extra);
}

// Read a body without ever holding more than `max` bytes. `truncate` keeps a prefix (error pages);
// otherwise the first chunk that would pass the cap is the error and is not retained.
type CapRead = { readonly what: string; readonly truncate: boolean };
const PREVIEW_READ: CapRead = { what: 'response bytes', truncate: true };
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number, { what, truncate }: CapRead): Promise<Result<Uint8Array, ErrorOf<'limit_exceeded'>>> {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- a fetch double may hand back a body that is not async-iterable
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') return ok(new Uint8Array(0));
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for await (const chunk of body) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (n + bytes.length > max) {
        if (!truncate) return err(limitExceeded(what, n + bytes.length, max));
        if (max > n) chunks.push(bytes.subarray(0, max - n));
        break;
      }
      chunks.push(bytes);
      n += bytes.length;
    }
  } finally { await cancelBody(body); }
  return ok(concat(chunks));
}

// A non-2xx answer: a prefix of the body for the message (credential-scrubbed), the rest cancelled.
async function statusError(res: Response, service: string, scrub: Scrub | null): Promise<PlyError> {
  const read = await readCapped(res.body, ERROR_PREVIEW, PREVIEW_READ);
  // A truncating read keeps a prefix: it has no error to report.
  const preview = td.decode(read.ok ? read.value : new Uint8Array(0));
  const quoted = (scrub ? scrub(preview) : preview).slice(0, ERROR_QUOTE);
  const miss = res.status === 404 ? { miss: { kind: 'repository' as const } } : {};
  return thrown(httpCode(res.status), `HTTP ${res.status} ${service}: ${quoted}`, { status: res.status, ...miss } as Detail['http'] & Extra);
}
// What the transport calls: the platform fetch, or a wrapper with its signature (packcache.ts cachingFetch).
export type FetchLike = (url: string | URL, init: RequestInit) => Promise<Response>;
// The transport's configuration, total. `null` is "none given": no credential, no parent span, no abort signal, no
// allowUrl hook. recordResponseHeaders names the response headers copied onto each exchange span (none by default, so
// the span contract is unchanged).
export type HttpConfig = {
  readonly auth: HttpAuth | null;
  readonly tracer: Tracer | null;
  readonly parent: Span | null;
  readonly fetchImpl: FetchLike;
  readonly userAgent: string;
  readonly limits: Limits;
  readonly signal: AbortSignal | null;
  readonly quirks: Input<Quirks>;
  readonly followRedirects: FollowRedirects;
  readonly allowUrl: AllowUrl | null;
  readonly maxRedirects: number;
  readonly recordResponseHeaders: readonly string[];
};
export type HttpOptions = Input<HttpConfig>;
// Fresh per transport: quirks are learned per server and must not leak between transports.
const httpDefaults = (): { -readonly [K in keyof HttpConfig]: HttpConfig[K] } => ({
  auth: null, tracer: null, parent: null, fetchImpl: globalThis.fetch, userAgent: UA, limits: DEFAULT_LIMITS, signal: null,
  quirks: freshQuirks(), followRedirects: 'never', allowUrl: null, maxRedirects: DEFAULT_MAX_REDIRECTS, recordResponseHeaders: [],
});
export type HttpTransport = Transport & { readonly kind: 'http' };

// The URL's userinfo as the Basic parts git sends for it, or null when the URL carries none (or `auth` is explicit).
function urlCredential(auth: HttpAuth | null, u: URL, url: string | URL): Result<Basic | null, BadRequest> {
  if (auth !== null || !(u.username || u.password || emptyUserinfo(url))) return ok(null);
  const user = userinfo(u.username);
  if (!user.ok) return user;
  const pass = userinfo(u.password);
  if (!pass.ok) return pass;
  return ok({ user: user.value, pass: pass.value });
}
// The Basic parts of an Authorization value as a server would echo them, or null when it is not Basic or not base64.
const basicOf = (authorization: string | null): Basic | null => {
  if (authorization === null || !/^Basic\s/i.test(authorization)) return null;
  try {
    const d = atob(authorization.replace(/^Basic\s+/i, ''));
    const c = d.indexOf(':');
    return c < 0 ? { user: d, pass: '' } : { user: d.slice(0, c), pass: d.slice(c + 1) };
  } catch { return null; }
};
// Node's timer has unref (the DOM lib types it as a number); a Worker's has none.
const unref = (timer: unknown): void => {
  const f = field(timer, 'unref');
  if (f.tag === 'some' && typeof f.value === 'function') Reflect.apply(f.value, timer, []);
};

// oxlint-disable-next-line complexity -- the constructor resolves every credential form in one place
export function createTransport(url: string | URL, options: HttpOptions = {}): HttpTransport {
  const { auth, tracer, parent, fetchImpl, userAgent, limits, signal, quirks: givenQuirks, recordResponseHeaders, followRedirects, allowUrl, maxRedirects } = withDefaults(options, httpDefaults());
  const policy = orThrow(redirectPolicyResult(followRedirects, maxRedirects));
  // the caller's record, filled in place: every later call that passes it sees what this transport learns
  const quirks: Quirks = fillIn(givenQuirks, freshQuirks());
  headerField(userAgent, 'user agent');
  const recordNames = orThrow(recordResponseHeaderNames(recordResponseHeaders));
  // The explicit forms, total (all null without auth).
  const given = auth === null ? noAuth() : withDefaults(auth, noAuth());
  headerField(given.header, 'authorization');
  headerField(given.token, 'token');
  headerField(given.bearer, 'bearer');
  headerField(given.user, 'auth user');
  // `new URL` puts what it was given on the TypeError (`input`): a credential in a malformed URL would ride out on it.
  let u: URL;
  try { u = new URL(url); } catch { return orThrow(fail('bad_request', 'invalid url: not an absolute URL', { what: 'url' })); }
  // userinfo in the URL becomes the Basic credential git sends for it, byte for byte: `user:password`; a user alone is
  // `user:` (a token given as the user, which GitHub and GitLab accept; git sends it without asking for a password and
  // asks only once it is refused), a password alone `:password`, an empty userinfo `:`. Explicit `auth` wins. It never
  // appears again: not in requests, not in spans, not in error messages.
  const fromUrl = orThrow(urlCredential(auth, u, url));
  u.username = ''; u.password = ''; u.hash = '';
  // allowUrl runs before any request, including the base. A different origin does not inherit this transport's credential.
  const offeredOrigin = u.origin;
  const approvedUrl = orThrow(useAllowed(allowUrl, u));
  let base = approvedUrl.toString().replace(/\/$/, '');
  const baseCrossOrigin = approvedUrl.origin !== offeredOrigin;
  // Workers: fetch is a method of the global and throws "Illegal invocation" when called detached; bind it (found under workerd)
  const f = fetchImpl === globalThis.fetch ? fetchImpl.bind(globalThis) : fetchImpl;
  // cachingFetch reads this and strips it (packcache.ts). Any other fetchImpl must not see it: it would go to the origin.
  const recordHint = (): Record<string, string> => recordNames.length > 0 && Object.hasOwn(f, CACHING_FETCH_BRAND) ? { [RECORD_HEADERS_REQUEST]: recordNames.join(',') } : {};
  // Whatever form, the value never reaches a span or an error message (`scrub`), even echoed.
  // oxlint-disable-next-line no-nested-ternary -- three forms, one pair
  const [authorization, explicitBasic]: [string | null, Basic | null] = fromUrl ? [`Basic ${btoa(`${fromUrl.user}:${fromUrl.pass}`)}`, null] : auth === null ? [null, null] : orThrow(explicitAuth(given));
  // The credential sent from here on. A cross-origin rebase (or an allowUrl that moved the base) clears it; the
  // scrubber above still redacts the original, so an echo of it cannot leak.
  let liveAuth = baseCrossOrigin ? null : authorization;
  let rebasedFrom: string | null = null;
  let redirectCount = 0;
  let initialSettled = false;
  // The Basic parts as a server would echo them (UTF-8 text). From a header they are decoded, as bytes and as UTF-8.
  const decoded = basicOf(authorization);
  // oxlint-disable-next-line no-nested-ternary -- the explicit parts, else the decoded ones, else none
  const basic = explicitBasic === null ? (decoded === null ? null : { user: utf8(decoded.user), pass: utf8(decoded.pass) }) : explicitBasic;
  const basicUserOrNull = basic ? basic.user : null;
  const user = given.user === null ? basicUserOrNull : given.user;
  const userSecret = basic ? secretUser(basic.user, basic.pass !== '') : secretShaped(user);
  // Every string a server can send back (error bodies, ERR lines, band-2/3 text, ng reasons, hook output) passes through
  // `scrub` before it reaches an error or a span: the transport carries it (`t.scrub`) and otel.js applies it.
  const authHeaderScrub = authorization === null ? null : authorization.replace(/^\S+\s+/, '');
  const basicPass = basic ? basic.pass : null;
  const decodedPass = decoded ? decoded.pass : null;
  const echoedUser = basic ? basic.user : user;
  const decodedUserOrNull = decoded ? decoded.user : null;
  const basicUser = userSecret ? echoedUser : null;
  const decodedUser = userSecret ? decodedUserOrNull : null;
  const scrub = scrubber([authorization, given.token, given.bearer, authHeaderScrub, basicPass, decodedPass, basicUser, decodedUser, secretShaped(user) ? user : null]);
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
    const ms = orThrow(readLimit(limits, 'requestTimeoutMs'));
    const ac = new AbortController();
    const timer = setTimeout(() => { ac.abort(new DOMException(`request exceeded ${ms} ms`, 'TimeoutError')); }, ms);
    unref(timer);
    const sig = signal ? AbortSignal.any([ac.signal, signal]) : ac.signal;
    return { signal: sig, cancel: () => { clearTimeout(timer); } };
  };

  const fetchAdvertisement = async (asked: string, service: string, span: Span, sig: AbortSignal): Promise<Response> => {
    const t0 = Date.now();
    let res: Response;
    try { res = await f(asked, { headers: headers(service, { 'Git-Protocol': 'version=2', ...recordHint() }), signal: sig, redirect: 'manual' }); }
    catch (e) { throw wrapNet(e, sig); }
    span.set({ 'http.response.status_code': res.status, 'http.response.ttfb_ms': Date.now() - t0, 'http.response.header.content-type': headerText(res, 'content-type') });
    return res;
  };
  const advertisementBody = async (res: Response, service: string, span: Span): Promise<Result<Uint8Array, PlyError>> => {
    if (!res.ok) return fail(httpCode(res.status), `HTTP ${res.status} ${service} advertisement`, { status: res.status, ...(res.status === 404 ? { miss: { kind: 'repository' as const } } : {}) } as Detail['http'] & Extra);
    if (!headerText(res, 'content-type').startsWith(`application/x-${service}-advertisement`)) return fail('not_git', `unexpected content-type from ${service} advertisement`);
    const maxPack = readLimit(limits, 'maxPackBytes');
    if (!maxPack.ok) return maxPack;
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxPack.value) {
      await cancelBody(res.body);
      return err(limitExceeded('advertisement bytes', declared, maxPack.value));
    }
    const body = bodyOf(res);
    switch (body.tag) {
      case 'missing': return fail('protocol', `${service} advertisement: HTTP ${res.status} response has no body`);
      case 'body': {
        const buf = await readCapped(body.stream, maxPack.value, { what: 'advertisement bytes', truncate: false });
        if (buf.ok) span.set({ 'git.response.bytes': buf.value.length, 'http.response.body.size': buf.value.length, ...redirectAttrs() });
        return buf;
      }
    }
    // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
    return assertNever(body);
  };
  // A 3xx on the initial GET. Returns the next base, or null when `res` is not a redirect. A redirect that is not
  // followed (the default, a hop past maxRedirects, a Location that fails the suffix rule) is the existing http error.
  async function redirectHop(res: Response, asked: string, service: string, following: boolean): Promise<Result<string | null, PlyError>> {
    if (!isRedirect(res)) return ok(null);
    const room = following && redirectCount < policy.max;
    if (!room) {
      initialSettled = true;
      return err(await redirectError(res, asked, `${service} advertisement`, scrub));
    }
    let next: Result<string | null, PlyError>;
    // allowUrl is the caller's code: if it throws, the body is still released before that propagates.
    try { next = locationBase(asked, res.headers.get('location'), service, allowUrl); }
    catch (e) { await cancelBody(res.body); throw e; }
    if (!next.ok) { await cancelBody(res.body); return next; }
    if (next.value === null) {
      initialSettled = true;
      return err(await redirectError(res, asked, `${service} advertisement`, scrub));
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
        const next = orThrow(await redirectHop(res, asked, service, following));
        if (next !== null) { rebase(next); continue; }
        initialSettled = true;
        return orThrow(await advertisementBody(res, service, span));
      } finally { sig.cancel(); }
    }
    // oxlint-enable no-await-in-loop
  }
  // The POST's answer, checked before its body is read: a redirect, a non-2xx, a foreign content type, a missing body.
  const postStream = async (res: Response, service: string, target: string): Promise<Result<ReadableStream<Uint8Array>, PlyError>> => {
    if (isRedirect(res)) return err(await redirectError(res, target, service, scrub));
    // Keep a prefix for the message (and for credential scrubbing). The rest of a huge error page is cancelled.
    if (!res.ok) return err(await statusError(res, service, scrub));
    const ct = headerText(res, 'content-type');
    if (!ct.startsWith(`application/x-${service}-result`)) return fail('not_git', `unexpected content-type ${JSON.stringify(ct)} from ${service}`);
    const body = bodyOf(res);
    switch (body.tag) {
      case 'missing': return fail('protocol', `${service}: HTTP ${res.status} response has no body`);
      case 'body': return ok(body.stream);
    }
    // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
    return assertNever(body);
  };
  // POST and yield body chunks, filling span with HTTP attrs. Async generator keeps memory at one chunk.
  async function* post(service: string, body: Uint8Array, span: Span, hints: Hints): AsyncGenerator<Uint8Array, void, unknown> {
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
    const cache = headerText(res, PACK_CACHE_HEADER);
    span.set({ 'http.response.status_code': res.status, 'http.response.header.content-type': headerText(res, 'content-type'), 'http.response.ttfb_ms': Date.now() - t0, 'git.response.cache': cache, 'git.pack.cache': cache });
    if (recordNames.length > 0) span.set(recordedHeaderAttrs(res, recordNames, scrub));
    const stream = orThrow(await postStream(res, service, target));
    let bytes = 0, chunks = 0, first = -1, maxChunk = 0;
    try { for await (const chunk of stream) {
      if (chunks === 0) first = Date.now() - t0;
      bytes += chunk.length; chunks++; if (chunk.length > maxChunk) maxChunk = chunk.length;
      yield chunk;
    } } catch (e) { throw wrapNet(e, sig.signal); }
    span.set({ 'git.response.bytes': bytes, 'git.response.first_byte_ms': first, 'git.response.duration_ms': Date.now() - t0, 'http.response.body.size': bytes, 'http.response.chunks': chunks, 'http.response.chunk.max': maxChunk, 'http.response.first_byte_ms': first, 'http.response.duration_ms': Date.now() - t0 });
    } finally { sig.cancel(); }
  }

  return {
    // quirks: what this server was found to need (shared by every view of the transport; a caller may pass one object to
    // many transports for the same server). objects: commits/trees harvested from over-wide packs (fetch.js).
    // scrub: the credential's forms → '[redacted]' (null without auth); spans under this transport apply it (otel.js).
    // A transport without a tracer fails on its first span, as it always has. A3: require it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- see above
    kind: 'http', get url(): string { return base; }, tracer: tracer as Tracer, parent, limits, signal, quirks, objects: new Map(), scrub,
    async *frames(service: string, body: Uint8Array, span: Span, hints: Hints = NO_HINTS): AsyncGenerator<Frame, void, unknown> {
      let st: PktState = pktInit();
      for await (const chunk of post(service, body, span, hints)) { const r = orThrow(pktStepResult(st, chunk)); st = r.state; yield* r.frames; }
      orThrow(pktFinishResult(st));
      span.set(pktAttrs(st));
    },
    // GET info/refs?service=… (capability advertisements). Returns the whole body; advertisements are small.
    advertise,
  };
}
