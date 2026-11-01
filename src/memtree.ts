// An in-memory tree for one multi-path commit. A lazy node is an object the server already has (its oid only);
// a directory is expanded only when a change walks into it. Encoding writes the directories this call rebuilt;
// a lazy node contributes its oid and no bytes. Empty directories are pruned; only the root may be empty.
// Every refusal is a value (Result): the commit path (changes.ts) returns it, and nothing here throws.
import { fail } from './errors.js';
import type { ErrorOf } from './errors.js';
import { err, ok } from './result.js';
import type { Result } from './result.js';
import { encodeTree, hashObject } from './objects.js';
import { indexOfBytes } from './bytes.js';
import { limitExceeded, readLimit } from './limits.js';
import type { Limits } from './limits.js';
import { MODE_LINK, MODE_TREE, BLOB_MODES } from './format.js';
import { atOr, mapGet } from './absent.js';

export type BlobMode = (typeof BLOB_MODES)[number];
const BLOB_MODE_SET: ReadonlySet<string> = new Set(BLOB_MODES);

export type Dir = { readonly kind: 'dir'; readonly entries: Map<string, Mem> };
export type Lazy = { readonly kind: 'lazy'; readonly mode: string; readonly oid: string };
export type Mem = Dir | Lazy;

// What an edit of the memory tree can refuse: a path that is not what the change needs, a bound, a bad limit.
export type MemError = ErrorOf<'bad_request' | 'not_found' | 'limit_exceeded'>;

export const emptyDir = (): Dir => ({ kind: 'dir', entries: new Map() });
export const lazyNode = (mode: string, oid: string): Lazy => ({ kind: 'lazy', mode, oid });
export const isDir = (node: Mem): node is Extract<Mem, { readonly kind: 'dir' }> => node.kind === 'dir';

// The directory's entries, or bad_request when the node is not a directory. Exported so a cell can reach this
// refusal on a lazy node; the live path expands trees before it edits them.
export function requireDir(node: Mem, path: string): Result<Map<string, Mem>, ErrorOf<'bad_request'>> {
  if (node.kind !== 'dir') return fail('bad_request', `${path || '.'} is not a directory`, { what: 'path', path });
  return ok(node.entries);
}

export type Leaf = { readonly mode: BlobMode; readonly oid: string; readonly data: Uint8Array };
// Hash one blob the caller is adding. A symlink target is a path: git cannot check out an empty one, and a NUL ends it.
export function fileLeaf(mode: BlobMode, data: Uint8Array, limits: Limits, path = 'blob'): Result<Leaf, ErrorOf<'bad_request' | 'limit_exceeded'>> {
  const max = readLimit(limits, 'maxObjectSize');
  if (!max.ok) return max;
  if (data.length > max.value) return err(limitExceeded('object size', data.length, max.value));
  if (mode === MODE_LINK && (data.length === 0 || data.includes(0))) return fail('bad_request', `${path}: a symlink target must be non-empty and contain no NUL`, { what: 'symlink', path });
  return ok({ mode, oid: hashObject('blob', data), data });
}

// validatePath refuses an empty path, so every component list that reaches here has a last name ('' is never one).
const leafName = (comps: readonly string[]): string => atOr(comps, comps.length - 1, '');

function joined(comps: readonly string[]): string {
  return comps.join('/');
}

// The missing component and the path that existed above it. Not a fail wrapper: the refusal stays at the call.
function pathMiss(path: string): { readonly kind: 'path'; readonly missing: string; readonly existingPath: string } {
  const at = path.lastIndexOf('/');
  if (at < 0) return { kind: 'path', missing: path, existingPath: '' };
  return { kind: 'path', missing: path.slice(at + 1), existingPath: path.slice(0, at) };
}

export function insertChild(entries: Map<string, Mem>, name: string, node: Mem, limits: Limits): Result<null, ErrorOf<'bad_request' | 'limit_exceeded'>> {
  if (!entries.has(name)) {
    const max = readLimit(limits, 'maxTreeEntries');
    if (!max.ok) return max;
    if (entries.size >= max.value) return err(limitExceeded('tree entries', entries.size + 1, max.value));
  }
  entries.set(name, node);
  return ok(null);
}

