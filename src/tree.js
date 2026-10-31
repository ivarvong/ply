// A whole tree as one commit: the caller names every file (a build output, a generated site, a deploy artifact) and
// the commit's tree is exactly that set. Where editFile changes one path of the parent's tree, pushTree replaces it.
//
//   ls-refs (‖ the hinted commit) → the parent commit (tree:0, deepen 1) → the parent's trees, only where the new tree
//   differs (tree:0 per directory; on a host that refuses tree:0 the first fetch is blob:none and carries them all) →
//   one thin pack: the commit, the new trees (REF_DELTA against the tree they replace when that is smaller), and only the
//   blobs no fetched parent tree names → receive-pack, old oid = the parent (or zeros for a new ref) as the CAS.
//
// Workers-safe (Web APIs only). The directory walk is Node's and lives in tree-node.js.
//
// Shape: pure decisions between thin effects, as edit.js. fileEntries, buildTree, selectObjects are functions of their
// arguments; the effects (lsRefs, fetchObject, push, verifyRef) are free functions over a transport record.
import { fail } from './errors.js';
import { operation, verifyRef } from './operation.js';
import { lsRefs } from './lsrefs.js';
import { fetchObject } from './fetch.js';
import { push, ZERO_OID } from './push.js';
import { makeDelta } from './packresolve.js';
import { parseCommit, parseTree, encodeTree, encodeCommit, hashObject, ident, TYPE } from './objects.js';
import { bytesOf } from './bytes.js';
import { DEFAULT_LIMITS, limitError, requireLimit } from './limits.js';
import { validateIdent, validateRef, validatePath, validateMessage } from './validate.js';
import { decideHead } from './edit.js';
import { signCommit } from './sign.js';
import { MODE_BLOB, MODE_EXEC, MODE_LINK, MODE_TREE, MODE_COMMIT, DELTA_SIZE_MIN } from './format.js';

const OID = /^[0-9a-f]{40}$/;
const BLOB_MODES = new Set([MODE_BLOB, MODE_EXEC, MODE_LINK]);

// Pure: the caller's files as one list of { path, comps, mode, data?, oid }. Two input shapes:
//   { 'path': content } or a Map    content: string | Uint8Array (100644) | { data, mode } | { mode: '160000', oid }
//   iterable of { path, mode?, data?, oid? }
// Modes are git's tree modes: 100644 file, 100755 executable, 120000 symlink (data = the link target, as git stores
// it), 160000 gitlink (oid = the submodule commit; no data — the server does not need that commit). Every path goes
// through validatePath (no `.git`, `..`, empty component); each blob is bounded by maxObjectSize and the count by
// maxPackObjects before anything is hashed.
export function fileEntries(files, limits = DEFAULT_LIMITS) {
  if (files === null || typeof files !== 'object') throw fail('bad_request', 'files must be an object or an iterable of { path, mode, data }', { what: 'files' });
  const maxFiles = requireLimit(limits, 'maxPackObjects');
  const maxObject = requireLimit(limits, 'maxObjectSize');
  const pairs = files instanceof Map ? [...files] : Symbol.iterator in files ? null : Object.entries(files);
  const list = pairs ? pairs.map(([path, v]) => (typeof v === 'string' || v instanceof Uint8Array ? { path, data: v } : { ...v, path })) : files;
  const out = [];
  for (const f of list) {
    if (out.length >= maxFiles) throw limitError('files', out.length + 1, maxFiles);
    const { path, mode = MODE_BLOB } = f ?? {};
    const comps = validatePath(path, limits);
    if (mode === MODE_COMMIT) {
      if (!OID.test(f.oid ?? '') || f.data !== undefined) throw fail('bad_request', `${path}: a gitlink (160000) takes a 40-hex oid and no data`, { what: 'gitlink', path });
      out.push({ path, comps, mode, oid: f.oid });
      continue;
    }
    if (!BLOB_MODES.has(mode)) throw fail('bad_request', `${path}: mode ${JSON.stringify(mode)} is not 100644, 100755, 120000 or 160000`, { what: 'mode', path });
    const data = bytesOf(f.data);
    if (!(data instanceof Uint8Array)) throw fail('bad_request', `${path}: data must be a string or Uint8Array`, { what: 'data', path });
    if (data.length > maxObject) throw limitError('object size', data.length, maxObject);
    // a symlink target is a path: git cannot check out an empty one, and a NUL ends it on every platform
    if (mode === MODE_LINK && (data.length === 0 || data.includes(0))) throw fail('bad_request', `${path}: a symlink target must be non-empty and contain no NUL`, { what: 'symlink', path });
    out.push({ path, comps, mode, data, oid: hashObject('blob', data) });
  }
  return out;
}

