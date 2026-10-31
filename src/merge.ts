// Landing a branch, with git operations only: fast-forward, a merge commit from a three-way tree merge, branch delete.
//
// mergeBranch(ref ← from): ls-refs both, find the merge base (commit-only fetches, tree:0, doubling depth), then
//   - ours == base      → fast-forward: push the branch head to ref, empty pack (the server has every object)
//   - theirs == base    → nothing to do
//   - else              → three-way merge of the two trees against the base tree, directory by directory, fetching only the
//                         subtrees that differ; a commit with parents [ours, theirs]; push the commit + the new trees and
//                         merged blobs. A regular file both sides changed is merged line by line with a port of git's xdiff
//                         (linemerge.js: histogram diff, compaction, zealous conflict refinement) — clean exactly where git is
//                         clean and byte-identical, else `merge_conflict` with the paths and a reason per path. Our conflicts
//                         are a superset of git's: the rename guards below, and the rare file where git's diff falls back to
//                         classic Myers, which we do not port (test/fuzz/linemerge.mjs measures it). Where we succeed, the
//                         tree is what `git merge-tree --write-tree` produces (test/merge.test.js).
// The pure parts: threeWay (one directory), mergeMode, bestBases (git merge-base --all over known commits), uniqueObjects; linemerge.js. The effects: lsRefs, fetchObject, push.
/* oxlint-disable import/max-dependencies -- a merge drives ls-refs, fetch, push, the object codecs and the line merge */
/* oxlint-disable eslint/require-await, typescript/promise-function-async -- each function keeps its async-ness (a sync throw stays sync); together the two rules forbid a function that forwards a promise */
import type { ValidatedIdent } from './validate.js';
import type { Limits } from './limits.js';
import type { Driver, Rediff } from './linemerge.js';
import { thrown as fail } from './errors.js';
import { lsRefs } from './lsrefs.js';
import { fetchObject } from './fetch.js';
import { fetchPackTree0 } from './fetchpack.js';
import { push, ZERO_OID } from './push.js';
import { operation, verifyRef } from './operation.js';
import { parseTree, encodeTree, parseCommit, encodeCommit, hashObject, ident, TYPE } from './objects.js';
import { validateRef, validatePushRef, validateIdent, validateMessage } from './validate.js';
import { signCommit } from './sign.js';
import { mergeLines } from './linemerge.js';
import { attributesFor, bytesToStr, utf8ToStr } from './attributes.js';
import { limitError, requireLimit, finiteLimit, LIMIT_MERGE_BLOB } from './limits.js';

// The shapes this module reads from unconverted modules (objects, transport, operation, push, ls-refs); their own
// clusters own the full types.
export type TreeEntry = { readonly mode: string; readonly name: string; readonly oid: string };
export type Commit = {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly encoding: string | null;
  readonly message: string | null;
  readonly extra: readonly string[];
};
export type PackObject = { readonly type: number; readonly data: Uint8Array; readonly oid: string };
// the transport every operation runs on (src/transport.ts); re-exported for rebase.ts
export type { Transport } from './transport.js';
import type { Transport } from './transport.js';
// the span every operation records on (src/otel.js); re-exported for rebase.ts
export type { Span } from './otel.js';
import type { Span } from './otel.js';
export type Outcome = <R>(kind: string, result: R, attrs?: Readonly<Record<string, unknown>>) => R;
export type OpContext = { readonly t: Transport; readonly root: Span; readonly outcome: Outcome; readonly limits: Limits };
export type PushResult = { readonly packBytes: number };
export type Refs = { readonly refs: ReadonlyMap<string, { readonly oid: string; readonly peeled?: string }> };
export type Author = { readonly name: string; readonly email: string; readonly tz?: string };
export type Signer = { readonly sign: (message: Uint8Array, namespace?: string) => Promise<string> };
export type TreeCache = Map<string, Uint8Array>;
type Fetched = { readonly data: Uint8Array };
export type PushObject = { readonly type: number; readonly data: Uint8Array };

// The unconverted modules' functions as this module calls them. TS infers their parameter types from the JS defaults
// (`expectType = null` reads as null, `parents = []` as never[]), which no caller satisfies. These go as they convert.
/* oxlint-disable typescript/no-unsafe-type-assertion -- see above */
const fetchObj = fetchObject as unknown as (t: Transport, o: { readonly oid: string | null | undefined; readonly expectType: number; readonly deepen?: number }) => Promise<Fetched>;
const pushRef = push as unknown as (t: Transport, o: { readonly ref: string; readonly oldOid: string; readonly newOid: string; readonly objects: readonly PushObject[] }) => Promise<PushResult>;
const runOp = operation as unknown as <R>(op: string, url: string, opts: Readonly<Record<string, unknown>>, body: (ctx: OpContext) => Promise<R>) => Promise<R>;
const commitBytes = encodeCommit as unknown as (c: { readonly tree: string; readonly parents: readonly string[]; readonly author: string; readonly committer: string; readonly message: string }) => Uint8Array;
/* oxlint-enable typescript/no-unsafe-type-assertion */

