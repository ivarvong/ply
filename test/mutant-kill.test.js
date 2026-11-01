// Branch and message assertions for the mutation gate. Prefix and round-trip tests kill the happy path;
// these kill a mutant that deletes one check, flips one comparison, or empties one error string.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { take, indexOfBytes, bytesOf, te, td, concat, decodeBytes, encodeBytes, decodeChunk, bufferSource } from '../src/bytes.js';
import {
  parseTree, parseCommit, parseTag, parseIdent, assertFetched, encodeTree, encodeCommit, encodeTag, TYPE, hashObject, ident,
} from '../src/objects.js';
import { pkt, pktInit, pktStep, pktFinish, FLUSH, DELIM } from '../src/pktline.js';
import {
  parsePack, applyDelta, makeDelta, readObjHeader, readOfsDelta, readUint32BE, packParseOpts, resolvePack,
} from '../src/packresolve.js';
import { encodeObjHeader, encodeVarint, buildPack, zlibDeflate, copyOp } from '../src/pack.js';
import { huffBuild, adler32 } from '../src/inflate.js';
import { inflate, cappedBound, declaredBound, zlibWrap, rawWrap } from '../src/inflatestream.js';
import { v2Init, v2Step, parseSideband, spInit, spStep, spFinish, fetchBody, isShortRead } from '../src/fetch.js';
import { attributeTree, bestBases, mergeBase, mergeBranch } from '../src/merge.js';
import { rebaseBranch } from '../src/rebase.js';
import { Tracer } from '../src/otel.js';
import { parseLsRefLine, parseUnbornLine, lsRefs, lsRefsBody } from '../src/lsrefs.js';
import { lsRefs as lsRefsAsked } from '../src/client.js';
import { classifyReport, reportInit, reportStep, reportFinish, decideOutcome, outcomeResult, ngClass, planPush, requestCaps, streamInit, streamStep, GIT_UNPACK_ERRORS, push, ZERO_OID } from '../src/push.js';
import { checkPushCaps, capsProblem, parseReceiveAdvert, pushWithOptions } from '../src/receivecaps.js';
import { orThrow } from '../src/errors.js';
import { parseLine, parseFile, UNSET } from '../src/attributes.js';
import { withGpgsig } from '../src/sign.js';
import { withLimits, DEFAULT_LIMITS, requireLimit, finiteLimit } from '../src/limits.js';
import { validateIdent, isValidatedIdent, validatePushRef } from '../src/validate.js';
import { createTransport } from '../src/http.js';
import { verifyRef } from '../src/operation.js';
import { negotiate } from '../src/negotiate.js';
import { parseOid, parseCommitId } from '../src/oid.js';
import {
  OID_BYTES, OID_HEX_CHARS, HEX_DIGIT_MIN, HEX_DIGIT_MAX, HEX_LOWER_MIN, HEX_LOWER_MAX, PACK_SIGNATURE, PACK_HEADER_BYTES, PACK_VERSION,
  DELTA_COPY, DELTA_COPY_OFF1, DELTA_COPY_OFF2, DELTA_COPY_OFF3, DELTA_COPY_OFF4,
  DELTA_COPY_LEN1, DELTA_COPY_LEN2, DELTA_COPY_LEN3, DELTA_SIZE_MIN, SIDEBAND_PACK, SIDEBAND_PROGRESS, zlibBound,
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
    ['100644 .git:x\0', 'tree: bad name'],
    ['100644 a\\.git\0', 'tree: bad name'],
    [`100644 ${'l'.repeat(4097)}\0`, 'tree: large pathname'],
    ['120000 .gitmodules\0', 'tree: .gitmodules is a symbolic link'],
    ['40000 GITMOD~1\0', 'tree: .gitmodules is not a blob'],
    ['160000 .gitmodules\0', 'tree: .gitmodules is not a blob'],
    ['160000 .gitattributes\0', 'tree: .gitattributes is not a blob'],
    ['40000 .gitattributes\0', 'tree: .gitattributes is not a blob'],
  ];
  for (const [text, message] of bad) throws(() => parseTree(raw(text)), 'pack_corrupt', message);
  throws(() => parseTree(raw('100644 a\0', id.subarray(0, OID_BYTES - 1))), 'pack_corrupt', `short read: need ${OID_BYTES} bytes at ${'100644 a\0'.length}, have ${'100644 a\0'.length + OID_BYTES - 1}`);
  throws(() => parseTree(data(raw('100644 b\0'), raw('100644 a\0'))), 'pack_corrupt', 'tree: not strictly sorted');
  throws(() => parseTree(data(raw('100644 a\0'), raw('100644 a\0', oidBytes(5)))), 'pack_corrupt', 'tree: duplicate entry "a"');
  assert.equal(parseTree(new Uint8Array(0)).length, 0);
  // canon_mode, as git ls-tree prints it; a 4096-byte name is the longest fsck allows
  assert.equal(parseTree(raw('100664 a\0'))[0].mode, '100644');
  assert.equal(parseTree(raw(`100644 ${'l'.repeat(4096)}\0`))[0].name.length, 4096);
  throws(() => parseTree(raw('100644 a\0', new Uint8Array(OID_BYTES))), 'pack_corrupt', 'tree: null sha1');
  assert.equal(parseTree(raw('100644 a\0', Uint8Array.of(...new Uint8Array(OID_BYTES - 1), 1)))[0].name, 'a');
  for (const ok of ['120000 .gitattributes', '120000 .gitignore', '120000 .mailmap', '100644 .gitmodules', '100644 git~2', '40000 a\\.gitattributes']) assert.equal(parseTree(raw(`${ok}\0`)).length, 1, ok);
  // issue #34: one name twice is git fsck duplicateEntries whatever the modes, next to each other or not. A file and a
  // directory of one name sort apart ('d' < 'd.x' < 'd/'), so the old neighbour-only check passed them. encodeTree
  // refuses to write such a tree, so the bytes are built by hand.
  const e = (mode, name, n = 1) => raw(`${mode} ${name}\0`, oidBytes(n));
  throws(() => parseTree(data(e('100644', 'd', 2), e('40000', 'd'))), 'pack_corrupt', 'tree: duplicate entry "d"');
  throws(() => parseTree(data(e('100644', 'd', 2), e('100644', 'd.x'), e('40000', 'd'))), 'pack_corrupt', 'tree: duplicate entry "d"');
  throws(() => parseTree(data(e('120000', 'd', 2), e('100644', 'd-'), e('100644', 'd.x'), e('40000', 'd'))), 'pack_corrupt', 'tree: duplicate entry "d"');
  throws(() => parseTree(data(e('160000', 'd', 2), e('40000', 'd'))), 'pack_corrupt', 'tree: duplicate entry "d"');
  throws(() => parseTree(data(e('40000', 'd', 2), e('40000', 'd'))), 'pack_corrupt', 'tree: duplicate entry "d"');
  // the same name in a later, unrelated position is still the duplicate, reported before the order it also breaks
  throws(() => parseTree(data(e('100644', 'a'), e('100644', 'b'), e('100644', 'a'))), 'pack_corrupt', 'tree: duplicate entry "a"');
  // order: a directory sorts as name + '/'. S_ISDIR of the mode decides, as in fsck: `40755` is a directory, a gitlink
  // is not. Either way round, one of the two lists is out of order.
  assert.deepEqual(parseTree(data(e('100644', 'd.x'), e('40000', 'd'))).map(x => x.name), ['d.x', 'd']);
  throws(() => parseTree(data(e('40000', 'd'), e('100644', 'd.x'))), 'pack_corrupt', 'tree: not strictly sorted');
  assert.deepEqual(parseTree(data(e('100644', 'd.x'), e('40755', 'd'))).map(x => x.mode), ['100644', '40000'], 'canon_mode: 40755 reads as a tree');
  throws(() => parseTree(data(e('40755', 'd'), e('100644', 'd.x'))), 'pack_corrupt', 'tree: not strictly sorted');
  // fsck keeps the mode in an unsigned short: `1040000` is a directory there, `140000` (S_IFSOCK) is not
  assert.deepEqual(parseTree(data(e('100644', 'd.x'), e('1040000', 'd'))).map(x => x.name), ['d.x', 'd'], 'only the low 16 bits of a mode count');
  throws(() => parseTree(data(e('1040000', 'd'), e('100644', 'd.x'))), 'pack_corrupt', 'tree: not strictly sorted');
  assert.deepEqual(parseTree(data(e('140000', 'd'), e('100644', 'd.x'))).map(x => x.name), ['d', 'd.x']);
  // past 2^53 a whole-string parse loses the low bits; the last six digits keep them
  assert.deepEqual(parseTree(data(e('100644', 'd.x'), e('777777777777777777777777040000', 'd'))).map(x => x.name), ['d.x', 'd'], 'a long mode is read from its last six digits');
  assert.deepEqual(parseTree(data(e('100644', 'd'), e('160000', 'd.x'))).map(x => x.mode), ['100644', '160000']);
  throws(() => parseTree(data(e('100644', 'd.x'), e('160000', 'd'))), 'pack_corrupt', 'tree: not strictly sorted');
  assert.deepEqual(parseTree(data(e('40000', 'd'), e('100644', 'd0'))).map(x => x.name), ['d', 'd0'], "'/' sorts below '0'");
  throws(() => parseTree(data(e('100644', 'd0'), e('40000', 'd'))), 'pack_corrupt', 'tree: not strictly sorted');
  // case-only and NFC/NFD twins are two names to git and to ply
  assert.deepEqual(parseTree(data(e('100644', 'D'), e('100644', 'd'))).map(x => x.name), ['D', 'd']);
  assert.deepEqual(parseTree(data(e('100644', 'e\u0301'), e('100644', '\u00e9'))).map(x => x.name), ['e\u0301', '\u00e9']);
  // order is on the raw bytes; byte-distinct names stay distinct (decodeBytes is lossless, #43), so the decode-twin refusal
  // #34 had (U+FFFD twins, a dropped leading BOM) cannot arise and is gone: these parse as two names, as in git
  const rawE = (mode, bytes) => data(te.encode(`${mode} `), Uint8Array.from(bytes), Uint8Array.of(0), oidBytes(1));
  throws(() => parseTree(data(rawE('100644', [0x64, 0xff]), rawE('100644', [0x64, 0xfe]))), 'pack_corrupt', 'tree: not strictly sorted');
  assert.deepEqual(parseTree(data(rawE('100644', [0x64, 0xfe]), rawE('100644', [0x64, 0xff]))).map(x => x.name), ['d\udcfe', 'd\udcff']);
  assert.deepEqual(parseTree(data(rawE('100644', [0x61]), rawE('100644', [0xef, 0xbb, 0xbf, 0x61]))).map(x => x.name), ['a', '\ufeffa']);
  assert.deepEqual(parseTree(data(rawE('100644', [0x64, 0xc3, 0xa9]), rawE('100644', [0x64, 0xff]))).map(x => x.name), ['d\u00e9', 'd\udcff'], 'raw bytes: 0xc3 < 0xff (0xff decodes to its escape U+DCFF, #43)');
  assert.deepEqual(parseTree(data(rawE('100644', [0x64, 0xef, 0xbf, 0xbe]), rawE('100644', [0x64, 0xf0]))).map(x => x.name.length), [2, 2]);
  throws(() => parseTree(data(rawE('100644', [0x64, 0xf0]), rawE('100644', [0x64, 0xef, 0xbf, 0xbe]))), 'pack_corrupt', 'tree: not strictly sorted');
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

// bufferSource is the BufferSource boundary (bytes.ts): an ArrayBuffer view is returned as itself, and a
// SharedArrayBuffer view is copied into a fresh ArrayBuffer. Both arms have to be observed or the copy is uncovered.
test('bufferSource keeps an ArrayBuffer view and copies a SharedArrayBuffer view', () => {
  const own = Uint8Array.of(1, 2, 3, 4);
  assert.equal(bufferSource(own), own);
  assert.ok(bufferSource(own).buffer instanceof ArrayBuffer);
  const wide = new Uint8Array([9, 8, 7, 6, 5]);
  const view = wide.subarray(1, 4);
  assert.equal(bufferSource(view), view);
  assert.deepEqual([...bufferSource(view)], [8, 7, 6]);
  const empty = new Uint8Array(0);
  assert.equal(bufferSource(empty), empty);
  const shared = new Uint8Array(new SharedArrayBuffer(4));
  shared.set([9, 8, 7, 6]);
  const copy = bufferSource(shared);
  assert.notEqual(copy, shared);
  assert.ok(copy.buffer instanceof ArrayBuffer);
  assert.ok(!(copy.buffer instanceof SharedArrayBuffer));
  assert.deepEqual([...copy], [9, 8, 7, 6]);
  copy[0] = 1;
  assert.equal(shared[0], 9);
  const sharedEmpty = new Uint8Array(new SharedArrayBuffer(0));
  const emptyCopy = bufferSource(sharedEmpty);
  assert.notEqual(emptyCopy, sharedEmpty);
  assert.equal(emptyCopy.byteLength, 0);
  assert.ok(emptyCopy.buffer instanceof ArrayBuffer);
});

