// describePack without git: the choices verify-pack does not spell out (header size, not the resolved object; a thin
// base is a list, not an error) and every limit the function passes through, at the boundary and one past it.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { describePack, parsePack, resolvePack, buildPack, makeDelta, encodeObjHeader, zlibDeflate } from '../src/pack.js';
import { hashObject, TYPE } from '../src/objects.js';
import { Sha1, fromHex } from '../src/sha1.js';
import { concat, te } from '../src/bytes.js';
import { DEFAULT_LIMITS, withLimits } from '../src/limits.js';
import {
  PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, PACK_TRAILER_BYTES, UINT32_BYTES,
  OBJ_CONTINUE, OBJ_SIZE_NEXT_MASK, OBJ_SIZE_NEXT_BASE,
} from '../src/format.js';

const refused = (r, code, what) => {
  assert.equal(r.ok, false, what);
  if (r.ok) return;
  assert.equal(r.error.code, code);
  assert.equal(r.error.what, what);
};
const layoutOf = buf => {
  const r = describePack(buf);
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error('unreachable');
  return r.value;
};

function encodeOfs(off) {
  const out = [off & OBJ_SIZE_NEXT_MASK];
  while ((off = Math.floor(off / OBJ_SIZE_NEXT_BASE)) > 0) out.unshift(OBJ_CONTINUE | (--off & OBJ_SIZE_NEXT_MASK));
  return Uint8Array.of(...out);
}

// entries: { type, data } full, { data, baseOid } REF_DELTA, { data, baseIndex } OFS_DELTA to an earlier entry.
async function packOf(entries) {
  const parts = [Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION), new Uint8Array(UINT32_BYTES)];
  new DataView(parts[1].buffer).setUint32(0, entries.length);
  const offsets = [];
  let at = PACK_HEADER_BYTES;
  for (const e of entries) {
    offsets.push(at);
    const type = e.baseOid ? TYPE.REF_DELTA : e.baseIndex !== undefined ? TYPE.OFS_DELTA : e.type;
    const entry = concat([
      encodeObjHeader(type, e.data.length),
      ...(e.baseOid ? [fromHex(e.baseOid)] : e.baseIndex !== undefined ? [encodeOfs(at - offsets[e.baseIndex])] : []),
      await zlibDeflate(e.data),
    ]);
    parts.push(entry);
    at += entry.length;
  }
  const body = concat(parts);
  return concat([body, new Sha1().update(body).digest()]);
}

test('a pack of one of each object type is four depth-0 rows and no missing base', async () => {
  const rows = [
    [TYPE.COMMIT, te.encode('commit-bytes')],
    [TYPE.TREE, te.encode('tree-bytes')],
    [TYPE.BLOB, te.encode('blob-bytes')],
    [TYPE.TAG, te.encode('tag-bytes')],
  ];
  const { pack } = await buildPack(rows.map(([type, data]) => ({ type, data })));
  const layout = layoutOf(pack);
  assert.equal(layout.version, PACK_VERSION);
  assert.equal(layout.count, 4);
  assert.equal(layout.objects.length, 4);
  assert.deepEqual(layout.missingBases, []);
  assert.equal(layout.trailer, new Sha1().update(pack.subarray(0, pack.length - PACK_TRAILER_BYTES)).hex());
  const names = { [TYPE.COMMIT]: 'commit', [TYPE.TREE]: 'tree', [TYPE.BLOB]: 'blob', [TYPE.TAG]: 'tag' };
  for (const [i, [type, data]] of rows.entries()) {
    const o = layout.objects[i];
    assert.equal(o.wireType, type);
    assert.equal(o.type, type);
    assert.equal(o.oid, hashObject(names[type], data));
    assert.equal(o.depth, 0);
    assert.equal(o.base, null);
    assert.equal(o.size, data.length);
  }
});

test('size is the inflated header, and an in-pack REF or OFS base is that object', async () => {
  const base = te.encode('A'.repeat(64));
  const target = te.encode(`${'A'.repeat(64)}Z`);
  const delta = makeDelta(base, target).delta;
  const baseOid = hashObject('blob', base);
  const targetOid = hashObject('blob', target);
  assert.notEqual(delta.length, target.length);

  const { pack: refPack } = await buildPack([
    { type: TYPE.BLOB, data: base },
    { type: TYPE.BLOB, data: delta, baseOid },
  ]);
  const ref = layoutOf(refPack);
  assert.equal(ref.objects[1].wireType, TYPE.REF_DELTA);
  assert.equal(ref.objects[1].type, TYPE.BLOB);
  assert.equal(ref.objects[1].oid, targetOid);
  assert.equal(ref.objects[1].size, delta.length);
  assert.notEqual(ref.objects[1].size, target.length);
  assert.equal(ref.objects[1].depth, 1);
  assert.deepEqual(ref.objects[1].base, { oid: baseOid });
  assert.deepEqual(ref.missingBases, []);
  const parsed = parsePack(refPack);
  assert.equal(ref.objects[1].headerBytes + ref.objects[1].compressed, parsed.objects[1].headerBytes + parsed.objects[1].compressed);

  const ofsPack = await packOf([
    { type: TYPE.BLOB, data: base },
    { data: delta, baseIndex: 0 },
  ]);
  const ofs = layoutOf(ofsPack);
  assert.equal(ofs.objects[1].wireType, TYPE.OFS_DELTA);
  assert.equal(ofs.objects[1].type, TYPE.BLOB);
  assert.equal(ofs.objects[1].oid, targetOid);
  assert.equal(ofs.objects[1].size, delta.length);
  assert.equal(ofs.objects[1].depth, 1);
  assert.deepEqual(ofs.objects[1].base, { offset: ofs.objects[0].offset, oid: baseOid });
});

