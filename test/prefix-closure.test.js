// Prefix closure: for a valid encoding, every strict prefix throws a typed error, or — when the cut lands on an
// entry boundary — parses to a prefix of the entries. A new `export function parse*` (or the other decoder names)
// without an `@decoder name prefix=<id>` annotation fails the registry test at the bottom of this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { te, td, concat, take } from '../src/bytes.js';
import { fromHex } from '../src/sha1.js';
import { fail } from '../src/errors.js';
import {
  parseTree, parseCommit, parseTag, parseIdent, encodeCommit, encodeTag, encodeTree, assertFetched, ident, hashObject, TYPE,
} from '../src/objects.js';
import { pkt, FLUSH, DELIM, pktInit, pktStep, pktFinish } from '../src/pktline.js';
import { encodeObjHeader, buildPack, spliceDelta } from '../src/pack.js';
import { readObjHeader, readOfsDelta, parsePack, applyDelta } from '../src/packresolve.js';
import { inflate } from '../src/inflate.js';
import { parseSideband, spInit, spStep, spFinish, v2Init, v2Step } from '../src/fetch.js';
import { parseLsRefLine } from '../src/lsrefs.js';
import { parseReportStatus } from '../src/push.js';
import { kexInit, parseKexInit } from '../src/ssh.js';
import { parseSshUrl } from '../src/sshgit.js';
import { parseLine, parseFile } from '../src/attributes.js';
import { OID_BYTES, OID_HEX_CHARS, OBJ_CONTINUE, OBJ_SIZE_NEXT_MASK } from '../src/format.js';

const covered = new Set();
const property = (id, name, fn) => { covered.add(id); test(name, fn); };
const oid = n => n.toString(16).padStart(OID_HEX_CHARS, '0');
const oidBytes = n => fromHex(oid(n));
const CODES = new Set(['pack_corrupt', 'protocol', 'ssh', 'bad_request', 'remote_error', 'unsupported']);

function sampleTree() {
  const entries = [
    { mode: '100644', name: 'ab', oid: oid(1) },
    { mode: '100644', name: 'c', oid: oid(2) },
    { mode: '100755', name: 'de', oid: oid(3) },
  ];
  return { entries, bytes: encodeTree(entries) };
}

// The guard Ivar's review caught: `nul + OID_BYTES > length` plus a clamping subarray. Kept here so the property's
// failure mode stays visible — prefix 29 of the 89-byte tree is one byte short of the first object id.
function parseTreePreFix(data) {
  const entries = [];
  let p = 0;
  while (p < data.length) {
    const sp = data.indexOf(0x20, p);
    const nul = data.indexOf(0, sp);
    if (sp < 0 || nul < 0 || nul + OID_BYTES > data.length) throw fail('pack_corrupt', 'tree: malformed entry');
    entries.push({
      mode: td.decode(data.subarray(p, sp)),
      name: td.decode(data.subarray(sp + 1, nul)),
      oid: toHexClamp(data.subarray(nul + 1, nul + 1 + OID_BYTES)),
      oidOffset: nul + 1,
    });
    p = nul + 1 + OID_BYTES;
  }
  return entries;
}
const toHexClamp = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

function assertTree(parse, bytes) {
  const full = parse(bytes);
  const ends = [];
  {
    let p = 0;
    for (const e of full) {
      const head = te.encode(`${e.mode} ${e.name}\0`);
      p += head.length + OID_BYTES;
      ends.push(p);
    }
  }
  for (let i = 1; i < bytes.length; i++) {
    let got;
    try { got = parse(bytes.subarray(0, i)); }
    catch (e) {
      assert.equal(e.code, 'pack_corrupt', `prefix ${i} threw ${e.code}: ${e.message}`);
      continue;
    }
    if (!ends.includes(i)) {
      const last = got.at(-1);
      throw new Error(`prefix ${i}/${bytes.length} parsed with a ${last ? last.oid.length : 0}-byte last oid`);
    }
    const n = ends.indexOf(i) + 1;
    assert.deepEqual(got.slice(0, n).map(e => [e.mode, e.name, e.oid]), full.slice(0, n).map(e => [e.mode, e.name, e.oid]));
    for (const e of got) assert.equal(e.oid.length, OID_HEX_CHARS);
  }
}

