// Safety invariants under a hostile/broken server and hostile caller input. Real git behind a fault proxy.
//   I1  Every run terminates (bounded by limits.requestTimeoutMs) with either a correct result or a typed error.
//   I2  On any error, the ref is unchanged — except a fault on the receive-pack *response*, where the ref is
//       either unchanged or exactly our commit (server applied it before the fault); never anything else.
//   I3  A successful result is always git-verified: ref == our commit, content == expected splice, fsck clean.
//   I4  Nothing an untrusted size field says is allocated before it is checked against limits.
//   I5  Caller strings that reach git objects or command lines are validated before any I/O.
//   I6  Secrets never appear in telemetry.
//   I6b A credential a server echoes back reaches no error and no span.
//   I6c A 3xx is never followed: no request (and no Authorization) reaches another origin.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, commitFiles } from './server.js';
import { startProxy } from './proxy.js';
import { MUTATORS, MUTATOR_NAMES } from './fuzz/mutate.js';
import { Rng } from './fuzz/prng.js';
import { editFile } from '../src/edit.js';
import { readFile } from '../src/read.js';
import { checkoutTree } from '../src/checkout.js';
import { mergeBranch } from '../src/merge.js';
import { rebaseBranch, cherryPick, revertCommit } from '../src/rebase.js';
import { GitHttp } from '../src/client.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { withLimits, DEFAULT_LIMITS } from '../src/limits.js';
import { applyDelta, parsePack, buildPack, encodeObjHeader, packParseOpts, resolvePack, makeDelta } from '../src/pack.js';
import { hashObject, TYPE } from '../src/objects.js';
import { Sha1 } from '../src/sha1.js';
import { concat, te } from '../src/bytes.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { inspect } from 'node:util';
import { pkt, FLUSH } from '../src/pktline.js';

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
  // encodeCommit refuses the injected header itself. The same bytes, written without that helper, are still
  // rejected by receive.fsckObjects: defense in depth if a caller pushes raw objects.
  const { encodeCommit } = await import('../src/objects.js');
  assert.throws(() => encodeCommit({ tree: 'a'.repeat(40), parents: ['b'.repeat(40)], author: 'x <a@x> 1 +0000', committer: 'y\nparent 0000000000000000000000000000000000000000 <a@x> 1 +0000', message: 'm' }), e => e.code === 'bad_request');
  const repo = freshRepo();
  const c = new GitHttp(`${srv.url}/${repo.name}.git`, { tracer: new Tracer() });
  const tree = git(repo.bare, ['rev-parse', 'main^{tree}']).trim();
  const bad = te.encode(`tree ${tree}\nparent ${repo.head}\nauthor x <a@x> 1 +0000\ncommitter y\nparent 0000000000000000000000000000000000000000 <a@x> 1 +0000\n\nm\n`);
  await assert.rejects(c.push({ ref: 'refs/heads/main', oldOid: repo.head, newOid: hashObject('commit', bad), objects: [{ type: TYPE.COMMIT, data: bad }] }), e => e.code === 'push_rejected');
  assert.equal(git(repo.bare, ['rev-parse', 'main']).trim(), repo.head);
});

