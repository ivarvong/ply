// The transport contract. A transport is a plain record; the protocol layer (lsrefs, fetch, push, discover, receivecaps)
// calls exactly two things on it and never looks inside:
//
//   t.frames(service, body, span, hints)  → AsyncIterable of pkt-line frames of one command's response
//   t.advertise(service, span)            → Result<Uint8Array>: the service's capability advertisement (pkt-lines)
//
// plus the data every caller may read: t.kind ('http'), t.url (credential-free, for spans and messages),
// t.tracer, t.parent (the span wire spans hang under), t.limits, t.signal, and t.scrub: null, or a function that
// redacts the transport's credential from any text (server echoes), applied by every span under it (otel.js).
//
// `hints` are transport-neutral requests a transport may honor or ignore: { bypassCache: true } asks an HTTP transport
// with a pack cache in front of it (packcache.js) to go to the origin. Transports record, on the span they are given:
//   git.transport            'http'
//   git.request.bytes        body bytes sent
//   git.response.bytes       bytes received for this command
//   git.response.first_byte_ms, git.response.duration_ms
//   git.response.cache       'HIT' | 'MISS' | 'BUST' | ''   (HTTP with packcache; '' otherwise)
//   server.address, url.full
//   http.response.header.<name>     opt-in (createTransport recordResponseHeaders): that response header, lowercased,
//                                   scrubbed, length-capped. Absent when the response did not send it.
//   http.response.headers.from_cache  true when that opt-in exchange was a pack-cache HIT (the header values are the
//                                   cached response's). Omitted on a live response.
// and may add transport-specific detail under http.*. Implementation: http.ts (an SSH one was removed 2026-10-31;
// history on branch archive/ssh).
import type { Code, ErrorOf, PlyError } from './errors.js';
import { fail, plyError } from './errors.js';
import type { Err, Result } from './result.js';
import { err } from './result.js';
import type { Limits } from './limits.js';
import type { Span, Tracer } from './otel.js';
import { KIND } from './otel.js';
import type { Input } from './absent.js';
import { field, fillIn, fromNullable, mapGet, readKey } from './absent.js';
import { isPlyThrown, thrownText } from './boundary.js';

// One pkt-line frame as pktline.js yields it.
export type Frame =
  | { readonly kind: 'data'; readonly payload: Uint8Array }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'end' };
