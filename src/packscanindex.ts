// Streaming pack index (issue #236): read a pack from a stream and return each entry's layout without resolving a delta
// or keeping an object. indexPack and describePack need the whole pack in memory and resolve every object; this is their
// counterpart for a pack too large to hold, built on the pull scan (packstream.ts) under its work budget (#240).
//
// What it keeps: the scan's constant hold (peakBound('pack-scan'), streambound.ts), plus SCAN_INDEX_ENTRY_BYTES per
// entry in typed columns, plus OID_BYTES per entry for each oid column in use (whole-object oids when `oids` is on, REF
// bases once the pack has a REF_DELTA). Columns grow by doubling, never past the header's count, so a header that lies
// about its count costs only the entries that arrive. A selected object's content (`content`) is held whole until its
// callback returns; it is capped by maxObjectSize.
//
// Verified while scanning: zlib validity and each member's declared size (inflatestream.ts), each OFS base an earlier
// entry's offset (git index-pack: "delta base offset is out of bound" otherwise), and the trailer when verify is on.
// Entries are contiguous by construction: the scan reads each one where the previous ended.
//
// The resolved type is the type of the whole object a delta chain rests on: a whole object's own; an OFS_DELTA's
// base's; a REF_DELTA's base's when that base is a whole object in this pack whose oid was computed (oids on). Anything
// else (a base absent from the pack, a base that is itself a delta, oids off) is unknown, never a guess.
import type { PlyError } from './errors.js';
import { plyError } from './errors.js';
import type { Option, Result } from './result.js';
import { ok, err, some, none, assertNever } from './result.js';
import { withDefaults } from './absent.js';
import type { LimitsInput } from './limits.js';
import { DEFAULT_LIMITS, limitExceeded, parseLimits } from './limits.js';
import type { Oid } from './oid.js';
import { Sha1, fromHex, toOid } from './sha1.js';
import { encodeBytes } from './bytes.js';
import type { ObjType } from './format.js';
import { OBJ_COMMIT, OBJ_TREE, OBJ_BLOB, OBJ_TAG, OBJ_OFS_DELTA, OBJ_REF_DELTA, OID_BYTES } from './format.js';
import type { PackError, PackPiece, PackScan, ScanBudget } from './packstream.js';
import { WORK_BUDGET, parsePackInit, parsePackFeed, parsePackClose, parsePackPull } from './packstream.js';
import { TYPE_NAME } from './objects.js';

// In-range indexed reads of columns this module sized; noUncheckedIndexedAccess cannot see that.
/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- in-range indexed reads, see above */

export type ScanSource = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
// A whole object's type: what a delta chain resolves to.
export type ScannedType = typeof OBJ_COMMIT | typeof OBJ_TREE | typeof OBJ_BLOB | typeof OBJ_TAG;
// An entry's base as stored: none, an earlier entry (OFS_DELTA, by offset and index), or an id (REF_DELTA). `index` on a
// REF base is the whole object in this pack with that id, or -1 when there is none (or oids were off).
export type ScannedBase =
  | { readonly tag: 'none' }
  | { readonly tag: 'ofs'; readonly offset: number; readonly index: number }
  | { readonly tag: 'ref'; readonly oid: Oid; readonly index: number };
export type ScannedEntry = {
  readonly index: number;
  readonly offset: number;
  readonly headerBytes: number;
  readonly compressed: number;
  // the type in the entry header (OFS_DELTA and REF_DELTA included) and its declared inflated size
  readonly storedType: ObjType;
  readonly size: number;
  readonly base: ScannedBase;
  // the resolved type, null when it cannot be known without resolving deltas (see the top of this file)
  readonly type: ScannedType | null;
  // a whole object's id, when oids are on; null for a delta or with oids off
  readonly oid: Oid | null;
};
// What a content callback sees: a whole object, its id once hashed (oids on), and its bytes.
export type ScannedObject = { readonly index: number; readonly type: ScannedType; readonly size: number; readonly oid: Oid | null };
export type ScanContent = {
  readonly select: (head: { readonly index: number; readonly type: ScannedType; readonly size: number }) => boolean;
  readonly take: (object: ScannedObject, data: Uint8Array) => void | Promise<void>;
};
export type ScanIndexOpts = {
  readonly limits: LimitsInput;
  readonly verify: boolean;
  readonly budget: ScanBudget;
  readonly oids: boolean;
  readonly content: ScanContent | null;
};
// A fresh record per call: withDefaults fills it in place.
const defaultOpts = (): ScanIndexOpts => ({ limits: DEFAULT_LIMITS, verify: true, budget: WORK_BUDGET, oids: false, content: null });

