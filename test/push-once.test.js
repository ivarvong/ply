// push() sends each object once, whatever list a producer hands it. A pack that holds one object twice is refused
// by a strict receiver. Measured with git 2.50.0 on the 379-byte pack commitChanges built for "the same new file
// under two twins" before trees were deduplicated (the same new tree for a/ and b/, packed twice):
//   git index-pack --strict --stdin : fatal: The same object deaee133500b7fbecb042fd6c74b5f5cb61b0a9b appears twice in the pack
//   git unpack-objects --strict     : fatal: object deaee133500b7fbecb042fd6c74b5f5cb61b0a9b tried to add buffer twice!
// (both accept it without --strict), which receive-pack reports as "unpacker error".
// Judge: git. The objects are git's own (a commit made by git, read back with cat-file); the server decides whether
// the pack is acceptable, and the ref must then be the commit git made.
import { test, vi, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, fsckProblems, commitFiles } from './server.js';
import { GitHttp } from '../src/client.js';
import { Tracer } from '../src/otel.js';
import { TYPE } from '../src/objects.js';
import { makeDelta } from '../src/pack.js';
import * as pushEntry from '../src/push.js';
import { Sha1 } from '../src/sha1.js';

let root, cleanup, srv, n = 0;
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv.close(); cleanup(); });

const CONFIGS = [
  ['strict-unpack', []],                                // receive.fsckObjects=true, unpack-objects --strict
  ['index-pack', [['receive.unpackLimit', '1']]],       // receive.fsckObjects=true, index-pack --strict
];

// A repository with one seed commit on the server and a second commit (by git) only in the work tree.
function fixture(cfg) {
  const name = `once${n++}`;
  const bare = makeBareRepo(root, name);
  for (const [k, v] of cfg) git(bare, ['config', k, v]);
  const work = join(root, `w${name}`); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  const head = commitFiles(work, bare, { 'a/f.txt': 'one\n', 'b/f.txt': 'one\n' }, 'seed');
  writeFileSync(join(work, 'a/f.txt'), 'two\n'); writeFileSync(join(work, 'b/f.txt'), 'two\n'); writeFileSync(join(work, 'c.txt'), 'c\n');
  git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'next']);
  const next = git(work, ['rev-parse', 'HEAD']).trim();
  const raw = (type, rev) => ({ type: TYPE[type.toUpperCase()], data: new Uint8Array(gitBuf(work, ['cat-file', type, rev])) });
  // a/ and b/ are one new tree, their f.txt one new blob: what a producer walking both paths collects twice
  const objects = [raw('commit', 'HEAD'), raw('tree', 'HEAD^{tree}'), raw('tree', 'HEAD:a'), raw('blob', 'HEAD:a/f.txt'), raw('blob', 'HEAD:c.txt')];
  return { name, bare, head, next, objects, work, raw };
}

for (const [config, cfg] of CONFIGS) {
  test(`push: a list that names objects twice is one object each on the wire [${config}]`, async () => {
    const f = fixture(cfg);
    const [commit, rootTree, sub, blob, other] = f.objects;
    // every object twice, the repeats as separate copies of the bytes (not the same array) and out of order
    const copy = o => ({ type: o.type, data: o.data.slice() });
    const objects = [commit, rootTree, sub, copy(sub), blob, other, copy(blob), copy(rootTree), copy(commit), copy(other)];
    const c = GitHttp.create(`${srv.url}/${f.name}.git`, { tracer: new Tracer() });
    assert.equal(c.ok, true);
    const r = await c.value.push({ ref: 'refs/heads/main', oldOid: f.head, newOid: f.next, objects });
    assert.equal(r.ok ? 'ok' : `${r.error.code}: ${r.error.message}`, 'ok');
    assert.equal(r.value.entries.length, 5); // five distinct objects, by the fixture
    assert.equal(git(f.bare, ['rev-parse', 'refs/heads/main']).trim(), f.next);
    assert.deepEqual(fsckProblems(f.bare), []);
  });

  test(`push: an ofs delta whose base is a repeated object still names its base [${config}]`, async () => {
    const f = fixture(cfg);
    const [commit, rootTree, sub, blob, other] = f.objects;
    // c.txt as a delta against the a/f.txt blob, which sits after a dropped repeat: its ofs index (4) must follow
    const delta = { type: TYPE.BLOB, data: makeDelta(blob.data, other.data).delta, base: { tag: 'ofs', index: 4 } };
    const objects = [commit, rootTree, sub, { type: sub.type, data: sub.data.slice() }, blob, delta];
    const c = GitHttp.create(`${srv.url}/${f.name}.git`, { tracer: new Tracer() });
    assert.equal(c.ok, true);
    const r = await c.value.push({ ref: 'refs/heads/main', oldOid: f.head, newOid: f.next, objects });
    assert.equal(r.ok ? 'ok' : `${r.error.code}: ${r.error.message}`, 'ok');
    assert.equal(git(f.bare, ['rev-parse', 'refs/heads/main']).trim(), f.next);
    assert.equal(git(f.bare, ['cat-file', 'blob', 'refs/heads/main:c.txt']), 'c\n');
    assert.deepEqual(fsckProblems(f.bare), []);
  });
}

