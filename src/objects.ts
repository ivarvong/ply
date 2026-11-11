// Git object encoding/decoding. All pure. Every function that can refuse returns a Result.
import { fail } from './errors.js';
import type { Err, Ok, Option, Result } from './result.js';
import { ok, err, none, some, assertNever } from './result.js';
import type { ErrorOf } from './errors.js';
import { Sha1, toOid, fromHex } from './sha1.js';
import { parseOid, type Oid } from './oid.js';
import { te, shortRead, decodeBytes, encodeBytes } from './bytes.js';
import { isDotGitName, isDotFileName, isValidatedIdent, validateRef } from './validate.js';
import type { ValidatedIdent } from './validate.js';
import { DEFAULT_LIMITS, limitError, parseLimits } from './limits.js';
import type { LimitsInput } from './limits.js';
import { atOr, type Input } from './absent.js';
import type { ObjType, ObjectTypeName, PackKind } from './format.js';
import {
  OID_BYTES, OID_HEX_CHARS, TREE_MODE_SEP, TREE_NUL, MODE_TREE, MODE_BLOB, MODE_EXEC, MODE_LINK, MODE_COMMIT, IDENT_TZ_DIGITS, IDENT_TIMESTAMP_MAX,
  MODE_S_IFREG, MODE_S_IFLNK, MODE_OWNER_EXEC, TREE_MAX_NAME_BYTES,
  MODE_S_IFMT, MODE_S_IFDIR, MODE_BITS, MODE_LOW_DIGITS, TREE_SORT_SLASH, TREE_ENTRY_MIN,
  OBJ_COMMIT, OBJ_TREE, OBJ_BLOB, OBJ_TAG, OBJ_OFS_DELTA, OBJ_REF_DELTA,
  COMMIT_HEADER_TREE, COMMIT_HEADER_PARENT, COMMIT_HEADER_AUTHOR, COMMIT_HEADER_COMMITTER, COMMIT_HEADER_ENCODING,
  TAG_HEADER_OBJECT, TAG_HEADER_TYPE, TAG_HEADER_TAG, TAG_HEADER_TAGGER,
} from './format.js';

export type { ObjType };

export const TYPE: {
  readonly COMMIT: typeof OBJ_COMMIT; readonly TREE: typeof OBJ_TREE; readonly BLOB: typeof OBJ_BLOB; readonly TAG: typeof OBJ_TAG;
  readonly OFS_DELTA: typeof OBJ_OFS_DELTA; readonly REF_DELTA: typeof OBJ_REF_DELTA;
} = Object.freeze({ COMMIT: OBJ_COMMIT, TREE: OBJ_TREE, BLOB: OBJ_BLOB, TAG: OBJ_TAG, OFS_DELTA: OBJ_OFS_DELTA, REF_DELTA: OBJ_REF_DELTA });
export const TYPE_NAME: {
  readonly [OBJ_COMMIT]: 'commit'; readonly [OBJ_TREE]: 'tree'; readonly [OBJ_BLOB]: 'blob'; readonly [OBJ_TAG]: 'tag';
  readonly [OBJ_OFS_DELTA]: 'ofs_delta'; readonly [OBJ_REF_DELTA]: 'ref_delta';
} = Object.freeze({ [OBJ_COMMIT]: 'commit', [OBJ_TREE]: 'tree', [OBJ_BLOB]: 'blob', [OBJ_TAG]: 'tag', [OBJ_OFS_DELTA]: 'ofs_delta', [OBJ_REF_DELTA]: 'ref_delta' });
export const TYPE_ID: {
  readonly commit: typeof OBJ_COMMIT; readonly tree: typeof OBJ_TREE; readonly blob: typeof OBJ_BLOB; readonly tag: typeof OBJ_TAG;
} = Object.freeze({ commit: OBJ_COMMIT, tree: OBJ_TREE, blob: OBJ_BLOB, tag: OBJ_TAG });

