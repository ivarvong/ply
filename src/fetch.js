// v2 fetch: request body (pure), response state machine (pure step), the streamed band-1 pack, and fetchObject — one
// object by oid through the single-object pack parser, hash-verified. The buffered multi-object fetch with delta
// resolution lives in fetchpack.js so this module never pulls the resolver into a bundle.
import { fail } from './errors.js';
import { pkts } from './pktline.js';
import { td, concat, take } from './bytes.js';
import { Sha1, toHex } from './sha1.js';
import { TYPE, TYPE_NAME, hashObject, assertFetched } from './objects.js';
import { inflate } from './inflate.js';
import { parsePack, resolvePack, readObjHeader, readUint32BE, packParseOpts } from './packresolve.js';
import { PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, PACK_TRAILER_BYTES, UINT32_BYTES, SIDEBAND_PACK, SIDEBAND_PROGRESS, SIDEBAND_ERROR, SIDEBAND_CHANNEL_BYTES, OID_HEX_CHARS, PROTOCOL_V2 } from './format.js';
import { DEFAULT_LIMITS, limitError } from './limits.js';
import { frames, coded, clientSpan, proto } from './transport.js';

/* oxlint-disable no-magic-numbers -- span tails and the compressed-size slack are diagnostics, not wire-format facts */
const PROGRESS_KEEP = 512;
const PROGRESS_ATTR = 200;
const COMPRESSED_SLACK = 64 * 1024;
const OID_PREVIEW = 48;
/* oxlint-enable no-magic-numbers */


// ---- request body (pure) ----
export function fetchBody({ wants, haves = [], filter, deepen, deepenSince, deepenNot = [], deepenRelative = false, thinPack = false, ofsDelta = true, includeTag = false, noProgress = true, done = true, shallows = [] }) {
  const args = [
    ...wants.map(w => `want ${w}\n`),
    ...haves.map(h => `have ${h}\n`),
    ...shallows.map(s => `shallow ${s}\n`),
    ...(filter ? [`filter ${filter}\n`] : []),
    ...(deepen ? [`deepen ${deepen}\n`] : []),
    ...(deepenSince ? [`deepen-since ${deepenSince}\n`] : []),
    ...deepenNot.map(r => `deepen-not ${r}\n`),
    ...(deepenRelative ? ['deepen-relative\n'] : []),
    ...(thinPack ? ['thin-pack\n'] : []),
    ...(ofsDelta ? ['ofs-delta\n'] : []),
    ...(includeTag ? ['include-tag\n'] : []),
    ...(noProgress ? ['no-progress\n'] : []),
    ...(done ? ['done\n'] : []),
  ];
  return pkts(['command=fetch\n', ...args], { delimAfter: 0 });
}

