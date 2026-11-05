// Packfile v2: parse, delta resolve/apply/generate, build. Pure except buildPack (async zlib).
import { Sha1, fromHex } from './sha1.js';
import { TYPE, TYPE_NAME } from './objects.js';
import { bufferSource, concat } from './bytes.js';
import { at, fromNullish, readKey, type Input } from './absent.js';
import { getOrElse } from './result.js';
import {
  PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, BYTE_MASK,
  OBJ_TYPE_SHIFT, OBJ_SIZE_FIRST_MASK, OBJ_SIZE_NEXT_MASK, OBJ_CONTINUE,
  OBJ_SIZE_FIRST_BASE, OBJ_SIZE_NEXT_BASE, BE32_SHIFTS,
  DELTA_COPY, DELTA_COPY_MAX, DELTA_INSERT_MAX, DELTA_OFF_SHIFT,
  DELTA_COPY_OFF1, DELTA_COPY_OFF2, DELTA_COPY_OFF3, DELTA_COPY_OFF4,
  DELTA_COPY_LEN1, DELTA_COPY_LEN2, DELTA_COPY_LEN3,
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
export function encodeVarint(n: number): Uint8Array { // delta header style: 7-bit LE groups
  const out: number[] = [];
  let rest = n;
  do { let b = rest & OBJ_SIZE_NEXT_MASK; rest = Math.floor(rest / OBJ_SIZE_NEXT_BASE); if (rest > 0) b |= OBJ_CONTINUE; out.push(b); } while (rest > 0);
  return Uint8Array.from(out);
}
export const copyOp = (off: number, len: number): Uint8Array => {
  let op = DELTA_COPY;
  const b: number[] = [];
  let o = off;
  let l = len === DELTA_COPY_MAX ? 0 : len;
  if (o & BYTE_MASK) { op |= DELTA_COPY_OFF1; b.push(o & BYTE_MASK); } o >>>= DELTA_OFF_SHIFT;
  if (o & BYTE_MASK) { op |= DELTA_COPY_OFF2; b.push(o & BYTE_MASK); } o >>>= DELTA_OFF_SHIFT;
  if (o & BYTE_MASK) { op |= DELTA_COPY_OFF3; b.push(o & BYTE_MASK); } o >>>= DELTA_OFF_SHIFT;
  if (o & BYTE_MASK) { op |= DELTA_COPY_OFF4; b.push(o & BYTE_MASK); }
  if (l & BYTE_MASK) { op |= DELTA_COPY_LEN1; b.push(l & BYTE_MASK); } l >>>= DELTA_OFF_SHIFT;
  if (l & BYTE_MASK) { op |= DELTA_COPY_LEN2; b.push(l & BYTE_MASK); } l >>>= DELTA_OFF_SHIFT;
  if (l & BYTE_MASK) { op |= DELTA_COPY_LEN3; b.push(l & BYTE_MASK); }
  return Uint8Array.of(op, ...b);
};
export const copyOps = (off: number, len: number): Uint8Array[] => {
  const parts: Uint8Array[] = [];
  let o = off;
  let left = len;
  while (left > 0) { const n = Math.min(left, DELTA_COPY_MAX); parts.push(copyOp(o, n)); o += n; left -= n; }
  return parts;
};
export const insertOps = (bytes: Uint8Array): Uint8Array[] => {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += DELTA_INSERT_MAX) {
    const chunk = bytes.subarray(i, Math.min(i + DELTA_INSERT_MAX, bytes.length));
    parts.push(Uint8Array.of(chunk.length), chunk);
  }
  return parts;
};

// One delta instruction (gitformat-pack "Deltified representation"): copy `len` bytes of the source from `off`, or insert
// the literal bytes. A copy longer than DELTA_COPY_MAX or an insert longer than DELTA_INSERT_MAX is one instruction
// here and as many opcodes as it takes on the wire (encodeDeltaOps).
export type DeltaOp = { readonly tag: 'copy'; readonly off: number; readonly len: number } | { readonly tag: 'insert'; readonly bytes: Uint8Array };
// A delta's bytes from its sizes and instructions.
export function encodeDeltaOps(srcSize: number, dstSize: number, ops: readonly DeltaOp[]): Uint8Array<ArrayBuffer> {
  const parts = [encodeVarint(srcSize), encodeVarint(dstSize)];
  for (const op of ops) parts.push(...(op.tag === 'copy' ? copyOps(op.off, op.len) : insertOps(op.bytes)));
  return concat(parts);
}

