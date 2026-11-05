/* oxlint-disable import/max-dependencies -- result.js is the 0.2.0 return type; this file was already at the module cap */
// Node only (node:fs, node:path): checkoutTree's files written into a directory, laid out as `git clone` lays them out.
// Not part of any Workers bundle — the Workers-safe core is checkout.js, which yields the files as streams.
//
//   writeFiles(dir, files, { limits, platform }) → Result<{ files, bytes, symlinks, gitlinks }>   files: checkoutTree's `files`
//   checkoutDir(url, { dir, ref, path }, opts) → Result of checkoutTree's record without `files`, plus `written`
// writeFiles takes both fields. checkoutDir takes `dir` and the tracer; the rest default (ref: the remote's HEAD, path:
// the whole tree, batch: CHECKOUT_BATCH, limits: DEFAULT_LIMITS, platform: this process's, the others none).
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
// returned as Err; a checkout that returns Err leaves `dir` partial. A filesystem error that is not EILSEQ is
// `unsupported` (kind: filesystem). checkoutTree's Err is checkoutDir's.
import { mkdir, readdir, lstat, open, symlink, unlink } from 'node:fs/promises';
// oxlint-disable-next-line unicorn/import-style -- `path` names a checkout path throughout this file
import { join } from 'node:path';
import { platform as processPlatform } from 'node:process';
import { fail, isPlyError, plyError } from './errors.js';
import type { ErrorOf, PlyError } from './errors.js';
import { err, getOrElse, mapOption, ok } from './result.js';
import type { Err, Option, Result } from './result.js';
import { DEFAULT_LIMITS, limitError, parseLimits } from './limits.js';
import type { LimitsInput } from './limits.js';
import { validatePath, checkoutPathRefusal } from './validate.js';
import { concat, encodeBytes } from './bytes.js';
import { MODE_EXEC, MODE_LINK, MODE_COMMIT } from './format.js';
import { checkoutTree } from './checkout.js';
import type { CheckoutFile, CheckoutResult } from './checkout.js';
import type { ReadOptions } from './read.js';
import { thrownCodeIs } from './boundary.js';
import type { HttpAuth } from './http.js';
import type { Tracer, Span } from './otel.js';
import type { Quirks, Transport } from './transport.js';
import type { Input } from './absent.js';
import { field, withDefaults } from './absent.js';

/* oxlint-disable no-await-in-loop -- files are written one at a time, in order, each stream drained before the next */
/* oxlint-disable unicorn/explicit-length-check, require-unicode-regexp -- bundle budget: the JS's truthy length checks and non-unicode regexes, byte for byte (no behaviour change) */

/* oxlint-disable no-magic-numbers -- the permission bits git creates files with (entry.c), before the umask, and checkout.ts BATCH */
const FILE_MODE = 0o666;
const EXEC_MODE = 0o777;
// The batch checkoutTree uses when its own parameter is omitted. checkoutDir takes it as a required field.
export const CHECKOUT_BATCH = 1000;
/* oxlint-enable no-magic-numbers */

// A tree name is bytes (#43): one that is not UTF-8 arrives with escaped bytes (bytes.js decodeBytes) and is written as
// those bytes through a Buffer path, as git writes it. A filesystem that refuses the bytes (APFS: EILSEQ) is a typed
// refusal naming the path, never a file under a U+FFFD name.
const fsPath = (dir: string, rel: string): Result<string | Buffer, PlyError> => {
  const p = join(dir, rel);
  if (p.isWellFormed()) return ok(p);
  const bytes = encodeBytes(p, 'checkout path');
  return bytes.ok ? ok(Buffer.from(bytes.value)) : bytes;
};
// A wrapper: the call site is the decision point (`refused(path, e)`), so the body stays the `fail()` itself.
const refused = (path: string, e: unknown) =>
  (thrownCodeIs(e, 'EILSEQ') ? fail('unsupported', `checkout: the filesystem refuses the name bytes of ${JSON.stringify(path)}`, { what: 'checkout path', path, cause: e }) : e);

const collision = (path: string, why: string): Err<ErrorOf<'bad_request'>> => fail('bad_request', `checkout: ${path} ${why}`, { what: 'checkout path', path });

