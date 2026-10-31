// The pipeline's pure decisions, exercised without a server. Oracles: node zlib / git for codecs, the invariants
// themselves for the decisions (every branch of decideHead, every rejection of lookupEntry, buildCommitObjects ≡ git).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rng } from './fuzz/prng.js';
import { validateSpec, decideHead, lookupEntry, buildCommitObjects, memFromScan, memAttrs, scanInit, scanStep, MATCH_OFFSETS_KEPT } from '../src/edit.js';
import { zlibDeflate, spliceDelta } from '../src/pack.js';
import { inflate } from '../src/inflate.js';
import { encodeTree, hashObject, parseCommit, TYPE } from '../src/objects.js';
import { DEFAULT_LIMITS, withLimits } from '../src/limits.js';
import { thrown as fail, scrubError } from '../src/errors.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40);

test('decideHead: every branch', () => {
  assert.deepEqual(decideHead({ hint: null, resolved: A }), { oldCommit: A, hint: null });
  assert.deepEqual(decideHead({ hint: A, resolved: A }), { oldCommit: A, hint: 'used' });
  assert.deepEqual(decideHead({ hint: A, resolved: B }), { oldCommit: B, hint: 'stale' }, 'ls-refs wins over the hint');
});

test('validateSpec: rejects before any I/O, freezes the plan', () => {
  const ok = validateSpec({ path: 'a/b.txt', find: 'x', replace: 'y', author: { name: 'n', email: 'e@x' }, message: 'm', time: 1 }, DEFAULT_LIMITS, A);
  assert.ok(Object.isFrozen(ok)); assert.deepEqual(ok.comps, ['a', 'b.txt']); assert.equal(ok.head, A);
  const base = { path: 'a', find: 'x', replace: 'y', author: { name: 'n', email: 'e@x' }, message: 'm' };
  for (const [bad, code] of [[{ ...base, find: '' }, 'bad_request'], [{ ...base, time: -1 }, 'bad_request'], [{ ...base, time: 1.5 }, 'bad_request'], [{ ...base, find: 42 }, 'bad_request'], [{ ...base, path: '.git/config' }, 'bad_request'], [{ ...base, ref: 'refs/heads/a..b' }, 'bad_request'], [{ ...base, author: { name: 'n<', email: 'e' } }, 'bad_request']]) {
    assert.throws(() => validateSpec(bad, DEFAULT_LIMITS), e => e.code === code || e.code === 'bad_request', JSON.stringify(bad));
  }
  assert.throws(() => validateSpec(base, DEFAULT_LIMITS, 'short'), e => e.code === 'bad_request');
});

test('lookupEntry: found/dir/file/mode rules and the entries limit, with attrs on every outcome', () => {
  const tree = encodeTree([{ mode: '40000', name: 'dir', oid: A }, { mode: '100644', name: 'f', oid: B }, { mode: '120000', name: 'link', oid: A }, { mode: '160000', name: 'sub', oid: B }, { mode: '100755', name: 'x', oid: A }]);
  assert.equal(lookupEntry(tree, 'dir', false, DEFAULT_LIMITS).entry.oid, A);
  assert.equal(lookupEntry(tree, 'f', true, DEFAULT_LIMITS).entry.oid, B);
  assert.equal(lookupEntry(tree, 'x', true, DEFAULT_LIMITS).entry.mode, '100755');
  for (const [name, last, re] of [['nope', true, /not found/], ['f', false, /not a directory/], ['dir', true, /not a regular file/], ['link', true, /not a regular file/], ['sub', true, /not a regular file/], ['sub', false, /not a directory/]]) {
    assert.throws(() => lookupEntry(tree, name, last, DEFAULT_LIMITS), e => e.code === 'not_found' && re.test(e.message) && typeof e.attrs['git.edit.tree.entries'] === 'number', `${name}/${last}`);
  }
  assert.throws(() => lookupEntry(tree, 'f', true, withLimits({ maxTreeEntries: 4 })), e => e.code === 'limit_exceeded');
});

