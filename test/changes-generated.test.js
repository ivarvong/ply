// commitChanges against git, over generated repositories and generated change lists.
//
// Repository: one generated template directory planted at sibling and nested paths (one tree oid at several paths), its
// `sub/` directory planted again elsewhere (twins inside twins), plus a few files of their own. Asserted by git's own
// hashing before any case runs.
// Change list: write, create, edit, delete, rename, mode change, delete and rename of whole directories, across and
// inside the twins; names and contents come from small pools so the same new file often lands under two twins (the
// two rebuilt directories are then one new tree, which a pack must carry once). A third of the lists hold one change:
// that is commitChanges' streamed path.
// Oracle: the same list applied with git add / git rm / git mv in a copy of the seed work tree, then
// `git ls-tree -r -t` of git's commit against `git ls-tree -r -t` of the ref ply pushed, byte for byte; the outcome
// (commit or noop) is predicted from git's tree oid; fsck of the receiving repository must be clean. Nothing expected
// here is computed by ply. The generator keeps a model of the file set (path -> bytes) only to emit lists that are
// valid for both sides; an edit's expected bytes are the model's (a token that occurs once, replaced by split/join).
// Servers: `default` is git's own receive-pack defaults (no fsck: a wrong tree is accepted silently, so the ls-tree
// comparison is the judge); `strict` is receive.fsckObjects=true + receive.unpackLimit=1 (index-pack --strict, which
// refuses a pack that names one object twice).
//
// Deterministic: splitmix32 seeded from CHANGES_GEN_SEED (default below). Every failure prints the line that reruns
// that one case. A wider sweep: CHANGES_GEN_REPOS=40 CHANGES_GEN_LISTS=12 npx vitest run test/changes-generated.test.js
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { cpSync, mkdirSync, writeFileSync, chmodSync, rmdirSync } from 'node:fs';
import { git, tmpRoot, makeBareRepo, startGitServer, fsckProblems, noMaintenance } from './server.js';
import { Rng } from './fuzz/prng.js';
import { commitChanges } from '../src/changes.js';
import { Tracer } from '../src/otel.js';

const SEED = Number(process.env.CHANGES_GEN_SEED ?? 20261111);
const REPOS = Number(process.env.CHANGES_GEN_REPOS ?? 3);
const LISTS = Number(process.env.CHANGES_GEN_LISTS ?? 4);
const ONLY = process.env.CHANGES_GEN_ONLY ?? ''; // "<repo>.<list>": rerun one case
const AUTHOR = { name: 'Ada', email: 'ada@x', tz: '+0000', time: 1700000000 };
const SERVERS = [
  ['default', [['receive.fsckObjects', 'false'], ['transfer.fsckObjects', 'false']]],
  ['strict', [['receive.fsckObjects', 'true'], ['receive.unpackLimit', '1']]],
];
const NAMES = ['alpha.txt', 'beta.md', 'gamma.json', 'run.sh', 'new.txt', 'same.txt'];
const DIRS = ['sub', 'lib', 'x'];
const BODIES = ['same\n', 'one\n', 'two\ntwo\n', '{}\n'];

// ---- the generator: a model of the file set, Map<path, { content, exec }> ----
const dirsOf = files => {
  const out = new Set();
  for (const p of files.keys()) for (let d = dirname(p); d !== '.'; d = dirname(d)) out.add(d);
  return [...out].sort();
};
const isDir = (files, p) => [...files.keys()].some(f => f.startsWith(`${p}/`));
// a path is free for a new file when nothing is there and no ancestor is a file
const free = (files, p) => {
  if (files.has(p) || isDir(files, p)) return false;
  for (let d = dirname(p); d !== '.'; d = dirname(d)) if (files.has(d)) return false;
  return true;
};

// a rename's destination directory must exist, in ply (not_found) as in `git mv` ("destination directory does not
// exist"); the oracle runs `git mv` unassisted, so git itself refuses a list that breaks this
const parentExists = (files, p) => dirname(p) === '.' || isDir(files, dirname(p));

