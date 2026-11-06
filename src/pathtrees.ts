// A path walk's commit and the first levels of its tree in one fetch (#218). readFile and listTree read the commit, then
// one tree per path level, each a round trip that waits on the one before it. A server that takes
// `filter combine:blob:none+tree:K` answers a commit want (deepen 1) with the commit and every tree at depth < K, no blobs:
// one round trip where tree:0 takes K + 1. K is the levels the walk reads, capped at PATH_TREE_LEVELS: the levels below the
// root's children are the whole repository's fan-out (gitlab-org/gitlab: 48 trees / 36 KB at K = 2, 566 / 526 KB at
// K = 3, measured 2026-11-06), slower than the round trips they would save, so they are read one per level as before.
//
// The pack is checked as a blob:none fallback pack is (fetchWide, fetchPackTree0): every object keyed by its computed hash
// (resolvePack), every commit and tree held to the caller's limits (checkWide, the commit the wanted object; an extra over
// a limit is dropped, #46 / SAFETY I30; a malformed object fails the fetch), the trees harvested into the transport's
// store, where the walk's tree:0 reads find them (objectAt). A tree that did not come is fetched by its level as before.
//
// Whether the server takes it is learned from its answer, never from its name (transport.ts pathTreesOf), per quirks
// record. It is asked only of a server known to take tree:0 (an earlier request on the record settled it, transport.ts
// tree0Taken): a host that refuses tree:0 (Artifacts: blob:none, every tree with the commit already) or takes no filter
// (stock git: everything) never sees it, and a first contact is the tree:0 path alone, so #136's one refusal per remote
// stands. Tree:0 taken, this one not known yet: this fetch and the tree:0 commit fetch run concurrently, so a refusal costs
// a request and no round trip. Taken: this fetch alone. Refused (GitHub: `filter 'combine' not supported`, `tree filter
// allows max depth 0`, git's own words under uploadpackfilter.combine.allow=false / tree.maxDepth=0): the tree:0 path
// alone. A failure of this fetch for any other reason is not used: the tree:0 path answers, and its answer and its errors
// are the walk's, as before.
import type { PlyError } from './errors.js';
import type { Transport } from './transport.js';
import type { Oid } from './oid.js';
import type { Result } from './result.js';
import type { FetchedCommit } from './commit.js';
import { commitWithTrees, isEmptyResponse, isFilterRejection } from './fetch.js';
import { commitById } from './commit.js';
import { parseCommit } from './objects.js';
import { learnPathTrees, pathTreesOf, tree0Taken } from './transport.js';
import { map } from './result.js';
import { thrownCodeIs, thrownText } from './boundary.js';

// The deepest tree level fetched with the commit: the root (depth 0) and its children (depth 1).
export const PATH_TREE_LEVELS = 2;
// git's refusal of a depth past uploadpackfilter.tree.maxDepth (list-objects-filter-options.c), as GitHub sends it.
const DEPTH_REFUSED = 'tree filter allows max depth';
// The server said it does not take this filter: a refusal the filter phrases name (an HTTP 400 like Artifacts', or git's
// `filter '…' not supported`), git's depth refusal, or the empty answer of an upload-pack that takes no filter at all.
export const isPathTreesRefusal = (e: unknown): boolean => isFilterRejection(e) || isEmptyResponse(e) || (thrownCodeIs(e, 'remote_error') && thrownText(e).includes(DEPTH_REFUSED));

// The filter for a walk that reads `levels` tree levels (0: none, the commit alone).
export const pathTreesFilter = (levels: number): string => `combine:blob:none+tree:${Math.min(levels, PATH_TREE_LEVELS)}`;

// Effect: the commit and its trees at depth < K, harvested (fetch.ts commitWithTrees: a want that is not a commit, or a
// pack without it, is that fetch's error). Ok(commit), or the fetch's error: the caller decides.
const deepCommit = async (t: Transport, oid: Oid, levels: number): Promise<Result<FetchedCommit, PlyError>> => {
  const got = await commitWithTrees(t, oid, pathTreesFilter(levels));
  if (!got.ok) return got;
  const { data } = got.value;
  return map(parseCommit(data, t.limits), commit => ({ oid, data, commit }));
};

// Effect: the commit a walk of `levels` tree levels starts from, with as many of those levels as one fetch brings
// harvested. The answer (and every error) is commitById's whenever the deep fetch is not used.
export async function commitForWalk(t: Transport, oid: Oid, levels: number): Promise<Result<FetchedCommit, PlyError>> {
  const known = pathTreesOf(t.quirks);
  if (levels <= 0 || !tree0Taken(t.quirks) || known === 'refused') return commitById(t, oid);
  if (known === 'taken') {
    const deep = await deepCommit(t, oid, levels);
    if (deep.ok) return deep;
    if (isPathTreesRefusal(deep.error)) learnPathTrees(t.quirks, 'refused');
    return commitById(t, oid);
  }
  const [deep, narrow] = await Promise.all([deepCommit(t, oid, levels), commitById(t, oid)]);
  if (deep.ok) { learnPathTrees(t.quirks, 'taken'); return deep; }
  if (isPathTreesRefusal(deep.error)) learnPathTrees(t.quirks, 'refused');
  return narrow;
}
