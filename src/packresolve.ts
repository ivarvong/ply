// Pack parsing and delta resolution (buffered, general-purpose): parsePack walks a whole pack verifying the trailer,
// applyDelta is git's patch_delta, resolvePack resolves OFS/REF chains to a fixpoint with external bases as a last
// resort, makeDelta is a general delta generator. The edit pipeline needs none of this (fetch.js/fetchObject +
// pack.js/spliceDelta); it is here for the general client and re-exported from pack.js for callers.
import type { Thrown } from './errors.js';
import { thrown as fail } from './errors.js';
import type { InflateStats } from './inflate.js';
import { inflate } from './inflate.js';
import { Sha1, toHex } from './sha1.js';
import { TYPE, TYPE_NAME, hashObject } from './objects.js';
import type { LimitKey, Limits } from './limits.js';
import { DEFAULT_LIMITS, limitError, requireLimit, finiteLimit } from './limits.js';
// pack.js re-exports this module's parsers: a cycle of a re-export and one function, which ES modules resolve
// oxlint-disable-next-line import/no-cycle -- see above
import { spliceDelta } from './pack.js';
import { take } from './bytes.js';
import {
  PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, PACK_TRAILER_BYTES, OID_BYTES, UINT32_BYTES,
  DELTA_SIZE_MIN, DELTA_COPY, DELTA_COPY_MAX, DELTA_OFF4_FACTOR, DELTA_OFF_SHIFT,
  DELTA_COPY_OFF1, DELTA_COPY_OFF2, DELTA_COPY_OFF3, DELTA_COPY_OFF4,
  DELTA_COPY_LEN1, DELTA_COPY_LEN2, DELTA_COPY_LEN3, DELTA_BYTE2_SHIFT,
  OBJ_TYPE_SHIFT, OBJ_TYPE_MASK, OBJ_SIZE_FIRST_MASK, OBJ_SIZE_NEXT_MASK, OBJ_CONTINUE,
  OBJ_SIZE_NEXT_BASE, VARINT_BITS, VARINT_MAX_SHIFT, varintScale, BE32_SHIFTS,
} from './format.js';

const corrupt = (msg: string): Thrown => fail('pack_corrupt', msg);
// TYPE_NAME's keys are the type numbers; read by a type number, a name may be absent (a widening, so no runtime alias).
type TypeNames = Readonly<Record<number, string | undefined>>;
// take(buf, p, n)[i] with i < n is in range, which noUncheckedIndexedAccess cannot see: such reads say `as number` (free
// at runtime, unlike a `?? 0` per byte; not the `!` src/ forbids). Each carries the suppression below.

// Past VARINT_MAX_SHIFT a group used to scale by Infinity, and 0 × Infinity is NaN: every `size > limit` check is false
// on NaN, so the size reached callers (#13). Checked before the byte is read, so a hostile header costs ≤ 10 bytes.
function varintRoom(shift: number, what: string): void {
  if (shift > VARINT_MAX_SHIFT) throw corrupt(`${what}: size varint longer than ${VARINT_MAX_SHIFT + 1} bits`);
}

function readVarint(buf: Uint8Array, start: number): [number, number] {
  let p = start;
  let n = 0;
  let shift = 0;
  let c: number;
  do {
    varintRoom(shift, 'delta');
    c = take(buf, p, 1)[0] as number; // oxlint-disable-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- in range, see above
    p += 1;
    n += (c & OBJ_SIZE_NEXT_MASK) * varintScale(shift);
    shift += VARINT_BITS;
  } while (c & OBJ_CONTINUE);
  return [n, p];
}

export function readUint32BE(buf: Uint8Array, off: number): number {
  const b = take(buf, off, BE32_SHIFTS.length);
  // b and BE32_SHIFTS (format.js) both have four entries: in range, see above
  /* oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- see above */
  return (((b[0] as number) << (BE32_SHIFTS[0] as number)) | ((b[1] as number) << (BE32_SHIFTS[1] as number)) | ((b[2] as number) << (BE32_SHIFTS[2] as number)) | (b[BE32_SHIFTS.length - 1] as number)) >>> 0;
}

export type ObjHeader = { readonly type: number; readonly size: number; readonly next: number };
// @decoder readObjHeader prefix=obj-header
export function readObjHeader(buf: Uint8Array, start: number): ObjHeader {
  let p = start;
  let c = take(buf, p, 1)[0] as number; // oxlint-disable-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- in range
  const type = (c >> OBJ_TYPE_SHIFT) & OBJ_TYPE_MASK;
  let size = c & OBJ_SIZE_FIRST_MASK;
  let shift = OBJ_TYPE_SHIFT;
  p += 1;
  while (c & OBJ_CONTINUE) {
    varintRoom(shift, 'pack');
    c = take(buf, p, 1)[0] as number; // oxlint-disable-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- in range
    p += 1;
    size += (c & OBJ_SIZE_NEXT_MASK) * varintScale(shift);
    shift += VARINT_BITS;
  }
  return { type, size, next: p };
}

