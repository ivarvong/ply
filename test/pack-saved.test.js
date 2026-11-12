// Saved pack index (#260): encodeSavedIndex / decodeSavedIndex and loadTransferPack.
//   - round trip, REF-only and OFS packs, with and without resolved columns, oids on and off: every column, every
//     entry view, find() and the resolver's stats come back equal; a transfer planned from the decoded index is the
//     one planned from a fresh scan
//   - size: exactly 64 + 31/entry (+20 oids, +20 REF bases, +37 resolved, +72 stats) + 20 bytes
//   - refusals, each its own tag: not a saved index, another version, every truncation length, every single-byte
//     corruption (the check), another pack (trailer, length), and each malformed field with a valid check
//   - encode refusals: an index short of its header count, resolved columns of another length, no trailer
//   - loadTransferPack: none → scanned; saved → used, reading only the spool's last 20 bytes; no resolved columns →
//     resolved again; stale / corrupt / truncated / foreign saved bytes → scanned, with the refusal on the result and
//     the span; a spool too small for a pack, a spool whose read fails, a spool that is not a pack
//   - a resumed transfer whose every request loads the saved index reaches the head a fresh one does, at every step
//     boundary, against git http-backend with fsck on
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomFillSync, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, fsckProblems, initRepo } from './server.js';
import { scanPackIndex, scannedPackOf } from '../src/packscanindex.js';
import { resolvePackRange } from '../src/packrangeresolve.js';
import { rangeFromBytes } from '../src/rangesource.js';
import { createTransport } from '../src/http.js';
import { planTransfer } from '../src/transferplan.js';
import { runTransfer } from '../src/transfer.js';
import { encodeSavedIndex, decodeSavedIndex, describeRefusal, packIdentity, SAVED_INDEX_VERSION, SAVED_INDEX_ENTRY_BYTES, SAVED_INDEX_FIXED_BYTES } from '../src/packsaved.js';
import { loadTransferPack } from '../src/transferload.js';
import { Sha1 } from '../src/sha1.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { some, none } from '../src/result.js';
import { unwrap } from './unwrap.js';
import { settledWithin, stallAt, abortedBefore, codeOf } from './abortcells.js';

const must = r => { if (r.ok) return r.value; throw Object.assign(new Error(r.error.message ?? JSON.stringify(r.error)), { code: r.error.code }); };
const streamOf = bytes => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
const ident = ['-c', 'user.name=Ann Author', '-c', 'user.email=ann@x'];
const REF = 'refs/heads/main';
const BUDGET = { maxRequestBytes: 200_000, maxObjects: 300, maxObjectBytes: 1 << 20, maxCompressedObjectBytes: 1 << 20, reserveBytes: 0, reserveObjects: 0 };

let root, cleanup, srv, n = 0, work, src;
before(async () => {
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  work = join(root, 'source');
  mkdirSync(join(work, 'a', 'b'), { recursive: true });
  initRepo(work);
  for (let i = 0; i < 8; i++) {
    const blob = new Uint8Array(40_000 + i * 700);
    randomFillSync(blob);
    writeFileSync(join(work, i % 2 ? 'a' : join('a', 'b'), `r${i}.bin`), blob);
  }
  const base = new Uint8Array(30_000);
  randomFillSync(base);
  for (let v = 0; v < 5; v++) { base[v * 997] ^= 0xff; writeFileSync(join(work, 'a', `chain${v}.bin`), base); }
  writeFileSync(join(work, 'small.txt'), 'hello\n');
  git(work, ['add', '.']);
  git(work, [...ident, 'commit', '-q', '-m', 'saved index']);
  const head = git(work, ['rev-parse', 'HEAD']).trim();
  const objs = git(work, ['rev-list', '--objects', '--no-walk', head]);
  src = {
    head,
    commit: new Uint8Array(gitBuf(work, ['cat-file', 'commit', head])),
    lsTree: git(work, ['ls-tree', '-r', head]),
    packs: {
      ref: new Uint8Array(gitBuf(work, ['pack-objects', '--stdout', '-q', '--depth=50'], objs)),
      ofs: new Uint8Array(gitBuf(work, ['pack-objects', '--stdout', '-q', '--depth=50', '--delta-base-offset'], objs)),
    },
  };
});
after(async () => { await srv?.close(); cleanup?.(); });

const fresh = async (bytes, scan = {}) => {
  const pack = must(await scanPackIndex(streamOf(bytes), scan));
  const source = rangeFromBytes(bytes);
  return { source, pack, resolved: must(await resolvePackRange(pack, source)) };
};
const idOf = from => ({ trailer: from.pack.trailer, bytes: from.pack.bytes });
const COLS = ['offset', 'headerBytes', 'compressed', 'size', 'storedType', 'type', 'baseIndex', 'oids', 'refs'];
const RCOLS = ['oid', 'type', 'base', 'depth', 'size'];
function assertSame(a, b) {
  for (const k of COLS) assert.deepEqual([...b.pack.columns[k]], [...a.pack.columns[k]], k);
  for (const k of ['version', 'count', 'trailer', 'bytes']) assert.equal(b.pack[k], a.pack[k], k);
  assert.deepEqual([...b.pack.entries()], [...a.pack.entries()]);
  assert.deepEqual(b.pack.entry(-1), none);
  assert.deepEqual(b.pack.entry(a.pack.count), none);
}
function assertSameResolved(a, b) {
  for (const k of RCOLS) assert.deepEqual([...b.columns[k]], [...a.columns[k]], k);
  assert.deepEqual(b.stats, a.stats);
  assert.equal(b.count, a.count);
  assert.equal(b.heldBytes, a.heldBytes);
  for (let i = -1; i <= a.count; i++) { assert.deepEqual(b.oid(i), a.oid(i)); assert.deepEqual(b.type(i), a.type(i)); }
  for (let i = 0; i < a.count; i++) { const id = a.oid(i).value; assert.deepEqual(b.find(id), a.find(id)); }
  assert.deepEqual(b.find('0'.repeat(40)), none);
  assert.deepEqual(b.find('not an id'), none);
}
// Rewrite the check after an edit, so only the structural checks can refuse it.
const rechecked = bytes => { const out = Uint8Array.from(bytes); out.set(new Sha1().update(out.subarray(0, out.length - 20)).digest(), out.length - 20); return out; };
const sizeOf = (n, { oids = true, refs = false, resolved = true } = {}) => SAVED_INDEX_FIXED_BYTES - (resolved ? 0 : 72) + n * (SAVED_INDEX_ENTRY_BYTES.index + (oids ? 20 : 0) + (refs ? 20 : 0) + (resolved ? SAVED_INDEX_ENTRY_BYTES.resolved : 0));

