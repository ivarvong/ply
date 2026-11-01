// One commit from an ordered list of path changes, including the first commit of an empty repository.
// editFile stays the O(1) stream for a single find/replace of an existing blob. Everything else — create, write,
// delete, rename, more than one change, a root commit — edits an in-memory tree of the paths it touches and pushes
// the commit plus the trees and blobs that edit created.
//
// Choices, where git's commands disagree: `create` of a path that exists is bad_request (git add overwrites; `write`
// is that). A result tree equal to the parent does not create an empty commit, and does not create a new ref
// (that is createRef). A 40-hex base that is not the tip of an existing target is bad_request, not a silent rebase.
// Every decision returns a Result; commitChanges throws until the 0.2.0 Result cut-over, as editFile and pushTree do,
// and inside the operation the Err meets operation()'s span at one `orThrow`.
/* oxlint-disable import/max-dependencies -- an entry composes the protocol from one import per module */
import { fail, orThrow } from './errors.js';
import type { ErrorOf, PlyError } from './errors.js';
import type { OperationOpts } from './operation.js';
import { operation, verifyRef } from './operation.js';
import { lsRefs, parseUnbornLine } from './lsrefs.js';
import { discover } from './discover.js';
import { fetchObject } from './fetch.js';
import { fetchCommit } from './commit.js';
import { push, validated, ZERO_OID } from './push.js';
import type { PackObject } from './push.js';
import { parseOid, parseCommitId } from './oid.js';
import { parseTree, encodeTree, hashObject, TYPE } from './objects.js';
import { bytesOf } from './bytes.js';
import { limitExceeded, readLimit } from './limits.js';
import type { Limits } from './limits.js';
import { validateIdent, validateRef, validatePushRef, validatePath, validateMessage } from './validate.js';
import type { IdentInput, ValidatedIdent } from './validate.js';
import { editFile, inSpan, isLfsPointerPrefix, limitsOf, refuseRebase } from './edit.js';
import type { Author } from './edit.js';
import { signCommitResult } from './sign.js';
import type { Signer } from './sign.js';
import {
  emptyDir, lazyNode, fileLeaf, putAt, removeAt, renameAt, replaceOnce, encodeMem, insertChild, blobOids, requireDir,
} from './memtree.js';
import type { BlobMode, Dir, Mem } from './memtree.js';
import { MODE_TREE } from './format.js';
import { assertNever, err, getOrElse, mapOption, none, ok, some } from './result.js';
import type { Err, Option, Result } from './result.js';
import { thrownCodeIs, thrownCodeOr } from './boundary.js';
import type { EntryOptions } from './boundary.js';
import type { Transport } from './transport.js';
import type { Span } from './otel.js';
import { buildCommitData } from './commit-build.js';
import type { Path } from './path.js';
import { parsePath } from './path.js';
import { parseRefname } from './refname.js';
import type { Refname } from './refname.js';
import type { Input } from './absent.js';
import { at, field, fromNullable, fromNullish, mapGet, withDefaults } from './absent.js';

const HEX40 = /^[0-9a-fA-F]{40}$/u;
const EMPTY_TREE = hashObject('tree', encodeTree([]));

export type { BlobMode };
// `mode` left out is a regular file (100644).
type Content = { readonly path: Path; readonly content: string | Uint8Array } & Input<{ readonly mode: BlobMode }>;
export type Change =
  | ({ readonly kind: 'create' } & Content)
  | ({ readonly kind: 'write' } & Content)
  | { readonly kind: 'edit'; readonly path: Path; readonly find: string | Uint8Array; readonly replace: string | Uint8Array }
  | { readonly kind: 'delete'; readonly path: Path }
  | { readonly kind: 'rename'; readonly from: Path; readonly to: Path };

// `ref` null: the remote's HEAD. `base` null: the target's tip. `committer` null: the author. `time` null: now.
export type CommitChangesConfig = { readonly ref: string | null; readonly base: string | null; readonly committer: Author | null; readonly time: number | null };
export type CommitChangesSpec = Input<CommitChangesConfig> & {
  readonly changes: readonly Change[];
  readonly author: Author;
  readonly message: string;
};
const specDefaults = (): { -readonly [K in keyof CommitChangesConfig]: CommitChangesConfig[K] } => ({ ref: null, base: null, committer: null, time: null });
// `head` null: no expected tip. `signer` null: the commit is not signed.
export type CommitChangesConfigOptions = { readonly head: string | null; readonly verify: boolean; readonly signer: Signer | null; readonly allowLfsPointer: boolean };
export type CommitChangesOptions = EntryOptions & Input<CommitChangesConfigOptions>;
const optionDefaults = (): { -readonly [K in keyof CommitChangesConfigOptions]: CommitChangesConfigOptions[K] } => ({ head: null, verify: false, signer: null, allowLfsPointer: false });
export type CommitChangesResult = {
  readonly outcome: 'commit' | 'noop';
  readonly ref: string;
  readonly oid: string;
  readonly tree: string;
  readonly parent: string | null;
  readonly oldOid: string | null;
  readonly pushBytes: number;
  readonly created: boolean;
};

