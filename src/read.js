// Read one file or one directory listing from a remote, without a clone: ls-refs → the commit (tree:0, deepen 1) → one
// tree per path level → the blob, STREAMED (inflate → SHA-1 check → caller) and never held. Built from the same
// primitives as edit.js; carries no push, merge or pack-building code (asserted by test/bundle.test.js).
//
//   readFile(url, { ref, path }, opts) → { ref, commit, blob, mode, size, stream }    stream: ReadableStream<Uint8Array>
//   listTree(url, { ref, path }, opts) → { ref, commit, tree, entries: [{ name, mode, oid, type }] }
//   readCommit(url, { ref }, opts) → { ref, oid, tree, parents, author, committer, message, signed }   (no trees fetched
//                                    unless the server refuses tree:0; then the blob:none fallback applies)
//
// `ref`: null/'HEAD' (the remote's HEAD), a full ref name, a short name resolved the way `git rev-parse` does it for a
// remote's refs (refs/<n>, refs/tags/<n>, refs/heads/<n> — tags win over branches, as in git), or a 40-hex commit oid.
// Annotated tags are peeled. `size` is known before the first content byte (the pack object header carries it), so a
// caller can send Content-Length. The stream errors (never ends cleanly) if the content does not hash to the blob's oid
// or the server sends a different number of bytes than it declared: a consumer that saw `done` saw the right bytes.
import { fail, isPlyCode } from './errors.js';
import { operation } from './operation.js';
import { lsRefs } from './lsrefs.js';
import { packStream, fetchObject, spInit, spStep, spFinish } from './fetch.js';
import { parseCommit, parseIdent, parseTree, objectHeader, TYPE, TYPE_NAME } from './objects.js';
import { streamingSha1 } from './sha1.js';
import { KIND } from './otel.js';
import { DEFAULT_LIMITS } from './limits.js';
import { validateRef, validatePath } from './validate.js';

const OID = /^[0-9a-f]{40}$/;

// Pure: what to ask ls-refs for, and which answer wins. git's ref_rev_parse_rules minus the remote-tracking forms.
export function refCandidates(ref) {
  if (ref === null || ref === undefined || ref === '' || ref === 'HEAD') return ['HEAD'];
  if (typeof ref !== 'string') throw fail('bad_request', 'ref must be a string');
  if (OID.test(ref)) return [];
  if (ref.startsWith('refs/')) return [validateRef(ref)];
  return [`refs/${ref}`, `refs/tags/${ref}`, `refs/heads/${ref}`].map(r => validateRef(r));
}

// Pure: git ls-tree's type for a tree entry mode.
export const entryType = mode => (mode === '40000' ? 'tree' : mode === '160000' ? 'commit' : 'blob');
// Pure: git ls-tree prints modes as %06o (trees as 040000); the tree object stores them without the leading zero.
export const lsMode = mode => mode.padStart(6, '0');

// Effect: ref → { name, commit } (annotated tags peeled; a bare oid is taken as given and checked by the commit fetch).
export async function resolveCommit(t, ref) {
  const cands = refCandidates(ref);
  if (!cands.length) return { name: ref, commit: ref };
  const { refs, head } = await lsRefs(t, cands);
  for (const name of cands) {
    const r = refs.get(name);
    if (r) return { name: name === 'HEAD' ? (head ?? 'HEAD') : name, commit: r.peeled ?? r.oid };
  }
  throw fail('not_found', cands[0] === 'HEAD' ? 'remote HEAD is unborn or absent (some hosts point HEAD at a deleted branch); pass ref explicitly' : `ref ${ref} not found`);
}

// Effect: the commit object alone (tree:0, deepen 1). A bare oid that is not a commit (or not on the server) is the
// caller's not_found, not a corrupt pack.
async function fetchCommit(t, commit) {
  const c = await fetchObject(t, { oid: commit, filter: 'tree:0', deepen: 1, expectType: TYPE.COMMIT }).catch(e => {
    if (e?.code === 'pack_corrupt' && /expected commit/.test(e.message)) throw fail('not_found', `${commit} is not a commit`);
    if (e?.code === 'remote_error' && /not our ref/.test(e.message)) throw fail('not_found', `commit ${commit} not found on the remote`);
    throw e;
  });
  return c.data;
}

// Pure: an ident for JSON. `time` is ISO-8601 UTC, `epoch` the raw seconds, `tz` the offset as written (+0530).
const identView = line => {
  const p = parseIdent(line);
  if (!p) return null;
  const epoch = p.time === null ? null : Number(p.time);
  const d = epoch === null ? null : new Date(epoch * 1000);
  return { name: p.name, email: p.email, time: d && !Number.isNaN(d.getTime()) ? d.toISOString().replace('.000Z', 'Z') : null, epoch, tz: p.tz };
};

// Pure: the JSON view of a commit object. `signed` is whether it carries a gpgsig/gpgsig-sha256 header (any format:
// OpenPGP, SSH, X.509); it says nothing about whether the signature verifies. The message is the raw body, UTF-8.
export function commitView(data, limits = DEFAULT_LIMITS) {
  const c = parseCommit(data, limits);
  return { tree: c.tree, parents: c.parents, author: identView(c.author), committer: identView(c.committer), message: c.message ?? '', signed: c.extra.some(l => /^gpgsig(-sha256)? /.test(l)) };
}

