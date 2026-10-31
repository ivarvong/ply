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
//   I6d URL userinfo is the Basic credential git sends for that URL, byte for byte, and reaches no error, span or URL.
//   I6e Every credential cell (source × user × password × transport) has one stated outcome, git's where git has the input.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { git, gitBuf, gitAsync, tmpRoot, makeBareRepo, startGitServer, startAuthGate, commitFiles } from './server.js';
import { startProxy } from './proxy.js';
import { MUTATORS, MUTATOR_NAMES } from './fuzz/mutate.js';
import { Rng } from './fuzz/prng.js';
import { editFile } from '../src/edit.js';
import { readFile } from '../src/read.js';
import { checkoutTree } from '../src/checkout.js';
import { mergeBranch } from '../src/merge.js';
import { rebaseBranch, cherryPick, revertCommit } from '../src/rebase.js';
import { GitHttp } from '../src/client.js';
import { createTransport } from '../src/http.js';
import { createSshTransport, parseSshUrl } from '../src/sshgit.js';
import { lsRefs } from '../src/lsrefs.js';
import { fetchObject } from '../src/fetch.js';
import { fetchPackTree0 } from '../src/fetchpack.js';
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

// Every ref line of an ls-refs response with `extra` appended: attributes a hostile server adds after the real ones.
const appendLsRefAttrs = (bytes, extra) => {
  const out = []; let o = 0;
  while (o < bytes.length) {
    const len = parseInt(new TextDecoder().decode(bytes.subarray(o, o + 4)), 16);
    if (len < 4) { out.push(bytes.subarray(o, o + 4)); o += 4; continue; }
    out.push(pkt(`${new TextDecoder().decode(bytes.subarray(o + 4, o + len)).replace(/\n$/, '')} ${extra}\n`)); o += len;
  }
  return concat(out);
};

// ---- I6d (#32): URL userinfo is git's credential, byte for byte; it is scrubbed like any other ----

// Tokens of the shapes hosts issue (random parts are fixed here): a classic GitHub PAT, a fine-grained one, a GitLab PAT
// with no digit (the ≥16-with-a-digit user rule alone would leave it readable when it is the user).
const GHP = 'ghp_R4nd0mClassicTokenAbcdefGhijklmnop12';
const GHFG = 'github_pat_11ABCDEFG0abcdefghijkl_MNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';
const GLPAT = 'glpat-AbcdEfghIjklMnopQrst';
const USERINFO = [ // [name, userinfo as written in the URL, the secrets in it]
  ['user only (ghp_)', `${GHP}@`, [GHP]],
  ['user only (fine-grained)', `${GHFG}@`, [GHFG]],
  ['user only (glpat, no digit)', `${GLPAT}@`, [GLPAT]],
  ['user: (empty password)', `${GHP}:@`, [GHP]],
  ['user:password', `alice:${encodeURIComponent('s3cret/Pass:word@0123456789')}@`, ['s3cret/Pass:word@0123456789']],
  [':password', `:${GHP}@`, [GHP]],
  ['percent-encoded user only', 'to%40ken%3Aabcdefghij0123456789@', ['to@ken:abcdefghij0123456789']],
  ['UTF-8 user only', 't%C3%A9k%E2%82%ACabcdefghij0123456789@', ['ték€abcdefghij0123456789']],
  ['invalid escape kept (%ZZ)', 'to%ZZkenabcdefghij0123456789@', ['to%ZZkenabcdefghij0123456789']],
  ['raw byte (%FF)', 'tok%FFabcdefghij0123456789@', ['tok\uFFFDabcdefghij0123456789']],
];

