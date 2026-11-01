// O(1)-memory single-file edit: ls-refs → commit (tree:0, deepen 1) → one tree per level →
// streamed blob replace (never materialized) → thin push with REF_DELTAs.
// Shape: pure decisions between thin effects. Every decision (validateSpec, decideHead, lookupEntry, buildCommitObjects,
// memFromScan, summarize) is a function of its arguments; the effects (lsRefs, fetchObject, packStream, push) are free
// functions over a transport record, imported individually so a bundle of this file carries nothing else.
/* oxlint-disable import/max-dependencies -- an entry composes the protocol from one import per module, so its bundle carries nothing else */
import { thrown as fail, isPlyCode } from './errors.js';
import type { Extra, Miss } from './errors.js';
import { operation, verifyRef } from './operation.js';
import { lsRefs } from './lsrefs.js';
import { packStream, fetchObject, spInit, spStep, spFinish } from './fetch.js';
import { push, ZERO_OID } from './push.js';
import { spliceDelta } from './pack.js';
import { parseCommit, parseTree, treeReplaceOid, hashObject, encodeCommit, ident, objectHeader, TYPE } from './objects.js';
import { fromHex, streamingSha1 } from './sha1.js';
import { te, bufferSource, concat, indexOfBytes, bytesOf } from './bytes.js';
import { KIND, cpuNow, cpuSince } from './otel.js';
import type { Attrs, Span, Tracer } from './otel.js';
import { DEFAULT_LIMITS } from './limits.js';
import type { Limits } from './limits.js';
import { validateIdent, isValidatedIdent, validateRef, validatePushRef, validatePath, validateMessage } from './validate.js';
import { parseCommitId } from './oid.js';
import { signCommit } from './sign.js';
import type { OperationOpts } from './operation.js';
import type { FetchedObject as Fetched, SpState } from './fetch.js';
import type { PackObject } from './push.js';
import type { Signer } from './sign.js';
import type { Transport } from './transport.js';
import type { TreeEntry } from './objects.js';
import { thrownAttrs, thrownCode, thrownMessage } from './boundary.js';
import type { EntryOptions } from './boundary.js';

/* oxlint-disable no-await-in-loop -- a stream is consumed in order: each write waits for the inflate side (back-pressure) */
/* oxlint-disable unicorn/explicit-length-check, require-unicode-regexp -- bundle budget: the JS's truthy length checks and non-unicode regexes, byte for byte (no behaviour change) */

export { spInit, spStep, spFinish }; // the single-object pack parser lives in fetch.js; re-exported for callers of old paths

// A caller's identity, before validateIdent. `time` overrides the spec's `time` for this person; omitted uses the spec's.
export type Author = { readonly name: string; readonly email: string; readonly tz?: string; readonly time?: number };
// A validated identity (validate.js validateIdent): frozen, branded, the only input ident() accepts.
export type Ident = ReturnType<typeof validateIdent>;

