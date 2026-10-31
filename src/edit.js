// O(1)-memory single-file edit: ls-refs → commit (tree:0, deepen 1) → one tree per level →
// streamed blob replace (never materialized) → thin push with REF_DELTAs.
// Shape: pure decisions between thin effects. Every decision (validateSpec, decideHead, lookupEntry, buildCommitObjects,
// memFromScan, summarize) is a function of its arguments; the effects (lsRefs, fetchObject, packStream, push) are free
// functions over a transport record, imported individually so a bundle of this file carries nothing else.
import { fail, isPlyCode } from './errors.js';
import { operation, verifyRef } from './operation.js';
import { lsRefs } from './lsrefs.js';
import { packStream, fetchObject, spInit, spStep, spFinish } from './fetch.js';
import { push, ZERO_OID } from './push.js';
import { spliceDelta } from './pack.js';
import { parseCommit, parseTree, treeReplaceOid, hashObject, encodeCommit, ident, objectHeader, TYPE } from './objects.js';
import { fromHex, streamingSha1 } from './sha1.js';
import { te, concat, indexOfBytes, bytesOf } from './bytes.js';
import { KIND, cpuNow, cpuSince } from './otel.js';
import { DEFAULT_LIMITS } from './limits.js';
import { validateIdent, validateRef, validatePath, validateMessage } from './validate.js';
import { signCommit } from './sign.js';

export { spInit, spStep, spFinish }; // the single-object pack parser lives in fetch.js; re-exported for callers of old paths

// ---- streaming find/replace scanner (pure step) ----
// Emits transformed bytes; counts matches and records the first MATCH_OFFSETS_KEPT offsets. Carry ≤ |find|-1 bytes.
// The contract is exactly one match, so offsets past the first few decide nothing: `count` is the outcome, `matches`
// is evidence for the span. Keeping every offset (a fresh array per hit) made a one-byte find over a 128 KiB run of that
// byte O(matches²): 400 s (#13). Now each hit costs O(1).
export const MATCH_OFFSETS_KEPT = 16;
export const scanInit = ({ find, replace }) => Object.freeze({ find, replace, carry: new Uint8Array(0), base: 0, matches: [], count: 0, emitted: 0, chunks: 0, maxChunk: 0 });
export function scanStep(st, chunk) {
  const data = st.carry.length ? concat([st.carry, chunk]) : chunk;
  const emit = [];
  const matches = [...st.matches];
  let count = st.count, p = 0, emitted = st.emitted;
  for (;;) {
    const i = indexOfBytes(data, st.find, p);
    if (i < 0) break;
    emit.push(data.subarray(p, i)); emitted += i - p;
    emit.push(st.replace); emitted += st.replace.length;
    if (matches.length < MATCH_OFFSETS_KEPT) matches.push(st.base + i);
    count += 1;
    p = i + st.find.length;
  }
  const keep = Math.min(st.find.length - 1, data.length - p);
  const flushTo = data.length - keep;
  if (flushTo > p) { emit.push(data.subarray(p, flushTo)); emitted += flushTo - p; }
  return {
    emit: emit.filter(e => e.length),
    state: { ...st, carry: data.slice(flushTo), base: st.base + flushTo, matches, count, emitted, chunks: st.chunks + 1, maxChunk: Math.max(st.maxChunk, chunk.length) },
  };
}
export function scanFinish(st) {
  const emit = st.carry.length ? [st.carry] : [];
  return { emit, state: { ...st, carry: new Uint8Array(0), emitted: st.emitted + st.carry.length } };
}
export const scanAttrs = st => ({
  'git.edit.blob.scan.chunks': st.chunks, 'git.edit.blob.scan.chunk.max': st.maxChunk, 'git.edit.blob.scan.matches': st.count,
  'git.edit.blob.scan.match_offsets': st.matches, 'git.edit.blob.scan.emitted': st.emitted,
});

// ---- the pipeline ----

const OID = /^[0-9a-f]{40}$/;

// Pure: everything the caller controls, checked before any I/O. None of these strings can be escaped once inside git.
// `base`: the ref whose head the commit is built on (default: `ref` itself). With base ≠ ref the push *creates* `ref`
// (old oid = zeros), the way a pull-request branch is made; the CAS then means "the branch must not exist yet".
export function validateSpec({ ref = 'refs/heads/main', base = ref, path, find, replace, author, message, time = Math.floor(Date.now() / 1000) }, limits, head = null) {
  validateRef(ref); validateRef(base);
  const person = validateIdent({ name: author?.name, email: author?.email, time, tz: author?.tz });
  validateMessage(message);
  const comps = validatePath(path, limits);
  find = bytesOf(find); replace = bytesOf(replace);
  if (!(find instanceof Uint8Array) || !(replace instanceof Uint8Array)) throw fail('bad_request', 'find/replace must be string or Uint8Array');
  if (!find.length) throw fail('bad_request', 'find must be non-empty');
  if (head !== null && !OID.test(head)) throw fail('bad_request', 'head must be a 40-hex oid');
  return Object.freeze({ ref, base, create: base !== ref, path, comps, find, replace, author: person, message, time: person.time, head });
}

