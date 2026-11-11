# ply — project context

This is the hand-over document: what ply is, how it is put together, how it was built, every decision that matters and
the evidence behind it, how to verify all of it again, and what is still open. README.md is the user-facing guide;
SAFETY.md is the invariant ledger (each claim, the test that proves it, the findings and the run record). This file is the
map between them.

As of 2026-10-20: 35 modules in `src/` (3,606 lines), 113 deterministic tests in 19 suites plus 16 fuzz stages in
`npm test` (≈29 min, all green), 100% line coverage of `src/` (2,461 lines, `npm run coverage`, reproducible seeds).

---

## 0. The name

**ply** — to *ply* is to work a route steadily, back and forth (a ferry plies the river): this client works the wire
between your code and a repository it never brings home. A *ply* is also one thin layer of something larger — a
one-line delta on a 10 GB repository. Renamed from *gitwire* on 2026-10-23: git's trademark policy (git-scm.com/about/
trademark, §2.3) does not allow "Git" "as a syllable in a new word or as part of a portmanteau" for a third-party
product; "… for Git" is the permitted form, so the tagline is *"ply — a git client for anywhere"*. The bare npm name
`ply` is an abandoned 0.1.0 package: publish under a scope. Everything was renamed — package name, user agent
(`ply/0.1.0`, `agent=ply/…`), request headers (`x-ply-cache`, `x-ply-pack-cache`), span attributes (`ply.*`),
`isPlyCode`, environment variables (`PLY_*`) — so traces and server logs say ply.

## 1. What ply is

A zero-dependency JavaScript git client for Cloudflare Workers (and Node), speaking git's own wire protocols — smart
HTTP (protocol v2 for fetch, v0 receive-pack for push) — with no clone, no working tree and no local object store.

What it does:

- **Edit one file in a huge repository in O(1) memory**: ls-refs → fetch the commit (`tree:0`, depth 1) → one tree per
  path level → stream the blob through inflate, find/replace and SHA-1 without holding it → push a thin pack whose blob is
  a delta against the old one (hundreds of bytes for a one-line change in a multi-GB repo). Compare-and-swap on the ref:
  a lost race is `cas_conflict`, never a clobber. Optional SSH commit signing, verification read-back, LFS-pointer guard.
- **Land branches with git operations only**: create (CAS), fast-forward, merge commit, delete; rebase, squash,
  cherry-pick, revert — all on one three-way tree merge plus a line merge ported from git's xdiff, so clean results are
  byte-for-byte what `git merge-tree` produces.
- **A general client** (ls-refs, fetch/negotiate, push, discovery) for everything else, tree-shakeable so an edit-only
  Worker carries ~42.6 KB minified.
- **Telemetry**: OTLP/JSON spans for every wire round trip and every operation, with bounded events, measured vs
  estimated CPU, cache status, retry links.

Design constraints, held throughout: zero runtime dependencies; Web APIs only in `src/` (no `node:` imports — checked by
the bundle test); pragmatic functional style (pure step functions and state machines, effects at the edges, free
functions over classes so bundlers can drop what you do not import); every wire-sized allocation bounded by `limits.js`;
every error typed (`errors.js`, one table with a retry policy).

## 2. Map of the code

Layers, bottom up (each depends only on the ones below):

| Layer | Modules | Notes |
|---|---|---|
| Codecs (pure) | `bytes`, `pktline`, `inflate`, `sha1`, `objects`, `pack`, `packresolve`, `validate` | streaming where it matters (inflate reports bytes consumed; SHA-1 is incremental) |
| Errors & limits | `errors`, `errors-doc`, `limits` | 27 codes, each with a retry policy (`yes`/`fresh`/`no`/`read`); docs kept apart so the edit bundle does not carry them |
| Transport contract | `transport`, `http` | a transport is a plain record `{ frames(service, body, span, hints), advertise(service, span) }`; one implementation (HTTP), no dispatch |
| Protocol | `lsrefs`, `fetch`, `fetchpack`, `negotiate`, `push`, `receivecaps`, `discover`, `packcache` | v2 fetch as a pure state machine (`v2Init`/`v2Step`); push report parsing pure |
| Operations | `operation`, `edit`, `tree`, `checkout`, `log`, `merge`, `linemerge`, `attributes`, `rebase`, `sign` | `operation()` owns the root span, transport, outcome and the "after an acknowledged push, any read-back failure is `ambiguous`" rule |
| Entry points | `edit.js` (edit-only bundle), `tree.js` (whole-tree push), `checkout.js` (whole-tree read), `index.js` (everything), `client.js` (`GitHttp` convenience wrapper); Node-only adapters outside every Workers bundle: `tree-node.js` and `checkout-node.js` (`node:fs`) | `sideEffects: false` |
| Telemetry | `otel` | minimal OTLP/JSON tracer; exporters pluggable (`test/jsonl.mjs` for files) |

