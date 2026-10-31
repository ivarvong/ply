// encodeTag against git (issue #103, item 5). Two oracles, both git's own:
//   1. `git hash-object -t tag --stdin` (fsck_tag_standalone, every message an error): it stores what encodeTag
//      returns, under the oid hashObject gives, and it refuses each tag encodeTag refuses (the same fields, spelled out
//      as bytes by hand here, independently of src/objects.ts).
//   2. `git tag -a --cleanup=verbatim -F <file>`: for the cells git's porcelain can write (a UTF-8 tag name and tagger,
//      no extra header), `git cat-file tag` is byte-for-byte what encodeTag returns.
// Cells: target type (commit, tree, blob, an annotated tag; a lightweight tag is a ref, not an object) × tagger
// (present, absent) × message (none, empty, with and without a trailing newline, paragraphs, a signature block) ×
// bytes (UTF-8, non-UTF-8 in the name/message, non-UTF-8 in the tagger) × an extra header (none, a gpgsig-sha256 block).
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { git, tmpRoot } from './server.js';
import { encodeTag, hashObject } from '../src/index.js';
import { decodeBytes } from '../src/bytes.js';

let root, cleanup, work;
const targets = {};
before(() => {
  ({ root, cleanup } = tmpRoot());
  work = join(root, 'w'); mkdirSync(work);
  git(work, ['init', '-q', '-b', 'main']);
  writeFileSync(join(work, 'f'), 'f\n');
  git(work, ['add', 'f']);
  git(work, ['-c', 'user.name=s', '-c', 'user.email=s@x', 'commit', '-q', '-m', 'c']);
  targets.commit = git(work, ['rev-parse', 'HEAD']).trim();
  targets.tree = git(work, ['rev-parse', 'HEAD^{tree}']).trim();
  targets.blob = git(work, ['rev-parse', 'HEAD:f']).trim();
  git(work, ['-c', 'user.name=s', '-c', 'user.email=s@x', 'tag', '-a', '-m', 'inner', 'inner', 'HEAD']);
  targets.tag = git(work, ['rev-parse', 'refs/tags/inner']).trim();
});
after(() => cleanup());

const raw = (...parts) => decodeBytes(Buffer.concat(parts.map(p => (typeof p === 'string' ? Buffer.from(p) : Buffer.from(p)))));
const enc = s => Buffer.from(Uint8Array.from([...s].map(ch => { const c = ch.codePointAt(0); return c >= 0xdc80 && c <= 0xdcff ? [c - 0xdc00] : [...Buffer.from(ch)]; }).flat()));
const SIG = '-----BEGIN PGP SIGNATURE-----\n\niQEzBAABCAAdFiEE\n=abcd\n-----END PGP SIGNATURE-----\n';
const MESSAGES = { none: null, empty: '', newline: 'release\n', 'no-newline': 'release', paragraphs: 'subject\n\nbody line\n\ntrailer: x\n', signed: `release\n${SIG}` };
const BYTES = {
  utf8: { name: 'v1.0', tagger: 'Ada Lovelace <ada@x> 1700000000 -0700', msg: m => m },
  'non-utf8-name-msg': { name: raw('v', [0xe9], '-', [0xff]), tagger: 'Ada <ada@x> 1700000000 +0000', msg: m => (m === null ? null : raw(m, [0xe9, 0x80, 0xc3], '\n')) },
  'non-utf8-tagger': { name: 'v2', tagger: raw('Ad', [0xe9, 0xff], ' <a', [0xfe], '@x> 0 +1400'), msg: m => m },
};
const EXTRA = { none: [], 'gpgsig-sha256': ['gpgsig-sha256 -----BEGIN PGP SIGNATURE-----', ' ', ' iQEzBAABCAAdFiEE', ' -----END PGP SIGNATURE-----'] };

