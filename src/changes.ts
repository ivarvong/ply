// One commit from an ordered list of path changes, including the first commit of an empty repository.
// editFile stays the O(1) stream for a single find/replace of an existing blob. Everything else — create, write,
// delete, rename, more than one change, a root commit — edits an in-memory tree of the paths it touches and pushes
// the commit plus the trees and blobs that edit created.
//
// Choices, where git's commands disagree: `create` of a path that exists is bad_request (git add overwrites; `write`
// is that). A result tree equal to the parent does not create an empty commit, and does not create a new ref
// (that is createRef). A 40-hex base that is not the tip of an existing target is bad_request, not a silent rebase.
// Public functions throw until the 0.2.0 Result cut-over, as editFile and pushTree do.
/* oxlint-disable import/max-dependencies -- an entry composes the protocol from one import per module */
import { thrown as fail } from './errors.js';
import type { OperationOpts } from './operation.js';
import { operation, verifyRef } from './operation.js';
import { lsRefs, parseUnbornLine } from './lsrefs.js';
import { discover } from './discover.js';
import { fetchObject } from './fetch.js';
import { fetchCommit } from './commit.js';
import { push, ZERO_OID } from './push.js';
import type { PackObject } from './push.js';
import { parseOid, parseCommitId } from './oid.js';
import { parseTree, encodeTree, encodeCommit, hashObject, ident, TYPE } from './objects.js';
import { bytesOf } from './bytes.js';
import { DEFAULT_LIMITS, limitError, requireLimit } from './limits.js';
import type { Limits } from './limits.js';
import { validateIdent, validateRef, validatePushRef, validatePath, validateMessage } from './validate.js';
import type { ValidatedIdent } from './validate.js';
import { editFile, isLfsPointerPrefix, refuseRebase } from './edit.js';
import type { Author } from './edit.js';
import { signCommit } from './sign.js';
import type { Signer } from './sign.js';
import {
  emptyDir, lazyNode, fileLeaf, putAt, removeAt, renameAt, replaceOnce, encodeMem, insertChild, blobOids, requireDir,
} from './memtree.js';
import type { BlobMode, Dir, Mem } from './memtree.js';
import { MODE_TREE } from './format.js';
import { assertNever } from './result.js';
import { thrownCode } from './boundary.js';
import type { EntryOptions } from './boundary.js';
import type { Transport } from './transport.js';
import type { Span } from './otel.js';

const HEX40 = /^[0-9a-fA-F]{40}$/u;
const EMPTY_TREE = hashObject('tree', encodeTree([]));

export type { BlobMode };
export type Change =
  | { readonly kind: 'create'; readonly path: string; readonly content: string | Uint8Array; readonly mode?: BlobMode }
  | { readonly kind: 'write'; readonly path: string; readonly content: string | Uint8Array; readonly mode?: BlobMode }
  | { readonly kind: 'edit'; readonly path: string; readonly find: string | Uint8Array; readonly replace: string | Uint8Array }
  | { readonly kind: 'delete'; readonly path: string }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string };

export type CommitChangesSpec = {
  readonly ref?: string | null;
  readonly base?: string | null;
  readonly changes: readonly Change[];
  readonly author: Author;
  readonly committer?: Author | null;
  readonly message: string;
  readonly time?: number;
};
export type CommitChangesOptions = EntryOptions & {
  readonly head?: string | null;
  readonly verify?: boolean;
  readonly signer?: Signer | null;
  readonly allowLfsPointer?: boolean;
};
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

