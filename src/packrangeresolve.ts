// Every entry's oid and resolved type for a pack too large to hold (#248): what `git index-pack` computes, over a spooled
// pack read back through a RangeSource, in memory bounded by object size rather than pack size. The layout comes from
// scanPackIndex (#236); this applies the deltas that scan cannot.
//
// Why: a REF_DELTA names its base by oid, and a delta's oid is known only once it is applied. Cloudflare Artifacts sends
// every delta as REF_DELTA, so on its packs any chain deeper than one is unknown to the scan, and children-first
// planning (#237) needs every type.
//
// How: from each whole object, depth first over the deltas that rest on it (OFS children by base index, REF children by
// the base's oid). A delta's bytes are read back through the source, inflated and applied to its base. Nothing holds a
// chain. All the deltas resting on a base are applied while that base is held; of the results that something rests on,
// the last is pinned (it is the next base, so a linear chain builds every object exactly once whatever its size) and
// the others go to a small LRU (`cacheBytes`). A base in neither is rebuilt from its chain root on demand, each frame
// holding nothing while its base is made, and every base made on the way is put in the LRU: a fork whose siblings
// fell out of the cache walks the chain once per cache-full of siblings, not once per sibling.
//
// Memory: one base + one pinned result + one result + one delta's instructions + the LRU, at most
// max(maxObjectSize, maxDeltaResult) + 3 x maxDeltaResult + cacheBytes, whatever the pack's size, depth or shape.
//
// Work (bytes inflated from the source + bytes of delta results produced) is bounded by what the pack declares, not by
// its compressed size (delta-compressed history is legitimately hundreds of times its pack). The floor is every member
// inflated once (the scan's sizes) plus every delta applied once (its header's result size, capped by maxDeltaResult).
// A work budget allows LIMIT_RESOLVE_FACTOR x the floor reached so far (the factor is the room for rebuilds), never
// less than maxInflatedTotal and never more than the ceiling, limits.maxResolveWork as parsed
// (8 x maxInflatedTotal unless the caller sets it; parseLimits refuses it below maxInflatedTotal, #271): CPU is at most the factor times the declared sizes and at most the ceiling, which is what stops a delta bomb
// (every first-time result raises the floor). A retain budget allows maxInflatedTotal, flat.
//
// Verified: each member's zlib checksum, length and declared size; every delta against its base's size; every oid
// computed from the bytes (never taken from the pack); a base read back a second time rehashed against the oid it had
// the first time (a spool that changed under us is pack_corrupt, not a wrong oid); a thin base hashed against the oid
// that named it. Refused: a base in neither the pack nor `bases` (pack_corrupt, "not found"; a REF cycle cannot
// resolve, so it ends there too), a chain deeper than maxDeltaChain, and work past the budget (limit_exceeded).
//
// Kept per entry in the result: RESOLVED_ENTRY_BYTES (oid 20 + type 1 + base 4 + depth 4 + size 8 + the oid-ordered
// index 4).
// Held per entry only while resolving: child links (4 per entry + 4 per OFS delta), each REF delta's base id and
// position (24), and a known flag (1).
import type { PlyError } from './errors.js';
import { fail, plyError } from './errors.js';
import type { Option, Result } from './result.js';
import { ok, err, some, none, assertNever } from './result.js';
import { withDefaults, fromNullish, mapGet } from './absent.js';
import type { CheckedLimits, LimitsInput } from './limits.js';
import { DEFAULT_LIMITS, LIMIT_WORK_RATIO, LIMIT_RESOLVE_FACTOR, checkLimit, limitExceeded, parseLimits } from './limits.js';
import type { Oid } from './sha1.js';
import { fromHex, toOid } from './sha1.js';
import type { ScannedPack, ScannedType, ScanIndexOpts } from './packscanindex.js';
import type { RangeSource } from './rangesource.js';
import { inflateInit, inflateFeed, inflatePull, inflateEnd, declaredBound, zlibWrap } from './inflatestream.js';
import { applyDelta } from './packresolve.js';
import { TYPE, TYPE_NAME, hashObject } from './objects.js';

