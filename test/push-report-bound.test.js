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
const host = (answer, limits = {}) => {
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
  return { seen, t: unwrap(createTransport('https://host.example/repo.git', { fetchImpl, limits })) };
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

// Owner decision (5): a cap bounds what ply keeps, never the outcome class. Every answer below is shaped as receive-pack
// writes it (an unpack line, one status for the one command, the two flushes), so the report grammar fixes its class:
// "ok <ref>" landed, "ng <ref> <reason>" refused. origin/main reads each the same way (review3 report-diff.mjs).
const answerOf = (...lines) => cat(band(1, cat(...lines.map(line), FLUSH)), FLUSH);
const REPORT_OK = answerOf('unpack ok\n', `ok ${REF}\n`);
const LANDED = { tag: 'statuses', refs: [{ ref: REF, ok: true, reason: '' }] };

test('band 2 of any size under maxPackBytes is read through to the report: 1 MiB and 120 MiB of hook output both land', async () => {
  const progress = band(2, te.encode(`${'remote: Resolving deltas: 100% (1234/1234), done.'.padEnd(998, '.')}\n`));
  for (const total of [MIB, FLOOD]) {
    const { seen, t } = host(() => repeat(progress, total, REPORT_OK));
    const landed = await pushOne(t);
    assert.equal(landed.ok, true, landed.ok ? '' : landed.error.message);
    assert.deepEqual(landed.value.report, LANDED);
    assert.ok(seen.pulled > total, 'all of it was read');
    // what is kept of band 2 is a tail of 4,096 characters, whatever was read
    assert.ok(landed.value.hookOutput.length <= 4096, `kept ${landed.value.hookOutput.length} characters of band 2`);
  }
});

test('band 2 past maxReportProgressBytes is dropped, and the report is still read', async () => {
  // three 1,000-byte band-2 frames (the band byte and 999 letters) under a limit of 2,000: a and b fit, c is past it
  const frame = letter => band(2, te.encode(letter.repeat(999)));
  const { t } = host(function* () { yield frame('a'); yield frame('b'); yield frame('c'); yield REPORT_OK; }, { maxReportProgressBytes: 2000 });
  const landed = await pushOne(t);
  assert.equal(landed.ok, true, landed.ok ? '' : landed.error.message);
  assert.deepEqual(landed.value.report, LANDED);
  assert.equal(landed.value.hookOutput, 'a'.repeat(999) + 'b'.repeat(999));
  // a limit that bounds nothing is refused where the record enters, before any request
  for (const key of ['maxReportProgressBytes', 'maxReportReasonBytes']) {
    const made = createTransport('https://host.example/repo.git', { limits: { [key]: -1 } });
    assert.deepEqual([made.ok, made.ok ? '' : made.error.code, made.ok ? '' : made.error.what], [false, 'bad_request', key]);
  }
});

test('an over-long reason is cut at maxReportReasonBytes and the ref keeps its status', async () => {
  // [reason bytes sent, limits, reason bytes kept]: the default is 4,096
  for (const [sent, limits, kept] of [[4096, {}, 4096], [4097, {}, 4096], [20_000, {}, 4096], [300, { maxReportReasonBytes: 100 }, 100]]) {
    const { t } = host(function* () { yield answerOf('unpack ok\n', `ng ${REF} ${'r'.repeat(sent)}\n`); }, limits);
    const r = await pushOne(t);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'push_rejected', `${sent} bytes: ${r.error.message.slice(0, 120)}`);
    assert.deepEqual(r.error.report, { tag: 'statuses', refs: [{ ref: REF, ok: false, reason: 'r'.repeat(kept) }] });
  }
  // a host's unpack failure, its 5,000-byte status echoed on the ref: both are cut at the same byte, so it is still the echo
  const why = 'e'.repeat(5000);
  const echoed = host(function* () { yield answerOf(`unpack ${why}\n`, `ng ${REF} ${why}\n`); });
  const refused = await pushOne(echoed.t);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'push_rejected', refused.error.message.slice(0, 120));
  assert.deepEqual(refused.error.report, { tag: 'unpackFailed', status: 'e'.repeat(4096), refs: [{ ref: REF, ok: false, reason: 'e'.repeat(4096) }] });
});

test('a cut never reads a report that is malformed whole: the bytes dropped are held to the same grammar', async () => {
  // past the cut: a control byte in the reason, and a line with no LF. Both are malformed whole, so both stay ambiguous.
  const bad = `${'r'.repeat(4500)}\u0001${'r'.repeat(499)}`;
  for (const ng of [`ng ${REF} ${bad}\n`, `ng ${REF} ${'r'.repeat(5000)}`]) {
    const { t } = host(function* () { yield answerOf('unpack ok\n', ng); });
    const r = await pushOne(t);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'ambiguous', r.error.message.slice(0, 120));
  }
});

test('a reason limit below the reasons receive-pack itself writes does not cut them: their classes are read whole', async () => {
  // receive-pack's own reasons decide the outcome class: non-fast-forward is not_fast_forward, a proc-receive hook that
  // did not answer is ambiguous, an unpack failure is push_rejected, and "unpack ok" with "ok <ref>" landed.
  for (const [lines, code] of [
    [['unpack ok\n', `ok ${REF}\n`], 'ok'], [['unpack ok\n', `ng ${REF} non-fast-forward\n`], 'not_fast_forward'],
    [['unpack ok\n', `ng ${REF} proc-receive failed to report status\n`], 'ambiguous'],
    [['unpack index-pack abnormal exit\n', `ng ${REF} unpacker error\n`], 'push_rejected'],
  ]) {
    const { t } = host(function* () { yield answerOf(...lines); }, { maxReportReasonBytes: 0 });
    const r = await pushOne(t);
    assert.equal(r.ok ? 'ok' : r.error.code, code, lines[1]);
  }
});

test('13,000 band-1 keepalives while a hook runs, then the report: landed', async () => {
  // copy_to_sideband's keepalive is an empty band-1 packet ("0005" and the band byte), one every 5 s while a hook runs
  const keepalives = cat(...Array.from({ length: 13_000 }, () => band(1, new Uint8Array(0))));
  const { t } = host(function* () { yield keepalives; yield REPORT_OK; });
  const landed = await pushOne(t);
  assert.equal(landed.ok, true, landed.ok ? '' : landed.error.message);
  assert.deepEqual(landed.value.report, LANDED);
});