function modeOf(mode: unknown, path: string): BlobMode {
  if (mode === undefined) return '100644';
  if (mode === '100644' || mode === '100755' || mode === '120000') return mode;
  throw fail('bad_request', `${path}: mode ${JSON.stringify(mode)} is not 100644, 100755 or 120000`, { what: 'mode', path });
}
function bytes(raw: unknown, path: string, what: string): Uint8Array {
  if (typeof raw !== 'string' && !(raw instanceof Uint8Array)) throw fail('bad_request', `${path}: ${what} must be a string or Uint8Array`, { what, path });
  return bytesOf(raw);
}
function fields(raw: object): Record<string, unknown> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a change is an untyped object; each field is checked below
  return raw as Record<string, unknown>;
}
function normalize(raw: unknown, limits: Limits): Norm {
  if (raw === null || typeof raw !== 'object') throw fail('bad_request', 'change must be an object with a kind', { what: 'change' });
  const rec = fields(raw);
  const kind = rec['kind'];
  if (kind === 'create' || kind === 'write') {
    const comps = validatePath(rec['path'], limits);
    const joined = comps.join('/');
    const stored = { path: joined, comps, mode: modeOf(rec['mode'], joined), data: bytes(rec['content'], joined, 'content') };
    if (kind === 'create') return { kind, ...stored };
    return { kind, ...stored };
  }
  if (kind === 'edit') {
    const comps = validatePath(rec['path'], limits);
    const joined = comps.join('/');
    const find = bytes(rec['find'], joined, 'find');
    if (find.length === 0) throw fail('bad_request', 'find must be non-empty', { what: 'find', path: joined });
    return { kind, path: joined, comps, find, replace: bytes(rec['replace'], joined, 'replace') };
  }
  if (kind === 'delete') {
    const comps = validatePath(rec['path'], limits);
    return { kind, path: comps.join('/'), comps };
  }
  if (kind === 'rename') {
    const from = validatePath(rec['from'], limits);
    const to = validatePath(rec['to'], limits);
    return { kind, from: from.join('/'), to: to.join('/'), fromComps: from, toComps: to };
  }
  throw fail('bad_request', `unknown change kind ${JSON.stringify(kind)}`, { what: 'change', got: kind });
}
function validateBase(base: string | null | undefined): BasePlan {
  if (base === undefined || base === null) return { kind: 'tip' };
  if (HEX40.test(base)) {
    const id = parseCommitId(base);
    if (!id.ok) throw id.error;
    return { kind: 'oid', oid: id.value };
  }
  return { kind: 'ref', ref: validateRef(base) };
}
function validateHead(head: string | null): string | null {
  if (head === null) return null;
  const id = parseOid(head);
  if (!id.ok) throw id.error;
  return id.value;
}
function baseLabel(base: BasePlan): string {
  if (base.kind === 'tip') return '';
  if (base.kind === 'ref') return base.ref;
  return base.oid;
}
function validatePlan(spec: CommitChangesSpec, limits: Limits, head: string | null): Plan {
  const ref = spec.ref === undefined || spec.ref === null ? null : validatePushRef(spec.ref, false);
  const base = validateBase(spec.base);
  const list: unknown = spec.changes;
  if (!Array.isArray(list) || list.length === 0) throw fail('bad_request', 'changes must be a non-empty list', { what: 'changes' });
  const max = requireLimit(limits, 'maxPackObjects');
  if (list.length > max) throw limitError('changes', list.length, max);
  const changes = list.map(c => normalize(c, limits));
  const time = spec.author?.time ?? spec.time ?? Math.floor(Date.now() / 1000);
  const author = validateIdent({ name: spec.author?.name, email: spec.author?.email, time, tz: spec.author?.tz });
  const committer = spec.committer === undefined || spec.committer === null ? author : validateIdent({ name: spec.committer.name, email: spec.committer.email, time: spec.committer.time ?? time, tz: spec.committer.tz });
  validateMessage(spec.message);
  return { ref, base, baseText: baseLabel(base), changes, author, committer, message: spec.message, head: validateHead(head) };
}

