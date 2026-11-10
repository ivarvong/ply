// ply-memlab: a scratch Worker that runs ply's streaming paths inside real isolate limits (128 MB memory, the CPU limit
// in worker.config). It is a measurement rig, not product code: bench/worker-mem/README.md says how to run it.
//
// Every route needs `Authorization: Bearer <MEMLAB_TOKEN>`. Read access to the seed repo comes from the Artifacts
// binding (namespace ply-loadgen): each request mints its own short-lived read token and revokes it when done.
//
// Responses are NDJSON: progress lines while a cell runs (so the client sees bytes long before the end), then one
// `{"final":true,...}` line. Each request also logs one `memlab` line, which joins the cell to its Workers Observability
// invocation (CPU, wall, outcome) by request id.
import * as ply from '../../dist/index.js';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const READ_TOKEN_TTL_S = 900;
const PROGRESS_EVERY_BYTES = 64 * MIB;
// The transport counts every band-1 byte against maxPackBytes. The seed pack is ~1 GiB, so the transport cap is raised
// here and only here; the scan's own budget (WORK_BUDGET) is what bounds inflate work. Time is bounded by ply's
// default stall limits (#258): firstByteTimeoutMs and idleTimeoutMs, 60 s each, cut an exchange that stops making
// progress, while a long one that keeps streaming (the ~55 s scan of the ~1 GiB pack, run ml-20261110t034240z) runs
// on. No whole-exchange requestTimeoutMs: a cap sized to the pack would only hide a stall behind a longer wait.
const TRANSPORT_LIMITS = ply.withLimits({ maxPackBytes: 8 * GIB });

const enc = new TextEncoder();

