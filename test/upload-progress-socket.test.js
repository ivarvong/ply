// Upload progress on a real socket (#255): the platform's own fetch (undici) to a node:http server, no double.
// What ply can hold a limit to is what it can see: the platform pulling a piece of the request body. These tests pin
// that granularity (pieces of at most 64 KiB, however large the source chunk) and which limit names which stall.
// They assert counts and limit names, never elapsed time; the timeouts are far from what a loaded machine reaches.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTransport } from '../src/http.js';
import { withLimits } from '../src/limits.js';

const RP = { 'content-type': 'application/x-git-receive-pack-result' };
const MIB = 1 << 20;
const spanOf = () => ({ set() {}, event() {}, error() {} });
const serve = handler => new Promise(resolve => {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}/r`, close: () => { s.closeAllConnections(); s.close(); } }));
});
// The platform's fetch, recording every piece it pulls from the request body and how much the server had read by then.
// The recorder has no buffer of its own (highWaterMark 0), so a recorded pull is a pull by the platform.
const observed = (pieces, serverRead) => (url, init) => {
  if (!(init.body instanceof ReadableStream)) return fetch(url, init);
  const rd = init.body.getReader();
  const body = new ReadableStream({
    async pull(c) { const r = await rd.read(); if (r.done) { c.close(); return; } pieces.push({ bytes: r.value.length, serverRead: serverRead() }); c.enqueue(r.value); },
    cancel: reason => rd.cancel(reason),
  }, { highWaterMark: 0 });
  return fetch(url, { ...init, body });
};
// a source of `count` chunks of `size` bytes, read only when pulled; `pulls.n` counts the chunks taken
const source = (count, size, pulls) => {
  const chunk = new Uint8Array(size);
  return { stream: new ReadableStream({ pull(c) { if (pulls.n === count) { c.close(); return; } pulls.n++; c.enqueue(chunk); } }, { highWaterMark: 0 }), length: count * size };
};
// the outcome of the exchange, never a rejection
const push = async (t, body) => {
  let frames = 0;
  try { for await (const _ of t.frames('git-receive-pack', body, spanOf(), { bypassCache: false })) frames++; } catch (error) { return { frames, code: error.code, what: error.what }; }
  return { frames };
};

test('one 4 MiB chunk to a server that reads 64 KiB per 25 ms: the platform takes it in 64 pieces and it is answered', async () => {
  // The finding's experiment. 4 MiB / 64 KiB = 64 pieces, each a progress mark; before the split the platform took the
  // chunk in one pull, so the clock saw one mark and then nothing until the whole 4 MiB had left undici's queue.
  const seen = { bytes: 0 };
  const srv = await serve((req, res) => {
    req.on('data', d => { seen.bytes += d.length; req.pause(); setTimeout(() => { req.resume(); }, 25); });
    req.on('end', () => { res.writeHead(200, RP); res.end('0000'); });
    req.on('error', () => { /* the client went away */ });
  });
  const pieces = [];
  const pulls = { n: 0 };
  try {
    const t = createTransport(srv.url, { fetchImpl: observed(pieces, () => seen.bytes), limits: withLimits({ firstByteTimeoutMs: 30_000, idleTimeoutMs: 10_000 }) }).value;
    const r = await push(t, source(1, 4 * MIB, pulls));
    assert.deepEqual(r, { frames: 1 });
    assert.equal(seen.bytes, 4 * MIB);
    assert.deepEqual([pieces.length, Math.max(...pieces.map(p => p.bytes)), pieces.reduce((n, p) => n + p.bytes, 0)], [64, 65_536, 4 * MIB]);
  } finally { srv.close(); }
}, 60_000);

test('a server that stops reading mid-upload is idleTimeoutMs: pieces remain and the platform takes no more', async () => {
  // 64 MiB in 1 MiB chunks, more than undici's queue and the kernel's socket buffers hold, to a server that reads once
  // and never again. The platform stops pulling, so the source is never read to its end (pulls < 64) and the upload
  // has not ended: the limit is the idle one, whatever the first-byte limit is.
  const srv = await serve(req => { req.once('data', () => { req.pause(); }); req.on('error', () => { /* cut */ }); });
  const pieces = [];
  const pulls = { n: 0 };
  try {
    const t = createTransport(srv.url, { fetchImpl: observed(pieces, () => 0), limits: withLimits({ firstByteTimeoutMs: 30_000, idleTimeoutMs: 300 }) }).value;
    const r = await push(t, source(64, MIB, pulls));
    assert.deepEqual(r, { frames: 0, code: 'timeout', what: 'idleTimeoutMs' });
    assert.ok(pulls.n < 64, `the source was read to its end (${pulls.n} chunks): the upload did not stall`);
  } finally { srv.close(); }
}, 60_000);

test('a server that reads the whole upload and never answers is firstByteTimeoutMs: every piece was handed over', async () => {
  const seen = { bytes: 0 };
  const srv = await serve(req => { req.on('data', d => { seen.bytes += d.length; }); req.on('error', () => { /* cut */ }); });
  const pieces = [];
  const pulls = { n: 0 };
  try {
    const t = createTransport(srv.url, { fetchImpl: observed(pieces, () => seen.bytes), limits: withLimits({ firstByteTimeoutMs: 300, idleTimeoutMs: 30_000 }) }).value;
    const r = await push(t, source(1, 4 * MIB, pulls));
    assert.deepEqual(r, { frames: 0, code: 'timeout', what: 'firstByteTimeoutMs' });
    assert.equal(pieces.length, 64);
  } finally { srv.close(); }
}, 60_000);
