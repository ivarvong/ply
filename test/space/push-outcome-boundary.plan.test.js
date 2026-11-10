// The boundary space's slices (push-outcome-boundary.js) are exactly the slice files on disk, and together they cover
// every definite base exactly once: a slice file that is missing, extra, or renamed fails here, not by silently
// shrinking the space (#263).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SLICES, bases, sliceOf, mutants, mutantCount } from './push-outcome-boundary.js';

test('push outcome boundaries: the slice files are 0..SLICES-1 and the slices partition every base', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const files = readdirSync(dir).filter(f => /^push-outcome-boundary\.\d+\.test\.js$/.test(f)).sort();
  assert.deepEqual(files, Array.from({ length: SLICES }, (_, s) => `push-outcome-boundary.${s}.test.js`).sort());
  const n = bases().length;
  const seen = Array.from({ length: n }, () => 0);
  for (let s = 0; s < SLICES; s++) for (const j of sliceOf(n, s, SLICES)) seen[j]++;
  assert.ok(seen.every(c => c === 1), 'every base in exactly one slice');
});

test('push outcome boundaries: mutantCount is what mutants() yields', () => {
  for (const n of [0, 1, 2, 39, 154]) assert.equal([...mutants(new Uint8Array(n).fill(0x61))].length, mutantCount(n));
});
