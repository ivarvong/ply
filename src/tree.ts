// A whole tree as one commit: the caller names every file (a build output, a generated site, a deploy artifact) and
// the commit's tree is exactly that set. Where editFile changes one path of the parent's tree, pushTree replaces it.
//
//   ls-refs (‖ the hinted commit) → the parent commit (tree:0, deepen 1) → the parent's trees, only where the new tree
//   differs (tree:0 per directory; on a host that refuses tree:0 the first fetch is blob:none and carries them all) →
//   one thin pack: the commit, the new trees (REF_DELTA against the tree they replace when that is smaller), and only the
//   blobs no fetched parent tree names → receive-pack, old oid = the parent (or zeros for a new ref) as the CAS.
//
// Workers-safe (Web APIs only). The directory walk is Node's and lives in tree-node.js.
//
// Shape: pure decisions between thin effects, as edit.js. fileEntries, buildTree, selectObjects are functions of their
// arguments; the effects (lsRefs, fetchObject, push, verifyRef) are free functions over a transport record.
/* oxlint-disable import/max-dependencies -- an entry composes the protocol from one import per module, so its bundle carries nothing else */
import { thrown as fail } from './errors.js';
import { operation, verifyRef } from './operation.js';
import { lsRefs } from './lsrefs.js';
import { fetchObject } from './fetch.js';
import { push, ZERO_OID } from './push.js';
import { makeDelta } from './packresolve.js';
import { parseCommit, parseTree, encodeTree, encodeCommit, hashObject, ident, TYPE } from './objects.js';
import { bytesOf } from './bytes.js';
import { DEFAULT_LIMITS, limitError, requireLimit } from './limits.js';
import type { Limits } from './limits.js';
import { validateIdent, validateRef, validatePath, validateMessage } from './validate.js';
import { decideHead } from './edit.js';
import type { Author, EditOptions, HintOutcome, Ident } from './edit.js';
import { signCommit } from './sign.js';
import { MODE_BLOB, MODE_EXEC, MODE_LINK, MODE_TREE, MODE_COMMIT, DELTA_SIZE_MIN } from './format.js';
import type { Span } from './otel.js';
import type { Caught, EncodeCommit, FetchObject, Fetched, Operation, PackObject, Push, Pushed, Transport, TreeEntry } from './boundary.js';

const OID = /^[0-9a-f]{40}$/u;
const BLOB_MODES: ReadonlySet<string> = new Set([MODE_BLOB, MODE_EXEC, MODE_LINK]);

// The caller's files, in either shape (below): a record or Map of path → content, or an iterable of file specs.
export type FileSpec = { readonly path: string; readonly mode?: string; readonly data?: string | Uint8Array; readonly oid?: string };
export type FileContent = string | Uint8Array | Omit<FileSpec, 'path'>;
export type TreeFiles = Readonly<Record<string, FileContent>> | ReadonlyMap<string, FileContent> | Iterable<FileSpec>;
// One checked file: its path (and components), mode, oid, and bytes (none for a gitlink).
export type FileEntry = { readonly path: string; readonly comps: readonly string[]; readonly mode: string; readonly oid: string; readonly data?: Uint8Array };

