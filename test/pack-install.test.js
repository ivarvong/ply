// What a consumer gets from the packed tarball with lifecycle scripts off, and what README.md says about it.
// The judges are npm and Node, not ply: `npm install --ignore-scripts <tarball>` into an empty project must leave
// exactly one package, Node must import the root and all 18 subpaths (19, counted by hand from package.json
// "exports"), and `require('ply')` must do what README Install states for the running Node. The expected require()
// outcomes were measured with Node binaries on the development machine (the REQUIRE_MEASURED table below). The
// boundary on the 20 line is 20.19.0 (Node's CHANGELOG_V20.md, 20.19.0: "require(esm) is now enabled by default";
// measured: 20.18.3 throws, 20.19.0 works); the 22.12 boundary is Node's own (require of ES modules is unflagged from
// 22.12.0) and is not measured here. CI job `pack` runs scripts/pack-check.mjs under the newest Node 20, 22 and 24.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pack, installTarball, importAll, requireRoot, requireExpected, nodeVersion, examplesSetupCommand } from '../scripts/pack-check.mjs';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const INSTALL = README.slice(README.indexOf('## Install'), README.indexOf('## Beta'));
let out;
let consumer;
before(() => {
  out = mkdtempSync(join(tmpdir(), 'ply-pack-test-'));
  consumer = installTarball(pack(out));
}, 300_000);
after(() => {
  if (consumer) consumer.cleanup();
  if (out) rmSync(out, { recursive: true, force: true });
});

test('the tarball installs with --ignore-scripts as one package and every subpath imports', () => {
  assert.deepEqual(consumer.packages, ['ply']);
  const imported = importAll(consumer.dir);
  assert.equal(Object.keys(imported).length, 19);
  for (const [name, count] of Object.entries(imported)) assert.ok(count > 0, `${name} exports nothing`);
});

test('README Install states ESM-only and the require() behaviour this Node shows', () => {
  const { major, minor } = nodeVersion();
  const expected = major > 22 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19) ? 'ok' : 'ERR_REQUIRE_ESM';
  assert.equal(requireRoot(consumer.dir), expected);
  assert.match(INSTALL, /ESM[- ]only/);
  assert.match(INSTALL, /ERR_REQUIRE_ESM/);
  assert.match(INSTALL, /20\.19\.0/);
  assert.match(INSTALL, /22\.12/);
  assert.match(INSTALL, /await import\('ply'\)/);
  assert.equal(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines.node, '>=20');
});

// `require('ply')` from a CommonJS file in an empty project with the tarball installed, run under each Node binary on
// the development machine (2026-11-11; 20.18.3, 20.19.0 and 20.20.2 are the official nodejs.org darwin-arm64 builds,
// checksums verified). The two 22.x rows are Node's documented boundary (22.12.0), not measured.
const REQUIRE_MEASURED = [
  ['20.17.0', 'ERR_REQUIRE_ESM'], ['20.18.0', 'ERR_REQUIRE_ESM'], ['20.18.3', 'ERR_REQUIRE_ESM'],
  ['20.19.0', 'ok'], ['20.20.2', 'ok'],
  ['22.11.0', 'ERR_REQUIRE_ESM'], ['22.12.0', 'ok'],
  ['22.15.0', 'ok'], ['24.2.0', 'ok'], ['24.16.0', 'ok'], ['24.18.0', 'ok'], ['25.2.1', 'ok'],
];

test('the require() outcome pack-check expects is the measured one on every Node version in the table', () => {
  for (const [version, outcome] of REQUIRE_MEASURED) {
    const [major, minor] = version.split('.').map(Number);
    assert.equal(requireExpected({ major, minor }), outcome, `node ${version}`);
  }
});

test('examples/README.md documents one setup command before the example commands', () => {
  // the examples import `ply` by name, which resolves to dist/; `npm install` runs `prepare`, which builds it.
  // scripts/pack-check.mjs (CI job `pack`) runs this command in a fresh export and then starts each example.
  assert.equal(examplesSetupCommand(readFileSync(new URL('../examples/README.md', import.meta.url), 'utf8')), 'npm install');
});

test('README Install states what npm, pnpm, yarn and bun each do with the git dependency, by measured version', () => {
  // The judges are the package managers, not ply: `<pm> add github:ivarvong/ply#77048fb` into an empty project, with
  // and without --ignore-scripts, then `import('ply')` (npm against a local clone of the same commit). Measured once:
  // npm 11.16.0 and pnpm 8.15.9 run `prepare` and leave dist/ (158 files); yarn 1.22.22 and bun 1.2.18 exit 0 without
  // running it and leave no dist/. That run needs the network and four package managers, so it is not repeated here;
  // this test holds README to naming each one with the version it was measured on and the outcome that version showed.
  const rows = Object.fromEntries(INSTALL.split('\n').filter(line => line.startsWith('| ')).map(line => [String(line.split('|')[1]).trim(), line]));
  assert.match(rows['npm 11.16.0'] ?? '', /^\| npm 11\.16\.0 \| builds `dist\/`/);
  assert.match(rows['pnpm 8.15.9'] ?? '', /^\| pnpm 8\.15\.9 \| builds `dist\/`/);
  assert.match(rows['yarn 1.22.22'] ?? '', /^\| yarn 1\.22\.22 \| exits 0[^|]*no `dist\/`/);
  assert.match(rows['bun 1.2.18'] ?? '', /^\| bun 1\.2\.18 \| exits 0[^|]*no `dist\/`/);
});
