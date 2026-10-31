// Branch and message assertions for the mutation gate. Prefix and round-trip tests kill the happy path;
// these kill a mutant that deletes one check, flips one comparison, or empties one error string.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { take, indexOfBytes, bytesOf, te, td, concat, decodeBytes, encodeBytes, decodeChunk } from '../src/bytes.js';
import {
  parseTree, parseCommit, parseTag, parseIdent, assertFetched, encodeTree, encodeCommit, encodeTag, TYPE, hashObject, ident,
} from '../src/objects.js';
import { pkt, pktInit, pktStep, pktFinish, FLUSH, DELIM } from '../src/pktline.js';
import {
  parsePack, applyDelta, makeDelta, readObjHeader, readOfsDelta, readUint32BE, packParseOpts, resolvePack,
} from '../src/packresolve.js';
import { encodeObjHeader, encodeVarint, buildPack, zlibDeflate, copyOp } from '../src/pack.js';
import { inflate, huffBuild, adler32 } from '../src/inflate.js';
import { v2Init, v2Step, parseSideband, spInit, spStep, spFinish, fetchBody } from '../src/fetch.js';
import { parseLsRefLine, lsRefs } from '../src/lsrefs.js';
import { parseReportStatus, checkReport, push, ZERO_OID } from '../src/push.js';
import { parseLine, parseFile, UNSET } from '../src/attributes.js';
import { kexInit, parseKexInit } from '../src/ssh.js';
import { parseSshUrl, createSshTransport } from '../src/sshgit.js';
import { withGpgsig } from '../src/sign.js';
import { withLimits, DEFAULT_LIMITS, requireLimit, finiteLimit } from '../src/limits.js';
import { validateIdent, isValidatedIdent } from '../src/validate.js';
import { createTransport } from '../src/http.js';
import { negotiate } from '../src/negotiate.js';
import {
  OID_BYTES, OID_HEX_CHARS, PACK_SIGNATURE, PACK_HEADER_BYTES, PACK_VERSION,
  DELTA_COPY, DELTA_COPY_OFF1, DELTA_COPY_OFF2, DELTA_COPY_OFF3, DELTA_COPY_OFF4,
  DELTA_COPY_LEN1, DELTA_COPY_LEN2, DELTA_COPY_LEN3, DELTA_SIZE_MIN, SIDEBAND_PACK, SIDEBAND_PROGRESS,
} from '../src/format.js';

const oid = n => (n.toString(16).padStart(2, '0').repeat(OID_BYTES));
const oidBytes = n => Uint8Array.from({ length: OID_BYTES }, () => n);
const throws = (fn, code, message) => assert.throws(fn, e => {
  assert.equal(e.code, code, e.message);
  assert.equal(e.message, message);
  return true;
});
const data = (...parts) => concat(parts.map(p => typeof p === 'string' ? te.encode(p) : p));

test('take, indexOfBytes, and bytesOf reject every out-of-range shape', () => {
  const buf = Uint8Array.of(1, 2, 3, 4);
  assert.deepEqual([...take(buf, 1, 2)], [2, 3]);
  assert.equal(take(buf, 4, 0).length, 0);
  assert.equal(take(buf, 0, 1, 'protocol')[0], 1);
  for (const [off, n] of [[1.5, 1], [0, 1.5], [NaN, 1], [0, NaN], [-1, 1], [0, -1], [3, 2], [5, 0]]) {
    throws(() => take(buf, off, n), 'pack_corrupt', `short read: need ${n} bytes at ${off}, have 4`);
  }
  throws(() => take(undefined, 0, 1), 'pack_corrupt', 'short read: need 1 bytes at 0, have 0');
  throws(() => take(null, 0, 1, 'protocol'), 'protocol', 'short read: need 1 bytes at 0, have 0');

  const hay = Uint8Array.of(1, 2, 1, 2, 3);
  assert.equal(indexOfBytes(hay, new Uint8Array(), 3), 3);
  assert.equal(indexOfBytes(hay, Uint8Array.of(9)), -1);
  assert.equal(indexOfBytes(hay, Uint8Array.of(1)), 0);
  assert.equal(indexOfBytes(hay, Uint8Array.of(2, 3)), 3);
  assert.equal(indexOfBytes(hay, Uint8Array.of(1, 2, 3), 1), 2);
  assert.equal(indexOfBytes(hay, Uint8Array.of(1, 9)), -1);

  const text = te.encode('ab');
  assert.deepEqual(bytesOf('ab'), text);
  assert.equal(bytesOf(text), text);
  assert.equal(bytesOf('').length, 0);
});

test('parseTree error strings and the boundaries next to them', () => {
  const id = oidBytes(4);
  const raw = (text, extra = id) => data(text, extra);
  const bad = [
    ['100644a\0', 'tree: malformed entry'],
    [' a\0', 'tree: empty mode'],
    ['100644 \0', 'tree: empty name'],
    ['8 a\0', 'tree: malformed mode'],
    ['19 a\0', 'tree: malformed mode'],
    ['0 a\0', 'tree: zero-padded mode'],
    ['0100644 a\0', 'tree: zero-padded mode'],
    ['100644 /x\0', 'tree: full pathname'],
    ['100644 a/b\0', 'tree: full pathname'],
    ['100644 .\0', 'tree: bad name'],
    ['100644 ..\0', 'tree: bad name'],
    ['100644 .git\0', 'tree: bad name'],
    ['100644 .GIT\0', 'tree: bad name'],
  ];
  for (const [text, message] of bad) throws(() => parseTree(raw(text)), 'pack_corrupt', message);
  throws(() => parseTree(raw('100644 a\0', id.subarray(0, OID_BYTES - 1))), 'pack_corrupt', `short read: need ${OID_BYTES} bytes at ${'100644 a\0'.length}, have ${'100644 a\0'.length + OID_BYTES - 1}`);
  throws(() => parseTree(data(raw('100644 b\0'), raw('100644 a\0'))), 'pack_corrupt', 'tree: not strictly sorted');
  throws(() => parseTree(data(raw('100644 a\0'), raw('100644 a\0', oidBytes(5)))), 'pack_corrupt', 'tree: not strictly sorted');
  assert.equal(parseTree(new Uint8Array(0)).length, 0);
  assert.equal(parseTree(raw('100664 a\0'))[0].mode, '100664');
  // a file and a directory of one name sort apart ('d' < 'd/'): the order check passes it. encodeTree refuses to write
  // it (git fsck duplicateEntries), so the bytes are built by hand.
  const tree = data(raw('100644 d\0', oidBytes(2)), raw('40000 d\0', oidBytes(1)));
  assert.deepEqual(parseTree(tree).map(e => e.name), ['d', 'd']);
  // a leading U+FEFF is a byte of the name to git; the default TextDecoder would drop it and `README` would be found (#43)
  assert.equal(parseTree(raw('100644 \ufeffREADME\0'))[0].name, '\ufeffREADME');
  assert.equal(td.decode(te.encode('\ufeffX')), '\ufeffX');
  // and a mode is not a name: `\ufeff100644` is malformed, as git's ls-tree says
  throws(() => parseTree(raw('\ufeff100644 a\0')), 'pack_corrupt', 'tree: malformed mode');
  // ill-formed UTF-8 names are escaped byte by byte, sort and re-encode as their bytes
  const latin = data(Uint8Array.from([...te.encode('100644 caf'), 0xe9, 0]), oidBytes(1), Uint8Array.from([...te.encode('100644 caf'), 0xe9, 0x41, 0]), oidBytes(2));
  assert.deepEqual(parseTree(latin).map(e => e.name), ['caf\udce9', 'caf\udce9A']);
  assert.deepEqual(encodeTree(parseTree(latin)), latin);
  // a directory sorts as name + '/' on the raw bytes: `a\xff` (file) after `a/`-keyed dir `a`
  assert.deepEqual(parseTree(data(raw('40000 a\0', oidBytes(1)), Uint8Array.from([...te.encode('100644 a'), 0xff, 0]), oidBytes(2))).map(e => e.name), ['a', 'a\udcff']);
  throws(() => parseTree(data(Uint8Array.from([...te.encode('100644 a'), 0xff, 0]), oidBytes(2), raw('40000 a\0', oidBytes(1)))), 'pack_corrupt', 'tree: not strictly sorted');
});

test('decodeBytes / encodeBytes: a bijection on bytes; decodeChunk holds a cut sequence (#43)', () => {
  const cases = [[0xef, 0xbb, 0xbf, 0x52], [0x63, 0xe9], [0xc0, 0xae], [0xe0, 0x80, 0xae], [0xed, 0xa0, 0x80], [0xed, 0x9f, 0xbf], [0xf0, 0x8f, 0xbf, 0xbf], [0xf0, 0x90, 0x80, 0x80], [0xf4, 0x8f, 0xbf, 0xbf], [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80], [0xc1, 0xbf], [0xc2, 0x80], [0xdf, 0xbf], [0xe2, 0x82], [0x80], [0xff], [0x41, 0, 0x0d], [0xc3, 0xa9, 0xff]];
  const want = ['\ufeffR', 'c\udce9', '\udcc0\udcae', '\udce0\udc80\udcae', '\udced\udca0\udc80', '\ud7ff', '\udcf0\udc8f\udcbf\udcbf', '\u{10000}', '\u{10ffff}', '\udcf4\udc90\udc80\udc80', '\udcf5\udc80', '\udcc1\udcbf', '\u0080', '\u07ff', '\udce2\udc82', '\udc80', '\udcff', 'A\0\r', '\u00e9\udcff'];
  cases.forEach((c, i) => {
    const b = Uint8Array.from(c);
    assert.equal(decodeBytes(b), want[i], c.join(' '));
    assert.deepEqual(encodeBytes(want[i]), b, c.join(' '));
  });
  for (const [s, msg] of [['\ud800', 'x: lone surrogate U+D800 is no byte sequence'], ['a\udfff', 'x: lone surrogate U+DFFF is no byte sequence'], ['\udc7f', 'x: lone surrogate U+DC7F is no byte sequence'], ['\udcc3\udca9', 'x: escaped bytes spell well-formed UTF-8; pass the characters']]) throws(() => encodeBytes(s, 'x'), 'bad_request', msg);
  throws(() => encodeBytes(1, 'x'), 'bad_request', 'x must be a string');
  assert.deepEqual(encodeBytes('\u{1f680}\udcff'), Uint8Array.from([0xf0, 0x9f, 0x9a, 0x80, 0xff]));
  // a well-formed string takes the TextEncoder path; a lone escape at either end is still found
  assert.deepEqual(encodeBytes('\udcffa'), Uint8Array.from([0xff, 0x61]));
  let d = decodeChunk(new Uint8Array(0), Uint8Array.from([0x61, 0xf0, 0x9f]));
  assert.deepEqual([d.text, [...d.carry]], ['a', [0xf0, 0x9f]]);
  d = decodeChunk(d.carry, Uint8Array.from([0x9a, 0x80, 0xe2]));
  assert.deepEqual([d.text, [...d.carry]], ['\u{1f680}', [0xe2]]);
  d = decodeChunk(d.carry, Uint8Array.from([0x82, 0xac]));
  assert.deepEqual([d.text, [...d.carry]], ['\u20ac', []]);
  // a complete sequence at the end is not held; nor a stray continuation byte
  assert.deepEqual([...decodeChunk(new Uint8Array(0), Uint8Array.from([0xc3, 0xa9])).carry], []);
  assert.equal(decodeChunk(new Uint8Array(0), Uint8Array.from([0x80])).text, '\ufffd');
  assert.deepEqual([...decodeChunk(new Uint8Array(0), Uint8Array.from([0xe2, 0x82, 0x80, 0x80])).carry], []);
});