export async function readCommit(url, { ref = null } = {}, opts = {}) {
  return operation('read_commit', url, { ...opts, attrs: { 'git.read_commit.ref': ref ?? 'HEAD' } }, async ({ t, outcome }) => {
    const { name, commit } = await resolveCommit(t, ref);
    const view = commitView(await fetchCommit(t, commit), t.limits);
    return outcome('ok', { ref: name, oid: commit, ...view }, { 'git.read_commit.oid': commit, 'git.read_commit.parents': view.parents.length, 'git.read_commit.signed': view.signed });
  });
}

// Effect: walk `comps` from the commit's root tree. Returns { commit, levels, entry } where entry is the last
// component's tree entry (null for the root: comps = []).
async function walk(t, root, tracer, { commit, comps, cache, limits }) {
  const info = parseCommit(await fetchCommit(t, commit), limits);
  root.set({ 'git.read.commit': commit, 'git.read.tree.root': info.tree });
  let treeOid = info.tree, entry = null;
  for (let depth = 0; depth < comps.length; depth++) {
    const name = comps[depth];
    entry = await tracer.span('git.read.tree', { parent: root, attrs: { 'git.read.tree.depth': depth, 'git.read.tree.oid': treeOid, 'git.read.tree.lookup': name } }, async span => {
      let data = cache.get(treeOid);
      span.set({ 'git.read.tree.cache_hit': !!data });
      if (!data) { data = (await fetchObject(t, { oid: treeOid, filter: 'tree:0', expectType: TYPE.TREE })).data; cache.set(treeOid, data); }
      const entries = parseTree(data, limits);
      const e = entries.find(x => x.name === name);
      span.set({ 'git.read.tree.entries': entries.length, 'git.read.tree.entry.found': !!e, 'git.read.tree.entry.mode': e?.mode ?? '' });
      if (!e) throw fail('not_found', `path component ${name} not found`);
      if (depth < comps.length - 1 && e.mode !== '40000') throw fail('not_found', `${name} is not a directory`);
      return e;
    });
    treeOid = entry.oid;
  }
  return { tree: info.tree, entry };
}

const pathComps = (path, limits, { allowRoot }) => {
  if (allowRoot && (path === undefined || path === null || path === '' || path === '/')) return [];
  return validatePath(typeof path === 'string' ? path.replace(/\/$/, '') : path, limits);
};

export async function listTree(url, { ref = null, path = '' } = {}, { cache = new Map(), ...opts } = {}) {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const comps = pathComps(path, limits, { allowRoot: true });
  return operation('ls_tree', url, { ...opts, attrs: { 'git.ls_tree.ref': ref ?? 'HEAD', 'git.ls_tree.path': comps.join('/'), 'git.ls_tree.path.depth': comps.length } }, async ({ t, root, outcome }) => {
    const { name, commit } = await resolveCommit(t, ref);
    const { tree, entry } = await walk(t, root, opts.tracer, { commit, comps, cache, limits });
    if (entry && entry.mode !== '40000') throw fail('not_found', `${comps.join('/')} is not a directory (mode ${entry.mode})`);
    const oid = entry ? entry.oid : tree;
    let data = cache.get(oid);
    if (!data) { data = (await fetchObject(t, { oid, filter: 'tree:0', expectType: TYPE.TREE })).data; cache.set(oid, data); }
    const entries = parseTree(data, limits);
    return outcome('ok', { ref: name, commit, tree: oid, entries: entries.map(e => ({ name: e.name, mode: lsMode(e.mode), oid: e.oid, type: entryType(e.mode) })) }, { 'git.ls_tree.tree': oid, 'git.ls_tree.entries': entries.length });
  });
}

// The root span ends when the stream is open (size known); the content's own span, `git.read.blob`, ends when the
// stream does, with the bytes delivered and whether the oid verified. It outlives the root, so it is not the root's child
// but the root of its own trace, linked both ways (follows_from / followed_by): README "Span lifetimes".
export async function readFile(url, { ref = null, path } = {}, { cache = new Map(), ...opts } = {}) {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const comps = pathComps(path, limits, { allowRoot: false });
  return operation('read', url, { ...opts, attrs: { 'git.read.ref': ref ?? 'HEAD', 'git.read.path': comps.join('/'), 'git.read.path.depth': comps.length } }, async ({ t, root, outcome }) => {
    const tracer = opts.tracer;
    const { name, commit } = await resolveCommit(t, ref);
    const { entry } = await walk(t, root, tracer, { commit, comps, cache, limits });
    // a symlink's blob is its target (what `git show <ref>:<path>` prints); a gitlink has no blob in this repository
    if (entry.mode === '40000') throw fail('not_found', `${comps.join('/')} is a directory`);
    if (entry.mode === '160000') throw fail('not_found', `${comps.join('/')} is a submodule (commit ${entry.oid})`);
    const blob = await openBlob(t, tracer, root, entry.oid);
    return outcome('ok', { ref: name, commit, blob: entry.oid, mode: lsMode(entry.mode), size: blob.size, stream: blob.stream }, { 'git.read.blob': entry.oid, 'git.read.blob.size': blob.size, 'git.read.blob.mode': entry.mode });
  });
}

