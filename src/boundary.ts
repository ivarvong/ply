// Types only (no runtime): what the entry modules (edit, read, log, checkout, tree) need from modules that are still
// JavaScript. TypeScript infers an untyped JS function's parameters from their defaults, so operation.js's
// `link = null` reads as the type `null`, push.js's `objects = []` as `never[]`, fetch.js's `expectType = null` as
// `null`. A call site that passes a real value casts the callee to the signature below (each cast is marked), and a
// value a JS function returns untyped is annotated with the shape here. Each type goes when its module converts:
// operation, transport, fetch, fetchpack (T3); push (T4); objects (T2); sign (T4).
import type { Attrs, Span, Tracer } from './otel.js';
import type { Limits } from './limits.js';
import type { lsRefs } from './lsrefs.js';

// The transport record (transport.js). Untyped until T3: this is the type TypeScript infers for it, not one written here.
export type Transport = Parameters<typeof lsRefs>[0];

// A thrown value, read loosely as the JS did (`e?.code`): any field may be missing, and a primitive has none. Errors
// become values in the A pass; until then a `catch` reads them through this.
// `message` reads as a string because the JS passed it straight to RegExp#test and templates (which coerce whatever it is).
export type Caught = { readonly code?: unknown; readonly message: string; readonly attrs?: Attrs } | null | undefined;

// A fetch implementation; packcache.js's adds `attrs()` (its hit/miss counters).
export type FetchImpl = typeof fetch & { readonly attrs?: () => Attrs };
// Per-host behaviour learned from a server's answers (fetch.js, checkout.js), kept by the caller across operations.
export type Quirks = { treeFilter?: string; blobWants?: string };

// operation.js: the options every entry passes through, and what its body receives.
export type OperationOptions = {
  readonly auth?: unknown;
  // required at run time: operation() starts its root span on it
  readonly tracer?: Tracer | undefined;
  readonly parent?: Span | null | undefined;
  readonly fetchImpl?: FetchImpl | undefined;
  readonly limits?: Limits | undefined;
  readonly signal?: AbortSignal | null | undefined;
  readonly quirks?: Quirks | undefined;
  readonly transport?: Transport;
  readonly attrs?: Attrs | undefined;
  readonly link?: { readonly span: Span; readonly kind: string } | null | undefined;
  readonly onFinish?: (() => Attrs) | null | undefined;
};
export type OperationContext = {
  readonly t: Transport;
  readonly root: Span;
  readonly outcome: <T>(kind: string, result: T, extra?: Attrs) => T;
  readonly limits: Limits;
};
export type Operation = <R>(op: string, url: string, opts: OperationOptions, body: (ctx: OperationContext) => Promise<R>) => Promise<R>;

// fetch.js fetchObject: one object, whole.
export type Fetched = { readonly type: number; readonly data: Uint8Array; readonly oid: string; readonly size: number };
export type FetchObject = (t: Transport, o: {
  readonly oid: string;
  readonly filter?: string;
  readonly deepen?: number | undefined;
  readonly expectType?: number | null;
}) => Promise<Fetched>;
// fetch.js spInit/spStep/spFinish: the single-object pack stream's state, as the entries read it.
export type SpState = {
  readonly phase: string;
  readonly type: number;
  readonly size: number;
  readonly bytes: number;
  readonly zlibBytes: number;
  readonly trailer?: string;
};
// fetchpack.js fetchPack/fetchPackTree0: the resolved objects by oid (null when the server sent no pack).
export type PackObjects = Map<string, { readonly type: number; readonly data: Uint8Array }>;
export type FetchedPack = {
  readonly objects: PackObjects | null;
  readonly shallow?: readonly string[];
  readonly filter?: string;
};

// objects.js parseTree: one tree entry (the mode canonical, as git's canon_mode; oidOffset: where its oid starts).
export type TreeEntry = { readonly mode: string; readonly name: string; readonly oid: string; readonly oidOffset: number };
// objects.js TYPE_NAME, indexed by a type number read off the wire (any number: a lookup may miss).
export type TypeNames = Readonly<Record<number, string | undefined>>;

// A pack entry: a whole object, or a REF_DELTA against `baseOid`.
export type PackObject = { readonly type: number; readonly data: Uint8Array; readonly baseOid?: string };
// push.js push: one ref update; the receipt.
export type Pushed = { readonly packBytes: number; readonly entries: readonly unknown[] };
export type Push = (t: Transport, o: {
  readonly ref: string;
  readonly oldOid: string;
  readonly newOid: string;
  readonly objects: readonly PackObject[];
}) => Promise<Pushed>;

// objects.js encodeCommit, for the fields the entries write.
export type EncodeCommit = (c: {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}) => Uint8Array;

// sign.js: a commit signer (ed25519Signer).
export type Signer = {
  readonly kind: string;
  readonly publicKeyLine?: string;
  readonly sign: (message: Uint8Array, namespace?: string) => Promise<string>;
};
