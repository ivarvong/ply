// O(1)-memory single-file edit: ls-refs → commit (tree:0, deepen 1) → one tree per level →
// streamed blob replace (never materialized) → thin push with REF_DELTAs.
// Shape: pure decisions between thin effects. Every decision (validateSpec, decideHead, lookupEntry, buildCommitObjects,
// memFromScan, summarize) is a function of its arguments; the effects (lsRefs, fetchObject, packStream, push) are free
// functions over a transport record, imported individually so a bundle of this file carries nothing else.
// Decisions return Result. The public entries (editFile, validateSpec, lookupEntry) stay throwing until the Result cut-over
// (docs/STACK.md step 3); inside the operation the Err meets operation()'s span at one `orThrow` per step.
/* oxlint-disable import/max-dependencies -- an entry composes the protocol from one import per module, so its bundle carries nothing else */
import { fail, orThrow, isPlyError } from './errors.js';
import type { ErrorOf, Extra, Miss, PlyError } from './errors.js';
import { operation, verifyRef } from './operation.js';
import { lsRefs } from './lsrefs.js';
import { packStream, fetchObject, spInit, spStep, spFinish } from './fetch.js';
import { push, validated, ZERO_OID } from './push.js';
import { spliceDelta } from './pack.js';
import { parseCommit, parseTree, objectHeader, TYPE } from './objects.js';
import { streamingSha1 } from './sha1.js';
import { te, bufferSource, concat, indexOfBytes, bytesOf } from './bytes.js';
import { KIND, cpuNow, cpuSince } from './otel.js';
import type { Attrs, Span, StartOptions, Tracer } from './otel.js';
import { DEFAULT_LIMITS } from './limits.js';
import type { Limits } from './limits.js';
import { validateIdent, validateRef, validatePushRef, validatePath, validateMessage } from './validate.js';
import type { IdentInput } from './validate.js';
import { parseCommitId } from './oid.js';
import { signCommitResult } from './sign.js';
import type { OperationOpts } from './operation.js';
import type { FetchedObject as Fetched, SpState } from './fetch.js';
import type { PackObject } from './push.js';
import type { Signer } from './sign.js';
import type { Transport } from './transport.js';
import type { TreeEntry } from './objects.js';
import { isPlyThrown, thrownCodeIs, thrownCodeOr, thrownText } from './boundary.js';
import type { EntryOptions } from './boundary.js';
import type { Input } from './absent.js';
import { atOr, field, fromNullish, mapGet, withDefaults } from './absent.js';
import { err, getOrElse, mapOption, ok } from './result.js';
import type { Err, Result } from './result.js';
import { DEFAULT_REF } from './refname.js';
import type { Refname } from './refname.js';
import type { Path } from './path.js';
import { buildCommitObjects, withCommitData } from './commit-build.js';
import type { Author, Level as BuiltLevel, NewTree as BuiltNewTree } from './commit-build.js';

/* oxlint-disable no-await-in-loop -- a stream is consumed in order: each write waits for the inflate side (back-pressure) */
/* oxlint-disable unicorn/explicit-length-check, require-unicode-regexp -- bundle budget: the JS's truthy length checks and non-unicode regexes, byte for byte (no behaviour change) */

export { spInit, spStep, spFinish }; // the single-object pack parser lives in fetch.js; re-exported for callers of old paths
export { buildCommitObjects, withCommitData } from './commit-build.js';

// A caller's identity, before validateIdent. `time` overrides the spec's `time` for this person; omitted uses the spec's.
export type { Author };
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