const EMPTY: readonly TreeEntry[] = [];
// An entry absent on a side is undefined.
type Entry = TreeEntry | undefined;
const same = (a: Entry, b: Entry): boolean => a === b || (a !== undefined && b !== undefined && a.mode === b.mode && a.oid === b.oid);
const isTree = (e: Entry): boolean => e?.mode === '40000';

// Pure: three-way merge of one directory's entries. Returns { entries (resolved, in no particular order), recurse: [name],
// conflicts: [name], content: [name], deletedBoth, addedOurs, addedTheirs }. An entry absent on a side is undefined. Rules
// (git's trivial-merge rules, tree level): same on both sides → that; unchanged on one side → the other side's; both
// trees → recurse; both regular files changed differently over a regular base → `content` (a line merge may resolve it);
// otherwise → conflict. The deleted/added lists feed the rename guards in mergeTrees.
// A6 pass: PathDecision = take | drop | recurse | content | conflict{reason} instead of parallel lists.
export type ThreeWay = {
  readonly entries: TreeEntry[];
  readonly recurse: string[];
  readonly conflicts: string[];
  readonly content: string[];
  readonly deletedBoth: string[];
  readonly addedOurs: string[];
  readonly addedTheirs: string[];
};
const isFile = (e: Entry): boolean => e?.mode === '100644' || e?.mode === '100755';
// directory vs directory, or a directory one side deleted/added: recurse so the conflict (if any) is per file,
// and untouched files inside a directory the other side deleted go away, as git does
const treeish = (e: Entry): boolean => e === undefined || isTree(e);
const recurses = (O: Entry, T: Entry): boolean => treeish(O) && treeish(T) && (isTree(O) || isTree(T));
const byName = (list: readonly TreeEntry[]): Map<string, TreeEntry> => new Map(list.map(e => [e.name, e]));
export function threeWay(base: readonly TreeEntry[], ours: readonly TreeEntry[], theirs: readonly TreeEntry[]): ThreeWay {
  const b = byName(base);
  const o = byName(ours);
  const t = byName(theirs);
  const names = new Set([...b.keys(), ...o.keys(), ...t.keys()]);
  const entries: TreeEntry[] = [];
  const recurse: string[] = [];
  const conflicts: string[] = [];
  const content: string[] = [];
  const deletedBoth: string[] = [];
  const addedOurs: string[] = [];
  const addedTheirs: string[] = [];
  for (const name of names) {
    const B = b.get(name);
    const O = o.get(name);
    const T = t.get(name);
    if (B && !O && !T) deletedBoth.push(name);
    if (!B && O) addedOurs.push(name);
    if (!B && T) addedTheirs.push(name);
    if (same(O, T) || same(B, T)) { if (O) entries.push(O); }
    else if (same(B, O)) { if (T) entries.push(T); }
    else if (recurses(O, T)) recurse.push(name);
    else if (isFile(B) && isFile(O) && isFile(T)) content.push(name);
    else conflicts.push(name);
  }
  return { entries, recurse, conflicts, content, deletedBoth, addedOurs, addedTheirs };
}

// Pure: git's mode merge for a regular file both sides touched: equal → that; one side unchanged → the other's.
export const mergeMode = (b: string, o: string, t: string): string | null => {
  if (o === t || b === t) return o;
  if (b === o) return t;
  return null;
};

// Pure: git's merge bases — the best common ancestors of `a` and `b` (common ancestors that are not ancestors of another
// common ancestor; git merge-base --all), over the commits known so far (oid → { parents }). A commit named as a parent
// but not in the map is a cut: its ancestry is unknown. `truncated` says the answer may change once the cuts are fetched:
//   - a cut reachable from a or b outside the settled region (common ancestors and everything below them) may hide a
//     best base — any best base outside what we know is an ancestor of a or b that is not an ancestor of a known common
//     ancestor, so it lies beyond exactly such a cut;
//   - with more than one best base, a cut inside the settled region may hide that one of them is an ancestor of
//     another (through the cut), so the set would shrink: {c, z} where z is below c through a cut x is not criss-cross,
//     it is {c} (#42). Only a cut that some best base reaches and another does not can do that: z below c through a
//     cut k means k is an ancestor of c and z an ancestor of k, so k cannot also be an ancestor of z (a cycle). A cut
//     every best base reaches (deep shared history under a true criss-cross) changes nothing, and deepening for it
//     would walk to the root or the cap (limit_exceeded where git answers two bases).
// A single best base over a graph whose only cuts are settled is final, and the rule says so without a special case:
// every settled commit is the base or below it, so the one base reaches every settled cut.
// A6 pass: Verdict = final{best} | needMore{reason, cuts} | capped.
export type Parents = { readonly parents: readonly string[] };
export function bestBases(commits: ReadonlyMap<string, Parents>, a: string, b: string): { best: string[]; truncated: boolean } {
  const closure = (starts: readonly string[]): Set<string> => { const seen = new Set<string>(); const st = [...starts]; for (let c = st.pop(); c !== undefined; c = st.pop()) { if (seen.has(c)) continue; seen.add(c); for (const p of commits.get(c)?.parents ?? []) st.push(p); } return seen; };
  const A = closure([a]);
  const B = closure([b]);
  const common = [...A].filter(c => B.has(c));
  const below = closure(common.flatMap(c => commits.get(c)?.parents ?? [])); // proper ancestors of common ancestors
  const best = common.filter(c => !below.has(c)).toSorted();
  const settled = new Set([...common, ...below]);
  const frontier = (start: string): boolean => { const seen = new Set<string>(); const st = [start]; for (let c = st.pop(); c !== undefined; c = st.pop()) { if (seen.has(c) || settled.has(c)) continue; seen.add(c); const k = commits.get(c); if (!k) return true; for (const p of k.parents) st.push(p); } return false; };
  const cutBetween = (): boolean => {
    const reach = best.map(c => closure([c]));
    for (const k of settled) if (!commits.has(k) && reach.some(r => !r.has(k))) return true;
    return false;
  };
  return { best, truncated: frontier(a) || frontier(b) || cutBetween() };
}

