// Pull pack scan: bytes in as they arrive, one event out at a time: the header, each object's header, its inflated
// chunks and its end, the trailer, the end. It keeps one inflate record (the window and one chunk, inflatestream.ts),
// the unread input, and a 20-byte lag of the trailer hash — never an object (issue #172). Deltas come out as their
// instruction bytes; resolvePack applies them for a caller that wants objects, from parsePack's buffered records.
//
// The same refusals as parsePack, in the same order, with the same caps: maxPackObjects on the header's count,
// maxObjectSize on each declared size and maxInflatedTotal on the declared sizes plus LIMIT_OBJECT_OVERHEAD each, all
// before an inflated byte exists. The trailer SHA-1 runs over the bytes as they are fed, 20 bytes behind, so the bytes
// it has not hashed when the input closes are the trailer exactly when the trailer is where the objects end.
// test/packstream.test.js holds the scan to parsePack's objects, trailer and error code for every chunking.
//
// That is the default budget, for a caller that keeps what it reads. A caller that drops every object can ask for a work
// budget (workBudget): nothing is retained, so what a pack can cost is CPU, and it is charged as CPU: the bytes actually
// inflated, against maxInflatedTotal or `ratio` times the pack bytes consumed so far, whichever is larger. A scan's memory
// is peakBound('pack-scan') under either budget (streambound.ts). The check runs at each chunk's end, so a refusal comes
// at most one chunk past the budget, and a pack within a chunk of its ratio can pass or refuse depending on how it is fed.
import type { ErrorOf } from './errors.js';
import { fail, plyError } from './errors.js';
import type { Err, Result } from './result.js';
import { ok, err, assertNever, getOrElse } from './result.js';
import type { LimitsInput } from './limits.js';
import { DEFAULT_LIMITS, LIMIT_OBJECT_OVERHEAD, LIMIT_WORK_RATIO, checkLimit, limitExceeded, parseLimits } from './limits.js';
import type { Input } from './absent.js';
import { atOr, fromNullish } from './absent.js';
import { take, shortRead } from './bytes.js';
import { Sha1, toHex, toOid } from './sha1.js';
import type { Oid } from './oid.js';
import type { ObjType } from './format.js';
import type { InflateStats, InflateStream } from './inflatestream.js';
export type { InflateStats };
import { inflateInit, inflateReset, inflateFeed, inflatePull, inflateEnd, inflateUnread, inflateConsumed, declaredBound, zlibWrap } from './inflatestream.js';
import type { Attrs } from './otel.js';
import {
  PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, PACK_TRAILER_BYTES, OID_BYTES, UINT32_BYTES, BE32_SHIFTS,
  OBJ_COMMIT, OBJ_TREE, OBJ_BLOB, OBJ_TAG, OBJ_OFS_DELTA, OBJ_REF_DELTA,
  OBJ_TYPE_SHIFT, OBJ_TYPE_MASK, OBJ_SIZE_FIRST_MASK, OBJ_SIZE_NEXT_MASK, OBJ_CONTINUE,
  OBJ_SIZE_NEXT_BASE, VARINT_BITS, VARINT_MAX_SHIFT, varintScale,
} from './format.js';

// Indexed reads below are inside a length the code has just checked; noUncheckedIndexedAccess cannot see that.
/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- in-range indexed reads, see above */

type Corrupt = ErrorOf<'pack_corrupt'>;
// Everything a pack can be refused for: corrupt bytes, a limit, or a caller's limit that bounds nothing.
export type PackError = Corrupt | ErrorOf<'limit_exceeded'> | ErrorOf<'bad_request'>;
const corrupt = (msg: string): Err<Corrupt> => fail('pack_corrupt', msg);
const short = (buf: Uint8Array, p: number): Err<Corrupt> => err(shortRead('pack_corrupt', p, 1, buf.length));
// A read that may run past the end reads atOr(buf, p, NO_BYTE): NO_BYTE there is a short read.
const NO_BYTE = -1;