// What the caller names. `ref` defaults to DEFAULT_REF; `base` (a ref or a 40-hex commit id) to `ref`; `committer` (null
// or left out) is the author; `time` to now (an author's own time wins).
export type EditSpecConfig = { readonly ref: Refname; readonly base: string | null; readonly committer: Author | null; readonly time: number | null };
export type EditSpec = Input<EditSpecConfig> & {
  readonly path: Path;
  readonly find: string | Uint8Array;
  readonly replace: string | Uint8Array;
  readonly author: Author;
  readonly message: string;
};
const specDefaults = (): { -readonly [K in keyof EditSpecConfig]: EditSpecConfig[K] } => ({ ref: DEFAULT_REF, base: null, committer: null, time: null });
export type EditPlan = {
  readonly ref: Refname;
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
function resolvedBase(base: string): Result<{ readonly base: string; readonly oid: boolean }, PlyError> {
  if (!HEX40.test(base)) {
    const ref = validated(() => validateRef(base));
    return ref.ok ? ok({ base: ref.value, oid: false }) : ref;
  }
  const id = parseCommitId(base);
  return id.ok ? ok({ base: id.value, oid: true }) : id;
}
// One person as validateIdent takes it: the time given, and the zone only when one is (UTC otherwise).
const identInput = (who: Author, time: number): IdentInput => {
  const tz = fromNullish(who.tz);
  return tz.tag === 'some' ? { name: who.name, email: who.email, time, tz: tz.value } : { name: who.name, email: who.email, time };
};
export function validateSpecResult(spec: EditSpec, limits: Limits, head: string | null = null): Result<EditPlan, PlyError> {
  const given = withDefaults(spec, specDefaults());
  // a null ref is the default too, as the JS read it
  const givenRef = getOrElse(fromNullish(given.ref), DEFAULT_REF);
  const baseIn: string = given.base === null ? givenRef : given.base;
  const author = spec.author;
  const message = spec.message;
  const atAuthorTime = fromNullish(author.time);
  const stamp = atAuthorTime.tag === 'some' ? atAuthorTime.value : getOrElse(fromNullish(given.time), Math.floor(Date.now() / 1000));
  const pushRef = validated(() => validatePushRef(givenRef, false));
  if (!pushRef.ok) return pushRef;
  // oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- a JS caller's base may be any value; String() as before
  const parsed = resolvedBase(String(baseIn));
  if (!parsed.ok) return parsed;
  const resolved = parsed.value.base;
  const baseIsOid = parsed.value.oid;
  const person = validated(() => validateIdent(identInput(author, stamp)));
  if (!person.ok) return person;
  const committer = fromNullish(given.committer);
  const written = committer.tag === 'none' ? person : validated(() => validateIdent(identInput(committer.value, getOrElse(fromNullish(committer.value.time), stamp))));
  if (!written.ok) return written;
  const checkedMessage = validated(() => validateMessage(message));
  if (!checkedMessage.ok) return checkedMessage;
  const comps = validated(() => validatePath(spec.path, limits));
  if (!comps.ok) return comps;
  const find: unknown = bytesOf(spec.find), replace: unknown = bytesOf(spec.replace);
  if (!(find instanceof Uint8Array) || !(replace instanceof Uint8Array)) return fail('bad_request', 'find/replace must be string or Uint8Array');
  if (!find.length) return fail('bad_request', 'find must be non-empty');
  if (head !== null && !OID.test(head)) return fail('bad_request', 'head must be a 40-hex oid');
  // oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- a JS caller's ref and path may be any value; String() as before
  return ok(Object.freeze({ ref: givenRef, base: resolved, baseOid: baseIsOid, create: !baseIsOid && resolved !== String(givenRef), path: String(spec.path), comps: comps.value, find, replace, author: person.value, committer: written.value, message, time: person.value.time, head }));
}
// The throwing form (a public entry) until the Result cut-over.
export const validateSpec = (spec: EditSpec, limits: Limits, head: string | null = null): EditPlan => orThrow(validateSpecResult(spec, limits, head));

// The ref exists and the caller named a commit that is not its tip. Committing there would move the ref off its
// history. A new ref is how that commit is published. Not inside editOnce: that function's fail sites belong to the
// merged `edges` space.
export function refuseRebase(ref: string, base: string, tip: string): Err<ErrorOf<'bad_request'>> {
  return fail('bad_request', `base ${base} is not the tip of ${ref} (${tip}); omit base to commit on the tip, or name a new ref to start from that commit`, { what: 'rebase' });
}

// Pure: which oid is the parent, and what the hint turned out to be. ls-refs always wins; the hint only decides
// whether the speculative commit fetch was useful ('used') or wasted ('stale').
export type HintOutcome = 'used' | 'stale';
export type HeadDecision<R> = { readonly oldCommit: R; readonly hint: HintOutcome | null };
export function decideHead<R extends string | null>({ hint, resolved }: { readonly hint: string | null; readonly resolved: R }): HeadDecision<R> {
  if (hint === null) return { oldCommit: resolved, hint: null };
  return { oldCommit: resolved, hint: hint === resolved ? 'used' : 'stale' };
}
// Pure: `strictHead` makes the hint a precondition. A stale hint is a cas_conflict before anything is pushed.
export function strictParent(strictHead: boolean, decided: HeadDecision<string | null>, base: string, head: string | null): Result<null, ErrorOf<'cas_conflict'>> {
  if (!strictHead || decided.hint !== 'stale') return ok(null);
  return fail('cas_conflict', `${base} is at ${getOrElse(fromNullish(decided.oldCommit), 'nothing')}, not the expected head ${String(head)}`, { expected: head, actual: decided.oldCommit });
}
// Pure: `strictHead` without a `head` has nothing to hold the ref to.
export function needsHead(strictHead: boolean, head: string | null): Result<null, ErrorOf<'bad_request'>> {
  return strictHead && head === null ? fail('bad_request', 'strictHead needs head') : ok(null);
}

// Pure: one path component against one tree's entries.
export type Found = { readonly entry: TreeEntry; readonly attrs: Attrs };
export function lookupEntryResult(data: Uint8Array, name: string, last: boolean, limits: Limits): Result<Found, PlyError> {
  const parsed = validated(() => parseTree(data, limits));
  if (!parsed.ok) return parsed;
  const entries: readonly TreeEntry[] = parsed.value;
  const found = fromNullish(entries.find(e => e.name === name));
  const attrs = { 'git.edit.tree.bytes': data.length, 'git.edit.tree.entries': entries.length, 'git.edit.tree.entry.found': found.tag === 'some', 'git.edit.tree.entry.mode': getOrElse(mapOption(found, e => e.mode), ''), 'git.edit.tree.entry.oid': getOrElse(mapOption(found, e => e.oid), ''), 'git.edit.tree.entry.oid_offset': getOrElse(mapOption(found, e => e.oidOffset), -1) };
  if (found.tag === 'none') return fail('not_found', `path component ${name} not found`, { attrs, miss: { kind: 'path', missing: name, existingPath: '' } });
  const entry = found.value;
  if (!last && entry.mode !== '40000') return fail('not_found', `${name} is not a directory`, { attrs, miss: { kind: 'not_directory', path: name, mode: entry.mode } });
  if (last && !(entry.mode === '100644' || entry.mode === '100755')) {
    let miss: Miss;
    if (entry.mode === '40000') miss = { kind: 'is_directory', path: name, tree: entry.oid };
    else if (entry.mode === '160000') miss = { kind: 'submodule', path: name, commit: entry.oid };
    else miss = { kind: 'not_directory', path: name, mode: entry.mode };
    return fail('not_found', `${name} is not a regular file (mode ${entry.mode})`, { attrs, miss });
  }
  return ok({ entry, attrs });
}
// The throwing form (a public entry) until the Result cut-over.
export const lookupEntry = (data: Uint8Array, name: string, last: boolean, limits: Limits): Found => orThrow(lookupEntryResult(data, name, last, limits));

export type Level = BuiltLevel;
// The blob side of an edit, as streamBlobEdit returns it.
export type BlobEdit = {
  readonly oldOid: string;
  readonly newOid: string;
  readonly delta: Uint8Array;
  readonly baseLen: number;
  readonly newLen: number;
  readonly matchOffset: number;
  readonly scan: ScanState;
  readonly inflated: number;
};
export type NewTree = BuiltNewTree;
export type Built = {
  readonly trees: readonly NewTree[];
  readonly newTree: string;
  readonly commitData: Uint8Array;
  readonly newCommit: string;
  readonly objects: readonly PackObject[];
};
// buildCommitObjects and withCommitData now live in commit/build.ts

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
  readonly matchOffset: number;
  readonly baseLen: number;
  readonly newLen: number;
  readonly pushBytes: number;
  readonly trees: ReadonlyArray<{ readonly old: string; readonly new: string }>;
  readonly hint: HintOutcome | null;
  readonly attempt: number;
};
// Pure: the result record. `next` is the commit that was pushed; a no-op has none.
type Pushed = { readonly newCommit: string; readonly newTree: string; readonly trees: readonly NewTree[]; readonly pushBytes: number };
const summarize = ({ oldCommit, commit, blob, hint, attempt }: {
  readonly oldCommit: string;
  readonly commit: { readonly tree: string };
  readonly blob: BlobEdit;
  readonly hint: HintOutcome | null;
  readonly attempt: number;
}, next: Pushed | null): EditResult => {
  const { newCommit, newTree, trees, pushBytes }: Pushed = next === null ? { newCommit: oldCommit, newTree: commit.tree, trees: [], pushBytes: 0 } : next;
  return { noop: next === null, oldCommit, newCommit, oldTree: commit.tree, newTree, oldBlob: blob.oldOid, newBlob: blob.newOid, matchOffset: blob.matchOffset, baseLen: blob.baseLen, newLen: blob.newLen, pushBytes, trees: trees.map(t => ({ old: t.baseOid, new: t.newOid })), hint, attempt };
};