type ScanBudget = ScanIndexOpts['budget'];
// packstream.ts WORK_BUDGET (the scan's default). Here its tag selects the bound from declared sizes (top of this file);
// its ratio is the scan's and is only checked.
const WORK_BUDGET: ScanBudget = Object.freeze({ tag: 'work', ratio: LIMIT_WORK_RATIO, capObjects: false });
const OID_BYTES = 20;
const { COMMIT: OBJ_COMMIT, TREE: OBJ_TREE, BLOB: OBJ_BLOB, TAG: OBJ_TAG, OFS_DELTA: OBJ_OFS_DELTA, REF_DELTA: OBJ_REF_DELTA } = TYPE;

// In-range indexed reads of columns this module sized; noUncheckedIndexedAccess cannot see that.
/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- in-range indexed reads, see above */

export type ThinBase = { readonly type: number; readonly data: Uint8Array };
// A thin pack's base, from the caller: the object stored under the oid asked for, or null when it has none.
export type ThinBaseLookup = (oid: Oid) => Promise<ThinBase | null> | ThinBase | null;
export type ResolveRangeOpts = {
  readonly limits: LimitsInput;
  readonly budget: ScanBudget;
  // bytes of resolved bases kept for the deltas resting on them; a base not kept is rebuilt from its chain when needed
  readonly cacheBytes: number;
  readonly bases: ThinBaseLookup | null;
};
export const RESOLVE_CACHE_BYTES: number = 16 * 1024 * 1024;
const defaultOpts = (): ResolveRangeOpts => ({ limits: DEFAULT_LIMITS, budget: WORK_BUDGET, cacheBytes: RESOLVE_CACHE_BYTES, bases: null });

// oid 20 + type 1 + base 4 + depth 4 + size 8 + byOid 4
export const RESOLVED_ENTRY_BYTES = 41;
// `base`: the entry a delta was applied to; NO_BASE for a whole object; THIN_BASE for a base from `bases`.
export const NO_BASE = -1;
export const THIN_BASE = -2;
export type ResolvedColumns = {
  readonly oid: Uint8Array;
  readonly type: Uint8Array;
  readonly base: Int32Array;
  readonly depth: Int32Array;
  // the resolved object's size in bytes (a delta's result, not its instructions)
  readonly size: Float64Array;
};
export type ResolveStats = {
  // bytes inflated from the source, delta results produced, range reads made, bytes read back
  readonly inflated: number;
  readonly applied: number;
  readonly reads: number;
  readonly readBytes: number;
  readonly cacheHits: number;
  // bases made again (read back or rebuilt over their chain) because the cache did not hold them
  readonly rebuilt: number;
  readonly thinBases: number;
  // the work charged against the budget, and the budget
  readonly work: number;
  readonly workMax: number;
};
export type ResolvedIndex = {
  readonly count: number;
  readonly columns: ResolvedColumns;
  readonly heldBytes: number;
  readonly stats: ResolveStats;
  readonly oid: (index: number) => Option<Oid>;
  readonly type: (index: number) => Option<ScannedType>;
  // the entry holding `oid` (the first, if the pack holds it twice), or none
  readonly find: (oid: Oid) => Option<number>;
};

const isWhole = (t: number): t is ScannedType => t === OBJ_COMMIT || t === OBJ_TREE || t === OBJ_BLOB || t === OBJ_TAG;
function oidCompare(a: Uint8Array, ai: number, b: Uint8Array, bi: number): number {
  for (let k = 0; k < OID_BYTES; k++) {
    const d = (a[ai + k] as number) - (b[bi + k] as number);
    if (d !== 0) return d;
  }
  return 0;
}

