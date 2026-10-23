// Pure byte-level mutations of server responses. Each takes (rng, bytes) → bytes and names what it did.
// Protocol-aware ones locate pkt-line length fields, sideband band bytes and pack object headers so the
// fuzzer reaches parser branches that random bit flips rarely hit.
import { concat } from '../../src/bytes.js';

const te = new TextEncoder();
const splice = (b, at, del, ins = new Uint8Array(0)) => concat([b.subarray(0, at), ins, b.subarray(at + del)]);

export const MUTATORS = {
  flip_bit: (rng, b) => { if (!b.length) return b; const o = b.slice(); const i = rng.int(0, b.length - 1); o[i] ^= 1 << rng.int(0, 7); return o; },
  flip_byte: (rng, b) => { if (!b.length) return b; const o = b.slice(); o[rng.int(0, b.length - 1)] = rng.u32() & 0xff; return o; },
  zero_run: (rng, b) => { if (!b.length) return b; const o = b.slice(); const i = rng.int(0, b.length - 1); o.fill(0, i, Math.min(b.length, i + rng.int(1, 64))); return o; },
  truncate: (rng, b) => b.subarray(0, rng.int(0, Math.max(0, b.length - 1))),
  truncate_tail: (rng, b) => b.subarray(0, Math.max(0, b.length - rng.int(1, 24))),
  delete_run: (rng, b) => { if (b.length < 2) return b; const i = rng.int(0, b.length - 2); return splice(b, i, rng.int(1, Math.min(64, b.length - i))); },
  insert_junk: (rng, b) => splice(b, rng.int(0, b.length), 0, rng.bytes(rng.int(1, 64))),
  duplicate_run: (rng, b) => { if (b.length < 2) return b; const i = rng.int(0, b.length - 2), n = rng.int(1, Math.min(200, b.length - i)); return splice(b, i, 0, b.subarray(i, i + n)); },
  append_junk: (rng, b) => concat([b, rng.bytes(rng.int(1, 100))]),
  append_flush: (rng, b) => concat([b, te.encode('0000')]),
  empty: () => new Uint8Array(0),
  swap_runs: (rng, b) => { if (b.length < 40) return b; const n = rng.int(1, Math.min(16, b.length >> 2)); const i = rng.int(0, b.length - 2 * n - 1), j = rng.int(i + n, b.length - n); const o = b.slice(); o.set(b.subarray(j, j + n), i); o.set(b.subarray(i, i + n), j); return o; },

  // ---- pkt-line aware ----
  pkt_len: (rng, b) => { const offs = pktOffsets(b); if (!offs.length) return b; const o = b.slice(); const at = rng.pick(offs); const v = rng.pick(['0000', '0001', '0002', '0003', 'ffff', 'zzzz', '0004', '0005', (rng.int(4, 70000)).toString(16).padStart(4, '0').slice(-4)]); o.set(te.encode(v), at); return o; },
  pkt_drop: (rng, b) => { const offs = pktOffsets(b); if (offs.length < 2) return b; const k = rng.int(0, offs.length - 1); const end = k + 1 < offs.length ? offs[k + 1] : b.length; return splice(b, offs[k], end - offs[k]); },
  pkt_dup: (rng, b) => { const offs = pktOffsets(b); if (!offs.length) return b; const k = rng.int(0, offs.length - 1); const end = k + 1 < offs.length ? offs[k + 1] : b.length; return splice(b, offs[k], 0, b.subarray(offs[k], end)); },
  pkt_inject_band2: (rng, b) => { const offs = pktOffsets(b); if (!offs.length) return b; const msg = concat([Uint8Array.of(2), te.encode(`remote: ${'x'.repeat(rng.int(0, 300))}\r`)]); return splice(b, rng.pick(offs), 0, pkt(msg)); },
  pkt_inject_band3: (rng, b) => { const offs = pktOffsets(b); if (!offs.length) return b; return splice(b, rng.pick(offs), 0, pkt(concat([Uint8Array.of(3), te.encode('fatal: injected')]))); },
  pkt_inject_err: (rng, b) => { const offs = pktOffsets(b); if (!offs.length) return b; return splice(b, rng.pick(offs), 0, pkt(te.encode('ERR injected\n'))); },
  band_swap: (rng, b) => { const offs = pktOffsets(b).filter(o => b.length > o + 4 && (b[o + 4] === 1 || b[o + 4] === 2)); if (!offs.length) return b; const o = b.slice(); o[rng.pick(offs) + 4] = rng.pick([0, 1, 2, 3, 4, 255]); return o; },
  pkt_shallow_flood: (rng, b) => { const offs = pktOffsets(b); if (!offs.length) return b; const n = rng.int(1000, 1500); const lines = []; for (let i = 0; i < n; i++) lines.push(pkt(te.encode(`shallow ${'a'.repeat(40)}\n`))); return splice(b, offs[0], 0, concat([pkt(te.encode('shallow-info\n')), ...lines, te.encode('0001')])); },

  // ---- pack aware (operates inside band-1 payload of the first pack frame) ----
  pack_count: (rng, b) => inPack(b, (p) => { const o = p.slice(); new DataView(o.buffer, o.byteOffset).setUint32(8, rng.pick([0, 2, 7, 0xffffffff, 1000000])); return o; }),
  pack_version: (rng, b) => inPack(b, (p) => { const o = p.slice(); new DataView(o.buffer, o.byteOffset).setUint32(4, rng.pick([0, 1, 3, 0xffffffff])); return o; }),
  pack_objtype: (rng, b) => inPack(b, (p) => { const o = p.slice(); o[12] = (o[12] & 0x8f) | (rng.pick([0, 1, 2, 4, 5, 6, 7]) << 4); return o; }),
  pack_objsize: (rng, b) => inPack(b, (p) => { const o = p.slice(); o[12] = (o[12] & 0x70) | 0x80 | rng.int(0, 15); return splice(o, 13, 0, Uint8Array.from(rng.pick([[0x7f], [0xff, 0xff, 0xff, 0xff, 0x0f], [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f], [0x80, 0x80, 0x80, 0x01]]))); }),
  pack_sig: (rng, b) => inPack(b, (p) => { const o = p.slice(); o[rng.int(0, 3)] ^= 0x20; return o; }),
  pack_trailer: (rng, b) => inPack(b, (p) => { const o = p.slice(); if (o.length >= 20) o[o.length - 1 - rng.int(0, 19)] ^= 0xff; return o; }),
  zlib_header: (rng, b) => inPack(b, (p) => { const o = p.slice(); if (o.length > 14) { o[13] = rng.pick([0x00, 0x78, 0x79, 0xff]); o[14] = rng.pick([0x9c, 0x01, 0xda, 0x00, 0x20]); } return o; }),
  zlib_body: (rng, b) => inPack(b, (p) => { const o = p.slice(); if (o.length > 36) o[rng.int(15, o.length - 21)] ^= 1 << rng.int(0, 7); return o; }),
  zlib_bomb: (rng, b) => inPack(b, () => { // 1 object claiming 1 MiB of zeros, honest zlib (so adler passes) but declared size differs from header
    const hdr = new Uint8Array(12); hdr.set([0x50, 0x41, 0x43, 0x4b]); new DataView(hdr.buffer).setUint32(4, 2); new DataView(hdr.buffer).setUint32(8, 1);
    return concat([hdr, Uint8Array.from([0x30 | 0x80 | 0x0f, 0xff, 0x3f]), ZEROS_1M]); }),
};
export const MUTATOR_NAMES = Object.keys(MUTATORS);