property('tree', 'tree prefix-closure fails on the pre-fix parser at 29/89', () => {
  const { bytes } = sampleTree();
  assert.equal(bytes.length, 89);
  let message = null;
  try { assertTree(parseTreePreFix, bytes); }
  catch (e) { message = e.message; }
  assert.equal(message, 'prefix 29/89 parsed with a 38-byte last oid');
  console.log(`  pre-fix tree property: ${message}`);
});

property('tree', 'tree prefix-closure holds, including the 29/89 cut', () => {
  const { bytes, entries } = sampleTree();
  assert.equal(bytes.length, 89);
  assert.throws(() => parseTree(bytes.subarray(0, 29)), e => e.code === 'pack_corrupt' && /short read:/.test(e.message));
  assertTree(parseTree, bytes);
  assert.deepEqual(parseTree(bytes).map(e => e.name), entries.map(e => e.name));
});

test('tree: fsck-hard malformations are rejected; a bad filemode warning still parses', () => {
  const id = oid(4);
  const raw = (text, extra = oidBytes(4)) => concat([te.encode(text), extra]);
  const bad = [
    ['empty mode', raw(' a\0')],
    ['empty name', raw('100644 \0')],
    ['truncated oid', raw('100644 a\0', oidBytes(4).subarray(0, OID_BYTES - 1))],
    ['zero-padded mode', raw('0100644 a\0')],
    ['bare zero mode', raw('0 a\0')],
    ['non-octal mode', raw('10064g a\0')],
    ['full pathname', raw('100644 a/b\0')],
    ['dot', raw('100644 .\0')],
    ['dotdot', raw('100644 ..\0')],
    ['dotgit', raw('100644 .git\0')],
    ['unsorted', concat([raw('100644 b\0'), raw('100644 a\0')])],
    ['duplicate', concat([raw('100644 a\0'), raw('100644 a\0', oidBytes(5))])],
  ];
  for (const [label, bytes] of bad) assert.throws(() => parseTree(bytes), e => e.code === 'pack_corrupt', label);
  assert.equal(parseTree(raw('100664 a\0'))[0].mode, '100664');
  assert.equal(parseTree(new Uint8Array(0)).length, 0);
  assert.equal(id.length, OID_HEX_CHARS);
});

function linesOf(c) {
  const lines = [];
  if (c.tree != null) lines.push(`tree ${c.tree}`);
  for (const p of c.parents ?? []) lines.push(`parent ${p}`);
  if (c.object != null) lines.push(`object ${c.object}`);
  if (c.type != null) lines.push(`type ${c.type}`);
  if (c.tag != null) lines.push(`tag ${c.tag}`);
  if (c.author != null) lines.push(`author ${c.author}`);
  if (c.committer != null) lines.push(`committer ${c.committer}`);
  if (c.tagger != null) lines.push(`tagger ${c.tagger}`);
  lines.push(...(c.extra ?? []));
  return lines;
}

function headerBounds(bytes) {
  const text = td.decode(bytes);
  const bounds = new Set();
  const blank = text.indexOf('\n\n');
  // The first newline of the blank line is also the last header line's terminator.
  const headEnd = blank < 0 ? text.length : blank + 1;
  for (let p = 0; p < headEnd;) {
    const n = text.indexOf('\n', p);
    if (n < 0 || n >= headEnd) break;
    bounds.add(n + 1);
    p = n + 1;
  }
  if (blank >= 0) for (let i = blank + 2; i <= text.length; i++) bounds.add(i);
  return bounds;
}

