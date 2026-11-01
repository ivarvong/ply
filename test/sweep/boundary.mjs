// Boundary values for one numeric limit. The sweep walks every value, including the ones past the cap,
// so a check that fires late (or not at all) shows up as a cell instead of a gap between examples.
// Powers of two stop at the first power strictly past the limit: that is the doubling step that must fail,
// and the next power is the same failure again.

/** @param {number} limit */
export function boundaryValues(limit) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error(`boundaryValues: limit must be a non-negative safe integer, got ${limit}`);
  /** @type {Set<number>} */
  const values = new Set([0, 1]);
  if (limit > 0) {
    values.add(limit - 1);
    values.add(limit);
    values.add(limit + 1);
  }
  let power = 1;
  while (power <= limit) {
    values.add(power);
    if (power > Number.MAX_SAFE_INTEGER / 2) break;
    power *= 2;
  }
  if (power > limit && power <= Number.MAX_SAFE_INTEGER) values.add(power);
  return [...values].sort((a, b) => a - b);
}
