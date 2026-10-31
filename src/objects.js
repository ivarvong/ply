// Git object encoding/decoding. All pure.
import { fail } from './errors.js';
import { Sha1, toHex, fromHex } from './sha1.js';
import { te, td, concat, take, decodeBytes, encodeBytes } from './bytes.js';
import { isDotGitName, isDotFileName, isValidatedIdent } from './validate.js';
import { DEFAULT_LIMITS, limitError, requireLimit } from './limits.js';
import {
  OID_BYTES, OID_HEX_CHARS, TREE_MODE_SEP, TREE_NUL, MODE_TREE, MODE_BLOB, MODE_EXEC, MODE_LINK, MODE_COMMIT, IDENT_TZ_DIGITS, IDENT_TIMESTAMP_MAX,
  MODE_S_IFREG, MODE_S_IFLNK, MODE_OWNER_EXEC, TREE_MAX_NAME_BYTES,
  MODE_S_IFMT, MODE_S_IFDIR, MODE_BITS, MODE_LOW_DIGITS, TREE_SORT_SLASH,
  OBJ_COMMIT, OBJ_TREE, OBJ_BLOB, OBJ_TAG, OBJ_OFS_DELTA, OBJ_REF_DELTA,
  COMMIT_HEADER_TREE, COMMIT_HEADER_PARENT, COMMIT_HEADER_AUTHOR, COMMIT_HEADER_COMMITTER, COMMIT_HEADER_ENCODING,
  TAG_HEADER_OBJECT, TAG_HEADER_TYPE, TAG_HEADER_TAG, TAG_HEADER_TAGGER,
} from './format.js';

export const TYPE = Object.freeze({ COMMIT: OBJ_COMMIT, TREE: OBJ_TREE, BLOB: OBJ_BLOB, TAG: OBJ_TAG, OFS_DELTA: OBJ_OFS_DELTA, REF_DELTA: OBJ_REF_DELTA });
export const TYPE_NAME = Object.freeze({ [OBJ_COMMIT]: 'commit', [OBJ_TREE]: 'tree', [OBJ_BLOB]: 'blob', [OBJ_TAG]: 'tag', [OBJ_OFS_DELTA]: 'ofs_delta', [OBJ_REF_DELTA]: 'ref_delta' });
export const TYPE_ID = Object.freeze({ commit: OBJ_COMMIT, tree: OBJ_TREE, blob: OBJ_BLOB, tag: OBJ_TAG });

export const objectHeader = (typeName, len) => te.encode(`${typeName} ${len}\0`);

export function hashObject(typeName, data) {
  return new Sha1().update(objectHeader(typeName, data.length)).update(data).hex();
}

const cmpBytes = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};

// ---- tree ----
// fsck.c verify_ordered sorts an entry as a directory when S_ISDIR holds for the low 16 bits of its mode: `40755` sorts
// as a directory (fsck only warns about the mode), `160000` as a file.
const lowBits = mode => parseInt(mode.slice(-MODE_LOW_DIGITS), 8) & MODE_BITS;
const isDirMode = mode => (lowBits(mode) & MODE_S_IFMT) === MODE_S_IFDIR;
// object.h canon_mode on the low 16 bits (tree-walk keeps the mode in a uint16_t): every reader of a tree but fsck sees
// this. A regular file is 100755 if the owner may execute it, else 100644 (100664 → 100644, 100700 → 100755); S_IFLNK is
// a symlink, S_IFDIR a tree (40755 → 40000); every other type is a gitlink (1, 160644, 777777 → 160000). `7100644`
// and `300644` are 100644 to git, without even a badFilemode warning.
export function canonMode(mode) {
  const m = lowBits(mode), type = m & MODE_S_IFMT;
  if (type === MODE_S_IFREG) return m & MODE_OWNER_EXEC ? MODE_EXEC : MODE_BLOB;
  if (type === MODE_S_IFLNK) return MODE_LINK;
  if (type === MODE_S_IFDIR) return MODE_TREE;
  return MODE_COMMIT;
}
const SLASH = Uint8Array.of(TREE_SORT_SLASH);

