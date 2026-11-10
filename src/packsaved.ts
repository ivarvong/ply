// Saved pack index (#260): a pack's index (scanPackIndex, #236) and its resolved columns (resolvePackRange, #248) as
// bytes, so a resumed transfer step (#238) reads them back instead of scanning and resolving the spooled pack again.
// For a 1.09 GB Artifacts pack the rescan is ~111 s in a Worker; the saved form is ~190 KB. Storage stays the caller's
// (an object store, a file, memory): ply gives bytes out and takes bytes in.
//
// Format, version 1, little-endian throughout:
//   header (64 B)  magic "PLYI", version u16, flags u16 (1 oids, 2 refs, 4 resolved), the pack's version u32, its
//                  header count u32, entries u32, the pack's length f64, its trailer (20 B), resolved entries u32 (0
//                  without them), 12 reserved zero bytes
//   index          offset f64, compressed f64, size f64, baseIndex i32, headerBytes u8, storedType u8, type u8 per
//                  entry (31 B); the whole-object ids (20 B per entry) with flag 1; the REF base ids (20 B) with flag 2
//   resolved       (flag 4) size f64, base i32, depth i32, oid 20 B, type u8 per entry (37 B); the run's stats, 9 f64
//   check (20 B)   SHA-1 of everything before it
// Bytes per entry: 31, +20 with oids (the default), +20 when the pack has a REF_DELTA, +37 with resolved columns; a
// REF-only pack (what Artifacts sends) with resolved columns is 108 B per entry, plus 64 + 72 + 20 B.
//
// Decoding refuses, as a SavedIndexRefusal: bytes that are not a saved index, another version, a length the header does
// not give (truncated), a check that does not match (corrupt), an index of another pack (the caller's expected
// trailer and length: a stale index is never used), and columns no scan could produce (malformed: entries not
// contiguous from the pack header to the trailer, a type or base out of range). loadTransferPack (below) turns any
// refusal into a fresh scan and says why on its span.
import type { PlyError } from './errors.js';
import { fail } from './errors.js';
import type { Option, Result } from './result.js';
import { ok, err, some, none, isSome, assertNever } from './result.js';
import type { RangeSource } from './rangesource.js';
import type { ScannedPack, ScanColumns } from './packscanindex.js';
import { scannedPackOf, SCAN_INDEX_ENTRY_BYTES } from './packscanindex.js';
import type { ResolvedIndex, ResolvedColumns, ResolveStats } from './packrangeresolve.js';
import { resolvedIndexOf, NO_BASE, THIN_BASE } from './packrangeresolve.js';
import { Sha1, toHex, fromHex } from './sha1.js';
import { OID_BYTES, OBJ_COMMIT, OBJ_TREE, OBJ_BLOB, OBJ_TAG, OBJ_OFS_DELTA, OBJ_REF_DELTA, PACK_TRAILER_BYTES } from './format.js';

export const SAVED_INDEX_VERSION = 1;
const MAGIC = [0x50, 0x4c, 0x59, 0x49];
const HEADER = 64;
const CHECK = 20;
const FLAG_OIDS = 1;
const FLAG_REFS = 2;
const FLAG_RESOLVED = 4;
const FLAGS_KNOWN = FLAG_OIDS | FLAG_REFS | FLAG_RESOLVED;
// pack header "PACK" + version + count: the first entry's offset
const PACK_HEADER_BYTES = 12;
const RESOLVED_BYTES = 37;
const STATS: ReadonlyArray<keyof ResolveStats> = ['inflated', 'applied', 'reads', 'readBytes', 'cacheHits', 'rebuilt', 'thinBases', 'work', 'workMax'];
const STATS_BYTES = STATS.length * 8;
export const SAVED_INDEX_ENTRY_BYTES: Readonly<{ index: number; oid: number; ref: number; resolved: number }> = Object.freeze({ index: SCAN_INDEX_ENTRY_BYTES, oid: OID_BYTES, ref: OID_BYTES, resolved: RESOLVED_BYTES });
export const SAVED_INDEX_FIXED_BYTES: number = HEADER + STATS_BYTES + CHECK;

