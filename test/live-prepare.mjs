// Prepare (do not push) a single-file edit against a real remote and dump the pack + spans.
//   node test/live-prepare.mjs <url> <ref> <path> <find> <replace> [out.pack]
import { writeFileSync } from 'node:fs';
import { GitHttp } from '../src/client.js';
import { parseCommit, parseTree, treeReplaceOid, hashObject, encodeCommit, ident, objectHeader, TYPE } from '../src/objects.js';
import { validateIdent } from '../src/validate.js';
import { spliceDelta, buildPack } from '../src/pack.js';
import { Sha1, fromHex } from '../src/sha1.js';
import { te } from '../src/bytes.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { withLimits } from '../src/limits.js';
import { spInit, spStep, spFinish, scanInit, scanStep, scanFinish } from '../src/edit.js';

export async function prepare({ url, ref = 'refs/heads/main', path, find, replace, author = { name: 'ply', email: 'ply@edge' }, message = 'ply edit', auth, fetchImpl, head: hint = null }) {
  const exporter = arrayExporter(); const tracer = new Tracer({ exporter });
  const root = tracer.start('git.edit.prepare', { attrs: { 'git.edit.path': path } });
  const client = new GitHttp(url, { tracer, parent: root, limits: withLimits({ requestTimeoutMs: 25000 }), auth, fetchImpl });
  const t0 = Date.now();
  let oldCommit = hint;
  if (!oldCommit) { const { refs, head } = await client.lsRefs([ref, 'HEAD']); oldCommit = refs.get(ref)?.oid; if (!oldCommit) throw Object.assign(new Error(`no ${ref} (HEAD→${head})`), { code: 'not_found' }); }
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
  const who = ident(validateIdent({ name: author.name, email: author.email, time: Math.floor(Date.now() / 1000), tz: author.tz }));
  const commitData = encodeCommit({ tree: child, parents: [oldCommit], author: who, committer: who, message: message + '\n' });
  const newCommit = hashObject('commit', commitData);
  const objects = [{ type: TYPE.COMMIT, data: commitData }, ...treeObjs.map(t => ({ type: t.type, data: t.data, baseOid: t.baseOid })), blobDelta.length >= 4 ? { type: TYPE.BLOB, data: blobDelta, baseOid: blobOid } : { type: TYPE.BLOB, data: new Uint8Array(0) }];
  const { pack, entries } = await buildPack(objects);
  root.set({ 'git.edit.commit.old': oldCommit, 'git.edit.commit.new': newCommit, 'git.edit.push.bytes': pack.length, }).end();
  return { ms: Date.now() - t0, oldCommit, newCommit, oldTree: commit.tree, newTree: child, oldBlob: blobOid, newBlob, baseLen: sp.size, newLen, matchOffset: scan.matches[0], trees: treeObjs.map(t => ({ old: t.baseOid, new: t.newOid })), command: `${oldCommit} ${newCommit} ${ref}`, pack, entries, spans: exporter.lines.flatMap(flattenLine) };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const [url, ref, path, find, replace, out = 'live.pack'] = process.argv.slice(2);
  const auth = process.env.PLY_TOKEN ? { token: process.env.PLY_TOKEN } : undefined;
  const r = await prepare({ url, ref, path, find, replace, auth });
  writeFileSync(out, r.pack);
  const { pack, spans, ...rest } = r;
  console.log(JSON.stringify(rest, null, 1));
  for (const s of spans) console.log(s.name.padEnd(26), String(Math.round(s.ms)).padStart(5) + 'ms', s.status.code === 2 ? 'ERR' : '   ', 'req', s.attrs['http.request.body.size'] ?? '', 'resp', s.attrs['http.response.body.size'] ?? '', s.attrs['git.pack.objects'] !== undefined ? `objs=${s.attrs['git.pack.objects']}` : '', s.attrs['git.sideband.band2.frames'] ? `band2=${s.attrs['git.sideband.band2.frames']}` : '', s.attrs['http.response.ttfb_ms'] !== undefined ? `ttfb=${s.attrs['http.response.ttfb_ms']}` : '');
}