// entry: { mode: '100644'|'100755'|'120000'|'40000'|'160000', name, oid (hex), oidOffset }
// Duplicates and order are git's rules (fsck duplicateEntries and treeNotSorted, both errors under --strict) on the
// raw name bytes. A file `d` and a directory `d` need not be neighbours (`d` < `d.x` < `d/`), so the duplicate check is
// over the whole tree, as fsck's verify_ordered does with its stack of file names a later directory could repeat. It
// runs before the order check: by then every earlier pair was in order, and on a sorted prefix fsck's stack finds
// exactly the duplicates this set finds, so the message is one fsck prints. Names decode losslessly (decodeBytes, #43):
// distinct bytes are distinct names, so the raw-byte duplicate check is also the decoded-name one.
// @decoder parseTree prefix=tree
export function parseTree(data, limits = DEFAULT_LIMITS) {
  const maxEntries = requireLimit(limits, 'maxTreeEntries');
  const entries = [];
  const seen = new Set();
  let p = 0;
  let prevKey = null;
  while (p < data.length) {
    if (entries.length >= maxEntries) throw limitError('tree entries', entries.length + 1, maxEntries);
    const sp = data.indexOf(TREE_MODE_SEP, p);
    // A negative fromIndex would wrap; indexOf returns -1 when the separator is absent.
    if (sp < p) throw fail('pack_corrupt', 'tree: malformed entry');
    const nul = data.indexOf(TREE_NUL, sp + 1);
    if (nul < sp + 1) throw fail('pack_corrupt', 'tree: malformed entry');
    const raw = td.decode(take(data, p, sp - p));
    // The name is bytes to git: decodeBytes keeps a leading BOM and escapes ill-formed UTF-8, so the string maps back (#43)
    const nameBytes = take(data, sp + 1, nul - (sp + 1));
    const name = decodeBytes(nameBytes);
    // The id starts at nul+1. take() demands OID_BYTES bytes there; the old `nul + OID_BYTES > length`
    // guard counted from the NUL and let a 19-byte id through.
    const oidBytes = take(data, nul + 1, OID_BYTES);
    if (raw.length === 0) throw fail('pack_corrupt', 'tree: empty mode');
    if (!/^[0-7]+$/.test(raw)) throw fail('pack_corrupt', 'tree: malformed mode');
    // decode_tree_entry refuses an empty name before fsck_tree looks at the mode's first byte
    if (name.length === 0) throw fail('pack_corrupt', 'tree: empty name');
    if (raw[0] === '0') throw fail('pack_corrupt', 'tree: zero-padded mode');
    const mode = canonMode(raw);
    if (name.indexOf('/') >= 0) throw fail('pack_corrupt', 'tree: full pathname');
    if (name === '.' || name === '..' || isDotGitName(nameBytes)) throw fail('pack_corrupt', 'tree: bad name');
    if (nameBytes.length > TREE_MAX_NAME_BYTES) throw fail('pack_corrupt', 'tree: large pathname');
    if (oidBytes.every(b => b === 0)) throw fail('pack_corrupt', 'tree: null sha1');
    // fsck_tree: a .gitmodules (any spelling) that is a symlink is gitmodulesSymlink; one that is not a blob (a tree, or a
    // gitlink, whose commit is never in the repository) is gitmodulesBlob / gitmodulesMissing in fsck_finish. The same
    // for .gitattributes, except that as a symlink it is only a warning (gitattributesSymlink, INFO)
    if (isDotFileName(nameBytes, 'gitmodules')) {
      if (mode === MODE_LINK) throw fail('pack_corrupt', 'tree: .gitmodules is a symbolic link');
      if (mode === MODE_TREE || mode === MODE_COMMIT) throw fail('pack_corrupt', 'tree: .gitmodules is not a blob');
    }
    if ((mode === MODE_TREE || mode === MODE_COMMIT) && isDotFileName(nameBytes, 'gitattributes')) throw fail('pack_corrupt', 'tree: .gitattributes is not a blob');
    const rawName = toHex(nameBytes);
    if (seen.has(rawName)) throw fail('pack_corrupt', `tree: duplicate entry ${JSON.stringify(name)}`);
    seen.add(rawName);
    const key = isDirMode(raw) ? concat([nameBytes, SLASH]) : nameBytes;
    // Stryker disable next-line EqualityOperator: equal keys are equal names (a name holds no '/'), which the duplicate check above refused
    if (prevKey !== null && cmpBytes(prevKey, key) >= 0) throw fail('pack_corrupt', 'tree: not strictly sorted');
    prevKey = key;
    entries.push({ mode, name, oid: toHex(oidBytes), oidOffset: nul + 1, entryOffset: p });
    p = nul + 1 + OID_BYTES;
  }
  return entries;
}

