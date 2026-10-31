// Buffered multi-object fetch: whole pack in memory (bounded by limits.maxPackBytes), parsed and delta-resolved.
// The general-purpose path (clones, thin packs, negotiation); the edit pipeline uses fetch.js's fetchObject instead.
import { concat } from './bytes.js';
import { TYPE, TYPE_NAME } from './objects.js';
import { parsePack, resolvePack, packParseOpts } from './packresolve.js';
import { limitError, requireLimit } from './limits.js';
import { coded, clientSpan } from './transport.js';
import { packStream, isFilterRejection, harvest, checkWide, skippedAttrs } from './fetch.js';

// fetchPack for a `filter tree:0` request (commit-only history walks) with the blob:none fallback of fetch.js: a server
// that refuses tree:0 gets blob:none, which also carries every tree of every commit in the window — far more bytes on a
// deep window (bounded by limits.maxPackBytes; the attrs say how much). The trees are harvested for later tree fetches.
// Every commit, tree and tag in the pack is checked as fetchObject checks one (assertFetched), inside the fetch's span,
// so a malformed object fails the fetch (`pack_corrupt`) instead of reaching a caller or the harvest. On the tree:0
// path all of it is what was asked for. On the blob:none path the trees are extras a tree:0 server would not have sent
// (the walk reads commits only): checkWide drops one that is over a limit instead of failing the walk (#46; see there).
const commitsAndTags = (_oid, o) => o.type !== TYPE.TREE;
export async function fetchPackTree0(t, opts) {
  const wide = async learned => {
    const r = await fetchPack(t, { ...opts, filter: 'blob:none' }, { check: objects => skippedAttrs(checkWide(objects, commitsAndTags, t.limits)), attrs: { 'git.fetch.filter.fallback': 'blob:none', 'git.fetch.filter.requested': opts.filter, 'git.fetch.filter.learned': learned } });
    if (r.objects) harvest(t, r.objects);
    return r;
  };
  if (t.quirks?.treeFilter === 'blob:none') return wide(false);
  try { return await fetchPack(t, opts, { check: objects => { checkWide(objects, () => true, t.limits); return {}; } }); } catch (e) {
    if (!isFilterRejection(e)) throw e;
    if (t.quirks) t.quirks.treeFilter = 'blob:none';
    return wide(true);
  }
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

// `check(objects)`, when given, runs over the resolved objects inside the span (it may drop some, or throw) and returns
// attrs for it.
export async function fetchPackOnce(t, opts, { external, resolve = true, attrs = {}, check = null } = {}) {
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
    if (check && resolved) span.set(check(resolved.objects));
    return { parsed, objects: resolved?.objects ?? null, resolved, ...acks };
  } catch (e) { if (e && typeof e === 'object') e.cacheStatus = span.attrs['git.response.cache'] ?? ''; throw e; } }));
}
