// Plan how to push a pack's objects as several pushes, each under a caller's budget (#237). The input is a spooled pack's
// layout (scanPackIndex, #236) and every entry's oid, type and base (resolvePackRange, #248); the output is plain data:
// which entries go in which push, in what order, and a hash that names the plan. Nothing here reads or writes bytes;
// packSubset (#235) builds each batch's pack and pushPack (#234) sends it.
//
// Children first. A strict server (receive.fsckObjects) refuses a pushed tree whose blob it does not have, even when no
// ref reaches it (measured 2026-11-09 against stock git; Artifacts refuses it once a ref does). So every blob is pushed
// in a batch before the trees, and the trees, commits and tags go last, in one batch: v1 refuses a plan whose trees do
// not fit in one batch (limit_exceeded) rather than ordering trees by depth.
//
// Delta families stay together: a whole object and every delta resting on it, directly or through other deltas, go in
// one batch, so every base a batch needs is in it. A family too big for one batch is refused unless `crossBatchRef`:
// then it is split in chain order, and a delta whose base landed in an earlier batch is written as REF_DELTA to the
// base's oid (an OFS_DELTA is rewritten; a REF_DELTA, which is all a Cloudflare Artifacts pack holds, already is). How
// an entry is written given where its base is, is packSubset's own rule (`entryWrite`, `baseId`), called here: a batch
// this plans is one packSubset builds when it is given the same `resolved` (a base that is itself a delta has an id
// only there). An entry that rule cannot write fails the plan (bad_request), before anything is pushed. A cut is a
// thin pack resting on objects the server already has; git's receive-pack runs index-pack --fix-thin and accepts
// it, but whether a host does is the host's to say, so it is opt-in. A selected delta whose base is not selected, or a
// thin pack's delta whose base is outside the pack, likewise needs `crossBatchRef` (the destination must hold the base).
//
// Budget: every dimension is the caller's (no host numbers here). Per push: request bytes (pack + `reserveBytes` for
// the command prefix, capabilities and any generated objects) and objects (entries + `reserveObjects`). Per object: the
// resolved (inflated) size and the compressed (zlib member) size, each checked for every entry before any batch is
// planned. Sizes are counted as written, with room for header growth: an OFS_DELTA's distance is counted at the length
// the largest possible distance in a push needs, and a REF rewrite at 20 bytes of oid.
//
// Deterministic: the same index, resolution and options give the same plan. `hash` (SHA-1 of the canonical JSON of the
// plan version, the source pack's trailer, the budget, the options and the batches) names it, so a resumed transfer can
// tell its plan from another.
import type { PlyError } from './errors.js';
import { fail } from './errors.js';
import type { Result } from './result.js';
import { ok, err } from './result.js';
import { limitExceeded } from './limits.js';
import type { ScannedPack } from './packscanindex.js';
import type { ResolvedIndex } from './packrangeresolve.js';
import { NO_BASE, THIN_BASE } from './packrangeresolve.js';
import type { Threw, Nothing } from './packsubset.js';
import { entryWrite, baseId, ofsDistanceBytes, WRITE_OFS, WRITE_REFUSED } from './packsubset.js';
import { Sha1 } from './sha1.js';
import { te } from './bytes.js';
import { withDefaults, mapGet, at } from './absent.js';
import type { Input } from './absent.js';
import { OID_BYTES, PACK_HEADER_BYTES, PACK_TRAILER_BYTES, OBJ_COMMIT, OBJ_TREE, OBJ_BLOB, OBJ_TAG, OBJ_OFS_DELTA } from './format.js';

// In-range indexed reads of columns sized by the index; noUncheckedIndexedAccess cannot see that.
/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- in-range indexed reads, see above */

