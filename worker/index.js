// ply as an HTTP API: a stateless Worker that runs ply's git client against any smart-HTTP git host (Cloudflare
// Artifacts, GitHub, GitLab, …) with the caller's git credential. See worker/README.md for the API.
//
// Two credentials, never confused:
//   Authorization: Bearer <PLY_TOKEN>   gates this Worker (secret; constant-time compare)
//   Git-Authorization: <value>          sent upstream verbatim as Authorization
//   Git-Token: <token>                  convenience, mapped per host (github → Basic x-access-token, gitlab → Basic
//                                       oauth2, Artifacts and others → Bearer)
// Neither git credential appears in logs, spans, error messages or responses (scrubbed at the edge as defense in depth;
// ply itself never records them).
import { readFile, listTree, readCommit, resolveCommit } from '../src/read.js';
import { editFile } from '../src/edit.js';
import { mergeBranch } from '../src/merge.js';
import { rebaseBranch, cherryPick, revertCommit } from '../src/rebase.js';
import { lsRefs } from '../src/lsrefs.js';
import { discover } from '../src/discover.js';
import { push, ZERO_OID } from '../src/push.js';
import { operation } from '../src/operation.js';
import { createTransport } from '../src/http.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { RETRY, isPlyCode, fail } from '../src/errors.js';
import { withLimits } from '../src/limits.js';
import { cachingFetch } from '../src/packcache.js';
import { validateRef, validateIdent } from '../src/validate.js';

// A Worker isolate has 128 MB: keep every buffered pack well under it (the blob is streamed and never counts).
const LIMITS = withLimits({ maxPackBytes: 32 << 20, maxObjectSize: 16 << 20, maxHarvestBytes: 16 << 20, requestTimeoutMs: 30_000 });
const MAX_BODY = 1 << 20;

// Learned server properties (ply's `quirks`: e.g. "refuses tree:0, use blob:none"), per origin, for the isolate's life.
// Not request state: a fact about a server, learned from its own answer, the same for every caller.
const QUIRKS = new Map();
const quirksFor = origin => { if (!QUIRKS.has(origin)) { if (QUIRKS.size >= 256) QUIRKS.clear(); QUIRKS.set(origin, {}); } return QUIRKS.get(origin); };

// HTTP status for each ply error code (README in worker/ documents the choices).
export const STATUS = Object.freeze({
  bad_request: 400, unsupported: 501, network: 502, timeout: 504, aborted: 499, http: 502, auth: 401, not_found: 404,
  rate_limited: 429, upstream_5xx: 502, not_git: 502, ssh: 502, host_key_mismatch: 502, protocol: 502, pack_corrupt: 502,
  remote_error: 502, limit_exceeded: 413, match_count: 422, lfs_pointer: 422, cas_conflict: 409, push_rejected: 409,
  merge_conflict: 409, not_fast_forward: 409, not_linear: 422, unrelated_histories: 422, ambiguous: 502, internal: 500,
});

const USAGE = `ply — a git client for anywhere, as an HTTP API (https://ply.ivar.workers.dev)

Every endpoint except GET / needs  Authorization: Bearer <PLY_TOKEN>.
Git credential (optional, forwarded upstream):  Git-Authorization: <Authorization value>  or  Git-Token: <token>.
remote= is an https git URL (no userinfo, no IP literals, no private hosts, default port only).
ref= defaults to the remote's HEAD. Short names resolve like git rev-parse (tags before branches).

  GET    /v1/refs?remote=&prefix=              {refs:{name:oid}, head, peeled}
  GET    /v1/discover?remote=                  server capabilities (protocol v2)
  GET    /v1/read?remote=&ref=&path=           file bytes, streamed; x-ply-commit, x-ply-blob, x-ply-mode, content-length
  GET    /v1/tree?remote=&ref=&path=           [{name, mode, oid, type}]
  GET    /v1/commit?remote=&ref=               {ref, oid, tree, parents, author, committer, message, signed}
                         author/committer: {name, email, time (ISO-8601 UTC), epoch, tz (as written, e.g. +0530)}
  POST   /v1/edit        {remote, ref?, base?, path, find, replace, author:{name,email}, message, head?, hint?}
                         head: expected parent (moved → 409 cas_conflict, nothing pushed); hint: a guess only
  POST   /v1/branch      {remote, ref, from?}           create (fails 409 if it exists)
  DELETE /v1/branch      {remote, ref, oid?}            delete (compare-and-swap on oid)
  POST   /v1/merge       {remote, ref?, from, author, message?, fastForwardOnly?, noFastForward?}
  POST   /v1/rebase      {remote, ref, onto?, committer, squash?, message?}
  POST   /v1/cherry-pick {remote, ref?, commit, committer, message?}
  POST   /v1/revert      {remote, ref?, commit, committer, message?}

Errors: {code, message, retry} with retry in yes|fresh|no|read. ?trace=1 adds ply's spans to JSON responses
(and an x-ply-trace timing summary header on /v1/read).
`;