// Pure: the trees of `entries`, bottom up. Returns { root, trees: Map(dir → { oid, data, entries }), blobs: Map(oid →
// data) }; '' is the root directory. A path given twice, or used as both a file and a directory, is the caller's
// error (git would reject the tree as duplicateEntries); each directory is bounded by maxTreeEntries. No files at all is
// git's empty tree (4b825dc6…), a valid root.
export function buildTree(entries, limits = DEFAULT_LIMITS) {
  const maxEntries = requireLimit(limits, 'maxTreeEntries');
  const dirs = new Map([['', new Map()]]);
  const blobs = new Map();
  for (const e of entries) {
    let dir = '';
    for (let i = 0; i < e.comps.length - 1; i++) {
      const name = e.comps[i], sub = dir ? `${dir}/${name}` : name;
      const here = dirs.get(dir);
      if (here.has(name) && here.get(name) !== null) throw fail('bad_request', `${sub} is both a file and a directory`, { what: 'path', path: e.path });
      if (!here.has(name)) { here.set(name, null); dirs.set(sub, new Map()); }
      dir = sub;
    }
    const here = dirs.get(dir), name = e.comps[e.comps.length - 1];
    if (here.has(name)) throw fail('bad_request', here.get(name) === null ? `${e.path} is both a file and a directory` : `${e.path} is given twice`, { what: 'path', path: e.path });
    if (here.size >= maxEntries) throw limitError('tree entries', here.size + 1, maxEntries);
    here.set(name, { mode: e.mode, name, oid: e.oid });
    if (e.data) blobs.set(e.oid, e.data);
  }
  // deepest first, so every subtree's oid exists before its parent is encoded
  const trees = new Map();
  const depth = dir => (dir === '' ? 0 : dir.split('/').length);
  for (const dir of [...dirs.keys()].sort((a, b) => depth(b) - depth(a))) {
    const list = [...dirs.get(dir)].map(([name, e]) => e ?? { mode: MODE_TREE, name, oid: trees.get(dir ? `${dir}/${name}` : name).oid });
    const data = encodeTree(list);
    trees.set(dir, { oid: hashObject('tree', data), data, entries: list });
  }
  return { root: trees.get('').oid, trees, blobs };
}

// Pure: what the pack must carry, given what the server is known to have. `have`: every oid named by a parent tree we
// fetched (the server holds the parent commit's whole closure, so each of those objects is there); `old`: dir → the
// parent's tree bytes at that path, a REF_DELTA base. A tree the server has is skipped with everything under it; a
// blob or tree reached twice is sent once (receive-pack refuses a pack with an object twice). Gitlinks send nothing.
export function selectObjects(built, { have = new Set(), old = new Map() } = {}) {
  const sent = new Set(), trees = [], blobs = [];
  const walk = dir => {
    const t = built.trees.get(dir);
    if (have.has(t.oid) || sent.has(t.oid)) return;
    sent.add(t.oid);
    const base = old.get(dir);
    const delta = base ? makeDelta(base.data, t.data).delta : null;
    // git's patch_delta rejects a delta under DELTA_SIZE_MIN; a delta no smaller than the tree is not worth the base lookup
    trees.push(delta && delta.length >= DELTA_SIZE_MIN && delta.length < t.data.length ? { type: TYPE.TREE, data: delta, baseOid: base.oid } : { type: TYPE.TREE, data: t.data });
    for (const e of t.entries) {
      if (e.mode === MODE_TREE) walk(dir ? `${dir}/${e.name}` : e.name);
      else if (BLOB_MODES.has(e.mode) && !have.has(e.oid) && !sent.has(e.oid)) { sent.add(e.oid); blobs.push({ type: TYPE.BLOB, data: built.blobs.get(e.oid) }); }
    }
  };
  walk('');
  return { trees, blobs, deltas: trees.filter(t => t.baseOid).length };
}

