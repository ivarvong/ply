// Fetch wants, haves and shallows are object ids, parsed once (#156): fetchRequest refuses one that is not, before any
// request (and negotiate before its first round).
// git's verdict on the same want line, from git upload-pack itself (protocol v2, stateless, as smart HTTP runs it):
// upload-pack.c parse_want reads `want <arg>` with get_oid_hex and dies "expected to get oid, not 'want …'" otherwise.
// get_oid_hex reads either case and only the first 40 characters, so two classes git answers and ply does not take as
// given: an upper-case id (ply lowercases it: the same object, and git answers ply's line with the same pack) and text
// after the id (ply refuses it; git would ignore it). Every other non-oid want git refuses, and ply refuses it too.
// A have (process_haves: "expected SHA1 object, got '…'") and a shallow (process_shallow: "invalid shallow line") are
// read the same way, with the same two classes git reads past.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { git, tmpRoot, makeBareRepo, commitFiles } from './server.js';
import { fetchBody, fetchRequest } from '../src/fetch.js';
import { fetchPack } from '../src/fetchpack.js';
import { negotiate } from '../src/negotiate.js';
import { encodeCommit, hashObject } from '../src/objects.js';
import { mergeTrees } from '../src/merge.js';
import { createTransport } from '../src/http.js';
import { Tracer } from '../src/otel.js';
import { unwrap } from './unwrap.js';
import { transport as wireTransport, frame, cat, FLUSH } from './space/wire.js';

let tmp, bare, head;
before(() => {
  tmp = tmpRoot();
  bare = makeBareRepo(tmp.root, 'w', { stock: true });
  const work = join(tmp.root, 'work');
  git(tmp.root, ['init', '-q', '-b', 'main', work]);
  head = commitFiles(work, bare, { a: 'a\n' });
});
after(() => tmp.cleanup());

const te = new TextEncoder();
// a pkt-line by hand (not ply's writer): the request git reads is the one written here
const line = s => { const b = te.encode(s); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]); };
const request = (want, extra = []) => Buffer.concat([line('command=fetch\n'), Buffer.from('0001'), line(`want ${want}\n`), ...extra.map(l => line(`${l}\n`)), line('no-progress\n'), line('done\n'), Buffer.from('0000')]);
// git's refusal of each argument that is not an oid (upload-pack.c parse_want, process_haves, process_shallow)
const DIES = { want: /expected to get oid, not 'want /, have: /git upload-pack: expected SHA1 object, got '/, shallow: /invalid shallow line: shallow/ };
// git upload-pack's answer: 'pack' (a packfile section came back) or 'refuse' (it died expecting an oid), and the bytes
const uploadPack = (body, kind = 'want') => {
  const r = spawnSync('git', ['upload-pack', '--stateless-rpc', bare], { input: body, env: { ...process.env, GIT_PROTOCOL: 'version=2' } });
  const out = r.stdout.toString('latin1');
  if (out.includes('packfile\n')) return { verdict: 'pack', out };
  assert.match(r.stderr.toString(), DIES[kind], `git's refusal: ${r.stderr}`);
  return { verdict: 'refuse', out };
};
// the pack bytes of an answer: band 1 of every pkt after the packfile header (git may split them differently per run)
const band1 = out => {
  const b = Buffer.from(out, 'latin1'), parts = [];
  for (let p = b.indexOf('packfile\n', 0, 'latin1') + 'packfile\n'.length; p + 4 <= b.length;) {
    const n = Number.parseInt(b.toString('latin1', p, p + 4), 16);
    if (n < 4) { p += 4; continue; }
    if (b[p + 4] === 1) parts.push(b.subarray(p + 5, p + n));
    p += n;
  }
  return Buffer.concat(parts);
};
const plyVerdict = want => {
  const r = fetchRequest({ wants: [want] });
  if (r.ok) return { verdict: 'ok', want: r.value.wants[0] };
  assert.equal(r.error.code, 'bad_request');
  assert.equal(r.error.what, 'want');
  return { verdict: 'refuse', message: r.error.message };
};