// the tag object, spelled out as git writes it (builtin/tag.c create_tag; fsck_tag_standalone's order)
const handBytes = ({ object, type, tag, tagger, extra, message }) => Buffer.concat([
  enc(`object ${object}\ntype ${type}\ntag ${tag}\n${tagger === null ? '' : `tagger ${tagger}\n`}${extra.map(l => `${l}\n`).join('')}`),
  message === null ? Buffer.alloc(0) : Buffer.concat([Buffer.from('\n'), enc(message)]),
]);
const gitHash = bytes => {
  const r = spawnSync('git', ['hash-object', '-t', 'tag', '--stdin'], { cwd: work, input: bytes, encoding: 'buffer' });
  return r.status === 0 ? { oid: r.stdout.toString().trim() } : { refused: r.stderr.toString().trim() };
};

test('encodeTag: git hash-object stores its bytes under hashObject\'s oid, and refuses exactly the tags it refuses', () => {
  let cells = 0, stored = 0, refused = 0;
  for (const [type, object] of Object.entries(targets)) {
    for (const withTagger of [true, false]) {
      for (const [mName, message0] of Object.entries(MESSAGES)) {
        for (const [bName, b] of Object.entries(BYTES)) {
          for (const [xName, extra] of Object.entries(EXTRA)) {
            const cell = `${type} tagger=${withTagger} message=${mName} bytes=${bName} extra=${xName}`;
            const fields = { object, type, tag: b.name, tagger: withTagger ? b.tagger : null, extra, message: b.msg(message0) };
            const want = gitHash(handBytes(fields));
            let got;
            try { got = encodeTag({ ...fields, tagger: fields.tagger ?? undefined }); } catch (e) { got = e; }
            if (want.refused) {
              assert.ok(got instanceof Error && got.code === 'bad_request', `${cell}: git refuses (${want.refused}), encodeTag returned bytes`);
              refused++;
            } else {
              assert.ok(!(got instanceof Error), `${cell}: git stores it, encodeTag threw ${got?.message}`);
              assert.deepEqual(Buffer.from(got), handBytes(fields), `${cell}: bytes`);
              assert.equal(hashObject('tag', got), want.oid, `${cell}: oid`);
              stored++;
            }
            cells++;
          }
        }
      }
    }
  }
  assert.equal(cells, 4 * 2 * 6 * 3 * 2);
  // every tagger-less cell is refused (missingTaggerEntry is an error to hash-object), every other is stored
  assert.equal(refused, cells / 2);
  assert.equal(stored, cells / 2);
  console.log(`  encodeTag vs git hash-object: ${cells} cells, ${stored} stored, ${refused} refused by both`);
});