// Pure: which oid is the parent, and what the hint turned out to be. ls-refs always wins; the hint only decides
// whether the speculative commit fetch was useful ('used') or wasted ('stale').
export function decideHead({ hint, resolved }) {
  if (hint === null) return { oldCommit: resolved, hint: null };
  return { oldCommit: resolved, hint: hint === resolved ? 'used' : 'stale' };
}

// Pure: one path component against one tree's entries.
export function lookupEntry(data, name, last, limits) {
  const entries = parseTree(data, limits);
  const entry = entries.find(e => e.name === name);
  const attrs = { 'git.edit.tree.bytes': data.length, 'git.edit.tree.entries': entries.length, 'git.edit.tree.entry.found': !!entry, 'git.edit.tree.entry.mode': entry?.mode ?? '', 'git.edit.tree.entry.oid': entry?.oid ?? '', 'git.edit.tree.entry.oid_offset': entry?.oidOffset ?? -1 };
  if (!entry) throw fail('not_found', `path component ${name} not found`, { attrs });
  if (!last && entry.mode !== '40000') throw fail('not_found', `${name} is not a directory`, { attrs });
  if (last && !(entry.mode === '100644' || entry.mode === '100755')) throw fail('not_found', `${name} is not a regular file (mode ${entry.mode})`, { attrs });
  return { entry, attrs };
}

// Pure: the new trees (bottom-up splices), the commit, and the thin pack's object list.
export function buildCommitObjects({ levels, blob, oldCommit, author, time, message }) {
  const trees = [];
  let child = blob.newOid;
  for (let i = levels.length - 1; i >= 0; i--) {
    const { treeOid: oldOid, data, entry } = levels[i];
    const newData = treeReplaceOid(data, entry, child);
    const newOid = hashObject('tree', newData);
    const { delta } = spliceDelta({ baseLen: data.length, off: entry.oidOffset, oldLen: 20, insert: fromHex(child) });
    trees.unshift({ type: TYPE.TREE, data: delta, baseOid: oldOid, newOid, newData });
    child = newOid;
  }
  const who = ident(validateIdent({ name: author?.name, email: author?.email, time, tz: author?.tz }));
  const commitData = encodeCommit({ tree: child, parents: [oldCommit], author: who, committer: who, message: message.endsWith('\n') ? message : message + '\n' });
  const newCommit = hashObject('commit', commitData);
  const objects = [
    { type: TYPE.COMMIT, data: commitData },
    ...trees.map(t => ({ type: t.type, data: t.data, baseOid: t.baseOid })),
    // git's patch_delta rejects deltas < DELTA_SIZE_MIN (4 bytes); an empty result is such a delta → send the full object
    blob.delta.length >= 4 ? { type: TYPE.BLOB, data: blob.delta, baseOid: blob.oldOid } : { type: TYPE.BLOB, data: new Uint8Array(blob.newLen) },
  ];
  return { trees, newTree: child, commitData, newCommit, objects };
}

// Pure: the same build with a different commit object (e.g. the signed one): identity and pack entry follow the bytes.
export function withCommitData(built, commitData) {
  const newCommit = hashObject('commit', commitData);
  return { ...built, commitData, newCommit, objects: [{ type: TYPE.COMMIT, data: commitData }, ...built.objects.slice(1)] };
}

// Pure: memory accounting for the whole edit, from what was actually held: each metadata object (whole, bounded by
// limits.maxObjectSize) and the streamed blob's chunks (DecompressionStream's; counted from the scanner's state).
export const memFromScan = (scan, inflated) => ({ 'mem.alloc.inflate_chunk.bytes': inflated, 'mem.alloc.inflate_chunk.count': scan.chunks, 'mem.alloc.inflate_chunk.max_single': scan.maxChunk });
export const memAttrs = ({ objects, scan, inflated }) => ({
  'mem.alloc.bytes': objects.reduce((n, o) => n + o, 0) + inflated, 'mem.alloc.count': objects.length + scan.chunks, 'mem.alloc.max_single': Math.max(0, ...objects, scan.maxChunk),
  'mem.alloc.object.bytes': objects.reduce((n, o) => n + o, 0), 'mem.alloc.object.count': objects.length, ...memFromScan(scan, inflated),
});

