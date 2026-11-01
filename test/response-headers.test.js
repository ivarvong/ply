// recordResponseHeaders (#123). Not a git-semantics change: a real git http-backend, with the response headers
// stamped by the fetch the transport calls. Each cell is one exchange (discover, ls-refs, fetch), the tree:0 refusal
// and its blob:none retry, a credential echoed in a header, and a pack-cache HIT of the same wants-only fetch.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { git, tmpRoot, makeBareRepo, startGitServer } from './server.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { createTransport } from '../src/http.js';
import { discover } from '../src/discover.js';
import { lsRefs } from '../src/lsrefs.js';
import { fetchPack, fetchPackTree0 } from '../src/fetchpack.js';
import { cachingFetch, memoryCache } from '../src/packcache.js';
import { td } from '../src/bytes.js';

const KEY = /^(git|http|url|server|mem|error|ply|exception)\.[a-z0-9_.-]+$/;
const CAP = 128;
let root, cleanup, srv, n = 0;
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv?.close(); cleanup?.(); });

const seeded = () => {
  const name = `h${n++}`;
  const bare = makeBareRepo(root, name);
  const work = join(root, `w${name}`);
  mkdirSync(work);
  git(work, ['init', '-q', '-b', 'main']);
  writeFileSync(join(work, 'a.txt'), 'a\n');
  const g = ['-c', 'user.name=h', '-c', 'user.email=h@x', '-c', 'commit.gpgsign=false'];
  git(work, ['add', 'a.txt']);
  git(work, [...g, 'commit', '-q', '-m', 'seed']);
  git(work, ['push', '-q', bare, 'HEAD:refs/heads/main']);
  return { url: `${srv.url}/${name}.git`, oid: git(work, ['rev-parse', 'HEAD']).trim() };
};

const spansOf = ex => ex.lines.flatMap(flattenLine);
const traced = () => { const ex = arrayExporter(); return { tracer: new Tracer({ exporter: ex }), spans: () => spansOf(ex) }; };

test('each exchange span records the headers that response carried, and no others', async () => {
  const r = seeded();
  let i = 0;
  const hint = [];
  const fetchImpl = async (url, init) => {
    hint.push(new Headers(init.headers).get('x-ply-record-headers'));
    const res = await fetch(url, init);
    i += 1;
    const headers = new Headers(res.headers);
    headers.set('cf-ray', `ray-${i}`);
    headers.set('x-github-request-id', `gh-${i}`);
    headers.set('x-request-id', `not-listed-${i}`);
    return new Response(res.body, { status: res.status, headers });
  };
  const { tracer, spans } = traced();
  const t = createTransport(r.url, { tracer, fetchImpl, recordResponseHeaders: ['CF-Ray', 'cf-ray', 'X-GitHub-Request-Id', 'x-missing'] });
  await discover(t);
  const { refs } = await lsRefs(t, ['refs/heads/main']);
  assert.equal(refs.get('refs/heads/main').oid, r.oid);
  await fetchPack(t, { wants: [r.oid], filter: 'blob:none', deepen: 1 });
  const want = ['git.upload-pack discover', 'git.upload-pack ls-refs', 'git.upload-pack fetch'];
  const got = spans().filter(s => want.includes(s.name));
  assert.deepEqual(got.map(s => s.name), want);
  got.forEach((s, k) => {
    assert.equal(s.attrs['http.response.header.cf-ray'], `ray-${k + 1}`, s.name);
    assert.equal(s.attrs['http.response.header.x-github-request-id'], `gh-${k + 1}`, s.name);
    assert.equal(s.attrs['http.response.header.x-request-id'], undefined, 'a header not in the list is not recorded');
    assert.equal(s.attrs['http.response.header.x-missing'], undefined, 'a listed header the response omitted is absent');
    assert.equal(s.attrs['http.response.header.CF-Ray'], undefined, 'the key is the lowercased name');
    assert.equal(s.attrs['http.response.headers.from_cache'], undefined, 'a live response is not a cache hit');
    assert.equal(typeof s.attrs['http.response.status_code'], 'number');
    assert.equal(typeof s.attrs['http.response.ttfb_ms'], 'number');
    for (const key of Object.keys(s.attrs)) assert.match(key, KEY, key);
  });
  assert.deepEqual(hint, [null, null, null], 'a non-caching fetch is not sent the record hint');
});

