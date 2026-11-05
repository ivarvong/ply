// parsePack as ply had it before #172 made it a collector over the pack scan (src/packstream.ts): a whole buffer walked
// with the old inflate (inflate-ref.ts), kept in test/ as an independent oracle for the scan. One change from the old
// code, the one #156 made on purpose: the declared size is refused right after the object header (before the base),
// where readObjHeader now checks it. Its objects carry baseOffset/baseOid; test/packstream.test.js reads them as the
// tagged base.
import type { ErrorOf } from '../../src/errors.js';
import { fail } from '../../src/errors.js';
import type { Err, Result } from '../../src/result.js';
import { ok, err, assertNever, getOrElse } from '../../src/result.js';
import { at, atOr, fromNullish, readKey, type Input } from '../../src/absent.js';
import type { InflateStats } from '../../src/inflatestream.js';
import { inflateRef } from './inflate-ref.js';
import { Sha1, toHex, toOid, type Oid } from '../../src/sha1.js';
import { nameOfTypeId } from '../../src/objects.js';
import type { ObjType } from '../../src/objects.js';
import type { LimitKey, Limits } from '../../src/limits.js';
import { DEFAULT_LIMITS, LIMIT_OBJECT_OVERHEAD, limitError, checkLimit, readLimit } from '../../src/limits.js';
import { take, shortRead } from '../../src/bytes.js';
import type { PackKind } from '../../src/format.js';
import {
  PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, PACK_TRAILER_BYTES, OID_BYTES, UINT32_BYTES,
  OBJ_TYPE_SHIFT, OBJ_TYPE_MASK, OBJ_SIZE_FIRST_MASK, OBJ_SIZE_NEXT_MASK, OBJ_CONTINUE,
  OBJ_SIZE_NEXT_BASE, VARINT_BITS, VARINT_MAX_SHIFT, varintScale, BE32_SHIFTS,
} from '../../src/format.js';
import { TYPE } from '../../src/objects.js';

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
export function readUint32BE(buf: Uint8Array, off: number): Result<number, Corrupt> {
  const r = take(buf, off, BE32_SHIFTS.length);
  return r.ok ? ok(be32(buf, off)) : r;
}

// The header's three type bits as one of the six pack types, or null for 0 and 5 (which name nothing).
function objTypeOf(n: number): ObjType | null {
  switch (n) {
    case TYPE.COMMIT:
    case TYPE.TREE:
    case TYPE.BLOB:
    case TYPE.TAG:
    case TYPE.OFS_DELTA:
    case TYPE.REF_DELTA:
      return n;
    default:
      return null;
  }
}
// `type` is parsed here, once: a reader of an ObjHeader sees one of the six pack types and no other number.
export type ObjHeader = { readonly type: ObjType; readonly size: number; readonly next: number };
// A header cut by the end of the buffer is a short read (`reason: 'short_read'`): a stream parser waits for more bytes
// on that reason (fetch.ts spStep), and refuses anything else. A whole header whose type is 0 or 5 is
// `pack: bad object type <n> at <offset>`, after the size (a size varint past 64 bits is refused first, as it always was);
// `offset` is the header's offset in the pack, which a stream parser's carry buffer does not start at.
export function readObjHeader(buf: Uint8Array, start: number, offset: number = start): Result<ObjHeader, Corrupt> {
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
  return ok({ type, size, next });
}

export type OfsDelta = { readonly off: number; readonly next: number };
// The same ten-byte cap as the size varints (readObjHeader): git's index-pack refuses an offset that overflows
// ("offset value overflow for delta base object"); past it the offset could only name a base before the pack start.
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
// parsePack's options for `limits`: the two pack caps read out of it, checked (the first that bounds nothing is the error).
export type PackParseOpts = { readonly limits: Limits; readonly maxObjects: number; readonly maxInflatedTotal: number };
export function packParseOpts(limits: Limits = DEFAULT_LIMITS): Result<PackParseOpts, ErrorOf<'bad_request'>> {
  const maxObjects = readLimit(limits, 'maxPackObjects');
  if (!maxObjects.ok) return maxObjects;
  const maxInflatedTotal = readLimit(limits, 'maxInflatedTotal');
  if (!maxInflatedTotal.ok) return maxInflatedTotal;
  return ok({ limits, maxObjects: maxObjects.value, maxInflatedTotal: maxInflatedTotal.value });
}

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
// What parsePack read: the type is one of the six and a REF base is an Oid (parsed where the bytes were read). A
// hand-built PackObject (resolvePack's input) is still checked by the resolver.
export type ParsedObject = PackObject & { readonly type: ObjType; readonly baseOid: Oid | null };
export type ParsedPack = { readonly objects: ParsedObject[]; readonly stats: PackStats; readonly trailer: string; readonly bytes: number };

export function parsePackRef(buf: Uint8Array, opts: PackParseOptions = {}): Result<ParsedPack, PackError> {
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
  const objects: ParsedObject[] = [];
  // What the objects held so far cost: declared bytes plus LIMIT_OBJECT_OVERHEAD each (the record, its views, its
  // resolved form), so a pack of many tiny objects meets maxInflatedTotal too (#142). stats.inflated stays git's sum.
  let charged = 0;
  const stats: PackStats = { version, count, full: 0, ofsDelta: 0, refDelta: 0, byType: {}, compressed: 0, inflated: 0, inflate: { blocks: 0, stored: 0, fixed: 0, dynamic: 0 } };
  let p = PACK_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const offset = p;
    const header = readObjHeader(buf, p);
    if (!header.ok) return header;
    const { type, size } = header.value;
    p = header.value.next;
    if (size > maxObjectSize) return err(limitError('pack object size', size, maxObjectSize));
    let baseOffset: number | null = null;
    let baseOid: Oid | null = null;
    const kindResult = ((): Result<PackKind, PackError> => {
      const raw = nameOfTypeId(type);
      switch (raw) {
        case 'commit': case 'tree': case 'blob': case 'tag': stats.full++; return ok(raw);
        case 'ofs_delta': {
          const ofs = readOfsDelta(buf, p);
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
          baseOid = toOid(buf.subarray(p, p + OID_BYTES)); p += OID_BYTES;
          stats.refDelta++;
          return ok('ref_delta');
        }
      }
      return assertNever(raw);
    })();
    if (!kindResult.ok) return kindResult;
    const kind = kindResult.value;
    // Declared inflated size is known before zlib runs, so an inflate bomb is refused before the output buffer exists.
    const cost = size + LIMIT_OBJECT_OVERHEAD;
    if (charged + cost > maxInflatedTotal) return err(limitError('pack inflated bytes', charged + cost, maxInflatedTotal));
    const z = inflateRef(buf, p, { expectedSize: size, maxOutput: maxObjectSize });
    if (!z.ok) return z;
    const { out, consumed, stats: is } = z.value;
    stats.compressed += consumed; stats.inflated += size; charged += cost;
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

