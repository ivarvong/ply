// Git object encoding/decoding. All pure.
import { fail } from './errors.js';
import { Sha1, toHex, fromHex } from './sha1.js';
import { te, td, concat, take } from './bytes.js';
import { isDotGit, isValidatedIdent } from './validate.js';
import { DEFAULT_LIMITS, limitError, requireLimit } from './limits.js';
import {
  OID_BYTES, OID_HEX_CHARS, TREE_MODE_SEP, TREE_NUL, MODE_TREE, IDENT_TZ_DIGITS,
  OBJ_COMMIT, OBJ_TREE, OBJ_BLOB, OBJ_TAG, OBJ_OFS_DELTA, OBJ_REF_DELTA,
  COMMIT_HEADER_TREE, COMMIT_HEADER_PARENT, COMMIT_HEADER_AUTHOR, COMMIT_HEADER_COMMITTER, COMMIT_HEADER_ENCODING,
  COMMIT_HEADER_ORDER, TAG_HEADER_OBJECT, TAG_HEADER_TYPE, TAG_HEADER_TAG, TAG_HEADER_TAGGER, TAG_HEADER_ORDER,
  HEADER_SKIP_OPTIONAL,
} from './format.js';

export const TYPE = Object.freeze({ COMMIT: OBJ_COMMIT, TREE: OBJ_TREE, BLOB: OBJ_BLOB, TAG: OBJ_TAG, OFS_DELTA: OBJ_OFS_DELTA, REF_DELTA: OBJ_REF_DELTA });
export const TYPE_NAME = Object.freeze({ [OBJ_COMMIT]: 'commit', [OBJ_TREE]: 'tree', [OBJ_BLOB]: 'blob', [OBJ_TAG]: 'tag', [OBJ_OFS_DELTA]: 'ofs_delta', [OBJ_REF_DELTA]: 'ref_delta' });
export const TYPE_ID = Object.freeze({ commit: OBJ_COMMIT, tree: OBJ_TREE, blob: OBJ_BLOB, tag: OBJ_TAG });

const OID_TEXT = new RegExp(`^[0-9a-f]{${OID_HEX_CHARS}}$`);

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
// entry: { mode: '100644'|'100755'|'120000'|'40000'|'160000', name, oid (hex), oidOffset }
// @decoder parseTree prefix=tree
export function parseTree(data, limits = DEFAULT_LIMITS) {
  const maxEntries = requireLimit(limits, 'maxTreeEntries');
  const entries = [];
  let p = 0;
  let prevKey = null;
  while (p < data.length) {
    if (entries.length >= maxEntries) throw limitError('tree entries', entries.length + 1, maxEntries);
    const sp = data.indexOf(TREE_MODE_SEP, p);
    // A negative fromIndex would wrap; indexOf returns -1 when the separator is absent.
    if (sp < p) throw fail('pack_corrupt', 'tree: malformed entry');
    const nul = data.indexOf(TREE_NUL, sp + 1);
    if (nul < sp + 1) throw fail('pack_corrupt', 'tree: malformed entry');
    const mode = td.decode(take(data, p, sp - p));
    const name = td.decode(take(data, sp + 1, nul - (sp + 1)));
    // The id starts at nul+1. take() demands OID_BYTES bytes there; the old `nul + OID_BYTES > length`
    // guard counted from the NUL and let a 19-byte id through.
    const oidBytes = take(data, nul + 1, OID_BYTES);
    if (mode.length === 0) throw fail('pack_corrupt', 'tree: empty mode');
    if (!/^[0-7]+$/.test(mode)) throw fail('pack_corrupt', 'tree: malformed mode');
    if (mode[0] === '0') throw fail('pack_corrupt', 'tree: zero-padded mode');
    if (name.length === 0) throw fail('pack_corrupt', 'tree: empty name');
    if (name.indexOf('/') >= 0) throw fail('pack_corrupt', 'tree: full pathname');
    if (name === '.' || name === '..' || isDotGit(name)) throw fail('pack_corrupt', 'tree: bad name');
    const key = te.encode(mode === MODE_TREE ? name + '/' : name);
    if (prevKey !== null && cmpBytes(prevKey, key) >= 0) throw fail('pack_corrupt', 'tree: not strictly sorted');
    prevKey = key;
    entries.push({ mode, name, oid: toHex(oidBytes), oidOffset: nul + 1, entryOffset: p });
    p = nul + 1 + OID_BYTES;
  }
  return entries;
}

