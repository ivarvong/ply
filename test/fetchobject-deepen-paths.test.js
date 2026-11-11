// The default depth (fetchObject sends `deepen 1` for a want that may be a commit) on the paths beside the tree:0 single
// fetch: the blob:none fallback, the unfiltered fallback, the caller's `filter: ''`, the re-ask without `deepen` on a
// server without `shallow`, and expectType tag. The oracle is git, as in fetchobject-deepen.test.js: a line of N commits
// built by git fast-import, each changing the one file f.txt, served by git http-backend; every exchange is recorded
// and the pack in it is counted from its own header and by git index-pack + git verify-pack -v.
// Expected counts are hand-derived from that history (every commit has its own root tree and its own f.txt blob):
//   depth 1, blob:none   1 commit + its 1 tree                 = 2      (no depth: N commits + N trees          = 2N)
//   depth 1, no filter   1 commit + its 1 tree + its 1 blob    = 3      (no depth: N commits, N trees, N blobs  = 3N)
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer } from './server.js';
import { fetchObject } from '../src/fetch.js';
import { createTransport } from '../src/http.js';
import { TYPE } from '../src/objects.js';
import { unwrap } from './unwrap.js';

const N = 120;
let root, cleanup, srv, bare, url, stockUrl, tip, tag, k = 0;

before(async () => {
  ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root);
  bare = makeBareRepo(root, 'hist'); url = `${srv.url}/hist.git`;
  // git's defaults: no uploadpack.allowFilter, so `fetch=` lists no `filter` and upload-pack dies on one
  const stock = makeBareRepo(root, 'stock', { stock: true }); stockUrl = `${srv.url}/stock.git`;
  let stream = '';
  for (let i = 1; i <= N; i++) {
    const msg = `c${i}\n`, body = `line ${i}\n`;
    stream += `commit refs/heads/main\nmark :${i}\ncommitter Ada <ada@x> ${1_700_000_000 + i} +0000\ndata ${msg.length}\n${msg}${i > 1 ? `from :${i - 1}\n` : ''}M 100644 inline f.txt\ndata ${body.length}\n${body}\n`;
  }
  // the same stream into both: the same objects, the same ids
  for (const dir of [bare, stock]) gitBuf(dir, ['fast-import', '--quiet'], Buffer.from(stream));
  git(bare, ['-c', 'user.name=Ada', '-c', 'user.email=ada@x', 'tag', '-a', '-m', 'v1', 'v1', 'main']);
  tip = git(bare, ['rev-parse', 'main']).trim();
  tag = git(bare, ['rev-parse', 'refs/tags/v1']).trim();
  assert.equal(git(stock, ['rev-parse', 'main']).trim(), tip);
  assert.equal(Number(git(bare, ['rev-list', '--count', 'main']).trim()), N);
  // what the hand-derived counts rest on: N distinct root trees, N distinct blobs
  assert.equal(new Set(git(bare, ['log', '--format=%T', 'main']).trim().split('\n')).size, N);
  assert.equal(git(bare, ['cat-file', '--batch-all-objects', '--batch-check=%(objecttype)']).split('\n').filter(x => x === 'blob').length, N);
  assert.equal(git(bare, ['cat-file', '-t', tag]).trim(), 'tag');
});
after(async () => { await srv.close(); cleanup(); });

// A transport on `remote` whose every exchange is kept: the request body as text, the response bytes. `rewrite` may
// answer in the server's place.
function recording(remote, quirks = {}, rewrite = null) {
  const log = [];
  const fetchImpl = async (input, init = {}) => {
    const body = init.body === undefined || init.body === null ? '' : Buffer.from(await new Response(init.body).arrayBuffer()).toString('latin1');
    const method = init.method ?? 'GET';
    const faked = rewrite === null ? null : await rewrite({ url: String(input), method, body });
    const res = faked ?? await fetch(input, { ...init, body: body === '' ? undefined : Buffer.from(body, 'latin1') });
    const bytes = Buffer.from(await res.arrayBuffer());
    log.push({ url: String(input), method, body, bytes, status: res.status });
    return new Response(bytes, { status: res.status, headers: res.headers });
  };
  const t = unwrap(createTransport(remote, { fetchImpl, quirks: { treeFilter: 'tree:0', blobWants: 'many', ...quirks } }));
  return { t, log, fetches: () => log.filter(x => x.method === 'POST' && x.body.includes('command=fetch')) };
}
// The band-1 bytes of a fetch response: the pack.
function packOf(bytes) {
  const parts = [];
  let i = 0, inPack = false;
  while (i + 4 <= bytes.length) {
    const len = parseInt(bytes.subarray(i, i + 4).toString('latin1'), 16);
    if (len < 4) { i += 4; continue; }
    const payload = bytes.subarray(i + 4, i + len); i += len;
    if (inPack) { if (payload[0] === 1) parts.push(payload.subarray(1)); continue; }
    if (payload.toString('latin1').trimEnd() === 'packfile') inPack = true;
  }
  return Buffer.concat(parts);
}
// The pack counted: by its header, and by git (index-pack accepts it, verify-pack lists its objects).
function counted(bytes) {
  const pack = packOf(bytes);
  const dir = join(root, `count${k++}`); mkdirSync(dir); git(dir, ['init', '-q', '--bare', '.']);
  const file = join(dir, 'x.pack'); writeFileSync(file, pack);
  git(dir, ['index-pack', file]);
  const by = { commit: 0, tree: 0, blob: 0, tag: 0 };
  for (const l of git(dir, ['verify-pack', '-v', join(dir, 'x.idx')]).split('\n')) { const m = /^[0-9a-f]{40} (commit|tree|blob|tag) /.exec(l); if (m) by[m[1]]++; }
  assert.equal(pack.subarray(0, 4).toString('latin1'), 'PACK');
  return { header: pack.readUInt32BE(8), ...by };
}
const argOf = (name, body) => { const m = new RegExp(`(?:^|\\n)[0-9a-f]{4}${name} ([^\\n]*)\\n`).exec(body); return m ? m[1] : null; };
// each exchange as `METHOD filter deepen` (null: the argument is not in the request)
const said = log => log.map(x => `${x.method} ${argOf('filter', x.body)} ${argOf('deepen', x.body)}`);
const commitBytes = () => new Uint8Array(gitBuf(bare, ['cat-file', 'commit', tip]));

