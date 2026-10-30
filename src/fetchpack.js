// Buffered multi-object fetch: whole pack in memory (bounded by limits.maxPackBytes), parsed and delta-resolved.
// The general-purpose path (clones, thin packs, negotiation); the edit pipeline uses fetch.js's fetchObject instead.
import { fail } from './errors.js';
import { concat } from './bytes.js';
import { TYPE, TYPE_NAME, parseCommit, assertFetched } from './objects.js';
import { parsePack, resolvePack, packParseOpts } from './packresolve.js';
import { limitError, requireLimit } from './limits.js';
import { coded, clientSpan } from './transport.js';
import { packStream, isFilterRejection, harvest } from './fetch.js';

// Pure: the commit window a `deepen` fetch of commit wants must contain, checked the way git's fetch checks what it
// received — fsck on every object (transfer.fsckObjects) and connectivity (check_connected): every object is a commit
// (or, from a blob:none answer, a tree) and well-formed (assertFetched); every want is a commit in the pack; every commit
// is reachable from a want; and every commit's parents are in the pack unless the server declared that commit a shallow
// boundary. A cut the server did not declare is pack_corrupt — the pack is not the answer to the request — so no caller
// ever walks a graph with a hole it was not told about (issue #18: the merge base of such a graph is not git's). Returns
// oid → parsed commit for the window, so the caller parses nothing itself.
export function checkCommitWindow(objects, { wants, shallow, trees = false }, limits) {
  for (const [oid, o] of objects) {
    const name = TYPE_NAME[o.type];
    if (o.type !== TYPE.COMMIT && !(trees && o.type === TYPE.TREE)) throw fail('pack_corrupt', `unrequested ${name} ${oid} in a commit-only pack (${objects.size} objects)`);
    assertFetched(name, o.data, limits);
  }
  for (const w of wants) if (!objects.has(w)) throw fail('pack_corrupt', `want ${w} not in the pack (${objects.size} objects)`);
  const cut = new Set(shallow);
  const commits = new Map(); const st = [...wants];
  while (st.length) {
    // Stryker disable next-line ConditionalExpression: a commit reached twice (a diamond) is parsed again to the same entry; the hash-verified graph has no cycles
    const c = st.pop(); if (commits.has(c)) continue;
    const o = objects.get(c);
    if (o.type !== TYPE.COMMIT) throw fail('pack_corrupt', `${c} is a ${TYPE_NAME[o.type]}, not a commit`);
    const parsed = parseCommit(o.data, limits); commits.set(c, parsed);
    for (const p of parsed.parents) {
      if (objects.has(p)) { st.push(p); continue; }
      if (!cut.has(c)) throw fail('pack_corrupt', `commit ${p}, parent of ${c}, is not in the pack and ${c} was not declared shallow`);
    }
  }
  for (const [oid, o] of objects) if (o.type === TYPE.COMMIT && !commits.has(oid)) throw fail('pack_corrupt', `unrequested commit ${oid}: not reachable from a want`);
  return commits;
}

// fetchPack for a `filter tree:0` request (commit-only history walks) with the blob:none fallback of fetch.js: a server
// that refuses tree:0 gets blob:none, which also carries every tree of every commit in the window — far more bytes on a
// deep window (bounded by limits.maxPackBytes; the attrs say how much). Either answer passes checkCommitWindow before
// anything is kept: the result carries `commits` (oid → parsed), and the trees of a wide answer are harvested for later
// tree fetches (fetch.js harvest, which is where every object entering t.objects is checked).
export async function fetchPackTree0(t, opts) {
  const checked = (r, trees) => {
    if (!r.objects) throw fail('protocol', 'fetch: no packfile in the answer to a commit walk');
    return { ...r, commits: checkCommitWindow(r.objects, { wants: opts.wants, shallow: r.shallow, trees }, t.limits) };
  };
  const wide = async learned => {
    const r = checked(await fetchPack(t, { ...opts, filter: 'blob:none' }, { attrs: { 'git.fetch.filter.fallback': 'blob:none', 'git.fetch.filter.requested': opts.filter, 'git.fetch.filter.learned': learned } }), true);
    harvest(t, r.objects);
    return r;
  };
  if (t.quirks?.treeFilter === 'blob:none') return wide(false);
  let r;
  try { r = await fetchPack(t, opts); } catch (e) {
    if (!isFilterRejection(e)) throw e;
    if (t.quirks) t.quirks.treeFilter = 'blob:none';
    return wide(true);
  }
  return checked(r, false);
}

