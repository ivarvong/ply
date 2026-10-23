// Safety invariants under a hostile/broken server and hostile caller input. Real git behind a fault proxy.
//   I1  Every run terminates (bounded by limits.requestTimeoutMs) with either a correct result or a typed error.
//   I2  On any error, the ref is unchanged — except a fault on the receive-pack *response*, where the ref is
//       either unchanged or exactly our commit (server applied it before the fault); never anything else.
//   I3  A successful result is always git-verified: ref == our commit, content == expected splice, fsck clean.
//   I4  Nothing an untrusted size field says is allocated before it is checked against limits.
//   I5  Caller strings that reach git objects or command lines are validated before any I/O.
//   I6  Secrets never appear in telemetry.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, commitFiles } from './server.js';
import { startProxy } from './proxy.js';
import { MUTATORS, MUTATOR_NAMES } from './fuzz/mutate.js';
import { Rng } from './fuzz/prng.js';
import { editFile } from '../src/edit.js';
import { GitHttp } from '../src/client.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { withLimits } from '../src/limits.js';
import { applyDelta, parsePack, buildPack, encodeObjHeader } from '../src/pack.js';
import { Sha1 } from '../src/sha1.js';
import { concat, te } from '../src/bytes.js';

const CODES = new Set(['pack_corrupt', 'protocol', 'network', 'timeout', 'aborted', 'not_git', 'auth', 'not_found', 'rate_limited', 'upstream_5xx', 'http', 'limit_exceeded', 'remote_error', 'match_count', 'cas_conflict', 'push_rejected', 'bad_request', 'unsupported', 'ambiguous']);
const AUTHOR = { name: 'adv', email: 'adv@x' };
const FILE = 'a/b/target.txt';
const ORIG = 'before MARK after\n', FIND = 'MARK', REPL = 'XX', EXPECTED = 'before XX after\n';

let root, cleanup, srv, n = 0;
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv.close(); cleanup(); });

function freshRepo() {
  const name = `adv${n++}`;
  const bare = makeBareRepo(root, name);
  const work = join(root, `w${name}`); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  commitFiles(work, bare, { [FILE]: ORIG, 'a/sibling.txt': 'x'.repeat(3000), 'c.txt': 'c' }, 'one');
  const head = commitFiles(work, bare, { 'c.txt': 'c2' }, 'two');
  return { name, bare, work, head };
}

// Run one edit through a proxy with the given fault; return everything needed to check invariants.
async function run(fault, { limits = withLimits({ requestTimeoutMs: 1500 }), find = FIND, replace = REPL, opts = {} } = {}) {
  const repo = freshRepo();
  const proxy = await startProxy(srv.url, fault);
  const exporter = arrayExporter();
  const tracer = new Tracer({ exporter });
  const t0 = performance.now();
  let result = null, error = null;
  try { result = await editFile(`${proxy.url}/${repo.name}.git`, { path: FILE, find, replace, author: AUTHOR, message: 'adv' }, { tracer, limits, ...opts }); }
  catch (e) { error = e; }
  const ms = performance.now() - t0;
  await proxy.close();
  const head = git(repo.bare, ['rev-parse', 'main']).trim();
  const content = gitBuf(repo.bare, ['cat-file', 'blob', `main:${FILE}`]).toString();
  const spans = exporter.lines.flatMap(flattenLine);
  rmSync(repo.work, { recursive: true, force: true });
  return { repo, result, error, ms, head, content, spans, log: proxy.log, exporter };
}

function checkInvariants(r, { stage, allowMoved = false, requireError = false }) {
  assert.ok(r.ms < 10000, `I1: took ${r.ms}ms`);
  if (r.error) {
    assert.ok(CODES.has(r.error.code), `I1: untyped error ${r.error.code}: ${r.error.message}\n${r.error.stack}`);
    const root = r.spans.find(s => s.name === 'git.edit');
    assert.equal(root.attrs['git.edit.outcome'], r.error.code, 'outcome attr matches error code');
    if (allowMoved && r.head !== r.repo.head) {
      assert.equal(r.error.code, 'ambiguous', `I2: ref moved on error → the error must say the outcome is unknown (got ${r.error.code})`);
      assert.equal(r.content, EXPECTED, 'I2: ref moved → must be exactly our edit');
      assert.equal(git(r.repo.bare, ['log', '-1', '--format=%P', r.head]).trim(), r.repo.head);
    } else assert.equal(r.head, r.repo.head, `I2: ref moved on error (${stage}: ${r.error.code})`);
  } else {
    assert.ok(!requireError, `expected an error for ${stage}, got success`);
    assert.equal(r.head, r.result.newCommit, 'I3: ref == our commit');
    assert.equal(r.content, EXPECTED, 'I3: content');
    assert.equal(git(r.repo.bare, ['fsck', '--strict', '--no-dangling']).trim(), '');
  }
}