// ---- pure helpers ----

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const BLOCKED_SUFFIX = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home\.arpa|corp|private)\.?$/i;

// Pure: the caller's remote, or a bad_request saying why not. `allow` lists origins exempt from the rules (tests).
export function checkRemote(raw, allow = []) {
  if (typeof raw !== 'string' || !raw) throw fail('bad_request', 'remote is required');
  if (raw.length > 2048) throw fail('bad_request', 'remote too long');
  let u; try { u = new URL(raw); } catch { throw fail('bad_request', 'remote is not a URL'); }
  if (u.username || u.password) throw fail('bad_request', 'remote must not carry credentials; use Git-Authorization or Git-Token');
  if (u.search || u.hash) throw fail('bad_request', 'remote must not have a query or fragment');
  if (allow.includes(u.origin)) return u;
  if (u.protocol !== 'https:') throw fail('bad_request', 'remote must be https');
  if (u.port !== '') throw fail('bad_request', 'remote must use the default port');
  const h = u.hostname;
  if (IPV4.test(h) || h.startsWith('[')) throw fail('bad_request', 'remote must be a host name, not an IP address');
  if (!h.includes('.') || BLOCKED_SUFFIX.test(h)) throw fail('bad_request', 'remote host is not a public name');
  return u;
}

// Pure: the git credential from the request headers, as ply's `auth`, plus every string form to scrub.
export function gitAuth(headers, host) {
  const ga = headers.get('git-authorization'), gt = headers.get('git-token');
  if (ga && gt) throw fail('bad_request', 'send Git-Authorization or Git-Token, not both');
  if (ga) {
    const secrets = [ga, ga.replace(/^\S+\s+/, '')];
    if (/^basic\s/i.test(ga)) { try { const d = atob(ga.replace(/^basic\s+/i, '')); secrets.push(d, d.slice(d.indexOf(':') + 1)); } catch { /* not base64: forwarded as is */ } }
    return { auth: { header: ga }, secrets };
  }
  if (gt) {
    const user = host === 'github.com' || host.endsWith('.github.com') ? 'x-access-token' : host === 'gitlab.com' || host.startsWith('gitlab.') ? 'oauth2' : null;
    const auth = user ? { token: gt, user } : { bearer: gt };
    return { auth, secrets: [gt, ...(user ? [btoa(`${user}:${gt}`)] : [])] };
  }
  return { auth: undefined, secrets: [] };
}

export const scrubber = secrets => {
  const list = [...new Set(secrets.filter(s => typeof s === 'string' && s.length >= 4))].sort((a, b) => b.length - a.length);
  return text => list.reduce((s, x) => s.split(x).join('[redacted]'), String(text));
};

const fullRef = r => (typeof r === 'string' && !r.startsWith('refs/') ? `refs/heads/${r}` : r);
const need = (body, k) => { if (body[k] === undefined || body[k] === null || body[k] === '') throw fail('bad_request', `${k} is required`); return body[k]; };

// ---- effects ----

async function timingSafeTokenEqual(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}

