// The ply Worker (worker/index.js), bundled with esbuild as wrangler would and run under workerd, against git
// http-backend (test/server.js). Every endpoint is judged by git; plus the bearer gate, the remote allowlist, the
// credential forwarding (verbatim and per host), credential non-leakage (responses, traces, error bodies, logs) and the
// writes switch. Skipped if workerd is not installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, commitFiles } from './server.js';
import { startProxy } from './proxy.js';

const WORKERD = [process.env.WORKERD, fileURLToPath(new URL('../node_modules/.bin/workerd', import.meta.url))].filter(Boolean).find(p => existsSync(p));
const skip = !WORKERD && 'workerd not installed';
const PORT = 18900 + (process.pid % 50), PORT_RO = PORT + 50;
const PLY = 'test-ply-token-' + 'x'.repeat(20);
const SECRET = 'gitcred_' + 'S3cr3tT0k3n'.repeat(3);          // the git credential the auth proxy expects
const EXPECT = `Bearer ${SECRET}`;
let root, cleanup, srv, authSrv, echoSrv, artProxy, proc, procRo, logs = '';
const A = { name: 'w', email: 'w@x' };

// a git host that requires `Authorization: Bearer SECRET` (401 without, 403 with a wrong one) in front of http-backend
function authProxy(upstream) {
  const up = new URL(upstream);
  const s = http.createServer((req, res) => {
    const a = req.headers.authorization;
    if (!a) { res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' }); return void res.end('Authentication required'); }
    if (a !== EXPECT && a !== `Basic ${Buffer.from(`x-access-token:${SECRET}`).toString('base64')}`) { res.writeHead(403); return void res.end('Forbidden'); }
    const u = http.request({ host: up.hostname, port: up.port, path: req.url, method: req.method, headers: { ...req.headers, host: up.host } }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(u);
  });
  return new Promise(ok => s.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise(r => { s.closeAllConnections?.(); s.close(r); }) })));
}
// a hostile host that echoes the credential back in a 500 body
function echoServer() {
  const s = http.createServer((req, res) => { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(`echo ${req.headers.authorization} ${Buffer.from(String(req.headers.authorization).split(' ')[1] ?? '', 'base64').toString()}`); });
  return new Promise(ok => s.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise(r => { s.closeAllConnections?.(); s.close(r); }) })));
}

before(async () => {
  if (!WORKERD) return;
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  authSrv = await authProxy(srv.url);
  echoSrv = await echoServer();
  const filterOf = b => /filter ([^\n]+)\n/.exec(Buffer.from(b).toString('latin1'))?.[1] ?? null;
  artProxy = await startProxy(srv.url, ctx => (ctx.stage === 'fetch' && filterOf(ctx.reqBody) && filterOf(ctx.reqBody) !== 'blob:none' ? { type: 'status', status: 400, contentType: 'text/plain', body: 'Unsupported Git fetch filter; only blob:none is supported.' } : { type: 'pass' }));
  const out = join(root, 'wk'); mkdirSync(out, { recursive: true });
  await build({ entryPoints: [fileURLToPath(new URL('../worker/index.js', import.meta.url))], bundle: true, format: 'esm', outfile: join(out, 'worker.mjs'), logLevel: 'silent' });
  const allow = [srv.url, authSrv.url, echoSrv.url, artProxy.url].join(',');
  const worker = writes => `(modules = [ (name = "worker.mjs", esModule = embed "worker.mjs") ], compatibilityDate = "2026-10-18", globalOutbound = "internet",
    bindings = [ (name = "PLY_TOKEN", text = "${PLY}"), (name = "WRITES", text = "${writes}"), (name = "ALLOW_REMOTE_ORIGINS", text = "${allow}") ])`;
  writeFileSync(join(out, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "rw", worker = ${worker('on')}), (name = "ro", worker = ${worker('off')}), (name = "internet", network = (allow = ["private", "public", "local"])) ],
  sockets = [ (name = "http", address = "127.0.0.1:${PORT}", http = (), service = "rw"), (name = "http-ro", address = "127.0.0.1:${PORT_RO}", http = (), service = "ro") ],
);
`);
  proc = spawn(WORKERD, ['serve', join(out, 'config.capnp'), '--verbose'], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', d => { logs += d; }); proc.stderr.on('data', d => { logs += d; });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch { } await new Promise(r => setTimeout(r, 100)); }
});
after(async () => { if (!WORKERD) return; proc.kill(); await Promise.all([srv.close(), authSrv.close(), echoSrv.close(), artProxy.close()]); cleanup(); });

const W = (path, { method = 'GET', body, headers = {}, port = PORT, auth = true } = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(auth ? { authorization: `Bearer ${PLY}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined)).toString();
let n = 0;
function repo(files, host = () => srv.url) {
  const name = `r${n++}`; const bare = makeBareRepo(root, name); const work = join(root, `w${name}`); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  const head = commitFiles(work, bare, files, 'seed');
  return { name, bare, work, head, remote: `${host()}/${name}.git` };
}

