// Node only (node:fs, node:path): push a local repository, with its history, to a smart-HTTP remote without a git
// binary. Not part of any Workers bundle.
//
//   pushRepo(dir, url, { refspecs, all, tags, force, dryRun, thin }, opts) → { upToDate, updates, current, objects, … }
//
// `dir` is a work tree (with `.git`, a directory or a `gitdir:` file) or a bare repository. What is pushed, as
// `git push <url> <refspecs>` decides it: each refspec is `src`, `src:dst`, `+src:dst` (forced) or `:dst` (delete);
// `src` is resolved as git resolves a name (`x`, `refs/x`, `refs/tags/x`, `refs/heads/x`, `refs/remotes/x`), `HEAD`
// is the current branch, and a missing `dst` is the same ref. `all` adds every branch, `tags` every tag. With none of
// these, the current branch goes to the same name (push.default=simple without an upstream).
//
// One ls-refs, then one receive-pack request for every command. The pack is what the remote lacks: everything
// reachable from the new tips minus everything reachable from the remote's refs that this repository has (gitlinks
// are not followed). Trees and blobs are delta-compressed against the previous version of the same path in the same
// pack (delta.ts planDeltas: OFS_DELTA, chains of at most 50); `thin: true` also deltas the first version of a path
// against the remote's copy (REF_DELTA). receive-pack accepts thin packs unless it was started with
// --reject-thin-pack-for-testing, and `git push` sends them by default, but ply cannot prove that for a host it has
// not seen, so it is opt-in.
//
// Refused locally, before anything is sent: a non-fast-forward update of a branch (or of a ref whose current tip this
// repository does not have: git's "fetch first"), and any change to an existing tag, unless the refspec has `+` or
// `force` is set. That is `not_fast_forward` (the code a server's own non-fast-forward refusal carries in push.ts),
// naming every refused ref; none of the other commands are sent either. Every ref already at its target: nothing is
// sent (no receive-pack request) and the result says `upToDate`. `dryRun`: the same decisions and object count, and
// no receive-pack request.
//
// Memory: every packfile is read and resolved in memory (parsePack, resolvePack; no .idx is read), so this suits
// repositories up to a few hundred MB. The resident set is bounded by limits.maxInflatedTotal (the objects held), the
// object count by limits.maxPackObjects, each object by limits.maxObjectSize, the pack sent by limits.maxPackBytes and
// the refs by limits.maxRefs: past any of them the answer is `limit_exceeded`, never a partial push. The defaults hold
// a repository of about 256 MiB of objects whose packs are each at most 128 MiB; for a larger one raise
// maxInflatedTotal, maxPackObjects and (for a single pack over 128 MiB) maxPackBytes. All of it is then held in
// memory: a repository that does not fit goes through the range-reader pipeline instead (scanPackIndex,
// resolvePackRange, planPackBatches, packSubset over a RangeSource), which holds no pack whole. A packfile is
// held whole while it is parsed, so each is bounded by limits.maxPackBytes before a byte of it is read (its size from
// the open handle; `limit_exceeded`, what: 'local pack bytes'; one exactly at the bound is read). No read call is
// asked for more than 1 GiB (READ_CHUNK), so a pack of 2 GiB or more under a raised bound is read in pieces, and one
// the runtime has no buffer for is `limit_exceeded`, what: 'local pack buffer bytes'. A packfile the file system will not give (EACCES, EIO,
// EISDIR, …) is `unsupported`, kind 'filesystem', what: 'local pack', with the path, the operation and the system's
// code in the message and the thrown error as `cause`: pushRepo never rejects with a node:fs error for a packfile.
// Not yet bounded before the read (maybeRead / maybeText read the file whole): a loose object file, packed-refs, a
// loose ref file, config, commondir, a `.git` file and HEAD. maxObjectSize bounds a loose object's inflated bytes,
// not its file, and a text file of 512 MiB or more makes pushRepo reject with node's ERR_STRING_TOO_LONG.
//
// Refused as `bad_request` with `what`: SHA-256 repositories (objectFormat), reftable (refStorage), partial clones
// (partialClone), objects/info/alternates (alternates) and shallow repositories (shallow).
/* oxlint-disable no-await-in-loop -- the walks read one object at a time from the local repository, under the bounds */
/* oxlint-disable import/max-dependencies -- an entry composes the protocol from one import per module */
import { open, readFile, readdir, lstat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
// oxlint-disable-next-line unicorn/import-style -- `path` names a tree path throughout this file
import { join, resolve } from 'node:path';
import { fail, plyError } from './errors.js';
import type { ErrorOf, PlyError } from './errors.js';
import { thrownCode } from './boundary.js';
import { LIMIT_OBJECT_OVERHEAD, limitExceeded, limitsOf, lowered } from './limits.js';
import type { CheckedLimits } from './limits.js';
import { inflate } from './inflate.js';
import { parsePack, resolvePack } from './packresolve.js';
import { hashObject, parseCommit, parseTag, TYPE, TYPE_ID } from './objects.js';
import { ZERO_OID } from './format.js';
import { lsRefs } from './lsrefs.js';
import { push } from './push.js';
import type { Command, Commands } from './push.js';
import { operation } from './operation.js';
import type { OperationOpts } from './operation.js';
import type { ReadOptions } from './read.js';
import { validatePushRef, validateRef } from './validate.js';
import { planDeltas } from './delta.js';
import type { DeltaCandidate, DeltaPlan, ThinBase } from './delta.js';
import { children, missing, popped, reachable } from './packwalk.js';
import type { Walk as PackWalk } from './packwalk.js';
import type { Span } from './otel.js';
import { decodeBytes } from './bytes.js';
import type { Input } from './absent.js';
import { at, mapGet, readKey, withDefaults } from './absent.js';
import { err, getOrElse, ok } from './result.js';
import type { Err, Option, Result } from './result.js';

const OID = /^[0-9a-f]{40}$/u;
const SYMREF = 'ref: ';
const MAX_SYMREF_DEPTH = 5;
const HEX_DIR = 2;
// a loose object's header, "<type> <size>\0", is at most this long ("commit ", 20 digits, NUL)
const HEADER_ROOM = 32;
const OID_SHOWN = 40;

// ---- the local repository: where it is, its format, its refs ----
type Repo = {
  readonly dir: string;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly refs: ReadonlyMap<string, string>;
  // HEAD's branch (refs/heads/…) when it names one, else null; HEAD's commit when it has one, else null
  readonly headRef: string | null;
  readonly head: string | null;
};

const mapOrNone = <T>(v: T | null): Option<T> => (v === null ? { tag: 'none' } : { tag: 'some', value: v });
// A file's bytes, or null when it cannot be read (absent, a directory): for the files a repository may lack.
// oxlint-disable-next-line typescript/promise-function-async -- the read's own promise, its failure mapped to null
const maybeRead = (path: string): Promise<Buffer | null> => readFile(path).then(b => b, () => null);
const maybeText = async (path: string): Promise<string | null> => { const b = await maybeRead(path); return b === null ? null : b.toString('utf8'); };
// oxlint-disable-next-line typescript/promise-function-async -- lstat's own promise, mapped to a boolean
const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);