test('I6d URL userinfo authenticates fetch and push with the Authorization git sends for the same URL, byte for byte', async () => {
  const gate = await startAuthGate(srv.url);
  try {
    for (const [name, ui, secrets] of USERINFO) {
      const repo = freshRepo();
      const url = `http://${ui}${new URL(gate.url).host}/${repo.name}.git`;
      // git: ls-remote and push through the gate; its credentialed requests carry one Authorization value
      gate.seen.length = 0;
      const ls = await gitAsync(repo.work, ['ls-remote', url]);
      assert.equal(ls.status, 0, `${name}: git ls-remote: ${ls.stderr}`);
      const push = await gitAsync(repo.work, ['push', '-q', url, 'HEAD:refs/heads/by-git']);
      assert.equal(push.status, 0, `${name}: git push: ${push.stderr}`);
      const gitAuth = [...new Set(gate.seen.map(r => r.authorization).filter(Boolean))];
      assert.equal(gitAuth.length, 1, `${name}: git sent ${JSON.stringify(gitAuth)}`);
      // ply: a read (fetch) and an edit (fetch + push) through the same gate; every request carries git's value
      gate.seen.length = 0;
      const exporter = arrayExporter(); const tracer = new Tracer({ exporter });
      const read = await readFile(url, { path: FILE }, { tracer });
      const parts = []; for await (const c of read.stream) parts.push(c);
      assert.equal(new TextDecoder().decode(concat(parts)), ORIG, `${name}: read`);
      const r = await editFile(url, { path: FILE, find: FIND, replace: REPL, author: AUTHOR, message: 'm' }, { tracer });
      assert.equal(git(repo.bare, ['rev-parse', 'main']).trim(), r.newCommit, `${name}: push landed`);
      assert.ok(gate.seen.some(x => x.path.endsWith('/git-receive-pack')), `${name}: ply pushed through the gate`);
      assert.deepEqual([...new Set(gate.seen.map(x => x.authorization))], gitAuth, `${name}: ply's Authorization`);
      // the userinfo is nowhere in the export, and every URL attribute is the credential-free URL
      const dump = JSON.stringify(exporter.lines);
      for (const s of [...secrets, ui, gitAuth[0], gitAuth[0].slice(6)]) assert.ok(!dump.includes(s), `${name}: ${JSON.stringify(s)} in a span`);
      const urls = exporter.lines.flatMap(flattenLine).flatMap(sp => Object.entries(sp.attrs).filter(([k]) => /url/.test(k)).map(([, v]) => v));
      assert.ok(urls.length >= 3, `${name}: url attributes recorded`);
      for (const v of urls) assert.ok(v.startsWith(`${gate.url}/${repo.name}.git`) && !v.includes('@'), `${name}: url attribute ${v}`);
    }
  } finally { await gate.close(); }
});

test('I6d a refused URL credential is `auth`; the server echoing it reaches no error and no span (a short user name stays readable)', async () => {
  const gate = await startAuthGate(srv.url, () => false); // refuses everything, quoting the header and its decoded form
  try {
    for (const [name, ui, secrets] of USERINFO) {
      const exporter = arrayExporter(); const tracer = new Tracer({ exporter });
      const url = `http://${ui}${new URL(gate.url).host}/r.git`;
      const errs = [
        await readFile(url, { path: FILE }, { tracer }).catch(e => e),
        await editFile(url, { path: FILE, find: FIND, replace: REPL, author: AUTHOR, message: 'm' }, { tracer }).catch(e => e),
        await new GitHttp(url, { tracer }).discover().catch(e => e),
      ];
      const said = gate.seen.at(-1).authorization;
      assert.ok(said, `${name}: no Authorization sent`);
      for (const e of errs) {
        assert.equal(e.code, 'auth', `${name}: ${e.code} ${e.message}`);
        const text = `${reachableText(e)}\n${String(e)}\n${inspect(e, { depth: 20, showHidden: true })}`;
        for (const s of [...secrets, said, said.slice(6), ui]) for (const frag of [s, ...Array.from({ length: Math.max(0, s.length - 11) }, (_, i) => s.slice(i, i + 12))]) {
          assert.ok(!text.includes(frag), `${name}: ${JSON.stringify(frag)} in the error: ${e.message}`);
        }
      }
      assert.match(errs[0].message, /\[redacted\]/, `${name}: the echo was scrubbed`);
      const dump = JSON.stringify(exporter.lines);
      for (const s of [...secrets, said.slice(6), ui]) assert.ok(!dump.includes(s), `${name}: ${JSON.stringify(s)} in a span`);
    }
    // `git@` and `ivar@` alone are names: sent as `git:` / `ivar:` like git does, and not scrubbed from server text
    const e = await readFile(`http://ivar@${new URL(gate.url).host}/r.git`, { path: FILE }, { tracer: new Tracer() }).catch(x => x);
    assert.equal(gate.seen.at(-1).authorization, `Basic ${btoa('ivar:')}`);
    assert.equal(e.code, 'auth'); assert.match(e.message, /\(ivar:\)/);
  } finally { await gate.close(); }
});

test('I6d unusable userinfo or a malformed URL is bad_request before any request, and the error carries no credential', async () => {
  const cases = [['LF', `${GHP}%0A@`, 'url userinfo'], ['CR', `${GHP}%0D@`, 'url userinfo'], ['NUL', `x:${GHP}%00@`, 'url userinfo']];
  for (const [name, ui, what] of cases) {
    let calls = 0;
    const fetchImpl = async () => { calls++; throw new Error('should not be called'); };
    const e = await readFile(`http://${ui}127.0.0.1:1/r.git`, { path: FILE }, { tracer: new Tracer(), fetchImpl }).catch(x => x);
    assert.equal(e.code, 'bad_request', `${name}: ${e.code} ${e.message}`); assert.equal(e.what, what);
    assert.equal(calls, 0, name);
    assert.ok(!reachableText(e).includes(GHP.slice(0, 12)), `${name}: credential in the error`);
  }
  // git refuses LF and NUL here and sends CR; ply refuses all three. A URL that does not parse: Node's TypeError
  // carries what it was given (`input`), credential and all.
  const e = (() => { try { createTransport(`http://${GHP}@127.0.0.1:99999/r.git`); } catch (x) { return x; } })();
  assert.equal(e?.code, 'bad_request'); assert.equal(e.what, 'url');
  assert.ok(!reachableText(e).includes(GHP.slice(0, 12)) && !inspect(e, { showHidden: true }).includes(GHP.slice(0, 12)), 'credential in the error');
});

