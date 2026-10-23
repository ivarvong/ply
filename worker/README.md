# ply Worker — `https://ply.ivar.workers.dev`

A stateless Cloudflare Worker that exposes ply as an HTTP API against any smart-HTTP git host. No bindings, no
storage. Everything is in `worker/index.js`, and `GET /` prints the usage text.

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

## Develop / deploy

```sh
npm run worker:test                      # the Worker under workerd vs git http-backend
npm run worker:deploy                    # env -u CLOUDFLARE_API_TOKEN wrangler deploy -c worker/wrangler.jsonc
node worker/smoke.mjs https://ply.ivar.workers.dev read --out smoke.json
```
