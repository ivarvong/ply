// Landing a branch, with git operations only: fast-forward, a merge commit from a three-way tree merge, branch delete.
//
// mergeBranch(ref ← from): ls-refs both, find the merge base (commit-only fetches, tree:0, doubling depth), then
//   - ours == base      → fast-forward: push the branch head to ref, empty pack (the server has every object)
//   - theirs == base    → nothing to do
//   - else              → three-way merge of the two trees against the base tree, directory by directory, fetching only the
//                         subtrees that differ; a commit with parents [ours, theirs]; push the commit + the new trees and
//                         merged blobs. A regular file both sides changed is merged line by line with a port of git's xdiff
//                         (linemerge.js: histogram diff, compaction, zealous conflict refinement) — clean exactly where git is
//                         clean and byte-identical, else `merge_conflict` with the paths and a reason per path. Our conflicts
//                         are a superset of git's: the rename guards below, and the rare file where git's diff falls back to
//                         classic Myers, which we do not port (test/fuzz/linemerge.mjs measures it). Where we succeed, the
//                         tree is what `git merge-tree --write-tree` produces (test/merge.test.js).
// The pure parts: threeWay (one directory), mergeMode, bestBases (git merge-base --all over known commits), uniqueObjects; linemerge.js. The effects: lsRefs, fetchObject, push.
import { fail } from './errors.js';
import { lsRefs } from './lsrefs.js';
import { fetchObject } from './fetch.js';
import { fetchPackTree0 } from './fetchpack.js';
import { push, ZERO_OID } from './push.js';
import { operation, verifyRef } from './operation.js';
import { parseTree, encodeTree, parseCommit, encodeCommit, hashObject, ident, TYPE } from './objects.js';
import { validateRef, validateIdent, validateMessage } from './validate.js';
import { signCommit } from './sign.js';
import { mergeLines } from './linemerge.js';
import { attributesFor, bytesToStr, utf8ToStr } from './attributes.js';
import { limitError, requireLimit, finiteLimit, LIMIT_MERGE_BLOB } from './limits.js';

const EMPTY = [];
const same = (a, b) => (a === null && b === null) || (a !== null && b !== null && a.mode === b.mode && a.oid === b.oid);
const isTree = e => e !== null && e.mode === '40000';

// Pure: three-way merge of one directory's entries. Returns { entries (resolved, in no particular order), recurse: [name],
// conflicts: [name], content: [name], deletedBoth, addedOurs, addedTheirs }. An entry absent on a side is null. Rules
// (git's trivial-merge rules, tree level): same on both sides → that; unchanged on one side → the other side's; both
// trees → recurse; both regular files changed differently over a regular base → `content` (a line merge may resolve it);
// otherwise → conflict. The deleted/added lists feed the rename guards in mergeTrees.
const isFile = e => e !== null && (e.mode === '100644' || e.mode === '100755');
export function threeWay(base, ours, theirs) {
  const by = list => new Map(list.map(e => [e.name, e]));
  const b = by(base), o = by(ours), t = by(theirs);
  const names = new Set([...b.keys(), ...o.keys(), ...t.keys()]);
  const entries = [], recurse = [], conflicts = [], content = [], deletedBoth = [], addedOurs = [], addedTheirs = [];
  for (const name of names) {
    const B = b.get(name) ?? null, O = o.get(name) ?? null, T = t.get(name) ?? null;
    if (B && !O && !T) deletedBoth.push(name);
    if (!B && O) addedOurs.push(name);
    if (!B && T) addedTheirs.push(name);
    if (same(O, T)) { if (O) entries.push(O); continue; }
    if (same(B, T)) { if (O) entries.push(O); continue; }
    if (same(B, O)) { if (T) entries.push(T); continue; }
    // directory vs directory, or a directory one side deleted/added: recurse so the conflict (if any) is per file,
    // and untouched files inside a directory the other side deleted go away, as git does
    const treeish = e => e === null || isTree(e);
    if (treeish(O) && treeish(T) && (isTree(O) || isTree(T))) { recurse.push(name); continue; }
    if (isFile(B) && isFile(O) && isFile(T)) { content.push(name); continue; }
    conflicts.push(name);
  }
  return { entries, recurse, conflicts, content, deletedBoth, addedOurs, addedTheirs };
}

// Pure: git's mode merge for a regular file both sides touched: equal → that; one side unchanged → the other's.
export const mergeMode = (b, o, t) => (o === t ? o : b === o ? t : b === t ? o : null);

