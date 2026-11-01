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
// linemerge.js. The effects: lsRefs, fetchObject, push. Inside, a step that can fail returns a Result; the exported
// entry points (mergeBranch, mergeBase, attributeTree) throw it at the public boundary.
/* oxlint-disable import/max-dependencies -- a merge drives ls-refs, fetch, push, the object codecs and the line merge */
/* oxlint-disable eslint/require-await, typescript/promise-function-async -- each function keeps its async-ness (a sync throw stays sync); together the two rules forbid a function that forwards a promise */
import type { ValidatedIdent } from './validate.js';
import type { Limits } from './limits.js';
import type { Driver, Rediff } from './linemerge.js';
import type { ErrorOf, Extra, Miss, PlyError } from './errors.js';
import type { Option, Result } from './result.js';
import type { Input } from './absent.js';
import type { LsRefsResult } from './lsrefs.js';
import type { OperationOpts, Outcome } from './operation.js';
import { fail, orThrow } from './errors.js';
import { assertNever, err, getOrElse, isNone, isSome, mapOption, none, ok, some } from './result.js';
import { at, fromNullable, fromNullish, mapGet, readKey, withDefaults } from './absent.js';
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
import { thrownCodeIs } from './boundary.js';

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

// push.ts takes a branded Refname; the ref here is validated (validatePushRef) as a plain string. Each call casts to
// this signature (a type-only cast: an alias `const f = g as F` would cost bundle bytes).
type Push = (t: Transport, o: { readonly ref: string; readonly oldOid: string; readonly newOid: string; readonly objects: readonly PushObject[] }) => Promise<PushResult>;

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
export async function ancestors(t: Transport, head: string, depth: number): Promise<Result<Map<string, Commit>, ErrorOf<'pack_corrupt'>>> {
  const r = await fetchPackTree0(t, { wants: [head], filter: 'tree:0', deepen: depth });
  const commits = new Map<string, Commit>();
  const objects = fromNullish(r.objects);
  if (objects.tag === 'some') for (const [oid, o] of objects.value) if (o.type === TYPE.COMMIT) commits.set(oid, parseCommit(o.data, t.limits));
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
export async function mergeBaseResult(t: Transport, a: string, b: string, options: MergeBaseOptions = {}): Promise<Result<MergeBase, PlyError>> {
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
// The throwing form, for callers outside the merge modules (the package's mergeBase).
export async function mergeBase(t: Transport, a: string, b: string, options: MergeBaseOptions = {}): Promise<MergeBase> {
  return orThrow(await mergeBaseResult(t, a, b, options));
}

// Effect: a tree's entries, from the oid → bytes cache or fetched into it (`onFetch` counts a fetch)
const NO_COUNT = (): void => { /* not counted */ };
// oxlint-disable-next-line eslint/max-params -- the transport, the cache, the oid and the counter
const cachedTree = async (t: Transport, cache: TreeCache, oid: string, onFetch: () => void = NO_COUNT): Promise<TreeEntry[]> => {
  const held = mapGet(cache, oid);
  if (held.tag === 'some') return parseTree(held.value, t.limits);
  const { data } = await fetchObject(t, { oid, expectType: TYPE.TREE });
  cache.set(oid, data); onFetch();
  return parseTree(data, t.limits);
};
const subtree = (e: Entry): string | null => (e.tag === 'some' && isTreeEntry(e.value) ? e.value.oid : null);
// a tree by oid; null is the empty tree
type ReadTree = (oid: string | null) => Promise<readonly TreeEntry[]>;
// Effect: the paths `side` adds relative to `base` (both tree oids), recursing only into differing subtrees; a directory
// new on `side` is one entry, 'dir/', standing for everything inside it.
async function addedPaths(read: ReadTree, base: string | null, side: string | null, prefix = ''): Promise<string[]> {
  if (base === side) return [];
  const [B, S] = await Promise.all([read(base), read(side)]);
  const b = byName(B); const out: string[] = [];
  for (const e of S) {
    const was = mapGet(b, e.name);
    // new, or a file where a directory was (or the reverse): added
    if (was.tag === 'none' || isTreeEntry(e) !== isTreeEntry(was.value)) out.push(prefix + e.name + (isTreeEntry(e) ? '/' : ''));
    // oxlint-disable-next-line eslint/no-await-in-loop -- one subtree at a time, as before
    else if (isTreeEntry(e) && was.value.oid !== e.oid) out.push(...await addedPaths(read, was.value.oid, e.oid, `${prefix}${e.name}/`));
  }
  return out;
}

// a path list as one comparable value (paths hold no NUL)
const pathSet = (l: readonly string[]): string => [...l].toSorted().join('\0');
export type DriverFor = (path: string) => Promise<Driver>;
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
export type MergeBlob = ((spec: BlobSpec) => Promise<BlobMerge>) & { stats: MergeStats };
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
async function mergeDir(t: Transport, cache: TreeCache, { base, ours, theirs, prefix, removed, mergeBlob, driverFor }: MergeTreesConfig, out: MergeAcc, top: boolean): Promise<MergeTreesResult> {
  const conflict = (path: string, why: ConflictReason): void => { out.conflicts.push(path); out.reasons[path] = why; };
  const read: ReadTree = async oid => (oid === null ? EMPTY : cachedTree(t, cache, oid, () => { out.fetched++; }));
  const [B, O, T] = await Promise.all([read(base), read(ours), read(theirs)]);
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
    const blob = await mergeBlob({ base: eb.value.oid, ours: eo.value.oid, theirs: et.value.oid, path: prefix + name, driverFor });
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
    if (sub.oid !== null) entries.push({ mode: '40000', name, oid: sub.oid }); // an empty merged subtree drops the directory, as git does
  }
  if (top) for (const p of out.dirAdds) if (!(p in out.reasons)) conflict(p, 'possible directory rename (added inside a directory the other side removed)');
  const data: Uint8Array = encodeTree(entries);
  const oid: string = hashObject('tree', data);
  // deletedOne is set only beside a conflict
  if (top && (out.deletedBoth.length > 0 || out.deletedOne)) {
    // Every path either side added, across the whole tree — the walk above skips directories only one side changed, and a
    // rename target can be anywhere. Fetched only when a deletion is in play.
    const addedOurs = await addedPaths(read, base, ours);
    const addedTheirs = await addedPaths(read, base, theirs);
    const added = [...new Set([...addedOurs, ...addedTheirs])];
    // G1 stands down when the rename is already applied (#103): the rename-blind merge is ours' tree (every change theirs
    // made is in ours) and both sides added and deleted exactly the same paths, so git pairs the same renames on both
    // sides and finds nothing to conflict (a cherry-pick of it is empty). An add or delete on ours alone could let git
    // pair a different source or target there (rename/rename, rename/delete), so the guard stays.
    const sameChanges = async (): Promise<boolean> => pathSet(addedOurs) === pathSet(addedTheirs) && pathSet(await addedPaths(read, ours, base)) === pathSet(await addedPaths(read, theirs, base));
    const applied = out.conflicts.length === 0 && oid === ours && await sameChanges();
    if (added.length > 0 && !applied) for (const p of out.deletedBoth) conflict(p, 'possible rename source (deleted on both sides while paths were added; ply does not detect renames)');
    // Naming: git reports a rename's conflict at the rename target (rename/delete, rename/rename, or a content conflict
    // after following a rename onto a modify/delete). When this merge conflicts with a deletion in play, every added path
    // is a possible target, so it is listed too. This adds names to a conflicting merge; it never makes one conflict.
    if (out.conflicts.length > 0) for (const p of added) if (!(p in out.reasons)) conflict(p, 'possible rename target (added while the merge has a deletion conflict)');
  }
  if (out.conflicts.length > 0 || entries.length === 0) return { oid: null, ...out };
  if (oid !== ours && oid !== theirs && oid !== base) out.objects.push({ type: TYPE.TREE, data, oid });
  cache.set(oid, data);
  return { oid, ...out };
}
/* oxlint-enable eslint/no-await-in-loop, eslint/complexity, eslint/max-params */

export async function mergeTrees(t: Transport, cache: TreeCache, spec: MergeTreesSpec, into: MergeAcc | null = null): Promise<MergeTreesResult> {
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
  // succeeded. A lookup that fails is forgotten as it fails, so the next path asks again (#79: one transient failure
  // poisoned every later lookup of that directory).
  const memo = new Map<string, Promise<Option<string>>>([['/', Promise.resolve(some(treeOid))]]);
  const once = (key: string, look: () => Promise<Option<string>>): Promise<Option<string>> => {
    const known = mapGet(memo, key);
    if (known.tag === 'some') return known.value;
    const p = look(); memo.set(key, p); p.catch(() => memo.delete(key));
    return p;
  };
  // keys: '/' + dir for a directory's tree oid, dir alone for its .gitattributes text (a dir never starts with '/')
  const treeOf = (dir: string): Promise<Option<string>> => once(`/${dir}`, async () => {
    const cut = dir.lastIndexOf('/');
    const p = await treeOf(cut < 0 ? '' : dir.slice(0, cut));
    if (p.tag === 'none') return none;
    return mapOption(fromNullable((await cachedTree(t, cache, p.value)).find(e => e.name === dir.slice(cut + 1) && e.mode === '40000')), e => e.oid);
  });
  const fileOf = (dir: string): Promise<Option<string>> => once(dir, async () => {
    const oid = await treeOf(dir);
    if (oid.tag === 'none') return none;
    const e = fromNullable((await cachedTree(t, cache, oid.value)).find(x => x.name === '.gitattributes' && x.mode !== '40000' && x.mode !== '160000'));
    if (e.tag === 'none') return none;
    return some(bytesToStr((await fetchObject(t, { oid: e.value.oid, expectType: TYPE.BLOB })).data));
  });
  return async path => {
    const dirs = ['']; for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) dirs.push(path.slice(0, i));
    const texts = await Promise.all(dirs.map(d => fileOf(d)));
    const byDir = new Map<string, string>();
    for (const [i, d] of dirs.entries()) { const text = at(texts, i); if (text.tag === 'some' && text.value.tag === 'some') byDir.set(utf8ToStr(d), text.value.value); }
    const v = attributeOf(attributesFor(utf8ToStr(path), byDir), 'merge');
    if (v.tag === 'none') return 'text';
    if (v.value === false) return 'binary';
    if (v.value === 'binary' || v.value === 'union') return v.value;
    return 'text';
  };
}

