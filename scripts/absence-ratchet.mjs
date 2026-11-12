// Absence ratchet. Outside src/absent.ts, counts of the platform missing value (the `undefined` identifier or type
// keyword, `void <literal>`), optional members and parameters (`a?: T`, `m?(): T`, a mapped `?:`, an optional tuple
// member), optional chaining (`?.`), and nullish coalescing (`??`, `??=`) must match scripts/absence-baseline.json
// exactly. A rise fails. A drop fails until this change lowers the baseline, so the count only moves down on purpose.
//
// It counts syntax, not text: each file is parsed (@babel/parser with its typescript plugin, the parser scripts/decision-points.mjs uses) and the nodes are counted, so `(?:` in a
// regex literal, `??` in a string or template text, and `undefined` in a comment are nothing, and `a? : T` or `void 0`
// are what they are however they are spaced. (The textual count once failed a regex's non-capturing group and the
// "fix" loosened a wire parser; a gate must not change parser behaviour for no reason.)
//
//   node scripts/absence-ratchet.mjs           compare, exit 1 on any difference
//   node scripts/absence-ratchet.mjs --write   rewrite the baseline when the count fell (a rise is refused)
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

export const BOUNDARY = 'src/absent.ts';
const BASELINE_PATH = 'scripts/absence-baseline.json';
const KEYS = ['undefined', 'optional', 'chain', 'coalesce'];

const { parse } = createRequire(import.meta.url)('@babel/parser');
const LITERALS = new Set(['NumericLiteral', 'BigIntLiteral', 'StringLiteral', 'NullLiteral', 'BooleanLiteral']);
const CHAIN = new Set(['OptionalMemberExpression', 'OptionalCallExpression', 'MemberExpression', 'CallExpression']);
const NOT_SYNTAX = new Set(['loc', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens', 'errors', 'extra']);
// One count per syntax node. Exported for the test: (file name, source text) -> counts. A file that does not parse
// throws: it is never counted as empty.
export function tally(file, text) {
  const counts = { undefined: 0, optional: 0, chain: 0, coalesce: 0 };
  const visit = node => {
    const t = node.type;
    // the missing value: the identifier (an expression, a shorthand member, a binding), the type keyword, `void 0`
    if (t === 'TSUndefinedKeyword' || (t === 'Identifier' && node.name === 'undefined')) counts.undefined += 1;
    else if (t === 'UnaryExpression' && node.operator === 'void' && LITERALS.has(node.argument.type)) counts.undefined += 1;
    // `?.`: the link that carries the token (the rest of the chain has optional: false)
    if (CHAIN.has(t)) { if (node.optional === true) counts.chain += 1; }
    // an optional member, method, parameter, mapped member (`?:` or `+?:`; `-?:` removes optionality) or tuple member
    else if (t === 'TSOptionalType' || node.optional === true || node.optional === '+') counts.optional += 1;
    if ((t === 'LogicalExpression' && node.operator === '??') || (t === 'AssignmentExpression' && node.operator === '??=')) counts.coalesce += 1;
    for (const key of Object.keys(node)) {
      if (NOT_SYNTAX.has(key)) continue;
      const child = node[key];
      if (Array.isArray(child)) { for (const c of child) if (c !== null && typeof c === 'object' && typeof c.type === 'string') visit(c); }
      else if (child !== null && typeof child === 'object' && typeof child.type === 'string') visit(child);
    }
  };
  visit(parse(text, { sourceType: 'module', errorRecovery: false, plugins: file.endsWith('.ts') ? ['typescript'] : [] }).program);
  return counts;
}

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
    const counts = tally(file, readFileSync(file, 'utf8'));
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