type Stored = { readonly path: string; readonly comps: readonly string[]; readonly mode: BlobMode; readonly data: Uint8Array };
type Norm =
  | (Stored & { readonly kind: 'create' })
  | (Stored & { readonly kind: 'write' })
  | { readonly kind: 'edit'; readonly path: string; readonly comps: readonly string[]; readonly find: Uint8Array; readonly replace: Uint8Array }
  | { readonly kind: 'delete'; readonly path: string; readonly comps: readonly string[] }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string; readonly fromComps: readonly string[]; readonly toComps: readonly string[] };
type BasePlan = { readonly kind: 'tip' } | { readonly kind: 'ref'; readonly ref: string } | { readonly kind: 'oid'; readonly oid: string };
type Plan = {
  readonly ref: string | null;
  readonly base: BasePlan;
  readonly baseText: string;
  readonly changes: readonly Norm[];
  readonly author: ValidatedIdent;
  readonly committer: ValidatedIdent;
  readonly message: string;
  readonly head: string | null;
};
type Tip = { readonly ref: string; readonly oid: string | null };
type Parent = {
  readonly oid: string | null;
  readonly tree: string | null;
  readonly commitParent: string | null;
  readonly creating: boolean;
  readonly baseRef: string | null;
  readonly baseOid: string | null;
};
type Applied = { readonly tree: string; readonly objects: readonly PackObject[] };
type BadRequest = ErrorOf<'bad_request'>;