// Typed columns, one slot per entry. `type` is 0 for unknown; `baseIndex` is -1 for none or not found.
export type ScanColumns = {
  readonly offset: Float64Array;
  readonly headerBytes: Uint8Array;
  readonly compressed: Float64Array;
  readonly size: Float64Array;
  readonly storedType: Uint8Array;
  readonly type: Uint8Array;
  readonly baseIndex: Int32Array;
};
export type ScannedPack = {
  readonly version: number;
  readonly count: number;
  readonly trailer: string;
  readonly bytes: number;
  readonly columns: ScanColumns;
  // the column bytes this index holds, oid columns included
  readonly heldBytes: number;
  // the entry at 0 <= index < count, or none
  readonly entry: (index: number) => Option<ScannedEntry>;
  readonly entries: () => IterableIterator<ScannedEntry>;
};

// offset 8 + headerBytes 1 + compressed 8 + size 8 + storedType 1 + type 1 + baseIndex 4
export const SCAN_INDEX_ENTRY_BYTES = 31;
const FIRST_CAPACITY = 1024;
const UNKNOWN = 0;
const NO_INDEX = -1;

type Store = {
  n: number;
  cap: number;
  offset: Float64Array;
  headerBytes: Uint8Array;
  compressed: Float64Array;
  size: Float64Array;
  storedType: Uint8Array;
  type: Uint8Array;
  baseIndex: Int32Array;
  oids: Uint8Array;
  refs: Uint8Array;
};
const EMPTY = new Uint8Array(0);

function grown<T extends Float64Array | Uint8Array | Int32Array>(old: T, make: (n: number) => T, cap: number, used: number): T {
  const next = make(cap);
  next.set(old.subarray(0, used));
  return next;
}
// Room for one more entry: double, never past the header's count.
function ensureRoom(s: Store, count: number, oids: boolean): void {
  if (s.n < s.cap) return;
  const cap = Math.min(count, Math.max(FIRST_CAPACITY, s.cap * 2));
  s.offset = grown(s.offset, k => new Float64Array(k), cap, s.n);
  s.headerBytes = grown(s.headerBytes, k => new Uint8Array(k), cap, s.n);
  s.compressed = grown(s.compressed, k => new Float64Array(k), cap, s.n);
  s.size = grown(s.size, k => new Float64Array(k), cap, s.n);
  s.storedType = grown(s.storedType, k => new Uint8Array(k), cap, s.n);
  s.type = grown(s.type, k => new Uint8Array(k), cap, s.n);
  s.baseIndex = grown(s.baseIndex, k => new Int32Array(k), cap, s.n);
  if (oids) s.oids = grown(s.oids, k => new Uint8Array(k), cap * OID_BYTES, s.n * OID_BYTES);
  if (s.refs.length > 0) s.refs = grown(s.refs, k => new Uint8Array(k), cap * OID_BYTES, s.n * OID_BYTES);
  s.cap = cap;
}
const isWhole = (t: number): t is ScannedType => t === OBJ_COMMIT || t === OBJ_TREE || t === OBJ_BLOB || t === OBJ_TAG;