// Pure: the caller's files as one list of { path, comps, mode, data?, oid }. Two input shapes:
//   { 'path': content } or a Map    content: string | Uint8Array (100644) | { data, mode } | { mode: '160000', oid }
//   iterable of { path, mode?, data?, oid? }
// Modes are git's tree modes: 100644 file, 100755 executable, 120000 symlink (data = the link target, as git stores
// it), 160000 gitlink (oid = the submodule commit; no data — the server does not need that commit). Every path goes
// through validatePath (no `.git`, `..`, empty component); each blob is bounded by maxObjectSize and the count by
// maxPackObjects before anything is hashed.
// oxlint-disable-next-line complexity -- one check per field, in the order git would refuse them
export function fileEntries(files: unknown, limits: Limits = DEFAULT_LIMITS): FileEntry[] {
  if (files === null || typeof files !== 'object') throw fail('bad_request', 'files must be an object or an iterable of { path, mode, data }', { what: 'files' });
  const maxFiles = requireLimit(limits, 'maxPackObjects');
  const maxObject = requireLimit(limits, 'maxObjectSize');
  // the caller's values: each is checked below (validatePath refuses a missing entry or path)
  /* oxlint-disable typescript/no-unsafe-type-assertion -- see above */
  let pairs: Array<[unknown, unknown]> | null = null;
  if (files instanceof Map) pairs = [...(files as Map<unknown, unknown>)];
  else if (!(Symbol.iterator in files)) pairs = Object.entries(files);
  // oxlint-disable-next-line oxc/no-map-spread -- a fresh object per value: a spread defines `path`, where Object.assign would run a `__proto__` setter
  const list = (pairs ? pairs.map(([path, v]) => (typeof v === 'string' || v instanceof Uint8Array ? { path, data: v } : { ...(v as object), path })) : files) as Iterable<FileSpec | null | undefined>;
  /* oxlint-enable typescript/no-unsafe-type-assertion */
  const out: FileEntry[] = [];
  for (const f of list) {
    if (out.length >= maxFiles) throw limitError('files', out.length + 1, maxFiles);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an absent entry reads as no fields, which validatePath refuses
    const spec = (f ?? {}) as FileSpec;
    const { path, mode = MODE_BLOB } = spec;
    const comps = validatePath(path, limits);
    if (mode === MODE_COMMIT) {
      const oid = spec.oid ?? '';
      if (!OID.test(oid) || spec.data !== undefined) throw fail('bad_request', `${path}: a gitlink (160000) takes a 40-hex oid and no data`, { what: 'gitlink', path });
      out.push({ path, comps, mode, oid });
      continue;
    }
    if (!BLOB_MODES.has(mode)) throw fail('bad_request', `${path}: mode ${JSON.stringify(mode)} is not 100644, 100755, 120000 or 160000`, { what: 'mode', path });
    const data: unknown = bytesOf(spec.data);
    if (!(data instanceof Uint8Array)) throw fail('bad_request', `${path}: data must be a string or Uint8Array`, { what: 'data', path });
    if (data.length > maxObject) throw limitError('object size', data.length, maxObject);
    // a symlink target is a path: git cannot check out an empty one, and a NUL ends it on every platform
    if (mode === MODE_LINK && (data.length === 0 || data.includes(0))) throw fail('bad_request', `${path}: a symlink target must be non-empty and contain no NUL`, { what: 'symlink', path });
    out.push({ path, comps, mode, data, oid: hashObject('blob', data) });
  }
  return out;
}

const depth = (dir: string): number => (dir === '' ? 0 : dir.split('/').length);