// ---- the header readers (one place: the scan, the single-object parser and the delta header read them) ----
// Past VARINT_MAX_SHIFT a group used to scale by Infinity, and 0 × Infinity is NaN: every `size > limit` check is false
// on NaN, so the size reached callers (#13). Checked before the byte is read, so a hostile header costs ≤ 10 bytes.
const varintLong = (what: string): Err<Corrupt> => corrupt(`${what}: size varint longer than ${VARINT_MAX_SHIFT + 1} bits`);

// Little-endian 7-bit groups from start, each with a continue bit: the delta header's sizes (from n = 0, shift = 0), and
// the rest of an object header's size after a first byte that continues (from that byte's four bits, shift = 4).
// @decoder readVarint prefix=varint
export function readVarint(buf: Uint8Array, start: number, what: string, n0 = 0, shift0 = 0): Result<readonly [number, number], Corrupt> {
  let p = start;
  let n = n0;
  let shift = shift0;
  let c: number;
  do {
    if (shift > VARINT_MAX_SHIFT) return varintLong(what);
    c = atOr(buf, p, NO_BYTE);
    if (c === NO_BYTE) return short(buf, p);
    p += 1;
    n += (c & OBJ_SIZE_NEXT_MASK) * varintScale(shift);
    shift += VARINT_BITS;
  } while (c & OBJ_CONTINUE);
  return ok([n, p]);
}

// Four bytes at off, big-endian, where the caller has checked they are there.
const be32 = (b: Uint8Array, off: number): number =>
  // oxlint-disable-next-line no-magic-numbers -- off + 2 is the third byte of the four BE32_SHIFTS places
  (((b[off] as number) << (BE32_SHIFTS[0] as number)) | ((b[off + 1] as number) << (BE32_SHIFTS[1] as number)) | ((b[off + 2] as number) << (BE32_SHIFTS[2] as number)) | (b[off + UINT32_BYTES - 1] as number)) >>> 0;
export function readUint32BE(buf: Uint8Array, off: number): Result<number, Corrupt> {
  const r = take(buf, off, UINT32_BYTES);
  return r.ok ? ok(be32(buf, off)) : r;
}

// The header's three type bits as one of the six pack types, or null for 0 and 5 (which name nothing).
function objTypeOf(n: number): ObjType | null {
  switch (n) {
    case OBJ_COMMIT:
    case OBJ_TREE:
    case OBJ_BLOB:
    case OBJ_TAG:
    case OBJ_OFS_DELTA:
    case OBJ_REF_DELTA:
      return n;
    default:
      return null;
  }
}
// An object's declared inflated size, checked against the reader's cap where the header was read (#156): a reader of
// an ObjHeader holds a size no larger than the cap it asked for, before any inflated byte exists.
declare const objSizeBrand: unique symbol;
export type ObjSize = number & { readonly [objSizeBrand]: typeof objSizeBrand };
const withinCap = (size: number, max: number): size is ObjSize => size <= max;
// The size of an empty object, for a record's placeholder (0 is within every cap).
// Stryker disable next-line all: a placeholder, see above
const zeroSize = (): ObjSize => { const z = 0; return withinCap(z, z) ? z : zeroSize(); };
// `type` is parsed here, once: a reader of an ObjHeader sees one of the six pack types and no other number.
export type ObjHeader = { readonly type: ObjType; readonly size: ObjSize; readonly next: number };
export type HeaderError = Corrupt | ErrorOf<'limit_exceeded'>;
// No cap: a streamed blob (edit, read) is bounded by its own reader, not by maxObjectSize.
export const NO_SIZE_CAP: number = Number.POSITIVE_INFINITY;
// A header cut by the end of the buffer is a short read (`reason: 'short_read'`): a stream parser waits for more bytes
// on that reason (fetch.ts spStep, the scan below), and refuses anything else. A whole header whose type is 0 or 5 is
// `pack: bad object type <n> at <offset>`, after the size (a size varint past 64 bits is refused first, as it always
// was); `offset` is the header's offset in the pack, which a stream parser's carry buffer does not start at. A size
// past `maxSize` is limit_exceeded (`pack object size`), after the type.
// @decoder readObjHeader prefix=obj-header
export function readObjHeader(buf: Uint8Array, start: number, offset: number = start, maxSize: number = NO_SIZE_CAP): Result<ObjHeader, HeaderError> {
  const c = atOr(buf, start, NO_BYTE);
  if (c === NO_BYTE) return short(buf, start);
  const bits = (c >> OBJ_TYPE_SHIFT) & OBJ_TYPE_MASK;
  let size = c & OBJ_SIZE_FIRST_MASK;
  let next = start + 1;
  if (c & OBJ_CONTINUE) {
    const rest = readVarint(buf, start + 1, 'pack', size, OBJ_TYPE_SHIFT);
    if (!rest.ok) return rest;
    [size, next] = rest.value;
  }
  const type = objTypeOf(bits);
  if (type === null) return corrupt(`pack: bad object type ${bits} at ${offset}`);
  if (!withinCap(size, maxSize)) return err(limitExceeded('pack object size', size, maxSize));
  return ok({ type, size, next });
}

