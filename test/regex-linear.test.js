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
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { gate, shapeProblems } from '../scripts/regex-gate.mjs';
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

// ---- the gate itself ------------------------------------------------------------------------------------------------
// The second line (shape rules). The refused list is not derived from the rules: the first seven are the patterns an
// independent reviewer timed at 16 times the input length (linear is about 16): /\/+$/ 477x, /\n+$/u 228x,
// /[#;].*$/u 438x, /filter .* not (supported|allowed)/ 408x, /(a|a)*$/ 401x, /(a|ab)*c/ 329x, and /(a+)+$/, the
// textbook exponential one. The eighth is quadratic by hand: on 'x' + n digits + 'z', (\d+) takes all n digits, y
// fails, and for each of the n lengths (\d+) can give back, (\d*) tries every length of the rest: n(n+1)/2 steps.
const REFUSED = [
  [String.raw`\/+$`, ''], [String.raw`\n+$`, 'u'], [String.raw`[#;].*$`, 'u'], ['filter .* not (supported|allowed)', ''],
  ['(a|a)*$', ''], ['(a|ab)*c', ''], ['(a+)+$', ''], [String.raw`x(\d+)(\d*)y`, ''],
];
// Linear by construction: one anchored start and one class run; a fixed count; no run at all; three runs whose
// classes are pairwise disjoint (name, space, quoted text), so no character can be matched by two of them.
const CLEAN = [['^[a-z]+$', ''], ['^[0-9a-f]{40}$', ''], [String.raw`\n$`, ''], [String.raw`^\[([^\]\s"]+)(\s+"([^"]*)")?\]$`, 'u']];

test('the shape rules refuse the patterns measured superlinear and pass the linear controls', () => {
  for (const [source, flags] of REFUSED) expect(shapeProblems(source, flags).length, `/${source}/${flags}`).toBeGreaterThan(0);
  for (const [source, flags] of CLEAN) expect(shapeProblems(source, flags), `/${source}/${flags}`).toEqual([]);
});

test('the gate fails on a pattern with no row, a row with no pattern, and a known-bad marker left behind', () => {
  const found = [{ file: 'src/x.ts', line: 7, pattern: '/^[a-z]+$/u', kind: 'literal' }];
  const entry = { file: 'src/x.ts', pattern: '/^[a-z]+$/u', input: 'caller', linear: 'anchored at ^, one class run', adversarial: n => 'a'.repeat(n) };
  expect(gate(found, [entry])).toEqual([]);
  expect(gate(found, [])).toEqual(['src/x.ts:7: /^[a-z]+$/u: not in scripts/regex-inventory.mjs']);
  expect(gate([], [entry])).toHaveLength(1);
  expect(gate([], [entry])[0]).toContain('matches no pattern in the source');
  expect(gate([], [{ ...entry, knownBad: 'fix/some-branch' }])[0]).toContain('its fix landed (fix/some-branch)');
  // A row cannot claim remote text without a generator, and a refused shape is refused whatever the row says.
  expect(gate(found, [{ ...entry, adversarial: undefined }])[0]).toContain('needs an adversarial(n) generator');
  const slash = { file: 'src/x.ts', line: 9, pattern: String.raw`/\/+$/`, kind: 'literal' };
  expect(gate([slash], [{ ...entry, pattern: slash.pattern }])[0]).toContain('unanchored run');
});