// ---- I6e (#40): the credential product space ----
// Every (source × user × password × transport) cell has one expected outcome: the exact Authorization (HTTP) or login
// name (SSH), anonymous, or `bad_request` before any request. git is the oracle wherever git has the same input: URL
// userinfo as written; explicit fields as a credential helper's `username=`/`password=`; an explicit header as
// `http.extraHeader`; an ssh:// URL through GIT_SSH_COMMAND (the login git hands to ssh). In no cell does a secret, or
// any 12 characters of one, reach an error, a span, a URL attribute or `t.url`.
const CRED_USER = { absent: undefined, short: 'ivar', secret: GHP, utf8: 'tëst', 'ctl-lf': 'iv\nar', 'ctl-soh': 'iv\x01ar' };
const CRED_PASS = { absent: undefined, empty: '', ascii: 's3cret/Pass:word@0123456789', utf8: 'pässwörd€-0123456789' };
const basicOf = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
const userinfoOf = (user, pass) => user === undefined && pass === undefined ? '' : `${encodeURIComponent(user ?? '')}${pass === undefined ? '' : `:${encodeURIComponent(pass)}`}@`;
const fragments = s => s.length < 12 ? [s] : [s, ...Array.from({ length: s.length - 11 }, (_, i) => s.slice(i, i + 12))];

// The expected outcome of a cell, stated without running anything.
//   { header }    every request carries exactly this Authorization
//   { anonymous } no Authorization (and so the gate's 401: `auth`)
//   { refused }   `bad_request`, zero requests
//   { login, url } SSH: the login name sent and the transport's `t.url`
//   { na }        not expressible (createSshTransport takes no password: publickey only)
function expectCell(source, uk, pk) {
  const user = CRED_USER[uk], pass = CRED_PASS[pk];
  if (source === 'url') {
    if (user === undefined && pass === undefined) return { anonymous: true };
    if (uk === 'ctl-lf') return { refused: 'url userinfo' };        // git: "credential url cannot be parsed"
    return { header: basicOf(user ?? '', pass ?? '') };              // as written, percent-decoded to UTF-8 bytes (#39)
  }
  if (source === 'fields') {
    if (uk === 'ctl-lf') return { refused: 'auth user' };
    if (pass === undefined) return { refused: 'auth' };               // { user } alone, or {}: git's helper API asks for the password
    if (pass === '' && user === undefined) return { refused: 'auth' }; // { token: '' }: nothing to send
    return { header: basicOf(user ?? 'x-access-token', pass) };      // UTF-8 bytes, as git sends a helper's
  }
  if (source === 'header') {
    if (user === undefined && pass === undefined) return { refused: 'auth' }; // header: ''
    return { header: basicOf(user ?? '', pass ?? '') };              // verbatim
  }
  const redacted = login => `ssh://${login.length >= 16 ? '[redacted]' : login}@host.example/p.git`;
  if (source === 'ssh-url') {
    if (pass !== undefined) return { refused: 'ssh url' };           // git would log in as `user:pass`
    if (uk === 'ctl-lf') return { refused: 'ssh user' };             // git hands ssh the raw LF
    return { login: user ?? 'git', url: redacted(user ?? 'git') };
  }
  if (pass !== undefined) return { na: 'createSshTransport has no password option' };
  if (uk === 'ctl-lf') return { refused: 'ssh user' };
  return { login: user ?? 'git', url: redacted(user ?? 'git') };
}
const authFor = (source, user, pass) => {
  if (source === 'fields') return { ...(user !== undefined && { user }), ...(pass !== undefined && { token: pass }) };
  if (source === 'header') return { header: user === undefined && pass === undefined ? '' : basicOf(user ?? '', pass ?? '') };
  return undefined;
};
// git with the same input: the Authorization values it sent (null for none) and its exit status.
async function gitHttpOracle(gate, work, source, user, pass, repoPath) {
  const host = new URL(gate.url).host;
  let args, env = {};
  if (source === 'url') args = ['ls-remote', `http://${userinfoOf(user, pass)}${host}${repoPath}`];
  else if (source === 'fields') {
    const u = user ?? (pass ? 'x-access-token' : undefined); // ply's documented default user
    if (u !== undefined) env.PLY_U = u; if (pass !== undefined) env.PLY_P = pass;
    args = ['-c', `credential.helper=!f() { [ "$1" = get ] || exit 0; [ -n "\${PLY_U+x}" ] && printf 'username=%s\\n' "$PLY_U"; [ -n "\${PLY_P+x}" ] && printf 'password=%s\\n' "$PLY_P"; true; }; f`, 'ls-remote', `http://${host}${repoPath}`];
  } else args = ['-c', `http.extraHeader=Authorization: ${authFor('header', user, pass).header}`, 'ls-remote', `http://${host}${repoPath}`];
  gate.seen.length = 0;
  const r = await gitAsync(work, args, env);
  return { status: r.status, sent: [...new Set(gate.seen.map(x => x.authorization).filter(Boolean))], stderr: r.stderr };
}

