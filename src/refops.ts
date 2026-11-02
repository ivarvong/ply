// Ref management by URL: create a branch at a commit, delete a branch, create a tag. Each is one operation (a
// `git.<op>` root span, a transport built for the url) and one receive-pack command with no new objects, except an
// annotated tag, whose one tag object is the pack.
//
//   createBranch(url, { ref, from }, opts)                   → { ref, oid, pushBytes }
//   deleteBranch(url, { ref, expected? }, opts)               → { ref, oid }            oid: the tip it had
//   createTag(url, { name, target, message?, tagger? }, opts) → { ref, oid, commit, annotated, pushBytes }
//   deleteTag(url, { name, expected? }, opts)                 → { ref, oid }            deleteBranch on refs/tags/<name>
//   listRefs(url, { prefixes? }, opts)                        → { head, refs: [{ name, oid, peeled }] }
//
// A ref that already exists is `cas_conflict` with `expected` the zero id and `actual` its tip, as a create in
// editFile and commitChanges reports it (the zero old id is the compare-and-swap "must not exist"), whether ply saw it
// in ls-refs or receive-pack refused the create. A delete compares against `expected` when given, else the tip ls-refs
// reported; a stale one is `cas_conflict` with `actual` the tip. What the server itself refuses (deleting the branch
// HEAD names, a hook) is its own error, unchanged: `push_rejected` with git's reason.
/* oxlint-disable require-await -- the entry points are async: a refused argument is an Err in a promise, like every other answer (read.ts) */
/* oxlint-disable import/max-dependencies -- an operation over ls-refs, resolve, push and the tag codec: each module is one step */
import type { PlyError } from './errors.js';
import type { Result } from './result.js';
import type { ReadOptions } from './read.js';
import type { Input } from './absent.js';
import type { OperationOpts } from './operation.js';
import { fail } from './errors.js';
import { ok } from './result.js';
import { withDefaults } from './absent.js';
import { lsRefs } from './lsrefs.js';
import { push, ZERO_OID } from './push.js';
import { operation, verifyRef } from './operation.js';
import { encodeTag, hashObject, ident, TYPE } from './objects.js';
import { validatePushRef, validateMessage } from './validate.js';
import { resolveCommit } from './read.js';
import { refOid, type Author, type OpContext, type PushObject } from './merge.js';
import { assertCommit, isOid, stamp } from './mergeio.js';

// What every ref operation takes besides the url and the spec: the entry options (auth, tracer, limits, …) and
// `verify` (read the ref back after the push; an acknowledged push that does not read back is `ambiguous`).
export type RefOpOptions = ReadOptions & Input<{ readonly verify: boolean }>;

// The entry options as operation() takes them, with the operation's attributes.
const opOpts = (options: RefOpOptions, attrs: Readonly<Record<string, unknown>>): OperationOpts => ({ ...options, attrs });

// A ref the remote already has: the create's compare-and-swap (old id zero) cannot hold.
const exists = (ref: string, tip: string): Result<never, PlyError> =>
  fail('cas_conflict', `${ref} already exists at ${tip}`, { what: 'ref', expected: ZERO_OID, actual: tip });

// Effect: the commit `from` names. A 40-hex id must be a commit the server has (fetched alone); a name is resolved as
// readCommit resolves one (full ref, short name, HEAD; an annotated tag is peeled to its commit).
async function commitOf(t: OpContext['t'], from: string, what: string): Promise<Result<string, PlyError>> {
  if (isOid(from)) {
    if (from === ZERO_OID) return fail('bad_request', `${what} must not be the zero oid`, { what });
    const c = await assertCommit(t, from, what);
    return c.ok ? ok(from) : c;
  }
  const r = await resolveCommit(t, from);
  return r.ok ? ok(r.value.commit) : r;
}

// Effect: the create push (old id zero, nothing but `objects`). A refused create re-reads the ref: present, it is the
// ref that already existed (cas_conflict naming its tip); absent, the server's own refusal stands.
type Create = { readonly prefix: string; readonly ref: string; readonly newOid: string; readonly objects: readonly PushObject[]; readonly verify: boolean };
async function createRef({ t, root }: Pick<OpContext, 't' | 'root'>, { prefix, ref, newOid, objects, verify }: Create): Promise<Result<number, PlyError>> {
  const pushed = await push(t, { ref, oldOid: ZERO_OID, newOid, objects });
  if (!pushed.ok) {
    if (pushed.error.code !== 'cas_conflict') return pushed;
    const now = await lsRefs(t, [ref]);
    if (!now.ok) return now;
    const tip = refOid(now.value.refs, ref);
    return tip.tag === 'some' ? exists(ref, tip.value) : pushed;
  }
  if (verify) { const seen = await verifyRef(t, root, prefix, ref, newOid); if (!seen.ok) return seen; }
  return ok(pushed.value.packBytes);
}

