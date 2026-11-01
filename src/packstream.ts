// Incremental pack scan, sideband demux, and a copied pkt-line step.
// The scan yields one event at a time and keeps the inflate window, not the objects. Deltas are yielded as
// instruction bytes (resolvePack still applies them for callers that want objects). The trailer SHA-1 runs over
// bytes as they are consumed; the trailer itself is not hashed.
//
// Events are a closed union. A base is none, an offset, or an oid — never a missing field.

import type { ErrorOf } from './errors.js';
import { plyError, fail } from './errors.js';
import type { Result } from './result.js';
import { ok, err, assertNever } from './result.js';
import { shortRead, decodeChunk, td } from './bytes.js';
import type { Limits } from './limits.js';
import { DEFAULT_LIMITS, readLimit, limitExceeded } from './limits.js';
import type { PackError } from './packresolve.js';
import { readObjHeaderResult, readOfsDeltaResult } from './packresolve.js';
import { Sha1, toHex } from './sha1.js';
import type { PktFrame } from './pktline.js';
import { inflateInit, inflateFeed, inflatePull, inflateEnd, inflateRelease, declaredBound, zlibWrap, type InflateStream, type InflatePiece, type InflateStats } from './inflatestream.js';

// noUncheckedIndexedAccess cannot see a Uint8Array index that a length check already proved.
/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- in-range indexed reads (`as number`; src/ forbids a bang assertion) */
import type { Attrs } from './otel.js';
import {
  PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, PACK_TRAILER_BYTES, OID_BYTES, UINT32_BYTES, BYTE_SHIFT,
  OBJ_COMMIT, OBJ_TREE, OBJ_BLOB, OBJ_TAG, OBJ_OFS_DELTA, OBJ_REF_DELTA,
  SIDEBAND_PACK, SIDEBAND_PROGRESS, SIDEBAND_ERROR, SIDEBAND_CHANNEL_BYTES, SIDEBAND_PROGRESS_KEEP,
} from './format.js';

const NOT_OUR_REF = 'not our ref';
const UPLOAD_PACK_NOT_OUR_REF = 'upload-pack: not our ref';
const PACK_EMPTY = new Uint8Array(0);

export type PackBase =
  | { readonly kind: 'none' }
  | { readonly kind: 'ofs'; readonly offset: number }
  | { readonly kind: 'oid'; readonly oid: string };
export type PackScanOpts = { readonly verify: boolean; readonly limits: Limits };
export const packScanOpts = (limits: Limits = DEFAULT_LIMITS, verify = true): PackScanOpts => ({ verify, limits });

type ObjClass = 'full' | 'ofs' | 'ref' | 'bad';
type PackPhase = 'header' | 'object' | 'ofs' | 'ref' | 'gate' | 'body' | 'trailer' | 'after' | 'end';
type PackHash = { kind: 'off' } | { kind: 'on'; sha: Sha1 };
type InflateHold =
  | { kind: 'closed' }
  | { kind: 'idle'; stream: InflateStream }
  | { kind: 'fed'; stream: InflateStream; at: number };

export type PackScan = {
  phase: PackPhase;
  verify: boolean;
  maxObjects: number;
  maxInflatedTotal: number;
  maxObjectSize: number;
  ended: boolean;
  carry: Uint8Array;
  p: number;
  base: number;
  hash: PackHash;
  count: number;
  version: number;
  index: number;
  inflated: number;
  objOffset: number;
  type: number;
  size: number;
  baseRef: PackBase;
  inf: InflateHold;
};

export type PackPiece =
  | { readonly kind: 'need' }
  | { readonly kind: 'header'; readonly version: number; readonly count: number }
  | { readonly kind: 'object'; readonly index: number; readonly offset: number; readonly type: number; readonly size: number; readonly base: PackBase }
  | { readonly kind: 'chunk'; readonly index: number; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'object-end'; readonly index: number; readonly compressed: number; readonly stats: InflateStats }
  | { readonly kind: 'trailer'; readonly trailer: string }
  | { readonly kind: 'end' };

