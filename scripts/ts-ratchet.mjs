// The TypeScript ratchet. scripts/ts-ratchet.json lists the src/ files still in JavaScript, and it may only shrink:
//   1. the list is exactly the .js files under src/ (a converted file leaves the list in the same commit; a new .js
//      file is not allowed in, so new code is TypeScript), and
//   2. against a base ref (RATCHET_BASE, the PR's base sha in CI), nothing was added to the list.
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const LIST = 'scripts/ts-ratchet.json';
const listed = JSON.parse(readFileSync(LIST, 'utf8')).js;
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? walk(`${dir}/${d.name}`) : [`${dir}/${d.name}`]));
const present = walk('src').filter(f => /\.(?:js|mjs|cjs|jsx)$/.test(f)).sort();
const problems = [];
for (const f of present) if (!listed.includes(f)) problems.push(`${f}: new JavaScript in src/; write it in TypeScript`);
for (const f of listed) if (!present.includes(f)) problems.push(`${f}: listed but not present (converted? remove it from ${LIST})`);
if (new Set(listed).size !== listed.length) problems.push(`${LIST}: duplicate entries`);
const base = process.env.RATCHET_BASE;
if (base) {
  let before = null;
  try { before = JSON.parse(execFileSync('git', ['show', `${base}:${LIST}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).js; } catch { /* the base predates the ratchet */ }
  if (before) for (const f of listed) if (!before.includes(f)) problems.push(`${f}: added to ${LIST} (base ${base} does not list it); the list may only shrink`);
}
if (problems.length) { console.error(`ts-ratchet:\n  ${problems.join('\n  ')}`); process.exit(1); }
console.log(`ts-ratchet: ${listed.length} src files still JavaScript, ${walk('src').filter(f => f.endsWith('.ts')).length} TypeScript`);
