// Review train 2, S2 input validation (#296-1, #300-1, #300-8). Expected values come from outside the code:
// a null argument is a caller error, so README's contract ("Every error a function returns has a code") makes it a
// coded Err, never a throw; RFC 9110 §5.5 field-value = *field-content of field-vchar (VCHAR / obs-text 0x80-0xFF),
// SP and HTAB, so a control character or a code point above U+00FF is no header value; and `git cat-file -t HEAD:file/`
// on git 2.50 answers "fatal: path 'file/' does not exist in 'HEAD'" for a blob `file` (and `tree` for `dir/`).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { pushRepo } from '../src/repo-node.ts';
import { pushDir, filesFromDir } from '../src/tree-node.ts';
import { createTransport } from '../src/http.ts';
import { pathComps } from '../src/read.ts';
import { DEFAULT_LIMITS, parseLimits } from '../src/limits.ts';

const coded = async (name, fn, what) => {
  let r;
  try { r = await fn(); } catch (e) { assert.fail(`${name} threw ${e?.constructor?.name}: ${e?.message}`); }
  assert.equal(r.ok, false, `${name} returned ok`);
  assert.equal(r.error.code, 'bad_request', `${name}: ${r.error.code}`);
  if (what !== undefined) assert.equal(r.error.what, what, `${name}: what ${r.error.what}`);
};

test('node entry points answer a null or mis-typed argument with bad_request naming it (#296-1)', async () => {
  await coded('pushRepo options null', () => pushRepo('/nonexistent', 'https://example.invalid/x', {}, null), 'options');
  await coded('pushRepo options 5', () => pushRepo('/nonexistent', 'https://example.invalid/x', {}, 5), 'options');
  await coded('pushRepo spec null', () => pushRepo('/nonexistent', 'https://example.invalid/x', null), 'spec');
  await coded('pushDir spec null', () => pushDir('https://example.invalid/x', null), 'spec');
  await coded('pushDir spec omitted', () => pushDir('https://example.invalid/x'), 'spec');
  await coded('filesFromDir dir omitted', () => filesFromDir(), 'dir');
  await coded('pushDir spec 5', () => pushDir('https://example.invalid/x', 5), 'spec');
  await coded('pushDir spec []', () => pushDir('https://example.invalid/x', []), 'spec');
  await coded('pushDir options []', () => pushDir('https://example.invalid/x', { dir: '/nonexistent' }, []), 'options');
  await coded('pushRepo spec []', () => pushRepo('/nonexistent', 'https://example.invalid/x', []), 'spec');
  await coded('pushRepo options []', () => pushRepo('/nonexistent', 'https://example.invalid/x', {}, []), 'options');
  await coded('filesFromDir options []', () => filesFromDir('/nonexistent', []), 'options');
  await coded('pushDir options null', () => pushDir('https://example.invalid/x', { dir: '/nonexistent' }, null), 'options');
  await coded('filesFromDir dir null', () => filesFromDir(null), 'dir');
  await coded('filesFromDir options 5', () => filesFromDir('/nonexistent', 5), 'options');
});

test('a userAgent that is no RFC 9110 field-value is refused at parse (#300-1)', () => {
  for (const ua of [' ply', 'ply ', '\tply', 'ply\t', 'ply\u0001', 'ply\u007F', 'ply☃', 'ply\t\u0000', 'a\nb', 'ply😀']) {
    const r = createTransport('https://h/r', { userAgent: ua });
    assert.equal(r.ok, false, JSON.stringify(ua));
    assert.equal(r.error.code, 'bad_request');
    assert.equal(r.error.what, 'userAgent');
  }
  // obs-text (0x80-0xFF), SP and HTAB inside a value are field-content
  for (const ua of ['ply/1.0 (x)', 'plyé', 'a\tb', 'ply']) assert.equal(createTransport('https://h/r', { userAgent: ua }).ok, true, JSON.stringify(ua));
});

