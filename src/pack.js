// Packfile v2: parse, delta resolve/apply/generate, build. Pure except buildPack (async zlib).
import { Sha1, fromHex } from './sha1.js';
import { TYPE, TYPE_NAME } from './objects.js';
import { concat } from './bytes.js';
import {
  PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, OID_BYTES, BYTE_MASK,
  OBJ_TYPE_SHIFT, OBJ_SIZE_FIRST_MASK, OBJ_SIZE_NEXT_MASK, OBJ_CONTINUE,
  OBJ_SIZE_FIRST_BASE, OBJ_SIZE_NEXT_BASE, BE32_SHIFTS,
  DELTA_COPY, DELTA_COPY_MAX, DELTA_INSERT_MAX, DELTA_OFF_SHIFT,
  DELTA_COPY_OFF1, DELTA_COPY_OFF2, DELTA_COPY_OFF3, DELTA_COPY_OFF4,
  DELTA_COPY_LEN1, DELTA_COPY_LEN2, DELTA_COPY_LEN3,
} from './format.js';
// ---- varints ----
export function encodeObjHeader(type, size) {
  const out = [(type << OBJ_TYPE_SHIFT) | (size & OBJ_SIZE_FIRST_MASK)];
  size = Math.floor(size / OBJ_SIZE_FIRST_BASE);
  while (size > 0) { out[out.length - 1] |= OBJ_CONTINUE; out.push(size & OBJ_SIZE_NEXT_MASK); size = Math.floor(size / OBJ_SIZE_NEXT_BASE); }
  return Uint8Array.from(out);
}
export function encodeVarint(n) { // delta header style: 7-bit LE groups
  const out = [];
  do { let b = n & OBJ_SIZE_NEXT_MASK; n = Math.floor(n / OBJ_SIZE_NEXT_BASE); if (n > 0) b |= OBJ_CONTINUE; out.push(b); } while (n > 0);
  return Uint8Array.from(out);
}
export const copyOp = (off, len) => {
  const b = [DELTA_COPY];
  let o = off, l = len === DELTA_COPY_MAX ? 0 : len;
  if (o & BYTE_MASK) { b[0] |= DELTA_COPY_OFF1; b.push(o & BYTE_MASK); } o >>>= DELTA_OFF_SHIFT;
  if (o & BYTE_MASK) { b[0] |= DELTA_COPY_OFF2; b.push(o & BYTE_MASK); } o >>>= DELTA_OFF_SHIFT;
  if (o & BYTE_MASK) { b[0] |= DELTA_COPY_OFF3; b.push(o & BYTE_MASK); } o >>>= DELTA_OFF_SHIFT;
  if (o & BYTE_MASK) { b[0] |= DELTA_COPY_OFF4; b.push(o & BYTE_MASK); }
  if (l & BYTE_MASK) { b[0] |= DELTA_COPY_LEN1; b.push(l & BYTE_MASK); } l >>>= DELTA_OFF_SHIFT;
  if (l & BYTE_MASK) { b[0] |= DELTA_COPY_LEN2; b.push(l & BYTE_MASK); } l >>>= DELTA_OFF_SHIFT;
  if (l & BYTE_MASK) { b[0] |= DELTA_COPY_LEN3; b.push(l & BYTE_MASK); }
  return Uint8Array.from(b);
};
export const copyOps = (off, len) => {
  const parts = [];
  while (len > 0) { const n = Math.min(len, DELTA_COPY_MAX); parts.push(copyOp(off, n)); off += n; len -= n; }
  return parts;
};
export const insertOps = bytes => {
  const parts = [];
  for (let i = 0; i < bytes.length; i += DELTA_INSERT_MAX) {
    const chunk = bytes.subarray(i, Math.min(i + DELTA_INSERT_MAX, bytes.length));
    parts.push(Uint8Array.of(chunk.length), chunk);
  }
  return parts;
};

// Structural delta: base with [off, off+oldLen) replaced by `insert`. Pure; needs no base bytes.
export function spliceDelta({ baseLen, off, oldLen, insert }) {
  const resultLen = baseLen - oldLen + insert.length;
  const tail = baseLen - off - oldLen;
  const parts = [encodeVarint(baseLen), encodeVarint(resultLen)];
  if (off > 0) parts.push(...copyOps(0, off));
  if (insert.length) parts.push(...insertOps(insert));
  if (tail > 0) parts.push(...copyOps(off + oldLen, tail));
  return { delta: concat(parts), resultLen, ops: { copy: (off > 0 ? Math.ceil(off / DELTA_COPY_MAX) : 0) + (tail > 0 ? Math.ceil(tail / DELTA_COPY_MAX) : 0), insert: Math.ceil(insert.length / DELTA_INSERT_MAX) } };
}

// ---- build ----
export async function zlibDeflate(bytes) {
  const ab = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer();
  return new Uint8Array(ab);
}

// objects: [{ type (1-4), data, baseOid? }] — baseOid makes it a REF_DELTA whose `data` is the delta.
// Measured (test/pure.test.js history): hand-rolled stored-block zlib never beats CompressionStream's output — zlib
// already emits stored blocks for incompressible input and ties at ≥32 bytes, and loses by 3 bytes below. So: deflate only.
export async function buildPack(objects) {
  const parts = [];
  const hdr = new Uint8Array(PACK_HEADER_BYTES);
  hdr.set(PACK_SIGNATURE);
  new DataView(hdr.buffer).setUint32(PACK_SIGNATURE.length, PACK_VERSION);
  new DataView(hdr.buffer).setUint32(PACK_SIGNATURE.length + BE32_SHIFTS.length, objects.length);
  parts.push(hdr);
  const entries = [];
  for (const o of objects) {
    const type = o.baseOid ? TYPE.REF_DELTA : o.type;
    const z = await zlibDeflate(o.data);
    const h = encodeObjHeader(type, o.data.length);
    parts.push(h);
    if (o.baseOid) parts.push(fromHex(o.baseOid));
    parts.push(z);
    entries.push({ type, typeName: TYPE_NAME[type], size: o.data.length, compressed: z.length, baseOid: o.baseOid ?? null, bytes: h.length + (o.baseOid ? OID_BYTES : 0) + z.length });
  }
  const body = concat(parts);
  const pack = concat([body, new Sha1().update(body).digest()]);
  return { pack, entries };
}


// General-purpose parsing/resolution, kept out of this module so bundles of the edit path do not carry it.
export { parsePack, applyDelta, makeDelta, resolvePack, readObjHeader, readOfsDelta, readUint32BE } from './packresolve.js';
