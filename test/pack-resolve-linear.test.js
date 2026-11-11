// resolvePack's cost and its stack. A pack's deltas may arrive in any order (a REF_DELTA before its base, an OFS chain
// resting on a REF_DELTA whose base is later still), so the resolver's work must not depend on the order: every entry is
// visited a constant number of times, a chain of any configured length is walked without recursion, and the Result is
// never a thrown RangeError. Oracles: node:crypto for ids, node:zlib for the pack bytes, `git index-pack` plus
// `git cat-file --batch` for what the pack holds; the step bounds are worked out by hand below.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parsePack, resolvePack, describePack } from '../src/packresolve.js';
import { withLimits } from '../src/limits.js';
import { gitBuf, git, tmpRoot } from './server.js';

const BLOB = 3; // gitformat-pack: OBJ_BLOB
const OFS = 6;
const REF = 7;
const sha1 = (type, data) => createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest();
const content = i => Buffer.from(`c${String(i).padStart(9, '0')}\n`);
// A delta that copies nothing: the source size, the result size, one insert of the whole result (11 bytes, under 127).
const replaceDelta = (srcLen, bytes) => Uint8Array.of(srcLen, bytes.length, bytes.length, ...bytes);
const objHeader = (type, size) => { let b = (type << 4) | (size & 15); let rest = size >> 4; const out = []; while (rest) { out.push(b | 0x80); b = rest & 0x7f; rest >>= 7; } out.push(b); return out; };
const ofsDistance = d => { const out = [d & 0x7f]; let rest = d >> 7; while (rest) { rest -= 1; out.unshift(0x80 | (rest & 0x7f)); rest >>= 7; } return out; };
class Pack {
  parts = []; at = 12; n = 0;
  add(type, data, base = {}) {
    const offset = this.at;
    const head = type === OFS ? [...objHeader(OFS, data.length), ...ofsDistance(offset - base.ofs)] : type === REF ? [...objHeader(REF, data.length), ...base.ref] : objHeader(type, data.length);
    const b = Buffer.concat([Buffer.from(head), deflateSync(data, { level: 1 })]);
    this.parts.push(b); this.at += b.length; this.n++;
    return offset;
  }
  build() {
    const h = Buffer.alloc(12); h.write('PACK'); h.writeUInt32BE(2, 4); h.writeUInt32BE(this.n, 8);
    const body = Buffer.concat([h, ...this.parts]);
    return new Uint8Array(Buffer.concat([body, createHash('sha1').update(body).digest()]));
  }
}
// content(0) whole; a REF chain content(1..K), each on the one before by id; an OFS chain content(K+1..K+D) on the top of
// it; M leaves content(K+D+1..K+D+M), each an OFS delta on the end of the OFS chain. Adverse: the REF chain is emitted
// top first and the whole base after it, so every REF delta precedes its base and every OFS delta waits on all of them.
function shape(K, D, M, adverse) {
  const p = new Pack();
  const refAt = [];
  const ref = i => { refAt[i] = p.add(REF, replaceDelta(content(i - 1).length, content(i)), { ref: sha1('blob', content(i - 1)) }); };
  if (adverse) { for (let i = K; i >= 1; i--) ref(i); p.add(BLOB, content(0)); } else { p.add(BLOB, content(0)); for (let i = 1; i <= K; i++) ref(i); }
  let prev = refAt[K];
  for (let i = K + 1; i <= K + D; i++) prev = p.add(OFS, replaceDelta(content(i - 1).length, content(i)), { ofs: prev });
  for (let m = 1; m <= M; m++) p.add(OFS, replaceDelta(content(K + D).length, content(K + D + m)), { ofs: prev });
  return { pack: p.build(), count: 1 + K + D + M };
}
const resolved = (pack, limits) => { const parsed = parsePack(pack, { limits }); assert.ok(parsed.ok, JSON.stringify(parsed)); return resolvePack(parsed.value, undefined, limits); };