export type OfsDelta = { readonly off: number; readonly next: number };
// @decoder readOfsDelta prefix=ofs-delta
export function readOfsDelta(buf: Uint8Array, start: number): OfsDelta {
  let p = start;
  let c = take(buf, p, 1)[0] as number; // oxlint-disable-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- in range
  p += 1;
  let off = c & OBJ_SIZE_NEXT_MASK;
  while (c & OBJ_CONTINUE) {
    c = take(buf, p, 1)[0] as number; // oxlint-disable-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- in range
    p += 1;
    off = ((off + 1) * OBJ_SIZE_NEXT_BASE) + (c & OBJ_SIZE_NEXT_MASK);
  }
  return { off, next: p };
}

// ---- parse ----
// Caps are required. A missing field used to become Infinity (`??`), which disabled the check; finiteLimit rejects that.
const capOf = (value: unknown, limits: Limits, key: LimitKey): number => (value === undefined ? requireLimit(limits, key) : finiteLimit(value, key));
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

// @decoder parsePack prefix=pack
// oxlint-disable-next-line eslint/complexity -- one decoder loop (header, per-object header and body, trailer)
export function parsePack(buf: Uint8Array, opts: PackParseOptions = {}): ParsedPack {
  const verify = opts.verify !== false;
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const maxObjects = capOf(opts.maxObjects, limits, 'maxPackObjects');
  const maxInflatedTotal = capOf(opts.maxInflatedTotal, limits, 'maxInflatedTotal');
  const maxObjectSize = requireLimit(limits, 'maxObjectSize');
  const minPack = PACK_HEADER_BYTES + PACK_TRAILER_BYTES;
  // Past the minPack check the header is a view, not a bounded read; the object loop's reads are take()s.
  if (buf.length < minPack || !buf.subarray(0, PACK_SIGNATURE.length).every((b, i) => b === PACK_SIGNATURE[i])) throw corrupt('pack: bad signature');
  const version = readUint32BE(buf, PACK_SIGNATURE.length);
  const count = readUint32BE(buf, PACK_SIGNATURE.length + UINT32_BYTES);
  if (version !== PACK_VERSION) throw corrupt(`pack: unsupported version ${version}`);
  // A hostile count must fail before the loop allocates one object record.
  if (count > maxObjects) throw limitError('pack objects', count, maxObjects);
  const objects: PackObject[] = [];
  const stats: PackStats = { version, count, full: 0, ofsDelta: 0, refDelta: 0, byType: {}, compressed: 0, inflated: 0, inflate: { blocks: 0, stored: 0, fixed: 0, dynamic: 0 } };
  let p = PACK_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const offset = p;
    const header = readObjHeader(buf, p);
    const type = header.type;
    const size = header.size;
    p = header.next;
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (type === TYPE.OFS_DELTA) {
      const ofs = readOfsDelta(buf, p);
      p = ofs.next;
      baseOffset = offset - ofs.off;
      // git index-pack: "delta base offset is out of bound" unless 0 < base < this object. An offset of 0 names the
      // object itself, which used to recurse to the chain limit and come back limit_exceeded instead of corrupt.
      if (ofs.off === 0) throw corrupt(`pack: ofs delta at ${offset} is its own base`);
      if (baseOffset < PACK_HEADER_BYTES) throw corrupt(`pack: ofs delta base before pack start at ${offset}`);
      stats.ofsDelta++;
    } else if (type === TYPE.REF_DELTA) {
      baseOid = toHex(take(buf, p, OID_BYTES)); p += OID_BYTES;
      stats.refDelta++;
    } else if (type >= TYPE.COMMIT && type <= TYPE.TAG) stats.full++;
    else throw corrupt(`pack: bad object type ${type} at ${offset}`);
    if (size > maxObjectSize) throw limitError('pack object size', size, maxObjectSize);
    // Declared inflated size is known before zlib runs, so an inflate bomb is refused before the output buffer exists.
    if (stats.inflated + size > maxInflatedTotal) throw limitError('pack inflated bytes', stats.inflated + size, maxInflatedTotal);
    const { out, consumed, stats: is } = inflate(buf, p, { expectedSize: size, maxOutput: maxObjectSize });
    stats.compressed += consumed; stats.inflated += size;
    stats.inflate.blocks += is.blocks; stats.inflate.stored += is.stored; stats.inflate.fixed += is.fixed; stats.inflate.dynamic += is.dynamic;
    // type is one of the four object types or a delta (checked above), each of which TYPE_NAME names
    const name = (TYPE_NAME as TypeNames)[type] as string; // oxlint-disable-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- see above
    stats.byType[name] = (stats.byType[name] ?? 0) + 1;
    objects.push({ offset, headerBytes: p - offset, type, size, compressed: consumed, data: out, baseOffset, baseOid, inflate: is });
    p += consumed;
  }
  if (p + PACK_TRAILER_BYTES !== buf.length) throw corrupt(`pack: expected trailer at ${p}, pack length ${buf.length}`);
  // the check above fixed the trailer's place: these are views
  const trailer = toHex(buf.subarray(p));
  const computed = verify ? new Sha1().update(buf.subarray(0, p)).hex() : null;
  if (verify && computed !== trailer) throw corrupt(`pack: trailer sha mismatch ${trailer} != ${computed}`);
  return { objects, stats, trailer, bytes: buf.length };
}

