// Recent history of a ref in one fetch, without a clone (#56).
//
//   readLog(url, { ref, limit = 20 }, opts) → { ref, oid, commits: [{ oid, tree, parents, author, committer, message, signed }], truncated }
//   logOn(transport, { commit, limit = 20 }) → Result<{ commits, truncated, cut, filter, window }>
//
// readLog resolves the ref, then logOn does the window on that transport. A caller that already holds the transport
// (and a commit id) uses logOn and keeps the harvested trees.
//
// Order: first parent, newest first: exactly `git rev-list --first-parent -n <limit> <ref>` (and `git log
// --first-parent`). That is the line a branch's history follows (one merge commit per landed branch, not the branch's own
// commits), and it is the only order a window of `limit` commits answers exactly from one fetch with no date heuristics.
// `parents` lists every parent, as git does. `truncated` is true when history continues past the last commit returned: it
// has a parent. Fewer than `limit` commits with `truncated` true means the server's history is cut there (a shallow
// repository on the server says so with a `shallow` line).
//
// The fetch: `want <commit>  deepen <limit>  filter tree:0`. A server that refuses tree:0 (Cloudflare Artifacts answers
// only blob:none) gets `blob:none` instead, learned from that answer and remembered in `quirks` (fetchpack.js
// fetchPackTree0): that pack also carries every tree of every commit in the window, which is checked and harvested so a
// following readFile/listTree on the same transport costs no round trip. Every commit, tree and tag in the pack passes
// assertFetched; a malformed one fails the read (`pack_corrupt`).
//
// The window is held to the deepen contract (#37, merge.js ancestors): the wanted commit is in the pack; every commit in
// it is an ancestor of the wanted one through the pack; a commit whose parent the pack lacks is one the server named
// `shallow`. Commits are hash-verified, so history cannot be forged, only withheld or padded; a pack that does either
// without saying so is `pack_corrupt`, never a short or foreign log.
//
// `path` (commits touching a path) is not supported: under tree:0 the window carries no trees, and comparing trees per
// commit would cost a fetch per commit on a tree:0 server. Passing one is `bad_request`.
//
// Errors are values here (logOn, logWindowResult); readLog and logWindow are the throwing public entries (orThrow).
import { fail, orThrow, type CommitMiss, type PlyError } from './errors.js';
import { at, field, fromNullable, fromNullish, mapGet, withDefaults } from './absent.js';
import type { Input } from './absent.js';
import { ok, assertNever, flatMapOption, getOrElse, none } from './result.js';
import type { Option, Result } from './result.js';
import type { OperationOpts } from './operation.js';
import { operation } from './operation.js';
import { resolveCommitResult, commitView } from './read.js';
import { fetchPackTree0 } from './fetchpack.js';
import { parseCommit, TYPE, nonCommitType } from './objects.js';
import { DEFAULT_LIMITS, readLimit } from './limits.js';
import type { CommitView, ReadOptions } from './read.js';
import type { FetchPackResult } from './fetchpack.js';
import type { Transport } from './transport.js';
import { thrownCodeIs, thrownReasonIs } from './boundary.js';
// oxlint-disable-next-line import/max-dependencies -- the read path's edge to the modules not yet converted to Result
import { attemptSync, caughtErr } from './commit.js';

type FetchedPack = FetchPackResult & { readonly filter: string | null };
type PackObjects = NonNullable<FetchPackResult['objects']>;

export const DEFAULT_LOG_LIMIT = 20;
const isObject = (v: unknown): v is object => v !== null && typeof v === 'object';

