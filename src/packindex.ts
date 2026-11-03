// Pack index v2 (gitformat-pack "Version 2 pack-*.idx files"), the file `git index-pack` writes beside a pack: what a
// dumb-HTTP client (and any git reading a pack from disk) needs to find an object without reading the pack. Pure and
// Workers-safe; the SHA-1 is ply's own, so it is synchronous.
//
//   encodePackIndex(pack, objects) → the .idx of a pack you just wrote (buildPack's entries give the offsets; you know
//                                    the ids): CRC-32s from the pack's bytes, the pack checksum from its trailer
//   indexPack(pack, limits)        → the .idx of any self-contained pack (git index-pack): parsed, trailer verified,
//                                    every object resolved and hashed; a thin pack is pack_corrupt (no --fix-thin)
//   layoutPackIndex(rows, checksum) → the layout alone, from { oid, offset, crc32 } rows
//
// Byte for byte what git 2.x index-pack writes for the same pack (test/packindex.test.js), including the 64-bit offset
// table for objects at or past 2 GiB. One object id twice is refused, as `index-pack --strict` refuses it.
/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- indexed reads of a CRC table and of a sorted array within its checked length say `as number`, as packresolve.ts does */
import { fail } from './errors.js';
import type { PlyError } from './errors.js';
import { DEFAULT_LIMITS } from './limits.js';
import type { Limits } from './limits.js';
import { Sha1, fromHex, toHex } from './sha1.js';
import { parsePack, resolvePack } from './packresolve.js';
import { OID_BYTES, PACK_HEADER_BYTES, PACK_SIGNATURE, PACK_TRAILER_BYTES, PACK_VERSION } from './format.js';
import { ok } from './result.js';
import type { Result } from './result.js';

/** One object of the index: its id, its entry's offset in the pack, and the CRC-32 of the entry's bytes as stored. */
export type IndexRow = { readonly oid: string; readonly offset: number; readonly crc32: number };
/** One object of a pack you wrote: its id and its entry's offset (buildPack's `entries[i].offset`). */
export type IndexedObject = { readonly oid: string; readonly offset: number };
export type IndexedPack = { readonly idx: Uint8Array<ArrayBuffer>; readonly checksum: string; readonly objects: number };

const IDX_SIGNATURE = [0xff, 0x74, 0x4f, 0x63]; // "\377tOc"
const IDX_VERSION = 2;
const FANOUT = 256;
const U32 = 4;
const U64 = 8;
// An offset at or past 2^31 goes to the 64-bit table; its 32-bit slot holds that table's index with the high bit set.
const LARGE_OFFSET = 0x80_00_00_00;
const U32_LIMIT = 0x1_00_00_00_00;
const OID_RE = /^[0-9a-f]{40}$/u;

