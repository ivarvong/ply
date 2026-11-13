// Resumable transfer, the plan (#238): copy one commit's tree, read from a spooled pack, to another remote as a new
// parentless commit, in pushes under a host's cap. Pure: everything here is data computed from the pack's index
// (scanPackIndex, #236), its resolved ids and types (resolvePackRange, #248) and the source commit's bytes. The effects
// (status, one push per step, the loop) are in transfer.ts.
//
// The plan is planPackBatches' (#237) plus what makes each push safe to retry and to resume from the destination alone:
//   - every batch but the last advances a temp ref (refs/ply/transfer/<key> by default) to a temp commit whose parent is
//     the previous one and whose tree lists that batch's objects by id. Everything pushed so far is reachable from the
//     temp ref at every moment, so nothing depends on how long a host keeps unreachable objects, and the server's
//     connectivity check passes on every push. The listing fans out into subtrees by the id's first two hex digits: a
//     flat tree was refused above about 16k entries on Cloudflare Artifacts (2026-11-09 spike); 256 subtrees passed at
//     50,001 objects.
//   - the last batch (trees, with any blobs that fit) carries the new root commit and, in one atomic push, creates the
//     target ref (compare-and-swap on the zero id) and deletes the temp ref.
//   - every generated object (temp trees, temp commits, the new commit) has a deterministic id, written in the plan, so
//     the next step is found by reading the temp ref back (transferStatus), never by local state.
//
// Commit policy: the new commit keeps the source commit's author, committer, encoding, message and other headers, and
// drops gpgsig, gpgsig-sha256 and mergetag (a signature over a different object would be false). Temp commits are
// written by `ply transfer <ply-transfer@invalid> 0 +0000`, so the same plan always gives the same ids.
import type { PlyError } from './errors.js';
import { fail } from './errors.js';
import type { Option, Result } from './result.js';
import { ok, some, none, getOrElse } from './result.js';
import { parseCommit, encodeCommitOf, encodeEntries, hashObject, TYPE } from './objects.js';
import type { EntryOf } from './objects.js';
import type { Input } from './absent.js';
import { at, mapGet, withDefaults } from './absent.js';
import type { PackPlan, PlannedBatch, PushBudget } from './packplan.js';
import { planPackBatches, planHash, packObjectsBound, PLAN_VERSION, PLAN_MAX_PACK_OBJECTS } from './packplan.js';
import type { ScannedPack, ScannedType } from './packscanindex.js';
import type { ResolvedIndex } from './packrangeresolve.js';
import type { Oid } from './sha1.js';
import type { RangeSource } from './rangesource.js';
import type { Refname, TempRef } from './transfernames.js';
import { sha1Hex, targetRef, tempRefOf, isOid, isOptionOid, isList } from './transfernames.js';

const OBJ_BLOB = TYPE.BLOB;
const OBJ_COMMIT = TYPE.COMMIT;
const OBJ_TREE = TYPE.TREE;
const MODE_BLOB = '100644';
const MODE_TREE = '40000';

export const TRANSFER_VERSION = 1;
export const TRANSFER_REF_PREFIX = 'refs/ply/transfer/';
export { sweepPrefix, isTempKey } from './transfernames.js';
export const TRANSFER_IDENT = 'ply transfer <ply-transfer@invalid> 0 +0000';
// Generated objects per batch at most: 256 subtrees, the root tree, the temp commit.
export const TRANSFER_GENERATED_OBJECTS = 258;
// Entries in one generated tree at most: under the 16,223 a host refused above (Cloudflare Artifacts, 2026-11-09).
export const TRANSFER_TREE_ENTRIES = 16_000;
// Bytes of generated objects per batch object at most: a subtree entry is `100644 ` + 38 hex + NUL + 20 bytes = 66,
// deflated stored at worst (a 5-byte header per 16 KiB block); the fixed part covers the root tree, the commits,
// object headers and the two commands' pkt-lines.
const GEN_BYTES_PER_OBJECT = 68;
const GEN_BYTES_FIXED = 32 * 1024;
const SIGNATURE_HEADERS = ['gpgsig', 'gpgsig-sha256', 'mergetag'];

