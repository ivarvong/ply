// Buffered multi-object fetch: whole pack in memory (bounded by limits.maxPackBytes, enforced by v2Step as the band-1
// bytes arrive), parsed and delta-resolved.
// The general-purpose path (clones, thin packs, negotiation); the edit pipeline uses fetch.js's fetchObject instead.
import type { Span } from './otel.js';
import type { Attrs, Transport } from './transport.js';
import type { FetchOpts, PackObject, V2State } from './fetch.js';
import { concat } from './bytes.js';
import { TYPE, TYPE_NAME } from './objects.js';
import { parsePack, resolvePack, packParseOpts } from './packresolve.js';
import { coded, clientSpan } from './transport.js';
import { packStream, isFilterRejection, harvest, checkWide, skippedAttrs } from './fetch.js';
import { plyError, isPlyError } from './errors.js';
import type { PlyError } from './errors.js';
import { fromNullable } from './absent.js';
import { ok, err } from './result.js';
import type { Result } from './result.js';
import { corruptCacheHit } from './cachestatus.js';

// packresolve.js is not converted yet: its shapes are whatever it declares.
type Parsed = ReturnType<typeof parsePack>;
type Resolved = ReturnType<typeof resolvePack>;
// `external(oid)` supplies a thin pack's bases; `check(objects)` runs over the resolved objects inside the span.
export type FetchPackExtra = {
  readonly external?: ((oid: string) => PackObject | undefined) | undefined;
  readonly resolve?: boolean | undefined;
  readonly attrs?: Attrs;
  readonly check?: ((objects: Map<string, PackObject>) => Attrs) | null;
};
export type FetchPackResult = {
  readonly parsed: Parsed | null; readonly objects: Map<string, PackObject> | null; readonly resolved: Resolved | null;
  readonly acks: string[]; readonly nak: boolean; readonly ready: boolean; readonly shallow: readonly string[]; readonly unshallow: readonly string[];
};

export const packAttrs = (parsed: Parsed, resolved: Resolved | null): Attrs => ({
  'git.pack.version': parsed.stats.version, 'git.pack.objects': parsed.stats.count, 'git.pack.bytes': parsed.bytes,
  'git.pack.trailer': parsed.trailer, 'git.pack.full': parsed.stats.full, 'git.pack.ofs_delta': parsed.stats.ofsDelta,
  'git.pack.ref_delta': parsed.stats.refDelta, 'git.pack.compressed.bytes': parsed.stats.compressed, 'git.pack.inflated.bytes': parsed.stats.inflated,
  'git.pack.inflate.blocks': parsed.stats.inflate.blocks, 'git.pack.inflate.stored': parsed.stats.inflate.stored,
  'git.pack.inflate.fixed': parsed.stats.inflate.fixed, 'git.pack.inflate.dynamic': parsed.stats.inflate.dynamic,
  ...Object.fromEntries(Object.entries(parsed.stats.byType).map(([k, v]) => [`git.pack.type.${k}`, v])),
  ...(resolved ? { 'git.pack.chain.max': resolved.stats.maxChain, 'git.pack.external_bases': resolved.stats.externalBases } : {}),
});