for (const adverse of [true, false]) {
  test(`resolvePack's work is linear in the pack's entries, REF chain ${adverse ? 'child-first (adverse)' : 'base-first'}`, () => {
    const limits = withLimits({ maxDeltaChain: 200 });
    // every dimension doubled: the REF chain, the OFS chain on it, the leaves
    const small = shape(30, 30, 500, adverse);
    const large = shape(60, 60, 1000, adverse);
    const a = resolved(small.pack, limits);
    const b = resolved(large.pack, limits);
    assert.ok(a.ok && b.ok);
    assert.equal(a.value.objects.size, small.count);
    assert.equal(b.value.objects.size, large.count);
    // by hand: a REF_DELTA's base is looked up by id once, and the pack has K of them
    assert.equal(a.value.stats.baseLookups, 30);
    assert.equal(b.value.stats.baseLookups, 60);
    // by hand: an entry is visited once in pack order and at most once more when the base it waited on lands
    assert.ok(a.value.stats.steps >= small.count && a.value.stats.steps <= 2 * small.count, `steps ${a.value.stats.steps} for ${small.count} entries`);
    assert.ok(b.value.stats.steps >= large.count && b.value.stats.steps <= 2 * large.count, `steps ${b.value.stats.steps} for ${large.count} entries`);
    // twice the entries (1.97x), at most 2.5x the work
    const ratio = b.value.stats.steps / a.value.stats.steps;
    assert.ok(ratio <= 2.5, `steps grew ${ratio}x for ${large.count / small.count}x the entries`);
  });
}

test('resolvePack agrees with git index-pack and cat-file on every id and every content, both orders', () => {
  const { root, cleanup } = tmpRoot();
  try {
    for (const adverse of [true, false]) oracle(root, adverse);
  } finally {
    cleanup();
  }
});
function oracle(root, adverse) {
  {
    const { pack, count } = shape(32, 31, 300, adverse); // the leaves are 64 deltas deep: the default maxDeltaChain exactly
    const r = resolved(pack);
    assert.ok(r.ok, JSON.stringify(r));
    const repo = `${root}/oracle-${adverse ? 'adverse' : 'benign'}.git`;
    git(root, ['init', '-q', '--bare', repo]);
    gitBuf(repo, ['index-pack', '--stdin'], pack);
    const out = gitBuf(repo, ['cat-file', '--batch-all-objects', '--batch']);
    const fromGit = new Map();
    for (let at = 0; at < out.length;) {
      const nl = out.indexOf(10, at);
      const [oid, type, size] = out.subarray(at, nl).toString().split(' ');
      fromGit.set(oid, { type, data: out.subarray(nl + 1, nl + 1 + Number(size)) });
      at = nl + 1 + Number(size) + 1;
    }
    assert.equal(fromGit.size, count);
    assert.equal(r.value.objects.size, count);
    for (const [oid, o] of fromGit) {
      const mine = r.value.objects.get(oid);
      assert.ok(mine, `${oid} is in git's index and not in resolvePack's result`);
      assert.equal(o.type, 'blob');
      assert.equal(mine.type, BLOB);
      assert.ok(o.data.equals(mine.data), `${oid} differs`);
    }
    assert.equal(r.value.stats.maxChain, 64);
  }
}

