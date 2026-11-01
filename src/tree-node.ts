// Node only (node:fs, node:path): a directory as pushTree's `files`. Not part of any Workers bundle — the Workers-safe
// core is tree.js, which takes the files as data.
//
//   filesFromDir(dir, { limits, filter }) → [{ path, mode, data }]
//   pushDir(url, { dir, filter, ...spec }, opts) = pushTree(url, { ...spec, files: await filesFromDir(dir, …) }, opts)
//
// Modes as git's index records them (ce_mode_from_stat): a regular file with the owner's execute bit is 100755,
// otherwise 100644; a symlink is 120000 with its target as the blob (never followed); a directory is a tree (an empty
// one disappears, as in git). `.git` is skipped at every level. Anything else (FIFO, socket, device) is `bad_request`,
// not a silent skip. `filter(path, { directory, symlink })` → false leaves a path out (`.gitignore` is not read).
// Bounds: each file by maxObjectSize (checked on lstat, before the read), the count by maxPackObjects, the bytes held
// by maxInflatedTotal — the resident set ply already accepts for one buffered pack.
import { readdir, readFile, readlink, lstat } from 'node:fs/promises';
// oxlint-disable-next-line unicorn/import-style -- `path` names a file's path in the tree throughout this file
import { join } from 'node:path';
import { fail, orThrow } from './errors.js';
import type { ErrorOf } from './errors.js';
import { DEFAULT_LIMITS, limitExceeded, readLimit } from './limits.js';
import type { Limits } from './limits.js';
import { MODE_BLOB, MODE_EXEC, MODE_LINK } from './format.js';
import { err, getOrElse, ok } from './result.js';
import type { Result } from './result.js';
import type { Input } from './absent.js';
import { fromNullish, withDefaults } from './absent.js';
import { pushTree } from './tree.js';
import type { PushTreeOptions, PushTreeResult, TreeSpec } from './tree.js';

/* oxlint-disable no-await-in-loop -- the walk reads one entry at a time, in sorted order, under the byte bound */

const OWNER_EXEC = 0o100;

// A file of the directory, as pushTree takes it.
export type DirFile = { readonly path: string; readonly mode: string; readonly data: Uint8Array };
// `filter(path, { directory, symlink })` → false leaves the path out.
export type DirFilter = (path: string, kind: { readonly directory: boolean; readonly symlink: boolean }) => boolean;
// The walk's options, total: the bounds, and the caller's filter (null: keep every path).
export type FilesFromDirConfig = { readonly limits: Limits; readonly filter: DirFilter | null };
export type FilesFromDirOptions = Input<FilesFromDirConfig>;
type DirError = ErrorOf<'bad_request' | 'limit_exceeded'>;

// The walk as a value: a refused entry or bound is an Err. The file system's own failures (a missing directory, a
// permission) reject as node:fs rejects them.
export async function filesFromDirResult(dir: string, options: FilesFromDirOptions | null = null): Promise<Result<DirFile[], DirError>> {
  const { limits, filter } = withDefaults(options, { limits: DEFAULT_LIMITS, filter: null });
  const maxObject = readLimit(limits, 'maxObjectSize');
  if (!maxObject.ok) return maxObject;
  const maxFiles = readLimit(limits, 'maxPackObjects');
  if (!maxFiles.ok) return maxFiles;
  const maxTotal = readLimit(limits, 'maxInflatedTotal');
  if (!maxTotal.ok) return maxTotal;
  const out: DirFile[] = [];
  let total = 0;
  const keep = (data: Uint8Array, path: string, mode: string): Result<null, DirError> => {
    if (out.length >= maxFiles.value) return err(limitExceeded('files', out.length + 1, maxFiles.value));
    total += data.length;
    if (total > maxTotal.value) return err(limitExceeded('directory bytes', total, maxTotal.value));
    out.push({ path, mode, data: new Uint8Array(data.buffer, data.byteOffset, data.length) });
    return ok(null);
  };
  // One entry: the directory to walk into, the file or link to keep, or the refusal.
  const walk = async (rel: string): Promise<Result<null, DirError>> => {
    const names = (await readdir(rel ? join(dir, rel) : dir)).toSorted();
    for (const name of names) {
      if (name === '.git') continue;
      const path = rel ? `${rel}/${name}` : name;
      const full = join(dir, path);
      const st = await lstat(full);
      if (filter !== null && !filter(path, { directory: st.isDirectory(), symlink: st.isSymbolicLink() })) continue;
      let kept: Result<null, DirError>;
      if (st.isDirectory()) kept = await walk(path);
      else if (st.isSymbolicLink()) kept = keep(await readlink(full, { encoding: 'buffer' }), path, MODE_LINK);
      else if (st.isFile()) {
        if (st.size > maxObject.value) return err(limitExceeded('object size', st.size, maxObject.value));
        kept = keep(await readFile(full), path, (st.mode & OWNER_EXEC) === 0 ? MODE_BLOB : MODE_EXEC);
      } else return fail('bad_request', `${path}: not a regular file, directory or symlink`, { what: 'path', path });
      if (!kept.ok) return kept;
    }
    return ok(null);
  };
  const walked = await walk('');
  return walked.ok ? ok(out) : walked;
}
// The throwing form ('ply/tree-node' is a public entry, which throws until the Result cut-over).
export async function filesFromDir(dir: string, options: FilesFromDirOptions | null = null): Promise<DirFile[]> {
  return orThrow(await filesFromDirResult(dir, options));
}

export type PushDirSpec = Omit<TreeSpec, 'files'> & { readonly dir: string } & Input<{ readonly filter: DirFilter | null }>;
export async function pushDir(url: string, { dir, filter = null, ...spec }: PushDirSpec, opts: PushTreeOptions = {}): Promise<PushTreeResult> {
  return pushTree(url, { ...spec, files: await filesFromDir(dir, { limits: getOrElse(fromNullish(opts.limits), DEFAULT_LIMITS), filter }) }, opts);
}
