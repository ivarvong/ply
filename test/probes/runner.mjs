// The probe runner: executes test/probes/scenarios.ts plans against a target and records what stock git, the judge,
// sees afterwards. Impure on purpose (processes, sockets, temp dirs); every decision about what a result means is in
// test/probes/evaluate.ts.
//
// A target is a smart-HTTP base URL behind a recording proxy this process runs. The proxy forwards each request to the
// upstream, records method, path, status, duration, sizes and the upstream's cf-ray, applies the step's fault on the
// first receive-pack POST of the `main` channel, and, for the reference, enforces the filter policy (any upload-pack
// filter but blob:none is a 400). Channels: `main` (the client under test), `side` (seeding and the racing writer),
// `judge` (stock git reading the result). A credential, when the upstream needs one, is added by the proxy: neither
// ply nor git is handed it, so it is in no argv, environment or config of a child process.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync, deflateSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { startGitServer, fsckProblems, NO_MAINTENANCE } from '../server.js';
import { GitHttp } from '../../src/client.js';
import { TYPE_ID } from '../../src/objects.js';
import { Tracer, arrayExporter, flattenLine } from '../../src/otel.js';
import { gitOutcome, gitFetchOutcome, plyOutcome } from './evaluate.ts';

const ZERO = '0'.repeat(40);
// Artifacts' known policy, applied to every reference repository (lab notes 2026-10-23..25, matrix runs): wants of
// reachable objects only, blob:none the only filter (the proxy refuses others), objects fsck'd on receive, 64 MiB cap.
export const REFERENCE_POLICY = [
  ['http.receivepack', 'true'], ['receive.fsckObjects', 'true'], ['transfer.fsckObjects', 'true'],
  ['uploadpack.allowFilter', 'true'], ['uploadpack.allowReachableSHA1InWant', 'true'], ['uploadpack.allowAnySHA1InWant', 'false'],
  ['receive.maxInputSize', String(64 * 1024 * 1024)], ['receive.advertiseAtomic', 'true'], ...NO_MAINTENANCE,
];
const FILTER_REFUSAL = 'Unsupported Git fetch filter; only blob:none is supported.';