test('commit and tag headers, idents, and assertFetched', () => {
  const author = 'Ada <ada@ex> 1700000000 +0000';
  const tree = oid(1);
  throws(() => parseCommit(te.encode('tree')), 'pack_corrupt', 'commit: truncated header line');
  throws(() => parseCommit(te.encode('nospace\n')), 'pack_corrupt', 'commit: truncated header line');
  throws(() => parseCommit(te.encode(`tree ${tree}\n parent-sig\n\n`)), 'pack_corrupt', 'commit: bad header order');
  const cont = parseCommit(te.encode(`tree ${tree}\nauthor ${author}\ncommitter ${author}\n parent-sig\n\n`));
  assert.deepEqual(cont.extra, [' parent-sig']);
  assert.equal(cont.encoding, null);
  assert.equal(cont.message, '');
  const blankFirst = parseCommit(te.encode('\n\nbody'));
  assert.deepEqual(blankFirst.head ?? blankFirst.extra, []);
  assert.equal(blankFirst.message, 'body');
  assert.equal(parseCommit(te.encode(`tree ${tree}\n`)).message, null);

  const commit = encodeCommit({ tree, parents: [oid(2)], author, message: 'hi\n' });
  assert.equal(parseCommit(commit).tree, tree);
  assert.deepEqual(parseCommit(commit).parents, [oid(2)]);
  throws(() => assertFetched('commit', te.encode(`author ${author}\ncommitter ${author}\n\n`)), 'pack_corrupt', 'commit: bad header order');
  throws(() => assertFetched('commit', te.encode('\n\n')), 'pack_corrupt', 'commit: missing or bad tree');
  throws(() => assertFetched('commit', te.encode(`tree zz\nauthor ${author}\ncommitter ${author}\n\n`)), 'pack_corrupt', 'commit: missing or bad tree');
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\nparent zz\nauthor ${author}\ncommitter ${author}\n\n`)), 'pack_corrupt', 'commit: bad parent');
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\ncommitter ${author}\n\n`)), 'pack_corrupt', 'commit: bad header order');
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\n\n`)), 'pack_corrupt', 'commit: missing author');
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\nauthor ${author}\n\n`)), 'pack_corrupt', 'commit: missing committer');
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\nauthor Ada\ncommitter ${author}\n\n`)), 'pack_corrupt', 'author: missing email');
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\nauthor Ada <ada@ex>\ncommitter ${author}\n\n`)), 'pack_corrupt', 'author: bad date');
  assertFetched('commit', commit);
  assert.equal(assertFetched('blob', te.encode('x')), undefined);
  assert.equal(assertFetched('ofs_delta', te.encode('x')), undefined);
  assert.equal(assertFetched('ref_delta', te.encode('x')), undefined);
  throws(() => assertFetched('submodule', te.encode('x')), 'pack_corrupt', 'object: bad type submodule');
  throws(() => assertFetched('tree', data(' a\0', oidBytes(1))), 'pack_corrupt', 'tree: empty mode');

  const tagger = author;
  const tag = encodeTag({ object: oid(3), type: 'commit', tag: 'v1', tagger, message: 'rel\n' });
  assert.equal(parseTag(tag).tag, 'v1');
  throws(() => parseTag(te.encode(`object ${oid(3)}\nobject ${oid(4)}\ntype commit\ntag v1\ntagger ${tagger}\n\n`)), 'pack_corrupt', 'tag: duplicate object');
  throws(() => assertFetched('tag', te.encode(`type commit\ntag v1\ntagger ${tagger}\n\n`)), 'pack_corrupt', 'tag: bad header order');
  throws(() => assertFetched('tag', te.encode(`object ${oid(3)}\ntag v1\ntagger ${tagger}\n\n`)), 'pack_corrupt', 'tag: bad header order');
  throws(() => assertFetched('tag', te.encode(`object ${oid(3)}\ntype commit\ntagger ${tagger}\n\n`)), 'pack_corrupt', 'tag: bad header order');
  throws(() => assertFetched('tag', te.encode('\n\n')), 'pack_corrupt', 'tag: missing or bad object');
  throws(() => assertFetched('tag', te.encode(`object ${oid(3)}\n\n`)), 'pack_corrupt', 'tag: missing type');
  throws(() => assertFetched('tag', te.encode(`object ${oid(3)}\ntype commit\n\n`)), 'pack_corrupt', 'tag: missing name');
  throws(() => assertFetched('tag', te.encode(`object ${oid(3)}\ntype commit\ntag v1\n\n`)), 'pack_corrupt', 'tag: missing tagger');
  throws(() => assertFetched('tag', te.encode(`object ${oid(3)}\ntype commit\ntag v1\ntagger Ada\n\n`)), 'pack_corrupt', 'tagger: missing email');
  assertFetched('tag', tag);
  assert.equal(parseTag(te.encode(`object ${oid(3)}\ntype commit\ntag \ntagger ${tagger}\n\n`)).tag, '');

  assert.equal(parseIdent(1), null);
  assert.deepEqual(parseIdent('  bare name  '), { name: 'bare name', email: '', time: null, tz: '' });
  assert.deepEqual(parseIdent('foo >bar'), { name: 'foo >bar', email: '', time: null, tz: '' });
  assert.deepEqual(parseIdent('<ada@ex> 1700000000 +0000'), { name: '', email: 'ada@ex', time: '1700000000', tz: '+0000' });
  assert.deepEqual(parseIdent(' Ada <ada@ex> 1700000000 +0000'), { name: ' Ada', email: 'ada@ex', time: '1700000000', tz: '+0000' });
  assert.deepEqual(parseIdent('Ada  <ada@ex> nope +0100'), { name: 'Ada', email: 'ada@ex', time: null, tz: '+0100' });
});

test('duplicate and out-of-order commit and tag headers are rejected', () => {
  const author = 'Ada <ada@ex> 1700000000 +0000';
  const other = 'Bea <bea@ex> 1700000001 +0000';
  const tree = oid(1);
  const tree2 = oid(2);
  const committer = author;
  const body = (lines) => te.encode(`${lines.join('\n')}\n\nmsg\n`);
  const ok = parseCommit(body([`tree ${tree}`, `parent ${oid(3)}`, `parent ${oid(4)}`, `author ${author}`, `committer ${committer}`, 'encoding UTF-8', 'gpgsig -----BEGIN', ' signature', 'mergetag object x']));
  assert.equal(ok.tree, tree);
  assert.deepEqual(ok.parents, [oid(3), oid(4)]);
  assert.equal(ok.author, author);
  assert.equal(ok.committer, committer);
  assert.equal(ok.encoding, 'UTF-8');
  assert.deepEqual(ok.extra, ['gpgsig -----BEGIN', ' signature', 'mergetag object x']);
  const again = parseCommit(encodeCommit(ok));
  assert.equal(again.encoding, 'UTF-8');
  assert.deepEqual(again.extra, ok.extra);
  const bare = encodeCommit({ tree, parents: [oid(2)], author, message: 'hi\n' });
  assert.equal(td.decode(bare).includes('\nencoding '), false);
  assert.equal(parseCommit(bare).encoding, null);
  const enc = encodeCommit({ tree, author, encoding: 'ISO-8859-1', message: 'hi\n' });
  assert.equal(parseCommit(enc).encoding, 'ISO-8859-1');
  assert.deepEqual([...encodeCommit(parseCommit(enc))], [...enc]);
  const signed = withGpgsig(enc, '-----BEGIN SSH SIGNATURE-----\nAAA\n-----END SSH SIGNATURE-----\n');
  const parsedSig = parseCommit(signed);
  assert.equal(parsedSig.encoding, 'ISO-8859-1');
  assert.equal(parsedSig.extra[0].startsWith('gpgsig '), true);
  assert.equal(parseCommit(body([`tree ${tree}`, `author ${author}`, `committer ${committer}`, 'gpgsig x'])).extra[0], 'gpgsig x');
  const plain = encodeCommit({ tree, author, message: 'hi\n', extra: ['x-custom v'] });
  const signedPlain = td.decode(withGpgsig(plain, 'SIG\n'));
  const plainHeaders = signedPlain.split('\n\n')[0].split('\n');
  const ci = plainHeaders.findIndex(l => l.startsWith('committer '));
  assert.equal(plainHeaders[ci + 1].startsWith('gpgsig '), true);
  assert.equal(plainHeaders[ci + 2], 'x-custom v');
  assert.equal(parseCommit(withGpgsig(bare, 'SIG\n')).extra[0].startsWith('gpgsig '), true);
  const dup = (label, lines) => throws(() => parseCommit(body(lines)), 'pack_corrupt', label);
  const bad = (lines) => throws(() => parseCommit(body(lines)), 'pack_corrupt', 'commit: bad header order');
  dup('commit: duplicate tree', [`tree ${tree}`, `tree ${tree2}`, `author ${author}`, `committer ${committer}`]);
  dup('commit: duplicate tree', [`tree ${tree}`, `author ${author}`, `committer ${committer}`, `tree ${tree2}`]);
  dup('commit: duplicate author', [`tree ${tree}`, `author ${author}`, `author ${other}`, `committer ${committer}`]);
  dup('commit: duplicate author', [`tree ${tree}`, `author ${author}`, `committer ${committer}`, `author ${other}`]);
  dup('commit: duplicate author', [`tree ${tree}`, `author ${author}`, `committer ${committer}`, 'encoding UTF-8', `author ${other}`]);
  dup('commit: duplicate author', [`tree ${tree}`, `author ${author}`, `committer ${committer}`, 'gpgsig x', `author ${other}`]);
  dup('commit: duplicate committer', [`tree ${tree}`, `author ${author}`, `committer ${committer}`, `committer ${other}`]);
  dup('commit: duplicate committer', [`tree ${tree}`, `author ${author}`, `committer ${committer}`, 'encoding UTF-8', `committer ${other}`]);
  dup('commit: duplicate committer', [`tree ${tree}`, `author ${author}`, `committer ${committer}`, 'gpgsig x', `committer ${other}`]);
  dup('commit: duplicate encoding', [`tree ${tree}`, `author ${author}`, `committer ${committer}`, 'encoding UTF-8', 'encoding ISO-8859-1']);
  dup('commit: duplicate encoding', [`tree ${tree}`, `author ${author}`, `committer ${committer}`, 'encoding UTF-8', 'gpgsig x', 'encoding ISO-8859-1']);
  bad([`parent ${oid(3)}`, `tree ${tree}`, `author ${author}`, `committer ${committer}`]);
  bad([`author ${author}`, `tree ${tree}`, `committer ${committer}`]);
  bad([`tree ${tree}`, `committer ${committer}`]);
  bad([`tree ${tree}`, `author ${author}`, 'encoding UTF-8', `committer ${committer}`]);
  bad([`tree ${tree}`, 'encoding UTF-8', `author ${author}`, `committer ${committer}`]);
  bad([`tree ${tree}`, `author ${author}`, `committer ${committer}`, `parent ${oid(3)}`]);
  bad([`tree ${tree}`, `author ${author}`, `parent ${oid(3)}`, `committer ${committer}`]);
  bad([`tree ${tree}`, ' parent-sig', `author ${author}`, `committer ${committer}`]);
  bad([`tree ${tree}`, 'x-custom v', `author ${author}`, `committer ${committer}`]);
  const twoParents = parseCommit(body([`tree ${tree}`, `parent ${oid(3)}`, `parent ${oid(3)}`, `author ${author}`, `committer ${committer}`]));
  assert.deepEqual(twoParents.parents, [oid(3), oid(3)]);
  const tags = parseTag(body([`object ${oid(5)}`, 'type commit', 'tag v1', `tagger ${author}`, 'gpgsig abc']));
  assert.equal(tags.object, oid(5));
  assert.equal(tags.type, 'commit');
  assert.equal(tags.tag, 'v1');
  assert.equal(tags.tagger, author);
  assert.deepEqual(tags.extra, ['gpgsig abc']);
  assert.deepEqual(parseTag(body([`object ${oid(5)}`, 'type commit', 'tag v1', `tagger ${author}`, 'gpgsig abc', ' more'])).extra, ['gpgsig abc', ' more']);
  const tagDup = (label, lines) => throws(() => parseTag(body(lines)), 'pack_corrupt', label);
  const tagBad = (lines) => throws(() => parseTag(body(lines)), 'pack_corrupt', 'tag: bad header order');
  tagDup('tag: duplicate object', [`object ${oid(5)}`, `object ${oid(6)}`, 'type commit', 'tag v1', `tagger ${author}`]);
  tagDup('tag: duplicate object', [`object ${oid(5)}`, 'type commit', 'tag v1', `tagger ${author}`, `object ${oid(6)}`]);
  tagDup('tag: duplicate type', [`object ${oid(5)}`, 'type commit', 'type blob', 'tag v1', `tagger ${author}`]);
  tagDup('tag: duplicate type', [`object ${oid(5)}`, 'type commit', 'tag v1', 'type blob']);
  tagDup('tag: duplicate type', [`object ${oid(5)}`, 'type commit', 'tag v1', `tagger ${author}`, 'type blob']);
  tagDup('tag: duplicate type', [`object ${oid(5)}`, 'type commit', 'tag v1', `tagger ${author}`, 'gpgsig x', 'type blob']);
  tagDup('tag: duplicate tag', [`object ${oid(5)}`, 'type commit', 'tag v1', 'tag v2', `tagger ${author}`]);
  tagDup('tag: duplicate tag', [`object ${oid(5)}`, 'type commit', 'tag v1', `tagger ${author}`, 'tag v2']);
  tagDup('tag: duplicate tag', [`object ${oid(5)}`, 'type commit', 'tag v1', `tagger ${author}`, 'gpgsig x', 'tag v2']);
  tagDup('tag: duplicate tagger', [`object ${oid(5)}`, 'type commit', 'tag v1', `tagger ${author}`, `tagger ${other}`]);
  tagDup('tag: duplicate tagger', [`object ${oid(5)}`, 'type commit', 'tag v1', `tagger ${author}`, 'gpgsig x', `tagger ${other}`]);
  tagBad(['type commit', `object ${oid(5)}`, 'tag v1', `tagger ${author}`]);
  tagBad(['tag v1', `object ${oid(5)}`, 'type commit', `tagger ${author}`]);
  tagBad([`object ${oid(5)}`, 'type commit', `tagger ${author}`]);
  tagBad([`object ${oid(5)}`, 'type commit', 'tag v1', 'foo bar', `tagger ${author}`]);
  tagBad(['gpgsig x', `object ${oid(5)}`, 'type commit', 'tag v1', `tagger ${author}`]);
  assert.equal(parseCommit(te.encode(`tree ${tree}\nparent ${oid(3)}\n`)).message, null);
  assert.equal(parseCommit(te.encode(`tree ${tree}\nauthor ${author}\n`)).author, author);
  assert.equal(parseTag(te.encode(`object ${oid(5)}\ntype commit\ntag \n`)).tag, '');
});