const at = (stage, k, spec) => ctx => (ctx.stage === stage && ctx.n === k ? spec : { type: 'pass' });
const STAGES = [['ls-refs', 0], ['fetch', 0], ['fetch', 1], ['fetch', 3], ['fetch', 4], ['receive-pack', 0]]; // commit, root tree, leaf tree, blob

test('HTTP-level faults at every stage: statuses, non-git bodies, stall, drop, empty', async () => {
  const faults = [
    ['500 html', { type: 'status', status: 500 }, 'upstream_5xx'],
    ['401', { type: 'status', status: 401 }, 'auth'],
    ['403', { type: 'status', status: 403 }, 'auth'],
    ['404', { type: 'status', status: 404 }, 'not_found'],
    ['429', { type: 'status', status: 429 }, 'rate_limited'],
    ['200 html login page', { type: 'status', status: 200, body: '<html>sign in</html>' }, 'not_git'],
    ['200 empty body', { type: 'bytes', bytes: new Uint8Array(0) }, null],
    ['stall', { type: 'stall' }, 'timeout'],
    ['stall after partial', { type: 'stall', partial: 10 }, 'timeout'],
    ['drop', { type: 'drop' }, 'network'],
    ['drop after partial', { type: 'drop', after: 30 }, null],
  ];
  for (const [stage, k] of STAGES) for (const [name, spec, code] of faults) {
    const r = await run(at(stage, k, spec));
    const label = `${stage}#${k} ${name}`;
    checkInvariants(r, { stage: label, requireError: true, allowMoved: stage === 'receive-pack' });
    if (code) assert.equal(r.error.code, stage === 'receive-pack' ? 'ambiguous' : code, `${label}: ${r.error.message}`);
  }
});

test('byte-level chunking stress: 1-byte and 7-byte chunks at every stage must succeed', async () => {
  for (const [stage, k] of STAGES) for (const chunk of [1, 7]) {
    const r = await run(at(stage, k, { type: 'slow', chunk, delayMs: 0 }), { limits: withLimits({ requestTimeoutMs: 30000 }) });
    checkInvariants(r, { stage: `${stage}#${k} chunk=${chunk}` });
    assert.ok(!r.error, `${stage}#${k} chunk=${chunk}: ${r.error?.message}`);
  }
});

test('every protocol-aware mutator × every stage: typed error or git-verified success, never silent corruption', async () => {
  const rng = new Rng(42);
  const hist = {};
  // real pass: mutator receives upstream bytes
  for (const [stage, k] of STAGES) for (const name of MUTATOR_NAMES) for (let rep = 0; rep < 3; rep++) {
    const seed = rng.u32();
    const r = await run(ctx => (ctx.stage === stage && ctx.n === k ? { type: 'bytes', bytes: MUTATORS[name](new Rng(seed), ctx.bytes), name } : { type: 'pass' }));
    const label = `${stage}#${k} ${name} seed=${seed}`;
    try { checkInvariants(r, { stage: label, allowMoved: stage === 'receive-pack' }); } catch (e) { e.message = `${label}: ${e.message} | report=${JSON.stringify(r.error?.report?.refs ?? null)}`; throw e; }
    const key = `${stage}:${r.error ? r.error.code : 'ok'}`;
    hist[key] = (hist[key] ?? 0) + 1;
  }
  console.log('  mutation outcomes:', JSON.stringify(hist));
  // the silent-success case must only ever be a mutation that touched nothing we read (band 2, trailing flush, etc.)
});

