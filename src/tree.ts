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
/* oxlint-disable unicorn/explicit-length-check, require-unicode-regexp -- bundle budget: the JS's truthy length checks and non-unicode regexes, byte for byte (no behaviour change) */
// Decisions return Result; the public functions (fileEntries, buildTree, validateTreeSpec, pushTree) stay throwing until the Result
// cut-over (docs/STACK.md step 3).
import { fail, orThrow } from './errors.js';
import type { ErrorOf, PlyError } from './errors.js';
import type { OperationOpts } from './operation.js';
import { operation, verifyRef } from './operation.js';
import { lsRefs } from './lsrefs.js';
import { fetchObject } from './fetch.js';
import { push, validated, ZERO_OID } from './push.js';
import { parseRefname } from './refname.js';
import type { Refname } from './refname.js';
import { makeDelta } from './packresolve.js';
import { parseCommit, parseTree, encodeTree, encodeCommit, hashObject, ident, TYPE } from './objects.js';
import { bytesOf } from './bytes.js';
import { DEFAULT_LIMITS, limitExceeded, readLimit } from './limits.js';
import type { Limits } from './limits.js';
import { validateIdent, validateRef, validatePushRef, validatePath, validateMessage } from './validate.js';
import { decideHead, inSpan, limitsOf, needsHead, retryLink, strictParent, tagAttempt } from './edit.js';
import type { Author, EditConfig, EditOptions, HintOutcome, Ident } from './edit.js';
import { signCommitResult } from './sign.js';
import { MODE_BLOB, MODE_LINK, MODE_TREE, MODE_COMMIT, BLOB_MODES, DELTA_SIZE_MIN } from './format.js';
import type { Span } from './otel.js';
import type { FetchedObject as Fetched } from './fetch.js';
import type { PackObject, PushResult as Pushed } from './push.js';
import type { Transport } from './transport.js';
import type { TreeEntry } from './objects.js';
import { thrownCodeIs, thrownCodeOr } from './boundary.js';
import type { Input } from './absent.js';
import { fromNullable, fromNullish, mapGet, withDefaults } from './absent.js';
import { err, getOrElse, mapOption, matchOption, ok } from './result.js';
import type { Result } from './result.js';

const OID = /^[0-9a-f]{40}$/;
const BLOB_MODE_SET: ReadonlySet<string> = new Set(BLOB_MODES);

// The caller's files, in either shape (below): a record or Map of path → content, or an iterable of file specs.
export type FileSpec = { readonly path: string } & Input<{ readonly mode: string; readonly data: string | Uint8Array; readonly oid: string }>;
export type FileContent = string | Uint8Array | Omit<FileSpec, 'path'>;
export type TreeFiles = Readonly<Record<string, FileContent>> | ReadonlyMap<string, FileContent> | Iterable<FileSpec>;
// One checked file: its path (and components), mode, oid, and bytes. A gitlink has no bytes (and no `data` key).
type EntryBase = { readonly path: string; readonly comps: readonly string[]; readonly mode: string; readonly oid: string };
export type BlobFileEntry = EntryBase & { readonly data: Uint8Array };
export type FileEntry = EntryBase | BlobFileEntry;
const isBlobEntry = (e: FileEntry): e is BlobFileEntry => 'data' in e;
type TreeError = ErrorOf<'bad_request' | 'limit_exceeded'>;

// One caller entry, read as given: an entry that is not an object (null, a string) has no fields, and validatePath
// refuses its missing path.
const specOf = (f: unknown): Input<FileSpec> => {
  // the caller's object: each field is checked below
  return typeof f === 'object' && f !== null ? f : {};

};