// The options operation() reads pass through (tracer, auth, fetchImpl, limits, transport, …); these are the edit's own.
// `cache` null: a fresh tree cache per attempt. `signer` null: the commit is not signed.
export type EditConfig = {
  readonly head: string | null;
  readonly strictHead: boolean;
  readonly cache: Map<string, Uint8Array> | null;
  readonly verify: boolean;
  readonly allowLfsPointer: boolean;
  readonly signer: Signer | null;
  readonly retry: boolean;
};
export type EditOptions = EntryOptions & Input<EditConfig>;
const editDefaults = (): { -readonly [K in keyof EditConfig]: EditConfig[K] } => ({ head: null, strictHead: false, cache: null, verify: false, allowLfsPointer: false, signer: null, retry: true });
type Attempt = { readonly head: string | null; readonly attempt: number; readonly linkTo: Span | null; readonly hintWas: HintOutcome | null };

// The limits an entry's options name, else the defaults.
export const limitsOf = (opts: EntryOptions): Limits => getOrElse(fromNullish(opts.limits), DEFAULT_LIMITS);
// A packcache fetch reports its counters (attrs()); any other fetch has none.
const fetchCounters = (opts: EntryOptions): Attrs => {
  const fetchImpl = fromNullish(opts.fetchImpl);
  if (fetchImpl.tag === 'none') return {};
  const counters = fromNullish(fetchImpl.value.attrs);
  return counters.tag === 'some' ? counters.value() : {};
};

