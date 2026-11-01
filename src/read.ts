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
/* oxlint-disable import/max-dependencies -- an entry composes the protocol from one import per module, so its bundle carries nothing else */
import { thrown as fail, isPlyCode, isPlyError, orThrow, plyError } from './errors.js';
import type { Miss, PlyError } from './errors.js';
import { err as resultErr, ok } from './result.js';
import type { Result } from './result.js';
import { operation, entryOptions } from './operation.js';
export { entryOptions };
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
import type { SpState } from './fetch.js';
import type { Transport } from './transport.js';
import type { TreeEntry } from './objects.js';
import { thrownCode, thrownMessage } from './boundary.js';
import { fetchCommit } from './commit.js';
import type { EntryOptions, TypeNames } from './boundary.js';

/* oxlint-disable no-await-in-loop -- a stream is consumed in order: each write waits for the inflate side (back-pressure) */
/* oxlint-disable require-await -- the entry points are async so that a throw while checking arguments is a rejection, as before */
/* oxlint-disable unicorn/explicit-length-check, require-unicode-regexp, typescript/prefer-includes -- bundle budget: the JS's truthy length checks and non-unicode regexes, byte for byte (no behaviour change); RegExp#test, not includes: a thrown value's message may be no string at run time */

const OID = /^[0-9a-f]{40}$/;

// Pure: what to ask ls-refs for, and which answer wins. git's ref_rev_parse_rules minus the remote-tracking forms.
// `ref` is the caller's, checked here: anything but null, undefined or a string is bad_request.
export function refCandidates(ref: unknown): string[] {
  if (ref === null || ref === undefined || ref === '' || ref === 'HEAD') return ['HEAD'];
  if (typeof ref !== 'string') throw fail('bad_request', 'ref must be a string');
  if (OID.test(ref)) return [];
  if (ref.startsWith('refs/')) return [validateRef(ref)];
  return [`refs/${ref}`, `refs/tags/${ref}`, `refs/heads/${ref}`].map(r => validateRef(r));
}

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
  const name = requested === null || requested === undefined || requested === '' ? 'HEAD' : requested;
  return typeof name === 'string' && (name === full || name === 'HEAD' || (!name.startsWith('refs/') && full === `refs/heads/${name}`));
};

// Effect: the unborn HEAD's target, or null when the server does not advertise ls-refs=unborn or lists no unborn line
// (a deleted branch, a born HEAD). discover runs only on a ref miss; the happy path never asks.
async function unbornTarget(t: Transport): Promise<string | null> {
  const info = await discover(t);
  if (!info.lsRefsUnborn) return null;
  const listed = await lsRefs(t, ['HEAD'], { unborn: parseUnbornLine });
  const target = listed.unborn?.target;
  return target === undefined || target === '' ? null : target;
}

