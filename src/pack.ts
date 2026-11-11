// Packfile v2: parse, delta resolve/apply/generate, build. Pure except buildPack (async zlib).
import { Sha1, fromHex } from './sha1.js';
import { TYPE, TYPE_NAME } from './objects.js';
import { bufferSource, concat } from './bytes.js';
import { at, fromNullish, readKey, type Input } from './absent.js';
import { assertNever, getOrElse } from './result.js';
import {
  PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, OBJ_TYPE_SHIFT, OBJ_SIZE_FIRST_MASK,
  OBJ_SIZE_NEXT_MASK, OBJ_CONTINUE, OBJ_SIZE_FIRST_BASE, OBJ_SIZE_NEXT_BASE, BE32_SHIFTS,
} from './format.js';
// ---- varints ----
export function encodeObjHeader(type: number, size: number): Uint8Array {
  let rest = size;
  let last = (type << OBJ_TYPE_SHIFT) | (rest & OBJ_SIZE_FIRST_MASK);
  const out: number[] = [];
  rest = Math.floor(rest / OBJ_SIZE_FIRST_BASE);
  // `last` is out's last element, held apart until it is final (its continue bit depends on what follows)
  while (rest > 0) { out.push(last | OBJ_CONTINUE); last = rest & OBJ_SIZE_NEXT_MASK; rest = Math.floor(rest / OBJ_SIZE_NEXT_BASE); }
  out.push(last);
  return Uint8Array.from(out);
}
// The delta-instruction encoders live in a leaf module (deltaenc.ts), which the resolver imports too; re-exported here,
// where callers have always found them.
export { encodeVarint, copyOp, copyOps, insertOps, encodeDeltaOps, spliceDelta } from './deltaenc.js';
export type { DeltaOp, Splice, SplicedDelta } from './deltaenc.js';

