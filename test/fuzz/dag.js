// Generate a repo with a branching/merging history and churned files (so packs have delta chains),
// then read the full object model back from git. The model is the oracle for expected pack contents.
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { git, gitBuf } from '../server.js';

// files: a set of paths at varying depth; each commit edits some, adds some, deletes some.
export function genDag(rng, work, { commits = 14, maxParents = 3, branches = 3 } = {}) {
  git(work, ['init', '-q', '-b', 'main']);
  const paths = ['a.txt', 'big.bin', 'd1/x.txt', 'd1/y.txt', 'd1/d2/z.txt', 'd1/d2/d3/w.txt', 'd1/d2/d3/d4/v.txt', 'e/f.txt'];
  const content = Object.fromEntries(paths.map(p => [p, Buffer.from(`${p}\n` + 'line\n'.repeat(rng.int(1, 40)))]));
  content['big.bin'] = Buffer.alloc(rng.int(2000, 9000), rng.int(0, 255));
  const heads = []; // commit oids usable as parents
  const env = { ...process.env, GIT_AUTHOR_NAME: 'dag', GIT_AUTHOR_EMAIL: 'd@x', GIT_COMMITTER_NAME: 'dag', GIT_COMMITTER_EMAIL: 'd@x', };
  const commitOids = [];
  for (let i = 0; i < commits; i++) {
    // mutate working tree
    for (const p of paths) {
      if (rng.bool(0.5)) { const b = content[p]; const o = rng.int(0, b.length); content[p] = Buffer.concat([b.subarray(0, o), Buffer.from(rng.bool(0.5) ? `edit${i}\n` : ''), b.subarray(Math.min(b.length, o + rng.int(0, 10)))]); }
      mkdirSync(join(work, p, '..'), { recursive: true });
      writeFileSync(join(work, p), content[p]);
    }
    if (rng.bool(0.3)) { const np = `new${i}/n.txt`; mkdirSync(join(work, np, '..'), { recursive: true }); writeFileSync(join(work, np), `n${i}`); paths.push(np); content[np] = Buffer.from(`n${i}`); }
    git(work, ['add', '-A']);
    const tree = git(work, ['write-tree']).trim();
    const nParents = i === 0 ? 0 : Math.min(heads.length, rng.weighted([[1, 6], [2, 2], [3, 1]]));
    const parents = [];
    while (parents.length < nParents) { const p = rng.pick(heads); if (!parents.includes(p)) parents.push(p); }
    const date = `${1700000000 + i * 1000} +0000`;
    const oid = git(work, ['commit-tree', tree, ...parents.flatMap(p => ['-p', p]), '-m', `c${i}`], { env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }).trim();
    commitOids.push(oid);
    heads.push(oid);
    if (heads.length > branches) heads.splice(rng.int(0, heads.length - 1), 1);
  }
  const tip = commitOids[commitOids.length - 1];
  git(work, ['update-ref', 'refs/heads/main', tip]);
  heads.forEach((h, i) => git(work, ['update-ref', `refs/heads/b${i}`, h]));
  git(work, ['tag', '-a', 'v1', '-m', 'v1', commitOids[Math.floor(commits / 2)]], { env: { ...env, GIT_COMMITTER_DATE: '1700000000 +0000' } });
  return { commitOids, tip, branchHeads: heads };
}