test('I6e the credential product: every source × user × password × transport cell gets its stated header, login or typed refusal, equal to git where git has the input, and leaks nothing', async () => {
  const accept = await startAuthGate(srv.url);
  const refuse = await startAuthGate(srv.url, () => false); // 401 echoing the header and its decoded form
  const repo = freshRepo();
  const repoPath = `/${repo.name}.git`;
  const tally = { header: 0, anonymous: 0, refused: 0, login: 0, na: 0, oracle: 0 };
  // one SSH login git would hand to ssh, read from a fake ssh that logs its arguments
  const sshLog = join(root, 'fake-ssh.json'), sshBin = join(root, 'fake-ssh.mjs');
  writeFileSync(sshBin, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(sshLog)}, JSON.stringify(process.argv.slice(2)) + '\\n'); process.exit(1);\n`);
  const gitSshLogin = async url => {
    writeFileSync(sshLog, '');
    await gitAsync(repo.work, ['ls-remote', url], { GIT_SSH_COMMAND: `${process.execPath} ${sshBin}` });
    const calls = (await import('node:fs')).readFileSync(sshLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(a => !a.includes('-G'));
    return calls.at(-1).at(-2); // [user@]host as git hands it to ssh
  };
  const loginOf = dest => dest.includes('@') ? dest.slice(0, dest.lastIndexOf('@')) : null;
  try {
    for (const source of ['url', 'fields', 'header', 'ssh-url', 'ssh-fields']) for (const uk of Object.keys(CRED_USER)) for (const pk of Object.keys(CRED_PASS)) {
      const cell = `${source} × user ${uk} × password ${pk}`;
      const user = CRED_USER[uk], pass = CRED_PASS[pk];
      const want = expectCell(source, uk, pk);
      const secrets = [...(pass && pass.length >= 4 ? [pass] : []), ...(uk === 'secret' ? [GHP] : []), ...(want.header ? [want.header, want.header.slice(6)] : [])];
      const noLeak = (text, where) => { for (const s of secrets) for (const f of fragments(s)) assert.ok(!text.includes(f), `${cell}: ${JSON.stringify(f)} in ${where}`); };
      const errText = e => `${reachableText(e)}\n${String(e)}\n${inspect(e, { depth: 20, showHidden: true })}`;

      if (source.startsWith('ssh')) {
        if (want.na) { tally.na++; continue; }
        const url = source === 'ssh-url' ? `ssh://${userinfoOf(user, pass)}host.example/p.git` : 'ssh://host.example/p.git';
        let dials = 0;
        // a server whose version line echoes the login, as a careless one might; the handshake fails on it
        const connect = () => { dials++; let said = false; return { read: async () => { if (said) return null; said = true; return te.encode(`SSH-1.0-${t.ssh.user}\r\n`); }, write: async () => {}, close: () => {} }; };
        const exporter = arrayExporter();
        let t;
        try { t = createSshTransport(url, { hostKey: new Uint8Array(32), connect, tracer: new Tracer({ exporter }), ...(source === 'ssh-fields' && user !== undefined && { user }) }); }
        catch (e) {
          assert.ok(want.refused, `${cell}: refused (${e.code} ${e.message}), expected ${JSON.stringify(want)}`);
          assert.equal(e.code, 'bad_request', cell); assert.equal(e.what, want.refused, cell);
          noLeak(errText(e), 'the error'); if (source === 'ssh-url' && userinfoOf(user, pass).length > 4) assert.ok(!errText(e).includes(userinfoOf(user, pass)), `${cell}: url echoed`);
          assert.equal(dials, 0, cell);
          if (source === 'ssh-url' && pass !== undefined) {
            // why: git decodes the URL and hands ssh `user:pass@host`: the password goes to the server as the login
            // name (or, when it decodes to a `/`, its first part becomes the host: `:s3cret`)
            const dest = await gitSshLogin(url);
            assert.ok(dest.startsWith(`${user ?? ''}:${pass.split('/')[0]}`), `${cell}: git's ssh destination ${JSON.stringify(dest)}`); tally.oracle++;
          }
          tally.refused++; continue;
        }
        assert.ok(want.login !== undefined, `${cell}: built a transport, expected ${JSON.stringify(want)}`);
        assert.equal(t.ssh.user, want.login, `${cell}: login`);
        assert.equal(t.url, want.url, `${cell}: t.url`);
        if (source === 'ssh-url' && user !== undefined) { assert.equal(loginOf(await gitSshLogin(url)), want.login, `${cell}: git's ssh login`); tally.oracle++; }
        const e = await lsRefs(t, ['refs/heads/']).catch(x => x);
        assert.equal(e.code, 'unsupported', `${cell}: ${e.code} ${e.message}`);
        const connectSpan = exporter.lines.flatMap(flattenLine).find(sp => sp.name === 'ssh.connect');
        assert.equal(connectSpan.attrs['ssh.user'], want.login.length >= 16 ? '[redacted]' : want.login, `${cell}: ssh.user`);
        noLeak(t.url, 't.url'); noLeak(errText(e), 'the error'); noLeak(JSON.stringify(exporter.lines), 'a span');
        tally.login++; continue;
      }

      const auth = authFor(source, user, pass);
      const urlOf = gate => `http://${source === 'url' ? userinfoOf(user, pass) : ''}${new URL(gate.url).host}${repoPath}`;
      // 1. ply through the accepting gate
      accept.seen.length = 0;
      const exporter = arrayExporter(); const tracer = new Tracer({ exporter });
      const got = await readFile(urlOf(accept), { path: FILE }, { tracer, auth }).then(async r => { const parts = []; for await (const c of r.stream) parts.push(c); return new TextDecoder().decode(concat(parts)); }, e => e);
      const spans = exporter.lines.flatMap(flattenLine);
      if (want.refused) {
        assert.equal(got?.code, 'bad_request', `${cell}: ${got?.code} ${got?.message}`); assert.equal(got.what, want.refused, cell);
        assert.equal(accept.seen.length, 0, `${cell}: requests were sent`);
        // #40.3: the root span is ended with the error recorded, and the caller can link to it
        const rootSpan = spans.find(sp => sp.name === 'git.read');
        assert.ok(rootSpan, `${cell}: root span not exported`);
        assert.equal(rootSpan.attrs['git.read.outcome'], 'bad_request', cell); assert.equal(rootSpan.status.code, 2, cell);
        assert.equal(got.span?.name, 'git.read', cell);
        noLeak(errText(got), 'the error');
        tally.refused++;
      } else if (want.anonymous) {
        assert.equal(got?.code, 'auth', `${cell}: ${got?.code}`);
        assert.deepEqual([...new Set(accept.seen.map(x => x.authorization))], [null], cell);
        tally.anonymous++;
      } else {
        assert.equal(got, ORIG, `${cell}: read failed: ${got?.code} ${got?.message}`);
        assert.deepEqual([...new Set(accept.seen.map(x => x.authorization))], [want.header], `${cell}: ply's Authorization`);
        tally.header++;
      }
      noLeak(JSON.stringify(exporter.lines), 'a span');
      for (const sp of spans) for (const [k, v] of Object.entries(sp.attrs)) if (/url/.test(k)) assert.ok(String(v).startsWith(`${accept.url}${repoPath}`) && !String(v).includes('@'), `${cell}: ${k} = ${v}`);
      if (!want.refused) { const t = createTransport(urlOf(accept), { auth }); assert.equal(t.url, `${accept.url}${repoPath}`, cell); noLeak(t.url, 't.url'); }
      // 2. git with the same input, through the same gate
      if (!(source === 'fields' && uk === 'ctl-lf') && !(source === 'header' && want.refused)) {
        const g = await gitHttpOracle(accept, repo.work, source, user, pass, repoPath);
        if (want.header) { assert.equal(g.status, 0, `${cell}: git: ${g.stderr}`); assert.deepEqual(g.sent, [want.header], `${cell}: git's Authorization`); }
        else assert.deepEqual(g.sent, [], `${cell}: git sent ${JSON.stringify(g.sent)} where ply sends nothing`);
        tally.oracle++;
      }
      // 3. a refusing server that echoes the credential: `auth`, and the echo is scrubbed everywhere
      if (want.header) {
        const ex2 = arrayExporter();
        const e = await readFile(urlOf(refuse), { path: FILE }, { tracer: new Tracer({ exporter: ex2 }), auth }).catch(x => x);
        assert.equal(e.code, 'auth', `${cell}: ${e.code} ${e.message}`);
        assert.equal(refuse.seen.at(-1).authorization, want.header, cell);
        if (secrets.length > 2) assert.match(e.message, /\[redacted\]/, `${cell}: the echo was not scrubbed: ${e.message}`);
        noLeak(errText(e), 'the echoed error'); noLeak(JSON.stringify(ex2.lines), 'an echoed span');
      }
    }
    // 5 sources × 6 users × 4 passwords = 120 cells. HTTP (72): url 19 headers + 1 anonymous + 4 refused (LF); fields 14
    // headers + 10 refused (LF ×4, no token ×5, an empty token alone); header 23 + 1 refused (empty). SSH (48): url 5
    // logins + 19 refused (a password ×18, LF); fields 5 logins + 1 refused (LF) + 18 with no password option.
    // git ran on 89: every HTTP cell but the 4 a helper cannot carry (LF) and the refused header, and every ssh:// cell
    // with a user or a password.
    assert.deepEqual(tally, { header: 56, anonymous: 1, refused: 35, login: 10, na: 18, oracle: 89 }, JSON.stringify(tally));
  } finally { await accept.close(); await refuse.close(); }
});