test('want: git upload-pack and fetchRequest agree on every class, but the two git reads past', () => {
  const cells = [
    // [name, want, git, ply]
    ['the id', head, 'pack', 'ok'],
    ['the id in upper case', head.toUpperCase(), 'pack', 'ok'],
    ['an abbreviation', head.slice(0, 7), 'refuse', 'refuse'],
    ['one digit short', head.slice(0, 39), 'refuse', 'refuse'],
    ['a ref name', 'refs/heads/main', 'refuse', 'refuse'],
    ['HEAD', 'HEAD', 'refuse', 'refuse'],
    ['empty', '', 'refuse', 'refuse'],
    ['a non-hex digit', `${head.slice(0, 39)}g`, 'refuse', 'refuse'],
    // git's get_oid_hex reads 40 characters and stops: what follows is ignored. ply does not send it.
    ['a 41st character', `${head}x`, 'pack', 'refuse'],
    ['a second word', `${head} more`, 'pack', 'refuse'],
  ];
  const wrong = [];
  for (const [name, want, gitWant, plyWant] of cells) {
    const g = uploadPack(request(want)).verdict, p = plyVerdict(want);
    if (g !== gitWant || p.verdict !== plyWant) wrong.push(`${name}: git ${g}, ply ${p.verdict}`);
    if (p.verdict === 'refuse' && p.message !== 'invalid want: must be an object id (40 hex digits)') wrong.push(`${name}: ${p.message}`);
  }
  assert.deepEqual(wrong, []);
});

test('want: an upper-case id is sent lowercase, and git answers the upper-case line with the pack it sends for the id', () => {
  const upper = head.toUpperCase();
  assert.equal(unwrap(fetchRequest({ wants: [upper] })).wants[0], head);
  // ply's body for the upper-case id is its body for the id, byte for byte
  assert.deepEqual(Buffer.from(unwrap(fetchBody({ wants: [upper] }))), Buffer.from(unwrap(fetchBody({ wants: [head] }))));
  // and git reads the two lines as one object: the same pack (band 1) in answer to either
  const pack = band1(uploadPack(request(head)).out);
  assert.equal(pack.subarray(0, 4).toString(), 'PACK');
  assert.deepEqual(band1(uploadPack(request(upper)).out), pack);
});

test('want: a NUL, CR or LF is the wire refusal it always was; a non-oid want is refused before any request', async () => {
  for (const w of [`${head}\n`, 'a\rb', 'a\0']) {
    const r = fetchRequest({ wants: [w] });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'bad_request');
    assert.equal(r.error.what, 'want');
    assert.equal(r.error.message, 'invalid want: must be a string without NUL, CR, or LF');
  }
  // the first bad want is the refusal, in order; haves after it are not read
  const second = fetchRequest({ wants: [head, 'refs/heads/main'], haves: ['x\n'] });
  assert.equal(second.error.what, 'want');
  let requests = 0;
  const t = unwrap(createTransport('http://127.0.0.1:9/r.git', { tracer: new Tracer(), fetchImpl: async () => { requests++; throw new Error('no request expected'); } }));
  const r = await fetchPack(t, { wants: ['refs/heads/main'] });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'bad_request');
  assert.equal(r.error.what, 'want');
  assert.equal(requests, 0);
});

// [name, value, git, ply] for any oid argument: the classes of the want table above
const oidCells = () => [
  ['the id', head, 'pack', 'ok'],
  ['the id in upper case', head.toUpperCase(), 'pack', 'ok'],
  ['an abbreviation', head.slice(0, 7), 'refuse', 'refuse'],
  ['one digit short', head.slice(0, 39), 'refuse', 'refuse'],
  ['a ref name', 'refs/heads/main', 'refuse', 'refuse'],
  ['HEAD', 'HEAD', 'refuse', 'refuse'],
  ['empty', '', 'refuse', 'refuse'],
  ['a non-hex digit', `${head.slice(0, 39)}g`, 'refuse', 'refuse'],
  ['a 41st character', `${head}x`, 'pack', 'refuse'],
  ['a second word', `${head} more`, 'pack', 'refuse'],
];

