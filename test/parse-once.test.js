// Parse once (#156, part 2): each public input is parsed at its edge into the brand core takes, and refused there with
// one code and `what`. The git-oracle side of fetch wants is test/want-oracle.test.js.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { lsRefsBody, refPrefixes, parseLsRefLine } from '../src/lsrefs.js';
import { encodeTree, treeEntryOf, isMode, parseCommit, encodeCommit, hashObject } from '../src/objects.js';
import { objectId, fetchObject } from '../src/fetch.js';
import { fetchCommit } from '../src/commit.js';
import { mergeBase } from '../src/merge.js';
import { walkPath } from '../src/read.js';
import { validateSpec, baseName } from '../src/edit.js';
import { buildCommitObjects } from '../src/commit-build.js';
import { DEFAULT_LIMITS } from '../src/limits.js';
import { unwrap } from './unwrap.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40);
// a transport no call may use: every refusal below comes before any request
const noIO = () => {
  const seen = { n: 0 };
  const fail = () => { seen.n++; throw new Error('no request expected'); };
  return { seen, t: { kind: 'http', url: 'http://x/r.git', tracer: { span: fail, start: fail }, parent: null, limits: DEFAULT_LIMITS, signal: null, quirks: { treeFilter: 'tree:0', blobWants: 'many' }, objects: new Map(), scrub: null, frames: fail, advertise: fail } };
};
const refused = (r, what, message) => {
  assert.equal(r.ok, false, 'refused');
  assert.equal(r.error.code, 'bad_request');
  assert.equal(r.error.what, what);
  if (message !== undefined) assert.equal(r.error.message, message);
};

test('lsRefsBody parses its prefixes once, as lsRefs does: a NUL, CR or LF is `invalid ref prefix`', () => {
  for (const p of ['refs/heads/\n', 'a\rb', 'a\0']) {
    refused(lsRefsBody([p]), 'ref prefix', 'invalid ref prefix: must be a string without NUL, CR, or LF');
    refused(refPrefixes(['refs/tags/', p]), 'ref prefix');
  }
  assert.deepEqual(unwrap(refPrefixes(['refs/heads/', '', 'HEAD'])), ['refs/heads/', '', 'HEAD']);
  // the body of parsed prefixes is the body it always was
  assert.equal(new TextDecoder().decode(unwrap(lsRefsBody(['refs/heads/']))), '0014command=ls-refs\n00010009peel\n000csymrefs\n001bref-prefix refs/heads/\n0000');
});

test('a listed name is the field ls-refs wrote: HEAD, a refs/ name, and what a malformed line spells, as git lists them', () => {
  for (const name of ['HEAD', 'refs/heads/main', '', 'capabilities^{}', 'refs/heads/a..b']) {
    const line = name === '' ? `${A} ` : `${A} ${name}`;
    assert.equal(unwrap(parseLsRefLine(line)).name, name);
  }
});

test('encodeTree parses each entry once: a mode git does not write is `mode`, an id that is not one is `oid`', () => {
  for (const mode of ['100664', '040000', '644', '', 'x', 100644]) refused(encodeTree([{ mode, name: 'f', oid: A }]), 'mode');
  for (const oid of [A.toUpperCase(), A.slice(1), `${A}0`, '', 'z'.repeat(40)]) refused(encodeTree([{ mode: '100644', name: 'f', oid }]), 'oid');
  const r = treeEntryOf({ mode: '100644', name: 'n', oid: 'x' });
  assert.equal(r.error.entry, 'n');
  assert.equal(r.error.message, 'tree: entry "n": oid must be 40 lowercase hex characters');
  assert.equal(treeEntryOf({ mode: '1', name: 'n', oid: A }).error.message, 'tree: entry "n": invalid mode "1"');
  // in the caller's order: the first bad entry is the refusal, before a duplicate later on
  refused(encodeTree([{ mode: '100644', name: 'a', oid: A }, { mode: '9', name: 'b', oid: A }, { mode: '100644', name: 'a', oid: A }]), 'mode');
  for (const m of ['100644', '100755', '120000', '40000', '160000']) assert.equal(isMode(m), true);
  for (const m of ['100664', '40755', 100644, null]) assert.equal(isMode(m), false);
  // the five modes, and parsed entries, encode as before
  const entries = [{ mode: '40000', name: 'd', oid: A }, { mode: '100644', name: 'f', oid: B }, { mode: '120000', name: 'l', oid: A }, { mode: '160000', name: 's', oid: B }, { mode: '100755', name: 'x', oid: A }];
  assert.equal(hashObject('tree', unwrap(encodeTree(entries))), hashObject('tree', unwrap(encodeTree(entries.toReversed()))));
});