type WithKind<E, K extends string> = E & { readonly kind: K };
const kinded = <E extends PlyError, K extends string>(error: E, kind: K): Err<WithKind<E, K>> => err(Object.assign(error, { kind }));
const isResultErr = (v: unknown): v is Err<PlyError> => {
  if (typeof v !== 'object' || v === null || !('ok' in v) || v.ok !== false || !('error' in v)) return false;
  return isPlyError(v.error);
};
// EILSEQ is name_bytes. Any other filesystem error is unsupported, kind filesystem (one decision point).
const nameBytes = (named: unknown): Err<WithKind<PlyError, 'name_bytes'>> | null =>
  (isResultErr(named) ? kinded(named.error, 'name_bytes') : null);
const filesystem = (path: string, e: unknown): Err<WithKind<ErrorOf<'unsupported'>, 'filesystem'>> =>
  kinded(plyError('unsupported', `checkout: the filesystem refused ${JSON.stringify(path)}`, { what: 'checkout path', path, cause: e }), 'filesystem');
const caught = (e: unknown, path: string): Err<WriteFilesError> => (isPlyError(e) ? err(e) : filesystem(path, e));

// The refusals writeFiles itself builds. A PlyError from validatePath, encodeBytes, parseLimits, or a blob stream
// is returned as that error (its own code and miss); it is not re-tagged.
export type WriteFilesError =
  | WithKind<ErrorOf<'bad_request'>, 'not_empty'>
  | WithKind<ErrorOf<'bad_request'>, 'collision'>
  | WithKind<ErrorOf<'unsupported'>, 'name_bytes'>
  | WithKind<ErrorOf<'unsupported'>, 'path_refused'>
  | WithKind<ErrorOf<'limit_exceeded'>, 'symlink_target'>
  | WithKind<ErrorOf<'unsupported'>, 'filesystem'>
  | PlyError;

// Effect: `dir` exists and is empty afterwards, or not_empty.
async function emptyDir(dir: string): Promise<Result<true, WithKind<ErrorOf<'bad_request'>, 'not_empty'> | WithKind<ErrorOf<'unsupported'>, 'filesystem'>>> {
  try {
    await mkdir(dir, { recursive: true });
    if ((await readdir(dir)).length) return kinded(fail('bad_request', `checkout: ${dir} is not empty`, { what: 'dir' }).error, 'not_empty');
  } catch (e) { return filesystem(dir, e); }
  return ok(true);
}

// Effect: read a stream into one buffer, at most `max` bytes (a symlink target). A stream that errors (a blob that does
// not hash to its oid) is that error as an Err, like a regular file's.
async function slurp(stream: ReadableStream<Uint8Array>, max: number, path: string): Promise<Result<Uint8Array<ArrayBuffer>, WriteFilesError>> {
  const parts: Uint8Array[] = []; let n = 0;
  try {
    for await (const c of stream) { n += c.length; if (n > max) return kinded(limitError('symlink target', n, max), 'symlink_target'); parts.push(c); }
  } catch (e) { return caught(e, path); }
  return ok(concat(parts));
}

// What writeFiles wrote: regular files (and their bytes), symlinks, and gitlinks (as empty directories).
export type Written = { files: number; bytes: number; symlinks: number; gitlinks: number };
async function ensureDir(dir: string, rel: string, made: Set<string>): Promise<Result<true, WriteFilesError>> {
  if (made.has(rel)) return ok(true);
  const i = rel.lastIndexOf('/');
  const up = await ensureDir(dir, i < 0 ? '' : rel.slice(0, i), made);
  if (!up.ok) return up;
  const named = fsPath(dir, rel);
  if (!named.ok) return named;
  const target = named.value;
  const created = await mkdir(target).then(() => ok(true), (e: unknown): Result<true, WriteFilesError> => {
    if (thrownCodeIs(e, 'EEXIST')) return ok(true);
    const bytes = nameBytes(refused(rel, e));
    if (bytes) return bytes;
    return filesystem(rel, e);
  });
  if (!created.ok) return created;
  const st = await lstat(target).then(s => ok(s), (e: unknown) => caught(e, rel));
  if (!st.ok) return st;
  if (!st.value.isDirectory()) return kinded(collision(rel, 'is already a file or symlink here; refusing to write through it').error, 'collision');
  made.add(rel);
  return ok(true);
}