function assertHeaderObject(parse, bytes) {
  const full = parse(bytes);
  const bounds = headerBounds(bytes);
  for (let i = 1; i < bytes.length; i++) {
    let got;
    try { got = parse(bytes.subarray(0, i)); }
    catch (e) {
      assert.equal(e.code, 'pack_corrupt');
      continue;
    }
    if (!bounds.has(i)) throw new Error(`prefix ${i}/${bytes.length} parsed off an entry boundary`);
    const g = linesOf(got), f = linesOf(full);
    if (got.message === null) assert.deepEqual(g, f.slice(0, g.length));
    else {
      assert.deepEqual(g, f);
      assert.equal(typeof got.message, 'string');
      assert.ok((full.message ?? '').startsWith(got.message));
    }
  }
}

const author = ident({ name: 'Ada', email: 'ada@x', time: '1700000000' });
const commitBytes = encodeCommit({
  tree: oid(9), parents: [oid(8)], author, message: 'subject\n\nbody\n', extra: ['gpgsig -----BEGIN', ' signature'],
});
const tagBytes = encodeTag({ object: oid(9), type: 'commit', tag: 'v1', tagger: author, message: 'release\n' });

property('commit', 'commit prefix-closure: header lines are entries, the message is an opaque tail', () => {
  assertHeaderObject(parseCommit, commitBytes);
  assertHeaderObject(parseCommit, encodeCommit({ tree: oid(1), author, message: null }));
});

property('tag', 'tag prefix-closure matches the commit header framing', () => {
  assertHeaderObject(parseTag, tagBytes);
});

property('ident', 'ident prefixes are field prefixes and never throw', () => {
  const line = 'Ada Lovelace <ada@x> 1700000000 +0000';
  const full = parseIdent(line);
  for (let i = 0; i < line.length; i++) {
    const pre = line.slice(0, i);
    const got = parseIdent(pre);
    assert.ok(got);
    // No closing '>' yet: split_ident_line has not found an email, so the whole line is the name.
    if (pre.includes('<') && !pre.includes('>')) continue;
    assert.ok(full.name.startsWith(got.name), JSON.stringify(pre));
    assert.ok(full.email.startsWith(got.email));
    assert.ok(full.tz.startsWith(got.tz));
    if (got.time !== null) assert.ok(full.time.startsWith(got.time));
  }
});

test('assertFetched applies fsck to a complete object and leaves a header prefix to parseCommit', () => {
  const tree = encodeTree([{ mode: '100644', name: 'a', oid: oid(1) }]);
  assertFetched('tree', tree);
  assert.throws(() => assertFetched('tree', tree.subarray(0, tree.length - 1)), e => e.code === 'pack_corrupt');
  const good = encodeCommit({ tree: oid(1), author, message: 'm\n' });
  assertFetched('commit', good);
  assert.throws(() => assertFetched('commit', te.encode(`tree ${oid(1)}\ncommitter ${author}\n\nm\n`)), /missing author/);
  assert.throws(() => assertFetched('commit', te.encode(`tree ${oid(1)}\nauthor Ada 1700000000 +0000\ncommitter ${author}\n\nm\n`)), /missing email/);
  assert.throws(() => assertFetched('commit', te.encode(`tree ${oid(1)}\nauthor Ada <ada@x> soon +0000\ncommitter ${author}\n\nm\n`)), /bad date/);
  assert.throws(() => assertFetched('commit', te.encode(`tree short\nauthor ${author}\ncommitter ${author}\n\nm\n`)), /bad tree/);
  assertFetched('tag', tagBytes);
  assert.throws(() => assertFetched('tag', te.encode(`object ${oid(1)}\ntype commit\ntagger ${author}\n\nm\n`)), /missing name/);
  assert.equal(hashObject('blob', te.encode('x')).length, OID_HEX_CHARS);
  // a one-line header prefix still parses; it is not a complete object, so fetch is what calls assertFetched
  assert.equal(parseCommit(te.encode(`tree ${oid(1)}\n`)).tree, oid(1));
});

function stepPkt(bytes) {
  let st = pktInit();
  const r = pktStep(st, bytes);
  st = r.state;
  pktFinish(st);
  return r.frames;
}

