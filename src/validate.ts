// Caller-supplied strings that reach a git object header or a protocol command line are validated here.
// Anything that could terminate a header line or a pkt-line field is rejected rather than escaped: git has no escaping.
// Each check returns a Result.
import { fail } from './errors.js';
import type { ErrorOf } from './errors.js';
import { parseLimits } from './limits.js';
import type { LimitsInput } from './limits.js';
import { encodeBytes, te } from './bytes.js';
import { MODE_LINK, IDENT_TZ_DIGITS, IDENT_TZ_HOUR_MIN, IDENT_TZ_HOUR_MAX, IDENT_TZ_MINUTE_MAX } from './format.js';
import type { Err, Option, Result } from './result.js';
import { none, ok, some } from './result.js';
import type { Input } from './absent.js';
import { withDefaults } from './absent.js';
import type { Refname } from './refname.js';
import type { Path } from './path.js';

type Bad = ErrorOf<'bad_request'>;
const bad = (what: string, why: string): Err<Bad> => fail('bad_request', `invalid ${what}: ${why}`, { what });

// Brand for an ident that has been through validateIdent. A spread drops it, so ident() cannot be fed a copy.
const VALIDATED_IDENT: unique symbol = Symbol('validatedIdent');
export type Ident = { readonly name: string; readonly email: string; readonly time: number; readonly tz: string };
export type ValidatedIdent = Ident & { readonly [VALIDATED_IDENT]: true };
// What a caller hands validateIdent: anything, field by field (a public input record, parsed once below).
export type IdentFields = { readonly name: unknown; readonly email: unknown; readonly time: unknown; readonly tz: unknown };
export type IdentInput = Input<IdentFields>;
export const isValidatedIdent = (person: unknown): person is ValidatedIdent =>
  typeof person === 'object' && person !== null && Reflect.get(person, VALIDATED_IDENT) === true;
const TZ_TEXT = new RegExp(`^[+-][0-9]{${IDENT_TZ_DIGITS}}$`, 'u');
// A field the caller left out is null here, which every check below refuses as it refused the missing value. An
// omitted zone means UTC (a null one is refused, as before).
const identDefaults = (): IdentFields => ({ name: null, email: null, time: null, tz: '+0000' });

export function validateIdent(input: IdentInput = {}): Result<ValidatedIdent, Bad> {
  const { name, email, time, tz } = withDefaults(input, identDefaults());
  // Exactly fsck.c fsck_ident(): name is everything before " <" and may not contain '<', '>', NUL or newline;
  // email is between '<' and '>' and may not contain '<', '>', NUL or newline. Anything else — punctuation,
  // leading/trailing spaces, tabs, empty name or email — is a valid object. (Verified against git fsck --strict.)
  for (const [k, v] of [['author name', name], ['author email', email]] as const) {
    if (typeof v !== 'string') return bad(k, 'must be a string');
    if (/[\0\n<>]/u.test(v)) return bad(k, 'must not contain NUL, newline, < or >');
  }
  // Caller time is a unix epoch. A string would be interpolated into the header; only a safe non-negative integer is.
  if (!Number.isSafeInteger(time) || Number(time) < 0) return bad('time', 'must be a non-negative safe integer');
  // Caller zones are the civil range. fsck_ident does not range-check (checkIdent still accepts +9999).
  if (typeof tz !== 'string' || !TZ_TEXT.test(tz)) return bad('tz', 'must be a sign and four digits');
  const hourDigits = IDENT_TZ_DIGITS / 2;
  const sign = tz.startsWith('-') ? -1 : 1;
  const hours = sign * Number(tz.slice(1, 1 + hourDigits));
  const minutes = Number(tz.slice(1 + hourDigits));
  if (minutes > IDENT_TZ_MINUTE_MAX || minutes < 0) return bad('tz', 'minutes out of range');
  if (hours < IDENT_TZ_HOUR_MIN || hours > IDENT_TZ_HOUR_MAX) return bad('tz', 'hours out of range');
  if ((hours === IDENT_TZ_HOUR_MAX || hours === IDENT_TZ_HOUR_MIN) && minutes !== 0) return bad('tz', 'extreme offset must be on the hour');
  const person = { name, email, time, tz };
  Object.defineProperty(person, VALIDATED_IDENT, { value: true });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the loop above checked name and email, defineProperty added the brand; neither narrows the type
  return ok(Object.freeze(person) as ValidatedIdent);
}

