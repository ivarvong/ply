// fetchObject costs one object's worth of pack, whatever the history behind the want. The oracle is git: a repository of
// N commits built by git fast-import, served by git http-backend; every response is recorded, and the pack in it is
// counted twice, from its own 12-byte header and by git index-pack + git verify-pack. Expected counts are hand-derived:
// a commit want is 1 commit (it was N: every ancestor, the filter drops trees and blobs, not commits); a tree or blob
// want is that 1 object; an annotated tag want is what git's server sends for it, stated below.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer } from './server.js';
import { fetchObject } from '../src/fetch.js';
import { createTransport } from '../src/http.js';
import { discover } from '../src/discover.js';
import { TYPE } from '../src/objects.js';
import { DEFAULT_LIMITS } from '../src/limits.js';
import { unwrap } from './unwrap.js';

const N = 300;
let root, cleanup, srv, bare, url, tip, tree, blob, tag, k = 0;

before(async () => {
  ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root);
  bare = makeBareRepo(root, 'hist'); url = `${srv.url}/hist.git`;
  // N commits in a line, f.txt changed in each
  let stream = '';
  for (let i = 1; i <= N; i++) {
    const msg = `c${i}\n`, body = `line ${i}\n`;
    stream += `commit refs/heads/main\nmark :${i}\ncommitter Ada <ada@x> ${1_700_000_000 + i} +0000\ndata ${msg.length}\n${msg}${i > 1 ? `from :${i - 1}\n` : ''}M 100644 inline f.txt\ndata ${body.length}\n${body}\n`;
  }
  gitBuf(bare, ['fast-import', '--quiet'], Buffer.from(stream));
  git(bare, ['-c', 'user.name=Ada', '-c', 'user.email=ada@x', 'tag', '-a', '-m', 'v1', 'v1', 'main']);
  tip = git(bare, ['rev-parse', 'main']).trim();
  tree = git(bare, ['rev-parse', 'main^{tree}']).trim();
  blob = git(bare, ['rev-parse', 'main:f.txt']).trim();
  tag = git(bare, ['rev-parse', 'refs/tags/v1']).trim();
  assert.equal(Number(git(bare, ['rev-list', '--count', 'main']).trim()), N);
  assert.equal(git(bare, ['cat-file', '-t', tag]).trim(), 'tag');
});
after(async () => { await srv.close(); cleanup(); });

// A transport whose every exchange is kept: the request body as text, the response bytes. `rewrite` may answer in the
// server's place (a server that does not take `deepen`).
function recording(options = {}, rewrite = null) {
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
  const t = unwrap(createTransport(url, { fetchImpl, quirks: { treeFilter: 'tree:0', blobWants: 'many' }, ...options }));
  return { t, log, fetches: () => log.filter(x => x.method === 'POST' && x.body.includes('command=fetch')) };
}
// The response's pkt-lines: the section names before the pack, the lines of shallow-info, the band-1 bytes (the pack).
function answer(bytes) {
  const lines = [], parts = [];
  let i = 0, inPack = false;
  while (i + 4 <= bytes.length) {
    const len = parseInt(bytes.subarray(i, i + 4).toString('latin1'), 16);
    if (len < 4) { i += 4; continue; }
    const payload = bytes.subarray(i + 4, i + len); i += len;
    if (inPack) { if (payload[0] === 1) parts.push(payload.subarray(1)); continue; }
    const text = payload.toString('latin1').trimEnd();
    if (text === 'packfile') inPack = true; else lines.push(text);
  }
  return { lines, pack: Buffer.concat(parts) };
}
// The pack counted: by its header, and by git (index-pack accepts it, verify-pack lists its objects).
function counted(pack) {
  const dir = join(root, `count${k++}`); mkdirSync(dir); git(dir, ['init', '-q', '--bare', '.']);
  const file = join(dir, 'x.pack'); writeFileSync(file, pack);
  git(dir, ['index-pack', file]);
  const by = { commit: 0, tree: 0, blob: 0, tag: 0 };
  for (const l of git(dir, ['verify-pack', '-v', join(dir, 'x.idx')]).split('\n')) { const m = /^[0-9a-f]{40} (commit|tree|blob|tag) /.exec(l); if (m) by[m[1]]++; }
  assert.equal(pack.subarray(0, 4).toString('latin1'), 'PACK');
  return { header: pack.readUInt32BE(8), ...by };
}
const deepenOf = body => { const m = /(?:^|\n)[0-9a-f]{4}deepen (\d+)\n/.exec(body); return m ? Number(m[1]) : null; };
const raw = (type, oid) => new Uint8Array(gitBuf(bare, ['cat-file', type, oid]));

