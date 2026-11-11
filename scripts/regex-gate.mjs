// Regex gate. Text written by a remote or a caller is handled in time linear in its length, and a backtracking pattern
// is the easiest way to break that without noticing (three were found in one review: a slash trim in transport.ts,
// TOO_LARGE in push.ts, the squash message trim in rebase.ts). So every regular expression under src/ is inventoried:
//
//   1. every regex literal and every RegExp construction in src/ (found with the TypeScript compiler API) must have an
//      entry in scripts/regex-inventory.mjs with the same file and the same pattern text; an entry whose pattern is no
//      longer in that file fails too (a stale entry, or a known-bad marker left behind after its fix landed). A regex
//      built any other way cannot have a row and fails where it stands: RegExp used as a value other than the callee
//      of RegExp(...) / new RegExp(...), and String#match, matchAll or search given anything but a regex literal or a
//      construction written at the call (see regexesIn; the Cache API's cache.match is the one named allowance);
//   2. each entry says what text the pattern is applied to (`input`: remote, stored, caller or internal), why it is
//      linear (`linear`), and for remote, stored or caller text gives an adversarial input generator
//      (`adversarial(n)`), which test/regex-linear.test.js runs at n, 2n and 4n as a ratio test (4 times the length
//      must cost less than 9 times the time; never an absolute time). That test is the gate's first line;
//   3. the second line: shapes that backtrack are refused outright, whatever the inventory says: a quantifier inside a
//      quantified group (nested); two variable-length quantified atoms next to each other that can match the same
//      character (adjacent, also across capture groups: /(\d+)(\d*)/); an unanchored unbounded run followed by something that can fail, such as /\/+$/ or
//      /\n+$/ (every character of a long run starts the run again); and alternatives under a quantifier that can start
//      with the same character, such as /(a|ab)*c/. An entry marked `knownBad: '<branch that fixes it>'` is exempt
//      from 3, is listed on every run, must still be in the source (when the fix lands the entry fails the gate until
//      it is removed), and the ratio test asserts that its generator does show a superlinear cost.
//
//   node scripts/regex-gate.mjs            check, exit 1 on any problem
//   node scripts/regex-gate.mjs --list     print every pattern found with its inventory verdict
//   node scripts/regex-gate.mjs --root d   check the tree under d (d/src) against this inventory (for scratch copies)
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// TypeScript 7: the compiler API is the native compiler behind these two entry points.
import { API } from 'typescript/unstable/sync';
import { SyntaxKind, isRegularExpressionLiteral } from 'typescript/unstable/ast';

const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name).split('\\').join('/');
  if (entry.isDirectory()) return walk(path);
  return path.endsWith('.ts') ? [path] : [];
});

// String methods that compile a string argument into a RegExp: s.match('(a+)+$') builds the pattern at the call.
const STRING_REGEX_METHODS = new Set(['match', 'matchAll', 'search']);
// Calls with one of those names that are not String methods. Each is allowed by its file and its receiver, and nowhere
// else: the same call in another file, or on another receiver in that file, is refused.
export const NOT_STRING_METHODS = [
  { file: 'src/packcache.ts', receiver: 'cache', method: 'match', why: 'the Cache API: cache.match(key) looks a stored Response up by its URL key and compiles nothing' },
];