test('fsck badTimezone: a sign, four digits, then the end of the ident line', () => {
  const tree = oid(1);
  const who = tz => `A <a@b.c> 1700000000 ${tz}`;
  const commit = (author, committer = who('+0000')) => te.encode(`tree ${tree}\nauthor ${author}\ncommitter ${committer}\n\nm\n`);
  const tag = tagger => te.encode(`object ${tree}\ntype commit\ntag v1\ntagger ${tagger}\n\n`);
  for (const tz of ['+0000', '-0000', '+0530', '-1200', '+1400', '+9999', '+1560', '+2400', '+0059']) {
    assertFetched('commit', commit(who(tz)));
    assertFetched('tag', tag(who(tz)));
  }
  // fsck skips spaces and tabs before the timestamp, and a timestamp of 0 must not be confused with a zero in the zone
  assertFetched('commit', commit('A <a@b.c>  1700000000 +0000'));
  assertFetched('commit', commit('A <a@b.c> \t1700000000 +0530'));
  assertFetched('commit', commit('A <a@b.c> 0 -1200'));
  assertFetched('commit', commit('A <a@b.c> 1700000009 +0000'));
  const bad = ['+000', '+00000', '+00', '+', '0000', '+0a00', '+00:00', 'Z', '+0000x', '+0000 ', '+0000\t', ' +0000', '+00 00', '++000', '+-000', '+0000 extra'];
  for (const tz of bad) {
    throws(() => assertFetched('commit', commit(who(tz))), 'pack_corrupt', 'author: bad time zone');
    throws(() => assertFetched('commit', commit(who('+0000'), who(tz))), 'pack_corrupt', 'committer: bad time zone');
    throws(() => assertFetched('tag', tag(who(tz))), 'pack_corrupt', 'tagger: bad time zone');
  }
  throws(() => assertFetched('commit', commit('A <a@b.c> 1700000000')), 'pack_corrupt', 'author: bad date');
  throws(() => assertFetched('commit', commit('A <a@b.c>1700000000 +0000')), 'pack_corrupt', 'author: bad date');
  throws(() => assertFetched('commit', commit('A <a@b.c> 12:34 +0000')), 'pack_corrupt', 'author: bad date');
  throws(() => assertFetched('commit', commit('Ada <ada@ex> soon +0000')), 'pack_corrupt', 'author: bad date');
  // a space is required immediately before '<'. commit#23000087 replaced it with '!'; commit#19000059 with 0x9E.
  throws(() => assertFetched('commit', commit('A<a@b.c> 1700000000 +0000')), 'pack_corrupt', 'author: missing space before email');
  throws(() => assertFetched('commit', commit('A!<a@b.c> 1700000000 +0000')), 'pack_corrupt', 'author: missing space before email');
  throws(() => assertFetched('commit', commit('<a@b.c> 1700000000 +0000')), 'pack_corrupt', 'author: missing space before email');
  throws(() => assertFetched('commit', commit('A\t<a@b.c> 1700000000 +0000')), 'pack_corrupt', 'author: missing space before email');
  assertFetched('commit', commit(' <a@b.c> 1700000000 +0000'));
  const glued = concat([
    te.encode(`tree ${tree}\nauthor A <a@b.c> 1700000000 +0000\ncommitter A `),
    Uint8Array.of(0x9e),
    te.encode('<a@b.c> 1700000000 +0000\n\nm\n'),
  ]);
  throws(() => assertFetched('commit', glued), 'pack_corrupt', 'committer: missing space before email');
  // commit#1000022: 0xC1 inserted into the author zone, Latin-1 "+00Á00"
  const poison = concat([
    te.encode(`tree ${tree}\nauthor A <a@b.c> 1700000000 +00`),
    Uint8Array.of(0xc1),
    te.encode('00\ncommitter A <a@b.c> 1700000000 +0000\n\nm\n'),
  ]);
  throws(() => assertFetched('commit', poison), 'pack_corrupt', 'author: bad time zone');
});

test('pkt-line kinds, counters, and length errors', () => {
  const step = chunk => pktStep(pktInit(), chunk);
  throws(() => step(te.encode('zzzz')), 'protocol', 'bad pkt-line length at byte 0');
  throws(() => step(te.encode('0003')), 'protocol', 'invalid pkt-line length 3');
  const one = step(concat([te.encode('0002'), FLUSH, DELIM, pkt('ab')]));
  assert.deepEqual(one.frames.map(f => f.kind), ['end', 'flush', 'delim', 'data']);
  assert.equal(td.decode(one.frames[3].payload), 'ab');
  assert.equal(one.state.end, 1);
  assert.equal(one.state.flush, 1);
  assert.equal(one.state.delim, 1);
  assert.equal(one.state.data, 1);
  assert.equal(one.state.maxPayload, 2);
  const partial = pktStep(pktInit(), te.encode('000'));
  assert.equal(partial.frames.length, 0);
  throws(() => pktFinish(partial.state), 'protocol', 'trailing 3 bytes after last pkt-line');
  assert.equal(pktFinish(one.state).frames, 4);
  const longer = pktStep(one.state, pkt('abcd'));
  assert.equal(longer.state.maxPayload, 4);
  assert.equal(longer.state.data, 2);
});

test('pack header, ofs base, delta opcodes, and trailer', async () => {
  const blob = te.encode('hello');
  const { pack } = await buildPack([{ type: TYPE.BLOB, data: blob }]);
  const parsed = parsePack(pack);
  assert.equal(parsed.stats.version, PACK_VERSION);
  assert.equal(parsed.stats.count, 1);
  assert.equal(parsed.stats.full, 1);
  assert.equal(parsed.stats.ofsDelta, 0);
  assert.equal(parsed.stats.byType.blob, 1);
  assert.equal(parsed.stats.inflated, blob.length);
  assert.ok(parsed.stats.inflate.blocks >= 1);
  assert.deepEqual(parsed.objects[0].data, blob);

  const badSig = pack.slice();
  badSig.set(PACK_SIGNATURE.map((b, i) => (i === 0 ? b : 0)));
  throws(() => parsePack(badSig), 'pack_corrupt', 'pack: bad signature');
  const badVer = pack.slice();
  badVer[7] = 3;
  throws(() => parsePack(badVer), 'pack_corrupt', 'pack: unsupported version 3');
  throws(() => parsePack(pack.subarray(0, 4)), 'pack_corrupt', 'pack: bad signature');

  const za = await zlibDeflate(blob);
  const ha = encodeObjHeader(TYPE.BLOB, blob.length);
  const other = te.encode('hello!');
  const delta = makeDelta(blob, other).delta;
  const zd = await zlibDeflate(delta);
  const hd = encodeObjHeader(TYPE.OFS_DELTA, delta.length);
  const second = PACK_HEADER_BYTES + ha.length + za.length;
  const ofs = second - PACK_HEADER_BYTES;
  assert.ok(ofs < 128);
  const body = concat([
    Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION, 0, 0, 0, 2),
    ha, za, hd, Uint8Array.of(ofs), zd,
  ]);
  const { Sha1 } = await import('../src/sha1.js');
  const ofsPack = concat([body, new Sha1().update(body).digest()]);
  const ofsParsed = parsePack(ofsPack);
  assert.equal(ofsParsed.stats.full, 1);
  assert.equal(ofsParsed.stats.ofsDelta, 1);
  assert.equal(ofsParsed.objects[1].baseOffset, PACK_HEADER_BYTES);

  const early = concat([
    Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION, 0, 0, 0, 1),
    hd, Uint8Array.of(1), zd,
  ]);
  throws(() => parsePack(concat([early, new Sha1().update(early).digest()])), 'pack_corrupt', `pack: ofs delta base before pack start at ${PACK_HEADER_BYTES}`);

  const t5 = encodeObjHeader(5, blob.length);
  const badTypeBody = concat([Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION, 0, 0, 0, 1), t5, za]);
  throws(() => parsePack(concat([badTypeBody, new Sha1().update(badTypeBody).digest()])), 'pack_corrupt', `pack: bad object type 5 at ${PACK_HEADER_BYTES}`);
  throws(() => parsePack(pack, { limits: withLimits({ maxObjectSize: blob.length - 1 }) }), 'limit_exceeded', `pack object size ${blob.length} exceeds limit ${blob.length - 1}`);
  const flipped = ofsPack.slice();
  flipped[flipped.length - 1] ^= 1;
  assert.throws(() => parsePack(flipped), e => e.code === 'pack_corrupt' && /^pack: trailer sha mismatch [0-9a-f]{40} != [0-9a-f]{40}$/.test(e.message));
  assert.equal(parsePack(flipped, { verify: false }).objects.length, 2);
  const extra = concat([pack, Uint8Array.of(0)]);
  assert.throws(() => parsePack(extra), /expected trailer at/);

  assert.equal(readUint32BE(Uint8Array.of(0, 0, 1, 2), 0), 258);
  const hdr = readObjHeader(encodeObjHeader(TYPE.BLOB, 300), 0);
  assert.equal(hdr.type, TYPE.BLOB);
  assert.equal(hdr.size, 300);
  const ofsHdr = readOfsDelta(Uint8Array.of(0x81, 2), 0);
  assert.equal(ofsHdr.off, 258);

  throws(() => applyDelta(blob, new Uint8Array(DELTA_SIZE_MIN - 1)), 'pack_corrupt', 'delta: shorter than DELTA_SIZE_MIN');
  const four = new Uint8Array(DELTA_SIZE_MIN);
  throws(() => applyDelta(new Uint8Array(0), four), 'pack_corrupt', 'delta: reserved opcode 0');
  throws(() => applyDelta(te.encode('no'), delta), 'pack_corrupt', `delta: base size ${blob.length} != 2`);
  const applied = applyDelta(blob, makeDelta(blob, other).delta);
  assert.deepEqual(applied.out, other);
  assert.equal(applied.ops.insert + applied.ops.copy >= 1, true);

  const base = Uint8Array.of(9, 8, 7);
  const op = Uint8Array.of(
    DELTA_COPY | DELTA_COPY_OFF1 | DELTA_COPY_OFF2 | DELTA_COPY_OFF3 | DELTA_COPY_OFF4 | DELTA_COPY_LEN1 | DELTA_COPY_LEN2 | DELTA_COPY_LEN3,
    1, 0, 0, 0, 2, 0, 0,
  );
  const copyDelta = concat([encodeVarint(base.length), encodeVarint(2), op]);
  const copied = applyDelta(base, copyDelta);
  assert.deepEqual([...copied.out], [8, 7]);
  assert.equal(copied.ops.copy, 1);
  assert.equal(copied.ops.copyBytes, 2);
  throws(() => applyDelta(base, concat([encodeVarint(base.length), encodeVarint(1), Uint8Array.of(DELTA_COPY | DELTA_COPY_OFF1 | DELTA_COPY_LEN1, 5, 1)])), 'pack_corrupt', 'delta: copy out of range');
  throws(() => applyDelta(base, concat([encodeVarint(base.length), encodeVarint(1), Uint8Array.of(2, 9)])), 'pack_corrupt', 'delta: insert out of range');
  throws(() => applyDelta(base, concat([encodeVarint(base.length), encodeVarint(2), Uint8Array.of(1, 1)])), 'pack_corrupt', 'delta: produced 1 != 2');
  throws(() => applyDelta(base, makeDelta(base, base).delta, { maxResult: 0 }), 'limit_exceeded', `delta result size ${base.length} exceeds limit 0`);
  assert.ok(copyOp(1, 1)[0] & DELTA_COPY);
});

test('inflate stored, fixed, dynamic, and the header checks', () => {
  const h = huffBuild(Uint8Array.of(1, 2, 0, 2));
  assert.deepEqual([...h.count].slice(0, 4), [0, 1, 2, 0]);
  assert.deepEqual([...h.symbol].slice(0, 3), [0, 1, 3]);
  assert.equal(adler32(Uint8Array.of(1, 2, 3)), 851975);

  const stored = (bytes, final) => {
    const out = new Uint8Array(1 + 4 + bytes.length);
    out[0] = final ? 1 : 0;
    out[1] = bytes.length & 255;
    out[2] = bytes.length >> 8;
    out[3] = ~out[1] & 255;
    out[4] = ~out[2] & 255;
    out.set(bytes, 5);
    return out;
  };
  const two = inflate(concat([stored(Uint8Array.of(1, 2), false), stored(Uint8Array.of(3), true)]), 0, { raw: true });
  assert.deepEqual([...two.out], [1, 2, 3]);
  assert.equal(two.stats.blocks, 2);
  assert.equal(two.stats.stored, 2);
  throws(() => inflate(Uint8Array.of(1), 0, { raw: true }), 'pack_corrupt', 'inflate: truncated stored header');
  const badLen = stored(Uint8Array.of(1), true);
  badLen[3] ^= 1;
  throws(() => inflate(badLen, 0, { raw: true }), 'pack_corrupt', 'inflate: stored length check failed');
  throws(() => inflate(Uint8Array.of(7), 0, { raw: true }), 'pack_corrupt', 'inflate: invalid block type');
  throws(() => inflate(stored(Uint8Array.of(1, 2, 3), true).subarray(0, 6), 0, { raw: true }), 'pack_corrupt', 'inflate: truncated stored block');

  const hello = te.encode('hello hello hello hello');
  const fixed = inflate(new Uint8Array(zlib.deflateSync(hello)));
  assert.equal(fixed.stats.fixed, 1);
  assert.equal(fixed.stats.dynamic, 0);
  assert.equal(td.decode(fixed.out), td.decode(hello));
  assert.equal(fixed.stats.literals, 7);
  assert.equal(fixed.stats.matches, 1);
  assert.equal(fixed.stats.maxDist, 6);
  assert.equal(fixed.stats.maxLen, 16);
  const level0 = inflate(new Uint8Array(zlib.deflateSync(hello, { level: 0 })));
  assert.equal(level0.stats.stored, 1);
  let varied = '';
  for (let i = 0; i < 4000; i++) varied += `word${i % 700} `;
  const dynamic = inflate(new Uint8Array(zlib.deflateSync(Buffer.from(varied))));
  assert.equal(dynamic.stats.dynamic, 1);
  assert.equal(td.decode(dynamic.out), varied);

  const grown = inflate(new Uint8Array(zlib.deflateSync(Buffer.from('a'.repeat(10000)))));
  assert.equal(grown.out.length, 10000);
  throws(() => inflate(new Uint8Array(zlib.deflateSync(hello)), 0, { expectedSize: 1 }), 'pack_corrupt', 'inflate: output exceeds expected 1');
  assert.throws(() => inflate(new Uint8Array(zlib.deflateSync(hello)), 0, { expectedSize: hello.length + 10, maxOutput: 4 }), e => e.code === 'limit_exceeded' && e.message === `inflate: expected size ${hello.length + 10} exceeds limit 4`);
  throws(() => inflate(new Uint8Array(zlib.deflateSync(Buffer.from('a'.repeat(1000)))), 0, { maxOutput: 100 }), 'limit_exceeded', 'inflate: output exceeds limit 100');

  throws(() => inflate(Uint8Array.of(0x01, 0x00)), 'pack_corrupt', 'zlib: unsupported method 1');
  throws(() => inflate(Uint8Array.of(0x78, 0x00)), 'pack_corrupt', 'zlib: bad header check');
  throws(() => inflate(Uint8Array.of(0x78, 0x20)), 'pack_corrupt', 'zlib: preset dictionary not supported');
  const chopped = new Uint8Array(zlib.deflateSync(hello)).subarray(0, 8);
  throws(() => inflate(chopped), 'pack_corrupt', 'inflate: unexpected end of input');
  const mismatch = new Uint8Array(zlib.deflateSync(hello));
  mismatch[mismatch.length - 1] ^= 1;
  throws(() => inflate(mismatch), 'pack_corrupt', 'inflate: adler32 mismatch');
  assert.equal(inflate(mismatch, 0, { verifyAdler: false }).out.length, hello.length);
  const rawCut = new Uint8Array(zlib.deflateRawSync(hello)).subarray(0, 1);
  throws(() => inflate(rawCut, 0, { raw: true }), 'pack_corrupt', 'inflate: unexpected end of input');
});