const sortKey = e => (e.mode === MODE_TREE ? e.name + '/' : e.name);
export function treeSort(entries) {
  return [...entries].sort((a, b) => cmpBytes(encodeBytes(sortKey(a), 'tree entry name'), encodeBytes(sortKey(b), 'tree entry name')));
}

// git fsck `duplicateEntries`: one name twice in one tree, whatever the modes. A file `a` and a directory `a` do not sort
// next to each other (`a` < `a.b` < `a/`), so the check is by name, not by neighbour. Case-only twins (`README` and
// `readme`) are two names to git and to fsck; they collide only on a case-insensitive checkout, and are accepted here too.
export function encodeTree(entries) {
  const names = new Set();
  for (const e of entries) {
    if (names.has(e.name)) throw fail('bad_request', `tree: duplicate entry ${JSON.stringify(e.name)}`, { what: 'tree entry', entry: e.name });
    names.add(e.name);
  }
  return concat(treeSort(entries).flatMap(e => [encodeBytes(`${e.mode} ${e.name}\0`, 'tree entry name'), fromHex(e.oid)]));
}

// Replace the oid of one entry in place; returns new bytes + coordinates for a structural delta.
export function treeReplaceOid(data, entry, newOidHex) {
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
// %P ignores, and a second tag object/type/name that the parsed tag ignores), so whatever ply showed, some git view would contradict it: an author-spoofing differential. Those throw
// `duplicateHeader` (`commit: duplicate tree`). A missing tagger and a tag name that is not a refname are warnings git accepts (INFO
// under --strict), so ply accepts them too. The object is decoded losslessly (decodeBytes, #43): a leading BOM is kept,
// so a BOM before `tree` is a missing tree, as in git, and an ill-formed UTF-8 byte becomes an escape (a lone surrogate)
// that encodeBytes maps back to the same byte, so a Latin-1 message or ident re-encodes to its own bytes. No rule here
// matches an escape, and an escape can never form a NUL, a newline or any other delimiter.
const HEX = /^[0-9a-fA-F]$/;
const DIGIT = /^[0-9]$/;

const BLANK_LINE = '\n\n';
const NO_BODY = -1;
const corrupt = (kind, msgId, why) => fail('pack_corrupt', `${kind}: ${msgId}: ${why}`, { msgId });

// fsck.c verify_headers: no NUL before the first blank line, and a header without a blank line ends in a newline.
// Returns the index of the blank line's first newline, or -1 when there is no body section.
function verifyHeaders(s, kind) {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\0') throw corrupt(kind, 'nulInHeader', `unterminated header: NUL at offset ${i}`);
    if (ch === '\n' && s[i + 1] === '\n') return i;
  }
  if (s.length && s.endsWith('\n')) return NO_BODY;
  throw corrupt(kind, 'unterminatedHeader', 'unterminated header');
}

// parse_oid_hex then '\n': 40 hex digits of either case (git stores the binary id, so it prints lowercase).
function oidLine(s, p, kind, msgId, what) {
  for (let i = 0; i < OID_HEX_CHARS; i++) if (!HEX.test(s[p + i] ?? '')) throw corrupt(kind, msgId, `invalid '${what}' line format - bad sha1`);
  if (s[p + OID_HEX_CHARS] !== '\n') throw corrupt(kind, msgId, `invalid '${what}' line format - bad sha1`);
  return s.slice(p, p + OID_HEX_CHARS).toLowerCase();
}

