import { join } from 'node:path'; import { mkdirSync, writeFileSync } from 'node:fs'; import { spawnSync } from 'node:child_process';
import { startGitServer, makeBareRepo, tmpRoot } from '/home/claude/ply/test/server.js';
import { mergeBranch } from '/home/claude/ply/src/merge.js'; import { Tracer } from '/home/claude/ply/src/otel.js';
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'w', GIT_AUTHOR_EMAIL: 'w@x', GIT_COMMITTER_NAME: 'w', GIT_COMMITTER_EMAIL: 'w@x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' };
const sh = (cwd, a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: ENV });
const { root, cleanup } = tmpRoot(); const srv = await startGitServer(root);
for (const flip of [false, true]) {
  const name = `cc${+flip}`, bare = makeBareRepo(root, name), w = join(root, `w${name}`); mkdirSync(w); sh(w, ['init', '-q', '-b', 'main']);
  const put = v => { writeFileSync(join(w, 'f'), v); sh(w, ['add', '-A']); };
  put('x\n'); sh(w, ['commit', '-qm', 'B']);
  sh(w, ['checkout', '-qb', 'feat']); writeFileSync(join(w, 'g'), 'g\n'); sh(w, ['add', '-A']); sh(w, ['commit', '-qm', 'C1']);
  sh(w, ['checkout', '-q', 'main']); put('a\n'); sh(w, ['commit', '-qm', 'A1']);
  const A1 = sh(w, ['rev-parse', 'HEAD']).stdout.trim(), C1 = sh(w, ['rev-parse', 'feat']).stdout.trim();
  // criss-cross: main merges C1; feat merges A1 but resolves f back to x
  // main := merge(C1, A1) keeping f=a (first parent C1); feat := merge(A1, C1) reverting f=x
  sh(w, ['checkout', '-q', '--detach', C1]); sh(w, ['merge', '-q', '--no-edit', A1]); const M = sh(w, ['rev-parse', 'HEAD']).stdout.trim();
  sh(w, ['checkout', '-q', '--detach', A1]); sh(w, ['merge', '-q', '--no-commit', C1]); put('x\n'); sh(w, ['commit', '-qm', 'F (reverts f)']); const F = sh(w, ['rev-parse', 'HEAD']).stdout.trim();
  sh(w, ['branch', '-f', 'main', M]); sh(w, ['branch', '-f', 'feat', F]); sh(w, ['checkout', '-q', 'main']);
  sh(w, ['push', '-q', bare, 'main', 'feat']);
  const bases = sh(bare, ['merge-base', '--all', 'main', 'feat']).stdout.trim().split('\n').length;
  const g = sh(bare, ['merge-tree', '--write-tree', 'main', 'feat']); const gitF = g.status === 0 ? sh(bare, ['cat-file', '-p', `${g.stdout.split('\n')[0]}:f`]).stdout.trim() : 'CONFLICT';
  let ours; try { const m = await mergeBranch(`${srv.url}/${name}.git`, { ref: 'refs/heads/main', from: 'refs/heads/feat', author: { name: 'm', email: 'm@x' } }, { tracer: new Tracer() }); ours = sh(bare, ['cat-file', '-p', `${m.oid}:f`]).stdout.trim(); } catch (e) { ours = e.code; }
  console.log(`merge bases: ${bases}; git f=${gitF}; ply f=${ours}${gitF !== 'CONFLICT' && ours !== 'merge_conflict' && ours !== gitF ? '   <-- WRONG' : ''}`);
}
await srv.close(); cleanup();
