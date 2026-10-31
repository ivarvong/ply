// The commit, tag and ident decision space (issue #59), decided by git. Every rule fsck.c applies to a commit or a tag
// (verify_headers, fsck_commit, fsck_tag_standalone, fsck_ident) is an axis below, as a tagged union of the shapes that
// rule sees. The cells are the product of the axes: each is built byte for byte, written by `git hash-object -t <type>
// --literally`, and judged by `git fsck --strict` (both streams, the exit code, `error in` and `warning in` lines,
// never --connectivity-only). ply must refuse exactly the cells git reports an error for, with the same msgId, and
// accept the rest. A cell git only warns about is decided per msgId in WARN_DECISION; a warning without a decision
// fails the test, so a new git msgId cannot slip through as "accept" by default.
//
//   FSCK_SPACE_LIST=1 node --test test/fsck-space.test.js   prints every disagreeing cell
//
// The space (git 2.50, fsck.h FOREACH_FSCK_MSG_ID, default severities under --strict):
//   FATAL  nulInHeader unterminatedHeader                                                   error
//   ERROR  missingTree badTreeSha1 badParentSha1 missingAuthor multipleAuthors missingCommitter
//          missingNameBeforeEmail badName missingEmail missingSpaceBeforeEmail badEmail
//          missingSpaceBeforeDate badDate zeroPaddedDate badDateOverflow badTimezone
//          missingObject badObjectSha1 missingTypeEntry missingType badType missingTagEntry missingTag     error
//   WARN   nulInCommit                                         --strict makes it an error
//   INFO   badTagName missingTaggerEntry                       a warning even under --strict (exit 0)
//   IGNORE extraHeaderEntry                                    not reported at all
// fsck_commit stops reading headers after committer: anything later (encoding, gpgsig, mergetag, unknown headers, a
// second tree/parent/author/committer, a line with no space) is not checked. fsck_tag stops after tagger the same way,
// and never looks at the tag body: a NUL there is accepted, unlike in a commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir, availableParallelism } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { assertFetched, parseCommit, parseTag, hashObject } from '../src/objects.js';
import { commitView } from '../src/read.js';

// ---- the fsck oracle (test/server.js `fsck` / `fsckProblemsOf` semantics, PR #53; one run per store) ----
// git 2.50 prints an object problem as `error in <type> <oid>: <msgId>: <text>` or `warning in <type> <oid>: …` on
// stderr; connectivity as `broken link from …`/`missing …` on stdout; a damaged store as `error:`/`fatal:`. Notices say
// nothing about an object. A continuation line is folded into the line before it. Exit bits beyond 1 (object) and 2
// (connectivity) are a store or git failure and throw. Every line must be pinned to a cell or the test throws: a
// problem no cell owns would otherwise be dropped.
function run(cmd, args, { cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd });
    const out = [], err = [];
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => err.push(d));
    p.on('error', reject);
    p.on('close', status => resolve({ status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
    p.stdin.end(input ?? '');
  });
}

async function fsckLines(dir, { packed }) {
  const r = await run('git', ['fsck', '--strict', '--no-dangling'], { cwd: dir });
  const lines = [];
  for (const l of `${r.stdout}\n${r.stderr}`.split('\n')) {
    if (!l.trim() || l.startsWith('notice:')) continue;
    if (/^\s/.test(l) && lines.length) lines[lines.length - 1] += ` ${l.trim()}`; else lines.push(l.trim());
  }
  // A packed object that does not parse is exit bit 4 (ERROR_PACK) where the same loose object is bit 1 (ERROR_OBJECT);
  // the packed run allows that bit and nothing more, and the loose sample below holds the two runs to one verdict.
  if (r.status === null || (r.status & ~(packed ? 7 : 3)) !== 0) throw new Error(`git fsck failed (exit ${r.status}): ${lines.join(' | ')}`);
  if (r.status !== 0 && !lines.length) throw new Error(`git fsck exit ${r.status} with no output`);
  return { status: r.status, lines };
}

