// pushPack (#234): a pack the caller already has, as a stream, with push's commands, capability checks and report handling.
// The oracle is `git http-backend`: packs written by stock git are pushed, the ref moves, fsck --strict is clean.
//   - known and unknown length; the body is a stream (duplex half, redirect error), read once, never buffered
//   - length wrong in either direction, an errored source, the cap mid-stream: ambiguous with the cause as `original`,
//     the final bytes withheld, the ref not moved
//   - a body that errors but looks complete to the server (workerd) is still not reported as landed
//   - refusals before the request leave the stream unread and unlocked
//   - a source the request did not finish is cancelled
//   - memory: a pack far larger than what is held (child process, --expose-gc)
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { MEMORY_CELL_FLAGS } from './memcell.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomFillSync } from 'node:crypto';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, fsckProblems, initRepo } from './server.js';
import { createTransport } from '../src/http.js';
import { ZERO_OID, pushPackChecked, planPackPush } from '../src/push.js';
import { pushPack, checkPushCaps } from '../src/receivecaps.js';
import { GitHttp } from '../src/client.js';
import { withLimits } from '../src/limits.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { pkt, FLUSH } from '../src/pktline.js';
import { concat } from '../src/bytes.js';
import { unwrap } from './unwrap.js';

const REF = 'refs/heads/main';
let root, cleanup, srv, n = 0, source;
before(async () => {
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  const work = join(root, 'source');
  mkdirSync(work);
  initRepo(work);
  const blob = new Uint8Array(300_000);
  randomFillSync(blob);
  writeFileSync(join(work, 'random.bin'), blob);
  writeFileSync(join(work, 'text.txt'), 'line\n'.repeat(4000));
  git(work, ['add', '.']);
  git(work, ['-c', 'user.name=a', '-c', 'user.email=a@x', 'commit', '-q', '-m', 'one']);
  writeFileSync(join(work, 'text.txt'), `${'line\n'.repeat(4000)}changed\n`);
  git(work, ['add', '.']);
  git(work, ['-c', 'user.name=a', '-c', 'user.email=a@x', 'commit', '-q', '-m', 'two']);
  const oid = git(work, ['rev-parse', 'HEAD']).trim();
  source = { oid, pack: new Uint8Array(gitBuf(work, ['pack-objects', '--revs', '--stdout', '-q'], `${oid}\n`)) };
});
after(async () => { await srv.close(); cleanup(); });

