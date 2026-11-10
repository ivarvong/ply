// One memory cell of test/stream-memory.test.js, in its own process (test/memcell.js's flags, and the heap the parent
// picks). The input is generated as it is read by the plain iterators of test/stream/pieces.mjs, which keep no piece once
// it is handed over (a generator's frame does on node 22: #249), so the cell measures what ply holds. After a gc at
// every sample point (array buffers swept with it, not on a background thread), the peak of process.memoryUsage().arrayBuffers over the cell, less the value before it,
// is the bytes the code under test kept alive (Uint8Arrays sit outside the V8 heap --max-old-space-size caps). One
// JSON line on stdout.
//
//   inflate-drop     a stored zlib member of SIZE bytes, every chunk dropped                 bound: peakBound(inflate)
//   scan-drop        a pack of COUNT 1-byte blobs, scanned, every object dropped             bound: peakBound(pack-scan)
//   scan-work        a pack of 3 x SIZE stored blobs of SIZE/1 MiB chunks under WORK_BUDGET, default caps, every chunk dropped  bound: peakBound(pack-scan)
//   scan-index       scanPackIndex of a pack of COUNT 1-byte blobs, oids on                  bound: peakBound(pack-scan) + its columns
//   scan-index-big   scanPackIndex of 3 x SIZE stored blobs, default caps, oids on           bound: peakBound(pack-scan)
//   scan-iter        scanPack (#241) of 3 x SIZE stored blobs under WORK_BUDGET, every piece dropped  bound: peakBound(pack-scan)
//   inflate-iter     inflateChunks (#241) of a SIZE-byte stored member from a ReadableStream       bound: peakBound(inflate)
//   pkt-iter         pktFrames (#241) of SIZE max-size data frames, every frame dropped           bound: peakBound(pkt)
//   fetch-object     fetchObject of a SIZE-byte blob through the http transport (fetchSingle) bound: peakBound(fetch-object)
//   fetch-drain      the same response with every pack chunk dropped: the transport's own share
//   fetch-buffered   the same bytes read the way fetchSingle did before #172: the zlib member collected, then inflate()
//   inflate-whole    inflate() of a SIZE-byte stored member in hand, with its declared size                  bound: SIZE + peakBound(inflate)
//   inflate-capped   the same without a declared size (the output buffer grows)
//   fetch-wide       fetchObject of a tree through the blob:none fallback (fetchWide): a pack of COUNT 4 KiB trees, every
//                    one retained (checked and harvested)                                                  bound: peakBound(fetch-pack, R)
//   fetch-wide-blobs the same through the unfiltered fallback, the pack also holding COUNT/32 256 KiB blobs the tree want
//                    does not need (R is the trees)
//   fetch-pack       fetchPack of the fetch-wide pack (fetchPackOnce, every object parsed and resolved)      bound: peakBound(fetch-pack, R)
import crypto from 'node:crypto';
import { source, END, seq, once, repeat, sealed, chunked, framed, asAsync, drain } from './pieces.mjs';
import { inflateInit, inflateFeed, inflatePull, inflateEnd, declaredBound, zlibWrap } from '../../src/inflatestream.js';
import { inflate } from '../../src/inflate.js';
import { parsePackInit, parsePackFeed, parsePackPull, parsePackEnd, packScanOpts, WORK_BUDGET } from '../../src/packstream.js';
import { fetchObject, packStream, spInit, spStep, spFinish } from '../../src/fetch.js';
import { fetchPack } from '../../src/fetchpack.js';
import zlib from 'node:zlib';
import { createTransport } from '../../src/http.js';
import { encodeObjHeader } from '../../src/pack.js';
import { concat } from '../../src/bytes.js';
import { TYPE } from '../../src/objects.js';
import { Tracer } from '../../src/otel.js';
import { withLimits, DEFAULT_LIMITS, LIMIT_OBJECT_OVERHEAD } from '../../src/limits.js';
import { peakBound } from '../../src/streambound.js';
import { PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, PKT_MAX_PAYLOAD } from '../../src/format.js';

const [mode, sizeArg] = process.argv.slice(2);
const SIZE = Number(sizeArg);
const STORED = 65_535;
const FEED = 16_384;
const ADLER_MOD = 65_521;

