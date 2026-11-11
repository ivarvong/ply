// One server mode of the exhaustive fetch matrix in test/protocol.test.js, run in a worker thread so the three modes
// run side by side: each cell blocks on synchronous git (the pack-objects oracle) and the git server lives in the same
// thread, so one thread can only take the modes one after another. Each worker has its own root, server and hook log.
// It posts its stats and per-cell object counts; the test sums them and makes the cross-mode assertions.
import { parentPort, workerData } from 'node:worker_threads';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer } from './server.js';
import { genDag, readModel, expectedObjects, requiredAndHad, treeClosure } from './fuzz/dag.js';
import { packObjectsOracle, reconstructFor } from './fuzz/packobjects.js';
import { Rng } from './fuzz/prng.js';
import { GitHttp } from '../src/client.js';
import { Tracer } from '../src/otel.js';
import { TYPE_NAME } from '../src/objects.js';
import { unwrap, unwrapAsync } from './unwrap.js';

let root, srv, hookLog;

// The cell plan, without a repository: the four enumerated dimensions by key, and the flags that cycle with the cell
// number. test/protocol.test.js holds this plan to a stated rule (no flag is a function of an enumerated dimension)
// before the matrix runs it, so the plan the guard judges is the plan the cells follow.
export const WANT_KEYS = ['tip', 'old', 'tag', 'tree', 'blob', 'tip+old', 'tip+tree', 'tag+blob'];
export const HAVE_KEYS = ['none', 'ancestor', 'old', 'branch', 'tip', 'tree', 'blob', 'tag', 'unknown', 'tip+old', 'old+tip'];
export const DEEPEN_KEYS = ['none', 'd1', 'd2', 'd99', 'since', 'not'];
export const FILTER = [undefined, 'blob:none', 'blob:limit=100', 'blob:limit=1', 'tree:0', 'tree:1', 'tree:2', 'combine:blob:none+tree:1', 'combine:blob:limit=100+tree:2'];
// Periods 13, 17 and 5 are coprime to each other, to every stride of the product (1, 9, 54, 594) and to the 7 and 11
// of the client-shallow cycle, so no flag is a function of a dimension or of another flag. (`i % 3` and `i % 2` under
// the 9-value filter loop asked for thin-pack with three filters only and gave each (deepen, filter) pair one ofs value.)
export const flagsOf = i => ({ thinPack: (i % 13) < 6, ofsDelta: (i % 17) < 8, done: (i % 5) !== 0 });
export function* plan() {
  let i = 0;
  for (const wk of WANT_KEYS) for (const hk of HAVE_KEYS) for (const dk of DEEPEN_KEYS) for (const filter of FILTER) { i++; yield { i, wk, hk, dk, filter, ...flagsOf(i) }; }
}

function makeServer(mode) {
  const name = `m-${mode}`;
  const bare = makeBareRepo(root, name);
  const work = join(root, `w-${mode}`); mkdirSync(work);
  const rng = new Rng(4242);
  const dag = genDag(rng, work, { commits: 16, branches: 3 });
  git(work, ['push', '-q', '--all', bare]); git(work, ['push', '-q', '--tags', bare]);
  git(bare, ['config', 'pack.depth', '10']);
  if (mode !== 'loose') git(bare, ['gc', '-q']);
  git(bare, ['config', 'pack.useBitmaps', String(mode === 'bitmap')]);
  return { name, bare, dag, model: readModel(bare), bitmap: mode === 'bitmap', mode };
}