// fsck.c fsck_ident on the line that starts at p (after "author "); returns [the ident text, the index after its
// newline]. The checks and their order are git's: a leading '<', a '>' before the '<', no '<', no space before '<',
// no '>' after the email, no space after '>', then spaces or tabs, a digit, no leading zero unless the date is "0",
// no overflow past git's timestamp range, one space, a sign, IDENT_TZ_DIGITS digits, and the newline.
function fsckIdent(s, p, kind, role) {
  const eol = s.indexOf('\n', p);
  const end = eol < 0 ? s.length : eol;
  const bad = (msgId, why) => corrupt(kind, msgId, `invalid ${role} line - ${why}`);
  if (s[p] === '<') throw bad('missingNameBeforeEmail', 'missing space before email');
  let q = p;
  while (q < end && s[q] !== '<' && s[q] !== '>') q++;
  if (s[q] === '>') throw bad('badName', 'bad name');
  if (s[q] !== '<') throw bad('missingEmail', 'missing email');
  if (s[q - 1] !== ' ') throw bad('missingSpaceBeforeEmail', 'missing space before email');
  q++;
  while (q < end && s[q] !== '<' && s[q] !== '>') q++;
  if (s[q] !== '>') throw bad('badEmail', 'bad email');
  q++;
  if (s[q] !== ' ') throw bad('missingSpaceBeforeDate', 'missing space before date');
  q++;
  while (s[q] === ' ' || s[q] === '\t') q++;
  if (!DIGIT.test(s[q] ?? '')) throw bad('badDate', 'bad date');
  if (s[q] === '0' && s[q + 1] !== ' ') throw bad('zeroPaddedDate', 'zero-padded date');
  const start = q;
  while (DIGIT.test(s[q] ?? '')) q++;
  if (BigInt(s.slice(start, q)) > IDENT_TIMESTAMP_MAX) throw bad('badDateOverflow', 'date causes integer overflow');
  if (s[q] !== ' ') throw bad('badDate', 'bad date');
  q++;
  if (s[q] !== '+' && s[q] !== '-') throw bad('badTimezone', 'bad time zone');
  for (let i = 1; i <= IDENT_TZ_DIGITS; i++) if (!DIGIT.test(s[q + i] ?? '')) throw bad('badTimezone', 'bad time zone');
  if (s[q + IDENT_TZ_DIGITS + 1] !== '\n') throw bad('badTimezone', 'bad time zone');
  return [s.slice(p, end), end + 1];
}

// The header lines after the last one fsck reads, up to the blank line (or the end), and the message after it.
function rest(s, p, blank) {
  const headEnd = blank === NO_BODY ? s.length : blank + 1;
  const tail = s.slice(p, headEnd);
  // every header line ends in a newline (verify_headers), so the tail is whole lines; drop the last terminator
  return { extra: tail.length ? tail.slice(0, tail.length - 1).split('\n') : [], message: blank === NO_BODY ? null : s.slice(blank + BLANK_LINE.length) };
}

// The allowed typed refusal above: fsck accepts the object, git's views of it disagree, ply refuses. A line after the
// committer that starts `parent ` is a parent cat-file shows and %P does not; PR #7 named it a bad header order.
const COMMIT_SHADOWED = [COMMIT_HEADER_TREE, COMMIT_HEADER_PARENT, COMMIT_HEADER_AUTHOR, COMMIT_HEADER_COMMITTER];
const TAG_SHADOWED = [TAG_HEADER_OBJECT, TAG_HEADER_TYPE, TAG_HEADER_TAG, TAG_HEADER_TAGGER];
const duplicate = (kind, key) => fail('pack_corrupt', key === COMMIT_HEADER_PARENT && kind === 'commit' ? 'commit: bad header order' : `${kind}: duplicate ${key}`, { msgId: 'duplicateHeader' });
function refuseShadowed(kind, extra, keys) {
  for (const l of extra) for (const key of keys) if (l.startsWith(`${key} `)) throw duplicate(kind, key);
}