test('GET / is public usage text; everything else needs the PLY bearer (missing or wrong → 401)', { skip }, async () => {
  const u = await W('/', { auth: false }); assert.equal(u.status, 200); const usage = await u.text(); assert.match(usage, /Authorization: Bearer <PLY_TOKEN>/); assert.match(usage, /GET +\/v1\/commit\?remote=&ref=/);
  for (const [m, p] of [['GET', '/v1/refs'], ['GET', '/v1/read'], ['GET', '/v1/tree'], ['GET', '/v1/discover'], ['GET', '/v1/commit'], ['POST', '/v1/edit'], ['POST', '/v1/branch'], ['DELETE', '/v1/branch'], ['POST', '/v1/merge'], ['POST', '/v1/rebase'], ['POST', '/v1/cherry-pick'], ['POST', '/v1/revert'], ['GET', '/nope']]) {
    for (const headers of [{}, { authorization: `Bearer ${PLY}x` }, { authorization: `Bearer ${PLY.slice(0, -1)}` }, { authorization: `Basic ${btoa(`x:${PLY}`)}` }]) {
      const r = await W(`${p}?remote=${encodeURIComponent(srv.url + '/x.git')}`, { method: m, headers, auth: false });
      assert.equal(r.status, 401, `${m} ${p} ${JSON.stringify(headers)}`); assert.equal((await r.json()).code, 'unauthorized');
      assert.match(r.headers.get('www-authenticate') ?? '', /Bearer/);
    }
  }
  assert.equal((await W('/nope')).status, 404);
  assert.equal((await W('/v1/read', { method: 'POST' })).status, 405);
});

test('remote allowlist: https only, no IP literals / private names / userinfo / ports / query; nothing is fetched', { skip }, async () => {
  const bad = ['http://example.com/x.git', 'https://127.0.0.1/x.git', 'https://10.0.0.1/x.git', 'https://169.254.169.254/x.git', 'https://192.168.1.1/x.git', 'https://[::1]/x.git', 'https://[fd00::1]/x.git',
    'https://2130706433/x.git', 'https://0x7f000001/x.git', 'https://localhost/x.git', 'https://foo.localhost/x.git', 'https://git.internal/x.git', 'https://intranet/x.git', 'https://user:pw@github.com/x.git',
    'https://github.com:8443/x.git', 'https://github.com/x.git?a=b', 'ftp://github.com/x.git', 'not a url', ''];
  for (const remote of bad) {
    const r = await W(`/v1/refs?${qs({ remote, trace: '1' })}`);
    const b = await r.json();
    assert.equal(r.status, 400, `${remote}: ${JSON.stringify(b)}`); assert.equal(b.code, 'bad_request'); assert.equal(b.retry, 'no');
    assert.deepEqual(b.trace, [], 'refused before any span (no request was made)');
  }
  const w = await W('/v1/edit', { method: 'POST', body: { remote: 'https://127.0.0.1/x.git', path: 'a', find: 'b', replace: 'c', author: A, message: 'm' } });
  assert.equal(w.status, 400);
});