Key operation modules:

- `edit.js` — `editFile(url, spec, opts)`: find/replace in one path, create-on-branch (`ref` + `base`), head hint (ls-refs in
  parallel with a speculative commit fetch), pack cache, signing, verify, LFS guard.
- `tree.js` — `pushTree(url, spec, opts)`: a caller-given file set (object, Map or iterable of `{ path, mode, data|oid }`,
  symlinks 120000, gitlinks 160000) as one commit, with editFile's head hint, fresh `cas_conflict` retry, `strictHead`,
  `verify`/`ambiguous`, signing and tree cache. Thin repeat pushes: the parent's trees are read only where the new tree
  differs, known blobs are not sent, changed trees go as `REF_DELTA`s. `tree-node.js` (`filesFromDir`, `pushDir`) is the
  Node directory walk. Issue #11.
- `checkout.js` — `checkoutTree(url, { ref, path }, opts)`: the mirror of pushTree. ls-refs → one `blob:none` fetch of the
  commit (every tree) → blobs in `batch`-sized wants lists (buffered, delta-resolved, keyed by computed hash; an unwanted
  object is `pack_corrupt`), a batch over a cap split in half down to single blobs that stream through read.js's
  `openBlob`; a host refusing many wants gets one per request (`quirks.blobWants`). Returns `entries` and a `files` async
  iterator. `checkout-node.js` (`writeFiles`, `checkoutDir`) writes a directory as `git clone` lays it out and never
  writes through a symlink. Issue #12.
- `log.js` — `readLog(url, { ref, limit }, opts)`: first-parent history (`git rev-list --first-parent -n`) from one
  `deepen <limit>` fetch through `fetchPackTree0` (`tree:0`, else `blob:none` with the trees harvested). `logWindow` (pure)
  holds the window to the #37 deepen contract (the want present; every commit an ancestor; a missing parent only under a
  `shallow` line, else `pack_corrupt`) and sets `truncated` from the last commit's parents. No `path` filter. Issue #56.