export type { TempRef };
// The pack, read through `source`, with its index and resolved columns: what a step reads its batch from.
export type TransferPack = { readonly source: RangeSource; readonly pack: ScannedPack; readonly resolved: ResolvedIndex };
export type TransferConfig = {
  // the host's per-push limits, before ply's own reserve for generated objects (added here)
  readonly budget: PushBudget;
  // the ref to create on the destination; it must not exist there (any value: refused unless git would push it)
  readonly ref: string;
  // the source commit's bytes (scanPackIndex's content callback hands them over)
  readonly commit: Uint8Array;
  // where temp refs live (default refs/ply/transfer/); it ends in '/'
  readonly tempPrefix: string;
  // a delta whose base is pushed in an earlier batch, as REF_DELTA (packPlan crossBatchRef; default off)
  readonly crossBatchRef: boolean;
  // the last push creates the ref and deletes the temp ref atomically (default); false: one push, not atomic
  readonly atomic: boolean;
  // pack entries planned for at most (planPackBatches maxPackObjects; default DEFAULT_LIMITS.maxPackObjects), refused
  // as limit_exceeded before any per-entry structure is allocated
  readonly maxPackObjects: number;
};
export type TransferOpts = Pick<TransferConfig, 'budget' | 'ref' | 'commit'> & Input<Omit<TransferConfig, 'budget' | 'ref' | 'commit'>>;
// A step: a batch moves the temp ref from `prev` (none: the temp ref does not exist yet) to its temp commit; the final
// step creates the target ref from `prev` (the temp ref to delete, none when the transfer is one push). The plan is
// stored as JSON between requests: an Option is plain JSON ({"tag":"none"} / {"tag":"some","value":...}).
export type BatchStep = { readonly kind: 'batch'; readonly temp: Oid; readonly prev: Option<Oid> };
export type FinalStep = { readonly kind: 'final'; readonly prev: Option<Oid> };
export type TransferStepPlan = BatchStep | FinalStep;
export type TransferPlan = {
  readonly version: typeof TRANSFER_VERSION;
  readonly source: Oid;
  readonly tree: Oid;
  // the new root commit the ref is created at
  readonly head: Oid;
  readonly ref: Refname;
  readonly tempRef: TempRef;
  readonly atomic: boolean;
  readonly pack: PackPlan;
  readonly steps: readonly TransferStepPlan[];
  // SHA-1 hex of the canonical JSON of everything above
  readonly hash: string;
};
export type GeneratedType = typeof TYPE.TREE | typeof TYPE.COMMIT;
export type GeneratedObject = { readonly type: GeneratedType; readonly data: Uint8Array; readonly oid: Oid };

const outOfRange = (i: number): Result<never, PlyError> => fail('bad_request', `transfer: entry ${i} is not in the resolved index`, { what: 'entry' });
// The resolved id and type of entry `i`, read through the index's checked accessors. The index is the caller's object:
// what its accessor throws is the cause of a refusal, never an exception out of a plan, a step or a run.
function entryAt(r: ResolvedIndex, i: number): Result<{ readonly oid: Oid; readonly type: ScannedType }, PlyError> {
  try {
    const oid = r.oid(i);
    const type = r.type(i);
    return oid.tag === 'some' && type.tag === 'some' ? ok({ oid: oid.value, type: type.value }) : outOfRange(i);
  } catch (cause) {
    return fail('bad_request', `transfer: the resolved index threw reading entry ${i}`, { what: 'entry', cause });
  }
}

function treeObject(list: readonly EntryOf[]): Result<GeneratedObject, PlyError> {
  const data = encodeEntries([...list]);
  return data.ok ? ok({ type: OBJ_TREE, data: data.value, oid: hashObject('tree', data.value) }) : data;
}

