// readLog (#56) against git as the oracle, over git http-backend. The space is a product of tagged unions:
//
//   server     tree0 (git's default) | blobnone (Artifacts-like: every filter but blob:none is a 400, test/proxy.js)
//   shape      linear | merges | root (root within every limit but 1) | exact (first-parent length = n) | longer
//   limit      1 | n | big (larger than every history but `longer`)
//   behaviour  honest | omit-shallow (the shallow-info section dropped) | foreign (one commit that is not an ancestor
//              of the want, added by asking upload-pack for it as a second want)
//
// Every cell's expected outcome comes from git alone: the commits from `git rev-list --first-parent -n <limit>` and
// `git log` / `git cat-file` for each, `truncated` from `git rev-list --first-parent --count`, and whether a cut graph
// exists (some commit at depth ≥ limit, from `git rev-list --parents`) for the omit-shallow cells: with a cut, dropping
// the shallow lines is a withheld parent (`pack_corrupt`, #37); without one there are no shallow lines to drop and the
// answer is git's. A foreign commit is always `pack_corrupt`.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer } from './server.js';
import { startProxy } from './proxy.js';
import { readLog, logWindow } from '../src/log.js';
import { listTree } from '../src/read.js';
import { createTransport } from '../src/http.js';
import { pkt } from '../src/pktline.js';
import { concat } from '../src/bytes.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';

const REJECT = 'Unsupported Git fetch filter; only blob:none is supported.';
const N = 5, BIG = 64;
const LIMITS = { 1: 1, n: N, big: BIG };
const SHAPES = ['linear', 'merges', 'root', 'exact', 'longer'];
const SERVERS = ['tree0', 'blobnone'];
const BEHAVIOURS = ['honest', 'omit-shallow', 'foreign'];

let root, cleanup, srv;
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv.close(); cleanup(); });

const spansOf = ex => ex.lines.flatMap(flattenLine);
const filterOf = body => /filter ([^\n]+)\n/.exec(Buffer.from(body).toString('latin1'))?.[1] ?? null;

// ---- histories, built with plumbing at fixed dates ----
function builder(bare) {
  let clock = 1_700_000_000, k = 0;
  return (parents, msg = null, { date = null, author = ['A U Thor', 'a@x'] } = {}) => {
    const n = k++; const t = date ?? (clock += 60);
    const blob = gitBuf(bare, ['hash-object', '-w', '--stdin'], Buffer.from(`content ${n}\n`)).toString().trim();
    const tree = gitBuf(bare, ['mktree'], `100644 blob ${blob}\tf${n % 3}.txt\n`).toString().trim();
    const env = { ...process.env, GIT_AUTHOR_NAME: author[0], GIT_AUTHOR_EMAIL: author[1], GIT_AUTHOR_DATE: `${t} +0130`, GIT_COMMITTER_NAME: 'C', GIT_COMMITTER_EMAIL: 'c@x', GIT_COMMITTER_DATE: `${t + 7} -0800` };
    return git(bare, ['commit-tree', tree, ...parents.flatMap(p => ['-p', p]), '-m', msg ?? `commit ${n}`], { env }).trim();
  };
}
const chain = (mk, from, len, tag) => { let c = from; for (let i = 0; i < len; i++) c = mk(c ? [c] : [], `${tag} ${i}`); return c; };

function buildShape(bare, shape) {
  const mk = builder(bare);
  let head;
  if (shape === 'linear') head = chain(mk, null, 12, 'linear');
  if (shape === 'merges') {
    // first-parent length 12: two --no-ff merges of 3-commit branches (dated after the main line, so a date-ordered walk
    // would interleave them) and an octopus; one non-ASCII author, one multi-line message
    let c = chain(mk, null, 3, 'base');
    const fork1 = c; c = chain(mk, c, 2, 'main');
    const side1 = chain(mk, fork1, 3, 'side1');
    c = mk([c, side1], "Merge branch 'side1'\n\nbody line\n    indented\n");
    const s2 = mk([c], 'oct a'), s3 = mk([c], 'oct b', { author: ['Zoë Ångström 李雷', 'zoë@exämple.org'] });
    c = mk([mk([c], 'pre-octopus'), s2, s3], 'octopus');
    c = chain(mk, c, 2, 'main2');
    const side2 = chain(mk, c, 3, 'side2');
    c = mk([mk([c], 'main3'), side2], "Merge branch 'side2'");
    head = c;
  }
  if (shape === 'root') { const r0 = mk([], 'root'); const side = mk([r0], 'side'); head = mk([mk([r0], 'one'), side], 'merge side'); } // first-parent 3
  if (shape === 'exact') { // first-parent length N; a side branch longer than N, so the window is cut on the side
    const r0 = mk([], 'root'); const side = chain(mk, r0, N + 3, 'long side');
    let c = chain(mk, r0, N - 2, 'main'); head = mk([c, side], 'merge long side');
  }
  if (shape === 'longer') { let c = null; for (let i = 0; i < 80; i++) { c = mk(c ? [c] : [], `l ${i}`); if (i % 10 === 9) c = mk([c, mk([c], `topic ${i}`)], `merge topic ${i}`); } head = c; }
  git(bare, ['update-ref', 'refs/heads/main', head]);
  git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  // the foreign commit: a child of head, so a pack that carries it is the honest window plus one commit
  git(bare, ['update-ref', 'refs/heads/foreign', mk([head], 'foreign')]);
  return head;
}

