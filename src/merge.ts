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
// The pure parts: decidePath / threeWay (one directory), mergeMode, bestBases (git merge-base --all over known commits),
// searchStep (the merge-base search's transition), decideMerge (what a verdict means for the branch), uniqueObjects;
// linemerge.js. The effects: lsRefs, fetchObject, push. Every step that can fail returns a Result, the entry points
// (mergeBranch, mergeBase, mergeTrees, attributeTree) included.
/* oxlint-disable import/max-dependencies -- a merge drives ls-refs, fetch, push, the object codecs and the line merge */
/* oxlint-disable eslint/require-await, typescript/promise-function-async -- each function keeps its async-ness (a sync throw stays sync); together the two rules forbid a function that forwards a promise */
import type { ValidatedIdent } from './validate.js';
import type { Limits } from './limits.js';
import type { Driver, Rediff } from './linemerge.js';
import type { ErrorOf, Extra, Miss, PlyError } from './errors.js';
import type { Err, Ok, Option, Result } from './result.js';
import type { Input } from './absent.js';
import type { LsRefsResult } from './lsrefs.js';
import type { OperationOpts, Outcome } from './operation.js';
import { fail } from './errors.js';
import { andThen, assertNever, err, getOrElse, isNone, isSome, map, mapOption, none, ok, some } from './result.js';
import { at, fromNullable, fromNullish, mapGet, withDefaults } from './absent.js';
import { lsRefs } from './lsrefs.js';
import { fetchObject } from './fetch.js';
import { fetchPackTree0 } from './fetchpack.js';
import { push, ZERO_OID } from './push.js';
import { operation, verifyRef } from './operation.js';
import { parseTree, encodeTree, parseCommit, encodeCommit, hashObject, ident, TYPE } from './objects.js';
import { validateRef, validatePushRef, validateMessage } from './validate.js';
import { signCommit } from './sign.js';
import { mergeLines } from './linemerge.js';
import { attributeOf, attributesFor, bytesToStr, popLast, utf8ToStr } from './attributes.js';
import { short, commitAt, commitBytesAt, isOid, givenOid, assertCommit, stamp } from './mergeio.js';
import { checkLimit, limitError, readLimit } from './limits.js';

// A merge_conflict's payload: Detail carries `conflicts`; reasons and bases are extras (errors.ts is shared; additive
// detail is the steward's call).
type ConflictDetail = Extra & { readonly conflicts: readonly string[] };

// The shapes this module reads from other modules (objects, transport, operation, push, ls-refs); their own modules
// own the full types.
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
export type { Outcome } from './operation.js';
export type OpContext = { readonly t: Transport; readonly root: Span; readonly outcome: Outcome; readonly limits: Limits };
export type PushResult = { readonly packBytes: number };
// a commit stamp: `time` (unix seconds) defaults to the operation's `time`, `tz` (+HHMM / -HHMM) to +0000
export type Author = { readonly name: string; readonly email: string } & Input<{ readonly tz: string; readonly time: number }>;
// a commit signer (src/sign.ts); re-exported for rebase.ts
export type { Signer } from './sign.js';
import type { Signer } from './sign.js';
export type TreeCache = Map<string, Uint8Array>;
export type PushObject = { readonly type: number; readonly data: Uint8Array };


const EMPTY: readonly TreeEntry[] = [];
const NO_PARENTS: readonly string[] = [];
const isTreeEntry = (e: TreeEntry): boolean => e.mode === '40000';
// An entry absent on a side is None.
type Entry = Option<TreeEntry>;
const same = (a: Entry, b: Entry): boolean => (a.tag === 'none' || b.tag === 'none' ? a.tag === b.tag : a.value.mode === b.value.mode && a.value.oid === b.value.oid);
const isTree = (e: Entry): boolean => e.tag === 'some' && isTreeEntry(e.value);
const isFile = (e: Entry): boolean => e.tag === 'some' && (e.value.mode === '100644' || e.value.mode === '100755');
// directory vs directory, or a directory one side deleted/added: recurse so the conflict (if any) is per file,
// and untouched files inside a directory the other side deleted go away, as git does
const treeish = (e: Entry): boolean => e.tag === 'none' || isTree(e);
const recurses = (O: Entry, T: Entry): boolean => treeish(O) && treeish(T) && (isTree(O) || isTree(T));
const byName = (list: readonly TreeEntry[]): Map<string, TreeEntry> => new Map(list.map(e => [e.name, e]));

// Pure: what a three-way merge does with one name of a directory, git's trivial-merge rules at tree level: same on both
// sides → that; unchanged on one side → the other side's (an absent result drops the name); both trees → recurse; both
// regular files changed differently over a regular base → content (a line merge may resolve it); otherwise → conflict.
export type PathDecision =
  | { readonly kind: 'take'; readonly entry: TreeEntry }
  | { readonly kind: 'drop' }
  | { readonly kind: 'recurse' }
  | { readonly kind: 'content' }
  | { readonly kind: 'conflict' };
const DROP: PathDecision = { kind: 'drop' };
const RECURSE: PathDecision = { kind: 'recurse' };
const CONTENT: PathDecision = { kind: 'content' };
const CONFLICT: PathDecision = { kind: 'conflict' };
const taken = (e: Entry): PathDecision => (e.tag === 'some' ? { kind: 'take', entry: e.value } : DROP);
function decidePath(B: Entry, O: Entry, T: Entry): PathDecision {
  if (same(O, T) || same(B, T)) return taken(O);
  if (same(B, O)) return taken(T);
  if (recurses(O, T)) return RECURSE;
  if (isFile(B) && isFile(O) && isFile(T)) return CONTENT;
  return CONFLICT;
}

// Pure: three-way merge of one directory's entries, as lists by decision: { entries (resolved, in no particular order),
// recurse: [name], conflicts: [name], content: [name], deletedBoth, addedOurs, addedTheirs }. The deleted/added lists
// feed the rename guards in mergeTrees.
export type ThreeWay = {
  readonly entries: TreeEntry[];
  readonly recurse: string[];
  readonly conflicts: string[];
  readonly content: string[];
  readonly deletedBoth: string[];
  readonly addedOurs: string[];
  readonly addedTheirs: string[];
};
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
    const B = mapGet(b, name);
    const O = mapGet(o, name);
    const T = mapGet(t, name);
    if (B.tag === 'some' && O.tag === 'none' && T.tag === 'none') deletedBoth.push(name);
    if (B.tag === 'none' && O.tag === 'some') addedOurs.push(name);
    if (B.tag === 'none' && T.tag === 'some') addedTheirs.push(name);
    const d = decidePath(B, O, T);
    switch (d.kind) {
      case 'take': entries.push(d.entry); continue;
      case 'drop': continue;
      case 'recurse': recurse.push(name); continue;
      case 'content': content.push(name); continue;
      case 'conflict': conflicts.push(name); continue;
    }
    // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
    assertNever(d);
  }
  return { entries, recurse, conflicts, content, deletedBoth, addedOurs, addedTheirs };
}

