// Measure the streamed blob phase's CPU rate (bytes/ms): scanStep + pure-JS Sha1.update over DecompressionStream-sized
// chunks. Workers cannot measure CPU (no clock advances during sync work); this is the number to read `git.edit.blob.inflated` against.
//   node test/calibrate.mjs [--mb 24] [--chunk 16384]
import { scanInit, scanStep, scanFinish } from '../src/edit.js';
import { Sha1 } from '../src/sha1.js';
import { cpuNow, cpuSince } from '../src/otel.js';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : +process.argv[i + 1]; };
const MB = arg('mb', 24), CHUNK = arg('chunk', 16384);
const buf = new Uint8Array(MB << 20); for (let i = 0; i < buf.length; i += 4096) buf.set(new TextEncoder().encode(`line ${i}\n`), i); buf.set(new TextEncoder().encode('MARK'), buf.length >> 1);
const find = new TextEncoder().encode('MARK'), replace = new TextEncoder().encode('WD');
const rates = [];
for (let run = 0; run < 5; run++) {
  let scan = scanInit({ find, replace }); const sha = new Sha1();
  const c0 = cpuNow(), t0 = performance.now();
  for (let o = 0; o < buf.length; o += CHUNK) { const r = scanStep(scan, buf.subarray(o, o + CHUNK)); scan = r.state; for (const p of r.emit) sha.update(p); }
  const f = scanFinish(scan); for (const p of f.emit) sha.update(p); sha.hex();
  const cpu = cpuSince(c0), wall = performance.now() - t0;
  rates.push(buf.length / cpu);
  console.log(`run ${run}: ${MB} MiB in ${cpu.toFixed(1)} ms cpu / ${wall.toFixed(1)} ms wall → ${Math.round(buf.length / cpu).toLocaleString()} B/ms (matches=${scan.count})`);
}
const med = rates.sort((a, b) => a - b)[2];
console.log(`median ${Math.round(med).toLocaleString()} B/ms`);