// ---- v2 fetch response state machine (pure step over frames) ----
export const v2Init = (limits = DEFAULT_LIMITS) => Object.freeze({ limits,
  phase: 'sections', section: null, sections: [], shallow: [], unshallow: [], acks: [], ready: false,
  band1: 0, band2: 0, band3: 0, band2Frames: 0, progress: '', error: null, done: false, packFrames: 0,
});
// @decoder v2Step prefix=v2
export function v2Step(st, frame) {
  if (st.done) throw proto('v2: frame after flush');
  if (frame.kind === 'flush') return { state: { ...st, done: true }, pack: null };
  if (frame.kind === 'end') return { state: st, pack: null };
  if (st.phase === 'pack') {
    if (frame.kind !== 'data') return { state: st, pack: null };
    const band = parseSideband(frame.payload);
    if (band.band === SIDEBAND_PACK) return { state: { ...st, band1: st.band1 + band.body.length, packFrames: st.packFrames + 1 }, pack: band.body };
    if (band.band === SIDEBAND_PROGRESS) return { state: { ...st, band2: st.band2 + band.body.length, band2Frames: st.band2Frames + 1, progress: (st.progress + td.decode(band.body)).slice(-PROGRESS_KEEP) }, pack: null };
    if (band.band === SIDEBAND_ERROR) throw fail('remote_error', `remote: ${td.decode(band.body).trim()}`);
    throw proto(`v2: bad sideband ${band.band}`);
  }
  if (frame.kind === 'delim') return { state: { ...st, section: null }, pack: null };
  const line = td.decode(frame.payload).replace(/\n$/, '');
  if (line.startsWith('ERR ')) throw fail('remote_error', `remote: ${line.slice('ERR '.length)}`);
  if (st.section === null) {
    const next = { ...st, section: line, sections: [...st.sections, line] };
    if (line === 'packfile') next.phase = 'pack';
    return { state: next, pack: null };
  }
  if (st.section === 'shallow-info') {
    if ((st.sectionLines ?? 0) >= st.limits.maxSectionLines) throw limitError('shallow-info lines', (st.sectionLines ?? 0) + 1, st.limits.maxSectionLines);
    st = { ...st, sectionLines: (st.sectionLines ?? 0) + 1 };
    // the server may repeat a shallow line when a commit is wanted both directly and through a tag; keep them unique
    if (line.startsWith('shallow ')) return { state: { ...st, shallow: st.shallow.includes(line.slice('shallow '.length)) ? st.shallow : [...st.shallow, line.slice('shallow '.length)] }, pack: null };
    if (line.startsWith('unshallow ')) return { state: { ...st, unshallow: st.unshallow.includes(line.slice('unshallow '.length)) ? st.unshallow : [...st.unshallow, line.slice('unshallow '.length)] }, pack: null };
  }
  if (st.section === 'acknowledgments') {
    if (st.acks.length >= st.limits.maxSectionLines) throw limitError('acknowledgment lines', st.acks.length + 1, st.limits.maxSectionLines);
    if (line === 'ready') return { state: { ...st, ready: true }, pack: null };
    return { state: { ...st, acks: [...st.acks, line] }, pack: null };
  }
  return { state: st, pack: null };
}
export const v2Attrs = st => ({
  'git.fetch.sections': st.sections.join(','), 'git.fetch.shallow': st.shallow, 'git.fetch.unshallow': st.unshallow,
  'git.fetch.acks': st.acks, 'git.fetch.ready': st.ready,
  'git.sideband.band1.bytes': st.band1, 'git.sideband.band2.bytes': st.band2, 'git.sideband.band2.frames': st.band2Frames,
  'git.sideband.band3.bytes': st.band3, 'git.sideband.pack.frames': st.packFrames, 'git.sideband.progress.tail': st.progress.slice(-PROGRESS_ATTR),
});
export const fetchAttrs = opts => ({
  'git.command': 'fetch', 'git.protocol.version': PROTOCOL_V2, 'git.fetch.wants': opts.wants, 'git.fetch.wants.count': opts.wants.length,
  'git.fetch.haves.count': (opts.haves ?? []).length, 'git.fetch.filter': opts.filter ?? '', 'git.fetch.deepen': opts.deepen ?? 0, 'git.fetch.deepen_since': opts.deepenSince ?? 0, 'git.fetch.deepen_not': opts.deepenNot ?? [], 'git.fetch.shallows.count': (opts.shallows ?? []).length, 'git.fetch.done': opts.done !== false,
  'git.fetch.thin_pack': !!opts.thinPack, 'git.fetch.ofs_delta': opts.ofsDelta !== false, 'git.fetch.no_progress': opts.noProgress !== false,
});

// Stream band-1 pack bytes. Consumer drives it; the v2 state is the generator's return value.
export async function* packStream(t, opts, span) {
  span.set(fetchAttrs(opts));
  let st = v2Init(t.limits);
  for await (const f of frames(t, 'git-upload-pack', fetchBody(opts), span, { bypassCache: !!opts.bypassCache })) {
    const r = v2Step(st, f);
    st = r.state;
    if (r.pack) yield r.pack;
  }
  if (!st.done) throw proto('v2: response ended without flush');
  if (st.phase !== 'pack' && !st.sections.includes('acknowledgments')) throw proto(`v2: no packfile section (sections: ${st.sections.join(',') || 'none'})`);
  span.set(v2Attrs(st));
  return st;
}