test('commit and tag headers, idents, and assertFetched', () => {
  const author = 'Ada <ada@ex> 1700000000 +0000';
  const tree = oid(1);
  const C = 'commit: ', T = 'tag: ';
  // verify_headers: a NUL before the blank line, and a header that does not end in a newline
  throws(() => parseCommit(te.encode('tree')), 'pack_corrupt', `${C}unterminatedHeader: unterminated header`);
  throws(() => parseCommit(new Uint8Array(0)), 'pack_corrupt', `${C}unterminatedHeader: unterminated header`);
  throws(() => parseCommit(te.encode(`tree ${tree}\0\n\n`)), 'pack_corrupt', `${C}nulInHeader: unterminated header: NUL at offset 45`);
  throws(() => parseCommit(te.encode('\0')), 'pack_corrupt', `${C}nulInHeader: unterminated header: NUL at offset 0`);
  throws(() => parseCommit(te.encode('nospace\n')), 'pack_corrupt', `${C}missingTree: invalid format - expected 'tree' line`);
  throws(() => parseCommit(te.encode('\n\nbody')), 'pack_corrupt', `${C}missingTree: invalid format - expected 'tree' line`);
  throws(() => parseCommit(te.encode(`tree\n${tree}\n`)), 'pack_corrupt', `${C}missingTree: invalid format - expected 'tree' line`);
  throws(() => parseCommit(te.encode(`tree ${tree}\n`)), 'pack_corrupt', `${C}missingAuthor: invalid format - expected 'author' line`);
  throws(() => parseCommit(te.encode(`tree ${tree}\n parent-sig\n\n`)), 'pack_corrupt', `${C}missingAuthor: invalid format - expected 'author' line`);
  throws(() => parseCommit(te.encode(`tree ${tree}\nauthor ${author}\n`)), 'pack_corrupt', `${C}missingCommitter: invalid format - expected 'committer' line`);
  // the tree and parent ids: 40 hex digits of either case, then the newline; git prints the id lowercase
  throws(() => parseCommit(te.encode(`tree zz\nauthor ${author}\ncommitter ${author}\n\n`)), 'pack_corrupt', `${C}badTreeSha1: invalid 'tree' line format - bad sha1`);
  throws(() => parseCommit(te.encode(`tree ${tree.slice(1)}g\nauthor ${author}\ncommitter ${author}\n\n`)), 'pack_corrupt', `${C}badTreeSha1: invalid 'tree' line format - bad sha1`);
  throws(() => parseCommit(te.encode(`tree ${tree} \nauthor ${author}\ncommitter ${author}\n\n`)), 'pack_corrupt', `${C}badTreeSha1: invalid 'tree' line format - bad sha1`);
  throws(() => parseCommit(te.encode(`tree ${tree.slice(1)}\nauthor ${author}\ncommitter ${author}\n\n`)), 'pack_corrupt', `${C}badTreeSha1: invalid 'tree' line format - bad sha1`);
  throws(() => parseCommit(te.encode(`tree ${tree}\nparent zz\nauthor ${author}\ncommitter ${author}\n\n`)), 'pack_corrupt', `${C}badParentSha1: invalid 'parent' line format - bad sha1`);
  throws(() => parseCommit(te.encode(`tree ${tree}\nparent ${oid(2)}x\nauthor ${author}\ncommitter ${author}\n\n`)), 'pack_corrupt', `${C}badParentSha1: invalid 'parent' line format - bad sha1`);
  const upper = parseCommit(te.encode(`tree ${'AB'.repeat(20)}\nparent ${'Cd'.repeat(20)}\nauthor ${author}\ncommitter ${author}\n\n`));
  assert.equal(upper.tree, 'ab'.repeat(20));
  assert.deepEqual(upper.parents, ['cd'.repeat(20)]);
  assert.equal(parseCommit(te.encode(`tree ${'9f'.repeat(20)}\nauthor ${author}\ncommitter ${author}\n`)).tree, '9f'.repeat(20));
  throws(() => parseCommit(te.encode(`tree ${tree}\nauthor ${author}\nauthor ${author}\ncommitter ${author}\n\n`)), 'pack_corrupt', `${C}multipleAuthors: invalid format - multiple 'author' lines`);
  throws(() => parseCommit(te.encode(`tree ${tree}\nauthor Ada\ncommitter ${author}\n\n`)), 'pack_corrupt', `${C}missingEmail: invalid author line - missing email`);
  throws(() => parseCommit(te.encode(`tree ${tree}\nauthor ${author}\ncommitter Ada\n\n`)), 'pack_corrupt', `${C}missingEmail: invalid committer line - missing email`);
  throws(() => parseCommit(te.encode(`tree ${tree}\nauthor Ada <ada@ex>\ncommitter ${author}\n\n`)), 'pack_corrupt', `${C}missingSpaceBeforeDate: invalid author line - missing space before date`);
  // the body: no NUL anywhere in a commit (nulInCommit is WARN, an error under --strict)
  throws(() => parseCommit(te.encode(`tree ${tree}\nauthor ${author}\ncommitter ${author}\n\nsub\0ject\n`)), 'pack_corrupt', `${C}nulInCommit: NUL byte in the commit object body`);
  throws(() => parseCommit(te.encode(`tree ${tree}\nauthor ${author}\ncommitter ${author}\n\n\0`)), 'pack_corrupt', `${C}nulInCommit: NUL byte in the commit object body`);
  const cont = parseCommit(te.encode(`tree ${tree}\nauthor ${author}\ncommitter ${author}\n parent-sig\n\n`));
  assert.deepEqual(cont.extra, [' parent-sig']);
  assert.equal(cont.encoding, null);
  assert.equal(cont.message, '');
  const noBody = parseCommit(te.encode(`tree ${tree}\nauthor ${author}\ncommitter ${author}\nsubject\n`));
  assert.deepEqual(noBody.extra, ['subject']);
  assert.equal(noBody.message, null);
  assert.deepEqual(parseCommit(te.encode(`tree ${tree}\nauthor ${author}\ncommitter ${author}\n`)).extra, []);
  assert.equal(parseCommit(te.encode(`tree ${tree}\nauthor ${author}\ncommitter ${author}\n\n\nm`)).message, '\nm');
  // a leading BOM is a byte before `tree`, as git reads it
  throws(() => parseCommit(concat([Uint8Array.of(0xef, 0xbb, 0xbf), te.encode(`tree ${tree}\nauthor ${author}\ncommitter ${author}\n\n`)])), 'pack_corrupt', `${C}missingTree: invalid format - expected 'tree' line`);

  const commit = encodeCommit({ tree, parents: [oid(2)], author, message: 'hi\n' });
  assert.equal(parseCommit(commit).tree, tree);
  assert.deepEqual(parseCommit(commit).parents, [oid(2)]);
  assertFetched('commit', commit);
  throws(() => assertFetched('commit', te.encode(`author ${author}\ncommitter ${author}\n\n`)), 'pack_corrupt', `${C}missingTree: invalid format - expected 'tree' line`);
  assert.equal(assertFetched('blob', te.encode('x')), undefined);
  assert.equal(assertFetched('ofs_delta', te.encode('x')), undefined);
  assert.equal(assertFetched('ref_delta', te.encode('x')), undefined);
  throws(() => assertFetched('submodule', te.encode('x')), 'pack_corrupt', 'object: bad type submodule');
  throws(() => assertFetched('tree', data(' a\0', oidBytes(1))), 'pack_corrupt', 'tree: empty mode');
  throws(() => assertFetched('tag', te.encode('x')), 'pack_corrupt', `${T}unterminatedHeader: unterminated header`);

  const tagger = author;
  const tag = encodeTag({ object: oid(3), type: 'commit', tag: 'v1', tagger, message: 'rel\n' });
  assert.equal(parseTag(tag).tag, 'v1');
  assertFetched('tag', tag);
  throws(() => parseTag(te.encode('tag')), 'pack_corrupt', `${T}unterminatedHeader: unterminated header`);
  throws(() => parseTag(te.encode(`object ${oid(3)}\0\n`)), 'pack_corrupt', `${T}nulInHeader: unterminated header: NUL at offset 47`);
  throws(() => parseTag(te.encode('\n\n')), 'pack_corrupt', `${T}missingObject: invalid format - expected 'object' line`);
  throws(() => parseTag(te.encode(`type commit\ntag v1\ntagger ${tagger}\n\n`)), 'pack_corrupt', `${T}missingObject: invalid format - expected 'object' line`);
  throws(() => parseTag(te.encode(`object ${oid(3).slice(2)}\ntype commit\n\n`)), 'pack_corrupt', `${T}badObjectSha1: invalid 'object' line format - bad sha1`);
  throws(() => parseTag(te.encode(`object ${oid(3)}\n\n`)), 'pack_corrupt', `${T}missingTypeEntry: invalid format - expected 'type' line`);
  throws(() => parseTag(te.encode(`object ${oid(3)}\ntag v1\ntagger ${tagger}\n\n`)), 'pack_corrupt', `${T}missingTypeEntry: invalid format - expected 'type' line`);
  for (const bad of ['commi', '', 'commit ', 'Commit', 'ofs_delta', 'constructor', 'toString'])
    throws(() => parseTag(te.encode(`object ${oid(3)}\ntype ${bad}\ntag v1\n\n`)), 'pack_corrupt', `${T}badType: invalid 'type' value`);
  for (const type of ['commit', 'tree', 'blob', 'tag']) assert.equal(parseTag(te.encode(`object ${oid(3)}\ntype ${type}\ntag v1\n`)).type, type);
  throws(() => parseTag(te.encode(`object ${oid(3)}\ntype commit\n\n`)), 'pack_corrupt', `${T}missingTagEntry: invalid format - expected 'tag' line`);
  throws(() => parseTag(te.encode(`object ${oid(3)}\ntype commit\ntagger ${tagger}\n\n`)), 'pack_corrupt', `${T}missingTagEntry: invalid format - expected 'tag' line`);
  throws(() => parseTag(te.encode(`object ${oid(3)}\ntype commit\ntag v1\ntagger Ada\n\n`)), 'pack_corrupt', `${T}missingEmail: invalid tagger line - missing email`);
  // INFO under --strict, so accepted: no tagger (missingTaggerEntry) and a name that is not a refname (badTagName)
  const old = parseTag(te.encode(`object ${oid(3)}\ntype commit\ntag v0.99\n\nold\n`));
  assert.equal(old.tagger, null);
  assert.equal(old.message, 'old\n');
  assert.deepEqual(old.extra, []);
  assert.deepEqual(parseTag(te.encode(`object ${oid(3)}\ntype commit\ntag v1\nfoo bar\n\n`)).extra, ['foo bar']);
  assert.equal(parseTag(te.encode(`object ${oid(3)}\ntype commit\ntag \ntagger ${tagger}\n\n`)).tag, '');
  assert.equal(parseTag(te.encode(`object ${oid(3)}\ntype commit\ntag v1..2\ntagger ${tagger}\n\n`)).tag, 'v1..2');
  // fsck never reads a tag's body: a NUL there is accepted, unlike in a commit
  assert.equal(parseTag(te.encode(`object ${oid(3)}\ntype commit\ntag v1\ntagger ${tagger}\n\nr\0l\n`)).message, 'r\0l\n');
  assert.equal(parseTag(te.encode(`object ${'AB'.repeat(20)}\ntype commit\ntag v1\n`)).object, 'ab'.repeat(20));

  assert.equal(parseIdent(1), null);
  assert.deepEqual(parseIdent('  bare name  '), { name: 'bare name', email: '', time: null, tz: '' });
  assert.deepEqual(parseIdent('foo >bar'), { name: 'foo >bar', email: '', time: null, tz: '' });
  assert.deepEqual(parseIdent('<ada@ex> 1700000000 +0000'), { name: '', email: 'ada@ex', time: '1700000000', tz: '+0000' });
  assert.deepEqual(parseIdent(' Ada <ada@ex> 1700000000 +0000'), { name: ' Ada', email: 'ada@ex', time: '1700000000', tz: '+0000' });
  assert.deepEqual(parseIdent('Ada  <ada@ex> nope +0100'), { name: 'Ada', email: 'ada@ex', time: null, tz: '+0100' });
});

test('headers after the committer and the tagger are kept, not judged, except a second copy (PR #7)', () => {
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
  assert.equal(ok.message, 'msg\n');
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
  // after the committer fsck reads nothing, but a second tree, parent, author, committer or encoding is a copy git's
  // views disagree on (pretty's %an/%cn read the last, %T and the date the first): refused, typed (PR #7)
  const after = (...lines) => parseCommit(body([`tree ${tree}`, `author ${author}`, `committer ${committer}`, ...lines]));
  const dup = (label, lines) => assert.throws(() => after(...lines), e => e.code === 'pack_corrupt' && e.message === label && e.msgId === 'duplicateHeader');
  dup('commit: duplicate tree', [`tree ${tree2}`]);
  dup('commit: duplicate tree', ['gpgsig x', `tree ${tree2}`]);
  dup('commit: bad header order', [`parent ${oid(3)}`]);
  dup('commit: duplicate author', [`author ${other}`]);
  dup('commit: duplicate author', ['encoding UTF-8', `author ${other}`]);
  dup('commit: duplicate committer', [`committer ${other}`]);
  dup('commit: duplicate committer', ['committer garbage']);
  dup('commit: duplicate encoding', ['encoding ISO-8859-1', 'encoding UTF-8']);
  dup('commit: duplicate encoding', ['encoding ISO-8859-1', 'gpgsig x', 'encoding UTF-8']);
  assert.deepEqual(after('foo').extra, ['foo']);
  assert.deepEqual(after('treehouse x', 'authors y', ' tree z').extra, ['treehouse x', 'authors y', ' tree z']);
  assert.equal(after('gpgsig x', ' y', 'encoding ISO-8859-1').encoding, 'ISO-8859-1');
  assert.equal(after(' encoding ISO-8859-1').encoding, null);
  assert.equal(after('encodingISO').encoding, null);
  // before the committer, the order is fsck's: tree, parents, one author, committer
  const bad = (lines, msgId, why) => throws(() => parseCommit(body(lines)), 'pack_corrupt', `commit: ${msgId}: ${why}`);
  const noAuthor = ['missingAuthor', "invalid format - expected 'author' line"];
  const noCommitter = ['missingCommitter', "invalid format - expected 'committer' line"];
  bad([`parent ${oid(3)}`, `tree ${tree}`, `author ${author}`, `committer ${committer}`], 'missingTree', "invalid format - expected 'tree' line");
  bad([`author ${author}`, `tree ${tree}`, `committer ${committer}`], 'missingTree', "invalid format - expected 'tree' line");
  bad([`tree ${tree}`, `tree ${tree2}`, `author ${author}`, `committer ${committer}`], ...noAuthor);
  bad([`tree ${tree}`, `committer ${committer}`], ...noAuthor);
  bad([`tree ${tree}`, 'encoding UTF-8', `author ${author}`, `committer ${committer}`], ...noAuthor);
  bad([`tree ${tree}`, ' parent-sig', `author ${author}`, `committer ${committer}`], ...noAuthor);
  bad([`tree ${tree}`, 'x-custom v', `author ${author}`, `committer ${committer}`], ...noAuthor);
  bad([`tree ${tree}`, `committer ${committer}`, `author ${author}`], ...noAuthor);
  bad([`tree ${tree}`, `author ${author}`, 'encoding UTF-8', `committer ${committer}`], ...noCommitter);
  bad([`tree ${tree}`, `author ${author}`, `parent ${oid(3)}`, `committer ${committer}`], ...noCommitter);
  const twoParents = parseCommit(body([`tree ${tree}`, `parent ${oid(3)}`, `parent ${oid(3)}`, `author ${author}`, `committer ${committer}`]));
  assert.deepEqual(twoParents.parents, [oid(3), oid(3)]);

  const tags = parseTag(body([`object ${oid(5)}`, 'type commit', 'tag v1', `tagger ${author}`, 'gpgsig abc']));
  assert.equal(tags.object, oid(5));
  assert.equal(tags.type, 'commit');
  assert.equal(tags.tag, 'v1');
  assert.equal(tags.tagger, author);
  assert.deepEqual(tags.extra, ['gpgsig abc']);
  assert.equal(tags.message, 'msg\n');
  assert.deepEqual(parseTag(body([`object ${oid(5)}`, 'type commit', 'tag v1', `tagger ${author}`, 'gpgsig abc', ' more'])).extra, ['gpgsig abc', ' more']);
  // after the tagger fsck reads nothing (extraHeaderEntry is IGNORE), but a second object, type, tag or tagger is
  // refused like a second author (PR #7)
  const tagAfter = (...lines) => parseTag(body([`object ${oid(5)}`, 'type commit', 'tag v1', `tagger ${author}`, ...lines]));
  assert.throws(() => tagAfter(`tagger ${other}`), e => e.code === 'pack_corrupt' && e.message === 'tag: duplicate tagger' && e.msgId === 'duplicateHeader');
  assert.throws(() => tagAfter('gpgsig x', `tagger ${other}`), e => e.message === 'tag: duplicate tagger');
  assert.throws(() => tagAfter(`object ${oid(6)}`), e => e.message === 'tag: duplicate object' && e.msgId === 'duplicateHeader');
  assert.throws(() => tagAfter('type blob'), e => e.message === 'tag: duplicate type');
  assert.throws(() => tagAfter('gpgsig x', 'tag v2'), e => e.message === 'tag: duplicate tag');
  assert.deepEqual(tagAfter('objection x', 'typed y', 'tagline z').extra, ['objection x', 'typed y', 'tagline z']);
  const tagBad = (lines, msgId, why) => throws(() => parseTag(body(lines)), 'pack_corrupt', `tag: ${msgId}: ${why}`);
  tagBad([`object ${oid(5)}`, `object ${oid(6)}`, 'type commit', 'tag v1', `tagger ${author}`], 'missingTypeEntry', "invalid format - expected 'type' line");
  tagBad([`object ${oid(5)}`, 'type commit', 'type blob', 'tag v1', `tagger ${author}`], 'missingTagEntry', "invalid format - expected 'tag' line");
  tagBad(['type commit', `object ${oid(5)}`, 'tag v1', `tagger ${author}`], 'missingObject', "invalid format - expected 'object' line");
  tagBad(['gpgsig x', `object ${oid(5)}`, 'type commit', 'tag v1', `tagger ${author}`], 'missingObject', "invalid format - expected 'object' line");
  // a tag line followed by anything but a tagger: missingTaggerEntry (INFO), so the rest is extra, but a second copy
  // of a tag header further down (a tagger git's %(tagger) would show while fsck saw none) is refused
  assert.deepEqual(parseTag(body([`object ${oid(5)}`, 'type commit', 'tag v1', 'x y'])).extra, ['x y']);
  assert.throws(() => parseTag(body([`object ${oid(5)}`, 'type commit', 'tag v1', 'tag v2', `tagger ${author}`])), e => e.message === 'tag: duplicate tag');
  assert.throws(() => parseTag(body([`object ${oid(5)}`, 'type commit', 'tag v1', 'x y', `tagger ${author}`])), e => e.message === 'tag: duplicate tagger');
  assert.equal(parseTag(te.encode(`object ${oid(5)}\ntype commit\ntag \n`)).tag, '');
});