// The finding's shape at 100,000 links, hand-built (resolvePack takes plain objects): three REF deltas emitted child
// first, the whole base, then an OFS chain on the top REF delta. The old resolver recursed two frames per link.
function deepChain(D, order) {
  const oidHex = i => sha1('blob', content(i)).toString('hex');
  const objects = [];
  for (const i of [3, 2, 1]) objects.push({ offset: 100 + i, type: REF, data: replaceDelta(content(i - 1).length, content(i)), base: { tag: 'ref', oid: oidHex(i - 1) } });
  objects.push({ offset: 100, type: BLOB, data: content(0) });
  const chain = [];
  for (let i = 4; i <= D + 3; i++) chain.push({ offset: 100 + i, type: OFS, data: replaceDelta(content(i - 1).length, content(i)), base: { tag: 'ofs', offset: 100 + i - 1 } });
  if (order === 'deepest-first') chain.reverse();
  return { objects: [...objects, ...chain], last: oidHex(D + 3) };
}
for (const order of ['base-first', 'deepest-first']) {
  test(`a 100,000-link OFS chain on a late REF base resolves under a raised limit and is limit_exceeded under the default: never thrown (${order})`, () => {
    const D = 100_000;
    const { objects, last } = deepChain(D, order);
    // the aggregate cap charges LIMIT_OBJECT_OVERHEAD per object: 100,004 objects need more than the default 256 MiB
    const r = resolvePack({ objects }, undefined, withLimits({ maxDeltaChain: D + 3, maxInflatedTotal: 2 ** 30 }));
    assert.ok(r.ok, JSON.stringify(r.ok ? null : r.error));
    assert.equal(r.value.objects.size, D + 4);
    const deepest = r.value.objects.get(last);
    assert.ok(deepest);
    assert.equal(deepest.chain, D + 3);
    assert.ok(Buffer.from(deepest.data).equals(content(D + 3)));
    assert.equal(r.value.stats.maxChain, D + 3);
    assert.ok(r.value.stats.steps <= 2 * (D + 4), `steps ${r.value.stats.steps}`);
    // the default chain limit (64), by hand: the 65th delta above the whole base is the first one refused
    const refused = resolvePack({ objects }, undefined, withLimits({ maxInflatedTotal: 2 ** 30 }));
    assert.ok(!refused.ok);
    assert.deepEqual([refused.error.code, refused.error.what, refused.error.got, refused.error.max], ['limit_exceeded', 'delta chain depth', 65, 64]);
  });
}

test('describePack reports a 20,000-link chain without recursing, its base in the pack or thin', () => {
  const D = 20_000;
  const limits = withLimits({ maxDeltaChain: D + 3 });
  const inPack = shape(3, D, 0, true);
  const full = describePack(inPack.pack, limits);
  assert.ok(full.ok, JSON.stringify(full.ok ? null : full.error));
  assert.equal(full.value.objects.length, D + 4);
  assert.equal(full.value.objects.at(-1).depth, D + 3);
  assert.equal(full.value.objects.at(-1).oid, sha1('blob', content(D + 3)).toString('hex'));
  // thin: one REF delta on a base that is not in the pack, the OFS chain on it. Depth as verify-pack prints it once the
  // base is appended: the REF delta 1, each OFS link one more.
  const p = new Pack();
  let prev = p.add(REF, replaceDelta(content(0).length, content(1)), { ref: sha1('blob', content(0)) });
  for (let i = 2; i <= D + 1; i++) prev = p.add(OFS, replaceDelta(content(i - 1).length, content(i)), { ofs: prev });
  const thin = describePack(p.build(), limits);
  assert.ok(thin.ok, JSON.stringify(thin.ok ? null : thin.error));
  assert.deepEqual(thin.value.missingBases, [sha1('blob', content(0)).toString('hex')]);
  assert.equal(thin.value.objects.at(-1).depth, D + 1);
  assert.equal(thin.value.objects.at(-1).oid, null);
  // under the default limit the same thin pack is refused with the coded error
  const refused = describePack(p.build());
  assert.ok(!refused.ok);
  assert.equal(refused.error.code, 'limit_exceeded');
});

