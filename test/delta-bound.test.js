// A delta that asks for a huge result must die before the output buffer exists, and the largest
// expansion the caps allow is the one SAFETY.md I4 records. A chain is at most maxDeltaChain deltas in any pack order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDelta, parsePack, resolvePack, makeDelta } from '../src/packresolve.js';
import { encodeVarint, encodeObjHeader, zlibDeflate } from '../src/pack.js';
import { DEFAULT_LIMITS, withLimits } from '../src/limits.ts';
import {
  DELTA_COPY, DELTA_COPY_MAX, PACK_SIGNATURE, PACK_VERSION, PACK_HEADER_BYTES, UINT32_BYTES,
  OBJ_CONTINUE, OBJ_SIZE_NEXT_MASK, OBJ_SIZE_NEXT_BASE,
} from '../src/format.js';
import { hashObject, TYPE } from '../src/objects.js';
import { Sha1, fromHex } from '../src/sha1.js';
import { concat, te } from '../src/bytes.js';

const MAX = DEFAULT_LIMITS.maxDeltaResult;

test('the densest in-limit delta expands a 64 KiB base to maxDeltaResult and no further', () => {
  assert.equal(MAX % DELTA_COPY_MAX, 0);
  const copies = MAX / DELTA_COPY_MAX;
  const base = new Uint8Array(DELTA_COPY_MAX);
  base[0] = 7;
  const header = concat([encodeVarint(base.length), encodeVarint(MAX)]);
  const ops = new Uint8Array(copies);
  ops.fill(DELTA_COPY);
  const delta = concat([header, ops]);
  assert.equal(header.length, 7);
  assert.equal(delta.length, 1031);
  const { out } = applyDelta(base, delta);
  assert.equal(out.length, MAX);
  assert.equal(out[0], 7);
  assert.equal(out[DELTA_COPY_MAX], 7);
  assert.equal(Math.floor(MAX / delta.length), 65091);
  assert.throws(
    () => applyDelta(base, concat([encodeVarint(base.length), encodeVarint(MAX + 1), Uint8Array.of(DELTA_COPY)])),
    e => e.code === 'limit_exceeded' && e.got === MAX + 1 && e.max === MAX,
  );
});

// ---- chain length (#14) ----
// A chain of `n` deltas over 'v0' → 'v1' → … → 'vn'. Every object is distinct, so every oid is.
const CHAIN = DEFAULT_LIMITS.maxDeltaChain;
const versions = n => Array.from({ length: n + 1 }, (_, i) => te.encode(`v${i} `.repeat(4)));

// gitformat-pack's OFS_DELTA offset: big-endian 7-bit groups, each continued group biased by one (readOfsDelta's inverse).
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
    parts.push(entry); at += entry.length;
  }
  const body = concat(parts);
  return parsePack(concat([body, new Sha1().update(body).digest()]));
}

// n REF_DELTAs, each naming the previous version. childFirst puts the full object last and the tip first.
function refChain(n, childFirst) {
  const v = versions(n);
  const entries = [{ type: TYPE.BLOB, data: v[0] }];
  for (let i = 1; i <= n; i++) entries.push({ data: makeDelta(v[i - 1], v[i]).delta, baseOid: hashObject('blob', v[i - 1]) });
  return { v, entries: childFirst ? entries.reverse() : entries };
}

// n OFS_DELTAs, each against the entry before it (an OFS base is always earlier, so only base-first exists).
function ofsChain(n) {
  const v = versions(n);
  const entries = [{ type: TYPE.BLOB, data: v[0] }];
  for (let i = 1; i <= n; i++) entries.push({ data: makeDelta(v[i - 1], v[i]).delta, baseIndex: i - 1 });
  return { v, entries };
}

const tooLong = (n, max = CHAIN) => e => {
  assert.equal(e.code, 'limit_exceeded');
  assert.equal(e.what, 'delta chain depth');
  assert.equal(e.got, max + 1, `${n}-delta chain stops at the first link past the cap`);
  assert.equal(e.max, max);
  return true;
};

function resolvesWhole(parsed, v, n, external) {
  const r = resolvePack(parsed, external);
  assert.equal(r.objects.size, external ? n : n + 1);
  assert.equal(r.stats.maxChain, n);
  const tip = r.objects.get(hashObject('blob', v[n]));
  assert.equal(tip.chain, n);
  assert.deepEqual(tip.data, v[n]);
}

test('a delta chain of exactly maxDeltaChain resolves in every order', async () => {
  assert.equal(CHAIN, 64);
  for (const childFirst of [false, true]) {
    const { v, entries } = refChain(CHAIN, childFirst);
    resolvesWhole(await packOf(entries), v, CHAIN);
  }
  const { v, entries } = ofsChain(CHAIN);
  resolvesWhole(await packOf(entries), v, CHAIN);
});