test('read endpoints equal git: refs, discover, tree, read (bytes, headers, content-length, streamed 3 MiB)', { skip }, async () => {
  const big = Buffer.alloc(3 << 20); for (let i = 0; i < big.length; i += 5) big[i] = i & 255;
  const r = repo({ 'README.md': '# hello\n', 'a/b/c.txt': 'nested\n', 'empty': '', 'big.bin': big });
  git(r.work, ['tag', '-a', '-m', 't', 'v1']); git(r.work, ['push', '-q', r.bare, 'refs/tags/v1']);
  const refs = await (await W(`/v1/refs?${qs({ remote: r.remote })}`)).json();
  assert.equal(refs.head, 'refs/heads/main'); assert.equal(refs.refs['refs/heads/main'], r.head);
  assert.equal(refs.refs['refs/tags/v1'], git(r.bare, ['rev-parse', 'v1']).trim()); assert.equal(refs.peeled['refs/tags/v1'], r.head);
  const pre = await (await W(`/v1/refs?${qs({ remote: r.remote, prefix: 'refs/tags/' })}`)).json();
  assert.deepEqual(Object.keys(pre.refs), ['refs/tags/v1']); assert.equal(pre.head, 'refs/heads/main');
  const d = await (await W(`/v1/discover?${qs({ remote: r.remote })}`)).json();
  assert.equal(d.version, 2); assert.match(d.agent, /^git\//); assert.equal(d.objectFormat, 'sha1');
  const tr = await (await W(`/v1/tree?${qs({ remote: r.remote, path: 'a/b' })}`)).json();
  assert.deepEqual(tr.entries, [{ name: 'c.txt', mode: '100644', oid: git(r.bare, ['rev-parse', 'main:a/b/c.txt']).trim(), type: 'blob' }]);
  const top = await (await W(`/v1/tree?${qs({ remote: r.remote, ref: 'v1' })}`)).json();
  assert.equal(top.tree, git(r.bare, ['rev-parse', 'v1^{tree}']).trim()); assert.equal(top.entries.length, 4);
  for (const path of ['README.md', 'a/b/c.txt', 'empty', 'big.bin']) {
    const res = await W(`/v1/read?${qs({ remote: r.remote, path })}`);
    assert.equal(res.status, 200, path);
    const got = Buffer.from(await res.arrayBuffer()), want = gitBuf(r.bare, ['show', `main:${path}`]);
    assert.ok(got.equals(want), `${path} bytes`);
    assert.equal(res.headers.get('content-length'), String(want.length), `${path} content-length`);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal(res.headers.get('x-ply-commit'), r.head); assert.equal(res.headers.get('x-ply-blob'), git(r.bare, ['rev-parse', `main:${path}`]).trim());
  }
  const tr1 = await W(`/v1/read?${qs({ remote: r.remote, path: 'README.md', trace: '1' })}`);
  assert.match(tr1.headers.get('x-ply-trace'), /ls-refs;dur=\d+/); await tr1.arrayBuffer();
  for (const [path, code, status] of [['nope', 'not_found', 404], ['a/b', 'not_found', 404], ['README.md/x', 'not_found', 404], ['../x', 'bad_request', 400]]) {
    const res = await W(`/v1/read?${qs({ remote: r.remote, path })}`); const b = await res.json();
    assert.equal(res.status, status, path); assert.equal(b.code, code); assert.equal(b.retry, 'no');
  }
  const nr = await W(`/v1/read?${qs({ remote: r.remote, path: 'README.md', ref: 'nope' })}`); assert.equal(nr.status, 404);
  const trace = await (await W(`/v1/tree?${qs({ remote: r.remote, trace: '1' })}`)).json();
  assert.ok(trace.trace.some(s => s.name === 'git.upload-pack ls-refs') && trace.trace.some(s => s.name === 'git.ls_tree'));
});

test('GET /v1/commit equals git log / cat-file (HEAD, short, full, tag, oid, merge); not_found / bad_request shapes; blob:none fallback', { skip }, async () => {
  const r = repo({ 'f.txt': 'one\n' });
  git(r.work, ['tag', '-a', '-m', 't', 'v1']);
  git(r.work, ['checkout', '-q', '-b', 'side']); writeFileSync(join(r.work, 's.txt'), 's\n'); git(r.work, ['add', '-A']);
  git(r.work, ['commit', '-q', '-m', 'side: Zoë\n\nline two\nline three'], { env: { ...process.env, GIT_AUTHOR_NAME: 'Zoë Ångström', GIT_AUTHOR_EMAIL: 'z@ë.x', GIT_AUTHOR_DATE: '1700000000 +0530', GIT_COMMITTER_NAME: 'C', GIT_COMMITTER_EMAIL: 'c@x', GIT_COMMITTER_DATE: '1700000100 -0800' } });
  git(r.work, ['checkout', '-q', 'main']); writeFileSync(join(r.work, 'm.txt'), 'm\n'); git(r.work, ['add', '-A']);
  git(r.work, ['-c', 'user.name=m', '-c', 'user.email=m@x', 'commit', '-q', '-m', 'main']);
  git(r.work, ['-c', 'user.name=m', '-c', 'user.email=m@x', 'merge', '-q', '--no-ff', '-m', 'merge side', 'side']);
  git(r.work, ['push', '-q', r.bare, 'main', 'side', 'refs/tags/v1']);
  const want = (spec, bare = r.bare) => {
    const [oid, tree, parents, an, ae, ad, cn, ce, cd] = git(bare, ['log', '-1', '--date=raw', `--format=%H%x1f%T%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%cn%x1f%ce%x1f%cd`, spec]).replace(/\n$/, '').split('\x1f');
    const raw = gitBuf(bare, ['cat-file', 'commit', oid]).toString(); const id = (name, email, d) => { const [epoch, tz] = d.split(' '); return { name, email, time: new Date(Number(epoch) * 1000).toISOString().replace('.000Z', 'Z'), epoch: Number(epoch), tz }; };
    return { oid, tree, parents: parents ? parents.split(' ') : [], author: id(an, ae, ad), committer: id(cn, ce, cd), message: raw.slice(raw.indexOf('\n\n') + 2), signed: false };
  };
  const side = git(r.bare, ['rev-parse', 'side']).trim();
  for (const [ref, spec, name] of [[undefined, 'main', 'refs/heads/main'], ['main', 'main', 'refs/heads/main'], ['refs/heads/side', 'side', 'refs/heads/side'], ['v1', 'v1^{commit}', 'refs/tags/v1'], [side, side, side]]) {
    const res = await W(`/v1/commit?${qs({ remote: r.remote, ref })}`);
    const b = await res.json();
    assert.equal(res.status, 200, JSON.stringify(b)); assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual(b, { ref: name, ...want(spec) }, String(ref));
  }
  const m = await (await W(`/v1/commit?${qs({ remote: r.remote })}`)).json();
  assert.equal(m.parents.length, 2); assert.equal(m.parents[1], side);
  const s = await (await W(`/v1/commit?${qs({ remote: r.remote, ref: 'side' })}`)).json();
  assert.deepEqual(s.author, { name: 'Zoë Ångström', email: 'z@ë.x', time: '2023-11-14T22:13:20Z', epoch: 1700000000, tz: '+0530' }); assert.equal(s.message, 'side: Zoë\n\nline two\nline three\n');
  for (const [ref, status, code] of [['nope', 404, 'not_found'], ['f'.repeat(40), 404, 'not_found'], [git(r.bare, ['rev-parse', 'main:f.txt']).trim(), 404, 'not_found'], ['a..b', 400, 'bad_request']]) {
    const res = await W(`/v1/commit?${qs({ remote: r.remote, ref })}`); const b = await res.json();
    assert.equal(res.status, status, `${ref}: ${JSON.stringify(b)}`); assert.equal(b.code, code); assert.equal(b.retry, 'no');
  }
  const missing = await W(`/v1/commit?${qs({ remote: `${srv.url}/does-not-exist.git` })}`); assert.equal(missing.status, 404); assert.equal((await missing.json()).code, 'not_found');
  assert.equal((await W('/v1/commit')).status, 400);
  assert.equal((await W(`/v1/commit?${qs({ remote: r.remote })}`, { method: 'POST' })).status, 405);
  const tr = await (await W(`/v1/commit?${qs({ remote: r.remote, trace: '1' })}`)).json();
  const fetches = tr.trace.filter(x => x.name === 'git.upload-pack fetch');
  assert.equal(fetches.length, 1); assert.equal(fetches[0].attrs['git.fetch.filter'], 'tree:0'); assert.equal(fetches[0].attrs['git.fetch.deepen'], 1);
  // Artifacts mode: tree:0 refused → blob:none, same answer
  const a = repo({ 'x.txt': 'x\n' }, () => artProxy.url);
  const ab = await (await W(`/v1/commit?${qs({ remote: a.remote, trace: '1' })}`)).json();
  const { trace, ...rest } = ab;
  assert.deepEqual(rest, { ref: 'refs/heads/main', ...want('main', a.bare) }); assert.equal(rest.oid, a.head);
  assert.ok(trace.some(x => x.attrs['git.fetch.filter.fallback'] === 'blob:none'));
});

test('a server that refuses tree:0 (Artifacts mode): reads and an edit still match git via the blob:none fallback', { skip }, async () => {
  const r = repo({ 'd/e/f.txt': 'deep MARK\n', 'x.txt': 'x\n' }, () => artProxy.url);
  const res = await W(`/v1/read?${qs({ remote: r.remote, path: 'd/e/f.txt', trace: '1' })}`);
  assert.equal(res.status, 200); assert.equal(await res.text(), 'deep MARK\n');
  const tr = await (await W(`/v1/tree?${qs({ remote: r.remote, path: 'd', trace: '1' })}`)).json();
  assert.equal(tr.tree, git(r.bare, ['rev-parse', 'main:d']).trim());
  const e = await (await W('/v1/edit?trace=1', { method: 'POST', body: { remote: r.remote, path: 'd/e/f.txt', find: 'MARK', replace: 'EDITED', author: A, message: 'm' } })).json();
  assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), e.newCommit, JSON.stringify(e).slice(0, 400));
  assert.equal(gitBuf(r.bare, ['show', 'main:d/e/f.txt']).toString(), 'deep EDITED\n');
  assert.ok(e.trace.some(s => s.attrs['git.fetch.filter.fallback'] === 'blob:none'));
});

