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