// The temp tree for a batch: its objects by id, fanned out by the id's first two hex digits. A fan holding more than
// TRANSFER_TREE_ENTRIES ids (only a crafted id distribution, #298-3) is split, in id order, into subtrees of at most
// that many, named `<fan>`, `<fan>-1`, `<fan>-2`, ...; so no tree is over a host's limit, and a batch of n objects
// adds at most floor(n / TRANSFER_TREE_ENTRIES) trees past TRANSFER_GENERATED_OBJECTS. The root tree is last.
export function batchTrees(resolved: ResolvedIndex, entries: readonly number[]): Result<{ readonly subtrees: readonly GeneratedObject[]; readonly root: GeneratedObject }, PlyError> {
  // by fan, then by name: an id the batch holds twice (a pack may) is listed once
  const groups = new Map<string, Map<string, EntryOf>>();
  for (const i of entries) {
    const e = entryAt(resolved, i);
    if (!e.ok) return e;
    const { oid, type } = e.value;
    const fan = oid.slice(0, 2);
    const group = getOrElse(mapGet(groups, fan), new Map<string, EntryOf>());
    group.set(oid.slice(2), { mode: type === OBJ_TREE ? MODE_TREE : MODE_BLOB, name: oid.slice(2), oid });
    groups.set(fan, group);
  }
  const subtrees: GeneratedObject[] = [];
  const top: EntryOf[] = [];
  for (const [fan, group] of groups) {
    const list = [...group.values()];
    for (let c = 0; c * TRANSFER_TREE_ENTRIES < list.length; c++) {
      const sub = treeObject(list.slice(c * TRANSFER_TREE_ENTRIES, (c + 1) * TRANSFER_TREE_ENTRIES));
      if (!sub.ok) return sub;
      subtrees.push(sub.value);
      top.push({ mode: MODE_TREE, name: c === 0 ? fan : `${fan}-${c}`, oid: sub.value.oid });
    }
  }
  if (top.length > TRANSFER_TREE_ENTRIES) return fail('limit_exceeded', `transfer root tree: ${top.length} entries, max ${TRANSFER_TREE_ENTRIES}`, { what: 'transfer root tree entries', got: top.length, max: TRANSFER_TREE_ENTRIES });
  const root = treeObject(top);
  return root.ok ? ok({ subtrees, root: root.value }) : root;
}

// A commit object, encoded and hashed.
function commitObject(fields: Parameters<typeof encodeCommitOf>[0]): Result<GeneratedObject, PlyError> {
  const data = encodeCommitOf(fields);
  return data.ok ? ok({ type: OBJ_COMMIT, data: data.value, oid: hashObject('commit', data.value) }) : data;
}

// A batch's temp commit over its temp root tree, its parent the previous temp commit.
export function tempCommit(key: string, step: number, steps: number, tree: Oid, prev: Option<Oid>): Result<GeneratedObject, PlyError> {
  return commitObject({ tree, parents: prev.tag === 'some' ? [prev.value] : [], author: TRANSFER_IDENT, committer: TRANSFER_IDENT, message: `ply transfer ${key} batch ${step + 1} of ${steps}\n` });
}

// The source commit's headers without signatures (a header line and its continuation lines).
function unsigned(extra: readonly string[]): string[] {
  const out: string[] = [];
  let dropping = false;
  for (const line of extra) {
    if (line.startsWith(' ')) { if (!dropping) out.push(line); continue; }
    dropping = SIGNATURE_HEADERS.some(h => line.startsWith(`${h} `));
    if (!dropping) out.push(line);
  }
  return out;
}

// The new root commit: the source commit's tree and headers (see the commit policy above), no parents.
export function rootCommit(source: Uint8Array): Result<{ readonly source: Oid; readonly tree: Oid; readonly commit: GeneratedObject }, PlyError> {
  const c = parseCommit(source);
  if (!c.ok) return c;
  const v = c.value;
  const made = commitObject({ tree: v.tree, parents: [], author: v.author, committer: v.committer, encoding: v.encoding, message: v.message, extra: unsigned(v.extra) });
  return made.ok ? ok({ source: hashObject('commit', source), tree: v.tree, commit: made.value }) : made;
}

