// README "Custom exchanges on a transport" (#239): the `// custom-exchange:` block is read from the README and executed
// as written (imports bound to src/: 'ply' the package entry, 'ply/transport', 'ply/push') against `git http-backend`
// behind an auth gate, and stock git judges what it left (rev-parse, cat-file, fsck --strict). Then the error paths an
// exchange on `frames` meets, each a typed PlyError from the iteration, with the span and the credential checked:
//   wrong credential (401; the server echoes the credential back) · no credential · a credential that would send nothing ·
//   a body stream that errors midway · a stream that yields more or fewer bytes than `length` (measured: frames does not
//   check it, the README says so) · a receive-pack refusal (ng) · a corrupt pack (unpack failed) · a server that is not
//   git (foreign content type) · an aborted signal
// test/types/custom-exchange.typetest.ts is the block as TypeScript (UPDATE_README_TYPETEST=1 rewrites it).
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import * as ply from '../src/index.js';
import * as plyTransport from '../src/transport.js';
import * as plyPush from '../src/push.js';
import { isPlyError } from '../src/errors.js';
import { git, tmpRoot, makeBareRepo, startGitServer, fsckProblems } from './server.js';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const TYPETEST_PATH = new URL('./types/custom-exchange.typetest.ts', import.meta.url);
const MODULES = { ply, 'ply/transport': plyTransport, 'ply/push': plyPush };
const TS_SPECIFIER = { ply: '../../src/index.js', 'ply/transport': '../../src/transport.js', 'ply/push': '../../src/push.js' };
const BLOCK = /```js\n\/\/ custom-exchange: ([\w-]+)\n([\s\S]*?)```/g;
const IMPORT = /^import \{([^}]+)\} from '([^']+)';\n/gm;
const blocks = [...README.matchAll(BLOCK)].map(([, step, code]) => ({ step, code }));
const AsyncFunction = (async () => {}).constructor;
// The block as a function of its free variables (url, opts); returns every top-level declaration.
function compile(code) {
  const imports = [...code.matchAll(IMPORT)].map(([, names, from]) => ({ names: names.split(',').map(s => s.trim()).filter(Boolean), from }));
  const body = code.replace(IMPORT, '');
  const declared = [...body.matchAll(/^(?:const|let) (?:\{ (\w+) \}|(\w+))/gm)].map(m => m[1] ?? m[2]);
  const bound = {};
  for (const { names, from } of imports) for (const n of names) bound[n] = MODULES[from][n];
  return async scope => {
    const all = { ...bound, ...scope };
    const fn = new AsyncFunction(...Object.keys(all), `${body}\nreturn { ${declared.join(', ')} };`);
    return fn(...Object.values(all));
  };
}

const TOKEN = 'ghp_customExchangeToken0123456789abcdef';
const WRONG = 'ghp_wrongToken9876543210fedcbaFEDCBA00';
const basic = tok => `Basic ${Buffer.from(`x-access-token:${tok}`).toString('base64')}`;
let tmp, srv;
const seen = [];
// The auth gate in front of git http-backend: the right Basic credential passes; anything else is a 401 whose body
// echoes the Authorization it got (a careless server), so a leak of the credential into an error would show.
const gate = async (url, init) => {
  const h = new Headers(init?.headers);
  const got = h.get('authorization');
  seen.push({ url: String(url), auth: got, aborted: init?.signal?.aborted === true });
  if (got !== basic(TOKEN)) return new Response(`denied: ${got}\n`, { status: 401, headers: { 'www-authenticate': 'Basic realm="git"', 'content-type': 'text/plain' } });
  return fetch(url, init);
};
before(async () => { tmp = tmpRoot(); srv = await startGitServer(tmp.root); });
after(async () => { await srv?.close(); tmp?.cleanup(); });
let n = 0;
const repo = () => { const name = `cx${n++}`; return { bare: makeBareRepo(tmp.root, name), url: `${srv.url}/${name}.git` }; };
const leaks = (value, ...secrets) => { const text = JSON.stringify(value) + String(value?.message ?? '') + String(value?.stack ?? ''); return secrets.filter(s => text.includes(s) || text.includes(Buffer.from(`x-access-token:${s}`).toString('base64'))); };
const rev = (bare, r) => { try { return git(bare, ['rev-parse', '--verify', '-q', r]).trim(); } catch { return null; } };