// Read the model back from git: commits (parents, tree), every tree's entries, blob sizes, depths.
export function readModel(repo) {
  const type = new Map(), size = new Map();
  for (const l of git(repo, ['cat-file', '--batch-check', '--batch-all-objects']).trim().split('\n')) { const [o, t, s] = l.split(' '); type.set(o, t); size.set(o, +s); }
  const commits = new Map();
  for (const l of git(repo, ['rev-list', '--all', '--parents']).trim().split('\n')) { const [c, ...ps] = l.split(' '); commits.set(c, { parents: ps, tree: git(repo, ['rev-parse', `${c}^{tree}`]).trim(), date: +git(repo, ['log', '-1', '--format=%ct', c]).trim() }); }
  const refs = new Map(git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']).trim().split('\n').map(l => l.split(' ')).map(([r, o]) => [r, o]));
  const trees = new Map();
  for (const [o, t] of type) if (t === 'tree') trees.set(o, git(repo, ['ls-tree', o]).trim().split('\n').filter(Boolean).map(l => { const [m, ty, oid, ...n] = l.split(/\s+/); return { mode: m, type: ty, oid, name: n.join(' ') }; }));
  const tags = new Map();
  for (const [o, t] of type) if (t === 'tag') tags.set(o, git(repo, ['rev-parse', `${o}^{}`]).trim());
  return { type, size, commits, trees, tags, refs };
}

// ---- pure set computations over the model ----
// upload-pack do_got_oid(): a have marks its direct parents THEY_HAVE; a later have already marked is not added.
// Order-dependent by design in git; we reproduce it rather than idealize it.
export function effectiveHaves(model, haves) {
  const theyHave = new Set(), out = [];
  for (const h of haves) {
    if (!model.type.has(h)) continue;
    const knew = theyHave.has(h);
    theyHave.add(h);
    // parents are marked even for an already-known have (captured from upload-pack via uploadpack.packObjectsHook)
    if (model.commits.has(h)) for (const p of model.commits.get(h).parents) theyHave.add(p);
    if (!knew) out.push(h);
  }
  return out;
}
export function reachableCommits(model, roots, { depth = Infinity, since = 0, exclude = new Set() } = {}) {
  // BFS by generation from each root; depth 1 = root only. `since`: parents older than it are cut.
  // `exclude`: commits reachable from deepen-not refs are cut. Returns Map commit → minDepth, and boundary set.
  const seen = new Map();
  let frontier = roots.filter(r => model.commits.has(r)).map(r => [r, 1]);
  const boundary = new Set();
  while (frontier.length) {
    const next = [];
    for (const [c, d] of frontier) {
      if (seen.has(c) || exclude.has(c)) continue;
      seen.set(c, d);
      const ps = model.commits.get(c).parents;
      const kept = ps.filter(p => !exclude.has(p) && model.commits.get(p).date >= since);
      // git: a commit at exactly the cutoff depth is reported shallow even if it has no parents (observed on root commits)
      if (d >= depth) { boundary.add(c); continue; }
      if (kept.length < ps.length) boundary.add(c);
      for (const p of kept) next.push([p, d + 1]);
    }
    frontier = next;
  }
  return { commits: seen, boundary };
}

// Objects (trees+blobs) of a set of trees with their min depth from root (root tree depth 0).
export function treeClosure(model, rootTrees) {
  const depthOf = new Map(); // oid → min depth
  const stack = rootTrees.map(t => [t, 0]);
  while (stack.length) {
    const [t, d] = stack.pop();
    if (depthOf.has(t) && depthOf.get(t) <= d) continue;
    depthOf.set(t, d);
    for (const e of model.trees.get(t) ?? []) {
      if (e.type === 'tree') stack.push([e.oid, d + 1]);
      else if (e.type === 'blob') { if (!depthOf.has(e.oid) || depthOf.get(e.oid) > d + 1) depthOf.set(e.oid, d + 1); }
    }
  }
  return depthOf;
}

export function parseFilter(f) {
  if (!f) return () => true;
  if (f.startsWith('combine:')) { const fs = f.slice(8).split('+').map(parseFilter); return (o, m) => fs.every(x => x(o, m)); }
  if (f === 'blob:none') return o => o.type !== 'blob';
  if (f.startsWith('blob:limit=')) { const n = parseInt(f.slice(11), 10); return o => o.type !== 'blob' || o.size < n; }
  if (f.startsWith('tree:')) { const n = parseInt(f.slice(5), 10); return o => (o.type !== 'blob' && o.type !== 'tree') || o.depth < n; }
  throw new Error(`unknown filter ${f}`);
}
// pack-objects can serve a request from the bitmap index only for these filters (git 2.43 pack-bitmap.c filter_bitmap)
export function bitmapSupportsFilter(f) {
  if (!f) return true;
  if (f.startsWith('combine:')) return f.slice(8).split('+').every(bitmapSupportsFilter);
  return f === 'blob:none' || f.startsWith('blob:limit=') || f === 'tree:0';
}

// Expected object set for a v2 fetch.
//   mode 'bitmap'    : exact reachable(wants) \ reachable(haves)  — server has a bitmap, no deepen, supported filter
//   mode 'traversal' : git's revision walk with edge-based tree marking (aggressive when the request is shallow)
export function expectedObjects(model, { wants, haves = [], deepen, deepenSince, deepenNot = [], filter, shallow = [], bitmap = false, thinPack = false }) {
  const peel = o => (model.tags.has(o) ? model.tags.get(o) : o);
  const exclude = new Set();
  for (const r of deepenNot) { const o = model.refs.get(r); if (!o) continue; for (const c of reachableCommits(model, [peel(o)]).commits.keys()) exclude.add(c); }
  const deepening = deepen !== undefined || !!deepenSince || deepenNot.length > 0;
  const mode = bitmap && !deepening && bitmapSupportsFilter(filter) ? 'bitmap' : 'traversal';
  const eff = effectiveHaves(model, haves);
  const knownHaves = eff.map(peel).filter(h => model.commits.has(h));
  const nonCommitHaves = eff.filter(h => !model.commits.has(h) && !model.tags.has(h));
  const clientShallow = new Set(shallow.filter(c => model.commits.has(c)));

  // 1. depth walk from wants (independent of haves): boundary = commits at the cutoff; they are shallow for this request
  let wantCommits = wants.map(peel).filter(w => model.commits.has(w));
  const walk0 = reachableCommits(model, wantCommits, { depth: deepen ?? Infinity, since: deepenSince ?? 0, exclude });
  // send_unshallow(): a client shallow inside the window that is not on the boundary is unshallowed; its parents become wants
  const unshallowed = deepening ? [...clientShallow].filter(c => walk0.commits.has(c) && !walk0.boundary.has(c)) : [];
  wantCommits = [...wantCommits, ...unshallowed.flatMap(u => model.commits.get(u).parents)];
  // the shallow set was computed before the parents were added: they get no fresh depth budget (they lie inside the window)
  const { commits: inDepth, boundary } = walk0;
  const cut = new Set([...clientShallow, ...walk0.boundary]);

  // 2. have closure: ancestors of haves, not descending past cut commits. An unshallowed client commit is an
  //    extra edge (uninteresting): the client has it, only its parents are new.
  const haveClosure = new Set();
  { const stack = [...knownHaves, ...unshallowed]; while (stack.length) { const c = stack.pop(); if (haveClosure.has(c)) continue; haveClosure.add(c); if (!cut.has(c)) for (const p of model.commits.get(c).parents) stack.push(p); } }

  // 3. interesting commits: walk from wants, never through a had commit (a had want's parents are not visited)
  const included = new Set();
  { const stack = wantCommits.filter(w => inDepth.has(w)); while (stack.length) { const c = stack.pop(); if (included.has(c) || haveClosure.has(c) || !inDepth.has(c)) continue; included.add(c); if (!cut.has(c)) for (const p of model.commits.get(c).parents) if (inDepth.has(p)) stack.push(p); } }

  // 4. uninteresting objects
  const haveObjects = new Set(haveClosure);
  if (mode === 'bitmap') {
    for (const [o] of treeClosure(model, [...haveClosure].map(c => model.commits.get(c).tree))) haveObjects.add(o);
  } else {
    // mark_edges_uninteresting: trees of uninteresting parents of interesting commits (not of boundary commits: grafted).
    // pack-objects passes --objects-edge-aggressive iff --thin: then cmdline haves' trees are marked too.
    const edges = new Set([...(thinPack ? knownHaves : []), ...unshallowed]);
    for (const c of included) if (!cut.has(c)) for (const p of model.commits.get(c).parents) if (haveClosure.has(p)) edges.add(p);
    for (const [o] of treeClosure(model, [...edges].map(c => model.commits.get(c).tree))) haveObjects.add(o);
  }
  for (const h of nonCommitHaves) { haveObjects.add(h); if (model.type.get(h) === 'tree') for (const [o] of treeClosure(model, [h])) haveObjects.add(o); }
  for (const h of haves) if (model.tags.has(h)) haveObjects.add(h);

  // 5. objects of interesting commits, then filter
  const f = parseFilter(filter);
  const info = (o, d) => ({ type: model.type.get(o), depth: d, size: model.size.get(o) });
  const out = new Set();
  for (const c of included) out.add(c);
  for (const [o, d] of treeClosure(model, [...included].map(c => model.commits.get(c).tree))) if (!haveObjects.has(o) && f(info(o, d), model)) out.add(o);

  // 6. explicitly wanted objects
  for (const w of wants) {
    if (!model.type.has(w)) continue;
    const t = model.type.get(w);
    if (t === 'commit') continue; // handled by the walk
    if (t === 'tag') { if (!haveObjects.has(w)) { out.add(w); const c = model.tags.get(w); if (model.commits.has(c) && !haveClosure.has(c) && !included.has(c)) out.add(c); } continue; }
    // tree/blob: traversal mode drops it only if it is literally a have; bitmap mode drops it if any have reaches it
    const dropped = mode === 'bitmap' ? haveObjects.has(w) : (haves.includes(w) || [...nonCommitHaves].some(h => h === w || (model.type.get(h) === 'tree' && treeClosure(model, [h]).has(w))));
    if (dropped) continue;
    // a user-given want is unfiltered and its tree entries count from depth 0 (tree:N omits depth > N); a want that git has
    // already flagged NOT_USER_GIVEN is filtered like any tree (see userGiven)
    const given = userGiven(model, w, wants, included, filter), off = given ? 1 : 0;
    if (given || f(info(w, 0), model)) out.add(w);
    if (t === 'tree' && (given || f(info(w, 0), model))) for (const [o, d] of treeClosure(model, [w])) if (!haveObjects.has(o) && f(info(o, Math.max(0, d - off)), model)) out.add(o);
  }
  const shallowLines = [...walk0.boundary].filter(c => !clientShallow.has(c));
  return { objects: out, shallow: shallowLines.sort(), unshallow: [...unshallowed].sort(), includedCommits: [...included], uninteresting: haveObjects, mode, boundary: walk0.boundary, inDepth };
}

// git applies an object filter only to objects flagged NOT_USER_GIVEN (list_objects_filter__filter_object). The commit walk
// flags every walked commit's root tree before any pending tree is processed, and walking a wanted tree flags everything
// inside it. So a wanted tree/blob stays "user given" — unfiltered, with its tree's entries counted one level shallower —
// only if it is neither a walked commit's root tree nor inside an earlier wanted tree (list-objects.c, do_traverse).
export function userGiven(model, w, wants, walkedCommits, filter) {
  for (const c of walkedCommits) if (model.commits.get(c).tree === w) return false;
  // the deepest tree depth whose contents a tree:N filter (or a combine with one) lets git walk into
  const N = Math.min(...[...String(filter ?? '').matchAll(/tree:(\d+)/g)].map(m => +m[1]), Infinity);
  const prior = [];
  for (const e of wants) {
    if (e === w) break;
    prior.push(e);
    if (model.type.get(e) !== 'tree') continue;
    const eGiven = userGiven(model, e, prior.slice(0, -1), walkedCommits, filter);
    if (!eGiven && !(0 < N)) continue; // a filtered root at depth 0 is skipped whole under tree:0
    // walk as git does: a processed tree flags all its entries; a subtree is processed iff its depth < N.
    // A user-given root does not count a level (its entries are depth 0); a filtered root is depth 0.
    const stack = [[e, eGiven ? -1 : 0]], seen = new Map();
    while (stack.length) {
      const [t, d] = stack.pop();
      if (seen.has(t) && seen.get(t) <= d) continue; seen.set(t, d);
      for (const x of model.trees.get(t) ?? []) {
        if (x.oid === w) return false;
        if (x.type === 'tree' && d + 1 < N) stack.push([x.oid, d + 1]);
      }
    }
  }
  return true;
}

// ---- the two-sided bound any correct server must satisfy, independent of git's traversal heuristics ----
// required: reachable(wants) \ reachable(haves) exactly (haves cut at the request's shallow set), after the filter.
// had:      everything reachable from haves (same cut) — any extra the server sends must be in here.
export function requiredAndHad(model, { wants, haves = [], deepen, deepenSince, deepenNot = [], filter, shallow = [] }) {
  const exp = expectedObjects(model, { wants, haves, deepen, deepenSince, deepenNot, filter, shallow, bitmap: true });
  // expectedObjects in bitmap mode == precise set, except deepen forces traversal mode; recompute precisely here
  const peel = o => (model.tags.has(o) ? model.tags.get(o) : o);
  const exclude = new Set();
  for (const r of deepenNot) { const o = model.refs.get(r); if (!o) continue; for (const c of reachableCommits(model, [peel(o)]).commits.keys()) exclude.add(c); }
  const knownHaves = haves.map(peel).filter(h => model.commits.has(h));
  const clientShallow = shallow.filter(c => model.commits.has(c));
  let wantCommits = wants.map(peel).filter(w => model.commits.has(w));
  const walk0 = reachableCommits(model, wantCommits, { depth: deepen ?? Infinity, since: deepenSince ?? 0, exclude });
  const deepening = deepen !== undefined || !!deepenSince || deepenNot.length > 0;
  const unshallowed = deepening ? clientShallow.filter(c => walk0.commits.has(c) && !walk0.boundary.has(c)) : [];
  wantCommits = [...wantCommits, ...unshallowed.flatMap(u => model.commits.get(u).parents)];
  const { commits: inDepth } = walk0;
  const boundary = walk0.boundary;
  const cut = new Set([...clientShallow, ...boundary]);
  const had = new Set();
  // the client has what it declared shallow (and an unshallowed commit is treated as had by the server)
  { const stack = [...knownHaves, ...unshallowed]; while (stack.length) { const c = stack.pop(); if (had.has(c)) continue; had.add(c); if (!cut.has(c)) for (const p of model.commits.get(c).parents) stack.push(p); } }
  const hadCommits = new Set(had);
  for (const [o] of treeClosure(model, [...hadCommits].map(c => model.commits.get(c).tree))) had.add(o);
  for (const h of haves) { if (!model.type.has(h)) continue; had.add(h); if (model.type.get(h) === 'tree') for (const [o] of treeClosure(model, [h])) had.add(o); if (model.tags.has(h)) had.add(model.tags.get(h)); }
  const f = parseFilter(filter);
  const info = (o, d) => ({ type: model.type.get(o), depth: d, size: model.size.get(o) });
  const required = new Set();
  // walk from wants, never through a had commit (a had, shallow want has no parents from the client's point of view)
  const included = [];
  { const seen = new Set(); const stack = wantCommits.filter(w => inDepth.has(w)); while (stack.length) { const c = stack.pop(); if (seen.has(c) || hadCommits.has(c)) continue; seen.add(c); included.push(c); if (!cut.has(c)) for (const p of model.commits.get(c).parents) if (inDepth.has(p)) stack.push(p); } }
  for (const c of included) required.add(c);
  for (const [o, d] of treeClosure(model, included.map(c => model.commits.get(c).tree))) if (!had.has(o) && f(info(o, d), model)) required.add(o);
  for (const w of wants) {
    if (!model.type.has(w) || model.commits.has(w) || had.has(w)) continue;
    const given = model.tags.has(w) || userGiven(model, w, wants, included, filter), off = given ? 1 : 0;
    if (given || f(info(w, 0), model)) required.add(w);
    if (model.tags.has(w)) { const c = model.tags.get(w); if (!hadCommits.has(c)) required.add(c); }
    if (model.type.get(w) === 'tree' && (given || f(info(w, 0), model))) for (const [o, d] of treeClosure(model, [w])) if (!had.has(o) && f(info(o, Math.max(0, d - off)), model)) required.add(o);
  }
  return { required, had, shallow: exp.shallow, unshallow: exp.unshallow, boundary, inDepth };
}
