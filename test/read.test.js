// readFile / listTree against git as the oracle: `git show <ref>:<path>` for bytes, `git ls-tree <ref>:<path>` for
// listings, over git http-backend. Covers nested paths, every entry kind (regular, executable, symlink, gitlink, tree),
// empty and multi-MiB blobs, every ref form (HEAD, full, short, annotated/lightweight tag, oid), the not_found shapes,
// a lying server (wrong blob served → the stream errors), and credential hygiene (spans, echoed error bodies).
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { git, gitBuf, gitAsync, tmpRoot, makeBareRepo, startGitServer, commitFiles } from './server.js';
import { readFile, listTree, readCommit, refCandidates, walkPath, fetchCommit, openBlob, readBlob, resolveCommit, resolveAbbrev } from '../src/read.js';
import { lsRefs } from '../src/lsrefs.js';
import { createTransport } from '../src/http.js';
import { fetchObject } from '../src/fetch.js';
import { parseIdent, TYPE } from '../src/objects.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';

let root, cleanup, srv, R;
const tracer = () => new Tracer();
const drain = async stream => { const parts = []; for await (const c of stream) parts.push(Buffer.from(c)); return Buffer.concat(parts); };
const lsTree = (bare, spec) => git(bare, ['ls-tree', '-z', spec]).split('\0').filter(Boolean).map(l => { const [meta, name] = l.split('\t'); const [mode, type, oid] = meta.split(' '); return { name, mode, oid, type }; });

before(async () => {
  ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root);
  const bare = makeBareRepo(root, 'r'); const work = join(root, 'wr'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  const big = Buffer.alloc(3 << 20); for (let i = 0; i < big.length; i += 7) big[i] = (i * 2654435761) >>> 24;
  commitFiles(work, bare, { 'README.md': '# v1\n', 'a/b/c.txt': 'nested\n', 'empty.txt': '', 'run.sh': { mode: '100755', data: '#!/bin/sh\necho hi\n' }, 'big.bin': big, 'dir with space/ünï.txt': 'unicode\n' }, 'one');
  git(work, ['tag', '-a', '-m', 'annotated', 'v1']); git(work, ['tag', 'light']); git(work, ['push', '-q', bare, 'refs/tags/v1', 'refs/tags/light']);
  symlinkSync('a/b/c.txt', join(work, 'link'));
  commitFiles(work, bare, { 'README.md': '# v2\n' }, 'two');
  git(work, ['push', '-q', bare, 'HEAD:refs/heads/feature']);
  commitFiles(work, bare, { 'README.md': '# v3 main\n' }, 'three');
  // a branch and a tag with the same short name: git rev-parse picks the tag
  git(work, ['tag', 'dup', 'HEAD~2']); git(work, ['push', '-q', bare, 'refs/tags/dup', 'HEAD~1:refs/heads/dup']);
  // last, because commitFiles' `add -A` would drop it: a gitlink (submodule entry) with no .gitmodules, as git allows
  git(work, ['update-index', '--add', '--cacheinfo', `160000,${git(work, ['rev-parse', 'HEAD~2']).trim()},vendor/sub`]);
  git(work, ['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-q', '-m', 'four']); git(work, ['push', '-q', bare, 'HEAD:refs/heads/main']);
  R = { bare, work, url: `${srv.url}/r.git` };
});
after(async () => { await srv.close(); cleanup(); });

test('refCandidates is git rev-parse order (tags before heads); oids skip ls-refs; bad refs refused', () => {
  assert.deepEqual(refCandidates(null), ['HEAD']);
  assert.deepEqual(refCandidates('main'), ['refs/main', 'refs/tags/main', 'refs/heads/main']);
  assert.deepEqual(refCandidates('refs/heads/x'), ['refs/heads/x']);
  assert.deepEqual(refCandidates('a'.repeat(40)), []);
  for (const bad of ['ma..in', 'x y', 'refs/heads/a\nb', 'a:b']) assert.throws(() => refCandidates(bad), e => e.code === 'bad_request', bad);
});

test('readFile bytes == git show <ref>:<path> for every blob path and every ref form', async () => {
  const oid = git(R.bare, ['rev-parse', 'main~1']).trim();
  const refs = [null, 'HEAD', 'main', 'refs/heads/main', 'feature', 'v1', 'refs/tags/v1', 'light', 'dup', oid];
  const paths = ['README.md', 'a/b/c.txt', 'empty.txt', 'run.sh', 'big.bin', 'dir with space/ünï.txt', 'link'];
  let n = 0;
  for (const ref of refs) for (const path of paths) {
    const spec = `${ref ?? 'HEAD'}:${path}`;
    let want; try { want = gitBuf(R.bare, ['show', spec]); } catch { continue; } // link does not exist at v1
    const r = await readFile(R.url, { ref, path }, { tracer: tracer() });
    const got = await drain(r.stream);
    assert.equal(r.size, want.length, spec);
    assert.ok(got.equals(want), `${spec}: bytes differ`);
    assert.equal(r.blob, git(R.bare, ['rev-parse', spec]).trim(), spec);
    assert.equal(r.commit, git(R.bare, ['rev-parse', `${ref ?? 'HEAD'}^{commit}`]).trim(), spec);
    n++;
  }
  assert.ok(n >= 60, `cases ${n}`);
  const dup = await readFile(R.url, { ref: 'dup', path: 'README.md' }, { tracer: tracer() });
  assert.equal(dup.ref, 'refs/tags/dup'); assert.equal((await drain(dup.stream)).toString(), '# v1\n');
  const head = await readFile(R.url, { path: 'README.md' }, { tracer: tracer() });
  assert.equal(head.ref, 'refs/heads/main'); assert.equal((await drain(head.stream)).toString(), '# v3 main\n');
  console.log(`  ${n} (ref, path) cases equal to git show`);
});

