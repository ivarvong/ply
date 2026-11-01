// The merge-base cap (#143). Every cell is a relation, a length, and a cap. When the search window reaches the
// answer, ply's bases equal `git merge-base --all` and the depth is the first window that reaches it. When the
// window is still truncated, the error names the attempted depth and the cap separately.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmpRoot, makeBareRepo, startGitServer } from '../server.js';
import { createTransport } from '../../src/http.js';
import { mergeBase } from '../../src/merge.js';
import { Tracer } from '../../src/otel.js';
import { cells, expectCap } from './merge-depth.space.js';

const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x',
  GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000',
};

let root, cleanup, srv, bare;
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); bare = makeBareRepo(root, 'd'); });
after(async () => { await srv.close(); cleanup(); });

const git = (args, input) => execFileSync('git', ['-C', bare, ...args], { env: ENV, input, encoding: 'utf8' });
const line = (args, input) => git(args, input).trim();

function chain(n, parent, marker) {
  const oids = [];
  let p = parent;
  for (let i = 1; i <= n; i++) {
    const args = ['commit-tree', TREE, '-m', `${marker}-${i}`];
    if (p) args.push('-p', p);
    p = line(args);
    oids.push(p);
  }
  return oids;
}

let TREE;
function build() {
  const blob = line(['hash-object', '-w', '--stdin'], 'x\n');
  TREE = line(['mktree'], `100644 blob ${blob}\tf\n`);
  const rootOid = chain(1, undefined, 'root')[0];
  const a = chain(15, rootOid, 'a');
  const c = chain(15, rootOid, 'c');
  const u = chain(15, undefined, 'u');
  const v = chain(15, undefined, 'v');
  return { rootOid, a, c, u, v };
}

function gitBases(a, b) {
  try {
    const out = git(['merge-base', '--all', a, b]).trim();
    return out === '' ? [] : out.split('\n').sort();
  } catch (e) {
    if (e.status === 1) return [];
    throw e;
  }
}

const count = tip => Number(line(['rev-list', '--count', tip]));

test('merge-base cap: every relation × length × cap against git merge-base --all', async () => {
  const all = cells();
  assert.equal(all.length, 3 * 5 * 8);
  const g = build();
  const url = `${srv.url}/d.git`;
  const t = createTransport(url, { tracer: new Tracer() });
  for (const c of all) {
    const pair = c.relation === 'fork' ? [g.a[c.length - 1], g.c[c.length - 1]]
      : c.relation === 'ancestor' ? [g.a[c.length - 1], g.rootOid]
      : [g.u[c.length - 1], g.v[c.length - 1]];
    const [a, b] = pair;
    // fork and ancestor: the base's child is `length` behind the tip (rev-list counts the root too).
    // unrelated: each root is `length` deep and must itself be fetched.
    const behind = c.relation === 'unrelated' ? count(a) : count(a) - 1;
    assert.equal(behind, c.length, `${c.id}: git rev-list`);
    const want = expectCap(c.cap, behind);
    const gitAnswer = gitBases(a, b);
    let result = null;
    let err = null;
    try { result = await mergeBase(t, a, b, { maxDepth: c.cap }); }
    catch (e) { err = e; }
    if (want.tag === 'fit') {
      assert.equal(err, null, `${c.id}: ${err?.code} ${err?.message}`);
      assert.equal(result.depth, want.depth, c.id);
      assert.deepEqual([...result.bases].sort(), gitAnswer, c.id);
      assert.equal(result.base, gitAnswer.length === 1 ? gitAnswer[0] : null, c.id);
    } else {
      assert.equal(err?.code, 'limit_exceeded', `${c.id}: ${err?.code} ${result?.base}`);
      assert.equal(err.what, 'merge-base search depth', c.id);
      assert.equal(err.got, want.got, c.id);
      assert.equal(err.max, want.max, c.id);
      assert.notEqual(err.got, err.max, `${c.id}: the attempt and the cap are different numbers`);
    }
  }
});