// Pure: the result record.
const summarize = ({ oldCommit, commit, blob, hint, attempt, newCommit = oldCommit, newTree = commit.tree, trees = [], pushBytes = 0, noop = false }) =>
  ({ noop, oldCommit, newCommit, oldTree: commit.tree, newTree, oldBlob: blob.oldOid, newBlob: blob.newOid, matchOffset: blob.matchOffset, baseLen: blob.baseLen, newLen: blob.newLen, pushBytes, trees: trees.map(t => ({ old: t.baseOid, new: t.newOid })), hint, attempt });

// `head`: an oid the caller believes `ref` points at (e.g. its last newCommit). ls-refs and the hinted commit fetch run
// concurrently; a stale hint is corrected before anything is pushed (same wall time as skipping ls-refs, one more
// request, no wasted push). A cas_conflict on attempt 0 (replica lag: ls-refs and receive-pack disagreed) is redone
// once; the retry's root span links to the first attempt's.
// `strictHead: true` turns the hint into a precondition: if `ref` is not at `head`, the edit is a `cas_conflict` before
// anything is pushed, and it is not retried (the caller asked for exactly that parent).
export async function editFile(url, spec, { head = null, strictHead = false, ...opts } = {}) {
  if (strictHead && head === null) throw fail('bad_request', 'strictHead needs head');
  const first = await editOnce(url, spec, { ...opts, strictHead }, { head, attempt: 0, linkTo: null }).catch(e => e);
  if (!(first instanceof Error)) return first;
  if (first.code !== 'cas_conflict' || first.attempt !== 0 || strictHead) throw first;
  return editOnce(url, spec, opts, { head: null, attempt: 1, linkTo: first.span ?? null, hintWas: first.hint ?? null });
}