async function readJson(req) {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_BODY) throw fail('limit_exceeded', `request body over ${MAX_BODY} bytes`);
  if (!req.body) return {};
  const parts = []; let n = 0;
  for await (const c of req.body) { n += c.length; if (n > MAX_BODY) throw fail('limit_exceeded', `request body over ${MAX_BODY} bytes`); parts.push(c); }
  const text = new TextDecoder().decode(parts.length === 1 ? parts[0] : new Uint8Array(await new Blob(parts).arrayBuffer()));
  if (!text.trim()) return {};
  try { const v = JSON.parse(text); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; return v; } catch { throw fail('bad_request', 'body must be a JSON object'); }
}

// The default branch: the remote's HEAD symref (some hosts let it go unborn — then the caller must name the ref).
async function headBranch(remote, opts) {
  const t = createTransport(remote, { ...opts, parent: null });
  const { head } = await lsRefs(t, ['HEAD']);
  if (!head) throw fail('not_found', 'remote HEAD is unborn or not a symref; pass ref explicitly');
  return head;
}

const json = (status, obj, scrub, extra = {}) => new Response(scrub(JSON.stringify(obj)), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });

function errorBody(e) {
  const code = isPlyCode(e?.code) ? e.code : 'internal';
  const body = { code, message: String(e?.message ?? e).slice(0, 1000), retry: RETRY[code] ?? 'no' };
  if (Array.isArray(e?.conflicts)) body.conflicts = e.conflicts.slice(0, 200);
  if (e?.reasons && typeof e.reasons === 'object') body.reasons = e.reasons;
  if (Array.isArray(e?.bases)) body.bases = e.bases;
  if (typeof e?.matches === 'number') body.matches = e.matches;
  if (code === 'auth' && e?.status) body.upstreamStatus = e.status;
  return body;
}
const statusOf = e => (e?.code === 'auth' && (e.status === 401 || e.status === 403) ? e.status : STATUS[e?.code] ?? 500);

const spanView = s => ({ name: s.name, ms: Math.round(s.durationMs * 10) / 10, status: s.status?.code === 2 ? 'error' : 'ok', attrs: s.attrs, events: s.events.filter(e => e.name !== 'exception').slice(0, 32) });
const traceSummary = spans => spans.map(s => `${s.name.replace(/^git\.(upload-pack |receive-pack)/, '$1').replace(/ /g, '_')};dur=${Math.round(s.durationMs)}`).join(', ').slice(0, 4000);

// ---- handlers: (ctx) → { status?, body } | Response ----

const READS = {
  'GET /v1/refs': async ({ remote, q, opts }) => {
    const prefix = q.get('prefix');
    const t = createTransport(remote, opts);
    const { refs, head } = await lsRefs(t, prefix ? [prefix, 'HEAD'] : []);
    const out = {}, peeled = {};
    for (const [name, r] of refs) { if (name === 'HEAD') continue; if (prefix && !name.startsWith(prefix)) continue; out[name] = r.oid; if (r.peeled) peeled[name] = r.peeled; }
    return { body: { refs: out, head, peeled } };
  },
  'GET /v1/discover': async ({ remote, opts }) => {
    const info = await discover(createTransport(remote, opts));
    return { body: { ...info, caps: Object.fromEntries(info.caps) } };
  },
  'GET /v1/tree': async ({ remote, q, opts }) => {
    const r = await listTree(remote, { ref: q.get('ref') || null, path: q.get('path') ?? '' }, opts);
    return { body: { ref: r.ref, commit: r.commit, tree: r.tree, entries: r.entries } };
  },
  'GET /v1/commit': async ({ remote, q, opts }) => ({ body: await readCommit(remote, { ref: q.get('ref') || null }, opts) }),
  'GET /v1/read': async ({ remote, q, opts, spans, ctx, log }) => {
    const r = await readFile(remote, { ref: q.get('ref') || null, path: q.get('path') }, opts);
    const fixed = new FixedLengthStream(r.size);
    // a verification failure mid-stream aborts the body short of its Content-Length: the client sees a truncated
    // response, never a clean one with the wrong bytes
    ctx.waitUntil(r.stream.pipeTo(fixed.writable).then(() => log({ stream: 'ok' }), e => log({ stream: 'error', stream_code: e?.code ?? 'error' })));
    const headers = { 'content-type': 'application/octet-stream', 'x-ply-ref': r.ref, 'x-ply-commit': r.commit, 'x-ply-blob': r.blob, 'x-ply-mode': r.mode, 'x-ply-size': String(r.size) };
    if (q.get('trace') === '1') headers['x-ply-trace'] = traceSummary(spans());
    return new Response(fixed.readable, { status: 200, headers });
  },
};

