// Decision-point inventory: every place in src/ where ply decides an outcome, extracted statically (no hand list).
//
//   site      a call that builds a typed error: `fail(...)`, `failHere(...)`, or a call to a wrapper. A wrapper is a function
//             of at most three statements whose result is a fail() (or another wrapper's) built from its parameters,
//             unconditionally (`proto(msg)`, `limitError(what, got, max)`, `bad(why)`) or with a code its caller picks
//             (`take(buf, off, n, code)`). A guarded check (`validateWire`) is not a wrapper: its own fail() is the site.
//             The wrapper's own fail() is a site too.
//   producer  a literal error code from src/errors.js produced outside a site: returned, a conditional's branch, a `code:`
//             property, an assignment (`e.code = code` in `coded`), a default parameter. Comparisons are not producers.
//   untyped   a `throw new Error(...)` in src/: an error with no code from errors.js (SAFETY I1 says every error has one).
//   decode    every bytes-to-string decode, with its mode: lossless (decodeBytes), strict (TextDecoder fatal,
//             decodeURIComponent: throws on non-UTF-8), replacement (default TextDecoder: non-UTF-8 becomes U+FFFD).
//             Whether a decode is display-only is the registry's call (an exclusion with that reason).
//   export    every exported parse*/decode*/classify*/decide* function.
//
// Every entry has a stable id `<file>#<function>:<code>:<message stem>` (line numbers move on every edit; the id moves
// only when the decision does). Ids repeated inside one function get `#2`, `#3`, ... in source order.
//
//   node scripts/decision-points.mjs            table
//   node scripts/decision-points.mjs --json     JSON (what test/space/gates.test.js reads)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { parse } = createRequire(import.meta.url)('@babel/parser');
const { CODES } = await import(join(ROOT, 'src/errors.ts'));
const CODE_SET = new Set(CODES);
// Files that define or document the taxonomy rather than decide with it.
const SKIP_PRODUCERS = new Set(['src/errors.ts', 'src/errors-doc.ts']);
// The constructors a site calls: `fail` (unconverted modules import `thrown as fail`), and plyError itself.
const CONSTRUCTORS = new Set(['fail', 'thrown', 'plyError']);
// Source keeps `.js` specifiers for .ts files (test/ts-resolve.mjs): the file an import names is whichever exists.
const srcFile = spec => { const js = `src/${spec.slice(2)}`; const ts = js.replace(/\.js$/, '.ts'); return existsSync(join(ROOT, ts)) ? ts : js; };
const EXPORT_NAME = /^(parse|decode|classify|decide)/i;
const STEM = 56;

const children = n => {
  const out = [];
  for (const k of Object.keys(n)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments' || k === 'extra') continue;
    const v = n[k];
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === 'string') out.push(x); } else if (v && typeof v.type === 'string') out.push(v);
  }
  return out;
};
const isFn = n => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'ObjectMethod' || n.type === 'ClassMethod' || n.type === 'ClassPrivateMethod';
const keyName = k => (k?.type === 'Identifier' ? k.name : k?.type === 'StringLiteral' ? k.value : k?.type === 'PrivateName' ? `#${k.id.name}` : null);
// The name a function is known by: its own id, the variable / property / method it is assigned to.
function fnName(fn, parent) {
  if (fn.id?.name) return fn.id.name;
  if (fn.type === 'ObjectMethod' || fn.type === 'ClassMethod' || fn.type === 'ClassPrivateMethod') return keyName(fn.key);
  if (parent?.type === 'VariableDeclarator') return parent.id?.name ?? null;
  if (parent?.type === 'ObjectProperty' || parent?.type === 'ClassProperty') return keyName(parent.key);
  if (parent?.type === 'AssignmentExpression') return parent.left?.type === 'MemberExpression' ? keyName(parent.left.property) : parent.left?.name ?? null;
  return null;
}

function walk(node, visit, ancestors = []) {
  visit(node, ancestors);
  ancestors.push(node);
  for (const c of children(node)) walk(c, visit, ancestors);
  ancestors.pop();
}