// Pure: every caller-controlled field, checked before any I/O. `base` as in editFile: the ref whose head is the
// parent (default `ref`); base ≠ ref creates `ref` (zero old oid). base = ref and the ref absent: the first commit of a
// new ref, no parent, zero old oid — a deploy's first push.
export function validateTreeSpec({ ref = 'refs/heads/main', base = ref, files, author, message, time = Math.floor(Date.now() / 1000) }, limits, head = null) {
  validateRef(ref); validateRef(base);
  const person = validateIdent({ name: author?.name, email: author?.email, time, tz: author?.tz });
  validateMessage(message);
  if (head !== null && !OID.test(head)) throw fail('bad_request', 'head must be a 40-hex oid');
  const entries = fileEntries(files, limits);
  const built = buildTree(entries, limits);
  return Object.freeze({ ref, base, create: base !== ref, built, files: entries.length, author: person, message, head });
}

// Same contract as editFile: `head` overlaps ls-refs with a speculative fetch of the hinted commit (ls-refs wins); a
// cas_conflict on attempt 0 is redone once from a fresh ls-refs, the retry's span linked to the first; `strictHead`
// makes the hint a precondition and is never retried; `verify` reads the ref back and an acknowledged push that does
// not read back is `ambiguous`. A retry rebuilds on the new head: the tree is still exactly `files` (that is the
// contract — another writer's files are not merged in), its parent is whatever won the race.
// The files are hashed once: the retry reuses the validated spec (same commit time, same trees).
export async function pushTree(url, spec, { head = null, strictHead = false, ...opts } = {}) {
  if (strictHead && head === null) throw fail('bad_request', 'strictHead needs head');
  const s = validateTreeSpec(spec, opts.limits ?? DEFAULT_LIMITS, head);
  const first = await pushTreeOnce(url, s, { ...opts, strictHead }, { head, attempt: 0, linkTo: null }).catch(e => e);
  if (!(first instanceof Error)) return first;
  if (first.code !== 'cas_conflict' || first.attempt !== 0 || strictHead) throw first;
  return pushTreeOnce(url, s, opts, { head: null, attempt: 1, linkTo: first.span ?? null, hintWas: first.hint ?? null });
}

