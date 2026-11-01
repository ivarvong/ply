// Pack parsing and delta resolution (buffered, general-purpose): parsePack walks a whole pack verifying the trailer,
// applyDelta is git's patch_delta, resolvePack resolves OFS/REF chains to a fixpoint with external bases as a last
// resort, describePack reports that layout the way `git verify-pack -v` prints it (a thin base is data, not an error),
// makeDelta is a general delta generator. The edit pipeline needs none of this (fetch.js/fetchObject +
// pack.js/spliceDelta); it is here for the general client and re-exported from pack.js for callers.
import type { ErrorOf } from './errors.js';
import { fail, plyError, orThrow } from './errors.js';
import type { Err, Result } from './result.js';
import { ok, err, assertNever, flatMapOption, getOrElse, mapOption } from './result.js';
import { at, atOr, fromNullable, fromNullish, mapGet, readKey, type Input } from './absent.js';
import type { InflateStats } from './inflate.js';
import { inflateResult } from './inflate.js';
import { Sha1, toHex } from './sha1.js';
import { TYPE, hashObject, nameOfTypeId } from './objects.js';
import type { ObjType } from './objects.js';
import type { LimitKey, Limits } from './limits.js';
import { DEFAULT_LIMITS, limitError, requireLimit, checkLimit, readLimit } from './limits.js';
// pack.js re-exports this module's parsers: a cycle of a re-export and one function, which ES modules resolve
// oxlint-disable-next-line import/no-cycle -- see above
import { spliceDelta } from './pack.js';
import { takeResult, shortRead } from './bytes.js';
import type { PackKind } from './format.js';
import {
  PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, PACK_TRAILER_BYTES, OID_BYTES, UINT32_BYTES,
  DELTA_SIZE_MIN, DELTA_COPY, DELTA_COPY_MAX, DELTA_OFF4_FACTOR, DELTA_OFF_SHIFT,
  DELTA_COPY_OFF1, DELTA_COPY_OFF2, DELTA_COPY_OFF3, DELTA_COPY_OFF4,
  DELTA_COPY_LEN1, DELTA_COPY_LEN2, DELTA_COPY_LEN3, DELTA_BYTE2_SHIFT,
  OBJ_TYPE_SHIFT, OBJ_TYPE_MASK, OBJ_SIZE_FIRST_MASK, OBJ_SIZE_NEXT_MASK, OBJ_CONTINUE,
  OBJ_SIZE_NEXT_BASE, VARINT_BITS, VARINT_MAX_SHIFT, varintScale, BE32_SHIFTS,
} from './format.js';

export type { PackKind };
type Corrupt = ErrorOf<'pack_corrupt'>;
// Everything a buffered pack can be refused for: corrupt bytes, a limit, or a caller's limit that bounds nothing.
export type PackError = Corrupt | ErrorOf<'limit_exceeded'> | ErrorOf<'bad_request'>;
const corrupt = (msg: string): Err<Corrupt> => fail('pack_corrupt', msg);
const short = (buf: Uint8Array, p: number): Err<Corrupt> => err(shortRead('pack_corrupt', p, 1, buf.length));
// Indexed reads in range of a checked length say `as number` (free at runtime, unlike a fallback per byte; not the `!`
// src/ forbids). A read that may run past the end reads atOr(buf, p, NO_BYTE): NO_BYTE there is a short read.
const NO_BYTE = -1;

