// A pushPack whose caller's signal had already fired sent nothing, so its outcome is known. The counters are the
// test's own: pulls and cancels of the pack stream it built, requests seen by its server. None is a number ply reports.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTransport } from '../src/http.js';
import { ZERO_OID, push } from '../src/push.js';
import { pushPack } from '../src/receivecaps.js';
import { streamSource } from '../src/packwrite.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { unwrap } from './unwrap.js';

test('pushPack under an already-aborted signal: a definite aborted, no request, the pack never read, locked or cancelled', async () => {
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; req.resume(); res.end(); });
  await new Promise(r => { server.listen(0, '127.0.0.1', r); });
  try {
    const ac = new AbortController();
    ac.abort();
    const pack = { pulls: 0, cancels: 0 };
    const stream = new ReadableStream({ pull(c) { pack.pulls++; c.enqueue(new Uint8Array(1024)); c.close(); }, cancel() { pack.cancels++; } }, { highWaterMark: 0 });
    const t = unwrap(createTransport(`http://127.0.0.1:${server.address().port}/repo.git`, { signal: ac.signal }));
    const r = await pushPack(t, { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: 'a'.repeat(40), pack: stream, length: 1024 });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'aborted', `nothing was sent, so nothing is unknown: ${r.error.message}`);
    assert.deepEqual({ ...pack, locked: stream.locked, requests }, { pulls: 0, cancels: 0, locked: false, requests: 0 });
    // the pack is still the caller's: it can be read (or sent again) afterwards
    const first = await stream.getReader().read();
    assert.equal(first.value.length, 1024);
  } finally { server.close(); server.closeAllConnections(); }
});

// Decision table: a failure before the transport's first pull of the request body is definite; the same failure after
// one pull is 'ambiguous'. The repository is a real bare one served by git http-backend; "no ref moved" is git's own
// answer (for-each-ref before and after). Expected codes come from the fetch contract, not from ply: a rejected
// fetch() is a network error (a TypeError), an abort is the signal's AbortError.
const dnsError = () => new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND git.invalid'), { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'git.invalid' }) });
const refused = () => new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }) });
const isReceive = url => String(url).endsWith('/git-receive-pack');
// each row: how the POST fails, and the code the fetch contract gives that failure
const FAILURES = [
  ['a signal fired before the call', { preAbort: true, reject: null }, 'aborted'],
  ['fetch rejects before reading the body', { preAbort: false, reject: refused }, 'network'],
  ['a DNS failure (getaddrinfo ENOTFOUND)', { preAbort: false, reject: dnsError }, 'network'],
];

const gitServer = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ply-unsent-'));
  const repo = join(dir, 'repo.git');
  const git = (args, input = '') => execFileSync('git', args, { cwd: dir, encoding: 'utf8', input, env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000' } }).trim();
  git(['init', '-q', '--bare', repo]);
  git(['-C', repo, 'config', 'http.receivepack', 'true']);
  const blob = git(['-C', repo, 'hash-object', '-w', '--stdin'], 'x\n');
  const tree = git(['-C', repo, 'mktree'], `100644 blob ${blob}\tf\n`);
  const commit = git(['-C', repo, 'commit-tree', tree, '-m', 'base']);
  git(['-C', repo, 'update-ref', 'refs/heads/main', commit]);
  const server = http.createServer((req, res) => {
    const [path, query = ''] = req.url.split('?');
    const cgi = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: dir, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: req.method, PATH_INFO: path, QUERY_STRING: query, CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_USER: 'u', REMOTE_ADDR: '127.0.0.1' } });
    req.pipe(cgi.stdin);
    const out = [];
    cgi.stdout.on('data', d => out.push(d));
    cgi.on('close', () => {
      const all = Buffer.concat(out), cut = all.indexOf('\r\n\r\n');
      for (const h of all.subarray(0, cut).toString().split('\r\n')) {
        const k = h.indexOf(':');
        if (h.slice(0, k).toLowerCase() === 'status') res.statusCode = Number(h.slice(k + 1).trim().split(' ')[0]); else res.setHeader(h.slice(0, k), h.slice(k + 1).trim());
      }
      res.end(all.subarray(cut + 4));
    });
  });
  await new Promise(r => { server.listen(0, '127.0.0.1', r); });
  return { url: `http://127.0.0.1:${server.address().port}/repo.git`, commit, refs: () => git(['-C', repo, 'for-each-ref']), close: () => { server.close(); server.closeAllConnections(); rmSync(dir, { recursive: true, force: true }); } };
};

