// Absence ratchet. Outside src/absent.ts, counts of the platform missing value, optional members and
// parameters (`?:`), optional chaining (`?.`), and nullish coalescing (`??`) must match
// scripts/absence-baseline.json exactly. A rise fails. A drop fails until this change lowers the baseline,
// so the count only moves down on purpose.
//
//   node scripts/absence-ratchet.mjs           compare, exit 1 on any difference
//   node scripts/absence-ratchet.mjs --write   rewrite the baseline when the count fell (a rise is refused)
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BOUNDARY = 'src/absent.ts';
const BASELINE_PATH = 'scripts/absence-baseline.json';
const KEYS = ['undefined', 'optional', 'chain', 'coalesce'];

const tally = text => ({
  undefined: (text.match(/\bundefined\b/g) ?? []).length,
  optional: (text.match(/\?:/g) ?? []).length,
  chain: (text.match(/\?\./g) ?? []).length,
  coalesce: (text.match(/\?\?/g) ?? []).length,
});

const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name).split('\\').join('/');
  if (entry.isDirectory()) return walk(path);
  return /\.(?:ts|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
});

export function countTree() {
  const totals = { boundary: BOUNDARY, undefined: 0, optional: 0, chain: 0, coalesce: 0 };
  const files = [];
  for (const file of walk('src')) {
    if (file === BOUNDARY) continue;
    const counts = tally(readFileSync(file, 'utf8'));
    const n = KEYS.reduce((sum, key) => sum + counts[key], 0);
    if (n) files.push({ file, ...counts, n });
    for (const key of KEYS) totals[key] += counts[key];
  }
  files.sort((a, b) => b.n - a.n || a.file.localeCompare(b.file));
  return { totals, files };
}

export function compareCounts(actual, baseline) {
  const problems = [];
  if (actual.boundary !== baseline.boundary) problems.push(`boundary is ${actual.boundary}, baseline says ${baseline.boundary}`);
  for (const key of KEYS) {
    const got = actual[key];
    const want = baseline[key];
    if (typeof want !== 'number') problems.push(`${key} is ${got}, baseline has no number`);
    else if (got > want) problems.push(`${key} rose ${want} -> ${got}; absence outside ${actual.boundary} may only fall`);
    else if (got < want) problems.push(`${key} fell ${want} -> ${got}; lower ${BASELINE_PATH} in this change`);
  }
  return problems;
}

function main() {
  if (!existsSync(BOUNDARY)) {
    console.error(`absence-ratchet: ${BOUNDARY} is missing; it is the only file that may name platform absence`);
    process.exit(1);
  }
  const { totals, files } = countTree();
  const write = process.argv.includes('--write');
  let baseline = null;
  if (existsSync(BASELINE_PATH)) baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  if (!baseline) {
    if (!write) {
      console.error(`absence-ratchet: no ${BASELINE_PATH}; run with --write to create it`);
      process.exit(1);
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(totals, null, 2)}\n`);
    console.log(`absence-ratchet: wrote ${BASELINE_PATH}`);
    process.exit(0);
  }
  const problems = compareCounts(totals, baseline);
  if (write) {
    const rose = problems.filter(line => line.includes('rose'));
    if (rose.length) {
      console.error(`absence-ratchet:\n  ${rose.join('\n  ')}`);
      process.exit(1);
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(totals, null, 2)}\n`);
    console.log(`absence-ratchet: wrote ${BASELINE_PATH}`);
    process.exit(0);
  }
  if (problems.length) {
    const detail = files.map(row => `  ${row.file}: undefined ${row.undefined}, optional ${row.optional}, chain ${row.chain}, coalesce ${row.coalesce}`).join('\n');
    console.error(`absence-ratchet:\n  ${problems.join('\n  ')}\n${detail}`);
    process.exit(1);
  }
  console.log(`absence-ratchet: undefined ${totals.undefined}, optional ${totals.optional}, chain ${totals.chain}, coalesce ${totals.coalesce} (boundary ${BOUNDARY})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