export const PLAN_VERSION = 1;
export type PushBudget = {
  // one push's receive-pack request body: the pack plus reserveBytes
  readonly maxRequestBytes: number;
  // objects in one push, reserveObjects included
  readonly maxObjects: number;
  // one object's resolved (inflated) size
  readonly maxObjectBytes: number;
  // one entry's compressed bytes as stored (its zlib member)
  readonly maxCompressedObjectBytes: number;
  // per push, outside the planned entries: the command prefix, capabilities, generated objects (a temp commit and tree)
  readonly reserveBytes: number;
  readonly reserveObjects: number;
};
export type PlanOpts = {
  readonly budget: PushBudget;
  // the entries to plan, by index (default: every entry)
  readonly select: readonly number[] | null;
  // allow a delta whose base is pushed in an earlier batch (or already on the destination) as REF_DELTA
  readonly crossBatchRef: boolean;
};
// 'blobs': only blobs (and their deltas); 'final': the trees, commits and tags (with any blobs that fit), always last.
export type BatchKind = 'blobs' | 'final';
export type PlannedBatch = {
  readonly kind: BatchKind;
  // entry indices in the order to write them: every base before the delta resting on it
  readonly entries: readonly number[];
  // the pack this batch writes, counted with header growth (an upper bound): header, entries, trailer
  readonly packBytes: number;
  // entries in the batch (reserveObjects not included)
  readonly objects: number;
  // entries written as REF_DELTA because their base is not in this batch
  readonly refRewrites: number;
};
export type PackPlan = {
  readonly version: typeof PLAN_VERSION;
  readonly trailer: string;
  readonly budget: PushBudget;
  readonly crossBatchRef: boolean;
  readonly select: readonly number[] | null;
  readonly batches: readonly PlannedBatch[];
  readonly entries: number;
  // SHA-1 hex of the canonical JSON of everything above
  readonly hash: string;
};

const BLOB = OBJ_BLOB;
const COMMIT = OBJ_COMMIT;
const OFS_DELTA = OBJ_OFS_DELTA;
const TAG = OBJ_TAG;
const TREE = OBJ_TREE;
const ofsLen = ofsDistanceBytes;

function checkBudget(b: PushBudget): PlyError | null {
  const fields: ReadonlyArray<readonly [string, number]> = [
    ['maxRequestBytes', b.maxRequestBytes], ['maxObjects', b.maxObjects], ['maxObjectBytes', b.maxObjectBytes],
    ['maxCompressedObjectBytes', b.maxCompressedObjectBytes], ['reserveBytes', b.reserveBytes], ['reserveObjects', b.reserveObjects],
  ];
  for (const [name, v] of fields) {
    if (!Number.isSafeInteger(v) || v < 0) return fail('bad_request', `budget ${name} must be a non-negative integer, got ${String(v)}`).error;
  }
  if (b.reserveObjects >= b.maxObjects) return fail('bad_request', `budget reserveObjects ${b.reserveObjects} leaves no room under maxObjects ${b.maxObjects}`).error;
  if (b.reserveBytes + PACK_HEADER_BYTES + PACK_TRAILER_BYTES >= b.maxRequestBytes) return fail('bad_request', `budget reserveBytes ${b.reserveBytes} leaves no room for a pack under maxRequestBytes ${b.maxRequestBytes}`).error;
  return null;
}

// The entries to plan: every entry, or the caller's selection (each an entry index, once).
function selection(n: number, select: readonly number[] | null): Result<Uint8Array, PlyError> {
  const chosen = new Uint8Array(n);
  if (select === null) return ok(chosen.fill(1));
  for (const i of select) {
    if (!Number.isInteger(i) || i < 0 || i >= n) return fail('bad_request', `select: ${String(i)} is not an entry of this pack (0..${n - 1})`);
    if (chosen[i] === 1) return fail('bad_request', `select: entry ${i} named twice`);
    chosen[i] = 1;
  }
  return ok(chosen);
}

type Ctx = {
  readonly pack: ScannedPack;
  readonly resolved: ResolvedIndex;
  readonly budget: PushBudget;
  readonly cross: boolean;
  readonly chosen: Uint8Array;
  // the batch each planned entry is in, -1 before it is placed
  readonly batchOf: Int32Array;
  // bytes of an OFS distance counted for a delta written as OFS: the length the largest distance in a push needs
  readonly ofsMax: number;
  // entries the builder's rule cannot write where the plan put them (none, unless `resolved` lacks a base's id)
  readonly unbuildable: number[];
  // what the caller's `resolved.oid()` threw, the first time it did, or that it returned nothing (at most one): the
  // plan's refusal, with what was thrown as its cause
  readonly threw: Array<Threw | Nothing>;
};

