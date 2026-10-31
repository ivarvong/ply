// The fsck tree-entry space (hole #4 of the spaces report, PR #63), as code. Every check git's fsck_tree makes on a
// tree entry (git v2.50.0 fsck.c fsck_tree, fsck_finish/fsck_blobs for the dotfiles it collects; tree-walk.c
// decode_tree_entry; object.h parse_mode; utf8.c is_hfs_dot*; path.c is_ntfs_dot*) is an axis below, as a tagged union
// of the shapes that check sees. A cell is a tree of one or two entries: the cell's entry (`mode` × `name`) and the
// entry carrying a `trigger`, in the order `position` says. `fsckModel` is git's fsck_tree ported from that source, and
// test/space/fsck-tree.test.js holds it to `git fsck --strict` on every cell; `expected` is ply's outcome, derived from
// the model through one rule plus a decision per warning-only msgId (WARN_DECISION).
//
// The rule: ply refuses (pack_corrupt) exactly the trees git reports an error for under --strict, and accepts the rest.
// Severities under --strict (fsck.h; `--strict` turns WARN into an error, INFO stays a warning, fsck exits 0):
//   ERROR  badTree duplicateEntries treeNotSorted gitmodulesSymlink gitmodulesBlob gitmodulesMissing
//          gitattributesBlob gitattributesMissing                                                            error
//   WARN   nullSha1 fullPathname emptyName hasDot hasDotdot hasDotgit zeroPaddedFilemode largePathname       error
//   INFO   badFilemode gitattributesSymlink gitignoreSymlink mailmapSymlink                                  warning
// emptyName is never reported for a tree git can read: decode_tree_entry refuses an empty name first ("empty filename in
// tree entry"), which fsck reports as badTree.
import { createHash } from 'node:crypto';

const bin = s => Buffer.from(s, 'latin1');
const utf8 = s => Buffer.from(s, 'utf8');

// ---- severities and ply's decision for each warning-only msgId ----
export const SEVERITY = {
  badTree: 'error', duplicateEntries: 'error', treeNotSorted: 'error', gitmodulesSymlink: 'error', gitmodulesBlob: 'error',
  gitmodulesMissing: 'error', gitattributesBlob: 'error', gitattributesMissing: 'error',
  nullSha1: 'error', fullPathname: 'error', emptyName: 'error', hasDot: 'error', hasDotdot: 'error', hasDotgit: 'error',
  zeroPaddedFilemode: 'error', largePathname: 'error',
  badFilemode: 'warning', gitattributesSymlink: 'warning', gitignoreSymlink: 'warning', mailmapSymlink: 'warning',
};
// A warning git prints under --strict and exits 0 on. Each is decided here; one without a decision fails the test.
export const WARN_DECISION = {
  badFilemode: { ply: 'accept', why: 'git reads every such mode through canon_mode (100664 → 100644, 40755 → a tree, an unknown type → a gitlink) and checks it out; real repositories carry 100664 from git\'s first weeks. ply returns the canonical mode, as `git ls-tree` prints it' },
  gitattributesSymlink: { ply: 'accept', why: 'git reads a symlinked .gitattributes from a tree as the blob it is (attr.c read_attr_from_blob has no mode check) and only declines to follow one in a worktree; ply has no worktree, and merge reads it as git merge-tree does' },
  gitignoreSymlink: { ply: 'accept', why: 'ply never reads .gitignore' },
  mailmapSymlink: { ply: 'accept', why: 'ply never reads .mailmap' },
};

// ---- the axes ----
// Each entry: { mode (raw bytes text), name (Buffer), oid: 'blob' | 'tree' | 'gitlink' | 'null' }. 'tree' is a subtree of
// this cell's own and 'gitlink' an oid no object has, so fsck_finish's reports on them (gitmodulesBlob, ...Missing)
// name this cell. 'blob' is the empty blob: empty content is a valid .gitmodules and .gitattributes, so no content
// check fires on it.
const S_IFMT = 0o170000, S_IFREG = 0o100000, S_IFLNK = 0o120000, S_IFDIR = 0o040000;
const STANDARD = new Set([0o100755, 0o100644, 0o120000, 0o040000, 0o160000]);
// parse_mode: octal digits up to the space, accumulated in an unsigned int, stored in a uint16_t
export const parseMode = raw => {
  if (raw.length === 0 || !/^[0-7]+$/.test(raw)) return null;
  let m = 0;
  for (const d of raw) m = ((m << 3) + Number(d)) >>> 0;
  return m & 0xffff;
};
export const canon = m => ((m & S_IFMT) === S_IFREG ? (m & 0o100 ? '100755' : '100644') : (m & S_IFMT) === S_IFLNK ? '120000' : (m & S_IFMT) === S_IFDIR ? '40000' : '160000');
const oidKindFor = raw => { const m = parseMode(raw); return m === null ? 'blob' : { '40000': 'tree', '160000': 'gitlink' }[canon(m)] ?? 'blob'; };