// Pure: the caller's files as one list of { path, comps, mode, data?, oid }. Two input shapes:
//   { 'path': content } or a Map    content: string | Uint8Array (100644) | { data, mode } | { mode: '160000', oid }
//   iterable of { path, mode?, data?, oid? }
// Modes are git's tree modes: 100644 file, 100755 executable, 120000 symlink (data = the link target, as git stores
// it), 160000 gitlink (oid = the submodule commit; no data — the server does not need that commit). Every path goes
// through validatePath (no `.git`, `..`, empty component); each blob is bounded by maxObjectSize and the count by
// maxPackObjects before anything is hashed.
// oxlint-disable-next-line complexity -- one check per field, in the order git would refuse them
export function fileEntriesResult(files: unknown, limits: Limits = DEFAULT_LIMITS): Result<FileEntry[], PlyError> {
  if (files === null || typeof files !== 'object') return fail('bad_request', 'files must be an object or an iterable of { path, mode, data }', { what: 'files' });
  const maxFiles = readLimit(limits, 'maxPackObjects');
  if (!maxFiles.ok) return maxFiles;
  const maxObject = readLimit(limits, 'maxObjectSize');
  if (!maxObject.ok) return maxObject;
  // the caller's values: each is checked below (validatePath refuses a missing entry or path)
  /* oxlint-disable typescript/no-unsafe-type-assertion -- see above */
  // oxlint-disable-next-line no-nested-ternary -- bundle budget: the JS's expression, byte for byte
  const pairs = files instanceof Map ? [...(files as Map<unknown, unknown>)] : Symbol.iterator in files ? null : Object.entries(files);
  // oxlint-disable-next-line oxc/no-map-spread -- a fresh object per value: a spread defines `path`, where Object.assign would run a `__proto__` setter
  const list = (pairs ? pairs.map(([path, v]) => (typeof v === 'string' || v instanceof Uint8Array ? { path, data: v } : { ...(v as object), path })) : files) as Iterable<unknown>;
  /* oxlint-enable typescript/no-unsafe-type-assertion */
  const out: FileEntry[] = [];
  for (const f of list) {
    if (out.length >= maxFiles.value) return err(limitExceeded('files', out.length + 1, maxFiles.value));
    const spec = specOf(f);
    const comps = validated(() => validatePath(spec.path, limits));
    if (!comps.ok) return comps;
    const path = comps.value.join('/');
    // a mode left out is a file's; any other value (null included) is the caller's, and checked
    const mode: unknown = getOrElse<unknown>(fromNullable(spec.mode), MODE_BLOB);
    if (mode === MODE_COMMIT) {
      const oid = getOrElse(fromNullish(spec.oid), '');
      if (!OID.test(oid) || fromNullable(spec.data).tag === 'some') return fail('bad_request', `${path}: a gitlink (160000) takes a 40-hex oid and no data`, { what: 'gitlink', path });
      out.push({ path, comps: comps.value, mode, oid });
      continue;
    }
    if (typeof mode !== 'string' || !BLOB_MODE_SET.has(mode)) return fail('bad_request', `${path}: mode ${JSON.stringify(mode)} is not 100644, 100755, 120000 or 160000`, { what: 'mode', path });
    const raw: unknown = spec.data;
    if (typeof raw !== 'string' && !(raw instanceof Uint8Array)) return fail('bad_request', `${path}: data must be a string or Uint8Array`, { what: 'data', path });
    const data = bytesOf(raw);
    if (data.length > maxObject.value) return err(limitExceeded('object size', data.length, maxObject.value));
    // a symlink target is a path: git cannot check out an empty one, and a NUL ends it on every platform
    if (mode === MODE_LINK && (data.length === 0 || data.includes(0))) return fail('bad_request', `${path}: a symlink target must be non-empty and contain no NUL`, { what: 'symlink', path });
    out.push({ path, comps: comps.value, mode, data, oid: hashObject('blob', data) });
  }
  return ok(out);
}
// The throwing form (a public entry) until the Result cut-over.
export const fileEntries = (files: unknown, limits: Limits = DEFAULT_LIMITS): FileEntry[] => orThrow(fileEntriesResult(files, limits));