// ---- streaming find/replace scanner (pure step) ----
// Emits transformed bytes; counts matches and records the first MATCH_OFFSETS_KEPT offsets. Carry ≤ |find|-1 bytes.
// The contract is exactly one match, so offsets past the first few decide nothing: `count` is the outcome, `matches`
// is evidence for the span. Keeping every offset (a fresh array per hit) made a one-byte find over a 128 KiB run of that
// byte O(matches²): 400 s (#13). Now each hit costs O(1).
export const MATCH_OFFSETS_KEPT = 16;
export type ScanState = {
  readonly find: Uint8Array;
  readonly replace: Uint8Array;
  readonly carry: Uint8Array;
  readonly base: number;
  readonly matches: readonly number[];
  readonly count: number;
  readonly emitted: number;
  readonly chunks: number;
  readonly maxChunk: number;
};
export type ScanOut = { readonly emit: Uint8Array[]; readonly state: ScanState };
export const scanInit = ({ find, replace }: { readonly find: Uint8Array; readonly replace: Uint8Array }): ScanState => Object.freeze({ find, replace, carry: new Uint8Array(0), base: 0, matches: [], count: 0, emitted: 0, chunks: 0, maxChunk: 0 });
export function scanStep(st: ScanState, chunk: Uint8Array): ScanOut {
  const data = st.carry.length ? concat([st.carry, chunk]) : chunk;
  const emit: Uint8Array[] = [];
  const matches = [...st.matches];
  let count = st.count;
  let emitted = st.emitted;
  let p = 0;
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
export function scanFinish(st: ScanState): ScanOut {
  const emit = st.carry.length ? [st.carry] : [];
  return { emit, state: { ...st, carry: new Uint8Array(0), emitted: st.emitted + st.carry.length } };
}
export const scanAttrs = (st: ScanState): Attrs => ({
  'git.edit.blob.scan.chunks': st.chunks, 'git.edit.blob.scan.chunk.max': st.maxChunk, 'git.edit.blob.scan.matches': st.count,
  'git.edit.blob.scan.match_offsets': st.matches, 'git.edit.blob.scan.emitted': st.emitted,
});

// ---- the pipeline ----

const OID = /^[0-9a-f]{40}$/;

export type EditSpec = {
  readonly ref?: string;
  readonly base?: string;
  readonly path: string;
  readonly find: string | Uint8Array;
  readonly replace: string | Uint8Array;
  readonly author: Author;
  readonly committer?: Author | null;
  readonly message: string;
  readonly time?: number;
};
export type EditPlan = {
  readonly ref: string;
  readonly base: string;
  readonly baseOid: boolean;
  readonly create: boolean;
  readonly path: string;
  readonly comps: readonly string[];
  readonly find: Uint8Array;
  readonly replace: Uint8Array;
  readonly author: Ident;
  readonly committer: Ident;
  readonly message: string;
  readonly time: number;
  readonly head: string | null;
};
const HEX40 = /^[0-9a-fA-F]{40}$/u;
// Pure: everything the caller controls, checked before any I/O. None of these strings can be escaped once inside git.
// `base`: the ref whose head the commit is built on (default: `ref` itself), or a 40-hex commit id. With a ref base ≠ ref
// the push *creates* `ref` (old oid = zeros). A commit id is that parent; the ref is created only when it is absent,
// and when it exists the id must be its tip (refuseRebase). The zero id is not a commit (parseCommitId, before any I/O).
function resolvedBase(base: string): { readonly base: string; readonly oid: boolean } {
  if (!HEX40.test(base)) return { base: validateRef(base), oid: false };
  const id = parseCommitId(base);
  if (!id.ok) throw id.error;
  return { base: id.value, oid: true };
}
export function validateSpec({ ref = 'refs/heads/main', base = ref, path, find: findIn, replace: replaceIn, author, committer = null, message, time = Math.floor(Date.now() / 1000) }: EditSpec, limits: Limits, head: string | null = null): EditPlan {
  validatePushRef(ref, false);
  const parsed = resolvedBase(base);
  const resolved = parsed.base;
  const baseIsOid = parsed.oid;
  const stamp = author?.time ?? time;
  const person = validateIdent({ name: author?.name, email: author?.email, time: stamp, tz: author?.tz });
  const written = committer === undefined || committer === null ? person : validateIdent({ name: committer.name, email: committer.email, time: committer.time ?? stamp, tz: committer.tz });
  validateMessage(message);
  const comps = validatePath(path, limits);
  const find: unknown = bytesOf(findIn), replace: unknown = bytesOf(replaceIn);
  if (!(find instanceof Uint8Array) || !(replace instanceof Uint8Array)) throw fail('bad_request', 'find/replace must be string or Uint8Array');
  if (!find.length) throw fail('bad_request', 'find must be non-empty');
  if (head !== null && !OID.test(head)) throw fail('bad_request', 'head must be a 40-hex oid');
  return Object.freeze({ ref, base: resolved, baseOid: baseIsOid, create: !baseIsOid && resolved !== ref, path, comps, find, replace, author: person, committer: written, message, time: person.time, head });
}

// The ref exists and the caller named a commit that is not its tip. Committing there would move the ref off its
// history. A new ref is how that commit is published. Not inside editOnce: that function's fail sites belong to the
// merged `edges` space.
export function refuseRebase(ref: string, base: string, tip: string): never {
  throw fail('bad_request', `base ${base} is not the tip of ${ref} (${tip}); omit base to commit on the tip, or name a new ref to start from that commit`, { what: 'rebase' });
}

// Pure: which oid is the parent, and what the hint turned out to be. ls-refs always wins; the hint only decides
// whether the speculative commit fetch was useful ('used') or wasted ('stale').
export type HintOutcome = 'used' | 'stale';
export type HeadDecision<R> = { readonly oldCommit: R; readonly hint: HintOutcome | null };
export function decideHead<R extends string | null>({ hint, resolved }: { readonly hint: string | null; readonly resolved: R }): HeadDecision<R> {
  if (hint === null) return { oldCommit: resolved, hint: null };
  return { oldCommit: resolved, hint: hint === resolved ? 'used' : 'stale' };
}

// Pure: one path component against one tree's entries.
export function lookupEntry(data: Uint8Array, name: string, last: boolean, limits: Limits): { readonly entry: TreeEntry; readonly attrs: Attrs } {
  const entries: readonly TreeEntry[] = parseTree(data, limits);
  const entry = entries.find(e => e.name === name);
  const attrs = { 'git.edit.tree.bytes': data.length, 'git.edit.tree.entries': entries.length, 'git.edit.tree.entry.found': !!entry, 'git.edit.tree.entry.mode': entry?.mode ?? '', 'git.edit.tree.entry.oid': entry?.oid ?? '', 'git.edit.tree.entry.oid_offset': entry?.oidOffset ?? -1 };
  if (!entry) throw fail('not_found', `path component ${name} not found`, { attrs, miss: { kind: 'path', missing: name, existingPath: '' } });
  if (!last && entry.mode !== '40000') throw fail('not_found', `${name} is not a directory`, { attrs, miss: { kind: 'not_directory', path: name, mode: entry.mode } });
  if (last && !(entry.mode === '100644' || entry.mode === '100755')) {
    let miss: Miss;
    if (entry.mode === '40000') miss = { kind: 'is_directory', path: name, tree: entry.oid };
    else if (entry.mode === '160000') miss = { kind: 'submodule', path: name, commit: entry.oid };
    else miss = { kind: 'not_directory', path: name, mode: entry.mode };
    throw fail('not_found', `${name} is not a regular file (mode ${entry.mode})`, { attrs, miss });
  }
  return { entry, attrs };
}

export type Level = { readonly treeOid: string; readonly data: Uint8Array; readonly entry: TreeEntry };
// The blob side of an edit, as streamBlobEdit returns it.
export type BlobEdit = {
  readonly oldOid: string;
  readonly newOid: string;
  readonly delta: Uint8Array;
  readonly baseLen: number;
  readonly newLen: number;
  readonly matchOffset: number | undefined;
  readonly scan: ScanState;
  readonly inflated: number;
};
export type NewTree = { readonly type: number; readonly data: Uint8Array; readonly baseOid: string; readonly newOid: string; readonly newData: Uint8Array };
export type Built = {
  readonly trees: readonly NewTree[];
  readonly newTree: string;
  readonly commitData: Uint8Array;
  readonly newCommit: string;
  readonly objects: readonly PackObject[];
};
// Pure: the new trees (bottom-up splices), the commit, and the thin pack's object list.
function identLine(person: Author | Ident, time: number): string {
  if (isValidatedIdent(person)) return ident(person);
  return ident(validateIdent({ name: person.name, email: person.email, time: person.time ?? time, tz: person.tz }));
}
export function buildCommitObjects({ levels, blob, oldCommit, author, committer, time, message }: {
  readonly levels: readonly Level[];
  readonly blob: Pick<BlobEdit, 'oldOid' | 'newOid' | 'delta' | 'newLen'>;
  readonly oldCommit: string;
  readonly author: Author | Ident;
  readonly committer?: Author | Ident;
  readonly time: number;
  readonly message: string;
}): Built {
  const trees: NewTree[] = [];
  let child = blob.newOid;
  // from the deepest level up: each level's entry gets the oid of the tree (or blob) below it
  for (const { treeOid: oldOid, data, entry } of levels.toReversed()) {
    const newData: Uint8Array = treeReplaceOid(data, entry, child);
    const newOid = hashObject('tree', newData);
    const delta = spliceDelta({ baseLen: data.length, off: entry.oidOffset, oldLen: 20, insert: fromHex(child) }).delta;
    trees.unshift({ type: TYPE.TREE, data: delta, baseOid: oldOid, newOid, newData });
    child = newOid;
  }
  const who = identLine(author, time);
  const written = committer === undefined ? who : identLine(committer, time);
  // oxlint-disable-next-line prefer-template -- bundle budget: the JS's concatenation
  const commitData = encodeCommit({ tree: child, parents: [oldCommit], author: who, committer: written, message: message.endsWith('\n') ? message : message + '\n' });
  const newCommit = hashObject('commit', commitData);
  const objects: PackObject[] = [
    { type: TYPE.COMMIT, data: commitData },
    ...trees.map(t => ({ type: t.type, data: t.data, baseOid: t.baseOid })),
    // git's patch_delta rejects deltas < DELTA_SIZE_MIN (4 bytes); an empty result is such a delta → send the full object
    blob.delta.length >= 4 ? { type: TYPE.BLOB, data: blob.delta, baseOid: blob.oldOid } : { type: TYPE.BLOB, data: new Uint8Array(blob.newLen) },
  ];
  return { trees, newTree: child, commitData, newCommit, objects };
}

// Pure: the same build with a different commit object (e.g. the signed one): identity and pack entry follow the bytes.
export function withCommitData(built: Built, commitData: Uint8Array): Built {
  const newCommit = hashObject('commit', commitData);
  return { ...built, commitData, newCommit, objects: [{ type: TYPE.COMMIT, data: commitData }, ...built.objects.slice(1)] };
}

// Pure: memory accounting for the whole edit, from what was actually held: each metadata object (whole, bounded by
// limits.maxObjectSize) and the streamed blob's chunks (DecompressionStream's; counted from the scanner's state).
type Held = Pick<ScanState, 'chunks' | 'maxChunk'>;
export const memFromScan = (scan: Held, inflated: number): Attrs => ({ 'mem.alloc.inflate_chunk.bytes': inflated, 'mem.alloc.inflate_chunk.count': scan.chunks, 'mem.alloc.inflate_chunk.max_single': scan.maxChunk });
export const memAttrs = ({ objects, scan, inflated }: { readonly objects: readonly number[]; readonly scan: Held; readonly inflated: number }): Attrs => ({
  'mem.alloc.bytes': objects.reduce((n, o) => n + o, 0) + inflated, 'mem.alloc.count': objects.length + scan.chunks, 'mem.alloc.max_single': Math.max(0, ...objects, scan.maxChunk),
  'mem.alloc.object.bytes': objects.reduce((n, o) => n + o, 0), 'mem.alloc.object.count': objects.length, ...memFromScan(scan, inflated),
});

export type EditResult = {
  readonly noop: boolean;
  readonly oldCommit: string;
  readonly newCommit: string;
  readonly oldTree: string;
  readonly newTree: string;
  readonly oldBlob: string;
  readonly newBlob: string;
  readonly matchOffset: number | undefined;
  readonly baseLen: number;
  readonly newLen: number;
  readonly pushBytes: number;
  readonly trees: ReadonlyArray<{ readonly old: string; readonly new: string }>;
  readonly hint: HintOutcome | null;
  readonly attempt: number;
};
// Pure: the result record.
const summarize = ({ oldCommit, commit, blob, hint, attempt, newCommit = oldCommit, newTree = commit.tree, trees = [], pushBytes = 0, noop = false }: {
  readonly oldCommit: string;
  readonly commit: { readonly tree: string };
  readonly blob: BlobEdit;
  readonly hint: HintOutcome | null;
  readonly attempt: number;
  readonly newCommit?: string;
  readonly newTree?: string;
  readonly trees?: readonly NewTree[];
  readonly pushBytes?: number;
  readonly noop?: boolean;
}): EditResult =>
  ({ noop, oldCommit, newCommit, oldTree: commit.tree, newTree, oldBlob: blob.oldOid, newBlob: blob.newOid, matchOffset: blob.matchOffset, baseLen: blob.baseLen, newLen: blob.newLen, pushBytes, trees: trees.map(t => ({ old: t.baseOid, new: t.newOid })), hint, attempt });

// The options operation() reads pass through (tracer, auth, fetchImpl, limits, transport, …); these are the edit's own.
export type EditOptions = EntryOptions & {
  readonly head?: string | null;
  readonly strictHead?: boolean;
  readonly cache?: Map<string, Uint8Array>;
  readonly verify?: boolean;
  readonly allowLfsPointer?: boolean;
  readonly signer?: Signer | null;
  readonly retry?: boolean;
};
// What operation() and the attempt loop attach to an error on its way out: the root span, the attempt, the hint.
type Tagged = { code?: unknown; span?: Span; attempt?: number; hint?: HintOutcome | null };
type Attempt = { readonly head: string | null; readonly attempt: number; readonly linkTo: Span | null; readonly hintWas?: HintOutcome | null };

// Effect: stream one blob through inflate → scan → sha, never holding it. Returns the new blob's identity and delta.
// A Git LFS pointer is what the repository stores for an LFS-tracked file; the real content lives in the LFS store.
// Editing the pointer as if it were the file corrupts the pointer (and git-lfs then refuses the whole checkout). The
// pointer announces itself in its first bytes, which we are streaming anyway, so the guard costs nothing.
type Hasher = ReturnType<typeof streamingSha1>;
const LFS_MAGIC = te.encode('version https://git-lfs.github.com/spec/v1');
export const isLfsPointerPrefix = (bytes: Uint8Array): boolean => { const n = Math.min(bytes.length, LFS_MAGIC.length); for (let i = 0; i < n; i++) if (bytes[i] !== LFS_MAGIC[i]) return false; return n === LFS_MAGIC.length; };

// oxlint-disable-next-line require-await -- async, as before: a throw while starting the span is a rejection
async function streamBlobEdit({ t, tracer, root, blobOid, find, replace, allowLfsPointer = false }: {
  readonly t: Transport;
  readonly tracer: Tracer;
  readonly root: Span;
  readonly blobOid: string;
  readonly find: Uint8Array;
  readonly replace: Uint8Array;
  readonly allowLfsPointer?: boolean;
}): Promise<BlobEdit> {
  return tracer.span('git.edit.blob', { parent: root, attrs: { 'git.edit.blob.oid': blobOid } }, async span => {
    const fetchSpan = tracer.start('git.upload-pack fetch', { parent: span, kind: KIND.CLIENT });
    let sp: SpState = spInit();
    let scan = scanInit({ find, replace });
    let newLen: number | null = null;
    let sha: Hasher | null = null;
    let inflated = 0;
    let cpuMs = 0;
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    const pump = (async () => {
      try {
        for await (const chunk of packStream(t, { wants: [blobOid] }, fetchSpan)) {
          const r = spStep(sp, chunk); sp = r.state;
          for (const z of r.zlib) await writer.write(bufferSource(z));
        }
        sp = spFinish(sp);
        await writer.close();
        fetchSpan.end();
      } catch (e) { fetchSpan.error(e).end(); await writer.abort(e).catch(() => { /* the stream is already failing */ }); throw e; }
    })();
    const partial = (): Span => span.set({ 'git.edit.blob.base_len': sp.size, 'git.edit.blob.new_len': newLen ?? -1, 'git.edit.blob.inflated': inflated, 'git.edit.blob.zlib.bytes': sp.zlibBytes, 'git.edit.blob.pack.bytes': sp.bytes, 'git.edit.blob.pack.trailer': sp.trailer ?? '', 'git.edit.blob.cpu_ms': cpuMs, ...scanAttrs(scan) });
    // the hasher, once the declared size is known and checked: it has hashed the object header
    const begin = async (): Promise<Hasher> => {
      if (sp.type !== TYPE.BLOB) throw fail('pack_corrupt', `expected blob, got type ${sp.type}`);
      if (sp.size < find.length) throw fail('match_count', `blob (${sp.size} bytes) is shorter than find (${find.length} bytes): expected exactly one match, found 0`, { matches: 0 });
      newLen = sp.size - find.length + replace.length; // exactly-one-match contract
      const h = streamingSha1(); span.set({ 'git.edit.blob.hasher': h.kind });
      await h.update(objectHeader('blob', newLen));
      return h;
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
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the pointer's size rides as an ad-hoc field (errors.ts Extra), as fetch.ts's size does
          if (lfs && !allowLfsPointer) throw fail('lfs_pointer', `${blobOid} is a Git LFS pointer (${sp.size} bytes); the file's content is in the LFS store, not in git. Pass allowLfsPointer to edit the pointer itself.`, { size: sp.size } as Extra);
          sha = await begin();
        }
        const c0 = cpuNow();
        const r = scanStep(scan, chunk); scan = r.state;
        for (const p of r.emit) await sha.update(p);
        const dc = cpuSince(c0); if (dc !== null) cpuMs += dc;
      }
      await pump;
    } catch (e) {
      await pump.catch(() => { /* the read side's error is the one reported */ });
      partial();
      if (!isPlyCode(thrownCode(e))) throw fail('pack_corrupt', `blob stream: ${String(thrownMessage(e) ?? e)}`, { cause: e });
      throw e;
    }
    if (sha === null) { try { sha = await begin(); } catch (e) { partial(); throw e; } } // empty blob
    const fin = scanFinish(scan); scan = fin.state; for (const p of fin.emit) await sha.update(p);
    partial();
    if (inflated !== sp.size) throw fail('pack_corrupt', `inflated ${inflated} != header size ${sp.size}`);
    if (scan.count !== 1) throw fail('match_count', `expected exactly one match, found ${scan.count}`, { matches: scan.count });
    if (scan.emitted !== newLen) throw fail('internal', `emitted ${scan.emitted} != ${newLen}`);
    const newOid = await sha.hex();
    // exactly one match (checked above), so matches[0] is its offset
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- see above (and no `!`: docs/STACK.md)
    const { delta, ops } = spliceDelta({ baseLen: sp.size, off: scan.matches[0] as number, oldLen: find.length, insert: replace });
    span.set({ 'git.edit.blob.new': newOid, 'git.edit.blob.match_offset': scan.matches[0], 'git.edit.blob.delta.bytes': delta.length, 'git.edit.blob.delta.copy_ops': ops.copy, 'git.edit.blob.delta.insert_ops': ops.insert });
    return { oldOid: blobOid, newOid, delta, baseLen: sp.size, newLen, matchOffset: scan.matches[0], scan, inflated };
  });
}