const MODE = { name: 'mode', doc: 'the cell entry\'s mode bytes: every class fsck_tree\'s switch and parse_mode tell apart', variants: [
  { tag: 'blob', raw: '100644', why: 'S_IFREG|0644: standard' },
  { tag: 'exec', raw: '100755', why: 'S_IFREG|0755: standard' },
  { tag: 'symlink', raw: '120000', why: 'S_IFLNK: standard' },
  { tag: 'tree', raw: '40000', why: 'S_IFDIR: standard' },
  { tag: 'gitlink', raw: '160000', why: 'S_IFGITLINK: standard' },
  { tag: 'group', raw: '100664', why: 'S_IFREG|0664: "we had a few of these early on"; badFilemode only under --strict' },
  { tag: 'private', raw: '100600', why: 'S_IFREG|0600: badFilemode (INFO); canon_mode 100644' },
  { tag: 'dir755', raw: '40755', why: 'S_IFDIR|0755: badFilemode; S_ISDIR, so it sorts and reads as a tree' },
  { tag: 'gitlinkPerm', raw: '160644', why: 'S_IFGITLINK|0644: badFilemode; canon_mode 160000' },
  { tag: 'zeroPadded', raw: '0100644', why: 'a leading 0: zeroPaddedFilemode (WARN), and the value is still 100644' },
  { tag: 'zeroPaddedTree', raw: '040000', why: 'the zero-padded tree mode old tools wrote: zeroPaddedFilemode' },
  { tag: 'truncated', raw: '7100644', why: 'parse_mode keeps 16 bits: 07100644 & 0xffff is 0100644, a standard mode (no report at all)' },
  { tag: 'unknownType', raw: '1', why: 'type bits 0: badFilemode; canon_mode makes it a gitlink' },
  { tag: 'allBits', raw: '777777', why: '0177777: badFilemode; type 0170000 is no type git knows, so a gitlink' },
] };