// What a saved index must be the index of: the pack's trailer (40 hex) and its length in bytes.
export type PackIdentity = { readonly trailer: string; readonly bytes: number };
export type SavedIndex = { readonly pack: ScannedPack; readonly resolved: Option<ResolvedIndex> };
export type SavedIndexRefusal =
  | { readonly tag: 'not_saved_index' }
  | { readonly tag: 'version'; readonly version: number }
  | { readonly tag: 'truncated'; readonly bytes: number; readonly want: number }
  | { readonly tag: 'corrupt' }
  | { readonly tag: 'other_pack'; readonly saved: PackIdentity; readonly want: PackIdentity }
  | { readonly tag: 'malformed'; readonly field: string; readonly index: number };

const refused = (r: SavedIndexRefusal): Result<never, SavedIndexRefusal> => err(r);
const malformed = (field: string, index = -1): Result<never, SavedIndexRefusal> => refused({ tag: 'malformed', field, index });
const isWhole = (t: number): boolean => t === OBJ_COMMIT || t === OBJ_TREE || t === OBJ_BLOB || t === OBJ_TAG;
const isStored = (t: number): boolean => isWhole(t) || t === OBJ_OFS_DELTA || t === OBJ_REF_DELTA;

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const p of stream) { parts.push(p); n += p.length; }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
// The spool's identity: its length and its last 20 bytes, read through the source.
export async function packIdentity(source: RangeSource): Promise<Result<PackIdentity, PlyError>> {
  if (!Number.isSafeInteger(source.size) || source.size < 32) return fail('bad_request', `saved index: a spool of ${source.size} bytes holds no pack`, { what: 'spool' });
  const got = await source.read(source.size - PACK_TRAILER_BYTES, PACK_TRAILER_BYTES);
  if (!got.ok) return got;
  const tail = await readAll(got.value);
  if (tail.length !== PACK_TRAILER_BYTES) return fail('bad_request', `saved index: the spool's last ${PACK_TRAILER_BYTES} bytes read back as ${tail.length}`, { what: 'spool' });
  return ok({ trailer: toHex(tail), bytes: source.size });
}

// A refusal in words, for a span or a log line.
export function describeRefusal(r: SavedIndexRefusal): string {
  switch (r.tag) {
    case 'not_saved_index': return 'not a saved pack index';
    case 'version': return `saved index version ${r.version}, this ply reads ${SAVED_INDEX_VERSION}`;
    case 'truncated': return `saved index is ${r.bytes} bytes, its header gives ${r.want}`;
    case 'corrupt': return 'saved index check does not match its bytes';
    case 'other_pack': return `saved index is of pack ${r.saved.trailer} (${r.saved.bytes} B), not ${r.want.trailer} (${r.want.bytes} B)`;
    case 'malformed': return `saved index ${r.field} is not one a scan gives${r.index >= 0 ? ` (entry ${r.index})` : ''}`;
  }
  // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(r);
}

type Layout = { readonly n: number; readonly flags: number; readonly total: number };
const layoutOf = (n: number, flags: number): Layout => {
  const per = SCAN_INDEX_ENTRY_BYTES + ((flags & FLAG_OIDS) === 0 ? 0 : OID_BYTES) + ((flags & FLAG_REFS) === 0 ? 0 : OID_BYTES) + ((flags & FLAG_RESOLVED) === 0 ? 0 : RESOLVED_BYTES);
  return { n, flags, total: HEADER + n * per + ((flags & FLAG_RESOLVED) === 0 ? 0 : STATS_BYTES) + CHECK };
};

// A cursor over one buffer: each put/get moves it on.
type Cursor = { readonly bytes: Uint8Array; readonly view: DataView; at: number };
const cursorOf = (bytes: Uint8Array): Cursor => ({ bytes, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), at: 0 });
function putF64s(c: Cursor, col: Float64Array): void { for (const v of col) { c.view.setFloat64(c.at, v, true); c.at += 8; } }
function putI32s(c: Cursor, col: Int32Array): void { for (const v of col) { c.view.setInt32(c.at, v, true); c.at += 4; } }
function putBytes(c: Cursor, b: Uint8Array): void { c.bytes.set(b, c.at); c.at += b.length; }
function getF64s(c: Cursor, n: number): Float64Array { const out = new Float64Array(n); for (let i = 0; i < n; i++) { out[i] = c.view.getFloat64(c.at, true); c.at += 8; } return out; }
function getI32s(c: Cursor, n: number): Int32Array { const out = new Int32Array(n); for (let i = 0; i < n; i++) { out[i] = c.view.getInt32(c.at, true); c.at += 4; } return out; }
function getBytes(c: Cursor, n: number): Uint8Array { const out = c.bytes.slice(c.at, c.at + n); c.at += n; return out; }

