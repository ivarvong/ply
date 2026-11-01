// Pack parsing and delta resolution (buffered, general-purpose): parsePack walks a whole pack verifying the trailer,
// applyDelta is git's patch_delta, resolvePack resolves OFS/REF chains to a fixpoint with external bases as a last
// resort, makeDelta is a general delta generator. The edit pipeline needs none of this (fetch.js/fetchObject +
// pack.js/spliceDelta); it is here for the general client and re-exported from pack.js for callers.
import type { ErrorOf } from './errors.js';
import { fail, plyError, orThrow } from './errors.js';
import type { Err, Result } from './result.js';
import { ok, err, assertNever } from './result.js';
import type { InflateStats } from './inflate.js';
import { inflateResult } from './inflate.js';
import { Sha1, toHex } from './sha1.js';
import { TYPE, TYPE_NAME, hashObject } from './objects.js';
import type { LimitKey, Limits } from './limits.js';
import { DEFAULT_LIMITS, limitError, requireLimit, checkLimit, readLimit } from './limits.js';
// pack.js re-exports this module's parsers: a cycle of a re-export and one function, which ES modules resolve
// oxlint-disable-next-line import/no-cycle -- see above
import { spliceDelta } from './pack.js';
import { takeResult, shortRead } from './bytes.js';
import {
  PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, PACK_TRAILER_BYTES, OID_BYTES, UINT32_BYTES,
  DELTA_SIZE_MIN, DELTA_COPY, DELTA_COPY_MAX, DELTA_OFF4_FACTOR, DELTA_OFF_SHIFT,
  DELTA_COPY_OFF1, DELTA_COPY_OFF2, DELTA_COPY_OFF3, DELTA_COPY_OFF4,
  DELTA_COPY_LEN1, DELTA_COPY_LEN2, DELTA_COPY_LEN3, DELTA_BYTE2_SHIFT,
  OBJ_TYPE_SHIFT, OBJ_TYPE_MASK, OBJ_SIZE_FIRST_MASK, OBJ_SIZE_NEXT_MASK, OBJ_CONTINUE,
  OBJ_SIZE_NEXT_BASE, VARINT_BITS, VARINT_MAX_SHIFT, varintScale, BE32_SHIFTS,
} from './format.js';

type Corrupt = ErrorOf<'pack_corrupt'>;
// Everything a buffered pack can be refused for: corrupt bytes, a limit, or a caller's limit that bounds nothing.
export type PackError = Corrupt | ErrorOf<'limit_exceeded'> | ErrorOf<'bad_request'>;
const corrupt = (msg: string): Err<Corrupt> => fail('pack_corrupt', msg);
const short = (buf: Uint8Array, p: number): Err<Corrupt> => err(shortRead('pack_corrupt', p, 1, buf.length));
// TYPE_NAME's keys are the type numbers; read by a type number, a name may be absent (a widening, so no runtime alias).
type TypeNames = Readonly<Record<number, PackKind | undefined>>;
// Indexed reads in range of a checked length say `as number` (free at runtime, unlike a `?? 0` per byte; not the `!`
// src/ forbids). A read that may run past the end reads `buf[p]` and checks it against undefined: a short read.

// The six pack object types git writes (pack.h OBJ_*): four objects and two deltas. 0 and 5 name nothing.
export type PackKind = 'commit' | 'tree' | 'blob' | 'tag' | 'ofs_delta' | 'ref_delta';

// Past VARINT_MAX_SHIFT a group used to scale by Infinity, and 0 × Infinity is NaN: every `size > limit` check is false
// on NaN, so the size reached callers (#13). Checked before the byte is read, so a hostile header costs ≤ 10 bytes.
const varintLong = (what: string): Err<Corrupt> => corrupt(`${what}: size varint longer than ${VARINT_MAX_SHIFT + 1} bits`);

