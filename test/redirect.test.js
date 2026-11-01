// followRedirects 'initial' (#113) against git's own client.
//
// Product, judged by `git -c http.followRedirects=… ls-remote` with GIT_TRACE_CURL (method, path, host, and whether
// Authorization was sent) and by the refs ls-remote prints when both succeed:
//
//   origin   same (one listener; Location is a path) | cross (Location is another port)
//   auth     the caller's Authorization | none
//   follow   initial | off (git `false`, ply `never`)
//   kind     keep (301 whose Location ends with /info/refs?service=git-upload-pack)
//            | drop (301 that drops the ?service= suffix)
//            | post (info/refs is 200, the POST is 307)
//            | dotdot (Location is ../new.git/info/refs?service=…, same-origin only: a relative URL has one origin)
//
// Two places git and ply are not the same request list, both checked rather than papered over:
//   - a Location that fails the suffix rule: git's curl requests it, then update_url_from_redirect dies; ply reports
//     the http error and does not request it.
//   - after a cross-origin rebase, git reapplies `http.extraHeader` on the POST it builds itself. ply drops the
//     caller's Authorization for every request to the new origin (a redirect must not move a credential). The
//     redirected GET matches git: curl already strips Authorization there.
//
// maxRedirects is ply's cap (git follows up to curl's 50). It is swept through 0, 1, the default 3, 4, 15, 16 and the
// values refused past 16. Status codes sit on the 3xx boundary git actually answers: 299, 300, 301, 398, 399, 400.
import http from 'node:http';
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { git, gitAsync, tmpRoot, makeBareRepo, commitFiles, startGitServer } from './server.js';
import { GitHttp } from '../src/client.js';
import { lsRefs } from '../src/lsrefs.js';
import { createTransport, baseFromRedirect, redirectPolicy } from '../src/http.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { ok } from '../src/result.js';
import { fail } from '../src/errors.js';

const TOK = 's3cret-token';
const BASIC = `Basic ${Buffer.from(`x-access-token:${TOK}`).toString('base64')}`;
const EVIL = `Basic ${Buffer.from('evil:s3cret').toString('base64')}`;
const SERVICE = 'git-upload-pack';
const TAIL = `/info/refs?service=${SERVICE}`;
const ORIGINS = ['same', 'cross'];
const AUTHS = [false, true];
const FOLLOWS = ['initial', 'off'];
const KINDS = ['keep', 'drop', 'post', 'dotdot'];
const HOP_CAP = 16;
const DEFAULT_HOPS = 3;

let root, cleanup, srv, gate, gateHits, gatePost;
before(async () => {
  ({ root, cleanup } = tmpRoot());
  const bare = makeBareRepo(root, 'new');
  const work = join(root, 'work');
  git(root, ['init', '-q', '-b', 'main', work]);
  commitFiles(work, bare, { 'README.md': 'hello\n' });
  srv = await startGitServer(root);
  gateHits = [];
  gatePost = null;
  gate = await listen((req, res) => {
    gateHits.push(hit(req));
    if (req.method === 'POST' && gatePost !== null) { res.writeHead(gatePost.status, gatePost.headers); res.end(); return; }
    proxy(req, res, srv.url, req.url);
  });
});
after(async () => { await gate.close(); await srv.close(); cleanup(); });