// A ref as the caller names it: null/undefined/'' or 'HEAD' for the remote's HEAD, a name, or a 40-hex oid.
export type RefSpec = string | null | undefined;
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
  if (!ABBREV.test(prefix)) return resultErr(plyError('bad_request', 'abbreviated oid must be 4..39 lowercase hex', { what: 'ref' }));
  const byOid = new Map<string, string[]>();
  for (const rec of listed.refs.values()) {
    const hits: ReadonlyArray<readonly [string, string]> = rec.peeled === undefined ? [[rec.oid, rec.name]] : [[rec.oid, rec.name], [rec.peeled, rec.name]];
    for (const [oid, name] of hits) {
      if (!oid.startsWith(prefix)) continue;
      const names = byOid.get(oid);
      if (names === undefined) byOid.set(oid, [name]);
      else if (!names.includes(name)) names.push(name);
    }
  }
  const oids = [...byOid.keys()].toSorted();
  const oid = oids[0];
  if (oid === undefined) return ok({ kind: 'none' });
  if (oids.length > 1) return ok({ kind: 'ambiguous', oids });
  return ok({ kind: 'unique_among_advertised', oid, refs: byOid.get(oid) ?? [] });
}
// The name missed. A unique advertised oid is that commit; more than one is bad_request; none leaves the caller to
// report not_found. The prefix already matched ABBREV, so resolveAbbrev's own bad_request does not run.
function advertisedCommit(prefix: string, listed: LsRefsResult): Resolved | null {
  const resolved = resolveAbbrev(prefix, listed);
  if (!resolved.ok) throw resolved.error;
  if (resolved.value.kind === 'unique_among_advertised') return { name: resolved.value.oid, commit: resolved.value.oid };
  if (resolved.value.kind === 'ambiguous') throw fail('bad_request', `abbreviated oid ${prefix} matches ${resolved.value.oids.length} advertised objects`, { what: 'ref', got: resolved.value.oids });
  return null;
}
// One ls-refs. `hit` is the ref name, a bare oid, or a unique advertised prefix. `cands` is the miss: the name was not
// listed and the prefix was not unique. The abbrev refusal lives here so resolveCommit's only fail() is not_found.
async function lookupRef(t: Transport, ref: unknown, abbrev: AbbrevMode): Promise<{ readonly hit: Resolved } | { readonly cands: readonly string[] }> {
  if (abbrev !== 'off' && abbrev !== 'advertised') throw fail('bad_request', 'abbrev must be "advertised" or "off"', { what: 'abbrev' });
  const cands = refCandidates(ref);
  // refCandidates answers [] only for a 40-hex oid string (anything else is a name list, or it threw).
  if (cands.length === 0 && typeof ref === 'string') return { hit: { name: ref, commit: ref } };
  // null: this call is a name. A string: the prefix, and the listing is wide enough to answer it.
  const prefix = abbrev === 'advertised' && typeof ref === 'string' && ABBREV.test(ref) ? ref : null;
  const listed = await lsRefs(t, prefix === null ? cands : [...cands, 'HEAD', 'refs/heads/', 'refs/tags/']);
  for (const name of cands) {
    const r = listed.refs.get(name);
    if (r) return { hit: { name: name === 'HEAD' ? (listed.head ?? 'HEAD') : name, commit: r.peeled ?? r.oid } };
  }
  if (prefix !== null) {
    const found = advertisedCommit(prefix, listed);
    if (found) return { hit: found };
  }
  return { cands };
}
// Effect: ref → { name, commit } (annotated tags peeled; a bare oid is taken as given and checked by the commit fetch).
// `abbrev: 'advertised'` asks once for the name's candidates plus HEAD, branches and tags, tries the name first, then
// the prefix. `'off'` is the candidates alone. A miss is not_found, and an unborn HEAD the caller named is head_unborn.
export async function resolveCommit(t: Transport, ref: unknown, { abbrev = 'off' }: { readonly abbrev?: AbbrevMode } = {}): Promise<Resolved> {
  const looked = await lookupRef(t, ref, abbrev);
  if ('hit' in looked) return looked.hit;
  const { cands } = looked;
  const first = cands[0];
  // The unborn question is a second ls-refs, and only after a miss: the advertisement is read then, and `unborn` is
  // sent only when the server lists ls-refs=unborn. A path miss never reaches here.
  const target = await unbornTarget(t);
  // refCandidates threw on a non-string, and a HEAD miss does not read this. The false arm stays so the type is a string.
  const asked = typeof ref === 'string' ? ref : '';
  let miss: Miss;
  if (target !== null && sameBranch(ref, target)) miss = { kind: 'head_unborn', target };
  else if (first === 'HEAD') miss = { kind: 'head_absent' };
  else miss = { kind: 'ref', ref: asked, candidates: cands };
  throw fail('not_found', first === 'HEAD' ? 'remote HEAD is unborn or absent (some hosts point HEAD at a deleted branch); pass ref explicitly' : `ref ${asked} not found`, { miss });
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
// Pure: a commit object's view.
export function commitView(data: Uint8Array, limits: Limits = DEFAULT_LIMITS): CommitView {
  const c: { readonly tree: string; readonly parents: readonly string[]; readonly author: string; readonly committer: string; readonly message: string | null; readonly extra: readonly string[] } = parseCommit(data, limits);
  return { tree: c.tree, parents: c.parents, author: identView(c.author), committer: identView(c.committer), message: c.message ?? '', signed: c.extra.some(l => /^gpgsig(-sha256)? /.test(l)) };
}

// The options operation() reads pass through (capabilities, auth, limits, transport, …).
export type ReadOptions = EntryOptions;
// Trees by oid, kept by the caller across reads (immutable: an oid names its bytes).
export type TreeCache = Map<string, Uint8Array>;
export type CommitResult = CommitView & { readonly ref: string; readonly oid: string };
// An unborn HEAD (or that branch by name): git log's "does not have any commits yet". Not a not_found.
export type EmptyCommit = { readonly empty: true; readonly ref: string };

type CommitQuery = { readonly ref: RefSpec } | Record<string, never>;
const headQuery = (): CommitQuery => ({ ref: null });
export async function readCommit(url: string, query: CommitQuery = headQuery(), opts: ReadOptions = entryOptions()): Promise<CommitResult | EmptyCommit> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ref is present or absent; the default is null
  const { ref = null } = query as { readonly ref: RefSpec };
  const refLabel = typeof ref === 'string' ? ref : 'HEAD';
  return operation('read_commit', url, { ...opts, attrs: { 'git.read_commit.ref': refLabel } }, async ({ t, outcome }) => {
    let resolved: Resolved | EmptyCommit;
    try { resolved = await resolveCommit(t, ref); } catch (e) {
      if (!(isPlyError(e) && e.code === 'not_found' && e.miss.kind === 'head_unborn')) throw e;
      const empty: EmptyCommit = { empty: true, ref: e.miss.target };
      resolved = empty;
    }
    if ('empty' in resolved) return outcome('ok', resolved);
    const { name, commit } = resolved;
    const view = commitView(orThrow(await fetchCommit(t, commit)).data, t.limits);
    return outcome('ok', { ref: name, oid: commit, ...view }, { 'git.read_commit.oid': commit, 'git.read_commit.parents': view.parents.length, 'git.read_commit.signed': view.signed });
  });
}

