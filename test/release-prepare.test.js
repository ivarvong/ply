// npm run release:prepare (scripts/release-prepare.mjs, #326), run for real in a scratch git repository holding this
// checkout's tracked files as one commit (node_modules linked, as pack-check does). The judges are git, sha256 over
// the bytes on disk, and tar's own listing of the tarball, not the script's report of itself:
//   a clean commit gives ply-<version>.tgz, a .sha256 that sha256sum -c accepts and a provenance naming that commit
//   and that digest, and a second run gives the same bytes;
//   a dirty tree is refused and writes nothing, or with --allow-dirty is named and marked dirty;
//   a version that disagrees with CHANGELOG.md or the user agent, or a non-empty Unreleased, is refused.
// CI does not run release:prepare on the repository itself: between releases CHANGELOG.md has Unreleased entries,
// which it refuses. Its packing and its two consumer checks are the ones CI job `pack + install` and `lint + fuzz` run.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, symlinkSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshExport } from '../scripts/pack-check.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const ENV = { ...process.env, NODE_OPTIONS: '', GIT_AUTHOR_NAME: 'ply', GIT_AUTHOR_EMAIL: 'ply@example.com', GIT_COMMITTER_NAME: 'ply', GIT_COMMITTER_EMAIL: 'ply@example.com' };
let repo;
let scratch;

const git = (...args) => {
  const run = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo.dir, env: ENV, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stdout}${run.stderr}`);
  return run.stdout.trim();
};
const prepare = (out, ...flags) => spawnSync(process.execPath, [join(repo.dir, 'scripts/release-prepare.mjs'), '--out', out, ...flags], { cwd: repo.dir, env: ENV, encoding: 'utf8' });
const outDir = name => join(scratch, name);
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

before(() => {
  repo = freshExport();
  scratch = mkdtempSync(join(tmpdir(), 'ply-release-test-'));
  symlinkSync(join(ROOT, 'node_modules'), join(repo.dir, 'node_modules'));
  // The repository's own CHANGELOG.md has Unreleased entries between releases, which release:prepare refuses by
  // design; the fixture's is one a release would have, so this file tests the script, not the repository's readiness.
  writeFileSync(join(repo.dir, 'CHANGELOG.md'), `# Changelog\n\n## Unreleased\n\n_Nothing yet._\n\n## ${VERSION}\n\n- the fixture's release notes\n`);
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'release fixture');
}, 60_000);
after(() => {
  if (repo) repo.cleanup();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test('a clean commit gives a tarball, a checksum and a provenance that agree, and the same bytes twice', () => {
  const run = prepare(outDir('clean'));
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.deepEqual(readdirSync(outDir('clean')).sort(), [`ply-${VERSION}.provenance.json`, `ply-${VERSION}.tgz`, `ply-${VERSION}.tgz.sha256`]);
  const tarball = join(outDir('clean'), `ply-${VERSION}.tgz`);
  const digest = sha256(tarball);

  // the checksum file is in sha256sum's format and sha256sum accepts it
  assert.equal(readFileSync(`${tarball}.sha256`, 'utf8'), `${digest}  ply-${VERSION}.tgz\n`);
  const check = spawnSync('sha256sum', ['-c', `ply-${VERSION}.tgz.sha256`], { cwd: outDir('clean'), encoding: 'utf8' });
  if (check.error === undefined) assert.equal(check.status, 0, `${check.stdout}${check.stderr}`); // no sha256sum (older macOS): the digest above is the check

  const provenance = JSON.parse(readFileSync(join(outDir('clean'), `ply-${VERSION}.provenance.json`), 'utf8'));
  assert.equal(provenance.schema, 'ply-release-provenance/1');
  assert.deepEqual(provenance.package, { name: 'ply', version: VERSION });
  assert.equal(provenance.source.commit, git('rev-parse', 'HEAD'));
  assert.match(provenance.source.commit, /^[0-9a-f]{40}$/u);
  assert.equal(provenance.source.dirty, false);
  assert.equal(provenance.tarball.sha256, digest);
  assert.equal(provenance.tarball.bytes, readFileSync(tarball).length);
  assert.equal(provenance.build.node, process.versions.node);
  assert.deepEqual(provenance.verified.map(line => line.split(' --tarball')[0]), ['node scripts/pack-check.mjs', 'node scripts/dist-check.mjs']);

  // the file count against tar's own listing; package.json in it carries the version
  const listed = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).stdout.split('\n').filter(line => line !== '' && !line.endsWith('/'));
  assert.equal(provenance.contents.files, listed.length);
  assert.ok(listed.includes('package/package.json') && listed.includes('package/dist/index.js'));
  const inner = spawnSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }).stdout;
  assert.equal(JSON.parse(inner).version, VERSION);

  // reproducible: a second run from the same commit gives the same bytes
  const again = prepare(outDir('again'));
  assert.equal(again.status, 0, `${again.stdout}${again.stderr}`);
  assert.equal(sha256(join(outDir('again'), `ply-${VERSION}.tgz`)), digest);
}, 180_000);

