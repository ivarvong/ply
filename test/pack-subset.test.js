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
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomFillSync } from 'node:crypto';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, fsckProblems } from './server.js';
import { packSubset } from '../src/packsubset.js';
import { rangeFromBytes } from '../src/rangesource.js';
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
  git(work, ['init', '-q', '-b', 'main']);
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
  const r = await pushPackChecked(t, { ref: REF, oldOid: ZERO_OID, newOid: packs.head, pack: built.stream, length: built.length, sideband: false });
  assert.equal(r.ok, true, r.ok ? '' : r.error.message);
  assert.equal(git(bare, ['rev-parse', REF]).trim(), packs.head);
  assert.deepEqual(fsckProblems(bare, { args: ['--strict'] }), []);
});

test('memory: a subset of a source far larger than what is held', async () => {
  // 48 entries of 4 MiB stored blobs (192 MiB of pack), every other one selected, drained slowly
  const child = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--expose-gc', '--import', './test/ts-resolve.mjs', 'test/pack-subset-child.mjs', String(4 << 20), '48'], { stdio: ['ignore', 'pipe', 'inherit'] });
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
