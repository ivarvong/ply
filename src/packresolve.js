// Pack parsing and delta resolution (buffered, general-purpose): parsePack walks a whole pack verifying the trailer,
// applyDelta is git's patch_delta, resolvePack resolves OFS/REF chains to a fixpoint with external bases as a last
// resort, makeDelta is a general delta generator. The edit pipeline needs none of this (fetch.js/fetchObject +
// pack.js/spliceDelta); it is here for the general client and re-exported from pack.js for callers.
import { fail } from './errors.js';
import { inflate } from './inflate.js';
import { Sha1, toHex } from './sha1.js';
import { TYPE, TYPE_NAME, hashObject } from './objects.js';
import { DEFAULT_LIMITS, limitError } from './limits.js';
import { spliceDelta } from './pack.js';
import { take } from './bytes.js';
import {
  PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, PACK_TRAILER_BYTES, OID_BYTES, UINT32_BYTES,
  DELTA_SIZE_MIN, DELTA_COPY, DELTA_COPY_MAX, DELTA_OFF4_FACTOR, DELTA_OFF_SHIFT,
  DELTA_COPY_OFF1, DELTA_COPY_OFF2, DELTA_COPY_OFF3, DELTA_COPY_OFF4,
  DELTA_COPY_LEN1, DELTA_COPY_LEN2, DELTA_COPY_LEN3, DELTA_BYTE2_SHIFT,
  OBJ_TYPE_SHIFT, OBJ_TYPE_MASK, OBJ_SIZE_FIRST_MASK, OBJ_SIZE_NEXT_MASK, OBJ_CONTINUE,
  OBJ_SIZE_NEXT_BASE, VARINT_BITS, varintScale, BE32_SHIFTS,
} from './format.js';

const corrupt = msg => fail('pack_corrupt', msg);

function readVarint(buf, p) {
  let n = 0, shift = 0, c;
  do {
    c = take(buf, p, 1)[0];
    p += 1;
    n += (c & OBJ_SIZE_NEXT_MASK) * varintScale(shift);
    shift += VARINT_BITS;
  } while (c & OBJ_CONTINUE);
  return [n, p];
}

export function readUint32BE(buf, off) {
  const b = take(buf, off, BE32_SHIFTS.length);
  return ((b[0] << BE32_SHIFTS[0]) | (b[1] << BE32_SHIFTS[1]) | (b[2] << BE32_SHIFTS[2]) | b[BE32_SHIFTS.length - 1]) >>> 0;
}

// @decoder readObjHeader prefix=obj-header
export function readObjHeader(buf, p) {
  let c = take(buf, p, 1)[0];
  const type = (c >> OBJ_TYPE_SHIFT) & OBJ_TYPE_MASK;
  let size = c & OBJ_SIZE_FIRST_MASK;
  let shift = OBJ_TYPE_SHIFT;
  p += 1;
  while (c & OBJ_CONTINUE) {
    c = take(buf, p, 1)[0];
    p += 1;
    size += (c & OBJ_SIZE_NEXT_MASK) * varintScale(shift);
    shift += VARINT_BITS;
  }
  return { type, size, next: p };
}

// @decoder readOfsDelta prefix=ofs-delta
export function readOfsDelta(buf, p) {
  let c = take(buf, p, 1)[0];
  p += 1;
  let off = c & OBJ_SIZE_NEXT_MASK;
  while (c & OBJ_CONTINUE) {
    c = take(buf, p, 1)[0];
    p += 1;
    off = ((off + 1) * OBJ_SIZE_NEXT_BASE) + (c & OBJ_SIZE_NEXT_MASK);
  }
  return { off, next: p };
}

// ---- parse ----