test('round trip: REF-only and OFS packs, with and without resolved columns, oids on and off; the stated size', async () => {
  for (const kind of ['ref', 'ofs']) {
    const from = await fresh(src.packs[kind]);
    const refs = kind === 'ref';
    const bytes = must(encodeSavedIndex(from.pack, some(from.resolved)));
    assert.equal(bytes.length, sizeOf(from.pack.count, { refs }), `${kind}: ${bytes.length} B for ${from.pack.count} entries`);
    const back = must(decodeSavedIndex(bytes, idOf(from)));
    assertSame(from, back);
    assertSameResolved(from.resolved, back.resolved.value);
    // a plan from the decoded index is the plan from the fresh one
    assert.deepEqual(must(planTransfer(back.pack, back.resolved.value, { budget: BUDGET, ref: REF, commit: src.commit })), must(planTransfer(from.pack, from.resolved, { budget: BUDGET, ref: REF, commit: src.commit })));
    // without resolved columns
    const bare = must(encodeSavedIndex(from.pack, none));
    assert.equal(bare.length, sizeOf(from.pack.count, { refs, resolved: false }));
    const b2 = must(decodeSavedIndex(bare, idOf(from)));
    assertSame(from, b2);
    assert.deepEqual(b2.resolved, none);
    // encoding is deterministic, and a decoded index encodes to the same bytes
    assert.deepEqual(must(encodeSavedIndex(back.pack, back.resolved)), bytes);
  }
  // oids off (an OFS pack resolves its types without them): no oid column
  const off = await fresh(src.packs.ofs, { oids: false });
  const bytes = must(encodeSavedIndex(off.pack, none));
  assert.equal(bytes.length, sizeOf(off.pack.count, { oids: false, resolved: false }));
  const back = must(decodeSavedIndex(bytes, idOf(off)));
  assertSame(off, back);
  assert.ok([...back.pack.entries()].every(e => e.oid === null));
});

test('refusals: not a saved index, another version, every truncation, every corrupted byte, another pack', async () => {
  const from = await fresh(src.packs.ref);
  const bytes = must(encodeSavedIndex(from.pack, some(from.resolved)));
  const want = idOf(from);
  const tags = {};
  const count = r => { assert.equal(r.ok, false); tags[r.error.tag] = (tags[r.error.tag] ?? 0) + 1; assert.ok(describeRefusal(r.error).length > 0); return r.error; };
  assert.equal(count(decodeSavedIndex(new TextEncoder().encode('PACK and more bytes than a header needs, sixty-four and twenty more bytes in all, so long'), want)).tag, 'not_saved_index');
  assert.equal(count(decodeSavedIndex(new Uint8Array(3), want)).tag, 'not_saved_index');
  const v2 = Uint8Array.from(bytes); v2[4] = SAVED_INDEX_VERSION + 1;
  assert.deepEqual(count(decodeSavedIndex(rechecked(v2), want)), { tag: 'version', version: SAVED_INDEX_VERSION + 1 });
  // every truncation: a prefix of the magic, of the header, of the body
  for (let len = 0; len < bytes.length; len++) {
    const e = count(decodeSavedIndex(bytes.subarray(0, len), want));
    assert.ok(e.tag === 'truncated' || (len === 0 && e.tag === 'truncated'), `len ${len}: ${e.tag}`);
  }
  // every single byte flipped past the version: the check refuses it (or the header it changed says so first)
  for (let i = 6; i < bytes.length; i++) {
    const b = Uint8Array.from(bytes); b[i] ^= 0x01;
    const e = count(decodeSavedIndex(b, want));
    // a flip in the count's top bytes (16-19) claims more entries than maxPackObjects: refused by count first (#299)
    assert.ok(['corrupt', 'truncated'].includes(e.tag) || (e.tag === 'limit_exceeded' && i >= 16 && i < 20), `byte ${i}: ${e.tag}`);
    if (i >= 20) assert.equal(e.tag, 'corrupt', `byte ${i}`);
  }
  // another pack: the trailer, the length
  const other = await fresh(src.packs.ofs);
  assert.equal(count(decodeSavedIndex(bytes, idOf(other))).tag, 'other_pack');
  assert.deepEqual(count(decodeSavedIndex(bytes, { ...want, bytes: want.bytes + 1 })), { tag: 'other_pack', saved: want, want: { ...want, bytes: want.bytes + 1 } });
  assert.ok(tags.truncated >= bytes.length, `${tags.truncated} truncations`);
  assert.equal(tags.corrupt + (tags.truncated - bytes.length) + (tags.limit_exceeded || 0), bytes.length - 6);
});