async function authorized(req, env) {
  const got = req.headers.get('authorization') ?? '';
  const want = `Bearer ${env.MEMLAB_TOKEN ?? ''}`;
  if (!env.MEMLAB_TOKEN) return false;
  const a = enc.encode(got);
  const b = enc.encode(want);
  if (a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

// A read token for one repo, minted through the binding and revoked by the returned function.
async function readToken(env, repo, scope = 'read') {
  const handle = await env.REPOS.get(repo);
  const minted = await handle.createToken(scope, READ_TOKEN_TTL_S);
  // 'revoked', or why not: expiry (READ_TOKEN_TTL_S) is the backstop either way.
  const revoke = async () => {
    try {
      if (!minted.id) return 'no-id';
      if (typeof handle.revokeToken !== 'function') return 'no-revokeToken';
      await handle.revokeToken(minted.id);
      return 'revoked';
    } catch (e) { return `revoke-failed: ${String(e?.message ?? e).slice(0, 120)}`; }
  };
  return { token: minted.plaintext, revoke };
}

function client(remote, token, limits = TRANSPORT_LIMITS) {
  const gh = ply.GitHttp.create(remote, { auth: { token, user: 'x' }, limits });
  if (!gh.ok) throw new Error(`transport: ${gh.error.code} ${gh.error.message}`);
  return gh.value;
}

const scanLimits = name => (name === 'worker' ? ply.WORKER_LIMITS : ply.DEFAULT_LIMITS);

// Drives one pack scan over an async source of byte chunks. Returns counts; a refusal is returned, not thrown.
async function scanSource(source, opts, progress) {
  const init = ply.parsePackInit(opts);
  if (!init.ok) return { ok: false, error: { code: init.error.code, message: init.error.message } };
  const scan = init.value;
  const out = { objects: 0, deltas: 0, types: {}, packBytes: 0, inflated: 0, trailer: null, maxChunk: 0 };
  let nextProgress = PROGRESS_EVERY_BYTES;
  const drain = () => {
    for (;;) {
      const p = ply.parsePackPull(scan);
      if (!p.ok) return { error: p.error };
      const piece = p.value;
      switch (piece.kind) {
        case 'need': return { need: true };
        case 'header': out.count = piece.count; break;
        case 'object':
          out.objects++;
          out.types[piece.type] = (out.types[piece.type] ?? 0) + 1;
          if (piece.base.tag !== 'none') out.deltas++;
          break;
        case 'chunk':
          out.inflated += piece.bytes.length;
          if (piece.bytes.length > out.maxChunk) out.maxChunk = piece.bytes.length;
          break;
        case 'object-end': break;
        case 'trailer': out.trailer = piece.trailer; break;
        case 'end': return { end: true };
        default: break;
      }
    }
  };
  for await (const chunk of source) {
    out.packBytes += chunk.length;
    ply.parsePackFeed(scan, chunk);
    const r = drain();
    if (r.error) return { ok: false, error: { code: r.error.code, message: r.error.message, what: r.error.what ?? null }, ...out };
    if (r.end) return { ok: true, ...out };
    if (out.packBytes >= nextProgress) {
      nextProgress += PROGRESS_EVERY_BYTES;
      await progress({ packBytes: out.packBytes, objects: out.objects, inflated: out.inflated });
    }
  }
  ply.parsePackClose(scan);
  const r = drain();
  if (r.error) return { ok: false, error: { code: r.error.code, message: r.error.message, what: r.error.what ?? null }, ...out };
  return { ok: Boolean(r.end), ...out, ...(r.end ? {} : { error: { code: 'harness', message: 'pack ended without end piece' } }) };
}

// Cell 1: fetch the whole seed history as one pack and scan it with the work budget, holding nothing.
async function cellScan(q, env, progress) {
  const { token, revoke } = await readToken(env, q.repo);
  try {
    const gh = client(q.remote, token);
    const span = gh.tracer.start('memlab.scan');
    const t0 = Date.now();
    const source = gh.packStream({ wants: [q.commit] }, span);
    const r = await scanSource(source, ply.packScanOpts(scanLimits(q.limits), true, ply.WORK_BUDGET), progress);
    span.end();
    return { ...r, wallMs: Date.now() - t0, limits: q.limits ?? 'default', budget: 'WORK_BUDGET' };
  } finally { tokenState.last = await revoke(); }
}

// Cell 2: one large blob through ply's read path (openBlob: fetch, inflate, verify), streamed and counted, not held.
async function cellRead(q, env) {
  const { token, revoke } = await readToken(env, q.repo);
  try {
    const gh = client(q.remote, token, ply.DEFAULT_LIMITS);
    const t0 = Date.now();
    const opened = await ply.openBlob(gh.t, q.blob);
    if (!opened.ok) return { ok: false, error: { code: opened.error.code, message: opened.error.message }, wallMs: Date.now() - t0 };
    const reader = opened.value.stream.getReader();
    let bytes = 0;
    let maxChunk = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (value.length > maxChunk) maxChunk = value.length;
    }
    return { ok: bytes === opened.value.size, size: opened.value.size, bytes, maxChunk, wallMs: Date.now() - t0 };
  } finally { tokenState.last = await revoke(); }
}

// A one-object pack whose blob inflates to `declared` zero bytes. Built once per isolate (CompressionStream is native).
let bombCache = null;
async function bombPack(declared) {
  if (bombCache && bombCache.declared === declared) return { ...bombCache, cached: true };
  const t0 = Date.now();
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  const zeros = new Uint8Array(MIB);
  const pump = (async () => {
    for (let left = declared; left > 0; left -= MIB) await writer.write(left >= MIB ? zeros : zeros.subarray(0, left));
    await writer.close();
  })();
  const parts = [];
  for await (const c of cs.readable) parts.push(c);
  await pump;
  const z = ply.concat(parts);
  const head = ply.encodeObjHeader(3, declared);
  const body = ply.concat([enc.encode('PACK'), new Uint8Array([0, 0, 0, 2, 0, 0, 0, 1]), head, z]);
  const sha = new Uint8Array(await crypto.subtle.digest('SHA-1', body));
  bombCache = { declared, pack: ply.concat([body, sha]), zlibBytes: z.length, genMs: Date.now() - t0 };
  return { ...bombCache, cached: false };
}

// Cell 3: the bomb must be refused before inflate work runs past the budget.
async function cellBomb(q, _env, progress) {
  const declared = Number(q.declared ?? GIB);
  const bomb = await bombPack(declared);
  const feed = async function* () {
    const step = 64 * 1024;
    for (let i = 0; i < bomb.pack.length; i += step) yield bomb.pack.subarray(i, i + step);
  };
  const t0 = Date.now();
  const r = await scanSource(feed(), ply.packScanOpts(scanLimits(q.limits), true, ply.WORK_BUDGET), progress);
  return { ...r, refused: !r.ok, declared, packLen: bomb.pack.length, zlibBytes: bomb.zlibBytes, genMs: bomb.genMs, genCached: bomb.cached, scanMs: Date.now() - t0, limits: q.limits ?? 'default' };
}

// The last token's revoke outcome, reported on the cell's final line.
const tokenState = { last: null, write: null };
const pending = (name, why) => ({ ok: false, pending: true, cell: name, why });

// Cell 4a: the streaming pack index (#236, scanPackIndex): the whole seed history from packStream, oids on (each whole
// object hashed while streaming), work budget, verify on. Reports the index's own held column bytes and how many
// entries' resolved type stayed unknown.
async function cellIndex(q, env) {
  const fn = ply.scanPackIndex;
  if (typeof fn !== 'function') return pending('index', 'ply has no scanPackIndex export (#236)');
  const { token, revoke } = await readToken(env, q.repo);
  try {
    const gh = client(q.remote, token);
    const span = gh.tracer.start('memlab.index');
    const t0 = Date.now();
    const oids = q.oids !== 'off';
    const r = await fn(gh.packStream({ wants: [q.commit] }, span), { oids, budget: ply.WORK_BUDGET, verify: true, limits: scanLimits(q.limits) });
    span.end();
    if (!r.ok) return { ok: false, error: { code: r.error.code, message: String(r.error.message).slice(0, 300) }, wallMs: Date.now() - t0 };
    const v = r.value;
    const types = {};
    let unknown = 0;
    for (let i = 0; i < v.count; i++) {
      const t = v.columns.type[i];
      if (t === 0) unknown++;
      types[t] = (types[t] ?? 0) + 1;
    }
    return { ok: true, count: v.count, objects: v.count, packBytes: v.bytes, trailer: v.trailer, heldBytes: v.heldBytes, perEntryBytes: v.count ? v.heldBytes / v.count : null, resolvedTypes: types, unknownType: unknown, oids, wallMs: Date.now() - t0 };
  } finally { tokenState.last = await revoke(); }
}

// R2 spool (harness-side; ply stays storage-neutral). The pack is written once by the `spool` cell as a multipart
// upload in fixed parts (R2 needs every part but the last the same size), then read back by range for resolvePackRange.
const SPOOL_PART_BYTES = 16 * MIB;
const spoolKey = q => `spool/${q.key}`;

// A ply RangeSource over one R2 object: each read is one ranged get, streamed.
function r2Range(bucket, key, size) {
  return {
    size,
    read: async (offset, length) => {
      if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > size) {
        return { ok: false, error: ply.plyError('bad_request', `range ${offset}+${length} outside ${size} bytes`) };
      }
      if (length === 0) return { ok: true, value: new ReadableStream({ start(c) { c.close(); } }) };
      const obj = await bucket.get(key, { range: { offset, length } });
      if (!obj || !obj.body) return { ok: false, error: ply.plyError('not_found', `spool object ${key} is gone`) };
      return { ok: true, value: obj.body };
    },
  };
}

