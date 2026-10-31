// checkoutTree / checkoutDir: a ref out of a remote into a directory, judged by `git clone` of the same ref. Every
// fixture lives in a bare repo behind `git http-backend`; the clone and ply's checkout must be `diff -r` identical, and
// a walk of both compares every entry's type, permission bits, bytes and symlink target. Round trips are counted at
// the fetch boundary and compared with the per-file baseline (readCommit → listTree per directory → readFile per blob,
// the first examples/checkout-tree.mjs, before checkoutDir). Also: a blob:none-only host (Artifacts), a host that refuses many wants, lying servers
// (wrong blob, unwanted object, wrong commit, duplicate tree entry), `path`, the limits, and the writer's path rules.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, symlinkSync, readdirSync, lstatSync, readlinkSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, commitFiles } from './server.js';
import { startProxy } from './proxy.js';
import { checkoutTree, treeFiles, canonMode } from '../src/checkout.js';
import { checkoutDir, writeFiles } from '../src/checkout-node.js';
import { readCommit, listTree, readFile } from '../src/read.js';
import { withLimits } from '../src/limits.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';

let root, cleanup, srv, R, n = 0;
const traced = () => { const ex = arrayExporter(); return { tracer: new Tracer({ exporter: ex }), spans: () => ex.lines.flatMap(flattenLine) }; };
// counts HTTP requests by service; `rewrite(body)` may replace an upload-pack request body (the lying servers)
const counting = (rewrite = null) => {
  const c = { requests: 0, bodies: [] };
  const f = async (url, init) => {
    c.requests++;
    let body = init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('latin1') : null;
    if (body !== null) c.bodies.push(body);
    if (body !== null && rewrite) { const b = rewrite(body); if (b !== body) { body = b; return fetch(url, { ...init, body: Buffer.from(b, 'latin1') }); } }
    return fetch(url, init);
  };
  return { c, f };
};
const fresh = () => join(root, `o${n++}`);
const wants = body => (body.match(/^[0-9a-f]{4}want [0-9a-f]{40}$/gm) ?? []).length;

// the fixture: nested dirs, exec bits, symlinks (file, directory, dangling, upward), a gitlink, unicode and spaces,
// an empty file, one blob at two paths, a 3 MiB file, sort-order neighbours (a.b, a/, a0, a-b)
before(async () => {
  ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root);
  const bare = makeBareRepo(root, 'r'); const work = join(root, 'wr'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  const big = Buffer.alloc(3 << 20); for (let i = 0; i < big.length; i += 7) big[i] = (i * 2654435761) >>> 24;
  const files = {
    'README.md': '# fixture\n', 'empty.txt': '', 'big.bin': big,
    'src/lib/deep/x/y/z.js': 'export const z = 1;\n', 'src/lib/util.js': 'export {};\n', 'src/main.js': 'import "./lib/util.js";\n',
    'bin/run.sh': { mode: '100755', data: '#!/bin/sh\necho hi\n' }, 'bin/tool': { mode: '100755', data: '#!/bin/sh\nexit 0\n' },
    'dir with space/ünï cödé.txt': 'unicode\n', '日本/ファイル.txt': 'nihongo\n', 'emoji/🙂.txt': 'smile\n',
    'copy/one.txt': 'same bytes\n', 'copy/two.txt': 'same bytes\n',
    'a.b': '1\n', 'a/x': '2\n', 'a0': '3\n', 'a-b/c': '4\n',
  };
  commitFiles(work, bare, files, 'one');
  symlinkSync('README.md', join(work, 'link-file')); symlinkSync('src/lib', join(work, 'link-dir'));
  symlinkSync('does/not/exist', join(work, 'link-dangling')); symlinkSync('../../README.md', join(work, 'src/lib/up'));
  commitFiles(work, bare, {}, 'links');
  git(work, ['update-index', '--add', '--cacheinfo', `160000,${git(work, ['rev-parse', 'HEAD~1']).trim()},vendor/sub`]);
  git(work, ['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-q', '-m', 'gitlink']); git(work, ['push', '-q', bare, 'HEAD:refs/heads/main']);
  R = { bare, work, url: `${srv.url}/r.git`, files: Object.keys(files).length + 4 + 1 };
});
after(async () => { await srv.close(); cleanup(); });

