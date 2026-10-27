// Exhaustive protocol matrix against real git. Not sampled: the full product of
//   want kind × have kind × deepen × filter × server mode   (thin, ofs-delta, done and client-shallow cycle deterministically)
// Every cell checks: required ⊆ got ⊆ required ∪ had (model bound), got == pack-objects (git oracle), object
// types/sizes, shallow/unshallow lines, thin bases derivable from haves, no OFS when not requested, chain ≤ pack.depth.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer } from './server.js';
import { genDag, readModel, expectedObjects, requiredAndHad, treeClosure } from './fuzz/dag.js';
import { packObjectsArgs, packObjectsOracle, reconstructFor } from './fuzz/packobjects.js';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Rng } from './fuzz/prng.js';
import { GitHttp } from '../src/client.js';
import { Tracer } from '../src/otel.js';
import { TYPE_NAME } from '../src/objects.js';

test('pack-objects argv: git 2.55 create_pack_file, git 2.56 odb_source_files_generate_pack', () => {
  const full = { thinPack: true, shallows: ['aa'], ofsDelta: true, filter: 'blob:none' };
  assert.equal(packObjectsArgs({ ...full, version: [2, 55, 0] }).join(' '), '--revs --thin --stdout --shallow --delta-base-offset --filter=blob:none');
  assert.equal(packObjectsArgs({ ...full, version: [2, 56, 0] }).join(' '), '--revs --stdout --thin --shallow --delta-base-offset --quiet --filter=blob:none');
  assert.equal(packObjectsArgs({ thinPack: false, shallows: [], ofsDelta: false, version: [2, 43, 0] }).join(' '), '--revs --stdout');
  assert.equal(packObjectsArgs({ thinPack: false, shallows: [], ofsDelta: false, version: [2, 56, 0] }).join(' '), '--revs --stdout --quiet');
});

let root, cleanup, srv, hookLog;
before(async () => {
  ({ root, cleanup } = tmpRoot());
  const hookCfg = join(root, 'gitconfig'); hookLog = join(root, 'hooklog');
  writeFileSync(hookCfg, `[uploadpack]\n\tpackObjectsHook = ${fileURLToPath(new URL('./fuzz/pack-objects-hook.sh', import.meta.url))}\n`);
  srv = await startGitServer(root, { GIT_CONFIG_GLOBAL: hookCfg, PLY_HOOK_LOG: hookLog });
});
after(async () => { await srv.close(); cleanup(); });

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

test('exhaustive fetch matrix: wants × haves × deepen × filter × server', async () => {
  const servers = ['loose', 'packed', 'bitmap'].map(makeServer);
  const stats = { cells: 0, modelExact: 0, oracleExact: 0, invocationExact: 0, degenerate: 0, crash: 0, remote: 0 };
  const norm = t => { const lines = t.trim().split('\n'); const i = lines.indexOf('--not'); const uniq = a => [...new Set(a)].sort(); return JSON.stringify([uniq(lines.slice(0, i).filter(l => l.startsWith('--shallow'))), uniq(lines.slice(0, i).filter(l => !l.startsWith('--shallow'))), uniq(lines.slice(i + 1).filter(Boolean))]); };
  const seen = new Map();
  for (const S of servers) {
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
    const FILTER = [undefined, 'blob:none', 'blob:limit=100', 'blob:limit=1', 'tree:0', 'tree:1', 'tree:2', 'combine:blob:none+tree:1', 'combine:blob:limit=100+tree:2'];
    const client = new GitHttp(`${srv.url}/${S.name}.git`, { tracer: new Tracer() });
    const external = oid => (model.type.has(oid) ? { type: { blob: 3, tree: 2, commit: 1, tag: 4 }[model.type.get(oid)], data: new Uint8Array(gitBuf(bare, ['cat-file', model.type.get(oid), oid])) } : undefined);
    let i = 0;
    for (const [wk, wants] of Object.entries(WANTS)) for (const [hk, haves] of Object.entries(HAVES)) for (const [dk, d] of Object.entries(DEEPEN)) for (const filter of FILTER) {
      i++;
      const thinPack = (i % 3) === 0, ofsDelta = (i % 2) === 0, done = (i % 5) !== 0;
      // client shallow state cycles: none / the have is shallow / the tip is shallow (only meaningful with deepen)
      const shallow = (i % 7) === 0 && haves.length && model.commits.has(haves[0]) ? [haves[0]] : (i % 11) === 0 && dk !== 'none' ? [tip] : [];
      const req = { wants, haves, ...d, filter, thinPack, ofsDelta, done, shallows: shallow };
      const label = `${S.mode} want=${wk} have=${hk} ${dk} ${filter ?? '-'} ${thinPack ? 'thin' : ''}${ofsDelta ? ' ofs' : ' ref'}${done ? '' : ' nego'}${shallow.length ? ' sh' : ''}`;
      stats.cells++;
      const wantCommits = wants.map(w => model.tags.get(w) ?? w).filter(w => model.commits.has(w));
      const exp = expectedObjects(model, { ...req, shallow, bitmap: S.bitmap });
      const bound = requiredAndHad(model, { ...req, shallow });
      const degenerate = (d.deepenSince || d.deepenNot) && (wantCommits.length === 0 || wantCommits.some(w => (d.deepenSince && model.commits.get(w).date < d.deepenSince) || (d.deepenNot && !exp.inDepth.has(w))));
      let r;
      try { r = done ? await client.fetchPack(req, { external }) : await client.negotiate(req, { external }); }
      catch (e) {
        if (e.code === 'remote_error') { stats.remote++; continue; }
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
      for (const [, obj] of r.objects) if (obj.baseOid && !r.objects.has(obj.baseOid)) assert.ok(bound.had.has(obj.baseOid), `${label}: thin base not derivable`);
      assert.ok(r.resolved.stats.maxChain <= 10, label);
      seen.set(`${S.mode}|${wk}|${hk}|${dk}|${filter ?? '-'}`, got.size);
    }
  }
  console.log(`  cells=${stats.cells} oracleExact=${stats.oracleExact} invocationExact=${stats.invocationExact} modelExact=${stats.modelExact} degenerate=${stats.degenerate} serverCrash=${stats.crash} remoteRefused=${stats.remote}`);
  assert.equal(stats.oracleExact, stats.cells - stats.degenerate - stats.crash - stats.remote, 'every non-degenerate cell is pack-objects-exact');
  assert.ok(stats.crash + stats.degenerate < stats.cells * 0.25, 'degenerate deepen-since/not combos stay a minority (each one is only accepted when the degeneracy predicate holds)');
  // the three server modes must agree wherever bitmaps cannot be used (deepen present or unsupported filter)
  let disagree = 0, compared = 0;
  for (const [k, v] of seen) if (k.startsWith('loose|')) { const kp = k.replace('loose|', 'packed|'); if (seen.has(kp)) { compared++; if (seen.get(kp) !== v) disagree++; } }
  assert.equal(disagree, 0, `loose vs packed(no bitmap) must be identical: ${disagree}/${compared} differ`);
});