async function editOnce(url, spec, { cache = new Map(), verify = false, allowLfsPointer = false, signer = null, fetchImpl, strictHead = false, ...opts } = {}, { head, attempt, linkTo, hintWas = null }) {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const s = validateSpec(spec, limits, head);
  const held = []; // sizes of metadata objects held whole, for memAttrs
  let streamed = { scan: { chunks: 0, maxChunk: 0 }, inflated: 0 };
  let hint = hintWas;
  const attrs = { 'git.edit.ref': s.ref, 'git.edit.base': s.base, 'git.edit.create': s.create, 'git.edit.path': s.path, 'git.edit.path.depth': s.comps.length, 'git.edit.find.bytes': s.find.length, 'git.edit.replace.bytes': s.replace.length, 'git.edit.head.hint': head ?? '', 'git.edit.attempt': attempt };
  // on every exit: how the hint turned out, what was held in memory, and the pack cache's counters if the fetch has them
  const onFinish = () => ({ 'git.edit.head.outcome': hint ?? '', ...memAttrs({ objects: held, ...streamed }), ...(fetchImpl?.attrs ? fetchImpl.attrs() : {}) });
  return operation('edit', url, { ...opts, fetchImpl, attrs, onFinish, link: linkTo ? { span: linkTo, kind: 'retry_of' } : null }, async ({ t, root, outcome }) => {
    const tracer = opts.tracer;
    const getObject = async (oid, expectType, deepen) => { const o = await fetchObject(t, { oid, filter: 'tree:0', deepen, expectType }); held.push(o.size); return o; };
    try {
    // 1+2. parent commit: ls-refs, overlapped with a speculative fetch of the hinted commit when there is a hint.
    const resolve = () => lsRefs(t, [s.base]).then(({ refs }) => { const r = refs.get(s.base); if (!r) throw fail('not_found', `ref ${s.base} not found`); return r.oid; });
    const [resolved, speculative] = await Promise.all([resolve(), head ? getObject(head, TYPE.COMMIT, 1).then(o => o, e => e) : null]);
    const decided = decideHead({ hint: head, resolved });
    hint = hintWas ?? decided.hint;
    const { oldCommit } = decided;
    if (strictHead && decided.hint === 'stale') throw fail('cas_conflict', `${s.base} is at ${oldCommit}, not the expected head ${head}`, { expected: head, actual: oldCommit });
    if (speculative instanceof Error) root.set({ 'git.edit.head.speculative_error': speculative.code ?? 'error' });
    const commitObj = decided.hint === 'used' && !(speculative instanceof Error) ? speculative : await getObject(oldCommit, TYPE.COMMIT, 1);
    const commit = parseCommit(commitObj.data, limits);
    root.set({ 'git.edit.commit.old': oldCommit, 'git.edit.tree.root': commit.tree, 'git.edit.commit.old.parents': commit.parents.length });

    // 3. trees, one per level. Effect: fetch on cache miss; decision: lookupEntry.
    const levels = [];
    let treeOid = commit.tree, cacheHits = 0;
    for (let depth = 0; depth < s.comps.length; depth++) {
      const name = s.comps[depth], last = depth === s.comps.length - 1;
      const lvl = await tracer.span('git.edit.tree', { parent: root, attrs: { 'git.edit.tree.depth': depth, 'git.edit.tree.oid': treeOid, 'git.edit.tree.lookup': name } }, async span => {
        let data = cache.get(treeOid);
        const hit = !!data;
        if (!data) { data = (await getObject(treeOid, TYPE.TREE)).data; cache.set(treeOid, data); } else cacheHits++;
        span.set({ 'git.edit.tree.cache_hit': hit });
        try { const { entry, attrs } = lookupEntry(data, name, last, limits); span.set(attrs); return { treeOid, data, entry }; }
        catch (e) { if (e.attrs) span.set(e.attrs); throw e; }
      });
      levels.push(lvl);
      treeOid = lvl.entry.oid;
    }
    const blobOid = treeOid;
    root.set({ 'git.edit.blob.old': blobOid, 'git.edit.tree.cache_hits': cacheHits, 'git.edit.tree.fetches': s.comps.length - cacheHits });

    // 4. streamed blob replace. Effect: one pack stream; decisions: spStep/scanStep (pure), the exactly-one-match contract.
    const blob = await streamBlobEdit({ t, tracer, root, blobOid, find: s.find, replace: s.replace, allowLfsPointer });
    streamed = { scan: blob.scan, inflated: blob.inflated };

    // identical content → no commit; a no-op edit must not create an empty commit
    if (blob.newOid === blobOid) return outcome('noop', summarize({ oldCommit, commit, blob, hint, attempt, noop: true }), { 'git.edit.blob.new': blob.newOid });

    // 5+6. new trees + commit (pure), then push (effect).
    let built = buildCommitObjects({ levels, blob, oldCommit, author: s.author, time: s.time, message: s.message });
    if (signer) { built = withCommitData(built, await signCommit(built.commitData, signer)); root.set({ 'git.edit.commit.signed': signer.kind, 'git.edit.commit.signer': signer.publicKeyLine ?? '' }); }
    for (const tr of built.trees) cache.set(tr.newOid, tr.newData);
    root.set({ 'git.edit.tree.new': built.newTree, 'git.edit.commit.new': built.newCommit, 'git.edit.commit.bytes': built.commitData.length });
    const pushed = await push(t, { ref: s.ref, oldOid: s.create ? ZERO_OID : oldCommit, newOid: built.newCommit, objects: built.objects });
    // report-status is the only receipt git offers, and a middlebox can forge it. verify: re-read the ref (one ~100 B
    // roundtrip) and require it to be our commit; a mismatch is 'ambiguous' (the push was acknowledged but not observed).
    if (verify) await verifyRef(t, root, 'git.edit', s.ref, built.newCommit);
    return outcome('ok', summarize({ oldCommit, commit, blob, hint, attempt, newCommit: built.newCommit, newTree: built.newTree, trees: built.trees, pushBytes: pushed.packBytes }), { 'git.edit.push.bytes': pushed.packBytes, 'git.edit.push.ratio': pushed.packBytes / Math.max(1, blob.newLen) });
    } catch (e) { if (e && typeof e === 'object') { e.attempt = attempt; e.hint = hint; } throw e; }
  });
}

// Effect: stream one blob through inflate → scan → sha, never holding it. Returns the new blob's identity and delta.
// A Git LFS pointer is what the repository stores for an LFS-tracked file; the real content lives in the LFS store.
// Editing the pointer as if it were the file corrupts the pointer (and git-lfs then refuses the whole checkout). The
// pointer announces itself in its first bytes, which we are streaming anyway, so the guard costs nothing.
const LFS_MAGIC = te.encode('version https://git-lfs.github.com/spec/v1');
export const isLfsPointerPrefix = bytes => { const n = Math.min(bytes.length, LFS_MAGIC.length); for (let i = 0; i < n; i++) if (bytes[i] !== LFS_MAGIC[i]) return false; return n === LFS_MAGIC.length; };