// ---- single-object pack stream parser (pure step) ----
// Emits the zlib bytes of the single object, withholding the trailing 20-byte trailer, verifying it at finish.
// @decoder parseSideband prefix=sideband
export function parseSideband(payload) {
  const band = take(payload, 0, SIDEBAND_CHANNEL_BYTES, 'protocol')[0];
  // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral: a one-byte payload takes zero body bytes, the same empty result, and that read cannot be short
  const body = payload.length > SIDEBAND_CHANNEL_BYTES ? take(payload, SIDEBAND_CHANNEL_BYTES, payload.length - SIDEBAND_CHANNEL_BYTES, 'protocol') : new Uint8Array(0);
  return { band, body };
}

const shortRead = e => e?.code === 'pack_corrupt' && String(e.message).startsWith('short read:');

export const spInit = () => Object.freeze({ head: new Uint8Array(0), phase: 'header', type: 0, size: 0, lag: new Uint8Array(0), sha: new Sha1(), bytes: 0, zlibBytes: 0 });
// @decoder spStep prefix=sp-header
export function spStep(st, chunk) {
  let s = { ...st, bytes: st.bytes + chunk.length };
  let data = chunk;
  if (s.phase === 'header') {
    const head = concat([s.head, chunk]);
    // need the pack header plus the first object-header byte; a short read means the chunk has not arrived
    if (head.length < PACK_HEADER_BYTES + 1) return { state: { ...s, head }, zlib: [] };
    if (!take(head, 0, PACK_SIGNATURE.length).every((b, i) => b === PACK_SIGNATURE[i])) throw fail('pack_corrupt', 'pack: bad signature');
    if (readUint32BE(head, PACK_SIGNATURE.length) !== PACK_VERSION) throw fail('pack_corrupt', 'pack: bad version');
    const count = readUint32BE(head, PACK_SIGNATURE.length + UINT32_BYTES);
    if (count !== 1) throw fail('pack_corrupt', `pack: expected 1 object, got ${count}`);
    let header;
    try { header = readObjHeader(head, PACK_HEADER_BYTES); }
    // Stryker disable next-line ConditionalExpression: readObjHeader's only throw here is the short read take() raises
    catch (e) { if (shortRead(e)) return { state: { ...s, head }, zlib: [] }; throw e; }
    if (header.type === TYPE.OFS_DELTA || header.type === TYPE.REF_DELTA) throw fail('pack_corrupt', 'pack: single-object pack is a delta');
    const p = header.next;
    s = { ...s, phase: 'body', type: header.type, size: header.size, head: new Uint8Array(0), headerBytes: p };
    s.sha.update(take(head, 0, p));
    data = take(head, p, head.length - p);
  }
  // body: pass through with the trailer withheld
  const all = s.lag.length ? concat([s.lag, data]) : data;
  const emitLen = Math.max(0, all.length - PACK_TRAILER_BYTES);
  const emit = emitLen ? take(all, 0, emitLen) : new Uint8Array(0);
  const lag = take(all, emitLen, all.length - emitLen).slice();
  // Stryker disable next-line ConditionalExpression: hashing an empty emit leaves the trailer digest unchanged
  if (emitLen) s.sha.update(emit);
  return { state: { ...s, lag, zlibBytes: s.zlibBytes + emitLen }, zlib: emitLen ? [emit] : [] };
}
export function spFinish(st) {
  if (st.phase !== 'body') throw fail('pack_corrupt', 'pack: truncated before object header');
  if (st.lag.length !== PACK_TRAILER_BYTES) throw fail('pack_corrupt', 'pack: missing trailer');
  const want = toHex(st.lag), got = st.sha.hex();
  if (want !== got) throw fail('pack_corrupt', `pack: trailer ${want} != ${got}`);
  return { ...st, trailer: want };
}
export const spAttrs = (st, prefix = 'git.pack') => ({ [`${prefix}.objects`]: 1, [`${prefix}.bytes`]: st.bytes, [`${prefix}.trailer`]: st.trailer ?? '', [`${prefix}.compressed.bytes`]: st.zlibBytes, [`${prefix}.type.${TYPE_NAME[st.type] ?? st.type}`]: 1 });