const packOf = () => {
  const seen = { pulls: 0, cancels: 0 };
  const stream = new ReadableStream({ pull(c) { seen.pulls++; c.enqueue(new Uint8Array(1024)); c.close(); }, cancel() { seen.cancels++; } }, { highWaterMark: 0 });
  return { seen, stream };
};

for (const [name, how, code] of FAILURES) {
  test(`pushPack, ${name}: before the first body pull it is the definite ${code}, the pack is never read, and git shows no ref moved`, async () => {
    const g = await gitServer();
    try {
      const before = g.refs();
      assert.match(before, new RegExp(`^${g.commit} commit\\trefs/heads/main$`, 'u'));
      const ac = new AbortController();
      if (how.preAbort) ac.abort();
      let posts = 0;
      const fetchImpl = async (url, init) => { if (isReceive(url) && how.reject !== null) { posts++; throw how.reject(); } return fetch(url, init); };
      const { seen, stream } = packOf();
      const t = unwrap(createTransport(g.url, { signal: ac.signal, fetchImpl }));
      const r = await pushPack(t, { ref: 'refs/heads/main', oldOid: g.commit, newOid: 'a'.repeat(40), pack: stream, length: 1024 });
      assert.equal(r.ok, false);
      assert.equal(r.error.code, code, r.error.message);
      assert.deepEqual({ ...seen, locked: stream.locked }, { pulls: 0, cancels: 0, locked: false });
      if (how.reject !== null) assert.equal(posts, 1, 'the POST was attempted once and not retried');
      assert.equal(g.refs(), before, 'git for-each-ref is unchanged');
      // the pack is still the caller's
      assert.equal((await stream.getReader().read()).value.length, 1024);
    } finally { g.close(); }
  });

  test(`pushPack, ${name}: after one body pull the same failure is ambiguous`, async () => {
    const g = await gitServer();
    try {
      const ac = new AbortController();
      let pulled = 0;
      // the transport takes one chunk of the body (the command list), then the same failure happens
      const fetchImpl = async (url, init) => {
        if (!isReceive(url)) return fetch(url, init);
        const first = await init.body.getReader().read();
        pulled += first.value.length;
        if (how.reject === null) { ac.abort(); throw ac.signal.reason; }
        throw how.reject();
      };
      const { stream } = packOf();
      const t = unwrap(createTransport(g.url, { signal: ac.signal, fetchImpl }));
      const r = await pushPack(t, { ref: 'refs/heads/main', oldOid: g.commit, newOid: 'a'.repeat(40), pack: stream, length: 1024 });
      assert.ok(pulled > 0, 'the double read the first chunk');
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'ambiguous', r.error.message);
    } finally { g.close(); }
  });
}

