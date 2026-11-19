// Release preparation (#326): one versioned tarball, its checksum and its provenance, from an identified source commit,
// checked as a consumer installs it. `npm run release:prepare [-- --out <dir>] [-- --allow-dirty]`.
//
// It prepares and verifies; it never publishes, tags, pushes or deploys (docs/RELEASING.md: publication is a separate,
// manual step whose channel is an open decision, #302). Nothing here writes into the checkout except <out>.
//
//   1. source identity: HEAD's full commit id; a tree with any change `git status --porcelain` lists (tracked edits or
//      untracked files that are not ignored) is refused unless --allow-dirty, which marks the artifact `-dirty` in its
//      file name and `dirty: true` (with the paths) in its provenance;
//   2. version metadata: package.json's version is semver and equals package-lock.json's, the user agent
//      (src/transport.ts UA) and the tracer's scope version (src/otel.ts); CHANGELOG.md has a `## <version>` section
//      and its `## Unreleased` section lists no entries (they belong under the version being prepared);
//   3. build and pack: scripts/pack-check.mjs pack(), a fresh export of the tracked files packed with `npm pack`
//      (its `prepare` builds dist/ with the locked typescript), the same packing CI job `pack` uses;
//   4. the artifact itself: the tarball's package.json names the same package and version; sha256 of the tarball,
//      and a contents hash (sha256 over the sorted `<sha256>  <path>` lines of every file in it), which does not
//      depend on tar or gzip framing;
//   5. consumer checks on that exact file, lifecycle scripts off: `node scripts/pack-check.mjs --tarball <file>`
//      (install --ignore-scripts, every subpath imported, require() as README states) and
//      `node scripts/dist-check.mjs --tarball <file>` (load, and the declarations compiled for Node 20/22/24 types,
//      DOM and Workers), both under the running Node;
//   6. only when every check passed: <out>/ply-<version>[-dirty].tgz, <file>.sha256 (sha256sum format) and
//      ply-<version>[-dirty].provenance.json, the tarball hashed again after the copy.
// Exit 0 and the three paths printed, or exit 1 with the reason (`release-prepare: refused: ...`) and nothing written.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { pack } from './pack-check.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
export const PROVENANCE_SCHEMA = 'ply-release-provenance/1';

class Refused extends Error {}