test('parseCommit parses tree and parents once into lowercase ids (either case on the wire, as git reads them)', () => {
  const data = unwrap(encodeCommit({ tree: A.toUpperCase(), parents: [B.toUpperCase(), A], author: 'a <a@x> 1 +0000', message: 'm\n' }));
  const c = unwrap(parseCommit(data));
  assert.equal(c.tree, A);
  assert.deepEqual(c.parents, [B, A]);
  // a short id at the end of the object is git's bad sha1, as before
  const cut = new TextEncoder().encode(`tree ${A.slice(0, 20)}\n`);
  assert.equal(parseCommit(cut).error.message, "commit: badTreeSha1: invalid 'tree' line format - bad sha1");
  // an expanding lowercase (U+0130 is two code units lowercased) is no hex digit
  const wide = new TextEncoder().encode(`tree ${A.slice(0, 39)}İ\nauthor a <a@x> 1 +0000\ncommitter a <a@x> 1 +0000\n`);
  assert.equal(parseCommit(wide).error.message, "commit: badTreeSha1: invalid 'tree' line format - bad sha1");
});

test('fetchObject, fetchCommit, mergeBase and walkPath parse their ids at the edge, before any request', async () => {
  const { seen, t } = noIO();
  const msg = s => `fetchObject: oid must be 40-hex, got ${JSON.stringify(s)}`;
  for (const bad of ['HEAD', A.toUpperCase(), A.slice(1)]) {
    const o = await fetchObject(t, { oid: bad });
    assert.equal(o.error.code, 'bad_request'); assert.equal(o.error.message, msg(bad)); assert.equal(o.error.what, undefined);
    const c = await fetchCommit(t, bad);
    assert.equal(c.error.code, 'bad_request'); assert.equal(c.error.message, msg(bad));
    const w = await walkPath(t, bad, []);
    assert.equal(w.error.code, 'bad_request'); assert.equal(w.error.message, msg(bad));
    refused(await mergeBase(t, bad, A), 'oid');
    refused(await mergeBase(t, A, bad), 'oid');
  }
  assert.equal(unwrap(objectId(A)), A);
  // a non-string is checked as String() renders it (none as ''), and quoted as String() renders it, as before
  assert.equal(objectId(undefined).error.message, msg('undefined'));
  assert.equal(objectId(null).error.message, 'fetchObject: oid must be 40-hex, got "null"');
  // a String object renders as its text, and is that id (as the String() check always read it)
  assert.equal(unwrap(objectId(new String(A))), A);
  assert.equal(objectId(new String('x')).error.message, msg('x'));
  // the refusal quotes the first 48 characters
  assert.equal(objectId('x'.repeat(100)).error.message, msg('x'.repeat(48)));
  assert.equal(seen.n, 0);
});

