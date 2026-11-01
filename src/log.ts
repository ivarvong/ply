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
import { thrown as fail, plyError, isPlyError, orThrow, type CommitMiss, type PlyError } from './errors.js';
import { fromNullable } from './absent.js';
import { ok, err, assertNever } from './result.js';
import type { Result } from './result.js';
import type { OperationOpts } from './operation.js';
import { operation } from './operation.js';
import { resolveCommit, commitView } from './read.js';
import { fetchPackTree0 } from './fetchpack.js';
import { parseCommit, TYPE, nonCommitType } from './objects.js';
import { DEFAULT_LIMITS, requireLimit } from './limits.js';
import type { CommitView, ReadOptions } from './read.js';
import type { FetchPackResult } from './fetchpack.js';
import type { Transport } from './transport.js';
import { thrownCode, thrownReason } from './boundary.js';

type FetchedPack = FetchPackResult & { readonly filter: string | null };
type PackObjects = NonNullable<FetchPackResult['objects']>;

export const DEFAULT_LOG_LIMIT = 20;
const isObject = (v: unknown): v is object => v !== null && typeof v === 'object';

type Parents = { readonly parents: readonly string[] };
// Pure: the first-parent log of `head` over a deepen window. `commits` is oid → { parents } (every commit the pack held),
// `shallow` the server's shallow lines. Throws pack_corrupt when the window breaks the deepen contract. Returns
// { chain: [oid], truncated, cut } where `cut` says the chain stopped at a shallow commit before `limit`.
export type LogWindow = { readonly chain: string[]; readonly truncated: boolean; readonly cut: boolean };
export function logWindow(commits: ReadonlyMap<string, Parents>, shallow: Iterable<string>, head: string, limit: number): LogWindow {
  if (!commits.has(head)) throw fail('pack_corrupt', `commit ${head} not in the pack that wanted it`);
  // every oid in q is in `commits`: head was checked, and a parent joins only when present
  const reach = new Set([head]); const q = [head];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- see above (and no `!`: docs/STACK.md)
  for (const c of q) for (const p of (commits.get(c) as Parents).parents) if (commits.has(p) && !reach.has(p)) { reach.add(p); q.push(p); }
  const cut = new Set(shallow);
  for (const [oid, c] of commits) {
    if (!reach.has(oid)) throw fail('pack_corrupt', `commit ${oid} sent but not an ancestor of ${head}`);
    const missing = cut.has(oid) ? undefined : c.parents.find(p => !commits.has(p));
    if (missing !== undefined) throw fail('pack_corrupt', `parent ${missing} of ${oid} withheld and ${oid} not reported shallow`);
  }
  const chain: string[] = [];
  for (let c = head; ;) {
    chain.push(c);
    // c is head or a first parent the window holds (checked below before stepping to it)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- see above (and no `!`: docs/STACK.md)
    const first = (commits.get(c) as Parents).parents[0];
    if (first === undefined) return { chain, truncated: false, cut: false };
    if (chain.length === limit) return { chain, truncated: true, cut: false };
    if (!commits.has(first)) return { chain, truncated: true, cut: true };
    c = first;
  }
}

// Effect: the window's pack, with a want that is not a commit (or not on the server) as the caller's not_found.
async function fetchWindow(t: Transport, commit: string, limit: number): Promise<FetchedPack> {
  let r: FetchedPack;
  try { r = await fetchPackTree0(t, { wants: [commit], filter: 'tree:0', deepen: limit }); } catch (e) {
    if (thrownCode(e) === 'remote_error' && thrownReason(e) === 'not_our_ref') throw fail('not_found', `commit ${commit} not found on the remote`, { miss: { kind: 'commit', miss: { kind: 'absent', oid: commit } } });
    throw e;
  }
  const want = r.objects?.get(commit);
  if (want && want.type !== TYPE.COMMIT) {
    const found = nonCommitType(want.type);
    const detail = ((): { readonly shown: string; readonly miss: CommitMiss } => {
      switch (found.tag) {
        case 'notCommit':
          return { shown: found.name, miss: { kind: 'not_commit', oid: commit, type: found.name } };
        case 'delta':
          return { shown: found.name, miss: { kind: 'absent', oid: commit } };
        case 'commit':
          return { shown: 'commit', miss: { kind: 'absent', oid: commit } };
        case 'invalid':
          return { shown: String(want.type), miss: { kind: 'absent', oid: commit } };
      }
      // Stryker disable next-line ConditionalExpression,CallExpression: unreachable, the compiler's exhaustiveness check
      return assertNever(found);
    })();
    throw fail('not_found', `${commit} is not a commit (${detail.shown})`, { miss: { kind: 'commit', miss: detail.miss } });
  }
  return r;
}