const NAME = { name: 'name', doc: 'the cell entry\'s name bytes: every spelling fsck_tree and verify_path tell apart', variants: [
  { tag: 'plain', bytes: utf8('a'), why: 'an ordinary name' },
  { tag: 'dot', bytes: utf8('.'), why: 'hasDot' },
  { tag: 'dotdot', bytes: utf8('..'), why: 'hasDotdot' },
  { tag: 'empty', bytes: utf8(''), why: 'decode_tree_entry: "empty filename in tree entry", so badTree (emptyName is unreachable)' },
  { tag: 'slash', bytes: utf8('a/b'), why: 'fullPathname' },
  { tag: 'dotgit', bytes: utf8('.git'), why: 'hasDotgit' },
  { tag: 'DOTGIT', bytes: utf8('.GIT'), why: 'is_ntfs_dotgit and is_hfs_dotgit fold ASCII case' },
  { tag: 'DotGit', bytes: utf8('.Git'), why: 'mixed case' },
  { tag: 'short1', bytes: utf8('git~1'), why: 'is_ntfs_dotgit: the 8.3 short name of .git' },
  { tag: 'SHORT1', bytes: utf8('GIT~1'), why: 'the short name, upper case' },
  { tag: 'short2', bytes: utf8('git~2'), why: 'not .git: git guarantees .git takes ~1 (path.c), so ~2 is an ordinary name' },
  { tag: 'short10', bytes: utf8('git~10'), why: 'git~1 followed by a digit: an ordinary name' },
  { tag: 'trailDot', bytes: utf8('.git.'), why: 'NTFS trims trailing dots' },
  { tag: 'trailSpace', bytes: utf8('.git '), why: 'NTFS trims trailing spaces' },
  { tag: 'trailMixed', bytes: utf8('.git. .'), why: 'dots and spaces, any mix' },
  { tag: 'stream', bytes: utf8('.git:x'), why: 'an NTFS alternate data stream of .git' },
  { tag: 'shortStream', bytes: utf8('git~1:x'), why: 'a stream of the short name' },
  { tag: 'dotgitx', bytes: utf8('.gitx'), why: 'a longer name: ordinary' },
  { tag: 'hfsZwnj', bytes: utf8('.g‌it'), why: 'HFS+ ignores U+200C' },
  { tag: 'hfsBom', bytes: utf8('﻿.git'), why: 'HFS+ ignores U+FEFF, also in front' },
  { tag: 'hfsLrm', bytes: utf8('.git‎'), why: 'HFS+ ignores U+200E, also at the end' },
  { tag: 'hfsBadTail', bytes: bin('.git\xff'), why: 'next_hfs_char reads an invalid sequence as the end of the name: .git' },
  { tag: 'hfsSurrogate', bytes: bin('.git\xed\xa0\x80'), why: 'a UTF-8-encoded surrogate is invalid to pick_one_utf8_char: the end, so .git' },
  { tag: 'badLead', bytes: bin('\xff.git'), why: 'invalid UTF-8 before the dot: not .git to HFS, not to NTFS' },
  { tag: 'overlongDot', bytes: bin('\xc0\xaegit'), why: 'an overlong "." is invalid, never a dot' },
  { tag: 'backslash', bytes: utf8('a\\.git'), why: 'fsck_tree reads a backslash as a separator (is_ntfs_dotgit after it) on every platform' },
  { tag: 'backslashShort', bytes: utf8('a\\git~1'), why: 'the short name after a backslash' },
  { tag: 'backslashDotdot', bytes: utf8('..\\x'), why: 'fsck checks only .git after a backslash: accepted, and `..` on Windows' },
  { tag: 'gitmodules', bytes: utf8('.gitmodules'), why: 'gitmodulesSymlink as a symlink; collected for fsck_finish otherwise' },
  { tag: 'GITMODULES', bytes: utf8('.GITMODULES'), why: 'case' },
  { tag: 'gitmodulesTrail', bytes: utf8('.gitmodules .'), why: 'is_ntfs_dot_generic: trailing spaces and dots' },
  { tag: 'gitmodulesStream', bytes: utf8('.gitmodules:x'), why: 'a stream' },
  { tag: 'gitmodulesShort', bytes: utf8('gitmod~1'), why: 'the 6-character short name, ~1 to ~4' },
  { tag: 'gitmodulesShort5', bytes: utf8('gitmod~5'), why: '~5 is past the regular short names, and gitmod is not the fallback prefix: ordinary' },
  { tag: 'gitmodulesFallback', bytes: utf8('GI7EBA~1'), why: 'the fallback short name (hash prefix gi7eba)' },
  { tag: 'gitmodulesFallback9', bytes: utf8('gi7eba~9'), why: 'the fallback allows ~1 to ~9' },
  { tag: 'tildeDigits', bytes: utf8('~1234567'), why: 'is_ntfs_dot_generic\'s fallback loop takes a leading ~ and digits as every dotfile\'s short name' },
  { tag: 'gitmodulesHfs', bytes: utf8('.gitmodu‍les'), why: 'HFS+ ignorable inside' },
  { tag: 'gitmodulesBackslash', bytes: utf8('a\\.gitmodules'), why: 'is_ntfs_dotgitmodules after a backslash' },
  { tag: 'gitattributes', bytes: utf8('.gitattributes'), why: 'gitattributesSymlink (INFO) as a symlink' },
  { tag: 'gitattributesShort', bytes: utf8('gi7d29~1'), why: 'its fallback short name' },
  { tag: 'gitattributesBackslash', bytes: utf8('a\\.gitattributes'), why: 'fsck_tree checks only .gitmodules after a backslash' },
  { tag: 'gitignore', bytes: utf8('.gitignore'), why: 'gitignoreSymlink (INFO)' },
  { tag: 'gitignoreShort', bytes: utf8('gi250a~1'), why: 'its fallback short name' },
  { tag: 'mailmap', bytes: utf8('.mailmap'), why: 'mailmapSymlink (INFO)' },
  { tag: 'mailmapShort', bytes: utf8('maba30~1'), why: 'its fallback short name' },
  { tag: 'long4096', bytes: utf8('l'.repeat(4096)), why: 'max_tree_entry_len: 4096 bytes is allowed' },
  { tag: 'long4097', bytes: utf8('l'.repeat(4097)), why: 'largePathname' },
] };

