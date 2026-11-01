// A whole tree (or one subtree) out of a remote, without a clone, a working tree or an object store. The mirror of
// pushTree: where readFile pays ls-refs + a commit fetch + a tree per level + the blob for every file, checkoutTree
// resolves the commit once and asks for objects in bulk:
//
//   ls-refs → ONE blob:none fetch of the commit (deepen 1: the commit and every tree under it, which is also all a
//   blob:none-only host such as Cloudflare Artifacts serves) → the blobs, `batch` wants per fetch.
//
//   checkoutTree(url, { ref, path }, opts) → { ref, commit, tree, path, entries, files }
//     entries: [{ path, mode, oid }]                            every non-tree entry under `path`, in tree order
//     files:   AsyncIterable<{ path, mode, oid, size, stream }> one per entry; stream: ReadableStream<Uint8Array>
//
// Paths are relative to `path`. Modes are git's canonical ones (canon_mode, from parseTree: 100664 → 100644, 40755 → a
// directory, any type git does not know → 160000):
// 100644, 100755, 120000 (a symlink; the stream is its target) and 160000 (a gitlink: the submodule's commit is not
// in this repository, so size 0 and stream null). Directories are implied by the paths (git has no empty ones).
//
// Verification. The tree pack is delta-resolved and every object keyed by its computed hash (packresolve.js); a
// missing tree is pack_corrupt. A blob batch is the same, and an object nobody asked for is pack_corrupt before any
// file is yielded. A blob fetched on its own (one left in its batch, a batch split down to one, a host that refuses
// many wants) is readFile's stream: hashed as it passes, erroring rather than ending if the bytes are not the blob's.
//
// Memory. The tree pack is one buffered fetch (maxPackBytes, maxInflatedTotal, maxPackObjects); the entries walked are
// bounded by maxPackObjects (a tree reused at many paths cannot multiply them past it) and the depth by maxPathDepth.
// A blob batch is one buffered fetch under the same caps; one that hits a cap is split in half and refetched, down to
// single blobs, which stream in O(1) memory. Every fetch, streamed or buffered, delivers at most maxPackBytes of pack
// (v2Step): a single blob whose pack is over it is limit_exceeded, not fetched (the default, 128 MiB, is above GitHub's
// 100 MiB file cap). The iterator holds at most the batch it is yielding (and the previous one while its streams are unread).
//
// Errors are values here (fetchTrees, subtree, treeFilesResult, fetchBlobs). checkoutTree and treeFiles are the throwing
// public entries (orThrow); the files iterator errors as an async iterator does, at next().
//
// Workers-safe (Web APIs only). Writing into a directory is Node's and lives in checkout-node.js.
/* oxlint-disable import/max-dependencies -- an entry composes the protocol from one import per module, so its bundle carries nothing else */
/* oxlint-disable unicorn/explicit-length-check, require-unicode-regexp, typescript/prefer-includes -- bundle budget: the JS's truthy length checks and non-unicode regexes, byte for byte (no behaviour change); RegExp#test, not includes: a thrown value's message may be no string at run time */
import { fail, orThrow, type CommitMiss, type PlyError } from './errors.js';
import { assertNever, err, getOrElse, mapOption, ok } from './result.js';
import type { Result } from './result.js';
import type { OperationOpts } from './operation.js';
import { operation } from './operation.js';
import { fetchPack } from './fetchpack.js';
import { resolveCommitResult, openBlob, pathComps } from './read.js';
import type { ReadOptions, RefSpec } from './read.js';
import { parseCommit, parseTree, canonMode as canonModeOf, TYPE, TYPE_NAME, nonCommitType } from './objects.js';
import { DEFAULT_LIMITS, limitError, readLimit } from './limits.js';
import type { Limits } from './limits.js';
import { withParent } from './transport.js';
import { MODE_TREE, MODE_COMMIT } from './format.js';
import type { Span, Tracer } from './otel.js';
import type { FetchPackResult as FetchedPack } from './fetchpack.js';
import type { Transport } from './transport.js';
import type { TreeEntry } from './objects.js';
import { thrownCodeIs, thrownCodeOr, thrownReasonIs } from './boundary.js';
import type { TypeNames } from './boundary.js';
import { attempt, attemptSync, caughtErr } from './commit.js';
import { fromNullable, fromNullish, mapGet, withDefaults } from './absent.js';
import type { Input } from './absent.js';

type PackObjects = NonNullable<FetchedPack['objects']>;


