// Names for the differential test of the tree-entry name checks (#207): src/validate.ts against the version before it
// (test/oracle/dotnames-ref.ts). Shared by test/dotnames.test.js (sizes a mutation run can afford) and
// test/fuzz/dotnames.mjs (the large campaign). Every generator yields Uint8Arrays; the judge compares every predicate.
import { isDotGitName, isDotFileName, checkoutPathRefusal } from '../src/validate.js';
import { isDotGitNameRef, isDotFileNameRef, isHfsDotRef } from './oracle/dotnames-ref.ts';

export const FILES = ['gitmodules', 'gitignore', 'gitattributes', 'mailmap'];
const enc = s => new TextEncoder().encode(s);

// The bytes every check branches on: the end (NUL), the separators and NTFS tail bytes, `~` and the digits around the
// short-name ranges, the letters of every needle in both cases (and a neighbour of each range), UTF-8 leads of every
// length, continuation bytes at the range edges, the ignorables' bytes (E2 80 8C, E2 81 AF, EF BB BF), and bytes no
// UTF-8 has.
export const ALPHABET = Uint8Array.from(new Set([
  0x00, 0x01, 0x20, 0x2e, 0x2f, 0x3a, 0x5c, 0x7e, 0x2d,
  0x30, 0x31, 0x32, 0x34, 0x35, 0x37, 0x39, 0x3a,
  ...enc('gitmodulesbaignorttrmlp7GITMODULESBAIGNORTTRMLP'), 0x40, 0x5b, 0x60, 0x7b, 0x41, 0x5a,
  0x7f, 0x80, 0x81, 0x8c, 0x8f, 0x90, 0x9f, 0xa0, 0xaa, 0xaf, 0xbb, 0xbe, 0xbf, 0xc0, 0xc1, 0xc2, 0xc3, 0xdf,
  0xe0, 0xe2, 0xed, 0xee, 0xef, 0xf0, 0xf4, 0xf5, 0xf8, 0xfe, 0xff,
]));

// The spellings the checks look for, and near misses: every `.git` form, every dotfile's dot name, 6-character short
// names ~1..~4 (and ~0, ~5), fallback short names (`<prefix>~N…`, `~1234567`), in both cases.
const IGNORABLES = [[0xe2, 0x80, 0x8c], [0xe2, 0x80, 0x8d], [0xe2, 0x80, 0x8e], [0xe2, 0x80, 0x8f], [0xe2, 0x80, 0xaa], [0xe2, 0x80, 0xae], [0xe2, 0x80, 0xaf], [0xe2, 0x81, 0xaa], [0xe2, 0x81, 0xaf], [0xe2, 0x81, 0xb0], [0xe2, 0x80, 0x8b], [0xef, 0xbb, 0xbf], [0xef, 0xbb, 0xbe], [0xef, 0xbf, 0xbe], [0xed, 0xa0, 0x80], [0xc0, 0xae], [0xe0, 0x80, 0xae], [0xf0, 0x80, 0x80, 0xae]];
export const SPELLINGS = [
  '.git', 'git~1', 'git~2', 'GIT~1', '.GIT', '.gIt', 'gIT~1', 'gi~1', '.gi', 'git', '.g', '.', '~1', '~',
  '.gitmodules', 'gitmod~1', 'gitmod~4', 'gitmod~5', 'gitmod~0', 'GITMOD~2', 'gi7eba~1', 'gi7eba~9', 'gi7eb~12', 'gi7e~123', 'gi~12345', 'g~123456', '~1234567', '~0234567', '~123456a', 'gi7eba~10',
  '.gitignore', 'gitign~1', 'gi250a~1', 'gi250~12', '.gitattributes', 'gitatt~1', 'gi7d29~1', 'gi7d2~12', '.mailmap', 'mailma~1', 'maba30~1', 'maba3~12', 'MAILMA~3',
  '.gitmodulesx', '.gitmodule', 'gitmodules', '.gitmodules~1', 'gitmodules~1',
];
export const TAILS = ['', '.', ' ', '. .', ' . ', ':', ':x', ':$DATA', '/', '/x', '\\', '\\x', 'x', '.x', ' x', '\0', '\0x', '~', '1'];
export const HEADS = ['', 'a\\', '\\', 'a\\b\\', '\\\\', '.git\\', 'x', ' ', '‌'];