export const packAttrs = (parsed, resolved) => ({
  'git.pack.version': parsed.stats.version, 'git.pack.objects': parsed.stats.count, 'git.pack.bytes': parsed.bytes,
  'git.pack.trailer': parsed.trailer, 'git.pack.full': parsed.stats.full, 'git.pack.ofs_delta': parsed.stats.ofsDelta,
  'git.pack.ref_delta': parsed.stats.refDelta, 'git.pack.compressed.bytes': parsed.stats.compressed, 'git.pack.inflated.bytes': parsed.stats.inflated,
  'git.pack.inflate.blocks': parsed.stats.inflate.blocks, 'git.pack.inflate.stored': parsed.stats.inflate.stored,
  'git.pack.inflate.fixed': parsed.stats.inflate.fixed, 'git.pack.inflate.dynamic': parsed.stats.inflate.dynamic,
  ...Object.fromEntries(Object.entries(parsed.stats.byType).map(([k, v]) => [`git.pack.type.${k}`, v])),
  ...(resolved ? { 'git.pack.chain.max': resolved.stats.maxChain, 'git.pack.external_bases': resolved.stats.externalBases } : {}),
});

// A pack that fails verification may be a poisoned cache entry (see packcache.js): retry once, bypassing the cache.
// Only when the bad response was served from cache; a corrupt live response is reported as-is.
export async function fetchPack(t, opts, extra = {}) {
  try { return await fetchPackOnce(t, opts, extra); } catch (e) {
    if (e?.code !== 'pack_corrupt' || e?.cacheStatus !== 'HIT' || opts.bypassCache) throw e;
    return fetchPackOnce(t, { ...opts, bypassCache: true }, extra);
  }
}

export async function fetchPackOnce(t, opts, { external, resolve = true, attrs = {} } = {}) {
  return coded('pack_corrupt', () => t.tracer.span('git.upload-pack fetch', clientSpan(t, { 'git.pack.cache.bust': !!opts.bypassCache, ...attrs }), async span => { try {
    const maxPack = requireLimit(t.limits, 'maxPackBytes');
    const parts = []; let total = 0;
    const it = packStream(t, opts, span);
    let st;
    for (;;) { const { value, done } = await it.next(); if (done) { st = value; break; } total += value.length; if (total > maxPack) throw limitError('pack bytes', total, maxPack); parts.push(value); }
    const acks = { acks: st.acks.filter(a => a.startsWith('ACK ')).map(a => a.slice(4)), nak: st.acks.includes('NAK'), ready: st.ready, shallow: st.shallow, unshallow: st.unshallow };
    if (st.phase !== 'pack') { span.set({ 'git.fetch.pack': false }); return { parsed: null, objects: null, resolved: null, ...acks }; }
    const buf = concat(parts);
    const parsed = parsePack(buf, packParseOpts(t.limits));
    for (const o of parsed.objects) span.event('git.pack.object', {
      'git.object.offset': o.offset, 'git.object.type': TYPE_NAME[o.type], 'git.object.size': o.size, 'git.object.compressed': o.compressed,
      'git.object.header_bytes': o.headerBytes, 'git.object.base.offset': o.baseOffset ?? -1, 'git.object.base.oid': o.baseOid ?? '',
      'git.object.inflate.blocks': o.inflate.blocks, 'git.object.inflate.stored': o.inflate.stored, 'git.object.inflate.fixed': o.inflate.fixed,
      'git.object.inflate.dynamic': o.inflate.dynamic, 'git.object.inflate.matches': o.inflate.matches, 'git.object.inflate.max_dist': o.inflate.maxDist,
    });
    const resolved = resolve ? resolvePack(parsed, external, t.limits) : null;
    span.set(packAttrs(parsed, resolved));
    return { parsed, objects: resolved?.objects ?? null, resolved, ...acks };
  } catch (e) { if (e && typeof e === 'object') e.cacheStatus = span.attrs['git.response.cache'] ?? ''; throw e; } }));
}