// Little-endian 7-bit groups from start, each with a continue bit: the delta header's sizes (from n = 0, shift = 0), and
// the rest of an object header's size after a first byte that continues (from that byte's four bits, shift = 4).
function readVarint(buf: Uint8Array, start: number, what: string, n0 = 0, shift0 = 0): Result<readonly [number, number], Corrupt> {
  let p = start;
  let n = n0;
  let shift = shift0;
  let c: number | undefined;
  do {
    if (shift > VARINT_MAX_SHIFT) return varintLong(what);
    c = buf[p];
    if (c === undefined) return short(buf, p);
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
  const c = buf[start];
  if (c === undefined) return short(buf, start);
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
  let c = buf[p];
  if (c === undefined) return short(buf, p);
  p += 1;
  let off = c & OBJ_SIZE_NEXT_MASK;
  let shift = VARINT_BITS;
  while (c & OBJ_CONTINUE) {
    if (shift > VARINT_MAX_SHIFT) return corrupt(`pack: ofs delta offset longer than ${VARINT_MAX_SHIFT + 1} bits`);
    c = buf[p];
    if (c === undefined) return short(buf, p);
    p += 1;
    off = ((off + 1) * OBJ_SIZE_NEXT_BASE) + (c & OBJ_SIZE_NEXT_MASK);
    shift += VARINT_BITS;
  }
  return ok({ off, next: p });
}
// @decoder readOfsDelta prefix=ofs-delta
export function readOfsDelta(buf: Uint8Array, start: number): OfsDelta { return orThrow(readOfsDeltaResult(buf, start)); }

// ---- parse ----
// Caps are required. A missing field used to become Infinity (`??`), which disabled the check; checkLimit rejects that.
// Each key's cap is the caller's override at the same index when it gave one, else limits[key]; the first cap that
// bounds nothing is the error. One cap per key, in order, so the result has keys.length entries.
type Caps = readonly [number, number, number];
function capsOf(limits: Limits, keys: readonly [LimitKey, LimitKey, LimitKey], given: readonly unknown[] = []): Result<Caps, ErrorOf<'bad_request'>> {
  const out: number[] = [];
  for (const [i, k] of keys.entries()) {
    const r = given[i] === undefined ? readLimit(limits, k) : checkLimit(given[i], k);
    if (!r.ok) return r;
    out.push(r.value);
  }
  // three keys, three caps (the loop above)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  return ok(out as unknown as Caps);
}
export type PackParseOptions = {
  readonly verify?: boolean | undefined;
  readonly limits?: Limits | undefined;
  readonly maxObjects?: number | undefined;
  readonly maxInflatedTotal?: number | undefined;
};
export const packParseOpts = (limits: Limits = DEFAULT_LIMITS): { limits: Limits; maxObjects: number; maxInflatedTotal: number } => ({ limits, maxObjects: requireLimit(limits, 'maxPackObjects'), maxInflatedTotal: requireLimit(limits, 'maxInflatedTotal') });

// One object as parsePack read it. A full object has neither base; an OFS_DELTA has baseOffset, a REF_DELTA baseOid.
// resolvePack sets `oid` on full objects.
export type PackObject = {
  readonly offset: number;
  readonly headerBytes: number;
  readonly type: number;
  readonly size: number;
  readonly compressed: number;
  readonly data: Uint8Array;
  readonly baseOffset: number | undefined;
  readonly baseOid: string | undefined;
  readonly inflate: InflateStats;
  oid?: string;
};
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
// oxlint-disable-next-line eslint/complexity -- one decoder loop (header, per-object header by exhaustive kind, body, trailer)
export function parsePackResult(buf: Uint8Array, opts: PackParseOptions = {}): Result<ParsedPack, PackError> {
  const verify = opts.verify !== false;
  const limits = opts.limits ?? DEFAULT_LIMITS;
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
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    const kind = (TYPE_NAME as TypeNames)[type];
    switch (kind) {
      case 'commit': case 'tree': case 'blob': case 'tag': stats.full++; break;
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
        break;
      }
      case 'ref_delta': {
        // a view: the pack's 20-byte trailer is still ahead of p (buf holds minPack bytes, and every object header byte
        // read so far came before the trailer), so OID_BYTES at p are inside buf; the trailer check below places them
        baseOid = toHex(buf.subarray(p, p + OID_BYTES)); p += OID_BYTES;
        stats.refDelta++;
        break;
      }
      case undefined: return corrupt(`pack: bad object type ${type} at ${offset}`);
      // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
      default: return assertNever(kind);
    }
    if (size > maxObjectSize) return err(limitError('pack object size', size, maxObjectSize));
    // Declared inflated size is known before zlib runs, so an inflate bomb is refused before the output buffer exists.
    if (stats.inflated + size > maxInflatedTotal) return err(limitError('pack inflated bytes', stats.inflated + size, maxInflatedTotal));
    const z = inflateResult(buf, p, { expectedSize: size, maxOutput: maxObjectSize });
    if (!z.ok) return z;
    const { out, consumed, stats: is } = z.value;
    stats.compressed += consumed; stats.inflated += size;
    stats.inflate.blocks += is.blocks; stats.inflate.stored += is.stored; stats.inflate.fixed += is.fixed; stats.inflate.dynamic += is.dynamic;
    stats.byType[kind] = (stats.byType[kind] ?? 0) + 1;
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
// @decoder applyDeltaResult prefix=delta
// oxlint-disable-next-line eslint/complexity -- one decoder: git's patch_delta, an opcode loop with seven optional bytes
export function applyDeltaResult(base: Uint8Array, delta: Uint8Array, opts: { readonly maxResult?: number | undefined } = {}): Result<Patched, PackError> {
  let maxResult = DEFAULT_LIMITS.maxDeltaResult;
  if (opts.maxResult !== undefined) {
    const m = checkLimit(opts.maxResult, 'maxDeltaResult');
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
  const deltaByte = (): number => delta[p++] ?? 0;
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
export function applyDelta(base: Uint8Array, delta: Uint8Array, opts: { readonly maxResult?: number | undefined } = {}): Patched { return orThrow(applyDeltaResult(base, delta, opts)); }

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
// `type` is the pack type number of a commit, tree, blob or tag. The bytes are that object, so
// hashObject(type, data) is `oid`. Anything else is refused before applyDelta (externalBase).
export type ExternalBase = { readonly type: number; readonly data: Uint8Array };
export type ResolvedObject = {
  readonly type: number;
  readonly data: Uint8Array;
  readonly chain: number;
  readonly deltaOps?: DeltaOps;
  readonly oid: string;
  readonly offset: number;
  readonly size: number;
  readonly compressed: number;
  readonly baseOffset: number | undefined;
  readonly baseOid: string | undefined;
};
// What resolvePack reads of a parsed pack: parsePack's result, or a hand-built one (stats optional).
export type PackToResolve = { readonly objects: readonly PackObject[]; readonly stats?: { readonly inflated?: number | undefined } | undefined };
export type ResolvedPack = { readonly objects: Map<string, ResolvedObject>; readonly stats: { maxChain: number; externalBases: number; baseLookups: number } };
type Base = { readonly type: number; readonly data: Uint8Array; readonly chain: number };

// git hash-object stores only these four. A delta type, or 0 or 5, is not an object an oid can name.
function storedKind(type: number): 'commit' | 'tree' | 'blob' | 'tag' | null {
  if (type === TYPE.COMMIT) return 'commit';
  if (type === TYPE.TREE) return 'tree';
  if (type === TYPE.BLOB) return 'blob';
  if (type === TYPE.TAG) return 'tag';
  return null;
}

// A thin REF base is the object git stored under that oid: SHA-1("type size\0" + body). A wrong type or wrong
// bytes hashes to a different oid, which is pack_corrupt before applyDelta. Pure, so the span stays on the fetch.
function externalBase(oid: string, ext: ExternalBase): Result<Base, Corrupt> {
  const kind = storedKind(ext.type);
  if (kind === null) return corrupt(`pack: ref delta base ${oid} has type ${ext.type}`);
  const hashed = hashObject(kind, ext.data);
  if (hashed !== oid) return corrupt(`pack: ref delta base ${oid} hashes to ${hashed}`);
  return ok({ type: ext.type, data: ext.data, chain: 0 });
}

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

// oxlint-disable-next-line eslint/complexity -- one fixpoint over the pack's objects
export function resolvePackResult(
  parsed: PackToResolve,
  external: (oid: string) => ExternalBase | null | undefined = () => null,
  limits: Limits = DEFAULT_LIMITS,
): Result<ResolvedPack, PackError> {
  const caps = capsOf(limits, ['maxDeltaChain', 'maxDeltaResult', 'maxInflatedTotal']);
  if (!caps.ok) return caps;
  const [maxChain, maxDelta, inflatedCap] = caps.value;
  const byOffset = new Map(parsed.objects.map(o => [o.offset, o]));
  // REF_DELTA lookup is this map, not parsed.objects.find (that scan is O(n) per delta, O(passes·n²) on a pack of tiny
  // ref-deltas). Resolved deltas join the same map.
  const byOid = new Map<string | undefined, PackObject>();
  const resolved = new Map<string, ResolvedObject>();
  const memo = new Map<number, ResolvedObject>();
  const stats = { maxChain: 0, externalBases: 0, baseLookups: 0 };
  // Bytes already held (inflated instructions and bases) plus each delta result, which is a new buffer.
  // `?.` on data: a hand-built pack may leave it out (the parsed type says it is there)
  let held = parsed.stats?.inflated ?? parsed.objects.reduce((n, o) => n + (o.data?.length ?? 0), 0);
  let phase: Phase = 'in_pack';
  const failed = (error: PackError): Step => ({ tag: 'failed', error });
  const resolveObj = (obj: PackObject, depth = 0): Step => {
    const hit = memo.get(obj.offset);
    if (hit) return { tag: 'resolved', r: hit };
    if (depth > maxChain) return failed(limitError('delta chain depth', depth, maxChain));
    // the base: none (a full object), the object at baseOffset (OFS_DELTA), or the object named baseOid (REF_DELTA)
    let base: Base | undefined;
    if (obj.baseOffset !== undefined) {
      const b = byOffset.get(obj.baseOffset);
      if (!b) return failed(plyError('pack_corrupt', `pack: ofs delta base not at object boundary ${obj.baseOffset}`));
      const s = resolveObj(b, depth + 1);
      if (s.tag !== 'resolved') return s;
      base = s.r;
    } else if (obj.baseOid !== undefined) {
      stats.baseLookups++;
      const inPack = byOid.get(obj.baseOid);
      if (inPack) {
        const s = resolveObj(inPack, depth + 1);
        if (s.tag !== 'resolved') return s;
        base = s.r;
      } else {
        const ext = phase === 'external' ? external(obj.baseOid) : undefined;
        if (!ext) return { tag: 'waiting', oid: obj.baseOid };
        const checked = externalBase(obj.baseOid, ext);
        if (!checked.ok) return failed(checked.error);
        stats.externalBases++;
        base = checked.value;
      }
    }
    let core: Base & { deltaOps?: DeltaOps };
    let oid: string;
    if (base === undefined) {
      core = { type: obj.type, data: obj.data, chain: 0 };
      // a full object was hashed once, where the loop below registered it
      oid = obj.oid ?? hashObject(String((TYPE_NAME as TypeNames)[core.type]), core.data);
    } else {
      // Chain length, not recursion depth: a base resolved earlier comes back from memo, so depth alone let a chain
      // emitted base-first grow without bound (#14). An external base is chain 0.
      const chain = base.chain + 1;
      if (chain > maxChain) return failed(limitError('delta chain depth', chain, maxChain));
      // The result buffer does not exist until applyDelta passes maxResult. Room is what the aggregate cap has left.
      const room = inflatedCap - held;
      if (room < 0) return failed(limitError('pack inflated bytes', held, inflatedCap));
      const patched = applyDeltaResult(base.data, obj.data, { maxResult: Math.min(maxDelta, room) });
      if (!patched.ok) return failed(patched.error);
      held += patched.value.out.length;
      core = { type: base.type, data: patched.value.out, chain, deltaOps: patched.value.ops };
      oid = hashObject(String((TYPE_NAME as TypeNames)[core.type]), core.data);
    }
    const r: ResolvedObject = Object.assign(core, {
      oid, offset: obj.offset, size: obj.size, compressed: obj.compressed,
      baseOffset: obj.baseOffset, baseOid: obj.baseOid,
    });
    if (r.chain > stats.maxChain) stats.maxChain = r.chain;
    memo.set(obj.offset, r);
    resolved.set(r.oid, r);
    byOid.set(r.oid, obj);
    return { tag: 'resolved', r };
  };
  // Full objects first: each is hashed here, once, and registered, so a REF_DELTA finds it by id.
  for (const o of parsed.objects) {
    if (o.baseOffset !== undefined || o.baseOid !== undefined) continue;
    o.oid = hashObject(String((TYPE_NAME as TypeNames)[o.type]), o.data);
    byOid.set(o.oid, o);
    const s = resolveObj(o);
    if (s.tag === 'failed') return err(s.error);
  }
  // Until nothing is pending: a pass either resolves something, or moves to the external phase once, or ends in an
  // error. A REF chain emitted child-first resolves one link per pass, so the pass count is bounded by the chain check
  // above (≤ 2 · maxDeltaChain + 2), not by a pass ceiling that used to return the tail unresolved without an error (#14).
  let pending = parsed.objects.filter(o => o.baseOffset !== undefined || o.baseOid !== undefined);
  while (pending.length > 0) {
    const next: PackObject[] = [];
    let missing: string | undefined;
    for (const o of pending) {
      const s = resolveObj(o);
      switch (s.tag) {
        case 'resolved': break;
        case 'waiting': next.push(o); missing ??= s.oid; break;
        case 'failed': return err(s.error);
        // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
        default: return assertNever(s);
      }
    }
    if (next.length === pending.length) {
      // no progress even with external bases: the first waiting object's base is missing from the pack and the caller
      if (phase === 'external') return corrupt(`pack: ref delta base ${String(missing)} not found`);
      phase = 'external'; // every in-pack base is known now; the rest are thin bases
    }
    pending = next;
  }
  return ok({ objects: resolved, stats });
}
export function resolvePack(
  parsed: PackToResolve,
  external: (oid: string) => ExternalBase | null | undefined = () => null,
  limits: Limits = DEFAULT_LIMITS,
): ResolvedPack {
  return orThrow(resolvePackResult(parsed, external, limits));
}