// ---- the leftover-wait chain bound, at its boundary (wire packs through parsePack) ----
// A thin pack: one REF_DELTA on content(0), which is not in the pack, and `ofsCount` OFS deltas in a chain on it. Depth
// is counted in deltas above the base (the REF_DELTA 1, the k-th OFS delta k + 1), as `git verify-pack -v` prints it.
function thinChain(ofsCount) {
  const p = new Pack();
  let prev = p.add(REF, replaceDelta(content(0).length, content(1)), { ref: sha1('blob', content(0)) });
  for (let i = 2; i <= ofsCount + 1; i++) prev = p.add(OFS, replaceDelta(content(i - 1).length, content(i)), { ofs: prev });
  return p.build();
}
const counting = lookup => { const asked = []; return { asked, external: oid => { asked.push(oid); return lookup(oid); } }; };
const coded = r => [r.error.code, r.error.what, r.error.got, r.error.max];
test('a thin REF root with maxDeltaChain OFS deltas on it is a missing base; one more OFS delta is past the chain limit before the base is asked for', () => {
  const CHAIN = 64; // DEFAULT_LIMITS.maxDeltaChain
  const base = sha1('blob', content(0)).toString('hex');
  // Expected values are not read off the new resolver: they are what main at ec337c5 (the recursive resolver) returns
  // for these same wire packs, and what the limit means by hand. Root + 64 OFS: the deepest delta is 65 above the base,
  // one past the limit, so it can only be refused once the base is there to patch on; with the base withheld the pack's
  // defect is the missing base (pack_corrupt 'not found'; describePack: ok, one missing base, depth 65 as verify-pack
  // would print it). Root + 65 OFS: the deepest is 66 above the base, and its own OFS base (65 above) is already past
  // the limit whatever the root turns out to be, so it is limit_exceeded 65/64 and the lookup is never called.
  {
    const pack = thinChain(CHAIN);
    const parsed = parsePack(pack);
    assert.ok(parsed.ok);
    const withheld = counting(() => null);
    const r = resolvePack(parsed.value, withheld.external);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'pack_corrupt');
    assert.equal(r.error.message, `pack: ref delta base ${base} not found`);
    assert.deepEqual(withheld.asked, [base]);
    const d = describePack(pack);
    assert.ok(d.ok, JSON.stringify(d.ok ? null : d.error));
    assert.deepEqual(d.value.missingBases, [base]);
    assert.equal(d.value.objects.length, CHAIN + 1);
    assert.equal(d.value.objects.at(-1).depth, CHAIN + 1);
    // the base given: the 65th delta is refused by the patch
    const given = counting(oid => (oid === base ? { type: BLOB, data: new Uint8Array(content(0)) } : null));
    const g = resolvePack(parsed.value, given.external);
    assert.ok(!g.ok);
    assert.deepEqual(coded(g), ['limit_exceeded', 'delta chain depth', CHAIN + 1, CHAIN]);
    assert.deepEqual(given.asked, [base]);
  }
  {
    const pack = thinChain(CHAIN + 1);
    const parsed = parsePack(pack);
    assert.ok(parsed.ok);
    for (const lookup of [() => null, oid => (oid === base ? { type: BLOB, data: new Uint8Array(content(0)) } : null)]) {
      const c = counting(lookup);
      const r = resolvePack(parsed.value, c.external);
      assert.ok(!r.ok);
      assert.deepEqual(coded(r), ['limit_exceeded', 'delta chain depth', CHAIN + 1, CHAIN]);
      assert.deepEqual(c.asked, []);
    }
    const d = describePack(pack);
    assert.ok(!d.ok);
    assert.deepEqual(coded(d), ['limit_exceeded', 'delta chain depth', CHAIN + 1, CHAIN]);
  }
});

// ---- hand-built input parsePack cannot produce ----
const blobId = i => sha1('blob', content(i)).toString('hex');
const ofsAt = (offset, baseOffset, i) => ({ offset, type: OFS, data: replaceDelta(content(i - 1).length, content(i)), base: { tag: 'ofs', offset: baseOffset } });
const refAt = (offset, baseI, i) => ({ offset, type: REF, data: replaceDelta(content(baseI).length, content(i)), base: { tag: 'ref', oid: blobId(baseI) } });
const blobBase = i => ({ type: BLOB, data: new Uint8Array(content(i)) });

