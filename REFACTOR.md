# The refactor: target and gates

The rules are `docs/STACK.md` ("Rules for code in src/", "Absence", "Public API policy"). This file is the finish
line in numbers, and the order the work lands in. Pre-1.0 and breaking by design: no compat shims beyond the
throwing wrappers STACK.md step 2 allows until the cut-over.

## Finish line (each one a gate that fails the build, not a goal)

| # | Property | Gate | Today → done |
|---|---|---|---|
| 1 | No platform absence outside `src/absent.ts`: no `undefined`, `?:`, `?.`, `??` | `scripts/absence-ratchet.mjs` (in `npm run typecheck`) | see the baseline → all four 0 |
| 2 | Errors are values: `throw` only for `assertNever`, an `internal` invariant, and the throwing wrappers of step 2 | a throw ratchet (to add) | 398 throw sites → wrappers only, then 0 after the cut-over |
| 3 | Every switch or tag chain over a closed union ends in `assertNever` | `scripts/exhaustive.mjs` (in `npm run lint`) | holds |
| 4 | The public API returns `Result` (0.2.0), ply-web updated in the same window | the bundle and type tests on `dist/` | after 1 and 2 |
| 5 | Every gate CI runs is green on every commit to main | `.github/workflows/ci.yml`, all 26 jobs | the rewrite left 23 red; fixed at b350b96 |

## The one edge

Absence exists where a caller's data enters, and nowhere else:

- **Options** a caller may leave out are `Input<Config>` (`src/absent.ts`) and are parsed once, at the entry, by
  `withDefaults(options, freshDefaults())` into a total `Config`. Past that line no code asks whether a field is
  there. `Input<T>` is allowed for exactly two things: public entry option records, and the error `Extra` bag.
- **Shared mutable records** a caller owns and passes to every call (a transport's learned `quirks`) are filled in
  place with `fillIn`, so the caller's record stays the one later calls see.
- **A caller's transport** is a `TransportInput`; `asTransport` fills its quirks, harvest store and scrubber at the
  edge (`operation()`).
- **Thrown values and foreign records** (a JSONL line from another producer, a platform error) are read with
  `field` / `readKey` / `fromNullish`, which return `Option`.

Inside: absence a lookup produces is `Option<T>`; a total record's "none given" field is `T | null`; alternatives are
tagged unions.

## Order

1. **Green trunk** (b350b96). The rewrite's seven red pushes: commitChanges limits regression, http lint, decoder and
   decision registries, absence ratchet, stale sweep lines; #164.
2. **Wave 1: total shared types** (97802db, b2020be). Transport, OperationOpts, the thrown-value readers, otel: the
   types every cluster reads, so clusters convert without touching each other's files.
3. **Wave 2: clusters, in parallel** (STACK.md "Converting a module"): packs, wire, write, merge, read, core. Each
   drives its files to zero absence, returns `Result` internally, and keeps a throwing wrapper for what another
   cluster or the public API still calls.
4. **Leftovers**: exported types a cluster could not change without editing another cluster's file.
5. **Cut-over** (STACK.md step 3): public entries return `Result`; delete `thrown`, `orThrow` and every wrapper; 0.2.0;
   ply-web switches `catch` for an exhaustive `switch (r.error.code)`.

## Visible changes so far (callers can observe these)

- A `quirks` record passed to a transport is filled with the defaults (`treeFilter: 'tree:0'`, `blobWants: 'many'`)
  instead of staying empty until a fallback is learned.
- A root `Span`'s `parentSpanId` is `null` (the exported OTLP line still omits the key).
- Span `status` is a tagged union: only `code: 2` carries `message`.
- `memtree.replaceOnce` returns a `Result`.

## Not carried forward

Five PRs the rewrite closed and never re-landed: #167 and #168 (brands on validated refs and wire fields) and #169
(a total capabilities record) are subsumed by waves 1 and 2 in this style; #173 (pull-based stream primitives) is a
separate design change and should be re-proposed against the converted wire cluster. #164 landed in step 1.
