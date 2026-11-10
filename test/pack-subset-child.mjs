// One packSubset of a synthetic pack far larger than what is held (test/pack-subset.test.js), under --expose-gc. The
// source is N copies of one stored-zlib blob entry, served as views of that one entry's bytes, so the source itself
// holds one entry; the index comes from scanPackIndex over the same bytes. Every other entry is selected and the result
// drained slowly. The peak is sampled after a full GC every 50 ms. Prints one JSON line.
//   node --expose-gc --import ./test/ts-resolve.mjs test/pack-subset-child.mjs <blob bytes> <entries>
import { deflateSync } from 'node:zlib';
import { packSubset } from '../src/packsubset.js';
import { scanPackIndex } from '../src/packscanindex.js';
import { encodeObjHeader, packHeader } from '../src/pack.js';
import { TYPE } from '../src/objects.js';
import { concat } from '../src/bytes.js';

const [blobBytes, count] = process.argv.slice(2).map(Number);
const blob = new Uint8Array(blobBytes);
for (let i = 0; i < blob.length; i++) blob[i] = (i * 2654435761) >>> 24;
const entry = concat([encodeObjHeader(TYPE.BLOB, blob.length), new Uint8Array(deflateSync(blob, { level: 0 }))]);
const head = packHeader(count);
const trailer = new Uint8Array(20);
const size = head.length + entry.length * count + trailer.length;
const CHUNK = 64 * 1024;
// the bytes at [offset, offset + length) as views of head, entry and trailer
function* views(offset, length) {
  let at = offset;
  const end = offset + length;
  while (at < end) {
    let part, from;
    if (at < head.length) { part = head; from = at; } else if (at >= size - trailer.length) { part = trailer; from = at - (size - trailer.length); } else { part = entry; from = (at - head.length) % entry.length; }
    const n = Math.min(end - at, part.length - from, CHUNK);
    yield part.subarray(from, from + n);
    at += n;
  }
}
const streamOf = (offset, length) => {
  const it = views(offset, length);
  return new ReadableStream({ pull(c) { const r = it.next(); if (r.done) c.close(); else c.enqueue(r.value); } }, { highWaterMark: 0 });
};
const source = { size, read: async (offset, length) => ({ ok: true, value: streamOf(offset, length) }) };
const scanned = await scanPackIndex(streamOf(0, size), { verify: false, oids: false });
if (!scanned.ok) { process.stdout.write(`${JSON.stringify({ ok: false, error: scanned.error.message })}\n`); process.exit(0); }
const idx = scanned.value;
const selection = [...Array(count).keys()].filter(i => i % 2 === 0);
globalThis.gc(); globalThis.gc();
const base = process.memoryUsage();
let peak = base.arrayBuffers, samples = 0;
const timer = setInterval(() => { globalThis.gc(); samples++; peak = Math.max(peak, process.memoryUsage().arrayBuffers); }, 50);
const t0 = performance.now();
const built = await packSubset(source, idx, selection);
let sent = 0, error = null;
if (built.ok) {
  const reader = built.value.stream.getReader();
  try {
    for (let k = 0; ; k++) {
      const r = await reader.read();
      if (r.done) break;
      sent += r.value.length;
      if (k % 64 === 0) await new Promise(resolve => setTimeout(resolve, 1));
    }
  } catch (e) { error = e.message; }
}
const ms = performance.now() - t0;
clearInterval(timer);
process.stdout.write(`${JSON.stringify({
  ok: built.ok && error === null, error: built.ok ? error : built.error.message, sourceBytes: size, length: built.ok ? built.value.length : null,
  sent, ms: Math.round(ms), mbPerS: Math.round(sent / 1e6 / (ms / 1000)), samples, liveDelta: peak - base.arrayBuffers,
})}\n`);
