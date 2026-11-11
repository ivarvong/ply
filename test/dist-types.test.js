// The built declarations compile for the consumers ply names as supported, with skipLibCheck false: a Node service
// (lib ES2022 + @types/node, no DOM lib), a browser bundle (lib DOM) and a Worker (@cloudflare/workers-types).
// tsc is the judge and the expected value is its own: zero `error TS` lines over a file that imports every subpath
// export in package.json. Before the fix the Node consumer got 5 errors inside node_modules/ply (TextEncoder,
// TextDecoder, Cache, CryptoKey, CryptoKeyPair: DOM-lib type names @types/node declares only as values or not at all).
// scripts/dist-check.mjs holds the build and the three configs (npm run check:dist runs the same thing in CI).
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { buildConsumer, compileVariant, VARIANTS, SUBPATHS } from '../scripts/dist-check.mjs';

let consumer;
before(() => { consumer = buildConsumer(); }, 300_000);
after(() => { if (consumer) consumer.cleanup(); });

test('package.json exports the root and 18 subpaths, three of them Node only', () => {
  // counted by hand from package.json "exports"; a new subpath must be added here on purpose
  assert.equal(SUBPATHS.length, 19);
  assert.deepEqual(SUBPATHS.filter(name => name.endsWith('-node')), ['ply/tree-node', 'ply/checkout-node', 'ply/repo-node']);
});

for (const variant of VARIANTS) {
  test(`dist d.ts compiles for a ${variant.name} consumer, skipLibCheck false (lib ${variant.lib.join('+')}, types [${variant.types.join(', ')}])`, context => {
    const { skipped, errors } = compileVariant(consumer, variant);
    if (skipped) { context.skip(); return; }
    assert.deepEqual(errors, []);
  }, 300_000);
}