test('maxDeltaChain + 1 deltas are limit_exceeded in every order', async () => {
  for (const childFirst of [false, true]) {
    const { entries } = refChain(CHAIN + 1, childFirst);
    const parsed = await packOf(entries);
    assert.throws(() => resolvePack(parsed), tooLong(CHAIN + 1));
  }
  const parsed = await packOf(ofsChain(CHAIN + 1).entries);
  assert.throws(() => resolvePack(parsed), tooLong(CHAIN + 1));
});

// Issue #14's probes. Base-first, a memoised base came back at depth 0, so 500 links resolved (stats.maxChain = 500).
// Child-first, the fixpoint stopped after maxDeltaChain passes and returned 65 of 101 objects with no error.
test('#14 a 500-delta chain emitted base-first is limit_exceeded (REF and OFS)', async () => {
  const ref = await packOf(refChain(500, false).entries);
  assert.throws(() => resolvePack(ref), tooLong(500));
  const ofs = await packOf(ofsChain(500).entries);
  assert.throws(() => resolvePack(ofs), tooLong(500));
});

test('#14 a 101-object chain emitted child-first is limit_exceeded, not 65 objects', async () => {
  const parsed = await packOf(refChain(100, true).entries);
  assert.equal(parsed.objects.length, 101);
  assert.throws(() => resolvePack(parsed), tooLong(100));
});

// An OFS chain standing on a thin REF_DELTA: until external bases are allowed, every OFS link recurses through all the
// unresolved links below it, so recursion depth (not a memoised chain) is what stops a long one, before the stack does.
test('an OFS chain over a thin REF root is bounded by recursion depth', async () => {
  const ofsOverThin = async n => {
    const v = versions(n);
    const entries = [{ data: makeDelta(v[0], v[1]).delta, baseOid: hashObject('blob', v[0]) }];
    for (let i = 2; i <= n; i++) entries.push({ data: makeDelta(v[i - 1], v[i]).delta, baseIndex: i - 2 });
    const base = { type: TYPE.BLOB, data: v[0] };
    return { v, parsed: await packOf(entries), external: oid => (oid === hashObject('blob', v[0]) ? base : undefined) };
  };
  const ok = await ofsOverThin(CHAIN);
  resolvesWhole(ok.parsed, ok.v, CHAIN, ok.external);
  const over = await ofsOverThin(CHAIN + 1);
  assert.throws(() => resolvePack(over.parsed, over.external), tooLong(CHAIN + 1));
  const deep = await ofsOverThin(20_000); // without the depth check: RangeError (call stack), outside the taxonomy
  assert.throws(() => resolvePack(deep.parsed, deep.external), tooLong(20_000));
});

// Thin packs: a missing base is pack_corrupt (the pack is incomplete), a long chain is limit_exceeded (the pack is too
// deep). An external base is chain 0, and switching to external bases costs one pass, which used to come out of the
// pass ceiling: a child-first thin chain of maxDeltaChain lost its last link silently.
test('thin chains: external base is link 0, a missing base is pack_corrupt, too long is limit_exceeded', async () => {
  const thin = async (n, childFirst) => {
    const { v, entries } = refChain(n, childFirst);
    const base = { type: TYPE.BLOB, data: v[0] };
    return { v, parsed: await packOf(entries.filter(e => e.type === undefined)), external: oid => (oid === hashObject('blob', v[0]) ? base : undefined) };
  };
  for (const childFirst of [false, true]) {
    const ok = await thin(CHAIN, childFirst);
    resolvesWhole(ok.parsed, ok.v, CHAIN, ok.external);
    assert.equal(resolvePack(ok.parsed, ok.external).stats.externalBases, 1);
    assert.throws(() => resolvePack(ok.parsed), e => e.code === 'pack_corrupt' && /ref delta base [0-9a-f]{40} not found/.test(e.message));
    const long = await thin(CHAIN + 1, childFirst);
    assert.throws(() => resolvePack(long.parsed, long.external), tooLong(CHAIN + 1));
  }
});

test('maxDeltaChain is the bound as configured, not a constant', async () => {
  for (const childFirst of [false, true]) {
    const { v, entries } = refChain(3, childFirst);
    const parsed = await packOf(entries);
    assert.equal(resolvePack(parsed, undefined, withLimits({ maxDeltaChain: 3 })).stats.maxChain, 3);
    assert.throws(() => resolvePack(parsed, undefined, withLimits({ maxDeltaChain: 2 })), tooLong(3, 2));
    assert.equal(v.length, 4);
  }
});