test('a dirty tree is refused and nothing is written; --allow-dirty names and marks the artifact dirty', () => {
  const readme = join(repo.dir, 'README.md');
  const original = readFileSync(readme, 'utf8');
  writeFileSync(readme, `${original}\nan uncommitted line\n`);
  try {
    const refused = prepare(outDir('dirty-refused'));
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /release-prepare: refused: the working tree is dirty \(README\.md\)/u);
    assert.equal(existsSync(outDir('dirty-refused')), false);

    const allowed = prepare(outDir('dirty-allowed'), '--allow-dirty');
    assert.equal(allowed.status, 0, `${allowed.stdout}${allowed.stderr}`);
    assert.deepEqual(readdirSync(outDir('dirty-allowed')).sort(), [`ply-${VERSION}-dirty.provenance.json`, `ply-${VERSION}-dirty.tgz`, `ply-${VERSION}-dirty.tgz.sha256`]);
    const provenance = JSON.parse(readFileSync(join(outDir('dirty-allowed'), `ply-${VERSION}-dirty.provenance.json`), 'utf8'));
    assert.equal(provenance.source.dirty, true);
    assert.deepEqual(provenance.source.dirtyPaths, ['README.md']);
    assert.equal(provenance.tarball.sha256, sha256(join(outDir('dirty-allowed'), `ply-${VERSION}-dirty.tgz`)));
  } finally { writeFileSync(readme, original); }

  // an untracked file that is not ignored is dirty too
  writeFileSync(join(repo.dir, 'stray.txt'), 'x\n');
  try {
    const refused = prepare(outDir('untracked'));
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /dirty \(stray\.txt\)/u);
  } finally { rmSync(join(repo.dir, 'stray.txt')); }
}, 180_000);

test('version metadata that disagrees is refused before anything is built', () => {
  // a committed version bump with no CHANGELOG section and no matching user agent or tracer scope
  const pkgPath = join(repo.dir, 'package.json');
  writeFileSync(pkgPath, readFileSync(pkgPath, 'utf8').replace(`"version": "${VERSION}"`, '"version": "9.9.9"'));
  git('commit', '-q', '-am', 'bump package.json only');
  try {
    const run = prepare(outDir('mismatch'));
    assert.equal(run.status, 1);
    assert.match(run.stderr, /refused: .*package-lock\.json says/u);
    assert.match(run.stderr, /src\/transport\.ts UA is ply\/[^,]+, package\.json says 9\.9\.9/u);
    assert.match(run.stderr, /src\/otel\.ts tracer scope version/u);
    assert.match(run.stderr, /CHANGELOG\.md has no "## 9\.9\.9" section/u);
    assert.equal(existsSync(outDir('mismatch')), false);
  } finally { git('reset', '-q', '--hard', 'HEAD~1'); }

  // entries left under Unreleased belong to the version being prepared
  const changelog = join(repo.dir, 'CHANGELOG.md');
  writeFileSync(changelog, readFileSync(changelog, 'utf8').replace('## Unreleased\n', '## Unreleased\n\n- a change not yet filed under a version (#0)\n'));
  git('commit', '-q', '-am', 'an Unreleased entry');
  try {
    const run = prepare(outDir('unreleased'));
    assert.equal(run.status, 1);
    assert.match(run.stderr, /"## Unreleased" lists entries/u);
  } finally { git('reset', '-q', '--hard', 'HEAD~1'); }
}, 60_000);

test('the script never publishes, tags or pushes', () => {
  // every command it runs is in a string literal; none of these is one
  const source = readFileSync(join(ROOT, 'scripts/release-prepare.mjs'), 'utf8');
  assert.doesNotMatch(source, /['"`](?:publish|push|tag|deploy)['"`]/u);
  assert.doesNotMatch(source, /npm publish|git (?:push|tag)/u);
});