// A directory entry of a built tree; the built trees by directory ('' is the root) and the blobs by oid.
export type DirEntry = { readonly mode: string; readonly name: string; readonly oid: string };
export type BuiltDir = { readonly oid: string; readonly data: Uint8Array; readonly entries: readonly DirEntry[] };
export type BuiltTree = { readonly root: string; readonly trees: ReadonlyMap<string, BuiltDir>; readonly blobs: ReadonlyMap<string, Uint8Array> };
// Pure: the trees of `entries`, bottom up. Returns { root, trees: Map(dir → { oid, data, entries }), blobs: Map(oid →
// data) }; '' is the root directory. A path given twice, or used as both a file and a directory, is the caller's
// error (git would reject the tree as duplicateEntries); each directory is bounded by maxTreeEntries. No files at all is
// git's empty tree (4b825dc6…), a valid root.
export function buildTreeResult(entries: readonly FileEntry[], limits: Limits = DEFAULT_LIMITS): Result<BuiltTree, TreeError> {
  const maxEntries = readLimit(limits, 'maxTreeEntries');
  if (!maxEntries.ok) return maxEntries;
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
      if (here.has(name) && here.get(name) !== null) return fail('bad_request', `${sub} is both a file and a directory`, { what: 'path', path: e.path });
      if (!here.has(name)) { here.set(name, null); dirs.set(sub, new Map()); }
      dir = sub;
    }
    const here = dirs.get(dir) as Map<string, DirEntry | null>, name = e.comps.at(-1) as string;
    if (here.has(name)) return fail('bad_request', here.get(name) === null ? `${e.path} is both a file and a directory` : `${e.path} is given twice`, { what: 'path', path: e.path });
    if (here.size >= maxEntries.value) return err(limitExceeded('tree entries', here.size + 1, maxEntries.value));
    here.set(name, { mode: e.mode, name, oid: e.oid });
    if (isBlobEntry(e)) blobs.set(e.oid, e.data);
  }
  // deepest first, so every subtree's oid exists before its parent is encoded
  const trees = new Map<string, BuiltDir>();
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- bundle budget: where the JS had it
  const depth = (dir: string): number => (dir === '' ? 0 : dir.split('/').length);
  for (const dir of [...dirs.keys()].toSorted((a, b) => depth(b) - depth(a))) {
    const list = [...(dirs.get(dir) as Map<string, DirEntry | null>)].map(([name, e]) => (e === null ? { mode: MODE_TREE, name, oid: (trees.get(dir ? `${dir}/${name}` : name) as BuiltDir).oid } : e));
    const data = encodeTree(list);
    trees.set(dir, { oid: hashObject('tree', data), data, entries: list });
  }
  return ok({ root: (trees.get('') as BuiltDir).oid, trees, blobs });
  /* oxlint-enable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style */
}
// The throwing form (a public entry) until the Result cut-over.
export const buildTree = (entries: readonly FileEntry[], limits: Limits = DEFAULT_LIMITS): BuiltTree => orThrow(buildTreeResult(entries, limits));

