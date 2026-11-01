// The pack-cut space (SPACES.md hole #5): real git-produced packs, cut at EVERY byte offset and corrupted field by
// field, through every path ply reads a pack on. Bounded-exhaustive, no randomness.
//
//   pack     full (non-delta: commit, tree, blob, tag) | ofs (OFS_DELTA) | ref (REF_DELTA) | chain (several OFS deltas)
//            | thin (REF_DELTA to a base outside the pack) | single-{commit,tree,blob,tag} (a one-object tree:0 answer)
//   cut      every offset 0 .. length-1 (the uncut pack is the control cell: it must be accepted, by git and by ply)
//   path     parsePack (buffered: parsePack + resolvePack, pure) | fetchPack (public multi-object fetch over http)
//            | fetchWide (the blob:none fallback of fetchObject) | spStep (the streamed single-object parser, pure,
//            in one chunk and byte by byte) | fetchObject (tree:0 single-object fetch over http)
//   corrupt  a header field set to each class of value (signature byte, version, count, object type, size varint, ofs
//            offset, ref base, delta header and opcodes, zlib header/body/adler, trailer) × trailer {recomputed, stale}
//
// Expected: a cut pack is refused by git (`git index-pack --strict`: the oracle, every cut must fail there) and by ply
// with a typed error, `pack_corrupt` (or `limit_exceeded` where a cap decides first); never accepted, never a partial
// result, never an untyped error, never a hang (each cell is synchronous or awaits one in-memory response). A corrupt
// pack: ply accepts exactly when git index-pack --strict accepts (judgment calls listed in JUDGED).
//
// PACK_SPACE=full runs the git oracle on every cut (nightly); the default runs it on a deterministic subset: every
// field boundary of every pack plus every 8th offset (CI). ply's own paths run every offset in both modes.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { buildPacks, indexPackOracle } from './pack-fixtures.js';
import { transport, outcome, outcomeSync, v2PackResponse, cat } from './wire.js';
import { parsePack, resolvePack, packParseOpts, readObjHeader, readOfsDelta, readUint32BE } from '../../src/pack.js';
import { fetchObject, spInit, spStep, spFinish } from '../../src/fetch.js';
import { fetchPack } from '../../src/fetchpack.js';
import { inflate, declaredBound, zlibWrap } from '../../src/inflatestream.js';
import { hashObject, TYPE_NAME } from '../../src/objects.js';
import { DEFAULT_LIMITS } from '../../src/limits.js';
import { encodeObjHeader, encodeVarint } from '../../src/pack.js';

const FULL = process.env.PACK_SPACE === 'full';
const F = buildPacks();
const ORACLE = indexPackOracle();
for (const b of F.bases.values()) ORACLE.seed(packOf([{ type: { commit: 1, tree: 2, blob: 3, tag: 4 }[b.type], data: b.data }]));
process.on('exit', () => ORACLE.close());

// ---- pack building (for corruption cells only; the cut cells use git's bytes untouched) ----
function sha1(b) { return new Uint8Array(createHash('sha1').update(b).digest()); }
function withTrailer(body) { return cat([body, sha1(body)]); }
function header(count, version = 2) { const h = new Uint8Array(12); h.set([0x50, 0x41, 0x43, 0x4b]); new DataView(h.buffer).setUint32(4, version); new DataView(h.buffer).setUint32(8, count); return h; }
function packOf(objs) { return withTrailer(cat([header(objs.length), ...objs.map(o => cat([encodeObjHeader(o.type, o.data.length), deflateSync(o.data)]))])); }
// git's pack as records: { offset, raw: the object's bytes in the pack (header + base ref + zlib) }
function records(bytes) {
  const p = parsePack(bytes, packParseOpts());
  return p.objects.map((o, i) => ({ ...o, end: i + 1 < p.objects.length ? p.objects[i + 1].offset : bytes.length - 20 }));
}
const restamp = body => withTrailer(body.subarray(0, body.length - 20));