test('I4 limits: hostile sizes are rejected before allocation; memory does not grow', async () => {
  const hdr = n => { const h = new Uint8Array(12); h.set([0x50, 0x41, 0x43, 0x4b]); new DataView(h.buffer).setUint32(4, 2); new DataView(h.buffer).setUint32(8, n); return h; };
  const sign = body => concat([body, new Sha1().update(body).digest()]);
  const rssBefore = process.memoryUsage().rss;
  // object claims 2^40 bytes
  const p1 = sign(concat([hdr(1), encodeObjHeader(3, 2 ** 40), Uint8Array.from([0x78, 0x9c, 3, 0, 0, 0, 0, 1])]));
  assert.throws(() => parsePack(p1), e => e.code === 'limit_exceeded');
  // delta claims 2^40 result
  assert.throws(() => applyDelta(new Uint8Array(1), Uint8Array.from([1, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f, 0x00])), e => e.code === 'limit_exceeded');
  // honest-looking object whose declared size is small but zlib expands past it (bomb): must stop at the declared size
  const zlib = await import('node:zlib');
  const bomb = new Uint8Array(zlib.deflateSync(Buffer.alloc(8 << 20)));
  const p2 = sign(concat([hdr(1), encodeObjHeader(3, 100), bomb]));
  assert.throws(() => parsePack(p2), e => e.code === 'pack_corrupt' && /exceeds expected/.test(e.message));
  assert.ok(process.memoryUsage().rss - rssBefore < 64 * 1024 * 1024, 'rss grew');

  // over the wire: tree fetch answered with the bomb → streaming path stops early; metadata path rejects
  const r = await run(ctx => (ctx.stage === 'fetch' && ctx.n === 4 ? { type: 'bytes', bytes: wrapPack(sign(concat([hdr(1), encodeObjHeader(3, 100), bomb]))), name: 'blob-bomb' } : { type: 'pass' }));
  checkInvariants(r, { stage: 'blob bomb', requireError: true });
  assert.equal(r.error.code, 'pack_corrupt');
  const blobSpan = r.spans.find(s => s.name === 'git.edit.blob');
  assert.ok(blobSpan.attrs['git.edit.blob.inflated'] <= 100 + 65536, `stopped early: inflated=${blobSpan.attrs['git.edit.blob.inflated']}`);

  // flood of refs / shallow lines / pack bytes
  const refsFlood = concat([...Array.from({ length: 20000 }, (_, i) => pktLine(`${'0'.repeat(39)}${i % 10} refs/heads/b${i}\n`)), te.encode('0000')]);
  const r2 = await run(at('ls-refs', 0, { type: 'bytes', bytes: refsFlood, name: 'refs-flood' }));
  checkInvariants(r2, { stage: 'refs flood', requireError: true }); assert.equal(r2.error.code, 'limit_exceeded');
  const r3 = await run(ctx => (ctx.stage === 'fetch' && ctx.n === 0 ? { type: 'bytes', bytes: MUTATORS.pkt_shallow_flood(new Rng(1), ctx.bytes), name: 'shallow-flood' } : { type: 'pass' }), { limits: withLimits({ requestTimeoutMs: 1500, maxSectionLines: 100 }) });
  checkInvariants(r3, { stage: 'shallow flood', requireError: true }); assert.equal(r3.error.code, 'limit_exceeded');
  const big = wrapPack(sign(concat([hdr(1), encodeObjHeader(3, 2 << 20), new Uint8Array(zlib.deflateSync(Buffer.alloc(2 << 20, 7), { level: 0 }))])));
  const r4 = await run(at('fetch', 1, { type: 'bytes', bytes: big, name: 'pack-flood' }), { limits: withLimits({ requestTimeoutMs: 3000, maxPackBytes: 1 << 20 }) });
  checkInvariants(r4, { stage: 'pack flood', requireError: true }); assert.equal(r4.error.code, 'limit_exceeded');
  // server streams more than declared on the blob path
  const over = wrapPack(sign(concat([hdr(1), encodeObjHeader(3, 10), new Uint8Array(zlib.deflateSync(Buffer.alloc(300000, 65)))])));
  const r5 = await run(at('fetch', 4, { type: 'bytes', bytes: over, name: 'over-declared' }));
  checkInvariants(r5, { stage: 'over-declared blob', requireError: true }); assert.equal(r5.error.code, 'pack_corrupt');
});

test('I5 caller input validation happens before any I/O', async () => {
  const cases = [
    [{ author: { name: 'a\nparent 0000000000000000000000000000000000000000', email: 'a@x' } }, 'author name'],
    [{ author: { name: 'a <b>', email: 'a@x' } }, 'author name'],
    [{ author: { name: 'a', email: 'a\nb@x' } }, 'author email'],
    [{ author: { name: 'a', email: 'a>b@x' } }, 'author email'],
    [{ ref: 'refs/heads/main\0report-status' }, 'ref'],
    [{ ref: 'refs/heads/a b' }, 'ref'],
    [{ ref: 'main' }, 'ref'],
    [{ ref: 'refs/heads/..' }, 'ref'],
    [{ ref: 'refs/heads/x.lock' }, 'ref'],
    [{ path: '../etc/passwd' }, 'path'],
    [{ path: 'a//b' }, 'path'],
    [{ path: '/a' }, 'path'],
    [{ path: 'a/.git/config' }, 'path'],
    [{ path: '' }, 'path'],
    [{ message: 'x\0y' }, 'message'],
    [{ find: '' }, undefined],
    [{ time: -1 }, undefined],
  ];
  for (const [over, what] of cases) {
    const exporter = arrayExporter();
    let calls = 0;
    const fetchImpl = async () => { calls++; throw new Error('should not be called'); };
    await assert.rejects(editFile('http://127.0.0.1:1/x.git', { path: FILE, find: FIND, replace: REPL, author: AUTHOR, message: 'm', ...over }, { tracer: new Tracer({ exporter }), fetchImpl }),
      e => e.code === 'bad_request' && (what === undefined || e.what === what), JSON.stringify(over));
    assert.equal(calls, 0, 'no I/O before validation');
  }
  // and the server agrees: an ident git would mangle is rejected by receive.fsckObjects if it ever got through
  const repo = freshRepo();
  const c = new GitHttp(`${srv.url}/${repo.name}.git`, { tracer: new Tracer() });
  const { encodeCommit, hashObject, TYPE } = await import('../src/objects.js');
  const tree = git(repo.bare, ['rev-parse', 'main^{tree}']).trim();
  const bad = encodeCommit({ tree, parents: [repo.head], author: 'x <a@x> 1 +0000', committer: 'y\nparent 0000000000000000000000000000000000000000 <a@x> 1 +0000', message: 'm' });
  await assert.rejects(c.push({ ref: 'refs/heads/main', oldOid: repo.head, newOid: hashObject('commit', bad), objects: [{ type: TYPE.COMMIT, data: bad }] }), e => e.code === 'push_rejected');
  assert.equal(git(repo.bare, ['rev-parse', 'main']).trim(), repo.head);
});