// The entry's base inside the selection, or -1 (a whole object, a thin base, or a base not selected).
function inBase(c: Ctx, i: number): number {
  const b = c.resolved.columns.base[i] as number;
  return b >= 0 && c.chosen[b] === 1 ? b : -1;
}
// Bytes the entry takes in a batch whose number is `batch`: its header as it will be written, then its compressed bytes.
// Only an OFS_DELTA written outside its base's batch carries `refused` (the builder's rule cannot write it there): a
// whole object, a REF_DELTA and an OFS_DELTA beside its base return the two fields alone, so their path costs nothing more.
type Wire = { readonly bytes: number; readonly rewrite: boolean };
type CutWire = Wire & { readonly refused: boolean };
function wireBytes(c: Ctx, i: number, batch: number): Wire | CutWire {
  const cols = c.pack.columns;
  const compressed = cols.compressed[i] as number;
  const header = cols.headerBytes[i] as number;
  const stored = cols.storedType[i] as number;
  const b = inBase(c, i);
  const isDelta = (c.resolved.columns.base[i] as number) !== NO_BASE;
  if (!isDelta) return { bytes: header + compressed, rewrite: false };
  const sameBatch = b >= 0 && (c.batchOf[b] as number) === batch;
  if (stored === OFS_DELTA) {
    const storedBase = cols.baseIndex[i] as number;
    const typeSize = header - ofsLen((cols.offset[i] as number) - (cols.offset[storedBase] as number));
    // the builder's own rule: OFS beside its base, else a REF_DELTA to the base's id, which `resolved` must know. The
    // id is asked for only when it would be written (the base is outside this batch): this runs per entry per try
    const id = sameBatch ? null : baseId(c.pack, c.resolved, storedBase);
    if (id !== null && typeof id !== 'string' && c.threw.length === 0) c.threw.push(id);
    const write = entryWrite(stored, sameBatch, sameBatch || typeof id === 'string', c.cross ? 'ref' : 'refuse');
    return write === WRITE_OFS
      ? { bytes: typeSize + c.ofsMax + compressed, rewrite: false }
      : { bytes: typeSize + OID_BYTES + compressed, rewrite: true, refused: write === WRITE_REFUSED };
  }
  // a REF_DELTA is written as it is stored, wherever its base is
  return { bytes: header + compressed, rewrite: !sameBatch };
}

// Every planned entry checked against the per-object budget and the type it resolved to.
function checkEntries(c: Ctx): PlyError | null {
  const n = c.pack.count;
  for (let i = 0; i < n; i++) {
    if (c.chosen[i] !== 1) continue;
    const t = c.resolved.columns.type[i] as number;
    if (t !== COMMIT && t !== TREE && t !== BLOB && t !== TAG) return fail('bad_request', `entry ${i} has no resolved type (resolvePackRange first)`).error;
    const size = c.resolved.columns.size[i] as number;
    if (size > c.budget.maxObjectBytes) return limitExceeded(`object bytes (entry ${i})`, size, c.budget.maxObjectBytes);
    const compressed = c.pack.columns.compressed[i] as number;
    if (compressed > c.budget.maxCompressedObjectBytes) return limitExceeded(`compressed object bytes (entry ${i})`, compressed, c.budget.maxCompressedObjectBytes);
    const base = c.resolved.columns.base[i] as number;
    const outside = base === THIN_BASE || (base >= 0 && c.chosen[base] !== 1);
    if (outside && !c.cross) return fail('bad_request', `entry ${i} is a delta whose base is not in the selection; it needs crossBatchRef (the destination must hold the base)`).error;
  }
  return null;
}

// Families: each planned entry's chain root (the whole object it rests on, or the first entry above a base outside the
// selection), and per root the entries in chain order (depth, then index), so a base comes before its deltas.
function families(c: Ctx): Map<number, number[]> {
  const n = c.pack.count;
  const rootOf = new Int32Array(n).fill(-1);
  const root = (i: number): number => {
    const path: number[] = [];
    let u = i;
    while ((rootOf[u] as number) < 0) {
      const b = inBase(c, u);
      if (b < 0) { rootOf[u] = u; break; }
      path.push(u);
      u = b;
    }
    const r = rootOf[u] as number;
    for (const p of path) rootOf[p] = r;
    return r;
  };
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (c.chosen[i] !== 1) continue;
    const r = root(i);
    const list = mapGet(byRoot, r);
    if (list.tag === 'none') byRoot.set(r, [i]);
    else list.value.push(i);
  }
  const depth = c.resolved.columns.depth;
  for (const list of byRoot.values()) list.sort((x, y) => (depth[x] as number) - (depth[y] as number) || x - y);
  return byRoot;
}

type Open = { kind: BatchKind; entries: number[]; bytes: number; refRewrites: number };
const PACK_OVERHEAD = PACK_HEADER_BYTES + PACK_TRAILER_BYTES;
const open = (kind: BatchKind): Open => ({ kind, entries: [], bytes: PACK_OVERHEAD, refRewrites: 0 });
const fitsBytes = (c: Ctx, packBytes: number): boolean => packBytes + c.budget.reserveBytes <= c.budget.maxRequestBytes;
const fitsObjects = (c: Ctx, count: number): boolean => count + c.budget.reserveObjects <= c.budget.maxObjects;