// The other entry: one per fsck_tree msgId trigger (or none), with the minimal defect that fires it.
const e = (mode, name, oid = oidKindFor(mode)) => ({ mode, name: typeof name === 'string' ? utf8(name) : name, oid });
const TRIGGER = { name: 'trigger', doc: 'the other entry in the tree, carrying one fsck_tree msgId\'s trigger', variants: [
  { tag: 'alone', entry: null, why: 'a one-entry tree' },
  { tag: 'plain', entry: e('100644', 'm'), why: 'an ordinary sibling' },
  { tag: 'nullSha1', entry: e('100644', 'n', 'null'), why: 'is_null_oid' },
  { tag: 'fullPathname', entry: e('100644', 'm/n'), why: 'strchr(name, \'/\')' },
  { tag: 'emptyName', entry: e('100644', ''), why: 'an empty name: badTree (decode_tree_entry)' },
  { tag: 'malformedMode', entry: e('10x644', 'm', 'blob'), why: 'parse_mode: a non-octal digit, "malformed mode in tree entry": badTree' },
  { tag: 'hasDot', entry: e('100644', '.'), why: '"."' },
  { tag: 'hasDotdot', entry: e('100644', '..'), why: '".."' },
  { tag: 'hasDotgit', entry: e('100644', '.git'), why: 'is_hfs_dotgit || is_ntfs_dotgit' },
  { tag: 'zeroPaddedFilemode', entry: e('0100644', 'm'), why: 'the mode\'s first byte is \'0\'' },
  { tag: 'badFilemode', entry: e('100664', 'm'), why: 'S_IFREG|0664 under --strict' },
  { tag: 'gitmodulesSymlink', entry: e('120000', '.gitmodules'), why: 'S_ISLNK on a .gitmodules' },
  { tag: 'gitmodulesBlob', entry: e('40000', '.gitmodules'), why: 'a .gitmodules that is a tree: fsck_finish "non-blob found at .gitmodules"' },
  { tag: 'gitattributesSymlink', entry: e('120000', '.gitattributes'), why: 'S_ISLNK on a .gitattributes (INFO)' },
  { tag: 'gitattributesMissing', entry: e('160000', '.gitattributes'), why: 'a .gitattributes gitlink: fsck_finish cannot read the blob' },
  { tag: 'gitignoreSymlink', entry: e('120000', '.gitignore'), why: 'S_ISLNK on a .gitignore (INFO)' },
  { tag: 'mailmapSymlink', entry: e('120000', '.mailmap'), why: 'S_ISLNK on a .mailmap (INFO)' },
  { tag: 'largePathname', entry: e('100644', 'm'.repeat(4097)), why: 'tree_entry_len > 4096' },
  { tag: 'duplicateEntries', entry: 'same', why: 'the cell\'s own name again, as 100644: verify_ordered TREE_HAS_DUPS' },
] };

const POSITION = { name: 'position', doc: 'the order of the two entries in the tree bytes (the tree is sorted or not as the names fall)', variants: [
  { tag: 'cellFirst', why: 'the cell entry, then the trigger entry' },
  { tag: 'triggerFirst', why: 'the trigger entry, then the cell entry' },
] };

export const AXES = [TRIGGER, MODE, NAME, POSITION];
// A one-entry tree has no order: its two positions are one tree.
export const COLLAPSE = [{ when: c => c.trigger.tag === 'alone' && c.position.tag !== 'cellFirst', why: 'a one-entry tree has no order' }];

// Generic product of the axes: every combination, each a cell { [axis.name]: variant }, minus the collapsed duplicates.
export function product(axes = AXES) {
  let cells = [{}];
  for (const a of axes) cells = cells.flatMap(c => a.variants.map(v => ({ ...c, [a.name]: v })));
  return cells.filter(c => !COLLAPSE.some(r => r.when(c)));
}
export const cellId = c => AXES.map(a => c[a.name].tag).join('/');

