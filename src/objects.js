// Git object encoding/decoding. All pure.
import { fail } from './errors.js';
import { Sha1, toHex, fromHex } from './sha1.js';
import { te, td, concat } from './bytes.js';

export const TYPE = Object.freeze({ COMMIT: 1, TREE: 2, BLOB: 3, TAG: 4, OFS_DELTA: 6, REF_DELTA: 7 });
export const TYPE_NAME = Object.freeze({ 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs_delta', 7: 'ref_delta' });
export const TYPE_ID = Object.freeze({ commit: 1, tree: 2, blob: 3, tag: 4 });

export const objectHeader = (typeName, len) => te.encode(`${typeName} ${len}\0`);

export function hashObject(typeName, data) {
  return new Sha1().update(objectHeader(typeName, data.length)).update(data).hex();
}

// ---- tree ----
// entry: { mode: '100644'|'100755'|'120000'|'40000'|'160000', name, oid (hex), oidOffset }
export function parseTree(data) {
  const entries = [];
  let p = 0;
  while (p < data.length) {
    const sp = data.indexOf(0x20, p);
    const nul = data.indexOf(0, sp);
    if (sp < 0 || nul < 0 || nul + 20 > data.length) throw fail('pack_corrupt', 'tree: malformed entry');
    entries.push({
      mode: td.decode(data.subarray(p, sp)),
      name: td.decode(data.subarray(sp + 1, nul)),
      oid: toHex(data.subarray(nul + 1, nul + 21)),
      oidOffset: nul + 1,
      entryOffset: p,
    });
    p = nul + 21;
  }
  return entries;
}

const sortKey = e => (e.mode === '40000' ? e.name + '/' : e.name);
export function treeSort(entries) {
  return [...entries].sort((a, b) => {
    const ka = te.encode(sortKey(a)), kb = te.encode(sortKey(b));
    const n = Math.min(ka.length, kb.length);
    for (let i = 0; i < n; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return ka.length - kb.length;
  });
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

// ---- commit ----
export function parseCommit(data) {
  const text = td.decode(data);
  const nl = text.indexOf('\n\n');
  const head = (nl < 0 ? text.replace(/\n$/, '') : text.slice(0, nl)).split('\n');
  // message is null when the object has no body section at all (no blank line); '' when the body is empty
  const c = { tree: null, parents: [], author: null, committer: null, extra: [], message: nl < 0 ? null : text.slice(nl + 2) };
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
export function parseIdent(line) {
  if (typeof line !== 'string') return null;
  const lt = line.indexOf('<'), gt = lt < 0 ? -1 : line.indexOf('>', lt + 1);
  if (lt < 0 || gt < 0) return { name: line.trim(), email: '', time: null, tz: '' };
  const [time = '', tz = ''] = line.slice(line.lastIndexOf('>') + 1).trim().split(/\s+/);
  return { name: line.slice(0, lt).trimEnd(), email: line.slice(lt + 1, gt), time: /^\d+$/.test(time) ? time : null, tz };
}

// Faithful: the message is written verbatim after the blank line; null means no body section. Callers that want
// git's conventional trailing newline add it themselves (editFile does).
export function encodeCommit({ tree, parents = [], author, committer = author, message = null, extra = [] }) {
  const lines = [`tree ${tree}`, ...parents.map(p => `parent ${p}`), `author ${author}`, `committer ${committer}`, ...extra];
  return te.encode(lines.join('\n') + '\n' + (message === null ? '' : '\n' + message));
}
