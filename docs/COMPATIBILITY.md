# Compatibility and versioning

What a consumer of ply can rely on between versions, and what is checked. Each statement is marked either
**enforced** (a named check fails when it stops being true) or **policy** (a rule the maintainers follow; no check
holds it). Policy marked *(owner to confirm)* is the conservative reading of current practice, written down for #326,
and has not yet been confirmed by the owner.

## Versions

- **policy** ply is pre-1.0. A `0.MINOR.PATCH` version follows semver's rules for 0.x as npm applies them: a new
  minor (`0.2.x` to `0.3.0`) may break the API, a patch may not. There are no deprecation periods and no
  compatibility shims: a breaking change is a clean break, named as one in CHANGELOG.md with its migration step
  (REFACTOR.md: "Pre-1.0 and breaking by design: no compat shims"; README "Beta"). *(owner to confirm: whether a
  patch may ever carry a break before 1.0)*
- **policy** Until a version is prepared and published, the version field is a label, not a release: `main` has said
  `0.2.0` since 62f71ce while changes, breaking ones included, kept landing. Consumers who install from git pin a
  commit sha (README "Install") and read CHANGELOG.md and the commit log before moving it. *(owner to confirm: the
  version is bumped when a release is prepared, not on every breaking merge)*
- **enforced** The version is written in five places that must agree: `package.json`, `package-lock.json`, the user
  agent (`src/transport.ts`, `ply/<version>`), the tracer's OTLP scope version (`src/otel.ts`) and a
  `## <version>` section of CHANGELOG.md. `npm run release:prepare` refuses when any differ
  (`scripts/release-prepare.mjs`, `test/release-prepare.test.js`).

## Public API

- **policy** The public API is what `package.json` `exports` names (the root and its subpaths) and the types their
  `dist/*.d.ts` declare. Anything reached another way (a deep import of `dist/<file>.js`, an undocumented field) is not
  public. README states further limits: the step functions are public but their states are opaque, and the HTTP
  transport's internals (retry, redirect memo) are not public (README "Custom exchanges on a transport").
- **enforced** Every subpath in `exports` installs from the packed tarball with `--ignore-scripts` and imports
  under Node 20, 22 and 24 (`scripts/pack-check.mjs`, CI job `pack + install`); the root exports `Tracer` and `RETRY`
  (`scripts/dist-check.mjs`). The number of subpaths is pinned by hand in `test/dist-types.test.js` and
  `test/pack-install.test.js`, so adding or removing one is a visible change.
- **enforced** Error values: every error a function returns has a `code` from `src/errors.ts`, and `RETRY` maps each
  code to what a caller does (README "Errors"; `test/pure.test.js`). **policy** Adding a code, or changing which code
  or retry class an input produces, is user-visible and goes in CHANGELOG.md (under **Breaking** when a caller's
  existing switch would now take another branch).
- **policy** The module format is ESM only, with no `require` export condition. `require('ply')` works where Node
  loads an ES module with `require()` (README "Install"; **enforced** for the running Node by
  `scripts/pack-check.mjs`).

## Supported runtimes

| Runtime | What is checked | Where |
|---|---|---|
| Node 20, 22, 24 | the tarball installs with `--ignore-scripts`, every subpath imports, `require('ply')` behaves as README states | CI job `pack + install` (`scripts/pack-check.mjs --tarball` under each major) |
| Node 22 | the whole suite | CI `test-shard` jobs |
| TypeScript consumers: `lib` ES2022 + `@types/node` 20, 22, 24; `lib` DOM; `@cloudflare/workers-types` | the shipped `.d.ts` compile with `skipLibCheck: false`, `nodenext` resolution; DOM and Workers without the three `*-node` subpaths | `scripts/dist-check.mjs` (`npm run check`, CI `lint + fuzz`), `test/dist-types.test.js` |
| Cloudflare Workers (workerd) | the streaming and limit paths under the workerd runtime | `test/workerd.test.js`, the limit sweep |

- **enforced** `engines.node` is `>=20` (`test/pack-install.test.js` asserts it). The pinned type packages and their
  versions are in README "Requirements".
- **policy** Dropping a Node major or a TypeScript consumer variant is a breaking change, made only in a new minor
  and listed under **Breaking**. *(owner to confirm: Node 20 reached its upstream end of life in April 2026 and is
  still the floor; whether and when to raise it is the owner's decision)*
- Not supported: CommonJS builds, SHA-256 repositories, SSH transport (README "Requirements").

## Telemetry

Span names, kinds, parent/child structure, links and attribute keys with their value types are public API (README
"Telemetry contract").

- **enforced** `test/span-contract.test.js` runs every operation and the wire spans against real git and compares the
  shape with `test/span-contract.json`; any added, removed, renamed, retyped or moved span or key fails it until the
  snapshot is regenerated (`npm run test:spans:update`), so every change is a reviewed diff of that file. Naming
  rules (`git.<op>`, `git.<op>.<phase>`, attribute namespaces) are held by `test/pure.test.js`.
- **policy** Removing or renaming a span or key, changing a value's type, or moving a span is a breaking change and is
  listed under **Telemetry** (and **Breaking**) in CHANGELOG.md with the old and new names. Adding one is listed under
  **Telemetry**. Attribute values, and how many times a round trip repeats, are not part of the contract.
- **policy** The OTLP scope is `{ name: 'ply', version: <package version> }` (enforced equal at release preparation).

## The artifact

- **enforced** The npm tarball contains `package.json`, `README.md`, `LICENSE` and `dist/` (`files: ["dist"]`); it has
  no dependencies and installs with lifecycle scripts off (`scripts/pack-check.mjs`).
- **enforced** Two `npm run release:prepare` runs from the same commit with the same Node, npm and locked
  TypeScript produce byte-identical tarballs (`test/release-prepare.test.js` runs it twice on one commit and compares
  the SHA-256). See docs/RELEASING.md for what can change the bytes.