export type OfsDelta = { readonly off: number; readonly next: number };
// The same ten-byte cap as the size varints (readObjHeader): git's index-pack refuses an offset that overflows
// ("offset value overflow for delta base object"); past it the offset could only name a base before the pack start.
// @decoder readOfsDelta prefix=ofs-delta
export function readOfsDelta(buf: Uint8Array, start: number): Result<OfsDelta, Corrupt> {
  let p = start;
  let c = atOr(buf, p, NO_BYTE);
  if (c === NO_BYTE) return short(buf, p);
  p += 1;
  let off = c & OBJ_SIZE_NEXT_MASK;
  let shift = VARINT_BITS;
  while (c & OBJ_CONTINUE) {
    if (shift > VARINT_MAX_SHIFT) return corrupt(`pack: ofs delta offset longer than ${VARINT_MAX_SHIFT + 1} bits`);
    c = atOr(buf, p, NO_BYTE);
    if (c === NO_BYTE) return short(buf, p);
    p += 1;
    off = ((off + 1) * OBJ_SIZE_NEXT_BASE) + (c & OBJ_SIZE_NEXT_MASK);
    shift += VARINT_BITS;
  }
  return ok({ off, next: p });
}

// ---- the scan ----
const EMPTY: Uint8Array = new Uint8Array(0);
const MIN_PACK: number = PACK_HEADER_BYTES + PACK_TRAILER_BYTES;

// An object's base, parsed where its bytes were read: none (a full object), an offset in this pack (OFS_DELTA, a pack
// offset past the header and before the object), or an id (REF_DELTA). parsePack's objects and resolvePack's input
// carry this; nothing reads a base as a number or a string that may be missing.
export type ObjBase =
  | { readonly tag: 'none' }
  | { readonly tag: 'ofs'; readonly offset: number }
  | { readonly tag: 'ref'; readonly oid: Oid };
export const NO_BASE: ObjBase = Object.freeze({ tag: 'none' });
// limits: any subset (a key left out is the default), parsed by parsePackInit.
// How a scan charges inflation. retain: declared sizes plus LIMIT_OBJECT_OVERHEAD against maxInflatedTotal, before any
// byte inflates, for a caller that keeps objects (parsePack's refusals). work: see the top of this file; maxObjectSize
// applies only with capObjects, since a scan that keeps nothing has no reason to refuse a large blob.
export type ScanBudget =
  | { readonly tag: 'retain' }
  | { readonly tag: 'work'; readonly ratio: number; readonly capObjects: boolean };
export const RETAIN_BUDGET: ScanBudget = Object.freeze({ tag: 'retain' });
export const workBudget = (ratio: number = LIMIT_WORK_RATIO, capObjects = false): ScanBudget => Object.freeze({ tag: 'work', ratio, capObjects });
export const WORK_BUDGET: ScanBudget = workBudget();
export type PackScanOpts = { readonly verify: boolean; readonly limits: LimitsInput; readonly budget: ScanBudget };
export const packScanOpts = (limits: LimitsInput = DEFAULT_LIMITS, verify = true, budget: ScanBudget = RETAIN_BUDGET): PackScanOpts => ({ verify, limits, budget });

