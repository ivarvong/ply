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