function genRepo(rng) {
  // the template: 2-4 files and a sub/ with 1-2 files; every file carries one token an edit can find exactly once
  const template = new Map();
  let token = 0;
  const body = () => `line ${rng.int(0, 3)}\nTOKEN${token++}\n`;
  for (const name of NAMES.slice(0, rng.int(2, 4))) template.set(name, { content: body(), exec: name === 'run.sh' || rng.bool(0.2) });
  for (const name of NAMES.slice(0, rng.int(1, 2))) template.set(`sub/${name}`, { content: body(), exec: false });
  const twins = ['a', 'b', 'c', 'n/a', 'n/deep/b'].slice(0, rng.int(3, 5));
  const subTwins = ['s', 'n/s'].slice(0, rng.int(1, 2));
  const files = new Map();
  for (const d of twins) for (const [p, f] of template) files.set(`${d}/${p}`, { ...f });
  for (const d of subTwins) for (const [p, f] of template) if (p.startsWith('sub/')) files.set(`${d}/${p.slice(4)}`, { ...f });
  files.set('top.txt', { content: body(), exec: false });
  files.set('tool.sh', { content: body(), exec: true });
  return { files, twins, subTwins };
}

function genChange(rng, files) {
  const paths = [...files.keys()].sort();
  const dirs = dirsOf(files);
  const newPath = () => {
    const dir = rng.bool(0.85) && dirs.length > 0 ? rng.pick(dirs) : '';
    const leaf = rng.bool(0.25) ? `${rng.pick(DIRS)}/${rng.pick(NAMES)}` : rng.pick(NAMES);
    return dir === '' ? leaf : `${dir}/${leaf}`;
  };
  const mode = () => rng.weighted([[undefined, 5], ['100644', 2], ['100755', 2]]);
  const withMode = (c, m) => (m === undefined ? c : { ...c, mode: m });
  const kind = rng.weighted([['write-new', 4], ['write-over', 4], ['create', 2], ['edit', 3], ['delete', 3], ['rename', 3], ['chmod', 2], ['rename-dir', 1], ['delete-dir', 1]]);
  if (kind === 'write-new' || kind === 'create') {
    const path = newPath();
    if (!free(files, path)) return null;
    const m = mode();
    const content = rng.pick(BODIES);
    files.set(path, { content, exec: m === '100755' });
    return withMode({ kind: kind === 'create' ? 'create' : 'write', path, content }, m);
  }
  if (paths.length === 0) return null;
  if (kind === 'write-over') {
    const path = rng.pick(paths);
    const m = mode();
    // one time in four the same bytes: with no mode that is a no-op, as `git add` of an unchanged file is
    const content = rng.bool(0.25) ? files.get(path).content : rng.pick(BODIES);
    files.set(path, { content, exec: m === undefined ? files.get(path).exec : m === '100755' });
    return withMode({ kind: 'write', path, content }, m);
  }
  if (kind === 'chmod') {
    const path = rng.pick(paths);
    const f = files.get(path);
    files.set(path, { content: f.content, exec: !f.exec });
    return { kind: 'write', path, content: f.content, mode: f.exec ? '100644' : '100755' };
  }
  if (kind === 'edit') {
    const path = rng.pick(paths);
    const f = files.get(path);
    const found = /TOKEN\d+/u.exec(f.content);
    if (found === null || f.content.split(found[0]).length !== 2) return null;
    const replace = `EDIT${rng.int(0, 2)}`;
    files.set(path, { content: f.content.split(found[0]).join(replace), exec: f.exec });
    return { kind: 'edit', path, find: found[0], replace };
  }
  if (kind === 'delete') {
    const path = rng.pick(paths);
    files.delete(path);
    return { kind: 'delete', path };
  }
  if (kind === 'rename') {
    const from = rng.pick(paths);
    const to = newPath();
    if (!free(files, to) || !parentExists(files, to)) return null;
    files.set(to, files.get(from));
    files.delete(from);
    return { kind: 'rename', from, to };
  }
  if (dirs.length === 0) return null;
  const dir = rng.pick(dirs);
  const under = paths.filter(p => p.startsWith(`${dir}/`));
  if (kind === 'delete-dir') {
    for (const p of under) files.delete(p);
    return { kind: 'delete', path: dir };
  }
  const to = rng.bool(0.5) ? `moved${rng.int(0, 1)}` : `${rng.pick(dirs)}/moved`;
  if (to === dir || to.startsWith(`${dir}/`) || !free(files, to) || !parentExists(files, to)) return null;
  for (const p of under) { files.set(`${to}/${p.slice(dir.length + 1)}`, files.get(p)); files.delete(p); }
  return { kind: 'rename', from: dir, to };
}