property('pkt', 'pkt-line prefix-closure, finished so a partial frame cannot hide in the carry', () => {
  const frames = [pkt('hello'), pkt(''), FLUSH, DELIM, te.encode('0002'), pkt('z')];
  const bytes = concat(frames);
  const full = stepPkt(bytes);
  const ends = [];
  let n = 0;
  for (const f of frames) { n += f.length; ends.push(n); }
  for (let i = 1; i < bytes.length; i++) {
    let got;
    try { got = stepPkt(bytes.subarray(0, i)); }
    catch (e) {
      assert.ok(CODES.has(e.code), e.message);
      continue;
    }
    assert.ok(ends.includes(i), `prefix ${i}/${bytes.length} parsed off a frame boundary`);
    const k = ends.indexOf(i) + 1;
    assert.equal(got.length, k);
    got.forEach((g, j) => {
      assert.equal(g.kind, full[j].kind);
      if (g.kind === 'data') assert.deepEqual([...g.payload], [...full[j].payload]);
    });
  }
});

property('obj-header', 'object-header prefixes are short reads until the continuation bit clears', () => {
  for (const [type, size] of [[1, 0], [3, 15], [2, 16], [7, 2 ** 20 + 3]]) {
    const h = encodeObjHeader(type, size);
    for (let i = 1; i < h.length; i++) assert.throws(() => readObjHeader(h.subarray(0, i), 0), e => e.code === 'pack_corrupt');
    const got = readObjHeader(h, 0);
    assert.equal(got.type, type);
    assert.equal(got.size, size);
    assert.equal(got.next, h.length);
  }
});

property('ofs-delta', 'ofs-delta prefixes are short reads until the offset is complete', () => {
  // off = (1 + 1) * 128 + 2 = 258, two bytes, continuation on the first.
  const enc = Uint8Array.of(OBJ_CONTINUE | 1, 2);
  assert.throws(() => readOfsDelta(enc.subarray(0, 1), 0), e => e.code === 'pack_corrupt');
  assert.deepEqual(readOfsDelta(enc, 0), { off: (1 + 1) * (OBJ_SIZE_NEXT_MASK + 1) + 2, next: 2 });
});

property('pack', 'every strict prefix of a pack throws', async () => {
  const { pack } = await buildPack([{ type: TYPE.BLOB, data: te.encode('hello') }]);
  parsePack(pack);
  for (let i = 1; i < pack.length; i++) assert.throws(() => parsePack(pack.subarray(0, i)), e => e.code === 'pack_corrupt');
});

property('delta', 'every strict prefix of a delta throws', () => {
  const base = te.encode('hello world, hello');
  const { delta } = spliceDelta({ baseLen: base.length, off: 6, oldLen: 5, insert: te.encode('there') });
  assert.ok(delta.length >= 4);
  applyDelta(base, delta);
  for (let i = 1; i < delta.length; i++) assert.throws(() => applyDelta(base, delta.subarray(0, i)), e => e.code === 'pack_corrupt');
});

property('sideband', 'a sideband frame is a channel byte plus an opaque body prefix', () => {
  const body = te.encode('pack-bytes');
  const payload = concat([Uint8Array.of(1), body]);
  assert.throws(() => parseSideband(payload.subarray(0, 0)), e => e.code === 'protocol');
  for (let i = 1; i < payload.length; i++) {
    const got = parseSideband(payload.subarray(0, i));
    assert.equal(got.band, 1);
    assert.deepEqual([...got.body], [...body.subarray(0, i - 1)]);
  }
});

property('sp-header', 'a strict prefix of a single-object pack does not finish', async () => {
  const { pack } = await buildPack([{ type: TYPE.BLOB, data: te.encode('xyz') }]);
  let st = spInit();
  for (const chunk of [pack]) { const r = spStep(st, chunk); st = r.state; }
  spFinish(st);
  for (let i = 0; i < pack.length; i++) {
    let s = spInit();
    try { s = spStep(s, pack.subarray(0, i)).state; }
    catch (e) { assert.equal(e.code, 'pack_corrupt'); continue; }
    assert.throws(() => spFinish(s), e => e.code === 'pack_corrupt');
  }
});