const refused = (reason: ContentReason): BlobMerge => ({ kind: 'conflict', reason });

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
  const get = async (oid: string): Promise<Uint8Array> => { const held = mapGet(made, oid); return held.tag === 'some' ? held.value : (await fetchObject(bounded, { oid, expectType: TYPE.BLOB })).data; };
  const f = async ({ base, ours, theirs, path, driverFor }: BlobSpec): Promise<BlobMerge> => {
    if (ours === theirs || theirs === base) return { kind: 'existing', oid: ours };
    if (ours === base) return { kind: 'existing', oid: theirs };
    // the merge attribute (when an attribute source was given): binary/-merge conflicts without reading the blobs
    const driver = driverFor === null ? 'text' : await driverFor(path);
    if (driver === 'binary') { stats.attrBinary++; return refused('binary (merge attribute)'); }
    let B: Uint8Array;
    let O: Uint8Array;
    let T: Uint8Array;
    try { [B, O, T] = await Promise.all([get(base), get(ours), get(theirs)]); }
    catch (error) {
      if (thrownCodeIs(error, 'limit_exceeded')) return refused('too large to merge');
      throw error;
    }
    const m = mergeLines(B, O, T, { maxBytes: blobCap, rediff, driver });
    if (!m.clean) {
      if (m.reason === 'undecided') { stats.undecided++; return refused('content (git would decide this with a classic-diff fallback ply does not implement)'); }
      return refused(m.reason === 'content' ? 'content (both sides changed the same lines)' : m.reason);
    }
    stats.merged++; if ('unioned' in m) stats.unioned++;
    const oid: string = hashObject('blob', m.data); made.set(oid, m.data);
    return { kind: 'merged', oid, data: m.data };
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
  validateRef(v);
  return ok(v);
};
// The three sides' trees (null: the empty tree, or a side not in play).
export type Trees = { readonly base: string | null; readonly ours: string | null; readonly theirs: string | null };
export const NO_TREES: Trees = { base: null, ours: null, theirs: null };
const refMiss = (ref: string): Miss => ({ kind: 'ref', ref, candidates: [ref] });
// a ref's oid in an ls-refs answer
export const refOid = (refs: LsRefsResult['refs'], ref: string): Option<string> => mapOption(mapGet(refs, ref), r => r.oid);
// The Result form is defined as `attributeTree` and exported as attributeTreeResult, so its refusal keeps the id the
// decision inventory knows (attributeTree#…, test/space/ratchet.json); the throwing form is exported as attributeTree.
async function attributeTree(t: Transport, attributes: AttributeSource, trees: Trees): Promise<Result<string | null, ErrorOf<'not_found'>>> {
  if (attributes === null) return ok(null);
  if (attributes === 'ours' || attributes === 'theirs' || attributes === 'base') return ok(trees[attributes]);
  // validateAttributes ran first (mergeBranch, rebaseBranch, pickCommit): a ref name or an oid
  let oid = attributes;
  if (!isOid(attributes)) {
    validateRef(attributes);
    const found = refOid((await lsRefs(t, [attributes])).refs, attributes);
    if (found.tag === 'none') return fail('not_found', `attributes ref ${attributes} not found`, { miss: { kind: 'ref', ref: attributes, candidates: [attributes] } });
    oid = found.value;
  }
  return ok((await commitAt(t, oid)).tree);
}
// The throwing form; a JS caller's missing tree is null.
async function attributeTreeOrThrow(t: Transport, attributes: AttributeSource, trees: Input<Trees>): Promise<string | null> {
  return orThrow(await attributeTree(t, attributes, withDefaults(trees, { ...NO_TREES })));
}
export { attributeTree as attributeTreeResult, attributeTreeOrThrow as attributeTree };

