// ply at the edge: runs the pipeline against a real remote but stops before receive-pack, returning the
// packfile and the commands we *would* have pushed, plus every span. POST /prepare {url, ref, path, find, replace}
import { GitHttp } from 'client.js';
import { parseCommit, parseTree, treeReplaceOid, hashObject, encodeCommit, ident, objectHeader, TYPE } from 'objects.js';
import { spliceDelta, buildPack } from 'pack.js';
import { Sha1, fromHex, toHex } from 'sha1.js';
import { te } from 'bytes.js';
import { Tracer, arrayExporter, flattenLine } from 'otel.js';
import { withLimits } from 'limits.js';
import { cachingFetch } from 'packcache.js';
import { spInit, spStep, spFinish, scanInit, scanStep, scanFinish } from 'edit.js';

const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };

async function prepare(body, cf, env, ctx) {
    const { url, ref = 'refs/heads/main', path, find, replace, author = { name: 'ply', email: 'ply@edge' }, message = 'ply edge edit' } = body;
    const exporter = arrayExporter();
    const tracer = new Tracer({ exporter, resource: { 'cloudflare.colo': req.cf?.colo ?? '', 'service.name': 'ply-edge' } });
    const root = tracer.start('git.edit.prepare', { attrs: { 'git.edit.url': url, 'git.edit.path': path } });
    // per-colo pack cache for the wants-only commit/tree fetches (every object is hash-verified on arrival; poison → one bust)
    const fetchImpl = body.packCache === false ? globalThis.fetch : cachingFetch(globalThis.fetch, caches.default, { waitUntil: p => ctx?.waitUntil(p) });
    const client = new GitHttp(url, { tracer, parent: root, limits: withLimits({ requestTimeoutMs: 25000 }), auth: body.auth, fetchImpl });
    const t0 = Date.now();
    try {
      // head hint (e.g. from the last prepare's result in KV) skips ls-refs; a real push would let receive-pack's CAS catch staleness
      let oldCommit = body.head ?? null;
      root.set({ 'git.edit.head.hint': oldCommit ?? '' });
      if (!oldCommit) { const { refs } = await client.lsRefs([ref]); oldCommit = refs.get(ref)?.oid; if (!oldCommit) throw Object.assign(new Error(`no ${ref}`), { code: 'not_found' }); }
      const cf = await client.fetchPack({ wants: [oldCommit], filter: 'tree:0', deepen: 1 });
      const commit = parseCommit(cf.objects.get(oldCommit).data);
      const comps = path.split('/'); const levels = []; let treeOid = commit.tree;
      for (let d = 0; d < comps.length; d++) {
        const tf = await client.fetchPack({ wants: [treeOid], filter: 'tree:0' });
        const data = tf.objects.get(treeOid).data; const entry = parseTree(data).find(e => e.name === comps[d]);
        if (!entry) throw Object.assign(new Error(`${comps[d]} not in ${treeOid}`), { code: 'not_found' });
        levels.push({ treeOid, data, entry }); treeOid = entry.oid;
      }
      const blobOid = treeOid;
      // streamed blob replace (same code path as editFile, inlined so we can keep the delta instead of pushing it)
      const findB = te.encode(find), replB = te.encode(replace);
      let sp = spInit(), scan = scanInit({ find: findB, replace: replB }), sha = null, newLen = 0, inflated = 0;
      const ds = new DecompressionStream('deflate'); const w = ds.writable.getWriter();
      const fspan = tracer.start('git.upload-pack fetch', { parent: root });
      const pump = (async () => { for await (const c of client.packStream({ wants: [blobOid] }, fspan)) { const r = spStep(sp, c); sp = r.state; for (const z of r.zlib) await w.write(z); } sp = spFinish(sp); await w.close(); fspan.end(); })();
      for await (const chunk of ds.readable) { if (!sha) { newLen = sp.size - findB.length + replB.length; sha = new Sha1().update(objectHeader('blob', newLen)); } inflated += chunk.length; const r = scanStep(scan, chunk); scan = r.state; for (const p of r.emit) sha.update(p); }
      await pump; if (!sha) { newLen = sp.size - findB.length + replB.length; sha = new Sha1().update(objectHeader('blob', newLen)); }
      const fin = scanFinish(scan); scan = fin.state; for (const p of fin.emit) sha.update(p);
      if (scan.matches.length !== 1) throw Object.assign(new Error(`expected exactly one match, found ${scan.matches.length}`), { code: 'match_count' });
      const newBlob = sha.hex();
      const blobDelta = spliceDelta({ baseLen: sp.size, off: scan.matches[0], oldLen: findB.length, insert: replB }).delta;
      const treeObjs = []; let child = newBlob;
      for (let i = levels.length - 1; i >= 0; i--) { const { treeOid: oldT, data, entry } = levels[i]; const nd = treeReplaceOid(data, entry, child); const nid = hashObject('tree', nd); treeObjs.unshift({ type: TYPE.TREE, data: spliceDelta({ baseLen: data.length, off: entry.oidOffset, oldLen: 20, insert: fromHex(child) }).delta, baseOid: oldT, newOid: nid }); child = nid; }
      const who = ident({ ...author, time: Math.floor(Date.now() / 1000) });
      const commitData = encodeCommit({ tree: child, parents: [oldCommit], author: who, committer: who, message: message + '\n' });
      const newCommit = hashObject('commit', commitData);
      const objects = [{ type: TYPE.COMMIT, data: commitData }, ...treeObjs.map(t => ({ type: t.type, data: t.data, baseOid: t.baseOid })), blobDelta.length >= 4 ? { type: TYPE.BLOB, data: blobDelta, baseOid: blobOid } : { type: TYPE.BLOB, data: new Uint8Array(0) }];
      const { pack, entries } = await buildPack(objects);
      root.set({ 'git.edit.commit.old': oldCommit, 'git.edit.commit.new': newCommit, 'git.edit.blob.old': blobOid, 'git.edit.blob.new': newBlob, 'git.edit.push.bytes': pack.length, 'git.edit.ms': Date.now() - t0, }).end();
      return { ok: true, colo: cf?.colo, ms: Date.now() - t0, packCache: fetchImpl.stats ?? null, oldCommit, newCommit, oldBlob: blobOid, newBlob, baseLen: sp.size, newLen, matchOffset: scan.matches[0], trees: treeObjs.map(t => ({ old: t.baseOid, new: t.newOid })), command: `${oldCommit} ${newCommit} ${ref}`, pack: b64(pack), packBytes: pack.length, entries, spans: exporter.lines.flatMap(flattenLine).map(s => ({ name: s.name, ms: s.durationMs, status: s.status.code, attrs: s.attrs })) };
    } catch (e) {
      root.error(e).end();
      return { ok: false, code: e.code, message: e.message, ms: Date.now() - t0, spans: exporter.lines.flatMap(flattenLine).map(s => ({ name: s.name, ms: s.durationMs, status: s.status.code, attrs: s.attrs })) };
    }
}

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    if (u.pathname === '/ping') return new Response('pong');
    if (u.pathname === '/discover') { // capability canary: who is the server, what does it advertise (agent, object-format, fetch features)
      const exporter = arrayExporter(); const tracer = new Tracer({ exporter, resource: { 'cloudflare.colo': req.cf?.colo ?? '', 'service.name': 'ply-edge' } });
      try { const info = await new GitHttp(u.searchParams.get('url') ?? 'https://github.com/elixir-ai-tools/just_bash', { tracer }).discover(); return Response.json({ ok: true, ...info, caps: [...info.caps.entries()], spans: exporter.lines.flatMap(flattenLine) }); }
      catch (e) { return Response.json({ ok: false, code: e.code, message: e.message, spans: exporter.lines.flatMap(flattenLine) }, { status: 502 }); }
    }
    if (u.pathname !== '/prepare' || req.method !== 'POST') return new Response('POST /prepare, GET /discover?url=', { status: 404 });
    if (env.TOKEN && req.headers.get('authorization') !== `Bearer ${env.TOKEN}`) return new Response('unauthorized', { status: 401 });
    const r = await prepare(await req.json(), req.cf, env, ctx);
    return Response.json(r, { status: r.ok ? 200 : 500 });
  },
  // Preview accounts put a managed challenge in front of workers.dev, so the job is also runnable from a cron
  // trigger: JOB (secret, JSON) describes the edit, the result lands in KV under "result" for the API to read.
  async scheduled(event, env, ctx) {
    const body = JSON.parse(env.JOB);
    const r = await prepare(body, { colo: 'cron' }, env, ctx);
    await env.RESULTS.put('result', JSON.stringify({ at: new Date().toISOString(), cron: event.cron, ...r }));
  },
};
