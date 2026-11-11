// The ratchet scripts, run as CI runs them (a process, an exit code) against a scratch tree whose counts are known
// by construction. Expected values are counted by hand from the fixture text below, never taken from the script.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/throw-ratchet.mjs', import.meta.url));
const BASELINE = 'scripts/throw-baseline.json';

// A tree with exactly two throw statements (one per function; the word in the comment is prose, not a statement).
function tree() {
  const dir = mkdtempSync(join(tmpdir(), 'ply-ratchet-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'src/a.ts'), [
    '// this file may throw twice',
    'export function a(): never { throw new Error("a"); }',
    'export function b(): never { throw new Error("b"); }',
    '',
  ].join('\n'));
  return dir;
}
const run = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });

test('throw ratchet: a missing baseline fails and is not written; only --write creates it', () => {
  const dir = tree();
  try {
    // Check mode (what `npm run typecheck` and CI run): no baseline is a failure that names the file and the count.
    const check = run(dir);
    assert.equal(check.status, 1, `check mode with no baseline must fail, got exit ${check.status}: ${check.stdout}${check.stderr}`);
    assert.match(check.stderr, /no scripts\/throw-baseline\.json \(src has 2 throw statements\)/u);
    assert.equal(existsSync(join(dir, BASELINE)), false, 'check mode must not write a baseline');
    // The explicit flag writes it, with the hand-counted number.
    const write = run(dir, '--write');
    assert.equal(write.status, 0, write.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, BASELINE), 'utf8')), { throw: 2 });
    assert.equal(run(dir).status, 0);
    // A third throw: check mode fails, and --write refuses to raise the baseline.
    writeFileSync(join(dir, 'src/c.ts'), 'export function c(): never { throw new Error("c"); }\n');
    assert.equal(run(dir).status, 1);
    const raise = run(dir, '--write');
    assert.equal(raise.status, 1);
    assert.match(raise.stderr, /throw rose 2 -> 3/u);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, BASELINE), 'utf8')), { throw: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ABSENCE = fileURLToPath(new URL('../scripts/absence-ratchet.mjs', import.meta.url));
const ZERO = { boundary: 'src/absent.ts', undefined: 0, optional: 0, chain: 0, coalesce: 0 };
// A tree whose baseline says: no absence syntax outside the boundary.
function absenceTree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ply-absence-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'src/absent.ts'), 'export const absent = undefined;\n');
  writeFileSync(join(dir, 'scripts/absence-baseline.json'), `${JSON.stringify(ZERO, null, 2)}\n`);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
const absence = dir => spawnSync(process.execPath, [ABSENCE], { cwd: dir, encoding: 'utf8' });

test('absence ratchet: a regex group, a string, a template and a comment are not absence syntax', () => {
  // Hand count: this file has no optional member, no optional chain, no coalescing operator and no missing value.
  // Every `?:`, `?.`, `??` and `undefined` below is inside a regex literal, a string, template text or a comment
  // (the regex is the one the textual count failed at 018d58b: src/push.ts:257).
  const dir = absenceTree({ 'src/a.ts': [
    '// undefined is only named here: a?.b, c ?? d, e?: f',
    '/* and here: undefined ?. ?? ?: */',
    'export const R = /^push is ([0-9]+(?:\\.[0-9]+)?) MiB, limit is ([0-9]+(?:\\.[0-9]+)?) MiB$/u;',
    "export const S = 'x?.y ?? z?: undefined';",
    'export const T = `t?.u ?? v?: undefined ${1} ?? undefined`;',
    'export const C = R.test(S) ? 1 : 2;',
    '',
  ].join('\n') });
  try {
    const r = absence(dir);
    assert.equal(r.status, 0, `a file with no absence syntax must pass a zero baseline: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /undefined 0, optional 0, chain 0, coalesce 0/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('absence ratchet: spacing does not hide syntax; each kind is counted once per node', () => {
  // Hand count, one line each:
  //   optional 4: `a? : number`, `m?(): void`, the parameter `p?: number`, the mapped `[K in keyof T]?: T[K]`
  //               (`-?` on the next line removes optionality: not counted; `c ? 1 : 2` is a conditional: not counted)
  //   undefined 3: `void 0`, the type keyword in `number | undefined`, the identifier in `= undefined`
  //   chain 3: `o?.a`, `o?.["a"]`, `f?.()`
  //   coalesce 2: `??`, `??=`
  const dir = absenceTree({ 'src/b.ts': [
    'export type O = { a? : number; m?(): void };',
    'export type P<T> = { [K in keyof T]?: T[K] };',
    'export type Q<T> = { [K in keyof T]-?: T[K] };',
    'export function g(o: O | null, f: (() => number) | null, p?: number): number {',
    '  let x: number | undefined = undefined;',
    '  const v = void 0;',
    '  x ??= 1;',
    '  const c = v ? 1 : 2;',
    '  return (o?.a ?? 0) + Number(o?.["a"]) + Number(f?.()) + Number(p) + x + c;',
    '}',
    '',
  ].join('\n') });
  try {
    const r = absence(dir);
    assert.equal(r.status, 1, `absence syntax over a zero baseline must fail: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /undefined rose 0 -> 3;/u);
    assert.match(r.stderr, /optional rose 0 -> 4;/u);
    assert.match(r.stderr, /chain rose 0 -> 3;/u);
    assert.match(r.stderr, /coalesce rose 0 -> 2;/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
