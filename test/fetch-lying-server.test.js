// A source that lies in its fetch answer: ply and real git against the SAME server (a proxy in front of
// `git http-backend` that replaces one upload-pack response). The expectation in every test is git's verdict on that
// server, read from git's own exit status and stderr in the test; ply must reach the same verdict (a failed fetch),
// never ok.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitAsync, tmpRoot, makeBareRepo, startGitServer, commitFiles } from './server.js';
import { GitHttp } from '../src/client.js';
import { v2Init, v2Step, v2End, fetchBody } from '../src/fetch.js';
import { Tracer } from '../src/otel.js';

// a pkt-line by hand (not ply's writer)
const pkt = s => { const b = Buffer.from(s); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]); };
const FLUSH = Buffer.from('0000');

// mode(body) => a Buffer to answer an upload-pack POST with, or null to pass the request to the real server;
// tamper(body, answer) => the bytes to send in place of the real server's answer to an upload-pack POST
function lyingProxy(upstream, mode, tamper = (_body, answer) => answer) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const isUpload = req.method === 'POST' && req.url.endsWith('/git-upload-pack');
    const lie = isUpload ? mode(body.toString('latin1')) : null;
    if (isUpload) seen.push(body.toString('latin1'));
    if (lie) { res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' }); res.end(lie); return; }
    const headers = { ...req.headers }; delete headers.host; delete headers['content-length']; delete headers['transfer-encoding'];
    const up = await fetch(upstream + req.url, { method: req.method, headers, body: req.method === 'POST' ? body : undefined });
    const real = Buffer.from(await up.arrayBuffer());
    const out = isUpload ? tamper(body.toString('latin1'), real) : real;
    const h = {}; for (const [k, v] of up.headers) if (!['content-length', 'transfer-encoding', 'content-encoding', 'connection'].includes(k)) h[k] = v;
    res.writeHead(up.status, h); res.end(out);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise(x => { server.close(x); server.closeAllConnections?.(); }) })));
}
// real git's fetch of main from `url` into the repository at `cwd`: its exit status and stderr
const gitFetch = async (cwd, url) => { const r = await gitAsync(cwd, ['-c', 'protocol.version=2', 'fetch', url, 'main']); return { failed: r.status !== 0, stderr: r.stderr }; };
const client = url => GitHttp.create(url, { tracer: new Tracer() }).value;

