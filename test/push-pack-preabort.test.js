// A pushPack whose caller's signal had already fired sent nothing, so its outcome is known. The counters are the
// test's own: pulls and cancels of the pack stream it built, requests seen by its server. None is a number ply reports.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTransport } from '../src/http.js';
import { ZERO_OID } from '../src/push.js';
import { pushPack } from '../src/receivecaps.js';
import { unwrap } from './unwrap.js';

test('pushPack under an already-aborted signal: a definite aborted, no request, the pack never read, locked or cancelled', async () => {
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; req.resume(); res.end(); });
  await new Promise(r => { server.listen(0, '127.0.0.1', r); });
  try {
    const ac = new AbortController();
    ac.abort();
    const pack = { pulls: 0, cancels: 0 };
    const stream = new ReadableStream({ pull(c) { pack.pulls++; c.enqueue(new Uint8Array(1024)); c.close(); }, cancel() { pack.cancels++; } }, { highWaterMark: 0 });
    const t = unwrap(createTransport(`http://127.0.0.1:${server.address().port}/repo.git`, { signal: ac.signal }));
    const r = await pushPack(t, { ref: 'refs/heads/main', oldOid: ZERO_OID, newOid: 'a'.repeat(40), pack: stream, length: 1024 });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'aborted', `nothing was sent, so nothing is unknown: ${r.error.message}`);
    assert.deepEqual({ ...pack, locked: stream.locked, requests }, { pulls: 0, cancels: 0, locked: false, requests: 0 });
    // the pack is still the caller's: it can be read (or sent again) afterwards
    const first = await stream.getReader().read();
    assert.equal(first.value.length, 1024);
  } finally { server.close(); server.closeAllConnections(); }
});