export function nameOfTypeId(type: ObjType): PackKind {
  switch (type) {
    case OBJ_COMMIT: return 'commit';
    case OBJ_TREE: return 'tree';
    case OBJ_BLOB: return 'blob';
    case OBJ_TAG: return 'tag';
    case OBJ_OFS_DELTA: return 'ofs_delta';
    case OBJ_REF_DELTA: return 'ref_delta';
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(type);
}

// A type id git writes, or invalid (0, 5, and anything else a pack header can carry).
type WireType = { readonly tag: 'named'; readonly name: PackKind } | { readonly tag: 'invalid' };
function wireTypeId(type: number): WireType {
  switch (type) {
    case OBJ_COMMIT:
    case OBJ_TREE:
    case OBJ_BLOB:
    case OBJ_TAG:
    case OBJ_OFS_DELTA:
    case OBJ_REF_DELTA:
      return { tag: 'named', name: nameOfTypeId(type) };
    default:
      return { tag: 'invalid' };
  }
}
function wireTypeName(typeName: string): WireType {
  switch (typeName) {
    case 'commit':
    case 'tree':
    case 'blob':
    case 'tag':
    case 'ofs_delta':
    case 'ref_delta':
      return { tag: 'named', name: typeName };
    default:
      return { tag: 'invalid' };
  }
}

/** What a wire type id is, for a caller that only stores a tree, blob, or tag as `not_commit`. */
export type NonCommit =
  | { readonly tag: 'notCommit'; readonly name: Exclude<ObjectTypeName, 'commit'> }
  | { readonly tag: 'commit' }
  | { readonly tag: 'delta'; readonly name: Exclude<PackKind, ObjectTypeName> }
  | { readonly tag: 'invalid' };

function nonCommitName(name: PackKind): NonCommit {
  switch (name) {
    case 'tree':
    case 'blob':
    case 'tag':
      return { tag: 'notCommit', name };
    case 'commit':
      return { tag: 'commit' };
    case 'ofs_delta':
    case 'ref_delta':
      return { tag: 'delta', name };
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(name);
}

// A pack type id. `notCommit` is a tree, blob, or tag. A commit, a delta, or an unknown id is its own variant.
export function nonCommitType(type: number): NonCommit {
  const found = wireTypeId(type);
  switch (found.tag) {
    case 'invalid': return { tag: 'invalid' };
    case 'named': return nonCommitName(found.name);
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(found);
}

export const objectHeader = (typeName: string, len: number): Uint8Array => te.encode(`${typeName} ${len}\0`);

export function hashObject(typeName: string, data: Uint8Array): Oid {
  return new Sha1().update(objectHeader(typeName, data.length)).update(data).hex();
}

const cmpBytes = (a: Uint8Array, b: Uint8Array): number => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- i < n, the shorter length: both reads are in range (`as`, not the `!` src/ forbids)
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  }
  return a.length - b.length;
};

// ---- tree ----
// fsck.c verify_ordered sorts an entry as a directory when S_ISDIR holds for the low 16 bits of its mode: `40755` sorts
// as a directory (fsck only warns about the mode), `160000` as a file.
const lowBits = (mode: string): number => Number.parseInt(mode.slice(-MODE_LOW_DIGITS), 8) & MODE_BITS;
// object.h canon_mode on the low 16 bits (tree-walk keeps the mode in a uint16_t): every reader of a tree but fsck sees
// this. A regular file is 100755 if the owner may execute it, else 100644 (100664 → 100644, 100700 → 100755); S_IFLNK is
// a symlink, S_IFDIR a tree (40755 → 40000); every other type is a gitlink (1, 160644, 777777 → 160000). `7100644`
// and `300644` are 100644 to git, without even a badFilemode warning.
export type Mode = typeof MODE_BLOB | typeof MODE_EXEC | typeof MODE_LINK | typeof MODE_TREE | typeof MODE_COMMIT;
// canon_mode of a mode's low 16 bits
function canonBits(m: number): Mode {
  const type = m & MODE_S_IFMT;
  if (type === MODE_S_IFREG) return m & MODE_OWNER_EXEC ? MODE_EXEC : MODE_BLOB;
  if (type === MODE_S_IFLNK) return MODE_LINK;
  if (type === MODE_S_IFDIR) return MODE_TREE;
  return MODE_COMMIT;
}
export function canonMode(mode: string): Mode {
  return canonBits(lowBits(mode));
}
// The tree order of fsck verify_ordered on two names, a directory's read as if it ended in `/`, without building that
// key (#207): the sign of cmpBytes(a + '/'?, b + '/'?).
/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- i < a.length, i < b.length: both reads are in range (`as`, not the `!` src/ forbids) */
// oxlint-disable-next-line eslint/max-params -- two names and whether each is a directory
function cmpTreeKeys(a: Uint8Array, aDir: boolean, b: Uint8Array, bDir: boolean): number {
  const la = aDir ? a.length + 1 : a.length, lb = bDir ? b.length + 1 : b.length;
  const n = Math.min(la, lb);
  for (let i = 0; i < n; i++) {
    const x = i < a.length ? (a[i] as number) : TREE_SORT_SLASH;
    const y = i < b.length ? (b[i] as number) : TREE_SORT_SLASH;
    if (x !== y) return x - y;
  }
  return la - lb;
}
/* oxlint-enable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style */
// A tree entry's mode, read from its bytes [p, sp) without decoding them (#207): lowBits of the mode, or NOT_OCTAL when a byte is
// not an octal digit (what /^[0-7]+$/ refused of the decoded text: any other byte decodes to a non-digit). Each digit
// is 3 bits, so the low 16 bits of the whole mode are those of its last MODE_LOW_DIGITS digits, which lowBits reads:
// the value is kept to its low 16 bits as it is read, however long the mode. Empty (p === sp) is 0; the caller refuses
// it first.
/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- p <= i < sp <= data.length: every read is in range (`as`, not the `!` src/ forbids) */
const OCTAL_0 = 0x30;
const OCTAL_7 = 0x37;
const OCTAL_BITS = 3;
const NOT_OCTAL = -1;
function modeBits(data: Uint8Array, p: number, sp: number): number {
  let m = 0;
  for (let i = p; i < sp; i++) {
    const c = data[i] as number;
    if (c < OCTAL_0 || c > OCTAL_7) return NOT_OCTAL;
    m = ((m << OCTAL_BITS) | (c - OCTAL_0)) & MODE_BITS;
  }
  return m;
}
// The OID_BYTES at o are all zero (fsck nullSha1)
function nullOid(data: Uint8Array, o: number): boolean {
  for (let i = o; i < o + OID_BYTES; i++) if ((data[i] as number) !== 0) return false;
  return true;
}
/* oxlint-enable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style */

export type TreeEntry = { readonly mode: Mode; readonly name: string; readonly oid: Oid; readonly oidOffset: number; readonly entryOffset: number };
// What encodeTree takes from a caller: plain strings, parsed once (treeEntryOf) into an EntryOf.
export type TreeEntryInput = { readonly mode: string; readonly name: string; readonly oid: string };
// An entry to encode, parsed: one of the five modes git writes and a full object id. A parsed TreeEntry is one.
export type EntryOf = { readonly mode: Mode; readonly name: string; readonly oid: Oid };
// The five modes git writes in a tree (canon_mode's results), spelled exactly: a mode git would canonicalize first
// (`100664`, `040000`) is not one of them.
export function isMode(mode: unknown): mode is Mode {
  switch (mode) {
    case MODE_BLOB:
    case MODE_EXEC:
    case MODE_LINK:
    case MODE_TREE:
    case MODE_COMMIT:
      return true;
    default:
      return false;
  }
}
// A caller's value quoted in a refusal. The types say string, a JavaScript caller's value is whatever it is, and a
// refusal must not throw: JSON.stringify throws on a BigInt and on a cycle, so only a string is quoted; a number, a
// boolean and null are spelled, and anything else (an absent value included) is named by its type.
// An error never grows with a caller's text: at most QUOTE_UNITS UTF-16 units of a string are quoted (http.ts's
// ERROR_QUOTE: 200), with the true length after it, and the `entry` field holds the same cut (cutName). A name over
// TREE_MAX_NAME_BYTES is refused for its length, so without the cut that refusal alone is as large as the caller likes.
// The cut never ends on the first half of a surrogate pair (a unit in d800..dbff): it stops one unit earlier, so what is
// quoted of a well-formed name is well-formed, and an error about a name with a byte form holds no string without one.
const QUOTE_UNITS = 200;
const HIGH_SURROGATE_FIRST = 0xd8_00;
const HIGH_SURROGATE_LAST = 0xdb_ff;
function cut(text: string): string {
  const last = text.charCodeAt(QUOTE_UNITS - 1); // oxlint-disable-line unicorn/prefer-code-point -- the unit itself: codePointAt would pair it with the next one
  return text.slice(0, last >= HIGH_SURROGATE_FIRST && last <= HIGH_SURROGATE_LAST ? QUOTE_UNITS - 1 : QUOTE_UNITS);
}
const cutName = (name: string): string => (typeof name === 'string' && name.length > QUOTE_UNITS ? cut(name) : name);
function quoted(value: unknown): string {
  if (typeof value === 'string') return value.length > QUOTE_UNITS ? `${JSON.stringify(cut(value))}… (${value.length} UTF-16 units)` : JSON.stringify(value);
  return value === null || typeof value === 'number' || typeof value === 'boolean' ? String(value) : typeof value;
}
// A caller's entry, parsed once: the mode is one of the five (`tree: entry "n": invalid mode`, what `mode`) and the oid
// 40 lowercase hex (parseOid's refusal, what `oid`), each with the entry's name.
export function treeEntryOf(e: TreeEntryInput): Result<EntryOf, BadRequest> {
  const { mode, name } = e;
  if (!isMode(mode)) return fail('bad_request', `tree: entry ${quoted(name)}: invalid mode ${quoted(mode)}`, { what: 'mode', entry: cutName(name) });
  const oid = parseOid(e.oid);
  if (!oid.ok) return fail('bad_request', `tree: entry ${quoted(name)}: ${oid.error.message}`, { what: 'oid', entry: cutName(name) });
  return ok({ mode, name, oid: oid.value });
}

type Corrupt = ErrorOf<'pack_corrupt'>;
type BadRequest = ErrorOf<'bad_request'>;
// What a parser refuses: corrupt bytes, a limit, or a caller's limit that bounds nothing.
export type ObjectError = Corrupt | ErrorOf<'limit_exceeded'> | BadRequest;
// A check that passed: one shared value, so a check that succeeds allocates nothing.
const DONE: Ok<null> = ok(null);

// Every tree refusal is pack_corrupt with this prefix (one constructor: the code and prefix ship once).
const badTree = (why: string): Err<Corrupt> => fail('pack_corrupt', `tree: ${why}`);

// How many entries are fully framed (mode, space, name, NUL, OID_BYTES). A short tail is not an entry: the parser
// reports that as pack_corrupt. Stops at one past the cap, so a huge tree is not scanned twice end to end.
const completeTreeFrames = (data: Uint8Array, maxEntries: number): number => {
  const stop = maxEntries + 1;
  let p = 0;
  let n = 0;
  while (p < data.length && n < stop) {
    const sp = data.indexOf(TREE_MODE_SEP, p);
    if (sp < p) return n;
    const nul = data.indexOf(TREE_NUL, sp + 1);
    if (nul < sp + 1 || data.length - (nul + 1) < OID_BYTES) return n;
    n += 1;
    p = nul + 1 + OID_BYTES;
  }
  return n;
};

// The hex id is computed when a reader asks. Caching it on the entry would put a 40-character string beside every
// name, which is what exhausted a 128 MiB heap at the cap. The tree's buffer is a private field: not enumerable, not in
// JSON, not a key, so equality and JSON see the mode, the name, and the offsets. Entries are ordinary objects of one
// shape, built by one constructor (#207: an Object.create of a per-tree prototype, then Object.assign of a record, was
// a fifth of parseTree's CPU); defineProperty on every entry puts it in dictionary mode, which is what exhausted a
// 128 MiB heap at the cap, and a private field does not.
class ParsedEntry implements TreeEntry {
  public readonly mode: Mode;
  public readonly name: string;
  public readonly oidOffset: number;
  public readonly entryOffset: number;
  readonly #bytes: Uint8Array;
  // oxlint-disable-next-line eslint/max-params -- the tree's bytes and one entry's four fields, on every entry: no record to allocate
  public constructor(bytes: Uint8Array, mode: Mode, name: string, oidOffset: number, entryOffset: number) {
    this.mode = mode; this.name = name; this.oidOffset = oidOffset; this.entryOffset = entryOffset;
    this.#bytes = bytes;
  }
  public get oid(): Oid {
    return toOid(this.#bytes.subarray(this.oidOffset, this.oidOffset + OID_BYTES));
  }
}

// entry: { mode: '100644'|'100755'|'120000'|'40000'|'160000', name, oid (hex), oidOffset }
// Duplicates and order are git's rules (fsck duplicateEntries and treeNotSorted, both errors under --strict) on the
// raw name bytes. A file `d` and a directory `d` need not be neighbours (`d` < `d.x` < `d/`), so the duplicate check is
// over the whole tree, as fsck's verify_ordered does with its stack of file names a later directory could repeat. It
// runs before the order check: by then every earlier pair was in order, and on a sorted prefix fsck's stack finds
// exactly the duplicates this set finds, so the message is one fsck prints. Names decode losslessly (decodeBytes, #43):
// distinct bytes are distinct names, so the set holds that name and not a second hex copy of the bytes.
// A tree that cannot fit in maxTreeEntries is counted before any entry object exists. The cap still fires as
// `tree entries <max+1>`, and bytes past it are not validated: a bad mode there stays limit_exceeded.
// @decoder parseTree prefix=tree
// oxlint-disable-next-line eslint/complexity -- fsck_tree's checks in fsck's order, inline: a helper costs bytes on every entry
export function parseTree(data: Uint8Array, limits: LimitsInput = DEFAULT_LIMITS): Result<TreeEntry[], ObjectError> {
  const checked = parseLimits(limits);
  if (!checked.ok) return checked;
  const maxEntries = checked.value.maxTreeEntries;
  // Shorter than one minimum entry per allowed slot: the count cannot pass the cap, so skip the frame scan.
  // A flipped comparison here still agrees with the frame count (max+1 minimum frames cannot fit in fewer bytes).
  // Stryker disable next-line ConditionalExpression,EqualityOperator,ArithmeticOperator: byte length only skips the scan; the frame count decides the cap
  const wide = data.length > maxEntries * TREE_ENTRY_MIN;
  // Stryker disable next-line ConditionalExpression,EqualityOperator: past the cap the loop refuses either way; this flag only skips retaining entries the caller never sees
  const over = wide && completeTreeFrames(data, maxEntries) > maxEntries;
  const entries: TreeEntry[] = [];
  const seen = new Set<string>();
  let p = 0;
  let count = 0;
  let prevName: Uint8Array | null = null;
  // Stryker disable next-line BooleanLiteral: read only once prevName is set, and set with it
  let prevDir = false;
  while (p < data.length) {
    if (count >= maxEntries) return err(limitError('tree entries', count + 1, maxEntries));
    const sp = data.indexOf(TREE_MODE_SEP, p);
    // A negative fromIndex would wrap; indexOf returns -1 when the separator is absent.
    if (sp < p) return badTree('malformed entry');
    const nul = data.indexOf(TREE_NUL, sp + 1);
    if (nul < sp + 1) return badTree('malformed entry');
    // p <= sp < nul < data.length (the two checks above): the mode and the name are in range, they cannot be short
    // The name is bytes to git: decodeBytes keeps a leading BOM and escapes ill-formed UTF-8, so the string maps back (#43)
    const nameBytes: Uint8Array = data.subarray(sp + 1, nul);
    const name: string = decodeBytes(nameBytes);
    // The id starts at nul+1 and needs OID_BYTES bytes there (take's short read); the old `nul + OID_BYTES > length`
    // guard counted from the NUL and let a 19-byte id through.
    if (data.length - (nul + 1) < OID_BYTES) return err(shortRead('pack_corrupt', nul + 1, OID_BYTES, data.length));
    if (sp === p) return badTree('empty mode');
    // the mode's bytes, not a decode of them (#207)
    const bits = modeBits(data, p, sp);
    if (bits === NOT_OCTAL) return badTree('malformed mode');
    // decode_tree_entry refuses an empty name before fsck_tree looks at the mode's first byte
    if (name.length === 0) return badTree('empty name');
    if (data[p] === OCTAL_0) return badTree('zero-padded mode');
    const mode = canonBits(bits);
    if (name.includes('/')) return badTree('full pathname');
    if (name === '.' || name === '..' || isDotGitName(nameBytes)) return badTree('bad name');
    if (nameBytes.length > TREE_MAX_NAME_BYTES) return badTree('large pathname');
    if (nullOid(data, nul + 1)) return badTree('null sha1');
    // fsck_tree: a .gitmodules (any spelling) that is a symlink is gitmodulesSymlink; one that is not a blob (a tree, or a
    // gitlink, whose commit is never in the repository) is gitmodulesBlob / gitmodulesMissing in fsck_finish. The same
    // for .gitattributes, except that as a symlink it is only a warning (gitattributesSymlink, INFO)
    if (isDotFileName(nameBytes, 'gitmodules')) {
      if (mode === MODE_LINK) return badTree('.gitmodules is a symbolic link');
      if (mode === MODE_TREE || mode === MODE_COMMIT) return badTree('.gitmodules is not a blob');
    }
    if ((mode === MODE_TREE || mode === MODE_COMMIT) && isDotFileName(nameBytes, 'gitattributes')) return badTree('.gitattributes is not a blob');
    if (seen.has(name)) return badTree(`duplicate entry ${JSON.stringify(name)}`);
    seen.add(name);
    const dir = (bits & MODE_S_IFMT) === MODE_S_IFDIR;
    // Stryker disable next-line EqualityOperator: equal keys are equal names (a name holds no '/'), which the duplicate check above refused
    if (prevName !== null && cmpTreeKeys(prevName, prevDir, nameBytes, dir) >= 0) return badTree('not strictly sorted');
    prevName = nameBytes;
    prevDir = dir;
    // Past the cap, keep the name set (a bad prefix is still pack_corrupt) and do not retain the entry.
    // Always pushing still refuses on the next entry, so the returned array is the same; never pushing is a length assertion.
    // Stryker disable next-line ConditionalExpression: retaining the entries past the cap does not change the refusal or the array a caller sees
    if (!over) entries.push(new ParsedEntry(data, mode, name, nul + 1, p));
    count += 1;
    p = nul + 1 + OID_BYTES;
  }
  return ok(entries);
}

type Sortable = { readonly mode: string; readonly name: string };
const sortKey = (e: Sortable): string => (e.mode === MODE_TREE ? `${e.name}/` : e.name);
// git's tree order on the names' bytes (a directory sorts as its name and a `/`). A name with no byte form is refused.
// Each key is computed once, before the sort: an entry's name and mode are read once and encoded once, where encoding
// both keys inside the comparator cost two encodes (and, for a directory, two string concatenations) per comparison,
// about 2 log2(n) per entry. The comparator and the keys are the ones the sort always used, and Array.prototype.sort
// is stable, so the order is unchanged for every input. What changed with it: every name is encoded, compared or not,
// so the refusal is the first entry in the caller's order with no byte form, and a list of one such entry is refused.
type SortRow<T> = { readonly key: Uint8Array; readonly entry: T };
export function treeSort<T extends Sortable>(entries: Iterable<T>): Result<T[], BadRequest> {
  const rows: Array<SortRow<T>> = [];
  for (const entry of entries) {
    const key = encodeBytes(sortKey(entry), 'tree entry name');
    if (!key.ok) return key;
    rows.push({ key: key.value, entry });
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- sorts its own array; any iterable a caller passes still works
  rows.sort((a, b) => cmpBytes(a.key, b.key));
  return ok(rows.map(row => row.entry));
}

// The one tree encoder: every tree ply writes (encodeTree, pushTree, commitChanges, merge, memtree, buildTree) is built
// here, and none of them can write a tree `git fsck --strict` refuses. Each entry is held to fsck.c fsck_tree's rules,
// the ones parseTree reads by, before a byte is written: an empty name (git: `empty filename in tree entry`, badTree),
// a NUL (it would end the name field early: the rest of the name would be read as an object id and further entries)
// or a `/` in a name (fullPathname), `.` (hasDot), `..` (hasDotdot), any spelling of `.git` git checks (hasDotgit: case
// folded, NTFS short and stream forms, HFS ignorable code points, after a backslash), a name over TREE_MAX_NAME_BYTES
// (largePathname), the null id (nullSha1), `.gitmodules` as a symlink (gitmodulesSymlink) or as a tree or gitlink
// (gitmodulesBlob, gitmodulesMissing), and `.gitattributes` as a tree or gitlink (gitattributesBlob).
// duplicateEntries: one name twice in one tree, whatever the modes. A file `a` and a directory `a` do not sort next to
// each other (`a` < `a.b` < `a/`), so the check is by name, not by neighbour. Case-only twins (`README` and `readme`)
// are two names to git and to fsck; they collide only on a case-insensitive checkout, and are accepted here too.
// treeNotSorted cannot happen: the entries are sorted here, in fsck verify_ordered's order (cmpTreeKeys), on name bytes
// encoded once per entry. zeroPaddedFilemode and badFilemode cannot happen either: the encoder checks every field
// itself, whatever the entry's type says. The name must be a string with a byte form, the mode one of the five git
// writes (isMode) and the id 40 lowercase hex (parseOid); anything else is bad_request (what `tree entry name`, `mode`,
// `oid`), never a throw and never a written byte. A mode that is not one of the five has no fixed width (a fullwidth
// digit is one UTF-16 unit and three bytes), so it is refused before the output is sized.
const NULL_OID = '0'.repeat(OID_HEX_CHARS);
type TreeRow = { readonly mode: Mode; readonly name: Uint8Array; readonly oid: Oid };
// Why fsck refuses one entry (parseTree's words for it), or null: the entry and its name's bytes
// oxlint-disable-next-line eslint/complexity -- fsck_tree's checks in fsck's order, as in parseTree
function entryRefusal(e: EntryOf, name: Uint8Array): string | null {
  const { mode } = e;
  if (name.length === 0) return 'empty name';
  if (name.includes(TREE_NUL)) return 'NUL in name';
  if (name.includes(TREE_SORT_SLASH)) return 'full pathname';
  if (e.name === '.' || e.name === '..' || isDotGitName(name)) return 'bad name';
  if (name.length > TREE_MAX_NAME_BYTES) return 'large pathname';
  if (e.oid === NULL_OID) return 'null sha1';
  const notBlob = mode === MODE_TREE || mode === MODE_COMMIT;
  if (isDotFileName(name, 'gitmodules')) {
    if (mode === MODE_LINK) return '.gitmodules is a symbolic link';
    if (notBlob) return '.gitmodules is not a blob';
  }
  if (notBlob && isDotFileName(name, 'gitattributes')) return '.gitattributes is not a blob';
  return null;
}
export function encodeEntries(entries: readonly EntryOf[]): Result<Uint8Array, BadRequest> {
  const names = new Set<string>();
  const rows: TreeRow[] = [];
  let size = 0;
  for (const e of entries) {
    const { mode } = e;
    const encoded = encodeBytes(e.name, 'tree entry name');
    if (!encoded.ok) return encoded;
    const name = encoded.value;
    if (!isMode(mode)) return fail('bad_request', `tree: entry ${quoted(e.name)}: invalid mode ${quoted(mode)}`, { what: 'mode', entry: cutName(e.name) });
    const oid = parseOid(e.oid);
    if (!oid.ok) return fail('bad_request', `tree: entry ${quoted(e.name)}: ${oid.error.message}`, { what: 'oid', entry: cutName(e.name) });
    const why = entryRefusal(e, name);
    if (why !== null) return fail('bad_request', `tree: entry ${quoted(e.name)}: ${why}`, { what: 'tree entry', entry: cutName(e.name) });
    if (names.has(e.name)) return fail('bad_request', `tree: duplicate entry ${quoted(e.name)}`, { what: 'tree entry', entry: cutName(e.name) });
    names.add(e.name);
    rows.push({ mode, name, oid: e.oid });
    size += mode.length + 1 + name.length + 1 + OID_BYTES;
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- sorts its own array
  rows.sort((a, b) => cmpTreeKeys(a.name, a.mode === MODE_TREE, b.name, b.mode === MODE_TREE));
  const out = new Uint8Array(size);
  let p = 0;
  for (const row of rows) {
    // the mode is ASCII digits: one byte each
    p += te.encodeInto(row.mode, out.subarray(p)).written;
    out[p] = TREE_MODE_SEP;
    out.set(row.name, p + 1);
    p += row.name.length + 1;
    out[p] = TREE_NUL;
    out.set(fromHex(row.oid), p + 1);
    p += OID_BYTES + 1;
  }
  return ok(out);
}

// A caller's entries, each parsed once (treeEntryOf, in the caller's order), then encoded.
export function encodeTree(entries: readonly TreeEntryInput[]): Result<Uint8Array, BadRequest> {
  const parsed: EntryOf[] = [];
  for (const e of entries) {
    const one = treeEntryOf(e);
    if (!one.ok) return one;
    parsed.push(one.value);
  }
  return encodeEntries(parsed);
}

// Replace the oid of one entry in place; returns new bytes + coordinates for a structural delta.
export function treeReplaceOid(data: Uint8Array, entry: { readonly oidOffset: number }, newOidHex: Oid): Uint8Array {
  const out = data.slice();
  out.set(fromHex(newOidHex), entry.oidOffset);
  return out;
}

// ---- commit and tag: git fsck.c, rule for rule (issue #59) ----
// parseCommit and parseTag are the only readers of a commit or tag header, and each refuses exactly the objects
// `git fsck --strict` reports an error for, with git's msgId in the message (`commit: badDate: …`). The decision space
// and git's verdict on every cell are in test/fsck-space.test.js. What fsck does not read, ply does not judge: a commit
// is checked up to its committer line and a tag up to its tagger; every later header line is kept verbatim in `extra`.
// One allowed typed refusal (PR #7): a second copy of a single-valued header after the committer or tagger (tree,
// parent, author, committer, encoding; object, type, tag, tagger) is fsck-clean, but git's own views of that object disagree (pretty.c's
// %an/%cn show the last author/committer line, %T, %e and the commit date the first; cat-file shows a late parent that
// %P ignores, and a second tag object/type/name that the parsed tag ignores), so whatever ply showed, some git view would contradict it: an author-spoofing differential. Those are refused as
// `duplicateHeader` (`commit: duplicate tree`). A missing tagger and a tag name that is not a refname are warnings git accepts (INFO
// under --strict), so ply accepts them too. The object is decoded losslessly (decodeBytes, #43): a leading BOM is kept,
// so a BOM before `tree` is a missing tree, as in git, and an ill-formed UTF-8 byte becomes an escape (a lone surrogate)
// that encodeBytes maps back to the same byte, so a Latin-1 message or ident re-encodes to its own bytes. No rule here
// matches an escape, and an escape can never form a NUL, a newline or any other delimiter.
const DIGIT = /^[0-9]$/u;

const BLANK_LINE = '\n\n';
const NO_BODY = -1;
const corrupt = (kind: string, msgId: string, why: string): Err<Corrupt> => fail('pack_corrupt', `${kind}: ${msgId}: ${why}`, { msgId });

// fsck.c verify_headers: no NUL before the first blank line, and a header without a blank line ends in a newline.
// The index of the blank line's first newline, or -1 when there is no body section.
function verifyHeaders(s: string, kind: string): Result<number, Corrupt> {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\0') return corrupt(kind, 'nulInHeader', `unterminated header: NUL at offset ${i}`);
    if (ch === '\n' && s[i + 1] === '\n') return ok(i);
  }
  if (s.length > 0 && s.endsWith('\n')) return ok(NO_BODY);
  return corrupt(kind, 'unterminatedHeader', 'unterminated header');
}

// parse_oid_hex then '\n': 40 hex digits of either case (git stores the binary id, so it prints lowercase). The id is
// parsed once, lowercased (only A-F lowercase to hex digits, as in lsrefs.ts): a slice cut short by the end of the
// object is the length refusal, and a non-hex character the digit one; either is git's bad sha1.
function oidLine(s: string, p: number, kind: string, msgId: string, what: string): Result<Oid, Corrupt> {
  const id = parseOid(s.slice(p, p + OID_HEX_CHARS).toLowerCase());
  if (!id.ok || s[p + OID_HEX_CHARS] !== '\n') return corrupt(kind, msgId, `invalid '${what}' line format - bad sha1`);
  return id;
}


// fsck.c fsck_ident on the line that starts at p (after "author "); returns [the ident text, the index after its
// newline]. The checks and their order are git's: a leading '<', a '>' before the '<', no '<', no space before '<',
// no '>' after the email, no space after '>', then spaces or tabs, a digit, no leading zero unless the date is "0",
// no overflow past git's timestamp range, one space, a sign, IDENT_TZ_DIGITS digits, and the newline.
// The digits of the greatest timestamp fsck accepts (2^63 - 1: 19).
const IDENT_TIMESTAMP_DIGITS = String(IDENT_TIMESTAMP_MAX).length;
// oxlint-disable-next-line eslint/complexity -- fsck_ident line for line, inline: a helper costs bytes on every entry
function fsckIdent(s: string, p: number, kind: string, role: string): Result<readonly [ident: string, next: number], Corrupt> {
  const eol = s.indexOf('\n', p);
  const end = eol < 0 ? s.length : eol;
  const bad = (msgId: string, why: string): Err<Corrupt> => corrupt(kind, msgId, `invalid ${role} line - ${why}`);
  if (s[p] === '<') return bad('missingNameBeforeEmail', 'missing space before email');
  let q = p;
  while (q < end && s[q] !== '<' && s[q] !== '>') q++;
  if (s[q] === '>') return bad('badName', 'bad name');
  if (s[q] !== '<') return bad('missingEmail', 'missing email');
  if (s[q - 1] !== ' ') return bad('missingSpaceBeforeEmail', 'missing space before email');
  q++;
  while (q < end && s[q] !== '<' && s[q] !== '>') q++;
  if (s[q] !== '>') return bad('badEmail', 'bad email');
  q++;
  if (s[q] !== ' ') return bad('missingSpaceBeforeDate', 'missing space before date');
  q++;
  while (s[q] === ' ' || s[q] === '\t') q++;
  // charAt past the end is '', which is no digit
  if (!DIGIT.test(s.charAt(q))) return bad('badDate', 'bad date');
  if (s[q] === '0' && s[q + 1] !== ' ') return bad('zeroPaddedDate', 'zero-padded date');
  const start = q;
  while (DIGIT.test(s.charAt(q))) q++;
  // By length first: the run has no leading zero (above), so more digits than the limit has is past the limit. The
  // run is the remote's and as long as the object; BigInt of it is superlinear, so it only ever sees a short one.
  if (q - start > IDENT_TIMESTAMP_DIGITS || BigInt(s.slice(start, q)) > IDENT_TIMESTAMP_MAX) return bad('badDateOverflow', 'date causes integer overflow');
  if (s[q] !== ' ') return bad('badDate', 'bad date');
  q++;
  if (s[q] !== '+' && s[q] !== '-') return bad('badTimezone', 'bad time zone');
  for (let i = 1; i <= IDENT_TZ_DIGITS; i++) if (!DIGIT.test(s.charAt(q + i))) return bad('badTimezone', 'bad time zone');
  if (s[q + IDENT_TZ_DIGITS + 1] !== '\n') return bad('badTimezone', 'bad time zone');
  return ok([s.slice(p, end), end + 1]);
}

// The header lines after the last one fsck reads, up to the blank line (or the end), and the message after it.
function rest(s: string, p: number, blank: number): { extra: string[]; message: string | null } {
  const headEnd = blank === NO_BODY ? s.length : blank + 1;
  const tail = s.slice(p, headEnd);
  // every header line ends in a newline (verify_headers), so the tail is whole lines; drop the last terminator
  return { extra: tail.length > 0 ? tail.slice(0, tail.length - 1).split('\n') : [], message: blank === NO_BODY ? null : s.slice(blank + BLANK_LINE.length) };
}

// The allowed typed refusal above: fsck accepts the object, git's views of it disagree, ply refuses. A line after the
// committer that starts `parent ` is a parent cat-file shows and %P does not; PR #7 named it a bad header order.
const COMMIT_SHADOWED = [COMMIT_HEADER_TREE, COMMIT_HEADER_PARENT, COMMIT_HEADER_AUTHOR, COMMIT_HEADER_COMMITTER];
const TAG_SHADOWED = [TAG_HEADER_OBJECT, TAG_HEADER_TYPE, TAG_HEADER_TAG, TAG_HEADER_TAGGER];
const duplicate = (kind: string, key: string): Err<Corrupt> => fail('pack_corrupt', key === COMMIT_HEADER_PARENT && kind === 'commit' ? 'commit: bad header order' : `${kind}: duplicate ${key}`, { msgId: 'duplicateHeader' });
function refuseShadowed(kind: string, extra: readonly string[], keys: readonly string[]): Result<null, Corrupt> {
  for (const l of extra) for (const key of keys) if (l.startsWith(`${key} `)) return duplicate(kind, key);
  return DONE;
}

// tree and parents are parsed once (oidLine): Oids.
export type Commit = {
  readonly tree: Oid; readonly parents: Oid[]; readonly author: string; readonly committer: string;
  readonly encoding: string | null; readonly extra: string[]; readonly message: string | null;
};
// @decoder parseCommit prefix=commit
export function parseCommit(data: Uint8Array, limits: LimitsInput = DEFAULT_LIMITS): Result<Commit, ObjectError> {
  const checked = parseLimits(limits);
  if (!checked.ok) return checked;
  const maxParents = checked.value.maxCommitParents;
  const s: string = decodeBytes(data);
  const headers = verifyHeaders(s, 'commit');
  if (!headers.ok) return headers;
  const blank = headers.value;
  const has = (p: number, key: string): boolean => s.startsWith(`${key} `, p);
  if (!has(0, COMMIT_HEADER_TREE)) return corrupt('commit', 'missingTree', "invalid format - expected 'tree' line");
  let p = COMMIT_HEADER_TREE.length + 1;
  const tree = oidLine(s, p, 'commit', 'badTreeSha1', COMMIT_HEADER_TREE);
  if (!tree.ok) return tree;
  p += OID_HEX_CHARS + 1;
  const parents: Oid[] = [];
  while (has(p, COMMIT_HEADER_PARENT)) {
    p += COMMIT_HEADER_PARENT.length + 1;
    const parent = oidLine(s, p, 'commit', 'badParentSha1', COMMIT_HEADER_PARENT);
    if (!parent.ok) return parent;
    parents.push(parent.value);
    if (parents.length > maxParents) return err(limitError('commit parents', parents.length, maxParents));
    p += OID_HEX_CHARS + 1;
  }
  const authors: string[] = [];
  while (has(p, COMMIT_HEADER_AUTHOR)) {
    const who = fsckIdent(s, p + COMMIT_HEADER_AUTHOR.length + 1, 'commit', COMMIT_HEADER_AUTHOR);
    if (!who.ok) return who;
    authors.push(who.value[0]);
    p = who.value[1];
  }
  const [author] = authors;
  if (typeof author !== 'string') return corrupt('commit', 'missingAuthor', "invalid format - expected 'author' line");
  if (authors.length > 1) return corrupt('commit', 'multipleAuthors', "invalid format - multiple 'author' lines");
  if (!has(p, COMMIT_HEADER_COMMITTER)) return corrupt('commit', 'missingCommitter', "invalid format - expected 'committer' line");
  const committed = fsckIdent(s, p + COMMIT_HEADER_COMMITTER.length + 1, 'commit', COMMIT_HEADER_COMMITTER);
  if (!committed.ok) return committed;
  const [committer, next] = committed.value;
  // fsck_commit's last check is over the whole object; verify_headers already refused a NUL in the header
  if (s.includes('\0')) return corrupt('commit', 'nulInCommit', 'NUL byte in the commit object body');
  const { extra, message } = rest(s, next, blank);
  const shadowed = refuseShadowed('commit', extra, COMMIT_SHADOWED);
  if (!shadowed.ok) return shadowed;
  const at = extra.findIndex(l => l.startsWith(`${COMMIT_HEADER_ENCODING} `));
  // splice returns a one-element array; String() of it is that line
  const encoding = at < 0 ? null : String(extra.splice(at, 1)).slice(COMMIT_HEADER_ENCODING.length + 1);
  // a second encoding is a second copy of a single-valued header
  if (extra.some(l => l.startsWith(`${COMMIT_HEADER_ENCODING} `))) return duplicate('commit', COMMIT_HEADER_ENCODING);
  return ok({ tree: tree.value, parents, author, committer, encoding, extra, message });
}

export function ident(person: ValidatedIdent): Result<string, BadRequest> {
  if (!isValidatedIdent(person)) return fail('bad_request', 'ident: unvalidated identity', { what: 'ident' });
  return ok(`${person.name} <${person.email}> ${person.time} ${person.tz}`);
}

// The inverse, as git's split_ident_line reads it: name up to the first '<' (trailing spaces trimmed), email up to the
// next '>', then "<epoch> <tz>" after the last '>'. Fields git would print as empty are '' (time null when the date is missing).
// @decoder parseIdent prefix=ident
export type ParsedIdent = { readonly name: string; readonly email: string; readonly time: string | null; readonly tz: string };
export function parseIdent(line: unknown): ParsedIdent | null {
  if (typeof line !== 'string') return null;
  const lt = line.indexOf('<');
  if (lt < 0) return { name: line.trim(), email: '', time: null, tz: '' };
  const gt = line.indexOf('>', lt + 1);
  // Stryker disable next-line EqualityOperator: indexOf from lt + 1 cannot return 0, so <= and < reject the same missing '>'
  if (gt < 0) return { name: line.trim(), email: '', time: null, tz: '' };
  const parts = line.slice(line.lastIndexOf('>') + 1).trim().split(/\s+/u);
  // Stryker disable next-line StringLiteral: a missing time fails the digit test the same way any non-numeric default does
  const time = atOr(parts, 0, '');
  const tz = atOr(parts, 1, '');
  return { name: line.slice(0, lt).trimEnd(), email: line.slice(lt + 1, gt), time: /^\d+$/u.test(time) ? time : null, tz };
}

// ---- tag (annotated): fsck.c fsck_tag_standalone ----
export type Tag = {
  readonly object: string; readonly type: string; readonly tag: string; readonly tagger: string | null;
  readonly extra: string[]; readonly message: string | null;
};
// @decoder parseTag prefix=tag
export function parseTag(data: Uint8Array): Result<Tag, Corrupt> {
  const s: string = decodeBytes(data);
  const headers = verifyHeaders(s, 'tag');
  if (!headers.ok) return headers;
  const blank = headers.value;
  const has = (p: number, key: string): boolean => s.startsWith(`${key} `, p);
  if (!has(0, TAG_HEADER_OBJECT)) return corrupt('tag', 'missingObject', "invalid format - expected 'object' line");
  let p = TAG_HEADER_OBJECT.length + 1;
  const object = oidLine(s, p, 'tag', 'badObjectSha1', TAG_HEADER_OBJECT);
  if (!object.ok) return object;
  p += OID_HEX_CHARS + 1;
  if (!has(p, TAG_HEADER_TYPE)) return corrupt('tag', 'missingTypeEntry', "invalid format - expected 'type' line");
  p += TAG_HEADER_TYPE.length + 1;
  // verify_headers guarantees a newline after every header line, so the type and tag lines always end
  let eol = s.indexOf('\n', p);
  const type = s.slice(p, eol);
  if (!Object.hasOwn(TYPE_ID, type)) return corrupt('tag', 'badType', "invalid 'type' value");
  p = eol + 1;
  if (!has(p, TAG_HEADER_TAG)) return corrupt('tag', 'missingTagEntry', "invalid format - expected 'tag' line");
  p += TAG_HEADER_TAG.length + 1;
  eol = s.indexOf('\n', p);
  // badTagName (not a refname under refs/tags/) is INFO: git warns and accepts, and so does ply
  const tag = s.slice(p, eol);
  p = eol + 1;
  // missingTaggerEntry is INFO: tags before git 0.99.1 have none
  let tagger: string | null = null;
  if (has(p, TAG_HEADER_TAGGER)) {
    const who = fsckIdent(s, p + TAG_HEADER_TAGGER.length + 1, 'tag', TAG_HEADER_TAGGER);
    if (!who.ok) return who;
    [tagger, p] = who.value;
  }
  // extraHeaderEntry is IGNORE, and fsck never reads a tag's body: a NUL there is accepted, unlike in a commit
  const { extra, message } = rest(s, p, blank);
  const shadowed = refuseShadowed('tag', extra, TAG_SHADOWED);
  if (!shadowed.ok) return shadowed;
  return ok({ object: object.value, type, tag, tagger, extra, message });
}

// Every object fetch passes through here once it hashes to the oid the server advertised (fetchObject, checkWide on a
// pack before any of it is returned or harvested). It is the same parser every reader calls, so a commit or tag no
// reader would accept never reaches one. A tree's entries are its answer (#208): the parse is the reader's too, so a fetched
// tree is parsed once (fetch.ts treeEntries); any other type answers none.
const NOTHING_PARSED: Ok<Option<TreeEntry[]>> = ok(none);
export function assertFetched(typeName: string, data: Uint8Array, limits: LimitsInput = DEFAULT_LIMITS): Result<Option<TreeEntry[]>, ObjectError> {
  const found = wireTypeName(typeName);
  switch (found.tag) {
    case 'invalid': return fail('pack_corrupt', `object: bad type ${typeName}`);
    case 'named': {
      switch (found.name) {
        case 'blob': case 'ofs_delta': case 'ref_delta': return NOTHING_PARSED;
        case 'tree': { const r = parseTree(data, limits); return r.ok ? ok(some(r.value)) : r; }
        case 'commit': { const r = parseCommit(data, limits); return r.ok ? NOTHING_PARSED : r; }
        case 'tag': { const r = parseTag(data); return r.ok ? NOTHING_PARSED : r; }
      }
      // Stryker disable next-line ConditionalExpression,CallExpression: unreachable, the compiler's exhaustiveness check
      return assertNever(found.name);
    }
  }
  // Stryker disable next-line ConditionalExpression,CallExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(found);
}

// A header value is one line. LF or NUL, from any caller, would open a new header. The message is the body: LF is
// legal there, NUL is not. withGpgsig splices signature continuation lines after this returns, so those bytes are
// not re-checked here.
const headerValue = (value: unknown, what: string): Result<null, BadRequest> =>
  (typeof value !== 'string' || /[\0\n]/u.test(value) ? fail('bad_request', `${what} must not contain NUL or newline`, { what }) : DONE);
// The first of (value, what) that is not one header line, in order.
function headerValues(values: ReadonlyArray<readonly [unknown, string]>): Result<null, BadRequest> {
  for (const [value, what] of values) {
    const r = headerValue(value, what);
    if (!r.ok) return r;
  }
  return DONE;
}
const messageBody = (message: unknown): Result<null, BadRequest> =>
  (message !== null && (typeof message !== 'string' || message.includes('\0')) ? fail('bad_request', 'message must not contain NUL', { what: 'message' }) : DONE);

// Faithful: the message is written verbatim after the blank line; null means no body section. Callers that want
// git's conventional trailing newline add it themselves (editFile does). parents, committer (the author), encoding,
// message and extra may be left out. tree and parents are plain strings in, parsed once (parseOid) at encodeCommit.
export type CommitConfig = {
  readonly tree: string; readonly parents: readonly string[]; readonly author: string; readonly committer: string;
  readonly encoding: string | null; readonly message: string | null; readonly extra: readonly string[];
};
export type CommitInput = { readonly tree: string; readonly author: string } & Input<Omit<CommitConfig, 'tree' | 'author'>>;
// The same, the ids parsed: what ply's own writers hold (a built tree, a resolved commit).
export type CommitIds = { readonly tree: Oid; readonly parents: readonly Oid[]; readonly author: string } & Input<Omit<CommitConfig, 'tree' | 'author' | 'parents'>>;
// A commit's tree or parent id: 40 hex digits, parsed once (parseOid's refusal, named for the header it would be written
// in, what `tree` or `parent`). git's fsck reads either case (hash-object keeps the case it was given); git commit-tree
// writes the id lowercase, and so does ply: an upper-case id is the same object (test/want-oracle.test.js).
function headerOid(value: string, what: 'tree' | 'parent'): Result<Oid, BadRequest> {
  const id = parseOid(value.toLowerCase());
  return id.ok ? id : fail('bad_request', `commit: ${what}: ${id.error.message}`, { what, got: value });
}
const COMMIT_FIELDS = ['tree', 'parents', 'author', 'committer', 'encoding', 'extra', 'message'] as const;
// A commit field read back against the one given: a string or null, or a list of strings, element for element.
function sameField(back: string | null | readonly string[], given: string | null | readonly string[]): boolean {
  if (typeof back === 'string' || back === null || typeof given === 'string' || given === null) return back === given;
  return back.length === given.length && back.every((line, i) => line === given[i]);
}
export function encodeCommitOf({ tree, parents, author, committer = author, encoding = null, message = null, extra = [] }: CommitIds): Result<Uint8Array<ArrayBuffer>, BadRequest> {
  const values: Array<readonly [unknown, string]> = [[author, 'author'], [committer, 'committer']];
  if (encoding !== null) values.push([encoding, 'encoding']);
  for (const line of extra) values.push([line, 'extra']);
  const headed = headerValues(values);
  if (!headed.ok) return headed;
  const body = messageBody(message);
  if (!body.ok) return body;
  const lines = [
    `${COMMIT_HEADER_TREE} ${tree}`,
    ...parents.map(p => `${COMMIT_HEADER_PARENT} ${p}`),
    `${COMMIT_HEADER_AUTHOR} ${author}`,
    `${COMMIT_HEADER_COMMITTER} ${committer}`,
  ];
  if (encoding !== null) lines.push(`${COMMIT_HEADER_ENCODING} ${encoding}`);
  lines.push(...extra);
  const bytes = encodeBytes(`${lines.join('\n')}\n${message === null ? '' : `\n${message}`}`, 'commit');
  if (!bytes.ok) return bytes;
  // Held to the reader, as encodeTag is: what parseCommit refuses (an ident fsck refuses, an extra line that shadows
  // tree, parent, author, committer or encoding) is the caller's bad request, and so is a commit that would read back
  // as another one (an empty extra line ends the header; an `encoding ` extra line is the encoding). The parent bound
  // is the reader's own choice, so it is not applied here. Every message below is fixed text.
  const parsed = parseCommit(bytes.value, parents.length > DEFAULT_LIMITS.maxCommitParents ? { maxCommitParents: parents.length } : DEFAULT_LIMITS);
  if (!parsed.ok) return fail('bad_request', parsed.error.message, { what: 'commit' });
  const back = parsed.value;
  const given: Commit = { tree, parents: [...parents], author, committer, encoding, extra: [...extra], message };
  for (const field of COMMIT_FIELDS) {
    if (!sameField(back[field], given[field])) return fail('bad_request', `commit: ${field} would not read back as given`, { what: field });
  }
  return bytes;
}

// A caller's commit, its ids parsed once: the tree and parent header values are checked first (a NUL or newline is that
// refusal, as before), then the tree id, then each parent's in order, then the rest (encodeCommitOf).
export function encodeCommit(input: CommitInput): Result<Uint8Array<ArrayBuffer>, BadRequest> {
  const { tree, parents = [] } = input;
  const headed = headerValues([[tree, 'tree'], ...parents.map((p): readonly [unknown, string] => [p, 'parent'])]);
  if (!headed.ok) return headed;
  const treeId = headerOid(tree, 'tree');
  if (!treeId.ok) return treeId;
  const parentIds: Oid[] = [];
  for (const p of parents) {
    const id = headerOid(p, 'parent');
    if (!id.ok) return id;
    parentIds.push(id.value);
  }
  return encodeCommitOf({ ...input, tree: treeId.value, parents: parentIds });
}

// The four types a tag can name (git's type_from_string_gently: object_type_strings, nothing else).
export type TagTargetType = keyof typeof TYPE_ID;
// An annotated tag: `tag` is the short name (`v1`, not `refs/tags/v1`); `tagger` an ident line (ident(validateIdent(…))).
// message and extra may be left out.
export type TagConfig = {
  readonly object: string; readonly type: TagTargetType; readonly tag: string; readonly tagger: string;
  readonly message: string | null; readonly extra: readonly string[];
};
export type TagInput = Pick<TagConfig, 'object' | 'type' | 'tag' | 'tagger'> & Input<Pick<TagConfig, 'message' | 'extra'>>;
// git's annotated-tag object bytes (`git tag -a`, `git mktag`): object, type, tag and tagger lines, the extra header
// lines, then a blank line and the message verbatim (null: no body section; git's own tags end the message with a
// newline, which the caller adds). A signature is part of the message, as `git tag -s` appends its armored block to
// the body. Refuses (bad_request) what `git hash-object -t tag` refuses, which is fsck_tag_standalone with every
// message an error: a bad object id, a type outside the four, a tag name that is not a refname under refs/tags/
// (check_refname_format), a bad tagger ident; and a NUL or newline in a header value or a NUL in the message. So the
// bytes hash (hashObject('tag', …)) to an object git stores as is.
export function encodeTag({ object, type, tag, tagger, message = null, extra = [] }: TagInput): Result<Uint8Array<ArrayBuffer>, BadRequest> {
  const values: Array<readonly [unknown, string]> = [[object, 'object'], [type, 'type'], [tag, 'tag'], [tagger, 'tagger']];
  for (const line of extra) values.push([line, 'extra']);
  const headed = headerValues(values);
  if (!headed.ok) return headed;
  const body = messageBody(message);
  if (!body.ok) return body;
  const lines = [
    `${TAG_HEADER_OBJECT} ${object}`, `${TAG_HEADER_TYPE} ${type}`, `${TAG_HEADER_TAG} ${tag}`, `${TAG_HEADER_TAGGER} ${tagger}`,
    ...extra,
  ];
  const bytes = encodeBytes(`${lines.join('\n')}\n${message === null ? '' : `\n${message}`}`, 'tag');
  if (!bytes.ok) return bytes;
  // fsck_tag_standalone's badTagName is check_refname_format("refs/tags/<tag>", 0), validateRef's rule; the rest
  // (badObjectSha1, badType, the tagger's fsck_ident) is parseTag's. Either refusal is the caller's bad request.
  if (!validateRef(`refs/tags/${tag}`).ok) return fail('bad_request', "tag: badTagName: invalid 'tag' name", { what: 'tag' });
  const parsed = parseTag(bytes.value);
  if (!parsed.ok) return fail('bad_request', parsed.error.message, { what: 'tag' });
  return bytes;
}
