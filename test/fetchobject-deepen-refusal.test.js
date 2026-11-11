// "Without the capability ply behaves as on main", for every refusal shape. fetchObject adds `deepen 1` to a want that
// may be a commit. A server whose fetch= line lists no `shallow` may refuse that argument with an ERR pkt-line or with
// HTTP 400 (not only with an empty body: test/fetchobject-deepen.test.js). ply then reads the advertisement once per
// quirks record and asks again without `deepen`: the request main sends, so the answer is main's.
// The oracle is git: N commits in a line served by git http-backend; the proxy in front of it strips `shallow` from the
// advertisement and refuses any request that carries `deepen`. Expected values are hand-derived from git's rules and
// counted by git verify-pack: with no depth a commit want is answered with every commit reachable from it, so
//   filter tree:0     N commits (trees and blobs dropped)
//   filter blob:none  N commits + N root trees (every commit changes f.txt: N distinct trees of one entry)
//   no filter         N commits + N trees + N blobs
// and the object returned is `git cat-file commit <tip>`.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer } from './server.js';
import { fetchObject } from '../src/fetch.js';
import { createTransport } from '../src/http.js';
import { TYPE } from '../src/objects.js';
import { unwrap } from './unwrap.js';

const N = 24;
let root, cleanup, srv, bare, url, tip, k = 0;

before(async () => {
  ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root);
  bare = makeBareRepo(root, 'hist'); url = `${srv.url}/hist.git`;
  let stream = '';
  for (let i = 1; i <= N; i++) {
    const msg = `c${i}\n`, body = `line ${i}\n`;
    stream += `commit refs/heads/main\nmark :${i}\ncommitter Ada <ada@x> ${1_700_000_000 + i} +0000\ndata ${msg.length}\n${msg}${i > 1 ? `from :${i - 1}\n` : ''}M 100644 inline f.txt\ndata ${body.length}\n${body}\n`;
  }
  gitBuf(bare, ['fast-import', '--quiet'], Buffer.from(stream));
  tip = git(bare, ['rev-parse', 'main']).trim();
  assert.equal(Number(git(bare, ['rev-list', '--count', 'main']).trim()), N);
});
after(async () => { await srv.close(); cleanup(); });

// A transport whose every exchange is kept; `rewrite` may answer in the server's place.
function recording(rewrite, quirks = { treeFilter: 'tree:0', blobWants: 'many' }) {
  const log = [];
  const fetchImpl = async (input, init = {}) => {
    const body = init.body === undefined || init.body === null ? '' : Buffer.from(await new Response(init.body).arrayBuffer()).toString('latin1');
    const method = init.method ?? 'GET';
    const faked = await rewrite({ url: String(input), method, body });
    const res = faked ?? await fetch(input, { ...init, body: body === '' ? undefined : Buffer.from(body, 'latin1') });
    const bytes = Buffer.from(await res.arrayBuffer());
    log.push({ method, body, bytes, status: res.status });
    return new Response(bytes, { status: res.status, headers: res.headers });
  };
  const t = unwrap(createTransport(url, { fetchImpl, quirks }));
  return { t, log };
}
const deepenOf = body => { const m = /(?:^|\n)[0-9a-f]{4}deepen (\d+)\n/.exec(body); return m ? Number(m[1]) : null; };
const filterOf = body => { const m = /(?:^|\n)[0-9a-f]{4}filter ([^\n]+)\n/.exec(body); return m ? m[1] : null; };
const shape = log => log.map(x => `${x.method} ${deepenOf(x.body)}`);
// The band-1 bytes of a fetch response (the pack), counted by git.
function counted(bytes) {
  const parts = [];
  let i = 0, inPack = false;
  while (i + 4 <= bytes.length) {
    const len = parseInt(bytes.subarray(i, i + 4).toString('latin1'), 16);
    if (len < 4) { i += 4; continue; }
    const payload = bytes.subarray(i + 4, i + len); i += len;
    if (inPack) { if (payload[0] === 1) parts.push(payload.subarray(1)); continue; }
    if (payload.toString('latin1').trimEnd() === 'packfile') inPack = true;
  }
  const dir = join(root, `count${k++}`); mkdirSync(dir); git(dir, ['init', '-q', '--bare', '.']);
  const file = join(dir, 'x.pack'); writeFileSync(file, Buffer.concat(parts));
  git(dir, ['index-pack', file]);
  const by = { commit: 0, tree: 0, blob: 0, tag: 0 };
  for (const l of git(dir, ['verify-pack', '-v', join(dir, 'x.idx')]).split('\n')) { const m = /^[0-9a-f]{40} (commit|tree|blob|tag) /.exec(l); if (m) by[m[1]]++; }
  return by;
}
const raw = () => new Uint8Array(gitBuf(bare, ['cat-file', 'commit', tip]));