// Effect: ancestors of `head` as oid → distance, via commit-only packs (tree:0 keeps trees and blobs out) of doubling depth.
// The pack is held to the deepen contract (shallow-info, protocol v2): `head` is in it as a commit, every commit in it is
// an ancestor of `head` through it, and a commit whose parent it lacks is one the server named `shallow`. Commits are
// hash-verified, so ancestry cannot be forged, only withheld; a server that withholds it without saying so would make
// bestBases answer over a cut graph that looks whole (#18), so that is `pack_corrupt` here. git's upload-pack keeps the
// contract (the boundary of the depth and of a shallow server repository are both reported).
export type Ancestors = { readonly dist: Map<string, number>; readonly commits: Map<string, Commit>; readonly complete: boolean };
type Tree0Pack = { readonly objects?: ReadonlyMap<string, { readonly type: number; readonly data: Uint8Array }> | null; readonly shallow: readonly string[] };
export async function ancestors(t: Transport, head: string, depth: number): Promise<Ancestors> {
  const r: Tree0Pack = await fetchPackTree0(t, { wants: [head], filter: 'tree:0', deepen: depth });
  const commits = new Map<string, Commit>(); for (const [oid, o] of r.objects ?? []) if (o.type === TYPE.COMMIT) commits.set(oid, parseCommit(o.data, t.limits));
  if (!commits.has(head)) throw fail('pack_corrupt', `commit ${head} not in the pack that wanted it`);
  const dist = new Map([[head, 0]]); const q = [head];
  // q grows while it is walked: a breadth-first queue
  for (const c of q) { const d = dist.get(c) ?? 0; for (const p of commits.get(c)?.parents ?? []) if (!dist.has(p)) { dist.set(p, d + 1); q.push(p); } }
  const shallow = new Set(r.shallow);
  for (const [oid, c] of commits) {
    if (!dist.has(oid)) throw fail('pack_corrupt', `commit ${oid} sent but not an ancestor of ${head}`);
    const missing = shallow.has(oid) ? undefined : c.parents.find(p => !commits.has(p));
    if (missing !== undefined) throw fail('pack_corrupt', `parent ${missing} of ${oid} withheld and ${oid} not reported shallow`);
  }
  return { dist, commits, complete: r.shallow.length === 0 }; // no shallow boundary reported → the whole history fit in the depth
}

export type MergeBase = { readonly base: string | null; readonly bases: string[]; readonly depth: number; readonly commits: Map<string, Commit> };
export async function mergeBase(t: Transport, a: string, b: string, { maxDepth }: { readonly maxDepth?: number } = {}): Promise<MergeBase> {
  const cap = maxDepth === undefined ? requireLimit(t.limits, 'maxMergeDepth') : finiteLimit(maxDepth, 'maxMergeDepth');
  for (let depth = 8; depth <= cap; depth *= 2) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each round deepens from what the last one found
    const [A, B] = await Promise.all([ancestors(t, a, depth), ancestors(t, b, depth)]);
    const commits = new Map([...B.commits, ...A.commits]);
    const { best, truncated } = bestBases(commits, a, b);
    // Only a graph with no unexplored ancestry is an answer. Both sides complete and still truncated cannot happen now
    // (ancestors refuses a parent withheld without a shallow line); it used to be accepted (#18).
    if (!truncated) return { base: best.length === 1 ? best[0] ?? null : null, bases: best, depth, commits };
  }
  throw limitError('merge-base search depth', cap, cap);
}