// The caller's budget with room for each batch's generated objects and the commands.
// Trees a batch of `maxObjects` objects may add past TRANSFER_GENERATED_OBJECTS (#298-3): a fan of g ids adds
// ceil(g / TRANSFER_TREE_ENTRIES) - 1 <= floor(g / TRANSFER_TREE_ENTRIES) trees, and the fans are disjoint.
export function extraTrees(maxObjects: number): number {
  return Math.floor(maxObjects / TRANSFER_TREE_ENTRIES);
}
function reserved(b: PushBudget): PushBudget {
  const extra = extraTrees(b.maxObjects);
  return { ...b, reserveObjects: b.reserveObjects + TRANSFER_GENERATED_OBJECTS + extra, reserveBytes: b.reserveBytes + (b.maxObjects + extra) * GEN_BYTES_PER_OBJECT + GEN_BYTES_FIXED };
}

// A step as canonical JSON: the variant's tag first, an absent prev as null (never the same text as an id).
const optionJson = (o: Option<Oid>): Oid | null => (o.tag === 'some' ? o.value : null);
const stepJson = (s: TransferStepPlan): ReadonlyArray<string | null> => (s.kind === 'batch' ? ['batch', s.temp, optionJson(s.prev)] : ['final', optionJson(s.prev)]);
function canonical(p: Omit<TransferPlan, 'hash'>): string {
  return JSON.stringify([p.version, p.source, p.tree, p.head, p.ref, p.tempRef, p.atomic, p.pack.hash, p.steps.map(stepJson)]);
}
// The hash a plan should carry; a plan read back from storage is checked with it before a step uses it.
export const transferPlanHash = (p: Omit<TransferPlan, 'hash'>): string => sha1Hex(canonical(p));

// Only the commit's tree and blobs are copied: a commit or tag in the pack is left out (the new commit replaces it).
function treeEntries(pack: ScannedPack, resolved: ResolvedIndex): Result<number[], PlyError> {
  const out: number[] = [];
  for (let i = 0; i < pack.count; i++) {
    const e = entryAt(resolved, i);
    if (!e.ok) return e;
    if (e.value.type === OBJ_TREE || e.value.type === OBJ_BLOB) out.push(i);
  }
  return ok(out);
}

// A batch's generated objects: its temp trees and temp commit (the commit last).
export function tempFor(resolved: ResolvedIndex, entries: readonly number[], place: { readonly key: string; readonly step: number; readonly steps: number; readonly prev: Option<Oid> }): Result<{ readonly objects: readonly GeneratedObject[]; readonly commit: GeneratedObject }, PlyError> {
  const trees = batchTrees(resolved, entries);
  if (!trees.ok) return trees;
  const { subtrees, root } = trees.value;
  const commit = tempCommit(place.key, place.step, place.steps, root.oid, place.prev);
  if (!commit.ok) return commit;
  return ok({ objects: [...subtrees, root, commit.value], commit: commit.value });
}

// The steps, one per batch: each batch's temp commit is the next one's prev.
function planSteps(resolved: ResolvedIndex, planned: PackPlan, key: string): Result<TransferStepPlan[], PlyError> {
  const steps: TransferStepPlan[] = [];
  let prev: Option<Oid> = none;
  const n = planned.batches.length;
  for (const [i, b] of planned.batches.entries()) {
    if (b.kind === 'final') { steps.push({ kind: 'final', prev }); continue; }
    const made = tempFor(resolved, b.entries, { key, step: i, steps: n, prev });
    if (!made.ok) return made;
    const temp = made.value.commit.oid;
    steps.push({ kind: 'batch', temp, prev });
    prev = some(temp);
  }
  return ok(steps);
}

