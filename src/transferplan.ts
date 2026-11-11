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
import type { PackPlan, PushBudget } from './packplan.js';
import { planPackBatches } from './packplan.js';
import type { ScannedPack, ScannedType } from './packscanindex.js';
import type { ResolvedIndex } from './packrangeresolve.js';
import type { Oid } from './sha1.js';
import type { RangeSource } from './rangesource.js';
import type { Refname, TempRef } from './transfernames.js';
import { sha1Hex, targetRef, tempRefOf, isOid, isOptionOid, isPushRef, isList } from './transfernames.js';

const OBJ_BLOB = TYPE.BLOB;
const OBJ_COMMIT = TYPE.COMMIT;
const OBJ_TREE = TYPE.TREE;
const MODE_BLOB = '100644';
const MODE_TREE = '40000';

export const TRANSFER_VERSION = 1;
export const TRANSFER_REF_PREFIX = 'refs/ply/transfer/';
export const TRANSFER_IDENT = 'ply transfer <ply-transfer@invalid> 0 +0000';
// Generated objects per batch at most: 256 subtrees, the root tree, the temp commit.
export const TRANSFER_GENERATED_OBJECTS = 258;
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

// The temp tree for a batch: its objects by id, fanned out by the id's first two hex digits. The root tree is last.
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
    const data = encodeEntries([...group.values()]);
    if (!data.ok) return data;
    const oid = hashObject('tree', data.value);
    subtrees.push({ type: OBJ_TREE, data: data.value, oid });
    top.push({ mode: MODE_TREE, name: fan, oid });
  }
  const rootData = encodeEntries(top);
  if (!rootData.ok) return rootData;
  return ok({ subtrees, root: { type: OBJ_TREE, data: rootData.value, oid: hashObject('tree', rootData.value) } });
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
function reserved(b: PushBudget): PushBudget {
  return { ...b, reserveObjects: b.reserveObjects + TRANSFER_GENERATED_OBJECTS, reserveBytes: b.reserveBytes + b.maxObjects * GEN_BYTES_PER_OBJECT + GEN_BYTES_FIXED };
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
  const opts = withDefaults<TransferConfig>(input, { budget: input.budget, ref: input.ref, commit: input.commit, tempPrefix: TRANSFER_REF_PREFIX, crossBatchRef: false, atomic: true });
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
  const planned = planPackBatches(pack, resolved, { budget: reserved(opts.budget), select: select.value, crossBatchRef: opts.crossBatchRef });
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

const edited = (): Result<never, PlyError> => fail('bad_request', 'transfer: the plan does not match its hash', { what: 'plan' });
// A step read back: one of the two variants, its ids well formed, its prev an Option of one.
function wellFormedStep(s: TransferStepPlan): boolean {
  if (typeof s !== 'object' || s === null || !isOptionOid(s.prev)) return false;
  if (s.kind === 'batch') return isOid(s.temp);
  return s.kind === 'final' && !Reflect.has(s, 'temp');
}

// A plan as read back (JSON, a store): its ids, refs and steps well formed, and its hash matching, so a step never
// pushes from an edited or stale plan. The last step is the only final one.
export function checkTransferPlan(plan: TransferPlan): Result<TransferPlan, PlyError> {
  if (typeof plan !== 'object' || plan === null || plan.version !== TRANSFER_VERSION) return edited();
  if (!isOid(plan.source) || !isOid(plan.tree) || !isOid(plan.head) || !isList(plan.steps)) return edited();
  if (!targetRef(plan.ref).ok || !isPushRef(plan.tempRef)) return edited();
  const last = at(plan.steps, plan.steps.length - 1);
  if (last.tag !== 'some' || last.value.kind !== 'final' || !plan.steps.every((s, i) => wellFormedStep(s) && (s.kind === 'final') === (i === plan.steps.length - 1))) return edited();
  const { hash, ...body } = plan;
  return transferPlanHash(body) === hash ? ok(plan) : edited();
}