// What the server is known to hold: `have` (oids), `old` (dir → the parent's tree there, a delta base).
export type Known = { readonly have: ReadonlySet<string>; readonly old: ReadonlyMap<string, { readonly oid: string; readonly data: Uint8Array }> };
export type Selected = { readonly trees: PackObject[]; readonly blobs: PackObject[]; readonly deltas: number };
// Pure: what the pack must carry, given what the server is known to have. `have`: every oid named by a parent tree we
// fetched (the server holds the parent commit's whole closure, so each of those objects is there); `old`: dir → the
// parent's tree bytes at that path, a REF_DELTA base. A tree the server has is skipped with everything under it; a
// blob or tree reached twice is sent once (receive-pack refuses a pack with an object twice). Gitlinks send nothing.
export function selectObjects(built: BuiltTree, { have = new Set(), old = new Map() }: Input<Known> = {}): Selected {
  const sent = new Set<string>();
  const trees: PackObject[] = [];
  const blobs: PackObject[] = [];
  // every dir walked is a key of built.trees (the root, or a tree entry of one), and every blob entry's oid a key of built.blobs
  /* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- see above (and no `!`: docs/STACK.md) */
  const walk = (dir: string): void => {
    const t = built.trees.get(dir) as BuiltDir;
    if (have.has(t.oid) || sent.has(t.oid)) return;
    sent.add(t.oid);
    // git's patch_delta rejects a delta under DELTA_SIZE_MIN; a delta no smaller than the tree is not worth the base lookup
    const thin = mapOption(mapGet(old, dir), base => ({ base: base.oid, delta: makeDelta(base.data, t.data).delta }));
    trees.push(thin.tag === 'some' && thin.value.delta.length >= DELTA_SIZE_MIN && thin.value.delta.length < t.data.length ? { type: TYPE.TREE, data: thin.value.delta, baseOid: thin.value.base } : { type: TYPE.TREE, data: t.data });
    for (const e of t.entries) {
      if (e.mode === MODE_TREE) walk(dir ? `${dir}/${e.name}` : e.name);
      else if (BLOB_MODE_SET.has(e.mode) && !have.has(e.oid) && !sent.has(e.oid)) { sent.add(e.oid); blobs.push({ type: TYPE.BLOB, data: built.blobs.get(e.oid) as Uint8Array }); }
    }
  };
  /* oxlint-enable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style */
  walk('');
  // oxlint-disable-next-line typescript/strict-boolean-expressions -- bundle budget: the JS's own truthy test, byte for byte (baseOid is an oid or not there)
  return { trees, blobs, deltas: trees.filter(t => t.baseOid).length };
}

// What the caller names besides the files: `ref` (default refs/heads/main), `base` (default `ref`), `time` (default now).
export type TreeSpecConfig = { readonly ref: string; readonly base: string; readonly time: number };
export type TreeSpec = Input<TreeSpecConfig> & { readonly files: TreeFiles; readonly author: Author; readonly message: string };
export type TreePlan = {
  readonly ref: Refname;
  readonly base: string;
  readonly create: boolean;
  readonly built: BuiltTree;
  readonly files: number;
  readonly author: Ident;
  readonly message: string;
  readonly head: string | null;
};
// The author as validateIdent reads it: a missing author has no fields (and is refused there); a zone left out is UTC,
// any other value is the caller's and checked.
const authorInput = (author: Author | null, time: number): Parameters<typeof validateIdent>[0] =>
  matchOption(fromNullish(author), {
    none: () => ({ time }),
    some: a => matchOption(fromNullable(a.tz), { none: () => ({ name: a.name, email: a.email, time }), some: tz => ({ name: a.name, email: a.email, time, tz }) }),
  });
