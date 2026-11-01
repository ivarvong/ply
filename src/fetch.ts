// v2 fetch: request body (pure), response state machine (pure step), the streamed band-1 pack, and fetchObject — one
// object by oid through the single-object pack parser, hash-verified. The buffered multi-object fetch with delta
// resolution lives in fetchpack.js so this module never pulls the resolver into a bundle.
// The step functions and checks return Result (`…Result`); the names callers already use (v2Step, spStep, spFinish,
// parseSideband, fetchBody) are their throwing forms. packStream and fetchObject are the I/O edge: their errors are thrown.
/* oxlint-disable require-unicode-regexp -- ASCII wire text; `u` costs a byte per literal and changes what /i matches (U+017F, U+212A) */
import type { ErrorOf, Extra, PlyError } from './errors.js';
import type { Limits } from './limits.js';
import type { Span } from './otel.js';
import type { Input } from './absent.js';
import type { Result } from './result.js';
import type { Attrs, Frame, Transport } from './transport.js';
import { fail, orThrow, scrubError } from './errors.js';
import { pkts } from './pktline.js';
import { td, concat, takeResult, decodeChunk } from './bytes.js';
import { Sha1, toHex } from './sha1.js';
import { TYPE, TYPE_NAME, hashObject, assertFetched, nonCommitType } from './objects.js';
// oxlint-disable-next-line import/max-dependencies -- the fetch path's parsers each live in their own module (pack, inflate, objects, sha1, cache)
import { corruptCacheHit } from './cachestatus.js';
import { assertNever, err, getOrElse, none, ok } from './result.js';
import { inflateResult } from './inflate.js';
import { parsePackResult, resolvePackResult, readObjHeaderResult, readUint32BEResult, packParseOpts } from './packresolve.js';
import { atOr, field, fromNullish, mapGet, withDefaults } from './absent.js';
import { PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, PACK_TRAILER_BYTES, UINT32_BYTES, SIDEBAND_PACK, SIDEBAND_PROGRESS, SIDEBAND_ERROR, SIDEBAND_CHANNEL_BYTES, OID_HEX_CHARS, PROTOCOL_V2, zlibBound } from './format.js';
import { DEFAULT_LIMITS, limitExceeded, readLimit } from './limits.js';
import { validateWire } from './validate.js';
import { frames, coded, clientSpan, proto, harvestBytes } from './transport.js';
import { thrownCodeIs, thrownReasonIs, thrownCode, thrownMessage } from './boundary.js';

/* oxlint-disable no-magic-numbers -- span tails are diagnostics, not wire-format facts */
const PROGRESS_KEEP = 512;
const PROGRESS_ATTR = 200;
const OID_PREVIEW = 48;
/* oxlint-enable no-magic-numbers */

// TYPE_NAME read by a type id that is a number on the wire, as String() renders the lookup (objects.js keys it by the
// ids it knows; an id it does not know renders as the platform's missing value did).
const typeText = (type: number): string => String(Reflect.get(TYPE_NAME, type));
// A git object as the pack parser and resolver hand it over (and as the harvest holds it).
export type PackObject = { readonly type: number; readonly data: Uint8Array };

// ---- request body (pure) ----
type BadRequest = ErrorOf<'bad_request'>;
const UNIT: Result<null, never> = ok(null);
// validateWire (validate.ts) throws until its cluster converts.
const wireField = (value: string, what: string): unknown => validateWire(value, what);
const countField = (value: number, what: string): Result<null, BadRequest> => {
  if (!Number.isSafeInteger(value) || value < 0) return fail('bad_request', `invalid ${what}: must be a non-negative safe integer`, { what });
  return UNIT;
};
// deepen-since is a unix timestamp on the wire (a number from callers, or a digit string). Either way it is one token.
const sinceField = (value: number | string, what: string): Result<null, BadRequest> => {
  if (typeof value === 'number') return countField(value, what);
  wireField(value, what);
  return UNIT;
};

// The arguments of one v2 fetch command. An empty filter, a zero deepen and a zero deepen-since are absent.
export type FetchConfig = {
  readonly haves: readonly string[];
  readonly filter: string;
  readonly deepen: number;
  readonly deepenSince: number | string;
  readonly deepenNot: readonly string[];
  readonly deepenRelative: boolean;
  readonly thinPack: boolean;
  readonly ofsDelta: boolean;
  readonly includeTag: boolean;
  readonly noProgress: boolean;
  readonly done: boolean;
  readonly shallows: readonly string[];
  readonly bypassCache: boolean;
};
export type FetchOpts = { readonly wants: readonly string[] } & Input<FetchConfig>;
const fetchDefaults = (): FetchConfig => ({
  haves: [], filter: '', deepen: 0, deepenSince: 0, deepenNot: [], deepenRelative: false, thinPack: false, ofsDelta: true,
  includeTag: false, noProgress: true, done: true, shallows: [], bypassCache: false,
});