// `pack` (complete: every entry the header counts) and, when given, its resolved columns, as bytes (see the top).
export function encodeSavedIndex(pack: ScannedPack, resolved: Option<ResolvedIndex>): Result<Uint8Array, PlyError> {
  const cols = pack.columns;
  const n = cols.offset.length;
  if (n !== pack.count) return fail('bad_request', `saved index: the index holds ${n} of the pack's ${pack.count} entries`, { what: 'pack' });
  if (!/^[0-9a-f]{40}$/u.test(pack.trailer)) return fail('bad_request', 'saved index: the index has no trailer', { what: 'pack' });
  if (isSome(resolved) && resolved.value.count !== n) return fail('bad_request', `saved index: ${resolved.value.count} resolved entries for ${n} in the index`, { what: 'resolved' });
  const oids = cols.oids.length === n * OID_BYTES && n > 0;
  const refs = cols.refs.length === n * OID_BYTES && n > 0;
  const flags = (oids ? FLAG_OIDS : 0) | (refs ? FLAG_REFS : 0) | (isSome(resolved) ? FLAG_RESOLVED : 0);
  const { total } = layoutOf(n, flags);
  const c = cursorOf(new Uint8Array(total));
  putBytes(c, Uint8Array.from(MAGIC));
  c.view.setUint16(4, SAVED_INDEX_VERSION, true);
  c.view.setUint16(6, flags, true);
  c.view.setUint32(8, pack.version, true);
  c.view.setUint32(12, pack.count, true);
  c.view.setUint32(16, n, true);
  c.view.setFloat64(20, pack.bytes, true);
  c.bytes.set(fromHex(pack.trailer), 28);
  c.view.setUint32(48, isSome(resolved) ? n : 0, true);
  c.at = HEADER;
  putF64s(c, cols.offset);
  putF64s(c, cols.compressed);
  putF64s(c, cols.size);
  putI32s(c, cols.baseIndex);
  putBytes(c, cols.headerBytes);
  putBytes(c, cols.storedType);
  putBytes(c, cols.type);
  if (oids) putBytes(c, cols.oids);
  if (refs) putBytes(c, cols.refs);
  if (isSome(resolved)) {
    const r = resolved.value.columns;
    putF64s(c, r.size);
    putI32s(c, r.base);
    putI32s(c, r.depth);
    putBytes(c, r.oid);
    putBytes(c, r.type);
    putF64s(c, Float64Array.from(STATS.map(k => resolved.value.stats[k])));
  }
  c.bytes.set(new Sha1().update(c.bytes.subarray(0, c.at)).digest(), c.at);
  return ok(c.bytes);
}

type Header = { readonly flags: number; readonly version: number; readonly count: number; readonly n: number; readonly bytes: number; readonly trailer: string; readonly resolvedN: number };
function readHeader(bytes: Uint8Array): Result<Header, SavedIndexRefusal> {
  if (bytes.length < HEADER + CHECK) return MAGIC.every((m, i) => i >= bytes.length || bytes[i] === m) ? refused({ tag: 'truncated', bytes: bytes.length, want: HEADER + CHECK }) : refused({ tag: 'not_saved_index' });
  if (!MAGIC.every((m, i) => bytes[i] === m)) return refused({ tag: 'not_saved_index' });
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = v.getUint16(4, true);
  if (version !== SAVED_INDEX_VERSION) return refused({ tag: 'version', version });
  const flags = v.getUint16(6, true);
  const n = v.getUint32(16, true);
  const want = layoutOf(n, flags & FLAGS_KNOWN).total;
  if (bytes.length < want) return refused({ tag: 'truncated', bytes: bytes.length, want });
  const body = bytes.subarray(0, bytes.length - CHECK);
  if (toHex(new Sha1().update(body).digest()) !== toHex(bytes.subarray(bytes.length - CHECK))) return refused({ tag: 'corrupt' });
  if (bytes.length !== want) return malformed('length');
  if ((flags & ~FLAGS_KNOWN) !== 0) return malformed('flags');
  if (!bytes.subarray(52, HEADER).every(b => b === 0)) return malformed('reserved');
  return ok({ flags, version: v.getUint32(8, true), count: v.getUint32(12, true), n, bytes: v.getFloat64(20, true), trailer: toHex(bytes.subarray(28, 48)), resolvedN: v.getUint32(48, true) });
}

