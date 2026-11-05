// Mirror one ref from a source remote to a destination: `git fetch <src> <ref>` then
// `git push --force-with-lease=<dstRef>:<dstTip> <dst> <tip>:<dstRef>`, with no local repository.
//
//   syncRef(srcUrl, dstUrl, { ref, dstRef?, force? }, { src?, dst?, tracer?, limits?, signal?, verify? })
//     → { outcome: 'in_sync', ref, dstRef, oid }
//     | { outcome: 'created' | 'updated', ref, dstRef, from, to, forced, objects, pushBytes }
//
// One ls-refs on each side (concurrently). Equal tips: `in_sync`, nothing else is sent. Otherwise one fetch from the
// source wanting its tip with the destination's tip as the one `have` (a have the source does not know is harmless: it
// NAKs and sends the whole history), then one receive-pack command on the destination whose old id is the tip ls-refs
// read there (the zero id when the ref is absent: a create). The pack sent is the source's pack as received, object for
// object and delta for delta (an OFS_DELTA stays one against the same base; nothing is re-deltified or made thin), so it
// holds only what the source computed the destination lacks: nothing reachable from the destination's tip when the
// source has that commit. The fetch never asks for a thin pack: every base is in the pack, so the destination needs no
// object it was not shown to have.
//
// Fast-forward: the destination's tip is a parent of a commit in the received pack reachable from the source's tip
// (the pack holds exactly the commits the destination's tip does not reach, so the path from the source's tip down to
// an ancestor tip is in it). An update that is not a fast-forward (a rewritten or diverged source, or a destination
// ahead of the source), and any change to an existing tag (refs/tags/), is `not_fast_forward` unless `force` (as
// pushRepo refuses one; the default is false, as `git push` without `+`). Forced, it is pushed with the same CAS.
//
// A push that loses the compare-and-swap (the destination moved after ls-refs) re-reads the destination ref:
// `cas_conflict` with `expected` the tip ply saw (zero for a create) and `actual` the tip now (null: deleted), as
// refops' createBranch and deleteBranch report a lost race. Anything else the destination refuses is its own error.
//
// Options. Each remote has its own credential and transport: `src` and `dst` each take `auth`, `fetchImpl`, `quirks`
// and `transport` (a mirror reads with one token and writes with another, often on two hosts). One operation has one
// root span, one abort signal and one budget, so `tracer`, `parent`, `signal` and `limits` are shared; a top-level
// `fetchImpl` is the default for both sides. A top-level `auth` names neither side and is refused (`bad_request`,
// `what: 'auth'`) rather than guessed. `limits.maxPackBytes` bounds both the pack fetched and the pack pushed.
/* oxlint-disable require-await -- the entry is async: a refused argument is an Err in a promise, like every other answer (read.ts) */
/* oxlint-disable import/max-dependencies -- an operation over ls-refs on two remotes, the fetch, the pack and the push */
import type { PlyError } from './errors.js';
import type { Result } from './result.js';
import type { Input } from './absent.js';
import type { EntryConfig } from './boundary.js';
import type { OperationOpts } from './operation.js';
import type { OpContext } from './merge.js';
import type { Transport, TransportInput, Scrub } from './transport.js';
import type { PackObject } from './fetch.js';
import type { PackInput } from './pack.js';
import type { ParsedPack } from './packresolve.js';
import type { CheckedLimits, LimitsInput } from './limits.js';
import { fail } from './errors.js';
import { ok, map, assertNever } from './result.js';
import { field, mapGet, withDefaults } from './absent.js';
import { lsRefs } from './lsrefs.js';
import { fetchPack } from './fetchpack.js';
import { push, ZERO_OID } from './push.js';
import { operation, verifyRef } from './operation.js';
import { createTransport, redactUrl } from './http.js';
import { transportFrom, withParent } from './transport.js';
import { parseCommit, parseTag, TYPE } from './objects.js';
import { validatePushRef } from './validate.js';
import { refOid } from './merge.js';
import { DEFAULT_LIMITS, parseLimits } from './limits.js';
import { Tracer } from './otel.js';
import type { Span } from './otel.js';

// One remote's connection: its credential, fetch, learned quirks, or a transport the caller already holds.
export type SyncSideConfig = Pick<EntryConfig, 'auth' | 'quirks' | 'transport'> & { readonly fetchImpl: EntryConfig['fetchImpl'] | null };
export type SyncSide = Input<SyncSideConfig>;
type Shared = { readonly tracer: Tracer; readonly parent: Span | null; readonly limits: LimitsInput; readonly signal: AbortSignal | null; readonly fetchImpl: EntryConfig['fetchImpl'] | null; readonly verify: boolean; readonly src: SyncSide; readonly dst: SyncSide };
export type SyncRefOptions = Input<Shared>;
export type SyncRefConfig = { readonly dstRef: string | null; readonly force: boolean };
export type SyncRefSpec = { readonly ref: string } & Input<SyncRefConfig>;
export type SyncRefResult =
  | { readonly outcome: 'in_sync'; readonly ref: string; readonly dstRef: string; readonly oid: string }
  | { readonly outcome: 'created' | 'updated'; readonly ref: string; readonly dstRef: string; readonly from: string | null; readonly to: string; readonly forced: boolean; readonly objects: number; readonly pushBytes: number };

