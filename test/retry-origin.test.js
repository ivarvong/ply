// #300-5: a corrupt pack is retryable only when the bytes came from a server. The expected values come from the README
// contract (retrying the caller's own bytes cannot succeed), not from errors.ts.
import { describe, expect, it } from 'vitest';
import { parseTree } from '../src/objects.js';
import { isRetryable, plyError, retryPolicy } from '../src/errors.js';

describe('pack_corrupt retry policy follows where the bytes came from', () => {
  it('a pure codec over caller bytes (parseTree of 5 junk bytes) is pack_corrupt and not retryable', () => {
    const r = parseTree(new Uint8Array([1, 2, 3, 4, 5]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('pack_corrupt');
    expect(isRetryable(r.error)).toBe(false);
    expect(retryPolicy(r.error)).toBe('no');
  });
  it('a pack_corrupt carrying origin remote is retryable', () => {
    const e = plyError('pack_corrupt', 'bad zlib', { origin: 'remote' });
    expect(retryPolicy(e)).toBe('yes');
    expect(isRetryable(e)).toBe(true);
  });
  it('a pack_corrupt with no origin is not', () => {
    expect(retryPolicy(plyError('pack_corrupt', 'bad zlib'))).toBe('no');
  });
});
