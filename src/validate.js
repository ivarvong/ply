// Caller-supplied strings that reach a git object header or a protocol command line are validated here.
// Anything that could terminate a header line or a pkt-line field is rejected rather than escaped: git has no escaping.
import { fail } from './errors.js';
const bad = (what, why) => fail('bad_request', `invalid ${what}: ${why}`, { what });

export function validateIdent({ name, email } = {}) {
  // Exactly fsck.c fsck_ident(): name is everything before " <" and may not contain '<', '>', NUL or newline;
  // email is between '<' and '>' and may not contain '<', '>', NUL or newline. Anything else — punctuation,
  // leading/trailing spaces, tabs, empty name or email — is a valid object. (Verified against git fsck --strict.)
  for (const [k, v] of [['author name', name], ['author email', email]]) {
    if (typeof v !== 'string') throw bad(k, 'must be a string');
    if (/[\0\n<>]/.test(v)) throw bad(k, 'must not contain NUL, newline, < or >');
  }
  return { name, email };
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
  const comps = path.split('/');
  if (comps.length > limits.maxPathDepth) throw bad('path', `depth ${comps.length} exceeds ${limits.maxPathDepth}`);
  for (const c of comps) {
    if (c === '' ) throw bad('path', 'empty component (leading, trailing or doubled slash)');
    if (c === '.' || c === '..' || isDotGit(c)) throw bad('path', `component ${JSON.stringify(c)} not allowed (git fsck hasDotgit)`);
    if (c.includes('\0')) throw bad('path', 'NUL in component');
    if (c.length > limits.maxPathComponent) throw bad('path', 'component too long');
  }
  return comps;
}

export function validateMessage(message) {
  if (typeof message !== 'string') throw bad('message', 'must be a string');
  if (message.includes('\0')) throw bad('message', 'NUL not allowed');
  return message;
}