// A span whose body answers with a Result: an Err is recorded on the span as a thrown error would be (status, error.type,
// the exception event), and returned. What the body throws (another module's refusal) still ends the span as an error.
// oxlint-disable-next-line typescript/promise-function-async -- the span's promise, returned as is
export function inSpan<T>(tracer: Tracer, name: string, opts: StartOptions, body: (span: Span) => Promise<Result<T, PlyError>>): Promise<Result<T, PlyError>> {
  return tracer.span(name, opts, async span => {
    const r = await body(span);
    if (!r.ok) span.error(r.error);
    return r;
  });
}

// What a failed attempt carries out (operation() sets the root span; the attempt loop sets attempt and hint), read back
// for the retry: the span to link to and the hint as it turned out.
const isSpan = (v: unknown): v is Span => typeof v === 'object' && v !== null && 'spanId' in v && 'traceId' in v;
const isHint = (v: unknown): v is HintOutcome => v === 'used' || v === 'stale';
export const retryLink = (e: unknown): { readonly linkTo: Span | null; readonly hintWas: HintOutcome | null } => {
  const span = field(e, 'span');
  const hint = field(e, 'hint');
  return { linkTo: span.tag === 'some' && isSpan(span.value) ? span.value : null, hintWas: hint.tag === 'some' && isHint(hint.value) ? hint.value : null };
};
// An attempt's error leaves with its attempt number and how the hint turned out (an object only: a primitive has no fields).
export const tagAttempt = (e: unknown, attempt: number, hint: HintOutcome | null): void => {
  if (typeof e === 'object' && e !== null) Object.assign(e, { attempt, hint });
};

