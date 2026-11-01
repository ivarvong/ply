// Command oids on a push (#81, the planPush site the push-outcome space owns). Every pair of six shapes, judged
// against one `git receive-pack --stateless-rpc` each. ply accepts only lowercase 40-hex; git accepts any case of
// 40 hex, so an uppercase oid is a typed bad_request before the wire (format.ts: uppercase is not an object id here).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pkt, FLUSH } from '../../src/pktline.js';
import { concat, te } from '../../src/bytes.js';
import { planPush } from '../../src/push.js';
import { DEFAULT_LIMITS } from '../../src/limits.js';
import { createHash } from 'node:crypto';

const ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000' };
const ZERO = '0'.repeat(40);
const LOWER = /^[0-9a-f]{40}$/u;
const ANY_CASE = /^[0-9a-fA-F]{40}$/u;

test('push command oids: 6 × 6 shapes, ply against receive-pack', () => {
  const root = mkdtempSync(join(tmpdir(), 'ply-oid-'));
  try {
    const dir = join(root, 'srv.git');
    spawnSync('git', ['init', '-q', '--bare', dir], { env: ENV });
    const tree = spawnSync('git', ['mktree'], { cwd: dir, env: ENV, input: '' }).stdout.toString().trim();
    const commit = spawnSync('git', ['commit-tree', tree, '-m', 'c'], { cwd: dir, env: ENV }).stdout.toString().trim();
    assert.match(commit, LOWER);
    const shapes = [
      ['lower', commit],
      ['upper', commit.toUpperCase()],
      ['len39', commit.slice(0, 39)],
      ['len41', `${commit}a`],
      ['nonhex', `g${commit.slice(1)}`],
      ['empty', ''],
    ];
    const head = new Uint8Array(12); head.set(te.encode('PACK')); head[7] = 2;
    const pack = concat([head, new Uint8Array(createHash('sha1').update(head).digest())]);
    let cells = 0, disagreed = 0;
    for (const [oldTag, oldOid] of shapes) for (const [newTag, newOid] of shapes) {
      const where = `${oldTag}/${newTag}`;
      const ref = `refs/heads/c${cells}`;
      const planned = planPush({ ref, oldOid, newOid }, DEFAULT_LIMITS);
      const plyOk = planned.ok;
      if (!plyOk) {
        assert.equal(planned.error.code, 'bad_request', where);
        assert.equal(planned.error.message, 'push: oids must be 40-hex', where);
      }
      assert.equal(plyOk, LOWER.test(oldOid) && LOWER.test(newOid), where);
      const line = pkt(te.encode(`${oldOid} ${newOid} ${ref}\0report-status\n`));
      const git = spawnSync('git', ['receive-pack', '--stateless-rpc', dir], { env: ENV, input: concat([line, FLUSH, ...(newOid === ZERO ? [] : [pack])]) });
      const gitOk = ANY_CASE.test(oldOid) && ANY_CASE.test(newOid);
      if (gitOk) {
        assert.equal(git.status, 0, `${where}: ${git.stderr}`);
        assert.match(git.stdout.toString(), /unpack ok\n/u, where);
      } else {
        assert.equal(git.status, 128, where);
        assert.match(git.stderr.toString(), /protocol error: expected old\/new\/ref/u, where);
      }
      if (gitOk && !plyOk) disagreed++;
      cells++;
    }
    assert.equal(cells, 36);
    // upper × {lower, upper} on either side, except lower/lower: 4 − 1 = 3
    assert.equal(disagreed, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