// Every regex in one parsed source file: literals (`/x/u`), and `RegExp(...)` / `new RegExp(...)` (pattern text = the
// whole expression as written, since its arguments may be computed). Every other way to build one cannot be given a
// row, so it is found too and reported as kind 'refused' (gate() fails on each):
//   - RegExp referenced as a value anywhere but as the callee of those two forms: `new globalThis.RegExp(...)`,
//     `new (RegExp)(...)`, `globalThis['RegExp']`, `const R = RegExp`, `Reflect.construct(RegExp, ...)`,
//     `class X extends RegExp`. A type position (`: RegExp`, `typeof RegExp`, `implements`) is not a value;
//   - String#match, matchAll and search called with anything but a regex literal or a RegExp construction written at
//     the call (each of which needs its own row): the engine compiles any other argument as a pattern.
export function regexesIn(file, sf) {
  const found = [];
  const lineOf = node => sf.getLineAndCharacterOfPosition(node.end).line + 1;
  const textOf = node => sf.text.slice(node.pos, node.end).trim();
  const refuse = (node, why) => found.push({ file, line: lineOf(node), pattern: textOf(node), kind: 'refused', why });
  const isConstruction = node => (node.kind === SyntaxKind.NewExpression || node.kind === SyntaxKind.CallExpression) && node.expression.kind === SyntaxKind.Identifier && node.expression.text === 'RegExp';
  const sameNode = (a, b) => a.kind === b.kind && a.pos === b.pos && a.end === b.end;
  // The member a node reads: x.name, x?.name, x['name'], x[`name`] (undefined for anything else, a computed key included).
  const memberName = node => {
    if (node.kind === SyntaxKind.PropertyAccessExpression) return node.name.text;
    if (node.kind !== SyntaxKind.ElementAccessExpression) return undefined;
    const key = node.argumentExpression;
    return key.kind === SyntaxKind.StringLiteral || key.kind === SyntaxKind.NoSubstitutionTemplateLiteral ? key.text : undefined;
  };
  const unwrapped = node => (node.kind === SyntaxKind.ParenthesizedExpression || node.kind === SyntaxKind.NonNullExpression ? unwrapped(node.expression) : node);
  // A type position: a type node, or a heritage clause that names a type (`implements`, an interface's `extends`).
  const typePosition = (node, parent) => (node.kind >= SyntaxKind.FirstTypeNode && node.kind <= SyntaxKind.LastTypeNode)
    || (node.kind === SyntaxKind.HeritageClause && (node.token === SyntaxKind.ImplementsKeyword || parent.kind === SyntaxKind.InterfaceDeclaration));
  const visit = (node, parent, inType) => {
    if (isRegularExpressionLiteral(node)) found.push({ file, line: lineOf(node), pattern: node.text, kind: 'literal' });
    else if (isConstruction(node)) found.push({ file, line: lineOf(node), pattern: textOf(node), kind: 'construction' });
    else if (node.kind === SyntaxKind.Identifier && node.text === 'RegExp') {
      if (!inType && !(isConstruction(parent) && sameNode(parent.expression, node))) refuse(parent, 'RegExp is used as a value here, not as the callee of RegExp(...) or new RegExp(...): the gate cannot inventory what is built from it, write the construction directly');
    } else if (node.kind === SyntaxKind.ElementAccessExpression && memberName(node) === 'RegExp') {
      refuse(node, "['RegExp'] reads the constructor as a value: the gate cannot inventory what is built from it, write RegExp(...) or new RegExp(...) directly");
    } else if (node.kind === SyntaxKind.CallExpression) {
      const callee = unwrapped(node.expression);
      const method = memberName(callee);
      if (method !== undefined && STRING_REGEX_METHODS.has(method)) {
        const receiver = callee.expression.kind === SyntaxKind.Identifier ? callee.expression.text : undefined;
        const allowed = NOT_STRING_METHODS.some(a => a.file === file && a.receiver === receiver && a.method === method);
        const arg = node.arguments[0];
        if (!allowed && (arg === undefined || !(isRegularExpressionLiteral(arg) || isConstruction(arg)))) {
          refuse(node, `String#${method} compiles its argument as a pattern: pass a regex literal or a RegExp construction written at the call (with its own row), or use RegExp#exec on an inventoried pattern`);
        }
      }
    }
    node.forEachChild(child => visit(child, node, inType || typePosition(child, node)));
  };
  visit(sf, sf, false);
  return found;
}

// `/source/flags` → { source, flags }. The last slash ends the source: flags never contain one.
export function splitLiteral(pattern) {
  const end = pattern.lastIndexOf('/');
  return { source: pattern.slice(1, end), flags: pattern.slice(end + 1) };
}