property('inflate', 'every strict prefix of a zlib stream throws', () => {
  const z = zlib.deflateSync(Buffer.from('hello prefix'));
  inflate(z);
  for (let i = 1; i < z.length; i++) assert.throws(() => inflate(z.subarray(0, i)), e => e.code === 'pack_corrupt');
});

property('v2', 'a prefix of a v2 fetch response is a prefix of its sections and pack bytes', () => {
  const frames = [
    { kind: 'data', payload: te.encode('acknowledgments\n') },
    { kind: 'data', payload: te.encode('ACK abc common\n') },
    { kind: 'delim' },
    { kind: 'data', payload: te.encode('packfile\n') },
    { kind: 'data', payload: concat([Uint8Array.of(1), te.encode('PACK')]) },
    { kind: 'data', payload: concat([Uint8Array.of(2), te.encode('counting')]) },
    { kind: 'flush' },
  ];
  const run = list => {
    let st = v2Init();
    const packs = [];
    for (const f of list) {
      const r = v2Step(st, f);
      st = r.state;
      if (r.pack) packs.push(r.pack);
    }
    return { sections: st.sections, pack: packs.length ? concat(packs) : new Uint8Array(0), done: st.done };
  };
  const full = run(frames);
  for (let i = 0; i < frames.length; i++) {
    const got = run(frames.slice(0, i));
    assert.deepEqual(got.sections, full.sections.slice(0, got.sections.length));
    assert.ok(full.pack.length >= got.pack.length);
    assert.deepEqual([...got.pack], [...full.pack.subarray(0, got.pack.length)]);
  }
});

property('ls-ref', 'an ls-refs line prefix is a typed error or a field prefix', () => {
  const line = `${oid(7)} refs/heads/main symref-target:refs/heads/main peeled:${oid(6)}`;
  const full = parseLsRefLine(line);
  for (let i = 1; i < line.length; i++) {
    let got;
    try { got = parseLsRefLine(line.slice(0, i)); }
    catch (e) { assert.ok(CODES.has(e.code), e.message); continue; }
    assert.equal(got.oid, full.oid);
    assert.ok(full.name.startsWith(got.name));
  }
});

property('report', 'a prefix of report-status lines is a prefix of the ref statuses', () => {
  const lines = ['unpack ok', 'ok refs/heads/main', 'ng refs/heads/other hook declined', 'option old-oid abcdef'];
  const full = parseReportStatus(lines);
  for (let i = 0; i <= lines.length; i++) {
    const got = parseReportStatus(lines.slice(0, i));
    if (got.unpack !== null) assert.ok(full.unpack.startsWith(got.unpack));
    assert.ok(got.refs.length <= full.refs.length);
    got.refs.forEach((r, j) => { assert.equal(r.ref, full.refs[j].ref); assert.equal(r.ok, full.refs[j].ok); });
  }
  const partial = parseReportStatus(['unpack o']);
  assert.equal(partial.unpack, 'o');
});

property('kex', 'a KEXINIT prefix throws ssh until the reserved tail', () => {
  const cookie = new Uint8Array(16);
  for (let i = 0; i < cookie.length; i++) cookie[i] = i + 1;
  const msg = kexInit(cookie);
  const full = parseKexInit(msg);
  // parseKexInit stops at first_kex_packet_follows and does not read the reserved u32, so the last four bytes are
  // not required. Every shorter cut throws; every cut that reaches that boolean parses to the same message.
  let opened = null;
  for (let i = 1; i < msg.length; i++) {
    let got;
    try { got = parseKexInit(msg.subarray(0, i)); }
    catch (e) {
      assert.equal(e.code, 'ssh');
      assert.equal(opened, null, `threw again after succeeding at ${opened}`);
      continue;
    }
    if (opened === null) opened = i;
    assert.deepEqual(got, full);
  }
  assert.ok(opened !== null && opened < msg.length);
});