// ---- git, with no user or system config, deterministic identities, nothing interactive ----
const IDENT = { GIT_AUTHOR_NAME: 'ply probe', GIT_AUTHOR_EMAIL: 'probe@ply.invalid', GIT_COMMITTER_NAME: 'ply probe', GIT_COMMITTER_EMAIL: 'probe@ply.invalid', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000' };
export function gitEnv(home, extra = {}) {
  const cfg = [['credential.helper', ''], ['protocol.version', '2'], ['advice.pushUpdateRejected', 'false'], ...NO_MAINTENANCE];
  return {
    PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_COUNT: String(cfg.length), ...Object.fromEntries(cfg.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])),
    ...IDENT, ...extra,
  };
}
export function run(cmd, args, { cwd, env, input, timeoutMs = 300_000 } = {}) {
  return new Promise(resolve => {
    const t0 = performance.now();
    const c = spawn(cmd, args, { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    const timer = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    c.stdout.on('data', d => out.push(d)); c.stderr.on('data', d => err.push(d));
    if (input !== undefined) { c.stdin.on('error', () => {}); c.stdin.end(input); }
    c.on('close', status => { clearTimeout(timer); const buf = Buffer.concat(out); resolve({ status, out: buf, stdout: buf.toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), ms: +(performance.now() - t0).toFixed(1) }); });
  });
}
const must = async (p, what) => { const r = await p; if (r.status !== 0) throw new Error(`${what}: exit ${r.status}: ${r.stderr.trim().slice(0, 400)}`); return r; };

// ---- seed objects: plumbing only, so every target gets the same object ids ----
export function noiseBytes(seed, n) {
  const out = Buffer.alloc(n);
  for (let o = 0, i = 0; o < n; i++) { const h = createHash('sha256').update(`${seed}:${i}`).digest(); h.copy(out, o, 0, Math.min(32, n - o)); o += 32; }
  return out;
}
const contentOf = c => (c.tag === 'text' ? Buffer.from(c.text, 'utf8') : noiseBytes(c.seed, c.bytes));

// A bare object store holding the scenario's objects: { dir, names (name -> oid), byOid (oid -> name) }.
export async function buildSeed(root, seed) {
  const dir = join(root, 'objects.git');
  const env = gitEnv(root);
  await must(run('git', ['init', '-q', '--bare', '-b', 'main', dir], { env }), 'init seed store');
  const names = {}, trees = {};
  for (const o of seed.objects) {
    if (o.tag === 'commit') {
      const ienv = { ...env, GIT_INDEX_FILE: join(root, `index-${o.name}`) };
      const first = o.parents[0];
      await must(run('git', first === undefined ? ['read-tree', '--empty'] : ['read-tree', trees[first]], { cwd: dir, env: ienv }), `read-tree ${o.name}`);
      for (const f of o.files) {
        const blob = (await must(run('git', ['hash-object', '-w', '--stdin'], { cwd: dir, env, input: contentOf(f.content) }), `blob ${f.path}`)).stdout.trim();
        await must(run('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},${f.path}`], { cwd: dir, env: ienv }), `index ${f.path}`);
      }
      trees[o.name] = (await must(run('git', ['write-tree'], { cwd: dir, env: ienv }), 'write-tree')).stdout.trim();
      const parents = o.parents.flatMap(p => ['-p', names[p]]);
      names[o.name] = (await must(run('git', ['commit-tree', trees[o.name], ...parents, '-m', o.message], { cwd: dir, env }), `commit ${o.name}`)).stdout.trim();
    } else {
      const body = `object ${names[o.target]}\ntype commit\ntag ${o.tagName}\ntagger ply probe <probe@ply.invalid> 1700000000 +0000\n\n${o.message}\n`;
      names[o.name] = (await must(run('git', ['mktag'], { cwd: dir, env, input: body }), `mktag ${o.name}`)).stdout.trim();
    }
  }
  const byOid = Object.fromEntries(Object.entries(names).map(([n, oid]) => [oid, n]));
  return { dir, env, names, byOid, trees };
}
const oidOf = (seed, e) => (e.tag === 'zero' ? ZERO : seed.names[e.name]);

// A seed object by reference (types.ts ObjRef).
async function resolveRef(seed, r) {
  if (r.tag === 'commit') return seed.names[r.name];
  return (await must(run('git', ['rev-parse', `${seed.names[r.of]}:${r.path}`], { cwd: seed.dir, env: seed.env }), `rev-parse ${r.of}:${r.path}`)).stdout.trim();
}
async function catFile(seed, oids) {
  const batch = (await must(run('git', ['cat-file', '--batch'], { cwd: seed.dir, env: seed.env, input: `${oids.join('\n')}\n` }), 'cat-file')).out;
  const objs = [];
  for (let o = 0; o < batch.length;) {
    const nl = batch.indexOf(10, o);
    const [oid, type, size] = batch.subarray(o, nl).toString('latin1').split(' ');
    const n = Number(size);
    objs.push({ oid, type: TYPE_ID[type], data: new Uint8Array(batch.subarray(nl + 1, nl + 1 + n)) });
    o = nl + 1 + n + 1;
  }
  return objs;
}
// The objects a push carries: reachable from its new ids, not from what the target was seeded with (the race's moves
// may add objects the server has; sending them again is harmless), minus the plan's `omit`.
async function objectsFor(seed, scenario, push) {
  const news = push.updates.map(u => oidOf(seed, u.new)).filter(o => o !== ZERO);
  if (news.length === 0) return [];
  const have = scenario.seed.refs.map(r => seed.names[r.at]);
  const omit = new Set(await Promise.all(push.omit.map(r => resolveRef(seed, r))));
  const list = (await must(run('git', ['rev-list', '--objects', '--no-object-names', ...news, ...(have.length ? ['--not', ...have] : [])], { cwd: seed.dir, env: seed.env }), 'rev-list')).stdout.trim().split('\n').filter(Boolean).filter(x => !omit.has(x));
  return catFile(seed, list);
}

// ---- packs the harness writes (PackForm 'hand'): plain entries, an optional REF_DELTA, then damage ----
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const varint = n => { const out = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0); return Buffer.from(out); };
function entryHeader(type, size) {
  const out = []; let b = (type << 4) | (size & 15); let rest = Math.floor(size / 16);
  while (rest > 0) { out.push(b | 0x80); b = rest & 0x7f; rest = Math.floor(rest / 128); }
  out.push(b);
  return Buffer.from(out);
}
const sha1 = b => createHash('sha1').update(b).digest();
// entries: { type, data } or { refDelta: <base oid>, delta }. Returns the pack and where each zlib stream ends.
export function writePack(entries) {
  const parts = [Buffer.from('PACK'), u32(2), u32(entries.length)];
  let at = 12; const zlibEnds = [];
  for (const e of entries) {
    const head = e.refDelta ? Buffer.concat([entryHeader(7, e.delta.length), Buffer.from(e.refDelta, 'hex')]) : entryHeader(e.type, e.data.length);
    const z = deflateSync(e.refDelta ? e.delta : e.data);
    parts.push(head, z); at += head.length + z.length; zlibEnds.push(at);
  }
  const body = Buffer.concat(parts);
  return { pack: Buffer.concat([body, sha1(body)]), zlibEnds };
}
// A delta from a base of `srcSize` bytes: literal inserts only (valid; needs the base present to resolve), or one copy
// that reads 16 bytes from past the end of the base (never valid).
export function deltaFor(srcSize, target, kind) {
  if (kind === 'copy-past-end') {
    const off = srcSize + 1000; let op = 0x80; const args = [];
    for (let i = 0; i < 4; i++) { const b = Math.floor(off / 256 ** i) & 0xff; if (b !== 0) { op |= 1 << i; args.push(b); } }
    op |= 0x10; args.push(16);
    return Buffer.concat([varint(srcSize), varint(16), Buffer.from([op, ...args])]);
  }
  const chunks = [];
  for (let o = 0; o < target.length; o += 127) { const c = target.subarray(o, o + 127); chunks.push(Buffer.from([c.length]), c); }
  return Buffer.concat([varint(srcSize), varint(target.length), ...chunks]);
}
export function damagePack({ pack, zlibEnds }, damage) {
  const b = Buffer.from(pack);
  switch (damage) {
    case 'none': return b;
    case 'bad-trailer': b[b.length - 1] ^= 0xff; return b;
    case 'truncated': return b.subarray(0, Math.floor(b.length / 2));
    case 'bad-zlib': {
      b[zlibEnds[0] - 1] ^= 0xff; // the last byte of the first object's Adler-32
      const body = b.subarray(0, b.length - 20);
      return Buffer.concat([body, sha1(body)]);
    }
  }
  throw new Error(`unknown damage ${damage}`);
}
async function handPack(seed, objects, form) {
  let entries = objects.map(o => ({ type: o.type, data: Buffer.from(o.data) }));
  if (form.deltaBase !== null) {
    const i = objects.findIndex(o => o.type === TYPE_ID.blob);
    if (i < 0) throw new Error('hand pack: no blob to send as a delta');
    const base = await resolveRef(seed, form.deltaBase);
    const size = Number((await must(run('git', ['cat-file', '-s', base], { cwd: seed.dir, env: seed.env }), 'cat-file -s')).stdout.trim());
    entries = entries.map((e, k) => (k === i ? { refDelta: base, delta: deltaFor(size, e.data, form.delta) } : e));
  }
  return damagePack(writePack(entries), form.damage);
}

// ---- the recording proxy ----
const HOP = new Set(['host', 'connection', 'keep-alive', 'content-length', 'transfer-encoding', 'accept-encoding', 'authorization', 'expect', 'te', 'upgrade', 'proxy-connection']);
// The leading pkt-lines of a body up to the first flush (or the pack signature), as text: the commands of a receive-pack
// request ("<old> <new> <ref>", capabilities cut), or the refs of an advertisement ("<oid> <ref>"). Object ids and ref
// names only; no credential is ever in either.
export function pktLines(buf, limit = 200) {
  const out = [];
  for (let o = 0; o + 4 <= buf.length && out.length < limit;) {
    const h = buf.subarray(o, o + 4).toString('latin1');
    if (!/^[0-9a-f]{4}$/.test(h)) break;
    const n = parseInt(h, 16);
    if (n === 0) { if (out.length > 0 && !out[out.length - 1].startsWith('# service=')) break; o += 4; continue; }
    if (n < 4 || o + n > buf.length) break;
    out.push(buf.subarray(o + 4, o + n).toString('latin1').split('\0')[0].replace(/\n$/, ''));
    o += n;
  }
  return out;
}
const OID_LINE = /^[0-9a-f]{40} /;
// The filter argument of a v2 fetch request, read pkt-line by pkt-line (a line may or may not end in LF).
function filterOf(body) {
  for (let o = 0; o + 4 <= body.length;) {
    const h = body.subarray(o, o + 4).toString('latin1');
    if (!/^[0-9a-f]{4}$/.test(h)) return null;
    const n = parseInt(h, 16);
    if (n < 4) { o += 4; continue; }
    const line = body.subarray(o + 4, o + n).toString('latin1').replace(/\n$/, '');
    if (line.startsWith('filter ')) return line.slice(7);
    o += n;
  }
  return null;
}
export function startRecordingProxy({ upstream, authorization = null, filterPolicy = false }) {
  const base = new URL(upstream);
  const exchanges = [];
  let armed = null; // a types.ts Fault plus `on` ('receive' | 'upload') and, for a race, `run`; for the next matching POST on `main`
  let n = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', async () => {
      const t0 = performance.now();
      const body = Buffer.concat(chunks);
      const m = /^\/(main|side|judge)(\/.*)$/.exec(req.url);
      const rec = { i: n++, channel: m?.[1] ?? '?', method: req.method, path: m?.[2] ?? req.url, status: 0, ms: 0, reqBytes: body.length, resBytes: 0, cfRay: null, fault: null };
      exchanges.push(rec);
      if (!m) { rec.status = 404; res.writeHead(404); res.end(); return; }
      const isReceive = req.method === 'POST' && rec.path.split('?')[0].endsWith('/git-receive-pack');
      const isUpload = req.method === 'POST' && rec.path.split('?')[0].endsWith('/git-upload-pack');
      const plainUpload = isUpload ? (req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body) : null;
      if (filterPolicy && plainUpload !== null) {
        const f = filterOf(plainUpload);
        if (f !== null && f !== 'blob:none') { rec.status = 400; rec.fault = 'policy:filter'; rec.ms = +(performance.now() - t0).toFixed(1); res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); res.end(FILTER_REFUSAL); return; }
      }
      let fault = null;
      const isFetchCommand = plainUpload !== null && plainUpload.includes('command=fetch');
      // stock git first sends a 4-byte probe ("0000") before a body larger than http.postBuffer: not the push
      if (armed !== null && rec.channel === 'main' && (armed.on === 'receive' ? isReceive && body.length > 4 : isFetchCommand)) { fault = armed; armed = null; rec.fault = fault.tag; }
      try {
        if (fault?.tag === 'race') await fault.run();
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && typeof v === 'string') headers[k] = v;
        if (authorization !== null) headers.authorization = authorization;
        const target = new URL(base.pathname.replace(/\/$/, '') + rec.path, base.origin);
        if (fault?.tag === 'cut-request') {
          // the upstream reads part of the body, then the request is aborted; the client hears nothing
          const cutAt = Math.max(1, Math.floor(body.length * fault.fraction));
          const ctl = new AbortController();
          const part = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(body.subarray(0, cutAt))); setTimeout(() => { c.error(new Error('probe: request body cut')); ctl.abort(); }, 500); } });
          rec.cutAt = cutAt;
          try {
            const up = await fetch(target, { method: req.method, headers, body: part, duplex: 'half', redirect: 'manual', signal: ctl.signal });
            rec.status = up.status; rec.cfRay = up.headers.get('cf-ray'); await up.body?.cancel();
          } catch (e) { rec.error = String(e?.message ?? e).slice(0, 200); }
          rec.ms = +(performance.now() - t0).toFixed(1);
          req.socket.destroy();
          return;
        }
        let reqBody = req.method === 'GET' || req.method === 'HEAD' ? undefined : body;
        if (fault?.tag === 'stall-request') {
          const at = Math.max(1, Math.floor(body.length * fault.fraction));
          rec.stallAt = at;
          reqBody = new ReadableStream({ async start(c) { c.enqueue(new Uint8Array(body.subarray(0, at))); await new Promise(r => setTimeout(r, fault.ms)); c.enqueue(new Uint8Array(body.subarray(at))); c.close(); } });
        }
        const up = await fetch(target, { method: req.method, headers, body: reqBody, ...(reqBody instanceof ReadableStream ? { duplex: 'half' } : {}), redirect: 'manual' });
        const buf = Buffer.from(await up.arrayBuffer());
        rec.status = up.status; rec.resBytes = buf.length; rec.cfRay = up.headers.get('cf-ray');
        if (isReceive) { const plain = req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body; rec.commands = pktLines(plain, 400).filter(l => OID_LINE.test(l)); }
        if (req.method === 'GET' && /service=git-receive-pack/.test(rec.path) && up.status === 200) rec.advertised = pktLines(buf, 400).filter(l => OID_LINE.test(l)).map(l => l.replace(/^([0-9a-f]{40}) (\S+).*$/, '$1 $2'));
        rec.ms = +(performance.now() - t0).toFixed(1);
        if (fault?.tag === 'cut-response') { req.socket.destroy(); return; }
        if (fault?.tag === 'stall-response') await new Promise(r => setTimeout(r, fault.ms));
        const out = { 'content-length': String(buf.length) };
        for (const k of ['content-type', 'cache-control', 'cf-ray', 'www-authenticate', 'location']) { const v = up.headers.get(k); if (v !== null) out[k] = v; }
        res.on('error', () => {});
        if (req.socket.destroyed) { rec.clientGone = true; return; }
        res.writeHead(up.status, out);
        if (fault?.tag === 'drop-response') { res.write(buf.subarray(0, Math.floor(buf.length * fault.fraction)), () => req.socket.destroy()); return; }
        res.end(buf);
      } catch (e) {
        rec.status = 502; rec.error = `${String(e?.message ?? e)}${e?.cause ? `: ${e.cause.code ?? ''} ${e.cause.message ?? ''}` : ''}`.slice(0, 300); rec.ms = +(performance.now() - t0).toFixed(1);
        if (!res.headersSent) { res.writeHead(502); res.end(); }
      }
    });
  });
  server.keepAliveTimeout = 120_000; server.headersTimeout = 121_000; server.requestTimeout = 0;
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, exchanges,
    arm: f => { armed = f; }, armedLeft: () => armed !== null, disarm: () => { armed = null; },
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
  })));
}

