import { join } from 'node:path'; import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs'; import { spawnSync } from 'node:child_process';
import { startGitServer, makeBareRepo, tmpRoot } from '/home/claude/ply/test/server.js'; import { Tracer } from '/home/claude/ply/src/otel.js';
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'w', GIT_AUTHOR_EMAIL: 'w@x', GIT_COMMITTER_NAME: 'w', GIT_COMMITTER_EMAIL: 'w@x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' };
const sh = (cwd, a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: ENV }).stdout.trim();
copyFileSync('/tmp/oldmerge.js', '/home/claude/ply/src/merge.old.js');
const { root, cleanup } = tmpRoot(); const srv = await startGitServer(root);
for (const which of ['merge.old.js', 'merge.js']) {
  const { mergeBranch } = await import(`/home/claude/ply/src/${which}`);
  const name = `t${which.length}`, bare = makeBareRepo(root, name), w = join(root, `w${name}`); mkdirSync(w); sh(w, ['init', '-q', '-b', 'main']);
  const put = (p, v) => { writeFileSync(join(w, p), v); sh(w, ['add', '-A']); };
  put('f', 'r\n'); sh(w, ['commit', '-qm', 'r']); const R = sh(w, ['rev-parse', 'HEAD']);
  put('f', 'y\n'); sh(w, ['commit', '-qm', 'y']); const Y = sh(w, ['rev-parse', 'HEAD']);
  sh(w, ['checkout', '-qb', 'feat']); put('h', 'h\n'); sh(w, ['commit', '-qm', 'feat']); const FT = sh(w, ['rev-parse', 'HEAD']);
  sh(w, ['checkout', '-q', '--detach', Y]); for (let i = 1; i <= 3; i++) { put(`p${i}`, `${i}\n`); sh(w, ['commit', '-qm', `p${i}`]); } const P3 = sh(w, ['rev-parse', 'HEAD']);
  sh(w, ['checkout', '-q', '--detach', R]); sh(w, ['merge', '-q', '--no-ff', '--no-commit', P3]); put('f', 'r\n'); sh(w, ['commit', '-qm', 'm']); const MM = sh(w, ['rev-parse', 'HEAD']);
  sh(w, ['push', '-q', '-f', bare, `${MM}:refs/heads/main`, `${FT}:refs/heads/feat`]);
  const g = spawnSync('git', ['-C', bare, 'merge-tree', '--write-tree', 'main', 'feat'], { encoding: 'utf8' }); const gitF = sh(bare, ['cat-file', '-p', `${g.stdout.split('\n')[0]}:f`]);
  const m = await mergeBranch(`${srv.url}/${name}.git`, { ref: 'refs/heads/main', from: 'refs/heads/feat', author: { name: 'm', email: 'm@x' } }, { tracer: new Tracer() });
  console.log(`${which}: base ${m.base === Y ? 'y' : m.base === R ? 'r' : m.base}; git f=${gitF}; ply f=${sh(bare, ['cat-file', '-p', `${m.oid}:f`])}`);
}
await srv.close(); cleanup();
