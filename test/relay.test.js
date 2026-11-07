// #217: a fetched, resolved pack relayed straight into push (a mirror). fetchPack({ resolve: true }) objects are whole
// objects; where each sat in the source pack is `packBase`, never `base`, which push reads as its own delta input. Before
// the rename an OFS_DELTA's `{ tag: 'ofs', offset }` was refused ("an ofs base must name an earlier object") and a
// REF_DELTA's `{ tag: 'ref', oid }` would have sent a whole object as a delta. git is the oracle: fsck and the refs.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { git, tmpRoot, makeBareRepo, startGitServer, commitFiles, fsckProblems } from './server.js';
import { GitHttp, ZERO_OID } from '../src/client.js';
import { unwrap, unwrapAsync } from './unwrap.js';
import { resolvePack, makeDelta } from '../src/packresolve.js';
import { TYPE } from '../src/objects.js';

let root, cleanup, srv;
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv.close(); cleanup(); });

test('fetchPack({ resolve: true }) objects push as they are: ofs and ref deltas in the source pack, git fsck clean', async () => {
  const src = makeBareRepo(root, 'relay-src');
  const dst = makeBareRepo(root, 'relay-dst');
  const work = join(root, 'relay-w');
  mkdirSync(work);
  git(work, ['init', '-q', '-b', 'main']);
  // many versions of one large-ish file: pack-objects deltas them (OFS_DELTA in a fresh pack)
  const line = i => `line ${i} ${'x'.repeat(40)}\n`;
  let body = Array.from({ length: 200 }, (_, i) => line(i)).join('');
  for (let v = 0; v < 6; v++) { body += line(1000 + v); commitFiles(work, src, { 'big.txt': body, [`f${v}.txt`]: `${v}\n` }, `v${v}`); }
  git(src, ['repack', '-adf', '-q']);
  const head = git(src, ['rev-parse', 'main']).trim();
  const from = unwrap(GitHttp.create(`${srv.url}/relay-src.git`));
  const to = unwrap(GitHttp.create(`${srv.url}/relay-dst.git`));
  const fetched = await unwrapAsync(from.fetchPack({ wants: [head], ofsDelta: true, thinPack: false, done: true }, { resolve: true }));
  const objects = [...fetched.objects.values()];
  assert.ok(objects.some(o => o.packBase.tag === 'ofs'), 'the source pack carried an OFS_DELTA');
  assert.ok(objects.every(o => !('base' in o)), 'no resolved object has a `base` push would read');
  await unwrapAsync(to.push({ commands: [{ ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: head }], objects }));
  assert.equal(git(dst, ['rev-parse', 'main']).trim(), head);
  assert.deepEqual(fsckProblems(dst), []);
  // A REF_DELTA source (a thin pack's object against one the receiver holds): resolved, it is whole and pushes as such.
  const baseOid = git(src, ['rev-parse', 'main:big.txt']).trim();
  const baseData = Buffer.from(git(src, ['cat-file', 'blob', baseOid]), 'latin1');
  const target = Buffer.concat([baseData, Buffer.from('one more line\n')]);
  const resolved = unwrap(resolvePack({ objects: [{ offset: 12, type: TYPE.REF_DELTA, data: makeDelta(baseData, target).delta, base: { tag: 'ref', oid: baseOid } }] }, oid => (oid === baseOid ? { type: TYPE.BLOB, data: baseData } : null)));
  const thin = [...resolved.objects.values()];
  assert.deepEqual(thin.map(o => [o.type, o.packBase]), [[TYPE.BLOB, { tag: 'ref', oid: baseOid }]]);
  assert.deepEqual(Buffer.from(thin[0].data), target);
  await unwrapAsync(to.push({ commands: [{ ref: 'refs/tags/grown', oldOid: ZERO_OID, newOid: thin[0].oid }], objects: thin }));
  assert.deepEqual(Buffer.from(git(dst, ['cat-file', 'blob', 'refs/tags/grown']), 'latin1'), target);
  assert.deepEqual(fsckProblems(dst), []);
});