// Samples inside synchronous code too: every SAMPLE_BYTES of new Uint8Arrays (a buffer, not a view) the code under test
// allocates, a sample (gc, then the live arrayBuffers). Without it a cell sees only the points where its input generator
// runs, and a parse that joins the pack after the stream ended peaks between them. ply reads the global `Uint8Array` at
// call time, so the subclass sees its allocations; instanceof still answers for every Uint8Array.
const SAMPLE_BYTES = 256 * 1024;
const NativeU8 = globalThis.Uint8Array;
let measuring = false, sampling = false, allocated = 0;
class SampledU8 extends NativeU8 {
  constructor(...args) {
    super(...args);
    if (measuring && !sampling && typeof args[0] === 'number') {
      allocated += args[0];
      if (allocated >= SAMPLE_BYTES) { allocated = 0; sampling = true; note(); sampling = false; }
    }
  }
  static [Symbol.hasInstance](v) { return v instanceof NativeU8; }
}
globalThis.Uint8Array = SampledU8;

const must = r => { if (r.ok) return r.value; throw new Error(`${r.error.code}: ${r.error.message}`); };
function ab() { global.gc(); global.gc(); return process.memoryUsage().arrayBuffers; }
let base = 0;
let peak = 0;
const note = () => { const a = ab(); if (a > peak) peak = a; };
function start() { base = ab(); peak = base; measuring = true; }

// The blob's bytes from `at`, n of them, in pieces of at most FEED bytes (as a transport hands a body over): a
// pattern, so nothing has to be kept to know them, and the source holds no piece.
function blobBytes(at, n) {
  let off = 0;
  return source(() => {
    if (off >= n) return END;
    const piece = new Uint8Array(Math.min(FEED, n - off));
    for (let i = 0; i < piece.length; i++) { const k = at + off + i; piece[i] = k * 31 + (k >> 9); }
    off += piece.length;
    return piece;
  });
}
// A zlib member of stored blocks over the blob, with its Adler-32, generated as it is read.
function storedMember(size) {
  let a = 1, b = 0;
  const adler = piece => { for (let i = 0; i < piece.length; i++) { a = (a + piece[i]) % ADLER_MOD; b = (b + a) % ADLER_MOD; } return piece; };
  const blocks = Math.ceil(size / STORED);
  const block = j => {
    const at = j * STORED, n = Math.min(STORED, size - at), nlen = (~n) & 0xffff;
    const bytes = blobBytes(at, n);
    return seq([() => once(Uint8Array.of(at + n === size ? 1 : 0, n & 0xff, n >> 8, nlen & 0xff, nlen >> 8)), () => source(() => { const r = bytes.next(); return r.done ? END : adler(r.value); })]);
  };
  const tail = () => { const t = new Uint8Array(4); new DataView(t.buffer).setUint32(0, ((b << 16) | a) >>> 0); return once(t); };
  return seq([
    () => once(Uint8Array.of(0x78, 0x01)),
    ...(size === 0 ? [() => once(Uint8Array.of(1, 0, 0, 0xff, 0xff))] : []),
    () => repeat(blocks, block),
    tail,
  ]);
}
const packHead = count => { const h = new Uint8Array(PACK_HEADER_BYTES); h.set(PACK_SIGNATURE); new DataView(h.buffer).setUint32(4, PACK_VERSION); new DataView(h.buffer).setUint32(8, count); return h; };
function blobOid(size) {
  const h = crypto.createHash('sha1').update(`blob ${size}\0`);
  for (const b of blobBytes(0, size)) h.update(b);
  return h.digest('hex');
}

function inflateDrop() {
  start();
  const st = must(inflateInit({ bound: declaredBound(SIZE), wrap: zlibWrap(true) }));
  let produced = 0, blocks = 0;
  const drain = end => {
    for (;;) {
      const p = must(end ? inflateEnd(st) : inflatePull(st));
      if (p.kind === 'chunk') { produced += p.bytes.length; continue; }
      return p.kind;
    }
  };
  for (const piece of storedMember(SIZE)) {
    inflateFeed(st, piece);
    drain(false);
    if (++blocks % 64 === 0) note();
  }
  if (drain(true) !== 'end' || produced !== SIZE) throw new Error(`inflated ${produced} of ${SIZE}`);
  note();
  return { bound: peakBound({ kind: 'inflate' }), produced };
}