// The cell's entries in tree order: [{ mode, name, oid, role: 'cell' | 'trigger' }]
export function entriesOf(c) {
  const cell = { mode: c.mode.raw, name: c.name.bytes, oid: oidKindFor(c.mode.raw), role: 'cell' };
  const t = c.trigger.entry === 'same' ? { mode: '100644', name: c.name.bytes, oid: 'blob' } : c.trigger.entry;
  if (!t) return [cell];
  const trig = { ...t, role: 'trigger' };
  return c.position.tag === 'cellFirst' ? [cell, trig] : [trig, cell];
}

// The oid an entry points at, given the store's fixtures (blob: the empty blob) and the cell's own objects.
export const gitlinkOid = (id, role) => createHash('sha1').update(`gitlink ${role} ${id}`).digest('hex');
export const subtreeBytes = (id, role, blob) => Buffer.concat([utf8(`100644 ${role}-${createHash('sha1').update(id).digest('hex').slice(0, 12)}\0`), Buffer.from(blob, 'hex')]);

export function treeBytes(entries, oidOf) {
  return Buffer.concat(entries.flatMap(x => [utf8(`${x.mode} `), x.name, Buffer.from([0]), Buffer.from(oidOf(x), 'hex')]));
}

// ---- git's fsck_tree, ported (the model the test holds to `git fsck --strict`) ----
// path.c / utf8.c predicates, written again here from the C (not imported from src/validate.js: the model must not
// share code with what it judges).
const at = (b, i) => (i < b.length ? b[i] : 0);
const lc = c => (c >= 65 && c <= 90 ? c + 32 : c);
function pick(b, i) { // utf8.c pick_one_utf8_char → [ch, incr] | null
  const s = k => at(b, i + k);
  if (s(0) < 0x80) return [s(0), 1];
  if ((s(0) & 0xe0) === 0xc0) { if ((s(1) & 0xc0) !== 0x80 || (s(0) & 0xfe) === 0xc0) return null; return [((s(0) & 0x1f) << 6) | (s(1) & 0x3f), 2]; }
  if ((s(0) & 0xf0) === 0xe0) {
    if ((s(1) & 0xc0) !== 0x80 || (s(2) & 0xc0) !== 0x80 || (s(0) === 0xe0 && (s(1) & 0xe0) === 0x80) || (s(0) === 0xed && (s(1) & 0xe0) === 0xa0) || (s(0) === 0xef && s(1) === 0xbf && (s(2) & 0xfe) === 0xbe)) return null;
    return [((s(0) & 0x0f) << 12) | ((s(1) & 0x3f) << 6) | (s(2) & 0x3f), 3];
  }
  if ((s(0) & 0xf8) === 0xf0) {
    if ((s(1) & 0xc0) !== 0x80 || (s(2) & 0xc0) !== 0x80 || (s(3) & 0xc0) !== 0x80 || (s(0) === 0xf0 && (s(1) & 0xf0) === 0x80) || (s(0) === 0xf4 && s(1) > 0x8f) || s(0) > 0xf4) return null;
    return [0x10000, 4]; // the value is never compared to an ASCII needle or an ignorable
  }
  return null;
}
const IGNORABLE = [0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f, 0xfeff];
function hfs(b, needle) {
  let i = 0, dead = false;
  const next = () => { while (!dead) { const r = pick(b, i); if (!r) { dead = true; break; } i += r[1]; if (!IGNORABLE.includes(r[0])) return r[0]; } return 0; };
  if (next() !== 46) return false;
  for (const ch of needle) { const c = next(); if (c > 127 || lc(c) !== ch.charCodeAt(0)) return false; }
  const c = next();
  return !c || c === 47;
}
function ntfsGit(b, o) {
  let i = o; let c = at(b, i++);
  if (c === 46) { for (const ch of 'git') { c = at(b, i++); if (lc(c) !== ch.charCodeAt(0)) return false; } }
  else if (lc(c) === 103) { for (const ch of 'it') { c = at(b, i++); if (lc(c) !== ch.charCodeAt(0)) return false; } if (at(b, i++) !== 126 || at(b, i++) !== 49) return false; }
  else return false;
  for (;;) { c = at(b, i++); if (!c || c === 47 || c === 92 || c === 58) return true; if (c !== 46 && c !== 32) return false; }
}
function ntfsGeneric(b, o, dotname, prefix) {
  const n = k => at(b, o + k);
  const only = i => { for (;;) { const c = n(i++); if (!c || c === 58) return true; if (c !== 32 && c !== 46) return false; } };
  let eq = n(0) === 46;
  for (let k = 0; eq && k < dotname.length; k++) if (lc(n(k + 1)) !== dotname.charCodeAt(k)) eq = false;
  if (eq) return only(dotname.length + 1);
  let eq6 = true;
  for (let k = 0; k < 6; k++) if (lc(n(k)) !== dotname.charCodeAt(k)) eq6 = false;
  if (eq6 && n(6) === 126 && n(7) >= 49 && n(7) <= 52) return only(8);
  let saw = false;
  for (let i = 0; i < 8; i++) {
    if (n(i) === 0) return false;
    if (saw) { if (n(i) < 48 || n(i) > 57) return false; }
    else if (n(i) === 126) { if (n(++i) < 49 || n(i) > 57) return false; saw = true; }
    else if (i >= 6) return false;
    else if (n(i) & 0x80) return false;
    else if (lc(n(i)) !== prefix.charCodeAt(i)) return false;
  }
  return only(8);
}
const DOT = { gitmodules: 'gi7eba', gitignore: 'gi250a', gitattributes: 'gi7d29', mailmap: 'maba30' };
const isDot = (b, f) => hfs(b, f) || ntfsGeneric(b, 0, f, DOT[f]);
const tails = b => [...b.keys()].filter(i => b[i] === 92).map(i => i + 1);