export type CreateBranchSpec = { readonly ref: string; readonly from: string };
export type CreateBranchResult = { readonly ref: string; readonly oid: string; readonly pushBytes: number };
// A new branch at a commit: `from` is a ref name (full or short, as readCommit takes it) or a 40-hex commit id.
export async function createBranch(url: string, spec: CreateBranchSpec, options: RefOpOptions = {}): Promise<Result<CreateBranchResult, PlyError>> {
  const { ref, from } = spec;
  const { verify } = withDefaults(options, { verify: false });
  const named = validatePushRef(ref, false); if (!named.ok) return named;
  if (typeof from !== 'string' || from === '') return fail('bad_request', 'from must be a ref name or a commit id', { what: 'from' });
  return operation('branch_create', url, opOpts(options, { 'git.branch_create.ref': ref, 'git.branch_create.from': from }), async ({ t, root, outcome }: OpContext): Promise<Result<CreateBranchResult, PlyError>> => {
    const listed = await lsRefs(t, [ref]); if (!listed.ok) return listed;
    const present = refOid(listed.value.refs, ref);
    if (present.tag === 'some') return exists(ref, present.value);
    const commit = await commitOf(t, from, 'from'); if (!commit.ok) return commit;
    root.set({ 'git.branch_create.oid': commit.value });
    const pushed = await createRef({ t, root }, { prefix: 'git.branch_create', ref, newOid: commit.value, objects: [], verify });
    if (!pushed.ok) return pushed;
    return outcome('created', { ref, oid: commit.value, pushBytes: pushed.value });
  });
}

export type DeleteBranchConfig = { readonly expected: string | null };
export type DeleteBranchSpec = { readonly ref: string } & Input<DeleteBranchConfig>;
export type DeleteBranchResult = { readonly ref: string; readonly oid: string };
// Delete a branch (or any ref): against `expected` when given (the tip the caller last saw), else the tip ls-refs
// reports now. An absent ref is not_found. receive-pack's report is the answer (push.ts: anything short of git's own
// report is `ambiguous`), so there is no read-back.
export async function deleteBranch(url: string, spec: DeleteBranchSpec, options: ReadOptions = {}): Promise<Result<DeleteBranchResult, PlyError>> {
  const { ref } = spec;
  const { expected } = withDefaults<DeleteBranchConfig>(spec, { expected: null });
  const named = validatePushRef(ref, true); if (!named.ok) return named;
  if (expected !== null && !isOid(expected)) return fail('bad_request', 'expected must be a 40-hex commit id', { what: 'expected' });
  return operation('branch_delete', url, opOpts(options, { 'git.branch_delete.ref': ref, 'git.branch_delete.cas_from_caller': expected !== null }), async ({ t, root, outcome }: OpContext): Promise<Result<DeleteBranchResult, PlyError>> => {
    const listed = await lsRefs(t, [ref]); if (!listed.ok) return listed;
    const present = refOid(listed.value.refs, ref);
    if (present.tag === 'none') return fail('not_found', `ref ${ref} not found`, { miss: { kind: 'ref', ref, candidates: [ref] } });
    const tip = present.value;
    if (expected !== null && expected !== tip) return fail('cas_conflict', `${ref} is at ${tip}, not ${expected}`, { what: 'ref', expected, actual: tip });
    root.set({ 'git.branch_delete.oid': tip });
    const pushed = await push(t, { ref, oldOid: tip, newOid: ZERO_OID, objects: [] });
    if (!pushed.ok) return pushed;
    return outcome('deleted', { ref, oid: tip });
  });
}

