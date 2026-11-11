// What ply reads of a receive-pack answer is bounded by what an honest report can be. The counter here is the test's
// own: bytes handed out by the response body the test built. It is not a number ply reports.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createTransport } from '../src/http.js';
import { push, ZERO_OID } from '../src/push.js';
import { unwrap } from './unwrap.js';

const te = new TextEncoder();
// pkt-line and side-band-64k framing written from the protocol (gitprotocol-common: four hex digits of length that
// count themselves; gitprotocol-pack: the first payload byte is the band), not with ply's encoders.
const pkt = bytes => { const out = new Uint8Array(bytes.length + 4); out.set(te.encode((bytes.length + 4).toString(16).padStart(4, '0'))); out.set(bytes, 4); return out; };
const FLUSH = te.encode('0000');
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const band = (n, body) => pkt(cat(Uint8Array.of(n), body));
const line = text => pkt(te.encode(text));
const REF = 'refs/heads/main';
const KIB = 1024;
const MIB = KIB * KIB;
const FLOOD = 120 * MIB;

// A receive-pack that takes the whole request, then answers with the chunks of `answer()`. The body has no queue
// (highWaterMark 0), so `pulled` is exactly the bytes the client asked for.
const host = answer => {
  const seen = { pulled: 0, cancelled: false, posts: 0 };
  const fetchImpl = async (_url, init) => {
    if (init.method !== 'POST') return new Response('', { status: 404 });
    seen.posts++;
    if (init.body instanceof ReadableStream) for await (const _ of init.body) { /* the request body, taken whole */ }
    const chunks = answer();
    const body = new ReadableStream({
      pull(c) { const r = chunks.next(); if (r.done) { c.close(); return; } seen.pulled += r.value.length; c.enqueue(r.value); },
      cancel() { seen.cancelled = true; },
    }, { highWaterMark: 0 });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' } });
  };
  return { seen, t: unwrap(createTransport('https://host.example/repo.git', { fetchImpl })) };
};
const pushOne = t => push(t, { ref: REF, oldOid: ZERO_OID, newOid: 'a'.repeat(40), objects: [{ type: 3, data: te.encode('hi\n') }] });
const repeat = function* (chunk, total, ...tail) { for (let sent = 0; sent < total; sent += chunk.length) yield chunk; yield* tail; };

// An honest report for this one command is "unpack ok\n" and "ok refs/heads/main\n": two lines, 29 bytes. Each bound
// below is a round figure far above that and far below the flood.
test('a band-1 report of 65,000-byte lines that would run to 120 MiB is abandoned at once: ambiguous, the body cancelled', async () => {
  const big = band(1, line(`${'x'.repeat(65_000)}\n`));
  const { seen, t } = host(() => repeat(big, FLOOD, cat(band(1, FLUSH), FLUSH)));
  const r = await pushOne(t);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ambiguous', 'the request body was sent');
  assert.equal(seen.posts, 1);
  assert.ok(seen.pulled <= 256 * KIB, `ply pulled ${seen.pulled} bytes of a report that cannot be valid from its first line`);
  assert.equal(seen.cancelled, true, 'the response body is cancelled, not left open');
});

test('a report with more ref lines than commands is abandoned at the first one: ambiguous, the body cancelled', async () => {
  const extra = band(1, line('ok refs/heads/never-pushed\n'));
  const { seen, t } = host(() => repeat(extra, FLOOD, cat(band(1, FLUSH), FLUSH), band(1, line('unpack ok\n'))));
  // the unpack line first, so every line is well formed: only the count and the ref names are wrong
  const { seen: seen2, t: t2 } = host(function* () { yield band(1, line('unpack ok\n')); yield band(1, line(`ok ${REF}\n`)); yield* repeat(extra, FLOOD, cat(band(1, FLUSH), FLUSH)); });
  for (const [s, tr] of [[seen, t], [seen2, t2]]) {
    const r = await pushOne(tr);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'ambiguous');
    assert.ok(s.pulled <= 64 * KIB, `ply pulled ${s.pulled} bytes`);
    assert.equal(s.cancelled, true);
  }
});

test('band 2 in ordinary amounts is read through to the report; a band-2 flood is cut: ambiguous, the body cancelled', async () => {
  const progress = band(2, te.encode(`${'remote: Resolving deltas: 100% (1234/1234), done.'.padEnd(998, '.')}\n`));
  const report = cat(band(1, cat(line('unpack ok\n'), line(`ok ${REF}\n`), FLUSH)), FLUSH);
  // 1 MiB of hook and progress output before the report: a talkative server-side hook
  const fine = host(() => repeat(progress, MIB, report));
  const landed = await pushOne(fine.t);
  assert.equal(landed.ok, true, landed.ok ? '' : landed.error.message);
  assert.deepEqual(landed.value.report, { tag: 'statuses', refs: [{ ref: REF, ok: true, reason: '' }] });
  assert.ok(fine.seen.pulled > MIB, 'all of it was read');
  const flood = host(() => repeat(progress, FLOOD, report));
  const r = await pushOne(flood.t);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ambiguous');
  assert.equal(r.error.original, 'limit_exceeded');
  assert.ok(flood.seen.pulled <= 16 * MIB, `ply pulled ${flood.seen.pulled} bytes of band 2`);
  assert.equal(flood.seen.cancelled, true);
});