function modeOf(mode: Option<unknown>, path: string): Result<BlobMode, BadRequest> {
  if (mode.tag === 'none') return ok('100644');
  const given = mode.value;
  if (given === '100644' || given === '100755' || given === '120000') return ok(given);
  return fail('bad_request', `${path}: mode ${JSON.stringify(given)} is not 100644, 100755 or 120000`, { what: 'mode', path });
}
function bytes(raw: unknown, path: string, what: string): Result<Uint8Array, BadRequest> {
  if (typeof raw !== 'string' && !(raw instanceof Uint8Array)) return fail('bad_request', `${path}: ${what} must be a string or Uint8Array`, { what, path });
  return ok(bytesOf(raw));
}
function fields(raw: object): Record<string, unknown> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a change is an untyped object; each field is checked below
  return raw as Record<string, unknown>;
}
const pathOf = (raw: unknown, limits: Limits): Result<string[], PlyError> => validated(() => validatePath(raw, limits));
function normalize(raw: unknown, limits: Limits): Result<Norm, PlyError> {
  if (raw === null || typeof raw !== 'object') return fail('bad_request', 'change must be an object with a kind', { what: 'change' });
  const rec = fields(raw);
  const kind = rec['kind'];
  if (kind === 'create' || kind === 'write') {
    const comps = pathOf(rec['path'], limits);
    if (!comps.ok) return comps;
    const joined = comps.value.join('/');
    // a mode left out is a regular file; any other value (null included) is the caller's, and checked
    const mode = modeOf(fromNullable(rec['mode']), joined);
    if (!mode.ok) return mode;
    const data = bytes(rec['content'], joined, 'content');
    if (!data.ok) return data;
    const stored = { path: joined, comps: comps.value, mode: mode.value, data: data.value };
    if (kind === 'create') return ok({ kind, ...stored });
    return ok({ kind, ...stored });
  }
  if (kind === 'edit') {
    const comps = pathOf(rec['path'], limits);
    if (!comps.ok) return comps;
    const joined = comps.value.join('/');
    const find = bytes(rec['find'], joined, 'find');
    if (!find.ok) return find;
    if (find.value.length === 0) return fail('bad_request', 'find must be non-empty', { what: 'find', path: joined });
    const replace = bytes(rec['replace'], joined, 'replace');
    if (!replace.ok) return replace;
    return ok({ kind, path: joined, comps: comps.value, find: find.value, replace: replace.value });
  }
  if (kind === 'delete') {
    const comps = pathOf(rec['path'], limits);
    if (!comps.ok) return comps;
    return ok({ kind, path: comps.value.join('/'), comps: comps.value });
  }
  if (kind === 'rename') {
    const from = pathOf(rec['from'], limits);
    if (!from.ok) return from;
    const to = pathOf(rec['to'], limits);
    if (!to.ok) return to;
    return ok({ kind, from: from.value.join('/'), to: to.value.join('/'), fromComps: from.value, toComps: to.value });
  }
  return fail('bad_request', `unknown change kind ${JSON.stringify(kind)}`, { what: 'change', got: kind });
}
function validateBase(base: string | null): Result<BasePlan, PlyError> {
  if (base === null) return ok({ kind: 'tip' });
  if (HEX40.test(base)) {
    const id = parseCommitId(base);
    return id.ok ? ok({ kind: 'oid', oid: id.value }) : id;
  }
  const ref = validated(() => validateRef(base));
  return ref.ok ? ok({ kind: 'ref', ref: ref.value }) : ref;
}
function validateHead(head: string | null): Result<string | null, PlyError> {
  if (head === null) return ok(null);
  return parseOid(head);
}
function baseLabel(base: BasePlan): string {
  if (base.kind === 'tip') return '';
  if (base.kind === 'ref') return base.ref;
  return base.oid;
}
// One person as validateIdent takes it: the name and email as given (a missing person has none, and is refused there),
// the time, and the zone only when one is given (UTC otherwise).
function identInput(who: Option<Author>, time: number): IdentInput {
  if (who.tag === 'none') return { time };
  const { name, email } = who.value;
  const tz = fromNullish(who.value.tz);
  return tz.tag === 'some' ? { name, email, time, tz: tz.value } : { name, email, time };
}
function validatePlan(spec: CommitChangesSpec, limits: Limits, head: string | null): Result<Plan, PlyError> {
  const given = withDefaults(spec, specDefaults());
  const refIn = given.ref;
  const ref = refIn === null ? ok(null) : validated(() => validatePushRef(refIn, false));
  if (!ref.ok) return ref;
  const base = validateBase(given.base);
  if (!base.ok) return base;
  const list: unknown = spec.changes;
  if (!Array.isArray(list) || list.length === 0) return fail('bad_request', 'changes must be a non-empty list', { what: 'changes' });
  const max = readLimit(limits, 'maxPackObjects');
  if (!max.ok) return max;
  if (list.length > max.value) return err(limitExceeded('changes', list.length, max.value));
  const changes: Norm[] = [];
  for (const c of list) {
    const norm = normalize(c, limits);
    if (!norm.ok) return norm;
    changes.push(norm.value);
  }
  const author = fromNullish<Author>(spec.author);
  const authorTime = mapOption(author, a => fromNullish(a.time));
  let time = getOrElse(fromNullish(given.time), Math.floor(Date.now() / 1000));
  if (authorTime.tag === 'some' && authorTime.value.tag === 'some') time = authorTime.value.value;
  const authorIdent = validated(() => validateIdent(identInput(author, time)));
  if (!authorIdent.ok) return authorIdent;
  const committer = fromNullish(given.committer);
  const written = committer.tag === 'none'
    ? authorIdent
    : validated(() => validateIdent(identInput(committer, getOrElse(fromNullish(committer.value.time), time))));
  if (!written.ok) return written;
  const message = validated(() => validateMessage(spec.message));
  if (!message.ok) return message;
  const pinned = validateHead(head);
  if (!pinned.ok) return pinned;
  return ok({ ref: ref.value, base: base.value, baseText: baseLabel(base.value), changes, author: authorIdent.value, committer: written.value, message: spec.message, head: pinned.value });
}