test('fsck_ident: every rule, in git\'s order, on every role', () => {
  const tree = oid(1);
  const who = tz => `A <a@b.c> 1700000000 ${tz}`;
  const commit = (author, committer = who('+0000')) => te.encode(`tree ${tree}\nauthor ${author}\ncommitter ${committer}\n\nm\n`);
  const tag = tagger => te.encode(`object ${tree}\ntype commit\ntag v1\ntagger ${tagger}\n\n`);
  const all = (ident, msgId, why) => {
    throws(() => assertFetched('commit', commit(ident)), 'pack_corrupt', `commit: ${msgId}: invalid author line - ${why}`);
    throws(() => assertFetched('commit', commit(who('+0000'), ident)), 'pack_corrupt', `commit: ${msgId}: invalid committer line - ${why}`);
    throws(() => assertFetched('tag', tag(ident)), 'pack_corrupt', `tag: ${msgId}: invalid tagger line - ${why}`);
  };
  const fine = ident => { assertFetched('commit', commit(ident)); assertFetched('commit', commit(who('+0000'), ident)); assertFetched('tag', tag(ident)); };
  for (const tz of ['+0000', '-0000', '+0530', '-1200', '+1400', '+9999', '+1560', '+2400', '+0059']) fine(who(tz));
  // fsck skips spaces and tabs before the timestamp; a timestamp of 0 is not zero-padded; any name and email bytes
  fine('A <a@b.c>  1700000000 +0000');
  fine('A <a@b.c> \t1700000000 +0530');
  fine('A <a@b.c> 0 -1200');
  fine('A <a@b.c> 1700000009 +0000');
  fine('A <a@b.c> 9223372036854775807 +0000');
  fine(' <a@b.c> 1700000000 +0000');
  fine('A <> 1700000000 +0000');
  fine('A <a b> 1700000000 +0000');
  fine('A\t <a@b.c> 1700000000 +0000');
  const badTz = ['+000', '+00000', '+00', '+', '0000', '+0a00', '+00:00', 'Z', '+0000x', '+0000 ', '+0000\t', ' +0000', '+00 00', '++000', '+-000', '+0000 extra', '+000a', 'a0000'];
  for (const tz of badTz) all(who(tz), 'badTimezone', 'bad time zone');
  all('A <a@b.c> 1700000000', 'badDate', 'bad date');
  all('A <a@b.c> 12:34 +0000', 'badDate', 'bad date');
  all('Ada <ada@ex> soon +0000', 'badDate', 'bad date');
  all('A <a@b.c> +0000', 'badDate', 'bad date');
  all('A <a@b.c> 1700000000\t+0000', 'badDate', 'bad date');
  all('A <a@b.c> \t', 'badDate', 'bad date');
  all('A <a@b.c> 01700000000 +0000', 'zeroPaddedDate', 'zero-padded date');
  all('A <a@b.c> 00 +0000', 'zeroPaddedDate', 'zero-padded date');
  all('A <a@b.c> 0x +0000', 'zeroPaddedDate', 'zero-padded date');
  all('A <a@b.c> 9223372036854775808 +0000', 'badDateOverflow', 'date causes integer overflow');
  all('A <a@b.c> 99999999999999999999999 +0000', 'badDateOverflow', 'date causes integer overflow');
  all('A <a@b.c> 99999999999999999999999x +0000', 'badDateOverflow', 'date causes integer overflow');
  all('A <a@b.c>1700000000 +0000', 'missingSpaceBeforeDate', 'missing space before date');
  all('A <a@b.c>', 'missingSpaceBeforeDate', 'missing space before date');
  all('A <a@b.c 1700000000 +0000', 'badEmail', 'bad email');
  all('A <a<b@c> 1700000000 +0000', 'badEmail', 'bad email');
  all('A <a@b.c', 'badEmail', 'bad email');
  // a space is required immediately before '<'. commit#23000087 replaced it with '!'; commit#19000059 with 0x9E.
  all('A<a@b.c> 1700000000 +0000', 'missingSpaceBeforeEmail', 'missing space before email');
  all('A!<a@b.c> 1700000000 +0000', 'missingSpaceBeforeEmail', 'missing space before email');
  all('A\t<a@b.c> 1700000000 +0000', 'missingSpaceBeforeEmail', 'missing space before email');
  all('<a@b.c> 1700000000 +0000', 'missingNameBeforeEmail', 'missing space before email');
  all('A > <a@b.c> 1700000000 +0000', 'badName', 'bad name');
  all('A a@b.c> 1700000000 +0000', 'badName', 'bad name');
  all('A U Thor 1700000000 +0000', 'missingEmail', 'missing email');
  all('', 'missingEmail', 'missing email');
  const glued = concat([
    te.encode(`tree ${tree}\nauthor A <a@b.c> 1700000000 +0000\ncommitter A `),
    Uint8Array.of(0x9e),
    te.encode('<a@b.c> 1700000000 +0000\n\nm\n'),
  ]);
  throws(() => assertFetched('commit', glued), 'pack_corrupt', 'commit: missingSpaceBeforeEmail: invalid committer line - missing space before email');
  // commit#1000022: 0xC1 inserted into the author zone, Latin-1 "+00Á00"
  const poison = concat([
    te.encode(`tree ${tree}\nauthor A <a@b.c> 1700000000 +00`),
    Uint8Array.of(0xc1),
    te.encode('00\ncommitter A <a@b.c> 1700000000 +0000\n\nm\n'),
  ]);
  throws(() => assertFetched('commit', poison), 'pack_corrupt', 'commit: badTimezone: invalid author line - bad time zone');
  // a non-UTF-8 name is bytes git accepts
  assertFetched('commit', concat([te.encode(`tree ${tree}\nauthor J`), Uint8Array.of(0xf6), te.encode(`rg <j@b.c> 1 +0000\ncommitter ${who('+0000')}\n\n`)]));
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
  const two = inflate(concat([stored(Uint8Array.of(1, 2), false), stored(Uint8Array.of(3), true)]), 0, { bound: cappedBound(), wrap: rawWrap() });
  assert.deepEqual([...two.out], [1, 2, 3]);
  assert.equal(two.stats.blocks, 2);
  assert.equal(two.stats.stored, 2);
  throws(() => inflate(Uint8Array.of(1), 0, { bound: cappedBound(), wrap: rawWrap() }), 'pack_corrupt', 'inflate: truncated stored header');
  const badLen = stored(Uint8Array.of(1), true);
  badLen[3] ^= 1;
  throws(() => inflate(badLen, 0, { bound: cappedBound(), wrap: rawWrap() }), 'pack_corrupt', 'inflate: stored length check failed');
  throws(() => inflate(Uint8Array.of(7), 0, { bound: cappedBound(), wrap: rawWrap() }), 'pack_corrupt', 'inflate: invalid block type');
  throws(() => inflate(stored(Uint8Array.of(1, 2, 3), true).subarray(0, 6), 0, { bound: cappedBound(), wrap: rawWrap() }), 'pack_corrupt', 'inflate: truncated stored block');

  const hello = te.encode('hello hello hello hello');
  const fixed = inflate(new Uint8Array(zlib.deflateSync(hello)), 0, { bound: cappedBound(), wrap: zlibWrap(true) });
  assert.equal(fixed.stats.fixed, 1);
  assert.equal(fixed.stats.dynamic, 0);
  assert.equal(td.decode(fixed.out), td.decode(hello));
  assert.equal(fixed.stats.literals, 7);
  assert.equal(fixed.stats.matches, 1);
  assert.equal(fixed.stats.maxDist, 6);
  assert.equal(fixed.stats.maxLen, 16);
  const level0 = inflate(new Uint8Array(zlib.deflateSync(hello, { level: 0 })), 0, { bound: cappedBound(), wrap: zlibWrap(true) });
  assert.equal(level0.stats.stored, 1);
  let varied = '';
  for (let i = 0; i < 4000; i++) varied += `word${i % 700} `;
  const dynamic = inflate(new Uint8Array(zlib.deflateSync(Buffer.from(varied))), 0, { bound: cappedBound(), wrap: zlibWrap(true) });
  assert.equal(dynamic.stats.dynamic, 1);
  assert.equal(td.decode(dynamic.out), varied);

  const grown = inflate(new Uint8Array(zlib.deflateSync(Buffer.from('a'.repeat(10000)))), 0, { bound: cappedBound(), wrap: zlibWrap(true) });
  assert.equal(grown.out.length, 10000);
  throws(() => inflate(new Uint8Array(zlib.deflateSync(hello)), 0, { bound: declaredBound(1), wrap: zlibWrap(true) }), 'pack_corrupt', 'inflate: output exceeds expected 1');
  assert.throws(() => inflate(new Uint8Array(zlib.deflateSync(hello)), 0, { bound: declaredBound(hello.length + 10, 4), wrap: zlibWrap(true) }), e => e.code === 'limit_exceeded' && e.message === `inflate: expected size ${hello.length + 10} exceeds limit 4`);
  throws(() => inflate(new Uint8Array(zlib.deflateSync(Buffer.from('a'.repeat(1000)))), 0, { bound: cappedBound(100), wrap: zlibWrap(true) }), 'limit_exceeded', 'inflate: output exceeds limit 100');

  throws(() => inflate(Uint8Array.of(0x01, 0x00), 0, { bound: cappedBound(), wrap: zlibWrap(true) }), 'pack_corrupt', 'zlib: unsupported method 1');
  throws(() => inflate(Uint8Array.of(0x78, 0x00), 0, { bound: cappedBound(), wrap: zlibWrap(true) }), 'pack_corrupt', 'zlib: bad header check');
  throws(() => inflate(Uint8Array.of(0x78, 0x20), 0, { bound: cappedBound(), wrap: zlibWrap(true) }), 'pack_corrupt', 'zlib: preset dictionary not supported');
  const chopped = new Uint8Array(zlib.deflateSync(hello)).subarray(0, 8);
  throws(() => inflate(chopped, 0, { bound: cappedBound(), wrap: zlibWrap(true) }), 'pack_corrupt', 'inflate: unexpected end of input');
  const mismatch = new Uint8Array(zlib.deflateSync(hello));
  mismatch[mismatch.length - 1] ^= 1;
  throws(() => inflate(mismatch, 0, { bound: cappedBound(), wrap: zlibWrap(true) }), 'pack_corrupt', 'inflate: adler32 mismatch');
  assert.equal(inflate(mismatch, 0, { bound: cappedBound(), wrap: zlibWrap(false) }).out.length, hello.length);
  const rawCut = new Uint8Array(zlib.deflateRawSync(hello)).subarray(0, 1);
  throws(() => inflate(rawCut, 0, { bound: cappedBound(), wrap: rawWrap() }), 'pack_corrupt', 'inflate: unexpected end of input');
});

test('v2 sections, sideband, and the single-object pack stream', async () => {
  const limits = withLimits({ maxSectionLines: 2 });
  let st = v2Init(limits);
  const feed = frame => { const r = v2Step(st, frame); st = r.state; return r; };
  const line = s => ({ kind: 'data', payload: te.encode(s) });
  const errOf = (text) => {
    st = v2Init(limits);
    try { feed(line(`ERR ${text}\n`)); } catch (e) { return e; }
    assert.fail(`ERR ${text} did not throw`);
  };
  const boom = errOf('boom');
  assert.equal(boom.code, 'remote_error');
  assert.equal(boom.message, 'remote: boom');
  assert.equal(boom.reason, undefined);
  for (const text of ['not our ref', 'not our ref abc', 'upload-pack: not our ref', 'upload-pack: not our ref abc']) {
    const e = errOf(text);
    assert.equal(e.code, 'remote_error', text);
    assert.equal(e.message, `remote: ${text}`, text);
    assert.equal(e.reason, 'not_our_ref', text);
  }
  for (const text of ['not our refresh', 'upload-pack: not our refresh', 'upload-pack: not our refX']) {
    const e = errOf(text);
    assert.equal(e.code, 'remote_error', text);
    assert.equal(e.message, `remote: ${text}`, text);
    assert.equal(e.reason, undefined, text);
  }
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
  // a delim or response-end inside the packfile section ends git's demultiplexer: refused, not skipped
  throws(() => feed({ kind: 'delim' }), 'protocol', 'v2: delim inside the packfile section');
  throws(() => feed({ kind: 'end' }), 'protocol', 'v2: end inside the packfile section');
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
  const bandErr = (body) => {
    try { feed({ kind: 'data', payload: concat([Uint8Array.of(3), te.encode(body)]) }); } catch (e) { return e; }
    assert.fail(body);
  };
  const bandBoom = bandErr('  boom \n');
  assert.equal(bandBoom.code, 'remote_error');
  assert.equal(bandBoom.message, 'remote: boom');
  assert.equal(bandBoom.reason, undefined);
  const bandAbsent = bandErr('upload-pack: not our ref abc');
  assert.equal(bandAbsent.code, 'remote_error');
  assert.equal(bandAbsent.message, 'remote: upload-pack: not our ref abc');
  assert.equal(bandAbsent.reason, 'not_our_ref');
  assert.equal(bandErr('not our refresh').reason, undefined);
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
  // git reads an oid in either case (parse_oid_hex_algop: hexval); ply keeps it lower-case (the advertisement space, record=upperPeeled)
  assert.deepEqual(parseLsRefLine(`${id} refs/tags/v1 peeled:${'AB'.repeat(20)}`), { oid: id, name: 'refs/tags/v1', peeled: 'ab'.repeat(20) });
  for (const bad of ['junk', 'GB'.repeat(20), `${oid(5)}0`, '']) {
    const line = `${id} refs/tags/v1 peeled:${bad}`;
    throws(() => parseLsRefLine(line), 'protocol', `ls-refs: malformed line ${JSON.stringify(line.slice(0, 60))}`);
  }
  throws(() => parseLsRefLine('ERR no such ref'), 'remote_error', 'remote: no such ref');
  throws(() => parseLsRefLine('nope'), 'protocol', 'ls-refs: malformed line "nope"');
  // an empty second field is a ref named "" (process_ref_v2), and an `unborn` record is no ref (record=emptyName, unbornOther)
  assert.deepEqual(parseLsRefLine(`${id} `), { oid: id, name: '' });
  assert.equal(parseLsRefLine('unborn HEAD symref-target:refs/heads/main'), null);
  assert.equal(parseLsRefLine('unborn '), null);
  throws(() => parseLsRefLine('unborn'), 'protocol', 'ls-refs: malformed line "unborn"');
  throws(() => parseLsRefLine(`${'zz'.repeat(20)} refs/heads/main`), 'protocol', `ls-refs: malformed line ${JSON.stringify(`${'zz'.repeat(20)} refs/heads/main`)}`);
  throws(() => parseLsRefLine(`${'ab'.repeat(32)} refs/heads/main`), 'unsupported', 'unsupported object-format: only sha1 repositories are supported');
  const upper = 'ab'.repeat(20).toUpperCase();
  assert.deepEqual(parseLsRefLine(`${upper} refs/heads/main`), { oid: 'ab'.repeat(20), name: 'refs/heads/main' });
  throws(() => parseLsRefLine(`${'AB'.repeat(32)} refs/heads/main`), 'unsupported', 'unsupported object-format: only sha1 repositories are supported');
  const long = 'not a ref line '.repeat(8);
  throws(() => parseLsRefLine(long), 'protocol', `ls-refs: malformed line ${JSON.stringify(long.slice(0, 60))}`);

  // one report parser (classifyReport): the lines parseReportStatus read, judged by git's grammar
  const rs = (lines, refs = ['refs/heads/main', 'refs/heads/other']) => classifyReport(lines.map(l => te.encode(`${l}\n`)), refs.map(ref => ({ ref })));
  assert.deepEqual(rs(['unpack ok', 'ok refs/heads/main', 'ok refs/heads/other']), { tag: 'statuses', refs: [{ ref: 'refs/heads/main', ok: true, reason: '' }, { ref: 'refs/heads/other', ok: true, reason: '' }] });
  assert.deepEqual(rs(['unpack ok', 'ok refs/heads/main', 'ng refs/heads/other failed to lock']).refs[1], { ref: 'refs/heads/other', ok: false, reason: 'failed to lock' });
  // report-status-v2 option lines come only from a proc-receive hook (not modelled): the report is not git's plain one
  assert.deepEqual(rs(['unpack ok', 'ok refs/heads/main', 'ng refs/heads/other failed to lock', 'option old-oid abc']), { tag: 'malformed', why: 'a line is not a ref status' });
  assert.deepEqual(rs(['unpack error', 'ok refs/heads/main', 'ok refs/heads/other']), { tag: 'malformed', why: 'no git unpack line first' });
  assert.deepEqual(rs(['ok refs/heads/main']), { tag: 'malformed', why: 'no git unpack line first' });
  assert.deepEqual(rs(['unpackok', 'ok refs/heads/main']), { tag: 'malformed', why: 'no git unpack line first' });
  // send-pack.c receive_unpack_status reads one unpack line; a second is an invalid ref status
  assert.deepEqual(rs(['unpack index-pack abnormal exit', 'unpack ok', 'ok refs/heads/main'], ['refs/heads/main']), { tag: 'malformed', why: 'a line is not a ref status' });
  assert.deepEqual(rs(['unpack ok', 'ok refs/heads/main', 'unpack ok'], ['refs/heads/main']), { tag: 'malformed', why: 'a line is not a ref status' });
});

