// Protocol product-space fuzz: wants × haves × deepen/deepen-since/deepen-not × filter × thin × ofs-delta ×
// done/negotiate × client shallow state × server pack settings, on generated DAG repos, against real git.
// Oracle: the object model read back from git + the exact expected-set rules calibrated in dag.js.
//   node test/fuzz/protocol.mjs [--n 300] [--seed 1] [--case <seed>]
import { treeClosure } from './dag.js';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer } from '../server.js';
import { genDag, readModel, expectedObjects, requiredAndHad } from './dag.js';
import { packObjectsOracle, reconstructFor } from './packobjects.js';
import { Rng } from './prng.js';
import { GitHttp } from '../../src/client.js';
import { Tracer, arrayExporter, flattenLine } from '../../src/otel.js';
import { TYPE_NAME } from '../../src/objects.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? true] : []).filter(x => x.length));
const N = parseInt(args.n ?? '200', 10), SEED = parseInt(args.seed ?? String(Date.now() % 1e9), 10), ONLY = args.case ? parseInt(args.case, 10) : null;

const { root, cleanup } = tmpRoot();
// capture the real pack-objects invocation through uploadpack.packObjectsHook (honored from protected config only)
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const hookCfg = join(root, 'gitconfig'); const hookLog = join(root, 'hooklog');
writeFileSync(hookCfg, `[uploadpack]\n\tpackObjectsHook = ${fileURLToPath(new URL('./pack-objects-hook.sh', import.meta.url))}\n`);
const srv = await startGitServer(root, { GIT_CONFIG_GLOBAL: hookCfg, PLY_HOOK_LOG: hookLog });
const repos = new Map(); // seed → {model, dag, name}
function repoFor(rng) {
  const key = rng.int(0, 5);
  if (repos.has(key)) return repos.get(key);
  const r = new Rng(1000 + key);
  const name = `dag${key}`;
  const bare = makeBareRepo(root, name);
  const work = join(root, `w${name}`); mkdirSync(work);
  const dag = genDag(r, work, { commits: r.int(6, 24), branches: r.int(2, 4) });
  git(work, ['push', '-q', '--all', bare]); git(work, ['push', '-q', '--tags', bare]);
  const pack = { window: r.pick([0, 1, 10, 250]), depth: r.pick([0, 1, 5, 50]), compression: r.pick([0, 1, 6, 9]) };
  for (const [k, v] of Object.entries(pack)) git(bare, ['config', `pack.${k}`, String(v)]);
  git(bare, ['config', 'uploadpack.allowFilter', 'true']);
  const gc = r.bool(0.6); if (gc) git(bare, ['gc', '-q']); // gc on a bare repo writes a bitmap index: a different object-selection path
  const useBitmaps = gc && r.bool(0.7); git(bare, ['config', 'pack.useBitmaps', String(useBitmaps)]);
  const model = readModel(bare);
  const rec = { model, dag, name, bare, pack, key, allOids: [...model.type.keys()], bitmap: useBitmaps, gc };
  repos.set(key, rec);
  return rec;
}