- `merge.js` — `mergeBranch`, `fastForward`, `deleteRef`, `mergeTrees` (trivial-merge rules per directory, only differing
  subtrees fetched), `bestBases` (git's `merge-base --all` with a completeness check), rename guards, `blobMerger`,
  `attributeDrivers`/`attributeTree`.
- `linemerge.js` — port of git's xdiff as merge-ort drives it: histogram diff (+ hash-chain limit), classic Myers fallback
  (prepare-stage trim/cleanup, `xdl_split` heuristics), group compaction (+ git 2.54's shifted-group re-diff), build
  script, `xdl_do_merge`, conflict refinement and simplification, fill (clean and `merge=union`).
- `attributes.js` — `.gitattributes` as git reads them: parse, wildmatch, precedence, macros.
- `rebase.js` — `rebaseBranch` (per-commit or squash), `cherryPick`, `revertCommit` on the same merge primitive.
- `repo-node.ts` — `pushRepo(dir, url, { refspecs, all, tags, force, dryRun, thin }, opts)`: `git push` of a local
  repository with its history, no git binary (`ply/repo-node`, Node only). Reads `.git` itself (packs resolved in
  memory, loose objects hash-checked, packed and loose refs), one ls-refs, one receive-pack for every command; the pack is
  `rev-list --objects <new> --not <remote refs>`, delta-compressed by `delta.ts` (`planDeltas`: OFS_DELTA against the
  previous version of the same path, `encodeDelta` in the shape of git's diff-delta.c; thin REF_DELTA opt-in). A
  non-fast-forward is `not_fast_forward` before sending. Judged in `test/push-repo.test.js`. Issue #186.
- `refops.ts` — `createBranch`, `deleteBranch`, `createTag` by URL: one receive-pack command each (an annotated tag carries
  its tag object); an existing ref is `cas_conflict` (expected zero, actual its tip). Judged in `test/e2e-customer.test.js`,
  which also runs README.md's quick start as written against a default and a stock `git http-backend`.

## 3. How the work was done (the process)

**Git is the oracle.** Every behaviour that git defines is decided by running git, not by reading docs or reasoning:
`git http-backend` behind a tiny Node shim (`test/server.js`), a fault-injecting proxy (`test/proxy.js`), `workerd` for the Workers runtime, and git's own commands as judges — `merge-tree --write-tree`,
`merge`, `rebase`, `cherry-pick`, `revert`, `check-attr`, `rev-list --objects --filter`, `diff`, `fsck --strict`,
`verify-commit`, `ssh-keygen -Y verify`, `index-pack`, `pack-objects`. A second git (master, 2.56, built from source) is
used wherever behaviour differs by version.

**Evidence before claims.** A claim goes into SAFETY.md only with the test that proves it. When a test fails, the first
question is whether the oracle or the code is wrong; several "failures" were the oracle (e.g. `git diff -U0` trims the
common tail; a fast-forward merge where a merge commit was intended; a tie in parent order hiding a bug) and were fixed
there, with the reason written down.

**A bug becomes a test that fails on the old code.** For the serious findings (merge base, criss-cross) the new tests
were run against the previous code to confirm they catch it.

**Property tests and fuzzers over random inputs, with seeds and repro commands.** Every fuzzer prints a one-line repro
(`--seed`, `--case`). `npm test`'s fuzz stage (`npm run test:fuzz-pinned`, test/fuzz/pinned.mjs) is seeded by constants:
the same cases every run, each entry printing its seed when it starts and, with a replay command, when it fails or hangs
past the per-entry timeout. Discovery by a fresh seed (the wanted-tree finding came from a clock seed) runs in the nightly
workflow only, through `npm run test:fuzz-random`, which prints its seed first; `npm run coverage` pins every seed so
the coverage number is reproducible. A fuzzer feeds its git oracle from a file, not through `execFileSync`'s `input`
pipe, and gives the call a timeout: on node 24.18 / macOS under load that pipe call sometimes never returns for a 250 kB
input (9 of about 36 000 calls with no ply code loaded, 0 of 13 000 from a file), which hung test/fuzz/codec.mjs.

**Measure what is exercised.** Fuzzers report what they reached (coverage buckets, "exercised" counters: union-resolved
files, merge-attribute conflicts, Myers heuristic splits, mxcost cutoffs), so a green run is known not to be vacuous.
A first run with zero differences is treated with suspicion until the counters show the hard paths ran.

**Tree-shaking is asserted** (`test/bundle.test.js`: esbuild metafile module lists, symbol greps, byte budgets).

**Constraints in force**: nothing was ever pushed to GitHub (the push side against GitHub is unexercised by design, pending
real keys); the user's email address is used only to identify the user and is not written into the project.

## 4. Timeline

Earlier sessions (summarised; details in SAFETY.md):

1. Core client: smart HTTP v2, partial fetch, streamed single-file edit, thin delta push, O(1) memory, OTLP telemetry,
   hostile-server safety (fault proxy, liar fuzz, hostile fuzz), exhaustive compliance against git.
2. Learned from ivarvong/gitgrep → content-addressed pack cache for wants-only fetches (one bust retry if a cached pack
   fails verification) and the head hint (ls-refs overlapped with a speculative commit fetch; one internal retry on
   `cas_conflict`, linked by span).
3. Telemetry overhaul ("all of it"): bounded events, CPU measured vs estimated, cache status, isolate cold marker, retry
   links; more FP throughout.
4. Simplify without losing the general client: free functions, `sideEffects: false`, tree-shaking proven by the bundle
   test; coverage tooling and dev loop.
5. Git fundamentals review; LFS-pointer guard; honest `agent=` string; SSH-signed commits (PROTOCOL.sshsig, Ed25519 via
   WebCrypto; verified by git and ssh-keygen; also under workerd).
6. Branch operations needed for merging (scope narrowed by the user from "PRs" to git ops): create, fast-forward, merge,
   delete; then rebase, squash, cherry-pick, revert.
7. SSH transport (removed 2026-10-31; history on branch archive/ssh).
8. Layer review and refactor: the transport contract, `operation()`, the error table split, I26 (layering as a tested
   property).

This session (2026-10-19 → 20):

9. Line-level merging: ported git's xdiff merge (histogram, compaction, `xdl_do_merge`, refinement). Found and fixed:
   rebase replaying against a blob that only existed in the pending push; duplicate objects in a pack ("tried to add
   buffer twice"); rebase keeping commits that became empty (git: `--empty=drop`); rename naming at targets and a G1 hole.
10. Version skew: the remaining conservative answers all came from git 2.54's compaction re-diff. Built git master as a
    second oracle; ported classic Myers; made it the `rediff` option (`myers` ≡ git ≥ 2.54, `skip` ≡ older, `undecided`
    = safe for any). Double dissociation measured. Pinned the hash-chain limit (64 merges, 65 → git fails) exactly.
11. Protocol model gap (fuzzer's model, not the client): `NOT_USER_GIVEN` semantics for wanted trees under `tree:N`;
    modelled from git's source, 1,080 targeted cases equal `rev-list`.
12. Export (zip) after a fully green run and 100% coverage.
13. "Where are our gaps?" → found and fixed two silent wrong-merge bugs in merge-base selection (criss-cross, and the
    summed-distance trap on ordinary histories); `.gitattributes` support (measured that the attribute source is
    version-dependent → explicit option); merge drivers `binary`/`-merge`/`union` with git's full refinement.
14. This export.

## 5. Decisions and why

| Decision | Why (evidence) |
|---|---|
| readLog is first-parent, not git log's date order | the first `limit` first-parent commits are exactly inside a `deepen limit` window and `truncated` is the last commit's parent count, with no date heuristics; it is the history a branch view shows (one merge per landed branch). A date-ordered `git log -n` would need the whole window ranked by committer date (issue #56) |
| readLog's window is held to the deepen contract like the merge-base walk's | a cut graph without `shallow` lines (or a foreign commit) is `pack_corrupt`, never a shorter or padded log: 90 cells in `test/log.test.js`, 50 of them predicted `pack_corrupt` from git's own graph |
| Transport = plain record with two methods; HTTP implements it | operations never branch on transport; an SSH transport was added (and removed 2026-10-31, archive/ssh) with zero changes above the contract |
| Errors: one table, codes validated at throw | retry policy is data; tests check docs ↔ table ↔ literals in source stay aligned |
| After an acknowledged push, any read-back failure → `ambiguous` | the push may have landed; a transport code would invite a wrong retry (I25) |
| Pack cache keyed by sha256(url, credential, body), wants-only | measured against GitHub: wants-only fetches are deterministic; poison → bust + one retry |
| Merge = tree merge + ported line merge, never "close enough" | clean results must equal `git merge-tree` byte for byte; anything uncertain is a conflict (superset) |
| No rename detection; rename guards instead | porting merge-ort's rename detection is large; guards make every rename shape a conflict, never a wrong tree |
| `rediff` option, default `myers` | git changed behaviour in 2.54; both are git; default follows current git, `skip`/`undecided` documented |
| Merge base = git's best common ancestors, deepen until complete; criss-cross refused | the old "closest" rule produced wrong merges (shown); a single base cannot reproduce git's virtual base |
| `attributes` option, default `null` | measured: git 2.43 bare repos read HEAD's attributes, 2.46+ read none — there is no single "git's answer"; the caller names the source |
| Merge bundle budget 66 KB (edit bundle 44 KB) | line merge ≈ 10.4 KB and attributes ≈ 5.5 KB are deliberate; the edit path carries neither (asserted) |
| Git's GPL test vectors (t3070) run once, not shipped | licence; the result (380/380) is recorded in SAFETY.md |
| pushTree takes files as data; the directory walk is a separate Node module (`ply/tree-node`); likewise checkoutTree yields streams and `ply/checkout-node` writes them | `src/` stays Web-APIs-only for Workers; the bundle test asserts `node:` appears only in `tree-node.js` and `checkout-node.js` |
| pushTree's "server has it" set = oids named by the parent's trees it read | exact for one-commit deploys (push 2 == `git rev-list --objects new ^old`, 7 objects / 1,176 B on a 208-entry tree); objects only in older history are resent — correct, not minimal, no history walk |
| checkoutTree fetches every tree in one `blob:none` pack, then blobs by wants list | 3 requests for a 22-entry fixture vs 72 for readCommit → listTree → readFile per file; `blob:none` is the one filter Artifacts serves, so the same 3 there. A `path` still fetches the whole commit's trees (one round trip beats a tree:0 walk; bounded by `maxPackBytes`) |
| blob:none fallback: the caller's limits bind what it asked for; an extra over a limit is dropped, a malformed one fails the fetch | a tree:0 server never sends the extras, so failing on an honest big sibling directory made the answer depend on the host (#46: curl on Artifacts, 2,135-entry tests/data vs a 2,000 limit, 413 on every page); a malformed object means the response is untrusted (#18). Dropped extras are refetched as wanted objects if ever read. SAFETY I30 |
| Blob batches are buffered and split on a cap, not streamed | a multi-object pack cannot be cut into objects without inflating each one (zlib end is found only by inflating); a batch is bounded by the same caps as any buffered pack, and a blob alone streams in O(1) memory (still under `maxPackBytes` on the wire: since issue #36 every fetch is). A split re-downloads up to `maxPackBytes` — the cost of not knowing blob sizes in advance (trees do not carry them) |
| Every push refuses a pack over `maxPackBytes` before sending | a capped host (Artifacts: 64 MiB of request body, so set the limit a little under it for the command prefix) would otherwise take the upload and answer 4xx; `limit_exceeded` carries the measured size |
| A push deflates its pack twice and streams the second pass (#172) | holding the pack cost about 4 L for a push of largest object L: the pack, its concat, and the request body's concat (+268 MB live for 64 MiB). Pass 1 measures, so the cap still refuses before the first byte. Pass 2 streams, and its trailer is written only if it matches pass 1. Peak +78 KB live (+82 to +95 KB with 64 KiB zlib slices, below). A pack of at most 16 KiB is still sent as bytes. SAFETY I41 |
| The deflate decoder looks codes up 9 bits at a time, from a bit buffer read up to 24 bits ahead (after #172) | the pull decoder #198 made the only one went a code bit per step and back to the pull per symbol: `inflate()` of 64 MiB of text 2.10 s CPU (2.04 s for the buffered decoder before it), `parsePack` of one 64 MiB blob 2.34 s. The table is filled from the count/symbol arrays puff's decode walks, so it answers what decode answers on every 9-bit lookahead, incomplete and over-subscribed codes included (held exhaustively to puff); a longer code falls back to decode. Bytes read ahead are not consumed and go back to the input before a byte boundary, at the end and with a full chunk, so output, `consumed` and refusals are unchanged in every chunking. Now 1.12 s and 1.25 s; 2,000 4 KiB trees 0.53 → 0.30 s; random (stored) 64 MiB 0.53 → 0.21 s; under workerd 64 MiB text 1.62 → 1.06 s. Two 1 KiB tables are the only new memory. `node test/bench.mjs --tree <old> --tree <new>` |
| A push's two deflate passes stay; each hashes with `streamingSha1` | measured per pass (node, 64 MiB): about 3.0 s, almost all zlib (pure-JS SHA-1 of the compressed bytes 0.2 s for text, 0.6 s for random); the length pass 1 must know before the first byte exists only once zlib has run, so the pass cannot be cheaper without holding the pack. On Workers the hash is now the native `DigestStream`: under workerd 64 MiB text 5.19 → 4.89 s, random 5.43 → 4.90 s (one pass, buildPack, was 2.36 s). Feeding zlib 64 KiB slices (`DEFLATE_SLICE`) instead of 16 KiB: taken (2026-11-06). 64 MiB push CPU, node (`npm run bench`, 5 runs, median): text 5,504 → 5,063 ms, random 5,190 → 4,791 ms; workerd (one process, trees alternated, 24 rounds, paired median): text −225 ms of 4,420, random −115 ms of 3,530 (3–5%, not the 6–8% an earlier process-per-run measurement showed). Cost: one slice's deflate output in flight, 81,940 B where it was 32,776 B (SAFETY I41). A cheaper pass-2 comparison than SHA-1 was measured and not taken: SAFETY.md, measured negative results |
| Tree-entry name checks and parseTree allocate nothing per entry they do not return (#207) | prod profile of ply-web 59f39490: parseTree 8.3% of CPU, isDotFileName + isDotGitName 55% of it, GC 10%: a needle `te.encode`d per call, a `[cp, len]` tuple per character, closures, a mode decode + regex, `take`'s Result, a concatenated key per directory, an Object.create + Object.assign per entry. Now needles are module constants, the checks read bytes in place, a name whose first byte begins no spelling and that holds no backslash exits after one switch and one indexOf, entries are one class with the buffer in a private field. Equivalence: the c91c9cf code is kept as the oracle (test/oracle/dotnames-ref.ts, parsetree-ref.ts); 38.8 M names (every byte string ≤ 3 bytes, ≤ 4 over 38 bytes, every spelling × head × tail with truncations/substitutions/ignorables, 10 M random) and 1 M random trees agree, 0 disagreements (test/fuzz/dotnames.mjs, parsetree.mjs). `node test/bench-tree.mjs --runs 7 --passes 20`, node 24.18, median [min–max] ns/entry: bun@2a99800 (13,785 entries) 2,238 [2,219–2,275] → 427 [424–429], llama.cpp@ec88c3c 2,310 → 534, ply@c91c9cf 2,849 → 899; bytes allocated per entry 2,251 → 316, 2,623 → 387, 2,677 → 379 |
| A fetched tree is parsed once: the check's parse is the reader's (#208) | prod profile: 48% of parseTree's CPU was assertFetched, the rest the reader parsing the same bytes again. assertFetched now answers a tree with its entries; a single-object fetch carries them on the FetchedObject (`tree`, with the entry cap they were parsed under) and `treeEntries` hands that array to the reader when the reader's `maxTreeEntries` is that cap (parseTree reads no other limit, so it is the parse the reader would make), else parses under the reader's limits. Every tree is still checked before it is returned; a harvested or wide answer, and bytes from a caller's cache, are parsed by the reader as before. Readers: listTree/readFile walk, changes, pushTree's parent trees, merge's cachedTree, editFile. `node test/bench-tree.mjs --op fetched` (check + read per fetched tree, 7 runs × 20 passes) ns/entry, c91c9cf → #207 → #208: bun 4,301 → 830 → 448, llama.cpp 4,233 → 931 → 529; B/entry 4,503 → 646 → 354 |
| The pure-JS SHA-1 keeps int32 state and a 16-word Int32Array schedule (#214); `hashObject` stays sync and pure JS | prod: SHA-1 3.6% of pooled CPU, 10.3% of heap. A Uint32Array read of a word ≥ 2^31 boxed a heap number every round, and the 80-word schedule cost 64 extra stores and loads per block. `npm run bench -- --runs 5 --case sha1|hashObject` (node 24.18) median: 1 MiB 7.11 → 3.77 ms; hashObject of 2,000 4 KiB trees 59.8 → 30.5 ms. Held to node:crypto (test/sha1.test.js). `crypto.subtle.digest` measured and not taken: async and whole-buffer, ~10 µs a call in node (slower than pure JS below ~2 KiB, 13× faster at 1 MiB); hashObject is sync on every fetched object, so it would be an API break through singleObject and every caller. Streams already use Workers' native `DigestStream` |
| readFile/listTree ask for the commit with `combine:blob:none+tree:K` (K = levels the path needs, at most 2) where the server takes it (#218) | each path level was a round trip waiting on the last (ply-web prod traces, 6f2897ff). Measured 2026-11-06: GitHub refuses `tree:N>0` and `combine` (git's own words, reproduced with `uploadpackfilter.tree.maxDepth=0` + `combine.allow=false`), Artifacts refuses every filter but blob:none, gitlab.com and codeberg.org take both; no host advertises ref-in-want. Commit + root + one level, 7 rounds, median ms, 3 × tree:0 → one combine fetch: gitlab-org/gitlab 716 → 249, linux stable 605 → 279, forgejo 649 → 341, gitlab-runner 663 → 221. K = 3 rejected: 145–566 KB and 0.8–1.6 s per fetch on those repos (K = 2: 20–55 KB). Steady-state requests (test/bench-rt.mjs, base 814922e → this): gitlab-runner readFile depth 1/2/3 4/5/6 → 3/3/4, listTree / and depth 1 3/4 → 2/2; forgejo depth 1/3/4 4/6/7 → 3/4/5; GitHub and Artifacts unchanged (GitHub 3 + n, Artifacts 3 at any depth). Learned per quirks record in a WeakMap (the Quirks JSON shape is unchanged), asked only once tree:0 is settled (so Artifacts and stock git never see it and #136's one refusal stands), first ask concurrent with the tree:0 commit fetch; a failed deep fetch is never used. SAFETY I42 |
| `maxPackBytes` is enforced in `v2Step` (band 1 and band 2), not by each consumer; every object's zlib stream is capped at `zlibBound(size)` in `spStep` and `inflate` | the streamed blob paths had no body cap at all: endless empty stored blocks (5 bytes in, 0 out) were read at ~90 MiB/s until the request timer (shown: 793.6 MiB / 8 s). One choke point means a new consumer cannot forget the cap; the per-object bound (zlib's own `deflateBound`, since RFC 1951 has no ceiling) means a 10-byte blob costs ≤ 26 zlib bytes plus one chunk whatever `maxPackBytes` is, and a buffered pack's parse is linear in declared sizes |
| Redirects never followed (`redirect: 'manual'`, 3xx → `http`); the credential scrub rides on the transport into every span and error | workerd 2026-10-23 forwards Authorization on a cross-origin redirect (measured); a server can echo the token in ERR/band 2/band 3/`ng` text. SAFETY I6b, I6c (issue #15) |
| URL userinfo is sent as git sends it (`<token>@` → Basic `<token>:`, `:pass` → `:pass`, percent-decoded to bytes), not refused | measured on git 2.50 behind a Basic-auth gate: no prompt before the first credentialed request, the header byte-equal in every form; a library cannot prompt, so a refused one is `auth`. SAFETY I6d (issue #32) |
| An explicit `auth` that sends nothing is `bad_request`; `{ user }` alone is refused, not `user:` | git's own credential API (a helper giving a username alone) asks for the password and sends nothing; a library cannot ask. `{ user, token: '' }` is the explicit `user:`. Explicit fields go out as UTF-8 bytes, as git sends a helper's. SAFETY I6e (issue #40) |

## 6. Verification — how to rerun everything

Requirements: Node ≥ 22, git ≥ 2.43 on PATH, OpenSSH `ssh-keygen` for the signing suites, `workerd` (npm,
pinned) for the Workers suite (skipped if absent).

```sh
npm ci
npm test                  # 113 deterministic tests + 16 fuzz stages (≈29 min)
npm run coverage          # line coverage of src/, seeds pinned (expects 100%)
npm run fuzz:long         # the long campaigns
npm run test:push-full    # the full push matrix (1,400 cells)
```

Individual oracles (each prints a repro on failure):

| What | Command |
|---|---|
| Line merge vs `git merge-tree` | `node test/fuzz/linemerge.mjs --n 2000 --seed 1 [--runs\|--big] [--driver union\|binary] [--rediff myers\|skip\|undecided]` |
| Diff hunks vs `git diff --histogram` | `node test/fuzz/diffscript.mjs --n 200 [--snake\|--huge]` |
| `.gitattributes` vs `git check-attr` | `node test/fuzz/attributes.mjs --n 200 --seed 1` |
| Wanted-tree filter model vs `rev-list` | `node test/fuzz/usergiven.mjs --n 60 --seed 500` |
| Merge property (histories, renames, attributes) | `MERGE_SEED=11 MERGE_CASES=120 npx vitest run -t property test/merge.test.js` |
| Rebase/cherry-pick property | `REBASE_SEED=1 REBASE_CASES=60 npx vitest run -t property test/rebase.test.js` |
| Protocol product space | `node test/fuzz/protocol.mjs --n 200 --seed 32` |
| CPU of inflate, parsePack and the push writer, old tree against new (interleaved, one process per case) | `npm run bench -- --runs 5 --tree <older checkout> --tree .` |
| parseTree ns and bytes allocated per entry over every tree of a repository, old tree against new | `node test/bench-tree.mjs --runs 7 --corpus <repo>@<rev> --tree <older checkout> --tree .` |
| Tree-entry name checks and parseTree against the pre-#207 code (test/oracle/) | `node --import ./test/ts-resolve.mjs test/fuzz/dotnames.mjs` (38.8 M names) and `test/fuzz/parsetree.mjs --n 1000000` |

The oracle's version picks the matching mode automatically (`test/gitversion.js`). To judge against another git:
`GIT_BIN=/path/to/git node test/fuzz/linemerge.mjs …` (and `diffscript`, `attributes`, `linemerge.test.js`).

Building git master as the second oracle (what was used here, commit 47fdf220, "2.56"):

```sh
git clone --depth 1 https://github.com/git/git.git && cd git
make -j NO_CURL=1 NO_OPENSSL=1 NO_EXPAT=1 NO_GETTEXT=1 NO_TCLTK=1 NO_PERL=1 NO_PYTHON=1 git
```

## 7. Numbers (2026-10-20)

- Bundles (esbuild, minified): edit 42.6 KB (16.5 KB gz); merge 63.9 KB; full 116 KB.
- Line merge: 0 wrong across >40,000 random merges against 2.43 and 2.56; union 5,280 byte-identical; diff hunks identical
  on >1,400 diffs incl. 947 Myers heuristic splits and 160+ mxcost cutoffs.
- Attributes: >40,000 paths equal to `check-attr` on both versions; 380/380 git wildmatch vectors.
- Merge property runs: 0 wrong across seeds 11–15 with merge-commit and criss-cross histories and random attributes.
- Coverage: 100% of 2,461 lines.

## 8. Open gaps and next steps

In order of value:

1. **Real keys**: a GitHub push run (receive-pack policy layer, protected branches, the exact `ng` wording the
   `cas_conflict` classifier relies on) and an observed run on the Workers edge (CPU, subrequest and memory limits).
2. **Rename detection** (merge-ort's): today every rename shape is a conflict — the largest source of conservative
   conflicts on real refactors.
3. **Virtual merge base** for criss-cross histories (refused today).
4. **Conflict output**: we refuse rather than produce markers/partial results; no resolution flow.
5. Server-side configuration ply cannot see: `info/attributes`, custom merge drivers, `merge.default`.
6. Rebase niceties: patch-id skipping of already-upstream commits; merges in the chain (`not_linear` today).
7. Protocol/transport limits: SHA-256 repositories; servers without protocol v2; no SSH transport (removed 2026-10-31;
   history on branch archive/ssh).
8. Features not built: annotated tags, multi-file edits on top of the parent tree (pushTree replaces the whole tree),
   LFS beyond the guard, merges of files over 8 MiB, a `ply push <dir>` CLI and `.gitignore` reading for `pushDir`;
   for checkoutTree: submodule recursion, `.gitattributes` (eol/filters) and LFS smudging, sparse fetching of only `path`'s
   trees, and checkout into a non-empty directory.

## 9. What is in this export

```
ply-export/
  ply/                 the project (no node_modules, no fuzz-out traces) — run `npm ci`
    README.md              user guide
    SAFETY.md              invariants, findings, run record, what is not proven
    CONTEXT.md             this file
    src/  test/  package.json  package-lock.json
  process/
    README.md              index of the logs and experiments below
    logs/                  the final npm test run, the coverage report, the 20k line-merge campaign
    experiments/           the one-off scripts behind the findings (criss-cross, trap, chain limit, …)
```
