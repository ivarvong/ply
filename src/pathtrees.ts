// A path walk in fewer round trips (#218, and the walk's later levels and editFile since the bench/compare finding).
// readFile, listTree and editFile read a commit, then one tree per path level, each a round trip that waits on the one
// before it: a tree's id is only known from its parent. A server that takes `filter combine:blob:none+tree:K` can be asked
// for an object together with the trees under it, no blobs, so one round trip brings PATH_TREE_LEVELS levels:
//   - a commit want (deepen 1) with tree:K: the commit and every tree at depth < K (the root is depth 0);
//   - a tree want with tree:K-1: that tree and the trees K-1 levels under it (a wanted tree's entries are its depth 0).
// K is the levels the walk still reads, capped at PATH_TREE_LEVELS: one fetch brings the level the walk needs and the
// whole level below it, of which the walk reads one tree. Two levels are an object and its children; one more is the
// children's children, the fan-out squared (gitlab-org/gitlab from the root: 48 trees / 36 KB at K = 2, 566 / 526 KB at
// K = 3, measured 2026-11-06), slower than the round trip it would save. So a walk of n tree levels is ceil(n / 2) fetches
// where it was n, the first of them the commit's.
//
// How wide the level below is cannot be known before the answer is read, so every such fetch runs under a budget,
// limits.maxPathTreesBytes, in place of maxPackBytes and maxInflatedTotal (budgeted): the pack is refused at that many
// band-1 bytes (v2Step) and at that many bytes of declared tree sizes plus LIMIT_OBJECT_OVERHEAD each, before any of
// them is inflated (the pack scan). An answer over the budget is not used, and the rest of that walk is one tree:0 fetch
// per level, as before: a walk pays for at most one answer it does not use (so too for any other failure of such a
// fetch). Nothing is asked when the transport's harvest has no
// room for a whole budget (maxHarvestBytes), or when the budget is 0.
//
// The pack is checked as a blob:none fallback pack is (fetchWide, fetchPackTree0): every object keyed by its computed hash
// (resolvePack), every commit and tree held to the caller's limits (checkWide, the wanted object under the full checks; an
// extra over a limit is dropped, #46 / SAFETY I30; a malformed object fails the fetch), the trees harvested into the
// transport's store, where the walk's tree:0 reads find them (objectAt). A tree that did not come is fetched by its level.
//
// Whether the server takes it is learned from its answer, never from its name (transport.ts pathTreesOf), per quirks
// record, and it is asked only of a record whose treeFilter is tree:0: a host known to refuse tree:0 (Artifacts: blob:none,
// every tree with the commit already) or to take no filter (stock git: everything) is not asked. Not known yet (a first
// contact included): this fetch and the tree:0 fetch of the same object run concurrently, so a refusal costs a request and
// no round trip, and a host that refuses tree:0 too sees one such request per record, beside its one refusal (#136).
// Taken: this fetch alone. Refused (GitHub: `filter 'combine' not supported`, `tree filter allows max depth 0`, git's own
// words under uploadpackfilter.combine.allow=false / tree.maxDepth=0): the tree:0 path alone. A failure of this fetch for
// any other reason is not used: the tree:0 fetch answers, and its answer and its errors are the walk's, as before. A
// timeout of it is kept as a refusal (the walk waited for it once; it is not asked to wait again on that record).
import type { PlyError } from './errors.js';
import type { Transport } from './transport.js';
import type { Oid } from './oid.js';
import type { Result } from './result.js';
import type { FetchedCommit } from './commit.js';
import type { FetchedObject } from './fetch.js';
import { commitWithTrees, isEmptyResponse, isFilterRejection, objectAt, treeWithTrees } from './fetch.js';
import { commitById, commitObject } from './commit.js';
import { TYPE } from './objects.js';
import { harvestBytes, learnPathTrees, pathTreesOf } from './transport.js';
import { lowered } from './limits.js';
import { thrownCodeIs, thrownText } from './boundary.js';

// The tree levels one fetch brings: the level the walk reads and the one below it.
export const PATH_TREE_LEVELS = 2;
// git's refusal of a depth past uploadpackfilter.tree.maxDepth (list-objects-filter-options.c), as GitHub sends it.
const DEPTH_REFUSED = 'tree filter allows max depth';
// The server said it does not take this filter: a refusal the filter phrases name (an HTTP 400 like Artifacts', or git's
// `filter '…' not supported`), git's depth refusal, or the empty answer of an upload-pack that takes no filter at all.
export const isPathTreesRefusal = (e: unknown): boolean => isFilterRejection(e) || isEmptyResponse(e) || (thrownCodeIs(e, 'remote_error') && thrownText(e).includes(DEPTH_REFUSED));

