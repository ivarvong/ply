// Packfile v2: parse, delta resolve/apply/generate, build. Pure except buildPack (async zlib).
import { fail } from './errors.js';
import { Sha1, toHex, fromHex } from './sha1.js';
import { TYPE, TYPE_NAME } from './objects.js';
import { concat } from './bytes.js';
const corrupt = msg => fail('pack_corrupt', msg);

// ---- varints ----
export function encodeObjHeader(type, size) {
  const out = [(type << 4) | (size & 0x0f)];
  size = Math.floor(size / 16);
  while (size > 0) { out[out.length - 1] |= 0x80; out.push(size & 0x7f); size = Math.floor(size / 128); }
  return Uint8Array.from(out);
}
export function encodeVarint(n) { // delta header style: 7-bit LE groups
  const out = [];
  do { let b = n & 0x7f; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
  return Uint8Array.from(out);
}
export const copyOp = (off, len) => {
  const b = [0x80];
  let o = off, l = len === 0x10000 ? 0 : len;
  if (o & 0xff) { b[0] |= 0x01; b.push(o & 0xff); } o >>>= 8;
  if (o & 0xff) { b[0] |= 0x02; b.push(o & 0xff); } o >>>= 8;
  if (o & 0xff) { b[0] |= 0x04; b.push(o & 0xff); } o >>>= 8;
  if (o & 0xff) { b[0] |= 0x08; b.push(o & 0xff); }
  if (l & 0xff) { b[0] |= 0x10; b.push(l & 0xff); } l >>>= 8;
  if (l & 0xff) { b[0] |= 0x20; b.push(l & 0xff); } l >>>= 8;
  if (l & 0xff) { b[0] |= 0x40; b.push(l & 0xff); }
  return Uint8Array.from(b);
};
export const copyOps = (off, len) => {
  const parts = [];
  while (len > 0) { const n = Math.min(len, 0x10000); parts.push(copyOp(off, n)); off += n; len -= n; }
  return parts;
};
export const insertOps = bytes => {
  const parts = [];
  for (let i = 0; i < bytes.length; i += 127) {
    const chunk = bytes.subarray(i, Math.min(i + 127, bytes.length));
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
  return { delta: concat(parts), resultLen, ops: { copy: (off > 0 ? Math.ceil(off / 0x10000) : 0) + (tail > 0 ? Math.ceil(tail / 0x10000) : 0), insert: Math.ceil(insert.length / 127) } };
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
  const hdr = new Uint8Array(12);
  hdr.set([0x50, 0x41, 0x43, 0x4b]);
  new DataView(hdr.buffer).setUint32(4, 2);
  new DataView(hdr.buffer).setUint32(8, objects.length);
  parts.push(hdr);
  const entries = [];
  for (const o of objects) {
    const type = o.baseOid ? TYPE.REF_DELTA : o.type;
    const z = await zlibDeflate(o.data);
    const h = encodeObjHeader(type, o.data.length);
    parts.push(h);
    if (o.baseOid) parts.push(fromHex(o.baseOid));
    parts.push(z);
    entries.push({ type, typeName: TYPE_NAME[type], size: o.data.length, compressed: z.length, baseOid: o.baseOid ?? null, bytes: h.length + (o.baseOid ? 20 : 0) + z.length });
  }
  const body = concat(parts);
  const pack = concat([body, new Sha1().update(body).digest()]);
  return { pack, entries };
}


// General-purpose parsing/resolution, kept out of this module so bundles of the edit path do not carry it.
export { parsePack, applyDelta, makeDelta, resolvePack } from './packresolve.js';