// push() with objects (the same rule, for the entry that writes the pack itself). 40 blobs of 60,000 random bytes do not
// deflate, so the pack is 2.4 MB and its request body is a stream; the double sees that for itself (init.body is a
// ReadableStream). Expected codes are the fetch contract's, as above; "no ref moved" is git's for-each-ref.
const blobs = () => Array.from({ length: 40 }, () => ({ type: 3, data: crypto.getRandomValues(new Uint8Array(60000)) }));
for (const [name, how, code] of FAILURES) {
  test(`push with a streamed pack, ${name}: before the first body pull it is the definite ${code}, and git shows no ref moved`, async () => {
    const g = await gitServer();
    try {
      const before = g.refs();
      const ac = new AbortController();
      if (how.preAbort) ac.abort();
      const seen = { posts: 0, streamed: 0 };
      const fetchImpl = async (url, init) => {
        if (!isReceive(url)) return fetch(url, init);
        seen.posts++;
        if (init.body instanceof ReadableStream) seen.streamed++;
        if (how.reject !== null) throw how.reject();
        return fetch(url, init);
      };
      const t = unwrap(createTransport(g.url, { signal: ac.signal, fetchImpl }));
      const r = await push(t, { ref: 'refs/heads/main', oldOid: g.commit, newOid: 'a'.repeat(40), objects: blobs() });
      assert.equal(r.ok, false);
      assert.equal(r.error.code, code, r.error.message);
      // a signal that had fired: no request is made; a rejected fetch: one POST with a stream body, not retried
      assert.deepEqual(seen, how.preAbort ? { posts: 0, streamed: 0 } : { posts: 1, streamed: 1 });
      assert.equal(g.refs(), before, 'git for-each-ref is unchanged');
    } finally { g.close(); }
  });

  test(`push with a streamed pack, ${name}: after one body pull the same failure is ambiguous`, async () => {
    const g = await gitServer();
    try {
      const ac = new AbortController();
      let pulled = 0;
      const fetchImpl = async (url, init) => {
        if (!isReceive(url)) return fetch(url, init);
        const first = await init.body.getReader().read();
        pulled += first.value.length;
        if (how.reject === null) { ac.abort(); throw ac.signal.reason; }
        throw how.reject();
      };
      const t = unwrap(createTransport(g.url, { signal: ac.signal, fetchImpl }));
      const r = await push(t, { ref: 'refs/heads/main', oldOid: g.commit, newOid: 'a'.repeat(40), objects: blobs() });
      assert.ok(pulled > 0, 'the double read the first chunk');
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'ambiguous', r.error.message);
      assert.equal(r.error.original, code);
    } finally { g.close(); }
  });
}

// A pack small enough to go as bytes: a signal that had fired before the request is still the definite 'aborted' with
// no request made. A fetch that rejects is not: bytes handed to fetch() cannot be seen leaving or not, so that stays
// 'ambiguous' (the near miss of the streamed rows above).
test('push with a pack sent as bytes: a signal already fired is the definite aborted with no request; a rejected fetch stays ambiguous', async () => {
  const g = await gitServer();
  try {
    const before = g.refs();
    const small = () => ({ ref: 'refs/heads/main', oldOid: g.commit, newOid: 'a'.repeat(40), objects: [{ type: 3, data: new TextEncoder().encode('hi\n') }] });
    const ac = new AbortController();
    ac.abort();
    let posts = 0;
    const counting = async (url, init) => { if (isReceive(url)) posts++; return fetch(url, init); };
    const fired = await push(unwrap(createTransport(g.url, { signal: ac.signal, fetchImpl: counting })), small());
    assert.deepEqual({ ok: fired.ok, code: fired.error.code, posts }, { ok: false, code: 'aborted', posts: 0 });

    const kinds = [];
    const rejecting = async (url, init) => { if (!isReceive(url)) return fetch(url, init); kinds.push(init.body instanceof ReadableStream ? 'stream' : 'bytes'); throw refused(); };
    const lost = await push(unwrap(createTransport(g.url, { fetchImpl: rejecting })), small());
    assert.deepEqual({ ok: lost.ok, code: lost.error.code, original: lost.error.original, kinds }, { ok: false, code: 'ambiguous', original: 'network', kinds: ['bytes'] });
    assert.equal(g.refs(), before, 'git for-each-ref is unchanged');
  } finally { g.close(); }
});