// The filter on a commit want for a walk that reads `levels` tree levels from the root.
export const pathTreesFilter = (levels: number): string => `combine:blob:none+tree:${Math.min(levels, PATH_TREE_LEVELS)}`;
// The filter on a tree want for a walk that reads another level under that tree: the tree and its child trees.
export const SUBTREES_FILTER = 'combine:blob:none+tree:1';

// The transport a path-trees fetch runs on: `t` with its pack bounds lowered to the budget. A view (as withParent): the
// quirks record, the harvest store and the spans' parent are `t`'s.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.create returns any; the view is `t` with one field shadowed
const budgeted = (t: Transport, budget: number): Transport => Object.create(t, { limits: { value: lowered(lowered(t.limits, 'maxPackBytes', budget), 'maxInflatedTotal', budget), enumerable: true } }) as Transport;

// One walk's reads: its commit and its trees, each with the level below it where the server takes that. `over` is the
// walk's own: a wider fetch of it failed (an answer past the budget, a refusal, anything else), after which it asks one
// object at a time. So one walk pays for at most one answer it does not use, whatever the server does with the filter.
export type PathWalk = {
  // The commit a walk of `levels` tree levels starts from (0: the commit alone). The answer, and every error, is the
  // tree:0 commit fetch's (commit.ts commitObject) whenever the wider fetch is not used.
  readonly commit: (oid: Oid, levels: number) => Promise<Result<FetchedObject, PlyError>>;
  // A tree the walk reads, when it reads `below` more levels under it. The answer, and every error, is the tree:0 fetch's
  // whenever the wider fetch is not used; a tree an earlier fetch of this transport harvested is answered from the store.
  readonly tree: (oid: Oid, below: number) => Promise<Result<FetchedObject, PlyError>>;
};
type Fetch = (t: Transport) => Promise<Result<FetchedObject, PlyError>>;
export function pathWalk(t: Transport): PathWalk {
  let over = false;
  // What a failed wider fetch teaches: this walk asks no more, and a refusal is the record's. So is a timeout: a server
  // that leaves this fetch unanswered would hold every later walk for as long (the fetch beside it, or after it, waits).
  const learn = (e: PlyError): void => {
    over = true;
    if (isPathTreesRefusal(e) || thrownCodeIs(e, 'timeout')) learnPathTrees(t.quirks, 'refused');
  };
  const ask = async (deep: Fetch, narrow: Fetch): Promise<Result<FetchedObject, PlyError>> => {
    const budget = t.limits.maxPathTreesBytes;
    const known = pathTreesOf(t.quirks);
    if (over || budget === 0 || t.quirks.treeFilter !== 'tree:0' || known === 'refused') return narrow(t);
    // whatever the answer holds is harvested: no room for a whole budget, no ask
    if (harvestBytes(t.objects) + budget > t.limits.maxHarvestBytes) return narrow(t);
    const view = budgeted(t, budget);
    if (known === 'taken') {
      const got = await deep(view);
      if (got.ok) return got;
      learn(got.error);
      return narrow(t);
    }
    const [got, plain] = await Promise.all([deep(view), narrow(t)]);
    if (got.ok) { learnPathTrees(t.quirks, 'taken'); return got; }
    learn(got.error);
    return plain;
  };
  return {
    // oxlint-disable-next-line typescript/promise-function-async -- the fetch's promise, passed through
    commit: (oid, levels) => {
      // oxlint-disable-next-line typescript/promise-function-async -- commitObject's promise, passed through
      const narrow: Fetch = on => commitObject(on, oid);
      // oxlint-disable-next-line typescript/promise-function-async -- commitWithTrees' promise, passed through
      return levels <= 0 ? narrow(t) : ask(on => commitWithTrees(on, oid, pathTreesFilter(levels)), narrow);
    },
    // oxlint-disable-next-line typescript/promise-function-async -- the fetch's promise, passed through
    tree: (oid, below) => {
      // oxlint-disable-next-line typescript/promise-function-async -- objectAt's promise, passed through
      const narrow: Fetch = on => objectAt(on, oid, { filter: 'tree:0', expectType: TYPE.TREE });
      // a harvested tree is answered from the store (objectAt): nothing to ask
      // oxlint-disable-next-line typescript/promise-function-async -- treeWithTrees' promise, passed through
      return below <= 0 || t.objects.has(oid) ? narrow(t) : ask(on => treeWithTrees(on, oid, SUBTREES_FILTER), narrow);
    },
  };
}

// Effect: the commit a walk of `levels` tree levels starts from, with as many of those levels as one fetch brings
// harvested. The answer (and every error) is commitById's whenever the wider fetch is not used.
// oxlint-disable-next-line typescript/promise-function-async -- commitById's promise, passed through
export function commitForWalk(t: Transport, oid: Oid, levels: number, walk: PathWalk = pathWalk(t)): Promise<Result<FetchedCommit, PlyError>> {
  return commitById(t, oid, walk.commit(oid, levels));
}