export type PackPiece =
  | { readonly kind: 'need' }
  | { readonly kind: 'header'; readonly version: number; readonly count: number }
  | { readonly kind: 'object'; readonly index: number; readonly offset: number; readonly headerBytes: number; readonly type: ObjType; readonly size: ObjSize; readonly base: ObjBase }
  | { readonly kind: 'chunk'; readonly index: number; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'object-end'; readonly index: number; readonly compressed: number; readonly stats: InflateStats }
  | { readonly kind: 'trailer'; readonly trailer: string }
  | { readonly kind: 'end' };

export type PackPhase = 'header' | 'object' | 'ofs' | 'ref' | 'gate' | 'body' | 'trailer' | 'end';
type PackHash = { readonly kind: 'off' } | { readonly kind: 'on'; readonly sha: Sha1 };
export type PackHalt = { readonly tag: 'running' } | { readonly tag: 'failed'; readonly error: PackError };
// Stryker disable next-line ObjectLiteral,StringLiteral: halt is read only as tag === 'failed'; any other record runs
const RUNNING: PackHalt = { tag: 'running' };

// Single owner, mutable so a pull resumes where the last one stopped.
export type PackScan = {
  phase: PackPhase;
  halt: PackHalt;
  maxObjects: number;
  maxInflatedTotal: number;
  maxObjectSize: number;
  budget: ScanBudget;
  ended: boolean;
  // unread input outside an object body: `carry` from `p`, which is pack offset `at`
  carry: Uint8Array;
  p: number;
  at: number;
  // every byte fed so far, and the last ≤ 20 of them (not hashed yet)
  total: number;
  lag: Uint8Array;
  hash: PackHash;
  count: number;
  index: number;
  charged: number;
  // the object being read
  offset: number;
  headerBytes: number;
  type: ObjType;
  size: ObjSize;
  base: ObjBase;
  // one inflate record, reset for every member: the window and chunk buffers are allocated once per scan
  inflate: InflateStream;
};

const NEED_PIECE: PackPiece = { kind: 'need' };
const END_PIECE: PackPiece = { kind: 'end' };
// A step's answer: go on, a piece, or stopped (the refusal is on the record).
type Step = { readonly kind: 'cont' } | { readonly kind: 'piece'; readonly piece: PackPiece } | { readonly kind: 'failed' };
// Stryker disable next-line ObjectLiteral,StringLiteral: the pull loops on anything that is not a piece or a failure
const CONT: Step = { kind: 'cont' };
const NEED: Step = { kind: 'piece', piece: NEED_PIECE };
// Stryker disable next-line ObjectLiteral,StringLiteral: the pull reads a step only as kind === 'piece'; the refusal is on st.halt
const FAILED: Step = { kind: 'failed' };
const piece = (p: PackPiece): Step => ({ kind: 'piece', piece: p });
function refuse(st: PackScan, error: PackError): Step {
  st.halt = { tag: 'failed', error };
  return FAILED;
}

// A work-budgeted scan's object cap: the largest size a double holds exactly, so a declared size past it is still refused.
const UNCAPPED_OBJECT: number = Number.MAX_SAFE_INTEGER;
// The three caps a scan holds, each already checked (parseLimits, or parsePack's override checked the same way).
export type PackCaps = { readonly maxObjects: number; readonly maxInflatedTotal: number; readonly maxObjectSize: number };
// A scan under caps in hand: the limits' check is the caller's (parsePackInit, parsePack).
export function packScanOpen(caps: PackCaps, verify: boolean, budget: ScanBudget = RETAIN_BUDGET): Result<PackScan, PackError> {
  // a declared size of 0 under a checked cap: this record always opens (each member resets it)
  // Stryker disable next-line all: see above
  const inflate = inflateInit({ bound: declaredBound(0, caps.maxObjectSize), wrap: zlibWrap(true) });
  // Stryker disable next-line all: see above
  if (!inflate.ok) return inflate;
  return ok({
    phase: 'header', halt: RUNNING, maxObjects: caps.maxObjects, maxInflatedTotal: caps.maxInflatedTotal, maxObjectSize: caps.maxObjectSize, budget,
    // Stryker disable next-line ObjectLiteral,StringLiteral: the hash is read only as kind 'on'; any other record is off
    ended: false, carry: EMPTY, p: 0, at: 0, total: 0, lag: EMPTY, hash: verify ? { kind: 'on', sha: new Sha1() } : { kind: 'off' },
    // Stryker disable next-line all: placeholders until the first object header sets them
    count: 0, index: 0, charged: 0, offset: 0, headerBytes: 0, type: OBJ_BLOB, size: zeroSize(), base: NO_BASE, inflate: inflate.value,
  });
}
// @decoder parsePackInit prefix=pack
export function parsePackInit(opts: Omit<PackScanOpts, 'budget'> & Input<Pick<PackScanOpts, 'budget'>>): Result<PackScan, PackError> {
  const limits = parseLimits(opts.limits);
  if (!limits.ok) return limits;
  const budget = getOrElse(fromNullish(opts.budget), RETAIN_BUDGET);
  if (budget.tag === 'work') {
    const ratio = checkLimit(budget.ratio, 'workRatio');
    if (!ratio.ok) return ratio;
  }
  const { maxPackObjects: maxObjects, maxInflatedTotal } = limits.value;
  const maxObjectSize = budget.tag === 'work' && !budget.capObjects ? UNCAPPED_OBJECT : limits.value.maxObjectSize;
  return packScanOpen({ maxObjects, maxInflatedTotal, maxObjectSize }, opts.verify, budget);
}