test('encodeTag: byte-equal to the tag `git tag -a` writes, for every cell git\'s porcelain can write', () => {
  let cells = 0;
  const env = { ...process.env, GIT_COMMITTER_NAME: 'Ada Lovelace', GIT_COMMITTER_EMAIL: 'ada@x', GIT_COMMITTER_DATE: '1700000000 -0700' };
  for (const [type, object] of Object.entries(targets)) {
    for (const [mName, message] of Object.entries(MESSAGES)) {
      if (message === null) continue; // git tag always writes the blank line
      for (const msgBytes of ['utf8', 'non-utf8']) {
        const name = `t-${type}-${mName}-${msgBytes}`;
        const body = msgBytes === 'utf8' ? Buffer.from(message) : Buffer.concat([Buffer.from(message), Buffer.from([0xe9, 0x80, 0xc3, 0x0a])]);
        const file = join(root, `${name}.msg`);
        writeFileSync(file, body);
        const r = spawnSync('git', ['tag', '-a', '--cleanup=verbatim', '-F', file, name, object], { cwd: work, env, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        const written = git(work, ['cat-file', 'tag', `refs/tags/${name}`], { encoding: 'buffer' });
        const bytes = encodeTag({ object, type, tag: name, tagger: 'Ada Lovelace <ada@x> 1700000000 -0700', message: decodeBytes(body) });
        assert.deepEqual(Buffer.from(bytes), written, name);
        assert.equal(hashObject('tag', bytes), git(work, ['rev-parse', `refs/tags/${name}`]).trim(), name);
        cells++;
      }
    }
  }
  assert.equal(cells, 4 * 5 * 2);
  console.log(`  encodeTag vs git tag -a: ${cells} cells byte-equal`);
});

test('encodeTag refuses what git hash-object refuses: fsck_tag_standalone, cell by cell', () => {
  const object = 'ab'.repeat(20);
  const tagger = 'A <a@x> 1700000000 +0000';
  // [what changes, fields]: each is refused by git hash-object (asserted) and by encodeTag
  const refusedCells = [
    ['bad object id', { object: 'zz'.repeat(20) }],
    ['short object id', { object: object.slice(2) }],
    ['type outside the four', { type: 'bogus' }],
    ['type ofs_delta', { type: 'ofs_delta' }],
    ['empty tag name', { tag: '' }],
    ['tag name with a space', { tag: 'v 1' }],
    ['tag name with ..', { tag: 'a..b' }],
    ['tag name ending .lock', { tag: 'v1.lock' }],
    ['tag name ending /', { tag: 'v1/' }],
    ['tag name with @{', { tag: 'v@{1' }],
    ['tag name with a component starting .', { tag: 'a/.b' }],
    ['tag name ending .', { tag: 'v1.' }],
    ['tag name with DEL', { tag: 'v\u007f' }],
    ['tag name with *', { tag: 'v*' }],
    ['tagger without email', { tagger: 'A a@x 1700000000 +0000' }],
    ['tagger with a bad date', { tagger: 'A <a@x> x +0000' }],
    ['tagger zero-padded date', { tagger: 'A <a@x> 01 +0000' }],
    ['tagger with a bad timezone', { tagger: 'A <a@x> 1 +00' }],
    ['tagger missing name space', { tagger: 'A<a@x> 1 +0000' }],
  ];
  for (const [what, change] of refusedCells) {
    const fields = { object, type: 'commit', tag: 'v1', tagger, extra: [], message: 'm\n', ...change };
    assert.ok(gitHash(handBytes(fields)).refused, `${what}: git refuses`);
    assert.throws(() => encodeTag(fields), e => e.code === 'bad_request' && e.what !== undefined, what);
  }
  // accepted by both: what fsck lets through
  const storedCells = [
    ['tag name with a slash', { tag: 'release/v1' }],
    ['tag name a./b', { tag: 'a./b' }],
    ['tag name @', { tag: '@' }],
    ['upper-case object id', { object: 'AB'.repeat(20) }],
    ['type naming a blob for a commit id (no lookup)', { type: 'blob' }],
    ['tagger at epoch 0', { tagger: 'A <a@x> 0 +0000' }],
    ['tagger with an empty name', { tagger: ' <a@x> 1 +0000' }],
    ['an extra header', { extra: ['x-custom value'] }],
  ];
  for (const [what, change] of storedCells) {
    const fields = { object, type: 'commit', tag: 'v1', tagger, extra: [], message: 'm\n', ...change };
    const want = gitHash(handBytes(fields));
    assert.ok(want.oid, `${what}: git stores it (${want.refused})`);
    assert.equal(hashObject('tag', encodeTag(fields)), want.oid, what);
  }
  // ply is stricter than hash-object in two places, both already ply's reader rules: a NUL in the message (fsck
  // never reads a tag body) and an extra header that would shadow one of the four (parseTag's typed refusal)
  for (const [what, change] of [['NUL in the message', { message: 'a\0b\n' }], ['extra header shadowing tagger', { extra: [`tagger ${tagger}`] }]]) {
    const fields = { object, type: 'commit', tag: 'v1', tagger, extra: [], message: 'm\n', ...change };
    assert.ok(gitHash(handBytes(fields)).oid, `${what}: git stores it`);
    assert.throws(() => encodeTag(fields), e => e.code === 'bad_request', what);
  }
});