function sh(command, args, options) {
  const run = spawnSync(command, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  return { status: run.status, stdout: run.stdout ?? '', out: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// HEAD's full id and the paths `git status --porcelain` lists (ignored files are not listed).
export function sourceIdentity(repo = REPO) {
  const head = sh('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: repo });
  if (head.status !== 0) throw new Refused(`no source commit: git rev-parse HEAD failed: ${head.out.trim()}`);
  const status = sh('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: repo });
  if (status.status !== 0) throw new Refused(`git status failed: ${status.out.trim()}`);
  const dirtyPaths = status.stdout.split('\0').filter(entry => entry !== '').map(entry => entry.slice(3));
  const date = sh('git', ['show', '-s', '--format=%cI', 'HEAD'], { cwd: repo }).stdout.trim();
  return { commit: head.stdout.trim(), commitDate: date, dirty: dirtyPaths.length > 0, dirtyPaths };
}

// The `## <heading>` sections of CHANGELOG.md: { heading line's first word: body }.
export function changelogSections(text) {
  const sections = {};
  for (const part of text.split(/^## /mu).slice(1)) {
    const newline = part.indexOf('\n');
    const heading = (newline < 0 ? part : part.slice(0, newline)).trim();
    const key = heading.split(/\s/u)[0] ?? '';
    sections[key] = newline < 0 ? '' : part.slice(newline + 1);
  }
  return sections;
}

// Every place the version is written must agree. Returns the version, or throws Refused naming each disagreement.
export function versionAgreement(repo = REPO) {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const version = String(pkg.version);
  const problems = [];
  if (!SEMVER.test(version)) problems.push(`package.json version ${JSON.stringify(version)} is not semver`);
  const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8'));
  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    problems.push(`package-lock.json says ${lock.version} / ${lock.packages?.['']?.version}, package.json says ${version}`);
  }
  const ua = /^export const UA = 'ply\/([^']*)';$/mu.exec(readFileSync(join(repo, 'src/transport.ts'), 'utf8'))?.[1];
  if (ua !== version) problems.push(`src/transport.ts UA is ply/${ua}, package.json says ${version}`);
  const scope = /scope: \{ name: 'ply', version: '([^']*)' \}/u.exec(readFileSync(join(repo, 'src/otel.ts'), 'utf8'))?.[1];
  if (scope !== version) problems.push(`src/otel.ts tracer scope version is ${scope}, package.json says ${version}`);
  const changelogPath = join(repo, 'CHANGELOG.md');
  if (existsSync(changelogPath)) {
    const sections = changelogSections(readFileSync(changelogPath, 'utf8'));
    if (!(version in sections)) problems.push(`CHANGELOG.md has no "## ${version}" section`);
    const unreleased = sections.Unreleased;
    if (unreleased === undefined) problems.push('CHANGELOG.md has no "## Unreleased" section');
    else if (/^\s*[-*] /mu.test(unreleased)) problems.push(`CHANGELOG.md "## Unreleased" lists entries: move them under "## ${version}" (or a new version) first`);
  } else problems.push('CHANGELOG.md is missing');
  if (problems.length > 0) throw new Refused(problems.join('; '));
  return { name: String(pkg.name), version, repository: pkg.repository?.url ?? null };
}

// The regular files of a .tgz as { path: bytes } (ustar, with pax `path` records; directories and links skipped).
export function tarFiles(tgz) {
  const tar = gunzipSync(tgz);
  const files = {};
  const text = (start, length) => tar.subarray(start, start + length).toString('utf8').replace(/\0.*$/su, '');
  let offset = 0;
  let paxPath = null;
  while (offset + 512 <= tar.length) {
    if (tar.subarray(offset, offset + 512).every(byte => byte === 0)) break;
    const size = Number.parseInt(text(offset + 124, 12).trim() || '0', 8);
    const type = text(offset + 156, 1) || '0';
    const prefix = text(offset + 345, 155);
    const name = paxPath ?? (prefix === '' ? text(offset, 100) : `${prefix}/${text(offset, 100)}`);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    paxPath = null;
    if (type === 'x') paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/u.exec(body.toString('utf8'))?.[1] ?? null;
    else if (type === '0') files[name] = Buffer.from(body);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

// sha256 over `<sha256 of file>  <path>\n`, sorted by path: what is in the tarball, whatever its framing.
export function contentsHash(files) {
  const lines = Object.keys(files).sort().map(path => `${sha256(files[path])}  ${path}\n`);
  return { files: lines.length, sha256: sha256(lines.join('')) };
}

function toolVersions() {
  const npm = sh('npm', ['--version']).stdout.trim();
  const ts = JSON.parse(readFileSync(join(REPO, 'node_modules', 'typescript', 'package.json'), 'utf8')).version;
  return { node: process.versions.node, npm, typescript: ts };
}

// The existing consumer checks, on the exact file, lifecycle scripts off (both install with --ignore-scripts).
export const CONSUMER_CHECKS = ['scripts/pack-check.mjs', 'scripts/dist-check.mjs'];
function consumerChecks(tarball) {
  return CONSUMER_CHECKS.map(script => {
    console.log(`release-prepare: node ${script} --tarball ${basename(tarball)}`);
    const run = spawnSync(process.execPath, [join(REPO, script), '--tarball', tarball], { cwd: REPO, stdio: 'inherit' });
    if (run.status !== 0) throw new Error(`${script} --tarball failed (exit ${run.status}); nothing was written`);
    return `node ${script} --tarball (node ${process.versions.node}): ok`;
  });
}

export function prepare({ out, allowDirty }) {
  const source = sourceIdentity();
  if (source.dirty && !allowDirty) {
    throw new Refused(`the working tree is dirty (${source.dirtyPaths.slice(0, 10).join(', ')}${source.dirtyPaths.length > 10 ? ', …' : ''}); commit or stash, or pass --allow-dirty to build an artifact marked dirty`);
  }
  const meta = versionAgreement();
  const stem = `${meta.name}-${meta.version}${source.dirty ? '-dirty' : ''}`;
  const staging = mkdtempSync(join(tmpdir(), 'ply-release-'));
  try {
    const packed = pack(staging);
    const bytes = readFileSync(packed);
    const files = tarFiles(bytes);
    const inner = JSON.parse(String(files['package/package.json'] ?? '{}'));
    if (inner.name !== meta.name || inner.version !== meta.version) {
      throw new Refused(`the tarball's package.json is ${inner.name}@${inner.version}, expected ${meta.name}@${meta.version}`);
    }
    const verified = consumerChecks(packed);
    const digest = sha256(bytes);
    const provenance = {
      schema: PROVENANCE_SCHEMA,
      package: { name: meta.name, version: meta.version },
      source: { repository: meta.repository, commit: source.commit, commitDate: source.commitDate, dirty: source.dirty, ...(source.dirty ? { dirtyPaths: source.dirtyPaths } : {}) },
      releaseNotes: `CHANGELOG.md ## ${meta.version}`,
      build: { command: 'npm pack (prepare: tsc -p tsconfig.json) in a fresh export of the tracked files', ...toolVersions() },
      tarball: { file: `${stem}.tgz`, bytes: bytes.length, sha256: digest },
      contents: contentsHash(files),
      verified,
    };
    mkdirSync(out, { recursive: true });
    const tarball = join(out, `${stem}.tgz`);
    copyFileSync(packed, tarball);
    if (sha256(readFileSync(tarball)) !== digest) throw new Error(`${tarball} does not hash to ${digest} after the copy`);
    writeFileSync(`${tarball}.sha256`, `${digest}  ${stem}.tgz\n`);
    writeFileSync(join(out, `${stem}.provenance.json`), `${JSON.stringify(provenance, null, 2)}\n`);
    return { tarball, checksum: `${tarball}.sha256`, provenance: join(out, `${stem}.provenance.json`), digest, dirty: source.dirty };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outFlag = process.argv.indexOf('--out');
  const out = outFlag > 0 ? resolve(String(process.argv[outFlag + 1])) : join(REPO, 'release-out');
  try {
    const made = prepare({ out, allowDirty: process.argv.includes('--allow-dirty') });
    console.log(`release-prepare: ${made.dirty ? 'DIRTY ' : ''}artifact ${made.tarball}`);
    console.log(`release-prepare: sha256 ${made.digest} (${made.checksum})`);
    console.log(`release-prepare: provenance ${made.provenance}`);
    console.log('release-prepare: prepared and verified; nothing was published, tagged or pushed (docs/RELEASING.md)');
  } catch (error) {
    console.error(`release-prepare: ${error instanceof Refused ? 'refused: ' : ''}${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