property('ssh-url', 'an ssh url prefix throws or returns a prefix of the host and path', () => {
  for (const url of ['ssh://git@github.com:22/owner/repo.git', 'git@github.com:owner/repo.git']) {
    const full = parseSshUrl(url);
    for (let i = 1; i < url.length; i++) {
      const pre = url.slice(0, i);
      let got;
      try { got = parseSshUrl(pre); }
      catch (e) { assert.equal(e.code, 'bad_request'); continue; }
      // `ssh:/...` (the second slash not yet present) matches the scp grammar instead. That alias is url syntax,
      // not a git object; once `://` is in hand the host and path stay prefixes.
      if (url.startsWith('ssh://') && !pre.includes('://')) continue;
      assert.ok(full.host.startsWith(got.host), `${pre} host ${got.host}`);
      assert.ok(full.user.startsWith(got.user));
      const gotPath = got.path.replace(/^\//, '');
      const fullPath = full.path.replace(/^\//, '');
      assert.ok(fullPath.startsWith(gotPath), `${pre} → ${got.path}`);
    }
  }
});

property('attr-line', 'a gitattributes line prefix parses as a pattern prefix or not at all', () => {
  const line = '*.txt text ident';
  const full = parseLine(line, { macrosOk: false });
  for (let i = 1; i < line.length; i++) {
    const got = parseLine(line.slice(0, i), { macrosOk: false });
    if (!got?.pat) continue;
    assert.ok(full.pat.pattern.startsWith(got.pat.pattern));
  }
});

property('attr-file', 'a gitattributes file prefix is a prefix of its patterns', () => {
  const text = '*.txt text\n*.c diff=cpp\n';
  const pats = rows => rows.map(l => l.pat?.pattern).filter(Boolean);
  const full = pats(parseFile(text));
  for (let i = 1; i < text.length; i++) {
    const got = pats(parseFile(text.slice(0, i)));
    assert.ok(got.length <= full.length);
    got.forEach((p, j) => {
      if (j < got.length - 1 || text[i - 1] === '\n') assert.equal(p, full[j]);
      else assert.ok(full[j].startsWith(p));
    });
  }
});

test('take() throws a typed short read and does not clamp', () => {
  const buf = new Uint8Array([1, 2, 3, 4]);
  assert.throws(() => take(buf, 2, 3), e => e.code === 'pack_corrupt' && e.message.startsWith('short read:'));
  assert.throws(() => take(buf, 3, 2, 'protocol'), e => e.code === 'protocol' && e.message.startsWith('short read:'));
  assert.deepEqual([...take(buf, 1, 2)], [2, 3]);
  assert.equal(take(buf, 4, 0).length, 0);
});

const DECODER_EXPORT = /^(parse[A-Z]\w*|readObjHeader|readOfsDelta|applyDelta|inflate|pktStep|pktFinish|spStep|v2Step)$/;

test('every exported decoder has a prefix-closure property', () => {
  const missing = [];
  const annotated = [];
  for (const file of readdirSync('src').filter(f => f.endsWith('.js'))) {
    const text = readFileSync(join('src', file), 'utf8');
    const anns = [...text.matchAll(/@decoder\s+(\w+)\s+prefix=([\w-]+)/g)].map(m => ({ name: m[1], prefix: m[2] }));
    for (const a of anns) annotated.push({ file, ...a });
    for (const m of text.matchAll(/export (?:async )?function (\w+)/g)) {
      if (DECODER_EXPORT.test(m[1]) && !anns.some(a => a.name === m[1])) missing.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], `decoder exports without @decoder:\n${missing.join('\n')}`);
  const uncovered = annotated.filter(a => !covered.has(a.prefix));
  assert.deepEqual(uncovered.map(a => `${a.file} ${a.name} prefix=${a.prefix}`), []);
  console.log(`  decoders: ${annotated.map(a => a.name).sort().join(', ')}`);
});