type Parents = { readonly parents: readonly string[] };
// Pure: the first-parent log of `head` over a deepen window. `commits` is oid → { parents } (every commit the pack held),
// `shallow` the server's shallow lines. Err pack_corrupt when the window breaks the deepen contract. Returns
// { chain: [oid], truncated, cut } where `cut` says the chain stopped at a shallow commit before `limit`.
export type LogWindow = { readonly chain: string[]; readonly truncated: boolean; readonly cut: boolean };
export function logWindowResult(commits: ReadonlyMap<string, Parents>, shallow: Iterable<string>, head: string, limit: number): Result<LogWindow, PlyError> {
  if (!commits.has(head)) return fail('pack_corrupt', `commit ${head} not in the pack that wanted it`);
  // every oid in q is in `commits`: head was checked, and a parent joins only when present
  const reach = new Set([head]); const q = [head];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- see above (and no `!`: docs/STACK.md)
  for (const c of q) for (const p of (commits.get(c) as Parents).parents) if (commits.has(p) && !reach.has(p)) { reach.add(p); q.push(p); }
  const cut = new Set(shallow);
  for (const [oid, c] of commits) {
    if (!reach.has(oid)) return fail('pack_corrupt', `commit ${oid} sent but not an ancestor of ${head}`);
    const missing: Option<string> = cut.has(oid) ? none : fromNullable(c.parents.find(p => !commits.has(p)));
    if (missing.tag === 'some') return fail('pack_corrupt', `parent ${missing.value} of ${oid} withheld and ${oid} not reported shallow`);
  }
  const chain: string[] = [];
  for (let c = head; ;) {
    chain.push(c);
    // c is head or a first parent the window holds (checked below before stepping to it)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- see above (and no `!`: docs/STACK.md)
    const first = at((commits.get(c) as Parents).parents, 0);
    if (first.tag === 'none') return ok({ chain, truncated: false, cut: false });
    if (chain.length === limit) return ok({ chain, truncated: true, cut: false });
    if (!commits.has(first.value)) return ok({ chain, truncated: true, cut: true });
    c = first.value;
  }
}
// The throwing entry (public API until the Result cut-over, docs/STACK.md).
export const logWindow = (commits: ReadonlyMap<string, Parents>, shallow: Iterable<string>, head: string, limit: number): LogWindow =>
  orThrow(logWindowResult(commits, shallow, head, limit));

// Effect: the window's pack, with a want that is not a commit (or not on the server) as the caller's not_found.
async function fetchWindow(t: Transport, commit: string, limit: number): Promise<Result<FetchedPack, PlyError>> {
  let r: FetchedPack;
  try { r = await fetchPackTree0(t, { wants: [commit], filter: 'tree:0', deepen: limit }); } catch (e) {
    if (thrownCodeIs(e, 'remote_error') && thrownReasonIs(e, 'not_our_ref')) return fail('not_found', `commit ${commit} not found on the remote`, { miss: { kind: 'commit', miss: { kind: 'absent', oid: commit } } });
    return caughtErr(e);
  }
  const want = flatMapOption(fromNullish(r.objects), objects => mapGet(objects, commit));
  if (want.tag === 'some' && want.value.type !== TYPE.COMMIT) {
    const wantType = want.value.type;
    const found = nonCommitType(wantType);
    const detail = ((): { readonly shown: string; readonly miss: CommitMiss } => {
      switch (found.tag) {
        case 'notCommit':
          return { shown: found.name, miss: { kind: 'not_commit', oid: commit, type: found.name } };
        case 'delta':
          return { shown: found.name, miss: { kind: 'absent', oid: commit } };
        case 'commit':
          return { shown: 'commit', miss: { kind: 'absent', oid: commit } };
        case 'invalid':
          return { shown: String(wantType), miss: { kind: 'absent', oid: commit } };
      }
      // Stryker disable next-line ConditionalExpression,CallExpression: unreachable, the compiler's exhaustiveness check
      return assertNever(found);
    })();
    return fail('not_found', `${commit} is not a commit (${detail.shown})`, { miss: { kind: 'commit', miss: detail.miss } });
  }
  return ok(r);
}