test('I6e an Authorization header or a Bearer token that fetch could not send is bad_request before any request; scp-like and ssh:// passwords are refused unquoted', async () => {
  for (const [name, auth] of [['header, non-ASCII', { header: 'Bearer tök€n-0123456789' }], ['header, control', { header: 'Bearer t\x01k-0123456789' }], ['header, LF', { header: 'Bearer t\nk-0123456789' }],
    ['bearer, non-ASCII', { bearer: 'tök€n-0123456789' }], ['bearer, control', { bearer: 't\x7fk-0123456789' }], ['bearer, empty', { bearer: '' }]]) {
    let calls = 0;
    const exporter = arrayExporter();
    const e = await readFile('http://127.0.0.1:1/r.git', { path: FILE }, { tracer: new Tracer({ exporter }), auth, fetchImpl: async () => { calls++; throw new Error('sent'); } }).catch(x => x);
    assert.equal(e.code, 'bad_request', `${name}: ${e.code} ${e.message}`); assert.equal(calls, 0, name);
    assert.ok(!reachableText(e).includes('0123456789') && !JSON.stringify(exporter.lines).includes('0123456789'), `${name}: echoed`);
  }
  for (const url of ['ivar:s3cretpassw0rd@host:p.git', 'ssh://ivar:s3cretpassw0rd@host:2222/p.git', 'ssh://:s3cretpassw0rd@host/p.git', 'https://ivar:s3cretpassw0rd@host/p.git']) {
    const e = (() => { try { parseSshUrl(url); } catch (x) { return x; } })();
    assert.equal(e?.code, 'bad_request', url); assert.equal(e.what, 'ssh url', url);
    assert.ok(!inspect(e, { showHidden: true }).includes('s3cretpassw0rd'), `${url}: echoed`);
  }
});

