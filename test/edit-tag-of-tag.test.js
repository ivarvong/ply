// editFile creating a branch from a base ref that is a tag of a tag (refs/tags/vv -> tag v1 -> commit).
// Oracle: git itself. `git branch oracle refs/tags/vv` in the bare repo starts the branch at the commit git peels the
// tag chain to; editFile's new commit must have exactly that commit as its parent.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { git, tmpRoot, makeBareRepo, startGitServer } from './server.js';
import { editFile } from '../src/edit.js';
import { Tracer } from '../src/otel.js';

let root, cleanup, srv, bare;
before(async () => {
  ({ root, cleanup } = tmpRoot());
  srv = await startGitServer(root);
  const seed = join(root, 'seed');
  git(root, ['init', '-q', '-b', 'main', seed]);
  for (const [k, v] of [['user.name', 's'], ['user.email', 's@x'], ['commit.gpgsign', 'false']]) git(seed, ['config', k, v]);
  writeFileSync(join(seed, 'plain.txt'), 'plain\n');
  git(seed, ['add', '-A']); git(seed, ['commit', '-q', '-m', 'seed']);
  git(seed, ['tag', '-a', '-m', 'v1', 'v1', 'main']);
  git(seed, ['tag', '-a', '-m', 'vv', 'vv', 'v1']);
  bare = makeBareRepo(root, 'tagtag'); git(seed, ['push', '-q', bare, 'main', 'v1', 'vv']);
});
after(async () => { await srv.close(); cleanup(); });

test('a base that is a tag of a tag is the commit git starts a branch at', async () => {
  // the fixture is what it claims: vv is a tag object whose target is another tag object
  assert.equal(git(bare, ['cat-file', '-t', 'refs/tags/vv']).trim(), 'tag');
  assert.match(git(bare, ['cat-file', '-p', 'refs/tags/vv']), /^object [0-9a-f]{40}\ntype tag\n/u);
  git(bare, ['branch', 'oracle', 'refs/tags/vv']);
  const start = git(bare, ['rev-parse', 'refs/heads/oracle']).trim();
  assert.equal(git(bare, ['cat-file', '-t', start]).trim(), 'commit');

  const r = await editFile(`${srv.url}/tagtag.git`, { ref: 'refs/heads/feature', base: 'refs/tags/vv', path: 'plain.txt', find: 'plain', replace: 'edited', author: { name: 'Ada', email: 'ada@x' }, message: 'm' }, { tracer: new Tracer() });
  assert.equal(r.ok ? 'ok' : `${r.error.code}: ${r.error.message}`, 'ok');
  assert.equal(r.value.oldCommit, start);
  const tip = git(bare, ['rev-parse', 'refs/heads/feature']).trim();
  assert.equal(tip, r.value.newCommit);
  assert.equal(git(bare, ['rev-parse', `${tip}^`]).trim(), start);
  assert.equal(git(bare, ['cat-file', '-p', `${tip}:plain.txt`]), 'edited\n');
});
