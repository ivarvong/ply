// Helpers this library shares between its own modules are not part of the package: a consumer can import only what
// package.json "exports" maps, so a helper is reachable exactly when one of those entry modules exports it.
//
// The entry list is read from package.json (the thing Node resolves `ply/<subpath>` with), not from the code. Each
// dist/<name>.js entry is built from src/<name>.ts, which is what is imported here. The names below are the helpers
// the owner ruled internal: editFileExpecting (commitChanges's compare-and-swap seam into the streamed edit) and
// typeNameOf (the pack writer's type-name table).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const INTERNAL = ['editFileExpecting', 'typeNameOf'];
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const entries = Object.entries(pkg.exports).map(([subpath, target]) => [subpath, target.default.replace(/^\.\/dist\/(.*)\.js$/u, '../src/$1.ts')]);

test('package.json maps the root and ply/edit, the entries these helpers were reachable from', () => {
  const subpaths = entries.map(([subpath]) => subpath);
  assert.ok(subpaths.includes('.') && subpaths.includes('./edit'), subpaths.join(' '));
  for (const [, source] of entries) assert.match(source, /^\.\.\/src\/[a-z-]+\.ts$/u);
});

test('no package entry exports an internal helper', async () => {
  const reachable = [];
  for (const [subpath, source] of entries) {
    const mod = await import(source);
    for (const name of INTERNAL) if (name in mod) reachable.push(`${subpath}: ${name}`);
  }
  assert.deepEqual(reachable, []);
});
