// The pack check: what a consumer who installs the packed tarball gets, with lifecycle scripts off.
// `npm run check:pack` (CI job `pack`, once per supported Node major); test/pack-install.test.js runs the tarball
// part in the suite.
//
//   1. a fresh export of the tracked files (no dist/, no node_modules) is packed with `npm pack` (its `prepare`
//      builds dist/ with the checkout's installed typescript);
//   2. the tarball is installed with `npm install --ignore-scripts` into an empty project: exactly one package, `ply`;
//   3. the root and every subpath in package.json "exports" are imported under the running Node;
//   4. `require('ply')` is run under the running Node and compared with what README.md Install states for that major;
//   5. (CLI only) the setup command examples/README.md documents is run in a second fresh export, then each example
//      is started without arguments: it must reach its own usage line (exit 2), not ERR_MODULE_NOT_FOUND.
// `--out <dir>` keeps the tarball there (CI uploads it as a workflow artifact); `--tarball <file>` runs steps 2 to 4
// on an existing tarball (CI: the same tarball under Node 20 and 24, where the dev tools are not installed).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
// 'ply', 'ply/edit', …: the names a consumer writes, from package.json exports
export const SUBPATHS = Object.keys(pkg.exports).map(key => `ply${key.slice(1)}`);
export const EXAMPLES = ['push-tree', 'checkout-tree', 'push-repo'];

function sh(command, args, options) {
  const run = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  return { status: run.status, out: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

// The tracked files of the working tree, copied to a new directory: what `git clone` gives, with this checkout's edits.
export function freshExport() {
  const dir = mkdtempSync(join(tmpdir(), 'ply-export-'));
  const listed = sh('git', ['ls-files', '-z'], { cwd: REPO });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.out}`);
  for (const file of listed.out.split('\0')) {
    if (file === '' || !existsSync(join(REPO, file))) continue;
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    copyFileSync(join(REPO, file), join(dir, file));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// npm pack in a fresh export. The build tools are the checkout's installed devDependencies (a symlink); nothing is
// written into the checkout. Returns the tarball path inside `out`.
export function pack(out) {
  const source = freshExport();
  try {
    symlinkSync(join(REPO, 'node_modules'), join(source.dir, 'node_modules'));
    const run = sh('npm', ['pack', '--json', '--pack-destination', out], { cwd: source.dir });
    if (run.status !== 0) throw new Error(`npm pack failed:\n${run.out}`);
    const tarball = readdirSync(out).filter(name => name.endsWith('.tgz'));
    if (tarball.length !== 1) throw new Error(`expected one tarball in ${out}, found ${tarball.join(', ')}`);
    return join(out, String(tarball[0]));
  } finally { source.cleanup(); }
}

// An empty project with the tarball installed, lifecycle scripts off, registry untouched (ply has no dependencies).
export function installTarball(tarball) {
  const dir = mkdtempSync(join(tmpdir(), 'ply-pack-consumer-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true }));
  const run = sh('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', tarball], { cwd: dir });
  if (run.status !== 0) throw new Error(`npm install failed:\n${run.out}`);
  const packages = readdirSync(join(dir, 'node_modules')).filter(name => !name.startsWith('.'));
  return { dir, packages, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Import every subpath from inside the consumer under `node`. Returns { name: export count } or throws with Node's error.
export function importAll(consumerDir, node = process.execPath) {
  const code = `const out = {}; for (const name of ${JSON.stringify(SUBPATHS)}) out[name] = Object.keys(await import(name)).length; console.log(JSON.stringify(out));`;
  const run = sh(node, ['--input-type=module', '-e', code], { cwd: consumerDir });
  if (run.status !== 0) throw new Error(`import failed under ${node}:\n${run.out}`);
  return JSON.parse(run.out);
}

// What `require('ply')` does from a CommonJS file under `node`: 'ok' or the error code Node throws.
export function requireRoot(consumerDir, node = process.execPath) {
  writeFileSync(join(consumerDir, 'req.cjs'), `try { require('ply'); console.log('ok'); } catch (error) { console.log(error.code); }\n`);
  const run = sh(node, ['req.cjs'], { cwd: consumerDir, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  return run.out.trim();
}

export function nodeVersion(node = process.execPath) {
  const [major, minor] = sh(node, ['-p', 'process.versions.node']).out.trim().split('.').map(Number);
  return { major: major ?? 0, minor: minor ?? 0 };
}

// The first command of the first ```sh block of examples/README.md: the one documented setup step.
export function examplesSetupCommand(readme) {
  const block = /```sh\n([^\n]*)\n/.exec(readme);
  return block ? String(block[1]).split('#')[0].trim() : '';
}

// Run the documented setup in a fresh export, then start each example without arguments.
export function examplesFromExport() {
  const source = freshExport();
  try {
    const command = examplesSetupCommand(readFileSync(join(source.dir, 'examples', 'README.md'), 'utf8'));
    if (!command.startsWith('npm ')) return { command, setup: 'examples/README.md documents no setup command before the example commands', runs: [] };
    const setup = sh('sh', ['-c', command], { cwd: source.dir, env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_prefer_offline: 'true' } });
    const runs = EXAMPLES.map(name => {
      const run = sh(process.execPath, [join('examples', `${name}.mjs`)], { cwd: source.dir });
      return { name, status: run.status, first: run.out.split('\n').find(line => line.trim() !== '') ?? '' };
    });
    return { command, setup: setup.status === 0 ? 'ok' : `exit ${setup.status}:\n${setup.out.slice(-2000)}`, runs };
  } finally { source.cleanup(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outFlag = process.argv.indexOf('--out');
  const out = outFlag > 0 ? resolve(String(process.argv[outFlag + 1])) : mkdtempSync(join(tmpdir(), 'ply-pack-'));
  mkdirSync(out, { recursive: true });
  let failed = false;
  const check = (ok, line) => { console.log(`pack-check ${ok ? 'ok  ' : 'FAIL'} ${line}`); if (!ok) failed = true; };
  // --tarball <file>: check an already packed tarball under the running Node (steps 2 to 4 only)
  const given = process.argv.indexOf('--tarball');
  const tarball = given > 0 ? resolve(String(process.argv[given + 1])) : pack(out);
  const consumer = installTarball(tarball);
  try {
    check(consumer.packages.length === 1 && consumer.packages[0] === 'ply', `install --ignore-scripts: packages [${consumer.packages.join(', ')}]`);
    const imported = importAll(consumer.dir);
    check(Object.keys(imported).length === SUBPATHS.length, `node ${process.versions.node}: imported ${Object.keys(imported).length} of ${SUBPATHS.length} subpaths`);
    const { major, minor } = nodeVersion();
    const required = requireRoot(consumer.dir);
    // README Install: require() throws ERR_REQUIRE_ESM before Node 22.12, works from 22.12 on
    const expected = major > 22 || (major === 22 && minor >= 12) ? 'ok' : 'ERR_REQUIRE_ESM';
    check(required === expected, `node ${process.versions.node}: require('ply') -> ${required} (README states ${expected})`);
  } finally { consumer.cleanup(); }
  if (given < 0) {
    const examples = examplesFromExport();
    check(examples.setup === 'ok', `examples setup \`${examples.command}\` in a fresh export: ${examples.setup}`);
    for (const run of examples.runs) check(run.status === 2 && run.first.startsWith('usage: '), `examples/${run.name}.mjs without arguments: exit ${run.status}, ${run.first}`);
  }
  console.log(`pack-check tarball ${tarball}`);
  process.exit(failed ? 1 : 0);
}