// One step of a walk down existing directories: the entries under `name`, or the refusal for what is there instead.
type Frame = { readonly entries: Map<string, Mem>; readonly name: string };
function stepInto(entries: Map<string, Mem>, name: string, walked: string): Result<Map<string, Mem>, ErrorOf<'not_found'>> {
  const child = mapGet(entries, name);
  if (child.tag === 'none') return fail('not_found', `${walked} not found`, { what: 'path', path: walked, miss: pathMiss(walked) });
  if (child.value.kind !== 'dir') return fail('not_found', `${walked} is not a directory`, { what: 'path', path: walked, miss: { kind: 'not_directory', path: walked, mode: child.value.mode } });
  return ok(child.value.entries);
}

// Prune the directories, innermost first, that a removal left empty. The root may stay empty.
function prune(stack: readonly Frame[]): void {
  for (const frame of stack.toReversed()) {
    const child = mapGet(frame.entries, frame.name);
    if (child.tag === 'none' || child.value.kind !== 'dir' || child.value.entries.size > 0) break;
    frame.entries.delete(frame.name);
  }
}

// Put `leaf` at `comps`. `overwrite` is write (replace a file); create fails when the path exists.
// A directory at the path is a refusal either way. Intermediate components must already be directories.
export function putAt(root: Mem, comps: readonly string[], leaf: Mem, overwrite: boolean, limits: Limits): Result<null, MemError> {
  const top = requireDir(root, '');
  if (!top.ok) return top;
  let entries = top.value;
  let walked = '';
  for (const name of comps.slice(0, -1)) {
    walked = walked === '' ? name : `${walked}/${name}`;
    const child = mapGet(entries, name);
    if (child.tag === 'none' || child.value.kind !== 'dir') return fail('bad_request', `${walked} is not a directory`, { what: 'path', path: walked });
    entries = child.value.entries;
  }
  const name = leafName(comps);
  const full = walked === '' ? name : `${walked}/${name}`;
  const existing = mapGet(entries, name);
  if (existing.tag === 'some' && (existing.value.kind === 'dir' || existing.value.mode === MODE_TREE)) {
    return fail('bad_request', `${full} is a directory`, { what: 'path', path: full });
  }
  if (existing.tag === 'some' && !overwrite) return fail('bad_request', `${full} already exists`, { what: 'path', path: full });
  return insertChild(entries, name, leaf, limits);
}

// Drop the node at `comps` and prune directories that this left empty. The root may stay empty.
export function removeAt(root: Mem, comps: readonly string[]): Result<null, ErrorOf<'bad_request' | 'not_found'>> {
  const stack: Frame[] = [];
  const top = requireDir(root, '');
  if (!top.ok) return top;
  let entries = top.value;
  let walked = '';
  for (const name of comps.slice(0, -1)) {
    walked = walked === '' ? name : `${walked}/${name}`;
    const next = stepInto(entries, name, walked);
    if (!next.ok) return next;
    stack.push({ entries, name });
    entries = next.value;
  }
  const name = leafName(comps);
  const full = walked === '' ? name : `${walked}/${name}`;
  if (!entries.has(name)) return fail('not_found', `${full} not found`, { what: 'path', path: full, miss: pathMiss(full) });
  entries.delete(name);
  prune(stack);
  return ok(null);
}