// ---- fixtures every store holds: the objects a cell points at ----
const bin = s => Buffer.from(s, 'latin1');
const CANON = 'A U Thor <a@b.c> 1700000000 +0000';
const CANON2 = 'B Other <b@b.c> 1700000001 +0100';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const BLOB = 'hello\n';
const BLOB_OID = hashObject('blob', bin(BLOB));
const P1_TEXT = `tree ${EMPTY_TREE}\nauthor ${CANON}\ncommitter ${CANON}\n\np1\n`;
const P1 = hashObject('commit', bin(P1_TEXT));
const P2_TEXT = `tree ${EMPTY_TREE}\nauthor ${CANON2}\ncommitter ${CANON2}\n\np2\n`;
const P2 = hashObject('commit', bin(P2_TEXT));
const OTHER_TREE = 'a'.repeat(40);
const FIXTURES = [['tree', ''], ['blob', BLOB], ['commit', P1_TEXT], ['commit', P2_TEXT]];

// ---- axes ----
// ident shape: one fsck_ident rule each, applied to one role (author or committer of a commit, tagger of a tag).
// Strings are latin1 byte strings: \xF6 is the byte 0xF6.
const IDENT = {
  ok: CANON,
  'ok-empty-email': 'A <> 1700000000 +0000',
  'ok-space-name': ' <a@b.c> 1700000000 +0000',
  'ok-ws-before-date': 'A <a@b.c> \t 1700000000 +0000',
  'ok-zero-date': 'A <a@b.c> 0 +0000',
  'ok-max-date': 'A <a@b.c> 9223372036854775807 +0000',
  'ok-tz-unranged': 'A <a@b.c> 1700000000 +9999',
  'ok-tz-negative': 'A <a@b.c> 1700000000 -0730',
  'ok-utf8-name': 'J\xC3\xB6rg <j@b.c> 1700000000 +0000',
  'ok-latin1-name': 'J\xF6rg <j@b.c> 1700000000 +0000',
  'ok-email-spaces': 'A <a b@c d> 1700000000 +0000',
  'missing-name-before-email': '<a@b.c> 1700000000 +0000',
  'bad-name': 'A > B <a@b.c> 1700000000 +0000',
  'bad-name-gt-only': 'A a@b.c> 1700000000 +0000',
  'missing-email': 'A U Thor 1700000000 +0000',
  'missing-space-before-email': 'A<a@b.c> 1700000000 +0000',
  'bad-email-unclosed': 'A <a@b.c 1700000000 +0000',
  'bad-email-second-lt': 'A <a<b@c> 1700000000 +0000',
  'missing-space-before-date': 'A <a@b.c>1700000000 +0000',
  'missing-date': 'A <a@b.c>',
  'bad-date-word': 'A <a@b.c> soon +0000',
  'bad-date-trailing': 'A <a@b.c> 17x +0000',
  'bad-date-empty': 'A <a@b.c> +0000',
  'bad-date-tab-before-tz': 'A <a@b.c> 1700000000\t+0000',
  'bad-date-no-tz': 'A <a@b.c> 1700000000',
  'date-overflow': 'A <a@b.c> 9223372036854775808 +0000',
  'date-overflow-huge': 'A <a@b.c> 99999999999999999999999 +0000',
  'zero-padded-date': 'A <a@b.c> 01700000000 +0000',
  'zero-padded-00': 'A <a@b.c> 00 +0000',
  'bad-tz-short': 'A <a@b.c> 1700000000 +000',
  'bad-tz-long': 'A <a@b.c> 1700000000 +00000',
  'bad-tz-nosign': 'A <a@b.c> 1700000000 0000',
  'bad-tz-nondigit': 'A <a@b.c> 1700000000 +00a0',
  'bad-tz-trailing': 'A <a@b.c> 1700000000 +0000 ',
  'bad-tz-double-space': 'A <a@b.c> 1700000000  +0000',
  'nul-in-ident': 'A\0B <a@b.c> 1700000000 +0000',
};

