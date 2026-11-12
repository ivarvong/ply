// packSubset (#235): a new pack of chosen entries of an existing pack, read through a range reader, compressed bytes
// copied unchanged. The oracle is stock git: `git index-pack --strict` accepts every built pack, and `git verify-pack -v`
// lists exactly the selected objects (by id) and nothing else.
//   - the whole pack in order is byte-identical to the source (OFS and REF packs written by git)
//   - an order that differs from the source: OFS distances rewritten, headers growing and shrinking
//   - REF passthrough (a REF-only pack, as Cloudflare Artifacts sends)
//   - an OFS base outside the selection: refused, or written as a REF_DELTA (`outsideBase: 'ref'`) and fixed thin by git
//   - extras appended; exact length up front; one range read per run of consecutive entries
//   - a range that is short or long errors the stream; a consumer that cancels cancels the range
//   - a pushPack round trip to git http-backend, fsck --strict clean
//   - memory: a source far larger than what is held (child process, --expose-gc)
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { MEMORY_CELL_FLAGS } from './memcell.js';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomFillSync, createHash } from 'node:crypto';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, fsckProblems, initRepo } from './server.js';
import { packSubset } from '../src/packsubset.js';
import { rangeFromBytes } from '../src/rangesource.js';
import * as rangesource from '../src/rangesource.js';
import { resolvePackRange } from '../src/packrangeresolve.js';
import { loadTransferPack } from '../src/transferload.js';
import { packIdentity } from '../src/packsaved.js';
import { scanPackIndex } from '../src/packscanindex.js';
import { hashObject, TYPE } from '../src/objects.js';
import { te } from '../src/bytes.js';
import { createTransport } from '../src/http.js';
import { pushPackChecked, ZERO_OID } from '../src/push.js';
import { unwrap } from './unwrap.js';

