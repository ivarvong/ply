// Byte equality for tests whose buffers can be large. node:assert's deepEqual renders a diff of both values on failure,
// and that diff is quadratic: two 20,000-element arrays that differ peak at 13 GB resident, two 65,516-byte pkt-line
// payloads went past 23 GB (#85: the mutant at pktline.ts `out.set(p, …)` wrote zero payloads, the comparison failed,
// and the failure message took the CI runner down). This checks the length first, then reports the first differing
// byte and its neighbourhood, so the failure costs O(n) time and O(1) message.
import assert from 'node:assert/strict';

const MAX_SHOWN = 16;
const window = (b, i) => [...b.subarray(Math.max(0, i - MAX_SHOWN / 2), i + MAX_SHOWN / 2)].map(x => x.toString(16).padStart(2, '0')).join(' ');

export function assertBytes(got, want, what = 'bytes') {
  if (!(got instanceof Uint8Array) || !(want instanceof Uint8Array)) assert.fail(`${what}: not byte arrays`);
  if (got.length !== want.length) assert.fail(`${what}: ${got.length} bytes, want ${want.length}`);
  for (let i = 0; i < got.length; i++) {
    if (got[i] !== want[i]) assert.fail(`${what}: first difference at byte ${i} of ${got.length}: got [${window(got, i)}], want [${window(want, i)}]`);
  }
}