// ---- the paths ----
const LIMITS = {};
const typedPackError = o => o.tag === 'typed' && (o.code === 'pack_corrupt' || o.code === 'limit_exceeded');
const external = oid => { const b = F.bases.get(oid); return b && { type: { commit: 1, tree: 2, blob: 3, tag: 4 }[b.type], data: b.data }; };

function viaParsePack(bytes, thin) {
  return outcomeSync(() => { const parsed = parsePack(bytes, packParseOpts()); return resolvePack(parsed, thin ? external : undefined).objects.size; });
}
// the streamed single-object path exactly as fetchSingle runs it (spStep chunks, spFinish, inflate, trailing, hash)
function viaSpStep(bytes, want, chunked) {
  return outcomeSync(() => {
    let sp = spInit(); const parts = [];
    const step = c => { const r = spStep(sp, c); sp = r.state; parts.push(...r.zlib); };
    if (chunked) for (let i = 0; i < bytes.length; i++) step(bytes.subarray(i, i + 1)); else step(bytes);
    sp = spFinish(sp);
    const z = cat(parts);
    const { out, consumed } = inflate(z, 0, { bound: declaredBound(sp.size, 1 << 26), wrap: zlibWrap(true) });
    if (consumed !== z.length) throw Object.assign(new Error('trailing'), { code: 'pack_corrupt' });
    if (hashObject(TYPE_NAME[sp.type], out) !== want) throw Object.assign(new Error('hash'), { code: 'pack_corrupt' });
    return out.length;
  });
}
const serve = pack => transport((kind, service) => (kind === 'post' && service === 'git-upload-pack' ? { bytes: v2PackResponse(pack) } : undefined), LIMITS);
const viaFetchObject = (bytes, want) => outcome(() => fetchObject(serve(bytes), { oid: want }));
const viaFetchWide = (bytes, want) => outcome(async () => { const t = serve(bytes); t.quirks.treeFilter = 'blob:none'; return fetchObject(t, { oid: want }); });
const viaFetchPack = (bytes, want, thin) => outcome(() => fetchPack(serve(bytes), { wants: [want] }, thin ? { external } : {}));

const MULTI = Object.entries(F.packs).map(([name, p]) => ({ name, ...p }));
const SINGLE = Object.entries(F.single).map(([t, p]) => ({ name: `single-${t}`, ...p }));
const ALL = [...MULTI, ...SINGLE];

// field boundaries of a pack (for the CI subset of the oracle): header fields, every object's start, header end, the
// base reference, the zlib stream's first and last bytes, the trailer's first byte, and both neighbours of each
function boundaries(p) {
  const b = new Set([0, 1, 3, 4, 8, 11, 12]);
  for (const r of records(p.bytes)) for (const x of [r.offset, r.offset + 1, r.offset + r.headerBytes - 1, r.offset + r.headerBytes, r.offset + r.headerBytes + 2, r.end - 4, r.end - 1]) b.add(x);
  for (const x of [p.bytes.length - 20, p.bytes.length - 1]) b.add(x);
  return [...b].filter(x => x >= 0 && x < p.bytes.length);
}
const oracleOffsets = p => (FULL ? [...Array(p.bytes.length).keys()] : [...new Set([...boundaries(p), ...[...Array(p.bytes.length).keys()].filter(k => k % 8 === 0)])].sort((a, b) => a - b));

const census = { cells: 0, oracle: 0, codes: {} };
const tally = (path, o) => { census.cells++; const k = `${path}:${o.tag === 'typed' ? o.code : o.tag}`; census.codes[k] = (census.codes[k] ?? 0) + 1; };