// package.json maps './push' to this module, so each of its exports is public API ('ply/push'). The guard is push()'s
// own: main (ec337c5) exports no such name, and the owner's decision is that none is added.
// push() returns a Result and never rejects. A JavaScript caller's list with an entry that is not an object is refused
// on main (ec337c5) as Result err 'protocol' before any request, for each of these lists (measured: attack5.mjs of the
// second review, run against main). The guard reads every entry, so it runs where main first read one.
test('push: an objects list with a null or undefined entry is a protocol error, never a rejection', async () => {
  const blob = byte => ({ type: TYPE.BLOB, data: Uint8Array.of(byte) });
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('the network must not be reached'); };
  for (const objects of [[null, blob(1)], [blob(1), blob(2), null], [undefined, blob(1)]]) {
    const c = GitHttp.create('http://127.0.0.1:9/x.git', { tracer: new Tracer(), fetchImpl });
    assert.equal(c.ok, true);
    // a rejection fails here: the await throws
    const r = await c.value.push({ ref: 'refs/heads/x', oldOid: '0'.repeat(40), newOid: 'a'.repeat(40), objects });
    assert.equal(r.ok ? 'ok' : r.error.code, 'protocol');
    // planning refuses nothing main did not: it returns a Result for the same list, and does not throw
    assert.equal(pushEntry.planPush({ ref: 'refs/heads/x', oldOid: '0'.repeat(40), newOid: 'a'.repeat(40), objects }, null).ok, true);
  }
  assert.equal(calls, 0);
});

// A list with no repeated object costs no object hash. A pack holds no object id (gitformat-pack: entries, then one
// SHA-1 trailer over the pack), so main hashes no object to push; an object id is SHA-1 over "<type> <size>\0" and the
// bytes (git hash-object), which makes each object hash visible as a SHA-1 update of exactly that header. Counted,
// not timed: 24 blobs of one length (8 bytes, all distinct) beside git's commit and tree.
test('push: a list with no repeated object hashes no object, though every blob has the same length', async () => {
  const name = `once${n++}`;
  const bare = makeBareRepo(root, name);
  const work = join(root, `w${name}`); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  const head = commitFiles(work, bare, { 'seed.txt': 'seed\n' }, 'seed');
  const files = Array.from({ length: 24 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
  for (const f of files) writeFileSync(join(work, f), `${f.slice(0, 3)}:one\n`);
  git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'next']);
  const next = git(work, ['rev-parse', 'HEAD']).trim();
  const raw = (type, rev) => ({ type: TYPE[type.toUpperCase()], data: new Uint8Array(gitBuf(work, ['cat-file', type, rev])) });
  const objects = [raw('commit', 'HEAD'), raw('tree', 'HEAD^{tree}'), ...files.map(f => raw('blob', `HEAD:${f}`))];
  assert.deepEqual([...new Set(objects.slice(2).map(o => o.data.length))], [8]);
  const c = GitHttp.create(`${srv.url}/${name}.git`, { tracer: new Tracer() });
  assert.equal(c.ok, true);
  const spy = vi.spyOn(Sha1.prototype, 'update');
  let hashed;
  try {
    const r = await c.value.push({ ref: 'refs/heads/main', oldOid: head, newOid: next, objects });
    hashed = spy.mock.calls.map(([b]) => Buffer.from(b.subarray(0, 32)).toString('latin1')).filter(s => /^(?:blob|tree|commit|tag) \d+\0$/u.test(s));
    assert.equal(r.ok ? 'ok' : `${r.error.code}: ${r.error.message}`, 'ok');
    assert.equal(r.value.entries.length, 26); // git's commit, its tree and the 24 blobs: nothing dropped
  } finally { spy.mockRestore(); }
  assert.deepEqual(hashed, []);
  assert.equal(git(bare, ['rev-parse', 'refs/heads/main']).trim(), next);
  assert.deepEqual(fsckProblems(bare), []);
});

test("the duplicate-object guard is not an export of 'ply/push'", () => {
  assert.deepEqual(Object.keys(pushEntry).filter(k => /once|dedup|duplicate/iu.test(k)), []);
});