test('malformed with a valid check: each field a scan could not produce is refused by name', async () => {
  const from = await fresh(src.packs.ref);
  const ofs = await fresh(src.packs.ofs);
  const enc = f => must(encodeSavedIndex(f.pack, some(f.resolved)));
  const n = from.pack.count;
  const dv = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
  // offsets into the body, as packsaved.ts lays it out
  const at = (count, flags) => {
    const offset = 64, compressed = offset + count * 8, size = compressed + count * 8, baseIndex = size + count * 8;
    const headerBytes = baseIndex + count * 4, storedType = headerBytes + count, type = storedType + count, oids = type + count;
    const refs = oids + count * 20, resolved = refs + (flags & 2 ? count * 20 : 0);
    return { offset, compressed, size, baseIndex, headerBytes, storedType, type, oids, refs, resolved, rBase: resolved + count * 8, rDepth: resolved + count * 12, rType: resolved + count * 16 + count * 20, stats: resolved + count * 37 };
  };
  const refAt = at(n, 7);
  const firstDelta = [...from.pack.entries()].find(e => e.storedType === 7).index;
  const firstWhole = [...from.pack.entries()].find(e => e.storedType !== 7).index;
  const cases = [
    ['flags (unknown bit)', b => { dv(b).setUint16(6, dv(b).getUint16(6, true) | 0x80, true); }, 'flags', -1],
    ['flags (refs off with REF entries)', null, 'length', -1],
    ['reserved', b => { b[60] = 1; }, 'reserved', -1],
    ['count', b => { dv(b).setUint32(12, n + 1, true); }, 'count', -1],
    ['resolved.count', b => { dv(b).setUint32(48, n - 1, true); }, 'resolved.count', -1],
    ['offset', b => { dv(b).setFloat64(refAt.offset + 8, 13, true); }, 'offset', 1],
    ['compressed', b => { dv(b).setFloat64(refAt.compressed, 1.5, true); }, 'size', 0],
    ['size', b => { dv(b).setFloat64(refAt.size, -1, true); }, 'size', 0],
    ['headerBytes', b => { b[refAt.headerBytes] = 0; }, 'size', 0],
    ['storedType', b => { b[refAt.storedType] = 5; }, 'storedType', 0],
    ['type of a whole object', b => { b[refAt.type + firstWhole] = b[refAt.type + firstWhole] === 3 ? 2 : 3; }, 'type', firstWhole],
    ['baseIndex of a whole object', b => { dv(b).setInt32(refAt.baseIndex + firstWhole * 4, 0, true); }, 'type', firstWhole],
    ['baseIndex of a REF delta past the end', b => { dv(b).setInt32(refAt.baseIndex + firstDelta * 4, n, true); }, 'baseIndex', firstDelta],
    // its baseIndex is left the scan's (review R2: one moved to a whole object with another id is refused as baseIndex
    // before its type is read; the tampered table below has that case), so only the type disagrees with its base's
    ['type of a REF delta', b => { b[refAt.type + firstDelta] = b[refAt.type + firstDelta] === 3 ? 2 : 3; }, 'type', firstDelta],
    ['resolved.type', b => { b[refAt.rType] = 7; }, 'resolved.type', 0],
    ['resolved.base self', b => { dv(b).setInt32(refAt.rBase + 4, 1, true); }, 'resolved.base', 1],
    ['resolved.base below thin', b => { dv(b).setInt32(refAt.rBase, -3, true); }, 'resolved.base', 0],
    ['resolved.depth', b => { dv(b).setInt32(refAt.rDepth + firstWhole * 4, 1, true); }, 'resolved.depth', firstWhole],
    ['resolved.size', b => { dv(b).setFloat64(refAt.resolved, 0.5, true); }, 'resolved.size', 0],
    ['resolved.stats', b => { dv(b).setFloat64(refAt.stats, Number.NaN, true); }, 'resolved.stats', -1],
  ];
  for (const [name, edit, field, index] of cases) {
    if (edit === null) continue;
    const b = enc(from);
    edit(b);
    const r = decodeSavedIndex(rechecked(b), idOf(from));
    assert.equal(r.ok, false, name);
    assert.deepEqual(r.error, { tag: 'malformed', field, index }, name);
  }
  // the REF flag cleared on a pack with REF entries: the buffer is longer than its header gives
  const noRefs = enc(from);
  dv(noRefs).setUint16(6, 5, true);
  assert.deepEqual(decodeSavedIndex(rechecked(noRefs), idOf(from)).error, { tag: 'malformed', field: 'length', index: -1 });
  // a longer buffer than its header gives, with a valid check
  const long = new Uint8Array(enc(from).length + 8); long.set(enc(from).subarray(0, enc(from).length - 20)); 
  assert.deepEqual(decodeSavedIndex(rechecked(long), idOf(from)).error, { tag: 'malformed', field: 'length', index: -1 });
  // an OFS base that is not earlier, and the last entry not ending at the trailer
  const ofsAt = at(ofs.pack.count, 5);
  const delta = [...ofs.pack.entries()].find(e => e.storedType === 6).index;
  const b = enc(ofs);
  dv(b).setInt32(ofsAt.baseIndex + delta * 4, delta, true);
  assert.deepEqual(decodeSavedIndex(rechecked(b), idOf(ofs)).error, { tag: 'malformed', field: 'baseIndex', index: delta });
  const last = enc(ofs);
  const k = ofs.pack.count - 1;
  dv(last).setFloat64(ofsAt.compressed + k * 8, dv(last).getFloat64(ofsAt.compressed + k * 8, true) - 1, true);
  assert.deepEqual(decodeSavedIndex(rechecked(last), idOf(ofs)).error, { tag: 'malformed', field: 'offset', index: ofs.pack.count });
  // the REF flag set on a pack without REF entries (OFS), with room for the column
  const fake = enc(ofs);
  const grown = new Uint8Array(fake.length + ofs.pack.count * 20);
  grown.set(fake.subarray(0, ofsAt.refs));
  grown.set(fake.subarray(ofsAt.refs, fake.length - 20), ofsAt.refs + ofs.pack.count * 20);
  dv(grown).setUint16(6, 7, true);
  assert.deepEqual(decodeSavedIndex(rechecked(grown), idOf(ofs)).error, { tag: 'malformed', field: 'flags', index: -1 });
});