export type CreateTagConfig = { readonly message: string | null; readonly tagger: Author | null; readonly time: number };
// `name` is the tag's name, `v1.0` or `refs/tags/v1.0`. A `message` makes an annotated tag (a tag object, as `git tag
// -a`), which needs a `tagger`; without one the tag is lightweight (the ref names the commit, as `git tag`).
export type CreateTagSpec = { readonly name: string; readonly target: string } & Input<CreateTagConfig>;
export type CreateTagResult = { readonly ref: string; readonly oid: string; readonly commit: string; readonly annotated: boolean; readonly pushBytes: number };
export async function createTag(url: string, spec: CreateTagSpec, options: RefOpOptions = {}): Promise<Result<CreateTagResult, PlyError>> {
  const { name, target } = spec;
  const { message, tagger, time } = withDefaults<CreateTagConfig>(spec, { message: null, tagger: null, time: Math.floor(Date.now() / 1000) });
  const { verify } = withDefaults(options, { verify: false });
  if (typeof name !== 'string' || name === '') return fail('bad_request', 'name must be a tag name', { what: 'tag' });
  const ref = name.startsWith('refs/tags/') ? name : `refs/tags/${name}`;
  const named = validatePushRef(ref, false); if (!named.ok) return named;
  if (typeof target !== 'string' || target === '') return fail('bad_request', 'target must be a ref name or a commit id', { what: 'target' });
  const annotated = message !== null;
  if (annotated) { const m = validateMessage(message); if (!m.ok) return m; }
  if (annotated && tagger === null) return fail('bad_request', 'an annotated tag (message) needs a tagger', { what: 'tagger' });
  const who = tagger === null ? null : stamp(tagger, time);
  if (who !== null && !who.ok) return who;
  return operation('tag_create', url, opOpts(options, { 'git.tag_create.ref': ref, 'git.tag_create.target': target, 'git.tag_create.annotated': annotated }), async ({ t, root, outcome }: OpContext): Promise<Result<CreateTagResult, PlyError>> => {
    const listed = await lsRefs(t, [ref]); if (!listed.ok) return listed;
    const present = refOid(listed.value.refs, ref);
    if (present.tag === 'some') return exists(ref, present.value);
    const commit = await commitOf(t, target, 'target'); if (!commit.ok) return commit;
    let oid = commit.value;
    const objects: PushObject[] = [];
    if (annotated && who !== null) {
      const line = ident(who.value); if (!line.ok) return line;
      const data = encodeTag({ object: commit.value, type: 'commit', tag: ref.slice('refs/tags/'.length), tagger: line.value, message: message.endsWith('\n') ? message : `${message}\n` });
      if (!data.ok) return data;
      oid = hashObject('tag', data.value);
      objects.push({ type: TYPE.TAG, data: data.value });
    }
    root.set({ 'git.tag_create.commit': commit.value, 'git.tag_create.oid': oid });
    const pushed = await createRef({ t, root }, { prefix: 'git.tag_create', ref, newOid: oid, objects, verify });
    if (!pushed.ok) return pushed;
    return outcome('created', { ref, oid, commit: commit.value, annotated, pushBytes: pushed.value });
  });
}

// A tag is a ref like a branch: deleting one is deleteBranch on refs/tags/<name> (the same CAS and errors).
export type DeleteTagSpec = { readonly name: string } & Input<DeleteBranchConfig>;
export async function deleteTag(url: string, spec: DeleteTagSpec, options: ReadOptions = {}): Promise<Result<DeleteBranchResult, PlyError>> {
  const { name } = spec;
  if (typeof name !== 'string' || name === '') return fail('bad_request', 'name must be a tag name', { what: 'tag' });
  const { expected } = withDefaults<DeleteBranchConfig>(spec, { expected: null });
  return deleteBranch(url, { ref: name.startsWith('refs/tags/') ? name : `refs/tags/${name}`, expected }, options);
}

// The refs the remote advertises under `prefixes` (branches and tags by default), sorted by name, and the branch HEAD
// names (null when HEAD is detached or absent). `peeled` is the commit an annotated tag points at, else null.
export type ListRefsConfig = { readonly prefixes: readonly string[] };
export type ListRefsSpec = Input<ListRefsConfig>;
export type ListedRef = { readonly name: string; readonly oid: string; readonly peeled: string | null };
export type ListRefsResult = { readonly head: string | null; readonly refs: readonly ListedRef[] };
export async function listRefs(url: string, spec: ListRefsSpec = {}, options: ReadOptions = {}): Promise<Result<ListRefsResult, PlyError>> {
  const { prefixes } = withDefaults<ListRefsConfig>(spec, { prefixes: ['refs/heads/', 'refs/tags/'] });
  if (!Array.isArray(prefixes) || !prefixes.every(p => typeof p === 'string' && p !== '')) return fail('bad_request', 'prefixes must be non-empty strings', { what: 'prefixes' });
  return operation('list_refs', url, opOpts(options, { 'git.list_refs.prefixes': prefixes.join(',') }), async ({ t, outcome }: OpContext): Promise<Result<ListRefsResult, PlyError>> => {
    const listed = await lsRefs(t, [...prefixes, 'HEAD']); if (!listed.ok) return listed;
    const refs: ListedRef[] = [];
    for (const [name, r] of listed.value.refs) if (name !== 'HEAD' && prefixes.some(p => name.startsWith(p))) refs.push({ name, oid: r.oid, peeled: r.peeled });
    // byte order, as git lists refs (names are unique, so never equal)
    refs.sort((a, b) => (a.name < b.name ? -1 : 1));
    return outcome('ok', { head: listed.value.head, refs }, { 'git.list_refs.count': refs.length });
  });
}