const has = (list: readonly TreeEntry[], name: string): boolean => list.some(e => e.name === name);
const subtree = (e: Entry): string | null => (e?.mode === '40000' ? e.oid : null);
type ReadTree = (oid: string | null | undefined) => Promise<readonly TreeEntry[]>;
// Effect: the paths `side` adds relative to `base` (both tree oids), recursing only into differing subtrees; a directory
// new on `side` is one entry, 'dir/', standing for everything inside it.
async function addedPaths(read: ReadTree, base: string | null | undefined, side: string | null | undefined, prefix = ''): Promise<string[]> {
  if (base === side) return [];
  const [B, S] = await Promise.all([read(base), read(side)]);
  const b = byName(B); const out: string[] = [];
  for (const e of S) {
    const old = b.get(e.name);
    if (!old) out.push(prefix + e.name + (isTree(e) ? '/' : ''));
    // oxlint-disable-next-line eslint/no-await-in-loop -- one subtree at a time, as before
    else if (isTree(e) && isTree(old) && old.oid !== e.oid) out.push(...await addedPaths(read, old.oid, e.oid, `${prefix}${e.name}/`));
    else if (isTree(e) !== isTree(old)) out.push(prefix + e.name + (isTree(e) ? '/' : ''));
  }
  return out;
}

export type DriverFor = (path: string) => Promise<Driver>;
export type BlobSpec = { readonly base: string; readonly ours: string; readonly theirs: string; readonly path: string; readonly driverFor?: DriverFor | null };
export type BlobMerge = { readonly oid: string; readonly data?: Uint8Array; readonly reason?: never } | { readonly conflict: true; readonly reason: string };
export type MergeStats = { merged: number; undecided: number; unioned: number; attrBinary: number };
export type MergeBlob = ((spec: BlobSpec) => Promise<BlobMerge>) & { stats: MergeStats };
export type Removed = 'ours' | 'theirs' | null;
export type MergeTreesSpec = {
  readonly base?: string | null | undefined;
  readonly ours?: string | null | undefined;
  readonly theirs?: string | null | undefined;
  readonly prefix?: string;
  readonly removed?: Removed;
  readonly mergeBlob?: MergeBlob | null;
  readonly driverFor?: DriverFor | null;
};
// The accumulator one merge shares across its recursion. reasons is keyed by path and has no prototype.
// A6 pass: ConflictReason union and Map<Path, ConflictReason>.
export type MergeAcc = {
  objects: PackObject[];
  conflicts: string[];
  fetched: number;
  deletedBoth: string[];
  dirAdds: string[];
  reasons: Record<string, string>;
  contentMerged: number;
  deletedOne?: boolean;
};
export type MergeTreesResult = MergeAcc & { readonly oid: string | null };