// Hash everything but the last PACK_TRAILER_BYTES bytes seen so far (spStep's lag, fetch.ts). The lag is kept with
// verify off too: it is the trailer.
function hashLagged(st: PackScan, bytes: Uint8Array): void {
  st.total += bytes.length;
  const lagged = st.lag.length + bytes.length;
  // Stryker disable next-line EqualityOperator: at exactly PACK_TRAILER_BYTES the other branch hashes nothing and keeps the same lag
  if (lagged <= PACK_TRAILER_BYTES) {
    const lag = new Uint8Array(lagged);
    lag.set(st.lag, 0);
    lag.set(bytes, st.lag.length);
    st.lag = lag;
    return;
  }
  const out = lagged - PACK_TRAILER_BYTES;
  // what leaves the lag first, then what of `bytes` leaves
  const fromLag = Math.min(out, st.lag.length);
  if (st.hash.kind === 'on') {
    st.hash.sha.update(st.lag.subarray(0, fromLag));
    st.hash.sha.update(bytes.subarray(0, out - fromLag));
  }
  const lag = new Uint8Array(PACK_TRAILER_BYTES);
  const keepLag = st.lag.length - fromLag;
  lag.set(st.lag.subarray(fromLag), 0);
  lag.set(bytes.subarray(out - fromLag), keepLag);
  st.lag = lag;
}

// Append input. Inside an object body it goes straight to the inflate record; elsewhere an exhausted carry is replaced
// by `bytes` (no copy) and a leftover tail (an object header cut by the chunk) is copied in front of it once.
// @decoder parsePackFeed prefix=pack
export function parsePackFeed(st: PackScan, bytes: Uint8Array): void {
  hashLagged(st, bytes);
  if (st.phase === 'body') {
    inflateFeed(st.inflate, bytes);
    return;
  }
  // past the objects only the count matters: the trailer is the hash lag
  if (st.phase === 'trailer' || st.phase === 'end') return;
  if (st.p >= st.carry.length) {
    st.carry = bytes;
    st.p = 0;
    return;
  }
  const tail = st.carry.subarray(st.p);
  const joined = new Uint8Array(tail.length + bytes.length);
  joined.set(tail, 0);
  joined.set(bytes, tail.length);
  st.carry = joined;
  st.p = 0;
}
// No more input will come.
// @decoder parsePackClose prefix=pack
export function parsePackClose(st: PackScan): void {
  st.ended = true;
}

const available = (st: PackScan): number => st.carry.length - st.p;
function advance(st: PackScan, n: number): void {
  st.p += n;
  st.at += n;
}