// A file system failure as a value: `unsupported`, kind 'filesystem' (the shape checkout-node.ts gives the same class
// of failure), naming the file, the operation and the system's own code (EACCES, EISDIR, …); the thrown error is `cause`.
type FilesystemError = ErrorOf<'unsupported'> & { readonly kind: 'filesystem' };
const filesystem = (what: string, op: string, path: string, e: unknown): Err<FilesystemError> => {
  const code = thrownCode(e);
  const named = code.tag === 'some' && typeof code.value === 'string' ? code.value : 'no error code';
  return err(Object.assign(plyError('unsupported', `${what}: ${op} of ${JSON.stringify(path)} failed (${named})`, { what, path, cause: e }), { kind: 'filesystem' as const }));
};

// The most one read call is asked for (1 GiB). node's fs binding takes the length as an int32 and aborts the process
// on more (node_file.cc fs.Read: `args[3]->IsInt32()`, SIGABRT, which no caller can catch), so a file of 2 GiB or more
// under a raised limit is read in pieces.
const READ_CHUNK = 1024 * 1024 * 1024;

// One buffer of `size` bytes, or null when the runtime will not give one (a RangeError: past the largest typed array,
// or no memory for it).
const allocate = (size: number): Uint8Array | null => {
  try { return new Uint8Array(size); } catch { return null; }
};

// A local file's bytes, held to `max`: the size comes from the open handle, a file past the bound is refused before a
// byte of it is read, and no more than the size seen is read even when the file grows meanwhile (one that shrank is
// what was there). No read call is asked for more than READ_CHUNK, and a file one buffer cannot hold is
// `limit_exceeded` (what: '<what> buffer bytes'). Never rejects.
async function readBounded(path: string, max: number, what: string): Promise<Result<Uint8Array, PlyError>> {
  let op = 'open';
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, 'r');
    op = 'stat';
    const { size } = await handle.stat();
    if (size > max) return err(limitExceeded(`${what} bytes`, size, max));
    op = 'read';
    const buf = allocate(size);
    if (buf === null) return fail('limit_exceeded', `${what}: no buffer of ${size} bytes could be allocated (the file is within the limit ${max}, the process cannot hold it)`, { what: `${what} buffer bytes`, got: size, max });
    let got = 0;
    while (got < size) {
      const { bytesRead } = await handle.read(buf, got, Math.min(size - got, READ_CHUNK), got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return ok(buf.subarray(0, got));
  } catch (e) {
    return filesystem(what, op, path, e);
  } finally {
    if (handle !== null) await handle.close().then(() => null, () => null);
  }
}