// Cloudflare Artifacts' answer to any filter but blob:none (observed 2026-10-23, fetch.ts): HTTP 400 and this text.
const onlyBlobNone = ({ method, body }) => {
  const filter = argOf('filter', body);
  if (method !== 'POST' || filter === null || filter === 'blob:none') return null;
  return new Response('Unsupported Git fetch filter; only blob:none is supported.', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
// A server that does not implement shallow fetches: its advertisement's fetch= line has no `shallow`, and its
// upload-pack dies on the `deepen` argument without a word (an empty body), as git's does on an argument it does not take.
const noShallow = async ({ url: u, method, body }) => {
  if (method === 'POST' && /deepen /.test(body)) return new Response(new Uint8Array(0), { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' } });
  if (method !== 'GET') return null;
  const res = await fetch(u, { headers: { 'git-protocol': 'version=2' } });
  const text = Buffer.from(await res.arrayBuffer()).toString('latin1');
  const m = /[0-9a-f]{4}fetch=([^\n]*)\n/.exec(text);
  assert.ok(m && m[1].split(' ').includes('shallow'), 'git advertises shallow');
  const line = `fetch=${m[1].split(' ').filter(f => f !== 'shallow').join(' ')}\n`;
  const out = text.replace(m[0], `${(line.length + 4).toString(16).padStart(4, '0')}${line}`);
  return new Response(Buffer.from(out, 'latin1'), { status: res.status, headers: res.headers });
};

test('the blob:none fallback, learned record: one request with deepen 1, the commit and its one tree', async () => {
  for (const expectType of [null, TYPE.COMMIT]) {
    const { t, log } = recording(url, { treeFilter: 'blob:none' });
    const got = unwrap(await fetchObject(t, { oid: tip, expectType }));
    assert.equal(got.type, TYPE.COMMIT);
    assert.deepEqual(got.data, commitBytes());
    assert.equal(got.wide, true);
    assert.deepEqual(said(log), ['POST blob:none 1']);
    assert.deepEqual(counted(log[0].bytes), { header: 2, commit: 1, tree: 1, blob: 0, tag: 0 });
  }
});

test('the blob:none fallback, tree:0 refused in this call: both requests carry deepen 1, the answer is the commit and its one tree', async () => {
  const { t, log } = recording(url, {}, onlyBlobNone);
  const got = unwrap(await fetchObject(t, { oid: tip }));
  assert.equal(got.type, TYPE.COMMIT);
  assert.deepEqual(got.data, commitBytes());
  assert.equal(got.wide, true);
  assert.equal(t.quirks.treeFilter, 'blob:none');
  assert.deepEqual(said(log), ['POST tree:0 1', 'POST blob:none 1']);
  assert.deepEqual(log.map(x => x.status), [400, 200]);
  assert.deepEqual(counted(log[1].bytes), { header: 2, commit: 1, tree: 1, blob: 0, tag: 0 });
});

test('the unfiltered fallback, stock git without allowFilter: POST (empty), GET, POST with deepen 1 and no filter: the commit, its tree, its blob', async () => {
  const { t, log } = recording(stockUrl);
  const got = unwrap(await fetchObject(t, { oid: tip }));
  assert.equal(got.type, TYPE.COMMIT);
  assert.deepEqual(got.data, commitBytes());
  assert.equal(got.wide, true);
  assert.equal(t.quirks.treeFilter, 'none');
  assert.deepEqual(said(log), ['POST tree:0 1', 'GET null null', 'POST null 1']);
  // git's upload-pack died on `filter`: nothing came back
  assert.equal(log[0].bytes.length, 0);
  assert.deepEqual(counted(log[2].bytes), { header: 3, commit: 1, tree: 1, blob: 1, tag: 0 });
});

test('the unfiltered fallback, learned record (quirks.treeFilter none): one request with deepen 1 and no filter', async () => {
  for (const expectType of [null, TYPE.COMMIT]) {
    const { t, log } = recording(stockUrl, { treeFilter: 'none' });
    const got = unwrap(await fetchObject(t, { oid: tip, expectType }));
    assert.equal(got.type, TYPE.COMMIT);
    assert.deepEqual(got.data, commitBytes());
    assert.equal(got.wide, true);
    assert.deepEqual(said(log), ['POST null 1']);
    assert.deepEqual(counted(log[0].bytes), { header: 3, commit: 1, tree: 1, blob: 1, tag: 0 });
  }
});

test("the caller's filter '' with a commit want: one request with deepen 1 and no filter; a caller's deepen 0 is the history", async () => {
  const { t, log } = recording(url);
  const got = unwrap(await fetchObject(t, { oid: tip, filter: '', expectType: TYPE.COMMIT }));
  assert.deepEqual(got.data, commitBytes());
  assert.deepEqual(said(log), ['POST null 1']);
  assert.deepEqual(counted(log[0].bytes), { header: 3, commit: 1, tree: 1, blob: 1, tag: 0 });
  // the caller's depth wins on this path too
  const all = recording(url);
  const whole = unwrap(await fetchObject(all.t, { oid: tip, filter: '', expectType: TYPE.COMMIT, deepen: 0 }));
  assert.deepEqual(whole.data, commitBytes());
  assert.deepEqual(said(all.log), ['POST null null']);
  assert.deepEqual(counted(all.log[0].bytes), { header: 3 * N, commit: N, tree: N, blob: N, tag: 0 });
});

test('a server without shallow, not yet known, the wide path: one refused deepen, the advertisement read once, then no deepen', async () => {
  const { t, log } = recording(url, { treeFilter: 'blob:none' }, noShallow);
  const got = unwrap(await fetchObject(t, { oid: tip, expectType: TYPE.COMMIT }));
  assert.deepEqual(got.data, commitBytes());
  assert.equal(got.wide, true);
  assert.deepEqual(said(log), ['POST blob:none 1', 'GET null null', 'POST blob:none null']);
  // as before the default depth: the history, without its blobs
  assert.deepEqual(counted(log[2].bytes), { header: 2 * N, commit: N, tree: N, blob: 0, tag: 0 });
  // the record has learned it: the next call asks once, without deepen
  const again = unwrap(await fetchObject(t, { oid: tip, filter: 'blob:none', expectType: TYPE.COMMIT }));
  assert.deepEqual(again.data, commitBytes());
  assert.deepEqual(said(log.slice(3)), ['POST blob:none null']);
});

test("a server without shallow, not yet known, the caller's filter '': one refused deepen, the advertisement read once, then no deepen", async () => {
  const { t, log } = recording(url, {}, noShallow);
  const got = unwrap(await fetchObject(t, { oid: tip, filter: '', expectType: TYPE.COMMIT }));
  assert.deepEqual(got.data, commitBytes());
  assert.deepEqual(said(log), ['POST null 1', 'GET null null', 'POST null null']);
  assert.deepEqual(counted(log[2].bytes), { header: 3 * N, commit: N, tree: N, blob: N, tag: 0 });
  const again = unwrap(await fetchObject(t, { oid: tip, filter: '', expectType: TYPE.COMMIT }));
  assert.deepEqual(again.data, commitBytes());
  assert.deepEqual(said(log.slice(3)), ['POST null null']);
});

test('expectType tag carries the default depth: a tag want is the tag and the one commit it peels to, a commit id is one commit', async () => {
  // Only the first request and git's answer to it are pinned here: what fetchObject makes of a tag want's two objects
  // belongs to fetchobject-deepen.test.js and fetchobject-deepen-refusal.test.js.
  const a = recording(url);
  await fetchObject(a.t, { oid: tag, expectType: TYPE.TAG });
  assert.equal(said(a.log)[0], 'POST tree:0 1');
  // depth 1 of a tag is the commit it peels to (upload-pack get_shallow_commits: deref_tag); it was N + 1 objects
  assert.deepEqual(counted(a.log[0].bytes), { header: 2, commit: 1, tree: 0, blob: 0, tag: 1 });
  // a commit id named a tag: one commit of pack, and the refusal it has always had (pack_corrupt)
  const b = recording(url);
  const got = await fetchObject(b.t, { oid: tip, expectType: TYPE.TAG });
  assert.deepEqual(said(b.log), ['POST tree:0 1']);
  assert.deepEqual(counted(b.log[0].bytes), { header: 1, commit: 1, tree: 0, blob: 0, tag: 0 });
  assert.equal(got.ok, false);
  assert.equal(got.error.code, 'pack_corrupt');
  assert.equal(got.error.message, 'expected tag, got commit');
});
