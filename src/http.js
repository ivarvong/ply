// Smart-HTTP transport: one POST per git command, body chunks yielded as they arrive, every request a CLIENT span.
// Implements the contract in transport.js. `createTransport` is its constructor (the name every caller used first).
import { fail } from './errors.js';
import { pktInit, pktStep, pktFinish, pktAttrs } from './pktline.js';
import { concat, td, te } from './bytes.js';
import { scrubber, secretShaped, secretUser } from './scrub.js';
import { DEFAULT_LIMITS, requireLimit, limitError } from './limits.js';
import { validateWire } from './validate.js';
import { UA, wrapNet } from './transport.js';

export const redactUrl = u => { try { const x = new URL(u); x.username = ''; x.password = ''; return x.toString(); } catch { return '<invalid url>'; } };
export const httpCode = status => status === 401 || status === 403 ? 'auth' : status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : status >= 500 ? 'upstream_5xx' : 'http';

// An error page is quoted, not stored. Past this many bytes the rest cannot change the message and must not be buffered.
const ERROR_PREVIEW = 4096;
const ERROR_QUOTE = 200;

const headerField = (value, what) => { if (value != null) validateWire(value, what); };

// URL userinfo → the bytes git sends for it (git 2.50, measured against http-backend behind Basic auth), as a byte
// string `btoa` takes as is: `%XX` is that byte (`%FF` → 0xFF, UTF-8 as its bytes), anything else as written (`%ZZ`
// stays `%ZZ`; WHATWG URL has already percent-encoded every non-ASCII character). A NUL, CR or LF is refused: git
// refuses LF ("credential url cannot be parsed") and NUL (curl: "bad/illegal format") and sends CR; Basic would carry
// any of them, but no host means one.
const userinfo = s => {
  const b = s.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  if (/[\0\r\n]/.test(b)) throw fail('bad_request', 'invalid url userinfo: must not contain NUL, CR, or LF', { what: 'url userinfo' });
  return b;
};
// WHATWG URL drops an empty userinfo (`http://@h`, `http://:@h` → `http://h/`); git sends Basic `:` for both (measured).
// A `\` ends the authority of a special URL, as `/` does.
const emptyUserinfo = url => /^[a-z][a-z0-9+.-]*:\/\/[^/?#\\]*@/i.test(String(url));
const latin1 = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return s; };
const utf8 = b => td.decode(Uint8Array.from(b, c => c.charCodeAt(0)));
// An Authorization value or a Bearer token goes on the wire as written: printable ASCII (and tab) only. A raw
// non-ASCII or control character is refused before any request: fetch throws an untyped TypeError on a character past
// U+00FF, git sends UTF-8 as raw bytes (measured, `http.extraHeader`) that no grammar for either scheme admits, and a
// control character is a 400 from a strict server (measured: git's `Bearer t\x01k` → HTTP 400). Basic credentials are
// any text (below).
const ASCII_VALUE = /^[\t\x20-\x7e]+$/;
const noCredential = why => fail('bad_request', `invalid auth: ${why}`, { what: 'auth' });

// The explicit `auth` → [Authorization value, its Basic parts or null]. Every form yields a credential or is refused:
// an `auth` that sends nothing is the silent trap #32 was (every request anonymous, a 401 saying nothing about why).
//   { header }        the value verbatim (a proxy forwarding its caller's credential)
//   { token, user? }  Basic `user:token`, user defaulting to `x-access-token`; the text is sent as its UTF-8 bytes, as git
//                     sends a credential helper's (measured: `username=tëst password=päss` → those bytes)
//   { bearer }        Bearer
//   { user }          refused. git's own credential API asks for the password when a helper gives a user alone (measured:
//                     "could not read Password", nothing sent) and a library cannot ask; `token: ''` is the explicit
//                     empty password and sends `user:` (git, helper `password=` empty: `ivar:`), the URL `user@` form.
function explicitAuth({ header, token, user, bearer }) {
  if (header != null) {
    if (!ASCII_VALUE.test(header)) throw noCredential('the authorization header must be non-empty printable ASCII');
    return [header, null];
  }
  if (token != null) {
    if (token === '' && user == null) throw noCredential('an empty token with no user carries no credential');
    const name = user ?? 'x-access-token';
    return [`Basic ${btoa(latin1(te.encode(`${name}:${token}`)))}`, { user: name, pass: token }];
  }
  if (bearer != null) {
    if (!ASCII_VALUE.test(bearer)) throw noCredential('the bearer token must be non-empty printable ASCII');
    return [`Bearer ${bearer}`, null];
  }
  if (user != null) throw noCredential('a user with no token; pass the token, or token: \'\' to send the user alone (Basic `user:`)');
  throw noCredential('no token, bearer or header; omit auth to send none');
}