test('a cycle of OFS bases (hand-built) is the coded chain-depth error from resolvePack, never a throw', () => {
  // By hand: a cycle of bases is a chain with no end, so it is past maxDeltaChain (64) at its 65th link, and a Result
  // API reports that as a value. parsePack cannot produce one (an OFS base is strictly earlier in the pack).
  const cycles = {
    'self-loop': [ofsAt(10, 10, 1)],
    '2-cycle': [ofsAt(10, 11, 1), ofsAt(11, 10, 2)],
    '3-cycle with a tail': [ofsAt(10, 12, 1), ofsAt(11, 10, 2), ofsAt(12, 11, 3), ofsAt(13, 10, 4), ofsAt(14, 13, 5)],
    'a tail first, then the cycle it rests on': [ofsAt(14, 13, 5), ofsAt(13, 10, 4), ofsAt(10, 11, 1), ofsAt(11, 10, 2)],
    'a cycle beside a whole object and its delta': [{ offset: 1, type: BLOB, data: content(0) }, ofsAt(2, 1, 1), ofsAt(10, 11, 1), ofsAt(11, 10, 2)],
  };
  for (const [name, objects] of Object.entries(cycles)) {
    const c = counting(() => null);
    let r;
    assert.doesNotThrow(() => { r = resolvePack({ objects }, c.external); }, name);
    assert.ok(!r.ok, name);
    assert.deepEqual(coded(r), ['limit_exceeded', 'delta chain depth', 65, 64], name);
    assert.deepEqual(c.asked, [], name);
  }
});

test('two entries hand-built at one offset are one object: the second thin REF delta at a resolved offset is not patched or counted', () => {
  // An offset names one object, so the first entry at it is that object (the rule the resolver states for every other
  // phase, and main at ec337c5's result for this input: 1 object, externalBases 1). By hand: one external base used once.
  const c = counting(oid => (oid === blobId(9) ? blobBase(9) : null));
  const r = resolvePack({ objects: [refAt(2, 9, 1), refAt(2, 9, 2)] }, c.external);
  assert.ok(r.ok, JSON.stringify(r.ok ? null : r.error));
  assert.deepEqual([...r.value.objects.keys()], [blobId(1)]);
  assert.equal(r.value.stats.externalBases, 1);
  assert.equal(r.value.stats.maxChain, 1);
  assert.deepEqual(c.asked, [blobId(9)]);
  // the same rule where the base is in the pack: a second whole object, a second delta already resolved, a second
  // delta that waited (filed under a base that lands later)
  const twoFull = resolvePack({ objects: [{ offset: 1, type: BLOB, data: content(0) }, { offset: 1, type: BLOB, data: content(1) }] });
  assert.ok(twoFull.ok);
  assert.deepEqual([...twoFull.value.objects.keys()], [blobId(0)]);
  const twoDeltas = resolvePack({ objects: [{ offset: 1, type: BLOB, data: content(0) }, ofsAt(2, 1, 1), { ...ofsAt(2, 1, 1), data: replaceDelta(content(0).length, content(2)) }] });
  assert.ok(twoDeltas.ok);
  assert.deepEqual([...twoDeltas.value.objects.keys()], [blobId(0), blobId(1)]);
  const twoWaiting = resolvePack({ objects: [refAt(2, 0, 1), refAt(2, 0, 2), { offset: 1, type: BLOB, data: content(0) }] });
  assert.ok(twoWaiting.ok);
  assert.deepEqual([...twoWaiting.value.objects.keys()], [blobId(0), blobId(1)]);
  // two deltas at offset 3 filed under the delta at offset 2, which resolves after them: the first is the object
  const twoFiled = resolvePack({ objects: [ofsAt(3, 2, 2), { ...ofsAt(3, 2, 2), data: replaceDelta(content(1).length, content(3)) }, refAt(2, 0, 1), { offset: 1, type: BLOB, data: content(0) }] });
  assert.ok(twoFiled.ok);
  assert.deepEqual([...twoFiled.value.objects.keys()], [blobId(0), blobId(1), blobId(2)]);
});

