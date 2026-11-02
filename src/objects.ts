// Git object encoding/decoding. All pure. Every function that can refuse returns a Result.
import { fail } from './errors.js';
import type { Err, Ok, Result } from './result.js';
import { ok, err, map, assertNever } from './result.js';
import type { ErrorOf } from './errors.js';
import { Sha1, toHex, fromHex } from './sha1.js';
import { te, td, concat, take, decodeBytes, encodeBytes } from './bytes.js';
import { isDotGitName, isDotFileName, isValidatedIdent, validateRef } from './validate.js';
import type { ValidatedIdent } from './validate.js';
import { DEFAULT_LIMITS, limitError, readLimit } from './limits.js';
import type { Limits } from './limits.js';
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

export function hashObject(typeName: string, data: Uint8Array): string {
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
const isDirMode = (mode: string): boolean => (lowBits(mode) & MODE_S_IFMT) === MODE_S_IFDIR;
// object.h canon_mode on the low 16 bits (tree-walk keeps the mode in a uint16_t): every reader of a tree but fsck sees
// this. A regular file is 100755 if the owner may execute it, else 100644 (100664 → 100644, 100700 → 100755); S_IFLNK is
// a symlink, S_IFDIR a tree (40755 → 40000); every other type is a gitlink (1, 160644, 777777 → 160000). `7100644`
// and `300644` are 100644 to git, without even a badFilemode warning.
export type Mode = typeof MODE_BLOB | typeof MODE_EXEC | typeof MODE_LINK | typeof MODE_TREE | typeof MODE_COMMIT;
export function canonMode(mode: string): Mode {
  const m = lowBits(mode), type = m & MODE_S_IFMT;
  if (type === MODE_S_IFREG) return m & MODE_OWNER_EXEC ? MODE_EXEC : MODE_BLOB;
  if (type === MODE_S_IFLNK) return MODE_LINK;
  if (type === MODE_S_IFDIR) return MODE_TREE;
  return MODE_COMMIT;
}
const SLASH = Uint8Array.of(TREE_SORT_SLASH);

export type TreeEntry = { readonly mode: Mode; readonly name: string; readonly oid: string; readonly oidOffset: number; readonly entryOffset: number };
// What encodeTree and treeSort take: a caller's entries, or parsed ones.
export type TreeEntryInput = { readonly mode: string; readonly name: string; readonly oid: string };

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
// name, which is what exhausted a 128 MiB heap at the cap. `bytes` is not enumerable, so equality and JSON see the
// mode, the name, and the offsets.
type TreeEntryState = { readonly bytes: Uint8Array; readonly oidOffset: number };
const treeEntryProto: TreeEntry = Object.create(null);
Object.defineProperty(treeEntryProto, 'oid', {
  get(this: TreeEntryState): string {
    return toHex(this.bytes.subarray(this.oidOffset, this.oidOffset + OID_BYTES));
  },
});
// One prototype per tree carries the buffer. Entries are ordinary assigned objects: defineProperty on every
// entry puts it in dictionary mode, and that is what exhausted a 128 MiB heap at the cap.
const treeBytes = (bytes: Uint8Array): TreeEntry => {
  const proto: TreeEntry = Object.create(treeEntryProto);
  Object.defineProperty(proto, 'bytes', { value: bytes });
  return proto;
};
const treeEntry = (proto: TreeEntry, mode: Mode, name: string, oidOffset: number, entryOffset: number): TreeEntry =>
  Object.assign(Object.create(proto), { mode, name, oidOffset, entryOffset });

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
export function parseTree(data: Uint8Array, limits: Partial<Limits> = DEFAULT_LIMITS): Result<TreeEntry[], ObjectError> {
  const cap = readLimit(limits, 'maxTreeEntries');
  if (!cap.ok) return cap;
  const maxEntries = cap.value;
  // Shorter than one minimum entry per allowed slot: the count cannot pass the cap, so skip the frame scan.
  // A flipped comparison here still agrees with the frame count (max+1 minimum frames cannot fit in fewer bytes).
  // Stryker disable next-line ConditionalExpression,EqualityOperator,ArithmeticOperator: byte length only skips the scan; the frame count decides the cap
  const wide = data.length > maxEntries * TREE_ENTRY_MIN;
  // Stryker disable next-line ConditionalExpression,EqualityOperator: past the cap the loop refuses either way; this flag only skips retaining entries the caller never sees
  const over = wide && completeTreeFrames(data, maxEntries) > maxEntries;
  const entries: TreeEntry[] = [];
  const shape = treeBytes(data);
  const seen = new Set<string>();
  let p = 0;
  let count = 0;
  let prevKey: Uint8Array | null = null;
  while (p < data.length) {
    if (count >= maxEntries) return err(limitError('tree entries', count + 1, maxEntries));
    const sp = data.indexOf(TREE_MODE_SEP, p);
    // A negative fromIndex would wrap; indexOf returns -1 when the separator is absent.
    if (sp < p) return badTree('malformed entry');
    const nul = data.indexOf(TREE_NUL, sp + 1);
    if (nul < sp + 1) return badTree('malformed entry');
    // p <= sp < nul < data.length (the two checks above): the mode and the name are views, they cannot be short
    const raw: string = td.decode(data.subarray(p, sp));
    // The name is bytes to git: decodeBytes keeps a leading BOM and escapes ill-formed UTF-8, so the string maps back (#43)
    const nameBytes: Uint8Array = data.subarray(sp + 1, nul);
    const name: string = decodeBytes(nameBytes);
    // The id starts at nul+1. take demands OID_BYTES bytes there; the old `nul + OID_BYTES > length`
    // guard counted from the NUL and let a 19-byte id through.
    const oid = take(data, nul + 1, OID_BYTES);
    if (!oid.ok) return oid;
    const oidBytes: Uint8Array = oid.value;
    if (raw.length === 0) return badTree('empty mode');
    if (!/^[0-7]+$/u.test(raw)) return badTree('malformed mode');
    // decode_tree_entry refuses an empty name before fsck_tree looks at the mode's first byte
    if (name.length === 0) return badTree('empty name');
    if (raw[0] === '0') return badTree('zero-padded mode');
    const mode = canonMode(raw);
    if (name.includes('/')) return badTree('full pathname');
    if (name === '.' || name === '..' || isDotGitName(nameBytes)) return badTree('bad name');
    if (nameBytes.length > TREE_MAX_NAME_BYTES) return badTree('large pathname');
    if (oidBytes.every(b => b === 0)) return badTree('null sha1');
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
    const key: Uint8Array = isDirMode(raw) ? concat([nameBytes, SLASH]) : nameBytes;
    // Stryker disable next-line EqualityOperator: equal keys are equal names (a name holds no '/'), which the duplicate check above refused
    if (prevKey !== null && cmpBytes(prevKey, key) >= 0) return badTree('not strictly sorted');
    prevKey = key;
    // Past the cap, keep the name set (a bad prefix is still pack_corrupt) and do not retain the entry.
    // Always pushing still refuses on the next entry, so the returned array is the same; never pushing is a length assertion.
    // Stryker disable next-line ConditionalExpression: retaining the entries past the cap does not change the refusal or the array a caller sees
    if (!over) entries.push(treeEntry(shape, mode, name, nul + 1, p));
    count += 1;
    p = nul + 1 + OID_BYTES;
  }
  return ok(entries);
}

type Sortable = { readonly mode: string; readonly name: string };
const sortKey = (e: Sortable): string => (e.mode === MODE_TREE ? `${e.name}/` : e.name);
// git's tree order on the names' bytes. A name with no byte form is refused: the first one the sort compares (a sort
// of one entry compares none). Once one is refused the rest of the sort is moot; the comparison it is in sees no bytes.
const NO_BYTES = new Uint8Array(0);
export function treeSort<T extends Sortable>(entries: Iterable<T>): Result<T[], BadRequest> {
  let refused: Result<null, BadRequest> = DONE;
  const keyOf = (e: Sortable): Uint8Array => {
    const k = encodeBytes(sortKey(e), 'tree entry name');
    if (k.ok) return k.value;
    if (refused.ok) refused = k;
    return NO_BYTES;
  };
  // oxlint-disable-next-line unicorn/no-array-sort -- sorts its own copy; the spread keeps any iterable a caller passes working
  const sorted = [...entries].sort((a, b) => cmpBytes(keyOf(a), keyOf(b)));
  return refused.ok ? ok(sorted) : refused;
}

// git fsck `duplicateEntries`: one name twice in one tree, whatever the modes. A file `a` and a directory `a` do not sort
// next to each other (`a` < `a.b` < `a/`), so the check is by name, not by neighbour. Case-only twins (`README` and
// `readme`) are two names to git and to fsck; they collide only on a case-insensitive checkout, and are accepted here too.
// Each entry's line is encoded (in the caller's order) before the sort: a name that is no byte sequence is refused there,
// and the sort's own encoding of the same name cannot fail.
export function encodeTree(entries: readonly TreeEntryInput[]): Result<Uint8Array, BadRequest> {
  const names = new Set<string>();
  for (const e of entries) {
    if (names.has(e.name)) return fail('bad_request', `tree: duplicate entry ${JSON.stringify(e.name)}`, { what: 'tree entry', entry: e.name });
    names.add(e.name);
  }
  const lines: Array<TreeEntryInput & { readonly line: Uint8Array }> = [];
  for (const e of entries) {
    const line = encodeBytes(`${e.mode} ${e.name}\0`, 'tree entry name');
    if (!line.ok) return line;
    lines.push({ mode: e.mode, name: e.name, oid: e.oid, line: line.value });
  }
  return map(treeSort(lines), sorted => concat(sorted.flatMap(e => [e.line, fromHex(e.oid)])));
}

// Replace the oid of one entry in place; returns new bytes + coordinates for a structural delta.
export function treeReplaceOid(data: Uint8Array, entry: { readonly oidOffset: number }, newOidHex: string): Uint8Array {
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
const HEX = /^[0-9a-fA-F]$/u;
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

// parse_oid_hex then '\n': 40 hex digits of either case (git stores the binary id, so it prints lowercase).
// charAt past the end is '', which is no hex digit.
function oidLine(s: string, p: number, kind: string, msgId: string, what: string): Result<string, Corrupt> {
  for (let i = 0; i < OID_HEX_CHARS; i++) if (!HEX.test(s.charAt(p + i))) return corrupt(kind, msgId, `invalid '${what}' line format - bad sha1`);
  if (s[p + OID_HEX_CHARS] !== '\n') return corrupt(kind, msgId, `invalid '${what}' line format - bad sha1`);
  return ok(s.slice(p, p + OID_HEX_CHARS).toLowerCase());
}


// fsck.c fsck_ident on the line that starts at p (after "author "); returns [the ident text, the index after its
// newline]. The checks and their order are git's: a leading '<', a '>' before the '<', no '<', no space before '<',
// no '>' after the email, no space after '>', then spaces or tabs, a digit, no leading zero unless the date is "0",
// no overflow past git's timestamp range, one space, a sign, IDENT_TZ_DIGITS digits, and the newline.
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
  if (BigInt(s.slice(start, q)) > IDENT_TIMESTAMP_MAX) return bad('badDateOverflow', 'date causes integer overflow');
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

export type Commit = {
  readonly tree: string; readonly parents: string[]; readonly author: string; readonly committer: string;
  readonly encoding: string | null; readonly extra: string[]; readonly message: string | null;
};
// @decoder parseCommit prefix=commit
export function parseCommit(data: Uint8Array, limits: Partial<Limits> = DEFAULT_LIMITS): Result<Commit, ObjectError> {
  const cap = readLimit(limits, 'maxCommitParents');
  if (!cap.ok) return cap;
  const maxParents = cap.value;
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
  const parents: string[] = [];
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
// reader would accept never reaches one.
export function assertFetched(typeName: string, data: Uint8Array, limits: Partial<Limits> = DEFAULT_LIMITS): Result<null, ObjectError> {
  const found = wireTypeName(typeName);
  switch (found.tag) {
    case 'invalid': return fail('pack_corrupt', `object: bad type ${typeName}`);
    case 'named': {
      switch (found.name) {
        case 'blob': case 'ofs_delta': case 'ref_delta': return DONE;
        case 'tree': { const r = parseTree(data, limits); return r.ok ? DONE : r; }
        case 'commit': { const r = parseCommit(data, limits); return r.ok ? DONE : r; }
        case 'tag': { const r = parseTag(data); return r.ok ? DONE : r; }
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
// message and extra may be left out.
export type CommitConfig = {
  readonly tree: string; readonly parents: readonly string[]; readonly author: string; readonly committer: string;
  readonly encoding: string | null; readonly message: string | null; readonly extra: readonly string[];
};
export type CommitInput = { readonly tree: string; readonly author: string } & Input<Omit<CommitConfig, 'tree' | 'author'>>;
export function encodeCommit({ tree, parents = [], author, committer = author, encoding = null, message = null, extra = [] }: CommitInput): Result<Uint8Array<ArrayBuffer>, BadRequest> {
  const values: Array<readonly [unknown, string]> = [[tree, 'tree']];
  for (const p of parents) values.push([p, 'parent']);
  values.push([author, 'author'], [committer, 'committer']);
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
  return encodeBytes(`${lines.join('\n')}\n${message === null ? '' : `\n${message}`}`, 'commit');
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