export function pktOffsets(b) {
  const offs = []; let p = 0;
  while (p + 4 <= b.length) {
    const len = parseInt(String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]), 16);
    if (!Number.isFinite(len)) break;
    offs.push(p);
    p += len < 4 ? 4 : len;
  }
  return offs;
}
const pkt = payload => concat([te.encode((payload.length + 4).toString(16).padStart(4, '0')), payload]);

// Find first band-1 frame starting with PACK; apply f to the concatenation of ALL band-1 payloads, then re-frame.
function inPack(b, f) {
  const offs = pktOffsets(b);
  const frames = offs.map((o, i) => ({ o, end: i + 1 < offs.length ? offs[i + 1] : b.length }));
  const band1 = frames.filter(fr => fr.end - fr.o > 5 && b[fr.o + 4] === 1);
  if (!band1.length) return b;
  const payload = concat(band1.map(fr => b.subarray(fr.o + 5, fr.end)));
  if (payload.length < 40 || payload[0] !== 0x50) return b;
  const mutated = f(payload);
  const pre = b.subarray(0, band1[0].o), post = b.subarray(band1[band1.length - 1].end);
  const out = [pre];
  for (let i = 0; i < mutated.length; i += 65000) out.push(pkt(concat([Uint8Array.of(1), mutated.subarray(i, Math.min(i + 65000, mutated.length))])));
  out.push(post);
  return concat(out);
}
let ZEROS_1M;
try { const z = await import('node:zlib'); ZEROS_1M = new Uint8Array(z.deflateSync(Buffer.alloc(1 << 20))); } catch { ZEROS_1M = new Uint8Array(0); }