test('a file path with a trailing slash names a directory and is refused; a tree path keeps it (#300-8)', () => {
  const limits = parseLimits(DEFAULT_LIMITS).value;
  const file = pathComps('file/', limits, { allowRoot: false });
  assert.equal(file.ok, false);
  assert.equal(file.error.code, 'bad_request');
  assert.equal(file.error.what, 'path');
  assert.deepEqual(pathComps('a/file', limits, { allowRoot: false }).value, ['a', 'file']);
  assert.deepEqual(pathComps('dir/', limits, { allowRoot: true }).value, ['dir']);
});

// #296-2: the stack entry points, each argument in turn replaced by null (the others a well-shaped stand-in, so the
// shape check is what answers). Expected: README's contract, a coded Err (bad_request) naming that argument, no throw.
// index.ts is imported dynamically: the mutation suite has no static index import (#313).
const index = () => import('../src/index.ts');
const O = {};
// Each argument: [name, well-shaped stand-in, required]. README §errors: an argument of the wrong shape is a caller
// error, a coded bad_request naming it. Wrong shapes, by the argument's TypeScript type: null, undefined (for a
// required one), a number, and an array where an object is declared (an array is no options/pack/source record) or
// an object where an array or bytes is declared. An omitted optional options argument is the default, never refused.
const OBJ = [null, 5, []];
const STACK = [
  ['scanPackIndex', [['source', O, true], ['options', O, false]]],
  ['resolvePackRange', [['pack', O, true], ['source', O, true], ['options', O, false]]],
  ['planPackBatches', [['pack', O, true], ['resolved', O, true], ['options', O, true]]],
  ['packSubset', [['source', O, true], ['pack', O, true], ['selection', [], true, [null, 5, O]], ['options', O, false]]],
  ['planTransfer', [['pack', O, true], ['resolved', O, true], ['options', O, true]]],
  ['copyTree', [['dst', O, true], ['from', O, true], ['options', O, true]]],
  ['decodeSavedIndex', [['bytes', new Uint8Array(0), true, [null, 5, [], O]], ['want', O, true]]],
  ['loadTransferPack', [['dst', O, true], ['source', O, true], ['saved', O, true], ['options', O, false]]],
  ['pushPack', [['transport', O, true], ['options', O, true]]],
];
const show = v => (v === undefined ? 'undefined' : JSON.stringify(v));
for (const [name, args] of STACK) {
  test(`${name}: null, undefined, a number or an array/object of the wrong kind for each argument is bad_request naming it, never a throw (#296-2)`, async () => {
    const fn = (await index())[name];
    for (let i = 0; i < args.length; i++) {
      const [what, , required, wrong = OBJ] = args[i];
      for (const bad of required ? [...wrong, undefined] : wrong) {
        const call = args.map(([, v], j) => (j === i ? bad : v));
        await coded(`${name}(${args.map(([n], j) => (j === i ? show(bad) : n)).join(', ')})`, () => fn(...call), what);
      }
    }
  });
}
test('transferStatus and runTransfer answer null with a coded Err, no throw (#296-2)', async () => {
  const { transferStatus, runTransfer } = await index();
  for (const fn of [transferStatus, runTransfer]) await coded(fn.name, () => fn(null, null, null, null, null));
});

