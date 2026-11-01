// Issue #141. pushTree had no total-bytes cap: three 48 MiB blobs reached about 440 MB RSS, and the
// per-file cap still allowed them (each is under 64 MiB). The sum is refused in validateTreeSpec, before
// buildTree, as limit_exceeded. One 64 MiB blob stays inside the cap, and git mktree hashes the same tree.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { LIMIT_OBJECT, LIMIT_PUSH_BYTES } from '../src/limits.js';
import { gitBuf, tmpRoot } from './server.js';

const MIB = 1024 * 1024;
const THREE = 48 * MIB;
// Measured with the bytes resident: one 64 MiB blob about 158 MB RSS, the three-blob refusal about 238 MB.
// The uncapped push of the same three blobs was about 440 MB. Headroom for CI.
const RSS_BOUND_MB = 320;

const runChild = kind => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    '--max-old-space-size=128', '--import', './test/ts-resolve.mjs',
    'test/push-budget-child.mjs', kind,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  let err = '';
  child.stdout.on('data', d => out.push(d));
  child.stderr.on('data', d => { err += d; });
  child.on('close', status => {
    const text = Buffer.concat(out).toString();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* OOM prints no JSON */ }
    resolve({ status, parsed, err, text });
  });
  child.on('error', reject);
});

test('one 64 MiB blob matches git mktree; three 48 MiB blobs are limit_exceeded under a 128 MiB heap', async () => {
  const { root, cleanup } = tmpRoot();
  try {
    const one = await runChild('one');
    const three = await runChild('three');
    assert.equal(one.status, 0, one.err);
    assert.equal(one.parsed?.status, 'ok', one.text || one.err);
    assert.ok(one.parsed.rss < RSS_BOUND_MB, `one rss ${one.parsed.rss}`);
    gitBuf(root, ['init']);
    const blob = Buffer.alloc(LIMIT_OBJECT, 7);
    const oid = gitBuf(root, ['hash-object', '-w', '--stdin'], blob).toString().trim();
    const tree = gitBuf(root, ['mktree'], Buffer.from(`100644 blob ${oid}\tbig.bin\n`)).toString().trim();
    assert.equal(one.parsed.blob, oid);
    assert.equal(one.parsed.root, tree);

    assert.equal(three.status, 0, three.err);
    assert.equal(three.parsed?.status, 'err', three.text || three.err);
    assert.equal(three.parsed.code, 'limit_exceeded');
    assert.equal(three.parsed.what, 'push bytes');
    assert.equal(three.parsed.got, THREE * 3);
    assert.equal(three.parsed.max, LIMIT_PUSH_BYTES);
    assert.ok(THREE * 3 > LIMIT_PUSH_BYTES);
    assert.ok(three.parsed.rss < RSS_BOUND_MB, `three rss ${three.parsed.rss}`);
  } finally {
    cleanup();
  }
});
