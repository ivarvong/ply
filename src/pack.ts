// Packfile v2: parse, delta resolve/apply/generate, build. Pure except buildPack (async zlib).
import { Sha1, fromHex } from './sha1.js';
import { TYPE, TYPE_NAME } from './objects.js';
import { bufferSource, concat } from './bytes.js';
import {
  PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, OID_BYTES, BYTE_MASK,
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

// Structural delta: base with [off, off+oldLen) replaced by `insert`. Pure; needs no base bytes.
export type Splice = { readonly baseLen: number; readonly off: number; readonly oldLen: number; readonly insert: Uint8Array };
export type SplicedDelta = { readonly delta: Uint8Array<ArrayBuffer>; readonly resultLen: number; readonly ops: { readonly copy: number; readonly insert: number } };
export function spliceDelta({ baseLen, off, oldLen, insert }: Splice): SplicedDelta {
  const resultLen = baseLen - oldLen + insert.length;
  const tail = baseLen - off - oldLen;
  const parts = [encodeVarint(baseLen), encodeVarint(resultLen)];
  if (off > 0) parts.push(...copyOps(0, off));
  if (insert.length > 0) parts.push(...insertOps(insert));
  if (tail > 0) parts.push(...copyOps(off + oldLen, tail));
  return { delta: concat(parts), resultLen, ops: { copy: (off > 0 ? Math.ceil(off / DELTA_COPY_MAX) : 0) + (tail > 0 ? Math.ceil(tail / DELTA_COPY_MAX) : 0), insert: Math.ceil(insert.length / DELTA_INSERT_MAX) } };
}

// ---- build ----
// Any Uint8Array in; a Blob takes only an ArrayBuffer-backed view, which bufferSource guarantees (bytes.ts).
export type DeflatePull = { readonly kind: 'chunk'; readonly bytes: Uint8Array<ArrayBuffer> } | { readonly kind: 'end' };
export type DeflateSession = { readonly reader: ReadableStreamDefaultReader<Uint8Array> };
export function deflateOpen(bytes: Uint8Array): DeflateSession {
  const stream = new Blob([bufferSource(bytes)]).stream().pipeThrough(new CompressionStream('deflate'));
  return { reader: stream.getReader() };
}
export async function deflatePull(session: DeflateSession): Promise<DeflatePull> {
  const step = await session.reader.read();
  if (step.done) return { kind: 'end' };
  return { kind: 'chunk', bytes: step.value.slice() };
}
export async function zlibDeflate(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const session = deflateOpen(bytes);
  const parts: Array<Uint8Array<ArrayBuffer>> = [];
  let total = 0;
  for (;;) {
    // one reader: the next chunk does not exist until this read resolves
    // oxlint-disable-next-line no-await-in-loop -- see above
    const step = await deflatePull(session);
    if (step.kind === 'end') break;
    parts.push(step.bytes);
    total += step.bytes.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// objects: [{ type (1-4), data, baseOid? }] — baseOid makes it a REF_DELTA whose `data` is the delta.
export type PackInput = { readonly type: number; readonly data: Uint8Array; readonly baseOid?: string | null | undefined };
export type BuiltEntry = {
  readonly type: number; readonly typeName: string | undefined; readonly size: number; readonly compressed: number;
  readonly baseOid: string | null; readonly bytes: number;
};
export type BuiltPack = { readonly pack: Uint8Array; readonly entries: BuiltEntry[] };
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
  for (const o of objects) {
    const baseOid = o.baseOid ?? ''; // truthiness, as before: an empty baseOid is no base
    const type: number = baseOid ? TYPE.REF_DELTA : o.type;
    // one at a time, in pack order: the pack is a sequence (parallel deflate is a perf change, not this one)
    // oxlint-disable-next-line no-await-in-loop -- see above
    const z = await zlibDeflate(o.data);
    const h = encodeObjHeader(type, o.data.length);
    parts.push(h);
    if (baseOid) parts.push(fromHex(baseOid));
    parts.push(z);
    entries.push({ type, typeName: (TYPE_NAME as Readonly<Record<number, string | undefined>>)[type], size: o.data.length, compressed: z.length, baseOid: o.baseOid ?? null, bytes: h.length + (baseOid ? OID_BYTES : 0) + z.length });
  }
  const body = concat(parts);
  const pack = concat([body, new Sha1().update(body).digest()]);
  return { pack, entries };
}


// General-purpose parsing/resolution, kept out of this module so bundles of the edit path do not carry it.
// packresolve imports spliceDelta from here: a cycle of a re-export and one function, which ES modules resolve (A1 untangles it)
// oxlint-disable-next-line import/no-cycle -- see above
export { parsePack, applyDelta, makeDelta, resolvePack, describePack, readObjHeader, readOfsDelta, readUint32BE, packParseOpts } from './packresolve.js';
export type { PackLayout, PackLayoutObject, PackBase, ResolvedObjType } from './packresolve.js';