test('the README has exactly one custom-exchange block, and its TypeScript twin is current', () => {
  assert.deepEqual(blocks.map(b => b.step), ['receive-pack']);
  const head = '// GENERATED from README.md "Custom exchanges on a transport" by test/custom-exchange.test.js (UPDATE_README_TYPETEST=1\n'
    + '// rewrites it). The block as a TypeScript consumer writes it: `npm run typecheck` compiles it.\n'
    + "const url: string = 'https://git.example.com/acme/site.git';\nconst opts = { auth: { token: process.env['GIT_TOKEN'] ?? '' } };\n";
  // a TypeScript consumer annotates two lets: the span list, and the state that widens (streamInit gives the Reading it
  // starts in)
  const ts = head + blocks[0].code
    .replace(IMPORT, (_, names, from) => `import {${names}} from '${TS_SPECIFIER[from] ?? from}';\n`)
    .replace("from '../../src/push.js';\n", "from '../../src/push.js';\nimport type { StreamState } from '../../src/push.js';\n")
    .replace("from '../../src/index.js';\n", "from '../../src/index.js';\nimport type { EndedSpan } from '../../src/index.js';\n")
    .replace('const spans = [];', 'const spans: EndedSpan[] = [];')
    .replace('let reply = streamInit(', 'let reply: StreamState = streamInit(');
  if (process.env.UPDATE_README_TYPETEST) writeFileSync(TYPETEST_PATH, ts);
  assert.equal(readFileSync(TYPETEST_PATH, 'utf8'), ts, 'test/types/custom-exchange.typetest.ts drifted from the README (UPDATE_README_TYPETEST=1)');
});

test('happy path: the block, as written, lands a root commit through the auth gate; git agrees; the span carries the bytes', async () => {
  const run = compile(blocks[0].code);
  const { bare, url } = repo();
  seen.length = 0;
  const s = await run({ url, opts: { auth: { token: TOKEN }, fetchImpl: gate } });
  console.log(JSON.stringify({ report: s.report, length: s.body.length, spans: s.spans.map(x => ({ name: x.name, status: x.status, attrs: Object.fromEntries(Object.entries(x.attrs).filter(([k]) => /^(git\.(request|response|service)|http\.(request\.method|response\.status_code))/.test(k))) })) }));
  assert.deepEqual(s.report, { tag: 'statuses', refs: [{ ref: 'refs/heads/main', ok: true, reason: '' }] });
  // stock git is the judge
  assert.equal(rev(bare, 'refs/heads/main'), s.commit);
  assert.equal(git(bare, ['cat-file', '-p', 'main:hello.txt']), 'hello\n');
  assert.equal(git(bare, ['log', '-1', '--format=%an <%ae> %at%n%s', 'main']).trim(), 'Me <me@example.com> 1700000000\nhello');
  assert.deepEqual(fsckProblems(bare), []);
  // the span: what frames() filled in
  const span = s.spans.find(x => x.name === 'custom receive-pack');
  assert.ok(span, 'the caller span ended');
  assert.equal(span.attrs['git.request.bytes'], s.body.length, 'git.request.bytes is the StreamBody length');
  assert.equal(span.attrs['http.request.body.size'], s.body.length);
  assert.equal(span.attrs['git.service'], 'git-receive-pack');
  assert.equal(span.attrs['http.request.method'], 'POST');
  assert.equal(span.attrs['http.response.status_code'], 200);
  assert.ok(span.attrs['git.response.bytes'] > 0);
  assert.ok(span.attrs['git.response.first_byte_ms'] >= 0);
  assert.notEqual(span.status?.code, 2, 'not an error span');
  // the credential went on the wire, and nowhere else
  assert.ok(seen.every(x => x.auth === basic(TOKEN)), 'every request carried the credential');
  assert.deepEqual(leaks(s.spans, TOKEN), [], 'no form of the credential in a span');
});

test('wrong credential: auth (401), typed, thrown from the iteration; the echoed credential is scrubbed; nothing lands', async () => {
  const run = compile(blocks[0].code);
  const { bare, url } = repo();
  const spans = [];
  const e = await run({ url, opts: { auth: { token: WRONG }, fetchImpl: gate } }).then(() => null, x => x);
  assert.ok(isPlyError(e), String(e));
  console.log(JSON.stringify({ code: e.code, status: e.status, message: e.message }));
  assert.equal(e.code, 'auth');
  assert.deepEqual(leaks(e, WRONG), [], 'the credential the server echoed is scrubbed from the error');
  assert.equal(rev(bare, 'refs/heads/main'), null, 'nothing landed');
  // the same through a span we keep: the error is recorded, scrubbed
  const t = ply.createTransport(url, { auth: { token: WRONG }, fetchImpl: gate, tracer: new ply.Tracer({ onEnd: x => spans.push(x) }) });
  const span = t.value.tracer.start('custom', { kind: ply.KIND.CLIENT, scrub: t.value.scrub });
  const err2 = await (async () => { try { for await (const _ of plyTransport.frames(t.value, 'git-receive-pack', new Uint8Array(4).fill(48), span)) { /* none */ } } catch (x) { span.error(x); return x; } finally { span.end(); } return null; })();
  assert.equal(err2.code, 'auth');
  assert.equal(spans[0].status.code, 2, 'error status on the span');
  assert.equal(spans[0].attrs['http.response.status_code'], 401);
  assert.deepEqual(leaks(spans, WRONG), [], 'no form of the credential in the span');
});