// Pure: git's mode merge for a regular file both sides touched: equal → that; one side unchanged → the other's; null:
// both changed it, differently (a conflict).
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
export type Parents = { readonly parents: readonly string[] };
// a known commit's parents; a cut has none known
const parentsIn = (commits: ReadonlyMap<string, Parents>, c: string): readonly string[] => getOrElse(mapOption(mapGet(commits, c), x => x.parents), NO_PARENTS);
export function bestBases(commits: ReadonlyMap<string, Parents>, a: string, b: string): { best: string[]; truncated: boolean } {
  // the commits reachable from `starts`, not walking into `stop` (a commit not in the map is reached, not walked)
  const closure = (starts: readonly string[], stop: ReadonlySet<string> = new Set()): Set<string> => { const seen = new Set<string>(); const st = [...starts]; for (let c = popLast(st); c.tag === 'some'; c = popLast(st)) { if (seen.has(c.value) || stop.has(c.value)) continue; seen.add(c.value); for (const p of parentsIn(commits, c.value)) st.push(p); } return seen; };
  const A = closure([a]);
  const B = closure([b]);
  const common = [...A].filter(c => B.has(c));
  const below = closure(common.flatMap(c => parentsIn(commits, c))); // proper ancestors of common ancestors
  const best = common.filter(c => !below.has(c)).toSorted();
  const settled = new Set([...common, ...below]);
  const cut = (c: string): boolean => !commits.has(c);
  // a cut reachable from a or b outside the settled region, or a settled cut some best base reaches and another does not
  const between = (): boolean => { const reach = best.map(c => closure([c])); return [...settled].some(k => cut(k) && reach.some(r => !r.has(k))); };
  return { best, truncated: [...closure([a, b], settled)].some(c => cut(c)) || between() };
}

// Effect: the ancestors of `head` within `depth`, via a commit-only pack (tree:0 keeps trees and blobs out).
// The pack is held to the deepen contract (shallow-info, protocol v2): `head` is in it as a commit, every commit in it is
// an ancestor of `head` through it, and a commit whose parent it lacks is one the server named `shallow`. Commits are
// hash-verified, so ancestry cannot be forged, only withheld; a server that withholds it without saying so would make
// bestBases answer over a cut graph that looks whole (#18), so that is `pack_corrupt` here. git's upload-pack keeps the
// contract (the boundary of the depth and of a shallow server repository are both reported).
export async function ancestors(t: Transport, head: string, depth: number): Promise<Result<Map<string, Commit>, PlyError>> {
  const got = await fetchPackTree0(t, { wants: [head], filter: 'tree:0', deepen: depth });
  if (!got.ok) return got;
  const r = got.value;
  const commits = new Map<string, Commit>();
  const objects = fromNullish(r.objects);
  if (objects.tag === 'some') for (const [oid, o] of objects.value) if (o.type === TYPE.COMMIT) { const c = parseCommit(o.data, t.limits); if (!c.ok) return c; commits.set(oid, c.value); }
  if (!commits.has(head)) return fail('pack_corrupt', `commit ${head} not in the pack that wanted it`);
  const seen = new Set([head]);
  // seen grows while it is walked: every commit reachable from head through the pack
  for (const c of seen) for (const p of parentsIn(commits, c)) seen.add(p);
  const shallow = new Set(r.shallow);
  for (const [oid, c] of commits) {
    if (!seen.has(oid)) return fail('pack_corrupt', `commit ${oid} sent but not an ancestor of ${head}`);
    const missing = shallow.has(oid) ? none : fromNullable(c.parents.find(p => !commits.has(p)));
    if (missing.tag === 'some') return fail('pack_corrupt', `parent ${missing.value} of ${oid} withheld and ${oid} not reported shallow`);
  }
  return ok(commits);
}

// The merge-base search as a machine. It starts searching a window of 8 commits a side and, while the window's graph
// is truncated (bestBases), doubles it, the last step clamped to the cap (#79: cap 100 searches 64 and then 100, not
// 64 alone). A graph that is not truncated is the verdict: one base, several (criss-cross), or none (unrelated). A
// truncated graph at the cap is `capped`: limit_exceeded, never an answer over a cut graph. `searchStep` is pure; the
// driver in mergeBase is the only part that fetches.
export type Search =
  | { readonly tag: 'searching'; readonly depth: number }
  | { readonly tag: 'found'; readonly depth: number; readonly base: string; readonly bases: string[] }
  | { readonly tag: 'criss-cross'; readonly depth: number; readonly bases: string[] }
  | { readonly tag: 'unrelated'; readonly depth: number; readonly bases: string[] }
  | { readonly tag: 'capped'; readonly depth: number };
export type Verdict = Extract<Search, { readonly tag: 'found' | 'criss-cross' | 'unrelated' }>;
// `depth` is the window searched (commits a side, the tip at 1); `cap` counts whole commits (mergeBase rounds a limit
// down); bases is git merge-base --all on every verdict. The first state is searching(min(8, cap)); a cap under 1 is
// capped before any search.
export function searchStep(depth: number, cap: number, commits: ReadonlyMap<string, Parents>, a: string, b: string): Search {
  const { best, truncated } = bestBases(commits, a, b);
  // Both sides complete and still truncated cannot happen (ancestors refuses a parent withheld without a shallow line);
  // it used to be accepted (#18).
  if (truncated) return depth < cap ? { tag: 'searching', depth: Math.min(depth * 2, cap) } : { tag: 'capped', depth };
  const first = at(best, 0);
  if (first.tag === 'none') return { tag: 'unrelated', depth, bases: best };
  return best.length > 1 ? { tag: 'criss-cross', depth, bases: best } : { tag: 'found', depth, base: first.value, bases: best };
}

