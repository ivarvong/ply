# ply Worker — `https://ply.ivar.workers.dev`

A Cloudflare Worker that exposes ply as an HTTP API against any smart-HTTP git host. The `/v1` API has no
bindings and no storage. `GET /view` is a public repository viewer; its only binding is a SQLite Durable Object
that rate-limits by client. `GET /` prints the usage text.

## Auth

- **Gate**: `Authorization: Bearer <PLY_TOKEN>` on every endpoint except `GET /`. The token is a Worker secret
  (`wrangler secret put PLY_TOKEN -c worker/wrangler.jsonc`) and is compared in constant time (SHA-256 of both sides,
  then `crypto.subtle.timingSafeEqual`). A missing or wrong token returns 401 `{code: "unauthorized"}`.
- **Git credential** (optional; public repos need none):
  - `Git-Authorization: <value>` is sent upstream verbatim as `Authorization`.
  - `Git-Token: <token>` is mapped by host: `github.com` → `Basic x-access-token:<token>`, `gitlab.*` → `Basic
    oauth2:<token>`, anything else (Cloudflare Artifacts included) → `Bearer <token>`. Artifacts accepts Bearer and
    Basic; both were checked in the smoke run.
  - Sending both headers is a 400.
  - Neither credential appears in a response, trace, error message or log line. ply never records them, and the
    Worker scrubs every outgoing string as a second layer (`test/worker.test.js` greps all of these, including a
    hostile upstream that echoes the header back).
- **Remote rules**: `remote` must be `https:`, on the default port, with no userinfo, query or fragment. IP literals
  are refused (including normalised forms such as `https://2130706433/`), as are single-label hosts and
  `localhost`/`.local`/`.internal`/`.lan`/`.home.arpa`/… names. The check runs before any I/O. `ALLOW_REMOTE_ORIGINS`
  (comma-separated origins) exempts listed origins from these rules. Only the tests use it.

## Endpoints

| Method | Path | Input | Output |
|---|---|---|---|
| GET | `/v1/refs` | `remote`, `prefix?` | `{refs: {name: oid}, head, peeled: {tag: commit}}` |
| GET | `/v1/discover` | `remote` | protocol v2 capabilities (`agent`, `fetch`, `filter`, `caps`, …) |
| GET | `/v1/read` | `remote`, `ref?`, `path` | the blob, streamed. Headers: `content-length`, `x-ply-ref`, `x-ply-commit`, `x-ply-blob`, `x-ply-mode`, `x-ply-size` |
| GET | `/v1/tree` | `remote`, `ref?`, `path?` | `{ref, commit, tree, entries: [{name, mode, oid, type}]}` (modes as `git ls-tree` prints them) |
| GET | `/v1/commit` | `remote`, `ref?` | `{ref, oid, tree, parents: [oid], author, committer, message, signed}`. `author`/`committer` are `{name, email, time, epoch, tz}`: `time` ISO-8601 UTC, `epoch` the raw seconds, `tz` the offset as written (`+0530`). `message` is the raw body (UTF-8, trailing newline kept). `signed` means a `gpgsig`/`gpgsig-sha256` header is present (not verified). Other headers (`encoding`, `mergetag`, …) are not returned. Fetches the commit object only (`tree:0`, deepen 1; `blob:none` on servers that refuse that) |
| POST | `/v1/edit` | `{remote, ref?, base?, path, find, replace, author, message, head?, hint?}` | `{ref, newCommit, oldCommit, pushBytes, noop, …}` |
| POST | `/v1/branch` | `{remote, ref, from?}` | 201 `{ref, oid}`. The CAS is a zero old-oid, so an existing branch gets 409 |
| DELETE | `/v1/branch` | `{remote, ref, oid?}` | `{ref, deleted}`. CAS on `oid` (default: the oid ls-refs shows now) |
| POST | `/v1/merge` | `{remote, ref?, from, author, message?, fastForwardOnly?, noFastForward?}` | ply's `mergeBranch` result |
| POST | `/v1/rebase` | `{remote, ref, onto?, committer, squash?, message?}` | ply's `rebaseBranch` result |
| POST | `/v1/cherry-pick`, `/v1/revert` | `{remote, ref?, commit, committer, message?}` | ply's result |

