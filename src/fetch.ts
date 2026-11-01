// v2 fetch: request body (pure), response state machine (pure step), the streamed band-1 pack, and fetchObject — one
// object by oid through the single-object pack parser, hash-verified. The buffered multi-object fetch with delta
// resolution lives in fetchpack.js so this module never pulls the resolver into a bundle.
/* oxlint-disable require-unicode-regexp -- ASCII wire text; `u` costs a byte per literal and changes what /i matches (U+017F, U+212A) */
import type { Extra } from './errors.js';
import type { Limits } from './limits.js';
import type { Span } from './otel.js';
import type { Attrs, Frame, Loose, Transport } from './transport.js';
import { thrown as fail, scrubError } from './errors.js';
import { pkts } from './pktline.js';
import { td, concat, take, decodeChunk } from './bytes.js';
import { Sha1, toHex } from './sha1.js';
import { TYPE, TYPE_NAME, hashObject, assertFetched, nonCommitType } from './objects.js';
import { inflate } from './inflate.js';
import { parsePack, resolvePack, readObjHeader, readUint32BE, packParseOpts } from './packresolve.js';
// oxlint-disable-next-line import/max-dependencies -- the fetch path's parsers each live in their own module (pack, inflate, objects, sha1)
import { PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, PACK_TRAILER_BYTES, UINT32_BYTES, SIDEBAND_PACK, SIDEBAND_PROGRESS, SIDEBAND_ERROR, SIDEBAND_CHANNEL_BYTES, OID_HEX_CHARS, PROTOCOL_V2, zlibBound } from './format.js';
import { DEFAULT_LIMITS, limitError, requireLimit } from './limits.js';
import { validateWire } from './validate.js';
import { frames, coded, clientSpan, proto } from './transport.js';

/* oxlint-disable no-magic-numbers -- span tails are diagnostics, not wire-format facts */
const PROGRESS_KEEP = 512;
const PROGRESS_ATTR = 200;
const OID_PREVIEW = 48;
/* oxlint-enable no-magic-numbers */

// TYPE_NAME read by a type id that is a number on the wire (objects.js keys it by the ids it knows).
type Names = Readonly<Partial<Record<number, string>>>;
// A git object as the pack parser and resolver hand it over (and as the harvest holds it).
export type PackObject = { readonly type: number; readonly data: Uint8Array };

// ---- request body (pure) ----
const wireField = (value: string, what: string): unknown => validateWire(value, what);
const countField = (value: number, what: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw fail('bad_request', `invalid ${what}: must be a non-negative safe integer`, { what });
};
// deepen-since is a unix timestamp on the wire (a number from callers, or a digit string). Either way it is one token.
const sinceField = (value: number | string, what: string): void => {
  if (typeof value === 'number') countField(value, what);
  else wireField(value, what);
};

// The arguments of one v2 fetch command. An empty filter, a zero deepen and a zero deepen-since are absent.
export type FetchOpts = {
  readonly wants: readonly string[];
  readonly haves?: readonly string[] | undefined;
  readonly filter?: string | undefined;
  readonly deepen?: number | undefined;
  readonly deepenSince?: number | string | undefined;
  readonly deepenNot?: readonly string[] | undefined;
  readonly deepenRelative?: boolean | undefined;
  readonly thinPack?: boolean | undefined;
  readonly ofsDelta?: boolean | undefined;
  readonly includeTag?: boolean | undefined;
  readonly noProgress?: boolean | undefined;
  readonly done?: boolean | undefined;
  readonly shallows?: readonly string[] | undefined;
  readonly bypassCache?: boolean | undefined;
};