export type Walked = { readonly tree: string; readonly entry: TreeEntry | null };
// Effect: walk `comps` from a tree the caller already has. `tree` is that starting oid; `entry` is the last component
// (null when comps is empty). A missing component or a non-directory along the way is not_found with its miss. Each
// level is a `git.read.tree` span under the transport's parent, so a readFile/listTree walk stays on that trace.
export async function walkPath(t: Transport, treeOid: string, comps: readonly string[], { cache = new Map<string, Uint8Array>() }: { readonly cache?: TreeCache } = {}): Promise<Result<Walked, PlyError>> {
  let at = treeOid;
  let entry: TreeEntry | null = null;
  try {
    for (const [depth, name] of comps.entries()) {
      // oxlint-disable-next-line no-loop-func -- the span runs to completion inside this iteration (awaited)
      entry = await t.tracer.span('git.read.tree', { parent: t.parent, attrs: { 'git.read.tree.depth': depth, 'git.read.tree.oid': at, 'git.read.tree.lookup': name } }, async span => {
        let data = cache.get(at);
        span.set({ 'git.read.tree.cache_hit': !!data });
        if (!data) { data = (await fetchObject(t, { oid: at, filter: 'tree:0', expectType: TYPE.TREE })).data; cache.set(at, data); }
        const entries: readonly TreeEntry[] = parseTree(data, t.limits);
        const found = entries.find(x => x.name === name);
        span.set({ 'git.read.tree.entries': entries.length, 'git.read.tree.entry.found': !!found, 'git.read.tree.entry.mode': found?.mode ?? '' });
        if (!found) throw fail('not_found', `path component ${name} not found`, { miss: { kind: 'path', missing: name, existingPath: comps.slice(0, depth).join('/') } });
        if (depth < comps.length - 1 && found.mode !== '40000') throw fail('not_found', `${name} is not a directory`, { miss: { kind: 'not_directory', path: comps.slice(0, depth + 1).join('/'), mode: found.mode } });
        return found;
      });
      at = entry.oid;
    }
    return ok({ tree: treeOid, entry });
  } catch (e) {
    if (isPlyError(e)) return resultErr(e);
    throw e;
  }
}

// Effect: walk `comps` from the commit's root tree. `tree` is that root (walkPath's tree is the tree it started from).
async function walk(t: Transport, root: Span, { commit, comps, cache, limits }: { readonly commit: string; readonly comps: readonly string[]; readonly cache: TreeCache; readonly limits: Limits }): Promise<Walked> {
  const info: { readonly tree: string } = parseCommit(orThrow(await fetchCommit(t, commit)).data, limits);
  root.set({ 'git.read.commit': commit, 'git.read.tree.root': info.tree });
  const walked = orThrow(await walkPath(t, info.tree, comps, { cache }));
  return { tree: info.tree, entry: walked.entry };
}