function genList(rng, seedFiles) {
  const files = new Map(seedFiles);
  const want = rng.bool(0.34) ? 1 : rng.int(2, 7);
  const changes = [];
  for (let tries = 0; changes.length < want && tries < 200; tries++) {
    const c = genChange(rng, files);
    if (c !== null) changes.push(c);
  }
  return { changes, files };
}

// ---- the oracle: git's own commands in a copy of the seed work tree ----
// git removes a directory from the work tree when `git rm` empties it, not when `git mv` does; an empty directory
// left behind would turn a later `git mv x <that name>` into a move INTO it. Trees have no empty directories.
const prune = (work, p) => { for (let d = dirname(p); d !== '.'; d = dirname(d)) { try { rmdirSync(join(work, d)); } catch { return; } } };
function byGit(seedWork, work, changes, model) {
  cpSync(seedWork, work, { recursive: true });
  for (const c of changes) {
    if (c.kind === 'write' || c.kind === 'create') {
      mkdirSync(dirname(join(work, c.path)), { recursive: true });
      writeFileSync(join(work, c.path), c.content); // an existing file keeps its mode; a new one is 0644
      if (c.mode !== undefined) chmodSync(join(work, c.path), c.mode === '100755' ? 0o755 : 0o644);
      git(work, ['add', '--', c.path]);
    } else if (c.kind === 'edit') {
      writeFileSync(join(work, c.path), model.at(c)); // git has no find/replace: the model's bytes after this edit
      git(work, ['add', '--', c.path]);
    } else if (c.kind === 'delete') {
      // -f: git rm refuses a path whose staged content differs from HEAD (an earlier change of this list) without it
      git(work, ['rm', '-r', '-q', '-f', '--', c.path]);
    } else {
      git(work, ['mv', '--', c.from, c.to]);
      prune(work, c.from);
    }
  }
  git(work, ['commit', '-q', '--allow-empty', '-m', 'by git']);
  return { listing: git(work, ['ls-tree', '-r', '-t', 'HEAD']), tree: git(work, ['rev-parse', 'HEAD^{tree}']).trim() };
}

// The bytes each edit must leave, replayed from the seed model by the list alone (no ply code).
function editBytes(seedFiles, changes) {
  const files = new Map([...seedFiles].map(([p, f]) => [p, f.content]));
  const out = new Map();
  for (const c of changes) {
    if (c.kind === 'write' || c.kind === 'create') files.set(c.path, c.content);
    else if (c.kind === 'edit') { files.set(c.path, files.get(c.path).split(c.find).join(c.replace)); out.set(c, files.get(c.path)); }
    else if (c.kind === 'delete') { for (const p of [...files.keys()]) if (p === c.path || p.startsWith(`${c.path}/`)) files.delete(p); }
    else for (const p of [...files.keys()]) {
      if (p !== c.from && !p.startsWith(`${c.from}/`)) continue;
      files.set(c.to + p.slice(c.from.length), files.get(p));
      files.delete(p);
    }
  }
  return { at: c => out.get(c) };
}

