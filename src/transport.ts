// The transport contract. A transport is a plain record; the protocol layer (lsrefs, fetch, push, discover, receivecaps)
// calls exactly two things on it and never looks inside:
//
//   t.frames(service, body, span, hints)  → AsyncIterable of pkt-line frames of one command's response
//   t.advertise(service, span)            → Uint8Array: the service's capability advertisement (pkt-lines)
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
import type { Code, ErrorOf } from './errors.js';
import { thrown, fail } from './errors.js';
import type { Err } from './result.js';
import type { Limits } from './limits.js';
import type { Span, Tracer } from './otel.js';
import { KIND } from './otel.js';
import type { Input } from './absent.js';
import { field, fillIn, readKey } from './absent.js';
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
// treeFilter: 'blob:none' for a host that refuses tree:0 (fetch). blobWants: 'single' for a host that refuses a
// multi-blob want list (checkout). A caller passes one record to every call on a server; ply fills it (absent.fillIn).
export type Quirks = { treeFilter: 'tree:0' | 'blob:none'; blobWants: 'many' | 'single' };
export const freshQuirks = (): Quirks => ({ treeFilter: 'tree:0', blobWants: 'many' });
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
  advertise: (service: string, span: Span) => Promise<Uint8Array>;
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
export const UA = 'ply/0.1.0';
export const proto = (msg: string): Err<ErrorOf<'protocol'>> => fail('protocol', msg);

export const frames = (t: Transport, service: string, body: Uint8Array, span: Span, hints: Hints = NO_HINTS): AsyncIterable<Frame> => t.frames(service, body, span, hints);
// oxlint-disable-next-line typescript/promise-function-async -- a pass-through: the transport's own promise, unwrapped (async adds a wrapper and bytes)
export const advertise = (t: Transport, service: string, span: Span): Promise<Uint8Array> => t.advertise(service, span);

// The same transport, with wire spans parented under `parent` (an operation's root). State is shared with the original:
// the view only shadows `parent`. (A transport's methods must therefore read `parent` from the record they are called on.)
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.create returns any; the view is `t` with one field shadowed
export const withParent = <T extends Transport>(t: T, parent: Span): T => Object.create(t, { parent: { value: parent, enumerable: true } }) as T;

export type SpanOpts = { readonly parent: Span | null; readonly kind: number; readonly attrs: Attrs; readonly scrub: Scrub | null };
// Span options for a wire round trip under this transport's parent.
// It carries the transport's `scrub` (credential redaction, http.js), so even an unparented wire span exports none.
export const clientSpan = (t: Transport, attrs: Attrs = {}): SpanOpts => ({ parent: t.parent, kind: KIND.CLIENT, attrs, scrub: t.scrub });

// Set `code` on a thrown value. False for a primitive, null or a frozen value (Reflect.set answers false, or a setter
// throws): that one is wrapped instead.
const setCode = (e: unknown, code: Code): boolean => {
  try { return (typeof e === 'object' || typeof e === 'function') && e !== null && Reflect.set(e, 'code', code); } catch { return false; }
};
// The I/O edge: an operation's promise, its rejection given a default code when it carries none (typed errors keep theirs).
export async function coded<T>(code: Code, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (isPlyThrown(e) || setCode(e, code)) throw e;
    throw thrown(code, thrownText(e), { cause: e });
  }
}

// A thrown value's `name` is `want` (an AbortError, a TimeoutError). Any value may be thrown: a primitive has no name.
const nameIs = (e: unknown, want: string): boolean => { const n = field(e, 'name'); return n.tag === 'some' && n.value === want; };
// A platform fetch failure → the PlyError it is: aborted or timeout when the signal fired or the error says so, else
// network. A typed error passes through.
export function wrapNet(e: unknown, signal: AbortSignal | null = null): unknown {
  if (isPlyThrown(e)) return e;
  const aborted = signal !== null && signal.aborted;
  if (aborted || nameIs(e, 'AbortError') || nameIs(e, 'TimeoutError')) {
    const timedOut = nameIs(e, 'TimeoutError') || (signal !== null && nameIs(signal.reason, 'TimeoutError'));
    return thrown(timedOut ? 'timeout' : 'aborted', `request aborted: ${thrownText(e)}`, { cause: e });
  }
  return thrown('network', `network: ${thrownText(e)}`, { cause: e });
}