test('`external` is asked once per distinct missing base id, in pack order, however many deltas wait on it', () => {
  // By hand: 3 deltas wait on content(7), 2 on content(8), 1 on content(9): three ids, so three calls, in the order
  // their first REF_DELTA appears in the pack, whether the lookup has the base or not.
  const objects = [refAt(1, 7, 1), refAt(2, 8, 2), refAt(3, 7, 3), refAt(4, 9, 4), refAt(5, 7, 5), refAt(6, 8, 6)];
  const order = [blobId(7), blobId(8), blobId(9)];
  const have = counting(oid => (order.includes(oid) ? blobBase(order.indexOf(oid) + 7) : null));
  const r = resolvePack({ objects }, have.external);
  assert.ok(r.ok, JSON.stringify(r.ok ? null : r.error));
  assert.equal(r.value.objects.size, 6);
  assert.equal(r.value.stats.externalBases, 6);
  assert.deepEqual(have.asked, order);
  const none = counting(() => null);
  const refused = resolvePack({ objects }, none.external);
  assert.ok(!refused.ok);
  assert.equal(refused.error.message, `pack: ref delta base ${blobId(7)} not found`);
  assert.deepEqual(none.asked, order);
  // one id has it, the others do not: still one call each
  const some = counting(oid => (oid === blobId(8) ? blobBase(8) : null));
  const partly = resolvePack({ objects }, some.external);
  assert.ok(!partly.ok);
  assert.deepEqual(some.asked, order);
});

test('a thin REF delta whose bytes do not apply to the base `external` gives is the patch error, not a missing base and not ok', () => {
  // By the pack format a delta opens with the size of the base it was made against; this one says 12 for an 11-byte
  // base, so no object can be built from it. The base was found, so the defect is the delta: main at ec337c5 returns
  // pack_corrupt 'delta: base size 12 != 11' for each of these inputs (not `ref delta base … not found`). The base is
  // asked for once: one id (the rule pinned above; main asked once per waiting delta).
  const BAD_DELTA = 'delta: base size 12 != 11';
  const bad ={ offset: 2, type: REF, data: replaceDelta(content(9).length + 1, content(1)), base: { tag: 'ref', oid: blobId(9) } };
  for (const objects of [[bad], [bad, ofsAt(3, 2, 2)], [refAt(1, 9, 3), bad]]) {
    const c = counting(oid => (oid === blobId(9) ? blobBase(9) : null));
    let r;
    assert.doesNotThrow(() => { r = resolvePack({ objects }, c.external); });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'pack_corrupt');
    assert.equal(r.error.message, BAD_DELTA);
    assert.deepEqual(c.asked, [blobId(9)]);
  }
});

test('a REF delta whose base is built from an external base is in the pack after all: `external` is not asked for it', () => {
  // By hand: content(1) is made in this pack (a REF delta on content(9), which the caller holds), so the second delta's
  // base is not missing and only content(9) is asked for. Main at ec337c5 asks [content(9)] too.
  for (const objects of [[refAt(2, 9, 1), refAt(3, 1, 2)], [refAt(2, 9, 1), refAt(3, 1, 2), refAt(4, 2, 3), ofsAt(5, 4, 4)]]) {
    const c = counting(oid => (oid === blobId(9) ? blobBase(9) : null));
    const r = resolvePack({ objects }, c.external);
    assert.ok(r.ok, JSON.stringify(r.ok ? null : r.error));
    assert.deepEqual(c.asked, [blobId(9)]);
    assert.equal(r.value.objects.size, objects.length);
    assert.equal(r.value.stats.externalBases, 1);
  }
});