// Move `from` to `to`. The same path, and a destination inside the source, are bad_request before any lookup
// (a missing source still is). The destination's parent must already exist; a destination that exists is bad_request.
export function renameAt(root: Mem, from: readonly string[], to: readonly string[]): Result<null, ErrorOf<'bad_request' | 'not_found'>> {
  const fromPath = joined(from);
  const toPath = joined(to);
  if (fromPath === toPath) return fail('bad_request', `${fromPath} is already named ${toPath}`, { what: 'path', path: fromPath });
  if (toPath.startsWith(`${fromPath}/`)) return fail('bad_request', `cannot rename ${fromPath} into itself`, { what: 'path', path: fromPath });
  const top = requireDir(root, '');
  if (!top.ok) return top;
  let srcEntries = top.value;
  let walked = '';
  const stack: Frame[] = [];
  for (const name of from.slice(0, -1)) {
    walked = walked === '' ? name : `${walked}/${name}`;
    const next = stepInto(srcEntries, name, walked);
    if (!next.ok) return next;
    stack.push({ entries: srcEntries, name });
    srcEntries = next.value;
  }
  const srcName = leafName(from);
  const node = mapGet(srcEntries, srcName);
  if (node.tag === 'none') return fail('not_found', `${fromPath} not found`, { what: 'path', path: fromPath, miss: pathMiss(fromPath) });
  let destEntries = top.value;
  let destWalked = '';
  for (const name of to.slice(0, -1)) {
    destWalked = destWalked === '' ? name : `${destWalked}/${name}`;
    const next = stepInto(destEntries, name, destWalked);
    if (!next.ok) return next;
    destEntries = next.value;
  }
  const destName = leafName(to);
  if (destEntries.has(destName)) return fail('bad_request', `${toPath} already exists`, { what: 'path', path: toPath });
  srcEntries.delete(srcName);
  destEntries.set(destName, node.value);
  prune(stack);
  return ok(null);
}

// Exactly one non-overlapping match. Zero or several is match_count; an empty find is bad_request.
export function replaceOnce(data: Uint8Array, find: Uint8Array, replace: Uint8Array): Result<Uint8Array, ErrorOf<'bad_request' | 'match_count'>> {
  if (find.length === 0) return fail('bad_request', 'find must be non-empty');
  let count = 0;
  let at = 0;
  let from = 0;
  for (;;) {
    const i = indexOfBytes(data, find, from);
    if (i < 0) break;
    if (count === 0) at = i;
    count += 1;
    from = i + find.length;
  }
  if (count !== 1) return fail('match_count', `expected exactly one match, found ${count}`, { matches: count });
  const out = new Uint8Array(data.length - find.length + replace.length);
  out.set(data.subarray(0, at), 0);
  out.set(replace, at);
  out.set(data.subarray(at + find.length), at + replace.length);
  return ok(out);
}

export type EncodedTree = { readonly oid: string; readonly data: Uint8Array };
export type Encoded = { readonly oid: string; readonly trees: readonly EncodedTree[] };
function encodeNode(node: Mem, max: number, trees: EncodedTree[]): Result<string, ErrorOf<'limit_exceeded'>> {
  if (node.kind === 'lazy') return ok(node.oid);
  if (node.entries.size > max) return err(limitExceeded('tree entries', node.entries.size, max));
  const entries: Array<{ readonly mode: string; readonly name: string; readonly oid: string }> = [];
  for (const [name, child] of node.entries) {
    if (child.kind === 'dir') {
      const sub = encodeNode(child, max, trees);
      if (!sub.ok) return sub;
      entries.push({ mode: MODE_TREE, name, oid: sub.value });
    } else entries.push({ mode: child.mode, name, oid: child.oid });
  }
  const data = encodeTree(entries);
  const oid = hashObject('tree', data);
  trees.push({ oid, data });
  return ok(oid);
}
// The trees this memory holds, deepest first. A lazy node contributes its oid and no bytes. The limit is read once,
// before the first directory is encoded (a lazy root reads none, as before).
export function encodeMem(node: Mem, limits: Limits): Result<Encoded, ErrorOf<'bad_request' | 'limit_exceeded'>> {
  if (node.kind === 'lazy') return ok({ oid: node.oid, trees: [] });
  const max = readLimit(limits, 'maxTreeEntries');
  if (!max.ok) return max;
  const trees: EncodedTree[] = [];
  const oid = encodeNode(node, max.value, trees);
  if (!oid.ok) return oid;
  return ok({ oid: oid.value, trees });
}

export function blobOids(node: Mem, into: Set<string>): void {
  if (node.kind === 'lazy') {
    if (BLOB_MODE_SET.has(node.mode)) into.add(node.oid);
    return;
  }
  for (const child of node.entries.values()) blobOids(child, into);
}