// Effect: stream one blob through inflate → scan → sha, never holding it. Returns the new blob's identity and delta.
// A Git LFS pointer is what the repository stores for an LFS-tracked file; the real content lives in the LFS store.
// Editing the pointer as if it were the file corrupts the pointer (and git-lfs then refuses the whole checkout). The
// pointer announces itself in its first bytes, which we are streaming anyway, so the guard costs nothing.
type Hasher = ReturnType<typeof streamingSha1>;
const LFS_MAGIC = te.encode('version https://git-lfs.github.com/spec/v1');
export const isLfsPointerPrefix = (bytes: Uint8Array): boolean => { const n = Math.min(bytes.length, LFS_MAGIC.length); for (let i = 0; i < n; i++) if (bytes[i] !== LFS_MAGIC[i]) return false; return n === LFS_MAGIC.length; };
const ignore
 = (): void => { /* the read side's error is the one reported */ };

type BlobWant = {
  readonly t: Transport;
  readonly tracer: Tracer;
  readonly root: Span;
  readonly blobOid: string;
  readonly find: Uint8Array;
  readonly replace: Uint8Array;
  readonly allowLfsPointer: boolean;
};
// oxlint-disable-next-line typescript/promise-function-async -- the span's promise, returned as is
function streamBlobEdit({ t, tracer, root, blobOid, find, replace, allowLfsPointer }: BlobWant): Promise<Result<BlobEdit, PlyError>> {
  return inSpan(tracer, 'git.edit.blob', { parent: root, attrs: { 'git.edit.blob.oid': blobOid } }, async span => {
    const fetchSpan = tracer.start('git.upload-pack fetch', { parent: span, kind: KIND.CLIENT });
    let sp: SpState = spInit();
    let scan = scanInit({ find, replace });
    // -1 until the declared size is known and checked (begin)
    let newLen = -1;
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
      } catch (e) { fetchSpan.error(e).end(); await writer.abort(e).catch(ignore); throw e; }
    })();
    const partial = (): Span => span.set({ 'git.edit.blob.base_len': sp.size, 'git.edit.blob.new_len': newLen, 'git.edit.blob.inflated': inflated, 'git.edit.blob.zlib.bytes': sp.zlibBytes, 'git.edit.blob.pack.bytes': sp.bytes, 'git.edit.blob.pack.trailer': getOrElse(fromNullish(sp.trailer), ''), 'git.edit.blob.cpu_ms': cpuMs, ...scanAttrs(scan) });
    // the hasher, once the declared size is known and checked: it has hashed the object header
    const begin = async (): Promise<Result<Hasher, PlyError>> => {
      if (sp.type !== TYPE.BLOB) return fail('pack_corrupt', `expected blob, got type ${sp.type}`);
      if (sp.size < find.length) return fail('match_count', `blob (${sp.size} bytes) is shorter than find (${find.length} bytes): expected exactly one match, found 0`, { matches: 0 });
      newLen = sp.size - find.length + replace.length; // exactly-one-match contract
      const h = streamingSha1(); span.set({ 'git.edit.blob.hasher': h.kind });
      await h.update(objectHeader('blob', newLen));
      return ok(h);
    };
    // The inflate side: every chunk scanned and hashed. The hasher once the first chunk arrived (none for an empty blob).
    const inflate = async (): Promise<Result<Hasher | null, PlyError>> => {
      let sha: Hasher | null = null;
      for await (const chunk of ds.readable) {
        // before begin(): a stream that inflates past its declared size is the server's lie (pack_corrupt), even when the
        // declared size is shorter than find (an empty blob followed by a byte used to be reported as match_count)
        inflated += chunk.length;
        if (inflated > sp.size) return fail('pack_corrupt', `server streamed more than the ${sp.size} bytes it declared`);
        if (sha === null) {
          // Unreachable: zlib is written only after phase is body, and a header-phase size is 0, so any positive
          // chunk has already failed the declared-size check. DecompressionStream emits no empty chunk.
          if (sp.phase !== 'body') return fail('pack_corrupt', 'inflated bytes before header');
          const lfs = isLfsPointerPrefix(chunk); span.set({ 'git.edit.blob.lfs_pointer': lfs });
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the pointer's size rides as an ad-hoc field (errors.ts Extra), as fetch.ts's size does
          if (lfs && !allowLfsPointer) return fail('lfs_pointer', `${blobOid} is a Git LFS pointer (${sp.size} bytes); the file's content is in the LFS store, not in git. Pass allowLfsPointer to edit the pointer itself.`, { size: sp.size } as Extra);
          const began = await begin();
          if (!began.ok) return began;
          sha = began.value;
        }
        const c0 = cpuNow();
        const r = scanStep(scan, chunk); scan = r.state;
        for (const p of r.emit) await sha.update(p);
        const dc = cpuSince(c0); if (dc !== null) cpuMs += dc;
      }
      await pump;
      return ok(sha);
    };
    let inflatedTo: Result<Hasher | null, PlyError>;
    try { inflatedTo = await inflate(); } catch (e) {
      await pump.catch(ignore);
      partial();
      if (isPlyError(e)) return err(e);
      if (!isPlyThrown(e)) return fail('pack_corrupt', `blob stream: ${thrownText(e)}`, { cause: e });
      // a coded value that is not an Error: the caller's own, passed on as thrown
      throw e;
    }
    if (!inflatedTo.ok) { await pump.catch(ignore); partial(); return inflatedTo; }
    let sha: Hasher;
    if (inflatedTo.value === null) { // empty blob
      const began = await begin();
      if (!began.ok) { partial(); return began; }
      sha = began.value;
    } else sha = inflatedTo.value;
    const fin = scanFinish(scan); scan = fin.state; for (const p of fin.emit) await sha.update(p);
    partial();
    if (inflated !== sp.size) return fail('pack_corrupt', `inflated ${inflated} != header size ${sp.size}`);
    if (scan.count !== 1) return fail('match_count', `expected exactly one match, found ${scan.count}`, { matches: scan.count });
    if (scan.emitted !== newLen) return fail('internal', `emitted ${scan.emitted} != ${newLen}`);
    const newOid = await sha.hex();
    // exactly one match (checked above), so matches[0] is its offset
    const matchOffset = atOr(scan.matches, 0, 0);
    const { delta, ops } = spliceDelta({ baseLen: sp.size, off: matchOffset, oldLen: find.length, insert: replace });
    span.set({ 'git.edit.blob.new': newOid, 'git.edit.blob.match_offset': matchOffset, 'git.edit.blob.delta.bytes': delta.length, 'git.edit.blob.delta.copy_ops': ops.copy, 'git.edit.blob.delta.insert_ops': ops.insert });
    return ok({ oldOid: blobOid, newOid, delta, baseLen: sp.size, newLen, matchOffset, scan, inflated });
  });
}