// Review finding saved-index-resolved-base-cycle: a saved index is stored state, so untrusted. Each tampered index below
// has its trailing SHA-1 recomputed (the check is unkeyed), so only the structural checks can refuse it. The expected
// refusal comes from the pack format, not from ply: a delta's object is its base's with one more delta applied (depth
// = base depth + 1, same type), an OFS_DELTA names its base by position, a REF_DELTA by the base's id, a whole object
// has no base, and the objects are git's own (pack-objects above).
test('tampered resolved columns with a valid check: cycles, depth lies and bases the scan contradicts are malformed', async () => {
  const from = await fresh(src.packs.ref);
  const ofs = await fresh(src.packs.ofs);
  const enc = f => must(encodeSavedIndex(f.pack, some(f.resolved)));
  const dv = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
  // where the resolved columns start: 64 B header, 31 B per entry, 20 B of ids, 20 B of REF base ids in a REF pack
  const rAt = (count, refs) => { const r = 64 + count * (31 + 20 + (refs ? 20 : 0)); return { size: r, base: r + count * 8, depth: r + count * 12, oid: r + count * 16, type: r + count * 36 }; };
  const setBase = (b, at, i, v) => dv(b).setInt32(at.base + i * 4, v, true);
  const setDepth = (b, at, i, v) => dv(b).setInt32(at.depth + i * 4, v, true);
  const refusal = (f, edit, name) => {
    const b = enc(f);
    edit(b);
    const r = decodeSavedIndex(rechecked(b), idOf(f));
    assert.equal(r.ok, false, `${name}: accepted`);
    assert.equal(r.error.tag, 'malformed', name);
    return `${r.error.field}@${r.error.index}`;
  };
  const R = rAt(from.pack.count, true);
  const rc = from.resolved.columns;
  const all = [...Array(from.pack.count).keys()];
  const deltas = all.filter(i => from.pack.columns.storedType[i] === 7);
  const blobs = all.filter(i => from.pack.columns.storedType[i] === 3);
  assert.ok(deltas.length >= 3 && blobs.length >= 3, 'the fixture has three REF deltas and three whole blobs');
  const [d0, d1, d2] = deltas;
  // the finding's bytes: two deltas resting on each other, depth 1 each
  assert.match(refusal(from, b => { setBase(b, R, d0, d1); setBase(b, R, d1, d0); setDepth(b, R, d0, 1); setDepth(b, R, d1, 1); }, '2-cycle'), /^resolved\.(base|depth)@/u);
  // a longer cycle whose depths agree on every link but the one that closes it
  assert.match(refusal(from, b => { setBase(b, R, d0, d1); setBase(b, R, d1, d2); setBase(b, R, d2, d0); setDepth(b, R, d0, 3); setDepth(b, R, d1, 2); setDepth(b, R, d2, 1); }, '3-cycle'), /^resolved\.(base|depth)@/u);
  assert.equal(refusal(from, b => { setBase(b, R, d0, d0); }, 'self base'), `resolved.base@${d0}`);
  // depth lies with every base left honest: one more, one less, none, negative
  for (const lie of [rc.depth[d0] + 1, rc.depth[d0] - 1, 0, -1]) assert.equal(refusal(from, b => { setDepth(b, R, d0, lie); }, `depth ${lie}`), `resolved.depth@${d0}`);
  // a delta resolved to no base, and a whole object given one
  assert.equal(refusal(from, b => { setBase(b, R, d0, -1); setDepth(b, R, d0, 0); }, 'delta without a base'), `resolved.base@${d0}`);
  assert.equal(refusal(from, b => { setBase(b, R, blobs[0], blobs[1]); setDepth(b, R, blobs[0], 1); }, 'whole object with a base'), `resolved.base@${blobs[0]}`);
  // a REF delta resting on a whole blob moved to another whole blob: depth 1 and type blob still agree, the base's id does not
  const onWhole = deltas.find(i => from.pack.columns.storedType[rc.base[i]] === 3);
  const otherBlob = blobs.find(i => i !== rc.base[onWhole]);
  assert.equal(refusal(from, b => { setBase(b, R, onWhole, otherBlob); }, 'REF base with another id'), `resolved.base@${onWhole}`);
  // the scan found that base in the pack, so it is not a thin base
  assert.equal(from.pack.columns.baseIndex[onWhole], rc.base[onWhole]);
  assert.equal(refusal(from, b => { setBase(b, R, onWhole, -2); setDepth(b, R, onWhole, 1); }, 'thin base the scan found in the pack'), `resolved.base@${onWhole}`);
  // #260 review R2. The scan's own base column (after the 64 B header and three f64 columns, an i32 per entry): a REF
  // delta's baseIndex is the whole object whose id the delta names. The fixture says so itself (both ids are in the
  // index), and git wrote both: the REF id is in the pack's bytes, the whole object's id is its SHA-1.
  const hex = (col, i) => Buffer.from(col.subarray(i * 20, i * 20 + 20)).toString('hex');
  assert.equal(hex(from.pack.columns.oids, from.pack.columns.baseIndex[onWhole]), hex(from.pack.columns.refs, onWhole));
  assert.notEqual(hex(from.pack.columns.oids, otherBlob), hex(from.pack.columns.refs, onWhole));
  const scanBaseAt = i => 64 + from.pack.count * 24 + i * 4;
  assert.equal(dv(enc(from)).getInt32(scanBaseAt(onWhole), true), from.pack.columns.baseIndex[onWhole], 'the offset is the scan baseIndex column');
  // moved to a whole blob with another id: type (blob) and range still agree, and the resolved base is left honest
  assert.equal(refusal(from, b => { dv(b).setInt32(scanBaseAt(onWhole), otherBlob, true); }, 'scan REF base with another id'), `baseIndex@${onWhole}`);
  // the same lie told in both columns, and told with no resolved columns saved
  assert.equal(refusal(from, b => { dv(b).setInt32(scanBaseAt(onWhole), otherBlob, true); setBase(b, R, onWhole, otherBlob); }, 'scan and resolved REF base with another id'), `baseIndex@${onWhole}`);
  const bare = must(encodeSavedIndex(from.pack, none));
  dv(bare).setInt32(scanBaseAt(onWhole), otherBlob, true);
  assert.deepEqual(decodeSavedIndex(rechecked(bare), idOf(from)).error, { tag: 'malformed', field: 'baseIndex', index: onWhole });
  // #260 re-review REQ 2 (owner decision 4). The same pack indexed without ids (scan oids: false; flags 2 refs, +4
  // with resolved columns). A scan that keeps no ids finds no REF base: its base column is -1 for every REF delta
  // (asserted on the scan's own output), so a recorded base is one no scan gives and has no id to be checked against.
  // Both forgeries name a whole blob, with the type column made to agree (blob): the blob the ids-on index above shows
  // is not the object the delta names, and the one that is. With and without resolved columns.
  const noIds = await fresh(src.packs.ref, { oids: false });
  assert.equal(noIds.pack.columns.oids.length, 0);
  assert.ok(deltas.every(i => noIds.pack.columns.baseIndex[i] === -1), 'without ids the scan finds no REF base');
  // the type column: after the base column (i32) and headerBytes, storedType (u8 each)
  const scanTypeAt = i => 64 + from.pack.count * 30 + i;
  for (const resolved of [some(noIds.resolved), none]) {
    const honest = must(encodeSavedIndex(noIds.pack, resolved));
    assert.equal(dv(honest).getUint16(6, true), resolved.tag === 'some' ? 6 : 2, 'flags: REF ids, no ids');
    assert.equal(honest[scanTypeAt(onWhole)], 0, 'the offset is the scan type column: a REF delta with no base found has no type');
    assert.ok(decodeSavedIndex(honest, idOf(noIds)).ok, 'the honest index without ids is used');
    for (const to of [otherBlob, from.pack.columns.baseIndex[onWhole]]) {
      const forged = Uint8Array.from(honest);
      dv(forged).setInt32(scanBaseAt(onWhole), to, true);
      forged[scanTypeAt(onWhole)] = 3;
      const r = decodeSavedIndex(rechecked(forged), idOf(noIds));
      assert.equal(r.ok, false, `REF scan base ${to} recorded without ids (${resolved.tag} resolved): accepted`);
      assert.deepEqual(r.error, { tag: 'malformed', field: 'baseIndex', index: onWhole });
    }
  }
  // types, ids and sizes the scan knows: a delta's type is its base's, a whole object's are the scan's
  assert.equal(refusal(from, b => { b[R.type + onWhole] = 2; }, 'delta type'), `resolved.type@${onWhole}`);
  assert.equal(refusal(from, b => { b[R.type + blobs[0]] = 2; }, 'whole type'), `resolved.type@${blobs[0]}`);
  assert.equal(refusal(from, b => { b[R.oid + blobs[0] * 20] ^= 1; }, 'whole id'), `resolved.oid@${blobs[0]}`);
  // ids are compared whole: one that differs in any single byte (each of the 20) is another id
  for (let k = 0; k < 20; k++) assert.equal(refusal(from, b => { b[R.oid + blobs[0] * 20 + k] ^= 0x80; }, `whole id byte ${k}`), `resolved.oid@${blobs[0]}`);
  assert.equal(refusal(from, b => { dv(b).setFloat64(R.size + blobs[0] * 8, rc.size[blobs[0]] + 1, true); }, 'whole size'), `resolved.size@${blobs[0]}`);
  // OFS: the base is the scan's baseIndex and nothing else: a later entry, an earlier one, a cycle
  const O = rAt(ofs.pack.count, false);
  const oc = ofs.resolved.columns;
  const ofsAll = [...Array(ofs.pack.count).keys()];
  const od = ofsAll.filter(i => ofs.pack.columns.storedType[i] === 6);
  assert.ok(od.length >= 2, 'the fixture has two OFS deltas');
  const [o0, o1] = od;
  const later = ofsAll.find(i => i > o0 && ofs.pack.columns.storedType[i] === 3 && i !== oc.base[o0]);
  const earlier = ofsAll.find(i => i < o0 && ofs.pack.columns.storedType[i] === 3 && i !== oc.base[o0]);
  assert.equal(ofs.pack.columns.baseIndex[o0], oc.base[o0]);
  assert.ok(later !== undefined, 'a whole blob after the first OFS delta');
  for (const to of [later, earlier]) {
    if (to === undefined) continue;
    assert.equal(refusal(ofs, b => { setBase(b, O, o0, to); setDepth(b, O, o0, 1); }, `OFS base ${to}`), `resolved.base@${o0}`);
  }
  assert.match(refusal(ofs, b => { setBase(b, O, o0, o1); setBase(b, O, o1, o0); setDepth(b, O, o0, 1); setDepth(b, O, o1, 1); }, 'OFS 2-cycle'), /^resolved\.base@/u);
  // depth is held to the chain limit the caller resolves under: the honest index passes at its deepest chain, not below
  const deepest = Math.max(...rc.depth);
  assert.ok(deepest >= 1);
  assert.ok(decodeSavedIndex(enc(from), idOf(from), deepest).ok);
  assert.deepEqual(decodeSavedIndex(enc(from), idOf(from), deepest - 1).error, { tag: 'malformed', field: 'resolved.depth', index: all.find(i => rc.depth[i] === deepest) });
  // the tampered index is rescanned by loadTransferPack, never used
  const cyc = enc(from);
  setBase(cyc, R, d0, d1); setBase(cyc, R, d1, d0); setDepth(cyc, R, d0, 1); setDepth(cyc, R, d1, 1);
  const loaded = must(await loadTransferPack(traced().t, from.source, some(rechecked(cyc))));
  assert.equal(loaded.loaded.tag, 'scanned');
  assert.equal(loaded.loaded.refused.value.tag, 'malformed');
  assertSameResolved(from.resolved, loaded.from.resolved);
});

