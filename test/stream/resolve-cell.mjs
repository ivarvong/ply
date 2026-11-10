// One memory cell for resolvePackRange (#248), run as its own process with --expose-gc (test/resolve-memory.test.js).
// Writes a pack of CHAINS chains to a temp file: each a whole random blob of SIZE bytes and DEPTH OFS deltas on it, each
// delta keeping all but the last 16 bytes of its base. Scans it from the file, then resolves it over a file-backed
// RangeSource with a CACHE-byte cache, sampling live arrayBuffers (after gc) at every range read. Prints one JSON line.
//   node --expose-gc test/stream/resolve-cell.mjs CHAINS DEPTH SIZE CACHE
import { mkdtempSync, rmSync, openSync, writeSync, closeSync, createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { createHash, randomFillSync } from 'node:crypto';
import { scanPackIndex } from '../../src/packscanindex.js';
import { resolvePackRange } from '../../src/packrangeresolve.js';
import { withLimits } from '../../src/limits.js';

const [chains, depth, size, cache] = process.argv.slice(2).map(Number);
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

const dir = mkdtempSync(join(tmpdir(), 'ply-resolve-cell-'));
const file = join(dir, 'p.pack');
try {
  const fd = openSync(file, 'w');
  const sha = createHash('sha1');
  let at = 0;
  const put = bytes => { writeSync(fd, bytes); sha.update(bytes); at += bytes.length; };
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'latin1');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(chains * (depth + 1), 8);
  put(head);
  for (let c = 0; c < chains; c++) {
    const blob = randomFillSync(new Uint8Array(size));
    let prev = at;
    put(objHeader(3, size));
    put(deflateSync(blob, { level: 1 }));
    for (let d = 0; d < depth; d++) {
      const here = at;
      const program = delta(randomFillSync(new Uint8Array(TAIL)));
      put(objHeader(6, program.length));
      put(ofs(here - prev));
      put(deflateSync(program));
      prev = here;
    }
  }
  writeSync(fd, sha.digest());
  closeSync(fd);
  const packBytes = at + 20;

  const idx = await scanPackIndex(createReadStream(file, { highWaterMark: PIECE }), { limits: withLimits({ maxObjectSize: size }) });
  if (!idx.ok) throw new Error(idx.error.message);
  const fh = await open(file, 'r');
  const ab = () => { global.gc(); global.gc(); return process.memoryUsage().arrayBuffers; };
  const base = ab();
  let peak = base;
  const source = {
    size: packBytes,
    read: async (offset, length) => {
      peak = Math.max(peak, ab());
      let o = offset;
      const end = offset + length;
      return { ok: true, value: new ReadableStream({
        async pull(ctl) {
          if (o >= end) { ctl.close(); return; }
          const buf = new Uint8Array(Math.min(PIECE, end - o));
          const { bytesRead } = await fh.read(buf, 0, buf.length, o);
          o += bytesRead;
          ctl.enqueue(buf.subarray(0, bytesRead));
        },
      }) };
    },
  };
  const t0 = performance.now();
  const res = await resolvePackRange(idx.value, source, { cacheBytes: cache, limits: withLimits({ maxObjectSize: size, maxDeltaResult: size, maxDeltaChain: depth + 1 }) });
  const ms = performance.now() - t0;
  peak = Math.max(peak, ab());
  await fh.close();
  if (!res.ok) throw new Error(res.error.message);
  console.log(JSON.stringify({ chains, depth, size, cache, packBytes, entries: res.value.count, abDelta: peak - base, ms: Math.round(ms), stats: res.value.stats }));
} finally { rmSync(dir, { recursive: true, force: true }); }
