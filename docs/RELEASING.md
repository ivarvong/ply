# Releasing

A release has three separate stages: **preparation** builds one artifact from one commit, **verification** checks
that exact file, and **publication** makes it available. Preparation and verification are automated by
`npm run release:prepare`; publication is manual, and its channel has not been chosen (see
[Distribution channel: open](#distribution-channel-open)). Nothing in this repository publishes, tags, pushes or
deploys a release.

## The artifact

`npm run release:prepare` (`scripts/release-prepare.mjs`) writes three files to `release-out/` (gitignored; `--out
<dir>` for another place):

| File | What it is |
|---|---|
| `ply-<version>.tgz` | the `npm pack` tarball: `package.json`, `README.md`, `LICENSE`, `dist/` |
| `ply-<version>.tgz.sha256` | its SHA-256, in `sha256sum` format |
| `ply-<version>.provenance.json` | package name and version; source repository, full commit id, commit date and dirty flag; Node, npm and TypeScript versions; the tarball's bytes and SHA-256; a contents hash (SHA-256 over the sorted `<sha256>  <path>` lines of every file in the tarball, independent of tar and gzip framing); the checks it passed |

What it does, in order (each step refuses with `release-prepare: refused: <reason>`, exit 1, and writes nothing):

1. **Source identity.** HEAD's full commit id. A tree with any change `git status --porcelain` lists, tracked edits or
   untracked files that are not ignored, is refused. `--allow-dirty` builds anyway, and the artifact is named
   `ply-<version>-dirty.tgz` with `"dirty": true` and the changed paths in its provenance. A dirty artifact is for
   local trials only; never publish one.
2. **Version agreement.** `package.json`'s version is semver and equals `package-lock.json`'s, the user agent
   (`src/transport.ts`), the tracer's scope version (`src/otel.ts`) and a `## <version>` section of CHANGELOG.md; and
   `## Unreleased` lists no entries.
3. **Build and pack.** `scripts/pack-check.mjs` `pack()`, the packing CI job `pack + install` uses: the tracked files
   are exported to a scratch directory, and `npm pack` there runs `prepare` (`tsc -p tsconfig.json`, the locked
   TypeScript). The tarball's own `package.json` must name the same package and version.
4. **Consumer checks on that exact file**, both installing it with `npm install --ignore-scripts`:
   `node scripts/pack-check.mjs --tarball <file>` (one package installed, every subpath imported, `require('ply')` as
   README states) and `node scripts/dist-check.mjs --tarball <file>` (the root loads; the `.d.ts` compile for
   `@types/node` 20, 22, 24, DOM and Workers). These run under the Node that runs the command.
5. **Write.** Only after every check passed: the tarball is copied to the output directory and hashed again, then the
   checksum and provenance are written.

### Reproducibility

Measured on 2026-11-18 (Node 22.23.5, npm 10.9.9, TypeScript 7.0.2): two runs from the same commit, in different
scratch directories, produced byte-identical tarballs (same SHA-256). `npm pack` writes fixed mtimes and normalised
modes, and `tsc` output depends only on the sources and the compiler. `test/release-prepare.test.js` runs the command
twice on one commit and requires the same SHA-256.

What can change the bytes for the same commit: a different TypeScript (it is locked in `package-lock.json`; install
with `npm ci`), and a different npm or Node (npm's tar layout and the zlib that gzips it). The **contents hash** in
the provenance is unaffected by tar and gzip framing, so two tarballs whose SHA-256 differ but whose contents hash is
equal hold the same files. To reproduce an artifact, check out `source.commit`, install the Node and npm versions
named in `build`, run `npm ci && npm run release:prepare -- --out <dir>`, and compare the SHA-256.

## Installing and verifying an artifact (consumers)

The tarball contains the built `dist/`, so it needs no `prepare` script, no dev tools and no network (ply has no
dependencies):

```sh
sha256sum -c ply-0.2.0.tgz.sha256                 # macOS: shasum -a 256 -c ply-0.2.0.tgz.sha256
npm install ./ply-0.2.0.tgz --ignore-scripts      # package.json gets "ply": "file:ply-0.2.0.tgz"
```

Then check `ply-0.2.0.provenance.json`: `tarball.sha256` is the same digest, `source.dirty` is `false`, and
`source.commit` is the commit you mean to depend on. npm records the tarball's `integrity` (SHA-512) in
`package-lock.json`, so later `npm ci` runs refuse a different file under the same name. Measured with npm 10.9.9;
other package managers' handling of a local tarball was not measured.

## Checklist

### Preparation (maintainer, local or CI)

- [ ] `main` at the commit to release; `npm ci`; `git status` is clean.
- [ ] CHANGELOG.md: `## Unreleased` renamed to `## <version>`, a new empty `## Unreleased` above it; every **Breaking**
      entry has its migration step.
- [ ] The version is set in `package.json`, `package-lock.json` (`npm version --no-git-tag-version <version>` sets
      both), `src/transport.ts` (`UA`) and `src/otel.ts` (scope version), in one commit that passes CI.
- [ ] `npm run check`, then `npm run release:prepare`. Keep the three files.

### Verification (before anything is published)

- [ ] `sha256sum -c release-out/ply-<version>.tgz.sha256` (macOS: `shasum -a 256 -c`).
- [ ] Provenance: `source.commit` is the intended commit, `source.dirty` is `false`, `package.version` is the version.
- [ ] The same tarball under the other supported Node majors: `node scripts/pack-check.mjs --tarball
      release-out/ply-<version>.tgz` under Node 20 and Node 24 (release-prepare ran it under one Node only; CI job
      `pack + install` does the same for its own tarball).
- [ ] CI is green on that commit (the `test` check).
- [ ] Optional: reproduce from a clean clone of the commit (above) and compare the SHA-256.

### Publication (manual; channel undecided)

- [ ] The channel is decided (below). Until then, this stage is not done.
- [ ] Publish the **verified file itself**, never a re-pack, with its `.sha256` and provenance beside it.
- [ ] Tag the source commit `v<version>` and push the tag, if the chosen channel uses tags.
- [ ] Tell consumers (ply-web) the version, the commit and the checksum.

## Distribution channel: open

Which channel a prepared artifact is published through is the owner's decision, tracked in #302 ("Packaging release
channel: decision pending with Ivar"). It has not been made. Today consumers install `github:ivarvong/ply#<sha>`
(README "Install"), which runs `prepare` and works with npm and pnpm 8 only, and CI uploads a tarball as the
`ply-tarball` workflow artifact, which needs a GitHub login and expires. The options, without a recommendation:

| Option | For | Against |
|---|---|---|
| npm registry, scoped name (`@<scope>/ply`; the name `ply` is taken) | standard `npm install`, semver ranges, every package manager, npm provenance attestations | imports change to `@<scope>/ply` unless consumers alias (`"ply": "npm:@<scope>/ply@0.2.0"`); an npm account, 2FA and publish token to manage; a published version cannot be replaced |
| GitHub Releases asset on a `v<version>` tag (tarball, `.sha256`, provenance) | no rename, no registry account; the checksum and provenance sit beside the file | installed by URL, so no semver ranges; needs the repository public (or a token) to download; the lockfile's integrity is the only automatic check |
| GitHub Packages (npm registry) | registry semantics tied to the repository | a scoped name; installing needs a GitHub token even for public packages |
| Vendored tarball in the consumer's repository (`"ply": "file:vendor/ply-<version>.tgz"`) | offline, exactly the verified bytes, no publishing at all | a binary in the consumer's history; each upgrade is a manual copy; serves only consumers who do it |
| Status quo: git commit pin, `prepare` builds on install | nothing to publish | needs scripts on and npm or pnpm 8; builds on the consumer's machine, so the installed bytes are not the verified artifact |

When the decision is made, record it in #302 and replace this section with the chosen channel's publication steps.