test('control: every uncut pack is accepted by git index-pack --strict and by every ply path', async () => {
  for (const p of ALL) {
    assert.ok(ORACLE.run(p.bytes, { thin: !!p.external }).ok, `${p.name}: git index-pack refuses the uncut pack`);
    const r = viaParsePack(p.bytes, !!p.external);
    assert.equal(r.tag, 'ok', `${p.name} parsePack: ${JSON.stringify(r)}`);
  }
  for (const p of MULTI) {
    if (!p.external) assert.equal((await viaFetchWide(p.bytes, p.want)).tag, 'ok', `${p.name} fetchWide`);
    assert.equal((await viaFetchPack(p.bytes, p.want, !!p.external)).tag, 'ok', `${p.name} fetchPack`);
  }
  for (const p of SINGLE) {
    assert.equal(viaSpStep(p.bytes, p.want, false).tag, 'ok', `${p.name} spStep`);
    assert.equal((await viaFetchObject(p.bytes, p.want)).tag, 'ok', `${p.name} fetchObject`);
  }
});

test('cut: every byte offset of every pack is refused, typed, on every path', async () => {
  const wrong = [];
  for (const p of ALL) {
    const single = p.name.startsWith('single-');
    for (let k = 0; k < p.bytes.length; k++) {
      const cut = p.bytes.subarray(0, k);
      const runs = [['parsePack', viaParsePack(cut, !!p.external)]];
      if (single) {
        runs.push(['spStep', viaSpStep(cut, p.want, false)], ['spStep/bytewise', viaSpStep(cut, p.want, true)], ['fetchObject', await viaFetchObject(cut, p.want)]);
      } else {
        runs.push(['fetchPack', await viaFetchPack(cut, p.want, !!p.external)]);
        if (!p.external) runs.push(['fetchWide', await viaFetchWide(cut, p.want)]);
      }
      for (const [path, o] of runs) { tally(path, o); if (!typedPackError(o)) wrong.push(`${p.name} cut@${k} ${path}: ${JSON.stringify(o).slice(0, 200)}`); }
    }
  }
  assert.deepEqual(wrong.slice(0, 20), [], `${wrong.length} cut cell(s) not refused with a typed pack error`);
});

test(`cut: git index-pack --strict refuses every cut (the oracle; ${FULL ? 'every offset' : 'field boundaries + every 8th offset'})`, () => {
  const accepted = [];
  for (const p of ALL) for (const k of oracleOffsets(p)) {
    census.oracle++;
    const g = ORACLE.run(p.bytes.subarray(0, k), { thin: !!p.external });
    if (g.ok) accepted.push(`${p.name} cut@${k}`);
  }
  assert.deepEqual(accepted, [], 'git accepted a cut pack: the space expects a refusal there and must be revisited');
});

