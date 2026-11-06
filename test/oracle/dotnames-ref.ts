// The tree-entry name checks ply had before #207 made them allocation-free (src/validate.ts at c91c9cf, isHfsDot,
// isNtfsDotGit, isNtfsDot, isDotGitName, isDotFileName, verbatim but for the imports): kept in test/ as the oracle.
// test/dotnames.test.js and test/fuzz/dotnames.mjs hold src/validate.ts to it byte string by byte string, so a change
// to the src side cannot pass by changing both sides of the comparison. It is itself held to git by
// test/space/fsck-tree.test.js (as it was on c91c9cf).
import { te } from '../../src/bytes.js';
import { atOr } from '../../src/absent.js';

const at = (b: Uint8Array, i: number): number => atOr(b, i, 0);
const lower = (c: number): number => (c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
const ascii = (s: string): Uint8Array => te.encode(s);

type Utf8Char = readonly [codePoint: number, length: number];
const cont = (c: number): boolean => (c & 0xc0) === 0x80;
export function utf8AtRef(b: Uint8Array, i: number): Utf8Char | null {
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
const HFS_IGNORED = new Set([0x20_0c, 0x20_0d, 0x20_0e, 0x20_0f, 0x20_2a, 0x20_2b, 0x20_2c, 0x20_2d, 0x20_2e, 0x20_6a, 0x20_6b, 0x20_6c, 0x20_6d, 0x20_6e, 0x20_6f, 0xfe_ff]);
export function isHfsDotRef(b: Uint8Array, needle: string): boolean {
  let i = 0;
  const next = (): number => {
    for (;;) {
      if (i < 0) return 0;
      const r = utf8AtRef(b, i);
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
export function isNtfsDotGitRef(b: Uint8Array, o: number): boolean {
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
export function isNtfsDotRef(b: Uint8Array, o: number, name: string, prefix: string): boolean {
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
export const DOTFILES: Readonly<Record<DotFile, readonly [name: string, prefix: string]>> = {
  gitmodules: ['gitmodules', 'gi7eba'], gitignore: ['gitignore', 'gi250a'], gitattributes: ['gitattributes', 'gi7d29'], mailmap: ['mailmap', 'maba30'],
};
const backslashTails = (b: Uint8Array): number[] => { const out: number[] = []; for (let i = 0; i < b.length; i++) if (b[i] === 0x5c) out.push(i + 1); return out; };

export const isDotGitNameRef = (b: Uint8Array): boolean => isHfsDotRef(b, 'git') || isNtfsDotGitRef(b, 0) || backslashTails(b).some(o => isNtfsDotGitRef(b, o));
export const isDotFileNameRef = (b: Uint8Array, file: DotFile): boolean => {
  const [name, prefix] = DOTFILES[file];
  return isHfsDotRef(b, name) || isNtfsDotRef(b, 0, name, prefix) || (file === 'gitmodules' && backslashTails(b).some(o => isNtfsDotRef(b, o, name, prefix)));
};
