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
HTTP (protocol v2 for fetch, v0 receive-pack for push) and SSH — with no clone, no working tree and no local object store.

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
| Transport contract | `transport`, `http`, `sshgit` (+ `ssh`, `ssh-node`, `ssh-workers`) | a transport is a plain record `{ frames(service, body, span, hints), advertise(service, span) }`; two implementations, no dispatch |
| Protocol | `lsrefs`, `fetch`, `fetchpack`, `negotiate`, `push`, `receivecaps`, `discover`, `packcache` | v2 fetch as a pure state machine (`v2Init`/`v2Step`); push report parsing pure |
| Operations | `operation`, `edit`, `tree`, `merge`, `linemerge`, `attributes`, `rebase`, `sign` | `operation()` owns the root span, transport, outcome and the "after an acknowledged push, any read-back failure is `ambiguous`" rule |
| Entry points | `edit.js` (edit-only bundle), `tree.js` (whole-tree push), `index.js` (everything), `client.js` (`GitHttp` convenience wrapper); Node-only adapters outside every Workers bundle: `ssh-node.js` (`node:net`), `tree-node.js` (`node:fs`) | `sideEffects: false` |
| Telemetry | `otel` | minimal OTLP/JSON tracer; exporters pluggable (`test/jsonl.mjs` for files) |

Key operation modules:

- `edit.js` — `editFile(url, spec, opts)`: find/replace in one path, create-on-branch (`ref` + `base`), head hint (ls-refs in
  parallel with a speculative commit fetch), pack cache, signing, verify, LFS guard.
- `tree.js` — `pushTree(url, spec, opts)`: a caller-given file set (object, Map or iterable of `{ path, mode, data|oid }`,
  symlinks 120000, gitlinks 160000) as one commit, with editFile's head hint, fresh `cas_conflict` retry, `strictHead`,
  `verify`/`ambiguous`, signing and tree cache. Thin repeat pushes: the parent's trees are read only where the new tree
  differs, known blobs are not sent, changed trees go as `REF_DELTA`s. `tree-node.js` (`filesFromDir`, `pushDir`) is the
  Node directory walk. Issue #11.