function lost(ref: string, expected: string, actual: string | null, cause?: unknown): never {
  const where = actual ?? 'absent';
  const want = expected === ZERO_OID ? 'absent' : expected;
  throw fail('cas_conflict', `${ref} is ${where}, not ${want}`, { expected, actual, ...(cause === undefined ? {} : { cause }) });
}
function nothing(): never {
  throw fail('bad_request', 'nothing to commit');
}
function person(p: ValidatedIdent): Author {
  return { name: p.name, email: p.email, time: p.time, tz: p.tz };
}
function fieldOf(e: unknown, key: string): unknown {
  if (typeof e !== 'object' || e === null || !(key in e)) return undefined;
  return fields(e)[key];
}
function actualOf(e: unknown): string | null | undefined {
  const actual = fieldOf(e, 'actual');
  if (actual === null || typeof actual === 'string') return actual;
  return undefined;
}

async function resolveTarget(t: Transport, ref: string | null): Promise<Tip> {
  if (ref === null) {
    const info = await discover(t);
    const listed = await lsRefs(t, ['HEAD'], info.lsRefsUnborn ? { unborn: parseUnbornLine } : {});
    const headLine = listed.refs.get('HEAD');
    if (listed.unborn) return { ref: validatePushRef(listed.unborn.target, false), oid: null };
    if (listed.head !== null && headLine) return { ref: listed.head, oid: headLine.oid };
    if (headLine) throw fail('bad_request', 'remote HEAD is detached; pass ref explicitly');
    throw fail('not_found', 'remote HEAD is absent; pass ref explicitly');
  }
  const { refs } = await lsRefs(t, [ref]);
  return { ref, oid: refs.get(ref)?.oid ?? null };
}

async function mustCommit(t: Transport, oid: string): Promise<{ readonly tree: string; readonly parent: string | null }> {
  const got = await fetchCommit(t, oid);
  if (!got.ok) throw got.error;
  return { tree: got.value.commit.tree, parent: got.value.commit.parents[0] ?? null };
}

async function resolveParent(t: Transport, target: Tip, base: BasePlan): Promise<Parent> {
  if (base.kind === 'ref' && base.ref !== target.ref) {
    if (target.oid !== null) lost(target.ref, ZERO_OID, target.oid);
    const { refs } = await lsRefs(t, [base.ref]);
    const rec = refs.get(base.ref);
    if (!rec) throw fail('not_found', `ref ${base.ref} not found`, { what: 'ref', path: base.ref });
    const commit = await mustCommit(t, rec.peeled ?? rec.oid);
    return { oid: rec.peeled ?? rec.oid, tree: commit.tree, commitParent: commit.parent, creating: true, baseRef: base.ref, baseOid: null };
  }
  if (base.kind === 'oid') {
    if (target.oid !== null && target.oid !== base.oid) refuseRebase(target.ref, base.oid, target.oid);
    const commit = await mustCommit(t, base.oid);
    return { oid: base.oid, tree: commit.tree, commitParent: commit.parent, creating: target.oid === null, baseRef: null, baseOid: base.oid };
  }
  if (target.oid === null) return { oid: null, tree: null, commitParent: null, creating: true, baseRef: null, baseOid: null };
  const commit = await mustCommit(t, target.oid);
  return { oid: target.oid, tree: commit.tree, commitParent: commit.parent, creating: false, baseRef: target.ref, baseOid: null };
}

type Walk = {
  readonly t: Transport;
  readonly limits: Limits;
  readonly have: Set<string>;
  readonly cache: Map<string, Dir>;
  readonly allowLfs: boolean;
};

