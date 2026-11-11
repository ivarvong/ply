// push() sends each object once, whatever list a producer hands it. A pack that holds one object twice is refused
// by a strict receiver. Measured with git 2.50.0 on the 379-byte pack commitChanges built for "the same new file
// under two twins" before trees were deduplicated (the same new tree for a/ and b/, packed twice):
//   git index-pack --strict --stdin : fatal: The same object deaee133500b7fbecb042fd6c74b5f5cb61b0a9b appears twice in the pack
//   git unpack-objects --strict     : fatal: object deaee133500b7fbecb042fd6c74b5f5cb61b0a9b tried to add buffer twice!
// (both accept it without --strict), which receive-pack reports as "unpacker error".
// Judge: git. The objects are git's own (a commit made by git, read back with cat-file); the server decides whether
// the pack is acceptable, and the ref must then be the commit git made.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, fsckProblems, commitFiles } from './server.js';
import { GitHttp } from '../src/client.js';
import { Tracer } from '../src/otel.js';
import { TYPE } from '../src/objects.js';
import { makeDelta } from '../src/pack.js';
import * as pushEntry from '../src/push.js';

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
test("the duplicate-object guard is not an export of 'ply/push'", () => {
  assert.deepEqual(Object.keys(pushEntry).filter(k => /once|dedup|duplicate/iu.test(k)), []);
});