test('modes: symlink reads as its target (120000), executable 100755; gitlink and tree are not files', async () => {
  const link = await readFile(R.url, { path: 'link' }, { tracer: tracer() });
  assert.equal(link.mode, '120000'); assert.equal((await drain(link.stream)).toString(), 'a/b/c.txt');
  const sh = await readFile(R.url, { path: 'run.sh' }, { tracer: tracer() }); await drain(sh.stream);
  assert.equal(sh.mode, '100755');
  await assert.rejects(readFile(R.url, { path: 'vendor/sub' }, { tracer: tracer() }), e => e.code === 'not_found' && /submodule/.test(e.message));
  await assert.rejects(readFile(R.url, { path: 'a/b' }, { tracer: tracer() }), e => e.code === 'not_found' && /directory/.test(e.message));
});

test('typed misses match git: ref, unborn HEAD, path, directory, submodule', async () => {
  const ref = 'no-such-branch';
  assert.throws(() => git(R.bare, ['rev-parse', '--verify', '--quiet', ref]));
  await assert.rejects(readFile(R.url, { ref, path: 'README.md' }, { tracer: tracer() }), e => {
    assert.equal(e.code, 'not_found');
    assert.equal(e.miss.kind, 'ref');
    assert.equal(e.miss.ref, ref);
    assert.deepEqual([...e.miss.candidates], refCandidates(ref));
    return true;
  });

  const empty = makeBareRepo(root, 'empty');
  // git 2.43's ls-remote receives `unborn HEAD symref-target:refs/heads/main` and prints no line (no oid to list).
  // symbolic-ref is the target that line names; an empty listing is the unborn repository.
  assert.equal(git(empty, ['ls-remote', '--symref', '.']).trim(), '');
  const target = git(empty, ['symbolic-ref', 'HEAD']).trim();
  assert.equal(target, 'refs/heads/main');
  for (const asked of [null, 'HEAD', 'main', 'refs/heads/main']) {
    const got = await readCommit(`${srv.url}/empty.git`, { ref: asked }, { tracer: tracer() });
    assert.deepEqual(got, { empty: true, ref: target }, String(asked));
  }
  await assert.rejects(readFile(`${srv.url}/empty.git`, { path: 'README.md' }, { tracer: tracer() }), e => e.code === 'not_found' && e.miss.kind === 'head_unborn' && e.miss.target === target);
  await assert.rejects(readFile(`${srv.url}/empty.git`, { ref: 'nope', path: 'README.md' }, { tracer: tracer() }), e => e.code === 'not_found' && e.miss.kind === 'ref' && e.miss.ref === 'nope');

  const tree = git(R.bare, ['rev-parse', 'HEAD^{tree}']).trim();
  const t = createTransport(R.url, { tracer: tracer() });
  const missing = await walkPath(t, tree, ['a', 'nope']);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.deepEqual(missing.error.miss, { kind: 'path', missing: 'nope', existingPath: 'a' });
  assert.throws(() => git(R.bare, ['cat-file', '-e', 'HEAD:a/nope']));
  const throughFile = await walkPath(t, tree, ['README.md', 'x']);
  assert.equal(throughFile.ok, false);
  if (!throughFile.ok) {
    const mode = git(R.bare, ['ls-tree', 'HEAD', 'README.md']).slice(0, 6);
    assert.deepEqual(throughFile.error.miss, { kind: 'not_directory', path: 'README.md', mode });
  }
  const dir = await readFile(R.url, { path: 'a/b' }, { tracer: tracer() }).then(() => { throw new Error('a directory was a file'); }, e => e);
  assert.equal(dir.code, 'not_found');
  assert.deepEqual(dir.miss, { kind: 'is_directory', path: 'a/b', tree: git(R.bare, ['rev-parse', 'HEAD:a/b']).trim() });
  const subLine = git(R.bare, ['ls-tree', 'HEAD', 'vendor/sub']).trim();
  const subOid = subLine.split(/\s+/)[2];
  assert.equal(subLine.slice(0, 6), '160000');
  const sub = await readFile(R.url, { path: 'vendor/sub' }, { tracer: tracer() }).then(() => { throw new Error('a submodule was a file'); }, e => e);
  assert.equal(sub.code, 'not_found');
  assert.deepEqual(sub.miss, { kind: 'submodule', path: 'vendor/sub', commit: subOid });
});