// body: what follows the headers. `blank: false` appends the text as header lines (no blank line before it).
const BODY = {
  text: { blank: true, text: 'subject\n\nbody\n' },
  none: { blank: false, text: '' },
  empty: { blank: true, text: '' },
  nul: { blank: true, text: 'sub\0ject\n' },
  'non-utf8': { blank: true, text: 'caf\xE9 \xFF\xFE\n' },
  'crlf-body': { blank: true, text: 'subject\r\n\r\nbody\r\n' },
  'missing-blank-word': { blank: false, text: 'subject\n' },
  'missing-blank-text': { blank: false, text: 'hello world\n' },
  'missing-blank-unterminated': { blank: false, text: 'subject' },
};

// line ending: every LF in the object, or every LF turned into CRLF
const EOL = { lf: s => s, crlf: s => s.replace(/\n/g, '\r\n') };

// commit header: the lines fsck_commit reads (tree, parents, author, committer) and what follows them. `a` and `c` are
// the author and committer idents for the cell; the ident axis replaces one of them.
const COMMIT_HEADER = {
  'parents-0': (a, c) => [`tree ${EMPTY_TREE}`, `author ${a}`, `committer ${c}`],
  'parents-1': (a, c) => [`tree ${EMPTY_TREE}`, `parent ${P1}`, `author ${a}`, `committer ${c}`],
  'parents-many': (a, c) => [`tree ${EMPTY_TREE}`, `parent ${P1}`, `parent ${P2}`, `author ${a}`, `committer ${c}`],
  'tree-missing': (a, c) => [`author ${a}`, `committer ${c}`],
  'tree-short': (a, c) => [`tree ${EMPTY_TREE.slice(1)}`, `author ${a}`, `committer ${c}`],
  'tree-upper': (a, c) => [`tree ${EMPTY_TREE.toUpperCase()}`, `author ${a}`, `committer ${c}`],
  'tree-junk': (a, c) => [`tree ${EMPTY_TREE} x`, `author ${a}`, `committer ${c}`],
  'tree-twice': (a, c) => [`tree ${EMPTY_TREE}`, `tree ${EMPTY_TREE}`, `author ${a}`, `committer ${c}`],
  'tree-not-first': (a, c) => [`parent ${P1}`, `tree ${EMPTY_TREE}`, `author ${a}`, `committer ${c}`],
  'parent-bad': (a, c) => [`tree ${EMPTY_TREE}`, `parent ${'z'.repeat(40)}`, `author ${a}`, `committer ${c}`],
  'parent-upper': (a, c) => [`tree ${EMPTY_TREE}`, `parent ${P1.toUpperCase()}`, `author ${a}`, `committer ${c}`],
  'parent-after-author': (a, c) => [`tree ${EMPTY_TREE}`, `author ${a}`, `parent ${P1}`, `committer ${c}`],
  'author-missing': (a, c) => [`tree ${EMPTY_TREE}`, `committer ${c}`],
  'author-twice': (a, c) => [`tree ${EMPTY_TREE}`, `author ${a}`, `author ${CANON2}`, `committer ${c}`],
  'committer-missing': (a) => [`tree ${EMPTY_TREE}`, `author ${a}`],
  'committer-first': (a, c) => [`tree ${EMPTY_TREE}`, `committer ${c}`, `author ${a}`],
  'encoding-before-committer': (a, c) => [`tree ${EMPTY_TREE}`, `author ${a}`, 'encoding UTF-8', `committer ${c}`],
  'unknown-before-author': (a, c) => [`tree ${EMPTY_TREE}`, 'x-foo bar', `author ${a}`, `committer ${c}`],
  encoding: (a, c) => [`tree ${EMPTY_TREE}`, `author ${a}`, `committer ${c}`, 'encoding ISO-8859-1'],
  gpgsig: (a, c) => [`tree ${EMPTY_TREE}`, `author ${a}`, `committer ${c}`, 'gpgsig -----BEGIN PGP SIGNATURE-----', ' abc', ' -----END PGP SIGNATURE-----'],
  mergetag: (a, c) => [`tree ${EMPTY_TREE}`, `parent ${P1}`, `author ${a}`, `committer ${c}`, `mergetag object ${P2}`, ' type commit', ' tag v1', ` tagger ${CANON}`, ' ', ' m'],
  'unknown-after': (a, c) => [`tree ${EMPTY_TREE}`, `author ${a}`, `committer ${c}`, 'x-foo bar'],
  'unknown-nospace': (a, c) => [`tree ${EMPTY_TREE}`, `author ${a}`, `committer ${c}`, 'foo'],
  'orphan-continuation': (a, c) => [`tree ${EMPTY_TREE}`, `author ${a}`, `committer ${c}`, ' orphan'],
  'tree-after-committer': (a, c) => [`tree ${EMPTY_TREE}`, `author ${a}`, `committer ${c}`, `tree ${OTHER_TREE}`],
  'parent-after-committer': (a, c) => [`tree ${EMPTY_TREE}`, `author ${a}`, `committer ${c}`, `parent ${P1}`],
  'author-after-committer': (a, c) => [`tree ${EMPTY_TREE}`, `author ${a}`, `committer ${c}`, `author ${CANON2}`],
  'committer-twice': (a, c) => [`tree ${EMPTY_TREE}`, `author ${a}`, `committer ${c}`, `committer ${CANON2}`],
  'encoding-twice': (a, c) => [`tree ${EMPTY_TREE}`, `author ${a}`, `committer ${c}`, 'encoding ISO-8859-1', 'encoding UTF-8'],
  'encoding-after-gpgsig': (a, c) => [`tree ${EMPTY_TREE}`, `author ${a}`, `committer ${c}`, 'gpgsig x', ' y', 'encoding ISO-8859-1'],
  'garbage-after-committer': (a, c) => [`tree ${EMPTY_TREE}`, `author ${a}`, `committer ${c}`, 'committer garbage'],
  bom: (a, c) => [`\xEF\xBB\xBFtree ${EMPTY_TREE}`, `author ${a}`, `committer ${c}`],
  'empty-object': () => null,
};
const COMMIT_ROLE = ['author', 'committer'];

