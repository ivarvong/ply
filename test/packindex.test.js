// Pack index v2 (src/packindex.ts) and the pack walk (src/packwalk.ts), judged by git.
//
// - indexPack and encodePackIndex write the bytes `git index-pack` writes for the same pack: git's own packs (OFS_DELTA
//   from repack, REF_DELTA from pack-objects without --delta-base-offset, the empty pack) and ply's (objectsForPack →
//   planDeltas → buildPack). The 64-bit offset table is read back by `git show-index`.
// - objectsForPack over a store of fetched objects sends exactly `git rev-list --objects <tips> --not <have>`, and each
//   tree and blob carries a path where some commit holds it.
// - End to end, the export a Worker would do with no disk: those three calls plus encodePackIndex and four small text
//   files, served as static files over plain HTTP (git's dumb protocol: no git on the server), are cloned by stock git,
//   pass `fsck --strict`, and have the source's refs.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, mkdtempSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { git, gitBuf, gitAsync, tmpRoot, fsckProblems } from './server.js';
import { encodePackIndex, indexPack, layoutPackIndex } from '../src/packindex.js';
import { objectsForPack, reachableObjects, mapStore } from '../src/packwalk.js';
import { encodeDelta, planDeltas } from '../src/delta.js';
import { buildPack, parsePack, resolvePack } from '../src/pack.js';
import { hashObject, TYPE } from '../src/objects.js';
import { fromHex } from '../src/sha1.js';

let root, cleanup;
before(() => { ({ root, cleanup } = tmpRoot()); });
after(() => cleanup());

