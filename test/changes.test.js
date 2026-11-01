// commitChanges (#103 item 2): one commit from an ordered change list, including the first commit of an empty
// repository. The product is start × place × op, judged by git over http-backend: the same list applied with
// git add / rm / mv and committed with fixed dates, then `git cat-file commit` byte for byte and fsck --strict.
// One named disagreement: `create` of a path that exists. git add overwrites; ply refuses. A new ref whose tree
// equals its parent is not an empty commit and the ref stays absent.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, chmodSync } from 'node:fs';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, fsckProblems } from './server.js';
import { commitChanges } from '../src/changes.js';
import { editFile } from '../src/edit.js';
import {
  emptyDir, lazyNode, fileLeaf, putAt, removeAt, renameAt, replaceOnce, encodeMem, insertChild, requireDir,
} from '../src/memtree.js';
import { withLimits } from '../src/limits.js';
import { generateSigner } from '../src/sign.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { defaultCapabilities } from '../src/capabilities.js';
import { spawnSync } from 'node:child_process';

const ZERO = '0'.repeat(40);
const withCaps = (opts) => {
  const { tracer: given, fetchImpl: fetchGiven, ...rest } = opts;
  const tracer = given ? given : new Tracer();
  return { ...rest, capabilities: { ...defaultCapabilities(), ...rest.capabilities, tracer, ...(fetchGiven ? { fetch: fetchGiven } : {}) } };
};
const commit = (url, spec, opts = {}) => commitChanges(url, spec, withCaps(opts));
const edit = (url, spec, opts = {}) => editFile(url, spec, withCaps(opts));
const AUTHOR = { name: 'Ada', email: 'ada@x', tz: '+0000', time: 1700000000 };
const STAMP = {
  GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@x', GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@x', GIT_COMMITTER_DATE: '1700000000 +0000',
};
const STARTS = ['empty', 'linear'];
const PLACES = ['main', 'orphan', 'from-ref', 'from-oid', 'from-old', 'other', 'zero'];
const OP_NAMES = ['create', 'create-dup', 'write', 'edit', 'edit-zero', 'edit-two', 'delete', 'delete-miss', 'rename', 'rename-onto', 'rename-self', 'sequence', 'exec', 'symlink', 'touch'];

let root, cleanup, srv, n = 0, linearBare, emptyBare, tips;

before(async () => {
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  emptyBare = makeBareRepo(root, 'empty');
  linearBare = makeBareRepo(root, 'linear');
  tips = seedLinear(linearBare);
  assert.deepEqual(fsckProblems(linearBare), []);
  assert.deepEqual(fsckProblems(emptyBare), []);
});
after(async () => { await srv.close(); cleanup(); });