// Small LRU of resolved bases by entry index, held to `cap` bytes. A base larger than the cap is not kept.
type Cache = { readonly map: Map<number, Uint8Array>; bytes: number; readonly cap: number };
function cacheGet(c: Cache, i: number): Uint8Array | null {
  const v = mapGet(c.map, i);
  if (v.tag === 'none') return null;
  c.map.delete(i);
  c.map.set(i, v.value);
  return v.value;
}
function cachePut(c: Cache, i: number, v: Uint8Array): void {
  if (v.length > c.cap || c.map.has(i)) return;
  c.map.set(i, v);
  c.bytes += v.length;
  for (const [k, old] of c.map) {
    if (c.bytes <= c.cap) break;
    c.map.delete(k);
    c.bytes -= old.length;
  }
}

type Stats = { inflated: number; applied: number; reads: number; readBytes: number; cacheHits: number; rebuilt: number; thinBases: number };
type State = {
  readonly pack: ScannedPack;
  readonly source: RangeSource;
  readonly bases: ThinBaseLookup | null;
  readonly n: number;
  readonly maxObject: number;
  readonly maxDelta: number;
  readonly maxChain: number;
  // the work bound: min(ceiling, max(flat, factor x floor)); floor grows by each delta result made for the first time
  readonly flat: number;
  readonly factor: number;
  readonly ceiling: number;
  floor: number;
  work: number;
  // the result the next entry popped rests on, held outside the cache (always the top of the stack, or null)
  pin: { readonly index: number; readonly data: Uint8Array } | null;
  readonly oid: Uint8Array;
  readonly known: Uint8Array;
  readonly type: Uint8Array;
  readonly base: Int32Array;
  readonly depth: Int32Array;
  readonly size: Float64Array;
  // OFS children of entry i: ofsKids[ofsStart[i] .. ofsStart[i + 1])
  readonly ofsStart: Int32Array;
  readonly ofsKids: Int32Array;
  // REF deltas in order of their base id: refEntry[k]'s base id is refOid[k * 20 ..]
  readonly refEntry: Int32Array;
  readonly refOid: Uint8Array;
  // a delta resting on a thin base: thinOf[i] is that base's index in thinOids
  readonly thinOf: Int32Array;
  thinOids: Uint8Array;
  thinCount: number;
  readonly cache: Cache;
  readonly stats: Stats;
};

