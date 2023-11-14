// HEAD against maxRefs (#143). Every cell is a HEAD form, a refs/heads/HEAD decoy, a branch count, and a cap.
// Within the cap, ply's listing equals `git ls-remote --symref` (HEAD included). Past it, the refusal names
// one past the cap as got and the cap as max. The line named exactly HEAD never takes a slot.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmpRoot, makeBareRepo, startGitServer } from '../server.js';
import { createTransport } from '../../src/http.js';
import { lsRefs } from '../../src/lsrefs.js';
import { withLimits, LIMIT_REFS } from '../../src/limits.js';
import { Tracer } from '../../src/otel.js';
import { cells, CAPS } from './lsrefs-head.space.js';

const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x',
  GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000',
};

let root, cleanup, srv, nRepo = 0;
const built = new Map();
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv.close(); cleanup(); });

const git = (cwd, args, input) => execFileSync('git', ['-C', cwd, ...args], { env: ENV, input, encoding: 'utf8', maxBuffer: 64 << 20 });
const line = (cwd, args, input) => git(cwd, args, input).trim();

function listingOf(bare) {
  // Against the repo itself, not the HTTP server: execFileSync would block the server's event loop.
  const out = git(bare, ['ls-remote', '--symref', '.']);
  const refs = [];
  let sym = null;
  for (const row of out.split('\n')) {
    if (row === '') continue;
    const tab = row.indexOf('\t');
    if (row.startsWith('ref: ')) { sym = row.slice('ref: '.length, tab); continue; }
    refs.push({ oid: row.slice(0, tab), name: row.slice(tab + 1) });
  }
  return { refs, sym };
}

function build(cell) {
  const key = `${cell.head}/${cell.decoy}/${cell.n}`;
  const hit = built.get(key);
  if (hit) return hit;
  const name = `h${nRepo++}`;
  const bare = makeBareRepo(root, name);
  const branches = [];
  for (let i = 0; i < cell.n; i++) branches.push(`refs/heads/r${String(i).padStart(5, '0')}`);
  if (cell.decoy) branches.push('refs/heads/HEAD');
  let oid = '';
  if (cell.head === 'detached' || branches.length > 0) {
    const blob = line(bare, ['hash-object', '-w', '--stdin'], 'x\n');
    const tree = line(bare, ['mktree'], `100644 blob ${blob}\tf\n`);
    oid = line(bare, ['commit-tree', tree, '-m', 'c']);
    if (branches.length > 0) git(bare, ['update-ref', '--stdin'], branches.map(b => `update ${b} ${oid}\n`).join(''));
  }
  if (cell.head === 'detached') git(bare, ['update-ref', '--no-deref', 'HEAD', oid]);
  else if (cell.head === 'symref') {
    let target = 'refs/heads/main';
    if (branches.includes('refs/heads/r00000')) target = 'refs/heads/r00000';
    else if (branches.length > 0) target = branches[0];
    git(bare, ['symbolic-ref', 'HEAD', target]);
  } else git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/missing']);
  const url = `${srv.url}/${name}.git`;
  const rec = { url, listing: listingOf(bare) };
  built.set(key, rec);
  return rec;
}

const shown = refs => refs.map(r => `${r.oid} ${r.name}`).sort();

test('ls-refs: HEAD does not consume maxRefs; the listing matches git ls-remote', async () => {
  const all = cells();
  assert.equal(all.length, 3 * 2 * 5 * 3);
  assert.equal(LIMIT_REFS, 10000);
  assert.ok(CAPS.includes(LIMIT_REFS));
  for (const c of all) {
    const repo = build(c);
    const nonHead = repo.listing.refs.filter(r => r.name !== 'HEAD');
    assert.equal(nonHead.length, c.n + (c.decoy ? 1 : 0), `${c.id}: git ls-remote`);
    const t = createTransport(repo.url, { tracer: new Tracer(), limits: withLimits({ maxRefs: c.maxRefs }) });
    let result = null;
    let err = null;
    try { result = await lsRefs(t); }
    catch (e) { err = e; }
    if (nonHead.length > c.maxRefs) {
      assert.ok(err, c.id);
      assert.equal(err.code, 'limit_exceeded', `${c.id}: ${err.code} ${err.message}`);
      assert.equal(err.what, 'ls-refs lines', c.id);
      assert.equal(err.got, c.maxRefs + 1, c.id);
      assert.equal(err.max, c.maxRefs, c.id);
    } else {
      assert.equal(err, null, c.id);
      assert.ok(result, c.id);
      assert.deepEqual(shown([...result.refs.values()]), shown(repo.listing.refs), c.id);
      assert.equal(result.head, repo.listing.sym, c.id);
    }
  }
});