const pathComps = (path: unknown, limits: Limits, { allowRoot }: { readonly allowRoot: boolean }): string[] => {
  if (allowRoot && (path === undefined || path === null || path === '' || path === '/')) return [];
  return validatePath(typeof path === 'string' ? path.replace(/\/$/, '') : path, limits);
};

export type ListEntry = { readonly name: string; readonly mode: string; readonly oid: string; readonly type: EntryType };
export type ListResult = { readonly ref: string; readonly commit: string; readonly tree: string; readonly entries: readonly ListEntry[] };
type TreeQuery =
  | { readonly ref: RefSpec; readonly path: string | null }
  | { readonly ref: RefSpec }
  | { readonly path: string | null }
  | Record<string, never>;
type ListOptions = ReadOptions | (ReadOptions & { readonly cache: TreeCache });
const cacheOf = (options: object): TreeCache => {
  if (!('cache' in options)) return new Map();
  const found = options.cache;
  if (found instanceof Map) return found;
  return new Map();
};
const rootQuery = (): TreeQuery => ({ ref: null, path: '' });
export async function listTree(url: string, query: TreeQuery = rootQuery(), options: ListOptions = entryOptions()): Promise<ListResult> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ref and path default when the query omits them
  const { ref = null, path = '' } = query as { readonly ref: RefSpec; readonly path: RefSpec };
  const cache = cacheOf(options);
  const opts = options;
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const comps = pathComps(path, limits, { allowRoot: true });
  const refLabel = typeof ref === 'string' ? ref : 'HEAD';
  return operation('ls_tree', url, { ...opts, attrs: { 'git.ls_tree.ref': refLabel, 'git.ls_tree.path': comps.join('/'), 'git.ls_tree.path.depth': comps.length } }, async ({ t, root, outcome }) => {
    const { name, commit } = await resolveCommit(t, ref);
    // the tracer operation() started the root span on (opts.tracer)
    const { tree, entry } = await walk(t, root, { commit, comps, cache, limits });
    if (entry && entry.mode !== '40000') throw fail('not_found', `${comps.join('/')} is not a directory (mode ${entry.mode})`, { miss: { kind: 'not_directory', path: comps.join('/'), mode: entry.mode } });
    const oid = entry ? entry.oid : tree;
    let data = cache.get(oid);
    if (!data) { data = (await fetchObject(t, { oid, filter: 'tree:0', expectType: TYPE.TREE })).data; cache.set(oid, data); }
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
// The root span ends when the stream is open (size known); the content's own span, `git.read.blob`, ends when the
// stream does, with the bytes delivered and whether the oid verified. It outlives the root, so it is not the root's child
// but the root of its own trace, linked both ways (follows_from / followed_by): README "Span lifetimes".
type FileQuery =
  | { readonly ref: RefSpec; readonly path: string }
  | { readonly ref: RefSpec }
  | { readonly path: string }
  | Record<string, never>;
const fileQuery = (): FileQuery => ({ ref: null });
export async function readFile(url: string, query: FileQuery = fileQuery(), options: ListOptions = entryOptions()): Promise<FileResult> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ref defaults when the query omits it
  const { ref = null } = query as { readonly ref: RefSpec };
  const path = 'path' in query ? query.path : [][0];
  const cache = cacheOf(options);
  const opts = options;
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const comps = pathComps(path, limits, { allowRoot: false });
  const refLabel = typeof ref === 'string' ? ref : 'HEAD';
  return operation('read', url, { ...opts, attrs: { 'git.read.ref': refLabel, 'git.read.path': comps.join('/'), 'git.read.path.depth': comps.length } }, async ({ t, root, outcome }) => {
    const { name, commit } = await resolveCommit(t, ref);
    // comps is non-empty (validatePath refuses an empty path), so the walk ends at an entry
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- see above (and no `!`: docs/STACK.md)
    const entry = (await walk(t, root, { commit, comps, cache, limits })).entry as TreeEntry;
    // a symlink's blob is its target (what `git show <ref>:<path>` prints); a gitlink has no blob in this repository
    if (entry.mode === '40000') throw fail('not_found', `${comps.join('/')} is a directory`, { miss: { kind: 'is_directory', path: comps.join('/'), tree: entry.oid } });
    if (entry.mode === '160000') throw fail('not_found', `${comps.join('/')} is a submodule (commit ${entry.oid})`, { miss: { kind: 'submodule', path: comps.join('/'), commit: entry.oid } });
    // oxlint-disable-next-line no-use-before-define -- the JS's order (readFile, then openBlob): a function declaration, hoisted; the bundle's gzip budget
    const opened = orThrow(await openBlob(t, entry.oid, { follows: root }));
    return outcome('ok', { ref: name, commit, blob: entry.oid, mode: lsMode(entry.mode), size: opened.size, stream: opened.stream }, { 'git.read.blob': entry.oid, 'git.read.blob.size': opened.size, 'git.read.blob.mode': entry.mode });
  });
}

export type BlobStream = { readonly kind: 'stream'; readonly size: number; readonly stream: ReadableStream<Uint8Array> };
export type BlobTooBig = { readonly kind: 'too_big'; readonly size: number };
export type OpenedBlob = BlobStream | BlobTooBig;
export type BlobOpts = { readonly maxBytes?: number; readonly follows?: Span };
// Effect: one blob on the caller's transport. Reads the pack until the object header (→ size). A declared size above
// `maxBytes` is `{ kind: 'too_big' }`: the fetch is cancelled and no body byte is delivered (`git.read.blob.header_only`).
// Otherwise the zlib bytes go through DecompressionStream and a verifying transform. The transform releases every chunk
// but the latest as it arrives, and releases the latest only after the pack trailer and the object hash verify. A failure
// errors the stream with that chunk still held, so the body never completes on unverified bytes. Back-pressure: the pump
// awaits each write, so at most one network chunk and one inflate chunk are in flight beyond the chunk being held.
// `follows` is the span the stream follows (the read root, or git.checkout.blobs): the consumer reads after it returns.
// The tracer is the transport's. Header and cap failures are a Result; a bad `maxBytes` is too. Without `maxBytes` the
// result is a stream (a cap is the only way the header refuses the blob).
export function openBlob(t: Transport, oid: string, opts?: { readonly follows?: Span }): Promise<Result<BlobStream, PlyError>>;
export function openBlob(t: Transport, oid: string, opts: { readonly maxBytes: number; readonly follows?: Span }): Promise<Result<OpenedBlob, PlyError>>;
export async function openBlob(t: Transport, oid: string, { maxBytes, follows }: BlobOpts = {}): Promise<Result<OpenedBlob, PlyError>> {
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 0)) return resultErr(plyError('bad_request', 'maxBytes must be an integer >= 0', { what: 'maxBytes' }));
  const span = t.tracer.start('git.read.blob', { ...(follows ? { follows } : {}), attrs: { 'git.read.blob.oid': oid } });
  const fetchSpan = t.tracer.start('git.upload-pack fetch', { parent: span, kind: KIND.CLIENT });
  const it: AsyncIterator<Uint8Array> = packStream(t, { wants: [oid] }, fetchSpan)[Symbol.asyncIterator]();
  let sp: SpState = spInit();
  const early: Uint8Array[] = [];
  // the first of failure, cancellation and verified end records the outcome; whatever follows (a cancel aborting the
  // pump) leaves the ended spans alone
  const failHere = (e: unknown): unknown => {
    const code = thrownCode(e);
    if (isPlyCode(code)) {
      if (!span.ended) { fetchSpan.error(e).end(); span.error(e).set({ 'git.read.blob.outcome': code }).end(); }
      return e;
    }
    const err = fail('pack_corrupt', `blob stream: ${String(thrownMessage(e) ?? e)}`, { cause: e });
    if (!span.ended) { fetchSpan.error(err).end(); span.error(err).set({ 'git.read.blob.outcome': err.code }).end(); }
    return err;
  };
  try {
    while (sp.phase !== 'body') {
      const { value, done } = await it.next();
      // oxlint-disable-next-line typescript/strict-boolean-expressions -- bundle budget: the JS's own truthy test (an iterator's done is true, false or absent)
      if (done) throw fail('pack_corrupt', 'pack ended before the object header');
      const r = spStep(sp, value); sp = r.state;
      early.push(...r.zlib);
    }
    if (sp.type !== TYPE.BLOB) throw fail('pack_corrupt', `expected blob, got ${(TYPE_NAME as TypeNames)[sp.type] ?? sp.type}`);
  } catch (e) {
    await it.return?.().catch(() => { /* the read already failed */ });
    const err = failHere(e);
    if (isPlyError(err)) return resultErr(err);
    throw err;
  }
  const size = sp.size;
  span.set({ 'git.read.blob.size': size });
  // The cap is the declared size. Bytes already in the packet that completed the header stay unread by the consumer;
  // the iterator is closed so nothing further is pulled.
  if (maxBytes !== undefined && size > maxBytes) {
    span.set({ 'git.read.blob.header_only': true, 'git.read.blob.outcome': 'too_big' }).end();
    fetchSpan.end();
    await it.return?.().catch(() => { /* the size cap ended the read */ });
    return ok({ kind: 'too_big', size });
  }
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  const pump = (async () => {
    for (const z of early) await writer.write(bufferSource(z));
    for (;;) {
      const { value, done } = await it.next();
      // oxlint-disable-next-line typescript/strict-boolean-expressions -- see above
      if (done) break;
      const r = spStep(sp, value); sp = r.state;
      for (const z of r.zlib) await writer.write(bufferSource(z));
    }
    sp = spFinish(sp); // pack trailer checksum
    fetchSpan.end();
    await writer.close();
  })();
  // a pump failure (network, framing, trailer) aborts the inflate side, which errors the stream the consumer reads. The
  // verify transform's flush never runs then, so the failure is recorded (and both spans ended) here.
  pump.catch(async (e: unknown) => { const err = failHere(e); await writer.abort(err).catch(() => { /* already failing */ }); await it.return?.().catch(() => { /* already failing */ }); });
  const sha = streamingSha1();
  await sha.update(objectHeader('blob', size));
  let seen = 0;
  // The latest inflate chunk. An empty chunk is not a chunk: releasing the real tail because a zero-length piece
  // arrived would finish the body before the hash and the trailer were checked.
  let held: Uint8Array | null = null;
  const verify = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, ctl) {
      if (chunk.byteLength === 0) return;
      seen += chunk.length;
      if (seen > size) throw failHere(fail('pack_corrupt', `server streamed more than the ${size} bytes it declared`));
      await sha.update(chunk);
      if (held) ctl.enqueue(held);
      held = chunk;
    },
    async flush(ctl) {
      try { await pump; } catch (e) { throw failHere(e); }
      if (seen !== size) throw failHere(fail('pack_corrupt', `inflated ${seen} != declared ${size}`));
      const got = await sha.hex();
      if (got !== oid) throw failHere(fail('pack_corrupt', `blob content hashes to ${got}, not ${oid}`));
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
      try { r = await inner.read(); } catch (e) { throw isPlyCode(thrownCode(e)) ? e : failHere(e); }
      if (r.done) c.close(); else c.enqueue(r.value);
    },
    async cancel(reason) {
      if (!span.ended) { fetchSpan.end(); span.set({ 'git.read.blob.bytes': seen, 'git.read.blob.outcome': 'cancelled' }).end(); }
      await inner.cancel(reason).catch(() => { /* cancelling: the outcome is recorded */ });
      await it.return?.().catch(() => { /* cancelling: the outcome is recorded */ });
    },
  }, { highWaterMark: 0 });
  return ok({ kind: 'stream', size, stream });
}

export type BlobData = { readonly kind: 'bytes'; readonly data: Uint8Array<ArrayBuffer> };
// Effect: openBlob, then the whole verified stream. A stream that errors is that error; `too_big` is not read.
export function readBlob(t: Transport, oid: string, opts?: { readonly follows?: Span }): Promise<Result<BlobData, PlyError>>;
export function readBlob(t: Transport, oid: string, opts: { readonly maxBytes: number; readonly follows?: Span }): Promise<Result<BlobData | BlobTooBig, PlyError>>;
export async function readBlob(t: Transport, oid: string, { maxBytes, follows }: BlobOpts = {}): Promise<Result<BlobData | BlobTooBig, PlyError>> {
  const opened = maxBytes === undefined
    ? await openBlob(t, oid, follows === undefined ? undefined : { follows })
    : await openBlob(t, oid, follows === undefined ? { maxBytes } : { maxBytes, follows });
  if (!opened.ok) return opened;
  if (opened.value.kind === 'too_big') return ok(opened.value);
  const parts: Uint8Array[] = [];
  try { for await (const chunk of opened.value.stream) parts.push(chunk); }
  catch (e) { if (isPlyError(e)) return resultErr(e); throw e; }
  return ok({ kind: 'bytes', data: concat(parts) });
}