const REF = 'refs/heads/main';
let root, cleanup, srv, work, n = 0;
const packs = {};
const id = { name: 'a', email: 'a@x' };
const commitAll = msg => { git(work, ['add', '.']); git(work, ['-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`, 'commit', '-q', '-m', msg]); };
before(async () => {
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  work = join(root, 'source');
  mkdirSync(work);
  initRepo(work);
  // versions of one text file make deltas; a 300 KB random blob sits between them, so moving an entry across it moves
  // its OFS distance across a varint byte boundary
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i} of a file that changes a little each commit\n`).join('');
  for (let v = 0; v < 6; v++) {
    writeFileSync(join(work, 'text.txt'), `${lines}version ${v}\n`);
    writeFileSync(join(work, `notes-${v % 2}.md`), `${lines.slice(0, 20_000)}note ${v}\n`);
    if (v === 2) { const big = new Uint8Array(300_000); randomFillSync(big); writeFileSync(join(work, 'random.bin'), big); }
    commitAll(`v${v}`);
  }
  const head = git(work, ['rev-parse', 'HEAD']).trim();
  packs.head = head;
  packs.ofs = new Uint8Array(gitBuf(work, ['pack-objects', '--revs', '--stdout', '-q', '--delta-base-offset'], `${head}\n`));
  packs.ref = new Uint8Array(gitBuf(work, ['pack-objects', '--revs', '--stdout', '-q'], `${head}\n`));
});
after(async () => { await srv.close(); cleanup(); });

const scan = async bytes => unwrap(await scanPackIndex(rangeStream(bytes)));
const rangeStream = bytes => new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
const drain = async stream => {
  const parts = [];
  let len = 0;
  const reader = stream.getReader();
  for (;;) { const r = await reader.read(); if (r.done) break; parts.push(r.value); len += r.value.length; }
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
// `git verify-pack -v` of a pack: each object's id, type, offset and (for a delta) its base id
function verifyPack(bytes) {
  const dir = join(root, `v${n++}`);
  mkdirSync(dir);
  const file = join(dir, 'p.pack');
  writeFileSync(file, bytes);
  git(dir, ['index-pack', '-o', join(dir, 'p.idx'), file]);
  const out = git(dir, ['verify-pack', '-v', join(dir, 'p.idx')]);
  const rows = [];
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{40}) (\w+)\s+(\d+) (\d+) (\d+)(?: (\d+) ([0-9a-f]{40}))?$/.exec(line);
    if (m) rows.push({ oid: m[1], type: m[2], offset: Number(m[5]), base: m[7] ?? null });
  }
  return rows;
}
// `git index-pack --strict` in a bare repo (optionally one that already has the source's objects, for a thin pack)
function strictAccept(bytes, { thin = false } = {}) {
  const bare = makeBareRepo(root, `s${n++}`);
  if (thin) gitBuf(bare, ['index-pack', '--stdin'], Buffer.from(packs.ofs));
  return gitBuf(bare, ['index-pack', '--strict', ...(thin ? ['--fix-thin'] : []), '--stdin'], Buffer.from(bytes)).toString();
}
// The source's entry index for each object id, from git's own listing of the source.
function indexByOid(srcBytes, idx) {
  const at = new Map([...idx.entries()].map(e => [e.offset, e.index]));
  return new Map(verifyPack(srcBytes).map(r => [r.oid, at.get(r.offset)]));
}
// A range reader that counts reads and can be told to misbehave.
function countingSource(bytes, { short = 0, long = 0 } = {}) {
  const inner = rangeFromBytes(bytes);
  const state = { reads: 0, cancelled: 0 };
  return {
    state,
    size: bytes.length,
    async read(offset, length) {
      state.reads++;
      const r = await inner.read(offset, length);
      if (!r.ok) return r;
      if (short === 0 && long === 0) return { ok: true, value: tap(r.value) };
      const want = length - short + long;
      const body = new Uint8Array(want);
      body.set(bytes.subarray(offset, offset + Math.min(want, bytes.length - offset)));
      return { ok: true, value: new ReadableStream({ start(c) { c.enqueue(body); c.close(); } }) };
    },
  };
  function tap(stream) {
    const reader = stream.getReader();
    return new ReadableStream({
      async pull(c) { const r = await reader.read(); if (r.done) c.close(); else c.enqueue(r.value); },
      cancel() { state.cancelled++; return reader.cancel(); },
    }, { highWaterMark: 0 });
  }
}
async function build(srcBytes, idx, selection, opts = {}) {
  const src = countingSource(srcBytes);
  const built = unwrap(await packSubset(src, idx, selection, opts));
  const bytes = await drain(built.stream);
  assert.equal(bytes.length, built.length, 'length is exact');
  assert.equal(built.count, selection.length + (opts.extras?.length ?? 0));
  return { bytes, built, reads: src.state.reads };
}

test('the whole pack in order is the source, byte for byte (OFS and REF packs), in one range read', async () => {
  for (const kind of ['ofs', 'ref']) {
    const idx = await scan(packs[kind]);
    const all = [...Array(idx.count).keys()];
    const { bytes, reads } = await build(packs[kind], idx, all);
    assert.deepEqual(bytes, packs[kind], kind);
    assert.equal(reads, 1, `${kind}: one run, one read`);
    strictAccept(bytes);
  }
});

test('an order that differs from the source: OFS distances rewritten, headers grow and shrink, git accepts it', async () => {
  const idx = await scan(packs.ofs);
  const c = idx.columns;
  // wholes first in reverse order, then every delta in an order with each base before it (a topological order)
  const wholes = [...idx.entries()].filter(e => e.base.tag === 'none').map(e => e.index).reverse();
  const placed = new Set(wholes);
  const order = [...wholes];
  let left = [...idx.entries()].filter(e => e.base.tag !== 'none').map(e => e.index).reverse();
  while (left.length) {
    const ready = left.filter(i => placed.has(c.baseIndex[i]));
    assert.ok(ready.length, 'a base is always placeable');
    for (const i of ready) { order.push(i); placed.add(i); }
    left = left.filter(i => !placed.has(i));
  }
  const { bytes, reads } = await build(packs.ofs, idx, order);
  const out = await scan(bytes);
  // the same objects, by id, as the source
  const src = verifyPack(packs.ofs).map(r => r.oid).sort();
  assert.deepEqual(verifyPack(bytes).map(r => r.oid).sort(), src);
  strictAccept(bytes);
  // headers changed size: compare each entry's header length with its source entry's
  let grew = 0;
  for (const [k, i] of order.entries()) {
    if (out.columns.headerBytes[k] > c.headerBytes[i]) grew++;
    assert.equal(out.columns.compressed[k], c.compressed[i], 'compressed bytes copied unchanged');
  }
  assert.ok(grew > 0, 'some OFS distance grew a varint byte (shrinking is the next test)');
  assert.ok(reads > 1, 'a reordered selection is several runs');
});

test('an OFS distance shrinks when the entries between base and delta are left out', async () => {
  const idx = await scan(packs.ofs);
  const c = idx.columns;
  // the OFS delta farthest from its whole base (across the 300 KB random blob): select only the two of them
  const far = [...idx.entries()].filter(e => e.base.tag === 'ofs' && c.storedType[c.baseIndex[e.index]] !== TYPE.OFS_DELTA)
    .sort((a, b) => (b.offset - b.base.offset) - (a.offset - a.base.offset))[0];
  assert.ok(far && far.offset - far.base.offset > 1 << 14, 'the fixture has a far delta');
  const chain = [c.baseIndex[far.index], far.index];
  const { bytes } = await build(packs.ofs, idx, chain);
  const out = await scan(bytes);
  const k = chain.indexOf(far.index);
  assert.ok(out.columns.headerBytes[k] < c.headerBytes[far.index], 'the far delta header shrank');
  assert.equal(verifyPack(bytes).length, chain.length);
  strictAccept(bytes);
});

test('REF passthrough: a REF-only pack, a subset of whole objects and their REF deltas', async () => {
  const idx = await scan(packs.ref);
  assert.ok([...idx.entries()].some(e => e.base.tag === 'ref'), 'the fixture has REF deltas');
  // every other run of entries, plus the base of every selected REF delta (so the pack is whole and git can list it)
  const byOid = indexByOid(packs.ref, idx);
  const chosen = new Set([...Array(idx.count).keys()].filter(i => i % 3 !== 1));
  for (let grew = true; grew;) {
    grew = false;
    for (const i of [...chosen]) {
      const e = idx.entry(i).value;
      if (e.base.tag === 'ref' && !chosen.has(byOid.get(e.base.oid))) { chosen.add(byOid.get(e.base.oid)); grew = true; }
    }
  }
  const sel = [...chosen].sort((a, b) => a - b);
  assert.ok(sel.length < idx.count && sel.some(i => idx.entry(i).value.base.tag === 'ref'));
  const { bytes } = await build(packs.ref, idx, sel);
  const want = new Set([...byOid].filter(([, j]) => chosen.has(j)).map(([oid]) => oid));
  assert.deepEqual(new Set(verifyPack(bytes).map(r => r.oid)), want);
  const out = await scan(bytes);
  assert.ok([...out.entries()].some(e => e.base.tag === 'ref'), 'REF deltas passed through as REF');
  // a subset links to objects it leaves out: --strict in a repository that has them
  strictAccept(bytes, { thin: true });
});

test('an OFS base outside the selection: refused by default; with outsideBase ref, a REF_DELTA git fixes thin', async () => {
  const idx = await scan(packs.ofs);
  const c = idx.columns;
  const d = [...idx.entries()].find(e => e.base.tag === 'ofs' && c.storedType[c.baseIndex[e.index]] !== TYPE.OFS_DELTA);
  assert.ok(d, 'the fixture has a delta on a whole object');
  const refused = await packSubset(rangeFromBytes(packs.ofs), idx, [d.index]);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'bad_request');
  assert.match(refused.error.message, /base.*is not selected/);
  // base written after the delta: also refused
  const later = await packSubset(rangeFromBytes(packs.ofs), idx, [d.index, c.baseIndex[d.index]]);
  assert.equal(later.ok, false);
  assert.match(later.error.message, /written after it/);
  const { bytes } = await build(packs.ofs, idx, [d.index], { outsideBase: 'ref' });
  const out = await scan(bytes);
  assert.equal(out.columns.storedType[0], TYPE.REF_DELTA);
  assert.equal(out.entry(0).value.base.oid, idx.entry(c.baseIndex[d.index]).value.oid);
  strictAccept(bytes, { thin: true });
  // a base that is itself a delta has no id in the index: refused even with outsideBase ref
  const dd = [...idx.entries()].find(e => e.base.tag === 'ofs' && c.storedType[c.baseIndex[e.index]] === TYPE.OFS_DELTA);
  if (dd) {
    const r = await packSubset(rangeFromBytes(packs.ofs), idx, [dd.index], { outsideBase: 'ref' });
    assert.equal(r.ok, false);
    assert.match(r.error.message, /id is unknown/);
  }
});

test('extras are appended, deflated up front, and counted in the length', async () => {
  const idx = await scan(packs.ofs);
  const blob = te.encode('an extra object ply encoded itself\n');
  const extra = { type: TYPE.BLOB, data: blob };
  // whole blobs only: they link to nothing, so --strict has nothing missing
  const wholes = [...idx.entries()].filter(e => e.storedType === TYPE.BLOB).map(e => e.index);
  const { bytes } = await build(packs.ofs, idx, wholes, { extras: [extra] });
  const oids = new Set(verifyPack(bytes).map(r => r.oid));
  assert.ok(oids.has(hashObject('blob', blob)));
  assert.equal(oids.size, wholes.length + 1);
  strictAccept(bytes);
  const bad = await packSubset(rangeFromBytes(packs.ofs), idx, wholes, { extras: [{ ...extra, base: { tag: 'ofs', index: 0 } }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'bad_request');
});

test('the selection is checked before a byte is read: out of range, not an integer, twice', async () => {
  const idx = await scan(packs.ofs);
  for (const sel of [[idx.count], [-1], [0.5], [0, 0]]) {
    const src = countingSource(packs.ofs);
    const r = await packSubset(src, idx, sel);
    assert.equal(r.ok, false, JSON.stringify(sel));
    assert.equal(r.error.code, 'bad_request');
    assert.equal(src.state.reads, 0);
  }
  const small = await packSubset(rangeFromBytes(packs.ofs.subarray(0, 100)), idx, [0]);
  assert.equal(small.ok, false, 'a source smaller than the indexed pack');
});

test('refusals of the request or the index: more objects than a pack counts, a REF_DELTA the index gives no base id', async () => {
  const idx = await scan(packs.ref);
  // a pack's count is 32 bits: 2^32 - 1 selected (a sparse array, refused before it is walked) plus one extra
  const huge = await packSubset(rangeFromBytes(packs.ref), idx, new Array(0xff_ff_ff_ff), { extras: [{ type: TYPE.BLOB, data: te.encode('x') }] });
  assert.equal(huge.ok, false);
  assert.equal(huge.error.code, 'bad_request');
  assert.match(huge.error.message, /more than a pack can count/);
  // an index (hand-built or damaged) whose entry() gives a REF_DELTA no base id
  const r = [...idx.entries()].find(e => e.base.tag === 'ref');
  const damaged = Object.create(idx);
  damaged.entry = i => (i === r.index ? { tag: 'none' } : idx.entry(i));
  const noBase = await packSubset(rangeFromBytes(packs.ref), damaged, [r.index]);
  assert.equal(noBase.ok, false);
  assert.equal(noBase.error.code, 'bad_request');
  assert.match(noBase.error.message, /REF_DELTA with no base id/);
});

test('an index changed after planning: the stream errors instead of sending a length it did not plan', async () => {
  const idx = await scan(packs.ofs);
  const wholes = [...idx.entries()].filter(e => e.base.tag === 'none').map(e => e.index);
  const built = unwrap(await packSubset(rangeFromBytes(packs.ofs), idx, wholes));
  idx.columns.compressed[wholes.at(-1)] -= 1;
  await assert.rejects(drain(built.stream), e => e.code === 'internal' && /wrote \d+ bytes, planned \d+/.test(e.message));
});

test('the selection is copied at the call: changing the array afterwards changes nothing git can see', async () => {
  const idx = await scan(packs.ofs);
  const c = idx.columns;
  const entries = [...idx.entries()];
  // git's own ids for the source's entries
  const oidOf = new Map([...indexByOid(packs.ofs, idx)].map(([oid, i]) => [i, oid]));
  // D is an OFS_DELTA on the whole object A; X is another whole object
  const d = entries.find(e => e.base.tag === 'ofs' && entries[c.baseIndex[e.index]].base.tag === 'none').index;
  const a = c.baseIndex[d];
  const x = entries.find(e => e.base.tag === 'none' && e.index !== a).index;
  const want = [oidOf.get(a), oidOf.get(x), oidOf.get(d)];
  const listed = bytes => verifyPack(bytes).toSorted((p, q) => p.offset - q.offset).map(r => r.oid);
  // left alone
  const plain = await drain(unwrap(await packSubset(rangeFromBytes(packs.ofs), idx, [a, x, d])).stream);
  assert.deepEqual(listed(plain), want);
  // the caller reuses its array before the stream is read (a batching loop's scratch array): A and X swapped, so D's
  // planned distance would land on X
  const sel = [a, x, d];
  const built = unwrap(await packSubset(rangeFromBytes(packs.ofs), idx, sel));
  sel[0] = x;
  sel[1] = a;
  const changed = await drain(built.stream);
  // git index-pack accepts it (verifyPack runs it) and lists the objects the call named, in the order it named them
  assert.deepEqual(listed(changed), want);
  assert.equal(verifyPack(changed).find(r => r.oid === oidOf.get(d)).base, oidOf.get(a), 'D is still a delta on A');
  assert.deepEqual(changed, plain);
  // more entries than the pack has cannot all be distinct and in it: refused before anything is sized by the selection
  const over = await packSubset(rangeFromBytes(packs.ofs), idx, new Array(idx.count + 1).fill(a));
  assert.equal(over.ok, false);
  assert.equal(over.error.code, 'bad_request');
});

test('an extra a pack cannot hold is refused before the source sees a read', async () => {
  const idx = await scan(packs.ofs);
  const data = te.encode('an extra\n');
  // gitformat-pack: an undeltified entry's type is 1 (commit), 2 (tree), 3 (blob) or 4 (tag); 0 is invalid and 5
  // reserved; 6 and 7 are deltas, which need a base; a REF_DELTA's base is a 20-byte object name, 40 hex digits.
  // (The reviewer's run had git index-pack reject the pack built from each of these.)
  const invalid = [
    ['type 9', { type: 9, data }],
    ['type 0', { type: 0, data }],
    ['type 5', { type: 5, data }],
    ['type 7 (REF_DELTA) with no base', { type: 7, data }],
    ['type 6 (OFS_DELTA) with no base', { type: 6, data }],
    ['a fractional type', { type: 1.5, data }],
    ['a REF base that is not hex', { type: TYPE.BLOB, data, base: { tag: 'ref', oid: 'zz' } }],
    ['a REF base of 39 hex digits', { type: TYPE.BLOB, data, base: { tag: 'ref', oid: 'a'.repeat(39) } }],
    ['a base of no known tag', { type: TYPE.BLOB, data, base: { tag: 'offset', index: 0 } }],
    ['data that is not bytes', { type: TYPE.BLOB, data: 'an extra\n' }],
    // not an object at all: there is no entry to write, and packSubset returns a Result (it never throws or rejects)
    ['an extra that is null', null],
    ['an extra that is undefined', undefined],
    ['an extra that is a number', 7],
  ];
  for (const [name, extra] of invalid) {
    const src = countingSource(packs.ofs);
    // a valid extra first: the refusal names the one at fault
    const r = await packSubset(src, idx, [0], { extras: [{ type: TYPE.BLOB, data }, extra] });
    assert.equal(r.ok, false, name);
    assert.equal(r.error.code, 'bad_request', name);
    assert.equal(r.error.what, 'pack subset extras', name);
    assert.match(r.error.message, /extra 1 /, name);
    assert.equal(src.state.reads, 0, `${name}: no read`);
  }
});

test('extras that is not an array is refused (bad_request), never thrown', async () => {
  const idx = await scan(packs.ofs);
  // The expected outcome is the contract's: packSubset returns a Result, so a caller's wrong value is a coded refusal
  // (bad_request, what: 'pack subset extras'), not a TypeError out of the promise, and nothing is read for it.
  const invalid = [['null', null], ['a number', 7], ['a string', 'ab'], ['a plain object', {}], ['an array-like', { length: 1, 0: { type: TYPE.BLOB, data: te.encode('x') } }], ['bytes', new Uint8Array(2)]];
  for (const [name, extras] of invalid) {
    const src = countingSource(packs.ofs);
    const settled = await packSubset(src, idx, [0], { extras }).then(r => ({ r }), thrown => ({ thrown }));
    assert.equal(settled.thrown, undefined, `${name}: rejected with ${String(settled.thrown)}`);
    assert.equal(settled.r.ok, false, name);
    assert.equal(settled.r.error.code, 'bad_request', name);
    assert.equal(settled.r.error.what, 'pack subset extras', name);
    assert.equal(src.state.reads, 0, `${name}: no read`);
  }
  // left out, or passed as the missing value, is no extras: the pack is the selection alone
  for (const opts of [{}, { extras: undefined }]) {
    const built = unwrap(await packSubset(rangeFromBytes(packs.ofs), idx, [0], opts));
    assert.equal(built.count, 1);
  }
});

test('rangeFromBytes refuses a range outside its bytes', async () => {
  const src = rangeFromBytes(new Uint8Array(8));
  for (const [o, l] of [[4, 5], [-1, 2], [9, 0], [0.5, 1]]) {
    const r = await src.read(o, l);
    assert.equal(r.ok, false, `${o}+${l}`);
    assert.equal(r.error.code, 'bad_request');
    assert.match(r.error.message, /outside 8 bytes/);
  }
  assert.ok((await src.read(0, 8)).ok);
});

test('runs of consecutive entries are one range read each', async () => {
  const idx = await scan(packs.ofs);
  const wholes = [...idx.entries()].filter(e => e.base.tag === 'none').map(e => e.index);
  // runs in the selection (consecutive source indices written consecutively)
  let runs = 0;
  for (let k = 0; k < wholes.length; k++) if (k === 0 || wholes[k] !== wholes[k - 1] + 1) runs++;
  const { reads } = await build(packs.ofs, idx, wholes);
  assert.equal(reads, runs);
});

test('a range that serves too few or too many bytes errors the stream before the trailer', async () => {
  const idx = await scan(packs.ofs);
  const all = [...Array(idx.count).keys()];
  for (const misbehave of [{ short: 1 }, { long: 1 }]) {
    const built = unwrap(await packSubset(countingSource(packs.ofs, misbehave), idx, all));
    await assert.rejects(drain(built.stream), e => e.code === 'pack_corrupt', JSON.stringify(misbehave));
  }
  const failing = { size: packs.ofs.length, read: async () => ({ ok: false, error: Object.assign(new Error('gone'), { code: 'network' }) }) };
  const built = unwrap(await packSubset(failing, idx, all));
  await assert.rejects(drain(built.stream), e => e.code === 'network');
});

test('a consumer that cancels the stream cancels the range read', async () => {
  const idx = await scan(packs.ofs);
  const src = countingSource(packs.ofs);
  const built = unwrap(await packSubset(src, idx, [...Array(idx.count).keys()]));
  const reader = built.stream.getReader();
  await reader.read();
  await reader.read();
  await reader.cancel();
  assert.equal(src.state.cancelled, 1);
});

// A hang is proved by a step counter, not a clock: `turns` event-loop turns pass while the promise is still pending.
// (A cancel that works settles within a few microtasks of the call, before the first turn.)
const settledWithin = async (promise, turns = 50) => {
  let state = 'pending';
  promise.then(() => { state = 'settled'; }, () => { state = 'settled'; });
  for (let i = 0; i < turns && state === 'pending'; i++) await new Promise(r => setImmediate(r));
  return state;
};
const readAll = async reader => { for (;;) { const r = await reader.read(); if (r.done) return; } };
// A source that stops answering: `open: 'never'` leaves read() itself pending for ever; `open: 'stall'` opens a range
// that serves `serve` bytes and then never another. `parked` resolves once the source is in that state.
function stallingSource(bytes, { open, serve = 0 }) {
  const state = { reads: 0, cancelled: 0, aborted: 0 };
  let reached;
  const parked = new Promise(r => { reached = r; });
  return {
    state, parked, size: bytes.length,
    read(offset, length, signal) {
      state.reads++;
      signal?.addEventListener('abort', () => { state.aborted++; });
      if (open === 'never') { reached(); return new Promise(() => {}); }
      let at = offset;
      return Promise.resolve({ ok: true, value: new ReadableStream({
        pull(c) {
          if (at - offset >= serve) { reached(); return new Promise(() => {}); }
          const len = Math.min(serve - (at - offset), offset + length - at);
          c.enqueue(bytes.subarray(at, at + len));
          at += len;
          return undefined;
        },
        cancel() { state.cancelled++; },
      }, { highWaterMark: 0 }) });
    },
  };
}

test('cancel settles while a range read is in flight, whether or not the source ever answers', async () => {
  const idx = await scan(packs.ofs);
  const all = [...Array(idx.count).keys()];
  // the range is open and has stalled: cancel settles, and the range is cancelled
  const stalled = stallingSource(packs.ofs, { open: 'stall', serve: 1000 });
  const a = unwrap(await packSubset(stalled, idx, all)).stream.getReader();
  const drainA = readAll(a);
  await stalled.parked;
  assert.equal(await settledWithin(a.cancel('stop')), 'settled', 'cancel() with a stalled range');
  assert.equal(await settledWithin(drainA), 'settled', 'the read that was pending');
  assert.equal(stalled.state.cancelled, 1, 'the stalled range is cancelled');
  assert.equal(stalled.state.aborted, 1, 'the source is told through its signal');
  // read() itself never resolves: cancel settles all the same, and the source is told through its signal
  const never = stallingSource(packs.ofs, { open: 'never' });
  const b = unwrap(await packSubset(never, idx, all)).stream.getReader();
  const drainB = readAll(b);
  await never.parked;
  assert.equal(await settledWithin(b.cancel('stop')), 'settled', 'cancel() with read() pending');
  assert.equal(await settledWithin(drainB), 'settled', 'the read that was pending');
  assert.equal(never.state.reads, 1);
  assert.equal(never.state.aborted, 1, 'a source that takes a signal is aborted');
});

test('the reason a cancelled range receives: the consumer\'s own, an AbortError when it gave none; the signal carries the same', async () => {
  const idx = await scan(packs.ofs);
  // DOM: AbortController.abort() with no reason sets an "AbortError" DOMException; a given reason is kept as it is
  const cases = [['stop', r => r === 'stop'], [undefined, r => r instanceof DOMException && r.name === 'AbortError']];
  for (const [given, expected] of cases) {
    const seen = { cancels: [], aborts: [] };
    let reached;
    const parked = new Promise(r => { reached = r; });
    const source = {
      size: packs.ofs.length,
      read(offset, length, signal) {
        // a read given no signal records no abort, so the assertions below fail rather than this source throwing
        signal?.addEventListener('abort', () => { seen.aborts.push(signal.reason); });
        return Promise.resolve({ ok: true, value: new ReadableStream({ pull() { reached(); return new Promise(() => {}); }, cancel(why) { seen.cancels.push(why); } }, { highWaterMark: 0 }) });
      },
    };
    const reader = unwrap(await packSubset(source, idx, [...Array(idx.count).keys()])).stream.getReader();
    const drained = readAll(reader);
    // no wait here is bare: a cancel that waits for the range (which never answers) fails the test, it does not hang it
    assert.equal(await settledWithin(parked), 'settled', 'the range is open and has stalled');
    assert.equal(await settledWithin(reader.cancel(given)), 'settled', `cancel(${String(given)}) with a stalled range`);
    assert.equal(await settledWithin(drained), 'settled', 'the read that was pending');
    assert.equal(seen.cancels.length, 1, String(given));
    assert.ok(expected(seen.cancels[0]), `the range's cancel reason for ${String(given)}: ${String(seen.cancels[0])}`);
    assert.deepEqual(seen.aborts, seen.cancels, 'read\'s signal aborts with the same reason');
  }
  // a range that is refused (it serves more bytes than were asked for) is cancelled with null, not with an error
  const refused = [];
  const long = { size: packs.ofs.length, read: (offset, length) => Promise.resolve({ ok: true, value: new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(length + 1)); }, cancel(why) { refused.push(why); } }, { highWaterMark: 0 }) }) };
  await assert.rejects(readAll(unwrap(await packSubset(long, idx, [...Array(idx.count).keys()])).stream.getReader()));
  assert.deepEqual(refused, [null]);
});

