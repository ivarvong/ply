// Switches and if-chains over a closed union end in assertNever, with no default that hides a missing member.
// Oxlint's switch-exhaustiveness-check covers typed switches (no default on an exhaustive union; default does not
// count as a member). It does not require the never-check to be the next statement, and it does not see an if chain.
// This script is the other half, run from `npm run lint`.
import { parse } from '@babel/parser';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const problems = [];
const typeOf = node => (node && node.type) || '';
const ABSENT_NAME = 'undef' + 'ined';
const isFn = node => {
  const t = typeOf(node);
  return t === 'FunctionDeclaration' || t === 'FunctionExpression' || t === 'ArrowFunctionExpression' || t === 'ObjectMethod' || t === 'ClassMethod';
};

const isNeverCall = node => typeOf(node) === 'CallExpression' && typeOf(node.callee) === 'Identifier' && node.callee.name === 'assertNever';

// Babel's ReturnStatement uses `argument` (ESTree shape in this parser); ExpressionStatement uses `expression`.
const stmtValue = stmt => stmt.expression || stmt.argument || null;

const stmtIsNever = stmt => {
  if (!stmt) return false;
  const t = typeOf(stmt);
  if (t === 'ReturnStatement' || t === 'ExpressionStatement') return isNeverCall(stmtValue(stmt));
  if (t === 'BlockStatement') {
    const body = stmt.body.filter(s => typeOf(s) !== 'EmptyStatement');
    return body.length === 1 && stmtIsNever(body[0]);
  }
  return false;
};

const caseIsOnlyNever = consequent => {
  const body = consequent.filter(s => typeOf(s) !== 'BreakStatement' && typeOf(s) !== 'EmptyStatement');
  return body.length === 1 && stmtIsNever(body[0]);
};

const literalCase = test => {
  const t = typeOf(test);
  return t === 'StringLiteral' || t === 'NumericLiteral' || t === 'NullLiteral' || t === 'BooleanLiteral'
    || (t === 'Identifier' && test.name === ABSENT_NAME)
    || (t === 'TemplateLiteral' && test.expressions.length === 0);
};

const propName = node => (typeOf(node) === 'MemberExpression' && !node.computed && typeOf(node.property) === 'Identifier' ? node.property.name : null);

const exprKey = node => {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed && typeOf(node.property) === 'Identifier') {
    const o = exprKey(node.object);
    return o === null ? null : `${o}.${node.property.name}`;
  }
  return null;
};

// x.tag === 'lit' / x.code === 'lit' (either side).
const tagCompare = test => {
  if (typeOf(test) !== 'BinaryExpression' || test.operator !== '===') return null;
  const mem = test.left.type === 'MemberExpression' ? test.left : test.right.type === 'MemberExpression' ? test.right : null;
  const lit = test.left.type === 'StringLiteral' || test.left.type === 'NullLiteral' || test.left.type === 'BooleanLiteral' ? test.left
    : test.right.type === 'StringLiteral' || test.right.type === 'NullLiteral' || test.right.type === 'BooleanLiteral' ? test.right : null;
  if (!mem || !lit) return null;
  const prop = propName(mem);
  if (prop !== 'tag' && prop !== 'code') return null;
  const obj = exprKey(mem.object);
  if (obj === null) return null;
  return `${obj}.${prop}`;
};

const kindChainTest = test => {
  if (typeOf(test) !== 'BinaryExpression' || test.operator !== '===') return null;
  const mem = test.left.type === 'MemberExpression' ? test.left : test.right.type === 'MemberExpression' ? test.right : null;
  const lit = test.left.type === 'StringLiteral' ? test.left : test.right.type === 'StringLiteral' ? test.right : null;
  if (!mem || !lit) return null;
  const prop = propName(mem);
  if (prop !== 'tag' && prop !== 'code' && prop !== 'kind') return null;
  const obj = exprKey(mem.object);
  return obj === null ? null : `${obj}.${prop}`;
};

function walk(node, parent, visit) {
  if (!node || typeof node !== 'object' || !node.type) return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
    const child = node[key];
    if (Array.isArray(child)) { for (const c of child) if (c && typeof c.type === 'string') walk(c, node, visit); }
    else if (child && typeof child.type === 'string') walk(child, node, visit);
  }
}