const repo = () => { const name = `p${n++}`; return { bare: makeBareRepo(root, name), url: `${srv.url}/${name}.git` }; };
const tipOf = bare => { try { return git(bare, ['rev-parse', '--verify', '-q', REF]).trim(); } catch { return null; } };
const create = () => ({ ref: REF, oldOid: ZERO_OID, newOid: source.oid });
// a stream of `bytes` cut every `size`, recording whether it was read and cancelled
const streamOf = (bytes, size = 4096, end = c => c.close()) => {
  const state = { pulls: 0, cancelled: 0 };
  let at = 0;
  const stream = new ReadableStream({
    pull(c) {
      state.pulls++;
      if (at >= bytes.length) { end(c); return; }
      c.enqueue(bytes.slice(at, at + size));
      at += size;
    },
    cancel() { state.cancelled++; },
  }, { highWaterMark: 0 });
  return { stream, state };
};
// every receive-pack POST: what the body was, and the bytes the server was sent when it is drained here
const capture = () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/git-receive-pack')) seen.push({ streamed: typeof init.body?.getReader === 'function', duplex: init.duplex ?? null, redirect: init.redirect });
    return fetch(url, init);
  };
  return { seen, fetchImpl };
};
const transport = (url, opts = {}) => unwrap(createTransport(url, opts));
const report = () => concat([unwrap(pkt('unpack ok\n')), unwrap(pkt(`ok ${REF}\n`)), FLUSH]);
const reportResponse = () => new Response(report(), { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' } });
// the POST goes to `post`; everything else (the advertisement GET) to the real server
const routed = post => async (url, init) => (String(url).endsWith('/git-receive-pack') ? post(init) : fetch(url, init));
const drain = async body => {
  const reader = body.getReader();
  let bytes = 0;
  try { for (;;) { const r = await reader.read(); if (r.done) return { bytes, error: null }; bytes += r.value.length; } } catch (e) { return { bytes, error: e }; }
};
const assertAmbiguous = (r, original) => {
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'ambiguous', r.error.message);
  assert.equal(r.error.original, original);
};

test('a stock git pack of known length: chunked stream, ref moves, fsck --strict clean, span counts the body', async () => {
  const { bare, url } = repo();
  const { seen, fetchImpl } = capture();
  const ex = arrayExporter();
  const { stream } = streamOf(source.pack);
  const r = await pushPack(transport(url, { fetchImpl, tracer: new Tracer({ exporter: ex }) }), { ...create(), pack: stream, length: source.pack.length });
  assert.equal(r.ok, true, r.error?.message);
  assert.deepEqual(seen, [{ streamed: true, duplex: 'half', redirect: 'error' }]);
  assert.equal(r.value.packBytes, source.pack.length);
  assert.deepEqual(r.value.entries, []);
  assert.equal(r.value.report.tag, 'statuses');
  assert.equal(tipOf(bare), source.oid);
  assert.deepEqual(fsckProblems(bare, { args: ['--strict'] }), []);
  const span = ex.lines.flatMap(flattenLine).find(s => s.name === 'git.receive-pack');
  assert.equal(span.attrs['git.push.pack.bytes'], source.pack.length);
  const prefix = span.attrs['git.request.bytes'] - source.pack.length;
  assert.ok(prefix > 100 && prefix < 400, String(prefix));
  assert.equal(span.attrs['http.request.body.size'], span.attrs['git.request.bytes']);
});

test('an unknown length, cut into small chunks, through GitHttp: the same push', async () => {
  const { bare, url } = repo();
  const { stream } = streamOf(source.pack, 1000);
  const r = await unwrap(GitHttp.create(url)).pushPack({ commands: [create()], pack: stream });
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(r.value.packBytes, source.pack.length);
  assert.equal(tipOf(bare), source.oid);
  assert.deepEqual(fsckProblems(bare, { args: ['--strict'] }), []);
});

test('empty chunks in the stream are skipped; a chunk may be any Uint8Array', async () => {
  const { bare, url } = repo();
  const parts = [new Uint8Array(0), source.pack.subarray(0, 12), new Uint8Array(0), source.pack.subarray(12), new Uint8Array(0)];
  const stream = new ReadableStream({ pull(c) { const p = parts.shift(); if (p === undefined) c.close(); else c.enqueue(p); } }, { highWaterMark: 0 });
  const r = await pushPack(transport(url), { ...create(), pack: stream, length: source.pack.length });
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(tipOf(bare), source.oid);
});

test('a source shorter than length: ambiguous (bad_request), its last chunk withheld, the ref does not move', async () => {
  const { bare, url } = repo();
  let got = null;
  const fetchImpl = routed(async init => { got = await drain(init.body); return reportResponse(); });
  const { stream } = streamOf(source.pack, 4096);
  const r = await pushPack(transport(url, { fetchImpl }), { ...create(), pack: stream, length: source.pack.length + 1, sideband: false });
  assertAmbiguous(r, 'bad_request');
  assert.match(r.error.message, /yielded \d+ bytes where length said/u);
  assert.equal(r.error.cause.got, source.pack.length);
  assert.equal(r.error.cause.max, source.pack.length + 1);
  // the server never got the last chunk, so it never got the trailer
  assert.ok(got.error !== null);
  assert.ok(got.bytes < source.pack.length, `${got.bytes}`);
  assert.equal(tipOf(bare), null);
});

test('a source longer than length: refused at the chunk that goes over, which is never sent', async () => {
  const { bare, url } = repo();
  let got = null;
  const fetchImpl = routed(async init => { got = await drain(init.body); return reportResponse(); });
  const { stream, state } = streamOf(source.pack, 4096);
  const length = 4096 * 3;
  const r = await pushPack(transport(url, { fetchImpl }), { ...create(), pack: stream, length, sideband: false });
  assertAmbiguous(r, 'bad_request');
  assert.equal(r.error.cause.max, length);
  assert.equal(r.error.cause.got, 4096 * 4);
  assert.ok(got.bytes <= length + 400, `${got.bytes}`);
  assert.equal(state.cancelled, 1);
  assert.equal(tipOf(bare), null);
});

test('length equal to what the source yields, against a mismatch by one in each direction, is the only pass', async () => {
  for (const [delta, landed] of [[0, true], [-1, false], [1, false]]) {
    const { bare, url } = repo();
    const { stream } = streamOf(source.pack);
    const r = await pushPack(transport(url), { ...create(), pack: stream, length: source.pack.length + delta });
    assert.equal(r.ok, landed, `${delta}: ${r.error?.message}`);
    assert.equal(tipOf(bare), landed ? source.oid : null, String(delta));
  }
});

test('an errored source: ambiguous (internal), its cause kept, the ref does not move', async () => {
  const { bare, url } = repo();
  const boom = new Error('source died');
  const { stream } = streamOf(source.pack.subarray(0, 20_000), 4096, c => c.error(boom));
  const r = await pushPack(transport(url), { ...create(), pack: stream });
  assertAmbiguous(r, 'internal');
  assert.equal(r.error.cause.cause, boom);
  assert.equal(tipOf(bare), null);
});

test('a runtime that ends an errored body as if complete: a clean report is still not "landed"', async () => {
  const { url } = repo();
  const fetchImpl = routed(async init => { await drain(init.body); return reportResponse(); });
  const { stream } = streamOf(source.pack.subarray(0, 20_000), 4096, c => c.error(new Error('source died')));
  const r = await pushPack(transport(url, { fetchImpl }), { ...create(), pack: stream, sideband: false });
  assertAmbiguous(r, 'internal');
});

test('a chunk that is not bytes: ambiguous (bad_request), nothing after it sent', async () => {
  const { bare, url } = repo();
  const stream = new ReadableStream({ start(c) { c.enqueue('not bytes'); c.close(); } });
  const r = await pushPack(transport(url), { ...create(), pack: stream });
  assertAmbiguous(r, 'bad_request');
  assert.equal(r.error.cause.what, 'push pack chunk');
  assert.equal(tipOf(bare), null);
});

test('over maxPackBytes with a known length: limit_exceeded before any request, the stream unread and unlocked', async () => {
  const { url } = repo();
  let requests = 0;
  const fetchImpl = async (u, init) => { requests++; return fetch(u, init); };
  const { stream, state } = streamOf(source.pack);
  const r = await pushPack(transport(url, { fetchImpl, limits: withLimits({ maxPackBytes: 100 }) }), { ...create(), pack: stream, length: 101 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'limit_exceeded');
  assert.equal(r.error.got, 101);
  assert.equal(r.error.max, 100);
  assert.equal(requests, 0);
  assert.equal(state.pulls, 0);
  assert.equal(stream.locked, false);
});

test('exactly maxPackBytes passes, with a known length and an unknown one', async () => {
  for (const length of [source.pack.length, null]) {
    const { bare, url } = repo();
    const { stream } = streamOf(source.pack);
    const r = await pushPack(transport(url, { limits: withLimits({ maxPackBytes: source.pack.length }) }), { ...create(), pack: stream, length });
    assert.equal(r.ok, true, r.error?.message);
    assert.equal(tipOf(bare), source.oid);
  }
});

test('over maxPackBytes with no length: refused mid-stream at the chunk that crosses, never sent; the source is cancelled', async () => {
  const { bare, url } = repo();
  let got = null;
  const fetchImpl = routed(async init => { got = await drain(init.body); return reportResponse(); });
  const { stream, state } = streamOf(source.pack, 4096);
  const max = 4096 * 2 + 1;
  const r = await pushPack(transport(url, { fetchImpl, limits: withLimits({ maxPackBytes: max }) }), { ...create(), pack: stream, sideband: false });
  assertAmbiguous(r, 'limit_exceeded');
  assert.equal(r.error.cause.got, 4096 * 3);
  assert.equal(r.error.cause.max, max);
  assert.ok(got.bytes < max + 400, `${got.bytes}`);
  assert.equal(state.cancelled, 1);
  assert.equal(tipOf(bare), null);
});

// #246: a pack the server cannot unpack is a definite refusal, never ambiguous; nothing moves
test('a corrupt pack against stock git: push_rejected (git\'s unpack failure), the ref not moved, nothing read back', async () => {
  const { createHash } = await import('node:crypto');
  const withTrailer = body => concat([body, new Uint8Array(createHash('sha1').update(body).digest())]);
  const body = source.pack.subarray(0, source.pack.length - 20);
  // a zlib stream damaged inside the first object, and a first entry of type 0 (invalid), both with a valid trailer
  const damaged = new Uint8Array(body); damaged[40] ^= 0xff;
  const type0 = new Uint8Array(body); type0[12] &= 0x8f;
  for (const pack of [withTrailer(damaged), withTrailer(type0)]) {
    const { bare, url } = repo();
    const posts = [];
    const fetchImpl = async (u, init) => { posts.push(String(u).split('/').at(-1)); return fetch(u, init); };
    const r = await pushPack(transport(url, { fetchImpl }), { ...create(), pack: streamOf(pack).stream, length: pack.length });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'push_rejected', r.error.message);
    assert.equal(r.error.report.tag, 'unpackFailed');
    assert.equal(tipOf(bare), null);
    assert.equal(posts.filter(p => p === 'git-upload-pack').length, 0, 'a definite answer reads nothing back');
  }
});

// #246: Artifacts' unpack failure (observed bytes, 2026-11-10) through the real transport: push_rejected with its reason
test('a host\'s echoed unpack failure (Cloudflare Artifacts\' report bytes) is push_rejected with the host\'s reason', async () => {
  const { url } = repo();
  const reason = 'invalid pack entry type 0';
  const inner = concat([unwrap(pkt(`unpack ${reason}\n`)), unwrap(pkt(`ng ${REF} ${reason}\n`)), FLUSH]);
  const sideband = concat([unwrap(pkt(concat([Uint8Array.of(1), inner]))), FLUSH]);
  const answer = () => new Response(sideband, { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' } });
  const fetchImpl = routed(async init => { await drain(init.body); return answer(); });
  const r = await pushPack(transport(url, { fetchImpl }), { ...create(), pack: streamOf(source.pack).stream, length: source.pack.length });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'push_rejected', r.error.message);
  assert.equal(r.error.message, `push rejected: ${reason}`);
  assert.equal(r.error.report.status, reason);
});

test('a stale old oid is cas_conflict, as push reports it', async () => {
  const { bare, url } = repo();
  const first = await pushPack(transport(url), { ...create(), pack: streamOf(source.pack).stream });
  assert.equal(first.ok, true, first.error?.message);
  const again = await pushPack(transport(url), { ...create(), pack: streamOf(source.pack).stream });
  assert.equal(again.ok, false);
  assert.equal(again.error.code, 'cas_conflict', again.error.message);
  assert.equal(tipOf(bare), source.oid);
});

test('a lost response after the body went out is ambiguous, and the unfinished source is cancelled', async () => {
  const { url } = repo();
  // the body went out: the transport took its first chunk (the command list) before the connection was lost. A
  // failure before that first pull is the definite one (test/push-pack-preabort.test.js).
  let taken = 0;
  const fetchImpl = routed(async init => { taken += (await init.body.getReader().read()).value.length; throw new TypeError('network gone'); });
  const { stream, state } = streamOf(source.pack);
  const r = await pushPack(transport(url, { fetchImpl }), { ...create(), pack: stream });
  assert.ok(taken > 0);
  assertAmbiguous(r, 'network');
  assert.equal(state.cancelled, 1);
});

test('a server that answers without reading the pack: its report decides, and the source is cancelled', async () => {
  const { url } = repo();
  const { stream, state } = streamOf(source.pack);
  const r = await pushPack(transport(url, { fetchImpl: routed(async () => reportResponse()) }), { ...create(), pack: stream, sideband: false });
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(r.value.packBytes, 0);
  assert.equal(state.cancelled, 1);
});

test('a source that fails to cancel changes nothing', async () => {
  const { url } = repo();
  const stream = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { throw new Error('cannot cancel'); } }, { highWaterMark: 0 });
  const r = await pushPack(transport(url, { fetchImpl: routed(async () => reportResponse()) }), { ...create(), pack: stream, sideband: false });
  assert.equal(r.ok, true, r.error?.message);
});