// Pure: every caller-controlled field, checked before any I/O. `base` as in editFile: the ref whose head is the
// parent (default `ref`); base ≠ ref creates `ref` (zero old oid). base = ref and the ref absent: the first commit of a
// new ref, no parent, zero old oid — a deploy's first push.
export function validateTreeSpecResult(spec: TreeSpec, limits: Limits, head: string | null = null): Result<TreePlan, PlyError> {
  const { ref, time } = withDefaults(spec, { ref: 'refs/heads/main', time: Math.floor(Date.now() / 1000) });
  const { files, author, message } = spec;
  const pushRef = validated(() => validatePushRef(ref, false));
  if (!pushRef.ok) return pushRef;
  // a base left out is `ref`; any other value (null included) is the caller's, and checked
  const baseRef = validated(() => validateRef(getOrElse<unknown>(fromNullable(spec.base), ref)));
  if (!baseRef.ok) return baseRef;
  const base = baseRef.value;

  const person = validated(() => validateIdent(authorInput(author, time)));
  if (!person.ok) return person;
  const checkedMessage = validated(() => validateMessage(message));
  if (!checkedMessage.ok) return checkedMessage;
  if (head !== null && !OID.test(head)) return fail('bad_request', 'head must be a 40-hex oid');
  const entries = fileEntriesResult(files, limits);
  if (!entries.ok) return entries;
  // Before buildTree retains the blobs. got is the running total, including the file that crossed the cap.
  // Exactly the cap is allowed. A gitlink has no bytes. A single file over maxObjectSize already failed above.
  const maxPush = readLimit(limits, 'maxPushBytes');
  if (!maxPush.ok) return maxPush;
  let pushBytes = 0;
  for (const e of entries.value) {
    const next = pushBytes + (isBlobEntry(e) ? e.data.length : 0);
    if (next > maxPush.value) return err(limitExceeded('push bytes', next, maxPush.value));
    pushBytes = next;
  }
  const built = buildTreeResult(entries.value, limits);
  if (!built.ok) return built;
  // validatePushRef passed, so the ref is a refname
  const branded = parseRefname(ref);
  if (!branded.ok) return branded;
  return ok(Object.freeze({ ref: branded.value, base, create: base !== ref, built: built.value, files: entries.value.length, author: person.value, message, head }));
}
// The throwing form (a public entry) until the Result cut-over.
export const validateTreeSpec = (spec: TreeSpec, limits: Limits, head: string | null = null): TreePlan => orThrow(validateTreeSpecResult(spec, limits, head));

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
// Pure: the result record. `sent` is what was pushed; a no-op has nothing.
type Sent = { readonly newCommit: string; readonly sel: Selected; readonly pushed: Pushed; readonly treesRead: number };
const summarize = ({ s, parent, oldTree, hint, attempt }: {
  readonly s: TreePlan;
  readonly parent: string | null;
  readonly oldTree: string | null;
  readonly hint: HintOutcome | null;
  readonly attempt: number;
}, sent: Sent | null): PushTreeResult => {
  const files = s.files, trees = s.built.trees.size;
  if (sent === null) {
    return { noop: true, ref: s.ref, oldCommit: parent, newCommit: parent, oldTree, newTree: s.built.root, hint, attempt, pushBytes: 0, treesRead: 0, objects: { files, trees, sent: 0, sentTrees: 0, sentBlobs: 0, treeDeltas: 0 } };
  }
  const { newCommit, sel, pushed, treesRead } = sent;
  return {
    noop: false, ref: s.ref, oldCommit: parent, newCommit, oldTree, newTree: s.built.root, hint, attempt, pushBytes: pushed.packBytes, treesRead,
    objects: { files, trees, sent: pushed.entries.length, sentTrees: sel.trees.length, sentBlobs: sel.blobs.length, treeDeltas: sel.deltas },
  };
};

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
    const cached = mapGet(cache, oid);
    if (cached.tag === 'some') { k.hits++; return cached.value; }
    const data = (await fetchObject(t, { oid, expectType: TYPE.TREE })).data;
    cache.set(oid, data); k.read++;
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
      const was = mapGet(before, e.name);
      if (e.mode === MODE_TREE && was.tag === 'some' && was.value.mode === MODE_TREE && was.value.oid !== e.oid) next.push(visit(dir ? `${dir}/${e.name}` : e.name, was.value.oid));
    }
    await Promise.all(next);
  };
  if (oldTree !== built.root) await visit('', oldTree);
  return k;
}

// Pure: an absent base is a new ref only when base = ref; a base ≠ ref must exist.
function baseFound(s: TreePlan, resolved: string | null): Result<null, ErrorOf<'not_found'>> {
  if (resolved === null && s.create) return fail('not_found', `ref ${s.base} not found`, { miss: { kind: 'ref', ref: s.base, candidates: [s.base] } });
  return ok(null);
}

