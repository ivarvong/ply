// Caller-supplied strings that reach a git object header or a protocol command line are validated here.
// Anything that could terminate a header line or a pkt-line field is rejected rather than escaped: git has no escaping.
import { fail } from './errors.js';
import { requireLimit } from './limits.js';
import { IDENT_TZ_DIGITS, IDENT_TZ_HOUR_MIN, IDENT_TZ_HOUR_MAX, IDENT_TZ_MINUTE_MAX, UTF8_REPLACEMENT } from './format.js';
import { te } from './bytes.js';
const bad = (what, why) => fail('bad_request', `invalid ${what}: ${why}`, { what });

// Brand for an ident that has been through validateIdent. A spread drops it, so ident() cannot be fed a copy.
const VALIDATED_IDENT = Symbol('validatedIdent');
export const isValidatedIdent = person => !!person && person[VALIDATED_IDENT] === true;
const TZ_TEXT = new RegExp(`^[+-][0-9]{${IDENT_TZ_DIGITS}}$`);

export function validateIdent({ name, email, time, tz } = {}) {
  // Exactly fsck.c fsck_ident(): name is everything before " <" and may not contain '<', '>', NUL or newline;
  // email is between '<' and '>' and may not contain '<', '>', NUL or newline. Anything else — punctuation,
  // leading/trailing spaces, tabs, empty name or email — is a valid object. (Verified against git fsck --strict.)
  for (const [k, v] of [['author name', name], ['author email', email]]) {
    if (typeof v !== 'string') throw bad(k, 'must be a string');
    if (/[\0\n<>]/.test(v)) throw bad(k, 'must not contain NUL, newline, < or >');
  }
  // Caller time is a unix epoch. A string would be interpolated into the header; only a safe non-negative integer is.
  if (!Number.isSafeInteger(time) || time < 0) throw bad('time', 'must be a non-negative safe integer');
  // Caller zones are the civil range. fsck_ident does not range-check (checkIdent still accepts +9999). Omitted means UTC.
  if (tz === undefined) tz = '+0000';
  if (typeof tz !== 'string' || !TZ_TEXT.test(tz)) throw bad('tz', 'must be a sign and four digits');
  const hourDigits = IDENT_TZ_DIGITS / 2;
  const sign = tz[0] === '-' ? -1 : 1;
  const hours = sign * Number(tz.slice(1, 1 + hourDigits));
  const minutes = Number(tz.slice(1 + hourDigits));
  if (minutes > IDENT_TZ_MINUTE_MAX || minutes < 0) throw bad('tz', 'minutes out of range');
  if (hours < IDENT_TZ_HOUR_MIN || hours > IDENT_TZ_HOUR_MAX) throw bad('tz', 'hours out of range');
  if ((hours === IDENT_TZ_HOUR_MAX || hours === IDENT_TZ_HOUR_MIN) && minutes !== 0) throw bad('tz', 'extreme offset must be on the hour');
  const person = { name, email, time, tz };
  Object.defineProperty(person, VALIDATED_IDENT, { value: true });
  return Object.freeze(person);
}

// A pkt-line field. CR, LF, or NUL ends the line or the command the way a header injection does.
export function validateWire(value, what) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw bad(what, 'must be a string without NUL, CR, or LF');
  return value;
}

