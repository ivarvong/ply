// Mutation tests for pushTree (tree.js), checkoutTree (checkout.js) and readFile/listTree/readCommit (read.js), without a
// git server. The pure steps are asserted directly; the operations run against `remote()`, an in-process fake that
// speaks the transport contract (transport.js: `frames(service, body)`), answers ls-refs, v2 fetch (tree:0, blob:none,
// plain wants) and receive-pack (report-status over side-band-64k), and builds every response with ply's own codecs.
// Tree and commit oids that matter are git's (`git write-tree` / `git commit-tree` over the same files), not ply's.
// The integration suites (push-tree, checkout-tree, read) judge the same operations against git http-backend.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { fileEntries, buildTree, selectObjects, validateTreeSpec, pushTree } from '../src/tree.js';
import { editFile, lookupEntry } from '../src/edit.js';
import { canonMode, treeFiles, checkoutTree } from '../src/checkout.js';
import { refCandidates, entryType, lsMode, resolveCommit, commitView, readCommit, listTree, readFile, openBlob, readBlob, fetchCommit, walkPath } from '../src/read.js';
import { hashObject, encodeTree, encodeCommit, encodeTag, parseTree, parseCommit, TYPE, TYPE_ID } from '../src/objects.js';
import { buildPack, encodeObjHeader, zlibDeflate } from '../src/pack.js';
import { parsePack, resolvePack, makeDelta } from '../src/packresolve.js';
import { pkts } from '../src/pktline.js';
import { te, td, concat, bytesOf } from '../src/bytes.js';
import { Sha1 } from '../src/sha1.js';
import { ZERO_OID } from '../src/push.js';
import { DEFAULT_LIMITS, withLimits } from '../src/limits.js';
import { thrown as fail } from '../src/errors.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';

const GITLINK = 'c0ffee'.padEnd(40, '0');
const A = { name: 'A', email: 'a@x' };
const T0 = 1700000000;
// git write-tree / commit-tree over FILES (author and committer "A <a@x> 1700000000 +0000", message "deploy")
const FILES = () => ({
  README: 'hello\n', 'src/a.js': 'a\n', 'src/lib/b.js': 'b\n',
  'run.sh': { data: '#!/bin/sh\n', mode: '100755' }, link: { mode: '120000', data: 'README' }, sub: { mode: '160000', oid: GITLINK },
});
const GIT = {
  root: '516560e7fe0766acc830fce50b4f6bcf3b35bb83', src: 'e094828ddb490f7c7fc78031e31089f3156da7cd', lib: '365e3dfff5383dbc31ea16336fa73ff0dc2bb025',
  readme: 'ce013625030ba8dba906f756967f9e9ca394464a', link: '100b93820ade4c16225673b4ca62bb3ade63c313', run: '1a2485251c33a70432394c93fb89330ef214bfc9',
  a: '78981922613b2afb6025042ff6bd878ac1994e85', b: '61780798228d17af2d34fce4cfbdf35556832472', commit: '217d4d2b52dc2f2156e5e88d5340e9e9b97f83fb',
  // src/a.js → 'A\n': the new root and src trees, and the child commit of `commit`
  root2: 'b6a71e2069a3b261745147e78ccd34bde142c998', src2: 'baa4b47b50ca112598753de9675c52e757514321', commit2: '08b2316ec8417327ce57e304a333cf880b8ceac5',
};
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

const rejects = (p, code, message, extra = {}) => assert.rejects(p, e => {
  assert.equal(e.code, code, e.message);
  if (message instanceof RegExp) assert.match(e.message, message); else if (message !== undefined) assert.equal(e.message, message);
  for (const [k, v] of Object.entries(extra)) assert.deepEqual(e[k], v, k);
  return true;
});
const throws = (fn, code, message, extra = {}) => assert.throws(fn, e => {
  assert.equal(e.code, code, e.message);
  if (message !== undefined) assert.equal(e.message, message);
  for (const [k, v] of Object.entries(extra)) assert.deepEqual(e[k], v, k);
  return true;
});
const readAll = async stream => { const parts = []; for await (const c of stream) parts.push(c); return td.decode(concat(parts)); };
const streamOf = r => { assert.equal(r.ok, true, r.ok ? '' : r.error?.message); if (!r.ok || r.value.kind !== 'stream') throw new Error('expected a stream'); return r.value; };
const errOf = r => { assert.equal(r.ok, false); if (r.ok) throw new Error('expected an error'); return r.error; };

// ---- the fake remote ----

// pkt-lines of a request body; receive-pack stops at the first flush and the rest is the pack
function requestLines(body, { stopAtFlush = false } = {}) {
  const lines = []; let p = 0;
  while (p < body.length) {
    const n = parseInt(td.decode(body.subarray(p, p + 4)), 16);
    if (n === 0) { p += 4; if (stopAtFlush) break; continue; }
    if (n === 1) { p += 4; continue; }
    lines.push(td.decode(body.subarray(p + 4, p + n)).replace(/\n$/, '')); p += n;
  }
  return { lines, rest: body.subarray(p) };
}
const dataFrame = s => ({ kind: 'data', payload: bytesOf(s) });
const band = (n, bytes) => ({ kind: 'data', payload: concat([Uint8Array.of(n), bytes]) });
const packFrames = (pack, chunk = 1 << 16) => {
  const out = [dataFrame('packfile\n')];
  for (let i = 0; i < pack.length; i += chunk) out.push(band(1, pack.subarray(i, i + chunk)));
  return [...out, { kind: 'flush' }];
};

function remote({ head = 'refs/heads/main', chunk = 1 << 16, hook = null } = {}) {
  const objects = new Map(), refs = new Map(), log = [];
  const put = (typeName, data) => { data = bytesOf(data); const oid = hashObject(typeName, data); objects.set(oid, { type: TYPE_ID[typeName], data }); return oid; };
  const commit = (files, { ref = 'refs/heads/main', parents = [], time = T0, message = 'deploy\n' } = {}) => {
    const built = buildTree(fileEntries(files));
    for (const tr of built.trees.values()) objects.set(tr.oid, { type: TYPE.TREE, data: tr.data });
    for (const [oid, data] of built.blobs) objects.set(oid, { type: TYPE.BLOB, data });
    const who = `A <a@x> ${time} +0000`;
    const oid = put('commit', encodeCommit({ tree: built.root, parents, author: who, committer: who, message }));
    if (ref) refs.set(ref, oid);
    return oid;
  };
  const trees = (oid, out) => {
    if (out.has(oid)) return out; out.add(oid);
    for (const e of parseTree(objects.get(oid).data)) if (e.mode === '40000') trees(e.oid, out);
    return out;
  };
  const select = (want, filter) => {
    const o = objects.get(want);
    if (filter !== 'blob:none' || o.type === TYPE.BLOB) return [want];
    return [...trees(o.type === TYPE.COMMIT ? parseCommit(o.data).tree : want, new Set(o.type === TYPE.COMMIT ? [want] : []))];
  };
  async function* serve(service, body) {
    if (service === 'git-receive-pack') {
      const { lines, rest } = requestLines(body, { stopAtFlush: true });
      const commands = lines.map(l => { const [old, nu, ref] = l.split('\0')[0].split(' '); return { old, new: nu, ref }; });
      const req = { service, commands, pack: rest.length ? parsePack(rest) : null };
      log.push(req);
      if (hook) { const r = await hook(req); if (r) { yield* r; return; } }
      if (req.pack) for (const [oid, o] of resolvePack(req.pack, b => objects.get(b)).objects) objects.set(oid, { type: o.type, data: o.data });
      const report = ['unpack ok'];
      for (const c of commands) {
        if ((refs.get(c.ref) ?? ZERO_OID) !== c.old) { report.push(`ng ${c.ref} fetch first`); continue; }
        if (c.new === ZERO_OID) refs.delete(c.ref); else refs.set(c.ref, c.new);
        report.push(`ok ${c.ref}`);
      }
      yield band(1, pkts(report.map(l => l + '\n')));
      yield { kind: 'flush' };
      return;
    }
    const { lines } = requestLines(body);
    const arg = k => lines.filter(l => l.startsWith(`${k} `)).map(l => l.slice(k.length + 1));
    if (lines[0] === 'command=ls-refs') {
      const req = { service, command: 'ls-refs', prefixes: arg('ref-prefix'), unborn: lines.includes('unborn') };
      log.push(req);
      if (hook) { const r = await hook(req); if (r) { yield* r; return; } }
      const match = name => !req.prefixes.length || req.prefixes.some(p => name.startsWith(p));
      const line = (name, oid, extra = '') => { const o = objects.get(oid); const peeled = o?.type === TYPE.TAG ? ` peeled:${td.decode(o.data).slice(7, 47)}` : ''; return dataFrame(`${oid} ${name}${extra}${peeled}\n`); };
      if (match('HEAD')) {
        if (typeof head === 'string' && head.startsWith('refs/') && refs.has(head)) yield line('HEAD', refs.get(head), ` symref-target:${head}`);
        else if (head && !head.startsWith('refs/')) yield line('HEAD', head);
      }
      for (const [name, oid] of refs) if (match(name)) yield line(name, oid);
      yield { kind: 'flush' };
      return;
    }
    const req = { service, command: 'fetch', wants: arg('want'), filter: arg('filter')[0] ?? null, deepen: Number(arg('deepen')[0] ?? 0) };
    log.push(req);
    if (hook) { const r = await hook(req); if (r) { yield* r; return; } }
    const missing = req.wants.find(w => !objects.has(w));
    if (missing) { yield dataFrame(`ERR upload-pack: not our ref ${missing}`); return; }
    const send = [...new Set(req.wants.flatMap(w => select(w, req.filter)))];
    const { pack } = await buildPack(send.map(oid => objects.get(oid)));
    yield* packFrames(pack, chunk);
  }
  const transport = ({ tracer, limits = DEFAULT_LIMITS, quirks = {} }) => ({
    kind: 'http', url: 'http://fake/r.git', tracer, parent: null, limits, signal: null, quirks, scrub: null,
    frames: (service, body) => serve(service, body),
    // A ref miss asks discover() before it classifies the miss. No `unborn` feature: no second ls-refs, HEAD stays head_absent.
    advertise: async () => pkts(['version 2\n', 'ls-refs\n', 'fetch\n', 'object-format=sha1\n']),
  });
  return { objects, refs, log, put, commit, transport, fetches: () => log.filter(r => r.command === 'fetch'), pushes: () => log.filter(r => r.service === 'git-receive-pack') };
}

// an operation's options over the fake: { opts, spans(), span(name) }
function env(r, { limits = DEFAULT_LIMITS, quirks = {} } = {}) {
  const ex = arrayExporter(); const tracer = new Tracer({ exporter: ex });
  const transport = r.transport({ tracer, limits, quirks });
  const spans = () => ex.lines.flatMap(flattenLine);
  return { opts: { tracer, transport, limits }, transport, spans, span: name => spans().find(s => s.name === name), all: name => spans().filter(s => s.name === name) };
}

// ======================================================================================================================
// tree.js — pure steps
// ======================================================================================================================

test('fileEntries: the three input shapes, defaults and git blob oids', () => {
  const fromObject = fileEntries({ 'a/b.txt': 'hello\n', bin: Uint8Array.of(0, 1), x: { data: 'ex', mode: '100755' } });
  assert.deepEqual(fromObject.map(e => [e.path, e.comps, e.mode, e.oid]), [
    ['a/b.txt', ['a', 'b.txt'], '100644', GIT.readme],
    ['bin', ['bin'], '100644', hashObject('blob', Uint8Array.of(0, 1))],
    ['x', ['x'], '100755', hashObject('blob', te.encode('ex'))],
  ]);
  assert.deepEqual([...fromObject[0].data], [...te.encode('hello\n')]);
  const map = fileEntries(new Map([['m', 'hello\n']]));
  assert.deepEqual(map.map(e => [e.path, e.mode, e.oid]), [['m', '100644', GIT.readme]]);
  const list = fileEntries([{ path: 'l', data: '' }, { path: 'g', mode: '160000', oid: GITLINK }]);
  assert.deepEqual(list[0].oid, EMPTY_BLOB);
  assert.deepEqual(list[1], { path: 'g', comps: ['g'], mode: '160000', oid: GITLINK });
  assert.equal('data' in list[1], false);
  assert.deepEqual(fileEntries({}), []);
  assert.deepEqual(fileEntries([]), []);
  assert.deepEqual(fileEntries({ s: { mode: '120000', data: 'target' } })[0].oid, hashObject('blob', te.encode('target')));
});

test('fileEntries: every refusal, with its code, message and what', () => {
  for (const bad of [null, undefined, 'files', 7]) throws(() => fileEntries(bad), 'bad_request', 'files must be an object or an iterable of { path, mode, data }', { what: 'files' });
  throws(() => fileEntries({ g: { mode: '160000', oid: 'xyz' } }), 'bad_request', 'g: a gitlink (160000) takes a 40-hex oid and no data', { what: 'gitlink', path: 'g' });
  throws(() => fileEntries({ g: { mode: '160000' } }), 'bad_request', 'g: a gitlink (160000) takes a 40-hex oid and no data', { what: 'gitlink' });
  throws(() => fileEntries({ g: { mode: '160000', oid: GITLINK.toUpperCase() } }), 'bad_request', undefined, { what: 'gitlink' });
  throws(() => fileEntries({ g: { mode: '160000', oid: `${GITLINK}0` } }), 'bad_request', undefined, { what: 'gitlink' });
  throws(() => fileEntries({ g: { mode: '160000', oid: `x${GITLINK}` } }), 'bad_request', undefined, { what: 'gitlink' });
  throws(() => fileEntries({ g: { mode: '160000', oid: GITLINK, data: '' } }), 'bad_request', undefined, { what: 'gitlink' });
  for (const mode of ['100664', '40000', '644', 100644, '']) throws(() => fileEntries({ f: { mode, data: 'x' } }), 'bad_request', `f: mode ${JSON.stringify(mode)} is not 100644, 100755, 120000 or 160000`, { what: 'mode', path: 'f' });
  for (const data of [undefined, 5, null, [1]]) throws(() => fileEntries([{ path: 'f', data }]), 'bad_request', 'f: data must be a string or Uint8Array', { what: 'data', path: 'f' });
  throws(() => fileEntries({ l: { mode: '120000', data: '' } }), 'bad_request', 'l: a symlink target must be non-empty and contain no NUL', { what: 'symlink', path: 'l' });
  throws(() => fileEntries({ l: { mode: '120000', data: 'a\0b' } }), 'bad_request', undefined, { what: 'symlink' });
  throws(() => fileEntries({ l: { mode: '120000', data: Uint8Array.of(0) } }), 'bad_request', undefined, { what: 'symlink' });
  // a NUL is fine in a regular file, and an empty file is git's empty blob
  assert.equal(fileEntries({ f: 'a\0b', e: '' }).length, 2);
  throws(() => fileEntries({ '../x': 'y' }), 'bad_request', undefined, { what: 'path' });
  throws(() => fileEntries([null]), 'bad_request', undefined, { what: 'path' });
  throws(() => fileEntries([{ data: 'x' }]), 'bad_request', undefined, { what: 'path' });
});