// ---- parse ----
// @decoder parsePack prefix=pack
export function parsePack(buf, { verify = true, limits = DEFAULT_LIMITS } = {}) {
  const minPack = PACK_HEADER_BYTES + PACK_TRAILER_BYTES;
  if (buf.length < minPack || !take(buf, 0, PACK_SIGNATURE.length).every((b, i) => b === PACK_SIGNATURE[i])) throw corrupt('pack: bad signature');
  const version = readUint32BE(buf, PACK_SIGNATURE.length);
  const count = readUint32BE(buf, PACK_SIGNATURE.length + UINT32_BYTES);
  if (version !== PACK_VERSION) throw corrupt(`pack: unsupported version ${version}`);
  const objects = [];
  const stats = { version, count, full: 0, ofsDelta: 0, refDelta: 0, byType: {}, compressed: 0, inflated: 0, inflate: { blocks: 0, stored: 0, fixed: 0, dynamic: 0 } };
  let p = PACK_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const offset = p;
    const header = readObjHeader(buf, p);
    const type = header.type;
    const size = header.size;
    p = header.next;
    let baseOffset, baseOid;
    if (type === TYPE.OFS_DELTA) {
      const ofs = readOfsDelta(buf, p);
      p = ofs.next;
      baseOffset = offset - ofs.off;
      if (baseOffset < PACK_HEADER_BYTES) throw corrupt(`pack: ofs delta base before pack start at ${offset}`);
      stats.ofsDelta++;
    } else if (type === TYPE.REF_DELTA) {
      baseOid = toHex(take(buf, p, OID_BYTES)); p += OID_BYTES;
      stats.refDelta++;
    } else if (type >= TYPE.COMMIT && type <= TYPE.TAG) stats.full++;
    else throw corrupt(`pack: bad object type ${type} at ${offset}`);
    if (size > limits.maxObjectSize) throw limitError('pack object size', size, limits.maxObjectSize);
    const { out, consumed, stats: is } = inflate(buf, p, { expectedSize: size, maxOutput: limits.maxObjectSize });
    stats.compressed += consumed; stats.inflated += size;
    stats.inflate.blocks += is.blocks; stats.inflate.stored += is.stored; stats.inflate.fixed += is.fixed; stats.inflate.dynamic += is.dynamic;
    stats.byType[TYPE_NAME[type]] = (stats.byType[TYPE_NAME[type]] ?? 0) + 1;
    objects.push({ offset, headerBytes: p - offset, type, size, compressed: consumed, data: out, baseOffset, baseOid, inflate: is });
    p += consumed;
  }
  if (p + PACK_TRAILER_BYTES !== buf.length) throw corrupt(`pack: expected trailer at ${p}, pack length ${buf.length}`);
  const trailer = toHex(take(buf, p, PACK_TRAILER_BYTES));
  const computed = verify ? new Sha1().update(take(buf, 0, p)).hex() : null;
  if (verify && computed !== trailer) throw corrupt(`pack: trailer sha mismatch ${trailer} != ${computed}`);
  return { objects, stats, trailer, bytes: buf.length };
}

// ---- delta ----

// ---- delta ----
const deltaByte = (delta, p) => ({ b: take(delta, p, 1)[0], p: p + 1 });

// @decoder applyDelta prefix=delta
export function applyDelta(base, delta, { maxResult = DEFAULT_LIMITS.maxDeltaResult } = {}) {
  if (delta.length < DELTA_SIZE_MIN) throw corrupt('delta: shorter than DELTA_SIZE_MIN');
  let p = 0, baseSize, resultSize;
  // readVarint uses take(), so a header that runs past the buffer throws a short read before p can pass the end.
  [baseSize, p] = readVarint(delta, p);
  [resultSize, p] = readVarint(delta, p);
  if (resultSize > maxResult) throw limitError('delta result size', resultSize, maxResult);
  if (baseSize !== base.length) throw corrupt(`delta: base size ${baseSize} != ${base.length}`);
  const out = new Uint8Array(resultSize);
  let o = 0;
  const ops = { copy: 0, insert: 0, copyBytes: 0, insertBytes: 0 };
  while (p < delta.length) {
    let c;
    ({ b: c, p } = deltaByte(delta, p));
    if (c & DELTA_COPY) {
      let off = 0, len = 0;
      if (c & DELTA_COPY_OFF1) { const r = deltaByte(delta, p); off |= r.b; p = r.p; }
      if (c & DELTA_COPY_OFF2) { const r = deltaByte(delta, p); off |= r.b << DELTA_OFF_SHIFT; p = r.p; }
      if (c & DELTA_COPY_OFF3) { const r = deltaByte(delta, p); off |= r.b << DELTA_BYTE2_SHIFT; p = r.p; }
      if (c & DELTA_COPY_OFF4) { const r = deltaByte(delta, p); off += r.b * DELTA_OFF4_FACTOR; p = r.p; }
      if (c & DELTA_COPY_LEN1) { const r = deltaByte(delta, p); len |= r.b; p = r.p; }
      if (c & DELTA_COPY_LEN2) { const r = deltaByte(delta, p); len |= r.b << DELTA_OFF_SHIFT; p = r.p; }
      if (c & DELTA_COPY_LEN3) { const r = deltaByte(delta, p); len |= r.b << DELTA_BYTE2_SHIFT; p = r.p; }
      if (len === 0) len = DELTA_COPY_MAX;
      if (off + len > base.length || o + len > resultSize) throw corrupt('delta: copy out of range');
      out.set(take(base, off, len), o); o += len;
      ops.copy++; ops.copyBytes += len;
    } else if (c) {
      if (p + c > delta.length || o + c > resultSize) throw corrupt('delta: insert out of range');
      out.set(take(delta, p, c), o); o += c; p += c;
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
  return spliceDelta({ baseLen: base.length, off: p, oldLen: base.length - p - s, insert: take(target, p, target.length - s - p) });
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
  // oxlint-disable-next-line no-magic-numbers -- fixpoint iterations, not a pack field width
  const RESOLVE_PASSES = 64;
  for (let pass = 0; pending.length && pass < RESOLVE_PASSES; pass++) {
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

