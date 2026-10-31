// Caller-supplied strings that reach a git object header or a protocol command line are validated here.
// Anything that could terminate a header line or a pkt-line field is rejected rather than escaped: git has no escaping.
import { thrown as fail } from './errors.js';
import type { ErrorOf } from './errors.js';
import { requireLimit } from './limits.js';
import type { Limits } from './limits.js';
import { encodeBytes, te } from './bytes.js';
import { MODE_LINK, IDENT_TZ_DIGITS, IDENT_TZ_HOUR_MIN, IDENT_TZ_HOUR_MAX, IDENT_TZ_MINUTE_MAX } from './format.js';
const bad = (what: string, why: string): ErrorOf<'bad_request'> => fail('bad_request', `invalid ${what}: ${why}`, { what });

// Brand for an ident that has been through validateIdent. A spread drops it, so ident() cannot be fed a copy.
const VALIDATED_IDENT: unique symbol = Symbol('validatedIdent');
export type Ident = { readonly name: string; readonly email: string; readonly time: number; readonly tz: string };
export type ValidatedIdent = Ident & { readonly [VALIDATED_IDENT]: true };
// What a caller hands validateIdent: anything, field by field.
export type IdentInput = { readonly name?: unknown; readonly email?: unknown; readonly time?: unknown; readonly tz?: unknown };
type MaybeBranded = { readonly [VALIDATED_IDENT]?: unknown } | null | undefined;
export const isValidatedIdent = (person: MaybeBranded): person is ValidatedIdent => !!person && person[VALIDATED_IDENT] === true;
const TZ_TEXT = new RegExp(`^[+-][0-9]{${IDENT_TZ_DIGITS}}$`, 'u');

export function validateIdent({ name, email, time, tz = '+0000' }: IdentInput = {}): ValidatedIdent {
  // Exactly fsck.c fsck_ident(): name is everything before " <" and may not contain '<', '>', NUL or newline;
  // email is between '<' and '>' and may not contain '<', '>', NUL or newline. Anything else — punctuation,
  // leading/trailing spaces, tabs, empty name or email — is a valid object. (Verified against git fsck --strict.)
  for (const [k, v] of [['author name', name], ['author email', email]] as const) {
    if (typeof v !== 'string') throw bad(k, 'must be a string');
    if (/[\0\n<>]/u.test(v)) throw bad(k, 'must not contain NUL, newline, < or >');
  }
  // Caller time is a unix epoch. A string would be interpolated into the header; only a safe non-negative integer is.
  if (!Number.isSafeInteger(time) || Number(time) < 0) throw bad('time', 'must be a non-negative safe integer');
  // Caller zones are the civil range. fsck_ident does not range-check (checkIdent still accepts +9999). Omitted means UTC
  // (the parameter default: undefined only, as before).
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
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the loop above checked name and email, defineProperty added the brand; neither narrows the type
  return Object.freeze(person) as ValidatedIdent;
}

// A pkt-line field. CR, LF, or NUL ends the line or the command the way a header injection does.
export function validateWire(value: unknown, what: string): string {
  if (typeof value !== 'string' || /[\0\r\n]/u.test(value)) throw bad(what, 'must be a string without NUL, CR, or LF');
  return value;
}