// ---- corruption ----
const setU32 = (b, off, v) => { const c = b.slice(); new DataView(c.buffer).setUint32(off, v >>> 0); return c; };
const setByte = (b, off, v) => { const c = b.slice(); c[off] = v; return c; };
// a pack whose object i is replaced by raw bytes (header + base ref + zlib), offsets after it shifted, trailer recomputed
function replaceObject(bytes, i, raw) {
  const rs = records(bytes);
  return withTrailer(cat([bytes.subarray(0, rs[i].offset), raw, bytes.subarray(rs[i].end, bytes.length - 20)]));
}
const deltaRecord = name => { const p = F.packs[name]; const rs = records(p.bytes); const i = rs.findIndex(r => r.type === 6 || r.type === 7); return { p, rs, i, r: rs[i] }; };
// the delta object of pack `name` (its last object) re-encoded around a new delta body
function withDelta(name, delta) {
  const { p, r, i } = deltaRecord(name);
  const ref = p.bytes.subarray(r.offset + r.headerBytes - (r.type === 7 ? 20 : 0), r.offset + r.headerBytes);
  const ofs = r.type === 6 ? p.bytes.subarray(r.offset + encodeObjHeader(6, r.size).length, r.offset + r.headerBytes) : new Uint8Array(0);
  return replaceObject(p.bytes, i, cat([encodeObjHeader(r.type, delta.length), r.type === 7 ? ref : ofs, deflateSync(delta)]));
}
// the real delta git wrote, and its header fields
function gitDelta(name) { const { r } = deltaRecord(name); return r.data; }
function varint(b, p) { let n = 0, s = 0, c; do { c = b[p++]; n += (c & 0x7f) * 2 ** s; s += 7; } while (c & 0x80); return [n, p]; }
function deltaWith(name, { base, result, ops }) {
  const d = gitDelta(name); let [b0, p] = varint(d, 0); let r0; [r0, p] = varint(d, p);
  return cat([encodeVarint(base ?? b0), encodeVarint(result ?? r0), ops ?? d.subarray(p)]);
}
// a zlib stream (fixed Huffman) that emits one literal and then a match with distance code `dcode` (30, 31: invalid)
function badDistanceZlib(dcode) {
  const bits = []; const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); }; // Huffman codes MSB first
  bits.push(1, 1, 0); // BFINAL=1, BTYPE=01 (LSB first)
  put(0x30 + 0x61, 8); // literal 'a'
  put(1, 7); // length code 257 (length 3)
  put(dcode, 5); // distance code
  put(0, 7); // end of block
  const out = new Uint8Array(Math.ceil(bits.length / 8)); bits.forEach((b, i) => { out[i >> 3] |= b << (i & 7); });
  return cat([Uint8Array.of(0x78, 0x01), out, Uint8Array.of(0, 0, 0, 0)]);
}