test('encode refusals: an index short of its count, resolved columns of another length, no trailer', async () => {
  const from = await fresh(src.packs.ref);
  const short = scannedPackOf({ version: 2, count: from.pack.count + 1, trailer: from.pack.trailer, bytes: from.pack.bytes, heldBytes: 0 }, from.pack.columns);
  assert.match(encodeSavedIndex(short, none).error.message, /holds \d+ of the pack's \d+ entries/);
  assert.match(encodeSavedIndex(from.pack, some({ ...from.resolved, count: 1 })).error.message, /1 resolved entries/);
  const noTrailer = scannedPackOf({ version: 2, count: from.pack.count, trailer: '', bytes: from.pack.bytes, heldBytes: 0 }, from.pack.columns);
  assert.equal(encodeSavedIndex(noTrailer, none).error.code, 'bad_request');
});

// A spool that counts what is read through it.
function counted(bytes) {
  const inner = rangeFromBytes(bytes);
  const c = { reads: 0, bytes: 0 };
  return { c, source: { size: inner.size, read: async (o, l) => { c.reads++; c.bytes += l; return inner.read(o, l); } } };
}
function traced() {
  const lines = [];
  const tracer = new Tracer({ exporter: arrayExporter(lines) });
  const t = unwrap(createTransport(`${srv.url}/none.git`, { tracer }));
  return { t, spans: () => lines.map(l => flattenLine(l)).flat() };
}

test('loadTransferPack: scanned with none; saved used reading only the trailer; resolved again; stale and corrupt saved bytes rescanned, with why', async () => {
  const bytes = src.packs.ref;
  const { t, spans } = traced();
  const first = counted(bytes);
  const scanned = must(await loadTransferPack(t, first.source, none));
  assert.deepEqual(scanned.loaded, { tag: 'scanned', refused: none });
  assert.ok(first.c.bytes >= bytes.length, `a scan reads the spool: ${first.c.bytes} B`);
  const again = counted(bytes);
  const saved = must(await loadTransferPack(t, again.source, some(scanned.saved)));
  assert.deepEqual(saved.loaded, { tag: 'saved' });
  assert.deepEqual(again.c, { reads: 1, bytes: 20 }, 'only the trailer is read');
  assert.equal(saved.saved, scanned.saved);
  assertSame(scanned.from, saved.from);
  assertSameResolved(scanned.from.resolved, saved.from.resolved);
  // no resolved columns saved: the index is used, the resolve runs
  const half = counted(bytes);
  const resolved = must(await loadTransferPack(t, half.source, some(must(encodeSavedIndex(scanned.from.pack, none)))));
  assert.deepEqual(resolved.loaded, { tag: 'resolved' });
  assert.deepEqual(resolved.saved, scanned.saved);
  // refused saved bytes: each is rescanned and says why
  const other = must(await loadTransferPack(t, rangeFromBytes(src.packs.ofs), none));
  const flipped = Uint8Array.from(scanned.saved); flipped[100] ^= 1;
  const v9 = Uint8Array.from(scanned.saved); v9[4] = 9;
  for (const [bad, tag] of [[other.saved, 'other_pack'], [flipped, 'corrupt'], [scanned.saved.subarray(0, 99), 'truncated'], [new Uint8Array(200), 'not_saved_index'], [rechecked(v9), 'version']]) {
    const r = must(await loadTransferPack(t, rangeFromBytes(bytes), some(bad)));
    assert.equal(r.loaded.tag, 'scanned');
    assert.equal(r.loaded.refused.value.tag, tag);
    assert.deepEqual(r.saved, scanned.saved, `${tag}: the fresh encoding is the one to keep`);
  }
  const got = spans().filter(s => s.name === 'git.transfer.load');
  assert.equal(got.length, 9);
  assert.deepEqual(got.map(s => s.attrs['git.transfer.load.from']), ['scanned', 'saved', 'resolved', 'scanned', 'scanned', 'scanned', 'scanned', 'scanned', 'scanned']);
  assert.deepEqual(got.map(s => s.attrs['git.transfer.load.refused']), [undefined, undefined, undefined, undefined, 'other_pack', 'corrupt', 'truncated', 'not_saved_index', 'version']);
  for (const s of got) { assert.equal(s.attrs['git.pack.trailer'], scanned.from.pack.trailer === s.attrs['git.pack.trailer'] ? scanned.from.pack.trailer : other.from.pack.trailer); assert.equal(typeof s.attrs['git.transfer.load.saved_bytes'], 'number'); }
});

// #260 review R1. A hand-built pack of one chain 100 deep: 101 blobs, entry 0 whole, entry i a REF_DELTA on entry i-1
// (the delta copies the first 40 bytes of its base and inserts the rest). Stock git is the judge that it is an honest
// pack and of how deep it is (index-pack --strict accepts it; verify-pack -v prints each delta's depth). 64 is
// DEFAULT_LIMITS.maxDeltaChain, so only a caller's raised limit resolves it. (git pack-objects --depth=200 over 120
// versions of one file chained 43 deep at --window=20 and 5 at --window=2: its heuristics do not promise a depth.)
test('loadTransferPack: a pack chained deeper than 64 is used from its saved index under the caller\'s raised maxDeltaChain (scanned -> saved -> saved)', async () => {
  const DEPTH = 100;
  const sha1 = b => createHash('sha1').update(b).digest();
  const entryHeader = (type, size) => { const out = [(type << 4) | (size & 15)]; let rest = size >> 4; while (rest > 0) { out[out.length - 1] |= 0x80; out.push(rest & 0x7f); rest >>= 7; } return Buffer.from(out); };
  const versions = Array.from({ length: DEPTH + 1 }, (_, i) => Buffer.from(`c ${'x'.repeat(40)} v${i}\n`));
  const ids = versions.map(v => sha1(Buffer.concat([Buffer.from(`blob ${v.length}\0`), v])));
  // base size, result size (both under 128: one byte each), copy 40 bytes from offset 0, insert the rest
  const deltaOf = (base, target) => Buffer.concat([Buffer.from([base.length, target.length, 0x90, 40, target.length - 40]), target.subarray(40)]);
  const head = Buffer.alloc(12);
  head.write('PACK'); head.writeUInt32BE(2, 4); head.writeUInt32BE(DEPTH + 1, 8);
  const parts = [head, entryHeader(3, versions[0].length), deflateSync(versions[0])];
  for (let i = 1; i <= DEPTH; i++) { const d = deltaOf(versions[i - 1], versions[i]); parts.push(entryHeader(7, d.length), ids[i - 1], deflateSync(d)); }
  const body = Buffer.concat(parts);
  const bytes = new Uint8Array(Buffer.concat([body, sha1(body)]));
  const dir = join(root, `deep${n++}`);
  mkdirSync(dir);
  initRepo(dir);
  writeFileSync(join(dir, 'deep.pack'), bytes);
  git(dir, ['index-pack', '--strict', 'deep.pack']);
  const depths = git(dir, ['verify-pack', '-v', 'deep.idx']).split('\n').map(l => /^[0-9a-f]{40} \w+\s+\d+ \d+ \d+ (\d+) [0-9a-f]{40}$/u.exec(l)).filter(m => m !== null).map(m => Number(m[1]));
  const deepest = Math.max(...depths);
  assert.equal(deepest, DEPTH, 'git reads the chain as 100 deep');
  const { t } = traced();
  const limits = { maxDeltaChain: 200 };
  const source = rangeFromBytes(bytes);
  // the default limit refuses the pack itself: the raised one is what the caller needs to read it at all
  assert.equal((await loadTransferPack(t, source, none)).error.code, 'limit_exceeded');
  const first = must(await loadTransferPack(t, source, none, { resolve: { limits } }));
  assert.equal(first.loaded.tag, 'scanned');
  assert.equal(Math.max(...first.from.resolved.columns.depth), deepest);
  const second = must(await loadTransferPack(t, source, some(first.saved), { resolve: { limits } }));
  assert.deepEqual(second.loaded, { tag: 'saved' });
  const third = must(await loadTransferPack(t, source, some(second.saved), { resolve: { limits } }));
  assert.deepEqual(third.loaded, { tag: 'saved' });
  assert.deepEqual([...third.saved], [...first.saved]);
  assertSameResolved(first.from.resolved, third.from.resolved);
  // the limit is the caller's, both ways: at the pack's deepest chain it loads, one below it the saved index is refused
  // and the rescan's resolve refuses the pack, as it does with no saved index
  assert.deepEqual(must(await loadTransferPack(t, source, some(first.saved), { resolve: { limits: { maxDeltaChain: deepest } } })).loaded, { tag: 'saved' });
  assert.equal((await loadTransferPack(t, source, some(first.saved), { resolve: { limits: { maxDeltaChain: deepest - 1 } } })).error.code, 'limit_exceeded');
  assert.equal((await loadTransferPack(t, source, some(first.saved))).error.code, 'limit_exceeded');
  // limits that do not parse are refused where they enter, saved index or not
  for (const saved of [none, some(first.saved)]) {
    const bad = await loadTransferPack(t, source, saved, { resolve: { limits: { maxDeltaChain: -1 } } });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'bad_request');
    assert.match(bad.error.message, /limits\.maxDeltaChain/u);
  }
  // a direct caller of decodeSavedIndex passes the same limit; without it the default 64 applies
  const id = { trailer: first.from.pack.trailer, bytes: first.from.pack.bytes };
  assert.ok(decodeSavedIndex(first.saved, id, 200).ok);
  assert.equal(decodeSavedIndex(first.saved, id).error.field, 'resolved.depth');
  // #260 re-review REQ 1: the resolve options are read as resolvePackRange reads them (opts[key]), so one that reaches
  // the caller's record through a prototype or a class accessor counts. The expected outcomes are not ply's: git reads
  // this pack as 100 deep (above), so only an honoured limit of 200 resolves it, and a cache of -1 bytes is no size.
  assert.equal(must(await loadTransferPack(t, source, none, { resolve: Object.create({ limits }) })).loaded.tag, 'scanned');
  let cacheReads = 0;
  class Accessors { get limits() { return limits; } get cacheBytes() { cacheReads++; return -1; } }
  const supplied = [Object.create({ limits, cacheBytes: -1 }), Object.assign(Object.create({ cacheBytes: -1 }), { limits }), new Accessors()];
  for (const [k, resolve] of supplied.entries()) {
    const bad = await loadTransferPack(t, source, none, { resolve });
    assert.equal(bad.ok, false, `inherited cacheBytes -1 (${k}) is refused`);
    assert.equal(bad.error.code, 'bad_request');
    assert.match(bad.error.message, /cacheBytes must be a non-negative number, got -1/u);
  }
  assert.equal(cacheReads, 1, 'an accessor is read once');
});

