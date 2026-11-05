// The memory bound of the pull codecs and of fetchSingle, fetchWide, fetchPack and inflate() on them (issue #172), measured: each cell is its own process
// (test/stream/cell.mjs, --expose-gc) under a 64 MiB and a 128 MiB V8 heap, its input generated as it is read, and the
// peak of live arrayBuffers over the cell (a gc at every sample) compared with streambound.ts. The parent does not import
// src/, so a mutation run does not re-run the cells for every covered line.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const MIB = 1024 * 1024;
const HOLD = 32_768 + 16_384 + 65_520; // INFLATE_WINDOW + INFLATE_CHUNK + PKT_MAX_SIZE (format.ts; peakBound 'inflate')
const PKT = 65_520;
function cell(mode, size, heap) {
  const r = spawnSync(process.execPath, ['--expose-gc', `--max-old-space-size=${heap}`, '--import', './test/ts-resolve.mjs', 'test/stream/cell.mjs', mode, String(size)], { encoding: 'utf8', env: process.env, maxBuffer: 1 << 20 });
  assert.equal(r.status, 0, `${mode} ${size} heap ${heap}: exit ${r.status}\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

for (const heap of [64, 128]) {
  test(`heap ${heap} MiB: a 64 MiB member inflated chunk by chunk holds the window and a chunk, not the object`, () => {
    const r = cell('inflate-drop', 64 * MIB, heap);
    console.log(JSON.stringify(r));
    assert.equal(r.bound, HOLD);
    assert.ok(r.abDelta <= r.bound, `inflate held ${r.abDelta} > ${r.bound}`);
  });
  test(`heap ${heap} MiB: a pack of 100,000 one-byte blobs scanned object by object holds one inflate record`, () => {
    const r = cell('scan-drop', 100_000, heap);
    console.log(JSON.stringify(r));
    assert.ok(r.abDelta <= HOLD, `scan held ${r.abDelta} > ${HOLD}`);
  });
  test(`heap ${heap} MiB: inflate() of a 64 MiB member in hand holds the output and the pull's hold, nothing more`, () => {
    for (const mode of ['inflate-whole', 'inflate-capped']) {
      const r = cell(mode, 64 * MIB, heap);
      console.log(JSON.stringify(r));
      assert.ok(r.abDelta >= 64 * MIB, `${mode}: the output is held`);
      assert.ok(r.abDelta <= 64 * MIB + HOLD, `${mode}: inflate() held ${r.abDelta} > ${64 * MIB} + ${HOLD}`);
    }
  });
  test(`heap ${heap} MiB: a wide fetch (fetchWide, fetchPack) that retains R bytes of a pack of 2,000 trees holds R and the inflate hold, not the pack`, () => {
    const drain = cell('fetch-wide-drain', 2000, heap);
    for (const mode of ['fetch-wide', 'fetch-wide-blobs', 'fetch-pack']) {
      const r = cell(mode, 2000, heap);
      console.log(JSON.stringify({ ...r, drain: drain.abDelta }));
      // what reading the response costs is the transport's (fetch-wide-drain); the fetch adds what it retains (the trees:
      // the blobs of fetch-wide-blobs are dropped as their headers arrive) and the scan's inflate hold
      assert.ok(r.abDelta >= r.retained, `${mode}: the trees are held`);
      assert.ok(r.abDelta - drain.abDelta <= r.bound, `${mode}: added ${r.abDelta - drain.abDelta} > R ${r.retained} + ${HOLD}`);
    }
  });
  test(`heap ${heap} MiB: fetchObject of a 48 MiB blob holds the blob and the inflate hold; before #172 it held the member twice more`, () => {
    const size = 48 * MIB;
    const drain = cell('fetch-drain', size, heap);
    const streamed = cell('fetch-object', size, heap);
    const buffered = cell('fetch-buffered', size, heap);
    console.log(JSON.stringify({ drain, streamed, buffered }));
    // what reading the response costs (the generator's frames, the body chunk, the copied pkt payload) is the
    // transport's; fetchSingle adds the object, the inflate hold, and spStep's join of the trailer lag and one frame
    const added = streamed.abDelta - drain.abDelta;
    assert.ok(added <= size + HOLD + PKT, `fetchSingle added ${added} > ${size} + ${HOLD} + ${PKT}`);
    assert.ok(added >= size, 'the blob itself is held');
    assert.ok(buffered.abDelta >= 3 * size, `the buffered read held ${buffered.abDelta}: the member, its join, and the object`);
    assert.ok(streamed.rss < buffered.rss, `rss ${streamed.rss} vs buffered ${buffered.rss}`);
  });
}
