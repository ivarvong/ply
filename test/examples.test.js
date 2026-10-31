// examples/push-tree.mjs and examples/checkout-tree.mjs, run as a user runs them: a child `node` whose PATH holds node
// and nothing else (no git on the client), against `git http-backend` (test/server.js), with the credential in the
// environment behind Basic auth. git is only the judge: push → checkout must give back the source directory byte for
// byte with its modes and symlinks; `git clone` of the remote must equal the source; a repeat with nothing changed is a
// noop and a one-file change sends one blob, the trees on its path and the commit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { mkdirSync, symlinkSync, writeFileSync, chmodSync, readdirSync, lstatSync, readlinkSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { git, tmpRoot, makeBareRepo, startGitServer, startAuthGate } from './server.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'tok-3x4mple';
let root, cleanup, srv, auth, bin, n = 0;

before(async () => {
  ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root);
  auth = await startAuthGate(srv.url, h => h === `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`);
  bin = join(root, 'bin'); mkdirSync(bin); symlinkSync(process.execPath, join(bin, 'node'));
});
after(async () => { await auth.close(); await srv.close(); cleanup(); });

// the example in a child node with PATH = just node; PLY_TOKEN in env, never argv. Async: the servers are in-process.
const run = async (script, args, env = {}) => (await promisify(execFile)(join(bin, 'node'), [join(REPO, 'examples', script), ...args], {
  cwd: REPO, encoding: 'utf8',
  env: { PATH: bin, HOME: root, PLY_TOKEN: TOKEN, GIT_AUTHOR_NAME: 'Example', GIT_AUTHOR_EMAIL: 'ex@example.com', ...env },
})).stdout;

// every path under `base` (not .git): type, permission bits, bytes, symlink target
function snapshot(base, rel = '', out = new Map()) {
  for (const name of readdirSync(join(base, rel)).sort()) {
    if (name === '.git') continue;
    const p = rel ? `${rel}/${name}` : name, st = lstatSync(join(base, p));
    if (st.isSymbolicLink()) out.set(p, `link ${readlinkSync(join(base, p))}`);
    else if (st.isDirectory()) snapshot(base, p, out);
    else out.set(p, `file ${(st.mode & 0o777).toString(8)} ${readFileSync(join(base, p)).toString('base64')}`);
  }
  return out;
}
const same = (got, want, what) => assert.deepEqual([...snapshot(got)], [...snapshot(want)], what);

test('examples: push-tree → checkout-tree round-trips byte-identical with modes; git clone == source; repeats are thin', async () => {
  makeBareRepo(root, 'ex'); const url = `${auth.url}/ex.git`;
  const src = join(root, 'src');
  const files = { 'README.md': '# example\n', 'empty': '', 'src/lib/deep/x.js': 'export const x = 1;\n', 'src/main.js': 'import "./lib/deep/x.js";\n', 'dir with space/ünï.txt': 'unicode\n', 'bin/build.sh': '#!/bin/sh\necho build\n', 'data.bin': Buffer.from(Array.from({ length: 70000 }, (_, i) => (i * 2654435761) >>> 24)) };
  for (const [p, d] of Object.entries(files)) { mkdirSync(dirname(join(src, p)), { recursive: true }); writeFileSync(join(src, p), d); }
  chmodSync(join(src, 'bin/build.sh'), 0o755); chmodSync(join(src, 'README.md'), 0o644);
  symlinkSync('src/main.js', join(src, 'link')); symlinkSync('../../README.md', join(src, 'src/lib/up'));

  // create
  const out1 = await run('push-tree.mjs', [src, url, '--ref', 'main', '--message', 'first']);
  const head1 = git(join(root, 'ex.git'), ['rev-parse', 'refs/heads/main']).trim();
  assert.match(out1, new RegExp(`refs/heads/main: \\(new\\) -> ${head1}`));
  const sent1 = +/sent (\d+) objects/.exec(out1)[1];
  assert.ok(/(\d+) pack bytes/.exec(out1)[1] > 0);
  git(join(root, 'ex.git'), ['fsck', '--strict']);
  assert.equal(git(join(root, 'ex.git'), ['log', '-1', '--format=%an <%ae>%n%B', 'main']).trim(), 'Example <ex@example.com>\nfirst');

  // git clone of the remote == source
  const cloned = join(root, `clone${n++}`); git(root, ['clone', '-q', join(root, 'ex.git'), cloned]);
  same(cloned, src, 'git clone == source');
  assert.equal(git(cloned, ['ls-files', '-s', 'bin/build.sh']).split(' ')[0], '100755');

  // checkout == source
  const co = join(root, `co${n++}`);
  const outCo = await run('checkout-tree.mjs', [url, co, '--ref', 'main']);
  assert.match(outCo, new RegExp(`refs/heads/main @ ${head1} -> `));
  assert.match(outCo, /wrote 7 files \(\d+ bytes\), 2 symlinks, 0 submodule dirs/);
  same(co, src, 'checkout == source');

  // repeat, unchanged: noop, the ref does not move
  assert.match(await run('push-tree.mjs', [src, url]), /^noop: refs\/heads\/main already has this tree/);
  assert.equal(git(join(root, 'ex.git'), ['rev-parse', 'refs/heads/main']).trim(), head1);

  // repeat, one deep file changed: 1 blob + the 4 trees on its path (root, src, src/lib, src/lib/deep) + the commit
  writeFileSync(join(src, 'src/lib/deep/x.js'), 'export const x = 2;\n');
  const out3 = await run('push-tree.mjs', [src, url]);
  const head3 = git(join(root, 'ex.git'), ['rev-parse', 'refs/heads/main']).trim();
  assert.match(out3, new RegExp(`refs/heads/main: ${head1} -> ${head3}`));
  assert.match(out3, /sent 6 objects \(1 blobs, 4 trees, 1 commit\)/);
  assert.ok(6 < sent1, `thin: ${sent1} objects on create`);
  git(join(root, 'ex.git'), ['fsck', '--strict']);
  const co2 = join(root, `co${n++}`); await run('checkout-tree.mjs', [url, co2]);
  same(co2, src, 'checkout after update == source');
  const cloned2 = join(root, `clone${n++}`); git(root, ['clone', '-q', join(root, 'ex.git'), cloned2]);
  same(cloned2, src, 'git clone after update == source');

  // no credential in env: the server's 401 surfaces, nothing pushed
  await assert.rejects(run('push-tree.mjs', [src, url], { PLY_TOKEN: '' }), e => /auth/.test(e.stderr) && !e.stderr.includes(TOKEN));
  assert.ok(auth.seen.every(s => s.authorization === null || s.authorization.startsWith('Basic ')), 'only Basic, from env');
  console.log(`  create: ${out1.trim().split('\n')[1].trim()}\n  update: ${out3.trim().split('\n')[1].trim()}\n  checkout: ${outCo.trim().split('\n')[1].trim()}`);
});
