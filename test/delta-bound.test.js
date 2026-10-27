// A delta that asks for a huge result must die before the output buffer exists, and the largest
// expansion the caps allow is the one SAFETY.md I4 records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDelta } from '../src/packresolve.js';
import { encodeVarint } from '../src/pack.js';
import { DEFAULT_LIMITS } from '../src/limits.js';
import { DELTA_COPY, DELTA_COPY_MAX } from '../src/format.js';
import { concat } from '../src/bytes.js';

const MAX = DEFAULT_LIMITS.maxDeltaResult;

test('the densest in-limit delta expands a 64 KiB base to maxDeltaResult and no further', () => {
  assert.equal(MAX % DELTA_COPY_MAX, 0);
  const copies = MAX / DELTA_COPY_MAX;
  const base = new Uint8Array(DELTA_COPY_MAX);
  base[0] = 7;
  const header = concat([encodeVarint(base.length), encodeVarint(MAX)]);
  const ops = new Uint8Array(copies);
  ops.fill(DELTA_COPY);
  const delta = concat([header, ops]);
  assert.equal(header.length, 7);
  assert.equal(delta.length, 1031);
  const { out } = applyDelta(base, delta);
  assert.equal(out.length, MAX);
  assert.equal(out[0], 7);
  assert.equal(out[DELTA_COPY_MAX], 7);
  assert.equal(Math.floor(MAX / delta.length), 65091);
  assert.throws(
    () => applyDelta(base, concat([encodeVarint(base.length), encodeVarint(MAX + 1), Uint8Array.of(DELTA_COPY)])),
    e => e.code === 'limit_exceeded' && e.got === MAX + 1 && e.max === MAX,
  );
});
