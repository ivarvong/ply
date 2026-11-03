# ply

Zero-dependency git smart-HTTP client that edits one file in a remote repo in **O(1) memory** and pushes the change **as a delta**. Runs anywhere with `fetch`, `CompressionStream`, `crypto.getRandomValues` and `Uint8Array` (Node ≥ 20, Workers, browsers behind a CORS proxy).

Every byte and every roundtrip is recorded as an OTLP span. The test suite is a property/fuzz harness that uses real `git` as the oracle and the spans as the coverage map that steers generation.

The hosted HTTP API and the public repository viewer live in [ply-web](https://github.com/ivarvong/ply-web) (the Cloudflare Worker `ply`). This repository is the git client.

## Install

ply is not on npm (the npm name `ply` belongs to another package). Install it from GitHub; npm builds `dist/` on install:

```sh
npm install github:ivarvong/ply              # the default branch, as of now
npm install github:ivarvong/ply#<commit-sha>  # recommended: pin a commit for reproducible builds
```

It installs as `ply`, so imports read `from 'ply'` and `from 'ply/<subpath>'` (`ply/edit`, `ply/read`, `ply/tree`, `ply/checkout-node`, …). Types ship with it (`dist/*.d.ts`); JavaScript and TypeScript use the same calls.

## Beta

ply is pre-1.0 (0.2.0). The API can change between commits without a deprecation period, and there are no tagged releases yet: pin a commit sha, read the commit log before moving the pin, and let your type checker or tests catch a changed signature. Span names and attributes are a stated contract (see [Telemetry contract](#telemetry-contract)).

## Requirements

- **Runtime**: Node ≥ 20, Cloudflare Workers, or any runtime with `fetch`, `CompressionStream`/`DecompressionStream`, `crypto.getRandomValues` and `Uint8Array` (a browser works behind a CORS proxy). `ply/tree-node`, `ply/checkout-node` and `ply/repo-node` are Node only (`node:fs`).
- **A git smart-HTTP server**: GitHub, GitLab, Gitea/Forgejo, Cloudflare Artifacts, or self-hosted `git http-backend` (`http.receivepack true` to push; nothing else). A stock git server works: without `uploadpack.allowFilter` its advertisement has no `filter`, and ply learns that from the server (`quirks.treeFilter = 'none'`, learned once per remote: see the Artifacts notes below) and fetches unfiltered: the same results, with more bytes per read. The quick start below runs on both. ply speaks protocol v2 for reads and receive-pack for pushes; SHA-1 repositories only.
- **Auth**, per call in `opts.auth`: `{ token }` (HTTP Basic with user `x-access-token`, which GitHub tokens use), `{ token, user }` (a host that wants a username: GitLab `oauth2` for an OAuth token, your Gitea/Forgejo user), `{ bearer }`, or `{ header }` (an `Authorization` value sent as is). Or userinfo in the URL (`https://<token>@host/…`), sent as git sends it. No `auth` and no userinfo: anonymous. Credentials never reach a span or an error message; redirects are not followed. Details in "Credentials" under [More detail](#more-detail).

What ply does **not** do: create or delete repositories (that is the host's API, or `git init --bare` on your server: ply needs one to exist, empty or not); SSH transport (removed; HTTPS only); Git LFS content (an LFS pointer is refused by edits, see [Guards](#guards-and-policy)); pull requests, issues or any other host API object; a working tree or index (there is no clone: every call reads what it needs over the wire).

## Quick start: a repo end to end

Every call takes `(url, spec, opts)` (`opts` is optional: `auth`, `limits`, `signal`, and `tracer`, a `new Tracer({ exporter })` to export spans; without one they are dropped), and returns a `Result`: `{ ok: true, value }` or `{ ok: false, error }`, never a throw. The blocks below run in order against one repository that starts empty (they are executed as written, against `git http-backend` with and without `uploadpack.allowFilter`, by `test/e2e-customer.test.js`, and type-checked as TypeScript by `test/types/readme.typetest.ts`). A ref that is written is a full name (`refs/heads/main`; a tag's `name` may be short); a ref that is only read (`readCommit`'s `ref`, `createBranch`'s `from`, `createTag`'s `target`) may also be a short name (`main`, `v1.3.0`) or a commit id.

```js
// quick-start: setup
const url = 'https://git.example.com/acme/site.git';  // an existing repository, empty or not
const opts = { auth: { token: process.env['GIT_TOKEN'] } };  // add tracer: new Tracer({ exporter }) to export spans
const author = { name: 'Release Bot', email: 'bot@example.com' };  // time defaults to now, tz to +0000
const outDir = './site-checkout';  // checkoutDir writes here; it must be absent or empty
```

**First commit into an empty repository.** `pushTree` commits exactly `files` as the tree. A branch that does not exist yet is created as a root commit.

```js
// quick-start: first-commit
import { pushTree } from 'ply';

const first = await pushTree(url, {
  ref: 'refs/heads/main',
  files: {
    'README.md': '# site\n',
    'src/config.ts': 'export const VERSION = "1.2.3";\n',
    'bin/build': { data: '#!/bin/sh\necho build\n', mode: '100755' },
  },
  author, message: 'Initial commit',
}, opts);
if (!first.ok) throw first.error;
console.log(first.value.newCommit);  // the commit id main now points at
```

**Read** a commit, a directory, and a file (streamed, hash-checked as it is read).

```js
// quick-start: read
import { readCommit, listTree, readFile } from 'ply';

const head = await readCommit(url, { ref: 'main' }, opts);
if (!head.ok) throw head.error;
if ('empty' in head.value) throw new Error('main has no commits yet');
console.log(head.value.oid, head.value.tree, head.value.parents, head.value.message);

const listing = await listTree(url, { ref: 'main', path: 'src' }, opts);
if (!listing.ok) throw listing.error;
for (const e of listing.value.entries) console.log(e.mode, e.type, e.oid, e.name);  // as git ls-tree prints them

const file = await readFile(url, { ref: 'main', path: 'src/config.ts' }, opts);
if (!file.ok) throw file.error;
const config = await new Response(file.value.stream).text();  // read the stream to the end (or cancel it)
console.log(file.value.size, config);
```

**Edit one file**: find exactly one occurrence and replace it. The blob streams through; the push is a delta.

```js
// quick-start: edit
import { editFile } from 'ply';

const bump = await editFile(url, {
  ref: 'refs/heads/main', path: 'src/config.ts',
  find: 'VERSION = "1.2.3"', replace: 'VERSION = "1.2.4"',
  author, message: 'Bump version to 1.2.4',
}, opts);
if (!bump.ok) throw bump.error;  // match_count when find is not there exactly once
console.log(bump.value.newCommit, bump.value.noop);  // noop: find === replace, nothing pushed
```

**Several changes in one commit**, applied in order.

```js
// quick-start: commit-changes
import { commitChanges } from 'ply';

const change = await commitChanges(url, {
  ref: 'refs/heads/main',
  changes: [
    { kind: 'create', path: 'docs/intro.md', content: '# Intro\n' },  // refuses a path that exists
    { kind: 'write', path: 'README.md', content: '# site\n\nHello.\n' },  // creates or overwrites
    { kind: 'edit', path: 'src/config.ts', find: '1.2.4', replace: '1.3.0' },  // exactly one match
    { kind: 'delete', path: 'bin/build' },  // a file or a whole directory
    { kind: 'rename', from: 'docs/intro.md', to: 'docs/index.md' },
  ],
  author, message: 'Docs; version 1.3.0',
}, opts);
if (!change.ok) throw change.error;
console.log(change.value.outcome, change.value.oid);  // 'commit', or 'noop' when the tree did not change
```

**Branches**: create one at a commit (a ref name or a 40-hex commit id), commit to it, merge it back. `mergeBranch` fast-forwards when it can and otherwise writes a merge commit (git's merge-ort result for clean merges; `merge_conflict` with the paths otherwise).

```js
// quick-start: branch-merge
import { createBranch, mergeBranch } from 'ply';

const feature = await createBranch(url, { ref: 'refs/heads/feature', from: 'main' }, opts);
if (!feature.ok) throw feature.error;  // cas_conflict when the branch already exists

const work = await commitChanges(url, {
  ref: 'refs/heads/feature',
  changes: [{ kind: 'create', path: 'src/feature.ts', content: 'export const feature = true;\n' }],
  author, message: 'Add feature flag',
}, opts);
if (!work.ok) throw work.error;

const hotfix = await editFile(url, {  // main moves on meanwhile
  ref: 'refs/heads/main', path: 'README.md', find: 'Hello.', replace: 'Hello, world.', author, message: 'Fix greeting',
}, opts);
if (!hotfix.ok) throw hotfix.error;

const merged = await mergeBranch(url, { ref: 'refs/heads/main', from: 'refs/heads/feature', author }, opts);
if (!merged.ok) throw merged.error;
console.log(merged.value.outcome, merged.value.oid);  // 'merge': a commit with parents [main, feature]
```

**Tags**: lightweight (the ref names the commit) or annotated (a tag object with a tagger and message).

```js
// quick-start: tag
import { createTag } from 'ply';

const release = await createTag(url, { name: 'v1.3.0', target: 'refs/heads/main' }, opts);
if (!release.ok) throw release.error;
const notes = await createTag(url, { name: 'v1.3.0-notes', target: release.value.commit, message: 'Release 1.3.0', tagger: author }, opts);
if (!notes.ok) throw notes.error;
console.log(notes.value.oid, notes.value.commit);  // the tag object, and the commit it names
```

**Rebase, cherry-pick, revert.** Each replays commits with the same three-way merge and pushes with the old tip as the compare-and-swap.

```js
// quick-start: rebase-pick-revert
import { rebaseBranch, cherryPick, revertCommit } from 'ply';

const topic = await createBranch(url, { ref: 'refs/heads/topic', from: 'refs/heads/main' }, opts);
if (!topic.ok) throw topic.error;
const onTopic = await commitChanges(url, { ref: 'refs/heads/topic', changes: [{ kind: 'create', path: 'src/topic.ts', content: 'export const topic = 1;\n' }], author, message: 'Add topic' }, opts);
if (!onTopic.ok) throw onTopic.error;
const onMain = await commitChanges(url, { ref: 'refs/heads/main', changes: [{ kind: 'create', path: 'CHANGELOG.md', content: '1.3.0\n' }], author, message: 'Changelog' }, opts);
if (!onMain.ok) throw onMain.error;

const rebased = await rebaseBranch(url, { ref: 'refs/heads/topic', onto: 'refs/heads/main', committer: author }, opts);
if (!rebased.ok) throw rebased.error;  // topic's commits replayed onto main's tip

const picked = await cherryPick(url, { ref: 'refs/heads/main', commit: rebased.value.oid, committer: author }, opts);
if (!picked.ok) throw picked.error;  // outcome 'ok', or 'empty' when main already has the change (nothing written)

const reverted = await revertCommit(url, { ref: 'refs/heads/main', commit: picked.value.oid, committer: author }, opts);
if (!reverted.ok) throw reverted.error;  // a 'Revert "Add topic"' commit on main
```

**History**, first parent, newest first (`git log --first-parent`).

```js
// quick-start: history
import { readLog } from 'ply';

const log = await readLog(url, { ref: 'refs/heads/main', limit: 10 }, opts);
if (!log.ok) throw log.error;
for (const c of log.value.commits) console.log(c.oid.slice(0, 7), c.parents.length, c.message.split('\n')[0]);
```

**Check out a whole tree**: as streams (Workers-safe), or into a directory (Node, laid out as `git clone` would, without `.git`).

```js
// quick-start: checkout
import { checkoutTree } from 'ply';
import { checkoutDir } from 'ply/checkout-node';

const tree = await checkoutTree(url, { ref: 'v1.3.0' }, opts);
if (!tree.ok) throw tree.error;
for await (const f of tree.value.files) {
  if (f.stream) console.log(f.path, f.mode, (await new Response(f.stream).arrayBuffer()).byteLength);  // read each stream
}

const written = await checkoutDir(url, { dir: outDir, ref: 'main' }, opts);
if (!written.ok) throw written.error;
console.log(written.value.written.files);  // files written under outDir
```

**Delete a branch.** Without `expected` the tip ls-refs reports is the compare-and-swap; with `expected: '<oid>'` the delete happens only from that tip. The branch the remote's HEAD names is refused by the server (`push_rejected`).

```js
// quick-start: refs
import { listRefs, deleteBranch, deleteTag } from 'ply';

const refs = await listRefs(url, {}, opts);  // branches and tags; { prefixes: ['refs/heads/'] } for branches only
if (!refs.ok) throw refs.error;
console.log(refs.value.head, refs.value.refs.map(r => r.name));  // 'refs/heads/main', [ 'refs/heads/feature', … ]

const gone = await deleteBranch(url, { ref: 'refs/heads/feature', expected: work.value.oid }, opts);
if (!gone.ok) throw gone.error;  // cas_conflict when feature moved off that commit; not_found when it is gone
const untagged = await deleteTag(url, { name: 'v1.3.0-notes' }, opts);
if (!untagged.ok) throw untagged.error;
```

**Errors.** `error.code` is a closed union, so a `switch` with `assertNever` in `default` is checked exhaustive by TypeScript (a new code in ply fails your build, not your users). What to do with each:

```js
// quick-start: errors
import { assertNever } from 'ply';

const stale = await editFile(url, {
  ref: 'refs/heads/main', path: 'src/config.ts', find: 'VERSION = "9.9.9"', replace: 'VERSION = "10.0.0"', author, message: 'Bump',
}, opts);
if (!stale.ok) {
  const e = stale.error;
  switch (e.code) {
    case 'cas_conflict':  // the ref moved between read and push (editFile already redid it once): read again, redo
      console.warn('moved', e.expected, e.actual); break;
    case 'match_count':  // find matched e.matches times, not once: the file is not what you expected
      console.warn('matches', e.matches); break;
    case 'not_found':  // e.miss.kind: 'ref' | 'path' | 'repository' | 'head_unborn' | 'commit' | …
      console.warn('missing', e.miss.kind); break;
    case 'auth':  // 401/403: the credential is missing, wrong, or lacks write access
      console.warn('auth'); break;
    case 'limit_exceeded':  // a limits.* bound (e.what, e.got, e.max): raise it with withLimits, or do less per call
      console.warn('limit', e.what, e.got, e.max); break;
    case 'ambiguous':  // the push was sent and may have landed: read the ref back before doing anything else
      console.warn('unknown outcome'); break;
    case 'network': case 'timeout': case 'rate_limited': case 'upstream_5xx': case 'protocol': case 'pack_corrupt':
      console.warn('transient: retry with backoff', e.code); break;  // isRetryable(e) is true for exactly these
    case 'merge_conflict': case 'not_fast_forward': case 'not_linear': case 'unrelated_histories':
      console.warn('history needs a human', e.code); break;
    case 'push_rejected': case 'push_partial': case 'remote_error':  // a hook, branch protection, or the server said no
      console.warn('refused', e.message); break;
    case 'bad_request': case 'unsupported': case 'lfs_pointer': case 'http': case 'not_git': case 'aborted': case 'internal':
      console.warn('fix the call or the setup', e.code, e.message); break;
    default:
      assertNever(e);
  }
}
```

`retryPolicy(error)` gives the same advice as data (`yes`, `fresh`, `read`, `no`), and `CODE_DOCS[code]` a one-line description. Every option an entry takes is in its section below.

## More detail

`parsePack` accepts optional `maxObjects` and `maxInflatedTotal`. Omitting them uses `DEFAULT_LIMITS` (`maxPackObjects` 100_000, `maxInflatedTotal` 256 MiB). A limits object that drops either key fails closed (`bad_request`) instead of leaving the cap off. `validateIdent({ name, email, time, tz })` is the only way to build an author, committer, or tagger: `time` is a non-negative safe integer, `tz` is a civil offset (`-1200`..`+1400`), and the result is branded so a spread cannot reach `ident()`. [ply-web](https://github.com/ivarvong/ply-web) also uses these entry-point exports: `validateIdent`, `validateRef`, `validatePath`, `concat`, `limitError`, `isFilterRejection`, `fromAny`, `packParseOpts`.

```js
import { editFile, Tracer, consoleExporter } from 'ply';

const tracer = new Tracer({ exporter: consoleExporter() });  // logs each OTLP/JSON export line; or your own (line) => …
const cache = new Map();  // trees by oid, reused across edits
const r = await editFile('https://github.com/o/r.git', {
  ref: 'refs/heads/main', path: 'src/config.ts',
  find: 'VERSION = "1.2.3"', replace: 'VERSION = "1.2.4"',
  author: { name: 'bot', email: 'bot@x' }, message: 'bump',
}, { auth: { token: process.env.GIT_TOKEN }, tracer, cache });
if (!r.ok) {
  switch (r.error.code) { /* exhaustive over Code: every case, no default, then assertNever(r.error) */ }
}
// r.value.newCommit, r.value.pushBytes (≈ 300 + |replace| + 80·depth), r.value.noop
```

Every public function returns a `Result` (0.2.0): `{ ok: true, value }` or `{ ok: false, error }`, never a throw. `error`
is a `PlyError`: an `Error` with a `code` from a closed union, so `switch (r.error.code)` with no `default` is checked
exhaustive by the compiler. A stream (`readFile`'s `stream`, `checkoutTree`'s `files`) reports a failure the way a
stream does: it errors, with that same `PlyError`.

Credentials: `auth: { token, user? }` (Basic `<user>:<token>`, user defaulting to `x-access-token`, sent as UTF-8 bytes as git sends a credential helper's), `{ bearer }`, or `{ header }` (an Authorization value forwarded verbatim; it and a bearer token must be printable ASCII). An `auth` that would send nothing is `bad_request`: `{}`, an empty token with no user, and `{ user }` alone (git's credential API asks for the password there; `{ user, token: '' }` sends Basic `<user>:`, the `https://<user>@host` form). Without `auth`, userinfo in the URL is sent as git sends it, byte for byte (percent-decoded): `https://user:pass@host/…` is Basic `user:pass`, a token as the user (`https://<token>@host/…`, the GitHub and GitLab form) is Basic `<token>:`, `https://:pass@host/…` is `:pass`; a NUL, CR or LF in it, or a URL that does not parse, is `bad_request` before any request. None reaches a span, a URL attribute or an error message, even when a server echoes it (the Basic user too, when it is token-shaped or the whole credential). Redirects are never followed: a 3xx is an `http` error naming the target, so no credential can follow it to another origin.

Outcomes are typed on `r.error.code`: `cas_conflict` (retry), `match_count` (find ≠ exactly once), `not_found`, `auth`, `rate_limited`, `pack_corrupt`, `remote_error`, `upstream_5xx`. A `find === replace` edit returns `{ noop: true }` and pushes nothing.

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

`readFile(url, { ref, path }, opts)` → `{ ref, commit, blob, mode, size, stream }`: ls-refs → commit (`tree:0`, deepen 1) → one tree per level → the blob as a `ReadableStream`, hash-checked as it passes (the stream errors rather than ends if the bytes are not the blob's). The latest chunk stays until the object hash and the pack trailer verify, and a failure errors the stream without releasing it, so a consumer that received every byte saw a verified blob. `size` is known before the first byte. `openBlob(transport, oid, { maxBytes, follows })` opens that stream on a caller's transport for an oid it already resolved: `{ kind: 'stream', size, stream }`, or `{ kind: 'too_big', size }` when the object header's size is above `maxBytes`. The fetch is cancelled then (`git.read.blob.header_only`) and no body byte is delivered. `readBlob` is the same, buffered, and a pack that fails verification is an error rather than `bytes`. The stream is O(1) in memory but not unbounded on the wire: a blob whose pack exceeds `limits.maxPackBytes` (128 MiB; GitHub caps files at 100 MiB) is `limit_exceeded`, and one whose zlib stream runs past what its declared size allows (`zlibBound`, zlib's own `deflateBound`) is `pack_corrupt`, so a server cannot feed a reader forever. `listTree(url, { ref, path })` → `{ tree, entries: [{ name, mode, oid, type }] }` as `git ls-tree` prints them. `ref` is `HEAD` (default), a full ref, a short name (git's order: tags before branches), or a commit oid; tags are peeled. `resolveCommit(transport, ref, { abbrev: 'advertised' })` also takes a 4–39 character lowercase hex prefix when it matches one advertised tip (HEAD, branches, tags, and peeled targets) in that one ls-refs; a ref name wins, as in git. The default `abbrev: 'off'` keeps a short hex string as a ref name. `resolveAbbrev` is that step on an ls-refs answer (`unique_among_advertised`, `none`, or `ambiguous`). It is weaker than `git rev-parse`: an interior object is not a candidate. `import { readFile, listTree } from 'ply/read'` (36 KB min, no push or merge code). A `not_found` carries `miss` (`miss.kind`): a missing ref, an absent or unborn HEAD, a missing path, a file where a directory was required, a directory, a submodule, a commit (`miss.kind === 'commit'`, then `miss.miss` is `absent` or `not_commit`), or a repository 404. `readCommit` of an unborn HEAD, or of that branch by name, returns `{ empty: true, ref }` instead of `not_found`. `walkPath(transport, treeOid, comps, { cache })` walks a tree the caller already has. `fetchCommit(transport, oid)` is that commit fetch for a 40-hex id: `{ oid, data, commit }`, or `not_found` with that commit miss. A corrupt pack stays `pack_corrupt`. `readCommit`, `readLog`, and `pickCommit` use that classification.

### Recent history: `readLog`

`readLog(url, { ref, limit = 20 }, opts)` → `{ ref, oid, commits: [{ oid, tree, parents, author, committer, message, signed }], truncated }` (the commit view is `readCommit`'s). The order is **first parent, newest first**: exactly `git rev-list --first-parent -n <limit> <ref>`, the line a branch's history follows (one merge commit per landed branch). `parents` lists every parent. `truncated` is true when history continues past the last commit returned; fewer than `limit` commits with `truncated` true means the server's own repository is shallow there. One fetch: `want <commit>  deepen <limit>  filter tree:0`, commits only. A server that refuses `tree:0` (Artifacts) gets `blob:none`, learned once into `quirks`; that pack also carries every tree of the window, checked and harvested, so a following `listTree`/`readFile` on the same `transport` costs no round trip. Every object passes `assertFetched`, and the window is held to the deepen contract: a commit the server sent that is not an ancestor of `ref`, or a withheld parent without a `shallow` line, is `pack_corrupt`, never a short or foreign log. `limit` is 1 to `limits.maxMergeDepth` (1024); `path` filtering is not supported (`bad_request`): under `tree:0` the window has no trees. `import { readLog } from 'ply/log'` (43 KB min). Measured on a local mirror of curl (10 commits, served by `git http-backend`): `tree:0` 6,073 B, 10 objects; `blob:none` 128,965 B, 87 objects (10 commits, 77 trees), against 121,646 B for `blob:none` deepen 1. Tested in `test/log.test.js`: server (`tree:0`, `blob:none`-only) × shape (linear, merges, root within the limit, first-parent length equal to the limit, longer) × limit (1, n, larger than the history) × server behaviour (honest, shallow lines dropped, a foreign commit added) = 90 cells, each against git.

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

## Push a whole local repository (history, no git binary)

`pushRepo(dir, url, { refspecs?, all?, tags?, force?, dryRun?, thin? }, opts)` is `git push <url> <refspecs>` from a machine with Node and no git: it reads `dir`'s `.git` itself (a work tree, a linked worktree or a bare repository: loose objects inflated and hash-checked, every packfile parsed and resolved, `packed-refs` and loose refs, `HEAD`), asks the remote for its refs (one ls-refs), and sends one receive-pack request for every command. Example: [`examples/push-repo.mjs`](examples/push-repo.mjs).

```js
import { pushRepo } from 'ply/repo-node';        // Node: reads .git (node:fs)

const r = await pushRepo('./repo', url, { refspecs: ['main', 'v1.0', '+wip:refs/heads/backup', ':stale'] }, { auth });
if (r.ok && r.value.upToDate) console.log('Everything up-to-date');      // nothing was sent
await pushRepo('./repo', url, { all: true, tags: true }, { auth });       // every branch and tag
```

Refspecs are git's: `src`, `src:dst`, `+src:dst` (forced), `:dst` (delete). `src` resolves as git resolves a name (`x`, `refs/x`, `refs/tags/x`, `refs/heads/x`, `refs/remotes/x`; two matches are `bad_request`), `HEAD` is the current branch, a 40-hex id needs a full `dst`, and a missing `dst` is the same ref. A short `dst` is the branch or tag the remote has by that name, else the kind of `src`. With no refspecs (and neither `all` nor `tags`) the current branch goes to the same name. The pack is what the remote lacks: everything reachable from the new tips minus everything reachable from the remote's refs that the local repository has (exactly `git rev-list --objects <new> --not <remote refs>`; gitlinks are not followed). A non-fast-forward update of a branch, an update of a ref whose tip the local repository lacks (git's "fetch first") and any change to an existing tag are refused before anything is sent — `not_fast_forward`, naming every refused ref, the same code a server's own non-fast-forward refusal carries — unless the refspec has `+` or `force` is set; none of the other refs are sent then either. Refs already at their target are `current`; when every ref is, the result is `upToDate` and no receive-pack request is made. `dryRun` makes the same decisions and counts the objects, and sends nothing. The result: `{ upToDate, dryRun, updates: [{ ref, oldOid, newOid, kind: 'create' | 'update' | 'force' | 'delete' }], current, objects, deltas, thinDeltas, rawBytes, packBytes }`; spans `git.push_repo` → `git.push_repo.read`, `git.push_repo.plan`, `git.receive-pack`.

The pack is delta-compressed (`planDeltas`, `encodeDelta` in `ply`, a block-hash copy/insert generator in the shape of git's `diff-delta.c`): each tree and blob is tried against the previous version of the same path in the pack, then of the same file name (a rename), as an `OFS_DELTA`, kept only when it is under half the object, with chains of at most 50. Commits and tags are stored whole. `thin: true` also deltas the first version of each path against the remote's copy (`REF_DELTA`): `git push` sends thin packs and receive-pack completes them (`index-pack --fix-thin`), but ply cannot prove a host it has not seen does, so it is opt-in. Measured on this repository's own history (`test/push-repo.test.js`, against a stock `git http-backend`; `git push`'s pack is `git pack-objects --revs --thin --delta-base-offset`): `HEAD~50` to an empty remote, 957 objects, 1,394,379 B against git's 1,546,809 B (every object whole, as before: 4,513,180 B); then `HEAD` on top, 1,576 objects, 845,188 B thin against git's 856,093 B (1,512,574 B without `thin`, against git's 1,443,193 B non-thin; whole: 8,517,408 B).

Memory: every packfile is resolved in memory (no `.idx` is read), so it suits repositories up to a few hundred MB. It fails closed with `limit_exceeded`: the objects held by `maxInflatedTotal` (256 MiB by default; raise it, and `maxPackObjects`, for a larger repository), their count by `maxPackObjects`, each by `maxObjectSize`, the pack sent by `maxPackBytes`, the refs by `maxRefs`. Refused with `bad_request` and `what`: SHA-256 repositories (`objectFormat`), reftable (`refStorage`), partial clones (`partialClone`), `objects/info/alternates` (`alternates`), shallow repositories (`shallow`), a ref file that is not an id or a symbolic ref (`ref`); a missing object is `bad_request` (`what: 'object'`), a loose object that does not hash to its name `pack_corrupt`.

## One commit from a change list

`commitChanges(url, { ref?, base?, changes, author, committer?, message, time? }, opts)` writes one commit. `changes` is applied in order: `create` (refuses a path that already exists; `write` overwrites, which is what `git add` does), `edit` (exactly one non-overlapping match, or `match_count`), `delete` (a file or a directory; empty directories are pruned), `rename`. Modes are `100644`, `100755` and `120000`. A single `edit` of an existing blob goes through `editFile`, so a large file stays a stream; every other list is an in-memory tree of the paths it touches.

`ref` defaults to the remote HEAD, born or unborn (an empty `git init --bare -b main` commits `refs/heads/main`; a symref to a branch with no commit does the same). A detached HEAD is `bad_request`. A server that will not name an unborn HEAD is `not_found`. Pass `ref` for either. `base` defaults to that ref's tip. Another ref creates `ref` from it and is `cas_conflict` (`expected` the zero id, `actual` the tip) when `ref` already exists. A 40-hex `base` is that commit — lowercase, as everywhere else in ply — and `bad_request` when the target exists at a different tip. The zero id is `bad_request` before any request.

An absent ref with no `base` is a root commit. A result tree equal to the parent does not write an empty commit: an existing ref returns `{ outcome: 'noop' }`; a new ref is `bad_request` (`nothing to commit`) and stays absent. `head` is the tip the ref must have, or the zero id when it must be absent; a mismatch is `cas_conflict` and is not retried. A lost push reads the ref back, so `actual` is the oid that won. `author.time` and `committer` are separate stamps. `import { commitChanges } from 'ply'`.

`editFile` accepts the same 40-hex `base` (the commit to edit) and an optional `committer`. A commit id that is not the tip of an existing ref is `bad_request`.

## Checking out a whole tree (no git binary, no clone)

`checkoutTree(url, { ref, path? }, opts)` → `{ ref, commit, tree, path, entries, files }`: ls-refs → one `blob:none` fetch of the commit (deepen 1: the commit and every tree under it — on Artifacts, the only filter it serves anyway) → the blobs, up to `batch` (default 1,000) wants per request. `entries` is every non-tree entry under `path` as `[{ path, mode, oid }]` in `git ls-tree -r` order, paths relative to `path`; `files` is an async iterator of `{ path, mode, oid, size, stream }`. Modes are git's canonical `100644`, `100755`, `120000` (a symlink: the stream is its target) and `160000` (a gitlink: `size` 0, `stream` null, the submodule's commit is not in this repository).

```js
import { checkoutTree } from 'ply/checkout';       // Workers-safe
import { checkoutDir } from 'ply/checkout-node';    // Node: writes a directory (node:fs)

const r = await checkoutTree(url, { ref: 'main', path: 'site' }, { auth, tracer });
if (r.ok) for await (const f of r.value.files) if (f.stream) await env.BUCKET.put(f.path, f.stream, { httpMetadata: { contentLength: f.size } });
const done = await checkoutDir(url, { dir: './out', ref: 'v1.2.0' }, { auth, tracer });  // == git clone, minus .git
```

Every object is checked against its oid: a blob batch is delta-resolved and keyed by computed hash before any file is yielded (an object nobody asked for is `pack_corrupt`); a blob fetched alone streams through `readFile`'s verifier (the stream errors rather than ends on wrong bytes). A batch that hits `maxPackBytes`, `maxInflatedTotal` or `maxObjectSize` is split in half and refetched, down to single blobs, which stream in O(1) memory (a single blob whose pack is over `maxPackBytes` is `limit_exceeded`: every fetch, streamed or not, delivers at most that much pack); a host that refuses a many-wants fetch (an HTTP error, `ERR`) gets one blob per request from then on (`quirks.blobWants = 'single'`). A wrong blob is never a reason to fall back. Entries walked are bounded by `maxPackObjects` (a tree reused at many paths cannot multiply past it), depth by `maxPathDepth`, and a tree naming one entry twice (a symlink `a` beside a directory `a`) is `pack_corrupt`.

Measured against `git http-backend` (`test/checkout-tree.test.js`, 22 entries: nested and unicode paths, exec bits, four symlinks, a gitlink, a 3 MiB blob, one blob at two paths): 3 requests (ls-refs, trees, blobs), the same behind an Artifacts-like `blob:none`-only proxy, against 72 for the per-file loop (`readCommit` → `listTree` per directory → `readFile` per blob, as the first `examples/checkout-tree.mjs` did, before `checkoutDir`). A commit oid as `ref` skips ls-refs.

`checkoutDir` / `writeFiles(dir, files)` lay the files out as `git clone` does — `diff -r --no-dereference` identical to a clone of the same ref, permission bits included (100755 is created 0777 & ~umask, others 0666 & ~umask; symlinks never followed; a gitlink is an empty directory). `dir` must be absent or empty. Paths go through `validatePath` again (no `..`, absolute, empty or `.git` component); each directory is made one level at a time and must be a real directory (a symlink there — one this checkout made, or the same name on a case-insensitive filesystem — is `bad_request`, `what: 'checkout path'`); files are opened `O_EXCL`, so nothing is overwritten or written through a link. A file whose stream fails verification is removed before the error is rethrown; a checkout that throws leaves `dir` partial. No index, no `.git`, no working-tree updates: a one-shot materialisation.

## Hosts that refuse `filter tree:0` (Cloudflare Artifacts)

Artifacts advertises `fetch=filter` but answers anything other than `blob:none` with `400 … only blob:none is supported`. ply learns that from the answer (not the host name), sets `quirks.treeFilter = 'blob:none'` on the transport and asks for `blob:none` from then on: a commit want then returns every tree of the commit, which ply delta-resolves, hash-checks and keeps (up to `limits.maxHarvestBytes`) so the deeper levels cost no round trip. The 400 is paid once per remote: a call that passes no `quirks` uses a record ply keeps per remote (origin + path, never the credential or query; the 256 most recently used remotes, per process or Workers isolate), and concurrent first requests wait for the one that finds out instead of each paying it. A `quirks` object you pass wins and is filled in place (pass a fresh `{}` to opt a call out of the shared record); `forgetQuirks(url)` drops one remote's record and `forgetQuirks()` all of them (a server reconfigured, a test faking several servers at one URL). A stale record costs bytes, never correctness. Cost: measured 8.9× the bytes of `tree:0` on a small repo; a merge-base walk ships every tree of every commit in its window. Spans say so (`git.fetch.filter.fallback`, `git.fetch.wide.extra_bytes`). A server whose upload-pack advertises no `filter` at all (a stock `git http-backend`: `uploadpack.allowFilter` is off by default) gets `quirks.treeFilter = 'none'`: a filtered fetch that comes back empty triggers one advertisement read, and with no `filter` on its `fetch=` line the request is retried unfiltered (`discover()` sets it too; an advertisement that lists `filter` again turns it back to `tree:0`). Unfiltered fetches carry objects a filter would have left out, so reads there cost more bytes; the results are the same. Artifacts rejects stale ref updates as `ng <ref> stale ref`, which is `cas_conflict`. Other observed Artifacts behaviour: an unknown want is an HTTP 500 (not `ERR`), HEAD follows the first-pushed branch and can be unborn, `receiveCaps()` returns `[]` (its v2-style receive-pack advertisement), push packs are capped between 62 and 93 MiB, HTTPS only.

## Branches and merging (git operations only)

- `editFile(url, { ref: 'refs/heads/feature', base: 'refs/heads/main', … })` builds the commit on `base`'s head and *creates* `ref` (zero old-oid: the CAS means "must not exist yet").
- `mergeBranch(url, { ref, from, author })` lands `from` into `ref`: merge-base via commit-only packs, then `up_to_date` / `fast_forward` (empty pack — the server has every object) / a merge commit with parents `[ours, theirs]` from a three-way tree merge (git's trivial-merge rules per directory, only differing subtrees fetched). A file both sides changed is merged **line by line with a port of git's xdiff** (`linemerge.js`: histogram diff with its classic-Myers fallback, group compaction, zealous conflict refinement — what merge-ort runs), so a clean result is byte-for-byte git's; anything else is `merge_conflict` with the paths and a reason per path (`content`, `binary`, `too large to merge`, `undecided`, `possible rename …`). Git changed its compaction in 2.54; `rediff: 'myers'` (default) matches git ≥ 2.54, `'skip'` older git, `'undecided'` conflicts wherever the two differ. `.gitattributes` merge drivers apply when you say which tree supplies them — `attributes: 'ours'` (what `git merge` in a worktree reads), `'theirs'`, `'base'`, a ref or commit (`attr.tree`), or `null` (default: none, as git ≥ 2.46 does in a bare repository): `-merge`/`binary` conflict, `merge=union` keeps both sides. The merge base is git's (`merge-base --all`); a criss-cross history with two bases is refused rather than merged against one. The remaining supersets are renames (no rename detection: the guards conflict instead) and criss-cross. `fastForwardOnly`, `noFastForward`, `signer`, `verify`, `limits.maxMergeBlobBytes` (8 MiB).
- `createBranch(url, { ref, from })`, `deleteBranch(url, { ref, expected? })` and `createTag(url, { name, target, message?, tagger? })` manage refs by URL (`src/refops.ts`): one receive-pack command each, no objects except an annotated tag's tag object. `from`/`target` is a ref name (resolved as `readCommit` resolves one; an annotated tag is peeled) or a 40-hex commit id the server must have. A ref that already exists is `cas_conflict` (`expected` the zero id, `actual` its tip), as a create is in `editFile`; a delete whose `expected` is not the tip is `cas_conflict` before anything is sent, and one that loses a race to another writer after ls-refs is `cas_conflict` with `actual` the ref read back (null only when it was deleted); an absent ref is `not_found`; what the server refuses (deleting the branch HEAD names) is its `push_rejected`. `verify: true` reads a created ref back. On a transport you already hold: `fastForward(t, { ref, from, to })` and `deleteRef(t, { ref, oid })`.
- `rebaseBranch(url, { ref, onto, committer })` replays the branch's linear chain onto `onto`'s head (per commit: three-way of parent-tree / new-tip / commit-tree; author and message kept, committer ours, signatures dropped as git does) and force-updates the branch with its old tip as the CAS; commits that become empty are dropped as git's `--empty=drop` does; `squash: true` makes one commit. `cherryPick` / `revertCommit` are the same primitive with one commit. Merge commits in the chain → `not_linear`. A root commit (no parent) is picked and reverted against the empty tree, as git does. `empty: 'keep'` writes the commit when the result tree is already the target's (`git cherry-pick --keep-redundant-commits`, which also keeps a commit that was empty to start); the result is `outcome: 'kept_empty'`. The default `empty: 'stop'` reports `outcome: 'empty'` and writes nothing. The kept commit is built by the same path as a non-empty one: a cherry-pick keeps the picked author line (name, email, time, zone) and message, a revert uses the reverting author and git's `Revert "<subject>"` message, and the committer stamp is the caller's.
- One primitive underneath all of it — the three-way tree merge, with the line merge for files both sides changed — with different arguments:

  | op | base | ours | theirs | commit |
  |---|---|---|---|---|
  | merge | merge-base tree | main | branch | parents `[main, branch]` |
  | rebase (per commit) | commit's parent tree | new tip | commit | parent `[new tip]` |
  | squash | merge-base tree | main | branch tip | parent `[main]` |
  | cherry-pick | commit's parent tree (empty tree, if the commit is a root) | target | commit | parent `[target]` |
  | revert | commit tree | target | commit's parent tree (empty tree, if the commit is a root) | parent `[target]` |

- A pull request is a GitHub API object around such a branch; that call is outside this library.

## SSH

SSH transport removed 2026-10-31; history on branch archive/ssh.

## Guards and policy

- **LFS pointers** are refused (`lfs_pointer`): the file's content is in the LFS store, and editing the pointer corrupts it. The check is on the blob's first bytes (`version https://git-lfs.github.com/spec/v1`), which are streaming past anyway, so it costs nothing; `allowLfsPointer: true` opts in to editing the pointer itself.
- **Signed commits**: pass `signer` (from `ed25519Signer({ privateKey, publicKeyRaw })` or `generateSigner()`) and the commit carries an SSH signature (PROTOCOL.sshsig, Ed25519 via WebCrypto — Workers and node). Verified by `git verify-commit` and `ssh-keygen -Y verify` in `test/sign.test.js`; satisfies "require signed commits" branch protection with the public key registered as a signing key.
- We identify as `ply/0.2.0`, not as git.

## Layers

```
operations   edit · push tree · merge · rebase · cherry-pick · revert        operation.js: root span, transport, outcome, verify rule
commands     lsRefs · packStream/fetchObject · fetchPack/negotiate · push · discover · receiveCaps   free functions over a transport
transport    the contract (transport.js): t.frames(service, body, span, hints) · t.advertise(service, span)
             implementation: http.js (one POST per command)
protocol     pure step functions: pktStep · v2Step · spStep · scanStep · streamStep · reportStep · threeWay · decideHead
codecs       pktline · inflate · sha1 · objects · pack (delta/build) · validate
errors       errors.js: every code, its retry policy; errors-doc.js: what each means
```

Each layer is testable without the one below it, and `test/bundle.test.js` asserts the dependency direction. Transport hints are neutral (`{ bypassCache }`), not headers; transport-specific detail goes under `http.*`, the neutral facts under `git.transport`, `git.request.bytes`, `git.response.bytes`, `git.response.cache`.

## Telemetry conventions (enforced by `test/pure.test.js` and `test/span-contract.test.js`)

- Span names: `git.<service> <command>` for wire round trips (`git.upload-pack ls-refs`, `git.upload-pack fetch`, `git.receive-pack`); `git.<op>` for operation roots (`git.edit`, `git.commit`, `git.push_tree`, `git.checkout`, `git.read_log`, `git.merge`, `git.rebase`, `git.cherry_pick`, `git.revert`, `git.branch_create`, `git.branch_delete`, `git.tag_create`); `git.<op>.<phase>` for their children.
- Attribute keys: dotted lowercase under `git.` `http.` `url.` `server.` `mem.` `error.` `ply.` `exception.`.
- Every trace root (operation roots and the spans that follow them, below) carries `<name>.outcome` (`ok`, `noop`, `fast_forward`, `cancelled`, …, or the error code).
- Every wire span carries `git.transport`, `git.request.bytes`, `git.response.bytes`, `server.address`.

### Telemetry contract

Span names, kinds, parent/child structure, links and attribute keys (with their value types) are public API. [`test/span-contract.json`](test/span-contract.json) is the contract: `test/span-contract.test.js` runs every operation (editFile, commitChanges, pushTree, checkoutTree, readFile, listTree, readCommit, mergeBranch, rebaseBranch, cherryPick, revertCommit, createBranch, deleteBranch, createTag), and the wire spans against real git and fails, naming each span and key, when what is emitted differs from the file. Values are not part of the contract; repeated siblings (three fetches) are one node, so round-trip counts are not either.

- **Removing or renaming** a span or key, changing a value's type, or moving a span is a **breaking change** for consumers' dashboards and alerts, and is called out as one in the PR and the release notes.
- **Adding** one also fails the test until the snapshot is regenerated (`npm run test:spans:update`), so every addition is visible in review as a diff of `test/span-contract.json`.

### Span lifetimes

Some work is driven by the caller after the call returns: `readFile`'s `stream`, `checkoutTree`'s `files` iterator (and each streamed blob in it). Their spans — `git.read.blob`, `git.checkout.blobs` — **follow** the span that started them instead of being its children:

- Each is the root of a trace of its own, with an OTLP link `ply.link=follows_from` to the span it follows, and that span carries `ply.link=followed_by` back if it was still open when the follower started (`git.read` → `git.read.blob`; `git.checkout.blobs` → each streamed `git.read.blob`). Links per span are capped at `maxEvents`, the rest counted in `droppedLinksCount`.
- A follower is not an invocation (no `ply.isolate.*`), inherits its leader's credential scrubbing, and carries its own `<name>.outcome`. It ends when the work does: the stream read to the end (`ok`), failing (the error code), or cancelled by the consumer (`cancelled`). A stream neither read to the end nor cancelled never ends its span, and holds its connection, like an unread `fetch` body.
- Every other span ends within its parent: no child outlives its parent (asserted over every trace in the contract test).

Why not keep the root open until the stream ends: the root's duration would then be the consumer's read speed (a slow downstream client, a Worker's response piping out), not ply's work, and a stream the caller never drains would leave the root — the span dashboards key on — unexported. Why not a child that ends late: trace viewers draw and roll up durations by the root span, so a child past its parent's end renders outside it and the root's time undercounts the work under it (#35). This is OpenTracing's `FOLLOWS_FROM` reference (a parent that does not depend on its child's result), which OpenTelemetry represents as a span link; Jaeger, Tempo and Honeycomb show links as navigable references between traces. So the operation root measures what the caller awaited (until the result is ready; for `readFile`, until the stream is open and its size known), and the follower measures the transfer.

## Errors

Every error a function returns has a `code` from `errors.js`, whose `RETRY` table says what to do: `yes` (retry as-is), `fresh` (re-resolve the parent: `cas_conflict`), `no`, or `read` (`ambiguous`: the push may have landed — read the ref back before anything else). A push says landed (resolves), not landed (`cas_conflict`, `not_fast_forward`, `push_rejected`: each git rejection reason's class is in SPACE.md "Push ng reasons") or partly landed (`push_partial`, a non-atomic multi-ref push: `err.landed` and `err.rejected` name the refs) only on a report exactly as git's receive-pack writes it; every other state after the request may have reached the server — a cut, trailing bytes, band 3, a near-miss line, option lines, a limit hit while reading — is `ambiguous` (SAFETY.md I36; the space and every cell's outcome: SPACE.md). After an acknowledged push, any failure to confirm — a forged report, a transport error on the read-back — is `ambiguous`, enforced in one place (`operation.js/verifyRef`, `push.js/ambiguousAfterPush`).

## Shape

`parseOid` returns a 40-character lowercase hex object id as an `Oid` (`bad_request` otherwise). `parseCommitId` is that check and also rejects `ZERO_OID`. git's `rev-parse` also accepts abbreviations, ref names, and uppercase hex; ply does not. `MODE_BLOB`, `MODE_EXEC`, `MODE_LINK`, `MODE_TREE`, `MODE_COMMIT`, and `BLOB_MODES` are the modes git writes in a tree (`BLOB_MODES` is the file modes: blob, executable, symlink).

Two entry points, one codebase. `ply/edit` is the pipeline and imports only the free functions it uses; `ply` is the full client (negotiation, delta resolution, multi-ref pushes, advertisements). Nothing is a class on the hot path — `createTransport()` returns a record and `lsRefs`, `packStream`, `fetchObject`, `fetchPack`, `negotiate`, `push`, `discover` are functions over it — so a bundler keeps only what you import. `GitHttp` wraps all of them for scripts and tests: `GitHttp.create(url, opts)` is a `Result` (a bad URL is its Err), and each method answers with the free function's `Result`. `test/bundle.test.js` asserts the edit bundle carries no resolver, negotiation, advertisement or class code and stays under budget (39 KB min / 15 KB gz; full: 58 KB / 21 KB).

`edit.js` is pure decisions between thin effects: `validateSpec`, `decideHead`, `lookupEntry`, `buildCommitObjects`, `memFromScan` are functions of their arguments and unit-tested against git without a server (`test/pure.test.js`); ls-refs, fetch, the blob stream, push and verify are the only places the client is touched.

## Limits

Every bound is a field of `limits` (`opts.limits`, any call). `DEFAULT_LIMITS` is sized for a git client's heap: one object up to 64 MiB (`maxObjectSize`), 128 MiB of pack per fetch or push (`maxPackBytes`), 128 MiB of files per `pushTree` or `commitChanges` (`maxPushBytes`), 256 MiB held from one buffered pack (`maxInflatedTotal`), 100 000 objects per pack (`maxPackObjects`), 200 000 entries per tree (`maxTreeEntries`). `withLimits({ ... })` overrides some of them; a field that is missing, `NaN`, infinite or negative is `bad_request`, never an open cap. A bound hit is `limit_exceeded` with `what` (the budget), `got` and `max`.

The byte budgets count what an object costs, not only its bytes: each object parsed from a pack (`parsePack`, and the room `resolvePack` has left; so every fetch, `checkoutTree`, and `pushRepo`'s local packs), each local object `pushRepo` holds, each file `filesFromDir` reads, and each file or change `pushTree`/`commitChanges` takes is charged its bytes plus `LIMIT_OBJECT_OVERHEAD` (3 KiB, above the 1.0 to 2.4 KiB of heap and RSS one tiny object was measured to cost; the method is in `src/limits.ts`). So a pack of 100 000 three-byte blobs (1.4 MB on the wire, which `git index-pack` accepts) is `limit_exceeded` (`what: 'pack inflated bytes'`) under the defaults, and 100 000 eight-byte files are `limit_exceeded` (`what: 'push bytes'`), where counting bytes alone let both run a 128 MiB heap out of memory. On the defaults that is about 87 000 tiny objects per pack and 43 000 tiny files per push; `got` includes the overhead. `stats.inflated` is still the declared sum git reports.

`WORKER_LIMITS` is the preset for a 128 MiB isolate (a Cloudflare Worker): `maxObjectSize` and `maxDeltaResult` 16 MiB (one object peaks near twice its size), `maxPackBytes`, `maxPushBytes` and `maxLsRefsBytes` 32 MiB, `maxInflatedTotal` 64 MiB (about 21 000 tiny objects), `maxHarvestBytes` 8 MiB, `maxMergeBlobBytes` 2 MiB, `maxTreeEntries` 32 768; the rest are the defaults. The limit sweep (`npm run sweep -- --full`, nightly) runs it at `--max-old-space-size=128`: every `worker.*` cell refuses or succeeds, none runs out of memory.

```js
import { pushTree, WORKER_LIMITS, withLimits } from 'ply';
const r = await pushTree(url, spec, { limits: withLimits({ ...WORKER_LIMITS, maxPackBytes: 62 * 1024 * 1024 }) });
```

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
npm run test:mutate     # Stryker across src/. Full run locally and on main; a PR mutates only the src lines it changes
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
