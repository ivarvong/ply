// Merge NODE_V8_COVERAGE output from many processes into per-file line coverage for src/, listing uncovered lines.
//   NODE_V8_COVERAGE=/tmp/cov node --test ... && node test/fuzz/*.mjs ...; node test/coverage.mjs /tmp/cov [--lines]
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.argv[2] ?? '/tmp/cov';
const showLines = process.argv.includes('--lines');
const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

// per file: max count seen per byte offset (union across processes = max over all ranges that cover the byte)
const files = new Map(); // url → { source, counts: Int32Array }
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.json')) continue;
  const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  for (const s of j.result) {
    if (!s.url.startsWith('file://') || !fileURLToPath(s.url).startsWith(srcRoot)) continue;
    const path = fileURLToPath(s.url);
    if (!files.has(s.url)) { const source = readFileSync(path, 'utf8'); files.set(s.url, { path, source, counts: new Int32Array(source.length).fill(-1) }); }
    const { counts } = files.get(s.url);
    // V8 block coverage: ranges are nested; apply outer first then inner so inner overrides. Sort by start asc, end desc.
    const ranges = s.functions.flatMap(fn => fn.ranges.map(r => ({ ...r, block: fn.isBlockCoverage })));
    ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
    const local = new Int32Array(counts.length).fill(-1);
    for (const r of ranges) local.fill(r.count, r.startOffset, r.endOffset);
    for (let i = 0; i < counts.length; i++) if (local[i] > counts[i]) counts[i] = local[i];
  }
}

const rows = [];
let totLines = 0, totCovered = 0;
for (const [, { path, source, counts }] of [...files].sort()) {
  const lines = source.split('\n');
  let off = 0, covered = 0, executable = 0; const uncovered = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], start = off, end = off + line.length; off = end + 1;
    const code = line.trim();
    if (!code || code.startsWith('//') || code === '}' || code === '};' || code === ');' || code.startsWith('import ') || code.startsWith('export {') || /^(export )?(const|let) [A-Z_]+ = /.test(code) && !code.includes('=>') && !code.includes('(')) continue;
    // a line is covered if any non-whitespace byte in it has count > 0; uncovered if all its bytes are 0; unknown (-1) is skipped
    let any = false, zero = false, known = false;
    for (let p = start; p < end; p++) { if (/\s/.test(source[p])) continue; const c = counts[p]; if (c < 0) continue; known = true; if (c > 0) { any = true; break; } else zero = true; }
    if (!known) continue;
    executable++;
    if (any) covered++; else uncovered.push(i + 1);
  }
  totLines += executable; totCovered += covered;
  rows.push({ file: relative(srcRoot, path), executable, covered, pct: executable ? (100 * covered / executable) : 100, uncovered });
}
const ranges = u => { const out = []; for (let i = 0; i < u.length; i++) { let j = i; while (j + 1 < u.length && u[j + 1] === u[j] + 1) j++; out.push(i === j ? `${u[i]}` : `${u[i]}-${u[j]}`); i = j; } return out.join(','); };
console.log('file'.padEnd(14), 'lines'.padStart(6), 'cov'.padStart(6), 'pct'.padStart(7));
for (const r of rows) console.log(r.file.padEnd(14), String(r.executable).padStart(6), String(r.covered).padStart(6), (r.pct.toFixed(1) + '%').padStart(7), showLines && r.uncovered.length ? '  uncovered: ' + ranges(r.uncovered) : '');
console.log('TOTAL'.padEnd(14), String(totLines).padStart(6), String(totCovered).padStart(6), ((100 * totCovered / totLines).toFixed(1) + '%').padStart(7));
