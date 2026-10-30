// Case generators over the combinatorial product space. Each knob has named classes so the
// steering loop can ask for a specific region of the space by name.
import { indexOfBytes } from '../../src/bytes.js';

const te = new TextEncoder();
export const KNOBS = {
  blob: ['empty', 'tiny', 'text', 'random', 'repetitive', 'boundary', 'big', 'binaryish'],
  pos: ['start', 'end', 'middle', 'chunk16k', 'chunk32k', 'chunk64k', 'random'],
  find: ['one', 'short', 'medium', 'over127', 'long'],
  replace: ['empty', 'same', 'shorter', 'longer', 'over127', 'huge', 'identical'],
  compression: ['0', '1', '6', '9', '-1'],
  depth: ['1', '2', '3', '4', '6', '10'],
  outcome: ['ok', 'zero_matches', 'two_matches', 'missing_path', 'not_a_file', 'cas_conflict'],
  siblings: ['none', 'few', 'many', 'sortedge'],
  history: ['1', '2', '5'],
  mode: ['100644', '100755'],
  server: ['loose', 'packed', 'bitmap', 'midx-bitmap', 'mixed'],
};

const VOCAB = 'the quick brown fox jumps over lazy dog lorem ipsum dolor sit amet git pack delta inflate huffman'.split(' ');
const SORT_EDGE_NAMES = ['a', 'a-b', 'a.b', 'a0', 'a_b', 'ab', 'A', 'a~', 'z', 'é', 'a b', 'a--', 'a.', '-a', '.hidden', 'ä', '한글', '🚀'];
const BOUNDARY_SIZES = [127, 128, 255, 256, 4095, 4096, 16383, 16384, 16385, 32767, 32768, 32769, 65535, 65536, 65537, 131072];

export function genBlob(rng, cls) {
  switch (cls) {
    case 'empty': return new Uint8Array(0);
    case 'tiny': return te.encode(Array.from({ length: rng.int(1, 12) }, () => rng.pick(VOCAB)).join(' '));
    case 'text': return genText(rng, rng.int(100, 20000));
    case 'random': return rng.bytes(rng.int(1, 40000));
    case 'repetitive': { const pat = rng.pick([te.encode('ab'), rng.bytes(rng.int(1, 300)), te.encode('line of text\n')]); const n = rng.int(1000, 120000); const out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = pat[i % pat.length]; return out; }
    case 'boundary': { const n = rng.pick(BOUNDARY_SIZES); return rng.bool(0.6) ? genText(rng, n) : rng.bytes(n); }
    case 'big': return genText(rng, rng.int(200000, 1500000));
    case 'binaryish': { const n = rng.int(500, 60000); const out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = rng.bool(0.7) ? 0 : rng.u32() & 0xff; return out; }
    default: throw new Error(`blob class ${cls}`);
  }
}
function genText(rng, n) {
  const parts = []; let len = 0;
  while (len < n) { const w = rng.pick(VOCAB) + (rng.bool(0.15) ? '\n' : ' '); parts.push(w); len += w.length; }
  return te.encode(parts.join('')).subarray(0, n);
}

export function genFind(rng, cls) {
  const n = { one: 1, short: rng.int(2, 16), medium: rng.int(17, 100), over127: rng.int(128, 200), long: rng.int(300, 2000) }[cls];
  // bytes outside the text vocab so uniqueness is likely; some fully random
  return rng.bool(0.5) ? Uint8Array.from({ length: n }, () => 0xc0 + (rng.u32() % 50)) : rng.bytes(n);
}
export function genReplace(rng, cls, find) {
  switch (cls) {
    case 'empty': return new Uint8Array(0);
    case 'same': return rng.bytes(find.length);
    case 'shorter': return rng.bytes(rng.int(0, Math.max(0, find.length - 1)));
    case 'longer': return rng.bytes(find.length + rng.int(1, 50));
    case 'over127': return rng.bytes(rng.int(128, 400));
    case 'huge': return rng.bytes(rng.int(1000, 70000));
    case 'identical': return find.slice();
  }
}