test('a range opened after the stream was cancelled is cancelled, not left open', async () => {
  const idx = await scan(packs.ofs);
  // read() answers only when the test lets it, which is after the cancel
  let answer, reached, cancelled = 0;
  const parked = new Promise(r => { reached = r; });
  const late = { size: packs.ofs.length, read: () => new Promise(r => { answer = r; reached(); }) };
  const s = unwrap(await packSubset(late, idx, [...Array(idx.count).keys()])).stream.getReader();
  const drained = readAll(s);
  await parked;
  assert.equal(await settledWithin(s.cancel()), 'settled');
  assert.equal(await settledWithin(drained), 'settled');
  answer({ ok: true, value: new ReadableStream({ cancel() { cancelled++; } }) });
  await new Promise(r => setImmediate(r));
  assert.equal(cancelled, 1, 'the late range');
});

test('pushPack over a source that stalls mid-range: an abort returns an outcome, and the ref did not move', async () => {
  const idx = await scan(packs.ofs);
  const src = stallingSource(packs.ofs, { open: 'stall', serve: 100_000 });
  const built = unwrap(await packSubset(src, idx, [...Array(idx.count).keys()]));
  const name = `stall${n++}`;
  const bare = makeBareRepo(root, name);
  const ac = new AbortController();
  const t = unwrap(createTransport(`${srv.url}/${name}.git`, { signal: ac.signal }));
  const pushed = pushPackChecked(t, { ref: REF, oldOid: ZERO_OID, newOid: packs.head, pack: built.stream, length: built.length, sideband: false });
  await src.parked;
  ac.abort(new Error('caller gave up'));
  const { result: r } = await pushed;
  // the request was under way with part of the pack sent: what the server did with it is not known to the client
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ambiguous', r.error.message);
  assert.equal(src.state.cancelled, 1, 'the stalled range is cancelled');
  // git is the witness that nothing landed: a pack cut short cannot move a ref
  assert.throws(() => git(bare, ['rev-parse', '--verify', '-q', REF]));
}, 20_000);