test('fileEntries: maxPackObjects and maxObjectSize bound exactly', () => {
  const two = withLimits({ maxPackObjects: 2 });
  assert.equal(fileEntries({ a: '1', b: '2' }, two).length, 2);
  throws(() => fileEntries({ a: '1', b: '2', c: '3' }, two), 'limit_exceeded', 'files 3 exceeds limit 2', { what: 'files', got: 3, max: 2 });
  const four = withLimits({ maxObjectSize: 4 });
  assert.equal(fileEntries({ a: 'abcd' }, four)[0].data.length, 4);
  throws(() => fileEntries({ a: 'abcde' }, four), 'limit_exceeded', 'object size 5 exceeds limit 4', { what: 'object size', got: 5, max: 4 });
  // a gitlink has no data, so the size cap never applies to it
  assert.equal(fileEntries({ g: { mode: '160000', oid: GITLINK } }, withLimits({ maxObjectSize: 0 })).length, 1);
  throws(() => fileEntries({ a: 'x' }, { ...DEFAULT_LIMITS, maxPackObjects: undefined }), 'bad_request', 'limits.maxPackObjects must be a finite non-negative number');
  throws(() => fileEntries({ a: 'x' }, { ...DEFAULT_LIMITS, maxObjectSize: undefined }), 'bad_request', 'limits.maxObjectSize must be a finite non-negative number');
});

test('buildTree: git\'s tree oids, every directory, blobs by oid', () => {
  const built = buildTree(fileEntries(FILES()));
  assert.equal(built.root, GIT.root);
  assert.deepEqual([...built.trees.keys()].sort(), ['', 'src', 'src/lib']);
  assert.equal(built.trees.get('src').oid, GIT.src);
  assert.equal(built.trees.get('src/lib').oid, GIT.lib);
  assert.equal(built.trees.get('').oid, GIT.root);
  assert.equal(hashObject('tree', built.trees.get('src').data), GIT.src);
  assert.deepEqual(built.trees.get('src').entries.map(e => [e.mode, e.name, e.oid]), [['100644', 'a.js', GIT.a], ['40000', 'lib', GIT.lib]]);
  assert.deepEqual(built.trees.get('').entries.map(e => e.name).sort(), ['README', 'link', 'run.sh', 'src', 'sub']);
  // blobs: every file's content once by oid; the gitlink names a commit that is not here
  assert.deepEqual([...built.blobs.keys()].sort(), [GIT.readme, GIT.link, GIT.run, GIT.a, GIT.b].sort());
  assert.equal(td.decode(built.blobs.get(GIT.b)), 'b\n');
  const none = buildTree([]);
  assert.equal(none.root, EMPTY_TREE);
  assert.equal(none.trees.size, 1);
  assert.equal(none.blobs.size, 0);
  // an empty file is a blob too (an empty Uint8Array is truthy)
  assert.deepEqual([...buildTree(fileEntries({ e: '' })).blobs.keys()], [EMPTY_BLOB]);
  // deep before shallow: a four-level chain still encodes
  const deep = buildTree(fileEntries({ 'a/b/c/d': 'x', 'a/y': 'z' }));
  assert.equal(deep.trees.size, 4);
  assert.equal(parseTree(deep.trees.get('a/b').data)[0].oid, deep.trees.get('a/b/c').oid);
});

test('buildTree: file/directory clashes, duplicates and maxTreeEntries', () => {
  const clash = files => () => buildTree(fileEntries(files));
  throws(clash([{ path: 'x/a', data: '1' }, { path: 'x/a/b', data: '2' }]), 'bad_request', 'x/a is both a file and a directory', { what: 'path', path: 'x/a/b' });
  throws(clash([{ path: 'x/a/b', data: '1' }, { path: 'x/a', data: '2' }]), 'bad_request', 'x/a is both a file and a directory', { what: 'path', path: 'x/a' });
  throws(clash([{ path: 'x/a', data: '1' }, { path: 'x/a', data: '2' }]), 'bad_request', 'x/a is given twice', { what: 'path', path: 'x/a' });
  throws(clash([{ path: 'a', data: '1' }, { path: 'a/b/c', data: '2' }]), 'bad_request', 'a is both a file and a directory', { path: 'a/b/c' });
  // two files under one new directory share it
  assert.equal(buildTree(fileEntries({ 'd/a': '1', 'd/b': '2' })).trees.get('d').entries.length, 2);
  const two = withLimits({ maxTreeEntries: 2 });
  assert.equal(buildTree(fileEntries({ a: '1', b: '2', 'c/d': '3', 'c/e': '4' }), withLimits({ maxTreeEntries: 3 })).trees.size, 2);
  assert.equal(buildTree(fileEntries({ a: '1', b: '2' }), two).trees.get('').entries.length, 2);
  throws(() => buildTree(fileEntries({ a: '1', b: '2', c: '3' }), two), 'limit_exceeded', 'tree entries 3 exceeds limit 2', { what: 'tree entries', got: 3, max: 2 });
  throws(() => buildTree([], {}), 'bad_request', 'limits.maxTreeEntries must be a finite non-negative number');
});

test('selectObjects: walk order, dedupe, what the server has, gitlinks', () => {
  const built = buildTree(fileEntries(FILES()));
  const fresh = selectObjects(built);
  assert.deepEqual(fresh.trees.map(t => hashObject('tree', t.data)), [GIT.root, GIT.src, GIT.lib]);
  assert.ok(fresh.trees.every(t => t.type === TYPE.TREE && t.baseOid === undefined));
  // blobs follow the walk over each directory's entries as given (README, src/a.js, src/lib/b.js, run.sh, link, sub)
  assert.deepEqual(fresh.blobs.map(b => hashObject('blob', b.data)), [GIT.readme, GIT.a, GIT.b, GIT.run, GIT.link]);
  assert.ok(fresh.blobs.every(b => b.type === TYPE.BLOB));
  assert.equal(fresh.deltas, 0);
  // the server has src/lib (so its blob too) and README's blob
  const known = selectObjects(built, { have: new Set([GIT.lib, GIT.readme]) });
  assert.deepEqual(known.trees.map(t => hashObject('tree', t.data)), [GIT.root, GIT.src]);
  assert.deepEqual(known.blobs.map(b => hashObject('blob', b.data)), [GIT.a, GIT.run, GIT.link]);
  assert.deepEqual(selectObjects(built, { have: new Set([GIT.root]) }), { trees: [], blobs: [], deltas: 0 });
  // one blob at two paths, one tree at two paths: each sent once
  const twins = buildTree(fileEntries({ 'p/x': 'same', 'q/x': 'same', r: 'same' }));
  const sel = selectObjects(twins);
  assert.equal(sel.trees.length, 2);
  assert.equal(sel.blobs.length, 1);
  // a gitlink alone sends nothing but its tree
  const g = selectObjects(buildTree(fileEntries({ g: { mode: '160000', oid: GITLINK } })));
  assert.deepEqual([g.trees.length, g.blobs.length], [1, 0]);
});

test('selectObjects: a tree goes as a REF_DELTA only when that is smaller and at least DELTA_SIZE_MIN', () => {
  const before = buildTree(fileEntries(FILES()));
  const after = buildTree(fileEntries({ ...FILES(), 'src/a.js': 'A\n' }));
  assert.equal(after.root, GIT.root2);
  const old = new Map([['', { oid: GIT.root, data: before.trees.get('').data }], ['src', { oid: GIT.src, data: before.trees.get('src').data }]]);
  const sel = selectObjects(after, { have: new Set([GIT.lib, GIT.readme, GIT.link, GIT.run, GIT.b]), old });
  assert.equal(sel.deltas, 2);
  assert.deepEqual(sel.trees.map(t => t.baseOid), [GIT.root, GIT.src]);
  assert.deepEqual([...sel.trees[0].data], [...makeDelta(before.trees.get('').data, after.trees.get('').data).delta]);
  assert.deepEqual([...sel.trees[1].data], [...makeDelta(before.trees.get('src').data, after.trees.get('src').data).delta]);
  assert.deepEqual(sel.blobs.map(b => td.decode(b.data)), ['A\n']);
  // an unrelated base gives a delta no smaller than the tree: the tree goes whole
  const other = buildTree(fileEntries({ zzz: 'q' }));
  const whole = selectObjects(other, { old: new Map([['', { oid: GIT.lib, data: te.encode('#'.repeat(64)) }]]) });
  assert.equal(whole.deltas, 0);
  assert.deepEqual([...whole.trees[0].data], [...other.trees.get('').data]);
  // identical bytes: header (2) + one copy op (2) is exactly DELTA_SIZE_MIN (4), and smaller than the tree
  const same = selectObjects(before, { old: new Map([['src/lib', { oid: 'f'.repeat(40), data: before.trees.get('src/lib').data }]]) });
  const lib = same.trees.find(t => t.baseOid);
  assert.equal(lib.data.length, 4);
  assert.equal(lib.baseOid, 'f'.repeat(40));
  // the empty tree against itself: a 2-byte delta is under DELTA_SIZE_MIN, so whole (0 bytes)
  const empty = buildTree([]);
  const e = selectObjects(empty, { old: new Map([['', { oid: EMPTY_TREE, data: new Uint8Array(0) }]]) });
  assert.deepEqual([e.deltas, e.trees[0].data.length, e.trees[0].baseOid], [0, 0, undefined]);
});

test('validateTreeSpec: defaults, create, head, and each field checked before I/O', () => {
  const s = validateTreeSpec({ files: { a: 'x' }, author: A, message: 'm', time: T0 }, DEFAULT_LIMITS);
  assert.equal(Object.isFrozen(s), true);
  assert.deepEqual([s.ref, s.base, s.create, s.files, s.message, s.head], ['refs/heads/main', 'refs/heads/main', false, 1, 'm', null]);
  assert.deepEqual({ ...s.author }, { name: 'A', email: 'a@x', time: T0, tz: '+0000' });
  assert.equal(s.built.root, buildTree(fileEntries({ a: 'x' })).root);
  const c = validateTreeSpec({ ref: 'refs/heads/new', base: 'refs/heads/main', files: {}, author: { ...A, tz: '+0530' }, message: '', time: 0 }, DEFAULT_LIMITS, 'a'.repeat(40));
  assert.deepEqual([c.ref, c.base, c.create, c.head, c.author.tz, c.files], ['refs/heads/new', 'refs/heads/main', true, 'a'.repeat(40), '+0530', 0]);
  assert.equal(validateTreeSpec({ ref: 'refs/heads/x', files: {}, author: A, message: '' }, DEFAULT_LIMITS).base, 'refs/heads/x');
  const t0 = Math.floor(Date.now() / 1000);
  const now = validateTreeSpec({ files: {}, author: A, message: '' }, DEFAULT_LIMITS).author.time;
  assert.ok(now >= t0 && now <= t0 + 2, `${now} vs ${t0}`);
  const ok = { files: {}, author: A, message: 'm', time: T0 };
  throws(() => validateTreeSpec(ok, DEFAULT_LIMITS, 'abc'), 'bad_request', 'head must be a 40-hex oid');
  throws(() => validateTreeSpec(ok, DEFAULT_LIMITS, 'A'.repeat(40)), 'bad_request', 'head must be a 40-hex oid');
  throws(() => validateTreeSpec(ok, DEFAULT_LIMITS, `${'a'.repeat(40)}\n`), 'bad_request', 'head must be a 40-hex oid');
  throws(() => validateTreeSpec({ ...ok, ref: 'main' }, DEFAULT_LIMITS), 'bad_request', undefined, { what: 'ref' });
  throws(() => validateTreeSpec({ ...ok, base: 'main' }, DEFAULT_LIMITS), 'bad_request', undefined, { what: 'ref' });
  throws(() => validateTreeSpec({ ...ok, author: undefined }, DEFAULT_LIMITS), 'bad_request', undefined, { what: 'author name' });
  throws(() => validateTreeSpec({ ...ok, author: { name: 'A' } }, DEFAULT_LIMITS), 'bad_request', undefined, { what: 'author email' });
  throws(() => validateTreeSpec({ ...ok, message: 'a\0' }, DEFAULT_LIMITS), 'bad_request', undefined, { what: 'message' });
  throws(() => validateTreeSpec({ ...ok, files: null }, DEFAULT_LIMITS), 'bad_request', undefined, { what: 'files' });
  throws(() => validateTreeSpec({ ...ok, files: { a: '1', 'a/b': '2' } }, DEFAULT_LIMITS), 'bad_request', 'a is both a file and a directory');
  // the total is the sum of blob bytes. Exactly the cap is kept; the next byte is limit_exceeded before buildTree.
  const cap = withLimits({ maxPushBytes: 4 });
  assert.equal(validateTreeSpec({ ...ok, files: { a: 'ab', b: 'cd' } }, cap).built.root, buildTree(fileEntries({ a: 'ab', b: 'cd' }, cap)).root);
  throws(() => validateTreeSpec({ ...ok, files: { a: 'abc', b: 'de' } }, cap), 'limit_exceeded', 'push bytes 5 exceeds limit 4', { what: 'push bytes', got: 5, max: 4 });
  assert.equal(validateTreeSpec({ ...ok, files: { g: { mode: '160000', oid: GITLINK } } }, withLimits({ maxPushBytes: 0 })).files, 1);
  throws(() => validateTreeSpec({ ...ok, files: { a: 'x' } }, withLimits({ maxPushBytes: 0 })), 'limit_exceeded', 'push bytes 1 exceeds limit 0', { what: 'push bytes', got: 1, max: 0 });
  // a file over maxObjectSize is still that error, from fileEntries, not the total
  throws(() => validateTreeSpec({ ...ok, files: { a: 'abcd' } }, withLimits({ maxObjectSize: 2, maxPushBytes: 1 })), 'limit_exceeded', 'object size 4 exceeds limit 2');
  throws(() => validateTreeSpec(ok, { ...DEFAULT_LIMITS, maxPushBytes: undefined }), 'bad_request', 'limits.maxPushBytes must be a finite non-negative number');
});

// ======================================================================================================================
// tree.js — pushTree over the fake remote
// ======================================================================================================================

test('pushTree: the first commit of a new ref is git\'s commit, every object sent, the CAS old oid zero', async () => {
  const r = remote(); const e = env(r);
  const res = await pushTree('http://fake/r.git', { files: FILES(), author: A, message: 'deploy', time: T0 }, e.opts);
  assert.deepEqual(res, {
    noop: false, ref: 'refs/heads/main', oldCommit: null, newCommit: GIT.commit, oldTree: null, newTree: GIT.root, hint: null, attempt: 0,
    pushBytes: res.pushBytes, treesRead: 0, objects: { files: 6, trees: 3, sent: 9, sentTrees: 3, sentBlobs: 5, treeDeltas: 0 },
  });
  assert.ok(res.pushBytes > 0);
  assert.equal(r.refs.get('refs/heads/main'), GIT.commit);
  const [p] = r.pushes();
  assert.deepEqual(p.commands, [{ old: ZERO_OID, new: GIT.commit, ref: 'refs/heads/main' }]);
  assert.equal(p.pack.objects.length, 9);
  assert.equal(p.pack.objects[0].type, TYPE.COMMIT);
  assert.equal(r.fetches().length, 0, 'an absent ref needs no parent fetch');
  const root = e.span('git.push_tree');
  assert.deepEqual(Object.fromEntries(Object.entries(root.attrs).filter(([k]) => k.startsWith('git.push_tree.'))), {
    'git.push_tree.url': 'http://fake/r.git', 'git.push_tree.ref': 'refs/heads/main', 'git.push_tree.base': 'refs/heads/main', 'git.push_tree.create': false,
    'git.push_tree.files': 6, 'git.push_tree.trees': 3, 'git.push_tree.tree.new': GIT.root, 'git.push_tree.head.hint': '', 'git.push_tree.attempt': 0,
    'git.push_tree.commit.old': '', 'git.push_tree.tree.old': '', 'git.push_tree.commit.new': GIT.commit, 'git.push_tree.send.trees': 3,
    'git.push_tree.send.tree_deltas': 0, 'git.push_tree.send.blobs': 5, 'git.push_tree.push.bytes': res.pushBytes, 'git.push_tree.push.objects': 9,
    'git.push_tree.head.outcome': '', 'git.push_tree.outcome': 'ok',
  });
  const diff = e.span('git.push_tree.diff');
  assert.deepEqual([diff.attrs['git.push_tree.diff.trees_read'], diff.attrs['git.push_tree.diff.cache_hits'], diff.attrs['git.push_tree.diff.have']], [0, 0, 0]);
  assert.equal(diff.parentSpanId, root.spanId);
  // a message that already ends in a newline is not given a second one
  const r2 = remote();
  assert.equal((await pushTree('http://fake/r.git', { files: FILES(), author: A, message: 'deploy\n', time: T0 }, env(r2).opts)).newCommit, GIT.commit);
});

