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
import { thrown as fail, isPlyCode } from './errors.js';
import type { Limits } from './limits.js';
import type { Span, Tracer } from './otel.js';
import { KIND } from './otel.js';

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

// A thrown value read loosely, as the JS read it: `?.` makes the read safe for any value. TODO(A3): Results replace it.
export type Loose = { readonly code?: unknown; readonly message?: unknown; readonly name?: unknown } | null | undefined;

// We are not git and do not claim to be: servers that branch on the agent string get the truth.
export const UA = 'ply/0.1.0';
export const proto = (msg: string): ErrorOf<'protocol'> => fail('protocol', msg);

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

// Give an untyped failure a default code (typed errors keep theirs). The assignment throws for a primitive, null or a
// frozen value; that one is wrapped instead.
export async function coded<T>(code: Code, fn: () => Promise<T>): Promise<T> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, no-ex-assign -- see Loose; any thrown value is assigned to as the JS did, and replaced when it cannot be
  try { return await fn(); } catch (e) { if (!isPlyCode((e as Loose)?.code)) { try { (e as { code: unknown }).code = code; } catch { e = fail(code, String((e as Loose)?.message ?? e), { cause: e }); } } throw e; }
}

export function wrapNet(e: unknown, signal?: AbortSignal | null): unknown {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see Loose
  if (isPlyCode((e as Loose)?.code)) return e;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/restrict-template-expressions -- see Loose; a thrown value renders as String() renders it
  if (Boolean(signal?.aborted) || (e as Loose)?.name === 'AbortError' || (e as Loose)?.name === 'TimeoutError') return fail((e as Loose)?.name === 'TimeoutError' || (signal?.reason as Loose)?.name === 'TimeoutError' ? 'timeout' : 'aborted', `request aborted: ${(e as Loose)?.message ?? e}`, { cause: e });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/restrict-template-expressions -- as above
  return fail('network', `network: ${(e as Loose)?.message ?? e}`, { cause: e });
}