const gitEnv = (cwd, args, env = {}) => git(cwd, ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { env: { ...process.env, ...env } });
function seedLinear(bare) {
  const work = join(root, 'seed-linear');
  git(root, ['-c', 'core.autocrlf=false', 'init', '-q', '-b', 'main', work]);
  git(work, ['config', 'commit.gpgsign', 'false']);
  git(work, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(work, 'a.txt'), 'old\n');
  git(work, ['add', '-A']);
  gitEnv(work, ['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-q', '-m', 'first']);
  const old = git(work, ['rev-parse', 'HEAD']).trim();
  mkdirSync(join(work, 'dir'));
  writeFileSync(join(work, 'a.txt'), 'v1\n');
  writeFileSync(join(work, 'dir/b.txt'), 'b\n');
  writeFileSync(join(work, 'run.sh'), '#!/bin/sh\n');
  chmodSync(join(work, 'run.sh'), 0o755);
  symlinkSync('a.txt', join(work, 'link'));
  writeFileSync(join(work, 'twin.txt'), 'xx\n');
  git(work, ['add', '-A']);
  gitEnv(work, ['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-q', '-m', 'second']);
  const tip = git(work, ['rev-parse', 'HEAD']).trim();
  git(work, ['push', '-q', bare, 'HEAD:refs/heads/main', 'HEAD:refs/heads/side']);
  return { old, tip };
}
const copy = template => {
  const name = `c${n++}`;
  const bare = join(root, `${name}.git`);
  cpSync(template, bare, { recursive: true });
  return { bare, url: `${srv.url}/${name}.git` };
};
const refOid = (bare, ref) => { try { return git(bare, ['rev-parse', '--verify', ref]).trim(); } catch { return null; } };
const refOf = place => (place === 'orphan' || place === 'from-ref' || place === 'from-oid' ? 'refs/heads/topic' : 'refs/heads/main');
function baseOf(start, place) {
  if (place === 'main' || place === 'orphan') return {};
  if (place === 'from-ref') return { base: 'refs/heads/side' };
  if (place === 'from-oid') return { base: start === 'linear' ? tips.tip : 'a'.repeat(40) };
  if (place === 'from-old') return { base: start === 'linear' ? tips.old : 'a'.repeat(40) };
  if (place === 'other') return { base: 'refs/heads/side' };
  return { base: ZERO };
}
const changesOf = op => ({
  create: [{ kind: 'create', path: 'n.txt', content: 'n\n' }],
  'create-dup': [{ kind: 'create', path: 'a.txt', content: 'z\n' }],
  write: [{ kind: 'write', path: 'a.txt', content: 'w\n' }],
  edit: [{ kind: 'edit', path: 'a.txt', find: 'v1', replace: 'v2' }],
  'edit-zero': [{ kind: 'edit', path: 'a.txt', find: 'NO', replace: 'x' }],
  'edit-two': [{ kind: 'edit', path: 'twin.txt', find: 'x', replace: 'y' }],
  delete: [{ kind: 'delete', path: 'a.txt' }],
  'delete-miss': [{ kind: 'delete', path: 'nope.txt' }],
  rename: [{ kind: 'rename', from: 'a.txt', to: 'z.txt' }],
  'rename-onto': [{ kind: 'rename', from: 'a.txt', to: 'twin.txt' }],
  'rename-self': [{ kind: 'rename', from: 'a.txt', to: 'a.txt' }],
  sequence: [{ kind: 'create', path: 'n.txt', content: 'n\n' }, { kind: 'write', path: 'w.txt', content: 'w\n' }, { kind: 'delete', path: 'twin.txt' }],
  exec: [{ kind: 'create', path: 'bin/run', content: '#!/bin/sh\n', mode: '100755' }],
  symlink: [{ kind: 'create', path: 'slink', content: 'a.txt', mode: '120000' }],
  touch: [{ kind: 'write', path: 'a.txt', content: 'v1\n' }],
})[op];
function classOf(start, place, op) {
  if (place === 'zero') return { kind: 'pre', code: 'bad_request', fetches: 0 };
  if (start === 'empty' && (place === 'from-ref' || place === 'from-oid' || place === 'from-old' || place === 'other')) return { kind: 'pre', code: 'not_found' };
  if (start === 'linear' && place === 'from-old') return { kind: 'pre', code: 'bad_request', rebase: true };
  if (start === 'linear' && place === 'other') return { kind: 'pre', code: 'cas_conflict' };
  const tip = start === 'linear' && (place === 'main' || place === 'from-ref' || place === 'from-oid');
  if (!tip) {
    if (op === 'edit' || op === 'edit-zero' || op === 'edit-two' || op === 'delete' || op === 'delete-miss' || op === 'rename' || op === 'rename-onto' || op === 'sequence') return { kind: 'refuse', code: 'not_found' };
    if (op === 'rename-self') return { kind: 'refuse', code: 'bad_request' };
    return { kind: 'commit', root: true };
  }
  if (op === 'create-dup') return { kind: 'disagree' };
  if (op === 'edit-zero' || op === 'edit-two') return { kind: 'refuse', code: 'match_count' };
  if (op === 'delete-miss') return { kind: 'refuse', code: 'not_found' };
  if (op === 'rename-onto' || op === 'rename-self') return { kind: 'refuse', code: 'bad_request' };
  if (op === 'touch') return place === 'main' ? { kind: 'noop' } : { kind: 'nothing' };
  return { kind: 'commit', root: false };
}
function workFrom(bare, kind) {
  const work = join(root, `w${n++}`);
  if (kind === 'tip') git(root, ['-c', 'core.autocrlf=false', 'clone', '-q', bare, work]);
  else git(root, ['-c', 'core.autocrlf=false', 'init', '-q', '-b', 'main', work]);
  git(work, ['config', 'commit.gpgsign', 'false']);
  git(work, ['config', 'core.autocrlf', 'false']);
  return work;
}
function writeRepo(work, path, data, mode) {
  const full = join(work, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, data);
  if (mode !== undefined) chmodSync(full, mode);
  git(work, ['add', '--', path]);
}
function applyGit(work, op) {
  if (op === 'create') writeRepo(work, 'n.txt', 'n\n');
  else if (op === 'create-dup') writeRepo(work, 'a.txt', 'z\n');
  else if (op === 'write' || op === 'touch') writeRepo(work, 'a.txt', op === 'write' ? 'w\n' : 'v1\n');
  else if (op === 'edit') {
    const full = join(work, 'a.txt');
    writeFileSync(full, readFileSync(full, 'utf8').replace('v1', 'v2'));
    git(work, ['add', '--', 'a.txt']);
  } else if (op === 'delete') git(work, ['rm', '-q', '--', 'a.txt']);
  else if (op === 'rename') git(work, ['mv', 'a.txt', 'z.txt']);
  else if (op === 'sequence') {
    writeRepo(work, 'n.txt', 'n\n'); writeRepo(work, 'w.txt', 'w\n'); git(work, ['rm', '-q', '--', 'twin.txt']);
  } else if (op === 'exec') writeRepo(work, 'bin/run', '#!/bin/sh\n', 0o755);
  else if (op === 'symlink') { symlinkSync('a.txt', join(work, 'slink')); git(work, ['add', '--', 'slink']); }
  else throw new Error(`no git twin for ${op}`);
}
function tryCommit(work, env = STAMP) {
  try {
    gitEnv(work, ['-c', 'user.name=Ada', '-c', 'user.email=ada@x', 'commit', '-q', '-m', 'c'], env);
    return { oid: git(work, ['rev-parse', 'HEAD']).trim(), err: '' };
  } catch (e) { return { oid: null, err: String(e.stderr ?? e.message).slice(0, 500) }; }
}
function counts() {
  const c = { upload: 0, receive: 0 };
  const fetchImpl = async (url, init) => {
    const kind = String(url).split('?')[0].split('/').pop();
    if (kind === 'git-upload-pack') c.upload++;
    else if (kind === 'git-receive-pack') c.receive++;
    return fetch(url, init);
  };
  return { c, fetchImpl };
}
const caught = p => p.then(() => null, e => e);
function sameCommit(bare, plyOid, work, gitOid) {
  const plyBytes = gitBuf(bare, ['cat-file', 'commit', plyOid]);
  const gitBytes = gitBuf(work, ['cat-file', 'commit', gitOid]);
  if (!plyBytes.equals(gitBytes)) throw new Error(`commit bytes differ\n--- ply\n${plyBytes.toString()}\n--- git\n${gitBytes.toString()}`);
}