- `ref` defaults to the remote's HEAD branch. If HEAD is unborn (Artifacts can leave it pointing at a deleted branch),
  the response is 404 asking for an explicit `ref`.
- On reads, short names resolve the way `git rev-parse` does: tags win over branches, and a 40-hex commit oid is also
  accepted. On writes, short names mean `refs/heads/<name>`.
- `head` on edit is a **precondition**: if the branch is not at `head`, the response is 409 `cas_conflict` and nothing
  is pushed. `hint` is ply's soft head hint, which saves a round trip when it is right and is corrected when it is
  stale.
- JSON request bodies are capped at 1 MiB (413 above that). `WRITES` (wrangler var) must be `on` for the
  POST/DELETE endpoints; otherwise they return 501 `unsupported`.

## Errors

Every failure is JSON `{code, message, retry}`. `code` comes from ply's error table (`src/errors.js`), and `retry` is
that table's policy: `yes`, `fresh` (re-read, then retry), `no`, or `read` (the push may have landed; read the ref
back first). Merge conflicts add `conflicts` and `reasons`. `match_count` adds `matches`. `auth` adds
`upstreamStatus`.

| code | HTTP | why this status |
|---|---|---|
| `bad_request` | 400 | input, including a refused remote |
| `auth` | 401 or 403, the upstream's own status | the caller needs to know whether its credential was missing or not good enough |
| `not_found` | 404 | ref, path or repo |
| `cas_conflict` | 409 | the branch moved, so re-read and retry (`retry: fresh`) |
| `merge_conflict`, `not_fast_forward`, `push_rejected` | 409 | conflict with the repository's current state |
| `match_count`, `lfs_pointer`, `not_linear`, `unrelated_histories` | 422 | the request is well-formed but cannot apply to this content. Retrying it unchanged cannot work, even against a fresh state. That is the difference from 409 |
| `limit_exceeded` | 413 | |
| `rate_limited` | 429 | |
| `upstream_5xx`, `network`, `protocol`, `pack_corrupt`, `not_git`, `remote_error`, `http`, `ambiguous` | 502 | the upstream misbehaved. Check `retry` before retrying: `ambiguous` is `read` |
| `timeout` | 504 | |
| `unsupported` | 501 | including writes when they are disabled |
| `internal` | 500 | |

## Tracing

- `?trace=1` on a JSON endpoint adds `trace: [{name, ms, status, attrs, events}]` with ply's spans, the same OTLP
  spans ply emits anywhere.
- `/v1/read` streams raw bytes and has no JSON to carry spans. Instead, `?trace=1` adds an `x-ply-trace` header
  summarising every span that finished before the first byte, as `name;dur=ms, …`. The blob's own span finishes after
  the response is sent, so it shows up only in the request's log line (`stream: ok|error`).
- Every request writes one structured log line (`msg: "ply.request"`) with id, method, path, upstream **host** (never
  the path or the credential), status, ms, round trips, how many fetches used the blob:none fallback, and pack-cache
  hits. Workers Observability logs and traces are enabled, and `redact_query_string` keeps `remote=` out of the
  platform's request records. Each response carries `x-ply-request-id`.

## Servers that refuse `filter tree:0`

