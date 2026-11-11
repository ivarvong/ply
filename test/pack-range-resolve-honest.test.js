// Honest history under both presets (owner decision 1 of the resolve work ceiling): this repository's own pack, built
// read-only by `git pack-objects --revs --stdout` from HEAD, resolves under DEFAULT_LIMITS and under WORKER_LIMITS, and
// every object's oid, type and size is what `git index-pack` + `git verify-pack -v` say of the same bytes.
//
// Measured on fbbf5d2 (node 24, git 2.50.0), work = bytes inflated + delta results made, the same under both presets:
//   this repository, HEAD history (this test)   3,872 objects (2,985 deltas), 3,307,891 pack bytes, work 69,665,726
//   this repository, every ref (the reviewer's)  7,541 objects, 7,852,523 pack bytes, work 109,854,403
//   an 18 MB pack of this repository, the largest real pack in the session scratch (a clone's own packfile, mostly
//   whole objects)                              3,500 objects, 18,028,461 pack bytes, work 4,734,753
// all ok under both presets, against ceilings of 2,147,483,648 (DEFAULT_LIMITS.maxResolveWork) and 536,870,912
// (WORKER_LIMITS.maxResolveWork). No clone of git.git or another larger real repository was at hand, so nothing larger
// was measured. Work counts what resolving reads back: deltas and the bases they rest on, not whole objects nothing
// rests on, so it is at least the bytes of the objects git stored as deltas (62,663,356 here).
// A shallow checkout packs less; the oracle is git on the same bytes, so the test holds for whatever HEAD reaches.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanPackIndex } from '../src/packscanindex.js';
import { resolvePackRange } from '../src/packrangeresolve.js';
import { rangeFromBytes } from '../src/rangesource.js';
import { DEFAULT_LIMITS, WORKER_LIMITS } from '../src/limits.js';

const TYPE = { commit: 1, tree: 2, blob: 3, tag: 4 };
const streamOf = bytes => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });

test('this repository\'s own history resolves under DEFAULT_LIMITS and WORKER_LIMITS to the objects git finds in the same pack', { timeout: 600_000 }, async () => {
  const pack = new Uint8Array(execFileSync('git', ['pack-objects', '--revs', '--stdout', '--delta-base-offset', '-q'], { input: 'HEAD\n', maxBuffer: 1 << 30 }));
  const dir = mkdtempSync(join(tmpdir(), 'ply-resolve-honest-'));
  let inPack;
  try {
    writeFileSync(join(dir, 'p.pack'), pack);
    execFileSync('git', ['index-pack', '-o', join(dir, 'p.idx'), join(dir, 'p.pack')]);
    const listing = execFileSync('git', ['verify-pack', '-v', join(dir, 'p.idx')], { encoding: 'utf8', maxBuffer: 1 << 30 });
    // "<oid> <type> <size> <bytes in pack> <offset> [<depth> <base>]": one line per object, the last two on a delta.
    // The size there is the delta's own, so each object's size is asked of the repository below.
    inPack = [...listing.matchAll(/^([0-9a-f]{40}) (?:commit|tree|blob|tag) +\d+ \d+ \d+( \d+ [0-9a-f]{40})?$/gmu)].map(m => ({ oid: m[1], delta: m[2] !== undefined }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(inPack.length, new DataView(pack.buffer, pack.byteOffset).getUint32(8), 'git listed every object the pack header counts');
  const sized = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: `${inPack.map(o => o.oid).join('\n')}\n`, encoding: 'utf8', maxBuffer: 1 << 30 }).trim().split('\n');
  const want = sized.map(line => { const [oid, type, size] = line.split(' '); return { oid, type: TYPE[type], size: Number(size) }; });
  assert.equal(want.length, inPack.length);
  const key = o => `${o.oid} ${o.type} ${o.size}`;
  const wantKeys = want.map(key).sort();
  // every delta's result is made at least once, so the work is at least the bytes of the objects git stored as deltas
  const deltaBytes = want.reduce((a, o, i) => a + (inPack[i].delta ? o.size : 0), 0);
  for (const [name, limits] of [['DEFAULT_LIMITS', DEFAULT_LIMITS], ['WORKER_LIMITS', WORKER_LIMITS]]) {
    const idx = await scanPackIndex(streamOf(pack), { limits });
    assert.equal(idx.ok, true, idx.ok ? '' : `${name} scan: ${idx.error.message}`);
    const r = await resolvePackRange(idx.value, rangeFromBytes(pack), { limits });
    assert.equal(r.ok, true, r.ok ? '' : `${name}: ${r.error.code}: ${r.error.message}`);
    const got = Array.from({ length: r.value.count }, (_, i) => key({ oid: r.value.oid(i).value, type: r.value.type(i).value, size: r.value.columns.size[i] }));
    assert.deepEqual(got.sort(), wantKeys, `${name}: oid, type and size of every object`);
    assert.ok(r.value.stats.work >= deltaBytes, `${name}: work ${r.value.stats.work} under the ${deltaBytes} bytes of deltified objects`);
    assert.ok(r.value.stats.work <= limits.maxResolveWork, `${name}: work ${r.value.stats.work} past the ceiling`);
    console.log(JSON.stringify({ preset: name, objects: r.value.count, packBytes: pack.length, deltas: inPack.filter(o => o.delta).length, deltaBytes, work: r.value.stats.work, workMax: r.value.stats.workMax, ceiling: limits.maxResolveWork }));
  }
});