// ---- clients ----
// A create is a plain push (no lease, no force): git 2.47 does not protect a create with --force-with-lease=<ref>: or
// <ref>:<zero id> (it force-updates a ref that exists), so a lease there would turn a lost create race into a silent
// overwrite. Without force, git refuses client side when its advertisement already has the ref ("fetch first") and
// otherwise sends the zero old id for the server to check. An update or delete carries a lease on the plan's old id.
const gitArgs = (seed, push) => [
  ...(push.atomic ? ['--atomic'] : []),
  ...push.updates.filter(u => u.old.tag !== 'zero').map(u => `--force-with-lease=${u.ref}:${oidOf(seed, u.old)}`),
];
const gitSpecs = (seed, push) => push.updates.map(u => (u.new.tag === 'zero' ? `:${u.ref}` : `${u.old.tag === 'zero' ? '' : '+'}${oidOf(seed, u.new)}:${u.ref}`));

const plyErr = (r, prefix = '') => plyOutcome({ ok: false, code: r.error.code, message: `${prefix}${String(r.error.message)}` });
const plyLimits = timeouts => (timeouts === null ? {} : { limits: { firstByteTimeoutMs: timeouts.ms, idleTimeoutMs: timeouts.ms } });
const gitTimeouts = timeouts => (timeouts === null ? [] : ['-c', 'http.lowSpeedLimit=1', '-c', `http.lowSpeedTime=${Math.ceil(timeouts.ms / 1000)}`]);
async function plyFetch(url, seed, st, tracer, parent) {
  const client = GitHttp.create(url, { tracer, parent, recordResponseHeaders: ['cf-ray'], quirks: {}, ...plyLimits(st.timeouts) });
  if (!client.ok) return plyErr(client);
  const want = seed.names[st.want];
  const f = await client.value.fetchPack({ wants: [want] });
  if (!f.ok) return plyErr(f);
  return f.value.objects?.has(want) ? { outcome: 'landed', error: null, detail: `fetched ${f.value.objects.size} objects` } : { outcome: 'rejected', error: 'harness', detail: 'the wanted object did not arrive' };
}
async function gitFetch(url, seed, st, root) {
  const dir = join(root, `fetch-${fromN++}.git`);
  await must(run('git', ['init', '-q', '--bare', dir], { env: seed.env }), 'init fetch');
  const r = await run('git', [...gitTimeouts(st.timeouts), 'fetch', '-q', url, st.ref], { cwd: dir, env: seed.env });
  return gitFetchOutcome(r.status, r.stderr);
}
async function plyPush(url, seed, scenario, push, tracer, parent, from = { tag: 'full' }, timeouts = null) {
  const client = GitHttp.create(url, { tracer, parent, recordResponseHeaders: ['cf-ray'], quirks: {}, ...plyLimits(timeouts) });
  if (!client.ok) return plyErr(client);
  if (from.tag === 'partial') {
    // ply's partial clone: main's commits and trees, no blob
    const tip = seed.names[scenario.seed.refs.find(r => r.ref === 'refs/heads/main')?.at ?? ''];
    const f = await client.value.fetchPack({ wants: [tip], filter: 'blob:none' });
    if (!f.ok) return plyErr(f, 'partial fetch: ');
    const blobs = [...(f.value.objects?.values() ?? [])].filter(o => o.type === TYPE_ID.blob).length;
    if (blobs > 0) return { outcome: 'rejected', error: 'harness', detail: `partial fetch carried ${blobs} blobs` };
  }
  const objects = await objectsFor(seed, scenario, push);
  const commands = push.updates.map(u => ({ ref: u.ref, oldOid: oidOf(seed, u.old), newOid: oidOf(seed, u.new) }));
  const atomic = push.atomic ? { atomic: true } : {};
  let r;
  if (push.pack.tag === 'hand') {
    const bytes = new Uint8Array(await handPack(seed, objects, push.pack));
    const pack = new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
    r = await client.value.pushPack({ commands, pack, length: bytes.length, ...atomic });
  } else r = await client.value.push({ commands, objects, ...atomic });
  return r.ok ? plyOutcome({ ok: true }) : plyErr(r);
}
// The repository stock git pushes from (types.ts From): the seed store, a shallow fetch out of it, or a blob:none
// clone of the target with the push's new objects added.
let fromN = 0;
async function gitFrom(seed, scenario, push, from, root, cloneUrl) {
  if (from.tag === 'full') return seed.dir;
  const dir = join(root, `${from.tag}-${fromN++}.git`);
  if (from.tag === 'shallow') {
    await must(run('git', ['update-ref', 'refs/probe/tip', seed.names[from.tip]], { cwd: seed.dir, env: seed.env }), 'tip ref');
    await must(run('git', ['init', '-q', '--bare', dir], { env: seed.env }), 'init shallow');
    await must(run('git', ['fetch', '-q', `--depth=${from.depth}`, `file://${seed.dir}`, 'refs/probe/tip:refs/heads/tip'], { cwd: dir, env: seed.env }), 'shallow fetch');
    return dir;
  }
  await must(run('git', ['clone', '-q', '--bare', '--filter=blob:none', cloneUrl, dir], { env: seed.env }), 'partial clone');
  const news = push.updates.map(u => oidOf(seed, u.new)).filter(o => o !== ZERO);
  const have = scenario.seed.refs.map(r => seed.names[r.at]);
  const pack = (await must(run('git', ['pack-objects', '--stdout', '--revs', '-q'], { cwd: seed.dir, env: seed.env, input: `${news.join('\n')}\n${have.map(h => `^${h}`).join('\n')}\n` }), 'pack-objects')).out;
  await must(run('git', ['index-pack', '--stdin'], { cwd: dir, env: seed.env, input: pack }), 'index-pack into the partial clone');
  return dir;
}
async function gitPush(url, seed, push, cwd = seed.dir, timeouts = null) {
  const r = await run('git', [...gitTimeouts(timeouts), 'push', '--porcelain', ...gitArgs(seed, push), url, ...gitSpecs(seed, push)], { cwd, env: seed.env });
  return { ...gitOutcome(r.status, r.stdout, r.stderr, new Set(push.updates.filter(u => u.old.tag === 'zero').map(u => u.ref))), exit: r.status };
}
async function forcePush(url, seed, moves) {
  const specs = moves.map(mv => (mv.to.tag === 'zero' ? `:${mv.ref}` : `+${oidOf(seed, mv.to)}:${mv.ref}`));
  return must(run('git', ['push', '--porcelain', '--force', url, ...specs], { cwd: seed.dir, env: seed.env }), 'side push');
}