Cloudflare Artifacts refuses `filter tree:0`. ply learns this from the 400 and falls back to `blob:none`, which
brings more trees per fetch (see ply's README). The Worker keeps what it learned per origin for the life of the
isolate, so only the first request on an isolate pays for the 400.

## Public viewer (`/view`)

`GET /view` is a server-rendered browser for a **public** smart-HTTP repository. It does not use `PLY_TOKEN` and it
never reads `Authorization`, `Git-Token`, `Git-Authorization`, or `Cookie`. A URL with userinfo is rejected, not
turned into a credential. `/v1` is unchanged: same gate, same credential headers, same isolate-wide `quirks` map.
The viewer keeps a fresh `quirks` object per request, so a server that rejects `filter tree:0` shows that 400 and
the `blob:none` retry on every page (the `/v1` path still learns it once per isolate).

Shareable URLs: `/view/<host>/<repo path>?ref=&path=`. `?raw=1` returns the file as `text/plain` or
`application/octet-stream` (never `text/html`). `?want=<oid>&filter=tree:0|blob:none&offset=` is the pack map.
Every HTML page includes a waterfall of the git round trips that produced it (method, filter, wants, HTTP status,
cache HIT/MISS, server agent, pkt-line counters) plus the `cf-ray` when the platform sends one. The Workers trace
id is not readable inside the isolate.

**Allowlist.** An unauthenticated Worker that will `fetch` a caller-supplied URL is an SSRF proxy, so the viewer
accepts https URLs whose hostname is an exact, case-insensitive match for `github.com`, `gitlab.com`,
`codeberg.org`, `bitbucket.org`, or `git.sr.ht`. No suffix, no wildcard, no userinfo, default port only. A
trailing dot (`github.com.`) does not match. Lookalikes (`github.com.evil.com`, `evilgithub.com`, punycode)
do not match. Everything else is rejected before a fetch, and the error lists the supported hosts.
`VIEWER_EXTRA_HOSTS` appends exact hostnames (comma-separated). A token with a scheme, port, userinfo, wildcard,
or trailing dot is skipped, not treated as a suffix. Cloudflare Artifacts is off unless that variable names the
exact public git host. `ALLOW_REMOTE_ORIGINS` is a `/v1` test hook and does not apply to `/view`. Redirects are
manual, re-checked against the same allowlist, and limited to that repo's `info/refs` and `git-upload-pack`
paths (plus a `.git` suffix). A redirect to any other host is not followed. Upstream `User-Agent` is
`ply-viewer/0.1.0`.

**Caps** (not raised by environment; rate limits can be lowered and are clamped to 1…1000):

| Cap | Value |
|---|---|
| upstream bytes / page | 4 MiB |
| pack bytes mapped | 2 MiB |
| pack objects mapped | 400 |
| inflated bytes / pack | 4 MiB |
| one object | 1 MiB |
| file shown or returned raw | 256 KiB |
| delta chain | 32 |
| delta result | 1 MiB |
| upstream calls / page | 16 |
| redirects / upstream call | 2 |
| per-call timeout | 12 s |
| page timeout | 20 s |
| refs retained | 2000 (200 branches shown) |
| tree entries retained / shown | 2000 / 500 |
| parent commits shown | 5 |
| page rate | 60 / minute / client |
| pack-map rate | 20 / minute / client |

Over any cap the response is an HTML error (413 for a limit, 504 for a timeout), with the trace of the calls that
did finish. Rate limiting is a Durable Object, `ViewerRateLimit`, declared as a SQLite class. It is sharded by the
SHA-256 of `CF-Connecting-IP` (clients with no header share one shard). Each shard stores a short list of
timestamps per bucket, not addresses.
Immutable upload-pack responses are cached in the Workers Cache by SHA-256 of url + body; the viewer sends no
`Authorization`, so it cannot read a pack `/v1` cached under a credential. Cache hits do not spend the subrequest
budget. HTML is `no-store`, escaped, and served with `Content-Security-Policy: default-src 'none'; style-src 'self'; script-src 'none'` and `X-Content-Type-Options: nosniff`.

Deploying this Worker creates the `ViewerRateLimit` migration. This change does not deploy it.

## Develop / deploy

```sh
npm run worker:test                      # the Worker under workerd vs git http-backend
npm run worker:deploy                    # env -u CLOUDFLARE_API_TOKEN wrangler deploy -c worker/wrangler.jsonc
node worker/smoke.mjs https://ply.ivar.workers.dev read --out smoke.json
```
