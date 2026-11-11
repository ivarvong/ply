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
// by maxInflatedTotal — the resident set ply already accepts for one buffered pack, LIMIT_OBJECT_OVERHEAD per file included.
import { readdir, readFile, readlink, lstat } from 'node:fs/promises';
// oxlint-disable-next-line unicorn/import-style -- `path` names a file's path in the tree throughout this file
import { join } from 'node:path';
import { callbackFailed, fail } from './errors.js';
import type { ErrorOf, PlyError } from './errors.js';
import { DEFAULT_LIMITS, LIMIT_OBJECT_OVERHEAD, limitExceeded, limitsOf, parseLimits } from './limits.js';
import type { LimitsInput } from './limits.js';
import { MODE_BLOB, MODE_EXEC, MODE_LINK } from './format.js';
import { err, getOrElse, ok } from './result.js';
import type { Result } from './result.js';
import type { Input } from './absent.js';
import { field, withDefaults } from './absent.js';
import { pushTree } from './tree.js';
import type { PushTreeOptions, PushTreeResult, TreeSpec } from './tree.js';

/* oxlint-disable no-await-in-loop -- the walk reads one entry at a time, in sorted order, under the byte bound */

const OWNER_EXEC = 0o100;

// A file of the directory, as pushTree takes it.
export type DirFile = { readonly path: string; readonly mode: string; readonly data: Uint8Array };
// `filter(path, { directory, symlink })` → false leaves the path out.
export type DirFilter = (path: string, kind: { readonly directory: boolean; readonly symlink: boolean }) => boolean;
// The walk's options, total: the bounds, and the caller's filter (null: keep every path).
export type FilesFromDirConfig = { readonly limits: LimitsInput; readonly filter: DirFilter | null };
export type FilesFromDirOptions = Input<FilesFromDirConfig>;
type DirError = ErrorOf<'bad_request' | 'limit_exceeded'>;

// The walk as a value: a refused entry or bound is an Err, and so is the file system's own failure (a missing
// directory, a permission): bad_request naming 'dir', with node:fs's error (its errno `code`, `path`) as `cause`.
// Definite: the walk precedes any request. filesFromDir never rejects.
export async function filesFromDir(dir: string, options: FilesFromDirOptions | null = null): Promise<Result<DirFile[], DirError>> {
  const { limits, filter } = withDefaults<FilesFromDirConfig>(options, { limits: DEFAULT_LIMITS, filter: null });
  const checked = parseLimits(limits);
  if (!checked.ok) return checked;
  const { maxObjectSize: maxObject, maxPackObjects: maxFiles, maxInflatedTotal: maxTotal } = checked.value;
  const out: DirFile[] = [];
  let total = 0;
  const keep = (data: Uint8Array, path: string, mode: string): Result<null, DirError> => {
    if (out.length >= maxFiles) return err(limitExceeded('files', out.length + 1, maxFiles));
    // each file costs LIMIT_OBJECT_OVERHEAD beyond its bytes (#142)
    total += data.length + LIMIT_OBJECT_OVERHEAD;
    if (total > maxTotal) return err(limitExceeded('directory bytes', total, maxTotal));
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
      // the caller's filter: what it throws is an Err naming 'filter' (definite: the walk precedes any request)
      let wanted = true;
      if (filter !== null) { try { wanted = filter(path, { directory: st.isDirectory(), symlink: st.isSymbolicLink() }); } catch (e) { return err(callbackFailed('filter', e)); } }
      if (!wanted) continue;
      let kept: Result<null, DirError>;
      if (st.isDirectory()) kept = await walk(path);
      else if (st.isSymbolicLink()) kept = keep(await readlink(full, { encoding: 'buffer' }), path, MODE_LINK);
      else if (st.isFile()) {
        if (st.size > maxObject) return err(limitExceeded('object size', st.size, maxObject));
        kept = keep(await readFile(full), path, (st.mode & OWNER_EXEC) === 0 ? MODE_BLOB : MODE_EXEC);
      } else return fail('bad_request', `${path}: not a regular file, directory or symlink`, { what: 'path', path });
      if (!kept.ok) return kept;
    }
    return ok(null);
  };
  let walked: Result<null, DirError>;
  try { walked = await walk(''); } catch (e) {
    return fail('bad_request', `${dir}: the directory could not be read: ${String(getOrElse(field(e, 'message'), e))}`, { what: 'dir', cause: e });
  }
  return walked.ok ? ok(out) : walked;
}

export type PushDirSpec = Omit<TreeSpec, 'files'> & { readonly dir: string } & Input<{ readonly filter: DirFilter | null }>;
export async function pushDir(url: string, { dir, filter = null, ...spec }: PushDirSpec, opts: PushTreeOptions = {}): Promise<Result<PushTreeResult, PlyError>> {
  const limits = limitsOf(opts);
  if (!limits.ok) return limits;
  const files = await filesFromDir(dir, { limits: limits.value, filter });
  if (!files.ok) return files;
  return pushTree(url, { ...spec, files: files.value }, { ...opts, limits: limits.value });
}