// base is the verdict's one base, or null
export type MergeBase = { readonly base: string | null; readonly bases: string[]; readonly depth: number; readonly commits: Map<string, Commit>; readonly verdict: Verdict };
// maxDepth: the search cap in commits a side; null (the default) reads the transport's limits.maxMergeDepth.
export type MergeBaseConfig = { readonly maxDepth: number | null };
export type MergeBaseOptions = Input<MergeBaseConfig>;
export async function mergeBase(t: Transport, a: string, b: string, options: MergeBaseOptions = {}): Promise<Result<MergeBase, PlyError>> {
  const { maxDepth } = withDefaults<MergeBaseConfig>(options, { maxDepth: null });
  const capped = maxDepth === null ? readLimit(t.limits, 'maxMergeDepth') : checkLimit(maxDepth, 'maxMergeDepth');
  if (!capped.ok) return capped;
  const cap = capped.value;
  const top = Math.floor(cap);
  let s: Search = top < 1 ? { tag: 'capped', depth: 0 } : { tag: 'searching', depth: Math.min(8, top) };
  let commits = new Map<string, Commit>();
  while (s.tag === 'searching') {
    const { depth } = s;
    // oxlint-disable-next-line eslint/no-await-in-loop -- each round deepens from what the last one found
    const [A, B] = await Promise.all([ancestors(t, a, depth), ancestors(t, b, depth)]);
    if (!A.ok) return A;
    if (!B.ok) return B;
    commits = new Map([...B.value, ...A.value]);
    s = searchStep(depth, top, commits, a, b);
  }
  switch (s.tag) {
    case 'capped': {
      const attempted = s.depth === 0 ? 1 : s.depth * 2;
      return err(limitError('merge-base search depth', attempted, cap));
    }
    case 'found': return ok({ base: s.base, bases: s.bases, depth: s.depth, commits, verdict: s });
    case 'criss-cross':
    case 'unrelated': return ok({ base: null, bases: s.bases, depth: s.depth, commits, verdict: s });
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(s);
}

// Effect: a tree's entries, from the oid → bytes cache or fetched into it (`onFetch` counts a fetch)
const NO_COUNT = (): void => { /* not counted */ };
// oxlint-disable-next-line eslint/max-params -- the transport, the cache, the oid and the counter
const cachedTree = async (t: Transport, cache: TreeCache, oid: string, onFetch: () => void = NO_COUNT): Promise<Result<TreeEntry[], PlyError>> => {
  const held = mapGet(cache, oid);
  if (held.tag === 'some') return parseTree(held.value, t.limits);
  const got = await fetchObject(t, { oid, expectType: TYPE.TREE });
  if (!got.ok) return got;
  const { data } = got.value;
  cache.set(oid, data); onFetch();
  return parseTree(data, t.limits);
};
const subtree = (e: Entry): string | null => (e.tag === 'some' && isTreeEntry(e.value) ? e.value.oid : null);
// a tree by oid; null is the empty tree
type ReadTree = (oid: string | null) => Promise<Result<readonly TreeEntry[], PlyError>>;
// Effect: the paths `side` adds relative to `base` (both tree oids), recursing only into differing subtrees; a directory
// new on `side` is one entry, 'dir/', standing for everything inside it.
async function addedPaths(read: ReadTree, base: string | null, side: string | null, prefix = ''): Promise<Result<string[], PlyError>> {
  if (base === side) return ok([]);
  const [B, S] = await Promise.all([read(base), read(side)]);
  if (!B.ok) return B;
  if (!S.ok) return S;
  const b = byName(B.value); const out: string[] = [];
  for (const e of S.value) {
    const was = mapGet(b, e.name);
    // new, or a file where a directory was (or the reverse): added
    if (was.tag === 'none' || isTreeEntry(e) !== isTreeEntry(was.value)) out.push(prefix + e.name + (isTreeEntry(e) ? '/' : ''));
    else if (isTreeEntry(e) && was.value.oid !== e.oid) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one subtree at a time, as before
      const inner = await addedPaths(read, was.value.oid, e.oid, `${prefix}${e.name}/`);
      if (!inner.ok) return inner;
      out.push(...inner.value);
    }
  }
  return ok(out);
}

// a path list as one comparable value (paths hold no NUL)
const pathSet = (l: readonly string[]): string => [...l].toSorted().join('\0');
export type DriverFor = (path: string) => Promise<Result<Driver, PlyError>>;
// Why a path conflicts. The text is the reason a caller reads in merge_conflict's `reasons`.
export type ContentReason =
  | 'binary (merge attribute)' | 'too large to merge' | 'binary'
  | 'content (both sides changed the same lines)'
  | 'content (git would decide this with a classic-diff fallback ply does not implement)';
export type ConflictReason =
  | ContentReason
  | 'tree' // the sides disagree on what the path is (modify/delete, file/directory, add/add of different kinds, …)
  | 'mode' // both sides changed a file's mode, differently
  | 'content' // both sides changed a file and no line merge was given
  | 'possible directory rename (added inside a directory the other side removed)'
  | 'possible rename source (deleted on both sides while paths were added; ply does not detect renames)'
  | 'possible rename target (added while the merge has a deletion conflict)';
export type BlobSpec = { readonly base: string; readonly ours: string; readonly theirs: string; readonly path: string; readonly driverFor: DriverFor | null };
// A both-sides-changed file's content: one side's blob as it is (already on the server), a new merged blob (to push),
// or a conflict with its reason.
export type BlobMerge =
  | { readonly kind: 'existing'; readonly oid: string }
  | { readonly kind: 'merged'; readonly oid: string; readonly data: Uint8Array }
  | { readonly kind: 'conflict'; readonly reason: ContentReason };