// Pure: git's merge bases — the best common ancestors of `a` and `b` (common ancestors that are not ancestors of another
// common ancestor; git merge-base --all), over the commits known so far (oid → { parents }). `truncated` says the answer
// may be incomplete: some commit that could lead to another best base has parents we have not fetched yet. Sound
// because any best base outside what we know is an ancestor of a or b that is not an ancestor of a known common
// ancestor — so it lies beyond a frontier commit of exactly that region.
export function bestBases(commits, a, b) {
  const closure = starts => { const seen = new Set(); const st = [...starts]; while (st.length) { const c = st.pop(); if (seen.has(c)) continue; seen.add(c); for (const p of commits.get(c)?.parents ?? []) st.push(p); } return seen; };
  const A = closure([a]), B = closure([b]);
  const common = [...A].filter(c => B.has(c));
  const below = closure(common.flatMap(c => commits.get(c)?.parents ?? [])); // proper ancestors of common ancestors
  const best = common.filter(c => !below.has(c)).sort();
  const settled = new Set([...common, ...below]);
  const frontier = start => { const seen = new Set(); const st = [start]; while (st.length) { const c = st.pop(); if (seen.has(c) || settled.has(c)) continue; seen.add(c); const k = commits.get(c); if (!k) return true; for (const p of k.parents) st.push(p); } return false; };
  return { best, truncated: frontier(a) || frontier(b) };
}

// Effect: ancestors of `head` as oid → distance, via commit-only packs (tree:0 keeps trees and blobs out) of doubling depth.
export async function ancestors(t, head, depth) {
  const r = await fetchPackTree0(t, { wants: [head], filter: 'tree:0', deepen: depth });
  const commits = new Map(); for (const [oid, o] of r.objects ?? []) if (o.type === TYPE.COMMIT) commits.set(oid, parseCommit(o.data, t.limits));
  const dist = new Map([[head, 0]]); const q = [head];
  for (let i = 0; i < q.length; i++) { const c = q[i]; const d = dist.get(c); for (const p of commits.get(c)?.parents ?? []) if (!dist.has(p)) { dist.set(p, d + 1); q.push(p); } }
  return { dist, commits, complete: r.shallow.length === 0 }; // no shallow boundary reported → the whole history fit in the depth
}

export async function mergeBase(t, a, b, { maxDepth } = {}) {
  const cap = maxDepth === undefined ? requireLimit(t.limits, 'maxMergeDepth') : finiteLimit(maxDepth, 'maxMergeDepth');
  for (let depth = 8; depth <= cap; depth *= 2) {
    const [A, B] = await Promise.all([ancestors(t, a, depth), ancestors(t, b, depth)]);
    const commits = new Map([...B.commits, ...A.commits]);
    const { best, truncated } = bestBases(commits, a, b);
    if (!truncated || (A.complete && B.complete)) return { base: best.length === 1 ? best[0] : null, bases: best, depth, commits };
  }
  throw limitError('merge-base search depth', cap, cap);
}

// Effect: the paths `side` adds relative to `base` (both tree oids), recursing only into differing subtrees; a directory
// new on `side` is one entry, 'dir/', standing for everything inside it.
async function addedPaths(read, base, side, prefix = '') {
  if (base === side) return [];
  const [B, S] = await Promise.all([read(base), read(side)]);
  const b = new Map(B.map(e => [e.name, e])); const out = [];
  for (const e of S) {
    const old = b.get(e.name);
    if (!old) out.push(prefix + e.name + (isTree(e) ? '/' : ''));
    else if (isTree(e) && isTree(old) && old.oid !== e.oid) out.push(...await addedPaths(read, old.oid, e.oid, `${prefix}${e.name}/`));
    else if (isTree(e) !== isTree(old)) out.push(prefix + e.name + (isTree(e) ? '/' : ''));
  }
  return out;
}