test('loadTransferPack refusals: a spool too small for a pack, a spool whose read fails, a spool that is not a pack', async () => {
  const { t, spans } = traced();
  const tiny = await loadTransferPack(t, rangeFromBytes(new Uint8Array(31)), none);
  assert.equal(tiny.error.code, 'bad_request');
  assert.match(tiny.error.message, /holds no pack/);
  const failing = { size: 1000, read: async () => ({ ok: false, error: Object.assign(new Error('r2 down'), { code: 'network' }) }) };
  assert.equal((await loadTransferPack(t, failing, none)).error.code, 'network');
  const short = { size: 1000, read: async () => ({ ok: true, value: streamOf(new Uint8Array(5)) }) };
  assert.match((await loadTransferPack(t, short, none)).error.message, /read back as 5/);
  const junk = new Uint8Array(4096); randomFillSync(junk);
  assert.equal((await loadTransferPack(t, rangeFromBytes(junk), none)).error.code, 'pack_corrupt');
  assert.equal((await packIdentity(rangeFromBytes(src.packs.ref))).value.bytes, src.packs.ref.length);
  assert.ok(spans().filter(s => s.name === 'git.transfer.load').every(s => s.status.code === 2), 'each refusal is the span error');
});

test('a resumed transfer that loads the saved index every request reaches the fresh head, at every step boundary', async () => {
  for (const kind of ['ref', 'ofs']) {
    const bytes = src.packs[kind];
    const first = must(await loadTransferPack(unwrap(createTransport(`${srv.url}/x.git`)), rangeFromBytes(bytes), none));
    const plan = must(planTransfer(first.from.pack, first.from.resolved, { budget: BUDGET, ref: REF, commit: src.commit }));
    assert.ok(plan.steps.length >= 3, `${kind}: ${plan.steps.length} steps`);
    const name = `s${n++}`;
    const bare = makeBareRepo(root, name);
    const t = unwrap(createTransport(`${srv.url}/${name}.git`));
    let saved = first.saved;
    let requests = 0;
    for (;;) {
      // a new request: nothing but the plan, the spool and the saved bytes
      const spool = counted(bytes);
      const loaded = must(await loadTransferPack(t, spool.source, some(saved)));
      assert.equal(loaded.loaded.tag, 'saved');
      assert.deepEqual(spool.c, { reads: 1, bytes: 20 });
      saved = loaded.saved;
      const r = must(await runTransfer(t, loaded.from, plan, src.commit, { maxSteps: 1, ref: REF }));
      requests++;
      if (r.tag === 'done') break;
    }
    assert.equal(requests, plan.steps.length);
    assert.equal(git(bare, ['rev-parse', REF]).trim(), plan.head);
    assert.equal(git(bare, ['for-each-ref', 'refs/ply']).trim(), '');
    assert.deepEqual(fsckProblems(bare, { args: ['--strict'] }), []);
    assert.equal(git(bare, ['ls-tree', '-r', REF]), src.lsTree);
    // the same plan from a fresh scan: the same head
    const scanned = await fresh(bytes);
    assert.equal(must(planTransfer(scanned.pack, scanned.resolved, { budget: BUDGET, ref: REF, commit: src.commit })).head, plan.head);
  }
});