// Place find into blob at a position class; returns new blob + offset (exactly one occurrence guaranteed).
export function placeFind(rng, blob, find, posCls) {
  const L = blob.length;
  let off;
  switch (posCls) {
    case 'start': off = 0; break;
    case 'end': off = L; break;
    case 'middle': off = L >> 1; break;
    case 'chunk16k': off = chunkStraddle(rng, L, 16384, find.length); break;
    case 'chunk32k': off = chunkStraddle(rng, L, 32768, find.length); break;
    case 'chunk64k': off = chunkStraddle(rng, L, 65536, find.length); break;
    default: off = rng.int(0, L);
  }
  const out = new Uint8Array(L + find.length);
  out.set(blob.subarray(0, off)); out.set(find, off); out.set(blob.subarray(off), off + find.length);
  return { blob: out, off };
}
function chunkStraddle(rng, L, boundary, n) {
  const k = Math.max(1, Math.floor(L / boundary));
  const b = boundary * rng.int(1, k);
  return Math.max(0, Math.min(L, b - rng.int(1, Math.max(1, n - 1))));
}
export const countOccurrences = (hay, needle) => { let c = 0, i = 0; while ((i = indexOfBytes(hay, needle, i)) >= 0) { c++; i += Math.max(1, needle.length); } return c; };

export function genPath(rng, depthCls, siblingsCls) {
  const depth = parseInt(depthCls, 10);
  const name = () => (siblingsCls === 'sortedge' ? rng.pick(SORT_EDGE_NAMES) : rng.pick(['src', 'lib', 'pkg', 'a', 'b', 'deep', 'x-y', 'n.m']) + (rng.bool(0.5) ? rng.int(0, 9) : ''));
  const dirs = Array.from({ length: depth - 1 }, name);
  return [...dirs, (siblingsCls === 'sortedge' ? rng.pick(SORT_EDGE_NAMES) : 'f' + rng.int(0, 999)) + rng.pick(['.txt', '.js', '', '.bin'])].join('/');
}

export function genSiblings(rng, cls, path) {
  const n = { none: 0, few: rng.int(1, 4), many: rng.int(10, 40), sortedge: rng.int(6, 14) }[cls];
  const files = {};
  const comps = path.split('/');
  for (let i = 0; i < n; i++) {
    const depth = rng.int(0, comps.length - 1);
    const base = comps.slice(0, depth);
    let nm = cls === 'sortedge' ? rng.pick(SORT_EDGE_NAMES) : 's' + rng.int(0, 9999);
    const asDir = rng.bool(0.3);
    const p = [...base, nm, ...(asDir ? ['inner' + rng.int(0, 9)] : [])].join('/');
    const clash = (x, y) => x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
    if (clash(p, path) || Object.keys(files).some(q => clash(p, q))) continue;
    const kind = rng.weighted([['file', 8], ['exec', 1], ['symlink', 1]]);
    files[p] = kind === 'symlink' ? { symlink: rng.pick(['../x', 'f0.txt', '/dev/null']) } : { mode: kind === 'exec' ? '100755' : '100644', data: genBlob(rng, rng.pick(['tiny', 'text', 'random', 'empty'])) };
  }
  return files;
}

