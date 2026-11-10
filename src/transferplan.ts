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
import type { Result } from './result.js';
import { ok, getOrElse } from './result.js';
import { parseCommit, encodeCommitOf, encodeEntries, hashObject, TYPE } from './objects.js';
import type { Input } from './absent.js';
import { mapGet, withDefaults } from './absent.js';
import type { PackPlan, PushBudget } from './packplan.js';
import { planPackBatches } from './packplan.js';
import type { ScannedPack } from './packscanindex.js';
import type { ResolvedIndex } from './packrangeresolve.js';
import type { Oid } from './sha1.js';
import { Sha1, toOid } from './sha1.js';
import { te } from './bytes.js';
import type { RangeSource } from './rangesource.js';

const OBJ_BLOB = TYPE.BLOB;
const OBJ_COMMIT = TYPE.COMMIT;
const OBJ_TREE = TYPE.TREE;
const MODE_BLOB = '100644';
const MODE_TREE = '40000';

// In-range indexed reads of columns sized by the index; noUncheckedIndexedAccess cannot see that.
/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- in-range indexed reads, see above */

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

// The pack, read through `source`, with its index and resolved columns: what a step reads its batch from.
export type TransferPack = { readonly source: RangeSource; readonly pack: ScannedPack; readonly resolved: ResolvedIndex };
export type TransferConfig = {
  // the host's per-push limits, before ply's own reserve for generated objects (added here)
  readonly budget: PushBudget;
  // the ref to create on the destination; it must not exist there
  readonly ref: string;
  // the source commit's bytes (scanPackIndex's content callback hands them over)
  readonly commit: Uint8Array;
  // where temp refs live (default refs/ply/transfer/)
  readonly tempPrefix: string;
  // a delta whose base is pushed in an earlier batch, as REF_DELTA (packPlan crossBatchRef; default off)
  readonly crossBatchRef: boolean;
  // the last push creates the ref and deletes the temp ref atomically (default); false: one push, not atomic
  readonly atomic: boolean;
};
export type TransferOpts = Pick<TransferConfig, 'budget' | 'ref' | 'commit'> & Input<Omit<TransferConfig, 'budget' | 'ref' | 'commit'>>;
export type TransferStepPlan = {
  readonly kind: 'batch' | 'final';
  // the temp commit this step moves the temp ref to (null for the final step) and the one before it (null: none)
  readonly temp: Oid | null;
  readonly prev: Oid | null;
};
export type TransferPlan = {
  readonly version: typeof TRANSFER_VERSION;
  readonly source: Oid;
  readonly tree: Oid;
  // the new root commit the ref is created at
  readonly head: Oid;
  readonly ref: string;
  readonly tempRef: string;
  readonly atomic: boolean;
  readonly pack: PackPlan;
  readonly steps: readonly TransferStepPlan[];
  // SHA-1 hex of the canonical JSON of everything above
  readonly hash: string;
};
export type GeneratedObject = { readonly type: number; readonly data: Uint8Array; readonly oid: Oid };

const sha1Hex = (s: string): string => new Sha1().update(te.encode(s)).hex();
const oidAt = (r: ResolvedIndex, i: number): Oid => toOid(r.columns.oid.subarray(i * 20, i * 20 + 20));

// The temp tree for a batch: its objects by id, fanned out by the id's first two hex digits.
export function batchTrees(resolved: ResolvedIndex, entries: readonly number[]): Result<GeneratedObject[], PlyError> {
  const groups = new Map<string, Map<string, string>>();
  for (const i of entries) {
    const hex = oidAt(resolved, i);
    const mode = (resolved.columns.type[i] as number) === OBJ_TREE ? MODE_TREE : MODE_BLOB;
    const group = getOrElse(mapGet(groups, hex.slice(0, 2)), new Map<string, string>());
    group.set(hex.slice(2), mode);
    groups.set(hex.slice(0, 2), group);
  }
  const out: GeneratedObject[] = [];
  const root: Array<{ mode: typeof MODE_TREE; name: string; oid: Oid }> = [];
  for (const [prefix, group] of groups) {
    const data = encodeEntries([...group].map(([name, mode]) => ({ mode: mode === MODE_TREE ? MODE_TREE : MODE_BLOB, name, oid: `${prefix}${name}` as Oid })));
    if (!data.ok) return data;
    const oid = hashObject('tree', data.value);
    out.push({ type: OBJ_TREE, data: data.value, oid });
    root.push({ mode: MODE_TREE, name: prefix, oid });
  }
  const rootData = encodeEntries(root);
  if (!rootData.ok) return rootData;
  out.push({ type: OBJ_TREE, data: rootData.value, oid: hashObject('tree', rootData.value) });
  return ok(out);
}

// A commit object, encoded and hashed.
function commitObject(fields: Parameters<typeof encodeCommitOf>[0]): Result<GeneratedObject, PlyError> {
  const data = encodeCommitOf(fields);
  return data.ok ? ok({ type: OBJ_COMMIT, data: data.value, oid: hashObject('commit', data.value) }) : data;
}