- `merge.js` — `mergeBranch`, `fastForward`, `deleteBranch`, `mergeTrees` (trivial-merge rules per directory, only differing
  subtrees fetched), `bestBases` (git's `merge-base --all` with a completeness check), rename guards, `blobMerger`,
  `attributeDrivers`/`attributeTree`.
- `linemerge.js` — port of git's xdiff as merge-ort drives it: histogram diff (+ hash-chain limit), classic Myers fallback
  (prepare-stage trim/cleanup, `xdl_split` heuristics), group compaction (+ git 2.54's shifted-group re-diff), build
  script, `xdl_do_merge`, conflict refinement and simplification, fill (clean and `merge=union`).
- `attributes.js` — `.gitattributes` as git reads them: parse, wildmatch, precedence, macros.
- `rebase.js` — `rebaseBranch` (per-commit or squash), `cherryPick`, `revertCommit` on the same merge primitive.

## 3. How the work was done (the process)

**Git is the oracle.** Every behaviour that git defines is decided by running git, not by reading docs or reasoning:
`git http-backend` behind a tiny Node shim (`test/server.js`), a fault-injecting proxy (`test/proxy.js`), a real OpenSSH
`sshd` (`test/sshd.js`), `workerd` for the Workers runtime, and git's own commands as judges — `merge-tree --write-tree`,
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
(`--seed`, `--case`). `npm test` uses clock seeds for some fuzzers on purpose (discovery — the wanted-tree finding came
from one); `npm run coverage` pins every seed so the coverage number is reproducible.

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
7. SSH transport: curve25519-sha256 KEX, pinned ssh-ed25519 host key (no TOFU), aes-gcm, publickey auth, `GIT_PROTOCOL`
   env, per-channel serialization; proven against OpenSSH 9.6 and over `cloudflare:sockets` in workerd.
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
| Transport = plain record with two methods; HTTP and SSH implement it | operations never branch on transport; SSH added with zero changes above the contract |
| Errors: one table, codes validated at throw | retry policy is data; tests check docs ↔ table ↔ literals in source stay aligned |
| After an acknowledged push, any read-back failure → `ambiguous` | the push may have landed; a transport code would invite a wrong retry (I25) |
| Pack cache keyed by sha256(url, credential, body), wants-only | measured against GitHub: wants-only fetches are deterministic; poison → bust + one retry |
| SSH host key pinned, no TOFU | first-use trust on an edge runtime has nowhere safe to remember keys |
| Merge = tree merge + ported line merge, never "close enough" | clean results must equal `git merge-tree` byte for byte; anything uncertain is a conflict (superset) |
| No rename detection; rename guards instead | porting merge-ort's rename detection is large; guards make every rename shape a conflict, never a wrong tree |
| `rediff` option, default `myers` | git changed behaviour in 2.54; both are git; default follows current git, `skip`/`undecided` documented |
| Merge base = git's best common ancestors, deepen until complete; criss-cross refused | the old "closest" rule produced wrong merges (shown); a single base cannot reproduce git's virtual base |
| `attributes` option, default `null` | measured: git 2.43 bare repos read HEAD's attributes, 2.46+ read none — there is no single "git's answer"; the caller names the source |
| Merge bundle budget 66 KB (edit bundle 44 KB) | line merge ≈ 10.4 KB and attributes ≈ 5.5 KB are deliberate; the edit path carries neither (asserted) |
| Git's GPL test vectors (t3070) run once, not shipped | licence; the result (380/380) is recorded in SAFETY.md |
| pushTree takes files as data; the directory walk is a separate Node module (`ply/tree-node`) | `src/` stays Web-APIs-only for Workers; the bundle test asserts `node:` appears only in `ssh-node.js` and `tree-node.js` |
| pushTree's "server has it" set = oids named by the parent's trees it read | exact for one-commit deploys (push 2 == `git rev-list --objects new ^old`, 7 objects / 1,176 B on a 208-entry tree); objects only in older history are resent — correct, not minimal, no history walk |
| Every push refuses a pack over `maxPackBytes` before sending | a capped host (Artifacts 62–93 MiB) would otherwise take the upload and answer 4xx; `limit_exceeded` carries the measured size |

## 6. Verification — how to rerun everything

Requirements: Node ≥ 22, git ≥ 2.43 on PATH, OpenSSH `sshd`/`ssh-keygen` for the SSH and signing suites, `workerd` (npm,
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
| Merge property (histories, renames, attributes) | `MERGE_SEED=11 MERGE_CASES=120 node --test --test-name-pattern=property test/merge.test.js` |
| Rebase/cherry-pick property | `REBASE_SEED=1 REBASE_CASES=60 node --test --test-name-pattern=property test/rebase.test.js` |
| Protocol product space | `node test/fuzz/protocol.mjs --n 200 --seed 32` |

The oracle's version picks the matching mode automatically (`test/gitversion.js`). To judge against another git:
`GIT_BIN=/path/to/git node test/fuzz/linemerge.mjs …` (and `diffscript`, `attributes`, `linemerge.test.js`).

Building git master as the second oracle (what was used here, commit 47fdf220, "2.56"):

```sh
git clone --depth 1 https://github.com/git/git.git && cd git
make -j NO_CURL=1 NO_OPENSSL=1 NO_EXPAT=1 NO_GETTEXT=1 NO_TCLTK=1 NO_PERL=1 NO_PYTHON=1 git
```

## 7. Numbers (2026-10-20)

- Bundles (esbuild, minified): edit 42.6 KB (16.5 KB gz); SSH transport 21.5 KB; merge 63.9 KB; full 116 KB.
- Line merge: 0 wrong across >40,000 random merges against 2.43 and 2.56; union 5,280 byte-identical; diff hunks identical
  on >1,400 diffs incl. 947 Myers heuristic splits and 160+ mxcost cutoffs.
- Attributes: >40,000 paths equal to `check-attr` on both versions; 380/380 git wildmatch vectors.
- Merge property runs: 0 wrong across seeds 11–15 with merge-commit and criss-cross histories and random attributes.
- Coverage: 100% of 2,461 lines.

## 8. Open gaps and next steps

In order of value:

1. **Real keys**: a GitHub push run (receive-pack policy layer, protected branches, the exact `ng` wording the
   `cas_conflict` classifier relies on) and an observed run on the Workers edge (CPU, subrequest and memory limits).
   GitHub over SSH has not been reachable from the build sandbox.
2. **Rename detection** (merge-ort's): today every rename shape is a conflict — the largest source of conservative
   conflicts on real refactors.
3. **Virtual merge base** for criss-cross histories (refused today).
4. **Conflict output**: we refuse rather than produce markers/partial results; no resolution flow.
5. Server-side configuration ply cannot see: `info/attributes`, custom merge drivers, `merge.default`.
6. Rebase niceties: patch-id skipping of already-upstream commits; merges in the chain (`not_linear` today).
7. Protocol/transport limits: SHA-256 repositories; servers without protocol v2; SSH supports Ed25519 keys only and
   does not re-key.
8. Features not built: annotated tags, multi-file edits on top of the parent tree (pushTree replaces the whole tree),
   LFS beyond the guard, merges of files over 8 MiB, a `ply push <dir>` CLI and `.gitignore` reading for `pushDir`.

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
