// Read one file or one directory listing from a remote, without a clone: ls-refs → the commit (tree:0, deepen 1) → one
// tree per path level → the blob, STREAMED (inflate, then the caller). The latest chunk is held until the object
// hash and the pack trailer verify; a failure errors the stream without releasing it. Built from the same
// primitives as edit.js; carries no push, merge or pack-building code (asserted by test/bundle.test.js).
//
//   readFile(url, { ref, path }, opts) → { ref, commit, blob, mode, size, stream }    stream: ReadableStream<Uint8Array>
//   listTree(url, { ref, path }, opts) → { ref, commit, tree, entries: [{ name, mode, oid, type }] }
//   readCommit(url, { ref }, opts) → { ref, oid, tree, parents, author, committer, message, signed }   (no trees fetched
//                                    unless the server refuses tree:0; then the blob:none fallback applies)
//                                    an unborn HEAD, or that branch by name, is { empty: true, ref } — a state, not not_found
//   walkPath(transport, treeOid, comps, { cache }) → Result<{ tree, entry }, PlyError>   one tree per component, from a tree
//                                    the caller already has. not_found carries miss (ref, path, directory, submodule, …).
//
// `ref`: null/'HEAD' (the remote's HEAD), a full ref name, a short name resolved the way `git rev-parse` does it for a
// remote's refs (refs/<n>, refs/tags/<n>, refs/heads/<n> — tags win over branches, as in git), or a 40-hex commit oid.
// `{ abbrev: 'advertised' }` also accepts a 4–39 character lowercase hex prefix, unique among the tips that one ls-refs
// lists (HEAD, branches, tags, and peeled targets). A ref name wins over a prefix, as in git. The default `'off'`
// leaves a short hex string as a ref name. That answer is weaker than `git rev-parse`: an interior object is not a
// candidate. Annotated tags are peeled. `size` is known before the first content byte (the pack object header carries it), so a
// caller can send Content-Length. The stream errors (never ends cleanly) if the content does not hash to the blob's oid
// or the server sends a different number of bytes than it declared, and the chunk that would have completed the body
// stays held: a consumer that received every byte, or saw `done`, saw the right bytes.
//   openBlob(transport, oid, { maxBytes, follows }) → Result<{ kind:'stream', size, stream } | { kind:'too_big', size }, PlyError>
//   readBlob(transport, oid, { maxBytes, follows }) → Result<{ kind:'bytes', data } | { kind:'too_big', size }, PlyError>
// `too_big` is decided from the pack object header. The fetch is cancelled and no body byte is delivered.
//
// Errors are values inside this module (…Result functions, walkPath, openBlob, readBlob). The public entries readFile,
// listTree, readCommit, resolveCommit and refCandidates still raise theirs (orThrow at the boundary: docs/STACK.md step 2). The
// blob stream errors as a stream does: its pull, transform and flush raise the PlyError the consumer reads.
/* oxlint-disable import/max-dependencies -- an entry composes the protocol from one import per module, so its bundle carries nothing else */
import { fail, isPlyCode, orThrow, plyError } from './errors.js';
import type { Miss, PlyError } from './errors.js';
import { assertNever, err, getOrElse, isSome, mapOption, none, ok, some } from './result.js';
import type { Err, Option, Result } from './result.js';
import { operation } from './operation.js';
import { lsRefs, parseUnbornLine, type LsRefsResult } from './lsrefs.js';
import { discover } from './discover.js';
import { packStream, fetchObject, spInit, spStep, spFinish } from './fetch.js';
import { parseCommit, parseIdent, parseTree, objectHeader, TYPE, TYPE_NAME } from './objects.js';
import { streamingSha1 } from './sha1.js';
import { bufferSource, concat } from './bytes.js';
import { KIND } from './otel.js';
import type { Span } from './otel.js';
import { DEFAULT_LIMITS } from './limits.js';
import type { Limits } from './limits.js';
import { validateRef, validatePath } from './validate.js';
import type { OperationOpts } from './operation.js';
import type { SpState } from './fetch.js';
import type { Transport } from './transport.js';
import type { TreeEntry } from './objects.js';
import { isPlyThrown, thrownCodeOr, thrownText } from './boundary.js';
import { attempt, attemptSync, caughtErr, fetchCommit } from './commit.js';
import type { EntryOptions, TypeNames } from './boundary.js';
import { at, fromNullable, fromNullish, mapGet, readKey, withDefaults } from './absent.js';
import type { Input } from './absent.js';

/* oxlint-disable no-await-in-loop -- a stream is consumed in order: each write waits for the inflate side (back-pressure) */
/* oxlint-disable require-await -- the entry points are async so that a refused argument is a rejection, as before */
/* oxlint-disable unicorn/explicit-length-check, require-unicode-regexp, typescript/prefer-includes -- bundle budget: the JS's truthy length checks and non-unicode regexes, byte for byte (no behaviour change); RegExp#test, not includes: a thrown value's message may be no string at run time */

const OID = /^[0-9a-f]{40}$/;
// null or the platform's missing value: what a caller's `ref` or `path` left out.
const isNothing = (v: unknown): boolean => fromNullish(v).tag === 'none';