// A pkt-line field. CR, LF, or NUL ends the line or the command the way a header injection does.
declare const wireBrand: unique symbol;
/** One pkt-line field: a string without NUL, CR, or LF (validateWire grants the brand, and nothing else does). */
export type WireField = string & { readonly [wireBrand]: typeof wireBrand };
// The whole check, and the brand it grants.
const isWireField = (value: unknown): value is WireField => typeof value === 'string' && !/[\0\r\n]/u.test(value);
export function validateWire(value: unknown, what: string): Result<WireField, Bad> {
  if (!isWireField(value)) return bad(what, 'must be a string without NUL, CR, or LF');
  return ok(value);
}

// The first check of validateRef, and the brand it grants: a value leaves validateRef as a Refname only
// after every check below it, so the brand is the whole check (refname.ts reads the brand; no second test).
const isFullRef = (ref: unknown): ref is Refname => typeof ref === 'string' && ref.startsWith('refs/');

export function validateRef(ref: unknown): Result<Refname, Bad> {
  if (!isFullRef(ref)) return bad('ref', 'must be a full ref name starting with refs/');
  // git check-ref-format rules that matter for injection and server acceptance
  // (NUL, CR, LF and the other controls are one class: check-ref-format refuses all of them)
  // oxlint-disable-next-line no-control-regex -- check-ref-format refuses control characters; matching them is the point
  if (/[\0-\u001F\u007F ~^:?*[\\]|\.\.|@\{|\/\/|\/$|\.$|\.lock(\/|$)|^\/|\/\.|^\./u.test(ref)) return bad('ref', 'fails check-ref-format');
  if (ref.length > 1024) return bad('ref', 'too long');
  // a lone surrogate would be written as U+FFFD (TextEncoder); only an escaped byte from a read maps back (#43)
  const bytes = encodeBytes(ref, 'ref');
  if (!bytes.ok) return bytes;
  return ok(ref);
}

// A ref a push may name: git v2.50.0 receive-pack.c update() refuses anything else as "funny refname", checking the name
// after "refs/" with check_refname_format(name + 5, deleting ? REFNAME_ALLOW_ONELEVEL : 0). validateRef already holds the
// full name to check_refname_format, so every component passes; what is left is the part after refs/ as a refname of its
// own: it may not be exactly "@" (refs/@), and a create or update needs two components there (refs/foo can be deleted,
// never written). Proved cell by cell against git in test/space/refname.test.js.
// Any value: validateRef refuses a non-string (push.ts parses a caller's command with it).
export function validatePushRef(ref: unknown, deleting: boolean): Result<Refname, Bad> {
  const full = validateRef(ref);
  if (!full.ok) return full;
  const name = full.value.slice('refs/'.length);
  if (name === '@' || (!deleting && !name.includes('/'))) return bad('ref', 'receive-pack refuses it (funny refname)');
  return full;
}

// ---- git's spellings of .git and its dotfiles (git v2.50.0 utf8.c is_hfs_dot*, path.c is_ntfs_dot*), on name bytes ----
// Ported line by line, because the edges are where a name gets through: `git~1` but not `git~2`; `.git:x` (an NTFS
// stream) and `.git . .` (NTFS trims trailing dots and spaces); `.g\u200cit` and `.git\xff` (HFS+ skips ignorable code
// points, and git treats an invalid UTF-8 sequence after `.git` as the end of the name); `gi7eba~1` and `~1234567` (the
// NTFS fallback short names of .gitmodules); `a\.git` (fsck reads a backslash as a separator, whatever the platform).
// Case folds ASCII only (git's tolower), never Unicode. The fuzz-free check of all of it: test/space/fsck-tree.test.js.
// These run on every tree entry (#207): nothing below allocates. The needles are encoded once, here; a code point and its
// length are two calls, not a tuple; the loops are inline, not closures. test/dotnames.test.js holds every function
// below to the version before #207 (test/oracle/dotnames-ref.ts) over every byte string up to three bytes, every
// spelling's truncations and one-byte substitutions, and random names; test/fuzz/dotnames.mjs runs the large campaign.
// Past the end reads 0 (git's NUL terminator); no caller passes a negative index.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- i < b.length: the read is in range (`as`, not the `!` src/ forbids)
const at = (b: Uint8Array, i: number): number => (i < b.length ? (b[i] as number) : 0);
const lower = (c: number): number => (c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
// ASCII needles only: their UTF-8 bytes are their code points
const ascii = (s: string): Uint8Array => te.encode(s);
const GIT = ascii('git');
const IT_TILDE_1 = ascii('it~1');

// utf8.c pick_one_utf8_char at i: the sequence's length (1 to 4), or 0 for what git calls invalid (C0/C1 leads, overlong
// 3- and 4-byte forms, surrogates, U+FFFE/U+FFFF, above U+10FFFF, a cut sequence). Its code point is codePointAt's.
const cont = (c: number): boolean => (c & 0xc0) === 0x80;
// oxlint-disable-next-line eslint/complexity -- pick_one_utf8_char line for line
function utf8Length(b: Uint8Array, i: number): number {
  const s0 = at(b, i);
  if (s0 < 0x80) return 1;
  const s1 = at(b, i + 1);
  if ((s0 & 0xe0) === 0xc0) return !cont(s1) || (s0 & 0xfe) === 0xc0 ? 0 : 2;
  const s2 = at(b, i + 2);
  if ((s0 & 0xf0) === 0xe0) {
    if (!cont(s1) || !cont(s2) || (s0 === 0xe0 && (s1 & 0xe0) === 0x80) || (s0 === 0xed && (s1 & 0xe0) === 0xa0) || (s0 === 0xef && s1 === 0xbf && (s2 & 0xfe) === 0xbe)) return 0;
    return 3;
  }
  const s3 = at(b, i + 3);
  if ((s0 & 0xf8) === 0xf0) {
    if (!cont(s1) || !cont(s2) || !cont(s3) || (s0 === 0xf0 && (s1 & 0xf0) === 0x80) || (s0 === 0xf4 && s1 > 0x8f) || s0 > 0xf4) return 0;
    return 4;
  }
  return 0;
}
// The code point of the `len`-byte sequence at i (utf8Length's answer, not 0)
function codePointAt(b: Uint8Array, i: number, len: number): number {
  const s0 = at(b, i);
  if (len === 1) return s0;
  if (len === 2) return ((s0 & 0x1f) << 6) | (at(b, i + 1) & 0x3f);
  if (len === 3) return ((s0 & 0x0f) << 12) | ((at(b, i + 1) & 0x3f) << 6) | (at(b, i + 2) & 0x3f);
  return ((s0 & 0x07) << 18) | ((at(b, i + 1) & 0x3f) << 12) | ((at(b, i + 2) & 0x3f) << 6) | (at(b, i + 3) & 0x3f);
}
// utf8.c next_hfs_char's list: U+200C..U+200F, U+202A..U+202E, U+206A..U+206F, U+FEFF
const hfsIgnored = (cp: number): boolean =>
  (cp >= 0x20_0c && cp <= 0x20_0f) || (cp >= 0x20_2a && cp <= 0x20_2e) || (cp >= 0x20_6a && cp <= 0x20_6f) || cp === 0xfe_ff;
// utf8.c is_hfs_dot_generic: `.` and the needle, ASCII case folded, then the end or `/`, reading code points with
// next_hfs_char (the ones HFS+ ignores are skipped; an invalid sequence reads as 0, the end). k = -1 reads the dot,
// k = needle.length the end. Every read decides: a 0 (an invalid sequence, or the end) is the end at k = needle.length
// and fails every other read, so nothing is read after one (git's "0 from then on" is never consulted). git also
// refuses a code point above 127 before folding; lower() leaves one unchanged and no needle byte is above 127, so the
// comparison alone refuses it.
function isHfsDot(b: Uint8Array, needle: Uint8Array): boolean {
  let i = 0;
  for (let k = -1; ; k++) {
    let c = 0;
    for (;;) {
      const len = utf8Length(b, i);
      if (len === 0) break;
      const cp = codePointAt(b, i, len);
      i += len;
      if (!hfsIgnored(cp)) { c = cp; break; }
    }
    if (k === needle.length) return c === 0 || c === 0x2f;
    if (k < 0 ? c !== 0x2e : lower(c) !== needle[k]) return false;
  }
}
// The `count` bytes at i are `needle`'s first `count`, ASCII case folded
function foldedAt(b: Uint8Array, i: number, needle: Uint8Array, count: number): boolean {
  for (let k = 0; k < count; k++) if (lower(at(b, i + k)) !== needle[k]) return false;
  return true;
}
// path.c is_ntfs_dotgit, from offset `o`: `.git` or `git~1`, then only dots and spaces up to the end, a separator
// (`/` or `\`) or `:`. git folds case for the letters only (`.git`, and `gi` of `git~1`); folding `~1` too is the same
// test, since lower() changes only A-Z.
function isNtfsDotGit(b: Uint8Array, o: number): boolean {
  const c0 = at(b, o);
  if (c0 !== 0x2e && lower(c0) !== 0x67) return false;
  const want = c0 === 0x2e ? GIT : IT_TILDE_1;
  if (!foldedAt(b, o + 1, want, want.length)) return false;
  for (let i = o + 1 + want.length; ; i++) {
    const c = at(b, i);
    if (c === 0 || c === 0x2f || c === 0x5c || c === 0x3a) return true;
    if (c !== 0x2e && c !== 0x20) return false;
  }
}
// is_ntfs_dot_generic's tail from i: only dots and spaces up to the end or `:`
function ntfsTail(b: Uint8Array, i: number): boolean {
  for (let j = i; ; j++) {
    const x = at(b, j);
    if (x === 0 || x === 0x3a) return true;
    if (x !== 0x20 && x !== 0x2e) return false;
  }
}
type DotSpelling = { readonly name: Uint8Array; readonly prefix: Uint8Array };
// path.c is_ntfs_dot_generic, from offset `o`: `.<name>`, its 6-character short name `<name[0..6]>~1`..`~4`, or the
// fallback short name (`<prefix>~N` with digits to 8 characters), then only dots and spaces up to the end or `:`
function isNtfsDot(b: Uint8Array, o: number, { name, prefix }: DotSpelling): boolean {
  if (at(b, o) === 0x2e && foldedAt(b, o + 1, name, name.length)) return ntfsTail(b, o + name.length + 1);
  if (foldedAt(b, o, name, 6) && at(b, o + 6) === 0x7e && at(b, o + 7) >= 0x31 && at(b, o + 7) <= 0x34) return ntfsTail(b, o + 8);
  let sawTilde = false;
  for (let i = 0; i < 8; i++) {
    const x = at(b, o + i);
    if (x === 0) return false;
    if (sawTilde) { if (x < 0x30 || x > 0x39) return false; }
    else if (x === 0x7e) { const d = at(b, o + ++i); if (d < 0x31 || d > 0x39) return false; sawTilde = true; }
    // git also refuses i >= 6 and a byte >= 0x80 here: past the prefix's 6 bytes at() reads 0, which x is not (refused
    // above), and lower() leaves a byte >= 0x80 unchanged, which no prefix byte is; the comparison refuses both
    else if (lower(x) !== at(prefix, i)) return false;
  }
  return ntfsTail(b, o + 8);
}
export type DotFile = 'gitmodules' | 'gitignore' | 'gitattributes' | 'mailmap';
const dot = (name: string, prefix: string): DotSpelling => ({ name: ascii(name), prefix: ascii(prefix) });
const DOTFILES: Readonly<Record<DotFile, DotSpelling>> = {
  gitmodules: dot('gitmodules', 'gi7eba'), gitignore: dot('gitignore', 'gi250a'), gitattributes: dot('gitattributes', 'gi7d29'), mailmap: dot('mailmap', 'maba30'),
};
const GITMODULES = DOTFILES.gitmodules.name;
// is_ntfs_dotgit (`dotgit`) or is_ntfs_dot<file> after any backslash in the name (fsck_tree's offsets past the first)
function afterBackslash(b: Uint8Array, dotgit: boolean): boolean {
  for (let i = b.indexOf(0x5c); i >= 0; i = b.indexOf(0x5c, i + 1)) {
    if (dotgit ? isNtfsDotGit(b, i + 1) : isNtfsDot(b, i + 1, DOTFILES.gitmodules)) return true;
  }
  return false;
}
// Every spelling above, from offset 0, starts with one of these bytes: `.`; the lead byte of an HFS+ ignorable (E2 for
// U+20xx, EF for U+FEFF), which isHfsDot skips before the dot; `g`/`G` (git~1, and every name's and prefix's first
// letter but mailmap's) and `m`/`M` (mailmap's); `~` (a fallback short name with no prefix, `~1234567`). Any other first
// byte, the end (an empty name) included, fails each check at its first read. A name that also holds no backslash has no
// other offset to look at: it spells nothing (the common case: one switch and one indexOf).
function maySpell(b: Uint8Array): boolean {
  switch (at(b, 0)) {
    case 0x2e: case 0xe2: case 0xef: case 0x67: case 0x47: case 0x6d: case 0x4d: case 0x7e: return true;
    default: return b.includes(0x5c);
  }
}

// fsck hasDotgit for one tree entry name (bytes): is_hfs_dotgit || is_ntfs_dotgit, and is_ntfs_dotgit after a backslash
export const isDotGitName = (b: Uint8Array): boolean => maySpell(b) && (isHfsDot(b, GIT) || isNtfsDotGit(b, 0) || afterBackslash(b, true));
// fsck's `is_hfs_dot<file> || is_ntfs_dot<file>` for file \u2208 gitmodules, gitignore, gitattributes, mailmap; for
// .gitmodules also after a backslash (fsck_tree checks only that one there)
export const isDotFileName = (b: Uint8Array, file: DotFile): boolean => {
  const spelling = DOTFILES[file];
  return maySpell(b) && (isHfsDot(b, spelling.name) || isNtfsDot(b, 0, spelling) || (file === 'gitmodules' && afterBackslash(b, false)));
};

// read-cache.c verify_path for the checkout of one path (`/`-separated tree names) of `mode` (canonical) on `platform`
// (process.platform), with git's defaults: core.protectNTFS on everywhere, core.protectHFS on macOS. Returns the reason
// git refuses it, or None. Every name parseTree accepts passes on Linux and macOS (fsck --strict refuses a superset:
// test/space/fsck-tree.test.js checks it against `git read-tree` with both protections on); this is the check at the
// point of writing all the same. On Windows a backslash is a separator (verify_path refuses it outright) and
// compat/mingw.c is_valid_win32_path refuses the characters `: < > " | ? *` and controls, a component ending in a space or
// a period, and the reserved device names (AUX, CON, NUL, PRN, COM1-9, LPT0-9, CONIN$, CONOUT$, whatever follows them
// after spaces, a period or a colon). A component with no byte form (a lone surrogate) is a bad_request.
export function checkoutPathRefusal(path: string, mode: string, platform: string): Result<Option<string>, Bad> {
  const comps = path.split('/');
  for (const [k, c] of comps.entries()) {
    const encoded = encodeBytes(c, 'checkout path');
    if (!encoded.ok) return encoded;
    const b = encoded.value;
    if (c === '' || c === '.' || c === '..') return ok(some('an empty, `.` or `..` component'));
    if (isDotGitName(b)) return ok(some('a spelling of .git'));
    // git compares ASCII case-insensitively; /iu would also fold U+017F to s (and U+212A to k)
    // oxlint-disable-next-line eslint/require-unicode-regexp -- see above
    if (mode === MODE_LINK && (/^\.gitmodules$/i.test(c) || (platform === 'darwin' && isHfsDot(b, GITMODULES)) || (k === comps.length - 1 && isDotFileName(b, 'gitmodules')))) return ok(some('a symlink at a spelling of .gitmodules'));
  }
  if (platform !== 'win32') return ok(none);
  if (path.includes('\\')) return ok(some('a backslash (a separator on Windows)'));
  for (const c of comps) {
    // oxlint-disable-next-line no-control-regex -- is_valid_win32_path refuses control characters; matching them is the point
    if (/[:<>"|?*\u0001-\u001F]/u.test(c)) return ok(some('a character Windows refuses in a name'));
    if (/[ .]$/u.test(c)) return ok(some('a name ending in a space or a period'));
    // oxlint-disable-next-line eslint/require-unicode-regexp -- ASCII case folding, as git's strncasecmp; /iu folds U+017F and U+212A too
    if (/^(aux|prn|nul|con|com[1-9]|lpt[0-9]|conin\$|conout\$) *([.:]|$)/i.test(c)) return ok(some('a reserved Windows device name'));
  }
  return ok(none);
}

// The first check of validatePath, and the brand it grants: the value leaves as a Path only after every check
// below it (path.ts reads the brand; no second test).
const isPathText = (path: unknown): path is Path => typeof path === 'string' && path.length > 0;
// A validated path and its components (the path is their `/` join: split and join are inverses).
export type ValidPath = { readonly path: Path; readonly components: string[] };

// `limits`: the caller's record (any subset, a key left out is the default; null, the default, is DEFAULT_LIMITS),
// parsed once (parseLimits) and read for maxPathDepth and maxPathComponent.
export function validatePath(path: unknown, limits: LimitsInput | null = null): Result<ValidPath, Bad> {
  if (!isPathText(path)) return bad('path', 'must be a non-empty string');
  const checked = parseLimits(limits);
  if (!checked.ok) return checked;
  const { maxPathDepth: maxDepth, maxPathComponent: maxComponent } = checked.value;
  const comps = path.split('/');
  if (comps.length > maxDepth) return bad('path', `depth ${comps.length} exceeds ${maxDepth}`);
  for (const c of comps) {
    if (c === '' ) return bad('path', 'empty component (leading, trailing or doubled slash)');
    // Every component is encoded, so the whole path is too (a `/` cannot complete a surrogate pair).
    const bytes = encodeBytes(c, 'path');
    if (!bytes.ok) return bytes;
    if (c === '.' || c === '..' || isDotGitName(bytes.value)) return bad('path', `component ${JSON.stringify(c)} not allowed (git fsck hasDotgit)`);
    if (c.includes('\0')) return bad('path', 'NUL in component');
    if (c.length > maxComponent) return bad('path', 'component too long');
  }
  return ok({ path, components: comps });
}

export function validateMessage(message: unknown): Result<string, Bad> {
  if (typeof message !== 'string') return bad('message', 'must be a string');
  if (message.includes('\0')) return bad('message', 'NUL not allowed');
  const bytes = encodeBytes(message, 'message');
  if (!bytes.ok) return bytes;
  return ok(message);
}
