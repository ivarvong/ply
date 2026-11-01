## ply refactor plan (pre-1.0, breaking by design)

This document maps the current codebase and sets the target architecture for an aggressive refactor toward a small, pure core in strict functional TypeScript, inspired by Elixir/OCaml. Breaking changes are expected; no compat shims or alias fallbacks.

### Scope and priorities
1) Map the codebase: module graph, duplication, god-files, leaky types.
2) Make illegal states unrepresentable: discriminated unions, branded ids/paths/refnames, exhaustive matching.
3) Zero `undefined` in core: absence is an explicit Option/domain union; conversion from platform `undefined` happens only at a single boundary.
4) Delete dead code and collapse indirection/options-bags into explicit typed args or ADTs.
5) Keep and extend OpenTelemetry spans; keep attribution and cardinality discipline.

---

## Module graph (current)

High-level groupings from `src/`:

- Core primitives
  - `result.ts`: Result and Option, matching helpers, `assertNever`.
  - `errors.ts`, `errors-doc.ts`: typed errors, helpers and error docs.
  - `absent.ts`: the only boundary that handles platform `undefined`/nullish and funnels it into `Option`.
  - `boundary.ts`: typed edges for thrown values (code/reason/attrs), entry options.
  - `limits.ts`, `validate.ts`: limits and input validation.
  - `format.ts`: protocol and on-disk constants (modes, pack headers, etc.).
  - `bytes.ts`, `sha1.ts`: byte operations and hashing.
  - `oid.ts`: branded `Oid`, parsers for oids and commit ids.
  - `refs.ts`: refname comparison (version:refname).

- Object model and parse/encode
  - `objects.ts`: parse/encode for commit/tree/blob/tag.
  - `packresolve.ts`, `inflate.ts`, `pack.ts`: pack parsing/resolve and delta operations.
  - `pktline.ts`: pkt-line framing.

- Protocol/transport (I/O edges)
  - `transport.ts`, `http.ts`: transport frames, HTTP client integration.
  - `discover.ts`, `lsrefs.ts`, `negotiate.ts`: wire discovery, ls-refs, negotiation.
  - `fetch.ts`, `fetchpack.ts`, `push.ts`, `receivecaps.ts`: object/pack fetch and push.
  - `operation.ts`, `otel.ts`, `log.ts`: operation wrapper with tracing and span helpers.

- Tree and edits (domain core)
  - `memtree.ts`, `tree-node.ts`: in-memory tree, edits, and helpers.
  - `tree.ts`: push a tree-based change (commit-builder path).
  - `edit.ts`: single-file O(1) streaming edit; pure decisions + thin effect edges.
  - `changes.ts`: multi-change commit flow over `memtree` (create/write/delete/rename/edit).
  - `merge.ts`, `mergeio.ts`, `linemerge.ts`, `rebase.ts`: merge/rebase, line merge logic.
  - `checkout.ts`, `checkout-node.ts`: checkout flows.
  - `commit.ts`, `read.ts`: commit fetch/read helpers.
  - `client.ts`: high-level orchestration facade.

Supporting:
- `attributes.ts`, `scrub.ts`, `receivecaps.ts`, `packcache.ts`, `limits.ts`, `sign.ts`, `negotiate.ts`.

Observations:
- Effects (I/O) are already well-encapsulated in `transport.ts`, `http.ts`, and operation-scoped spans (`operation.ts` + `otel.ts`).
- `absent.ts` exists and centralizes platform nullish handling; many domain types still carry optional fields.

---

## God-files and hotspots

- Large multi-responsibility modules:
  - `merge.ts` (~45 KB): merge semantics + IO touches; split into pure merge engine and IO adapters.
  - `fetch.ts` (~37 KB): mixed concerns (sideband, inflate, object assertions); keep isolated pure step-machine cores, move wire specifics to a small edge wrapper.
  - `edit.ts` (~33 KB): mostly pure; extract reusable commit build (see duplication) and enforce branded types in public spec.
  - `read.ts` (~33 KB): reading helpers across multiple concerns; split by domain (commit/tree/blob reading) with shared Result types.
  - `tree.ts` (~25 KB), `changes.ts` (~27 KB): overlapping commit-building paths (see below).

These get split toward:
- Pure core modules (no I/O): object model, pack/parse, tree/memtree, diff/changes, edit planning, commit building.
- Thin transport/IO shells: http/fetch/push/checkout wire specifics.

---

## Duplicated or overlapping logic

- Commit building:
  - `edit.ts`: `buildCommitObjects` and `withCommitData` assemble trees bottom-up and construct the commit and pack object list.
  - `changes.ts`: `writeMem` mirrors a similar flow (encode tree, parents, sign, hash, push).
  - `tree.ts`: replicates pieces of commit assembly and push outcome handling.
  Action: extract `commit/build.ts` with:
    - `buildCommit({ parent: Oid | null, tree: Oid, author: Ident | Author, committer?: Ident | Author, message: string }): { commitData, commitOid }`
    - `planObjects({ trees, blobs, commitData }) => readonly PackObject[]`
    - Keep signing as a transform: `withSignedCommit(commitData, signer)`.