test('pushTree: a repeat push reads only the changed trees, sends deltas and only the new blob; the same tree is a noop', async () => {
  const r = remote(); r.commit(FILES());
  assert.equal(r.refs.get('refs/heads/main'), GIT.commit);
  const cache = new Map();
  const e = env(r);
  const res = await pushTree('http://fake/r.git', { files: { ...FILES(), 'src/a.js': 'A\n' }, author: A, message: 'deploy', time: T0 }, { ...e.opts, cache });
  assert.equal(res.newCommit, GIT.commit2);
  assert.deepEqual([res.oldCommit, res.oldTree, res.newTree, res.treesRead], [GIT.commit, GIT.root, GIT.root2, 2]);
  assert.deepEqual(res.objects, { files: 6, trees: 3, sent: 4, sentTrees: 2, sentBlobs: 1, treeDeltas: 2 });
  assert.equal(r.refs.get('refs/heads/main'), GIT.commit2);
  // the commit (tree:0 deepen 1), then the root and src trees (tree:0) — never src/lib, which did not change
  assert.deepEqual(r.fetches().map(f => [f.wants[0], f.filter, f.deepen]), [[GIT.commit, 'tree:0', 1], [GIT.root, 'tree:0', 0], [GIT.src, 'tree:0', 0]]);
  const [p] = r.pushes();
  assert.deepEqual(p.commands, [{ old: GIT.commit, new: GIT.commit2, ref: 'refs/heads/main' }]);
  assert.deepEqual(p.pack.objects.map(o => [o.type, o.baseOid ?? null]), [[TYPE.COMMIT, null], [TYPE.REF_DELTA, GIT.root], [TYPE.REF_DELTA, GIT.src], [TYPE.BLOB, null]]);
  const diff = e.span('git.push_tree.diff');
  // have: the old root, its five entries, and src's two
  assert.deepEqual([diff.attrs['git.push_tree.diff.trees_read'], diff.attrs['git.push_tree.diff.cache_hits'], diff.attrs['git.push_tree.diff.have']], [2, 0, 8]);
  const root = e.span('git.push_tree');
  assert.deepEqual([root.attrs['git.push_tree.commit.old'], root.attrs['git.push_tree.tree.old'], root.attrs['git.push_tree.send.tree_deltas']], [GIT.commit, GIT.root, 2]);
  // every new tree is cached by oid after the push; a later push from it reads nothing
  assert.deepEqual([...cache.keys()].sort(), [GIT.root, GIT.src, GIT.lib, GIT.root2, GIT.src2].sort());
  const e2 = env(r);
  const back = await pushTree('http://fake/r.git', { files: FILES(), author: A, message: 'deploy', time: T0 }, { ...e2.opts, cache });
  assert.deepEqual([back.treesRead, back.oldCommit, back.newTree], [0, GIT.commit2, GIT.root]);
  assert.deepEqual([e2.span('git.push_tree.diff').attrs['git.push_tree.diff.cache_hits'], e2.span('git.push_tree.diff').attrs['git.push_tree.diff.trees_read']], [2, 0]);
  // the same files again: noop, no receive-pack
  const e3 = env(r); const before = r.pushes().length;
  const noop = await pushTree('http://fake/r.git', { files: FILES(), author: A, message: 'other', time: T0 + 5 }, e3.opts);
  assert.deepEqual(noop, {
    noop: true, ref: 'refs/heads/main', oldCommit: back.newCommit, newCommit: back.newCommit, oldTree: GIT.root, newTree: GIT.root, hint: null, attempt: 0,
    pushBytes: 0, treesRead: 0, objects: { files: 6, trees: 3, sent: 0, sentTrees: 0, sentBlobs: 0, treeDeltas: 0 },
  });
  assert.equal(r.pushes().length, before);
  assert.equal(e3.span('git.push_tree').attrs['git.push_tree.outcome'], 'noop');
});

test('pushTree: parent trees are read only where both sides are directories with different oids', async () => {
  const r = remote(); r.commit({ d: { mode: '120000', data: 'x' }, 'e/f': '1', 'g/h': '1', 'same/x': 's' });
  // d becomes a directory, e becomes a file, g changes, same is unchanged
  const res = await pushTree('http://fake/r.git', { files: { 'd/y': '2', e: '3', 'g/h': '2', 'same/x': 's' }, author: A, message: 'm', time: T0 }, env(r).opts);
  assert.equal(res.treesRead, 2, 'the root and g');
  assert.deepEqual(r.fetches().slice(1).map(f => f.wants[0]).length, 2);
  const parsed = parseTree(r.objects.get(parseCommit(r.objects.get(res.newCommit).data).tree).data);
  assert.deepEqual(parsed.map(x => [x.name, x.mode]), [['d', '40000'], ['e', '100644'], ['g', '40000'], ['same', '40000']]);
  // the pushed tree resolves on the server (every delta base and blob it needs is there)
  assert.equal(r.refs.get('refs/heads/main'), res.newCommit);
});

test('pushTree: create a ref from base, refuse an absent base', async () => {
  const r = remote(); r.commit(FILES());
  const res = await pushTree('http://fake/r.git', { ref: 'refs/heads/topic', base: 'refs/heads/main', files: { ...FILES(), 'src/a.js': 'A\n' }, author: A, message: 'deploy', time: T0 }, env(r).opts);
  assert.equal(res.newCommit, GIT.commit2);
  assert.equal(res.oldCommit, GIT.commit);
  assert.deepEqual(r.pushes()[0].commands, [{ old: ZERO_OID, new: GIT.commit2, ref: 'refs/heads/topic' }]);
  assert.equal(r.refs.get('refs/heads/main'), GIT.commit);
  // base = the new ref's own tree: still a commit, never a noop, when creating
  const same = await pushTree('http://fake/r.git', { ref: 'refs/heads/copy', base: 'refs/heads/main', files: FILES(), author: A, message: 'deploy', time: T0 }, env(r).opts);
  assert.equal(same.noop, false);
  assert.equal(r.refs.get('refs/heads/copy'), same.newCommit);
  const e = env(r);
  await rejects(pushTree('http://fake/r.git', { ref: 'refs/heads/x', base: 'refs/heads/gone', files: {}, author: A, message: 'm', time: T0 }, e.opts), 'not_found', 'ref refs/heads/gone not found', { attempt: 0, hint: null, miss: { kind: 'ref', ref: 'refs/heads/gone', candidates: ['refs/heads/gone'] } });
  assert.equal(e.span('git.push_tree').attrs['git.push_tree.outcome'], 'not_found');
});

test('pushTree: a lost race is retried once from a fresh ls-refs, linked to the first attempt; a second loss is thrown', async () => {
  const r = remote({ hook: async req => { if (req.service === 'git-receive-pack' && moves-- > 0) r.commit({ other: String(moves) }, { parents: [r.refs.get('refs/heads/main')] }); } });
  let moves = 1;
  r.commit(FILES());
  const e = env(r);
  const res = await pushTree('http://fake/r.git', { files: { ...FILES(), 'src/a.js': 'A\n' }, author: A, message: 'deploy', time: T0 }, e.opts);
  assert.equal(res.attempt, 1);
  const raced = parseCommit(r.objects.get(r.refs.get('refs/heads/main')).data);
  assert.equal(raced.tree, GIT.root2);
  assert.deepEqual(raced.parents, [res.oldCommit]);
  assert.notEqual(res.oldCommit, GIT.commit);
  const roots = e.all('git.push_tree');
  assert.deepEqual(roots.map(s => [s.attrs['git.push_tree.attempt'], s.attrs['git.push_tree.outcome']]), [[0, 'cas_conflict'], [1, 'ok']]);
  assert.deepEqual(roots[1].links.map(l => [l.spanId, l.attrs['ply.link']]), [[roots[0].spanId, 'retry_of']]);
  assert.equal(roots[0].links.length, 0);
  moves = 2;
  const e2 = env(r);
  await rejects(pushTree('http://fake/r.git', { files: { ...FILES(), 'src/a.js': 'B\n' }, author: A, message: 'deploy', time: T0 }, e2.opts), 'cas_conflict', 'push rejected: fetch first', { attempt: 1 });
  assert.equal(e2.all('git.push_tree').length, 2);
});

const settled = p => p.then(value => ({ settled: 'resolved', value }), reason => ({ settled: 'rejected', reason }));

test('editFile: a lost race is retried once from a fresh ls-refs', async () => {
  let moves = 1;
  // the raced commit keeps the current tree, so the retry still finds the file the edit names
  const r = remote({ hook: async req => {
    if (req.service !== 'git-receive-pack' || moves-- <= 0) return;
    const cur = r.refs.get('refs/heads/main');
    const tree = parseCommit(r.objects.get(cur).data).tree;
    const who = `A <a@x> ${T0} +0000`;
    r.refs.set('refs/heads/main', r.put('commit', encodeCommit({ tree, parents: [cur], author: who, committer: who, message: 'raced\n' })));
  } });
  r.commit(FILES());
  const e = env(r);
  const res = await editFile('http://fake/r.git', { path: 'README', find: 'hello', replace: 'HELLO', author: A, message: 'm', time: T0 }, e.opts);
  assert.equal(res.attempt, 1);
  assert.equal(res.noop, false);
  assert.deepEqual(e.all('git.edit').map(s => [s.attrs['git.edit.attempt'], s.attrs['git.edit.outcome']]), [[0, 'cas_conflict'], [1, 'ok']]);
  // a hint on the lost attempt is what the retry reports, and the retry's span links to the first
  moves = 1;
  const hinted = env(r);
  const again = await editFile('http://fake/r.git', { path: 'README', find: 'HELLO', replace: 'AGAIN', author: A, message: 'm', time: T0 }, { ...hinted.opts, head: r.refs.get('refs/heads/main') });
  assert.deepEqual([again.attempt, again.hint], [1, 'used']);
  const roots = hinted.all('git.edit');
  assert.deepEqual(roots[1].links.map(l => [l.spanId, l.attrs['ply.link']]), [[roots[0].spanId, 'retry_of']]);
  // a non-conflict error is the one attempt, not a retry
  const missing = env(r);
  await rejects(editFile('http://fake/r.git', { ref: 'refs/heads/missing', path: 'README', find: 'a', replace: 'b', author: A, message: 'm', time: T0 }, missing.opts), 'not_found', 'ref refs/heads/missing not found', { miss: { kind: 'ref', ref: 'refs/heads/missing', candidates: ['refs/heads/missing'] } });
  assert.equal(missing.all('git.edit').length, 1);
});

test('lookupEntry: a missing name, a file along the way, and a last component that is not a regular file', () => {
  const tree = encodeTree([
    { name: 'README', mode: '100644', oid: GIT.readme },
    { name: 'src', mode: '40000', oid: GIT.src },
    { name: 'sub', mode: '160000', oid: GITLINK },
    { name: 'link', mode: '120000', oid: GIT.link },
    { name: 'run.sh', mode: '100755', oid: GIT.run },
  ]);
  throws(() => lookupEntry(tree, 'nope', true, DEFAULT_LIMITS), 'not_found', 'path component nope not found', { miss: { kind: 'path', missing: 'nope', existingPath: '' } });
  throws(() => lookupEntry(tree, 'README', false, DEFAULT_LIMITS), 'not_found', 'README is not a directory', { miss: { kind: 'not_directory', path: 'README', mode: '100644' } });
  assert.equal(lookupEntry(tree, 'src', false, DEFAULT_LIMITS).entry.oid, GIT.src);
  throws(() => lookupEntry(tree, 'src', true, DEFAULT_LIMITS), 'not_found', 'src is not a regular file (mode 40000)', { miss: { kind: 'is_directory', path: 'src', tree: GIT.src } });
  throws(() => lookupEntry(tree, 'sub', true, DEFAULT_LIMITS), 'not_found', 'sub is not a regular file (mode 160000)', { miss: { kind: 'submodule', path: 'sub', commit: GITLINK } });
  throws(() => lookupEntry(tree, 'link', true, DEFAULT_LIMITS), 'not_found', 'link is not a regular file (mode 120000)', { miss: { kind: 'not_directory', path: 'link', mode: '120000' } });
  assert.equal(lookupEntry(tree, 'README', true, DEFAULT_LIMITS).entry.oid, GIT.readme);
  assert.equal(lookupEntry(tree, 'run.sh', true, DEFAULT_LIMITS).entry.mode, '100755');
});

test('editFile and pushTree: a non-Error from the first attempt is a rejection, and is not retried', async () => {
  // a plain object whose code is cas_conflict used to come back as the resolved value; an Error with that code is retried once
  const plain = { code: 'cas_conflict', message: 'not an Error' };
  const r = remote();
  r.commit(FILES());
  let calls = 0;
  const e = env(r);
  const real = e.transport.frames;
  e.transport.frames = (...args) => { calls += 1; if (calls === 1) throw plain; return real(...args); };
  const edit = await settled(editFile('http://fake/r.git', { path: 'README', find: 'hello', replace: 'HELLO', author: A, message: 'm', time: T0 }, e.opts));
  assert.deepEqual(edit, { settled: 'rejected', reason: plain });
  assert.equal(calls, 1, 'a non-Error is not a cas_conflict retry');
  calls = 0;
  const tree = await settled(pushTree('http://fake/r.git', { files: { ...FILES(), 'src/a.js': 'A\n' }, author: A, message: 'm', time: T0 }, e.opts));
  assert.deepEqual(tree, { settled: 'rejected', reason: plain });
  assert.equal(calls, 1);
  // a string thrown after the protocol (the caller's signer) is not wrapped, and is not the return value
  const e2 = env(r);
  const before = r.pushes().length;
  const signer = { kind: 'ssh-ed25519', publicKeyLine: 'ssh-ed25519 AAAA', sign() { throw 'x'; } };
  const signed = await settled(pushTree('http://fake/r.git', { files: { ...FILES(), 'src/a.js': 'B\n' }, author: A, message: 'm', time: T0 }, { ...e2.opts, signer }));
  assert.deepEqual(signed, { settled: 'rejected', reason: 'x' });
  assert.equal(r.pushes().length, before);
  const editSigned = await settled(editFile('http://fake/r.git', { path: 'README', find: 'hello', replace: 'HELLO', author: A, message: 'm', time: T0 }, { ...env(r).opts, signer: { ...signer, sign() { throw 'y'; } } }));
  assert.deepEqual(editSigned, { settled: 'rejected', reason: 'y' });
});

test('pushTree: git.push_tree.diff belongs to the operation tracer, in the root span\'s trace', async () => {
  const r = remote(); r.commit(FILES());
  const opEx = arrayExporter(); const opTracer = new Tracer({ exporter: opEx });
  const wireEx = arrayExporter(); const wireTracer = new Tracer({ exporter: wireEx });
  await pushTree('http://fake/r.git', { files: { ...FILES(), 'src/a.js': 'A\n' }, author: A, message: 'deploy', time: T0 }, { tracer: opTracer, transport: r.transport({ tracer: wireTracer }) });
  const op = opEx.lines.flatMap(flattenLine);
  const root = op.find(s => s.name === 'git.push_tree');
  const diff = op.find(s => s.name === 'git.push_tree.diff');
  assert.ok(root && diff, 'the diff span is exported with the operation');
  assert.equal(diff.traceId, root.traceId);
  assert.equal(diff.parentSpanId, root.spanId);
  const wire = wireEx.lines.flatMap(flattenLine);
  assert.equal(wire.some(s => s.name === 'git.push_tree.diff'), false);
  assert.equal(wire.some(s => s.name === 'git.upload-pack ls-refs'), true);
});

