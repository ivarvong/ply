// The coverage matrix's types: a server behaviour, the ply operations and tests that exercise it, and its status.
// The unit of progress is an independently validated server behaviour, not a git command (t229u). Illegal states
// are not representable: a `verified` status carries at least one piece of evidence; evidence against git
// http-backend names a test in this repository, evidence against Artifacts names a recorded run and one of its checks;
// a behaviour ply cannot exercise names no ply operation, and one it can names at least one.
import type { RunRefFor } from './runs.js';

export type NonEmpty<T> = readonly [T, ...T[]];

// The areas of server behaviour, in the order COVERAGE.md lists them.
export const AREAS = ['refs', 'caps', 'fetch', 'pack', 'push', 'concurrency', 'tags', 'ancestry', 'errors', 'interrupted', 'http'] as const;
export type Area = (typeof AREAS)[number];

export const AREA_TITLES: { readonly [A in Area]: string } = {
  refs: 'Ref advertisement and ls-refs',
  caps: 'Capabilities and protocol v2',
  fetch: 'Fetch: negotiation, filters, shallow, include-tag, thin packs',
  pack: 'Packfiles: OFS/REF deltas, thin bases, malformed packs (served and pushed)',
  push: 'Push and receive-pack',
  concurrency: 'Concurrent updates and stale refs',
  tags: 'Tags (lightweight and annotated)',
  ancestry: 'Merges and rebases as ancestry exercisers',
  errors: 'Error conditions (auth, not found, limits, corrupt input)',
  interrupted: 'Interrupted operations',
  http: 'HTTP transport (smart HTTP, sideband, keepalive, large bodies)',
};

// A behaviour id is `<area>.<slug>`: the area is part of the id, so an id filed under the wrong area does not type.
export type BehaviourId<A extends Area> = `${A}.${string}`;

// A ply operation: an exported function of a src/ module. test/behaviours/matrix.test.js greps the module for the export.
export type PlyOp = { readonly module: `src/${string}.ts`; readonly symbol: string };

// A test in this repository and an anchor: text the file contains (a test name, or the line that drives the case).
// matrix.test.js fails if the file is missing or the anchor is not in it, so no mapping is asserted from memory.
export type TestRef = { readonly tag: 'test'; readonly path: `test/${string}`; readonly anchor: string };

// Who exercised the server and who judged it.
//   ply_vs_reference_git     ply against git http-backend in this repository's suite, git's own output the expected
//                            value (matrix.test.js checks the cited file runs real git)
//   ply_vs_artifacts         ply against Cloudflare Artifacts in a recorded run
//   native_git_vs_artifacts  stock git against Artifacts in a recorded run (git http-backend beside it as baseline)
//   wire_probe_vs_artifacts  hand-built requests (pkt-lines, packs, HTTP framing) against Artifacts in a recorded run,
//                            beside a git http-backend baseline: neither ply nor stock git sends these bytes
export const EVIDENCE_KINDS = ['ply_vs_reference_git', 'ply_vs_artifacts', 'native_git_vs_artifacts', 'wire_probe_vs_artifacts'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export type RunEvidenceKind = Exclude<EvidenceKind, 'ply_vs_reference_git'>;

export type Evidence =
  | { readonly kind: 'ply_vs_reference_git'; readonly ref: TestRef }
  | { readonly kind: 'ply_vs_artifacts'; readonly ref: RunRefFor<'ply_vs_artifacts'> }
  | { readonly kind: 'native_git_vs_artifacts'; readonly ref: RunRefFor<'native_git_vs_artifacts'> }
  | { readonly kind: 'wire_probe_vs_artifacts'; readonly ref: RunRefFor<'wire_probe_vs_artifacts'> };

// Evidence that does not involve ply: all a behaviour ply cannot exercise may carry.
export type OtherEvidence = Extract<Evidence, { readonly kind: 'native_git_vs_artifacts' | 'wire_probe_vs_artifacts' }>;

// unsupported  ply has no operation that exercises it (`why` says so); others may have observed the server
// implemented  ply can exercise it; nothing independent has checked the server's answer
// verified     at least one independent check, of any kind
export type Status =
  | { readonly tag: 'unsupported'; readonly why: string; readonly observed: readonly OtherEvidence[] }
  | { readonly tag: 'implemented' }
  | { readonly tag: 'verified'; readonly evidence: NonEmpty<Evidence> };

type Common<A extends Area> = {
  readonly id: BehaviourId<A>;
  readonly area: A;
  readonly description: string;
  // Any test that exercises it, including ones with a fake server; evidence is the subset an independent judge decides.
  readonly tests: readonly TestRef[];
  readonly notes: readonly string[];
};

export type BehaviourIn<A extends Area> =
  | (Common<A> & { readonly ops: readonly []; readonly status: Extract<Status, { readonly tag: 'unsupported' }> })
  | (Common<A> & { readonly ops: NonEmpty<PlyOp>; readonly status: Exclude<Status, { readonly tag: 'unsupported' }> });

export type Behaviour = { readonly [A in Area]: BehaviourIn<A> }[Area];
