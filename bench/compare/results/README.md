# Recorded runs of bench/compare

Each run is two files: `<date>-<source commit>.json`, exactly as `npm run bench:compare` wrote it, and the `.md`
rendered from that JSON with `node bench/compare/run.mjs --render <file>.json`. The Markdown repeats everything needed
to judge a run (source commit and dirty state, seed, versions, machine, load, repetitions, metric definitions).

| file | date (UTC) | measured code | command | machine |
|---|---|---|---|---|
| [2026-11-18-6636294](2026-11-18-6636294.md) | 2026-11-18 | commit `6636294`, clean tree, `dist/` built from it | `npm run bench:compare -- --machine "…"`: default matrix, seed 323, n = 5 | a shared cloud container (Firecracker VM, 4 vCPU, 16 GiB) with other workloads running on it during the run |

**Caveats for 2026-11-18-6636294.** It was not measured on a quiet machine: the 1-minute load average was 2.46 before
the run began and peaked at 3.92 on 4 CPUs. Its elapsed times are noisy and must not be quoted as quiet-machine
figures; its request counts, byte totals and pack sizes do not depend on load. Loopback timing does not predict WAN
latency, and Node process memory does not establish Workers memory usage. Its `.md` was rendered by the commit after
`6636294` (a wording change to the load note, exact bytes where two medians print alike, and the "Where ply is lower"
list); the JSON, and so every number, is the run's own.

To add a run: `npm run bench:compare -- --machine "<what the machine is>"` on a clean tree, then copy
`bench/compare/out/results.json` here under the date and short commit and render it.