export type Hints = { readonly bypassCache: boolean };
export const NO_HINTS: Hints = Object.freeze({ bypassCache: false });
export type Scrub = (s: string) => string;
// What a server was found to need, learned at run time and shared by every view of the transport (mutable on purpose).
// treeFilter: what a filtered fetch is sent as. 'blob:none' for a host that refuses tree:0 (fetch.ts, learned from its
// 400); 'none' for a host whose upload-pack advertisement has no `filter` on its `fetch=` line (git's own default,
// uploadpack.allowFilter unset), learned from that advertisement (learnFilter): no filter is sent and the fetch takes
// the unfiltered pack. blobWants: 'single' for a host that refuses a multi-blob want list (checkout). A caller passes
// one record to every call on a server; ply fills it (absent.fillIn).
// The record stays two string enums rather than an ADT with a reason and a time (#136 asked for `refused{reason, at}`):
// each value already names what was learned (tree:0 = unknown or taken, blob:none = tree:0 refused, none = no filter
// advertised), the reason and the request that learned it are on that request's span (git.fetch.filter.fallback,
// .requested, .learned, error.kind), and a time would only serve expiry, which a stale value does not need (see the memo
// below). Callers persist and compare it as plain JSON; a richer shape would break that for no decision ply makes.
export type TreeFilter = 'tree:0' | 'blob:none' | 'none';
export type Quirks = { treeFilter: TreeFilter; blobWants: 'many' | 'single' };
export const freshQuirks = (): Quirks => ({ treeFilter: 'tree:0', blobWants: 'many' });
// What an upload-pack advertisement says about `filter`, kept: absent is 'none'; present undoes an earlier 'none' (the
// host turned it on) and leaves a learned blob:none alone (Artifacts advertises `filter` and refuses tree:0).
export function learnFilter(t: Transport, advertised: boolean): void {
  if (!advertised) t.quirks.treeFilter = 'none';
  else if (t.quirks.treeFilter === 'none') t.quirks.treeFilter = 'tree:0';
}
// The default memo (#136): what a remote was found to need, kept per remote for a transport made without a `quirks`
// record (createTransport, every operation), so a later operation on the same remote does not pay the refusal again
// (Artifacts' 400 on tree:0 is 100-900 ms; a stock server's empty answer is a request plus an advertisement read).
// Keyed by origin and path (query, fragment, userinfo and a trailing slash dropped: the credential is never part of the
// key). Bounded: the least recently used remote is dropped past QUIRKS_MEMO_MAX. Module state, so per process, or per
// isolate on Workers. A record the caller passes wins (and is filled in place, as before); passing a fresh one (`{}`)
// opts that call out; forgetQuirks() clears one remote or all of them (a server reconfigured, a test faking several
// servers at one URL). A stale entry costs bytes, never correctness: blob:none and the unfiltered pack are wider answers
// to the same question, and a server that stops taking a filter is relearned from its empty answer.
export const QUIRKS_MEMO_MAX = 256;
const quirksMemo = new Map<string, Quirks>();
// The memo key of a parsed remote URL: origin and path, nothing else.
// oxlint-disable-next-line require-unicode-regexp -- ASCII
export const quirksKeyOf = (u: URL): string => `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
// The memo key of a remote URL, or null for a URL that does not parse (createTransport refuses it first).
export function quirksKey(url: string | URL): string | null {
  try { return quirksKeyOf(new URL(url)); } catch { return null; }
}
// The remembered record for `key`, made (fresh) on first use and marked most recently used.
export function rememberedQuirks(key: string): Quirks {
  const hit = mapGet(quirksMemo, key);
  const q = hit.tag === 'some' ? hit.value : freshQuirks();
  quirksMemo.delete(key);
  quirksMemo.set(key, q);
  for (const oldest of quirksMemo.keys()) {
    if (quirksMemo.size <= QUIRKS_MEMO_MAX) break;
    quirksMemo.delete(oldest);
  }
  return q;
}
// Forget what was learned about `url` (as quirksKey normalizes it), or about every remote when no url is given.
// Transports already made keep their record; the next one made for that remote starts fresh.
export function forgetQuirks(url: string | URL | null = null): void {
  if (url === null) { quirksMemo.clear(); return; }
  const key = quirksKey(url);
  if (key !== null) quirksMemo.delete(key);
}
// One probe at a time per record (#136). Until a server has answered a filtered request, two concurrent ones (merge
// walks both sides at once; two operations on one remembered record) would each pay the refusal or the empty answer.
// So the first filtered request on a record whose treeFilter is still tree:0 is the probe: a filtered request that
// arrives while it runs waits for it, then reads the record again (it may now say blob:none or none). An answer that
// was not a refusal settles the record for what was sent (`filter`: some filter is taken, so a blob:none request needs
// no probe; `tree:0`: tree:0 itself is taken, nothing does); a failure for another reason (a network error, a missing
// object) settles nothing and the next request probes. `run` reads the record itself, after any wait.
export type Probe = 'filter' | 'tree:0';
const probes = new WeakMap<Quirks, Promise<null>>();
const settled = new WeakMap<Quirks, Probe>();
const ignore = (): null => null;
export async function probing<T extends { readonly ok: boolean }>(q: Quirks, sends: Probe, run: () => Promise<T>): Promise<T> {
  // read and claimed with no await between them: two callers cannot both see no probe and both start one
  const pending = fromNullable(probes.get(q));
  if (pending.tag === 'some') {
    await pending.value;
    return probing(q, sends, run);
  }
  const known = fromNullable(settled.get(q));
  if (q.treeFilter !== 'tree:0' || (known.tag === 'some' && (known.value === 'tree:0' || sends === 'filter'))) return run();
  const running = run();
  probes.set(q, running.then(ignore, ignore));
  try {
    const out = await running;
    if (out.ok && q.treeFilter === 'tree:0' && (sends === 'tree:0' || known.tag === 'none')) settled.set(q, sends);
    return out;
  } finally {
    probes.delete(q);
  }
}
// Commits and trees harvested from over-wide packs (fetch.js), keyed by oid; `bytes` is their running total.
export type HeldObject = { readonly type: number; readonly data: Uint8Array };
export type Harvest = Map<string, HeldObject>;
// Bytes held: the store is bounded by limits.maxHarvestBytes, so a sum over it is a bounded scan.
export const harvestBytes = (store: Harvest): number => { let n = 0; for (const o of store.values()) n += o.data.length; return n; };
// Span attributes as otel.js records them.
export type Attrs = Record<string, unknown>;

export type Transport = {
  readonly kind: 'http';
  readonly url: string;
  readonly tracer: Tracer;
  readonly parent: Span | null;
  readonly limits: Limits;
  readonly signal: AbortSignal | null;
  readonly quirks: Quirks;
  readonly objects: Harvest;
  readonly scrub: Scrub | null;
  frames: (service: string, body: Uint8Array, span: Span, hints: Hints) => AsyncIterable<Frame>;
  advertise: (service: string, span: Span) => Promise<Result<Uint8Array, PlyError>>;
};

// A transport as a caller may hand one in (operations take `transport`): it may lack the learned-quirks record and the
// harvest store and the credential scrubber, or pass null for them. asTransport fills them once, at the edge: a transport that had none had no
// memory of either, so a private fresh record behaves the same.
export type TransportInput = Omit<Transport, 'quirks' | 'objects' | 'scrub'> & Input<{ readonly quirks: Input<Quirks> | null; readonly objects: Harvest | null; readonly scrub: Scrub | null }>;
export function asTransport(t: TransportInput): Transport {
  const q = readKey(t, 'quirks');
  const o = readKey(t, 'objects');
  const sc = readKey(t, 'scrub');
  const scrub = sc.tag === 'some' ? sc.value : null;
  const quirks = fillIn(q.tag === 'some' && q.value !== null ? q.value : {}, freshQuirks());
  const objects = o.tag === 'some' && o.value !== null ? o.value : new Map<string, HeldObject>();
  if (q.tag === 'some' && q.value === quirks && o.tag === 'some' && o.value === objects && sc.tag === 'some') {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- both fields were present; the record is a Transport
    return t as Transport;
  }
  // A view, like withParent: the caller's methods and state stay the prototype's.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.create returns any; the view is `t` with the two fields filled
  return Object.create(t, { quirks: { value: quirks, enumerable: true }, objects: { value: objects, enumerable: true }, scrub: { value: scrub, enumerable: true } }) as Transport;
}

// We are not git and do not claim to be: servers that branch on the agent string get the truth.
export const UA = 'ply/0.2.0';
export const proto = (msg: string): Err<ErrorOf<'protocol'>> => fail('protocol', msg);

export const frames = (t: Transport, service: string, body: Uint8Array, span: Span, hints: Hints = NO_HINTS): AsyncIterable<Frame> => t.frames(service, body, span, hints);
// oxlint-disable-next-line typescript/promise-function-async -- a pass-through: the transport's own promise, unwrapped (async adds a wrapper and bytes)
export const advertise = (t: Transport, service: string, span: Span): Promise<Result<Uint8Array, PlyError>> => t.advertise(service, span);

// The same transport, with wire spans parented under `parent` (an operation's root). State is shared with the original:
// the view only shadows `parent`. (A transport's methods must therefore read `parent` from the record they are called on.)
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.create returns any; the view is `t` with one field shadowed
export const withParent = <T extends Transport>(t: T, parent: Span): T => Object.create(t, { parent: { value: parent, enumerable: true } }) as T;

export type SpanOpts = { readonly parent: Span | null; readonly kind: number; readonly attrs: Attrs; readonly scrub: Scrub | null };
// Span options for a wire round trip under this transport's parent.
// It carries the transport's `scrub` (credential redaction, http.js), so even an unparented wire span exports none.
export const clientSpan = (t: Transport, attrs: Attrs = {}): SpanOpts => ({ parent: t.parent, kind: KIND.CLIENT, attrs, scrub: t.scrub });

// Set `code` on a raised value. False for a primitive, null or a frozen value (Reflect.set answers false, or a setter
// throws): that one is wrapped instead.
const setCode = (e: unknown, code: Code): boolean => {
  try { return (typeof e === 'object' || typeof e === 'function') && e !== null && Reflect.set(e, 'code', code); } catch { return false; }
};
// A raised value as the PlyError it is: a typed error keeps its code; any other value is given `code` (on the value
// itself when it takes one, else on a wrapper that has it as the cause).
export function raised(code: Code, e: unknown): PlyError {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- it carries one of ply's codes (already, or just set): a PlyError's shape
  if (isPlyThrown(e) || setCode(e, code)) return e as PlyError;
  return plyError(code, thrownText(e), { cause: e });
}
// The stream edge: a transport's frames signal failure through the stream protocol (the iterator rejects), and a
// transport the caller hands in may raise anything. Caught here, once per exchange, and returned as the Err it is.
export async function coded<T>(code: Code, fn: () => Promise<Result<T, PlyError>>): Promise<Result<T, PlyError>> {
  try { return await fn(); } catch (e) { return err(raised(code, e)); }
}
// fn(span) under a wire span. An Err is recorded on the span (error status, error.type, the exception event) as the
// tracer records a raised error; a raised one still is, by the tracer, before coded() catches it.
// oxlint-disable-next-line typescript/promise-function-async -- the span's promise, passed through (an async wrapper adds bytes, not behaviour)
export const spanned = <T>(t: Transport, name: string, opts: SpanOpts, fn: (span: Span) => Promise<Result<T, PlyError>>): Promise<Result<T, PlyError>> =>
  t.tracer.span(name, opts, async (span: Span): Promise<Result<T, PlyError>> => {
    const r = await fn(span);
    if (!r.ok) span.error(r.error);
    return r;
  });

// A thrown value's `name` is `want` (an AbortError, a TimeoutError). Any value may be thrown: a primitive has no name.
const nameIs = (e: unknown, want: string): boolean => { const n = field(e, 'name'); return n.tag === 'some' && n.value === want; };
// A platform fetch failure → the PlyError it is: aborted or timeout when the signal fired or the error says so, else
// network. A typed error passes through.
export function wrapNet(e: unknown, signal: AbortSignal | null = null): PlyError {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- it carries one of ply's codes: a PlyError's shape
  if (isPlyThrown(e)) return e as PlyError;
  const aborted = signal !== null && signal.aborted;
  if (aborted || nameIs(e, 'AbortError') || nameIs(e, 'TimeoutError')) {
    const timedOut = nameIs(e, 'TimeoutError') || (signal !== null && nameIs(signal.reason, 'TimeoutError'));
    return plyError(timedOut ? 'timeout' : 'aborted', `request aborted: ${thrownText(e)}`, { cause: e });
  }
  return plyError('network', `network: ${thrownText(e)}`, { cause: e });
}