// The HTTP half of the same rule: an answer that arrives while the body is still unpulled. The server cannot have
// read a command list nobody handed over, so the answer's own code is the outcome and the pack is still the caller's.
// Expected codes are the status classes as HTTP defines them and README names them (401 auth, 404 not_found,
// 429 rate_limited, 5xx upstream_5xx, an unfollowed redirect http, a 200 that is not a receive-pack result not_git),
// written here by hand. The double answers without touching init.body; pulls and cancels are the test's own counters.
const ANSWERS = [
  ['401', () => new Response('no', { status: 401 }), 'auth'],
  ['404', () => new Response('no', { status: 404 }), 'not_found'],
  ['429', () => new Response('no', { status: 429 }), 'rate_limited'],
  ['500', () => new Response('no', { status: 500 }), 'upstream_5xx'],
  ['a 302 redirect', () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1:1/elsewhere/git-receive-pack' } }), 'http'],
  ['200 with content-type text/plain', () => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }), 'not_git'],
];
for (const [name, answer, code] of ANSWERS) {
  test(`pushPack, the POST answered ${name} with the body never pulled: the definite ${code}, the pack never read, locked or cancelled`, async () => {
    const g = await gitServer();
    try {
      const before = g.refs();
      let posts = 0;
      const fetchImpl = async (url, init) => { if (!isReceive(url)) return fetch(url, init); posts++; return answer(); };
      const { seen, stream } = packOf();
      const exporter = arrayExporter();
      const t = unwrap(createTransport(g.url, { fetchImpl, tracer: new Tracer({ exporter }) }));
      const r = await pushPack(t, { ref: 'refs/heads/main', oldOid: g.commit, newOid: 'a'.repeat(40), pack: stream, length: 1024 });
      assert.equal(r.ok, false);
      assert.equal(r.error.code, code, r.error.message);
      assert.deepEqual({ ...seen, locked: stream.locked, posts }, { pulls: 0, cancels: 0, locked: false, posts: 1 });
      assert.equal(g.refs(), before, 'git for-each-ref is unchanged');
      assert.equal((await stream.getReader().read()).value.length, 1024, 'the pack is still the caller\'s');
      // the span says no more than the error it carries: no attribute outside the documented ones
      const receive = exporter.lines.flatMap(flattenLine).filter(s => s.name === 'git.receive-pack');
      assert.equal(receive.length, 1);
      assert.equal('git.push.unsent' in receive[0].attrs, false);
    } finally { g.close(); }
  });

  test(`pushPack, the POST answered ${name} after one body pull: ambiguous, with ${code} as the original`, async () => {
    const g = await gitServer();
    try {
      let pulled = 0;
      const fetchImpl = async (url, init) => {
        if (!isReceive(url)) return fetch(url, init);
        const first = await init.body.getReader().read();
        pulled += first.value.length;
        return answer();
      };
      const { stream } = packOf();
      const t = unwrap(createTransport(g.url, { fetchImpl }));
      const r = await pushPack(t, { ref: 'refs/heads/main', oldOid: g.commit, newOid: 'a'.repeat(40), pack: stream, length: 1024 });
      assert.ok(pulled > 0, 'the double read the first chunk');
      assert.equal(r.ok, false);
      assert.deepEqual({ code: r.error.code, original: r.error.original }, { code: 'ambiguous', original: code });
    } finally { g.close(); }
  });
}

// The body itself: `pulled` turns true at the first pull and not before; a source given back is unlocked and uncancelled;
// a body given back and pulled after all errors without handing over the command list; after a pull giveBack does nothing.
test('streamSource: pulled() is the first pull; giveBack() before it unlocks the source and the body then sends nothing', async () => {
  const prefix = new TextEncoder().encode('0000');
  const a = packOf();
  const body = streamSource(a.stream, prefix, 1024, 4096);
  assert.deepEqual({ pulled: body.pulled(), locked: a.stream.locked }, { pulled: false, locked: true });
  body.giveBack();
  assert.deepEqual({ pulled: body.pulled(), locked: a.stream.locked, ...a.seen }, { pulled: false, locked: false, pulls: 0, cancels: 0 });
  const late = await body.stream.getReader().read().then(() => null, e => e);
  assert.equal(late.code, 'internal');
  assert.deepEqual({ pulled: body.pulled(), sent: body.sent(), ...a.seen }, { pulled: false, sent: 0, pulls: 0, cancels: 0 });

  const b = packOf();
  const sent = streamSource(b.stream, prefix, 1024, 4096);
  const first = await sent.stream.getReader().read();
  assert.deepEqual([...first.value], [...prefix]);
  assert.equal(sent.pulled(), true);
  sent.giveBack();
  assert.equal(b.stream.locked, true, 'a pulled body keeps its source: only release() ends it, by cancelling');
  await sent.release();
  assert.equal(b.seen.cancels, 1);
});