// What readLog takes. `ref: null` is the remote's HEAD; `path` is refused unless absent or null (see above).
export type LogConfig = { readonly ref: string | null; readonly limit: number; readonly path: unknown };
export type LogSpec = Input<LogConfig>;
export type LogCommit = CommitView & { readonly oid: string };
export type LogResult = { readonly ref: string; readonly oid: string; readonly commits: readonly LogCommit[]; readonly truncated: boolean };
// The window readLog returns, plus what the span already recorded: which filter answered, and how big the pack's
// commit set was. `cut` is true when the chain stopped on a shallow commit before `limit` (a shallow server).
export type LogOnValue = {
  readonly commits: readonly LogCommit[];
  readonly truncated: boolean;
  readonly cut: boolean;
  readonly filter: string | null;
  readonly window: { readonly commits: number; readonly shallow: number };
};
type LogOnFields = { readonly commit: unknown; readonly limit: unknown };
export type LogOnSpec = Input<LogOnFields>;
// Effect: one first-parent window of `commit` on the caller's transport. Trees of a blob:none answer are harvested
// into `t.objects`. A bad limit is bad_request; a pack that breaks the deepen contract is pack_corrupt.
export async function logOn(t: Transport, spec: LogOnSpec | null): Promise<Result<LogOnValue, PlyError>> {
  if (!isObject(spec)) return fail('bad_request', 'logOn: the second argument must be an object ({ commit, limit })', { what: 'spec' });
  if (typeof spec.commit !== 'string') return fail('bad_request', 'logOn: commit must be a string', { what: 'commit' });
  // A missing limit is the default. Null is not a limit: the caller passed it.
  const givenLimit = fromNullable(spec.limit);
  const limit = givenLimit.tag === 'none' ? DEFAULT_LOG_LIMIT : givenLimit.value;
  const commit = spec.commit;
  const cap = readLimit(t.limits, 'maxMergeDepth');
  if (!cap.ok) return cap;
  // A rejected limit is not a number. Null would pass a bare `< 1` by coercion, so it stays its own case.
  const depth = typeof limit === 'number' && Number.isSafeInteger(limit) ? limit : null;
  if (depth === null || depth < 1 || depth > cap.value) return fail('bad_request', `logOn: limit must be an integer from 1 to ${cap.value} (limits.maxMergeDepth)`, { what: 'limit' });
  const fetched = await fetchWindow(t, commit, depth);
  if (!fetched.ok) return fetched;
  const r = fetched.value;
  const objects: PackObjects = r.objects === null ? new Map() : r.objects;
  const parsed = new Map<string, Parents>();
  for (const [oid, o] of objects) {
    if (o.type !== TYPE.COMMIT) continue;
    const c = attemptSync(() => parseCommit(o.data, t.limits));
    if (!c.ok) return c;
    parsed.set(oid, c.value);
  }
  const w = logWindowResult(parsed, r.shallow, commit, depth);
  if (!w.ok) return w;
  const commits: LogCommit[] = [];
  for (const oid of w.value.chain) {
    // every oid in the chain is a commit the pack held (logWindow walked them), so the object is there
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    const view = attemptSync(() => commitView((objects.get(oid) as { readonly data: Uint8Array }).data, t.limits));
    if (!view.ok) return view;
    commits.push({ oid, ...view.value });
  }
  const answered = fromNullable(r.filter);
  return ok({ commits, truncated: w.value.truncated, cut: w.value.cut, filter: answered.tag === 'some' ? answered.value : null, window: { commits: parsed.size, shallow: r.shallow.length } });
}

// readLog's arguments, checked in the order the entry always checked them. `opts` needs a tracer with start().
function logArgs(spec: LogSpec, opts: ReadOptions): Result<{ readonly ref: string | null; readonly limit: number }, PlyError> {
  if (!isObject(spec)) return fail('bad_request', 'readLog: the second argument must be an object ({ ref, limit })');
  const start = flatMapOption(field(opts, 'tracer'), tracer => field(tracer, 'start'));
  if (!isObject(opts) || typeof getOrElse(start, null) !== 'function') return fail('bad_request', 'readLog: opts.tracer is required');
  const { ref, limit, path } = withDefaults<LogConfig>(spec, { ref: null, limit: DEFAULT_LOG_LIMIT, path: null });
  if (path !== null) return fail('bad_request', 'readLog: path filtering is not supported');
  // A null limits record is the default, as the nullish read had it.
  const cap = readLimit(getOrElse(fromNullish(opts.limits), DEFAULT_LIMITS), 'maxMergeDepth');
  if (!cap.ok) return cap;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > cap.value) return fail('bad_request', `readLog: limit must be an integer from 1 to ${cap.value} (limits.maxMergeDepth)`, { what: 'limit' });
  return ok({ ref, limit });
}
// oxlint-disable-next-line require-await -- async so that a refused argument is a rejection, as before
export async function readLog(url: string, spec: LogSpec = {}, opts: ReadOptions = {}): Promise<LogResult> {
  const { ref, limit } = orThrow(logArgs(spec, opts));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the options' tracer, required at run time: EntryOptions (boundary.ts)
  return operation('read_log', url, ({ ...opts, attrs: { 'git.read_log.ref': typeof ref === 'string' ? ref : 'HEAD', 'git.read_log.limit': limit } } as OperationOpts), async ({ t, outcome }) => {
    const { name, commit } = orThrow(await resolveCommitResult(t, ref));
    const got = orThrow(await logOn(t, { commit, limit }));
    return outcome('ok', { ref: name, oid: commit, commits: got.commits, truncated: got.truncated }, {
      'git.read_log.oid': commit, 'git.read_log.commits': got.commits.length, 'git.read_log.truncated': got.truncated, 'git.read_log.cut': got.cut,
      'git.read_log.window.commits': got.window.commits, 'git.read_log.window.shallow': got.window.shallow, 'git.read_log.filter': got.filter,
    });
  });
}