const ID = ['-c', 'user.name=Ix', '-c', 'user.email=ix@example.com'];
let n = 0;
const fresh = (bare = true) => { const d = mkdtempSync(join(root, `r${n++}-`)); git(d, ['init', '-q', ...(bare ? ['--bare'] : []), '-b', 'main']); return d; };
// A history with something for every pack shape: a file edited in every commit (delta chains), a renamed file, a
// binary blob, nested directories, an executable, a symlink, a gitlink (not followed), a second branch, and an annotated
// and a lightweight tag.
function history() {
  const w = fresh(false);
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i}: ${'lorem ipsum dolor sit amet '.repeat(2)}`);
  const commit = (msg, t) => { git(w, ['add', '-A']); git(w, [...ID, 'commit', '-q', '-m', msg], { env: { ...process.env, GIT_AUTHOR_DATE: `${t} +0000`, GIT_COMMITTER_DATE: `${t} +0000` } }); };
  mkdirSync(join(w, 'src/deep/er'), { recursive: true });
  for (let i = 0; i < 12; i++) {
    lines[i * 7] = `edited in commit ${i}`;
    writeFileSync(join(w, 'src/deep/er/big.txt'), lines.join('\n'));
    writeFileSync(join(w, i < 6 ? 'old-name.txt' : 'new-name.txt'), `${lines.slice(0, 120).join('\n')}\nv${i}\n`);
    if (i === 6) git(w, ['rm', '-q', 'old-name.txt']);
    writeFileSync(join(w, 'bin.dat'), Buffer.from(Array.from({ length: 3000 }, (_, k) => (k * 31 + i) & 0xff)));
    if (i === 0) {
      writeFileSync(join(w, 'run.sh'), '#!/bin/sh\necho hi\n'); execFileSync('chmod', ['+x', join(w, 'run.sh')]);
      execFileSync('ln', ['-s', 'src/deep/er/big.txt', join(w, 'link')]);
      git(w, ['update-index', '--add', '--cacheinfo', `160000,${'5'.repeat(40)},vendor/sub`]);
    }
    commit(`c${i}`, 1_700_000_000 + i * 60);
    if (i === 4) git(w, [...ID, 'tag', '-a', '-m', 'annotated', 'v1']);
    if (i === 8) { git(w, ['branch', 'side']); git(w, ['tag', 'light']); }
  }
  git(w, ['checkout', '-q', 'side']);
  writeFileSync(join(w, 'side.txt'), 'only on side\n');
  commit('side', 1_700_001_000);
  git(w, ['checkout', '-q', 'main']);
  return w;
}
// git's idx for a pack: index-pack in an empty repository (the bytes it writes, and the pack name it prints)
function gitIndex(pack) {
  const d = fresh();
  const p = join(d, 'x.pack');
  writeFileSync(p, pack);
  git(d, ['index-pack', '-o', join(d, 'x.idx'), p]);
  return readFileSync(join(d, 'x.idx'));
}
const unwrap = r => { assert.ok(r.ok, r.ok ? '' : `${r.error.code}: ${r.error.message}`); return r.value; };
const eqBytes = (a, b, what) => { assert.equal(Buffer.compare(Buffer.from(a), Buffer.from(b)), 0, `${what}: ${a.length} vs ${b.length} bytes, not byte-identical`); };
// every object of a repository, as a Worker holds them after one fetch: resolvePack's map
function objectsOf(dir) {
  const pack = gitBuf(dir, ['pack-objects', '--all', '--stdout', '-q'], '');
  return unwrap(resolvePack(unwrap(parsePack(pack)))).objects;
}
const refsOf = dir => git(dir, ['for-each-ref', '--format=%(objectname) %(refname)']).trim().split('\n').map(l => l.split(' '));

test('indexPack writes git index-pack\'s bytes for git\'s own packs: OFS deltas, REF deltas, the empty pack', () => {
  const w = history();
  git(w, ['repack', '-adq', '--depth=50', '--window=10']);
  const packs = readdirSync(join(w, '.git/objects/pack'));
  const name = packs.find(f => f.endsWith('.pack'));
  const ofsPack = readFileSync(join(w, '.git/objects/pack', name));
  const refPack = gitBuf(w, ['pack-objects', '--all', '--stdout', '-q'], ''); // no --delta-base-offset: REF_DELTA
  const emptyPack = gitBuf(w, ['pack-objects', '--stdout', '-q'], '');
  const kinds = p => { const o = unwrap(parsePack(p)).objects; return { ofs: o.filter(x => x.type === TYPE.OFS_DELTA).length, ref: o.filter(x => x.type === TYPE.REF_DELTA).length, all: o.length }; };
  assert.ok(kinds(ofsPack).ofs > 10 && kinds(ofsPack).ref === 0, JSON.stringify(kinds(ofsPack)));
  assert.ok(kinds(refPack).ref > 10 && kinds(refPack).ofs === 0, JSON.stringify(kinds(refPack)));
  for (const [label, pack, gitIdx] of [['repack (OFS_DELTA)', ofsPack, readFileSync(join(w, '.git/objects/pack', name.replace(/\.pack$/, '.idx')))], ['pack-objects (REF_DELTA)', refPack, gitIndex(refPack)], ['empty', emptyPack, gitIndex(emptyPack)]]) {
    const r = unwrap(indexPack(pack));
    eqBytes(r.idx, gitIdx, label);
    assert.equal(r.objects, kinds(pack).all);
    assert.equal(r.checksum, Buffer.from(pack.subarray(pack.length - 20)).toString('hex'));
  }
});

test('objectsForPack sends exactly rev-list --objects, with paths git agrees with; planDeltas + buildPack + encodePackIndex is index-pack\'s idx', async () => {
  const w = history();
  const all = objectsOf(w);
  const store = mapStore(all);
  const tips = refsOf(w).map(([oid]) => oid);
  const listed = (args) => new Set(git(w, ['rev-list', '--objects', ...args]).trim().split('\n').filter(Boolean).map(l => l.slice(0, 40)));
  // (oid, path) pairs that some commit holds: ls-tree -r -t of every commit
  const held = new Set();
  for (const c of git(w, ['rev-list', '--all']).trim().split('\n')) for (const l of git(w, ['ls-tree', '-r', '-t', c]).trim().split('\n')) { const [meta, path] = l.split('\t'); held.add(`${meta.split(' ')[2]} ${path}`); }
  // two cuts: everything, and only what `light` (tag) and main lack beyond v1
  const v1 = git(w, ['rev-parse', 'v1^{commit}']).trim();
  const have = unwrap(await reachableObjects(store, [v1]));
  assert.deepEqual(have, listed([v1]));
  for (const [label, wanted, haveSet, notArgs] of [['everything', tips, new Set(), []], ['beyond v1', ['refs/heads/main', 'refs/tags/light'].map(r => git(w, ['rev-parse', r]).trim()), have, ['--not', v1]]]) {
    const cands = unwrap(await objectsForPack(store, wanted, haveSet));
    assert.deepEqual(new Set(cands.map(c => c.oid)), listed([...wanted, ...notArgs]), label);
    assert.equal(cands.length, new Set(cands.map(c => c.oid)).size, `${label}: an object twice`);
    for (const c of cands) {
      assert.equal(hashObject(['', 'commit', 'tree', 'blob', 'tag'][c.type], c.data), c.oid);
      if (c.type === TYPE.TREE || c.type === TYPE.BLOB) assert.ok(c.path === '' ? c.type === TYPE.TREE : held.has(`${c.oid} ${c.path}`), `${label}: ${c.oid} at ${c.path}`);
      else assert.equal(c.path, null);
    }
    const plan = planDeltas(cands);
    if (label === 'everything') assert.ok(plan.ofs > 20, `deltas: ${plan.ofs}`);
    const built = await buildPack(plan.objects);
    const idx = unwrap(encodePackIndex(built.pack, cands.map((c, i) => ({ oid: c.oid, offset: built.entries[i].offset }))));
    eqBytes(idx, gitIndex(built.pack), `${label}: encodePackIndex`);
    eqBytes(unwrap(indexPack(built.pack)).idx, idx, `${label}: indexPack`);
  }
});

test('the 64-bit offset table: git show-index reads back every row of layoutPackIndex', () => {
  const offsets = [12, 2 ** 31 - 1, 2 ** 31, 2 ** 32 + 5, 2 ** 40 + 3, 2 ** 53 - 1];
  const rows = offsets.map((offset, i) => ({ oid: hashObject('blob', new TextEncoder().encode(`o${i}`)), offset, crc32: (0x9e37_79b9 * (i + 1)) >>> 0 }));
  const checksum = fromHex('ab'.repeat(20));
  const idx = unwrap(layoutPackIndex(rows, checksum));
  // git show-index: "<offset> <oid> (<crc32>)" per object, in id order
  const shown = execFileSync('git', ['show-index'], { input: idx, encoding: 'utf8' }).trim().split('\n').map(l => { const [off, oid, crc] = l.split(' '); return { oid, offset: Number(off), crc32: Number.parseInt(crc.slice(1, -1), 16) }; });
  assert.deepEqual(shown, rows.toSorted((a, b) => (a.oid < b.oid ? -1 : 1)));
  assert.equal(idx.length, 8 + 1024 + rows.length * 28 + 4 * 8 + 40); // four offsets at or past 2^31 take a 64-bit slot
  eqBytes(idx.subarray(idx.length - 40, idx.length - 20), checksum, 'pack checksum');
});

test('refusals: a malformed index request is bad_request, a thin or duplicated pack is pack_corrupt (git agrees)', async () => {
  const blob = new TextEncoder().encode('x'.repeat(100));
  const oid = hashObject('blob', blob);
  const { pack, entries } = await buildPack([{ type: TYPE.BLOB, data: blob }]);
  const ck = pack.subarray(pack.length - 20);
  const code = r => (r.ok ? 'ok' : `${r.error.code}:${r.error.what}`);
  const cases = {
    'short pack': [encodePackIndex(pack.subarray(0, 31), []), 'bad_request:pack'],
    // the limits record is parsed once, before the pack is read (#156); a key left out is the default
    'bad limits': [indexPack(pack, { maxDeltaChain: -1 }), 'bad_request:maxDeltaChain'],
    'partial limits': [indexPack(pack, { maxPackObjects: 1 }), 'ok'],
    'a cap the pack passes': [indexPack(pack, { maxPackObjects: 0 }), 'limit_exceeded:pack objects'],
    'not a pack': [encodePackIndex(Uint8Array.from([...pack].map((b, i) => (i === 0 ? 0x51 : b))), [{ oid, offset: 12 }]), 'bad_request:pack'],
    'version 3': [encodePackIndex(Uint8Array.from([...pack].map((b, i) => (i === 7 ? 3 : b))), [{ oid, offset: 12 }]), 'bad_request:pack'],
    'count mismatch': [encodePackIndex(pack, []), 'bad_request:objects'],
    'first offset not 12': [encodePackIndex(pack, [{ oid, offset: 13 }]), 'bad_request:offset'],
    'offset in the trailer': [layoutPackIndex([{ oid, offset: 11, crc32: 0 }], ck), 'bad_request:offset'],
    'fractional offset': [layoutPackIndex([{ oid, offset: 12.5, crc32: 0 }], ck), 'bad_request:offset'],
    'unsafe offset': [layoutPackIndex([{ oid, offset: 2 ** 53, crc32: 0 }], ck), 'bad_request:offset'],
    'uppercase oid': [layoutPackIndex([{ oid: oid.toUpperCase(), offset: 12, crc32: 0 }], ck), 'bad_request:oid'],
    'short oid': [layoutPackIndex([{ oid: oid.slice(1), offset: 12, crc32: 0 }], ck), 'bad_request:oid'],
    'crc32 too big': [layoutPackIndex([{ oid, offset: 12, crc32: 2 ** 32 }], ck), 'bad_request:crc32'],
    'crc32 negative': [layoutPackIndex([{ oid, offset: 12, crc32: -1 }], ck), 'bad_request:crc32'],
    'oid twice': [layoutPackIndex([{ oid, offset: 12, crc32: 0 }, { oid, offset: 40, crc32: 0 }], ck), 'bad_request:oid'],
    'checksum 19 bytes': [layoutPackIndex([], ck.subarray(1)), 'bad_request:checksum'],
  };
  for (const [label, [r, want]] of Object.entries(cases)) assert.equal(code(r), want, label);
  // two entries at one offset: the second has no bytes
  const two = await buildPack([{ type: TYPE.BLOB, data: blob }, { type: TYPE.BLOB, data: new TextEncoder().encode('y') }]);
  assert.equal(code(encodePackIndex(two.pack, [{ oid, offset: 12 }, { oid: hashObject('blob', new TextEncoder().encode('y')), offset: 12 }])), 'bad_request:offset');
  assert.equal(code(encodePackIndex(two.pack, [{ oid, offset: 12 }, { oid: hashObject('blob', new TextEncoder().encode('y')), offset: two.pack.length }])), 'bad_request:offset');
  assert.ok(entries[0].offset === 12 && two.entries[1].offset === 12 + two.entries[0].bytes);

  // the same object twice: git index-pack --strict refuses it, and so does indexPack
  const dup = (await buildPack([{ type: TYPE.BLOB, data: blob }, { type: TYPE.BLOB, data: blob }])).pack;
  const d = fresh();
  writeFileSync(join(d, 'dup.pack'), dup);
  assert.throws(() => git(d, ['index-pack', '--strict', '-o', join(d, 'dup.idx'), join(d, 'dup.pack')]), /appears twice|duplicate/i);
  assert.match(code(indexPack(dup)), /^pack_corrupt/);
  // a thin pack (a REF_DELTA whose base is not in it): git index-pack refuses it without --fix-thin, and so does indexPack
  const base = new TextEncoder().encode('base '.repeat(40));
  const target = new TextEncoder().encode(`${'base '.repeat(40)}and more`);
  const thin = (await buildPack([{ type: TYPE.BLOB, data: encodeDelta(base, target), base: { tag: 'ref', oid: hashObject('blob', base) } }])).pack;
  writeFileSync(join(d, 'thin.pack'), thin);
  assert.throws(() => git(d, ['index-pack', '-o', join(d, 'thin.idx'), join(d, 'thin.pack')]), /unresolved deltas|fatal/i);
  assert.match(code(indexPack(thin)), /^pack_corrupt/);
  // a corrupt trailer is the parser's refusal
  assert.match(code(indexPack(Uint8Array.from([...pack].map((b, i) => (i === pack.length - 1 ? b ^ 1 : b))))), /^pack_corrupt/);
  // the walk: a wanted object the store lacks is bad_request naming it; a tip of the wrong kind where a tree is named is pack_corrupt
  const missing = await objectsForPack(mapStore(new Map()), [oid]);
  assert.equal(code(missing), 'bad_request:object');
  assert.match(missing.error.message, /is missing from the object store/);
  const commitText = new TextEncoder().encode(`tree ${oid}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\nm\n`);
  const commitOid = hashObject('commit', commitText);
  const wrong = await objectsForPack(mapStore(new Map([[commitOid, { type: TYPE.COMMIT, data: commitText }], [oid, { type: TYPE.BLOB, data: blob }]])), [commitOid]);
  assert.equal(code(wrong), 'pack_corrupt:object');
});

// A static file server: what an object store's public bucket is to git (GET only; info/refs ignores ?service=, so
// git falls back from smart to dumb HTTP).
function staticServer(dir) {
  const hits = [];
  const srv = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    hits.push(`${req.method} ${path}`);
    const file = join(dir, path);
    if (req.method !== 'GET' || path.includes('..') || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${srv.address().port}`, hits, close: () => new Promise(c => srv.close(c)) })));
}

