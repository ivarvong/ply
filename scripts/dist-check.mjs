// The dist check: what a consumer of the built package gets. `npm run check:dist` and the last step of `npm run check`
// (CI: "dist is what consumers import"); test/dist-types.test.js runs the same compiles in the suite.
//
// dist is built into a scratch directory and never into this tree's dist/: a contributor's dist/ may be linked into
// another project or hold a build under comparison, and a check must not rewrite it. `npm run build` is still what
// writes dist/.
//
// Load: the build is installed as <scratch>/load/node_modules/ply and `import('ply')` runs there, through
// package.json's exports map; it must export Tracer and RETRY.
//
// Types: dist is built once (never into the checkout's dist/), copied into one scratch consumer project per variant,
// and a file importing every subpath export plus a file using the signer and pack-cache types with the consumer's own
// platform values is compiled by tsc with skipLibCheck false:
//   node20, node22, node24 — lib ES2022 + @types/node of that major, all subpaths (a Node service: no DOM or WebWorker
//             lib). 20 is the engines floor, 22 is CI's Node, 24 is the repo's own @types/node.
//   dom     — lib ES2022 + DOM, no @types, every subpath but the *-node ones (a browser bundle)
//   workers — lib ES2022 + @cloudflare/workers-types, every subpath but the *-node ones (a Worker)
// tsc is the judge: the declarations may name only types every one of these environments declares. The type packages
// are exact-pinned devDependencies (types-node-20 and types-node-22 are npm aliases of @types/node, named outside
// @types so no tsconfig picks them up by accident). No variant can be skipped: a missing package is an error.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, cpSync, symlinkSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSC = join(REPO, 'node_modules', '.bin', 'tsc');
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
// 'ply', 'ply/edit', …: the names a consumer writes, from package.json exports
export const SUBPATHS = Object.keys(pkg.exports).map(key => `ply${key.slice(1)}`);
const NODE_ONLY = name => name.endsWith('-node');
const WEB = SUBPATHS.filter(name => !NODE_ONLY(name));

// A consumer's own code against the declarations: its platform key goes into SignerKey, a generated key goes back
// into the platform's crypto.subtle.sign and out as the platform's key type, and neither the key nor a cache miss has
// degraded to `any`.
const IS_ANY = 'type IsAny<T> = 0 extends 1 & T ? true : false;\n';
const useTypes = (preamble, keyType) => `${IS_ANY}${preamble}import { ed25519Signer, generateSigner, type SignerKey } from 'ply/sign';
import type { PackCache } from 'ply/packcache';
declare const own: ${keyType};
export const key: SignerKey = { privateKey: own, publicKeyRaw: new Uint8Array(32) };
export const signer = ed25519Signer(key);
export const keyNotAny: IsAny<SignerKey['privateKey']> = false;
export async function roundTrip(): Promise<${keyType}> {
  const generated = await generateSigner();
  await crypto.subtle.sign('Ed25519', generated.keyPair.privateKey, new Uint8Array(1));
  return generated.keyPair.publicKey;
}
export const missNotAny: IsAny<Awaited<ReturnType<PackCache['match']>>> = false;
export async function miss(cache: PackCache): Promise<number> { const hit = await cache.match('k'); return hit === undefined ? 0 : hit.status; }
`;
const NODE_USE = useTypes(`import type { webcrypto } from 'node:crypto';\n`, 'webcrypto.CryptoKey');
const WEB_USE = useTypes('', 'CryptoKey');

// provides: the type package the consumer installs, as { its name in the consumer: its directory in this repo's
// node_modules }.
const nodeVariant = (major, source) => ({ name: `node${major}`, lib: ['es2022'], types: ['node'], provides: { '@types/node': source }, subpaths: SUBPATHS, use: NODE_USE });
export const VARIANTS = [
  nodeVariant(20, 'types-node-20'),
  nodeVariant(22, 'types-node-22'),
  nodeVariant(24, '@types/node'),
  { name: 'dom', lib: ['es2022', 'dom'], types: [], provides: {}, subpaths: WEB, use: WEB_USE },
  { name: 'workers', lib: ['es2022'], types: ['@cloudflare/workers-types'], provides: { '@cloudflare/workers-types': '@cloudflare/workers-types' }, subpaths: WEB, use: WEB_USE },
];