// One object by oid (a tree or a commit, under a filter that keeps the pack to that object), fully in memory but bounded
// by limits.maxObjectSize, inflated with our inflate and hash-verified against the oid. A verification failure after a
// cache HIT is retried once past the cache (packcache.js). Returns { type, data, oid, size, bust }.
//
// The blob:none fallback. Some servers advertise `fetch=filter` but honour only `blob:none` (Cloudflare Artifacts:
// HTTP 400 "Unsupported Git fetch filter; only blob:none is supported.", observed 2026-10-23). Detected by that answer,
// never by host name: the transport's `quirks.treeFilter` becomes 'blob:none' and this and every later tree:0 fetch on
// it asks for blob:none instead. That pack is wider — a commit want (deepen 1) brings every tree of the commit, a tree
// want its whole subtree — so it is parsed and delta-resolved (packresolve.js), the wanted object is taken by its
// computed hash, and the other commits and trees are harvested into `t.objects` (bounded by limits.maxHarvestBytes):
// the next tree:0 fetch of any of them is answered locally. Spans: `git.fetch.filter.fallback`, `git.fetch.wide.*`.
const OID_RE = new RegExp(`^[0-9a-f]{${OID_HEX_CHARS}}$`);
export const isFilterRejection = e => ['http', 'remote_error', 'protocol'].includes(e?.code) && /only blob:none is supported|unsupported (git )?fetch filter|filter .* not (supported|allowed)/i.test(String(e?.message ?? ''));

// Keep commits and trees from a wide pack for later tree:0 wants. Every entry's key is its computed hash (resolvePack).
export function harvest(t, objects, skip = null) {
  const store = t.objects; if (!store) return { kept: 0, bytes: 0 };
  let kept = 0, bytes = 0; store.bytes ??= 0;
  for (const [oid, o] of objects) {
    if (oid === skip || store.has(oid) || (o.type !== TYPE.COMMIT && o.type !== TYPE.TREE)) continue;
    if (store.bytes + o.data.length > (t.limits.maxHarvestBytes ?? 0)) break;
    store.set(oid, { type: o.type, data: o.data }); store.bytes += o.data.length; kept++; bytes += o.data.length;
  }
  return { kept, bytes };
}

export async function fetchObject(t, { oid, filter = 'tree:0', deepen, expectType = null }) {
  if (!OID_RE.test(oid ?? '')) throw fail('bad_request', `fetchObject: oid must be 40-hex, got ${JSON.stringify(String(oid).slice(0, OID_PREVIEW))}`);
  const narrow = filter === 'tree:0';
  const held = narrow ? t.objects?.get(oid) : undefined;
  if (held && (expectType === null || held.type === expectType)) return { type: held.type, data: held.data, oid, size: held.data.length, bust: false, harvested: true };
  if (narrow && t.quirks?.treeFilter === 'blob:none') return fetchWide(t, { oid, deepen, expectType });
  try { return await fetchSingle(t, { oid, filter, deepen, expectType }); } catch (e) {
    if (!narrow || !isFilterRejection(e)) throw e;
    if (t.quirks) t.quirks.treeFilter = 'blob:none';
    return fetchWide(t, { oid, deepen, expectType, learned: true });
  }
}