// The target is not where the caller (or our own read) said: a compare-and-swap lost. `cause`: what reported it.
function lost(ref: string, expected: string, actual: string | null, ...cause: [] | [unknown]): Err<ErrorOf<'cas_conflict'>> {
  const where = actual === null ? 'absent' : actual;
  const want = expected === ZERO_OID ? 'absent' : expected;
  return fail('cas_conflict', `${ref} is ${where}, not ${want}`, { expected, actual, ...(cause.length === 0 ? {} : { cause: cause[0] }) });
}
function nothing(): Err<BadRequest> {
  return fail('bad_request', 'nothing to commit');
}
function person(p: ValidatedIdent): Author {
  return { name: p.name, email: p.email, time: p.time, tz: p.tz };
}
// A cas_conflict that says where the ref is (a string: a fresh read is not needed).
const actualKnown = (e: unknown): boolean => { const actual = field(e, 'actual'); return actual.tag === 'some' && typeof actual.value === 'string'; };
const whatIs = (e: unknown, what: string): boolean => { const w = field(e, 'what'); return w.tag === 'some' && w.value === what; };
const tipOf = (refs: ReadonlyMap<string, { readonly oid: string }>, ref: string): string | null => getOrElse<string | null>(mapOption(mapGet(refs, ref), r => r.oid), null);

async function resolveTarget(t: Transport, ref: string | null): Promise<Result<Tip, PlyError>> {
  if (ref === null) {
    const info = await discover(t);
    const listed = await lsRefs(t, ['HEAD'], info.lsRefsUnborn ? { unborn: parseUnbornLine } : {});
    const headLine = mapGet(listed.refs, 'HEAD');
    const unborn = listed.unborn;
    if (unborn !== null) {
      const target = validated(() => validatePushRef(unborn.target, false));

      return target.ok ? ok({ ref: target.value, oid: null }) : target;
    }
    if (listed.head !== null && headLine.tag === 'some') return ok({ ref: listed.head, oid: headLine.value.oid });
    if (headLine.tag === 'some') return fail('bad_request', 'remote HEAD is detached; pass ref explicitly');
    return fail('not_found', 'remote HEAD is absent; pass ref explicitly', { miss: { kind: 'head_absent' } });
  }
  const { refs } = await lsRefs(t, [ref]);
  return ok({ ref, oid: tipOf(refs, ref) });
}

async function mustCommit(t: Transport, oid: string): Promise<Result<{ readonly tree: string; readonly parent: string | null }, PlyError>> {
  const got = await fetchCommit(t, oid);
  if (!got.ok) return got;
  return ok({ tree: got.value.commit.tree, parent: getOrElse<string | null>(at(got.value.commit.parents, 0), null) });
}

async function resolveParent(t: Transport, target: Tip, base: BasePlan): Promise<Result<Parent, PlyError>> {
  if (base.kind === 'ref' && base.ref !== target.ref) {
    if (target.oid !== null) return lost(target.ref, ZERO_OID, target.oid);
    const { refs } = await lsRefs(t, [base.ref]);
    const rec = mapGet(refs, base.ref);
    if (rec.tag === 'none') return fail('not_found', `ref ${base.ref} not found`, { what: 'ref', path: base.ref, miss: { kind: 'ref', ref: base.ref, candidates: [base.ref] } });
    const oid = getOrElse(fromNullish(rec.value.peeled), rec.value.oid);
    const commit = await mustCommit(t, oid);
    if (!commit.ok) return commit;
    return ok({ oid, tree: commit.value.tree, commitParent: commit.value.parent, creating: true, baseRef: base.ref, baseOid: null });
  }
  if (base.kind === 'oid') {
    if (target.oid !== null && target.oid !== base.oid) return refuseRebase(target.ref, base.oid, target.oid);
    const commit = await mustCommit(t, base.oid);
    if (!commit.ok) return commit;
    return ok({ oid: base.oid, tree: commit.value.tree, commitParent: commit.value.parent, creating: target.oid === null, baseRef: null, baseOid: base.oid });
  }
  if (target.oid === null) return ok({ oid: null, tree: null, commitParent: null, creating: true, baseRef: null, baseOid: null });
  const commit = await mustCommit(t, target.oid);
  if (!commit.ok) return commit;
  return ok({ oid: target.oid, tree: commit.value.tree, commitParent: commit.value.parent, creating: false, baseRef: target.ref, baseOid: null });
}

type Walk = {
  readonly t: Transport;
  readonly limits: Limits;
  readonly have: Set<string>;
  readonly cache: Map<string, Dir>;
  readonly allowLfs: boolean;
};

async function loadTree(walk: Walk, oid: string): Promise<Dir> {
  const hit = mapGet(walk.cache, oid);
  if (hit.tag === 'some') return hit.value;
  const obj = await fetchObject(walk.t, { oid, filter: 'tree:0', expectType: TYPE.TREE });
  const dir = emptyDir();
  for (const entry of parseTree(obj.data, walk.limits)) {
    dir.entries.set(entry.name, lazyNode(entry.mode, entry.oid));
    walk.have.add(entry.oid);
  }
  walk.have.add(oid);
  walk.cache.set(oid, dir);
  return dir;
}

