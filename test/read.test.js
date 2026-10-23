// readFile / listTree against git as the oracle: `git show <ref>:<path>` for bytes, `git ls-tree <ref>:<path>` for
// listings, over git http-backend. Covers nested paths, every entry kind (regular, executable, symlink, gitlink, tree),
// empty and multi-MiB blobs, every ref form (HEAD, full, short, annotated/lightweight tag, oid), the not_found shapes,
// a lying server (wrong blob served → the stream errors), and credential hygiene (spans, echoed error bodies).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, commitFiles } from './server.js';
import { readFile, listTree, readCommit, refCandidates } from '../src/read.js';
import { parseIdent } from '../src/objects.js';
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
