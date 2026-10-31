// The ply pipeline running inside workerd. POST /edit with {url, path, find, replace, n?} runs editFile n times
// (sequentially, or concurrently with ?concurrent=1) and reports results, spans summary, and timing.
import { editFile } from '../../src/edit.js';
import { Tracer, arrayExporter, flattenLine } from '../../src/otel.js';
import { GitHttp } from '../../src/client.js';
import { withLimits } from '../../src/limits.js';
import { cachingFetch } from '../../src/packcache.js';
import { generateSigner } from '../../src/sign.js';
import { createSshTransport } from '../../src/sshgit.js';
import { workersStream } from '../../src/ssh-workers.js';
import { lsRefs } from '../../src/lsrefs.js';

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
      const c = new GitHttp(body.url, { tracer: new Tracer({ exporter }) });
      const t0 = Date.now();
      try {
        const r = await c.fetchPack(body.req);
        return Response.json({ ok: true, objects: r.parsed?.stats.count ?? 0, ms: Date.now() - t0, spans: exporter.lines.flatMap(flattenLine).map(s => ({ name: s.name, ms: s.durationMs, attrs: pick(s.attrs) })) });
      } catch (e) { return Response.json({ ok: false, code: e.code, message: e.message, ms: Date.now() - t0 }); }
    }
    if (u.pathname === '/ssh-edit') { // the whole pipeline over SSH from inside workerd, TCP via cloudflare:sockets
      const body = await req.json();
      const exporter = arrayExporter(); const tracer = new Tracer({ exporter });
      const hex = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
      const privateKey = await crypto.subtle.importKey('pkcs8', hex(body.privateKeyPkcs8Hex), { name: 'Ed25519' }, false, ['sign']); // workerd rejects node's JWK (alg "Ed25519" vs "EdDSA")
      const publicKeyRaw = hex(body.publicKeyHex);
      const t = createSshTransport(body.url, { privateKey, publicKeyRaw, hostKey: body.hostKey, connect: workersStream, tracer });
      const t0 = Date.now();
      try {
        const r = await editFile(body.url, { path: body.path, find: body.find, replace: body.replace, author: { name: 'wd', email: 'wd@x' }, message: 'wd over ssh' }, { tracer, transport: t, verify: true });
        await t.close();
        return Response.json({ ok: true, ms: Date.now() - t0, newCommit: r.newCommit, pushBytes: r.pushBytes, stats: t.stats(), spans: exporter.lines.flatMap(flattenLine).map(s => ({ name: s.name, attrs: pick(s.attrs) })) });
      } catch (e) { await t.close().catch(() => {}); return Response.json({ ok: false, ms: Date.now() - t0, code: e.code, message: e.message }); }
    }
    if (u.pathname === '/ssh-bound') { // SAFETY I1 over cloudflare:sockets: one ls-refs under requestTimeoutMs and a signal aborted after abortMs
      const body = await req.json();
      const hex = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
      const privateKey = await crypto.subtle.importKey('pkcs8', hex(body.privateKeyPkcs8Hex), { name: 'Ed25519' }, false, ['sign']);
      const ac = new AbortController(); if (body.abortMs != null) setTimeout(() => ac.abort(), body.abortMs);
      const t = createSshTransport(body.url, { privateKey, publicKeyRaw: hex(body.publicKeyHex), hostKey: body.hostKey, connect: workersStream, tracer: new Tracer(), limits: withLimits({ requestTimeoutMs: body.requestTimeoutMs }), signal: ac.signal });
      const t0 = Date.now();
      try { await lsRefs(t, ['HEAD']); return Response.json({ ok: true, ms: Date.now() - t0 }); }
      catch (e) { return Response.json({ ok: false, ms: Date.now() - t0, code: e.code, message: e.message }); }
      finally { await t.close().catch(() => {}); }
    }
    if (u.pathname === '/redirect') { // ply against a redirecting server; plus what workerd's own `follow` does with Authorization
      const body = await req.json();
      const c = new GitHttp(body.url, { tracer: new Tracer(), auth: body.auth });
      const res = {};
      for (const [k, op] of [['get', () => c.discover()], ['post', () => c.lsRefs()]]) { try { await op(); res[k] = { ok: true }; } catch (e) { res[k] = { code: e.code, status: e.status, message: e.message }; } }
      try { const r = await fetch(`${body.url}/info/refs?service=git-upload-pack`, { headers: { Authorization: 'Bearer workerd-follow-probe' } }); res.follow = { status: r.status, url: r.url }; await r.body?.cancel(); } catch (e) { res.follow = { error: e.message }; }
      return Response.json(res);
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
          const r = await editFile(body.url, { path: body.path, find: body.find, replace: body.replace, author: { name: 'wd', email: 'wd@x' }, message: `wd ${i}` }, { tracer, cache, limits, auth: body.auth, fetchImpl, head: body.head ?? null, signer: signing?.signer ?? null });
          return { ok: true, ms: Date.now() - t0, newCommit: r.newCommit, oldCommit: r.oldCommit, pushBytes: r.pushBytes, noop: !!r.noop, hint: r.hint, packCache: fetchImpl.stats ?? null };
        } catch (e) { return { ok: false, ms: Date.now() - t0, code: e.code, message: e.message }; }
      };
      const results = concurrent ? await Promise.all(Array.from({ length: n }, (_, i) => one(i))) : [];
      if (!concurrent) for (let i = 0; i < n; i++) results.push(await one(i));
      const spans = exporter.lines.flatMap(flattenLine);
      const root = spans.filter(s => s.name === 'git.edit');
      return Response.json({ signer: signing?.signer.publicKeyLine ?? null, results, roots: root.map(s => pick(s.attrs)), blob: spans.filter(s => s.name === 'git.edit.blob').map(s => pick(s.attrs)), spanCount: spans.length, ...(body.dump ? { dump: JSON.stringify(exporter.lines) } : {}) });
    }
    return new Response('not found', { status: 404 });
  },
};
const pick = a => Object.fromEntries(Object.entries(a).filter(([k]) => /outcome|mem\.|bytes|ms$|objects|cache_hits|match|ratio|status_code|pack\.cache|head\.hint|head\.outcome|attempt|hasher|cpu|ssh\./.test(k)));