test('#16 ls-refs attributes never override the parsed oid or name: oid:/name: extras leave the edit on the real head', async () => {
  for (const extra of ['oid:junk name:refs/heads/other', `oid:${'1'.repeat(40)}`, 'name:refs/heads/other', 'name:HEAD oid:junk __proto__:x constructor:y']) {
    const r = await run(ctx => (ctx.stage === 'ls-refs' && ctx.phase !== 'request' ? { type: 'bytes', bytes: appendLsRefAttrs(ctx.bytes, extra) } : { type: 'pass' }));
    assert.equal(r.error, null, `${extra}: ${r.error?.code} ${r.error?.message}`);
    assert.ok(r.log.some(l => l.stage === 'ls-refs' && l.spec === 'bytes'), `${extra}: the ls-refs response was rewritten`);
    checkInvariants(r, { stage: `ls-refs + ${extra}` });
    assert.equal(git(r.repo.bare, ['log', '-1', '--format=%P', r.head]).trim(), r.repo.head, `${extra}: parent is the real head`);
  }
});

// #18: the merge-base walk's commit-only packs, lied about. Commits are hash-verified, so ancestry can only be withheld.
// P ← X ← M is main; feat = merge(Q, y10) with Q ← P and y10 ← … ← y1 ← X. git's base is X (via y1); with y1..y3 cut
// the only common ancestor in view is P. X sets g=2 and y1 sets it back to 1: base X → g=1 (git), base P → g=2.
function cutHistoryRepo() {
  const name = `cut${n++}`; const bare = makeBareRepo(root, name); const work = join(root, `w${name}`); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  const g = args => git(work, ['-c', 'user.name=c', '-c', 'user.email=c@x', ...args]).trim();
  const put = (files, msg) => { for (const [p, v] of Object.entries(files)) writeFileSync(join(work, p), v); g(['add', '-A']); g(['commit', '-q', '--allow-empty', '-m', msg]); return g(['rev-parse', 'HEAD']); };
  const P = put({ g: '1\n', f: 'f\n' }, 'P'), X = put({ g: '2\n' }, 'X');
  const y = [null, put({ g: '1\n' }, 'y1')]; for (let i = 2; i <= 10; i++) y.push(put({ [`y${i}`]: `${i}\n` }, `y${i}`));
  g(['checkout', '-q', '--detach', X]); const M = put({ m: 'm\n' }, 'M');
  g(['checkout', '-q', '--detach', P]); const Q = put({ q: 'q\n' }, 'Q'); g(['merge', '-q', '--no-edit', y[10]]); const S = g(['rev-parse', 'HEAD']);
  g(['push', '-q', bare, `${M}:refs/heads/main`, `${S}:refs/heads/feat`, `${y[10]}:refs/heads/lin`]);
  rmSync(work, { recursive: true, force: true });
  return { name, bare, P, X, M, Q, S, y };
}
// a fetch the merge-base walk makes (commit-only, deepen > 1), rewritten by `lie(objects, shallow)` → { objects, shallow }
const td = new TextDecoder();
const walkFetch = ctx => ctx.stage === 'fetch' && ctx.phase !== 'request' && /filter tree:0/.test(ctx.reqBody.toString('latin1')) && Number(/deepen (\d+)/.exec(ctx.reqBody.toString('latin1'))?.[1]) > 1;
const wantOf = ctx => /want ([0-9a-f]{40})/.exec(ctx.reqBody.toString('latin1'))[1];
function splitFetch(bytes) { // v2 fetch response → { shallow, objects: Map oid → { type, data } }
  const shallow = [], parts = []; let o = 0, inPack = false;
  while (o < bytes.length) {
    const len = parseInt(td.decode(bytes.subarray(o, o + 4)), 16); if (len < 4) { o += 4; continue; }
    const body = bytes.subarray(o + 4, o + len); o += len;
    if (inPack) { if (body[0] === 1) parts.push(body.subarray(1)); continue; }
    const line = td.decode(body); if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim()); if (line === 'packfile\n') inPack = true;
  }
  return { shallow, objects: resolvePack(parsePack(concat(parts), packParseOpts())).objects };
}
async function fetchReply(objects, shallow) {
  const { pack } = await buildPack([...objects.values()].map(o => ({ type: o.type, data: o.data })));
  const head = shallow.length ? [pktLine('shallow-info\n'), ...shallow.map(x => pktLine(`shallow ${x}\n`)), te.encode('0001')] : [];
  return concat([...head, wrapPack(pack)]);
}
const walkLie = lie => ctx => { if (!walkFetch(ctx)) return { type: 'pass' }; const r = splitFetch(ctx.bytes); const l = lie(r.objects, r.shallow, wantOf(ctx)); return { type: 'bytes', bytes: fetchReply(l.objects, l.shallow), name: 'walk lie' }; };
const without = (objects, drop) => new Map([...objects].filter(([k]) => !drop.includes(k)));
const objOf = (bare, oid) => { const ty = git(bare, ['cat-file', '-t', oid]).trim(); return { type: TYPE[ty.toUpperCase()], data: new Uint8Array(gitBuf(bare, ['cat-file', ty, oid])) }; };
async function mergeVia(R, fault, op = 'merge') {
  const proxy = await startProxy(srv.url, fault);
  const url = `${proxy.url}/${R.name}.git`, opts = { tracer: new Tracer(), limits: withLimits({ requestTimeoutMs: 3000 }) };
  let result = null, error = null;
  try { result = op === 'merge' ? await mergeBranch(url, { ref: 'refs/heads/main', from: 'refs/heads/feat', author: AUTHOR, message: 'm', time: 1 }, opts) : await rebaseBranch(url, { ref: 'refs/heads/lin', onto: 'refs/heads/main', committer: AUTHOR, time: 1 }, opts); }
  catch (e) { error = e; }
  await proxy.close();
  return { result, error, counts: { ...proxy.counts }, main: git(R.bare, ['rev-parse', 'main']).trim(), lin: git(R.bare, ['rev-parse', 'lin']).trim() };
}