// ply as the tarball lays it out ({package.json,dist}), built once; each variant gets its own copy.
export function buildConsumer() {
  const dir = mkdtempSync(join(tmpdir(), 'ply-dist-check-'));
  const ply = join(dir, 'ply');
  mkdirSync(ply);
  copyFileSync(join(REPO, 'package.json'), join(ply, 'package.json'));
  const built = spawnSync(TSC, ['-p', join(REPO, 'tsconfig.json'), '--outDir', join(ply, 'dist')], { cwd: REPO, encoding: 'utf8' });
  if (built.status !== 0) throw new Error(`build failed:\n${built.stdout}${built.stderr}`);
  return { dir, ply, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const LOAD = "const m = await import('ply'); if (!m.Tracer || !m.RETRY) { console.error('dist-check: the built ply does not export Tracer and RETRY'); process.exit(1); }";

// Import the build the way a consumer does. Returns the exit status (0 when both exports are there).
export function loadConsumer(consumer) {
  const dir = join(consumer.dir, 'load');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  cpSync(consumer.ply, join(dir, 'node_modules', 'ply'), { recursive: true });
  // NODE_OPTIONS may carry a hook path relative to this tree; the load runs in the scratch directory.
  return spawnSync(process.execPath, ['--input-type=module', '-e', LOAD], { cwd: dir, stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' } }).status ?? 1;
}

// Compile one variant in its own consumer project: node_modules/ply plus the variant's type package and nothing else.
// Returns { errors, provided }: errors are tsc's `error TS` lines (empty when it compiles), or the one line naming a
// type package that is not installed; provided maps each type package to the version the compile ran against.
export function compileVariant(consumer, variant) {
  const dir = join(consumer.dir, variant.name);
  const modules = join(dir, 'node_modules');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(modules, { recursive: true });
  cpSync(consumer.ply, join(modules, 'ply'), { recursive: true });
  const provided = {};
  for (const [name, source] of Object.entries(variant.provides)) {
    const from = join(REPO, 'node_modules', source);
    if (!existsSync(join(from, 'package.json'))) return { errors: [`${variant.name}: node_modules/${source} is not installed (run npm ci); this variant is never skipped`], provided };
    provided[name] = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8')).version;
    mkdirSync(dirname(join(modules, name)), { recursive: true });
    symlinkSync(from, join(modules, name));
  }
  const all = variant.subpaths.map((name, index) => `import * as m${index} from '${name}';`).join('\n')
    + `\nexport const all = [${variant.subpaths.map((_, index) => `m${index}`).join(', ')}];\n`;
  writeFileSync(join(dir, 'all.ts'), all);
  writeFileSync(join(dir, 'use.ts'), variant.use);
  const config = {
    compilerOptions: {
      noEmit: true, strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, skipLibCheck: false,
      target: 'es2022', module: 'nodenext', moduleResolution: 'nodenext', lib: variant.lib, types: variant.types,
    },
    files: ['all.ts', 'use.ts'],
  };
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(config));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  const run = spawnSync(TSC, ['-p', 'tsconfig.json', '--pretty', 'false'], { cwd: dir, encoding: 'utf8' });
  const errors = `${run.stdout}${run.stderr}`.split('\n').filter(line => line.includes('error TS'));
  if (run.status !== 0 && errors.length === 0) errors.push(`tsc exited ${run.status}: ${run.stdout}${run.stderr}`);
  return { errors, provided };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const consumer = buildConsumer();
  let failed = false;
  try {
    const loaded = loadConsumer(consumer);
    console.log(`dist-check load: ${loaded === 0 ? 'ok' : `failed (exit ${loaded})`}`);
    if (loaded !== 0) failed = true;
    for (const variant of VARIANTS) {
      const { errors, provided } = compileVariant(consumer, variant);
      const against = Object.entries(provided).map(([name, version]) => ` (${name} ${version})`).join('');
      console.log(`dist-check types ${variant.name}${against}: ${errors.length} errors over ${variant.subpaths.length} subpaths`);
      for (const line of errors) console.log(`  ${line}`);
      if (errors.length > 0) failed = true;
    }
  } finally { consumer.cleanup(); }
  process.exit(failed ? 1 : 0);
}