// fsck.c verify_ordered with its name stack
function verifyOrdered(m1, n1, m2, n2, stack) {
  const len = Math.min(n1.length, n2.length);
  const cmp = Buffer.compare(n1.subarray(0, len), n2.subarray(0, len));
  if (cmp < 0) return 0;
  if (cmp > 0) return 'unordered';
  let c1 = at(n1, len), c2 = at(n2, len);
  if (!c1 && !c2) return 'dups';
  if (!c1 && (m1 & S_IFMT) === S_IFDIR) c1 = 47;
  if (!c2 && (m2 & S_IFMT) === S_IFDIR) c2 = 47;
  const lessThanSlash = c => c > 0 && c < 47;
  if (!c1 && lessThanSlash(c2)) stack.push(n1);
  else if (c2 === 47 && lessThanSlash(c1)) {
    for (;;) {
      const f = stack.pop();
      if (!f) break;
      if (!n2.subarray(0, f.length).equals(f) || n2.length < f.length) continue;
      if (n2.length === f.length) return 'dups';
      if (lessThanSlash(n2[f.length])) { stack.push(f); break; }
    }
  }
  return c1 < c2 ? 0 : 'unordered';
}

// → { tree: Set<msgId> (reported on the cell's tree), finish: [{ msgId, on: entry }] (fsck_finish, on the entry's object) }
export function fsckModel(entries) {
  const tree = new Set(), finish = [];
  const decodable = x => parseMode(x.mode) !== null && x.name.length > 0;
  if (entries.length && !decodable(entries[0])) return { tree: new Set(['badTree']), finish };
  let o = null; const stack = [];
  const flags = new Set();
  for (let k = 0; k < entries.length; k++) {
    const x = entries[k], m = parseMode(x.mode), name = x.name;
    if (x.oid === 'null') flags.add('nullSha1');
    if (name.includes(47)) flags.add('fullPathname');
    if (name.length === 1 && name[0] === 46) flags.add('hasDot');
    if (name.length === 2 && name[0] === 46 && name[1] === 46) flags.add('hasDotdot');
    if (hfs(name, 'git') || ntfsGit(name, 0)) flags.add('hasDotgit');
    if (x.mode[0] === '0') flags.add('zeroPaddedFilemode');
    if (name.length > 4096) flags.add('largePathname');
    const lnk = (m & S_IFMT) === S_IFLNK;
    const collect = f => { if (x.oid === 'null' || x.oid === 'gitlink') finish.push({ msgId: `${f}Missing`, on: x }); else if (x.oid === 'tree') finish.push({ msgId: `${f}Blob`, on: x }); };
    if (isDot(name, 'gitmodules')) { if (lnk) tree.add('gitmodulesSymlink'); else collect('gitmodules'); }
    if (isDot(name, 'gitattributes')) { if (lnk) tree.add('gitattributesSymlink'); else collect('gitattributes'); }
    if (lnk && isDot(name, 'gitignore')) tree.add('gitignoreSymlink');
    if (lnk && isDot(name, 'mailmap')) tree.add('mailmapSymlink');
    for (const t of tails(name)) {
      if (ntfsGit(name, t)) flags.add('hasDotgit');
      if (ntfsGeneric(name, t, 'gitmodules', DOT.gitmodules)) { if (lnk) tree.add('gitmodulesSymlink'); else collect('gitmodules'); }
    }
    if (k + 1 < entries.length && !decodable(entries[k + 1])) { tree.add('badTree'); break; }
    if (!STANDARD.has(m)) flags.add('badFilemode');
    if (o) { const r = verifyOrdered(o.m, o.name, m, name, stack); if (r === 'unordered') flags.add('treeNotSorted'); if (r === 'dups') flags.add('duplicateEntries'); }
    o = { m, name };
  }
  for (const f of flags) tree.add(f);
  return { tree, finish };
}