// tag header: what fsck_tag_standalone reads (object, type, tag, tagger) and what follows
const TAG_HEADER = {
  ok: t => [`object ${P1}`, 'type commit', 'tag v1', `tagger ${t}`],
  'type-blob': t => [`object ${BLOB_OID}`, 'type blob', 'tag v1', `tagger ${t}`],
  'type-tree': t => [`object ${EMPTY_TREE}`, 'type tree', 'tag v1', `tagger ${t}`],
  'object-missing': t => ['type commit', 'tag v1', `tagger ${t}`],
  'object-bad': t => [`object ${'z'.repeat(40)}`, 'type commit', 'tag v1', `tagger ${t}`],
  'object-upper': t => [`object ${P1.toUpperCase()}`, 'type commit', 'tag v1', `tagger ${t}`],
  'type-missing': t => [`object ${P1}`, 'tag v1', `tagger ${t}`],
  'type-bad': t => [`object ${P1}`, 'type commi', 'tag v1', `tagger ${t}`],
  'type-empty': t => [`object ${P1}`, 'type ', 'tag v1', `tagger ${t}`],
  'tag-missing': t => [`object ${P1}`, 'type commit', `tagger ${t}`],
  'tag-name-bad': t => [`object ${P1}`, 'type commit', 'tag v1..2', `tagger ${t}`],
  'tag-name-empty': t => [`object ${P1}`, 'type commit', 'tag ', `tagger ${t}`],
  'tagger-missing': () => [`object ${P1}`, 'type commit', 'tag v1'],
  'tagger-missing-extra': () => [`object ${P1}`, 'type commit', 'tag v1', 'x-foo bar'],
  'tagger-twice': t => [`object ${P1}`, 'type commit', 'tag v1', `tagger ${t}`, `tagger ${CANON2}`],
  'unknown-after': t => [`object ${P1}`, 'type commit', 'tag v1', `tagger ${t}`, 'x-foo bar'],
  'unknown-nospace': t => [`object ${P1}`, 'type commit', 'tag v1', `tagger ${t}`, 'foo'],
  gpgsig: t => [`object ${P1}`, 'type commit', 'tag v1', `tagger ${t}`, 'gpgsig -----BEGIN', ' abc'],
  'type-before-object': t => ['type commit', `object ${P1}`, 'tag v1', `tagger ${t}`],
  bom: t => [`\xEF\xBB\xBFobject ${P1}`, 'type commit', 'tag v1', `tagger ${t}`],
  'empty-object': () => null,
};

