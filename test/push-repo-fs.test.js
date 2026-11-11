// pushRepo (ply/repo-node) against the local file system's own edges: what it reads from `.git` is bounded by the
// limits, and a file system failure is a coded Err. node:fs/promises is wrapped so every read's size is counted: the
// proof of a bound is the largest single read of a file, never the process's RSS.
import { test, vi, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readdirSync, statSync, truncateSync, chmodSync } from 'node:fs';
import { git, tmpRoot, makeBareRepo, startGitServer } from './server.js';
import { pushRepo } from '../src/repo-node.js';
import { withLimits } from '../src/limits.js';

// every read through node:fs/promises, as { path, bytes }: readFile (whole) and FileHandle.read / readFile
const reads = vi.hoisted(() => ({ log: [] }));
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal();
  const note = (path, bytes) => { reads.log.push({ path: String(path), bytes }); };
  return {
    ...real,
    readFile: async (path, ...rest) => { const b = await real.readFile(path, ...rest); note(path, b.length); return b; },
    open: async (path, ...rest) => {
      const fh = await real.open(path, ...rest);
      const read = fh.read.bind(fh);
      const readAll = fh.readFile.bind(fh);
      fh.read = async (...a) => { const r = await read(...a); note(path, r.bytesRead); return r; };
      fh.readFile = async (...a) => { const b = await readAll(...a); note(path, b.length); return b; };
      return fh;
    },
  };
});

const MIB = 1024 * 1024;
let root, cleanup, srv, n = 0;
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv.close(); cleanup(); });

const ID = ['-c', 'user.name=Local', '-c', 'user.email=local@example.com'];
const remoteRepo = () => { const name = `fs${n++}`; makeBareRepo(root, name); return `${srv.url}/${name}.git`; };
// a work tree with one commit on main, its objects in one pack (git gc)
const localRepo = () => {
  const dir = join(root, `local${n++}`);
  mkdirSync(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, ['add', '-A']);
  git(dir, [...ID, 'commit', '-q', '-m', 'one']);
  git(dir, ['gc', '-q']);
  return dir;
};
const packDir = dir => join(dir, '.git', 'objects', 'pack');
const largestRead = path => Math.max(0, ...reads.log.filter(r => r.path === path).map(r => r.bytes));
const totalRead = path => reads.log.filter(r => r.path === path).reduce((sum, r) => sum + r.bytes, 0);

test('a local pack is read under maxPackBytes: one past the bound is limit_exceeded and no read of it is larger than the bound', async () => {
  const dir = localRepo();
  const url = remoteRepo();
  const [real] = readdirSync(packDir(dir)).filter(f => f.endsWith('.pack'));
  const realPath = join(packDir(dir), real);

  // the counter sees the pack's reads: a push that succeeds read exactly the file's bytes (statSync), in reads no
  // larger than the file
  reads.log.length = 0;
  const fine = await pushRepo(dir, url, { refspecs: ['main'], dryRun: true });
  assert.equal(fine.ok, true);
  assert.equal(totalRead(realPath), statSync(realPath).size, 'the wrapped fs counted the pack read');

  // 64 MiB of zeros (sparse) beside it, every limit a pack could be held to at 1 MiB
  const big = join(packDir(dir), 'pack-big.pack');
  writeFileSync(big, '');
  truncateSync(big, 64 * MIB);
  reads.log.length = 0;
  const limits = withLimits({ maxPackBytes: MIB, maxInflatedTotal: MIB, maxObjectSize: MIB });
  const r = await pushRepo(dir, url, { refspecs: ['main'], dryRun: true }, { limits });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'limit_exceeded');
  assert.equal(r.error.what, 'local pack bytes');
  assert.equal(r.error.got, 64 * MIB);
  assert.equal(r.error.max, MIB);
  assert.ok(largestRead(big) <= MIB, `largest single read of the 64 MiB pack: ${largestRead(big)} bytes, the bound is ${MIB}`);

  // 3 GiB (sparse), past what one Buffer read takes (node: ERR_FS_FILE_TOO_LARGE above 2 GiB), under the defaults:
  // a coded refusal, not a rejection
  truncateSync(big, 3 * 1024 * MIB);
  reads.log.length = 0;
  const huge = await pushRepo(dir, url, { refspecs: ['main'], dryRun: true });
  assert.equal(huge.ok, false);
  assert.equal(huge.error.code, 'limit_exceeded');
  assert.equal(huge.error.what, 'local pack bytes');
  assert.equal(largestRead(big), 0, 'nothing of a pack past the bound is read');
});

test.skipIf(process.getuid?.() === 0)('a pack the process cannot read is a coded Err naming the file and the operation, never a rejection', async () => {
  const dir = localRepo();
  const url = remoteRepo();
  const [real] = readdirSync(packDir(dir)).filter(f => f.endsWith('.pack'));
  const path = join(packDir(dir), real);
  chmodSync(path, 0o000);
  try {
    const r = await pushRepo(dir, url, { refspecs: ['main'], dryRun: true });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'unsupported');
    assert.equal(r.error.kind, 'filesystem');
    assert.equal(r.error.what, 'local pack');
    assert.equal(r.error.path, path);
    assert.equal(r.error.cause.code, 'EACCES');
    assert.match(r.error.message, /EACCES/u);
    assert.match(r.error.message, /open|read/u);
  } finally { chmodSync(path, 0o644); }
});