/* oxlint-disable no-magic-numbers -- a request-size default, not a wire-format fact */
const BATCH = 1000;
/* oxlint-enable no-magic-numbers */
const TREE_MODE = /^[1-7][0-7]*$/;

/* oxlint-disable no-await-in-loop -- the files are yielded in order, one fetch or stream at a time (bounded memory) */

// git's canonical modes: a regular file, an executable, a symlink, a gitlink, a directory.
export type Mode = ReturnType<typeof canonModeOf>;
// Pure: git's canon_mode for a tree entry's mode (objects.js canonMode: the low 16 bits, as tree-walk keeps them), or
// null for a mode git does not parse at all or errors on under fsck --strict (empty, not octal, zero-padded). parseTree
// already returns canonical modes; this is the same function for a caller holding a raw one. Every type that is not a
// regular file, a symlink or a directory is a gitlink to git (`git ls-tree` shows 140000, 100 and 200644 as 160000).
export const canonMode = (mode: unknown): Mode | null => (typeof mode === 'string' && TREE_MODE.test(mode) ? canonModeOf(mode) : null);

// One file of a checkout: its path under the checked-out directory, canonical mode, and blob (or gitlink commit) oid.
export type CheckoutEntry = { readonly path: string; readonly mode: Mode; readonly oid: string };
// A tree's entries by oid, or why they cannot be had (a tree missing from the pack, or one that does not parse).
export type TreeLookup = (oid: string) => Result<readonly TreeEntry[], PlyError>;
// `depth`: the level the walk starts at (a subtree's own depth); `limits`: maxPackObjects and maxPathDepth.
export type TreeFilesConfig = { readonly depth: number; readonly limits: Limits };
export type TreeFilesOptions = Input<TreeFilesConfig>;
// Pure: every non-tree entry under `oid`, depth first in tree order. `tree(oid)` → parsed entries. Each tree is checked
// for a name given twice (git fsck duplicateEntries: a symlink `a` beside a directory `a` would route a later write
// through the link). Every entry visited counts against maxPackObjects, trees included, so a tree reused at many paths
// (each a distinct path, one object) cannot make the walk outgrow the pack it came from by more than that.
export function treeFilesResult(tree: TreeLookup, oid: string, options: TreeFilesOptions = {}): Result<CheckoutEntry[], PlyError> {
  const { depth, limits } = withDefaults<TreeFilesConfig>(options, { depth: 0, limits: DEFAULT_LIMITS });
  const entriesCap = readLimit(limits, 'maxPackObjects');
  if (!entriesCap.ok) return entriesCap;
  const depthCap = readLimit(limits, 'maxPathDepth');
  if (!depthCap.ok) return depthCap;
  const maxEntries = entriesCap.value;
  const maxDepth = depthCap.value;
  const out: CheckoutEntry[] = [];
  let seen = 0;
  const walk = (at: string, prefix: string, level: number): Result<true, PlyError> => {
    const listed = tree(at);
    if (!listed.ok) return listed;
    const names = new Set<string>();
    for (const e of listed.value) {
      if (++seen > maxEntries) return err(limitError('checkout entries', seen, maxEntries));
      if (names.has(e.name)) return fail('pack_corrupt', `tree ${at}: duplicate entry ${JSON.stringify(e.name)} (git fsck duplicateEntries)`);
      names.add(e.name);
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (level + 1 > maxDepth) return err(limitError('path depth', level + 1, maxDepth));
      const mode = canonMode(e.mode);
      if (mode === null) return fail('pack_corrupt', `tree ${at}: ${path} has mode ${e.mode}, which git cannot check out`);
      if (mode !== MODE_TREE) { out.push({ path, mode, oid: e.oid }); continue; }
      const below = walk(e.oid, path, level + 1);
      if (!below.ok) return below;
    }
    return ok(true);
  };
  const walked = walk(oid, '', depth);
  if (!walked.ok) return walked;
  return ok(out);
}
// The throwing entry (public API until the Result cut-over): `tree(oid)` returns the entries, and what it throws is
// thrown as it was.
export const treeFiles = (tree: (oid: string) => readonly TreeEntry[], oid: string, options: TreeFilesOptions = {}): CheckoutEntry[] =>
  orThrow(treeFilesResult(at => attemptSync(() => tree(at)), oid, options));