// Pure: what to ask ls-refs for, and which answer wins. git's ref_rev_parse_rules minus the remote-tracking forms.
// `ref` is the caller's, checked here: anything but null, the missing value or a string is bad_request.
export function refCandidatesResult(ref: unknown): Result<string[], PlyError> {
  if (isNothing(ref) || ref === '' || ref === 'HEAD') return ok(['HEAD']);
  if (typeof ref !== 'string') return fail('bad_request', 'ref must be a string');
  if (OID.test(ref)) return ok([]);
  if (ref.startsWith('refs/')) return attemptSync(() => [validateRef(ref)]);
  return attemptSync(() => [`refs/${ref}`, `refs/tags/${ref}`, `refs/heads/${ref}`].map(r => validateRef(r)));
}
// The throwing entry (public API until the Result cut-over).
export const refCandidates = (ref: unknown): string[] => orThrow(refCandidatesResult(ref));

// git ls-tree's object types.
export type EntryType = 'tree' | 'commit' | 'blob';
// Pure: git ls-tree's type for a tree entry mode.
export const entryType = (mode: string): EntryType => {
  if (mode === '40000') return 'tree';
  return mode === '160000' ? 'commit' : 'blob';
};
// Pure: git ls-tree prints modes as %06o (trees as 040000); the tree object stores them without the leading zero.
export const lsMode = (mode: string): string => mode.padStart(6, '0');

// The caller's name and the unborn target name the same branch: HEAD, the full ref, or the short branch name.
const sameBranch = (requested: unknown, full: string): boolean => {
  const name = isNothing(requested) || requested === '' ? 'HEAD' : requested;
  return typeof name === 'string' && (name === full || name === 'HEAD' || (!name.startsWith('refs/') && full === `refs/heads/${name}`));
};

// Effect: the unborn HEAD's target, or None when the server does not advertise ls-refs=unborn or lists no unborn line
// (a deleted branch, a born HEAD). discover runs only on a ref miss; the happy path never asks.
async function unbornTarget(t: Transport): Promise<Result<Option<string>, PlyError>> {
  const info = await attempt(async () => discover(t));
  if (!info.ok) return info;
  if (!info.value.lsRefsUnborn) return ok(none);
  const listed = await attempt(async () => lsRefs(t, ['HEAD'], { unborn: parseUnbornLine }));
  if (!listed.ok) return listed;
  const target = mapOption(fromNullish(listed.value.unborn), u => u.target);
  return ok(getOrElse(target, '') === '' ? none : target);
}

// A ref as the caller names it: null or 'HEAD' for the remote's HEAD (as is '' or leaving it out), a name, or a 40-hex oid.
export type RefSpec = string | null;
export type Resolved = { readonly name: string; readonly commit: string };
// How far a short hex string is an object id. `'off'` (the default): it is a ref name. `'advertised'`: after the name
// misses, it is a prefix of an advertised tip.
export type AbbrevMode = 'advertised' | 'off';
const ABBREV = /^[0-9a-f]{4,39}$/;
// Pure, over one ls-refs answer. `unique_among_advertised` is one oid (the ref names are every listing that carried it,
// as the oid or as a peeled target). `none`: no advertised oid starts with the prefix. `ambiguous`: more than one oid does.
// A bad prefix (not 4..39 lowercase hex) is `bad_request`, not a kind.
export type AbbrevResolution =
  | { readonly kind: 'unique_among_advertised'; readonly oid: string; readonly refs: readonly string[] }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous'; readonly oids: readonly string[] };
