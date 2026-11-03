// The objects a pack carries, walked from tips, over any object store: what pushRepo sends, and what a repack or an
// export writes. Workers-safe (no node:); pushRepo (repo-node.ts) reads its store from `.git`, a Worker from a fetched
// pack (`mapStore` over resolvePack's objects).
//
//   objectsForPack(store, tips, have) → everything reachable from `tips` that `have` lacks, in pack order: commits
//                                       parents first, then tags, then each commit's new trees and blobs depth first in
//                                       tree order, each with the path it first appears at (planDeltas' candidates)
//   reachableObjects(store, tips)     → everything reachable from `tips` that the store has (a remote's side of a push:
//                                       blobs are marked from tree entries and never read; a missing object is skipped)
//
// Gitlinks are not followed. A wanted object the store lacks is `bad_request` (`what: 'object'`); an object of the wrong
// type where a tree, commit or blob is named is `pack_corrupt`. Every commit, tree and tag is parsed under `limits`.
/* oxlint-disable no-await-in-loop -- the walks read one object at a time from the store, in pack order (the order is the output) */
import { fail } from './errors.js';
import type { PlyError } from './errors.js';
import { DEFAULT_LIMITS } from './limits.js';
import type { Limits } from './limits.js';
import { parseCommit, parseTag, parseTree, TYPE, TYPE_ID } from './objects.js';
import { MODE_COMMIT, MODE_TREE } from './format.js';
import type { DeltaCandidate } from './delta.js';
import { fromNullable, mapGet, readKey } from './absent.js';
import { getOrElse, ok } from './result.js';
import type { Option, Result } from './result.js';

/** An object as a store returns it: its type id (TYPE) and its bytes. */
export type StoredObject = { readonly type: number; readonly data: Uint8Array };
/** Where the walk reads objects: `get` answers the object, or null when the store does not have it. */
export type ObjectStore = { readonly get: (oid: string) => Promise<Result<StoredObject | null, PlyError>> };
/** A pack candidate with its id: planDeltas reads type, data and path; the id is for the caller's index. */
export type PackCandidate = DeltaCandidate & { readonly oid: string };

/** A store over objects already in memory (resolvePack's map, or any oid → { type, data } map). */
export function mapStore(objects: ReadonlyMap<string, StoredObject>): ObjectStore {
  // oxlint-disable-next-line typescript/promise-function-async -- a settled answer, no work to await
  return { get: (oid: string) => { const hit = mapGet(objects, oid); return Promise.resolve(ok(hit.tag === 'some' ? hit.value : null)); } };
}

// The next item of a work stack (none when it is empty).
export const popped = <T>(stack: T[]): Option<T> => (stack.length === 0 ? { tag: 'none' } : fromNullable(stack.pop()));
const TYPE_IDS: Readonly<Record<string, number>> = TYPE_ID;
// `source` names the store in a missing-object error ("missing from <source>").
export type Walk = { readonly store: ObjectStore; readonly limits: Limits; readonly source: string };
const TYPE_NAMES: Readonly<Record<number, string>> = { [TYPE.COMMIT]: 'commit', [TYPE.TREE]: 'tree', [TYPE.BLOB]: 'blob', [TYPE.TAG]: 'tag' };
const typeName = (type: number): string => getOrElse(readKey(TYPE_NAMES, type), String(type));
const wrongType = (oid: string, type: number, want: number): Result<never, PlyError> =>
  fail('pack_corrupt', `${oid} is a ${typeName(type)}, not a ${typeName(want)}`, { what: 'object', path: oid });

export type Child = { readonly oid: string; readonly type: number; readonly name: string };
// The objects one object names: a commit's tree and parents, a tree's entries (not gitlinks), a tag's object.
export function children(o: StoredObject, limits: Limits): Result<Child[], PlyError> {
  switch (o.type) {
    case TYPE.COMMIT: {
      const c = parseCommit(o.data, limits);
      if (!c.ok) return c;
      return ok([...c.value.parents.map(p => ({ oid: p, type: TYPE.COMMIT, name: '' })), { oid: c.value.tree, type: TYPE.TREE, name: '' }]);
    }
    case TYPE.TREE: {
      const t = parseTree(o.data, limits);
      if (!t.ok) return t;
      return ok(t.value.filter(e => e.mode !== MODE_COMMIT).map(e => ({ oid: e.oid, type: e.mode === MODE_TREE ? TYPE.TREE : TYPE.BLOB, name: e.name })));
    }
    case TYPE.TAG: {
      const t = parseTag(o.data);
      if (!t.ok) return t;
      return ok([{ oid: t.value.object, type: getOrElse(readKey(TYPE_IDS, t.value.type), TYPE.COMMIT), name: '' }]);
    }
    default: return ok([]);
  }
}

// An object the store must have (the pack carries it, or the walk decides with it).
async function need(w: Walk, oid: string, type: number | null, where: string): Promise<Result<StoredObject, PlyError>> {
  const got = await w.store.get(oid);
  if (!got.ok) return got;
  if (got.value === null) return fail('bad_request', `${oid} (${where}) is missing from ${w.source}`, { what: 'object', path: oid });
  if (type !== null && got.value.type !== type) return wrongType(oid, got.value.type, type);
  return ok(got.value);
}

