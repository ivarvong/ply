// The dist step of `npm run check`: the package builds, and the build loads the way a consumer imports it
// (`import('ply')` through package.json's exports map). Run from the package root.
// It builds into a scratch install shape, <tmp>/node_modules/ply/{package.json,dist/}, and never into this tree's
// dist/: a contributor's dist/ may be linked into another project or hold a build under comparison, and a check
// must not rewrite it. `npm run build` is still what writes dist/.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const LOAD = "const m = await import('ply'); if (!m.Tracer || !m.RETRY) { console.error('dist-check: the built ply does not export Tracer and RETRY'); process.exit(1); }";
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ply-dist-')));
let status = 1;
try {
  const pkg = join(tmp, 'node_modules/ply');
  mkdirSync(pkg, { recursive: true });
  copyFileSync('package.json', join(pkg, 'package.json'));
  const build = spawnSync(resolve('node_modules/.bin/tsc'), ['-p', 'tsconfig.json', '--outDir', join(pkg, 'dist')], { stdio: 'inherit' });
  if (build.status !== 0) console.error(`dist-check: the build failed (exit ${build.status})`);
  // NODE_OPTIONS may carry a hook path relative to this tree; the load runs in the scratch directory.
  else status = spawnSync(process.execPath, ['--input-type=module', '-e', LOAD], { cwd: tmp, stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' } }).status ?? 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(status);
