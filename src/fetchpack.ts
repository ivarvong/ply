// Buffered multi-object fetch: whole pack in memory (bounded by limits.maxPackBytes, enforced by v2Step as the band-1
// bytes arrive), parsed and delta-resolved.
// The general-purpose path (clones, thin packs, negotiation); the edit pipeline uses fetch.js's fetchObject instead.
// Reading the received pack is a Result (readPack); fetchPack and its fallbacks are the I/O edge, where errors are thrown.
import type { Span } from './otel.js';
import type { Attrs, Transport } from './transport.js';
import type { FetchOpts, PackObject, V2State } from './fetch.js';
import type { Input } from './absent.js';
import { concat } from './bytes.js';
import { TYPE, TYPE_NAME } from './objects.js';
import { parsePackResult, resolvePackResult, packParseOpts } from './packresolve.js';
import type { ParsedPack, ResolvedPack } from './packresolve.js';
import { coded, clientSpan } from './transport.js';
import { packStream, isFilterRejection, harvest, checkWide, skippedAttrs, stampCacheStatus } from './fetch.js';
import { fail, isPlyError, orThrow } from './errors.js';
import type { PlyError } from './errors.js';
import { fromNullable, fromNullish, withDefaults } from './absent.js';
import { ok, err, getOrElse } from './result.js';
import type { Result } from './result.js';
// oxlint-disable-next-line import/max-dependencies -- the buffered fetch joins the stream, the pack parser and the cache's retry rule
import { corruptCacheHit } from './cachestatus.js';

// The pack and its resolution, as packresolve.ts declares them.
type Parsed = ParsedPack;
type Resolved = ResolvedPack;
// A thin pack's base by oid, or null when the caller does not hold it.
export type ExternalLookup = (oid: string) => PackObject | null;
// `external(oid)` supplies a thin pack's bases; `check(objects)` runs over the resolved objects inside the span.
export type FetchPackConfig = {
  readonly external: ExternalLookup;
  readonly resolve: boolean;
  readonly attrs: Attrs;
  readonly check: ((objects: Map<string, PackObject>) => Attrs) | null;
};
export type FetchPackExtra = Input<FetchPackConfig>;
const noExternal: ExternalLookup = () => null;
const fetchPackDefaults = (): FetchPackConfig => ({ external: noExternal, resolve: true, attrs: {}, check: null });
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

// The span attribute for a type id: its name, or nothing for an id objects.js does not know (the attribute is dropped).
const typeAttr = (type: number): unknown => Reflect.get(TYPE_NAME, type);
type Acks = Pick<FetchPackResult, 'acks' | 'nak' | 'ready' | 'shallow' | 'unshallow'>;
// The received pack, parsed (one span event per object), resolved when asked, and checked.
function readPack(t: Transport, buf: Uint8Array, { external, resolve, check }: FetchPackConfig, acks: Acks, span: Span): Result<FetchPackResult, PlyError> {
  const read = parsePackResult(buf, packParseOpts(t.limits));
  if (!read.ok) return read;
  const parsed = read.value;
  for (const o of parsed.objects) span.event('git.pack.object', {
    'git.object.offset': o.offset, 'git.object.type': typeAttr(o.type), 'git.object.size': o.size, 'git.object.compressed': o.compressed,
    'git.object.header_bytes': o.headerBytes, 'git.object.base.offset': getOrElse(fromNullish(o.baseOffset), -1), 'git.object.base.oid': getOrElse(fromNullish(o.baseOid), ''),
    'git.object.inflate.blocks': o.inflate.blocks, 'git.object.inflate.stored': o.inflate.stored, 'git.object.inflate.fixed': o.inflate.fixed,
    'git.object.inflate.dynamic': o.inflate.dynamic, 'git.object.inflate.matches': o.inflate.matches, 'git.object.inflate.max_dist': o.inflate.maxDist,
  });
  let resolved: Resolved | null = null;
  if (resolve) {
    const r = resolvePackResult(parsed, external, t.limits);
    if (!r.ok) return r;
    resolved = r.value;
  }
  span.set(packAttrs(parsed, resolved));
  if (check && resolved) span.set(check(resolved.objects));
  return ok({ parsed, objects: resolved === null ? null : resolved.objects, resolved, ...acks });
}