// Everything reachable from `tips` that the store has (for a push: what the remote has). Blobs are marked from their
// tree entries and never read; an object the local repository lacks is skipped (the remote has it, ply does not).
export async function reachable(w: Walk, tips: readonly string[]): Promise<Result<Set<string>, PlyError>> {
  const seen = new Set<string>();
  const stack = [...tips];
  for (let next = popped(stack); next.tag === 'some'; next = popped(stack)) {
    const oid = next.value;
    if (seen.has(oid)) continue;
    const got = await w.store.get(oid);
    if (!got.ok) return got;
    if (got.value === null) continue;
    seen.add(oid);
    const kids = children(got.value, w.limits);
    if (!kids.ok) return kids;
    for (const k of kids.value) if (k.type === TYPE.BLOB) seen.add(k.oid); else stack.push(k.oid);
  }
  return ok(seen);
}
// What `have` lacks, in pack order: commits parents-first, then tags, then each commit's new trees and blobs in
// tree order with their paths (delta candidates: the previous version of a path is earlier in the pack).
export async function missing(w: Walk, tips: readonly string[], have: ReadonlySet<string>): Promise<Result<PackCandidate[], PlyError>> {
  const seen = new Set<string>(have);
  const commits: Array<{ readonly oid: string; readonly tree: string; readonly data: Uint8Array }> = [];
  const tags: PackCandidate[] = [];
  const rootObjects: Array<{ readonly oid: string; readonly type: number }> = [];
  // tips: peel tags (sent), then commits in post-order (parents first) by an explicit stack
  const stack: Array<{ readonly oid: string; readonly done: boolean }> = tips.map(oid => ({ oid, done: false })).toReversed();
  const parsed = new Map<string, { readonly tree: string; readonly data: Uint8Array }>();
  for (let next = popped(stack); next.tag === 'some'; next = popped(stack)) {
    const { oid, done } = next.value;
    if (done) { const c = mapGet(parsed, oid); if (c.tag === 'some') commits.push({ oid, ...c.value }); continue; }
    if (seen.has(oid)) continue;
    seen.add(oid);
    const got = await need(w, oid, null, 'a tip or an ancestor');
    if (!got.ok) return got;
    if (got.value.type === TYPE.TAG) {
      tags.push({ oid, type: TYPE.TAG, data: got.value.data, path: null });
      const kids = children(got.value, w.limits);
      if (!kids.ok) return kids;
      for (const k of kids.value) stack.push({ oid: k.oid, done: false });
      continue;
    }
    if (got.value.type !== TYPE.COMMIT) { seen.delete(oid); rootObjects.push({ oid, type: got.value.type }); continue; }
    const c = parseCommit(got.value.data, w.limits);
    if (!c.ok) return c;
    parsed.set(oid, { tree: c.value.tree, data: got.value.data });
    stack.push({ oid, done: true });
    for (const p of c.value.parents.toReversed()) stack.push({ oid: p, done: false });
  }
  const out: PackCandidate[] = [...commits.map(c => ({ oid: c.oid, type: TYPE.COMMIT, data: c.data, path: null })), ...tags];
  // trees and blobs, depth first in tree order, each with the path it first appears at
  const walkTree = async (oid: string, type: number, path: string): Promise<Result<null, PlyError>> => {
    if (seen.has(oid)) return ok(null);
    seen.add(oid);
    const got = await need(w, oid, type, path === '' ? 'a root tree' : path);
    if (!got.ok) return got;
    out.push({ oid, type, data: got.value.data, path });
    if (type !== TYPE.TREE) return ok(null);
    const kids = children(got.value, w.limits);
    if (!kids.ok) return kids;
    for (const k of kids.value) {
      const r = await walkTree(k.oid, k.type, path === '' ? k.name : `${path}/${k.name}`);
      if (!r.ok) return r;
    }
    return ok(null);
  };
  for (const c of commits) {
    const r = await walkTree(c.tree, TYPE.TREE, '');
    if (!r.ok) return r;
  }
  // a tag of a tree or a blob: that object and (for a tree) what it names
  for (const o of rootObjects) {
    const r = await walkTree(o.oid, o.type, '');
    if (!r.ok) return r;
  }
  return ok(out);
}

/** Everything reachable from `tips` that `store` has. Blobs are marked from their tree entries and never read. */
// oxlint-disable-next-line typescript/promise-function-async -- the walk's own promise
export function reachableObjects(store: ObjectStore, tips: readonly string[], limits: Limits = DEFAULT_LIMITS): Promise<Result<Set<string>, PlyError>> {
  return reachable({ store, limits, source: 'the object store' }, tips);
}
/** Everything reachable from `tips` and not in `have`, in pack order, each tree and blob with its first path. */
// oxlint-disable-next-line typescript/promise-function-async -- the walk's own promise
export function objectsForPack(store: ObjectStore, tips: readonly string[], have: ReadonlySet<string> = new Set(), limits: Limits = DEFAULT_LIMITS): Promise<Result<PackCandidate[], PlyError>> {
  return missing({ store, limits, source: 'the object store' }, tips, have);
}