// Effect: merge three trees (by oid, any may be null = empty) into a new tree, returning its oid, the new objects to push
// and conflicts as paths. Fetches only directories where the sides differ; `cache` is the oid → bytes tree cache.
// `mergeBlob(base, ours, theirs, path)` resolves a path both sides changed (line merge); without it such paths conflict.
//
// Rename guards. merge-ort detects renames (and directory renames, as conflicts); we do not. Two shapes are where a
// rename could make git conflict while a rename-blind merge is clean, so they are conflicts here (superset of git's):
//   G1  a path deleted on both sides while either side adds a path   (rename/rename(1to2), rename/delete) — the deleted
//       paths and the added ones are reported, since git names the conflict at the rename target
//   (G2's target is a path git computes from the directory rename; we report the added path and the reason.)
//   G2  a directory one side removed entirely, the other side adds inside it   (directory rename + add)
// A rename on one side with the other side untouched merges exactly as git does.
export async function mergeTrees(t, cache, { base, ours, theirs, prefix = '', removed = null, mergeBlob = null, driverFor = null }, out = null) {
  const top = out === null;
  // reasons is keyed by path, so it has no prototype: a path named `__proto__` or `constructor` is recorded like any other
  out = out ?? { objects: [], conflicts: [], fetched: 0, deletedBoth: [], dirAdds: [], reasons: Object.create(null), contentMerged: 0 };
  const read = async oid => { if (!oid) return EMPTY; let data = cache.get(oid); if (!data) { data = (await fetchObject(t, { oid, expectType: TYPE.TREE })).data; cache.set(oid, data); out.fetched++; } return parseTree(data, t.limits); };
  const [B, O, T] = await Promise.all([read(base), read(ours), read(theirs)]);
  const r = threeWay(B, O, T);
  const { entries } = r;
  for (const name of r.conflicts) { out.conflicts.push(prefix + name); out.reasons[prefix + name] = 'tree'; }
  const has = (list, name) => list.some(e => e.name === name);
  if (r.conflicts.some(name => has(B, name) && !(has(O, name) && has(T, name)))) out.deletedOne = true; // modify/delete
  for (const name of r.deletedBoth) out.deletedBoth.push(prefix + name);
  if (removed === 'ours') for (const name of r.addedTheirs) out.dirAdds.push(prefix + name);
  if (removed === 'theirs') for (const name of r.addedOurs) out.dirAdds.push(prefix + name);
  // Names are the repository's: a Map, so a directory called `constructor` or `__proto__` is not Object.prototype's
  const byName = list => new Map(list.map(e => [e.name, e]));
  const b = byName(B), o = byName(O), th = byName(T);
  for (const name of r.content) {
    const mode = mergeMode(b.get(name).mode, o.get(name).mode, th.get(name).mode);
    const blob = mode === null || !mergeBlob ? null : await mergeBlob({ base: b.get(name).oid, ours: o.get(name).oid, theirs: th.get(name).oid, path: prefix + name, driverFor });
    if (blob === null || blob.conflict) { out.conflicts.push(prefix + name); out.reasons[prefix + name] = mode === null ? 'mode' : blob?.reason ?? 'content'; continue; }
    entries.push({ mode, name, oid: blob.oid });
    if (blob.data) out.objects.push({ type: TYPE.BLOB, data: blob.data, oid: blob.oid });
    out.contentMerged++;
  }
  for (const name of r.recurse) {
    const treeOid = e => (e && e.mode === '40000' ? e.oid : null);
    const sideRemoved = removed ?? (b.get(name)?.mode === '40000' ? (!o.has(name) ? 'ours' : !th.has(name) ? 'theirs' : null) : null);
    const sub = await mergeTrees(t, cache, { base: treeOid(b.get(name)), ours: treeOid(o.get(name)), theirs: treeOid(th.get(name)), prefix: `${prefix}${name}/`, removed: sideRemoved, mergeBlob, driverFor }, out);
    if (sub.oid !== null) entries.push({ mode: '40000', name, oid: sub.oid }); // an empty merged subtree drops the directory, as git does
  }
  if (top) for (const p of out.dirAdds) if (!(p in out.reasons)) { out.conflicts.push(p); out.reasons[p] = 'possible directory rename (added inside a directory the other side removed)'; }
  if (top && (out.deletedBoth.length || (out.conflicts.length && out.deletedOne))) {
    // Every path either side added, across the whole tree — the walk above skips directories only one side changed, and a
    // rename target can be anywhere. Fetched only when a deletion is in play.
    const added = [...new Set([...await addedPaths(read, base, ours), ...await addedPaths(read, base, theirs)])];
    if (out.deletedBoth.length && added.length) for (const p of out.deletedBoth) { out.conflicts.push(p); out.reasons[p] = 'possible rename source (deleted on both sides while paths were added; ply does not detect renames)'; }
    // Naming: git reports a rename's conflict at the rename target (rename/delete, rename/rename, or a content conflict
    // after following a rename onto a modify/delete). When this merge conflicts with a deletion in play, every added path
    // is a possible target, so it is listed too. This adds names to a conflicting merge; it never makes one conflict.
    if (out.conflicts.length) for (const p of added) if (!(p in out.reasons)) { out.conflicts.push(p); out.reasons[p] = 'possible rename target (added while the merge has a deletion conflict)'; }
  }
  if (out.conflicts.length) return { oid: null, ...out };
  if (entries.length === 0) return { oid: null, ...out };
  const data = encodeTree(entries), oid = hashObject('tree', data);
  if (oid !== ours && oid !== theirs && oid !== base) out.objects.push({ type: TYPE.TREE, data, oid });
  cache.set(oid, data);
  return { oid, ...out };
}

