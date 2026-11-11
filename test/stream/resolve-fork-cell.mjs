// One memory cell for resolvePackRange on a forked delta family larger than the cache, run as its own process with
// --expose-gc (test/resolve-memory.test.js). Writes one pack to a temp file: a whole random blob of SIZE bytes and a
// spine DEPTH deep on it; at each level two OFS deltas on the same base (the second is the next spine) and one leaf on
// the first: 3 x DEPTH + 1 objects of SIZE bytes, each its base with the last 16 bytes replaced. Resolves it over a
// file-backed RangeSource with a CACHE-byte cache, sampling live arrayBuffers (after gc) at every range read and at
// every piece pulled, and checks every oid against node:crypto over the bytes the edits describe. One JSON line.
//   node --expose-gc test/stream/resolve-fork-cell.mjs DEPTH SIZE CACHE
import { mkdtempSync, rmSync, openSync, writeSync, closeSync, createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { createHash, randomFillSync } from 'node:crypto';
import { scanPackIndex } from '../../src/packscanindex.js';
import { resolvePackRange } from '../../src/packrangeresolve.js';
import { withLimits } from '../../src/limits.js';

const [depth, size, cache] = process.argv.slice(2).map(Number);
const TAIL = 16;
const PIECE = 65_536;

function objHeader(type, n) {
  const out = [(type << 4) | (n & 0x0f)];
  n = Math.floor(n / 16);
  while (n > 0) { out[out.length - 1] |= 0x80; out.push(n & 0x7f); n = Math.floor(n / 128); }
  return Uint8Array.from(out);
}
function ofs(off) {
  const out = [off & 0x7f];
  while ((off = Math.floor(off / 128)) > 0) out.unshift(0x80 | (--off & 0x7f));
  return Uint8Array.from(out);
}
const varint = n => { const out = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return out; };
// copy [0, size - TAIL) of the base, then insert TAIL new bytes
function delta(tail) {
  const keep = size - TAIL;
  return Uint8Array.from([...varint(size), ...varint(size), 0x80 | 0x10 | 0x20 | 0x40, keep & 0xff, (keep >> 8) & 0xff, (keep >> 16) & 0xff, TAIL, ...tail]);
}

const dir = mkdtempSync(join(tmpdir(), 'ply-resolve-fork-cell-'));
const file = join(dir, 'p.pack');
try {
  const fd = openSync(file, 'w');
  const sha = createHash('sha1');
  let at = 0;
  const put = bytes => { writeSync(fd, bytes); sha.update(bytes); at += bytes.length; };
  const entries = 3 * depth + 1;
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'latin1');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries, 8);
  put(head);
  const want = [];
  {
    // every object is the root's first size - TAIL bytes and its own tail, so its oid needs no copy of it
    const root = randomFillSync(new Uint8Array(size));
    const oidOf = tail => createHash('sha1').update(`blob ${size}\0`).update(root.subarray(0, size - TAIL)).update(tail).digest('hex');
    want.push(oidOf(root.subarray(size - TAIL)));
    const edit = baseAt => {
      const here = at;
      const tail = randomFillSync(new Uint8Array(TAIL));
      const program = delta(tail);
      put(objHeader(6, program.length));
      put(ofs(here - baseAt));
      put(deflateSync(program));
      want.push(oidOf(tail));
      return here;
    };
    let spine = at;
    put(objHeader(3, size));
    put(deflateSync(root, { level: 1 }));
    for (let k = 0; k < depth; k++) {
      const first = edit(spine);
      const second = edit(spine);
      edit(first);
      spine = second;
    }
  }
  writeSync(fd, sha.digest());
  closeSync(fd);
  const packBytes = at + 20;

  const limits = withLimits({ maxObjectSize: size, maxDeltaResult: size, maxDeltaChain: depth + 2 });
  const idx = await scanPackIndex(createReadStream(file, { highWaterMark: PIECE }), { limits });
  if (!idx.ok) throw new Error(idx.error.message);
  const fh = await open(file, 'r');
  const ab = () => { global.gc(); global.gc(); return process.memoryUsage().arrayBuffers; };
  const base = ab();
  let peak = base;
  let samples = 0;
  const sample = () => { samples += 1; peak = Math.max(peak, ab()); };
  const source = {
    size: packBytes,
    read: async (offset, length) => {
      sample();
      let o = offset;
      const end = offset + length;
      return { ok: true, value: new ReadableStream({
        async pull(ctl) {
          sample();
          if (o >= end) { ctl.close(); return; }
          const buf = new Uint8Array(Math.min(PIECE, end - o));
          const { bytesRead } = await fh.read(buf, 0, buf.length, o);
          o += bytesRead;
          ctl.enqueue(buf.subarray(0, bytesRead));
        },
      }) };
    },
  };
  const res = await resolvePackRange(idx.value, source, { cacheBytes: cache, limits });
  sample();
  await fh.close();
  if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
  let oidsRight = 0;
  for (let i = 0; i < want.length; i++) if (res.value.oid(i).value === want[i]) oidsRight += 1;
  console.log(JSON.stringify({ depth, size, cache, packBytes, entries: res.value.count, wanted: want.length, oidsRight, abDelta: peak - base, samples, stats: res.value.stats }));
} finally { rmSync(dir, { recursive: true, force: true }); }
