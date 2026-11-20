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

### Fixed

- A push answered with an empty side-band band 3 (Cloudflare Artifacts under a same-ref race) no longer comes back as
  `cas_conflict` when it had landed. Since #225 ply read the ref after that answer and called every tip but the pushed
  commit `cas_conflict` (`RETRY`: `fresh`), so a push that landed and was then built on by another writer was redone
  by the caller, or by `editFile` / `commitChanges` / `pushTree` themselves, and the change was applied twice. The
  outcome for the same answer is now: ok when the tip is the pushed commit or the pushed commit is an ancestor of the
  tip; `cas_conflict` when the ref moved and does not hold the commit; `ambiguous` (`RETRY`: `read`) when the ref has
  not moved (this was `cas_conflict` with `expected` equal to `actual`), when the push did not carry the commit itself
  (a ref-only update or create, a tag, `pushPack`: these were `cas_conflict` whenever the tip was elsewhere), or when
  at most `limits.maxPushSettleCommits` commits read from the tip do not settle it. SAFETY.md I36.
  (#327; corrects #225)

### Changed

- An ok result of `push`, and of the operations that push a commit they built (`editFile`, `commitChanges`,
  `pushTree`, `mergeBranch`), can now name a commit that is not the ref's tip: the push landed and another writer
  moved the ref before ply read it (only after the empty band 3 above). With `verify: true` such a result is ok, not
  `ambiguous`: the read that settled the push is the verification, recorded as `<op>.verify.ref`, and the ref is not
  read again. (#327; corrects #225)
- A path walk makes fewer requests on a server that takes `filter combine:blob:none+tree:K` (a git with
  `uploadpack.allowFilter`: GitLab, Codeberg, self-hosted): `readFile`, `listTree`, `walkCommit`, `walkPath` and
  `editFile` (and a `commitChanges` routed to it) read two tree levels per fetch, where #218 gave `readFile` and
  `listTree` the first two levels only and `editFile` none. A path of n components is ceil(n / 2) + 2 requests for
  `readFile` (n + 3 before; one more for `editFile`). It applies on a first contact too: while a `quirks` record does
  not yet know whether the server takes the filter, the commit (or the first tree) is asked both ways at once, so a
  first contact is one request more than that, and on GitHub (which refuses the filter) one request more than
  before, once per record, with no round trip added. A new record for a server that refuses `tree:0` (Cloudflare
  Artifacts) or takes no filter now sees that one request as well, beside its one refused `tree:0`; a record that
  already says `treeFilter: 'blob:none'` or `'none'` is never asked. Results are unchanged: the same commit, trees and
  blob. `limits.maxPathTreesBytes: 0` restores one tree per fetch. (PR number pending)

### Added

- `PushResult.readBack`: `null` for a push its report settled; the tip ply read for one settled after an empty band 3.
  `limits.maxPushSettleCommits` (default 8, also in `WORKER_LIMITS`; 0 reads none): the commits read from that tip,
  one fetch each. (#327; corrects #225)
- `limits.maxPathTreesBytes` (default 1 MiB, also in `WORKER_LIMITS`; 0 never asks): the budget of one path-trees
  fetch, in place of `maxPackBytes` and `maxInflatedTotal` for that fetch (at most 341 trees). An answer over it is
  dropped and that walk reads one tree per fetch from there; it never fails an operation. Before, the #218 fetch ran
  under `maxPackBytes` and `maxInflatedTotal` themselves. (PR number pending)
- `ply/fetch` exports `treeWithTrees(transport, oid, filter)`: a tree and the trees `filter` brings from under it,
  read and checked as `commitWithTrees` reads a commit's. (PR number pending)

### Telemetry

- `git.receive-pack`: `git.push.ambiguous.resolved` (set only after an empty band 3) gains the values `ancestor`
  (landed, the ref moved on), `unchanged`, `unproven` and `unknown` (each still `ambiguous`), beside `landed`,
  `cas_conflict` and `unread`. No key is added or retyped. (#327; corrects #225)
- `git.upload-pack fetch`: `git.fetch.path_trees` (and the `git.fetch.wide.*` keys beside it) now also appears on
  fetches under `git.edit` and on tree wants, with the value `combine:blob:none+tree:1` for a tree; such a fetch that
  is over `limits.maxPathTreesBytes` ends with `error.type: limit_exceeded` while its operation succeeds. `git.read`,
  `git.ls_tree` and `git.edit` have fewer `git.upload-pack fetch` children where the server takes the filter, and a
  `git.read.tree` / `git.edit.tree` span may have none (its tree came with the level above). Nine keys ply already
  emitted (`git.fetch.path_trees` and eight `git.fetch.wide.*`) are added to `test/span-contract.json` on the fetch
  spans under `git.read`, `git.ls_tree`, `git.edit` and `git.commit > git.edit`; no key is removed or retyped.
  (PR number pending)

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