const CORRUPT = [];
const add = (pack, field, value, bytes, opts = {}) => CORRUPT.push({ pack, field, value, bytes, ...opts });
for (const name of ['full', 'single-blob', 'ofs', 'ref']) {
  const p = name.startsWith('single-') ? F.single[name.slice(7)] : F.packs[name];
  const b = p.bytes; const n = records(b).length;
  for (let i = 0; i < 4; i++) for (const [cls, v] of [['zero', 0], ['ff', 0xff], ['case', b[i] ^ 0x20], ['next', (b[i] + 1) & 0xff]]) {
    add(name, `signature[${i}]`, cls, setByte(b, i, v)); add(name, `signature[${i}]`, `${cls}+restamp`, restamp(setByte(b, i, v)));
  }
  for (const v of [0, 1, 3, 4, 0x80000002, 0xffffffff]) add(name, 'version', v, restamp(setU32(b, 4, v)));
  for (const v of [0, n - 1, n + 1, 100_001, 0xffffffff]) { add(name, 'count', v, restamp(setU32(b, 8, v))); add(name, 'count', `${v}+stale`, setU32(b, 8, v)); }
  records(b).forEach((r, i) => {
    const t = b[r.offset];
    for (const ty of [0, 5, ...(r.type < 6 ? [6, 7] : [1, 3])]) add(name, `obj${i}.type`, ty, restamp(setByte(b, r.offset, (t & 0x8f) | (ty << 4))), { thin: false });
    add(name, `obj${i}.size`, '+1', replaceObject(b, i, cat([encodeObjHeader(r.type, r.size + 1), b.subarray(r.offset + encodeObjHeader(r.type, r.size).length, r.end)])));
    if (r.size > 0) add(name, `obj${i}.size`, '-1', replaceObject(b, i, cat([encodeObjHeader(r.type, r.size - 1), b.subarray(r.offset + encodeObjHeader(r.type, r.size).length, r.end)])));
    // a size varint that never ends inside 10 bytes (varintRoom), and one cut by the end of the pack is the cut space
    add(name, `obj${i}.size`, 'overlong', replaceObject(b, i, cat([Uint8Array.of((r.type << 4) | 0x8f, ...Array(10).fill(0xff), 0x01), b.subarray(r.offset + r.headerBytes, r.end)])));
    const z = r.offset + r.headerBytes;
    add(name, `obj${i}.zlib[0]`, 'method', restamp(setByte(b, z, 0x77)));
    add(name, `obj${i}.zlib[1]`, 'fcheck', restamp(setByte(b, z + 1, b[z + 1] ^ 1)));
    add(name, `obj${i}.zlib.adler`, 'flip', restamp(setByte(b, r.end - 1, b[r.end - 1] ^ 0xff)));
  });
  for (const k of [0, 10, 19]) add(name, `trailer[${k}]`, 'flip', setByte(b, b.length - 20 + k, b[b.length - 20 + k] ^ 1));
  add(name, 'trailing', '+1 byte', cat([b, Uint8Array.of(0)]));
}
{ // ofs offset classes on the ofs pack (the delta is the last object, so nothing after it moves)
  const { p, r, i } = deltaRecord('ofs');
  const hdr = encodeObjHeader(6, r.size); const z = p.bytes.subarray(r.offset + r.headerBytes, r.end);
  const ofsVar = off => { const out = [off & 0x7f]; while ((off >>= 7)) { off -= 1; out.unshift(0x80 | (off & 0x7f)); } return Uint8Array.from(out); };
  for (const [cls, off] of [['self (0)', 0], ['mid-object (+1)', r.offset - r.baseOffset - 1], ['mid-object (-1)', r.offset - r.baseOffset + 1], ['before pack start', r.offset - 4], ['far before', 1 << 20]]) add('ofs', 'ofs.offset', cls, replaceObject(p.bytes, i, cat([hdr, ofsVar(off), z])));
  add('ofs', 'ofs.offset', 'overlong', replaceObject(p.bytes, i, cat([hdr, Uint8Array.from([...Array(12).fill(0xff), 0x00]), z])));
}
{ // ref base classes on the ref pack
  const { p, r, i } = deltaRecord('ref');
  const base = p.bytes.subarray(r.offset + r.headerBytes - 20, r.offset + r.headerBytes);
  const z = p.bytes.subarray(r.offset + r.headerBytes, r.end);
  add('ref', 'ref.base', 'unknown oid', replaceObject(p.bytes, i, cat([encodeObjHeader(7, r.size), setByte(base, 19, base[19] ^ 1), z])));
  add('ref', 'ref.base', 'zero oid', replaceObject(p.bytes, i, cat([encodeObjHeader(7, r.size), new Uint8Array(20), z])));
}
for (const name of ['ofs', 'ref']) { // delta header and opcode classes (a valid zlib stream of a bad delta)
  const d = gitDelta(name); const [bs] = varint(d, 0);
  add(name, 'delta.base-size', '+1', withDelta(name, deltaWith(name, { base: bs + 1 })));
  add(name, 'delta.result-size', '+1', withDelta(name, deltaWith(name, { result: varint(d, varint(d, 0)[1])[0] + 1 })));
  add(name, 'delta.result-size', '-1', withDelta(name, deltaWith(name, { result: varint(d, varint(d, 0)[1])[0] - 1 })));
  add(name, 'delta.result-size', '2^40', withDelta(name, deltaWith(name, { result: 2 ** 40 })));
  add(name, 'delta.header', 'varint never ends', withDelta(name, Uint8Array.of(0x80, 0x80, 0x80, 0x80)));
  add(name, 'delta.header', 'shorter than DELTA_SIZE_MIN', withDelta(name, Uint8Array.of(bs & 0x7f, 1, 1)));
  for (let bit = 0; bit < 7; bit++) add(name, 'delta.copy', `operand ${bit} missing`, withDelta(name, deltaWith(name, { ops: Uint8Array.of(0x80 | (1 << bit)) })));
  add(name, 'delta.copy', 'out of range', withDelta(name, deltaWith(name, { ops: Uint8Array.of(0x80 | 0x01 | 0x02 | 0x10, 0xff, 0xff, 0x10) })));
  add(name, 'delta.insert', 'past end', withDelta(name, deltaWith(name, { ops: Uint8Array.of(0x7f, 0x61) })));
  add(name, 'delta.opcode', '0', withDelta(name, deltaWith(name, { ops: Uint8Array.of(0) })));
  add(name, 'delta.ops', 'none', withDelta(name, deltaWith(name, { ops: new Uint8Array(0) })));
}
for (const dcode of [30, 31]) add('single-blob', 'zlib.distance-code', dcode, withTrailer(cat([header(1), encodeObjHeader(3, 4), badDistanceZlib(dcode)])));