test('writes equal git: edit, branch create/delete, merge, rebase, cherry-pick, revert; CAS → 409; conflicts → 409/422', { skip }, async () => {
  const r = repo({ 'f.txt': 'one MARK\n', 'x.txt': 'x1\nx2\nx3\n', 'y.txt': 'y\n' });
  const post = (p, body, method = 'POST') => W(p, { method, body: { remote: r.remote, ...body } }).then(async res => ({ status: res.status, body: await res.json() }));
  // edit (HEAD branch by default), then a stale head → 409 and nothing pushed
  let x = await post('/v1/edit', { path: 'f.txt', find: 'MARK', replace: 'EDIT', author: A, message: 'edit' });
  assert.equal(x.status, 200, JSON.stringify(x.body)); assert.equal(x.body.ref, 'refs/heads/main'); assert.equal(x.body.noop, false);
  const c1 = x.body.newCommit; assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), c1); assert.equal(gitBuf(r.bare, ['show', 'main:f.txt']).toString(), 'one EDIT\n');
  x = await post('/v1/edit', { path: 'f.txt', find: 'EDIT', replace: 'AGAIN', author: A, message: 'stale', head: r.head });
  assert.equal(x.status, 409); assert.equal(x.body.code, 'cas_conflict'); assert.equal(x.body.retry, 'fresh'); assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), c1);
  x = await post('/v1/edit', { path: 'f.txt', find: 'EDIT', replace: 'AGAIN', author: A, message: 'fresh', head: c1 });
  assert.equal(x.status, 200); const c2 = x.body.newCommit;
  x = await post('/v1/edit', { path: 'f.txt', find: 'nothere', replace: 'z', author: A, message: 'm' });
  assert.equal(x.status, 422); assert.equal(x.body.code, 'match_count'); assert.equal(x.body.matches, 0);
  x = await post('/v1/edit', { path: 'f.txt', find: 'AGAIN', replace: 'AGAIN', author: A, message: 'noop' });
  assert.equal(x.status, 200); assert.equal(x.body.noop, true); assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), c2);
  // edit creating a branch from main
  x = await post('/v1/edit', { ref: 'feat', base: 'main', path: 'x.txt', find: 'x2', replace: 'x2 feat', author: A, message: 'feat' });
  assert.equal(x.status, 200); const f1 = x.body.newCommit; assert.equal(git(r.bare, ['rev-parse', 'feat']).trim(), f1);
  // branch create (409 if it exists), delete with CAS (stale → 409), delete current
  x = await post('/v1/branch', { ref: 'tmp', from: 'main' }); assert.equal(x.status, 201); assert.equal(x.body.oid, c2); assert.equal(git(r.bare, ['rev-parse', 'tmp']).trim(), c2);
  x = await post('/v1/branch', { ref: 'tmp', from: 'main' }); assert.equal(x.status, 409); assert.equal(x.body.code, 'cas_conflict');
  x = await post('/v1/branch', { ref: 'tmp', oid: r.head }, 'DELETE'); assert.equal(x.status, 409); assert.equal(x.body.code, 'cas_conflict');
  x = await post('/v1/branch', { ref: 'tmp', oid: c2 }, 'DELETE'); assert.equal(x.status, 200); assert.equal(x.body.deleted, c2);
  assert.throws(() => git(r.bare, ['rev-parse', '--verify', '-q', 'refs/heads/tmp']));
  x = await post('/v1/branch', { ref: 'tmp' }, 'DELETE'); assert.equal(x.status, 404);
  // main moves on y.txt; merge feat → a merge commit whose tree is git merge-tree's
  x = await post('/v1/edit', { path: 'y.txt', find: 'y', replace: 'y main', author: A, message: 'main y' }); const m1 = x.body.newCommit;
  x = await post('/v1/merge', { from: 'feat', author: A, message: 'merge feat' });
  assert.equal(x.status, 200, JSON.stringify(x.body)); assert.equal(x.body.outcome, 'merge');
  assert.equal(x.body.tree, git(r.bare, ['merge-tree', '--write-tree', m1, f1]).trim().split('\n')[0]);
  assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), x.body.oid); const mg = x.body.oid;
  // feat2 from the pre-merge main, rebased onto main
  x = await post('/v1/edit', { ref: 'feat2', base: 'main', path: 'f.txt', find: 'AGAIN', replace: 'AGAIN2', author: A, message: 'feat2' });
  const f2 = x.body.newCommit;
  x = await post('/v1/edit', { path: 'y.txt', find: 'y main', replace: 'y main2', author: A, message: 'main moves' }); const m2 = x.body.newCommit;
  x = await post('/v1/rebase', { ref: 'feat2', committer: A });
  assert.equal(x.status, 200, JSON.stringify(x.body)); assert.equal(x.body.outcome, 'rebase'); assert.equal(x.body.commits, 1);
  assert.equal(git(r.bare, ['rev-parse', 'feat2^{tree}']).trim(), git(r.bare, ['merge-tree', '--write-tree', `--merge-base=${mg}`, m2, f2]).trim().split('\n')[0]);
  assert.equal(git(r.bare, ['rev-parse', 'feat2^']).trim(), m2);
  // cherry-pick the rebased commit onto main, then revert it
  const picked = git(r.bare, ['rev-parse', 'feat2']).trim();
  x = await post('/v1/cherry-pick', { commit: picked, committer: A }); assert.equal(x.status, 200, JSON.stringify(x.body));
  assert.equal(x.body.tree, git(r.bare, ['rev-parse', 'feat2^{tree}']).trim());
  x = await post('/v1/revert', { commit: x.body.oid, committer: A }); assert.equal(x.status, 200);
  assert.equal(x.body.tree, git(r.bare, ['rev-parse', `${m2}^{tree}`]).trim());
  // a content conflict → 409 merge_conflict with the paths
  await post('/v1/edit', { ref: 'c1', base: 'main', path: 'x.txt', find: 'x1', replace: 'x1 left', author: A, message: 'l' });
  await post('/v1/edit', { path: 'x.txt', find: 'x1', replace: 'x1 right', author: A, message: 'r' });
  x = await post('/v1/merge', { from: 'c1', author: A }); assert.equal(x.status, 409); assert.equal(x.body.code, 'merge_conflict'); assert.deepEqual(x.body.conflicts, ['x.txt']);
  // bad input
  x = await post('/v1/edit', { path: 'f.txt', find: 'a', replace: 'b', message: 'no author' }); assert.equal(x.status, 400);
  x = await post('/v1/cherry-pick', { commit: 'nothex', committer: A }); assert.equal(x.status, 400);
  const raw = await W('/v1/edit', { method: 'POST', body: undefined, headers: { 'content-type': 'application/json' } }); assert.equal(raw.status, 400);
  // an oversized declared body is refused from its Content-Length, before it is read
  const huge = await new Promise((ok, no) => { const q = http.request({ host: '127.0.0.1', port: PORT, path: '/v1/edit', method: 'POST', headers: { authorization: `Bearer ${PLY}`, 'content-length': String((1 << 20) + 10) } }, res => { res.resume(); ok(res.statusCode); }); q.on('error', no); q.write('{'); });
  assert.equal(huge, 413);
  assert.equal(git(r.bare, ['fsck', '--strict', '--no-dangling']).trim(), '');
});