// ---- static shape -------------------------------------------------------------------------------------------------
// A small parser for the pattern syntax, enough to see quantifiers, groups and single-character atoms. It never has to
// understand a character class or an escape: what an atom can match is asked of the engine itself (CHARS below).
const UNBOUNDED = 32; // a {n,m} with m above this repeats enough to count as unbounded
const SAMPLE = [...Array.from({ length: 0x250 }, (_, i) => i), 0x2028, 0x2029, 0x3000, 0xfeff, 0x4e2d, 0x1f600];
const ALL = new Set(SAMPLE);
function charsOf(src, flags) {
  const kept = [...flags].filter(f => 'iusv'.includes(f)).join('');
  let re;
  try { re = new RegExp(`^(?:${src})$`, kept); } catch { return ALL; }
  return new Set(SAMPLE.filter(cp => re.test(String.fromCodePoint(cp))));
}
function parsePattern(source, flags) {
  let i = 0;
  const classEnd = () => { // from '[' to its matching ']' (v-flag classes nest)
    let depth = 0;
    for (; i < source.length; i += 1) {
      const c = source[i];
      if (c === '\\') i += 1;
      else if (c === '[') depth += 1;
      else if (c === ']') { depth -= 1; if (depth === 0) { i += 1; return; } }
    }
  };
  const escapeEnd = () => { // from '\\' past the whole escape
    const c = source[i + 1];
    i += 2;
    const braced = () => { if (source[i] === '{') i = source.indexOf('}', i) + 1; };
    if (c === 'p' || c === 'P') braced();
    else if (c === 'u') { if (source[i] === '{') braced(); else i += 4; }
    else if (c === 'x') i += 2;
    else if (c === 'c') i += 1;
    else if (c === 'k') i = source.indexOf('>', i) + 1;
    return c;
  };
  const quantifier = () => {
    const c = source[i];
    let q = null;
    if (c === '*') q = { min: 0, max: Infinity, len: 1 };
    else if (c === '+') q = { min: 1, max: Infinity, len: 1 };
    else if (c === '?') q = { min: 0, max: 1, len: 1 };
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/u.exec(source.slice(i, i + 24));
      if (m) q = { min: Number(m[1]), max: m[2] === undefined ? Number(m[1]) : m[3] === '' ? Infinity : Number(m[3]), len: m[0].length };
    }
    if (q === null) return { min: 1, max: 1 };
    i += q.len;
    if (source[i] === '?') i += 1; // lazy: the same search space
    return { min: q.min, max: q.max };
  };
  const alternation = () => {
    const alts = [[]];
    while (i < source.length && source[i] !== ')') {
      if (source[i] === '|') { i += 1; alts.push([]); continue; }
      const start = i;
      const c = source[i];
      let atom;
      if (c === '(') {
        i += 1;
        let look = false;
        if (source[i] === '?') {
          const head = /^\?(?:[=!]|<[=!])/u.exec(source.slice(i, i + 3));
          if (head) { look = true; i += head[0].length; }
          else if (source[i + 1] === '<') i = source.indexOf('>', i) + 1;
          else i = source.indexOf(':', i) + 1; // (?: and (?flags:
        }
        const body = alternation();
        i += 1; // ')'
        atom = { type: look ? 'look' : 'group', body };
      } else if (c === '[') { classEnd(); atom = { type: 'char', chars: charsOf(source.slice(start, i), flags) }; }
      else if (c === '\\') {
        const e = escapeEnd();
        if (e === 'b' || e === 'B') atom = { type: 'assert' };
        else if (e === 'k' || (e >= '1' && e <= '9')) atom = { type: 'char', chars: ALL }; // a backreference: anything
        else atom = { type: 'char', chars: charsOf(source.slice(start, i), flags) };
      } else if (c === '^' || c === '$') { i += 1; atom = { type: 'assert' }; }
      else { i += String.fromCodePoint(source.codePointAt(i)).length; atom = { type: 'char', chars: charsOf(c === '.' ? '.' : source.slice(start, i).replace(/[/{}\]]/u, '\\$&'), flags) }; }
      const q = quantifier();
      alts[alts.length - 1].push({ ...atom, ...q, text: source.slice(start, i) });
    }
    return alts;
  };
  return alternation();
}
const unbounded = item => item.max > UNBOUNDED;
const variable = item => item.max !== item.min;
const zeroWidth = item => item.type === 'assert' || item.type === 'look';
const hasUnbounded = alts => alts.some(seq => seq.some(item => unbounded(item) || ((item.type === 'group' || item.type === 'look') && hasUnbounded(item.body))));
const charsIn = item => {
  if (item.type === 'char') return item.chars;
  if (item.type === 'group') return new Set(item.body.flatMap(seq => seq.flatMap(inner => [...charsIn(inner)])));
  return new Set();
};
const overlap = (a, b) => { for (const cp of a) if (b.has(cp)) return true; return false; };
// What an alternative can start with: every atom up to and including the first one that must match.
const firstChars = seq => {
  const chars = new Set();
  for (const item of seq) {
    if (zeroWidth(item)) continue;
    for (const cp of charsIn(item)) chars.add(cp);
    if (item.min > 0) break;
  }
  return chars;
};
// What an atom can start with: for a group, what its alternatives can start with (a group that must open with a
// character the run before it cannot match is a delimiter, not a second run).
const startChars = item => (item.type === 'group' ? new Set(item.body.flatMap(alt => [...firstChars(alt)])) : charsIn(item));
// A group matched exactly once with one alternative is transparent: in /x(\d+)(\d*)y/ the two runs sit next to each
// other although each is inside its own capture group.
const flat = seq => seq.flatMap(item => (item.type === 'group' && item.min === 1 && item.max === 1 && item.body.length === 1 ? flat(item.body[0]) : [item]));
const isRun = item => !zeroWidth(item) && (unbounded(item) || (item.type === 'group' && hasUnbounded(item.body)));
const canFail = item => zeroWidth(item) || item.min > 0;
// The shapes refused: returns a list of reasons, empty when the pattern has none of them.
export function shapeProblems(source, flags) {
  const problems = [];
  const check = alts => {
    for (const seq of alts) {
      seq.forEach(item => {
        if (item.type === 'group' || item.type === 'look') {
          if (item.type === 'group' && unbounded(item) && hasUnbounded(item.body)) problems.push(`nested quantifier: ${item.text} repeats a group that itself repeats`);
          // (a|ab)*: after any prefix the engine may take either alternative, so a failure retries every split.
          if (item.type === 'group' && unbounded(item) && item.body.some((alt, k) => item.body.slice(k + 1).some(later => overlap(firstChars(alt), firstChars(later))))) {
            problems.push(`overlapping alternatives under a quantifier: two alternatives of ${item.text} can start with the same character`);
          }
          check(item.body);
        }
      });
      const line = flat(seq);
      line.forEach((item, at) => {
        if (zeroWidth(item) || !variable(item)) return;
        for (let next = at + 1; next < line.length; next += 1) {
          const other = line[next];
          if (zeroWidth(other)) continue;
          if (variable(other) && (unbounded(item) || unbounded(other)) && overlap(charsIn(item), startChars(other))) {
            problems.push(`adjacent quantified atoms ${item.text} and ${other.text} can match the same character`);
          }
          if (other.min > 0) break; // a required atom ends the run the first one could trade characters with
        }
      });
    }
  };
  const top = parsePattern(source, flags);
  check(top);
  // An unanchored unbounded run followed by something that can fail (/\/+$/ on '////…x'): the search starts the run
  // again at each of its characters and each start walks to the end of the run before failing. It needs the pattern to
  // be able to start inside the run: nothing before the run, or only atoms the run's own characters can match.
  for (const seq of top) {
    const first = seq.find(item => item.type !== 'look');
    const caret = first !== undefined && first.type === 'assert' && first.text === '^';
    seq.forEach((item, at) => {
      if (!isRun(item)) return;
      const chars = charsIn(item);
      // ^ under the m flag also matches after every newline: it anchors only a run that cannot cross one.
      if (flags.includes('y') || (caret && !(flags.includes('m') && chars.has(10)))) return;
      const restarts = seq.slice(0, at).every(before => zeroWidth(before) || overlap(charsIn(before), chars));
      const failing = seq.slice(at + 1).find(canFail);
      if (restarts && failing !== undefined) problems.push(`unanchored run ${item.text} is followed by ${failing.text}, which can fail: every character of a long run starts the run again`);
    });
  }
  return [...new Set(problems)]; // a transparent group's atoms are seen from outside and from inside it
}