// A 3xx is never followed (fetch `redirect: 'manual'`), same-origin or not. Following hands the Authorization header to
// whatever the server names, under the runtime's own rules: undici strips it cross-origin, workerd 2026-10-23 forwards it
// (measured, SAFETY I6c). A 301/302 also turns the POST into a GET, which surfaced as a content-type error. git follows
// only on the initial info/refs and then rebases every request on the new URL; ply's first request is usually the v2
// POST, so following on the GET alone would not make a moved repository work. A moved remote is a URL the caller
// updates: the error names where the server pointed (origin and path only, scrubbed). Browsers answer `manual` with an
// opaque redirect (status 0): same error.
const isRedirect = res => res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
function redirectError(res, url, what, scrub) {
  let to = '';
  const loc = res.headers.get('location');
  if (loc) try { const x = new URL(loc, url); to = `${x.origin}${x.pathname}`; } catch { /* unparseable Location */ }
  if (scrub) to = scrub(to);
  try { res.body?.cancel?.(); } catch { /* unopened */ }
  return fail('http', `HTTP ${res.status} ${what}: redirected${to ? ` to ${to}` : ''}; ply does not follow redirects (update the remote URL)`, { status: res.status, location: to });
}

// Read a body without ever holding more than `max` bytes. `truncate` keeps a prefix (error pages);
// otherwise the first chunk that would pass the cap throws and is not retained.
async function readCapped(body, max, { what = 'response bytes', truncate = false } = {}) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') return new Uint8Array(0);
  const chunks = [];
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
  } finally { try { await body.cancel?.(); } catch { /* already closed */ } }
  return concat(chunks);
}