test('end to end: an export with no disk and no git (walk, plan, build, index) clones from static files with stock git', async () => {
  const w = history();
  const source = fresh();
  git(w, ['push', '-q', '--mirror', source]);
  // what a Worker has after ls-refs and one fetch: the refs (with peeled tags) and resolvePack's objects
  const objects = objectsOf(source);
  const refs = git(source, ['for-each-ref', '--format=%(objectname) %(refname) %(*objectname)']).trim().split('\n').map(l => { const [oid, name, peeled] = l.split(' '); return { oid, name, peeled: peeled || null }; });
  // ---- the export: ply's public API (imported from the modules src/index.ts re-exports) and ~10 lines of layout ----
  const order = unwrap(await objectsForPack(mapStore(objects), refs.map(r => r.oid)));
  const plan = planDeltas(order);
  const { pack, entries } = await buildPack(plan.objects);
  const idx = unwrap(encodePackIndex(pack, order.map((o, i) => ({ oid: o.oid, offset: entries[i].offset }))));
  const name = `pack-${Buffer.from(pack.subarray(pack.length - 20)).toString('hex')}`;
  const files = {
    [`objects/pack/${name}.pack`]: pack,
    [`objects/pack/${name}.idx`]: idx,
    'objects/info/packs': `P ${name}.pack\n\n`,
    'info/refs': refs.map(r => `${r.oid}\t${r.name}\n${r.peeled ? `${r.peeled}\t${r.name}^{}\n` : ''}`).join(''),
    HEAD: 'ref: refs/heads/main\n',
  };
  // ---- publish (here: a directory; in a Worker: R2 puts) and clone ----
  const site = mkdtempSync(join(root, 'site-'));
  for (const [key, body] of Object.entries(files)) { mkdirSync(join(site, 'repo.git', key, '..'), { recursive: true }); writeFileSync(join(site, 'repo.git', key), body); }
  const srv = await staticServer(site);
  try {
    const clone = join(root, `clone-${n++}`);
    // async: the server answers on this process's event loop, which execFileSync would block
    const cloned = await gitAsync(root, ['clone', '-q', '--mirror', `${srv.url}/repo.git`, clone]);
    assert.equal(cloned.status, 0, cloned.stderr);
    assert.deepEqual(fsckProblems(clone), []);
    assert.deepEqual(refsOf(clone), refsOf(source));
    assert.equal(git(clone, ['rev-list', '--objects', '--all']).trim().split('\n').length, objects.size);
    assert.ok(srv.hits.includes('GET /repo.git/info/refs') && srv.hits.some(h => h.endsWith('.idx')), srv.hits.join('\n'));
    assert.ok(!srv.hits.some(h => h.startsWith('POST')), 'dumb HTTP: GETs only');
    // the pack is delta-compressed: smaller than the objects whole, and git's verify-pack reads the same chain shapes
    assert.ok(plan.ofs > 20 && pack.length < plan.rawBytes / 2, `${pack.length} B for ${plan.rawBytes} B raw, ${plan.ofs} deltas`);
    git(root, ['verify-pack', join(site, 'repo.git', `objects/pack/${name}.idx`)]);
  } finally { await srv.close(); }
});