let root, cleanup, srv, n = 0;
const repos = [];

before(async () => {
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  const rng = new Rng(SEED);
  for (let r = 0; r < REPOS; r++) {
    const repoRng = rng.fork();
    const listRngs = Array.from({ length: LISTS }, () => rng.fork());
    const { files, twins, subTwins } = genRepo(repoRng);
    const work = join(root, `seed${r}`);
    git(root, ['-c', 'core.autocrlf=false', 'init', '-q', '-b', 'main', work]); noMaintenance(work);
    for (const [k, v] of [['user.name', 's'], ['user.email', 's@x'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false'], ['core.fileMode', 'true']]) git(work, ['config', k, v]);
    for (const [p, f] of files) {
      mkdirSync(dirname(join(work, p)), { recursive: true });
      writeFileSync(join(work, p), f.content);
      if (f.exec) chmodSync(join(work, p), 0o755);
    }
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'seed']);
    // the fixture is what the test is about: by git's own hashing, the twins are one tree oid and so are the sub twins
    assert.equal(new Set(twins.map(d => git(work, ['rev-parse', `HEAD:${d}`]).trim())).size, 1, `seed ${SEED} repo ${r}: twins differ`);
    assert.equal(new Set([`${twins[0]}/sub`, ...subTwins].map(d => git(work, ['rev-parse', `HEAD:${d}`]).trim())).size, 1, `seed ${SEED} repo ${r}: sub twins differ`);
    const bares = new Map();
    for (const [name, cfg] of SERVERS) {
      const bare = makeBareRepo(root, `tpl${r}-${name}`);
      for (const [k, v] of cfg) git(bare, ['config', k, v]);
      git(work, ['push', '-q', bare, 'main']);
      bares.set(name, bare);
    }
    repos.push({ work, bares, files, listRngs, seedTree: git(work, ['rev-parse', 'HEAD^{tree}']).trim() });
  }
});
after(async () => { await srv.close(); cleanup(); });

for (let r = 0; r < REPOS; r++) {
  for (let l = 0; l < LISTS; l++) {
    if (ONLY !== '' && ONLY !== `${r}.${l}`) continue;
    for (const [server] of SERVERS) {
      test(`generated change list ${r}.${l} matches git [${server}] (seed ${SEED})`, async () => {
        const repo = repos[r];
        // a fresh generator per run of the case, so the two servers (and a rerun) see the same list
        const { changes } = genList(new Rng(repo.listRngs[l].s), repo.files);
        const rerun = `CHANGES_GEN_SEED=${SEED} CHANGES_GEN_REPOS=${REPOS} CHANGES_GEN_LISTS=${LISTS} CHANGES_GEN_ONLY=${r}.${l} npx vitest run test/changes-generated.test.js`;
        const where = `\nFAILING SEED ${SEED} case ${r}.${l} [${server}]\nrerun: ${rerun}\nchanges: ${JSON.stringify(changes)}\n`;
        const want = byGit(repo.work, join(root, `g${n++}`), changes, editBytes(repo.files, changes));
        const name = `t${n++}`;
        const bare = join(root, `${name}.git`);
        cpSync(repo.bares.get(server), bare, { recursive: true });
        const res = await commitChanges(`${srv.url}/${name}.git`, { ref: 'refs/heads/main', author: AUTHOR, message: 'generated', changes }, { tracer: new Tracer() });
        // git's tree decides the outcome: the seed's tree again is nothing to commit
        assert.equal(res.ok ? `ok ${res.value.outcome}` : `${res.error.code}: ${res.error.message}`, want.tree === repo.seedTree ? 'ok noop' : 'ok commit', where);
        assert.equal(git(bare, ['ls-tree', '-r', '-t', 'refs/heads/main']), want.listing, where);
        assert.equal(res.value.tree, want.tree, where);
        assert.deepEqual(fsckProblems(bare), [], where);
      });
    }
  }
}
