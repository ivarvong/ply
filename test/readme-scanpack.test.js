// README contracts a consumer codes against (#301 items 2 and 6):
//   - the scanPack loop in the README, run as written: it sees every object of a pack git made, with git's sizes;
//   - the wire-span attribute sentence of the telemetry contract, checked on a GET, a POST and a failed exchange.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { scanPack, readCommit, Tracer, discover, lsRefs, push, createTransport } from '../src/index.js';
import { arrayExporter, flattenLine } from '../src/otel.js';
import { startGitServer, makeBareRepo, tmpRoot, commitFiles, git, gitBuf } from './server.js';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

function scanLoop() {
  const at = README.indexOf('<!-- scanpack-loop:');
  assert.ok(at >= 0, 'README has the scanpack-loop block');
  const m = /```js\n([\s\S]*?)```/.exec(README.slice(at));
  assert.ok(m);
  const body = m[1].replace(/^import \{ scanPack \} from 'ply';\n/m, '') + '\nreturn sizes;';
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  return new AsyncFunction('scanPack', 'pack', body);
}

test('README scanPack loop sees every object of a git-made pack, at the size git reports', async () => {
  const { root, cleanup } = tmpRoot();
  try {
    const bare = makeBareRepo(root, 'p'); const work = join(root, 'w'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
    commitFiles(work, bare, { 'a.txt': 'alpha\n', 'dir/b.txt': 'b'.repeat(70000), 'c.bin': '\u0000\u0001\u0002' }, 'seed');
    // no deltas (window 0): each object's inflated bytes are the object itself, so git's object size is the expected count
    const pack = new Uint8Array(gitBuf(bare, ['pack-objects', '--all', '--stdout', '--window=0', '-q'], ''));
    const expected = git(bare, ['cat-file', '--batch-all-objects', '--batch-check=%(objectsize)']).trim().split('\n').map(Number).sort((a, b) => a - b);
    const sizes = await scanLoop()(scanPack, (async function* () { yield pack; })());
    assert.deepEqual([...sizes].sort((a, b) => a - b), expected);
  } finally { cleanup(); }
});

test('README wire-span attributes: GET has no request bytes, POST has them, a failed exchange has no response bytes', async () => {
  const { root, cleanup } = tmpRoot(); const srv = await startGitServer(root);
  try {
    const bare = makeBareRepo(root, 'r'); const work = join(root, 'w'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
    commitFiles(work, bare, { 'a.txt': 'a\n' }, 'seed');
    const ex = arrayExporter();
    const good = await readCommit(`${srv.url}/r.git`, { ref: 'main' }, { tracer: new Tracer({ exporter: ex }) });
    assert.ok(good.ok);
    const bad = await readCommit(`${srv.url}/missing.git`, { ref: 'main' }, { tracer: new Tracer({ exporter: ex }) });
    assert.equal(bad.ok, false);
    const wire = ex.lines.flatMap(flattenLine).filter(s => /^git\.(upload-pack|receive-pack)/.test(s.name));
    assert.ok(wire.length > 0);
    let failed = 0;
    for (const s of wire) {
      for (const k of ['git.transport', 'server.address']) assert.ok(k in s.attrs, `${s.name} lacks ${k}`);
      if (s.attrs['http.request.method'] === 'POST') assert.equal(typeof s.attrs['git.request.bytes'], 'number', `${s.name}: POST carries git.request.bytes`);
      else assert.ok(!('git.request.bytes' in s.attrs), `${s.name}: a GET sends no body`);
      const status = s.attrs['http.response.status_code'];
      if (typeof status === 'number' && status >= 400) { failed++; assert.ok(!('git.response.bytes' in s.attrs), `${s.name}: HTTP ${status} read no body`); }
      else assert.equal(typeof s.attrs['git.response.bytes'], 'number', `${s.name}: a completed exchange carries git.response.bytes`);
    }
    assert.ok(failed > 0, 'the missing repository produced a failed exchange span');
  } finally { await srv.close(); cleanup(); }
});

// discover() is a lone GET: README says a GET carries no git.request.bytes, and git.response.bytes only once its body
// was read whole (the 200; never the 404). Expected byte count: git's own advertisement, measured with curl-free fetch.
test('README wire-span attributes on discover(): GET 200 has response bytes and no request bytes, GET 404 has neither', async () => {
  const { root, cleanup } = tmpRoot(); const srv = await startGitServer(root);
  try {
    const bare = makeBareRepo(root, 'r'); const work = join(root, 'w'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
    commitFiles(work, bare, { 'a.txt': 'a\n' }, 'seed');
    const raw = await fetch(`${srv.url}/r.git/info/refs?service=git-upload-pack`, { headers: { 'git-protocol': 'version=2' } });
    const want = (await raw.arrayBuffer()).byteLength;
    for (const [repo, okWant] of [['r', true], ['missing', false]]) {
      const ex = arrayExporter(); const tracer = new Tracer({ exporter: ex });
      const t = createTransport(`${srv.url}/${repo}.git`, { tracer });
      assert.ok(t.ok);
      const r = await discover(t.value);
      assert.equal(r.ok, okWant);
      const [s] = ex.lines.flatMap(flattenLine).filter(x => x.name === 'git.upload-pack discover');
      assert.ok(s, 'discover span');
      assert.equal(s.attrs['http.request.method'], 'GET');
      assert.ok(!('git.request.bytes' in s.attrs), `${repo}: a GET sends no body`);
      if (okWant) assert.equal(s.attrs['git.response.bytes'], want);
      else assert.ok(!('git.response.bytes' in s.attrs), `${repo}: a 404 read no body`);
    }
  } finally { await srv.close(); cleanup(); }
});

// followRedirects 'initial': the first POST makes its GET on the POST's own span. README: the GET sets git.response.bytes
// there, and a POST that then fails (500) read no body of its own, so the span keeps the GET's count (the fake server's
// advertisement length), not the POST's.
test('README wire-span attributes: pre-GET then a failed POST keeps the GET\'s git.response.bytes', async () => {
  const ad = new TextEncoder().encode('000eversion 2\n0013ls-refs=unborn\n0011fetch=shallow\n0000');
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/info/refs')) return new Response(ad, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
    await new Response(init.body).arrayBuffer();
    return new Response('boom', { status: 500, headers: { 'content-type': 'text/plain' } });
  };
  const ex = arrayExporter(); const tracer = new Tracer({ exporter: ex });
  const t = createTransport('https://example.invalid/r.git', { fetchImpl, followRedirects: 'initial', tracer });
  assert.ok(t.ok, JSON.stringify(t.error));
  const r = await lsRefs(t.value, ['refs/heads/']);
  assert.equal(r.ok, false);
  const [s] = ex.lines.flatMap(flattenLine).filter(x => x.name === 'git.upload-pack ls-refs');
  assert.ok(s, 'ls-refs span');
  assert.equal(s.attrs['http.request.method'], 'POST');
  assert.equal(s.attrs['http.response.status_code'], 500);
  assert.equal(typeof s.attrs['git.request.bytes'], 'number');
  assert.equal(s.attrs['git.response.bytes'], ad.length, 'the pre-GET body, as the fake server sent it');
  assert.equal(s.attrs['http.response.body.size'], ad.length);
});

// A GET made on a POST's own span after the POST was answered (ls-refs' empty answer asks the advertisement why; a push
// refused at its status line asks receive-pack's advertisement whether the refusal stands). README: that GET, read
// whole, sets git.response.bytes to the advertisement's length and leaves its own method and status on the span.
// Expected values come from the fake server's own bytes (the advertisement's length).
const UPLOAD_AD = new TextEncoder().encode('000eversion 2\n0013ls-refs=unborn\n0011fetch=shallow\n0000');
const RECEIVE_AD = new TextEncoder().encode('003f0000000000000000000000000000000000000000 capabilities^{}\0report-status\n0000');
const wireSpan = (ex, name) => ex.lines.flatMap(flattenLine).find(x => x.name === name);

test('README wire-span attributes: ls-refs empty 200 answer, then its advertisement GET on the same span', async () => {
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/info/refs')) return new Response(UPLOAD_AD, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
    await new Response(init.body).arrayBuffer();
    return new Response(new Uint8Array(0), { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' } });
  };
  const ex = arrayExporter();
  const t = createTransport('https://example.invalid/r.git', { fetchImpl, tracer: new Tracer({ exporter: ex }) });
  assert.ok(t.ok);
  const r = await lsRefs(t.value, ['refs/heads/']);
  assert.equal(r.ok, false);
  const s = wireSpan(ex, 'git.upload-pack ls-refs');
  assert.ok(s, 'ls-refs span');
  assert.equal(s.attrs['http.request.method'], 'GET', 'the GET after the answer leaves its method');
  assert.equal(s.attrs['http.response.status_code'], 200);
  assert.equal(typeof s.attrs['git.request.bytes'], 'number', 'the POST set it before it was sent');
  assert.equal(s.attrs['git.response.bytes'], UPLOAD_AD.length, 'the GET read its advertisement whole');
});

test('README wire-span attributes: receive-pack POST refused 403, then a 200 advertisement GET on the same span sets its bytes', async () => {
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/info/refs')) return new Response(RECEIVE_AD, { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-advertisement' } });
    await new Response(init.body).arrayBuffer();
    return new Response('forbidden', { status: 403, headers: { 'content-type': 'text/plain' } });
  };
  const ex = arrayExporter();
  const t = createTransport('https://example.invalid/r.git', { fetchImpl, tracer: new Tracer({ exporter: ex }) });
  assert.ok(t.ok);
  const r = await push(t.value, { ref: 'refs/heads/main', oldOid: '0'.repeat(40), newOid: '1'.repeat(40), objects: [] });
  assert.equal(r.ok, false);
  const s = wireSpan(ex, 'git.receive-pack');
  assert.ok(s, `receive-pack span among ${ex.lines.flatMap(flattenLine).map(x => x.name)}`);
  assert.equal(s.attrs['http.request.method'], 'GET', 'the GET after the refusal leaves its method');
  assert.equal(s.attrs['http.response.status_code'], 200);
  assert.equal(typeof s.attrs['git.request.bytes'], 'number', 'the POST set it before it was sent');
  assert.equal(s.attrs['git.response.bytes'], RECEIVE_AD.length, 'the GET read its advertisement whole');
});