async function loadTree(walk: Walk, oid: string): Promise<Dir> {
  const hit = walk.cache.get(oid);
  if (hit) return hit;
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
async function descend(walk: Walk, root: Dir, names: readonly string[], create: boolean): Promise<void> {
  let here = root;
  let walked = '';
  for (const name of names) {
    const full = walked === '' ? name : `${walked}/${name}`;
    const child = here.entries.get(name);
    if (child === undefined) {
      if (!create) throw fail('not_found', `${full} not found`, { what: 'path', path: full });
      const next = emptyDir();
      insertChild(here.entries, name, next, walk.limits);
      here = next;
    } else if (child.kind === 'dir') here = child;
    else if (child.mode === MODE_TREE) {
      // oxlint-disable-next-line no-await-in-loop -- the next component is inside this directory
      const loaded = await loadTree(walk, child.oid);
      here.entries.set(name, loaded);
      here = loaded;
    } else throw fail('bad_request', `${full} is not a directory`, { what: 'path', path: full });
    walked = full;
  }
}

function leafAt(root: Dir, comps: readonly string[]): Mem {
  let here: Mem = root;
  let walked = '';
  for (const name of comps) {
    const entries = requireDir(here, walked === '' ? '.' : walked);
    walked = walked === '' ? name : `${walked}/${name}`;
    const child = entries.get(name);
    if (child === undefined) throw fail('not_found', `${walked} not found`, { what: 'path', path: walked });
    here = child;
  }
  return here;
}

// Each change walks the tree the previous change left, so the steps cannot run together.
/* oxlint-disable no-await-in-loop */
async function applyChange(walk: Walk, root: Dir, change: Norm, created: Map<string, Uint8Array>): Promise<void> {
  if (change.kind === 'create' || change.kind === 'write') {
    await descend(walk, root, change.comps.slice(0, -1), true);
    const leaf = fileLeaf(change.mode, change.data, walk.limits, change.path);
    putAt(root, change.comps, lazyNode(leaf.mode, leaf.oid), change.kind === 'write', walk.limits);
    created.set(leaf.oid, leaf.data);
    return;
  }
  if (change.kind === 'edit') {
    await descend(walk, root, change.comps.slice(0, -1), false);
    const node = leafAt(root, change.comps);
    const mode = node.kind === 'lazy' && (node.mode === '100644' || node.mode === '100755') ? node.mode : null;
    if (node.kind !== 'lazy' || mode === null) {
      const shown = node.kind === 'dir' ? MODE_TREE : node.mode;
      throw fail('not_found', `${change.path} is not a regular file (mode ${shown})`, { what: 'path', path: change.path });
    }
    walk.have.add(node.oid);
    const blob = await fetchObject(walk.t, { oid: node.oid, filter: '', expectType: TYPE.BLOB });
    if (isLfsPointerPrefix(blob.data) && !walk.allowLfs) throw fail('lfs_pointer', `${node.oid} is a Git LFS pointer (${blob.data.length} bytes); the file's content is in the LFS store, not in git. Pass allowLfsPointer to edit the pointer itself.`);
    const next = replaceOnce(blob.data, change.find, change.replace);
    const leaf = fileLeaf(mode, next, walk.limits, change.path);
    putAt(root, change.comps, lazyNode(leaf.mode, leaf.oid), true, walk.limits);
    created.set(leaf.oid, leaf.data);
    return;
  }
  if (change.kind === 'delete') {
    await descend(walk, root, change.comps.slice(0, -1), false);
    removeAt(root, change.comps);
    return;
  }
  if (change.kind === 'rename') {
    const into = change.to.startsWith(`${change.from}/`);
    if (change.from !== change.to && !into) {
      await descend(walk, root, change.fromComps.slice(0, -1), false);
      await descend(walk, root, change.toComps.slice(0, -1), false);
    }
    renameAt(root, change.fromComps, change.toComps);
    return;
  }
  assertNever(change);
}
/* oxlint-enable no-await-in-loop */

async function apply(walk: Walk, root: Dir, changes: readonly Norm[]): Promise<Applied> {
  const created = new Map<string, Uint8Array>();
  // oxlint-disable-next-line no-await-in-loop -- change N reads the tree change N-1 wrote
  for (const change of changes) await applyChange(walk, root, change, created);
  const encoded = encodeMem(root, walk.limits);
  const referenced = new Set<string>();
  blobOids(root, referenced);
  const objects: PackObject[] = [];
  for (const tree of encoded.trees) if (!walk.have.has(tree.oid)) objects.push({ type: TYPE.TREE, data: tree.data });
  for (const [oid, data] of created) if (referenced.has(oid) && !walk.have.has(oid)) objects.push({ type: TYPE.BLOB, data });
  return { tree: encoded.oid, objects };
}

type Built = { readonly tree: string; readonly oid: string; readonly pushBytes: number; readonly outcome: 'commit' | 'noop' };
function resultOf(ref: string, parent: Parent, built: Built): CommitChangesResult {
  if (built.outcome === 'noop') {
    return { outcome: built.outcome, ref, oid: parent.oid ?? built.oid, tree: parent.tree ?? built.tree, parent: parent.commitParent, oldOid: parent.oid, pushBytes: 0, created: false };
  }
  return { outcome: built.outcome, ref, oid: built.oid, tree: built.tree, parent: parent.oid, oldOid: parent.creating ? null : parent.oid, pushBytes: built.pushBytes, created: parent.creating };
}

type StreamOpts = {
  readonly rest: EntryOptions;
  readonly verify: boolean;
  readonly signer: Signer | null;
  readonly allowLfs: boolean;
  readonly pinned: boolean;
};

async function readTip(t: Transport, ref: string): Promise<string | null> {
  return (await lsRefs(t, [ref])).refs.get(ref)?.oid ?? null;
}

type StreamJob = {
  readonly plan: Plan;
  readonly target: Tip;
  readonly parent: Parent & { readonly oid: string };
  readonly edit: Extract<Norm, { readonly kind: 'edit' }>;
  readonly opts: StreamOpts;
};
async function streamEdit(url: string, t: Transport, root: Span, job: StreamJob): Promise<CommitChangesResult> {
  const { plan, target, parent, edit, opts } = job;
  const creating = parent.creating;
  const strict = opts.pinned && !creating && parent.baseOid === null;
  root.set({ 'git.commit.stream': true });
  try {
    const edited = await editFile(url, {
      ref: target.ref, base: parent.baseOid ?? parent.baseRef ?? target.ref, path: edit.path, find: edit.find, replace: edit.replace,
      author: person(plan.author), committer: person(plan.committer), message: plan.message, time: plan.author.time,
    }, {
      ...opts.rest, transport: t, parent: root, head: parent.oid, strictHead: strict, retry: !creating && !opts.pinned,
      verify: opts.verify, allowLfsPointer: opts.allowLfs, ...(opts.signer ? { signer: opts.signer } : {}),
    });
    if (edited.noop) {
      if (creating) nothing();
      return resultOf(target.ref, parent, { tree: edited.oldTree, oid: edited.oldCommit, pushBytes: 0, outcome: 'noop' });
    }
    // editFile may have retried against a tip that moved. That commit's parent is the tip it won on.
    return resultOf(target.ref, { ...parent, oid: edited.oldCommit }, { tree: edited.newTree, oid: edited.newCommit, pushBytes: edited.pushBytes, outcome: 'commit' });
  } catch (e) {
    const code = thrownCode(e);
    const rebase = creating && code === 'bad_request' && fieldOf(e, 'what') === 'rebase';
    if (code !== 'cas_conflict' && !rebase) throw e;
    const known = actualOf(e);
    if (code === 'cas_conflict' && !creating && known !== null && known !== undefined) throw e;
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
async function writeMem(job: MemJob): Promise<MemOutcome> {
  const { t, root, plan, target, parent, limits, verify, signer, allowLfs, pinned, attempt } = job;
  root.set({ 'git.commit.stream': false });
  const walk: Walk = { t, limits, have: new Set(), cache: new Map(), allowLfs };
  const mem = parent.tree === null ? emptyDir() : await loadTree(walk, parent.tree);
  const applied = await root.tracer.span('git.commit.apply', { parent: root, attrs: { 'git.commit.applied': plan.changes.length } }, async () => {
    const built = await apply(walk, mem, plan.changes);
    return built;
  });
  const decision = treeDecision(parent, applied.tree);
  if (decision === 'empty') nothing();
  if (decision === 'noop') return { retry: false, objects: 0, done: resultOf(target.ref, parent, { tree: applied.tree, oid: parent.oid ?? applied.tree, pushBytes: 0, outcome: 'noop' }) };
  const message = plan.message.endsWith('\n') ? plan.message : `${plan.message}\n`;
  const parents = parent.oid === null ? [] : [parent.oid];
  let commitData = encodeCommit({ tree: applied.tree, parents, author: ident(plan.author), committer: ident(plan.committer), message });
  if (signer) commitData = await signCommit(commitData, signer);
  const oid = hashObject('commit', commitData);
  const objects: PackObject[] = [{ type: TYPE.COMMIT, data: commitData }, ...applied.objects];
  const oldOid = oldOidOf(parent);
  try {
    const pushed = await push(t, { ref: target.ref, oldOid, newOid: oid, objects });
    if (verify) await verifyRef(t, root, 'git.commit', target.ref, oid);
    return { retry: false, objects: objects.length, done: resultOf(target.ref, parent, { tree: applied.tree, oid, pushBytes: pushed.packBytes, outcome: 'commit' }) };
  } catch (e) {
    if (thrownCode(e) !== 'cas_conflict') throw e;
    if (attempt === 0 && !pinned && !parent.creating) return { retry: true };
    return lost(target.ref, oldOid, await readTip(t, target.ref), e);
  }
}
type StreamTry = { readonly plan: Plan; readonly target: Tip; readonly parent: Parent; readonly opts: StreamOpts };
async function streamIfEdit(url: string, t: Transport, root: Span, job: StreamTry): Promise<CommitChangesResult | null> {
  const { plan, target, parent, opts } = job;
  const [only, more] = plan.changes;
  if (more !== undefined || only?.kind !== 'edit' || parent.oid === null) return null;
  const edited = await streamEdit(url, t, root, { plan, target, parent: { ...parent, oid: parent.oid }, edit: only, opts });
  return edited;
}

export async function commitChanges(url: string, spec: CommitChangesSpec, { head = null, verify = false, signer = null, allowLfsPointer = false, ...rest }: CommitChangesOptions = {}): Promise<CommitChangesResult> {
  const limits = rest.limits ?? DEFAULT_LIMITS;
  const plan = validatePlan(spec, limits, head);
  const pinned = plan.head !== null;
  const attrs = {
    'git.commit.ref': plan.ref ?? '', 'git.commit.base': plan.baseText, 'git.commit.changes': plan.changes.length,
    'git.commit.ops': plan.changes.map(c => c.kind), 'git.commit.head': plan.head ?? '', 'git.commit.stream': false,
    'git.commit.creating': false, 'git.commit.attempt': 0,
  };
  const opts: StreamOpts = { rest, verify, signer, allowLfs: allowLfsPointer, pinned };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- tracer is optional on EntryOptions and required by operation(), as editFile
  const out = await operation('commit', url, { ...rest, limits, attrs } as OperationOpts, async ({ t, root, outcome }) => {
    const finish = (done: CommitChangesResult, objects: number): CommitChangesResult => outcome(done.outcome, done, {
      'git.commit.tree': done.tree, 'git.commit.oid': done.oid, 'git.commit.push.bytes': done.pushBytes, ...(objects > 0 ? { 'git.commit.objects': objects } : {}),
    });
    const run = async (attempt: number): Promise<CommitChangesResult> => {
      root.set({ 'git.commit.attempt': attempt });
      const target = await resolveTarget(t, plan.ref);
      root.set({ 'git.commit.ref': target.ref });
      if (plan.head !== null && (target.oid ?? ZERO_OID) !== plan.head) return lost(target.ref, plan.head, target.oid);
      const parent = await resolveParent(t, target, plan.base);
      root.set({ 'git.commit.creating': parent.creating, 'git.commit.parent': parent.oid ?? '' });
      const streamed = await streamIfEdit(url, t, root, { plan, target, parent, opts });
      if (streamed) return finish(streamed, 0);
      const wrote = await writeMem({ t, root, plan, target, parent, limits, verify, signer, allowLfs: allowLfsPointer, pinned, attempt });
      if (wrote.retry) return run(1);
      return finish(wrote.done, wrote.objects);
    };
    const done = await run(0);
    return done;
  });
  return out;
}
