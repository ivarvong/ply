// Structural edges: depth, width, modes, odd names, odd refs, REF_DELTA packs, large blobs, exact limits.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, commitFiles, fsckProblems } from './server.js';
import { editFile } from '../src/edit.js';
import { GitHttp } from '../src/client.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { withLimits } from '../src/limits.js';
import { TYPE_NAME } from '../src/objects.js';

let root, cleanup, srv, n = 0;
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv.close(); cleanup(); });
const A = { name: 'e', email: 'e@x' };
const repo = () => { const name = `e${n++}`; const bare = makeBareRepo(root, name); const work = join(root, `w${name}`); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']); return { name, bare, work, url: `${srv.url}/${name}.git` }; };
const edit = (r, p, extra = {}, opts = {}) => editFile(r.url, { path: p, find: 'MARK', replace: 'OK', author: A, message: 'e', ...extra }, { tracer: new Tracer(), ...opts });

test('path depth 100 (limit 128): one tree fetch per level, push = commit + 100 tree deltas + blob delta', async () => {
  const r = repo();
  const path = Array.from({ length: 99 }, (_, i) => `d${i}`).join('/') + '/f.txt';
  commitFiles(r.work, r.bare, { [path]: 'MARK' }, 's');
  const ex = arrayExporter();
  const res = await editFile(r.url, { path, find: 'MARK', replace: 'OK', author: A, message: 'e' }, { tracer: new Tracer({ exporter: ex }) });
  assert.equal(gitBuf(r.bare, ['cat-file', 'blob', `main:${path}`]).toString(), 'OK');
  const spans = ex.lines.flatMap(flattenLine);
  assert.equal(spans.filter(s => s.name === 'git.edit.tree').length, 100);
  assert.equal(spans.find(s => s.name === 'git.receive-pack').attrs['git.push.pack.objects'], 102);
  assert.ok(res.pushBytes < 102 * 80 + 400, `push ${res.pushBytes}`);
  await assert.rejects(editFile(r.url, { path: 'x/'.repeat(129) + 'f', find: 'a', replace: 'b', author: A, message: 'e' }, { tracer: new Tracer() }), e => e.code === 'bad_request');
});

test('wide tree: 20k siblings (tree ≈ 700 KB, multi-pkt, multi-block zlib) and maxTreeEntries enforcement', async () => {
  const r = repo();
  const files = { 'wide/target.txt': 'MARK' };
  for (let i = 0; i < 20000; i++) files[`wide/f${String(i).padStart(5, '0')}.txt`] = '';
  commitFiles(r.work, r.bare, files, 's');
  const ex = arrayExporter();
  await editFile(r.url, { path: 'wide/target.txt', find: 'MARK', replace: 'OK', author: A, message: 'e' }, { tracer: new Tracer({ exporter: ex }) });
  assert.equal(gitBuf(r.bare, ['cat-file', 'blob', 'main:wide/target.txt']).toString(), 'OK');
  const t = ex.lines.flatMap(flattenLine).find(s => s.name === 'git.edit.tree' && s.attrs['git.edit.tree.depth'] === 1);
  assert.equal(t.attrs['git.edit.tree.entries'], 20001);
  assert.ok(t.attrs['git.edit.tree.bytes'] > 600000);
  const f = ex.lines.flatMap(flattenLine).filter(s => s.name === 'git.upload-pack fetch')[2];
  assert.ok(f.attrs['git.pack.inflated.bytes'] > 600000, 'tree inflated > 600KB');
  assert.ok(f.attrs['git.pack.inflate.blocks'] > 1, 'multi-block zlib');
  assert.ok(f.attrs['git.pack.compressed.bytes'] < f.attrs['git.pack.inflated.bytes'] / 5, 'near-identical names compress hard; the pack is small on the wire');
  await assert.rejects(edit(r, 'wide/target.txt', { find: 'OK' }, { limits: withLimits({ maxTreeEntries: 1000 }) }), e => e.code === 'limit_exceeded');
  assert.equal(gitBuf(r.bare, ['cat-file', 'blob', 'main:wide/target.txt']).toString(), 'OK');
});

test('modes: symlink and submodule along the path are refused; executable preserved; names with every odd byte', async () => {
  const r = repo();
  commitFiles(r.work, r.bare, { 'x/real.txt': 'MARK', 'x/exec.sh': { mode: '100755', data: 'MARK' } }, 's');
  symlinkSync('real.txt', join(r.work, 'x/link'));
  git(r.work, ['add', '-A']);
  git(r.work, ['update-index', '--add', '--cacheinfo', '160000,' + git(r.bare, ['rev-parse', 'main']).trim() + ',x/sub']); // gitlink with no worktree dir: must come after add -A
  git(r.work, ['-c', 'user.name=s', '-c', 'user.email=s@x', 'commit', '-q', '-m', 'modes']); git(r.work, ['push', '-q', r.bare, 'HEAD:refs/heads/main']);
  await assert.rejects(edit(r, 'x/link'), e => e.code === 'not_found' && /not a regular file/.test(e.message));
  await assert.rejects(edit(r, 'x/sub/anything'), e => e.code === 'not_found');
  await assert.rejects(edit(r, 'x/sub'), e => e.code === 'not_found');
  await assert.rejects(edit(r, 'x/real.txt/deeper'), e => e.code === 'not_found');
  await edit(r, 'x/exec.sh');
  assert.equal(git(r.bare, ['ls-tree', 'main', 'x/exec.sh']).split(' ')[0], '100755');
  assert.equal(git(r.bare, ['ls-tree', 'main', 'x/link']).split(' ')[0], '120000');
  assert.equal(git(r.bare, ['ls-tree', 'main', 'x/sub']).split(' ')[0], '160000');
  // names: bytes 1..255 except '/' and NUL, spaces, leading dash, 255-byte name
  const r2 = repo();
  const odd = [' lead', 'trail ', '-dash', '--', 'tab\tname', 'quote"name', "squote'", 'back\\slash', 'uni-日本語', 'emoji-🚀-x', 'a'.repeat(255), Array.from({ length: 200 }, (_, i) => String.fromCharCode(33 + (i % 90))).join('').replace(/\//g, '_')];
  const files = {}; for (const nm of odd) files[`odd/${nm}`] = 'MARK';
  commitFiles(r2.work, r2.bare, files, 's');
  for (const nm of odd) { await edit(r2, `odd/${nm}`); assert.equal(gitBuf(r2.bare, ['cat-file', 'blob', `main:odd/${nm}`]).toString(), 'OK', nm); }
  assert.deepEqual(fsckProblems(r2.bare, { dangling: true }), []);
});

test('refs: missing ref, non-main branch, unborn HEAD repo, ref pointing at a tag', async () => {
  const r = repo();
  await assert.rejects(edit(r, 'a', { ref: 'refs/heads/main' }), e => e.code === 'not_found' || e.code === 'remote_error');
  commitFiles(r.work, r.bare, { 'a': 'MARK' }, 's');
  git(r.work, ['push', '-q', r.bare, 'HEAD:refs/heads/feature/x-y']);
  await edit(r, 'a', { ref: 'refs/heads/feature/x-y' });
  assert.equal(gitBuf(r.bare, ['cat-file', 'blob', 'refs/heads/feature/x-y:a']).toString(), 'OK');
  assert.equal(gitBuf(r.bare, ['cat-file', 'blob', 'main:a']).toString(), 'MARK', 'main untouched');
  await assert.rejects(edit(r, 'a', { ref: 'refs/heads/nope' }), e => e.code === 'not_found');
  git(r.work, ['tag', '-a', 'v1', '-m', 'v1']); git(r.work, ['push', '-q', r.bare, 'refs/tags/v1']);
  await assert.rejects(edit(r, 'a', { ref: 'refs/tags/v1' }), e => e.code === 'pack_corrupt' || e.code === 'not_found');
  assert.equal(git(r.bare, ['rev-parse', 'refs/tags/v1']).trim(), git(r.work, ['rev-parse', 'v1']).trim(), 'tag untouched');
});

test('REF_DELTA packs (server without ofs-delta) resolve identically; thin-pack fetch with have resolves against external base', async () => {
  const r = repo();
  let text = 'line\n'.repeat(500);
  const c1 = commitFiles(r.work, r.bare, { 'd/a.txt': text, 'd/b.txt': text + 'b', 'd/c.txt': text + 'c' }, 'one');
  const c2 = commitFiles(r.work, r.bare, { 'd/a.txt': text + 'changed\n' }, 'two');
  const c = new GitHttp(r.url, { tracer: new Tracer() });
  const ofs = await c.fetchPack({ wants: [c2], filter: 'blob:none', deepen: 2, ofsDelta: true });
  const ref = await c.fetchPack({ wants: [c2], filter: 'blob:none', deepen: 2, ofsDelta: false });
  assert.equal(ref.parsed.stats.ofsDelta, 0);
  assert.deepEqual([...ref.objects.keys()].sort(), [...ofs.objects.keys()].sort());
  for (const [oid, o] of ref.objects) assert.deepEqual([...o.data], [...ofs.objects.get(oid).data]);
  // thin: have c1, want c2's blob a.txt → server may send it as a delta against c1's a.txt, which we supply externally
  const blobOld = git(r.bare, ['rev-parse', `${c1}:d/a.txt`]).trim(), blobNew = git(r.bare, ['rev-parse', `${c2}:d/a.txt`]).trim();
  const base = gitBuf(r.bare, ['cat-file', 'blob', blobOld]);
  const thin = await c.fetchPack({ wants: [c2], haves: [c1], thinPack: true, deepen: 1 }, { external: oid => (oid === blobOld ? { type: 3, data: new Uint8Array(base) } : undefined) });
  assert.ok(thin.objects.has(blobNew));
  assert.ok(Buffer.from(thin.objects.get(blobNew).data).equals(gitBuf(r.bare, ['cat-file', 'blob', blobNew])));
});

test('large blob (24 MB): max single allocation stays at one inflate chunk; push is a few hundred bytes', async () => {
  const r = repo();
  const big = Buffer.alloc(24 << 20); for (let i = 0; i < big.length; i += 4096) big.write(`line ${i}\n`, i);
  big.write('MARK', 12 << 20);
  commitFiles(r.work, r.bare, { 'big.bin': big }, 's');
  const ex = arrayExporter();
  const t0 = performance.now();
  const res = await editFile(r.url, { path: 'big.bin', find: 'MARK', replace: 'OK', author: A, message: 'e' }, { tracer: new Tracer({ exporter: ex }) });
  const ms = performance.now() - t0;
  const root = ex.lines.flatMap(flattenLine).find(s => s.name === 'git.edit');
  assert.ok(root.attrs['mem.alloc.max_single'] <= 65536, `max single alloc ${root.attrs['mem.alloc.max_single']}`);
  // delta copy ops cover at most 64 KiB each (git delta format): 24 MiB → 384 ops ≈ 3 KB raw, ~1 KB zlib'd. That is the floor for a 24 MB base.
  assert.ok(res.pushBytes < 1500, `push ${res.pushBytes}`);
  assert.ok(res.pushBytes > 500, 'copy-op cost is real and visible');
  const got = gitBuf(r.bare, ['cat-file', 'blob', 'main:big.bin']);
  const off = 12 << 20;
  assert.equal(got.length, big.length - 2);
  assert.equal(got.subarray(off, off + 2).toString(), 'OK');
  assert.ok(got.subarray(0, off).equals(big.subarray(0, off)), 'prefix intact');
  assert.ok(got.subarray(off + 2).equals(big.subarray(off + 4)), 'suffix intact');
  console.log(`  24MB edit in ${ms | 0}ms, push ${res.pushBytes}B, max alloc ${root.attrs['mem.alloc.max_single']}`);
});

test('find at exact chunk boundaries of a 16384-aligned stream and a find longer than one chunk', async () => {
  const r = repo();
  const files = {};
  const cases = [];
  for (const [i, off] of [16383, 16384, 16385, 32768 - 1, 65536, 65536 * 3 - 2].entries()) {
    const buf = Buffer.alloc(300000, 46); buf.write('MARK', off); files[`b${i}`] = buf; cases.push([`b${i}`, off, 'MARK']);
  }
  const longFind = 'L'.repeat(40000); const lb = Buffer.alloc(200000, 46); lb.write(longFind, 70000); files.long = lb; cases.push(['long', 70000, longFind]);
  commitFiles(r.work, r.bare, files, 's');
  for (const [p, off, find] of cases) {
    const res = await editFile(r.url, { path: p, find, replace: 'OK', author: A, message: 'e' }, { tracer: new Tracer() });
    assert.equal(res.matchOffset, off, p);
    const got = gitBuf(r.bare, ['cat-file', 'blob', `main:${p}`]);
    assert.equal(got.subarray(off, off + 2).toString(), 'OK'); assert.equal(got.length, files[p].length - find.length + 2);
  }
});

test('whole-file replace, replace with empty on 1-byte file, and empty find rejected', async () => {
  const r = repo();
  commitFiles(r.work, r.bare, { 'w': 'MARK', 'one': 'M' }, 's');
  await editFile(r.url, { path: 'w', find: 'MARK', replace: 'completely new content\n', author: A, message: 'e' }, { tracer: new Tracer() });
  assert.equal(gitBuf(r.bare, ['cat-file', 'blob', 'main:w']).toString(), 'completely new content\n');
  await editFile(r.url, { path: 'one', find: 'M', replace: '', author: A, message: 'e' }, { tracer: new Tracer() });
  assert.equal(gitBuf(r.bare, ['cat-file', 'blob', 'main:one']).length, 0);
  assert.equal(git(r.bare, ['rev-parse', 'main:one']).trim(), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  await assert.rejects(editFile(r.url, { path: 'one', find: '', replace: 'x', author: A, message: 'e' }, { tracer: new Tracer() }), e => e.code === 'bad_request');
  await assert.rejects(editFile(r.url, { path: 'one', find: 'x', replace: 'y', author: A, message: 'e' }, { tracer: new Tracer() }), e => e.code === 'match_count');
});

test('empty blob: find on a 0-byte file is match_count (0 matches), never a push; edit the empty→nonempty neighbour works', async () => {
  const r = repo();
  commitFiles(r.work, r.bare, { 'empty.txt': '', 'one.txt': 'M' }, 's');
  const head = git(r.bare, ['rev-parse', 'main']).trim();
  await assert.rejects(editFile(r.url, { path: 'empty.txt', find: 'x', replace: 'y', author: A, message: 'e' }, { tracer: new Tracer() }), e => e.code === 'match_count' && e.matches === 0);
  assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), head, 'ref untouched');
  // the blob fetch for an empty object is a 1-object pack whose zlib stream inflates to nothing: the scanner must still finish cleanly
  await assert.rejects(editFile(r.url, { path: 'empty.txt', find: 'longer than the file', replace: '', author: A, message: 'e' }, { tracer: new Tracer() }), e => e.code === 'match_count');
  await editFile(r.url, { path: 'one.txt', find: 'M', replace: '', author: A, message: 'e' }, { tracer: new Tracer() });
  assert.equal(gitBuf(r.bare, ['cat-file', 'blob', 'main:one.txt']).length, 0);
  await assert.rejects(editFile(r.url, { path: 'one.txt', find: 'M', replace: 'back', author: A, message: 'e' }, { tracer: new Tracer() }), e => e.code === 'match_count');
});

test('a one-byte find over 128 KiB of that byte (#13): match_count with the full count in linear time, never a push', { timeout: 60_000 }, async () => {
  const r = repo();
  commitFiles(r.work, r.bare, { 'run.txt': 'a'.repeat(128 << 10) }, 's');
  const head = git(r.bare, ['rev-parse', 'main']).trim();
  // O(n) calibration in this process: the same edit over 16 KiB of hits, so the ratio cancels a slow machine, and CPU
  // time, not wall clock, so parallel load on the box does not count. Linear is at most 8x (measured 4.6-5.5x, also beside
  // 3 fuzzers); the old scan, which kept every offset in a fresh array per hit, measured 71-78x (~20 s). Spans keep 16.
  const small = repo();
  commitFiles(small.work, small.bare, { 'run.txt': 'a'.repeat(16 << 10) }, 's');
  const cpuMs = async f => { const t = process.cpuUsage(); const v = await f(); const d = process.cpuUsage(t); return { v, ms: (d.user + d.system) / 1000 }; };
  const run = (u, ex = arrayExporter()) => cpuMs(() => editFile(u, { path: 'run.txt', find: 'a', replace: 'b', author: A, message: 'e' }, { tracer: new Tracer({ exporter: ex }) }).then(() => null, e => e));
  await run(small.url); // warm-up, discarded
  const base = [(await run(small.url)).ms, (await run(small.url)).ms, (await run(small.url)).ms].sort((a, b) => a - b)[1];
  const ex = arrayExporter();
  const { v: err, ms } = await run(r.url, ex);
  assert.ok(ms < 24 * base, `128 KiB of hits cost ${ms.toFixed(0)} ms CPU, ${(ms / base).toFixed(1)}x 16 KiB (${base.toFixed(0)} ms); linear is <= 8x`);
  assert.equal(err?.code, 'match_count', err?.message);
  assert.equal(err.matches, 128 << 10);
  assert.equal(err.message, `expected exactly one match, found ${128 << 10}`);
  const blob = ex.lines.flatMap(flattenLine).find(s => s.name === 'git.edit.blob');
  assert.equal(blob.attrs['git.edit.blob.scan.matches'], 128 << 10);
  assert.deepEqual(blob.attrs['git.edit.blob.scan.match_offsets'], Array.from({ length: 16 }, (_, i) => i));
  assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), head, 'ref untouched');
});

test('strictHead: a moved ref is cas_conflict before any push and is not retried; a current head lands', async () => {
  const r = repo();
  const h0 = commitFiles(r.work, r.bare, { 'f.txt': 'MARK\n' }, 's');
  const h1 = commitFiles(r.work, r.bare, { 'g.txt': 'other\n' }, 'moved');
  let pushes = 0; const counting = (u, i) => { if (String(u).endsWith('git-receive-pack')) pushes++; return fetch(u, i); };
  await assert.rejects(edit(r, 'f.txt', {}, { head: h0, strictHead: true, fetchImpl: counting }), e => e.code === 'cas_conflict' && e.actual === h1 && e.expected === h0);
  assert.equal(pushes, 0); assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), h1);
  const ok = await edit(r, 'f.txt', {}, { head: h1, strictHead: true, fetchImpl: counting });
  assert.equal(ok.hint, 'used'); assert.equal(ok.oldCommit, h1); assert.equal(pushes, 1);
  await assert.rejects(edit(r, 'f.txt', {}, { strictHead: true }), e => e.code === 'bad_request');
});