// The Abort contract (README) for packIdentity, whose one read is the spool's last 20 bytes: aborted before the call
// (nothing asked of the storage), while that read never opens, and while its range is open and never serves a byte.
// Expected values are the contract's: the code `aborted`, and on the test's own counters no read for the first, the one
// read told through its signal for the others, and the open range cancelled.
test('packIdentity aborted before the call, at the trailer read, and in the trailer range settles aborted', async () => {
  const bytes = src.packs.ofs;
  const seen = {};
  const before = stallAt(bytes, 0, 'never');
  seen.before = { code: codeOf(await packIdentity(before, abortedBefore())), ...before.state };
  for (const how of ['never', 'stall']) {
    const source = stallAt(bytes, 0, how);
    const ac = new AbortController();
    const op = packIdentity(source, ac.signal);
    assert.equal(await settledWithin(source.parked), 'settled', how);
    assert.equal(await settledWithin(op, 20), 'pending', how);
    ac.abort(new Error('stop'));
    assert.equal(await settledWithin(op), 'settled', how);
    seen[how] = { code: codeOf(await op), ...source.state };
  }
  assert.deepEqual(seen, {
    before: { code: 'aborted', reads: 0, cancelled: 0, aborted: 0 },
    never: { code: 'aborted', reads: 1, cancelled: 0, aborted: 1 },
    stall: { code: 'aborted', reads: 1, cancelled: 1, aborted: 1 },
  });
});

// #299 item 5: a saved index is held to maxPackObjects, the cap a scan holds the pack's header count to, from its
// header, before any column is built: one entry over is limit_exceeded (got = the header's count, max = the limit),
// at the bound it decodes. The count comes from git (rev-list --objects of the packed commit), not from ply.
test('maxPackObjects: a saved index over it is refused from the header with got/max, at the bound decodes, a 1M-entry header refused before its body is read', async () => {
  const from = await fresh(src.packs.ref);
  const bytes = must(encodeSavedIndex(from.pack, some(from.resolved)));
  const n = git(work, ['rev-list', '--objects', '--no-walk', src.head]).trim().split('\n').length;
  assert.equal(from.pack.count, n);
  const r = decodeSavedIndex(bytes, idOf(from), 64, n - 1);
  assert.deepEqual(r, { ok: false, error: { tag: 'limit_exceeded', what: 'pack objects', got: n, max: n - 1 } });
  assert.equal(describeRefusal(r.error), `saved index has ${n} entries by its header, over limits.maxPackObjects ${n - 1}`);
  assertSame(from, must(decodeSavedIndex(bytes, idOf(from), 64, n)));
  // a header claiming 1,000,000 entries (flags 1: oids) and nothing after it: refused by count, not truncated
  const head = Uint8Array.from(bytes.subarray(0, 84));
  const v = new DataView(head.buffer);
  v.setUint16(6, 1, true);
  v.setUint32(16, 1_000_000, true);
  assert.deepEqual(decodeSavedIndex(head, idOf(from), 64, 100_000), { ok: false, error: { tag: 'limit_exceeded', what: 'pack objects', got: 1_000_000, max: 100_000 } });
  // the default bound is DEFAULT_LIMITS.maxPackObjects, 100 000 (README): the same header is refused, 100 000 is truncated
  assert.deepEqual(decodeSavedIndex(head, idOf(from)).error, { tag: 'limit_exceeded', what: 'pack objects', got: 1_000_000, max: 100_000 });
  v.setUint32(16, 100_000, true);
  assert.equal(decodeSavedIndex(head, idOf(from)).error.tag, 'truncated');
});