// Effect: the merge driver for a path from the .gitattributes files of one tree (git's attr.tree / --attr-source, or the
// worktree's — which is ours — for a non-bare `git merge`). Reads only the directories on the path, each once; returns
// 'text' | 'union' | 'binary' as find_ll_merge_driver picks: merge set → text, -merge → binary, merge=binary|union|text
// → that, any other name → text (a custom driver is server configuration we cannot see), unspecified → text.
export function attributeDrivers(t, cache, treeOid) {
  const readTree = async oid => { let data = cache.get(oid); if (!data) { data = (await fetchObject(t, { oid, expectType: TYPE.TREE })).data; cache.set(oid, data); } return parseTree(data, t.limits); };
  const dirTree = new Map([['', Promise.resolve(treeOid)]]), files = new Map();
  const treeOf = dir => {
    if (!dirTree.has(dir)) {
      const cut = dir.lastIndexOf('/'), parent = cut < 0 ? '' : dir.slice(0, cut), name = dir.slice(cut + 1);
      dirTree.set(dir, treeOf(parent).then(async p => (p ? (await readTree(p)).find(e => e.name === name && e.mode === '40000')?.oid ?? null : null)));
    }
    return dirTree.get(dir);
  };
  const fileOf = dir => {
    if (!files.has(dir)) files.set(dir, treeOf(dir).then(async oid => {
      const e = oid ? (await readTree(oid)).find(x => x.name === '.gitattributes' && x.mode !== '40000' && x.mode !== '160000') : null;
      return e ? bytesToStr((await fetchObject(t, { oid: e.oid, expectType: TYPE.BLOB })).data) : null;
    }));
    return files.get(dir);
  };
  return async path => {
    const dirs = ['']; for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) dirs.push(path.slice(0, i));
    const texts = await Promise.all(dirs.map(fileOf));
    const byDir = new Map(); dirs.forEach((d, i) => { if (texts[i] !== null) byDir.set(utf8ToStr(d), texts[i]); });
    const v = attributesFor(utf8ToStr(path), byDir).get('merge');
    if (v === false) return 'binary';
    if (v === 'binary' || v === 'union') return v;
    return 'text';
  };
}

// Effect: the content half of a both-sides-changed file — git's shortcuts first (one side equal to base or both equal),
// then the three blobs (bounded by limits.maxMergeBlobBytes) through the ported xdiff merge. Returns { oid, data? } or
// { conflict: true, reason }. Shared by merge, rebase, cherry-pick and revert.
export function blobMerger(t, { maxMergeBlobBytes = LIMIT_MERGE_BLOB, rediff = 'myers', stats = { merged: 0, undecided: 0, unioned: 0, attrBinary: 0 } } = {}) {
  if (!['undecided', 'skip', 'myers'].includes(rediff)) throw fail('bad_request', `rediff must be 'undecided', 'skip' or 'myers', not ${JSON.stringify(rediff)}`);
  const blobCap = finiteLimit(maxMergeBlobBytes, 'maxMergeBlobBytes');
  const objectCap = requireLimit(t.limits, 'maxObjectSize');
  const bounded = Object.create(t, { limits: { value: { ...t.limits, maxObjectSize: Math.min(objectCap, blobCap) } } });
  // Blobs this merger produced exist only in the pending push (a rebase replays commit 2 onto commit 1's merged blob), so
  // they are served from here; the bytes are already held for the push, so this costs no extra memory.
  const made = new Map();
  const get = async oid => made.get(oid) ?? (await fetchObject(bounded, { oid, expectType: TYPE.BLOB })).data;
  const f = async ({ base, ours, theirs, path, driverFor = null }) => {
    if (ours === theirs || theirs === base) return { oid: ours };
    if (ours === base) return { oid: theirs };
    // the merge attribute (when an attribute source was given): binary/-merge conflicts without reading the blobs
    const driver = driverFor ? await driverFor(path) : 'text';
    if (driver === 'binary') { stats.attrBinary++; return { conflict: true, reason: 'binary (merge attribute)' }; }
    let B, O, T;
    try { [B, O, T] = await Promise.all([get(base), get(ours), get(theirs)]); }
    catch (e) { if (e.code === 'limit_exceeded') return { conflict: true, reason: 'too large to merge' }; throw e; }
    const m = mergeLines(B, O, T, { maxBytes: blobCap, rediff, driver });
    if (!m.clean) { if (m.reason === 'undecided') stats.undecided++; return { conflict: true, reason: m.reason === 'content' ? 'content (both sides changed the same lines)' : m.reason === 'undecided' ? 'content (git would decide this with a classic-diff fallback ply does not implement)' : m.reason }; }
    stats.merged++; if (m.unioned) stats.unioned++;
    const oid = hashObject('blob', m.data); made.set(oid, m.data);
    return { oid, data: m.data };
  };
  f.stats = stats;
  return f;
}