// Fast-forward `ref` to `to`, expecting it to be at `from` (CAS). Empty pack: the server already has the objects.
export async function fastForward(t: Transport, { ref, from, to }: { readonly ref: string; readonly from: string; readonly to: string }): Promise<PushResult> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a validated ref as push's Refname (see Push)
  return (push as unknown as Push)(t, { ref, oldOid: from, newOid: to, objects: [] });
}

export async function deleteBranch(t: Transport, { ref, oid }: { readonly ref: string; readonly oid: string }): Promise<PushResult> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a validated ref as push's Refname (see Push)
  return (push as unknown as Push)(t, { ref, oldOid: oid, newOid: ZERO_OID, objects: [] });
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
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the options' tracer, required at run time (see above)
  ({ ...options, attrs }) as OperationOpts;

// an annotated tag's peeled commit, as ls-refs reports it
const peeledOf = (refs: LsRefsResult['refs'], ref: string): Option<string> => {
  const r = mapGet(refs, ref);
  return r.tag === 'none' ? none : readKey(r.value, 'peeled');
};

// Effect: a landing that writes no merge commit: nothing to do, or the fast-forward push.
type Quick = Exclude<Landing, { readonly kind: 'three_way' }>;
async function landWithoutMerge(t: Transport, outcome: Outcome, land: Quick, { ref, ours, theirs }: { readonly ref: string; readonly ours: string; readonly theirs: string }): Promise<MergeOutcome> {
  switch (land.kind) {
    case 'up_to_date': return outcome('up_to_date', { outcome: 'up_to_date', ref, oid: ours, ours, theirs, base: land.base });
    case 'fast_forward': {
      const r = await fastForward(t, { ref, from: ours, to: theirs });
      return outcome('fast_forward', { outcome: 'fast_forward', ref, oid: theirs, ours, theirs, base: land.base }, { 'git.merge.push.bytes': r.packBytes });
    }
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(land);
}

// The body runs as one Result-returning step inside the operation (an Err is thrown there, so the operation records its
// code on the root span); its refusals keep the names the decision inventory knows them by (mergeBranch#…).
/* oxlint-disable eslint/complexity -- one operation's steps in order: refs, merge base, landing, tree merge, commit, push */
export async function mergeBranch(url: string, spec: MergeSpec, options: MergeOptions = {}): Promise<MergeOutcome> {
  const { ref, author, committer, message, time, fastForwardOnly, noFastForward } = withDefaults(spec, mergeSpecDefaults());
  const { from } = spec;
  const { cache, signer, verify, rediff, attributes: attributesGiven } = withDefaults(options, mergeDefaults());
  validatePushRef(ref, false); const fromOid = orThrow(givenOid(from, 'from'));
  const person: ValidatedIdent | null = author ? stamp(author, time) : null;
  const committerPerson: ValidatedIdent | null = committer ? stamp(committer, time) : person;
  if (message !== null && message !== '') validateMessage(message);
  const attributes = orThrow(validateAttributes(attributesGiven));
  return operation('merge', url, operationOpts(options, { 'git.merge.ref': ref, 'git.merge.from': from, 'git.merge.ff_only': fastForwardOnly, 'git.merge.no_ff': noFastForward }), async ({ t, root, outcome }: OpContext): Promise<MergeOutcome> => orThrow(await (async (): Promise<Result<MergeOutcome, PlyError>> => {
    const { refs } = await lsRefs(t, isNone(fromOid) ? [ref, from] : [ref]);
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
    const upToDate = (base: string): MergeOutcome => outcome('up_to_date', { outcome: 'up_to_date', ref, oid: ours, ours, theirs, base });
    if (ours === theirs) return ok(upToDate(ours));
    const found = await mergeBaseResult(t, ours, theirs);
    if (!found.ok) return found;
    const { base: one, bases, depth, verdict } = found.value;
    root.set({ 'git.merge.base': one === null ? '' : one, 'git.merge.bases': bases.length, 'git.merge.base.depth': depth });
    const landing = decideMerge(verdict, ours, theirs, { ref, from, fastForwardOnly, noFastForward });
    if (!landing.ok) return landing;
    const land = landing.value;
    if (land.kind !== 'three_way') return ok(await landWithoutMerge(t, outcome, land, { ref, ours, theirs }));
    const { base } = land;
    // three-way: commits for the three trees (the commit-only packs from mergeBase did not carry trees)
    const [cB, cO, cT] = await Promise.all([commitBytesAt(t, base), commitBytesAt(t, ours), commitBytesAt(t, theirs)]);
    const tree = (c: { readonly data: Uint8Array }): string => parseCommit(c.data, t.limits).tree;
    const trees: Trees = { base: tree(cB), ours: tree(cO), theirs: tree(cT) };
    const blobCap = readLimit(t.limits, 'maxMergeBlobBytes');
    if (!blobCap.ok) return blobCap;
    const merger = blobMerger(t, blobCap.value, rediff);
    if (!merger.ok) return merger;
    const mergeBlob = merger.value;
    const attrTree = await attributeTree(t, attributes, trees);
    if (!attrTree.ok) return attrTree;
    root.set({ 'git.merge.attributes': attributes === null ? '' : attributes });
    const merged = await mergeTrees(t, cache, { ...trees, mergeBlob, driverFor: attrTree.value === null ? null : attributeDrivers(t, cache, attrTree.value) });
    const newTrees = merged.objects.filter(o => o.type === TYPE.TREE).length;
    root.set({ 'git.merge.content.merged': merged.contentMerged, 'git.merge.content.undecided': mergeBlob.stats.undecided, 'git.merge.content.unioned': mergeBlob.stats.unioned, 'git.merge.content.attr_binary': mergeBlob.stats.attrBinary, 'git.merge.trees.fetched': merged.fetched, 'git.merge.trees.new': newTrees, 'git.merge.conflicts': merged.conflicts.slice(0, 64), 'git.merge.conflicts.count': merged.conflicts.length });
    if (merged.conflicts.length > 0) return fail('merge_conflict', `conflicts: ${merged.conflicts.slice(0, 8).map(p => `${p} (${merged.reasons[p]})`).join(', ')}${merged.conflicts.length > 8 ? '…' : ''}`, { conflicts: merged.conflicts, reasons: merged.reasons } as ConflictDetail);
    const treeOid: string = merged.oid === null ? hashObject('tree', encodeTree([])) : merged.oid;
    if (!person || !committerPerson) return fail('bad_request', 'author is required for a merge commit');
    let commitData = encodeCommit({ tree: treeOid, parents: [ours, theirs], author: ident(person), committer: ident(committerPerson), message: (message === null ? `Merge ${short(from)} into ${short(ref)}` : message).replace(/\n?$/u, '\n') });
    if (signer) commitData = await signCommit(commitData, signer);
    const oid: string = hashObject('commit', commitData);
    const objects = uniqueObjects([{ type: TYPE.COMMIT, data: commitData, oid }, ...(merged.oid === null ? [{ type: TYPE.TREE, data: encodeTree([]), oid: treeOid }] : []), ...merged.objects]).map(o => ({ type: o.type, data: o.data }));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a validated ref as push's Refname (see Push)
    const r = await (push as unknown as Push)(t, { ref, oldOid: ours, newOid: oid, objects });
    if (verify) await verifyRef(t, root, 'git.merge', ref, oid);
    return ok(outcome('merge', { outcome: 'merge', ref, oid, tree: treeOid, ours, theirs, base, pushBytes: r.packBytes, newTrees, contentMerged: merged.contentMerged }, { 'git.merge.commit': oid, 'git.merge.tree': treeOid, 'git.merge.push.bytes': r.packBytes }));
  })()));
}
/* oxlint-enable eslint/complexity */