test('buildCommitObjects ≡ git: trees and commit hash to what git computes, delta list is thin and minimal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-pure-'));
  try {
    const git = (args, input) => execFileSync('git', ['-C', dir, ...args], { input, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' } }).trim();
    git(['init', '-q', '--bare']);
    const oldBlob = git(['hash-object', '-w', '--stdin'], 'hello MARK\n'), newBlob = git(['hash-object', '-w', '--stdin'], 'hello DONE\n');
    const other = git(['hash-object', '-w', '--stdin'], 'other\n');
    const leafData = encodeTree([{ mode: '100644', name: 'file.txt', oid: oldBlob }, { mode: '100644', name: 'z', oid: other }]);
    const leafOid = git(['mktree'], `100644 blob ${oldBlob}\tfile.txt\n100644 blob ${other}\tz\n`);
    assert.equal(hashObject('tree', leafData), leafOid);
    const rootData = encodeTree([{ mode: '40000', name: 'd', oid: leafOid }]);
    const rootOid = git(['mktree'], `040000 tree ${leafOid}\td\n`);
    const levels = [{ treeOid: rootOid, data: rootData, entry: lookupEntry(rootData, 'd', false, DEFAULT_LIMITS).entry }, { treeOid: leafOid, data: leafData, entry: lookupEntry(leafData, 'file.txt', true, DEFAULT_LIMITS).entry }];
    const base = 'hello MARK\n';
    const { delta } = spliceDelta({ baseLen: base.length, off: 6, oldLen: 4, insert: new TextEncoder().encode('DONE') });
    const parent = git(['commit-tree', rootOid, '-m', 'p'], undefined);
    const built = buildCommitObjects({ levels, blob: { oldOid: oldBlob, newOid: newBlob, delta, newLen: base.length }, oldCommit: parent, author: { name: 'n', email: 'e@x' }, time: 1700000000, message: 'm' });
    // git's answer for the same edit
    const gitLeaf = git(['mktree'], `100644 blob ${newBlob}\tfile.txt\n100644 blob ${other}\tz\n`), gitRoot = git(['mktree'], `040000 tree ${gitLeaf}\td\n`);
    assert.deepEqual(built.trees.map(t => t.newOid), [gitRoot, gitLeaf]);
    const env = { GIT_AUTHOR_NAME: 'n', GIT_AUTHOR_EMAIL: 'e@x', GIT_COMMITTER_NAME: 'n', GIT_COMMITTER_EMAIL: 'e@x', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000' };
    const gitCommit = execFileSync('git', ['-C', dir, 'commit-tree', gitRoot, '-p', parent, '-m', 'm'], { encoding: 'utf8', env: { ...process.env, ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' } }).trim();
    assert.equal(built.newCommit, gitCommit);
    assert.equal(parseCommit(built.commitData).parents[0], parent);
    // object list: commit (full) + one REF_DELTA per tree + blob REF_DELTA
    assert.deepEqual(built.objects.map(o => [o.type, !!o.baseOid]), [[TYPE.COMMIT, false], [TYPE.TREE, true], [TYPE.TREE, true], [TYPE.BLOB, true]]);
    assert.deepEqual(built.objects.slice(1).map(o => o.baseOid), [rootOid, leafOid, oldBlob]);
    // a < 4-byte delta becomes a full blob (git's DELTA_SIZE_MIN)
    const tiny = buildCommitObjects({ levels, blob: { oldOid: oldBlob, newOid: newBlob, delta: new Uint8Array(3), newLen: 0 }, oldCommit: parent, author: { name: 'n', email: 'e@x' }, time: 1, message: 'm' });
    assert.equal(tiny.objects.at(-1).baseOid, undefined); assert.equal(tiny.objects.at(-1).data.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deflate only: a stored-block zlib stream never beats CompressionStream (the reason buildPack has no stored path)', async () => {
  // hand-rolled stored zlib, test-side only: 2 header + 5/block + 4 adler
  const stored = d => { const n = Math.max(1, Math.ceil(d.length / 65535)); const o = new Uint8Array(2 + d.length + 5 * n + 4); o[0] = 0x78; o[1] = 0x01; let p = 2, q = 0; for (let b = 0; b < n; b++) { const len = Math.min(65535, d.length - q); o[p++] = b === n - 1 ? 1 : 0; o[p++] = len & 255; o[p++] = len >> 8; o[p++] = ~len & 255; o[p++] = (~len >> 8) & 255; o.set(d.subarray(q, q + len), p); p += len; q += len; } let a = 1, c = 0; for (const x of d) { a = (a + x) % 65521; c = (c + a) % 65521; } const ad = ((c << 16) | a) >>> 0; o[p++] = ad >>> 24; o[p++] = (ad >>> 16) & 255; o[p++] = (ad >>> 8) & 255; o[p] = ad & 255; return o; };
  const rng = new Rng(7);
  for (let i = 0; i < 200; i++) {
    const n = i < 40 ? i : rng.int(0, 70000);
    const data = rng.int(0, 1) ? rng.bytes(n) : new Uint8Array(n).fill(0x61);
    const zs = stored(data), zd = await zlibDeflate(data);
    assert.deepEqual(new Uint8Array(zlib.inflateSync(zs)), data);
    assert.deepEqual(inflate(zs, 0, { expectedSize: n }).out, data, 'our inflate handles multi-block stored streams');
    // zlib's own stored blocks are ~16 KiB, ours 64 KiB: deflate can lose by ≤5 bytes per 16 KiB on incompressible input, nothing more
    assert.ok(zd.length <= zs.length + 5 * Math.ceil(n / 16384), `n=${n}: deflate ${zd.length} vs stored ${zs.length}`);
  }
});

test('scanStep counts every match and keeps the first MATCH_OFFSETS_KEPT offsets; each hit is O(1) (#13)', () => {
  // CPU time, not wall clock, so load on the box does not count; scaling 16 -> 128 KiB, so a slow machine cancels.
  // Linear is ~8x (measured 4-7x); the old per-hit offset copy was quadratic (64x and up). A noisy 24-64x is re-measured.
  const run = n => {
    const data = new Uint8Array(n).fill(0x61);
    let st = scanInit({ find: Uint8Array.of(0x61), replace: Uint8Array.of(0x62) });
    const t0 = process.cpuUsage();
    for (let o = 0; o < n; o += 16384) st = scanStep(st, data.subarray(o, o + 16384)).state;
    const d = process.cpuUsage(t0);
    return { st, ms: (d.user + d.system) / 1000 };
  };
  run(16 << 10); // warm-up
  const small = Math.max(Math.min(run(16 << 10).ms, run(16 << 10).ms, run(16 << 10).ms), 0.05);
  let big = run(128 << 10);
  for (let k = 0; k < 2 && big.ms >= 24 * small && big.ms < 64 * small; k++) { const r = run(128 << 10); if (r.ms < big.ms) big = r; }
  assert.ok(big.ms < 24 * small, `128 KiB of matches cost ${big.ms.toFixed(2)} ms CPU, ${(big.ms / small).toFixed(1)}x 16 KiB (${small.toFixed(2)} ms); linear is ~8x`);
  const { st } = big;
  assert.equal(st.count, 128 << 10);
  assert.equal(st.emitted, 128 << 10);
  assert.deepEqual(st.matches, Array.from({ length: MATCH_OFFSETS_KEPT }, (_, i) => i));
  const two = scanStep(scanInit({ find: Uint8Array.of(1), replace: new Uint8Array(0) }), Uint8Array.of(1, 0, 1)).state;
  assert.equal(two.count, 2);
  assert.deepEqual(two.matches, [0, 2]);
});

test('memFromScan/memAttrs: whole-edit accounting from what was held', () => {
  let st = scanInit({ find: new Uint8Array([1]), replace: new Uint8Array(0) });
  for (const n of [10, 4096, 100, 4096]) st = scanStep(st, new Uint8Array(n)).state;
  assert.deepEqual(memFromScan(st, 8302), { 'mem.alloc.inflate_chunk.bytes': 8302, 'mem.alloc.inflate_chunk.count': 4, 'mem.alloc.inflate_chunk.max_single': 4096 });
  const m = memAttrs({ objects: [190, 777, 777], scan: st, inflated: 8302 });
  assert.equal(m['mem.alloc.bytes'], 190 + 777 + 777 + 8302); assert.equal(m['mem.alloc.count'], 3 + 4); assert.equal(m['mem.alloc.max_single'], 4096); assert.equal(m['mem.alloc.object.count'], 3);
});

test('otel: links, event cap, isolate counter, flatten round-trip', () => {
  const ex = arrayExporter(); const t = new Tracer({ exporter: ex, maxEvents: 2 });
  const a = t.start('a'); a.end();
  const b = t.start('b'); b.link(a, { 'ply.link': 'retry_of' }); b.event('x'); b.event('y'); b.event('z'); b.end();
  const [fa, fb] = ex.lines.flatMap(flattenLine);
  assert.equal(fb.links.length, 1); assert.equal(fb.links[0].spanId, fa.spanId); assert.equal(fb.links[0].attrs['ply.link'], 'retry_of');
  assert.equal(fb.events.length, 2); assert.equal(fb.droppedEvents, 1);
  assert.equal(fb.attrs['ply.isolate.invocation'], fa.attrs['ply.isolate.invocation'] + 1); assert.equal(fb.attrs['ply.isolate.cold'], false);
  const c = t.start('c', { parent: b }); c.end();
  assert.equal(ex.lines.flatMap(flattenLine)[2].attrs['ply.isolate.invocation'], undefined, 'child spans do not count as invocations');
});

test('otel: a follows span is the root of its own trace, linked both ways while the followed span is open; links are capped', () => {
  const ex = arrayExporter(); const t = new Tracer({ exporter: ex, maxEvents: 2 });
  const op = t.start('git.op', { scrub: s => s.replaceAll('SECRET', '[redacted]') });
  const f = t.start('git.op.stream', { follows: op, attrs: { 'git.op.stream.note': 'SECRET' } });
  assert.notEqual(f.traceId, op.traceId); assert.equal(f.parentSpanId, undefined);
  op.end();
  const late = t.start('git.op.late', { follows: op }); late.end(); // op already exported: no link back
  t.start('x', { follows: f }); t.start('y', { follows: f }); // f has follows_from + 2 followed_by → the second is dropped
  f.end();
  const [fo, fl, ff] = ex.lines.map(l => l.resourceSpans[0].scopeSpans[0].spans[0]);
  const flat = ex.lines.flatMap(flattenLine);
  assert.deepEqual(flat[0].links.map(l => [l.spanId, l.attrs['ply.link']]), [[f.spanId, 'followed_by']]);
  assert.deepEqual(flat[1].links.map(l => [l.traceId, l.spanId, l.attrs['ply.link']]), [[op.traceId, op.spanId, 'follows_from']]);
  assert.deepEqual(flat[2].links.map(l => l.attrs['ply.link']), ['follows_from', 'followed_by']);
  assert.deepEqual([fo.droppedLinksCount, fl.droppedLinksCount, ff.droppedLinksCount], [0, 0, 1]);
  assert.equal(flat[2].attrs['git.op.stream.note'], '[redacted]', 'a follower inherits the scrub of the span it follows');
  assert.equal(flat[2].attrs['ply.isolate.invocation'], undefined, 'a follower is not an invocation');
  assert.throws(() => t.start('z', { parent: op, follows: op }), TypeError);
});

test('inflate: an incomplete huffman table with a hole is rejected (invalid huffman code), and zlib agrees', () => {
  // Dynamic block whose lit/len table has a single code (EOB, length 8): the table is incomplete, so a bit pattern that is
  // not that code decodes to nothing. Built bit by bit, LSB-first as deflate reads it.
  const bits = []; const put = (v, n) => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); };
  put(1, 1); put(2, 2);                                   // BFINAL=1, BTYPE=dynamic
  put(0, 5); put(0, 5); put(1, 4);                        // HLIT=257, HDIST=1, HCLEN=5 → code-length symbols in order 16,17,18,0,8
  put(0, 3); put(0, 3); put(0, 3); put(1, 3); put(1, 3);  // symbol 0 → length 1 (code 0), symbol 8 → length 1 (code 1)
  for (let i = 0; i < 256; i++) put(0, 1);                // literals 0..255: length 0
  put(1, 1);                                              // symbol 256 (EOB): length 8
  put(0, 1);                                              // the one distance symbol: length 0
  for (let i = 0; i < 16; i++) put(1, 1);                 // data: 1111…, which is not the EOB code (00000000)
  const raw = Uint8Array.from(Array.from({ length: Math.ceil(bits.length / 8) }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((b, v, j) => b | (v << j), 0)));
  assert.throws(() => inflate(raw, 0, { raw: true, maxOutput: 1024 }), e => e.code === 'pack_corrupt' && /invalid huffman code/.test(e.message));
  assert.throws(() => zlib.inflateRawSync(raw), /invalid|incomplete|Z_DATA_ERROR/i, 'node zlib rejects it too');
});

test('parsePack: reserved object types 0 and 5 are rejected', async () => {
  const { parsePack } = await import('../src/packresolve.js');
  const { encodeObjHeader } = await import('../src/pack.js');
  const { Sha1 } = await import('../src/sha1.js');
  const { concat } = await import('../src/bytes.js');
  for (const type of [0, 5]) {
    const hdr = new Uint8Array(12); hdr.set([0x50, 0x41, 0x43, 0x4b]); new DataView(hdr.buffer).setUint32(4, 2); new DataView(hdr.buffer).setUint32(8, 1);
    const body = concat([hdr, encodeObjHeader(type, 3), await zlibDeflate(new Uint8Array([1, 2, 3]))]);
    const pack = concat([body, new Sha1().update(body).digest()]);
    assert.throws(() => parsePack(pack), e => e.code === 'pack_corrupt' && /bad object type/.test(e.message), `type ${type}`);
  }
});

test('otel: anyValue stringifies objects, fromAny reads bytes', async () => {
  const { anyValue, fromAny } = await import('../src/otel.js');
  assert.deepEqual(anyValue({ a: 1 }), { stringValue: '[object Object]' });
  assert.equal(fromAny({ bytesValue: 'AQID' }), 'AQID');
  assert.deepEqual(anyValue(new Uint8Array([1, 2, 3])), { bytesValue: btoa('\x01\x02\x03') });
});

test('streamingSha1: uses crypto.DigestStream when the platform has one (shimmed here), same digest as pure JS', async () => {
  const { streamingSha1, Sha1 } = await import('../src/sha1.js');
  assert.equal(streamingSha1().kind, 'js', 'node has no DigestStream');
  class FakeDigestStream extends WritableStream {
    constructor(alg) { let h = new Sha1(); let resolve; const digest = new Promise(r => { resolve = r; }); super({ write(c) { h.update(c); }, close() { resolve(h.digest().buffer); } }); this.digest = digest; assert.equal(alg, 'SHA-1'); }
  }
  const orig = globalThis.crypto.DigestStream;
  Object.defineProperty(globalThis.crypto, 'DigestStream', { value: FakeDigestStream, configurable: true, writable: true });
  try {
    const h = streamingSha1(); assert.equal(h.kind, 'digeststream');
    const parts = [new Uint8Array([1, 2, 3]), new Uint8Array(1000).fill(7), new Uint8Array(0)];
    for (const p of parts) await h.update(p);
    const js = new Sha1(); for (const p of parts) js.update(p);
    assert.equal(await h.hex(), js.hex());
  } finally { if (orig === undefined) delete globalThis.crypto.DigestStream; else Object.defineProperty(globalThis.crypto, 'DigestStream', { value: orig, configurable: true }); }
});

test('span naming convention: every span and attribute key in a trace follows the written rules', async () => {
  // Rules (README "Telemetry"):
  //   span names:  git.<service> <command>  for wire round trips (git.upload-pack ls-refs, git.receive-pack, …)
  //                git.<op>                 operation roots (git.edit, git.merge, git.rebase, git.cherry_pick, git.revert)
  //                git.<op>.<phase>         operation children (git.edit.tree, git.edit.blob)
  //                ssh.<phase>              transport phases (ssh.connect, ssh.userauth, ssh.exec)
  //   attr keys:   dotted lowercase ascii with underscores, under one of: git. http. ssh. url. server. mem. error. ply. exception.
  //   outcomes:    every root span has <name>.outcome (operation roots, and the spans that follow them: README "Span lifetimes")
  const { startGitServer, makeBareRepo, tmpRoot, commitFiles, git } = await import('./server.js');
  const { editFile } = await import('../src/edit.js');
  const { join } = await import('node:path'); const { mkdirSync } = await import('node:fs');
  const { root, cleanup } = tmpRoot(); const srv = await startGitServer(root);
  try {
    const bare = makeBareRepo(root, 'nm'); const work = join(root, 'w'); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
    commitFiles(work, bare, { 'a/b.txt': 'MARK\n' }, 'seed');
    const ex = arrayExporter();
    await editFile(`${srv.url}/nm.git`, { path: 'a/b.txt', find: 'MARK', replace: 'X', author: { name: 'n', email: 'n@x' }, message: 'm' }, { tracer: new Tracer({ exporter: ex }), verify: true });
    const spans = ex.lines.flatMap(flattenLine);
    const NAME = /^(git\.(upload-pack|receive-pack)( [a-z-]+)?|git\.[a-z_]+(\.[a-z_]+)?|ssh\.[a-z]+)$/;
    const KEY = /^(git|http|ssh|url|server|mem|error|ply|exception)\.[a-z0-9_.-]+$/;
    for (const s of spans) {
      assert.match(s.name, NAME, `span name ${s.name}`);
      for (const k of Object.keys(s.attrs)) assert.match(k, KEY, `attr ${k} on ${s.name}`);
      if (!s.parentSpanId) assert.ok(`${s.name}.outcome` in s.attrs, `root ${s.name} has no outcome`);
      if (/^git\.(upload-pack|receive-pack)/.test(s.name)) for (const k of ['git.transport', 'git.request.bytes', 'git.response.bytes', 'server.address']) assert.ok(k in s.attrs, `${s.name} lacks ${k}`);
    }
  } finally { await srv.close(); cleanup(); }
});

test('error taxonomy: runtime table and documentation agree; fail refuses unknown codes', async () => {
  const { RETRY, CODES, thrown: fail, retryPolicy, ambiguousAfterPush } = await import('../src/errors.js');
  const { CODE_DOCS } = await import('../src/errors-doc.js');
  assert.deepEqual(Object.keys(CODE_DOCS).sort(), [...CODES].sort(), 'every code documented, nothing documented that does not exist');
  for (const c of CODES) assert.ok(['yes', 'no', 'fresh', 'read'].includes(RETRY[c]), c);
  assert.throws(() => fail('not_a_code', 'x'), /unknown error code/);
  assert.equal(retryPolicy(fail('cas_conflict', 'x')), 'fresh'); assert.equal(retryPolicy(fail('ambiguous', 'x')), 'read'); assert.equal(retryPolicy({ code: 'nope' }), 'no');
  assert.equal(ambiguousAfterPush(fail('network', 'dropped')).code, 'ambiguous'); assert.equal(ambiguousAfterPush(fail('network', 'dropped')).original, 'network');
  // a limit hit while reading the report is after the send: the ref may have moved (pre-send refusals never reach it)
  assert.equal(ambiguousAfterPush(fail('limit_exceeded', 'x')).code, 'ambiguous'); assert.equal(ambiguousAfterPush(fail('limit_exceeded', 'x')).original, 'limit_exceeded');
  const amb = fail('ambiguous', 'y'); assert.equal(ambiguousAfterPush(amb), amb);
});

test('error taxonomy: every fail(\'code\') literal in src/ is in the table (static)', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { CODES } = await import('../src/errors.js');
  const used = new Set();
  for (const f of readdirSync('src')) if (/\.(?:js|ts)$/.test(f)) for (const m of readFileSync(`src/${f}`, 'utf8').matchAll(/fail\('([a-z_0-9]+)'/g)) used.add(m[1]);
  for (const c of used) assert.ok(CODES.includes(c), `fail('${c}') used but not in errors.js`);
  assert.ok(used.size >= 20);
});

test('scrubError walks prototype-less maps (#16: merge reasons, report-status options) as it walks plain objects', () => {
  const options = Object.create(null); options.__proto__ = 'tok SECRET'; options['old-oid'] = 'SECRET';
  const reasons = Object.create(null); reasons['a.txt'] = 'SECRET';
  const e = scrubError(fail('push_rejected', 'x', { report: { refs: [{ options }] }, reasons }), s => s.replaceAll('SECRET', '[redacted]'));
  assert.deepEqual(Object.entries(e.report.refs[0].options), [['__proto__', 'tok [redacted]'], ['old-oid', '[redacted]']]);
  assert.equal(e.reasons['a.txt'], '[redacted]');
});