test('I5 every operation rejects a bad ident field before any fetch', async () => {
  const good = { name: 'a', email: 'a@x' };
  const fields = [
    ['name', { name: 'a\nparent 0000000000000000000000000000000000000000', email: 'a@x' }, 'author name', 1700000000],
    ['email', { name: 'a', email: 'a\nb@x' }, 'author email', 1700000000],
    ['time', good, 'time', -1],
    ['time-huge', good, 'time', Number.MAX_SAFE_INTEGER + 1],
    ['tz', { ...good, tz: '+0000\nparent 0000000000000000000000000000000000000000' }, 'tz', 1700000000],
    ['tz-range', { ...good, tz: '+9999' }, 'tz', 1700000000],
  ];
  const once = async (label, what, fn) => {
    let calls = 0;
    const fetchImpl = async () => { calls++; throw new Error('should not be called'); };
    await assert.rejects(fn(fetchImpl), e => e.code === 'bad_request' && e.what === what, label);
    assert.equal(calls, 0, label);
  };
  for (const [field, person, what, time] of fields) {
    await once(`editFile ${field}`, what, fetchImpl => editFile('http://127.0.0.1:1/x.git', { path: FILE, find: FIND, replace: REPL, author: person, message: 'm', time }, { fetchImpl }));
    await once(`mergeBranch ${field}`, what, fetchImpl => mergeBranch('http://127.0.0.1:1/x.git', { ref: 'refs/heads/main', from: 'refs/heads/other', author: person, message: 'm', time }, { fetchImpl }));
    await once(`rebaseBranch ${field}`, what, fetchImpl => rebaseBranch('http://127.0.0.1:1/x.git', { ref: 'refs/heads/topic', onto: 'refs/heads/main', committer: person, author: person, time }, { fetchImpl }));
    await once(`cherryPick ${field}`, what, fetchImpl => cherryPick('http://127.0.0.1:1/x.git', { ref: 'refs/heads/main', commit: 'a'.repeat(40), committer: person, time }, { fetchImpl }));
    await once(`revertCommit ${field}`, what, fetchImpl => revertCommit('http://127.0.0.1:1/x.git', { ref: 'refs/heads/main', commit: 'b'.repeat(40), committer: person, time }, { fetchImpl }));
  }
  await once('edit message', 'message', fetchImpl => editFile('http://127.0.0.1:1/x.git', { path: FILE, find: FIND, replace: REPL, author: good, message: 'x\0y' }, { fetchImpl }));
  await once('edit ref', 'ref', fetchImpl => editFile('http://127.0.0.1:1/x.git', { path: FILE, find: FIND, replace: REPL, author: good, message: 'm', ref: 'refs/heads/main\n' }, { fetchImpl }));
  await once('merge ref', 'ref', fetchImpl => mergeBranch('http://127.0.0.1:1/x.git', { ref: 'refs/heads/main\n', from: 'refs/heads/other', author: good, message: 'm' }, { fetchImpl }));
  await once('merge message', 'message', fetchImpl => mergeBranch('http://127.0.0.1:1/x.git', { ref: 'refs/heads/main', from: 'refs/heads/other', author: good, message: 'x\0y' }, { fetchImpl }));
  await once('rebase ref', 'ref', fetchImpl => rebaseBranch('http://127.0.0.1:1/x.git', { ref: 'refs/heads/topic\n', committer: good }, { fetchImpl }));
  await once('rebase message', 'message', fetchImpl => rebaseBranch('http://127.0.0.1:1/x.git', { ref: 'refs/heads/topic', committer: good, message: 'x\0y' }, { fetchImpl }));
  await once('cherryPick message', 'message', fetchImpl => cherryPick('http://127.0.0.1:1/x.git', { ref: 'refs/heads/main', commit: 'a'.repeat(40), committer: good, message: 'x\0y' }, { fetchImpl }));
  await once('revertCommit ref', 'ref', fetchImpl => revertCommit('http://127.0.0.1:1/x.git', { ref: 'refs/heads/main\n', commit: 'b'.repeat(40), committer: good }, { fetchImpl }));
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

// ---- I6b/I6c: echoed credentials are scrubbed everywhere; redirects are never followed ----

// Every string reachable from `root` (own keys, symbols, non-enumerable message/stack/cause, nested objects, functions),
// so a check sees what JSON.stringify(err) would miss.
function reachableText(root) {
  const out = []; const seen = new Set();
  const walk = v => {
    if (typeof v === 'string') { out.push(v); return; }
    if (v === null || (typeof v !== 'object' && typeof v !== 'function') || seen.has(v)) return;
    seen.add(v);
    if (ArrayBuffer.isView(v)) { out.push(Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('latin1')); return; }
    if (v instanceof Map) { for (const [k, x] of v) { walk(k); walk(x); } return; }
    for (const k of Reflect.ownKeys(v)) { let x; try { x = v[k]; } catch { continue; } walk(x); }
  };
  walk(root);
  return out.join('\n');
}

const TOK = 'ghp_EchoedToken0123456789abcdefXYZ';
const PASS = 'glpat-EchoedPassword9876543210';
const USER = 'deploy-user-4711-secretname';
const AUTHS = [
  { name: 'token', auth: { token: TOK }, secrets: [TOK, btoa(`x-access-token:${TOK}`)] },
  { name: 'user+token', auth: { user: USER, token: TOK }, secrets: [TOK, USER, btoa(`${USER}:${TOK}`)] },
  { name: 'header Basic', auth: { header: `Basic ${btoa(`${USER}:${PASS}`)}` }, secrets: [PASS, USER, btoa(`${USER}:${PASS}`)] },
  { name: 'bearer', auth: { bearer: TOK }, secrets: [TOK] },
];
const band = (n, text) => pkt(concat([new Uint8Array([n]), typeof text === 'string' ? te.encode(text) : text]));
const once = (stage, k, make) => ctx => (ctx.stage === stage && ctx.n === k && ctx.phase === 'request' ? { type: 'bytes', noForward: true, name: 'echo', bytes: make() } : null);
// A v2 fetch answer whose band-2 progress carries `text` split across two frames, spliced after the packfile header.
const withProgress = text => ctx => {
  if (ctx.stage !== 'fetch' || ctx.n !== 0 || ctx.phase === 'request') return { type: 'pass' };
  const hdr = Buffer.from(pkt('packfile\n')); const b = Buffer.from(ctx.bytes); const at = b.indexOf(hdr) + hdr.length;
  const half = text.length >> 1;
  return { type: 'bytes', name: 'progress-echo', bytes: concat([b.subarray(0, at), band(2, text.slice(0, half)), band(2, text.slice(half)), b.subarray(at)]) };
};
const report = (...lines) => concat([band(1, concat([...lines.map(l => pkt(`${l}\n`)), FLUSH]))]);
const ECHOES = [
  { name: 'ls-refs ERR', code: 'remote_error', fault: s => once('ls-refs', 0, () => concat([pkt(`ERR access denied for ${s}\n`), FLUSH])) },
  { name: 'ls-refs malformed line (quoted, cut at 60)', code: 'protocol', fault: s => once('ls-refs', 0, () => concat([pkt(`bogus-${s}\n`), FLUSH])) },
  { name: 'fetch ERR', code: 'remote_error', fault: s => once('fetch', 0, () => concat([pkt(`ERR upload-pack: ${s}\n`), FLUSH])) },
  { name: 'fetch band 3 (commit)', code: 'remote_error', fault: s => once('fetch', 0, () => concat([pkt('packfile\n'), band(3, `fatal: ${s}\n`), FLUSH])) },
  { name: 'fetch band 3 (streamed blob)', code: 'remote_error', fault: s => once('fetch', 4, () => concat([pkt('packfile\n'), band(3, `fatal: ${s}\n`), FLUSH])) },
  { name: 'push ng reason + band-2 hook output', code: 'push_rejected', fault: s => once('receive-pack', 0, () => concat([band(2, `remote: hook saw ${s}\n`), report('unpack ok', `ng refs/heads/main pre-receive hook declined: ${s}`), FLUSH])) },
  { name: 'push band-2 tail cut through the secret', code: 'push_rejected', fault: s => once('receive-pack', 0, () => concat([band(2, `remote: ${s}`), band(2, `${'x'.repeat(4096 - 20)}\n`), report('unpack ok', 'ng refs/heads/main pre-receive hook declined'), FLUSH])) },
  { name: 'push band 3', code: 'ambiguous', fault: s => once('receive-pack', 0, () => concat([band(3, `error: ${s}\n`), FLUSH])) },
  { name: 'push malformed report + hook output', code: 'ambiguous', fault: s => once('receive-pack', 0, () => concat([band(2, `remote: ${s}\n`), report('unpack ok', 'ok refs/heads/elsewhere'), FLUSH])) },
  { name: 'fetch band-2 progress (success)', code: null, fault: withProgress },
];

test('I6b a credential echoed by the server reaches no error (any field) and no span: ERR, band 2/3, ng, hook output × 4 auth forms', async () => {
  let cases = 0;
  for (const { name: form, auth, secrets } of AUTHS) for (const echo of ECHOES) {
    const said = `${secrets.join(' | ')} :: ${secrets.join('')}`;
    const r = await run(echo.fault(said), { opts: { auth } });
    const where = `${echo.name} / ${form}`;
    let text = '';
    if (echo.code === null) { assert.equal(r.error, null, `${where}: ${r.error?.message}`); assert.match(JSON.stringify(r.exporter.lines), /\[redacted\]/, `${where}: the echo reached a span`); }
    else {
      assert.equal(r.error?.code, echo.code, `${where}: ${r.error?.code} ${r.error?.message}`);
      assert.match(reachableText(r.error), /\[redacted\]/, `${where}: the echo reached the error`);
      text = `${reachableText(r.error)}\n${String(r.error)}\n${inspect(r.error, { depth: 20, showHidden: true })}`;
    }
    const dump = JSON.stringify(r.exporter.lines);
    // whole, and as any 12-character run (a secret cut by a tail or a quote)
    for (const s of secrets) for (const frag of [s, ...Array.from({ length: s.length - 11 }, (_, i) => s.slice(i, i + 12))]) {
      assert.ok(!text.includes(frag), `${where}: ${JSON.stringify(frag)} in the error: ${r.error?.message}`);
      assert.ok(!dump.includes(frag), `${where}: ${JSON.stringify(frag)} in a span`);
    }
    cases++;
  }
  assert.equal(cases, AUTHS.length * ECHOES.length);
});

test('I6b auth.user is scrubbed only when secret-shaped: a conventional user name in server text survives', async () => {
  const r = await run(once('ls-refs', 0, () => concat([pkt(`ERR denied to x-access-token and git (token ${TOK})\n`), FLUSH])), { opts: { auth: { user: 'x-access-token', token: TOK } } });
  assert.equal(r.error.code, 'remote_error');
  assert.match(r.error.message, /denied to x-access-token and git \(token \[redacted\]\)/);
  assert.ok(!JSON.stringify(r.exporter.lines).includes(TOK));
});

// A server that answers every request with `status` + Location: `to`, and one that records what reaches it.
async function listen(handler) {
  const s = http.createServer(handler); await new Promise(ok => s.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise(ok => { s.closeAllConnections?.(); s.close(ok); }) };
}

test('I6c a 3xx is never followed: cross-origin on the GET and the POST → typed http error; the other origin sees nothing', async () => {
  const seen = [];
  const other = await listen((req, res) => { seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null }); res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' }); res.end('0000'); });
  let status = 302;
  const redirector = await listen((req, res) => { res.writeHead(status, { location: `${other.url}${req.url}`, 'content-type': 'text/html' }); res.end(`moved; token ${TOK}`); });
  try {
    for (const s of [301, 302, 303, 307, 308]) {
      status = s;
      const ex = arrayExporter();
      const c = new GitHttp(`${redirector.url}/r.git`, { tracer: new Tracer({ exporter: ex }), auth: { token: TOK } });
      const get = await c.discover().catch(e => e);
      assert.equal(get.code, 'http', `GET ${s}: ${get.code} ${get.message}`); assert.equal(get.status, s);
      assert.match(get.message, new RegExp(`^HTTP ${s} git-upload-pack advertisement: redirected to ${other.url}/r.git/info/refs; ply does not follow redirects`));
      const post = await c.lsRefs(['refs/heads/']).catch(e => e);
      assert.equal(post.code, 'http', `POST ${s}: ${post.code} ${post.message}`); assert.equal(post.status, s);
      assert.match(post.message, /redirected to .*\/r\.git\/git-upload-pack; ply does not follow redirects/);
      const edit = await editFile(`${redirector.url}/r.git`, { path: FILE, find: FIND, replace: REPL, author: AUTHOR, message: 'm' }, { tracer: new Tracer({ exporter: ex }), auth: { token: TOK } }).catch(e => e);
      assert.equal(edit.code, 'http', `edit ${s}: ${edit.code} ${edit.message}`);
      assert.ok(!JSON.stringify(ex.lines).includes(TOK));
    }
    assert.deepEqual(seen, [], 'the redirect target received requests');
  } finally { await redirector.close(); await other.close(); }
});

test('I6c a same-origin 301 on the POST (a moved repository) is a clear http error, not a content-type error', async () => {
  const hits = [];
  const srv2 = await listen((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url.startsWith('/old.git/')) { res.writeHead(301, { location: req.url.replace('/old.git/', '/new.git/') }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>repository page</html>');
  });
  try {
    const err = await readFile(`${srv2.url}/old.git`, { path: 'README.md' }, { tracer: new Tracer(), auth: { token: TOK } }).catch(e => e);
    assert.equal(err.code, 'http', `${err.code} ${err.message}`); assert.equal(err.status, 301);
    assert.equal(err.message, `HTTP 301 git-upload-pack: redirected to ${srv2.url}/new.git/git-upload-pack; ply does not follow redirects (update the remote URL)`);
    assert.equal(err.location, `${srv2.url}/new.git/git-upload-pack`);
    assert.deepEqual(hits, ['POST /old.git/git-upload-pack']);
  } finally { await srv2.close(); }
});

test('I6c a Location carrying a query or the credential is quoted as origin + path, scrubbed', async () => {
  const srv2 = await listen((req, res) => { res.writeHead(302, { location: `https://elsewhere.example/${TOK}/x?sig=${TOK}` }); res.end(); });
  try {
    const err = await new GitHttp(`${srv2.url}/r.git`, { tracer: new Tracer(), auth: { token: TOK } }).lsRefs().catch(e => e);
    assert.equal(err.code, 'http');
    assert.equal(err.location, 'https://elsewhere.example/[redacted]/x');
    assert.ok(!reachableText(err).includes(TOK));
  } finally { await srv2.close(); }
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

test('I4 six objects at the per-object cap exceed the inflated aggregate', { timeout: 120_000 }, async () => {
  const zlib = await import('node:zlib');
  const per = DEFAULT_LIMITS.maxObjectSize;
  const z = zlib.deflateSync(Buffer.alloc(per));
  const entry = concat([encodeObjHeader(3, per), z]);
  const hdr = new Uint8Array(12);
  hdr.set([0x50, 0x41, 0x43, 0x4b]);
  new DataView(hdr.buffer).setUint32(4, 2);
  new DataView(hdr.buffer).setUint32(8, 6);
  const body = concat([hdr, entry, entry, entry, entry, entry]);
  const pack = concat([body, new Sha1().update(body).digest()]);
  assert.throws(() => parsePack(pack, packParseOpts(DEFAULT_LIMITS)), e => {
    assert.equal(e.code, 'limit_exceeded');
    assert.equal(e.what, 'pack inflated bytes');
    assert.equal(e.got, per * 5);
    assert.equal(e.max, DEFAULT_LIMITS.maxInflatedTotal);
    return true;
  });
});

test('I4 many ref-deltas resolve in linear lookups', { timeout: 30_000 }, async () => {
  const base = te.encode('a');
  const delta = makeDelta(base, te.encode('b')).delta;
  const baseOid = hashObject('blob', base);
  const n = 8_000;
  const objects = [{ type: TYPE.BLOB, data: base }];
  for (let i = 0; i < n; i++) objects.push({ type: TYPE.BLOB, data: delta, baseOid });
  const { pack } = await buildPack(objects);
  const parsed = parsePack(pack, packParseOpts());
  const t0 = Date.now();
  const resolved = resolvePack(parsed);
  const dt = Date.now() - t0;
  assert.equal(resolved.stats.baseLookups, n);
  assert.ok(dt < 3_000, `resolvePack took ${dt}ms`);
});

test('I4 parsePack keeps inflated bytes within the cap', async () => {
  for (let n = 1; n <= 4; n++) {
    const objects = Array.from({ length: n }, (_, i) => ({ type: TYPE.BLOB, data: te.encode(String(i + 1)) }));
    const { pack } = await buildPack(objects);
    const parsed = parsePack(pack, packParseOpts());
    assert.ok(parsed.stats.inflated <= DEFAULT_LIMITS.maxInflatedTotal);
    assert.ok(parsed.stats.inflated <= parsed.objects.reduce((s, o) => s + o.size, 0));
  }
  const declared = 1_000;
  const hdr = new Uint8Array(12);
  hdr.set([0x50, 0x41, 0x43, 0x4b]);
  new DataView(hdr.buffer).setUint32(4, 2);
  new DataView(hdr.buffer).setUint32(8, 1);
  const body = concat([hdr, encodeObjHeader(3, declared), Uint8Array.of(0)]);
  const pack = concat([body, new Sha1().update(body).digest()]);
  assert.throws(() => parsePack(pack, { limits: withLimits({ maxInflatedTotal: declared - 1, maxObjectSize: declared }), maxInflatedTotal: declared - 1 }), e => e.code === 'limit_exceeded' && e.what === 'pack inflated bytes' && e.got === declared);
});

const pktLine = s => { const b = te.encode(s); return concat([te.encode((b.length + 4).toString(16).padStart(4, '0')), b]); };
const pktRaw = b => concat([te.encode((b.length + 4).toString(16).padStart(4, '0')), b]);

// #13: a server answering a blob fetch with PACK + version + count=1 and then object-header continuation bytes forever.
// The streamed paths (edit's streamBlobEdit, readFile's openBlob, checkoutTree's single-blob stream) used to keep every
// byte in the header buffer, re-concatenated per chunk, until the request timer fired between chunks: linear memory,
// quadratic CPU. The header phase now ends at its 22nd byte, so the first band-1 frame is refused.
function endlessHeader() {
  const served = { bytes: 0, requests: 0 };
  const frame = pktRaw(concat([Uint8Array.of(1), new Uint8Array(65515).fill(0x80)]));
  const f = async (url, init) => {
    const body = init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('latin1') : '';
    if (!body.includes('command=fetch\n') || body.includes('filter ')) return fetch(url, init);
    served.requests++;
    let first = true;
    const stream = new ReadableStream({
      pull(c) {
        const chunk = first ? concat([pktLine('packfile\n'), pktRaw(Uint8Array.of(1, 0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 1, 0xb0))]) : frame;
        first = false; served.bytes += chunk.length; c.enqueue(chunk);
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' } });
  };
  return { served, f };
}

test('I4 a blob fetch whose object header never ends: pack_corrupt within the first frame on every streamed path', { timeout: 60_000 }, async () => {
  const repo = freshRepo();
  const url = `${srv.url}/${repo.name}.git`;
  const limits = withLimits({ requestTimeoutMs: 5000 });
  const refused = e => e.code === 'pack_corrupt' && e.message === 'pack: size varint longer than 64 bits';
  const paths = {
    edit: f => editFile(url, { path: FILE, find: FIND, replace: REPL, author: AUTHOR, message: 'adv' }, { tracer: new Tracer(), limits, fetchImpl: f }),
    read: f => readFile(url, { path: FILE }, { tracer: new Tracer(), limits, fetchImpl: f }),
    checkout: async f => { const r = await checkoutTree(url, {}, { tracer: new Tracer(), limits, fetchImpl: f, batch: 1 }); for await (const g of r.files) if (g.stream) for await (const _ of g.stream); },
  };
  const seen = {};
  for (const [name, op] of Object.entries(paths)) {
    const { served, f } = endlessHeader();
    const rss0 = process.memoryUsage().rss, t0 = performance.now();
    const err = await op(f).then(() => null, e => e);
    const ms = performance.now() - t0;
    assert.ok(err && refused(err), `${name}: ${err?.code}: ${err?.message}`);
    assert.equal(served.requests, 1, `${name}: one blob request`);
    assert.ok(ms < 1000, `${name}: ${ms.toFixed(0)} ms`);
    assert.ok(served.bytes < 1 << 20, `${name}: the client read ${served.bytes} bytes of header`);
    assert.ok(process.memoryUsage().rss - rss0 < 64 << 20, `${name}: rss grew`);
    seen[name] = `${served.bytes} B served, ${ms.toFixed(0)} ms`;
  }
  console.log('  endless object header:', JSON.stringify(seen));
  assert.equal(git(repo.bare, ['rev-parse', 'main']).trim(), repo.head, 'I2: ref unchanged');
  rmSync(repo.work, { recursive: true, force: true });
});

// A server that answers a blob fetch (or, for `wants`, every unfiltered fetch) with `first` and then `frame` forever,
// yielding to the event loop between chunks as a socket does and erroring the body when the request signal aborts (as a
// real fetch does), so the test depends on the client's caps and not on the request timer. Counts every byte it served.
function endlessBody({ first, frame }) {
  const served = { bytes: 0, requests: 0, perRequest: [] };
  const f = async (url, init) => {
    const body = init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('latin1') : '';
    if (!body.includes('command=fetch\n') || body.includes('filter ')) return fetch(url, init);
    const req = { wants: body.split('want ').length - 1, bytes: 0 };
    served.requests++; served.perRequest.push(req);
    let more = true, ctrl;
    init.signal?.addEventListener('abort', () => { more = false; ctrl?.error(init.signal.reason); });
    const stream = new ReadableStream({
      start(c) { ctrl = c; },
      async pull(c) {
        await new Promise(r => setImmediate(r));
        if (!more) return;
        const chunk = req.bytes === 0 ? first : frame;
        req.bytes += chunk.length; served.bytes += chunk.length; c.enqueue(chunk);
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' } });
  };
  return { served, f };
}
const PACK_ONE = Uint8Array.of(0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 1); // PACK, v2, one object
// 13103 non-final empty stored blocks (`00 00 00 ff ff`): infinite compressed input, zero inflated output
const EMPTY_STORED = (() => { const b = new Uint8Array(65515); for (let i = 0; i + 5 <= b.length; i += 5) b.set([0x00, 0x00, 0x00, 0xff, 0xff], i); return b; })();
const STORED_FRAME = pktRaw(concat([Uint8Array.of(1), EMPTY_STORED]));
// a single-object pack whose object header declares `size` bytes of blob and whose zlib stream never ends
const endlessStored = size => endlessBody({ first: concat([pktLine('packfile\n'), pktRaw(concat([Uint8Array.of(1), PACK_ONE, encodeObjHeader(3, size), Uint8Array.of(0x78, 0x01), EMPTY_STORED.subarray(0, 65000)]))]), frame: STORED_FRAME });

const streamedPaths = (url, limits) => ({
  edit: f => editFile(url, { path: FILE, find: FIND, replace: REPL, author: AUTHOR, message: 'adv' }, { tracer: new Tracer(), limits, fetchImpl: f }),
  read: async f => { const r = await readFile(url, { path: FILE }, { tracer: new Tracer(), limits, fetchImpl: f }); for await (const _ of r.stream) void _; },
  'checkout single': async f => { const r = await checkoutTree(url, {}, { tracer: new Tracer(), limits, fetchImpl: f, batch: 1 }); for await (const g of r.files) if (g.stream) for await (const _ of g.stream) void _; },
  'checkout batched': async f => { const r = await checkoutTree(url, {}, { tracer: new Tracer(), limits, fetchImpl: f }); for await (const g of r.files) if (g.stream) for await (const _ of g.stream) void _; },
});

// The probe behind this test: on the previous source, readFile accepted 793.6 MiB and editFile 632.7 MiB of an endless
// blob body in 8 s (~90 MiB/s) and failed `timeout` — at the default 60 s timer that is ~5 GiB per request — because no
// streamed path applied limits.maxPackBytes to the body. Now the cap is in v2Step, for every consumer of packStream, with
// limit_exceeded's `got` within one frame of the cap.
test('I4 maxPackBytes bounds the streamed body on every path: limit_exceeded within one frame of the cap, not timeout', { timeout: 60_000 }, async () => {
  const repo = freshRepo();
  const url = `${srv.url}/${repo.name}.git`;
  const limits = withLimits({ requestTimeoutMs: 5000, maxPackBytes: 1 << 20 });
  for (const [name, op] of Object.entries(streamedPaths(url, limits))) {
    const { served, f } = endlessStored(16 << 20);
    const t0 = performance.now();
    const err = await op(f).then(() => null, e => e);
    const ms = performance.now() - t0;
    assert.ok(err && err.code === 'limit_exceeded' && err.what === 'pack bytes', `${name}: ${err?.code}: ${err?.message}`);
    assert.equal(err.max, limits.maxPackBytes);
    assert.ok(err.got > limits.maxPackBytes && err.got <= limits.maxPackBytes + STORED_FRAME.length, `${name}: got ${err.got}`);
    assert.ok(ms < 2000, `${name}: ${ms.toFixed(0)} ms`);
    for (const r of served.perRequest) assert.ok(r.bytes <= limits.maxPackBytes + 2 * STORED_FRAME.length, `${name}: a ${r.wants}-want request read ${r.bytes} B`);
  }
  // band 2 (progress) is the other stream a fetch response carries; it is held to the same cap
  const PROGRESS_FRAME = pktRaw(concat([Uint8Array.of(2), new Uint8Array(65515).fill(0x2e)]));
  const { served, f } = endlessBody({ first: concat([pktLine('packfile\n'), PROGRESS_FRAME]), frame: PROGRESS_FRAME });
  const err = await editFile(url, { path: FILE, find: FIND, replace: REPL, author: AUTHOR, message: 'adv' }, { tracer: new Tracer(), limits, fetchImpl: f }).then(() => null, e => e);
  assert.ok(err && err.code === 'limit_exceeded' && err.what === 'progress bytes', `progress flood: ${err?.code}: ${err?.message}`);
  assert.ok(served.bytes <= limits.maxPackBytes + 2 * PROGRESS_FRAME.length, `progress flood: ${served.bytes} B served`);
  assert.equal(git(repo.bare, ['rev-parse', 'main']).trim(), repo.head, 'I2: ref unchanged');
  rmSync(repo.work, { recursive: true, force: true });
});

test('request timeout survives a GC during a stalled body', { timeout: 8_000 }, async () => {
  const child = spawn(process.execPath, ['--expose-gc', 'test/timeout-gc.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 0, err + out);
});

// helpers
function wrapPack(pack) { // v2 fetch response: packfile section + sideband band 1 frames + flush
  const parts = [pktLine('packfile\n')];
  for (let i = 0; i < pack.length; i += 65000) parts.push(pktRaw(concat([Uint8Array.of(1), pack.subarray(i, Math.min(i + 65000, pack.length))])));
  parts.push(te.encode('0000'));
  return concat(parts);
}
