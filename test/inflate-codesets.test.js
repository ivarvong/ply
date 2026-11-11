// Dynamic-block code sets against zlib: ply's inflate accepts a header if and only if node:zlib (inflateRawSync) accepts
// it, and when both accept the bytes are equal. zlib refuses an over-subscribed set always and an incomplete one except
// the cases inftrees.c permits (no codes at all; one 1-bit code in the literal/length or distance set). The expected
// value of every case here is zlib's answer on the same bytes, never ply's: the corpus is every length assignment over
// a small alphabet for each of the three sets (so every over-subscribed and incomplete shape of that size), then
// random sets.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { Rng } from './fuzz/prng.js';
import { inflate } from '../src/inflate.js';

// RFC 1951 §3.2.7: the order the code-length code lengths are sent in
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
// RFC 1951 §3.2.2: canonical codes from lengths (bl_count, next_code); null for a symbol with no code
function canon(lengths) {
  const count = new Array(17).fill(0);
  for (const l of lengths) count[l] += 1;
  count[0] = 0;
  const next = new Array(17).fill(0);
  let code = 0;
  for (let b = 1; b <= 15; b++) { code = (code + count[b - 1]) << 1; next[b] = code; }
  return lengths.map(l => (l ? { code: next[l]++, len: l } : null));
}
function bitWriter() {
  const bits = [];
  return {
    put(v, n) { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); },          // a field: least significant bit first
    code(c) { for (let i = c.len - 1; i >= 0; i--) bits.push((c.code >> i) & 1); }, // a Huffman code: most significant first
    bytes() { const out = new Uint8Array(Math.ceil(bits.length / 8)); bits.forEach((b, i) => { out[i >> 3] |= b << (i & 7); }); return out; },
  };
}
// One final dynamic block. clen: the 19 code-length code lengths by symbol; lit (257..286 lengths) and dist (1..30) are
// sent one code-length symbol each. A length clen has no code for ends the header there; `tail` follows either way.
function dynBlock(clen, lit, dist, body, tail = new Uint8Array(0)) {
  const w = bitWriter();
  w.put(1, 1); w.put(2, 2);
  w.put(lit.length - 257, 5); w.put(dist.length - 1, 5); w.put(19 - 4, 4);
  for (const s of ORDER) w.put(clen[s], 3);
  const cl = canon(clen);
  const sent = [...lit, ...dist];
  if (sent.every(l => cl[l] !== null)) {
    for (const l of sent) w.code(cl[l]);
    body(w, canon(lit), canon(dist));
  }
  return Uint8Array.from([...w.bytes(), ...tail]);
}
// lengths 0..15 as 4-bit codes, no repeat symbols: a complete code-length code (16 × 2^-4 = 1)
const PLAIN = Array.from({ length: 19 }, (_, s) => (s < 16 ? 4 : 0));
const lengthsOf = (n, set) => { const a = new Array(n).fill(0); for (const [s, l] of Object.entries(set)) a[Number(s)] = l; return a; };

const SETS = ['invalid code lengths set', 'invalid literal/lengths set', 'invalid distances set'];
const seen = { accepted: 0, refused: 0, 'invalid code lengths set': 0, 'invalid literal/lengths set': 0, 'invalid distances set': 0 };
function agrees(buf, label) {
  let want = null;
  let why = '';
  try { want = new Uint8Array(zlib.inflateRawSync(buf)); } catch (e) { why = e.message; }
  const got = inflate(buf, 0, { raw: true });
  const hex = Buffer.from(buf.subarray(0, 48)).toString('hex');
  if (want === null) {
    seen.refused += 1;
    if (SETS.includes(why)) seen[why] += 1;
    assert.equal(got.ok, false, `${label}: zlib refuses (${why}), ply accepts ${got.ok ? got.value.out.length : 0} bytes: ${hex}`);
    assert.equal(got.error.code, 'pack_corrupt', label);
    // the three code-set refusals carry zlib's own message
    if (SETS.includes(why)) assert.equal(got.error.message, `inflate: ${why}`, `${label}: ${hex}`);
    return;
  }
  seen.accepted += 1;
  assert.equal(got.ok, true, `${label}: zlib accepts ${want.length} bytes, ply refuses (${got.ok ? '' : got.error.message}): ${hex}`);
  assert.deepEqual(new Uint8Array(got.value.out), want, `${label}: bytes`);
}

