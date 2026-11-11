// The built declarations compile for the consumers ply names as supported, with skipLibCheck false: a Node service
// (lib ES2022 + @types/node, no DOM lib) on each supported @types/node major, a browser bundle (lib DOM) and a Worker
// (@cloudflare/workers-types). tsc is the judge and the expected value is its own: zero `error TS` lines over a file
// that imports every subpath export in package.json and a file that uses the signer and pack-cache types with the
// consumer's own platform key. Before the first fix the Node consumer got 5 errors inside node_modules/ply
// (TextEncoder, TextDecoder, Cache, CryptoKey, CryptoKeyPair: DOM-lib type names @types/node declares only as values or
// not at all); after it, @types/node 20 and 22 still failed on sign.d.ts (they declare no global `CryptoKey` value;
// 24 does), which a gate holding only the repo's own @types/node 24 could not see.
// scripts/dist-check.mjs holds the build and the configs (npm run check:dist runs the same thing in CI).
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

// Written by hand, not read from the script: the consumers README names. @types/node 20 is the engines floor
// (package.json "engines": node >=20), 22 is the Node CI runs, 24 is the repo's own @types/node. The major is checked
// against the version of the package the compile really ran against, so an alias pointing at the wrong major, or a
// variant dropped from the script, fails here.
const EXPECTED = [
  { name: 'node20', types: '@types/node', major: 20, subpaths: 19 },
  { name: 'node22', types: '@types/node', major: 22, subpaths: 19 },
  { name: 'node24', types: '@types/node', major: 24, subpaths: 19 },
  { name: 'dom', types: '', major: 0, subpaths: 16 },
  { name: 'workers', types: '@cloudflare/workers-types', major: 5, subpaths: 16 },
];

test('the variants are Node on @types/node 20, 22 and 24, DOM and Workers', () => {
  assert.deepEqual(VARIANTS.map(variant => variant.name), EXPECTED.map(expected => expected.name));
});

for (const expected of EXPECTED) {
  test(`dist d.ts compiles for a ${expected.name} consumer, skipLibCheck false, and no variant is skipped`, () => {
    const variant = VARIANTS.find(candidate => candidate.name === expected.name);
    assert.ok(variant, `no ${expected.name} variant in scripts/dist-check.mjs`);
    assert.equal(variant.subpaths.length, expected.subpaths);
    const { errors, provided } = compileVariant(consumer, variant);
    assert.deepEqual(errors, []);
    // what the compile ran against: exactly the one type package, at the expected major
    const majors = Object.fromEntries(Object.entries(provided).map(([name, version]) => [name, Number(version.split('.')[0])]));
    assert.deepEqual(majors, expected.types === '' ? {} : { [expected.types]: expected.major });
  }, 300_000);
}

test('a variant whose type package is not installed is an error, never a skip', () => {
  const { errors } = compileVariant(consumer, { name: 'absent', lib: ['es2022'], types: ['node'], provides: { '@types/node': 'types-node-not-installed' }, subpaths: SUBPATHS, use: '' });
  assert.deepEqual(errors, ['absent: node_modules/types-node-not-installed is not installed (run npm ci); this variant is never skipped']);
});
