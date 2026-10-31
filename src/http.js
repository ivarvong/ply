// Smart-HTTP transport: one POST per git command, body chunks yielded as they arrive, every request a CLIENT span.
// Implements the contract in transport.js. `createTransport` is its constructor (the name every caller used first).
import { fail } from './errors.js';
import { pktInit, pktStep, pktFinish, pktAttrs } from './pktline.js';
import { concat, td } from './bytes.js';
import { DEFAULT_LIMITS, requireLimit, limitError } from './limits.js';
import { validateWire } from './validate.js';
import { UA, wrapNet } from './transport.js';

export const redactUrl = u => { try { const x = new URL(u); x.username = ''; x.password = ''; return x.toString(); } catch { return '<invalid url>'; } };
export const httpCode = status => status === 401 || status === 403 ? 'auth' : status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : status >= 500 ? 'upstream_5xx' : 'http';

// An error page is quoted, not stored. Past this many bytes the rest cannot change the message and must not be buffered.
const ERROR_PREVIEW = 4096;
const ERROR_QUOTE = 200;

const headerField = (value, what) => { if (value != null) validateWire(value, what); };

// The Basic user is a name on most hosts (`x-access-token`, `oauth2`, `git`, a login) and a secret on some (a deploy
// token, a PAT given as the user). Scrubbing a name would mangle legitimate server text ("denied to ivar"), so the user
// is scrubbed only when it is secret-shaped: at least 16 characters with a digit. Every token format seen (ghp_…, glpat-…,
// hex, base64) is; every conventional user name is not. Below 4 characters nothing is scrubbed (it would eat text).
const MIN_SECRET = 4;
const SECRET_USER_CHARS = 16;
const secretShaped = s => typeof s === 'string' && s.length >= SECRET_USER_CHARS && /[0-9]/.test(s);

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

// text → text with every secret replaced by '[redacted]'; null when there is nothing to hide. Server text is kept as a
// tail or a prefix in places (progress, hook output, a quoted line), so a secret can arrive cut: any run of FRAGMENT or
// more characters of a secret is redacted, not only whole ones. 12 characters of a random token cannot occur by chance
// (a 12-hex window of a commit oid matches a hex token's with p ≈ 1e-13); shorter secrets are matched whole.
const FRAGMENT = 12;
const REDACTED = '[redacted]';
function scrubber(values) {
  const secrets = values.filter(x => typeof x === 'string' && x.length >= MIN_SECRET);
  if (!secrets.length) return null;
  const whole = secrets.filter(x => x.length < FRAGMENT);
  const grams = new Set();
  for (const x of secrets) for (let i = 0; i + FRAGMENT <= x.length; i++) grams.add(x.slice(i, i + FRAGMENT));
  const cut = s => {
    let out = '', from = 0, start = -1, end = -1;
    for (let i = 0; i + FRAGMENT <= s.length; i++) {
      if (!grams.has(s.slice(i, i + FRAGMENT))) continue;
      if (i > end) { if (start >= 0) { out += s.slice(from, start) + REDACTED; from = end; } start = i; }
      end = i + FRAGMENT;
    }
    return start < 0 ? s : out + s.slice(from, start) + REDACTED + s.slice(end);
  };
  return text => whole.reduce((acc, x) => acc.split(x).join(REDACTED), cut(String(text)));
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
  // asks only once it is refused), a password alone `:password`. Explicit `auth` wins. It never appears again: not in
  // requests, not in spans, not in error messages.
  const fromUrl = (u.username || u.password) && !auth ? { user: userinfo(u.username), pass: userinfo(u.password) } : null;
  u.username = ''; u.password = '';
  const base = u.toString().replace(/\/$/, '');
  // Workers: fetch is a method of the global and throws "Illegal invocation" when called detached; bind it (found under workerd)
  const f = fetchImpl === globalThis.fetch ? fetchImpl.bind(globalThis) : fetchImpl;
  // auth: { token, user? } → Basic; { bearer } → Bearer; { header } → the Authorization value verbatim (a proxy forwarding
  // its caller's credential). Whatever form, the value never reaches a span or an error message (`scrub`), even echoed.
  const authorization = fromUrl ? `Basic ${btoa(`${fromUrl.user}:${fromUrl.pass}`)}` : auth?.header ? String(auth.header) : auth?.token ? `Basic ${btoa(`${auth.user ?? 'x-access-token'}:${auth.token}`)}` : auth?.bearer ? `Bearer ${auth.bearer}` : null;
  const utf8 = b => td.decode(Uint8Array.from(b, c => c.charCodeAt(0)));
  const basic = fromUrl ? { user: utf8(fromUrl.user), pass: utf8(fromUrl.pass) } : (() => { if (!/^Basic\s/i.test(authorization ?? '')) return null; try { const d = atob(authorization.replace(/^Basic\s+/i, '')); const c = d.indexOf(':'); return { user: d.slice(0, c), pass: d.slice(c + 1) }; } catch { return null; } })();
  const user = auth?.user ?? basic?.user;
  // A Basic user with an empty password is the whole credential (the token-as-user form): secret at 16 characters,
  // digit or not (a GitLab or GitHub token without one would otherwise stay readable).
  const userSecret = secretShaped(user) || (basic !== null && basic.pass === '' && user.length >= SECRET_USER_CHARS);
  // Every string a server can send back (error bodies, ERR lines, band-2/3 text, ng reasons, hook output) passes through
  // `scrub` before it reaches an error or a span: the transport carries it (`t.scrub`) and otel.js applies it.
  const scrub = scrubber([authorization, auth?.token, auth?.bearer, authorization?.replace(/^\S+\s+/, ''), basic?.pass, userSecret ? user : null]);
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
