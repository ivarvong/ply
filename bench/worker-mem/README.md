# worker-mem: ply's streaming paths inside a real Worker

A manual harness that proves ply's streaming paths stay inside real Cloudflare Workers limits (128 MB isolate memory,
the configured CPU limit) on inputs far larger than isolate memory. It deploys a scratch Worker, `ply-memlab`, bundled
from this checkout's `dist/`, and drives it from the laptop. Nothing here ships: the package publishes `dist/` only,
the harness has no dependencies beyond the repo's dev tooling, and CI never runs it (it needs network and an account).

## Cells

| cell | what runs in the Worker | pass means |
|---|---|---|
| `scan` | `packStream` of the seed repo's whole history (one ~1 GiB pack) into `parsePackInit/Feed/Pull` with `WORK_BUDGET`, verify on | the trailer is reached, every object hashed, nothing retained; no `exceededMemory` / `exceededCpu` |
| `read` | `openBlob` of the seed's 30 MiB blob, streamed and counted | bytes = declared size |
| `bomb` | a 1 GiB-of-zeros blob (~1 MB deflated) built in the Worker, scanned with `WORK_BUDGET` and default limits | refused with `limit_exceeded` before work passes the budget |
| `bombworker` | the same bomb under `WORKER_LIMITS` | refused, earlier |
| `index` | the streaming pack index (#236) over the same pack | pending until ply exports `scanPackIndex` and the Worker runs with `--pending on` |
| `scanprofiled` | the `scan` cell with a 10 s heap capture taken 4 s in | reported apart from `scan` (profiling adds overhead); the report records which captures overlapped their scan |
| `pushpack` | one request per seed commit: `packStream` of that commit (previous commit as a have) piped as a `ReadableStream` into `pushPack` (#234), under a 64 MiB − 64 KiB `maxPackBytes`, into a throwaway `ply-loadgen` repo | every report line `ok`; afterwards a stock `git clone --mirror` of the destination passes `git fsck --strict` with the seed's head and object count; the destination and its tokens are then removed |

Each request's CPU time, wall time and outcome come from Workers Observability, joined to the cell by the request id
of the Worker's `memlab` log line. In-Worker `Date.now()` only advances on I/O, so in-Worker wall times are I/O time,
not CPU. Heap profiles (`cf workers versions profile --profile-type heap`) are captured while a scan runs. They are
allocation sampling (`alloc_objects`, `alloc_space` over the capture window), not in-use memory, so they show where
bytes are allocated, not the peak; the evidence for bounded memory is the outcome (no `exceededMemory`) on a pack many
times the isolate's 128 MB. Each report records the Worker version, the ply commit it was built from (`/health`
`x-memlab-ply`) and the configured CPU limit (`x-memlab-cpu-limit-ms`, 300,000 ms).

## Run

```sh
node bench/worker-mem/seed.mjs          # once: creates + pushes the seed repo (~1.1 GiB, ~12 min on a home link)
npm run bench:worker-mem -- --cells bomb,bombworker,read --profiles 0          # build, deploy, short cells
npm run bench:worker-mem -- --no-deploy --url https://ply-memlab.<sub>.workers.dev --cells scan --profiles 10  # ~25 min
npm run bench:worker-mem -- --cells pushpack --runs 19 --profiles 0            # relay all 19 seed commits + verify
node bench/worker-mem/seed.mjs --delete # remove the seed repo
```

Reports land in `bench/worker-mem/reports/<run>.{json,md}` (gitignored), profiles in `reports/<run>-profiles/`.
Every number in a report carries the Worker version id it was measured on.

## Credentials and cleanup

- `cf` runs with `CLOUDFLARE_API_TOKEN` unset (OAuth), never wrangler.
- The Worker's bearer is generated once into `~/.config/ply/memlab-token` (0600) and uploaded as the `MEMLAB_TOKEN`
  secret through a 0600 secrets file that is deleted after the deploy. It is never printed.
- The seed repo lives in the `ply-loadgen` Artifacts namespace. `seed.mjs` revokes the repo-create token, mints one
  2-hour write token for the pushes, and revokes it at the end (and checks it is refused). The Worker reads through
  its Artifacts binding: each request mints a 15-minute read token and revokes it when done.
- `seed.mjs` keeps the one seed repo (named in `.data/seed.json`) for reruns; `--delete` removes it.

## Files

- `worker.mjs`: the Worker (cells, NDJSON responses, `memlab` log line).
- `build.mjs`: esbuild bundle + cf Build Output (`.cloudflare/output/v0`), so `cf deploy --prebuilt` uploads exactly it.
- `seed.mjs`: seed repo create / push / delete.
- `run.mjs`: the one command.
- `lib.mjs`: cf wrapper, redaction, secrets files, quantiles.
