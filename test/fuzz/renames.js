// A seeded generator of three-way cases around renames: base / ours / theirs as { path: content }. ply does not detect
// renames, so every shape here is one where git's rename detection may or may not change the merge; the callers
// (test/merge-renames.test.js, test/fuzz/git-semantic.mjs) hold ply to `git merge-tree --write-tree`.
//
// Operations, applied to a side or to both ("shared": the changed subtree is then the same tree on both sides):
//   move       a file to another directory, same bytes
//   move+edit  the same, a few lines changed (similar enough for git to pair)
//   delete     a file
//   edit       a file in place
//   add        an unrelated new file
//   file→dir   a file replaced by a directory of its name holding its bytes (or unrelated bytes)
//   dir→file   a directory replaced by a file of its name holding one of its files' bytes (or unrelated bytes)
//   dir-rename every file of a directory moved to a new directory
// No node: imports: the generator is pure.

// mulberry32
const rng = seed => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

const text = (tag, n = 24) => `${Array.from({ length: n }, (_, i) => `${tag} line ${i}`).join('\n')}\n`;
// a few lines changed: git pairs it with the original (well over 50% similar)
const edited = (s, k) => s.split('\n').map((l, i) => (i % 6 === k % 6 && l !== '' ? `${l} edited${k}` : l)).join('\n');
const DIRS = ['', 'a/', 'b/', 'a/s/', 'c/'];

// a tree cannot hold a file and a directory of one name
const valid = files => { const paths = Object.keys(files); const dirs = new Set(); for (const p of paths) { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); } return paths.every(p => !dirs.has(p)); };

export function generateCase(seed, index) {
  const r = rng(seed * 1_000_003 + index);
  const int = n => Math.floor(r() * n);
  const pick = l => l[int(l.length)];
  let fresh = 0;
  const base = {};
  const count = 3 + int(4);
  for (let i = 0; i < count; i++) base[`${pick(DIRS)}f${i}`] = text(`base${i}`);
  base.keep = 'keep\n';
  const ops = [];
  // one operation on `files` (a copy is returned; an operation that would make an invalid tree is skipped)
  const apply = (files, who) => {
    const paths = Object.keys(files).filter(p => p !== 'keep');
    if (paths.length === 0) return files;
    const p = pick(paths); const out = { ...files }; const kind = int(9); const id = fresh++;
    const leaf = p.slice(p.lastIndexOf('/') + 1); const dir = p.slice(0, p.length - leaf.length);
    let what = '';
    if (kind === 0) { const to = `${pick(DIRS.filter(d => d !== dir))}${leaf}`; delete out[p]; out[to] = files[p]; what = `move ${p}→${to}`; }
    else if (kind === 1) { const to = `${pick(DIRS.filter(d => d !== dir))}m${id}`; delete out[p]; out[to] = edited(files[p], id); what = `move+edit ${p}→${to}`; }
    else if (kind === 2) { delete out[p]; what = `delete ${p}`; }
    else if (kind === 3) { out[p] = edited(files[p], id); what = `edit ${p}`; }
    else if (kind === 4) { const to = `${pick(DIRS)}n${id}`; out[to] = text(`new${id}`); what = `add ${to}`; }
    else if (kind === 5) { delete out[p]; out[`${p}/x${int(2)}`] = int(4) === 0 ? text(`new${id}`) : files[p]; what = `file→dir ${p}`; }
    else if (kind === 6 && dir !== '') { const d = dir.slice(0, -1); for (const q of Object.keys(out)) if (q.startsWith(dir)) delete out[q]; out[d] = int(4) === 0 ? text(`new${id}`) : files[p]; what = `dir→file ${d}`; }
    else if (kind === 7 && dir !== '') { const to = `r${int(2)}/`; for (const q of Object.keys(files)) if (q.startsWith(dir)) { delete out[q]; out[to + q.slice(dir.length)] = files[q]; } what = `dir-rename ${dir}→${to}`; }
    else { delete out[p]; what = `delete ${p}`; }
    if (!valid(out)) return files;
    ops.push(`${who}: ${what}`);
    return out;
  };
  // shared operations first: both sides hold the same change, so the subtree is the same tree on both sides
  let shared = base;
  for (let n = int(3); n > 0; n--) shared = apply(shared, 'both');
  let ours = shared; let theirs = shared;
  for (let n = int(3); n > 0; n--) ours = apply(ours, 'ours');
  for (let n = 1 + int(2); n > 0; n--) theirs = apply(theirs, 'theirs');
  return { base, ours, theirs, ops };
}