function scanDrop() {
  const count = SIZE;
  const one = concat([encodeObjHeader(TYPE.BLOB, 1), Uint8Array.of(0x78, 0x01, 1, 1, 0, 0xfe, 0xff, 7, 0, 8, 0, 8)]);
  const limits = withLimits({ maxPackObjects: count, maxInflatedTotal: count * (1 + LIMIT_OBJECT_OVERHEAD) });
  start();
  const st = must(parsePackInit(packScanOpts(limits)));
  let objects = 0, fed = 0;
  const body = () => seq([() => once(packHead(count)), () => repeat(count, () => once(one))]);
  for (const piece of sealed(body())) {
    parsePackFeed(st, piece);
    for (;;) {
      const p = must(parsePackPull(st));
      if (p.kind === 'need') break;
      if (p.kind === 'object-end') objects += 1;
    }
    if (++fed % 5000 === 0) note();
  }
  for (let p = must(parsePackEnd(st)); p.kind !== 'end'; p = must(parsePackPull(st))) { /* the trailer */ }
  note();
  if (objects !== count) throw new Error(`scanned ${objects} of ${count}`);
  return { bound: peakBound({ kind: 'pack-scan' }), objects };
}

// A pack past every default cap: three blobs of SIZE, each over maxObjectSize, their total over maxInflatedTotal.
function scanWork() {
  const count = 3;
  start();
  const st = must(parsePackInit(packScanOpts(DEFAULT_LIMITS, false, WORK_BUDGET)));
  let objects = 0, inflated = 0, fed = 0;
  const body = () => bigPack(count, SIZE);
  // in its own function, as inflateDrop: a piece left in this frame's variables is the cell's memory, not the scan's
  const drain = () => {
    for (;;) {
      const p = must(parsePackPull(st));
      if (p.kind === 'need') return;
      if (p.kind === 'chunk') inflated += p.bytes.length;
      if (p.kind === 'object-end') objects += 1;
    }
  };
  for (const piece of sealed(body())) {
    parsePackFeed(st, piece);
    drain();
    if (++fed % 64 === 0) note();
  }
  for (let p = must(parsePackEnd(st)); p.kind !== 'end'; p = must(parsePackPull(st))) { /* the trailer */ }
  note();
  if (objects !== count || inflated !== count * SIZE) throw new Error(`scanned ${objects} objects, ${inflated} bytes`);
  return { bound: peakBound({ kind: 'pack-scan' }), objects, inflated };
}

// A pack of `count` stored blobs of `size` bytes, generated as it is read (no trailer: sealed() adds it).
const bigPack = (count, size) => seq([() => once(packHead(count)), () => repeat(count, () => seq([() => once(encodeObjHeader(TYPE.BLOB, size)), () => storedMember(size)]))]);
// A source that samples every `every` pieces it hands over.
function sampledFeed(src, every) { let fed = 0; return source(() => { const n = src.next(); if (n.done) return END; if (++fed % every === 0) note(); return n.value; }); }
// scanPackIndex (#236) of a pack of COUNT 1-byte blobs, oids on: the scan's hold plus the index's columns.
async function scanIndexCell() {
  const { scanPackIndex, SCAN_INDEX_ENTRY_BYTES } = await import('../../src/packscanindex.js');
  const count = SIZE;
  const one = concat([encodeObjHeader(TYPE.BLOB, 1), Uint8Array.of(0x78, 0x01, 1, 1, 0, 0xfe, 0xff, 7, 0, 8, 0, 8)]);
  const limits = withLimits({ maxPackObjects: count });
  start();
  const src = sampledFeed(chunked(sealed(seq([() => once(packHead(count)), () => repeat(count, () => once(one))])), FEED), 256);
  const t0 = performance.now();
  const got = must(await scanPackIndex(asAsync(src), { limits, oids: true }));
  const ms = performance.now() - t0;
  note();
  if (got.count !== count || got.columns.offset.length !== count) throw new Error(`indexed ${got.columns.offset.length} of ${count}`);
  const keep = got.heldBytes;
  return { bound: peakBound({ kind: 'pack-scan' }), objects: count, heldBytes: keep, perEntry: keep / count, entryBytes: SCAN_INDEX_ENTRY_BYTES, packBytes: got.bytes, ms };
}
// scanPackIndex of three SIZE stored blobs, past every default cap, under its default WORK_BUDGET, oids on: the hold
// stays the scan's whatever the pack's size.
async function scanIndexBigCell() {
  const { scanPackIndex } = await import('../../src/packscanindex.js');
  const count = 3;
  start();
  const src = sampledFeed(sealed(bigPack(count, SIZE)), 64);
  const t0 = performance.now();
  const got = must(await scanPackIndex(asAsync(src), { oids: true }));
  const ms = performance.now() - t0;
  note();
  const first = got.entry(0);
  if (first.tag !== 'some' || first.value.oid !== blobOid(SIZE)) throw new Error('first blob oid differs from its hash');
  return { bound: peakBound({ kind: 'pack-scan' }), objects: count, packBytes: got.bytes, heldBytes: got.heldBytes, ms };
}