test('otel: end() scrubs an empty status message and leaves an unset message unset', () => {
  const ex = arrayExporter(); const t = new Tracer({ exporter: ex });
  const empty = t.start('git.op', { scrub: s => (s === '' ? 'EMPTY' : s.replaceAll('SECRET', '[redacted]')) });
  empty.status = { code: 2, message: '' };
  empty.end();
  const secret = t.start('git.op', { scrub: s => s.replaceAll('SECRET', '[redacted]') });
  secret.status = { code: 2, message: 'SECRET' };
  secret.end();
  const ok = t.start('git.op', { scrub: () => 'CALLED' });
  ok.end();
  const [a, b, c] = ex.lines.flatMap(flattenLine);
  assert.equal(a.status.message, 'EMPTY');
  assert.equal(b.status.message, '[redacted]');
  assert.equal(c.status.message, undefined);
});

test('pushTree: the head hint — used, stale, a failed speculative fetch, and strictHead', async () => {
  const r = remote(); r.commit(FILES());
  const files = { ...FILES(), 'src/a.js': 'A\n' };
  const spec = { files, author: A, message: 'deploy', time: T0 };
  await rejects(pushTree('http://fake/r.git', spec, { ...env(r).opts, strictHead: true }), 'bad_request', 'strictHead needs head');
  assert.equal(r.log.length, 0);
  // used: the speculative commit is the parent, fetched once
  const e = env(r);
  const used = await pushTree('http://fake/r.git', spec, { ...e.opts, head: GIT.commit });
  assert.deepEqual([used.hint, used.newCommit], ['used', GIT.commit2]);
  assert.equal(r.fetches().filter(f => f.wants[0] === GIT.commit).length, 1);
  assert.deepEqual([e.span('git.push_tree').attrs['git.push_tree.head.hint'], e.span('git.push_tree').attrs['git.push_tree.head.outcome']], [GIT.commit, 'used']);
  // stale: ls-refs wins, the real parent is fetched as well
  r.log.length = 0;
  const stale = await pushTree('http://fake/r.git', { ...spec, files: FILES() }, { ...env(r).opts, head: GIT.commit });
  assert.deepEqual([stale.hint, stale.oldCommit], ['stale', GIT.commit2]);
  assert.deepEqual(r.fetches().filter(f => f.deepen === 1).map(f => f.wants[0]).sort(), [GIT.commit, GIT.commit2].sort());
  // a hint the server does not have: recorded, and the push goes on from ls-refs
  const e3 = env(r);
  const ghost = 'd'.repeat(40);
  const res = await pushTree('http://fake/r.git', { ...spec, files: { x: '1' } }, { ...e3.opts, head: ghost });
  assert.equal(res.hint, 'stale');
  assert.equal(e3.span('git.push_tree').attrs['git.push_tree.head.speculative_error'], 'remote_error');
  assert.equal(e.span('git.push_tree').attrs['git.push_tree.head.speculative_error'], undefined);
  // strictHead with a stale hint: cas_conflict, never retried
  const e4 = env(r); r.log.length = 0;
  await rejects(pushTree('http://fake/r.git', { ...spec, files: { y: '1' } }, { ...e4.opts, head: GIT.commit, strictHead: true }), 'cas_conflict',
    `refs/heads/main is at ${res.newCommit}, not the expected head ${GIT.commit}`, { expected: GIT.commit, actual: res.newCommit, attempt: 0, hint: 'stale' });
  assert.equal(e4.all('git.push_tree').length, 1);
  assert.equal(r.pushes().length, 0);
  // strictHead with a matching hint pushes; with an absent ref, the hint is stale against nothing
  const ok = await pushTree('http://fake/r.git', { ...spec, files: { y: '1' } }, { ...env(r).opts, head: res.newCommit, strictHead: true });
  assert.equal(ok.hint, 'used');
  await rejects(pushTree('http://fake/r.git', { ...spec, ref: 'refs/heads/none' }, { ...env(r).opts, head: GIT.commit, strictHead: true }), 'cas_conflict',
    `refs/heads/none is at nothing, not the expected head ${GIT.commit}`);
});

test('pushTree: a lost race with a hint retries without it and reports the first hint', async () => {
  let moves = 1;
  const r = remote({ hook: async req => { if (req.service === 'git-receive-pack' && moves-- > 0) r.commit({ other: 'x' }, { parents: [r.refs.get('refs/heads/main')] }); } });
  r.commit(FILES());
  const e = env(r);
  const res = await pushTree('http://fake/r.git', { files: { z: '1' }, author: A, message: 'm', time: T0 }, { ...e.opts, head: GIT.commit });
  assert.deepEqual([res.attempt, res.hint], [1, 'used']);
  const roots = e.all('git.push_tree');
  assert.deepEqual(roots.map(s => [s.attrs['git.push_tree.head.hint'], s.attrs['git.push_tree.head.outcome']]), [[GIT.commit, 'used'], ['', 'used']]);
});

test('pushTree: verify reads the ref back; a different value after an acknowledged push is ambiguous', async () => {
  const r = remote();
  const e = env(r);
  const res = await pushTree('http://fake/r.git', { files: FILES(), author: A, message: 'deploy', time: T0 }, { ...e.opts, verify: true });
  assert.equal(res.newCommit, GIT.commit);
  assert.equal(e.span('git.push_tree').attrs['git.push_tree.verify.ref'], GIT.commit);
  let pushed = false;
  const liar = remote({ hook: async req => { if (req.service === 'git-receive-pack') pushed = true; else if (pushed && req.command === 'ls-refs') return [{ kind: 'flush' }]; } });
  await rejects(pushTree('http://fake/r.git', { files: FILES(), author: A, message: 'deploy', time: T0 }, { ...env(liar).opts, verify: true }), 'ambiguous',
    `push reported ok but refs/heads/main is absent, not ${GIT.commit}`);
  // without verify, the same server is believed
  pushed = false;
  assert.equal((await pushTree('http://fake/r.git', { ref: 'refs/heads/b', files: FILES(), author: A, message: 'deploy', time: T0 }, env(liar).opts)).newCommit, GIT.commit);
});

test('pushTree: a signer\'s signature is in the pushed commit and on the span', async () => {
  const r = remote(); const e = env(r);
  const sig = '-----BEGIN SSH SIGNATURE-----\nU0lH\n-----END SSH SIGNATURE-----\n';
  const signer = { kind: 'ssh', publicKeyLine: 'ssh-ed25519 AAAA', sign: async () => sig };
  const res = await pushTree('http://fake/r.git', { files: FILES(), author: A, message: 'deploy', time: T0 }, { ...e.opts, signer });
  const c = parseCommit(r.objects.get(res.newCommit).data);
  assert.equal(c.tree, GIT.root);
  assert.ok(c.extra.some(l => l.startsWith('gpgsig -----BEGIN SSH SIGNATURE-----')));
  assert.notEqual(res.newCommit, GIT.commit);
  const root = e.span('git.push_tree');
  assert.deepEqual([root.attrs['git.push_tree.commit.signed'], root.attrs['git.push_tree.commit.signer']], ['ssh', 'ssh-ed25519 AAAA']);
  const r2 = remote(); const e2 = env(r2);
  await pushTree('http://fake/r.git', { files: FILES(), author: A, message: 'deploy', time: T0 }, { ...e2.opts, signer: { kind: 'x', sign: async () => sig } });
  assert.equal(e2.span('git.push_tree').attrs['git.push_tree.commit.signer'], '');
  assert.equal(env(remote()).span('git.push_tree'), undefined);
  assert.equal(e2.spans().find(s => s.name === 'git.push_tree').attrs['git.push_tree.commit.signed'], 'x');
  const plain = env(remote());
  await pushTree('http://fake/r.git', { files: FILES(), author: A, message: 'deploy', time: T0 }, plain.opts);
  assert.equal(plain.span('git.push_tree').attrs['git.push_tree.commit.signed'], undefined);
});

// ======================================================================================================================
// checkout.js
// ======================================================================================================================

test('canonMode is git\'s canon_mode', () => {
  for (const m of ['120000', '160000', '40000']) assert.equal(canonMode(m), m);
  const cases = { 100644: '100644', 100755: '100755', 100664: '100644', 100600: '100644', 100000: '100644', 100700: '100755', 100100: '100755', 100744: '100755', 100777: '100755', 100677: '100644' };
  for (const [m, want] of Object.entries(cases)) assert.equal(canonMode(m), want, m);
  // the low 16 bits, as tree-walk keeps them (observed with git ls-tree 2.50): a type git does not know is a gitlink,
  // and the digits above the sixth from the right are gone
  const odd = { 100: '160000', 1006440: '160000', 200644: '160000', 120001: '120000', 160001: '160000', 4000: '160000', 140000: '160000', 40755: '40000', 7100644: '100644', 300644: '100644', 107777: '100755', 1: '160000', 777777: '160000' };
  for (const [m, want] of Object.entries(odd)) assert.equal(canonMode(m), want, m);
  // what parse_mode refuses (empty, a non-octal byte) or fsck --strict errors on (zero-padded), and non-strings
  for (const m of ['0100644', '040000', '0', '100648', '100x44', '', 'x100644', '100644x', ' 100644', '8']) assert.equal(canonMode(m), null, m);
  assert.equal(canonMode(100644), null);
});

test('treeFiles: depth-first in tree order, canonical modes, every refusal', () => {
  const trees = new Map([
    ['r', [{ mode: '100664', name: 'a', oid: '1' }, { mode: '40000', name: 'd', oid: 'd' }, { mode: '160000', name: 'g', oid: '2' }, { mode: '100755', name: 'z', oid: '3' }]],
    ['d', [{ mode: '120000', name: 'l', oid: '4' }, { mode: '40000', name: 'e', oid: 'e' }]],
    ['e', [{ mode: '100644', name: 'f', oid: '5' }]],
  ]);
  const tree = oid => trees.get(oid);
  assert.deepEqual(treeFiles(tree, 'r'), [
    { path: 'a', mode: '100644', oid: '1' }, { path: 'd/l', mode: '120000', oid: '4' }, { path: 'd/e/f', mode: '100644', oid: '5' },
    { path: 'g', mode: '160000', oid: '2' }, { path: 'z', mode: '100755', oid: '3' },
  ]);
  assert.deepEqual(treeFiles(tree, 'e'), [{ path: 'f', mode: '100644', oid: '5' }]);
  // 3 + 2 + 1 = 6 entries visited, trees included; 9 at the root level would be 9
  assert.equal(treeFiles(tree, 'r', { limits: withLimits({ maxPackObjects: 7 }) }).length, 5);
  throws(() => treeFiles(tree, 'r', { limits: withLimits({ maxPackObjects: 6 }) }), 'limit_exceeded', 'checkout entries 7 exceeds limit 6', { what: 'checkout entries', got: 7, max: 6 });
  // depth: d/e/f is level 3
  assert.equal(treeFiles(tree, 'r', { limits: withLimits({ maxPathDepth: 3 }) }).length, 5);
  throws(() => treeFiles(tree, 'r', { limits: withLimits({ maxPathDepth: 2 }) }), 'limit_exceeded', 'path depth 3 exceeds limit 2', { what: 'path depth' });
  throws(() => treeFiles(tree, 'e', { depth: 2, limits: withLimits({ maxPathDepth: 2 }) }), 'limit_exceeded', 'path depth 3 exceeds limit 2');
  assert.equal(treeFiles(tree, 'e', { depth: 1, limits: withLimits({ maxPathDepth: 2 }) }).length, 1);
  const dup = new Map([['r', [{ mode: '100644', name: 'a', oid: '1' }, { mode: '40000', name: 'a', oid: 'x' }]], ['x', []]]);
  throws(() => treeFiles(o => dup.get(o), 'r'), 'pack_corrupt', 'tree r: duplicate entry "a" (git fsck duplicateEntries)');
  // the same name in two different trees is not a duplicate
  const two = new Map([['r', [{ mode: '40000', name: 'a', oid: 'x' }, { mode: '40000', name: 'b', oid: 'x' }]], ['x', [{ mode: '100644', name: 'a', oid: '1' }]]]);
  assert.deepEqual(treeFiles(o => two.get(o), 'r').map(f => f.path), ['a/a', 'b/a']);
  const bad = new Map([['r', [{ mode: '40755', name: 'd', oid: 'd' }]], ['d', [{ mode: '100648', name: 'x', oid: '1' }]]]);
  throws(() => treeFiles(o => bad.get(o), 'r'), 'pack_corrupt', 'tree d: d/x has mode 100648, which git cannot check out');
  throws(() => treeFiles(tree, 'r', { limits: {} }), 'bad_request', 'limits.maxPackObjects must be a finite non-negative number');
  throws(() => treeFiles(tree, 'r', { limits: { maxPackObjects: 9 } }), 'bad_request', 'limits.maxPathDepth must be a finite non-negative number');
});

const drain = async files => { const out = []; for await (const f of files) out.push({ path: f.path, mode: f.mode, oid: f.oid, size: f.size, text: f.stream ? await readAll(f.stream) : null }); return out; };

test('checkoutTree: one blob:none fetch for the trees, blobs in batches, gitlinks first', async () => {
  const r = remote(); r.commit(FILES());
  const e = env(r);
  const res = await checkoutTree('http://fake/r.git', {}, e.opts);
  assert.deepEqual([res.ref, res.commit, res.tree, res.path], ['refs/heads/main', GIT.commit, GIT.root, '']);
  assert.deepEqual(res.entries, [
    { path: 'README', mode: '100644', oid: GIT.readme }, { path: 'link', mode: '120000', oid: GIT.link }, { path: 'run.sh', mode: '100755', oid: GIT.run },
    { path: 'src/a.js', mode: '100644', oid: GIT.a }, { path: 'src/lib/b.js', mode: '100644', oid: GIT.b }, { path: 'sub', mode: '160000', oid: GITLINK },
  ]);
  const [trees] = r.fetches();
  assert.deepEqual([trees.wants, trees.filter, trees.deepen], [[GIT.commit], 'blob:none', 1]);
  const root = e.span('git.checkout');
  assert.deepEqual(Object.fromEntries(Object.entries(root.attrs).filter(([k]) => k.startsWith('git.checkout.'))), {
    'git.checkout.url': 'http://fake/r.git', 'git.checkout.ref': 'HEAD', 'git.checkout.path': '', 'git.checkout.batch': 1000,
    'git.checkout.commit': GIT.commit, 'git.checkout.tree': GIT.root, 'git.checkout.entries': 6, 'git.checkout.pack.objects': 4, 'git.checkout.pack.trees': 3,
    'git.checkout.outcome': 'ok',
  });
  const files = await drain(res.files);
  assert.deepEqual(files.map(f => [f.path, f.size, f.text]), [
    ['sub', 0, null], ['README', 6, 'hello\n'], ['link', 6, 'README'], ['run.sh', 10, '#!/bin/sh\n'], ['src/a.js', 2, 'a\n'], ['src/lib/b.js', 2, 'b\n'],
  ]);
  assert.deepEqual(r.fetches().slice(1).map(f => [f.wants.length, f.filter]), [[5, null]]);
  const blobs = e.span('git.checkout.blobs');
  // consumed after checkoutTree returns: a root of its own trace that follows the checkout root (README "Span lifetimes")
  assert.deepEqual([blobs.parentSpanId, blobs.links.map(l => [l.traceId, l.spanId, l.attrs['ply.link']])], [undefined, [[root.traceId, root.spanId, 'follows_from']]]);
  assert.notEqual(blobs.traceId, root.traceId);
  assert.deepEqual(Object.fromEntries(Object.entries(blobs.attrs).filter(([k]) => k.startsWith('git.checkout.'))), {
    'git.checkout.blobs.unique': 5, 'git.checkout.blobs.paths': 6, 'git.checkout.blobs.fetches': 1, 'git.checkout.blobs.buffered': 5, 'git.checkout.blobs.streamed': 0,
    'git.checkout.blobs.splits': 0, 'git.checkout.blobs.bytes': 26, 'git.checkout.blobs.single': false, 'git.checkout.blobs.outcome': 'ok',
  });
});