for (const [kind, key] of [['have', 'haves'], ['shallow', 'shallows']]) {
  test(`${kind}: git upload-pack and fetchRequest agree on every class, but the two git reads past`, () => {
    const wrong = [];
    for (const [name, value, gitWant, plyWant] of oidCells()) {
      const g = uploadPack(request(head, [`${kind} ${value}`]), kind).verdict;
      const r = fetchRequest({ wants: [head], [key]: [value] });
      const p = r.ok ? 'ok' : 'refuse';
      if (g !== gitWant || p !== plyWant) wrong.push(`${name}: git ${g}, ply ${p}`);
      if (!r.ok && (r.error.code !== 'bad_request' || r.error.what !== kind || r.error.message !== `invalid ${kind}: must be an object id (40 hex digits)`)) wrong.push(`${name}: ${r.error.code} ${r.error.what} ${r.error.message}`);
      // an accepted one is sent as its lowercase id: the line git answered with the same verdict
      if (r.ok) assert.equal(r.value[key][0], head, name);
    }
    assert.deepEqual(wrong, []);
  });
}

test('have, shallow: an upper-case id is sent lowercase; git answers either line with the same pack', () => {
  for (const kind of ['have', 'shallow']) {
    const key = `${kind}s`;
    assert.deepEqual(Buffer.from(unwrap(fetchBody({ wants: [head], [key]: [head.toUpperCase()] }))), Buffer.from(unwrap(fetchBody({ wants: [head], [key]: [head] }))), kind);
    assert.deepEqual(band1(uploadPack(request(head, [`${kind} ${head.toUpperCase()}`]), kind).out), band1(uploadPack(request(head, [`${kind} ${head}`]), kind).out), kind);
  }
});

test('have, shallow: a NUL, CR or LF is the wire refusal; wants, then haves, then shallows; nothing is sent', async () => {
  for (const [kind, key] of [['have', 'haves'], ['shallow', 'shallows']]) {
    for (const v of [`${head}\n`, 'a\rb', 'a\0']) {
      const r = fetchRequest({ wants: [head], [key]: [v] });
      assert.deepEqual([r.ok, r.error.code, r.error.what, r.error.message], [false, 'bad_request', kind, `invalid ${kind}: must be a string without NUL, CR, or LF`]);
    }
  }
  assert.equal(fetchRequest({ wants: ['x'], haves: ['y'], shallows: ['z'] }).error.what, 'want');
  assert.equal(fetchRequest({ wants: [head], haves: ['y'], shallows: ['z'] }).error.what, 'have');
  assert.equal(fetchRequest({ wants: [head], haves: [head], shallows: ['z'] }).error.what, 'shallow');
  let requests = 0;
  const t = unwrap(createTransport('http://127.0.0.1:9/r.git', { tracer: new Tracer(), fetchImpl: async () => { requests++; throw new Error('no request expected'); } }));
  for (const opts of [{ haves: ['refs/heads/main'] }, { shallows: [head.slice(0, 7)] }]) {
    const r = await fetchPack(t, { wants: [head], ...opts });
    assert.deepEqual([r.ok, r.error.code], [false, 'bad_request']);
  }
  // negotiate parses every have before its first round: the bad one in the last batch is refused with nothing sent
  const n = await negotiate(t, { wants: [head], haves: [...Array.from({ length: 40 }, () => head), 'refs/heads/main'], batch: 16 });
  assert.deepEqual([n.ok, n.error.code, n.error.what], [false, 'bad_request', 'have']);
  assert.equal(requests, 0);
});

