// Red test: cases where merge-ort's rename detection makes git conflict but our tree merge (no rename detection) is clean.
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { startGitServer, makeBareRepo, tmpRoot } from '/home/claude/ply/test/server.js';
import { mergeBranch } from '/home/claude/ply/src/merge.js';
import { Tracer } from '/home/claude/ply/src/otel.js';
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'w', GIT_AUTHOR_EMAIL: 'w@x', GIT_COMMITTER_NAME: 'w', GIT_COMMITTER_EMAIL: 'w@x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' };
const sh = (cwd, a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: ENV });
const { root, cleanup } = tmpRoot(); const srv = await startGitServer(root);
const body = n => Array.from({ length: 30 }, (_, i) => `line ${i} of ${n}\n`).join('');
const CASES = {
  'rename/rename(1to2)': { base: { 'a.txt': body('a') }, ours: w => sh(w, ['mv', 'a.txt', 'b.txt']), theirs: w => sh(w, ['mv', 'a.txt', 'c.txt']) },
  'rename/delete':       { base: { 'a.txt': body('a') }, ours: w => sh(w, ['mv', 'a.txt', 'b.txt']), theirs: w => sh(w, ['rm', '-q', 'a.txt']) },
  'dir rename + add':    { base: { 'd/x.txt': body('x'), 'd/y.txt': body('y') }, ours: w => sh(w, ['mv', 'd', 'e']), theirs: w => { writeFileSync(join(w, 'd/new.txt'), 'new\n'); sh(w, ['add', '-A']); } },
};
let i = 0;
for (const [name, c] of Object.entries(CASES)) {
  const bare = makeBareRepo(root, `rr${i}`); const w = join(root, `w${i++}`); mkdirSync(w); sh(w, ['init', '-q', '-b', 'main']);
  for (const [p, v] of Object.entries(c.base)) { mkdirSync(join(w, p, '..'), { recursive: true }); writeFileSync(join(w, p), v); }
  sh(w, ['add', '-A']); sh(w, ['commit', '-q', '-m', 'base']);
  sh(w, ['checkout', '-q', '-b', 'feat']); c.theirs(w); sh(w, ['commit', '-q', '-am', 'theirs']); sh(w, ['add', '-A']); sh(w, ['commit', '-q', '--amend', '--no-edit']);
  sh(w, ['checkout', '-q', 'main']); c.ours(w); sh(w, ['add', '-A']); sh(w, ['commit', '-q', '-m', 'ours']);
  sh(w, ['push', '-q', bare, 'main', 'feat']);
  const g = sh(bare, ['merge-tree', '--write-tree', '--name-only', 'main', 'feat']);
  let ours; try { ours = (await mergeBranch(`${srv.url}/rr${i - 1}.git`, { ref: 'refs/heads/main', from: 'refs/heads/feat', author: { name: 'm', email: 'm@x' } }, { tracer: new Tracer() })).outcome; } catch (e) { ours = e.code; }
  console.log(`${name.padEnd(22)} git: ${g.status === 0 ? 'clean' : 'CONFLICT'}   ply: ${ours}${g.status !== 0 && ours === 'merge' ? '   <-- WRONG: clean where git conflicts' : ''}`);
}
await srv.close(); cleanup();
