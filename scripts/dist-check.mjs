// The dist check: what a consumer of the built package gets. `npm run check:dist` (CI: "dist is what consumers
// import"); test/dist-types.test.js runs the same compiles in the suite.
//
// Types: dist is built into a scratch consumer project (never the checkout's dist/) and a file importing every
// subpath export is compiled by tsc with skipLibCheck false, three ways:
//   node    — lib ES2022 + @types/node, all subpaths (a Node service: no DOM or WebWorker lib)
//   dom     — lib ES2022 + DOM, no @types, every subpath but the *-node ones (a browser bundle)
//   workers — lib ES2022 + @cloudflare/workers-types, every subpath but the *-node ones (a Worker)
// tsc is the judge: the declarations may name only types all three environments declare. workers-types is not a
// devDependency; the variant runs when the package is in node_modules or PLY_WORKERS_TYPES names its directory, and
// is reported as skipped otherwise.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSC = join(REPO, 'node_modules', '.bin', 'tsc');
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
// 'ply', 'ply/edit', …: the names a consumer writes, from package.json exports
export const SUBPATHS = Object.keys(pkg.exports).map(key => `ply${key.slice(1)}`);
const NODE_ONLY = name => name.endsWith('-node');

function workersTypesDir() {
  const given = process.env.PLY_WORKERS_TYPES;
  if (given) return resolve(given);
  const local = join(REPO, 'node_modules', '@cloudflare', 'workers-types');
  return existsSync(local) ? local : '';
}

export const VARIANTS = [
  { name: 'node', lib: ['es2022'], types: ['node'], subpaths: SUBPATHS },
  { name: 'dom', lib: ['es2022', 'dom'], types: [], subpaths: SUBPATHS.filter(name => !NODE_ONLY(name)) },
  { name: 'workers', lib: ['es2022'], types: ['@cloudflare/workers-types'], subpaths: SUBPATHS.filter(name => !NODE_ONLY(name)) },
];

// A consumer project with ply installed as the tarball lays it out: node_modules/ply/{package.json,dist}.
export function buildConsumer() {
  const dir = mkdtempSync(join(tmpdir(), 'ply-dist-check-'));
  const ply = join(dir, 'node_modules', 'ply');
  mkdirSync(ply, { recursive: true });
  copyFileSync(join(REPO, 'package.json'), join(ply, 'package.json'));
  const built = spawnSync(TSC, ['-p', join(REPO, 'tsconfig.json'), '--outDir', join(ply, 'dist')], { cwd: REPO, encoding: 'utf8' });
  if (built.status !== 0) throw new Error(`build failed:\n${built.stdout}${built.stderr}`);
  mkdirSync(join(dir, 'node_modules', '@types'));
  symlinkSync(join(REPO, 'node_modules', '@types', 'node'), join(dir, 'node_modules', '@types', 'node'));
  const workers = workersTypesDir();
  if (workers) {
    mkdirSync(join(dir, 'node_modules', '@cloudflare'));
    symlinkSync(workers, join(dir, 'node_modules', '@cloudflare', 'workers-types'));
  }
  return { dir, workers: workers !== '', cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Compile one variant. Returns { skipped, errors }: errors are tsc's `error TS` lines, empty when it compiles.
export function compileVariant(consumer, variant) {
  if (variant.name === 'workers' && !consumer.workers) return { skipped: true, errors: [] };
  const source = variant.subpaths.map((name, index) => `import * as m${index} from '${name}';`).join('\n')
    + `\nexport const all = [${variant.subpaths.map((_, index) => `m${index}`).join(', ')}];\n`;
  writeFileSync(join(consumer.dir, `use-${variant.name}.ts`), source);
  const config = {
    compilerOptions: {
      noEmit: true, strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, skipLibCheck: false,
      target: 'es2022', module: 'nodenext', moduleResolution: 'nodenext', lib: variant.lib, types: variant.types,
    },
    files: [`use-${variant.name}.ts`],
  };
  writeFileSync(join(consumer.dir, `tsconfig.${variant.name}.json`), JSON.stringify(config));
  writeFileSync(join(consumer.dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  const run = spawnSync(TSC, ['-p', `tsconfig.${variant.name}.json`, '--pretty', 'false'], { cwd: consumer.dir, encoding: 'utf8' });
  const errors = `${run.stdout}${run.stderr}`.split('\n').filter(line => line.includes('error TS'));
  if (run.status !== 0 && errors.length === 0) errors.push(`tsc exited ${run.status}: ${run.stdout}${run.stderr}`);
  return { skipped: false, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const consumer = buildConsumer();
  let failed = false;
  try {
    for (const variant of VARIANTS) {
      const { skipped, errors } = compileVariant(consumer, variant);
      console.log(`dist-check types ${variant.name}: ${skipped ? 'SKIPPED (no @cloudflare/workers-types; set PLY_WORKERS_TYPES)' : `${errors.length} errors over ${variant.subpaths.length} subpaths`}`);
      for (const line of errors) console.log(`  ${line}`);
      if (errors.length > 0) failed = true;
    }
  } finally { consumer.cleanup(); }
  process.exit(failed ? 1 : 0);
}