// oxlint-disable-next-line complexity -- one optional line per fetch argument
export function fetchBody({ wants, haves = [], filter = '', deepen = 0, deepenSince = 0, deepenNot = [], deepenRelative = false, thinPack = false, ofsDelta = true, includeTag = false, noProgress = true, done = true, shallows = [] }: FetchOpts): Uint8Array<ArrayBuffer> {
  for (const w of wants) wireField(w, 'want');
  for (const h of haves) wireField(h, 'have');
  for (const s of shallows) wireField(s, 'shallow');
  for (const r of deepenNot) wireField(r, 'deepen-not');
  if (filter) wireField(filter, 'filter');
  if (deepen) countField(deepen, 'deepen');
  // oxlint-disable-next-line typescript/strict-boolean-expressions -- 0, '' and NaN mean no deepen-since, as they always have
  if (deepenSince) sinceField(deepenSince, 'deepen-since');
  const args = [
    ...wants.map(w => `want ${w}\n`),
    ...haves.map(h => `have ${h}\n`),
    ...shallows.map(s => `shallow ${s}\n`),
    ...(filter ? [`filter ${filter}\n`] : []),
    ...(deepen ? [`deepen ${deepen}\n`] : []),
    // oxlint-disable-next-line typescript/strict-boolean-expressions -- as above
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
// One sideband frame: the band byte and its payload.
// @decoder parseSideband prefix=sideband
export function parseSideband(payload: Uint8Array): { readonly band: number; readonly body: Uint8Array } {
  // an empty payload (0004) has no band byte: git's demultiplex_sideband "missing sideband designator"
  // take returns exactly SIDEBAND_CHANNEL_BYTES bytes or throws, so the fallback never applies
  const band: number = take(payload, 0, SIDEBAND_CHANNEL_BYTES, 'protocol')[0] ?? 0;
  const body = payload.subarray(SIDEBAND_CHANNEL_BYTES);
  return { band, body };
}

// A3: `phase` as a tagged union (sections | pack | done) with the section's counters on its own member.
export type V2State = {
  readonly limits: Limits;
  readonly phase: 'sections' | 'pack';
  readonly section: string | null;
  readonly sections: readonly string[];
  readonly shallow: readonly string[];
  readonly unshallow: readonly string[];
  readonly acks: readonly string[];
  readonly ready: boolean;
  readonly band1: number;
  readonly band2: number;
  readonly band3: number;
  readonly band2Frames: number;
  readonly progress: string;
  readonly progressCarry: Uint8Array;
  readonly error: null;
  readonly done: boolean;
  readonly packFrames: number;
  readonly sectionLines?: number;
  readonly otherLines?: number;
};
export type V2Step = { readonly state: V2State; readonly pack: Uint8Array | null };

// upload-pack's own words for an oid it will not send. v2 prefixes `upload-pack: `; v0 and v1 do not. A trailing oid
// is separated by a space, so `not our refresh` is a different error. Recognised once, here (#112): callers switch
// on `reason` instead of the message (#76).
const NOT_OUR_REF = 'not our ref';
const UPLOAD_PACK_NOT_OUR_REF = 'upload-pack: not our ref';
function notOurRefReason(text: string): { readonly reason: 'not_our_ref' } | undefined {
  const bare = text === NOT_OUR_REF || text.startsWith(`${NOT_OUR_REF} `);
  const prefixed = text === UPLOAD_PACK_NOT_OUR_REF || text.startsWith(`${UPLOAD_PACK_NOT_OUR_REF} `);
  if (bare || prefixed) return { reason: 'not_our_ref' };
  return undefined;
}

// A commit want whose object is a tree, blob, or tag is not_found, before pack_corrupt is built. Any other mismatch
// (a blob want, a delta, an unknown type id) stays the caller's pack_corrupt.
function refuseNonCommit(expectType: number | null, type: number, oid: string): void {
  if (expectType !== TYPE.COMMIT) return;
  const name = nonCommitType(type);
  if (name === null) return;
  throw fail('not_found', `${oid} is not a commit`, { miss: { kind: 'not_commit', oid, type: name } });
}

export const v2Init = (limits: Limits = DEFAULT_LIMITS): V2State => Object.freeze({ limits,
  phase: 'sections', section: null, sections: [], shallow: [], unshallow: [], acks: [], ready: false,
  band1: 0, band2: 0, band3: 0, band2Frames: 0, progress: '', progressCarry: new Uint8Array(0), error: null, done: false, packFrames: 0,
});
// @decoder v2Step prefix=v2
// oxlint-disable-next-line complexity -- a step function is one transition table
export function v2Step(st: V2State, frame: Frame): V2Step {
  // Every section line, including ones this client does not interpret, counts against the same cap. A missing
  // maxSectionLines used to make `n >= undefined` false and disable the check.
  const maxLines = requireLimit(st.limits, 'maxSectionLines');
  // The one place every consumer of a fetch response passes: band 1 (the pack) and band 2 (progress) are each held to
  // maxPackBytes here, before the frame is yielded, so fetchSingle, fetchWide, fetchPackOnce, the streamed blob (edit,
  // read, checkout) and any new consumer are bounded without a check of their own. Before, only the buffered consumers
  // counted, and a streamed blob body was accepted until the request timer (~5 GiB at the default 60 s).
  const maxPack = requireLimit(st.limits, 'maxPackBytes');
  if (st.done) throw proto('v2: frame after flush');
  if (frame.kind === 'flush') return { state: { ...st, done: true }, pack: null };
  if (st.phase === 'pack') {
    // A delim or response-end inside the packfile section ends git's sideband demultiplexer (demultiplex_sideband:
    // SIDEBAND_FLUSH), so git reads a pack cut there; neither is a frame upload-pack writes in it. Refused, not skipped.
    if (frame.kind !== 'data') throw proto(`v2: ${frame.kind} inside the packfile section`);
    const band = parseSideband(frame.payload);
    if (band.band === SIDEBAND_PACK) {
      const band1 = st.band1 + band.body.length;
      if (band1 > maxPack) throw limitError('pack bytes', band1, maxPack);
      return { state: { ...st, band1, packFrames: st.packFrames + 1 }, pack: band.body };
    }
    if (band.band === SIDEBAND_PROGRESS) {
      const band2 = st.band2 + band.body.length;
      if (band2 > maxPack) throw limitError('progress bytes', band2, maxPack);
      // decodeChunk: a character cut by a frame boundary is held for the next frame instead of decoding as two U+FFFD
      const d = decodeChunk(st.progressCarry, band.body);
      return { state: { ...st, band2, band2Frames: st.band2Frames + 1, progress: (st.progress + d.text).slice(-PROGRESS_KEEP), progressCarry: d.carry }, pack: null };
    }
    if (band.band === SIDEBAND_ERROR) {
      const text = td.decode(band.body).trim();
      throw fail('remote_error', `remote: ${text}`, notOurRefReason(text));
    }
    throw proto(`v2: bad sideband ${band.band}`);
  }
  // A response-end outside the packfile section is skipped. (Checked here, after the packfile branch, rather than
  // before it as `end && phase !== 'pack'`: the same frames take the same path, and the compiler sees a data frame below.)
  if (frame.kind === 'end') return { state: st, pack: null };
  if (frame.kind === 'delim') return { state: { ...st, section: null }, pack: null };
  const line = td.decode(frame.payload).replace(/\n$/, '');
  if (line.startsWith('ERR ')) {
    const text = line.slice('ERR '.length);
    throw fail('remote_error', `remote: ${text}`, notOurRefReason(text));
  }
  if (st.section === null) {
    if (st.sections.length >= maxLines) throw limitError('section headers', st.sections.length + 1, maxLines);
    const next: { -readonly [K in keyof V2State]: V2State[K] } = { ...st, section: line, sections: [...st.sections, line] };
    if (line === 'packfile') next.phase = 'pack';
    return { state: next, pack: null };
  }
  if (st.section === 'shallow-info') {
    if ((st.sectionLines ?? 0) >= maxLines) throw limitError('shallow-info lines', (st.sectionLines ?? 0) + 1, maxLines);
    const s = { ...st, sectionLines: (st.sectionLines ?? 0) + 1 };
    // the server may repeat a shallow line when a commit is wanted both directly and through a tag; keep them unique
    if (line.startsWith('shallow ')) return { state: { ...s, shallow: s.shallow.includes(line.slice('shallow '.length)) ? s.shallow : [...s.shallow, line.slice('shallow '.length)] }, pack: null };
    if (line.startsWith('unshallow ')) return { state: { ...s, unshallow: s.unshallow.includes(line.slice('unshallow '.length)) ? s.unshallow : [...s.unshallow, line.slice('unshallow '.length)] }, pack: null };
    return { state: s, pack: null };
  }
  if (st.section === 'acknowledgments') {
    if (st.acks.length >= maxLines) throw limitError('acknowledgment lines', st.acks.length + 1, maxLines);
    if (line === 'ready') return { state: { ...st, ready: true }, pack: null };
    return { state: { ...st, acks: [...st.acks, line] }, pack: null };
  }
  if ((st.otherLines ?? 0) >= maxLines) throw limitError('section lines', (st.otherLines ?? 0) + 1, maxLines);
  return { state: { ...st, otherLines: (st.otherLines ?? 0) + 1 }, pack: null };
}
export const v2Attrs = (st: V2State): Attrs => ({
  'git.fetch.sections': st.sections.join(','), 'git.fetch.shallow': st.shallow, 'git.fetch.unshallow': st.unshallow,
  'git.fetch.acks': st.acks, 'git.fetch.ready': st.ready,
  'git.sideband.band1.bytes': st.band1, 'git.sideband.band2.bytes': st.band2, 'git.sideband.band2.frames': st.band2Frames,
  'git.sideband.band3.bytes': st.band3, 'git.sideband.pack.frames': st.packFrames, 'git.sideband.progress.tail': st.progress.slice(-PROGRESS_ATTR),
});
export const fetchAttrs = (opts: FetchOpts): Attrs => ({
  'git.command': 'fetch', 'git.protocol.version': PROTOCOL_V2, 'git.fetch.wants': opts.wants, 'git.fetch.wants.count': opts.wants.length,
  'git.fetch.haves.count': (opts.haves ?? []).length, 'git.fetch.filter': opts.filter ?? '', 'git.fetch.deepen': opts.deepen ?? 0, 'git.fetch.deepen_since': opts.deepenSince ?? 0, 'git.fetch.deepen_not': opts.deepenNot ?? [], 'git.fetch.shallows.count': (opts.shallows ?? []).length, 'git.fetch.done': opts.done !== false,
  'git.fetch.thin_pack': Boolean(opts.thinPack), 'git.fetch.ofs_delta': opts.ofsDelta !== false, 'git.fetch.no_progress': opts.noProgress !== false,
});

// Band-1 pack bytes as they arrive; the v2 state is the generator's return value.
export type PackFetch = AsyncGenerator<Uint8Array, V2State, undefined>;
// Stream band-1 pack bytes. Consumer drives it; the v2 state is the generator's return value.
export async function* packStream(t: Transport, opts: FetchOpts, span: Span): PackFetch {
  span.set(fetchAttrs(opts));
  let st = v2Init(t.limits);
  // A caller's own span (GitHttp.packStream) may not carry t.scrub: band-3/ERR text is redacted here too.
  try { for await (const f of frames(t, 'git-upload-pack', fetchBody(opts), span, { bypassCache: Boolean(opts.bypassCache) })) {
    const r = v2Step(st, f);
    st = r.state;
    if (r.pack) yield r.pack;
  } } catch (e) { throw scrubError(e, t.scrub); }
  if (!st.done) throw proto('v2: response ended without flush');
  if (st.phase !== 'pack' && !st.sections.includes('acknowledgments')) throw proto(`v2: no packfile section (sections: ${st.sections.join(',') || 'none'})`);
  span.set(v2Attrs(st));
  return st;
}

// ---- single-object pack stream parser (pure step) ----
// Emits the zlib bytes of the single object, withholding the trailing 20-byte trailer, verifying it at finish.
// A bounded read that ran past the buffer (`reason: 'short_read'`, bytes.ts). spStep waits for more bytes on this reason,
// never on the message (#76). A finished header readObjHeader refuses (a varint past 64 bits) is that error, rethrown.
export const isShortRead = (e: unknown): boolean => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a thrown value, read loosely (transport.ts Loose)
  const loose = e as Loose & { readonly reason?: unknown };
  return loose?.code === 'pack_corrupt' && loose?.reason === 'short_read';
};

// The single-object parser's state: the pack header and the object header (`header`), then the zlib body with the
// trailer withheld (`body`); `trailer` once spFinish has checked it.
type SpCommon = { readonly head: Uint8Array; readonly lag: Uint8Array; readonly sha: Sha1; readonly bytes: number; readonly zlibBytes: number; readonly trailer?: string };
export type SpState = SpCommon & ({ readonly phase: 'header'; readonly type: number; readonly size: number } | { readonly phase: 'body'; readonly type: number; readonly size: number; readonly headerBytes: number });
export type SpFinished = Extract<SpState, { readonly phase: 'body' }> & { readonly trailer: string };

export const spInit = (): SpState => Object.freeze({ head: new Uint8Array(0), phase: 'header', type: 0, size: 0, lag: new Uint8Array(0), sha: new Sha1(), bytes: 0, zlibBytes: 0 });
// @decoder spStep prefix=sp-header
export function spStep(st: SpState, chunk: Uint8Array): { readonly state: SpState; readonly zlib: Uint8Array[] } {
  let s: SpState = { ...st, bytes: st.bytes + chunk.length };
  let data = chunk;
  if (s.phase === 'header') {
    // The header phase is bounded here, for every caller: readObjHeader refuses an object header past 10 bytes
    // (VARINT_MAX_SHIFT), so `head` never holds more than PACK_HEADER_BYTES + 9 bytes between chunks and the 22nd
    // byte of a pack whose object header never ends is `pack_corrupt` (#13: endless 0x80 used to grow `head` without bound).
    const head = concat([s.head, chunk]);
    // need the pack header plus the first object-header byte; a short read means the chunk has not arrived. Past this
    // check the header fields are views into `head`, not bounded reads: they cannot be short.
    if (head.length < PACK_HEADER_BYTES + 1) return { state: { ...s, head }, zlib: [] };
    if (!head.subarray(0, PACK_SIGNATURE.length).every((b, i) => b === PACK_SIGNATURE[i])) throw fail('pack_corrupt', 'pack: bad signature');
    if (readUint32BE(head, PACK_SIGNATURE.length) !== PACK_VERSION) throw fail('pack_corrupt', 'pack: bad version');
    const count = readUint32BE(head, PACK_SIGNATURE.length + UINT32_BYTES);
    if (count !== 1) throw fail('pack_corrupt', `pack: expected 1 object, got ${count}`);
    let header;
    try { header = readObjHeader(head, PACK_HEADER_BYTES); }
    catch (e) { if (isShortRead(e)) return { state: { ...s, head }, zlib: [] }; throw e; }
    if (header.type === TYPE.OFS_DELTA || header.type === TYPE.REF_DELTA) throw fail('pack_corrupt', 'pack: single-object pack is a delta');
    const p: number = header.next;
    s = { ...s, phase: 'body', type: header.type, size: header.size, head: new Uint8Array(0), headerBytes: p };
    s.sha.update(head.subarray(0, p));
    data = head.subarray(p);
  }
  // body: pass through with the trailer withheld
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent: concat([empty lag, data]) is a copy of data, byte for byte
  const all = s.lag.length > 0 ? concat([s.lag, data]) : data;
  const emitLen = Math.max(0, all.length - PACK_TRAILER_BYTES);
  const emit = all.subarray(0, emitLen);
  const lag = all.slice(emitLen);
  // The zlib bytes of an object declared `size` may not run past zlibBound(size) (format.js). The declared-size check on
  // inflated bytes cannot see a stream that inflates to nothing (non-final empty stored blocks, 5 bytes in, 0 out), which
  // used to be accepted until the request timer; this refuses it on the chunk that crosses the bound, so a 10-byte blob
  // costs at most 26 zlib bytes plus the rest of that chunk, whatever maxPackBytes is. The message carries no count: the
  // same bytes in any chunking give the same error (I10).
  const zlibBytes = s.zlibBytes + emitLen;
  const bound = zlibBound(s.size);
  if (zlibBytes > bound) throw fail('pack_corrupt', `pack: zlib stream longer than its declared size allows (${s.size}-byte object, ${bound}-byte bound)`, { got: zlibBytes, max: bound, size: s.size } as Extra);
  // Stryker disable next-line ConditionalExpression: hashing an empty emit leaves the trailer digest unchanged
  if (emitLen) s.sha.update(emit);
  return { state: { ...s, lag, zlibBytes }, zlib: emitLen ? [emit] : [] };
}
export function spFinish(st: SpState): SpFinished {
  if (st.phase !== 'body') throw fail('pack_corrupt', 'pack: truncated before object header');
  if (st.lag.length !== PACK_TRAILER_BYTES) throw fail('pack_corrupt', 'pack: missing trailer');
  const got = st.sha.hex(), want = toHex(st.lag);
  if (want !== got) throw fail('pack_corrupt', `pack: trailer ${want} != ${got}`);
  return { ...st, trailer: want };
}
export const spAttrs = (st: SpState, prefix = 'git.pack'): Attrs => ({ [`${prefix}.objects`]: 1, [`${prefix}.bytes`]: st.bytes, [`${prefix}.trailer`]: st.trailer ?? '', [`${prefix}.compressed.bytes`]: st.zlibBytes, [`${prefix}.type.${(TYPE_NAME as Names)[st.type] ?? st.type}`]: 1 });

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
// oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/no-base-to-string -- see Loose
export const isFilterRejection = (e: unknown): boolean => (['http', 'remote_error', 'protocol'] as readonly unknown[]).includes((e as Loose)?.code) && /only blob:none is supported|unsupported (git )?fetch filter|filter .* not (supported|allowed)/i.test(String((e as Loose)?.message ?? ''));

// Check a wide (blob:none) pack's commits, trees and tags before any of it is returned or harvested (#18, #46).
// `wanted(oid, o)` names what a tree:0 server would have sent — what the caller asked for. Those pass assertFetched
// under the caller's limits exactly as a single-object fetch would, and any failure is the fetch's. The rest are extras
// only the widening brought, and the two ways one can fail are treated differently:
//   - limit_exceeded (say a sibling directory with more than maxTreeEntries entries): the extra is dropped from the
//     pack, so it is neither returned nor harvested, and counted. A limit is the caller's bound on what it will parse for
//     what it reads; an honest repository can hold a tree past it that the caller never reads, and a tree:0 server would
//     never have sent it. Failing on it made the answer depend on the server's filter support (#46: one 2,135-entry
//     directory failed every read of curl on Artifacts). Dropping it is safe: the caller never sees it, and a later
//     want of it is a fetch of its own that applies the limits to it as the wanted object. Whether its bytes past the
//     limit are well formed is unobservable, since checking them would mean parsing past the limit.
//   - pack_corrupt (malformed; git fsck would refuse it): the fetch fails, as #18 decided. This server sent bytes no
//     honest git server holds, hash-verified or not, so nothing from this response is trusted, including its other
//     objects; pack_corrupt is retryable (and a cached response is refetched once past the cache).
// maxPackBytes, maxPackObjects and maxInflatedTotal have already bounded the whole pack. Returns the skipped extras.
export type Skipped = { readonly oid: string; readonly what: unknown; readonly bytes: number };
export function checkWide(objects: Map<string, PackObject>, wanted: (oid: string, o: PackObject) => boolean, limits: Limits): Skipped[] {
  const skipped: Skipped[] = [];
  for (const [oid, o] of objects) {
    if (o.type !== TYPE.COMMIT && o.type !== TYPE.TREE && o.type !== TYPE.TAG) continue;
    try { assertFetched(String((TYPE_NAME as Names)[o.type]), o.data, limits); } catch (e) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see Loose
      if ((e as Loose)?.code !== 'limit_exceeded' || wanted(oid, o)) throw e;
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a limit_exceeded error carries `what` (limits.ts)
      skipped.push({ oid, what: (e as { what: unknown }).what, bytes: o.data.length });
    }
  }
  for (const s of skipped) objects.delete(s.oid);
  return skipped;
}
export const skippedAttrs = (skipped: readonly Skipped[]): Attrs => ({ 'git.fetch.wide.skipped': skipped.length, 'git.fetch.wide.skipped_reason': [...new Set(skipped.map(s => s.what))].join(',') });