// Plan a transfer of `opts.commit`'s tree (see the top of this file). Refusals (a ref git would not push, a tree not in
// the pack, a budget an object cannot fit, anything planPackBatches refuses) happen here, before anything is pushed.
export function planTransfer(pack: ScannedPack, resolved: ResolvedIndex, input: TransferOpts): Result<TransferPlan, PlyError> {
  const opts = withDefaults<TransferConfig>(input, { budget: input.budget, ref: input.ref, commit: input.commit, tempPrefix: TRANSFER_REF_PREFIX, crossBatchRef: false, atomic: true, maxPackObjects: PLAN_MAX_PACK_OBJECTS });
  const bound = packObjectsBound(pack.count, opts.maxPackObjects);
  if (!bound.ok) return bound;
  const ref = targetRef(opts.ref);
  if (!ref.ok) return ref;
  const root = rootCommit(opts.commit);
  if (!root.ok) return root;
  const { tree } = root.value;
  // ResolvedIndex.find is a lookup by id, not Array#find
  const lookup = resolved.find;
  const treeAt = lookup(tree);
  const treeType = treeAt.tag === 'some' ? resolved.type(treeAt.value) : none;
  if (treeType.tag !== 'some' || treeType.value !== OBJ_TREE) {
    return fail('bad_request', `transfer: the commit's tree ${tree} is not a tree in the pack`, { what: 'tree' });
  }
  const select = treeEntries(pack, resolved);
  if (!select.ok) return select;
  const planned = planPackBatches(pack, resolved, { budget: reserved(opts.budget), select: select.value, crossBatchRef: opts.crossBatchRef, maxPackObjects: opts.maxPackObjects });
  if (!planned.ok) return planned;
  const head = root.value.commit.oid;
  const key = sha1Hex(JSON.stringify([planned.value.hash, head, ref.value]));
  const tempRef = tempRefOf(opts.tempPrefix, key);
  if (!tempRef.ok) return tempRef;
  const steps = planSteps(resolved, planned.value, key);
  if (!steps.ok) return steps;
  const body = { version: TRANSFER_VERSION, source: root.value.source, tree, head, ref: ref.value, tempRef: tempRef.value, atomic: opts.atomic, pack: planned.value, steps: steps.value } as const;
  return ok({ ...body, hash: transferPlanHash(body) });
}

// The key a plan's temp commits and temp ref are named by.
export const transferKey = (plan: TransferPlan): string => sha1Hex(JSON.stringify([plan.pack.hash, plan.head, plan.ref]));

// What the caller of this call holds a plan read back to: the one ref this transfer may create, named on every call
// (a stored plan is never trusted to choose it), and the prefix its temp ref was planned under (default
// refs/ply/transfer/; a plan made with a custom tempPrefix is resumed by naming it again).
export type PlanExpectConfig = { readonly tempPrefix: string; readonly ref: string };
export type PlanExpect = Pick<PlanExpectConfig, 'ref'> & Input<Omit<PlanExpectConfig, 'ref'>>;

const edited = (): Result<never, PlyError> => fail('bad_request', 'transfer: the plan does not match its hash', { what: 'plan' });
// A step read back: one of the two variants, its ids well formed, its prev an Option of one.
function wellFormedStep(s: TransferStepPlan): boolean {
  if (typeof s !== 'object' || s === null || !isOptionOid(s.prev)) return false;
  if (s.kind === 'batch') return isOid(s.temp);
  return s.kind === 'final' && !Reflect.has(s, 'temp');
}

