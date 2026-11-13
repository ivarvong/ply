// README contracts a consumer codes against (#301 items 2 and 6):
//   - the scanPack loop in the README, run as written: it sees every object of a pack git made, with git's sizes;
//   - the wire-span attribute sentence of the telemetry contract, checked on a GET, a POST and a failed exchange.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { scanPack, readCommit, Tracer, discover, lsRefs, createTransport } from '../src/index.js';
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

// followRedirects 'initial': the first POST makes its GET on the POST's own span. A POST that then fails (500) read no
// POST body, so README's "a non-2xx exchange carries no git.response.bytes" must hold on that span too.
test('README wire-span attributes: pre-GET then a failed POST carries no git.response.bytes', async () => {
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
  assert.ok(!('git.response.bytes' in s.attrs), `a 500 POST read no body, got ${s.attrs['git.response.bytes']}`);
});