async function productCell(start, place, op) {
  const repo = copy(start === 'linear' ? linearBare : emptyBare);
  const ref = refOf(place);
  const before = refOid(repo.bare, ref);
  const { c, fetchImpl } = counts();
  const spec = { ref, ...baseOf(start, place), changes: changesOf(op), author: AUTHOR, message: 'c' };
  const cls = classOf(start, place, op);
  const run = () => commit(repo.url, spec, { fetchImpl });
  if (cls.kind === 'pre' || cls.kind === 'refuse') {
    const e = await caught(run());
    assert.ok(e, `${start}/${place}/${op} expected ${cls.code}`);
    assert.equal(e.code, cls.code, e.message);
    if (cls.fetches === 0) assert.equal(c.upload + c.receive, 0);
    if (cls.rebase) { assert.equal(e.what, 'rebase'); assert.match(e.message, /not the tip/); }
    if (cls.code === 'match_count') assert.equal(e.matches, op === 'edit-two' ? 2 : 0);
    if (cls.code === 'cas_conflict') { assert.equal(e.expected, ZERO); assert.equal(e.actual, tips.tip); }
    assert.equal(c.receive, 0);
    assert.equal(refOid(repo.bare, ref), before);
    return;
  }
  const work = workFrom(repo.bare, cls.root ? 'empty' : 'tip');
  applyGit(work, op);
  const twin = tryCommit(work);
  if (cls.kind === 'disagree' || cls.kind === 'nothing') {
    if (cls.kind === 'disagree') assert.ok(twin.oid, twin.err);
    else assert.equal(twin.oid, null, twin.err);
    const e = await caught(run());
    assert.ok(e);
    assert.equal(e.code, 'bad_request', e.message);
    assert.match(e.message, cls.kind === 'nothing' ? /nothing to commit/ : /already exists/);
    assert.equal(c.receive, 0);
    assert.equal(refOid(repo.bare, ref), before);
    return;
  }
  if (cls.kind === 'noop') {
    assert.equal(twin.oid, null, twin.err);
    const res = await run();
    assert.equal(res.outcome, 'noop');
    assert.equal(res.pushBytes, 0);
    assert.equal(res.created, false);
    assert.equal(res.oid, tips.tip);
    assert.equal(c.receive, 0);
    assert.equal(refOid(repo.bare, ref), tips.tip);
    return;
  }
  assert.ok(twin.oid, twin.err);
  const res = await run();
  assert.equal(res.outcome, 'commit');
  assert.equal(res.ref, ref);
  assert.equal(res.created, !(start === 'linear' && place === 'main'));
  assert.equal(res.oldOid, res.created ? null : tips.tip);
  assert.equal(res.parent, cls.root ? null : tips.tip);
  assert.ok(res.pushBytes > 0);
  assert.equal(c.receive, 1);
  sameCommit(repo.bare, res.oid, work, twin.oid);
  assert.equal(refOid(repo.bare, ref), res.oid);
  assert.deepEqual(fsckProblems(repo.bare), []);
}