export function resolveAbbrev(prefix: string, listed: LsRefsResult): Result<AbbrevResolution, PlyError> {
  if (!ABBREV.test(prefix)) return fail('bad_request', 'abbreviated oid must be 4..39 lowercase hex', { what: 'ref' });
  const byOid = new Map<string, string[]>();
  for (const rec of listed.refs.values()) {
    const peeled = fromNullish(rec.peeled);
    const hits: ReadonlyArray<readonly [string, string]> = peeled.tag === 'none' ? [[rec.oid, rec.name]] : [[rec.oid, rec.name], [peeled.value, rec.name]];
    for (const [oid, name] of hits) {
      if (!oid.startsWith(prefix)) continue;
      const names = mapGet(byOid, oid);
      if (names.tag === 'none') byOid.set(oid, [name]);
      else if (!names.value.includes(name)) names.value.push(name);
    }
  }
  const oids = [...byOid.keys()].toSorted();
  const oid = at(oids, 0);
  if (oid.tag === 'none') return ok({ kind: 'none' });
  if (oids.length > 1) return ok({ kind: 'ambiguous', oids });
  return ok({ kind: 'unique_among_advertised', oid: oid.value, refs: getOrElse(mapGet(byOid, oid.value), []) });
}
// The name missed. A unique advertised oid is that commit; more than one is bad_request; none leaves the caller to
// report not_found. The prefix already matched ABBREV, so resolveAbbrev's own bad_request does not run.
function advertisedCommit(prefix: string, listed: LsRefsResult): Result<Option<Resolved>, PlyError> {
  const resolved = resolveAbbrev(prefix, listed);
  if (!resolved.ok) return resolved;
  const found = resolved.value;
  switch (found.kind) {
    case 'unique_among_advertised': return ok(some({ name: found.oid, commit: found.oid }));
    case 'ambiguous': return fail('bad_request', `abbreviated oid ${prefix} matches ${found.oids.length} advertised objects`, { what: 'ref', got: found.oids });
    case 'none': return ok(none);
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(found);
}
// One ls-refs. `hit` is the ref name, a bare oid, or a unique advertised prefix. `miss` is the name not listed and the
// prefix not unique. The abbrev refusal lives here so resolveCommitResult's only fail() is not_found.
type Lookup = { readonly kind: 'hit'; readonly resolved: Resolved } | { readonly kind: 'miss'; readonly candidates: readonly string[] };
async function lookupRef(t: Transport, ref: unknown, abbrev: AbbrevMode): Promise<Result<Lookup, PlyError>> {
  if (abbrev !== 'off' && abbrev !== 'advertised') return fail('bad_request', 'abbrev must be "advertised" or "off"', { what: 'abbrev' });
  const named = refCandidatesResult(ref);
  if (!named.ok) return named;
  const cands = named.value;
  // refCandidates answers [] only for a 40-hex oid string (anything else is a name list, or it refused).
  if (cands.length === 0 && typeof ref === 'string') return ok({ kind: 'hit', resolved: { name: ref, commit: ref } });
  // null: this call is a name. A string: the prefix, and the listing is wide enough to answer it.
  const prefix = abbrev === 'advertised' && typeof ref === 'string' && ABBREV.test(ref) ? ref : null;
  const listing = await attempt(async () => lsRefs(t, prefix === null ? cands : [...cands, 'HEAD', 'refs/heads/', 'refs/tags/']));
  if (!listing.ok) return listing;
  const listed = listing.value;
  for (const name of cands) {
    const r = mapGet(listed.refs, name);
    if (r.tag === 'some') return ok({ kind: 'hit', resolved: { name: name === 'HEAD' ? getOrElse(fromNullish(listed.head), 'HEAD') : name, commit: getOrElse(fromNullish(r.value.peeled), r.value.oid) } });
  }
  if (prefix !== null) {
    const found = advertisedCommit(prefix, listed);
    if (!found.ok) return found;
    if (found.value.tag === 'some') return ok({ kind: 'hit', resolved: found.value.value });
  }
  return ok({ kind: 'miss', candidates: cands });
}

export type ResolveConfig = { readonly abbrev: AbbrevMode };
export type ResolveOptions = Input<ResolveConfig>;
// Effect: ref → { name, commit } (annotated tags peeled; a bare oid is taken as given and checked by the commit fetch).
// `abbrev: 'advertised'` asks once for the name's candidates plus HEAD, branches and tags, tries the name first, then
// the prefix. `'off'` is the candidates alone. A miss is not_found, and an unborn HEAD the caller named is head_unborn.
export async function resolveCommitResult(t: Transport, ref: unknown, options: ResolveOptions = {}): Promise<Result<Resolved, PlyError>> {
  const { abbrev } = withDefaults<ResolveConfig>(options, { abbrev: 'off' });
  const looked = await lookupRef(t, ref, abbrev);
  if (!looked.ok) return looked;
  if (looked.value.kind === 'hit') return ok(looked.value.resolved);
  const { candidates } = looked.value;
  const head = getOrElse(at(candidates, 0), '') === 'HEAD';
  // The unborn question is a second ls-refs, and only after a miss: the advertisement is read then, and `unborn` is
  // sent only when the server lists ls-refs=unborn. A path miss never reaches here.
  const unborn = await unbornTarget(t);
  if (!unborn.ok) return unborn;
  // refCandidates refused a non-string, and a HEAD miss does not read this. The false arm stays so the type is a string.
  const asked = typeof ref === 'string' ? ref : '';
  const target = unborn.value;
  let miss: Miss;
  if (target.tag === 'some' && sameBranch(ref, target.value)) miss = { kind: 'head_unborn', target: target.value };
  else if (head) miss = { kind: 'head_absent' };
  else miss = { kind: 'ref', ref: asked, candidates };
  return fail('not_found', head ? 'remote HEAD is unborn or absent (some hosts point HEAD at a deleted branch); pass ref explicitly' : `ref ${asked} not found`, { miss });
}
// The throwing entry (public API until the Result cut-over).
export async function resolveCommit(t: Transport, ref: unknown, options: ResolveOptions = {}): Promise<Resolved> {
  return orThrow(await resolveCommitResult(t, ref, options));
}

export { fetchCommit, type FetchedCommit, type CommitMiss } from './commit.js';

// An ident for JSON. `time` is ISO-8601 UTC, `epoch` the raw seconds, `tz` the offset as written (+0530).
export type IdentView = { readonly name: string; readonly email: string; readonly time: string | null; readonly epoch: number | null; readonly tz: string };
// Pure: an ident line's view (null for a line parseIdent cannot read).
const identView = (line: unknown): IdentView | null => {
  const p = parseIdent(line);
  if (!p) return null;
  const epoch = p.time === null ? null : Number(p.time);
  const d = epoch === null ? null : new Date(epoch * 1000);
  return { name: p.name, email: p.email, time: d && !Number.isNaN(d.getTime()) ? d.toISOString().replace('.000Z', 'Z') : null, epoch, tz: p.tz };
};

// The JSON view of a commit object. `signed` is whether it carries a gpgsig/gpgsig-sha256 header (any format:
// OpenPGP, SSH, X.509); it says nothing about whether the signature verifies. The message is the raw body, UTF-8.
export type CommitView = {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: IdentView | null;
  readonly committer: IdentView | null;
  readonly message: string;
  readonly signed: boolean;
};
// Pure: a commit object's view. parseCommit (objects.ts) throws on a malformed commit; this is public API that throws.
export function commitView(data: Uint8Array, limits: Limits = DEFAULT_LIMITS): CommitView {
  const c: { readonly tree: string; readonly parents: readonly string[]; readonly author: string; readonly committer: string; readonly message: string | null; readonly extra: readonly string[] } = parseCommit(data, limits);
  return { tree: c.tree, parents: c.parents, author: identView(c.author), committer: identView(c.committer), message: c.message === null ? '' : c.message, signed: c.extra.some(l => /^gpgsig(-sha256)? /.test(l)) };
}

// The options operation() reads pass through (tracer, auth, fetchImpl, limits, transport, …).
export type ReadOptions = EntryOptions;
// Trees by oid, kept by the caller across reads (immutable: an oid names its bytes).
export type TreeCache = Map<string, Uint8Array>;
export type CommitResult = CommitView & { readonly ref: string; readonly oid: string };
// An unborn HEAD (or that branch by name): git log's "does not have any commits yet". Not a not_found.
export type EmptyCommit = { readonly empty: true; readonly ref: string };

// What readCommit, listTree and readFile take as their second argument. `ref: null` is the remote's HEAD.
export type RefConfig = { readonly ref: RefSpec };
export type ReadCommitSpec = Input<RefConfig>;
// An unborn HEAD the caller named is a state (EmptyCommit), not a failure. Every other answer is the resolution's own.
const unbornState = (r: Result<Resolved, PlyError>): Option<EmptyCommit> => {
  if (r.ok || r.error.code !== 'not_found' || r.error.miss.kind !== 'head_unborn') return none;
  return some({ empty: true, ref: r.error.miss.target });
};
export async function readCommit(url: string, spec: ReadCommitSpec = {}, opts: ReadOptions = {}): Promise<CommitResult | EmptyCommit> {
  const { ref } = withDefaults<RefConfig>(spec, { ref: null });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the options' tracer, required at run time: EntryOptions (boundary.ts)
  return operation('read_commit', url, ({ ...opts, attrs: { 'git.read_commit.ref': ref === null ? 'HEAD' : ref } } as OperationOpts), async ({ t, outcome }) => {
    const resolved = await resolveCommitResult(t, ref);
    const empty = unbornState(resolved);
    if (empty.tag === 'some') return outcome('ok', empty.value);
    const { name, commit } = orThrow(resolved);
    const view = commitView(orThrow(await fetchCommit(t, commit)).data, t.limits);
    return outcome('ok', { ref: name, oid: commit, ...view }, { 'git.read_commit.oid': commit, 'git.read_commit.parents': view.parents.length, 'git.read_commit.signed': view.signed });
  });
}

// Effect: a tree's bytes by one tree:0 fetch, kept in the caller's cache.
async function fetchTree(t: Transport, cache: TreeCache, oid: string): Promise<Result<Uint8Array, PlyError>> {
  const fetched = await attempt(async () => fetchObject(t, { oid, filter: 'tree:0', expectType: TYPE.TREE }));
  if (!fetched.ok) return fetched;
  cache.set(oid, fetched.value.data);
  return ok(fetched.value.data);
}
// A failure inside a span: recorded on it (the span's own end follows), and passed on.
const spanErr = <E>(span: Span, r: Err<E>): Err<E> => { span.error(r.error); return r; };

export type Walked = { readonly tree: string; readonly entry: TreeEntry | null };
export type WalkConfig = { readonly cache: TreeCache };
export type WalkOptions = Input<WalkConfig>;
// Effect: walk `comps` from a tree the caller already has. `tree` is that starting oid; `entry` is the last component
// (null when comps is empty). A missing component or a non-directory along the way is not_found with its miss. Each
// level is a `git.read.tree` span under the transport's parent, so a readFile/listTree walk stays on that trace.
export async function walkPath(t: Transport, treeOid: string, comps: readonly string[], options: WalkOptions = {}): Promise<Result<Walked, PlyError>> {
  const { cache } = withDefaults<WalkConfig>(options, { cache: new Map<string, Uint8Array>() });
  let here = treeOid;
  let entry: TreeEntry | null = null;
  for (const [depth, name] of comps.entries()) {
    // oxlint-disable-next-line no-loop-func -- the span runs to completion inside this iteration (awaited)
    const level = await t.tracer.span('git.read.tree', { parent: t.parent, attrs: { 'git.read.tree.depth': depth, 'git.read.tree.oid': here, 'git.read.tree.lookup': name } }, async (span): Promise<Result<TreeEntry, PlyError>> => {
      const cached = mapGet(cache, here);
      span.set({ 'git.read.tree.cache_hit': isSome(cached) });
      const tree = cached.tag === 'some' ? ok(cached.value) : await fetchTree(t, cache, here);
      if (!tree.ok) return spanErr(span, tree);
      const entries = attemptSync(() => parseTree(tree.value, t.limits));
      if (!entries.ok) return spanErr(span, entries);
      const found = fromNullable(entries.value.find(x => x.name === name));
      span.set({ 'git.read.tree.entries': entries.value.length, 'git.read.tree.entry.found': found.tag === 'some', 'git.read.tree.entry.mode': getOrElse(mapOption(found, f => f.mode), '') });
      if (found.tag === 'none') return spanErr(span, fail('not_found', `path component ${name} not found`, { miss: { kind: 'path', missing: name, existingPath: comps.slice(0, depth).join('/') } }));
      if (depth < comps.length - 1 && found.value.mode !== '40000') return spanErr(span, fail('not_found', `${name} is not a directory`, { miss: { kind: 'not_directory', path: comps.slice(0, depth + 1).join('/'), mode: found.value.mode } }));
      return ok(found.value);
    });
    if (!level.ok) return level;
    entry = level.value;
    here = entry.oid;
  }
  return ok({ tree: treeOid, entry });
}

// Effect: walk `comps` from the commit's root tree. `tree` is that root (walkPath's tree is the tree it started from).
async function walk(t: Transport, root: Span, { commit, comps, cache, limits }: { readonly commit: string; readonly comps: readonly string[]; readonly cache: TreeCache; readonly limits: Limits }): Promise<Result<Walked, PlyError>> {
  const fetched = await fetchCommit(t, commit);
  if (!fetched.ok) return fetched;
  const info = attemptSync(() => parseCommit(fetched.value.data, limits));
  if (!info.ok) return info;
  root.set({ 'git.read.commit': commit, 'git.read.tree.root': info.value.tree });
  const walked = await walkPath(t, info.value.tree, comps, { cache });
  if (!walked.ok) return walked;
  return ok({ tree: info.value.tree, entry: walked.value.entry });
}

// A path as the entries take it: validated components. With `allowRoot`, a missing, null, empty or '/' path is the root.
export const pathComps = (path: unknown, limits: Limits, { allowRoot }: { readonly allowRoot: boolean }): Result<string[], PlyError> => {
  if (allowRoot && (isNothing(path) || path === '' || path === '/')) return ok([]);
  return attemptSync(() => validatePath(typeof path === 'string' ? path.replace(/\/$/, '') : path, limits));
};

// What listTree and readFile take as their second argument. `path: null` is the root for listTree, and refused by readFile.
export type PathConfig = RefConfig & { readonly path: string | null };
export type PathSpec = Input<PathConfig>;
// The options of listTree and readFile: operation()'s, plus the caller's tree cache.
export type TreeReadConfig = { readonly cache: TreeCache; readonly limits: Limits };
export type TreeReadOptions = ReadOptions & Input<TreeReadConfig>;
// A null or missing limits record is the default, as the nullish read had it; the cache is fresh per call.
const treeReadConfig = (options: TreeReadOptions): TreeReadConfig => ({
  cache: getOrElse(readKey(options, 'cache'), new Map<string, Uint8Array>()),
  limits: getOrElse(fromNullish(options.limits), DEFAULT_LIMITS),
});

export type ListEntry = { readonly name: string; readonly mode: string; readonly oid: string; readonly type: EntryType };
export type ListResult = { readonly ref: string; readonly commit: string; readonly tree: string; readonly entries: readonly ListEntry[] };
// The listed directory: the walk's last entry when it is a tree, the root when the path was. not_found otherwise.
function listedDir(walked: Walked, comps: readonly string[]): Result<string, PlyError> {
  const { entry } = walked;
  if (entry === null) return ok(walked.tree);
  if (entry.mode !== '40000') return fail('not_found', `${comps.join('/')} is not a directory (mode ${entry.mode})`, { miss: { kind: 'not_directory', path: comps.join('/'), mode: entry.mode } });
  return ok(entry.oid);
}
export async function listTree(url: string, spec: PathSpec = {}, options: TreeReadOptions = {}): Promise<ListResult> {
  const { ref, path } = withDefaults<PathConfig>(spec, { ref: null, path: '' });
  const { cache, limits } = treeReadConfig(options);
  const comps = orThrow(pathComps(path, limits, { allowRoot: true }));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the options' tracer, required at run time: EntryOptions (boundary.ts)
  return operation('ls_tree', url, ({ ...options, attrs: { 'git.ls_tree.ref': ref === null ? 'HEAD' : ref, 'git.ls_tree.path': comps.join('/'), 'git.ls_tree.path.depth': comps.length } } as OperationOpts), async ({ t, root, outcome }) => {
    const { name, commit } = orThrow(await resolveCommitResult(t, ref));
    // the tracer operation() started the root span on (opts.tracer)
    const walked = orThrow(await walk(t, root, { commit, comps, cache, limits }));
    const oid = orThrow(listedDir(walked, comps));
    const cached = mapGet(cache, oid);
    const data = cached.tag === 'some' ? cached.value : orThrow(await fetchTree(t, cache, oid));
    const entries: readonly TreeEntry[] = parseTree(data, limits);
    return outcome('ok', { ref: name, commit, tree: oid, entries: entries.map(e => ({ name: e.name, mode: lsMode(e.mode), oid: e.oid, type: entryType(e.mode) })) }, { 'git.ls_tree.tree': oid, 'git.ls_tree.entries': entries.length });
  });
}

export type FileResult = {
  readonly ref: string;
  readonly commit: string;
  readonly blob: string;
  readonly mode: string;
  readonly size: number;
  readonly stream: ReadableStream<Uint8Array>;
};
// The file's entry: a symlink's blob is its target (what `git show <ref>:<path>` prints); a directory has no blob, and a
// gitlink has none in this repository.
function fileEntry(entry: TreeEntry, comps: readonly string[]): Result<TreeEntry, PlyError> {
  if (entry.mode === '40000') return fail('not_found', `${comps.join('/')} is a directory`, { miss: { kind: 'is_directory', path: comps.join('/'), tree: entry.oid } });
  if (entry.mode === '160000') return fail('not_found', `${comps.join('/')} is a submodule (commit ${entry.oid})`, { miss: { kind: 'submodule', path: comps.join('/'), commit: entry.oid } });
  return ok(entry);
}
// The root span ends when the stream is open (size known); the content's own span, `git.read.blob`, ends when the
// stream does, with the bytes delivered and whether the oid verified. It outlives the root, so it is not the root's child
// but the root of its own trace, linked both ways (follows_from / followed_by): README "Span lifetimes".
export async function readFile(url: string, spec: PathSpec = {}, options: TreeReadOptions = {}): Promise<FileResult> {
  const { ref, path } = withDefaults<PathConfig>(spec, { ref: null, path: null });
  const { cache, limits } = treeReadConfig(options);
  const comps = orThrow(pathComps(path, limits, { allowRoot: false }));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the options' tracer, required at run time: EntryOptions (boundary.ts)
  return operation('read', url, ({ ...options, attrs: { 'git.read.ref': ref === null ? 'HEAD' : ref, 'git.read.path': comps.join('/'), 'git.read.path.depth': comps.length } } as OperationOpts), async ({ t, root, outcome }) => {
    const { name, commit } = orThrow(await resolveCommitResult(t, ref));
    // comps is non-empty (validatePath refuses an empty path), so the walk ends at an entry
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- see above (and no `!`: docs/STACK.md)
    const entry = orThrow(fileEntry(orThrow(await walk(t, root, { commit, comps, cache, limits })).entry as TreeEntry, comps));
    // oxlint-disable-next-line no-use-before-define -- the JS's order (readFile, then openBlob): a function declaration, hoisted; the bundle's gzip budget
    const opened = orThrow(await openBlob(t, entry.oid, { follows: root }));
    return outcome('ok', { ref: name, commit, blob: entry.oid, mode: lsMode(entry.mode), size: opened.size, stream: opened.stream }, { 'git.read.blob': entry.oid, 'git.read.blob.size': opened.size, 'git.read.blob.mode': entry.mode });
  });
}

export type BlobStream = { readonly kind: 'stream'; readonly size: number; readonly stream: ReadableStream<Uint8Array> };
export type BlobTooBig = { readonly kind: 'too_big'; readonly size: number };
export type OpenedBlob = BlobStream | BlobTooBig;
// `maxBytes`: the declared size above which the blob is too_big (left out: no cap). `follows`: the span the stream
// follows (null: none).
export type BlobConfig = { readonly maxBytes: number; readonly follows: Span | null };
export type BlobOpts = Input<BlobConfig>;
// The options without a cap: the answer is always a stream.
export type FollowOpts = Input<Pick<BlobConfig, 'follows'>>;
export type CappedOpts = Pick<BlobConfig, 'maxBytes'> & FollowOpts;

// The fail-site recorder (test/space/failsite-hook.mjs) installs this only when PLY_FAILSITES is set. A guard, not a
// cast: under the hook the value is a function and the property is absent otherwise, so the call is a no-op in a bundle.
const FAIL_SITE = Symbol.for('ply.failsite');
const isFailSiteRecorder = (v: unknown): v is (holder: (e: unknown) => unknown) => void => typeof v === 'function';
type BodyState = Extract<SpState, { readonly phase: 'body' }>;
// A pull of the pack stream, or a parser step, as a value: what it threw is the failure (failHere classifies it).
const nextChunk = async (it: AsyncIterator<Uint8Array>): Promise<Result<IteratorResult<Uint8Array>, unknown>> => {
  try { return ok(await it.next()); } catch (e) { return err(e); }
};
const stepHeader = (sp: SpState, chunk: Uint8Array): Result<ReturnType<typeof spStep>, unknown> => {
  try { return ok(spStep(sp, chunk)); } catch (e) { return err(e); }
};
// Effect: pull until the object header is read (→ type and size). The zlib bytes after it go to `early`.
async function blobHeader(it: AsyncIterator<Uint8Array>, early: Uint8Array[]): Promise<Result<BodyState, unknown>> {
  let sp: SpState = spInit();
  while (sp.phase !== 'body') {
    const next = await nextChunk(it);
    if (!next.ok) return next;
    if (next.value.done === true) return err(plyError('pack_corrupt', 'pack ended before the object header'));
    const r = stepHeader(sp, next.value.value);
    if (!r.ok) return r;
    sp = r.value.state;
    early.push(...r.value.zlib);
  }
  if (sp.type !== TYPE.BLOB) return err(plyError('pack_corrupt', `expected blob, got ${getOrElse<string | number>(fromNullish((TYPE_NAME as TypeNames)[sp.type]), sp.type)}`));
  return ok(sp);
}
// Effect: one blob on the caller's transport. Reads the pack until the object header (→ size). A declared size above
// `maxBytes` is `{ kind: 'too_big' }`: the fetch is cancelled and no body byte is delivered (`git.read.blob.header_only`).
// Otherwise the zlib bytes go through DecompressionStream and a verifying transform. The transform releases every chunk
// but the latest as it arrives, and releases the latest only after the pack trailer and the object hash verify. A failure
// errors the stream with that chunk still held, so the body never completes on unverified bytes. Back-pressure: the pump
// awaits each write, so at most one network chunk and one inflate chunk are in flight beyond the chunk being held.
// `follows` is the span the stream follows (the read root, or git.checkout.blobs): the consumer reads after it returns.
// The tracer is the transport's. Header and cap failures are a Result; a bad `maxBytes` is too. Without `maxBytes` the
// result is a stream (a cap is the only way the header refuses the blob).
export function openBlob(t: Transport, oid: string, ...opts: [] | [FollowOpts]): Promise<Result<BlobStream, PlyError>>;
export function openBlob(t: Transport, oid: string, opts: CappedOpts): Promise<Result<OpenedBlob, PlyError>>;
export function openBlob(t: Transport, oid: string, opts: BlobOpts): Promise<Result<OpenedBlob, PlyError>>;
export async function openBlob(t: Transport, oid: string, opts: BlobOpts = {}): Promise<Result<OpenedBlob, PlyError>> {
  // A given maxBytes is checked, null included (a cap the caller passed); only leaving it out is no cap.
  const cap = readKey(opts, 'maxBytes');
  if (cap.tag === 'some' && (!Number.isInteger(cap.value) || cap.value < 0)) return fail('bad_request', 'maxBytes must be an integer >= 0', { what: 'maxBytes' });
  const maxBytes = getOrElse(cap, Number.POSITIVE_INFINITY);
  const { follows } = withDefaults<Pick<BlobConfig, 'follows'>>(opts, { follows: null });
  const span = t.tracer.start('git.read.blob', { ...(follows === null ? {} : { follows }), attrs: { 'git.read.blob.oid': oid } });
  const fetchSpan = t.tracer.start('git.upload-pack fetch', { parent: span, kind: KIND.CLIENT });
  const it: AsyncIterator<Uint8Array> = packStream(t, { wants: [oid] }, fetchSpan)[Symbol.asyncIterator]();
  // Close the pack stream: the read failed, was cancelled, or the cap ended it. Its own failure then is not the outcome.
  const close = async (): Promise<void> => { if (typeof it.return === 'function') await it.return().catch(() => { /* the outcome is already decided */ }); };
  // the first of failure, cancellation and verified end records the outcome; whatever follows (a cancel aborting the
  // pump) leaves the ended spans alone
  const failHere = (e: unknown): unknown => {
    // A ply error built before this call has a stack that does not name the call, so the fail-site recorder
    // (installed only under PLY_FAILSITES) would not see it. Absent the hook there is no function to call.
    const record: unknown = (globalThis as Record<symbol, unknown>)[FAIL_SITE];
    if (isFailSiteRecorder(record)) record(failHere);
    const code = thrownCodeOr(e, null);
    if (isPlyCode(code)) {
      if (!span.ended) { fetchSpan.error(e).end(); span.error(e).set({ 'git.read.blob.outcome': code }).end(); }
      return e;
    }
    const wrapped = plyError('pack_corrupt', `blob stream: ${thrownText(e)}`, { cause: e });
    if (!span.ended) { fetchSpan.error(wrapped).end(); span.error(wrapped).set({ 'git.read.blob.outcome': wrapped.code }).end(); }
    return wrapped;
  };
  const early: Uint8Array[] = [];
  const header = await blobHeader(it, early);
  if (!header.ok) {
    await close();
    const e = header.error;
    return caughtErr(failHere(e));
  }
  let sp: SpState = header.value;
  const size = header.value.size;
  span.set({ 'git.read.blob.size': size });
  // The cap is the declared size. Bytes already in the packet that completed the header stay unread by the consumer;
  // the iterator is closed so nothing further is pulled.
  if (size > maxBytes) {
    span.set({ 'git.read.blob.header_only': true, 'git.read.blob.outcome': 'too_big' }).end();
    fetchSpan.end();
    await close();
    return ok({ kind: 'too_big', size });
  }
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  const pump = (async () => {
    for (const z of early) await writer.write(bufferSource(z));
    for (;;) {
      const { value, done } = await it.next();
      // oxlint-disable-next-line typescript/strict-boolean-expressions -- bundle budget: the JS's own truthy test (an iterator's done is true, false or absent)
      if (done) break;
      const r = spStep(sp, value); sp = r.state;
      for (const z of r.zlib) await writer.write(bufferSource(z));
    }
    sp = spFinish(sp); // pack trailer checksum
    fetchSpan.end();
    await writer.close();
  })();
  // a pump failure (network, framing, trailer) aborts the inflate side, which errors the stream the consumer reads. The
  // verify transform's flush never runs then (its catch is unreachable), so the failure is recorded here.
  pump.catch(async (e: unknown) => { const failed = failHere(e); await writer.abort(failed).catch(() => { /* already failing */ }); await close(); });
  const sha = streamingSha1();
  await sha.update(objectHeader('blob', size));
  let seen = 0;
  // The latest inflate chunk. An empty chunk is not a chunk: releasing the real tail because a zero-length piece
  // arrived would finish the body before the hash and the trailer were checked.
  let held: Uint8Array | null = null;
  // The stream edge: a transform or flush that throws errors the stream, which is how the consumer is told.
  const verify = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, ctl) {
      if (chunk.byteLength === 0) return;
      seen += chunk.length;
      if (seen > size) throw failHere(plyError('pack_corrupt', `server streamed more than the ${size} bytes it declared`));
      await sha.update(chunk);
      if (held) ctl.enqueue(held);
      held = chunk;
    },
    async flush(ctl) {
      try { await pump; } catch (e) { throw failHere(e); }
      if (seen !== size) throw failHere(plyError('pack_corrupt', `inflated ${seen} != declared ${size}`));
      const got = await sha.hex();
      if (got !== oid) throw failHere(plyError('pack_corrupt', `blob content hashes to ${got}, not ${oid}`));
      if (held) ctl.enqueue(held);
      held = null;
      span.set({ 'git.read.blob.bytes': seen, 'git.read.blob.verified': true, 'git.read.blob.hasher': sha.kind, 'git.read.blob.outcome': 'ok' }).end();
    },
  });
  // DecompressionStream's own refusals (trailing junk after the deflate end, a bad block) are platform errors with no ply
  // code; the consumer sees them as pack_corrupt like every other refusal on this path (I1: a code from the fixed set).
  // The consumer's cancel() is an outcome of its own ('cancelled', not an error): without the cancel hook a cancel after the
  // pump has written its last chunk would leave both spans open forever, and one before it would read as pack_corrupt.
  const inner = ds.readable.pipeThrough(verify).getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      let r: ReadableStreamReadResult<Uint8Array>;
      try { r = await inner.read(); } catch (e) { throw isPlyThrown(e) ? e : failHere(e); }
      if (r.done) c.close(); else c.enqueue(r.value);
    },
    async cancel(reason) {
      if (!span.ended) { fetchSpan.end(); span.set({ 'git.read.blob.bytes': seen, 'git.read.blob.outcome': 'cancelled' }).end(); }
      await inner.cancel(reason).catch(() => { /* cancelling: the outcome is recorded */ });
      await close();
    },
  }, { highWaterMark: 0 });
  return ok({ kind: 'stream', size, stream });
}