// oxlint-disable-next-line require-await -- async: a synchronous throw (validateSpec) is a rejection, which editFile's .catch sees
async function editOnce(url: string, spec: EditSpec, { cache = new Map<string, Uint8Array>(), verify = false, allowLfsPointer = false, signer = null, fetchImpl, strictHead = false, ...opts }: Omit<EditOptions, 'head'> = {}, { head, attempt, linkTo, hintWas = null }: Attempt): Promise<EditResult> {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const s = validateSpec(spec, limits, head);
  const held: number[] = []; // sizes of metadata objects held whole, for memAttrs
  let streamed: { readonly scan: Held; readonly inflated: number } = { scan: { chunks: 0, maxChunk: 0 }, inflated: 0 };
  let hint = hintWas;
  let creating = s.create;
  const attrs = { 'git.edit.ref': s.ref, 'git.edit.base': s.base, 'git.edit.create': s.create, 'git.edit.path': s.path, 'git.edit.path.depth': s.comps.length, 'git.edit.find.bytes': s.find.length, 'git.edit.replace.bytes': s.replace.length, 'git.edit.head.hint': head ?? '', 'git.edit.attempt': attempt };
  // on every exit: how the hint turned out, what was held in memory, and the pack cache's counters if the fetch has them
  const onFinish = (): Attrs => ({ 'git.edit.head.outcome': hint ?? '', ...memAttrs({ objects: held, ...streamed }), ...(fetchImpl?.attrs ? fetchImpl.attrs() : {}) });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the options' tracer, required at run time: EntryOptions (boundary.ts)
  return operation('edit', url, ({ ...opts, fetchImpl, attrs, onFinish, link: linkTo ? { span: linkTo, kind: 'retry_of' } : null } as OperationOpts), async ({ t, root, outcome }) => {
    // the tracer operation() started the root span on (opts.tracer)
    const tracer = root.tracer;
    const getObject = async (oid: string, expectType: number, deepen?: number): Promise<Fetched> => { const o = await fetchObject(t, { oid, filter: 'tree:0', deepen, expectType }); held.push(o.size); return o; };
    try {
    // 1+2. parent commit: ls-refs, overlapped with a speculative fetch of the hinted commit when there is a hint.
    // A ref base keeps the original chain. A 40-hex base is that commit; the ref is listed, and a tip that is some
    // other commit is refuseRebase (the ref is not moved off its tip). A missing ref is not_found with miss.kind 'ref'.
    const resolve = async (): Promise<string> => {
      if (s.baseOid) {
        const { refs } = await lsRefs(t, [s.ref]);
        const tip = refs.get(s.ref)?.oid ?? null;
        if (tip !== null && tip !== s.base) refuseRebase(s.ref, s.base, tip);
        creating = tip === null;
        return s.base;
      }
      const { refs } = await lsRefs(t, [s.base]);
      const found = refs.get(s.base);
      if (!found) throw fail('not_found', `ref ${s.base} not found`, { miss: { kind: 'ref', ref: s.base, candidates: [s.base] } });
      return found.oid;
    };
    // oxlint-disable-next-line typescript/strict-boolean-expressions -- bundle budget: the JS's own truthy test, byte for byte (head is null or a checked oid)
    const [resolved, speculative] = await Promise.all([resolve(), head ? getObject(head, TYPE.COMMIT, 1).then(o => o, (e: unknown) => e) : null]);
    root.set({ 'git.edit.create': creating });
    const decided = decideHead({ hint: head, resolved });
    hint = hintWas ?? decided.hint;
    const { oldCommit } = decided;
    if (strictHead && decided.hint === 'stale') throw fail('cas_conflict', `${s.base} is at ${oldCommit}, not the expected head ${head}`, { expected: head, actual: oldCommit });
    if (speculative instanceof Error) root.set({ 'git.edit.head.speculative_error': thrownCode(speculative) ?? 'error' });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a fulfilled speculative fetch is getObject's value (the rejection branch is the Error above)
    const commitObj = decided.hint === 'used' && !(speculative instanceof Error) ? speculative as Fetched : await getObject(oldCommit, TYPE.COMMIT, 1);
    const commit: { readonly tree: string; readonly parents: readonly string[] } = parseCommit(commitObj.data, limits);
    root.set({ 'git.edit.commit.old': oldCommit, 'git.edit.tree.root': commit.tree, 'git.edit.commit.old.parents': commit.parents.length });

    // 3. trees, one per level. Effect: fetch on cache miss; decision: lookupEntry.
    const levels: Level[] = [];
    let cacheHits = 0;
    let treeOid = commit.tree;
    for (const [depth, name] of s.comps.entries()) {
      const last = depth === s.comps.length - 1;
      // oxlint-disable-next-line no-loop-func -- the span runs to completion inside this iteration (awaited)
      const lvl = await tracer.span('git.edit.tree', { parent: root, attrs: { 'git.edit.tree.depth': depth, 'git.edit.tree.oid': treeOid, 'git.edit.tree.lookup': name } }, async span => {
        let data = cache.get(treeOid);
        const hit = !!data;
        if (data) cacheHits++; else { data = (await getObject(treeOid, TYPE.TREE)).data; cache.set(treeOid, data); }
        span.set({ 'git.edit.tree.cache_hit': hit });
        try { const { entry, attrs: found } = lookupEntry(data, name, last, limits); span.set(found); return { treeOid, data, entry }; }
        catch (e) { const found = thrownAttrs(e); if (found) span.set(found); throw e; }
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
    let built = buildCommitObjects({ levels, blob, oldCommit, author: s.author, committer: s.committer, time: s.time, message: s.message });
    if (signer) { built = withCommitData(built, await signCommit(built.commitData, signer)); root.set({ 'git.edit.commit.signed': signer.kind, 'git.edit.commit.signer': signer.publicKeyLine ?? '' }); }
    for (const tr of built.trees) cache.set(tr.newOid, tr.newData);
    root.set({ 'git.edit.tree.new': built.newTree, 'git.edit.commit.new': built.newCommit, 'git.edit.commit.bytes': built.commitData.length });
    const pushed = await push(t, { ref: s.ref, oldOid: creating ? ZERO_OID : oldCommit, newOid: built.newCommit, objects: built.objects });
    // report-status is the only receipt git offers, and a middlebox can forge it. verify: re-read the ref (one ~100 B
    // roundtrip) and require it to be our commit; a mismatch is 'ambiguous' (the push was acknowledged but not observed).
    if (verify) await verifyRef(t, root, 'git.edit', s.ref, built.newCommit);
    return outcome('ok', summarize({ oldCommit, commit, blob, hint, attempt, newCommit: built.newCommit, newTree: built.newTree, trees: built.trees, pushBytes: pushed.packBytes }), { 'git.edit.push.bytes': pushed.packBytes, 'git.edit.push.ratio': pushed.packBytes / Math.max(1, blob.newLen) });
    // oxlint-disable-next-line typescript/strict-boolean-expressions, typescript/no-unsafe-type-assertion -- bundle budget: the JS's own test, byte for byte; a thrown object gets the attempt's fields, as before
    } catch (e) { if (e && typeof e === 'object') { (e as Tagged).attempt = attempt; (e as Tagged).hint = hint; } throw e; }
  });
}

// `head`: an oid the caller believes `ref` points at (e.g. its last newCommit). ls-refs and the hinted commit fetch run
// concurrently; a stale hint is corrected before anything is pushed (same wall time as skipping ls-refs, one more
// request, no wasted push). A cas_conflict on attempt 0 (replica lag: ls-refs and receive-pack disagreed) is redone
// once; the retry's root span links to the first attempt's.
// `strictHead: true` turns the hint into a precondition: if `ref` is not at `head`, the edit is a `cas_conflict` before
// anything is pushed, and it is not retried (the caller asked for exactly that parent).
// `retry: false` is the caller's own race handling (commitChanges): attempt 0's cas_conflict is not redone here.
// An Error carries the attempt's tag (attempt, hint, the root span). A string or a plain object does not, and it is not
// a result: resolving with it reported success for a failed first attempt.
const isAttemptError = (e: unknown): e is Error & Tagged => e instanceof Error;

export async function editFile(url: string, spec: EditSpec, { head = null, strictHead = false, retry = true, ...opts }: EditOptions = {}): Promise<EditResult> {
  if (strictHead && head === null) throw fail('bad_request', 'strictHead needs head');
  try {
    return await editOnce(url, spec, { ...opts, strictHead }, { head, attempt: 0, linkTo: null });
  } catch (e) {
    // only a real Error is a cas_conflict that can be retried; anything else is the caller's throw, unchanged.
    // the retry is not inside this try, so a second cas_conflict propagates (attempt 0 is the only one caught)
    if (!retry || !isAttemptError(e) || e.code !== 'cas_conflict' || strictHead) throw e;
    return editOnce(url, spec, opts, { head: null, attempt: 1, linkTo: e.span ?? null, hintWas: e.hint ?? null });
  }
}
