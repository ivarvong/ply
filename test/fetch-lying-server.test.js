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
import { v2Init, v2Step, v2End } from '../src/fetch.js';
import { Tracer } from '../src/otel.js';

// a pkt-line by hand (not ply's writer)
const pkt = s => { const b = Buffer.from(s); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]); };
const FLUSH = Buffer.from('0000');

// mode(body) => a Buffer to answer an upload-pack POST with, or null to pass the request to the real server
function lyingProxy(upstream, mode) {
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
    const out = Buffer.from(await up.arrayBuffer());
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