export async function runMode(mode) {
  const S = makeServer(mode);
  const stats = { cells: 0, modelExact: 0, oracleExact: 0, invocationExact: 0, degenerate: 0, crash: 0 };
  const norm = t => { const lines = t.trim().split('\n'); const i = lines.indexOf('--not'); const uniq = a => [...new Set(a)].sort(); return JSON.stringify([uniq(lines.slice(0, i).filter(l => l.startsWith('--shallow'))), uniq(lines.slice(0, i).filter(l => !l.startsWith('--shallow'))), uniq(lines.slice(i + 1).filter(Boolean))]); };
  const seen = new Map();
  const { model, dag, bare } = S;
  const C = i => dag.commitOids[i];
  const tip = dag.tip, old = C(2), mid = C(8), branch = dag.branchHeads.find(h => h !== tip) ?? C(4);
  const tag = model.refs.get('refs/tags/v1');
  const tipTree = model.commits.get(tip).tree;
  const subtree = model.trees.get(tipTree).find(e => e.type === 'tree').oid;
  const blob = [...treeClosure(model, [tipTree]).keys()].find(o => model.type.get(o) === 'blob');
  const oldBlob = [...treeClosure(model, [model.commits.get(old).tree]).keys()].find(o => model.type.get(o) === 'blob');
  const WANTS = { tip: [tip], old: [old], tag: [tag], tree: [subtree], blob: [blob], 'tip+old': [tip, old], 'tip+tree': [tip, subtree], 'tag+blob': [tag, blob] };
  const HAVES = { none: [], ancestor: [mid], old: [old], branch: [branch], tip: [tip], tree: [subtree], blob: [oldBlob], tag: [tag], unknown: ['e'.repeat(40)], 'tip+old': [tip, old], 'old+tip': [old, tip] };
  const DEEPEN = { none: {}, d1: { deepen: 1 }, d2: { deepen: 2 }, d99: { deepen: 99 }, since: { deepenSince: model.commits.get(old).date - 500 }, not: { deepenNot: ['refs/tags/v1'] } };
  const client = unwrap(GitHttp.create(`${srv.url}/${S.name}.git`, { tracer: new Tracer() }));
  const external = oid => (model.type.has(oid) ? { type: { blob: 3, tree: 2, commit: 1, tag: 4 }[model.type.get(oid)], data: new Uint8Array(gitBuf(bare, ['cat-file', model.type.get(oid), oid])) } : undefined);
  assert.deepEqual([Object.keys(WANTS), Object.keys(HAVES), Object.keys(DEEPEN)], [WANT_KEYS, HAVE_KEYS, DEEPEN_KEYS], 'the plan names every dimension value');
  for (const { i, wk, hk, dk, filter, thinPack, ofsDelta, done } of plan()) {
    const wants = WANTS[wk], haves = HAVES[hk], d = DEEPEN[dk];
    // client shallow state cycles: none / the have is shallow / the tip is shallow (only meaningful with deepen)
    const shallow = (i % 7) === 0 && haves.length && model.commits.has(haves[0]) ? [haves[0]] : (i % 11) === 0 && dk !== 'none' ? [tip] : [];
    const req = { wants, haves, ...d, filter, thinPack, ofsDelta, done, shallows: shallow };
    const label = `${S.mode} want=${wk} have=${hk} ${dk} ${filter ?? '-'} ${thinPack ? 'thin' : ''}${ofsDelta ? ' ofs' : ' ref'}${done ? '' : ' nego'}${shallow.length ? ' sh' : ''}`;
    stats.cells++;
    const wantCommits = wants.map(w => model.tags.get(w) ?? w).filter(w => model.commits.has(w));
    const exp = expectedObjects(model, { ...req, shallow, bitmap: S.bitmap });
    const bound = requiredAndHad(model, { ...req, shallow, bitmap: S.bitmap });
    const degenerate = (d.deepenSince || d.deepenNot) && (wantCommits.length === 0 || wantCommits.some(w => (d.deepenSince && model.commits.get(w).date < d.deepenSince) || (d.deepenNot && !exp.inDepth.has(w))));
    let r;
    try { r = done ? await unwrapAsync(client.fetchPack(req, { external })) : await unwrapAsync(client.negotiate(req, { external })); }
    catch (e) {
      // The server answers no request of this plan with ERR: it serves the cell or, for a degenerate deepen, dies
      // without a flush (remoteRefused=0 in every recorded run of the matrix, and in a probe of all 14,256 requests).
      // A remote_error is therefore ply sending what the server refuses, and it fails its cell like any other error.
      // It was once counted and skipped in any cell, so a ply refused in every cell passed with nothing compared.
      if (e.code === 'protocol' && /without flush/.test(e.message) && degenerate) { stats.crash++; continue; }
      assert.fail(`${label}: ${e.code} ${e.message}`);
    }
    if (!r.parsed) assert.fail(`${label}: no pack (acks ${r.acks})`);
    if (degenerate) { stats.degenerate++; continue; }
    const got = new Set(r.objects.keys());
    // bound
    for (const o of bound.required) assert.ok(got.has(o), `${label}: required ${model.type.get(o)} ${o.slice(0, 8)} missing`);
    for (const o of got) assert.ok(bound.required.has(o) || bound.had.has(o), `${label}: extra ${model.type.get(o)} ${o.slice(0, 8)} not had`);
    // model
    const modelExact = [...exp.objects].every(o => got.has(o)) && [...got].every(o => exp.objects.has(o));
    if (modelExact) stats.modelExact++;
    // oracle
    const shallowSet = new Set([...shallow.filter(c => model.commits.has(c)), ...bound.boundary]);
    const o = packObjectsOracle(bare, model, req, { shallowSet, unshallowed: bound.unshallow, inDepth: bound.inDepth, external });
    const oMissing = [...o.objects.keys()].filter(x => !got.has(x)), oExtra = [...got].filter(x => !o.objects.has(x));
    assert.equal(oMissing.length + oExtra.length, 0, `${label}: pack-objects oracle differs (oracle-only ${oMissing.length}, fetch-only ${oExtra.length})`);
    stats.oracleExact++;
    // the invocation upload-pack actually made vs our reconstruction (flags exact; lists compared as sets)
    const realArgs = readFileSync(hookLog + '.args', 'utf8').trim().replace(/^git --shallow-file \S* pack-objects /, '').replace(/^git pack-objects /, '');
    const mine = reconstructFor(model, req, { shallowSet, unshallowed: bound.unshallow });
    assert.equal(realArgs, mine.args.join(' '), `${label}: pack-objects argv`);
    assert.equal(norm(readFileSync(hookLog + '.stdin', 'utf8')), norm(mine.stdin), `${label}: pack-objects stdin`);
    stats.invocationExact++;
    // object integrity
    for (const [oid, obj] of r.objects) { assert.equal(TYPE_NAME[obj.type], model.type.get(oid), label); assert.equal(obj.data.length, model.size.get(oid), label); }
    // shallow lines
    if (dk !== 'none') { assert.deepEqual([...r.shallow].sort(), exp.shallow, `${label}: shallow lines`); assert.deepEqual([...r.unshallow].sort(), exp.unshallow, `${label}: unshallow lines`); }
    else assert.equal(r.shallow.length + r.unshallow.length, 0, label);
    // pack properties
    if (!ofsDelta) assert.equal(r.parsed.stats.ofsDelta, 0, label);
    if (!thinPack) assert.equal(r.resolved.stats.externalBases, 0, label);
    // a REF base outside the pack is one of the haves (the read side's tagged base; a `baseOid` field no longer exists)
    for (const [, obj] of r.objects) { const ref = obj.packBase.tag === 'ref' ? obj.packBase.oid : null; if (ref !== null && !r.objects.has(ref)) assert.ok(bound.had.has(ref), `${label}: thin base not derivable`); }
    assert.ok(r.resolved.stats.maxChain <= 10, label);
    seen.set(`${S.mode}|${wk}|${hk}|${dk}|${filter ?? '-'}`, got.size);
  }
  return { stats, seen: [...seen] };
}

if (parentPort) {
  const { mode } = workerData;
  let cleanup;
  try {
    ({ root, cleanup } = tmpRoot());
    const hookCfg = join(root, 'gitconfig'); hookLog = join(root, 'hooklog');
    writeFileSync(hookCfg, `[uploadpack]\n\tpackObjectsHook = ${fileURLToPath(new URL('./fuzz/pack-objects-hook.sh', import.meta.url))}\n`);
    srv = await startGitServer(root, { GIT_CONFIG_GLOBAL: hookCfg, PLY_HOOK_LOG: hookLog });
    parentPort.postMessage({ ok: true, ...(await runMode(mode)) });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: `${mode}: ${e.stack ?? e}` });
  } finally {
    await srv?.close();
    cleanup?.();
  }
}