export type MergeStats = { merged: number; undecided: number; unioned: number; attrBinary: number };
export type MergeBlob = ((spec: BlobSpec) => Promise<Result<BlobMerge, PlyError>>) & { stats: MergeStats };
export type Removed = 'ours' | 'theirs' | null;
// The three trees by oid (null: the empty tree), the path prefix of this directory, which side removed the directory
// being merged (null: neither), the line merge for a both-sides-changed file (null: such a file conflicts), and the
// .gitattributes merge driver per path (null: text).
export type MergeTreesConfig = {
  readonly base: string | null;
  readonly ours: string | null;
  readonly theirs: string | null;
  readonly prefix: string;
  readonly removed: Removed;
  readonly mergeBlob: MergeBlob | null;
  readonly driverFor: DriverFor | null;
};
export type MergeTreesSpec = Input<MergeTreesConfig>;
// The accumulator one merge shares across its recursion. reasons is keyed by path and has no prototype. deletedOne: a
// modify/delete conflict was seen.
export type MergeAcc = {
  objects: PackObject[];
  conflicts: string[];
  fetched: number;
  deletedBoth: string[];
  dirAdds: string[];
  reasons: Record<string, ConflictReason>;
  contentMerged: number;
  deletedOne: boolean;
};
// oid: the merged tree, or null when the merge conflicts or the tree is empty
export type MergeTreesResult = MergeAcc & { readonly oid: string | null };
const mergeTreesDefaults = (): MergeTreesConfig => ({ base: null, ours: null, theirs: null, prefix: '', removed: null, mergeBlob: null, driverFor: null });

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
/* oxlint-disable eslint/no-await-in-loop, eslint/complexity, eslint/max-params -- one path at a time (the merges share `out`, the cache and the fetch budget); the rename guards run once, at the top */
async function mergeDir(t: Transport, cache: TreeCache, { base, ours, theirs, prefix, removed, mergeBlob, driverFor }: MergeTreesConfig, out: MergeAcc, top: boolean): Promise<Result<MergeTreesResult, PlyError>> {
  const conflict = (path: string, why: ConflictReason): void => { out.conflicts.push(path); out.reasons[path] = why; };
  const read: ReadTree = async oid => (oid === null ? ok(EMPTY) : cachedTree(t, cache, oid, () => { out.fetched++; }));
  const [readB, readO, readT] = await Promise.all([read(base), read(ours), read(theirs)]);
  if (!readB.ok) return readB;
  if (!readO.ok) return readO;
  if (!readT.ok) return readT;
  const [B, O, T] = [readB.value, readO.value, readT.value];
  const r = threeWay(B, O, T);
  const { entries } = r;
  // Names are the repository's: a Map, so a directory called `constructor` or `__proto__` is not Object.prototype's
  const b = byName(B);
  const o = byName(O);
  const th = byName(T);
  for (const name of r.conflicts) conflict(prefix + name, 'tree');
  if (r.conflicts.some(name => b.has(name) && !(o.has(name) && th.has(name)))) out.deletedOne = true; // modify/delete
  for (const name of r.deletedBoth) out.deletedBoth.push(prefix + name);
  if (removed === 'ours') for (const name of r.addedTheirs) out.dirAdds.push(prefix + name);
  if (removed === 'theirs') for (const name of r.addedOurs) out.dirAdds.push(prefix + name);
  for (const name of r.content) {
    // content names are files on all three sides (threeWay)
    const eb = mapGet(b, name);
    const eo = mapGet(o, name);
    const et = mapGet(th, name);
    if (eb.tag === 'none' || eo.tag === 'none' || et.tag === 'none') continue;
    const mode = mergeMode(eb.value.mode, eo.value.mode, et.value.mode);
    if (mode === null) { conflict(prefix + name, 'mode'); continue; }
    if (mergeBlob === null) { conflict(prefix + name, 'content'); continue; }
    const blobMerged = await mergeBlob({ base: eb.value.oid, ours: eo.value.oid, theirs: et.value.oid, path: prefix + name, driverFor });
    if (!blobMerged.ok) return blobMerged;
    const blob = blobMerged.value;
    switch (blob.kind) {
      case 'conflict': conflict(prefix + name, blob.reason); continue;
      case 'existing': entries.push({ mode, name, oid: blob.oid }); out.contentMerged++; continue;
      case 'merged': entries.push({ mode, name, oid: blob.oid }); out.objects.push({ type: TYPE.BLOB, data: blob.data, oid: blob.oid }); out.contentMerged++; continue;
    }
    // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
    assertNever(blob);
  }
  for (const name of r.recurse) {
    const eb = mapGet(b, name);
    let sideRemoved = removed;
    if (sideRemoved === null && isTree(eb)) { if (!o.has(name)) sideRemoved = 'ours'; else if (!th.has(name)) sideRemoved = 'theirs'; }
    const sub = await mergeDir(t, cache, { base: subtree(eb), ours: subtree(mapGet(o, name)), theirs: subtree(mapGet(th, name)), prefix: `${prefix}${name}/`, removed: sideRemoved, mergeBlob, driverFor }, out, false);
    if (!sub.ok) return sub;
    if (sub.value.oid !== null) entries.push({ mode: '40000', name, oid: sub.value.oid }); // an empty merged subtree drops the directory, as git does
  }
  if (top) for (const p of out.dirAdds) if (!(p in out.reasons)) conflict(p, 'possible directory rename (added inside a directory the other side removed)');
  const encoded = encodeTree(entries);
  if (!encoded.ok) return encoded;
  const data: Uint8Array = encoded.value;
  const oid: string = hashObject('tree', data);
  // deletedOne is set only beside a conflict
  if (top && (out.deletedBoth.length > 0 || out.deletedOne)) {
    // Every path either side added, across the whole tree — the walk above skips directories only one side changed, and a
    // rename target can be anywhere. Fetched only when a deletion is in play.
    const addedOursR = await addedPaths(read, base, ours);
    if (!addedOursR.ok) return addedOursR;
    const addedTheirsR = await addedPaths(read, base, theirs);
    if (!addedTheirsR.ok) return addedTheirsR;
    const addedOurs = addedOursR.value;
    const addedTheirs = addedTheirsR.value;
    const added = [...new Set([...addedOurs, ...addedTheirs])];
    // G1 stands down when the rename is already applied (#103): the rename-blind merge is ours' tree (every change theirs
    // made is in ours) and both sides added and deleted exactly the same paths, so git pairs the same renames on both
    // sides and finds nothing to conflict (a cherry-pick of it is empty). An add or delete on ours alone could let git
    // pair a different source or target there (rename/rename, rename/delete), so the guard stays.
    const sameChanges = async (): Promise<Result<boolean, PlyError>> => {
      if (pathSet(addedOurs) !== pathSet(addedTheirs)) return ok(false);
      const removedOurs = await addedPaths(read, ours, base);
      if (!removedOurs.ok) return removedOurs;
      return map(await addedPaths(read, theirs, base), removedTheirs => pathSet(removedOurs.value) === pathSet(removedTheirs));
    };
    const unchanged = out.conflicts.length === 0 && oid === ours ? await sameChanges() : ok(false);
    if (!unchanged.ok) return unchanged;
    const applied = unchanged.value;
    if (added.length > 0 && !applied) for (const p of out.deletedBoth) conflict(p, 'possible rename source (deleted on both sides while paths were added; ply does not detect renames)');
    // Naming: git reports a rename's conflict at the rename target (rename/delete, rename/rename, or a content conflict
    // after following a rename onto a modify/delete). When this merge conflicts with a deletion in play, every added path
    // is a possible target, so it is listed too. This adds names to a conflicting merge; it never makes one conflict.
    if (out.conflicts.length > 0) for (const p of added) if (!(p in out.reasons)) conflict(p, 'possible rename target (added while the merge has a deletion conflict)');
  }
  if (out.conflicts.length > 0 || entries.length === 0) return ok({ oid: null, ...out });
  if (oid !== ours && oid !== theirs && oid !== base) out.objects.push({ type: TYPE.TREE, data, oid });
  cache.set(oid, data);
  return ok({ oid, ...out });
}
/* oxlint-enable eslint/no-await-in-loop, eslint/complexity, eslint/max-params */