const sortKey = e => (e.mode === MODE_TREE ? e.name + '/' : e.name);
export function treeSort(entries) {
  return [...entries].sort((a, b) => cmpBytes(te.encode(sortKey(a)), te.encode(sortKey(b))));
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
  return concat(treeSort(entries).flatMap(e => [te.encode(`${e.mode} ${e.name}\0`), fromHex(e.oid)]));
}

// Replace the oid of one entry in place; returns new bytes + coordinates for a structural delta.
export function treeReplaceOid(data, entry, newOidHex) {
  const out = data.slice();
  out.set(fromHex(newOidHex), entry.oidOffset);
  return out;
}

// Header block shared by commits and tags. A buffer that ends mid-line (no blank line yet, and no trailing
// newline) is a truncated header and throws. A cut that lands on a newline is a whole number of header lines.
// Bytes after the blank line are the message; git does not frame the message, so a message prefix is a prefix.
function splitHeaders(data, what) {
  const text = td.decode(data);
  const blank = '\n\n';
  const nl = text.indexOf(blank);
  if (nl < 0 && text.length > 0 && !text.endsWith('\n')) throw fail('pack_corrupt', `${what}: truncated header line`);
  // Stryker disable next-line ConditionalExpression: a header that does not throw and has no blank line is empty or ends in a newline, so slice(0, -1) drops that same byte
  const headText = nl < 0 ? text.replace(/\n$/, '') : text.slice(0, nl);
  const head = headText.length ? headText.split('\n') : [];
  for (const line of head) if (line.indexOf(' ') < 0) throw fail('pack_corrupt', `${what}: truncated header line`);
  return { head, message: nl < 0 ? null : text.slice(nl + blank.length) };
}

// One checker for commit_tree_extended and builtin/tag.c. `repeat` is the header that may occur more than
// once (commit `parent`); a tag passes null. A second single-valued header throws even when fsck accepts
// the object: git shows the first tree, so a last-wins parse would hash a different tree than
// `git log --format=%T`. Extras (gpgsig, mergetag) are legal once `phase` has reached `extraFrom`.
function parseOrderedHeaders(kind, head, order, repeat, extraFrom, maxRepeat) {
  const bad = (why, key) => { throw fail('pack_corrupt', key === undefined ? `${kind}: ${why}` : `${kind}: ${why} ${key}`); };
  const rec = { extra: [] };
  for (const name of order) rec[name === repeat ? `${name}s` : name] = name === repeat ? [] : null;
  let phase = null;
  for (const line of head) {
    const sp = line.indexOf(' ');
    const key = line.slice(0, sp), value = line.slice(sp + 1);
    const at = order.indexOf(key);
    if (at < 0) {
      // null is below every index, so a header before the first structural line fails here too
      if (phase < extraFrom) bad('bad header order');
      rec.extra.push(line);
      phase = order.length;
    } else if (phase === null) {
      if (at > 0) bad('bad header order');
      rec[key] = value;
      phase = at;
    } else if (key !== repeat && phase >= at) bad('duplicate', key);
    else {
      // author may follow tree because parent is optional. The duplicate check already rejected every
      // later phase, so the phases that reach this comparison are exactly the skipped index.
      // Stryker disable next-line ConditionalExpression: author is the only header this skip can allow, and every phase that reaches the comparison already matches it
      const skipped = order[at - 1] === repeat && phase === at - 1 - HEADER_SKIP_OPTIONAL;
      if (phase !== at && phase !== at - 1 && !skipped) bad('bad header order');
      if (key === repeat) {
        const next = rec[`${key}s`].length + 1;
        if (next > maxRepeat) throw limitError('commit parents', next, maxRepeat);
        rec[`${key}s`].push(value);
      }
      else rec[key] = value;
      phase = at;
    }
  }
  return rec;
}