// The owner's invariant (#296): no function export of src/index.ts throws on a null argument; each returns a coded Err
// or a value. The call shapes are generated from the exports: for every function, null in each position
// 0..max(fn.length, 1)-1, every other argument undefined. STILL_THROWS lists, by name#position/arity, the shapes that
// still throw a raw TypeError/Error at this commit (190 of the 328 shapes); it must only shrink: a new throwing shape
// fails, and a shape that stops throwing fails until it is removed from the list.
const STILL_THROWS = new Set([
  'applyDelta#0/2',
  'applyDelta#1/2',
  'applyProgram#0/2',
  'applyProgram#1/2',
  'armor#0/1',
  'assertNever#0/1',
  'bestBases#1/3',
  'bestBases#2/3',
  'buildCommitObjects#0/1',
  'buildPack#0/1',
  'buildTree#0/1',
  'cacheKey#0/3',
  'cacheKey#1/3',
  'cacheKey#2/3',
  'commitChanges#0/2',
  'commitChanges#1/2',
  'commitView#0/1',
  'concat#0/1',
  'createBranch#0/2',
  'createBranch#1/2',
  'createTag#0/2',
  'createTag#1/2',
  'decideHead#0/1',
  'deleteBranch#0/2',
  'deleteBranch#1/2',
  'deleteRef#0/2',
  'deleteRef#1/2',
  'deleteTag#0/2',
  'deleteTag#1/2',
  'describePack#0/1',
  'describeSavedIndexRefusal#0/1',
  'ed25519Signer#0/1',
  'editFile#0/2',
  'editFile#1/2',
  'encodeCommit#0/1',
  'encodeDelta#0/2',
  'encodeDelta#1/2',
  'encodeDeltaOps#0/3',
  'encodeDeltaOps#1/3',
  'encodeDeltaOps#2/3',
  'encodePackIndex#0/2',
  'encodePackIndex#1/2',
  'encodeSavedIndex#0/2',
  'encodeSavedIndex#1/2',
  'encodeTag#0/1',
  'encodeTree#0/1',
  'exchangeKind#0/3',
  'exchangeKind#1/3',
  'exchangeKind#2/3',
  'fail#0/2',
  'fail#1/2',
  'fastForward#0/2',
  'fastForward#1/2',
  'fetchBody#0/1',
  'fetchObject#0/2',
  'fetchObject#1/2',
  'fetchPack#0/2',
  'fetchPack#1/2',
  'flattenLine#0/1',
  'fromAny#0/1',
  'fromHex#0/1',
  'hashObject#0/2',
  'hashObject#1/2',
  'indexPack#0/1',
  'inflate#0/1',
  'inflateChunks#0/1',
  'inflateEnd#0/1',
  'inflateFeed#0/2',
  'inflateFeed#1/2',
  'inflateInit#0/1',
  'inflatePull#0/1',
  'inflateReset#0/2',
  'inflateReset#1/2',
  'inflateUnread#0/1',
  'isCacheableFetch#0/1',
  'isLfsPointerPrefix#0/1',
  'isPureFetch#0/1',
  'layoutPackIndex#0/2',
  'layoutPackIndex#1/2',
  'linearChain#1/3',
  'linearChain#2/3',
  'logWindow#0/4',
  'logWindow#1/4',
  'logWindow#2/4',
  'logWindow#3/4',
  'lookupEntry#0/4',
  'lookupEntry#1/4',
  'lookupEntry#2/4',
  'lookupEntry#3/4',
  'lsMode#0/1',
  'lsRefs#0/1',
  'lsRefsBody#0/1',
  'makeDelta#0/2',
  'makeDelta#1/2',
  'memAttrs#0/1',
  'memFromScan#0/2',
  'memFromScan#1/2',
  'mergeBranch#0/2',
  'mergeBranch#1/2',
  'negotiate#0/2',
  'negotiate#1/2',
  'objectsForPack#0/2',
  'objectsForPack#1/2',
  'openBlob#0/2',
  'openBlob#1/2',
  'packIdentity#0/1',
  'parseCommit#0/1',
  'parseDelta#0/1',
  'parsePack#0/1',
  'parsePackClose#0/1',
  'parsePackEnd#0/1',
  'parsePackFeed#0/2',
  'parsePackFeed#1/2',
  'parsePackInit#0/1',
  'parsePackPull#0/1',
  'parseTag#0/1',
  'parseTree#0/1',
  'parseUploadPackRequest#0/1',
  'pickCommit#0/2',
  'pickCommit#1/2',
  'pkt#0/1',
  'pktFinish#0/1',
  'pktFrames#0/1',
  'pktStep#0/2',
  'pktStep#1/2',
  'pkts#0/1',
  'planDeltas#0/1',
  'planHash#0/1',
  'plyError#0/2',
  'plyError#1/2',
  'push#0/2',
  'push#1/2',
  'pushBody#0/1',
  'pushTree#0/2',
  'pushTree#1/2',
  'pushWithOptions#0/2',
  'pushWithOptions#1/2',
  'rangeFromBytes#0/1',
  'reachableObjects#0/2',
  'reachableObjects#1/2',
  'readBlob#0/2',
  'readBlob#1/2',
  'rebaseBranch#0/2',
  'rebaseBranch#1/2',
  'resolveCommit#0/2',
  'resolveCommit#1/2',
  'resolvePack#0/1',
  'resolvedIndexOf#0/2',
  'resolvedIndexOf#1/2',
  'scanFinish#0/1',
  'scanInit#0/1',
  'scanPack#0/1',
  'scanStep#0/2',
  'scanStep#1/2',
  'scannedPackOf#0/2',
  'scannedPackOf#1/2',
  'selectObjects#0/1',
  'sidebandStep#0/3',
  'sidebandStep#1/3',
  'sidebandStep#2/3',
  'spFinish#0/1',
  'spStep#0/2',
  'spStep#1/2',
  'spliceDelta#0/1',
  'sshPublicKey#0/1',
  'sweepTransfers#0/1',
  'syncRef#0/3',
  'syncRef#1/3',
  'syncRef#2/3',
  'threeWay#0/3',
  'threeWay#1/3',
  'threeWay#2/3',
  'toHex#0/1',
  'transferPlanHash#0/1',
  'treeFiles#0/2',
  'treeFiles#1/2',
  'treeSort#0/1',
  'v2Step#0/2',
  'v2Step#1/2',
  'validateSpec#0/2',
  'validateSpec#1/2',
  'validateTreeSpec#0/2',
  'validateTreeSpec#1/2',
  'verifyFetchAnswer#0/2',
  'verifyFetchAnswer#1/2',
  'withCommitData#0/2',
  'withCommitData#1/2',
  'withDerivedWork#0/1',
  'withGpgsig#0/2',
  'zlibDeflate#0/1',
]);
test('every function export of index.ts, null in each argument position: no throw outside the shrinking allow-list (#296)', async () => {
  const m = await index();
  const throws = [];
  for (const [name, fn] of Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (typeof fn !== 'function' || /^[A-Z]/u.test(name)) continue;
    const n = Math.max(fn.length, 1);
    for (let i = 0; i < n; i++) {
      try { await fn(...Array.from({ length: n }, (_, j) => (j === i ? null : undefined))); } catch { throws.push(`${name}#${i}/${n}`); }
    }
  }
  assert.deepEqual(throws.filter(s => !STILL_THROWS.has(s)), [], 'a call shape outside the allow-list throws');
  assert.deepEqual([...STILL_THROWS].filter(s => !throws.includes(s)), [], 'a listed shape no longer throws: remove it from STILL_THROWS');
});

// The other half of the options contract: an omitted optional options argument means the defaults (README: options
// are optional), so the call answers exactly as it does with {}; it is never bad_request naming 'options'.
test('an omitted optional options argument answers as {} does, never bad_request options (#296-2)', async () => {
  const m = await index();
  const empty = () => (async function* () {})();
  const cases = [
    ['scanPackIndex', o => m.scanPackIndex(empty(), ...o)],
    ['loadTransferPack', o => m.loadTransferPack(O, O, O, ...o)],
  ];
  for (const [name, call] of cases) {
    const omitted = await call([]);
    assert.notEqual(omitted.ok === false && omitted.error.what, 'options', `${name}: omitted options refused`);
    assert.deepEqual(omitted, await call([{}]), `${name}: omitted differs from {}`);
  }
});