// limits: any subset (a key left out is the default), parsed once before anything is written.
export type WriteFilesOptions = { readonly limits: LimitsInput; readonly platform: string };
// Complexity is the refusal branches. Pulling them into a helper would rename the decision-point function
// (the id is `writeFiles`, and the registry matches that name).
// oxlint-disable-next-line eslint/complexity -- see above
export async function writeFiles(dir: string, files: AsyncIterable<CheckoutFile>, options: WriteFilesOptions): Promise<Result<Written, WriteFilesError>> {
  const { platform } = options;
  const checked = parseLimits(options.limits);
  if (!checked.ok) return checked;
  const limits = checked.value;
  const maxObject = limits.maxObjectSize;
  const ready = await emptyDir(dir);
  if (!ready.ok) return ready;
  const made = new Set(['']);
  const out = { files: 0, bytes: 0, symlinks: 0, gitlinks: 0 };
  // Pull by hand: a blob that fails before the entry is yielded rejects next(), and that rejection is an Err.
  // for-await would nest the body one level deeper than the depth cap.
  const iter = files[Symbol.asyncIterator]();
  const stop = async (r: Err<WriteFilesError>): Promise<Err<WriteFilesError>> => { if (iter.return) await iter.return(); return r; };
  for (;;) {
    let next: IteratorResult<CheckoutFile>;
    try { next = await iter.next(); }
    catch (e) { return caught(e, dir); }
    if (next.done === true) break;
    const f = next.value;
    const valid = validatePath(f.path, limits);
    if (!valid.ok) return stop(valid);
    const refusal = checkoutPathRefusal(f.path, f.mode, platform);
    if (!refusal.ok) return stop(refusal);
    const why = getOrElse<string | null>(refusal.value, null);
    if (why !== null) {
      // a gitlink has no stream; every other entry does (CheckoutFile)
      if (f.mode !== MODE_COMMIT) await f.stream.cancel().catch(() => { /* refusing: the stream is not read */ });
      return stop(kinded(fail('unsupported', `checkout: git refuses to check out ${JSON.stringify(f.path)} on ${platform}: ${why}`, { what: 'checkout path', path: f.path }).error, 'path_refused'));
    }
    const named = fsPath(dir, f.path);
    if (!named.ok) return stop(named);
    const full = named.value;
    const slash = f.path.lastIndexOf('/');
    const parent = await ensureDir(dir, slash < 0 ? '' : f.path.slice(0, slash), made);
    if (!parent.ok) return stop(parent);
    if (f.mode === MODE_COMMIT) { const sub = await ensureDir(dir, f.path, made); if (!sub.ok) return stop(sub); out.gitlinks++; continue; }
    // a regular file or a symlink: checkoutTree streams every entry that is not a gitlink (CheckoutFile)
    const stream = f.stream;
    if (f.mode === MODE_LINK) {
      const target = await slurp(stream, maxObject, f.path);
      if (!target.ok) return stop(target);
      const linked = await symlink(Buffer.from(target.value.buffer, target.value.byteOffset, target.value.length), full).then(() => ok(true), (e: unknown): Result<true, WriteFilesError> => {
        if (thrownCodeIs(e, 'EEXIST')) return kinded(collision(f.path, 'already exists').error, 'collision');
        const bytes = nameBytes(refused(f.path, e));
        if (bytes) return bytes;
        return filesystem(f.path, e);
      });
      if (!linked.ok) return stop(linked);
      out.symlinks++; continue;
    }
    const opened = await open(full, 'wx', f.mode === MODE_EXEC ? EXEC_MODE : FILE_MODE).then(fh => ok(fh), async (e: unknown): Promise<Result<Awaited<ReturnType<typeof open>>, WriteFilesError>> => {
      await stream.cancel().catch(() => { /* failing: the stream is not read */ });
      if (thrownCodeIs(e, 'EEXIST')) return kinded(collision(f.path, 'already exists').error, 'collision');
      const bytes = nameBytes(refused(f.path, e));
      if (bytes) return bytes;
      return filesystem(f.path, e);
    });
    if (!opened.ok) return stop(opened);
    const fh = opened.value;
    try {
      for await (const c of stream) { let o = 0; while (o < c.length) o += (await fh.write(c, o, c.length - o)).bytesWritten; out.bytes += c.length; }
    } catch (e) {
      await fh.close().catch(() => { /* failing: the write error is the one reported */ }); await unlink(full).catch(() => { /* failing: the write error is the one reported */ });
      return stop(caught(e, f.path));
    }
    try { await fh.close(); }
    catch (e) { return stop(caught(e, f.path)); }
    out.files++;
  }
  return ok(out);
}