test('no credential at all: the gate\'s 401 is auth; a credential that would send nothing is bad_request before any request', async () => {
  const { url } = repo();
  const t = ply.createTransport(url, { fetchImpl: gate });
  const span = t.value.tracer.start('custom');
  const e = await (async () => { try { for await (const _ of plyTransport.frames(t.value, 'git-receive-pack', new Uint8Array(4).fill(48), span)) { /* none */ } } catch (x) { return x; } return null; })();
  assert.equal(e.code, 'auth');
  const before = seen.length;
  const bad = ply.createTransport(url, { auth: {}, fetchImpl: gate });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'bad_request');
  assert.equal(seen.length, before, 'no request was made');
});

// A direct exchange on the gate with a body of our choosing: the error, the span, and the ref afterwards.
async function exchange(url, body, { signal = null } = {}) {
  const spans = [];
  const t = ply.createTransport(url, { auth: { token: TOKEN }, fetchImpl: gate, tracer: new ply.Tracer({ onEnd: x => spans.push(x) }), ...(signal ? { signal } : {}) });
  const span = t.value.tracer.start('custom receive-pack', { kind: ply.KIND.CLIENT, scrub: t.value.scrub });
  let reply = plyPush.streamInit(true);
  let error = null;
  try {
    for await (const f of plyTransport.frames(t.value, 'git-receive-pack', body, span)) {
      const st = plyPush.streamStep(reply, f);
      if (!st.ok) throw st.error;
      reply = st.value;
    }
  } catch (e) { error = e; span.error(e); } finally { span.end(); }
  return { error, spans, done: error === null ? plyPush.streamFinish(reply) : null };
}
async function rootCommit(text) {
  const file = new TextEncoder().encode(text);
  const tree = ply.encodeTree([{ mode: '100644', name: 'f', oid: ply.hashObject('blob', file) }]).value;
  const c = ply.encodeCommit({ tree: ply.hashObject('tree', tree), author: 'A <a@x> 1700000000 +0000', message: `${text}\n` }).value;
  const commit = ply.hashObject('commit', c);
  const { pack } = await ply.buildPack([{ type: ply.TYPE.BLOB, data: file }, { type: ply.TYPE.TREE, data: tree }, { type: ply.TYPE.COMMIT, data: c }]);
  return { commit, pack };
}
const prefixOf = commands => plyPush.pushBody({ commands, caps: ['report-status', 'side-band-64k'] }).value;

test('a body stream that errors midway: a typed error from the iteration, the span records it, nothing lands', async () => {
  const { bare, url } = repo();
  const { commit, pack } = await rootCommit('x');
  const prefix = prefixOf([{ ref: 'refs/heads/main', oldOid: ply.ZERO_OID, newOid: commit }]);
  const boom = new Error('pack source died');
  let sent = 0;
  const stream = new ReadableStream({ pull(c) { if (sent++ === 0) c.enqueue(prefix); else c.error(boom); } });
  const r = await exchange(url, { stream, length: prefix.length + pack.length });
  console.log(JSON.stringify({ code: r.error?.code, message: r.error?.message }));
  assert.ok(isPlyError(r.error), String(r.error));
  // undici aborts the request and fetch rejects 'fetch failed': frames reports a network error; the source's own error
  // is on the cause chain. The README tells the caller to keep its own failure (as pushPack's streamSource does).
  assert.equal(r.error.code, 'network');
  const chain = []; for (let c = r.error; c; c = c.cause) chain.push(c);
  assert.ok(chain.includes(boom), 'the source error is on the cause chain');
  assert.equal(r.spans[0].status.code, 2);
  assert.equal(r.spans[0].attrs['git.request.bytes'], prefix.length + pack.length);
  assert.equal(rev(bare, 'refs/heads/main'), null);
});