test('v2 sections, sideband, and the single-object pack stream', async () => {
  const limits = withLimits({ maxSectionLines: 2 });
  let st = v2Init(limits);
  const feed = frame => { const r = v2Step(st, frame); st = r.state; return r; };
  const line = s => ({ kind: 'data', payload: te.encode(s) });
  throws(() => feed(line('ERR boom\n')), 'remote_error', 'remote: boom');
  st = v2Init(limits);
  assert.equal(feed(line('packfile')).state.phase, 'pack');
  assert.deepEqual(feed({ kind: 'flush' }).state.done, true);
  throws(() => feed(line('x')), 'protocol', 'v2: frame after flush');

  st = v2Init(limits);
  feed(line('acknowledgments'));
  assert.equal(feed(line('NAK')).state.acks[0], 'NAK');
  assert.equal(feed(line('ready')).state.ready, true);
  assert.equal(st.acks.length, 1);
  assert.equal(feed(line('NAK')).state.acks.length, 2);
  throws(() => feed(line('NAK')), 'limit_exceeded', 'acknowledgment lines 3 exceeds limit 2');

  st = v2Init();
  feed(line('shallow-info'));
  const id = oid(7);
  assert.deepEqual(feed(line(`shallow ${id}`)).state.shallow, [id]);
  assert.deepEqual(feed(line(`shallow ${id}`)).state.shallow, [id]);
  assert.deepEqual(feed(line(`unshallow ${oid(8)}`)).state.unshallow, [oid(8)]);
  assert.deepEqual(feed(line(`unshallow ${oid(8)}`)).state.unshallow, [oid(8)]);
  assert.equal(feed(line('other')).state.shallow.length, 1);
  st = v2Init(withLimits({ maxSectionLines: 1 }));
  feed(line('shallow-info'));
  feed(line(`shallow ${id}`));
  throws(() => feed(line('other')), 'limit_exceeded', 'shallow-info lines 2 exceeds limit 1');

  st = v2Init(limits);
  feed(line('wanted-refs'));
  const kept = feed(line('abc'));
  assert.equal(kept.state.section, 'wanted-refs');
  assert.equal(kept.pack, null);
  assert.equal(feed({ kind: 'delim' }).state.section, null);
  assert.equal(feed({ kind: 'end' }).state.done, false);

  st = v2Init(limits);
  feed(line('packfile'));
  assert.equal(feed({ kind: 'delim' }).pack, null);
  const body = te.encode('xyz');
  const band = n => ({ kind: 'data', payload: concat([Uint8Array.of(n), body]) });
  const pack = feed(band(SIDEBAND_PACK));
  assert.deepEqual(pack.pack, body);
  assert.equal(pack.state.band1, 3);
  assert.equal(pack.state.packFrames, 1);
  const progress = te.encode('p'.repeat(600));
  const prog = feed({ kind: 'data', payload: concat([Uint8Array.of(SIDEBAND_PROGRESS), progress]) });
  assert.equal(prog.state.band2, 600);
  assert.equal(prog.state.band2Frames, 1);
  assert.equal(prog.state.progress.length, 512);
  throws(() => feed({ kind: 'data', payload: te.encode('\x03  boom \n') }), 'remote_error', 'remote: boom');
  throws(() => feed({ kind: 'data', payload: Uint8Array.of(9, 1) }), 'protocol', 'v2: bad sideband 9');
  throws(() => parseSideband(new Uint8Array(0)), 'protocol', 'short read: need 1 bytes at 0, have 0');
  assert.equal(parseSideband(Uint8Array.of(SIDEBAND_PACK)).body.length, 0);
  assert.deepEqual(parseSideband(concat([Uint8Array.of(SIDEBAND_PROGRESS), te.encode('z')])).body, te.encode('z'));

  const blob = te.encode('pack-obj');
  const { pack: bytes } = await buildPack([{ type: TYPE.BLOB, data: blob }]);
  let sp = spInit();
  const early = spStep(sp, bytes.subarray(0, PACK_HEADER_BYTES));
  assert.equal(early.state.phase, 'header');
  const mid = spStep(early.state, bytes.subarray(PACK_HEADER_BYTES));
  sp = mid.state;
  const finished = spFinish(sp);
  assert.equal(finished.phase, 'body');
  assert.equal(finished.trailer.length, 40);
  throws(() => spFinish(spInit()), 'pack_corrupt', 'pack: truncated before object header');
  const sig = bytes.slice();
  sig[0] ^= 0xff;
  throws(() => spStep(spInit(), sig), 'pack_corrupt', 'pack: bad signature');
  const ver = bytes.slice();
  ver[7] = 9;
  throws(() => spStep(spInit(), ver), 'pack_corrupt', 'pack: bad version');
  const { pack: two } = await buildPack([{ type: TYPE.BLOB, data: blob }, { type: TYPE.BLOB, data: blob }]);
  throws(() => spStep(spInit(), two), 'pack_corrupt', 'pack: expected 1 object, got 2');
  const { pack: ref } = await buildPack([{ type: TYPE.BLOB, data: blob, baseOid: oid(1) }]);
  throws(() => spStep(spInit(), ref), 'pack_corrupt', 'pack: single-object pack is a delta');
  const torn = bytes.slice();
  torn[torn.length - 1] ^= 1;
  let bad = spInit();
  bad = spStep(bad, torn).state;
  assert.throws(() => spFinish(bad), e => e.code === 'pack_corrupt' && e.message.startsWith('pack: trailer ') && e.message.includes(' != '));
});

test('ls-refs lines and report-status', () => {
  const id = oid(4);
  assert.deepEqual(parseLsRefLine(`${id} refs/heads/main`), { oid: id, name: 'refs/heads/main' });
  assert.deepEqual(parseLsRefLine(`${id} HEAD symref-target:refs/heads/main peeled:${id}`), {
    oid: id, name: 'HEAD', 'symref-target': 'refs/heads/main', peeled: id,
  });
  assert.deepEqual(parseLsRefLine(`${id} refs/tags/v1 bare`), { oid: id, name: 'refs/tags/v1' });
  // #16: only symref-target and peeled are kept; a server attribute never overrides the parsed oid or name
  assert.deepEqual(parseLsRefLine(`${id} refs/heads/main oid:junk name:refs/heads/other`), { oid: id, name: 'refs/heads/main' });
  assert.deepEqual(parseLsRefLine(`${id} refs/heads/main oid:${oid(5)} name:HEAD __proto__:x constructor:y`), { oid: id, name: 'refs/heads/main' });
  assert.deepEqual(parseLsRefLine(`${id} refs/heads/main peeled symref-target`), { oid: id, name: 'refs/heads/main' }, 'no colon: not the attribute (git skip_prefix)');
  assert.deepEqual(parseLsRefLine(`${id} refs/heads/main peeled_ symref-target_`), { oid: id, name: 'refs/heads/main' }, 'no colon: never a key cut one char short');
  assert.deepEqual(parseLsRefLine(`${id} refs/heads/main  peeled:${id}  `), { oid: id, name: 'refs/heads/main', peeled: id }, 'doubled spaces');
  // the name is never read as an attribute, with or without attributes after it
  assert.deepEqual(parseLsRefLine(`${id} symref-target:refs/heads/x`), { oid: id, name: 'symref-target:refs/heads/x' });
  assert.deepEqual(parseLsRefLine(`${id} peeled:junk symref-target:refs/heads/main`), { oid: id, name: 'peeled:junk', 'symref-target': 'refs/heads/main' });
  for (const bad of ['junk', 'AB'.repeat(20), `${oid(5)}0`, '']) {
    const line = `${id} refs/tags/v1 peeled:${bad}`;
    throws(() => parseLsRefLine(line), 'protocol', `ls-refs: malformed line ${JSON.stringify(line.slice(0, 60))}`);
  }
  throws(() => parseLsRefLine('ERR no such ref'), 'remote_error', 'remote: no such ref');
  throws(() => parseLsRefLine('nope'), 'protocol', 'ls-refs: malformed line "nope"');
  throws(() => parseLsRefLine(`${id} `), 'protocol', `ls-refs: malformed line ${JSON.stringify(`${id} `)}`);
  throws(() => parseLsRefLine(`${'ab'.repeat(32)} refs/heads/main`), 'unsupported', 'unsupported object-format: only sha1 repositories are supported');
  const upper = 'ab'.repeat(20).toUpperCase();
  throws(() => parseLsRefLine(`${upper} refs/heads/main`), 'protocol', `ls-refs: malformed line ${JSON.stringify(`${upper} refs/heads/main`)}`);
  const long = 'not a ref line '.repeat(8);
  throws(() => parseLsRefLine(long), 'protocol', `ls-refs: malformed line ${JSON.stringify(long.slice(0, 60))}`);

  const ok = parseReportStatus(['unpack ok', 'ok refs/heads/main', 'ok refs/heads/other']);
  assert.equal(ok.ok, true);
  assert.equal(ok.unpack, 'ok');
  assert.equal(ok.refs.length, 2);
  const ng = parseReportStatus(['unpack ok', 'ok refs/heads/main', 'ng refs/heads/other failed to lock', 'option old-oid abc', 'option quiet']);
  assert.equal(ng.ok, false);
  assert.equal(ng.refs[1].ref, 'refs/heads/other');
  assert.equal(ng.refs[1].reason, 'failed to lock');
  assert.equal(ng.refs[1].options['old-oid'], 'abc');
  // #16: option names are the server's; a `__proto__` or `constructor` option is recorded, and an absent one reads as absent
  const named = parseReportStatus(['unpack ok', 'ok refs/heads/main', 'option __proto__ x', 'option constructor']);
  assert.deepEqual(Object.entries(named.refs[0].options), [['__proto__', 'x'], ['constructor', true]]);
  assert.equal(ok.refs[0].options.constructor, undefined);
  assert.equal('toString' in ok.refs[0].options, false);
  assert.equal(ng.refs[1].options.quiet, true);
  assert.equal(parseReportStatus(['unpack error']).ok, false);
  assert.equal(parseReportStatus(['unpack ok']).unpack, 'ok');
  assert.equal(parseReportStatus(['ok refs/heads/main']).ok, false);
  assert.equal(parseReportStatus(['unpackok', 'ok refs/heads/main']).unpack, null);
  throws(() => parseReportStatus(['unpack failed', 'unpack ok', 'ok refs/heads/main']), 'protocol', 'report: duplicate unpack');
  throws(() => parseReportStatus(['unpack ok', 'ok refs/heads/main', 'unpack ok']), 'protocol', 'report: duplicate unpack');
});

test('ssh url, kex, and gitattributes lines', () => {
  assert.deepEqual(parseSshUrl('ssh://host/path'), { user: 'git', host: 'host', port: 22, path: '/path' });
  assert.deepEqual(parseSshUrl('ssh://u@host/p'), { user: 'u', host: 'host', port: 22, path: '/p' });
  assert.deepEqual(parseSshUrl('ssh://host:2222/p'), { user: 'git', host: 'host', port: 2222, path: '/p' });
  assert.deepEqual(parseSshUrl('ssh://u@h:2222/a/b'), { user: 'u', host: 'h', port: 2222, path: '/a/b' });
  assert.deepEqual(parseSshUrl('git@github.com:o/r.git'), { user: 'git', host: 'github.com', port: 22, path: 'o/r.git' });
  assert.deepEqual(parseSshUrl('host:name'), { user: 'git', host: 'host', port: 22, path: 'name' });
  throws(() => parseSshUrl('https://x/y'), 'bad_request', 'not an ssh git url: https://x/y');
  throws(() => parseSshUrl('ssh://host'), 'bad_request', 'not an ssh git url: ssh://host');
  throws(() => parseSshUrl('host:22/foo'), 'bad_request', 'not an ssh git url: host:22/foo');
  const cookie = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
  const kex = parseKexInit(kexInit(cookie));
  assert.deepEqual(kex.kex, ['curve25519-sha256', 'curve25519-sha256@libssh.org']);
  assert.deepEqual(kex.hostKey, ['ssh-ed25519']);
  assert.equal(kex.firstFollows, false);
  assert.deepEqual(kex.langCS, []);
  throws(() => parseKexInit(Uint8Array.of(1)), 'ssh', 'ssh: expected KEXINIT');

  const no = { macrosOk: false };
  const yes = { macrosOk: true };
  assert.deepEqual(parseLine('*.txt text', no), { pat: { pattern: '*.txt', negative: false, mustBeDir: false, nodir: true, prefix: 0, endsWith: true }, states: [['text', true]] });
  assert.deepEqual(parseLine('  *.txt text', no).pat.pattern, '*.txt');
  assert.equal(parseLine('# comment', no), null);
  assert.equal(parseLine('', no), null);
  assert.equal(parseLine('!*.txt text', no), null);
  assert.equal(parseLine('docs/ text', no).pat.mustBeDir, true);
  assert.equal(parseLine('docs/ text', no).pat.pattern, 'docs');
  assert.equal(parseLine('dir/file text', no).pat.nodir, false);
  assert.deepEqual(parseLine('*.c diff=cpp', no).states, [['diff', 'cpp']]);
  assert.deepEqual(parseLine('*.c -text', no).states, [['text', false]]);
  assert.deepEqual(parseLine('*.c !text', no).states, [['text', UNSET]]);
  assert.equal(parseLine('"*.txt" text', no).pat.pattern, '*.txt');
  assert.deepEqual(parseLine('[attr]binary -diff -merge -text', yes), { macro: 'binary', states: [['diff', false], ['merge', false], ['text', false]] });
  assert.equal(parseLine('[attr]binary -diff', no), null);
  assert.equal(parseLine('[attr] text', yes).pat.pattern, '[attr]');
  assert.equal(parseLine('*.c -', no), null);
  assert.equal(parseLine('*.c =novalue', no), null);
  assert.equal(parseLine('*.c builtin_x', no), null);
  assert.deepEqual(parseLine('*.c builtin_x', { macrosOk: false, reserveBuiltin: false }).states, [['builtin_x', true]]);
  assert.equal(parseLine('x'.repeat(2048), no), null);
  assert.equal(parseLine('x'.repeat(2047), no).pat.pattern.length, 2047);
  const file = parseFile('*.txt text\n*.c -text\n# c\n\n*.bin binary\0junk\n');
  assert.deepEqual(file.map(l => l.pat.pattern), ['*.txt', '*.c', '*.bin']);
  assert.deepEqual(parseFile(''), []);
  assert.equal(parseFile('*.txt text').length, 1);
  assert.equal(hashObject('blob', te.encode('x')).length, OID_HEX_CHARS);
});