const sideDefaults = (): SyncSideConfig => ({ auth: null, fetchImpl: null, quirks: null, transport: null });

// The destination's transport, under the operation's root: the caller's (re-parented), or one built for the url.
function dstTransport(url: string, side: SyncSideConfig, shared: Shared, root: Span): Result<Transport, PlyError> {
  if (side.transport !== null) return map(transportFrom(side.transport), d => withParent(d, root));
  const fetchImpl = side.fetchImpl === null ? shared.fetchImpl : side.fetchImpl;
  return createTransport(url, { auth: side.auth, tracer: shared.tracer, parent: root, fetchImpl: fetchImpl === null ? globalThis.fetch : fetchImpl, limits: shared.limits, signal: shared.signal, ...(side.quirks === null ? {} : { quirks: side.quirks }) });
}

// Both credentials redacted from the root span and from the error the caller gets.
const bothScrubs = (a: Scrub | null, b: Scrub | null): Scrub | null => {
  if (a === null) return b;
  if (b === null) return a;
  return (s: string): string => b(a(s));
};

// Is `old` reachable from `tip` through the received pack? `tip` is peeled (an annotated tag to its object); the walk
// follows commit parents within the pack and stops at a parent outside it (one the destination's tip already reaches).
function reaches(objects: ReadonlyMap<string, PackObject>, tip: string, old: string, limits: CheckedLimits): Result<boolean, PlyError> {
  const stack = [tip];
  const seen = new Set<string>();
  for (let oid = stack.pop(); typeof oid === 'string'; oid = stack.pop()) {
    if (oid === old) return ok(true);
    const o = mapGet(objects, oid);
    if (seen.has(oid) || o.tag === 'none') continue;
    seen.add(oid);
    if (o.value.type === TYPE.TAG) {
      const tag = parseTag(o.value.data); if (!tag.ok) return tag;
      stack.push(tag.value.object);
    } else if (o.value.type === TYPE.COMMIT) {
      const c = parseCommit(o.value.data, limits); if (!c.ok) return c;
      stack.push(...c.value.parents);
    }
  }
  return ok(false);
}

// The received pack, as push sends it: each object in the order it arrived, a delta against the same base (an OFS base
// as the index of that earlier object, a REF base by id), a whole object whole.
function forwarded(parsed: ParsedPack | null): PackInput[] {
  if (parsed === null) return [];
  const index = new Map(parsed.objects.map((o, i) => [o.offset, i]));
  return parsed.objects.map((o): PackInput => {
    switch (o.base.tag) {
      case 'ofs': {
        const at = mapGet(index, o.base.offset);
        return at.tag === 'some' ? { type: o.type, data: o.data, base: { tag: 'ofs', index: at.value } } : { type: o.type, data: o.data };
      }
      case 'ref': return { type: o.type, data: o.data, base: o.base };
      case 'none': return { type: o.type, data: o.data };
    }
    // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: unreachable, the compiler's exhaustiveness check
    return assertNever(o.base);
  });
}

// Effect: a push the destination refused as stale (it moved after ls-refs). receive-pack does not say where it went, so
// re-read it: moved, cas_conflict naming the tip it has now (null: deleted); unchanged, the push's own error stands.
async function lostRace(d: Transport, dstRef: string, expected: string, pushed: Result<never, PlyError>): Promise<Result<never, PlyError>> {
  const now = await lsRefs(d, [dstRef]);
  if (!now.ok) return now;
  const tip = refOid(now.value.refs, dstRef);
  const actual = tip.tag === 'some' ? tip.value : null;
  if (actual === (expected === ZERO_OID ? null : expected)) return pushed;
  return fail('cas_conflict', `${dstRef} moved from ${expected} to ${actual === null ? 'absent' : actual} during the sync`, { what: 'ref', expected, actual });
}

type Parsed = { readonly ref: string; readonly dstRef: string; readonly force: boolean; readonly shared: Shared; readonly src: SyncSideConfig; readonly dst: SyncSideConfig };
// The spec and options, total, or the caller's mistake (nothing is sent).
function parseSync(spec: SyncRefSpec, options: SyncRefOptions): Result<Parsed, PlyError> {
  const { ref } = spec;
  const named = validatePushRef(ref, false); if (!named.ok) return named;
  const { dstRef: givenDst, force } = withDefaults<SyncRefConfig>(spec, { dstRef: null, force: false });
  const dstRef = givenDst === null ? ref : givenDst;
  const dstNamed = validatePushRef(dstRef, false); if (!dstNamed.ok) return dstNamed;
  if (typeof force !== 'boolean') return fail('bad_request', 'syncRef: force must be a boolean', { what: 'force' });
  if (field(options, 'auth').tag === 'some') return fail('bad_request', 'syncRef: auth belongs to one remote: pass opts.src.auth and opts.dst.auth', { what: 'auth' });
  const given = withDefaults<Shared>(options, { tracer: new Tracer(), parent: null, limits: DEFAULT_LIMITS, signal: null, fetchImpl: null, verify: false, src: {}, dst: {} });
  // parsed once here, for both transports: a bad one is refused before either is made
  const limits = parseLimits(given.limits); if (!limits.ok) return limits;
  const shared = { ...given, limits: limits.value };
  return ok({ ref, dstRef, force, shared, src: withDefaults(shared.src, sideDefaults()), dst: withDefaults(shared.dst, sideDefaults()) });
}