// parsePack decides the header on a buffer of at least a header and a trailer: so does the scan, or on a closed input.
function stepHeader(st: PackScan): Step {
  if (available(st) < MIN_PACK && !st.ended) return NEED;
  if (st.total < MIN_PACK) return refuse(st, plyError('pack_corrupt', 'pack: bad signature'));
  for (const [i, b] of PACK_SIGNATURE.entries()) {
    if (st.carry[st.p + i] !== b) return refuse(st, plyError('pack_corrupt', 'pack: bad signature'));
  }
  const version = be32(st.carry, st.p + PACK_SIGNATURE.length);
  const count = be32(st.carry, st.p + PACK_SIGNATURE.length + UINT32_BYTES);
  if (version !== PACK_VERSION) return refuse(st, plyError('pack_corrupt', `pack: unsupported version ${version}`));
  if (count > st.maxObjects) return refuse(st, limitExceeded('pack objects', count, st.maxObjects));
  advance(st, PACK_HEADER_BYTES);
  st.count = count;
  st.phase = count === 0 ? 'trailer' : 'object';
  return piece({ kind: 'header', version, count });
}
// A read cut by the end of what has arrived waits for more; on a closed input it is the refusal parsePack gives.
function waitOr(st: PackScan, e: HeaderError): Step {
  // Stryker disable next-line ConditionalExpression: only a pack_corrupt short read carries reason short_read; the code test is for the compiler
  if (e.code === 'pack_corrupt' && e.reason === 'short_read' && !st.ended) return NEED;
  return refuse(st, e);
}
function stepObject(st: PackScan): Step {
  // the carry starts mid-pack: a refused type names the pack offset (st.at), as parsePack does
  const header = readObjHeader(st.carry, st.p, st.at, st.maxObjectSize);
  if (!header.ok) return waitOr(st, header.error);
  const type = header.value.type;
  st.offset = st.at;
  st.type = type;
  st.size = header.value.size;
  st.base = NO_BASE;
  advance(st, header.value.next - st.p);
  switch (type) {
    case OBJ_COMMIT: case OBJ_TREE: case OBJ_BLOB: case OBJ_TAG:
      st.phase = 'gate';
      return CONT;
    case OBJ_OFS_DELTA:
      st.phase = 'ofs';
      return CONT;
    case OBJ_REF_DELTA:
      st.phase = 'ref';
      return CONT;
  }
  // Stryker disable next-line ConditionalExpression: unreachable, readObjHeader parsed the type into one of the six
  return assertNever(type);
}
function stepOfs(st: PackScan): Step {
  const ofs = readOfsDelta(st.carry, st.p);
  if (!ofs.ok) return waitOr(st, ofs.error);
  advance(st, ofs.value.next - st.p);
  // git index-pack: "delta base offset is out of bound" unless 0 < base < this object (packresolve.ts parsePack)
  if (ofs.value.off === 0) return refuse(st, plyError('pack_corrupt', `pack: ofs delta at ${st.offset} is its own base`));
  const baseOffset = st.offset - ofs.value.off;
  if (baseOffset < PACK_HEADER_BYTES) return refuse(st, plyError('pack_corrupt', `pack: ofs delta base before pack start at ${st.offset}`));
  st.base = { tag: 'ofs', offset: baseOffset };
  st.phase = 'gate';
  return CONT;
}
// parsePack reads a REF_DELTA's base oid as a view: its buffer always holds a trailer past it. A scan that has seen
// the input close with fewer than 20 bytes here has no trailer either; that is the trailer refusal parsePack gives.
function stepRef(st: PackScan): Step {
  if (available(st) < OID_BYTES) {
    if (!st.ended) return NEED;
    return refuse(st, plyError('pack_corrupt', `pack: expected trailer at ${st.at}, pack length ${st.total}`));
  }
  st.base = { tag: 'ref', oid: toOid(st.carry.subarray(st.p, st.p + OID_BYTES)) };
  advance(st, OID_BYTES);
  st.phase = 'gate';
  return CONT;
}
// The declared size against the aggregate cap, before an inflated byte exists (readObjHeader held it to maxObjectSize).
function stepGate(st: PackScan): Step {
  if (st.budget.tag === 'retain') {
    const cost = st.size + LIMIT_OBJECT_OVERHEAD;
    if (st.charged + cost > st.maxInflatedTotal) return refuse(st, limitExceeded('pack inflated bytes', st.charged + cost, st.maxInflatedTotal));
    st.charged += cost;
  }
  st.headerBytes = st.at - st.offset;
  // the size passed the cap on the line above, and the cap passed parseLimits: the reset cannot refuse
  const opened = inflateReset(st.inflate, { bound: declaredBound(st.size, st.maxObjectSize), wrap: zlibWrap(true) });
  // Stryker disable next-line all: see above
  if (!opened.ok) return refuse(st, opened.error);
  // the member's bytes are the inflate record's from here; the scan's carry is empty until the member ends
  inflateFeed(st.inflate, st.carry.subarray(st.p));
  st.carry = EMPTY;
  st.p = 0;
  st.phase = 'body';
  return piece({ kind: 'object', index: st.index, offset: st.offset, headerBytes: st.headerBytes, type: st.type, size: st.size, base: st.base });
}
// The bytes just inflated against a work budget; false when the scan has refused. A retain budget charged at the gate.
function chargeWork(st: PackScan, inflated: number): boolean {
  if (st.budget.tag !== 'work') return true;
  st.charged += inflated;
  const allowed = Math.max(st.maxInflatedTotal, st.budget.ratio * (st.at + inflateConsumed(st.inflate)));
  if (st.charged <= allowed) return true;
  refuse(st, limitExceeded('pack inflated work', st.charged, allowed));
  return false;
}
function stepBody(st: PackScan): Step {
  const stream = st.inflate;
  const pulled = st.ended ? inflateEnd(stream) : inflatePull(stream);
  if (!pulled.ok) return refuse(st, pulled.error);
  const got = pulled.value;
  switch (got.kind) {
    case 'need': return NEED;
    case 'chunk':
      if (!chargeWork(st, got.bytes.length)) return FAILED;
      return piece({ kind: 'chunk', index: st.index, bytes: got.bytes });
    case 'end': {
      // what followed the member is the scan's again
      st.carry = inflateUnread(stream);
      st.p = 0;
      st.at += got.consumed;
      const index = st.index;
      st.index += 1;
      st.phase = st.index < st.count ? 'object' : 'trailer';
      return piece({ kind: 'object-end', index, compressed: got.consumed, stats: got.stats });
    }
  }
  // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(got);
}
// The trailer is the 20 bytes after the last object and nothing after them: known when the input closes.
function stepTrailer(st: PackScan): Step {
  if (!st.ended) return NEED;
  if (st.at + PACK_TRAILER_BYTES !== st.total) return refuse(st, plyError('pack_corrupt', `pack: expected trailer at ${st.at}, pack length ${st.total}`));
  const trailer = toHex(st.lag);
  if (st.hash.kind === 'on') {
    const computed = st.hash.sha.hex();
    if (computed !== trailer) return refuse(st, plyError('pack_corrupt', `pack: trailer sha mismatch ${trailer} != ${computed}`));
  }
  st.phase = 'end';
  return piece({ kind: 'trailer', trailer });
}

function step(st: PackScan): Step {
  switch (st.phase) {
    case 'header': return stepHeader(st);
    case 'object': return stepObject(st);
    case 'ofs': return stepOfs(st);
    case 'ref': return stepRef(st);
    case 'gate': return stepGate(st);
    case 'body': return stepBody(st);
    case 'trailer': return stepTrailer(st);
    case 'end': return piece(END_PIECE);
  }
  // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(st.phase);
}
// The next event, or the refusal (every later pull returns it again).
// @decoder parsePackPull prefix=pack
export function parsePackPull(st: PackScan): Result<PackPiece, PackError> {
  for (;;) {
    if (st.halt.tag === 'failed') return err(st.halt.error);
    const s = step(st);
    if (s.kind === 'piece') return ok(s.piece);
  }
}
// Close the input and pull.
// @decoder parsePackEnd prefix=pack
export function parsePackEnd(st: PackScan): Result<PackPiece, PackError> {
  parsePackClose(st);
  return parsePackPull(st);
}

export const streamPackAttrs = (st: PackScan): Attrs => ({
  'git.pack.phase': st.phase, 'git.pack.objects': st.index, 'git.pack.offset': st.at, 'git.pack.bytes': st.total, 'git.pack.ended': st.ended,
});