// scanPack (#241) over three SIZE stored blobs under WORK_BUDGET, every piece dropped: the adapter holds the scan's hold.
async function scanIterCell() {
  const { scanPack } = await import('../../src/pullstream.js');
  const count = 3;
  start();
  const src = sampledFeed(sealed(bigPack(count, SIZE)), 64);
  let objects = 0, inflated = 0;
  await drain(scanPack(asAsync(src), { budget: WORK_BUDGET }), p => {
    if (p.kind === 'chunk') inflated += p.bytes.length;
    if (p.kind === 'object-end') objects += 1;
  });
  note();
  if (objects !== count || inflated !== count * SIZE) throw new Error(`scanned ${objects} objects, ${inflated} bytes`);
  return { bound: peakBound({ kind: 'pack-scan' }), objects, inflated };
}
// inflateChunks (#241) of a SIZE-byte stored member, from a ReadableStream source, every chunk dropped.
async function inflateIterCell() {
  const { inflateChunks } = await import('../../src/pullstream.js');
  start();
  const src = sampledFeed(storedMember(SIZE), 64);
  const stream = new ReadableStream({ pull(c) { const n = src.next(); if (n.done) c.close(); else c.enqueue(n.value); } }, { highWaterMark: 0 });
  let produced = 0;
  await drain(inflateChunks(stream, { bound: declaredBound(SIZE) }), chunk => { produced += chunk.length; });
  note();
  if (produced !== SIZE) throw new Error(`inflated ${produced} of ${SIZE}`);
  return { bound: peakBound({ kind: 'inflate' }), produced };
}
// pktFrames (#241) over SIZE max-size data frames made as they are read, every frame dropped: one chunk and one frame.
async function pktIterCell() {
  const { pktFrames } = await import('../../src/pullstream.js');
  const room = PKT_MAX_PAYLOAD;
  const te = new TextEncoder();
  const frame = () => { const f = new Uint8Array(4 + room); f.set(te.encode((room + 4).toString(16).padStart(4, '0'))); return f; };
  start();
  const src = sampledFeed(repeat(SIZE, () => once(frame())), 16);
  let frames = 0, bytes = 0;
  await drain(pktFrames(asAsync(src)), f => { frames += 1; bytes += f.payload.length; });
  note();
  if (frames !== SIZE) throw new Error(`framed ${frames} of ${SIZE}`);
  return { bound: peakBound({ kind: 'pkt' }), frames, bytes };
}
// A v2 fetch response carrying the one-object pack, framed into band-1 pkt-lines as it is read.
function responseStream(size) {
  return frameStream(sealed(bigPack(1, size)));
}
// The pieces of a pack framed into a v2 response body, sampled every 16 frames.
function frameStream(pack) {
  const frames = framed(pack, PKT_MAX_PAYLOAD - 1);
  let n = 0;
  return new ReadableStream({ pull(c) { const f = frames.next(); if (f.done) { c.close(); return; } if (++n % 16 === 0) note(); c.enqueue(f.value); } });
}
function transport(size) {
  const fetchImpl = async () => new Response(responseStream(size), { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' } });
  return must(createTransport('https://git.example/repo.git', { tracer: new Tracer(), fetchImpl, quirks: {} }));
}
async function fetchStreamed() {
  const oid = blobOid(SIZE);
  const t = transport(SIZE);
  start();
  const got = must(await fetchObject(t, { oid, filter: '', expectType: TYPE.BLOB }));
  note();
  if (got.data.length !== SIZE) throw new Error(`fetched ${got.data.length}`);
  return { bound: peakBound({ kind: 'fetch-object', output: SIZE }), oid };
}
// The same response read through the transport and v2Step with every pack chunk dropped: what reading the response
// costs before fetchSingle keeps anything (the generator's frame, the body chunk, the copied pkt payload).
async function fetchDrain() {
  const t = transport(SIZE);
  start();
  let bytes = 0;
  for await (const chunk of packStream(t, { wants: ['0'.repeat(40)], filter: '' }, { set() {}, event() {}, error() {} })) bytes += chunk.length;
  note();
  return { bound: peakBound({ kind: 'sideband' }), bytes };
}
// fetchSingle before #172: every zlib byte kept, joined, then inflated into a third buffer.
async function fetchBuffered() {
  const t = transport(SIZE);
  start();
  let sp = spInit();
  const parts = [];
  for await (const chunk of packStream(t, { wants: ['0'.repeat(40)], filter: '' }, { set() {}, event() {}, error() {} })) {
    const r = must(spStep(sp, chunk));
    sp = r.state;
    parts.push(...r.zlib);
  }
  must(spFinish(sp));
  const zlib = concat(parts);
  note();
  const out = must(inflate(zlib, 0, { expectedSize: sp.size }));
  note();
  if (out.out.length !== SIZE) throw new Error(`inflated ${out.out.length}`);
  return { bound: peakBound({ kind: 'fetch-object', output: SIZE }), zlib: zlib.length };
}

// inflate() of a member in hand: the input is the caller's (allocated before the cell starts), the output and what the
// decoder holds are the cell's.
// The member in one buffer, written piece by piece (no array of the pieces outlives the copy).
function memberInHand(size) {
  let n = 0;
  for (const p of storedMember(size)) n += p.length;
  const member = new Uint8Array(n);
  let o = 0;
  for (const p of storedMember(size)) { member.set(p, o); o += p.length; }
  return member;
}
function inflateWhole(declared) {
  const member = memberInHand(SIZE);
  start();
  const out = must(inflate(member, 0, declared ? { expectedSize: SIZE } : {}));
  note();
  if (out.out.length !== SIZE) throw new Error(`inflated ${out.out.length}`);
  return { bound: SIZE + peakBound({ kind: 'inflate' }), member: member.length };
}

// COUNT trees of 128 entries (4,120 bytes each, distinct), and for `blobs` one 256 KiB blob per 32 trees: the pack's
// pieces, each object's zlib member made as it is read. R is the trees' bytes, what a tree want retains.
const TREE_ENTRIES = 128;
function treeBytes(i) {
  const te = new TextEncoder();
  const parts = [];
  for (let j = 0; j < TREE_ENTRIES; j++) {
    parts.push(te.encode(`100644 f${String(j).padStart(3, '0')}\0`));
    parts.push(new Uint8Array(crypto.createHash('sha1').update(`${i}/${j}`).digest()));
  }
  return concat(parts);
}
const objHash = (type, data) => crypto.createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
// The blobs' zlib members, made before a cell starts measuring (each 256 KiB blob compresses to a few hundred bytes), so
// the generator never holds a blob.
const BLOB = 256 * 1024;
const blobMembers = n => Array.from({ length: n }, (_, i) => new Uint8Array(zlib.deflateSync(new Uint8Array(BLOB).map((_, k) => (k * 131 + i) & 255), { level: 9 })));
function widePieces(count, blobs) {
  const total = count + blobs.length;
  const tree = i => { const t = treeBytes(i); return seq([() => once(encodeObjHeader(TYPE.TREE, t.length)), () => once(new Uint8Array(zlib.deflateSync(t)))]); };
  const withBlob = i => (i % 32 === 31 && blobs.length > (i >> 5)) ? seq([() => tree(i), () => once(encodeObjHeader(TYPE.BLOB, BLOB)), () => once(blobs[i >> 5])]) : tree(i);
  return seq([() => once(packHead(total)), () => repeat(count, withBlob)]);
}
// A v2 response framing `pieces` (a pack, sealed here) into band-1 pkt-lines as it is read.
const framedResponse = pieces => frameStream(sealed(pieces));
async function fetchWideCell(withBlobs) {
  const count = SIZE;
  const blobs = withBlobs ? blobMembers(Math.floor(count / 32)) : [];
  const want = objHash('tree', treeBytes(0));
  const retained = count * treeBytes(0).length;
  const fetchImpl = async () => new Response(framedResponse(widePieces(count, blobs)), { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' } });
  const t = must(createTransport('https://git.example/repo.git', { tracer: new Tracer(), fetchImpl, quirks: { treeFilter: withBlobs ? 'none' : 'blob:none' } }));
  start();
  const got = must(await fetchObject(t, { oid: want, filter: 'tree:0', expectType: TYPE.TREE }));
  note();
  if (got.oid !== want) throw new Error(`fetched ${got.oid}`);
  return { bound: peakBound({ kind: 'fetch-pack', retained }), retained, harvested: t.objects.size, blobs: blobs.length };
}
// The same response read through the transport and v2Step with every pack chunk dropped: the transport's own share.
async function fetchWideDrain(withBlobs) {
  const count = SIZE;
  const blobs = withBlobs ? blobMembers(Math.floor(count / 32)) : [];
  const fetchImpl = async () => new Response(framedResponse(widePieces(count, blobs)), { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' } });
  const t = must(createTransport('https://git.example/repo.git', { tracer: new Tracer(), fetchImpl, quirks: {} }));
  start();
  let bytes = 0;
  for await (const chunk of packStream(t, { wants: ['0'.repeat(40)], filter: '' }, { set() {}, event() {}, error() {} })) bytes += chunk.length;
  note();
  return { bound: peakBound({ kind: 'sideband' }), bytes, blobs: blobs.length };
}
async function fetchPackCell() {
  const count = SIZE;
  const retained = count * treeBytes(0).length;
  const fetchImpl = async () => new Response(framedResponse(widePieces(count, [])), { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' } });
  const t = must(createTransport('https://git.example/repo.git', { tracer: new Tracer(), fetchImpl, quirks: {} }));
  start();
  const got = must(await fetchPack(t, { wants: [objHash('tree', treeBytes(0))], filter: '' }));
  note();
  if (got.objects.size !== count) throw new Error(`fetched ${got.objects.size}`);
  return { bound: peakBound({ kind: 'fetch-pack', retained }), retained, objects: got.objects.size };
}

const run = { 'inflate-whole': () => inflateWhole(true), 'inflate-capped': () => inflateWhole(false), 'fetch-wide': () => fetchWideCell(false), 'fetch-wide-blobs': () => fetchWideCell(true), 'fetch-wide-drain': () => fetchWideDrain(false), 'fetch-wide-blobs-drain': () => fetchWideDrain(true), 'fetch-pack': fetchPackCell, 'inflate-drop': inflateDrop, 'scan-drop': scanDrop, 'scan-work': scanWork, 'scan-index': scanIndexCell, 'scan-index-big': scanIndexBigCell, 'scan-iter': scanIterCell, 'inflate-iter': inflateIterCell, 'pkt-iter': pktIterCell,'fetch-object': fetchStreamed, 'fetch-drain': fetchDrain, 'fetch-buffered': fetchBuffered }[mode];
if (!run) throw new Error(`unknown mode ${mode}`);
const report = await run();
const m = process.memoryUsage();
console.log(JSON.stringify({ mode, size: SIZE, abDelta: peak - base, ...report, rss: m.rss, heap: m.heapUsed }));