// ---- the oracle: git only ----
const SEP = '\x1f', REC = '\x1e';
const FMT = ['%H', '%T', '%P', '%an', '%ae', '%at', '%ad', '%cn', '%ce', '%ct', '%cd'].join(SEP);
function oracle(bare, head, limit) {
  const env = { ...process.env, TZ: 'UTC' };
  const raw = git(bare, ['log', '--first-parent', '-n', String(limit), '--date=raw', `--format=${FMT}${REC}`, head], { env }).split(`${REC}\n`).filter(Boolean);
  const iso = git(bare, ['log', '--first-parent', '-n', String(limit), '--date=iso-strict-local', `--format=%ad${SEP}%cd${REC}`, head], { env }).split(`${REC}\n`).filter(Boolean);
  const commits = raw.map((line, i) => {
    const [oid, tree, parents, an, ae, at, ad, cn, ce, ct, cd] = line.split(SEP);
    const [aiso, ciso] = iso[i].split(SEP).map(d => d.replace(/\+00:00$/, 'Z'));
    const body = gitBuf(bare, ['cat-file', 'commit', oid]).toString('utf8');
    return { oid, tree, parents: parents ? parents.split(' ') : [],
      author: { name: an, email: ae, time: aiso, epoch: Number(at), tz: ad.split(' ')[1] },
      committer: { name: cn, email: ce, time: ciso, epoch: Number(ct), tz: cd.split(' ')[1] },
      message: body.slice(body.indexOf('\n\n') + 2), signed: /^gpgsig(-sha256)? /m.test(body.slice(0, body.indexOf('\n\n'))) };
  });
  assert.deepEqual(commits.map(c => c.oid), git(bare, ['rev-list', '--first-parent', '-n', String(limit), head]).trim().split('\n'), 'git log and git rev-list agree');
  const fpCount = Number(git(bare, ['rev-list', '--first-parent', '--count', head]).trim());
  // depth from head (0-based, shortest path) over the whole history: a commit at depth ≥ limit is outside the window, so
  // the window is cut and an honest server sends shallow lines
  const parentsOf = new Map(git(bare, ['rev-list', '--parents', head]).trim().split('\n').map(l => { const [c, ...ps] = l.split(' '); return [c, ps]; }));
  const depth = new Map([[head, 0]]); const q = [head];
  for (let i = 0; i < q.length; i++) for (const p of parentsOf.get(q[i])) if (!depth.has(p)) { depth.set(p, depth.get(q[i]) + 1); q.push(p); }
  return { commits, truncated: fpCount > limit, cut: [...depth.values()].some(d => d >= limit), fpCount };
}