const src = (text, n) => text.slice(n.start, n.end);
// A message argument as text: string literals as is, template literals with each `${...}` as `…`, anything else as
// `<expr>`. Whitespace collapsed; cut at STEM characters.
function messageText(text, n) {
  if (!n) return '';
  let s;
  if (n.type === 'StringLiteral') s = n.value;
  else if (n.type === 'TemplateLiteral') s = n.quasis.map(q => q.value.cooked ?? q.value.raw).join('…');
  else if (n.type === 'ConditionalExpression') s = `${messageText(text, n.consequent)} | ${messageText(text, n.alternate)}`;
  else if (n.type === 'BinaryExpression' && n.operator === '+') s = `${messageText(text, n.left)}${messageText(text, n.right)}`;
  else s = `<${src(text, n).replace(/\s+/g, ' ').slice(0, 40)}>`;
  return s.replace(/\s+/g, ' ').trim();
}
const codeText = (text, n) => (!n ? '?' : n.type === 'StringLiteral' ? n.value : `<${src(text, n).replace(/\s+/g, ' ').slice(0, 40)}>`);
const stemOf = s => (s.length > STEM ? `${s.slice(0, STEM)}…` : s);

function parseFile(file) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const ast = parse(text, { sourceType: 'module', errorRecovery: false, plugins: file.endsWith('.ts') ? ['typescript'] : [] });
  return { file, text, ast: ast.program };
}

// Every function node with its name, parameter names, enclosing function, and statement count.
function functionsOf(f) {
  const fns = [];
  walk(f.ast, (n, anc) => {
    if (!isFn(n)) return;
    const parent = anc[anc.length - 1];
    const enclosing = [...anc].reverse().find(isFn) ?? null;
    const params = new Set();
    for (const p of n.params) walk(p, x => { if (x.type === 'Identifier') params.add(x.name); });
    const stmts = n.body.type === 'BlockStatement' ? n.body.body.length : 1;
    fns.push({ node: n, name: fnName(n, parent), params, stmts, enclosing });
  });
  return fns;
}

// A TextDecoder's mode: `fatal: true` throws on bytes that are not UTF-8 (strict); the default replaces them with
// U+FFFD (replacement: the bytes are lost). Both differ from git, which passes names, messages and paths as raw bytes.
const decoderMode = n => (n.arguments[1]?.type === 'ObjectExpression' && n.arguments[1].properties.some(p => keyName(p.key) === 'fatal' && p.value.value === true) ? 'strict' : 'replacement');
// name -> mode for every TextDecoder bound at a module's top level, and `td` imported from bytes.js
const decoderCache = new Map();
function decoders(f) {
  if (decoderCache.has(f.file)) return decoderCache.get(f.file);
  const m = new Map();
  walk(f.ast, n => { if (n.type === 'VariableDeclarator' && n.init?.type === 'NewExpression' && n.init.callee.name === 'TextDecoder' && n.id.type === 'Identifier') m.set(n.id.name, decoderMode(n.init)); });
  for (const st of f.ast.body) if (st.type === 'ImportDeclaration' && st.source.value === './bytes.js') for (const sp of st.specifiers) if (sp.imported?.name === 'td') m.set(sp.local.name, 'replacement');
  decoderCache.set(f.file, m);
  return m;
}
// The innermost named function around a node: a callback (`.map(x => ...)`) is part of the function that wrote it.
const nameAt = (f, anc) => {
  for (let i = anc.length - 1; i >= 0; i--) if (isFn(anc[i])) { const n = f.fns.find(x => x.node === anc[i])?.name; if (n) return n; }
  return '(top)';
};
// A callee under a type-only wrapper (`(fail as (code: 'limit_exceeded', ...) => Thrown)(...)`) is the callee itself.
const TS_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression']);
const bare = n => (TS_WRAPPERS.has(n.type) ? bare(n.expression) : n);
const calleeName = c => { const k = bare(c.callee); return k.type === 'Identifier' ? k.name : null; };
const calleePos = c => (c.callee.type === 'MemberExpression' ? c.callee.property.loc.start : c.callee.loc.start);
const usesAny = (n, names) => { let hit = false; walk(n, x => { if (x.type === 'Identifier' && names.has(x.name)) hit = true; }); return hit; };