const cov = new Map();
const fails = [];
const seeds = ONLY !== null ? [ONLY] : Array.from({ length: N }, (_, i) => (SEED * 7919 + i * 104729) >>> 0);
try {
  for (let i = 0; i < seeds.length; i++) {
    const rng = new Rng(seeds[i]);
    const R = repoFor(rng);
    const { model, dag } = R;
    const commits = [...model.commits.keys()];
    const blobs = R.allOids.filter(o => model.type.get(o) === 'blob'), trees = R.allOids.filter(o => model.type.get(o) === 'tree');
    const tagOid = model.refs.get('refs/tags/v1');
    const pickWant = () => rng.weighted([[rng.pick(commits), 6], [dag.tip, 3], [tagOid, 1], [rng.pick(trees), 1], [rng.pick(blobs), 1]]);
    const wants = Array.from(new Set(Array.from({ length: rng.weighted([[1, 6], [2, 2], [3, 1]]) }, pickWant)));
    const pickHave = () => rng.weighted([[rng.pick(commits), 6], ['f'.repeat(39) + rng.int(0, 9), 1], [wants[0], 1], [tagOid, 1], [rng.pick(blobs), 1]]);
    const haves = Array.from(new Set(Array.from({ length: rng.weighted([[0, 4], [1, 3], [2, 2], [4, 1], [8, 1]]) }, pickHave)));
    const deepen = rng.weighted([[undefined, 5], [1, 2], [2, 2], [3, 1], [5, 1], [50, 1]]);
    const deepenSince = deepen === undefined && rng.bool(0.15) ? 1700000000 + rng.int(0, 24) * 1000 - 500 : undefined;
    const deepenNot = deepen === undefined && !deepenSince && rng.bool(0.15) ? [rng.pick([...model.refs.keys()])] : [];
    const filters = [undefined, 'blob:none', `blob:limit=${rng.pick([0, 1, 100, 1000, 5000])}`, `tree:${rng.int(0, 4)}`];
    let filter = rng.weighted([[filters[0], 4], [filters[1], 2], [filters[2], 2], [filters[3], 2], ['combine', 1]]);
    if (filter === 'combine') filter = `combine:${rng.pick(filters.slice(1))}+${rng.pick(filters.slice(1))}`;
    const thinPack = rng.bool(0.3), ofsDelta = rng.bool(0.7), done = rng.bool(0.75);
    // client shallow state: declare some commits shallow (we "have" them but not their parents)
    const shallow = haves.filter(h => model.commits.has(h)).filter(() => rng.bool(0.25));
    const req = { wants, haves, deepen, deepenSince, deepenNot, filter, thinPack, ofsDelta, done, shallows: shallow };
    const exp = expectedObjects(model, { wants, haves, deepen, deepenSince, deepenNot, filter, shallow, bitmap: R.bitmap, thinPack });
    // degenerate deepen-since/not: a want older than since, a want cut by deepen-not, or no commit wants at all.
    // git 2.43 upload-pack either dies mid-response or applies rev-list slop semantics we do not model.
    const wantCommits = wants.map(w => model.tags.get(w) ?? w).filter(w => model.commits.has(w));
    const degenerate = (deepenSince || deepenNot.length) && (wantCommits.length === 0 || wantCommits.some(w => (deepenSince && model.commits.get(w).date < deepenSince) || (deepenNot.length && !exp.inDepth.has(w))));
    const exporter = arrayExporter();
    const c = new GitHttp(`${srv.url}/${R.name}.git`, { tracer: new Tracer({ exporter }) });
    const external = oid => (model.type.has(oid) ? { type: { blob: 3, tree: 2, commit: 1, tag: 4 }[model.type.get(oid)], data: new Uint8Array(gitBuf(R.bare, ['cat-file', model.type.get(oid), oid])) } : undefined);
    const problems = [];
    let r, usedNegotiate = false;
    const t0 = performance.now();
    try {
      r = done ? await c.fetchPack(req, { external }) : await c.negotiate(req, { external });
      usedNegotiate = !done;
      if (!r.parsed) throw Object.assign(new Error(`no pack (acks=${r.acks} nak=${r.nak})`), { code: 'nopack' });
    } catch (e) {
      r = null;
      // the only legitimate server refusals: want of an object the server will not serve, or deepen on non-commits
      const legit = e.code === 'remote_error';
      // git 2.43 upload-pack dies mid-response (after "shallow-info") for deepen-since combined with client shallow lines
      const serverCrash = e.code === 'protocol' && /without flush/.test(e.message) && degenerate;
      problems.push(`${legit ? 'remote refused' : serverCrash ? 'server crash (known)' : 'ERROR'}: ${e.code} ${e.message.slice(0, 140)}`);
      if (legit || serverCrash) { cov.set(legit ? 'remote_error' : 'server_crash.deepen_since+shallow', (cov.get(legit ? 'remote_error' : 'server_crash.deepen_since+shallow') ?? 0) + 1); problems.length = 0; }
    }
    const ms = performance.now() - t0;
    if (r && degenerate) { cov.set('degenerate_deepen.pack', (cov.get('degenerate_deepen.pack') ?? 0) + 1); }
    else if (r) {
      const got = new Set(r.objects.keys());
      // (1) two-sided bound from the model: everything required is present; every extra is something the client has
      const bound = requiredAndHad(model, { wants, haves, deepen, deepenSince, deepenNot, filter, shallow });
      const missingReq = [...bound.required].filter(o => !got.has(o)), extraNotHad = [...got].filter(o => !bound.required.has(o) && !bound.had.has(o));
      if (missingReq.length) problems.push(`BOUND: ${missingReq.length} required objects missing [${missingReq.slice(0, 3).map(o => model.type.get(o)).join(',')}]`);
      if (missingReq.length && process.env.PROTO_DEBUG) {
        const where = o => { const out = []; for (const w of wants) { const roots = model.commits.has(w) ? [model.commits.get(w).tree] : model.type.get(w) === 'tree' ? [w] : []; for (const r of roots) { const d = treeClosure(model, [r]).get(o); if (d !== undefined) out.push(`${w.slice(0, 7)}(${model.type.get(w)})@${d}`); } } return out.join(' '); };
        console.log('  haves:', haves.map(h => `${h.slice(0, 7)}:${model.type.get(h)}`).join(' '), ' wants:', wants.map(w => `${w.slice(0, 7)}:${model.type.get(w)}`).join(' '));
        for (const o of missingReq) console.log(`  missing ${o.slice(0, 7)} ${model.type.get(o)} reachable via ${where(o)}; had? ${bound.had.has(o)}`);
        const rl = extra => git(R.bare, ['rev-list', '--objects', `--filter=${filter}`, ...wants, ...extra]).toString();
        for (const o of missingReq) console.log(`  rev-list ${o.slice(0, 7)}: no-have=${rl([]).includes(o)} with ^have=${rl(['--not', ...haves]).includes(o)}`);
        for (const h of haves) if (model.type.get(h) === 'tree') console.log(`  have-tree ${h.slice(0,7)} contains: ${[...treeClosure(model, [h]).entries()].map(([o, d]) => o.slice(0, 7) + '@' + d).join(' ')}`);
      }
      if (extraNotHad.length) problems.push(`BOUND: ${extraNotHad.length} extra objects the client does not have [${extraNotHad.slice(0, 3).map(o => model.type.get(o)).join(',')}]`);
      // (2) the calibrated model (bitmap vs traversal rules); a mismatch here is a modeling gap, reported but weaker
      const missing = [...exp.objects].filter(o => !got.has(o)), extra = [...got].filter(o => !exp.objects.has(o));
      const modelOk = !missing.length && !extra.length;
      cov.set(`model.${exp.mode}.${modelOk ? 'exact' : 'approx'}`, (cov.get(`model.${exp.mode}.${modelOk ? 'exact' : 'approx'}`) ?? 0) + 1);
      // (3) exact oracle: pack-objects invoked as upload-pack does → identical object set
      { // pack-objects run in the same repo takes the same bitmap/traversal decision upload-pack does
        // grafts registered for this request: every client shallow (send_unshallow re-registers even the unshallowed ones), plus the new boundary
        const shallowSet = new Set([...shallow.filter(c => model.commits.has(c)), ...bound.boundary]);
        try {
          const o = packObjectsOracle(R.bare, model, req, { shallowSet, unshallowed: bound.unshallow, inDepth: bound.inDepth, external });
          const oMissing = [...o.objects.keys()].filter(x => !got.has(x)), oExtra = [...got].filter(x => !o.objects.has(x));
          if (oMissing.length || oExtra.length) problems.push(`ORACLE: pack-objects set differs: oracle-only ${oMissing.length} [${oMissing.slice(0, 3).map(x => model.type.get(x)).join(',')}] fetch-only ${oExtra.length} [${oExtra.slice(0, 3).map(x => model.type.get(x)).join(',')}]`);
          else cov.set(`oracle.exact.${exp.mode}`, (cov.get(`oracle.exact.${exp.mode}`) ?? 0) + 1);
          // and the invocation itself: what upload-pack actually ran vs what we reconstruct from the model
          try {
            const realArgs = readFileSync(hookLog + '.args', 'utf8').trim().replace(/^git --shallow-file \S* pack-objects /, '').replace(/^git pack-objects /, '');
            const realStdin = readFileSync(hookLog + '.stdin', 'utf8');
            const mine = reconstructFor(model, req, { shallowSet, unshallowed: bound.unshallow });
            // compare modulo duplicate entries: send_unshallow's re-parse may list a parent twice depending on in-memory parse state
            const norm = t => { const lines = t.trim().split('\n'); const i = lines.indexOf('--not'); const uniq = a => [...new Set(a)].sort(); return JSON.stringify([uniq(lines.slice(0, i).filter(l => l.startsWith('--shallow'))), uniq(lines.slice(0, i).filter(l => !l.startsWith('--shallow'))), uniq(lines.slice(i + 1).filter(Boolean))]); };
            if (realArgs !== mine.args.join(' ') || norm(realStdin) !== norm(mine.stdin)) problems.push(`INVOCATION differs:\n       real: ${realArgs} | ${realStdin.trim().split('\n').join(' | ')}\n       mine: ${mine.args.join(' ')} | ${mine.stdin.trim().split('\n').join(' | ')}`);
            else cov.set('invocation.exact', (cov.get('invocation.exact') ?? 0) + 1);
          } catch (e) { problems.push(`INVOCATION capture failed: ${e.message}`); }
        } catch (e) { problems.push(`ORACLE failed: ${e.message.slice(0, 120)}`); }
      }
      for (const [oid, o] of r.objects) {
        if (TYPE_NAME[o.type] !== model.type.get(oid)) { problems.push(`type ${oid}`); break; }
        if (o.data.length !== model.size.get(oid)) { problems.push(`size ${oid}`); break; }
        if (rng.bool(0.2) && !Buffer.from(o.data).equals(gitBuf(R.bare, ['cat-file', model.type.get(oid), oid]))) { problems.push(`content ${oid}`); break; }
      }
      if (deepen !== undefined || deepenSince || deepenNot.length) {
        const gotShallow = [...r.shallow].sort(), gotUn = [...r.unshallow].sort();
        if (gotShallow.join() !== exp.shallow.join()) problems.push(`shallow lines got ${gotShallow.length} exp ${exp.shallow.length}`);
        if (gotUn.join() !== exp.unshallow.join()) problems.push(`unshallow lines got ${gotUn.length} exp ${exp.unshallow.length}`);
      } else if (r.shallow.length || r.unshallow.length) problems.push('shallow lines without deepen');
      if (!ofsDelta && r.parsed.stats.ofsDelta) problems.push('ofs delta despite not requested');
      if (!thinPack && r.resolved.stats.externalBases) problems.push('external base in non-thin pack');
      if (thinPack && r.resolved.stats.externalBases) {
        // client safety: every thin base must be resolvable from what the client declared it has (full closure of haves)
        for (const [, o] of r.objects) if (o.baseOid && !r.objects.has(o.baseOid) && !bound.had.has(o.baseOid)) { problems.push(`thin base ${o.baseOid.slice(0, 8)} (${model.type.get(o.baseOid)}) not derivable from the client's haves`); break; }
      }
      if (R.pack.depth && r.resolved.stats.maxChain > R.pack.depth) problems.push(`chain ${r.resolved.stats.maxChain} > pack.depth ${R.pack.depth}`);
      const span = exporter.lines.flatMap(flattenLine).filter(s => s.name === 'git.upload-pack fetch').pop();
      if (span.attrs['git.pack.objects'] !== got.size) problems.push('span object count');
      // negotiation: acks ⊆ haves the server has; a NAK round means no common
      if (usedNegotiate) {
        const known = new Set(haves.filter(h => model.type.has(h)));
        for (const rd of r.rounds) for (const a of rd.acks) if (!known.has(a)) problems.push(`ack for unknown ${a.slice(0, 8)}`);
        if (r.rounds.some(rd => rd.nak && rd.acks.length)) problems.push('NAK with acks');
      }
      // coverage
      const b = [`wants.${wants.length}`, `haves.${Math.min(haves.length, 4)}`, `deepen.${deepen ?? (deepenSince ? 'since' : deepenNot.length ? 'not' : 'none')}`, `filter.${(filter ?? 'none').replace(/=\d+/, '').replace(/:\d/, ':N')}`, `thin.${thinPack}`, `ofs.${ofsDelta}`, `done.${done}`, `shallow.${shallow.length > 0}`, `want_types.${[...new Set(wants.map(w => model.type.get(w)))].sort().join('+')}`, `pack.depth.${R.pack.depth}`, `pack.window.${R.pack.window}`, `chain.${Math.min(r.resolved.stats.maxChain, 5)}`, `objects.${got.size === 0 ? 0 : 2 ** Math.floor(Math.log2(got.size))}`, `ext_bases.${r.resolved.stats.externalBases > 0}`, `shallow_lines.${r.shallow.length > 0}`, `mode.${exp.mode}`, `server.${R.gc ? (R.bitmap ? 'bitmap' : 'packed') : 'loose'}`, `unshallow_lines.${r.unshallow.length > 0}`, ...(usedNegotiate ? [`rounds.${r.rounds.length}`, `ready.${r.ready}`, `nak.${r.rounds.some(x => x.nak)}`] : [])];
      for (const x of b) cov.set(x, (cov.get(x) ?? 0) + 1);
    }
    const tag = problems.length ? 'FAIL' : 'ok  ';
    process.stdout.write(`${tag} #${String(i).padStart(3)} seed=${seeds[i]} repo=${R.key}${R.bitmap ? 'B' : R.gc ? 'P' : 'L'} w=${wants.length}${wants.map(w => model.type.get(w)[0]).join('')} h=${haves.length} ${deepen !== undefined ? 'd' + deepen : deepenSince ? 'since' : deepenNot.length ? 'not' : '  '} ${(filter ?? '-').padEnd(26)} ${thinPack ? 'thin' : '    '} ${ofsDelta ? 'ofs' : 'ref'} ${done ? 'done' : 'nego'} ${shallow.length ? 'sh' + shallow.length : '   '} → ${r ? r.parsed.stats.count : '-'} obj ${String(ms | 0).padStart(4)}ms\n`);
    if (problems.length) {
      fails.push(seeds[i]);
      const idx = o => { const k = dag.commitOids.indexOf(o); return k >= 0 ? 'c' + k : (model.type.get(o)?.[0] ?? '?') + o.slice(0, 6); };
      console.log('     ' + problems.join('\n     ') + `\n     repro: node test/fuzz/protocol.mjs --case ${seeds[i]}`);
      console.log('     graph:', [...model.commits.entries()].map(([c, v]) => `${idx(c)}(${(v.date - 1700000000) / 1000})←${v.parents.map(idx).join(',')}`).join(' '));
      console.log('     req:', JSON.stringify({ wants: wants.map(idx), haves: haves.map(idx), deepen, deepenSince, deepenNot, filter, thinPack, ofsDelta, done, shallows: shallow.map(idx), mode: exp.mode, server: R.gc ? (R.bitmap ? 'bitmap' : 'packed') : 'loose' }));
      if (r) {
        const got = new Set(r.objects.keys());
        console.log('     got commits:', [...got].filter(o => model.commits.has(o)).map(idx).join(' '), '| exp:', [...exp.objects].filter(o => model.commits.has(o)).map(idx).join(' '));
        console.log('     missing:', [...exp.objects].filter(o => !got.has(o)).map(idx).join(' '), '| extra:', [...got].filter(o => !exp.objects.has(o)).map(idx).join(' '));
        console.log('     shallow got:', r.shallow.map(idx), 'exp:', exp.shallow.map(idx), 'unshallow got:', r.unshallow.map(idx), 'exp:', exp.unshallow.map(idx));
        console.log('     ext bases:', [...r.objects.values()].filter(o => o.baseOid && !r.objects.has(o.baseOid)).map(o => idx(o.baseOid)).join(' '));
      } else {
        const { fetchBody } = await import('../../src/client.js');
        const res = await fetch(`${srv.url}/${R.name}.git/git-upload-pack`, { method: 'POST', headers: { 'Content-Type': 'application/x-git-upload-pack-request', 'Git-Protocol': 'version=2' }, body: fetchBody(req) });
        console.log('     raw:', res.status, JSON.stringify(Buffer.from(await res.arrayBuffer()).toString('latin1').slice(0, 200)));
      }
    }
  }
} finally { await srv.close(); cleanup(); }
console.log(`\n${seeds.length} cases, ${fails.length} failures. Coverage (${cov.size} buckets):`);
console.log([...cov.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([k, v]) => `${String(v).padStart(4)} ${k}`).join('\n'));
process.exit(fails.length ? 1 : 0);
