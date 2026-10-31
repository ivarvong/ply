// Types only (no runtime): what the entry modules (edit, read, log, checkout, tree) read that no converted module
// declares. Each goes in the A pass (A7), when the entries stop catching thrown values.
import type { Attrs, Tracer } from './otel.js';
import type { Quirks } from './transport.js';
import type { OperationOpts } from './operation.js';
import type { FetchLike } from './http.js';

// A thrown value, read loosely as the JS did (`e?.code`): any field may be missing, and a primitive has none. Errors
// become values in the A pass; until then a `catch` reads them through this. `message` reads as a string because the
// JS passed it straight to RegExp#test and templates (which coerce whatever it is).
export type Caught = { readonly code?: unknown; readonly message: string; readonly attrs?: Attrs } | null | undefined;

// checkout's per-host fact (a server that refuses multi-blob wants), kept on the transport's quirks beside fetch's
// treeFilter; transport.ts's Quirks does not name it (T3's type, TODO(A3)).
export type CheckoutQuirks = Quirks & { blobWants?: 'single' };

// operation.ts's options as the entries take them. The entries default their options to {} as the JS did, so `tracer`
// stays optional here though operation() needs it at run time (it starts the root span on it); each entry hands its
// options to operation() through one assertion. fetchImpl may be packcache's cachingFetch, whose attrs() the edit
// reports.
export type EntryOptions = Omit<OperationOpts, 'tracer' | 'fetchImpl' | 'attrs' | 'onFinish' | 'link'> & {
  readonly tracer?: Tracer | undefined;
  readonly fetchImpl?: (FetchLike & { readonly attrs?: () => Attrs }) | undefined;
};

// objects.ts TYPE_NAME, indexed by a type number read off the wire (any number: a lookup may miss).
export type TypeNames = Readonly<Record<number, string | undefined>>;