// Cell: spool the whole seed history into R2 (run once per key).
async function cellSpool(q, env, progress) {
  const { token, revoke } = await readToken(env, q.repo);
  try {
    const gh = client(q.remote, token);
    const span = gh.tracer.start('memlab.spool');
    const t0 = Date.now();
    const up = await env.SPOOL.createMultipartUpload(spoolKey(q));
    const parts = [];
    let buf = new Uint8Array(SPOOL_PART_BYTES);
    let fill = 0;
    let total = 0;
    const flush = async last => {
      if (fill === 0 && !last) return;
      parts.push(await up.uploadPart(parts.length + 1, fill === SPOOL_PART_BYTES ? buf : buf.slice(0, fill)));
      buf = new Uint8Array(SPOOL_PART_BYTES);
      fill = 0;
    };
    try {
      for await (const chunk of gh.packStream({ wants: [q.commit] }, span)) {
        let at = 0;
        while (at < chunk.length) {
          const n = Math.min(chunk.length - at, SPOOL_PART_BYTES - fill);
          buf.set(chunk.subarray(at, at + n), fill);
          fill += n; at += n; total += n;
          if (fill === SPOOL_PART_BYTES) { await flush(false); if (parts.length % 8 === 0) await progress({ spooled: total }); }
        }
      }
      if (fill > 0) await flush(true);
      const done = await up.complete(parts);
      span.end();
      return { ok: done.size === total, key: spoolKey(q), size: done.size, packBytes: total, parts: parts.length, wallMs: Date.now() - t0 };
    } catch (e) {
      await up.abort().catch(() => {});
      throw e;
    }
  } finally { tokenState.last = await revoke(); }
}