// ply's outcome for a cell, from the model: refuse iff git reports an error-severity msgId (WARN_DECISION decides the
// rest). Returns { ply: 'accept' | 'refuse', errors: [msgId], warnings: [msgId] }.
export function expected(c) {
  const { tree, finish } = fsckModel(entriesOf(c));
  const all = [...tree, ...finish.map(f => f.msgId)];
  const errors = [...new Set(all.filter(m => SEVERITY[m] === 'error'))].sort();
  const warnings = [...new Set(all.filter(m => SEVERITY[m] === 'warning'))].sort();
  for (const m of all) if (!SEVERITY[m]) throw new Error(`no severity for ${m}`);
  for (const w of warnings) if (!WARN_DECISION[w]) throw new Error(`no decision for the warning ${w}`);
  const ply = errors.length ? 'refuse' : warnings.every(w => WARN_DECISION[w].ply === 'accept') ? 'accept' : 'refuse';
  return { ply, errors, warnings };
}

// ply's refusal messages (src/objects.js parseTree) and the msgIds each stands for: a refusal must name one git reported
export const PLY_MESSAGE = [
  [/^tree: malformed entry$/, ['badTree']],
  [/^tree: empty mode$/, ['badTree']],
  [/^tree: malformed mode$/, ['badTree']],
  [/^tree: empty name$/, ['badTree']],
  [/^tree: zero-padded mode$/, ['zeroPaddedFilemode']],
  [/^tree: full pathname$/, ['fullPathname']],
  [/^tree: bad name$/, ['hasDot', 'hasDotdot', 'hasDotgit']],
  [/^tree: large pathname$/, ['largePathname']],
  [/^tree: null sha1$/, ['nullSha1']],
  [/^tree: \.gitmodules is a symbolic link$/, ['gitmodulesSymlink']],
  [/^tree: \.gitmodules is not a blob$/, ['gitmodulesBlob', 'gitmodulesMissing']],
  [/^tree: \.gitattributes is not a blob$/, ['gitattributesBlob', 'gitattributesMissing']],
  [/^tree: duplicate entry /, ['duplicateEntries']],
  [/^tree: not strictly sorted$/, ['treeNotSorted']],
];
export const msgIdsOfPly = message => PLY_MESSAGE.find(([re]) => re.test(message))?.[1] ?? null;

// The Windows checkout rules (compat/mingw.c is_valid_win32_path, read-cache.c verify_path under GIT_WINDOWS_NATIVE),
// derived from the source: no git for Windows runs here. [name, refused?]
export const WIN32 = [
  ['a', false], ['..\\x', true], ['a\\b', true], ['con', true], ['CON.txt', true], ['con .txt', true], ['nul:x', true],
  ['aux ', true], ['prn', true], ['com1', true], ['com0', false], ['lpt0', true], ['conin$', true], ['CONOUT$', true],
  ['console', false], ['a.', true], ['a ', true], ['a:b', true], ['a<b', true], ['a>b', true], ['a"b', true],
  ['a|b', true], ['a?b', true], ['a*b', true], ['a\x01b', true], ['a.b', false], ['.a', false], ['...', true],
];