export function createTransport(url, { auth, tracer, parent = null, fetchImpl = globalThis.fetch, userAgent = UA, limits = DEFAULT_LIMITS, signal = null, quirks = {} } = {}) {
  headerField(userAgent, 'user agent');
  headerField(auth?.header, 'authorization');
  headerField(auth?.token, 'token');
  headerField(auth?.bearer, 'bearer');
  headerField(auth?.user, 'auth user');
  // `new URL` puts what it was given on the TypeError (`input`): a credential in a malformed URL would ride out on it.
  let u;
  try { u = new URL(url); } catch { throw fail('bad_request', 'invalid url: not an absolute URL', { what: 'url' }); }
  // userinfo in the URL becomes the Basic credential git sends for it, byte for byte: `user:password`; a user alone is
  // `user:` (a token given as the user, which GitHub and GitLab accept; git sends it without asking for a password and
  // asks only once it is refused), a password alone `:password`, an empty userinfo `:`. Explicit `auth` wins. It never
  // appears again: not in requests, not in spans, not in error messages.
  const fromUrl = auth == null && (u.username || u.password || emptyUserinfo(url)) ? { user: userinfo(u.username), pass: userinfo(u.password) } : null;
  u.username = ''; u.password = '';
  const base = u.toString().replace(/\/$/, '');
  // Workers: fetch is a method of the global and throws "Illegal invocation" when called detached; bind it (found under workerd)
  const f = fetchImpl === globalThis.fetch ? fetchImpl.bind(globalThis) : fetchImpl;
  // Whatever form, the value never reaches a span or an error message (`scrub`), even echoed.
  const [authorization, given] = fromUrl ? [`Basic ${btoa(`${fromUrl.user}:${fromUrl.pass}`)}`, null] : auth != null ? explicitAuth(auth) : [null, null];
  // The Basic parts as a server would echo them (UTF-8 text). From a header they are decoded, as bytes and as UTF-8.
  const decoded = (() => { if (!/^Basic\s/i.test(authorization ?? '')) return null; try { const d = atob(authorization.replace(/^Basic\s+/i, '')); const c = d.indexOf(':'); return c < 0 ? { user: d, pass: '' } : { user: d.slice(0, c), pass: d.slice(c + 1) }; } catch { return null; } })();
  const basic = given ?? (decoded && { user: utf8(decoded.user), pass: utf8(decoded.pass) });
  const user = auth?.user ?? basic?.user;
  const userSecret = basic ? secretUser(basic.user, basic.pass !== '') : secretShaped(user);
  // Every string a server can send back (error bodies, ERR lines, band-2/3 text, ng reasons, hook output) passes through
  // `scrub` before it reaches an error or a span: the transport carries it (`t.scrub`) and otel.js applies it.
  const scrub = scrubber([authorization, auth?.token, auth?.bearer, authorization?.replace(/^\S+\s+/, ''), basic?.pass, decoded?.pass, userSecret ? basic?.user ?? user : null, userSecret ? decoded?.user : null, secretShaped(user) ? user : null]);
  const headers = (service, extra = {}) => {
    const h = { 'Content-Type': `application/x-${service}-request`, Accept: `application/x-${service}-result`, 'User-Agent': userAgent, ...extra };
    if (authorization) h.Authorization = authorization;
    return h;
  };
  // Not AbortSignal.any([AbortSignal.timeout(ms)]): the composite holds its sources weakly and the timeout signal is held
  // only by its own (weak) timer, so after a GC the timeout never fires and a stalled body hangs forever (Node 20/22;
  // found by the calibration harness: `hang` fault + head hint). A controller owned by a live timer cannot be collected.
  // The timer is the strong owner of `ac`. It stays scheduled for the whole exchange (so a GC cannot drop it)
  // and is cleared when the exchange ends, so a finished request does not abort later.
  const requestSignal = () => {
    const ms = requireLimit(limits, 'requestTimeoutMs');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new DOMException(`request exceeded ${ms} ms`, 'TimeoutError')), ms);
    timer?.unref?.();
    const sig = signal ? AbortSignal.any([ac.signal, signal]) : ac.signal;
    return { signal: sig, cancel: () => clearTimeout(timer) };
  };

  // POST and yield body chunks, filling span with HTTP attrs. Async generator keeps memory at one chunk.
  async function* post(service, body, span, hints) {
    const url = `${base}/${service}`;
    const extra = { 'Git-Protocol': 'version=2', ...(hints.bypassCache ? { 'x-ply-cache': 'bust' } : {}) };
    span.set({ 'git.transport': 'http', 'http.request.method': 'POST', 'url.full': redactUrl(url), 'server.address': u.host, 'git.request.bytes': body.length, 'http.request.body.size': body.length, 'git.service': service, 'git.limits.request_timeout_ms': limits.requestTimeoutMs });
    const t0 = Date.now();
    const sig = requestSignal();
    let res;
    try {
    try { res = await f(url, { method: 'POST', headers: headers(service, extra), body, signal: sig.signal, redirect: 'manual' }); }
    catch (e) { throw wrapNet(e, sig.signal); }
    const cache = res.headers.get('x-ply-pack-cache') ?? '';
    span.set({ 'http.response.status_code': res.status, 'http.response.header.content-type': res.headers.get('content-type') ?? '', 'http.response.ttfb_ms': Date.now() - t0, 'git.response.cache': cache, 'git.pack.cache': cache });
    if (isRedirect(res)) throw redirectError(res, url, service, scrub);
    if (!res.ok) {
      // Keep a prefix for the message (and for credential scrubbing). The rest of a huge error page is cancelled.
      const preview = td.decode(await readCapped(res.body, ERROR_PREVIEW, { truncate: true }));
      throw fail(httpCode(res.status), `HTTP ${res.status} ${service}: ${(scrub ? scrub(preview) : preview).slice(0, ERROR_QUOTE)}`, { status: res.status });
    }
    let bytes = 0, chunks = 0, maxChunk = 0, first = null;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.startsWith(`application/x-${service}-result`)) throw fail('not_git', `unexpected content-type ${JSON.stringify(ct)} from ${service}`);
    try { for await (const chunk of res.body) {
      if (first === null) first = Date.now() - t0;
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
    kind: 'http', url: base, tracer, parent, limits, signal, quirks, objects: new Map(), scrub,
    async *frames(service, body, span, hints = {}) {
      let st = pktInit();
      for await (const chunk of post(service, body, span, hints)) { const r = pktStep(st, chunk); st = r.state; yield* r.frames; }
      pktFinish(st);
      span.set(pktAttrs(st));
    },
    // GET info/refs?service=… (capability advertisements). Returns the whole body; advertisements are small.
    async advertise(service, span) {
      const url = `${base}/info/refs?service=${service}`;
      span.set({ 'git.transport': 'http', 'http.request.method': 'GET', 'url.full': redactUrl(url), 'server.address': u.host });
      const sig = requestSignal();
      try {
      const t0 = Date.now();
      let res;
      try { res = await f(url, { headers: headers(service, { 'Git-Protocol': 'version=2' }), signal: sig.signal, redirect: 'manual' }); } catch (e) { throw wrapNet(e, sig.signal); }
      span.set({ 'http.response.status_code': res.status, 'http.response.ttfb_ms': Date.now() - t0, 'http.response.header.content-type': res.headers.get('content-type') ?? '' });
      if (isRedirect(res)) throw redirectError(res, url, `${service} advertisement`, scrub);
      if (!res.ok) throw fail(httpCode(res.status), `HTTP ${res.status} ${service} advertisement`, { status: res.status });
      if (!(res.headers.get('content-type') ?? '').startsWith(`application/x-${service}-advertisement`)) throw fail('not_git', `unexpected content-type from ${service} advertisement`);
      const maxPack = requireLimit(limits, 'maxPackBytes');
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxPack) {
        try { await res.body?.cancel?.(); } catch { /* unopened */ }
        throw limitError('advertisement bytes', declared, maxPack);
      }
      // Stream into the cap. arrayBuffer() would allocate the whole body before the check could run.
      const buf = await readCapped(res.body, maxPack, { what: 'advertisement bytes' });
      span.set({ 'git.response.bytes': buf.length, 'http.response.body.size': buf.length });
      return buf;
      } finally { sig.cancel(); }
    },
  };
}
// ci/fast probe 2: whole-file mutation of every src file (reverted in the next commit)