// A batch's temp commit over its temp root tree, its parent the previous temp commit.
export function tempCommit(key: string, step: number, steps: number, tree: Oid, prev: Oid | null): Result<GeneratedObject, PlyError> {
  return commitObject({ tree, parents: prev === null ? [] : [prev], author: TRANSFER_IDENT, committer: TRANSFER_IDENT, message: `ply transfer ${key} batch ${step + 1} of ${steps}\n` });
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

function canonical(p: Omit<TransferPlan, 'hash'>): string {
  return JSON.stringify([p.version, p.source, p.tree, p.head, p.ref, p.tempRef, p.atomic, p.pack.hash, p.steps.map(s => [s.kind, s.temp, s.prev])]);
}
// The hash a plan should carry; a plan read back from storage is checked with it before a step uses it.
export const transferPlanHash = (p: Omit<TransferPlan, 'hash'>): string => sha1Hex(canonical(p));

// Only the commit's tree and blobs are copied: a commit or tag in the pack is left out (the new commit replaces it).
function treeEntries(pack: ScannedPack, resolved: ResolvedIndex): number[] {
  const out: number[] = [];
  for (let i = 0; i < pack.count; i++) {
    const t = resolved.columns.type[i] as number;
    if (t === OBJ_TREE || t === OBJ_BLOB) out.push(i);
  }
  return out;
}

// A batch's generated objects: its temp trees and temp commit (the commit last).
export function tempFor(resolved: ResolvedIndex, entries: readonly number[], at: { readonly key: string; readonly step: number; readonly steps: number; readonly prev: Oid | null }): Result<{ readonly objects: readonly GeneratedObject[]; readonly commit: GeneratedObject }, PlyError> {
  const trees = batchTrees(resolved, entries);
  if (!trees.ok) return trees;
  const rootTree = trees.value.at(-1) as GeneratedObject;
  const commit = tempCommit(at.key, at.step, at.steps, rootTree.oid, at.prev);
  if (!commit.ok) return commit;
  return ok({ objects: [...trees.value, commit.value], commit: commit.value });
}

// Plan a transfer of `opts.commit`'s tree (see the top of this file). Refusals (a tree not in the pack, a budget an
// object cannot fit, anything planPackBatches refuses) happen here, before anything is pushed.
export function planTransfer(pack: ScannedPack, resolved: ResolvedIndex, input: TransferOpts): Result<TransferPlan, PlyError> {
  const opts = withDefaults<TransferConfig>(input, { budget: input.budget, ref: input.ref, commit: input.commit, tempPrefix: TRANSFER_REF_PREFIX, crossBatchRef: false, atomic: true });
  const root = rootCommit(opts.commit);
  if (!root.ok) return root;
  const { tree } = root.value;
  // ResolvedIndex.find is a lookup by id, not Array#find
  const lookup = resolved.find;
  const treeAt = lookup(tree);
  if (treeAt.tag !== 'some' || (resolved.columns.type[treeAt.value] as number) !== OBJ_TREE) {
    return fail('bad_request', `transfer: the commit's tree ${root.value.tree} is not a tree in the pack`, { what: 'tree' });
  }
  const planned = planPackBatches(pack, resolved, { budget: reserved(opts.budget), select: treeEntries(pack, resolved), crossBatchRef: opts.crossBatchRef });
  if (!planned.ok) return planned;
  const head = root.value.commit.oid;
  const key = sha1Hex(JSON.stringify([planned.value.hash, head, opts.ref]));
  const tempRef = `${opts.tempPrefix}${key}`;
  const steps: TransferStepPlan[] = [];
  let prev: Oid | null = null;
  const n = planned.value.batches.length;
  for (const [i, b] of planned.value.batches.entries()) {
    if (b.kind === 'final') { steps.push({ kind: 'final', temp: null, prev }); continue; }
    const made = tempFor(resolved, b.entries, { key, step: i, steps: n, prev });
    if (!made.ok) return made;
    const temp: Oid = made.value.commit.oid;
    steps.push({ kind: 'batch', temp, prev });
    prev = temp;
  }
  const body = { version: TRANSFER_VERSION, source: root.value.source, tree: root.value.tree, head, ref: opts.ref, tempRef, atomic: opts.atomic, pack: planned.value, steps } as const;
  return ok({ ...body, hash: transferPlanHash(body) });
}

// The key a plan's temp commits and temp ref are named by.
export const transferKey = (plan: TransferPlan): string => sha1Hex(JSON.stringify([plan.pack.hash, plan.head, plan.ref]));

// A plan as read back (JSON, a store): its hash must match, so a step never pushes from an edited or stale plan.
export function checkTransferPlan(plan: TransferPlan): Result<TransferPlan, PlyError> {
  const { hash, ...body } = plan;
  if (plan.version !== TRANSFER_VERSION || transferPlanHash(body) !== hash) return fail('bad_request', 'transfer: the plan does not match its hash', { what: 'plan' });
  return ok(plan);
}
