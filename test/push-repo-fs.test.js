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

// The boundary cells of the bound, on a real pack (git gc). The oracle is statSync and git: a pack of exactly
// maxPackBytes is read and the push lands (git rev-parse on the remote equals the local tip); with one byte less of
// limit the refusal carries got = the file's size and max = size - 1.
test('the maxPackBytes boundary: a pack of exactly the bound is read and pushes; one byte less of bound refuses with got = size, max = size - 1', async () => {
  const dir = localRepo();
  const url = remoteRepo();
  const [real] = readdirSync(packDir(dir)).filter(f => f.endsWith('.pack'));
  const size = statSync(join(packDir(dir), real)).size;

  const under = await pushRepo(dir, url, { refspecs: ['main'] }, { limits: withLimits({ maxPackBytes: size - 1 }) });
  assert.equal(under.ok, false);
  assert.equal(under.error.code, 'limit_exceeded');
  assert.equal(under.error.what, 'local pack bytes');
  assert.equal(under.error.got, size);
  assert.equal(under.error.max, size - 1);

  const exact = await pushRepo(dir, url, { refspecs: ['main'] }, { limits: withLimits({ maxPackBytes: size }) });
  assert.equal(exact.ok, true, exact.ok ? '' : `${exact.error.code}: ${exact.error.message}`);
  const remoteDir = join(root, `${url.slice(srv.url.length + 1)}`);
  assert.equal(git(remoteDir, ['rev-parse', 'refs/heads/main']).trim(), git(dir, ['rev-parse', 'main']).trim());
});

// node's fs binding takes a read's length as an int32 and aborts the process on more (node_file.cc, fs.Read:
// `args[3]->IsInt32()`, SIGABRT), so a caller who raises maxPackBytes past 2 GiB for a pack of 2^31 bytes or more must
// still get an answer. The expected values are hand-derived: the file is 2 GiB + 1 zeros (truncate), which is not a
// pack ('PACK' is 50 41 43 4b), so the answer is pack_corrupt; every byte was read (the sum equals the truncate
// size), and no single read was asked for more than 1 GiB (2^30).
test('a local pack of 2 GiB or more under a raised maxPackBytes is read in pieces of at most 1 GiB: an answer, never a process abort', async () => {
  const GIB = 1024 * MIB;
  const dir = localRepo();
  const url = remoteRepo();
  const big = join(packDir(dir), 'pack-big.pack');
  writeFileSync(big, '');
  truncateSync(big, 2 * GIB + 1);
  reads.log.length = 0;
  const r = await pushRepo(dir, url, { refspecs: ['main'], dryRun: true }, { limits: withLimits({ maxPackBytes: 4 * GIB }) });
  truncateSync(big, 0);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'pack_corrupt');
  assert.equal(totalRead(big), 2 * GIB + 1, 'the whole file was read');
  assert.ok(largestRead(big) <= GIB, `largest single read: ${largestRead(big)} bytes, the cap is ${GIB}`);
  assert.ok(reads.log.filter(x => x.path === big).length >= 3, 'more than two reads were needed for 2 GiB + 1 at 1 GiB each');
});