type Attempt = { readonly head: string | null; readonly attempt: number; readonly linkTo: Span | null; readonly hintWas: HintOutcome | null };
// editFile's options without allowLfsPointer (and retry, which pushTree does not read: a cas_conflict is redone once).
export type PushTreeOptions = Omit<EditOptions, 'allowLfsPointer'>;
type TreeConfig = Omit<EditConfig, 'allowLfsPointer' | 'retry'>;
const treeDefaults = (): { -readonly [K in keyof TreeConfig]: TreeConfig[K] } => ({ head: null, strictHead: false, cache: null, verify: false, signer: null });

// oxlint-disable-next-line require-await -- async, as before: an error while starting the operation is a rejection
async function pushTreeOnce(url: string, s: TreePlan, options: PushTreeOptions, cfg: TreeConfig, { head, attempt, linkTo, hintWas }: Attempt): Promise<PushTreeResult> {
  const { verify, signer, strictHead } = cfg;
  const cache = cfg.cache === null ? new Map<string, Uint8Array>() : cfg.cache;
  const limits = limitsOf(options);
  let hint = hintWas;
  const attrs = { 'git.push_tree.ref': s.ref, 'git.push_tree.base': s.base, 'git.push_tree.create': s.create, 'git.push_tree.files': s.files, 'git.push_tree.trees': s.built.trees.size, 'git.push_tree.tree.new': s.built.root, 'git.push_tree.head.hint': head === null ? '' : head, 'git.push_tree.attempt': attempt };
  // oxlint-disable-next-line complexity, typescript/no-unsafe-type-assertion -- the push is one sequence of protocol steps; the options' tracer: EntryOptions (boundary.ts)
  return operation('push_tree', url, ({ ...options, attrs, onFinish: () => ({ 'git.push_tree.head.outcome': hint === null ? '' : hint }), link: linkTo === null ? null : { span: linkTo, kind: 'retry_of' } } as OperationOpts), async ({ t, root, outcome }) => {
    // oxlint-disable-next-line promise-function-async -- fetchObject's promise, returned as is
    const commitOf = (oid: string): Promise<Fetched> => fetchObject(t, { oid, expectType: TYPE.COMMIT, deepen: 1 });
    try {
    // 1. the parent: ls-refs, overlapped with the hinted commit. An absent base is a new ref only when base = ref.
    // oxlint-disable-next-line typescript/strict-boolean-expressions -- bundle budget: the JS's own truthy test, byte for byte (head is null or a checked oid)
    const [resolved, speculative] = await Promise.all([lsRefs(t, [s.base]).then(({ refs }: { readonly refs: ReadonlyMap<string, { readonly oid: string }> }) => getOrElse<string | null>(mapOption(mapGet(refs, s.base), r => r.oid), null)), head ? commitOf(head).then(o => o, (e: unknown) => e) : null]);
    orThrow(baseFound(s, resolved));
    const decided = decideHead({ hint: head, resolved });
    hint = hintWas === null ? decided.hint : hintWas;
    const parent = decided.oldCommit;
    orThrow(strictParent(strictHead, decided, s.base, head));
    if (speculative instanceof Error) root.set({ 'git.push_tree.head.speculative_error': thrownCodeOr(speculative, 'error') });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fulfilled speculative fetch is commitOf's value (the rejection branch is the Error above)
    const oldTree: string | null = parent === null ? null : parseCommit((decided.hint === 'used' && !(speculative instanceof Error) ? speculative as Fetched : await commitOf(parent)).data, limits).tree;
    root.set({ 'git.push_tree.commit.old': parent === null ? '' : parent, 'git.push_tree.tree.old': oldTree === null ? '' : oldTree });
    if (oldTree === s.built.root && !s.create) return outcome('noop', summarize({ s, parent, oldTree, hint, attempt }, null));

    // 2. what the server has: the parent's trees along every directory whose oid changed (cache by oid, immutable).
    // The operation's tracer, the one the root span is on: a caller's transport may carry a different one.
    const known = orThrow(await inSpan(root.tracer, 'git.push_tree.diff', { parent: root }, async span => {
      const k = await parentTrees(t, cache, s.built, oldTree, limits);
      span.set({ 'git.push_tree.diff.trees_read': k.read, 'git.push_tree.diff.cache_hits': k.hits, 'git.push_tree.diff.have': k.have.size });
      return ok(k);
    }));
    const sel = selectObjects(s.built, known);

    // 3. the commit, then one push whose old oid is the CAS
    const who = ident(s.author);
    // oxlint-disable-next-line typescript/strict-boolean-expressions, prefer-template -- bundle budget: the JS's own truthy test and concatenation, byte for byte
    let commitData = encodeCommit({ tree: s.built.root, parents: parent ? [parent] : [], author: who, committer: who, message: s.message.endsWith('\n') ? s.message : s.message + '\n' });
    if (signer !== null) { commitData = orThrow(await signCommitResult(commitData, signer)); root.set({ 'git.push_tree.commit.signed': signer.kind, 'git.push_tree.commit.signer': getOrElse(fromNullish(signer.publicKeyLine), '') }); }
    const newCommit = hashObject('commit', commitData);
    const objects = [{ type: TYPE.COMMIT, data: commitData }, ...sel.trees, ...sel.blobs];
    root.set({ 'git.push_tree.commit.new': newCommit, 'git.push_tree.send.trees': sel.trees.length, 'git.push_tree.send.tree_deltas': sel.deltas, 'git.push_tree.send.blobs': sel.blobs.length });
    const pushed = await push(t, { ref: s.ref, oldOid: s.create || parent === null ? ZERO_OID : parent, newOid: newCommit, objects });
    for (const tr of s.built.trees.values()) cache.set(tr.oid, tr.data);
    if (verify) await verifyRef(t, root, 'git.push_tree', s.ref, newCommit);
    return outcome('ok', summarize({ s, parent, oldTree, hint, attempt }, { newCommit, sel, pushed, treesRead: known.read }), { 'git.push_tree.push.bytes': pushed.packBytes, 'git.push_tree.push.objects': pushed.entries.length });
    // a thrown object gets the attempt's fields, as before, and leaves through operation(), which records it on the root
    } catch (e) { tagAttempt(e, attempt, hint); throw e; }
  });
}

