// The advertisement enumerator (test/space/advertisement.space.js). Two passes:
//   derived   every cell of caps and refs through ply's real path (createTransport → discover / lsRefs, with an in-process
//             fetch that serves the rendered bytes: no network), compared with the table; the rule (`consistent`)
//             checked on every cell of the four decisions.
//   observed  cells judged by real git 2.50: a synthetic smart-HTTP server serves the cell's advertisement and ls-refs
//             response and forwards fetch requests to `git http-backend`; `git ls-remote` / `git fetch` / `git push` /
//             `git clone` are the oracle for accept vs refuse (and, for fetch, the request lines and the pack-objects
//             invocation upload-pack makes). ply runs over real HTTP against the same server. Real http-backend
//             configurations (uploadpack.*, lsrefs.unborn, transfer.advertiseSID, a sha256 repository, receive.*) check
//             that the renderer writes what git writes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as S from './advertisement.space.js';
import { git, gitAsync, tmpRoot, makeBareRepo, startGitServer } from '../server.js';
// ADV_SPACE_SRC=<dir>: run the space against another copy of src/ (e.g. `git archive train/1 src`) to see where it disagrees
const SRC = process.env.ADV_SPACE_SRC ?? '../../src';
const { createTransport, GitHttp } = await import(`${SRC}/client.js`);
const { discover } = await import(`${SRC}/discover.js`);
const { lsRefs } = await import(`${SRC}/lsrefs.js`);
import { pktInit, pktStep } from '../../src/pktline.js';
import { Tracer } from '../../src/otel.js';
import { td } from '../../src/bytes.js';

const spanStub = { set() {}, event() {}, end() {} };
const tracer = { span: async (_n, _o, fn) => fn(spanStub) };
const FX = { main: '1'.repeat(40), tag: '2'.repeat(40), peeled: '3'.repeat(40), other: '4'.repeat(40) };
const INFO_KEYS = ['agent', 'objectFormat', 'fetch', 'filter', 'shallow', 'waitForDone', 'refInWant', 'sidebandAll', 'lsRefs', 'lsRefsUnborn', 'serverOption', 'sessionId'];
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));
const WHY_MESSAGE = { protocol: /did not answer protocol v2/, 'ls-refs': /advertise ls-refs/, fetch: /advertise fetch/, 'object-format': /object-format/, 'pkt length': /bad pkt-line length/, 'advertisement framing': /^advertisement:/, record: /^ls-refs: malformed line/, 'listing framing': /^ls-refs: (response ended|delim|unexpected|data after)/ };