// ---- the server's behaviour, in a proxy in front of http-backend ----
// Drop the shallow-info section (its header, lines and the delim after it) from a v2 fetch response.
function omitShallow(bytes) {
  const out = []; let o = 0, skipping = false;
  while (o < bytes.length) {
    const len = parseInt(Buffer.from(bytes.subarray(o, o + 4)).toString('latin1'), 16);
    const end = o + (len < 4 ? 4 : len);
    const payload = len >= 4 ? Buffer.from(bytes.subarray(o + 4, end)).toString('latin1') : null;
    if (payload === 'shallow-info\n') skipping = true;
    else if (skipping && len === 1) { skipping = false; o = end; continue; }
    if (!skipping) out.push(bytes.subarray(o, end));
    if (payload === 'packfile\n') { out.push(bytes.subarray(end)); break; }
    o = end;
  }
  return concat(out);
}
// Ask upload-pack for one more want than the client did (inserted after the client's first want).
async function withForeign(url, reqBody, foreign) {
  const s = Buffer.from(reqBody).toString('latin1'); const at = s.indexOf('want ');
  const cut = at - 4 + parseInt(s.slice(at - 4, at), 16);
  const body = concat([reqBody.subarray(0, cut), pkt(`want ${foreign}\n`), reqBody.subarray(cut)]);
  const res = await fetch(`${url}/git-upload-pack`, { method: 'POST', body, headers: { 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' } });
  return new Uint8Array(await res.arrayBuffer());
}
function serverFault(state) {
  return ctx => {
    if (ctx.stage !== 'fetch') return null;
    const narrow = filterOf(ctx.reqBody) !== null && filterOf(ctx.reqBody) !== 'blob:none';
    if (state.server === 'blobnone' && narrow) return ctx.phase === 'request' ? null : { type: 'status', status: 400, contentType: 'text/plain; charset=utf-8', body: REJECT };
    if (state.behaviour === 'foreign' && ctx.phase === 'request') return { type: 'bytes', noForward: true, name: 'foreign', bytes: withForeign(state.upstream, ctx.reqBody, state.foreign) };
    if (state.behaviour === 'omit-shallow' && ctx.phase !== 'request' && ctx.status === 200) return { type: 'bytes', name: 'omit-shallow', bytes: omitShallow(ctx.bytes) };
    return ctx.phase === 'request' ? null : { type: 'pass' };
  };
}

test('logWindow (pure): first parent, truncated, the deepen contract', () => {
  const C = (...parents) => ({ parents });
  const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40), d = 'd'.repeat(40), x = 'e'.repeat(40);
  const m = new Map([[a, C(b, c)], [b, C(d)], [c, C(d)], [d, C()]]);
  assert.deepEqual(logWindow(m, [], a, 1), { chain: [a], truncated: true, cut: false });
  assert.deepEqual(logWindow(m, [], a, 3), { chain: [a, b, d], truncated: false, cut: false });
  assert.deepEqual(logWindow(m, [], a, 9), { chain: [a, b, d], truncated: false, cut: false });
  const cutAtB = new Map([[a, C(b, c)], [b, C(d)], [c, C(d)]]);
  assert.deepEqual(logWindow(cutAtB, [b, c], a, 5), { chain: [a, b], truncated: true, cut: true }, 'a server-side shallow boundary');
  assert.throws(() => logWindow(cutAtB, [c], a, 5), e => e.code === 'pack_corrupt' && /withheld and .* not reported shallow/.test(e.message));
  assert.throws(() => logWindow(new Map([...m, [x, C()]]), [], a, 5), e => e.code === 'pack_corrupt' && /not an ancestor/.test(e.message));
  assert.throws(() => logWindow(new Map([[b, C()]]), [], a, 5), e => e.code === 'pack_corrupt' && /not in the pack/.test(e.message));
});

test('readLog: server × shape × limit × behaviour, every cell against git', async () => {
  const state = { server: 'tree0', behaviour: 'honest', upstream: null, foreign: null };
  const proxy = await startProxy(srv.url, serverFault(state));
  const tally = { cells: 0, equal: 0, pack_corrupt: 0 };
  try {
    for (const shape of SHAPES) {
      const name = `log-${shape}`; const bare = makeBareRepo(root, name);
      const head = buildShape(bare, shape);
      state.upstream = `${srv.url}/${name}.git`; state.foreign = git(bare, ['rev-parse', 'foreign']).trim();
      const url = `${proxy.url}/${name}.git`;
      for (const [lname, limit] of Object.entries(LIMITS)) {
        const want = oracle(bare, head, limit);
        for (const server of SERVERS) for (const behaviour of BEHAVIOURS) {
          Object.assign(state, { server, behaviour });
          const cell = `${server} × ${shape} × limit ${lname} (${limit}) × ${behaviour}`;
          const fetchesBefore = proxy.log.filter(l => l.stage === 'fetch').length;
          const ex = arrayExporter(); const quirks = {};
          const run = readLog(url, { ref: 'main', limit }, { tracer: new Tracer({ exporter: ex }), quirks });
          tally.cells++;
          if (behaviour === 'foreign' || (behaviour === 'omit-shallow' && want.cut)) {
            await assert.rejects(run, e => e.code === 'pack_corrupt' && (behaviour === 'foreign' ? /not an ancestor/ : /not reported shallow/).test(e.message), cell);
            tally.pack_corrupt++;
          } else {
            const got = await run;
            assert.deepEqual(got, { ref: 'refs/heads/main', oid: head, commits: want.commits, truncated: want.truncated }, cell);
            const root = spansOf(ex).find(s => s.name === 'git.read_log').attrs;
            assert.equal(root['git.read_log.filter'], server === 'tree0' ? 'tree:0' : 'blob:none', cell);
            assert.equal(root['git.read_log.commits'], want.commits.length, cell);
            tally.equal++;
          }
          // one fetch; on the blob:none server one 400 first (learned into quirks)
          assert.equal(proxy.log.filter(l => l.stage === 'fetch').length - fetchesBefore, server === 'tree0' ? 1 : 2, `${cell}: fetches`);
          if (server === 'blobnone') assert.equal(quirks.treeFilter, 'blob:none', cell);
        }
      }
    }
  } finally { await proxy.close(); }
  assert.equal(tally.cells, SERVERS.length * SHAPES.length * Object.keys(LIMITS).length * BEHAVIOURS.length);
  console.log(`  ${tally.cells} cells: ${tally.equal} equal to git, ${tally.pack_corrupt} pack_corrupt as predicted`);
});

test('readLog on a shallow server repository: the log stops at the server\'s cut, truncated, as git log there does', async () => {
  const src = makeBareRepo(root, 'log-src'); const head = buildShape(src, 'linear');
  const bare = join(root, 'log-shallow.git');
  git(root, ['clone', '-q', '--bare', '--depth', '3', `file://${src}`, bare]);
  for (const [k, v] of [['uploadpack.allowFilter', 'true'], ['protocol.version', '2']]) git(bare, ['config', k, v]);
  for (const server of SERVERS) {
    const proxy = await startProxy(srv.url, serverFault({ server, behaviour: 'honest' }));
    try {
      const got = await readLog(`${proxy.url}/log-shallow.git`, { ref: 'main', limit: N }, { tracer: new Tracer() });
      assert.deepEqual(got.commits.map(c => c.oid), git(bare, ['rev-list', '--first-parent', head]).trim().split('\n'), server);
      assert.equal(got.commits.length, 3); assert.equal(got.truncated, true, 'history continues past the cut');
    } finally { await proxy.close(); }
  }
});

test('readLog: refs, not_found, bad_request; never a TypeError', async () => {
  const bare = makeBareRepo(root, 'log-refs'); const head = buildShape(bare, 'root');
  git(bare, ['tag', '-a', '-m', 'annotated', 'v1', head]);
  const url = `${srv.url}/log-refs.git`; const opts = () => ({ tracer: new Tracer() });
  for (const [ref, name] of [[null, 'refs/heads/main'], ['HEAD', 'refs/heads/main'], ['v1', 'refs/tags/v1'], [head, head]]) {
    const r = await readLog(url, { ref, limit: 2 }, opts());
    assert.equal(r.ref, name); assert.equal(r.oid, head); assert.equal(r.commits.length, 2); assert.equal(r.truncated, true);
  }
  assert.equal((await readLog(url, undefined, opts())).commits.length, 3, 'default limit 20 > history');
  const code = c => e => e.code === c && !(e instanceof TypeError);
  await assert.rejects(readLog(url, { ref: 'nope' }, opts()), code('not_found'));
  const absent = 'f'.repeat(40);
  await assert.rejects(readLog(url, { ref: absent }, opts()), e => e.code === 'not_found' && e.miss?.kind === 'absent' && e.miss.oid === absent && !(e instanceof TypeError));
  const treeOid = git(bare, ['rev-parse', 'main^{tree}']).trim();
  await assert.rejects(readLog(url, { ref: treeOid }, opts()), e => e.code === 'not_found' && e.message === `${treeOid} is not a commit (tree)` && e.miss?.kind === 'not_commit' && e.miss.type === 'tree' && !(e instanceof TypeError));
  for (const limit of [0, -1, 1.5, '5', NaN, Infinity, null, 1025, 2 ** 53]) await assert.rejects(readLog(url, { limit }, opts()), code('bad_request'), String(limit));
  for (const bad of [null, 5, 'main']) await assert.rejects(readLog(url, bad, opts()), code('bad_request'), String(bad));
  await assert.rejects(readLog(url, {}, null), code('bad_request'));
  await assert.rejects(readLog(url, {}, {}), code('bad_request'), 'no tracer');
  await assert.rejects(readLog(url, { path: 'f0.txt' }, opts()), code('bad_request'), 'path is not supported');
  await assert.rejects(readLog(url, { ref: 'a..b' }, opts()), code('bad_request'));
  await assert.rejects(readLog(url, { ref: 7 }, opts()), code('bad_request'));
  assert.equal((await readLog(url, { limit: 1 }, { tracer: new Tracer(), limits: { ...(await import('../src/limits.js')).DEFAULT_LIMITS, maxMergeDepth: 1 } })).commits.length, 1);
});

test('readLog on blob:none: the trees are harvested; a following listTree on the same transport costs no fetch', async () => {
  const bare = makeBareRepo(root, 'log-harvest'); buildShape(bare, 'merges');
  const proxy = await startProxy(srv.url, serverFault({ server: 'blobnone', behaviour: 'honest' }));
  try {
    const tracer = new Tracer(); const t = createTransport(`${proxy.url}/log-harvest.git`, { tracer });
    const log = await readLog(null, { ref: 'main', limit: N }, { tracer, transport: t });
    const fetches = () => proxy.log.filter(l => l.stage === 'fetch').length;
    const before = fetches();
    for (const c of log.commits) {
      const ls = await listTree(null, { ref: c.oid }, { tracer, transport: t });
      assert.equal(ls.tree, c.tree); assert.deepEqual(ls.entries.map(e => e.oid), git(bare, ['ls-tree', '--format=%(objectname)', c.oid]).trim().split('\n'));
    }
    assert.equal(fetches(), before, 'every commit and root tree came from the harvest');
  } finally { await proxy.close(); }
});

// Wide trees, curl-shaped: 48 directories of 80 files, 12 commits each changing one file. Bytes on the wire for a
// 10-commit window under each filter (the fetch that answered; the blob:none figure excludes the 400).
test('bytes: a 10-commit window on a wide repository, tree:0 vs blob:none', async () => {
  const bare = makeBareRepo(root, 'log-wide'); const work = join(root, 'wwide');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  for (let d = 0; d < 48; d++) { mkdirSync(join(work, `dir${d}`)); for (let f = 0; f < 80; f++) writeFileSync(join(work, `dir${d}`, `file-with-a-longish-name-${f}.c`), `/* ${d}/${f} */\n`); }
  const id = ['-c', 'user.name=w', '-c', 'user.email=w@x'];
  git(work, ['add', '-A']); git(work, [...id, 'commit', '-q', '-m', 'seed']);
  for (let i = 0; i < 12; i++) { writeFileSync(join(work, `dir${(i * 7) % 48}`, 'file-with-a-longish-name-0.c'), `/* change ${i} */\n`); git(work, [...id, 'commit', '-q', '-am', `change ${i}`]); }
  git(work, ['push', '-q', bare, 'HEAD:refs/heads/main']);
  const measure = async server => {
    const proxy = await startProxy(srv.url, serverFault({ server, behaviour: 'honest' }));
    try {
      const quirks = server === 'blobnone' ? { treeFilter: 'blob:none' } : {};
      const ex = arrayExporter();
      const r = await readLog(`${proxy.url}/log-wide.git`, { ref: 'main', limit: 10 }, { tracer: new Tracer({ exporter: ex }), quirks });
      assert.deepEqual(r.commits.map(c => c.oid), git(bare, ['rev-list', '--first-parent', '-n', '10', 'main']).trim().split('\n'));
      const f = spansOf(ex).filter(s => s.name === 'git.upload-pack fetch');
      assert.equal(f.length, 1);
      return { pack: f[0].attrs['git.pack.bytes'], wire: f[0].attrs['git.response.bytes'], objects: f[0].attrs['git.pack.objects'] };
    } finally { await proxy.close(); }
  };
  const t0 = await measure('tree0'), bn = await measure('blobnone');
  console.log(`  10 commits, 48 dirs × 80 files: tree:0 ${t0.pack} B pack / ${t0.wire} B response, ${t0.objects} objects; blob:none ${bn.pack} B pack / ${bn.wire} B response, ${bn.objects} objects (${(bn.pack / t0.pack).toFixed(1)}×)`);
  assert.equal(t0.objects, 10, 'tree:0: the commits only');
  assert.ok(bn.objects > 10 + 48 && bn.pack > t0.pack);
});
