// The default-depth space (test/space/default-depth.space.js): every cell of asked × expectType × knowledge ×
// advertised × refusal × path through fetchObject against git http-backend behind a proxy that renders the cell's
// server. The proxy keeps git's answer to each distinct request (the product has 1,800 cells and a few dozen distinct
// requests), so every pack and every advertisement is git's own bytes. Checked per cell: the requests in order with
// their `deepen` and `filter`, the outcome, the object against `git cat-file`, and the pack's object count (its own
// header) against the hand-derived count. SPACE.md's block is generated here (DEFAULT_DEPTH_WRITE=1 rewrites it).
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer } from '../server.js';
import { fetchObject } from '../../src/fetch.js';
import { discover } from '../../src/discover.js';
import { createTransport } from '../../src/http.js';
import { TYPE } from '../../src/objects.js';
import { unwrap } from '../unwrap.js';
import { cells, expected, block, START, END } from './default-depth.space.js';

const N = 6;
const SPACE_MD = new URL('../../SPACE.md', import.meta.url);
let root, cleanup, srv, bare, url, wants;

before(async () => {
  ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root);
  bare = makeBareRepo(root, 'hist'); url = `${srv.url}/hist.git`;
  let stream = '';
  for (let i = 1; i <= N; i++) {
    const msg = `c${i}\n`, body = `line ${i}\n`;
    stream += `commit refs/heads/main\nmark :${i}\ncommitter Ada <ada@x> ${1_700_000_000 + i} +0000\ndata ${msg.length}\n${msg}${i > 1 ? `from :${i - 1}\n` : ''}M 100644 inline f.txt\ndata ${body.length}\n${body}\n`;
  }
  gitBuf(bare, ['fast-import', '--quiet'], Buffer.from(stream));
  git(bare, ['-c', 'user.name=Ada', '-c', 'user.email=ada@x', 'tag', '-a', '-m', 'v1', 'v1', 'main']);
  const rev = name => git(bare, ['rev-parse', name]).trim();
  const commit = rev('main');
  wants = { none: ['commit', commit], COMMIT: ['commit', commit], TAG: ['tag', rev('refs/tags/v1')], TREE: ['tree', rev('main^{tree}')], BLOB: ['blob', rev('main:f.txt')] };
  // what the hand-derived pack counts rest on: N commits in a line, N distinct root trees, N distinct blobs
  assert.equal(Number(git(bare, ['rev-list', '--count', 'main']).trim()), N);
  assert.equal(new Set(git(bare, ['log', '--format=%T', 'main']).trim().split('\n')).size, N);
  assert.equal(git(bare, ['cat-file', '--batch-all-objects', '--batch-check=%(objecttype)']).split('\n').filter(x => x === 'blob').length, N);
});
after(async () => { await srv.close(); cleanup(); });