test('pushPack round trip: a reordered subset pushed to git http-backend lands, fsck --strict clean', async () => {
  const idx = await scan(packs.ofs);
  const c = idx.columns;
  // children-first by type is what a transfer does; here: wholes (blobs, trees, commits) reversed, then deltas topologically
  const wholes = [...idx.entries()].filter(e => e.base.tag === 'none').map(e => e.index).reverse();
  const placed = new Set(wholes);
  const order = [...wholes];
  let left = [...idx.entries()].filter(e => e.base.tag !== 'none').map(e => e.index);
  while (left.length) {
    for (const i of left.filter(j => placed.has(c.baseIndex[j]))) { order.push(i); placed.add(i); }
    left = left.filter(i => !placed.has(i));
  }
  const built = unwrap(await packSubset(rangeFromBytes(packs.ofs), idx, order));
  const name = `push${n++}`;
  const bare = makeBareRepo(root, name);
  const t = unwrap(createTransport(`${srv.url}/${name}.git`));
  const { result: r } = await pushPackChecked(t, { ref: REF, oldOid: ZERO_OID, newOid: packs.head, pack: built.stream, length: built.length, sideband: false });
  assert.equal(r.ok, true, r.ok ? '' : r.error.message);
  assert.equal(git(bare, ['rev-parse', REF]).trim(), packs.head);
  assert.deepEqual(fsckProblems(bare, { args: ['--strict'] }), []);
});