test('negotiate: an acknowledgment that is not an object id is the server\'s protocol error, not a have to send back', async () => {
  // a v2 answer with an acknowledgments section and no pack: the next round would offer each ACKed id as a have
  const answer = ack => cat([frame('acknowledgments\n'), frame(`ACK ${ack}\n`), FLUSH]);
  let sent = 0;
  const served = ack => wireTransport(() => { sent++; return { bytes: answer(ack) }; });
  const bad = await negotiate(served('refs/heads/main'), { wants: [head], haves: [head, head], batch: 1 });
  assert.deepEqual([bad.ok, bad.error.code, bad.error.message], [false, 'protocol', 'negotiate: the server acknowledged "refs/heads/main", not an object id']);
  assert.equal(sent, 1, 'refused after the round that read it');
  // an id is kept, and sent back as a have
  sent = 0;
  const good = await negotiate(served(head), { wants: [head], haves: [head], batch: 1, maxRounds: 1 });
  assert.deepEqual([good.ok, good.value.common, sent], [true, [head], 2]);
  // a long acknowledgment is quoted cut short
  sent = 0;
  const long = await negotiate(served('x'.repeat(100)), { wants: [head], haves: [head], batch: 1 });
  assert.equal(long.error.message, `negotiate: the server acknowledged "${'x'.repeat(60)}", not an object id`);
  // no haves: no round, only the final request
  sent = 0;
  assert.deepEqual([(await negotiate(served(head), { wants: [head] })).ok, sent], [true, 1]);
  // git writes an acknowledged id as it writes every id, lowercase: an upper-case one is not an id this client sent
  sent = 0;
  const upper = await negotiate(served(head.toUpperCase()), { wants: [head], haves: [head], batch: 1 });
  assert.deepEqual([upper.ok, upper.error.code, sent], [false, 'protocol', 1]);
});

