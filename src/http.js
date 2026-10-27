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
  // userinfo in the URL becomes auth and never appears again: not in requests, not in spans, not in error messages
  const u = new URL(url);
  if ((u.username || u.password) && !auth) auth = { user: decodeURIComponent(u.username) || 'x-access-token', token: decodeURIComponent(u.password) };
  u.username = ''; u.password = '';
  const base = u.toString().replace(/\/$/, '');
  // Workers: fetch is a method of the global and throws "Illegal invocation" when called detached; bind it (found under workerd)
  const f = fetchImpl === globalThis.fetch ? fetchImpl.bind(globalThis) : fetchImpl;
  // auth: { token, user? } → Basic; { bearer } → Bearer; { header } → the Authorization value verbatim (a proxy forwarding
  // its caller's credential). Whatever form, the value never reaches a span or an error message (`scrub`).
  const authorization = auth?.header ? String(auth.header) : auth?.token ? `Basic ${btoa(`${auth.user ?? 'x-access-token'}:${auth.token}`)}` : auth?.bearer ? `Bearer ${auth.bearer}` : null;
  const basicPass = () => { try { const d = atob(authorization.replace(/^Basic\s+/i, '')); return d.slice(d.indexOf(':') + 1); } catch { return null; } };
  const secrets = [authorization, auth?.token, auth?.bearer, authorization?.replace(/^\S+\s+/, ''), /^Basic\s/i.test(authorization ?? '') ? basicPass() : null].filter(x => typeof x === 'string' && x.length >= 4);
  const scrub = text => secrets.reduce((s, x) => s.split(x).join('[redacted]'), text);
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
    try { res = await f(url, { method: 'POST', headers: headers(service, extra), body, signal: sig.signal }); }
    catch (e) { throw wrapNet(e, sig.signal); }
    const cache = res.headers.get('x-ply-pack-cache') ?? '';
    span.set({ 'http.response.status_code': res.status, 'http.response.header.content-type': res.headers.get('content-type') ?? '', 'http.response.ttfb_ms': Date.now() - t0, 'git.response.cache': cache, 'git.pack.cache': cache });
    if (!res.ok) {
      // Keep a prefix for the message (and for credential scrubbing). The rest of a huge error page is cancelled.
      const preview = td.decode(await readCapped(res.body, ERROR_PREVIEW, { truncate: true }));
      throw fail(httpCode(res.status), `HTTP ${res.status} ${service}: ${scrub(preview).slice(0, ERROR_QUOTE)}`, { status: res.status });
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
    kind: 'http', url: base, tracer, parent, limits, signal, quirks, objects: new Map(),
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
      try { res = await f(url, { headers: headers(service, { 'Git-Protocol': 'version=2' }), signal: sig.signal }); } catch (e) { throw wrapNet(e, sig.signal); }
      span.set({ 'http.response.status_code': res.status, 'http.response.ttfb_ms': Date.now() - t0, 'http.response.header.content-type': res.headers.get('content-type') ?? '' });
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