test('the body cancelled by the transport cancels the source', async () => {
  const { url } = repo();
  const fetchImpl = routed(async init => { await init.body.cancel('gone'); return reportResponse(); });
  const { stream, state } = streamOf(source.pack);
  const r = await pushPack(transport(url, { fetchImpl }), { ...create(), pack: stream, sideband: false });
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(state.cancelled, 1);
});

test('atomic: checked against the advertisement, then sent; two refs land together', async () => {
  const { bare, url } = repo();
  const { stream } = streamOf(source.pack);
  const commands = [create(), { ref: 'refs/heads/other', oldOid: ZERO_OID, newOid: source.oid }];
  const r = await pushPack(transport(url), { commands, pack: stream, length: source.pack.length, atomic: true });
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(tipOf(bare), source.oid);
  assert.equal(git(bare, ['rev-parse', 'refs/heads/other']).trim(), source.oid);
});

test('atomic the server does not advertise: unsupported, no POST, the pack unread', async () => {
  const { url } = repo();
  const advert = concat([unwrap(pkt('# service=git-receive-pack\n')), FLUSH, unwrap(pkt(`${ZERO_OID} capabilities^{}\0report-status\n`)), FLUSH]);
  let posts = 0;
  const fetchImpl = async u => {
    if (String(u).endsWith('/git-receive-pack')) { posts++; return reportResponse(); }
    return new Response(advert, { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-advertisement' } });
  };
  const { stream, state } = streamOf(source.pack);
  const r = await pushPack(transport(url, { fetchImpl }), { ...create(), pack: stream, atomic: true });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'unsupported');
  assert.equal(posts, 0);
  assert.equal(state.pulls, 0);
  assert.equal(stream.locked, false);
});

test('push options: refused when not advertised, sent when they are', async () => {
  const { url } = repo();
  const { stream } = streamOf(source.pack);
  const r = await pushPack(transport(url), { ...create(), pack: stream, pushOptions: ['ci.skip'] });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'unsupported');
  // the checked form writes the options after the commands' flush
  const checked = unwrap(checkPushCaps(new Set(['report-status', 'push-options', 'object-format=sha1']), { pushOptions: ['ci.skip'] }));
  let body = null;
  const fetchImpl = routed(async init => { const chunks = []; const reader = init.body.getReader(); for (;;) { const c = await reader.read(); if (c.done) break; chunks.push(c.value); } body = concat(chunks); return reportResponse(); });
  const sent = await pushPackChecked(transport(url, { fetchImpl }), { ...create(), pack: streamOf(new Uint8Array([1, 2, 3])).stream, checked, sideband: false });
  assert.equal(sent.ok, true, sent.error?.message);
  const text = new TextDecoder('latin1').decode(body);
  assert.ok(text.includes('000cci.skip\n0000'), text.slice(0, 300));
  assert.ok(body.subarray(-3).every((b, i) => b === i + 1));
});