// A commit whose object is a tree, blob, or tag is not_found (refuseNonCommit). The pack_corrupt line that remains is a
// want whose expected type is not a commit: walking a path from a blob asks for a tree and the object is a blob.
test('a path walk that starts at a blob is pack_corrupt (expected tree, got blob)', async () => {
  const blob = git(R.bare, ['rev-parse', 'HEAD:README.md']).trim();
  const walked = await walkPath(createTransport(R.url, { tracer: tracer() }), blob, ['x']);
  assert.equal(walked.ok, false);
  if (!walked.ok) {
    assert.equal(walked.error.code, 'pack_corrupt');
    assert.match(walked.error.message, /expected tree, got blob/);
  }
});

test('ply does not classify a not_found by matching its own message', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  // The classifiers ply-web used, and the ones this tree used to rethrow not_found. The messages themselves stay;
  // nothing in src tests a message to decide a code.
  const banned = ['thrownMessageMatches(', '/not our ref/', '/expected commit', '/is a directory', '/is not a directory', '/path component', '/remote HEAD', '/^ref ', 'expected commit|not our ref'];
  for (const f of readdirSync('src').filter(name => /\.[jt]s$/.test(name))) {
    const text = readFileSync(`src/${f}`, 'utf8');
    for (const needle of banned) assert.equal(text.includes(needle), false, `${f} contains ${needle}`);
  }
});

