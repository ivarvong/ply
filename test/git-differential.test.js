// git is first-wins for a second `tree` and still fsck-clean, so a last-wins parser reads a different tree than
// `git log --format=%T`. These objects are the ones a red-team audit used. ply rejects them on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { te } from '../src/bytes.js';
import { parseCommit, parseTag, encodeCommit, ident } from '../src/objects.js';

const env = {
  ...process.env,
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false',
  GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'C', GIT_COMMITTER_EMAIL: 'c@b.c',
};
const author = ident({ name: 'A', email: 'a@b.c', time: '1700000000' });
const other = ident({ name: 'B', email: 'b@b.c', time: '1700000001' });

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
  const r = git(dir, ['hash-object', '-t', type, '-w', '--stdin', '--literally'], text);
  assert.equal(r.code, 0, r.err);
  return r.out.trim();
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
