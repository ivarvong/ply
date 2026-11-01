// An in-memory tree for one multi-path commit. A lazy node is an object the server already has (its oid only);
// a directory is expanded only when a change walks into it. Encoding writes the directories this call rebuilt;
// a lazy node contributes its oid and no bytes. Empty directories are pruned; only the root may be empty.
import { thrown as failThrown, fail } from './errors.js';
import type { ErrorOf } from './errors.js';
import { ok } from './result.js';
import type { Result } from './result.js';
import { encodeTree, hashObject } from './objects.js';
import { indexOfBytes } from './bytes.js';
import { limitError, requireLimit } from './limits.js';
import type { Limits } from './limits.js';
import { MODE_LINK, MODE_TREE, BLOB_MODES } from './format.js';

export type BlobMode = (typeof BLOB_MODES)[number];
const BLOB_MODE_SET: ReadonlySet<string> = new Set(BLOB_MODES);

export type Dir = { readonly kind: 'dir'; readonly entries: Map<string, Mem> };
export type Lazy = { readonly kind: 'lazy'; readonly mode: string; readonly oid: string };
export type Mem = Dir | Lazy;

export const emptyDir = (): Dir => ({ kind: 'dir', entries: new Map() });
export const lazyNode = (mode: string, oid: string): Lazy => ({ kind: 'lazy', mode, oid });
export const isDir = (node: Mem): node is Extract<Mem, { readonly kind: 'dir' }> => node.kind === 'dir';

// The directory's entries, or bad_request when the node is not a directory. Exported so a cell can reach this
// refusal on a lazy node; the live path expands trees before it edits them.
export function requireDir(node: Mem, path: string): Map<string, Mem> {
  if (node.kind !== 'dir') throw failThrown('bad_request', `${path || '.'} is not a directory`, { what: 'path', path });
  return node.entries;
}

export type Leaf = { readonly mode: BlobMode; readonly oid: string; readonly data: Uint8Array };
// Hash one blob the caller is adding. A symlink target is a path: git cannot check out an empty one, and a NUL ends it.
export function fileLeaf(mode: BlobMode, data: Uint8Array, limits: Limits, path = 'blob'): Leaf {
  const max = requireLimit(limits, 'maxObjectSize');
  if (data.length > max) throw limitError('object size', data.length, max);
  if (mode === MODE_LINK && (data.length === 0 || data.includes(0))) throw failThrown('bad_request', `${path}: a symlink target must be non-empty and contain no NUL`, { what: 'symlink', path });
  return { mode, oid: hashObject('blob', data), data };
}

function leafName(comps: readonly string[]): string {
  // validatePath refuses an empty path, so every component list that reaches here has a last name.
  const name = comps.at(-1);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- validatePath refuses an empty path, so the last component is a string; `!` is not used in this repository
  return name as string;
}

function joined(comps: readonly string[]): string {
  return comps.join('/');
}

// The missing component and the path that existed above it. Not a fail wrapper: the throw stays at the call.
function pathMiss(path: string): { readonly kind: 'path'; readonly missing: string; readonly existingPath: string } {
  const at = path.lastIndexOf('/');
  if (at < 0) return { kind: 'path', missing: path, existingPath: '' };
  return { kind: 'path', missing: path.slice(at + 1), existingPath: path.slice(0, at) };
}

export function insertChild(entries: Map<string, Mem>, name: string, node: Mem, limits: Limits): void {
  if (!entries.has(name)) {
    const max = requireLimit(limits, 'maxTreeEntries');
    if (entries.size >= max) throw limitError('tree entries', entries.size + 1, max);
  }
  entries.set(name, node);
}

// Put `leaf` at `comps`. `overwrite` is write (replace a file); create fails when the path exists.
// A directory at the path is a refusal either way. Intermediate components must already be directories.
export function putAt(root: Mem, comps: readonly string[], leaf: Mem, overwrite: boolean, limits: Limits): void {
  let entries = requireDir(root, '');
  let walked = '';
  for (const name of comps.slice(0, -1)) {
    walked = walked === '' ? name : `${walked}/${name}`;
    const child = entries.get(name);
    if (child === undefined || child.kind !== 'dir') throw failThrown('bad_request', `${walked} is not a directory`, { what: 'path', path: walked });
    entries = child.entries;
  }
  const name = leafName(comps);
  const full = walked === '' ? name : `${walked}/${name}`;
  const existing = entries.get(name);
  if ((existing !== undefined && existing.kind === 'dir') || (existing !== undefined && existing.kind === 'lazy' && existing.mode === MODE_TREE)) {
    throw failThrown('bad_request', `${full} is a directory`, { what: 'path', path: full });
  }
  if (existing !== undefined && !overwrite) throw failThrown('bad_request', `${full} already exists`, { what: 'path', path: full });
  insertChild(entries, name, leaf, limits);
}