// Pure: one entry per oid, first wins. git's unpack-objects/index-pack refuse a pack that carries an object twice
// ("tried to add buffer twice"), and a merge produces the same blob or tree at two paths, or in two replayed commits.
export const uniqueObjects = objects => { const seen = new Set(); return objects.filter(o => !seen.has(o.oid) && seen.add(o.oid)); };

// Effect: the tree whose .gitattributes govern a merge. null → none (git ≥ 2.46 in a bare repository, unless attr.tree
// is set); 'ours' | 'theirs' | 'base' → that side's tree ('ours' is what `git merge` in a worktree reads, and git
// 2.43–2.45 in a bare repository whose HEAD is the target branch); a ref name or commit oid → its tree (attr.tree=<rev>).
export const validateAttributes = a => {
  if (a === null || a === undefined || a === 'ours' || a === 'theirs' || a === 'base' || /^[0-9a-f]{40}$/.test(a ?? '')) return;
  if (typeof a !== 'string') throw fail('bad_request', 'attributes must be null, ours, theirs, base, a ref or a commit oid');
  validateRef(a);
};
export async function attributeTree(t, attributes, trees) {
  if (attributes === null || attributes === undefined) return null;
  if (attributes === 'ours' || attributes === 'theirs' || attributes === 'base') return trees[attributes];
  if (typeof attributes !== 'string') throw fail('bad_request', 'attributes must be null, ours, theirs, base, a ref or a commit oid');
  let oid = attributes;
  if (!/^[0-9a-f]{40}$/.test(attributes)) { validateRef(attributes); oid = (await lsRefs(t, [attributes])).refs.get(attributes)?.oid; if (!oid) throw fail('not_found', `attributes ref ${attributes} not found`); }
  return parseCommit((await fetchObject(t, { oid, expectType: TYPE.COMMIT, deepen: 1 })).data, t.limits).tree;
}

// Fast-forward `ref` to `to`, expecting it to be at `from` (CAS). Empty pack: the server already has the objects.
export async function fastForward(t, { ref, from, to }) {
  return push(t, { ref, oldOid: from, newOid: to, objects: [] });
}

export async function deleteBranch(t, { ref, oid }) {
  return push(t, { ref, oldOid: oid, newOid: ZERO_OID, objects: [] });
}