// A missing directory is fetched before the next component is named, so the walk is ordered.
async function descend(walk: Walk, root: Dir, names: readonly string[], create: boolean): Promise<Result<null, PlyError>> {
  let here = root;
  let walked = '';
  for (const name of names) {
    const full = walked === '' ? name : `${walked}/${name}`;
    const child = mapGet(here.entries, name);
    if (child.tag === 'none') {
      if (!create) return fail('not_found', `${full} not found`, { what: 'path', path: full, miss: { kind: 'path', missing: name, existingPath: walked } });
      const next = emptyDir();
      const inserted = insertChild(here.entries, name, next, walk.limits);
      if (!inserted.ok) return inserted;
      here = next;
    } else if (child.value.kind === 'dir') here = child.value;
    else if (child.value.mode === MODE_TREE) {
      // oxlint-disable-next-line no-await-in-loop -- the next component is inside this directory
      const loaded = await loadTree(walk, child.value.oid);
      here.entries.set(name, loaded);
      here = loaded;
    } else return fail('bad_request', `${full} is not a directory`, { what: 'path', path: full });
    walked = full;
  }
  return ok(null);
}

function leafAt(root: Dir, comps: readonly string[]): Result<Mem, PlyError> {
  let here: Mem = root;
  let walked = '';
  for (const name of comps) {
    const entries = requireDir(here, walked === '' ? '.' : walked);
    if (!entries.ok) return entries;
    const parent = walked;
    walked = walked === '' ? name : `${walked}/${name}`;
    const child = mapGet(entries.value, name);
    if (child.tag === 'none') return fail('not_found', `${walked} not found`, { what: 'path', path: walked, miss: { kind: 'path', missing: name, existingPath: parent } });
    here = child.value;
  }
  return ok(here);
}

// Put one new blob at its path (`write`: over a file that is there) and remember its bytes for the pack.
type NewLeaf = { readonly comps: readonly string[]; readonly mode: BlobMode; readonly data: Uint8Array; readonly path: string; readonly overwrite: boolean };
function putLeaf(walk: Walk, root: Dir, leafIn: NewLeaf, created: Map<string, Uint8Array>): Result<null, PlyError> {
  const leaf = fileLeaf(leafIn.mode, leafIn.data, walk.limits, leafIn.path);
  if (!leaf.ok) return leaf;
  const put = putAt(root, leafIn.comps, lazyNode(leaf.value.mode, leaf.value.oid), leafIn.overwrite, walk.limits);
  if (!put.ok) return put;
  created.set(leaf.value.oid, leaf.value.data);
  return ok(null);
}

// One find/replace of a file that exists: the blob fetched whole (the in-memory path), replaced, put back.
async function applyEdit(walk: Walk, root: Dir, change: Extract<Norm, { readonly kind: 'edit' }>, created: Map<string, Uint8Array>): Promise<Result<null, PlyError>> {
  const walked = await descend(walk, root, change.comps.slice(0, -1), false);
  if (!walked.ok) return walked;
  const found = leafAt(root, change.comps);
  if (!found.ok) return found;
  const node = found.value;
  const mode = node.kind === 'lazy' && (node.mode === '100644' || node.mode === '100755') ? node.mode : null;
  if (node.kind !== 'lazy' || mode === null) {
    const shown = node.kind === 'dir' ? MODE_TREE : node.mode;
    const miss = node.kind === 'lazy' && node.mode === '160000'
      ? { kind: 'submodule' as const, path: change.path, commit: node.oid }
      : { kind: 'not_directory' as const, path: change.path, mode: shown };
    return fail('not_found', `${change.path} is not a regular file (mode ${shown})`, { what: 'path', path: change.path, miss });
  }
  walk.have.add(node.oid);
  const blob = await fetchObject(walk.t, { oid: node.oid, filter: '', expectType: TYPE.BLOB });
  if (isLfsPointerPrefix(blob.data) && !walk.allowLfs) return fail('lfs_pointer', `${node.oid} is a Git LFS pointer (${blob.data.length} bytes); the file's content is in the LFS store, not in git. Pass allowLfsPointer to edit the pointer itself.`);
  const next = replaceOnce(blob.data, change.find, change.replace);
  if (!next.ok) return next;
  return putLeaf(walk, root, { comps: change.comps, mode, data: next.value, path: change.path, overwrite: true }, created);
}