test('refusals with nothing read: a missing, locked or non-stream pack; objects; only deletes; a bad length; a bad ref', async () => {
  const { url } = repo();
  const t = transport(url);
  const stream = () => streamOf(source.pack).stream;
  const locked = stream(); locked.getReader();
  const cases = [
    [{ ...create() }, 'pack'],
    [{ ...create(), pack: 'bytes' }, 'pack'],
    [{ ...create(), pack: source.pack }, 'pack'],
    [{ ...create(), pack: locked }, 'pack'],
    [{ ...create(), pack: stream(), objects: [] }, 'objects'],
    [{ ref: REF, oldOid: source.oid, newOid: ZERO_OID, pack: stream() }, 'pack'],
  ];
  for (const [opts, what] of cases) {
    const r = await pushPack(t, opts);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'bad_request', r.error.message);
    assert.equal(r.error.what, what);
  }
  for (const length of [-1, 1.5, '12', Number.NaN, Number.MAX_SAFE_INTEGER + 1, {}]) {
    const r = await pushPack(t, { ...create(), pack: stream(), length });
    assert.equal(r.ok, false, String(length));
    assert.equal(r.error.code, 'bad_request', String(length));
    assert.equal(r.error.what, 'length');
  }
  const badRef = await pushPack(t, { ref: 'not a ref', oldOid: ZERO_OID, newOid: source.oid, pack: stream() });
  assert.equal(badRef.error.code, 'bad_request');
  const noWants = await pushPackChecked(t, { ...create(), pack: stream(), atomic: true });
  assert.equal(noWants.error.code, 'bad_request', 'unchecked atomic is refused, not dropped');
});