export async function mergeTrees(t: Transport, cache: TreeCache, spec: MergeTreesSpec, into: MergeAcc | null = null): Promise<Result<MergeTreesResult, PlyError>> {
  const top = into === null;
  // reasons is keyed by path, so it has no prototype: a path named `__proto__` or `constructor` is recorded like any other
  const out: MergeAcc = into === null ? { objects: [], conflicts: [], fetched: 0, deletedBoth: [], dirAdds: [], reasons: Object.create(null), contentMerged: 0, deletedOne: false } : into;
  return mergeDir(t, cache, withDefaults(spec, mergeTreesDefaults()), out, top);
}
// Effect: the merge driver for a path from the .gitattributes files of one tree (git's attr.tree / --attr-source, or the
// worktree's — which is ours — for a non-bare `git merge`). Reads only the directories on the path, each once; returns
// 'text' | 'union' | 'binary' as find_ll_merge_driver picks: merge set → text, -merge → binary, merge=binary|union|text
// → that, any other name → text (a custom driver is server configuration we cannot see), unspecified → text.
export function attributeDrivers(t: Transport, cache: TreeCache, treeOid: string): DriverFor {
  // Each directory's tree and .gitattributes text is looked up once and shared, while it is pending or once it has
  // succeeded. A lookup that fails (an Err, or a rejection) is forgotten as it fails, so the next path asks again (#79:
  // one transient failure poisoned every later lookup of that directory).
  type Look = Promise<Result<Option<string>, PlyError>>;
  const memo = new Map<string, Look>([['/', Promise.resolve(ok(some(treeOid)))]]);
  const once = (key: string, look: () => Look): Look => {
    const known = mapGet(memo, key);
    if (known.tag === 'some') return known.value;
    const p = look(); memo.set(key, p); p.then(r => r.ok || memo.delete(key), () => memo.delete(key)).catch(() => false);
    return p;
  };
  // the first entry of the tree `oid` that `keep` accepts
  const entryIn = async (oid: string, keep: (e: TreeEntry) => boolean): Promise<Result<Option<TreeEntry>, PlyError>> => map(await cachedTree(t, cache, oid), l => fromNullable(l.find(e => keep(e))));
  // keys: '/' + dir for a directory's tree oid, dir alone for its .gitattributes text (a dir never starts with '/')
  const treeOf = (dir: string): Look => once(`/${dir}`, async () => {
    const cut = dir.lastIndexOf('/');
    const p = await treeOf(cut < 0 ? '' : dir.slice(0, cut));
    if (!p.ok || p.value.tag === 'none') return p;
    return map(await entryIn(p.value.value, e => e.name === dir.slice(cut + 1) && e.mode === '40000'), found => mapOption(found, e => e.oid));
  });
  // a .gitattributes entry's text
  const textOf = async (e: Option<TreeEntry>): Promise<Result<Option<string>, PlyError>> => {
    if (e.tag === 'none') return ok(none);
    return map(await fetchObject(t, { oid: e.value.oid, expectType: TYPE.BLOB }), b => some(bytesToStr(b.data)));
  };
  const fileOf = (dir: string): Look => once(dir, async () => {
    const oid = await treeOf(dir);
    if (!oid.ok || oid.value.tag === 'none') return oid;
    const e = await entryIn(oid.value.value, x => x.name === '.gitattributes' && x.mode !== '40000' && x.mode !== '160000');
    if (!e.ok) return e;
    return textOf(e.value);
  });
  return async path => {
    const dirs = ['']; for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) dirs.push(path.slice(0, i));
    const texts = await Promise.all(dirs.map(d => fileOf(d)));
    for (const r of texts) if (!r.ok) return r;
    const byDir = new Map<string, string>();
    for (const [i, d] of dirs.entries()) {
      const text = at(texts, i);
      if (text.tag === 'none' || !text.value.ok || text.value.value.tag === 'none') continue;
      const dir = utf8ToStr(d);
      if (!dir.ok) return dir;
      byDir.set(dir.value, text.value.value.value);
    }
    const file = utf8ToStr(path);
    if (!file.ok) return file;
    const v = attributeOf(attributesFor(file.value, byDir), 'merge');
    if (v.tag === 'none') return ok<Driver>('text');
    if (v.value === false) return ok<Driver>('binary');
    if (v.value === 'binary' || v.value === 'union') return ok<Driver>(v.value);
    return ok<Driver>('text');
  };
}

const refused = (reason: ContentReason): Ok<BlobMerge> => ok({ kind: 'conflict', reason });
// A blob that could not be read: too large is a refusal (the merge goes on), anything else fails it.
const lost = (r: Err<PlyError>): Result<BlobMerge, PlyError> => (r.error.code === 'limit_exceeded' ? refused('too large to merge') : r);