const ident = (body, k) => validateIdent(need(body, k));

const WRITES = {
  'POST /v1/edit': async ({ remote, body, opts }) => {
    const ref = body.ref ? fullRef(body.ref) : await headBranch(remote, opts);
    const r = await editFile(remote, { ref, base: body.base ? fullRef(body.base) : ref, path: need(body, 'path'), find: need(body, 'find'), replace: body.replace ?? '', author: ident(body, 'author'), message: need(body, 'message') }, { ...opts, ...(body.head ? { head: body.head, strictHead: true } : body.hint ? { head: body.hint } : {}) });
    return { body: { ref, newCommit: r.newCommit, oldCommit: r.oldCommit, pushBytes: r.pushBytes, noop: r.noop, newBlob: r.newBlob, newTree: r.newTree, hint: r.hint, attempt: r.attempt } };
  },
  'POST /v1/branch': async ({ remote, body, opts }) => {
    const ref = validateRef(fullRef(need(body, 'ref')));
    return { status: 201, body: await operation('branch_create', remote, { ...opts, attrs: { 'git.branch_create.ref': ref } }, async ({ t, root, outcome }) => {
      const { commit } = await resolveCommit(t, body.from ?? null);
      root.set({ 'git.branch_create.oid': commit });
      const r = await push(t, { ref, oldOid: ZERO_OID, newOid: commit, objects: [] });
      return outcome('created', { ref, oid: commit, pushBytes: r.packBytes });
    }) };
  },
  'DELETE /v1/branch': async ({ remote, body, opts }) => {
    const ref = validateRef(fullRef(need(body, 'ref')));
    if (body.oid !== undefined && !/^[0-9a-f]{40}$/.test(body.oid)) throw fail('bad_request', 'oid must be a 40-hex oid');
    return { body: await operation('branch_delete', remote, { ...opts, attrs: { 'git.branch_delete.ref': ref } }, async ({ t, root, outcome }) => {
      let oid = body.oid;
      if (!oid) { oid = (await lsRefs(t, [ref])).refs.get(ref)?.oid; if (!oid) throw fail('not_found', `ref ${ref} not found`); }
      root.set({ 'git.branch_delete.oid': oid, 'git.branch_delete.cas_from_caller': !!body.oid });
      await push(t, { ref, oldOid: oid, newOid: ZERO_OID, objects: [] });
      return outcome('deleted', { ref, deleted: oid });
    }) };
  },
  'POST /v1/merge': async ({ remote, body, opts }) => {
    const ref = body.ref ? fullRef(body.ref) : await headBranch(remote, opts);
    const r = await mergeBranch(remote, { ref, from: fullRef(need(body, 'from')), author: body.author ? validateIdent(body.author) : undefined, message: body.message, fastForwardOnly: !!body.fastForwardOnly, noFastForward: !!body.noFastForward }, opts);
    return { body: r };
  },
  'POST /v1/rebase': async ({ remote, body, opts }) => {
    const onto = body.onto ? fullRef(body.onto) : await headBranch(remote, opts);
    const r = await rebaseBranch(remote, { ref: fullRef(need(body, 'ref')), onto, committer: ident(body, 'committer'), author: body.author ? validateIdent(body.author) : undefined, squash: !!body.squash, message: body.message ?? null }, opts);
    return { body: r };
  },
  'POST /v1/cherry-pick': async ({ remote, body, opts }) => {
    const ref = body.ref ? fullRef(body.ref) : await headBranch(remote, opts);
    return { body: await cherryPick(remote, { ref, commit: need(body, 'commit'), committer: ident(body, 'committer'), message: body.message ?? null }, opts) };
  },
  'POST /v1/revert': async ({ remote, body, opts }) => {
    const ref = body.ref ? fullRef(body.ref) : await headBranch(remote, opts);
    return { body: await revertCommit(remote, { ref, commit: need(body, 'commit'), committer: ident(body, 'committer'), message: body.message ?? null }, opts) };
  },
};