// oxlint-disable-next-line require-await -- async: a refusal of the spec is a rejection, which editFile's catch sees
async function editOnce(url: string, spec: EditSpec, options: EditOptions, cfg: EditConfig, { head, attempt, linkTo, hintWas }: Attempt): Promise<EditResult> {
  const { verify, allowLfsPointer, signer, strictHead } = cfg;
  const cache = cfg.cache === null ? new Map<string, Uint8Array>() : cfg.cache;
  const limits = limitsOf(options);
  const s = orThrow(validateSpecResult(spec, limits, head));
  const held: number[] = []; // sizes of metadata objects held whole, for memAttrs
  let streamed: { readonly scan: Held; readonly inflated: number } = { scan: { chunks: 0, maxChunk: 0 }, inflated: 0 };
  let hint = hintWas;
  let creating = s.create;
  const attrs = { 'git.edit.ref': s.ref, 'git.edit.base': s.base, 'git.edit.create': s.create, 'git.edit.path': s.path, 'git.edit.path.depth': s.comps.length, 'git.edit.find.bytes': s.find.length, 'git.edit.replace.bytes': s.replace.length, 'git.edit.head.hint': head === null ? '' : head, 'git.edit.attempt': attempt };
  // on every exit: how the hint turned out, what was held in memory, and the pack cache's counters if the fetch has them
  const onFinish = (): Attrs => ({ 'git.edit.head.outcome': hint === null ? '' : hint, ...memAttrs({ objects: held, ...streamed }), ...fetchCounters(options) });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the options' tracer, required at run time: EntryOptions (boundary.ts)
  return operation('edit', url, ({ ...options, attrs, onFinish, link: linkTo === null ? null : { span: linkTo, kind: 'retry_of' } } as OperationOpts), async ({ t, root, outcome }) => {
    // the tracer operation() started the root span on (opts.tracer)
    const tracer = root.tracer;
    const getObject = async (oid: string, expectType: number, deepen: number): Promise<Fetched> => { const o = await fetchObject(t, { oid, filter: 'tree:0', deepen, expectType }); held.push(o.size); return o; };
    try {
    // 1+2. parent commit: ls-refs, overlapped with a speculative fetch of the hinted commit when there is a hint.
    // A ref base keeps the original chain. A 40-hex base is that commit; the ref is listed, and a tip that is some
    // other commit is refuseRebase (the ref is not moved off its tip). A missing ref is not_found with miss.kind 'ref'.
    const resolve = async (): Promise<Result<string, PlyError>> => {
      if (s.baseOid) {
        const { refs } = await lsRefs(t, [s.ref]);
        const tip = mapOption(mapGet(refs, s.ref), r => r.oid);
        if (tip.tag === 'some' && tip.value !== s.base) return refuseRebase(s.ref, s.base, tip.value);
        creating = tip.tag === 'none';
        return ok(s.base);
      }
      const { refs } = await lsRefs(t, [s.base]);
      const found = mapGet(refs, s.base);
      if (found.tag === 'none') return fail('not_found', `ref ${s.base} not found`, { miss: { kind: 'ref', ref: s.base, candidates: [s.base] } });
      return ok(found.value.oid);
    };
    // oxlint-disable-next-line typescript/strict-boolean-expressions -- bundle budget: the JS's own truthy test, byte for byte (head is null or a checked oid)
    const [resolved, speculative] = await Promise.all([resolve().then(r => orThrow(r)), head ? getObject(head, TYPE.COMMIT, 1).then(o => o, (e: unknown) => e) : null]);
    root.set({ 'git.edit.create': creating });
    const decided = decideHead({ hint: head, resolved });
    hint = hintWas === null ? decided.hint : hintWas;
    const { oldCommit } = decided;
    orThrow(strictParent(strictHead, decided, s.base, head));
    if (speculative instanceof Error) root.set({ 'git.edit.head.speculative_error': thrownCodeOr(speculative, 'error') });
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
      const lvl = await inSpan(tracer, 'git.edit.tree', { parent: root, attrs: { 'git.edit.tree.depth': depth, 'git.edit.tree.oid': treeOid, 'git.edit.tree.lookup': name } }, async span => {
        const cached = mapGet(cache, treeOid);
        let data: Uint8Array;
        if (cached.tag === 'some') { data = cached.value; cacheHits++; } else { data = (await getObject(treeOid, TYPE.TREE, 0)).data; cache.set(treeOid, data); }
        span.set({ 'git.edit.tree.cache_hit': cached.tag === 'some' });
        const found = lookupEntryResult(data, name, last, limits);
        if (!found.ok) {
          const seen = fromNullish(found.error.attrs);
          if (seen.tag === 'some') span.set(seen.value);
          return found;
        }
        span.set(found.value.attrs);
        return ok({ treeOid, data, entry: found.value.entry });
      });
      const level = orThrow(lvl);
      levels.push(level);
      treeOid = level.entry.oid;
    }
    const blobOid = treeOid;
    root.set({ 'git.edit.blob.old': blobOid, 'git.edit.tree.cache_hits': cacheHits, 'git.edit.tree.fetches': s.comps.length - cacheHits });

    // 4. streamed blob replace. Effect: one pack stream; decisions: spStep/scanStep (pure), the exactly-one-match contract.
    const blob = orThrow(await streamBlobEdit({ t, tracer, root, blobOid, find: s.find, replace: s.replace, allowLfsPointer }));
    streamed = { scan: blob.scan, inflated: blob.inflated };

    // identical content → no commit; a no-op edit must not create an empty commit
    if (blob.newOid === blobOid) return outcome('noop', summarize({ oldCommit, commit, blob, hint, attempt }, null), { 'git.edit.blob.new': blob.newOid });

    // 5+6. new trees + commit (pure), then push (effect).
    let built = buildCommitObjects({ levels, blob, oldCommit, author: s.author, committer: s.committer, time: s.time, message: s.message });
    if (signer !== null) { built = withCommitData(built, orThrow(await signCommitResult(built.commitData, signer))); root.set({ 'git.edit.commit.signed': signer.kind, 'git.edit.commit.signer': getOrElse(fromNullish(signer.publicKeyLine), '') }); }
    for (const tr of built.trees) cache.set(tr.newOid, tr.newData);
    root.set({ 'git.edit.tree.new': built.newTree, 'git.edit.commit.new': built.newCommit, 'git.edit.commit.bytes': built.commitData.length });
    const pushed = await push(t, { ref: s.ref, oldOid: creating ? ZERO_OID : oldCommit, newOid: built.newCommit, objects: built.objects });
    // report-status is the only receipt git offers, and a middlebox can forge it. verify: re-read the ref (one ~100 B
    // roundtrip) and require it to be our commit; a mismatch is 'ambiguous' (the push was acknowledged but not observed).
    if (verify) await verifyRef(t, root, 'git.edit', s.ref, built.newCommit);
    return outcome('ok', summarize({ oldCommit, commit, blob, hint, attempt }, { newCommit: built.newCommit, newTree: built.newTree, trees: built.trees, pushBytes: pushed.packBytes }), { 'git.edit.push.bytes': pushed.packBytes, 'git.edit.push.ratio': pushed.packBytes / Math.max(1, blob.newLen) });
    // a thrown object gets the attempt's fields, as before, and leaves through operation(), which records it on the root
    } catch (e) { tagAttempt(e, attempt, hint); throw e; }
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
export async function editFile(url: string, spec: EditSpec, options: EditOptions = {}): Promise<EditResult> {
  const cfg = withDefaults(options, editDefaults());
  orThrow(needsHead(cfg.strictHead, cfg.head));
  try {
    return await editOnce(url, spec, options, cfg, { head: cfg.head, attempt: 0, linkTo: null, hintWas: null });
  } catch (e) {
    // only a real Error is a cas_conflict that can be retried; anything else is what the caller threw, unchanged.
    // the retry is not inside this try, so a second cas_conflict propagates (attempt 0 is the only one caught)
    if (!cfg.retry || !(e instanceof Error) || !thrownCodeIs(e, 'cas_conflict') || cfg.strictHead) throw e;
    return editOnce(url, spec, options, cfg, { head: null, attempt: 1, ...retryLink(e) });
  }
}