test('a commit want is one commit of pack, not the history: expectType commit', async () => {
  const { t, fetches } = recording();
  const got = unwrap(await fetchObject(t, { oid: tip, expectType: TYPE.COMMIT }));
  assert.deepEqual(got.data, raw('commit', tip));
  assert.equal(fetches().length, 1);
  assert.equal(deepenOf(fetches()[0].body), 1);
  const a = answer(fetches()[0].bytes);
  assert.deepEqual(counted(a.pack), { header: 1, commit: 1, tree: 0, blob: 0, tag: 0 });
  // the protocol's shallow-info section says where history was cut; nothing ply returns says the repository is shallow
  assert.deepEqual(a.lines, ['shallow-info', `shallow ${tip}`]);
  assert.deepEqual(Object.keys(got).toSorted(), ['bust', 'data', 'oid', 'size', 'tree', 'type']);
  assert.equal(t.objects.size, 0);
});

test('a commit want of unknown type (no expectType) is one commit of pack', async () => {
  const { t, fetches } = recording();
  const got = unwrap(await fetchObject(t, { oid: tip }));
  assert.equal(got.type, TYPE.COMMIT);
  assert.deepEqual(got.data, raw('commit', tip));
  assert.equal(deepenOf(fetches()[0].body), 1);
  assert.deepEqual(counted(answer(fetches()[0].bytes).pack), { header: 1, commit: 1, tree: 0, blob: 0, tag: 0 });
});

test('a tree want and a blob want of unknown type: git sends the one object and an empty shallow-info', async () => {
  for (const [oid, type, id] of [[tree, 'tree', TYPE.TREE], [blob, 'blob', TYPE.BLOB]]) {
    const { t, fetches } = recording();
    const got = unwrap(await fetchObject(t, { oid }));
    assert.equal(got.type, id);
    assert.deepEqual(got.data, raw(type, oid));
    assert.equal(deepenOf(fetches()[0].body), 1);
    const a = answer(fetches()[0].bytes);
    // git's upload-pack opens shallow-info whenever a depth was asked (send_shallow_info) and names no commit: a tree
    // or blob is not a commit and peels to none (get_shallow_commits skips it)
    assert.deepEqual(a.lines, ['shallow-info']);
    assert.deepEqual(counted(a.pack), { header: 1, commit: 0, tree: 0, blob: 0, tag: 0, [type]: 1 });
  }
});

test('a want whose type the caller names tree or blob cannot be a commit: no deepen is sent, as before', async () => {
  for (const [oid, type, id] of [[tree, 'tree', TYPE.TREE], [blob, 'blob', TYPE.BLOB]]) {
    const { t, fetches } = recording();
    const got = unwrap(await fetchObject(t, { oid, expectType: id }));
    assert.deepEqual(got.data, raw(type, oid));
    assert.equal(deepenOf(fetches()[0].body), null);
    const a = answer(fetches()[0].bytes);
    assert.deepEqual(a.lines, []);
    assert.deepEqual(counted(a.pack), { header: 1, commit: 0, tree: 0, blob: 0, tag: 0, [type]: 1 });
  }
});

test('an annotated tag want: git sends the tag and the one commit it peels to, not the history', async () => {
  const { t, fetches } = recording();
  const got = await fetchObject(t, { oid: tag });
  assert.equal(deepenOf(fetches()[0].body), 1);
  const a = answer(fetches()[0].bytes);
  // depth 1 of a tag is the commit it peels to (get_shallow_commits: deref_tag); that commit is the shallow boundary
  assert.deepEqual(a.lines, ['shallow-info', `shallow ${tip}`]);
  assert.deepEqual(counted(a.pack), { header: 2, commit: 1, tree: 0, blob: 0, tag: 1 });
  // two objects are not a single-object answer: the refusal fetchObject has always given a tag want, now for a pack of
  // 2 objects where it was N + 1
  assert.equal(got.ok, false);
  assert.equal(got.error.code, 'pack_corrupt');
  assert.equal(got.error.message, 'pack: expected 1 object, got 2');
});