function assemble(head, body, eol) {
  if (head === null) return '';
  const b = BODY[body];
  const text = b.blank ? `${head.join('\n')}\n\n${b.text}` : `${head.join('\n')}\n${b.text}`;
  return EOL[eol](text);
}

function* cells() {
  for (const [h, build] of Object.entries(COMMIT_HEADER)) for (const [i, shape] of Object.entries(IDENT))
    for (const role of COMMIT_ROLE) for (const body of Object.keys(BODY)) for (const eol of Object.keys(EOL)) {
      const head = build(role === 'author' ? shape : CANON, role === 'committer' ? shape : CANON);
      yield { type: 'commit', axes: { header: h, ident: i, role, body, eol }, data: bin(assemble(head, body, eol)) };
    }
  for (const [h, build] of Object.entries(TAG_HEADER)) for (const [i, shape] of Object.entries(IDENT))
    for (const body of Object.keys(BODY)) for (const eol of Object.keys(EOL))
      yield { type: 'tag', axes: { header: h, ident: i, role: 'tagger', body, eol }, data: bin(assemble(build(shape), body, eol)) };
}

// A warning git still accepts the object under: what ply does with it, and why.
//   badTagName         accept: the tag header's name is not a ref ply creates; git checks it as a refname only to
//                      warn. Refs ply writes are validated separately (validate.js, `git check-ref-format`).
//   missingTaggerEntry accept: tags older than git 0.99.1 have no tagger (git.git's own v0.99 is one); git reads them.
const WARN_DECISION = { badTagName: 'accept', missingTaggerEntry: 'accept' };

const msgIdOf = line => /^(?:error|warning) in \w+ [0-9a-f]{40}: (\w+):/.exec(line)?.[1] ?? null;
const plyVerdict = (fn) => {
  try { fn(); return { verdict: 'accept', msgId: null }; } catch (e) {
    if (e?.code !== 'pack_corrupt') throw e;
    return { verdict: 'reject', msgId: /^\w+: (\w+):/.exec(e.message)?.[1] ?? e.message };
  }
};

// How the cells reach the store. The full space goes in one pack per shard, framed here with node:zlib (not ply's pack
// writer) and indexed by `git index-pack` without --strict, which judges nothing: git hashes every object from its
// bytes and type, and `git show-index` must list exactly the oids ply computed. Writing each object with `git hash-object
// -t <type> --literally -w` costs about 0.5 ms an object on APFS (a minute for the space), so that literal path runs
// on a fixed sample of every LOOSE_EVERY-th cell (all of them with FSCK_SPACE_LOOSE=1), and the sample's verdicts and
// msgIds must equal the packed run's, object for object.
const LOOSE_EVERY = process.env.FSCK_SPACE_LOOSE ? 1 : 25;
const TYPE_CODE = { commit: 1, tree: 2, blob: 3, tag: 4 };