// `length` is what the span reports (git.request.bytes); frames sends what the stream yields, chunked, and does not count
// it. The README says so, and says what checks it: pushPack's streamSource (packwrite.ts). Here is what happens when a
// raw exchange gets it wrong, so the documented behavior is a measured one.
test('length is the span\'s figure, not a check: a longer stream is sent as yielded; a shorter one is a pack git refuses', async () => {
  const observed = {};
  for (const [name, extra] of [['longer', 7], ['shorter', -7]]) {
    const { bare, url } = repo();
    const { commit, pack } = await rootCommit(`len-${name}`);
    const commands = [{ ref: 'refs/heads/main', oldOid: ply.ZERO_OID, newOid: commit }];
    const prefix = prefixOf(commands);
    const whole = new Uint8Array([...prefix, ...pack]);
    const body = extra > 0 ? new Uint8Array([...whole, ...new Uint8Array(extra)]) : whole.subarray(0, whole.length + extra);
    const r = await exchange(url, { stream: ReadableStream.from([body]), length: whole.length });
    const report = r.error === null && r.done.tag === 'report' ? plyPush.classifyReport(r.done.lines, commands) : null;
    observed[name] = { error: r.error?.code ?? null, report: report?.tag ?? r.done?.tag ?? null, landed: rev(bare, 'refs/heads/main') === commit, spanBytes: r.spans[0].attrs['git.request.bytes'], sent: body.length };
    assert.equal(r.spans[0].attrs['git.request.bytes'], whole.length, `${name}: the span reports the declared length`);
  }
  console.log(JSON.stringify(observed));
  // git reads a pack to its trailer: 7 bytes after it change nothing, so the push lands
  assert.deepEqual({ ...observed.longer, spanBytes: 0 }, { error: null, report: 'statuses', landed: true, spanBytes: 0, sent: observed.longer.sent });
  // a pack cut short of its trailer: git refuses it (unpack failed, or no report at all), and nothing lands
  assert.equal(observed.shorter.landed, false);
  assert.ok(observed.shorter.error !== null || observed.shorter.report === 'unpackFailed' || observed.shorter.report === 'broken', JSON.stringify(observed.shorter));
});

test('receive-pack refuses a command (stale old id): the report says ng, classifyReport names it; the ref is unchanged', async () => {
  const run = compile(blocks[0].code);
  const { bare, url } = repo();
  const first = await run({ url, opts: { auth: { token: TOKEN }, fetchImpl: gate } });
  const { commit, pack } = await rootCommit('second');
  const commands = [{ ref: 'refs/heads/main', oldOid: ply.ZERO_OID, newOid: commit }];
  const prefix = prefixOf(commands);
  const r = await exchange(url, { stream: ReadableStream.from([prefix, pack]), length: prefix.length + pack.length });
  assert.equal(r.error, null);
  assert.equal(r.done.tag, 'report');
  const report = plyPush.classifyReport(r.done.lines, commands);
  console.log(JSON.stringify(report));
  assert.equal(report.tag, 'statuses');
  assert.equal(report.refs[0].ok, false);
  assert.ok(report.refs[0].reason.length > 0);
  assert.equal(rev(bare, 'refs/heads/main'), first.commit, 'unchanged');
});

test('a corrupt pack: the report is unpackFailed, the span is not an error (the exchange worked), nothing lands', async () => {
  const { bare, url } = repo();
  const { commit, pack } = await rootCommit('corrupt');
  const bad = Uint8Array.from(pack); bad[20] ^= 0xff;
  const commands = [{ ref: 'refs/heads/main', oldOid: ply.ZERO_OID, newOid: commit }];
  const prefix = prefixOf(commands);
  const r = await exchange(url, { stream: ReadableStream.from([prefix, bad]), length: prefix.length + bad.length });
  assert.equal(r.error, null, String(r.error));
  const report = r.done.tag === 'report' ? plyPush.classifyReport(r.done.lines, commands) : r.done;
  console.log(JSON.stringify(report));
  assert.ok(report.tag === 'unpackFailed' || report.tag === 'broken', JSON.stringify(report));
  assert.equal(rev(bare, 'refs/heads/main'), null);
});

test('a server that is not git (HTML 200) is not_git; an aborted signal is aborted, and no fetch goes out live', async () => {
  const html = async () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  const t = ply.createTransport('https://git.example/r.git', { fetchImpl: html });
  const e = await (async () => { try { for await (const _ of plyTransport.frames(t.value, 'git-receive-pack', new Uint8Array(4).fill(48), t.value.tracer.start('x'))) { /* none */ } } catch (x) { return x; } return null; })();
  assert.equal(e.code, 'not_git');
  const { url } = repo();
  const ac = new AbortController();
  ac.abort();
  const before = seen.length;
  const r = await exchange(url, new Uint8Array(4).fill(48), { signal: ac.signal });
  console.log(JSON.stringify({ code: r.error?.code, calls: seen.slice(before).map(x => ({ url: x.url, aborted: x.aborted })) }));
  assert.ok(isPlyError(r.error));
  assert.equal(r.error.code, 'aborted');
  assert.equal(r.spans[0].status.code, 2);
  assert.ok(seen.slice(before).every(x => x.aborted), 'every fetch it made carried the aborted signal (none went out)');
});