async function fetchSingle(t, { oid, filter, deepen, expectType }) {
  // The span is where the transport says whether the response came from a cache; a verification failure after a HIT is
  // retried once past the cache (packcache.js), a corrupt live response is not.
  const once = bust => coded('pack_corrupt', () => t.tracer.span('git.upload-pack fetch', clientSpan(t, { 'git.pack.cache.bust': bust }), async span => {
    try {
      let sp = spInit(); const zlibParts = []; let zlibLen = 0;
      for await (const chunk of packStream(t, { wants: [oid], filter, deepen, bypassCache: bust }, span)) {
        const r = spStep(sp, chunk); sp = r.state;
        if (sp.phase === 'body' && sp.size > t.limits.maxObjectSize) throw limitError('object size', sp.size, t.limits.maxObjectSize);
        if (sp.bytes > t.limits.maxPackBytes) throw limitError('pack bytes', sp.bytes, t.limits.maxPackBytes);
        for (const z of r.zlib) { zlibParts.push(z); zlibLen += z.length; }
        if (zlibLen > t.limits.maxObjectSize + COMPRESSED_SLACK) throw limitError('compressed object bytes', zlibLen, t.limits.maxObjectSize);
      }
      sp = spFinish(sp);
      const zlib = concat(zlibParts);
      const { out, consumed, stats } = inflate(zlib, 0, { expectedSize: sp.size, maxOutput: t.limits.maxObjectSize });
      if (consumed !== zlib.length) throw fail('pack_corrupt', `pack: ${zlib.length - consumed} trailing bytes after object`);
      const got = hashObject(TYPE_NAME[sp.type], out);
      span.set({ ...spAttrs(sp), 'git.pack.inflated.bytes': out.length, 'git.pack.inflate.blocks': stats.blocks, 'git.pack.inflate.stored': stats.stored, 'git.pack.inflate.fixed': stats.fixed, 'git.pack.inflate.dynamic': stats.dynamic, 'git.object.oid': got, 'git.object.type': TYPE_NAME[sp.type] });
      if (got !== oid) throw fail('pack_corrupt', `object ${got} served for want ${oid}`);
      assertFetched(TYPE_NAME[sp.type], out);
      if (expectType !== null && sp.type !== expectType) throw fail('pack_corrupt', `expected ${TYPE_NAME[expectType]}, got ${TYPE_NAME[sp.type]}`);
      return { type: sp.type, data: out, oid, size: out.length, bust };
    } catch (e) { if (e && typeof e === 'object') e.cacheStatus = span.attrs['git.response.cache'] ?? ''; throw e; }
  }));
  try { return await once(false); } catch (e) {
    if (e?.code !== 'pack_corrupt' || e?.cacheStatus !== 'HIT') throw e;
    return once(true);
  }
}

// The blob:none form of a tree:0 single-object fetch (see fetchObject). Bounded by limits.maxPackBytes.
async function fetchWide(t, { oid, deepen, expectType, learned = false }) {
  const once = bust => coded('pack_corrupt', () => t.tracer.span('git.upload-pack fetch', clientSpan(t, { 'git.pack.cache.bust': bust, 'git.fetch.filter.fallback': 'blob:none', 'git.fetch.filter.requested': 'tree:0', 'git.fetch.filter.learned': learned }), async span => {
    try {
      const parts = []; let total = 0;
      for await (const chunk of packStream(t, { wants: [oid], filter: 'blob:none', deepen, bypassCache: bust }, span)) {
        total += chunk.length; if (total > t.limits.maxPackBytes) throw limitError('pack bytes', total, t.limits.maxPackBytes);
        parts.push(chunk);
      }
      const parsed = parsePack(concat(parts), packParseOpts(t.limits));
      const { objects } = resolvePack(parsed, undefined, t.limits);
      for (const o of objects.values()) if (o.type === TYPE.COMMIT || o.type === TYPE.TREE || o.type === TYPE.TAG) assertFetched(TYPE_NAME[o.type], o.data);
      const want = objects.get(oid);
      if (!want) throw fail('pack_corrupt', `object ${oid} not in the blob:none pack (${objects.size} objects)`);
      if (want.data.length > t.limits.maxObjectSize) throw limitError('object size', want.data.length, t.limits.maxObjectSize);
      if (expectType !== null && want.type !== expectType) throw fail('pack_corrupt', `expected ${TYPE_NAME[expectType]}, got ${TYPE_NAME[want.type]}`);
      let extraBytes = 0, blobs = 0; for (const [k, o] of objects) { if (k !== oid) extraBytes += o.data.length; if (o.type === TYPE.BLOB) blobs++; }
      const h = harvest(t, objects, oid);
      span.set({ 'git.pack.objects': parsed.stats.count, 'git.pack.bytes': total, 'git.object.oid': oid, 'git.object.type': TYPE_NAME[want.type], 'git.fetch.wide.objects': objects.size, 'git.fetch.wide.extra_objects': objects.size - 1, 'git.fetch.wide.extra_bytes': extraBytes, 'git.fetch.wide.blobs': blobs, 'git.fetch.wide.harvested': h.kept, 'git.fetch.wide.harvested_bytes': h.bytes });
      return { type: want.type, data: want.data, oid, size: want.data.length, bust, wide: true };
    } catch (e) { if (e && typeof e === 'object') e.cacheStatus = span.attrs['git.response.cache'] ?? ''; throw e; }
  }));
  try { return await once(false); } catch (e) {
    if (e?.code !== 'pack_corrupt' || e?.cacheStatus !== 'HIT') throw e;
    return once(true);
  }
}