test('boundaries between a thrown error and its neighbour', async () => {
  const author = 'Ada <ada@ex> 1700000000 +0000';
  const tree = oid(1);
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\nauthor Ada >x 1 +0000\ncommitter ${author}\n\n`)), 'pack_corrupt', 'author: missing email');
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\nauthor Ada <ada@ex 1 +0000\ncommitter ${author}\n\n`)), 'pack_corrupt', 'author: missing email');
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\nauthor <ada@ex> 1700000000 +0000\ncommitter ${author}\n\n`)), 'pack_corrupt', 'author: missing space before email');
  assertFetched('commit', te.encode(`tree ${tree}\nauthor  <ada@ex> 1700000000 +0000\ncommitter ${author}\n\n`));
  assert.equal(parseCommit(new Uint8Array(0)).message, null);
  throws(() => parseTree(data('100644 a', oidBytes(4))), 'pack_corrupt', 'tree: malformed entry');
  throws(() => parseTree(data('g7 a\0', oidBytes(4))), 'pack_corrupt', 'tree: malformed mode');
  throws(() => parseTag(te.encode('tag')), 'pack_corrupt', 'tag: truncated header line');
  throws(() => parseTag(te.encode(`object ${oid(3)}\ntype commit\ntag v1\nfoo bar\n\n`)), 'pack_corrupt', 'tag: bad header order');
  const extra = parseTag(te.encode(`object ${oid(3)}\ntype commit\ntag v1\ntagger ${author}\nfoo bar\n\n`));
  assert.equal(extra.tagger, author);
  assert.deepEqual(extra.extra, ['foo bar']);
  throws(() => parseTag(te.encode(`object ${oid(3)}\ntype commit\ntag v1\ntagger ${author}\ntagger second <s@ex> 1 +0000\n\n`)), 'pack_corrupt', 'tag: duplicate tagger');
  assert.deepEqual(parseIdent('>a <b@c> 1 +0000'), { name: '>a', email: 'b@c', time: '1', tz: '+0000' });
  assert.deepEqual(parseIdent('Ada <a@b>'), { name: 'Ada', email: 'a@b', time: null, tz: '' });
  assert.deepEqual(parseIdent('Ada <a@b> 1  +0100'), { name: 'Ada', email: 'a@b', time: '1', tz: '+0100' });
  assert.equal(parseIdent('Ada <a@b> 12abc +0000').time, null);
  assert.equal(parseIdent('Ada <a@b> x12 +0000').time, null);
  assert.deepEqual(parseIdent('Ada <ada@ex'), { name: 'Ada <ada@ex', email: '', time: null, tz: '' });

  const blob = te.encode('hello');
  const { pack } = await buildPack([{ type: TYPE.BLOB, data: blob }]);
  assert.equal(parsePack(pack, { limits: withLimits({ maxObjectSize: blob.length }) }).objects.length, 1);
  const emptyBody = Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION, 0, 0, 0, 0);
  const { Sha1 } = await import('../src/sha1.js');
  const emptyPack = concat([emptyBody, new Sha1().update(emptyBody).digest()]);
  assert.equal(emptyPack.length, PACK_HEADER_BYTES + OID_BYTES);
  assert.equal(parsePack(emptyPack).stats.count, 0);
  const commitBytes = te.encode(`tree ${tree}\nauthor ${author}\ncommitter ${author}\n\n`);
  const tagBytes = te.encode(`object ${oid(3)}\ntype commit\ntag v\ntagger ${author}\n\n`);
  for (const [type, bytes] of [[TYPE.COMMIT, commitBytes], [TYPE.TAG, tagBytes], [0, blob]]) {
    const z = await zlibDeflate(bytes);
    const h = encodeObjHeader(type, bytes.length);
    const body = concat([Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION, 0, 0, 0, 1), h, z]);
    const built = concat([body, new Sha1().update(body).digest()]);
    if (type === 0) throws(() => parsePack(built), 'pack_corrupt', `pack: bad object type 0 at ${PACK_HEADER_BYTES}`);
    else assert.equal(parsePack(built).stats.full, 1);
  }
  const parsed = parsePack(pack);
  assert.ok(parsed.objects[0].headerBytes > 0 && parsed.objects[0].headerBytes < 16);
  assert.equal(parsed.stats.compressed > 0, true);
  assert.equal(parsed.stats.inflate.blocks > 0, true);

  const base = Uint8Array.of(1, 2, 3, 4);
  const exact = makeDelta(base, base).delta;
  assert.deepEqual(applyDelta(base, exact, { maxResult: base.length }).out, base);
  const inserted = applyDelta(base, concat([encodeVarint(base.length), encodeVarint(1), Uint8Array.of(1, 9)]));
  assert.equal(inserted.ops.insertBytes, 1);

  let sp = spInit();
  const opened = spStep(sp, pack.subarray(0, PACK_HEADER_BYTES + 1));
  assert.equal(opened.state.phase, 'body');
  assert.equal(spStep(spInit(), pack).state.bytes, pack.length);
  throws(() => spFinish(opened.state), 'pack_corrupt', 'pack: missing trailer');
  const streamed = spStep(opened.state, pack.subarray(PACK_HEADER_BYTES + 1));
  assert.equal(spFinish(streamed.state).zlibBytes, streamed.state.zlibBytes);
  assert.ok(streamed.state.zlibBytes > 0);

  throws(() => parseSshUrl('xsssh://host/path'), 'bad_request', 'not an ssh git url: xsssh://host/path');
  assert.equal(parseSshUrl('ssh://ab@host/p').user, 'ab');
  throws(() => parseSshUrl('/git@github.com:o/r.git'), 'bad_request', 'not an ssh git url: /git@github.com:o/r.git');
  throws(() => parseSshUrl('host:22'), 'bad_request', 'not an ssh git url: host:22');

  const no = { macrosOk: false };
  const yes = { macrosOk: true };
  assert.equal(parseLine('*.txt text=v', no).states[0][1], 'v');
  assert.equal(parseLine('*.txt eq=at=mid', no).states[0][1], 'at=mid');
  assert.equal(parseLine('"*.c" diff', no).pat.pattern, '*.c');
  assert.equal(parseLine('[attr]-no -text', yes), null);
  assert.equal(parseLine('[attr]ok -text', yes).macro, 'ok');
  assert.equal(parseFile('*.c text\0ignored').length, 1);
  assert.equal(parseFile('*.c text').length, 1);
  assert.deepEqual(parseFile('*.c text', { maxFile: 8 }), []);
  assert.equal(parseFile('*.c text', { maxFile: 9 }).length, 1);

  const id = oid(9);
  throws(() => parseLsRefLine(` ${id}`), 'protocol', `ls-refs: malformed line ${JSON.stringify(` ${id}`)}`);
  assert.equal(parseLsRefLine(`${id} refs/heads/a`).name, 'refs/heads/a');
  assert.equal(parseLsRefLine(`${id} refs/heads/a symref-target:val`)['symref-target'], 'val');
  assert.equal(parseLsRefLine(`${id} refs/heads/a sym:val`).sym, undefined);
  const report = parseReportStatus(['unpack ok', 'ok refs/heads/main']);
  assert.equal(report.ok, true);
  assert.equal(report.refs[0].ref, 'refs/heads/main');
  const opted = parseReportStatus(['unpack ok', 'ok refs/heads/main', 'option alone']);
  assert.equal(opted.refs[0].options.alone, true);
  assert.equal(parseReportStatus(['option alone']).refs.length, 0);

  let st = v2Init();
  const line = s => ({ kind: 'data', payload: te.encode(s) });
  const end = v2Step(st, { kind: 'end' });
  assert.equal(end.state.done, false);
  st = v2Step(st, line('shallow-info')).state;
  st = v2Step(st, line(`unshallow ${id}`)).state;
  assert.deepEqual(st.unshallow, [id]);
  const nl = v2Step(st, line('shallow x\n')).state;
  assert.equal(nl.shallow[0], 'x');
});

test('asymmetric boundaries a symmetric fixture hides', async () => {
  const no = { macrosOk: false };
  assert.equal(parseLine('*.txt text', no).pat.endsWith, true);
  assert.equal(parseLine('*.txt text', no).pat.nodir, true);
  assert.equal(parseLine('/file text', no).pat.nodir, false);
  assert.equal(parseLine('docs/ text', no).pat.nodir, true);
  assert.equal(parseLine('*a* text', no).pat.endsWith, false);
  assert.equal(parseLine('a* text', no).pat.endsWith, false);
  assert.deepEqual(parseLine('*.c plain later=v', no).states[0], ['plain', true]);
  assert.equal(parseLine('*.c plain later=v', no).states[1][0], 'later');
  assert.deepEqual(parseFile('[attr]binary -text'), []);
  assert.deepEqual(parseFile('*.c builtin_x'), []);
  assert.equal(parseFile('*.c builtin_x', { reserveBuiltin: false }).length, 1);
  assert.deepEqual(parseFile('\0*.c text'), []);
  assert.equal(parseFile('*.c text').length, 1);
  assert.equal(parseFile('\n*.c text')[0].pat.pattern, '*.c');

  throws(() => parseTree(Uint8Array.of(0x20)), 'pack_corrupt', 'tree: malformed entry');
  assert.deepEqual(parseIdent('a><b@c> 1 +0000'), { name: 'a>', email: 'b@c', time: '1', tz: '+0000' });
  const author = 'Ada <ada@ex> 1700000000 +0000';
  const tree = oid(1);
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\nauthor ><ada@ex> 1700000000 +0000\ncommitter ${author}\n\n`)), 'pack_corrupt', 'author: bad name');
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\nauthor >a <ada@ex> 1700000000 +0000\ncommitter ${author}\n\n`)), 'pack_corrupt', 'author: bad name');
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\nauthor ${author}\ncommitter Ada\n\n`)), 'pack_corrupt', 'committer: missing email');
  const id = oid(3);
  const tagger = author;
  throws(() => parseTag(te.encode(`type commit\nobject ${id}\ntag v1\ntagger ${tagger}\n\n`)), 'pack_corrupt', 'tag: bad header order');
  throws(() => parseTag(te.encode(`tag v1\nobject ${id}\ntype blob\ntagger ${tagger}\n\n`)), 'pack_corrupt', 'tag: bad header order');

  const onlyDelim = pktStep(pktInit(), DELIM);
  assert.equal(onlyDelim.state.delim, 1);
  assert.equal(onlyDelim.state.end, 0);
  assert.equal(onlyDelim.state.flush, 0);
  const onlyEnd = pktStep(pktInit(), te.encode('0002'));
  assert.equal(onlyEnd.state.end, 1);
  assert.equal(onlyEnd.state.delim, 0);
  const first = pkt('ab');
  throws(() => pktStep(pktStep(pktInit(), first).state, te.encode('zzzz')), 'protocol', `bad pkt-line length at byte ${first.length}`);
  const long = pkt('abcd');
  const afterLong = pktStep(pktInit(), long).state;
  const shorter = pktStep(afterLong, pkt('z'));
  assert.equal(shorter.state.maxPayload, 4);
  assert.equal(pktStep(pktInit(), pkt('a')).state.carry, null);
  const partial = te.encode('000');
  const carried = pktStep(pktInit(), partial);
  partial[0] = 0x31;
  assert.equal(carried.state.carry[0], 0x30);
  assert.equal(carried.state.carryMax, 3);
  const rest = te.encode('6abZ');
  const finished = pktStep(carried.state, rest);
  assert.equal(finished.state.carry.length, 1);
  assert.equal(finished.state.carryMax, 3);

  const embedded = v2Step(v2Init(), { kind: 'data', payload: te.encode('foo\nbar\n') });
  assert.equal(embedded.state.sections[0], 'foo\nbar');
  const eleven = new Uint8Array(PACK_HEADER_BYTES - 1);
  eleven.set(PACK_SIGNATURE);
  eleven[0] ^= 0xff;
  assert.equal(spStep(spInit(), eleven).state.phase, 'header');
  const continued = encodeObjHeader(TYPE.BLOB, 300);
  const waitHead = concat([
    Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION, 0, 0, 0, 1),
    continued.subarray(0, 1),
  ]);
  const waited = spStep(spInit(), waitHead);
  assert.equal(waited.state.phase, 'header');
  assert.deepEqual(waited.zlib, []);

  const base = Uint8Array.of(1, 2, 3);
  const off4 = Uint8Array.of(
    DELTA_COPY | DELTA_COPY_OFF1 | DELTA_COPY_OFF4 | DELTA_COPY_LEN1,
    1, 1, 1,
  );
  throws(() => applyDelta(base, concat([encodeVarint(base.length), encodeVarint(1), off4])), 'pack_corrupt', 'delta: copy out of range');
  throws(() => applyDelta(base, concat([encodeVarint(base.length), encodeVarint(2), Uint8Array.of(DELTA_COPY | DELTA_COPY_OFF1 | DELTA_COPY_LEN1, 2, 2)])), 'pack_corrupt', 'delta: copy out of range');
  throws(() => applyDelta(base, concat([encodeVarint(base.length), encodeVarint(1), Uint8Array.of(2, 9, 9)])), 'pack_corrupt', 'delta: insert out of range');

  assert.equal(parseReportStatus([]).ok, false);
  assert.equal(parseReportStatus(['unpack ok']).ok, false);
  assert.equal(parseReportStatus(['unpack ok', 'ng refs/heads/a no']).ok, false);

  const ref = `${oid(4)} refs/heads/a :val`;
  assert.deepEqual(parseLsRefLine(ref), { oid: oid(4), name: 'refs/heads/a' });
  throws(() => parseLsRefLine(`${oid(4)}  refs/heads/a`), 'protocol', `ls-refs: malformed line ${JSON.stringify(`${oid(4)}  refs/heads/a`)}`);
  const spaced = parseLsRefLine(`${oid(4)} refs/heads/a symref-target:b  peeled:${oid(5)}`);
  assert.deepEqual(spaced, { oid: oid(4), name: 'refs/heads/a', 'symref-target': 'b', peeled: oid(5) });

  throws(() => parseSshUrl('ssh://host/path\n'), 'bad_request', 'not an ssh git url: ssh://host/path\n');
  throws(() => parseSshUrl('host:name\n'), 'bad_request', 'not an ssh git url: host:name\n');

  const hello = te.encode('hello hello hello hello');
  const inflated = inflate(new Uint8Array(zlib.deflateSync(hello)));
  assert.ok(inflated.stats.matchBytes > 0);
  assert.equal(inflated.stats.matchBytes, 16);
  const repeated = te.encode('abcdefghijabcdefghijab');
  const twice = inflate(new Uint8Array(zlib.deflateSync(repeated)));
  assert.ok(twice.stats.maxLen >= 10);
  assert.ok(twice.stats.maxDist >= 10);

  const blob = te.encode('hello');
  const { pack } = await buildPack([{ type: TYPE.BLOB, data: blob }]);
  const shrunk = pack.slice();
  shrunk[PACK_HEADER_BYTES] = (shrunk[PACK_HEADER_BYTES] & 0xf0) | 1;
  throws(() => parsePack(shrunk), 'pack_corrupt', 'inflate: output exceeds expected 1');
  const stored = new Uint8Array(zlib.deflateSync(blob, { level: 0 }));
  const header = encodeObjHeader(TYPE.BLOB, blob.length);
  const body = concat([Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION, 0, 0, 0, 1), header, stored]);
  const { Sha1 } = await import('../src/sha1.js');
  const storedPack = concat([body, new Sha1().update(body).digest()]);
  const parsed = parsePack(storedPack);
  assert.equal(parsed.stats.inflate.stored, 1);
  assert.equal(parsed.stats.inflate.fixed, 0);
  assert.equal(parsed.stats.inflate.dynamic, 0);
  const fixed = parsePack(pack);
  assert.equal(fixed.stats.inflate.stored + fixed.stats.inflate.fixed + fixed.stats.inflate.dynamic, fixed.stats.inflate.blocks);
  let words = '';
  for (let i = 0; i < 400; i++) words += `word${i} `;
  const wordBytes = te.encode(words);
  const wordInf = inflate(new Uint8Array(zlib.deflateSync(wordBytes)));
  assert.equal(wordInf.stats.dynamic, 1);
  assert.equal(wordInf.stats.maxDist, 2819);
  assert.equal(wordInf.stats.maxLen, 9);
  assert.equal(wordInf.stats.matchBytes, 2745);
  const variedZ = new Uint8Array(zlib.deflateSync(wordBytes));
  const variedHeader = encodeObjHeader(TYPE.BLOB, wordBytes.length);
  const variedBody = concat([Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION, 0, 0, 0, 1), variedHeader, variedZ]);
  const variedPack = concat([variedBody, new Sha1().update(variedBody).digest()]);
  assert.equal(parsePack(variedPack).stats.inflate.dynamic, 1);

  assert.equal(parseLine('a text', no).pat.endsWith, false);
  assert.deepEqual(parseLine('*.c text=', no).states, [['text', '']]);
  assert.deepEqual(parseIdent('  Ada <ada@ex'), { name: 'Ada <ada@ex', email: '', time: null, tz: '' });
  throws(() => parseTag(te.encode(`type commit\ntype blob\nobject ${id}\ntag v1\ntag v2\ntagger ${tagger}\n\n`)), 'pack_corrupt', 'tag: bad header order');
  throws(() => parseTag(te.encode(`object ${id}\ntype commit\ntype blob\ntag v1\ntagger ${tagger}\n\n`)), 'pack_corrupt', 'tag: duplicate type');
  throws(() => parseTag(te.encode(`object ${id}\ntype commit\ntag v1\ntag v2\ntagger ${tagger}\n\n`)), 'pack_corrupt', 'tag: duplicate tag');

  throws(() => pktStep(pktInit(), te.encode('0000zzzz')), 'protocol', 'bad pkt-line length at byte 4');
  const line = s => ({ kind: 'data', payload: te.encode(s) });
  const endOnly = v2Step(v2Init(), { kind: 'end' });
  assert.equal(endOnly.state.done, false);
  assert.deepEqual(endOnly.state.sections, []);
  let shallow = v2Step(v2Init(), line('shallow-info')).state;
  shallow = v2Step(shallow, line(`shallow ${oid(4)}`)).state;
  const other = v2Step(shallow, line('other')).state;
  assert.deepEqual(other.unshallow, []);
  assert.deepEqual(other.acks, []);

  const ofsHeader = encodeObjHeader(TYPE.OFS_DELTA, 1);
  const ofsZ = await zlibDeflate(Uint8Array.of(0));
  const ofsBody = concat([Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION, 0, 0, 0, 1), ofsHeader, Uint8Array.of(1), ofsZ]);
  throws(() => spStep(spInit(), concat([ofsBody, new Sha1().update(ofsBody).digest()])), 'pack_corrupt', 'pack: single-object pack is a delta');
  const whole = pack.slice();
  const opened = spStep(spInit(), whole.subarray(0, PACK_HEADER_BYTES + 1));
  whole[PACK_HEADER_BYTES] ^= 0xff;
  const streamed = spStep(opened.state, whole.subarray(PACK_HEADER_BYTES + 1));
  assert.equal(spFinish(streamed.state).trailer.length, 40);

  throws(() => applyDelta(base, concat([encodeVarint(base.length), encodeVarint(1), Uint8Array.of(DELTA_COPY | DELTA_COPY_LEN1, 2)])), 'pack_corrupt', 'delta: copy out of range');
  throws(() => applyDelta(base, concat([encodeVarint(base.length), encodeVarint(5), Uint8Array.of(3, 1)])), 'pack_corrupt', 'delta: insert out of range');

  throws(() => parseLsRefLine('x'.repeat(80)), 'protocol', `ls-refs: malformed line ${JSON.stringify('x'.repeat(60))}`);
  throws(() => parseLsRefLine(`${'ab'.repeat(20)}c`), 'protocol', `ls-refs: malformed line ${JSON.stringify(`${'ab'.repeat(20)}c`)}`);

  const bits = []; const put = (v, n) => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); };
  put(1, 1); put(2, 2);
  put(0, 5); put(0, 5); put(1, 4);
  put(0, 3); put(0, 3); put(0, 3); put(1, 3); put(1, 3);
  for (let i = 0; i < 256; i++) put(0, 1);
  put(1, 1);
  put(0, 1);
  for (let i = 0; i < 16; i++) put(1, 1);
  const raw = Uint8Array.from(Array.from({ length: Math.ceil(bits.length / 8) }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((b, v, j) => b | (v << j), 0)));
  throws(() => inflate(raw, 0, { raw: true, maxOutput: 1024 }), 'pack_corrupt', 'inflate: invalid huffman code');

  const helloZ = new Uint8Array(zlib.deflateSync(hello));
  assert.equal(inflate(helloZ, 0, { expectedSize: hello.length, maxOutput: hello.length + 10 }).out.length, hello.length);
  const emptyStored = Uint8Array.of(1, 0, 0, 255, 255);
  assert.equal(inflate(emptyStored, 0, { raw: true }).out.length, 0);
  const zhead = Uint8Array.of(0x78, 0x9c);
  const cut = concat([zhead, Uint8Array.of(1, 0, 0, 255, 255)]);
  throws(() => inflate(cut), 'pack_corrupt', 'inflate: truncated adler32');
});

