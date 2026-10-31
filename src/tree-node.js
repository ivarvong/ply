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
import { join } from 'node:path';
import { thrown as fail } from './errors.js';
import { DEFAULT_LIMITS, limitError, requireLimit } from './limits.js';
import { MODE_BLOB, MODE_EXEC, MODE_LINK } from './format.js';
import { pushTree } from './tree.js';

const OWNER_EXEC = 0o100;

export async function filesFromDir(dir, { limits = DEFAULT_LIMITS, filter = null } = {}) {
  const maxObject = requireLimit(limits, 'maxObjectSize');
  const maxFiles = requireLimit(limits, 'maxPackObjects');
  const maxTotal = requireLimit(limits, 'maxInflatedTotal');
  const out = [];
  let total = 0;
  const keep = (data, path, mode) => {
    if (out.length >= maxFiles) throw limitError('files', out.length + 1, maxFiles);
    total += data.length;
    if (total > maxTotal) throw limitError('directory bytes', total, maxTotal);
    out.push({ path, mode, data: new Uint8Array(data.buffer, data.byteOffset, data.length) });
  };
  const walk = async rel => {
    const names = (await readdir(rel ? join(dir, rel) : dir)).sort();
    for (const name of names) {
      if (name === '.git') continue;
      const path = rel ? `${rel}/${name}` : name, full = join(dir, path);
      const st = await lstat(full);
      if (filter && !filter(path, { directory: st.isDirectory(), symlink: st.isSymbolicLink() })) continue;
      if (st.isDirectory()) await walk(path);
      else if (st.isSymbolicLink()) keep(await readlink(full, { encoding: 'buffer' }), path, MODE_LINK);
      else if (st.isFile()) {
        if (st.size > maxObject) throw limitError('object size', st.size, maxObject);
        keep(await readFile(full), path, st.mode & OWNER_EXEC ? MODE_EXEC : MODE_BLOB);
      } else throw fail('bad_request', `${path}: not a regular file, directory or symlink`, { what: 'path', path });
    }
  };
  await walk('');
  return out;
}

export async function pushDir(url, { dir, filter = null, ...spec }, opts = {}) {
  return pushTree(url, { ...spec, files: await filesFromDir(dir, { limits: opts.limits ?? DEFAULT_LIMITS, filter }) }, opts);
}