// Effect: the content half of a both-sides-changed file — git's shortcuts first (one side equal to base or both equal),
// then the three blobs (bounded by maxMergeBlobBytes) through the ported xdiff merge. Shared by merge, rebase,
// cherry-pick and revert. Refused (bad_request) before any merge: a rediff that is not one of the three, a blob cap or a
// transport object cap that bounds nothing.
export function blobMerger(t: Transport, maxMergeBlobBytes: unknown, rediff: Rediff): Result<MergeBlob, ErrorOf<'bad_request'>> {
  if (!['undecided', 'skip', 'myers'].includes(rediff)) return fail('bad_request', `rediff must be 'undecided', 'skip' or 'myers', not ${JSON.stringify(rediff)}`);
  const blobCapped = checkLimit(maxMergeBlobBytes, 'maxMergeBlobBytes');
  if (!blobCapped.ok) return blobCapped;
  const objectCapped = readLimit(t.limits, 'maxObjectSize');
  if (!objectCapped.ok) return objectCapped;
  const blobCap = blobCapped.value;
  const stats: MergeStats = { merged: 0, undecided: 0, unioned: 0, attrBinary: 0 };
  const bounded: Transport = Object.create(t, { limits: { value: { ...t.limits, maxObjectSize: Math.min(objectCapped.value, blobCap) } } });
  // Blobs this merger produced exist only in the pending push (a rebase replays commit 2 onto commit 1's merged blob), so
  // they are served from here; the bytes are already held for the push, so this costs no extra memory.
  const made = new Map<string, Uint8Array>();
  const get = async (oid: string): Promise<Result<Uint8Array, PlyError>> => { const held = mapGet(made, oid); return held.tag === 'some' ? ok(held.value) : map(await fetchObject(bounded, { oid, expectType: TYPE.BLOB }), b => b.data); };
  const f = async ({ base, ours, theirs, path, driverFor }: BlobSpec): Promise<Result<BlobMerge, PlyError>> => {
    if (ours === theirs || theirs === base) return ok({ kind: 'existing', oid: ours });
    if (ours === base) return ok({ kind: 'existing', oid: theirs });
    // the merge attribute (when an attribute source was given): binary/-merge conflicts without reading the blobs
    const driven = driverFor === null ? ok<Driver>('text') : await driverFor(path);
    if (!driven.ok) return driven;
    const driver = driven.value;
    if (driver === 'binary') { stats.attrBinary++; return refused('binary (merge attribute)'); }
    const [rB, rO, rT] = await Promise.all([get(base), get(ours), get(theirs)]);
    if (!rB.ok) return lost(rB);
    if (!rO.ok) return lost(rO);
    if (!rT.ok) return lost(rT);
    const [B, O, T] = [rB.value, rO.value, rT.value];
    const m = mergeLines(B, O, T, { maxBytes: blobCap, rediff, driver });
    if (!m.clean) {
      if (m.reason === 'undecided') { stats.undecided++; return refused('content (git would decide this with a classic-diff fallback ply does not implement)'); }
      return refused(m.reason === 'content' ? 'content (both sides changed the same lines)' : m.reason);
    }
    stats.merged++; if ('unioned' in m) stats.unioned++;
    const oid: string = hashObject('blob', m.data); made.set(oid, m.data);
    return ok({ kind: 'merged', oid, data: m.data });
  };
  return ok(Object.assign(f, { stats }));
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
// A caller's attributes option, checked (a JS caller's missing value is null).
export const validateAttributes = (a: unknown): Result<AttributeSource, ErrorOf<'bad_request'>> => {
  const given = fromNullish(a);
  if (given.tag === 'none') return ok(null);
  const v = given.value;
  if (typeof v !== 'string') return fail('bad_request', 'attributes must be null, ours, theirs, base, a ref or a commit oid');
  if (v === 'ours' || v === 'theirs' || v === 'base' || isOid(v)) return ok(v);
  return map(validateRef(v), () => v);
};
// The three sides' trees (null: the empty tree, or a side not in play).
export type Trees = { readonly base: string | null; readonly ours: string | null; readonly theirs: string | null };
export const NO_TREES: Trees = { base: null, ours: null, theirs: null };
const refMiss = (ref: string): Miss => ({ kind: 'ref', ref, candidates: [ref] });
// a ref's oid in an ls-refs answer
export const refOid = (refs: LsRefsResult['refs'], ref: string): Option<string> => mapOption(mapGet(refs, ref), r => r.oid);
// The tree whose .gitattributes apply; a JS caller's missing tree is null.
export async function attributeTree(t: Transport, attributes: AttributeSource, given: Input<Trees>): Promise<Result<string | null, PlyError>> {
  const trees = withDefaults(given, { ...NO_TREES });
  if (attributes === null) return ok(null);
  if (attributes === 'ours' || attributes === 'theirs' || attributes === 'base') return ok(trees[attributes]);
  // validateAttributes ran first (mergeBranch, rebaseBranch, pickCommit): a ref name or an oid
  let oid = attributes;
  if (!isOid(attributes)) {
    const named = validateRef(attributes);
    if (!named.ok) return named;
    const listed = await lsRefs(t, [attributes]); if (!listed.ok) return listed;
    const found = refOid(listed.value.refs, attributes);
    if (found.tag === 'none') return fail('not_found', `attributes ref ${attributes} not found`, { miss: { kind: 'ref', ref: attributes, candidates: [attributes] } });
    oid = found.value;
  }
  return map(await commitAt(t, oid), c => c.tree);
}

// Fast-forward `ref` to `to`, expecting it to be at `from` (CAS). Empty pack: the server already has the objects.
export async function fastForward(t: Transport, { ref, from, to }: { readonly ref: string; readonly from: string; readonly to: string }): Promise<Result<PushResult, PlyError>> {
  return push(t, { ref, oldOid: from, newOid: to, objects: [] });
}

// Delete `ref` on a transport the caller holds, expecting it at `oid` (CAS). By URL, with the tip read for you:
// refops.ts deleteBranch.
export async function deleteRef(t: Transport, { ref, oid }: { readonly ref: string; readonly oid: string }): Promise<Result<PushResult, PlyError>> {
  return push(t, { ref, oldOid: oid, newOid: ZERO_OID, objects: [] });
}

// What a merge-base verdict means for landing `theirs` on `ours`, before any tree is read: nothing to do, a
// fast-forward, or a three-way merge over the one base. Criss-cross history is refused (git merges the bases into a
// virtual one, recursively; a single base can give a clean result that differs from git's, so we refuse rather than
// guess), as are unrelated histories and, when only a fast-forward is allowed, a merge commit.
type Landing =
  | { readonly kind: 'up_to_date'; readonly base: string }
  | { readonly kind: 'fast_forward'; readonly base: string }
  | { readonly kind: 'three_way'; readonly base: string };
type LandingFlags = { readonly ref: string; readonly from: string; readonly fastForwardOnly: boolean; readonly noFastForward: boolean };
function decideMerge(verdict: Verdict, ours: string, theirs: string, { ref, from, fastForwardOnly, noFastForward }: LandingFlags): Result<Landing, PlyError> {
  switch (verdict.tag) {
    case 'criss-cross': return fail('merge_conflict', `${ref} and ${from} have ${verdict.bases.length} merge bases (criss-cross history); ply does not build git's virtual merge base`, { conflicts: [], reasons: Object.create(null), bases: verdict.bases } as ConflictDetail);
    case 'unrelated': return fail('unrelated_histories', `${ref} and ${from} share no common ancestor within the search depth`);
    case 'found': {
      const { base } = verdict;
      if (base === theirs) return ok({ kind: 'up_to_date', base });
      if (base === ours && !noFastForward) return ok({ kind: 'fast_forward', base });
      if (fastForwardOnly) return fail('not_fast_forward', `${ref} has moved past the merge base; a merge commit would be needed`);
      return ok({ kind: 'three_way', base });
    }
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(verdict);
}

export type MergeSpecConfig = {
  readonly ref: string;
  readonly author: Author | null;
  // null: the author (one identity, one time, as before)
  readonly committer: Author | null;
  readonly message: string | null;
  readonly time: number;
  readonly fastForwardOnly: boolean;
  readonly noFastForward: boolean;
};
export type MergeSpec = Input<MergeSpecConfig> & { readonly from: string };
const mergeSpecDefaults = (): MergeSpecConfig => ({ ref: 'refs/heads/main', author: null, committer: null, message: null, time: Math.floor(Date.now() / 1000), fastForwardOnly: false, noFastForward: false });
// The operation options (auth, tracer, limits, …) pass through to operation(); these are the ones merge reads.
export type MergeConfig = {
  readonly cache: TreeCache;
  readonly signer: Signer | null;
  readonly verify: boolean;
  readonly rediff: Rediff;
  readonly attributes: AttributeSource;
};
export type MergeOptions = Input<MergeConfig> & Readonly<Record<string, unknown>>;
const mergeDefaults = (): MergeConfig => ({ cache: new Map(), signer: null, verify: false, rediff: 'myers', attributes: null });
type Sides = { readonly ref: string; readonly oid: string; readonly ours: string; readonly theirs: string };
export type MergeOutcome =
  | Sides & { readonly outcome: 'up_to_date' | 'fast_forward'; readonly base: string }
  | Sides & { readonly outcome: 'merge'; readonly tree: string; readonly base: string; readonly pushBytes: number; readonly newTrees: number; readonly contentMerged: number };

// The entry options as operation() takes them, with the operation's attributes. The tracer is the caller's, required at
// run time (operation starts the root span on it), as for every entry (boundary.ts EntryOptions).
export const operationOpts = (options: Readonly<Record<string, unknown>>, attrs: Readonly<Record<string, unknown>>): OperationOpts =>
  ({ ...options, attrs });

// an annotated tag's peeled commit, as ls-refs reports it
const peeledOf = (refs: LsRefsResult['refs'], ref: string): Option<string> => {
  const r = mapGet(refs, ref);
  return r.tag === 'none' ? none : fromNullish(r.value.peeled);
};

// Effect: a landing that writes no merge commit: nothing to do, or the fast-forward push.
type Quick = Exclude<Landing, { readonly kind: 'three_way' }>;
async function landWithoutMerge(t: Transport, outcome: Outcome, land: Quick, { ref, ours, theirs }: { readonly ref: string; readonly ours: string; readonly theirs: string }): Promise<Result<MergeOutcome, PlyError>> {
  switch (land.kind) {
    case 'up_to_date': return outcome('up_to_date', { outcome: 'up_to_date', ref, oid: ours, ours, theirs, base: land.base });
    case 'fast_forward': {
      const r = await fastForward(t, { ref, from: ours, to: theirs });
      if (!r.ok) return r;
      return outcome('fast_forward', { outcome: 'fast_forward', ref, oid: theirs, ours, theirs, base: land.base }, { 'git.merge.push.bytes': r.value.packBytes });
    }
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(land);
}

// A stamp, or None when none was given.
const stampOf = (p: Author | null, time: number): Result<Option<ValidatedIdent>, PlyError> => (p === null ? ok(none) : map(stamp(p, time), some));

// The inputs are checked before any I/O; a refusal returns before the operation starts. The body's refusals keep the
// names the decision inventory knows them by (mergeBranch#…), and the operation records an Err's code on the root span.
/* oxlint-disable eslint/complexity -- one operation's steps in order: refs, merge base, landing, tree merge, commit, push */
export async function mergeBranch(url: string, spec: MergeSpec, options: MergeOptions = {}): Promise<Result<MergeOutcome, PlyError>> {
  const { ref, author, committer, message, time, fastForwardOnly, noFastForward } = withDefaults(spec, mergeSpecDefaults());
  const { from } = spec;
  const { cache, signer, verify, rediff, attributes: attributesGiven } = withDefaults(options, mergeDefaults());
  const pushRef = validatePushRef(ref, false); if (!pushRef.ok) return pushRef;
  const given = givenOid(from, 'from'); if (!given.ok) return given;
  const fromOid = given.value;
  const authorStamp = stampOf(author, time); if (!authorStamp.ok) return authorStamp;
  const committerStamp = committer === null ? authorStamp : stampOf(committer, time); if (!committerStamp.ok) return committerStamp;
  const person = authorStamp.value;
  const committerPerson = committerStamp.value;
  if (message !== null && message !== '') { const checked = validateMessage(message); if (!checked.ok) return checked; }
  const attributesChecked = validateAttributes(attributesGiven); if (!attributesChecked.ok) return attributesChecked;
  const attributes = attributesChecked.value;
  return operation('merge', url, operationOpts(options, { 'git.merge.ref': ref, 'git.merge.from': from, 'git.merge.ff_only': fastForwardOnly, 'git.merge.no_ff': noFastForward }), async ({ t, root, outcome }: OpContext): Promise<Result<MergeOutcome, PlyError>> => {
    const listed = await lsRefs(t, isNone(fromOid) ? [ref, from] : [ref]); if (!listed.ok) return listed;
    const { refs } = listed.value;
    const oursAt = refOid(refs, ref);
    const theirsAt = isSome(fromOid) ? fromOid : refOid(refs, from);
    if (oursAt.tag === 'none') return fail('not_found', `ref ${ref} not found`, { miss: refMiss(ref) });
    if (theirsAt.tag === 'none') return fail('not_found', `ref ${from} not found`, { miss: refMiss(from) });
    const ours = oursAt.value;
    const theirs = theirsAt.value;
    // ls-refs names an annotated tag's object, not a commit; `git merge <tag>` records the tag in a mergetag header, which
    // ply does not write. Refused by name (it read as a missing commit, pack_corrupt, before #43's matrix ran it).
    for (const r of [ref, from]) { const peeled = peeledOf(refs, r); if (peeled.tag === 'some') return fail('unsupported', `${r} is an annotated tag (git merge writes a mergetag header ply does not); merge its commit ${peeled.value}`, { what: r === ref ? 'ref' : 'from' }); }
    if (fromOid.tag === 'some') { const c = await assertCommit(t, fromOid.value, 'from'); if (!c.ok) return c; }
    root.set({ 'git.merge.ours': ours, 'git.merge.theirs': theirs });
    const upToDate = (base: string): Ok<MergeOutcome> => outcome('up_to_date', { outcome: 'up_to_date', ref, oid: ours, ours, theirs, base });
    if (ours === theirs) return upToDate(ours);
    const found = await mergeBase(t, ours, theirs);
    if (!found.ok) return found;
    const { base: one, bases, depth, verdict } = found.value;
    root.set({ 'git.merge.base': one === null ? '' : one, 'git.merge.bases': bases.length, 'git.merge.base.depth': depth });
    const landing = decideMerge(verdict, ours, theirs, { ref, from, fastForwardOnly, noFastForward });
    if (!landing.ok) return landing;
    const land = landing.value;
    if (land.kind !== 'three_way') return landWithoutMerge(t, outcome, land, { ref, ours, theirs });
    const { base } = land;
    // three-way: commits for the three trees (the commit-only packs from mergeBase did not carry trees)
    const [cB, cO, cT] = await Promise.all([commitBytesAt(t, base), commitBytesAt(t, ours), commitBytesAt(t, theirs)]);
    const tree = (c: Result<{ readonly data: Uint8Array }, PlyError>): Result<string, PlyError> => andThen(c, b => map(parseCommit(b.data, t.limits), x => x.tree));
    const tB = tree(cB); if (!tB.ok) return tB;
    const tO = tree(cO); if (!tO.ok) return tO;
    const tT = tree(cT); if (!tT.ok) return tT;
    const trees: Trees = { base: tB.value, ours: tO.value, theirs: tT.value };
    const blobCap = readLimit(t.limits, 'maxMergeBlobBytes');
    if (!blobCap.ok) return blobCap;
    const merger = blobMerger(t, blobCap.value, rediff);
    if (!merger.ok) return merger;
    const mergeBlob = merger.value;
    const attrTree = await attributeTree(t, attributes, trees);
    if (!attrTree.ok) return attrTree;
    root.set({ 'git.merge.attributes': attributes === null ? '' : attributes });
    const treesMerged = await mergeTrees(t, cache, { ...trees, mergeBlob, driverFor: attrTree.value === null ? null : attributeDrivers(t, cache, attrTree.value) });
    if (!treesMerged.ok) return treesMerged;
    const merged = treesMerged.value;
    const newTrees = merged.objects.filter(o => o.type === TYPE.TREE).length;
    root.set({ 'git.merge.content.merged': merged.contentMerged, 'git.merge.content.undecided': mergeBlob.stats.undecided, 'git.merge.content.unioned': mergeBlob.stats.unioned, 'git.merge.content.attr_binary': mergeBlob.stats.attrBinary, 'git.merge.trees.fetched': merged.fetched, 'git.merge.trees.new': newTrees, 'git.merge.conflicts': merged.conflicts.slice(0, 64), 'git.merge.conflicts.count': merged.conflicts.length });
    if (merged.conflicts.length > 0) return fail('merge_conflict', `conflicts: ${merged.conflicts.slice(0, 8).map(p => `${p} (${merged.reasons[p]})`).join(', ')}${merged.conflicts.length > 8 ? '…' : ''}`, { conflicts: merged.conflicts, reasons: merged.reasons } as ConflictDetail);
    const emptyTree = encodeTree([]); if (!emptyTree.ok) return emptyTree;
    const treeOid: string = merged.oid === null ? hashObject('tree', emptyTree.value) : merged.oid;
    if (person.tag === 'none' || committerPerson.tag === 'none') return fail('bad_request', 'author is required for a merge commit');
    const authorLine = ident(person.value); if (!authorLine.ok) return authorLine;
    const committerLine = ident(committerPerson.value); if (!committerLine.ok) return committerLine;
    const encoded = encodeCommit({ tree: treeOid, parents: [ours, theirs], author: authorLine.value, committer: committerLine.value, message: (message === null ? `Merge ${short(from)} into ${short(ref)}` : message).replace(/\n?$/u, '\n') });
    if (!encoded.ok) return encoded;
    let commitData = encoded.value;
    if (signer) { const signed = await signCommit(commitData, signer); if (!signed.ok) return signed; commitData = signed.value; }
    const oid: string = hashObject('commit', commitData);
    const objects = uniqueObjects([{ type: TYPE.COMMIT, data: commitData, oid }, ...(merged.oid === null ? [{ type: TYPE.TREE, data: emptyTree.value, oid: treeOid }] : []), ...merged.objects]).map(o => ({ type: o.type, data: o.data }));
    const pushed = await push(t, { ref, oldOid: ours, newOid: oid, objects });
    if (!pushed.ok) return pushed;
    const r = pushed.value;
    if (verify) { const seen = await verifyRef(t, root, 'git.merge', ref, oid); if (!seen.ok) return seen; }
    return outcome('merge', { outcome: 'merge', ref, oid, tree: treeOid, ours, theirs, base, pushBytes: r.packBytes, newTrees, contentMerged: merged.contentMerged }, { 'git.merge.commit': oid, 'git.merge.tree': treeOid, 'git.merge.push.bytes': r.packBytes });
  });
}
/* oxlint-enable eslint/complexity */