// Same contract as editFile: `head` overlaps ls-refs with a speculative fetch of the hinted commit (ls-refs wins); a
// cas_conflict on attempt 0 is redone once from a fresh ls-refs, the retry's span linked to the first; `strictHead`
// makes the hint a precondition and is never retried; `verify` reads the ref back and an acknowledged push that does
// not read back is `ambiguous`. A retry rebuilds on the new head: the tree is still exactly `files` (that is the
// contract — another writer's files are not merged in), its parent is whatever won the race.
// The files are hashed once: the retry reuses the validated spec (same commit time, same trees).
// An Error carries the attempt's tag (attempt, hint, the root span). A string or a plain object does not, and it is not
// a result: resolving with it reported success for a failed first attempt.
export async function pushTree(url: string, spec: TreeSpec, options: PushTreeOptions = {}): Promise<PushTreeResult> {
  const cfg = withDefaults(options, treeDefaults());
  orThrow(needsHead(cfg.strictHead, cfg.head));
  const s = orThrow(validateTreeSpecResult(spec, limitsOf(options), cfg.head));
  try {
    return await pushTreeOnce(url, s, options, cfg, { head: cfg.head, attempt: 0, linkTo: null, hintWas: null });
  } catch (e) {
    // only a real Error is a cas_conflict that can be retried; anything else is what the caller threw, unchanged.
    // the retry is not inside this try, so a second cas_conflict propagates (attempt 0 is the only one caught)
    if (!(e instanceof Error) || !thrownCodeIs(e, 'cas_conflict') || cfg.strictHead) throw e;
    return pushTreeOnce(url, s, options, cfg, { head: null, attempt: 1, ...retryLink(e) });
  }
}