// Bytes the family would add to batch `batch` if placed whole (its bases all in it).
function familyBytes(c: Ctx, list: readonly number[], batch: number): number {
  for (const i of list) c.batchOf[i] = batch;
  let sum = 0;
  for (const i of list) sum += wireBytes(c, i, batch).bytes;
  for (const i of list) c.batchOf[i] = -1;
  return sum;
}
function place(c: Ctx, b: Open, batch: number, i: number): void {
  c.batchOf[i] = batch;
  const w = wireBytes(c, i, batch);
  b.entries.push(i);
  b.bytes += w.bytes;
  if (!w.rewrite) return;
  b.refRewrites += 1;
  if ('refused' in w && w.refused) c.unbuildable.push(i);
}
const done = (b: Open): PlannedBatch => ({ kind: b.kind, entries: b.entries, packBytes: b.bytes, objects: b.entries.length, refRewrites: b.refRewrites });

// Blob families, greedily in root order: a family whole into the open batch, else a new one; a family no empty batch
// holds is split in chain order (crossBatchRef) or refused.
function planBlobs(c: Ctx, fams: ReadonlyArray<readonly number[]>): Result<PlannedBatch[], PlyError> {
  const out: PlannedBatch[] = [];
  let cur = open('blobs');
  for (const list of fams) {
    const batch = out.length;
    const add = familyBytes(c, list, batch);
    if (fitsBytes(c, cur.bytes + add) && fitsObjects(c, cur.entries.length + list.length)) {
      for (const i of list) place(c, cur, batch, i);
      continue;
    }
    if (cur.entries.length > 0) { out.push(done(cur)); cur = open('blobs'); }
    const fresh = out.length;
    const alone = familyBytes(c, list, fresh);
    if (fitsBytes(c, PACK_OVERHEAD + alone) && fitsObjects(c, list.length)) {
      for (const i of list) place(c, cur, fresh, i);
      continue;
    }
    if (!c.cross) {
      const objects = !fitsObjects(c, list.length);
      return err(objects
        ? limitExceeded(`delta family objects (root entry ${list[0] as number}; crossBatchRef splits it)`, list.length + c.budget.reserveObjects, c.budget.maxObjects)
        : limitExceeded(`delta family bytes (root entry ${list[0] as number}; crossBatchRef splits it)`, PACK_OVERHEAD + alone + c.budget.reserveBytes, c.budget.maxRequestBytes));
    }
    for (const i of list) {
      let batch2 = out.length;
      let w = wireBytes(c, i, batch2);
      if (!(fitsBytes(c, cur.bytes + w.bytes) && fitsObjects(c, cur.entries.length + 1)) && cur.entries.length > 0) {
        out.push(done(cur));
        cur = open('blobs');
        batch2 = out.length;
        w = wireBytes(c, i, batch2);
      }
      if (!fitsBytes(c, cur.bytes + w.bytes)) return err(limitExceeded(`entry bytes (entry ${i})`, PACK_OVERHEAD + w.bytes + c.budget.reserveBytes, c.budget.maxRequestBytes));
      place(c, cur, batch2, i);
    }
  }
  if (cur.entries.length > 0) out.push(done(cur));
  return ok(out);
}

// One 'final' batch numbered `batch` holding `blobEntries` then every family, or null if it does not fit.
function tryFinal(c: Ctx, fams: ReadonlyArray<readonly number[]>, batch: number, blobEntries: readonly number[]): PlannedBatch | null {
  const b = open('final');
  for (const i of blobEntries) c.batchOf[i] = -1;
  for (const i of blobEntries) place(c, b, batch, i);
  for (const list of fams) for (const i of list) place(c, b, batch, i);
  if (fitsBytes(c, b.bytes) && fitsObjects(c, b.entries.length)) return done(b);
  for (const i of b.entries) c.batchOf[i] = -1;
  for (const i of blobEntries) c.batchOf[i] = batch;
  return null;
}