test('checkoutTree: a subtree by path, a ref by short name, batch bounds', async () => {
  const r = remote(); r.commit(FILES()); r.commit({ x: '1' }, { ref: 'refs/tags/v1' });
  for (const path of ['src', 'src/']) {
    const res = await checkoutTree('http://fake/r.git', { ref: 'main', path }, env(r).opts);
    assert.deepEqual([res.ref, res.tree, res.path], ['refs/heads/main', GIT.src, 'src']);
    assert.deepEqual(res.entries.map(x => x.path), ['a.js', 'lib/b.js']);
  }
  for (const path of [undefined, null, '', '/']) assert.equal((await checkoutTree('http://fake/r.git', { path }, env(r).opts)).tree, GIT.root);
  await rejects(checkoutTree('http://fake/r.git', { path: ['src'] }, env(r).opts), 'bad_request', 'invalid path: must be a non-empty string');
  const deep = await checkoutTree('http://fake/r.git', { path: 'src/lib' }, env(r).opts);
  assert.deepEqual([deep.tree, deep.entries.map(x => x.path)], [GIT.lib, ['b.js']]);
  assert.equal((await checkoutTree('http://fake/r.git', { ref: 'v1' }, env(r).opts)).ref, 'refs/tags/v1');
  await rejects(checkoutTree('http://fake/r.git', { path: 'nope' }, env(r).opts), 'not_found', 'path component nope not found', { miss: { kind: 'path', missing: 'nope', existingPath: '' } });
  await rejects(checkoutTree('http://fake/r.git', { path: 'src/nope' }, env(r).opts), 'not_found', 'path component nope not found', { miss: { kind: 'path', missing: 'nope', existingPath: 'src' } });
  await rejects(checkoutTree('http://fake/r.git', { path: 'src/lib/nope' }, env(r).opts), 'not_found', 'path component nope not found', { miss: { kind: 'path', missing: 'nope', existingPath: 'src/lib' } });
  await rejects(checkoutTree('http://fake/r.git', { path: 'src/a.js' }, env(r).opts), 'not_found', 'src/a.js is not a directory (mode 100644)', { miss: { kind: 'not_directory', path: 'src/a.js', mode: '100644' } });
  await rejects(checkoutTree('http://fake/r.git', { path: 'README/x' }, env(r).opts), 'not_found', 'README is not a directory (mode 100644)', { miss: { kind: 'not_directory', path: 'README', mode: '100644' } });
  await rejects(checkoutTree('http://fake/r.git', { path: '../x' }, env(r).opts), 'bad_request');
  for (const batch of [0, -1, 1.5, NaN, '2', 3]) {
    await rejects(checkoutTree('http://fake/r.git', {}, { ...env(r).opts, batch, limits: withLimits({ maxPackObjects: 2 }) }), 'bad_request', 'batch must be an integer from 1 to limits.maxPackObjects', { what: 'batch' });
  }
  const n = r.log.length;
  const two = await checkoutTree('http://fake/r.git', {}, { ...env(r).opts, batch: 2, limits: withLimits({ maxPackObjects: 100 }) });
  assert.equal(two.entries.length, 6);
  await drain(two.files);
  assert.deepEqual(r.fetches().slice(-3).map(f => f.wants.length), [2, 2, 1], 'five blobs in wants lists of two; the last alone');
  assert.ok(r.log.length > n);
  const one = await checkoutTree('http://fake/r.git', {}, { ...env(r).opts, batch: 1 });
  assert.deepEqual((await drain(one.files)).map(f => f.text), [null, 'hello\n', 'README', '#!/bin/sh\n', 'a\n', 'b\n']);
});

test('checkoutTree: a bare commit oid, a non-commit, missing trees and a short pack', async () => {
  const r = remote(); const c = r.commit(FILES());
  const e = env(r);
  const res = await checkoutTree('http://fake/r.git', { ref: c }, e.opts);
  assert.deepEqual([res.ref, res.commit], [c, c]);
  assert.equal(r.log.filter(x => x.command === 'ls-refs').length, 0, 'a bare oid needs no ls-refs');
  assert.equal(e.span('git.checkout').attrs['git.checkout.ref'], c);
  const missing = 'e'.repeat(40);
  await rejects(checkoutTree('http://fake/r.git', { ref: missing }, env(r).opts), 'not_found', `commit ${missing} not found on the remote`, { miss: { kind: 'commit', miss: { kind: 'absent', oid: missing } } });
  await rejects(checkoutTree('http://fake/r.git', { ref: GIT.src }, env(r).opts), 'not_found', `${GIT.src} is not a commit`, { miss: { kind: 'commit', miss: { kind: 'not_commit', oid: GIT.src, type: 'tree' } } });
  await rejects(checkoutTree('http://fake/r.git', { ref: GIT.readme }, env(r).opts), 'not_found', `${GIT.readme} is not a commit`, { miss: { kind: 'commit', miss: { kind: 'not_commit', oid: GIT.readme, type: 'blob' } } });
  // a pack without the commit, or without a tree under it
  const only = async oids => (await buildPack(oids.map(o => r.objects.get(o)))).pack;
  const lying = pack => remote({ hook: async req => (req.command === 'fetch' ? packFrames(await pack()) : undefined) });
  const noCommit = lying(() => only([GIT.root])); noCommit.refs.set('refs/heads/main', c); noCommit.objects.set(c, r.objects.get(c));
  await rejects(checkoutTree('http://fake/r.git', {}, env(noCommit).opts), 'pack_corrupt', `commit ${c} not in the blob:none pack (1 objects)`);
  const noTree = lying(() => only([c, GIT.root])); noTree.refs.set('refs/heads/main', c); noTree.objects.set(c, r.objects.get(c));
  await rejects(checkoutTree('http://fake/r.git', {}, env(noTree).opts), 'pack_corrupt', `tree ${GIT.src} not in the blob:none pack`);
  // a blob where a tree should be is still a missing tree
  const blobTree = lying(() => only([c, GIT.readme])); blobTree.refs.set('refs/heads/main', c); blobTree.objects.set(c, r.objects.get(c));
  await rejects(checkoutTree('http://fake/r.git', {}, env(blobTree).opts), 'pack_corrupt', `tree ${GIT.root} not in the blob:none pack`);
  const other = remote({ hook: async req => (req.command === 'fetch' ? [dataFrame('ERR upload-pack: something else')] : undefined) }); other.refs.set('refs/heads/main', c);
  await rejects(checkoutTree('http://fake/r.git', {}, env(other).opts), 'remote_error', 'remote: upload-pack: something else');
  const absent = remote(); absent.refs.set('refs/heads/main', c);
  await rejects(checkoutTree('http://fake/r.git', {}, env(absent).opts), 'not_found', `commit ${c} not found on the remote`, { miss: { kind: 'commit', miss: { kind: 'absent', oid: c } } });
  // a pack_corrupt that happens to carry not_our_ref is still pack_corrupt: only remote_error is reclassified
  const odd = remote({ hook: async req => { if (req.command !== 'fetch') return; const e = new Error('odd'); e.code = 'pack_corrupt'; e.reason = 'not_our_ref'; throw e; } });
  odd.refs.set('refs/heads/main', c);
  await rejects(checkoutTree('http://fake/r.git', {}, env(odd).opts), 'pack_corrupt', 'odd');
});

test('checkoutTree: one blob at two paths is fetched once and yielded twice, each with its own stream', async () => {
  const r = remote(); r.commit({ 'a/x': 'same\n', 'b/x': 'same\n', c: 'other\n' });
  const e = env(r);
  const res = await checkoutTree('http://fake/r.git', {}, e.opts);
  const files = await drain(res.files);
  assert.deepEqual(files.map(f => [f.path, f.text]), [['a/x', 'same\n'], ['b/x', 'same\n'], ['c', 'other\n']]);
  assert.deepEqual(r.fetches().slice(1).map(f => f.wants.length), [2]);
  const s = e.span('git.checkout.blobs').attrs;
  assert.deepEqual([s['git.checkout.blobs.unique'], s['git.checkout.blobs.paths'], s['git.checkout.blobs.buffered'], s['git.checkout.blobs.bytes']], [2, 3, 3, 16]);
  // an empty blob streams nothing and ends
  const z = remote(); z.commit({ e: '', f: 'x' });
  assert.deepEqual((await drain((await checkoutTree('http://fake/r.git', {}, env(z).opts)).files)).map(f => [f.path, f.size, f.text]), [['e', 0, ''], ['f', 1, 'x']]);
});

test('checkoutTree: a batch over a cap splits in half; one left alone streams on its own', async () => {
  const r = remote({ hook: async req => { if (req.command === 'fetch' && req.filter === null && req.wants.length > 2) throw fail('limit_exceeded', 'pack bytes 9 exceeds limit 1', { what: 'pack bytes' }); } });
  r.commit({ a: '1', b: '2', c: '3', d: '4', e: '5' });
  const e = env(r);
  const files = await drain((await checkoutTree('http://fake/r.git', {}, { ...e.opts, batch: 5 })).files);
  assert.deepEqual(files.map(f => f.text), ['1', '2', '3', '4', '5']);
  // 5 → 3 + 2 → (2 + 1) + 2: the singles stream
  assert.deepEqual(r.fetches().slice(1).map(f => f.wants.length), [5, 3, 2, 1, 2]);
  const s = e.span('git.checkout.blobs').attrs;
  assert.deepEqual([s['git.checkout.blobs.splits'], s['git.checkout.blobs.fetches'], s['git.checkout.blobs.buffered'], s['git.checkout.blobs.streamed'], s['git.checkout.blobs.bytes']], [2, 2, 4, 1, 5]);
  assert.equal(e.all('git.read.blob').length, 1);
  const [rb, cb] = [e.span('git.read.blob'), e.span('git.checkout.blobs')];
  assert.deepEqual([rb.parentSpanId, rb.links.map(l => [l.traceId, l.spanId, l.attrs['ply.link']])], [undefined, [[cb.traceId, cb.spanId, 'follows_from']]]);
  assert.deepEqual(cb.links.filter(l => l.attrs['ply.link'] === 'followed_by').map(l => l.spanId), [rb.spanId], 'the blobs span, open when the stream starts, links back');
});

test('checkoutTree: a host refusing many wants is asked one at a time from then on; a lie is never a reason to fall back', async () => {
  const refusing = code => remote({ hook: async req => { if (req.command === 'fetch' && req.filter === null && req.wants.length > 1) throw fail(code, `${code} refused`); } });
  for (const code of ['http', 'remote_error', 'protocol']) {
    const r = refusing(code); r.commit({ a: '1', b: '2', c: '3' });
    const e = env(r);
    const files = await drain((await checkoutTree('http://fake/r.git', {}, { ...e.opts, batch: 2 })).files);
    assert.deepEqual(files.map(f => f.text), ['1', '2', '3']);
    assert.deepEqual(r.fetches().slice(1).map(f => f.wants.length), [2, 1, 1, 1], code);
    assert.equal(e.transport.quirks.blobWants, 'single');
    const s = e.span('git.checkout.blobs').attrs;
    assert.deepEqual([s['git.checkout.blobs.refused'], s['git.checkout.blobs.single'], s['git.checkout.blobs.streamed'], s['git.checkout.blobs.fetches']], [code, true, 3, 0]);
  }
  // remembered: a transport that already knows asks for singles from the start
  const r = remote(); r.commit({ a: '1', b: '2' });
  const e = env(r, { quirks: { blobWants: 'single' } });
  await drain((await checkoutTree('http://fake/r.git', {}, e.opts)).files);
  assert.deepEqual(r.fetches().slice(1).map(f => f.wants.length), [1, 1]);
  assert.equal(e.span('git.checkout.blobs').attrs['git.checkout.blobs.refused'], undefined);
  // a transport without quirks still falls back for the rest of this checkout
  const nq = refusing('http'); nq.commit({ a: '1', b: '2', c: '3' });
  const ne = env(nq, { quirks: null });
  assert.deepEqual((await drain((await checkoutTree('http://fake/r.git', {}, { ...ne.opts, batch: 2 })).files)).map(f => f.text), ['1', '2', '3']);
  assert.deepEqual(nq.fetches().slice(1).map(f => f.wants.length), [2, 1, 1, 1]);
  // other failures propagate and are the span's outcome
  for (const code of ['pack_corrupt', 'network']) {
    const bad = refusing(code); bad.commit({ a: '1', b: '2' });
    const be = env(bad);
    await rejects(drain((await checkoutTree('http://fake/r.git', {}, be.opts)).files), code, `${code} refused`);
    assert.equal(be.transport.quirks.blobWants, undefined);
    const s = be.span('git.checkout.blobs');
    assert.equal(s.attrs['git.checkout.blobs.outcome'], code);
    assert.equal(s.status.code, 2);
  }
});

test('checkoutTree: a batch pack with an unwanted object or a non-blob is pack_corrupt before any file', async () => {
  const r = remote(); const c = r.commit({ a: '1', b: '2' });
  const [a, b] = [hashObject('blob', te.encode('1')), hashObject('blob', te.encode('2'))];
  const serve = list => remote({ hook: async req => (req.command === 'fetch' && req.wants.length > 1 ? packFrames((await buildPack(list)).pack) : undefined) });
  const copy = s => { for (const [k, v] of r.objects) s.objects.set(k, v); s.refs.set('refs/heads/main', c); return s; };
  const extra = copy(serve([r.objects.get(a), r.objects.get(b), { type: TYPE.BLOB, data: te.encode('3') }]));
  const seen = [];
  await rejects((async () => { for await (const f of (await checkoutTree('http://fake/r.git', {}, env(extra).opts)).files) seen.push(f.path); })(), 'pack_corrupt',
    `object ${hashObject('blob', te.encode('3'))} served but not wanted (2 blobs asked for)`);
  assert.deepEqual(seen, []);
  const tree = copy(serve([r.objects.get(a), { type: TYPE.TREE, data: new Uint8Array(0) }]));
  await rejects(drain((await checkoutTree('http://fake/r.git', {}, env(tree).opts)).files), 'pack_corrupt', `object ${EMPTY_TREE} served but not wanted (2 blobs asked for)`);
  // a wanted oid whose object is a tree (the server lies about a blob entry)
  const t2 = remote(); const treeOid = t2.put('tree', new Uint8Array(0));
  const blobOid = t2.put('blob', 'x');
  t2.refs.set('refs/heads/main', t2.put('commit', encodeCommit({ tree: t2.put('tree', encodeTree([{ mode: '100644', name: 'f', oid: treeOid }, { mode: '100644', name: 'g', oid: blobOid }])), author: 'A <a@x> 1 +0000', message: 'm\n' })));
  await rejects(drain((await checkoutTree('http://fake/r.git', {}, env(t2).opts)).files), 'pack_corrupt', `expected blob ${treeOid}, got tree`);
  // a wanted blob the pack leaves out is streamed on its own
  const short = copy(serve([r.objects.get(a)]));
  const se = env(short);
  assert.deepEqual((await drain((await checkoutTree('http://fake/r.git', {}, se.opts)).files)).map(f => f.text), ['1', '2']);
  const s = se.span('git.checkout.blobs').attrs;
  assert.deepEqual([s['git.checkout.blobs.buffered'], s['git.checkout.blobs.streamed']], [1, 1]);
});

