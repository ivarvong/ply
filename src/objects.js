// Git object encoding/decoding. All pure.
import { fail } from './errors.js';
import { Sha1, toHex, fromHex } from './sha1.js';
import { te, td, concat, take } from './bytes.js';
import { isDotGit } from './validate.js';
import {
  OID_BYTES, OID_HEX_CHARS, TREE_MODE_SEP, TREE_NUL, MODE_TREE,
  OBJ_COMMIT, OBJ_TREE, OBJ_BLOB, OBJ_TAG, OBJ_OFS_DELTA, OBJ_REF_DELTA,
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
export function parseTree(data) {
  const entries = [];
  let p = 0;
  let prevKey = null;
  while (p < data.length) {
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

export function encodeTree(entries) {
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
  const headText = nl < 0 ? text.replace(/\n$/, '') : text.slice(0, nl);
  const head = headText.length ? headText.split('\n') : [];
  for (const line of head) if (line.indexOf(' ') < 0) throw fail('pack_corrupt', `${what}: truncated header line`);
  return { head, message: nl < 0 ? null : text.slice(nl + blank.length) };
}

// ---- commit ----
// @decoder parseCommit prefix=commit
export function parseCommit(data) {
  const { head, message } = splitHeaders(data, 'commit');
  // message is null when the object has no body section at all (no blank line); '' when the body is empty
  const c = { tree: null, parents: [], author: null, committer: null, extra: [], message };
  for (const line of head) {
    const sp = line.indexOf(' ');
    const k = line.slice(0, sp), v = line.slice(sp + 1);
    if (k === 'tree') c.tree = v;
    else if (k === 'parent') c.parents.push(v);
    else if (k === 'author') c.author = v;
    else if (k === 'committer') c.committer = v;
    else c.extra.push(line);
  }
  return c;
}

export const ident = ({ name, email, time, tz = '+0000' }) => `${name} <${email}> ${time} ${tz}`;

// The inverse, as git's split_ident_line reads it: name up to the first '<' (trailing spaces trimmed), email up to the
// next '>', then "<epoch> <tz>" after the last '>'. Fields git would print as empty are '' (time null when the date is missing).
// @decoder parseIdent prefix=ident
export function parseIdent(line) {
  if (typeof line !== 'string') return null;
  const lt = line.indexOf('<'), gt = lt < 0 ? lt : line.indexOf('>', lt + 1);
  if (lt < 0 || gt < 0) return { name: line.trim(), email: '', time: null, tz: '' };
  const [time = '', tz = ''] = line.slice(line.lastIndexOf('>') + 1).trim().split(/\s+/);
  return { name: line.slice(0, lt).trimEnd(), email: line.slice(lt + 1, gt), time: /^\d+$/.test(time) ? time : null, tz };
}

// ---- tag (annotated; same header framing as a commit) ----
// @decoder parseTag prefix=tag
export function parseTag(data) {
  const { head, message } = splitHeaders(data, 'tag');
  const t = { object: null, type: null, tag: null, tagger: null, extra: [], message };
  for (const line of head) {
    const sp = line.indexOf(' ');
    const k = line.slice(0, sp), v = line.slice(sp + 1);
    if (k === 'object' && t.object === null) t.object = v;
    else if (k === 'type' && t.type === null) t.type = v;
    else if (k === 'tag' && t.tag === null) t.tag = v;
    else if (k === 'tagger' && t.tagger === null) t.tagger = v;
    else t.extra.push(line);
  }
  return t;
}

function checkIdent(line, role) {
  const id = parseIdent(line);
  if (!id || line.indexOf('<') < 0 || line.indexOf('>') < 0) throw fail('pack_corrupt', `${role}: missing email`);
  if (id.time === null) throw fail('pack_corrupt', `${role}: bad date`);
}

// Semantic checks git fsck --strict applies to a complete object. Structural prefixes (parseCommit of a header
// prefix) do not come through here; fetch does, after the object hashes to the oid the server advertised.
export function assertFetched(typeName, data) {
  if (typeName === 'blob' || typeName === 'ofs_delta' || typeName === 'ref_delta') return;
  if (typeName === 'tree') { parseTree(data); return; }
  if (typeName === 'commit') {
    const c = parseCommit(data);
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
    if (!OID_TEXT.test(t.object ?? '')) throw fail('pack_corrupt', 'tag: missing or bad object');
    if (!t.type) throw fail('pack_corrupt', 'tag: missing type');
    if (t.tag === null) throw fail('pack_corrupt', 'tag: missing name');
    if (!t.tagger) throw fail('pack_corrupt', 'tag: missing tagger');
    checkIdent(t.tagger, 'tagger');
    return;
  }
  throw fail('pack_corrupt', `object: bad type ${typeName}`);
}

// Faithful: the message is written verbatim after the blank line; null means no body section. Callers that want
// git's conventional trailing newline add it themselves (editFile does).
export function encodeCommit({ tree, parents = [], author, committer = author, message = null, extra = [] }) {
  const lines = [`tree ${tree}`, ...parents.map(p => `parent ${p}`), `author ${author}`, `committer ${committer}`, ...extra];
  return te.encode(lines.join('\n') + '\n' + (message === null ? '' : '\n' + message));
}

export function encodeTag({ object, type, tag, tagger, message = null, extra = [] }) {
  const lines = [`object ${object}`, `type ${type}`, `tag ${tag}`, `tagger ${tagger}`, ...extra];
  return te.encode(lines.join('\n') + '\n' + (message === null ? '' : '\n' + message));
}