const outcomeOf = async (fn, okMap) => { try { return { tag: 'ok', ...okMap(await fn()) }; } catch (e) { return { tag: e.code ?? 'untyped', message: e.message }; } };
// against another src (ADV_SPACE_SRC), only the info fields that src reports are compared (lsRefs, sidebandAll, sessionId are new)
const capsOk = info => ({ info: pick(info, process.env.ADV_SPACE_SRC ? INFO_KEYS.filter(k => info[k] !== undefined) : INFO_KEYS) });
const refsOk = ({ refs, head }) => ({ refs: [...refs.values()].map(r => [r.name, r.oid, r.peeled ?? null, r['symref-target'] ?? null]), head });
function judge(want, got) {
  const w = judgeWhy(want, got);
  return w;
}
// the disagreement class of a wrong cell, for the census: `want -> got`, or `ok -> ok(value)`, or `tag (message)`
const wrongClass = (want, got) => (want.tag !== got.tag ? `${want.tag} -> ${got.tag}` : want.tag === 'ok' ? 'ok -> ok (another value)' : `${want.tag} (another reason)`);
function judgeWhy(want, got) {
  if (want.tag !== got.tag) return `want ${want.tag}${want.why ? ` (${want.why})` : ''}, got ${got.tag}: ${got.message ?? ''}`;
  if (want.tag === 'ok') { try { assert.deepEqual(want.info ? { info: got.info } : { refs: got.refs, head: got.head }, want.info ? { info: pick(want.info, Object.keys(got.info)) } : { refs: want.refs, head: want.head }); } catch (e) { return `value: ${e.message.split('\n').slice(0, 12).join(' ')}`; } }
  else if (want.why && WHY_MESSAGE[want.why] && !WHY_MESSAGE[want.why].test(got.message)) return `want ${want.tag} (${want.why}), message: ${got.message}`;
  return null;
}
const census = classes => Object.entries(classes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join('; ');

// ---- the derived pass: an in-process fetch serving the rendered cell ----
function stubTransport(serve) {
  const fetchImpl = async (url, init = {}) => {
    const r = serve(init.method === 'POST' ? 'post' : 'get');
    if (r.reset) throw new TypeError('fetch failed');
    return new Response(r.body, { status: r.status ?? 200, headers: { 'content-type': r.contentType } });
  };
  return createTransport('http://cell.invalid/r.git', { tracer, fetchImpl });
}
const lsRefsReply = body => ({ status: 200, contentType: 'application/x-git-upload-pack-result', body });

test('caps: every cell through discover() (derived from the table)', async t => {
  const cells = S.capsCells();
  const tally = {}, wrong = [], rule = [], classes = {};
  Error.stackTraceLimit = 0;
  for (const c of cells) {
    const want = S.expectedCaps(c);
    const r = S.consistent('caps', want); if (r) rule.push(`${S.capsCellId(c)}: ${r}`);
    const tr = stubTransport(() => S.renderCaps(c, FX));
    const got = await outcomeOf(() => discover(tr), capsOk);
    tally[want.ply.tag] = (tally[want.ply.tag] ?? 0) + 1;
    const w = judge(want.ply, got);
    if (w) { const k = wrongClass(want.ply, got); classes[k] = (classes[k] ?? 0) + 1; wrong.push(wrong.length < 20 ? `${S.capsCellId(c)}: ${w}` : ''); }
  }
  Error.stackTraceLimit = 10;
  t.diagnostic(`caps cells=${cells.length} ${Object.entries(tally).map(([k, n]) => `${k}=${n}`).join(' ')}`);
  if (wrong.length) t.diagnostic(`wrong: ${census(classes)}`);
  assert.deepEqual(rule, [], 'the rule');
  assert.equal(wrong.length, 0, `${wrong.length} wrong:\n${wrong.slice(0, 20).join('\n')}`);
});

test('refs: every cell through lsRefs() (derived from the table)', async t => {
  const cells = S.refsCells();
  const tally = {}, wrong = [], rule = [], classes = {};
  for (const c of cells) {
    const want = S.expectedRefs(c, FX);
    const r = S.consistent('refs', want); if (r) rule.push(`${S.refsCellId(c)}: ${r}`);
    const tr = stubTransport(() => lsRefsReply(S.renderRefs(c, FX)));
    const got = await outcomeOf(() => lsRefs(tr), refsOk);
    tally[want.ply.tag] = (tally[want.ply.tag] ?? 0) + 1;
    const w = judge(want.ply, got);
    if (w) { const k = wrongClass(want.ply, got); classes[k] = (classes[k] ?? 0) + 1; wrong.push(`${S.refsCellId(c)}: ${w}`); }
  }
  t.diagnostic(`refs cells=${cells.length} ${Object.entries(tally).map(([k, n]) => `${k}=${n}`).join(' ')}`);
  if (wrong.length) t.diagnostic(`wrong: ${census(classes)}`);
  assert.deepEqual(rule, [], 'the rule');
  assert.deepEqual(wrong, []);
});

test('push and request: the rule holds on every cell of the table', () => {
  assert.deepEqual(S.pushCells().map(c => S.consistent('push', S.expectedPush(c)) && S.pushCellId(c)).filter(Boolean), []);
  assert.deepEqual(S.requestCells().map(c => S.consistent('request', S.expectedRequest(c)) && S.requestCellId(c)).filter(Boolean), []);
});

// ---- the observed pass ----
let root, cleanup, backend, front, hookLog, fx, fx256;
const routes = new Map(); // key → { kind: 'synthetic', caps?, refs } | { kind: 'proxy', repo }
const posts = new Map();  // key → [request body Buffers]
const observed = { caps: 0, refs: 0, push: 0, request: 0 };

function startFront(backendUrl) {
  const up = new URL(backendUrl);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const [, key, ...rest] = req.url.split('/');
      const route = routes.get(key);
      if (!route) { res.writeHead(404); res.end(); return; }
      if (req.method === 'POST') (posts.get(key) ?? posts.set(key, []).get(key)).push(body);
      const isLsRefs = /command=ls-refs/.test(body.subarray(0, 64).toString());
      if (route.kind === 'synthetic' && (req.method === 'GET' || isLsRefs)) {
        const r = req.method === 'GET' ? route.caps : lsRefsReply(route.refs);
        if (r.reset) { req.socket.destroy(); return; }
        res.writeHead(r.status, { 'content-type': r.contentType }); res.end(Buffer.from(r.body)); return;
      }
      const p = http.request({ host: up.hostname, port: up.port, path: `/${route.repo}/${rest.slice(1).join('/')}`, method: req.method, headers: { ...req.headers, host: up.host } }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      p.end(body);
    });
  });
  server.keepAliveTimeout = 120_000; server.headersTimeout = 121_000;
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => { server.close(r); server.closeAllConnections?.(); }) })));
}
let keyN = 0;
const route = r => { const key = `k${keyN++}`; routes.set(key, r); return key; };
const urlOf = key => `${front.url}/${key}/r.git`;
const ply = url => new GitHttp(url, { tracer: new Tracer() });
const gitIn = async (args, cwd) => gitAsync(cwd ?? root, ['-c', 'protocol.version=2', ...args]);
const freshRepo = name => { const d = join(root, `c-${name}-${keyN}`); rmSync(d, { recursive: true, force: true }); git(root, ['init', '-q', d]); return d; };
// the request lines of a v2 command body, after the delim (capabilities before it: command, agent, object-format)
const requestArgs = body => {
  const { frames } = pktStep(pktInit(), new Uint8Array(body));
  const out = { caps: [], args: [] };
  let after = false;
  for (const f of frames) { if (f.kind === 'delim') after = true; else if (f.kind === 'data') (after ? out.args : out.caps).push(td.decode(f.payload).replace(/\n$/, '')); }
  return out;
};
const fetchBodies = key => (posts.get(key) ?? []).map(requestArgs).filter(r => r.caps.includes('command=fetch'));

