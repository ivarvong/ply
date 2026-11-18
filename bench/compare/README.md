# bench/compare: ply against native git, end to end

A local, account-free benchmark of two user tasks, done by ply and by four documented native-git strategies against the
same `git http-backend` server and the same deterministic repositories (issue #323):

- **read**: get the bytes of one file at `refs/heads/main`;
- **edit**: replace one marker in that file, commit, and push to `refs/heads/main`.

```sh
npm run bench:compare                     # builds dist/, runs the default matrix (5 repetitions), prints the table
npm run bench:compare -- --full           # the wide matrix (tens of minutes)
npm run bench:compare -- --reps 9 --machine "what this machine is"
node bench/compare/run.mjs --render bench/compare/results/<file>.json    # the table again, from a results file
```

No credentials, no deployment, no network beyond `127.0.0.1`. It needs `git` and `sed` on `PATH` and the repository's Node (22; `--ply src` needs
22.18 or later). It writes `bench/compare/out/results.json` and `bench/compare/out/results.md` (not tracked; `--out <dir>` moves
them) and prints the Markdown, which is rendered from the JSON file it just wrote. The exit status is 1 when any sample
failed; the failure is in both files either way. All flags are in the header of [run.mjs](run.mjs).

**What this does not tell you.** Client and server share one machine over loopback: these timings do not predict WAN
latency, where round trips and bytes weigh more and CPU weighs less (read the request counts and byte totals for that;
they do not depend on the link). And it does not establish Cloudflare Workers memory usage: ply runs here as a Node
process, whose baseline and accounting are not an isolate's; [bench/worker-mem](../worker-mem/README.md) measures that
on the platform. Timing here is not a PR gate. `test/bench-compare.test.js` runs the smallest matrix once as a
correctness check (every sample verified, the JSON as documented) and asserts no duration and no winner.

Recorded runs are in [results/](results/), each a JSON file and the table rendered from it, named by date and source
commit and labelled with the machine they ran on.

## What is compared

| id | strategy | read | edit |
|---|---|---|---|
| `ply` | one node process importing `ply/read` and `ply/edit` from `dist/` | `readFile`, streamed to a file | `editFile` |
| `git-full` | full clone with checkout | `git clone -q URL DIR`; the file is `DIR/PATH` | clone, `sed -i`, `git commit -q -a -m MSG`, `git push -q origin HEAD:refs/heads/main` |
| `git-shallow` | `--depth 1` clone with checkout | `git clone -q --depth 1 URL DIR` | as above after the shallow clone |
| `git-partial` | blobless partial clone, full commit and tree history | `git clone -q --filter=blob:none --no-checkout URL DIR`, then `git -C DIR cat-file blob HEAD:PATH > OUT` (one blob fetched on demand) | the same clone, `git sparse-checkout set --no-cone /PATH`, `git checkout -q main` (one blob fetched), then sed, commit, push |
| `git-shallow-partial` | `--depth 1 --filter=blob:none --no-checkout`: the leanest stock-git strategy measured | as `git-partial` with `--depth 1` | as `git-partial` with `--depth 1` |

The exact argv of every step, set-up included, is in `strategies` in the results JSON and under "Strategies" in the
rendered table; both are generated from the definitions the harness executes (`CLIENTS` in [lib.mjs](lib.mjs)), so they
cannot drift from what ran. Steps run one after another with no shell.

The two partial strategies need the server to advertise `filter` (`uploadpack.allowFilter`). On a server that does not
(`--server stock`), git would print a warning and clone unfiltered, so those cells are recorded as `unsupported` with
the reason instead of being measured as something they are not. ply runs on both.

**Fresh and reused state are separate tables.**

- *fresh*: an empty client directory and new processes. Elapsed time includes process start-up for every client.
- *reused*: git starts from an existing clone of its strategy that is one commit behind (made before the measurement,
  not timed), and the measured steps are `git pull -q --ff-only origin main` (or `git fetch` + `cat-file FETCH_HEAD:PATH`
  for a partial read) and the task. The head commit rewrites the target file, so the stale clone lacks the current
  blob. ply keeps no repository state, so its reused mode is a warm process: the same task runs once, unmeasured,
  against the one-commit-behind copy (module load, JIT, a kept-alive connection, learned server quirks), then the
  measured call. Its elapsed time is `performance.now()` around that call and excludes process start-up; its memory
  covers the whole process. ply's optional pack cache is not exercised. Reused elapsed figures are not comparable with
  fresh ones.