test('memory: a subset of a source far larger than what is held', async () => {
  // 48 entries of 4 MiB stored blobs (192 MiB of pack), every other one selected, drained slowly
  const child = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [...MEMORY_CELL_FLAGS, '--import', './test/ts-resolve.mjs', 'test/pack-subset-child.mjs', String(4 << 20), '48'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let text = '';
    p.stdout.on('data', d => { text += d; });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve(JSON.parse(text)) : reject(new Error(`child exited ${code}`))));
  });
  assert.equal(child.ok, true, child.error ?? '');
  assert.equal(child.sent, child.length);
  assert.ok(child.sourceBytes > 150 << 20, 'the source is far larger than the bound');
  // held: one 64 KiB range chunk in flight plus small headers, not the pack (allowance for the drain's own chunk)
  assert.ok(child.liveDelta < 1 << 20, `live ${child.liveDelta} B`);
}, 120_000);

// ---- every operation that reads the caller's storage, not only packSubset's stream: an abort settles it ----
// The source is scripted, never slept on: read number `at` (0-based) stops answering, earlier reads are served from the
// bytes. 'never' leaves read() itself pending for ever; 'stall' opens a range whose first chunk never comes. `parked`
// resolves when the source is in that state, and the counters say what the operation told it afterwards.
function stallAt(bytes, at, how) {
  const real = rangeFromBytes(bytes);
  const state = { reads: 0, cancelled: 0, aborted: 0 };
  let reached;
  const parked = new Promise(r => { reached = r; });
  return {
    state, parked, size: bytes.length,
    read(offset, length, signal) {
      const i = state.reads++;
      if (i < at) return real.read(offset, length, signal);
      // an operation that passes no signal still parks here: its test then fails at 'the abort settles it'
      signal?.addEventListener('abort', () => { state.aborted++; });
      if (how === 'never') { reached(); return new Promise(() => {}); }
      return Promise.resolve({ ok: true, value: new ReadableStream({
        pull() { reached(); return new Promise(() => {}); },
        cancel() { state.cancelled++; },
      }, { highWaterMark: 0 }) });
    },
  };
}

