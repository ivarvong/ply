// The ply pipeline running inside workerd. POST /edit with {url, path, find, replace, n?} runs editFile n times
// (sequentially, or concurrently with ?concurrent=1) and reports results, spans summary, and timing.
import { editFile } from '../../src/edit.js';
import { readFile, openBlob } from '../../src/read.js';
import { unwrapAsync, unwrap } from '../unwrap.js';
import { Tracer, arrayExporter, flattenLine } from '../../src/otel.js';
import { GitHttp } from '../../src/client.js';
import { withLimits } from '../../src/limits.js';
import { cachingFetch, memoryCache } from '../../src/packcache.js';
import { BLOB_CACHE_MAX_BYTES, BLOB_CACHE_MAX_AGE_SECONDS } from '../../src/blobcache.js';
import { generateSigner } from '../../src/sign.js';
import { createTransport } from '../../src/http.js';
import { push, ZERO_OID } from '../../src/push.js';
import { hashObject, encodeTree, encodeCommit, TYPE } from '../../src/objects.js';
import { measurePack, streamPack } from '../../src/packwrite.js';
import { buildPack } from '../../src/pack.js';
import { failure, fetchOps } from '../sweep/ops.mjs';

// module-scoped: survives across requests within the isolate, like a real worker would hold it
const packCache = typeof caches !== 'undefined' ? caches.default : null;

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    if (u.pathname === '/ping') return new Response('pong');
    if (u.pathname === '/features') {
      const f = {};
      f.DecompressionStream = typeof DecompressionStream;
      f.CompressionStream = typeof CompressionStream;
      f.AbortSignalAny = typeof AbortSignal.any;
      f.AbortSignalTimeout = typeof AbortSignal.timeout;
      f.getRandomValues = typeof crypto.getRandomValues;
      f.subtle = typeof crypto.subtle;
      f.performanceNow = typeof performance?.now;
      f.dateNowAdvances = (() => { const a = Date.now(); let x = 0; for (let i = 0; i < 1e6; i++) x += i; return Date.now() - a; })();
      try { const ds = new DecompressionStream('deflate'); f.deflateOk = !!ds; } catch (e) { f.deflateOk = e.message; }
      return Response.json(f);
    }
    if (u.pathname === '/fetchpack') {
      const body = await req.json();
      const exporter = arrayExporter();
      const c = unwrap(GitHttp.create(body.url, { tracer: new Tracer({ exporter }) }));
      const t0 = Date.now();
      try {
        const r = await unwrapAsync(c.fetchPack(body.req));
        return Response.json({ ok: true, objects: r.parsed?.stats.count ?? 0, ms: Date.now() - t0, spans: exporter.lines.flatMap(flattenLine).map(s => ({ name: s.name, ms: s.durationMs, attrs: pick(s.attrs) })) });
      } catch (e) { return Response.json({ ok: false, code: e.code, message: e.message, ms: Date.now() - t0 }); }
    }
    if (u.pathname === '/redirect') { // ply against a redirecting server; plus what workerd's own `follow` does with Authorization
      const body = await req.json();
      const c = unwrap(GitHttp.create(body.url, { tracer: new Tracer(), auth: body.auth }));
      const res = {};
      for (const [k, op] of [['get', () => unwrapAsync(c.discover())], ['post', () => unwrapAsync(c.lsRefs())]]) { try { await op(); res[k] = { ok: true }; } catch (e) { res[k] = { code: e.code, status: e.status, message: e.message }; } }
      try { const r = await fetch(`${body.url}/info/refs?service=git-upload-pack`, { headers: { Authorization: 'Bearer workerd-follow-probe' } }); res.follow = { status: r.status, url: r.url }; await r.body?.cancel(); } catch (e) { res.follow = { error: e.message }; }
      return Response.json(res);
    }
    if (u.pathname === '/read') { // readFile's blob stream, drained or cancelled after one chunk: its follows span (#35)
      const body = await req.json();
      const exporter = arrayExporter();
      try {
        const r = await unwrapAsync(readFile(body.url, { path: body.path }, { tracer: new Tracer({ exporter }), ...(body.limits ? { limits: body.limits } : {}) }));
        let bytes = 0;
        const rd = r.stream.getReader();
        if (body.cancel) { const { value } = await rd.read(); bytes = value?.length ?? 0; await rd.cancel('enough'); }
        else for (;;) { const { value, done } = await rd.read(); if (done) break; bytes += value.length; }
        return Response.json({ ok: true, size: r.size, bytes, spans: exporter.lines.flatMap(flattenLine).map(s => ({ name: s.name, traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId ?? null, links: s.links.map(l => [l.spanId, l.attrs['ply.link']]), outcome: s.attrs[`${s.name}.outcome`] ?? null })) });
      } catch (e) { return Response.json({ ok: false, code: e.code, what: e.what ?? null, message: e.message, blob: exporter.lines.flatMap(flattenLine).filter(s => s.name === 'git.read.blob').map(s => s.attrs['git.read.blob.outcome'] ?? null) }); }
    }
    if (u.pathname === '/sweep') { // one limit-sweep cell (test/sweep): the same operation code the node cell runs
      const cell = await req.json();
      const op = fetchOps(cell, { tracer: new Tracer(), limits: cell.limits ?? {} })[cell.op];
      if (!op) return Response.json({ status: 'crash', code: null, msg: `workerd: no op ${cell.op}` });
      try { return Response.json({ status: 'ok', ...(await op()) }); } catch (e) { return Response.json(failure(e)); }
    }
    if (u.pathname === '/push') { // a streamed push (#172): an L-byte random blob; mutate: the blob changes between the passes
      const body = await req.json();
      const blob = new Uint8Array(body.size);
      for (let i = 0; i < blob.length; i += 65536) crypto.getRandomValues(blob.subarray(i, Math.min(i + 65536, blob.length)));
      const tree = unwrap(encodeTree([{ mode: '100644', name: 'big.bin', oid: hashObject('blob', blob) }]));
      const commit = unwrap(encodeCommit({ tree: hashObject('tree', tree), author: 'a <a@x> 1700000000 +0000', message: 'm\n' }));
      const oid = hashObject('commit', commit);
      const objects = [{ type: TYPE.BLOB, data: blob }, { type: TYPE.TREE, data: tree }, { type: TYPE.COMMIT, data: commit }];
      const seen = [];
      const fetchImpl = (url, init) => {
        if (String(url).endsWith('/git-receive-pack')) { seen.push({ streamed: typeof init.body?.getReader === 'function', duplex: init.duplex ?? null, redirect: init.redirect }); if (body.mutate) blob[100] ^= 1; }
        return fetch(url, init);
      };
      const t = unwrap(createTransport(body.url, { fetchImpl, limits: withLimits({ maxPackBytes: 4 * body.size + 4096 }) }));
      const r = await push(t, { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: oid, objects });
      return Response.json({ ok: r.ok, code: r.ok ? null : r.error.code, original: r.ok ? null : r.error.original ?? null, message: r.ok ? null : r.error.message, commit: oid, packBytes: r.ok ? r.value.packBytes : null, seen });
    }
    if (u.pathname === '/packwrite') { // both passes and buildPack agree byte for byte under workerd's CompressionStream
      const body = await req.json();
      const out = [];
      for (const size of body.sizes) {
        const data = new Uint8Array(size);
        for (let i = 0; i < size; i += 65536) crypto.getRandomValues(data.subarray(i, Math.min(i + 65536, size)));
        if (body.half) data.fill(0, size >> 1);
        const objects = [{ type: TYPE.BLOB, data }, { type: TYPE.BLOB, data: data.subarray(0, size >> 2) }];
        const built = (await buildPack(objects)).pack;
        const m = await measurePack(objects, 0);
        const a = new Uint8Array(await new Response(streamPack(m, new Uint8Array(0)).stream).arrayBuffer());
        const b = new Uint8Array(await new Response(streamPack(m, new Uint8Array(0)).stream).arrayBuffer());
        const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
        out.push({ size, bytes: m.bytes, passes: same(a, b), built: same(a, built) });
      }
      return Response.json(out);
    }
    if (u.pathname === '/edit') {
      const body = await req.json();
      const n = body.n ?? 1, concurrent = u.searchParams.get('concurrent') === '1';
      const exporter = arrayExporter();
      const tracer = new Tracer({ exporter });
      const cache = new Map();
      const limits = withLimits(body.limits ?? {});
      const fetchImpl = body.packCache && packCache ? cachingFetch(globalThis.fetch, packCache, { waitUntil: p => ctx.waitUntil(p) }) : globalThis.fetch;
      const signing = body.sign ? await generateSigner() : null; // Ed25519 via the platform's WebCrypto
      const one = async i => {
        const t0 = Date.now();
        try {
          const r = await unwrapAsync(editFile(body.url, { path: body.path, find: body.find, replace: body.replace, author: { name: 'wd', email: 'wd@x' }, message: `wd ${i}` }, { tracer, cache, limits, auth: body.auth, fetchImpl, head: body.head ?? null, signer: signing?.signer ?? null }));
          return { ok: true, ms: Date.now() - t0, newCommit: r.newCommit, oldCommit: r.oldCommit, pushBytes: r.pushBytes, noop: !!r.noop, hint: r.hint, packCache: fetchImpl.stats ?? null };
        } catch (e) { return { ok: false, ms: Date.now() - t0, code: e.code, message: e.message }; }
      };
      const results = concurrent ? await Promise.all(Array.from({ length: n }, (_, i) => one(i))) : [];
      if (!concurrent) for (let i = 0; i < n; i++) results.push(await one(i));
      const spans = exporter.lines.flatMap(flattenLine);
      const root = spans.filter(s => s.name === 'git.edit');
      return Response.json({ signer: signing?.signer.publicKeyLine ?? null, results, roots: root.map(s => pick(s.attrs)), blob: spans.filter(s => s.name === 'git.edit.blob').map(s => pick(s.attrs)), spanCount: spans.length, ...(body.dump ? { dump: JSON.stringify(exporter.lines) } : {}) });
    }

    if (u.pathname === '/blobcache') {
      // Cold then warm openBlob under holdLastChunk + FixedLengthStream, with an in-isolate PackCache
      // (standalone workerd's caches.default never hits — see pack-cache test). Proves no-tee fill:
      // warm body length and sha equal cold. mode=tee reproduces the #228/#229 poison for contrast.
      const body = await req.json();
      const store = memoryCache();
      const waitUntil = (p) => ctx.waitUntil(p);
      const blobCache = { store, waitUntil, maxBytes: BLOB_CACHE_MAX_BYTES, maxAge: BLOB_CACHE_MAX_AGE_SECONDS };
      const exporter = arrayExporter();
      const tracer = new Tracer({ exporter });
      const t = unwrap(createTransport(body.url, { tracer }));
      const mode = body.mode === 'tee' ? 'tee' : 'buffer';

      function holdLastChunk(source) {
        let held = null;
        return source.pipeThrough(new TransformStream({
          transform(chunk, ctl) {
            if (chunk.byteLength === 0) return;
            if (held) ctl.enqueue(held);
            held = chunk;
          },
          flush(ctl) {
            if (held) ctl.enqueue(held);
            held = null;
          },
        }));
      }

      async function drainThroughFixed(stream, size) {
        // ply-web shape: holdLastChunk(stream).pipeTo(FixedLengthStream(size).writable)
        const fixed = new FixedLengthStream(size);
        const pipe = holdLastChunk(stream).pipeTo(fixed.writable);
        const bytes = new Uint8Array(await new Response(fixed.readable).arrayBuffer());
        await pipe.catch(() => null);
        // settle waitUntil puts
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
        return bytes;
      }

      async function sha256hex(bytes) {
        const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return [...d].map(b => b.toString(16).padStart(2, '0')).join('');
      }

      if (mode === 'tee') {
        // Reproduce #228/#229: tee verified bytes, put one branch, drain the other via holdLastChunk+FixedLengthStream.
        // Then force the Workers-observed poison (empty body, declared CL) into the store and warm-lookup.
        const first = await unwrapAsync(readFile(body.url, { path: body.path }, { tracer }));
        const [toClient, toCache] = first.stream.tee();
        const headers = new Headers({
          'content-type': 'application/octet-stream',
          'content-length': String(first.size),
          'x-ply-blob-oid': first.blob,
          'cache-control': 'public, max-age=60, immutable',
        });
        const key = `https://ply.blob/tee-repro/${first.blob}`;
        waitUntil(store.put(key, new Response(toCache, { status: 200, headers })));
        const coldBytes = await drainThroughFixed(toClient, first.size);
        await new Promise(r => setTimeout(r, 20));
        const stored = store.entries.get(key);
        const poisoned = !stored || stored.body.byteLength !== first.size;
        // Match prod: empty body kept with non-zero Content-Length.
        store.entries.set(key, {
          body: new Uint8Array(),
          headers: { 'content-type': 'application/octet-stream', 'content-length': String(first.size), 'x-ply-blob-oid': first.blob },
        });
        const warmRes = await store.match(key);
        const warmBytes = new Uint8Array(await warmRes.arrayBuffer());
        return Response.json({
          ok: true,
          mode: 'tee',
          oid: first.blob,
          poisonedByRace: poisoned,
          cold: { size: first.size, bytes: coldBytes.byteLength, sha256: await sha256hex(coldBytes) },
          warm: { size: first.size, bytes: warmBytes.byteLength, sha256: await sha256hex(warmBytes), contentLength: first.size },
          equal: coldBytes.byteLength === warmBytes.byteLength && coldBytes.every((b, i) => b === warmBytes[i]),
        });
      }

      // Resolve blob oid via readFile once (miss path fills cache), then openBlob by oid for warm.
      const first = await unwrapAsync(readFile(body.url, { path: body.path }, { tracer, blobCache }));
      const coldBytes = await drainThroughFixed(first.stream, first.size);
      const oid = first.blob;
      // Allow put to finish
      await new Promise(r => setTimeout(r, 10));

      const opened = await unwrapAsync(openBlob(t, oid, { blobCache }));
      if (opened.kind !== 'stream') return Response.json({ ok: false, message: 'not a stream' });
      const warmBytes = await drainThroughFixed(opened.stream, opened.size);
      await new Promise(r => setTimeout(r, 10));

      const cacheAttrs = exporter.lines.flatMap(flattenLine)
        .filter(s => s.name === 'git.read.blob')
        .map(s => s.attrs['git.read.blob.cache'] ?? null);

      return Response.json({
        ok: true,
        mode: 'buffer',
        oid,
        cold: { size: first.size, bytes: coldBytes.byteLength, sha256: await sha256hex(coldBytes) },
        warm: { size: opened.size, bytes: warmBytes.byteLength, sha256: await sha256hex(warmBytes) },
        equal: coldBytes.byteLength === warmBytes.byteLength
          && coldBytes.every((b, i) => b === warmBytes[i]),
        cacheOutcomes: cacheAttrs,
        storeEntries: store.entries.size,
      });
    }

    return new Response('not found', { status: 404 });
  },
};
const pick = a => Object.fromEntries(Object.entries(a).filter(([k]) => /outcome|mem\.|bytes|ms$|objects|cache_hits|match|ratio|status_code|pack\.cache|head\.hint|head\.outcome|attempt|hasher|cpu/.test(k)));