type Step = { readonly kind: 'cont' } | { readonly kind: 'piece'; readonly piece: PackPiece } | { readonly kind: 'err'; readonly error: PackError };
const CONT: Step = { kind: 'cont' };
const emit = (next: PackPiece): Step => ({ kind: 'piece', piece: next });
const broken = (error: PackError): Step => ({ kind: 'err', error });

function packHash(st: PackScan, bytes: Uint8Array): void {
  if (st.hash.kind === 'off' || bytes.length === 0) return;
  st.hash.sha.update(bytes);
}
function packAdvance(st: PackScan, n: number): void {
  if (n === 0) return;
  packHash(st, st.carry.subarray(st.p, st.p + n));
  st.p += n;
}
function packBe32(b: Uint8Array, off: number): number {
  let v = 0;
  for (let i = 0; i < UINT32_BYTES; i++) v = (v << BYTE_SHIFT) | (b[off + i] as number);
  return v >>> 0;
}
function packClass(type: number): ObjClass {
  if (type === OBJ_COMMIT || type === OBJ_TREE || type === OBJ_BLOB || type === OBJ_TAG) return 'full';
  if (type === OBJ_OFS_DELTA) return 'ofs';
  if (type === OBJ_REF_DELTA) return 'ref';
  return 'bad';
}
function packSync(st: PackScan): void {
  if (st.inf.kind !== 'fed') return;
  const abs = st.inf.at + st.inf.stream.p;
  if (abs <= st.p) return;
  packHash(st, st.carry.subarray(st.p, abs));
  st.p = abs;
}

// @decoder parsePackInit prefix=pack
export function parsePackInit(opts: PackScanOpts): Result<PackScan, PackError> {
  const maxObjects = readLimit(opts.limits, 'maxPackObjects');
  if (!maxObjects.ok) return maxObjects;
  const maxInflatedTotal = readLimit(opts.limits, 'maxInflatedTotal');
  if (!maxInflatedTotal.ok) return maxInflatedTotal;
  const maxObjectSize = readLimit(opts.limits, 'maxObjectSize');
  if (!maxObjectSize.ok) return maxObjectSize;
  const hash: PackHash = opts.verify ? { kind: 'on', sha: new Sha1() } : { kind: 'off' };
  return ok({
    phase: 'header', verify: opts.verify, maxObjects: maxObjects.value, maxInflatedTotal: maxInflatedTotal.value, maxObjectSize: maxObjectSize.value,
    ended: false, carry: PACK_EMPTY, p: 0, base: 0, hash, count: 0, version: 0, index: 0, inflated: 0,
    objOffset: 0, type: 0, size: 0, baseRef: { kind: 'none' }, inf: { kind: 'closed' },
  });
}
// @decoder parsePackFeed prefix=pack
export function parsePackFeed(st: PackScan, bytes: Uint8Array): void {
  if (st.p >= st.carry.length) {
    st.base += st.p;
    st.carry = bytes;
    st.p = 0;
    return;
  }
  const tail = st.carry.subarray(st.p);
  const n = new Uint8Array(tail.length + bytes.length);
  n.set(tail, 0);
  n.set(bytes, tail.length);
  st.base += st.p;
  st.carry = n;
  st.p = 0;
}
// @decoder parsePackClose prefix=pack
export function parsePackClose(st: PackScan): void {
  st.ended = true;
}