test('a tree:0 refusal and the blob:none retry keep the ray of the response each one received', async () => {
  const r = seeded();
  const fetchImpl = async (url, init) => {
    const body = init.body instanceof Uint8Array ? td.decode(init.body) : '';
    if (String(url).endsWith('/git-upload-pack') && body.includes('filter tree:0')) {
      return new Response('Unsupported Git fetch filter; only blob:none is supported.', {
        status: 400, headers: { 'content-type': 'text/plain', 'cf-ray': 'ray-refused' },
      });
    }
    const res = await fetch(url, init);
    const headers = new Headers(res.headers);
    headers.set('cf-ray', 'ray-wide');
    return new Response(res.body, { status: res.status, headers });
  };
  const { tracer, spans } = traced();
  const t = createTransport(r.url, { tracer, fetchImpl, recordResponseHeaders: ['cf-ray'], quirks: {} });
  const res = await fetchPackTree0(t, { wants: [r.oid], filter: 'tree:0', deepen: 1 });
  assert.equal(res.filter, 'blob:none');
  const fetches = spans().filter(s => s.name === 'git.upload-pack fetch');
  assert.equal(fetches.length, 2);
  assert.equal(fetches[0].attrs['http.response.header.cf-ray'], 'ray-refused');
  assert.equal(fetches[0].attrs['git.fetch.filter.fallback'], undefined);
  assert.equal(fetches[1].attrs['http.response.header.cf-ray'], 'ray-wide');
  assert.equal(fetches[1].attrs['git.fetch.filter.fallback'], 'blob:none');
});

test('a recorded value is scrubbed, then capped at 128, on the span that received it', async () => {
  const token = `ghp_${'a1'.repeat(20)}`;
  const hint = [];
  const fetchImpl = async (_url, init) => {
    hint.push(new Headers(init.headers).get('x-ply-record-headers'));
    return new Response(Uint8Array.of(0), {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-advertisement', 'cf-ray': `${token}-${'z'.repeat(200)}` },
    });
  };
  const { tracer, spans } = traced();
  const span = tracer.start('contract.harness');
  const t = createTransport('http://127.0.0.1/r.git', { tracer, parent: span, auth: { bearer: token }, fetchImpl, recordResponseHeaders: ['cf-ray'] });
  assert.equal((await t.advertise('git-upload-pack', span)).length, 1);
  span.end();
  const ray = spans().find(s => s.name === 'contract.harness').attrs['http.response.header.cf-ray'];
  assert.equal(ray.length, CAP);
  assert.equal(ray.startsWith('[redacted]'), true);
  assert.equal(ray.includes(token), false);
  assert.equal(ray.includes('ghp_'), false);
  assert.deepEqual(hint, [null]);
});

test('a recorded value is kept at 0, 1, cap-1 and cap, and cut at cap+1 and beyond', async () => {
  for (const n of [0, 1, CAP - 1, CAP, CAP + 1, CAP * 8]) {
    const raw = 'v'.repeat(n);
    const fetchImpl = async () => new Response(Uint8Array.of(0), {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-advertisement', 'cf-ray': raw },
    });
    const { tracer, spans } = traced();
    const span = tracer.start('contract.harness');
    const t = createTransport('http://127.0.0.1/r.git', { tracer, parent: span, fetchImpl, recordResponseHeaders: ['cf-ray'] });
    await t.advertise('git-upload-pack', span);
    span.end();
    const ray = spans().find(s => s.name === 'contract.harness').attrs['http.response.header.cf-ray'];
    assert.equal(ray, raw.slice(0, CAP), `value length ${n}`);
  }
});

test('a pack-cache HIT replays the stored ray and is marked from_cache; the origin never sees the hint', async () => {
  const r = seeded();
  const cache = memoryCache();
  const hint = [];
  const origin = async (url, init) => {
    hint.push(new Headers(init.headers).get('x-ply-record-headers'));
    const res = await fetch(url, init);
    const headers = new Headers(res.headers);
    headers.set('cf-ray', 'origin-ray');
    headers.set('x-github-request-id', 'gh-origin');
    return new Response(res.body, { status: res.status, headers });
  };
  const pending = [];
  const fetchImpl = cachingFetch(origin, cache, { waitUntil: p => { pending.push(p); } });
  const { tracer, spans } = traced();
  const t = createTransport(r.url, { tracer, fetchImpl, recordResponseHeaders: ['cf-ray', 'x-github-request-id'] });
  const want = { wants: [r.oid], filter: 'blob:none', deepen: 1 };
  await fetchPack(t, want);
  await Promise.all(pending);
  await fetchPack(t, want);
  const fetches = spans().filter(s => s.name === 'git.upload-pack fetch');
  assert.equal(fetches.length, 2);
  assert.equal(fetches[0].attrs['git.response.cache'], 'MISS');
  assert.equal(fetches[0].attrs['http.response.header.cf-ray'], 'origin-ray');
  assert.equal(fetches[0].attrs['http.response.header.x-github-request-id'], 'gh-origin');
  assert.equal(fetches[0].attrs['http.response.headers.from_cache'], undefined);
  assert.equal(fetches[1].attrs['git.response.cache'], 'HIT');
  assert.equal(fetches[1].attrs['http.response.header.cf-ray'], 'origin-ray');
  assert.equal(fetches[1].attrs['http.response.header.x-github-request-id'], 'gh-origin');
  assert.equal(fetches[1].attrs['http.response.headers.from_cache'], true);
  assert.deepEqual(hint, [null]);
  const stored = [...cache.entries.values()];
  assert.equal(stored.length, 1);
  assert.equal(stored[0].headers['cf-ray'], 'origin-ray');
  assert.equal(stored[0].headers['x-github-request-id'], 'gh-origin');
  assert.equal(stored[0].headers['x-ply-record-headers'], undefined);
});