type Trees = { readonly root: string; readonly tree: TreeLookup; readonly objects: number; readonly trees: number };
// Effect: the commit and every tree under it, as one blob:none pack (deepen 1). Returns { root, tree } where tree(oid)
// parses a tree from that pack. A bare oid that is not a commit (or not on the server) is the caller's not_found.
async function fetchTrees(t: Transport, commit: string, limits: Limits): Promise<Result<Trees, PlyError>> {
  let r: FetchedPack;
  try { r = await fetchPack(t, { wants: [commit], filter: 'blob:none', deepen: 1 }); } catch (e) {
    if (thrownCodeIs(e, 'remote_error') && thrownReasonIs(e, 'not_our_ref')) return fail('not_found', `commit ${commit} not found on the remote`, { miss: { kind: 'commit', miss: { kind: 'absent', oid: commit } } });
    return caughtErr(e);
  }
  const objects: PackObjects = r.objects === null ? new Map() : r.objects;
  const wanted = mapGet(objects, commit);
  if (wanted.tag === 'none') return fail('pack_corrupt', `commit ${commit} not in the blob:none pack (${objects.size} objects)`);
  const c = wanted.value;
  if (c.type !== TYPE.COMMIT) {
    const found = nonCommitType(c.type);
    const miss = ((): CommitMiss => {
      switch (found.tag) {
        case 'commit':
        case 'delta':
        case 'invalid':
          return { kind: 'absent', oid: commit };
        case 'notCommit':
          return { kind: 'not_commit', oid: commit, type: found.name };
      }
      // Stryker disable next-line ConditionalExpression,CallExpression: unreachable, the compiler's exhaustiveness check
      return assertNever(found);
    })();
    return fail('not_found', `${commit} is not a commit`, { miss: { kind: 'commit', miss } });
  }
  const tree = (oid: string): Result<readonly TreeEntry[], PlyError> => {
    const o = mapGet(objects, oid);
    if (o.tag === 'none' || o.value.type !== TYPE.TREE) return fail('pack_corrupt', `tree ${oid} not in the blob:none pack`);
    const data = o.value.data;
    return attemptSync(() => parseTree(data, limits));
  };
  let trees = 0; for (const o of objects.values()) if (o.type === TYPE.TREE) trees++;
  const parsed = attemptSync(() => parseCommit(c.data, limits));
  if (!parsed.ok) return parsed;
  return ok({ root: parsed.value.tree, tree, objects: objects.size, trees });
}

// Effect: walk `comps` from `root` to the subtree's oid (not_found for a missing component or a non-directory).
const subtree = (tree: TreeLookup, root: string, comps: readonly string[]): Result<string, PlyError> => {
  let oid = root;
  for (const [i, name] of comps.entries()) {
    const listed = tree(oid);
    if (!listed.ok) return listed;
    const e = fromNullable(listed.value.find(x => x.name === name));
    if (e.tag === 'none') return fail('not_found', `path component ${name} not found`, { miss: { kind: 'path', missing: name, existingPath: comps.slice(0, i).join('/') } });
    if (e.value.mode !== MODE_TREE) return fail('not_found', `${comps.slice(0, i + 1).join('/')} is not a directory (mode ${e.value.mode})`, { miss: { kind: 'not_directory', path: comps.slice(0, i + 1).join('/'), mode: e.value.mode } });
    oid = e.value.oid;
  }
  return ok(oid);
};

// Effect: one wants-list fetch of blobs, buffered and delta-resolved. Every object is keyed by its computed hash; one
// that was not asked for, or is not a blob, is pack_corrupt. A wanted blob the pack leaves out is simply absent.
async function fetchBlobs(t: Transport, oids: readonly string[]): Promise<Result<PackObjects, PlyError>> {
  const want = new Set(oids);
  // oxlint-disable-next-line require-await -- async so that attempt() sees any failure as a rejection
  const fetched = await attempt(async () => fetchPack(t, { wants: oids }));
  if (!fetched.ok) return fetched;
  const objects: PackObjects = fetched.value.objects === null ? new Map() : fetched.value.objects;
  for (const [oid, o] of objects) {
    if (!want.has(oid)) return fail('pack_corrupt', `object ${oid} served but not wanted (${oids.length} blobs asked for)`);
    if (o.type !== TYPE.BLOB) return fail('pack_corrupt', `expected blob ${oid}, got ${getOrElse<string | number>(fromNullish((TYPE_NAME as TypeNames)[o.type]), o.type)}`);
  }
  return ok(objects);
}

