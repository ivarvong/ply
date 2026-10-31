// git is first-wins for a second `tree` and still fsck-clean, so a last-wins parser reads a different tree than
// `git log --format=%T`. These objects are the ones a red-team audit used. ply rejects them on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { te } from '../src/bytes.js';
import { parseCommit, parseTag, parseTree, encodeCommit, ident } from '../src/objects.js';
import { validateIdent } from '../src/validate.js';
import { fsck, fsckProblemsOf } from './server.js';

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
  const r = git(dir, ['hash-object', '-t', type, '-w', '--stdin', '--literally'], text);
  assert.equal(r.code, 0, r.err);
  return r.out.trim();
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
    assert.deepEqual(fsckProblemsOf(dir, oid), []);
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
    assert.deepEqual(fsckProblemsOf(dir, encOid), []);
    const encLog = git(dir, ['log', '-1', '--no-walk', '--format=%e', encOid]);
    assert.equal(encLog.out.trim(), 'ISO-8859-1');
    assert.throws(() => parseCommit(te.encode(enc)), e => e.code === 'pack_corrupt' && e.message === 'commit: duplicate encoding');

    const com = `tree ${empty}\nauthor ${author}\ncommitter ${author}\ncommitter ${other}\n\nmsg\n`;
    const comOid = literally(dir, 'commit', com);
    assert.deepEqual(fsckProblemsOf(dir, comOid), []);
    const comLog = git(dir, ['log', '-1', '--no-walk', '--format=%cn', comOid]);
    assert.equal(comLog.out.trim(), 'B');
    assert.throws(() => parseCommit(te.encode(com)), e => e.code === 'pack_corrupt' && e.message === 'commit: duplicate committer');

    const parent = 'b'.repeat(40);
    const late = `tree ${empty}\nauthor ${author}\ncommitter ${author}\nparent ${parent}\n\nmsg\n`;
    const lateOid = literally(dir, 'commit', late);
    assert.deepEqual(fsckProblemsOf(dir, lateOid), []);
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
    assert.deepEqual(fsckProblemsOf(dir, tagOid), []);
    const shown = git(dir, ['for-each-ref', '--format=%(tagger)', 'refs/tags/v1']);
    assert.equal(shown.out.trim(), author);
    assert.throws(() => parseTag(te.encode(tag)), e => e.code === 'pack_corrupt' && e.message === 'tag: duplicate tagger');
  });
});

// ---- issue #34: one name twice in a tree, every cell of the product, against `git fsck --strict` ----
// Axes (tagged unions; the test takes their product and runs every cell):
//   relation  equal (`d`,`d`) | slash-prefix (`d`,`d.x`: which sorts first depends on whether `d` is a directory) |
//             case-only (`d`,`D`) | nfc-nfd (`é` as U+00E9 and as e + U+0301) | decode-twin (`d\xff`,`d\xfe`: distinct
//             bytes, one decoded string)
//   modes     blob | exec | symlink | tree | gitlink, for each of the two entries (25)
//   position  adjacent | separated (a blob whose key sorts strictly between the two keys, when one exists)
//   order     sorted (git's order, ties keep the first) | unsorted (that list reversed)
// Expected (git's rules, fsck.c verify_ordered; checked against fsck below, cell by cell): fsck errors iff the two names
// are the same bytes (duplicateEntries) or the list is out of order (treeNotSorted). ply accepts iff fsck is silent,
// with one documented exception: a sorted decode-twin, which git accepts and ply refuses because its callers look
// entries up by decoded name. When ply refuses, its message is one fsck printed for that tree.
const MODES = [['blob', '100644'], ['exec', '100755'], ['symlink', '120000'], ['tree', '40000'], ['gitlink', '160000']];
const RELATIONS = [
  ['equal', Buffer.from('d'), Buffer.from('d')],
  ['slash-prefix', Buffer.from('d'), Buffer.from('d.x')],
  ['case-only', Buffer.from('d'), Buffer.from('D')],
  ['nfc-nfd', Buffer.from('é'), Buffer.from('é')],
  ['decode-twin', Buffer.from([0x64, 0xff]), Buffer.from([0x64, 0xfe])],
];
const POSITIONS = ['adjacent', 'separated'];
const ORDERS = ['sorted', 'unsorted'];

const gitRaw = (dir, args, input) => {
  const r = spawnSync('git', ['-C', dir, ...args], { input, env });
  assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
  return r.stdout.toString().trim();
};
const sortKey34 = (name, mode) => (mode === '40000' ? Buffer.concat([name, Buffer.from('/')]) : name);
const between = (lo, hi) => {
  const [a, b] = Buffer.compare(lo.key, hi.key) <= 0 ? [lo, hi] : [hi, lo];
  for (const n of [a.name, b.name]) {
    const bumped = Buffer.from(n); bumped[bumped.length - 1]++;
    for (const m of [Buffer.concat([n, Buffer.from('!')]), Buffer.concat([n, Buffer.from('.')]), bumped]) {
      // a third name: `d\xfe` bumped is `d\xff`, which would make the middle entry a duplicate of its own
      if (!m.equals(a.name) && !m.equals(b.name) && Buffer.compare(a.key, m) < 0 && Buffer.compare(m, b.key) < 0) return m;
    }
  }
  return null;
};