export async function mergeBranch(url, { ref = 'refs/heads/main', from, author, message, time = Math.floor(Date.now() / 1000), fastForwardOnly = false, noFastForward = false }, { cache = new Map(), signer = null, verify = false, rediff = 'myers', attributes = null, ...opts } = {}) {
  validateRef(ref); validateRef(from);
  const person = author ? validateIdent({ name: author.name, email: author.email, time, tz: author.tz }) : null;
  if (message) validateMessage(message); validateAttributes(attributes);
  return operation('merge', url, { ...opts, attrs: { 'git.merge.ref': ref, 'git.merge.from': from, 'git.merge.ff_only': fastForwardOnly, 'git.merge.no_ff': noFastForward } }, async ({ t, root, outcome }) => {
    const { refs } = await lsRefs(t, [ref, from]);
    const ours = refs.get(ref)?.oid, theirs = refs.get(from)?.oid;
    if (!ours) throw fail('not_found', `ref ${ref} not found`); if (!theirs) throw fail('not_found', `ref ${from} not found`);
    root.set({ 'git.merge.ours': ours, 'git.merge.theirs': theirs });
    if (ours === theirs) return outcome('up_to_date', { outcome: 'up_to_date', ref, oid: ours, ours, theirs, base: ours });
    const { base, bases, depth } = await mergeBase(t, ours, theirs);
    root.set({ 'git.merge.base': base ?? '', 'git.merge.bases': bases.length, 'git.merge.base.depth': depth });
    if (bases.length === 0) throw fail('unrelated_histories', `${ref} and ${from} share no common ancestor within the search depth`);
    // criss-cross history: git merges the bases into a virtual one (merge-ort, recursively); a single base can give a clean
    // result that differs from git's, so we refuse rather than guess
    if (bases.length > 1) throw fail('merge_conflict', `${ref} and ${from} have ${bases.length} merge bases (criss-cross history); ply does not build git's virtual merge base`, { conflicts: [], reasons: Object.create(null), bases });
    if (base === theirs) return outcome('up_to_date', { outcome: 'up_to_date', ref, oid: ours, ours, theirs, base });
    if (base === ours && !noFastForward) {
      const r = await fastForward(t, { ref, from: ours, to: theirs });
      return outcome('fast_forward', { outcome: 'fast_forward', ref, oid: theirs, ours, theirs, base }, { 'git.merge.push.bytes': r.packBytes });
    }
    if (fastForwardOnly) throw fail('not_fast_forward', `${ref} has moved past the merge base; a merge commit would be needed`);
    // three-way: commits for the three trees (the commit-only packs from mergeBase did not carry trees)
    const [cB, cO, cT] = await Promise.all([base, ours, theirs].map(oid => fetchObject(t, { oid, expectType: TYPE.COMMIT, deepen: 1 })));
    const trees = { base: parseCommit(cB.data, t.limits).tree, ours: parseCommit(cO.data, t.limits).tree, theirs: parseCommit(cT.data, t.limits).tree };
    const mergeBlob = blobMerger(t, { maxMergeBlobBytes: requireLimit(t.limits, 'maxMergeBlobBytes'), rediff });
    const attrTree = await attributeTree(t, attributes, trees);
    root.set({ 'git.merge.attributes': attributes ?? '' });
    const merged = await mergeTrees(t, cache, { ...trees, mergeBlob, driverFor: attrTree ? attributeDrivers(t, cache, attrTree) : null });
    root.set({ 'git.merge.content.merged': merged.contentMerged, 'git.merge.content.undecided': mergeBlob.stats.undecided, 'git.merge.content.unioned': mergeBlob.stats.unioned, 'git.merge.content.attr_binary': mergeBlob.stats.attrBinary, 'git.merge.trees.fetched': merged.fetched, 'git.merge.trees.new': merged.objects.filter(o => o.type === TYPE.TREE).length, 'git.merge.conflicts': merged.conflicts.slice(0, 64), 'git.merge.conflicts.count': merged.conflicts.length });
    if (merged.conflicts.length) throw fail('merge_conflict', `conflicts: ${merged.conflicts.slice(0, 8).map(p => `${p} (${merged.reasons[p]})`).join(', ')}${merged.conflicts.length > 8 ? '…' : ''}`, { conflicts: merged.conflicts, reasons: merged.reasons });
    const treeOid = merged.oid ?? hashObject('tree', encodeTree([]));
    if (!person) throw fail('bad_request', 'author is required for a merge commit');
    const who = ident(person);
    let commitData = encodeCommit({ tree: treeOid, parents: [ours, theirs], author: who, committer: who, message: (message ?? `Merge ${from.replace(/^refs\/heads\//, '')} into ${ref.replace(/^refs\/heads\//, '')}`).replace(/\n?$/, '\n') });
    if (signer) commitData = await signCommit(commitData, signer);
    const oid = hashObject('commit', commitData);
    const objects = uniqueObjects([{ type: TYPE.COMMIT, data: commitData, oid }, ...(merged.oid === null ? [{ type: TYPE.TREE, data: encodeTree([]), oid: treeOid }] : []), ...merged.objects]).map(o => ({ type: o.type, data: o.data }));
    const r = await push(t, { ref, oldOid: ours, newOid: oid, objects });
    if (verify) await verifyRef(t, root, 'git.merge', ref, oid);
    return outcome('merge', { outcome: 'merge', ref, oid, tree: treeOid, ours, theirs, base, pushBytes: r.packBytes, newTrees: merged.objects.filter(o => o.type === TYPE.TREE).length, contentMerged: merged.contentMerged }, { 'git.merge.commit': oid, 'git.merge.tree': treeOid, 'git.merge.push.bytes': r.packBytes });
  });
}