const deepenOf = body => { const m = /(?:^|\n)[0-9a-f]{4}deepen (\d+)\n/.exec(body); return m ? Number(m[1]) : null; };
const filterOf = body => { const m = /(?:^|\n)[0-9a-f]{4}filter ([^\n]+)\n/.exec(body); return m ? m[1] : null; };
const pkt = s => { const b = Buffer.from(s, 'latin1'); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0'), 'latin1'), b]); };
const RESULT = { 'content-type': 'application/x-git-upload-pack-result' };
const REFUSALS = {
  empty: () => new Response(new Uint8Array(0), { status: 200, headers: RESULT }),
  err: () => new Response(pkt('ERR unknown argument deepen\n'), { status: 200, headers: RESULT }),
  400: () => new Response('bad argument', { status: 400 }),
};
// git's answer to each distinct request, kept
const kept = new Map();
async function upstream(input, init, body) {
  const key = `${init.method ?? 'GET'} ${input}\n${body}`;
  if (!kept.has(key)) {
    const res = await fetch(input, { ...init, body: body === '' ? undefined : Buffer.from(body, 'latin1') });
    kept.set(key, { status: res.status, headers: [...res.headers], bytes: Buffer.from(await res.arrayBuffer()) });
  }
  return kept.get(key);
}
// The advertisement with the features the cell's server does not have taken off its fetch= line.
function advertisement(real, drop) {
  const text = real.bytes.toString('latin1');
  const m = /[0-9a-f]{4}fetch=([^\n]*)\n/.exec(text);
  assert.ok(m && m[1].split(' ').includes('shallow') && m[1].split(' ').includes('filter'), 'git advertises shallow and filter');
  const line = `fetch=${m[1].split(' ').filter(f => !drop.includes(f)).join(' ')}\n`;
  return Buffer.from(text.replace(m[0], `${(line.length + 4).toString(16).padStart(4, '0')}${line}`), 'latin1');
}
// The object count in the header of the pack a fetch response carries (band 1 after `packfile`).
function packCount(bytes) {
  const parts = [];
  let i = 0, inPack = false;
  while (i + 4 <= bytes.length) {
    const len = parseInt(bytes.subarray(i, i + 4).toString('latin1'), 16);
    if (len < 4) { i += 4; continue; }
    const payload = bytes.subarray(i + 4, i + len); i += len;
    if (inPack) { if (payload[0] === 1) parts.push(payload.subarray(1)); continue; }
    if (payload.toString('latin1').trimEnd() === 'packfile') inPack = true;
  }
  const pack = Buffer.concat(parts);
  assert.equal(pack.subarray(0, 4).toString('latin1'), 'PACK');
  return pack.readUInt32BE(8);
}

// The cell's server and a fresh transport (its own quirks record) on it.
function server(c) {
  const state = { lists: c.knowledge === 'listed', log: [] };
  const unfiltered = c.path === 'unfiltered';
  const fetchImpl = async (input, init = {}) => {
    const body = init.body === undefined || init.body === null ? '' : Buffer.from(await new Response(init.body).arrayBuffer()).toString('latin1');
    const method = init.method ?? 'GET';
    let res;
    if (method === 'GET') {
      const real = await upstream(String(input), init, '');
      const drop = [...(state.lists ? [] : ['shallow']), ...(unfiltered ? ['filter'] : [])];
      res = { status: real.status, headers: real.headers, bytes: advertisement(real, drop) };
    } else if (deepenOf(body) !== null && c.refusal in REFUSALS) {
      const r = REFUSALS[c.refusal]();
      res = { status: r.status, headers: [...r.headers], bytes: Buffer.from(await r.arrayBuffer()) };
    } else {
      res = await upstream(String(input), init, c.refusal === 'ignored' ? body.replace(/000ddeepen \d\n/, '') : body);
    }
    state.log.push({ method, body, bytes: res.bytes });
    return new Response(res.bytes, { status: res.status, headers: res.headers });
  };
  const treeFilter = unfiltered ? 'none' : (c.path === 'blob:none' ? 'blob:none' : 'tree:0');
  const t = unwrap(createTransport(url, { fetchImpl, quirks: { treeFilter, blobWants: 'many' } }));
  return { t, state };
}

test('default depth: every cell sends the expected requests and ends as the rules say, against git', async () => {
  const all = cells();
  assert.equal(all.length, 3 * 5 * 3 * 2 * 5 * 4);
  const wrong = [];
  const seen = { ok: 0, error: 0 };
  for (const c of all) {
    const { t, state } = server(c);
    if (c.knowledge !== 'unlearned') {
      const info = unwrap(await discover(t));
      assert.equal(info.shallow, c.knowledge === 'listed', c.id);
    }
    assert.equal(t.quirks.treeFilter, c.path === 'unfiltered' ? 'none' : (c.path === 'blob:none' ? 'blob:none' : 'tree:0'), `${c.id}: the path`);
    state.lists = c.advertised === 'yes';
    state.log.length = 0;
    const [typeName, oid] = wants[c.expectType];
    const want = { oid };
    if (c.expectType !== 'none') want.expectType = TYPE[c.expectType];
    if (c.asked !== 'none') want.deepen = Number(c.asked);
    if (c.path === "filter ''") want.filter = '';
    const got = await fetchObject(t, want);
    const exp = expected(c, N);
    const requests = state.log.map(x => (x.method === 'GET' ? 'GET' : `POST ${deepenOf(x.body) ?? '-'}`));
    const outcome = got.ok ? 'ok' : got.error.code;
    const problems = [];
    if (requests.join(', ') !== exp.requests.join(', ')) problems.push(`requests ${requests.join(', ')}, expected ${exp.requests.join(', ')}`);
    if (outcome !== exp.outcome) problems.push(`outcome ${outcome}${got.ok ? '' : ` (${got.error.message})`}, expected ${exp.outcome}`);
    const wire = c.path === 'tree:0' || c.path === 'blob:none' ? c.path : null;
    for (const x of state.log) if (x.method === 'POST' && filterOf(x.body) !== wire) problems.push(`filter ${filterOf(x.body)} on the wire, expected ${wire}`);
    if (exp.objects !== undefined && requests.length === exp.requests.length) {
      const count = packCount(state.log[state.log.length - 1].bytes);
      if (count !== exp.objects) problems.push(`pack of ${count} objects, expected ${exp.objects}`);
    }
    if (got.ok) {
      seen.ok++;
      if (got.value.type !== TYPE[typeName.toUpperCase()]) problems.push(`type ${got.value.type}`);
      if (!Buffer.from(got.value.data).equals(gitBuf(bare, ['cat-file', typeName, oid]))) problems.push('bytes differ from git cat-file');
      // nothing returned says the repository is shallow
      if ('shallow' in got.value) problems.push('the result has a shallow field');
    } else seen.error++;
    if (problems.length > 0) wrong.push(`${c.id}: ${problems.join('; ')}`);
  }
  assert.deepEqual(wrong.slice(0, 60), [], `${wrong.length} of ${all.length} cells wrong`);
  // both classes are populated: the walk is not vacuous
  assert.ok(seen.ok > 600 && seen.error > 300, JSON.stringify(seen));
}, 240_000);

test('SPACE.md\'s default-depth block is current', () => {
  const made = block(N);
  const md = readFileSync(SPACE_MD, 'utf8');
  const i = md.indexOf(START), j = md.indexOf(END);
  if (process.env.DEFAULT_DEPTH_WRITE === '1' && i >= 0 && j > i) { writeFileSync(SPACE_MD, md.slice(0, i) + made + md.slice(j + END.length)); return; }
  assert.ok(i >= 0 && j > i, 'SPACE.md has no default-depth block: add the markers and run DEFAULT_DEPTH_WRITE=1 npx vitest run test/space/default-depth.test.js');
  assert.equal(md.slice(i, j + END.length), made, 'SPACE.md default-depth block is stale: run DEFAULT_DEPTH_WRITE=1 npx vitest run test/space/default-depth.test.js');
});