test('literal/length sets: every assignment of lengths 0..4 to three literals and 1..4 to end-of-block, as zlib judges it', () => {
  for (let a = 0; a <= 4; a++) for (let b = 0; b <= 4; b++) for (let c = 0; c <= 4; c++) for (let e = 1; e <= 4; e++) {
    const lit = lengthsOf(257, { 97: a, 98: b, 99: c, 256: e });
    const buf = dynBlock(PLAIN, lit, [1], (w, L) => { for (const s of [97, 98, 99, 97]) if (L[s]) w.code(L[s]); w.code(L[256]); });
    agrees(buf, `lit a:${a} b:${b} c:${c} eob:${e}`);
  }
  // both kinds of refusal and the complete sets were all in the corpus (zlib's count, not ply's)
  assert.ok(seen.accepted >= 10 && seen['invalid literal/lengths set'] >= 100, JSON.stringify(seen));
});

test('distance sets: every assignment of lengths 0..3 to three distance codes, with and without a match, as zlib judges it', () => {
  const before = seen['invalid distances set'];
  const lit = lengthsOf(258, { 97: 1, 256: 2, 257: 2 }); // complete: 1/2 + 1/4 + 1/4; 257 is a match of length 3
  for (let x = 0; x <= 3; x++) for (let y = 0; y <= 3; y++) for (let z = 0; z <= 3; z++) for (const match of [false, true]) {
    const buf = dynBlock(PLAIN, lit, [x, y, z], (w, L, D) => {
      w.code(L[97]); w.code(L[97]); w.code(L[97]);
      if (match) { w.code(L[257]); if (D[0]) w.code(D[0]); else w.put(0, 2); } // distance code 0 is distance 1
      w.code(L[256]);
    });
    agrees(buf, `dist ${x},${y},${z} match:${match}`);
  }
  assert.ok(seen['invalid distances set'] - before >= 20, JSON.stringify(seen));
});

test('code-length sets: every assignment of lengths 0..3 to the code-length symbols 0, 1, 2 and 18, as zlib judges it', () => {
  const before = seen['invalid code lengths set'];
  const lit = lengthsOf(258, { 97: 1, 256: 2, 257: 2 });
  const rng = new Rng(11);
  for (let p = 0; p <= 3; p++) for (let q = 0; q <= 3; q++) for (let r = 0; r <= 3; r++) for (let t = 0; t <= 3; t++) {
    const clen = lengthsOf(19, { 0: p, 1: q, 2: r, 18: t });
    const buf = dynBlock(clen, lit, [1], (w, L) => { w.code(L[97]); w.code(L[97]); w.code(L[256]); }, rng.bytes(4));
    agrees(buf, `clen 0:${p} 1:${q} 2:${r} 18:${t}`);
  }
  assert.ok(seen['invalid code lengths set'] - before >= 100, JSON.stringify(seen));
});

test('random code sets: complete codes with one length moved, and random headers, as zlib judges them', () => {
  const rng = new Rng(20261111);
  for (let i = 0; i < 600; i++) {
    // a complete code built by splitting leaves, then (two times in three) one length moved by one: incomplete or over-subscribed
    const grow = n => { const ls = [1, 1]; while (ls.length < n) { const k = rng.int(0, ls.length - 1); if (ls[k] >= 15) break; ls[k] += 1; ls.push(ls[k]); } return ls; };
    const bend = ls => { const k = rng.int(0, ls.length - 1); const m = rng.int(0, 2); if (m === 1 && ls[k] < 15) ls[k] += 1; if (m === 2 && ls[k] > 1) ls[k] -= 1; return ls; };
    const ll = bend(grow(rng.int(2, 40)));
    const lit = new Array(257 + rng.int(0, 29)).fill(0);
    const live = [256];
    lit[256] = ll[0];
    for (const l of ll.slice(1)) { const s = rng.int(0, 255); if (lit[s] === 0) { lit[s] = l; live.push(s); } }
    const dl = bend(grow(rng.int(2, 30)));
    const dist = rng.int(0, 3) === 0 ? [rng.int(0, 1)] : dl;
    const buf = dynBlock(PLAIN, lit, dist, (w, L) => { for (let j = rng.int(0, 30); j > 0; j--) w.code(L[rng.pick(live.filter(s => s !== 256).concat(live.length > 1 ? [] : [256]))]); w.code(L[256]); });
    agrees(buf, `random set ${i}`);
  }
  for (let i = 0; i < 1500; i++) {
    // a dynamic block header and code-length code lengths biased short, then random bytes
    const clen = Array.from({ length: 19 }, () => rng.pick([0, 0, 1, 2, 2, 3, 3, 4, 5, 7]));
    const w = bitWriter();
    w.put(1, 1); w.put(2, 2); w.put(rng.int(0, 29), 5); w.put(rng.int(0, 29), 5); w.put(rng.int(0, 15), 4);
    for (const s of ORDER) w.put(clen[s], 3);
    agrees(Uint8Array.from([...w.bytes(), ...rng.bytes(rng.int(0, 120))]), `random header ${i}`);
  }
});
