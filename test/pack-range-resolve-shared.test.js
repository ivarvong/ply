// resolvePackRange on many REF_DELTAs sharing one base (#299 item 1). One blob and m identity REF deltas on it (each
// resolves to the same blob) took 0.28 s at m = 2,000 and 15.9 s at m = 16,000 under DEFAULT_LIMITS: each delta looked
// its base id's REF run up again with a linear walk to its end, and each delta (it rests on nothing new, its id is the
// base's) was pushed and popped and walked that run once more. The work charged stayed 10 m + 6, so the budget never
// refused. Oracles: node:zlib and node:crypto for the pack bytes, `git index-pack` + `git show-index` + `git hash-object`
// for what the pack holds, and the charge model at the top of src/packrangeresolve.ts for the work, worked out by hand below.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanPackIndex } from '../src/packscanindex.js';
import { resolvePackRange, NO_BASE } from '../src/packrangeresolve.js';
import { rangeFromBytes } from '../src/rangesource.js';
import { git, gitBuf, tmpRoot } from './server.js';

const cat = ps => { const o = new Uint8Array(ps.reduce((a, p) => a + p.length, 0)); let at = 0; for (const p of ps) { o.set(p, at); at += p.length; } return o; };
// gitformat-pack: type in bits 4..6 of the first byte, size in 4 then 7-bit groups
function hdr(type, size) { const out = []; let b = (type << 4) | (size & 15); size = Math.floor(size / 16); while (size > 0) { out.push(b | 0x80); b = size & 0x7f; size = Math.floor(size / 128); } out.push(b); return Uint8Array.from(out); }
const data = new TextEncoder().encode('hello\n');
const oid = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest();
const oidHex = Buffer.from(oid).toString('hex');
// gitformat-pack delta: source size 6, result size 6, copy offset 0 size 6 (0x90: size byte 0 present) = identity
const delta = Uint8Array.from([6, 6, 0x90, 6]);
function sharedPack(m) {
  const parts = [Uint8Array.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, ((m + 1) >>> 24) & 255, ((m + 1) >>> 16) & 255, ((m + 1) >>> 8) & 255, (m + 1) & 255]), hdr(3, 6), deflateSync(data)];
  const body = deflateSync(delta);
  for (let i = 0; i < m; i++) parts.push(hdr(7, delta.length), oid, body);
  const all = cat(parts);
  return cat([all, createHash('sha1').update(all).digest()]);
}
const streamOf = bytes => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
async function resolve(pack) {
  const idx = await scanPackIndex(streamOf(pack));
  assert.ok(idx.ok, idx.ok ? '' : idx.error.message);
  return resolvePackRange(idx.value, rangeFromBytes(pack));
}

test('m REF deltas on one base resolve to what git index-pack makes of the pack', async () => {
  const m = 64;
  const pack = sharedPack(m);
  const { root, cleanup } = tmpRoot();
  try {
    const repo = join(root, 'r.git');
    git(root, ['init', '-q', '--bare', repo]);
    const file = join(repo, 'objects', 'pack', 'pack-shared.pack');
    writeFileSync(file, pack);
    // index-pack takes a pack holding one object many times (verify-pack refuses it, "appears twice")
    git(repo, ['index-pack', file]);
    // show-index: offset sha1 (crc), one line per entry
    const byOffset = gitBuf(repo, ['show-index'], readFileSync(file.replace(/\.pack$/u, '.idx'))).toString().trim().split('\n').map(l => l.split(' ')).toSorted((a, b) => Number(a[0]) - Number(b[0]));
    assert.equal(byOffset.length, m + 1);
    assert.equal(gitBuf(root, ['hash-object', '--stdin'], data).toString().trim(), oidHex);
    const r = await resolve(pack);
    assert.ok(r.ok, r.ok ? '' : r.error.message);
    assert.equal(r.value.count, m + 1);
    for (let i = 0; i <= m; i++) {
      assert.equal(r.value.oid(i).value, byOffset[i][1], `entry ${i} oid`);
      assert.equal(r.value.type(i).value, 3, `entry ${i} type`);
      // by hand: every delta names the blob (entry 0) by id
      assert.equal(r.value.columns.depth[i], i === 0 ? 0 : 1, `entry ${i} depth`);
      assert.equal(r.value.columns.base[i], i === 0 ? NO_BASE : 0, `entry ${i} base`);
      assert.equal(r.value.columns.size[i], 6, `entry ${i} size`);
    }
    assert.equal(byOffset[0][1], oidHex);
  } finally {
    cleanup();
  }
});

test('the work charged for m shared-base REF deltas is 11 m + 6, worked out by hand', async () => {
  // the blob inflated once (6); each delta inflated (4) and applied (6), and visited once as a child of its base (1)
  for (const m of [1, 10, 1000]) {
    const r = await resolve(sharedPack(m));
    assert.ok(r.ok, r.ok ? '' : r.error.message);
    assert.equal(r.value.stats.work, 11 * m + 6, `m=${m}`);
  }
});

test('resolving m REF deltas on one base is linear-ish: 4 x the deltas take at most 6 x the time', { timeout: 120_000 }, async () => {
  const time = async m => {
    const pack = sharedPack(m);
    const idx = await scanPackIndex(streamOf(pack));
    assert.ok(idx.ok);
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      // oxlint-disable-next-line no-await-in-loop -- timed runs, in turn
      const r = await resolvePackRange(idx.value, rangeFromBytes(pack));
      best = Math.min(best, performance.now() - t0);
      assert.ok(r.ok);
    }
    return best;
  };
  await time(500);
  const small = await time(2000);
  const big = await time(8000);
  console.log(JSON.stringify({ small, big, ratio: big / small }));
  assert.ok(big / small <= 6, `m=2,000 ${small.toFixed(0)} ms, m=8,000 ${big.toFixed(0)} ms: ratio ${(big / small).toFixed(2)}`);
});