// Effect: merge three trees (by oid, any may be null = empty) into a new tree, returning its oid, the new objects to push
// and conflicts as paths. Fetches only directories where the sides differ; `cache` is the oid → bytes tree cache.
// `mergeBlob(base, ours, theirs, path)` resolves a path both sides changed (line merge); without it such paths conflict.
//
// Rename guards. merge-ort detects renames (and directory renames, as conflicts); we do not. Two shapes are where a
// rename could make git conflict while a rename-blind merge is clean, so they are conflicts here (superset of git's):
//   G1  a path deleted on both sides while either side adds a path   (rename/rename(1to2), rename/delete) — the deleted
//       paths and the added ones are reported, since git names the conflict at the rename target
//   (G2's target is a path git computes from the directory rename; we report the added path and the reason.)
//   G2  a directory one side removed entirely, the other side adds inside it   (directory rename + add)
// A rename on one side with the other side untouched merges exactly as git does.
/* oxlint-disable eslint/no-await-in-loop, eslint/complexity -- one path at a time (the merges share `out`, the cache and the fetch budget); the A6 pass splits planDir and the rename guards out */
export async function mergeTrees(t: Transport, cache: TreeCache, { base, ours, theirs, prefix = '', removed = null, mergeBlob = null, driverFor = null }: MergeTreesSpec, into: MergeAcc | null = null): Promise<MergeTreesResult> {
  const top = into === null;
  // reasons is keyed by path, so it has no prototype: a path named `__proto__` or `constructor` is recorded like any other
  const out: MergeAcc = into ?? { objects: [], conflicts: [], fetched: 0, deletedBoth: [], dirAdds: [], reasons: Object.create(null), contentMerged: 0 };
  const read: ReadTree = async oid => { if (oid === null || oid === undefined) return EMPTY; let data = cache.get(oid); if (!data) { data = (await fetchObj(t, { oid, expectType: TYPE.TREE })).data; cache.set(oid, data); out.fetched++; } return parseTree(data, t.limits); };
  const [B, O, T] = await Promise.all([read(base), read(ours), read(theirs)]);
  const r = threeWay(B, O, T);
  const { entries } = r;
  for (const name of r.conflicts) { out.conflicts.push(prefix + name); out.reasons[prefix + name] = 'tree'; }
  if (r.conflicts.some(name => has(B, name) && !(has(O, name) && has(T, name)))) out.deletedOne = true; // modify/delete
  for (const name of r.deletedBoth) out.deletedBoth.push(prefix + name);
  if (removed === 'ours') for (const name of r.addedTheirs) out.dirAdds.push(prefix + name);
  if (removed === 'theirs') for (const name of r.addedOurs) out.dirAdds.push(prefix + name);
  // Names are the repository's: a Map, so a directory called `constructor` or `__proto__` is not Object.prototype's
  const b = byName(B);
  const o = byName(O);
  const th = byName(T);
  for (const name of r.content) {
    // content names are files on all three sides (threeWay)
    const eb = b.get(name);
    const eo = o.get(name);
    const et = th.get(name);
    if (!eb || !eo || !et) continue;
    const mode = mergeMode(eb.mode, eo.mode, et.mode);
    const blob = mode === null || !mergeBlob ? null : await mergeBlob({ base: eb.oid, ours: eo.oid, theirs: et.oid, path: prefix + name, driverFor });
    if (mode === null || blob === null || 'conflict' in blob) { out.conflicts.push(prefix + name); out.reasons[prefix + name] = mode === null ? 'mode' : blob?.reason ?? 'content'; continue; }
    entries.push({ mode, name, oid: blob.oid });
    if (blob.data) out.objects.push({ type: TYPE.BLOB, data: blob.data, oid: blob.oid });
    out.contentMerged++;
  }
  for (const name of r.recurse) {
    let sideRemoved = removed;
    if (sideRemoved === null && b.get(name)?.mode === '40000') { if (!o.has(name)) sideRemoved = 'ours'; else if (!th.has(name)) sideRemoved = 'theirs'; }
    const sub = await mergeTrees(t, cache, { base: subtree(b.get(name)), ours: subtree(o.get(name)), theirs: subtree(th.get(name)), prefix: `${prefix}${name}/`, removed: sideRemoved, mergeBlob, driverFor }, out);
    if (sub.oid !== null) entries.push({ mode: '40000', name, oid: sub.oid }); // an empty merged subtree drops the directory, as git does
  }
  if (top) for (const p of out.dirAdds) if (!(p in out.reasons)) { out.conflicts.push(p); out.reasons[p] = 'possible directory rename (added inside a directory the other side removed)'; }
  // deletedOne is set only beside a conflict
  if (top && (out.deletedBoth.length > 0 || out.deletedOne === true)) {
    // Every path either side added, across the whole tree — the walk above skips directories only one side changed, and a
    // rename target can be anywhere. Fetched only when a deletion is in play.
    const added = [...new Set([...await addedPaths(read, base, ours), ...await addedPaths(read, base, theirs)])];
    if (added.length > 0) for (const p of out.deletedBoth) { out.conflicts.push(p); out.reasons[p] = 'possible rename source (deleted on both sides while paths were added; ply does not detect renames)'; }
    // Naming: git reports a rename's conflict at the rename target (rename/delete, rename/rename, or a content conflict
    // after following a rename onto a modify/delete). When this merge conflicts with a deletion in play, every added path
    // is a possible target, so it is listed too. This adds names to a conflicting merge; it never makes one conflict.
    if (out.conflicts.length > 0) for (const p of added) if (!(p in out.reasons)) { out.conflicts.push(p); out.reasons[p] = 'possible rename target (added while the merge has a deletion conflict)'; }
  }
  if (out.conflicts.length > 0 || entries.length === 0) return { oid: null, ...out };
  const data: Uint8Array = encodeTree(entries);
  const oid: string = hashObject('tree', data);
  if (oid !== ours && oid !== theirs && oid !== base) out.objects.push({ type: TYPE.TREE, data, oid });
  cache.set(oid, data);
  return { oid, ...out };
}
/* oxlint-enable eslint/no-await-in-loop, eslint/complexity */

// Effect: the merge driver for a path from the .gitattributes files of one tree (git's attr.tree / --attr-source, or the
// worktree's — which is ours — for a non-bare `git merge`). Reads only the directories on the path, each once; returns
// 'text' | 'union' | 'binary' as find_ll_merge_driver picks: merge set → text, -merge → binary, merge=binary|union|text
// → that, any other name → text (a custom driver is server configuration we cannot see), unspecified → text.
export function attributeDrivers(t: Transport, cache: TreeCache, treeOid: string): DriverFor {
  const readTree = async (oid: string): Promise<TreeEntry[]> => { let data = cache.get(oid); if (!data) { data = (await fetchObj(t, { oid, expectType: TYPE.TREE })).data; cache.set(oid, data); } return parseTree(data, t.limits); };
  const dirTree = new Map<string, Promise<string | null>>([['', Promise.resolve(treeOid)]]);
  const files = new Map<string, Promise<string | null>>();
  const treeOf = (dir: string): Promise<string | null> => {
    let tree = dirTree.get(dir);
    if (!tree) {
      const cut = dir.lastIndexOf('/');
      const parent = cut < 0 ? '' : dir.slice(0, cut);
      const name = dir.slice(cut + 1);
      tree = treeOf(parent).then(async p => (p === null ? null : (await readTree(p)).find(e => e.name === name && e.mode === '40000')?.oid ?? null));
      dirTree.set(dir, tree);
    }
    return tree;
  };
  const fileOf = (dir: string): Promise<string | null> => {
    let file = files.get(dir);
    if (!file) {
      file = treeOf(dir).then(async oid => {
        const e = oid === null ? null : (await readTree(oid)).find(x => x.name === '.gitattributes' && x.mode !== '40000' && x.mode !== '160000');
        return e ? bytesToStr((await fetchObj(t, { oid: e.oid, expectType: TYPE.BLOB })).data) : null;
      });
      files.set(dir, file);
    }
    return file;
  };
  return async path => {
    const dirs = ['']; for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) dirs.push(path.slice(0, i));
    const texts = await Promise.all(dirs.map(d => fileOf(d)));
    const byDir = new Map<string, string>();
    for (const [i, d] of dirs.entries()) { const text = texts[i]; if (text !== null && text !== undefined) byDir.set(utf8ToStr(d), text); }
    const v = attributesFor(utf8ToStr(path), byDir).get('merge');
    if (v === false) return 'binary';
    if (v === 'binary' || v === 'union') return v;
    return 'text';
  };
}