test('parser edges a symmetric or unreachable fixture left alive', async () => {
  const no = { macrosOk: false };
  assert.equal(parseLine('  "*.c" text', no).pat.pattern, '*.c');
  assert.equal(parseLine('a"b text', no).pat.pattern, 'a"b');
  assert.deepEqual(parseLine('*.c text more=v', no).states, [['text', true], ['more', 'v']]);
  assert.equal(parseFile('*.c text')[0].states[0][0], 'text');
  assert.equal(parseFile('\n*.c text\n*.h text').length, 2);

  const carriedHex = pktStep(pktInit(), te.encode('00')).state;
  throws(() => pktStep(carriedHex, te.encode('00zzzz')), 'protocol', 'bad pkt-line length at byte 4');

  const hello = te.encode('hello hello hello hello');
  const helloZ = new Uint8Array(zlib.deflateSync(hello));
  throws(() => inflate(helloZ, 0, { expectedSize: hello.length + 10 }), 'pack_corrupt', `inflate: size ${hello.length} != expected ${hello.length + 10}`);

  const { Sha1 } = await import('../src/sha1.js');
  const blob = te.encode('hello-hello-hello');
  const storedZ = new Uint8Array(zlib.deflateSync(blob, { level: 0 }));
  const objHeader = encodeObjHeader(TYPE.BLOB, blob.length);
  const head = concat([Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION, 0, 0, 0, 1), objHeader]);
  const unsigned = concat([head, storedZ]);
  const whole = concat([unsigned, new Sha1().update(unsigned).digest()]);
  const opened = spStep(spInit(), whole.subarray(0, head.length));
  assert.equal(opened.state.phase, 'body');
  assert.equal(opened.state.lag.length, 0);
  const chunk = whole.slice(head.length);
  const streamed = spStep(opened.state, chunk);
  const lagByte = streamed.state.lag[streamed.state.lag.length - 1];
  chunk[chunk.length - 1] ^= 0xff;
  assert.equal(streamed.state.lag[streamed.state.lag.length - 1], lagByte);

  // RFC 1951 §3.2.6 fixed Huffman codes, built the same way inflate does, then emitted MSB first.
  const litTab = huffCodes(huffBuild(Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8))));
  const distTab = huffCodes(huffBuild(Array.from({ length: 30 }, () => 5)));
  const fixed = (...ops) => {
    const bits = [];
    const put = (v, n) => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); };
    const putCode = rec => { for (let i = rec.len - 1; i >= 0; i--) bits.push((rec.code >> i) & 1); };
    put(1, 1); put(1, 2);
    for (const op of ops) {
      if (op.lit !== undefined) putCode(litTab.get(op.lit));
      else if (op.len) { putCode(litTab.get(op.sym)); if (op.extra) put(op.extra, op.extraBits); putCode(distTab.get(op.dist)); if (op.distExtra !== undefined) put(op.distExtra, op.distExtraBits); }
      else putCode(litTab.get(256));
    }
    return packBits(bits);
  };

  // 11 bits: final fixed block, one literal, no end-of-block. The padded high bits of the last byte are zeros.
  throws(() => inflate(fixed({ lit: 97 }), 0, { raw: true }), 'pack_corrupt', 'inflate: unexpected end of input');
  throws(() => inflate(fixed({ sym: 286, len: true, dist: 0 }), 0, { raw: true, maxOutput: 64 }), 'pack_corrupt', 'inflate: bad length symbol');
  throws(() => inflate(fixed({ sym: 257, len: true, dist: 0 }), 0, { raw: true, maxOutput: 64 }), 'pack_corrupt', 'inflate: distance too far back');
  const overlapped = inflate(fixed({ lit: 97 }, { sym: 257, len: true, dist: 0 }, {}), 0, { raw: true });
  assert.deepEqual([...overlapped.out], [97, 97, 97, 97]);
  const distances = inflate(fixed(
    ...[...'abcdef'].map(ch => ({ lit: ch.charCodeAt(0) })),
    { sym: 257, len: true, dist: 4, distExtra: 1, distExtraBits: 1 },
    { sym: 257, len: true, dist: 0 },
    {},
  ), 0, { raw: true });
  assert.equal(distances.stats.maxDist, 6);
  assert.equal(distances.out.length, 12);

  // One literal plus a 256-byte match is 257 bytes. The initial buffer is 256 and the limit is the exact size,
  // so growing onto the limit is legal and stopping one short of it is not.
  const onto = inflate(fixed({ lit: 97 }, { sym: 284, len: true, extra: 29, extraBits: 5, dist: 0 }, {}), 0, { raw: true, maxOutput: 257 });
  assert.equal(onto.out.length, 257);
  // A second match asks for more than twice the current buffer, so the growth loop has to run.
  const grown = inflate(fixed(
    { lit: 97 },
    { sym: 284, len: true, extra: 27, extraBits: 5, dist: 0 },
    { sym: 285, len: true, dist: 0 },
    {},
  ), 0, { raw: true });
  assert.equal(grown.out.length, 513);

  const stored = new Uint8Array(305);
  stored[0] = 1; stored[1] = 300 & 255; stored[2] = 300 >> 8;
  const nlen = (~300) & 0xffff; stored[3] = nlen & 255; stored[4] = nlen >> 8;
  stored.fill(7, 5);
  throws(() => inflate(stored, 0, { raw: true, maxOutput: 100 }), 'limit_exceeded', 'inflate: output exceeds limit 100');

  const dyn = (hlit, hdist) => {
    const bits = [];
    const put = (v, n) => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); };
    put(1, 1); put(2, 2); put(hlit, 5); put(hdist, 5); put(0, 4);
    return packBits(bits);
  };
  throws(() => inflate(dyn(30, 0), 0, { raw: true }), 'pack_corrupt', 'inflate: bad dynamic counts');
  throws(() => inflate(dyn(0, 30), 0, { raw: true }), 'pack_corrupt', 'inflate: bad dynamic counts');

  // Code-length symbol 16 as the first length, and symbol 18 repeated past the 258 length slots.
  const repeat = extras => {
    const bits = [];
    const put = (v, n) => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); };
    put(1, 1); put(2, 2); put(0, 5); put(0, 5); put(0, 4);
    for (const n of extras.head) put(n, 3);
    for (const [v, n] of extras.body) put(v, n);
    return packBits(bits);
  };
  throws(() => inflate(repeat({ head: [1, 0, 0, 0], body: [[0, 1]] }), 0, { raw: true }), 'pack_corrupt', 'inflate: repeat with no previous');
  throws(() => inflate(repeat({ head: [0, 0, 1, 0], body: [[0, 1], [127, 7], [0, 1], [127, 7]] }), 0, { raw: true }), 'pack_corrupt', 'inflate: repeat overflow');
  throws(() => inflate(repeat({ head: [0, 0, 1, 0], body: [[0, 1], [127, 7], [0, 1], [120 - 11, 7]] }), 0, { raw: true }), 'pack_corrupt', 'inflate: no end-of-block code');

  // 15 data bits end on the last bit of the buffer, so one more Huffman step has nothing to read.
  const hole = [];
  const putHole = (v, n) => { for (let i = 0; i < n; i++) hole.push((v >> i) & 1); };
  putHole(1, 1); putHole(2, 2); putHole(0, 5); putHole(0, 5); putHole(6, 4);
  for (const n of [0, 0, 0, 1, 1, 0, 0, 0, 0, 0]) putHole(n, 3);
  for (let i = 0; i < 256; i++) putHole(0, 1);
  putHole(1, 1); putHole(0, 1);
  for (let i = 0; i < 15; i++) putHole(1, 1);
  assert.equal(hole.length % 8, 0);
  throws(() => inflate(packBits(hole), 0, { raw: true, maxOutput: 32 }), 'pack_corrupt', 'inflate: invalid huffman code');
});