// ---- the gate -----------------------------------------------------------------------------------------------------
const INPUTS = ['remote', 'stored', 'caller', 'internal'];
export function gate(found, inventory) {
  const problems = [];
  const keyOf = x => `${x.file}\n${x.pattern}`;
  const counts = new Map();
  for (const f of found) {
    if (f.kind === 'refused') problems.push(`${f.file}:${f.line}: ${f.pattern}: ${f.why}`);
    else counts.set(keyOf(f), [...(counts.get(keyOf(f)) ?? []), f]);
  }
  const seen = new Set();
  for (const entry of inventory) {
    const key = keyOf(entry);
    const where = `${entry.file}: ${entry.pattern}`;
    if (seen.has(key)) { problems.push(`${where}: listed twice in the inventory`); continue; }
    seen.add(key);
    const uses = counts.get(key) ?? [];
    if (uses.length === 0) {
      problems.push(entry.knownBad === undefined
        ? `${where}: inventory entry matches no pattern in the source (the pattern changed or was removed: update or delete the entry)`
        : `${where}: known-bad pattern is no longer in the source: its fix landed (${entry.knownBad}), remove the entry or replace it with a checked one`);
      continue;
    }
    if ((entry.count ?? 1) !== uses.length) problems.push(`${where}: used ${uses.length} time(s) (lines ${uses.map(u => u.line).join(', ')}), inventory says ${entry.count ?? 1}`);
    if (!INPUTS.includes(entry.input)) problems.push(`${where}: input must be one of ${INPUTS.join(', ')}`);
    if (typeof entry.linear !== 'string' || entry.linear.length < 12) problems.push(`${where}: say why it is linear`);
    if (entry.knownBad !== undefined && (typeof entry.knownBad !== 'string' || entry.knownBad.length < 8)) problems.push(`${where}: knownBad names the branch that fixes it`);
    if (entry.input !== 'internal' && typeof entry.adversarial !== 'function') problems.push(`${where}: ${entry.input} text needs an adversarial(n) generator for the ratio test`);
    if (uses[0].kind === 'construction' && entry.input !== 'internal' && typeof entry.build !== 'function') problems.push(`${where}: a constructed RegExp on ${entry.input} text needs build() for the ratio test`);
    if (entry.knownBad !== undefined) continue;
    if (uses[0].kind === 'literal') {
      const { source, flags } = splitLiteral(entry.pattern);
      for (const p of shapeProblems(source, flags)) problems.push(`${where}: ${p}`);
    }
  }
  for (const [key, uses] of counts) {
    if (seen.has(key)) continue;
    for (const u of uses) {
      const shape = u.kind === 'literal' ? shapeProblems(...Object.values(splitLiteral(u.pattern))) : [];
      problems.push(`${u.file}:${u.line}: ${u.pattern}: not in scripts/regex-inventory.mjs${shape.length > 0 ? ` (and refused by shape: ${shape.join('; ')})` : ''}`);
    }
  }
  return problems;
}