test('stats.steps on thin packs is the count the visit rule gives: three per delta that waits on an external base, one per object that does not wait', () => {
  // The rule (README, stats.steps): a whole object is visited once; a delta whose base has resolved when it is reached
  // is visited once (patched); a delta that waits is visited three times: filed, walked once to the id it waits on,
  // patched once the base is given. The expected numbers below are that rule applied to each pack's shape by hand.
  {
    // one thin REF root and 2,000 OFS deltas in a chain above it: 2,001 deltas, all waiting on the one external base
    const K = 2000;
    const objects = [refAt(100, 0, 1)];
    for (let i = 2; i <= K + 1; i++) objects.push(ofsAt(99 + i, 98 + i, i));
    const c = counting(oid => (oid === blobId(0) ? blobBase(0) : null));
    const r = resolvePack({ objects }, c.external, withLimits({ maxDeltaChain: 1e6 }));
    assert.ok(r.ok, JSON.stringify(r.ok ? null : r.error));
    assert.equal(r.value.objects.size, K + 1);
    assert.equal(r.value.stats.steps, 3 * (K + 1));
    assert.equal(r.value.stats.maxChain, K + 1);
    assert.deepEqual(c.asked, [blobId(0)]);
  }
  {
    // 10 whole blobs, each with a 5-delta OFS chain after it (60 objects that never wait: 60 steps), then 3 thin REF
    // roots, each with 4 OFS deltas above it (15 deltas that wait: 45 steps)
    const objects = [];
    let at = 1, next = 100;
    for (let g = 0; g < 10; g++) {
      objects.push({ offset: at, type: BLOB, data: content(next++) });
      for (let j = 0; j < 5; j++) { objects.push(ofsAt(at + 1, at, next++)); at++; }
      at++;
    }
    const bases = [900, 901, 902];
    for (const b of bases) {
      objects.push(refAt(at, b, next++));
      for (let j = 0; j < 4; j++) { objects.push(ofsAt(at + 1, at, next++)); at++; }
      at++;
    }
    const c = counting(oid => { const i = bases.findIndex(b => blobId(b) === oid); return i < 0 ? null : blobBase(bases[i]); });
    const r = resolvePack({ objects }, c.external);
    assert.ok(r.ok, JSON.stringify(r.ok ? null : r.error));
    assert.equal(r.value.objects.size, 75);
    assert.equal(r.value.stats.steps, 60 + 3 * 15);
    assert.equal(r.value.stats.externalBases, 3);
    assert.equal(r.value.stats.maxChain, 5);
    assert.deepEqual(c.asked, bases.map(blobId));
  }
});

test('every REF delta filed under an id `external` gives is patched on that base, also when the pack then builds that id itself', () => {
  // Hand-built (parsePack can produce the shape from wire bytes; git does not write it):
  //   REF@2 on c9 -> c1,  OFS@3 on offset 2 -> c9,  REF@4 on c9 -> c5,   `external` holds c9 only.
  // Nothing resolves from the pack alone, so c9 is asked for, once. Both REF deltas were filed under c9 before it was
  // asked for, and the README rule is that every REF_DELTA waiting on an id `external` gives is patched directly on that
  // base. Applied by hand: @2 is one delta above the given c9 (chain 1, external base 1); landing it lets @3 resolve on
  // it, which builds c9 again inside the pack (chain 2); @4 is still patched on the given base (chain 1, external base
  // 2), not on the pack's copy at @3 (which would be chain 3 and external base 1). So: 3 objects, externalBases 2,
  // maxChain 2, c5 at chain 1, and a limit of 2 deltas is enough. Ids are node:crypto's.
  // ofsAt(offset, baseOffset, i) writes content(i - 1).length as its delta's source size while the base here is
  // content(1): every content(i) is 11 bytes, so the size matches and the delta applies.
  assert.equal(content(8).length, content(1).length);
  const objects = [refAt(2, 9, 1), ofsAt(3, 2, 9), refAt(4, 9, 5)];
  for (const limits of [undefined, withLimits({ maxDeltaChain: 2 })]) {
    const c = counting(oid => (oid === blobId(9) ? blobBase(9) : null));
    const r = resolvePack({ objects }, c.external, limits);
    assert.ok(r.ok, JSON.stringify(r.ok ? null : r.error));
    assert.deepEqual(c.asked, [blobId(9)]);
    assert.equal(r.value.objects.size, 3);
    assert.deepEqual([...r.value.objects.keys()].sort(), [blobId(1), blobId(5), blobId(9)].sort());
    assert.equal(r.value.stats.externalBases, 2);
    assert.equal(r.value.stats.maxChain, 2);
    assert.equal(r.value.objects.get(blobId(5)).chain, 1);
  }
});