// Each change walks the tree the previous change left, so the steps cannot run together.
/* oxlint-disable no-await-in-loop */
async function applyChange(walk: Walk, root: Dir, change: Norm, created: Map<string, Uint8Array>): Promise<Result<null, PlyError>> {
  switch (change.kind) {
    case 'create':
    case 'write': {
      const walked = await descend(walk, root, change.comps.slice(0, -1), true);
      if (!walked.ok) return walked;
      return putLeaf(walk, root, { comps: change.comps, mode: change.mode, data: change.data, path: change.path, overwrite: change.kind === 'write' }, created);
    }
    case 'edit': return applyEdit(walk, root, change, created);
    case 'delete': {
      const walked = await descend(walk, root, change.comps.slice(0, -1), false);
      if (!walked.ok) return walked;
      return removeAt(root, change.comps);
    }
    case 'rename': {
      const into = change.to.startsWith(`${change.from}/`);
      if (change.from !== change.to && !into) {
        const from = await descend(walk, root, change.fromComps.slice(0, -1), false);
        if (!from.ok) return from;
        const to = await descend(walk, root, change.toComps.slice(0, -1), false);
        if (!to.ok) return to;
      }
      return renameAt(root, change.fromComps, change.toComps);
    }
  }
  return assertNever(change);
}

async function apply(walk: Walk, root: Dir, changes: readonly Norm[]): Promise<Result<Applied, PlyError>> {
  const created = new Map<string, Uint8Array>();
  // change N reads the tree change N-1 wrote
  for (const change of changes) {
    const applied = await applyChange(walk, root, change, created);
    if (!applied.ok) return applied;
  }
  const encoded = encodeMem(root, walk.limits);
  if (!encoded.ok) return encoded;
  const referenced = new Set<string>();
  blobOids(root, referenced);
  const objects: PackObject[] = [];
  for (const tree of encoded.value.trees) if (!walk.have.has(tree.oid)) objects.push({ type: TYPE.TREE, data: tree.data });
  for (const [oid, data] of created) if (referenced.has(oid) && !walk.have.has(oid)) objects.push({ type: TYPE.BLOB, data });
  return ok({ tree: encoded.value.oid, objects });
}
/* oxlint-enable no-await-in-loop */

type Built = { readonly tree: string; readonly oid: string; readonly pushBytes: number; readonly outcome: 'commit' | 'noop' };
function resultOf(ref: string, parent: Parent, built: Built): CommitChangesResult {
  if (built.outcome === 'noop') {
    return { outcome: built.outcome, ref, oid: parent.oid === null ? built.oid : parent.oid, tree: parent.tree === null ? built.tree : parent.tree, parent: parent.commitParent, oldOid: parent.oid, pushBytes: 0, created: false };
  }
  return { outcome: built.outcome, ref, oid: built.oid, tree: built.tree, parent: parent.oid, oldOid: parent.creating ? null : parent.oid, pushBytes: built.pushBytes, created: parent.creating };
}

type StreamOpts = {
  readonly rest: EntryOptions;
  readonly limits: Limits;
  readonly verify: boolean;
  readonly signer: Signer | null;
  readonly allowLfs: boolean;
  readonly pinned: boolean;
};

async function readTip(t: Transport, ref: string): Promise<string | null> {
  return tipOf((await lsRefs(t, [ref])).refs, ref);
}

