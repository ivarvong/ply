// Query a trace JSONL. Examples:
//   node test/trace.mjs fuzz-out/trace.jsonl                      # one line per span: name, duration, key attrs
//   node test/trace.mjs fuzz-out/trace.jsonl git.receive-pack      # filter by span name
//   node test/trace.mjs fuzz-out/trace.jsonl - git.pack.inflate.stored>0   # attr predicate
//   node test/trace.mjs fuzz-out/trace.jsonl - - git.push.pack.bytes       # histogram of a numeric attr
import { readFileSync } from 'node:fs';
import { flattenLine } from '../src/otel.js';

const [file, nameFilter = '-', pred = '-', hist = '-'] = process.argv.slice(2);
const spans = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => flattenLine(JSON.parse(l)));
const m = pred !== '-' && pred.match(/^([\w.]+)\s*(>=|<=|>|<|==|!=|~)\s*(.*)$/);
const test = s => {
  if (nameFilter !== '-' && s.name !== nameFilter) return false;
  if (!m) return true;
  const v = s.attrs[m[1]]; const rhs = m[3];
  switch (m[2]) { case '>': return v > +rhs; case '<': return v < +rhs; case '>=': return v >= +rhs; case '<=': return v <= +rhs; case '==': return String(v) === rhs; case '!=': return String(v) !== rhs; case '~': return new RegExp(rhs).test(String(v)); }
};
const hit = spans.filter(test);
if (hist !== '-') {
  const vals = hit.map(s => s.attrs[hist]).filter(v => typeof v === 'number').sort((a, b) => a - b);
  const q = p => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
  console.log(`${hist}: n=${vals.length} min=${vals[0]} p50=${q(0.5)} p90=${q(0.9)} p99=${q(0.99)} max=${vals[vals.length - 1]} sum=${vals.reduce((a, b) => a + b, 0)}`);
} else {
  for (const s of hit) {
    const keys = Object.keys(s.attrs).filter(k => /outcome|git\.pack\.objects|bytes$|git\.push\.ok|cache_hit|matches|error\.type|filter/.test(k)).slice(0, 10);
    console.log(`${s.name.padEnd(26)} ${s.durationMs.toFixed(1).padStart(7)}ms ${s.status.code === 2 ? 'ERR ' : '    '}${keys.map(k => `${k}=${JSON.stringify(s.attrs[k])}`).join(' ')}`);
  }
  console.log(`-- ${hit.length}/${spans.length} spans`);
}