// oxlint-disable-next-line complexity -- one optional line per fetch argument
export function fetchBodyResult(opts: FetchOpts): Result<Uint8Array<ArrayBuffer>, BadRequest> {
  const { haves, filter, deepen, deepenSince, deepenNot, deepenRelative, thinPack, ofsDelta, includeTag, noProgress, done, shallows } = withDefaults(opts, fetchDefaults());
  const { wants } = opts;
  for (const w of wants) wireField(w, 'want');
  for (const h of haves) wireField(h, 'have');
  for (const s of shallows) wireField(s, 'shallow');
  for (const r of deepenNot) wireField(r, 'deepen-not');
  if (filter) wireField(filter, 'filter');
  if (deepen) { const c = countField(deepen, 'deepen'); if (!c.ok) return c; }
  // oxlint-disable-next-line typescript/strict-boolean-expressions -- 0, '' and NaN mean no deepen-since, as they always have
  if (deepenSince) { const c = sinceField(deepenSince, 'deepen-since'); if (!c.ok) return c; }
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
  return ok(pkts(['command=fetch\n', ...args], { delimAfter: 0 }));
}
export const fetchBody = (opts: FetchOpts): Uint8Array<ArrayBuffer> => orThrow(fetchBodyResult(opts));

// ---- v2 fetch response state machine (pure step over frames) ----
// One sideband frame: the band byte and its payload.
export type Sideband = { readonly band: number; readonly body: Uint8Array };
// @decoder parseSidebandResult prefix=sideband
export function parseSidebandResult(payload: Uint8Array): Result<Sideband, ErrorOf<'protocol'>> {
  // an empty payload (0004) has no band byte: git's demultiplex_sideband "missing sideband designator"
  // takeResult returns exactly SIDEBAND_CHANNEL_BYTES bytes or the short read, so the fallback never applies
  const head = takeResult(payload, 0, SIDEBAND_CHANNEL_BYTES, 'protocol');
  if (!head.ok) return head;
  const band: number = atOr(head.value, 0, 0);
  const body = payload.subarray(SIDEBAND_CHANNEL_BYTES);
  return ok({ band, body });
}
// @decoder parseSideband prefix=sideband
export const parseSideband = (payload: Uint8Array): Sideband => orThrow(parseSidebandResult(payload));

// The response's two phases: section lines up to `packfile`, then sideband frames. `section` is the open section
// (null between a delim and the next header); its line count is `sectionLines` (shallow-info) or `otherLines` (a
// section ply does not read). `done` is the flush that ends the response, in either phase.
export type V2Phase = 'sections' | 'pack';
export type V2State = {
  readonly limits: Limits;
  readonly phase: V2Phase;
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
  readonly sectionLines: number;
  readonly otherLines: number;
};
export type V2Step = { readonly state: V2State; readonly pack: Uint8Array | null };

// upload-pack's own words for an oid it will not send. v2 prefixes `upload-pack: `; v0 and v1 do not. A trailing oid
// is separated by a space, so `not our refresh` is a different error. Recognised once, here (#112): callers switch
// on `reason` instead of the message (#76). Any other text carries no reason (an empty extra adds no field).
const NOT_OUR_REF = 'not our ref';
const UPLOAD_PACK_NOT_OUR_REF = 'upload-pack: not our ref';
function notOurRefReason(text: string): Extra {
  const bare = text === NOT_OUR_REF || text.startsWith(`${NOT_OUR_REF} `);
  const prefixed = text === UPLOAD_PACK_NOT_OUR_REF || text.startsWith(`${UPLOAD_PACK_NOT_OUR_REF} `);
  if (bare || prefixed) return { reason: 'not_our_ref' };
  return {};
}

