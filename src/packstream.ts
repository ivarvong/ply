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
import type { ErrorOf } from './errors.js';
import { plyError } from './errors.js';
import type { Result } from './result.js';
import { ok, err, assertNever } from './result.js';
import type { Limits } from './limits.js';
import { DEFAULT_LIMITS, LIMIT_OBJECT_OVERHEAD, limitExceeded, readLimit } from './limits.js';
import type { PackError } from './packresolve.js';
import { readObjHeader, readOfsDelta } from './packresolve.js';
import { Sha1, toHex } from './sha1.js';
import type { InflateStats, InflateStream } from './inflatestream.js';
import { inflateInit, inflateReset, inflateFeed, inflatePull, inflateEnd, inflateUnread, declaredBound, zlibWrap } from './inflatestream.js';
import type { Attrs } from './otel.js';
import {
  PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, PACK_TRAILER_BYTES, OID_BYTES, UINT32_BYTES, BE32_SHIFTS,
  OBJ_COMMIT, OBJ_TREE, OBJ_BLOB, OBJ_TAG, OBJ_OFS_DELTA, OBJ_REF_DELTA,
} from './format.js';

// Indexed reads below are inside a length the code has just checked; noUncheckedIndexedAccess cannot see that.
/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- in-range indexed reads, see above */

const EMPTY: Uint8Array = new Uint8Array(0);
const MIN_PACK: number = PACK_HEADER_BYTES + PACK_TRAILER_BYTES;

// An object's base: none (a full object), an offset in this pack (OFS_DELTA), or an oid (REF_DELTA).
export type PackBase =
  | { readonly kind: 'none' }
  | { readonly kind: 'ofs'; readonly offset: number }
  | { readonly kind: 'oid'; readonly oid: string };
const NO_BASE: PackBase = { kind: 'none' };
export type PackScanOpts = { readonly verify: boolean; readonly limits: Limits };
export const packScanOpts = (limits: Limits = DEFAULT_LIMITS, verify = true): PackScanOpts => ({ verify, limits });

export type PackPiece =
  | { readonly kind: 'need' }
  | { readonly kind: 'header'; readonly version: number; readonly count: number }
  | { readonly kind: 'object'; readonly index: number; readonly offset: number; readonly headerBytes: number; readonly type: number; readonly size: number; readonly base: PackBase }
  | { readonly kind: 'chunk'; readonly index: number; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'object-end'; readonly index: number; readonly compressed: number; readonly stats: InflateStats }
  | { readonly kind: 'trailer'; readonly trailer: string }
  | { readonly kind: 'end' };

export type PackPhase = 'header' | 'object' | 'ofs' | 'ref' | 'gate' | 'body' | 'trailer' | 'end';
type PackHash = { readonly kind: 'off' } | { readonly kind: 'on'; readonly sha: Sha1 };
export type PackHalt = { readonly tag: 'running' } | { readonly tag: 'failed'; readonly error: PackError };
const RUNNING: PackHalt = { tag: 'running' };

// Single owner, mutable so a pull resumes where the last one stopped.
export type PackScan = {
  phase: PackPhase;
  halt: PackHalt;
  maxObjects: number;
  maxInflatedTotal: number;
  maxObjectSize: number;
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
  type: number;
  size: number;
  base: PackBase;
  // one inflate record, reset for every member: the window and chunk buffers are allocated once per scan
  inflate: InflateStream;
};

const NEED_PIECE: PackPiece = { kind: 'need' };
const END_PIECE: PackPiece = { kind: 'end' };
// A step's answer: go on, a piece, or stopped (the refusal is on the record).
type Step = { readonly kind: 'cont' } | { readonly kind: 'piece'; readonly piece: PackPiece } | { readonly kind: 'failed' };
const CONT: Step = { kind: 'cont' };
const NEED: Step = { kind: 'piece', piece: NEED_PIECE };
const FAILED: Step = { kind: 'failed' };
const piece = (p: PackPiece): Step => ({ kind: 'piece', piece: p });
function refuse(st: PackScan, error: PackError): Step {
  st.halt = { tag: 'failed', error };
  return FAILED;
}

// @decoder parsePackInit prefix=pack
export function parsePackInit(opts: PackScanOpts): Result<PackScan, PackError> {
  const maxObjects = readLimit(opts.limits, 'maxPackObjects');
  if (!maxObjects.ok) return maxObjects;
  const maxInflatedTotal = readLimit(opts.limits, 'maxInflatedTotal');
  if (!maxInflatedTotal.ok) return maxInflatedTotal;
  const maxObjectSize = readLimit(opts.limits, 'maxObjectSize');
  if (!maxObjectSize.ok) return maxObjectSize;
  const inflate = inflateInit({ bound: declaredBound(0, maxObjectSize.value), wrap: zlibWrap(true) });
  if (!inflate.ok) return inflate;
  return ok({
    phase: 'header', halt: RUNNING, maxObjects: maxObjects.value, maxInflatedTotal: maxInflatedTotal.value, maxObjectSize: maxObjectSize.value,
    ended: false, carry: EMPTY, p: 0, at: 0, total: 0, lag: EMPTY, hash: opts.verify ? { kind: 'on', sha: new Sha1() } : { kind: 'off' },
    count: 0, index: 0, charged: 0, offset: 0, headerBytes: 0, type: 0, size: 0, base: NO_BASE, inflate: inflate.value,
  });
}

