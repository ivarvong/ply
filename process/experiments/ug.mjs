import { join } from 'node:path'; import { mkdirSync } from 'node:fs';
import { git, tmpRoot, makeBareRepo } from '/home/claude/ply/test/server.js';
import { genDag, readModel, expectedObjects, treeClosure } from '/home/claude/ply/test/fuzz/dag.js';
import { Rng } from '/home/claude/ply/test/fuzz/prng.js';
const { root, cleanup } = tmpRoot(); let ok = 0, bad = 0;
for (let k = 0; k < 6; k++) {
  const r = new Rng(500 + k), bare = makeBareRepo(root, `u${k}`), work = join(root, `wu${k}`); mkdirSync(work);
  genDag(r, work, { commits: r.int(6, 20), branches: 2 }); git(work, ['push', '-q', '--all', bare]);
  const model = readModel(bare); const commits = [...model.commits.keys()];
  for (let i = 0; i < 40; i++) {
    const c = r.pick(commits), rootT = model.commits.get(c).tree; const subs = [...treeClosure(model, [rootT]).keys()].filter(o => model.type.get(o) === 'tree' && o !== rootT);
    const shape = r.int(0, 3);
    const wants = shape === 0 ? [c, rootT] : shape === 1 && subs.length ? [rootT, r.pick(subs)] : shape === 2 && subs.length ? [r.pick(subs), rootT] : [rootT, c];
    const N = r.int(0, 5), filter = `tree:${N}`;
    const got = new Set(git(bare, ['rev-list', '--objects', `--filter=${filter}`, ...wants]).toString().split('\n').filter(Boolean).map(l => l.slice(0, 40)));
    const exp = expectedObjects(model, { wants, haves: [], filter }).objects;
    const same = got.size === exp.size && [...got].every(o => exp.has(o));
    same ? ok++ : bad++;
    if (!same && bad <= 3) console.log(`repo ${k} wants ${wants.map(w => w.slice(0, 7) + ':' + model.type.get(w)).join(',')} ${filter}: git-only ${[...got].filter(o => !exp.has(o)).map(o => model.type.get(o)).join(',')} model-only ${[...exp].filter(o => !got.has(o)).map(o => model.type.get(o)).join(',')}`);
  }
}
cleanup(); console.log(`ok ${ok} bad ${bad}`);
