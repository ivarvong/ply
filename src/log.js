// Recent history of a ref in one fetch, without a clone (#56).
//
//   readLog(url, { ref, limit = 20 }, opts) → { ref, oid, commits: [{ oid, tree, parents, author, committer, message, signed }], truncated }
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
import { thrown as fail } from './errors.js';
import { operation } from './operation.js';
import { resolveCommit, commitView } from './read.js';
import { fetchPackTree0 } from './fetchpack.js';
import { parseCommit, TYPE, TYPE_NAME } from './objects.js';
import { DEFAULT_LIMITS, requireLimit } from './limits.js';

export const DEFAULT_LOG_LIMIT = 20;
const isObject = v => v !== null && typeof v === 'object';

// Pure: the first-parent log of `head` over a deepen window. `commits` is oid → { parents } (every commit the pack held),
// `shallow` the server's shallow lines. Throws pack_corrupt when the window breaks the deepen contract. Returns
// { chain: [oid], truncated, cut } where `cut` says the chain stopped at a shallow commit before `limit`.
export function logWindow(commits, shallow, head, limit) {
  if (!commits.has(head)) throw fail('pack_corrupt', `commit ${head} not in the pack that wanted it`);
  const reach = new Set([head]); const q = [head];
  for (let i = 0; i < q.length; i++) for (const p of commits.get(q[i]).parents) if (commits.has(p) && !reach.has(p)) { reach.add(p); q.push(p); }
  const cut = new Set(shallow);
  for (const [oid, c] of commits) {
    if (!reach.has(oid)) throw fail('pack_corrupt', `commit ${oid} sent but not an ancestor of ${head}`);
    const missing = cut.has(oid) ? undefined : c.parents.find(p => !commits.has(p));
    if (missing) throw fail('pack_corrupt', `parent ${missing} of ${oid} withheld and ${oid} not reported shallow`);
  }
  const chain = [];
  for (let c = head; ;) {
    chain.push(c);
    const first = commits.get(c).parents[0];
    if (first === undefined) return { chain, truncated: false, cut: false };
    if (chain.length === limit) return { chain, truncated: true, cut: false };
    if (!commits.has(first)) return { chain, truncated: true, cut: true };
    c = first;
  }
}

// Effect: the window's pack, with a want that is not a commit (or not on the server) as the caller's not_found.
async function fetchWindow(t, commit, limit) {
  let r;
  try { r = await fetchPackTree0(t, { wants: [commit], filter: 'tree:0', deepen: limit }); } catch (e) {
    if (e?.code === 'remote_error' && /not our ref/.test(e.message)) throw fail('not_found', `commit ${commit} not found on the remote`);
    throw e;
  }
  const want = r.objects?.get(commit);
  if (want && want.type !== TYPE.COMMIT) throw fail('not_found', `${commit} is not a commit (${TYPE_NAME[want.type] ?? want.type})`);
  return r;
}

export async function readLog(url, spec = {}, opts = {}) {
  if (!isObject(spec)) throw fail('bad_request', 'readLog: the second argument must be an object ({ ref, limit })');
  if (!isObject(opts) || typeof opts.tracer?.start !== 'function') throw fail('bad_request', 'readLog: opts.tracer is required');
  const { ref = null, limit = DEFAULT_LOG_LIMIT, path } = spec;
  if (path !== undefined && path !== null) throw fail('bad_request', 'readLog: path filtering is not supported');
  const cap = requireLimit(opts.limits ?? DEFAULT_LIMITS, 'maxMergeDepth');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > cap) throw fail('bad_request', `readLog: limit must be an integer from 1 to ${cap} (limits.maxMergeDepth)`, { what: 'limit' });
  return operation('read_log', url, { ...opts, attrs: { 'git.read_log.ref': typeof ref === 'string' ? ref : 'HEAD', 'git.read_log.limit': limit } }, async ({ t, outcome }) => {
    const { name, commit } = await resolveCommit(t, ref);
    const r = await fetchWindow(t, commit, limit);
    const parsed = new Map();
    for (const [oid, o] of r.objects ?? []) if (o.type === TYPE.COMMIT) parsed.set(oid, parseCommit(o.data, t.limits));
    const w = logWindow(parsed, r.shallow ?? [], commit, limit);
    const commits = w.chain.map(oid => ({ oid, ...commitView(r.objects.get(oid).data, t.limits) }));
    return outcome('ok', { ref: name, oid: commit, commits, truncated: w.truncated }, {
      'git.read_log.oid': commit, 'git.read_log.commits': commits.length, 'git.read_log.truncated': w.truncated, 'git.read_log.cut': w.cut,
      'git.read_log.window.commits': parsed.size, 'git.read_log.window.shallow': (r.shallow ?? []).length, 'git.read_log.filter': r.filter,
    });
  });
}