const hit = req => ({ method: req.method, path: req.url, host: req.headers.host, auth: req.headers.authorization ?? null });
function listen(handler) {
  const s = http.createServer(handler);
  return new Promise(resolve => s.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${s.address().port}`,
    host: `127.0.0.1:${s.address().port}`,
    close: () => new Promise(r => { s.closeAllConnections?.(); s.close(r); }),
  })));
}
function proxy(req, res, upstream, path) {
  const up = new URL(upstream);
  const p = http.request({ hostname: up.hostname, port: up.port, path, method: req.method, headers: { ...req.headers, host: up.host } }, r => {
    res.writeHead(r.statusCode, r.headers); r.pipe(res);
  });
  req.pipe(p);
}
const traceRequests = stderr => {
  const reqs = [];
  let cur = null;
  for (const line of stderr.split('\n')) {
    const send = /=> Send header: (GET|POST) (\S+) HTTP\/1\.[01]/.exec(line);
    if (send) {
      let path = send[2];
      if (path.startsWith('http://') || path.startsWith('https://')) { const u = new URL(path); path = `${u.pathname}${u.search}`; }
      cur = { method: send[1], path, host: '', auth: false };
      reqs.push(cur);
      continue;
    }
    const host = /=> Send header: Host: (\S+)/.exec(line);
    if (host && cur && cur.host === '') cur.host = host[1];
    if (/=> Send header: Authorization:/.test(line) && cur) cur.auth = true;
  }
  return reqs;
};
const clientView = (gitReqs, originHost) => gitReqs.map(r => ({ method: r.method, path: r.path, host: r.host, auth: r.auth && r.host === originHost }));
const refLines = text => text.trim().split('\n').filter(Boolean).sort();
const plyLines = refs => [...refs.values()].map(r => `${r.oid}\t${r.name}`).sort();

async function gitLs(url, follow, auth) {
  const config = [['protocol.version', '2'], ['http.followRedirects', follow === 'initial' ? 'initial' : 'false']];
  if (auth) config.push(['http.extraHeader', `Authorization: ${BASIC}`]);
  const r = await gitAsync(root, ['ls-remote', url], { GIT_TRACE_CURL: '1' }, { config });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, reqs: traceRequests(r.stderr) };
}
function plyClient(url, { follow, auth, max, allowUrl, fetchImpl, exporter }) {
  const tracer = new Tracer(exporter ? { exporter } : {});
  const opts = { tracer, followRedirects: follow === 'off' ? 'never' : follow, allowUrl, fetchImpl };
  if (max !== undefined) opts.maxRedirects = max;
  if (auth) opts.auth = { token: TOK };
  return new GitHttp(url, opts);
}
async function plyLs(url, spec) {
  const c = plyClient(url, spec);
  try { const r = await c.lsRefs(); return { ok: true, refs: r.refs, url: c.url, error: null }; }
  catch (error) { return { ok: false, refs: null, url: c.url, error }; }
}

// What `kind` answers on `front`, proxying a kept repo through to git http-backend. `stolen` records a POST Location
// that nobody should request. Cross-origin Locations point at `gate` (another port in front of the same backend).
function frontHandler(kind, status, stolen) {
  return (req, res) => {
    const info = req.method === 'GET' && req.url.startsWith('/old.git/info/refs');
    if (info && kind === 'keep') {
      const loc = stolen.cross ? `${gate.url}/new.git${TAIL}` : `/new.git${TAIL}`;
      res.writeHead(status, { location: loc }); res.end(); return;
    }
    if (info && kind === 'drop') {
      const loc = stolen.cross ? `${gate.url}/new.git/info/refs` : '/new.git/info/refs';
      res.writeHead(status, { location: loc }); res.end(); return;
    }
    if (info && kind === 'userinfo') {
      res.writeHead(status, { location: `http://evil:s3cret@${stolen.frontHost}/new.git${TAIL}` }); res.end(); return;
    }
    if (info && kind === 'dotdot') {
      res.writeHead(status, { location: `../new.git${TAIL}` }); res.end(); return;
    }
    if (req.method === 'POST' && kind === 'post' && req.url.startsWith('/old.git/')) {
      res.writeHead(307, { location: `${stolen.url}/stolen.git/${SERVICE}` }); res.end(); return;
    }
    const path = req.url.replace(/^\/old\.git\/new\.git\//, '/new.git/').replace(/^\/renamed\.git\//, '/new.git/');
    if (path.startsWith('/new.git/') || path.startsWith('/old.git/')) proxy(req, res, srv.url, path.startsWith('/old.git/') ? path.replace(/^\/old\.git\//, '/new.git/') : path);
    else { res.writeHead(404); res.end('no such repo'); }
  };
}

test('baseFromRedirect is the suffix rule; redirectPolicy refuses anything outside 0..16', () => {
  const asked = `http://h/old.git${TAIL}`;
  const keep = (href, want) => assert.equal(baseFromRedirect(asked, new URL(href), SERVICE), want, href);
  keep(`http://h/new.git${TAIL}`, 'http://h/new.git');
  keep(`http://user:pass@h/new.git${TAIL}`, 'http://h/new.git');
  keep(`http://h/new.git/${TAIL}`, 'http://h/new.git');
  keep(`http://h/old.git/new.git${TAIL}`, 'http://h/old.git/new.git');
  assert.equal(baseFromRedirect(asked, new URL(`../new.git${TAIL}`, asked), SERVICE), 'http://h/old.git/new.git');
  for (const href of [
    `http://h/new.git/info/refs?service=git-receive-pack`,
    `http://h/new.git/info/refs`,
    `http://h/x${TAIL}&x=1`,
    `http://h/new.git${TAIL}#frag`,
    `http://h/info/refs?service=${SERVICE}/more`,
    `ftp://h/new.git${TAIL}`,
  ]) assert.equal(baseFromRedirect(asked, new URL(href), SERVICE), null, href);
  assert.equal(redirectPolicy(undefined, undefined).follow, 'never');
  assert.equal(redirectPolicy(undefined, undefined).max, DEFAULT_HOPS);
  assert.equal(redirectPolicy('initial', 0).max, 0);
  assert.equal(redirectPolicy('initial', 1).max, 1);
  assert.equal(redirectPolicy('never', HOP_CAP - 1).max, HOP_CAP - 1);
  assert.equal(redirectPolicy('initial', HOP_CAP).max, HOP_CAP);
  assert.throws(() => redirectPolicy('always', 0), e => e.code === 'bad_request' && e.message === `followRedirects must be 'never' or 'initial', got "always"`);
  assert.throws(() => redirectPolicy('', 0), e => e.message === `followRedirects must be 'never' or 'initial', got ""`);
  assert.throws(() => redirectPolicy(1, 0), e => e.message === `followRedirects must be 'never' or 'initial', got 1`);
  assert.throws(() => redirectPolicy(null, 0), e => e.message === `followRedirects must be 'never' or 'initial', got null`);
  assert.throws(() => redirectPolicy({}, 0), e => e.message === `followRedirects must be 'never' or 'initial', got object`);
  const capMsg = `maxRedirects must be an integer from 0 to ${HOP_CAP}`;
  for (const bad of [-1, 1.5, NaN, 2 ** 53, HOP_CAP + 1, 64, null, '3']) {
    assert.throws(() => createTransport('http://127.0.0.1:9/r.git', { followRedirects: 'never', maxRedirects: bad }), e => e.code === 'bad_request' && e.message === capMsg, `max ${String(bad)}`);
  }
  assert.throws(() => createTransport('http://127.0.0.1:9/r.git', { followRedirects: 'always' }), e => e.message === `followRedirects must be 'never' or 'initial', got "always"`);
});

test('git oracle: origin × auth × follow × kind', async () => {
  const stolen = await listen((req, res) => { stolen.hits.push(hit(req)); res.writeHead(200); res.end('stolen'); });
  stolen.hits = [];
  try {
    for (const origin of ORIGINS) for (const auth of AUTHS) for (const follow of FOLLOWS) for (const kind of KINDS) {
      if (kind === 'dotdot' && origin === 'cross') continue;
      const label = `${origin}/${auth ? 'auth' : 'anon'}/${follow}/${kind}`;
      gateHits.length = 0;
      gatePost = null;
      const hits = [];
      const cross = origin === 'cross';
      const front = await listen((req, res) => { hits.push(hit(req)); frontHandler(kind, 301, { cross, url: stolen.url, frontHost: front.host })(req, res); });
      try {
        const git = await gitLs(`${front.url}/old.git`, follow, auth);
        hits.length = 0; gateHits.length = 0;
        const ply = follow === 'off' && kind !== 'post'
          ? await (async () => { const c = plyClient(`${front.url}/old.git`, { follow, auth }); try { await c.discover(); return { ok: true, refs: null, url: c.url, error: null }; } catch (error) { return { ok: false, refs: null, url: c.url, error }; } })()
          : await plyLs(`${front.url}/old.git`, { follow, auth });
        const seen = hits.concat(kind === 'keep' && cross ? gateHits : []);
        const plyView = seen.map(h => ({ method: h.method, path: h.path, host: h.host, auth: h.auth !== null }));
        const gitView = clientView(git.reqs, front.host);
        if (kind === 'drop' && follow === 'initial') {
          assert.notEqual(git.status, 0, `${label}: git accepted a Location that drops the suffix`);
          assert.ok(git.reqs.some(r => r.path === '/new.git/info/refs' || r.path.startsWith('/new.git/info/refs')), `${label}: git did not request the bad Location (${git.reqs.map(r => r.path).join(' ')})`);
          assert.equal(ply.ok, false, label);
          assert.equal(ply.error.code, 'http', `${label}: ${ply.error?.code} ${ply.error?.message}`);
          assert.equal(ply.error.status, 301);
          assert.ok(!plyView.some(r => r.path.startsWith('/new.git')), `${label}: ply requested the bad Location`);
          assert.deepEqual(plyView.map(r => r.path), [`/old.git${TAIL}`], label);
        } else if (kind === 'post') {
          assert.notEqual(git.status, 0, `${label}: git followed a POST redirect`);
          assert.equal(ply.ok, false, label);
          assert.equal(ply.error.code, 'http');
          assert.equal(ply.error.status, 307);
          assert.equal(stolen.hits.length, 0, `${label}: the POST Location was requested`);
          assert.ok(!git.reqs.some(r => r.path.includes('stolen')), label);
          // ply's readers POST first. 'off' stays that way (no inserted GET); 'initial' does git's GET before the POST.
          const plyPaths = follow === 'off' ? [`POST /old.git/${SERVICE}`] : [`GET /old.git${TAIL}`, `POST /old.git/${SERVICE}`];
          assert.deepEqual(plyView.map(r => `${r.method} ${r.path}`), plyPaths, label);
          if (follow === 'initial') {
            assert.deepEqual(plyView, gitView, `${label}\ngit ${JSON.stringify(git.reqs)}\nply ${JSON.stringify(plyView)}`);
            assert.match(ply.error.message, new RegExp(`^HTTP 307 ${SERVICE}: redirected to ${stolen.url}/stolen.git/${SERVICE}; ply does not follow redirects`));
          }
        } else {
          assert.equal(ply.ok, git.status === 0, `${label}: ply ${ply.ok} (${ply.error?.code} ${ply.error?.message}) git ${git.status} ${git.stderr.split('\n').filter(l => /fatal:|error:|warning:/.test(l)).slice(-1)[0] ?? ''}`);
          assert.deepEqual(plyView, gitView, `${label}\ngit ${JSON.stringify(git.reqs)}\nply ${JSON.stringify(seen)}`);
          if (git.status === 0) {
            assert.deepEqual(plyLines(ply.refs), refLines(git.stdout), label);
            const reb = /redirecting to (\S+)/.exec(git.stderr);
            assert.ok(reb, `${label}: git printed no redirect`);
            assert.equal(ply.url, reb[1].replace(/\/$/, ''), label);
            if (cross && auth) {
              const post = git.reqs.find(r => r.method === 'POST');
              assert.equal(post.auth, true, `${label}: git did not reapply Authorization on the cross-origin POST`);
              assert.notEqual(post.host, front.host);
              assert.ok(plyView.some(r => r.host !== front.host && r.auth === false), label);
            }
          } else {
            assert.equal(ply.error.code, 'http', label);
            assert.equal(hits.length, 1, `${label}: a refused redirect still left the front`);
            assert.equal(gateHits.length, 0, label);
          }
        }
      } finally { await front.close(); }
    }
  } finally { await stolen.close(); }
});

test('git oracle: the 3xx boundary, and a Location that tries to install userinfo', async () => {
  const codes = [299, 300, 301, 398, 399, 400];
  for (const status of codes) {
    gateHits.length = 0;
    const hits = [];
    const front = await listen((req, res) => { hits.push(hit(req)); frontHandler('keep', status, { cross: false, url: '', frontHost: front.host })(req, res); });
    try {
      const git = await gitLs(`${front.url}/old.git`, 'initial', true);
      hits.length = 0;
      const ply = await plyLs(`${front.url}/old.git`, { follow: 'initial', auth: true });
      const plyView = hits.map(h => ({ method: h.method, path: h.path, host: h.host, auth: h.auth !== null }));
      // 299 and 400 are outside the 3xx range. git may fall through to dumb HTTP; ply must not follow them.
      if (status >= 300 && status < 400) {
        assert.equal(ply.ok, git.status === 0, `HTTP ${status}: ply ${ply.ok} ${ply.error?.message ?? ''} git ${git.status}`);
        assert.deepEqual(plyView, clientView(git.reqs, front.host), `HTTP ${status}`);
        if (git.status === 0) assert.deepEqual(plyLines(ply.refs), refLines(git.stdout), `HTTP ${status}`);
      } else {
        assert.equal(ply.ok, false, `HTTP ${status} was followed`);
        assert.ok(!String(ply.error.message).includes('redirected'), ply.error.message);
        assert.ok(!plyView.some(r => r.path.startsWith('/new.git')), `HTTP ${status}: ${JSON.stringify(plyView)}`);
      }
    } finally { await front.close(); }
  }
  const hits = [];
  const front = await listen((req, res) => { hits.push(hit(req)); frontHandler('userinfo', 301, { cross: false, url: '', frontHost: front.host })(req, res); });
  try {
    const git = await gitLs(`${front.url}/old.git`, 'initial', true);
    hits.length = 0;
    const ply = await plyLs(`${front.url}/old.git`, { follow: 'initial', auth: true });
    assert.equal(git.status, 0, git.stderr);
    assert.equal(ply.ok, true, ply.error?.message);
    assert.deepEqual(plyLines(ply.refs), refLines(git.stdout));
    assert.ok(hits.every(h => h.auth === null || h.auth === BASIC), JSON.stringify(hits));
    assert.ok(!hits.some(h => h.auth === EVIL || h.path.includes('evil') || h.path.includes('s3cret')));
    assert.equal(ply.url, `${front.url}/new.git`);
    const reb = /redirecting to (\S+)/.exec(git.stderr);
    assert.equal(ply.url, reb[1].replace(/\/$/, ''));
    assert.ok(!reb[1].includes('evil'), reb[1]);
  } finally { await front.close(); }
});

test('maxRedirects: 0, 1, default 3, 4, 15, 16 follow that many and refuse the next', async () => {
  // `redirects` 3xx responses, the last of them naming the git backend. maxRedirects `max` (undefined → the default).
  const redirectsOf = async (redirects, max) => {
    gateHits.length = 0;
    const hits = [];
    const front = await listen((req, res) => {
      hits.push(req.url.split('?')[0]);
      const m = /^\/r(\d+)\.git\/info\/refs/.exec(req.url);
      if (!m) { res.writeHead(404); res.end(req.url); return; }
      const i = Number(m[1]);
      if (i >= redirects) { proxy(req, res, srv.url, req.url.replace(/^\/r\d+\.git\//, '/new.git/')); return; }
      const loc = i + 1 === redirects ? `${gate.url}/new.git${TAIL}` : `/r${i + 1}.git${TAIL}`;
      res.writeHead(301, { location: loc }); res.end();
    });
    try {
      const spec = { follow: 'initial', auth: false };
      if (max !== undefined) spec.max = max;
      const ply = await plyLs(`${front.url}/r0.git`, spec);
      return { ply, hops: hits.length, gate: gateHits.length };
    } finally { await front.close(); }
  };
  const direct = await gitLs(`${gate.url}/new.git`, 'off', false);
  assert.equal(direct.status, 0, direct.stderr);
  gateHits.length = 0;
  const none = await plyLs(`${gate.url}/new.git`, { follow: 'initial', auth: false, max: 0 });
  assert.equal(none.ok, true, none.error?.message);
  assert.equal(none.url, `${gate.url}/new.git`);
  assert.deepEqual(plyLines(none.refs), refLines(direct.stdout));
  const blocked = await redirectsOf(1, 0);
  assert.equal(blocked.ply.ok, false, 'maxRedirects 0 followed a redirect');
  assert.equal(blocked.ply.error.status, 301);
  assert.equal(blocked.hops, 1);
  assert.equal(blocked.gate, 0);
  for (const n of [1, 2, DEFAULT_HOPS, DEFAULT_HOPS + 1, HOP_CAP - 1, HOP_CAP]) {
    const cap = n === DEFAULT_HOPS ? undefined : n;
    const followed = await redirectsOf(n, cap);
    assert.equal(followed.ply.ok, true, `follow ${n}: ${followed.ply.error?.message}`);
    assert.equal(followed.hops, n, `follow ${n}: front saw ${followed.hops}`);
    assert.ok(followed.gate >= 1, `follow ${n}: the final host saw nothing`);
    assert.deepEqual(plyLines(followed.ply.refs), refLines(direct.stdout), `follow ${n}`);
    assert.equal(followed.ply.url, `${gate.url}/new.git`);
    const refused = await redirectsOf(n + 1, cap);
    assert.equal(refused.ply.ok, false, `refuse after ${n}`);
    assert.equal(refused.ply.error.code, 'http');
    assert.equal(refused.ply.error.status, 301);
    assert.equal(refused.hops, n + 1, `refuse after ${n}: requested the refused hop's URL, or skipped one`);
    assert.equal(refused.gate, 0, `refuse after ${n}: the next Location was requested`);
  }
});

test('a two-hop chain matches git, and the span records the original base once', async () => {
  gateHits.length = 0;
  const hits = [];
  const front = await listen((req, res) => {
    hits.push(hit(req));
    if (req.url.startsWith('/old.git/info/refs')) { res.writeHead(301, { location: `/mid.git${TAIL}` }); res.end(); return; }
    if (req.url.startsWith('/mid.git/info/refs')) { res.writeHead(302, { location: `${gate.url}/new.git${TAIL}` }); res.end(); return; }
    proxy(req, res, srv.url, req.url);
  });
  try {
    const ex = arrayExporter();
    const git = await gitLs(`${front.url}/old.git`, 'initial', true);
    hits.length = 0; gateHits.length = 0;
    const c = plyClient(`${front.url}/old.git`, { follow: 'initial', auth: true, exporter: ex });
    const refs = await c.lsRefs();
    assert.equal(git.status, 0, git.stderr);
    assert.deepEqual(plyLines(refs.refs), refLines(git.stdout));
    const seen = hits.concat(gateHits).map(h => ({ method: h.method, path: h.path, host: h.host, auth: h.auth !== null }));
    assert.deepEqual(seen, clientView(git.reqs, front.host));
    assert.equal(c.url, `${gate.url}/new.git`);
    const span = ex.lines.flatMap(flattenLine).find(s => s.name === 'git.upload-pack ls-refs');
    assert.equal(span.attrs['http.redirect.count'], 2);
    assert.equal(span.attrs['git.remote.rebased_from'], `${front.url}/old.git`);
    gateHits.length = 0;
    hits.length = 0;
    await c.lsRefs();
    assert.deepEqual(hits, [], 'a settled transport advertised at the original host again');
    assert.deepEqual(gateHits.map(h => `${h.method} ${h.path.split('?')[0]}`), [`POST /new.git/${SERVICE}`]);
  } finally { await front.close(); }
});

test('discover then lsRefs advertises once; the default never follows and never inserts a GET', async () => {
  const hits = [];
  const front = await listen((req, res) => {
    hits.push(`${req.method} ${req.url.split('?')[0]}`);
    if (req.method === 'GET' && req.url.startsWith('/old.git/')) { res.writeHead(301, { location: `/new.git${TAIL}` }); res.end(); return; }
    proxy(req, res, srv.url, req.url.replace(/^\/(?:old|new)\.git\//, '/new.git/'));
  });
  try {
    const c = plyClient(`${front.url}/old.git`, { follow: 'initial', auth: false });
    await c.discover();
    const afterDiscover = hits.slice();
    await c.lsRefs();
    assert.deepEqual(afterDiscover, ['GET /old.git/info/refs', 'GET /new.git/info/refs']);
    assert.deepEqual(hits, [...afterDiscover, 'POST /new.git/git-upload-pack']);
    assert.equal(c.url, `${front.url}/new.git`);
    const plain = [];
    const once = await listen((req, res) => { plain.push(`${req.method} ${req.url}`); res.writeHead(301, { location: req.url.replace('/old.git/', '/new.git/') }); res.end(); });
    try {
      const err = await plyLs(`${once.url}/old.git`, { follow: 'off', auth: true });
      assert.equal(err.ok, false);
      assert.equal(err.error.message, `HTTP 301 ${SERVICE}: redirected to ${once.url}/new.git/${SERVICE}; ply does not follow redirects (update the remote URL)`);
      assert.equal(err.error.location, `${once.url}/new.git/${SERVICE}`);
      assert.deepEqual(plain, [`POST /old.git/${SERVICE}`]);
      const ex = arrayExporter();
      const d = plyClient(`${once.url}/old.git`, { follow: 'off', auth: false, exporter: ex });
      await d.discover().catch(() => {});
      const attrs = ex.lines.flatMap(flattenLine).flatMap(s => Object.keys(s.attrs));
      assert.ok(!attrs.includes('http.redirect.count') && !attrs.includes('git.remote.rebased_from'));
    } finally { await once.close(); }
  } finally { await front.close(); }
});

test('allowUrl sees the base and each Location; its URL is the one requested; a refusal is never fetched', async () => {
  assert.throws(() => createTransport(`${gate.url}/new.git`, { allowUrl: () => null }), e => e.code === 'bad_request' && e.message === 'allowUrl must return a Result');
  assert.throws(() => createTransport(`${gate.url}/new.git`, { allowUrl: () => ({ ok: true, value: 'http://h/r.git' }) }), e => e.message === 'allowUrl must return an http(s) URL');
  const moved = [];
  const quiet = await listen((req, res) => { moved.push(`fetch ${req.url}`); res.writeHead(500); res.end(); });
  try {
    gateHits.length = 0;
    const t = createTransport(`${quiet.url}/old.git`, {
      tracer: new Tracer(), auth: { token: TOK }, followRedirects: 'initial',
      allowUrl(url) { moved.push(`allow ${url.href}`); return ok(new URL(`${gate.url}/new.git`)); },
    });
    assert.equal(t.url, `${gate.url}/new.git`);
    const movedRefs = await lsRefs(t);
    assert.ok(movedRefs.refs.has('refs/heads/main'));
    assert.deepEqual(moved, [`allow ${quiet.url}/old.git`]);
    assert.ok(gateHits.length >= 2 && gateHits.every(h => h.auth === null), JSON.stringify(gateHits));
  } finally { await quiet.close(); }
  const calls = [];
  const hits = [];
  const front = await listen((req, res) => {
    hits.push({ path: req.url.split('?')[0], auth: req.headers.authorization ?? null });
    if (req.method === 'GET' && req.url.startsWith('/old.git/info/refs')) { res.writeHead(301, { location: `/new.git${TAIL}` }); res.end(); return; }
    proxy(req, res, srv.url, req.url.replace(/^\/renamed\.git\//, '/new.git/'));
  });
  try {
    const ply = await plyLs(`${front.url}/old.git`, {
      follow: 'initial', auth: true,
      allowUrl(url) {
        calls.push(url.href);
        if (url.pathname === '/new.git/info/refs') return ok(new URL(`${front.url}/renamed.git${TAIL}`));
        return ok(url);
      },
    });
    assert.equal(ply.ok, true, ply.error?.message);
    assert.equal(ply.url, `${front.url}/renamed.git`);
    assert.deepEqual(calls, [`${front.url}/old.git`, `${front.url}/new.git${TAIL}`]);
    assert.deepEqual(hits.map(h => h.path), ['/old.git/info/refs', '/renamed.git/info/refs', `/renamed.git/${SERVICE}`]);
    assert.ok(hits.every(h => h.auth === BASIC));
    calls.length = 0;
    hits.length = 0;
    const denied = await plyLs(`${front.url}/old.git`, {
      follow: 'initial', auth: true,
      allowUrl(url) { calls.push(url.pathname); return url.pathname.startsWith('/new.git') ? fail('auth', 'host denied') : ok(url); },
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'auth');
    assert.equal(denied.error.message, 'host denied');
    assert.deepEqual(hits.map(h => h.path), ['/old.git/info/refs']);
    hits.length = 0;
    const ftp = await plyLs(`${front.url}/old.git`, {
      follow: 'initial', auth: false,
      allowUrl(url) { return url.pathname.startsWith('/new.git') ? ok(new URL(`ftp://h/new.git${TAIL}`)) : ok(url); },
    });
    assert.equal(ftp.error.code, 'bad_request');
    assert.equal(ftp.error.message, 'allowUrl must return an http(s) URL');
    assert.deepEqual(hits.map(h => h.path), ['/old.git/info/refs']);
  } finally { await front.close(); }
});

test('a network failure before a response does not settle the initial exchange', async () => {
  let failed = false;
  const hits = [];
  const front = await listen((req, res) => {
    hits.push(`${req.method} ${req.url.split('?')[0]}`);
    if (req.method === 'GET' && req.url.startsWith('/old.git/')) { res.writeHead(301, { location: `/new.git${TAIL}` }); res.end(); return; }
    proxy(req, res, srv.url, req.url.replace(/^\/new\.git\//, '/new.git/'));
  });
  try {
    const fetchImpl = async (url, init) => {
      if (!failed) { failed = true; throw new TypeError('fetch failed'); }
      return fetch(url, init);
    };
    const c = plyClient(`${front.url}/old.git`, { follow: 'initial', auth: false, fetchImpl });
    const first = await c.lsRefs().catch(e => e);
    assert.equal(first.code, 'network');
    assert.deepEqual(hits, []);
    const refs = await c.lsRefs();
    assert.ok(refs.refs.has('refs/heads/main'));
    assert.deepEqual(hits, ['GET /old.git/info/refs', 'GET /new.git/info/refs', `POST /new.git/${SERVICE}`]);
    assert.equal(c.url, `${front.url}/new.git`);
  } finally { await front.close(); }
});