// ---- build ----
// Any Uint8Array in; a Blob takes only an ArrayBuffer-backed view, which bufferSource guarantees (bytes.ts).
export async function zlibDeflate(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const ab = await new Response(new Blob([bufferSource(bytes)]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer();
  return new Uint8Array(ab);
}

// One object for buildPack: its type (1-4) and data, and its base, a tagged union with the read side's tags (ObjBase,
// packstream.ts). none (or left out): the object whole. ofs: an OFS_DELTA whose `data` is the delta against an earlier
// object of the same list, named by its index (its offset is not known until the pack is written). ref: a REF_DELTA
// whose `data` is the delta against the object `oid` (a thin base the receiver holds). buildPack is the encoder and
// checks neither: push's planPush refuses an ofs base that names no earlier object and a ref base that is not an object
// id before anything is built.
export type PackInputBase = { readonly tag: 'none' } | { readonly tag: 'ofs'; readonly index: number } | { readonly tag: 'ref'; readonly oid: string };
export type PackInput = { readonly type: number; readonly data: Uint8Array } & Input<{ readonly base: PackInputBase }>;
export const WHOLE: PackInputBase = Object.freeze({ tag: 'none' });
// The base an object gives (left out: none).
export const inputBase = (o: PackInput): PackInputBase => getOrElse<PackInputBase>(fromNullish(o.base), WHOLE);
// typeName: the type's name for the five types a pack holds (TYPE_NAME), null for any other id a caller passed.
// offset: where the entry starts in the pack (its header), as an index names it (packindex.ts encodePackIndex).
export type BuiltEntry = {
  readonly type: number; readonly typeName: string | null; readonly size: number; readonly compressed: number;
  readonly baseOid: string | null; readonly bytes: number; readonly offset: number;
};
export const typeNameOf = (type: number): string | null => {
  const named = readKey(TYPE_NAME as Readonly<Record<number, string>>, type);
  return named.tag === 'some' ? named.value : null;
};
export type BuiltPack = { readonly pack: Uint8Array; readonly entries: BuiltEntry[] };
// An OFS_DELTA's distance back to its base (gitformat-pack "offset encoding"): big-endian 7-bit groups, each group but
// the last with the high bit set, and every group after the first offset by one (pack-objects write_no_reuse_object).
export function encodeOfsDistance(distance: number): Uint8Array {
  const out: number[] = [distance & OBJ_SIZE_NEXT_MASK];
  let rest = Math.floor(distance / OBJ_SIZE_NEXT_BASE);
  while (rest > 0) { rest -= 1; out.unshift(OBJ_CONTINUE | (rest & OBJ_SIZE_NEXT_MASK)); rest = Math.floor(rest / OBJ_SIZE_NEXT_BASE); }
  return Uint8Array.from(out);
}
// The 12-byte pack header for `count` objects.
export function packHeader(count: number): Uint8Array<ArrayBuffer> {
  const hdr = new Uint8Array(PACK_HEADER_BYTES);
  hdr.set(PACK_SIGNATURE);
  const dv = new DataView(hdr.buffer);
  dv.setUint32(PACK_SIGNATURE.length, PACK_VERSION);
  dv.setUint32(PACK_SIGNATURE.length + BE32_SHIFTS.length, count);
  return hdr;
}
// One entry before its zlib stream, the one encoder buildPack and the streamed writer (packwrite.ts) share: its pack
// type, its object header and base bytes (`head`), and the REF base it names (BuiltEntry.baseOid). `offset` is where the
// entry starts; `offsets` the earlier entries' (an OFS base's distance back; an index with no entry is a distance of 0).
export type EntryHead = { readonly type: number; readonly head: Uint8Array; readonly baseOid: string | null };
export function entryHead(o: PackInput, offset: number, offsets: readonly number[]): EntryHead {
  const base = inputBase(o);
  switch (base.tag) {
    case 'none': return { type: o.type, head: encodeObjHeader(o.type, o.data.length), baseOid: null };
    case 'ofs': return { type: TYPE.OFS_DELTA, head: concat([encodeObjHeader(TYPE.OFS_DELTA, o.data.length), encodeOfsDistance(offset - getOrElse(at(offsets, base.index), offset))]), baseOid: null };
    case 'ref': return { type: TYPE.REF_DELTA, head: concat([encodeObjHeader(TYPE.REF_DELTA, o.data.length), fromHex(base.oid)]), baseOid: base.oid };
  }
  // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(base);
}
// The entry the header and its zlib stream make: what buildPack and the streamed writer report for it.
export const builtEntry = (h: EntryHead, size: number, compressed: number, offset: number): BuiltEntry =>
  ({ type: h.type, typeName: typeNameOf(h.type), size, compressed, baseOid: h.baseOid, bytes: h.head.length + compressed, offset });
// Measured (test/pure.test.js history): hand-rolled stored-block zlib never beats CompressionStream's output — zlib
// already emits stored blocks for incompressible input and ties at ≥32 bytes, and loses by 3 bytes below. So: deflate only.
export async function buildPack(objects: readonly PackInput[]): Promise<BuiltPack> {
  const parts: Uint8Array[] = [packHeader(objects.length)];
  const entries: BuiltEntry[] = [];
  // each object's offset in the pack, for an OFS_DELTA's distance back
  const offsets: number[] = [];
  let offset = PACK_HEADER_BYTES;
  for (const o of objects) {
    const h = entryHead(o, offset, offsets);
    // one at a time, in pack order: the pack is a sequence (parallel deflate is a perf change, not this one)
    // oxlint-disable-next-line no-await-in-loop -- see above
    const z = await zlibDeflate(o.data);
    parts.push(h.head, z);
    const entry = builtEntry(h, o.data.length, z.length, offset);
    entries.push(entry);
    offsets.push(offset);
    offset += entry.bytes;
  }
  const body = concat(parts);
  const pack = concat([body, new Sha1().update(body).digest()]);
  return { pack, entries };
}


// General-purpose parsing/resolution, kept out of this module so bundles of the edit path do not carry it.
// The resolver is re-exported for callers; it imports nothing from this module (the delta encoders are deltaenc.ts).
// oxlint-disable-next-line import/no-cycle -- see above
export { parsePack, applyDelta, parseDelta, applyProgram, deltaOps, makeDelta, resolvePack, describePack, readObjHeader, readOfsDelta, readUint32BE, packParseOpts } from './packresolve.js';
export type { PackLayout, PackLayoutObject, PackBase, ResolvedObjType, ObjBase, DeltaProgram, PackObjectInput, ParsedObject } from './packresolve.js';