// The six pack object types git writes (pack.h OBJ_*): four objects and two deltas. 0 and 5 name nothing.
type HeaderType = PackKind | 'invalid';
const headerType = (n: number): HeaderType => {
  switch (n) {
    case TYPE.COMMIT:
    case TYPE.TREE:
    case TYPE.BLOB:
    case TYPE.TAG:
    case TYPE.OFS_DELTA:
    case TYPE.REF_DELTA:
      return nameOfTypeId(n);
    default:
      return 'invalid';
  }
};
// A type id this pack will hash. An id outside the six is corrupt, the same refusal as a bad header.
const objectName = (type: number): Result<PackKind, Corrupt> => {
  const kind = headerType(type);
  switch (kind) {
    case 'invalid': return corrupt(`pack: bad object type ${type}`);
    case 'commit':
    case 'tree':
    case 'blob':
    case 'tag':
    case 'ofs_delta':
    case 'ref_delta':
      return ok(kind);
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(kind);
};

// Past VARINT_MAX_SHIFT a group used to scale by Infinity, and 0 × Infinity is NaN: every `size > limit` check is false
// on NaN, so the size reached callers (#13). Checked before the byte is read, so a hostile header costs ≤ 10 bytes.
const varintLong = (what: string): Err<Corrupt> => corrupt(`${what}: size varint longer than ${VARINT_MAX_SHIFT + 1} bits`);

// Little-endian 7-bit groups from start, each with a continue bit: the delta header's sizes (from n = 0, shift = 0), and
// the rest of an object header's size after a first byte that continues (from that byte's four bits, shift = 4).
function readVarint(buf: Uint8Array, start: number, what: string, n0 = 0, shift0 = 0): Result<readonly [number, number], Corrupt> {
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
  // b holds four bytes at off and BE32_SHIFTS (format.js) has four entries: in range, see above
  /* oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style, no-magic-numbers -- see above; off + 1 and off + 2 are the middle bytes */
  (((b[off] as number) << (BE32_SHIFTS[0] as number)) | ((b[off + 1] as number) << (BE32_SHIFTS[1] as number)) | ((b[off + 2] as number) << (BE32_SHIFTS[2] as number)) | (b[off + BE32_SHIFTS.length - 1] as number)) >>> 0;
export function readUint32BEResult(buf: Uint8Array, off: number): Result<number, Corrupt> {
  const r = takeResult(buf, off, BE32_SHIFTS.length);
  return r.ok ? ok(be32(buf, off)) : r;
}
export const readUint32BE = (buf: Uint8Array, off: number): number => orThrow(readUint32BEResult(buf, off));

export type ObjHeader = { readonly type: number; readonly size: number; readonly next: number };
// A header cut by the end of the buffer is a short read (`reason: 'short_read'`): a stream parser waits for more bytes
// on that reason (fetch.ts spStep), and refuses anything else.
// @decoder readObjHeaderResult prefix=obj-header
export function readObjHeaderResult(buf: Uint8Array, start: number): Result<ObjHeader, Corrupt> {
  const c = atOr(buf, start, NO_BYTE);
  if (c === NO_BYTE) return short(buf, start);
  const type = (c >> OBJ_TYPE_SHIFT) & OBJ_TYPE_MASK;
  if (!(c & OBJ_CONTINUE)) return ok({ type, size: c & OBJ_SIZE_FIRST_MASK, next: start + 1 });
  const rest = readVarint(buf, start + 1, 'pack', c & OBJ_SIZE_FIRST_MASK, OBJ_TYPE_SHIFT);
  if (!rest.ok) return rest;
  return ok({ type, size: rest.value[0], next: rest.value[1] });
}
// @decoder readObjHeader prefix=obj-header
export function readObjHeader(buf: Uint8Array, start: number): ObjHeader { return orThrow(readObjHeaderResult(buf, start)); }

export type OfsDelta = { readonly off: number; readonly next: number };
// The same ten-byte cap as the size varints (readObjHeader): git's index-pack refuses an offset that overflows
// ("offset value overflow for delta base object"); past it the offset could only name a base before the pack start.
// @decoder readOfsDeltaResult prefix=ofs-delta
export function readOfsDeltaResult(buf: Uint8Array, start: number): Result<OfsDelta, Corrupt> {
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
// @decoder readOfsDelta prefix=ofs-delta
export function readOfsDelta(buf: Uint8Array, start: number): OfsDelta { return orThrow(readOfsDeltaResult(buf, start)); }

// ---- parse ----
// Caps are required. A missing field used to become Infinity (a nullish fallback), which disabled the check; checkLimit rejects that.
// Each key's cap is the caller's override at the same index when it gave one, else limits[key]; the first cap that
// bounds nothing is the error. One cap per key, in order, so the result has keys.length entries.
type Caps = readonly [number, number, number];
function capsOf(limits: Limits, keys: readonly [LimitKey, LimitKey, LimitKey], given: readonly unknown[] = []): Result<Caps, ErrorOf<'bad_request'>> {
  const out: number[] = [];
  for (const [i, k] of keys.entries()) {
    const g = at(given, i);
    const r = g.tag === 'some' ? checkLimit(g.value, k) : readLimit(limits, k);
    if (!r.ok) return r;
    out.push(r.value);
  }
  // three keys, three caps (the loop above)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  return ok(out as unknown as Caps);
}
// verify: check the trailer's SHA-1 (anything but false verifies); limits: the caps (DEFAULT_LIMITS); maxObjects and
// maxInflatedTotal: a cap that overrides the one in limits.
export type PackParseConfig = {
  readonly verify: boolean;
  readonly limits: Limits;
  readonly maxObjects: number;
  readonly maxInflatedTotal: number;
};
export type PackParseOptions = Input<PackParseConfig>;
export const packParseOpts = (limits: Limits = DEFAULT_LIMITS): { limits: Limits; maxObjects: number; maxInflatedTotal: number } => ({ limits, maxObjects: requireLimit(limits, 'maxPackObjects'), maxInflatedTotal: requireLimit(limits, 'maxInflatedTotal') });

// One object as parsePack read it. A full object has neither base (both null); an OFS_DELTA has baseOffset, a REF_DELTA
// baseOid. A base is read by its type (hasOfsBase, hasRefBase), so a hand-built object that leaves a base out is a full one.
export type PackObject = {
  readonly offset: number;
  readonly headerBytes: number;
  readonly type: number;
  readonly size: number;
  readonly compressed: number;
  readonly data: Uint8Array;
  readonly baseOffset: number | null;
  readonly baseOid: string | null;
  readonly inflate: InflateStats;
};
type Ofs = { readonly baseOffset: number };
type Ref = { readonly baseOid: string };
const hasOfsBase = <T extends { readonly baseOffset: number | null }>(o: T): o is T & Ofs => typeof o.baseOffset === 'number';
const hasRefBase = <T extends { readonly baseOid: string | null }>(o: T): o is T & Ref => typeof o.baseOid === 'string';
export type PackStats = {
  readonly version: number;
  readonly count: number;
  full: number;
  ofsDelta: number;
  refDelta: number;
  readonly byType: Record<string, number>;
  compressed: number;
  inflated: number;
  readonly inflate: { blocks: number; stored: number; fixed: number; dynamic: number };
};
export type ParsedPack = { readonly objects: PackObject[]; readonly stats: PackStats; readonly trailer: string; readonly bytes: number };

// @decoder parsePackResult prefix=pack
export function parsePackResult(buf: Uint8Array, opts: PackParseOptions = {}): Result<ParsedPack, PackError> {
  const verify = opts.verify !== false;
  const limits = getOrElse(fromNullish(opts.limits), DEFAULT_LIMITS);
  const caps = capsOf(limits, ['maxPackObjects', 'maxInflatedTotal', 'maxObjectSize'], [opts.maxObjects, opts.maxInflatedTotal]);
  if (!caps.ok) return caps;
  const [maxObjects, maxInflatedTotal, maxObjectSize] = caps.value;
  const minPack = PACK_HEADER_BYTES + PACK_TRAILER_BYTES;
  // Past the minPack check the header is a view, not a bounded read; the object loop's reads are bounded.
  if (buf.length < minPack || !buf.subarray(0, PACK_SIGNATURE.length).every((b, i) => b === PACK_SIGNATURE[i])) return corrupt('pack: bad signature');
  // both reads are inside minPack bytes (above): views, not bounded reads
  const version = be32(buf, PACK_SIGNATURE.length);
  const count = be32(buf, PACK_SIGNATURE.length + UINT32_BYTES);
  if (version !== PACK_VERSION) return corrupt(`pack: unsupported version ${version}`);
  // A hostile count must fail before the loop allocates one object record.
  if (count > maxObjects) return err(limitError('pack objects', count, maxObjects));
  const objects: PackObject[] = [];
  const stats: PackStats = { version, count, full: 0, ofsDelta: 0, refDelta: 0, byType: {}, compressed: 0, inflated: 0, inflate: { blocks: 0, stored: 0, fixed: 0, dynamic: 0 } };
  let p = PACK_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const offset = p;
    const header = readObjHeaderResult(buf, p);
    if (!header.ok) return header;
    const { type, size } = header.value;
    p = header.value.next;
    let baseOffset: number | null = null;
    let baseOid: string | null = null;
    const kindResult = ((): Result<PackKind, PackError> => {
      const raw = headerType(type);
      switch (raw) {
        case 'commit': case 'tree': case 'blob': case 'tag': stats.full++; return ok(raw);
        case 'ofs_delta': {
          const ofs = readOfsDeltaResult(buf, p);
          if (!ofs.ok) return ofs;
          p = ofs.value.next;
          baseOffset = offset - ofs.value.off;
          // git index-pack: "delta base offset is out of bound" unless 0 < base < this object. An offset of 0 names the
          // object itself, which used to recurse to the chain limit and come back limit_exceeded instead of corrupt.
          if (ofs.value.off === 0) return corrupt(`pack: ofs delta at ${offset} is its own base`);
          if (baseOffset < PACK_HEADER_BYTES) return corrupt(`pack: ofs delta base before pack start at ${offset}`);
          stats.ofsDelta++;
          return ok(raw);
        }
        case 'ref_delta': {
          // a view: the pack's 20-byte trailer is still ahead of p (buf holds minPack bytes, and every object header byte
          // read so far came before the trailer), so OID_BYTES at p are inside buf; the trailer check below places them
          baseOid = toHex(buf.subarray(p, p + OID_BYTES)); p += OID_BYTES;
          stats.refDelta++;
          return ok('ref_delta');
        }
        case 'invalid': return corrupt(`pack: bad object type ${type} at ${offset}`);
      }
      // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
      return assertNever(raw);
    })();
    if (!kindResult.ok) return kindResult;
    const kind = kindResult.value;
    if (size > maxObjectSize) return err(limitError('pack object size', size, maxObjectSize));
    // Declared inflated size is known before zlib runs, so an inflate bomb is refused before the output buffer exists.
    if (stats.inflated + size > maxInflatedTotal) return err(limitError('pack inflated bytes', stats.inflated + size, maxInflatedTotal));
    const z = inflateResult(buf, p, { expectedSize: size, maxOutput: maxObjectSize });
    if (!z.ok) return z;
    const { out, consumed, stats: is } = z.value;
    stats.compressed += consumed; stats.inflated += size;
    stats.inflate.blocks += is.blocks; stats.inflate.stored += is.stored; stats.inflate.fixed += is.fixed; stats.inflate.dynamic += is.dynamic;
    stats.byType[kind] = getOrElse(readKey(stats.byType, kind), 0) + 1;
    objects.push({ offset, headerBytes: p - offset, type, size, compressed: consumed, data: out, baseOffset, baseOid, inflate: is });
    p += consumed;
  }
  if (p + PACK_TRAILER_BYTES !== buf.length) return corrupt(`pack: expected trailer at ${p}, pack length ${buf.length}`);
  // the check above fixed the trailer's place: these are views
  const trailer = toHex(buf.subarray(p));
  const computed = verify ? new Sha1().update(buf.subarray(0, p)).hex() : null;
  if (verify && computed !== trailer) return corrupt(`pack: trailer sha mismatch ${trailer} != ${computed}`);
  return ok({ objects, stats, trailer, bytes: buf.length });
}
// @decoder parsePack prefix=pack
export function parsePack(buf: Uint8Array, opts: PackParseOptions = {}): ParsedPack { return orThrow(parsePackResult(buf, opts)); }

// ---- delta ----
export type DeltaOps = { copy: number; insert: number; copyBytes: number; insertBytes: number };
export type Patched = { out: Uint8Array; ops: DeltaOps };
// maxResult: the cap on the result's size (limits.maxDeltaResult when left out).
export type DeltaOptions = Input<{ readonly maxResult: number }>;
// @decoder applyDeltaResult prefix=delta
// oxlint-disable-next-line eslint/complexity -- one decoder: git's patch_delta, an opcode loop with seven optional bytes
export function applyDeltaResult(base: Uint8Array, delta: Uint8Array, opts: DeltaOptions = {}): Result<Patched, PackError> {
  let maxResult = DEFAULT_LIMITS.maxDeltaResult;
  const given = fromNullable(opts.maxResult);
  if (given.tag === 'some') {
    const m = checkLimit(given.value, 'maxDeltaResult');
    if (!m.ok) return m;
    maxResult = m.value;
  }
  if (delta.length < DELTA_SIZE_MIN) return corrupt('delta: shorter than DELTA_SIZE_MIN');
  // readVarint's reads are bounded, so a header that runs past the buffer is a short read before p can pass the end.
  const bs = readVarint(delta, 0, 'delta');
  if (!bs.ok) return bs;
  const rs = readVarint(delta, bs.value[1], 'delta');
  if (!rs.ok) return rs;
  const baseSize = bs.value[0];
  const resultSize = rs.value[0];
  let p = rs.value[1];
  if (resultSize > maxResult) return err(limitError('delta result size', resultSize, maxResult));
  if (baseSize !== base.length) return corrupt(`delta: base size ${baseSize} != ${base.length}`);
  const out = new Uint8Array(resultSize);
  let o = 0;
  const ops: DeltaOps = { copy: 0, insert: 0, copyBytes: 0, insertBytes: 0 };
  // The byte at p, then past it. Past the end it reads 0 and p passes delta.length, which the opcode checks once it has
  // read its bytes: a delta cut inside an opcode is a typed short read at delta.length, with no allocation per byte.
  const deltaByte = (): number => atOr(delta, p++, 0);
  while (p < delta.length) {
    const c = delta[p++] as number; // oxlint-disable-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- p < delta.length (the loop)
    if (c & DELTA_COPY) {
      // off and len are 0 until their first byte, so that byte is assigned, not or-ed in
      let off = 0;
      let len = 0;
      if (c & DELTA_COPY_OFF1) off = deltaByte();
      if (c & DELTA_COPY_OFF2) off |= deltaByte() << DELTA_OFF_SHIFT;
      if (c & DELTA_COPY_OFF3) off |= deltaByte() << DELTA_BYTE2_SHIFT;
      if (c & DELTA_COPY_OFF4) off += deltaByte() * DELTA_OFF4_FACTOR;
      if (c & DELTA_COPY_LEN1) len = deltaByte();
      if (c & DELTA_COPY_LEN2) len |= deltaByte() << DELTA_OFF_SHIFT;
      if (c & DELTA_COPY_LEN3) len |= deltaByte() << DELTA_BYTE2_SHIFT;
      if (p > delta.length) return short(delta, delta.length);
      if (len === 0) len = DELTA_COPY_MAX;
      if (off + len > base.length || o + len > resultSize) return corrupt('delta: copy out of range');
      out.set(base.subarray(off, off + len), o); o += len; // in range: checked on the line above
      ops.copy++; ops.copyBytes += len;
    } else if (c) {
      if (p + c > delta.length || o + c > resultSize) return corrupt('delta: insert out of range');
      out.set(delta.subarray(p, p + c), o); o += c; p += c; // in range: checked on the line above
      ops.insert++; ops.insertBytes += c;
    } else return corrupt('delta: reserved opcode 0');
  }
  if (o !== resultSize) return corrupt(`delta: produced ${o} != ${resultSize}`);
  return ok({ out, ops });
}
// @decoder applyDelta prefix=delta
export function applyDelta(base: Uint8Array, delta: Uint8Array, opts: DeltaOptions = {}): Patched { return orThrow(applyDeltaResult(base, delta, opts)); }

// Common-prefix/suffix delta between two buffers.
export function makeDelta(base: Uint8Array, target: Uint8Array): ReturnType<typeof spliceDelta> {
  let p = 0;
  const max = Math.min(base.length, target.length);
  while (p < max && base[p] === target[p]) p++;
  let s = 0;
  while (s < max - p && base[base.length - 1 - s] === target[target.length - 1 - s]) s++;
  // p + s <= min(base.length, target.length) by the loops above: a view, it cannot be short
  return spliceDelta({ baseLen: base.length, off: p, oldLen: base.length - p - s, insert: target.subarray(p, target.length - s) });
}

// ---- resolve ----
// objects from parsePack; external(oid) -> {type, data} for thin bases. Returns Map oid -> resolved.
// A base from outside the pack (a thin pack's), as the caller's `external` returns it.
export type ExternalBase = { readonly type: number; readonly data: Uint8Array };
// The caller's lookup of a thin base by id. Anything falsy (null, or a JavaScript function's bare `return`) is "not
// here"; `void` is how a function type admits that bare return.
// oxlint-disable-next-line typescript/no-invalid-void-type -- a JavaScript caller's lookup may return nothing (see above)
export type ExternalLookup = (oid: string) => ExternalBase | null | void;
// A full object as resolvePack returns it; a delta's result also carries its delta's opcode counts.
export type ResolvedFull = {
  readonly type: number;
  readonly data: Uint8Array;
  readonly chain: number;
  readonly oid: string;
  readonly offset: number;
  readonly size: number;
  readonly compressed: number;
  readonly baseOffset: number | null;
  readonly baseOid: string | null;
};
export type ResolvedDelta = ResolvedFull & { readonly deltaOps: DeltaOps };
export type ResolvedObject = ResolvedFull | ResolvedDelta;
// What resolvePack reads of a parsed pack: parsePack's result, or a hand-built one (stats optional).
export type PackToResolve = { readonly objects: readonly PackObject[] } & Input<{ readonly stats: Input<{ readonly inflated: number }> }>;
export type ResolvedPack = { readonly objects: Map<string, ResolvedObject>; readonly stats: { maxChain: number; externalBases: number; baseLookups: number } };
type Base = { readonly type: number; readonly data: Uint8Array; readonly chain: number };

// One object's resolution: done, waiting on a REF_DELTA base that has not been resolved yet (in this phase), or refused.
// `waiting` is the typed form of what used to be a pack_corrupt "ref delta base … not found" caught back by a regex on
// its message (#76).
type Step =
  | { readonly tag: 'resolved'; readonly r: ResolvedObject }
  | { readonly tag: 'waiting'; readonly oid: string }
  | { readonly tag: 'failed'; readonly error: PackError };
// The fixpoint's phase: REF_DELTA bases from the pack only, until a pass makes no progress; then the caller's
// `external` lookup too (a thin pack's bases); then, if a pass still makes no progress, the first waiting object's
// missing base is the error.
type Phase = 'in_pack' | 'external';

// A REF_DELTA whose base is not in the pack, kept instead of refused. `oid` is that missing base (the root the fixpoint
// was waiting on), in pack order of the objects that could not be resolved.
export type UnresolvedBase = { readonly object: PackObject; readonly oid: string };
export type CollectedPack = ResolvedPack & { readonly unresolved: readonly UnresolvedBase[] };

// A thin REF base must be exactly the object git stored under that oid: the four stored types only
// (commit, tree, blob, tag), and the SHA-1 of "type SP size NUL" + bytes must equal the named oid.
// Anything else is pack_corrupt before applyDelta.
function externalBase(oid: string, ext: ExternalBase): Result<Base, Corrupt> {
  switch (ext.type) {
    case TYPE.COMMIT:
    case TYPE.TREE:
    case TYPE.BLOB:
    case TYPE.TAG: {
      const kind = nameOfTypeId(ext.type);
      // kind is one of commit|tree|blob|tag here
      const hashed = hashObject(kind, ext.data);
      if (hashed !== oid) return corrupt(`pack: ref delta base ${oid} hashes to ${hashed}`);
      return ok({ type: ext.type, data: ext.data, chain: 0 });
    }
    default:
      // a delta type, 0, 5, or any other non-object id
      return corrupt(`pack: ref delta base ${oid} has type ${ext.type}`);
  }
}

// The fixpoint. `collectMissing` is describePack's path: a thin base is data, not an error. Without it a thin base the
// lookup does not have is refused (`pack: ref delta base … not found`), which callers and the pack-cut space depend on.
function fixpoint(parsed: PackToResolve, external: ExternalLookup, limits: Limits, collectMissing: boolean): Result<CollectedPack, PackError> {
  const caps = capsOf(limits, ['maxDeltaChain', 'maxDeltaResult', 'maxInflatedTotal']);
  if (!caps.ok) return caps;
  const [maxChain, maxDelta, inflatedCap] = caps.value;
  const byOffset = new Map(parsed.objects.map(o => [o.offset, o]));
  // REF_DELTA lookup is this map, not parsed.objects.find (that scan is O(n) per delta, O(passes·n²) on a pack of tiny
  // ref-deltas). Resolved deltas join the same map.
  const byOid = new Map<string, PackObject>();
  const resolved = new Map<string, ResolvedObject>();
  const memo = new Map<number, ResolvedObject>();
  const stats = { maxChain: 0, externalBases: 0, baseLookups: 0 };
  // Bytes already held (inflated instructions and bases) plus each delta result, which is a new buffer.
  // fromNullish on data: a hand-built pack may leave it out (the parsed type says it is there)
  const given = flatMapOption(fromNullish(parsed.stats), s => fromNullish(s.inflated));
  let held = given.tag === 'some' ? given.value : parsed.objects.reduce((n, o) => n + getOrElse(mapOption(fromNullish(o.data), d => d.length), 0), 0);
  let phase: Phase = 'in_pack';
  const failed = (error: PackError): Step => ({ tag: 'failed', error });
  // The base: none (a full object), the object at baseOffset (OFS_DELTA), or the object named baseOid (REF_DELTA).
  type BaseOrStep = { readonly tag: 'full' } | { readonly tag: 'base'; readonly base: Base } | Step;
  function findBase(obj: PackObject, depth: number, resolveFn: (o: PackObject, d: number) => Step): BaseOrStep {
    if (hasOfsBase(obj)) {
      const b = mapGet(byOffset, obj.baseOffset);
      if (b.tag === 'none') return failed(plyError('pack_corrupt', `pack: ofs delta base not at object boundary ${obj.baseOffset}`));
      const s = resolveFn(b.value, depth + 1);
      if (s.tag !== 'resolved') return s;
      return { tag: 'base', base: s.r };
    }
    if (hasRefBase(obj)) {
      stats.baseLookups++;
      const inPack = mapGet(byOid, obj.baseOid);
      if (inPack.tag === 'some') {
        const s = resolveFn(inPack.value, depth + 1);
        if (s.tag !== 'resolved') return s;
        return { tag: 'base', base: s.r };
      }
      if (phase !== 'external') return { tag: 'waiting', oid: obj.baseOid };
      const ext = external(obj.baseOid);
      if (!ext) return { tag: 'waiting', oid: obj.baseOid };
      const checked = externalBase(obj.baseOid, ext);
      if (!checked.ok) return failed(checked.error);
      stats.externalBases++;
      return { tag: 'base', base: checked.value };
    }
    return { tag: 'full' };
  }
  // The object's resolved form, from its own bytes (a full object) or its base's bytes patched by its delta.
  function build(obj: PackObject, b: { readonly tag: 'full' } | { readonly tag: 'base'; readonly base: Base }): Result<ResolvedObject, PackError> {
    const place = { offset: obj.offset, size: obj.size, compressed: obj.compressed, baseOffset: obj.baseOffset, baseOid: obj.baseOid };
    if (b.tag === 'full') {
      const hashed = objectName(obj.type);
      if (!hashed.ok) return hashed;
      return ok({ type: obj.type, data: obj.data, chain: 0, oid: hashObject(hashed.value, obj.data), ...place });
    }
    const base = b.base;
    // Chain length, not recursion depth: a base resolved earlier comes back from memo, so depth alone let a chain
    // emitted base-first grow without bound (#14). An external base is chain 0.
    const chain = base.chain + 1;
    if (chain > maxChain) return err(limitError('delta chain depth', chain, maxChain));
    // The result buffer does not exist until applyDelta passes maxResult. Room is what the aggregate cap has left.
    const room = inflatedCap - held;
    if (room < 0) return err(limitError('pack inflated bytes', held, inflatedCap));
    const patched = applyDeltaResult(base.data, obj.data, { maxResult: Math.min(maxDelta, room) });
    if (!patched.ok) return patched;
    held += patched.value.out.length;
    const hashed = objectName(base.type);
    if (!hashed.ok) return hashed;
    return ok({ type: base.type, data: patched.value.out, chain, deltaOps: patched.value.ops, oid: hashObject(hashed.value, patched.value.out), ...place });
  }
  function resolveObj(obj: PackObject, depth = 0): Step {
    const hit = mapGet(memo, obj.offset);
    if (hit.tag === 'some') return { tag: 'resolved', r: hit.value };
    if (depth > maxChain) return failed(limitError('delta chain depth', depth, maxChain));
    const b = findBase(obj, depth, resolveObj);
    if (b.tag !== 'base' && b.tag !== 'full') return b;
    const built = build(obj, b);
    if (!built.ok) return failed(built.error);
    const r = built.value;
    if (r.chain > stats.maxChain) stats.maxChain = r.chain;
    memo.set(obj.offset, r);
    resolved.set(r.oid, r);
    byOid.set(r.oid, obj);
    return { tag: 'resolved', r };
  }
  // Full objects first: each is hashed once (resolveObj) and registered, so a REF_DELTA finds it by id.
  for (const o of parsed.objects) {
    if (hasOfsBase(o) || hasRefBase(o)) continue;
    const s = resolveObj(o);
    if (s.tag === 'failed') return err(s.error);
  }
  // Until nothing is pending: a pass either resolves something, or moves to the external phase once, or ends in an
  // error. A REF chain emitted child-first resolves one link per pass, so the pass count is bounded by the chain check
  // above (≤ 2 · maxDeltaChain + 2), not by a pass ceiling that used to return the tail unresolved without an error (#14).
  let pending: PackObject[] = parsed.objects.filter(o => hasOfsBase(o) || hasRefBase(o));
  while (pending.length > 0) {
    const next: PackObject[] = [];
    let missingOid = '';
    let haveMissing = false;
    const waited: UnresolvedBase[] = [];
    for (const o of pending) {
      const s = resolveObj(o);
      switch (s.tag) {
        case 'failed': return err(s.error);
        case 'waiting':
          next.push(o);
          waited.push({ object: o, oid: s.oid });
          if (!haveMissing) { missingOid = s.oid; haveMissing = true; }
          continue;
        case 'resolved': continue;
      }
      // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
      return assertNever(s);
    }
    if (next.length === pending.length) {
      // no progress even with external bases: the first waiting object's base is missing from the pack and the caller
      if (phase === 'external') {
        if (collectMissing) return ok({ objects: resolved, stats, unresolved: waited });
        return corrupt(`pack: ref delta base ${missingOid} not found`);
      }
      phase = 'external'; // every in-pack base is known now; the rest are thin bases
    }
    pending = next;
  }
  return ok({ objects: resolved, stats, unresolved: [] });
}

// Stryker disable next-line ArrowFunction: null and a bare return both mean the base is not in the pack
const noBase = (): null => null;

// objects from parsePack; external(oid) -> {type, data} for thin bases. A thin base the lookup does not have is refused.
export function resolvePackResult(parsed: PackToResolve, external: ExternalLookup = noBase, limits: Limits = DEFAULT_LIMITS): Result<ResolvedPack, PackError> {
  const r = fixpoint(parsed, external, limits, false);
  return r.ok ? ok({ objects: r.value.objects, stats: r.value.stats }) : r;
}
export function resolvePack(parsed: PackToResolve, external: ExternalLookup = noBase, limits: Limits = DEFAULT_LIMITS): ResolvedPack {
  return orThrow(resolvePackResult(parsed, external, limits));
}

// ---- layout (git verify-pack -v) ----
// What verify-pack prints for one object, plus the wire type it does not print. `size` is the pack header's inflated
// size (the delta or the object), not the resolved object. `type` is the resolved object type, which a missing thin
// base hides. No span: this is a pure read of bytes already in hand; the span belongs to the fetch that received them.
export type ResolvedObjType = typeof TYPE.COMMIT | typeof TYPE.TREE | typeof TYPE.BLOB | typeof TYPE.TAG;
// An OFS_DELTA base is an offset, and the base object's id once that object resolved. A REF_DELTA base is an id,
// whether or not the object is in the pack.
export type PackBase =
  | { readonly offset: number; readonly oid: string | null }
  | { readonly oid: string };
export type PackLayoutObject = {
  readonly offset: number;
  readonly headerBytes: number;
  readonly compressed: number;
  readonly size: number;
  readonly wireType: ObjType;
  readonly type: ResolvedObjType | null;
  readonly oid: string | null;
  readonly base: PackBase | null;
  readonly depth: number;
};
export type PackLayout = {
  readonly version: typeof PACK_VERSION;
  readonly count: number;
  readonly trailer: string;
  readonly objects: readonly PackLayoutObject[];
  // First-seen unique REF bases that are not in the pack, in pack order. These are the objects
  // `git index-pack --fix-thin` appends.
  readonly missingBases: readonly string[];
};

function wireOf(n: number): Result<ObjType, Corrupt> {
  // parsePack refuses an id outside the six before layout. objectName is that same refusal, so a bad id is pack_corrupt.
  const named = objectName(n);
  if (!named.ok) return named;
  switch (named.value) {
    case 'commit': return ok(TYPE.COMMIT);
    case 'tree': return ok(TYPE.TREE);
    case 'blob': return ok(TYPE.BLOB);
    case 'tag': return ok(TYPE.TAG);
    case 'ofs_delta': return ok(TYPE.OFS_DELTA);
    case 'ref_delta': return ok(TYPE.REF_DELTA);
  }
  // Stryker disable next-line ConditionalExpression,CallExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(named.value);
}
function resolvedObjType(n: number): ResolvedObjType | null {
  switch (n) {
    case TYPE.COMMIT:
    case TYPE.TREE:
    case TYPE.BLOB:
    case TYPE.TAG:
      return n;
    // Stryker disable next-line ConditionalExpression: a resolved object's type is the base object's, one of the four
    default: return null;
  }
}
function baseOf(obj: PackObject, memo: ReadonlyMap<number, ResolvedObject>): PackBase | null {
  if (hasOfsBase(obj)) {
    const base = mapGet(memo, obj.baseOffset);
    return { offset: obj.baseOffset, oid: base.tag === 'some' ? base.value.oid : null };
  }
  if (hasRefBase(obj)) return { oid: obj.baseOid };
  return null;
}
// Depth of an object the fixpoint could not hash. That only happens when a REF base is outside the pack, and a
// resolved base would have resolved this object too, so the walk never lands on a memoised object. An external base
// is chain 0: a REF_DELTA on it is 1, and an OFS_DELTA on that object is one deeper. Same numbers verify-pack prints
// once index-pack has appended the base.
function chainDepth(obj: PackObject, byOffset: ReadonlyMap<number, PackObject>): number {
  if (!hasOfsBase(obj)) return 1;
  const base = mapGet(byOffset, obj.baseOffset);
  // Stryker disable next-line ConditionalExpression: an ofs offset that is not an object is pack_corrupt before layout
  if (base.tag === 'none') return 0;
  return chainDepth(base.value, byOffset) + 1;
}
function packLayout(parsed: ParsedPack, resolved: CollectedPack): Result<PackLayout, Corrupt> {
  const memo = new Map<number, ResolvedObject>();
  for (const r of resolved.objects.values()) memo.set(r.offset, r);
  const byOffset = new Map(parsed.objects.map(o => [o.offset, o]));
  const objects: PackLayoutObject[] = [];
  for (const obj of parsed.objects) {
    const wireType = wireOf(obj.type);
    if (!wireType.ok) return wireType;
    const found = mapGet(memo, obj.offset);
    const r = found.tag === 'some' ? found.value : null;
    objects.push({
      offset: obj.offset,
      headerBytes: obj.headerBytes,
      compressed: obj.compressed,
      size: obj.size,
      wireType: wireType.value,
      type: r ? resolvedObjType(r.type) : null,
      oid: r ? r.oid : null,
      base: baseOf(obj, memo),
      depth: r ? r.chain : chainDepth(obj, byOffset),
    });
  }
  const missingBases: string[] = [];
  const seenOid = new Set<string>();
  for (const u of resolved.unresolved) {
    if (seenOid.has(u.oid)) continue;
    seenOid.add(u.oid);
    missingBases.push(u.oid);
  }
  return ok({ version: PACK_VERSION, count: parsed.stats.count, trailer: parsed.trailer, objects, missingBases });
}

// The pack's layout as `git verify-pack -v` prints it. A thin REF base is `missingBases`, not an error and not a
// message to match. Limits are the same ones parse and resolve already enforce.
export function describePack(buf: Uint8Array, limits: Limits = DEFAULT_LIMITS): Result<PackLayout, PackError> {
  const parsed = parsePackResult(buf, { limits });
  if (!parsed.ok) return parsed;
  const resolved = fixpoint(parsed.value, noBase, limits, true);
  if (!resolved.ok) return resolved;
  return packLayout(parsed.value, resolved.value);
}