- Path/ref validation and identity shaping:
  - Repeated `validateRef`, `validatePushRef`, `validatePath`, `validateIdent`, `validateMessage` orchestration across `edit.ts`, `tree.ts`, `changes.ts`.
  Action: a small pure `validate/commitSpec.ts` to validate and normalize inputs once into a tagged union or record with branded fields.

- Single-file edit vs tree-mem edit:
  - `changes.ts` rewrites a single-file edit via `replaceOnce` (mem) while `edit.ts` streams and enforces exactly-one-match.
  Action: converge on one "exactly one match" decision core, exposed for stream and in-memory variants.

---

## Leaky types and unsafe states

- Strings for ids, paths, modes, and refnames:
  - `oid.ts` already provides branded `Oid`. Paths, refnames, and tree modes are plain strings elsewhere.
  Action: introduce branded types:
    - `Path` (normalized slash-separated, validated), `Refname` (full ref path), `BranchName` (refs/heads/*), `TagName` (refs/tags/*), `Mode` (100644 | 100755 | 120000 | 40000 | 160000).
    - Replace public surfaces that accept strings with these brands; provide safe parsers in a single boundary.

- Optional fields (`?:`) and nullable params across core types:
  - `edit.EditSpec`, `changes.CommitChangesSpec` carry `ref?`, `base?`, `committer?`, etc.
  Action: zero `undefined` in core:
    - Use explicit ADTs: e.g., `Base = { kind: 'tip' } | { kind: 'ref', ref: Refname } | { kind: 'oid', oid: Oid }`.
    - Use `Option<T>` where absence is meaningful (e.g., optional committer), surfaced only where necessary.
    - Keep platform `undefined` conversion only in `absent.ts`.

- Throwing in core decision functions:
  - Many pure decisions throw typed errors; core should prefer `Result` for all decision-level failures, with throw only at I/O boundaries or legacy entry points.
  Action: introduce `Result` returns in pure cores (`changes.ts`, `memtree.ts`, `edit.ts` selected hotspots) and wrap at entries.

---

## Target architecture (post-refactor)

Small, pure, composable cores with branded domain types and ADTs:

- object-model/
  - `oid`, `objects` (parse/encode), `format`, `bytes`, `sha1`

- pack/
  - `pack-parse` (pure step machines: pkt/pack/inflate), `delta`

- tree/
  - `memtree` (immutable-ish builders), `tree-node` helpers, `diff/changes`

- commit/
  - `spec` (validated inputs, branded), `build` (commit data), `plan` (which objects to include)

- edit/
  - `scan` (pure find/replace), `stream-edit` (effect shell), `mem-edit` (pure)

- transport/
  - `frames`, `http` (FetchLike), `operation` (spans), `otel`

Public entries remain thin orchestration shells that:
- validate and brand inputs,
- call pure cores returning `Result`,
- perform I/O through `transport` edges,
- convert platform `undefined` only via `absent.ts`.

---

## Initial concrete steps (PR sequence)

1) REFACTOR.md (this file) and a code map ownership note in `README.md` (no code changes).
2) Types and boundaries (no behaviour change):
   - Add branded `Refname`, `BranchName`, `TagName`, `Path`, `Mode`.
   - Introduce ADTs for bases/heads and unify spec validation into `commit/spec.ts`.
   - Add `assertNever` usage and exhaustive checks where discriminants already exist.
3) Zero-`undefined` in initial targets:
   - `changes.ts`, `memtree.ts`, `edit.ts`: replace optional fields with `Option` or ADTs; migrate internal decisions to `Result`.
   - Keep entry signatures temporarily but normalize immediately at the edge; follow up with public API breaks in a dedicated PR.
4) Extract commit-building core:
   - `commit/build.ts` + `commit/plan.ts`; refactor `edit.ts`, `changes.ts`, `tree.ts` to depend on it.
5) Collapse options-bags:
   - Replace unstructured options with small ADTs and explicit params; delete unused indirection and dead helpers.
6) Spans:
   - Preserve span names/attrs; add discriminant/Result kind attributes; ensure zero-alloc on hot paths.

---

## Public API break tracking (for ply-web)

Each PR will list:
- Breaking type surface changes (function signatures, exported types).
- Renamed/moved modules and symbols.
- New branded types required by callers and migration notes.

---

## Notes on CI discipline

- Green per PR (26/26 checks including limit sweep and git oracles).
- No force-push or rebase; merge `origin/main` forward when needed.
- Confirm check runs exist on each new head before proceeding to the next PR.