test('fetchCommit matches git fetch and cat-file; a tree want of a blob stays pack_corrupt', async () => {
  const tip = git(R.bare, ['rev-parse', 'main']).trim();
  const tree = git(R.bare, ['rev-parse', `${tip}^{tree}`]).trim();
  const blob = git(R.bare, ['rev-parse', `${tip}:README.md`]).trim();
  const tag = git(R.bare, ['rev-parse', 'v1']).trim();
  const dangling = git(R.bare, ['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit-tree', tree, '-m', 'dangling']).trim();
  const absent = 'ab'.repeat(20);
  // gitAsync, not git(): execFileSync would block the event loop and deadlock the http-backend in this process.
  const classify = async (oid) => {
    const dir = join(root, `oracle-${oid.slice(0, 12)}`);
    mkdirSync(dir);
    git(dir, ['init', '-q']);
    git(dir, ['remote', 'add', 'origin', R.url]);
    const fetched = await gitAsync(dir, ['fetch', '--depth=1', 'origin', oid]);
    const text = `${fetched.stdout}\n${fetched.stderr}`;
    let typ = null;
    try { typ = git(R.bare, ['cat-file', '-t', oid]).trim(); } catch { typ = null; }
    if (fetched.status !== 0 && /not our ref|couldn't find remote ref/.test(text)) return { class: 'absent', typ };
    if (fetched.status === 0 && typ !== 'commit') return { class: 'not_commit', typ };
    if (fetched.status === 0 && typ === 'commit') return { class: 'ok', typ };
    throw new Error(`unclassified ${oid} status ${fetched.status} type ${typ}: ${text}`);
  };
  const cases = [
    ['tip', tip, 'ok'],
    ['dangling', dangling, 'ok'],
    ['tree', tree, 'not_commit'],
    ['blob', blob, 'not_commit'],
    ['tag', tag, 'not_commit'],
    ['absent', absent, 'absent'],
  ];
  for (const [name, oid, want] of cases) {
    const gitClass = await classify(oid);
    assert.equal(gitClass.class, want, `${name}: git classified ${gitClass.class} (${gitClass.typ})`);
    const got = await fetchCommit(createTransport(R.url, { tracer: tracer() }), oid);
    if (want === 'ok') {
      assert.equal(got.ok, true, name);
      if (!got.ok) continue;
      assert.ok(Buffer.from(got.value.data).equals(gitBuf(R.bare, ['cat-file', 'commit', oid])), name);
      assert.equal(got.value.oid, oid, name);
      assert.equal(got.value.commit.tree, git(R.bare, ['rev-parse', `${oid}^{tree}`]).trim(), name);
    } else {
      assert.equal(got.ok, false, name);
      if (got.ok) continue;
      assert.equal(got.error.code, 'not_found', `${name}: ${got.error.code} ${got.error.message}`);
      assert.equal(got.error.miss.kind, 'commit', name);
      assert.equal(got.error.miss.miss.kind, want, name);
      assert.equal(got.error.miss.miss.oid, oid, name);
      if (want === 'not_commit') assert.equal(got.error.miss.miss.type, gitClass.typ, name);
    }
  }
  await assert.rejects(fetchObject(createTransport(R.url, { tracer: tracer() }), { oid: blob, expectType: TYPE.TREE }), e => e.code === 'pack_corrupt' && e.message === 'expected tree, got blob' && e.miss === undefined);
});

test('not_found shapes: missing path, path through a file, missing ref, unknown oid; bad path is bad_request before I/O', async () => {
  for (const path of ['nope', 'a/nope', 'a/b/c.txt/x', 'README.md/x', 'empty.txt/x/y']) await assert.rejects(readFile(R.url, { path }, { tracer: tracer() }), e => e.code === 'not_found', path);
  for (const path of ['nope', 'README.md', 'a/b/c.txt', 'vendor/sub']) await assert.rejects(listTree(R.url, { path }, { tracer: tracer() }), e => e.code === 'not_found', path);
  await assert.rejects(readFile(R.url, { ref: 'no-such-branch', path: 'README.md' }, { tracer: tracer() }), e => e.code === 'not_found');
  await assert.rejects(readFile(R.url, { ref: 'f'.repeat(40), path: 'README.md' }, { tracer: tracer() }), e => e.code === 'not_found', 'unknown oid');
  const blobOid = git(R.bare, ['rev-parse', 'main:README.md']).trim();
  await assert.rejects(readFile(R.url, { ref: blobOid, path: 'README.md' }, { tracer: tracer() }), e => e.code === 'not_found', 'oid of a blob is not a commit');
  let calls = 0; const counting = (u, i) => { calls++; return fetch(u, i); };
  for (const path of ['', '../x', 'a//b', '.git/config', 'a/.git']) await assert.rejects(readFile(R.url, { path }, { tracer: tracer(), fetchImpl: counting }), e => e.code === 'bad_request', JSON.stringify(path));
  assert.equal(calls, 0);
});

test('listTree == git ls-tree <ref>:<path> (root, nested, gitlink, symlink, exec, at a tag)', async () => {
  for (const [ref, path] of [[null, ''], ['main', 'a'], ['main', 'a/b'], ['main', 'a/b/'], ['main', 'vendor'], ['main', 'dir with space'], ['v1', ''], ['feature', '']]) {
    const r = await listTree(R.url, { ref, path }, { tracer: tracer() });
    const spec = `${ref ?? 'HEAD'}:${path.replace(/\/$/, '')}`;
    assert.deepEqual(r.entries, lsTree(R.bare, spec), spec);
    assert.equal(r.tree, git(R.bare, ['rev-parse', spec]).trim());
  }
  const top = await listTree(R.url, {}, { tracer: tracer() });
  assert.deepEqual(Object.fromEntries(top.entries.map(e => [e.name, `${e.mode} ${e.type}`])), { 'README.md': '100644 blob', a: '040000 tree', 'big.bin': '100644 blob', 'dir with space': '040000 tree', 'empty.txt': '100644 blob', link: '120000 blob', 'run.sh': '100755 blob', vendor: '040000 tree' });
  const vendor = await listTree(R.url, { path: 'vendor' }, { tracer: tracer() });
  assert.deepEqual(vendor.entries.map(e => [e.mode, e.type]), [['160000', 'commit']]);
});

test('streamed: a 3 MiB blob arrives in many chunks; tree cache is reused across reads', async () => {
  const cache = new Map(); const ex = arrayExporter();
  const r = await readFile(R.url, { path: 'big.bin' }, { tracer: new Tracer({ exporter: ex }), cache });
  let chunks = 0, max = 0, len = 0; for await (const c of r.stream) { chunks++; max = Math.max(max, c.length); len += c.length; }
  assert.equal(len, 3 << 20); assert.ok(chunks > 10, `chunks ${chunks}`); assert.ok(max <= 1 << 16, `max chunk ${max}`);
  const blob = ex.lines.flatMap(flattenLine).find(s => s.name === 'git.read.blob');
  assert.equal(blob.attrs['git.read.blob.verified'], true); assert.equal(blob.attrs['git.read.blob.bytes'], 3 << 20);
  const ex2 = arrayExporter();
  const r2 = await readFile(R.url, { path: 'a/b/c.txt' }, { tracer: new Tracer({ exporter: ex2 }), cache }); await drain(r2.stream);
  const trees = ex2.lines.flatMap(flattenLine).filter(s => s.name === 'git.read.tree');
  assert.deepEqual(trees.map(s => s.attrs['git.read.tree.cache_hit']), [true, false, false]);
});

test('a server that serves a different blob than asked: the stream errors (pack_corrupt), never ends cleanly', async () => {
  const want = git(R.bare, ['rev-parse', 'main:README.md']).trim(), other = git(R.bare, ['rev-parse', 'main:a/b/c.txt']).trim();
  const liar = (u, init) => {
    const body = init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('latin1') : null;
    if (body && body.includes(`want ${want}\n`) && !body.includes('filter ')) return fetch(u, { ...init, body: Buffer.from(body.replace(want, other), 'latin1') });
    return fetch(u, init);
  };
  const r = await readFile(R.url, { path: 'README.md' }, { tracer: tracer(), fetchImpl: liar });
  await assert.rejects(drain(r.stream), e => e.code === 'pack_corrupt' && /hashes to/.test(e.message));
});

test('credential hygiene: never in spans; an upstream error body echoing Authorization is scrubbed', async () => {
  const token = 'ghp_SECRETTOKEN1234567890abcdef';
  const ex = arrayExporter();
  const r = await readFile(R.url, { path: 'README.md' }, { tracer: new Tracer({ exporter: ex }), auth: { token } }); await drain(r.stream);
  await listTree(R.url, {}, { tracer: new Tracer({ exporter: ex }), auth: { header: `Bearer ${token}` } });
  const dump = JSON.stringify(ex.lines);
  for (const s of [token, btoa(`x-access-token:${token}`)]) assert.ok(!dump.includes(s), 'credential in spans');
  const echo = http.createServer((req, res) => { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(`you sent: ${req.headers.authorization} / decoded: ${Buffer.from(String(req.headers.authorization).split(' ')[1] ?? '', 'base64').toString()}`); });
  await new Promise(ok => echo.listen(0, '127.0.0.1', ok));
  try {
    const url = `http://127.0.0.1:${echo.address().port}/x.git`;
    for (const auth of [{ token }, { bearer: token }, { header: `Bearer ${token}` }, { header: `Basic ${btoa(`oauth2:${token}`)}` }]) {
      const ex2 = arrayExporter();
      const err = await readFile(url, { path: 'README.md' }, { tracer: new Tracer({ exporter: ex2 }), auth }).catch(e => e);
      assert.equal(err.code, 'upstream_5xx'); assert.equal(err.status, 500);
      assert.match(err.message, /\[redacted\]/);
      const all = err.message + JSON.stringify(ex2.lines);
      for (const s of [token, btoa(`x-access-token:${token}`), btoa(`oauth2:${token}`)]) assert.ok(!all.includes(s), `credential leaked via ${JSON.stringify(Object.keys(auth))}: ${err.message}`);
    }
  } finally { await new Promise(ok => echo.close(ok)); }
});

// ---- readCommit vs git log / git cat-file ----

const SEP = '\x1f';
const FMT = ['%H', '%T', '%P', '%an', '%ae', '%at', '%ad', '%cn', '%ce', '%ct', '%cd'].join(SEP);
// what git says about `spec`: idents from `git log` (raw dates for epoch + tz, iso-strict in UTC for time), the message
// and the signature header from `git cat-file commit`
function gitCommit(bare, spec) {
  const env = { ...process.env, TZ: 'UTC' };
  const [oid, tree, parents, an, ae, at, ad, cn, ce, ct, cd] = git(bare, ['log', '-1', '--date=raw', `--format=${FMT}`, spec], { env }).replace(/\n$/, '').split(SEP);
  const [aiso, ciso] = git(bare, ['log', '-1', '--date=iso-strict-local', `--format=%ad${SEP}%cd`, spec], { env }).trim().split(SEP).map(d => d.replace(/\+00:00$/, 'Z'));
  const raw = gitBuf(bare, ['cat-file', 'commit', oid]).toString('utf8');
  const cut = raw.indexOf('\n\n');
  const header = raw.slice(0, cut);
  return {
    oid, tree, parents: parents ? parents.split(' ') : [],
    author: { name: an, email: ae, time: aiso, epoch: Number(at), tz: ad.split(' ')[1] },
    committer: { name: cn, email: ce, time: ciso, epoch: Number(ct), tz: cd.split(' ')[1] },
    message: raw.slice(cut + 2), signed: /^gpgsig(-sha256)? /m.test(header),
  };
}

test('parseIdent is git split_ident_line: name trimmed, email to the first >, date after the last >', () => {
  assert.deepEqual(parseIdent('A U Thor <a@x> 1700000000 +0530'), { name: 'A U Thor', email: 'a@x', time: '1700000000', tz: '+0530' });
  assert.deepEqual(parseIdent('Zoë  <z@ë> 0 -1200'), { name: 'Zoë', email: 'z@ë', time: '0', tz: '-1200' });
  assert.deepEqual(parseIdent('weird <a@x> trail> 5 +0000'), { name: 'weird', email: 'a@x', time: '5', tz: '+0000' });
  assert.deepEqual(parseIdent('no email'), { name: 'no email', email: '', time: null, tz: '' });
});

test('readCommit == git log -1 / git cat-file commit: root, merge (2 parents), signed, non-ASCII author, verbatim multi-line message, tags, oid', async () => {
  const bare = makeBareRepo(root, 'rc'); const work = join(root, 'wrc'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  const at = (author, committer, extra = {}) => ({ env: { ...process.env, GIT_AUTHOR_NAME: author[0], GIT_AUTHOR_EMAIL: author[1], GIT_AUTHOR_DATE: author[2], GIT_COMMITTER_NAME: committer[0], GIT_COMMITTER_EMAIL: committer[1], GIT_COMMITTER_DATE: committer[2], ...extra } });
  const commit = (args, who) => git(work, ['commit', '-q', ...args], who);
  writeFileSync(join(work, 'f.txt'), 'one\n'); git(work, ['add', '-A']);
  commit(['-m', 'root'], at(['Root', 'root@x', '1000000000 +0000'], ['Root', 'root@x', '1000000000 +0000']));
  const rootOid = git(work, ['rev-parse', 'HEAD']).trim();
  git(work, ['tag', '-a', '-m', 'annotated', 'v1']); git(work, ['tag', 'light']);
  // side: non-ASCII author and committer, odd offsets, a message kept verbatim (indentation, blank runs, no cleanup)
  git(work, ['checkout', '-q', '-b', 'side']);
  writeFileSync(join(work, 's.txt'), 'side\n'); git(work, ['add', '-A']);
  const msg = 'Ünïcödé subject — 李雷\n\nbody line one\n    indented line\n\n\n# not a comment here\ntrailing spaces   \n\n';
  writeFileSync(join(root, 'msg.txt'), msg);
  commit(['--cleanup=verbatim', '-F', join(root, 'msg.txt')], at(['Zoë Ångström 李雷', 'zoë@exämple.org', '1700000000 +0530'], ['Ørjan Nüñez', 'ørjan@exämple.org', '1700003600 -0800']));
  // main moves, then a --no-ff merge of side: two parents
  git(work, ['checkout', '-q', 'main']);
  writeFileSync(join(work, 'm.txt'), 'main\n'); git(work, ['add', '-A']);
  commit(['-m', 'main moves'], at(['M', 'm@x', '1700007200 +1345'], ['M', 'm@x', '1700007200 +1345']));
  git(work, ['merge', '-q', '--no-ff', '-m', "Merge branch 'side'", 'side'], at(['Merger', 'merge@x', '1700010800 -0330'], ['Merger', 'merge@x', '1700010800 -0330']));
  // signed: a real SSH signature when ssh-keygen exists, else an OpenPGP-shaped gpgsig header written by hand
  git(work, ['checkout', '-q', '-b', 'signed']);
  writeFileSync(join(work, 'g.txt'), 'signed\n'); git(work, ['add', '-A']);
  let how = 'ssh';
  try {
    const key = join(root, 'sign_key'); execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'ply-test', '-f', key], { stdio: 'ignore' });
    git(work, ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${key}`, 'commit', '-q', '-S', '-m', 'signed commit\n\nwith a body'], at(['S', 's@x', '1700014400 +0100'], ['S', 's@x', '1700014400 +0100']));
  } catch {
    how = 'handmade';
    const tree = git(work, ['write-tree']).trim(), parent = git(work, ['rev-parse', 'HEAD']).trim();
    const obj = `tree ${tree}\nparent ${parent}\nauthor S <s@x> 1700014400 +0100\ncommitter S <s@x> 1700014400 +0100\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n =abcd\n -----END PGP SIGNATURE-----\n\nsigned commit\n\nwith a body\n`;
    git(work, ['update-ref', 'refs/heads/signed', gitBuf(work, ['hash-object', '-t', 'commit', '-w', '--stdin'], obj).toString().trim()]);
  }
  git(work, ['push', '-q', bare, 'main', 'side', 'signed', 'refs/tags/v1', 'refs/tags/light']);
  git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const url = `${srv.url}/rc.git`;
  const sideOid = git(bare, ['rev-parse', 'side']).trim();
  const cases = [[null, 'HEAD', 'refs/heads/main'], ['main', 'main', 'refs/heads/main'], ['refs/heads/main', 'main', 'refs/heads/main'], ['side', 'side', 'refs/heads/side'], ['signed', 'signed', 'refs/heads/signed'],
    ['v1', 'v1^{commit}', 'refs/tags/v1'], ['refs/tags/light', 'light', 'refs/tags/light'], [rootOid, rootOid, rootOid], [sideOid, sideOid, sideOid]];
  for (const [ref, spec, name] of cases) {
    const got = await readCommit(url, { ref }, { tracer: tracer() });
    const { ref: gotRef, ...rest } = got;
    assert.equal(gotRef, name, String(ref));
    assert.deepEqual(rest, gitCommit(bare, spec), `${ref}: readCommit != git`);
  }
  // the properties each case was built for, stated independently of the oracle
  const merge = await readCommit(url, {}, { tracer: tracer() });
  assert.equal(merge.parents.length, 2); assert.deepEqual(merge.parents, [git(bare, ['rev-parse', 'main^1']).trim(), sideOid]); assert.equal(merge.signed, false);
  assert.equal(merge.author.tz, '-0330'); assert.equal(merge.author.time, '2023-11-15T01:13:20Z'); assert.equal(merge.author.epoch, 1700010800);
  const side = await readCommit(url, { ref: 'side' }, { tracer: tracer() });
  assert.equal(side.message, msg); assert.deepEqual(side.author, { name: 'Zoë Ångström 李雷', email: 'zoë@exämple.org', time: '2023-11-14T22:13:20Z', epoch: 1700000000, tz: '+0530' });
  assert.equal(side.committer.name, 'Ørjan Nüñez'); assert.equal(side.committer.tz, '-0800');
  const signed = await readCommit(url, { ref: 'signed' }, { tracer: tracer() });
  assert.equal(signed.signed, true, how); assert.equal(signed.message, 'signed commit\n\nwith a body\n');
  const r0 = await readCommit(url, { ref: 'v1' }, { tracer: tracer() });
  assert.deepEqual(r0.parents, []); assert.equal(r0.oid, rootOid);
  // not_found: missing ref, unknown oid, the oid of a tree; bad ref is bad_request
  await assert.rejects(readCommit(url, { ref: 'nope' }, { tracer: tracer() }), e => e.code === 'not_found');
  await assert.rejects(readCommit(url, { ref: 'f'.repeat(40) }, { tracer: tracer() }), e => e.code === 'not_found');
  await assert.rejects(readCommit(url, { ref: git(bare, ['rev-parse', 'main^{tree}']).trim() }, { tracer: tracer() }), e => e.code === 'not_found');
  await assert.rejects(readCommit(url, { ref: 'a..b' }, { tracer: tracer() }), e => e.code === 'bad_request');
  console.log(`  ${cases.length} refs equal to git (signature: ${how})`);
});

test('readCommit fetches the commit object only: one tree:0 deepen-1 fetch, no tree fetches', async () => {
  const ex = arrayExporter();
  await readCommit(R.url, { ref: 'main' }, { tracer: new Tracer({ exporter: ex }) });
  const spans = ex.lines.flatMap(flattenLine);
  const fetches = spans.filter(s => s.name === 'git.upload-pack fetch');
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].attrs['git.object.type'], 'commit');
  assert.equal(fetches[0].attrs['git.fetch.filter'], 'tree:0'); assert.equal(fetches[0].attrs['git.fetch.deepen'], 1);
  assert.ok(!spans.some(s => s.name === 'git.read.tree'));
});

test('abbreviated oids: unique among advertised tips agrees with git, and a ref name wins', async () => {
  const bare = makeBareRepo(root, 'abbrev');
  const work = join(root, 'abbrev-work');
  mkdirSync(work);
  git(work, ['init', '-q', '-b', 'main']);
  const empty = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const oids = [];
  const bucket = (n) => {
    const m = new Map();
    for (const oid of oids) {
      const k = oid.slice(0, n);
      const g = m.get(k);
      if (g) g.push(oid); else m.set(k, [oid]);
    }
    return m;
  };
  let parent = null;
  for (let i = 0; i < 4000; i++) {
    const args = ['-c', 'user.name=seed', '-c', 'user.email=seed@x', '-c', 'commit.gpgsign=false', 'commit-tree', empty, '-m', String(i)];
    if (parent) args.push('-p', parent);
    parent = git(work, args).trim();
    oids.push(parent);
    if ([...bucket(4).values()].some(v => v.length >= 2) && [...bucket(5).values()].some(v => v.length >= 2) && oids.length > 64) break;
  }
  const g4 = bucket(4);
  const g5 = bucket(5);
  const pair4 = [...g4.entries()].find(([, v]) => v.length >= 2);
  const pair5 = [...g5.entries()].find(([, v]) => v.length >= 2);
  const singles = [...g4.entries()].filter(([, v]) => v.length === 1);
  assert.ok(pair4 && pair5 && singles.length >= 4, `no shared prefix in ${oids.length} commits`);
  const used = new Set([...pair4[1], ...pair5[1]]);
  const free = singles.filter(([, v]) => !used.has(v[0]));
  assert.ok(free.length >= 4, `free singles ${free.length}`);
  const [uniquePrefix, [uniqueOid]] = free[0];
  const [namePrefix, [nameOid]] = free[1];
  const nameTarget = free[2][1][0];
  const [interiorPrefix, [interiorOid]] = free[3];
  git(work, ['update-ref', 'refs/heads/main', parent]);
  git(work, ['push', '-q', bare, 'refs/heads/main']);
  const point = (ref, oid) => git(bare, ['update-ref', ref, oid]);
  point('refs/heads/main', uniqueOid);
  point('refs/heads/a', pair4[1][0]);
  point('refs/heads/b', pair4[1][1]);
  point('refs/heads/c', pair5[1][0]);
  point('refs/heads/d', pair5[1][1]);
  point('refs/heads/hold', nameOid);
  point(`refs/heads/${namePrefix}`, nameTarget);
  git(bare, ['-c', 'user.name=seed', '-c', 'user.email=seed@x', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', 'tag', '-a', '-m', 'ann', 'v1', uniqueOid]);
  const tagOid = git(bare, ['rev-parse', 'v1']).trim();
  let up = uniquePrefix;
  if (tagOid.startsWith(up)) {
    for (let n = 5; n < 40 && tagOid.startsWith(uniqueOid.slice(0, n)); n++) up = uniqueOid.slice(0, n + 1);
  }
  const url = `${srv.url}/abbrev.git`;
  const t = () => createTransport(url, { tracer: tracer() });
  const disambiguate = prefix => git(bare, ['rev-parse', `--disambiguate=${prefix}`]).trim().split('\n').filter(Boolean);
  const advertised = git(bare, ['for-each-ref', '--format=%(objectname) %(objecttype) %(*objectname)']).trim().split('\n').flatMap(l => l.split(' ').filter(x => /^[0-9a-f]{40}$/.test(x)));
  const expectOids = prefix => [...new Set(advertised.filter(o => o.startsWith(prefix)))].sort();
  // a ref named like the prefix wins (git warns that the name is ambiguous, and still answers the ref)
  const named = await resolveCommit(t(), namePrefix, { abbrev: 'advertised' });
  assert.deepEqual(named, { name: `refs/heads/${namePrefix}`, commit: nameTarget });
  const rev = spawnSync('git', ['rev-parse', namePrefix], { cwd: bare, encoding: 'utf8' });
  assert.equal(rev.status, 0);
  assert.match(`${rev.stderr}`, /ambiguous/);
  assert.equal(rev.stdout.trim(), nameTarget);
  assert.equal(git(bare, ['rev-parse', `${namePrefix}^{commit}`]).trim(), nameTarget);
  // unique among advertised tips: git's candidates include that commit
  const unique = await resolveCommit(t(), up, { abbrev: 'advertised' });
  assert.deepEqual(unique, { name: uniqueOid, commit: uniqueOid });
  const uniqueObjs = disambiguate(up);
  assert.ok(uniqueObjs.includes(uniqueOid), uniqueObjs.join(' '));
  assert.equal(git(bare, ['cat-file', '-t', uniqueOid]).trim(), 'commit');
  const listed = await lsRefs(t(), ['HEAD', 'refs/heads/', 'refs/tags/']);
  const peeled = resolveAbbrev(up, listed);
  assert.equal(peeled.ok && peeled.value.kind, 'unique_among_advertised');
  if (peeled.ok && peeled.value.kind === 'unique_among_advertised') {
    assert.equal(peeled.value.oid, uniqueOid);
    assert.ok(peeled.value.refs.includes('refs/tags/v1'));
  }
  // two advertised tips: ply is ambiguous, and each oid is one of git's
  for (const prefix of [pair4[0], pair5[0]]) {
    const want = expectOids(prefix);
    assert.ok(want.length >= 2, prefix);
    await assert.rejects(resolveCommit(t(), prefix, { abbrev: 'advertised' }), e => {
      assert.equal(e.code, 'bad_request');
      assert.deepEqual([...e.got].sort(), want);
      return true;
    });
    const objs = disambiguate(prefix);
    for (const oid of want) assert.ok(objs.includes(oid), `${prefix} ${oid}`);
  }
  // git's only object for this prefix is an interior commit: ply does not call it ambiguous
  assert.deepEqual(disambiguate(interiorPrefix), [interiorOid]);
  await assert.rejects(resolveCommit(t(), interiorPrefix, { abbrev: 'advertised' }), e => e.code === 'not_found');
  // default off: the same prefix is a ref name that does not exist, not an object id
  await assert.rejects(resolveCommit(t(), up), e => e.code === 'not_found');
  console.log(`  abbrev oracle over ${oids.length} commits`);
});

test('openBlob and readBlob match git cat-file; too_big is the object header', async () => {
  // two near-copies, so git stores one as a delta. openBlob asks for one oid and sends no have, so upload-pack has no
  // in-pack base and sends the object whole. The bytes are still cat-file's.
  git(R.work, ['checkout', '-q', '-B', 'deltas', 'main']);
  const base = Buffer.alloc(4000, 0x61);
  const near = Buffer.from(base); near[20] = 0x62;
  writeFileSync(join(R.work, 'delta-a.bin'), base);
  writeFileSync(join(R.work, 'delta-b.bin'), near);
  git(R.work, ['add', 'delta-a.bin', 'delta-b.bin']);
  git(R.work, ['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-q', '-m', 'deltas']);
  git(R.work, ['push', '-q', R.bare, 'HEAD:refs/heads/deltas']);
  git(R.work, ['checkout', '-q', 'main']);
  git(R.bare, ['repack', '-a', '-d', '-f']);
  const packs = readdirSync(join(R.bare, 'objects', 'pack')).filter(n => n.endsWith('.pack'));
  const listed = packs.map(n => git(R.bare, ['verify-pack', '-v', join(R.bare, 'objects', 'pack', n)])).join('\n');
  const deltified = listed.split('\n').filter(l => /\sblob\s.*\s[0-9a-f]{40}$/.test(l)).map(l => l.slice(0, 40));
  assert.ok(deltified.length >= 1, 'the fixture pack stores a blob as a delta');
  const specs = ['empty.txt', 'README.md', 'run.sh', 'big.bin', 'deltas:delta-a.bin', 'deltas:delta-b.bin'];
  for (const spec of specs) {
    const oid = git(R.work, ['rev-parse', `${spec.includes(':') ? spec : `main:${spec}`}`]).trim();
    const size = Number(git(R.work, ['cat-file', '-s', oid]));
    const bytes = gitBuf(R.work, ['cat-file', 'blob', oid]);
    assert.equal(bytes.length, size);
    const ex = arrayExporter(); const tr = new Tracer({ exporter: ex });
    const capped = await openBlob(createTransport(R.url, { tracer: tr }), oid, { maxBytes: Math.max(0, size - 1), follows: tr.start('cap') });
    if (size === 0) {
      assert.equal(capped.ok && capped.value.kind, 'stream', spec);
      if (capped.ok && capped.value.kind === 'stream') assert.equal(capped.value.size, 0);
    } else {
      assert.equal(capped.ok, true, spec);
      if (capped.ok) assert.deepEqual(capped.value, { kind: 'too_big', size });
      const span = ex.lines.flatMap(flattenLine).find(s => s.name === 'git.read.blob');
      assert.equal(span.attrs['git.read.blob.header_only'], true, spec);
      assert.equal(span.attrs['git.read.blob.bytes'], undefined, spec);
    }
    const got = await readBlob(createTransport(R.url, { tracer: tracer() }), oid, { maxBytes: size });
    assert.equal(got.ok, true, spec);
    if (got.ok && got.value.kind === 'bytes') assert.deepEqual(Buffer.from(got.value.data), bytes);
    else assert.fail(`${spec} was ${got.ok ? got.value.kind : got.error.code}`);
  }
  assert.ok(specs.map(spec => git(R.work, ['rev-parse', `${spec.includes(':') ? spec : `main:${spec}`}`]).trim()).some(oid => deltified.includes(oid)));
});