test('gitattributes lines', () => {
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
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\nauthor Ada >x 1 +0000\ncommitter ${author}\n\n`)), 'pack_corrupt', 'commit: badName: invalid author line - bad name');
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\nauthor Ada <ada@ex 1 +0000\ncommitter ${author}\n\n`)), 'pack_corrupt', 'commit: badEmail: invalid author line - bad email');
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\nauthor <ada@ex> 1700000000 +0000\ncommitter ${author}\n\n`)), 'pack_corrupt', 'commit: missingNameBeforeEmail: invalid author line - missing space before email');
  assertFetched('commit', te.encode(`tree ${tree}\nauthor  <ada@ex> 1700000000 +0000\ncommitter ${author}\n\n`));
  throws(() => parseTree(data('100644 a', oidBytes(4))), 'pack_corrupt', 'tree: malformed entry');
  throws(() => parseTree(data('g7 a\0', oidBytes(4))), 'pack_corrupt', 'tree: malformed mode');
  throws(() => parseTag(te.encode('tag')), 'pack_corrupt', 'tag: unterminatedHeader: unterminated header');
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
  const main = [{ ref: 'refs/heads/main' }];
  assert.deepEqual(classifyReport(['unpack ok\n', 'ok refs/heads/main\n'].map(l => te.encode(l)), main), { tag: 'statuses', refs: [{ ref: 'refs/heads/main', ok: true, reason: '' }] });
  assert.equal(classifyReport(['unpack ok\n', 'ok refs/heads/main\n', 'option alone\n'].map(l => te.encode(l)), main).tag, 'malformed');
  assert.equal(classifyReport([te.encode('option alone\n')], main).tag, 'malformed');

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
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\nauthor ><ada@ex> 1700000000 +0000\ncommitter ${author}\n\n`)), 'pack_corrupt', 'commit: badName: invalid author line - bad name');
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\nauthor >a <ada@ex> 1700000000 +0000\ncommitter ${author}\n\n`)), 'pack_corrupt', 'commit: badName: invalid author line - bad name');
  throws(() => assertFetched('commit', te.encode(`tree ${tree}\nauthor ${author}\ncommitter Ada\n\n`)), 'pack_corrupt', 'commit: missingEmail: invalid committer line - missing email');
  const id = oid(3);
  const tagger = author;
  throws(() => parseTag(te.encode(`type commit\nobject ${id}\ntag v1\ntagger ${tagger}\n\n`)), 'pack_corrupt', "tag: missingObject: invalid format - expected 'object' line");
  throws(() => parseTag(te.encode(`object ${id}\ntag v1\ntype blob\ntagger ${tagger}\n\n`)), 'pack_corrupt', "tag: missingTypeEntry: invalid format - expected 'type' line");

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

  const one = [{ ref: 'refs/heads/a' }];
  assert.deepEqual(classifyReport([], one), { tag: 'malformed', why: 'no git unpack line first' });
  assert.deepEqual(classifyReport([te.encode('unpack ok\n')], one), { tag: 'malformed', why: 'no status for refs/heads/a' });
  assert.deepEqual(decideOutcome(classifyReport(['unpack ok\n', 'ng refs/heads/a no\n'].map(l => te.encode(l)), one)), { tag: 'rejected', code: 'push_rejected', refs: [{ ref: 'refs/heads/a', reason: 'no', cls: 'rejected' }] });

  const ref = `${oid(4)} refs/heads/a :val`;
  assert.deepEqual(parseLsRefLine(ref), { oid: oid(4), name: 'refs/heads/a' });
  // a doubled space after the oid: an empty name, then `refs/heads/a` as an attribute token (process_ref_v2 splits on every space)
  assert.deepEqual(parseLsRefLine(`${oid(4)}  refs/heads/a`), { oid: oid(4), name: '' });
  const spaced = parseLsRefLine(`${oid(4)} refs/heads/a symref-target:b  peeled:${oid(5)}`);
  assert.deepEqual(spaced, { oid: oid(4), name: 'refs/heads/a', 'symref-target': 'b', peeled: oid(5) });

  const hello = te.encode('hello hello hello hello');
  const inflated = inflate(new Uint8Array(zlib.deflateSync(hello)), 0, { bound: cappedBound(), wrap: zlibWrap(true) });
  assert.ok(inflated.stats.matchBytes > 0);
  assert.equal(inflated.stats.matchBytes, 16);
  const repeated = te.encode('abcdefghijabcdefghijab');
  const twice = inflate(new Uint8Array(zlib.deflateSync(repeated)), 0, { bound: cappedBound(), wrap: zlibWrap(true) });
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
  const wordInf = inflate(new Uint8Array(zlib.deflateSync(wordBytes)), 0, { bound: cappedBound(), wrap: zlibWrap(true) });
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
  throws(() => parseTag(te.encode(`object ${id}\ntype commit\ntype blob\ntag v1\ntagger ${tagger}\n\n`)), 'pack_corrupt', "tag: missingTagEntry: invalid format - expected 'tag' line");

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
  throws(() => inflate(raw, 0, { bound: cappedBound(1024), wrap: rawWrap() }), 'pack_corrupt', 'inflate: invalid huffman code');

  const helloZ = new Uint8Array(zlib.deflateSync(hello));
  assert.equal(inflate(helloZ, 0, { bound: declaredBound(hello.length, hello.length + 10), wrap: zlibWrap(true) }).out.length, hello.length);
  const emptyStored = Uint8Array.of(1, 0, 0, 255, 255);
  assert.equal(inflate(emptyStored, 0, { bound: cappedBound(), wrap: rawWrap() }).out.length, 0);
  const zhead = Uint8Array.of(0x78, 0x9c);
  const cut = concat([zhead, Uint8Array.of(1, 0, 0, 255, 255)]);
  throws(() => inflate(cut, 0, { bound: cappedBound(), wrap: zlibWrap(true) }), 'pack_corrupt', 'inflate: truncated adler32');
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
  throws(() => inflate(helloZ, 0, { bound: declaredBound(hello.length + 10), wrap: zlibWrap(true) }), 'pack_corrupt', `inflate: size ${hello.length} != expected ${hello.length + 10}`);

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
  throws(() => inflate(fixed({ lit: 97 }), 0, { bound: cappedBound(), wrap: rawWrap() }), 'pack_corrupt', 'inflate: unexpected end of input');
  throws(() => inflate(fixed({ sym: 286, len: true, dist: 0 }), 0, { bound: cappedBound(64), wrap: rawWrap() }), 'pack_corrupt', 'inflate: bad length symbol');
  throws(() => inflate(fixed({ sym: 257, len: true, dist: 0 }), 0, { bound: cappedBound(64), wrap: rawWrap() }), 'pack_corrupt', 'inflate: distance too far back');
  const overlapped = inflate(fixed({ lit: 97 }, { sym: 257, len: true, dist: 0 }, {}), 0, { bound: cappedBound(), wrap: rawWrap() });
  assert.deepEqual([...overlapped.out], [97, 97, 97, 97]);
  const distances = inflate(fixed(
    ...[...'abcdef'].map(ch => ({ lit: ch.charCodeAt(0) })),
    { sym: 257, len: true, dist: 4, distExtra: 1, distExtraBits: 1 },
    { sym: 257, len: true, dist: 0 },
    {},
  ), 0, { bound: cappedBound(), wrap: rawWrap() });
  assert.equal(distances.stats.maxDist, 6);
  assert.equal(distances.out.length, 12);

  // One literal plus a 256-byte match is 257 bytes. The initial buffer is 256 and the limit is the exact size,
  // so growing onto the limit is legal and stopping one short of it is not.
  const onto = inflate(fixed({ lit: 97 }, { sym: 284, len: true, extra: 29, extraBits: 5, dist: 0 }, {}), 0, { bound: cappedBound(257), wrap: rawWrap() });
  assert.equal(onto.out.length, 257);
  // A second match asks for more than twice the current buffer, so the growth loop has to run.
  const grown = inflate(fixed(
    { lit: 97 },
    { sym: 284, len: true, extra: 27, extraBits: 5, dist: 0 },
    { sym: 285, len: true, dist: 0 },
    {},
  ), 0, { bound: cappedBound(), wrap: rawWrap() });
  assert.equal(grown.out.length, 513);

  const stored = new Uint8Array(305);
  stored[0] = 1; stored[1] = 300 & 255; stored[2] = 300 >> 8;
  const nlen = (~300) & 0xffff; stored[3] = nlen & 255; stored[4] = nlen >> 8;
  stored.fill(7, 5);
  throws(() => inflate(stored, 0, { bound: cappedBound(100), wrap: rawWrap() }), 'limit_exceeded', 'inflate: output exceeds limit 100');

  const dyn = (hlit, hdist) => {
    const bits = [];
    const put = (v, n) => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); };
    put(1, 1); put(2, 2); put(hlit, 5); put(hdist, 5); put(0, 4);
    return packBits(bits);
  };
  throws(() => inflate(dyn(30, 0), 0, { bound: cappedBound(), wrap: rawWrap() }), 'pack_corrupt', 'inflate: bad dynamic counts');
  throws(() => inflate(dyn(0, 30), 0, { bound: cappedBound(), wrap: rawWrap() }), 'pack_corrupt', 'inflate: bad dynamic counts');

  // Code-length symbol 16 as the first length, and symbol 18 repeated past the 258 length slots.
  const repeat = extras => {
    const bits = [];
    const put = (v, n) => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); };
    put(1, 1); put(2, 2); put(0, 5); put(0, 5); put(0, 4);
    for (const n of extras.head) put(n, 3);
    for (const [v, n] of extras.body) put(v, n);
    return packBits(bits);
  };
  throws(() => inflate(repeat({ head: [1, 0, 0, 0], body: [[0, 1]] }), 0, { bound: cappedBound(), wrap: rawWrap() }), 'pack_corrupt', 'inflate: repeat with no previous');
  throws(() => inflate(repeat({ head: [0, 0, 1, 0], body: [[0, 1], [127, 7], [0, 1], [127, 7]] }), 0, { bound: cappedBound(), wrap: rawWrap() }), 'pack_corrupt', 'inflate: repeat overflow');
  throws(() => inflate(repeat({ head: [0, 0, 1, 0], body: [[0, 1], [127, 7], [0, 1], [120 - 11, 7]] }), 0, { bound: cappedBound(), wrap: rawWrap() }), 'pack_corrupt', 'inflate: no end-of-block code');

  // 15 data bits end on the last bit of the buffer, so one more Huffman step has nothing to read.
  const hole = [];
  const putHole = (v, n) => { for (let i = 0; i < n; i++) hole.push((v >> i) & 1); };
  putHole(1, 1); putHole(2, 2); putHole(0, 5); putHole(0, 5); putHole(6, 4);
  for (const n of [0, 0, 0, 1, 1, 0, 0, 0, 0, 0]) putHole(n, 3);
  for (let i = 0; i < 256; i++) putHole(0, 1);
  putHole(1, 1); putHole(0, 1);
  for (let i = 0; i < 15; i++) putHole(1, 1);
  assert.equal(hole.length % 8, 0);
  throws(() => inflate(packBits(hole), 0, { bound: cappedBound(32), wrap: rawWrap() }), 'pack_corrupt', 'inflate: invalid huffman code');
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
  const src = readdirSync('src').filter(f => /\.[jt]s$/.test(f) && !f.startsWith('limits.')).map(f => readFileSync(join('src', f), 'utf8')).join('\n');
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
  throws(() => inflate(zhello, 0, { bound: declaredBound(DEFAULT_LIMITS.maxObjectSize + 1), wrap: zlibWrap(true) }), 'limit_exceeded', `inflate: expected size ${DEFAULT_LIMITS.maxObjectSize + 1} exceeds limit ${DEFAULT_LIMITS.maxObjectSize}`);
  throws(() => inflate(zhello, 0, { bound: cappedBound(Infinity), wrap: zlibWrap(true) }), 'bad_request', 'limits.maxObjectSize must be a finite non-negative number');

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

  // the report's line bound is the read's (push: maxReportLines), and every limit push reads is checked before anything is sent
  const delA = { commands: [{ ref: 'refs/heads/a', oldOid: oid(1), newOid: ZERO_OID }] };
  for (const key of ['maxRefs', 'maxReportLines', 'maxPackBytes']) {
    const r = planPush(delA, withLimits({ [key]: undefined }));
    assert.equal(r.ok, false); assert.equal(r.error.code, 'bad_request'); assert.equal(r.error.message, `limits.${key} must be a finite non-negative number`);
  }
  const planned = orThrow(planPush(delA, withLimits({ maxReportLines: 1, maxPackBytes: 2 })));
  assert.deepEqual([planned.maxReportLines, planned.maxPack, planned.needPack, planned.checked], [1, 2, false, undefined]);

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
  // encodeTag refuses what git hash-object -t tag refuses (fsck_tag_standalone), as a bad request (issue #103)
  const tagOf = f => encodeTag({ object: tree, type: 'commit', tag: 'v1', tagger: 'A <a@b.c> 1 +0000', message: 'm\n', ...f });
  assert.equal(td.decode(tagOf({})), `object ${tree}\ntype commit\ntag v1\ntagger A <a@b.c> 1 +0000\n\nm\n`);
  assert.equal(td.decode(tagOf({ tag: 'release/v1', message: null, extra: ['x y'] })), `object ${tree}\ntype commit\ntag release/v1\ntagger A <a@b.c> 1 +0000\nx y\n`);
  for (const tag of ['', 'v 1', 'a..b', 'v1.lock', 'v1/', 'v*']) throws(() => tagOf({ tag }), 'bad_request', "tag: badTagName: invalid 'tag' name");
  throws(() => tagOf({ object: 'zz'.repeat(20) }), 'bad_request', "tag: badObjectSha1: invalid 'object' line format - bad sha1");
  throws(() => tagOf({ type: 'bogus' }), 'bad_request', "tag: badType: invalid 'type' value");
  throws(() => tagOf({ tagger: 'A a@b.c 1 +0000' }), 'bad_request', 'tag: missingEmail: invalid tagger line - missing email');
  throws(() => tagOf({ extra: ['tag v2'] }), 'bad_request', 'tag: duplicate tag');
  assert.throws(() => tagOf({ type: 'bogus' }), e => e.what === 'tag');
  assert.throws(() => tagOf({ tag: '' }), e => e.what === 'tag');

  throws(() => fetchBody({ wants: ['abc\n'] }), 'bad_request', 'invalid want: must be a string without NUL, CR, or LF');
  throws(() => fetchBody({ wants: [oid(1)], deepen: -1 }), 'bad_request', 'invalid deepen: must be a non-negative safe integer');
  throws(() => fetchBody({ wants: [oid(1)], deepenSince: '1\n2' }), 'bad_request', 'invalid deepen-since: must be a string without NUL, CR, or LF');
  throws(() => fetchBody({ wants: [oid(1)], haves: ['a\rb'] }), 'bad_request', 'invalid have: must be a string without NUL, CR, or LF');
  assert.ok(fetchBody({ wants: [oid(1)], deepenSince: 1, filter: 'blob:none', deepen: 1 }).byteLength > 0);
  await assert.rejects(() => negotiate({}, { wants: [oid(1)], haves: [oid(2)], maxRounds: Infinity }), e => e.code === 'bad_request' && e.what === 'maxNegotiateRounds');
  await assert.rejects(() => negotiate({}, { wants: [oid(1)], haves: [oid(2)], batch: 0 }), e => e.code === 'bad_request' && e.what === 'negotiateBatch');

  const commands = [{ ref: 'refs/heads/a' }, { ref: 'refs/heads/b' }];
  const mixed = classifyReport(['unpack ok\n', 'ok refs/heads/a\n', 'ng refs/heads/b failed to lock\n'].map(l => te.encode(l)), commands);
  assert.deepEqual(decideOutcome(mixed, { atomic: true }), { tag: 'ambiguous', why: 'atomic push split: some refs ok, some ng' });
  assert.deepEqual(decideOutcome(mixed), { tag: 'partial', landed: ['refs/heads/a'], rejected: [{ ref: 'refs/heads/b', reason: 'failed to lock', cls: 'cas' }] });

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

  // unborn (issue #103): the reader, the request argument, and the advertisement check that gates it
  const M = { name: 'HEAD', target: 'refs/heads/main' };
  assert.deepEqual(parseUnbornLine('unborn HEAD symref-target:refs/heads/main'), M);
  assert.deepEqual(parseUnbornLine('unborn HEAD peeled:x symref-target:refs/heads/a symref-target:refs/heads/b'), { name: 'HEAD', target: 'refs/heads/a' });
  assert.equal(parseUnbornLine('unborn HEAD', M), M, 'no target: the previous one stands');
  assert.equal(parseUnbornLine('unborn HEAD symref-targe:refs/heads/x', M), M, 'not the attribute');
  assert.equal(parseUnbornLine('unborn HEAD xsymref-target:refs/heads/x', M), M, 'the key starts the token');
  assert.equal(parseUnbornLine('unborn HEAD'), null, 'prev defaults to null');
  assert.equal(parseUnbornLine('unborn HEAD symref-target:', M), null, 'an empty target clears it');
  assert.deepEqual(parseUnbornLine('unborn HEAD symref-target::x'), { name: 'HEAD', target: ':x' });
  assert.equal(parseUnbornLine('unborn refs/heads/x symref-target:refs/heads/y', M), M, 'only HEAD');
  assert.equal(parseUnbornLine('unborn  HEAD symref-target:refs/heads/y', M), M, 'a doubled space is an empty name');
  assert.equal(parseUnbornLine(`${oid(1)} HEAD symref-target:refs/heads/y`, M), M, 'not an unborn line');
  assert.equal(parseUnbornLine('unbornx HEAD symref-target:refs/heads/y', M), M);
  const bodyOf = (...a) => td.decode(lsRefsBody(...a));
  assert.equal(bodyOf(['HEAD'], { unborn: true }), '0014command=ls-refs\n00010009peel\n000csymrefs\n000bunborn\n0014ref-prefix HEAD\n0000');
  assert.equal(bodyOf(['HEAD']), '0014command=ls-refs\n00010009peel\n000csymrefs\n0014ref-prefix HEAD\n0000');
  assert.equal(bodyOf([], { unborn: false }), bodyOf([]));
  const unbornFrames = [te.encode('unborn HEAD symref-target:refs/heads/a\n'), te.encode('unborn HEAD symref-target:refs/heads/b\n'), te.encode('unborn HEAD\n'), te.encode(refLine)];
  const recording = (list, adv = null) => {
    const sent = [], ads = [];
    return { sent, ads, t: { ...framesOf(list), url: 'http://x/r.git', kind: 'http', async *frames(_svc, body) { sent.push(td.decode(body)); for (const f of list) yield f; }, async advertise() { ads.push(1); return adv; } } };
  };
  const listing = [...unbornFrames.map(p => ({ kind: 'data', payload: p })), { kind: 'flush' }];
  const withReader = recording(listing);
  const got = await lsRefs(withReader.t, [], { unborn: parseUnbornLine });
  assert.deepEqual(got.unborn, { name: 'HEAD', target: 'refs/heads/b' }, 'the last target wins');
  assert.equal(got.refs.size, 1);
  assert.match(withReader.sent[0], /000bunborn\n/);
  const noReader = recording(listing);
  assert.equal((await lsRefs(noReader.t)).unborn, null);
  assert.doesNotMatch(noReader.sent[0], /unborn/);
  // the public lsRefs: unborn is sent only when the advertisement lists ls-refs=unborn (and only when asked)
  const adv = feature => concat([pkt('version 2\n'), pkt('agent=git/2.50.0\n'), pkt(`ls-refs${feature}\n`), pkt('fetch=filter\n'), pkt('object-format=sha1\n'), FLUSH]);
  for (const [feature, asked, sends] of [['=unborn', true, true], ['', true, false], ['=other', true, false], ['=unborn', false, false]]) {
    const r = recording(listing, adv(feature));
    const res = await lsRefsAsked(r.t, [], asked ? { unborn: true } : {});
    assert.equal(/unborn/.test(r.sent[0]), sends, `${feature} asked=${asked}`);
    assert.deepEqual(res.unborn, sends ? { name: 'HEAD', target: 'refs/heads/b' } : null, `${feature} asked=${asked}`);
    assert.equal(r.ads.length, asked ? 1 : 0, 'the advertisement is fetched only when asked');
  }
  for (const lsRefsUnborn of [true, false]) {
    const r = recording(listing, null);
    const res = await lsRefsAsked(r.t, [], { unborn: true, info: { lsRefsUnborn } });
    assert.equal(r.ads.length, 0, 'info in hand: no advertisement');
    assert.equal(/unborn/.test(r.sent[0]), lsRefsUnborn);
    assert.equal(res.unborn !== null, lsRefsUnborn);
  }

  const reportLines = ['unpack ok\n', 'ok refs/heads/a\n', 'ng refs/heads/b failed to lock\n'];
  const receipt = () => ({
    limits: DEFAULT_LIMITS, tracer: tracerStub, parent: null,
    async *frames() { for (const l of reportLines) yield { kind: 'data', payload: te.encode(l) }; yield { kind: 'flush' }; },
  });
  const deletes = [
    { ref: 'refs/heads/a', oldOid: ZERO_OID, newOid: ZERO_OID },
    { ref: 'refs/heads/b', oldOid: ZERO_OID, newOid: ZERO_OID },
  ];
  const all = new Set(['atomic', 'push-options']);
  await assert.rejects(push(receipt(), { commands: deletes, sideband: false, checked: orThrow(checkPushCaps(all, { atomic: true })) }), e => e.code === 'ambiguous' && /atomic push split/.test(e.message));
  // atomic and push options only as checked capabilities: an untyped caller's raw fields are refused before anything is sent
  for (const raw of [{ atomic: true }, { pushOptions: ['x'] }]) await assert.rejects(push(receipt(), { commands: deletes, sideband: false, ...raw }), e => e.code === 'bad_request' && e.message === 'push: unchecked atomic or push options');
  await assert.rejects(push(receipt(), { commands: deletes, sideband: false, atomic: false, pushOptions: [] }), e => e.code === 'push_partial');
  await assert.rejects(push(receipt(), { commands: deletes, sideband: false, checked: orThrow(checkPushCaps(all, { atomic: false })) }), e => e.code === 'push_partial' && e.message === 'push partially applied: refs/heads/a updated; refs/heads/b (failed to lock) refused' && e.landed.join() === 'refs/heads/a' && e.rejected[0].reason === 'failed to lock');
  await assert.rejects(push(receipt(), { commands: [{ ref: 'refs/heads/a\n', oldOid: ZERO_OID, newOid: ZERO_OID }], sideband: false }), e => e.code === 'bad_request' && e.what === 'ref');
  await assert.rejects(push(receipt(), { ref: 'refs/heads/a', oldOid: ZERO_OID, newOid: ZERO_OID, sideband: false, checked: orThrow(checkPushCaps(all, { pushOptions: ['a\nb'] })) }), e => e.code === 'bad_request' && e.what === 'push option');
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
  await assert.rejects((async () => { for await (const frame of errHttp.frames('git-upload-pack', new Uint8Array(0), spanStub)) void frame; })(), e => e.code === 'upstream_5xx' && e.message.includes('xxx') && e.miss === undefined);
  assert.ok(errPulls <= 3, `error body kept reading (${errPulls} chunks)`);
  const page = `missing repo ${'y'.repeat(500)}`;
  const missingRepo = createTransport('http://127.0.0.1:9/missing.git', {
    fetchImpl: async () => new Response(page, { status: 404, headers: { 'content-type': 'text/plain' } }),
    tracer: tracerStub,
  });
  // the advertisement names the status and the miss; it does not quote the body
  await assert.rejects(missingRepo.advertise('git-upload-pack', spanStub), e => e.code === 'not_found' && e.message === 'HTTP 404 git-upload-pack advertisement' && e.miss?.kind === 'repository');
  // the POST quotes a prefix of the page and stops: a dropped slice would keep the whole page
  await assert.rejects((async () => { for await (const frame of missingRepo.frames('git-upload-pack', new Uint8Array(0), spanStub)) void frame; })(), e => e.code === 'not_found' && e.miss?.kind === 'repository' && e.message.includes('yyyy') && !e.message.includes('y'.repeat(250)));
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



// The zlib stream of an object declared S bytes may not run past zlibBound(S) = S + ⌈S/8⌉ + ⌈S/64⌉ + 13 (format.js; the
// inequalities against zlib's deflateBound forms are in format-facts.test.js). Before this bound, a stream of non-final
// empty stored blocks (`00 00 00 ff ff`: 5 bytes in, 0 bytes out) was accepted by every path until the request timer:
// readFile took 793.6 MiB and editFile 632.7 MiB in 8 s, both `timeout`. Now the buffered inflate refuses it at the first
// block boundary past the bound (and a stream that ends past the bound, at its end), spStep refuses the streamed body on
// the chunk that crosses it, and the same empty stored blocks exactly at the bound still inflate.
test('zlib stream length is bounded by the declared size: inflate (both checks), spStep; exactly at the bound passes, one past fails', async () => {
  const { Sha1 } = await import('../src/sha1.js');
  const storedBlock = (data, final) => concat([Uint8Array.of(final ? 1 : 0, data.length & 0xff, data.length >> 8, ~data.length & 0xff, (~data.length >> 8) & 0xff), data]);
  const adlerBytes = n => Uint8Array.of(n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  const emptyBlocks = k => Array.from({ length: k }, () => storedBlock(new Uint8Array(0), false));
  const streamOf = (data, k) => concat([Uint8Array.of(0x78, 0x01), ...emptyBlocks(k), storedBlock(data, true), adlerBytes(adler32(data))]);
  const ten = te.encode('0123456789');
  assert.equal(zlibBound(10), 26);
  const exact = streamOf(ten, 1), over = streamOf(ten, 2);                          // 2 + 5·k + 15 + 4: 26 at k = 1, 31 at k = 2
  assert.equal(exact.length, 26); assert.equal(over.length, 31);
  assert.deepEqual([...zlib.inflateSync(exact)], [...ten]); assert.deepEqual([...zlib.inflateSync(over)], [...ten], 'zlib itself accepts both: the bound is ours');

  // the empirical half of the bound: node's zlib (every level, strategy, memLevel 1/2/8/9 and windowBits 9/15 — the memLevel
  // 1 and 2 cases are the storelen/fixedlen regimes) never emits more than zlibBound(S) for S bytes, incompressible or not
  const rnd = n => { const b = new Uint8Array(n); let x = 0x9e3779b9 ^ n; for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = x & 0xff; } return b; };
  const inputs = [...Array.from({ length: 70 }, (_, n) => n), 127, 128, 255, 256, 1000, 4096, 65535, 65536, 1 << 20].flatMap(n => [rnd(n), new Uint8Array(n).fill(0x61), te.encode('ab'.repeat(n >> 1))]);
  let deflates = 0;
  for (const d of inputs) for (const level of [-1, 0, 1, 6, 9]) for (const strategy of [0, 1, 2, 3, 4]) for (const memLevel of d.length > 5000 ? [8] : [1, 2, 8, 9]) for (const windowBits of [9, 15]) {
    const z = zlib.deflateSync(d, { level, strategy, memLevel, windowBits }); deflates++;
    assert.ok(z.length <= zlibBound(d.length), `zlib emitted ${z.length} B for ${d.length} B (bound ${zlibBound(d.length)}) at level ${level} strategy ${strategy} memLevel ${memLevel} windowBits ${windowBits}`);
  }
  assert.ok(deflates > 10_000, `${deflates} deflates`);

  // inflate, end check: consumed > bound is pack_corrupt even though every block started inside the bound (at 2, 7, 12 ≤ 26).
  // `pos` is non-zero so the consumed count is measured from the stream's start, not the buffer's.
  const junk = new Uint8Array(7).fill(0xee);
  const ok = inflate(concat([junk, exact]), junk.length, { bound: declaredBound(10), wrap: zlibWrap(true) });
  assert.equal(ok.consumed, 26); assert.deepEqual([...ok.out], [...ten]);
  throws(() => inflate(concat([junk, over]), junk.length, { bound: declaredBound(10), wrap: zlibWrap(true) }), 'pack_corrupt', 'inflate: zlib stream longer than its declared size allows (31 > 26 for 10 bytes)');
  // without an expected size the output cap stands in for the declared size: zlibBound(14) = 30 < 31 = zlibBound(15)
  throws(() => inflate(over, 0, { bound: cappedBound(14), wrap: zlibWrap(true) }), 'pack_corrupt', 'inflate: zlib stream longer than its declared size allows (31 > 30 for 14 bytes)');
  assert.equal(inflate(over, 0, { bound: cappedBound(15), wrap: zlibWrap(true) }).consumed, 31);
  // an expected size of 0 is a size, not an absent one: zlibBound(0) = 13 (zlib's own empty stream is 8 bytes; a stored one 11)
  const empty = new Uint8Array(0);
  assert.equal(inflate(streamOf(empty, 0), 0, { bound: declaredBound(0), wrap: zlibWrap(true) }).consumed, 11);
  throws(() => inflate(streamOf(empty, 1), 0, { bound: declaredBound(0), wrap: zlibWrap(true) }), 'pack_corrupt', 'inflate: zlib stream longer than its declared size allows (16 > 13 for 0 bytes)');

  // inflate, block-start check (what ends an endless stream): zlibBound(2) = 17 and block boundaries fall at 2, 7, 12, 17, 22.
  // A stream cut at 17 is still "unexpected end" (17 is not past the bound); one cut at 22 is refused as too long before the
  // reader asks for more input; 1 MiB of empty stored blocks is refused by the same check at the same byte, in microseconds.
  const two = te.encode('ab');
  assert.equal(zlibBound(2), 17);
  const blocks = k => concat([Uint8Array.of(0x78, 0x01), ...emptyBlocks(k)]);
  throws(() => inflate(concat([junk, blocks(3)]), junk.length, { bound: declaredBound(2), wrap: zlibWrap(true) }), 'pack_corrupt', 'inflate: unexpected end of input');
  throws(() => inflate(concat([junk, blocks(4)]), junk.length, { bound: declaredBound(2), wrap: zlibWrap(true) }), 'pack_corrupt', 'inflate: zlib stream longer than its declared size allows (22 > 17 for 2 bytes)');
  assert.equal(inflate(streamOf(two, 0), 0, { bound: declaredBound(2), wrap: zlibWrap(true) }).consumed, 13);
  throws(() => inflate(streamOf(two, 1), 0, { bound: declaredBound(2), wrap: zlibWrap(true) }), 'pack_corrupt', 'inflate: zlib stream longer than its declared size allows (18 > 17 for 2 bytes)');
  const mib = new Uint8Array(1 << 20); mib.set([0x78, 0x01]); for (let i = 2; i + 5 <= mib.length; i += 5) mib.set([0, 0, 0, 0xff, 0xff], i);
  const t0 = performance.now();
  throws(() => inflate(mib, 0, { bound: declaredBound(2), wrap: zlibWrap(true) }), 'pack_corrupt', 'inflate: zlib stream longer than its declared size allows (22 > 17 for 2 bytes)');
  assert.ok(performance.now() - t0 < 100, 'the endless stream was walked, not refused');
  // parsePack (the buffered path) takes the same refusal through inflate for the first object
  const hostile = concat([Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION, 0, 0, 0, 1), encodeObjHeader(TYPE.BLOB, 2), blocks(20), new Uint8Array(20)]);
  throws(() => parsePack(hostile), 'pack_corrupt', 'inflate: zlib stream longer than its declared size allows (22 > 17 for 2 bytes)');

  // spStep: the streamed body is refused on the byte that takes the zlib bytes (the body minus the 20-byte trailer lag) past
  // the bound. The message carries no byte count, so it is the same whatever the chunking (I10, props.test.js).
  const packOf = z => { const body = concat([Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION, 0, 0, 0, 1), encodeObjHeader(TYPE.BLOB, 10), z]); return concat([body, new Sha1().update(body).digest()]); };
  const atBound = spFinish(spStep(spInit(), packOf(exact)).state);
  assert.equal(atBound.zlibBytes, 26); assert.equal(atBound.size, 10);
  const longer = 'pack: zlib stream longer than its declared size allows (10-byte object, 26-byte bound)';
  throws(() => spStep(spInit(), packOf(over)), 'pack_corrupt', longer);
  assert.throws(() => spStep(spInit(), packOf(over)), e => e.got === 31 && e.max === 26 && e.size === 10, 'the fields carry the count the message leaves out');
  const hdrLen = PACK_HEADER_BYTES + encodeObjHeader(TYPE.BLOB, 10).length;
  let sp = spInit(), at = -1;
  const bytes = packOf(over);
  for (let i = 0; i < bytes.length && at < 0; i++) {
    try { sp = spStep(sp, bytes.subarray(i, i + 1)).state; } catch (e) { assert.equal(e.code, 'pack_corrupt'); assert.equal(e.message, longer); assert.deepEqual([e.got, e.max, e.size], [27, 26, 10]); at = i; }
  }
  assert.equal(sp.zlibBytes, 26, 'the state before the refusing byte is exactly at the bound');
  assert.equal(at, hdrLen + 26 + 20, 'the 27th zlib byte is body byte 47 (20 of them are still the withheld trailer lag)');
});

// Every consumer of packStream (fetchSingle, fetchWide, fetchPackOnce, streamBlobEdit, openBlob, checkoutTree's streams)
// gets limits.maxPackBytes from v2Step, before the frame is yielded: band 1 as 'pack bytes', band 2 as 'progress bytes'.
// A consumer cannot forget the cap, and a missing limit is bad_request on the first frame.
const sidebandFrame = (n, len) => ({ kind: 'data', payload: concat([Uint8Array.of(n), new Uint8Array(len).fill(0x78)]) });
test('v2Step holds band 1 and band 2 to maxPackBytes, for every consumer of packStream', () => {
  const line = s => ({ kind: 'data', payload: te.encode(s) });
  const band = sidebandFrame;
  const limits = withLimits({ maxPackBytes: 10 });
  let st = v2Step(v2Init(limits), line('packfile')).state;
  const feed = f => { const r = v2Step(st, f); st = r.state; return r; };
  assert.equal(feed(band(SIDEBAND_PACK, 6)).pack.length, 6);
  assert.equal(feed(band(SIDEBAND_PACK, 4)).pack.length, 4);
  assert.equal(st.band1, 10);
  assert.equal(feed(band(SIDEBAND_PROGRESS, 10)).pack, null);
  assert.equal(st.band2, 10);
  assert.throws(() => feed(band(SIDEBAND_PACK, 1)), e => e.code === 'limit_exceeded' && e.message === 'pack bytes 11 exceeds limit 10' && e.what === 'pack bytes' && e.got === 11 && e.max === 10);
  assert.throws(() => feed(band(SIDEBAND_PROGRESS, 1)), e => e.code === 'limit_exceeded' && e.message === 'progress bytes 11 exceeds limit 10' && e.what === 'progress bytes' && e.got === 11 && e.max === 10);
  assert.equal(feed(band(SIDEBAND_PACK, 0)).pack.length, 0, 'an empty frame at the cap is not past it');
  throws(() => v2Step({ ...v2Init(), limits: { maxSectionLines: 1 } }, line('packfile')), 'bad_request', 'limits.maxPackBytes must be a finite non-negative number');
});

// receive-pack's band 2 (hook stderr, the host's explanation) is held to maxPackBytes: a flood of it used to be read until
// the request timer, with the tail kept but the bytes unbounded (issue #36). Since the push outcome space (I36) every
// response frame, band 1, 2 or 3, counts toward one 'report bytes' cap, and a limit hit after the body is sent is
// `ambiguous` (original `limit_exceeded`): the ref may have moved. (Merge of #49 and #51: #49's separate 'progress bytes'
// counter became this shared one.)
test('push holds band 2 to maxPackBytes, counted with its report', async () => {
  const band = sidebandFrame;
  const del = [{ ref: 'refs/heads/a', oldOid: oid(1), newOid: ZERO_OID }];
  const report = { kind: 'data', payload: concat([Uint8Array.of(SIDEBAND_PACK), pkt('unpack ok\n'), pkt('ok refs/heads/a\n'), FLUSH]) };
  const fl = [band(SIDEBAND_PROGRESS, 30), band(SIDEBAND_PROGRESS, 20), report, { kind: 'flush' }];
  const total = fl.reduce((n, f) => n + (f.payload?.length ?? 0), 0);
  const pushT = (frames, max) => ({ limits: withLimits({ maxPackBytes: max }), tracer: tracerStub, parent: null, async *frames() { yield* frames; } });
  const fits = await push(pushT(fl, total), { commands: del, sideband: true });
  assert.equal(fits.report.tag, "statuses"); assert.equal(fits.hookOutput.length, 50);
  await assert.rejects(push(pushT(fl, total - 1), { commands: del, sideband: true }),
    e => e.code === 'ambiguous' && e.original === 'limit_exceeded' && e.cause.what === 'report bytes' && e.cause.got === total && e.cause.max === total - 1);
  // an endless band 2 is cut at the cap, not read until the timer: reading stops on the frame that crosses it
  let pulled = 0;
  const flood = { limits: withLimits({ maxPackBytes: 10_000 }), tracer: tracerStub, parent: null, async *frames() { for (;;) { pulled++; yield band(SIDEBAND_PROGRESS, 999); } } };
  await assert.rejects(push(flood, { commands: del, sideband: true }), e => e.code === 'ambiguous' && e.original === 'limit_exceeded' && e.cause.what === 'report bytes' && e.cause.max === 10_000);
  assert.equal(pulled, 11, 'ten 1,000-byte frames fit, the eleventh crosses the cap');
});

test('push outcome (SAFETY.md I36): the exact report shapes, the decision, and the fields the enumerator does not compare', async () => {
  const two = [{ ref: 'refs/heads/a' }, { ref: 'refs/heads/b' }];
  const cls = (lines, commands = two) => classifyReport(lines.map(l => (typeof l === 'string' ? te.encode(l) : l)), commands);
  const why = (lines, commands) => cls(lines, commands).why;
  assert.equal(why([Uint8Array.of(0xff)]), 'a line is not one LF-terminated line');
  // a ref name's bytes >= 0x80 are legal to git and echoed as sent (#43): `\xff` is the ref the command spelled `\udcff`,
  // never one spelled with U+FFFD
  assert.equal(why([data('unpack ok\n'), data('ok refs/heads/', Uint8Array.of(0xff), '\n')], [{ ref: 'refs/heads/\ufffd' }]), 'status for a ref not commanded');
  assert.deepEqual(cls([data('unpack ok\n'), data('ok refs/heads/', Uint8Array.of(0xe9, 0xe8), '\n')], [{ ref: 'refs/heads/\udce9\udce8' }]), { tag: 'statuses', refs: [{ ref: 'refs/heads/\udce9\udce8', ok: true, reason: '' }] });
  assert.equal(why(['unpack ok\n', data('ng refs/heads/a caf', Uint8Array.of(0xe9), '\n'), 'ok refs/heads/b\n']), 'no readable reason for refs/heads/a');
  assert.equal(why(['unpack ok']), 'a line is not one LF-terminated line');
  assert.equal(why(['unpack ok\nx\n']), 'a line is not one LF-terminated line');
  for (const l of [[], ['unpack ok*\n'], ['ok refs/heads/a\n']]) assert.equal(why(l), 'no git unpack line first');
  assert.equal(why(['unpack ok\n', 'nf refs/heads/a hook declined\n', 'ok refs/heads/b\n']), 'a line is not a ref status');
  assert.equal(why(['unpack ok\n', 'ok refs/heads/zz\n', 'ok refs/heads/b\n']), 'status for a ref not commanded');
  assert.equal(why(['unpack ok\n', 'ok refs/heads/a\n', 'ok refs/heads/a\n']), 'two statuses for refs/heads/a');
  for (const r of ['', 'hook\x01declined', '\x01x', 'x\x01', 'caf\u00e9']) assert.equal(why(['unpack ok\n', `ng refs/heads/a ${r}\n`, 'ok refs/heads/b\n']), 'no readable reason for refs/heads/a', JSON.stringify(r));
  assert.equal(why(['unpack ok\n', 'ng refs/heads/a\n', 'ok refs/heads/b\n']), 'no readable reason for refs/heads/a');
  assert.equal(why(['unpack ok\n', 'ok refs/heads/a\n']), 'no status for refs/heads/b');
  assert.equal(why(['unpack index-pack abnormal exit\n', 'ok refs/heads/a\n', 'ng refs/heads/b unpacker error\n']), 'unpack failed, a ref is not "unpacker error"');
  assert.equal(why(['unpack ok\n', 'ok refs/heads/a\n', 'ng refs/heads/b unpacker error\n']), '"unpacker error" beside "unpack ok"');
  const unpackerRefs = [{ ref: 'refs/heads/a', ok: false, reason: 'unpacker error' }, { ref: 'refs/heads/b', ok: false, reason: 'unpacker error' }];
  for (const status of GIT_UNPACK_ERRORS) assert.deepEqual(cls([`unpack ${status}\n`, 'ng refs/heads/a unpacker error\n', 'ng refs/heads/b unpacker error\n']), { tag: 'unpackFailed', status, refs: unpackerRefs });
  assert.equal(GIT_UNPACK_ERRORS.length, 8);
  assert.deepEqual(cls(['unpack ok\n', 'ng refs/heads/b hook declined\n', 'ok refs/heads/a\n']), { tag: 'statuses', refs: [{ ref: 'refs/heads/b', ok: false, reason: 'hook declined' }, { ref: 'refs/heads/a', ok: true, reason: '' }] });

  const failed = { tag: 'unpackFailed', status: 'index-pack abnormal exit', refs: unpackerRefs };
  assert.deepEqual(decideOutcome(failed), { tag: 'rejected', code: 'push_rejected', refs: unpackerRefs.map(r => ({ ref: r.ref, reason: r.reason, cls: 'rejected' })) });
  assert.deepEqual(decideOutcome(failed, { pack: false }), { tag: 'ambiguous', why: 'unpack failed but no pack was sent' });
  assert.deepEqual(decideOutcome({ tag: 'malformed', why: 'w' }), { tag: 'ambiguous', why: 'w' });
  assert.deepEqual(decideOutcome({ tag: 'broken', why: 'b', remote: 'r' }), { tag: 'ambiguous', why: 'b' });
  // a shape outside the union is a programmer bug, not an outcome
  assert.throws(() => decideOutcome({ tag: 'weird' }), /unreachable/);
  // the refusal of an all-ng report, by the classes present (the old rejectionCode, now part of the outcome)
  const sts = (...rs) => ({ tag: 'statuses', refs: rs.map(([ref, ok, reason]) => ({ ref, ok, reason })) });
  const ngs = (...reasons) => sts(...reasons.map((r, i) => [`r${i}`, false, r]));
  const tagOf = shape => { const o = decideOutcome(shape); return o.tag === 'rejected' ? o.code : o.tag; };
  assert.equal(tagOf(ngs('failed to update ref')), 'cas_conflict');
  for (const r of ['xfailed to update ref', 'failed to update refs', 'a bad ref', 'bad refs']) assert.equal(tagOf(ngs(r)), 'push_rejected', r);
  assert.equal(tagOf({ tag: 'unpackFailed', status: 'unpack-objects abnormal exit', refs: [{ ref: 'r0', ok: false, reason: 'failed to update ref' }] }), 'push_rejected');
  assert.deepEqual(decideOutcome(ngs('stale ref')), { tag: 'rejected', code: 'cas_conflict', refs: [{ ref: 'r0', reason: 'stale ref', cls: 'cas' }] });
  // the class table (test/space/push-ng.space.js): an atomic CAS loss, git >= 2.51's batched texts, denyNonFastForwards,
  // a proc-receive hook that did not answer, and the precedence refusal > non-fast-forward > cas
  for (const r of ['atomic transaction failed', 'bad ref', 'incorrect old value provided', 'reference already exists', 'reference does not exist']) assert.equal(tagOf(ngs(r)), 'cas_conflict', r);
  for (const r of ['refname conflict', 'hook declined', 'funny refname', 'atomic push failure']) assert.equal(tagOf(ngs(r)), 'push_rejected', r);
  assert.equal(tagOf(ngs('non-fast-forward')), 'not_fast_forward');
  assert.equal(tagOf(ngs('non-fast-forward', 'atomic push failure')), 'not_fast_forward');
  assert.equal(tagOf(ngs('non-fast-forward', 'failed to update ref')), 'not_fast_forward');
  assert.equal(tagOf(ngs('non-fast-forward', 'hook declined')), 'push_rejected');
  assert.equal(tagOf(ngs('failed to update ref', 'atomic push failure')), 'cas_conflict');
  assert.equal(tagOf(ngs('fail to run proc-receive hook', 'hook declined')), 'ambiguous', 'a hook that may have acted outranks a refusal');
  assert.equal(tagOf(ngs('rejected: non-fast-forward')), 'cas_conflict', 'a host\'s wording keeps its heuristic');
  for (const [r, c] of [['proc-receive failed to report status', 'ambiguous'], ['fail to run proc-receive hook', 'ambiguous'], ['atomic push failure', 'innocent'], ['non-fast-forward', 'nff'], ['failed to lock', 'cas'], ['fetch first', 'cas'], ['x already exists', 'cas'], ['failed to lock x', 'rejected']]) assert.equal(ngClass(r), c, r);
  assert.deepEqual(decideOutcome(sts(['a', true, ''], ['b', false, 'fail to run proc-receive hook'])), { tag: 'ambiguous', why: 'proc-receive: fail to run proc-receive hook' });
  assert.deepEqual(decideOutcome(sts(['a', false, 'proc-receive failed to report status'])), { tag: 'ambiguous', why: 'proc-receive: proc-receive failed to report status' });
  assert.deepEqual(decideOutcome(sts(['a', false, 'non-fast-forward'])), { tag: 'rejected', code: 'not_fast_forward', refs: [{ ref: 'a', reason: 'non-fast-forward', cls: 'nff' }] });

  // the outcome as a Result: the error a caller matches on, per tag
  const ctx = { report: null, hookOutput: 'h', remote: undefined, commands: [{ ref: 'a', oldOid: oid(1), newOid: oid(2) }, { ref: 'b', oldOid: ZERO_OID, newOid: oid(2) }] };
  assert.deepEqual(outcomeResult({ tag: 'landed' }, ctx), { ok: true, value: null });
  const errOf = (o, c = ctx) => { const r = outcomeResult(o, c); assert.equal(r.ok, false); return r.error; };
  const ref = (name, reason, c) => ({ ref: name, reason, cls: c });
  let e = errOf({ tag: 'rejected', code: 'push_rejected', refs: [ref('a', 'hook declined', 'rejected')] });
  assert.deepEqual([e.code, e.message, e.hookOutput, e.report], ['push_rejected', 'push rejected: hook declined', 'h', null]);
  e = errOf({ tag: 'rejected', code: 'not_fast_forward', refs: [ref('a', 'non-fast-forward', 'nff')] });
  assert.deepEqual([e.code, e.message], ['not_fast_forward', 'push rejected: non-fast-forward']);
  // cas_conflict: expected is the culprit's own old oid (null for a create), actual unknown (receive-pack does not say)
  e = errOf({ tag: 'rejected', code: 'cas_conflict', refs: [ref('a', 'atomic push failure', 'innocent'), ref('b', 'reference already exists', 'cas')] });
  assert.deepEqual([e.code, e.message, e.expected, e.actual], ['cas_conflict', 'push rejected: atomic push failure', null, null]);
  e = errOf({ tag: 'rejected', code: 'cas_conflict', refs: [ref('a', 'stale ref', 'cas')] });
  assert.deepEqual([e.expected, e.actual], [oid(1), null]);
  e = errOf({ tag: 'partial', landed: ['a'], rejected: [ref('b', 'hook declined', 'rejected')] });
  assert.deepEqual([e.code, e.message, e.landed, e.rejected[0].ref], ['push_partial', 'push partially applied: a updated; b (hook declined) refused', ['a'], 'b']);
  e = errOf({ tag: 'ambiguous', why: 'w' });
  assert.deepEqual([e.code, e.message, e.original], ['ambiguous', 'push outcome unknown: w', undefined]);
  e = errOf({ tag: 'ambiguous', why: 'band 3' }, { ...ctx, remote: 'boom' });
  assert.deepEqual([e.code, e.message, e.original], ['ambiguous', 'push outcome unknown: remote: boom: band 3', 'remote_error']);
  assert.throws(() => outcomeResult({ tag: 'weird' }, ctx), /unreachable/);

  // the report state machine: absorbing malformed, one status per ref, the finish checks
  let rst = reportInit([{ ref: 'a' }]);
  assert.deepEqual(reportFinish(rst), { tag: 'malformed', why: 'no git unpack line first' });
  rst = reportStep(rst, te.encode('unpack ok\n'));
  assert.equal(rst.tag, 'refs');
  assert.deepEqual(reportFinish(rst), { tag: 'malformed', why: 'no status for a' });
  const bad = reportStep(rst, te.encode('xx\n'));
  assert.equal(reportStep(bad, te.encode('ok a\n')), bad);
  assert.throws(() => reportStep({ tag: 'weird' }, te.encode('x\n')), /unreachable/);
  assert.throws(() => reportFinish({ tag: 'weird' }), /unreachable/);

  // the checked capabilities: the request asks for atomic / push-options only from them
  const caps = (...c) => new Set(c);
  assert.deepEqual(requestCaps([{ ref: 'a', oldOid: oid(1), newOid: ZERO_OID }], {}), ['report-status', 'side-band-64k', 'delete-refs', 'agent=ply/0.1.0']);
  assert.deepEqual(requestCaps([{ ref: 'a', oldOid: oid(1), newOid: oid(2) }], { sideband: false, reportV2: true }, orThrow(checkPushCaps(caps('atomic', 'push-options'), { atomic: true, pushOptions: ['o'] }))), ['report-status-v2', 'atomic', 'push-options', 'agent=ply/0.1.0']);
  assert.deepEqual(requestCaps([{ ref: 'a', oldOid: oid(1), newOid: oid(2) }], {}, orThrow(checkPushCaps(caps(), {}))), ['report-status', 'side-band-64k', 'agent=ply/0.1.0']);
  assert.equal(capsProblem(caps('atomic')), null);
  assert.deepEqual(capsProblem(caps('object-format=sha256', 'atomic'), { atomic: true }), { tag: 'objectFormat', format: 'sha256' });
  assert.deepEqual(capsProblem(caps('object-format=sha1'), { atomic: true }), { tag: 'noAtomic' });
  assert.deepEqual(capsProblem(caps('atomic'), { atomic: true, pushOptions: ['x'] }), { tag: 'noPushOptions' });
  assert.equal(capsProblem(caps(), { pushOptions: [] }), null);
  const unsup = checkPushCaps(caps('agent=x'), { pushOptions: ['x'] });
  assert.deepEqual([unsup.ok, unsup.error.code, unsup.error.message, unsup.error.caps], [false, 'unsupported', 'server does not advertise push-options', ['agent=x']]);
  assert.equal(checkPushCaps(caps('object-format=sha256')).error.message, 'server repository is object-format sha256');
  assert.equal(checkPushCaps(caps(), { atomic: true }).error.message, 'server does not advertise atomic');
  assert.deepEqual(orThrow(checkPushCaps(caps('push-options'), { pushOptions: ['p'] })), { atomic: false, pushOptions: ['p'] });
  // pushWithOptions reads the advertisement only when the push asks for atomic or push options
  let adverts = 0;
  const advertised = advertCaps => ({ limits: DEFAULT_LIMITS, tracer: tracerStub, parent: null,
    async advertise() { adverts++; return concat([pkt(`${oid(1)} refs/heads/a\0${advertCaps}\n`), FLUSH]); },
    async *frames() { yield { kind: 'data', payload: te.encode('unpack ok\n') }; yield { kind: 'data', payload: te.encode('ok refs/heads/a\n') }; yield { kind: 'flush' }; } });
  const del1 = { commands: [{ ref: 'refs/heads/a', oldOid: oid(1), newOid: ZERO_OID }], sideband: false };
  assert.equal((await pushWithOptions(advertised('report-status'), del1)).report.tag, 'statuses'); assert.equal(adverts, 0);
  await assert.rejects(pushWithOptions(advertised('report-status'), { ...del1, atomic: true }), e2 => e2.code === 'unsupported' && e2.caps.join() === 'report-status'); assert.equal(adverts, 1);
  assert.equal((await pushWithOptions(advertised('report-status atomic'), { ...del1, atomic: true })).report.tag, 'statuses'); assert.equal(adverts, 2);
  assert.deepEqual(parseReceiveAdvert([{ kind: 'flush' }]), { ok: true, value: new Set() });
  // parseReceiveAdvert, line by line (connect.c get_remote_heads)
  const dat = l => ({ kind: 'data', payload: typeof l === 'string' ? te.encode(l) : l });
  const FL = { kind: 'flush' };
  const advErr = (frames, message) => { const r = parseReceiveAdvert(frames); assert.equal(r.ok, false, message); assert.deepEqual([r.error.code, r.error.message], ['protocol', message]); };
  const advOk = (frames, capsWant) => { const r = parseReceiveAdvert(frames); assert.equal(r.ok, true, JSON.stringify(r.error?.message)); assert.deepEqual([...r.value], capsWant); };
  advErr([dat('# service=git-receive-pack\n'), dat(`${oid(1)} refs/heads/a\n`)], 'advertisement: no flush after the service header');
  advOk([dat('# service=git-receive-pack\n'), FL, dat(`${oid(1)} refs/heads/a\0report-status atomic\n`), FL], ['report-status', 'atomic']);
  // v2 answer (Artifacts): held to the v2 shape, no v0 caps; a v2 shape broken is parseCapabilitiesV2's typed error
  advOk([dat('version 2\n'), dat('agent=x\n'), FL], []);
  advOk([dat('version 2'), dat('agent=x\n'), FL], []);
  assert.throws(() => parseReceiveAdvert([dat('version 2\n'), dat('agent=x\n')]), e => e.code === 'protocol');
  advErr([dat('\nversion 2'), FL], 'receive-pack advertisement: unexpected line "\\nversion 2"');
  advErr([dat(`${oid(1)} refs/heads/a\n`)], 'receive-pack advertisement: no flush after the refs');
  advErr([dat(`${oid(1)} refs/heads/a\n`), { kind: 'delim' }, FL], 'receive-pack advertisement: invalid packet (delim)');
  advErr([dat('bogus\n'), FL], 'receive-pack advertisement: unexpected line "bogus"');
  advErr([dat(`${'x'.repeat(70)}\n`), FL], `receive-pack advertisement: unexpected line "${'x'.repeat(60)}"`);
  // only the trailing LF is the line's; a caps value keeps an inner one
  advOk([dat(`${oid(1)} refs/heads/a\0agent=a\nb`), FL], ['agent=a\nb']);
  // the caps ride on the first line only, after its NUL; a shallow line may carry them
  advOk([dat(`shallow ${oid(1)}\0report-status\n`), FL], ['report-status']);
  advOk([dat(`${oid(1)} refs/heads/a\0report-status\n`), dat(`${oid(2)} refs/heads/b\0extra\n`), FL], ['report-status']);
  advOk([dat(`${oid(1)} refs/heads/a\n`), dat(`${oid(2)} refs/heads/b\0extra\n`), FL], []);
  advErr([dat('\0report-status\n'), FL], 'receive-pack advertisement: unexpected line ""');
  advOk([dat(`${oid(1)} refs/heads/a\0 report-status atomic \n`), FL], ['report-status', 'atomic']);
  // object-format=sha256 widens every oid to 64 hex
  advOk([dat(`${'ab'.repeat(32)} refs/heads/a\0object-format=sha256\n`), dat(`${'cd'.repeat(32)} refs/heads/b\n`), FL], ['object-format=sha256']);
  advErr([dat(`${'ab'.repeat(32)} refs/heads/a\0report-status\n`), FL], `receive-pack advertisement: unexpected line "${'ab'.repeat(30)}"`);

  // band 2 is kept as a 4096-character tail, counted per frame
  let st = streamInit(true);
  assert.equal(st.band2, '');
  for (const n of [3000, 2000]) st = streamStep(st, { kind: 'data', payload: data(Uint8Array.of(2), 'x'.repeat(n - 1) + 'y') });
  assert.equal(st.band2.length, 4096); assert.ok(st.band2.endsWith('xy')); assert.equal(st.band2Frames, 2);

  // through push(): the error a caller sees
  const sb = (...frames) => ({ limits: DEFAULT_LIMITS, tracer: tracerStub, parent: null, async *frames() { for (const f of frames) yield f === null ? { kind: 'flush' } : { kind: 'data', payload: f }; } });
  const band = (b, ...parts) => data(Uint8Array.of(b), ...parts);
  const report = (...lines) => band(1, ...lines.map(l => pkt(l)), FLUSH);
  const del = { commands: [{ ref: 'refs/heads/a', oldOid: oid(1), newOid: ZERO_OID }], sideband: true };
  await assert.rejects(push(sb(band(2, 'hook says hi\n'), band(3, ' boom \n'), null), del), e => e.code === 'ambiguous' && e.message === 'push outcome unknown: remote: boom: band 3' && e.original === 'remote_error' && e.hookOutput === 'hook says hi\n');
  await assert.rejects(push(sb(report('unpack ok*\n', 'ok refs/heads/a\n'), null), del), e => e.code === 'ambiguous' && e.message === 'push outcome unknown: no git unpack line first' && e.original === undefined && e.report === null);
  await assert.rejects(push(sb(report('unpack ok\n', 'ok refs/heads/a\n'), null, null), del), e => e.code === 'ambiguous' && e.message === 'push outcome unknown: data after the final flush');
  await assert.rejects(push(sb(report('unpack ok\n', 'ng refs/heads/a hook declined\n'), null), del), e => e.code === 'push_rejected' && e.message === 'push rejected: hook declined');
  const many = { ...sb(report('unpack ok\n', 'ok refs/heads/a\n'), null), limits: withLimits({ maxReportLines: 1 }) };
  await assert.rejects(push(many, del), e => e.code === 'ambiguous' && e.original === 'limit_exceeded' && e.cause.what === 'report lines' && e.cause.got === 2);
  const big = { ...sb(report('unpack ok\n', 'ok refs/heads/a\n'), null), limits: withLimits({ maxPackBytes: 20 }) };
  await assert.rejects(push(big, del), e => e.code === 'ambiguous' && e.original === 'limit_exceeded' && e.cause.what === 'report bytes');
  const fits = { ...sb(report('unpack ok\n', 'ok refs/heads/a\n'), null), limits: withLimits({ maxPackBytes: 39 }) }; // the report frame's payload is exactly 39 bytes
  const ok = await push(fits, del);
  assert.deepEqual(ok.report, { tag: 'statuses', refs: [{ ref: 'refs/heads/a', ok: true, reason: '' }] }); assert.equal(ok.hookOutput, '');
});

// A commit-only v2 server over a hand graph ({ name: [parent names] }), answering `want` + `deepen N` + `filter tree:0`
// as upload-pack does: the commits within N of the want (the want is depth 1), those at depth N as `shallow` lines; a
// want of the empty tree answers it; ls-refs from `t.refs`; receive-pack answers every command `ok` and moves the ref
// (the pack is not inspected) — enough for mergeBase and rebaseBranch. Ported from research/18 (7b21380).
function graphServer(edges) {
  const author = ident(validateIdent({ name: 'g', email: 'g@x', time: 1700000000 }));
  const tree = hashObject('tree', new Uint8Array(0));
  const oids = new Map(), datas = new Map();
  const build = name => { if (oids.has(name)) return oids.get(name); const d = encodeCommit({ tree, parents: edges[name].map(build), author, committer: author, message: `${name}\n` }); const o = hashObject('commit', d); oids.set(name, o); datas.set(o, d); return o; };
  for (const name of Object.keys(edges)) build(name);
  const parentsOf = new Map([...oids].map(([name, o]) => [o, edges[name].map(n => oids.get(n))]));
  const requests = [];
  const line = str => ({ kind: 'data', payload: te.encode(str) });
  const sideband = b => ({ kind: 'data', payload: concat([Uint8Array.of(SIDEBAND_PACK), b]) });
  const t = { limits: DEFAULT_LIMITS, tracer: new Tracer(), parent: null, objects: new Map(), quirks: {}, requests, refs: new Map(), url: 'stub://graph',
    async *frames(service, body) {
      // the pkt-lines up to the first flush (a receive-pack body carries the raw pack after it)
      const lines = []; for (let p = 0; p + 4 <= body.length;) { const n = parseInt(td.decode(body.subarray(p, p + 4)), 16); if (n === 0) break; if (n > 1) lines.push(td.decode(body.subarray(p + 4, p + n)).replace(/\n$/, '')); p += Math.max(n, 4); }
      if (service === 'git-receive-pack') { yield sideband(pkt('unpack ok\n')); for (const l of lines) { const m = /^[0-9a-f]{40} ([0-9a-f]{40}) ([^\0 ]+)/.exec(l); if (m) { t.refs.set(m[2], m[1]); yield sideband(pkt(`ok ${m[2]}\n`)); } } yield sideband(FLUSH); yield { kind: 'flush' }; return; } // git's shape: the report's flush inside band 1, then the outer flush (I36)
      if (lines[0] === 'command=ls-refs') { const prefixes = lines.filter(l => l.startsWith('ref-prefix ')).map(l => l.slice(11)); for (const [ref, o] of t.refs) if (prefixes.some(p => ref.startsWith(p))) yield line(`${o} ${ref}\n`); yield { kind: 'flush' }; return; }
      const want = lines.find(l => l.startsWith('want '))?.slice(5), deepen = +(lines.find(l => l.startsWith('deepen '))?.slice(7) ?? 0);
      const filter = lines.find(l => l.startsWith('filter '))?.slice(7) ?? null;
      requests.push({ want, deepen, filter });
      if (want === tree) { const { pack } = await buildPack([{ type: TYPE.TREE, data: new Uint8Array(0) }]); yield line('packfile\n'); yield sideband(pack); yield { kind: 'flush' }; return; }
      const depth = new Map([[want, 1]]); const q = [want];
      for (let i = 0; i < q.length; i++) { const c = q[i]; if (depth.get(c) >= deepen) continue; for (const p of parentsOf.get(c) ?? []) if (!depth.has(p)) { depth.set(p, depth.get(c) + 1); q.push(p); } }
      const window = [...depth.keys()], shallow = window.filter(c => depth.get(c) === deepen && parentsOf.get(c).length);
      const { pack } = await buildPack(window.map(c => ({ type: TYPE.COMMIT, data: datas.get(c) })));
      if (shallow.length) { yield line('shallow-info\n'); for (const c of shallow) yield line(`shallow ${c}\n`); yield { kind: 'delim' }; }
      yield line('packfile\n');
      for (let i = 0; i < pack.length; i += 65000) yield sideband(pack.subarray(i, Math.min(i + 65000, pack.length)));
      yield { kind: 'flush' };
    } };
  return { t, oid: name => oids.get(name) };
}
const chain = (name, n, below) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${name}${i + 1}`, [i + 1 < n ? `${name}${i + 2}` : below]]));