// A directory entry of a built tree; the built trees by directory ('' is the root) and the blobs by oid.
export type DirEntry = { readonly mode: string; readonly name: string; readonly oid: string };
export type BuiltDir = { readonly oid: string; readonly data: Uint8Array; readonly entries: readonly DirEntry[] };
export type BuiltTree = { readonly root: string; readonly trees: ReadonlyMap<string, BuiltDir>; readonly blobs: ReadonlyMap<string, Uint8Array> };
// Pure: the trees of `entries`, bottom up. Returns { root, trees: Map(dir → { oid, data, entries }), blobs: Map(oid →
// data) }; '' is the root directory. A path given twice, or used as both a file and a directory, is the caller's
// error (git would reject the tree as duplicateEntries); each directory is bounded by maxTreeEntries. No files at all is
// git's empty tree (4b825dc6…), a valid root.
export function buildTree(entries: readonly FileEntry[], limits: Limits = DEFAULT_LIMITS): BuiltTree {
  const maxEntries = requireLimit(limits, 'maxTreeEntries');
  // null: a subdirectory (its entries are under its own key)
  const dirs = new Map<string, Map<string, DirEntry | null>>([['', new Map()]]);
  const blobs = new Map<string, Uint8Array>();
  // every directory looked up below was added to `dirs` (or `trees`) before: the root, or by the step that named it
  /* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- see above (and no `!`: docs/STACK.md) */
  for (const e of entries) {
    let dir = '';
    for (const name of e.comps.slice(0, -1)) {
      const sub = dir ? `${dir}/${name}` : name;
      const here = dirs.get(dir) as Map<string, DirEntry | null>;
      if (here.has(name) && here.get(name) !== null) throw fail('bad_request', `${sub} is both a file and a directory`, { what: 'path', path: e.path });
      if (!here.has(name)) { here.set(name, null); dirs.set(sub, new Map()); }
      dir = sub;
    }
    const here = dirs.get(dir) as Map<string, DirEntry | null>, name = e.comps.at(-1) as string;
    if (here.has(name)) throw fail('bad_request', here.get(name) === null ? `${e.path} is both a file and a directory` : `${e.path} is given twice`, { what: 'path', path: e.path });
    if (here.size >= maxEntries) throw limitError('tree entries', here.size + 1, maxEntries);
    here.set(name, { mode: e.mode, name, oid: e.oid });
    if (e.data) blobs.set(e.oid, e.data);
  }
  // deepest first, so every subtree's oid exists before its parent is encoded
  const trees = new Map<string, BuiltDir>();
  for (const dir of [...dirs.keys()].toSorted((a, b) => depth(b) - depth(a))) {
    const list = [...(dirs.get(dir) as Map<string, DirEntry | null>)].map(([name, e]) => e ?? { mode: MODE_TREE, name, oid: (trees.get(dir ? `${dir}/${name}` : name) as BuiltDir).oid });
    const data = encodeTree(list);
    trees.set(dir, { oid: hashObject('tree', data), data, entries: list });
  }
  return { root: (trees.get('') as BuiltDir).oid, trees, blobs };
  /* oxlint-enable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style */
}

// What the server is known to hold: `have` (oids), `old` (dir → the parent's tree there, a delta base).
export type Known = { readonly have: ReadonlySet<string>; readonly old: ReadonlyMap<string, { readonly oid: string; readonly data: Uint8Array }> };
export type Selected = { readonly trees: PackObject[]; readonly blobs: PackObject[]; readonly deltas: number };
// Pure: what the pack must carry, given what the server is known to have. `have`: every oid named by a parent tree we
// fetched (the server holds the parent commit's whole closure, so each of those objects is there); `old`: dir → the
// parent's tree bytes at that path, a REF_DELTA base. A tree the server has is skipped with everything under it; a
// blob or tree reached twice is sent once (receive-pack refuses a pack with an object twice). Gitlinks send nothing.
export function selectObjects(built: BuiltTree, { have = new Set(), old = new Map() }: Partial<Known> = {}): Selected {
  const blobs: PackObject[] = [];
  const sent = new Set<string>();
  const trees: PackObject[] = [];
  // every dir walked is a key of built.trees (the root, or a tree entry of one), and every blob entry's oid a key of built.blobs
  /* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- see above (and no `!`: docs/STACK.md) */
  const walk = (dir: string): void => {
    const t = built.trees.get(dir) as BuiltDir;
    if (have.has(t.oid) || sent.has(t.oid)) return;
    sent.add(t.oid);
    const base = old.get(dir);
    const delta = base ? makeDelta(base.data, t.data).delta : null;
    // git's patch_delta rejects a delta under DELTA_SIZE_MIN; a delta no smaller than the tree is not worth the base lookup
    trees.push(delta && delta.length >= DELTA_SIZE_MIN && delta.length < t.data.length ? { type: TYPE.TREE, data: delta, baseOid: (base as { readonly oid: string }).oid } : { type: TYPE.TREE, data: t.data });
    for (const e of t.entries) {
      if (e.mode === MODE_TREE) walk(dir ? `${dir}/${e.name}` : e.name);
      else if (BLOB_MODES.has(e.mode) && !have.has(e.oid) && !sent.has(e.oid)) { sent.add(e.oid); blobs.push({ type: TYPE.BLOB, data: built.blobs.get(e.oid) as Uint8Array }); }
    }
  };
  /* oxlint-enable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style */
  walk('');
  return { trees, blobs, deltas: trees.filter(t => t.baseOid !== undefined).length };
}