type StreamJob = {
  readonly plan: Plan;
  readonly target: Tip;
  readonly parent: Parent & { readonly oid: string };
  readonly edit: Extract<Norm, { readonly kind: 'edit' }>;
  readonly opts: StreamOpts;
};
function parseEditInputs(targetRef: string, editPath: string, limits: Limits): Result<{ readonly ref: Refname; readonly path: Path }, BadRequest> {
  const branded = parseRefname(targetRef);
  if (!branded.ok) return branded;
  const parsedPath = parsePath(editPath, limits);
  if (!parsedPath.ok) return parsedPath;
  return ok({ ref: branded.value, path: parsedPath.value.path });
}
// The single edit of an existing file, streamed by editFile (which throws: a public entry). What it throws is read
// here: a lost race (or a rebase refusal on a new ref) is this commit's cas_conflict; anything else passes on as thrown.
async function streamEdit(url: string, t: Transport, root: Span, job: StreamJob): Promise<Result<CommitChangesResult, PlyError>> {
  const { plan, target, parent, edit, opts } = job;
  const creating = parent.creating;
  const strict = opts.pinned && !creating && parent.baseOid === null;
  root.set({ 'git.commit.stream': true });
  const inputs = parseEditInputs(target.ref, edit.path, opts.limits);
  if (!inputs.ok) return inputs;
  const { ref, path } = inputs.value;
  try {
    const edited = await editFile(url, {
      ref, base: getOrElse(fromNullish(parent.baseOid), getOrElse(fromNullish(parent.baseRef), target.ref)), path, find: edit.find, replace: edit.replace,
      author: person(plan.author), committer: person(plan.committer), message: plan.message, time: plan.author.time,
    }, {
      ...opts.rest, transport: t, parent: root, head: parent.oid, strictHead: strict, retry: !creating && !opts.pinned,
      verify: opts.verify, allowLfsPointer: opts.allowLfs, ...(opts.signer === null ? {} : { signer: opts.signer }),
    });
    if (edited.noop) {
      if (creating) return nothing();
      return ok(resultOf(target.ref, parent, { tree: edited.oldTree, oid: edited.oldCommit, pushBytes: 0, outcome: 'noop' }));
    }
    // editFile may have retried against a tip that moved. That commit's parent is the tip it won on.
    return ok(resultOf(target.ref, { ...parent, oid: edited.oldCommit }, { tree: edited.newTree, oid: edited.newCommit, pushBytes: edited.pushBytes, outcome: 'commit' }));
  } catch (e) {
    const code = thrownCodeOr(e, null);
    const rebase = creating && code === 'bad_request' && whatIs(e, 'rebase');
    if (code !== 'cas_conflict' && !rebase) throw e;
    if (code === 'cas_conflict' && !creating && actualKnown(e)) throw e;
    return lost(target.ref, creating ? ZERO_OID : parent.oid, await readTip(t, target.ref), e);
  }
}

function treeDecision(parent: Parent, tree: string): 'noop' | 'empty' | 'commit' {
  if (parent.tree !== null && tree === parent.tree) return parent.creating ? 'empty' : 'noop';
  if (parent.oid === null && tree === EMPTY_TREE) return 'empty';
  return 'commit';
}

type MemJob = {
  readonly t: Transport;
  readonly root: Span;
  readonly plan: Plan;
  readonly target: Tip;
  readonly parent: Parent;
  readonly limits: Limits;
  readonly verify: boolean;
  readonly signer: Signer | null;
  readonly allowLfs: boolean;
  readonly pinned: boolean;
  readonly attempt: number;
};
type MemOutcome = { readonly retry: false; readonly done: CommitChangesResult; readonly objects: number } | { readonly retry: true };
function oldOidOf(parent: Parent): string {
  if (parent.creating || parent.oid === null) return ZERO_OID;
  return parent.oid;
}
async function writeMem(job: MemJob): Promise<Result<MemOutcome, PlyError>> {
  const { t, root, plan, target, parent, limits, verify, signer, allowLfs, pinned, attempt } = job;
  root.set({ 'git.commit.stream': false });
  const walk: Walk = { t, limits, have: new Set(), cache: new Map(), allowLfs };
  const mem = parent.tree === null ? emptyDir() : await loadTree(walk, parent.tree);
  const applied = await inSpan(root.tracer, 'git.commit.apply', { parent: root, attrs: { 'git.commit.applied': plan.changes.length } }, async () => { const r = await apply(walk, mem, plan.changes); return r; });

  if (!applied.ok) return applied;
  const decision = treeDecision(parent, applied.value.tree);
  if (decision === 'empty') return nothing();
  if (decision === 'noop') return ok({ retry: false, objects: 0, done: resultOf(target.ref, parent, { tree: applied.value.tree, oid: parent.oid === null ? applied.value.tree : parent.oid, pushBytes: 0, outcome: 'noop' }) });
  const message = plan.message.endsWith('\n') ? plan.message : `${plan.message}\n`;
  const parents = parent.oid === null ? [] : [parent.oid];
  let built = buildCommitData({ tree: applied.value.tree, parents, author: plan.author, committer: plan.committer, time: plan.author.time, message });
  if (signer !== null) {
    const signed = await signCommitResult(built.data, signer);
    if (!signed.ok) return signed;
    built = { data: signed.value, oid: hashObject('commit', signed.value) };
  }
  const commitData = built.data;
  const oid = built.oid;
  const objects: PackObject[] = [{ type: TYPE.COMMIT, data: commitData }, ...applied.value.objects];
  const oldOid = oldOidOf(parent);
  const branded = parseRefname(target.ref);
  if (!branded.ok) return branded;
  try {
    const pushed = await push(t, { ref: branded.value, oldOid, newOid: oid, objects });
    if (verify) await verifyRef(t, root, 'git.commit', target.ref, oid);
    return ok({ retry: false, objects: objects.length, done: resultOf(target.ref, parent, { tree: applied.value.tree, oid, pushBytes: pushed.packBytes, outcome: 'commit' }) });
  } catch (e) {
    // the push (or its read-back) throws: a lost race is redone once, or reported against a fresh read; the rest passes on
    if (!thrownCodeIs(e, 'cas_conflict')) throw e;
    if (attempt === 0 && !pinned && !parent.creating) return ok({ retry: true });
    return lost(target.ref, oldOid, await readTip(t, target.ref), e);
  }
}
type StreamTry = { readonly plan: Plan; readonly target: Tip; readonly parent: Parent; readonly opts: StreamOpts };
// One edit of a file that exists on a parent that exists: streamed (Some). Anything else is the in-memory tree (None).
async function streamIfEdit(url: string, t: Transport, root: Span, job: StreamTry): Promise<Result<Option<CommitChangesResult>, PlyError>> {
  const { plan, target, parent, opts } = job;
  const only = at(plan.changes, 0);
  if (plan.changes.length !== 1 || only.tag === 'none' || only.value.kind !== 'edit' || parent.oid === null) return ok(none);
  const edited = await streamEdit(url, t, root, { plan, target, parent: { ...parent, oid: parent.oid }, edit: only.value, opts });
  return edited.ok ? ok(some(edited.value)) : edited;
}