// The earlier entry at `offset`: offsets are strictly increasing, so a binary search over the first `n`.
function entryAt(s: Store, offset: number): number {
  let lo = 0;
  let hi = s.n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const at = s.offset[mid] as number;
    if (at === offset) return mid;
    if (at < offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return NO_INDEX;
}
function oidCompare(a: Uint8Array, ai: number, b: Uint8Array, bi: number): number {
  for (let k = 0; k < OID_BYTES; k++) {
    const d = (a[ai + k] as number) - (b[bi + k] as number);
    if (d !== 0) return d;
  }
  return 0;
}
// The whole object whose id is entry i's REF base, among `sorted` (whole-object indices in oid order), or NO_INDEX.
function findWhole(s: Store, sorted: readonly number[], i: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const cand = sorted[mid] as number;
    const d = oidCompare(s.oids, cand * OID_BYTES, s.refs, i * OID_BYTES);
    if (d === 0) return cand;
    if (d < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return NO_INDEX;
}
// After the last entry: each REF base found among the whole objects (oids on), then every type in pack order. An OFS
// base is earlier than its delta, and a found REF base is a whole object, so one ascending pass settles every chain.
function settle(s: Store, oids: boolean): void {
  const wholes: number[] = [];
  if (oids && s.refs.length > 0) {
    for (let i = 0; i < s.n; i++) if (isWhole(s.storedType[i] as number)) wholes.push(i);
    wholes.sort((x, y) => oidCompare(s.oids, x * OID_BYTES, s.oids, y * OID_BYTES));
  }
  // whole objects first: a REF base can come later in the pack than its delta
  for (let i = 0; i < s.n; i++) {
    const stored = s.storedType[i] as number;
    if (isWhole(stored)) s.type[i] = stored;
  }
  for (let i = 0; i < s.n; i++) {
    const stored = s.storedType[i] as number;
    if (isWhole(stored)) continue;
    if (stored === OBJ_REF_DELTA) s.baseIndex[i] = findWhole(s, wholes, i);
    const base = s.baseIndex[i] as number;
    s.type[i] = base === NO_INDEX ? UNKNOWN : (s.type[base] as number);
  }
}

function view(s: Store, oids: boolean, i: number): ScannedEntry {
  const stored = s.storedType[i] as ObjType;
  const t = s.type[i] as number;
  const baseIndex = s.baseIndex[i] as number;
  let base: ScannedBase;
  if (stored === OBJ_OFS_DELTA) base = { tag: 'ofs', offset: s.offset[baseIndex] as number, index: baseIndex };
  else if (stored === OBJ_REF_DELTA) base = { tag: 'ref', oid: toOid(s.refs.subarray(i * OID_BYTES, (i + 1) * OID_BYTES)), index: baseIndex };
  else base = { tag: 'none' };
  return {
    index: i, offset: s.offset[i] as number, headerBytes: s.headerBytes[i] as number, compressed: s.compressed[i] as number,
    storedType: stored, size: s.size[i] as number, base,
    type: isWhole(t) ? t : null,
    oid: oids && isWhole(stored) ? toOid(s.oids.subarray(i * OID_BYTES, (i + 1) * OID_BYTES)) : null,
  };
}

type Pull = { readonly next: () => Promise<Uint8Array | null>; readonly cancel: () => Promise<void> };
function puller(source: ScanSource): Pull {
  if ('getReader' in source) {
    const reader = source.getReader();
    return {
      next: async () => { const r = await reader.read(); return r.done ? null : r.value; },
      cancel: async () => { await reader.cancel().catch(() => null); },
    };
  }
  const it = source[Symbol.asyncIterator]();
  return {
    next: async () => { const r = await it.next(); return r.done === true ? null : r.value; },
    cancel: async () => { if (typeof it.return === 'function') await Promise.resolve(it.return()).catch(() => null); },
  };
}

// One scan's state: the columns, the pack's header and trailer, and the object being read (its hash when oids are on,
// its bytes when the caller selected it).
type Scanner = {
  readonly s: Store;
  readonly opts: ScanIndexOpts;
  readonly maxSelected: number;
  version: number;
  count: number;
  trailer: string;
  sha: Sha1 | null;
  data: Uint8Array;
  at: number;
  selected: ScannedType | null;
};
type ObjectPiece = Extract<PackPiece, { kind: 'object' }>;
type ScanError = PackError | PlyError;

// An OFS base must be an earlier entry's offset; a REF base's id goes in the refs column (allocated on the first one).
function recordBase(s: Store, i: number, p: ObjectPiece): ScanError | null {
  s.baseIndex[i] = NO_INDEX;
  switch (p.base.tag) {
    case 'none': return null;
    case 'ofs': {
      const base = entryAt(s, p.base.offset);
      if (base === NO_INDEX) return plyError('pack_corrupt', `pack: ofs delta base not at object boundary ${p.base.offset}`);
      s.baseIndex[i] = base;
      return null;
    }
    case 'ref':
      if (s.refs.length === 0) s.refs = new Uint8Array(s.cap * OID_BYTES);
      s.refs.set(fromHex(p.base.oid), i * OID_BYTES);
      return null;
  }
  // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(p.base);
}
// A whole object: start its hash (oids on), and its buffer when the caller selects it.
function openWhole(sc: Scanner, i: number, type: ScannedType, size: number): ScanError | null {
  if (sc.opts.oids) {
    const head = encodeBytes(`${TYPE_NAME[type]} ${size}\0`);
    if (!head.ok) return head.error;
    sc.sha = new Sha1().update(head.value);
  }
  const content = sc.opts.content;
  if (content === null || !content.select({ index: i, type, size })) return null;
  if (size > sc.maxSelected) return limitExceeded('selected object bytes', size, sc.maxSelected);
  sc.data = new Uint8Array(size);
  sc.selected = type;
  return null;
}
function onObject(sc: Scanner, p: ObjectPiece): ScanError | null {
  const s = sc.s;
  ensureRoom(s, sc.count, sc.opts.oids);
  const i = s.n;
  s.offset[i] = p.offset;
  s.headerBytes[i] = p.headerBytes;
  s.size[i] = p.size;
  s.storedType[i] = p.type;
  sc.sha = null;
  sc.data = EMPTY;
  sc.at = 0;
  sc.selected = null;
  // the base is searched among the entries before this one
  const based = recordBase(s, i, p);
  s.n += 1;
  if (based !== null) return based;
  const stored: number = p.type;
  return isWhole(stored) ? openWhole(sc, i, stored, p.size) : null;
}
function onChunk(sc: Scanner, bytes: Uint8Array): void {
  if (sc.sha !== null) sc.sha.update(bytes);
  if (sc.selected === null) return;
  sc.data.set(bytes, sc.at);
  sc.at += bytes.length;
}
async function onObjectEnd(sc: Scanner, i: number, compressed: number): Promise<void> {
  sc.s.compressed[i] = compressed;
  let oid: Oid | null = null;
  if (sc.sha !== null) {
    const digest = sc.sha.digest();
    sc.s.oids.set(digest, i * OID_BYTES);
    oid = toOid(digest);
  }
  const content = sc.opts.content;
  if (sc.selected === null || content === null) return;
  const object: ScannedObject = { index: i, type: sc.selected, size: sc.data.length, oid };
  const data = sc.data;
  sc.data = EMPTY;
  sc.selected = null;
  await content.take(object, data);
}

function finish(sc: Scanner, bytes: number): ScannedPack {
  const s = sc.s;
  const oids = sc.opts.oids;
  const n = s.n;
  const columns: ScanColumns = {
    offset: s.offset.subarray(0, n), headerBytes: s.headerBytes.subarray(0, n), compressed: s.compressed.subarray(0, n),
    size: s.size.subarray(0, n), storedType: s.storedType.subarray(0, n), type: s.type.subarray(0, n), baseIndex: s.baseIndex.subarray(0, n),
  };
  const heldBytes = s.cap * SCAN_INDEX_ENTRY_BYTES + s.oids.length + s.refs.length;
  const entry = (i: number): Option<ScannedEntry> => (Number.isInteger(i) && i >= 0 && i < n ? some(view(s, oids, i)) : none);
  function* entries(): IterableIterator<ScannedEntry> { for (let i = 0; i < n; i++) yield view(s, oids, i); }
  return { version: sc.version, count: sc.count, trailer: sc.trailer, bytes, columns, heldBytes, entry, entries };
}

// One pulled piece: feed the scan, record an entry, or note the header or trailer. A non-null error is the refusal.
async function onPiece(sc: Scanner, st: PackScan, pull: Pull, p: PackPiece): Promise<ScanError | null> {
  switch (p.kind) {
    case 'need': {
      const bytes = await pull.next();
      if (bytes === null) parsePackClose(st);
      else parsePackFeed(st, bytes);
      return null;
    }
    case 'header':
      sc.version = p.version;
      sc.count = p.count;
      return null;
    case 'object': return onObject(sc, p);
    case 'chunk':
      onChunk(sc, p.bytes);
      return null;
    case 'object-end':
      await onObjectEnd(sc, p.index, p.compressed);
      return null;
    case 'trailer':
      sc.trailer = p.trailer;
      return null;
    case 'end': return null;
  }
  // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(p);
}

// Scan `source` and index every entry (see the top of this file). A refusal is a Result and cancels the source; a source
// that errors rejects with its own error, and so does a content callback that throws.
export async function scanPackIndex(source: ScanSource, input: Partial<ScanIndexOpts> = {}): Promise<Result<ScannedPack, ScanError>> {
  const opts = withDefaults(input, defaultOpts());
  const limits = parseLimits(opts.limits);
  if (!limits.ok) return limits;
  const opened = parsePackInit({ limits: opts.limits, verify: opts.verify, budget: opts.budget });
  if (!opened.ok) return opened;
  const st = opened.value;
  const pull = puller(source);
  const s: Store = {
    n: 0, cap: 0, offset: new Float64Array(0), headerBytes: EMPTY, compressed: new Float64Array(0), size: new Float64Array(0),
    storedType: EMPTY, type: EMPTY, baseIndex: new Int32Array(0), oids: EMPTY, refs: EMPTY,
  };
  const sc: Scanner = { s, opts, maxSelected: limits.value.maxObjectSize, version: 0, count: 0, trailer: '', sha: null, data: EMPTY, at: 0, selected: null };
  for (;;) {
    const got = parsePackPull(st);
    if (got.ok && got.value.kind === 'end') {
      settle(s, opts.oids);
      return ok(finish(sc, st.total));
    }
    // oxlint-disable-next-line no-await-in-loop -- one stream, read in order
    const refused = got.ok ? await onPiece(sc, st, pull, got.value) : got.error;
    if (refused !== null) {
      // oxlint-disable-next-line no-await-in-loop -- the loop ends here
      await pull.cancel();
      return err(refused);
    }
  }
}