test('#18 merge base over a cut graph: a server that withholds ancestors without a shallow line fails closed (pack_corrupt), nothing pushed', async t => {
  // honest control: git's base, git's tree, g=1
  {
    const R = cutHistoryRepo();
    assert.equal(git(R.bare, ['merge-base', '--all', 'main', 'feat']).trim(), R.X);
    const r = await mergeVia(R, () => ({ type: 'pass' }));
    assert.equal(r.error, null, r.error?.message);
    assert.equal(r.result.base, R.X); assert.equal(r.result.tree, git(R.bare, ['merge-tree', '--write-tree', R.M, R.S]).trim());
    assert.equal(gitBuf(R.bare, ['cat-file', 'blob', 'main:g']).toString(), '1\n');
  }
  const lies = {
    // the depth boundary is real, its shallow lines are stripped: at deepen 8, y4's parent y3 is missing unannounced
    'strip shallow-info': () => (objects) => ({ objects, shallow: [] }),
    // y1 never sent (honest shallow lines otherwise): at deepen 16 the server reports the history whole, y2's parent missing
    'omit y1': R => (objects, shallow) => ({ objects: without(objects, [R.y[1]]), shallow }),
  };
  const wrong = [];
  for (const [name, lie] of Object.entries(lies)) {
    const R = cutHistoryRepo();
    const r = await mergeVia(R, walkLie(lie(R)));
    t.diagnostic(`${name}: ${r.error ? r.error.code : r.result.outcome}, requests ${JSON.stringify(r.counts)}`);
    const ok = r.error?.code === 'pack_corrupt' && /withheld and [0-9a-f]{40} not reported shallow/.test(r.error.message) && r.main === R.M && !r.counts['receive-pack'];
    if (!ok) wrong.push(`${name}: ${r.result ? `${r.result.outcome} with base ${r.result.base} (git: X ${R.X}; P ${R.P}), main:g=${JSON.stringify(gitBuf(R.bare, ['cat-file', 'blob', 'main:g']).toString())}` : `${r.error.code}: ${r.error.message}`}; requests ${JSON.stringify(r.counts)}`);
    // rebase walks the same way: a linear branch y10 ← … ← X onto main fails closed the same, the branch untouched
    const R2 = cutHistoryRepo(), rb = await mergeVia(R2, walkLie(lie(R2)), 'rebase');
    if (rb.error?.code !== 'pack_corrupt' || rb.lin !== R2.y[10]) wrong.push(`${name} rebase: ${rb.error ? `${rb.error.code}: ${rb.error.message}` : rb.result.outcome}, lin ${rb.lin === R2.y[10] ? 'untouched' : 'moved'}`);
  }
  assert.deepEqual(wrong, []);
});