export async function commitChanges(url: string, spec: CommitChangesSpec, options: CommitChangesOptions = {}): Promise<CommitChangesResult> {
  const { head, verify, signer, allowLfsPointer } = withDefaults(options, optionDefaults());
  const limits = limitsOf(options);
  const plan = orThrow(validatePlan(spec, limits, head));
  const pinned = plan.head !== null;
  const attrs = {
    'git.commit.ref': plan.ref === null ? '' : plan.ref, 'git.commit.base': plan.baseText, 'git.commit.changes': plan.changes.length,
    'git.commit.ops': plan.changes.map(c => c.kind), 'git.commit.head': plan.head === null ? '' : plan.head, 'git.commit.stream': false,
    'git.commit.creating': false, 'git.commit.attempt': 0,
  };
  const opts: StreamOpts = { rest: options, limits, verify, signer, allowLfs: allowLfsPointer, pinned };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tracer is optional on EntryOptions and required by operation(), as editFile
  const out = await operation('commit', url, { ...options, limits, attrs } as OperationOpts, async ({ t, root, outcome }) => {
    const finish = (done: CommitChangesResult, objects: number): CommitChangesResult => outcome(done.outcome, done, {
      'git.commit.tree': done.tree, 'git.commit.oid': done.oid, 'git.commit.push.bytes': done.pushBytes, ...(objects > 0 ? { 'git.commit.objects': objects } : {}),
    });
    const run = async (attempt: number): Promise<Result<CommitChangesResult, PlyError>> => {
      root.set({ 'git.commit.attempt': attempt });
      const target = await resolveTarget(t, plan.ref);
      if (!target.ok) return target;
      const tip = target.value;
      root.set({ 'git.commit.ref': tip.ref });
      if (plan.head !== null && (tip.oid === null ? ZERO_OID : tip.oid) !== plan.head) return lost(tip.ref, plan.head, tip.oid);
      const parent = await resolveParent(t, tip, plan.base);
      if (!parent.ok) return parent;
      root.set({ 'git.commit.creating': parent.value.creating, 'git.commit.parent': parent.value.oid === null ? '' : parent.value.oid });
      const streamed = await streamIfEdit(url, t, root, { plan, target: tip, parent: parent.value, opts });
      if (!streamed.ok) return streamed;
      if (streamed.value.tag === 'some') return ok(finish(streamed.value.value, 0));
      const wrote = await writeMem({ t, root, plan, target: tip, parent: parent.value, limits, verify, signer, allowLfs: allowLfsPointer, pinned, attempt });
      if (!wrote.ok) return wrote;
      if (wrote.value.retry) return run(1);
      return ok(finish(wrote.value.done, wrote.value.objects));
    };
    return orThrow(await run(0));
  });
  return out;
}