// Cell: scanPackIndex over the spooled object, then resolvePackRange over R2 ranged reads. Every entry must end with a
// type and an oid (unknowns 0). Held memory is the two indexes' columns plus the resolver's base cache bound.
async function cellResolve(q, env) {
  const head = await env.SPOOL.head(spoolKey(q));
  if (!head) return { ok: false, error: { code: 'harness', message: `no spool object ${spoolKey(q)}` } };
  const t0 = Date.now();
  const obj = await env.SPOOL.get(spoolKey(q));
  const idx = await ply.scanPackIndex(obj.body, { oids: true, budget: ply.WORK_BUDGET, verify: true, limits: ply.DEFAULT_LIMITS });
  if (!idx.ok) return { ok: false, phase: 'index', error: { code: idx.error.code, message: String(idx.error.message).slice(0, 300) } };
  const scanMs = Date.now() - t0;
  let indexUnknown = 0;
  for (let i = 0; i < idx.value.count; i++) if (idx.value.columns.type[i] === 0) indexUnknown++;
  const cacheBytes = Number(q.cacheBytes ?? ply.RESOLVE_CACHE_BYTES);
  const res = await ply.resolvePackRange(idx.value, r2Range(env.SPOOL, spoolKey(q), head.size), { cacheBytes, budget: ply.WORK_BUDGET, limits: ply.DEFAULT_LIMITS });
  if (!res.ok) return { ok: false, phase: 'resolve', error: { code: res.error.code, message: String(res.error.message).slice(0, 300) }, indexUnknown };
  const r = res.value;
  let unknownType = 0;
  let unknownOid = 0;
  const types = {};
  for (let i = 0; i < r.count; i++) {
    const t = r.type(i);
    if (t.tag !== 'some') unknownType++; else types[t.value] = (types[t.value] ?? 0) + 1;
    if (r.oid(i).tag !== 'some') unknownOid++;
  }
  const headFound = q.commit ? r.find(q.commit).tag === 'some' : null;
  return {
    ok: unknownType === 0 && unknownOid === 0 && headFound !== false, count: r.count, packBytes: head.size, indexUnknown, unknownType, unknownOid, types, headFound,
    indexHeldBytes: idx.value.heldBytes, resolvedHeldBytes: r.heldBytes, cacheBytes, heldBoundBytes: idx.value.heldBytes + r.heldBytes + cacheBytes,
    stats: r.stats, scanMs, wallMs: Date.now() - t0,
  };
}

// Cell: delete a spooled object.
async function cellSpoolDel(q, env) {
  const had = await env.SPOOL.head(spoolKey(q));
  await env.SPOOL.delete(spoolKey(q));
  const after = await env.SPOOL.head(spoolKey(q));
  return { ok: after === null, existed: Boolean(had), key: spoolKey(q) };
}