test('a thin REF base is missingBases, in pack order, and resolvePack still refuses it', async () => {
  const base = te.encode('hello');
  const target = te.encode('hello!');
  const other = te.encode('other');
  const delta = makeDelta(base, target).delta;
  const deltaB = makeDelta(other, te.encode('other!')).delta;
  const idA = hashObject('blob', base);
  const idB = hashObject('blob', other);
  const { pack } = await buildPack([
    { type: TYPE.BLOB, data: delta, baseOid: idA },
    { type: TYPE.BLOB, data: deltaB, baseOid: idB },
    { type: TYPE.BLOB, data: delta, baseOid: idA },
  ]);
  const layout = layoutOf(pack);
  assert.deepEqual(layout.missingBases, [idA, idB]);
  for (const o of layout.objects) {
    assert.equal(o.oid, null);
    assert.equal(o.type, null);
    assert.equal(o.depth, 1);
    assert.equal(o.wireType, TYPE.REF_DELTA);
    assert.equal(o.size, o === layout.objects[1] ? deltaB.length : delta.length);
  }
  assert.deepEqual(layout.objects[0].base, { oid: idA });
  assert.throws(() => resolvePack(parsePack(pack)), e => e.code === 'pack_corrupt' && e.message === `pack: ref delta base ${idA} not found`);

  const chained = await packOf([
    { data: delta, baseOid: idA },
    { data: makeDelta(target, te.encode('hello!!')).delta, baseIndex: 0 },
  ]);
  const chain = layoutOf(chained);
  assert.deepEqual(chain.missingBases, [idA]);
  assert.equal(chain.objects[0].depth, 1);
  assert.deepEqual(chain.objects[0].base, { oid: idA });
  assert.equal(chain.objects[1].wireType, TYPE.OFS_DELTA);
  assert.equal(chain.objects[1].depth, 2);
  assert.equal(chain.objects[1].oid, null);
  assert.equal(chain.objects[1].type, null);
  assert.deepEqual(chain.objects[1].base, { offset: chain.objects[0].offset, oid: null });
});

test('limits: the boundary accepts and one past it refuses, and a cap that bounds nothing is bad_request', async () => {
  const base = te.encode('hello');
  const target = te.encode('hello!');
  const delta = makeDelta(base, target).delta;
  const { pack } = await buildPack([
    { type: TYPE.BLOB, data: base },
    { type: TYPE.BLOB, data: delta, baseOid: hashObject('blob', base) },
  ]);
  const headerSum = base.length + delta.length;
  const inflated = headerSum + target.length;
  const maxHeader = Math.max(base.length, delta.length);
  assert.equal(describePack(pack, withLimits({ maxPackObjects: 2 })).ok, true);
  refused(describePack(pack, withLimits({ maxPackObjects: 1 })), 'limit_exceeded', 'pack objects');
  assert.equal(describePack(pack, withLimits({ maxObjectSize: maxHeader })).ok, true);
  refused(describePack(pack, withLimits({ maxObjectSize: maxHeader - 1 })), 'limit_exceeded', 'pack object size');
  assert.equal(describePack(pack, withLimits({ maxInflatedTotal: inflated })).ok, true);
  refused(describePack(pack, withLimits({ maxInflatedTotal: inflated - 1 })), 'limit_exceeded', 'delta result size');
  assert.equal(describePack(pack, withLimits({ maxDeltaChain: 1 })).ok, true);
  refused(describePack(pack, withLimits({ maxDeltaChain: 0 })), 'limit_exceeded', 'delta chain depth');
  assert.equal(describePack(pack, withLimits({ maxDeltaResult: target.length })).ok, true);
  refused(describePack(pack, withLimits({ maxDeltaResult: target.length - 1 })), 'limit_exceeded', 'delta result size');
  refused(describePack(pack, withLimits({ maxPackObjects: Number.NaN })), 'bad_request', 'maxPackObjects');
  const missing = { ...DEFAULT_LIMITS };
  delete missing.maxObjectSize;
  refused(describePack(pack, missing), 'bad_request', 'maxObjectSize');

  const badVer = pack.slice();
  badVer[7] = 3;
  refused(describePack(badVer), 'pack_corrupt', undefined);
  const bad = describePack(badVer);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.message, 'pack: unsupported version 3');
});
