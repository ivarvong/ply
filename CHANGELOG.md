# Changelog

User-visible changes to ply, newest first. The versioning and compatibility rules are in
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md); how a version is prepared and checked is in
[docs/RELEASING.md](docs/RELEASING.md).

## How to record a change

- **What goes here:** anything a consumer can observe from the package: an export added, removed or renamed; a
  signature, option, default or limit that changed; an error `code`, `what` or outcome class (`RETRY`) that changed for
  the same input; a span name, kind, parent or attribute key added, removed or retyped (`test/span-contract.json`); a
  supported runtime added or dropped; a change to what the tarball contains or how it installs.
  Not here: tests, CI, refactors, benchmarks, docs that describe unchanged behaviour.
- **Where:** a pull request with a user-visible change adds a line under `## Unreleased`, in one of **Breaking**,
  **Added**, **Changed**, **Fixed** or **Telemetry**, ending with its PR number (or commit sha).
- **Migration steps:** a **Breaking** line says what to change in the calling code, on the line itself or in an indented
  `Migration:` line under it. A telemetry removal or rename names the old and new span or key.
- **At release preparation:** `## Unreleased` is renamed to `## <version>` (the version in package.json) and a new
  empty `## Unreleased` is put above it. `npm run release:prepare` refuses when there is no `## <version>` section or
  when `## Unreleased` still lists entries.

## Unreleased

_Nothing yet._

## 0.2.0

`package.json` has said 0.2.0 since 62f71ce (2026-11-02). No 0.2.0 artifact has been tagged or published: consumers pin
commits (`github:ivarvong/ply#<sha>`). This section lists the user-visible changes from 62f71ce to the commit this file
was written at, taken from `git log`; earlier history (0.1.0, 63acbc1) is in `git log` only. Changes that landed and
were reverted within this range (the Cache API blob cache, #228 then #231) are not listed.

### Breaking

- Errors are values: every public function that can fail returns a `Result` (`{ ok: true, value }` or
  `{ ok: false, error }`) instead of throwing; `GitHttp.create(url, opts)` returns a `Result`; `thrown` and `orThrow`
  are gone and `fail` is `Err(plyError(…))`. Streams still error with a `PlyError`. (#180, 7b0d5ba; REFACTOR.md "0.2.0")
  Migration: test `result.ok`, then switch on `result.error.code`; `RETRY[code]` says whether to retry.
- `operation(op, url, opts, body)`: a throw from `body`, or from any callback reached from it, comes back as an `Err`
  (`what: 'callback'`, `bad_request` before the push request was handed over, `ambiguous` after), never as a throw.
  (#277, 0de5ad4; documented in #309)
  Migration: code that caught the body's own throw around `operation()` reads the `Err` and its `cause` instead
  (README "`operation()`: your body's outcomes").
- HTTP timeouts: `limits.requestTimeoutMs` is now an opt-in total (default 0, off); the defaults are
  `firstByteTimeoutMs` and `idleTimeoutMs` (60 s each). A timeout is the `timeout` error with `what` naming the limit.
  (#258, dd92d3e)
  Migration: pass `requestTimeoutMs: 60000` to keep the earlier whole-exchange cap.
- Resumable transfer: every call that takes a stored plan (`checkTransferPlan`, `transferStatus`, `transferStep`,
  `runTransfer`) must name the destination `ref` (and a custom `tempPrefix`); the earlier forms are `bad_request`.
  (#269, 8e3939d)
- `sweepTransfers` refuses a `prefix` outside `refs/ply/transfer/` (`bad_request`, `what: 'prefix'`). (#311, ed3458c)
- `readFile` refuses a `path` ending in `/` (`bad_request`, `what: 'path'`); it used to drop the slash. A `userAgent`
  that is not an RFC 9110 field value is refused when options are parsed (`what: 'userAgent'`, earlier
  `'user agent'`). Wrong-shape arguments to the pack and transfer entry points are `bad_request` naming the argument.
  (#316, 9246a39)
- Limits: `maxResolveWork` below `maxInflatedTotal`, or `null`, is refused. (#280, 8c20fc1)
- Error classes: a server that answers ls-refs only in protocol v0/v1 is `unsupported` (2e62dd0); a receive-pack
  refused for the caller is `auth` / `not_found`, not `ambiguous` (505cbf5); a host's echoed unpack failure is
  `push_rejected` (#251, c80517e); a band-3 push answer whose tip read-back shows another commit is `cas_conflict`
  (#225, dba337d); a push whose streamed body was never pulled is that request's failure, not `ambiguous`
  (#283, d28c1f9).

### Added

- Subpaths `ply/repo-node` (`pushRepo`, #188), `ply/blobcache` (size and TTL constants shared with ply-web; added in
  #228, reduced to the constants in #231)
  and `ply/probes` (the probe plans and their evaluator, a78ed24).
- `syncRef` (#193), `pushPack` (#234), `scanPackIndex` (#247), `packSubset` (#252), `resolvePackRange` (#254),
  `planPackBatches` (#256), resumable transfer (`copyTree`, `planTransfer`, `runTransfer`, `sweepTransfers`; #265,
  #260), stream adapters `scanPack`, `pktFrames`, `inflateChunks` (#241), `walkCommit` (#223).
- `listRefs` and `deleteTag` by URL, an optional tracer, plain-string refs and paths (#185); `parseTag` and `TYPE_ID`
  (#187); `WORKER_LIMITS` (#190); `limits.heldTimeoutMs` (#281); `Tracer({ onEnd })` with `EndedSpan` (#211);
  `Option` exported from the root (#315); `Transport.frames` stated as public (#239).

### Changed

- Byte budgets charge a per-object overhead (#190); refused fetch filters are remembered per remote (#190);
  `followRedirects: 'initial'` remembers how it settled per remote (#206); `readFile`/`listTree` fetch the commit and
  the path's first two tree levels in one request where the host allows it (#219); concurrent first exchanges share one
  advertisement GET (#221); receive-pack is requested in protocol v0, as git does (#232).

### Telemetry

- Additions only, checked against 62f71ce's `test/span-contract.json`: no span or attribute key was removed or retyped.
  Added spans include `git.blob.inflate` (#226), `git.push_repo` and its phases (#188), `git.branch_create`,
  `git.branch_delete` and `git.tag_create` (#185), and the limit keys `git.limits.first_byte_timeout_ms`, `git.limits.idle_timeout_ms` (#258) and
  `git.limits.held_timeout_ms` (#281).
