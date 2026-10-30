// git is first-wins for a second `tree` and still fsck-clean, so a last-wins parser reads a different tree than
// `git log --format=%T`. These objects are the ones a red-team audit used. ply rejects them on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { te, concat } from '../src/bytes.js';
import { parseCommit, parseTag, parseTree, encodeCommit, ident } from '../src/objects.js';
import { validateIdent } from '../src/validate.js';
import { genHostileTree, HOSTILE_TREE_NAMES, HOSTILE_TREE_MODES } from './fuzz/gen.js';
import { Rng } from './fuzz/prng.js';

const env = {
  ...process.env,
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false',
  GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'C', GIT_COMMITTER_EMAIL: 'c@b.c',
};
const author = ident(validateIdent({ name: 'A', email: 'a@b.c', time: 1700000000 }));
const other = ident(validateIdent({ name: 'B', email: 'b@b.c', time: 1700000001 }));

function git(dir, args, input) {
  const r = spawnSync('git', ['-C', dir, ...args], { input, encoding: 'utf8', env });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}`, err: `${r.stderr ?? ''}` };
}

function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ply-diff-'));
  try {
    const init = git(dir, ['init', '-q', '-b', 'main']);
    assert.equal(init.code, 0, init.err);
    const empty = git(dir, ['hash-object', '-t', 'tree', '-w', '--stdin'], '');
    assert.equal(empty.code, 0, empty.err);
    return fn(dir, empty.out.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function literally(dir, type, text) {
  const r = spawnSync('git', ['-C', dir, 'hash-object', '-t', type, '-w', '--stdin', '--literally'], { input: text, env });
  assert.equal(r.status, 0, `${r.stderr}`);
  return `${r.stdout}`.trim();
}

function fsckErrors(dir, oid) {
  const r = git(dir, ['fsck', '--strict']);
  return r.err.split('\n').map(l => l.trim()).filter(l => l.startsWith('error:') && l.includes(oid));
}

test('a second tree header is fsck-clean and git shows the first; ply rejects it', () => {
  withRepo((dir, empty) => {
    const otherTree = 'a'.repeat(40);
    const text = `tree ${empty}\nauthor ${author}\ncommitter ${author}\ntree ${otherTree}\n\nmsg\n`;
    const oid = literally(dir, 'commit', text);
    const raw = git(dir, ['cat-file', '-p', oid]);
    assert.equal(raw.code, 0);
    assert.ok(raw.out.includes(`tree ${empty}`));
    assert.ok(raw.out.includes(`tree ${otherTree}`));
    assert.deepEqual(fsckErrors(dir, oid), []);
    const shown = git(dir, ['log', '-1', '--no-walk', '--format=%T', oid]);
    assert.equal(shown.code, 0, shown.err);
    assert.equal(shown.out.trim(), empty);
    assert.throws(() => parseCommit(te.encode(text)), e => e.code === 'pack_corrupt' && e.message === 'commit: duplicate tree');
  });
});

test('duplicate encoding, duplicate committer, and a parent after committer', () => {
  withRepo((dir, empty) => {
    const enc = `tree ${empty}\nauthor ${author}\ncommitter ${author}\nencoding ISO-8859-1\nencoding UTF-8\n\nmsg\n`;
    const encOid = literally(dir, 'commit', enc);
    assert.deepEqual(fsckErrors(dir, encOid), []);
    const encLog = git(dir, ['log', '-1', '--no-walk', '--format=%e', encOid]);
    assert.equal(encLog.out.trim(), 'ISO-8859-1');
    assert.throws(() => parseCommit(te.encode(enc)), e => e.code === 'pack_corrupt' && e.message === 'commit: duplicate encoding');

    const com = `tree ${empty}\nauthor ${author}\ncommitter ${author}\ncommitter ${other}\n\nmsg\n`;
    const comOid = literally(dir, 'commit', com);
    assert.deepEqual(fsckErrors(dir, comOid), []);
    const comLog = git(dir, ['log', '-1', '--no-walk', '--format=%cn', comOid]);
    assert.equal(comLog.out.trim(), 'B');
    assert.throws(() => parseCommit(te.encode(com)), e => e.code === 'pack_corrupt' && e.message === 'commit: duplicate committer');

    const parent = 'b'.repeat(40);
    const late = `tree ${empty}\nauthor ${author}\ncommitter ${author}\nparent ${parent}\n\nmsg\n`;
    const lateOid = literally(dir, 'commit', late);
    assert.deepEqual(fsckErrors(dir, lateOid), []);
    const parents = git(dir, ['log', '-1', '--no-walk', '--format=%P', lateOid]);
    assert.equal(parents.out.trim(), '');
    assert.throws(() => parseCommit(te.encode(late)), e => e.code === 'pack_corrupt' && e.message === 'commit: bad header order');
  });
});

test('a commit git writes round-trips, and a duplicate tagger is fsck-clean first-wins', () => {
  withRepo((dir, empty) => {
    const text = `tree ${empty}\nparent ${'c'.repeat(40)}\nauthor ${author}\ncommitter ${other}\nencoding UTF-8\n\nmsg\n`;
    const oid = literally(dir, 'commit', text);
    const log = git(dir, ['log', '-1', '--no-walk', '--date=raw', '--format=%T%x00%P%x00%an <%ae> %ad%x00%cn <%ce> %cd%x00%e', oid]);
    assert.equal(log.code, 0, log.err);
    const [tree, parents, who, committer, encoding] = log.out.trim().split('\0');
    const c = parseCommit(te.encode(text));
    assert.equal(c.tree, tree);
    assert.equal(c.parents.join(' '), parents);
    assert.equal(c.author, who);
    assert.equal(c.committer, committer);
    assert.equal(c.encoding, encoding);
    assert.deepEqual([...encodeCommit(c)], [...te.encode(text)]);

    const tag = `object ${oid}\ntype commit\ntag v1\ntagger ${author}\ntagger ${other}\n\nrel\n`;
    const tagOid = literally(dir, 'tag', tag);
    assert.equal(git(dir, ['update-ref', 'refs/tags/v1', tagOid]).code, 0);
    assert.deepEqual(fsckErrors(dir, tagOid), []);
    const shown = git(dir, ['for-each-ref', '--format=%(tagger)', 'refs/tags/v1']);
    assert.equal(shown.out.trim(), author);
    assert.throws(() => parseTag(te.encode(tag)), e => e.code === 'pack_corrupt' && e.message === 'tag: duplicate tagger');
  });
});

// ---- trees: parseTree accepts a tree exactly when `git fsck --strict` has nothing to say about it (issue #34) ----
// fsck's verdict per tree object: [] when silent, else the (severity, msgId) pairs it printed for that oid. Under --strict
// every WARN-class message is promoted to an error; the INFO class (badFilemode, the three dotfile-symlink infos) is
// still printed as `warning` and leaves the exit code at 0. ply treats both as a rejection: the oracle is "fsck is
// silent", which is also what compliance.test.js's fsckOf asks.
function fsckTreeVerdicts(dir) {
  const r = git(dir, ['fsck', '--strict', '--no-dangling']);
  const verdicts = new Map();
  for (const line of r.err.split('\n')) {
    const m = /^(error|warning) in tree ([0-9a-f]{40}): (\w+): /.exec(line.trim());
    if (m) (verdicts.get(m[2]) ?? verdicts.set(m[2], []).get(m[2])).push({ severity: m[1], id: m[3] });
  }
  return verdicts;
}
// fsck keeps a tree entry's mode in an `unsigned short`: a mode text over 16 bits (`240000`, `1100644`) truncates to a
// legal mode there and the tree passes. ply refuses any mode that is not one of the five git writes. That is the one
// place ply rejects what fsck passes, and the test allows it only when such a mode is present.
const overflowMode = mode => /^[0-7]+$/.test(mode) && BigInt(`0o${mode}`) > 0xffffn;
const FSCK_INFO_CLASS = new Set(['badFilemode', 'gitattributesSymlink', 'gitignoreSymlink', 'mailmapSymlink']);
const FSCK_ERROR_CLASS = new Set(['badTree', 'duplicateEntries', 'treeNotSorted', 'fullPathname', 'hasDot', 'hasDotdot', 'hasDotgit', 'zeroPaddedFilemode', 'nullSha1', 'gitmodulesSymlink', 'largePathname']);

test('parseTree accepts a tree iff git fsck --strict is silent on it: curated shapes and random hostile trees', { timeout: 120_000 }, () => {
  withRepo((dir, empty) => {
    const blobs = ['x', 'y\n'].map(s => literally(dir, 'blob', s));
    const oidBytes = hex => Uint8Array.from(hex.match(/../g).map(h => parseInt(h, 16)));
    const fixture = literally(dir, 'tree', Buffer.from(concat([te.encode('100644 sub-fixture\0'), oidBytes(blobs[0])])));
    const commit = literally(dir, 'commit', `tree ${empty}\nauthor ${author}\ncommitter ${author}\n\nm\n`);
    const oids = { blob: blobs, tree: fixture, commit };
    const ent = (mode, name, oid = mode === '40000' ? fixture : mode === '160000' ? commit : blobs[0]) => concat([te.encode(`${mode} `), typeof name === 'string' ? te.encode(name) : Uint8Array.from(name), Uint8Array.of(0), oidBytes(oid)]);
    const curated = [
      ['issue #34: file d, d.x, directory d', concat([ent('100644', 'd'), ent('100644', 'd.x'), ent('40000', 'd')])],
      ['file d, directory d adjacent', concat([ent('100644', 'd'), ent('40000', 'd')])],
      ['directory d then file d', concat([ent('40000', 'd'), ent('100644', 'd')])],
      ['blob a twice', concat([ent('100644', 'a'), ent('100644', 'a', blobs[1])])],
      ['tree a twice', concat([ent('40000', 'a'), ent('40000', 'a')])],
      ['link a, blob a', concat([ent('100644', 'a'), ent('120000', 'a')])],
      ['candidate stack: d, d.x, d.x/, d/', concat([ent('100644', 'd'), ent('100644', 'd.x'), ent('40000', 'd.x'), ent('40000', 'd')])],
      ['case twins A, a', concat([ent('100644', 'A'), ent('100644', 'a')])],
      ['case twins README (dir), readme', concat([ent('40000', 'README'), ent('100644', 'readme')])],
      ['d.x then d/ is sorted', concat([ent('100644', 'd.x'), ent('40000', 'd')])],
      ['d- then d/ then d0 is sorted', concat([ent('100644', 'd-'), ent('40000', 'd'), ent('100644', 'd0')])],
      ['d/ then d- is unsorted', concat([ent('40000', 'd'), ent('100644', 'd-')])],
      ['d0 then d/ is unsorted', concat([ent('100644', 'd0'), ent('40000', 'd')])],
      ['empty tree', new Uint8Array(0)],
      ['mode 0', ent('0', 'a')],
      ['null oid', ent('100644', 'a', '0'.repeat(40))],
      ['null oid on a directory', ent('40000', 'a', '0'.repeat(40))],
      ['.gitmodules as a blob', ent('100644', '.gitmodules')],
      ['.gitmodules as a directory', ent('40000', '.gitmodules')],
      ['name of 4096 bytes', ent('100644', 'a'.repeat(4096))],
      ['name of 4097 bytes', ent('100644', 'a'.repeat(4097))],
      ...Object.entries(HOSTILE_TREE_NAMES).flatMap(([pool, names]) => names.filter(n => typeof n !== 'string' || !/[/\0]/.test(n)).flatMap(name => [[`${pool} ${JSON.stringify(name).slice(0, 40)} as a blob`, ent('100644', name)], [`${pool} ${JSON.stringify(name).slice(0, 40)} as a symlink`, ent('120000', name)]])),
      ...Object.entries(HOSTILE_TREE_MODES).flatMap(([pool, modes]) => modes.map(mode => [`${pool} mode ${JSON.stringify(mode)}`, ent(mode, 'a', mode === '40000' ? fixture : mode === '160000' ? commit : blobs[0])])),
    ];
    const N = parseInt(process.env.TREE_CASES ?? '400', 10), SEED = parseInt(process.env.TREE_SEED ?? '34', 10);
    const rng = new Rng(SEED);
    const random = Array.from({ length: N }, () => { const t = genHostileTree(rng, oids); return [t.note, t.bytes]; });
    const cases = new Map();
    for (const [note, bytes] of [...curated, ...random]) {
      const oid = literally(dir, 'tree', Buffer.from(bytes));
      if (!cases.has(oid)) cases.set(oid, { note, bytes });
    }
    const verdicts = fsckTreeVerdicts(dir);
    const disagree = [], seen = { error: new Set(), warning: new Set() };
    let accepted = 0, rejected = 0, overflow = 0;
    for (const [oid, { note, bytes }] of cases) {
      const fsck = verdicts.get(oid) ?? [];
      for (const v of fsck) seen[v.severity].add(v.id);
      let ply = 'accept', code = null, message = null;
      try { parseTree(bytes); } catch (e) { ply = 'reject'; code = e.code; message = e.message; }
      if (ply === 'reject' && code !== 'pack_corrupt' && code !== 'limit_exceeded') disagree.push({ note, oid, ply: `untyped ${code}: ${message}` });
      else if (ply === 'accept' && fsck.length) disagree.push({ note, oid, ply, fsck });
      else if (ply === 'reject' && !fsck.length) {
        const modes = [];
        for (let p = 0; p < bytes.length;) { const sp = bytes.indexOf(0x20, p), nul = bytes.indexOf(0, sp); modes.push(Buffer.from(bytes.subarray(p, sp)).toString()); p = nul + 1 + 20; }
        if (message === 'tree: bad mode' && modes.some(overflowMode)) overflow++;
        else disagree.push({ note, oid, ply: `${code}: ${message}`, fsck: 'silent', modes });
      }
      if (ply === 'accept') accepted++; else rejected++;
    }
    assert.deepEqual(disagree, [], `${disagree.length}/${cases.size} disagreements with git fsck --strict`);
    // which fsck tree messages are errors and which stay warnings under --strict
    assert.deepEqual([...seen.warning].sort(), [...FSCK_INFO_CLASS].sort(), 'the INFO class is the only one fsck --strict prints as a warning');
    assert.deepEqual([...seen.error].sort(), [...FSCK_ERROR_CLASS].sort(), 'every WARN-class and ERROR-class tree message was exercised and printed as an error');
    // the issue's tree and the case twins, by name
    const issue = literally(dir, 'tree', Buffer.from(curated[0][1]));
    assert.deepEqual(verdicts.get(issue), [{ severity: 'error', id: 'duplicateEntries' }]);
    assert.throws(() => parseTree(curated[0][1]), e => e.code === 'pack_corrupt' && e.message === 'tree: duplicate entry "d"');
    const twins = literally(dir, 'tree', Buffer.from(curated[7][1]));
    assert.equal(verdicts.get(twins), undefined);
    assert.deepEqual(parseTree(curated[7][1]).map(e => e.name), ['A', 'a']);
    console.log(`  trees: ${cases.size} distinct objects (${curated.length} curated, ${N} random, seed ${SEED}): ${accepted} accepted by both, ${rejected} rejected by ply of which ${overflow} passed fsck only through its 16-bit mode truncation; errors ${[...seen.error].sort().join(' ')}; warnings ${[...seen.warning].sort().join(' ')}`);
  });
});
