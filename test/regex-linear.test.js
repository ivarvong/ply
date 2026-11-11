// Every regular expression in src/ that is applied to remote, stored or caller text costs time linear in that text.
//
// The rows are scripts/regex-inventory.mjs (scripts/regex-gate.mjs makes sure every pattern in src/ has one). Each row's
// adversarial(n) is run at n, 2n and 4n characters. V8's regex engine exposes no step counter, so there is no
// step-independent measure to assert on: the assertion is on the ratio of two times measured the same way, never on a
// time. Four times the input costs about 4 times the work when matching is linear, 16 when it is quadratic and 64 when
// it is cubic; the bound sits between the first two (BOUND), each time is the best of several, and a row is measured
// again before it fails (a loaded machine can stretch one sample, not the best of fifteen).
//
// A row marked knownBad is asserted the other way round: its generator must show the superlinear cost, so the marker is
// evidence and not an excuse. When its fix lands the pattern changes, the gate refuses the stale row, and it is rewritten.
import { expect, test } from 'vitest';
import { INVENTORY } from '../scripts/regex-inventory.mjs';

const BOUND = 9; // t(4n) / t(n): linear is about 4 (or less: a fixed-length match is constant), quadratic about 16
const N = 4000;
const ATTEMPTS = 3;
const OPS = { exec: (re, text) => re.exec(text), replace: (re, text) => text.replace(re, ''), split: (re, text) => text.split(re) };

const regexOf = entry => {
  if (entry.build !== undefined) return entry.build();
  const end = entry.pattern.lastIndexOf('/'); // flags never contain a slash
  return new RegExp(entry.pattern.slice(1, end), entry.pattern.slice(end + 1));
};
const ms = () => Number(process.hrtime.bigint()) / 1e6;
const once = (op, re, text, reps) => {
  const t0 = ms();
  for (let r = 0; r < reps; r += 1) { re.lastIndex = 0; op(re, text); }
  return ms() - t0;
};
const best = (op, re, text, reps) => Math.min(...Array.from({ length: 5 }, () => once(op, re, text, reps)));

export function measure(entry, n = N) {
  const re = regexOf(entry);
  const op = OPS[entry.op ?? 'exec'];
  const [a, b, c] = [n, 2 * n, 4 * n].map(size => entry.adversarial(size));
  once(op, re, c, 1); // compile and warm up outside the measurement
  // Repeat the call until the smallest size takes about a millisecond, so the timer and the scheduler are small against it.
  let reps = 1;
  while (reps < 8192 && once(op, re, a, reps) < 1) reps *= 2;
  const t1 = best(op, re, a, reps);
  const t2 = best(op, re, b, reps);
  const t4 = best(op, re, c, reps);
  return { t1, t2, t4, ratio: t4 / t1 };
}

const rows = INVENTORY.filter(entry => entry.input !== 'internal');

test('the inventory has rows to measure, and every one names a known way to apply its pattern', () => {
  expect(rows.length).toBeGreaterThan(50);
  for (const entry of rows) {
    expect(typeof entry.adversarial, `${entry.file}: ${entry.pattern}`).toBe('function');
    expect(Object.keys(OPS), `${entry.file}: ${entry.pattern}`).toContain(entry.op ?? 'exec');
    // The generator grows with n: a generator that ignores n would make every ratio 1.
    expect(entry.adversarial(4 * N).length, `${entry.file}: ${entry.pattern}`).toBeGreaterThanOrEqual(3 * N);
  }
});

for (const entry of rows) {
  const name = `${entry.file}: ${entry.pattern}`;
  if (entry.knownBad === undefined) {
    test(`linear in its ${entry.input} input: ${name}`, () => {
      const seen = [];
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const m = measure(entry);
        seen.push(m);
        if (m.ratio < BOUND) return;
      }
      expect.fail(`4x the input cost ${seen.map(m => `${m.ratio.toFixed(1)}x`).join(', ')} the time over ${ATTEMPTS} attempts (linear is about 4, the bound is ${BOUND}); n, 2n, 4n took ${seen.map(m => `${m.t1.toFixed(3)} / ${m.t2.toFixed(3)} / ${m.t4.toFixed(3)} ms`).join('; ')}`);
    });
  } else {
    test(`known bad (${entry.knownBad}), and its generator shows it: ${name}`, () => {
      const seen = [];
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const m = measure(entry, N / 2);
        seen.push(m);
        if (m.ratio >= BOUND) return;
      }
      expect.fail(`marked knownBad, but 4x the input cost only ${seen.map(m => `${m.ratio.toFixed(1)}x`).join(', ')} the time: the generator does not show the defect, or the pattern was fixed and the marker should go`);
    });
  }
}