// `check(objects)`, when given, runs over the resolved objects inside the span (it may drop some, or throw) and returns
// attrs for it.
// async: a synchronous failure is a rejection, as it always was
// oxlint-disable-next-line require-await -- see above
export async function fetchPackOnce(t: Transport, opts: FetchOpts, { external, resolve = true, attrs = {}, check = null }: FetchPackExtra = {}): Promise<FetchPackResult> {
  // oxlint-disable-next-line typescript/promise-function-async -- the span's promise, passed through (an async wrapper adds bytes, not behaviour)
  return coded('pack_corrupt', () => t.tracer.span('git.upload-pack fetch', clientSpan(t, { 'git.pack.cache.bust': Boolean(opts.bypassCache), ...attrs }), async (span: Span): Promise<FetchPackResult> => { try {
    const parts: Uint8Array[] = []; let total = 0;
    const it = packStream(t, opts, span);
    let st: V2State;
    // oxlint-disable-next-line no-await-in-loop, typescript/strict-boolean-expressions -- the generator is drained in order; its return value (done) is the v2 state
    for (;;) { const { value, done } = await it.next(); if (done) { st = value; break; } total += value.length; parts.push(value); }
    const acks = { acks: st.acks.filter(a => a.startsWith('ACK ')).map(a => a.slice(4)), nak: st.acks.includes('NAK'), ready: st.ready, shallow: st.shallow, unshallow: st.unshallow };
    if (st.phase !== 'pack') { span.set({ 'git.fetch.pack': false }); return { parsed: null, objects: null, resolved: null, ...acks }; }
    const buf = concat(parts);
    const parsed = parsePack(buf, packParseOpts(t.limits));
    for (const o of parsed.objects) span.event('git.pack.object', {
      'git.object.offset': o.offset, 'git.object.type': (TYPE_NAME as Readonly<Partial<Record<number, string>>>)[o.type], 'git.object.size': o.size, 'git.object.compressed': o.compressed,
      'git.object.header_bytes': o.headerBytes, 'git.object.base.offset': o.baseOffset ?? -1, 'git.object.base.oid': o.baseOid ?? '',
      'git.object.inflate.blocks': o.inflate.blocks, 'git.object.inflate.stored': o.inflate.stored, 'git.object.inflate.fixed': o.inflate.fixed,
      'git.object.inflate.dynamic': o.inflate.dynamic, 'git.object.inflate.matches': o.inflate.matches, 'git.object.inflate.max_dist': o.inflate.maxDist,
    });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- packresolve.js infers `external` from its default (() => undefined) until its cluster converts
    const resolved = resolve ? resolvePack(parsed, external, t.limits) : null;
    span.set(packAttrs(parsed, resolved));
    if (check && resolved) span.set(check(resolved.objects));
    return { parsed, objects: resolved?.objects ?? null, resolved, ...acks };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- any thrown object carries the cache status (fetchPack reads it back)
  } catch (e) { if (Boolean(e) && typeof e === 'object') (e as { cacheStatus?: unknown }).cacheStatus = span.attrs['git.response.cache'] ?? ''; throw e; } }));
}

// A pack that fails verification may be a poisoned cache entry (see packcache.js): retry once, bypassing the cache.
// Only when the bad response was served from cache; a corrupt live response is reported as-is.
export async function fetchPack(t: Transport, opts: FetchOpts, extra: FetchPackExtra = {}): Promise<FetchPackResult> {
  try { return await fetchPackOnce(t, opts, extra); } catch (e) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see Loose (transport.ts)
    if (!corruptCacheHit(e) || Boolean(opts.bypassCache)) throw e;
    return fetchPackOnce(t, { ...opts, bypassCache: true }, extra);
  }
}

