// Bundle-size budget. Each package entry, bundled as a consumer's bundler would (esbuild, ESM, minified), must stay
// within its baseline in scripts/bundle-baseline.json: the minified bytes may exceed the baseline by at most
// `tolerance` (a fraction of it, rounded down to whole bytes) before the check fails. Under the baseline it passes and
// says the baseline can be tightened, as the other ratchets do.
//
//   node scripts/bundle-budget.mjs           compare, exit 1 when an entry is over budget or has no baseline
//   node scripts/bundle-budget.mjs --write   lower each baseline an entry is now under (a rise is refused)
// The baseline is written only under --write, and --write never raises one: raising a baseline is a hand edit in a
// commit that carries `Ratchet-Change: scripts/bundle-baseline.json: <reason>` (scripts/ratchet-guard.mjs, in CI).
// test/bundle.test.js runs the same check in the suite.
//
// Only minified bytes are gated. esbuild is pinned (package.json and the lockfile), and its output for one version
// and one input does not depend on the machine. The gzip size is printed beside it, not gated: it depends on the
// zlib that node:zlib links (Chromium's fork, whose deflate may differ by Node version and CPU), and this repository
// has no record of it being equal on Node 20, 22 and 24.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

export const BASELINE_PATH = 'scripts/bundle-baseline.json';
// Each published entry point that has a browser/Workers bundle (the -node adapters are Node-only and not budgeted).
export const ENTRIES = {
  full: 'src/index.ts',
  edit: 'src/edit.ts',
  read: 'src/read.ts',
  log: 'src/log.ts',
  tree: 'src/tree.ts',
  checkout: 'src/checkout.ts',
  merge: 'src/merge.ts',
};

// The options test/bundle.test.js checks bundle contents with.
export const BUILD = { bundle: true, format: 'esm', minify: true, write: false, logLevel: 'silent', metafile: true };

export async function measure(entry) {
  const out = await build({ ...BUILD, entryPoints: [entry] });
  const bytes = out.outputFiles[0].contents;
  return { min: bytes.length, gz: gzipSync(bytes, { level: 9 }).length };
}

export async function measureAll(entries = ENTRIES) {
  const sizes = {};
  for (const [name, entry] of Object.entries(entries)) sizes[name] = await measure(entry);
  return sizes;
}

// The bytes an entry may carry: its baseline plus the tolerance, rounded down.
export const limitOf = (budget, tolerance) => budget + Math.floor(budget * tolerance);

// One entry against its budget. `over` fails; `within` (above the baseline, inside the tolerance), `at` and `under`
// pass; `under` says the baseline can be lowered.
export function judge(name, got, budget, tolerance) {
  const limit = limitOf(budget, tolerance);
  const d = got - budget;
  const delta = `${d >= 0 ? '+' : ''}${d}`;
  if (got > limit) return { name, verdict: 'over', ok: false, message: `${name} ${got} B is over budget: baseline ${budget}, limit ${limit} (${delta})` };
  if (got > budget) return { name, verdict: 'within', ok: true, message: `${name} ${got} B is above baseline ${budget} within the tolerance (${delta}, limit ${limit})` };
  if (got === budget) return { name, verdict: 'at', ok: true, message: `${name} ${got} B is at baseline ${budget}` };
  return { name, verdict: 'under', ok: true, message: `${name} ${got} B is under baseline ${budget} (${delta}): the baseline can be tightened (node scripts/bundle-budget.mjs --write)` };
}

// Every measured entry against the baseline record { tolerance, min: { <entry>: bytes } }. An entry with no
// baseline fails: a deleted line must not admit any size.
export function check(baseline, sizes) {
  return Object.entries(sizes).map(([name, { min }]) => {
    const budget = baseline.min[name];
    if (typeof budget !== 'number') return { name, verdict: 'missing', ok: false, message: `${name} ${min} B has no baseline in ${BASELINE_PATH}` };
    return judge(name, min, budget, baseline.tolerance);
  });
}

const DEFAULT_TOLERANCE = 0.005;
const write = (baseline) => writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);

async function main() {
  const sizes = await measureAll();
  const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : null;
  for (const [name, { min, gz }] of Object.entries(sizes)) console.log(`bundle-budget: ${name.padEnd(8)} ${String(min).padStart(7)} B min, ${String(gz).padStart(6)} B gz (gz not gated)`);
  if (process.argv.includes('--write')) {
    if (baseline === null) {
      write({ tolerance: DEFAULT_TOLERANCE, min: Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, v.min])) });
      console.log(`bundle-budget: wrote ${BASELINE_PATH}`);
      return;
    }
    const rose = Object.entries(sizes).filter(([k, v]) => typeof baseline.min[k] !== 'number' || v.min > baseline.min[k]);
    if (rose.length > 0) {
      console.error(`bundle-budget: --write only lowers a baseline; raise ${rose.map(([k]) => k).join(', ')} by hand in a commit with 'Ratchet-Change: ${BASELINE_PATH}: <reason>'`);
      process.exit(1);
    }
    write({ ...baseline, min: { ...baseline.min, ...Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, v.min])) } });
    console.log(`bundle-budget: wrote ${BASELINE_PATH}`);
    return;
  }
  if (baseline === null) {
    console.error(`bundle-budget: no ${BASELINE_PATH}; run with --write to create it`);
    process.exit(1);
  }
  const results = check(baseline, sizes);
  for (const r of results) (r.ok ? console.log : console.error)(`bundle-budget: ${r.message}`);
  if (results.some(r => !r.ok)) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