// Effect: one blob as a ReadableStream (also checkout.js's per-blob path). Reads the pack until the object header (→ size), then pipes the zlib bytes
// through DecompressionStream and a verifying transform. Back-pressure: the pump awaits each write, so at most one
// network chunk and one inflate chunk are in flight beyond what the consumer has taken.
// `opener` is the span the stream follows (the read root, or git.checkout.blobs): the consumer reads after it returns.
export async function openBlob(t, tracer, opener, oid) {
  const span = tracer.start('git.read.blob', { follows: opener, attrs: { 'git.read.blob.oid': oid } });
  const fetchSpan = tracer.start('git.upload-pack fetch', { parent: span, kind: KIND.CLIENT });
  const it = packStream(t, { wants: [oid] }, fetchSpan)[Symbol.asyncIterator]();
  let sp = spInit(); const early = [];
  // the first of failure, cancellation and verified end records the outcome; whatever follows (a cancel aborting the
  // pump) leaves the ended spans alone
  const failHere = e => { const err = isPlyCode(e?.code) ? e : fail('pack_corrupt', `blob stream: ${e?.message ?? e}`, { cause: e }); if (!span.ended) { fetchSpan.error(err).end(); span.error(err).set({ 'git.read.blob.outcome': err.code }).end(); } return err; };
  try {
    while (sp.phase !== 'body') {
      const { value, done } = await it.next();
      if (done) throw fail('pack_corrupt', 'pack ended before the object header');
      const r = spStep(sp, value); sp = r.state; early.push(...r.zlib);
    }
    if (sp.type !== TYPE.BLOB) throw fail('pack_corrupt', `expected blob, got ${TYPE_NAME[sp.type] ?? sp.type}`);
  } catch (e) { await it.return?.().catch(() => {}); throw failHere(e); }
  const size = sp.size;
  span.set({ 'git.read.blob.size': size });
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  const pump = (async () => {
    for (const z of early) await writer.write(z);
    for (;;) {
      const { value, done } = await it.next();
      if (done) break;
      const r = spStep(sp, value); sp = r.state;
      for (const z of r.zlib) await writer.write(z);
    }
    sp = spFinish(sp); // pack trailer checksum
    fetchSpan.end();
    await writer.close();
  })();
  // a pump failure (network, framing, trailer) aborts the inflate side, which errors the stream the consumer reads. The
  // verify transform's flush never runs then, so the failure is recorded (and both spans ended) here.
  pump.catch(async e => { const err = failHere(e); await writer.abort(err).catch(() => {}); await it.return?.().catch(() => {}); });
  const sha = streamingSha1();
  await sha.update(objectHeader('blob', size));
  let seen = 0;
  const verify = new TransformStream({
    async transform(chunk, ctl) {
      seen += chunk.length;
      if (seen > size) throw failHere(fail('pack_corrupt', `server streamed more than the ${size} bytes it declared`));
      await sha.update(chunk);
      ctl.enqueue(chunk);
    },
    async flush() {
      try { await pump; } catch (e) { throw failHere(e); }
      if (seen !== size) throw failHere(fail('pack_corrupt', `inflated ${seen} != declared ${size}`));
      const got = await sha.hex();
      if (got !== oid) throw failHere(fail('pack_corrupt', `blob content hashes to ${got}, not ${oid}`));
      span.set({ 'git.read.blob.bytes': seen, 'git.read.blob.verified': true, 'git.read.blob.hasher': sha.kind, 'git.read.blob.outcome': 'ok' }).end();
    },
  });
  // DecompressionStream's own refusals (trailing junk after the deflate end, a bad block) are platform errors with no ply
  // code; the consumer sees them as pack_corrupt like every other refusal on this path (I1: a code from the fixed set).
  // The consumer's cancel() is an outcome of its own ('cancelled', not an error): without the cancel hook a cancel after the
  // pump has written its last chunk would leave both spans open forever, and one before it would read as pack_corrupt.
  const inner = ds.readable.pipeThrough(verify).getReader();
  const stream = new ReadableStream({
    async pull(c) {
      let r;
      try { r = await inner.read(); } catch (e) { throw isPlyCode(e?.code) ? e : failHere(e); }
      if (r.done) c.close(); else c.enqueue(r.value);
    },
    async cancel(reason) {
      if (!span.ended) { fetchSpan.end(); span.set({ 'git.read.blob.bytes': seen, 'git.read.blob.outcome': 'cancelled' }).end(); }
      await inner.cancel(reason).catch(() => {});
      await it.return?.().catch(() => {});
    },
  }, { highWaterMark: 0 });
  return { size, stream };
}
// ci/fast probe 2: whole-file mutation of every src file (reverted in the next commit)