// Drop the node at `comps` and prune directories that this left empty. The root may stay empty.
export function removeAt(root: Mem, comps: readonly string[]): void {
  const stack: Array<{ readonly entries: Map<string, Mem>; readonly name: string }> = [];
  let entries = requireDir(root, '');
  let walked = '';
  for (const name of comps.slice(0, -1)) {
    walked = walked === '' ? name : `${walked}/${name}`;
    const child = entries.get(name);
    if (child === undefined) throw failThrown('not_found', `${walked} not found`, { what: 'path', path: walked, miss: pathMiss(walked) });
    if (child.kind !== 'dir') throw failThrown('not_found', `${walked} is not a directory`, { what: 'path', path: walked, miss: { kind: 'not_directory', path: walked, mode: child.mode } });
    stack.push({ entries, name });
    entries = child.entries;
  }
  const name = leafName(comps);
  const full = walked === '' ? name : `${walked}/${name}`;
  if (!entries.has(name)) throw failThrown('not_found', `${full} not found`, { what: 'path', path: full, miss: pathMiss(full) });
  entries.delete(name);
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    if (frame === undefined) break;
    const child = frame.entries.get(frame.name);
    if (child === undefined || child.kind !== 'dir' || child.entries.size > 0) break;
    frame.entries.delete(frame.name);
  }
}

// Move `from` to `to`. The same path, and a destination inside the source, are bad_request before any lookup
// (a missing source still is). The destination's parent must already exist; a destination that exists is bad_request.
export function renameAt(root: Mem, from: readonly string[], to: readonly string[]): void {
  const fromPath = joined(from);
  const toPath = joined(to);
  if (fromPath === toPath) throw failThrown('bad_request', `${fromPath} is already named ${toPath}`, { what: 'path', path: fromPath });
  if (toPath.startsWith(`${fromPath}/`)) throw failThrown('bad_request', `cannot rename ${fromPath} into itself`, { what: 'path', path: fromPath });
  let srcEntries = requireDir(root, '');
  let walked = '';
  const stack: Array<{ readonly entries: Map<string, Mem>; readonly name: string }> = [];
  for (const name of from.slice(0, -1)) {
    walked = walked === '' ? name : `${walked}/${name}`;
    const child = srcEntries.get(name);
    if (child === undefined) throw failThrown('not_found', `${walked} not found`, { what: 'path', path: walked, miss: pathMiss(walked) });
    if (child.kind !== 'dir') throw failThrown('not_found', `${walked} is not a directory`, { what: 'path', path: walked, miss: { kind: 'not_directory', path: walked, mode: child.mode } });
    stack.push({ entries: srcEntries, name });
    srcEntries = child.entries;
  }
  const srcName = leafName(from);
  const node = srcEntries.get(srcName);
  if (node === undefined) throw failThrown('not_found', `${fromPath} not found`, { what: 'path', path: fromPath, miss: pathMiss(fromPath) });
  let destEntries = requireDir(root, '');
  let destWalked = '';
  for (const name of to.slice(0, -1)) {
    destWalked = destWalked === '' ? name : `${destWalked}/${name}`;
    const child = destEntries.get(name);
    if (child === undefined) throw failThrown('not_found', `${destWalked} not found`, { what: 'path', path: destWalked, miss: pathMiss(destWalked) });
    if (child.kind !== 'dir') throw failThrown('not_found', `${destWalked} is not a directory`, { what: 'path', path: destWalked, miss: { kind: 'not_directory', path: destWalked, mode: child.mode } });
    destEntries = child.entries;
  }
  const destName = leafName(to);
  if (destEntries.has(destName)) throw failThrown('bad_request', `${toPath} already exists`, { what: 'path', path: toPath });
  srcEntries.delete(srcName);
  destEntries.set(destName, node);
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    if (frame === undefined) break;
    const child = frame.entries.get(frame.name);
    if (child === undefined || child.kind !== 'dir' || child.entries.size > 0) break;
    frame.entries.delete(frame.name);
  }
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
function encodeNode(node: Mem, limits: Limits, trees: EncodedTree[]): string {
  if (node.kind === 'lazy') return node.oid;
  const max = requireLimit(limits, 'maxTreeEntries');
  if (node.entries.size > max) throw limitError('tree entries', node.entries.size, max);
  const entries: Array<{ readonly mode: string; readonly name: string; readonly oid: string }> = [];
  for (const [name, child] of node.entries) {
    if (child.kind === 'dir') entries.push({ mode: MODE_TREE, name, oid: encodeNode(child, limits, trees) });
    else entries.push({ mode: child.mode, name, oid: child.oid });
  }
  const data = encodeTree(entries);
  const oid = hashObject('tree', data);
  trees.push({ oid, data });
  return oid;
}
// The trees this memory holds, deepest first. A lazy node contributes its oid and no bytes.
export function encodeMem(node: Mem, limits: Limits): Encoded {
  const trees: EncodedTree[] = [];
  const oid = encodeNode(node, limits, trees);
  return { oid, trees };
}

export function blobOids(node: Mem, into: Set<string>): void {
  if (node.kind === 'lazy') {
    if (BLOB_MODE_SET.has(node.mode)) into.add(node.oid);
    return;
  }
  for (const child of node.entries.values()) blobOids(child, into);
}