// Keep commits and trees from a wide pack for later tree:0 wants. Every entry's key is its computed hash (resolvePack);
// every caller has run checkWide over the pack first (what is left passed assertFetched under the transport's limits),
// since fetchObject serves the harvest without another look.
export function harvest(t: Transport, objects: ReadonlyMap<string, PackObject>, skip: string | null = null): { readonly kept: number; readonly bytes: number } {
  const store = t.objects; if (!store) return { kept: 0, bytes: 0 };
  let bytes = 0, kept = 0; store.bytes ??= 0;
  for (const [oid, o] of objects) {
    if (oid === skip || store.has(oid) || (o.type !== TYPE.COMMIT && o.type !== TYPE.TREE)) continue;
    if (store.bytes + o.data.length > requireLimit(t.limits, 'maxHarvestBytes')) break;
    store.set(oid, { type: o.type, data: o.data }); store.bytes += o.data.length; kept++; bytes += o.data.length;
  }
  return { kept, bytes };
}

// One object wanted by oid. `expectType` (a TYPE id) is checked against what arrives; null takes any type.
export type ObjectWant = { readonly oid: string; readonly filter?: string; readonly deepen?: number | undefined; readonly expectType?: number | null };
export type FetchedObject = {
  readonly type: number; readonly data: Uint8Array; readonly oid: string; readonly size: number; readonly bust: boolean;
  readonly harvested?: true; readonly wide?: true;
};