// `check(objects)`, when given, runs over the resolved objects inside the span (it may drop some, or throw) and returns
// attrs for it.
// async: a synchronous failure is a rejection, as it always was
// oxlint-disable-next-line require-await -- see above
export async function fetchPackOnce(t: Transport, opts: FetchOpts, extra: FetchPackExtra = {}): Promise<FetchPackResult> {
  const cfg = withDefaults(extra, fetchPackDefaults());
  // oxlint-disable-next-line typescript/promise-function-async -- the span's promise, passed through (an async wrapper adds bytes, not behaviour)
  return coded('pack_corrupt', () => t.tracer.span('git.upload-pack fetch', clientSpan(t, { 'git.pack.cache.bust': Boolean(opts.bypassCache), ...cfg.attrs }), async (span: Span): Promise<FetchPackResult> => { try {
    const parts: Uint8Array[] = []; let total = 0;
    const it = packStream(t, opts, span);
    let st: V2State;
    // oxlint-disable-next-line no-await-in-loop, typescript/strict-boolean-expressions -- the generator is drained in order; its return value (done) is the v2 state
    for (;;) { const { value, done } = await it.next(); if (done) { st = value; break; } total += value.length; parts.push(value); }
    const acks: Acks = { acks: st.acks.filter(a => a.startsWith('ACK ')).map(a => a.slice(4)), nak: st.acks.includes('NAK'), ready: st.ready, shallow: st.shallow, unshallow: st.unshallow };
    if (st.phase !== 'pack') { span.set({ 'git.fetch.pack': false }); return { parsed: null, objects: null, resolved: null, ...acks }; }
    return orThrow(readPack(t, concat(parts), cfg, acks, span));
  } catch (e) { stampCacheStatus(e, span); throw e; } }));
}

// A pack that fails verification may be a poisoned cache entry (see packcache.js): retry once, bypassing the cache.
// Only when the bad response was served from cache; a corrupt live response is reported as-is.
export async function fetchPack(t: Transport, opts: FetchOpts, extra: FetchPackExtra = {}): Promise<FetchPackResult> {
  try { return await fetchPackOnce(t, opts, extra); } catch (e) {
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
  if (t.quirks.treeFilter === 'blob:none') return wide(false);
  try {
    const base = await fetchPack(t, opts, { check: (objects): Attrs => { checkWide(objects, () => true, t.limits); return {}; } });
    const f = fromNullable(opts.filter);
    const filterVal = f.tag === 'some' ? f.value : null;
    return { ...base, filter: filterVal, learned: false };
  } catch (e) {
    if (!isFilterRejection(e)) throw e;
    t.quirks.treeFilter = 'blob:none';
    return wide(true);
  }
}

// The two filters a history walk asks for. Anything else is the caller's bug, refused before a request.
export type PackFilter = 'tree:0' | 'blob:none';
const isPackFilter = (f: unknown): f is PackFilter => f === 'tree:0' || f === 'blob:none';
export type FilteredWantConfig = { readonly wants: readonly string[]; readonly filter: PackFilter; readonly deepen: number };
export type FilteredWant = Input<FilteredWantConfig>;
export type FilteredPack = {
  readonly objects: Map<string, PackObject> | null;
  readonly shallow: readonly string[];
  readonly filter: PackFilter;
  readonly learned: boolean;
};
// A caller's value, quoted: a primitive as JSON, anything else (the platform's missing value included) by its typeof.
const shown = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null ? JSON.stringify(v) : typeof v);
// fetchPackTree0 as a Result, for a caller that already holds the transport (ply-web's loadPack / loadWindow).
// `learned` is true only when this call is the one that found the server refuses tree:0.
export async function fetchPackFiltered(t: Transport, opts: FilteredWant | null): Promise<Result<FilteredPack, PlyError>> {
  if (typeof opts !== 'object' || opts === null) return fail('bad_request', 'fetchPackFiltered: expected { wants, filter, deepen }', { what: 'opts' });
  const { filter, wants } = opts;
  if (!isPackFilter(filter)) return fail('bad_request', `fetchPackFiltered: filter must be tree:0 or blob:none, got ${shown(filter)}`, { what: 'filter' });
  if (!Array.isArray(wants)) return fail('bad_request', 'fetchPackFiltered: wants must be a list of object ids', { what: 'wants' });
  if (wants.length === 0) return fail('bad_request', 'fetchPackFiltered: wants must name at least one object', { what: 'wants' });
  try {
    const r = await fetchPackTree0(t, { wants, filter, deepen: opts.deepen });
    // Success echoes the filter we just checked, or the fallback's blob:none. Both are PackFilter.
    const echoed: PackFilter = r.filter === 'blob:none' ? 'blob:none' : filter;
    return ok({ objects: r.objects, shallow: r.shallow, filter: echoed, learned: r.learned });
  } catch (e) {
    if (isPlyError(e)) return err(e);
    throw e;
  }
}