test("a caller's deepen is sent as given: 3 is three commits, 0 is the whole history", async () => {
  const three = recording();
  const got = unwrap(await fetchObject(three.t, { oid: tip, expectType: TYPE.COMMIT, deepen: 3 }));
  assert.deepEqual(got.data, raw('commit', tip));
  assert.equal(deepenOf(three.fetches()[0].body), 3);
  assert.deepEqual(counted(answer(three.fetches()[0].bytes).pack), { header: 3, commit: 3, tree: 0, blob: 0, tag: 0 });
  const all = recording();
  const whole = unwrap(await fetchObject(all.t, { oid: tip, expectType: TYPE.COMMIT, deepen: 0 }));
  assert.deepEqual(whole.data, raw('commit', tip));
  assert.equal(deepenOf(all.fetches()[0].body), null);
  const a = answer(all.fetches()[0].bytes);
  assert.deepEqual(a.lines, []);
  assert.deepEqual(counted(a.pack), { header: N, commit: N, tree: 0, blob: 0, tag: 0 });
});

test('a history no pack limit would hold in one pack still returns the one commit', async () => {
  // N commits charge N * (bytes + 3 KiB) against maxInflatedTotal: about 1 MiB here, against a 64 KiB limit
  const limits = { ...DEFAULT_LIMITS, maxInflatedTotal: 64 * 1024 };
  const { t, fetches } = recording({ limits });
  const got = unwrap(await fetchObject(t, { oid: tip, expectType: TYPE.COMMIT }));
  assert.deepEqual(got.data, raw('commit', tip));
  assert.deepEqual(counted(answer(fetches()[0].bytes).pack), { header: 1, commit: 1, tree: 0, blob: 0, tag: 0 });
  // the caller who asks for the whole history under that limit is refused by it, as before
  const whole = await fetchObject(recording({ limits }).t, { oid: tip, expectType: TYPE.COMMIT, deepen: 0 });
  assert.equal(whole.ok, false);
  assert.equal(whole.error.code, 'limit_exceeded');
  assert.match(whole.error.message, /^pack inflated bytes \d+ exceeds limit 65536$/);
});

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

test('a server that does not advertise shallow: the advertisement in hand, no deepen is sent and the answer is the history', async () => {
  const { t, fetches } = recording({}, noShallow);
  const info = unwrap(await discover(t));
  assert.equal(info.shallow, false);
  const got = unwrap(await fetchObject(t, { oid: tip, expectType: TYPE.COMMIT }));
  assert.deepEqual(got.data, raw('commit', tip));
  assert.equal(fetches().length, 1);
  assert.equal(deepenOf(fetches()[0].body), null);
  assert.deepEqual(counted(answer(fetches()[0].bytes).pack), { header: N, commit: N, tree: 0, blob: 0, tag: 0 });
  // and the limit refuses the history honestly
  const small = recording({ limits: { ...DEFAULT_LIMITS, maxInflatedTotal: 64 * 1024 } }, noShallow);
  unwrap(await discover(small.t));
  const refused = await fetchObject(small.t, { oid: tip, expectType: TYPE.COMMIT });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'limit_exceeded');
});

test('a server that does not advertise shallow, not yet known: one refused deepen, the advertisement read once, then no deepen', async () => {
  const { t, log, fetches } = recording({}, noShallow);
  const got = unwrap(await fetchObject(t, { oid: tip, expectType: TYPE.COMMIT }));
  assert.deepEqual(got.data, raw('commit', tip));
  assert.deepEqual(log.map(x => `${x.method} ${deepenOf(x.body)}`), ['POST 1', 'GET null', 'POST null']);
  assert.deepEqual(counted(answer(fetches()[1].bytes).pack), { header: N, commit: N, tree: 0, blob: 0, tag: 0 });
  const again = unwrap(await fetchObject(t, { oid: tip }).then(r => r.ok ? r : fetchObject(t, { oid: tip, expectType: TYPE.COMMIT })));
  assert.deepEqual(again.data, raw('commit', tip));
  assert.deepEqual(log.slice(3).map(x => `${x.method} ${deepenOf(x.body)}`).filter(x => x !== 'POST null'), []);
});