// Hash everything but the last PACK_TRAILER_BYTES bytes seen so far (spStep's lag, fetch.ts). The lag is kept with
// verify off too: it is the trailer.
function hashLagged(st: PackScan, bytes: Uint8Array): void {
  st.total += bytes.length;
  const lagged = st.lag.length + bytes.length;
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

const be32 = (b: Uint8Array, off: number): number =>
  // oxlint-disable-next-line no-magic-numbers -- off + 2 is the third byte of the four BE32_SHIFTS places
  (((b[off] as number) << (BE32_SHIFTS[0] as number)) | ((b[off + 1] as number) << (BE32_SHIFTS[1] as number)) | ((b[off + 2] as number) << (BE32_SHIFTS[2] as number)) | (b[off + UINT32_BYTES - 1] as number)) >>> 0;
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
function waitOr(st: PackScan, e: ErrorOf<'pack_corrupt'>): Step {
  if (e.reason === 'short_read' && !st.ended) return NEED;
  return refuse(st, e);
}
function stepObject(st: PackScan): Step {
  const header = readObjHeader(st.carry, st.p);
  if (!header.ok) return waitOr(st, header.error);
  st.offset = st.at;
  st.type = header.value.type;
  st.size = header.value.size;
  st.base = NO_BASE;
  advance(st, header.value.next - st.p);
  switch (st.type) {
    case OBJ_COMMIT: case OBJ_TREE: case OBJ_BLOB: case OBJ_TAG:
      st.phase = 'gate';
      return CONT;
    case OBJ_OFS_DELTA:
      st.phase = 'ofs';
      return CONT;
    case OBJ_REF_DELTA:
      st.phase = 'ref';
      return CONT;
    default:
      return refuse(st, plyError('pack_corrupt', `pack: bad object type ${st.type} at ${st.offset}`));
  }
}
function stepOfs(st: PackScan): Step {
  const ofs = readOfsDelta(st.carry, st.p);
  if (!ofs.ok) return waitOr(st, ofs.error);
  advance(st, ofs.value.next - st.p);
  // git index-pack: "delta base offset is out of bound" unless 0 < base < this object (packresolve.ts parsePack)
  if (ofs.value.off === 0) return refuse(st, plyError('pack_corrupt', `pack: ofs delta at ${st.offset} is its own base`));
  const baseOffset = st.offset - ofs.value.off;
  if (baseOffset < PACK_HEADER_BYTES) return refuse(st, plyError('pack_corrupt', `pack: ofs delta base before pack start at ${st.offset}`));
  st.base = { kind: 'ofs', offset: baseOffset };
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
  st.base = { kind: 'oid', oid: toHex(st.carry.subarray(st.p, st.p + OID_BYTES)) };
  advance(st, OID_BYTES);
  st.phase = 'gate';
  return CONT;
}
// The declared size against the caps, before an inflated byte exists (parsePack's order).
function stepGate(st: PackScan): Step {
  if (st.size > st.maxObjectSize) return refuse(st, limitExceeded('pack object size', st.size, st.maxObjectSize));
  const cost = st.size + LIMIT_OBJECT_OVERHEAD;
  if (st.charged + cost > st.maxInflatedTotal) return refuse(st, limitExceeded('pack inflated bytes', st.charged + cost, st.maxInflatedTotal));
  st.charged += cost;
  st.headerBytes = st.at - st.offset;
  const opened = inflateReset(st.inflate, { bound: declaredBound(st.size, st.maxObjectSize), wrap: zlibWrap(true) });
  if (!opened.ok) return refuse(st, opened.error);
  // the member's bytes are the inflate record's from here; the scan's carry is empty until the member ends
  inflateFeed(st.inflate, st.carry.subarray(st.p));
  st.carry = EMPTY;
  st.p = 0;
  st.phase = 'body';
  return piece({ kind: 'object', index: st.index, offset: st.offset, headerBytes: st.headerBytes, type: st.type, size: st.size, base: st.base });
}
function stepBody(st: PackScan): Step {
  const stream = st.inflate;
  const pulled = st.ended ? inflateEnd(stream) : inflatePull(stream);
  if (!pulled.ok) return refuse(st, pulled.error);
  const got = pulled.value;
  switch (got.kind) {
    case 'need': return NEED;
    case 'chunk': return piece({ kind: 'chunk', index: st.index, bytes: got.bytes });
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