// The git directory of a work tree (`.git`, a directory or a `gitdir:` file) or a bare repository; null for neither.
async function findGitDir(dir: string): Promise<string | null> {
  const dot = join(dir, '.git');
  const st = await lstat(dot).then(s => s, () => null);
  if (st !== null && st.isDirectory()) return dot;
  if (st !== null && st.isFile()) {
    const text = await maybeText(dot);
    const m = text === null ? null : /^gitdir: (.+)$/mu.exec(text);
    return m === null ? null : resolve(dir, getOrElse(at(m, 1), ''));
  }
  return (await exists(join(dir, 'HEAD'))) && (await exists(join(dir, 'objects'))) && (await exists(join(dir, 'refs'))) ? dir : null;
}

// git config as `section.key` → value (the last one wins), enough to read the format extensions. Subsections are kept
// in the section name; keys and section names are case-insensitive.
export function readConfig(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[#;].*$/u, '').trim();
    const head = /^\[([^\]\s"]+)(\s+"([^"]*)")?\]$/u.exec(line);
    if (head !== null) {
      const sub = at(head, 3);
      section = sub.tag === 'some' ? `${getOrElse(at(head, 1), '').toLowerCase()}.${sub.value}` : getOrElse(at(head, 1), '').toLowerCase();
      continue;
    }
    const kv = /^([A-Za-z][\w-]*)\s*(=\s*(.*))?$/u.exec(line);
    if (kv !== null && section !== '') out.set(`${section}.${getOrElse(at(kv, 1), '').toLowerCase()}`, getOrElse(at(kv, 3), 'true').trim());
  }
  return out;
}

// Why ply will not push from this repository, or null: the format extensions and layouts it does not read.
async function unsupported(commonDir: string): Promise<{ readonly what: string; readonly why: string } | null> {
  const config = readConfig(getOrElse<string>(mapOrNone(await maybeText(join(commonDir, 'config'))), ''));
  const format = getOrElse(mapGet(config, 'extensions.objectformat'), 'sha1').toLowerCase();
  if (format !== 'sha1') return { what: 'objectFormat', why: `object format ${format} (ply reads SHA-1 repositories only)` };
  const refStorage = getOrElse(mapGet(config, 'extensions.refstorage'), 'files').toLowerCase();
  if (refStorage !== 'files') return { what: 'refStorage', why: `ref storage ${refStorage} (ply reads loose and packed refs only)` };
  if (config.has('extensions.partialclone')) return { what: 'partialClone', why: 'a partial clone (objects may be missing locally)' };
  if (await exists(join(commonDir, 'objects', 'info', 'alternates'))) return { what: 'alternates', why: 'objects/info/alternates (objects stored in another repository)' };
  if (await exists(join(commonDir, 'shallow'))) return { what: 'shallow', why: 'a shallow repository (history is cut off)' };
  return null;
}

// A ref's value to its id through at most five symbolic hops: the id, 'dangling' for a symbolic ref that ends nowhere
// (git keeps one, as refs/remotes/origin/HEAD after its branch is gone), or null for a value that is neither.
const followRef = (raw: ReadonlyMap<string, string>, value: string): string | null => {
  let v = value;
  for (let i = 0; i <= MAX_SYMREF_DEPTH; i++) {
    if (OID.test(v)) return v;
    if (!v.startsWith(SYMREF)) return i === 0 ? null : 'dangling';
    v = getOrElse(mapGet(raw, v.slice(SYMREF.length).trim()), '');
  }
  return 'dangling';
};

// Every ref: packed-refs, then loose refs over them (a loose ref is newer). A symbolic ref is followed (refs/remotes/
// origin/HEAD) and left out when it ends nowhere; a value that is neither an id nor `ref: <name>` is refused.
async function readRefs(commonDir: string, maxRefs: number): Promise<Result<Map<string, string>, PlyError>> {
  const raw = new Map<string, string>();
  const packed = getOrElse<string>(mapOrNone(await maybeText(join(commonDir, 'packed-refs'))), '');
  for (const line of packed.split('\n')) {
    const m = /^([0-9a-f]{40}) (refs\/\S+)$/u.exec(line);
    if (m !== null) raw.set(getOrElse(at(m, 2), ''), getOrElse(at(m, 1), ''));
  }
  const walk = async (rel: string): Promise<null> => {
    const entries = await readdir(join(commonDir, rel), { withFileTypes: true }).then(e => e, () => []);
    for (const e of entries.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
      // git looks at no entry, file or directory, whose name starts with '.' or ends in '.lock' (refs/files-backend.c
      // loose_fill_ref_dir), and its ref iteration leaves out a file whose full name check-ref-format refuses: such a
      // file (Finder's .DS_Store, an editor's backup) is not a ref, whatever it holds
      if (e.name.startsWith('.') || e.name.endsWith('.lock')) continue;
      const name = `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(name);
      else if (e.isFile() && validateRef(name).ok) raw.set(name, getOrElse<string>(mapOrNone(await maybeText(join(commonDir, name))), '').trim());
      if (raw.size > maxRefs) return null;
    }
    return null;
  };
  await walk('refs');
  if (raw.size > maxRefs) return err(limitExceeded('local refs', raw.size, maxRefs));
  const refs = new Map<string, string>();
  for (const [name, value] of raw) {
    const oid = followRef(raw, value);
    if (oid === 'dangling') continue;
    if (oid === null) return fail('bad_request', `${name}: not an object id or a symbolic ref to one (${value.slice(0, OID_SHOWN)})`, { what: 'ref', path: name });
    refs.set(name, oid);
  }
  return ok(refs);
}

async function openRepo(dir: string, limits: CheckedLimits): Promise<Result<Repo, PlyError>> {
  const gitDir = typeof dir === 'string' && dir !== '' ? await findGitDir(dir) : null;
  if (gitDir === null) return fail('bad_request', `${typeof dir === 'string' ? dir : '(not a string)'}: not a git repository (no .git, and not a bare repository)`, { what: 'dir' });
  const common = await maybeText(join(gitDir, 'commondir'));
  const commonDir = common === null ? gitDir : resolve(gitDir, common.trim());
  const refused = await unsupported(commonDir);
  if (refused !== null) return fail('bad_request', `${dir}: ${refused.why}`, { what: refused.what });
  const refs = await readRefs(commonDir, limits.maxRefs);
  if (!refs.ok) return refs;
  const headText = getOrElse<string>(mapOrNone(await maybeText(join(gitDir, 'HEAD'))), '').trim();
  const headRef = headText.startsWith(`${SYMREF}refs/heads/`) ? headText.slice(SYMREF.length).trim() : null;
  const head = OID.test(headText) ? headText : getOrElse<string | null>(mapGet(refs.value, getOrElse<string>(mapOrNone(headRef), '')), null);
  return ok({ dir, gitDir, commonDir, refs: refs.value, headRef, head });
}

// ---- the object store: every pack resolved in memory, loose objects read as asked ----
type Obj = { readonly type: number; readonly data: Uint8Array };
type Store = {
  readonly get: (oid: string) => Promise<Result<Obj | null, PlyError>>;
  readonly stats: { packs: number; packed: number; loose: number; resident: number };
};
const TYPE_IDS: Readonly<Record<string, number>> = TYPE_ID;

async function openStore(repo: Repo, limits: CheckedLimits): Promise<Result<Store, PlyError>> {
  const { maxInflatedTotal: maxTotal, maxPackObjects: maxObjects, maxObjectSize: maxObject } = limits;
  const objectsDir = join(repo.commonDir, 'objects');
  const held = new Map<string, Obj>();
  const stats = { packs: 0, packed: 0, loose: 0, resident: 0 };
  // resident: the bytes held; charged: those plus LIMIT_OBJECT_OVERHEAD per object, what maxInflatedTotal bounds (#142)
  let charged = 0;
  const hold = (oid: string, o: Obj): Result<null, PlyError> => {
    if (held.has(oid)) return ok(null);
    held.set(oid, o);
    stats.resident += o.data.length;
    charged += o.data.length + LIMIT_OBJECT_OVERHEAD;
    if (charged > maxTotal) return err(limitExceeded('local objects bytes', charged, maxTotal));
    if (held.size > maxObjects) return err(limitExceeded('local objects', held.size, maxObjects));
    return ok(null);
  };
  const packDir = join(objectsDir, 'pack');
  const packs = (await readdir(packDir).then(n => n, () => [])).filter(n => n.endsWith('.pack')).toSorted();
  for (const name of packs) {
    const read = await readBounded(join(packDir, name), limits.maxPackBytes, 'local pack');
    if (!read.ok) return read;
    const buf = read.value;
    // the room the packs and objects held so far leave: a pack that would pass the bound fails while it is parsed
    const room = lowered(lowered(limits, 'maxInflatedTotal', maxTotal - charged), 'maxPackObjects', maxObjects - held.size);
    const parsed = parsePack(buf, { limits: room });
    if (!parsed.ok) return parsed;
    const resolved = resolvePack(parsed.value, () => null, room);
    if (!resolved.ok) return resolved;
    stats.packs++;
    for (const [oid, o] of resolved.value.objects) {
      const h = hold(oid, { type: o.type, data: o.data });
      if (!h.ok) return h;
      stats.packed++;
    }
  }
  const get = async (oid: string): Promise<Result<Obj | null, PlyError>> => {
    const hit = mapGet(held, oid);
    if (hit.tag === 'some') return ok(hit.value);
    const buf = await maybeRead(join(objectsDir, oid.slice(0, HEX_DIR), oid.slice(HEX_DIR)));
    if (buf === null) return ok(null);
    const z = inflate(buf, 0, { maxOutput: maxObject + HEADER_ROOM });
    if (!z.ok) return z;
    const out = z.value.out;
    const nul = out.indexOf(0);
    const header = /^(commit|tree|blob|tag) (\d+)$/u.exec(decodeBytes(out.subarray(0, Math.max(0, nul))));
    const type = header === null ? null : getOrElse(readKey(TYPE_IDS, getOrElse(at(header, 1), '')), null);
    const data = out.subarray(nul + 1);
    if (header === null || type === null || Number(header[2]) !== data.length || hashObject(getOrElse(at(header, 1), ''), data) !== oid) return fail('pack_corrupt', `loose object ${oid}: bad header or hash`, { what: 'object', path: oid });
    if (data.length > maxObject) return err(limitExceeded('object size', data.length, maxObject));
    const o = { type, data };
    const h = hold(oid, o);
    if (!h.ok) return h;
    stats.loose++;
    return ok(o);
  };
  return ok({ get, stats });
}

// ---- refspecs → commands ----
export type PushRepoConfig = {
  // git refspecs: `src`, `src:dst`, `+src:dst`, `:dst`. null: the current branch (unless all or tags)
  readonly refspecs: readonly string[] | null;
  readonly all: boolean;
  readonly tags: boolean;
  readonly force: boolean;
  readonly dryRun: boolean;
  readonly thin: boolean;
};
export type PushRepoSpec = Input<PushRepoConfig>;
export type PushRepoOptions = ReadOptions;
export type RefUpdate = { readonly ref: string; readonly oldOid: string; readonly newOid: string; readonly kind: 'create' | 'update' | 'force' | 'delete' };
export type PushRepoResult = {
  // nothing to send: every ref named is already where the local repository has it (no receive-pack request)
  readonly upToDate: boolean;
  readonly dryRun: boolean;
  readonly updates: readonly RefUpdate[];
  // refs already at their target, left out of the push
  readonly current: readonly string[];
  // objects in the pack, of which deltas against an object in the pack (ofs) and against the remote's (thin)
  readonly objects: number;
  readonly deltas: number;
  readonly thinDeltas: number;
  // object bytes before deltas and zlib, and the pack sent (0 on a dry run or a delete-only push)
  readonly rawBytes: number;
  readonly packBytes: number;
};

// One wanted command: the ref, the local id (null: delete), forced or not, and the name it came from.
type Wanted = { readonly dst: string; readonly src: string | null; readonly force: boolean; readonly from: string };
const RULES = ['', 'refs/', 'refs/tags/', 'refs/heads/', 'refs/remotes/'];
// git's ref_rev_parse_rules over the local refs: every full name the short one can mean that exists.
const localMatches = (repo: Repo, name: string): string[] => {
  const found = RULES.map(p => `${p}${name}`).filter(n => n.startsWith('refs/') && repo.refs.has(n));
  if (repo.refs.has(`refs/remotes/${name}/HEAD`)) found.push(`refs/remotes/${name}/HEAD`);
  return found;
};

type RemoteRefs = ReadonlyMap<string, string>;
// A destination on the remote: a full name it has, or the one branch or tag a short name means; null for none (or two).
const dstOnRemote = (remote: RemoteRefs, name: string): string | null => {
  if (name.startsWith('refs/')) return remote.has(name) ? name : null;
  const found = ['refs/heads/', 'refs/tags/'].map(p => `${p}${name}`).filter(n => remote.has(n));
  return found.length === 1 ? getOrElse(at(found, 0), null) : null;
};
// The local side of a refspec: HEAD, the one ref a name means, or a 40-hex id; a string says why it is none of those.
function resolveSrc(repo: Repo, srcName: string): { readonly src: string; readonly srcRef: string | null } | string {
  if (srcName === 'HEAD') return repo.head === null ? 'HEAD has no commit' : { src: repo.head, srcRef: repo.headRef };
  const matches = localMatches(repo, srcName);
  if (matches.length > 1) return `src matches more than one ref (${matches.join(', ')})`;
  const one = at(matches, 0);
  if (one.tag === 'some') return { src: getOrElse(mapGet(repo.refs, one.value), ''), srcRef: one.value };
  return OID.test(srcName) ? { src: srcName, srcRef: null } : `src ${srcName} does not match any local ref`;
}

// `:dst`: the remote ref to delete, which must exist (git: "remote ref does not exist").
function deletion(remote: RemoteRefs, spec: string, name: string, force: boolean): Result<Wanted, PlyError> {
  const dst = dstOnRemote(remote, name);
  if (dst === null) return fail('not_found', `refspec ${spec}: the remote has no ref ${name} to delete`, { miss: { kind: 'ref', ref: name, candidates: [] } });
  return ok({ dst, src: null, force, from: spec });
}

// One refspec as git's match_explicit_refs reads it (the src side in the local repository, the dst side on the remote).
function resolveRefspec(repo: Repo, remote: RemoteRefs, spec: string, forceAll: boolean): Result<Wanted, PlyError> {
  const forced = spec.startsWith('+');
  const body = forced ? spec.slice(1) : spec;
  const colon = body.indexOf(':');
  const srcName = colon < 0 ? body : body.slice(0, colon);
  const dstName = colon < 0 ? null : body.slice(colon + 1);
  const bad = (why: string): Result<never, PlyError> => fail('bad_request', `refspec ${spec}: ${why}`, { what: 'refspec', got: spec });
  if (body === '' || body.includes(':', colon + 1) || dstName === '' || /\s/u.test(body)) return bad('not src, src:dst, +src:dst or :dst');
  const force = forced || forceAll;
  if (srcName === '') return deletion(remote, spec, getOrElse<string>(mapOrNone(dstName), ''), force);
  const source = resolveSrc(repo, srcName);
  if (typeof source === 'string') return bad(source);
  const { src, srcRef } = source;
  if (dstName === null) {
    if (srcRef === null) return bad('a commit id or a detached HEAD needs a destination (src:refs/heads/…)');
    return ok({ dst: srcRef, src, force, from: spec });
  }
  if (dstName.startsWith('refs/')) return ok({ dst: dstName, src, force, from: spec });
  const onRemote = dstOnRemote(remote, dstName);
  if (onRemote !== null) return ok({ dst: onRemote, src, force, from: spec });
  // a new short name takes the kind of its source, as git's "the destination you provided is not a full refname" allows
  const kind = srcRef !== null && srcRef.startsWith('refs/tags/') ? 'refs/tags/' : 'refs/heads/';
  if (srcRef === null || !(srcRef.startsWith('refs/heads/') || srcRef.startsWith('refs/tags/'))) return bad(`destination ${dstName} is not a full refname and names no remote ref`);
  return ok({ dst: `${kind}${dstName}`, src, force, from: spec });
}

// The commands the spec asks for, before any of them is compared with the remote.
function wantedRefs(repo: Repo, remote: RemoteRefs, cfg: PushRepoConfig): Result<Wanted[], PlyError> {
  const specs: string[] = [...(cfg.refspecs === null ? [] : cfg.refspecs)];
  for (const [name] of repo.refs) if ((cfg.all && name.startsWith('refs/heads/')) || (cfg.tags && name.startsWith('refs/tags/'))) specs.push(name);
  if (cfg.refspecs === null && !cfg.all && !cfg.tags) {
    if (repo.headRef === null || repo.head === null) return fail('bad_request', `${repo.dir}: HEAD is not a branch with a commit; name what to push (refspecs, all or tags)`, { what: 'refspecs' });
    specs.push(repo.headRef);
  }
  const out = new Map<string, Wanted>();
  for (const s of specs) {
    const w = resolveRefspec(repo, remote, s, cfg.force);
    if (!w.ok) return w;
    const prev = mapGet(out, w.value.dst);
    if (prev.tag === 'some' && prev.value.src !== w.value.src) return fail('bad_request', `${w.value.dst} is the destination of two refspecs (${prev.value.from}, ${w.value.from})`, { what: 'refspec', got: w.value.from });
    out.set(w.value.dst, { ...w.value, force: w.value.force || (prev.tag === 'some' && prev.value.force) });
  }
  return ok([...out.values()]);
}

// ---- the walks ----
type Walk = PackWalk;

// Is `old` an ancestor of (or equal to) `tip`? Both peeled to commits; false when either is not one the local
// repository has.
async function descends(w: Walk, tip: string, old: string): Promise<Result<boolean, PlyError>> {
  const peel = async (oid: string): Promise<Result<string | null, PlyError>> => {
    let at0 = oid;
    for (let i = 0; i <= MAX_SYMREF_DEPTH; i++) {
      const got = await w.store.get(at0);
      if (!got.ok) return got;
      if (got.value === null) return ok(null);
      if (got.value.type === TYPE.COMMIT) return ok(at0);
      if (got.value.type !== TYPE.TAG) return ok(null);
      const t = parseTag(got.value.data);
      if (!t.ok) return t;
      at0 = t.value.object;
    }
    return ok(null);
  };
  const from = await peel(tip);
  if (!from.ok) return from;
  const target = await peel(old);
  if (!target.ok) return target;
  if (from.value === null || target.value === null) return ok(false);
  const seen = new Set<string>();
  const stack = [from.value];
  for (let next = popped(stack); next.tag === 'some'; next = popped(stack)) {
    const oid = next.value;
    if (oid === target.value) return ok(true);
    if (seen.has(oid)) continue;
    seen.add(oid);
    const got = await w.store.get(oid);
    if (!got.ok) return got;
    if (got.value === null) continue;
    const c = parseCommit(got.value.data, w.limits);
    if (!c.ok) return c;
    stack.push(...c.value.parents);
  }
  return ok(false);
}

// The remote's object at each path of its tips' trees, for thin deltas: `${type} ${path}` → id. The first tip (in ref
// name order) that has a path wins.
async function remotePaths(w: Walk, tips: readonly string[]): Promise<Result<Map<string, string>, PlyError>> {
  const out = new Map<string, string>();
  const trees = new Set<string>();
  const visit = async (oid: string, path: string): Promise<Result<null, PlyError>> => {
    if (trees.has(oid)) return ok(null);
    trees.add(oid);
    const got = await w.store.get(oid);
    if (!got.ok) return got;
    if (got.value === null || got.value.type !== TYPE.TREE) return ok(null);
    const kids = children(got.value, w.limits);
    if (!kids.ok) return kids;
    for (const k of kids.value) {
      const p = path === '' ? k.name : `${path}/${k.name}`;
      const key = `${k.type} ${p}`;
      if (!out.has(key)) out.set(key, k.oid);
      if (k.type === TYPE.TREE) { const r = await visit(k.oid, p); if (!r.ok) return r; }
    }
    return ok(null);
  };
  for (const tip of tips) {
    const got = await w.store.get(tip);
    if (!got.ok) return got;
    if (got.value === null || got.value.type !== TYPE.COMMIT) continue;
    const c = parseCommit(got.value.data, w.limits);
    if (!c.ok) return c;
    if (!out.has(`${TYPE.TREE} `)) out.set(`${TYPE.TREE} `, c.value.tree);
    const r = await visit(c.value.tree, '');
    if (!r.ok) return r;
  }
  return ok(out);
}

// ---- the entry ----
// The store of a delete-only push: it has no object (and no change asks it for one).
// oxlint-disable-next-line typescript/promise-function-async -- a settled answer, no work to await
const NO_OBJECTS: Store = { get: () => Promise.resolve(ok(null)), stats: { packs: 0, packed: 0, loose: 0, resident: 0 } };
// git's words for a refused update: a tag that exists, a tip this repository does not have, or a non-fast-forward.
const refusal = (ref: string, haveOld: boolean): string => {
  if (ref.startsWith('refs/tags/')) return 'already exists';
  return haveOld ? 'non-fast-forward' : 'fetch first';
};
// Each change against the remote's tip: a create, a delete, a fast-forward, a forced update, or refused (every refused
// ref is named in one not_fast_forward, and nothing is sent).
async function decideUpdates(w: Walk, changes: readonly Wanted[], remote: RemoteRefs): Promise<Result<RefUpdate[], PlyError>> {
  const updates: RefUpdate[] = [];
  const refused: string[] = [];
  for (const c of changes) {
    const old = getOrElse<string | null>(mapGet(remote, c.dst), null);
    if (c.src === null) { updates.push({ ref: c.dst, oldOid: getOrElse<string>(mapOrNone(old), ZERO_OID), newOid: ZERO_OID, kind: 'delete' }); continue; }
    if (old === null) { updates.push({ ref: c.dst, oldOid: ZERO_OID, newOid: c.src, kind: 'create' }); continue; }
    const ff = c.dst.startsWith('refs/tags/') ? ok(false) : await descends(w, c.src, old);
    if (!ff.ok) return ff;
    if (ff.value || c.force) { updates.push({ ref: c.dst, oldOid: old, newOid: c.src, kind: ff.value ? 'update' : 'force' }); continue; }
    const had = await w.store.get(old);
    if (!had.ok) return had;
    refused.push(`${c.dst} (${refusal(c.dst, had.value !== null)})`);
  }
  if (refused.length > 0) return fail('not_fast_forward', `push refused before sending: ${refused.join(', ')}; pull or use + / force`, { what: 'ref', got: refused });
  return ok(updates);
}

// The thin bases: for each path's first object in the pack, the remote's object at that path (its tips' trees).
async function thinBases(w: Walk, remote: RemoteRefs, objects: readonly DeltaCandidate[]): Promise<Result<Map<string, ThinBase>, PlyError>> {
  const thin = new Map<string, ThinBase>();
  const paths = await remotePaths(w, [...remote.entries()].toSorted(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v));
  if (!paths.ok) return paths;
  for (const o of objects) {
    if (o.path === null) continue;
    const key = `${o.type} ${o.path}`;
    const base = mapGet(paths.value, key);
    if (base.tag === 'none' || thin.has(key)) continue;
    const got = await w.store.get(base.value);
    if (!got.ok) return got;
    if (got.value !== null) thin.set(key, { oid: base.value, data: got.value.data });
  }
  return ok(thin);
}

// What to send: the objects the remote lacks, delta-planned. Every one was read through the store, so maxPackObjects
// and maxInflatedTotal already bound them.
type PlanInput = { readonly thin: boolean; readonly remote: RemoteRefs; readonly updates: readonly RefUpdate[] };
async function planPack(w: Walk, span: Span, { thin, remote, updates }: PlanInput): Promise<Result<DeltaPlan, PlyError>> {
  const tips = updates.filter(u => u.kind !== 'delete').map(u => u.newOid);
  // deletes only: no pack, and nothing to walk
  const have = tips.length === 0 ? ok(new Set<string>()) : await reachable(w, [...new Set(remote.values())]);
  if (!have.ok) return have;
  const objects = await missing(w, tips, have.value);
  if (!objects.ok) return objects;
  const bases = thin ? await thinBases(w, remote, objects.value) : ok(new Map<string, ThinBase>());
  if (!bases.ok) return bases;
  const plan = planDeltas(objects.value, { thinBase: thin ? (type, path) => getOrElse(mapGet(bases.value, `${type} ${path}`), null) : null });
  span.set({ 'git.push_repo.plan.have': have.value.size, 'git.push_repo.plan.objects': plan.objects.length, 'git.push_repo.plan.ofs': plan.ofs, 'git.push_repo.plan.ref': plan.ref, 'git.push_repo.plan.raw.bytes': plan.rawBytes, 'git.push_repo.plan.delta.bytes': plan.plannedBytes });
  return ok(plan);
}

const pushRepoDefaults = (): PushRepoConfig => ({ refspecs: null, all: false, tags: false, force: false, dryRun: false, thin: false });
const isBool = (v: unknown): boolean => typeof v === 'boolean';

// A child span of the operation's root, ended with the body's Result.
async function step<T>(root: Span, name: string, body: (span: Span) => Promise<Result<T, PlyError>>): Promise<Result<T, PlyError>> {
  const span = root.tracer.start(name, { parent: root });
  const r = await body(span);
  if (!r.ok) span.error(r.error, r.error.code);
  span.end();
  return r;
}

export async function pushRepo(dir: string, url: string, spec: PushRepoSpec = {}, options: PushRepoOptions = {}): Promise<Result<PushRepoResult, PlyError>> {
  const cfg = withDefaults<PushRepoConfig>(spec, pushRepoDefaults());
  const { refspecs } = cfg;
  if ((refspecs !== null && !(Array.isArray(refspecs) && refspecs.every(s => typeof s === 'string'))) || ![cfg.all, cfg.tags, cfg.force, cfg.dryRun, cfg.thin].every(v => isBool(v)) || (cfg.all && refspecs !== null)) {
    return fail('bad_request', 'pushRepo: refspecs is a list of strings, all/tags/force/dryRun/thin are booleans, and all takes no refspecs', { what: 'spec' });
  }
  const checked = limitsOf(options);
  if (!checked.ok) return checked;
  const limits = checked.value;
  const repo = await openRepo(dir, limits);
  if (!repo.ok) return repo;
  const r = repo.value;
  const opOpts: OperationOpts = { ...options, limits, attrs: { 'git.push_repo.dir': r.dir, 'git.push_repo.dry_run': cfg.dryRun, 'git.push_repo.thin': cfg.thin, 'git.push_repo.local_refs': r.refs.size } };
  return operation('push_repo', url, opOpts, async ({ t, root, outcome }) => {
    const listed = await lsRefs(t, []);
    if (!listed.ok) return listed;
    const remote = new Map<string, string>();
    for (const [name, ref] of listed.value.refs) if (name.startsWith('refs/')) remote.set(name, ref.oid);
    const wanted = wantedRefs(r, remote, cfg);
    if (!wanted.ok) return wanted;
    const current: string[] = [];
    const changes: Wanted[] = [];
    for (const want of wanted.value) {
      const named = validatePushRef(want.dst, want.src === null);
      if (!named.ok) return named;
      if (want.src !== null && getOrElse<string | null>(mapGet(remote, want.dst), null) === want.src) current.push(want.dst);
      else changes.push(want);
    }
    root.set({ 'git.push_repo.remote_refs': remote.size, 'git.push_repo.refs.current': current.length, 'git.push_repo.refs.changed': changes.length });
    const done = (upToDate: boolean, updates: readonly RefUpdate[], counts: { readonly objects: number; readonly deltas: number; readonly thinDeltas: number; readonly rawBytes: number; readonly packBytes: number }, kind: string): Result<PushRepoResult, PlyError> =>
      outcome(kind, { upToDate, dryRun: cfg.dryRun, updates, current, ...counts }, { 'git.push_repo.objects': counts.objects, 'git.push_repo.deltas': counts.deltas + counts.thinDeltas, 'git.push_repo.pack.bytes': counts.packBytes });
    const none = { objects: 0, deltas: 0, thinDeltas: 0, rawBytes: 0, packBytes: 0 };
    if (changes.length === 0) return done(true, [], none, 'up_to_date');
    // a delete-only push reads no objects
    const store = changes.every(c => c.src === null) ? ok(NO_OBJECTS) : await step(root, 'git.push_repo.read', async span => {
      const s = await openStore(r, limits);
      if (s.ok) span.set({ 'git.push_repo.read.packs': s.value.stats.packs, 'git.push_repo.read.objects': s.value.stats.packed, 'git.push_repo.read.bytes': s.value.stats.resident });
      return s;
    });
    if (!store.ok) return store;
    const w: Walk = { store: store.value, limits, source: 'the local repository' };
    const updates = await decideUpdates(w, changes, remote);
    if (!updates.ok) return updates;
    const planned = await step(root, 'git.push_repo.plan', async span => { const p = await planPack(w, span, { thin: cfg.thin, remote, updates: updates.value }); return p; });
    if (!planned.ok) return planned;
    const plan = planned.value;
    const counts = { objects: plan.objects.length, deltas: plan.ofs, thinDeltas: plan.ref, rawBytes: plan.rawBytes, packBytes: 0 };
    if (cfg.dryRun) return done(false, updates.value, counts, 'dry_run');
    const cmds = updates.value.map((u): Command => ({ ref: u.ref, oldOid: u.oldOid, newOid: u.newOid }));
    const first = at(cmds, 0);
    if (first.tag === 'none') return done(true, [], none, 'up_to_date');
    const commands: Commands = [first.value, ...cmds.slice(1)];
    const pushed = await push(t, { commands, objects: plan.objects });
    if (!pushed.ok) return pushed;
    return done(false, updates.value, { ...counts, packBytes: pushed.value.packBytes }, 'pushed');
  });
}