// A commit's tree and parent ids are parsed once at encodeCommit (#156). git's judges on the same header lines: git
// hash-object -t commit (fsck_commit: badTreeSha1, badParentSha1) refuses every line that is not 40 hex digits, and
// keeps an upper-case id as given; git commit-tree, the porcelain that writes a commit, writes the id lowercase.
// encodeCommit refuses what fsck refuses and writes what commit-tree writes.
test('encodeCommit: tree and parent ids against git hash-object (fsck) and git commit-tree', () => {
  const who = 'A <a@b.c> 1 +0000';
  const tree = git(tmp.root, ['hash-object', '-t', 'tree', '--stdin'], { input: '' }).trim();
  const commitText = (t, parents) => `tree ${t}\n${parents.map(p => `parent ${p}\n`).join('')}author ${who}\ncommitter ${who}\n\nm\n`;
  const fsck = text => spawnSync('git', ['hash-object', '-t', 'commit', '--stdin'], { input: text, cwd: tmp.root }).status === 0 ? 'ok' : 'refuse';
  const env = { ...process.env, GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_AUTHOR_DATE: '@1 +0000', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@b.c', GIT_COMMITTER_DATE: '@1 +0000' };
  const commitTree = (t, parents) => spawnSync('git', ['--git-dir', bare, 'commit-tree', t, ...parents.flatMap(p => ['-p', p]), '-m', 'm'], { env }).stdout.toString().trim();
  const ply = (t, parents) => encodeCommit({ tree: t, parents, author: who, message: 'm\n' });
  // the tree must exist for commit-tree: write the empty tree into the bare repository
  git(tmp.root, ['--git-dir', bare, 'hash-object', '-w', '-t', 'tree', '--stdin'], { input: '' });
  const cells = [
    // [name, value, fsck, ply]
    ['the id', tree, 'ok', 'ok'],
    ['upper case', tree.toUpperCase(), 'ok', 'ok'],
    ['an abbreviation', tree.slice(0, 7), 'refuse', 'refuse'],
    ['a ref name', 'refs/heads/main', 'refuse', 'refuse'],
    ['a non-hex digit', `${tree.slice(0, 39)}g`, 'refuse', 'refuse'],
    ['a 41st character', `${tree}0`, 'refuse', 'refuse'],
    ['empty', '', 'refuse', 'refuse'],
  ];
  const wrong = [];
  for (const [name, value, gitSays, plySays] of cells) {
    for (const [what, text, r] of [['tree', commitText(value, []), ply(value, [])], ['parent', commitText(tree, [value]), ply(tree, [value])]]) {
      const g = fsck(text), p = r.ok ? 'ok' : 'refuse';
      if (g !== gitSays || p !== plySays) wrong.push(`${what} ${name}: git ${g}, ply ${p}`);
      if (!r.ok && (r.error.code !== 'bad_request' || r.error.what !== what || !r.error.message.startsWith(`commit: ${what}: oid must be`))) wrong.push(`${what} ${name}: ${r.error.what} ${r.error.message}`);
    }
  }
  assert.deepEqual(wrong, []);
  // an accepted id, either case, is written as commit-tree writes it: the same commit, byte for byte (same oid)
  const parent = commitTree(tree, []);
  for (const [t, ps] of [[tree, []], [tree.toUpperCase(), []], [tree, [parent.toUpperCase()]]]) {
    const bytes = unwrap(ply(t, ps));
    assert.equal(hashObject('commit', bytes), commitTree(t.toLowerCase(), ps.map(p => p.toLowerCase())), `${t} ${ps}`);
    assert.equal(hashObject('commit', bytes), commitTree(t, ps), 'commit-tree lowercases what it is given');
  }
  // the header refusal (a NUL or newline) is still the one a tree or parent line gets first; then the id; then the rest
  assert.deepEqual([ply(`${tree}\n`, []).error.message, ply(tree, [`${tree}\n`]).error.message], ['tree must not contain NUL or newline', 'parent must not contain NUL or newline']);
  assert.equal(encodeCommit({ tree: 'x', parents: [], author: 'a\nb' }).error.what, 'tree');
  assert.equal(encodeCommit({ tree, parents: [], author: 'a\nb' }).error.message, 'author must not contain NUL or newline');
  // parents left out: a root commit, as commit-tree writes it with no -p
  assert.equal(hashObject('commit', unwrap(encodeCommit({ tree, author: who, message: 'm\n' }))), parent);
});

test('mergeTrees parses its three tree ids at the edge: null is the empty tree, anything else is an id, before any read', async () => {
  let requests = 0;
  const t = unwrap(createTransport('http://127.0.0.1:9/r.git', { tracer: new Tracer(), fetchImpl: async () => { requests++; throw new Error('no request expected'); } }));
  for (const side of ['base', 'ours', 'theirs']) {
    for (const bad of ['refs/heads/main', head.slice(0, 7), head.toUpperCase(), 7]) {
      const r = await mergeTrees(t, new Map(), { base: null, ours: null, theirs: null, [side]: bad });
      assert.deepEqual([r.ok, r.error.code, r.error.what], [false, 'bad_request', 'oid'], `${side} ${bad}`);
    }
  }
  // base first, then ours, then theirs
  assert.equal((await mergeTrees(t, new Map(), { base: 'x', ours: 'y', theirs: 'z' })).error.got, 'x');
  assert.equal((await mergeTrees(t, new Map(), { base: null, ours: 'y', theirs: 'z' })).error.got, 'y');
  // three empty trees merge to nothing with no read: as null, and as the empty tree's id held in the cache (each side is
  // read by its parsed id; a side read as anything else would be fetched, and this transport refuses every request)
  const empty = unwrap(await mergeTrees(t, new Map(), { base: null, ours: null, theirs: null }));
  assert.deepEqual([empty.oid, empty.conflicts], [null, []]);
  const EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const held = unwrap(await mergeTrees(t, new Map([[EMPTY, new Uint8Array(0)]]), { base: EMPTY, ours: EMPTY, theirs: EMPTY }));
  assert.deepEqual([held.oid, held.conflicts, held.fetched], [null, [], 0]);
  assert.equal(requests, 0);
});