function packHeader(st: PackScan): Step {
  const total = st.base + st.carry.length;
  const minPack = PACK_HEADER_BYTES + PACK_TRAILER_BYTES;
  // A short first chunk is a need. Closed with no complete header, or closed under the minimum pack, is the same
  // refusal parsePack gives a buffer shorter than a header plus a trailer. The signature check is the third refusal.
  if (st.carry.length - st.p < PACK_HEADER_BYTES) {
    if (!st.ended) return emit({ kind: 'need' });
    return broken(plyError('pack_corrupt', 'pack: bad signature'));
  }
  if (st.ended && total < minPack) return broken(plyError('pack_corrupt', 'pack: bad signature'));
  for (let i = 0; i < PACK_SIGNATURE.length; i++) {
    if (st.carry[st.p + i] !== PACK_SIGNATURE[i]) return broken(plyError('pack_corrupt', 'pack: bad signature'));
  }
  const version = packBe32(st.carry, st.p + PACK_SIGNATURE.length);
  const count = packBe32(st.carry, st.p + PACK_SIGNATURE.length + UINT32_BYTES);
  if (version !== PACK_VERSION) return broken(plyError('pack_corrupt', `pack: unsupported version ${version}`));
  if (count > st.maxObjects) return broken(limitExceeded('pack objects', count, st.maxObjects));
  packAdvance(st, PACK_HEADER_BYTES);
  st.version = version;
  st.count = count;
  st.index = 0;
  st.inflated = 0;
  st.phase = count === 0 ? 'trailer' : 'object';
  return emit({ kind: 'header', version, count });
}
function packObject(st: PackScan): Step {
  const header = readObjHeaderResult(st.carry, st.p);
  if (!header.ok) {
    if (header.error.reason === 'short_read' && !st.ended) return emit({ kind: 'need' });
    return broken(header.error);
  }
  const start = st.p;
  st.objOffset = st.base + start;
  st.type = header.value.type;
  st.size = header.value.size;
  packAdvance(st, header.value.next - start);
  const kind = packClass(st.type);
  if (kind === 'ofs') { st.phase = 'ofs'; return CONT; }
  if (kind === 'ref') { st.phase = 'ref'; return CONT; }
  if (kind === 'bad') return broken(plyError('pack_corrupt', `pack: bad object type ${st.type} at ${st.objOffset}`));
  st.baseRef = { kind: 'none' };
  st.phase = 'gate';
  return CONT;
}
function packOfs(st: PackScan): Step {
  const ofs = readOfsDeltaResult(st.carry, st.p);
  if (!ofs.ok) {
    if (ofs.error.reason === 'short_read' && !st.ended) return emit({ kind: 'need' });
    return broken(ofs.error);
  }
  const start = st.p;
  packAdvance(st, ofs.value.next - start);
  if (ofs.value.off === 0) return broken(plyError('pack_corrupt', `pack: ofs delta at ${st.objOffset} is its own base`));
  const baseOffset = st.objOffset - ofs.value.off;
  if (baseOffset < PACK_HEADER_BYTES) return broken(plyError('pack_corrupt', `pack: ofs delta base before pack start at ${st.objOffset}`));
  st.baseRef = { kind: 'ofs', offset: baseOffset };
  st.phase = 'gate';
  return CONT;
}
function packRef(st: PackScan): Step {
  if (st.carry.length - st.p < OID_BYTES) {
    if (!st.ended) return emit({ kind: 'need' });
    return broken(shortRead('pack_corrupt', st.p, OID_BYTES, st.carry.length));
  }
  st.baseRef = { kind: 'oid', oid: toHex(st.carry.subarray(st.p, st.p + OID_BYTES)) };
  packAdvance(st, OID_BYTES);
  st.phase = 'gate';
  return CONT;
}
function packGate(st: PackScan): Step {
  if (st.size > st.maxObjectSize) return broken(limitExceeded('pack object size', st.size, st.maxObjectSize));
  if (st.inflated + st.size > st.maxInflatedTotal) return broken(limitExceeded('pack inflated bytes', st.inflated + st.size, st.maxInflatedTotal));
  st.phase = 'body';
  st.inf = { kind: 'closed' };
  return emit({ kind: 'object', index: st.index, offset: st.objOffset, type: st.type, size: st.size, base: st.baseRef });
}
function packIdle(st: PackScan, stream: InflateStream): void {
  inflateRelease(stream);
  st.inf = { kind: 'idle', stream };
}
function packFinishObject(st: PackScan, compressed: number, stats: InflateStats): Step {
  const index = st.index;
  st.inflated += st.size;
  st.index += 1;
  st.inf = { kind: 'closed' };
  st.phase = st.index < st.count ? 'object' : 'trailer';
  return emit({ kind: 'object-end', index, compressed, stats });
}
function packFromInflate(st: PackScan, stream: InflateStream, r: Result<InflatePiece, PackError>): Step {
  if (!r.ok) return broken(r.error);
  if (r.value.kind === 'chunk') return emit({ kind: 'chunk', index: st.index, bytes: r.value.bytes });
  // inflateEnd turns a short member into an error. need would mean the stream asked for bytes after it was closed.
  if (r.value.kind !== 'end') return assertNever(r.value as never);
  packSync(st);
  packIdle(st, stream);
  return packFinishObject(st, r.value.consumed, r.value.stats);
}
function packEnsure(st: PackScan): Result<InflateStream, PackError> {
  if (st.inf.kind !== 'closed') return ok(st.inf.stream);
  const init = inflateInit({ bound: declaredBound(st.size, st.maxObjectSize), wrap: zlibWrap(true) });
  if (!init.ok) return init;
  st.inf = { kind: 'idle', stream: init.value };
  return ok(init.value);
}
function packBody(st: PackScan): Step {
  const ensured = packEnsure(st);
  if (!ensured.ok) return broken(ensured.error);
  const stream = ensured.value;
  if (st.inf.kind === 'idle' && st.p < st.carry.length) {
    const at = st.p;
    inflateFeed(stream, st.carry.subarray(st.p));
    st.inf = { kind: 'fed', stream, at };
  }
  if (st.inf.kind === 'idle') {
    if (!st.ended) return emit({ kind: 'need' });
    return packFromInflate(st, stream, inflateEnd(stream));
  }
  const pulled = inflatePull(stream);
  packSync(st);
  if (!pulled.ok) return broken(pulled.error);
  if (pulled.value.kind === 'need') {
    packIdle(st, stream);
    if (!st.ended) return emit({ kind: 'need' });
    return packFromInflate(st, stream, inflateEnd(stream));
  }
  if (pulled.value.kind === 'chunk') return emit({ kind: 'chunk', index: st.index, bytes: pulled.value.bytes });
  packIdle(st, stream);
  return packFinishObject(st, pulled.value.consumed, pulled.value.stats);
}
function packTrailer(st: PackScan): Step {
  const at = st.base + st.p;
  const total = st.base + st.carry.length;
  if (total !== at + PACK_TRAILER_BYTES) {
    if (total < at + PACK_TRAILER_BYTES && !st.ended) return emit({ kind: 'need' });
    return broken(plyError('pack_corrupt', `pack: expected trailer at ${at}, pack length ${total}`));
  }
  const trailer = toHex(st.carry.subarray(st.p, st.p + PACK_TRAILER_BYTES));
  st.p += PACK_TRAILER_BYTES;
  if (st.hash.kind === 'on') {
    const computed = st.hash.sha.hex();
    if (computed !== trailer) return broken(plyError('pack_corrupt', `pack: trailer sha mismatch ${trailer} != ${computed}`));
  }
  st.phase = 'after';
  return emit({ kind: 'trailer', trailer });
}
function packAfter(st: PackScan): Step {
  if (st.p < st.carry.length) {
    const at = st.base + st.p - PACK_TRAILER_BYTES;
    return broken(plyError('pack_corrupt', `pack: expected trailer at ${at}, pack length ${st.base + st.carry.length}`));
  }
  if (!st.ended) return emit({ kind: 'need' });
  st.phase = 'end';
  return emit({ kind: 'end' });
}
function packStep(st: PackScan): Step {
  switch (st.phase) {
    case 'header': return packHeader(st);
    case 'object': return packObject(st);
    case 'ofs': return packOfs(st);
    case 'ref': return packRef(st);
    case 'gate': return packGate(st);
    case 'body': return packBody(st);
    case 'trailer': return packTrailer(st);
    case 'after': return packAfter(st);
    case 'end': return emit({ kind: 'end' });
    default: return assertNever(st.phase);
  }
}
// @decoder parsePackPull prefix=pack
export function parsePackPull(st: PackScan): Result<PackPiece, PackError> {
  for (;;) {
    const step = packStep(st);
    if (step.kind === 'cont') continue;
    if (step.kind === 'err') return err(step.error);
    return ok(step.piece);
  }
}
// @decoder parsePackEnd prefix=pack
export function parsePackEnd(st: PackScan): Result<PackPiece, PackError> {
  parsePackClose(st);
  return parsePackPull(st);
}
export function streamPackAttrs(st: PackScan): Attrs {
  return {
    'git.pack.phase': st.phase,
    'git.pack.objects': st.index,
    'git.pack.offset': st.base + st.p,
    'git.pack.inflated': st.inflated,
    'git.pack.ended': st.ended,
  };
}