// A thrown value, read loosely for its code (as errors.ts's retryPolicy reads one).
type Loose = { readonly code?: unknown } | null | undefined;

// Effect: the content half of a both-sides-changed file — git's shortcuts first (one side equal to base or both equal),
// then the three blobs (bounded by limits.maxMergeBlobBytes) through the ported xdiff merge. Returns { oid, data? } or
// { conflict: true, reason }. Shared by merge, rebase, cherry-pick and revert.
export function blobMerger(t: Transport, { maxMergeBlobBytes = LIMIT_MERGE_BLOB, rediff = 'myers', stats = { merged: 0, undecided: 0, unioned: 0, attrBinary: 0 } }: { readonly maxMergeBlobBytes?: number; readonly rediff?: Rediff; readonly stats?: MergeStats } = {}): MergeBlob {
  if (!['undecided', 'skip', 'myers'].includes(rediff)) throw fail('bad_request', `rediff must be 'undecided', 'skip' or 'myers', not ${JSON.stringify(rediff)}`);
  const blobCap = finiteLimit(maxMergeBlobBytes, 'maxMergeBlobBytes');
  const objectCap = requireLimit(t.limits, 'maxObjectSize');
  const bounded: Transport = Object.create(t, { limits: { value: { ...t.limits, maxObjectSize: Math.min(objectCap, blobCap) } } });
  // Blobs this merger produced exist only in the pending push (a rebase replays commit 2 onto commit 1's merged blob), so
  // they are served from here; the bytes are already held for the push, so this costs no extra memory.
  const made = new Map<string, Uint8Array>();
  const get = async (oid: string): Promise<Uint8Array> => made.get(oid) ?? (await fetchObj(bounded, { oid, expectType: TYPE.BLOB })).data;
  const f = async ({ base, ours, theirs, path, driverFor = null }: BlobSpec): Promise<BlobMerge> => {
    if (ours === theirs || theirs === base) return { oid: ours };
    if (ours === base) return { oid: theirs };
    // the merge attribute (when an attribute source was given): binary/-merge conflicts without reading the blobs
    const driver = driverFor ? await driverFor(path) : 'text';
    if (driver === 'binary') { stats.attrBinary++; return { conflict: true, reason: 'binary (merge attribute)' }; }
    let B: Uint8Array;
    let O: Uint8Array;
    let T: Uint8Array;
    try { [B, O, T] = await Promise.all([get(base), get(ours), get(theirs)]); }
    catch (error) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see Loose
      if ((error as Loose)?.code === 'limit_exceeded') return { conflict: true, reason: 'too large to merge' };
      throw error;
    }
    const m = mergeLines(B, O, T, { maxBytes: blobCap, rediff, driver });
    if (!m.clean) {
      if (m.reason === 'undecided') { stats.undecided++; return { conflict: true, reason: 'content (git would decide this with a classic-diff fallback ply does not implement)' }; }
      return { conflict: true, reason: m.reason === 'content' ? 'content (both sides changed the same lines)' : m.reason };
    }
    stats.merged++; if ('unioned' in m) stats.unioned++;
    const oid: string = hashObject('blob', m.data); made.set(oid, m.data);
    return { oid, data: m.data };
  };
  f.stats = stats;
  return f;
}

// Pure: one entry per oid, first wins. git's unpack-objects/index-pack refuse a pack that carries an object twice
// ("tried to add buffer twice"), and a merge produces the same blob or tree at two paths, or in two replayed commits.
// the set grows exactly when the oid is new
export const uniqueObjects = <O extends { readonly oid: string }>(objects: readonly O[]): O[] => { const seen = new Set<string>(); return objects.filter(o => seen.size < seen.add(o.oid).size); };