// Cell 4b: pushPack (#234). Relays one seed commit to the destination repo as one streamed pack: the fetch asks for
// `new` with `old` as a have (so the pack is that commit's new objects only, under the 64 MiB push cap), and its band-1
// bytes go straight into pushPack's request body. Nothing is buffered past a chunk or two. ply's own cap is set just
// under the host's, so an oversize pack is refused by ply while sending, not by the server.
const PUSH_LIMITS = ply.withLimits({ maxPackBytes: 64 * MIB - 64 * 1024 });
async function cellPushPack(q, env, progress) {
  if (typeof ply.pushPack !== 'function') return pending('pushpack', 'ply has no pushPack export (#234)');
  const src = await readToken(env, q.repo);
  let dst = null;
  try {
    dst = await readToken(env, q.dst, 'write');
    const from = client(q.remote, src.token);
    const to = client(q.dstRemote, dst.token, PUSH_LIMITS);
    const span = from.tracer.start('memlab.relay');
    const old = q.old && q.old !== ply.ZERO_OID ? q.old : null;
    const gen = from.packStream({ wants: [q.new], ...(old ? { haves: [old] } : {}), done: true }, span);
    let packBytes = 0;
    let nextProgress = PROGRESS_EVERY_BYTES / 4;
    let maxChunk = 0;
    const pack = new ReadableStream({
      async pull(c) {
        const n = await gen.next();
        if (n.done) { c.close(); return; }
        packBytes += n.value.length;
        if (n.value.length > maxChunk) maxChunk = n.value.length;
        if (packBytes >= nextProgress) { nextProgress += PROGRESS_EVERY_BYTES / 4; await progress({ packBytes }); }
        c.enqueue(n.value);
      },
      async cancel(reason) { await gen.return?.(reason); },
    });
    const t0 = Date.now();
    const r = await ply.pushPack(to.t, { commands: [{ ref: 'refs/heads/main', oldOid: old ?? ply.ZERO_OID, newOid: q.new }], pack });
    span.end();
    if (!r.ok) return { ok: false, error: { code: r.error.code, message: String(r.error.message).slice(0, 300), original: r.error.original?.code ?? null }, packBytes, maxChunk, wallMs: Date.now() - t0 };
    const report = JSON.stringify(r.value.report);
    const refOk = report.includes('refs/heads/main') && !/\bng\b/.test(report);
    return { ok: refOk, packBytes, sentBytes: r.value.packBytes, maxChunk, wallMs: Date.now() - t0, report: report.slice(0, 300) };
  } finally {
    tokenState.last = await src.revoke();
    if (dst) tokenState.write = await dst.revoke();
  }
}

const CELLS = { scan: cellScan, read: cellRead, bomb: cellBomb, index: cellIndex, pushpack: cellPushPack, spool: cellSpool, resolve: cellResolve, spooldel: cellSpoolDel };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const version = env.VERSION?.id ?? '';
    // Build-time constants from build.mjs (esbuild define).
    const build = { 'x-memlab-version': version, 'x-memlab-ply': __PLY_SHA__, 'x-memlab-cpu-limit-ms': String(__CPU_LIMIT_MS__) };
    if (url.pathname === '/health') return new Response('ok', { headers: build });
    if (!(await authorized(req, env))) return new Response('unauthorized', { status: 401 });
    const m = /^\/cell\/([a-z]+)$/.exec(url.pathname);
    const cell = m ? CELLS[m[1]] : undefined;
    if (!cell) return new Response('no such cell', { status: 404 });
    const q = Object.fromEntries(url.searchParams);
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const line = obj => writer.write(enc.encode(`${JSON.stringify(obj)}\n`));
    const run = (async () => {
      const t0 = Date.now();
      let result;
      try {
        tokenState.last = null;
        tokenState.write = null;
        result = await cell(q, env, p => line({ progress: true, ...p }));
        if (tokenState.last) result = { ...result, readToken: tokenState.last };
        if (tokenState.write) result = { ...result, writeToken: tokenState.write };
      } catch (e) {
        result = { ok: false, error: { code: e?.code ?? 'thrown', message: String(e?.message ?? e) } };
      }
      const label = q.label ?? m[1];
      const final = { final: true, route: m[1], label, run: q.run ?? '', i: Number(q.i ?? -1), version, ply: build['x-memlab-ply'], cpuLimitMs: Number(build['x-memlab-cpu-limit-ms']), totalMs: Date.now() - t0, ...result };
      console.log(JSON.stringify({ memlab: true, label, run: final.run, i: final.i, ok: final.ok, pending: Boolean(final.pending) }));
      await line(final);
      await writer.close();
    })();
    ctx.waitUntil(run);
    return new Response(readable, { headers: { 'content-type': 'application/x-ndjson', 'x-memlab-version': version, 'cache-control': 'no-store' } });
  },
};