// ---- delta ----

// ---- delta ----
export type DeltaOps = { copy: number; insert: number; copyBytes: number; insertBytes: number };
// @decoder applyDelta prefix=delta
// oxlint-disable-next-line eslint/complexity -- one decoder: git's patch_delta, an opcode loop with seven optional bytes
export function applyDelta(base: Uint8Array, delta: Uint8Array, opts: { readonly maxResult?: number | undefined } = {}): { out: Uint8Array; ops: DeltaOps } {
  const maxResult = opts.maxResult === undefined ? requireLimit(DEFAULT_LIMITS, 'maxDeltaResult') : finiteLimit(opts.maxResult, 'maxDeltaResult');
  if (delta.length < DELTA_SIZE_MIN) throw corrupt('delta: shorter than DELTA_SIZE_MIN');
  let p = 0;
  let baseSize: number;
  let resultSize: number;
  // readVarint uses take(), so a header that runs past the buffer throws a short read before p can pass the end.
  [baseSize, p] = readVarint(delta, p);
  [resultSize, p] = readVarint(delta, p);
  if (resultSize > maxResult) throw limitError('delta result size', resultSize, maxResult);
  if (baseSize !== base.length) throw corrupt(`delta: base size ${baseSize} != ${base.length}`);
  const out = new Uint8Array(resultSize);
  let o = 0;
  const ops: DeltaOps = { copy: 0, insert: 0, copyBytes: 0, insertBytes: 0 };
  // The byte at p, then past it: a bounded read, so a delta cut inside an opcode is a typed short read.
  const deltaByte = (): number => take(delta, p++, 1)[0] as number; // oxlint-disable-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- one byte read, in range
  while (p < delta.length) {
    const c = deltaByte();
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
      if (len === 0) len = DELTA_COPY_MAX;
      if (off + len > base.length || o + len > resultSize) throw corrupt('delta: copy out of range');
      out.set(base.subarray(off, off + len), o); o += len; // in range: checked on the line above
      ops.copy++; ops.copyBytes += len;
    } else if (c) {
      if (p + c > delta.length || o + c > resultSize) throw corrupt('delta: insert out of range');
      out.set(delta.subarray(p, p + c), o); o += c; p += c; // in range: checked on the line above
      ops.insert++; ops.insertBytes += c;
    } else throw corrupt('delta: reserved opcode 0');
  }
  if (o !== resultSize) throw corrupt(`delta: produced ${o} != ${resultSize}`);
  return { out, ops };
}


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

// ---- resolve ----
// objects from parsePack; external(oid) -> {type, data} for thin bases. Returns Map oid -> resolved.
// A base from outside the pack (a thin pack's), as the caller's `external` returns it.
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