// CRC-32 (ISO-HDLC, zlib's crc32: reflected, polynomial 0xEDB88320), the checksum git stores per entry.
const CRC_POLY = 0xed_b8_83_20;
let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (crcTable === null) {
    const t = new Uint32Array(FANOUT);
    for (let n = 0; n < FANOUT; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? CRC_POLY ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    crcTable = t;
  }
  const t = crcTable;
  let c = 0xff_ff_ff_ff;
  for (const b of bytes) c = (t[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xff_ff_ff_ff) >>> 0;
}

const bad = (message: string, what: string): Result<never, PlyError> => fail('bad_request', message, { what });

/** The .idx v2 bytes for `rows`, which name every object of the pack whose trailer is `packChecksum`. */
export function layoutPackIndex(rows: readonly IndexRow[], packChecksum: Uint8Array): Result<Uint8Array<ArrayBuffer>, PlyError> {
  if (packChecksum.length !== OID_BYTES) return bad(`pack index: the pack checksum is ${packChecksum.length} bytes, not ${OID_BYTES}`, 'checksum');
  for (const r of rows) {
    if (!OID_RE.test(r.oid)) return bad(`pack index: ${JSON.stringify(r.oid)} is not a 40-hex object id`, 'oid');
    if (!Number.isSafeInteger(r.offset) || r.offset < PACK_HEADER_BYTES) return bad(`pack index: offset ${r.offset} of ${r.oid} is not an entry offset`, 'offset');
    if (!Number.isInteger(r.crc32) || r.crc32 < 0 || r.crc32 >= U32_LIMIT) return bad(`pack index: crc32 ${r.crc32} of ${r.oid} is not a 32-bit value`, 'crc32');
  }
  const byOid = (a: IndexRow, b: IndexRow): number => {
    if (a.oid === b.oid) return 0;
    return a.oid < b.oid ? -1 : 1;
  };
  const sorted = rows.toSorted(byOid);
  for (let i = 1; i < sorted.length; i++) {
    const oid = (sorted[i] as IndexRow).oid;
    if (oid === (sorted[i - 1] as IndexRow).oid) return bad(`pack index: ${oid} appears twice`, 'oid');
  }
  const n = sorted.length;
  const large = sorted.filter(r => r.offset >= LARGE_OFFSET);
  const out = new Uint8Array(IDX_SIGNATURE.length + U32 + FANOUT * U32 + n * (OID_BYTES + U32 + U32) + large.length * U64 + 2 * OID_BYTES);
  const dv = new DataView(out.buffer);
  out.set(IDX_SIGNATURE);
  let p = IDX_SIGNATURE.length;
  dv.setUint32(p, IDX_VERSION); p += U32;
  // fanout[b]: how many ids have a first byte ≤ b
  const counts = new Uint32Array(FANOUT);
  for (const r of sorted) { const b = Number.parseInt(r.oid.slice(0, 2), 16); counts[b] = (counts[b] as number) + 1; }
  let total = 0;
  for (const c of counts) { total += c; dv.setUint32(p, total); p += U32; }
  for (const r of sorted) { out.set(fromHex(r.oid), p); p += OID_BYTES; }
  for (const r of sorted) { dv.setUint32(p, r.crc32); p += U32; }
  let li = 0;
  for (const r of sorted) {
    dv.setUint32(p, r.offset < LARGE_OFFSET ? r.offset : (LARGE_OFFSET | li) >>> 0);
    if (r.offset >= LARGE_OFFSET) li++;
    p += U32;
  }
  for (const r of large) { dv.setBigUint64(p, BigInt(r.offset)); p += U64; }
  out.set(packChecksum, p); p += OID_BYTES;
  out.set(new Sha1().update(out.subarray(0, p)).digest(), p);
  return ok(out);
}

// The pack's object count from its header, or a refusal when it is not a version-2 pack with room for a trailer.
function packCount(pack: Uint8Array): Result<number, PlyError> {
  if (pack.length < PACK_HEADER_BYTES + PACK_TRAILER_BYTES) return bad(`pack index: ${pack.length} bytes is shorter than a pack`, 'pack');
  const dv = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const signed = PACK_SIGNATURE.every((b, i) => pack[i] === b) && dv.getUint32(PACK_SIGNATURE.length) === PACK_VERSION;
  if (!signed) return bad('pack index: not a version 2 pack', 'pack');
  return ok(dv.getUint32(PACK_SIGNATURE.length + U32));
}

/**
 * The .idx of a pack you just wrote. `objects` names every entry: its id and its offset (buildPack's entries, in pack
 * order, carry the offsets). Each entry's bytes run to the next entry (or the trailer); their CRC-32 is computed here.
 * Offsets are trusted as entry boundaries, not re-parsed: use indexPack for a pack from elsewhere.
 */
export function encodePackIndex(pack: Uint8Array, objects: readonly IndexedObject[]): Result<Uint8Array<ArrayBuffer>, PlyError> {
  const count = packCount(pack);
  if (!count.ok) return count;
  if (objects.length !== count.value) return bad(`pack index: ${objects.length} objects given for a pack of ${count.value}`, 'objects');
  const end = pack.length - PACK_TRAILER_BYTES;
  const byOffset = objects.toSorted((a, b) => a.offset - b.offset);
  const rows: IndexRow[] = [];
  for (let i = 0; i < byOffset.length; i++) {
    const o = byOffset[i] as IndexedObject;
    const next = i + 1 < byOffset.length ? (byOffset[i + 1] as IndexedObject).offset : end;
    if (i === 0 && o.offset !== PACK_HEADER_BYTES) return bad(`pack index: the first entry is at ${o.offset}, not ${PACK_HEADER_BYTES}`, 'offset');
    if (!Number.isSafeInteger(o.offset) || next <= o.offset || next > end) return bad(`pack index: offset ${o.offset} of ${o.oid} is not an entry boundary`, 'offset');
    rows.push({ oid: o.oid, offset: o.offset, crc32: crc32(pack.subarray(o.offset, next)) });
  }
  return layoutPackIndex(rows, pack.subarray(end));
}

/**
 * The .idx of any self-contained pack, as `git index-pack` writes it: the pack is parsed under `limits` and its trailer
 * verified, every object is resolved (a REF_DELTA base outside the pack is pack_corrupt) and hashed. One object twice is
 * pack_corrupt.
 */
export function indexPack(pack: Uint8Array, limits: Limits = DEFAULT_LIMITS): Result<IndexedPack, PlyError> {
  const parsed = parsePack(pack, { limits });
  if (!parsed.ok) return parsed;
  const resolved = resolvePack(parsed.value, () => null, limits);
  if (!resolved.ok) return resolved;
  if (resolved.value.objects.size !== parsed.value.objects.length) return fail('pack_corrupt', `pack index: ${parsed.value.objects.length - resolved.value.objects.size} objects appear twice in the pack`, { what: 'object' });
  const objects = [...resolved.value.objects.values()].map(o => ({ oid: o.oid, offset: o.offset }));
  const idx = encodePackIndex(pack, objects);
  if (!idx.ok) return idx;
  return ok({ idx: idx.value, checksum: toHex(pack.subarray(pack.length - PACK_TRAILER_BYTES)), objects: objects.length });
}