const clone = (ref = null) => { const dir = fresh(); git(root, ['clone', '-q', ...(ref ? ['-b', ref] : []), R.bare, dir]); return dir; };
// diff -r without following links, then a walk: type, permission bits, bytes, link targets, empty directories
function sameTree(want, got) {
  try { execFileSync('diff', ['-r', '--no-dereference', '-x', '.git', want, got], { stdio: 'pipe' }); } catch (e) { assert.fail(`diff -r: ${e.stdout}${e.stderr}`); }
  const walk = (base, rel = '', out = new Map()) => {
    for (const name of readdirSync(join(base, rel)).sort()) {
      if (name === '.git' && rel === '') continue;
      const p = rel ? `${rel}/${name}` : name, st = lstatSync(join(base, p));
      if (st.isSymbolicLink()) out.set(p, `link ${readlinkSync(join(base, p))}`);
      else if (st.isDirectory()) { out.set(p, `dir ${(st.mode & 0o777).toString(8)}`); walk(base, p, out); }
      else out.set(p, `file ${(st.mode & 0o777).toString(8)} ${readFileSync(join(base, p)).toString('base64')}`);
    }
    return out;
  };
  const a = walk(want), b = walk(got);
  assert.deepEqual([...b.keys()], [...a.keys()], 'same paths');
  for (const [p, v] of a) assert.equal(b.get(p), v, p);
  return a.size;
}

test('checkoutDir == git clone: diff -r and modes; 3 round trips against the per-file baseline', async () => {
  const t = traced(), { c, f } = counting(), dir = fresh();
  const r = await checkoutDir(R.url, { dir }, { tracer: t.tracer, fetchImpl: f });
  const entries = sameTree(clone(), dir);
  assert.equal(r.commit, git(R.bare, ['rev-parse', 'main']).trim()); assert.equal(r.tree, git(R.bare, ['rev-parse', 'main^{tree}']).trim());
  assert.equal(r.ref, 'refs/heads/main');
  assert.equal(r.entries.length, R.files);
  assert.deepEqual(r.written, { files: R.files - 5, bytes: r.written.bytes, symlinks: 4, gitlinks: 1 });
  assert.ok(lstatSync(join(dir, 'vendor/sub')).isDirectory() && readdirSync(join(dir, 'vendor/sub')).length === 0, 'a gitlink is an empty directory');
  assert.equal(lstatSync(join(dir, 'bin/run.sh')).mode & 0o100, 0o100);
  // ls-refs, the blob:none tree pack, one wants-list for every blob
  assert.equal(c.requests, 3, `${c.requests} requests`);
  const fetches = t.spans().filter(s => s.name === 'git.upload-pack fetch');
  assert.deepEqual(fetches.map(s => s.attrs['git.fetch.filter']), ['blob:none', '']);
  const unique = new Set(r.entries.filter(e => e.mode !== '160000').map(e => e.oid)).size;
  assert.equal(fetches[1].attrs['git.fetch.wants.count'], unique, 'every unique blob in one request');
  const blobs = t.spans().find(s => s.name === 'git.checkout.blobs').attrs;
  assert.equal(blobs['git.checkout.blobs.outcome'], 'ok'); assert.equal(blobs['git.checkout.blobs.fetches'], 1);
  assert.equal(blobs['git.checkout.blobs.buffered'], R.files - 1); assert.equal(blobs['git.checkout.blobs.streamed'], 0);
  assert.equal(t.spans().find(s => s.name === 'git.checkout').attrs['git.checkout.outcome'], 'ok');
  // round trips as the example counts them: spans that sent a request body
  const trips = t.spans().filter(s => s.attrs['git.request.bytes'] != null).length;
  assert.equal(trips, 3);

  // the baseline (what the first examples/checkout-tree.mjs did): readCommit once, listTree per directory, readFile per blob, by commit oid
  const base = counting(), opts = { tracer: new Tracer(), fetchImpl: base.f, cache: new Map(), quirks: {} };
  const { oid } = await readCommit(R.url, { ref: 'main' }, opts);
  let read = 0;
  const walk = async path => {
    for (const e of (await listTree(R.url, { ref: oid, path }, opts)).entries) {
      const p = path ? `${path}/${e.name}` : e.name;
      if (e.type === 'tree') await walk(p); else if (e.type === 'blob') { await new Response((await readFile(R.url, { ref: oid, path: p }, opts)).stream).arrayBuffer(); read++; }
    }
  };
  await walk('');
  assert.equal(read, R.files - 1);
  assert.ok(base.c.requests >= 2 * read, `baseline ${base.c.requests} requests for ${read} blobs`);
  console.log(`  checkout of ${R.files} entries (${entries} paths on disk, ${unique} unique blobs): checkoutTree ${c.requests} requests; per-file baseline ${base.c.requests} requests`);
});