// Visit fn's body but not nested functions.
function walkOwn(fn, visit) {
  const rec = (node, parent) => {
    if (!node || typeof node !== 'object' || !node.type) return;
    if (node !== fn && isFn(node)) return;
    visit(node, parent);
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
      const child = node[key];
      if (Array.isArray(child)) { for (const c of child) if (c && typeof c.type === 'string') rec(c, node); }
      else if (child && typeof child.type === 'string') rec(child, node);
    }
  };
  rec(fn.body, fn);
}

const nextStmt = (node, parent) => {
  if (typeOf(parent) !== 'BlockStatement') return null;
  const i = parent.body.indexOf(node);
  if (i < 0) return null;
  const next = parent.body[i + 1];
  return next ? next : null;
};

const lineOf = node => {
  const loc = node && node.loc;
  const start = loc && loc.start;
  const line = start && start.line;
  return line ? line : 0;
};

const at = (file, node) => `${file}:${lineOf(node)}`;

function checkSwitch(file, node, parent) {
  const def = node.cases.find(c => c.test === null);
  if (def && caseIsOnlyNever(def.consequent)) problems.push(`${at(file, node)} default is only assertNever; the never-check is the statement after the switch`);
  const prop = propName(node.discriminant);
  const closed = prop === 'tag' || prop === 'code';
  const literals = node.cases.length > 0 && node.cases.every(c => c.test === null || literalCase(c.test));
  if (!def && (closed || literals) && !stmtIsNever(nextStmt(node, parent))) {
    problems.push(`${at(file, node)} switch over a closed set has no assertNever as the next statement`);
  }
}

function checkElseIf(file, node, parent) {
  if (typeOf(parent) === 'IfStatement' && parent.alternate === node) return;
  const tests = [];
  let cur = node;
  let terminal = null;
  while (typeOf(cur) === 'IfStatement') {
    tests.push(cur.test);
    if (typeOf(cur.alternate) === 'IfStatement') { cur = cur.alternate; continue; }
    terminal = cur.alternate;
    break;
  }
  if (tests.length < 2) return;
  const keys = tests.map(kindChainTest);
  if (keys.some(k => k === null) || new Set(keys).size !== 1) return;
  if (!stmtIsNever(terminal)) problems.push(`${at(file, node)} if/else-if chain on ${keys[0]} does not end in assertNever`);
}

function checkFunction(file, fn) {
  const counts = new Map();
  let never = false;
  const switched = new Set();
  walkOwn(fn, node => {
    const key = (node.type === 'IfStatement' || node.type === 'WhileStatement' || node.type === 'ConditionalExpression' || node.type === 'DoWhileStatement')
      ? tagCompare(node.test) : null;
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
    if (node.type === 'SwitchStatement') {
      const p = propName(node.discriminant);
      const disc = node.discriminant;
      const obj = exprKey(typeOf(disc) === 'MemberExpression' ? disc.object : null);
      if ((p === 'tag' || p === 'code') && obj !== null) switched.add(`${obj}.${p}`);
    }
    if (stmtIsNever(node) || (node.type === 'ReturnStatement' && isNeverCall(stmtValue(node)))) never = true;
    if (node.type === 'CallExpression' && isNeverCall(node)) {
      const arg = exprKey(node.arguments[0]);
      if (arg) switched.add(arg);
    }
  });
  if (never) return;
  for (const [key, n] of counts) {
    if (n >= 2 && !switched.has(key) && ![...switched].some(s => key.startsWith(`${s}.`) || s.startsWith(`${key}.`) || s === key.split('.').slice(0, -1).join('.'))) {
      problems.push(`${file}:${lineOf(fn)} ${n} comparisons of ${key} and no assertNever`);
    }
  }
}

const parseOpts = { sourceType: 'module', plugins: ['typescript'], errorRecovery: false, tokens: false };
for (const name of readdirSync('src').filter(f => f.endsWith('.ts')).sort()) {
  const file = join('src', name);
  let ast;
  try { ast = parse(readFileSync(file, 'utf8'), parseOpts); }
  catch (e) { problems.push(`${file}: parse: ${e.message}`); continue; }
  walk(ast, null, (node, parent) => {
    if (node.type === 'SwitchStatement') checkSwitch(file, node, parent);
    if (node.type === 'IfStatement') checkElseIf(file, node, parent);
  });
  walk(ast, null, node => { if (isFn(node)) checkFunction(file, node); });
}

if (problems.length) {
  console.error(`exhaustive:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('exhaustive: switches and tag chains end in assertNever');