test('parsePack caps reject a hostile count and inflated total on the boundary', async () => {
  const blob = te.encode('hello');
  const other = te.encode('hello!');
  const { pack } = await buildPack([{ type: TYPE.BLOB, data: blob }]);
  const { pack: two } = await buildPack([{ type: TYPE.BLOB, data: blob }, { type: TYPE.BLOB, data: other }]);
  const emptyBody = Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION, 0, 0, 0, 0);
  const { Sha1 } = await import('../src/sha1.js');
  const emptyPack = concat([emptyBody, new Sha1().update(emptyBody).digest()]);
  const total = blob.length + other.length;

  assert.equal(parsePack(pack, { maxObjects: 1, maxInflatedTotal: blob.length }).objects.length, 1);
  assert.equal(parsePack(emptyPack, { maxObjects: 0, maxInflatedTotal: 0 }).stats.count, 0);
  assert.equal(parsePack(two, { maxObjects: 2, maxInflatedTotal: total }).objects.length, 2);
  throws(() => parsePack(pack, { maxObjects: 0 }), 'limit_exceeded', 'pack objects 1 exceeds limit 0');
  throws(() => parsePack(two, { maxObjects: 1 }), 'limit_exceeded', 'pack objects 2 exceeds limit 1');
  throws(() => parsePack(pack, { maxInflatedTotal: blob.length - 1 }), 'limit_exceeded', `pack inflated bytes ${blob.length} exceeds limit ${blob.length - 1}`);
  throws(() => parsePack(two, { maxInflatedTotal: total - 1 }), 'limit_exceeded', `pack inflated bytes ${total} exceeds limit ${total - 1}`);

  const zero = packParseOpts(withLimits({ maxPackObjects: 0, maxInflatedTotal: 0 }));
  assert.equal(zero.maxObjects, 0);
  assert.equal(zero.maxInflatedTotal, 0);
  assert.equal(zero.limits.maxObjectSize, withLimits({}).maxObjectSize);
  throws(() => parsePack(pack, zero), 'limit_exceeded', 'pack objects 1 exceeds limit 0');

  const positive = packParseOpts({ maxPackObjects: 1, maxInflatedTotal: blob.length, maxObjectSize: blob.length + blob.length });
  assert.equal(positive.maxObjects, 1);
  assert.equal(positive.maxInflatedTotal, blob.length);
  assert.equal(positive.limits.maxObjectSize, blob.length + blob.length);
  assert.equal(parsePack(pack, positive).objects.length, 1);

  const open = packParseOpts();
  assert.equal(open.maxObjects, DEFAULT_LIMITS.maxPackObjects);
  assert.equal(open.maxInflatedTotal, DEFAULT_LIMITS.maxInflatedTotal);
  assert.equal(parsePack(pack, open).stats.inflated, blob.length);
  throws(() => packParseOpts({ maxObjectSize: 1 }), 'bad_request', 'limits.maxPackObjects must be a finite non-negative number');
  throws(() => parsePack(two, { limits: withLimits({ maxPackObjects: 1 }) }), 'limit_exceeded', 'pack objects 2 exceeds limit 1');
  throws(() => parsePack(pack, { maxObjects: Infinity, maxInflatedTotal: blob.length }), 'bad_request', 'limits.maxPackObjects must be a finite non-negative number');
});

function huffCodes(h) {
  const map = new Map();
  let code = 0, index = 0;
  for (let len = 1; len < 16; len++) {
    for (let i = 0; i < h.count[len]; i++) { map.set(h.symbol[index + i], { len, code }); code++; }
    index += h.count[len];
    code <<= 1;
  }
  return map;
}
function packBits(bits) {
  return Uint8Array.from(Array.from({ length: Math.ceil(bits.length / 8) }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((b, v, j) => b | (v << j), 0)));
}

const spanStub = { set() {}, event() {} };
const tracerStub = { span: async (_name, _opts, fn) => fn(spanStub) };

test('every DEFAULT_LIMITS key is read outside limits.js', () => {
  const src = readdirSync('src').filter(f => f.endsWith('.js') && f !== 'limits.js').map(f => readFileSync(join('src', f), 'utf8')).join('\n');
  for (const key of Object.keys(DEFAULT_LIMITS)) assert.match(src, new RegExp(key), key);
  assert.equal(DEFAULT_LIMITS.maxInflatedTotal, DEFAULT_LIMITS.maxObjectSize * 4);
  assert.equal(DEFAULT_LIMITS.maxPackObjects, 100_000);
  assert.equal(DEFAULT_LIMITS.maxLsRefsBytes, DEFAULT_LIMITS.maxPackBytes);
  assert.equal(DEFAULT_LIMITS.maxReportLines, DEFAULT_LIMITS.maxRefs);
  assert.equal(DEFAULT_LIMITS.maxCommitParents, DEFAULT_LIMITS.maxRefs);
  assert.equal(DEFAULT_LIMITS.maxRebaseCommits, DEFAULT_LIMITS.maxRefs);
  throws(() => finiteLimit(Infinity, 'maxObjectSize'), 'bad_request', 'limits.maxObjectSize must be a finite non-negative number');
  throws(() => finiteLimit(-1, 'maxObjectSize'), 'bad_request', 'limits.maxObjectSize must be a finite non-negative number');
  throws(() => requireLimit({}, 'maxInflatedTotal'), 'bad_request', 'limits.maxInflatedTotal must be a finite non-negative number');
  assert.equal(requireLimit({ maxObjectSize: 0 }, 'maxObjectSize'), 0);
});

test('aggregate caps fail closed before allocation', async () => {
  const hostile = new Uint8Array(32);
  hostile.set(PACK_SIGNATURE);
  new DataView(hostile.buffer).setUint32(4, PACK_VERSION);
  new DataView(hostile.buffer).setUint32(8, DEFAULT_LIMITS.maxPackObjects + 1);
  throws(() => parsePack(hostile), 'limit_exceeded', `pack objects ${DEFAULT_LIMITS.maxPackObjects + 1} exceeds limit ${DEFAULT_LIMITS.maxPackObjects}`);

  const hello = te.encode('hi');
  const zhello = new Uint8Array(zlib.deflateSync(hello));
  throws(() => inflate(zhello, 0, { expectedSize: DEFAULT_LIMITS.maxObjectSize + 1 }), 'limit_exceeded', `inflate: expected size ${DEFAULT_LIMITS.maxObjectSize + 1} exceeds limit ${DEFAULT_LIMITS.maxObjectSize}`);
  throws(() => inflate(zhello, 0, { maxOutput: Infinity }), 'bad_request', 'limits.maxObjectSize must be a finite non-negative number');

  const twoEntries = encodeTree([{ mode: '100644', name: 'a', oid: oid(1) }, { mode: '100644', name: 'b', oid: oid(2) }]);
  assert.equal(parseTree(twoEntries, { maxTreeEntries: 2 }).length, 2);
  throws(() => parseTree(twoEntries, { maxTreeEntries: 1 }), 'limit_exceeded', 'tree entries 2 exceeds limit 1');
  throws(() => parseTree(twoEntries, {}), 'bad_request', 'limits.maxTreeEntries must be a finite non-negative number');

  const tree = oid(1);
  const who = 'A <a@b.c> 1 +0000';
  const parents = [oid(2), oid(3)];
  const commit = te.encode(`tree ${tree}\n${parents.map(p => `parent ${p}`).join('\n')}\nauthor ${who}\ncommitter ${who}\n\nm\n`);
  assert.equal(parseCommit(commit, { maxCommitParents: 2 }).parents.length, 2);
  throws(() => parseCommit(commit, { maxCommitParents: 1 }), 'limit_exceeded', 'commit parents 2 exceeds limit 1');
  throws(() => parseCommit(commit, {}), 'bad_request', 'limits.maxCommitParents must be a finite non-negative number');

  const line = s => ({ kind: 'data', payload: te.encode(s) });
  throws(() => v2Step({ ...v2Init(), limits: {} }, line('packfile')), 'bad_request', 'limits.maxSectionLines must be a finite non-negative number');
  let st = v2Step(v2Init(withLimits({ maxSectionLines: 1 })), line('wanted-refs')).state;
  st = v2Step(st, line('abc')).state;
  throws(() => v2Step(st, line('def')), 'limit_exceeded', 'section lines 2 exceeds limit 1');
  st = v2Step(v2Init(withLimits({ maxSectionLines: 1 })), line('acknowledgments')).state;
  st = v2Step(st, { kind: 'delim' }).state;
  throws(() => v2Step(st, line('shallow-info')), 'limit_exceeded', 'section headers 2 exceeds limit 1');
  // one wanted-refs body line under a cap of 2 is still kept
  st = v2Step(v2Init(withLimits({ maxSectionLines: 2 })), line('wanted-refs')).state;
  assert.equal(v2Step(st, line('abc')).state.section, 'wanted-refs');

  throws(() => parseReportStatus(['unpack ok', 'ok refs/heads/a'], { maxReportLines: 1 }), 'limit_exceeded', 'report lines 2 exceeds limit 1');
  assert.equal(parseReportStatus(['unpack ok'], { maxReportLines: 1 }).unpack, 'ok');
  throws(() => parseReportStatus(['unpack ok'], {}), 'bad_request', 'limits.maxReportLines must be a finite non-negative number');

  const base = te.encode('abcd');
  const delta = makeDelta(base, te.encode('abXY')).delta;
  const baseOid = hashObject('blob', base);
  const { pack } = await buildPack([
    { type: TYPE.BLOB, data: delta, baseOid },
    { type: TYPE.BLOB, data: delta, baseOid },
    { type: TYPE.BLOB, data: delta, baseOid },
    { type: TYPE.BLOB, data: base },
  ]);
  const parsed = parsePack(pack);
  assert.equal(resolvePack(parsed).stats.baseLookups, 3);
  assert.throws(() => resolvePack(parsed, undefined, withLimits({ maxInflatedTotal: parsed.stats.inflated + te.encode('abXY').length })), e => e.code === 'limit_exceeded');
  throws(() => applyDelta(base, makeDelta(base, base).delta, { maxResult: Infinity }), 'bad_request', 'limits.maxDeltaResult must be a finite non-negative number');
});