// Judgment calls: cells where ply refuses what git accepts, each with the reason. Keyed `${pack} ${field}=${value}`.
const JUDGED = {
  'full version=3': 'git index-pack accepts pack version 3 (pack_version_ok); no git since 2005 writes it, and an upload-pack response is always v2: ply refuses it as pack_corrupt',
  'single-blob version=3': 'as full version=3',
  'ofs version=3': 'as full version=3',
  'ref version=3': 'as full version=3',
};

// The only corrupt cells a cap decides before the corruption is seen: a count over maxPackObjects, a delta result over
// maxDeltaResult. Every other refusal is pack_corrupt (retryable: a corrupt pack is the server's or the wire's fault).
const CAPPED = new Set(['count=100001', 'count=4294967295', 'count=100001+stale', 'count=4294967295+stale', 'delta.result-size=2^40']);

test('corrupt: every header-field class is refused exactly where git index-pack --strict refuses it, typed', async () => {
  const wrong = [];
  for (const c of CORRUPT) {
    const key = `${c.pack} ${c.field}=${c.value}`;
    const g = ORACLE.run(c.bytes);
    const ply = viaParsePack(c.bytes, false);
    const want = c.pack.startsWith('single-') ? (F.single[c.pack.slice(7)]) : F.packs[c.pack];
    const real = c.pack.startsWith('single-') ? await viaFetchObject(c.bytes, want.want) : await viaFetchPack(c.bytes, want.want, false);
    if (process.env.PACK_SPACE_DUMP) console.error(`DUMP ${key} | git ${g.ok ? 'ok' : g.msg} | ply ${ply.tag === 'ok' ? 'ok' : ply.code + ': ' + ply.message} | real ${real.tag === 'ok' ? 'ok' : real.code + ': ' + real.message}`);
    tally('corrupt/parsePack', ply); tally(`corrupt/${c.pack.startsWith('single-') ? 'fetchObject' : 'fetchPack'}`, real);
    for (const [path, o] of [['parsePack', ply], ['real', real]]) {
      if (o.tag === 'untyped') wrong.push(`${key} ${path}: untyped ${JSON.stringify(o)}`);
      else if (g.ok && o.tag !== 'ok' && !JUDGED[key]) wrong.push(`${key} ${path}: git accepts, ply ${o.code}: ${o.message}`);
      else if (!g.ok && o.tag === 'ok') wrong.push(`${key} ${path}: git refuses (${g.msg}), ply accepts`);
      // the streamed single-object path refuses any count but 1 before a cap is asked
      else if (!g.ok && o.code !== (CAPPED.has(`${c.field}=${c.value}`) && !(path === 'real' && c.pack.startsWith('single-')) ? 'limit_exceeded' : 'pack_corrupt')) wrong.push(`${key} ${path}: ${o.code}: ${o.message}`);
    }
  }
  assert.deepEqual(wrong, []);
});