// Where each column starts, in a buffer whose header says `n` entries and `flags`.
type Regions = { readonly offset: number; readonly compressed: number; readonly size: number; readonly baseIndex: number; readonly headerBytes: number; readonly storedType: number; readonly type: number; readonly oids: number; readonly refs: number; readonly resolved: number };
function regionsOf(n: number, flags: number): Regions {
  const offset = HEADER;
  const compressed = offset + n * 8;
  const size = compressed + n * 8;
  const baseIndex = size + n * 8;
  const headerBytes = baseIndex + n * 4;
  const storedType = headerBytes + n;
  const type = storedType + n;
  const oids = type + n;
  const refs = oids + ((flags & FLAG_OIDS) === 0 ? 0 : n * OID_BYTES);
  const resolved = refs + ((flags & FLAG_REFS) === 0 ? 0 : n * OID_BYTES);
  return { offset, compressed, size, baseIndex, headerBytes, storedType, type, oids, refs, resolved };
}

// Entry i's columns read from the buffer: where it ends, or the field no scan gives.
type EntryCheck = { readonly tag: 'end'; readonly end: number; readonly ref: boolean } | { readonly tag: 'bad'; readonly field: string };
const bad = (field: string): EntryCheck => ({ tag: 'bad', field });
function checkEntry(v: DataView, h: Header, at: Regions, i: number, start: number): EntryCheck {
  const storedOf = (k: number): number => v.getUint8(at.storedType + k);
  const typeOf = (k: number): number => v.getUint8(at.type + k);
  const comp = v.getFloat64(at.compressed + i * 8, true);
  const size = v.getFloat64(at.size + i * 8, true);
  const base = v.getInt32(at.baseIndex + i * 4, true);
  const headerBytes = v.getUint8(at.headerBytes + i);
  const stored = storedOf(i);
  const type = typeOf(i);
  if (v.getFloat64(at.offset + i * 8, true) !== start) return bad('offset');
  if (!Number.isSafeInteger(comp) || comp < 2 || !Number.isSafeInteger(size) || size < 0 || headerBytes < 1) return bad('size');
  if (!isStored(stored)) return bad('storedType');
  const end: EntryCheck = { tag: 'end', end: start + headerBytes + comp, ref: stored === OBJ_REF_DELTA };
  if (isWhole(stored)) return type === stored && base === -1 ? end : bad('type');
  const baseOk = stored === OBJ_OFS_DELTA ? base >= 0 && base < i : base >= -1 && base < h.n && (base < 0 || isWhole(storedOf(base)));
  if (!baseOk) return bad('baseIndex');
  return type === (base < 0 ? 0 : typeOf(base)) ? end : bad('type');
}
// Every entry where the previous ended, from the pack header to the trailer; each type and base where a scan puts it.
function checkIndex(v: DataView, h: Header, at: Regions): Result<true, SavedIndexRefusal> {
  if (h.n !== h.count || !Number.isSafeInteger(h.bytes)) return malformed('count');
  let end = PACK_HEADER_BYTES;
  let anyRef = false;
  for (let i = 0; i < h.n; i++) {
    const e = checkEntry(v, h, at, i, end);
    if (e.tag === 'bad') return malformed(e.field, i);
    end = e.end;
    anyRef = anyRef || e.ref;
  }
  if (end !== h.bytes - PACK_TRAILER_BYTES) return malformed('offset', h.n);
  return anyRef === ((h.flags & FLAG_REFS) !== 0) ? ok(true) : malformed('flags');
}
// Resolved columns: a whole type each, a base in range (never itself), depth 0 exactly for a whole object.
function checkResolved(v: DataView, n: number, from: number): Result<true, SavedIndexRefusal> {
  const sizeAt = from;
  const baseAt = sizeAt + n * 8;
  const depthAt = baseAt + n * 4;
  const typeAt = depthAt + n * 4 + n * OID_BYTES;
  for (let i = 0; i < n; i++) {
    const base = v.getInt32(baseAt + i * 4, true);
    const depth = v.getInt32(depthAt + i * 4, true);
    const size = v.getFloat64(sizeAt + i * 8, true);
    if (!isWhole(v.getUint8(typeAt + i))) return malformed('resolved.type', i);
    if (base < THIN_BASE || base >= n || base === i) return malformed('resolved.base', i);
    if (depth < 0 || (base === NO_BASE) !== (depth === 0)) return malformed('resolved.depth', i);
    if (!Number.isSafeInteger(size) || size < 0) return malformed('resolved.size', i);
  }
  const statsAt = typeAt + n;
  return STATS.every((_, k) => { const s = v.getFloat64(statsAt + k * 8, true); return Number.isFinite(s) && s >= 0; }) ? ok(true) : malformed('resolved.stats');
}
function statsOf(v: DataView, at: number): ResolveStats {
  const f = (k: number): number => v.getFloat64(at + k * 8, true);
  return { inflated: f(0), applied: f(1), reads: f(2), readBytes: f(3), cacheHits: f(4), rebuilt: f(5), thinBases: f(6), work: f(7), workMax: f(8) };
}