// A stale redirect memo: the remembered base answers the POST with a 3xx, so ply drops the memo, re-settles with a GET
// on the POST's own span and re-sends the POST. README: the span then ends with the GET's `http.request.method`
// (`GET`) and the re-sent POST's status, request bytes and response bytes. Expected values: the bytes the fake server
// received in the re-sent POST, and the length of the answer it sent (a ref pkt plus a flush, hand-counted 61 + 4).
test('README wire-span attributes: a stale redirect memo re-send ends its span with method GET and the POST\'s bytes', async () => {
  const OID = 'a'.repeat(40);
  const answer = new TextEncoder().encode(`003d${OID} refs/heads/main\n0000`);
  assert.equal(answer.length, 65);
  const host = 'https://stale-memo.example.invalid';
  const hits = []; let staleSent = -1; let memoSettled = false;
  const fetchImpl = async (url, init) => {
    const u = String(url); const method = init?.method ?? 'GET';
    hits.push(`${method} ${new URL(u).pathname}`);
    if (u.includes('/old.git/info/refs')) {
      if (!memoSettled) return new Response(null, { status: 301, headers: { location: `${host}/a.git/info/refs?service=git-upload-pack` } });
      return new Response(UPLOAD_AD, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
    }
    if (u.includes('/a.git/info/refs')) return new Response(UPLOAD_AD, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
    const sent = (await new Response(init.body).arrayBuffer()).byteLength;
    if (u.includes('/a.git/') && memoSettled) return new Response(null, { status: 301, headers: { location: `${host}/b.git/git-upload-pack` } });
    staleSent = sent;
    return new Response(answer, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' } });
  };
  const first = createTransport(`${host}/old.git`, { fetchImpl, followRedirects: 'initial' });
  assert.ok(first.ok);
  assert.ok((await lsRefs(first.value, ['refs/heads/'])).ok, 'first transport settles old.git -> a.git');
  memoSettled = true; hits.length = 0; staleSent = -1;
  const ex = arrayExporter();
  const t = createTransport(`${host}/old.git`, { fetchImpl, followRedirects: 'initial', tracer: new Tracer({ exporter: ex }) });
  assert.ok(t.ok);
  const r = await lsRefs(t.value, ['refs/heads/']);
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.deepEqual(hits, ['POST /a.git/git-upload-pack', 'GET /old.git/info/refs', 'POST /old.git/git-upload-pack']);
  const s = wireSpan(ex, 'git.upload-pack ls-refs');
  assert.ok(s, 'ls-refs span');
  assert.equal(s.attrs['http.request.method'], 'GET', 'the re-settling GET leaves its method');
  assert.equal(s.attrs['http.response.status_code'], 200);
  assert.equal(s.attrs['git.request.bytes'], staleSent, 'the re-sent POST body, as the server received it');
  assert.equal(s.attrs['git.response.bytes'], answer.length, 'the re-sent POST read its answer whole');
  // and README says so, in the telemetry bullet
  const bullet = README.split('\n').find(l => l.startsWith('- On the HTTP transport (`createTransport`)'));
  assert.ok(bullet, 'README telemetry bullet');
  assert.match(bullet, /stale redirect memo[^.]*ends with `http\.request\.method` \(`GET`/);
});