// oxlint-disable-next-line eslint/complexity -- one fixpoint over the pack's objects; the A1 pass makes it a Phase machine
export function resolvePack(
  parsed: PackToResolve,
  external: (oid: string) => ExternalBase | null | undefined = () => null,
  limits: Limits = DEFAULT_LIMITS,
): ResolvedPack {
  const maxChain = requireLimit(limits, 'maxDeltaChain');
  const maxDelta = requireLimit(limits, 'maxDeltaResult');
  const inflatedCap = requireLimit(limits, 'maxInflatedTotal');
  const byOffset = new Map(parsed.objects.map(o => [o.offset, o]));
  // Full objects are hashed once. REF_DELTA lookup is this map, not parsed.objects.find (that scan is
  // O(n) per delta, O(passes·n²) on a pack of tiny ref-deltas). Resolved deltas join the same map.
  const byOid = new Map<string | undefined, PackObject>();
  const resolved = new Map<string, ResolvedObject>();
  const memo = new Map<number, ResolvedObject>();
  const stats = { maxChain: 0, externalBases: 0, baseLookups: 0 };
  // Bytes already held (inflated instructions and bases) plus each delta result, which is a new buffer.
  // `?.` on data: a hand-built pack may leave it out (the parsed type says it is there)
  let held = parsed.stats?.inflated ?? parsed.objects.reduce((n, o) => n + (o.data?.length ?? 0), 0);
  let allowExternal = false;
  const resolveObj = (obj: PackObject, depth = 0): ResolvedObject => {
    const hit = memo.get(obj.offset);
    if (hit) return hit;
    if (depth > maxChain) throw limitError('delta chain depth', depth, maxChain);
    let core: Base & { deltaOps?: DeltaOps };
    let base: Base | undefined;
    if (obj.baseOffset !== undefined) {
      const b = byOffset.get(obj.baseOffset);
      if (!b) throw corrupt(`pack: ofs delta base not at object boundary ${obj.baseOffset}`);
      base = resolveObj(b, depth + 1);
    } else if (obj.baseOid !== undefined) {
      stats.baseLookups++;
      const inPack = byOid.get(obj.baseOid);
      if (inPack) base = resolveObj(inPack, depth + 1);
      else {
        const ext = allowExternal ? external(obj.baseOid) : undefined;
        if (!ext) throw corrupt(`pack: ref delta base ${obj.baseOid} not found`);
        stats.externalBases++;
        base = { type: ext.type, data: ext.data, chain: 0 };
      }
    }
    if (base === undefined) core = { type: obj.type, data: obj.data, chain: 0 };
    else {
      // Chain length, not recursion depth: a base resolved earlier comes back from memo, so depth alone let a chain
      // emitted base-first grow without bound (#14). An external base is chain 0.
      const chain = base.chain + 1;
      if (chain > maxChain) throw limitError('delta chain depth', chain, maxChain);
      // The result buffer does not exist until applyDelta passes maxResult. Room is what the aggregate cap has left.
      const room = inflatedCap - held;
      if (room < 0) throw limitError('pack inflated bytes', held, inflatedCap);
      const { out, ops } = applyDelta(base.data, obj.data, { maxResult: Math.min(maxDelta, room) });
      held += out.length;
      core = { type: base.type, data: out, chain, deltaOps: ops };
    }
    const r: ResolvedObject = Object.assign(core, {
      oid: hashObject(String((TYPE_NAME as TypeNames)[core.type]), core.data),
      offset: obj.offset, size: obj.size, compressed: obj.compressed,
      baseOffset: obj.baseOffset, baseOid: obj.baseOid,
    });
    if (r.chain > stats.maxChain) stats.maxChain = r.chain;
    memo.set(obj.offset, r);
    resolved.set(r.oid, r);
    byOid.set(r.oid, obj);
    return r;
  };
  for (const o of parsed.objects) if (o.baseOffset === undefined && o.baseOid === undefined) o.oid = hashObject(String((TYPE_NAME as TypeNames)[o.type]), o.data);
  for (const o of parsed.objects) if (o.baseOffset === undefined && o.baseOid === undefined) { byOid.set(o.oid, o); resolveObj(o); }
  // Until nothing is pending: a pass either resolves something, or switches to external bases once, or throws. A REF
  // chain emitted child-first resolves one link per pass, so the pass count is bounded by the chain check above
  // (≤ 2 · maxDeltaChain + 2), not by a pass ceiling that used to return the tail unresolved without an error (#14).
  let pending = parsed.objects.filter(o => o.baseOffset !== undefined || o.baseOid !== undefined);
  while (pending.length > 0) {
    const next: PackObject[] = [];
    for (const o of pending) {
      try { resolveObj(o); }
      // the same two reads as ever (only a PlyError reaches here: resolveObj throws nothing else); TODO(A1): a Result, not a catch
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
      catch (e) { const f = e as { readonly code: unknown; readonly message: string }; if (f.code === 'pack_corrupt' && /ref delta base .* not found/u.test(f.message)) next.push(o); else throw e; }
    }
    if (next.length === pending.length) {
      if (allowExternal) resolveObj(next[0] as PackObject); // oxlint-disable-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- next is pending, which is not empty // no progress even with external bases: surface the real error
      allowExternal = true;                   // every in-pack base is known now; the rest are thin bases
    }
    pending = next;
  }
  return { objects: resolved, stats };
}