// A complete case spec. hints: partial {knob: class} to steer.
export function genCase(seedRng, hints = {}) {
  const rng = seedRng;
  const pick = k => hints[k] ?? rng.pick(KNOBS[k]);
  const c = { blob: pick('blob'), pos: pick('pos'), find: pick('find'), replace: pick('replace'), compression: pick('compression'), depth: pick('depth'), outcome: pick('outcome'), siblings: pick('siblings'), history: pick('history'), mode: pick('mode'), server: pick('server') };
  const path = genPath(rng, c.depth, c.siblings);
  let find = genFind(rng, c.find);
  const replace = genReplace(rng, c.replace, find);
  let blob = genBlob(rng, c.blob);
  let off = -1;
  // ensure baseline has zero occurrences, then place per outcome
  for (let tries = 0; countOccurrences(blob, find) > 0 && tries < 20; tries++) find = genFind(rng, c.find);
  if (countOccurrences(blob, find) > 0) blob = genBlob(rng, 'random');
  if (c.outcome !== 'zero_matches') { ({ blob, off } = placeFind(rng, blob, find, c.pos)); }
  if (c.outcome === 'two_matches') { ({ blob } = placeFind(rng, blob, find, 'random')); }
  const occurrences = countOccurrences(blob, find);
  if (occurrences === 1) off = indexOfBytes(blob, find); // overlapping placements can collapse; truth is what the scanner will see
  const files = { ...genSiblings(rng, c.siblings, path) };
  let editPath = path;
  if (c.outcome === 'missing_path') editPath = path + '.missing';
  if (c.outcome === 'not_a_file') { const comps = path.split('/'); editPath = comps.length > 1 ? comps.slice(0, -1).join('/') : path; if (comps.length === 1) files[path + '/inner'] = { mode: '100644', data: new Uint8Array(0) }; }
  if (!(c.outcome === 'not_a_file' && path.split('/').length === 1)) files[path] = { mode: c.mode, data: blob };
  const same = find.length === replace.length && find.every((b, i) => b === replace[i]);
  const matchOutcome = occurrences !== 1 ? 'match_count' : same ? 'noop' : 'ok';
  // a single injected race is absorbed by editFile's one internal retry: the caller sees 'ok' on attempt 1 (run.mjs checks the
  // attempt-0 root failed with cas_conflict and the retry's parent is the racer's commit)
  const expected = ['ok', 'zero_matches', 'two_matches'].includes(c.outcome) ? matchOutcome : c.outcome === 'cas_conflict' ? matchOutcome : 'not_found';
  return { knobs: c, path, editPath, find, replace, blob, off, occurrences, files, expected, compression: parseInt(c.compression, 10), history: parseInt(c.history, 10) };
}