async function pushTreeOnce(url, s, { cache = new Map(), verify = false, signer = null, strictHead = false, ...opts } = {}, { head, attempt, linkTo, hintWas = null }) {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  let hint = hintWas;
  const attrs = { 'git.push_tree.ref': s.ref, 'git.push_tree.base': s.base, 'git.push_tree.create': s.create, 'git.push_tree.files': s.files, 'git.push_tree.trees': s.built.trees.size, 'git.push_tree.tree.new': s.built.root, 'git.push_tree.head.hint': head ?? '', 'git.push_tree.attempt': attempt };
  return operation('push_tree', url, { ...opts, attrs, onFinish: () => ({ 'git.push_tree.head.outcome': hint ?? '' }), link: linkTo ? { span: linkTo, kind: 'retry_of' } : null }, async ({ t, root, outcome }) => {
    const commitOf = oid => fetchObject(t, { oid, expectType: TYPE.COMMIT, deepen: 1 });
    try {
    // 1. the parent: ls-refs, overlapped with the hinted commit. An absent base is a new ref only when base = ref.
    const [resolved, speculative] = await Promise.all([lsRefs(t, [s.base]).then(({ refs }) => refs.get(s.base)?.oid ?? null), head ? commitOf(head).then(o => o, e => e) : null]);
    if (resolved === null && s.create) throw fail('not_found', `ref ${s.base} not found`);
    const decided = decideHead({ hint: head, resolved });
    hint = hintWas ?? decided.hint;
    const parent = decided.oldCommit;
    if (strictHead && decided.hint === 'stale') throw fail('cas_conflict', `${s.base} is at ${parent ?? 'nothing'}, not the expected head ${head}`, { expected: head, actual: parent });
    if (speculative instanceof Error) root.set({ 'git.push_tree.head.speculative_error': speculative.code ?? 'error' });
    const oldTree = parent === null ? null : parseCommit((decided.hint === 'used' && !(speculative instanceof Error) ? speculative : await commitOf(parent)).data, limits).tree;
    root.set({ 'git.push_tree.commit.old': parent ?? '', 'git.push_tree.tree.old': oldTree ?? '' });
    if (oldTree === s.built.root && !s.create) return outcome('noop', summarize({ s, parent, oldTree, hint, attempt, noop: true }));

    // 2. what the server has: the parent's trees along every directory whose oid changed (cache by oid, immutable)
    const known = await t.tracer.span('git.push_tree.diff', { parent: root }, span => parentTrees(t, cache, s.built, oldTree, limits).then(k => { span.set({ 'git.push_tree.diff.trees_read': k.read, 'git.push_tree.diff.cache_hits': k.hits, 'git.push_tree.diff.have': k.have.size }); return k; }));
    const sel = selectObjects(s.built, known);

    // 3. the commit, then one push whose old oid is the CAS
    const who = ident(s.author);
    let commitData = encodeCommit({ tree: s.built.root, parents: parent ? [parent] : [], author: who, committer: who, message: s.message.endsWith('\n') ? s.message : s.message + '\n' });
    if (signer) { commitData = await signCommit(commitData, signer); root.set({ 'git.push_tree.commit.signed': signer.kind, 'git.push_tree.commit.signer': signer.publicKeyLine ?? '' }); }
    const newCommit = hashObject('commit', commitData);
    const objects = [{ type: TYPE.COMMIT, data: commitData }, ...sel.trees, ...sel.blobs];
    root.set({ 'git.push_tree.commit.new': newCommit, 'git.push_tree.send.trees': sel.trees.length, 'git.push_tree.send.tree_deltas': sel.deltas, 'git.push_tree.send.blobs': sel.blobs.length });
    const pushed = await push(t, { ref: s.ref, oldOid: s.create || parent === null ? ZERO_OID : parent, newOid: newCommit, objects });
    for (const tr of s.built.trees.values()) cache.set(tr.oid, tr.data);
    if (verify) await verifyRef(t, root, 'git.push_tree', s.ref, newCommit);
    return outcome('ok', summarize({ s, parent, oldTree, hint, attempt, newCommit, sel, pushed, treesRead: known.read }), { 'git.push_tree.push.bytes': pushed.packBytes, 'git.push_tree.push.objects': pushed.entries.length });
    } catch (e) { if (e && typeof e === 'object') { e.attempt = attempt; e.hint = hint; } throw e; }
  });
}

// Effect: the parent's trees wherever the new tree differs, recursing only into directories present on both sides with
// different oids. Every oid those trees name joins `have`. On a host that refuses tree:0 the first fetch is a blob:none
// pack that brings every tree of the subtree (fetch.js harvests them), so the rest are answered without a round trip.
async function parentTrees(t, cache, built, oldTree, limits) {
  const have = new Set(), old = new Map();
  const k = { have, old, read: 0, hits: 0 };
  if (oldTree === null) return k;
  have.add(oldTree);
  const read = async oid => {
    let data = cache.get(oid);
    if (data) k.hits++; else { data = (await fetchObject(t, { oid, expectType: TYPE.TREE })).data; cache.set(oid, data); k.read++; }
    return data;
  };
  const visit = async (dir, oid) => {
    const data = await read(oid);
    old.set(dir, { oid, data });
    const before = new Map(parseTree(data, limits).map(e => [e.name, e]));
    for (const e of before.values()) have.add(e.oid);
    const next = [];
    for (const e of built.trees.get(dir).entries) {
      const was = before.get(e.name);
      if (e.mode === MODE_TREE && was?.mode === MODE_TREE && was.oid !== e.oid) next.push(visit(dir ? `${dir}/${e.name}` : e.name, was.oid));
    }
    await Promise.all(next);
  };
  if (oldTree !== built.root) await visit('', oldTree);
  return k;
}

// Pure: the result record.
const summarize = ({ s, parent, oldTree, hint, attempt, newCommit = parent, sel = null, pushed = null, treesRead = 0, noop = false }) => ({
  noop, ref: s.ref, oldCommit: parent, newCommit, oldTree, newTree: s.built.root, hint, attempt,
  pushBytes: pushed?.packBytes ?? 0, treesRead,
  objects: { files: s.files, trees: s.built.trees.size, sent: pushed?.entries.length ?? 0, sentTrees: sel?.trees.length ?? 0, sentBlobs: sel?.blobs.length ?? 0, treeDeltas: sel?.deltas ?? 0 },
});
// ci/fast probe: whole-file mutation of every src file (reverted in the next commit)