**Held equal.** One server process and one fixture per cell for every client; every sample runs against its own fresh
copy of the fixture repository in an empty client directory (so nothing a previous sample pushed, packed or cached is
there); one author, committer, date (`1750000000 +0000`), message and replacement (`POLICY` in lib.mjs). Because parent,
tree and headers are equal, every client must write the *same commit id*, and the harness records per cell whether
they did (`cells[].commitAgreement`). Native git runs with no user or system config and with `gc.auto=0`,
`maintenance.auto=false` (a detached maintenance process would escape the measured tree and race the reset).

**Not equal, by nature.** git leaves a usable clone behind; ply leaves nothing. The tasks are equal in their effect on
the server and in the bytes read, not in what remains on the client.

## Fixtures and matrix

A fixture is a pure function of `(seed, cell)` (`--seed`, default 323): `commits` commits on `main` written by
`git fast-import` with fixed identities and dates, each rewriting one of 24 background files of 1 KiB; the target file
is rewritten in 8 of them (the last being the head commit) by overwriting 48-byte regions, and holds the marker
`@@PLY-BENCH-MARKER@@` exactly once. The repository is repacked into one pack by one thread and passes
`git fsck --strict` before use. The head commit id of every cell is in the results (`cells[].fixture.head`); the same
seed gives the same id (asserted in the test).

The default matrix changes one factor at a time around a base cell, 9 cells in all:

| factor | values (base in bold) |
|---|---|
| history, commits | 20, **200**, 2000 |
| target file size | 4 KiB, **64 KiB**, 4 MiB, 32 MiB |
| content (compressibility) | **text** (words from a 256-word vocabulary; zlib ratio about 0.3), random bytes (ratio about 1.0); the measured ratio is in `cells[].fixture.zlibRatio` |
| directory depth of the target | 1, **2**, 8 |

Fresh mode runs in all 9 cells; reused mode in three (the base, 2000 commits, 4 MiB). The default run takes about
five minutes on the machine of the recorded run. `--full` widens every axis
(20,000 commits, depth 16, large random files, one combined cell) and runs reused mode everywhere. Within a cell,
task and mode, repetitions are the outer loop and the client order rotates by one each repetition, one client at a
time, so a change in the machine's load falls on every client.

## Metrics

The definitions travel with the data (`metricDefinitions` in the JSON, printed at the end of the table). In short:

| metric | how it is measured | known error |
|---|---|---|
| `elapsedMs` | wall clock around the client's steps, taken by a separate measuring process ([measure.mjs](measure.mjs)); ply reused: `performance.now()` around the call | includes whatever else the machine is doing (`environment.loadavg`); the memory sampler is a separate process that competes for CPU with the client (`--no-memory` runs without it) |
| `peakRssSumBytes` | peak over samples of the sum of `Rss` (`/proc/<pid>/smaps_rollup`) over the client's process tree | upper bound for a multi-process client: a page shared by git, git-remote-http and index-pack is counted once per process. Sampled: a lower bound in time |
| `peakPssBytes` | the same with `Pss` | no double counting inside the tree, but pages shared with processes *outside* it are discounted too: the node binary is shared with the harness's node processes, so node's PSS is far below its RSS. The memory a tree needs lies between the PSS sum and the RSS sum |
| `maxProcessHwmBytes` | largest `VmHWM` (the kernel's per-process high-water RSS) of any one process in the tree | what `/usr/bin/time -v` or `getrusage(RUSAGE_CHILDREN)` reports: the largest process, not the tree |
| `plySelfMaxRssBytes` | ply only: `process.resourceUsage().maxRSS` just before exit (exact) | compare with `maxProcessHwmBytes` to see the sampler's shortfall |
| `requests`, `requestBytes`, `responseBytes` | counted inside the server process for every client alike: request line + headers + body, status line + headers + body | excludes chunked framing and TCP/IP; a gzip-encoded request body counts as sent |
| `fetchPackBytes` | side-band channel 1 bytes after `packfile` in protocol v2 upload-pack responses | `null` if no pack was fetched |
| `pushPackBytes` | the receive-pack request body after the command list (after gunzip when gzip-encoded) | `null` for a read |

**The process tree.** Native git is several processes (`git`, `git-remote-http`, `index-pack`, `pack-objects`, and here
`sed`). Each step is spawned as a session leader; its descendants inherit the session id and cannot leave it for
another one, so "session id = the step's pid" names the whole tree even after a parent exits. Every sample (1 ms
is asked for between samples; the interval achieved is recorded per sample) reads each member's `smaps_rollup` and `status`. Sampling
is a lower bound: a peak between two samples, or a process that lives for less than one interval (`git --version`),
is not seen. Two checks on the sampler are part of every run (`baselines` in the JSON): a node child that fills a
64 MiB buffer and holds it for 300 ms must show about 64 MiB more than an empty one, and ply's own exact `maxRSS`
sits beside the sampled high-water mark of the same process. The server's processes and the harness are not in the
tree. This needs Linux `/proc`; elsewhere, or with `--no-memory`, the memory metrics are `null` and
`memory.unavailable` says why. No number is substituted.

**Baselines.** A node process that imports the ply modules and exits is measured the same way and reported
(`baselines.nodeIdle`), because at these sizes ply's process memory and fresh-mode time are mostly the runtime's.

**Verification.** A sample counts only after the harness has checked, with git plumbing on the server repository and
values it computed itself from the fixture generator (neither client's word is taken):

- read: the sha256 and length of the bytes the client produced equal the file at the ref; the ref has not moved;
- edit: `main` is exactly one new commit whose only parent is the previous head; the blob at `main:PATH` has the
  intended final sha256; the commit changes that path and nothing else; author, committer, date and message are the
  stated ones; no other ref exists;
- both: `git fsck --strict` reports nothing.

A sample that fails any check, or whose client exits non-zero, is recorded with `status: "failed"` and its reason,
counted in the `ok/n` column and listed under "Failures". It is never dropped and never enters a statistic.

**Statistics.** Median, min, max, q1 and q3 of the accepted samples, n stated; quantiles by linear interpolation between
order statistics (R type 7). The comparison section lists every cell where ply's median is higher than the leanest git
strategy's, and says whether the two min-max ranges overlap; an overlapping difference is reported but is not a result.

## Results JSON (`ply-bench-compare/1`)

`validateResults` in lib.mjs is the schema check; the test runs it.

| key | content |
|---|---|
| `schema`, `generatedAt`, `durationMs`, `command` | identity of the file and the invocation |
| `source` | `commit` (HEAD), `dirty`, `dirtySha256` (sha256 of `git diff HEAD` plus untracked files; `null` when clean), `dirtyPaths` |
| `environment` | `node`, `git`, `os`, `cpus`, `totalMemBytes`, `loadavg` (`before`, `after`, `max1m`), `machine` (`--machine`) |
| `config` | `seed`, `repetitions`, `matrix`, `plyBuild`, clients, tasks, modes, sampling interval, order, reset policy |
| `server` | kind, whether it advertises `filter`, the served repository's git config, the client git's config, where bytes are counted |
| `policy` | author, committer, time, message, find, replace |
| `metrics`, `metricDefinitions`, `statistics`, `caveats` | what each number is, and the WAN and Workers limits |
| `strategies` | per client: label, description, exact set-up and measured commands per task and mode |
| `baselines` | `nodeIdle`, `nodeEmpty`, `nodeHolding64MiB`, `gitIdle`, `samplerCheck` |
| `cells[]` | `id`, `params`, `fixture` (path, head, sha256s, zlib ratio, pack bytes, objects), `commitAgreement` |
| `samples[]` | one per attempt: `cell`, `task`, `mode`, `client`, `rep`, `status` (`ok`, `failed`, `unsupported`), `reason`, `metrics`, `memory`, `timing`, `http` (totals and each request), `verification` (every check) |
| `summary[]` | per cell, task, mode, client: `attempted`, `accepted`, `failed`, `unsupported`, `reasons`, per-metric statistics |
| `comparisons[]` | ply against each git strategy per metric: both medians, `ratio`, `verdict` (`ply-lower`, `tie`, `ply-higher`), `separated` |
| `totals` | sample counts by status |

## Limits of this benchmark

- One machine, loopback, HTTP/1.1 without TLS or auth; `git http-backend` behind a Node CGI shim that shares the CPUs
  with the clients. A hosted service has pack caches, bitmaps and a network in between.
- Repositories are synthetic and small next to real monorepos; `--full` goes to 20,000 commits and 32 MiB files, no further.
- Memory is sampled, Linux only, and at these sizes dominated by runtime baselines. It says nothing about a Worker isolate.
- ply's reused mode models a warm process, not a cache; ply's pack cache and head hint are not measured here.
- One git version and one Node version per run (both recorded). git's behaviour here (protocol v2, partial clone,
  non-cone sparse checkout) is that of the recorded version.