// ---- hostile trees (issue #34) ----
// Raw tree bytes for `git fsck --strict` to judge beside parseTree. The pools hold every fsck tree rule's trigger:
// duplicate names across modes (adjacent, and apart as file `d` / `d.x` / dir `d`), case-only twins, unsorted order,
// `.`/`..`/empty/`.git` spellings (NTFS, HFS+, after a backslash, stray bytes), zero-padded, bad and over-16-bit modes,
// a null oid, dotfile symlinks under their short names, and a name past git's 4096-byte PATH_MAX. Names are bytes so
// invalid UTF-8 can be placed. Object ids come from `oids` so a type matches its mode (fsck follows directory entries;
// a blob behind a `40000` would be a broken link, which is a connectivity fault and not what parseTree judges).
const RAW_NAME = s => (typeof s === 'string' ? te.encode(s) : Uint8Array.from(s));
const DOT = 0x2e, G = 0x67, I = 0x69, T = 0x74, BAD_BYTE = 0xff;
export const HOSTILE_TREE_NAMES = {
  plain: ['a', 'b', 'd', 'd.x', 'd-', 'd0', 'A', 'D', 'a b', 'é', '.a', 'x', 'README', 'readme', '\ufeffREADME', 'a\\b'],
  dotgit: ['.git', '.GIT', '.Git.', '.git ', '.git. . .', 'git~1', 'GIT~1', 'git~1.', '.git:x', '.git:', 'git~1:s', '.git\\x', 'x\\.git', 'a\\b\\.GIT.', 'x\\git~1',
    '.gi‌t', '﻿.git', '.g‌i‍t', '.git‮', '.GIT⁪', '.git‏‪⁯﻿',
    [DOT, G, I, T, BAD_BYTE], [DOT, G, I, T, BAD_BYTE, 0x78], [DOT, 0xe2, 0x80, 0x8c, G, I, T, 0xc3], [DOT, G, I, T, 0xef, 0xbf], [DOT, G, I, T, 0xed, 0xa0, 0x80], [DOT, G, I, T, 0xc0, 0xae]],
  nearDotgit: ['git~2', 'GIT~9', '.gitx', '.git.x', '.git x', '.gitt', 'git~', 'git~1x', 'x.git', '.git‌x', '.giit', '‌.gitx', '.git�', '.git�.', '�.git',
    '.git﻿.', '.git.﻿', '.git ‌', '.git​', '.git⁠', '.gitmodules',
    [DOT, G, I, T, 0xef, 0xbf, 0xbd], [DOT, G, I, T, 0xef, 0xbf, 0xbd, 0x78], [DOT, G, I, T, 0xef, 0xbf, 0xbd, BAD_BYTE], [DOT, G, I, T, 0xc3, 0xa9], [BAD_BYTE, DOT, G, I, T], [DOT, G, BAD_BYTE, I, T]],
  dotfile: ['.gitmodules', '.GitModules', '.gitmodules.', '.gitmodules . ', '.gitmodules:x', '.gitmodules:x:', 'gitmod~1', 'GITMOD~4', 'gitmod~1.', 'gi7eba~1', 'GI7EBA~9', 'gi7eb~12',
    'gi7e~123', 'gi7~1234', 'gi~12345', 'g~123456', '~1234567', 'gi7eba~1 . :x', 'x\\.gitmodules', 'a\\b\\gitmod~2', '.gitmodule‌s', '﻿.GITMODULES',
    '.gitattributes', 'gitatt~1', 'gi7d29~1', '.gitattributes:', '.gitignore', 'gitign~1', 'gi250a~1', '.GITIGNORE..', '.mailmap', 'mailma~1', 'maba30~1', '.mailmap ',
    [...te.encode('.gitmodules'), BAD_BYTE]],
  nearDotfile: ['.gitmodulesx', '.gitmodulesx:', 'gitmod~5', 'gitmod~0', 'gi7eba~0', 'gi7eba~12', 'gi7ebx~1', 'gi7eba1~', 'gi7eba~1x', '~123456', '~12345678',
    'x\\.gitattributes', 'x\\.gitignore', 'x\\.mailmap', '.gitmodule', '.gitattribute', '.mailma', 'mailmap', 'gitmodules', '.gitmodules\\x', 'x\\.gitmodule‌s',
    [...te.encode('.gitmodules'), 0xef, 0xbf, 0xbd, BAD_BYTE]],
  structural: ['.', '..', '', 'a/b', '/'],
  large: ['a'.repeat(4096), 'a'.repeat(4097), 'é'.repeat(2048), 'é'.repeat(2049)],
};
export const HOSTILE_TREE_MODES = {
  blob: ['100644', '100755', '120000'],
  tree: ['40000'],
  commit: ['160000'],
  bad: ['100664', '100600', '777', '4000', '1', '7', '100645', '100754', '120001', '40001', '160001', '140000', '170000', '177777'],
  // over 16 bits: fsck's `unsigned short mode` keeps the low bits, which are a legal mode; ply refuses these
  overflow: ['240000', '1100644', '300755', '320000', '360000', '1000000040000'],
  padded: ['0', '040000', '0100644', '00'],
  malformed: ['', '8', '19', '10064g', 'x'],
};
const treeKey = (mode, name) => (mode === '40000' ? [...name, 0x2f] : [...name]);
const cmpKeys = (a, b) => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };

