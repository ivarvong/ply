// git rev-parse is the syntax oracle for a full object name, and the record of what ply refuses that git accepts.
// parseOid is the 40-lowercase-hex subset. Abbreviations, ref names, and uppercase are git's, not ply's.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOid, parseCommitId, ZERO_OID } from '../src/oid.js';
import { OID_HEX_CHARS } from '../src/format.js';

const git = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

test('parseOid agrees with git rev-parse on a full lowercase id, and refuses abbreviations and uppercase', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oid-'));
  try {
    const env = { ...process.env, GIT_AUTHOR_NAME: 'o', GIT_AUTHOR_EMAIL: 'o@x', GIT_AUTHOR_DATE: '@1400000000 +0000', GIT_COMMITTER_NAME: 'o', GIT_COMMITTER_EMAIL: 'o@x', GIT_COMMITTER_DATE: '@1400000000 +0000' };
    const run = args => { const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
    run(['init', '-q', '-b', 'main']);
    writeFileSync(join(dir, 'f.txt'), 'f\n');
    run(['add', '-A']);
    run(['commit', '-q', '-m', 'base']);
    const full = run(['rev-parse', 'HEAD']);
    assert.equal(full.length, OID_HEX_CHARS);
    const verify = name => git(dir, ['rev-parse', '--verify', '--end-of-options', name]);
    const ok = verify(full);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), full);
    const parsed = parseOid(full);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.value, full);
    const commit = parseCommitId(full);
    assert.equal(commit.ok, true);

    const upper = verify(full.toUpperCase());
    assert.equal(upper.status, 0, upper.stderr);
    assert.equal(upper.stdout.trim(), full);
    assert.equal(parseOid(full.toUpperCase()).ok, false);

    const abbrev = verify(full.slice(0, OID_HEX_CHARS - 1));
    assert.equal(abbrev.status, 0, abbrev.stderr);
    assert.equal(abbrev.stdout.trim(), full);
    assert.equal(parseOid(full.slice(0, OID_HEX_CHARS - 1)).ok, false);

    assert.notEqual(verify(`${full}a`).status, 0);
    assert.equal(parseOid(`${full}a`).ok, false);
    assert.notEqual(verify('g'.repeat(OID_HEX_CHARS)).status, 0);
    assert.equal(parseOid('g'.repeat(OID_HEX_CHARS)).ok, false);
    // a ref name is a revision in git and not an object id in ply
    assert.equal(verify('HEAD').status, 0);
    assert.equal(parseOid('HEAD').ok, false);
    assert.equal(parseOid('main').ok, false);

    const zero = verify(ZERO_OID);
    assert.equal(zero.status, 0, zero.stderr);
    assert.equal(zero.stdout.trim(), ZERO_OID);
    assert.equal(parseOid(ZERO_OID).ok, true);
    assert.equal(parseCommitId(ZERO_OID).ok, false);
    assert.notEqual(verify(`${ZERO_OID}^{object}`).status, 0);
    assert.notEqual(verify(`${ZERO_OID}^{commit}`).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