// The expected outcome is the contract's, not ply's output: an operation its caller aborts ends with the error code
// `aborted` (errors.ts: retry 'no'), and it ends when the signal fires, not when the storage answers (it never does
// here). `stalledRead` is the read each operation is parked at, counted from the operation's own description:
//   packIdentity      read 0 is the trailer
//   resolvePackRange  read 0 is the first entry read back
//   loadTransferPack  read 0 the trailer (packIdentity), read 1 the whole spool (opened here, read by the scan),
//                     read 2 the first entry read back by the resolve
const ABORTABLE = [
  ['packIdentity', 0, (source, signal) => packIdentity(source, signal)],
  ['resolvePackRange', 0, (source, signal, idx) => resolvePackRange(idx, source, { signal })],
  ['loadTransferPack: the trailer', 0, (source, signal, idx, dst) => loadTransferPack(dst, source, { tag: 'none' }, { signal })],
  ['loadTransferPack: the scan', 1, (source, signal, idx, dst) => loadTransferPack(dst, source, { tag: 'none' }, { signal })],
  ['loadTransferPack: the resolve', 2, (source, signal, idx, dst) => loadTransferPack(dst, source, { tag: 'none' }, { signal })],
];
for (const [name, stalledRead, run] of ABORTABLE) {
  for (const how of ['never', 'stall']) {
    test(`${name}: an abort settles it 'aborted' while the storage never answers (${how})`, async () => {
      const idx = await scan(packs.ofs);
      const dst = unwrap(createTransport(`${srv.url}/none.git`));
      const source = stallAt(packs.ofs, stalledRead, how);
      const ac = new AbortController();
      const op = run(source, ac.signal, idx, dst);
      // bounded like every wait below: an operation that never reaches the read fails here, it does not hang
      assert.equal(await settledWithin(source.parked), 'settled', 'the operation reached the read the case names');
      assert.equal(source.state.reads, stalledRead + 1, 'parked at the read the case names');
      assert.equal(await settledWithin(op, 20), 'pending', 'it is waiting for the storage');
      ac.abort(new Error('stop'));
      assert.equal(await settledWithin(op), 'settled', 'the abort settles it');
      const r = await op;
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'aborted');
      assert.equal(source.state.aborted, 1, 'the source is told through the signal of the read in flight');
      if (how === 'stall') assert.equal(source.state.cancelled, 1, 'the range in flight is cancelled');
      assert.equal(source.state.reads, stalledRead + 1, 'and nothing more is read');
    });
  }
}

// A signal that aborted before the call: the operation is `aborted` and the storage is not asked for anything. The
// expected values are the contract's, not ply's output: the error code `aborted` (errors.ts), and 0 on the test's own
// counters (no read issued, so no range opened and none to cancel). One test for each entry point that takes a signal
// and a source.
const abortedBefore = () => { const ac = new AbortController(); ac.abort(new Error('before')); return ac.signal; };
test('packIdentity: a signal aborted before the call is aborted before any storage read', async () => {
  const source = countingSource(packs.ofs);
  const op = packIdentity(source, abortedBefore());
  assert.equal(await settledWithin(op), 'settled');
  const r = await op;
  assert.deepEqual({ code: r.ok ? 'ok' : r.error.code, ...source.state }, { code: 'aborted', reads: 0, cancelled: 0 });
});
test('resolvePackRange: a signal aborted before the call is aborted before any storage read, a pack of whole objects included', async () => {
  // git's own pack of the same history with the delta search off: every object is stored whole, so resolving it needs
  // no read at all and only a check at the entry can see the abort. verify-pack says which pack has deltas.
  const whole = new Uint8Array(gitBuf(work, ['pack-objects', '--revs', '--stdout', '-q', '--window=0'], `${packs.head}\n`));
  assert.equal(verifyPack(whole).filter(r => r.base !== null).length, 0, 'the whole-object pack has no delta');
  assert.ok(verifyPack(packs.ofs).some(r => r.base !== null), 'the other pack has deltas');
  const seen = {};
  for (const [name, bytes] of [['deltas', packs.ofs], ['whole objects', whole]]) {
    const idx = await scan(bytes);
    const source = countingSource(bytes);
    const op = resolvePackRange(idx, source, { signal: abortedBefore() });
    assert.equal(await settledWithin(op), 'settled', name);
    const r = await op;
    seen[name] = { code: r.ok ? 'ok' : r.error.code, ...source.state };
  }
  assert.deepEqual(seen, {
    deltas: { code: 'aborted', reads: 0, cancelled: 0 },
    'whole objects': { code: 'aborted', reads: 0, cancelled: 0 },
  });
});

test('scanPackIndex: an abort settles it while its stream, or its iterator, never yields; the source is asked to stop', async () => {
  // a ReadableStream that serves 100 bytes and then nothing
  const src = stallingSource(packs.ofs, { open: 'stall', serve: 100 });
  const stream = (await src.read(0, packs.ofs.length, new AbortController().signal)).value;
  const a = new AbortController();
  const scanA = scanPackIndex(stream, { signal: a.signal });
  await src.parked;
  assert.equal(await settledWithin(scanA, 20), 'pending');
  a.abort(new Error('stop'));
  assert.equal(await settledWithin(scanA), 'settled', 'a stalled stream');
  const ra = await scanA;
  assert.equal(ra.ok, false);
  assert.equal(ra.error.code, 'aborted');
  assert.equal(src.state.cancelled, 1, 'the stream is cancelled');
  // an async iterable whose next() never resolves
  const seen = { next: 0, returned: 0 };
  let reached;
  const parked = new Promise(r => { reached = r; });
  const iterable = { [Symbol.asyncIterator]: () => ({
    next() { seen.next++; reached(); return new Promise(() => {}); },
    return() { seen.returned++; return new Promise(() => {}); },
  }) };
  const b = new AbortController();
  const scanB = scanPackIndex(iterable, { signal: b.signal });
  await parked;
  b.abort(new Error('stop'));
  assert.equal(await settledWithin(scanB), 'settled', 'a stalled iterator whose return() never settles either');
  const rb = await scanB;
  assert.equal(rb.ok, false);
  assert.equal(rb.error.code, 'aborted');
  assert.deepEqual(seen, { next: 1, returned: 1 });
  // a signal that aborted before the call: nothing is waited for at all
  const c = new AbortController();
  c.abort(new Error('before'));
  const scanC = scanPackIndex({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }, { signal: c.signal });
  assert.equal(await settledWithin(scanC), 'settled', 'a signal aborted before the call');
  const rc = await scanC;
  assert.equal(rc.ok, false);
  assert.equal(rc.error.code, 'aborted');
});

