# Stack

A fast, small, proven core. The shipped code is TypeScript compiled to plain ESM; the verification around it
(tests, spaces, fuzzers, mutation) can be as heavy as it needs to be, because none of it ships.

| | Version | Role |
|---|---|---|
| TypeScript | 7.0.2 (native compiler, `tsc`) | types, `.d.ts`, emit to `dist/` |
| oxlint + oxlint-tsgolint | 1.90.0 + 7.0.2005 | lint, type-aware rules (tsgolint runs TypeScript 7) |
| vitest | 5.0.5 | test runner |
| Stryker + vitest runner | 10.1.1 | mutation testing of `src/**/*.{js,ts}` |
| esbuild | 0.28.2 | bundle budgets (test/bundle.test.js), workerd tests |

Runtime dependencies: none, ever. Node ≥ 22.18 runs `src/*.ts` directly (type stripping) for tests and fuzzers;
consumers get `dist/` (plain `.js` + `.d.ts`), so `engines.node` stays `>=20`.

## Compiler settings and why

`tsconfig.json` (build) is `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`,
`useUnknownInCatchVariables`, `verbatimModuleSyntax`, target ES2022, `module`/`moduleResolution` `nodenext`.

- `erasableSyntaxOnly`: no enums, namespaces, parameter properties or other syntax with runtime meaning. The emitted
  JS is the source with the types removed: zero size or speed cost, and Node can run the source as is.
- **Import specifiers stay `.js`** (`import { fail } from './errors.js'` even though the file is `errors.ts`): the
  `nodenext` convention. `tsc` maps `./x.js` to `x.ts` and emits it unchanged into `dist/`; vitest (Vite) resolves a
  `.js` specifier to the `.ts` file from both `.js` and `.ts` importers; plain Node gets the same mapping from
  `test/ts-resolve.mjs` (a `module.registerHooks` resolve hook: a relative `./x.js` that does not exist resolves to
  `./x.ts`, then Node ≥ 22.18 strips the types). Run fuzzers and scripts that load `src/` as
  `node --import ./test/ts-resolve.mjs …`; vitest's config puts it in `NODE_OPTIONS` so every child process and worker
  a test starts has it; CI sets `NODE_OPTIONS` for whole jobs. Consequence: converting a module renames one file and
  edits no importer. (Verified on this branch: `errors`, `limits`, `errors-doc` are `.ts`, imported as `.js` from
  40 JS modules, `tsc`, vitest and `node --import ./test/ts-resolve.mjs` all resolve them.)
- `isolatedDeclarations`: every export has an explicit type, so declarations never depend on inference across
  files. TypeScript refuses it together with `allowJs` (TS5053), and TS 7.0.2 panics in declaration emit when both are
  set, so it runs as its own check: `tsconfig.isolated.json` (only `src/**/*.ts`, `allowJs` off). While unconverted
  `.js` remains, that one check has `noImplicitAny` off so an import of a `.js` file is not an error there; the main
  check (`tsconfig.check.json`, every flag above) is where implicit `any` is caught.
- `allowJs` (migration only): `.js` and `.ts` coexist in `src/`; `checkJs` is off. The ratchet
  (`scripts/ts-ratchet.mjs`, part of `npm run typecheck`): the set of `.js` files under `src/` may only shrink. There
  is no list file to edit (a shared list is a merge conflict between parallel conversions): the base commit's tree is
  the list (`RATCHET_BASE` in CI, else the merge-base with `origin/main`/`github/main`). A `.js` file the base lacks
  fails. When none is left, the check also fails until the migration-only lint relaxations (below) are removed.
- No JSDoc types, ever. Types are TypeScript.

`npm run typecheck` = `tsc -p tsconfig.check.json` (src + `test/types/*.typetest.ts`, the compile-time tests: every
`@ts-expect-error` there must remain an error) + `tsc -p tsconfig.isolated.json` + the ratchet.

Migration-only lint relaxation: `typescript/no-unsafe-{assignment,member-access,return,call,argument}` are off while
`.js` remains, because a `.ts` file importing an unconverted `.js` module sees `any` (checkJs is off and there is no
JSDoc) and these rules would block converting in any order. `no-explicit-any` stays an error, so no `any` is written
by hand. The ratchet refuses to pass once `src/` has no `.js` and these are still off.

## Lint

`npm run lint` runs two profiles:

- **Strict** (`.oxlintrc.json`, `--type-aware --deny-warnings`) on `src/**/*.ts`: plugins eslint, typescript, unicorn,
  oxc, import, promise, node; categories correctness, suspicious, pedantic, perf **and restriction** at error (364
  rules on today's files), style off with picks. Turned off, each for a reason: `oxc/no-optional-chaining`,
  `oxc/no-rest-spread-properties`, `oxc/no-async-await` (ES5-compat restrictions; this is ES2022), `no-magic-numbers`
  (on only for parser and bounds files, as before), `no-undefined`, `unicorn/no-null` (both are values the wire and
  the API use), `no-plusplus`, `no-bitwise`, `no-continue` (parsers), `max-lines*`/`max-statements` (a parser is
  one function), `no-inline-comments` (`/* @__PURE__ */` annotations are inline by definition),
  `explicit-function-return-type` (isolatedDeclarations already requires it where it matters, at exports),
  `prefer-readonly-parameter-types` (fires on every `Uint8Array`). Style picks: `consistent-type-definitions: type`,
  `consistent-type-imports`, `array-type`, `no-inferrable-types`, `prefer-const`, `prefer-template`,
  `no-nested-ternary`, `import/no-duplicates`, `no-else-return`, `object-shorthand`, `numeric-separators-style`,
  `prefer-node-protocol`, `throw-new-error`, `no-array-for-each`, `prefer-at`, `import/no-default-export`,
  `import/extensions: always`.
  Type-aware rules include `no-unsafe-type-assertion`, `no-floating-promises`, `no-unsafe-*`,
  `switch-exhaustiveness-check`, `restrict-template-expressions`. A suppression is
  `// oxlint-disable-next-line <rule> -- <reason>`; there are three in the converted files, each at a type the
  compiler cannot follow (a union member built from a generic code; `Object.keys` of an exhaustive table; `match`).
- **Loose** (`oxlint.loose.json`) on unconverted `src/*.js` and on `test/`, `scripts/`, `examples/`: the rules ply
  had before this stack. Verification code may be as heavy as it likes.

## Rules for code in src/

1. **Errors are values.** A function that can fail returns `Result<T, E>` (`src/result.ts`: `ok`, `err`, `map`,
   `mapErr`, `andThen`, `match`, `assertNever`). It does not throw. `throw` is for programmer bugs only:
   `assertNever`, an `internal` invariant. Platform calls that throw (`fetch`, `crypto.subtle`, a socket) are caught
   at the edge that makes them and turned into an `Err`.
2. **The error type is a closed, exhaustive union.** `Code` (`src/errors.ts`) is the closed set of codes; `RETRY`
   and `CODE_DOCS` are typed `Record<Code, …>`, so a code without a policy or a doc does not compile. `PlyError` is
   the discriminated union over `code`; `Detail` holds the fields a code always carries (`http` → `status`,
   `limit_exceeded` → `what`/`got`/`max`, `cas_conflict` → `expected`/`actual`, `match_count` → `matches`,
   `merge_conflict` → `conflicts`), and `fail(code, message, detail)` requires exactly those. A `switch` over a
   union ends in `default: return assertNever(x)`; `match(u, handlers)` demands one handler per tag. Adding a code
   or a payload field re-checks every constructor and every match.
3. **A PlyError value is an `Error` instance** with its fields (`Object.assign(new Error(message), {code, …})`):
   a stack for whoever logs it, and the exact shape thrown errors have today, so the migration boundary is the
   identity (`orThrow(r)` is `if (!r.ok) throw r.error`). Nothing reads it as a class; its type is the union.
4. **Pure functions where possible; I/O at the edges.** Parsers, encoders, validators, planners and merges take
   bytes/values and return values. Network, timers, crypto and the filesystem live in the transport, http, ssh and
   `*-node.ts` modules, and are passed in, not imported, where a pure module needs them.
5. **State machines are tagged unions with transition functions.** A stream parser is
   `type State = { tag: 'header'; … } | { tag: 'body'; … } | { tag: 'done'; … }` and
   `step(state, input): Result<State, PlyError>`; the driver loop is the only thing with I/O. `pktStep`, `spStep`,
   `v2Step`, `streamStep` already have this shape in JS; converting them means typing the states, not rewriting them.
6. **Bounds before allocation**, as before: every wire-driven size is checked against a `limits.*` value
   (`checkLimit`/`readLimit` return `Result`) before a buffer exists.
7. **Bundle budgets hold.** Types cost nothing; runtime helpers do. Prefer a type to a runtime check when the value
   is already trusted; mark unused-but-exported module-level calls `/* @__PURE__ */` so esbuild drops them.

## Public API policy

Today every public function throws a `PlyError`-shaped `Error`. **Decision: the public API returns `Result`** —
`Promise<Result<T, PlyError>>` from `editFile`, `readFile`, `readLog`, `pushTree`, `checkoutTree`, `merge`, `rebase`,
`fetch*`/`push`, the client. We are 0.x; the break is allowed, and ply-web (the consumer we own) is updated in the
same step. Why: an exhaustive `switch (r.error.code)` at the call site is the point of the closed union; a `catch`
gets `unknown`.

Migration path:

1. **Foundation (this PR).** Toolchain; `result`, `errors`, `errors-doc`, `limits` in TypeScript. The public API is
   unchanged: `index` still exports the throwing constructor as `fail`, and unconverted modules import
   `thrown as fail` from `./errors.ts`. Limits shows the pattern: `checkLimit`/`readLimit`/`limitExceeded` are the
   value API; `finiteLimit`/`requireLimit`/`limitError` are the throwing wrappers JS callers still use.
2. **Clusters (parallel, below).** Internal functions return `Result`. A converted function still called by `.js`
   code gets a throwing wrapper at the boundary (`orThrow`), named as today, so its JS callers do not change.
   Public entry points keep throwing until step 3.
3. **Cut-over (one PR, after the ratchet list is empty).** Public entry points return `Result`; delete `thrown`,
   `orThrow`, and every throwing wrapper; `index` stops exporting `fail` as a constructor. Bump to 0.2.0. In ply-web,
   in the same window: bump the pin, replace `try { … } catch (e) { code = e.code }` with `if (!r.ok)` and a
   `switch (r.error.code)` ending in `assertNever` (ply-web already maps codes to HTTP statuses; it becomes
   exhaustive), delete `src/ply.d.ts` (ply ships its own types).

## Build and consumers

`npm run build` (= `prepare`) runs `tsc -p tsconfig.json`: `src/` → `dist/` (`.js` + `.d.ts`, imports rewritten to
`.js`). `package.json` `exports` keep every subpath (`.`, `./edit`, `./read`, … `./otel`) with `types` + `default`
conditions into `dist/`; `files` is `["dist"]`. `dist/` is not committed: a git-pinned consumer
(`"ply": "github:ivarvong/ply#<sha>"`) gets it from npm running `prepare` while it packs the git dependency.
Evidence and the alternative we rejected are in the PR description.

## Tests

vitest runs every `test/**/*.test.js` file that `node --test` ran before (`vitest.config.ts`); the fuzzers in
`test/fuzz/` stay node scripts. `npm test` = vitest + the fuzzer chain. CI shards vitest (`--shard i/N`).
Mutation testing: `@stryker-mutator/vitest-runner`, `mutate: src/**/*.{js,ts}`; the gate (`scripts/mutate.mjs`) is
unchanged: parser and bounds survivors fail a PR, 8 shards balanced by mutant count.

## Converting a module (the brief for cluster agents)

The rules that make parallel conversions collision-free: **a cluster touches only its own files**. Specifiers stay
`.js`, so no importer changes; the ratchet has no list, so no shared file changes. The shared files are
`src/errors.ts`, `src/result.ts`, `src/index.*`, `test/bundle.test.js` (budgets), `package.json` and CI: change them only
when your cluster cannot work without it, in a separate small commit, and say so in the PR body (the steward merges).
Branch from `stack/foundation` (or main once it lands); merge main into your branch as main moves (no rebase, no
force-push). Clusters and order: the T1–T7 / A1–A7 plan in `lab_notebook/ply-core-audit-2026-10-31.md` §11.

T (mechanical) PR, per file in the cluster:

1. `git mv src/x.js src/x.ts`. Nothing else outside the cluster changes; imports keep saying `./x.js`.
2. Type it. Exported declarations get explicit types (isolatedDeclarations). No `any` written by hand, no `!`, no
   enums/namespaces/parameter properties (erasableSyntaxOnly), class fields declared. `as` only where the compiler
   cannot follow, with `// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- <why>`. Byte buffers are
   `Uint8Array`. No behavior change; `// TODO(A<n>)` marks what the A pass should change.
3. Unconverted modules keep importing `thrown as fail` (the throwing constructor) from `./errors.js`; a converted
   file that still throws imports the same alias. Errors-as-values is the A pass.

A (errors as values, ADTs, state machines) PR, after its T:

4. Replace `throw fail(code, …)` with `return fail(code, …)` (the typed constructor from `./errors.js`), make the function
   return `Result`, handle every `Err` in the cluster (early return, `andThen`, `match`). A function still called from
   `.js` or from the public API keeps its old name as a throwing wrapper (`orThrow`) until the cut-over. A payload a
   code always carries goes in `Detail` in `errors.ts` (a shared file: one-line change, own commit).
5. Switches over unions end in `default: return assertNever(x)`; stream parsers become tagged states with a transition
   function.

Gate, all green before opening the PR (paste the numbers into the PR body):

- `npm run typecheck` (tsc check + isolated declarations + ratchet) and `npm run lint` (strict on `src/**/*.ts`).
- `npx vitest run <the test files that cover the cluster>`, then the full `npx vitest run`.
- The fuzzers that exercise the cluster (`node --import ./test/ts-resolve.mjs test/fuzz/<f>.mjs …`, the same flags as
  `npm test`).
- Bundle budgets: `npx vitest run test/bundle.test.js` passes, and the per-module bytes it prints for your files are
  ≤ before (types are free; a runtime helper must pay for itself).
- Mutation on your files: `node scripts/mutate.mjs` (mutates only files changed against main) — no new survivors in a
  parser or bounds function; the score on your files does not drop.
- `npm run build` and, for the A pass of an entry module, the ply-web acceptance below.