test('the iterator: entries and files agree, sizes before bytes, a gitlink has no stream; path = a subtree', async () => {
  const r = await checkoutTree(R.url, { ref: 'main' }, { tracer: new Tracer() });
  const ls = new Map(git(R.bare, ['-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', '-l', 'main']).split('\0').filter(Boolean).map(l => { const [meta, path] = l.split('\t'); const [mode, , oid, size] = meta.trim().split(/\s+/); return [path, { mode, oid, size: size === '-' ? 0 : Number(size) }]; }));
  assert.deepEqual(r.entries.map(e => [e.path, e.mode, e.oid]), [...ls].map(([p, e]) => [p, e.mode, e.oid]), 'entries == git ls-tree -r, in its order');
  const seen = new Set();
  for await (const f of r.files) {
    const want = ls.get(f.path);
    assert.equal(f.mode, want.mode, f.path); assert.equal(f.oid, want.oid); assert.equal(f.size, want.size, f.path);
    if (f.mode === '160000') { assert.equal(f.stream, null); seen.add(f.path); continue; }
    const bytes = Buffer.from(await new Response(f.stream).arrayBuffer());
    assert.ok(bytes.equals(gitBuf(R.bare, ['cat-file', 'blob', f.oid])), f.path);
    seen.add(f.path);
  }
  assert.equal(seen.size, ls.size, 'every entry once');

  // path: a subtree, entries relative to it; the same bytes as the clone's subdirectory
  const dir = fresh();
  const sub = await checkoutDir(R.url, { dir, path: 'src/lib' }, { tracer: new Tracer() });
  assert.equal(sub.tree, git(R.bare, ['rev-parse', 'main:src/lib']).trim()); assert.equal(sub.path, 'src/lib');
  assert.deepEqual(sub.entries.map(e => e.path), ['deep/x/y/z.js', 'up', 'util.js']);
  sameTree(join(clone(), 'src/lib'), dir);
  for (const [path, re] of [['nope', /not found/], ['README.md', /not a directory/], ['src/nope/x', /not found/]]) await assert.rejects(checkoutTree(R.url, { path }, { tracer: new Tracer() }), e => e.code === 'not_found' && re.test(e.message), path);
  await assert.rejects(checkoutTree(R.url, { path: '../x' }, { tracer: new Tracer() }), e => e.code === 'bad_request');
  // an older commit by oid (no ls-refs), and a ref that is not there
  const old = git(R.bare, ['rev-parse', 'main~2']).trim(), counted = counting();
  const o = await checkoutTree(R.url, { ref: old }, { tracer: new Tracer(), fetchImpl: counted.f });
  assert.equal(o.entries.length, R.files - 5, 'no links, no gitlink yet'); assert.equal(counted.c.requests, 1, 'an oid needs no ls-refs');
  await assert.rejects(checkoutTree(R.url, { ref: 'nope' }, { tracer: new Tracer() }), e => e.code === 'not_found');
  await assert.rejects(checkoutTree(R.url, { ref: git(R.bare, ['rev-parse', 'main:README.md']).trim() }, { tracer: new Tracer() }), e => e.code === 'not_found');
});

test('Artifacts-like host (blob:none only): the same checkout in the same 3 round trips, no refused request', async () => {
  const filterOf = body => /filter ([^\n]+)\n/.exec(Buffer.from(body).toString('latin1'))?.[1] ?? null;
  const proxy = await startProxy(srv.url, ctx => (ctx.stage === 'fetch' && filterOf(ctx.reqBody) && filterOf(ctx.reqBody) !== 'blob:none' ? { type: 'status', status: 400, contentType: 'text/plain; charset=utf-8', body: 'Unsupported Git fetch filter; only blob:none is supported.' } : { type: 'pass' }));
  try {
    const { c, f } = counting(), dir = fresh();
    await checkoutDir(`${proxy.url}/r.git`, { dir }, { tracer: new Tracer(), fetchImpl: f });
    sameTree(clone(), dir);
    assert.equal(c.requests, 3);
    assert.equal(proxy.log.filter(l => l.spec === 'status').length, 0, 'nothing refused: blob:none is the only filter asked for');
  } finally { await proxy.close(); }
});