type Single = { readonly oid: string; readonly filter: string; readonly deepen: number | undefined; readonly expectType: number | null };
// The object count in a pack header, or null when the header is not a version-2 pack (the single-object parser then
// reports its own error). A commit want may be a tag plus the commit it peels to: more than one object, and still the
// wanted object's type.
function declaredPackCount(pack: Uint8Array): number | null {
  if (pack.length < PACK_HEADER_BYTES) return null;
  if (!pack.subarray(0, PACK_SIGNATURE.length).every((b, i) => b === PACK_SIGNATURE[i])) return null;
  if (readUint32BE(pack, PACK_SIGNATURE.length) !== PACK_VERSION) return null;
  return readUint32BE(pack, PACK_SIGNATURE.length + UINT32_BYTES);
}
// A multi-object answer to a commit want: the wanted object, once its type is a commit. A tree, blob, or tag throws
// not_found from refuseNonCommit. Null means the single-object parser should read the bytes (one object, a short
// header, or a pack that does not hold the want).
function commitFromPack(t: Transport, oid: string, pack: Uint8Array, span: Span, bust: boolean): FetchedObject | null {
  const count = declaredPackCount(pack);
  if (count === null || count === 1) return null;
  const objects: Map<string, PackObject> = resolvePack(parsePack(pack, packParseOpts(t.limits)), undefined, t.limits).objects;
  const want = objects.get(oid);
  if (!want) return null;
  span.set({ 'git.pack.objects': count, 'git.object.oid': oid, 'git.object.type': String((TYPE_NAME as Names)[want.type]) });
  refuseNonCommit(TYPE.COMMIT, want.type, oid);
  if (want.type !== TYPE.COMMIT) return null;
  assertFetched('commit', want.data, t.limits);
  return { type: want.type, data: want.data, oid, size: want.data.length, bust };
}
async function fetchSingle(t: Transport, { oid, filter, deepen, expectType }: Single): Promise<FetchedObject> {
  // The span is where the transport says whether the response came from a cache; a verification failure after a HIT is
  // retried once past the cache (packcache.js), a corrupt live response is not.
  // oxlint-disable-next-line typescript/promise-function-async -- coded() and the span are the promise; an async wrapper adds bytes, not behaviour
  const once = (bust: boolean): Promise<FetchedObject> => coded('pack_corrupt', () => t.tracer.span('git.upload-pack fetch', clientSpan(t, { 'git.pack.cache.bust': bust }), async (span: Span): Promise<FetchedObject> => {
    try {
      const maxObject = requireLimit(t.limits, 'maxObjectSize');
      // Pack bytes are held to maxPackBytes by v2Step (inside packStream) before a chunk reaches here; the zlib bytes held
      // are bounded by spStep at zlibBound(sp.size), and sp.size by maxObjectSize as soon as the header is read.
      let sp = spInit(); const zlibParts: Uint8Array[] = [];
      // One size check, in `once`: a nested function that threw would rename this decision (the #2 claims-owed hole).
      const feed = (chunk: Uint8Array): void => {
        const r = spStep(sp, chunk); sp = r.state;
        for (const z of r.zlib) zlibParts.push(z);
      };
      const wire = packStream(t, { wants: [oid], filter, deepen, bypassCache: bust }, span);
      let oversized = false;
      // A commit id may arrive as the tag object plus the commit it peels to. The single-object parser refuses that
      // count; the wanted object's type is still the not_commit answer. Other wants stay a stream, and stop at the
      // declared size before the rest of the pack is read.
      if (expectType === TYPE.COMMIT) {
        const parts: Uint8Array[] = [];
        for await (const chunk of wire) parts.push(chunk);
        const pack = concat(parts);
        const found = commitFromPack(t, oid, pack, span, bust);
        if (found) return found;
        feed(pack);
        oversized = sp.phase === 'body' && sp.size > maxObject;
      } else {
        for await (const chunk of wire) {
          feed(chunk);
          oversized = sp.phase === 'body' && sp.size > maxObject;
          if (oversized) break;
        }
      }
      if (oversized) throw limitError('object size', sp.size, maxObject);
      sp = spFinish(sp);
      const zlib = concat(zlibParts);
      const { out, consumed, stats } = inflate(zlib, 0, { expectedSize: sp.size, maxOutput: maxObject });
      if (consumed !== zlib.length) throw fail('pack_corrupt', `pack: ${zlib.length - consumed} trailing bytes after object`);
      const got = hashObject(String((TYPE_NAME as Names)[sp.type]), out);
      span.set({ ...spAttrs(sp), 'git.pack.inflated.bytes': out.length, 'git.pack.inflate.blocks': stats.blocks, 'git.pack.inflate.stored': stats.stored, 'git.pack.inflate.fixed': stats.fixed, 'git.pack.inflate.dynamic': stats.dynamic, 'git.object.oid': got, 'git.object.type': String((TYPE_NAME as Names)[sp.type]) });
      if (got !== oid) throw fail('pack_corrupt', `object ${got} served for want ${oid}`);
      assertFetched(String((TYPE_NAME as Names)[sp.type]), out, t.limits);
      refuseNonCommit(expectType, sp.type, oid);
      if (expectType !== null && sp.type !== expectType) throw fail('pack_corrupt', `expected ${(TYPE_NAME as Names)[expectType]}, got ${String((TYPE_NAME as Names)[sp.type])}`);
      return { type: sp.type, data: out, oid, size: out.length, bust };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- any thrown object carries the cache status (fetchPack reads it back)
    } catch (e) { if (Boolean(e) && typeof e === 'object') (e as { cacheStatus?: unknown }).cacheStatus = span.attrs['git.response.cache'] ?? ''; throw e; }
  }));
  try { return await once(false); } catch (e) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see Loose
    if ((e as Loose)?.code !== 'pack_corrupt' || (e as { cacheStatus?: unknown } | null | undefined)?.cacheStatus !== 'HIT') throw e;
    return once(true);
  }
}

