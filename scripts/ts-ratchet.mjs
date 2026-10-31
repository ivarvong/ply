// The TypeScript ratchet: the set of JavaScript files under src/ may only shrink. There is no list to edit (a shared
// list is a merge conflict between parallel conversions): the set at the base commit is the list.
//   - CI: RATCHET_BASE is the PR's base sha (or the previous commit on main).
//   - Locally: the merge-base with origin/main or github/main, whichever exists.
// A .js file under src/ that the base does not have fails: new code is TypeScript. When the last .js file is gone,
// the migration-only relaxations in .oxlintrc.json must go too (checked below).
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tryGit = args => { try { return git(args); } catch { return null; } };
const JS = /\.(?:js|mjs|cjs|jsx)$/;

const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? walk(`${dir}/${d.name}`) : [`${dir}/${d.name}`]));
const files = walk('src');
const js = files.filter(f => JS.test(f)).sort();
const ts = files.filter(f => f.endsWith('.ts'));

const base = process.env.RATCHET_BASE
  || ['origin/main', 'github/main'].map(r => tryGit(['merge-base', 'HEAD', r])).find(Boolean);
const problems = [];
if (base) {
  const before = new Set(git(['ls-tree', '-r', '--name-only', base, '--', 'src']).split('\n').filter(f => JS.test(f)));
  for (const f of js) if (!before.has(f)) problems.push(`${f}: new JavaScript in src/ (not in ${base.slice(0, 12)}); write it in TypeScript`);
} else {
  console.warn('ts-ratchet: no base (set RATCHET_BASE or fetch main); checking only the end state');
}
if (js.length === 0) {
  const lint = JSON.parse(readFileSync('.oxlintrc.json', 'utf8'));
  const relaxed = Object.entries(lint.rules ?? {}).filter(([r, v]) => r.startsWith('typescript/no-unsafe-') && v === 'off').map(([r]) => r);
  if (relaxed.length) problems.push(`.oxlintrc.json: src/ has no JavaScript left; turn ${relaxed.join(', ')} back on`);
}
if (problems.length) { console.error(`ts-ratchet:\n  ${problems.join('\n  ')}`); process.exit(1); }
console.log(`ts-ratchet: ${js.length} src files still JavaScript, ${ts.length} TypeScript${base ? ` (base ${base.slice(0, 12)})` : ''}`);
