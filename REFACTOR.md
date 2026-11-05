# The refactor: target and gates

The rules are `docs/STACK.md` ("Rules for code in src/", "Absence", "Public API policy"). This file is the finish
line in numbers, and the order the work lands in. Pre-1.0 and breaking by design: no compat shims.

## Finish line (each one a gate that fails the build, not a goal)

| # | Property | Gate | Today → done |
|---|---|---|---|
| 1 | No platform absence outside `src/absent.ts`: no `undefined`, `?:`, `?.`, `??` | `scripts/absence-ratchet.mjs` (in `npm run typecheck`) | **met** (a7982c0): 308/375/146/260 → 0/0/0/0 |
| 2 | Errors are values: `throw` only for `assertNever`, an `internal` invariant, a stream's own protocol, and a caller's callback's value passed back | `scripts/throw-ratchet.mjs` (in `npm run typecheck`) | **met**: 377 → 23 (every one of those four kinds; no throwing wrapper is left) |
| 3 | Every switch or tag chain over a closed union ends in `assertNever` | `scripts/exhaustive.mjs` (in `npm run lint`) | holds |
| 4 | The public API returns `Result` (0.2.0), ply-web updated in the same window | the bundle and type tests on `dist/` | **met** in ply (rounds A–D); ply-web must switch before this lands on main |
| 5 | Every gate CI runs is green on every commit to main | `.github/workflows/ci.yml`, all 26 jobs | the rewrite left 23 red. Locally on ef29502 every gate passes but `push-ng` (local git 2.43; fails identically on the untouched pre-rewrite tag; CI runs 2.56) |

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
   drove its files to zero absence, returns `Result` internally, and kept a throwing wrapper for what another
   cluster or the public API still calls. Done: a7982c0.
4. **Leftovers**: LsRef total, OrMissing deleted, honest Result/wrapper names (ec02ad6, 3814e4a). Done.
5. **Cut-over** (STACK.md step 3), bottom-up so a function's callers convert after it: round A codecs and validation;
   round B protocol, transport and `operation()`; round C the entries (write, read, merge in parallel); round D
   delete `thrown`/`orThrow`, 0.2.0, docs. Tests keep their assertions through `test/unwrap.js`. Done. ply-web
   switches `catch` for an exhaustive `switch (r.error.code)` before this lands on main.

## Visible changes so far (callers can observe these)

- A `quirks` record passed to a transport is filled with the defaults (`treeFilter: 'tree:0'`, `blobWants: 'many'`)
  instead of staying empty until a fallback is learned.
- A root `Span`'s `parentSpanId` is `null` (the exported OTLP line still omits the key).
- Span `status` is a tagged union: only `code: 2` carries `message`.
- `memtree.replaceOnce` returns a `Result`.
- A listed ref (`LsRef`) always has `peeled` and `symref-target`, `null` when the line carries none.
- `parsePack` objects (and `resolvePack`'s, and `describePack`'s rows) carry `base`, a tagged union (`{ tag: 'none' }`,
  `{ tag: 'ofs', offset }`, `{ tag: 'ref', oid }`), in place of `baseOffset`/`baseOid`; `resolvePack` no longer writes
  `.oid` onto the caller's parsed objects. A hand-built `resolvePack` input gives `base` the same way with plain values
  (left out: none) and is parsed at resolvePack's edge: a bad type, base or data is `bad_request` (a type outside the
  six used to be `pack_corrupt`).
- A pack object's declared size is checked where its header is read (`readObjHeader`'s cap): `fetchObject` of an object
  past `maxObjectSize` is `limit_exceeded` with `what: 'pack object size'` (was `'object size'`), as `parsePack` already
  said, and the scan refuses it before reading an OFS/REF base.
- `inflate()` is a collector over the pull decoder, so it refuses what the pull refuses: CINFO > 7 (`zlib: window size N
  is not a zlib window`) and a back-reference past the declared window (`inflate: distance too far back`), both
  `pack_corrupt` (the owner's ruling on #172).
- A wide fetch whose want cannot be a blob (a tree or commit through the blob:none or unfiltered fallback) drops the
  pack's blobs and their deltas as their headers arrive; they are counted in `git.fetch.wide.blobs`, at their declared
  size in `git.fetch.wide.extra_bytes`.
- `mergeBase` with `maxDepth: null`, and `inflate` with `expectedSize: null`, mean "not given" (the configured limit,
  no expected size) instead of `bad_request`.
- Parse once (#156): a fetch want is an object id. A want git's upload-pack refuses ("expected to get oid": a ref name,
  an abbreviation, an empty want) is `bad_request` (`what: 'want'`) before any request; an upper-case id is sent
  lowercase (git reads either case as the same object); text after the id, which git ignores, is refused.
- `lsRefsBody` refuses a prefix with a NUL, CR or LF (`what: 'ref prefix'`, as `lsRefs`) instead of writing it.
- `encodeTree` refuses a mode other than the five git writes (`what: 'mode'`) and an id that is not 40 lowercase hex
  (`what: 'oid'`) instead of writing them; `buildCommitObjects` refuses a new blob id that is not one.
- `mergeBase` refuses an id that is not 40 lowercase hex (`what: 'oid'`) before any fetch; `walkPath` refuses its tree id
  (fetchObject's refusal) even when there is no path to walk.
- `validateSpec`'s plan carries `base` as `{ kind: 'ref', ref } | { kind: 'commit', oid }` (no `baseOid` flag);
  `editFile` parses the spec once, so a retry reuses the first attempt's commit time.

- 0.2.0: every exported function that can fail returns `Result<T, PlyError>`; `GitHttp` is built with
  `GitHttp.create(url, opts)` (a `Result`), and its methods return the free functions' Results.
- `fail` from the package is `Err(plyError(…))`; `plyError` builds the error value. `thrown`/`orThrow` are gone.
- A value a caller-supplied transport raises that carries a ply code but is not an `Error` comes back as the Err,
  unchanged (it used to be rethrown); it is never mistaken for ply's own `cas_conflict` (no retry) or an unborn HEAD.
- A value the caller's own callback throws (a signer, a `fetchImpl`) still propagates as thrown.
- The user agent and the otel scope version are `ply/0.2.0` / `0.2.0`.

## Not carried forward

Five PRs the rewrite closed and never re-landed: #167 and #168 (brands on validated refs and wire fields) and #169
(a total capabilities record) are subsumed by waves 1 and 2 in this style; #173 (pull-based stream primitives) is a
separate design change and should be re-proposed against the converted wire cluster. #164 landed in step 1.