test('planPackPush: length 0 and null are lengths; the cap is on the pack', () => {
  const pack = () => streamOf(source.pack).stream;
  const zero = unwrap(planPackPush({ ...create(), pack: pack(), length: 0 }, withLimits({ maxPackBytes: 0 })));
  assert.equal(zero.length, 0);
  assert.equal(unwrap(planPackPush({ ...create(), pack: pack() }, null)).length, null);
  assert.equal(unwrap(planPackPush({ ...create(), pack: pack(), length: null }, null)).length, null);
  assert.equal(planPackPush({ ...create(), pack: pack(), length: 2 }, withLimits({ maxPackBytes: 1 })).error.code, 'limit_exceeded');
});

test('memory: a pack far larger than held memory holds about two chunks', async () => {
  const chunk = 1 << 20;
  const chunks = 256; // 256 MiB
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...MEMORY_CELL_FLAGS, '--import', './test/ts-resolve.mjs', 'test/push-pack-child.mjs', String(chunk), String(chunks)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let text = '';
    child.stdout.on('data', d => { text += d; });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(JSON.parse(text)) : reject(new Error(`child exited ${code}`))));
  });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.packBytes, chunk * chunks);
  assert.equal(out.bytesSeen > chunk * chunks, true);
  console.log(JSON.stringify(out));
  // Two chunks: the one being written and the one the source made next (2,097,288 B on node 24, 2,097,292 B on node 22).
  // Before #249 node 22 read 11.5 MiB here: the backing stores of dropped chunks still counted until V8's background
  // sweep reached them, which MEMORY_CELL_FLAGS now does with the gc. A third chunk is a copy or a tee.
  assert.ok(out.samples >= 10, JSON.stringify(out));
  assert.ok(out.liveDelta < 3 * chunk, JSON.stringify(out));
}, 180_000);