test('checkoutTree: stopping early ends the blobs span as cancelled', async () => {
  const r = remote(); r.commit({ a: '1', b: '2' });
  const e = env(r);
  const res = await checkoutTree('http://fake/r.git', {}, e.opts);
  for await (const f of res.files) { assert.equal(f.path, 'a'); break; }
  const s = e.span('git.checkout.blobs');
  assert.equal(s.attrs['git.checkout.blobs.outcome'], 'cancelled');
  assert.equal(s.status.code, 1);
  // gitlinks only: no fetch at all
  const g = remote(); g.commit({ s: { mode: '160000', oid: GITLINK } });
  const ge = env(g);
  assert.deepEqual(await drain((await checkoutTree('http://fake/r.git', {}, ge.opts)).files), [{ path: 's', mode: '160000', oid: GITLINK, size: 0, text: null }]);
  assert.equal(g.fetches().length, 1);
  assert.deepEqual([ge.span('git.checkout.blobs').attrs['git.checkout.blobs.unique'], ge.span('git.checkout.blobs').attrs['git.checkout.blobs.outcome']], [0, 'ok']);
});

test('checkoutTree: walk limits come from opts.limits', async () => {
  const r = remote(); r.commit(FILES());
  await rejects(checkoutTree('http://fake/r.git', {}, { ...env(r).opts, batch: 7, limits: withLimits({ maxPackObjects: 7 }) }), 'limit_exceeded', 'checkout entries 8 exceeds limit 7');
  assert.equal((await checkoutTree('http://fake/r.git', {}, { ...env(r).opts, batch: 8, limits: withLimits({ maxPackObjects: 8 }) })).entries.length, 6);
  await rejects(checkoutTree('http://fake/r.git', {}, { ...env(r).opts, limits: withLimits({ maxPathDepth: 2 }) }), 'limit_exceeded', 'path depth 3 exceeds limit 2');
  await rejects(checkoutTree('http://fake/r.git', { path: 'src' }, { ...env(r).opts, limits: withLimits({ maxPathDepth: 2 }) }), 'limit_exceeded', 'path depth 3 exceeds limit 2');
  assert.equal((await checkoutTree('http://fake/r.git', { path: 'src/lib' }, { ...env(r).opts, limits: withLimits({ maxPathDepth: 3 }) })).entries.length, 1);
});

// ======================================================================================================================
// read.js
// ======================================================================================================================

test('refCandidates, entryType and lsMode', () => {
  for (const ref of [null, undefined, '', 'HEAD']) assert.deepEqual(refCandidates(ref), ['HEAD']);
  assert.deepEqual(refCandidates('a'.repeat(40)), []);
  assert.deepEqual(refCandidates('A'.repeat(40)), ['refs/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'refs/tags/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'refs/heads/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']);
  assert.deepEqual(refCandidates('a'.repeat(39)), [`refs/${'a'.repeat(39)}`, `refs/tags/${'a'.repeat(39)}`, `refs/heads/${'a'.repeat(39)}`]);
  assert.deepEqual(refCandidates('refs/heads/x'), ['refs/heads/x']);
  assert.deepEqual(refCandidates('main'), ['refs/main', 'refs/tags/main', 'refs/heads/main']);
  assert.deepEqual(refCandidates('heads/main'), ['refs/heads/main', 'refs/tags/heads/main', 'refs/heads/heads/main']);
  assert.deepEqual(refCandidates('xrefs/a'), ['refs/xrefs/a', 'refs/tags/xrefs/a', 'refs/heads/xrefs/a']);
  throws(() => refCandidates(5), 'bad_request', 'ref must be a string');
  throws(() => refCandidates({}), 'bad_request', 'ref must be a string');
  throws(() => refCandidates('a..b'), 'bad_request', undefined, { what: 'ref' });
  throws(() => refCandidates('refs/a b'), 'bad_request', undefined, { what: 'ref' });
  assert.deepEqual(['40000', '160000', '100644', '120000', '100755'].map(entryType), ['tree', 'commit', 'blob', 'blob', 'blob']);
  assert.deepEqual(['40000', '100644', '160000', '1'].map(lsMode), ['040000', '100644', '160000', '000001']);
});

test('resolveCommit: HEAD\'s symref, a detached HEAD, tags over branches, peeled tags, the not-found messages', async () => {
  const r = remote(); const c = r.commit({ a: '1' });
  const c2 = r.commit({ a: '2' }, { ref: 'refs/heads/v1' });
  const tag = r.put('tag', encodeTag({ object: c, type: 'commit', tag: 'v1', tagger: 'A <a@x> 1 +0000', message: 'r\n' }));
  r.refs.set('refs/tags/v1', tag);
  const t = r.transport({ tracer: new Tracer() });
  assert.deepEqual(await resolveCommit(t, null), { name: 'refs/heads/main', commit: c });
  assert.deepEqual(await resolveCommit(t, 'HEAD'), { name: 'refs/heads/main', commit: c });
  assert.deepEqual(await resolveCommit(t, 'v1'), { name: 'refs/tags/v1', commit: c }, 'the tag wins and is peeled');
  assert.deepEqual(await resolveCommit(t, 'refs/heads/v1'), { name: 'refs/heads/v1', commit: c2 });
  assert.deepEqual(await resolveCommit(t, 'heads/v1'), { name: 'refs/heads/v1', commit: c2 });
  assert.deepEqual(await resolveCommit(t, c2), { name: c2, commit: c2 });
  assert.deepEqual(r.log.filter(x => x.command === 'ls-refs').map(x => x.prefixes), [['HEAD'], ['HEAD'], ['refs/v1', 'refs/tags/v1', 'refs/heads/v1'], ['refs/heads/v1'], ['refs/heads/v1', 'refs/tags/heads/v1', 'refs/heads/heads/v1']]);
  await rejects(resolveCommit(t, 'nope'), 'not_found', 'ref nope not found', { miss: { kind: 'ref', ref: 'nope', candidates: ['refs/nope', 'refs/tags/nope', 'refs/heads/nope'] } });
  await rejects(resolveCommit(t, 'refs/heads/nope'), 'not_found', 'ref refs/heads/nope not found', { miss: { kind: 'ref', ref: 'refs/heads/nope', candidates: ['refs/heads/nope'] } });
  const detached = remote({ head: c }); detached.objects.set(c, r.objects.get(c));
  assert.deepEqual(await resolveCommit(detached.transport({ tracer: new Tracer() }), null), { name: 'HEAD', commit: c });
  const unborn = remote();
  await rejects(resolveCommit(unborn.transport({ tracer: new Tracer() }), 'HEAD'), 'not_found', 'remote HEAD is unborn or absent (some hosts point HEAD at a deleted branch); pass ref explicitly', { miss: { kind: 'head_absent' } });
  assert.equal(unborn.log.filter(x => x.command === 'ls-refs').length, 1, 'no ls-refs=unborn: the miss does not ask again');
});

test('an advertised unborn HEAD is empty for readCommit and head_unborn otherwise', async () => {
  const target = 'refs/heads/main';
  const advertise = async () => pkts(['version 2\n', 'ls-refs=unborn\n', 'fetch\n', 'object-format=sha1\n']);
  const unbornLine = (text) => [dataFrame(text), { kind: 'flush' }];
  const server = (text) => {
    // an unborn answer that is not prefixed HEAD is the server's ordinary listing: the second ls-refs must ask for HEAD
    const r = remote({ hook: async req => (req.command === 'ls-refs' && req.unborn && req.prefixes.includes('HEAD') ? unbornLine(text) : undefined) });
    const ex = arrayExporter();
    const tracer = new Tracer({ exporter: ex });
    const transport = { ...r.transport({ tracer }), advertise };
    return { r, opts: { tracer, transport }, transport, spans: () => ex.lines.flatMap(flattenLine) };
  };
  const born = server(`unborn HEAD symref-target:${target}\n`);
  for (const ref of [null, undefined, '', 'HEAD', 'main', 'refs/heads/main']) {
    assert.deepEqual(await readCommit('http://fake/r.git', { ref }, born.opts), { empty: true, ref: target }, String(ref));
  }
  assert.ok(born.spans().filter(s => s.name === 'git.read_commit').every(s => s.attrs['git.read_commit.outcome'] === 'ok'));
  await rejects(readFile('http://fake/r.git', { path: 'README' }, born.opts), 'not_found', 'remote HEAD is unborn or absent (some hosts point HEAD at a deleted branch); pass ref explicitly', { miss: { kind: 'head_unborn', target } });
  await rejects(resolveCommit(born.transport, 'other'), 'not_found', 'ref other not found', { miss: { kind: 'ref', ref: 'other', candidates: ['refs/other', 'refs/tags/other', 'refs/heads/other'] } });
  await rejects(resolveCommit(born.transport, 'refs/heads/other'), 'not_found', 'ref refs/heads/other not found', { miss: { kind: 'ref', ref: 'refs/heads/other', candidates: ['refs/heads/other'] } });
  await rejects(readCommit('http://fake/r.git', { ref: 'other' }, born.opts), 'not_found', 'ref other not found', { miss: { kind: 'ref', ref: 'other', candidates: ['refs/other', 'refs/tags/other', 'refs/heads/other'] } });
  const plain = { code: 'not_found', miss: { kind: 'head_unborn', target } };
  const liar = remote({ hook: async req => { if (req.command === 'ls-refs') throw plain; } });
  await assert.rejects(readCommit('http://fake/r.git', {}, { tracer: new Tracer(), transport: { ...liar.transport({ tracer: new Tracer() }), advertise } }), e => e === plain);
  const typed = remote({ hook: async req => { if (req.command === 'ls-refs') throw fail('pack_corrupt', 'odd', { miss: { kind: 'head_unborn', target } }); } });
  await rejects(readCommit('http://fake/r.git', {}, { tracer: new Tracer(), transport: { ...typed.transport({ tracer: new Tracer() }), advertise } }), 'pack_corrupt', 'odd');
  const blank = server('unborn HEAD symref-target:\n');
  await rejects(resolveCommit(blank.transport, 'HEAD'), 'not_found', 'remote HEAD is unborn or absent (some hosts point HEAD at a deleted branch); pass ref explicitly', { miss: { kind: 'head_absent' } });
  await rejects(resolveCommit(born.transport, undefined), 'not_found', 'remote HEAD is unborn or absent (some hosts point HEAD at a deleted branch); pass ref explicitly', { miss: { kind: 'head_unborn', target } });
  const quiet = remote({ hook: async req => (req.command === 'ls-refs' && req.unborn ? [{ kind: 'flush' }] : undefined) });
  const quietT = { ...quiet.transport({ tracer: new Tracer() }), advertise };
  await rejects(resolveCommit(quietT, null), 'not_found', 'remote HEAD is unborn or absent (some hosts point HEAD at a deleted branch); pass ref explicitly', { miss: { kind: 'head_absent' } });
  const held = remote(); held.commit(FILES());
  const walked = await walkPath(held.transport({ tracer: new Tracer() }), GIT.root, ['nope']);
  assert.equal(walked.ok, false);
  if (!walked.ok) assert.deepEqual(walked.error.miss, { kind: 'path', missing: 'nope', existingPath: '' });
  const cache = new Map();
  cache.get = () => { throw 'boom'; };
  await assert.rejects(walkPath(held.transport({ tracer: new Tracer() }), GIT.root, ['x'], { cache }), e => e === 'boom');
});

test('commitView: idents for JSON, signed, parents and message', () => {
  const tree = GIT.root;
  const view = commitView(encodeCommit({ tree, parents: [GIT.commit, GIT.commit2], author: 'Ada L <ada@x> 1700000000 +0530', committer: 'Bob <b@y> 0 -0100', message: 'subject\n\nbody\n' }));
  assert.deepEqual(view, {
    tree, parents: [GIT.commit, GIT.commit2],
    author: { name: 'Ada L', email: 'ada@x', time: '2023-11-14T22:13:20Z', epoch: 1700000000, tz: '+0530' },
    committer: { name: 'Bob', email: 'b@y', time: '1970-01-01T00:00:00Z', epoch: 0, tz: '-0100' },
    message: 'subject\n\nbody\n', signed: false,
  });
  // milliseconds are never part of the time: whole seconds only
  assert.equal(commitView(encodeCommit({ tree, author: 'A <a@x> 1 +0000' })).author.time, '1970-01-01T00:00:01Z');
  assert.equal(commitView(encodeCommit({ tree, author: 'A <a@x> 1 +0000' })).message, '');
  const sig = '-----BEGIN SSH SIGNATURE-----\nU0lH\n-----END SSH SIGNATURE-----';
  const raw = (header) => te.encode(`tree ${tree}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n${header}\n\nm\n`);
  assert.equal(commitView(raw(`gpgsig ${sig.replace(/\n/g, '\n ')}`)).signed, true);
  assert.equal(commitView(raw(`gpgsig-sha256 ${sig.replace(/\n/g, '\n ')}`)).signed, true);
  assert.equal(commitView(raw('mergetag object x')).signed, false);
  assert.equal(commitView(raw('xgpgsig y')).signed, false);
  assert.equal(commitView(raw('gpgsigx y')).signed, false);
  // a date fsck accepts but a JS Date cannot hold: time null, the epoch and the rest kept
  const odd = commitView(te.encode(`tree ${tree}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 100000000000000000 +0000\n\nm\n`), withLimits({}));
  assert.deepEqual(odd.committer, { name: 'A', email: 'a@x', time: null, epoch: 1e17, tz: '+0000' });
  assert.equal(odd.message, 'm\n');
  // a commit fsck refuses is refused here too (#59): commitView reads through parseCommit
  assert.throws(() => commitView(te.encode(`tree ${tree}\nauthor A <a@x>\ncommitter A <a@x> 1 +0000\n\nm\n`)), e => e.code === 'pack_corrupt' && e.msgId === 'missingSpaceBeforeDate');
  assert.throws(() => commitView(te.encode(`tree ${tree}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\nm\0\n`)), e => e.code === 'pack_corrupt' && e.msgId === 'nulInCommit');
});

