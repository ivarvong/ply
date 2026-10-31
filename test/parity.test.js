// Parity with git's own client. For each clone/fetch shape, git's CLI and our client issue the equivalent request;
// we compare (1) the pack-objects invocation upload-pack made for each, (2) the shallow set git recorded vs our
// shallow/unshallow lines, (3) the objects git stored vs the objects we received.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer } from './server.js';
import { genDag, readModel } from './fuzz/dag.js';
import { Rng } from './fuzz/prng.js';
import { GitHttp } from '../src/client.js';
import { Tracer } from '../src/otel.js';

let root, cleanup, srv, hookLog, bare, model, dag, url, anc;
before(async () => {
  ({ root, cleanup } = tmpRoot());
  const hookCfg = join(root, 'gitconfig'); hookLog = join(root, 'hooklog');
  writeFileSync(hookCfg, `[uploadpack]\n\tpackObjectsHook = ${fileURLToPath(new URL('./fuzz/pack-objects-hook.sh', import.meta.url))}\n`);
  srv = await startGitServer(root, { GIT_CONFIG_GLOBAL: hookCfg, PLY_HOOK_LOG: hookLog });
  bare = makeBareRepo(root, 'p');
  const work = join(root, 'w'); mkdirSync(work);
  dag = genDag(new Rng(777), work, { commits: 18, branches: 3 });
  git(work, ['push', '-q', '--all', bare]); git(work, ['push', '-q', '--tags', bare]);
  model = readModel(bare);
  url = `${srv.url}/p.git`;
  fileUrl = `file://${bare}`;
  cliEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), PLY_HOOK_LOG: hookLog };
  // ancestors of main by generation (reachable commits only; dropped branch heads never reached the server)
  anc = git(bare, ['rev-list', '--first-parent', 'main']).trim().split('\n');
});
after(async () => { await srv.close(); cleanup(); });

const capture = () => ({ args: readFileSync(hookLog + '.args', 'utf8').trim().replace(/^git --shallow-file \S* pack-objects /, '').replace(/^git pack-objects /, ''), stdin: readFileSync(hookLog + '.stdin', 'utf8') });
const norm = t => { const lines = t.trim().split('\n'); const i = lines.indexOf('--not'); const uniq = a => [...new Set(a)].sort(); return { shallow: uniq(lines.slice(0, i).filter(l => l.startsWith('--shallow'))), wants: uniq(lines.slice(0, i).filter(l => !l.startsWith('--shallow'))), not: uniq(lines.slice(i + 1).filter(Boolean)) }; };
const objectsIn = dir => new Set(git(dir, ['cat-file', '--batch-check', '--batch-all-objects', '--unordered']).trim().split('\n').filter(Boolean).map(l => l.split(' ')[0]));
const shallowOf = dir => existsSync(join(dir, '.git/shallow')) ? readFileSync(join(dir, '.git/shallow'), 'utf8').trim().split('\n').filter(Boolean).sort() : [];
let n = 0;
// git's own client speaks to the same upload-pack over the file:// smart transport (the sandbox blocks git's TCP to
// local ports; the protocol, the server-side code path and the pack-objects hook are identical)
let fileUrl, cliEnv;
const cli = (args, cwd = root) => { rmSync(hookLog + '.args', { force: true }); git(cwd, ['-c', 'protocol.version=2', ...args.map(a => a === url ? fileUrl : a)], { env: cliEnv }); return capture(); };

test('clone --depth N / --filter / --shallow-since / --shallow-exclude: same invocation, same shallow set, same objects', async () => {
  const tip = dag.tip;
  const c = new GitHttp(url, { tracer: new Tracer() });
  const scenarios = [
    ['--depth=1', { wants: [tip], deepen: 1 }],
    ['--depth=2', { wants: [tip], deepen: 2 }],
    ['--depth=3', { wants: [tip], deepen: 3 }],
    ['--depth=50', { wants: [tip], deepen: 50 }],
    ['--depth=2 --filter=blob:none', { wants: [tip], deepen: 2, filter: 'blob:none' }],
    ['--filter=blob:none', { wants: [tip], filter: 'blob:none' }],
    ['--filter=blob:limit=100', { wants: [tip], filter: 'blob:limit=100' }],
    ['--filter=tree:0', { wants: [tip], filter: 'tree:0' }],
    ['--filter=combine:blob:none+tree:2', { wants: [tip], filter: 'combine:blob:none+tree:2' }],
    [`--shallow-since=${model.commits.get(anc[Math.min(3, anc.length - 1)]).date}`, { wants: [tip], deepenSince: model.commits.get(anc[Math.min(3, anc.length - 1)]).date }],
    ['--shallow-exclude=v1', { wants: [tip], deepenNot: ['refs/tags/v1'] }],
  ];
  for (const [flags, req] of scenarios) {
    const dst = join(root, `clone${n++}`);
    // git: single-branch clone of main so the want set is exactly [tip]
    const gitInv = cli(['clone', '-q', '--no-tags', '--single-branch', '-b', 'main', ...(req.filter ? ['--no-checkout'] : []), ...flags.split(' '), url, dst]); // a checkout would lazily fetch filtered blobs: a second request
    const gitObjects = objectsIn(dst), gitShallow = shallowOf(dst);
    rmSync(hookLog + '.args', { force: true });
    const r = await c.fetchPack({ ...req, ofsDelta: true, thinPack: true, includeTag: true, noProgress: true });
    const ourInv = capture();
    assert.equal(ourInv.args, gitInv.args, `${flags}: argv`);
    assert.deepEqual(norm(ourInv.stdin), norm(gitInv.stdin), `${flags}: stdin`);
    assert.deepEqual([...r.shallow].sort(), gitShallow, `${flags}: shallow set`);
    const ours = new Set(r.objects.keys());
    assert.deepEqual([...ours].sort(), [...gitObjects].sort(), `${flags}: objects (git stored ${gitObjects.size}, we received ${ours.size})`);
    console.log(`  ${flags.padEnd(40)} ${ours.size} objects, shallow ${gitShallow.length}: identical`);
  }
});

