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
  await coded('pushDir spec 5', () => pushDir('https://example.invalid/x', 5), 'spec');
  await coded('pushDir options null', () => pushDir('https://example.invalid/x', { dir: '/nonexistent' }, null), 'options');
  await coded('filesFromDir dir null', () => filesFromDir(null), 'dir');
  await coded('filesFromDir options 5', () => filesFromDir('/nonexistent', 5), 'options');
});

test('a userAgent that is no RFC 9110 field-value is refused at parse (#300-1)', () => {
  for (const ua of ['ply\u0001', 'ply\u007F', 'ply☃', 'ply\t\u0000', 'a\nb', 'ply😀']) {
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
import { scanPackIndex, resolvePackRange, planPackBatches, packSubset, planTransfer, copyTree, decodeSavedIndex, loadTransferPack, pushPack, transferStatus, runTransfer } from '../src/index.ts';
const O = {};
const STACK = [
  ['scanPackIndex', scanPackIndex, [['source', O], ['options', O]]],
  ['resolvePackRange', resolvePackRange, [['pack', O], ['source', O], ['options', O]]],
  ['planPackBatches', planPackBatches, [['pack', O], ['resolved', O], ['options', O]]],
  ['packSubset', packSubset, [['source', O], ['pack', O], ['selection', []], ['options', O]]],
  ['planTransfer', planTransfer, [['pack', O], ['resolved', O], ['options', O]]],
  ['copyTree', copyTree, [['dst', O], ['from', O], ['options', O]]],
  ['decodeSavedIndex', decodeSavedIndex, [['bytes', new Uint8Array(0)], ['want', O]]],
  ['loadTransferPack', loadTransferPack, [['dst', O], ['source', O], ['saved', O], ['options', O]]],
  ['pushPack', pushPack, [['transport', O], ['options', O]]],
];
for (const [name, fn, args] of STACK) {
  test(`${name}: null for each argument is bad_request naming it, never a throw (#296-2)`, async () => {
    for (let i = 0; i < args.length; i++) {
      const call = args.map(([, v], j) => (j === i ? null : v));
      await coded(`${name}(${args.map(([n], j) => (j === i ? 'null' : n)).join(', ')})`, () => fn(...call), args[i][0]);
    }
  });
}
test('transferStatus and runTransfer answer null with a coded Err, no throw (#296-2)', async () => {
  for (const fn of [transferStatus, runTransfer]) await coded(fn.name, () => fn(null, null, null, null, null));
});