// The trees, commits and tags, in one batch after every blob batch. If the last blob batch fits beside them, it joins.
function planFinal(c: Ctx, fams: ReadonlyArray<readonly number[]>, blobs: PlannedBatch[]): Result<PlannedBatch[], PlyError> {
  if (fams.length === 0) return ok(blobs);
  const last = at(blobs, blobs.length - 1);
  const merged = last.tag === 'none' ? null : tryFinal(c, fams, blobs.length - 1, last.value.entries);
  if (merged !== null) return ok([...blobs.slice(0, -1), merged]);
  const alone = tryFinal(c, fams, blobs.length, []);
  if (alone !== null) return ok([...blobs, alone]);
  const entries = fams.flat();
  const bytes = PACK_OVERHEAD + familyBytes(c, entries, blobs.length);
  return err(fitsObjects(c, entries.length)
    ? limitExceeded('tree batch bytes (trees, commits and tags must fit one push in plan v1)', bytes + c.budget.reserveBytes, c.budget.maxRequestBytes)
    : limitExceeded('tree batch objects (trees, commits and tags must fit one push in plan v1)', entries.length + c.budget.reserveObjects, c.budget.maxObjects));
}
// The canonical form a plan's hash is taken over: fixed key order, entries as arrays of numbers.
function canonical(p: Omit<PackPlan, 'hash'>): string {
  const b = p.budget;
  return JSON.stringify([
    p.version, p.trailer,
    [b.maxRequestBytes, b.maxObjects, b.maxObjectBytes, b.maxCompressedObjectBytes, b.reserveBytes, b.reserveObjects],
    p.crossBatchRef, p.select, p.entries,
    p.batches.map(x => [x.kind, x.packBytes, x.objects, x.refRewrites, x.entries]),
  ]);
}
// The hash a plan should carry: SHA-1 hex of its canonical JSON. A plan read back from storage can be checked with it.
export function planHash(p: Omit<PackPlan, 'hash'>): string {
  return new Sha1().update(te.encode(canonical(p))).hex();
}

// Plan the pushes for `pack` (its scanPackIndex index) given `resolved` (resolvePackRange over the same pack).
export function planPackBatches(pack: ScannedPack, resolved: ResolvedIndex, input: Input<PlanOpts> & { readonly budget: PushBudget }): Result<PackPlan, PlyError> {
  const opts = withDefaults<PlanOpts>(input, { budget: input.budget, select: null, crossBatchRef: false });
  if (resolved.count !== pack.count) return fail('bad_request', `resolved index has ${resolved.count} entries, the pack ${pack.count}`);
  const budgetBad = checkBudget(opts.budget);
  if (budgetBad !== null) return err(budgetBad);
  const chosen = selection(pack.count, opts.select);
  if (!chosen.ok) return chosen;
  const c: Ctx = {
    pack, resolved, budget: opts.budget, cross: opts.crossBatchRef, chosen: chosen.value,
    batchOf: new Int32Array(pack.count).fill(-1), ofsMax: ofsLen(opts.budget.maxRequestBytes), unbuildable: [], threw: [],
  };
  const bad = checkEntries(c);
  if (bad !== null) return err(bad);
  const blobFams: number[][] = [];
  const restFams: number[][] = [];
  for (const [r, list] of [...families(c)].toSorted((x, y) => x[0] - y[0])) {
    if ((resolved.columns.type[r] as number) === BLOB) blobFams.push(list);
    else restFams.push(list);
  }
  const blobs = planBlobs(c, blobFams);
  const batches = blobs.ok ? planFinal(c, restFams, blobs.value) : blobs;
  // an exception out of the caller's `resolved.oid()` is the cause, ahead of any other refusal: never swallowed
  const threw = at(c.threw, 0);
  if (threw.tag === 'some') {
    return 'threw' in threw.value
      ? fail('bad_request', 'the resolved index\'s oid() threw when a cut base\'s id was asked for', { cause: threw.value.threw })
      : fail('bad_request', 'the resolved index\'s oid() returned nothing when a cut base\'s id was asked for');
  }
  if (!batches.ok) return batches;
  const stuck = at(c.unbuildable, 0);
  if (stuck.tag === 'some') return fail('bad_request', `entry ${stuck.value} is an OFS_DELTA cut from its base, and the resolved index has no id (40 lowercase hex) for that base to write it as a REF_DELTA`);
  const entries = batches.value.reduce((s, b) => s + b.objects, 0);
  const body = { version: PLAN_VERSION, trailer: pack.trailer, budget: { ...opts.budget }, crossBatchRef: opts.crossBatchRef, select: opts.select === null ? null : [...opts.select], batches: batches.value, entries } as const;
  return ok({ ...body, hash: planHash(body) });
}