// A count or an entry index as JSON gives it back: a non-negative safe integer.
const isCount = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
// Every element of a list read back passes, a hole included. Array#every skips a hole (an index below the length that
// is not an element: a structured-clone store can hand one back, JSON cannot); for...of visits it, as a value that
// is no number and no object, which no element check here passes. So a plan with a hole in its steps, batches,
// selection or a batch's entries is not well formed, and nothing after the shape check meets one.
function everyOf<T>(list: readonly T[], pass: (v: T, i: number) => boolean): boolean {
  let i = 0;
  for (const v of list) {
    if (!pass(v, i)) return false;
    i += 1;
  }
  return true;
}
// The plan's long lists (the selection, a batch's entries): the same walk, with no call per element but isCount.
function isCounts(v: readonly number[]): boolean {
  if (!isList(v)) return false;
  for (const n of v) if (!isCount(n)) return false;
  return true;
}
function wellFormedBatch(b: PlannedBatch): boolean {
  if (typeof b !== 'object' || b === null || (b.kind !== 'blobs' && b.kind !== 'final')) return false;
  return isCount(b.packBytes) && isCount(b.objects) && isCount(b.refRewrites) && isCounts(b.entries);
}
function wellFormedBudget(b: PushBudget): boolean {
  if (typeof b !== 'object' || b === null) return false;
  return [b.maxRequestBytes, b.maxObjects, b.maxObjectBytes, b.maxCompressedObjectBytes, b.reserveBytes, b.reserveObjects].every(n => isCount(n));
}
// The pack plan, every field planHash and a step read: one batch per step, a blobs batch for a batch step and the
// final batch for the final step.
function wellFormedPack(p: PackPlan, steps: readonly TransferStepPlan[]): boolean {
  if (typeof p !== 'object' || p === null || p.version !== PLAN_VERSION || typeof p.hash !== 'string' || typeof p.trailer !== 'string') return false;
  if (typeof p.crossBatchRef !== 'boolean' || !isCount(p.entries) || !wellFormedBudget(p.budget)) return false;
  if (p.select !== null && !isCounts(p.select)) return false;
  if (!isList(p.batches) || p.batches.length !== steps.length || !everyOf(p.batches, b => wellFormedBatch(b))) return false;
  return everyOf(p.batches, (b, i) => {
    const s = at(steps, i);
    return s.tag === 'some' && (b.kind === 'final') === (s.value.kind === 'final');
  });
}

// The batches partition the selection: the selection is entry indices in pack order (ascending, as planTransfer
// selects them), every selected entry is in exactly one batch, no batch holds anything else, and each count is the
// length it counts. A hash cannot hold this (whoever wrote the plan wrote the hash), so it is checked directly.
// Memory: one set of the selection, which the plan already holds.
function partitions(p: PackPlan): boolean {
  const { select } = p;
  if (select === null || p.entries !== select.length) return false;
  let prev = -1;
  for (const i of select) {
    if (i <= prev) return false;
    prev = i;
  }
  const left = new Set(select);
  for (const b of p.batches) {
    if (b.objects !== b.entries.length) return false;
    for (const i of b.entries) if (!left.delete(i)) return false;
  }
  return left.size === 0;
}

// Every field the check, the key, the two hashes and a step read: ids, refs, the steps (each well formed before its
// kind is read; the last the only final one), the pack plan.
function wellFormedPlan(plan: TransferPlan): boolean {
  if (typeof plan !== 'object' || plan === null || plan.version !== TRANSFER_VERSION) return false;
  if (!isOid(plan.source) || !isOid(plan.tree) || !isOid(plan.head) || !isList(plan.steps)) return false;
  if (!targetRef(plan.ref).ok || typeof plan.tempRef !== 'string' || typeof plan.atomic !== 'boolean' || typeof plan.hash !== 'string') return false;
  const last = plan.steps.length - 1;
  if (last < 0 || !everyOf(plan.steps, (s, i) => wellFormedStep(s) && (s.kind === 'final') === (i === last))) return false;
  return wellFormedPack(plan.pack, plan.steps);
}