// A host that answers a many-wants fetch with an error status, ERR or broken framing is asked for one blob at a time
// from then on (remembered on the transport's quirks). A lie (pack_corrupt) is never a reason to fall back.
const isWantsRefusal = (e: unknown): boolean => { const code = thrownCodeOr(e, null); return code === 'http' || code === 'remote_error' || code === 'protocol'; };

const bytesStream = (data: Uint8Array): ReadableStream<Uint8Array> => new ReadableStream({ start(c) { if (data.length) c.enqueue(data); c.close(); } });

// The files iterator. Gitlinks first (nothing to fetch), then the unique blobs in `batch`-sized wants lists; every path
// naming a blob is yielded with it. Its span, `git.checkout.blobs`, starts at the first next() and ends when the
// iteration does, both after the checkout root has ended: it is the root of its own trace with a follows_from link to
// the checkout root (README "Span lifetimes"), and each streamed blob's git.read.blob follows it in turn. A failure is
// the iterator's: next() rejects with the PlyError (the async iterator's edge).
async function* blobFiles(transport: Transport, tracer: Tracer, opener: Span, entries: readonly CheckoutEntry[], batch: number): AsyncGenerator<CheckoutFile, void, void> {
  const span = tracer.start('git.checkout.blobs', { follows: opener });
  const t: Transport = withParent(transport, span);
  const byOid = new Map<string, CheckoutEntry[]>();
  for (const e of entries) if (e.mode !== MODE_COMMIT) { const l = byOid.get(e.oid); if (l) l.push(e); else byOid.set(e.oid, [e]); }
  const stat = { fetches: 0, buffered: 0, streamed: 0, splits: 0, bytes: 0 };
  span.set({ 'git.checkout.blobs.unique': byOid.size, 'git.checkout.blobs.paths': entries.length });
  let single = t.quirks.blobWants === 'single';
  // [oid, data | null] for each oid, in order; null means "stream it on its own"
  async function* group(oids: readonly string[]): AsyncGenerator<readonly [string, Uint8Array | null], void, void> {
    if (oids.length === 1 || single) { for (const oid of oids) yield [oid, null]; return; }
    const got = await fetchBlobs(t, oids);
    if (!got.ok) {
      const e = got.error;
      if (e.code === 'limit_exceeded') { stat.splits++; const h = Math.ceil(oids.length / 2); yield* group(oids.slice(0, h)); yield* group(oids.slice(h)); return; }
      if (!isWantsRefusal(e)) throw e;
      single = true;
      t.quirks.blobWants = 'single';
      span.set({ 'git.checkout.blobs.refused': e.code });
      yield* group(oids); return;
    }
    stat.fetches++;
    for (const oid of oids) yield [oid, getOrElse(mapOption(mapGet(got.value, oid), o => o.data), null)];
  }
  let done = false;
  try {
    for (const e of entries) if (e.mode === MODE_COMMIT) yield { path: e.path, oid: e.oid, mode: e.mode, size: 0, stream: null };
    const oids = [...byOid.keys()];
    for (let i = 0; i < oids.length; i += batch) {
      for await (const [oid, data] of group(oids.slice(i, i + batch))) {
        // every oid in a group is a key of byOid
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- see above (and no `!`: docs/STACK.md)
        for (const e of byOid.get(oid) as CheckoutEntry[]) {
          // a streamed blob is opened per path: one stream cannot be read twice, and tee() would hold the whole blob
          const opened = data ? { size: data.length, stream: bytesStream(data) } : orThrow(await openBlob(t, oid, { follows: span }));
          // oxlint-disable-next-line max-depth -- try, batch, group, paths of one blob: the iterator's shape, as before
          if (data) stat.buffered++; else stat.streamed++;
          stat.bytes += opened.size;
          // gitlinks were yielded above and are not in byOid. The arm is what makes `mode` discriminate CheckoutFile
          // (narrowing `e.mode` does not narrow the entry object, and a spread would not either).
          yield e.mode === MODE_COMMIT
            ? { path: e.path, oid: e.oid, mode: e.mode, size: 0, stream: null }
            : { path: e.path, oid: e.oid, mode: e.mode, size: opened.size, stream: opened.stream };
        }
      }
    }
    done = true;
  } catch (e) {
    const code = thrownCodeOr(e, null);
    span.error(e, code).set({ 'git.checkout.blobs.outcome': code === null ? 'error' : code });
    throw e;
  } finally {
    span.set({ 'git.checkout.blobs.fetches': stat.fetches, 'git.checkout.blobs.buffered': stat.buffered, 'git.checkout.blobs.streamed': stat.streamed, 'git.checkout.blobs.splits': stat.splits, 'git.checkout.blobs.bytes': stat.bytes, 'git.checkout.blobs.single': single });
    if (done) span.set({ 'git.checkout.blobs.outcome': 'ok' });
    // oxlint-disable-next-line typescript/strict-boolean-expressions -- any falsy outcome counts as none recorded, as before
    else if (!span.attrs['git.checkout.blobs.outcome']) span.set({ 'git.checkout.blobs.outcome': 'cancelled' });
    span.end();
  }
}