test('a host that refuses many wants: one refusal, then a blob per request, remembered on quirks', async () => {
  const proxy = await startProxy(srv.url, ctx => (ctx.stage === 'fetch' && wants(ctx.reqBody.toString('latin1')) > 1 ? { type: 'status', status: 400, contentType: 'text/plain', body: 'one want per request' } : { type: 'pass' }));
  try {
    const { c, f } = counting(), dir = fresh(), quirks = {}, t = traced();
    const r = await checkoutDir(`${proxy.url}/r.git`, { dir }, { tracer: t.tracer, fetchImpl: f, quirks });
    sameTree(clone(), dir);
    assert.equal(quirks.blobWants, 'single');
    const blobPaths = r.entries.filter(e => e.mode !== '160000').length;
    assert.equal(c.requests, 2 + 1 + blobPaths, 'ls-refs, trees, the refused batch, then one per path');
    const s = t.spans().find(x => x.name === 'git.checkout.blobs').attrs;
    assert.equal(s['git.checkout.blobs.refused'], 'http'); assert.equal(s['git.checkout.blobs.streamed'], blobPaths);
    // with the quirk known, no batch is tried
    const again = counting();
    await checkoutTree(`${proxy.url}/r.git`, { ref: r.commit }, { tracer: new Tracer(), fetchImpl: again.f, quirks }).then(async x => { for await (const g of x.files) await g.stream?.cancel(); });
    assert.equal(again.c.bodies.filter(b => wants(b) > 1).length, 0);
  } finally { await proxy.close(); }
});

test('lying servers fail closed with pack_corrupt: wrong blob in a batch, wrong blob alone (file removed), wrong commit, duplicate entry', async () => {
  const readme = git(R.bare, ['rev-parse', 'main:README.md']).trim(), other = git(R.bare, ['rev-parse', 'main:a.b']).trim();
  // 1. a batch: the server answers README.md's want with a blob nobody asked for → pack_corrupt before any file is yielded
  const decoy = gitBuf(R.bare, ['hash-object', '-w', '--stdin'], Buffer.from('not in any tree\n')).toString().trim();
  const liar1 = counting(body => (!body.includes('filter ') && body.includes(`want ${readme}\n`) ? body.replace(`want ${readme}\n`, `want ${decoy}\n`) : body));
  const r1 = await checkoutTree(R.url, {}, { tracer: new Tracer(), fetchImpl: liar1.f });
  const yielded = [];
  const err1 = await (async () => { for await (const f of r1.files) if (f.stream) yielded.push(f.path); })().catch(e => e);
  assert.equal(err1.code, 'pack_corrupt'); assert.match(err1.message, /served but not wanted/);
  assert.deepEqual(yielded, [], 'no blob was yielded from the lying batch');

  // 2. a blob fetched on its own (batch: 1): the stream errors, checkoutDir removes the file and rethrows
  const liar2 = counting(body => (!body.includes('filter ') && body.includes(`want ${readme}\n`) ? body.replace(`want ${readme}\n`, `want ${other}\n`) : body));
  const dir = fresh();
  const err2 = await checkoutDir(R.url, { dir }, { tracer: new Tracer(), fetchImpl: liar2.f, batch: 1 }).catch(e => e);
  assert.equal(err2.code, 'pack_corrupt'); assert.match(err2.message, /hashes to/);
  assert.ok(!existsSync(join(dir, 'README.md')), 'the unverified file is removed');

  // 3. the tree fetch answered for another commit: the wanted commit is not in the pack
  const head = git(R.bare, ['rev-parse', 'main']).trim(), older = git(R.bare, ['rev-parse', 'main~1']).trim();
  const liar3 = counting(body => body.replace(`want ${head}\n`, `want ${older}\n`));
  await assert.rejects(checkoutTree(R.url, { ref: head }, { tracer: new Tracer(), fetchImpl: liar3.f }), e => e.code === 'pack_corrupt' && /not in the blob:none pack/.test(e.message));
});

