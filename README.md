# ply

Zero-dependency git smart-HTTP client that edits one file in a remote repo in **O(1) memory** and pushes the change **as a delta**. Runs anywhere with `fetch`, `CompressionStream`, `crypto.getRandomValues` and `Uint8Array` (Node ≥ 20, Workers, browsers behind a CORS proxy).

Every byte and every roundtrip is recorded as an OTLP span. The test suite is a property/fuzz harness that uses real `git` as the oracle and the spans as the coverage map that steers generation.

The hosted HTTP API and the public repository viewer live in [ply-web](https://github.com/ivarvong/ply-web) (the Cloudflare Worker `ply`). This repository is the git client.

`parsePack` accepts optional `maxObjects` and `maxInflatedTotal`. Omitting them leaves those caps unlimited, which is what existing callers do. The Worker also uses these entry-point exports: `validateIdent`, `validateRef`, `validatePath`, `concat`, `limitError`, `isFilterRejection`, `fromAny`, `packParseOpts`.

```js
import { editFile, Tracer, jsonlExporter } from 'ply';

const tracer = new Tracer({ exporter: await jsonlExporter('trace.jsonl') });
const r = await editFile('https://github.com/o/r.git', {
  ref: 'refs/heads/main', path: 'src/config.ts',
  find: 'VERSION = "1.2.3"', replace: 'VERSION = "1.2.4"',
  author: { name: 'bot', email: 'bot@x' }, message: 'bump',
}, { auth: { token: PAT }, tracer, cache });
// r.newCommit, r.pushBytes (≈ 300 + |replace| + 80·depth), r.noop
```

Credentials: `auth: { token }` (Basic `x-access-token:<token>`), `{ bearer }`, or `{ header }` (an Authorization value forwarded verbatim). None reaches a span or an error message, even when a server echoes it.

Outcomes are typed on `err.code`: `cas_conflict` (retry), `match_count` (find ≠ exactly once), `not_found`, `auth`, `rate_limited`, `pack_corrupt`, `remote_error`, `upstream_5xx`. A `find === replace` edit returns `{ noop: true }` and pushes nothing.

## Wire sequence

| # | Request | Response | Why |
|---|---|---|---|
| 1 | v2 `ls-refs` with `ref-prefix` | one line | head oid |
| 2 | v2 `fetch want <commit> filter tree:0 deepen 1 done` | 1-object pack | commit only (~300 B) |
| 3…N+2 | v2 `fetch want <tree> filter tree:0` per level | 1-object pack each | only the trees on the path; cached by oid (immutable) |
| N+3 | v2 `fetch want <blob>` | 1-object pack, **streamed** | inflate → scan → SHA-1, never materialized |
| N+4 | v0 `receive-pack` thin pack | `unpack ok` / `ng` | commit full + N tree `REF_DELTA`s + blob `REF_DELTA`; `old new ref` line is the CAS |

With a warm tree cache (root tree oid unchanged) steps 3…N+2 vanish: 3 roundtrips + push.

## Fewer round trips on repeat edits

Two ideas from [gitgrep](https://github.com/ivarvong/gitgrep):

- `cachingFetch(fetch, caches.default, { waitUntil })` as `fetchImpl`: the commit/tree fetches are wants-only, filtered, and every object is hash-verified on arrival, so the responses are immutable and cached per colo under `sha256(url, credential, body)`. A poisoned entry is evicted and refetched once (`git.pack.cache.bust` on the span). The blob stream is never cached.
- `head`: the oid you believe the ref points at (your last `newCommit`). Skips ls-refs; receive-pack's compare-and-swap is the freshness check, and a stale hint is redone once from a real ls-refs (`result.hint` is `'used' | 'stale' | null`).

Against github.com: 4 rtt / 549 ms cold → 3 rtt / 73 ms with both.

`head` runs ls-refs concurrently with a speculative fetch of the hinted commit, so a stale hint is corrected before anything is pushed — same wall time as skipping ls-refs, one extra request, no wasted push. A `cas_conflict` (replica lag between ls-refs and receive-pack) is redone once, the retry's span linked to the first.

Also: `client.discover()` is a capability canary (agent, object-format, `fetch=` features); push records the server's band-2 text in `git.push.remote.messages`; the blob hash uses native `crypto.DigestStream` where the platform has it.

## Reading without a clone

`readFile(url, { ref, path }, opts)` → `{ ref, commit, blob, mode, size, stream }`: ls-refs → commit (`tree:0`, deepen 1) → one tree per level → the blob as a `ReadableStream`, never held, hash-checked as it passes (the stream errors rather than ends if the bytes are not the blob's). `size` is known before the first byte. `listTree(url, { ref, path })` → `{ tree, entries: [{ name, mode, oid, type }] }` as `git ls-tree` prints them. `ref` is `HEAD` (default), a full ref, a short name (git's order: tags before branches), or a commit oid; tags are peeled. `import { readFile, listTree } from 'ply/read'` (36 KB min, no push or merge code).

## Hosts that refuse `filter tree:0` (Cloudflare Artifacts)

Artifacts advertises `fetch=filter` but answers anything other than `blob:none` with `400 … only blob:none is supported`. ply learns that from the answer (not the host name), sets `quirks.treeFilter = 'blob:none'` on the transport and asks for `blob:none` from then on: a commit want then returns every tree of the commit, which ply delta-resolves, hash-checks and keeps (up to `limits.maxHarvestBytes`) so the deeper levels cost no round trip. Pass the same `quirks: {}` object to every call for one host to pay the 400 once. Cost: measured 8.9× the bytes of `tree:0` on a small repo; a merge-base walk ships every tree of every commit in its window. Spans say so (`git.fetch.filter.fallback`, `git.fetch.wide.extra_bytes`). Artifacts rejects stale ref updates as `ng <ref> stale ref`, which is `cas_conflict`. Other observed Artifacts behaviour: an unknown want is an HTTP 500 (not `ERR`), HEAD follows the first-pushed branch and can be unborn, `receiveCaps()` returns `[]` (its v2-style receive-pack advertisement), push packs are capped between 62 and 93 MiB, HTTPS only.

## Branches and merging (git operations only)

- `editFile(url, { ref: 'refs/heads/feature', base: 'refs/heads/main', … })` builds the commit on `base`'s head and *creates* `ref` (zero old-oid: the CAS means "must not exist yet").
- `mergeBranch(url, { ref, from, author })` lands `from` into `ref`: merge-base via commit-only packs, then `up_to_date` / `fast_forward` (empty pack — the server has every object) / a merge commit with parents `[ours, theirs]` from a three-way tree merge (git's trivial-merge rules per directory, only differing subtrees fetched). A file both sides changed is merged **line by line with a port of git's xdiff** (`linemerge.js`: histogram diff with its classic-Myers fallback, group compaction, zealous conflict refinement — what merge-ort runs), so a clean result is byte-for-byte git's; anything else is `merge_conflict` with the paths and a reason per path (`content`, `binary`, `too large to merge`, `undecided`, `possible rename …`). Git changed its compaction in 2.54; `rediff: 'myers'` (default) matches git ≥ 2.54, `'skip'` older git, `'undecided'` conflicts wherever the two differ. `.gitattributes` merge drivers apply when you say which tree supplies them — `attributes: 'ours'` (what `git merge` in a worktree reads), `'theirs'`, `'base'`, a ref or commit (`attr.tree`), or `null` (default: none, as git ≥ 2.46 does in a bare repository): `-merge`/`binary` conflict, `merge=union` keeps both sides. The merge base is git's (`merge-base --all`); a criss-cross history with two bases is refused rather than merged against one. The remaining supersets are renames (no rename detection: the guards conflict instead) and criss-cross. `fastForwardOnly`, `noFastForward`, `signer`, `verify`, `limits.maxMergeBlobBytes` (8 MiB); `deleteBranch` with the CAS oid.
- `rebaseBranch(url, { ref, onto, committer })` replays the branch's linear chain onto `onto`'s head (per commit: three-way of parent-tree / new-tip / commit-tree; author and message kept, committer ours, signatures dropped as git does) and force-updates the branch with its old tip as the CAS; commits that become empty are dropped as git's `--empty=drop` does; `squash: true` makes one commit. `cherryPick` / `revertCommit` are the same primitive with one commit. Merge commits in the chain → `not_linear`.
- One primitive underneath all of it — the three-way tree merge, with the line merge for files both sides changed — with different arguments:

  | op | base | ours | theirs | commit |
  |---|---|---|---|---|
  | merge | merge-base tree | main | branch | parents `[main, branch]` |
  | rebase (per commit) | commit's parent tree | new tip | commit | parent `[new tip]` |
  | squash | merge-base tree | main | branch tip | parent `[main]` |
  | cherry-pick | commit's parent tree | target | commit | parent `[target]` |
  | revert | commit tree | target | commit's parent tree | parent `[target]` |

- A pull request is a GitHub API object around such a branch; that call is outside this library.

## SSH hosts

`ply/ssh` is a zero-dependency SSH-2 client (`src/ssh.js`, 14 KB min) and a git transport on it (`src/sshgit.js`): curve25519-sha256, pinned `ssh-ed25519` host key (no trust-on-first-use — pass the `ssh-keyscan -t ed25519` line), `aes128/256-gcm@openssh.com`, publickey auth with an Ed25519 WebCrypto key, one connection for every command of an edit (`env GIT_PROTOCOL=version=2` + `exec git-upload-pack`, a second channel for `git-receive-pack`). TCP comes from the platform: `ply/ssh-workers` (`cloudflare:sockets`) or `ply/ssh-node` (`node:net`).

```js
import { createSshTransport } from 'ply/ssh';
import { workersStream } from 'ply/ssh-workers';
const t = createSshTransport('git@github.com:owner/repo.git', { privateKey, publicKeyRaw, hostKey: 'github.com ssh-ed25519 AAAA…', connect: workersStream, tracer });
await editFile(url, spec, { tracer, transport: t });   // editFile / mergeBranch / rebaseBranch all take `transport`
await t.close();
```

Proven against a real `sshd` (OpenSSH 9.6) in `test/sshgit.test.js`: edits, merge, rebase, signing and verify on one connection; parity both ways with git's own ssh client (clone sees our push, we see git's); host key mismatch refused before any credential is presented; unauthorized key → `auth`; a server without `AcceptEnv GIT_PROTOCOL` → `unsupported`; 25 random byte flips on the encrypted stream → bad tag, never a wrong answer (git is the judge). Two things learned the hard way: git caches loose refs for the life of a process, so a long-lived `upload-pack` channel must be dropped after a push; and a channel is one git process reading commands in order, so concurrent commands (the head hint's overlapped fetch) are serialized per channel. GitHub's SSH endpoint could not be reached from the build sandbox (HTTPS-only egress); it advertises the same kex/cipher/host-key set.

## Guards and policy

- **LFS pointers** are refused (`lfs_pointer`): the file's content is in the LFS store, and editing the pointer corrupts it. The check is on the blob's first bytes (`version https://git-lfs.github.com/spec/v1`), which are streaming past anyway, so it costs nothing; `allowLfsPointer: true` opts in to editing the pointer itself.
- **Signed commits**: pass `signer` (from `ed25519Signer({ privateKey, publicKeyRaw })` or `generateSigner()`) and the commit carries an SSH signature (PROTOCOL.sshsig, Ed25519 via WebCrypto — Workers and node). Verified by `git verify-commit` and `ssh-keygen -Y verify` in `test/sign.test.js`; satisfies "require signed commits" branch protection with the public key registered as a signing key.
- We identify as `ply/0.1.0`, not as git.

## Layers

```
operations   edit · merge · rebase · cherry-pick · revert         operation.js: root span, transport, outcome, verify rule
commands     lsRefs · packStream/fetchObject · fetchPack/negotiate · push · discover · receiveCaps   free functions over a transport
transport    the contract (transport.js): t.frames(service, body, span, hints) · t.advertise(service, span)
             implementations: http.js (one POST per command) · sshgit.js (one channel per service, over ssh.js)
protocol     pure step functions: pktStep · v2Step · spStep · scanStep · parseReportStatus · threeWay · decideHead
codecs       pktline · inflate · sha1 · objects · pack (delta/build) · validate
errors       errors.js: every code, its retry policy; errors-doc.js: what each means
```

Each layer is testable without the one below it, and `test/bundle.test.js` asserts the dependency direction. Transport hints are neutral (`{ bypassCache }`), not headers; transport-specific detail goes under `http.*` / `ssh.*`, the neutral facts under `git.transport`, `git.request.bytes`, `git.response.bytes`, `git.response.cache`.

## Telemetry conventions (enforced by `test/pure.test.js`)

- Span names: `git.<service> <command>` for wire round trips (`git.upload-pack ls-refs`, `git.upload-pack fetch`, `git.receive-pack`); `git.<op>` for operation roots (`git.edit`, `git.merge`, `git.rebase`, `git.cherry_pick`, `git.revert`); `git.<op>.<phase>` for their children; `ssh.<phase>` for transport phases.
- Attribute keys: dotted lowercase under `git.` `http.` `ssh.` `url.` `server.` `mem.` `error.` `ply.` `exception.`.
- Every root span carries `<name>.outcome` (`ok`, `noop`, `fast_forward`, …, or the error code).
- Every wire span carries `git.transport`, `git.request.bytes`, `git.response.bytes`, `server.address`.

## Errors

Every thrown error has a `code` from `errors.js`, whose `RETRY` table says what to do: `yes` (retry as-is), `fresh` (re-resolve the parent: `cas_conflict`), `no`, or `read` (`ambiguous`: the push may have landed — read the ref back before anything else). After an acknowledged push, any failure to confirm — a forged report, a transport error on the read-back — is `ambiguous`, enforced in one place (`operation.js/verifyRef`, `push.js/ambiguousAfterPush`).

## Shape

Two entry points, one codebase. `ply/edit` is the pipeline and imports only the free functions it uses; `ply` is the full client (negotiation, delta resolution, multi-ref pushes, advertisements). Nothing is a class on the hot path — `createTransport()` returns a record and `lsRefs`, `packStream`, `fetchObject`, `fetchPack`, `negotiate`, `push`, `discover` are functions over it — so a bundler keeps only what you import. `GitHttp` wraps all of them for scripts and tests. `test/bundle.test.js` asserts the edit bundle carries no resolver, negotiation, advertisement or class code and stays under budget (39 KB min / 15 KB gz; full: 58 KB / 21 KB).

`edit.js` is pure decisions between thin effects: `validateSpec`, `decideHead`, `lookupEntry`, `buildCommitObjects`, `memFromScan` are functions of their arguments and unit-tested against git without a server (`test/pure.test.js`); ls-refs, fetch, the blob stream, push and verify are the only places the client is touched.

## Memory

Peak per invocation is one pkt-line (≤ 64 KB) + one inflate chunk (16 KB) + `|find|−1` carry + the replacement bytes. Measured over 446 fuzzed edits including 1.4 MB blobs: `mem.alloc.max_single` max = 16384. The blob is never resident; the delta is three ops computed from the match offset, and the new blob's oid comes from a streaming SHA-1 over the transformed stream (the exactly-one-match contract makes `newLen` known up front).

## Things the oracle taught us (would have been wrong otherwise)

- The whole fetch product space (haves, shallow, deepen-since/not, blob:limit, combine, thin, negotiation) is in `SAFETY.md`; the short version: git has two object-selection modes (bitmap = exact set difference; traversal = edge-tree heuristics), `--thin` changes which objects are excluded, shallow boundaries are grafts rather than negative refs, and `have` processing is order-dependent.

- `filter tree:N` **includes blobs** at depth < N. It is not a subset of `blob:none`; `combine:blob:none+tree:N` is. (`test/oracle.test.js`)
- git's `patch_delta` rejects deltas shorter than `DELTA_SIZE_MIN` = 4 bytes, which is exactly what "delete the whole file" encodes to. Degenerate deltas are sent as full objects. (found by fuzz seed 3359247)
- `receive-pack` unpacks the pack before checking `old`, so a lost CAS race leaves dangling objects server-side. The conflict is still atomic for the ref. (`test/concurrency.test.js`)
- Identical replacement would have produced an empty commit. Now a `noop`. (fuzz)

## Test loop

`npm test` runs the push matrix as a seeded 1-in-8 sample (~2 min; the seed rotates daily, `PUSH_MATRIX_SEED=<n>` reproduces a day); `npm run test:push-full` runs all 1,400 cells (~20 min). Coverage: 100% of lines across every `src/` module (`npm run coverage`), with the matrix excluded because it adds time, not lines.

```
npm run lint            # oxlint; no-magic-numbers on the wire decoders (0 and 1 are the only allowed literals)
npm run test:props      # ~5 s: pure step functions — chunking invariance, codec roundtrips, node:zlib/crypto oracles
npm run test:mutate     # Stryker across src/. Full run locally and on main; a PR mutates only the src files it changes
npm run fuzz:below-hash -- --n 20 --seed 1   # mutate decompressed objects, re-hash, fetch, compare with git fsck --strict
npm run test:oracle     # ~5 s: real git — tree oids vs write-tree, git pack-objects (ofs-delta, 5 window/depth/compression combos) parsed to cat-file truth, verify-pack chain depths, index-pack --fix-thin accepts our thin packs, filter semantics, 6-writer CAS convergence
npm run fuzz -- --n 200 # ~30 s: steered generative cases against git http-backend
npm run test:git        # ~15 min: fsck/check-ref-format/mktree compliance, clone/fetch parity with git's client, 768-cell push matrix vs git push
npm run test:protocol   # ~4 min: exhaustive fetch matrix (14,256 cells) vs pack-objects + captured upload-pack invocation
npm run fuzz:protocol -- --n 500   # random wants/haves/deepen/filter/thin/negotiate/shallow on generated DAGs
npm run trace -- fuzz-out/trace.jsonl git.receive-pack "git.push.ok==false"
```

An equivalent mutant stays only as `// Stryker disable next-line <Mutator>: <reason>` on that line. A blanket `Stryker disable all`, or dropping a parser file from the Stryker config, fails `npm run test:mutate`. See SAFETY.md.

### The fuzzer

`test/fuzz/gen.js` draws from a product space of named classes: blob content (`empty tiny text random repetitive boundary big binaryish`), match position (`start end middle chunk16k chunk32k chunk64k random`), find/replace length classes (incl. >127 for insert-op chunking, 64K copy-op boundaries, empty), server `core.compression` 0…9/−1 (stored / fixed / dynamic Huffman blocks), path depth 1…10, sibling shape (`none few many sortedge`: names that sort differently as dir vs file, unicode, leading `-`), history depth (so `deepen 1` reports `shallow`), file mode, and intended outcome (`ok noop zero_matches two_matches missing_path not_a_file cas_conflict` — the CAS case injects a competing push between our `ls-refs` and our `receive-pack` via `fetchImpl`).

Each case is checked against git: ref advanced to our commit, `cat-file` bytes equal the expected splice, `diff --name-only -z` touches exactly the path, parent/author/message, tree oid, mode preserved, `fsck --strict`, plus two efficiency properties — push bytes ≤ `220 + 80·depth + |replace| + ⌈|replace|/127⌉ + 5·⌈|replace|/16K⌉ + 16·⌈|blob|/64K⌉` and max single allocation ≤ 70 KB regardless of blob size — then a second edit that must hit the tree cache at every level. Failures write `fuzz-out/fail-<seed>.jsonl` and print `--case <seed>` to replay.

### Steering

After each case the spans are bucketized (`buckets()` in `run.mjs`): inflate block types seen, pkt-line carry across TCP reads, max-size pkts, sideband frames, multi-chunk scans, matches straddling a chunk, delta op counts, chain depths, tree sizes, outcomes, push ratio, allocation high-water. 55% of cases target the least-covered bucket via a bucket→knob map (`TARGETS`), 20% mutate one knob of a case that hit a rare bucket, 25% are uniform. The run prints the coverage table and any `TARGETS` never reached.

## Layout

```
src/sha1.js      streaming SHA-1 (subtle.digest can't stream)
src/inflate.js   zlib/deflate inflate that returns bytes consumed (packs have no length prefix)
src/pktline.js   pkt-line encode; decoder as pure (state, chunk) → {state, frames}
src/pack.js      pack parse/resolve, delta apply/generate, thin pack build
src/objects.js   blob/tree/commit codecs, tree sort (dir-as-slash)
src/client.js    v2 ls-refs/fetch (streamed sideband), v0 receive-pack; request bodies & response state machine are pure
src/edit.js      the pipeline; single-object pack stream + find/replace scanner as pure step functions
src/otel.js      OTLP/JSON tracer, one ExportTraceServiceRequest per line
src/bytes.js     alloc accounting (Mem), concat, indexOf
```

Prod lib is ~1100 lines. Tests are the rest.