// Effect: the tree whose .gitattributes govern a merge. null → none (git ≥ 2.46 in a bare repository, unless attr.tree
// is set); 'ours' | 'theirs' | 'base' → that side's tree ('ours' is what `git merge` in a worktree reads, and git
// 2.43–2.45 in a bare repository whose HEAD is the target branch); a ref name or commit oid → its tree (attr.tree=<rev>).
// 'ours' | 'theirs' | 'base', a ref name or a commit oid, or null
export type AttributeSource = string | null;
export const validateAttributes = (a: unknown): void => {
  if (a === null || a === undefined) return;
  if (typeof a !== 'string') throw fail('bad_request', 'attributes must be null, ours, theirs, base, a ref or a commit oid');
  if (a === 'ours' || a === 'theirs' || a === 'base' || /^[0-9a-f]{40}$/u.test(a)) return;
  validateRef(a);
};
export type Trees = { readonly base?: string | null | undefined; readonly ours?: string | null | undefined; readonly theirs?: string | null | undefined };
export async function attributeTree(t: Transport, attributes: AttributeSource | undefined, trees: Trees): Promise<string | null> {
  if (attributes === null || attributes === undefined) return null;
  if (attributes === 'ours' || attributes === 'theirs' || attributes === 'base') return trees[attributes] ?? null;
  if (typeof attributes !== 'string') throw fail('bad_request', 'attributes must be null, ours, theirs, base, a ref or a commit oid');
  let oid: string | undefined = attributes;
  if (!/^[0-9a-f]{40}$/u.test(attributes)) {
    validateRef(attributes);
    const refs: Refs = await lsRefs(t, [attributes]);
    oid = refs.refs.get(attributes)?.oid;
    if (oid === undefined) throw fail('not_found', `attributes ref ${attributes} not found`);
  }
  return parseCommit((await fetchObj(t, { oid, expectType: TYPE.COMMIT, deepen: 1 })).data, t.limits).tree;
}

// Fast-forward `ref` to `to`, expecting it to be at `from` (CAS). Empty pack: the server already has the objects.
export async function fastForward(t: Transport, { ref, from, to }: { readonly ref: string; readonly from: string; readonly to: string }): Promise<PushResult> {
  return pushRef(t, { ref, oldOid: from, newOid: to, objects: [] });
}

export async function deleteBranch(t: Transport, { ref, oid }: { readonly ref: string; readonly oid: string }): Promise<PushResult> {
  return pushRef(t, { ref, oldOid: oid, newOid: ZERO_OID, objects: [] });
}

export type MergeSpec = {
  readonly ref?: string;
  readonly from: string;
  readonly author?: Author | null;
  readonly message?: string | null;
  readonly time?: number;
  readonly fastForwardOnly?: boolean;
  readonly noFastForward?: boolean;
};
// The operation options (auth, tracer, limits, …) pass through to operation(); these are the ones merge reads.
export type MergeOptions = {
  readonly cache?: TreeCache;
  readonly signer?: Signer | null;
  readonly verify?: boolean;
  readonly rediff?: Rediff;
  readonly attributes?: AttributeSource;
  readonly [option: string]: unknown;
};
type Sides = { readonly ref: string; readonly oid: string; readonly ours: string; readonly theirs: string };
export type MergeOutcome =
  | Sides & { readonly outcome: 'up_to_date' | 'fast_forward'; readonly base: string }
  | Sides & { readonly outcome: 'merge'; readonly tree: string; readonly base: string; readonly pushBytes: number; readonly newTrees: number; readonly contentMerged: number };