async function streamBlobEdit({ t, tracer, root, blobOid, find, replace, allowLfsPointer = false }) {
  return tracer.span('git.edit.blob', { parent: root, attrs: { 'git.edit.blob.oid': blobOid } }, async span => {
    const fetchSpan = tracer.start('git.upload-pack fetch', { parent: span, kind: KIND.CLIENT });
    let sp = spInit(), scan = scanInit({ find, replace }), newLen = null, sha = null, inflated = 0, cpuMs = 0;
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    const pump = (async () => {
      try {
        for await (const chunk of packStream(t, { wants: [blobOid] }, fetchSpan)) {
          const r = spStep(sp, chunk); sp = r.state;
          for (const z of r.zlib) await writer.write(z);
        }
        sp = spFinish(sp);
        await writer.close();
        fetchSpan.end();
      } catch (e) { fetchSpan.error(e).end(); await writer.abort(e).catch(() => {}); throw e; }
    })();
    const partial = () => span.set({ 'git.edit.blob.base_len': sp.size, 'git.edit.blob.new_len': newLen ?? -1, 'git.edit.blob.inflated': inflated, 'git.edit.blob.zlib.bytes': sp.zlibBytes, 'git.edit.blob.pack.bytes': sp.bytes, 'git.edit.blob.pack.trailer': sp.trailer ?? '', 'git.edit.blob.cpu_ms': cpuMs, ...scanAttrs(scan) });
    const begin = () => {
      if (sp.type !== TYPE.BLOB) throw fail('pack_corrupt', `expected blob, got type ${sp.type}`);
      if (sp.size < find.length) throw fail('match_count', `blob (${sp.size} bytes) is shorter than find (${find.length} bytes): expected exactly one match, found 0`, { matches: 0 });
      newLen = sp.size - find.length + replace.length; // exactly-one-match contract
      sha = streamingSha1(); span.set({ 'git.edit.blob.hasher': sha.kind });
      return sha.update(objectHeader('blob', newLen));
    };
    try {
      for await (const chunk of ds.readable) {
        // before begin(): a stream that inflates past its declared size is the server's lie (pack_corrupt), even when the
        // declared size is shorter than find (an empty blob followed by a byte used to be reported as match_count)
        inflated += chunk.length;
        if (inflated > sp.size) throw fail('pack_corrupt', `server streamed more than the ${sp.size} bytes it declared`);
        if (sha === null) {
          if (sp.phase !== 'body') throw fail('pack_corrupt', 'inflated bytes before header');
          const lfs = isLfsPointerPrefix(chunk); span.set({ 'git.edit.blob.lfs_pointer': lfs });
          if (lfs && !allowLfsPointer) throw fail('lfs_pointer', `${blobOid} is a Git LFS pointer (${sp.size} bytes); the file's content is in the LFS store, not in git. Pass allowLfsPointer to edit the pointer itself.`, { size: sp.size });
          await begin();
        }
        const c0 = cpuNow();
        const r = scanStep(scan, chunk); scan = r.state;
        for (const p of r.emit) await sha.update(p);
        const dc = cpuSince(c0); if (dc !== null) cpuMs += dc;
      }
      await pump;
    } catch (e) {
      await pump.catch(() => {});
      partial();
      if (!isPlyCode(e?.code)) throw fail('pack_corrupt', `blob stream: ${e?.message ?? e}`, { cause: e });
      throw e;
    }
    if (sha === null) { try { await begin(); } catch (e) { partial(); throw e; } } // empty blob
    const fin = scanFinish(scan); scan = fin.state; for (const p of fin.emit) await sha.update(p);
    partial();
    if (inflated !== sp.size) throw fail('pack_corrupt', `inflated ${inflated} != header size ${sp.size}`);
    if (scan.count !== 1) throw fail('match_count', `expected exactly one match, found ${scan.count}`, { matches: scan.count });
    if (scan.emitted !== newLen) throw fail('internal', `emitted ${scan.emitted} != ${newLen}`);
    const newOid = await sha.hex();
    const { delta, ops } = spliceDelta({ baseLen: sp.size, off: scan.matches[0], oldLen: find.length, insert: replace });
    span.set({ 'git.edit.blob.new': newOid, 'git.edit.blob.match_offset': scan.matches[0], 'git.edit.blob.delta.bytes': delta.length, 'git.edit.blob.delta.copy_ops': ops.copy, 'git.edit.blob.delta.insert_ops': ops.insert });
    return { oldOid: blobOid, newOid, delta, baseLen: sp.size, newLen, matchOffset: scan.matches[0], scan, inflated };
  });
}