export type BlobData = { readonly kind: 'bytes'; readonly data: Uint8Array<ArrayBuffer> };
// Effect: openBlob, then the whole verified stream. A stream that errors is that error; `too_big` is not read.
export function readBlob(t: Transport, oid: string, ...opts: [] | [FollowOpts]): Promise<Result<BlobData, PlyError>>;
export function readBlob(t: Transport, oid: string, opts: CappedOpts): Promise<Result<BlobData | BlobTooBig, PlyError>>;
export function readBlob(t: Transport, oid: string, opts: BlobOpts): Promise<Result<BlobData | BlobTooBig, PlyError>>;
export async function readBlob(t: Transport, oid: string, opts: BlobOpts = {}): Promise<Result<BlobData | BlobTooBig, PlyError>> {
  // The general overload: a caller's options may or may not carry a cap.
  const open: (t: Transport, oid: string, opts: BlobOpts) => Promise<Result<OpenedBlob, PlyError>> = openBlob;
  const opened = await open(t, oid, opts);
  if (!opened.ok) return opened;
  switch (opened.value.kind) {
    case 'too_big': return ok(opened.value);
    case 'stream': {
      const parts: Uint8Array[] = [];
      try { for await (const chunk of opened.value.stream) parts.push(chunk); }
      catch (e) { return caughtErr(e); }
      return ok({ kind: 'bytes', data: concat(parts) });
    }
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(opened.value);
}
