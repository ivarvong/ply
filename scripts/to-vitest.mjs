// The node:test → vitest conversion, as run once on the suite (kept so the change is reproducible and reviewable).
// node scripts/to-vitest.mjs [--check]   rewrites test files in place; --check exits 1 if any file still needs it.
//
// Mapping (node:test → vitest), every case the suite used:
//   import { test } / { test, before, after } from 'node:test'  → from 'vitest', before → beforeAll, after → afterAll
//     (file-level before/after in node:test run once around the file's tests: that is beforeAll/afterAll)
//   await import('node:test')                                    → await import('vitest')
//   test(name, { timeout, skip }, fn)                            → unchanged: vitest takes the same options object;
//     skip must be a boolean, so `skip: !X && 'why'` becomes `skip: !X`
//   t.diagnostic(msg)                                            → console.log(msg) (vitest prints a test's console)
//   t.skip(note)                                                 → unchanged: vitest's context.skip(note)
//   node's default (no timeout)                                  → testTimeout/hookTimeout 0 in vitest.config.ts
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const check = process.argv.includes('--check');
const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk('test').filter(f => /\.test\.js$/.test(f));

const rewrite = src => src
  .replace(/import \{ ([^}]*) \} from 'node:test';/g, (_, names) => `import { ${names.split(',').map(s => s.trim()).map(n => n === 'before' ? 'beforeAll as before' : n === 'after' ? 'afterAll as after' : n).join(', ')} } from 'vitest';`)
  .replace(/await import\('node:test'\)/g, "await import('vitest')")
  .replace(/\bt\.diagnostic\(/g, 'console.log(')
  .replace(/skip: (![A-Z_]+) && '[^']*'/g, 'skip: $1');

let pending = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8'), out = rewrite(src);
  if (out === src) continue;
  pending++;
  if (check) console.log(`needs conversion: ${f}`);
  else writeFileSync(f, out);
}
if (check && pending) process.exit(1);
console.log(`${check ? 'checked' : 'converted'} ${files.length} files, ${pending} ${check ? 'pending' : 'changed'}`);