// Structural delta: base with [off, off+oldLen) replaced by `insert`. Pure; needs no base bytes. The instructions are a
// copy of the prefix, the insert, and a copy of the tail, each only when it is not empty.
export type Splice = { readonly baseLen: number; readonly off: number; readonly oldLen: number; readonly insert: Uint8Array };
export type SplicedDelta = { readonly delta: Uint8Array<ArrayBuffer>; readonly resultLen: number; readonly ops: { readonly copy: number; readonly insert: number }; readonly program: readonly DeltaOp[] };
export function spliceDelta({ baseLen, off, oldLen, insert }: Splice): SplicedDelta {
  const resultLen = baseLen - oldLen + insert.length;
  const tail = baseLen - off - oldLen;
  const program: DeltaOp[] = [];
  if (off > 0) program.push({ tag: 'copy', off: 0, len: off });
  if (insert.length > 0) program.push({ tag: 'insert', bytes: insert });
  if (tail > 0) program.push({ tag: 'copy', off: off + oldLen, len: tail });
  return { delta: encodeDeltaOps(baseLen, resultLen, program), resultLen, program, ops: { copy: (off > 0 ? Math.ceil(off / DELTA_COPY_MAX) : 0) + (tail > 0 ? Math.ceil(tail / DELTA_COPY_MAX) : 0), insert: Math.ceil(insert.length / DELTA_INSERT_MAX) } };
}

// ---- build ----
// Any Uint8Array in; a Blob takes only an ArrayBuffer-backed view, which bufferSource guarantees (bytes.ts).
export async function zlibDeflate(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const ab = await new Response(new Blob([bufferSource(bytes)]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer();
  return new Uint8Array(ab);
}

// objects: [{ type (1-4), data, baseOid?, baseIndex? }] — baseOid makes it a REF_DELTA whose `data` is the delta;
// baseIndex (the index of an earlier object in the same list) an OFS_DELTA. buildPack is the encoder and checks neither:
// push's planPush refuses a baseIndex that names no earlier object before anything is built.
export type PackInput = { readonly type: number; readonly data: Uint8Array } & Input<{ readonly baseOid: string | null; readonly baseIndex: number | null }>;
// typeName: the type's name for the five types a pack holds (TYPE_NAME), null for any other id a caller passed.
// offset: where the entry starts in the pack (its header), as an index names it (packindex.ts encodePackIndex).
export type BuiltEntry = {
  readonly type: number; readonly typeName: string | null; readonly size: number; readonly compressed: number;
  readonly baseOid: string | null; readonly bytes: number; readonly offset: number;
};
const typeNameOf = (type: number): string | null => {
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
// Measured (test/pure.test.js history): hand-rolled stored-block zlib never beats CompressionStream's output — zlib
// already emits stored blocks for incompressible input and ties at ≥32 bytes, and loses by 3 bytes below. So: deflate only.
export async function buildPack(objects: readonly PackInput[]): Promise<BuiltPack> {
  const parts: Uint8Array[] = [];
  const hdr = new Uint8Array(PACK_HEADER_BYTES);
  hdr.set(PACK_SIGNATURE);
  new DataView(hdr.buffer).setUint32(PACK_SIGNATURE.length, PACK_VERSION);
  new DataView(hdr.buffer).setUint32(PACK_SIGNATURE.length + BE32_SHIFTS.length, objects.length);
  parts.push(hdr);
  const entries: BuiltEntry[] = [];
  // each object's offset in the pack, for an OFS_DELTA's distance back
  const offsets: number[] = [];
  let offset = PACK_HEADER_BYTES;
  for (const o of objects) {
    const given = getOrElse<string | null>(fromNullish(o.baseOid), null);
    const baseOid = given === null ? '' : given; // truthiness, as before: an empty baseOid is no base
    const baseIndex = getOrElse<number | null>(fromNullish(o.baseIndex), null);
    const ofs = baseIndex === null ? null : encodeOfsDistance(offset - getOrElse(at(offsets, baseIndex), offset));
    const ref = ofs === null && baseOid ? fromHex(baseOid) : null;
    let type: number = ref === null ? o.type : TYPE.REF_DELTA;
    if (ofs !== null) type = TYPE.OFS_DELTA;
    // one at a time, in pack order: the pack is a sequence (parallel deflate is a perf change, not this one)
    // oxlint-disable-next-line no-await-in-loop -- see above
    const z = await zlibDeflate(o.data);
    const h = encodeObjHeader(type, o.data.length);
    parts.push(h);
    const base = ofs === null ? ref : ofs;
    if (base !== null) parts.push(base);
    parts.push(z);
    const bytes = h.length + (base === null ? 0 : base.length) + z.length;
    entries.push({ type, typeName: typeNameOf(type), size: o.data.length, compressed: z.length, baseOid: ofs === null ? given : null, bytes, offset });
    offsets.push(offset);
    offset += bytes;
  }
  const body = concat(parts);
  const pack = concat([body, new Sha1().update(body).digest()]);
  return { pack, entries };
}


// General-purpose parsing/resolution, kept out of this module so bundles of the edit path do not carry it.
// packresolve imports spliceDelta from here: a cycle of a re-export and one function, which ES modules resolve (A1 untangles it)
// oxlint-disable-next-line import/no-cycle -- see above
export { parsePack, applyDelta, parseDelta, applyProgram, deltaOps, makeDelta, resolvePack, describePack, readObjHeader, readOfsDelta, readUint32BE, packParseOpts } from './packresolve.js';
export type { PackLayout, PackLayoutObject, PackBase, ResolvedObjType, ObjBase, DeltaProgram, PackObjectInput, ParsedObject } from './packresolve.js';