test('#18 the walk\'s pack holds only what was asked for, well-formed: an extra commit, a malformed commit, the want answered by a tree → pack_corrupt, nothing pushed', async t => {
  const cases = {
    // feat's head in main's pack: a real commit, but not an ancestor of the want
    'unrequested commit': R => (objects, shallow, want) => ({ objects: want === R.M ? new Map([...objects, [R.S, objOf(R.bare, R.S)]]) : objects, shallow }),
    // a commit parseCommit reads but fsck --strict refuses (no email, no date), riding along unasked
    'malformed commit': R => (objects, shallow) => ({ objects: new Map([...objects, ['x', { type: TYPE.COMMIT, data: te.encode(`tree ${git(R.bare, ['rev-parse', 'main^{tree}']).trim()}\nauthor nobody\ncommitter nobody\n\nbad\n`) }]]), shallow }),
    // the wanted commit's place taken by its root tree
    'want answered by a tree': R => (objects, shallow, want) => ({ objects: want === R.S ? new Map([...without(objects, [R.S]), ['t', objOf(R.bare, `${R.S}^{tree}`)]]) : objects, shallow }),
  };
  const wrong = [];
  for (const [name, lie] of Object.entries(cases)) {
    const R = cutHistoryRepo();
    const r = await mergeVia(R, walkLie(lie(R)));
    t.diagnostic(`${name}: ${r.error ? `${r.error.code} (${r.error.message})` : r.result.outcome}, requests ${JSON.stringify(r.counts)}`);
    if (r.error?.code !== 'pack_corrupt' || r.main !== R.M || r.counts['receive-pack']) wrong.push(`${name}: ${r.result ? `${r.result.outcome} (base ${r.result.base})` : `${r.error.code}: ${r.error.message}`}; requests ${JSON.stringify(r.counts)}`);
  }
  assert.deepEqual(wrong, []);
});

test('#18 the blob:none walk harvests only checked objects: a malformed commit in the wide pack fails the fetch and never reaches fetchObject', async () => {
  const R = cutHistoryRepo();
  const bad = te.encode(`tree ${git(R.bare, ['rev-parse', 'main^{tree}']).trim()}\nauthor nobody\ncommitter nobody\n\nbad\n`), badOid = hashObject('commit', bad);
  const proxy = await startProxy(srv.url, ctx => {
    if (ctx.stage !== 'fetch' || ctx.phase === 'request' || !/filter blob:none/.test(ctx.reqBody.toString('latin1'))) return { type: 'pass' };
    const r = splitFetch(ctx.bytes); return { type: 'bytes', bytes: fetchReply(new Map([...r.objects, [badOid, { type: TYPE.COMMIT, data: bad }]]), r.shallow) };
  });
  try {
    const t = createTransport(`${proxy.url}/${R.name}.git`, { tracer: new Tracer(), quirks: { treeFilter: 'blob:none' } });
    let res = null, err = null;
    try { res = await fetchPackTree0(t, { wants: [R.M], filter: 'tree:0', deepen: 8 }); } catch (e) { err = e; }
    const served = t.objects.has(badOid) ? await fetchObject(t, { oid: badOid, expectType: TYPE.COMMIT }) : null;
    assert.equal(err?.code, 'pack_corrupt', res ? `fetched; harvested ${t.objects.size}, malformed commit ${served?.harvested ? 'served by fetchObject from the harvest' : 'not kept'}` : String(err?.message));
    assert.equal(t.objects.has(badOid), false, 'nothing harvested from a refused pack');
  } finally { await proxy.close(); }
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

test('request timeout survives a GC during a stalled body', { timeout: 8_000 }, async () => {
  const child = spawn(process.execPath, ['--expose-gc', 'test/timeout-gc.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 0, err + out);
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