// @decoder parseCommit prefix=commit
export function parseCommit(data, limits = DEFAULT_LIMITS) {
  const maxParents = requireLimit(limits, 'maxCommitParents');
  const s = decodeBytes(data);
  const blank = verifyHeaders(s, 'commit');
  const has = (p, key) => s.startsWith(`${key} `, p);
  if (!has(0, COMMIT_HEADER_TREE)) throw corrupt('commit', 'missingTree', "invalid format - expected 'tree' line");
  let p = COMMIT_HEADER_TREE.length + 1;
  const tree = oidLine(s, p, 'commit', 'badTreeSha1', COMMIT_HEADER_TREE);
  p += OID_HEX_CHARS + 1;
  const parents = [];
  while (has(p, COMMIT_HEADER_PARENT)) {
    p += COMMIT_HEADER_PARENT.length + 1;
    parents.push(oidLine(s, p, 'commit', 'badParentSha1', COMMIT_HEADER_PARENT));
    if (parents.length > maxParents) throw limitError('commit parents', parents.length, maxParents);
    p += OID_HEX_CHARS + 1;
  }
  const authors = [];
  while (has(p, COMMIT_HEADER_AUTHOR)) {
    const [who, next] = fsckIdent(s, p + COMMIT_HEADER_AUTHOR.length + 1, 'commit', COMMIT_HEADER_AUTHOR);
    authors.push(who);
    p = next;
  }
  if (authors.length < 1) throw corrupt('commit', 'missingAuthor', "invalid format - expected 'author' line");
  if (authors.length > 1) throw corrupt('commit', 'multipleAuthors', "invalid format - multiple 'author' lines");
  if (!has(p, COMMIT_HEADER_COMMITTER)) throw corrupt('commit', 'missingCommitter', "invalid format - expected 'committer' line");
  const [committer, next] = fsckIdent(s, p + COMMIT_HEADER_COMMITTER.length + 1, 'commit', COMMIT_HEADER_COMMITTER);
  // fsck_commit's last check is over the whole object; verify_headers already refused a NUL in the header
  if (s.includes('\0')) throw corrupt('commit', 'nulInCommit', 'NUL byte in the commit object body');
  const { extra, message } = rest(s, next, blank);
  refuseShadowed('commit', extra, COMMIT_SHADOWED);
  const at = extra.findIndex(l => l.startsWith(`${COMMIT_HEADER_ENCODING} `));
  const encoding = at < 0 ? null : extra.splice(at, 1)[0].slice(COMMIT_HEADER_ENCODING.length + 1);
  // a second encoding is a second copy of a single-valued header
  if (extra.some(l => l.startsWith(`${COMMIT_HEADER_ENCODING} `))) throw duplicate('commit', COMMIT_HEADER_ENCODING);
  return { tree, parents, author: authors[0], committer, encoding, extra, message };
}

export function ident(person) {
  if (!isValidatedIdent(person)) throw fail('bad_request', 'ident: unvalidated identity', { what: 'ident' });
  return `${person.name} <${person.email}> ${person.time} ${person.tz}`;
}

// The inverse, as git's split_ident_line reads it: name up to the first '<' (trailing spaces trimmed), email up to the
// next '>', then "<epoch> <tz>" after the last '>'. Fields git would print as empty are '' (time null when the date is missing).
// @decoder parseIdent prefix=ident
export function parseIdent(line) {
  if (typeof line !== 'string') return null;
  const lt = line.indexOf('<');
  if (lt < 0) return { name: line.trim(), email: '', time: null, tz: '' };
  const gt = line.indexOf('>', lt + 1);
  // Stryker disable next-line EqualityOperator: indexOf from lt + 1 cannot return 0, so <= and < reject the same missing '>'
  if (gt < 0) return { name: line.trim(), email: '', time: null, tz: '' };
  const parts = line.slice(line.lastIndexOf('>') + 1).trim().split(/\s+/);
  // Stryker disable next-line StringLiteral: a missing time fails the digit test the same way any non-numeric default does
  const time = parts[0] ?? '';
  const tz = parts[1] ?? '';
  return { name: line.slice(0, lt).trimEnd(), email: line.slice(lt + 1, gt), time: /^\d+$/.test(time) ? time : null, tz };
}