test('what the storage answers after the abort is dropped: a late range is cancelled, a late rejection is not unhandled', async () => {
  const idx = await scan(packs.ofs);
  const unhandled = [];
  const note = e => { unhandled.push(e); };
  process.on('unhandledRejection', note);
  try {
    for (const late of ['opens', 'rejects']) {
      const state = { reads: 0, cancelled: 0 };
      let answer, refuse, reached;
      const parked = new Promise(r => { reached = r; });
      const source = { size: packs.ofs.length, read() {
        state.reads++;
        reached();
        return new Promise((resolve, reject) => { answer = resolve; refuse = reject; });
      } };
      const ac = new AbortController();
      const op = resolvePackRange(idx, source, { signal: ac.signal });
      await parked;
      ac.abort(new Error('stop'));
      assert.equal(await settledWithin(op), 'settled', late);
      assert.equal((await op).error.code, 'aborted', late);
      // only now does the storage answer
      if (late === 'opens') answer({ ok: true, value: new ReadableStream({ cancel() { state.cancelled++; } }) });
      else refuse(new Error('the storage failed, late'));
      for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
      assert.equal(state.cancelled, late === 'opens' ? 1 : 0, `${late}: a range that opened late is cancelled, not left open`);
      assert.equal(state.reads, 1, late);
    }
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', note);
  }
});

test('haltOn: every await in flight is released at the abort, and a finished operation leaves nothing on the signal', async () => {
  const ac = new AbortController();
  // count the listeners on the caller's signal with the platform's own add/remove
  const listeners = new Set();
  const add = ac.signal.addEventListener.bind(ac.signal);
  const remove = ac.signal.removeEventListener.bind(ac.signal);
  ac.signal.addEventListener = (type, fn, o) => { listeners.add(fn); add(type, fn, o); };
  ac.signal.removeEventListener = (type, fn, o) => { listeners.delete(fn); remove(type, fn, o); };
  const done = rangesource.haltOn(ac.signal);
  assert.equal(listeners.size, 1);
  // not halted: the race is the promise's own outcome, a value or a rejection
  assert.equal(await done.race(Promise.resolve(7), () => {}), 7);
  await assert.rejects(done.race(Promise.reject(new Error('mine')), () => {}), /mine/);
  done.release();
  assert.equal(listeners.size, 0, 'release() takes the listener off a signal that outlives the operation');
  // two awaits in flight at once: both are released, and each late value goes to its own `late`
  const halt = rangesource.haltOn(ac.signal);
  const late = [];
  let first, second;
  const one = halt.race(new Promise(r => { first = r; }), v => { late.push(v); });
  const two = halt.race(new Promise(r => { second = r; }), v => { late.push(v); });
  ac.abort(new Error('stop'));
  assert.deepEqual(await Promise.all([one, two]), [rangesource.HALTED, rangesource.HALTED]);
  first('a');
  second('b');
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.deepEqual(late, ['a', 'b']);
  // after the abort nothing is waited for, not even a promise that never settles
  assert.equal(await halt.race(new Promise(() => {}), () => {}), rangesource.HALTED);
});

test('a source whose read answers with its Result itself, not a promise of it, is read as a promise of it would be', async () => {
  // A JavaScript caller's source: read() returns { ok, value } synchronously. Every await on it was a bare await before
  // the abort work, and a bare await takes a plain value. Expected values, none from the code under test: git's own
  // pack bytes; the pack format's trailer (the SHA-1 of every byte before it, here node:crypto's) and the pack's
  // length; and the object ids `git verify-pack -v` lists for the pack.
  const idx = await scan(packs.ofs);
  const all = [...Array(idx.count).keys()];
  const source = { size: packs.ofs.length, read: (offset, length) => ({ ok: true, value: rangeStream(packs.ofs.subarray(offset, offset + length)) }) };
  // bounded like every wait in this file: a drain or a call that never ends fails here, it does not hang
  const built = unwrap(await packSubset(source, idx, all));
  const drained = drain(built.stream);
  assert.equal(await settledWithin(drained, 2000), 'settled', 'the drain ends');
  assert.deepEqual(await drained, packs.ofs);
  const trailer = createHash('sha1').update(packs.ofs.subarray(0, packs.ofs.length - 20)).digest('hex');
  const byOid = indexByOid(packs.ofs, idx);
  assert.equal(byOid.size, idx.count, 'git lists every entry of the pack');
  for (const signal of [undefined, new AbortController().signal]) {
    const identity = packIdentity(source, signal);
    assert.equal(await settledWithin(identity, 2000), 'settled', 'packIdentity ends');
    assert.deepEqual(unwrap(await identity), { trailer, bytes: packs.ofs.length });
    const resolving = resolvePackRange(idx, source, signal === undefined ? {} : { signal });
    assert.equal(await settledWithin(resolving, 2000), 'settled', 'resolvePackRange ends');
    const resolved = unwrap(await resolving);
    for (const [oid, i] of byOid) assert.equal(resolved.oid(i).value, oid);
    // loadTransferPack opens the whole spool through the same read (no index on the destination: it scans)
    const dst = unwrap(createTransport(`${srv.url}/none.git`));
    const loading = loadTransferPack(dst, source, { tag: 'none' }, signal === undefined ? {} : { signal });
    assert.equal(await settledWithin(loading, 2000), 'settled', 'loadTransferPack ends');
    const loaded = unwrap(await loading);
    for (const [oid, i] of byOid) assert.equal(loaded.from.resolved.oid(i).value, oid);
  }
});

test('a range that is a ReadableStream subclass serving its bytes through its own getReader() is read through that reader', async () => {
  // The subclass has no underlying source: its bytes come only from the reader its own getReader() returns (the idiom
  // test/push-pack.test.js uses for a caller-controlled reader). Expected values, none from the code under test: git's
  // own pack bytes; one read, because the whole pack in order is one run; one getReader call, one per range.
  const idx = await scan(packs.ofs);
  const all = [...Array(idx.count).keys()];
  const seen = { reads: 0, readers: 0 };
  const source = { size: packs.ofs.length, read(offset, length) {
    seen.reads++;
    const inner = rangeStream(packs.ofs.subarray(offset, offset + length)).getReader();
    class Served extends ReadableStream { getReader() { seen.readers++; return inner; } }
    return Promise.resolve({ ok: true, value: new Served() });
  } };
  const built = unwrap(await packSubset(source, idx, all));
  const drained = drain(built.stream);
  // bounded: a range whose bytes are never read fails here, it does not hang
  assert.equal(await settledWithin(drained, 2000), 'settled', 'the drain ends');
  assert.deepEqual(await drained, packs.ofs);
  assert.deepEqual(seen, { reads: 1, readers: 1 });
});

