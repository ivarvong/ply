// Pack parsing and delta resolution (buffered, general-purpose): parsePack walks a whole pack verifying the trailer,
// applyDelta is git's patch_delta, resolvePack resolves OFS/REF chains to a fixpoint with external bases as a last
// resort, makeDelta is a general delta generator. The edit pipeline needs none of this (fetch.js/fetchObject +
// pack.js/spliceDelta); it is here for the general client and re-exported from pack.js for callers.
import { fail } from './errors.js';
import { inflate } from './inflate.js';
import { Sha1, toHex } from './sha1.js';
import { TYPE, TYPE_NAME, hashObject } from './objects.js';
import { DEFAULT_LIMITS, limitError } from './limits.js';
import { encodeVarint, copyOps, insertOps, spliceDelta } from './pack.js';

const corrupt = msg => fail('pack_corrupt', msg);

function readVarint(buf, p) {
  let n = 0, shift = 0, c;
  do { c = buf[p++]; n += (c & 0x7f) * 2 ** shift; shift += 7; } while (c & 0x80);
  return [n, p];
}

// ---- parse ----

// ---- parse ----
// Optional tighter caps live on the caller's limits object. Absent means unlimited, which is what every
// existing caller (including the authenticated /v1 Worker) already observed.
export const packParseOpts = (limits = DEFAULT_LIMITS) => ({ limits, maxObjects: limits.maxPackObjects ?? Infinity, maxInflatedTotal: limits.maxInflatedTotal ?? Infinity });

export function parsePack(buf, { verify = true, limits = DEFAULT_LIMITS, maxObjects = Infinity, maxInflatedTotal = Infinity } = {}) {
  if (buf.length < 32 || buf[0] !== 0x50 || buf[1] !== 0x41 || buf[2] !== 0x43 || buf[3] !== 0x4b) throw corrupt('pack: bad signature');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = dv.getUint32(4), count = dv.getUint32(8);
  if (version !== 2) throw corrupt(`pack: unsupported version ${version}`);
  // A hostile count must fail before the loop allocates. Defaults preserve every existing caller.
  if (count > maxObjects) throw limitError('pack objects', count, maxObjects);
  const objects = [];
  const stats = { version, count, full: 0, ofsDelta: 0, refDelta: 0, byType: {}, compressed: 0, inflated: 0, inflate: { blocks: 0, stored: 0, fixed: 0, dynamic: 0 } };
  let p = 12;
  for (let i = 0; i < count; i++) {
    const offset = p;
    let c = buf[p++];
    const type = (c >> 4) & 7;
    let size = c & 15, shift = 4;
    while (c & 0x80) { c = buf[p++]; size += (c & 0x7f) * 2 ** shift; shift += 7; }
    let baseOffset, baseOid;
    if (type === TYPE.OFS_DELTA) {
      c = buf[p++]; let off = c & 0x7f;
      while (c & 0x80) { c = buf[p++]; off = ((off + 1) * 128) + (c & 0x7f); }
      baseOffset = offset - off;
      if (baseOffset < 12) throw corrupt(`pack: ofs delta base before pack start at ${offset}`);
      stats.ofsDelta++;
    } else if (type === TYPE.REF_DELTA) {
      baseOid = toHex(buf.subarray(p, p + 20)); p += 20;
      stats.refDelta++;
    } else if (type >= 1 && type <= 4) stats.full++;
    else throw corrupt(`pack: bad object type ${type} at ${offset}`);
    if (size > limits.maxObjectSize) throw limitError('pack object size', size, limits.maxObjectSize);
    // Declared inflated size is known before zlib runs, so an inflate bomb is refused before the output buffer exists.
    if (stats.inflated + size > maxInflatedTotal) throw limitError('pack inflated bytes', stats.inflated + size, maxInflatedTotal);
    const { out, consumed, stats: is } = inflate(buf, p, { expectedSize: size, maxOutput: limits.maxObjectSize });
    stats.compressed += consumed; stats.inflated += size;
    stats.inflate.blocks += is.blocks; stats.inflate.stored += is.stored; stats.inflate.fixed += is.fixed; stats.inflate.dynamic += is.dynamic;
    stats.byType[TYPE_NAME[type]] = (stats.byType[TYPE_NAME[type]] ?? 0) + 1;
    objects.push({ offset, headerBytes: p - offset, type, size, compressed: consumed, data: out, baseOffset, baseOid, inflate: is });
    p += consumed;
  }
  if (p + 20 !== buf.length) throw corrupt(`pack: expected trailer at ${p}, pack length ${buf.length}`);
  const trailer = toHex(buf.subarray(p));
  const computed = verify ? new Sha1().update(buf.subarray(0, p)).hex() : null;
  if (verify && computed !== trailer) throw corrupt(`pack: trailer sha mismatch ${trailer} != ${computed}`);
  return { objects, stats, trailer, bytes: buf.length };
}

// ---- delta ----

