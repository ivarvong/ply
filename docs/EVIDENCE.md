# Evidence index

What ply claims in its headline, what each claim covers, the test or benchmark behind it, how to rerun it, and what is
known not to hold. This page is an index: the detail lives in the files it links. Issues are on
[ivarvong/ply](https://github.com/ivarvong/ply/issues).

How to read the "kind" column:

- **tested invariant**: a test asserts it on every run, over the inputs that test generates or enumerates. It is
  empirical evidence over those inputs, not a formal proof.
- **measured result**: a number recorded from one run, on one commit and one machine. Labelled **historical** when the
  record does not name the commit, or when it was not rerun for this page.
- **limited claim**: holds for the named operation or environment only.

Reruns for this page: source commit `1991256` (the parent of the commit that added it), Node 22.23.5, git 2.43.0,
Linux, 4 CPUs, workerd 1.20261018.1 (the pinned devDependency). The results are recorded in each section's
"Reproduce" table.

Where the repository's own documents say more than this page, this page is the narrower statement; see
[Conflicts with other documents](#conflicts-with-other-documents).

## 1. Bounded memory

**Claim.** Each operation's memory is bounded by the limits record it runs under (`DEFAULT_LIMITS`, `WORKER_LIMITS`
or the caller's, all in [src/limits.ts](../src/limits.ts)). What the bound scales with depends on the operation. There
is no library-wide constant-memory claim: several operations hold memory that grows with tree size, object count or
the bytes they buffer.

| Operation | Does not grow with | Grows with | Configured limits | Evidence | Kind |
|---|---|---|---|---|---|
| `editFile` (and a `commitChanges` whose only change is one `edit` on an existing parent, routed to it by `streamIfEdit` in [src/changes.ts](../src/changes.ts)) | the edited blob's size | the commit and every tree on the path, each held whole; path depth; `find` and `replace` lengths | `maxObjectSize`, `maxTreeEntries`, `maxPathDepth` | [test/edges.test.js](../test/edges.test.js) "large blob (24 MB)": `mem.alloc.max_single` ≤ 65,536; [test/fuzz/run.mjs](../test/fuzz/run.mjs): ≤ 70,000 + \|find\| + \|replace\| on every case; [test/workerd.test.js](../test/workerd.test.js) 24 MB edit | tested invariant on ply's own allocation counter (`memAttrs` in [src/edit.ts](../src/edit.ts)), not a heap measurement |
| Pack scan: `scanPack`, the `parsePack*` and `inflate*` pulls under `WORK_BUDGET`, `inflateChunks`, `pktFrames` | pack size, object size | the chunks the caller keeps | `peakBound` in [src/streambound.ts](../src/streambound.ts): `INFLATE_WINDOW` + `INFLATE_CHUNK` + `PKT_MAX_SIZE` = 114,672 B | [test/stream-memory.test.js](../test/stream-memory.test.js): peak live `arrayBuffers` ≤ the bound, each cell in its own process at a 64 MiB and a 128 MiB V8 heap | tested invariant (live `arrayBuffers`, not RSS) |
| `fetchObject`, `fetchPack`, `fetchWide` | the pack bytes not retained | the bytes retained (R), plus the scan bound | `maxPackBytes`, `maxInflatedTotal`, `maxObjectSize` | [test/stream-memory.test.js](../test/stream-memory.test.js) fetch cells | tested invariant |
| `readFile`, `openBlob` | blob size (by design: `peakBound` kind `blob-read`) | each tree on the path, fetched whole, one per level | `maxPackBytes` | no cell in [test/stream-memory.test.js](../test/stream-memory.test.js); the limit sweep's `workerd.readFile.*` cells record RSS ([test/sweep/matrix.mjs](../test/sweep/matrix.mjs)) | design bound; not asserted by a heap test |
| `scanPackIndex` | object size | object count: `SCAN_INDEX_ENTRY_BYTES` (31) per entry, plus 20 per entry for each oid column in use | `maxPackObjects` | [test/stream-memory.test.js](../test/stream-memory.test.js): 200,000 entries at 51 B per entry | tested invariant |
| `resolvePackRange` | pack size, chain depth | object count (`RESOLVED_ENTRY_BYTES`, 41 per entry), plus max(`maxObjectSize`, `maxDeltaResult`) + 3 × `maxDeltaResult` + `cacheBytes` | `maxObjectSize`, `maxDeltaResult`, `maxResolveWork`, `maxDeltaChain` | [test/resolve-memory.test.js](../test/resolve-memory.test.js) | tested invariant; see #299 |
| `planPackBatches`, `planTransfer`, `decodeSavedIndex` | | object count; nothing refuses before a V8 out-of-memory at 1M objects under a 128 MB heap (#298, #299) | `maxPackObjects` (default 100,000; #267) | [test/pack-plan.test.js](../test/pack-plan.test.js) heap figures in README are **historical** (no commit named) | known gap |
| Buffered paths: `parsePack`/`resolvePack`, `checkoutTree` blob batches, `pushTree`, `commitChanges`, `pushRepo`, merges | | the bytes held, each object charged `LIMIT_OBJECT_OVERHEAD` (3 KiB) on top | `maxInflatedTotal`, `maxPushBytes`, `maxPackBytes`, `maxMergeBlobBytes` | [SAFETY.md](../SAFETY.md) I4, [test/adversarial.test.js](../test/adversarial.test.js) | limit-enforced: a refusal (`limit_exceeded`) past the cap, not a constant |
| `packSubset` | the source pack's size | 17 B per selected entry, 5 per source entry (README, from the code) | | README: half of a 537 MB source written with 6 KB live, Node 24, [test/pack-subset-child.mjs](../test/pack-subset-child.mjs) | measured result, **historical** (no commit named) |

**Platform evidence, and what it is not.**

- The limit sweep ([test/sweep/run.mjs](../test/sweep/run.mjs)) runs each cell in a fresh Node process on the default
  heap and at `--max-old-space-size=128`, and some cells once in a fresh workerd process. Its pass condition is that
  each cell refuses or succeeds as expected, so it shows survival under a 128 MiB V8 heap. It is not a peak-memory
  measurement. Each cell records RSS in its own report.
- [bench/worker-mem](../bench/worker-mem/README.md) runs scans, reads, bombs, index, resolve and push cells in a
  deployed Cloudflare Worker. Its evidence is the platform outcome (no `exceededMemory`). That is survival on the
  platform, not a measured peak, and its own README says the heap profiles are allocation sampling, not in-use memory.
  No report is committed (reports are gitignored), so the repository holds no result from it. #301 records that its
  telemetry join drops invocations the platform killed, so its outcomes column cannot show `exceededMemory` at all
  until that is fixed.

**Known gaps.** #298 (plan heap out-of-memory at 1M objects with no refusal; plan CPU per million objects), #299
(index held whole by every stage; `decodeSavedIndex` holds it twice; one more whole object held than the documented
resolve peak; resolve work quadratic in REF deltas that share a base), #302 (index and plan memory at 1M objects),
#267 (the 100,000-object default refuses a Linux kernel HEAD checkout), #286 (the scan-stream branch's memory effect was
never measured), #301 (worker-mem harness defects listed above).

**Reproduce.**

| Command | What it checks | Run for this page |
|---|---|---|
| `npx vitest run test/stream-memory.test.js test/resolve-memory.test.js` | scan, fetch, index and resolve bounds | passed (with the edges and push-tree files below: 5 files, 49 passed, 2 skipped, the skips are darwin-only push-tree tests) |
| `npx vitest run test/edges.test.js` | 24 MB edit: allocation counter, push size, bytes | passed (same run) |
| `npm run fuzz -- --n 20 --seed 1` | per-case allocation and push-size bounds, git-verified | passed: 20 cases, 0 failures |
| `npm run sweep -- --ci` | sweep cells at or under 16 MiB and 65,536 entries | passed: 332 cells, 653 runs, 0 divergences; see [Sweep run](#sweep-run) |
| `npm run sweep -- --full` | the full sweep (nightly) | not run |
| `npm run bench:worker-mem -- --cells ...` | the deployed Worker cells | not run: needs a Cloudflare account and deployment |

## 2. Delta pushes

**Claim.** `editFile` pushes its change as deltas: the blob as a REF_DELTA against the old blob and each tree on the
path as a delta against the tree it replaces, plus the new commit, whole. Push size grows with the replacement's length
and the path depth, and with the blob's size by one copy op per 64 KiB of base (git's delta format); it does not carry
the blob's content. A 24 MB blob edit pushes between 500 and 1,500 B (asserted).

| Operation | What is sent as a delta | What is sent whole | Preconditions and exclusions | Evidence | Kind |
|---|---|---|---|---|---|
| `editFile` | the blob (`spliceDelta`: copy, insert, copy, from the match offset), each tree on the path | the commit; a blob delta shorter than `DELTA_SIZE_MIN` (4 bytes) is sent as the full blob (`buildCommitObjects`, [src/commit-build.ts](../src/commit-build.ts)) | `find` matches exactly once; the server accepts a thin pack whose bases it holds | [test/fuzz/run.mjs](../test/fuzz/run.mjs) asserts push bytes ≤ 220 + 80·depth + \|replace\| + ⌈\|replace\|/127⌉ + 5·⌈\|replace\|/16 KiB⌉ + 16·⌈\|blob\|/64 KiB⌉ + 40 on every case; [test/edges.test.js](../test/edges.test.js): 24 MB blob, 500 < push < 1,500 B; path depth 100, push < 102·80 + 400 B; [test/workerd.test.js](../test/workerd.test.js): 24 MB, push < 1,500 B | tested invariant |
| `pushTree` repeat pushes | each changed tree, as a REF_DELTA, when the delta is at least `DELTA_SIZE_MIN` and smaller than the tree (`selectObjects`, [src/tree.ts](../src/tree.ts)) | every blob the parent's trees do not name; a blob present only in older history is sent again | the parent's trees are the only base consulted | [test/push-tree.test.js](../test/push-tree.test.js): the objects sent equal `git rev-list --objects new ^old` | tested invariant (object set); the byte figures in README "Pushing a whole tree" are **historical** (no commit named) |
| `commitChanges` (anything but a single `edit` on an existing parent) | | the new trees and blobs (header comment of [src/changes.ts](../src/changes.ts)) | | | limited claim: no delta |
| `pushRepo` | OFS_DELTA against the previous version of the same path, chains of at most 50 (`planDeltas`, [src/delta.ts](../src/delta.ts)); REF_DELTA against a remote base only with `thin: true` | first versions of paths without `thin` | Node only | [test/push-repo.test.js](../test/push-repo.test.js) | limited claim |
| `pushPack` | the caller's pack, untouched | | | | not a delta claim |

Every pack ply builds is checked by git: `git index-pack --strict` and `receive-pack` accept it and the oids match git's
([SAFETY.md](../SAFETY.md) I12, [test/fuzz/packgen.mjs](../test/fuzz/packgen.mjs); `index-pack --fix-thin` on thin
packs in [test/oracle.test.js](../test/oracle.test.js)).

**Compared with native Git.** `npm run bench:compare` ([bench/compare/README.md](../bench/compare/README.md), #323) runs
one read and one single-file edit, commit and push with ply and with four native Git strategies against the same
git http-backend, and verifies every sample (content, parentage, `git fsck --strict`). One recorded run, on a loaded
shared machine, is in [bench/compare/results](../bench/compare/results/README.md): a measured result on loopback, which
does not predict WAN latency and says nothing about Workers memory. Against the leanest Git strategy measured (a
depth-1 blobless clone), ply's process memory in that run was higher in every cell except the 32 MiB edit, and its
fresh-process elapsed time was higher on reads and on edits up to 64 KiB; ply was lower on the 32 MiB edit and on edits
from a warm process, whose timing excludes process start-up.

**Recovery from a lost or ambiguous push.** [examples/recover-push.mjs](../examples/recover-push.mjs) (#324) is a tested
recipe, run by [test/examples.test.js](../test/examples.test.js); what refs and history cannot settle is listed in
[examples/README.md](../examples/README.md).

**Known gaps.** #298 (an unpinned `commitChanges` that loses a race is re-applied on the winner's tip; transfer arms
without tests), #302 (a buffered push whose `fetchImpl` rejects without sending is still `ambiguous`).

**Reproduce.**

| Command | What it checks | Run for this page |
|---|---|---|
| `npx vitest run test/edges.test.js test/push-tree.test.js` | 24 MB and depth-100 push size; repeat push object set | passed (the memory run above) |
| `npm run fuzz -- --n 20 --seed 1` | push-size bound per case | passed: 20 cases, 0 failures |
| `npm run fuzz:packgen -- --n 20 --seed 1` | built packs accepted by `index-pack --strict` | passed: 19 ok, 1 skipped (a noop edit), exit 0 |

## 3. Git correctness

**Claim.** What ply writes, git accepts and computes the same way; what ply reads, it reads as git does. This is
checked by running real git as the oracle over enumerated or generated inputs. It is empirical: it covers the inputs
those tests enumerate or generate, on the git versions they run against.

| Surface | Oracle | Evidence | Kind |
|---|---|---|---|
| Every successful `editFile` | ref, blob bytes, `diff --name-only`, parent, mode, `git fsck --strict` with `receive.fsckObjects` | [SAFETY.md](../SAFETY.md) I3; [test/fuzz/run.mjs](../test/fuzz/run.mjs), [test/adversarial.test.js](../test/adversarial.test.js), [test/edges.test.js](../test/edges.test.js) | tested invariant |
| Fetch object selection | `git pack-objects` as upload-pack invokes it, plus a model bound | [test/protocol.test.js](../test/protocol.test.js) (14,256 cells), [test/fuzz/protocol.mjs](../test/fuzz/protocol.mjs); [SAFETY.md](../SAFETY.md) "Protocol semantics" | tested invariant |
| Idents, refs, tree names and encoding, commits, push outcomes, pack reading | git's own commands, per [SAFETY.md](../SAFETY.md) "Git compliance" | [test/compliance.test.js](../test/compliance.test.js), [test/parity.test.js](../test/parity.test.js), [test/push.test.js](../test/push.test.js) | tested invariant |
| Decision spaces (each decision's axes enumerated and judged by git) | real git per cell | [SPACES.md](../SPACES.md), [SPACE.md](../SPACE.md); gate [test/space/registry.test.js](../test/space/registry.test.js) | tested invariant; SPACES.md reports 26 unregistered decision points and 30 unreached fail sites |
| Server behaviours (Cloudflare Artifacts and git http-backend) | git http-backend in the suite; recorded Artifacts runs | [COVERAGE.md](../COVERAGE.md) (generated; [test/behaviours/matrix.test.js](../test/behaviours/matrix.test.js) fails on drift): 118 behaviours, 106 verified, 2 implemented, 10 unsupported | tested invariant for the git http-backend column; the Artifacts column rests on recorded runs whose verdicts are private ([test/behaviours/runs.ts](../test/behaviours/runs.ts)) |

**Preconditions and exclusions** (from [SAFETY.md](../SAFETY.md) "Explicitly not tested here" and README
"Requirements"): SHA-1 repositories only (SHA-256 is `unsupported`); protocol v2 for reads; criss-cross merges are
refused; rename detection is not ported, so rename shapes are conflicts; server-side attribute sources and custom merge
drivers are not visible; GitHub's receive-pack policy layer was not exercised. CI uses the runner image's git, which
[.github/workflows/ci.yml](../.github/workflows/ci.yml) does not pin.

**Known gaps.** #321 (nightly `fuzz/protocol.mjs --n 5000` failed or timed out on `1991256`, the commit these reruns
used), #289 (`v2Step` accepts `ACK junk`), #302 (git's rename pairing and `patch-id` not ported), #292 (checks only CI
runs), #293 (fuzz, sweep and bench git calls outside the git shim), #287 (mutation gate scope), #291 (line-merge step
counts depend on git's rediff mode), #318 (`pack_corrupt` retryability), #296 and #319 (entry points that throw on
`null` instead of returning `bad_request`), #300 (smaller API correctness findings).

**Reproduce.**

| Command | What it checks | Run for this page |
|---|---|---|
| `npm run test:oracle` | oracle, concurrency and edges suites against real git | passed: 3 files, 17 tests |
| `npx vitest run test/behaviours/matrix.test.js` | COVERAGE.md matches the matrix | passed (the memory run above) |
| `npm run fuzz -- --n 20 --seed 1` | steered edits against git http-backend | passed: 20 cases, 0 failures |
| `npm run test:protocol` | the 14,256-cell fetch matrix | not run (about 4 min per README) |
| `npm run test:git` | compliance, parity and the 768-cell push matrix | not run (about 15 min per README) |
| `npm run test:adversarial` | hostile-server faults and invariants I1 to I6 | not run |

## 4. Runtime portability

**Claim.** ply runs where `fetch`, `CompressionStream`/`DecompressionStream`, `crypto.getRandomValues` and `Uint8Array`
exist: Node 20 and later, Cloudflare Workers, and browsers behind a CORS proxy (README "Requirements"). `ply/tree-node`,
`ply/checkout-node` and `ply/repo-node` are Node only. What is tested differs by runtime:

| Runtime | What is checked | Evidence | Kind |
|---|---|---|---|
| Node 22 | the full suite | CI `test-shard` jobs run on Node 22 ([.github/workflows/ci.yml](../.github/workflows/ci.yml)) | tested invariant |
| Node 20, 24 | the packed tarball installs with `--ignore-scripts`, every subpath imports, `require('ply')` behaves as README "Install" states | CI `pack` job; [scripts/pack-check.mjs](../scripts/pack-check.mjs), [test/pack-install.test.js](../test/pack-install.test.js) | limited claim: import and install only; the behaviour suites do not run on 20 or 24 in CI |
| workerd (local) | edits (including 24 MB), reads, pushes, timeouts, cancellation, signing, redirects, 10 concurrent writers, git-verified | [test/workerd.test.js](../test/workerd.test.js) against the pinned `workerd` devDependency; sweep `workerd.*` cells | tested invariant on local workerd; local workerd does not enforce CPU, subrequest or isolate-memory limits ([SAFETY.md](../SAFETY.md)) |
| Cloudflare Workers (deployed) | streaming cells inside a 128 MB isolate | [bench/worker-mem](../bench/worker-mem/README.md), manual | limited claim: no committed result; see section 1 |
| Browsers | the shipped `.d.ts` compiles under the `DOM` lib | [test/dist-types.test.js](../test/dist-types.test.js), `npm run check:dist` | types only; no browser runtime test in the repository |
| TypeScript consumers | `.d.ts` compiles with `@types/node` 20, 22, 24, `DOM`, `@cloudflare/workers-types` | [test/dist-types.test.js](../test/dist-types.test.js) | tested invariant |
| Workers-safe entries carry no Node builtins | the `ply` (full), edit, read, log, tree, checkout and merge bundles contain no `node:` import; `node:fs` lives only in [src/tree-node.ts](../src/tree-node.ts), [src/checkout-node.ts](../src/checkout-node.ts), [src/repo-node.ts](../src/repo-node.ts) | [test/bundle.test.js](../test/bundle.test.js) | tested invariant; the test prints each bundle's size and does not gate it (#301), and README quotes no sizes |

**Known gaps.** #326 (no versioned release artifact or compatibility policy yet). No issue owns a browser runtime test.

**Reproduce.**

| Command | What it checks | Run for this page |
|---|---|---|
| `npm run test:workerd` | the workerd suite | 14 passed, 1 failed: the Ed25519 signing test, because `ssh-keygen` is not installed on this machine (git's verifier needs it); the other 14 passed |
| `npx vitest run test/dist-types.test.js test/bundle.test.js` | consumer type checks; bundle contents | passed: 2 files, 16 tests |
| `npm run check:pack` | pack, install, import on the current Node | not run |

## Sweep run

`npm run sweep -- --ci` at `1991256`, Node 22.23.5, workerd 1.20261018.1: 332 cells, 653 runs (default heap, a
128 MiB heap, or one workerd process), exit 0, `ratchet held 0, divergences 0, stale 0`. The report is written to
`reports/sweep/` (gitignored).

The RSS each cell prints is the whole process, measured once. The 108 Node `parse.*` cells, which refuse a bad limits
record before any request, printed 88 to 100 MB, so most of a cell's RSS is the runtime, not ply. Selected cells, as
printed (one run each; not a basis for a scaling claim):

| Cell | Heap | Outcome | RSS |
|---|---|---|---|
| `edit.file.1048576` | default / 128 MiB | ok | 110 / 114 MB |
| `edit.file.16777216` | default / 128 MiB | ok | 126 / 113 MB |
| `workerd.readFile.16777216` | workerd | ok | 159 MB |
| `workerd.readFile.cap1MiB.1048577` | workerd | refused `limit_exceeded` | 79 MB |
| `workerd.push.object.16777216` | workerd | ok | 82 MB |

## Conflicts with other documents

Statements elsewhere in the repository that said more than the evidence above, kept as the record of what was
narrowed. README.md was corrected in the commit that added this page; the other rows were corrected for #301.

| File | Statement | Why it is narrower here |
|---|---|---|
| README.md, first line (corrected) | "edits one file in a remote repo in **O(1) memory**" | the edit holds the commit and the trees on its path whole; the bound is in the blob's size only |
| README.md "Memory" (corrected) | "Peak per invocation is one pkt-line + one inflate chunk + carry + replacement … `mem.alloc.max_single` max = 16384" | the commit and trees were left out of the peak; `mem.alloc.max_single` is the largest single allocation ply counts, not a peak; the 446-edit run has no commit or record |
| README.md "The fuzzer" (corrected) | "max single allocation ≤ 70 KB regardless of blob size" | [test/fuzz/run.mjs](../test/fuzz/run.mjs) allows 70,000 + \|find\| + \|replace\| |
| [SAFETY.md](../SAFETY.md) I7 (corrected) | "Memory is O(1) in blob size and repo size" | `editFile` holds the trees on its path whole; index, resolve and plan memory grow with object count (#298, #299); the cited evidence is ply's allocation counter, not a heap measurement |
| [SAFETY.md](../SAFETY.md) (corrected) | "Invariants and where they are proven" | the checks are empirical tests, not proofs |
| [CONTEXT.md](../CONTEXT.md) sections 1 and 4 (corrected; §4 labelled historical) | "Edit one file in a huge repository in O(1) memory" | as SAFETY.md I7 |
| [bench/worker-mem/README.md](../bench/worker-mem/README.md) (corrected) | "A manual harness that proves ply's streaming paths stay inside real Cloudflare Workers limits" | platform survival on the cells run, with no committed report, and an outcome join that drops killed invocations (#301) |