test('I6 secrets never reach telemetry: token in auth, token in URL userinfo', async () => {
  const repo = freshRepo();
  const exporter = arrayExporter();
  const tracer = new Tracer({ exporter });
  const TOKEN = 'ghp_SECRET_TOKEN_1234567890';
  const r = await editFile(`http://user:${TOKEN}@127.0.0.1:${new URL(srv.url).port}/${repo.name}.git`, { path: FILE, find: FIND, replace: REPL, author: AUTHOR, message: 'm' }, { tracer, auth: { token: TOKEN } });
  assert.equal(git(repo.bare, ['rev-parse', 'main']).trim(), r.newCommit);
  const dump = JSON.stringify(exporter.lines);
  assert.ok(!dump.includes(TOKEN), 'token leaked into spans');
  assert.ok(!dump.includes(btoa(`x-access-token:${TOKEN}`)), 'basic auth leaked');
  assert.ok(!dump.includes('user:'), 'userinfo leaked');
});

test('ambiguous push (response lost after server applied it): ref == our commit; a naive retry is match_count, content correct', async () => {
  const r = await run(at('receive-pack', 0, { type: 'drop', after: 0 }));
  assert.equal(r.error.code, 'ambiguous');
  assert.notEqual(r.head, r.repo.head, 'server applied the push');
  assert.equal(r.content, EXPECTED);
  // retry against the real server
  await assert.rejects(editFile(`${srv.url}/${r.repo.name}.git`, { path: FILE, find: FIND, replace: REPL, author: AUTHOR, message: 'adv' }, { tracer: new Tracer() }), e => e.code === 'match_count');
  assert.equal(gitBuf(r.repo.bare, ['cat-file', 'blob', `main:${FILE}`]).toString(), EXPECTED);
  assert.equal(git(r.repo.bare, ['rev-list', '--count', `${r.repo.head}..main`]).trim(), '1', 'no duplicate commit');
});

test('external AbortSignal mid-stream → aborted, ref unchanged', async () => {
  const ac = new AbortController();
  const r = await run(at('fetch', 4, { type: 'slow', chunk: 4, delayMs: 20 }), { opts: { signal: ac.signal } , limits: withLimits({ requestTimeoutMs: 30000 }) });
  void r; // control: completes
  const ac2 = new AbortController();
  setTimeout(() => ac2.abort(), 150);
  const r2 = await run(at('fetch', 4, { type: 'slow', chunk: 2, delayMs: 30 }), { opts: { signal: ac2.signal }, limits: withLimits({ requestTimeoutMs: 30000 }) });
  checkInvariants(r2, { stage: 'abort', requireError: true });
  assert.equal(r2.error.code, 'aborted');
});

// helpers
const pktLine = s => { const b = te.encode(s); return concat([te.encode((b.length + 4).toString(16).padStart(4, '0')), b]); };
function wrapPack(pack) { // v2 fetch response: packfile section + sideband band 1 frames + flush
  const parts = [pktLine('packfile\n')];
  for (let i = 0; i < pack.length; i += 65000) parts.push(pktRaw(concat([Uint8Array.of(1), pack.subarray(i, Math.min(i + 65000, pack.length))])));
  parts.push(te.encode('0000'));
  return concat(parts);
}
const pktRaw = b => concat([te.encode((b.length + 4).toString(16).padStart(4, '0')), b]);