export function validateRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('refs/')) throw bad('ref', 'must be a full ref name starting with refs/');
  // git check-ref-format rules that matter for injection and server acceptance
  if (/[\0\n\r ~^:?*\[\\]|\.\.|@\{|\/\/|\/$|\.$|\.lock(\/|$)|^\/|\/\.|^\.|[\x01-\x1f\x7f]/.test(ref)) throw bad('ref', 'fails check-ref-format');
  if (ref.length > 1024) throw bad('ref', 'too long');
  return ref;
}

// ---- names git fsck refuses in a tree, rule for rule (fsck.c fsck_tree; decided by `git fsck --strict`) ----
// path.c is_ntfs_dotgit: `.git`, or its 8.3 short name `git~1` (only ~1), in any case, then nothing but dots and
// spaces up to the end of the name, an NTFS alternate data stream (`:`) or a directory separator (`/`, `\`). fsck
// applies it to the name and again after every backslash, which Windows would read as a separator.
const NTFS_DOTGIT = /^(\.git|git~1)[. ]*($|[:/\\])/i;
// utf8.c next_hfs_char: the code points HFS+ drops when it compares names.
const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;
const HFS_DOTGIT = /^\.git$/i;
const REPLACEMENT_CHAR = '\ufffd';

// Every start fsck scans a name from: the first byte, and the byte after each backslash.
function scanStarts(name) {
  const starts = [name];
  for (let i = name.indexOf('\\'); i >= 0; i = name.indexOf('\\', i + 1)) starts.push(name.slice(i + 1));
  return starts;
}

// The name as git's HFS+ scan reads it (utf8.c is_hfs_dot_generic): ignorable code points dropped, and nothing past
// the first invalid UTF-8 sequence, where pick_one_utf8_char yields 0 and the scan ends \u2014 `.git` + 0xff is `.git`.
// `bytes` is the raw tree entry name; a caller's path component is valid text and has none.
function hfsText(name, bytes) {
  let cut = bytes === null ? -1 : name.indexOf(REPLACEMENT_CHAR);
  // a literal U+FFFD is the three bytes EF BF BD at its own offset; anything else decoded to it was invalid. A name whose
  // first code point is U+FFFD matches no needle whether it is kept whole or cut to '', so cut === 0 may go either way.
  // Stryker disable next-line EqualityOperator: see above, cut === 0 is immaterial
  while (cut >= 0 && UTF8_REPLACEMENT.every((b, i) => bytes[te.encode(name.slice(0, cut)).length + i] === b)) cut = name.indexOf(REPLACEMENT_CHAR, cut + 1);
  // Stryker disable next-line EqualityOperator: see above, cut === 0 is immaterial
  return (cut < 0 ? name : name.slice(0, cut)).replace(HFS_IGNORABLE, '');
}

// fsck hasDotgit. Verified against `git fsck --strict` (compliance.test.js, git-differential.test.js).
export function isDotGit(name, bytes = null) {
  return scanStarts(name).some(s => NTFS_DOTGIT.test(s)) || HFS_DOTGIT.test(hfsText(name, bytes));
}

// fsck gitmodulesSymlink / gitattributesSymlink / gitignoreSymlink / mailmapSymlink: the four files git opens with
// O_NOFOLLOW may not be symlinks, under any spelling path.c is_ntfs_dot_generic or utf8.c is_hfs_dot_generic
// recognises: `.name`; the 8.3 short name `name[0..6]~[1-4]`; the fall-back short name (up to six characters of
// git's known prefix, `~`, a digit 1\u20139, then digits, eight characters in all) \u2014 each followed by only dots and spaces
// up to the end or a `:` stream \u2014 and the HFS+ spelling. `.gitmodules` is also looked for after every backslash.
const NTFS_SHORT_LEN = 8;
const NTFS_SHORT_BASE = 6;
function ntfsDotfile(dotfile, prefix) {
  const base = dotfile.slice(1);
  const fallback = Array.from({ length: NTFS_SHORT_BASE + 1 }, (_, k) => `${prefix.slice(0, k)}~[1-9][0-9]{${NTFS_SHORT_LEN - 2 - k}}`);
  return new RegExp(`^(?:\\.${base}|${base.slice(0, NTFS_SHORT_BASE)}~[1-4]|${fallback.join('|')})[. ]*($|:)`, 'i');
}
const PROTECTED_DOTFILES = [
  { dotfile: '.gitmodules', ntfs: ntfsDotfile('.gitmodules', 'gi7eba'), hfs: /^\.gitmodules$/i, everyStart: true },
  { dotfile: '.gitattributes', ntfs: ntfsDotfile('.gitattributes', 'gi7d29'), hfs: /^\.gitattributes$/i, everyStart: false },
  { dotfile: '.gitignore', ntfs: ntfsDotfile('.gitignore', 'gi250a'), hfs: /^\.gitignore$/i, everyStart: false },
  { dotfile: '.mailmap', ntfs: ntfsDotfile('.mailmap', 'maba30'), hfs: /^\.mailmap$/i, everyStart: false },
];
// The protected dotfile a name denotes, or null.
export function protectedDotfile(name, bytes = null) {
  const hfs = hfsText(name, bytes);
  for (const d of PROTECTED_DOTFILES) {
    if ((d.everyStart ? scanStarts(name) : [name]).some(s => d.ntfs.test(s)) || d.hfs.test(hfs)) return d.dotfile;
  }
  return null;
}

export function validatePath(path, limits) {
  if (typeof path !== 'string' || path.length === 0) throw bad('path', 'must be a non-empty string');
  const maxDepth = requireLimit(limits, 'maxPathDepth');
  const maxComponent = requireLimit(limits, 'maxPathComponent');
  const comps = path.split('/');
  if (comps.length > maxDepth) throw bad('path', `depth ${comps.length} exceeds ${maxDepth}`);
  for (const c of comps) {
    if (c === '' ) throw bad('path', 'empty component (leading, trailing or doubled slash)');
    if (c === '.' || c === '..' || isDotGit(c)) throw bad('path', `component ${JSON.stringify(c)} not allowed (git fsck hasDotgit)`);
    if (c.includes('\0')) throw bad('path', 'NUL in component');
    if (c.length > maxComponent) throw bad('path', 'component too long');
  }
  return comps;
}

export function validateMessage(message) {
  if (typeof message !== 'string') throw bad('message', 'must be a string');
  if (message.includes('\0')) throw bad('message', 'NUL not allowed');
  return message;
}