export function validateRef(ref: unknown): string {
  if (typeof ref !== 'string' || !ref.startsWith('refs/')) throw bad('ref', 'must be a full ref name starting with refs/');
  // git check-ref-format rules that matter for injection and server acceptance
  // (NUL, CR, LF and the other controls are one class: check-ref-format refuses all of them)
  // oxlint-disable-next-line no-control-regex -- check-ref-format refuses control characters; matching them is the point
  if (/[\0-\u001F\u007F ~^:?*[\\]|\.\.|@\{|\/\/|\/$|\.$|\.lock(\/|$)|^\/|\/\.|^\./u.test(ref)) throw bad('ref', 'fails check-ref-format');
  if (ref.length > 1024) throw bad('ref', 'too long');
  // a lone surrogate would be written as U+FFFD (TextEncoder); only an escaped byte from a read maps back (#43)
  encodeBytes(ref, 'ref');
  return ref;
}

// A ref a push may name: git v2.50.0 receive-pack.c update() refuses anything else as "funny refname", checking the name
// after "refs/" with check_refname_format(name + 5, deleting ? REFNAME_ALLOW_ONELEVEL : 0). validateRef already holds the
// full name to check_refname_format, so every component passes; what is left is the part after refs/ as a refname of its
// own: it may not be exactly "@" (refs/@), and a create or update needs two components there (refs/foo can be deleted,
// never written). Proved cell by cell against git in test/space/refname.test.js.
// The ref is typed string (push.js's callers pass one); validateRef still refuses a non-string at run time.
export function validatePushRef(ref: string, deleting: boolean): string {
  const name = validateRef(ref).slice(5); // after "refs/"
  if (name === '@' || (!deleting && !name.includes('/'))) throw bad('ref', 'receive-pack refuses it (funny refname)');
  return ref;
}

// ---- git's spellings of .git and its dotfiles (git v2.50.0 utf8.c is_hfs_dot*, path.c is_ntfs_dot*), on name bytes ----
// Ported line by line, because the edges are where a name gets through: `git~1` but not `git~2`; `.git:x` (an NTFS
// stream) and `.git . .` (NTFS trims trailing dots and spaces); `.g\u200cit` and `.git\xff` (HFS+ skips ignorable code
// points, and git treats an invalid UTF-8 sequence after `.git` as the end of the name); `gi7eba~1` and `~1234567` (the
// NTFS fallback short names of .gitmodules); `a\.git` (fsck reads a backslash as a separator, whatever the platform).
// Case folds ASCII only (git's tolower), never Unicode. The fuzz-free check of all of it: test/space/fsck-tree.test.js.
// Past the end reads 0 (git's NUL terminator); no caller passes a negative index.
const at = (b: Uint8Array, i: number): number => b[i] ?? 0;
const lower = (c: number): number => (c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
// ASCII needles only: their UTF-8 bytes are their code points
const ascii = (s: string): Uint8Array => te.encode(s);

// utf8.c pick_one_utf8_char: [code point, length], or null for what git calls invalid (C0/C1 leads, overlong 3- and
// 4-byte forms, surrogates, U+FFFE/U+FFFF, above U+10FFFF, a cut sequence).
type Utf8Char = readonly [codePoint: number, length: number];
const cont = (c: number): boolean => (c & 0xc0) === 0x80;
// oxlint-disable-next-line eslint/complexity -- pick_one_utf8_char line for line, inline: a helper costs bytes on every entry
function utf8At(b: Uint8Array, i: number): Utf8Char | null {
  const s0 = at(b, i), s1 = at(b, i + 1), s2 = at(b, i + 2), s3 = at(b, i + 3);
  if (s0 < 0x80) return [s0, 1];
  if ((s0 & 0xe0) === 0xc0) return !cont(s1) || (s0 & 0xfe) === 0xc0 ? null : [((s0 & 0x1f) << 6) | (s1 & 0x3f), 2];
  if ((s0 & 0xf0) === 0xe0) {
    if (!cont(s1) || !cont(s2) || (s0 === 0xe0 && (s1 & 0xe0) === 0x80) || (s0 === 0xed && (s1 & 0xe0) === 0xa0) || (s0 === 0xef && s1 === 0xbf && (s2 & 0xfe) === 0xbe)) return null;
    return [((s0 & 0x0f) << 12) | ((s1 & 0x3f) << 6) | (s2 & 0x3f), 3];
  }
  if ((s0 & 0xf8) === 0xf0) {
    if (!cont(s1) || !cont(s2) || !cont(s3) || (s0 === 0xf0 && (s1 & 0xf0) === 0x80) || (s0 === 0xf4 && s1 > 0x8f) || s0 > 0xf4) return null;
    return [((s0 & 0x07) << 18) | ((s1 & 0x3f) << 12) | ((s2 & 0x3f) << 6) | (s3 & 0x3f), 4];
  }
  return null;
}
// utf8.c next_hfs_char: the code points HFS+ ignores are skipped; an invalid sequence reads as 0 (the end) from then on
const HFS_IGNORED = new Set([0x20_0c, 0x20_0d, 0x20_0e, 0x20_0f, 0x20_2a, 0x20_2b, 0x20_2c, 0x20_2d, 0x20_2e, 0x20_6a, 0x20_6b, 0x20_6c, 0x20_6d, 0x20_6e, 0x20_6f, 0xfe_ff]);
function isHfsDot(b: Uint8Array, needle: string): boolean {
  let i = 0;
  const next = (): number => {
    for (;;) {
      if (i < 0) return 0;
      const r = utf8At(b, i);
      if (r === null) { i = -1; return 0; }
      i += r[1];
      if (!HFS_IGNORED.has(r[0])) return r[0];
    }
  };
  if (next() !== 0x2e) return false;
  for (const n of ascii(needle)) { const c = next(); if (c > 127 || lower(c) !== n) return false; }
  const c = next();
  return c === 0 || c === 0x2f;
}
// path.c is_ntfs_dotgit, from offset `o`: `.git` or `git~1`, then only dots and spaces up to the end, a separator
// (`/` or `\`) or `:`
function isNtfsDotGit(b: Uint8Array, o: number): boolean {
  let i = o;
  const c0 = at(b, i++);
  if (c0 !== 0x2e && lower(c0) !== 0x67) return false;
  const want = c0 === 0x2e ? 'git' : 'it~1';
  for (const [k, n] of ascii(want).entries()) { const c = at(b, i++); if ((k < 2 || c0 === 0x2e ? lower(c) : c) !== n) return false; }
  for (;;) {
    const c = at(b, i++);
    if (c === 0 || c === 0x2f || c === 0x5c || c === 0x3a) return true;
    if (c !== 0x2e && c !== 0x20) return false;
  }
}
// path.c is_ntfs_dot_generic, from offset `o`: `.<name>`, its 6-character short name `<name[0..6]>~1`..`~4`, or the
// fallback short name (`<prefix>~N` with digits to 8 characters), then only dots and spaces up to the end or `:`
function isNtfsDot(b: Uint8Array, o: number, name: string, prefix: string): boolean {
  const c = (k: number): number => at(b, o + k), n = ascii(name), p = ascii(prefix);
  const rest = (from: number): boolean => { for (let i = from; ; i++) { const x = c(i); if (x === 0 || x === 0x3a) return true; if (x !== 0x20 && x !== 0x2e) return false; } };
  if (c(0) === 0x2e && n.every((x, k) => lower(c(k + 1)) === x)) return rest(n.length + 1);
  if (n.slice(0, 6).every((x, k) => lower(c(k)) === x) && c(6) === 0x7e && c(7) >= 0x31 && c(7) <= 0x34) return rest(8);
  let sawTilde = false;
  for (let i = 0; i < 8; i++) {
    const x = c(i);
    if (x === 0) return false;
    if (sawTilde) { if (x < 0x30 || x > 0x39) return false; }
    else if (x === 0x7e) { const d = c(++i); if (d < 0x31 || d > 0x39) return false; sawTilde = true; }
    else if (i >= 6 || x & 0x80 || lower(x) !== p[i]) return false;
  }
  return rest(8);
}
export type DotFile = 'gitmodules' | 'gitignore' | 'gitattributes' | 'mailmap';
const DOTFILES: Readonly<Record<DotFile, readonly [name: string, prefix: string]>> = {
  gitmodules: ['gitmodules', 'gi7eba'], gitignore: ['gitignore', 'gi250a'], gitattributes: ['gitattributes', 'gi7d29'], mailmap: ['mailmap', 'maba30'],
};
// The offsets fsck_tree looks at: the name, and the rest after each backslash in it
const backslashTails = (b: Uint8Array): number[] => { const out: number[] = []; for (let i = 0; i < b.length; i++) if (b[i] === 0x5c) out.push(i + 1); return out; };

// fsck hasDotgit for one tree entry name (bytes): is_hfs_dotgit || is_ntfs_dotgit, and is_ntfs_dotgit after a backslash
export const isDotGitName = (b: Uint8Array): boolean => isHfsDot(b, 'git') || isNtfsDotGit(b, 0) || backslashTails(b).some(o => isNtfsDotGit(b, o));
// fsck's `is_hfs_dot<file> || is_ntfs_dot<file>` for file \u2208 gitmodules, gitignore, gitattributes, mailmap; for
// .gitmodules also after a backslash (fsck_tree checks only that one there)
export const isDotFileName = (b: Uint8Array, file: DotFile): boolean => {
  const [name, prefix] = DOTFILES[file];
  return isHfsDot(b, name) || isNtfsDot(b, 0, name, prefix) || (file === 'gitmodules' && backslashTails(b).some(o => isNtfsDot(b, o, name, prefix)));
};
// A component of a caller path: refused where fsck refuses the tree entry name
export const isDotGit = (c: string): boolean => isDotGitName(encodeBytes(c, 'path'));

// read-cache.c verify_path for the checkout of one path (`/`-separated tree names) of `mode` (canonical) on `platform`
// (process.platform), with git's defaults: core.protectNTFS on everywhere, core.protectHFS on macOS. Returns the reason
// git refuses it, or null. Every name parseTree accepts passes on Linux and macOS (fsck --strict refuses a superset:
// test/space/fsck-tree.test.js checks it against `git read-tree` with both protections on); this is the check at the
// point of writing all the same. On Windows a backslash is a separator (verify_path refuses it outright) and
// compat/mingw.c is_valid_win32_path refuses the characters `: < > " | ? *` and controls, a component ending in a space or
// a period, and the reserved device names (AUX, CON, NUL, PRN, COM1-9, LPT0-9, CONIN$, CONOUT$, whatever follows them
// after spaces, a period or a colon).
export function checkoutPathRefusal(path: string, mode: string, platform: string): string | null {
  const comps = path.split('/');
  for (const [k, c] of comps.entries()) {
    const b: Uint8Array = encodeBytes(c, 'checkout path');
    if (c === '' || c === '.' || c === '..') return 'an empty, `.` or `..` component';
    if (isDotGitName(b)) return 'a spelling of .git';
    // git compares ASCII case-insensitively; /iu would also fold U+017F to s (and U+212A to k)
    // oxlint-disable-next-line eslint/require-unicode-regexp -- see above
    if (mode === MODE_LINK && (/^\.gitmodules$/i.test(c) || (platform === 'darwin' && isHfsDot(b, 'gitmodules')) || (k === comps.length - 1 && isDotFileName(b, 'gitmodules')))) return 'a symlink at a spelling of .gitmodules';
  }
  if (platform !== 'win32') return null;
  if (path.includes('\\')) return 'a backslash (a separator on Windows)';
  for (const c of comps) {
    // oxlint-disable-next-line no-control-regex -- is_valid_win32_path refuses control characters; matching them is the point
    if (/[:<>"|?*\u0001-\u001F]/u.test(c)) return 'a character Windows refuses in a name';
    if (/[ .]$/u.test(c)) return 'a name ending in a space or a period';
    // oxlint-disable-next-line eslint/require-unicode-regexp -- ASCII case folding, as git's strncasecmp; /iu folds U+017F and U+212A too
    if (/^(aux|prn|nul|con|com[1-9]|lpt[0-9]|conin\$|conout\$) *(?:[.:]|$)/i.test(c)) return 'a reserved Windows device name';
  }
  return null;
}

export function validatePath(path: unknown, limits: Partial<Limits> | null | undefined): string[] {
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
  encodeBytes(path, 'path');
  return comps;
}

export function validateMessage(message: unknown): string {
  if (typeof message !== 'string') throw bad('message', 'must be a string');
  if (message.includes('\0')) throw bad('message', 'NUL not allowed');
  encodeBytes(message, 'message');
  return message;
}