// The advertisement with features taken off its fetch= line: a server that does not implement them.
const strip = async (u, drop) => {
  const res = await fetch(u, { headers: { 'git-protocol': 'version=2' } });
  const text = Buffer.from(await res.arrayBuffer()).toString('latin1');
  const m = /[0-9a-f]{4}fetch=([^\n]*)\n/.exec(text);
  for (const f of drop) assert.ok(m && m[1].split(' ').includes(f), `git advertises ${f}`);
  const line = `fetch=${m[1].split(' ').filter(f => !drop.includes(f)).join(' ')}\n`;
  return new Response(Buffer.from(text.replace(m[0], `${(line.length + 4).toString(16).padStart(4, '0')}${line}`), 'latin1'), { status: res.status, headers: res.headers });
};
// oxlint-disable-next-line typescript/promise-function-async -- strip's promise, passed through
const stripShallow = u => strip(u, ['shallow']);
const pkt = s => { const b = Buffer.from(s, 'latin1'); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0'), 'latin1'), b]); };
// How a request that carries `deepen` is refused. ERR: a pkt-line, HTTP 200 (git's own way to refuse an argument it
// parses and rejects). A status: the body a non-git server gives (Artifacts refuses a filter it does not take with 400).
const REFUSALS = {
  err: () => new Response(pkt('ERR unknown argument deepen 1\n'), { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' } }),
  400: () => new Response('bad argument', { status: 400 }),
  401: () => new Response('no', { status: 401 }),
  403: () => new Response('no', { status: 403 }),
  404: () => new Response('no', { status: 404 }),
  429: () => new Response('slow down', { status: 429 }),
  500: () => new Response('broken', { status: 500 }),
};
// `lists`: whether the advertisement still lists `shallow` (a server that takes it and fails for another reason).
const refusing = (how, lists = false) => async ({ url: u, method, body }) => {
  if (method === 'POST' && /deepen /.test(body)) return REFUSALS[how]();
  return method === 'GET' && !lists ? stripShallow(u) : null;
};

// The three paths of objectAt, as [name, quirks.treeFilter, the caller's filter (undefined: the default tree:0), the
// filter on the wire, the pack main's request is answered with].
const PATHS = [
  ['tree:0 single', 'tree:0', undefined, 'tree:0', { commit: N, tree: 0, blob: 0, tag: 0 }],
  ['wide blob:none', 'blob:none', undefined, 'blob:none', { commit: N, tree: N, blob: 0, tag: 0 }],
  ['wide unfiltered', 'none', undefined, null, { commit: N, tree: N, blob: N, tag: 0 }],
  ["filter ''", 'tree:0', '', null, { commit: N, tree: N, blob: N, tag: 0 }],
];
const want = filter => (filter === undefined ? { oid: tip, expectType: TYPE.COMMIT } : { oid: tip, expectType: TYPE.COMMIT, filter });

for (const how of ['err', '400']) {
  for (const [name, treeFilter, filter, wire, pack] of PATHS) {
    test(`no shallow, deepen refused (${how}), ${name}: POST, GET, POST without deepen, and main's answer`, async () => {
      const { t, log } = recording(refusing(how), { treeFilter, blobWants: 'many' });
      const got = await fetchObject(t, want(filter));
      assert.deepEqual(shape(log), ['POST 1', 'GET null', 'POST null'], got.ok ? 'ok' : `${got.error.code}: ${got.error.message}`);
      // the second request is the first without its depth: what main sends this server
      assert.equal(log[2].body, log[0].body.replace('000ddeepen 1\n', ''));
      assert.equal(filterOf(log[2].body), wire);
      assert.equal(got.ok, true);
      assert.equal(got.value.type, TYPE.COMMIT);
      assert.deepEqual(got.value.data, raw());
      assert.deepEqual(counted(log[2].bytes), pack);
    });
  }
}

test('no shallow, once learned: the next call on the same quirks record sends no deepen and reads nothing', async () => {
  for (const how of ['err', '400']) {
    for (const filter of [undefined, '']) {
      const { t, log } = recording(refusing(how));
      unwrap(await fetchObject(t, want(filter)));
      assert.deepEqual(shape(log), ['POST 1', 'GET null', 'POST null']);
      const again = unwrap(await fetchObject(t, want(filter)));
      assert.deepEqual(again.data, raw());
      assert.deepEqual(shape(log).slice(3), ['POST null']);
    }
  }
});

test('never asked again: 401, 403, 404, 429 and 500 stand as they are, with no advertisement read', async () => {
  const codes = { 401: 'auth', 403: 'auth', 404: 'not_found', 429: 'rate_limited', 500: 'upstream_5xx' };
  for (const [how, code] of Object.entries(codes)) {
    for (const [name, treeFilter, filter] of PATHS) {
      const { t, log } = recording(refusing(how), { treeFilter, blobWants: 'many' });
      const got = await fetchObject(t, want(filter));
      assert.equal(got.ok, false, `${how} ${name}`);
      assert.equal(got.error.code, code, `${how} ${name}`);
      assert.deepEqual(shape(log), ['POST 1'], `${how} ${name}`);
    }
  }
});

test("never asked again: the caller's own deepen is sent as given and its refusal stands", async () => {
  for (const [how, code] of [['err', 'remote_error'], ['400', 'http']]) {
    for (const [name, treeFilter, filter] of PATHS) {
      const { t, log } = recording(refusing(how), { treeFilter, blobWants: 'many' });
      const got = await fetchObject(t, { ...want(filter), deepen: 1 });
      assert.equal(got.ok, false, `${how} ${name}`);
      assert.equal(got.error.code, code, `${how} ${name}`);
      assert.deepEqual(shape(log), ['POST 1'], `${how} ${name}`);
    }
  }
});

test('a server that lists shallow: the first error stands, and the advertisement is read once per quirks record', async () => {
  for (const [how, code, said] of [['err', 'remote_error', /unknown argument deepen 1/], ['400', 'http', /^HTTP 400 /]]) {
    for (const [name, treeFilter, filter] of PATHS) {
      const { t, log } = recording(refusing(how, true), { treeFilter, blobWants: 'many' });
      const got = await fetchObject(t, want(filter));
      assert.equal(got.ok, false, `${how} ${name}`);
      assert.equal(got.error.code, code, `${how} ${name}`);
      assert.match(got.error.message, said);
      assert.deepEqual(shape(log), ['POST 1', 'GET null'], `${how} ${name}`);
      // shallow is now known for the record: the same refusal is not a reason to read the advertisement again
      const again = await fetchObject(t, want(filter));
      assert.equal(again.ok, false);
      assert.equal(again.error.code, code);
      assert.deepEqual(shape(log).slice(2), ['POST 1'], `${how} ${name}`);
    }
  }
});

// The request without `deepen` is main's request, so main's handling of its answer is ply's (R3 on the tree:0 path).
// Two servers without `shallow` that main reads through its filter fallbacks, each refusing the default depth first in
// one of the three shapes. The expected values are main's outcome, derived from git's rules as above:
//   (a) lists `filter`, takes only blob:none (tree:0: HTTP 400, Artifacts' text). Main: tree:0 -> 400, blob:none -> the
//       commit, in a pack of N commits + N root trees.
//   (b) lists neither `shallow` nor `filter` and dies on a `filter` line as git's upload-pack does (an empty body).
//       Main: tree:0 -> empty, the advertisement, no filter -> the commit, in a pack of N commits + N trees + N blobs.
const EMPTY = () => new Response(new Uint8Array(0), { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' } });
const refusingFirst = how => (how === 'empty' ? EMPTY() : REFUSALS[how]());
const SERVERS = [
  ['lists filter, takes only blob:none', ['shallow'], () => new Response('Unsupported Git fetch filter; only blob:none is supported.', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } }), body => filterOf(body) === 'tree:0',
    ['POST 1 tree:0', 'GET null null', 'POST null tree:0', 'POST null blob:none'], 'blob:none', { commit: N, tree: N, blob: 0, tag: 0 }],
  ['lists no filter, dies on one', ['shallow', 'filter'], EMPTY, body => filterOf(body) !== null,
    ['POST 1 tree:0', 'GET null null', 'POST null null'], 'none', { commit: N, tree: N, blob: N, tag: 0 }],
];
for (const how of ['err', '400', 'empty']) {
  for (const [name, drop, refuseFilter, refused, requests, learned, pack] of SERVERS) {
    test(`no shallow, deepen refused (${how}), tree:0 path, server ${name}: main's answer by main's fallback`, async () => {
      const { t, log } = recording(async ({ url: u, method, body }) => {
        if (method === 'GET') return strip(u, drop);
        if (/deepen /.test(body)) return refusingFirst(how);
        return refused(body) ? refuseFilter() : null;
      });
      const got = await fetchObject(t, want(undefined));
      assert.equal(got.ok, true, got.ok ? 'ok' : `${got.error.code}: ${got.error.message} after ${JSON.stringify(log.map(x => `${x.method} ${deepenOf(x.body)} ${filterOf(x.body)} -> ${x.status} ${x.bytes.length}B`))}`);
      assert.equal(got.value.type, TYPE.COMMIT);
      assert.deepEqual(got.value.data, raw());
      assert.deepEqual(log.map(x => `${x.method} ${deepenOf(x.body)} ${filterOf(x.body)}`), requests);
      assert.deepEqual(counted(log.at(-1).bytes), pack);
      assert.equal(t.quirks.treeFilter, learned);
    });
  }
}