// fetchPack for a `filter tree:0` request (commit-only history walks) with the blob:none fallback of fetch.js: a server
// that refuses tree:0 gets blob:none, which also carries every tree of every commit in the window — far more bytes on a
// deep window (bounded by limits.maxPackBytes; the attrs say how much). The trees are harvested for later tree fetches.
// Every commit, tree and tag in the pack is checked as fetchObject checks one (assertFetched), inside the fetch's span,
// so a malformed object fails the fetch (`pack_corrupt`) instead of reaching a caller or the harvest. On the tree:0
// path all of it is what was asked for. On the blob:none path the trees are extras a tree:0 server would not have sent
// (the walk reads commits only): checkWide drops one that is over a limit instead of failing the walk (#46; see there).
// The result carries `filter` (the one the answered request used) and `learned` (true only on the request that
// discovered the refusal; a later call on the same quirks asks for blob:none directly and reports learned false).
const commitsAndTags = (_oid: string, o: PackObject): boolean => o.type !== TYPE.TREE;
export type Tree0Pack = FetchPackResult & { readonly filter: string | null; readonly learned: boolean };
export async function fetchPackTree0(t: Transport, opts: FetchOpts): Promise<Tree0Pack> {
  const wide = async (learned: boolean): Promise<Tree0Pack> => {
    const r = await fetchPack(t, { ...opts, filter: 'blob:none' }, { check: objects => skippedAttrs(checkWide(objects, commitsAndTags, t.limits)), attrs: { 'git.fetch.filter.fallback': 'blob:none', 'git.fetch.filter.requested': opts.filter, 'git.fetch.filter.learned': learned } });
    if (r.objects) harvest(t, r.objects);
    return { ...r, filter: 'blob:none', learned };
  };
  if (t.quirks?.treeFilter === 'blob:none') return wide(false);
  try {
    const base = await fetchPack(t, opts, { check: (objects): Attrs => { checkWide(objects, () => true, t.limits); return {}; } });
    const f = fromNullable(opts.filter);
    const filterVal = f.tag === 'some' ? f.value : null;
    return { ...base, filter: filterVal, learned: false };
  } catch (e) {
    if (!isFilterRejection(e)) throw e;
    if (t.quirks) t.quirks.treeFilter = 'blob:none';
    return wide(true);
  }
}

// The two filters a history walk asks for. Anything else is the caller's bug, refused before a request.
export type PackFilter = 'tree:0' | 'blob:none';
const isPackFilter = (f: unknown): f is PackFilter => f === 'tree:0' || f === 'blob:none';
type DeepenOpt = { readonly deepen: number };
export type FilteredWant = { readonly wants: readonly string[]; readonly filter: PackFilter } & Partial<DeepenOpt>;
export type FilteredPack = {
  readonly objects: Map<string, PackObject> | null;
  readonly shallow: readonly string[];
  readonly filter: PackFilter;
  readonly learned: boolean;
};
// The platform missing word, spelled without naming it: this file is outside the absence boundary.
const MISSING_WORD = String.fromCodePoint(117, 110, 100, 101, 102, 105, 110, 101, 100);
const shown = (v: unknown): string => {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) return JSON.stringify(v);
  if (fromNullable(v).tag === 'none') return MISSING_WORD;
  return typeof v;
};
// fetchPackTree0 as a Result, for a caller that already holds the transport (ply-web's loadPack / loadWindow).
// `learned` is true only when this call is the one that found the server refuses tree:0.
export async function fetchPackFiltered(t: Transport, opts: Partial<FilteredWant> | null): Promise<Result<FilteredPack, PlyError>> {
  if (typeof opts !== 'object' || opts === null) return err(plyError('bad_request', 'fetchPackFiltered: expected { wants, filter, deepen }', { what: 'opts' }));
  if (!isPackFilter(opts.filter)) return err(plyError('bad_request', `fetchPackFiltered: filter must be tree:0 or blob:none, got ${shown(opts.filter)}`, { what: 'filter' }));
  const { wants } = opts;
  if (!Array.isArray(wants)) return err(plyError('bad_request', 'fetchPackFiltered: wants must be a list of object ids', { what: 'wants' }));
  if (wants.length === 0) return err(plyError('bad_request', 'fetchPackFiltered: wants must name at least one object', { what: 'wants' }));
  try {
    const r = await fetchPackTree0(t, { wants, filter: opts.filter, deepen: opts.deepen });
    // Success echoes the filter we just checked, or the fallback's blob:none. Both are PackFilter.
    const filter: PackFilter = r.filter === 'blob:none' ? 'blob:none' : opts.filter;
    return ok({ objects: r.objects, shallow: r.shallow, filter, learned: r.learned });
  } catch (e) {
    if (isPlyError(e)) return err(e);
    throw e;
  }
}