test('a missing ref is not_found with a ref miss, for attributes and for rebase', async () => {
  const s = graphServer({ root: [] });
  const gone = { kind: 'ref', ref: 'refs/heads/gone', candidates: ['refs/heads/gone'] };
  s.t.refs.set('refs/heads/main', s.oid('root'));
  s.t.refs.set('refs/heads/feat', s.oid('root'));
  assert.match(await attributeTree(s.t, 'refs/heads/main', {}), /^[0-9a-f]{40}$/);
  const same = await mergeBranch('stub://graph', { ref: 'refs/heads/main', from: 'refs/heads/feat', author: { name: 'm', email: 'm@x' }, time: 1700000000 }, { transport: s.t, tracer: s.t.tracer });
  assert.equal(same.outcome, 'up_to_date');
  await assert.rejects(mergeBranch('stub://graph', { ref: 'refs/heads/main', from: 'refs/heads/gone', author: { name: 'm', email: 'm@x' }, time: 1700000000 }, { transport: s.t, tracer: s.t.tracer }), e => e.code === 'not_found' && e.message === 'ref refs/heads/gone not found' && e.miss?.kind === 'ref' && e.miss.ref === 'refs/heads/gone');
  s.t.refs.delete('refs/heads/main');
  s.t.refs.delete('refs/heads/feat');
  await assert.rejects(attributeTree(s.t, 'refs/heads/gone', {}), e => e.code === 'not_found' && e.message === 'attributes ref refs/heads/gone not found' && e.miss.kind === 'ref' && e.miss.ref === gone.ref && e.miss.candidates.length === 1 && e.miss.candidates[0] === gone.ref);
  await assert.rejects(mergeBranch('stub://graph', { ref: 'refs/heads/gone', from: 'refs/heads/main', author: { name: 'm', email: 'm@x' }, time: 1700000000 }, { transport: s.t, tracer: s.t.tracer }), e => e.code === 'not_found' && e.message === 'ref refs/heads/gone not found' && e.miss?.kind === 'ref' && e.miss.ref === 'refs/heads/gone' && e.miss.candidates[0] === 'refs/heads/gone');
  await assert.rejects(rebaseBranch('stub://graph', { ref: 'refs/heads/gone', onto: 'refs/heads/main', committer: { name: 'r', email: 'r@x' }, time: 1700000000 }, { transport: s.t, tracer: s.t.tracer }), e => e.code === 'not_found' && e.message === 'ref refs/heads/gone not found' && e.miss.kind === 'ref' && e.miss.ref === 'refs/heads/gone');
  s.t.refs.set('refs/heads/feat', s.oid('root'));
  await assert.rejects(rebaseBranch('stub://graph', { ref: 'refs/heads/feat', onto: 'refs/heads/main', committer: { name: 'r', email: 'r@x' }, time: 1700000000 }, { transport: s.t, tracer: s.t.tracer }), e => e.code === 'not_found' && e.message === 'ref refs/heads/main not found' && e.miss.ref === 'refs/heads/main' && e.miss.candidates[0] === 'refs/heads/main');
});