test('readCommit: the commit alone (tree:0, deepen 1), its view and span; a non-commit oid is not_found', async () => {
  const r = remote(); const c = r.commit(FILES());
  const e = env(r);
  const res = await readCommit('http://fake/r.git', {}, e.opts);
  assert.deepEqual(res, {
    ref: 'refs/heads/main', oid: c, tree: GIT.root, parents: [],
    author: { name: 'A', email: 'a@x', time: '2023-11-14T22:13:20Z', epoch: T0, tz: '+0000' }, committer: { name: 'A', email: 'a@x', time: '2023-11-14T22:13:20Z', epoch: T0, tz: '+0000' },
    message: 'deploy\n', signed: false,
  });
  assert.deepEqual(r.fetches().map(f => [f.wants, f.filter, f.deepen]), [[[c], 'tree:0', 1]]);
  const s = e.span('git.read_commit').attrs;
  assert.deepEqual([s['git.read_commit.ref'], s['git.read_commit.oid'], s['git.read_commit.parents'], s['git.read_commit.signed'], s['git.read_commit.outcome']], ['HEAD', c, 0, false, 'ok']);
  const child = r.commit({ x: '1' }, { parents: [c] });
  const e2 = env(r);
  assert.deepEqual((await readCommit('http://fake/r.git', { ref: 'main' }, e2.opts)).parents, [c]);
  assert.deepEqual([e2.span('git.read_commit').attrs['git.read_commit.ref'], e2.span('git.read_commit').attrs['git.read_commit.parents']], ['main', 1]);
  assert.equal((await readCommit('http://fake/r.git', { ref: child }, env(r).opts)).oid, child);
  await rejects(readCommit('http://fake/r.git', { ref: GIT.root }, env(r).opts), 'not_found', `${GIT.root} is not a commit`, { miss: { kind: 'commit', miss: { kind: 'not_commit', oid: GIT.root, type: 'tree' } } });
  const absentId = 'f'.repeat(40);
  await rejects(readCommit('http://fake/r.git', { ref: absentId }, env(r).opts), 'not_found', `commit ${absentId} not found on the remote`, { miss: { kind: 'commit', miss: { kind: 'absent', oid: absentId } } });
  const tagData = encodeTag({ object: c, type: 'commit', tag: 'v1', tagger: 'A <a@x> 1 +0000', message: 't\n' });
  const tagOid = hashObject('tag', tagData);
  r.objects.set(tagOid, { type: TYPE.TAG, data: tagData });
  const tagged = await fetchCommit(r.transport({ tracer: new Tracer() }), tagOid);
  assert.equal(tagged.ok, false);
  if (!tagged.ok) assert.deepEqual({ code: tagged.error.code, message: tagged.error.message, miss: tagged.error.miss }, { code: 'not_found', message: `${tagOid} is not a commit`, miss: { kind: 'commit', miss: { kind: 'not_commit', oid: tagOid, type: 'tag' } } });
  const blobbed = await fetchCommit(r.transport({ tracer: new Tracer() }), GIT.readme);
  assert.equal(blobbed.ok, false);
  if (!blobbed.ok) assert.deepEqual(blobbed.error.miss, { kind: 'commit', miss: { kind: 'not_commit', oid: GIT.readme, type: 'blob' } });
  const other = remote({ hook: async req => (req.command === 'fetch' ? [dataFrame('ERR upload-pack: busy')] : undefined) }); other.refs.set('refs/heads/main', c);
  await rejects(readCommit('http://fake/r.git', {}, env(other).opts), 'remote_error', 'remote: upload-pack: busy');
  const busy = await fetchCommit(other.transport({ tracer: new Tracer() }), c);
  assert.equal(busy.ok, false);
  if (!busy.ok) { assert.equal(busy.error.code, 'remote_error'); assert.equal(busy.error.miss, undefined); }
  const corrupt = remote({ hook: async req => (req.command === 'fetch' ? packFrames((await buildPack([r.objects.get(GIT.readme)])).pack) : undefined) }); corrupt.refs.set('refs/heads/main', c);
  await rejects(readCommit('http://fake/r.git', {}, env(corrupt).opts), 'pack_corrupt', `object ${GIT.readme} served for want ${c}`);
  const lied = await fetchCommit(corrupt.transport({ tracer: new Tracer() }), c);
  assert.equal(lied.ok, false);
  if (!lied.ok) { assert.equal(lied.error.code, 'pack_corrupt'); assert.equal(lied.error.message, `object ${GIT.readme} served for want ${c}`); assert.equal(lied.error.miss, undefined); }
  const base = r.transport({ tracer: new Tracer() });
  const odd = { ...base, frames: async function* frames() { const e = new Error('odd'); e.code = 'pack_corrupt'; e.reason = 'not_our_ref'; throw e; } };
  const oddCommit = await fetchCommit(odd, c);
  assert.equal(oddCommit.ok, false);
  if (!oddCommit.ok) assert.equal(oddCommit.error.code, 'pack_corrupt');
});

test('listTree: the root, a subdirectory, cache hits and every not_found', async () => {
  const r = remote(); const c = r.commit(FILES());
  const e = env(r);
  const res = await listTree('http://fake/r.git', {}, e.opts);
  assert.deepEqual([res.ref, res.commit, res.tree], ['refs/heads/main', c, GIT.root]);
  assert.deepEqual(res.entries, [
    { name: 'README', mode: '100644', oid: GIT.readme, type: 'blob' }, { name: 'link', mode: '120000', oid: GIT.link, type: 'blob' },
    { name: 'run.sh', mode: '100755', oid: GIT.run, type: 'blob' }, { name: 'src', mode: '040000', oid: GIT.src, type: 'tree' },
    { name: 'sub', mode: '160000', oid: GITLINK, type: 'commit' },
  ]);
  const s = e.span('git.ls_tree').attrs;
  assert.deepEqual([s['git.ls_tree.ref'], s['git.ls_tree.path'], s['git.ls_tree.path.depth'], s['git.ls_tree.tree'], s['git.ls_tree.entries'], s['git.ls_tree.outcome'], s['git.read.commit'], s['git.read.tree.root']],
    ['HEAD', '', 0, GIT.root, 5, 'ok', c, GIT.root]);
  const cache = new Map();
  const e2 = env(r);
  const sub = await listTree('http://fake/r.git', { ref: 'main', path: 'src/lib/' }, { ...e2.opts, cache });
  assert.deepEqual([sub.tree, sub.entries], [GIT.lib, [{ name: 'b.js', mode: '100644', oid: GIT.b, type: 'blob' }]]);
  assert.deepEqual(e2.all('git.read.tree').map(x => [x.attrs['git.read.tree.depth'], x.attrs['git.read.tree.oid'], x.attrs['git.read.tree.lookup'], x.attrs['git.read.tree.cache_hit'], x.attrs['git.read.tree.entries'], x.attrs['git.read.tree.entry.found'], x.attrs['git.read.tree.entry.mode']]),
    [[0, GIT.root, 'src', false, 5, true, '40000'], [1, GIT.src, 'lib', false, 2, true, '40000']]);
  assert.deepEqual([e2.span('git.ls_tree').attrs['git.ls_tree.path'], e2.span('git.ls_tree').attrs['git.ls_tree.path.depth']], ['src/lib', 2]);
  assert.deepEqual([...cache.keys()], [GIT.root, GIT.src, GIT.lib]);
  // the same listing again: no tree fetched, every level a cache hit
  const before = r.fetches().length;
  const e3 = env(r);
  await listTree('http://fake/r.git', { path: 'src/lib' }, { ...e3.opts, cache });
  assert.equal(r.fetches().length, before + 1, 'only the commit');
  assert.deepEqual(e3.all('git.read.tree').map(x => x.attrs['git.read.tree.cache_hit']), [true, true]);
  for (const path of [undefined, null, '', '/']) assert.equal((await listTree('http://fake/r.git', { path }, env(r).opts)).tree, GIT.root);
  await rejects(listTree('http://fake/r.git', { path: 'README' }, env(r).opts), 'not_found', 'README is not a directory (mode 100644)', { miss: { kind: 'not_directory', path: 'README', mode: '100644' } });
  await rejects(listTree('http://fake/r.git', { path: 'sub' }, env(r).opts), 'not_found', 'sub is not a directory (mode 160000)', { miss: { kind: 'not_directory', path: 'sub', mode: '160000' } });
  await rejects(listTree('http://fake/r.git', { path: 'README/x' }, env(r).opts), 'not_found', 'README is not a directory', { miss: { kind: 'not_directory', path: 'README', mode: '100644' } });
  await rejects(listTree('http://fake/r.git', { path: 'src/a.js' }, env(r).opts), 'not_found', 'src/a.js is not a directory (mode 100644)', { miss: { kind: 'not_directory', path: 'src/a.js', mode: '100644' } });
  await rejects(listTree('http://fake/r.git', { path: 'src/a.js/x' }, env(r).opts), 'not_found', 'a.js is not a directory', { miss: { kind: 'not_directory', path: 'src/a.js', mode: '100644' } });
  const miss = env(r);
  await rejects(listTree('http://fake/r.git', { path: 'src/nope' }, miss.opts), 'not_found', 'path component nope not found', { miss: { kind: 'path', missing: 'nope', existingPath: 'src' } });
  await rejects(listTree('http://fake/r.git', { path: 'src/lib/nope' }, env(r).opts), 'not_found', 'path component nope not found', { miss: { kind: 'path', missing: 'nope', existingPath: 'src/lib' } });
  const last = miss.all('git.read.tree').at(-1).attrs;
  assert.deepEqual([last['git.read.tree.entry.found'], last['git.read.tree.entry.mode']], [false, '']);
  assert.equal(miss.span('git.ls_tree').attrs['git.ls_tree.outcome'], 'not_found');
  await rejects(listTree('http://fake/r.git', { path: '.git' }, env(r).opts), 'bad_request');
});

test('readFile: the blob streamed and verified, its size first; directories and submodules are not files', async () => {
  const r = remote({ chunk: 7 }); const c = r.commit({ ...FILES(), 'big.txt': 'x'.repeat(5000) });
  const e = env(r);
  const res = await readFile('http://fake/r.git', { path: 'src/lib/b.js' }, e.opts);
  assert.deepEqual([res.ref, res.commit, res.blob, res.mode, res.size], ['refs/heads/main', c, GIT.b, '100644', 2]);
  assert.equal(await readAll(res.stream), 'b\n');
  const root = e.span('git.read').attrs;
  assert.deepEqual([root['git.read.ref'], root['git.read.path'], root['git.read.path.depth'], root['git.read.blob'], root['git.read.blob.size'], root['git.read.blob.mode'], root['git.read.outcome']],
    ['HEAD', 'src/lib/b.js', 3, GIT.b, 2, '100644', 'ok']);
  const blob = e.span('git.read.blob');
  assert.deepEqual([blob.attrs['git.read.blob.oid'], blob.attrs['git.read.blob.size'], blob.attrs['git.read.blob.bytes'], blob.attrs['git.read.blob.verified'], blob.attrs['git.read.blob.outcome']], [GIT.b, 2, 2, true, 'ok']);
  const readRoot = e.span('git.read');
  assert.deepEqual([blob.parentSpanId, blob.links.map(l => [l.traceId, l.spanId, l.attrs['ply.link']])], [undefined, [[readRoot.traceId, readRoot.spanId, 'follows_from']]]);
  assert.deepEqual(readRoot.links.map(l => [l.spanId, l.attrs['ply.link']]), [[blob.spanId, 'followed_by']]);
  // a big blob in 7-byte network chunks
  const big = await readFile('http://fake/r.git', { ref: 'main', path: 'big.txt' }, env(r).opts);
  assert.equal(big.size, 5000);
  assert.equal(await readAll(big.stream), 'x'.repeat(5000));
  const link = await readFile('http://fake/r.git', { path: 'link' }, env(r).opts);
  assert.deepEqual([link.mode, await readAll(link.stream)], ['120000', 'README']);
  const exe = await readFile('http://fake/r.git', { path: 'run.sh/' }, env(r).opts);
  assert.equal(exe.mode, '100755');
  await readAll(exe.stream);
  await rejects(readFile('http://fake/r.git', { path: 'src' }, env(r).opts), 'not_found', 'src is a directory', { miss: { kind: 'is_directory', path: 'src', tree: GIT.src } });
  await rejects(readFile('http://fake/r.git', { path: 'src/lib' }, env(r).opts), 'not_found', 'src/lib is a directory', { miss: { kind: 'is_directory', path: 'src/lib', tree: GIT.lib } });
  await rejects(readFile('http://fake/r.git', { path: 'sub' }, env(r).opts), 'not_found', `sub is a submodule (commit ${GITLINK})`, { miss: { kind: 'submodule', path: 'sub', commit: GITLINK } });
  const nested = remote(); nested.commit({ ...FILES(), 'nest/mod': { mode: '160000', oid: GITLINK } });
  await rejects(readFile('http://fake/r.git', { path: 'nest/mod' }, env(nested).opts), 'not_found', `nest/mod is a submodule (commit ${GITLINK})`, { miss: { kind: 'submodule', path: 'nest/mod', commit: GITLINK } });
  for (const path of [undefined, '', '/']) await rejects(readFile('http://fake/r.git', { path }, env(r).opts), 'bad_request', undefined);
  await rejects(readFile('http://fake/r.git', {}, env(r).opts), 'bad_request');
});

// a one-object pack, by hand: `size` is what the header claims, `content` what the zlib stream holds
async function onePack(type, size, content) {
  const body = concat([Uint8Array.of(0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 1), encodeObjHeader(type, size), await zlibDeflate(te.encode(content))]);
  return concat([body, new Sha1().update(body).digest()]);
}

test('openBlob: every way a streamed blob can lie is pack_corrupt on the stream, and the span says so', async () => {
  const oid = hashObject('blob', te.encode('hello'));
  const run = async (frames, want = oid) => {
    const r = remote({ hook: async () => frames });
    const ex = arrayExporter(); const tracer = new Tracer({ exporter: ex });
    const parent = tracer.start('p');
    const t = r.transport({ tracer });
    return { open: () => openBlob(t, want, { follows: parent }), spans: () => ex.lines.flatMap(flattenLine) };
  };
  const good = await run(packFrames(await onePack(TYPE.BLOB, 5, 'hello'), 3));
  const ok = streamOf(await good.open());
  assert.equal(ok.size, 5);
  assert.equal(await readAll(ok.stream), 'hello');
  const okSpan = good.spans().find(s => s.name === 'git.read.blob');
  assert.deepEqual([okSpan.attrs['git.read.blob.bytes'], okSpan.attrs['git.read.blob.verified'], okSpan.attrs['git.read.blob.outcome']], [5, true, 'ok']);
  assert.ok(['digeststream', 'js'].includes(okSpan.attrs['git.read.blob.hasher']));
  assert.equal(good.spans().find(s => s.name === 'git.upload-pack fetch').status.code, 1);
  const cases = [
    ['more than declared', await onePack(TYPE.BLOB, 3, 'hello'), 'server streamed more than the 3 bytes it declared'],
    ['fewer than declared', await onePack(TYPE.BLOB, 9, 'hello'), 'inflated 5 != declared 9'],
    ['other content', await onePack(TYPE.BLOB, 5, 'jello'), `blob content hashes to ${hashObject('blob', te.encode('jello'))}, not ${oid}`],
  ];
  for (const [label, pack, message] of cases) {
    const c = await run(packFrames(pack, 4));
    const { stream } = streamOf(await c.open());
    await rejects(readAll(stream), 'pack_corrupt', message);
    const s = c.spans().find(x => x.name === 'git.read.blob');
    assert.equal(s.attrs['git.read.blob.outcome'], 'pack_corrupt', label);
    assert.equal(s.status.code, 2, label);
    assert.equal(s.status.message, message, label);
  }
  // header-phase failures are the Result, and the spans still record them
  const tree = await run(packFrames(await onePack(TYPE.TREE, 0, '')));
  const treeErr = errOf(await tree.open());
  assert.equal(treeErr.code, 'pack_corrupt'); assert.equal(treeErr.message, 'expected blob, got tree');
  assert.equal(tree.spans().find(x => x.name === 'git.read.blob').attrs['git.read.blob.outcome'], 'pack_corrupt');
  assert.equal(tree.spans().find(x => x.name === 'git.upload-pack fetch').status.code, 2);
  const commit = await run(packFrames(await onePack(TYPE.COMMIT, 0, '')));
  assert.equal(errOf(await commit.open()).message, 'expected blob, got commit');
  const empty = await run([dataFrame('packfile\n'), band(1, Uint8Array.of(0x50, 0x41)), { kind: 'flush' }]);
  assert.equal(errOf(await empty.open()).message, 'pack ended before the object header');
  const err = await run([dataFrame('ERR upload-pack: not our ref x')]);
  const remoteErr = errOf(await err.open());
  assert.equal(remoteErr.code, 'remote_error'); assert.equal(remoteErr.message, 'remote: upload-pack: not our ref x');
  assert.equal(err.spans().find(x => x.name === 'git.read.blob').attrs['git.read.blob.outcome'], 'remote_error');
  // a failure after the header errors the stream typed, and still ends both spans with it (they used to be left open and never exported)
  const pack = await onePack(TYPE.BLOB, 5, 'hello'); pack[pack.length - 1] ^= 1;
  const midway = async (label, frames, code, message) => {
    const c = await run(frames);
    await rejects(readAll(streamOf(await c.open()).stream), code, message);
    await new Promise(resolve => setTimeout(resolve, 0));
    const [blob, fetch] = ['git.read.blob', 'git.upload-pack fetch'].map(n => c.spans().find(x => x.name === n));
    assert.ok(blob && fetch, `${label}: both spans exported`);
    assert.equal(blob.attrs['git.read.blob.outcome'], code, label);
    assert.match(blob.status.message, message instanceof RegExp ? message : new RegExp(`^${message}$`), label);
    assert.deepEqual([blob.status.code, fetch.status.code, blob.attrs['git.read.blob.verified']], [2, 2, undefined], label);
  };
  await midway('trailer', packFrames(pack, 5), 'pack_corrupt', /^pack: trailer [0-9a-f]{40} != [0-9a-f]{40}$/);
  const cut = async function* (err) { const all = packFrames(await onePack(TYPE.BLOB, 5, 'hello'), 25); yield all[0]; yield all[1]; throw err; };
  await midway('network', cut(fail('network', 'network: reset')), 'network', 'network: reset');
  // an untyped failure is typed on the way out
  await midway('untyped', cut(new Error('socket hang up')), 'pack_corrupt', 'blob stream: socket hang up');
});