export type CheckoutDirResult = Omit<CheckoutResult, 'files'> & { readonly written: Written };
// dir is this function's own refusal. Everything else is writeFiles's Err or checkoutTree's.
export type CheckoutDirError = WithKind<ErrorOf<'bad_request'>, 'dir'> | WriteFilesError;
// Absence on a pass-through field is null. ref is a name or null (the remote's HEAD). path '' is the whole tree.
export type CheckoutDirConfig = { readonly ref: string | null; readonly path: string };
export type CheckoutDirRequest = { readonly dir: string } & Input<CheckoutDirConfig>;
export type CheckoutDirOptionsConfig = {
  readonly auth: HttpAuth | null;
  readonly parent: Span | null;
  readonly fetchImpl: NonNullable<ReadOptions['fetchImpl']> | null;
  readonly limits: LimitsInput;
  readonly signal: AbortSignal | null;
  readonly quirks: Quirks | null;
  readonly transport: Transport | null;
  readonly batch: number;
  readonly platform: string;
};
// `tracer` is optional, as on every entry: without one operation() drops the spans.
export type CheckoutDirOptions = Input<{ readonly tracer: Tracer } & CheckoutDirOptionsConfig>;
type CheckoutDirOptionsTotal = { readonly tracer: Option<Tracer> } & CheckoutDirOptionsConfig;
const dirDefaults = (): CheckoutDirOptionsConfig => ({
  auth: null, parent: null, fetchImpl: null, limits: DEFAULT_LIMITS, signal: null, quirks: null, transport: null, batch: CHECKOUT_BATCH, platform: processPlatform,
});
// checkoutTree still takes a partial ReadOptions. Null pass-through fields stay off that object.
function treeOpts(opts: CheckoutDirOptionsTotal): ReadOptions & { readonly batch: number } {
  const base = {
    auth: opts.auth,
    parent: opts.parent,
    limits: opts.limits,
    signal: opts.signal,
    transport: opts.transport,
    batch: opts.batch,
  };
  const traced = opts.tracer.tag === 'some' ? { ...base, tracer: opts.tracer.value } : base;
  const withFetch = opts.fetchImpl === null ? traced : { ...traced, fetchImpl: opts.fetchImpl };
  return opts.quirks === null ? withFetch : { ...withFetch, quirks: opts.quirks };
}
export async function checkoutDir(url: string, request: CheckoutDirRequest, options: CheckoutDirOptions = {}): Promise<Result<CheckoutDirResult, CheckoutDirError>> {
  const { dir } = request;
  const { ref, path } = withDefaults<CheckoutDirConfig>(request, { ref: null, path: '' });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a caller's tracer, if any: operation() checks it has start()
  const opts: CheckoutDirOptionsTotal = { ...withDefaults(options, dirDefaults()), tracer: mapOption(field(options, 'tracer'), t => t as Tracer) };
  if (typeof dir !== 'string' || dir === '') return kinded(fail('bad_request', 'dir must be a non-empty string', { what: 'dir' }).error, 'dir');
  // parsed once, for the checkout and the write
  const limits = parseLimits(opts.limits);
  if (!limits.ok) return limits;
  const ready = await emptyDir(dir);
  if (!ready.ok) return ready;
  const checked = await checkoutTree(url, { ref, path }, treeOpts({ ...opts, limits: limits.value }));
  if (!checked.ok) return checked;
  const { files, ...rest } = checked.value;
  const written = await writeFiles(dir, files, { limits: limits.value, platform: opts.platform });
  if (!written.ok) return written;
  return ok({ ...rest, written: written.value });
}