// Every predicate the two sides answer, as one string: isDotGitName and isDotFileName × 4.
export function verdicts(b, side) {
  if (side === 'ref') return `${+isDotGitNameRef(b)}${FILES.map(f => +isDotFileNameRef(b, f)).join('')}`;
  return `${+isDotGitName(b)}${FILES.map(f => +isDotFileName(b, f)).join('')}`;
}
// isHfsDot(b, 'gitmodules') as checkoutPathRefusal asks it: a symlink on macOS at `<name>/x` (a component before the
// last, where the NTFS spellings are not asked) is refused for the name exactly when it is .gitmodules (ASCII case
// folded) or isHfsDot says so. Asked only of a name that can be such a component: no `/` or NUL, well-formed UTF-8 (the
// path is a string), not `.`/`..`, no .git spelling (refused for that first). Null for any other name.
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });
export function hfsGitmodules(b) {
  if (b.length === 0 || b.includes(0x2f) || b.includes(0) || isDotGitNameRef(b)) return null;
  const s = utf8.decode(b);
  const back = enc(s);
  if (back.length !== b.length || !back.every((x, i) => x === b[i])) return null;
  if (s === '.' || s === '..' || /^\.gitmodules$/i.test(s)) return null;
  const r = checkoutPathRefusal(`${s}/x`, '120000', 'darwin');
  if (!r.ok) return null;
  return { got: r.value.tag === 'some', want: isHfsDotRef(b, 'gitmodules') };
}

// ---- generators ----
export function* exhaustive(alphabet, maxLen) {
  yield new Uint8Array(0);
  const a = alphabet.length;
  for (let len = 1; len <= maxLen; len++) {
    const idx = Array.from({ length: len }, () => 0);
    for (;;) {
      const b = new Uint8Array(len);
      for (let k = 0; k < len; k++) b[k] = alphabet[idx[k]];
      yield b;
      let k = len - 1;
      while (k >= 0 && ++idx[k] === a) idx[k--] = 0;
      if (k < 0) break;
    }
  }
}
export const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i);

// Each spelling × head × tail; then of each: every truncation, every one-byte substitution by the alphabet, every
// ignorable inserted at every position, each byte deleted, and each byte doubled.
export function* targeted(heads = HEADS, tails = TAILS, alphabet = ALPHABET) {
  const bases = [];
  for (const s of SPELLINGS) for (const h of heads) for (const t of tails) bases.push(enc(h + s + t));
  for (const b of bases) {
    yield b;
    for (let n = 0; n < b.length; n++) yield b.subarray(0, n);
    for (let i = 0; i < b.length; i++) {
      for (const x of alphabet) { if (x === b[i]) continue; const c = b.slice(); c[i] = x; yield c; }
      yield Uint8Array.of(...b.subarray(0, i), ...b.subarray(i + 1));
      yield Uint8Array.of(...b.subarray(0, i + 1), ...b.subarray(i));
    }
    for (let i = 0; i <= b.length; i++) for (const ig of IGNORABLES) yield Uint8Array.of(...b.subarray(0, i), ...ig, ...b.subarray(i));
  }
}

// xorshift32, seeded: the same names for the same seed
export function rng(seed) {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
  return { int: n => next() % n, pick: xs => xs[next() % xs.length] };
}
// A random name from fragments: spellings (either case per letter), ignorables, tails, backslashes and random bytes
export function randomName(r) {
  const parts = [];
  const k = 1 + r.int(5);
  for (let j = 0; j < k; j++) {
    switch (r.int(6)) {
      case 0: { const s = r.pick(SPELLINGS); parts.push(...[...enc(s)].map(c => (c >= 0x61 && c <= 0x7a && r.int(3) === 0 ? c - 0x20 : c))); break; }
      case 1: parts.push(...r.pick(IGNORABLES)); break;
      case 2: parts.push(...enc(r.pick(TAILS))); break;
      case 3: parts.push(0x5c); break;
      case 4: parts.push(r.pick(ALPHABET)); break;
      default: parts.push(r.int(256)); break;
    }
  }
  return Uint8Array.from(parts);
}

// Judge names: the first disagreement (a repro), or null; counts what was checked and how many each side accepted.
export function judge(names, stats = { n: 0, hits: 0 }) {
  for (const b of names) {
    const want = verdicts(b, 'ref');
    const got = verdicts(b, 'src');
    stats.n++;
    if (want !== '00000') stats.hits++;
    if (want !== got) return { bytes: [...b].map(x => x.toString(16).padStart(2, '0')).join(' '), want, got };
  }
  return null;
}