const workMaxOf = (s: State): number => Math.min(s.ceiling, Math.max(s.flat, s.factor * s.floor));
function charge(s: State, bytes: number): PlyError | null {
  s.work += bytes;
  const max = workMaxOf(s);
  return s.work > max ? limitExceeded('resolve work bytes', s.work, max) : null;
}
// A source (or a thin-base lookup) that throws, rejects or errors its stream failed the read: a coded error, never a
// rejection of resolvePackRange.
const readFailed = (what: string, e: unknown): PlyError => plyError('network', `pack: ${what} failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });

// The zlib member of entry i, inflated to its declared size, read back through the source.
async function readMember(s: State, i: number): Promise<Result<Uint8Array, PlyError>> {
  const cols = s.pack.columns;
  const at = (cols.offset[i] as number) + (cols.headerBytes[i] as number);
  const length = cols.compressed[i] as number;
  const size = cols.size[i] as number;
  const charged = charge(s, size);
  if (charged !== null) return err(charged);
  const opened = inflateInit({ bound: declaredBound(size, isWhole(cols.storedType[i] as number) ? s.maxObject : s.maxDelta), wrap: zlibWrap(true) });
  if (!opened.ok) return opened;
  const st = opened.value;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    const got = await s.source.read(at, length);
    if (!got.ok) return got;
    reader = got.value.getReader();
  } catch (e) {
    return err(readFailed(`range read of entry ${i}`, e));
  }
  s.stats.reads += 1;
  const out = new Uint8Array(size);
  let o = 0;
  let fed = 0;
  let ended = false;
  try {
    for (;;) {
      const piece = ended ? inflateEnd(st) : inflatePull(st);
      if (!piece.ok) return piece;
      const p = piece.value;
      if (p.kind === 'chunk') {
        out.set(p.bytes, o);
        o += p.bytes.length;
        continue;
      }
      if (p.kind === 'end') {
        if (p.consumed !== length || fed !== length) return fail('pack_corrupt', `pack: entry ${i} zlib member is ${p.consumed} of ${fed} bytes read, the index says ${length}`);
        s.stats.inflated += o;
        return ok(out);
      }
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one member, read in order
        r = await reader.read();
      } catch (e) {
        return err(readFailed(`range read of entry ${i}`, e));
      }
      if (r.done) {
        ended = true;
        continue;
      }
      fed += r.value.length;
      s.stats.readBytes += r.value.length;
      if (fed > length) return fail('pack_corrupt', `pack: range source gave more than ${length} bytes for entry ${i}`);
      inflateFeed(st, r.value);
    }
  } finally {
    await reader.cancel().catch(() => null);
  }
}

// type + bytes -> its oid, written at into[at ..]
function hashTo(type: ScannedType, data: Uint8Array, into: Uint8Array, at: number): void {
  into.set(fromHex(hashObject(TYPE_NAME[type], data)), at);
}
const oidAt = (bytes: Uint8Array, i: number): Oid => toOid(bytes.subarray(i * OID_BYTES, (i + 1) * OID_BYTES));
// A base made again must hash to the oid it had: anything else is the spool, not the pack.
function checkAgain(s: State, i: number, data: Uint8Array): PlyError | null {
  const scratch = new Uint8Array(OID_BYTES);
  hashTo(s.type[i] as ScannedType, data, scratch, 0);
  return oidCompare(scratch, 0, s.oid, i * OID_BYTES) === 0 ? null : plyError('pack_corrupt', `pack: entry ${i} read back as ${toOid(scratch)}, was ${oidAt(s.oid, i)}`);
}

type Thin = { readonly tag: 'absent' } | { readonly tag: 'found'; readonly type: ScannedType; readonly data: Uint8Array };
// The caller's object for `want`: absent, or checked (a stored type, and its bytes hash to `want`).
async function thinData(s: State, want: Oid): Promise<Result<Thin, PlyError>> {
  let found: ThinBase | null;
  try {
    found = s.bases === null ? null : await s.bases(want);
  } catch (e) {
    return err(readFailed(`thin base lookup of ${want}`, e));
  }
  const asked = fromNullish(found);
  if (asked.tag === 'none') return ok({ tag: 'absent' });
  const got = asked.value;
  if (!isWhole(got.type)) return fail('pack_corrupt', `pack: ref delta base ${want} has type ${got.type}`);
  const hashed = hashObject(TYPE_NAME[got.type], got.data);
  if (hashed !== want) return fail('pack_corrupt', `pack: ref delta base ${want} hashes to ${hashed}`);
  return ok({ tag: 'found', type: got.type, data: got.data });
}

// Entry i's delta, read back and applied to `base`, the result charged as work. `first`: the entry is being resolved
// (not made again), so its result joins the floor the budget is measured against.
async function applyEntry(s: State, i: number, base: Uint8Array, first: boolean): Promise<Result<Uint8Array, PlyError>> {
  const delta = await readMember(s, i);
  if (!delta.ok) return delta;
  const applied = applyDelta(base, delta.value, { maxResult: s.maxDelta });
  if (!applied.ok) return applied;
  const out = applied.value.out;
  if (first) s.floor += out.length;
  const charged = charge(s, out.length);
  if (charged !== null) return err(charged);
  s.stats.applied += out.length;
  return ok(out);
}
// Entry i's resolved bytes: from the cache, read whole, or rebuilt over its base (which may itself be rebuilt). Each
// frame holds nothing while its base is made, so the peak is one base and one result whatever the depth.
async function materialize(s: State, i: number): Promise<Result<Uint8Array, PlyError>> {
  const hit = cacheGet(s.cache, i);
  if (hit !== null) {
    s.stats.cacheHits += 1;
    return ok(hit);
  }
  s.stats.rebuilt += 1;
  let made: Result<Uint8Array, PlyError>;
  const b = s.base[i] as number;
  if (isWhole(s.pack.columns.storedType[i] as number)) made = await readMember(s, i);
  else if (b === THIN_BASE) {
    const want = oidAt(s.thinOids, s.thinOf[i] as number);
    const thin = await thinData(s, want);
    if (!thin.ok) return thin;
    if (thin.value.tag === 'absent') return fail('pack_corrupt', `pack: ref delta base ${want} not found when asked again`);
    made = await applyEntry(s, i, thin.value.data, false);
  } else {
    const base = await materialize(s, b);
    if (!base.ok) return base;
    // A base made again is kept (the LRU decides for how long): the siblings waiting behind this entry rest on the
    // bases just below it, so each of them then costs one delta, not the chain from its root again.
    cachePut(s.cache, b, base.value);
    made = await applyEntry(s, i, base.value, false);
  }
  if (!made.ok) return made;
  const bad = checkAgain(s, i, made.value);
  return bad === null ? made : err(bad);
}

// REF deltas whose base id is ids[at .. at + 20]: [lo, hi) in refEntry.
function refRange(s: State, ids: Uint8Array, at: number): readonly [number, number] {
  const m = s.refEntry.length;
  let lo = 0;
  let hi = m;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (oidCompare(s.refOid, mid * OID_BYTES, ids, at) < 0) lo = mid + 1;
    else hi = mid;
  }
  let end = lo;
  while (end < m && oidCompare(s.refOid, end * OID_BYTES, ids, at) === 0) end += 1;
  return [lo, end];
}
function hasKids(s: State, i: number): boolean {
  if ((s.ofsStart[i + 1] as number) > (s.ofsStart[i] as number)) return true;
  const [lo, hi] = refRange(s, s.oid, i * OID_BYTES);
  return hi > lo;
}

// A base whose deltas are being applied: its entry (THIN_BASE for a thin base), type, depth, bytes, and its id at
// ids[idAt ..].
type Parent = { readonly index: number; readonly type: ScannedType; readonly depth: number; readonly data: Uint8Array; readonly ids: Uint8Array; readonly idAt: number };
// Every not-yet-resolved delta resting on `p`, applied to its bytes: each gets its oid, type, depth and base; one that
// something rests on is pushed and kept: the last such is pinned (it is popped next), the earlier ones go to the cache.
async function resolveKids(s: State, p: Parent, stack: number[]): Promise<PlyError | null> {
  const kids: number[] = [];
  if (p.index >= 0) for (let k = s.ofsStart[p.index] as number; k < (s.ofsStart[p.index + 1] as number); k++) kids.push(s.ofsKids[k] as number);
  const [lo, hi] = refRange(s, p.ids, p.idAt);
  for (let k = lo; k < hi; k++) kids.push(s.refEntry[k] as number);
  const depth = p.depth + 1;
  for (const c of kids) {
    if (s.known[c] === 1) continue;
    if (depth > s.maxChain) return limitExceeded('delta chain depth', depth, s.maxChain);
    // oxlint-disable-next-line no-await-in-loop -- each child is applied in turn against the one base held
    const out = await applyEntry(s, c, p.data, true);
    if (!out.ok) return out.error;
    hashTo(p.type, out.value, s.oid, c * OID_BYTES);
    s.known[c] = 1;
    s.type[c] = p.type;
    s.depth[c] = depth;
    s.size[c] = out.value.length;
    s.base[c] = p.index;
    if (hasKids(s, c)) {
      if (s.pin !== null) cachePut(s.cache, s.pin.index, s.pin.data);
      s.pin = { index: c, data: out.value };
      stack.push(c);
    }
  }
  return null;
}
// Depth first: each entry popped is made (the pinned result, else a cache hit, else rebuilt) and the deltas resting on
// it applied.
async function drain(s: State, stack: number[]): Promise<PlyError | null> {
  while (stack.length > 0) {
    const u = stack.pop() as number;
    const pinned = s.pin;
    s.pin = null;
    // oxlint-disable-next-line no-await-in-loop -- one chain at a time, in order
    const data = pinned !== null && pinned.index === u ? ok(pinned.data) : await materialize(s, u);
    if (!data.ok) return data.error;
    const p: Parent = { index: u, type: s.type[u] as ScannedType, depth: s.depth[u] as number, data: data.value, ids: s.oid, idAt: u * OID_BYTES };
    // oxlint-disable-next-line no-await-in-loop -- as above
    const bad = await resolveKids(s, p, stack);
    if (bad !== null) return bad;
  }
  return null;
}

// OFS children by base index (counting sort), REF deltas sorted by base id, whole oids the scan computed.
function setup(pack: ScannedPack, source: RangeSource, opts: ResolveRangeOpts, caps: { readonly maxObject: number; readonly maxDelta: number; readonly maxChain: number; readonly flat: number; readonly factor: number; readonly ceiling: number }): State {
  const cols = pack.columns;
  const n = cols.offset.length;
  const ofsStart = new Int32Array(n + 1);
  let refs = 0;
  for (let i = 0; i < n; i++) {
    const t = cols.storedType[i] as number;
    if (t === OBJ_OFS_DELTA) {
      const at = (cols.baseIndex[i] as number) + 1;
      ofsStart[at] = (ofsStart[at] as number) + 1;
    } else if (t === OBJ_REF_DELTA) refs += 1;
  }
  for (let i = 0; i < n; i++) ofsStart[i + 1] = (ofsStart[i + 1] as number) + (ofsStart[i] as number);
  const ofsKids = new Int32Array(ofsStart[n] as number);
  const fill = ofsStart.slice(0, n);
  const refAt = new Int32Array(refs);
  const refRaw = new Uint8Array(refs * OID_BYTES);
  const oid = new Uint8Array(n * OID_BYTES);
  const known = new Uint8Array(n);
  let r = 0;
  for (let i = 0; i < n; i++) {
    const t = cols.storedType[i] as number;
    if (t === OBJ_OFS_DELTA) {
      const b = cols.baseIndex[i] as number;
      ofsKids[fill[b] as number] = i;
      fill[b] = (fill[b] as number) + 1;
      continue;
    }
    const e = pack.entry(i);
    if (e.tag === 'none') continue;
    if (t === OBJ_REF_DELTA && e.value.base.tag === 'ref') {
      refRaw.set(fromHex(e.value.base.oid), r * OID_BYTES);
      refAt[r] = i;
      r += 1;
    } else if (e.value.oid !== null) {
      oid.set(fromHex(e.value.oid), i * OID_BYTES);
      known[i] = 1;
    }
  }
  // REF deltas by base id, pack order among equal ids
  const order = Int32Array.from({ length: refs }, (_, k) => k).toSorted((x, y) => oidCompare(refRaw, x * OID_BYTES, refRaw, y * OID_BYTES) || x - y);
  const refOid = new Uint8Array(refs * OID_BYTES);
  const refEntry = new Int32Array(refs);
  for (let k = 0; k < refs; k++) {
    const from = order[k] as number;
    refOid.set(refRaw.subarray(from * OID_BYTES, (from + 1) * OID_BYTES), k * OID_BYTES);
    refEntry[k] = refAt[from] as number;
  }
  return {
    pack, source, bases: opts.bases, n, ...caps, floor: cols.size.reduce((a, b) => a + b, 0), work: 0, pin: null, oid, known,
    type: new Uint8Array(n), base: new Int32Array(n).fill(NO_BASE), depth: new Int32Array(n), size: Float64Array.from(pack.columns.size), ofsStart, ofsKids,
    refEntry, refOid, thinOf: new Int32Array(n).fill(-1), thinOids: new Uint8Array(0), thinCount: 0,
    cache: { map: new Map(), bytes: 0, cap: opts.cacheBytes },
    stats: { inflated: 0, applied: 0, reads: 0, readBytes: 0, cacheHits: 0, rebuilt: 0, thinBases: 0 },
  };
}

// One whole object as a root: its oid (hashed now if the scan had oids off), then everything resting on it.
async function fromRoot(s: State, i: number, t: ScannedType): Promise<PlyError | null> {
  s.type[i] = t;
  const hashedBefore = s.known[i] === 1;
  if (hashedBefore && !hasKids(s, i)) return null;
  const data = hashedBefore ? await materialize(s, i) : await readMember(s, i);
  if (!data.ok) return data.error;
  if (!hashedBefore) {
    hashTo(t, data.value, s.oid, i * OID_BYTES);
    s.known[i] = 1;
    if (!hasKids(s, i)) return null;
  }
  cachePut(s.cache, i, data.value);
  const stack: number[] = [];
  const kids = await resolveKids(s, { index: i, type: t, depth: 0, data: data.value, ids: s.oid, idAt: i * OID_BYTES }, stack);
  return kids === null ? drain(s, stack) : kids;
}
async function fromRoots(s: State): Promise<PlyError | null> {
  const stored = s.pack.columns.storedType;
  for (let i = 0; i < s.n; i++) {
    const t = stored[i] as number;
    if (!isWhole(t)) continue;
    // oxlint-disable-next-line no-await-in-loop -- one root at a time
    const bad = await fromRoot(s, i, t);
    if (bad !== null) return bad;
  }
  return null;
}

type ThinStep = { readonly tag: 'absent' } | { readonly tag: 'resolved' } | { readonly tag: 'failed'; readonly error: PlyError };
// The id at refOid[k] asked of `bases`: absent, or a root whose deltas (and theirs) are resolved now.
async function thinRoot(s: State, k: number): Promise<ThinStep> {
  const id = s.refOid.subarray(k * OID_BYTES, (k + 1) * OID_BYTES);
  const thin = await thinData(s, toOid(id));
  if (!thin.ok) return { tag: 'failed', error: thin.error };
  if (thin.value.tag === 'absent') return { tag: 'absent' };
  const t = s.thinCount;
  const grown = new Uint8Array((t + 1) * OID_BYTES);
  grown.set(s.thinOids);
  grown.set(id, t * OID_BYTES);
  s.thinOids = grown;
  s.thinCount += 1;
  s.stats.thinBases += 1;
  const [lo, hi] = refRange(s, s.refOid, k * OID_BYTES);
  for (let j = lo; j < hi; j++) s.thinOf[s.refEntry[j] as number] = t;
  const stack: number[] = [];
  const kids = await resolveKids(s, { index: THIN_BASE, type: thin.value.type, depth: 0, data: thin.value.data, ids: s.refOid, idAt: k * OID_BYTES }, stack);
  const bad = kids === null ? await drain(s, stack) : kids;
  return bad === null ? { tag: 'resolved' } : { tag: 'failed', error: bad };
}
// After the pack's own roots: a REF delta still unresolved names a base outside the pack, or an in-pack delta waiting
// on one. Each such id is asked of `bases` once; one it has becomes a root. Rounds repeat while one makes progress (an
// id asked too early may name an in-pack delta resolved later). Then the first entry left is the refusal.
async function fromThin(s: State): Promise<PlyError | null> {
  const asked = new Set<string>();
  for (let progress = s.bases !== null; progress;) {
    progress = false;
    for (let k = 0; k < s.refEntry.length; k++) {
      if (s.known[s.refEntry[k] as number] === 1) continue;
      const hex = oidAt(s.refOid, k);
      if (asked.has(hex)) continue;
      asked.add(hex);
      // oxlint-disable-next-line no-await-in-loop -- one thin base at a time
      const step = await thinRoot(s, k);
      switch (step.tag) {
        case 'failed': return step.error;
        case 'resolved': progress = true; continue;
        case 'absent': continue;
      }
      // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: unreachable, the compiler's exhaustiveness check
      return assertNever(step);
    }
  }
  for (let i = 0; i < s.n; i++) {
    if (s.known[i] === 1) continue;
    const e = s.pack.entry(i);
    const named = e.tag === 'some' && e.value.base.tag === 'ref' ? e.value.base.oid : `at entry ${s.pack.columns.baseIndex[i] as number}`;
    const hint = s.bases === null ? ' (a thin pack needs bases)' : '';
    return plyError('pack_corrupt', `pack: delta at entry ${i} unresolved: ref delta base ${named} not found${hint}`);
  }
  return null;
}

// An index over resolved `columns` (each sized to the entries) with the stats of the run that produced them.
// resolvePackRange builds one after resolving; decodeSavedIndex (packsaved.ts, #260) builds one from saved columns.
export function resolvedIndexOf(columns: ResolvedColumns, stats: ResolveStats): ResolvedIndex {
  const n = columns.type.length;
  const ids = columns.oid;
  const byOid = Int32Array.from({ length: n }, (_, i) => i).toSorted((x, y) => oidCompare(ids, x * OID_BYTES, ids, y * OID_BYTES) || x - y);
  const inRange = (i: number): boolean => Number.isInteger(i) && i >= 0 && i < n;
  const find = (want: Oid): Option<number> => {
    if (!/^[0-9a-f]{40}$/u.test(want)) return none;
    const id = fromHex(want);
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (oidCompare(ids, (byOid[mid] as number) * OID_BYTES, id, 0) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo < n && oidCompare(ids, (byOid[lo] as number) * OID_BYTES, id, 0) === 0 ? some(byOid[lo] as number) : none;
  };
  return {
    count: n,
    columns,
    heldBytes: n * RESOLVED_ENTRY_BYTES,
    stats,
    oid: i => (inRange(i) ? some(oidAt(ids, i)) : none),
    type: i => (inRange(i) ? some(columns.type[i] as ScannedType) : none),
    find,
  };
}
function finish(s: State): ResolvedIndex {
  return resolvedIndexOf({ oid: s.oid, type: s.type, base: s.base, depth: s.depth, size: s.size }, { ...s.stats, work: s.work, workMax: workMaxOf(s) });
}

// The options a resolve runs under: each key read from the caller's record as input[key] (withDefaults), so an inherited
// property or an accessor counts as an own one does, and the limits parsed. loadTransferPack (transferload.ts) holds a
// saved index to this record's limits.maxDeltaChain and hands the record on to resolvePackRange, which reads it again.
type CheckedOpts = Omit<ResolveRangeOpts, 'limits'> & { readonly limits: CheckedLimits };
export function resolveOptsOf(input: Partial<ResolveRangeOpts>): Result<CheckedOpts, PlyError> {
  const opts = withDefaults(input, defaultOpts());
  const limits = parseLimits(opts.limits);
  return limits.ok ? ok({ ...opts, limits: limits.value }) : limits;
}

// Resolve every entry of `pack` (scanPackIndex's index of the bytes `source` serves). See the top of this file.
export async function resolvePackRange(pack: ScannedPack, source: RangeSource, input: Partial<ResolveRangeOpts> = {}): Promise<Result<ResolvedIndex, PlyError>> {
  const parsed = resolveOptsOf(input);
  if (!parsed.ok) return parsed;
  const opts = parsed.value;
  if (source.size !== pack.bytes) return fail('bad_request', `range source is ${source.size} bytes, the index read ${pack.bytes}`);
  if (!Number.isFinite(opts.cacheBytes) || opts.cacheBytes < 0) return fail('bad_request', `cacheBytes must be a non-negative number, got ${opts.cacheBytes}`);
  const budget = opts.budget;
  const work = budget.tag === 'work';
  if (work) {
    const ratio = checkLimit(budget.ratio, 'workRatio');
    if (!ratio.ok) return ratio;
  }
  const l = opts.limits;
  const flat = l.maxInflatedTotal;
  // the ceiling is the parsed maxResolveWork (parseLimits: never below maxInflatedTotal)
  const bound = work ? { flat, factor: LIMIT_RESOLVE_FACTOR, ceiling: l.maxResolveWork } : { flat, factor: 0, ceiling: flat };
  const s = setup(pack, source, opts, { maxObject: l.maxObjectSize, maxDelta: l.maxDeltaResult, maxChain: l.maxDeltaChain, ...bound });
  const roots = await fromRoots(s);
  if (roots !== null) return err(roots);
  const thin = await fromThin(s);
  return thin === null ? ok(finish(s)) : err(thin);
}