test('idents are branded, wire fields reject breaks, atomic split is ambiguous, ls-refs needs a flush', async () => {
  const person = validateIdent({ name: 'A', email: 'a@b.c', time: 1 });
  assert.equal(isValidatedIdent(person), true);
  assert.equal(person.tz, '+0000');
  assert.equal(ident(person), 'A <a@b.c> 1 +0000');
  throws(() => ident({ name: 'A', email: 'a@b.c', time: 1, tz: '+0000' }), 'bad_request', 'ident: unvalidated identity');
  throws(() => ident({ ...person }), 'bad_request', 'ident: unvalidated identity');
  for (const tz of ['+0000', '-0000', '+0530', '-0530', '+0059', '+1400', '-1200']) validateIdent({ name: 'A', email: 'a@b.c', time: 0, tz });
  for (const tz of ['+1401', '-1230', '+9999', '+1560', '+2400', '0000', '+000', '+00000']) {
    assert.throws(() => validateIdent({ name: 'A', email: 'a@b.c', time: 0, tz }), e => e.code === 'bad_request' && e.what === 'tz', tz);
  }
  throws(() => validateIdent({ name: 'A', email: 'a@b.c', time: -1 }), 'bad_request', 'invalid time: must be a non-negative safe integer');
  throws(() => validateIdent({ name: 'A', email: 'a@b.c', time: 1.5 }), 'bad_request', 'invalid time: must be a non-negative safe integer');
  throws(() => validateIdent({ name: 'A', email: 'a@b.c', time: '1700000000' }), 'bad_request', 'invalid time: must be a non-negative safe integer');
  throws(() => validateIdent({ name: 'A', email: 'a@b.c', time: 0, tz: '+0000\nparent x' }), 'bad_request', 'invalid tz: must be a sign and four digits');

  const tree = oid(1);
  throws(() => encodeCommit({ tree, author: 'A <a@b.c> 1 +0000', committer: 'y\nparent x <a@b.c> 1 +0000' }), 'bad_request', 'committer must not contain NUL or newline');
  throws(() => encodeCommit({ tree, author: 'A <a@b.c> 1 +0000', message: 'a\0b' }), 'bad_request', 'message must not contain NUL');
  assert.ok(encodeCommit({ tree, author: 'A <a@b.c> 1 +0000', message: 'a\nb\n' }).byteLength > 0);
  throws(() => encodeTag({ object: tree, type: 'commit', tag: 'v\n1', tagger: 'A <a@b.c> 1 +0000' }), 'bad_request', 'tag must not contain NUL or newline');

  throws(() => fetchBody({ wants: ['abc\n'] }), 'bad_request', 'invalid want: must be a string without NUL, CR, or LF');
  throws(() => fetchBody({ wants: [oid(1)], deepen: -1 }), 'bad_request', 'invalid deepen: must be a non-negative safe integer');
  throws(() => fetchBody({ wants: [oid(1)], deepenSince: '1\n2' }), 'bad_request', 'invalid deepen-since: must be a string without NUL, CR, or LF');
  throws(() => fetchBody({ wants: [oid(1)], haves: ['a\rb'] }), 'bad_request', 'invalid have: must be a string without NUL, CR, or LF');
  assert.ok(fetchBody({ wants: [oid(1)], deepenSince: 1, filter: 'blob:none', deepen: 1 }).byteLength > 0);
  await assert.rejects(() => negotiate({}, { wants: [oid(1)], haves: [oid(2)], maxRounds: Infinity }), e => e.code === 'bad_request' && e.what === 'maxNegotiateRounds');
  await assert.rejects(() => negotiate({}, { wants: [oid(1)], haves: [oid(2)], batch: 0 }), e => e.code === 'bad_request' && e.what === 'negotiateBatch');

  const commands = [{ ref: 'refs/heads/a' }, { ref: 'refs/heads/b' }];
  const mixed = { unpack: 'ok', refs: [{ ref: 'refs/heads/a', ok: true, reason: '' }, { ref: 'refs/heads/b', ok: false, reason: 'failed to lock' }] };
  assert.equal(checkReport(mixed, commands, { atomic: true }), 'atomic push split: some refs ok, some ng');
  assert.equal(checkReport(mixed, commands), null);

  const refLine = `${oid(4)} refs/heads/main\n`;
  const framesOf = list => ({
    limits: DEFAULT_LIMITS, tracer: tracerStub, parent: null,
    async *frames() { for (const f of list) yield f; },
  });
  await assert.rejects(lsRefs(framesOf([{ kind: 'data', payload: te.encode(refLine) }])), e => e.code === 'protocol' && e.message === 'ls-refs: response ended without the terminating flush-pkt');
  await assert.rejects(lsRefs(framesOf([{ kind: 'data', payload: te.encode(refLine) }, { kind: 'flush' }, { kind: 'data', payload: te.encode(refLine) }])), e => e.code === 'protocol' && e.message === 'ls-refs: data after the terminating flush-pkt');
  await assert.rejects(lsRefs(framesOf([{ kind: 'delim' }])), e => e.code === 'protocol' && e.message === 'ls-refs: unexpected delim in ref listing');
  const listed = await lsRefs(framesOf([{ kind: 'data', payload: te.encode(refLine) }, { kind: 'flush' }]));
  assert.equal(listed.refs.get('refs/heads/main').oid, oid(4));
  // ref names are bytes (#43): a trailing U+FEFF or U+00A0 stays (trim() ate both), two Latin-1 names stay two refs
  const odd = [te.encode(`${oid(1)} refs/heads/x\ufeff\n`), te.encode(`${oid(2)} refs/heads/y\u00a0\n`), Uint8Array.from([...te.encode(`${oid(3)} refs/heads/`), 0xe9, 0x0a]), Uint8Array.from([...te.encode(`${oid(5)} refs/heads/`), 0xe8, 0x0a]), te.encode(`${oid(6)} refs/heads/cr\r\n`)];
  const oddRefs = (await lsRefs(framesOf([...odd.map(payload => ({ kind: 'data', payload })), { kind: 'flush' }]))).refs;
  assert.deepEqual([...oddRefs.keys()], ['refs/heads/x\ufeff', 'refs/heads/y\u00a0', 'refs/heads/\udce9', 'refs/heads/\udce8', 'refs/heads/cr\r']);
  assert.deepEqual(pkt('refs/heads/\udce9'), Uint8Array.from([...te.encode('0010refs/heads/'), 0xe9]));
  await assert.rejects(lsRefs(framesOf([]), ['refs/heads/a\nb']), e => e.code === 'bad_request' && e.what === 'ref prefix');
  const payload = te.encode(refLine);
  await assert.rejects(lsRefs({ ...framesOf([{ kind: 'data', payload }, { kind: 'flush' }]), limits: withLimits({ maxLsRefsBytes: payload.length - 1 }) }), e => e.code === 'limit_exceeded' && e.what === 'ls-refs bytes');

  const reportLines = ['unpack ok\n', 'ok refs/heads/a\n', 'ng refs/heads/b failed to lock\n'];
  const receipt = () => ({
    limits: DEFAULT_LIMITS, tracer: tracerStub, parent: null,
    async *frames() { for (const l of reportLines) yield { kind: 'data', payload: te.encode(l) }; },
  });
  const deletes = [
    { ref: 'refs/heads/a', oldOid: ZERO_OID, newOid: ZERO_OID },
    { ref: 'refs/heads/b', oldOid: ZERO_OID, newOid: ZERO_OID },
  ];
  await assert.rejects(push(receipt(), { commands: deletes, sideband: false, atomic: true }), e => e.code === 'ambiguous' && /atomic push split/.test(e.message));
  await assert.rejects(push(receipt(), { commands: deletes, sideband: false, atomic: false }), e => e.code === 'cas_conflict');
  await assert.rejects(push(receipt(), { commands: [{ ref: 'refs/heads/a\n', oldOid: ZERO_OID, newOid: ZERO_OID }], sideband: false }), e => e.code === 'bad_request' && e.what === 'ref');
  await assert.rejects(push(receipt(), { ref: 'refs/heads/a', oldOid: ZERO_OID, newOid: ZERO_OID, sideband: false, pushOptions: ['a\nb'] }), e => e.code === 'bad_request' && e.what === 'push option');
  await assert.rejects(push({ ...receipt(), limits: withLimits({ maxRefs: 1 }) }, { commands: deletes, sideband: false }), e => e.code === 'limit_exceeded' && e.what === 'push commands');

  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    // The request timer is unref'd, so a live socket (here, an interval) has to keep the loop awake.
    const keep = setInterval(() => {}, 50);
    init.signal.addEventListener('abort', () => { clearInterval(keep); reject(init.signal.reason); });
  });
  const http = createTransport('http://127.0.0.1:9/r.git', { fetchImpl, limits: withLimits({ requestTimeoutMs: 40 }), tracer: tracerStub });
  const t0 = Date.now();
  await assert.rejects((async () => { for await (const frame of http.frames('git-upload-pack', new Uint8Array(0), spanStub)) void frame; })(), e => e.code === 'timeout');
  assert.ok(Date.now() - t0 < 2000);

  assert.throws(() => createTransport('http://127.0.0.1/r.git', { userAgent: 'ply\r\nX: 1' }), e => e.code === 'bad_request' && e.what === 'user agent');
  assert.throws(() => createTransport('http://127.0.0.1/r.git', { auth: { bearer: 'tok\n' } }), e => e.code === 'bad_request' && e.what === 'bearer');
  let pulls = 0;
  const advBody = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(1000)); if (pulls > 8) controller.close(); } });
  const advHttp = createTransport('http://127.0.0.1:9/r.git', {
    fetchImpl: async () => new Response(advBody, { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } }),
    limits: withLimits({ maxPackBytes: 2500 }), tracer: tracerStub,
  });
  await assert.rejects(advHttp.advertise('git-upload-pack', spanStub), e => e.code === 'limit_exceeded' && e.what === 'advertisement bytes' && e.got > 2500);
  assert.ok(pulls <= 4, `advertisement kept reading (${pulls} chunks)`);
  const declared = createTransport('http://127.0.0.1:9/r.git', {
    fetchImpl: async () => ({
      ok: true, status: 200,
      headers: { get: n => (n === 'content-type' ? 'application/x-git-upload-pack-advertisement' : n === 'content-length' ? '999999999' : null) },
      body: { async *[Symbol.asyncIterator]() { throw new Error('body should not be read'); }, async cancel() {} },
    }),
    limits: withLimits({ maxPackBytes: 2500 }), tracer: tracerStub,
  });
  await assert.rejects(declared.advertise('git-upload-pack', spanStub), e => e.code === 'limit_exceeded' && e.what === 'advertisement bytes' && e.got === 999999999);
  let errPulls = 0;
  const errBody = new ReadableStream({ pull(controller) { errPulls++; controller.enqueue(te.encode('x'.repeat(3000))); if (errPulls > 6) controller.close(); } });
  const errHttp = createTransport('http://127.0.0.1:9/r.git', {
    fetchImpl: async () => new Response(errBody, { status: 500, headers: { 'content-type': 'text/plain' } }),
    limits: withLimits({ requestTimeoutMs: 2000 }), tracer: tracerStub,
  });
  await assert.rejects((async () => { for await (const frame of errHttp.frames('git-upload-pack', new Uint8Array(0), spanStub)) void frame; })(), e => e.code === 'upstream_5xx' && e.message.includes('xxx'));
  assert.ok(errPulls <= 3, `error body kept reading (${errPulls} chunks)`);
  assert.throws(() => createSshTransport('ssh://git@h/r.git', { hostKey: new Uint8Array(32), limits: {}, connect() { throw new Error('connect'); } }), e => e.code === 'bad_request' && e.what === 'requestTimeoutMs');
  assert.throws(() => createSshTransport('ssh://git@h/r.git', { hostKey: new Uint8Array(32), user: 'a\nb' }), e => e.code === 'bad_request' && e.what === 'ssh user');
});

test('encodeTree duplicate names and the pre-send push size refusal (issue #11)', async () => {
  const blob = oid(1), dir = oid(2);
  throws(() => encodeTree([{ mode: '100644', name: 'a', oid: blob }, { mode: '100644', name: 'a', oid: blob }]), 'bad_request', 'tree: duplicate entry "a"');
  throws(() => encodeTree([{ mode: '100644', name: 'a', oid: blob }, { mode: '100644', name: 'a.b', oid: blob }, { mode: '40000', name: 'a', oid: dir }]), 'bad_request', 'tree: duplicate entry "a"');
  assert.equal(encodeTree([{ mode: '100644', name: 'README', oid: blob }, { mode: '100644', name: 'readme', oid: blob }]).length, 2 * (OID_BYTES + 'README'.length + '100644 \0'.length), 'case-only twins are two names');
  let sent = 0;
  const t = { limits: withLimits({ maxPackBytes: 40 }), tracer: tracerStub, parent: null, async *frames() { sent++; for (const f of []) yield f; } };
  const objects = [{ type: TYPE.BLOB, data: te.encode('x'.repeat(64)) }];
  await assert.rejects(push(t, { ref: 'refs/heads/a', oldOid: ZERO_OID, newOid: oid(3), objects, sideband: false }), e => e.code === 'limit_exceeded' && e.what === 'push pack bytes' && e.max === 40 && e.got > 40);
  assert.equal(sent, 0, 'nothing reached the transport');
  const fits = { ...t, limits: withLimits({ maxPackBytes: 1 << 20 }) };
  await assert.rejects(push(fits, { ref: 'refs/heads/a', oldOid: ZERO_OID, newOid: oid(3), objects, sideband: false }), e => e.code === 'ambiguous');
  assert.equal(sent, 1, 'under the cap the body is sent');
});

test('size varints stop at 64 bits: a header that never ends is pack_corrupt at its 11th byte, never a NaN size (#13)', () => {
  const ones = n => new Uint8Array(n).fill(0x80);
  // ten bytes is the longest legal object header (4 + 9 × 7 bits), and every size it can carry is finite
  assert.deepEqual(readObjHeader(concat([Uint8Array.of(0xb0), ones(8), Uint8Array.of(0)]), 0), { type: TYPE.BLOB, size: 0, next: 10 });
  assert.ok(Number.isFinite(readObjHeader(concat([Uint8Array.of(0xbf), new Uint8Array(8).fill(0xff), Uint8Array.of(0x7f)]), 0).size));
  throws(() => readObjHeader(concat([Uint8Array.of(0xb0), ones(9), Uint8Array.of(0)]), 0), 'pack_corrupt', 'pack: size varint longer than 64 bits');
  // the probe: 200 continuation bytes used to decode to NaN, which every `size > limit` check lets through
  throws(() => readObjHeader(concat([Uint8Array.of(0xb0), ones(200), Uint8Array.of(0)]), 0), 'pack_corrupt', 'pack: size varint longer than 64 bits');
  throws(() => parsePack(concat([Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION, 0, 0, 0, 1, 0xb0), ones(200), new Uint8Array(40)])), 'pack_corrupt', 'pack: size varint longer than 64 bits');

  // a delta size may take ten groups (bits 0..69); the tenth starts at bit 63, the eleventh is refused
  assert.deepEqual([...applyDelta(new Uint8Array(0), concat([ones(9), Uint8Array.of(0, 1, 1, 0x41)])).out], [0x41]);
  assert.throws(() => applyDelta(new Uint8Array(0), concat([Uint8Array.of(0), new Uint8Array(9).fill(0xff), Uint8Array.of(1, 1, 0x41)])), e => e.code === 'limit_exceeded' && /^delta result size \d+ exceeds limit/.test(e.message));
  throws(() => applyDelta(new Uint8Array(0), concat([ones(10), Uint8Array.of(0, 1, 1, 0x41)])), 'pack_corrupt', 'delta: size varint longer than 64 bits');
  // the probe: an over-long result size was NaN; NaN passed the limit, and the copy ended in an untyped RangeError
  const base = Uint8Array.of(9, 8, 7);
  throws(() => applyDelta(base, concat([encodeVarint(base.length), ones(200), Uint8Array.of(0, DELTA_COPY | DELTA_COPY_OFF1 | DELTA_COPY_LEN1, 0, 3)])), 'pack_corrupt', 'delta: size varint longer than 64 bits');

  // the streamed single-object parser: its header phase holds ≤ 21 bytes, for every caller (fetchSingle, edit, read, checkout)
  const packHead = Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION, 0, 0, 0, 1, 0xb0);
  let sp = spInit(), held = 0;
  for (const b of concat([packHead, ones(8)])) { sp = spStep(sp, Uint8Array.of(b)).state; held = Math.max(held, sp.head.length); }
  assert.equal(sp.phase, 'header');
  assert.equal(held, PACK_HEADER_BYTES + 9);
  throws(() => spStep(sp, Uint8Array.of(0x80)), 'pack_corrupt', 'pack: size varint longer than 64 bits');
  assert.equal(spStep(sp, Uint8Array.of(0)).state.phase, 'body');
  throws(() => spStep(spInit(), concat([packHead, ones(1 << 20)])), 'pack_corrupt', 'pack: size varint longer than 64 bits');
});
