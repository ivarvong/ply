// Heap sweep for the stream bound. The vitest parent only spawns this file: importing the inflater from the
// test would make the mutation run execute the sweep once per covered line.
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { concat } from '../../src/bytes.js';
import { inflate, inflateInit, inflateFeed, inflatePull, inflateEnd, declaredBound, zlibWrap } from '../../src/inflatestream.js';
import { parsePackInit, parsePackFeed, parsePackClose, parsePackPull, parsePackEnd, packScanOpts } from '../../src/packstream.js';
import { encodeObjHeader } from '../../src/pack.js';
import { parsePack } from '../../src/packresolve.js';
import { TYPE } from '../../src/objects.js';
import { DEFAULT_LIMITS } from '../../src/limits.js';
import { peakBound } from '../../src/streambound.js';
import { Sha1 } from '../../src/sha1.js';
import { PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, INFLATE_CHUNK } from '../../src/format.js';

const SIZE = DEFAULT_LIMITS.maxObjectSize;
const BLOCK = INFLATE_CHUNK;
const COUNT = DEFAULT_LIMITS.maxPackObjects;
const ADLER_MOD = 65521;
const FILL = 7;

function sample() {
  global.gc();
  global.gc();
  const m = process.memoryUsage();
  return { ab: m.arrayBuffers, rss: m.rss, heap: m.heapUsed };
}
function must(r) {
  if (r.ok) return r.value;
  throw new Error(`${r.error.code}: ${r.error.message}`);
}
function packHead(count) {
  const b = new Uint8Array(PACK_HEADER_BYTES);
  b.set(PACK_SIGNATURE);
  const view = new DataView(b.buffer);
  view.setUint32(PACK_SIGNATURE.length, PACK_VERSION);
  view.setUint32(PACK_SIGNATURE.length + 4, count);
  return b;
}
function adlerStep(a, b, n) {
  const tri = (n * (n + 1)) / 2;
  return { a: (a + n * FILL) % ADLER_MOD, b: (b + n * a + FILL * tri) % ADLER_MOD };
}
function feedStored(size, block, onBytes) {
  onBytes(Uint8Array.of(0x78, 0x01));
  let a = 1;
  let b = 0;
  let left = size;
  while (left > 0) {
    const n = Math.min(block, left);
    const nlen = (~n) & 0xffff;
    onBytes(Uint8Array.of(n === left ? 1 : 0, n & 0xff, (n >> 8) & 0xff, nlen & 0xff, (nlen >> 8) & 0xff));
    const data = new Uint8Array(n);
    data.fill(FILL);
    onBytes(data);
    const next = adlerStep(a, b, n);
    a = next.a;
    b = next.b;
    left -= n;
  }
  const tail = new Uint8Array(4);
  new DataView(tail.buffer).setUint32(0, ((b << 16) | a) >>> 0);
  onBytes(tail);
}
function openInflate(size) {
  return must(inflateInit({ bound: declaredBound(size), wrap: zlibWrap(true) }));
}
function selfCheck() {
  const parts = [];
  feedStored(96, 32, bytes => parts.push(bytes));
  const out = inflate(concat(parts), 0, { bound: declaredBound(96), wrap: zlibWrap(true) });
  assert.equal(out.out.length, 96);
  assert.equal(out.out[0], FILL);
  assert.equal(out.out[95], FILL);
}

function drop(size) {
  selfCheck();
  const before = sample();
  let peak = before.ab;
  const note = () => { const s = sample(); if (s.ab > peak) peak = s.ab; };
  const st = openInflate(size);
  let produced = 0;
  let ended = false;
  feedStored(size, BLOCK, bytes => {
    if (ended) return;
    inflateFeed(st, bytes);
    for (;;) {
      const step = inflatePull(st);
      if (!step.ok) throw new Error(step.error.message);
      if (step.value.kind === 'need') break;
      if (step.value.kind === 'chunk') { produced += step.value.bytes.length; continue; }
      ended = true;
      assert.equal(step.value.consumed > 0, true);
      break;
    }
    note();
  });
  if (!ended) {
    const step = must(inflateEnd(st));
    if (step.kind === 'chunk') produced += step.bytes.length;
    assert.equal(step.kind === 'end' || step.kind === 'chunk', true);
  }
  note();
  assert.equal(produced, size);
  const bound = peakBound({ kind: 'inflate' });
  const abDelta = peak - before.ab;
  assert.ok(abDelta <= bound, `arrayBuffers delta ${abDelta} exceeds inflate bound ${bound}`);
  return { abDelta, bound, rss: sample().rss, heap: sample().heap };
}