test('a tree naming one entry twice (a symlink `a` beside a directory `a`) is refused before anything is written', async () => {
  const bare = makeBareRepo(root, 'dup');
  const hash = (type, bytes) => gitBuf(bare, ['hash-object', '--literally', '-w', '-t', type, '--stdin'], bytes).toString().trim();
  const entry = (mode, name, oid) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')]);
  const blob = hash('blob', Buffer.from('pwned\n')), link = hash('blob', Buffer.from('/tmp'));
  const inner = hash('tree', entry('100644', 'x', blob));
  const tree = hash('tree', Buffer.concat([entry('120000', 'a', link), entry('40000', 'a', inner)]));
  const commit = git(bare, ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit-tree', tree, '-m', 'dup']).trim();
  git(bare, ['update-ref', 'refs/heads/main', commit]);
  const dir = fresh();
  await assert.rejects(checkoutDir(`${srv.url}/dup.git`, { dir }, { tracer: new Tracer() }), e => e.code === 'pack_corrupt' && /duplicate entry "a"/.test(e.message));
  assert.deepEqual(readdirSync(dir), []);
});

test('limits: entries walked, depth, the tree pack, blob batches split under maxPackBytes, a single blob over it refused', async () => {
  // the tree pack is 15 objects (commit + 14 trees); walking it visits 36 entries (22 files + 13 trees + 1 gitlink)
  await assert.rejects(checkoutTree(R.url, {}, { tracer: new Tracer(), limits: withLimits({ maxPackObjects: 20 }), batch: 5 }), e => e.code === 'limit_exceeded' && e.what === 'checkout entries' && e.got === 21);
  await assert.rejects(checkoutTree(R.url, {}, { tracer: new Tracer(), limits: withLimits({ maxPathDepth: 4 }) }), e => e.code === 'limit_exceeded' && e.what === 'path depth');
  await assert.rejects(checkoutTree(R.url, {}, { tracer: new Tracer(), limits: withLimits({ maxPackBytes: 512 }) }), e => e.code === 'limit_exceeded' && e.what === 'pack bytes');
  for (const batch of [0, 1.5, 'x', 200_001]) await assert.rejects(checkoutTree(R.url, {}, { tracer: new Tracer(), batch }), e => e.code === 'bad_request' && e.what === 'batch');
  // a cap the tree pack fits under but the whole blob batch does not, by one byte: split in half, both halves refetched
  // under the cap and buffered (every fetch, streamed or buffered, stays under maxPackBytes)
  const t0 = traced();
  await checkoutDir(R.url, { dir: fresh() }, { tracer: t0.tracer });
  const whole = t0.spans().find(s => s.name === 'git.upload-pack fetch' && s.attrs['git.fetch.filter'] === '').attrs['git.pack.bytes'];
  const max = whole - 1, t = traced(), dir = fresh();
  await checkoutDir(R.url, { dir }, { tracer: t.tracer, limits: withLimits({ maxPackBytes: max }) });
  sameTree(clone(), dir);
  const blobs = t.spans().find(s => s.name === 'git.checkout.blobs').attrs;
  assert.equal(blobs['git.checkout.blobs.splits'], 1, 'the batch was split once'); assert.equal(blobs['git.checkout.blobs.fetches'], 2); assert.equal(blobs['git.checkout.blobs.streamed'], 0);
  for (const s of t.spans().filter(x => x.name === 'git.upload-pack fetch' && x.attrs['git.pack.bytes'] != null)) assert.ok(s.attrs['git.pack.bytes'] <= max, `a buffered pack of ${s.attrs['git.pack.bytes']} B`);
  // a cap under big.bin's own pack (3 MiB, 58 KiB deflated): the batch splits down to big.bin alone, whose stream is then
  // over the cap too — limit_exceeded, never a stream read past maxPackBytes (before the endless-body fix it streamed)
  const t2 = traced(), dir2 = fresh();
  const err = await checkoutDir(R.url, { dir: dir2 }, { tracer: t2.tracer, limits: withLimits({ maxPackBytes: 16 * 1024 }) }).catch(e => e);
  assert.equal(err.code, 'limit_exceeded', err.message); assert.equal(err.what, 'pack bytes'); assert.equal(err.max, 16 * 1024);
  const b2 = t2.spans().find(s => s.name === 'git.checkout.blobs').attrs;
  // "fetched alone" is read from openBlob's own span, not `streamed`: that counter moves only once openBlob returns, and
  // whether the cap trips while it reads the object header (one network chunk past 16 KiB) or later in the pump depends
  // on chunk sizes (CI: the former). Either way failHere ends a git.read.blob span as limit_exceeded.
  assert.ok(b2['git.checkout.blobs.splits'] >= 1, 'the batch was split');
  assert.ok(t2.spans().some(s => s.name === 'git.read.blob' && s.attrs['git.read.blob.outcome'] === 'limit_exceeded'), 'big.bin was fetched alone');
  assert.ok(!existsSync(join(dir2, 'big.bin')), 'the refused blob left no file');
  // a single blob under the cap still streams: batch 1 with the cap just above big.bin's pack
  const t3 = traced(), dir3 = fresh();
  await checkoutDir(R.url, { dir: dir3 }, { tracer: t3.tracer, limits: withLimits({ maxPackBytes: 64 * 1024 }), batch: 1 });
  sameTree(clone(), dir3);
  const read = t3.spans().find(s => s.name === 'git.read.blob' && s.attrs['git.read.blob.size'] === 3 << 20);
  assert.equal(read.attrs['git.read.blob.verified'], true);
});

test('the pure steps: canonMode is git\'s canon_mode; treeFiles bounds a tree reused at many paths', () => {
  assert.equal(canonMode('100644'), '100644'); assert.equal(canonMode('100664'), '100644'); assert.equal(canonMode('100755'), '100755'); assert.equal(canonMode('100775'), '100755');
  assert.equal(canonMode('120000'), '120000'); assert.equal(canonMode('160000'), '160000'); assert.equal(canonMode('40000'), '40000');
  for (const m of ['140000', '100', '1006440', '60000']) assert.equal(canonMode(m), null, m);
  const oid = i => String(i).padStart(40, '0');
  // tree k names tree k+1 twice: 2^20 paths from 21 objects
  const trees = new Map(Array.from({ length: 21 }, (_, k) => [oid(k), k === 20 ? [{ name: 'f', mode: '100644', oid: oid(99) }] : [{ name: 'l', mode: '40000', oid: oid(k + 1) }, { name: 'r', mode: '40000', oid: oid(k + 1) }]]));
  assert.throws(() => treeFiles(o => trees.get(o), oid(0), { limits: withLimits({ maxPackObjects: 1000 }) }), e => e.code === 'limit_exceeded' && e.what === 'checkout entries' && e.got === 1001);
  assert.throws(() => treeFiles(() => [{ name: 'x', mode: '140000', oid: oid(1) }], oid(0)), e => e.code === 'pack_corrupt' && /cannot check out/.test(e.message));
  assert.deepEqual(treeFiles(o => trees.get(o) ?? [], oid(19)).map(e => e.path), ['l/f', 'r/f']);
});

test('writeFiles refuses traversal, .git, absolute paths, a non-empty dir, and writing through a symlink it made', async () => {
  const s = text => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } });
  const one = (...files) => (async function* () { yield* files; })();
  const outside = fresh(); mkdirSync(outside);
  for (const path of ['../escape', '/abs', 'a/../../escape', '.git/config', '.GIT/config', 'a//b', 'git~1/x']) {
    const dir = fresh();
    await assert.rejects(writeFiles(dir, one({ path, mode: '100644', stream: s('x') })), e => e.code === 'bad_request', path);
    assert.deepEqual(readdirSync(dir), [], path);
  }
  // a symlink `a` → outside, then a file under `a/`: refused, nothing lands outside
  const dir = fresh();
  await assert.rejects(writeFiles(dir, one({ path: 'a', mode: '120000', stream: s(outside) }, { path: 'a/pwned', mode: '100644', stream: s('x') })), e => e.code === 'bad_request' && e.what === 'checkout path' && e.path === 'a');
  assert.deepEqual(readdirSync(outside), []);
  // the same name twice: the second does not overwrite, and a symlink is not replaced
  const dir2 = fresh();
  await assert.rejects(writeFiles(dir2, one({ path: 'f', mode: '100644', stream: s('one') }, { path: 'f', mode: '100644', stream: s('two') })), e => e.code === 'bad_request' && e.path === 'f');
  assert.equal(readFileSync(join(dir2, 'f'), 'utf8'), 'one');
  const dir3 = fresh();
  await assert.rejects(writeFiles(dir3, one({ path: 'l', mode: '120000', stream: s(join(outside, 'target')) }, { path: 'l', mode: '100644', stream: s('x') })), e => e.code === 'bad_request' && e.path === 'l');
  assert.ok(!existsSync(join(outside, 'target')), 'not written through the link');
  // a non-empty target dir is refused before any request
  const full = fresh(); mkdirSync(full); writeFileSync(join(full, 'keep'), 'x');
  const { c, f } = counting();
  await assert.rejects(checkoutDir(R.url, { dir: full }, { tracer: new Tracer(), fetchImpl: f }), e => e.code === 'bad_request' && e.what === 'dir');
  assert.equal(c.requests, 0);
});