async function writeLoose(dir, objs) {
  mkdirSync(join(dir, 'in'), { recursive: true });
  for (const type of ['tree', 'blob', 'commit', 'tag']) {
    const mine = objs.filter(o => o.type === type);
    if (!mine.length) continue;
    const paths = mine.map((o, k) => { const p = join(dir, 'in', `${type}-${k}`); writeFileSync(p, o.data); return p; });
    const r = await run('git', ['hash-object', '-t', type, '--literally', '-w', '--stdin-paths'], { cwd: dir, input: paths.join('\n') + '\n' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), mine.map(o => o.oid), `git and ply hash every ${type} alike`);
  }
  rmSync(join(dir, 'in'), { recursive: true, force: true });
}

async function writePack(dir, objs) {
  const parts = [Buffer.from('PACK'), Buffer.from([0, 0, 0, 2]), Buffer.alloc(4)];
  parts[2].writeUInt32BE(objs.length);
  for (const o of objs) {
    let size = o.data.length;
    const head = [(TYPE_CODE[o.type] << 4) | (size & 0x0f)];
    size >>= 4;
    while (size) { head[head.length - 1] |= 0x80; head.push(size & 0x7f); size >>= 7; }
    parts.push(Buffer.from(head), deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  const pack = Buffer.concat([body, createHash('sha1').update(body).digest()]);
  const r = await run('git', ['index-pack', '--stdin'], { cwd: dir, input: pack });
  assert.equal(r.status, 0, r.stderr);
  const idx = join(dir, 'objects', 'pack', `pack-${r.stdout.trim().split(/\s+/).pop()}.idx`);
  const listed = await run('git', ['show-index'], { cwd: dir, input: readFileSync(idx) });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split('\n').map(l => l.split(' ')[1]).sort(), objs.map(o => o.oid).sort(), 'git hashes every object as ply does');
}

// Judge `objs` with git fsck --strict, sharded over stores; returns oid → the fsck lines pinned to it.
async function judge(objs, { loose }) {
  const shards = Math.max(1, Math.min(8, availableParallelism()));
  const root = mkdtempSync(join(tmpdir(), 'ply-fsck-space-'));
  const out = new Map();
  try {
    await Promise.all(Array.from({ length: shards }, async (_, s) => {
      const dir = join(root, `s${s}`);
      const init = await run('git', ['init', '-q', '--bare', dir]);
      assert.equal(init.status, 0, init.stderr);
      const mine = [...FIXTURES.map(([type, text], k) => ({ type, data: bin(text), oid: hashObject(type, bin(text)), fixture: k })), ...objs.filter((_, k) => k % shards === s)];
      if (loose) await writeLoose(dir, mine); else await writePack(dir, mine);
      const { lines } = await fsckLines(dir, { packed: !loose });
      const index = new Map(mine.map(o => [o.oid, o]));
      const got = new Map(mine.map(o => [o.oid, []]));
      for (const l of lines) {
        const owner = [...l.matchAll(/[0-9a-f]{40}/g)].map(m => index.get(m[0])).find(o => o && o.fixture === undefined);
        if (!owner) throw new Error(`fsck line pinned to no cell: ${l}`);
        got.get(owner.oid).push(l);
      }
      for (const o of mine) if (o.fixture !== undefined) { if (got.get(o.oid).length) throw new Error(`fixture ${o.oid} is not fsck-clean: ${got.get(o.oid)}`); } else out.set(o.oid, got.get(o.oid));
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return out;
}

// git's verdict on one object from its lines: any line that is not a `warning in` is an error.
function classify(lines) {
  const errors = lines.filter(l => !l.startsWith('warning in ')).map(l => msgIdOf(l) ?? '');
  const warnings = lines.filter(l => l.startsWith('warning in ')).map(msgIdOf);
  return { verdict: errors.length ? 'error' : warnings.length ? 'warn' : 'ok', errors: errors.filter(Boolean), warnings };
}

test('commit, tag and ident space: ply refuses exactly what git fsck --strict reports an error for', { timeout: 600_000 }, async () => {
  // one cell per distinct object: axes that do not reach the bytes (an ident on a role the header drops) collapse
  const byOid = new Map();
  let product = 0;
  for (const c of cells()) {
    product++;
    const oid = hashObject(c.type, c.data);
    if (!byOid.has(oid)) byOid.set(oid, { ...c, oid, labels: [] });
    byOid.get(oid).labels.push(c.axes);
  }
  const all = [...byOid.values()];
  const packed = await judge(all, { loose: false });
  const sample = all.filter((_, k) => k % LOOSE_EVERY === 0);
  const loose = await judge(sample, { loose: true });
  for (const c of sample) assert.deepEqual(classify(loose.get(c.oid)), classify(packed.get(c.oid)), `loose and packed fsck agree on ${c.oid}`);
  for (const c of all) c.git = packed.get(c.oid);

  const tally = { error: 0, warn: 0, ok: 0 };
  const wrong = [], wrongMsg = [], wrongView = [];
  for (const c of all) {
    const { verdict: gitVerdict, errors, warnings } = classify(c.git);
    tally[gitVerdict]++;
    let expect = gitVerdict === 'error' ? 'reject' : 'accept';
    if (gitVerdict === 'warn') {
      for (const w of warnings) assert.ok(WARN_DECISION[w], `git warns ${w} (${c.git}); decide it in WARN_DECISION`);
      expect = warnings.some(w => WARN_DECISION[w] === 'reject') ? 'reject' : 'accept';
    }
    const gitMsg = errors.find(Boolean) ?? null;
    const ply = plyVerdict(() => assertFetched(c.type, c.data));
    const parsed = plyVerdict(() => (c.type === 'commit' ? parseCommit(c.data) : parseTag(c.data)));
    const view = c.type === 'commit' ? plyVerdict(() => commitView(c.data)) : parsed;
    const row = { oid: c.oid, type: c.type, axes: c.labels[0], git: c.git, ply };
    if (ply.verdict !== expect) wrong.push(row);
    else if (ply.verdict === 'reject' && gitMsg && ply.msgId !== gitMsg) wrongMsg.push({ ...row, gitMsg });
    if (parsed.verdict !== ply.verdict || view.verdict !== ply.verdict) wrongView.push({ ...row, parsed, view });
  }
  const summary = `${product} product cells, loose sample ${sample.length}, ${all.length} distinct objects (commit ${all.filter(c => c.type === 'commit').length}, tag ${all.filter(c => c.type === 'tag').length}); git: ${tally.error} error, ${tally.warn} warning-only, ${tally.ok} clean; ply disagrees on ${wrong.length} verdicts, ${wrongMsg.length} msgIds, ${wrongView.length} read paths`;
  console.log(summary);
  if (process.env.FSCK_SPACE_LIST) for (const w of [...wrong, ...wrongMsg, ...wrongView]) console.log(JSON.stringify(w));
  const show = rows => rows.slice(0, 5).map(r => `${r.type} ${JSON.stringify(r.axes)} git=${r.git.join(' | ') || 'clean'} ply=${r.ply.verdict}${r.ply.msgId ? `:${r.ply.msgId}` : ''}${r.gitMsg ? ` want ${r.gitMsg}` : ''}`).join('\n');
  assert.equal(wrong.length, 0, `verdicts:\n${show(wrong)}`);
  assert.equal(wrongMsg.length, 0, `msgIds:\n${show(wrongMsg)}`);
  assert.equal(wrongView.length, 0, `parseCommit/parseTag/commitView disagree with assertFetched:\n${show(wrongView)}`);
});