// ---- tag (annotated): fsck.c fsck_tag_standalone ----
// @decoder parseTag prefix=tag
export function parseTag(data) {
  const s = decodeBytes(data);
  const blank = verifyHeaders(s, 'tag');
  const has = (p, key) => s.startsWith(`${key} `, p);
  if (!has(0, TAG_HEADER_OBJECT)) throw corrupt('tag', 'missingObject', "invalid format - expected 'object' line");
  let p = TAG_HEADER_OBJECT.length + 1;
  const object = oidLine(s, p, 'tag', 'badObjectSha1', TAG_HEADER_OBJECT);
  p += OID_HEX_CHARS + 1;
  if (!has(p, TAG_HEADER_TYPE)) throw corrupt('tag', 'missingTypeEntry', "invalid format - expected 'type' line");
  p += TAG_HEADER_TYPE.length + 1;
  // verify_headers guarantees a newline after every header line, so the type and tag lines always end
  let eol = s.indexOf('\n', p);
  const type = s.slice(p, eol);
  if (!Object.hasOwn(TYPE_ID, type)) throw corrupt('tag', 'badType', "invalid 'type' value");
  p = eol + 1;
  if (!has(p, TAG_HEADER_TAG)) throw corrupt('tag', 'missingTagEntry', "invalid format - expected 'tag' line");
  p += TAG_HEADER_TAG.length + 1;
  eol = s.indexOf('\n', p);
  // badTagName (not a refname under refs/tags/) is INFO: git warns and accepts, and so does ply
  const tag = s.slice(p, eol);
  p = eol + 1;
  // missingTaggerEntry is INFO: tags before git 0.99.1 have none
  let tagger = null;
  if (has(p, TAG_HEADER_TAGGER)) [tagger, p] = fsckIdent(s, p + TAG_HEADER_TAGGER.length + 1, 'tag', TAG_HEADER_TAGGER);
  // extraHeaderEntry is IGNORE, and fsck never reads a tag's body: a NUL there is accepted, unlike in a commit
  const { extra, message } = rest(s, p, blank);
  refuseShadowed('tag', extra, TAG_SHADOWED);
  return { object, type, tag, tagger, extra, message };
}

// Every object fetch passes through here once it hashes to the oid the server advertised (fetchObject, checkWide on a
// pack before any of it is returned or harvested). It is the same parser every reader calls, so a commit or tag no
// reader would accept never reaches one.
export function assertFetched(typeName, data, limits = DEFAULT_LIMITS) {
  if (typeName === 'blob' || typeName === 'ofs_delta' || typeName === 'ref_delta') return;
  if (typeName === 'tree') { parseTree(data, limits); return; }
  if (typeName === 'commit') { parseCommit(data, limits); return; }
  if (typeName === 'tag') { parseTag(data); return; }
  throw fail('pack_corrupt', `object: bad type ${typeName}`);
}

// A header value is one line. LF or NUL, from any caller, would open a new header. The message is the body: LF is
// legal there, NUL is not. withGpgsig splices signature continuation lines after this returns, so those bytes are
// not re-checked here.
const headerValue = (value, what) => {
  if (typeof value !== 'string' || /[\0\n]/.test(value)) throw fail('bad_request', `${what} must not contain NUL or newline`, { what });
};
const messageBody = message => {
  if (message !== null && (typeof message !== 'string' || message.includes('\0'))) throw fail('bad_request', 'message must not contain NUL', { what: 'message' });
};

// Faithful: the message is written verbatim after the blank line; null means no body section. Callers that want
// git's conventional trailing newline add it themselves (editFile does).
export function encodeCommit({ tree, parents = [], author, committer = author, encoding = null, message = null, extra = [] }) {
  headerValue(tree, 'tree');
  for (const p of parents) headerValue(p, 'parent');
  headerValue(author, 'author');
  headerValue(committer, 'committer');
  if (encoding !== null) headerValue(encoding, 'encoding');
  for (const line of extra) headerValue(line, 'extra');
  messageBody(message);
  const lines = [
    `${COMMIT_HEADER_TREE} ${tree}`,
    ...parents.map(p => `${COMMIT_HEADER_PARENT} ${p}`),
    `${COMMIT_HEADER_AUTHOR} ${author}`,
    `${COMMIT_HEADER_COMMITTER} ${committer}`,
  ];
  if (encoding !== null) lines.push(`${COMMIT_HEADER_ENCODING} ${encoding}`);
  lines.push(...extra);
  return encodeBytes(lines.join('\n') + '\n' + (message === null ? '' : '\n' + message), 'commit');
}

export function encodeTag({ object, type, tag, tagger, message = null, extra = [] }) {
  headerValue(object, 'object');
  headerValue(type, 'type');
  headerValue(tag, 'tag');
  headerValue(tagger, 'tagger');
  for (const line of extra) headerValue(line, 'extra');
  messageBody(message);
  const lines = [
    `${TAG_HEADER_OBJECT} ${object}`, `${TAG_HEADER_TYPE} ${type}`, `${TAG_HEADER_TAG} ${tag}`, `${TAG_HEADER_TAGGER} ${tagger}`,
    ...extra,
  ];
  return encodeBytes(lines.join('\n') + '\n' + (message === null ? '' : '\n' + message), 'tag');
}
