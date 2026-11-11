// commitChanges over directories that share one tree oid (template, locale and package-copy directories). The
// in-memory tree must hold one mutable node per PATH: a node shared per oid applies a change under every twin.
// Judge: git. The same change list is applied in a clone with git add / git rm / git mv, and `git ls-tree -r` of
// ply's pushed commit must equal git's byte for byte, on three receive-pack configurations a host may run:
//   strict-unpack : receive.fsckObjects=true, small push -> unpack-objects --strict (the suite's default bare repo)
//   index-pack    : receive.fsckObjects=true, receive.unpackLimit=1 -> index-pack --strict
//   no-fsck       : receive.fsckObjects=false (git's own default), where a wrong tree is accepted silently
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { cpSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { git, tmpRoot, makeBareRepo, startGitServer, fsckProblems, noMaintenance } from './server.js';
import { commitChanges } from '../src/changes.js';
import { Tracer } from '../src/otel.js';

const AUTHOR = { name: 'Ada', email: 'ada@x', tz: '+0000', time: 1700000000 };
const CONFIGS = [
  ['strict-unpack', []],
  ['index-pack', [['receive.unpackLimit', '1']]],
  ['no-fsck', [['receive.fsckObjects', 'false'], ['transfer.fsckObjects', 'false']]],
];
// a/, b/, c/ and n/a/ are one tree oid; so are their sub/ directories (twins inside twins), at two depths.
const TWINS = ['a', 'b', 'c', 'n/a'];
const LISTS = {
  'write under one twin': [{ kind: 'write', path: 'a/only-in-a.txt', content: 'A\n' }],
  'write different files under two twins': [
    { kind: 'write', path: 'a/only-in-a.txt', content: 'A\n' }, { kind: 'write', path: 'b/only-in-b.txt', content: 'B\n' },
  ],
  'write different files under three twins': [
    { kind: 'write', path: 'a/1.txt', content: '1\n' }, { kind: 'write', path: 'b/2.txt', content: '2\n' }, { kind: 'write', path: 'c/3.txt', content: '3\n' },
  ],
  'overwrite one file under one twin': [{ kind: 'write', path: 'b/config.json', content: '{"b":1}\n' }],
  'delete under one twin': [{ kind: 'delete', path: 'a/config.json' }],
  'delete under one twin, write under another': [{ kind: 'delete', path: 'a/README.md' }, { kind: 'write', path: 'b/z.txt', content: 'z\n' }],
  'rename between twins': [{ kind: 'rename', from: 'a/README.md', to: 'b/moved.md' }],
  'rename inside one twin': [{ kind: 'rename', from: 'c/config.json', to: 'c/settings.json' }],
  'nested twins: write in one, delete in another': [
    { kind: 'write', path: 'a/sub/new.txt', content: 'new\n' }, { kind: 'delete', path: 'n/a/sub/leaf.txt' },
  ],
  'nested twin at another depth': [{ kind: 'write', path: 'n/a/only-nested.txt', content: 'N\n' }, { kind: 'delete', path: 'c/sub/leaf.txt' }],
  // the two rebuilt directories are again one tree: the pack must carry that new tree once
  'the same new file under two twins': [
    { kind: 'write', path: 'a/same.txt', content: 'same\n' }, { kind: 'write', path: 'b/same.txt', content: 'same\n' },
  ],
  'edit under one twin, create under another': [
    { kind: 'edit', path: 'a/README.md', find: 'template', replace: 'edited' }, { kind: 'create', path: 'c/x.txt', content: 'x\n' },
  ],
  'delete a whole twin, then write into the next': [
    { kind: 'delete', path: 'a/README.md' }, { kind: 'delete', path: 'a/config.json' }, { kind: 'delete', path: 'a/sub/leaf.txt' },
    { kind: 'write', path: 'b/sub/kept.txt', content: 'k\n' },
  ],
};

let root, cleanup, srv, seed, n = 0;
const templates = new Map();

before(async () => {
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  seed = join(root, 'seed');
  git(root, ['-c', 'core.autocrlf=false', 'init', '-q', '-b', 'main', seed]); noMaintenance(seed);
  for (const [k, v] of [['user.name', 's'], ['user.email', 's@x'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(seed, ['config', k, v]);
  for (const d of TWINS) {
    mkdirSync(join(seed, d, 'sub'), { recursive: true });
    writeFileSync(join(seed, d, 'README.md'), 'template\n');
    writeFileSync(join(seed, d, 'config.json'), '{}\n');
    writeFileSync(join(seed, d, 'sub', 'leaf.txt'), 'leaf\n');
  }
  writeFileSync(join(seed, 'run.sh'), '#!/bin/sh\n');
  chmodSync(join(seed, 'run.sh'), 0o755);
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'seed']);
  // the fixture is what the test is about: the twins are one tree oid, by git's own hashing
  const oids = new Set(TWINS.map(d => git(seed, ['rev-parse', `HEAD:${d}`]).trim()));
  assert.equal(oids.size, 1);
  for (const [name, cfg] of CONFIGS) {
    const bare = makeBareRepo(root, `tpl-${name}`);
    for (const [k, v] of cfg) git(bare, ['config', k, v]);
    git(seed, ['push', '-q', bare, 'main']);
    templates.set(name, bare);
  }
});
after(async () => { await srv.close(); cleanup(); });

// The same list by git's own commands in a clone of the seed: the oracle's `ls-tree -r`.
function byGit(changes) {
  const work = join(root, `g${n++}`);
  cpSync(seed, work, { recursive: true });
  for (const c of changes) {
    if (c.kind === 'write' || c.kind === 'create') {
      mkdirSync(dirname(join(work, c.path)), { recursive: true });
      writeFileSync(join(work, c.path), c.content);
      git(work, ['add', '--', c.path]);
    } else if (c.kind === 'edit') {
      // git has no find/replace: the expected bytes are written out here ('template\n' with the one match replaced)
      writeFileSync(join(work, c.path), 'edited\n');
      git(work, ['add', '--', c.path]);
    } else if (c.kind === 'delete') git(work, ['rm', '-q', '--', c.path]);
    else git(work, ['mv', c.from, c.to]);
  }
  git(work, ['commit', '-q', '-m', 'by git']);
  return git(work, ['ls-tree', '-r', 'HEAD']);
}

for (const [label, changes] of Object.entries(LISTS)) {
  for (const [config] of CONFIGS) {
    test(`twin directories: ${label} [${config}]`, async () => {
      const name = `t${n++}`;
      const bare = join(root, `${name}.git`);
      cpSync(templates.get(config), bare, { recursive: true });
      const want = byGit(changes);
      const r = await commitChanges(`${srv.url}/${name}.git`, { ref: 'refs/heads/main', author: AUTHOR, message: label, changes }, { tracer: new Tracer() });
      assert.equal(r.ok ? `ok ${r.value.outcome}` : `${r.error.code}: ${r.error.message}`, 'ok commit');
      assert.equal(git(bare, ['ls-tree', '-r', 'refs/heads/main']), want);
      assert.deepEqual(fsckProblems(bare), []);
    });
  }
}

// Rewriting a file's content does not change its mode in git: `git add` of new bytes over run.sh (100755) keeps
// 100755. A `write` with no mode does the same; an explicit mode wins; a path with no regular file there is 100644.
test('write with no mode keeps the mode of the regular file it replaces, as git add does', async () => {
  const name = `t${n++}`;
  const bare = join(root, `${name}.git`);
  cpSync(templates.get('strict-unpack'), bare, { recursive: true });
  const work = join(root, `g${n++}`);
  cpSync(seed, work, { recursive: true });
  writeFileSync(join(work, 'run.sh'), '#!/bin/sh\necho hi\n');
  writeFileSync(join(work, 'a/README.md'), 'plain\n');
  writeFileSync(join(work, 'new.sh'), 'new\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'by git']);
  const want = git(work, ['ls-tree', '-r', 'HEAD']);
  assert.match(want, /^100755 blob [0-9a-f]{40}\trun\.sh$/mu);
  const changes = [
    { kind: 'write', path: 'run.sh', content: '#!/bin/sh\necho hi\n' },
    { kind: 'write', path: 'a/README.md', content: 'plain\n' },
    { kind: 'write', path: 'new.sh', content: 'new\n' },
  ];
  const r = await commitChanges(`${srv.url}/${name}.git`, { ref: 'refs/heads/main', author: AUTHOR, message: 'modes', changes }, { tracer: new Tracer() });
  assert.equal(r.ok ? `ok ${r.value.outcome}` : `${r.error.code}: ${r.error.message}`, 'ok commit');
  assert.equal(git(bare, ['ls-tree', '-r', 'refs/heads/main']), want);
  // an explicit mode always wins: by hand, run.sh becomes 100644 and a/config.json 100755
  const again = await commitChanges(`${srv.url}/${name}.git`, {
    ref: 'refs/heads/main', author: AUTHOR, message: 'explicit',
    changes: [{ kind: 'write', path: 'run.sh', content: 'x\n', mode: '100644' }, { kind: 'write', path: 'a/config.json', content: '{}\n', mode: '100755' }],
  }, { tracer: new Tracer() });
  assert.equal(again.ok, true);
  assert.equal(git(bare, ['ls-tree', 'refs/heads/main', 'run.sh']).slice(0, 6), '100644');
  assert.equal(git(bare, ['ls-tree', 'refs/heads/main', 'a/config.json']).slice(0, 6), '100755');
});