// ---- a range reader that breaks the streams contract when asked to cancel ----
// The two ways a hand-written reader does: cancel() answers with no promise, or throws where it stands. The range is
// the caller's, and its failure to cancel is its own: ply asks it to stop and waits for nothing, so neither may reach
// anyone as an error or hold an operation past its abort.
const BROKEN_CANCEL = [
  ['returns undefined', () => undefined],
  ['throws where it stands', () => { throw new Error('sync cancel'); }],
];
// What node reports thrown out of every caller's reach while `run` runs. An error thrown inside an AbortSignal listener
// (where an abort asks the range in flight to cancel) is caught by no one: node raises it as an uncaughtException on a
// later tick, which ends a process that has no handler for it. The turns after `run` let that tick come.
const uncaughtDuring = async run => {
  const seen = [];
  const onUncaught = e => { seen.push(String(e)); };
  process.on('uncaughtException', onUncaught);
  try {
    await run();
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  return seen;
};
for (const [name, broken] of BROKEN_CANCEL) {
  test(`cancelRange asks a range to stop and does not throw when its cancel() ${name}`, () => {
    // Expected values are the test's own: the one reason it gave, seen once by the range's cancel()
    const reason = new Error('stop');
    const reasons = [];
    assert.doesNotThrow(() => rangesource.cancelRange({ cancel(why) { reasons.push(why); return broken(why); } }, reason));
    assert.deepEqual(reasons, [reason]);
  });

  test(`packSubset over a range read through its own reader, whose cancel() ${name}: the consumer's cancel settles and nothing is thrown`, async () => {
    // The range is a ReadableStream subclass that defines getReader, so it is read through the reader that returns.
    // Expected values, none from the code under test: the streams contract for the consumer (cancel() fulfils with
    // undefined), node's own uncaughtException event (none raised), and the test's counter (the range was asked to stop).
    const idx = await scan(packs.ofs);
    const seen = { cancels: 0 };
    const source = { size: packs.ofs.length, read(offset, length) {
      let at = offset;
      const reader = {
        // 256 bytes a read, so the consumer's cancel lands with the range open and most of it unread
        read() {
          const n = Math.min(256, offset + length - at);
          if (n === 0) return Promise.resolve({ done: true, value: undefined });
          at += n;
          return Promise.resolve({ done: false, value: packs.ofs.subarray(at - n, at) });
        },
        cancel(why) { seen.cancels++; return broken(why); },
        releaseLock() {},
      };
      class Served extends ReadableStream { getReader() { return reader; } }
      return Promise.resolve({ ok: true, value: new Served() });
    } };
    let cancelled = 'not reached';
    const uncaught = await uncaughtDuring(async () => {
      const consumer = unwrap(await packSubset(source, idx, [...Array(idx.count).keys()])).stream.getReader();
      for (let got = 0; got < 2000;) {
        const chunk = consumer.read();
        // bounded like every wait in this file: a read or a cancel that never ends fails here, it does not hang
        assert.equal(await settledWithin(chunk), 'settled', 'a chunk of the new pack');
        const r = await chunk;
        assert.equal(r.done, false, 'the pack is longer than what is read before the cancel');
        got += r.value.length;
      }
      const cancelling = consumer.cancel(new Error('consumer left'));
      assert.equal(await settledWithin(cancelling), 'settled', 'cancel()');
      cancelled = await cancelling.then(v => ({ fulfilled: v }), e => ({ rejected: String(e) }));
    });
    assert.deepEqual({ cancelled, uncaught }, { cancelled: { fulfilled: undefined }, uncaught: [] });
    assert.ok(seen.cancels >= 1, 'the open range was asked to stop');
  });

  // The expected outcome is the contract's, as for ABORTABLE above: `aborted` when the signal fires, though the read in
  // flight never answers. The counters are the test's own: one read issued, and its range asked once to stop.
  const SIGNALLED = [
    ['packIdentity', (source, signal) => packIdentity(source, signal)],
    ['resolvePackRange', (source, signal, idx) => resolvePackRange(idx, source, { signal })],
  ];
  for (const [op, run] of SIGNALLED) {
    test(`${op}: an abort settles it 'aborted' with a read in flight on a range whose cancel() ${name}`, async () => {
      const idx = await scan(packs.ofs);
      const seen = { reads: 0, cancels: 0 };
      let reached;
      const parked = new Promise(r => { reached = r; });
      const source = { size: packs.ofs.length, read() {
        seen.reads++;
        const reader = {
          read() { reached(); return new Promise(() => {}); },
          cancel(why) { seen.cancels++; return broken(why); },
          releaseLock() {},
        };
        class Stalled extends ReadableStream { getReader() { return reader; } }
        return Promise.resolve({ ok: true, value: new Stalled() });
      } };
      const ac = new AbortController();
      let outcome = 'not reached';
      const uncaught = await uncaughtDuring(async () => {
        const running = run(source, ac.signal, idx);
        assert.equal(await settledWithin(parked), 'settled', 'the operation is reading the range');
        assert.equal(await settledWithin(running, 20), 'pending', 'it is waiting for the storage');
        ac.abort(new Error('stop'));
        assert.equal(await settledWithin(running), 'settled', 'the abort settles it');
        const r = await running;
        outcome = r.ok ? 'ok' : r.error.code;
      });
      assert.deepEqual({ outcome, uncaught, ...seen }, { outcome: 'aborted', uncaught: [], reads: 1, cancels: 1 });
    });
  }
}

test('a chunk read is not a promise race: a whole pack served 256 bytes at a time is drained without one Promise.race', async () => {
  // Expected values, neither from the code under test: 0 is the owner's decision (no race per read), and the bytes are
  // git's own pack. The count is the platform's Promise.race, wrapped for the length of the drain.
  const idx = await scan(packs.ofs);
  const all = [...Array(idx.count).keys()];
  let chunks = 0;
  const source = { size: packs.ofs.length, async read(offset, length) {
    let at = offset;
    return { ok: true, value: new ReadableStream({ pull(c) {
      const n = Math.min(256, offset + length - at);
      if (n === 0) { c.close(); return; }
      chunks++;
      c.enqueue(packs.ofs.subarray(at, at + n));
      at += n;
    } }, { highWaterMark: 0 }) };
  } };
  const built = unwrap(await packSubset(source, idx, all));
  const platformRace = Promise.race;
  let races = 0;
  Promise.race = function race(list) { races++; return platformRace.call(this, list); };
  let bytes;
  try { bytes = await drain(built.stream); } finally { Promise.race = platformRace; }
  assert.equal(chunks, Math.ceil(packs.ofs.length / 256), 'every chunk of the pack was read, 256 bytes at a time');
  assert.equal(races, 0);
  assert.deepEqual(bytes, packs.ofs);
});