// A commit want whose object is a tree, blob, or tag is not_found, before pack_corrupt is built. Any other mismatch
// (a blob want, a delta, an unknown type id) stays the caller's pack_corrupt.
function refuseNonCommit(expectType: number | null, type: number, oid: string): Result<null, ErrorOf<'not_found'>> {
  if (expectType !== TYPE.COMMIT) return UNIT;
  const found = nonCommitType(type);
  switch (found.tag) {
    case 'commit':
    case 'delta':
    case 'invalid':
      return UNIT;
    case 'notCommit':
      return fail('not_found', `${oid} is not a commit`, { miss: { kind: 'commit', miss: { kind: 'not_commit', oid, type: found.name } } });
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(found);
}

export const v2Init = (limits: Limits = DEFAULT_LIMITS): V2State => Object.freeze({ limits,
  phase: 'sections', section: null, sections: [], shallow: [], unshallow: [], acks: [], ready: false,
  band1: 0, band2: 0, band3: 0, band2Frames: 0, progress: '', progressCarry: new Uint8Array(0), error: null, done: false, packFrames: 0,
  sectionLines: 0, otherLines: 0,
});
const stepped = (state: V2State, pack: Uint8Array | null = null): Result<V2Step, never> => ok({ state, pack });
// @decoder v2StepResult prefix=v2
// oxlint-disable-next-line complexity -- a step function is one transition table
export function v2StepResult(st: V2State, frame: Frame): Result<V2Step, PlyError> {
  // Every section line, including ones this client does not interpret, counts against the same cap. A missing
  // maxSectionLines used to make `n >= <missing>` false and disable the check.
  const linesCap = readLimit(st.limits, 'maxSectionLines');
  if (!linesCap.ok) return linesCap;
  const maxLines = linesCap.value;
  // The one place every consumer of a fetch response passes: band 1 (the pack) and band 2 (progress) are each held to
  // maxPackBytes here, before the frame is yielded, so fetchSingle, fetchWide, fetchPackOnce, the streamed blob (edit,
  // read, checkout) and any new consumer are bounded without a check of their own. Before, only the buffered consumers
  // counted, and a streamed blob body was accepted until the request timer (~5 GiB at the default 60 s).
  const packCap = readLimit(st.limits, 'maxPackBytes');
  if (!packCap.ok) return packCap;
  const maxPack = packCap.value;
  if (st.done) return proto('v2: frame after flush');
  if (frame.kind === 'flush') return stepped({ ...st, done: true });
  switch (st.phase) {
    case 'pack': {
      // A delim or response-end inside the packfile section ends git's sideband demultiplexer (demultiplex_sideband:
      // SIDEBAND_FLUSH), so git reads a pack cut there; neither is a frame upload-pack writes in it. Refused, not skipped.
      if (frame.kind !== 'data') return proto(`v2: ${frame.kind} inside the packfile section`);
      const sb = parseSidebandResult(frame.payload);
      if (!sb.ok) return sb;
      const band = sb.value;
      if (band.band === SIDEBAND_PACK) {
        const band1 = st.band1 + band.body.length;
        if (band1 > maxPack) return err(limitExceeded('pack bytes', band1, maxPack));
        return stepped({ ...st, band1, packFrames: st.packFrames + 1 }, band.body);
      }
      if (band.band === SIDEBAND_PROGRESS) {
        const band2 = st.band2 + band.body.length;
        if (band2 > maxPack) return err(limitExceeded('progress bytes', band2, maxPack));
        // decodeChunk: a character cut by a frame boundary is held for the next frame instead of decoding as two U+FFFD
        const d = decodeChunk(st.progressCarry, band.body);
        return stepped({ ...st, band2, band2Frames: st.band2Frames + 1, progress: (st.progress + d.text).slice(-PROGRESS_KEEP), progressCarry: d.carry });
      }
      if (band.band === SIDEBAND_ERROR) {
        const text = td.decode(band.body).trim();
        return fail('remote_error', `remote: ${text}`, notOurRefReason(text));
      }
      return proto(`v2: bad sideband ${band.band}`);
    }
    case 'sections': {
      // A response-end outside the packfile section is skipped.
      if (frame.kind === 'end') return stepped(st);
      if (frame.kind === 'delim') return stepped({ ...st, section: null });
      const line = td.decode(frame.payload).replace(/\n$/, '');
      if (line.startsWith('ERR ')) {
        const text = line.slice('ERR '.length);
        return fail('remote_error', `remote: ${text}`, notOurRefReason(text));
      }
      if (st.section === null) {
        if (st.sections.length >= maxLines) return err(limitExceeded('section headers', st.sections.length + 1, maxLines));
        const next: { -readonly [K in keyof V2State]: V2State[K] } = { ...st, section: line, sections: [...st.sections, line] };
        if (line === 'packfile') next.phase = 'pack';
        return stepped(next);
      }
      if (st.section === 'shallow-info') {
        if (st.sectionLines >= maxLines) return err(limitExceeded('shallow-info lines', st.sectionLines + 1, maxLines));
        const s = { ...st, sectionLines: st.sectionLines + 1 };
        // the server may repeat a shallow line when a commit is wanted both directly and through a tag; keep them unique
        if (line.startsWith('shallow ')) return stepped({ ...s, shallow: s.shallow.includes(line.slice('shallow '.length)) ? s.shallow : [...s.shallow, line.slice('shallow '.length)] });
        if (line.startsWith('unshallow ')) return stepped({ ...s, unshallow: s.unshallow.includes(line.slice('unshallow '.length)) ? s.unshallow : [...s.unshallow, line.slice('unshallow '.length)] });
        return stepped(s);
      }
      if (st.section === 'acknowledgments') {
        if (st.acks.length >= maxLines) return err(limitExceeded('acknowledgment lines', st.acks.length + 1, maxLines));
        if (line === 'ready') return stepped({ ...st, ready: true });
        return stepped({ ...st, acks: [...st.acks, line] });
      }
      if (st.otherLines >= maxLines) return err(limitExceeded('section lines', st.otherLines + 1, maxLines));
      return stepped({ ...st, otherLines: st.otherLines + 1 });
    }
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(st.phase);
}
// @decoder v2Step prefix=v2
export const v2Step = (st: V2State, frame: Frame): V2Step => orThrow(v2StepResult(st, frame));
// The response is over: it ended with its flush, and it had a packfile section or (negotiation) acknowledgments.
export function v2End(st: V2State): Result<V2State, ErrorOf<'protocol'>> {
  if (!st.done) return proto('v2: response ended without flush');
  if (st.phase !== 'pack' && !st.sections.includes('acknowledgments')) return proto(`v2: no packfile section (sections: ${st.sections.join(',') || 'none'})`);
  return ok(st);
}
export const v2Attrs = (st: V2State): Attrs => ({
  'git.fetch.sections': st.sections.join(','), 'git.fetch.shallow': st.shallow, 'git.fetch.unshallow': st.unshallow,
  'git.fetch.acks': st.acks, 'git.fetch.ready': st.ready,
  'git.sideband.band1.bytes': st.band1, 'git.sideband.band2.bytes': st.band2, 'git.sideband.band2.frames': st.band2Frames,
  'git.sideband.band3.bytes': st.band3, 'git.sideband.pack.frames': st.packFrames, 'git.sideband.progress.tail': st.progress.slice(-PROGRESS_ATTR),
});
// The request's arguments as the caller gave them: a left-out or null argument reads as its default.
export const fetchAttrs = (opts: FetchOpts): Attrs => ({
  'git.command': 'fetch', 'git.protocol.version': PROTOCOL_V2, 'git.fetch.wants': opts.wants, 'git.fetch.wants.count': opts.wants.length,
  'git.fetch.haves.count': getOrElse(fromNullish(opts.haves), []).length, 'git.fetch.filter': getOrElse(fromNullish(opts.filter), ''), 'git.fetch.deepen': getOrElse(fromNullish(opts.deepen), 0),
  'git.fetch.deepen_since': getOrElse<number | string>(fromNullish(opts.deepenSince), 0), 'git.fetch.deepen_not': getOrElse(fromNullish(opts.deepenNot), []), 'git.fetch.shallows.count': getOrElse(fromNullish(opts.shallows), []).length, 'git.fetch.done': opts.done !== false,
  'git.fetch.thin_pack': Boolean(opts.thinPack), 'git.fetch.ofs_delta': opts.ofsDelta !== false, 'git.fetch.no_progress': opts.noProgress !== false,
});

// Band-1 pack bytes as they arrive; the v2 state is the generator's return value.
export type PackFetch = AsyncGenerator<Uint8Array, V2State, unknown>;
// Stream band-1 pack bytes. Consumer drives it; the v2 state is the generator's return value. The stream edge: a
// step's Err is thrown here.
export async function* packStream(t: Transport, opts: FetchOpts, span: Span): PackFetch {
  span.set(fetchAttrs(opts));
  let st = v2Init(t.limits);
  // A caller's own span (GitHttp.packStream) may not carry t.scrub: band-3/ERR text is redacted here too.
  try { for await (const f of frames(t, 'git-upload-pack', fetchBody(opts), span, { bypassCache: Boolean(opts.bypassCache) })) {
    const r = orThrow(v2StepResult(st, f));
    st = r.state;
    if (r.pack) yield r.pack;
  } } catch (e) { throw scrubError(e, t.scrub); }
  const end = orThrow(v2End(st));
  span.set(v2Attrs(end));
  return end;
}

// ---- single-object pack stream parser (pure step) ----
// Emits the zlib bytes of the single object, withholding the trailing 20-byte trailer, verifying it at finish.
// A bounded read that ran past the buffer (`reason: 'short_read'`, bytes.ts). spStep waits for more bytes on this reason,
// never on the message (#76). A finished header readObjHeader refuses (a varint past 64 bits) is that error, returned.
export const isShortRead = (e: unknown): boolean => thrownCodeIs(e, 'pack_corrupt') && thrownReasonIs(e, 'short_read');

// The single-object parser's state: the pack header and the object header (`header`), then the zlib body with the
// trailer withheld (`body`); `trailer` is null until spFinish has checked it, then the trailer it checked.
type SpCommon = { readonly head: Uint8Array; readonly lag: Uint8Array; readonly sha: Sha1; readonly bytes: number; readonly zlibBytes: number; readonly trailer: string | null };
export type SpHeader = SpCommon & { readonly phase: 'header'; readonly type: number; readonly size: number };
export type SpBody = SpCommon & { readonly phase: 'body'; readonly type: number; readonly size: number; readonly headerBytes: number };
export type SpState = SpHeader | SpBody;
export type SpFinished = SpBody & { readonly trailer: string };
export type SpStepped = { readonly state: SpState; readonly zlib: Uint8Array[] };
type Corrupt = ErrorOf<'pack_corrupt'>;

export const spInit = (): SpState => Object.freeze({ head: new Uint8Array(0), phase: 'header', type: 0, size: 0, lag: new Uint8Array(0), sha: new Sha1(), bytes: 0, zlibBytes: 0, trailer: null });
const hasSignature = (head: Uint8Array): boolean => head.subarray(0, PACK_SIGNATURE.length).every((b, i) => b === PACK_SIGNATURE[i]);
// The header phase, given every byte so far (`head`): still waiting (null), or the body state and the bytes after the
// object header. Past the length check the header fields are views into `head`, not bounded reads: they cannot be short.
function spHeader(s: SpHeader, head: Uint8Array): Result<{ readonly body: SpBody; readonly rest: Uint8Array } | null, Corrupt> {
  // need the pack header plus the first object-header byte; a short read means the chunk has not arrived.
  if (head.length < PACK_HEADER_BYTES + 1) return ok(null);
  if (!hasSignature(head)) return fail('pack_corrupt', 'pack: bad signature');
  const version = readUint32BEResult(head, PACK_SIGNATURE.length);
  if (!version.ok) return version;
  if (version.value !== PACK_VERSION) return fail('pack_corrupt', 'pack: bad version');
  const counted = readUint32BEResult(head, PACK_SIGNATURE.length + UINT32_BYTES);
  if (!counted.ok) return counted;
  const count = counted.value;
  if (count !== 1) return fail('pack_corrupt', `pack: expected 1 object, got ${count}`);
  const header = readObjHeaderResult(head, PACK_HEADER_BYTES);
  if (!header.ok) return isShortRead(header.error) ? ok(null) : header;
  if (header.value.type === TYPE.OFS_DELTA || header.value.type === TYPE.REF_DELTA) return fail('pack_corrupt', 'pack: single-object pack is a delta');
  const p: number = header.value.next;
  s.sha.update(head.subarray(0, p));
  return ok({ body: { ...s, phase: 'body', type: header.value.type, size: header.value.size, head: new Uint8Array(0), headerBytes: p }, rest: head.subarray(p) });
}
// Where a chunk lands: still in the header (the state waits for more), or body bytes after the object header.
type SpEntry = { readonly tag: 'wait'; readonly state: SpHeader } | { readonly tag: 'body'; readonly state: SpBody; readonly data: Uint8Array };
function spEnter(st: SpState, chunk: Uint8Array): Result<SpEntry, Corrupt> {
  switch (st.phase) {
    case 'header': {
      // The header phase is bounded here, for every caller: readObjHeader refuses an object header past 10 bytes
      // (VARINT_MAX_SHIFT), so `head` never holds more than PACK_HEADER_BYTES + 9 bytes between chunks and the 22nd
      // byte of a pack whose object header never ends is `pack_corrupt` (#13: endless 0x80 used to grow `head` without bound).
      const head = concat([st.head, chunk]);
      const opened = spHeader(st, head);
      if (!opened.ok) return opened;
      if (opened.value === null) return ok({ tag: 'wait', state: { ...st, head } });
      return ok({ tag: 'body', state: opened.value.body, data: opened.value.rest });
    }
    case 'body':
      return ok({ tag: 'body', state: st, data: chunk });
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(st);
}
// @decoder spStepResult prefix=sp-header
export function spStepResult(st: SpState, chunk: Uint8Array): Result<SpStepped, Corrupt> {
  const entered = spEnter({ ...st, bytes: st.bytes + chunk.length }, chunk);
  if (!entered.ok) return entered;
  const entry = entered.value;
  if (entry.tag === 'wait') return ok({ state: entry.state, zlib: [] });
  const { state: s, data } = entry;
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
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an ad-hoc error field (`size`); Extra has got and max
  if (zlibBytes > bound) return fail('pack_corrupt', `pack: zlib stream longer than its declared size allows (${s.size}-byte object, ${bound}-byte bound)`, { got: zlibBytes, max: bound, size: s.size } as Extra);
  // Stryker disable next-line ConditionalExpression: hashing an empty emit leaves the trailer digest unchanged
  if (emitLen) s.sha.update(emit);
  return ok({ state: { ...s, lag, zlibBytes }, zlib: emitLen ? [emit] : [] });
}
// @decoder spStep prefix=sp-header
export const spStep = (st: SpState, chunk: Uint8Array): SpStepped => orThrow(spStepResult(st, chunk));
export function spFinishResult(st: SpState): Result<SpFinished, Corrupt> {
  if (st.phase !== 'body') return fail('pack_corrupt', 'pack: truncated before object header');
  if (st.lag.length !== PACK_TRAILER_BYTES) return fail('pack_corrupt', 'pack: missing trailer');
  const got = st.sha.hex(), want = toHex(st.lag);
  if (want !== got) return fail('pack_corrupt', `pack: trailer ${want} != ${got}`);
  return ok({ ...st, trailer: want });
}
export const spFinish = (st: SpState): SpFinished => orThrow(spFinishResult(st));
const trailerOf = (st: SpState): string => (st.trailer === null ? '' : st.trailer);
export const spAttrs = (st: SpState, prefix = 'git.pack'): Attrs => ({ [`${prefix}.objects`]: 1, [`${prefix}.bytes`]: st.bytes, [`${prefix}.trailer`]: trailerOf(st), [`${prefix}.compressed.bytes`]: st.zlibBytes, [`${prefix}.type.${typeText(st.type)}`]: 1 });

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
// The phrases a server uses when it refuses a fetch filter. Cloudflare Artifacts (observed 2026-10-23) is HTTP 400
// plus the first one. One regex, shared: ply-web used to keep a copy of it next to the cache.
const FILTER_REFUSAL = /only blob:none is supported|unsupported (git )?fetch filter|filter .* not (supported|allowed)/i;
// oxlint-disable-next-line no-magic-numbers -- RFC 9110 Bad Request: Artifacts' refusal, and the only status this predicate accepts
const FILTER_REFUSAL_STATUS = 400;
// A raw upload-pack answer (the HTTP status and the body, or the text an error quoted from it). Status is part of the
// answer: a 500 that happens to contain the phrase is not a filter refusal.
export const isFilterRefusal = (status: number, text: string): boolean => status === FILTER_REFUSAL_STATUS && FILTER_REFUSAL.test(text);
// A thrown value is not a PlyError until it is: message may be no string, and `status` is only on an http error.
export const isFilterRejection = (e: unknown): boolean => {
  const code = getOrElse(thrownCode(e), null);
  const text = String(getOrElse(thrownMessage(e), ''));
  // remote_error and protocol have no HTTP status. The phrase in the message is the refusal, so the same predicate
  // sees it as the 400 it is when the server says it over HTTP.
  if (code === 'remote_error' || code === 'protocol') return isFilterRefusal(FILTER_REFUSAL_STATUS, text);
  if (code !== 'http') return false;
  if (e === null || typeof e !== 'object' || !Object.hasOwn(e, 'status')) return false;
  const status: unknown = Reflect.get(e, 'status');
  return typeof status === 'number' && isFilterRefusal(status, text);
};

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
// assertFetched (objects.ts) throws until its cluster converts: a failure that is not a skipped extra is rethrown.
export type Skipped = { readonly oid: string; readonly what: unknown; readonly bytes: number };
export function checkWide(objects: Map<string, PackObject>, wanted: (oid: string, o: PackObject) => boolean, limits: Limits): Skipped[] {
  const skipped: Skipped[] = [];
  for (const [oid, o] of objects) {
    if (o.type !== TYPE.COMMIT && o.type !== TYPE.TREE && o.type !== TYPE.TAG) continue;
    try { assertFetched(typeText(o.type), o.data, limits); } catch (e) {
      if (!thrownCodeIs(e, 'limit_exceeded') || wanted(oid, o)) throw e;
      // a limit_exceeded error carries `what` (limits.ts)
      skipped.push({ oid, what: getOrElse(field(e, 'what'), ''), bytes: o.data.length });
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
  const store = t.objects;
  const cap = orThrow(readLimit(t.limits, 'maxHarvestBytes'));
  let bytes = 0, held = harvestBytes(store), kept = 0;
  for (const [oid, o] of objects) {
    if (oid === skip || store.has(oid) || (o.type !== TYPE.COMMIT && o.type !== TYPE.TREE)) continue;
    if (held + o.data.length > cap) break;
    store.set(oid, { type: o.type, data: o.data }); held += o.data.length; kept++; bytes += o.data.length;
  }
  return { kept, bytes };
}

// Any thrown object carries the cache status of the response it came from (fetchPack and the retry read it back).
export function stampCacheStatus(e: unknown, span: Span): void {
  if (e === null || typeof e !== 'object') return;
  Reflect.set(e, 'cacheStatus', getOrElse(fromNullish(span.attrs['git.response.cache']), ''));
}

// One object wanted by oid. `expectType` (a TYPE id) is checked against what arrives; null takes any type.
export type ObjectWantConfig = { readonly filter: string; readonly deepen: number; readonly expectType: number | null };
export type ObjectWant = { readonly oid: string } & Input<ObjectWantConfig>;
const objectWantDefaults = (): ObjectWantConfig => ({ filter: 'tree:0', deepen: 0, expectType: null });
type FetchedBase = { readonly type: number; readonly data: Uint8Array; readonly oid: string; readonly size: number; readonly bust: boolean };
// A fetched object; `harvested` when the transport's harvest answered it, `wide` when a blob:none pack did.
export type FetchedObject = FetchedBase | (FetchedBase & { readonly harvested: true }) | (FetchedBase & { readonly wide: true });

type Single = { readonly oid: string; readonly filter: string; readonly deepen: number; readonly expectType: number | null };
// The object count in a pack header, or null when the header is not a version-2 pack (the single-object parser then
// reports its own error). A commit want may be a tag plus the commit it peels to: more than one object, and still the
// wanted object's type.
function declaredPackCount(pack: Uint8Array): number | null {
  if (pack.length < PACK_HEADER_BYTES) return null;
  if (!hasSignature(pack)) return null;
  const version = readUint32BEResult(pack, PACK_SIGNATURE.length);
  if (!version.ok || version.value !== PACK_VERSION) return null;
  const count = readUint32BEResult(pack, PACK_SIGNATURE.length + UINT32_BYTES);
  return count.ok ? count.value : null;
}
// A multi-object answer to a commit want: the wanted object, once its type is a commit. A tree, blob, or tag is
// not_found from refuseNonCommit. Null means the single-object parser should read the bytes (one object, a short
// header, or a pack that does not hold the want).
function commitFromPack(t: Transport, oid: string, pack: Uint8Array, span: Span, bust: boolean): Result<FetchedObject | null, PlyError> {
  const count = declaredPackCount(pack);
  if (count === null || count === 1) return ok(null);
  const parsed = parsePackResult(pack, packParseOpts(t.limits));
  if (!parsed.ok) return parsed;
  const resolved = resolvePackResult(parsed.value, () => null, t.limits);
  if (!resolved.ok) return resolved;
  const objects: Map<string, PackObject> = resolved.value.objects;
  const found = mapGet(objects, oid);
  if (found.tag === 'none') return ok(null);
  const want = found.value;
  span.set({ 'git.pack.objects': count, 'git.object.oid': oid, 'git.object.type': typeText(want.type) });
  const refused = refuseNonCommit(TYPE.COMMIT, want.type, oid);
  if (!refused.ok) return refused;
  if (want.type !== TYPE.COMMIT) return ok(null);
  assertFetched('commit', want.data, t.limits);
  return ok({ type: want.type, data: want.data, oid, size: want.data.length, bust });
}
// The single object's zlib bytes, read: inflated within maxObject, hashed against the want, its type checked.
type Received = { readonly sp: SpFinished; readonly zlib: Uint8Array; readonly want: Single; readonly span: Span; readonly bust: boolean; readonly maxObject: number };
function singleObject(t: Transport, { sp, zlib, want, span, bust, maxObject }: Received): Result<FetchedObject, PlyError> {
  const { oid, expectType } = want;
  const inflated = inflateResult(zlib, 0, { expectedSize: sp.size, maxOutput: maxObject });
  if (!inflated.ok) return inflated;
  const { out, consumed, stats } = inflated.value;
  if (consumed !== zlib.length) return fail('pack_corrupt', `pack: ${zlib.length - consumed} trailing bytes after object`);
  const got = hashObject(typeText(sp.type), out);
  span.set({ ...spAttrs(sp), 'git.pack.inflated.bytes': out.length, 'git.pack.inflate.blocks': stats.blocks, 'git.pack.inflate.stored': stats.stored, 'git.pack.inflate.fixed': stats.fixed, 'git.pack.inflate.dynamic': stats.dynamic, 'git.object.oid': got, 'git.object.type': typeText(sp.type) });
  if (got !== oid) return fail('pack_corrupt', `object ${got} served for want ${oid}`);
  assertFetched(typeText(sp.type), out, t.limits);
  const refused = refuseNonCommit(expectType, sp.type, oid);
  if (!refused.ok) return refused;
  if (expectType !== null && sp.type !== expectType) return fail('pack_corrupt', `expected ${typeText(expectType)}, got ${typeText(sp.type)}`);
  return ok({ type: sp.type, data: out, oid, size: out.length, bust });
}
async function fetchSingle(t: Transport, want: Single): Promise<FetchedObject> {
  const { oid, filter, deepen, expectType } = want;
  // The span is where the transport says whether the response came from a cache; a verification failure after a HIT is
  // retried once past the cache (packcache.js), a corrupt live response is not.
  // oxlint-disable-next-line typescript/promise-function-async -- coded() and the span are the promise; an async wrapper adds bytes, not behaviour
  const once = (bust: boolean): Promise<FetchedObject> => coded('pack_corrupt', () => t.tracer.span('git.upload-pack fetch', clientSpan(t, { 'git.pack.cache.bust': bust }), async (span: Span): Promise<FetchedObject> => {
    try {
      const maxObject = orThrow(readLimit(t.limits, 'maxObjectSize'));
      // Pack bytes are held to maxPackBytes by v2Step (inside packStream) before a chunk reaches here; the zlib bytes held
      // are bounded by spStep at zlibBound(sp.size), and sp.size by maxObjectSize as soon as the header is read.
      let sp = spInit(); const zlibParts: Uint8Array[] = [];
      const feed = (chunk: Uint8Array): void => {
        const r = orThrow(spStepResult(sp, chunk)); sp = r.state;
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
        const found = orThrow(commitFromPack(t, oid, pack, span, bust));
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
      // One size check, in `once`: a nested function that failed would be a different fail site than this one.
      if (oversized) return orThrow<FetchedObject>(err(limitExceeded('object size', sp.size, maxObject)));
      return orThrow(singleObject(t, { sp: orThrow(spFinishResult(sp)), zlib: concat(zlibParts), want, span, bust, maxObject }));
    } catch (e) { stampCacheStatus(e, span); throw e; }
  }));
  try { return await once(false); } catch (e) {
    if (!corruptCacheHit(e)) throw e;
    return once(true);
  }
}

// The blob:none form of a tree:0 single-object fetch (see fetchObject). Bounded by limits.maxPackBytes (v2Step).
type Wide = { readonly oid: string; readonly deepen: number; readonly expectType: number | null; readonly learned: boolean };
// The wanted object out of the wide pack, its extras checked (checkWide) and harvested.
function wideObject(t: Transport, pack: Uint8Array, want: Wide, span: Span, bust: boolean): Result<FetchedObject, PlyError> {
  const { oid, expectType } = want;
  const maxObject = readLimit(t.limits, 'maxObjectSize');
  if (!maxObject.ok) return maxObject;
  const parsed = parsePackResult(pack, packParseOpts(t.limits));
  if (!parsed.ok) return parsed;
  const resolved = resolvePackResult(parsed.value, () => null, t.limits);
  if (!resolved.ok) return resolved;
  const objects: Map<string, PackObject> = resolved.value.objects;
  const skipped = checkWide(objects, k => k === oid, t.limits);
  const found = mapGet(objects, oid);
  if (found.tag === 'none') return fail('pack_corrupt', `object ${oid} not in the blob:none pack (${objects.size} objects)`);
  const wanted = found.value;
  if (wanted.data.length > maxObject.value) return err(limitExceeded('object size', wanted.data.length, maxObject.value));
  const refused = refuseNonCommit(expectType, wanted.type, oid);
  if (!refused.ok) return refused;
  if (expectType !== null && wanted.type !== expectType) return fail('pack_corrupt', `expected ${typeText(expectType)}, got ${typeText(wanted.type)}`);
  let blobs = 0, extraBytes = skipped.reduce((n, x) => n + x.bytes, 0); for (const [k, o] of objects) { if (k !== oid) extraBytes += o.data.length; if (o.type === TYPE.BLOB) blobs++; }
  const h = harvest(t, objects, oid);
  span.set({ 'git.pack.objects': parsed.value.stats.count, 'git.pack.bytes': pack.length, 'git.object.oid': oid, 'git.object.type': typeText(wanted.type), 'git.fetch.wide.objects': objects.size + skipped.length, 'git.fetch.wide.extra_objects': objects.size + skipped.length - 1, 'git.fetch.wide.extra_bytes': extraBytes, 'git.fetch.wide.blobs': blobs, 'git.fetch.wide.harvested': h.kept, 'git.fetch.wide.harvested_bytes': h.bytes, ...skippedAttrs(skipped) });
  return ok({ type: wanted.type, data: wanted.data, oid, size: wanted.data.length, bust, wide: true });
}
async function fetchWide(t: Transport, want: Wide): Promise<FetchedObject> {
  const { oid, deepen, learned } = want;
  // oxlint-disable-next-line typescript/promise-function-async -- coded() and the span are the promise; an async wrapper adds bytes, not behaviour
  const once = (bust: boolean): Promise<FetchedObject> => coded('pack_corrupt', () => t.tracer.span('git.upload-pack fetch', clientSpan(t, { 'git.pack.cache.bust': bust, 'git.fetch.filter.fallback': 'blob:none', 'git.fetch.filter.requested': 'tree:0', 'git.fetch.filter.learned': learned }), async (span: Span): Promise<FetchedObject> => {
    try {
      orThrow(readLimit(t.limits, 'maxObjectSize'));
      const parts: Uint8Array[] = [];
      for await (const chunk of packStream(t, { wants: [oid], filter: 'blob:none', deepen, bypassCache: bust }, span)) parts.push(chunk);
      return orThrow(wideObject(t, concat(parts), want, span, bust));
    } catch (e) { stampCacheStatus(e, span); throw e; }
  }));
  try { return await once(false); } catch (e) {
    if (!corruptCacheHit(e)) throw e;
    return once(true);
  }
}

// The I/O edge: a bad oid, a fetch failure, a verification failure are thrown.
export async function fetchObject(t: Transport, want: ObjectWant): Promise<FetchedObject> {
  const { oid } = want;
  // A JS caller may pass anything for the oid: it is checked as String() renders it (none as ''), and quoted the same way.
  // oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- see above
  if (!OID_RE.test(String(getOrElse(fromNullish<unknown>(oid), '')))) return orThrow(fail('bad_request', `fetchObject: oid must be 40-hex, got ${JSON.stringify(String(oid).slice(0, OID_PREVIEW))}`));
  const { filter, deepen, expectType } = withDefaults(want, objectWantDefaults());
  const narrow = filter === 'tree:0';
  const held = narrow ? mapGet(t.objects, oid) : none;
  if (held.tag === 'some' && (expectType === null || held.value.type === expectType)) return { type: held.value.type, data: held.value.data, oid, size: held.value.data.length, bust: false, harvested: true };
  if (narrow && t.quirks.treeFilter === 'blob:none') return fetchWide(t, { oid, deepen, expectType, learned: false });
  try { return await fetchSingle(t, { oid, filter, deepen, expectType }); } catch (e) {
    if (!narrow || !isFilterRejection(e)) throw e;
    t.quirks.treeFilter = 'blob:none';
    return fetchWide(t, { oid, deepen, expectType, learned: true });
  }
}