// A file the iterator yields: its entry, size and content (null for a gitlink: its commit is not in this repository).
// A gitlink has no blob, so no stream. Every other entry has one: the mode is the discriminant.
export type CheckoutFile = Omit<CheckoutEntry, 'mode'> & (
  | { readonly mode: typeof MODE_COMMIT; readonly size: number; readonly stream: null }
  | { readonly mode: Exclude<Mode, typeof MODE_COMMIT>; readonly size: number; readonly stream: ReadableStream<Uint8Array> }
);
export type CheckoutResult = {
  readonly ref: string;
  readonly commit: string;
  readonly tree: string;
  readonly path: string;
  readonly entries: readonly CheckoutEntry[];
  readonly files: AsyncGenerator<CheckoutFile, void, void>;
};
// What checkoutTree takes. `ref: null` is the remote's HEAD; `path` null, '' or '/' is the whole tree.
export type CheckoutConfig = { readonly ref: RefSpec; readonly path: string | null };
export type CheckoutSpec = Input<CheckoutConfig>;
// The options: operation()'s, plus `batch` (wants per blob fetch, 1..limits.maxPackObjects).
export type CheckoutOptions = ReadOptions & Input<{ readonly batch: number }>;
// The path's components and a batch the limits allow, refused in the order the entry always checked them.
function checkoutArgs(path: unknown, batch: number, limits: Limits): Result<string[], PlyError> {
  const comps = pathComps(path, limits, { allowRoot: true });
  if (!comps.ok) return comps;
  if (!Number.isSafeInteger(batch) || batch < 1) return fail('bad_request', 'batch must be an integer from 1 to limits.maxPackObjects', { what: 'batch' });
  const max = readLimit(limits, 'maxPackObjects');
  if (!max.ok) return max;
  if (batch > max.value) return fail('bad_request', 'batch must be an integer from 1 to limits.maxPackObjects', { what: 'batch' });
  return comps;
}
// oxlint-disable-next-line require-await -- async so that a refused argument is a rejection, as before
export async function checkoutTree(url: string, spec: CheckoutSpec = {}, options: CheckoutOptions = {}): Promise<CheckoutResult> {
  const { ref, path } = withDefaults<CheckoutConfig>(spec, { ref: null, path: '' });
  const { batch } = withDefaults<{ readonly batch: number }>(options, { batch: BATCH });
  // A null limits record is the default, as the nullish read had it.
  const limits = getOrElse(fromNullish(options.limits), DEFAULT_LIMITS);
  const comps = orThrow(checkoutArgs(path, batch, limits));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the options' tracer, required at run time: EntryOptions (boundary.ts)
  return operation('checkout', url, ({ ...options, attrs: { 'git.checkout.ref': ref === null ? 'HEAD' : ref, 'git.checkout.path': comps.join('/'), 'git.checkout.batch': batch } } as OperationOpts), async ({ t, root, outcome }) => {
    const { name, commit } = orThrow(await resolveCommitResult(t, ref));
    const trees = orThrow(await fetchTrees(t, commit, limits));
    const oid = orThrow(subtree(trees.tree, trees.root, comps));
    const entries = orThrow(treeFilesResult(trees.tree, oid, { depth: comps.length, limits }));
    // the tracer operation() started the root span on (opts.tracer)
    const files = blobFiles(t, root.tracer, root, entries, batch);
    return outcome('ok', { ref: name, commit, tree: oid, path: comps.join('/'), entries, files }, {
      'git.checkout.commit': commit, 'git.checkout.tree': oid, 'git.checkout.entries': entries.length,
      'git.checkout.pack.objects': trees.objects, 'git.checkout.pack.trees': trees.trees,
    });
  });
}