export function cells34() {
  const out = [];
  for (const [relation, nameA, nameB] of RELATIONS) for (const [ma, modeA] of MODES) for (const [mb, modeB] of MODES) for (const position of POSITIONS) for (const order of ORDERS) {
    const A = { name: nameA, mode: modeA, key: sortKey34(nameA, modeA) }, B = { name: nameB, mode: modeB, key: sortKey34(nameB, modeB) };
    let list = [A, B];
    let realized = position;
    if (position === 'separated') {
      const m = between(A, B);
      // no name sorts strictly between two equal keys: the cell exists, the middle entry sorts outside them
      if (m === null) realized = 'separated-unrealizable';
      list.push({ name: m ?? Buffer.concat([nameA, Buffer.from('!')]), mode: '100644', key: m ?? Buffer.concat([nameA, Buffer.from('!')]), middle: true });
    }
    list = list.map((e, i) => ({ e, i })).sort((x, y) => Buffer.compare(x.e.key, y.e.key) || x.i - y.i).map(x => x.e);
    if (order === 'unsorted') list.reverse();
    const sameBytes = nameA.equals(nameB);
    const unsorted = list.some((e, i) => i > 0 && Buffer.compare(list[i - 1].key, e.key) > 0);
    out.push({ id: `${relation}/${ma}+${mb}/${position}/${order}`, relation, modes: [ma, mb], position, realized, order, list, expectGitRejects: sameBytes || unsorted });
  }
  return out;
}

export function plyVerdict34(bytes) {
  try { parseTree(new Uint8Array(bytes)); return 'accept'; } catch (e) {
    assert.equal(e.code, 'pack_corrupt', e.message);
    if (e.message.startsWith('tree: duplicate entry ')) return 'duplicateEntries';
    if (e.message === 'tree: not strictly sorted') return 'treeNotSorted';
    if (e.message.startsWith('tree: two entries decode to the name ')) return 'ply:decodeTwin';
    return `other:${e.message}`;
  }
}

test('#34 parseTree on every cell of relation × mode × mode × position × order agrees with git fsck --strict', () => {
  withRepo(dir => {
    const blob = gitRaw(dir, ['hash-object', '-w', '--stdin'], Buffer.from('x\n'));
    const link = gitRaw(dir, ['hash-object', '-w', '--stdin'], Buffer.from('target'));
    const sub = gitRaw(dir, ['mktree'], Buffer.from(`100644 blob ${blob}\tf\n`));
    const gitlink = 'c0ffee'.padEnd(40, '0');
    const oidFor = mode => ({ '100644': blob, '100755': blob, '120000': link, '40000': sub, '160000': gitlink })[mode];
    const cells = cells34();
    assert.equal(cells.length, RELATIONS.length * MODES.length ** 2 * POSITIONS.length * ORDERS.length);
    for (const c of cells) {
      c.bytes = Buffer.concat(c.list.flatMap(e => [Buffer.from(`${e.mode} `), e.name, Buffer.from([0]), Buffer.from(oidFor(e.mode), 'hex')]));
      c.oid = gitRaw(dir, ['hash-object', '-t', 'tree', '-w', '--stdin', '--literally'], c.bytes);
    }
    const fsckOut = fsck(dir, ['--no-dangling']);
    const fsckOf = new Map();
    for (const line of fsckOut.lines) {
      const m = /^error in tree ([0-9a-f]{40}): (\w+):/.exec(line);
      if (m) { if (!fsckOf.has(m[1])) fsckOf.set(m[1], new Set()); fsckOf.get(m[1]).add(m[2]); }
    }
    const tally = new Map();
    const bad = [];
    for (const c of cells) {
      const ids = fsckOf.get(c.oid) ?? new Set();
      const ply = plyVerdict34(c.bytes);
      const gitRejects = ids.size > 0;
      if (gitRejects !== c.expectGitRejects) bad.push(`${c.id}: model says git ${c.expectGitRejects ? 'rejects' : 'accepts'}, fsck: [${[...ids]}]`);
      for (const id of ids) if (id !== 'duplicateEntries' && id !== 'treeNotSorted') bad.push(`${c.id}: unexpected fsck ${id}`);
      const exception = c.relation === 'decode-twin' && !gitRejects;
      if (exception ? ply !== 'ply:decodeTwin' : gitRejects ? !ids.has(ply) : ply !== 'accept') bad.push(`${c.id}: fsck [${[...ids]}], ply ${ply}`);
      const k = `${c.relation} ${gitRejects ? [...ids].sort().join('+') : 'clean'} -> ${ply}`;
      tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    console.log(`  #34 cells: ${cells.length}, separated-unrealizable: ${cells.filter(c => c.realized === 'separated-unrealizable').length}`);
    for (const [k, n] of [...tally].sort()) console.log(`  #34 ${k}: ${n}`);
    assert.deepEqual(bad, []);
  });
});