// Effect: the fetch from the source (the destination's tip as the have), the fast-forward decision, and the CAS push.
type Transfer = { readonly t: Transport; readonly d: Transport; readonly root: Span; readonly to: string; readonly from: string | null };
async function transfer({ dstRef, force, shared }: Parsed, { t, d, root, to, from }: Transfer): Promise<Result<Omit<SyncRefResult & { readonly outcome: 'created' | 'updated' }, 'ref'>, PlyError>> {
  const fetched = await fetchPack(t, { wants: [to], haves: from === null ? [] : [from], done: true, ofsDelta: true, thinPack: false }, { resolve: true });
  if (!fetched.ok) return fetched;
  const objects = fetched.value.objects === null ? new Map<string, PackObject>() : fetched.value.objects;
  const tag = dstRef.startsWith('refs/tags/');
  let fastForward = true;
  if (from !== null) {
    const ff = reaches(objects, to, from, t.limits); if (!ff.ok) return ff;
    fastForward = ff.value && !tag;
    if (!fastForward && !force) return fail('not_fast_forward', `${dstRef} is at ${from} on the destination and ${tag ? 'the tag already exists there' : `${to} does not descend from it`}; pass force: true to overwrite it`, { what: 'ref', got: [dstRef] });
  }
  root.set({ 'git.sync_ref.fast_forward': fastForward });
  const pack = forwarded(fetched.value.parsed);
  const expected = from === null ? ZERO_OID : from;
  const pushed = await push(d, { ref: dstRef, oldOid: expected, newOid: to, objects: pack });
  if (!pushed.ok) return pushed.error.code === 'cas_conflict' ? lostRace(d, dstRef, expected, pushed) : pushed;
  if (shared.verify) { const seen = await verifyRef(d, root, 'git.sync_ref', dstRef, to); if (!seen.ok) return seen; }
  return ok({ outcome: from === null ? 'created' : 'updated', dstRef, from, to, forced: !fastForward, objects: pack.length, pushBytes: pushed.value.packBytes });
}

export async function syncRef(srcUrl: string, dstUrl: string, spec: SyncRefSpec, options: SyncRefOptions = {}): Promise<Result<SyncRefResult, PlyError>> {
  const parsed = parseSync(spec, options); if (!parsed.ok) return parsed;
  const p = parsed.value;
  const { ref, dstRef, force, shared, src, dst } = p;
  const srcTransport: TransportInput | null = src.transport;
  const opOpts: OperationOpts = {
    tracer: shared.tracer, parent: shared.parent, limits: shared.limits, signal: shared.signal, auth: src.auth, quirks: src.quirks, transport: srcTransport,
    fetchImpl: src.fetchImpl === null ? shared.fetchImpl : src.fetchImpl,
    attrs: { 'git.sync_ref.ref': ref, 'git.sync_ref.dst_ref': dstRef, 'git.sync_ref.dst_url': dst.transport === null ? redactUrl(dstUrl) : dst.transport.url, 'git.sync_ref.force': force },
  };
  return operation('sync_ref', srcUrl, opOpts, async ({ t, root, outcome }: OpContext): Promise<Result<SyncRefResult, PlyError>> => {
    const made = dstTransport(dstUrl, dst, shared, root); if (!made.ok) return made;
    const d = made.value;
    root.scrub = bothScrubs(t.scrub, d.scrub);
    const [srcListed, dstListed] = await Promise.all([lsRefs(t, [ref]), lsRefs(d, [dstRef])]);
    if (!srcListed.ok) return srcListed;
    if (!dstListed.ok) return dstListed;
    const srcTip = refOid(srcListed.value.refs, ref);
    if (srcTip.tag === 'none') return fail('not_found', `ref ${ref} not found on the source`, { miss: { kind: 'ref', ref, candidates: [ref] } });
    const to = srcTip.value;
    const dstTip = refOid(dstListed.value.refs, dstRef);
    const from = dstTip.tag === 'some' ? dstTip.value : null;
    root.set({ 'git.sync_ref.to': to, 'git.sync_ref.from': from === null ? '' : from });
    if (from === to) return outcome('in_sync', { outcome: 'in_sync', ref, dstRef, oid: to });
    const sent = await transfer(p, { t, d, root, to, from }); if (!sent.ok) return sent;
    const result: SyncRefResult = { ...sent.value, ref };
    return outcome(result.outcome, result, { 'git.sync_ref.objects': result.objects, 'git.sync_ref.push_bytes': result.pushBytes });
  });
}