test('writes switch: WRITES=off → 501 on every write endpoint, reads still served', { skip }, async () => {
  const r = repo({ 'f.txt': 'MARK\n' });
  for (const [m, p] of [['POST', '/v1/edit'], ['POST', '/v1/branch'], ['DELETE', '/v1/branch'], ['POST', '/v1/merge'], ['POST', '/v1/rebase'], ['POST', '/v1/cherry-pick'], ['POST', '/v1/revert']]) {
    const res = await W(p, { method: m, port: PORT_RO, body: { remote: r.remote, path: 'f.txt', find: 'MARK', replace: 'X', author: A, message: 'm' } });
    assert.equal(res.status, 501, `${m} ${p}`); assert.equal((await res.json()).code, 'unsupported');
  }
  assert.equal(git(r.bare, ['rev-parse', 'main']).trim(), r.head);
  const rd = await W(`/v1/read?${qs({ remote: r.remote, path: 'f.txt' })}`, { port: PORT_RO }); assert.equal(await rd.text(), 'MARK\n');
});

test('git credentials: Git-Authorization verbatim, Git-Token mapped; upstream 401/403 mirrored; never in responses, traces, errors or logs', { skip }, async () => {
  const r = repo({ 'f.txt': 'secret MARK\n' }, () => authSrv.url);
  const ok = await W(`/v1/read?${qs({ remote: r.remote, path: 'f.txt' })}`, { headers: { 'git-authorization': EXPECT } });
  assert.equal(ok.status, 200); assert.equal(await ok.text(), 'secret MARK\n');
  const tok = await W(`/v1/tree?${qs({ remote: r.remote, trace: '1' })}`, { headers: { 'git-token': SECRET } }); // non-GitHub host → Bearer
  assert.equal(tok.status, 200); const tokBody = await tok.text();
  const none = await W(`/v1/refs?${qs({ remote: r.remote })}`); const noneB = await none.json();
  assert.equal(none.status, 401); assert.equal(noneB.code, 'auth'); assert.equal(noneB.upstreamStatus, 401);
  const wrong = await W(`/v1/refs?${qs({ remote: r.remote, trace: '1' })}`, { headers: { 'git-authorization': `Bearer ${SECRET}x` } });
  assert.equal(wrong.status, 403); const wrongB = await wrong.text();
  const both = await W(`/v1/refs?${qs({ remote: r.remote })}`, { headers: { 'git-authorization': EXPECT, 'git-token': SECRET } }); assert.equal(both.status, 400);
  const e = await W('/v1/edit?trace=1', { method: 'POST', headers: { 'git-authorization': EXPECT }, body: { remote: r.remote, path: 'f.txt', find: 'MARK', replace: 'EDIT', author: A, message: 'm' } });
  assert.equal(e.status, 200); const eB = await e.text();
  assert.equal(gitBuf(r.bare, ['show', 'main:f.txt']).toString(), 'secret EDIT\n');
  // a hostile upstream echoing the credential in its error body, under every credential form
  const echoes = [];
  for (const headers of [{ 'git-authorization': EXPECT }, { 'git-token': SECRET }, { 'git-authorization': `Basic ${btoa(`oauth2:${SECRET}`)}` }]) {
    const res = await W(`/v1/read?${qs({ remote: `${echoSrv.url}/x.git`, path: 'f', trace: '1' })}`, { headers });
    const b = await res.text(); echoes.push(b);
    assert.equal(res.status, 502, b); assert.match(b, /upstream_5xx/); assert.match(b, /\[redacted\]/);
  }
  await new Promise(r => setTimeout(r, 300)); // let workerd flush its log lines
  const forms = [SECRET, btoa(`x-access-token:${SECRET}`), btoa(`oauth2:${SECRET}`), SECRET.slice(0, 16)];
  const haystack = { tokBody, wrongB, eB, echoes: echoes.join('\n'), logs };
  for (const [where, text] of Object.entries(haystack)) for (const f of forms) assert.ok(!text.includes(f), `credential form ${f.slice(0, 6)}… found in ${where}`);
  assert.match(logs, /"msg":"ply.request"/, 'the structured request log lines were captured (the grep is not vacuous)');
  assert.ok(!logs.includes(PLY), 'the PLY token is not logged');
});