// A plan as read back (JSON, a store) is untrusted input. The check, which transferStatus, transferStep and
// runTransfer all make before they act or answer:
//   - it is total: every field the check, a hash or a later step reads (ids, refs, steps, the pack plan's budget,
//     selection, batches and their entries) has its type and shape checked first, so a plan of any shape is answered
//     with bad_request, never a TypeError. A hole in any of its arrays is such a shape (everyOf): what 'plan';
//   - its temp ref is not a free field: it must be the name tempRefOf derives from the plan's key under the caller's
//     prefix, and never the target ref. So the only refs a plan can make a push create, move or delete are
//     refs/ply/transfer/<key> (or the caller's prefix) and the target ref;
//   - its target ref is not a free field: the caller names the ref on every call (`expect.ref`), the plan's must
//     equal it, and a call that names none is refused;
//   - both hashes are recomputed and match: the pack plan's own (planHash: trailer, budget, crossBatchRef, selection,
//     entry count, every batch and its entries) and the transfer's (ids, refs, atomic, the pack plan's hash, the
//     steps), so every field a step reads is under a hash. The hashes are unkeyed (both functions are public): they
//     are integrity against corruption and stale or partial writes, NOT authentication against whoever can write the
//     plan store. What bounds a hostile
//     plan is the temp ref rule above, the named target ref, the partition rule below and the destination's own
//     checks (every update is a compare-and-swap; the server checks connectivity);
//   - what the steps push is not a free field either: the batches partition the selection (every selected entry in
//     exactly one batch, nothing else in any), and transferStep and runTransfer, which hold the pack, check the
//     selection is exactly the pack's trees and blobs (planFitsPack) before any request.
export function checkTransferPlan(plan: TransferPlan, expect: PlanExpect): Result<TransferPlan, PlyError> {
  const want = withDefaults<PlanExpectConfig>(expect, { tempPrefix: TRANSFER_REF_PREFIX, ref: '' });
  // the caller's own argument first: no ref named, nothing is read from the plan
  if (typeof want.ref !== 'string' || want.ref === '') return fail('bad_request', 'transfer: name the ref this transfer creates (`ref`) on every call with a stored plan; the plan is not trusted to choose it', { what: 'ref' });
  if (!wellFormedPlan(plan)) return edited();
  const { hash, ...body } = plan;
  // corruption first (an honest plan, damaged), then what holds whoever wrote the hash
  const { hash: packHash, ...packBody } = plan.pack;
  if (planHash(packBody) !== packHash || transferPlanHash(body) !== hash) return edited();
  if (!partitions(plan.pack)) return fail('bad_request', 'transfer: the plan\'s batches are not its selection, each entry in one batch', { what: 'batches' });
  const named = tempRefOf(want.tempPrefix, transferKey(plan));
  if (!named.ok || plan.tempRef !== named.value || plan.tempRef === plan.ref) return fail('bad_request', 'transfer: the plan\'s temp ref is not the one its key names under this call\'s `tempPrefix` (a plan made with a custom tempPrefix is resumed by naming it)', { what: 'tempRef' });
  if (plan.ref !== want.ref) return fail('bad_request', `transfer: the plan is for ${plan.ref}, not the ref this call names`, { what: 'ref' });
  return ok(plan);
}

// The plan is for this pack: its trailer, and its selection exactly the pack's trees and blobs in pack order (what
// planTransfer selects). With the partition checkTransferPlan makes, this holds what a run pushes to the pack's trees
// and blobs, each once, whatever hashes the plan carries: transferStep and runTransfer make it before any request.
// One pass over the index, nothing allocated.
export function planFitsPack(plan: TransferPlan, pack: ScannedPack, resolved: ResolvedIndex): Result<TransferPlan, PlyError> {
  if (pack.trailer !== plan.pack.trailer) return fail('bad_request', `transfer: the pack (trailer ${pack.trailer}) is not the planned one (${plan.pack.trailer})`, { what: 'pack' });
  const select = getOrElse<readonly number[]>(plan.pack.select === null ? none : some(plan.pack.select), []);
  let k = 0;
  for (let i = 0; i < pack.count; i++) {
    // the type column alone: no id is built per entry
    const type = resolved.type(i);
    if (type.tag !== 'some') return outOfRange(i);
    if (type.value !== OBJ_TREE && type.value !== OBJ_BLOB) continue;
    if (getOrElse(at(select, k), -1) !== i) return fail('bad_request', `transfer: the plan's selection is not the pack's trees and blobs (entry ${i}); the pack is not the one planned`, { what: 'pack' });
    k++;
  }
  return k === select.length ? ok(plan) : fail('bad_request', 'transfer: the plan selects entries the pack does not hold as trees or blobs; the pack is not the one planned', { what: 'pack' });
}