test('#41/#42: the merge-base window\'s cut — rebase fetches a base it was only named, and a cut below two candidates deepens', async () => {
  // #41: the base exactly at the window's cut (8 a side) is named by both sides' children, never fetched by mergeBase; it
  // is fetched once (deepen 1) before the first replay. With the base inside the window (7) it is not fetched again.
  for (const n of [8, 7]) {
    const s = graphServer({ root: [], ...chain('f', n, 'root'), ...chain('m', n, 'root') });
    s.t.refs.set('refs/heads/feat', s.oid('f1')); s.t.refs.set('refs/heads/main', s.oid('m1'));
    const res = await rebaseBranch('stub://graph', { ref: 'refs/heads/feat', onto: 'refs/heads/main', committer: { name: 'r', email: 'r@x' }, time: 1700000000 }, { transport: s.t, tracer: s.t.tracer });
    assert.deepEqual([res.outcome, res.commits, res.base, res.onto], ['rebase', n, s.oid('root'), s.oid('m1')]);
    assert.equal(s.t.refs.get('refs/heads/feat'), res.oid, 'the branch was force-updated to the new tip');
    assert.equal(s.t.requests.filter(q => q.want === s.oid('root') && q.deepen === 1).length, n === 8 ? 1 : 0, 'base fetched once at the cut (n=8), not when the window held it (n=7)');
  }
  // #42: a,b → [c, z]; c → p1..p6 → x → z. Depth 8 cuts x: {c, z} looks criss-cross; one more window shows z below c.
  { const s = graphServer({ a: ['c', 'z'], b: ['c', 'z'], ...chain('p', 6, 'x'), c: ['p1'], x: ['z'], z: [] });
    const res = await mergeBase(s.t, s.oid('a'), s.oid('b'));
    assert.deepEqual([res.base, res.bases, res.depth], [s.oid('c'), [s.oid('c')], 16]); }
  // a true criss-cross with nothing cut below it is final at the first window (two bases, not a deeper search)
  { const s = graphServer({ a: ['x', 'y'], b: ['y', 'x'], x: ['r'], y: ['r'], r: [] });
    const res = await mergeBase(s.t, s.oid('a'), s.oid('b'));
    assert.deepEqual([res.base, res.bases, res.depth], [null, [s.oid('x'), s.oid('y')].sort(), 8]); }
  // ...nor over deep shared history: a cut both bases reach cannot join them (the research rule deepened to the cap here:
  // limit_exceeded where git answers two bases)
  { const s = graphServer({ a: ['x', 'y'], b: ['y', 'x'], x: ['h1'], y: ['h1'], ...chain('h', 40, 'r'), r: [] });
    const res = await mergeBase(s.t, s.oid('a'), s.oid('b'), { maxDepth: 16 });
    assert.deepEqual([res.base, res.bases, res.depth], [null, [s.oid('x'), s.oid('y')].sort(), 8]); }
  // a single base over a settled cut stays final at the first window
  { const s = graphServer({ a: ['c'], b: ['c'], ...chain('p', 9, 'r'), c: ['p1'], r: [] });
    const res = await mergeBase(s.t, s.oid('a'), s.oid('b'));
    assert.deepEqual([res.base, res.depth], [s.oid('c'), 8]); }
  const G = o => new Map(Object.entries(o).map(([k, parents]) => [k, { parents }]));
  assert.deepEqual(bestBases(G({ a: ['c', 'z'], b: ['c', 'z'], c: ['x'], z: [] }), 'a', 'b'), { best: ['c', 'z'], truncated: true });
  assert.deepEqual(bestBases(G({ a: ['c', 'z'], b: ['c', 'z'], c: ['x'], z: ['x'] }), 'a', 'b'), { best: ['c', 'z'], truncated: false }, 'a cut both bases reach');
  assert.deepEqual(bestBases(G({ a: ['c', 'z'], b: ['c', 'z'], c: ['x'], z: ['w'] }), 'a', 'b'), { best: ['c', 'z'], truncated: true }, 'each base reaches a cut the other does not');
});