export type TreeSpec = {
  readonly ref?: string;
  readonly base?: string;
  readonly files: TreeFiles;
  readonly author: Author;
  readonly message: string;
  readonly time?: number;
};
export type TreePlan = {
  readonly ref: string;
  readonly base: string;
  readonly create: boolean;
  readonly built: BuiltTree;
  readonly files: number;
  readonly author: Ident;
  readonly message: string;
  readonly head: string | null;
};
// Pure: every caller-controlled field, checked before any I/O. `base` as in editFile: the ref whose head is the
// parent (default `ref`); base ≠ ref creates `ref` (zero old oid). base = ref and the ref absent: the first commit of a
// new ref, no parent, zero old oid — a deploy's first push.
export function validateTreeSpec({ ref = 'refs/heads/main', base = ref, files, author, message, time = Math.floor(Date.now() / 1000) }: TreeSpec, limits: Limits, head: string | null = null): TreePlan {
  validateRef(ref); validateRef(base);
  const person = validateIdent({ name: author?.name, email: author?.email, time, tz: author?.tz });
  validateMessage(message);
  if (head !== null && !OID.test(head)) throw fail('bad_request', 'head must be a 40-hex oid');
  const entries = fileEntries(files, limits);
  const built = buildTree(entries, limits);
  return Object.freeze({ ref, base, create: base !== ref, built, files: entries.length, author: person, message, head });
}

export type PushTreeResult = {
  readonly noop: boolean;
  readonly ref: string;
  readonly oldCommit: string | null;
  readonly newCommit: string | null;
  readonly oldTree: string | null;
  readonly newTree: string;
  readonly hint: HintOutcome | null;
  readonly attempt: number;
  readonly pushBytes: number;
  readonly treesRead: number;
  readonly objects: { readonly files: number; readonly trees: number; readonly sent: number; readonly sentTrees: number; readonly sentBlobs: number; readonly treeDeltas: number };
};
// Pure: the result record.
const summarize = ({ s, parent, oldTree, hint, attempt, newCommit = parent, sel = null, pushed = null, treesRead = 0, noop = false }: {
  readonly s: TreePlan;
  readonly parent: string | null;
  readonly oldTree: string | null;
  readonly hint: HintOutcome | null;
  readonly attempt: number;
  readonly newCommit?: string | null;
  readonly sel?: Selected | null;
  readonly pushed?: Pushed | null;
  readonly treesRead?: number;
  readonly noop?: boolean;
}): PushTreeResult => ({
  noop, ref: s.ref, oldCommit: parent, newCommit, oldTree, newTree: s.built.root, hint, attempt,
  pushBytes: pushed?.packBytes ?? 0, treesRead,
  objects: { files: s.files, trees: s.built.trees.size, sent: pushed?.entries.length ?? 0, sentTrees: sel?.trees.length ?? 0, sentBlobs: sel?.blobs.length ?? 0, treeDeltas: sel?.deltas ?? 0 },
});

type Read = Known & { read: number; hits: number };
// Effect: the parent's trees wherever the new tree differs, recursing only into directories present on both sides with
// different oids. Every oid those trees name joins `have`. On a host that refuses tree:0 the first fetch is a blob:none
// pack that brings every tree of the subtree (fetch.js harvests them), so the rest are answered without a round trip.
async function parentTrees(t: Transport, cache: Map<string, Uint8Array>, built: BuiltTree, oldTree: string | null, limits: Limits): Promise<Read> {
  const have = new Set<string>(), old = new Map<string, { readonly oid: string; readonly data: Uint8Array }>();
  const k = { have, old, read: 0, hits: 0 };
  if (oldTree === null) return k;
  have.add(oldTree);
  const read = async (oid: string): Promise<Uint8Array> => {
    let data = cache.get(oid);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fetch.js is JS: `expectType = null` reads as the type null (boundary.ts)
    if (data) k.hits++; else { data = (await (fetchObject as FetchObject)(t, { oid, expectType: TYPE.TREE })).data; cache.set(oid, data); k.read++; }
    return data;
  };
  const visit = async (dir: string, oid: string): Promise<void> => {
    const data = await read(oid);
    old.set(dir, { oid, data });
    const before = new Map<string, TreeEntry>(parseTree(data, limits).map((e: TreeEntry) => [e.name, e]));
    for (const e of before.values()) have.add(e.oid);
    const next: Array<Promise<void>> = [];
    // dir is a key of built.trees: the root, or a tree entry of a directory visited before it
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- see above (and no `!`: docs/STACK.md)
    for (const e of (built.trees.get(dir) as BuiltDir).entries) {
      const was = before.get(e.name);
      if (e.mode === MODE_TREE && was && was.mode === MODE_TREE && was.oid !== e.oid) next.push(visit(dir ? `${dir}/${e.name}` : e.name, was.oid));
    }
    await Promise.all(next);
  };
  if (oldTree !== built.root) await visit('', oldTree);
  return k;
}