// @decoder parseCommit prefix=commit
export function parseCommit(data, limits = DEFAULT_LIMITS) {
  const maxParents = requireLimit(limits, 'maxCommitParents');
  const { head, message } = splitHeaders(data, 'commit');
  // message is null when the object has no body section at all (no blank line); '' when the body is empty
  const c = parseOrderedHeaders('commit', head, COMMIT_HEADER_ORDER, COMMIT_HEADER_PARENT, COMMIT_HEADER_ORDER.indexOf(COMMIT_HEADER_COMMITTER), maxParents);
  c.message = message;
  return c;
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

// ---- tag (annotated; same header framing as a commit) ----
// @decoder parseTag prefix=tag
export function parseTag(data) {
  const { head, message } = splitHeaders(data, 'tag');
  const t = parseOrderedHeaders('tag', head, TAG_HEADER_ORDER, null, TAG_HEADER_ORDER.indexOf(TAG_HEADER_TAGGER));
  t.message = message;
  return t;
}

function checkIdent(line, role) {
  const id = parseIdent(line);
  const lt = line.indexOf('<');
  if (!id || lt < 0 || line.indexOf('>') < 0) throw fail('pack_corrupt', `${role}: missing email`);
  // fsck.c fsck_ident: a '>' in the name is a bad name; the byte before '<' must be a space
  // ('Name<email>' and a line that opens on '<' are both "missing space before email").
  if (line.slice(0, lt).includes('>')) throw fail('pack_corrupt', `${role}: bad name`);
  if (line[lt - 1] !== ' ') throw fail('pack_corrupt', `${role}: missing space before email`);
  // Then one space after '>', spaces or tabs, the timestamp, one space, a sign and IDENT_TZ_DIGITS digits, and
  // the newline. A non-digit ends the timestamp early (bad date). Hours and minutes are not range-checked.
  const gt = line.indexOf('>', lt);
  let p = gt + 1;
  if (line[p] !== ' ') throw fail('pack_corrupt', `${role}: bad date`);
  p++;
  while (line[p] === ' ' || line[p] === '\t') p++;
  while (line[p] >= '0' && line[p] <= '9') p++;
  if (line[p] !== ' ') throw fail('pack_corrupt', `${role}: bad date`);
  p++;
  if (!new RegExp(`^[+-][0-9]{${IDENT_TZ_DIGITS}}$`).test(line.slice(p))) throw fail('pack_corrupt', `${role}: bad time zone`);
}

// Semantic checks git fsck --strict applies to a complete object. Structural prefixes (parseCommit of a header
// prefix) do not come through here; fetch does, after the object hashes to the oid the server advertised.
export function assertFetched(typeName, data, limits = DEFAULT_LIMITS) {
  if (typeName === 'blob' || typeName === 'ofs_delta' || typeName === 'ref_delta') return;
  if (typeName === 'tree') { parseTree(data, limits); return; }
  if (typeName === 'commit') {
    const c = parseCommit(data, limits);
    // Stryker disable next-line StringLiteral: the fallback is rejected by OID_TEXT whether it is empty or any other non-oid
    if (!OID_TEXT.test(c.tree ?? '')) throw fail('pack_corrupt', 'commit: missing or bad tree');
    if (c.parents.some(p => !OID_TEXT.test(p))) throw fail('pack_corrupt', 'commit: bad parent');
    if (!c.author) throw fail('pack_corrupt', 'commit: missing author');
    if (!c.committer) throw fail('pack_corrupt', 'commit: missing committer');
    checkIdent(c.author, 'author');
    checkIdent(c.committer, 'committer');
    return;
  }
  if (typeName === 'tag') {
    const t = parseTag(data);
    // Stryker disable next-line StringLiteral: the fallback is rejected by OID_TEXT whether it is empty or any other non-oid
    if (!OID_TEXT.test(t.object ?? '')) throw fail('pack_corrupt', 'tag: missing or bad object');
    if (!t.type) throw fail('pack_corrupt', 'tag: missing type');
    if (t.tag === null) throw fail('pack_corrupt', 'tag: missing name');
    if (!t.tagger) throw fail('pack_corrupt', 'tag: missing tagger');
    checkIdent(t.tagger, 'tagger');
    return;
  }
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
  return te.encode(lines.join('\n') + '\n' + (message === null ? '' : '\n' + message));
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
  return te.encode(lines.join('\n') + '\n' + (message === null ? '' : '\n' + message));
}