// ---- delta ----
export function applyDelta(base, delta, { maxResult = DEFAULT_LIMITS.maxDeltaResult } = {}) {
  if (delta.length < 4) throw corrupt('delta: shorter than DELTA_SIZE_MIN');
  let p = 0, baseSize, resultSize;
  [baseSize, p] = readVarint(delta, p);
  if (p > delta.length) throw corrupt('delta: truncated header');
  [resultSize, p] = readVarint(delta, p);
  if (p > delta.length) throw corrupt('delta: truncated header');
  if (resultSize > maxResult) throw limitError('delta result size', resultSize, maxResult);
  if (baseSize !== base.length) throw corrupt(`delta: base size ${baseSize} != ${base.length}`);
  const out = new Uint8Array(resultSize);
  let o = 0;
  const ops = { copy: 0, insert: 0, copyBytes: 0, insertBytes: 0 };
  while (p < delta.length) {
    const c = delta[p++];
    if (c & 0x80) {
      let off = 0, len = 0;
      if (c & 0x01) off |= delta[p++];
      if (c & 0x02) off |= delta[p++] << 8;
      if (c & 0x04) off |= delta[p++] << 16;
      if (c & 0x08) off += delta[p++] * 0x1000000;
      if (c & 0x10) len |= delta[p++];
      if (c & 0x20) len |= delta[p++] << 8;
      if (c & 0x40) len |= delta[p++] << 16;
      if (len === 0) len = 0x10000;
      if (off + len > base.length || o + len > resultSize) throw corrupt('delta: copy out of range');
      out.set(base.subarray(off, off + len), o); o += len;
      ops.copy++; ops.copyBytes += len;
    } else if (c) {
      if (p + c > delta.length || o + c > resultSize) throw corrupt('delta: insert out of range');
      out.set(delta.subarray(p, p + c), o); o += c; p += c;
      ops.insert++; ops.insertBytes += c;
    } else throw corrupt('delta: reserved opcode 0');
  }
  if (o !== resultSize) throw corrupt(`delta: produced ${o} != ${resultSize}`);
  return { out, ops };
}


// Common-prefix/suffix delta between two buffers.
export function makeDelta(base, target) {
  let p = 0;
  const max = Math.min(base.length, target.length);
  while (p < max && base[p] === target[p]) p++;
  let s = 0;
  while (s < max - p && base[base.length - 1 - s] === target[target.length - 1 - s]) s++;
  return spliceDelta({ baseLen: base.length, off: p, oldLen: base.length - p - s, insert: target.subarray(p, target.length - s) });
}

// ---- resolve ----
// objects from parsePack; external(oid) -> {type, data} for thin bases. Returns Map oid -> resolved.

// ---- resolve ----
// objects from parsePack; external(oid) -> {type, data} for thin bases. Returns Map oid -> resolved.
export function resolvePack(parsed, external = () => undefined, limits = DEFAULT_LIMITS) {
  const byOffset = new Map(parsed.objects.map(o => [o.offset, o]));
  const resolved = new Map();
  const memo = new Map();
  const stats = { maxChain: 0, externalBases: 0 };
  let allowExternal = false;
  const resolveObj = (obj, depth = 0) => {
    if (memo.has(obj.offset)) return memo.get(obj.offset);
    if (depth > limits.maxDeltaChain) throw limitError('delta chain depth', depth, limits.maxDeltaChain);
    let r;
    if (obj.baseOffset !== undefined || obj.baseOid !== undefined) {
      let base;
      if (obj.baseOffset !== undefined) {
        const b = byOffset.get(obj.baseOffset);
        if (!b) throw corrupt(`pack: ofs delta base not at object boundary ${obj.baseOffset}`);
        base = resolveObj(b, depth + 1);
      } else {
        const inPack = parsed.objects.find(o => o.oid === obj.baseOid) ?? byDeltaOid.get(obj.baseOid);
        if (inPack) base = resolveObj(inPack, depth + 1);
        else {
          const ext = allowExternal ? external(obj.baseOid) : undefined;
          if (!ext) throw corrupt(`pack: ref delta base ${obj.baseOid} not found`);
          stats.externalBases++;
          base = { type: ext.type, data: ext.data, chain: 0 };
        }
      }
      const { out, ops } = applyDelta(base.data, obj.data, { maxResult: limits.maxDeltaResult });
      r = { type: base.type, data: out, chain: base.chain + 1, deltaOps: ops };
    } else r = { type: obj.type, data: obj.data, chain: 0 };
    r.oid = hashObject(TYPE_NAME[r.type], r.data);
    r.offset = obj.offset; r.size = obj.size; r.compressed = obj.compressed;
    r.baseOffset = obj.baseOffset; r.baseOid = obj.baseOid;
    if (r.chain > stats.maxChain) stats.maxChain = r.chain;
    memo.set(obj.offset, r);
    resolved.set(r.oid, r);
    return r;
  };
  // pre-hash full objects so REF_DELTA bases appearing later in-pack can be found by oid
  for (const o of parsed.objects) if (o.baseOffset === undefined && o.baseOid === undefined) o.oid = hashObject(TYPE_NAME[o.type], o.data);
  // a REF_DELTA base can itself be a delta object anywhere in the pack: resolve what we can, learn oids, repeat
  const byDeltaOid = new Map();
  let pending = parsed.objects.filter(o => o.baseOffset !== undefined || o.baseOid !== undefined);
  for (const o of parsed.objects) if (o.baseOffset === undefined && o.baseOid === undefined) resolveObj(o);
  for (let pass = 0; pending.length && pass < 64; pass++) {
    const next = [];
    for (const o of pending) {
      try { const r = resolveObj(o); byDeltaOid.set(r.oid, o); }
      catch (e) { if (e.code === 'pack_corrupt' && /ref delta base .* not found/.test(e.message)) next.push(o); else throw e; }
    }
    if (next.length === pending.length) {
      if (allowExternal) resolveObj(next[0]); // no progress even with external bases: surface the real error
      allowExternal = true;                   // every in-pack base is known now; the rest are thin bases
    }
    pending = next;
  }
  return { objects: resolved, stats };
}