export default {
  async fetch(req, env, ctx) {
    const t0 = Date.now();
    const url = new URL(req.url);
    const id = crypto.randomUUID();
    if (req.method === 'GET' && url.pathname === '/') return new Response(USAGE, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    let scrub = s => String(s);
    const record = { msg: 'ply.request', id, method: req.method, path: url.pathname, colo: req.cf?.colo ?? '' };
    const log = extra => console.log(scrub(JSON.stringify({ ...record, ...extra })));
    const done = (res, extra = {}) => { res.headers.set('x-ply-request-id', id); log({ status: res.status, ms: Date.now() - t0, ...extra }); return res; };
    // gate
    const token = env.PLY_TOKEN;
    if (!token) return done(json(500, { code: 'internal', message: 'PLY_TOKEN is not configured', retry: 'no' }, scrub));
    const presented = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
    if (!presented || !(await timingSafeTokenEqual(presented, token))) return done(json(401, { code: 'unauthorized', message: 'Authorization: Bearer <PLY_TOKEN> required', retry: 'no' }, scrub, { 'www-authenticate': 'Bearer realm="ply"' }));
    const key = `${req.method} ${url.pathname}`;
    const writes = env.WRITES === 'on';
    const handler = READS[key] ?? WRITES[key];
    if (!handler) return done(json(Object.keys({ ...READS, ...WRITES }).some(k => k.endsWith(` ${url.pathname}`)) ? 405 : 404, { code: 'not_found', message: `no route ${key}`, retry: 'no' }, scrub));
    if (WRITES[key] && !writes) return done(json(501, { code: 'unsupported', message: 'writes are disabled on this deployment', retry: 'no' }, scrub));
    const exporter = arrayExporter();
    const spans = () => exporter.lines.flatMap(flattenLine);
    try {
      const body = WRITES[key] ? await readJson(req) : {};
      const allow = (env.ALLOW_REMOTE_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
      const remoteUrl = checkRemote(WRITES[key] ? body.remote : url.searchParams.get('remote'), allow);
      const remote = remoteUrl.toString();
      record.host = remoteUrl.host;
      const cred = gitAuth(req.headers, remoteUrl.hostname);
      scrub = scrubber(cred.secrets);
      const tracer = new Tracer({ exporter, resource: { 'service.name': 'ply-worker', 'cloudflare.colo': req.cf?.colo ?? '' } });
      const fetchImpl = env.PACK_CACHE === 'off' || typeof caches === 'undefined' ? undefined : cachingFetch(globalThis.fetch, caches.default, { waitUntil: p => ctx.waitUntil(p) });
      const opts = { auth: cred.auth, tracer, limits: LIMITS, quirks: quirksFor(remoteUrl.origin), ...(fetchImpl ? { fetchImpl } : {}) };
      const out = await handler({ remote, q: url.searchParams, body, opts, spans, ctx, log });
      const s = spans();
      const stats = { spans: s.length, rtt: s.filter(x => /^git\.(upload-pack|receive-pack)/.test(x.name)).length, wide: s.filter(x => x.attrs['git.fetch.filter.fallback']).length, cache_hits: s.filter(x => x.attrs['git.response.cache'] === 'HIT').length };
      if (out instanceof Response) return done(out, stats);
      const payload = url.searchParams.get('trace') === '1' ? { ...out.body, trace: s.map(spanView) } : out.body;
      return done(json(out.status ?? 200, payload, scrub, { 'server-timing': `total;dur=${Date.now() - t0}` }), stats);
    } catch (e) {
      const payload = errorBody(e);
      if (url.searchParams.get('trace') === '1') payload.trace = spans().map(spanView);
      return done(json(statusOf(e), payload, scrub), { code: payload.code, rtt: spans().filter(x => /^git\.(upload-pack|receive-pack)/.test(x.name)).length });
    }
  },
};
