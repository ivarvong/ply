// Wanted trees under tree:N, decided by git: the object model's NOT_USER_GIVEN rule (a wanted tree that is a walked commit's
// root, or that an earlier wanted tree's walk reaches, is filtered like any tree) against `git rev-list --objects --filter`,
// which runs the same traversal as pack-objects. Shapes: [commit, its root], [root, commit], [tree, subtree], [subtree, tree].
//   node test/fuzz/usergiven.mjs [--repos 6] [--n 40] [--seed 500]
import { join } from 'node:path'; import { mkdirSync } from 'node:fs';
import { git, tmpRoot, makeBareRepo } from '../server.js';
import { genDag, readModel, expectedObjects, treeClosure } from './dag.js';
import { Rng } from './prng.js';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : +process.argv[i + 1]; };
const REPOS = arg('repos', 6), N = arg('n', 40), SEED = arg('seed', 500);
const { root, cleanup } = tmpRoot(); let ok = 0, bad = 0;
for (let k = 0; k < REPOS; k++) {
  const r = new Rng(SEED + k), bare = makeBareRepo(root, `u${k}`), work = join(root, `wu${k}`); mkdirSync(work);
  genDag(r, work, { commits: r.int(6, 20), branches: 2 }); git(work, ['push', '-q', '--all', bare]);
  const model = readModel(bare); const commits = [...model.commits.keys()];
  for (let i = 0; i < N; i++) {
    const c = r.pick(commits), rootT = model.commits.get(c).tree; const subs = [...treeClosure(model, [rootT]).keys()].filter(o => model.type.get(o) === 'tree' && o !== rootT);
    const shape = r.int(0, 3);
    const wants = shape === 0 ? [c, rootT] : shape === 1 && subs.length ? [rootT, r.pick(subs)] : shape === 2 && subs.length ? [r.pick(subs), rootT] : [rootT, c];
    const depth = r.int(0, 5), filter = `tree:${depth}`;
    const got = new Set(git(bare, ['rev-list', '--objects', `--filter=${filter}`, ...wants]).toString().split('\n').filter(Boolean).map(l => l.slice(0, 40)));
    const exp = expectedObjects(model, { wants, haves: [], filter }).objects;
    const same = got.size === exp.size && [...got].every(o => exp.has(o));
    same ? ok++ : bad++;
    if (!same && bad <= 3) console.log(`repo ${k} wants ${wants.map(w => w.slice(0, 7) + ':' + model.type.get(w)).join(',')} ${filter}: git-only ${[...got].filter(o => !exp.has(o)).map(o => model.type.get(o)).join(',')} model-only ${[...exp].filter(o => !got.has(o)).map(o => model.type.get(o)).join(',')}`);
  }
}
cleanup(); console.log(`${ok + bad} cases (seed ${SEED}): ${ok} equal to git rev-list, ${bad} different`);
if (bad) process.exit(1);