function materialize(size) {
  selfCheck();
  const out = new Uint8Array(size);
  const before = sample();
  let peak = before.ab;
  const note = () => { const s = sample(); if (s.ab > peak) peak = s.ab; };
  const st = openInflate(size);
  let at = 0;
  let ended = false;
  feedStored(size, BLOCK, bytes => {
    if (ended) return;
    inflateFeed(st, bytes);
    for (;;) {
      const step = inflatePull(st);
      if (!step.ok) throw new Error(step.error.message);
      if (step.value.kind === 'need') break;
      if (step.value.kind === 'chunk') {
        out.set(step.value.bytes, at);
        at += step.value.bytes.length;
        continue;
      }
      ended = true;
      break;
    }
    note();
  });
  note();
  assert.equal(at, size);
  assert.equal(out[0], FILL);
  assert.equal(out[size - 1], FILL);
  const bound = peakBound({ kind: 'inflate' });
  const abDelta = peak - before.ab;
  assert.ok(abDelta <= bound, `materialize arrayBuffers delta ${abDelta} exceeds inflate bound ${bound} (output was allocated before the sample)`);
  return { abDelta, bound, rss: sample().rss, heap: sample().heap };
}

function beforeInflate(size) {
  const raw = Buffer.alloc(size, FILL);
  const z = zlib.deflateSync(raw, { level: 0 });
  const before = sample();
  const out = inflate(new Uint8Array(z), 0, { bound: declaredBound(size), wrap: zlibWrap(true) });
  const after = process.memoryUsage();
  assert.equal(out.out.length, size);
  assert.equal(out.out[0], FILL);
  return {
    abDelta: after.arrayBuffers - before.ab,
    ab: after.arrayBuffers,
    zlib: z.length,
    rss: after.rss,
    heap: after.heapUsed,
    bound: peakBound({ kind: 'fetch-object', output: size }),
  };
}

function oneBlob() {
  return concat([encodeObjHeader(TYPE.BLOB, 1), new Uint8Array(zlib.deflateSync(Buffer.from([1]), { level: 0 }))]);
}
function scan(count) {
  const one = oneBlob();
  const before = sample();
  let peak = before.ab;
  const note = () => { const s = sample(); if (s.ab > peak) peak = s.ab; };
  const st = must(parsePackInit(packScanOpts()));
  const head = packHead(count);
  const sha = new Sha1();
  sha.update(head);
  parsePackFeed(st, head);
  assert.equal(must(parsePackPull(st)).kind, 'header');
  for (let i = 0; i < count; i++) {
    sha.update(one);
    parsePackFeed(st, one);
    for (;;) {
      const step = parsePackPull(st);
      if (!step.ok) throw new Error(step.error.message);
      if (step.value.kind === 'need' || step.value.kind === 'object-end') break;
    }
    if (i % 1000 === 0) note();
  }
  const trailer = sha.digest();
  parsePackFeed(st, trailer);
  parsePackClose(st);
  assert.equal(must(parsePackPull(st)).kind, 'trailer');
  assert.equal(must(parsePackEnd(st)).kind, 'end');
  note();
  const bound = peakBound({ kind: 'pack-scan' });
  const abDelta = peak - before.ab;
  assert.ok(abDelta <= bound, `pack scan arrayBuffers delta ${abDelta} exceeds bound ${bound}`);
  return { abDelta, bound, rss: sample().rss, heap: sample().heap, count };
}
function beforePack(count) {
  const one = oneBlob();
  const body = new Uint8Array(PACK_HEADER_BYTES + one.length * count);
  body.set(packHead(count));
  for (let i = 0; i < count; i++) body.set(one, PACK_HEADER_BYTES + i * one.length);
  const pack = concat([body, new Sha1().update(body).digest()]);
  const before = sample();
  const parsed = parsePack(pack);
  const after = process.memoryUsage();
  assert.equal(parsed.objects.length, count);
  return { abDelta: after.arrayBuffers - before.ab, ab: after.arrayBuffers, rss: after.rss, heap: after.heapUsed, count, pack: pack.length };
}

const mode = process.argv[2];
const started = sample();
let report;
if (mode === 'before-inflate') report = beforeInflate(SIZE);
else if (mode === 'drop') report = drop(SIZE);
else if (mode === 'materialize') report = materialize(SIZE);
else if (mode === 'before-pack') report = beforePack(COUNT);
else if (mode === 'scan') report = scan(COUNT);
else throw new Error(`unknown mode ${mode}`);
console.log(JSON.stringify({ mode, ...report, baseRss: started.rss }));