// Pull until the stream ends or errors. The chunks are what the consumer was given; an error keeps the ones already released.
async function pullChunks(stream) {
  const chunks = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) return { chunks };
      chunks.push(r.value);
    }
  } catch (error) {
    return { chunks, error };
  }
}

test('openBlob holds the last chunk until the hash and the trailer verify', async () => {
  // 64 KiB of one byte inflates as several chunks when the pack is delivered in small frames (measured on this runtime).
  const text = 'a'.repeat(65536);
  const oid = hashObject('blob', te.encode(text));
  const other = hashObject('blob', te.encode('b'));
  const pack = await onePack(TYPE.BLOB, text.length, text);
  const frames = packFrames(pack, 32);
  const open = async (want, wire = frames) => {
    const r = remote({ hook: async () => wire });
    const ex = arrayExporter();
    const tracer = new Tracer({ exporter: ex });
    const opened = streamOf(await openBlob(r.transport({ tracer }), want, { follows: tracer.start('p') }));
    return { size: opened.size, ...(await pullChunks(opened.stream)), spans: () => ex.lines.flatMap(flattenLine) };
  };
  const good = await open(oid);
  assert.equal(good.error, undefined);
  assert.ok(good.chunks.length >= 2, `a valid blob yielded ${good.chunks.length} chunk(s); the hold needs a real tail`);
  const whole = concat(good.chunks);
  assert.equal(whole.length, text.length);
  assert.equal(td.decode(whole), text);
  const prefix = concat(good.chunks.slice(0, -1));
  const bad = await open(other);
  assert.equal(bad.error?.code, 'pack_corrupt');
  assert.equal(bad.error.message, `blob content hashes to ${oid}, not ${other}`);
  assert.deepEqual(concat(bad.chunks), prefix, 'the last chunk of a blob that fails the hash is never yielded');
  const badSpan = bad.spans().find(s => s.name === 'git.read.blob');
  assert.equal(badSpan.attrs['git.read.blob.outcome'], 'pack_corrupt');
  assert.equal(badSpan.attrs['git.read.blob.verified'], undefined);
  // one inflate chunk (the pack arrives whole): holding it means the consumer receives nothing
  const hello = packFrames(await onePack(TYPE.BLOB, 5, 'hello'));
  const helloOid = hashObject('blob', te.encode('hello'));
  const helloGood = await open(helloOid, hello);
  assert.equal(helloGood.error, undefined);
  assert.equal(helloGood.chunks.length, 1);
  assert.equal(td.decode(concat(helloGood.chunks)), 'hello');
  const helloBad = await open(other, hello);
  assert.equal(helloBad.chunks.length, 0);
  assert.equal(helloBad.error?.code, 'pack_corrupt');
  assert.match(helloBad.error.message, /^blob content hashes to /);
  // a one-byte chunk is a real chunk (an empty one is not)
  const zee = packFrames(await onePack(TYPE.BLOB, 1, 'Z'), 8);
  const zeeGood = await open(hashObject('blob', te.encode('Z')), zee);
  assert.equal(td.decode(concat(zeeGood.chunks)), 'Z');
  // the trailer fails after the bytes have inflated: the same tail stays held
  const torn = new Uint8Array(pack);
  torn[torn.length - 1] ^= 1;
  const trailer = await open(oid, packFrames(torn, 32));
  assert.equal(trailer.error?.code, 'pack_corrupt');
  assert.match(trailer.error.message, /^pack: trailer [0-9a-f]{40} != [0-9a-f]{40}$/);
  // aborting the inflate on a bad trailer delivers no further chunk, so the held tail is not among them
  assert.ok(trailer.chunks.length < good.chunks.length);
  const trailerBytes = trailer.chunks.length ? concat(trailer.chunks) : new Uint8Array();
  assert.ok(trailerBytes.length < text.length);
  assert.equal(td.decode(trailerBytes), text.slice(0, trailerBytes.length));
});

test('openBlob: maxBytes is the declared size, and a cap does not pull the rest of the pack', async () => {
  const text = 'hello world';
  const oid = hashObject('blob', te.encode(text));
  const pack = await onePack(TYPE.BLOB, text.length, text);
  const frames = packFrames(pack, 8);
  const serve = () => {
    let pulls = 0;
    const r = remote({ hook: async req => (req.command === 'fetch' ? (async function* () { for (const f of frames) { pulls += 1; yield f; } })() : undefined) });
    const ex = arrayExporter(); const tracer = new Tracer({ exporter: ex });
    return { t: r.transport({ tracer }), tracer, pulls: () => pulls, spans: () => ex.lines.flatMap(flattenLine) };
  };
  const exact = serve();
  const at = streamOf(await openBlob(exact.t, oid, { maxBytes: text.length, follows: exact.tracer.start('p') }));
  assert.equal(await readAll(at.stream), text);
  assert.equal(exact.spans().find(s => s.name === 'git.read.blob').attrs['git.read.blob.header_only'], undefined);
  assert.equal(exact.pulls(), frames.length);
  const over = serve();
  const big = await openBlob(over.t, oid, { maxBytes: text.length - 1, follows: over.tracer.start('p') });
  assert.equal(big.ok, true);
  if (big.ok) assert.deepEqual(big.value, { kind: 'too_big', size: text.length });
  const cap = over.spans().find(s => s.name === 'git.read.blob');
  const capFetch = over.spans().find(s => s.name === 'git.upload-pack fetch');
  assert.deepEqual([cap.attrs['git.read.blob.header_only'], cap.attrs['git.read.blob.outcome'], cap.attrs['git.read.blob.size']], [true, 'too_big', text.length]);
  // the fetch span is ended (exported, status ok) when the header refuses the blob; dropping end() leaves it unexported
  assert.equal(capFetch?.status.code, 1);
  assert.ok(over.pulls() < frames.length, `the cap pulled ${over.pulls()} of ${frames.length} frames`);
  const none = await openBlob(serve().t, oid, { maxBytes: 0 });
  assert.equal(none.ok && none.value.kind, 'too_big');
  const emptyOid = hashObject('blob', new Uint8Array(0));
  const empty = streamOf(await openBlob(remote({ hook: async () => packFrames(await onePack(TYPE.BLOB, 0, ''), 8) }).transport({ tracer: new Tracer() }), emptyOid, { maxBytes: 0 }));
  assert.equal(empty.size, 0);
  assert.equal(await readAll(empty.stream), '');
  for (const maxBytes of [-1, 1.5, NaN]) {
    const bad = await openBlob(serve().t, oid, { maxBytes });
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.equal(bad.error.code, 'bad_request');
      assert.equal(bad.error.message, 'maxBytes must be an integer >= 0');
      assert.equal(bad.error.what, 'maxBytes');
    }
  }
  // a thrown value that already carries a ply code, and is not an Error, is rethrown: it is not a Result
  const bare = { code: 'network', message: 'reset' };
  await assert.rejects(openBlob(remote({ hook: async () => { throw bare; } }).transport({ tracer: new Tracer() }), oid), e => e === bare);
  const buffered = await readBlob(serve().t, oid, { maxBytes: text.length });
  assert.equal(buffered.ok, true);
  assert.equal(buffered.ok && buffered.value.kind, 'bytes');
  if (buffered.ok && buffered.value.kind === 'bytes') assert.deepEqual(buffered.value.data, te.encode(text));
  const capped = await readBlob(serve().t, oid, { maxBytes: 4 });
  assert.equal(capped.ok && capped.value.kind, 'too_big');
  if (capped.ok && capped.value.kind === 'too_big') assert.equal(capped.value.size, text.length);
  // readBlob passes follows through both overloads, and a cap still wins when follows is set
  const followed = serve();
  const parent = followed.tracer.start('read');
  const via = await readBlob(followed.t, oid, { follows: parent });
  assert.equal(via.ok && via.value.kind, 'bytes');
  if (via.ok && via.value.kind === 'bytes') assert.deepEqual(via.value.data, te.encode(text));
  const viaSpan = followed.spans().find(s => s.name === 'git.read.blob');
  assert.deepEqual(viaSpan.links.map(l => [l.traceId, l.spanId, l.attrs['ply.link']]), [[parent.traceId, parent.spanId, 'follows_from']]);
  const followedCap = serve();
  const parentCap = followedCap.tracer.start('read');
  const viaCap = await readBlob(followedCap.t, oid, { maxBytes: 4, follows: parentCap });
  assert.equal(viaCap.ok && viaCap.value.kind, 'too_big');
  if (viaCap.ok && viaCap.value.kind === 'too_big') assert.equal(viaCap.value.size, text.length);
  const capLink = followedCap.spans().find(s => s.name === 'git.read.blob');
  assert.deepEqual(capLink.links.map(l => [l.traceId, l.spanId, l.attrs['ply.link']]), [[parentCap.traceId, parentCap.spanId, 'follows_from']]);
  // a header refusal is the Result, not a throw from reading a value the Err does not have
  const asCommit = await readBlob(remote({ hook: async () => packFrames(await onePack(TYPE.COMMIT, 0, '')) }).transport({ tracer: new Tracer() }), oid);
  assert.equal(asCommit.ok, false);
  if (!asCommit.ok) assert.equal(asCommit.error.message, 'expected blob, got commit');
  const torn = new Uint8Array(pack); torn[torn.length - 1] ^= 1;
  const lied = await readBlob(remote({ hook: async () => packFrames(torn, 8) }).transport({ tracer: new Tracer() }), oid);
  assert.equal(lied.ok, false);
  if (!lied.ok) { assert.equal(lied.error.code, 'pack_corrupt'); assert.equal(lied.value, undefined); }
  // a body failure that is not an Error is rethrown; a ply Error from the stream is the Result
  const cut = async function* () {
    const all = packFrames(await onePack(TYPE.BLOB, text.length, text), 25);
    yield all[0]; yield all[1]; throw bare;
  };
  await assert.rejects(readBlob(remote({ hook: async () => cut() }).transport({ tracer: new Tracer() }), oid), e => e === bare);
});

test('the details each operation stamps: prefixes, filters, nested paths, caller limits, error-code gates', async () => {
  // pushTree asks ls-refs for the base alone, honours the caller's limits, and reads nested trees by their full path
  const r = remote(); r.commit(FILES());
  const e = env(r);
  const res = await pushTree('http://fake/r.git', { files: { ...FILES(), 'src/lib/b.js': 'B\n' }, author: A, message: 'deploy', time: T0 }, e.opts);
  assert.deepEqual(r.log.filter(x => x.command === 'ls-refs').map(x => x.prefixes), [['refs/heads/main']]);
  assert.equal(res.treesRead, 3);
  assert.deepEqual(r.pushes()[0].pack.objects.map(o => o.baseOid ?? null), [null, GIT.root, GIT.src, GIT.lib, null]);
  await rejects(pushTree('http://fake/r.git', { files: { a: '1', b: '2' }, author: A, message: 'm', time: T0 }, { ...env(r).opts, limits: withLimits({ maxPackObjects: 1 }) }), 'limit_exceeded', 'files 2 exceeds limit 1');
  // a create whose tree equals the base's reads no parent tree (the server has the whole closure)
  const copy = await pushTree('http://fake/r.git', { ref: 'refs/heads/copy2', base: 'refs/heads/main', files: { ...FILES(), 'src/lib/b.js': 'B\n' }, author: A, message: 'm', time: T0 }, env(r).opts);
  assert.deepEqual([copy.treesRead, copy.objects.sent], [0, 1]);
  throws(() => validateTreeSpec({ ref: 'main', base: 'refs/heads/main', files: {}, author: A, message: '' }, DEFAULT_LIMITS), 'bad_request', undefined, { what: 'ref' });

  // checkoutTree: the subtree path on the span and the result, joined with '/'
  const ce = env(r);
  const sub = await checkoutTree('http://fake/r.git', { path: 'src/lib' }, ce.opts);
  assert.equal(sub.path, 'src/lib');
  assert.equal(ce.span('git.checkout').attrs['git.checkout.path'], 'src/lib');
  // an empty blob's stream ends without a chunk
  const z = remote(); z.commit({ e: '', f: 'x' });
  for await (const f of (await checkoutTree('http://fake/r.git', {}, env(z).opts)).files) {
    const chunks = []; for await (const c of f.stream) chunks.push(c);
    assert.equal(chunks.length, f.size ? 1 : 0, f.path);
  }
  // only a remote_error saying "not our ref" is not_found; the same words under another code are not
  const c = r.refs.get('refs/heads/main');
  const words = (code, message) => { const x = remote({ hook: async req => { if (req.command === 'fetch') throw fail(code, message); } }); x.refs.set('refs/heads/main', c); return x; };
  await rejects(checkoutTree('http://fake/r.git', {}, env(words('protocol', 'not our ref')).opts), 'protocol', 'not our ref');
  await rejects(readCommit('http://fake/r.git', {}, env(words('protocol', 'not our ref')).opts), 'protocol', 'not our ref');
  await rejects(readCommit('http://fake/r.git', {}, env(words('protocol', 'expected commit')).opts), 'protocol', 'expected commit');

  // read.js: tree fetches are tree:0, nested paths in messages, caller limits
  const le = env(r); r.log.length = 0;
  await listTree('http://fake/r.git', { path: 'src' }, le.opts);
  assert.deepEqual(r.fetches().map(f => f.filter), ['tree:0', 'tree:0', 'tree:0']);
  await rejects(listTree('http://fake/r.git', { path: 'src/a.js' }, env(r).opts), 'not_found', 'src/a.js is not a directory (mode 100644)');
  await rejects(readFile('http://fake/r.git', { path: 'src/lib' }, env(r).opts), 'not_found', 'src/lib is a directory');
  await rejects(listTree('http://fake/r.git', { path: 'src/lib' }, { ...env(r).opts, limits: withLimits({ maxPathDepth: 1 }) }), 'bad_request', 'invalid path: depth 2 exceeds 1');
  await rejects(readFile('http://fake/r.git', { path: 'src/a.js' }, { ...env(r).opts, limits: withLimits({ maxPathDepth: 1 }) }), 'bad_request', 'invalid path: depth 2 exceeds 1');
  const nested = remote(); nested.commit({ 'm/sub': { mode: '160000', oid: GITLINK } });
  await rejects(readFile('http://fake/r.git', { path: 'm/sub' }, env(nested).opts), 'not_found', `m/sub is a submodule (commit ${GITLINK})`);
  // the oid test is anchored at both ends
  assert.equal(refCandidates(`x${'a'.repeat(40)}`).length, 3);
  assert.equal(refCandidates(`${'a'.repeat(40)}x`).length, 3);
  // the blob's fetch span is a client span under git.read.blob
  const be = env(r);
  await readAll((await readFile('http://fake/r.git', { path: 'README' }, be.opts)).stream);
  const blob = be.span('git.read.blob');
  const fetch = be.all('git.upload-pack fetch').find(s => s.parentSpanId === blob.spanId);
  assert.equal(fetch?.kind, 3);
});