// What the attempt loop attaches to an error on its way out (operation() adds the root span).
type Tagged = { code?: unknown; span?: Span; attempt?: number; hint?: HintOutcome | null };
type Attempt = { readonly head: string | null; readonly attempt: number; readonly linkTo: Span | null; readonly hintWas?: HintOutcome | null };
export type PushTreeOptions = Omit<EditOptions, 'allowLfsPointer'>;

// oxlint-disable-next-line require-await -- async, as before: a throw while starting the operation is a rejection
async function pushTreeOnce(url: string, s: TreePlan, { cache = new Map<string, Uint8Array>(), verify = false, signer = null, strictHead = false, ...opts }: Omit<PushTreeOptions, 'head'> = {}, { head, attempt, linkTo, hintWas = null }: Attempt): Promise<PushTreeResult> {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  let hint = hintWas;
  const attrs = { 'git.push_tree.ref': s.ref, 'git.push_tree.base': s.base, 'git.push_tree.create': s.create, 'git.push_tree.files': s.files, 'git.push_tree.trees': s.built.trees.size, 'git.push_tree.tree.new': s.built.root, 'git.push_tree.head.hint': head ?? '', 'git.push_tree.attempt': attempt };
  // operation.js is JS: `link = null` reads as the type null (boundary.ts); the push is one sequence of protocol steps
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, complexity -- see above
  return (operation as Operation)('push_tree', url, { ...opts, attrs, onFinish: () => ({ 'git.push_tree.head.outcome': hint ?? '' }), link: linkTo ? { span: linkTo, kind: 'retry_of' } : null }, async ({ t, root, outcome }) => {
    // fetch.js is JS: `expectType = null` reads as the type null (boundary.ts); its promise is returned as is
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, promise-function-async -- see above
    const commitOf = (oid: string): Promise<Fetched> => (fetchObject as FetchObject)(t, { oid, expectType: TYPE.COMMIT, deepen: 1 });
    try {
    // 1. the parent: ls-refs, overlapped with the hinted commit. An absent base is a new ref only when base = ref.
    const [resolved, speculative] = await Promise.all([lsRefs(t, [s.base]).then(({ refs }: { readonly refs: ReadonlyMap<string, { readonly oid: string }> }) => refs.get(s.base)?.oid ?? null), head === null ? null : commitOf(head).then(o => o, (e: unknown) => e)]);
    if (resolved === null && s.create) throw fail('not_found', `ref ${s.base} not found`);
    const decided = decideHead({ hint: head, resolved });
    hint = hintWas ?? decided.hint;
    const parent = decided.oldCommit;
    if (strictHead && decided.hint === 'stale') throw fail('cas_conflict', `${s.base} is at ${parent ?? 'nothing'}, not the expected head ${head}`, { expected: head, actual: parent });
    if (speculative instanceof Error) root.set({ 'git.push_tree.head.speculative_error': (speculative as Caught)?.code ?? 'error' });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fulfilled speculative fetch is commitOf's value (the rejection branch is the Error above)
    const oldTree: string | null = parent === null ? null : parseCommit((decided.hint === 'used' && !(speculative instanceof Error) ? speculative as Fetched : await commitOf(parent)).data, limits).tree;
    root.set({ 'git.push_tree.commit.old': parent ?? '', 'git.push_tree.tree.old': oldTree ?? '' });
    if (oldTree === s.built.root && !s.create) return outcome('noop', summarize({ s, parent, oldTree, hint, attempt, noop: true }));

    // 2. what the server has: the parent's trees along every directory whose oid changed (cache by oid, immutable)
    // oxlint-disable-next-line promise-function-async -- parentTrees' promise, as before
    const known = await root.tracer.span('git.push_tree.diff', { parent: root }, span => parentTrees(t, cache, s.built, oldTree, limits).then(k => { span.set({ 'git.push_tree.diff.trees_read': k.read, 'git.push_tree.diff.cache_hits': k.hits, 'git.push_tree.diff.have': k.have.size }); return k; }));
    const sel = selectObjects(s.built, known);

    // 3. the commit, then one push whose old oid is the CAS
    const who = ident(s.author);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- objects.js is JS: `parents = []` reads as never[] (boundary.ts)
    let commitData = (encodeCommit as unknown as EncodeCommit)({ tree: s.built.root, parents: parent === null ? [] : [parent], author: who, committer: who, message: s.message.endsWith('\n') ? s.message : `${s.message}\n` });
    if (signer) { commitData = await signCommit(commitData, signer); root.set({ 'git.push_tree.commit.signed': signer.kind, 'git.push_tree.commit.signer': signer.publicKeyLine ?? '' }); }
    const newCommit = hashObject('commit', commitData);
    const objects = [{ type: TYPE.COMMIT, data: commitData }, ...sel.trees, ...sel.blobs];
    root.set({ 'git.push_tree.commit.new': newCommit, 'git.push_tree.send.trees': sel.trees.length, 'git.push_tree.send.tree_deltas': sel.deltas, 'git.push_tree.send.blobs': sel.blobs.length });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- push.js is JS: `objects = []` reads as never[] (boundary.ts)
    const pushed = await (push as unknown as Push)(t, { ref: s.ref, oldOid: s.create || parent === null ? ZERO_OID : parent, newOid: newCommit, objects });
    for (const tr of s.built.trees.values()) cache.set(tr.oid, tr.data);
    if (verify) await verifyRef(t, root, 'git.push_tree', s.ref, newCommit);
    return outcome('ok', summarize({ s, parent, oldTree, hint, attempt, newCommit, sel, pushed, treesRead: known.read }), { 'git.push_tree.push.bytes': pushed.packBytes, 'git.push_tree.push.objects': pushed.entries.length });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a thrown object gets the attempt's fields, as before
    } catch (e) { if (typeof e === 'object' && e !== null) { const g = e as Tagged; g.attempt = attempt; g.hint = hint; } throw e; }
  });
}