// ---- the judge: stock git reads the target back ----
export async function observeEnd(url, root, env) {
  const ls = await must(run('git', ['ls-remote', '--symref', url], { cwd: root, env }), 'ls-remote');
  let head = null; const refs = {};
  for (const line of ls.stdout.split('\n').filter(Boolean)) {
    const sym = /^ref: (\S+)\tHEAD$/.exec(line);
    if (sym) { head = sym[1]; continue; }
    const [oid, name] = line.split('\t');
    if (name === 'HEAD' || name.endsWith('^{}')) continue;
    refs[name] = oid;
  }
  if (Object.keys(refs).length === 0) return { head, refs, objects: [], trees: {}, ancestry: [], mergeBases: {}, fsck: [] };
  const dir = join(root, `judge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.git`);
  await must(run('git', ['clone', '-q', '--mirror', url, dir], { cwd: root, env }), 'clone --mirror');
  const g = async args => (await must(run('git', args, { cwd: dir, env }), args[0])).stdout;
  const objects = (await g(['rev-list', '--objects', '--no-object-names', '--all'])).trim().split('\n').filter(Boolean).sort();
  const trees = {};
  for (const r of Object.keys(refs)) { const t = await run('git', ['rev-parse', '--verify', '-q', `${r}^{tree}`], { cwd: dir, env }); if (t.status === 0) trees[r] = t.stdout.trim(); }
  const ancestry = (await g(['rev-list', '--parents', '--all'])).trim().split('\n').filter(Boolean).sort();
  const heads = Object.keys(refs).filter(r => r.startsWith('refs/heads/')).sort();
  const mergeBases = {};
  if (heads.length <= 8) for (let i = 0; i < heads.length; i++) for (let j = i + 1; j < heads.length; j++) {
    const mb = await run('git', ['merge-base', '--all', heads[i], heads[j]], { cwd: dir, env });
    mergeBases[`${heads[i]}..${heads[j]}`] = mb.stdout.trim().split('\n').filter(Boolean).sort().join(',');
  }
  const fsck = fsckProblems(dir);
  rmSync(dir, { recursive: true, force: true });
  return { head, refs, objects, trees, ancestry, mergeBases, fsck };
}