test('parseOid is 40 lowercase hex; parseCommitId also refuses the zero oid', () => {
  const code = n => String.fromCharCode(n);
  const place = (i, ch) => `${'b'.repeat(i)}${ch}${'b'.repeat(OID_HEX_CHARS - 1 - i)}`;
  const refused = (fn, value) => {
    const r = fn(value);
    assert.equal(r.ok, false);
    if (r.ok) return null;
    assert.equal(r.error.code, 'bad_request');
    return r.error;
  };
  const accepted = value => {
    const r = parseOid(value);
    assert.equal(r.ok, true, typeof value === 'string' ? JSON.stringify(value) : typeof value);
    if (!r.ok) return '';
    assert.equal(r.value, value);
    assert.equal(typeof r.value, 'string');
    return r.value;
  };
  assert.equal(accepted(code(HEX_DIGIT_MIN).repeat(OID_HEX_CHARS)), ZERO_OID);
  assert.equal(ZERO_OID, '0'.repeat(OID_HEX_CHARS));
  accepted(code(HEX_DIGIT_MAX).repeat(OID_HEX_CHARS));
  accepted(code(HEX_LOWER_MIN).repeat(OID_HEX_CHARS));
  accepted(code(HEX_LOWER_MAX).repeat(OID_HEX_CHARS));
  accepted(place(0, code(HEX_DIGIT_MIN)));
  accepted(place(OID_HEX_CHARS - 1, code(HEX_LOWER_MAX)));
  for (const ch of [code(HEX_DIGIT_MIN - 1), code(HEX_DIGIT_MAX + 1), code(HEX_LOWER_MIN - 1), code(HEX_LOWER_MAX + 1), 'A', 'F']) {
    for (const i of [0, 7, OID_HEX_CHARS - 1]) {
      const e = refused(parseOid, place(i, ch));
      assert.equal(e.message, 'oid must be lowercase hex');
      assert.equal(e.what, 'oid');
      assert.equal(e.got, place(i, ch));
    }
  }
  for (const value of ['', 'b'.repeat(OID_HEX_CHARS - 1), 'b'.repeat(OID_HEX_CHARS + 1)]) {
    const e = refused(parseOid, value);
    assert.equal(e.message, `oid must be ${OID_HEX_CHARS} lowercase hex characters`);
    assert.equal(e.what, 'oid');
    assert.equal(e.got, value);
  }
  for (const value of [1, null, undefined, true, {}, [], Object('b'.repeat(OID_HEX_CHARS))]) {
    const e = refused(parseOid, value);
    assert.equal(e.message, 'oid must be a string');
    assert.equal(e.what, 'oid');
    assert.equal(e.got, value);
  }
  const short = refused(parseCommitId, 'b'.repeat(OID_HEX_CHARS - 1));
  assert.equal(short.message, `oid must be ${OID_HEX_CHARS} lowercase hex characters`);
  assert.equal(short.what, 'oid');
  assert.equal(short.got, 'b'.repeat(OID_HEX_CHARS - 1));
  const zero = refused(parseCommitId, ZERO_OID);
  assert.equal(zero.message, 'the zero oid is not a commit');
  assert.equal(zero.what, 'commit');
  assert.equal(zero.got, ZERO_OID);
  const leading = `${code(HEX_DIGIT_MIN)}${'c'.repeat(OID_HEX_CHARS - 1)}`;
  const kept = parseCommitId(leading);
  assert.equal(kept.ok, true);
  if (kept.ok) assert.equal(kept.value, leading);
});

