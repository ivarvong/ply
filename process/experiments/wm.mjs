import { readFileSync } from 'node:fs';
import { wildmatch, utf8ToStr } from '/home/claude/ply/src/attributes.js';
// shell-word split for the subset t3070 uses: '...', "...", bare words with backslash escapes
const words = line => { const out = []; let i = 0; while (i < line.length) { while (line[i] === ' ') i++; if (i >= line.length) break; let w = '';
  while (i < line.length && line[i] !== ' ') { const c = line[i];
    if (c === "'") { const j = line.indexOf("'", i + 1); w += line.slice(i + 1, j); i = j + 1; }
    else if (c === '"') { i++; while (line[i] !== '"') { if (line[i] === '\\' && '"\\$`'.includes(line[i + 1])) i++; w += line[i++]; } i++; }
    else if (c === '\\') { w += line[i + 1]; i += 2; } else { w += c; i++; } }
  out.push(w); } return out; };
let n = 0, bad = 0;
for (const line of readFileSync('/home/claude/gitmaster/src/t/t3070-wildmatch.sh', 'utf8').replace(/\\\n\s*/g, ' ').split('\n')) {
  if (!line.startsWith('match ')) continue;
  const w = words(line.slice(6)); const [glob, , pm] = w; const text = w[w.length - 2], pat = w[w.length - 1];
  for (const [want, pathname] of [[glob, true], [pm, false]]) {
    if (want !== '0' && want !== '1') continue;
    n++; const got = wildmatch(utf8ToStr(pat), utf8ToStr(text), { pathname });
    if (got !== (want === '1')) { bad++; if (bad < 10) console.log(`${pathname ? 'wildmatch' : 'pathmatch'} text=${JSON.stringify(text)} pattern=${JSON.stringify(pat)} want ${want} got ${+got}`); }
  }
}
console.log(`git t3070 vectors: ${n} checks, ${bad} wrong`);
