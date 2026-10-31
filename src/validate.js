// Caller-supplied strings that reach a git object header or a protocol command line are validated here.
// Anything that could terminate a header line or a pkt-line field is rejected rather than escaped: git has no escaping.
import { fail } from './errors.js';
import { requireLimit } from './limits.js';
import { IDENT_TZ_DIGITS, IDENT_TZ_HOUR_MIN, IDENT_TZ_HOUR_MAX, IDENT_TZ_MINUTE_MAX } from './format.js';
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

// git fsck hasDotgit: ".git" case-insensitively, after NTFS normalization (trailing dots/spaces stripped, 8.3 short
// names git~N) and HFS+ normalization (ignorable code points removed). Verified against index-pack --strict.
const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;
export function isDotGit(c) {
  const ntfs = c.replace(/[. ]+$/, '').toLowerCase();
  if (ntfs === '.git' || /^git~[1-9]$/.test(ntfs)) return true;
  const hfs = c.replace(HFS_IGNORABLE, '').toLowerCase();
  return hfs === '.git';
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