// The gate's discovery. A pattern the gate does not find gets no row, no generator, no ratio test and no shape check,
// so every way src/ can build a RegExp other than a literal, RegExp(...) or new RegExp(...) is refused. Each form is
// planted alone in a scratch copy of this tree's src/ and the gate is run on it the way npm run lint runs it: a child
// process, judged by its exit code (0 clean, 1 on any problem) and by a message naming the planted file and line. The
// lines are counted by hand from the planted text below; every pattern is the textbook exponential (x+)+$.
const PLANT = 'src/zz-planted.ts';
const PLANTED = [
  // (a) a construction whose callee is not the bare identifier RegExp
  ['new globalThis.RegExp(...)', "export const r = new globalThis.RegExp('(c+)+$', 'u');\n", 1],
  ['globalThis.RegExp(...)', "export const r = globalThis.RegExp('(c+)+$', 'u');\n", 1],
  ['new (RegExp)(...)', "export const r = new (RegExp)('(i+)+$', 'u');\n", 1],
  ["new globalThis['RegExp'](...)", "export const r = new globalThis['RegExp']('(j+)+$', 'u');\n", 1],
  // (b) RegExp as a value that is not the callee of a construction
  ['an alias of RegExp', "const R = RegExp;\nexport const r = new R('(d+)+$', 'u');\n", 1],
  ['Reflect.construct(RegExp, ...)', "export const r: RegExp = Reflect.construct(RegExp, ['(g+)+$', 'u']);\n", 1],
  ['class extends RegExp', "export class R extends RegExp {}\nexport const r = new R('(h+)+$', 'u');\n", 1],
  // (c) String#match, matchAll and search compile an argument that is not a RegExp
  ['match of a string', "export const f = (s: string): RegExpMatchArray | null =>\n  s.match('(e+)+$');\n", 2],
  ['matchAll of a string', "export const f = (s: string): unknown => s.matchAll('(e+)+$');\n", 1],
  ['search of a string', "export const f = (s: string): number => s.search('(f+)+$');\n", 1],
  ['match of a variable', "const p = '(k+)+$';\n\nexport const f = (s: string): unknown => s.match(p);\n", 3],
  // the Cache API allowance is src/packcache.ts and the receiver `cache`: the same text in another file is refused
  ['cache.match(key) outside src/packcache.ts', "export const f = (cache: string, key: string): unknown => cache.match(key);\n", 1],
];

test('the gate exits 1 on every way to build a RegExp it cannot inventory, naming the file and line', { timeout: 240_000 }, () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ply-regex-gate-')));
  const run = () => spawnSync(process.execPath, [join(repo, 'scripts/regex-gate.mjs'), '--root', root], { cwd: repo, encoding: 'utf8' });
  try {
    cpSync(join(repo, 'src'), join(root, 'src'), { recursive: true });
    for (const name of ['tsconfig.json', 'tsconfig.check.json']) cpSync(join(repo, name), join(root, name));
    const clean = run();
    expect(clean.status, `unplanted tree: ${clean.stderr}`).toBe(0);
    for (const [name, text, line] of PLANTED) {
      writeFileSync(join(root, PLANT), text);
      const planted = run();
      expect(planted.status, `${name}: ${planted.stdout}${planted.stderr}`).toBe(1);
      expect(planted.stderr, name).toContain(`regex-gate: ${PLANT}:${line}: `);
      rmSync(join(root, PLANT));
    }
    // The allowance is not the file alone: another receiver in src/packcache.ts is refused, at the line appended.
    const cacheFile = join(root, 'src/packcache.ts');
    const before = readFileSync(cacheFile, 'utf8');
    const appendedLine = before.split('\n').length; // the file ends with a newline: the appended text is the next line
    appendFileSync(cacheFile, "export const zz = (s: string): unknown => s.match('(a+)+$');\n");
    const other = run();
    expect(other.status, other.stdout + other.stderr).toBe(1);
    expect(other.stderr).toContain(`regex-gate: src/packcache.ts:${appendedLine}: `);
    writeFileSync(cacheFile, before);
    // Control: a regex literal argument is not refused as a string pattern. It is found as a literal, and the only
    // problem is the missing row.
    writeFileSync(join(root, PLANT), 'export const f = (s: string): unknown => s.match(/^zz$/u);\n');
    const literal = run();
    expect(literal.status).toBe(1);
    expect(literal.stderr.split('\n').filter(l => l.includes(PLANT))).toEqual([`regex-gate: ${PLANT}:1: /^zz$/u: not in scripts/regex-inventory.mjs`]);
    rmSync(join(root, PLANT));
    const again = run();
    expect(again.status, `tree restored: ${again.stderr}`).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
