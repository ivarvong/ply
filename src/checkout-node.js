// Node only (node:fs, node:path): checkoutTree's files written into a directory, laid out as `git clone` lays them out.
// Not part of any Workers bundle — the Workers-safe core is checkout.js, which yields the files as streams.
//
//   writeFiles(dir, files, { limits }) → { files, bytes, symlinks, gitlinks }   files: checkoutTree's `files`
//   checkoutDir(url, { dir, ref, path }, opts) → checkoutTree's record without `files`, plus `written`
//
// Layout as git's checkout (entry.c): a 100755 file is created 0777 & ~umask, any other 0666 & ~umask; a 120000 is a
// symlink whose target is the blob, never followed; a 160000 gitlink is an empty directory (an uninitialised submodule).
//
// Path safety. `dir` must be absent or empty, so everything under it is ours. Every path goes through validatePath (no
// `..`, `.`, empty or absolute component, no .git in any spelling git refuses) and git's verify_path for this platform
// (validate.js checkoutPathRefusal): on Windows a name with a backslash (`..\x` would leave `dir`), a colon (an NTFS
// stream), a reserved device name or a trailing dot or space is `unsupported`, as git for Windows refuses it. Each
// directory on the way is made one level at a time and lstat'd: anything but a real directory there (a symlink this
// checkout made, or a file — the same name on a case-insensitive filesystem counts) is `bad_request` (what: 'checkout
// path'), so nothing is ever written through a link. Files are opened O_CREAT|O_EXCL ('wx'), which neither follows a symlink nor overwrites; symlink()
// never replaces. A stream that fails (a blob that does not hash to its oid) removes its file before the error is
// rethrown; a checkout that throws leaves `dir` partial.
import { mkdir, readdir, lstat, open, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from './errors.js';
import { DEFAULT_LIMITS, limitError, requireLimit } from './limits.js';
import { validatePath, checkoutPathRefusal } from './validate.js';
import { concat, encodeBytes } from './bytes.js';
import { MODE_EXEC, MODE_LINK, MODE_COMMIT } from './format.js';
import { checkoutTree } from './checkout.js';

/* oxlint-disable no-magic-numbers -- the permission bits git creates files with (entry.c), before the umask */
const FILE_MODE = 0o666;
const EXEC_MODE = 0o777;
/* oxlint-enable no-magic-numbers */

// A tree name is bytes (#43): one that is not UTF-8 arrives with escaped bytes (bytes.js decodeBytes) and is written as
// those bytes through a Buffer path, as git writes it. A filesystem that refuses the bytes (APFS: EILSEQ) is a typed
// refusal naming the path, never a file under a U+FFFD name.
const fsPath = (dir, rel) => { const p = join(dir, rel); return p.isWellFormed() ? p : Buffer.from(encodeBytes(p, 'checkout path')); };
const refused = (path, e) => (e?.code === 'EILSEQ' ? fail('unsupported', `checkout: the filesystem refuses the name bytes of ${JSON.stringify(path)}`, { what: 'checkout path', path, cause: e }) : e);

const collision = (path, why) => fail('bad_request', `checkout: ${path} ${why}`, { what: 'checkout path', path });

// Effect: `dir` exists and is empty afterwards, or bad_request.
async function emptyDir(dir) {
  await mkdir(dir, { recursive: true });
  if ((await readdir(dir)).length) throw fail('bad_request', `checkout: ${dir} is not empty`, { what: 'dir' });
}

// Effect: read a stream into one buffer, at most `max` bytes (a symlink target).
async function slurp(stream, max) {
  const parts = []; let n = 0;
  for await (const c of stream) { n += c.length; if (n > max) throw limitError('symlink target', n, max); parts.push(c); }
  return concat(parts);
}

export async function writeFiles(dir, files, { limits = DEFAULT_LIMITS, platform = process.platform } = {}) {
  const maxObject = requireLimit(limits, 'maxObjectSize');
  await emptyDir(dir);
  const made = new Set(['']);
  const ensureDir = async rel => {
    if (made.has(rel)) return;
    const i = rel.lastIndexOf('/');
    await ensureDir(i < 0 ? '' : rel.slice(0, i));
    await mkdir(fsPath(dir, rel)).catch(e => { if (e?.code !== 'EEXIST') throw refused(rel, e); });
    if (!(await lstat(fsPath(dir, rel))).isDirectory()) throw collision(rel, 'is already a file or symlink here; refusing to write through it');
    made.add(rel);
  };
  const out = { files: 0, bytes: 0, symlinks: 0, gitlinks: 0 };
  for await (const f of files) {
    validatePath(f.path, limits);
    const why = checkoutPathRefusal(f.path, f.mode, platform);
    if (why) { await f.stream?.cancel().catch(() => {}); throw fail('unsupported', `checkout: git refuses to check out ${JSON.stringify(f.path)} on ${platform}: ${why}`, { what: 'checkout path', path: f.path }); }
    const full = fsPath(dir, f.path), slash = f.path.lastIndexOf('/');
    await ensureDir(slash < 0 ? '' : f.path.slice(0, slash));
    if (f.mode === MODE_COMMIT) { await ensureDir(f.path); out.gitlinks++; continue; }
    if (f.mode === MODE_LINK) {
      const target = await slurp(f.stream, maxObject);
      await symlink(Buffer.from(target.buffer, target.byteOffset, target.length), full).catch(e => { throw e?.code === 'EEXIST' ? collision(f.path, 'already exists') : refused(f.path, e); });
      out.symlinks++; continue;
    }
    const fh = await open(full, 'wx', f.mode === MODE_EXEC ? EXEC_MODE : FILE_MODE).catch(async e => { await f.stream.cancel().catch(() => {}); throw e?.code === 'EEXIST' ? collision(f.path, 'already exists') : refused(f.path, e); });
    try {
      for await (const c of f.stream) { let o = 0; while (o < c.length) o += (await fh.write(c, o, c.length - o)).bytesWritten; out.bytes += c.length; }
    } catch (e) {
      await fh.close(); await unlink(full).catch(() => {});
      throw e;
    }
    await fh.close();
    out.files++;
  }
  return out;
}

export async function checkoutDir(url, { dir, ref = null, path = '' } = {}, opts = {}) {
  if (typeof dir !== 'string' || dir === '') throw fail('bad_request', 'dir must be a non-empty string', { what: 'dir' });
  await emptyDir(dir);
  const { files, ...rest } = await checkoutTree(url, { ref, path }, opts);
  return { ...rest, written: await writeFiles(dir, files, { limits: opts.limits ?? DEFAULT_LIMITS }) };
}
// ci/fast probe 2: whole-file mutation of every src file (reverted in the next commit)