test('validateSpec parses the base once into a ref or a commit id, and the head hint into an id', () => {
  const spec = { path: 'a', find: 'x', replace: 'y', author: { name: 'n', email: 'e@x' }, message: 'm', time: 1 };
  const onRef = unwrap(validateSpec(spec, DEFAULT_LIMITS));
  assert.deepEqual(onRef.base, { kind: 'ref', ref: 'refs/heads/main' }); assert.equal(onRef.create, false); assert.equal(baseName(onRef.base), 'refs/heads/main');
  const other = unwrap(validateSpec({ ...spec, base: 'refs/heads/dev' }, DEFAULT_LIMITS));
  assert.deepEqual(other.base, { kind: 'ref', ref: 'refs/heads/dev' }); assert.equal(other.create, true);
  const onCommit = unwrap(validateSpec({ ...spec, base: A }, DEFAULT_LIMITS, B));
  assert.deepEqual(onCommit.base, { kind: 'commit', oid: A }); assert.equal(onCommit.create, false); assert.equal(baseName(onCommit.base), A); assert.equal(onCommit.head, B);
  // the refusals are the ones they were
  refused(validateSpec({ ...spec, base: '0'.repeat(40) }, DEFAULT_LIMITS), 'commit');
  assert.equal(validateSpec({ ...spec, base: A.toUpperCase() }, DEFAULT_LIMITS).error.code, 'bad_request');
  assert.equal(validateSpec(spec, DEFAULT_LIMITS, A.toUpperCase()).error.message, 'head must be a 40-hex oid');
  assert.equal(validateSpec(spec, DEFAULT_LIMITS, 'short').error.message, 'head must be a 40-hex oid');
});

test('buildCommitObjects parses the new blob id once: every tree above it is spliced from that id', () => {
  const r = buildCommitObjects({ levels: [], blob: { oldOid: A, newOid: 'zz', delta: new Uint8Array(0), newLen: 0 }, oldCommit: A, author: { name: 'n', email: 'e@x' }, time: 1, message: 'm' });
  refused(r, 'oid');
});

test('a merge `from` / rebase `onto` and a picked commit are parsed once: an id is an Oid, a name a ref', async () => {
  const { givenOid } = await import('../src/mergeio.js');
  const { pickCommit } = await import('../src/rebase.js');
  assert.deepEqual(unwrap(givenOid(A, 'from')), { tag: 'some', value: A });
  assert.deepEqual(unwrap(givenOid('refs/heads/main', 'from')), { tag: 'none' });
  refused(givenOid('main', 'onto'), 'ref');
  refused(givenOid('0'.repeat(40), 'onto'), 'onto', 'onto must not be the zero oid');
  refused(givenOid('refs/heads/a..b', 'from'), 'ref');
  // an upper-case id is no id: it is read as a name, as before
  refused(givenOid(A.toUpperCase(), 'from'), 'ref');
  const who = { name: 'n', email: 'e@x' };
  for (const commit of ['HEAD', A.toUpperCase(), A.slice(1)]) {
    const r = await pickCommit('http://127.0.0.1:9/r.git', { commit, committer: who }, { tracer: { span: () => { throw new Error('no I/O'); } } });
    assert.equal(r.error.code, 'bad_request'); assert.equal(r.error.message, 'commit must be a 40-hex oid');
  }
});

test('attributeTree parses an oid attribute once: an id is fetched as a commit, a name is a ref', async () => {
  const { attributeTree } = await import('../src/merge.js');
  const { seen, t } = noIO();
  const byId = await attributeTree(t, A, {});
  assert.notEqual(byId.error.code, 'bad_request', 'an id goes to the fetch, not the ref check');
  assert.ok(seen.n > 0);
  const before = seen.n;
  refused(await attributeTree(t, 'refs/heads/a..b', {}), 'ref');
  assert.equal(seen.n, before, 'a bad name is refused before any request');
});

test('a name with no attributes has none: a name that spells `key:value` past its first byte is still only the name', () => {
  // the attributes start after the space that ends the name; with no such space there are none, whatever the name holds
  for (const name of ['xsymref-target:refs/heads/main', `xpeeled:${B}`]) {
    const r = unwrap(parseLsRefLine(`${A} ${name}`));
    assert.equal(r.name, name);
    assert.deepEqual([r['symref-target'], r.peeled], [null, null], name);
  }
});
