// Throw ratchet. Errors are values (docs/STACK.md rule 1): the number of `throw` statements under src/ must match
// scripts/throw-baseline.json exactly. A rise fails. A drop fails until the same change lowers the baseline, so the
// count only moves down on purpose. What remains at the end is assertNever, `internal` invariants, and (until the
// public Result cut-over) the throwing wrappers other modules still call.
//
//   node scripts/throw-ratchet.mjs           compare, exit 1 on any difference
//   node scripts/throw-ratchet.mjs --write   rewrite the baseline when the count fell (a rise is refused)
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASELINE_PATH = 'scripts/throw-baseline.json';

// A `throw` in code, not in prose: drop block comments, then line comments (a `//` preceded by a space or at the
// line start, so `http://` in a string survives), then count the keyword where a statement can start.
const stripComments = text => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map(line => line.replace(/(^|\s)\/\/.*$/, '$1'))
  .join('\n');
export const countThrows = text => (stripComments(text).match(/(?:^|[;{}()]|\belse|=>|\?|:)\s*throw\b/gm) ?? []).length;

const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name).split('\\').join('/');
  if (entry.isDirectory()) return walk(path);
  return /\.(?:ts|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
});

export function countTree() {
  const files = walk('src').map(file => ({ file, n: countThrows(readFileSync(file, 'utf8')) })).filter(f => f.n > 0);
  files.sort((a, b) => b.n - a.n || a.file.localeCompare(b.file));
  return { total: files.reduce((sum, f) => sum + f.n, 0), files };
}

function main() {
  const { total, files } = countTree();
  const write = process.argv.includes('--write');
  const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : null;
  if (baseline === null || write) {
    if (baseline !== null && total > baseline.throw) {
      console.error(`throw-ratchet: throw rose ${baseline.throw} -> ${total}; a throw may only be removed`);
      process.exit(1);
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify({ throw: total }, null, 2)}\n`);
    console.log(`throw-ratchet: wrote ${BASELINE_PATH} (throw ${total})`);
    return;
  }
  if (total === baseline.throw) { console.log(`throw-ratchet: throw ${total}`); return; }
  const verb = total > baseline.throw ? 'rose' : 'fell';
  const advice = total > baseline.throw ? 'return a Result instead (docs/STACK.md rule 1)' : `lower ${BASELINE_PATH} in this change (--write)`;
  console.error(`throw-ratchet:\n  throw ${verb} ${baseline.throw} -> ${total}; ${advice}`);
  for (const f of files.slice(0, 15)) console.error(`  ${f.file}: ${f.n}`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