test('commitChanges: start × place × op against git cat-file and fsck --strict', async () => {
  const failures = [];
  let seen = 0;
  walk: for (const start of STARTS) for (const place of PLACES) for (const op of OP_NAMES) {
    seen++;
    try { await productCell(start, place, op); }
    catch (e) {
      failures.push(`${start}/${place}/${op}: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
      if (failures.length >= 12) break walk;
    }
  }
  console.log(`commit-changes product: ${seen} cells, ${failures.length} failures`);
  assert.deepEqual(failures, []);
  assert.equal(seen, STARTS.length * PLACES.length * OP_NAMES.length);
});

const enc = s => new TextEncoder().encode(s);
const OID = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);

test('memtree: every refusal, and the size boundaries git would still hash', () => {
  const lim1 = withLimits({ maxTreeEntries: 1, maxObjectSize: 4 });
  const wide = withLimits({ maxTreeEntries: 20, maxObjectSize: 64 });
  assert.throws(() => requireDir(lazyNode('100644', OID), 'a.txt'), e => e.code === 'bad_request' && /not a directory/.test(e.message));
  assert.equal(requireDir(emptyDir(), '').size, 0);
  const leaf = fileLeaf('100644', enc('abcd'), lim1, 'f');
  assert.equal(leaf.data.length, 4);
  assert.throws(() => fileLeaf('100644', enc('abcde'), lim1, 'f'), e => e.code === 'limit_exceeded' && e.what === 'object size' && e.got === 5 && e.max === 4);
  assert.throws(() => fileLeaf('120000', enc(''), lim1, 's'), e => e.code === 'bad_request' && e.what === 'symlink');
  assert.throws(() => fileLeaf('120000', Uint8Array.of(0x61, 0), lim1, 's'), e => e.code === 'bad_request' && e.what === 'symlink');
  assert.equal(fileLeaf('120000', enc('ab'), lim1, 's').mode, '120000');
  const entries = new Map();
  insertChild(entries, 'a', lazyNode('100644', OID), lim1);
  assert.throws(() => insertChild(entries, 'b', lazyNode('100644', OID_B), lim1), e => e.code === 'limit_exceeded' && e.what === 'tree entries' && e.got === 2 && e.max === 1);
  insertChild(entries, 'a', lazyNode('100644', OID_B), lim1);
  const one = emptyDir(); one.entries.set('a', lazyNode('100644', OID));
  assert.equal(typeof encodeMem(one, lim1).oid, 'string');
  const two = emptyDir(); two.entries.set('a', lazyNode('100644', OID)); two.entries.set('b', lazyNode('100644', OID_B));
  assert.throws(() => encodeMem(two, lim1), e => e.code === 'limit_exceeded' && e.what === 'tree entries' && e.got === 2);
  const rootDir = emptyDir();
  assert.throws(() => putAt(rootDir, ['missing', 'f'], lazyNode('100644', OID), false, wide), e => e.code === 'bad_request' && /not a directory/.test(e.message));
  rootDir.entries.set('file', lazyNode('100644', OID));
  assert.throws(() => putAt(rootDir, ['file', 'f'], lazyNode('100644', OID_B), true, wide), e => /not a directory/.test(e.message));
  const sub = emptyDir(); rootDir.entries.set('dir', sub);
  assert.throws(() => putAt(rootDir, ['dir'], lazyNode('100644', OID_B), true, wide), e => /is a directory/.test(e.message));
  rootDir.entries.set('tree', lazyNode('40000', OID));
  assert.throws(() => putAt(rootDir, ['tree'], lazyNode('100644', OID_B), true, wide), e => /is a directory/.test(e.message));
  assert.throws(() => putAt(rootDir, ['file'], lazyNode('100644', OID_B), false, wide), e => /already exists/.test(e.message));
  putAt(rootDir, ['file'], lazyNode('100644', OID_B), true, wide);
  assert.equal(rootDir.entries.get('file').oid, OID_B);
  putAt(rootDir, ['fresh'], lazyNode('100644', OID), false, wide);
  assert.throws(() => removeAt(rootDir, ['nope']), e => e.code === 'not_found');
  assert.throws(() => removeAt(rootDir, ['gone', 'f']), e => e.code === 'not_found' && /gone not found/.test(e.message));
  assert.throws(() => removeAt(rootDir, ['file', 'f']), e => e.code === 'not_found' && /not a directory/.test(e.message));
  sub.entries.set('b', lazyNode('100644', OID));
  removeAt(rootDir, ['dir', 'b']);
  assert.equal(rootDir.entries.has('dir'), false);
  assert.throws(() => renameAt(emptyDir(), ['a'], ['a']), e => /already named/.test(e.message));
  assert.throws(() => renameAt(emptyDir(), ['nope'], ['nope', 'x']), e => /into itself/.test(e.message));
  assert.throws(() => renameAt(emptyDir(), ['missing'], ['z']), e => e.code === 'not_found');
  assert.throws(() => renameAt(emptyDir(), ['missing', 'child'], ['z']), e => e.code === 'not_found' && /missing not found/.test(e.message));
  const ren = emptyDir(); ren.entries.set('file', lazyNode('100644', OID));
  assert.throws(() => renameAt(ren, ['file', 'a'], ['z']), e => /not a directory/.test(e.message));
  assert.throws(() => renameAt(ren, ['file'], ['no', 'z']), e => e.code === 'not_found' && /no not found/.test(e.message));
  ren.entries.set('file2', lazyNode('100644', OID_B));
  assert.throws(() => renameAt(ren, ['file2'], ['file']), e => e.code === 'bad_request' && /already exists/.test(e.message));
  const nested = emptyDir(); nested.entries.set('f', lazyNode('100644', OID)); ren.entries.set('dir', nested);
  assert.throws(() => renameAt(ren, ['dir', 'f'], ['file', 'z']), e => e.code === 'not_found' && /not a directory/.test(e.message));
  renameAt(ren, ['dir', 'f'], ['kept']);
  assert.equal(ren.entries.has('dir'), false);
  assert.equal(ren.entries.get('kept').oid, OID);
  assert.throws(() => replaceOnce(enc('ab'), enc(''), enc('x')), e => e.code === 'bad_request');
  assert.throws(() => replaceOnce(enc('ab'), enc('z'), enc('x')), e => e.code === 'match_count' && e.matches === 0);
  assert.throws(() => replaceOnce(enc('xx'), enc('x'), enc('y')), e => e.code === 'match_count' && e.matches === 2);
  assert.equal(Buffer.from(replaceOnce(enc('v1\n'), enc('v1'), enc('v2'))).toString(), 'v2\n');
});

test('commitChanges rejects a bad list before any fetch', async () => {
  const repo = copy(emptyBare);
  const author = AUTHOR;
  const message = 'c';
  const one = { kind: 'create', path: 'n.txt', content: 'n\n' };
  const bad = [
    [{ ref: 'refs/heads/main', changes: [], author, message }, /non-empty/],
    [{ ref: 'refs/heads/main', changes: null, author, message }, /non-empty/],
    [{ ref: 'refs/heads/main', changes: [null], author, message }, /object/],
    [{ ref: 'refs/heads/main', changes: [{ kind: 'nope' }], author, message }, /unknown change kind/],
    [{ ref: 'refs/heads/main', changes: [{ kind: 'edit', path: 'a.txt', find: '', replace: 'x' }], author, message }, /find must be non-empty/],
    [{ ref: 'refs/heads/main', changes: [{ kind: 'create', path: 'n.txt', content: 1 }], author, message }, /content/],
    [{ ref: 'refs/heads/main', changes: [{ kind: 'create', path: 'n.txt', content: 'n', mode: '100666' }], author, message }, /mode/],
    [{ ref: 'refs/heads/main', changes: [one], author, message, base: ZERO }, /zero oid is not a commit/],
    [{ ref: 'refs/heads/main', changes: [one], author, message, base: 'A'.repeat(40) }, /lowercase hex/],
    [{ ref: 'refs/heads/main', changes: [{ kind: 'create' }, { kind: 'create', path: 'b', content: 'b' }], author, message }, /limit/, { maxPackObjects: 1 }],
  ];
  for (const [spec, re, limits] of bad) {
    const { c, fetchImpl } = counts();
    const e = await caught(commit(repo.url, spec, { fetchImpl, ...(limits ? { limits: withLimits(limits) } : {}) }));
    assert.ok(e, re);
    assert.equal(e.code, limits ? 'limit_exceeded' : 'bad_request', `${e.code} ${e.message}`);
    assert.match(e.message, re, e.message);
    assert.equal(c.upload + c.receive, 0, e.message);
  }
  const { c, fetchImpl } = counts();
  const e = await caught(commit(repo.url, { ref: 'refs/heads/main', changes: [one], author, message }, { fetchImpl, head: 'not-an-oid' }));
  assert.equal(e.code, 'bad_request');
  assert.match(e.message, /lowercase hex|40/);
  assert.equal(c.upload + c.receive, 0);
});

test('one change at the pack-object cap commits; a blob at the object cap commits and one past it does not', async () => {
  const ok = copy(emptyBare);
  const res = await commit(ok.url, { ref: 'refs/heads/main', changes: [{ kind: 'create', path: 'n.txt', content: 'abcd' }], author: AUTHOR, message: 'c' }, { limits: withLimits({ maxPackObjects: 1, maxObjectSize: 4 }) });
  assert.equal(res.created, true);
  assert.equal(git(ok.bare, ['cat-file', '-p', `${res.oid}:n.txt`]), 'abcd');
  const over = copy(emptyBare);
  const before = refOid(over.bare, 'refs/heads/main');
  const e = await caught(commit(over.url, { ref: 'refs/heads/main', changes: [{ kind: 'create', path: 'n.txt', content: 'abcde' }], author: AUTHOR, message: 'c' }, { limits: withLimits({ maxObjectSize: 4 }) }));
  assert.equal(e.code, 'limit_exceeded');
  assert.equal(e.what, 'object size');
  assert.equal(refOid(over.bare, 'refs/heads/main'), before);
  const wide = copy(emptyBare);
  const tree = await caught(commit(wide.url, { ref: 'refs/heads/main', changes: [{ kind: 'create', path: 'a.txt', content: 'a' }, { kind: 'create', path: 'b.txt', content: 'b' }], author: AUTHOR, message: 'c' }, { limits: withLimits({ maxTreeEntries: 1 }) }));
  assert.equal(tree.code, 'limit_exceeded');
  assert.equal(tree.what, 'tree entries');
  assert.equal(refOid(wide.bare, 'refs/heads/main'), null);
});

test('heads, bases, and a 40-hex editFile', async () => {
  const match = copy(linearBare);
  const res = await commit(match.url, { ref: 'refs/heads/main', changes: changesOf('create'), author: AUTHOR, message: 'c' }, { head: tips.tip });
  assert.equal(res.parent, tips.tip);
  assert.equal(git(match.bare, ['rev-parse', 'main^']).trim(), tips.tip);
  const stale = copy(linearBare);
  const { c, fetchImpl } = counts();
  const missed = await caught(commit(stale.url, { ref: 'refs/heads/main', changes: changesOf('create'), author: AUTHOR, message: 'c' }, { head: tips.old, fetchImpl }));
  assert.equal(missed.code, 'cas_conflict');
  assert.equal(missed.expected, tips.old);
  assert.equal(missed.actual, tips.tip);
  assert.equal(missed.cause, undefined);
  assert.equal(c.receive, 0);
  assert.equal(refOid(stale.bare, 'refs/heads/main'), tips.tip);
  const held = copy(linearBare);
  const { c: zc, fetchImpl: zf } = counts();
  const zeroHead = await caught(commit(held.url, { ref: 'refs/heads/main', changes: changesOf('create'), author: AUTHOR, message: 'c' }, { head: ZERO, fetchImpl: zf }));
  assert.equal(zeroHead.code, 'cas_conflict');
  assert.equal(zeroHead.expected, ZERO);
  assert.equal(zeroHead.actual, tips.tip);
  assert.equal(zc.receive, 0);
  const born = copy(emptyBare);
  const created = await commit(born.url, { ref: 'refs/heads/topic', changes: changesOf('create'), author: AUTHOR, message: 'c' }, { head: ZERO });
  assert.equal(created.created, true);
  assert.equal(created.oldOid, null);
  assert.equal(refOid(born.bare, 'refs/heads/topic'), created.oid);
  const blob = git(linearBare, ['rev-parse', `${tips.tip}:a.txt`]).trim();
  const notCommit = copy(linearBare);
  const miss = await caught(commit(notCommit.url, { ref: 'refs/heads/topic', base: blob, changes: changesOf('create'), author: AUTHOR, message: 'c' }));
  assert.equal(miss.code, 'not_found');
  assert.equal(miss.miss.kind, 'commit');
  assert.equal(miss.miss.miss.kind, 'not_commit');
  assert.equal(miss.miss.miss.type, 'blob');
  assert.equal(refOid(notCommit.bare, 'refs/heads/topic'), null);
  const absent = copy(emptyBare);
  const gone = await caught(commit(absent.url, { ref: 'refs/heads/topic', base: 'b'.repeat(40), changes: changesOf('create'), author: AUTHOR, message: 'c' }));
  assert.equal(gone.code, 'not_found');
  assert.equal(gone.miss.kind, 'commit');
  assert.equal(gone.miss.miss.kind, 'absent');
  const bytes = new Uint8Array([0x6e, 0x0a]);
  const raw = copy(emptyBare);
  const rawRes = await commit(raw.url, { ref: 'refs/heads/main', changes: [{ kind: 'create', path: 'n.txt', content: bytes }], author: AUTHOR, message: 'c' });
  assert.equal(git(raw.bare, ['cat-file', '-p', `${rawRes.oid}:n.txt`]), 'n\n');
  const edited = copy(linearBare);
  const direct = await edit(edited.url, { ref: 'refs/heads/main', base: tips.tip, path: 'a.txt', find: 'v1', replace: 'v2', author: AUTHOR, message: 'c' });
  const work = workFrom(linearBare, 'tip');
  applyGit(work, 'edit');
  const twin = tryCommit(work);
  sameCommit(edited.bare, direct.newCommit, work, twin.oid);
  const off = copy(linearBare);
  const { c: ec, fetchImpl: ef } = counts();
  const rebase = await caught(edit(off.url, { ref: 'refs/heads/main', base: tips.old, path: 'a.txt', find: 'old', replace: 'x', author: AUTHOR, message: 'c' }, { fetchImpl: ef }));
  assert.equal(rebase.code, 'bad_request');
  assert.equal(rebase.what, 'rebase');
  assert.match(rebase.message, /not the tip/);
  assert.equal(ec.receive, 0);
  assert.equal(refOid(off.bare, 'refs/heads/main'), tips.tip);
  const { c: zc2, fetchImpl: zf2 } = counts();
  const zeroBase = await caught(edit(off.url, { base: ZERO, path: 'a.txt', find: 'v1', replace: 'v2', author: AUTHOR, message: 'c' }, { fetchImpl: zf2 }));
  assert.equal(zeroBase.code, 'bad_request');
  assert.match(zeroBase.message, /zero oid/);
  assert.equal(zc2.upload + zc2.receive, 0);
  const branch = copy(linearBare);
  const made = await edit(branch.url, { ref: 'refs/heads/topic', base: tips.tip, path: 'a.txt', find: 'v1', replace: 'v2', author: AUTHOR, message: 'c' });
  assert.equal(git(branch.bare, ['rev-parse', 'topic']).trim(), made.newCommit);
  assert.equal(git(branch.bare, ['rev-parse', 'topic^']).trim(), tips.tip);
});

test('author and committer stamps match git on both the stream and the in-memory path', async () => {
  const env = {
    GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@x', GIT_AUTHOR_DATE: '1700000000 +0000',
    GIT_COMMITTER_NAME: 'Bea', GIT_COMMITTER_EMAIL: 'bea@x', GIT_COMMITTER_DATE: '1700001000 -0500',
  };
  const author = { name: 'Ada', email: 'ada@x', tz: '+0000', time: 1700000000 };
  const committer = { name: 'Bea', email: 'bea@x', tz: '-0500', time: 1700001000 };
  for (const op of ['create', 'edit']) {
    const repo = copy(linearBare);
    const work = workFrom(repo.bare, 'tip');
    applyGit(work, op);
    const twin = tryCommit(work, env);
    const res = await commit(repo.url, { ref: 'refs/heads/main', changes: changesOf(op), author, committer, message: 'c' });
    sameCommit(repo.bare, res.oid, work, twin.oid);
    assert.deepEqual(fsckProblems(repo.bare), []);
  }
});

function retip(bare, ref, parent) {
  const tree = git(bare, ['rev-parse', `${parent}^{tree}`]).trim();
  const oid = gitEnv(bare, ['commit-tree', tree, '-p', parent, '-m', 'race'], {
    GIT_AUTHOR_NAME: 'race', GIT_AUTHOR_EMAIL: 'race@x', GIT_AUTHOR_DATE: '1710000000 +0000',
    GIT_COMMITTER_NAME: 'race', GIT_COMMITTER_EMAIL: 'race@x', GIT_COMMITTER_DATE: '1710000000 +0000',
  }).trim();
  git(bare, ['update-ref', ref, oid]);
  return oid;
}
function counting(hook) {
  const c = { 'git-upload-pack': 0, 'git-receive-pack': 0 };
  const fetchImpl = async (url, init) => {
    const kind = String(url).split('?')[0].split('/').pop();
    if (Object.hasOwn(c, kind)) { c[kind] += 1; await hook(kind, c); }
    return fetch(url, init);
  };
  return { c, fetchImpl };
}

test('a lost compare-and-swap reports the oid that won, and an update is retried once', async () => {
  const retry = copy(linearBare);
  let moved = null;
  const race = counting(kind => { if (kind === 'git-receive-pack' && moved === null) moved = retip(retry.bare, 'refs/heads/main', tips.tip); });
  const res = await commit(retry.url, { ref: 'refs/heads/main', changes: changesOf('create'), author: AUTHOR, message: 'c' }, { fetchImpl: race.fetchImpl });
  assert.equal(res.parent, moved);
  assert.equal(res.oldOid, moved);
  assert.equal(git(retry.bare, ['rev-parse', 'main']).trim(), res.oid);
  assert.equal(git(retry.bare, ['rev-parse', 'main^']).trim(), moved);
  assert.equal(git(retry.bare, ['cat-file', '-p', `${res.oid}:n.txt`]), 'n\n');
  assert.equal(race.c['git-receive-pack'], 2);
  assert.deepEqual(fsckProblems(retry.bare), []);

  const pinned = copy(linearBare);
  let winner = null;
  const once = counting(kind => { if (kind === 'git-receive-pack' && winner === null) winner = retip(pinned.bare, 'refs/heads/main', tips.tip); });
  const lost = await caught(commit(pinned.url, { ref: 'refs/heads/main', changes: changesOf('create'), author: AUTHOR, message: 'c' }, { head: tips.tip, fetchImpl: once.fetchImpl }));
  assert.equal(lost.code, 'cas_conflict');
  assert.equal(lost.expected, tips.tip);
  assert.equal(lost.actual, winner);
  assert.ok(lost.cause);
  assert.equal(once.c['git-receive-pack'], 1);
  assert.equal(refOid(pinned.bare, 'refs/heads/main'), winner);

  const created = copy(linearBare);
  let taken = null;
  const createRace = counting(kind => { if (kind === 'git-receive-pack' && taken === null) { git(created.bare, ['update-ref', 'refs/heads/topic', tips.old]); taken = tips.old; } });
  const clash = await caught(commit(created.url, { ref: 'refs/heads/topic', changes: changesOf('create'), author: AUTHOR, message: 'c' }, { fetchImpl: createRace.fetchImpl }));
  assert.equal(clash.code, 'cas_conflict');
  assert.equal(clash.expected, ZERO);
  assert.equal(clash.actual, taken);
  assert.equal(createRace.c['git-receive-pack'], 1);
  assert.equal(refOid(created.bare, 'refs/heads/topic'), tips.old);

  const fast = copy(linearBare);
  let shifted = null;
  let uploads = 0;
  const convert = counting(kind => {
    if (kind !== 'git-upload-pack') return;
    uploads += 1;
    if (uploads === 2) { git(fast.bare, ['update-ref', 'refs/heads/topic', tips.old]); shifted = tips.old; }
  });
  const converted = await caught(commit(fast.url, { ref: 'refs/heads/topic', base: tips.tip, changes: changesOf('edit'), author: AUTHOR, message: 'c' }, { fetchImpl: convert.fetchImpl }));
  assert.equal(converted.code, 'cas_conflict', converted.message);
  assert.equal(converted.expected, ZERO);
  assert.equal(converted.actual, shifted);
  assert.equal(converted.cause.what, 'rebase');
  assert.equal(convert.c['git-receive-pack'], 0);
  assert.equal(refOid(fast.bare, 'refs/heads/topic'), tips.old);

  const again = copy(linearBare);
  let ahead = null;
  const streamed = counting(kind => { if (kind === 'git-receive-pack' && ahead === null) ahead = retip(again.bare, 'refs/heads/main', tips.tip); });
  const edited = await commit(again.url, { ref: 'refs/heads/main', changes: changesOf('edit'), author: AUTHOR, message: 'c' }, { fetchImpl: streamed.fetchImpl });
  assert.equal(edited.parent, ahead);
  assert.equal(git(again.bare, ['rev-parse', 'main^']).trim(), ahead);
  assert.equal(git(again.bare, ['cat-file', '-p', `${edited.oid}:a.txt`]), 'v2\n');
  assert.equal(streamed.c['git-receive-pack'], 2);
  assert.deepEqual(fsckProblems(again.bare), []);

  const strict = copy(linearBare);
  let jumped = null;
  let seenUpload = 0;
  const early = counting(kind => {
    if (kind !== 'git-upload-pack') return;
    seenUpload += 1;
    if (seenUpload === 2) jumped = retip(strict.bare, 'refs/heads/main', tips.tip);
  });
  const rethrown = await caught(commit(strict.url, { ref: 'refs/heads/main', changes: changesOf('edit'), author: AUTHOR, message: 'c' }, { head: tips.tip, fetchImpl: early.fetchImpl }));
  assert.equal(rethrown.code, 'cas_conflict');
  assert.equal(rethrown.actual, jumped);
  assert.equal(rethrown.expected, tips.tip);
  assert.equal(early.c['git-receive-pack'], 0);
  assert.equal(refOid(strict.bare, 'refs/heads/main'), jumped);
});

test('an omitted ref follows HEAD: unborn, born, detached, absent', async () => {
  const empty = copy(emptyBare);
  const work = workFrom(empty.bare, 'empty');
  applyGit(work, 'create');
  const twin = tryCommit(work);
  const res = await commit(empty.url, { changes: changesOf('create'), author: AUTHOR, message: 'c' });
  assert.equal(res.ref, 'refs/heads/main');
  assert.equal(res.created, true);
  assert.equal(res.parent, null);
  sameCommit(empty.bare, res.oid, work, twin.oid);
  assert.deepEqual(fsckProblems(empty.bare), []);
  const born = copy(linearBare);
  const bornWork = workFrom(born.bare, 'tip');
  applyGit(bornWork, 'create');
  const bornTwin = tryCommit(bornWork);
  const onMain = await commit(born.url, { changes: changesOf('create'), author: AUTHOR, message: 'c' });
  assert.equal(onMain.ref, 'refs/heads/main');
  assert.equal(onMain.parent, tips.tip);
  sameCommit(born.bare, onMain.oid, bornWork, bornTwin.oid);
  const detached = copy(linearBare);
  git(detached.bare, ['update-ref', '--no-deref', 'HEAD', tips.tip]);
  const det = await caught(commit(detached.url, { changes: changesOf('create'), author: AUTHOR, message: 'c' }));
  assert.equal(det.code, 'bad_request');
  assert.match(det.message, /detached/);
  assert.equal(refOid(detached.bare, 'refs/heads/main'), tips.tip);
  // A symref to a branch that has no commit is unborn, including when other branches exist. The new commit is a root.
  const missingHead = copy(linearBare);
  git(missingHead.bare, ['symbolic-ref', 'HEAD', 'refs/heads/topic']);
  const missingWork = workFrom(missingHead.bare, 'empty');
  applyGit(missingWork, 'create');
  const missingTwin = tryCommit(missingWork);
  const onTopic = await commit(missingHead.url, { changes: changesOf('create'), author: AUTHOR, message: 'c' });
  assert.equal(onTopic.ref, 'refs/heads/topic');
  assert.equal(onTopic.parent, null);
  assert.equal(onTopic.created, true);
  sameCommit(missingHead.bare, onTopic.oid, missingWork, missingTwin.oid);
  assert.equal(refOid(missingHead.bare, 'refs/heads/main'), tips.tip);
  // Deleting HEAD makes http-backend 404 the repository. The absent answer is a server that will not name an unborn
  // HEAD (`lsrefs.unborn ignore`): there is no oid and no target, so the caller must pass ref.
  const absent = copy(emptyBare);
  git(absent.bare, ['config', 'lsrefs.unborn', 'ignore']);
  const miss = await caught(commit(absent.url, { changes: changesOf('create'), author: AUTHOR, message: 'c' }));
  assert.equal(miss.code, 'not_found');
  assert.match(miss.message, /absent/);
  assert.equal(refOid(absent.bare, 'refs/heads/main'), null);
});

test('paths git refuses or that ply refuses by name, with the tree git would write', async () => {
  const nested = copy(linearBare);
  const nestedWork = workFrom(nested.bare, 'tip');
  const full = join(nestedWork, 'dir/b.txt');
  writeFileSync(full, readFileSync(full, 'utf8').replace('b\n', 'B\n'));
  git(nestedWork, ['add', '--', 'dir/b.txt']);
  writeRepo(nestedWork, 'n.txt', 'n\n');
  const nestedTwin = tryCommit(nestedWork);
  const nestedRes = await commit(nested.url, { ref: 'refs/heads/main', changes: [{ kind: 'edit', path: 'dir/b.txt', find: 'b\n', replace: 'B\n' }, { kind: 'create', path: 'n.txt', content: 'n\n' }], author: AUTHOR, message: 'c' });
  sameCommit(nested.bare, nestedRes.oid, nestedWork, nestedTwin.oid);
  const pruned = copy(linearBare);
  const pruneWork = workFrom(pruned.bare, 'tip');
  git(pruneWork, ['rm', '-q', '--', 'dir/b.txt']);
  const pruneTwin = tryCommit(pruneWork);
  const pruneRes = await commit(pruned.url, { ref: 'refs/heads/main', changes: [{ kind: 'delete', path: 'dir/b.txt' }], author: AUTHOR, message: 'c' });
  sameCommit(pruned.bare, pruneRes.oid, pruneWork, pruneTwin.oid);
  assert.equal(git(pruned.bare, ['ls-tree', '-r', '--name-only', pruneRes.oid]).includes('dir/'), false);
  const moved = copy(linearBare);
  const moveWork = workFrom(moved.bare, 'tip');
  git(moveWork, ['mv', 'dir', 'folder']);
  const moveTwin = tryCommit(moveWork);
  const moveRes = await commit(moved.url, { ref: 'refs/heads/main', changes: [{ kind: 'rename', from: 'dir', to: 'folder' }], author: AUTHOR, message: 'c' });
  sameCommit(moved.bare, moveRes.oid, moveWork, moveTwin.oid);
  const into = copy(linearBare);
  const intoErr = await caught(commit(into.url, { ref: 'refs/heads/main', changes: [{ kind: 'rename', from: 'dir', to: 'dir/x' }], author: AUTHOR, message: 'c' }));
  assert.equal(intoErr.code, 'bad_request');
  assert.match(intoErr.message, /into itself/);
  assert.equal(refOid(into.bare, 'refs/heads/main'), tips.tip);
  const missing = copy(emptyBare);
  const missingErr = await caught(commit(missing.url, { ref: 'refs/heads/main', changes: [{ kind: 'rename', from: 'nope', to: 'nope/x' }], author: AUTHOR, message: 'c' }));
  assert.equal(missingErr.code, 'bad_request');
  assert.match(missingErr.message, /into itself/);
  assert.equal(refOid(missing.bare, 'refs/heads/main'), null);
  const link = copy(linearBare);
  const linkErr = await caught(commit(link.url, { ref: 'refs/heads/main', changes: [{ kind: 'edit', path: 'link', find: 'a', replace: 'b' }, { kind: 'create', path: 'n.txt', content: 'n\n' }], author: AUTHOR, message: 'c' }));
  assert.equal(linkErr.code, 'not_found');
  assert.match(linkErr.message, /not a regular file/);
  assert.equal(refOid(link.bare, 'refs/heads/main'), tips.tip);
  const under = copy(linearBare);
  const underErr = await caught(commit(under.url, { ref: 'refs/heads/main', changes: [{ kind: 'create', path: 'a.txt/child', content: 'x\n' }], author: AUTHOR, message: 'c' }));
  assert.equal(underErr.code, 'bad_request');
  assert.match(underErr.message, /not a directory/);
  const deep = copy(linearBare);
  const deepErr = await caught(commit(deep.url, { ref: 'refs/heads/main', changes: [{ kind: 'delete', path: 'missing/x' }], author: AUTHOR, message: 'c' }));
  assert.equal(deepErr.code, 'not_found');
  assert.match(deepErr.message, /missing not found/);
  const emptyLink = copy(emptyBare);
  const emptySym = await caught(commit(emptyLink.url, { ref: 'refs/heads/main', changes: [{ kind: 'create', path: 's', content: '', mode: '120000' }], author: AUTHOR, message: 'c' }));
  assert.equal(emptySym.code, 'bad_request');
  assert.equal(emptySym.what, 'symlink');
  const nul = copy(emptyBare);
  const nulErr = await caught(commit(nul.url, { ref: 'refs/heads/main', changes: [{ kind: 'create', path: 's', content: Uint8Array.of(0x61, 0), mode: '120000' }], author: AUTHOR, message: 'c' }));
  assert.equal(nulErr.code, 'bad_request');
  assert.equal(nulErr.what, 'symlink');
  const cancel = copy(emptyBare);
  const cancelled = await caught(commit(cancel.url, { ref: 'refs/heads/main', changes: [{ kind: 'create', path: 'n.txt', content: 'n\n' }, { kind: 'delete', path: 'n.txt' }], author: AUTHOR, message: 'c' }));
  assert.equal(cancelled.code, 'bad_request');
  assert.match(cancelled.message, /nothing to commit/);
  assert.equal(refOid(cancel.bare, 'refs/heads/main'), null);
  const same = copy(linearBare);
  const { c, fetchImpl } = counts();
  const noop = await commit(same.url, { ref: 'refs/heads/main', changes: [{ kind: 'edit', path: 'a.txt', find: 'v1', replace: 'v1' }], author: AUTHOR, message: 'c' }, { fetchImpl });
  assert.equal(noop.outcome, 'noop');
  assert.equal(c.receive, 0);
  assert.equal(refOid(same.bare, 'refs/heads/main'), tips.tip);
  const fresh = copy(linearBare);
  const none = await caught(commit(fresh.url, { ref: 'refs/heads/topic', base: tips.tip, changes: [{ kind: 'edit', path: 'a.txt', find: 'v1', replace: 'v1' }], author: AUTHOR, message: 'c' }));
  assert.equal(none.code, 'bad_request');
  assert.match(none.message, /nothing to commit/);
  assert.equal(refOid(fresh.bare, 'refs/heads/topic'), null);
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'ab'.repeat(32) + '\nsize 1\n';
  const lfs = copy(linearBare);
  const lfsWork = workFrom(lfs.bare, 'tip');
  writeRepo(lfsWork, 'pointer.txt', pointer);
  gitEnv(lfsWork, ['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-q', '-m', 'pointer']);
  git(lfsWork, ['push', '-q', lfs.bare, 'HEAD:refs/heads/main']);
  const lfsTip = git(lfs.bare, ['rev-parse', 'main']).trim();
  const lfsChanges = [{ kind: 'edit', path: 'pointer.txt', find: 'size 1', replace: 'size 2' }, { kind: 'create', path: 'n.txt', content: 'n\n' }];
  const refused = await caught(commit(lfs.url, { ref: 'refs/heads/main', changes: lfsChanges, author: AUTHOR, message: 'c' }));
  assert.equal(refused.code, 'lfs_pointer');
  assert.equal(refOid(lfs.bare, 'refs/heads/main'), lfsTip);
  const lfsEdit = workFrom(lfs.bare, 'tip');
  const body = readFileSync(join(lfsEdit, 'pointer.txt'), 'utf8').replace('size 1', 'size 2');
  writeFileSync(join(lfsEdit, 'pointer.txt'), body);
  git(lfsEdit, ['add', '--', 'pointer.txt']);
  writeRepo(lfsEdit, 'n.txt', 'n\n');
  const lfsTwin = tryCommit(lfsEdit);
  const allowed = await commit(lfs.url, { ref: 'refs/heads/main', changes: lfsChanges, author: AUTHOR, message: 'c' }, { allowLfsPointer: true });
  sameCommit(lfs.bare, allowed.oid, lfsEdit, lfsTwin.oid);
});

test('verify re-reads the ref, and a signer produces a commit git verify-commit accepts', async () => {
  const repo = copy(emptyBare);
  const ex = arrayExporter();
  const res = await commit(repo.url, { ref: 'refs/heads/main', changes: changesOf('create'), author: AUTHOR, message: 'c' }, { tracer: new Tracer({ exporter: ex }), verify: true });
  const span = ex.lines.flatMap(flattenLine).find(s => s.name === 'git.commit');
  assert.equal(span.attrs['git.commit.verify.ref'], res.oid);
  assert.equal(span.attrs['git.commit.outcome'], 'commit');
  assert.equal(ex.lines.flatMap(flattenLine).some(s => s.name === 'git.edit.blob'), false);
  assert.equal(ex.lines.flatMap(flattenLine).some(s => s.name === 'git.commit.apply'), true);
  const stream = copy(linearBare);
  const ex2 = arrayExporter();
  await commit(stream.url, { ref: 'refs/heads/main', changes: changesOf('edit'), author: AUTHOR, message: 'c' }, { tracer: new Tracer({ exporter: ex2 }), verify: true });
  const names = ex2.lines.flatMap(flattenLine).map(s => s.name);
  assert.ok(names.includes('git.edit.blob'));
  assert.equal(names.includes('git.commit.apply'), false);
  const { signer } = await generateSigner();
  const signers = join(root, 'allowed_signers');
  writeFileSync(signers, `${AUTHOR.email} namespaces="git" ${signer.publicKeyLine}\n`);
  const signed = copy(emptyBare);
  const made = await commit(signed.url, { ref: 'refs/heads/main', changes: changesOf('create'), author: AUTHOR, message: 'c' }, { signer });
  const verified = spawnSync('git', ['-C', signed.bare, '-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen', '-c', `gpg.ssh.allowedSignersFile=${signers}`, 'verify-commit', made.oid], { encoding: 'utf8' });
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  const signedEdit = copy(linearBare);
  const edited = await commit(signedEdit.url, { ref: 'refs/heads/main', changes: changesOf('edit'), author: AUTHOR, message: 'c' }, { signer });
  const verifiedEdit = spawnSync('git', ['-C', signedEdit.bare, '-c', 'gpg.format=ssh', '-c', 'gpg.ssh.program=ssh-keygen', '-c', `gpg.ssh.allowedSignersFile=${signers}`, 'verify-commit', edited.oid], { encoding: 'utf8' });
  assert.equal(verifiedEdit.status, 0, verifiedEdit.stdout + verifiedEdit.stderr);
});