// The bound on the consumer path: the cap is the scan's (opts.scan.limits.maxPackObjects), and a saved index over it
// is refused like any other stored bytes and rescanned (README: stored bytes are untrusted, loadTransferPack then scans
// again); a pack really over the cap is refused by the scan's own header-count check.
test('loadTransferPack: a saved index over the scan\'s maxPackObjects is refused and rescanned; the scan refuses a pack over it', async () => {
  const { t } = traced();
  const first = must(await loadTransferPack(t, rangeFromBytes(src.packs.ref), none));
  const n = git(work, ['rev-list', '--objects', '--no-walk', src.head]).trim().split('\n').length;
  assert.equal(first.from.pack.count, n);
  const over = counted(src.packs.ref);
  const r = await loadTransferPack(t, over.source, some(first.saved), { scan: { limits: { maxPackObjects: n - 1 } } });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'limit_exceeded');
  assert.ok(over.c.bytes > 20, `rescanned: ${over.c.bytes} B read`);
  // a resolve limit is not the cap: the index is used
  const at = must(await loadTransferPack(t, rangeFromBytes(src.packs.ref), some(first.saved), { resolve: { limits: { maxPackObjects: n - 1 } } }));
  assert.deepEqual(at.loaded, { tag: 'saved' });
});

// A corrupt stored count (bit 0x02 of byte 18, the third byte of the little-endian u32 count at 16, adds 0x20000) is
// untrusted data: refused, rescanned, and the load succeeds.
test('loadTransferPack: a saved index whose stored count is corrupt past the cap is rescanned, with the refusal', async () => {
  const { t, spans } = traced();
  const first = must(await loadTransferPack(t, rangeFromBytes(src.packs.ref), none));
  const n = git(work, ['rev-list', '--objects', '--no-walk', src.head]).trim().split('\n').length;
  const bad = Uint8Array.from(first.saved);
  assert.equal(bad[18] & 0x02, 0);
  bad[18] ^= 0x02;
  const r = must(await loadTransferPack(t, rangeFromBytes(src.packs.ref), some(bad)));
  assert.deepEqual(r.loaded, { tag: 'scanned', refused: some({ tag: 'limit_exceeded', what: 'pack objects', got: n + 0x20000, max: 100_000 }) });
  assert.equal(r.from.pack.count, n);
  assert.deepEqual(r.saved, first.saved);
  const span = spans().filter(s => s.name === 'git.transfer.load').at(-1);
  assert.equal(span.attrs['git.transfer.load.refused'], 'limit_exceeded');
});

// Raised scan cap: a pack of 100 005 blobs (git pack-objects) scans under scan.limits.maxPackObjects 200 000 and
// resumes from its own saved bytes with the same opts.
test('loadTransferPack: a pack over the default cap scanned under a raised scan cap resumes from its saved bytes', async () => {
  const dir = join(root, 'big');
  initRepo(dir);
  const N = 100_005;
  let fi = '';
  for (let i = 0; i < N; i++) { const d = `b${i}\n`; fi += `blob\ndata ${d.length}\n${d}`; }
  gitBuf(dir, ['fast-import', '--quiet', '--export-marks=marks'], Buffer.from(fi));
  const oids = git(dir, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'], { maxBuffer: 1 << 26 });
  assert.equal(oids.trim().split('\n').length, N);
  const pack = new Uint8Array(gitBuf(dir, ['pack-objects', '--stdout', '-q'], Buffer.from(oids)));
  const { t } = traced();
  const opts = { scan: { limits: { maxPackObjects: 200_000 } } };
  const first = must(await loadTransferPack(t, rangeFromBytes(pack), none, opts));
  assert.equal(first.from.pack.count, N);
  const again = counted(pack);
  const r = must(await loadTransferPack(t, again.source, some(first.saved), opts));
  assert.deepEqual(r.loaded, { tag: 'saved' });
  assert.deepEqual(again.c, { reads: 1, bytes: 20 });
}, 120_000);

// #299 items 5 and 6: decoded columns are views into the saved bytes (one copy, not two), the same for a Node Buffer
// and a Uint8Array (README 'Saved pack index'): a byte the caller changes after the decode shows in the column.
test('decodeSavedIndex: columns view the saved bytes, a Buffer and a Uint8Array alike; number columns too', async () => {
  const from = await fresh(src.packs.ref);
  const bytes = must(encodeSavedIndex(from.pack, some(from.resolved)));
  for (const input of [Uint8Array.from(bytes), Buffer.from(bytes)]) {
    let views = 0;
    const back = must(decodeSavedIndex(input, idOf(from)));
    assertSame(from, back);
    assertSameResolved(from.resolved, back.resolved.value);
    for (const k of [...COLS.filter(c => c !== 'baseIndex'), 'baseIndex']) {
      const col = back.pack.columns[k];
      if (col.length === 0) continue;
      if (col.BYTES_PER_ELEMENT > 1) views++;
      assert.equal(col.buffer, input.buffer, k);
      const at = col.byteOffset - input.byteOffset;
      const was = col[0];
      input[at] ^= 0xff;
      assert.notEqual(col[0], was, `${k} sees a write to the saved bytes`);
      input[at] ^= 0xff;
      assert.equal(col[0], was, k);
    }
    // base is rebuilt from the pack's baseIndex on decode, not read from the bytes; the others are views
    for (const k of RCOLS.filter(c => c !== 'base')) {
      const col = back.resolved.value.columns[k];
      // a number column is a view only where it is aligned in the buffer (README); here the resolved section follows
      // byte columns of odd length, so a misaligned one must be a copy with the same values
      if (col.BYTES_PER_ELEMENT > 1 && col.buffer !== input.buffer) { assert.notEqual(col.buffer, input.buffer); continue; }
      if (col.BYTES_PER_ELEMENT > 1) views++;
      assert.equal(col.buffer, input.buffer, k);
      const at = col.byteOffset - input.byteOffset;
      const was = col[0];
      input[at] ^= 0xff;
      assert.notEqual(col[0], was, `resolved ${k} sees a write to the saved bytes`);
      input[at] ^= 0xff;
    }
    // the aligned path is taken: number columns (offset, compressed, size, baseIndex) are views, not copies
    assert.ok(views >= 4, `${views} number columns are views`);
  }
});