// Saved bytes → the index and, when saved, its resolved columns; refused unless they are an intact saved index of
// exactly the pack `want` names (see the top of this file).
export function decodeSavedIndex(bytes: Uint8Array, want: PackIdentity): Result<SavedIndex, SavedIndexRefusal> {
  const head = readHeader(bytes);
  if (!head.ok) return head;
  const h = head.value;
  if (h.trailer !== want.trailer || h.bytes !== want.bytes) return refused({ tag: 'other_pack', saved: { trailer: h.trailer, bytes: h.bytes }, want });
  const hasResolved = (h.flags & FLAG_RESOLVED) !== 0;
  if (h.resolvedN !== (hasResolved ? h.n : 0)) return malformed('resolved.count');
  const n = h.n;
  const at = regionsOf(n, h.flags);
  const c = cursorOf(bytes);
  const checked = checkIndex(c.view, h, at);
  if (!checked.ok) return checked;
  if (hasResolved) {
    const good = checkResolved(c.view, n, at.resolved);
    if (!good.ok) return good;
  }
  c.at = HEADER;
  const offset = getF64s(c, n);
  const compressed = getF64s(c, n);
  const size = getF64s(c, n);
  const baseIndex = getI32s(c, n);
  const headerBytes = getBytes(c, n);
  const storedType = getBytes(c, n);
  const type = getBytes(c, n);
  const oids = (h.flags & FLAG_OIDS) === 0 ? new Uint8Array(0) : getBytes(c, n * OID_BYTES);
  const refs = (h.flags & FLAG_REFS) === 0 ? new Uint8Array(0) : getBytes(c, n * OID_BYTES);
  const columns: ScanColumns = { offset, headerBytes, compressed, size, storedType, type, baseIndex, oids, refs };
  const pack = scannedPackOf({ version: h.version, count: h.count, trailer: h.trailer, bytes: h.bytes, heldBytes: n * SCAN_INDEX_ENTRY_BYTES + oids.length + refs.length }, columns);
  if (!hasResolved) return ok({ pack, resolved: none });
  const r: ResolvedColumns = { size: getF64s(c, n), base: getI32s(c, n), depth: getI32s(c, n), oid: getBytes(c, n * OID_BYTES), type: getBytes(c, n) };
  return ok({ pack, resolved: some(resolvedIndexOf(r, statsOf(c.view, c.at))) });
}