/* oxlint-disable eslint/complexity -- one operation's steps in order; A6 splits out decideMerge */
export async function mergeBranch(url: string, { ref = 'refs/heads/main', from, author, message, time = Math.floor(Date.now() / 1000), fastForwardOnly = false, noFastForward = false }: MergeSpec, { cache = new Map(), signer = null, verify = false, rediff = 'myers', attributes = null, ...opts }: MergeOptions = {}): Promise<MergeOutcome> {
  validatePushRef(ref, false); validateRef(from);
  const person: ValidatedIdent | null = author ? validateIdent({ name: author.name, email: author.email, time, tz: author.tz }) : null;
  if (message !== undefined && message !== null) validateMessage(message); validateAttributes(attributes);
  return runOp('merge', url, { ...opts, attrs: { 'git.merge.ref': ref, 'git.merge.from': from, 'git.merge.ff_only': fastForwardOnly, 'git.merge.no_ff': noFastForward } }, async ({ t, root, outcome }: OpContext): Promise<MergeOutcome> => {
    const { refs }: Refs = await lsRefs(t, [ref, from]);
    const ours = refs.get(ref)?.oid;
    const theirs = refs.get(from)?.oid;
    if (ours === undefined) throw fail('not_found', `ref ${ref} not found`); if (theirs === undefined) throw fail('not_found', `ref ${from} not found`);
    // ls-refs names an annotated tag's object, not a commit; `git merge <tag>` records the tag in a mergetag header, which
    // ply does not write. Refused by name (it read as a missing commit, pack_corrupt, before #43's matrix ran it).
    for (const r of [ref, from]) { const peeled = refs.get(r)?.peeled; if (peeled !== undefined) throw fail('unsupported', `${r} is an annotated tag (git merge writes a mergetag header ply does not); merge its commit ${peeled}`, { what: r === ref ? 'ref' : 'from' }); }
    root.set({ 'git.merge.ours': ours, 'git.merge.theirs': theirs });
    if (ours === theirs) return outcome('up_to_date', { outcome: 'up_to_date', ref, oid: ours, ours, theirs, base: ours });
    const { base, bases, depth } = await mergeBase(t, ours, theirs);
    root.set({ 'git.merge.base': base ?? '', 'git.merge.bases': bases.length, 'git.merge.base.depth': depth });
    // criss-cross history: git merges the bases into a virtual one (merge-ort, recursively); a single base can give a clean
    // result that differs from git's, so we refuse rather than guess. A6 pass: reasons and bases belong in Detail.
    const crissCross = { conflicts: [], reasons: Object.create(null), bases };
    if (bases.length > 1) throw fail('merge_conflict', `${ref} and ${from} have ${bases.length} merge bases (criss-cross history); ply does not build git's virtual merge base`, crissCross);
    // base is null exactly when there is not one merge base; with more than one refused above, there are none
    if (base === null) throw fail('unrelated_histories', `${ref} and ${from} share no common ancestor within the search depth`);
    if (base === theirs) return outcome('up_to_date', { outcome: 'up_to_date', ref, oid: ours, ours, theirs, base });
    if (base === ours && !noFastForward) {
      const r = await fastForward(t, { ref, from: ours, to: theirs });
      return outcome('fast_forward', { outcome: 'fast_forward', ref, oid: theirs, ours, theirs, base }, { 'git.merge.push.bytes': r.packBytes });
    }
    if (fastForwardOnly) throw fail('not_fast_forward', `${ref} has moved past the merge base; a merge commit would be needed`);
    // three-way: commits for the three trees (the commit-only packs from mergeBase did not carry trees)
    const [cB, cO, cT]: Array<{ readonly data: Uint8Array }> = await Promise.all([base, ours, theirs].map(oid => fetchObj(t, { oid, expectType: TYPE.COMMIT, deepen: 1 })));
    const tree = (c: { readonly data: Uint8Array } | undefined): string => parseCommit(c?.data ?? new Uint8Array(0), t.limits).tree;
    const trees = { base: tree(cB), ours: tree(cO), theirs: tree(cT) };
    const mergeBlob = blobMerger(t, { maxMergeBlobBytes: requireLimit(t.limits, 'maxMergeBlobBytes'), rediff });
    const attrTree = await attributeTree(t, attributes, trees);
    root.set({ 'git.merge.attributes': attributes ?? '' });
    const merged = await mergeTrees(t, cache, { ...trees, mergeBlob, driverFor: attrTree === null ? null : attributeDrivers(t, cache, attrTree) });
    root.set({ 'git.merge.content.merged': merged.contentMerged, 'git.merge.content.undecided': mergeBlob.stats.undecided, 'git.merge.content.unioned': mergeBlob.stats.unioned, 'git.merge.content.attr_binary': mergeBlob.stats.attrBinary, 'git.merge.trees.fetched': merged.fetched, 'git.merge.trees.new': merged.objects.filter(o => o.type === TYPE.TREE).length, 'git.merge.conflicts': merged.conflicts.slice(0, 64), 'git.merge.conflicts.count': merged.conflicts.length });
    const conflicted = { conflicts: merged.conflicts, reasons: merged.reasons };
    if (merged.conflicts.length > 0) throw fail('merge_conflict', `conflicts: ${merged.conflicts.slice(0, 8).map(p => `${p} (${merged.reasons[p]})`).join(', ')}${merged.conflicts.length > 8 ? '…' : ''}`, conflicted);
    const treeOid: string = merged.oid ?? hashObject('tree', encodeTree([]));
    if (!person) throw fail('bad_request', 'author is required for a merge commit');
    const who: string = ident(person);
    let commitData = commitBytes({ tree: treeOid, parents: [ours, theirs], author: who, committer: who, message: (message ?? `Merge ${from.replace(/^refs\/heads\//u, '')} into ${ref.replace(/^refs\/heads\//u, '')}`).replace(/\n?$/u, '\n') });
    if (signer) commitData = await signCommit(commitData, signer);
    const oid: string = hashObject('commit', commitData);
    const objects = uniqueObjects([{ type: TYPE.COMMIT, data: commitData, oid }, ...(merged.oid === null ? [{ type: TYPE.TREE, data: encodeTree([]), oid: treeOid }] : []), ...merged.objects]).map(o => ({ type: o.type, data: o.data }));
    const r = await pushRef(t, { ref, oldOid: ours, newOid: oid, objects });
    if (verify) await verifyRef(t, root, 'git.merge', ref, oid);
    return outcome('merge', { outcome: 'merge', ref, oid, tree: treeOid, ours, theirs, base, pushBytes: r.packBytes, newTrees: merged.objects.filter(o => o.type === TYPE.TREE).length, contentMerged: merged.contentMerged }, { 'git.merge.commit': oid, 'git.merge.tree': treeOid, 'git.merge.push.bytes': r.packBytes });
  });
}
/* oxlint-enable eslint/complexity */