export type LogSpec = { readonly ref?: string | null; readonly limit?: number; readonly path?: unknown };
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
export type LogOnSpec = Partial<LogOnFields>;
// Effect: one first-parent window of `commit` on the caller's transport. Trees of a blob:none answer are harvested
// into `t.objects`. A bad limit is bad_request; a pack that breaks the deepen contract is pack_corrupt.
export async function logOn(t: Transport, spec: LogOnSpec | null): Promise<Result<LogOnValue, PlyError>> {
  if (!isObject(spec)) return err(plyError('bad_request', 'logOn: the second argument must be an object ({ commit, limit })', { what: 'spec' }));
  if (typeof spec.commit !== 'string') return err(plyError('bad_request', 'logOn: commit must be a string', { what: 'commit' }));
  // A missing limit is the default. Null is not a limit: the caller passed it.
  const givenLimit = fromNullable(spec.limit);
  const limit = givenLimit.tag === 'none' ? DEFAULT_LOG_LIMIT : givenLimit.value;
  const commit = spec.commit;
  try {
    const cap = requireLimit(t.limits, 'maxMergeDepth');
    // A rejected limit is not a number. Null would pass a bare `< 1` by coercion, so it stays its own case.
    const depth = typeof limit === 'number' && Number.isSafeInteger(limit) ? limit : null;
    if (depth === null || depth < 1 || depth > cap) return err(plyError('bad_request', `logOn: limit must be an integer from 1 to ${cap} (limits.maxMergeDepth)`, { what: 'limit' }));
    const r = await fetchWindow(t, commit, depth);
    const parsed = new Map<string, Parents>();
    for (const [oid, o] of r.objects ?? []) if (o.type === TYPE.COMMIT) parsed.set(oid, parseCommit(o.data, t.limits));
    const w = logWindow(parsed, r.shallow ?? [], commit, depth);
    // every oid in the chain is a commit the pack held (logWindow walked them), so the pack and the object are there
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- see above (and no `!`: docs/STACK.md)
    const commits = w.chain.map(oid => ({ oid, ...commitView(((r.objects as PackObjects).get(oid) as { readonly data: Uint8Array }).data, t.limits) }));
    const answered = fromNullable(r.filter);
    return ok({ commits, truncated: w.truncated, cut: w.cut, filter: answered.tag === 'some' ? answered.value : null, window: { commits: parsed.size, shallow: (r.shallow ?? []).length } });
  } catch (e) {
    if (isPlyError(e)) return err(e);
    throw e;
  }
}
// oxlint-disable-next-line require-await -- async so that a throw while checking arguments is a rejection, as before
export async function readLog(url: string, spec: LogSpec = {}, opts: ReadOptions = {}): Promise<LogResult> {
  if (!isObject(spec)) throw fail('bad_request', 'readLog: the second argument must be an object ({ ref, limit })');
  if (!isObject(opts) || typeof opts.tracer?.start !== 'function') throw fail('bad_request', 'readLog: opts.tracer is required');
  const { ref = null, limit = DEFAULT_LOG_LIMIT, path } = spec;
  if (path !== undefined && path !== null) throw fail('bad_request', 'readLog: path filtering is not supported');
  const cap = requireLimit(opts.limits ?? DEFAULT_LIMITS, 'maxMergeDepth');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > cap) throw fail('bad_request', `readLog: limit must be an integer from 1 to ${cap} (limits.maxMergeDepth)`, { what: 'limit' });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the options' tracer, required at run time: EntryOptions (boundary.ts)
  return operation('read_log', url, ({ ...opts, attrs: { 'git.read_log.ref': typeof ref === 'string' ? ref : 'HEAD', 'git.read_log.limit': limit } } as OperationOpts), async ({ t, outcome }) => {
    const { name, commit } = await resolveCommit(t, ref);
    const got = orThrow(await logOn(t, { commit, limit }));
    return outcome('ok', { ref: name, oid: commit, commits: got.commits, truncated: got.truncated }, {
      'git.read_log.oid': commit, 'git.read_log.commits': got.commits.length, 'git.read_log.truncated': got.truncated, 'git.read_log.cut': got.cut,
      'git.read_log.window.commits': got.window.commits, 'git.read_log.window.shallow': got.window.shallow, 'git.read_log.filter': got.filter,
    });
  });
}