// The caps, at each side of their bound, on real packs: a cap decides with limit_exceeded exactly past its value, and the
// pack at the bound is accepted. resolvePack takes its own limits, so a caller may resolve under a tighter
// maxInflatedTotal than it parsed with: what parsePack already inflated then counts against it first.
test('caps: maxObjectSize, maxInflatedTotal, maxDeltaChain at, and one under, what each real pack needs', () => {
  const wrong = [];
  const check = (id, o, ok) => { tally('caps', o); if (ok ? o.tag !== 'ok' : !(o.tag === 'typed' && o.code === 'limit_exceeded')) wrong.push(`${id}: ${JSON.stringify(o).slice(0, 160)}`); };
  for (const p of MULTI) {
    const parsed = parsePack(p.bytes, packParseOpts());
    const big = Math.max(...parsed.objects.map(o => o.size)), total = parsed.stats.inflated;
    const res = p.external ? external : undefined;
    for (const [d, ok] of [[0, true], [1, false]]) {
      check(`${p.name} maxObjectSize=${big - d}`, outcomeSync(() => parsePack(p.bytes, { ...packParseOpts({ ...DEFAULT_LIMITS, maxObjectSize: big - d }) })), ok);
      check(`${p.name} parse maxInflatedTotal=${total - d}`, outcomeSync(() => parsePack(p.bytes, packParseOpts({ ...DEFAULT_LIMITS, maxInflatedTotal: total - d }))), ok);
    }
    const deltas = parsed.objects.filter(o => o.type >= 6).length;
    if (!deltas) continue;
    // resolve under a tighter aggregate than the parse: what is held already is over it
    check(`${p.name} resolve maxInflatedTotal=${total - 1}`, outcomeSync(() => resolvePack(parsePack(p.bytes, packParseOpts()), res, { ...DEFAULT_LIMITS, maxInflatedTotal: total - 1 })), false);
    // the deepest chain the pack holds, from a resolve with no limit on it
    const depth = Math.max(...[...resolvePack(parsePack(p.bytes, packParseOpts()), res).objects.values()].map(o => o.chain));
    for (const [d, ok] of [[0, true], [1, false]]) check(`${p.name} maxDeltaChain=${depth - d}`, outcomeSync(() => resolvePack(parsePack(p.bytes, packParseOpts()), res, { ...DEFAULT_LIMITS, maxDeltaChain: depth - d })), ok);
  }
  assert.deepEqual(wrong, []);
});

test('the exported readers: every offset of every short buffer is a typed short read, never a NaN or undefined field', () => {
  const wrong = [];
  for (const p of ALL) {
    const rs = records(p.bytes);
    for (const r of rs) for (let k = r.offset; k < r.offset + r.headerBytes; k++) {
      const cut = p.bytes.subarray(0, k);
      const o = outcomeSync(() => readObjHeader(cut, r.offset));
      if (!(k < r.offset + encodeObjHeader(r.type, r.size).length ? typedPackError(o) : o.tag === 'ok')) wrong.push(`${p.name} readObjHeader cut@${k}: ${JSON.stringify(o)}`);
      if (r.type === 6) {
        const at = r.offset + encodeObjHeader(6, r.size).length;
        if (k <= at || k >= r.offset + r.headerBytes) continue;
        const q = outcomeSync(() => readOfsDelta(cut, at));
        if (!typedPackError(q)) wrong.push(`${p.name} readOfsDelta cut@${k}: ${JSON.stringify(q)}`);
      }
    }
    for (let k = 0; k < 12; k++) for (const off of [4, 8]) {
      const o = outcomeSync(() => readUint32BE(p.bytes.subarray(0, k), off));
      if (k >= off + 4 ? o.tag !== 'ok' : !typedPackError(o)) wrong.push(`${p.name} readUint32BE(${off}) cut@${k}: ${JSON.stringify(o)}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('census', t => {
  console.log(`git ${F.version}; packs ${ALL.map(p => `${p.name}=${p.bytes.length}B`).join(' ')}`);
  console.log(`${census.cells} ply cells, ${census.oracle} cut cells judged by git index-pack (${FULL ? 'full' : 'CI subset'}), ${CORRUPT.length} corruption cells`);
  for (const [k, v] of Object.entries(census.codes).sort()) console.log(`  ${k}: ${v}`);
});
