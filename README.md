# ply

Zero-dependency git smart-HTTP client that edits one file in a remote repo in **O(1) memory** and pushes the change **as a delta**. Runs anywhere with `fetch`, `CompressionStream`, `crypto.getRandomValues` and `Uint8Array` (Node ≥ 20, Workers, browsers behind a CORS proxy).

Every byte and every roundtrip is recorded as an OTLP span. The test suite is a property/fuzz harness that uses real `git` as the oracle and the spans as the coverage map that steers generation.

The hosted HTTP API and the public repository viewer live in [ply-web](https://github.com/ivarvong/ply-web) (the Cloudflare Worker `ply`). This repository is the git client.

`parsePack` accepts optional `maxObjects` and `maxInflatedTotal`. Omitting them uses `DEFAULT_LIMITS` (`maxPackObjects` 100_000, `maxInflatedTotal` 256 MiB). A limits object that drops either key fails closed (`bad_request`) instead of leaving the cap off. `validateIdent({ name, email, time, tz })` is the only way to build an author, committer, or tagger: `time` is a non-negative safe integer, `tz` is a civil offset (`-1200`..`+1400`), and the result is branded so a spread cannot reach `ident()`. [ply-web](https://github.com/ivarvong/ply-web) also uses these entry-point exports: `validateIdent`, `validateRef`, `validatePath`, `concat`, `limitError`, `isFilterRejection`, `fromAny`, `packParseOpts`.

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

Credentials: `auth: { token, user? }` (Basic `<user>:<token>`, user defaulting to `x-access-token`, sent as UTF-8 bytes as git sends a credential helper's), `{ bearer }`, or `{ header }` (an Authorization value forwarded verbatim; it and a bearer token must be printable ASCII). An `auth` that would send nothing is `bad_request`: `{}`, an empty token with no user, and `{ user }` alone (git's credential API asks for the password there; `{ user, token: '' }` sends Basic `<user>:`, the `https://<user>@host` form). Without `auth`, userinfo in the URL is sent as git sends it, byte for byte (percent-decoded): `https://user:pass@host/…` is Basic `user:pass`, a token as the user (`https://<token>@host/…`, the GitHub and GitLab form) is Basic `<token>:`, `https://:pass@host/…` is `:pass`; a NUL, CR or LF in it, or a URL that does not parse, is `bad_request` before any request. None reaches a span, a URL attribute or an error message, even when a server echoes it (the Basic user too, when it is token-shaped or the whole credential). Redirects are never followed: a 3xx is an `http` error naming the target, so no credential can follow it to another origin.

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

`readFile(url, { ref, path }, opts)` → `{ ref, commit, blob, mode, size, stream }`: ls-refs → commit (`tree:0`, deepen 1) → one tree per level → the blob as a `ReadableStream`, never held, hash-checked as it passes (the stream errors rather than ends if the bytes are not the blob's). `size` is known before the first byte. The stream is O(1) in memory but not unbounded on the wire: a blob whose pack exceeds `limits.maxPackBytes` (128 MiB; GitHub caps files at 100 MiB) is `limit_exceeded`, and one whose zlib stream runs past what its declared size allows (`zlibBound`, zlib's own `deflateBound`) is `pack_corrupt`, so a server cannot feed a reader forever. `listTree(url, { ref, path })` → `{ tree, entries: [{ name, mode, oid, type }] }` as `git ls-tree` prints them. `ref` is `HEAD` (default), a full ref, a short name (git's order: tags before branches), or a commit oid; tags are peeled. `import { readFile, listTree } from 'ply/read'` (36 KB min, no push or merge code).

## Pushing a whole tree (deploy from a directory, no git binary)

`pushTree(url, { ref, base?, files, author, message }, opts)` commits exactly `files` as the new tree, on the current head of `ref` (or `base`), and pushes it with the same rules as `editFile`: `head` hint, one fresh retry on `cas_conflict`, `strictHead`, `verify` (an acknowledged push that does not read back is `ambiguous`), `signer`, `cache`. An absent `ref` is created as a root commit (zero old oid: the CAS means "must not exist"). Identical files are `{ noop: true }`, nothing pushed.

```js
import { pushTree } from 'ply/tree';            // Workers-safe
import { pushDir } from 'ply/tree-node';         // Node: walks a directory (node:fs)

await pushTree(url, { ref: 'refs/heads/main', author, message: 'deploy', files: {
  'index.html': '<h1>hi</h1>',                                  // string or Uint8Array → 100644
  'bin/build': { data: script, mode: '100755' },
  'latest': { mode: '120000', data: 'v2/index.html' },          // symlink: the target is the blob
  'vendor/lib': { mode: '160000', oid: submoduleCommit },       // gitlink: no data; the server need not have the commit
} }, { auth, tracer, head: lastCommit });
await pushDir(url, { dir: './dist', ref: 'refs/heads/main', author, message: 'deploy' }, { auth, tracer });
```

`files` is an object, a `Map`, or an iterable of `{ path, mode?, data?, oid? }`. Paths are validated like `editFile`'s (no `.git`, `..`, empty components); a path given twice, or as both a file and a directory, is `bad_request` before any request (git's fsck calls that tree `duplicateEntries`; `encodeTree` now refuses it too). `README` and `readme` are two names to git and are accepted: they collide only on a case-insensitive checkout. Each blob is bounded by `maxObjectSize`, the file count by `maxPackObjects`, each directory by `maxTreeEntries`.

Repeat pushes are thin: ply reads the parent's trees only where the new tree differs (one `tree:0` fetch per changed directory, cached by oid; on Artifacts the first `blob:none` fetch carries them all), sends only blobs no such tree names, and sends each changed tree as a `REF_DELTA` against the tree it replaces. Measured on a 208-entry tree (207 blobs, 26 trees) (`test/push-tree.test.js`): push 1 is 234 objects / ≈116.9 KB; push 2 (one file changed, one added, one deleted) is 7 objects / 1,176 B, exactly `git rev-list --objects new ^old`; push 3 (a one-byte change, `head` hint + `cache`) is 4 objects / 841 B with two upload-pack requests (ls-refs and the hinted commit, concurrent). Only the parent's trees are consulted, so a blob that exists on the server only in older history is sent again (correct, not minimal). Any push whose pack exceeds `limits.maxPackBytes` is refused before the upload starts: `limit_exceeded`, `what: 'push pack bytes'`, `got` = the measured pack size (set `maxPackBytes` under a host's cap, e.g. Artifacts' 62–93 MiB).

`pushDir` / `filesFromDir(dir, { filter, limits })` read a directory as git's index would: the owner's execute bit makes `100755`, a symlink is `120000` with its target (never followed), empty directories vanish, `.git` is skipped, anything else (FIFO, socket) is `bad_request`. `filter(path, { directory, symlink })` → `false` leaves a path out; `.gitignore` is not read, and there is no `ply push` CLI. Gitlinks come only from `files` (`{ mode: '160000', oid }`): a nested checkout is walked as a plain directory. A tree oid from `filesFromDir` equals `git add -A && git write-tree` on the same directory (tested).

## Checking out a whole tree (no git binary, no clone)

`checkoutTree(url, { ref, path? }, opts)` → `{ ref, commit, tree, path, entries, files }`: ls-refs → one `blob:none` fetch of the commit (deepen 1: the commit and every tree under it — on Artifacts, the only filter it serves anyway) → the blobs, up to `batch` (default 1,000) wants per request. `entries` is every non-tree entry under `path` as `[{ path, mode, oid }]` in `git ls-tree -r` order, paths relative to `path`; `files` is an async iterator of `{ path, mode, oid, size, stream }`. Modes are git's canonical `100644`, `100755`, `120000` (a symlink: the stream is its target) and `160000` (a gitlink: `size` 0, `stream` null, the submodule's commit is not in this repository).

```js
import { checkoutTree } from 'ply/checkout';       // Workers-safe
import { checkoutDir } from 'ply/checkout-node';    // Node: writes a directory (node:fs)

const r = await checkoutTree(url, { ref: 'main', path: 'site' }, { auth, tracer });
for await (const f of r.files) if (f.stream) await env.BUCKET.put(f.path, f.stream, { httpMetadata: { contentLength: f.size } });
await checkoutDir(url, { dir: './out', ref: 'v1.2.0' }, { auth, tracer });  // == git clone, minus .git
```

Every object is checked against its oid: a blob batch is delta-resolved and keyed by computed hash before any file is yielded (an object nobody asked for is `pack_corrupt`); a blob fetched alone streams through `readFile`'s verifier (the stream errors rather than ends on wrong bytes). A batch that hits `maxPackBytes`, `maxInflatedTotal` or `maxObjectSize` is split in half and refetched, down to single blobs, which stream in O(1) memory (a single blob whose pack is over `maxPackBytes` is `limit_exceeded`: every fetch, streamed or not, delivers at most that much pack); a host that refuses a many-wants fetch (an HTTP error, `ERR`) gets one blob per request from then on (`quirks.blobWants = 'single'`). A wrong blob is never a reason to fall back. Entries walked are bounded by `maxPackObjects` (a tree reused at many paths cannot multiply past it), depth by `maxPathDepth`, and a tree naming one entry twice (a symlink `a` beside a directory `a`) is `pack_corrupt`.

Measured against `git http-backend` (`test/checkout-tree.test.js`, 22 entries: nested and unicode paths, exec bits, four symlinks, a gitlink, a 3 MiB blob, one blob at two paths): 3 requests (ls-refs, trees, blobs), the same behind an Artifacts-like `blob:none`-only proxy, against 72 for the per-file loop (`readCommit` → `listTree` per directory → `readFile` per blob, as in `examples/checkout-tree.mjs`). A commit oid as `ref` skips ls-refs.

`checkoutDir` / `writeFiles(dir, files)` lay the files out as `git clone` does — `diff -r --no-dereference` identical to a clone of the same ref, permission bits included (100755 is created 0777 & ~umask, others 0666 & ~umask; symlinks never followed; a gitlink is an empty directory). `dir` must be absent or empty. Paths go through `validatePath` again (no `..`, absolute, empty or `.git` component); each directory is made one level at a time and must be a real directory (a symlink there — one this checkout made, or the same name on a case-insensitive filesystem — is `bad_request`, `what: 'checkout path'`); files are opened `O_EXCL`, so nothing is overwritten or written through a link. A file whose stream fails verification is removed before the error is rethrown; a checkout that throws leaves `dir` partial. No index, no `.git`, no working-tree updates: a one-shot materialisation.

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
operations   edit · push tree · merge · rebase · cherry-pick · revert        operation.js: root span, transport, outcome, verify rule
commands     lsRefs · packStream/fetchObject · fetchPack/negotiate · push · discover · receiveCaps   free functions over a transport
transport    the contract (transport.js): t.frames(service, body, span, hints) · t.advertise(service, span)
             implementations: http.js (one POST per command) · sshgit.js (one channel per service, over ssh.js)
protocol     pure step functions: pktStep · v2Step · spStep · scanStep · parseReportStatus · threeWay · decideHead
codecs       pktline · inflate · sha1 · objects · pack (delta/build) · validate
errors       errors.js: every code, its retry policy; errors-doc.js: what each means
```

Each layer is testable without the one below it, and `test/bundle.test.js` asserts the dependency direction. Transport hints are neutral (`{ bypassCache }`), not headers; transport-specific detail goes under `http.*` / `ssh.*`, the neutral facts under `git.transport`, `git.request.bytes`, `git.response.bytes`, `git.response.cache`.

## Telemetry conventions (enforced by `test/pure.test.js` and `test/span-contract.test.js`)

- Span names: `git.<service> <command>` for wire round trips (`git.upload-pack ls-refs`, `git.upload-pack fetch`, `git.receive-pack`); `git.<op>` for operation roots (`git.edit`, `git.push_tree`, `git.checkout`, `git.merge`, `git.rebase`, `git.cherry_pick`, `git.revert`); `git.<op>.<phase>` for their children; `ssh.<phase>` for transport phases.
- Attribute keys: dotted lowercase under `git.` `http.` `ssh.` `url.` `server.` `mem.` `error.` `ply.` `exception.`.
- Every trace root (operation roots and the spans that follow them, below) carries `<name>.outcome` (`ok`, `noop`, `fast_forward`, `cancelled`, …, or the error code).
- Every wire span carries `git.transport`, `git.request.bytes`, `git.response.bytes`, `server.address`.

### Telemetry contract

Span names, kinds, parent/child structure, links and attribute keys (with their value types) are public API. [`test/span-contract.json`](test/span-contract.json) is the contract: `test/span-contract.test.js` runs every operation (editFile, pushTree, checkoutTree, readFile, listTree, readCommit, mergeBranch, rebaseBranch, cherryPick, revertCommit), the wire spans and the SSH phases against real git and fails, naming each span and key, when what is emitted differs from the file. Values are not part of the contract; repeated siblings (three fetches) are one node, so round-trip counts are not either.

- **Removing or renaming** a span or key, changing a value's type, or moving a span is a **breaking change** for consumers' dashboards and alerts, and is called out as one in the PR and the release notes.
- **Adding** one also fails the test until the snapshot is regenerated (`npm run test:spans:update`), so every addition is visible in review as a diff of `test/span-contract.json`.

### Span lifetimes

Some work is driven by the caller after the call returns: `readFile`'s `stream`, `checkoutTree`'s `files` iterator (and each streamed blob in it), and an SSH channel (`ssh.exec`, one git process reused across commands until it is closed). Their spans — `git.read.blob`, `git.checkout.blobs`, `ssh.exec` — **follow** the span that started them instead of being its children:

- Each is the root of a trace of its own, with an OTLP link `ply.link=follows_from` to the span it follows, and that span carries `ply.link=followed_by` back if it was still open when the follower started (`git.read` → `git.read.blob`; `git.checkout.blobs` → each streamed `git.read.blob`). Links per span are capped at `maxEvents`, the rest counted in `droppedLinksCount`.
- A follower is not an invocation (no `ply.isolate.*`), inherits its leader's credential scrubbing, and carries its own `<name>.outcome`. It ends when the work does: the stream read to the end (`ok`), failing (the error code), or cancelled by the consumer (`cancelled`). A stream neither read to the end nor cancelled never ends its span, and holds its connection, like an unread `fetch` body.
- Every other span ends within its parent: no child outlives its parent (asserted over every trace in the contract test).

Why not keep the root open until the stream ends: the root's duration would then be the consumer's read speed (a slow downstream client, a Worker's response piping out), not ply's work, and a stream the caller never drains would leave the root — the span dashboards key on — unexported. Why not a child that ends late: trace viewers draw and roll up durations by the root span, so a child past its parent's end renders outside it and the root's time undercounts the work under it (#35). This is OpenTracing's `FOLLOWS_FROM` reference (a parent that does not depend on its child's result), which OpenTelemetry represents as a span link; Jaeger, Tempo and Honeycomb show links as navigable references between traces. So the operation root measures what the caller awaited (until the result is ready; for `readFile`, until the stream is open and its size known), and the follower measures the transfer.

## Errors

Every thrown error has a `code` from `errors.js`, whose `RETRY` table says what to do: `yes` (retry as-is), `fresh` (re-resolve the parent: `cas_conflict`), `no`, or `read` (`ambiguous`: the push may have landed — read the ref back before anything else). A push says landed (resolves), not landed (`cas_conflict`, `push_rejected`) or partly landed (`push_partial`, a non-atomic multi-ref push: `err.landed` and `err.rejected` name the refs) only on a report exactly as git's receive-pack writes it; every other state after the request may have reached the server — a cut, trailing bytes, band 3, a near-miss line, option lines, a limit hit while reading — is `ambiguous` (SAFETY.md I36; the space and every cell's outcome: SPACE.md). After an acknowledged push, any failure to confirm — a forged report, a transport error on the read-back — is `ambiguous`, enforced in one place (`operation.js/verifyRef`, `push.js/ambiguousAfterPush`).

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