// Every regex under <root>/src, read from the TypeScript program of <root>/tsconfig.check.json.
export function findAll(root) {
  const abs = resolve(root);
  const api = new API({ cwd: abs });
  try {
    const { program } = api.updateSnapshot({ openProject: join(abs, 'tsconfig.check.json') }).getProjects()[0];
    return walk(join(abs, 'src')).sort().flatMap(path => {
      const sf = program.getSourceFile(path);
      if (sf === undefined) throw new Error(`regex-gate: ${path} is not in the TypeScript program`);
      return regexesIn(path.slice(abs.length + 1), sf);
    });
  } finally { api.close(); }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { INVENTORY } = await import('./regex-inventory.mjs');
  const rootAt = process.argv.indexOf('--root');
  const root = rootAt === -1 ? '.' : process.argv[rootAt + 1];
  const found = findAll(root);
  if (process.argv.includes('--list')) {
    for (const f of found) {
      const entry = INVENTORY.find(e => e.file === f.file && e.pattern === f.pattern);
      const verdict = f.kind === 'refused' ? `REFUSED: ${f.why}` : entry === undefined ? 'NOT INVENTORIED' : entry.knownBad === undefined ? `${entry.input}: ${entry.linear}` : `KNOWN BAD (fix: ${entry.knownBad})`;
      console.log(`${f.file}:${f.line}\t${f.pattern}\t${verdict}`);
    }
  }
  const problems = gate(found, INVENTORY);
  for (const p of problems) console.error(`regex-gate: ${p}`);
  if (problems.length > 0) { console.error(`regex-gate: ${problems.length} problem(s); see the header of scripts/regex-gate.mjs`); process.exit(1); }
  const knownBad = INVENTORY.filter(e => e.knownBad !== undefined);
  for (const e of knownBad) console.log(`regex-gate: KNOWN BAD ${e.file}: ${e.pattern} (fix: ${e.knownBad})`);
  console.log(`regex-gate: ${found.length} pattern(s) in src/, all inventoried, none of a refused shape (${knownBad.length} known-bad, listed above)`);
}