test('validatePushRef: receive-pack\'s funny refname (the cells test/space/refname.test.js observes from git)', () => {
  const ok = (ref, del) => { try { return validatePushRef(ref, del) === ref; } catch (e) { assert.equal(e.code, 'bad_request'); assert.equal(e.what, 'ref'); return false; } };
  // [ref, create accepted, delete accepted]: git v2.50.0 receive-pack's answers (the space's cells; a..b and a name outside refs/ by receive-pack.c:1477)
  for (const [ref, create, del] of [['refs/a', false, true], ['refs/@', false, false], ['refs/@a', false, true], ['refs/-a', false, true],
    ['refs/a/b', true, true], ['refs/@/a', true, true], ['refs/a/@', true, true], ['refs/heads/x', true, true], ['refs/a/b/c', true, true], ['refs/a..b/c', false, false], ['heads/a/b', false, false]]) {
    assert.equal(ok(ref, false), create, `${ref} create`);
    assert.equal(ok(ref, true), del, `${ref} delete`);
  }
});

// T3 noticed these and left them: a null throw in verifyRef became a TypeError, redirect cancel() was not awaited,
// a 2xx with no body was `network`, and spStep matched the short-read message instead of reason (#76, emitted by #99).
test('T3 transport: null read-back is ambiguous, cancel is awaited, a 2xx with no body is protocol, short reads switch on reason', async () => {
  const root = { set() {} };
  const ref = 'refs/heads/main';
  const expected = 'a'.repeat(40);
  const readBack = async (thrown) => verifyRef({ get limits() { throw thrown; } }, root, 'git.edit', ref, expected).then(() => null, e => e);
  const eNull = await readBack(null);
  assert.equal(eNull.code, 'ambiguous');
  assert.equal(eNull.message, 'push reported ok but the verification read-back failed: null');
  assert.equal(eNull.cause, null);
  assert.equal(eNull.original, undefined);
  const eUndef = await readBack(undefined);
  assert.equal(eUndef.code, 'ambiguous');
  assert.equal(eUndef.message, 'push reported ok but the verification read-back failed: undefined');
  const boom = Object.assign(new Error('boom'), { code: 'network' });
  const eBoom = await readBack(boom);
  assert.equal(eBoom.code, 'ambiguous');
  assert.equal(eBoom.message, 'push reported ok but the verification read-back failed: boom');
  assert.equal(eBoom.original, 'network');
  assert.equal(eBoom.cause, boom);
  const eStr = await readBack('nope');
  assert.equal(eStr.code, 'ambiguous');
  assert.equal(eStr.message, 'push reported ok but the verification read-back failed: nope');
  // an empty message is still the message: `??` keeps it, `||` would stringify the Error ("Error")
  const eEmpty = await readBack(Object.assign(new Error(''), { code: 'network' }));
  assert.equal(eEmpty.message, 'push reported ok but the verification read-back failed: ');
  assert.equal(eEmpty.original, 'network');

  const unhandled = [];
  const onUnhandled = (err) => { unhandled.push(err); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const held = () => {
      let release;
      const gate = new Promise(r => { release = r; });
      let started;
      const startedP = new Promise(r => { started = r; });
      const body = { cancel: () => { started(); return gate.then(() => { throw new Error('cancel rejected'); }); } };
      return { body, startedP, release: () => release() };
    };
    const postHold = held();
    const http = createTransport('http://127.0.0.1:9/r.git', {
      fetchImpl: async () => ({
        ok: false, status: 302, type: 'basic',
        headers: { get: n => (n === 'location' ? 'http://127.0.0.1:9/moved.git/git-upload-pack' : null) },
        body: postHold.body,
      }),
      tracer: tracerStub,
    });
    let settled = false;
    const pending = (async () => { for await (const frame of http.frames('git-upload-pack', new Uint8Array(0), spanStub)) void frame; })();
    pending.then(() => { settled = true; }, () => { settled = true; });
    await postHold.startedP;
    assert.equal(settled, false, 'a redirect waits until body.cancel() settles');
    postHold.release();
    const redir = await pending.then(() => null, e => e);
    assert.equal(redir.code, 'http');
    assert.match(redir.message, /redirected to http:\/\/127\.0\.0\.1:9\/moved\.git\/git-upload-pack/);

    const advHold = held();
    const declared = createTransport('http://127.0.0.1:9/r.git', {
      fetchImpl: async () => ({
        ok: true, status: 200,
        headers: { get: n => (n === 'content-type' ? 'application/x-git-upload-pack-advertisement' : n === 'content-length' ? '999999999' : null) },
        body: advHold.body,
      }),
      limits: withLimits({ maxPackBytes: 2500 }), tracer: tracerStub,
    });
    let advSettled = false;
    const advPending = declared.advertise('git-upload-pack', spanStub);
    advPending.then(() => { advSettled = true; }, () => { advSettled = true; });
    await advHold.startedP;
    assert.equal(advSettled, false, 'an over-cap advertisement waits until body.cancel() settles');
    advHold.release();
    const adv = await advPending.then(() => null, e => e);
    assert.equal(adv.code, 'limit_exceeded');
    assert.equal(adv.what, 'advertisement bytes');
    await new Promise(r => { setImmediate(r); });
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  const reply = (status, contentType, body) => createTransport('http://127.0.0.1:9/r.git', {
    fetchImpl: async () => ({ ok: status >= 200 && status < 300, status, headers: { get: n => (n === 'content-type' ? contentType : null) }, body }),
    tracer: tracerStub,
  });
  const drain = t => (async () => { for await (const frame of t.frames('git-upload-pack', new Uint8Array(0), spanStub)) void frame; })().then(() => null, e => e);
  const post = await drain(reply(200, 'application/x-git-upload-pack-result', null));
  assert.equal(post.code, 'protocol');
  assert.equal(post.message, 'git-upload-pack: HTTP 200 response has no body');
  const postUndef = await drain(reply(200, 'application/x-git-upload-pack-result', undefined));
  assert.equal(postUndef.message, 'git-upload-pack: HTTP 200 response has no body');
  const wrongType = await drain(reply(200, 'text/html', null));
  assert.equal(wrongType.code, 'not_git');
  const empty = new ReadableStream({ start(c) { c.close(); } });
  let frames = 0;
  for await (const _frame of reply(200, 'application/x-git-upload-pack-result', empty).frames('git-upload-pack', new Uint8Array(0), spanStub)) frames++;
  assert.equal(frames, 0, 'an empty body is bytes, not a missing body');
  const advNull = await reply(200, 'application/x-git-upload-pack-advertisement', null).advertise('git-upload-pack', spanStub).then(() => null, e => e);
  assert.equal(advNull.code, 'protocol');
  assert.equal(advNull.message, 'git-upload-pack advertisement: HTTP 200 response has no body');
  const advEmpty = await reply(200, 'application/x-git-upload-pack-advertisement', new ReadableStream({ start(c) { c.close(); } })).advertise('git-upload-pack', spanStub);
  assert.equal(advEmpty.length, 0);

  const shaped = (message, reason, code = 'pack_corrupt') => Object.assign(new Error(message), { code, reason });
  assert.equal(isShortRead(shaped('not the short-read text', 'short_read')), true);
  assert.equal(isShortRead(shaped('short read: need 1 bytes at 0, have 0')), false);
  assert.equal(isShortRead(shaped('short read: need 1 bytes at 0, have 0', 'other')), false);
  assert.equal(isShortRead(shaped('short read: need 1', 'short_read', 'protocol')), false);
  assert.equal(isShortRead(null), false);
  assert.equal(isShortRead(undefined), false);
  const continued = encodeObjHeader(TYPE.BLOB, 300);
  const waited = spStep(spInit(), concat([Uint8Array.of(...PACK_SIGNATURE, 0, 0, 0, PACK_VERSION, 0, 0, 0, 1), continued.subarray(0, 1)]));
  assert.equal(waited.state.phase, 'header');
  assert.equal(isShortRead(Object.assign(new Error('short read: need 1 bytes at 12, have 13'), { code: 'pack_corrupt', reason: 'short_read' })), true);
});