// The blob:none form of a tree:0 single-object fetch (see fetchObject). Bounded by limits.maxPackBytes (v2Step).
type Wide = { readonly oid: string; readonly deepen: number | undefined; readonly expectType: number | null; readonly learned?: boolean };
async function fetchWide(t: Transport, { oid, deepen, expectType, learned = false }: Wide): Promise<FetchedObject> {
  // oxlint-disable-next-line typescript/promise-function-async -- coded() and the span are the promise; an async wrapper adds bytes, not behaviour
  const once = (bust: boolean): Promise<FetchedObject> => coded('pack_corrupt', () => t.tracer.span('git.upload-pack fetch', clientSpan(t, { 'git.pack.cache.bust': bust, 'git.fetch.filter.fallback': 'blob:none', 'git.fetch.filter.requested': 'tree:0', 'git.fetch.filter.learned': learned }), async (span: Span): Promise<FetchedObject> => {
    try {
      const maxObject = requireLimit(t.limits, 'maxObjectSize');
      const parts: Uint8Array[] = []; let total = 0;
      for await (const chunk of packStream(t, { wants: [oid], filter: 'blob:none', deepen, bypassCache: bust }, span)) { total += chunk.length; parts.push(chunk); }
      const parsed = parsePack(concat(parts), packParseOpts(t.limits));
      const objects: Map<string, PackObject> = resolvePack(parsed, undefined, t.limits).objects;
      const skipped = checkWide(objects, k => k === oid, t.limits);
      const want = objects.get(oid);
      if (!want) throw fail('pack_corrupt', `object ${oid} not in the blob:none pack (${objects.size} objects)`);
      if (want.data.length > maxObject) throw limitError('object size', want.data.length, maxObject);
      refuseNonCommit(expectType, want.type, oid);
      if (expectType !== null && want.type !== expectType) throw fail('pack_corrupt', `expected ${(TYPE_NAME as Names)[expectType]}, got ${(TYPE_NAME as Names)[want.type]}`);
      let blobs = 0, extraBytes = skipped.reduce((n, x) => n + x.bytes, 0); for (const [k, o] of objects) { if (k !== oid) extraBytes += o.data.length; if (o.type === TYPE.BLOB) blobs++; }
      const h = harvest(t, objects, oid);
      span.set({ 'git.pack.objects': parsed.stats.count, 'git.pack.bytes': total, 'git.object.oid': oid, 'git.object.type': (TYPE_NAME as Names)[want.type], 'git.fetch.wide.objects': objects.size + skipped.length, 'git.fetch.wide.extra_objects': objects.size + skipped.length - 1, 'git.fetch.wide.extra_bytes': extraBytes, 'git.fetch.wide.blobs': blobs, 'git.fetch.wide.harvested': h.kept, 'git.fetch.wide.harvested_bytes': h.bytes, ...skippedAttrs(skipped) });
      return { type: want.type, data: want.data, oid, size: want.data.length, bust, wide: true };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- any thrown object carries the cache status (fetchPack reads it back)
    } catch (e) { if (Boolean(e) && typeof e === 'object') (e as { cacheStatus?: unknown }).cacheStatus = span.attrs['git.response.cache'] ?? ''; throw e; }
  }));
  try { return await once(false); } catch (e) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see Loose
    if ((e as Loose)?.code !== 'pack_corrupt' || (e as { cacheStatus?: unknown } | null | undefined)?.cacheStatus !== 'HIT') throw e;
    return once(true);
  }
}

export async function fetchObject(t: Transport, { oid, filter = 'tree:0', deepen, expectType = null }: ObjectWant): Promise<FetchedObject> {
  // A JS caller may pass anything for the oid: it is checked, and quoted as String() renders it.
  // oxlint-disable-next-line typescript/no-unnecessary-condition, typescript/no-unnecessary-type-conversion -- see above
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