// Same contract as editFile: `head` overlaps ls-refs with a speculative fetch of the hinted commit (ls-refs wins); a
// cas_conflict on attempt 0 is redone once from a fresh ls-refs, the retry's span linked to the first; `strictHead`
// makes the hint a precondition and is never retried; `verify` reads the ref back and an acknowledged push that does
// not read back is `ambiguous`. A retry rebuilds on the new head: the tree is still exactly `files` (that is the
// contract — another writer's files are not merged in), its parent is whatever won the race.
// The files are hashed once: the retry reuses the validated spec (same commit time, same trees).
export async function pushTree(url: string, spec: TreeSpec, { head = null, strictHead = false, ...opts }: PushTreeOptions = {}): Promise<PushTreeResult> {
  if (strictHead && head === null) throw fail('bad_request', 'strictHead needs head');
  const s = validateTreeSpec(spec, opts.limits ?? DEFAULT_LIMITS, head);
  const first = await pushTreeOnce(url, s, { ...opts, strictHead }, { head, attempt: 0, linkTo: null }).catch((e: unknown) => e);
  // a value that is not an Error is pushTreeOnce's result (a thrown non-Error would land here too, as before)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  if (!(first instanceof Error)) return first as PushTreeResult;
  // an Error from the first attempt: pushTreeOnce tagged it (attempt, hint) and operation() gave it its root span
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  const f = first as Error & Tagged;
  if (f.code !== 'cas_conflict' || f.attempt !== 0 || strictHead) throw first;
  return pushTreeOnce(url, s, opts, { head: null, attempt: 1, linkTo: f.span ?? null, hintWas: f.hint ?? null });
}