export type SidebandState = {
  band1: number;
  band2: number;
  progress: string;
  progressCarry: Uint8Array;
  maxPack: number;
};
export type SidebandPiece =
  | { readonly kind: 'pack'; readonly body: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'progress'; readonly text: string }
  | { readonly kind: 'skip' };
export type SidebandStep = { readonly state: SidebandState; readonly piece: SidebandPiece };
type SidebandError = ErrorOf<'protocol'> | ErrorOf<'limit_exceeded'> | ErrorOf<'remote_error'> | ErrorOf<'bad_request'>;

export function sidebandInit(limits: Limits): Result<SidebandState, ErrorOf<'bad_request'>> {
  const max = readLimit(limits, 'maxPackBytes');
  if (!max.ok) return max;
  return ok({ band1: 0, band2: 0, progress: '', progressCarry: PACK_EMPTY, maxPack: max.value });
}
function sidebandNotOurs(text: string): boolean {
  if (text === NOT_OUR_REF || text.startsWith(`${NOT_OUR_REF} `)) return true;
  if (text === UPLOAD_PACK_NOT_OUR_REF || text.startsWith(`${UPLOAD_PACK_NOT_OUR_REF} `)) return true;
  return false;
}
export function sidebandStep(st: SidebandState, frame: PktFrame): Result<SidebandStep, SidebandError> {
  if (frame.kind !== 'data') return fail('protocol', `sideband: ${frame.kind} is not a sideband frame`);
  if (frame.payload.length < SIDEBAND_CHANNEL_BYTES) return err(shortRead('protocol', 0, SIDEBAND_CHANNEL_BYTES, frame.payload.length));
  const band = frame.payload[0] as number;
  const body = frame.payload.subarray(SIDEBAND_CHANNEL_BYTES).slice();
  if (band === SIDEBAND_PACK) {
    const band1 = st.band1 + body.length;
    if (band1 > st.maxPack) return err(limitExceeded('pack bytes', band1, st.maxPack));
    return ok({ state: { ...st, band1 }, piece: { kind: 'pack', body } });
  }
  if (band === SIDEBAND_PROGRESS) {
    const band2 = st.band2 + body.length;
    if (band2 > st.maxPack) return err(limitExceeded('progress bytes', band2, st.maxPack));
    const decoded = decodeChunk(st.progressCarry, body);
    const progress = (st.progress + decoded.text).slice(-SIDEBAND_PROGRESS_KEEP);
    return ok({ state: { ...st, band2, progress, progressCarry: decoded.carry }, piece: { kind: 'progress', text: decoded.text } });
  }
  if (band === SIDEBAND_ERROR) {
    const text = td.decode(body).trim();
    if (sidebandNotOurs(text)) return fail('remote_error', `remote: ${text}`, { reason: 'not_our_ref' });
    return fail('remote_error', `remote: ${text}`);
  }
  return fail('protocol', `sideband: bad sideband ${band}`);
}
export function streamSidebandAttrs(st: SidebandState): Attrs {
  return {
    'git.sideband.band1.bytes': st.band1,
    'git.sideband.band2.bytes': st.band2,
    'git.sideband.progress.tail': st.progress,
  };
}