let tmp, srv, A, C, empty, haveA;
before(async () => {
  tmp = tmpRoot();
  srv = await startGitServer(tmp.root);
  const src = makeBareRepo(tmp.root, 'src');
  const work = join(tmp.root, 'work'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  A = commitFiles(work, src, { 'a.txt': 'one\n' }, 'A');
  commitFiles(work, src, { 'a.txt': 'one\ntwo\n' }, 'B');
  C = commitFiles(work, src, { 'b.txt': 'three\n' }, 'C');
  empty = join(tmp.root, 'empty'); mkdirSync(empty); git(empty, ['init', '-q', '-b', 'main']);
  // a client repository that holds A only: what real git negotiates with
  haveA = join(tmp.root, 'haveA'); mkdirSync(haveA); git(haveA, ['init', '-q', '-b', 'main']); git(haveA, ['fetch', '-q', src, `${A}:refs/heads/old`]);
});
after(async () => { await srv.close(); tmp.cleanup(); });

test('a fetch sent with done and answered with acknowledgments only is a protocol error, as it is for git', async () => {
  const p = await lyingProxy(srv.url, body => (body.includes('command=fetch') && body.includes('done\n') ? Buffer.concat([pkt('acknowledgments\n'), pkt('NAK\n'), FLUSH]) : null));
  try {
    // the oracle: git (fetch-pack.c do_fetch_pack_v2, FETCH_GET_PACK) dies on the same answer
    const g = await gitFetch(empty, `${p.url}/src.git`);
    assert.equal(g.failed, true, 'git fails the fetch');
    assert.match(g.stderr, /expected 'packfile', received 'acknowledgments'/);
    const r = await client(`${p.url}/src.git`).fetchPack({ wants: [C] });
    assert.deepEqual([r.ok, r.ok ? null : r.error.code], [false, 'protocol']);
  } finally { await p.close(); }
});

test('v2 end: without done, acknowledgments alone end a round; ready with no packfile, and a line that is no acknowledgment, do not', () => {
  // The step machine driven by hand-written frames. Expected values are git's (fetch-pack.c): process_ack reads only
  // "NAK", "ACK <oid>" and "ready" and dies "unexpected acknowledgment line: '%s'" on anything else; after `ready` it
  // dies "expected packfile to be sent after 'ready'" when the next section is not the packfile; and with `done` sent
  // it never reads an acknowledgments section (previous test).
  const te = new TextEncoder();
  const run = lines => { let st = v2Init(); for (const l of [...lines, null]) { const r = v2Step(st, l === null ? { kind: 'flush' } : { kind: 'data', payload: te.encode(l) }); if (!r.ok) return r; st = r.value.state; } return { ok: true, value: st }; };
  const end = (lines, done) => { const r = run(lines); return r.ok ? v2End(r.value, done) : r; };
  const code = r => (r.ok ? 'ok' : r.error.code);
  assert.equal(code(end(['acknowledgments\n', 'NAK\n'], false)), 'ok', 'a negotiation round');
  assert.equal(code(end(['acknowledgments\n', `ACK ${A}\n`], false)), 'ok', 'a negotiation round with a common commit');
  assert.equal(code(end(['acknowledgments\n', 'NAK\n'], true)), 'protocol', 'done was sent: the answer must be a pack');
  assert.equal(code(end(['acknowledgments\n', `ACK ${A}\n`, 'ready\n'], false)), 'protocol', 'ready, then no packfile');
  assert.equal(code(end(['acknowledgments\n', 'hello\n'], false)), 'protocol', 'not an acknowledgment line');
});

test('done is read once: what is not a boolean is refused before any request; false is a round, left out is done', async () => {
  // A server that answers every fetch sent WITHOUT done with acknowledgments only (a legitimate negotiation round) and
  // passes a fetch sent with done to real git. Expected values are the owner's rule (done is true, false or left out;
  // anything else is bad_request) and the protocol: the request's own bytes say whether `done` was sent.
  const p = await lyingProxy(srv.url, body => (body.includes('command=fetch') && !body.includes('done\n') ? Buffer.concat([pkt('acknowledgments\n'), pkt('NAK\n'), FLUSH]) : null));
  try {
    const c = client(`${p.url}/src.git`);
    const fetches = () => p.seen.filter(b => b.includes('command=fetch'));
    for (const done of [null, 0, '', 1, 'true']) {
      const before = fetches().length;
      // oxlint-disable-next-line no-await-in-loop -- one request at a time: the count is per call
      const r = await c.fetchPack({ wants: [C], haves: [A], done });
      assert.deepEqual([r.ok, r.ok ? null : r.error.code, fetches().length - before], [false, 'bad_request', 0], `done: ${JSON.stringify(done)}`);
      const b = fetchBody({ wants: [C], done });
      assert.deepEqual([b.ok, b.ok ? null : b.error.code], [false, 'bad_request'], `fetchBody done: ${JSON.stringify(done)}`);
    }
    const round = await c.fetchPack({ wants: [C], haves: [A], done: false });
    assert.deepEqual([round.ok, round.ok && Boolean(round.value.parsed), fetches().at(-1).includes('done\n')], [true, false, false], 'done: false is a round without a pack');
    const full = await c.fetchPack({ wants: [C], haves: [A] });
    assert.deepEqual([full.ok, full.ok && Boolean(full.value.parsed), fetches().at(-1).includes('0009done\n')], [true, true, true], 'done left out is sent, and answered with a pack');
  } finally { await p.close(); }
});

test('a fetch sent with done and answered with acknowledgments before its packfile is a protocol error, as it is for git', async () => {
  // real git's answer (a real pack) with an acknowledgments section put in front of it
  const DELIM = Buffer.from('0001');
  const p = await lyingProxy(srv.url, () => null, (body, answer) => (body.includes('command=fetch') && body.includes('done\n') ? Buffer.concat([pkt('acknowledgments\n'), pkt('NAK\n'), DELIM, answer]) : answer));
  try {
    // the oracle: after a request with done, git reads the packfile section next and dies on any other
    const g = await gitFetch(empty, `${p.url}/src.git`);
    assert.equal(g.failed, true, 'git fails the fetch');
    assert.match(g.stderr, /expected 'packfile', received 'acknowledgments'/);
    const r = await client(`${p.url}/src.git`).fetchPack({ wants: [C] });
    assert.deepEqual([r.ok, r.ok ? null : r.error.code], [false, 'protocol']);
    assert.match(r.error.message, /expected packfile, received acknowledgments/);
  } finally { await p.close(); }
  // the same shape through the step machine: refused with done; without done it is git's `ready` then the pack
  const te = new TextEncoder();
  const data = l => ({ kind: 'data', payload: te.encode(l) });
  const end = (frames, done) => { let st = v2Init(); for (const f of frames) { const s = v2Step(st, f); if (!s.ok) return s; st = s.value.state; } return v2End(st, done); };
  const code = x => (x.ok ? 'ok' : x.error.code);
  const acksThenPack = ready => [data('acknowledgments\n'), data(`ACK ${A}\n`), ...(ready ? [data('ready\n')] : []), { kind: 'delim' }, data('packfile\n'), { kind: 'flush' }];
  assert.equal(code(end(acksThenPack(false), true)), 'protocol', 'done was sent: no acknowledgments section');
  assert.equal(code(end(acksThenPack(true), true)), 'protocol', 'done was sent: not even with ready');
  assert.equal(code(end(acksThenPack(true), false)), 'ok', 'no done: ready, then the pack');
  assert.equal(code(end([data('shallow-info\n'), { kind: 'delim' }, data('packfile\n'), { kind: 'flush' }], true)), 'ok', 'done: shallow-info, then the pack');
});

test('an acknowledgment for an id the client never offered is a protocol error: git fails the same exchange', async () => {
  // The first fetch sent without done is answered `ACK <C>`. C is the want; the client holds A and offers only A.
  // upload-pack acknowledges only a have line it was sent (upload-pack.c process_haves / send_acks), so this is a lie.
  // Each client gets its own proxy: the lie is told once per proxy.
  const lie = () => { let told = false; return body => { if (told || !body.includes('command=fetch') || body.includes('done\n')) return null; told = true; return Buffer.concat([pkt('acknowledgments\n'), pkt(`ACK ${C}\n`), FLUSH]); }; };
  const pg = await lyingProxy(srv.url, lie());
  try {
    // the oracle: real git holding A, told the same lie, does not end with a successful fetch
    const g = await gitFetch(haveA, `${pg.url}/src.git`);
    assert.equal(pg.seen.some(b => b.includes('command=fetch') && !b.includes('done\n')), true, 'git was told the lie');
    assert.equal(g.failed, true, 'git fails the fetch');
  } finally { await pg.close(); }
  const p = await lyingProxy(srv.url, lie());
  try {
    const r = await client(`${p.url}/src.git`).negotiate({ wants: [C], haves: [A] });
    assert.deepEqual([r.ok, r.ok ? null : r.error.code], [false, 'protocol']);
    assert.match(r.error.message, new RegExp(`acknowledged ${C}, which was never offered`));
    // and no request claims to have the id that was never offered
    assert.deepEqual(p.seen.filter(b => b.includes(`have ${C}`)), []);
  } finally { await p.close(); }
});