// ---- one scenario on one target ----
// target: { name: Target, client: 'ply' | 'git', proxy, repoPath } where repoPath is the path under the proxy's
// upstream (e.g. `/s3.git` or `/git/<namespace>/<repo>.git`).
export async function runScenario(scenario, target, { tracer, root }) {
  const seed = await buildSeed(root, scenario.seed);
  const url = ch => `${target.proxy.url}/${ch}${target.repoPath}`;
  const rootSpan = tracer.start('probe.run', { attrs: { 'probe.scenario': scenario.id, 'probe.target': target.name } });
  const steps = [], stepExchanges = [];
  try {
    if (scenario.seed.refs.length > 0) {
      const s = tracer.start('probe.seed', { parent: rootSpan });
      const r = await run('git', ['push', '--porcelain', url('side'), ...scenario.seed.refs.map(x => `${seed.names[x.at]}:${x.ref}`)], { cwd: seed.dir, env: seed.env });
      s.set({ 'process.exit.code': r.status }).end();
      if (r.status !== 0) throw new Error(`seed push failed: ${r.stderr.trim().slice(0, 400)}`);
    }
    for (const [i, st] of scenario.steps.entries()) {
      const span = tracer.start('probe.step', { parent: rootSpan, attrs: { 'probe.step': i, 'probe.step.kind': st.tag, 'probe.client': target.client } });
      const before = target.proxy.exchanges.length;
      let outcomes;
      if (target.client === 'git' && st.git.tag === 'none') outcomes = [{ outcome: 'landed', error: 'skipped', detail: st.git.why }];
      else if (target.client === 'ply' && st.tag === 'push' && st.ply.tag === 'none') outcomes = [{ outcome: 'landed', error: 'skipped', detail: st.ply.why }];
      else if (st.tag === 'push' || st.tag === 'fetch') {
        const cwd = st.tag === 'push' && target.client === 'git' ? await gitFrom(seed, scenario, st.push, st.from, root, url('main')) : null;
        const f = st.fault;
        if (f.tag !== 'none') target.proxy.arm({ ...f, on: st.tag === 'push' ? 'receive' : 'upload', ...(f.tag === 'race' ? { run: () => forcePush(url('side'), seed, f.moves) } : {}) });
        const r = st.tag === 'fetch'
          ? (target.client === 'ply' ? await plyFetch(url('main'), seed, st, tracer, span) : await gitFetch(url('main'), seed, st, root))
          : (target.client === 'ply' ? await plyPush(url('main'), seed, scenario, st.push, tracer, span, st.from, st.timeouts) : await gitPush(url('main'), seed, st.push, cwd, st.timeouts));
        const unfired = target.proxy.armedLeft();
        target.proxy.disarm();
        outcomes = [{ outcome: r.outcome, error: r.error, detail: unfired ? `fault ${st.fault.tag} never fired; ${r.detail}` : r.detail }];
      } else if (st.tag === 'retry-unlanded') {
        const prev = scenario.steps[st.of], seen = steps[st.of];
        const pushes = prev?.tag === 'concurrent' ? prev.pushes : prev?.tag === 'push' ? [prev.push] : [];
        outcomes = [];
        for (const [k, p] of pushes.entries()) {
          const first = seen?.outcomes[k];
          if (first?.outcome === 'landed') { outcomes.push({ outcome: 'landed', error: null, detail: 'landed the first time' }); continue; }
          const r = target.client === 'ply' ? await plyPush(url('main'), seed, scenario, p, tracer, span) : await gitPush(url('main'), seed, p);
          outcomes.push({ outcome: r.outcome, error: r.error, detail: `retry after ${first?.outcome ?? '?'}: ${r.detail}` });
        }
      } else {
        const rs = await Promise.all(st.pushes.map(p => (target.client === 'ply' ? plyPush(url('main'), seed, scenario, p, tracer, span) : gitPush(url('main'), seed, p))));
        outcomes = rs.map(r => ({ outcome: r.outcome, error: r.error, detail: r.detail }));
      }
      const ex = target.proxy.exchanges.slice(before);
      span.set({ 'probe.outcomes': outcomes.map(o => o.outcome).join(','), 'probe.errors': outcomes.map(o => String(o.error)).join(','), 'probe.exchanges': ex.length, 'probe.cf_rays': ex.map(e => e.cfRay).filter(Boolean).join(',') }).end();
      steps.push({ outcomes });
      stepExchanges.push(ex);
    }
    const js = tracer.start('probe.judge', { parent: rootSpan });
    const end = await observeEnd(url('judge'), root, seed.env);
    js.set({ 'probe.refs': Object.keys(end.refs).length, 'probe.objects': end.objects.length, 'probe.fsck_problems': end.fsck.length }).end();
    rootSpan.ok().end();
    return { observation: { steps, end }, byOid: seed.byOid, stepExchanges };
  } catch (e) {
    rootSpan.error(e).end();
    throw e;
  }
}

// ---- the reference target: git http-backend with Artifacts' policy, behind the recording proxy ----
export async function startReference() {
  const root = mkdtempSync(join(tmpdir(), 'ply-probes-ref-'));
  const repos = join(root, 'repos'); mkdirSync(repos);
  const srv = await startGitServer(repos);
  const proxy = await startRecordingProxy({ upstream: srv.url, filterPolicy: true });
  let n = 0;
  return {
    root, proxy,
    async repo(scenario) {
      const name = `r${n++}`;
      const dir = join(repos, `${name}.git`);
      const env = gitEnv(root);
      await must(run('git', ['init', '-q', '--bare', '-b', 'main', dir], { env }), 'init reference repo');
      for (const [k, v] of [...REFERENCE_POLICY, ...scenario.referenceConfig]) await must(run('git', ['config', k, v], { cwd: dir, env }), `config ${k}`);
      return { repoPath: `/${name}.git`, dir };
    },
    close: async () => { await proxy.close(); await srv.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

export function newTracer() {
  const exporter = arrayExporter();
  return { tracer: new Tracer({ exporter, resource: { 'service.name': 'ply-probes' } }), spans: () => exporter.lines.flatMap(flattenLine) };
}