// One hostile tree: { bytes, entries, note }. `oids` = { blob: [hex...], tree: hex, commit: hex }.
export function genHostileTree(rng, oids) {
  const shape = rng.weighted([['clean', 3], ['dup', 3], ['dup-apart', 2], ['twins', 1], ['unsorted', 2], ['names', 4], ['modes', 3], ['nulloid', 1], ['dotfile', 3], ['mixed', 2]]);
  const nameFrom = pool => RAW_NAME(rng.pick(HOSTILE_TREE_NAMES[pool]));
  const modeFrom = pool => rng.pick(HOSTILE_TREE_MODES[pool]);
  const oidFor = mode => (mode === '40000' ? oids.tree : mode === '160000' ? oids.commit : rng.pick(oids.blob));
  const entry = (mode, name, oid = oidFor(mode)) => ({ mode, name, oid });
  const count = rng.int(0, 4);
  const entries = [];
  const plainEntry = () => entry(modeFrom(rng.weighted([['blob', 5], ['tree', 2], ['commit', 1]])), nameFrom('plain'));
  for (let i = 0; i < count; i++) entries.push(plainEntry());
  let sort = true;
  switch (shape) {
    case 'clean': break;
    case 'dup': { const e = entries.length ? rng.pick(entries) : plainEntry(); if (!entries.length) entries.push(e); entries.push(entry(modeFrom(rng.pick(['blob', 'tree', 'blob'])), e.name)); break; }
    case 'dup-apart': entries.push(entry('100644', RAW_NAME('d')), entry(rng.pick(['100644', '120000']), RAW_NAME(rng.pick(['d.x', 'd-', 'd.', 'd '])), undefined), entry('40000', RAW_NAME('d'))); break;
    case 'twins': entries.push(entry(modeFrom('blob'), RAW_NAME('README')), entry(modeFrom(rng.pick(['blob', 'tree'])), RAW_NAME(rng.pick(['readme', 'Readme', 'README'])))); break;
    case 'unsorted': sort = false; entries.push(plainEntry(), plainEntry()); break;
    case 'names': entries.push(entry(modeFrom(rng.weighted([['blob', 4], ['tree', 1]])), nameFrom(rng.weighted([['dotgit', 3], ['nearDotgit', 3], ['structural', 2], ['large', 1], ['dotfile', 1]])))); break;
    case 'modes': entries.push(entry(modeFrom(rng.weighted([['bad', 3], ['overflow', 2], ['padded', 2], ['malformed', 1]])), nameFrom('plain'), rng.pick(oids.blob))); break;
    case 'nulloid': entries.push(entry(modeFrom(rng.pick(['blob', 'tree', 'commit'])), nameFrom('plain'), '0'.repeat(40))); break;
    case 'dotfile': entries.push(entry(rng.weighted([['120000', 5], ['100644', 2], ['40000', 1]]), nameFrom(rng.pick(['dotfile', 'nearDotfile'])))); break;
    case 'mixed': for (let i = rng.int(1, 3); i > 0; i--) entries.push(entry(modeFrom(rng.pick(Object.keys(HOSTILE_TREE_MODES))), nameFrom(rng.pick(Object.keys(HOSTILE_TREE_NAMES))), rng.bool(0.1) ? '0'.repeat(40) : undefined)); break;
  }
  if (sort) entries.sort((a, b) => cmpKeys(treeKey(a.mode, a.name), treeKey(b.mode, b.name)));
  else if (entries.length > 1) { const i = rng.int(0, entries.length - 2); [entries[i], entries[i + 1]] = [entries[i + 1], entries[i]]; }
  const parts = [];
  for (const e of entries) {
    parts.push(te.encode(`${e.mode} `), e.name, Uint8Array.of(0), Uint8Array.from(e.oid.match(/../g).map(h => parseInt(h, 16))));
  }
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.length; }
  return { bytes, entries, note: `${shape}: ${entries.map(e => `${e.mode} ${JSON.stringify(new TextDecoder().decode(e.name)).slice(0, 40)}`).join(', ')}` };
}