before(async () => {
  ({ root, cleanup } = tmpRoot());
  const hookCfg = join(root, 'gitconfig'); hookLog = join(root, 'hooklog');
  writeFileSync(hookCfg, `[uploadpack]\n\tpackObjectsHook = ${fileURLToPath(new URL('../fuzz/pack-objects-hook.sh', import.meta.url))}\n`);
  backend = await startGitServer(root, { GIT_CONFIG_GLOBAL: hookCfg, PLY_HOOK_LOG: hookLog });
  front = await startFront(backend.url);
  const work = join(root, 'work'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  const commit = (f, m) => { writeFileSync(join(work, f), `${m}\n`.repeat(40)); git(work, ['add', f]); git(work, ['-c', 'user.name=a', '-c', 'user.email=a@b', 'commit', '-q', '-m', m]); return git(work, ['rev-parse', 'HEAD']).trim(); };
  commit('a', 'one'); const two = commit('b', 'two');
  git(work, ['-c', 'user.name=a', '-c', 'user.email=a@b', 'tag', '-a', '-m', 'v1', 'v1', two]);
  commit('c', 'three'); const main = commit('d', 'four');
  git(work, ['checkout', '-q', '-b', 'other', two]); const other = commit('e', 'other'); git(work, ['checkout', '-q', 'main']);
  for (const name of ['fx', 'rq-on', 'rq-off']) {
    const bare = makeBareRepo(root, name);
    git(work, ['push', '-q', bare, 'main', 'other', 'v1']);
    git(bare, ['config', 'uploadpack.allowFilter', String(name !== 'rq-off')]);
    if (name === 'fx') for (const k of ['uploadpack.allowRefInWant', 'uploadpack.allowSidebandAll']) git(bare, ['config', k, 'true']);
  }
  fx = { main, tag: git(work, ['rev-parse', 'v1']).trim(), peeled: two, other };
  fx256 = { main: 'c'.repeat(64), tag: 'd'.repeat(64), peeled: 'e'.repeat(64), other: 'f'.repeat(64) };
});
after(async () => { await front?.close(); await backend?.close(); cleanup?.(); });

const REAL_CONFIGS = [
  { name: 'default (allowFilter)', config: [], cell: {} },
  { name: 'uploadpack.allowFilter=false', config: [['uploadpack.allowFilter', 'false']], cell: { fetch: ['shallow', 'wait-for-done'] } },
  { name: 'allowRefInWant + allowSidebandAll', config: [['uploadpack.allowRefInWant', 'true'], ['uploadpack.allowSidebandAll', 'true']], cell: { fetch: S.FETCH_FEATURES } },
  { name: 'lsrefs.unborn=ignore', config: [['lsrefs.unborn', 'ignore']], cell: { lsRefs: 'plain' } },
  { name: 'transfer.advertiseSID=true', config: [['transfer.advertiseSID', 'true']], cell: { sessionId: 'present' } },
  { name: 'sha256 repository', config: [], sha256: true, cell: { objectFormat: 'sha256' } },
];
const capsCell = over => {
  const c = { protocol: S.PROTOCOLS[0] };
  for (const a of S.CAPS_AXES) {
    const want = over[a.name] ?? (a.name === 'fetch' ? S.CANONICAL_CAPS.fetch.split(',') : S.CANONICAL_CAPS[a.name]);
    c[a.name] = a.name === 'fetch' ? a.variants.find(v => v.tag === 'features' && v.set.join(',') === want.join(',')) : a.variants.find(v => v.tag === want);
  }
  return c;
};
// the advertisement as lines, with the run's agent and session id normalized; a capability the model has no axis for (a
// newer git's) is dropped and reported, and so are fetch features beyond the five
const MODELLED = /^(version 2|agent|ls-refs|fetch|server-option|object-format|session-id)(=|\n|$)/;
const advLines = (body, extra = []) => pktStep(pktInit(), new Uint8Array(body)).frames
  .map(f => (f.kind === 'data' ? td.decode(f.payload) : `<${f.kind}>`))
  .filter(l => l.startsWith('<') || MODELLED.test(l) || (extra.push(l.trim()), false))
  .map(l => l.replace(/^agent=git\/.*\n$/, `agent=${S.AGENT}\n`).replace(/^session-id=.*\n$/, 'session-id=sid-1\n')
    .replace(/^fetch=(.*)\n$/, (_, v) => `fetch=${v.split(' ').filter(x => S.FETCH_FEATURES.includes(x)).join(' ')}\n`));

test('real git http-backend configurations advertise exactly what the renderer writes for their cell', async t => {
  for (const rc of REAL_CONFIGS) {
    const name = `real-${rc.name.replace(/\W+/g, '-')}`;
    const bare = join(root, `${name}.git`);
    git(root, ['init', '--bare', '-q', '-b', 'main', ...(rc.sha256 ? ['--object-format=sha256'] : []), bare]);
    for (const [k, v] of [['uploadpack.allowFilter', 'true'], ['http.receivepack', 'true'], ...rc.config]) git(bare, ['config', k, v]);
    const res = await fetch(`${backend.url}/${name}.git/info/refs?service=git-upload-pack`, { headers: { 'Git-Protocol': 'version=2' } });
    assert.equal(res.headers.get('content-type'), 'application/x-git-upload-pack-advertisement');
    const unmodelled = [];
    const real = advLines(Buffer.from(await res.arrayBuffer()), unmodelled);
    if (unmodelled.length) t.diagnostic(`${rc.name}: capabilities with no axis (this git is newer than the model): ${unmodelled.join(', ')}`);
    const cell = capsCell(rc.cell);
    assert.deepEqual(real, advLines(S.renderCaps(cell, fx).body), rc.name);
    const got = await outcomeOf(() => ply(`${backend.url}/${name}.git`).discover(), capsOk);
    if (got.info) { got.info.agent = got.info.agent.replace(/^git\/.*/, S.AGENT); got.info.fetch = got.info.fetch.filter(x => S.FETCH_FEATURES.includes(x)); if (got.info.sessionId) got.info.sessionId = 'sid-1'; }
    assert.equal(judge(S.expectedCaps(cell).ply, got), null, `${rc.name}: ply discover`);
    t.diagnostic(`${rc.name}: ${S.capsCellId(cell)} → ${got.tag}`);
  }
});

test('caps: every cell within one deviation of git\'s default, judged by git ls-remote and git fetch', async t => {
  const cells = S.capsCells().filter(c => S.capsDeviations(c) <= 1);
  const bad = [];
  for (const c of cells) {
    const want = S.expectedCaps(c);
    const e = c.protocol.tag === 'v2' ? S.effectiveCaps(c) : null;
    const key = route({ kind: 'synthetic', repo: 'fx.git', caps: S.renderCaps(c, fx), refs: S.renderRefs({ record: { tag: 'plain' }, eol: { tag: 'lf' }, framing: { tag: 'flush' } }, e?.objectFormat === 'sha256' ? fx256 : fx) });
    const id = S.capsCellId(c);
    const ls = await gitIn(['ls-remote', urlOf(key)]);
    const lsGot = ls.status === 0 ? 'ok' : 'refuse';
    if (lsGot !== want.git.lsRemote) bad.push(`${id}: git ls-remote ${lsGot} (${ls.stderr.trim().split('\n').pop()}), table ${want.git.lsRemote}`);
    const got = await outcomeOf(() => ply(urlOf(key)).discover(), capsOk);
    const w = judge(want.ply, got); if (w) bad.push(`${id}: ply over HTTP: ${w}`);
    // git fetch on the cells that vary the fetch command, and git's default: which features git uses, from its requests
    if (c.protocol.tag === 'v2' && e.objectFormat === 'sha1' && want.git.lsRemote === 'ok' && (S.capsDeviations(c) === 0 || (c.fetch.tag !== 'features' || c.fetch.set.join(',') !== S.CANONICAL_CAPS.fetch))) {
      const plain = await gitIn(['fetch', '-q', '--no-tags', '--filter=blob:none', urlOf(key), 'refs/heads/main'], freshPartial());
      const fetchGot = plain.status === 0 ? 'ok' : 'refuse';
      if (fetchGot !== want.git.fetch) bad.push(`${id}: git fetch ${fetchGot} (${plain.stderr.trim().split('\n').pop()}), table ${want.git.fetch}`);
      if (fetchGot === 'ok') {
        const args = fetchBodies(key).flatMap(b => b.args);
        const used = new Set();
        if (args.some(a => a.startsWith('filter '))) used.add('filter');
        if (args.includes('sideband-all')) used.add('sideband-all');
        if (args.some(a => a.startsWith('want-ref '))) used.add('ref-in-want');
        // by oid: with ref-in-want git 2.50 cannot read a deepened want-ref response ("expected 'packfile', received 'shallow-info'")
        const deep = await gitIn(['fetch', '-q', '--no-tags', '--depth=1', urlOf(key), fx.main], freshRepo('deep'));
        if (deep.status === 0) used.add('shallow');
        else if (!/Server does not support shallow requests/.test(deep.stderr)) bad.push(`${id}: git fetch --depth=1: ${deep.stderr.trim()}`);
        const plyFeatures = want.ply.tag === 'ok' ? want.ply.info.fetch.filter(f => f !== 'wait-for-done') : [];
        if ([...used].sort().join() !== plyFeatures.sort().join()) bad.push(`${id}: git uses [${[...used].sort()}], ply reads [${plyFeatures.sort()}]`);
        if (!/filtering not recognized by server/.test(plain.stderr) !== used.has('filter')) bad.push(`${id}: git's filter warning disagrees with its request`);
      }
    }
    observed.caps++;
  }
  t.diagnostic(`caps observed=${cells.length}`);
  assert.deepEqual(bad, []);
});
const freshPartial = () => { const d = freshRepo('partial'); git(d, ['config', 'extensions.partialClone', 'origin']); git(d, ['config', 'remote.origin.promisor', 'true']); return d; };

test('refs: every cell, judged by git ls-remote; a duplicate ref resolves to its first listing in git fetch', async t => {
  const bad = [];
  for (const c of S.refsCells()) {
    const want = S.expectedRefs(c, fx);
    const key = route({ kind: 'synthetic', repo: 'fx.git', caps: S.renderCaps(capsCell({}), fx), refs: S.renderRefs(c, fx) });
    const ls = await gitIn(['ls-remote', urlOf(key)]);
    const lsGot = ls.status === 0 ? 'ok' : 'refuse';
    if (lsGot !== want.git) bad.push(`${S.refsCellId(c)}: git ls-remote ${lsGot} (${ls.stderr.trim().split('\n').pop()}), table ${want.git}`);
    const got = await outcomeOf(() => ply(urlOf(key)).lsRefs(), refsOk);
    const w = judge(want.ply, got); if (w) bad.push(`${S.refsCellId(c)}: ply over HTTP: ${w}`);
    if (c.record.tag === 'duplicate' && c.eol.tag === 'lf' && c.framing.tag === 'flush') {
      const d = freshRepo('dup');
      const f = await gitIn(['fetch', '-q', '--no-tags', urlOf(key), 'refs/heads/main'], d);
      assert.equal(f.status, 0, f.stderr);
      assert.equal(git(d, ['rev-parse', 'FETCH_HEAD']).trim(), fx.main, 'git fetch takes the first listing of a ref');
      assert.equal(got.refs?.find(r => r[0] === 'refs/heads/main')?.[1], fx.main, 'ply takes the first listing of a ref');
    }
    observed.refs++;
  }
  t.diagnostic(`refs observed=${observed.refs}`);
  assert.deepEqual(bad, []);
});

test('push: request × advertised atomic × advertised push-options × object-format, judged by git push', async t => {
  const work = join(root, 'pushwork'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  git(work, ['-c', 'user.name=a', '-c', 'user.email=a@b', 'commit', '-q', '--allow-empty', '-m', 'base']);
  const base = git(work, ['rev-parse', 'HEAD']).trim();
  git(work, ['-c', 'user.name=a', '-c', 'user.email=a@b', 'commit', '-q', '--allow-empty', '-m', 'next']);
  const next = git(work, ['rev-parse', 'HEAD']).trim();
  const obj = { oid: next, type: 1, data: new Uint8Array(git(work, ['cat-file', 'commit', next], { encoding: 'buffer' })) };
  const bad = [];
  for (const c of S.pushCells()) {
    const want = S.expectedPush(c);
    const name = `push-${observed.push}`; const bare = join(root, `${name}.git`);
    git(root, ['init', '--bare', '-q', '-b', 'main', `--object-format=${c.format.tag}`, bare]);
    for (const [k, v] of [['http.receivepack', 'true'], ['receive.advertiseAtomic', String(c.atomic.tag === 'on')], ['receive.advertisePushOptions', String(c.options.tag === 'on')]]) git(bare, ['config', k, v]);
    if (c.format.tag === 'sha1') git(work, ['push', '-q', bare, `${base}:refs/heads/main`]);
    const refsBefore = git(bare, ['for-each-ref']);
    const atomic = c.request.tag === 'atomic' || c.request.tag === 'both', options = c.request.tag === 'options' || c.request.tag === 'both';
    const g = await gitAsync(work, ['push', '--porcelain', ...(atomic ? ['--atomic'] : []), ...(options ? ['-o', 'x'] : []), `${backend.url}/${name}.git`, `${next}:refs/heads/g`]);
    const gitGot = g.status === 0 ? 'ok' : 'refuse';
    if (gitGot !== want.git.tag) bad.push(`${S.pushCellId(c)}: git push ${gitGot}, table ${want.git.tag}: ${g.stderr.trim()}`);
    if (want.git.tag === 'refuse' && !g.stderr.includes(S.GIT_PUSH_REFUSAL[want.git.why])) bad.push(`${S.pushCellId(c)}: git's refusal is not "${S.GIT_PUSH_REFUSAL[want.git.why]}": ${g.stderr.trim()}`);
    if (want.git.tag === 'refuse' && git(bare, ['for-each-ref']) !== refsBefore) bad.push(`${S.pushCellId(c)}: git's refused push moved a ref`);
    let got;
    try { await ply(`${backend.url}/${name}.git`).push({ ref: 'refs/heads/p', oldOid: '0'.repeat(40), newOid: next, objects: [obj], atomic, pushOptions: options ? ['x'] : [] }); got = { tag: 'landed' }; } catch (e) { got = { tag: e.code, message: e.message }; }
    if (got.tag !== want.ply.tag) bad.push(`${S.pushCellId(c)}: ply ${got.tag} (${got.message ?? ''}), table ${want.ply.tag}`);
    const landed = git(bare, ['for-each-ref', '--format=%(refname)']).split('\n').includes('refs/heads/p');
    if (landed !== (want.ply.tag === 'landed')) bad.push(`${S.pushCellId(c)}: refs/heads/p ${landed ? 'landed' : 'absent'} after ply's ${got.tag}`);
    if (want.ply.tag === 'unsupported' && !new RegExp({ hash: 'object-format sha256', atomic: 'advertise atomic', options: 'advertise push-options' }[want.ply.why]).test(got.message)) bad.push(`${S.pushCellId(c)}: ply's refusal names the wrong need: ${got.message}`);
    observed.push++;
  }
  t.diagnostic(`push observed=${observed.push}`);
  assert.deepEqual(bad, []);
});

test('request: fetch arguments ply sends, judged by git fetch\'s own request and upload-pack\'s pack-objects invocation', async t => {
  const bad = [];
  const hook = () => ({ args: readFileSync(`${hookLog}.args`, 'utf8').trim().replace(/^git (--shallow-file \S* )?pack-objects /, ''), stdin: readFileSync(`${hookLog}.stdin`, 'utf8').trim().split('\n').sort().join('\n') });
  const clearHook = () => { for (const s of ['.args', '.stdin']) rmSync(`${hookLog}${s}`, { force: true }); };
  for (const c of S.requestCells()) {
    const want = S.expectedRequest(c);
    const repo = c.server.tag === 'filterOn' ? 'rq-on.git' : 'rq-off.git';
    const id = S.requestCellId(c);
    // git, with the option that sends the flag (and --no-tags / --no-progress so nothing else differs)
    const gkey = route({ kind: 'proxy', repo });
    const f = c.flag.tag;
    let g, gitHook = null;
    if (f === 'filter') {
      const d = join(root, `clone-${keyN}`);
      clearHook();
      g = await gitIn(['clone', '-q', '--bare', '--no-tags', '--single-branch', '--branch', 'main', '--filter=blob:none', urlOf(gkey), d]);
    } else {
      const d = freshRepo('rq');
      if (f === 'deepenRelative') { const s = await gitIn(['fetch', '-q', '--no-tags', '--no-progress', '--depth=1', urlOf(gkey), 'refs/heads/main:refs/heads/main'], d); assert.equal(s.status, 0, s.stderr); posts.set(gkey, []); }
      clearHook();
      const opt = { noProgress: ['--no-tags', '--no-progress'], progress: ['--no-tags', '--progress'], includeTag: ['--no-progress'], deepenRelative: ['--no-tags', '--no-progress', '--deepen=1'] }[f];
      g = await gitIn(['fetch', '-q', ...opt, urlOf(gkey), 'refs/heads/main:refs/heads/main'], d);
    }
    if ((g.status === 0 ? 'ok' : 'refuse') !== want.git) { bad.push(`${id}: git ${g.status}: ${g.stderr.trim()}`); continue; }
    gitHook = existsSync(`${hookLog}.args`) ? hook() : null;
    // the last request (a deepen-relative fetch is one round without `done`: the server answers ready and the pack)
    const gb = fetchBodies(gkey).pop();
    if (!gb) { bad.push(`${id}: no git fetch request`); continue; }
    const flagLine = { noProgress: 'no-progress', progress: null, includeTag: 'include-tag', deepenRelative: 'deepen-relative', filter: 'filter blob:none' }[f];
    if (flagLine && gb.args.includes(flagLine) !== want.gitSendsFlag) bad.push(`${id}: git ${want.gitSendsFlag ? 'did not send' : 'sent'} "${flagLine}"`);
    if (f === 'progress' && gb.args.includes('no-progress')) bad.push(`${id}: git --progress sent no-progress`);
    // ply, with git's request as its arguments
    const val = p => gb.args.filter(a => a.startsWith(`${p} `)).map(a => a.slice(p.length + 1));
    const req = { wants: val('want'), haves: val('have'), shallows: val('shallow'), deepen: Number(val('deepen')[0] ?? 0) || undefined, deepenRelative: gb.args.includes('deepen-relative'), includeTag: gb.args.includes('include-tag'), noProgress: gb.args.includes('no-progress'), thinPack: gb.args.includes('thin-pack'), ofsDelta: gb.args.includes('ofs-delta'), done: gb.args.includes('done'), filter: f === 'filter' ? 'blob:none' : undefined };
    const pkey = route({ kind: 'proxy', repo });
    clearHook();
    // a deepen from a shallow boundary comes as a thin pack against the have: its bases are the client's objects
    const bare = join(root, repo);
    const external = oid => { try { const type = git(bare, ['cat-file', '-t', oid]).trim(); return { type: { commit: 1, tree: 2, blob: 3, tag: 4 }[type], data: new Uint8Array(git(bare, ['cat-file', type, oid], { encoding: 'buffer' })) }; } catch { return undefined; } };
    const got = await outcomeOf(() => ply(urlOf(pkey)).fetchPack(req, { external }), r => ({ objects: r.objects.size }));
    if (got.tag !== want.ply.tag) { bad.push(`${id}: ply ${got.tag} (${got.message ?? ''}), table ${want.ply.tag}`); continue; }
    if (got.tag === 'ok') {
      const pb = fetchBodies(pkey).pop();
      const norm = a => [...a].sort().join('\n');
      if (norm(pb.args) !== norm(gb.args)) bad.push(`${id}: request lines differ:\n  git ${norm(gb.args).replace(/\n/g, ' | ')}\n  ply ${norm(pb.args).replace(/\n/g, ' | ')}`);
      const plyHook = hook();
      if (!gitHook || plyHook.args !== gitHook.args || plyHook.stdin !== gitHook.stdin) bad.push(`${id}: pack-objects invocation differs: git ${JSON.stringify(gitHook)} ply ${JSON.stringify(plyHook)}`);
      t.diagnostic(`${id}: pack-objects ${plyHook.args}`);
    }
    observed.request++;
  }
  assert.deepEqual(bad, []);
});

test('SPACE.md carries the generated advertisement block (node scripts/space-md.mjs --write)', async () => {
  const doc = await import('../../scripts/space-md.mjs');
  assert.equal(doc.currentAdvertisement(), S.mdBlock(S.observedCounts()), 'SPACE.md is stale: run node scripts/space-md.mjs --write');
});
// the observed counts the block states are the cells the observed tests above ran
test('every observed cell ran', () => { assert.deepEqual(observed, S.observedCounts()); });