export function inventory() {
  const files = readdirSync(join(ROOT, 'src')).filter(x => /\.(js|ts)$/.test(x) && !x.endsWith('.d.ts')).sort().map(x => parseFile(`src/${x}`));
  // ---- wrappers, to a fixpoint: (file, name) -> { code, def } ----
  const wrappers = new Map(); // `${file}:${name}` -> [{ fn, file, codeArg }]
  const imports = new Map(); // file -> Map(local -> `${srcFile}:${imported}`)
  for (const f of files) {
    const m = new Map();
    for (const st of f.ast.body) {
      if (st.type !== 'ImportDeclaration' || !st.source.value.startsWith('./')) continue;
      const from = srcFile(st.source.value);
      for (const s of st.specifiers) if (s.type === 'ImportSpecifier') m.set(s.local.name, `${from}:${s.imported.name}`);
    }
    imports.set(f.file, m);
    f.fns = functionsOf(f);
  }
  const isProducerCall = (f, call) => {
    const name = calleeName(call);
    if (!name) return null;
    if (CONSTRUCTORS.has(name)) return { kind: 'fail' };
    if (name === 'failHere') return { kind: 'failHere' };
    const imp = imports.get(f.file).get(name);
    const key = imp ?? `${f.file}:${name}`;
    const ws = wrappers.get(key);
    if (!ws) return null;
    // innermost definition whose scope (the function enclosing the definition) contains the call; top level otherwise
    const inScope = ws.filter(w => !imp && (!w.fn.enclosing || (w.fn.enclosing.start <= call.start && call.end <= w.fn.enclosing.end)));
    const w = imp ? ws[0] : inScope.sort((a, b) => (b.fn.enclosing?.start ?? -1) - (a.fn.enclosing?.start ?? -1))[0];
    return w ? { kind: 'wrapper', via: name, wrapper: w } : null;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const f of files) for (const fn of f.fns) {
      if (!fn.name || fn.stmts > 3 || fn.name === 'failHere') continue;
      const key = `${f.file}:${fn.name}`;
      if (wrappers.get(key)?.some(w => w.fn === fn)) continue;
      // the error must be the function's result: the arrow's body, or a thrown / returned value, through conditionals
      // and `if` branches only (a call inside a try, a loop or a nested function is a use, not a construction)
      // Behind an `if` it is a check, not a wrapper, unless the caller picks the code (`take(buf, off, n, code)`): a check's
      // call sites are ordinary calls, its own fail() is the decision point.
      let hit = null;
      const result = (n, guarded) => {
        if (hit || !n) return;
        if (n.type === 'CallExpression') {
          const p = isProducerCall(f, n);
          if (!p || p.kind === 'failHere' || !usesAny(n, fn.params)) return;
          const codeArg = p.kind === 'fail' ? n.arguments[0] : null;
          if (!guarded || (codeArg?.type === 'Identifier' && fn.params.has(codeArg.name))) hit = { call: n, p };
          return;
        }
        if (n.type === 'ConditionalExpression') { result(n.consequent, guarded); result(n.alternate, guarded); }
        else if (n.type === 'LogicalExpression') result(n.right, guarded);
        else if (n.type === 'ThrowStatement' || n.type === 'ReturnStatement') result(n.argument, guarded);
        else if (n.type === 'IfStatement') { result(n.consequent, true); result(n.alternate, true); }
        else if (n.type === 'BlockStatement') n.body.forEach(x => result(x, guarded));
      };
      result(fn.node.body, false);
      if (!hit) continue;
      wrappers.set(key, [...(wrappers.get(key) ?? []), { fn, file: f.file, inner: hit }]);
      changed = true;
    }
  }
  // a wrapper exported under another name (`export { limitExceeded as limitError }`) is that wrapper under both names
  for (const f of files) for (const st of f.ast.body) {
    if (st.type !== 'ExportNamedDeclaration' || st.source) continue;
    for (const sp of st.specifiers ?? []) {
      const from = `${f.file}:${sp.local.name}`, to = `${f.file}:${keyName(sp.exported)}`;
      if (from !== to && wrappers.has(from) && !wrappers.has(to)) wrappers.set(to, wrappers.get(from));
    }
  }
  // the code a wrapper produces: its inner call's literal code, or the default of the parameter it forwards
  const wrapperCode = (w, args, text) => {
    const call = w.inner.call;
    if (w.inner.p.kind === 'wrapper') return wrapperCode(w.inner.p.wrapper, call.arguments, text);
    const c = call.arguments[0];
    if (c?.type === 'StringLiteral') return c.value;
    if (c?.type === 'Identifier') {
      const i = w.fn.node.params.findIndex(p => (p.type === 'Identifier' ? p.name : p.left?.name) === c.name);
      if (i >= 0 && args?.[i]?.type === 'StringLiteral') return args[i].value;
      const p = w.fn.node.params[i];
      if (p?.type === 'AssignmentPattern' && p.right.type === 'StringLiteral') return p.right.value;
    }
    return codeText(text, c);
  };
  // the message a wrapper call carries: the call's first string-ish argument (its `what`)
  // the message a wrapper call carries: its first string-ish argument other than the one the wrapper uses as the code
  // (`take(buf, off, n, 'protocol')` is `<buf>, <off>, <n>`), else every other argument
  const codeParam = w => { const c = w.inner.p.kind === 'fail' ? w.inner.call.arguments[0] : null; return c?.type === 'Identifier' ? w.fn.node.params.findIndex(p => (p.type === 'Identifier' ? p.name : p.left?.name) === c.name) : -1; };
  const wrapperWhat = (text, call, w) => {
    const args = call.arguments.filter((_, i) => i !== codeParam(w));
    const a = args.find(x => x.type === 'StringLiteral' || x.type === 'TemplateLiteral');
    return a ? messageText(text, a) : args.map(x => messageText(text, x)).join(', ');
  };

  const sites = [], producers = [], exports = [], untyped = [], decodes = [];
  for (const f of files) {
    const siteCalls = new Set();
    walk(f.ast, (n, anc) => {
      if (n.type !== 'CallExpression') return;
      const p = isProducerCall(f, n);
      if (!p) return;
      // errors.ts's constructors calling one another (fail -> plyError) are the taxonomy, not a decision
      if (SKIP_PRODUCERS.has(f.file) && p.kind === 'fail' && CONSTRUCTORS.has(nameAt(f, anc))) return;
      siteCalls.add(n);
      const fname = nameAt(f, anc);
      const pos = calleePos(n);
      let code, what;
      if (p.kind === 'fail') { code = codeText(f.text, n.arguments[0]); what = messageText(f.text, n.arguments[1]); }
      else if (p.kind === 'failHere') { code = n.arguments[0]?.type === 'CallExpression' && CONSTRUCTORS.has(calleeName(n.arguments[0])) ? codeText(f.text, n.arguments[0].arguments[0]) : '<rethrown or pack_corrupt>'; what = n.arguments[0]?.type === 'CallExpression' ? messageText(f.text, n.arguments[0].arguments[1]) : messageText(f.text, n.arguments[0]); }
      else { code = wrapperCode(p.wrapper, n.arguments, f.text); what = wrapperWhat(f.text, n, p.wrapper); }
      // a fail() passed straight into failHere is one decision, recorded as the failHere site
      if (p.kind === 'fail' && anc[anc.length - 1]?.type === 'CallExpression' && calleeName(anc[anc.length - 1]) === 'failHere') return;
      sites.push({ file: f.file, line: n.loc.start.line, endLine: n.loc.end.line, col: pos.column + 1, callLine: pos.line, fn: fname, kind: p.kind, ...(p.via ? { via: p.via } : {}), code, what });
    });
    if (!SKIP_PRODUCERS.has(f.file)) walk(f.ast, (n, anc) => {
      if (n.type !== 'StringLiteral' || !CODE_SET.has(n.value)) return;
      const parent = anc[anc.length - 1];
      // a code inside a site's code argument (`fail(c ? 'protocol' : 'ssh', ...)`) is that site's, not a producer
      if (anc.some(a => siteCalls.has(a) && a.arguments[0] && a.arguments[0].start <= n.start && n.end <= a.arguments[0].end)) return;
      let ctx = null;
      if (parent?.type === 'ReturnStatement' || (parent?.type === 'ArrowFunctionExpression' && parent.body === n)) ctx = 'return';
      else if (parent?.type === 'ConditionalExpression' && parent.test !== n) ctx = 'conditional';
      else if (parent?.type === 'ObjectProperty' && parent.value === n && keyName(parent.key) === 'code') ctx = 'code-property';
      else if (parent?.type === 'AssignmentExpression' && parent.right === n) ctx = 'assignment';
      else if (parent?.type === 'AssignmentPattern' && parent.right === n) ctx = 'default';
      else if (parent?.type === 'CallExpression' && calleeName(parent) === 'coded') ctx = 'coded';
      if (!ctx) return;
      const fname = nameAt(f, anc);
      producers.push({ file: f.file, line: n.loc.start.line, fn: fname, kind: 'producer', ctx, code: n.value, what: src(f.text, anc.findLast(a => a.type.endsWith('Statement') || a.type === 'VariableDeclarator') ?? n).replace(/\s+/g, ' ').slice(0, 80) });
    });
    // decoders: every `<decoder>.decode(...)`, `decodeURIComponent(...)`, `decodeBytes(...)`, with the decoder's mode
    walk(f.ast, (n, anc) => {
      if (n.type !== 'CallExpression') return;
      let mode = null, via = null;
      const c = n.callee;
      if (c.type === 'Identifier' && (c.name === 'decodeURIComponent' || c.name === 'decodeURI')) { mode = 'strict'; via = c.name; }
      else if (c.type === 'Identifier' && c.name === 'decodeBytes') { mode = 'lossless'; via = 'decodeBytes'; }
      else if (c.type === 'MemberExpression' && keyName(c.property) === 'decode') {
        const o = c.object;
        if (o.type === 'NewExpression' && o.callee.name === 'TextDecoder') { mode = decoderMode(o); via = 'new TextDecoder'; }
        else if (o.type === 'Identifier') { const d = decoders(f).get(o.name); if (d) { mode = d; via = o.name; } }
      }
      if (!mode) return;
      decodes.push({ file: f.file, line: n.loc.start.line, fn: nameAt(f, anc), kind: 'decode', mode, via, code: `<decode:${mode}>`, what: src(f.text, n.arguments[0] ?? n).replace(/\s+/g, ' ').slice(0, 60) });
    });
    if (f.file !== 'src/errors.ts') walk(f.ast, (n, anc) => {
      if (n.type !== 'NewExpression' || n.callee.type !== 'Identifier' || !/^(Error|TypeError|RangeError)$/.test(n.callee.name)) return;
      untyped.push({ file: f.file, line: n.loc.start.line, fn: nameAt(f, anc), kind: 'untyped', code: '<untyped>', what: messageText(f.text, n.arguments[0]) });
    });
    for (const st of f.ast.body) {
      if (st.type !== 'ExportNamedDeclaration') continue;
      const names = [];
      if (st.declaration?.type === 'FunctionDeclaration') names.push([st.declaration.id.name, st.declaration.loc.start.line]);
      if (st.declaration?.type === 'VariableDeclaration') for (const d of st.declaration.declarations) if (d.init && isFn(d.init)) names.push([d.id.name, d.loc.start.line]);
      if (!st.source) for (const s of st.specifiers ?? []) {
        const local = s.local.name;
        const def = f.fns.find(x => x.name === local && !x.enclosing);
        if (def) names.push([s.exported.name, def.node.loc.start.line]);
      }
      for (const [name, line] of names) if (EXPORT_NAME.test(name)) exports.push({ file: f.file, line, fn: name, kind: 'export', code: '-', what: `export ${name}` });
    }
  }
  // stable ids
  const seen = new Map();
  const idOf = e => {
    const base = e.kind === 'decode' ? `${e.file}#${e.fn}:decode:${e.mode}:${stemOf(e.what)}` : e.kind === 'untyped' ? `${e.file}#${e.fn}:untyped:${stemOf(e.what)}` : e.kind === 'export' ? `${e.file}#${e.fn}:export` : `${e.file}#${e.fn}:${e.kind === 'producer' ? `${e.ctx}=` : ''}${e.code}:${stemOf(e.what)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  };
  for (const list of [sites, producers, exports, untyped, decodes]) for (const e of list.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || (a.col ?? 0) - (b.col ?? 0))) e.id = idOf(e);
  const wrapperList = [...wrappers.entries()].map(([k, ws]) => ({ wrapper: k, lines: ws.map(w => w.fn.node.loc.start.line) }));
  return { sites, producers, exports, untyped, decodes, wrappers: wrapperList };
}

// The decision points the registry must account for: every site, every producer, every untyped throw, every export.
export const decisionPoints = inv => [...inv.sites, ...inv.producers, ...inv.untyped, ...inv.decodes, ...inv.exports];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const inv = inventory();
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(inv, null, 2)}\n`);
  else printTable(inv);
}
function printTable(inv) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`wrappers: ${inv.wrappers.map(w => w.wrapper.replace('src/', '')).join(' ')}`);
  console.log(`sites ${inv.sites.length} (fail ${inv.sites.filter(s => s.kind === 'fail').length}, failHere ${inv.sites.filter(s => s.kind === 'failHere').length}, wrapper calls ${inv.sites.filter(s => s.kind === 'wrapper').length}), producers ${inv.producers.length}, untyped ${inv.untyped.length}, decodes ${inv.decodes.length} (${['lossless', 'strict', 'replacement'].map(m => `${m} ${inv.decodes.filter(d => d.mode === m).length}`).join(', ')}), exports ${inv.exports.length}\n`);
  console.log(`${pad('file:line', 26)} ${pad('kind', 16)} ${pad('code', 18)} ${pad('function', 22)} what`);
  for (const e of decisionPoints(inv)) console.log(`${pad(`${e.file.replace('src/', '')}:${e.line}`, 26)} ${pad(e.kind === 'wrapper' ? `wrapper:${e.via}` : e.kind === 'producer' ? `producer:${e.ctx}` : e.kind === 'decode' ? `decode:${e.mode}` : e.kind, 16)} ${pad(e.code, 18)} ${pad(e.fn, 22)} ${e.what.slice(0, 70)}`);
}