test('fetch after a shallow clone: --deepen (relative), --depth=N, --unshallow, --shallow-since, --shallow-exclude', async () => {
  const tip = dag.tip;
  const c = new GitHttp(url, { tracer: new Tracer() });
  for (const [flags, mk] of [
    ['--deepen=1', s => ({ deepen: 1, deepenRelative: true })],
    ['--deepen=2', s => ({ deepen: 2, deepenRelative: true })],
    ['--depth=3', s => ({ deepen: 3 })],
    ['--depth=1', s => ({ deepen: 1 })],
    ['--unshallow', s => ({ deepen: 2147483647 })],
    [`--shallow-since=${model.commits.get(anc[Math.min(5, anc.length - 1)]).date}`, s => ({ deepenSince: model.commits.get(anc[Math.min(5, anc.length - 1)]).date })],
    ['--shallow-exclude=v1', s => ({ deepenNot: ['refs/tags/v1'] })],
  ]) {
    const dst = join(root, `clone${n++}`);
    cli(['clone', '-q', '--no-tags', '--single-branch', '-b', 'main', '--depth=2', url, dst]);
    const before = objectsIn(dst), shallowBefore = shallowOf(dst);
    const gitInv = cli(['fetch', '-q', ...flags.split(' '), 'origin', 'main'], dst);
    const gitNew = [...objectsIn(dst)].filter(o => !before.has(o)).sort(), gitShallow = shallowOf(dst);
    rmSync(hookLog + '.args', { force: true });
    // our equivalent: want tip, declare the same shallow set, have the tip (git's local ref)
    // thin bases resolve from the same local store git's client has (the clone before the fetch)
    const external = oid => (before.has(oid) ? { type: { blob: 3, tree: 2, commit: 1, tag: 4 }[git(dst, ['cat-file', '-t', oid]).trim()], data: new Uint8Array(gitBuf(dst, ['cat-file', git(dst, ['cat-file', '-t', oid]).trim(), oid])) } : undefined);
    const r = await c.fetchPack({ wants: [tip], haves: [tip], shallows: shallowBefore, ...mk(shallowBefore), ofsDelta: true, thinPack: true }, { external });
    const ourInv = capture();
    assert.equal(ourInv.args, gitInv.args, `${flags}: argv`);
    assert.deepEqual(norm(ourInv.stdin), norm(gitInv.stdin), `${flags}: stdin`);
    const expectedShallow = [...new Set([...shallowBefore.filter(s => !r.unshallow.includes(s)), ...r.shallow])].sort();
    assert.deepEqual(expectedShallow, gitShallow, `${flags}: shallow set after`);
    assert.deepEqual([...r.objects.keys()].sort(), gitNew, `${flags}: new objects (git +${gitNew.length}, we ${r.objects.size})`);
    console.log(`  ${flags.padEnd(40)} +${gitNew.length} objects, shallow ${shallowBefore.length}→${gitShallow.length}: identical`);
  }
});

test('ls-refs == git ls-remote (prefixes, symrefs, peeled tags, many refs)', async () => {
  for (let i = 0; i < 300; i++) git(bare, ['update-ref', `refs/heads/many/b${String(i).padStart(4, '0')}`, anc[i % anc.length]]);
  git(bare, ['update-ref', 'refs/tags/light', dag.tip]);
  git(bare, ['symbolic-ref', 'refs/heads/alias', 'refs/heads/main']);
  const c = new GitHttp(url, { tracer: new Tracer() });
  for (const prefixes of [[], ['refs/heads/'], ['refs/tags/'], ['refs/heads/many/b00'], ['refs/heads/main', 'refs/tags/v1'], ['HEAD']]) {
    const { refs, head } = await c.lsRefs(prefixes);
    const remote = git(bare, ['ls-remote', '--symref', ...(prefixes.length ? ['.', ...prefixes.map(p => p.replace(/\/$/, '/*'))] : ['.'])]).trim().split('\n').filter(Boolean);
    // ls-remote with globs approximates ref-prefix (prefix match); compare on the exact-prefix filter ourselves
    const exp = git(bare, ['ls-remote', '--symref', '.']).trim().split('\n').filter(Boolean).filter(l => prefixes.length === 0 || prefixes.some(p => l.split(/\s+/)[1].startsWith(p) || (l.startsWith('ref:') && l.split(/\s+/)[2].startsWith(p))));
    const expOids = new Map(exp.filter(l => !l.startsWith('ref:')).map(l => { const [oid, name] = l.split(/\s+/); return [name, oid]; }));
    for (const [name, oid] of expOids) if (!name.endsWith('^{}')) assert.equal(refs.get(name)?.oid, oid, `${prefixes}: ${name}`);
    for (const [name, oid] of expOids) if (name.endsWith('^{}')) assert.equal(refs.get(name.slice(0, -3))?.peeled, oid, `peeled ${name}`);
    assert.equal(refs.size, [...expOids.keys()].filter(k => !k.endsWith('^{}')).length, `${prefixes}: count`);
    if (prefixes.length === 0 || prefixes.includes('HEAD')) assert.equal(head, 'refs/heads/main');
    if (prefixes.length === 0) assert.equal(refs.get('refs/heads/alias')?.['symref-target'], 'refs/heads/main');
    void remote;
  }
  console.log('  ls-refs: 6 prefix sets vs ls-remote --symref, 300+ refs: identical');
});
