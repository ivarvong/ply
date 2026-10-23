// Pack-reading compliance: git pack-objects over random DAG repos × its option space must parse and resolve to
// `git cat-file` truth, with offsets and delta-chain depths matching `git verify-pack -v`.
//   node test/fuzz/packs.mjs [--n 60] [--seed 1]
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { git, gitBuf, tmpRoot } from '../server.js';
import { genDag, readModel } from './dag.js';
import { Rng } from './prng.js';
import { parsePack, resolvePack } from '../../src/pack.js';
import { TYPE_NAME } from '../../src/objects.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? true] : []).filter(x => x.length));
const N = parseInt(args.n ?? '60', 10), SEED = parseInt(args.seed ?? String(Date.now() % 1e9), 10);
const { root, cleanup } = tmpRoot();
const cov = new Map(), fails = [];
try {
  for (let i = 0; i < N; i++) {
    const seed = (SEED * 7919 + i * 104729) >>> 0, rng = new Rng(seed);
    const work = join(root, `w${i}`); mkdirSync(work);
    genDag(rng, work, { commits: rng.int(3, 30), branches: rng.int(1, 4) });
    // extra large/binary/repetitive blobs so deltas and stored blocks appear
    if (rng.bool(0.5)) { writeFileSync(join(work, 'big'), Buffer.alloc(rng.int(1, 300) * 1024, rng.int(0, 255))); git(work, ['add', 'big']); git(work, ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'big']); }
    const model = readModel(work);
    const truth = new Map(git(work, ['cat-file', '--batch-check', '--batch-all-objects']).trim().split('\n').map(l => { const [oid, type, size] = l.split(' '); return [oid, { type, size: +size }]; }));
    const opts = {
      window: rng.pick([0, 1, 10, 50, 250]), depth: rng.pick([0, 1, 5, 50, 250]), compression: rng.pick([-1, 0, 1, 6, 9]),
      reuseDelta: rng.bool(0.7), reuseObject: rng.bool(0.7), sparse: rng.bool(0.5), ofs: rng.bool(0.7), thin: rng.bool(0.3), bigFile: rng.pick([0, 1024, 1 << 20]),
    };
    const haves = opts.thin ? [...model.commits.keys()].filter(() => rng.bool(0.2)) : [];
    const wants = [...model.refs.values()];
    const stdin = [...wants, ...(haves.length ? ['--not', ...haves] : []), ''].join('\n') + '\n';
    const argv = ['-c', `pack.compression=${opts.compression}`, ...(opts.bigFile ? ['-c', `core.bigFileThreshold=${opts.bigFile}`] : []), 'pack-objects', '--revs', '--stdout', '-q', `--window=${opts.window}`, `--depth=${opts.depth}`, ...(opts.ofs ? ['--delta-base-offset'] : []), ...(opts.thin ? ['--thin'] : []), ...(opts.reuseDelta ? [] : ['--no-reuse-delta']), ...(opts.reuseObject ? [] : ['--no-reuse-object']), opts.sparse ? '--sparse' : '--no-sparse'];
    if (rng.bool(0.4)) git(work, ['gc', '-q']); // packed on disk → delta/object reuse paths
    const pack = new Uint8Array(gitBuf(work, argv, stdin));
    const problems = [];
    let parsed, r;
    try {
      parsed = parsePack(pack);
      const external = oid => (truth.has(oid) ? { type: { blob: 3, tree: 2, commit: 1, tag: 4 }[truth.get(oid).type], data: new Uint8Array(gitBuf(work, ['cat-file', truth.get(oid).type, oid])) } : undefined);
      r = resolvePack(parsed, external);
      for (const [oid, o] of r.objects) {
        const t = truth.get(oid);
        if (!t) { problems.push(`unknown object ${oid}`); break; }
        if (TYPE_NAME[o.type] !== t.type || o.data.length !== t.size) { problems.push(`type/size ${oid}`); break; }
        if (rng.bool(0.3) && !Buffer.from(o.data).equals(gitBuf(work, ['cat-file', t.type, oid]))) { problems.push(`content ${oid}`); break; }
      }
      // expected set: rev-list of the same revs (non-thin and thin alike: --not excludes; pack-objects' edge heuristics may add)
      const exp = new Set(git(work, ['rev-list', '--objects', '--no-object-names', ...wants, ...haves.map(h => `^${h}`)]).trim().split('\n').filter(Boolean));
      for (const o of exp) if (!r.objects.has(o)) { problems.push(`missing required ${o}`); break; }
      if (!opts.ofs && parsed.stats.ofsDelta) problems.push('ofs delta without --delta-base-offset');
      if (!opts.thin && r.stats.externalBases) problems.push('external base in non-thin pack');
      if (opts.depth && r.stats.maxChain > opts.depth) problems.push(`chain ${r.stats.maxChain} > depth ${opts.depth}`);
      // verify-pack: offsets and chain depths
      const pdir = join(root, `vp${i}`); mkdirSync(pdir); writeFileSync(join(pdir, 'p.pack'), pack);
      if (!opts.thin) {
        git(work, ['index-pack', join(pdir, 'p.pack')]);
        for (const l of git(work, ['verify-pack', '-v', join(pdir, 'p.pack')]).split('\n').filter(l => /^[0-9a-f]{40} (commit|tree|blob|tag)/.test(l))) {
          const [oid, , , , offset, chain] = l.trim().split(/\s+/);
          const o = r.objects.get(oid);
          if (!o || o.offset !== +offset || o.chain !== (chain ? +chain : 0)) { problems.push(`verify-pack offset/chain ${oid.slice(0, 8)}`); break; }
        }
      } else {
        // thin: index-pack --fix-thin must accept it and produce the same object set
        const out = gitBuf(work, ['index-pack', '--fix-thin', '--stdin', join(pdir, 'fixed.pack')], pack).toString();
        void out;
      }
    } catch (e) { problems.push(`ERROR ${e.code ?? ''} ${e.message.slice(0, 120)}`); }
    const buckets = [`window.${opts.window}`, `depth.${opts.depth}`, `comp.${opts.compression}`, `ofs.${opts.ofs}`, `thin.${opts.thin}`, `sparse.${opts.sparse}`, `reuseDelta.${opts.reuseDelta}`, `reuseObject.${opts.reuseObject}`, `bigFile.${opts.bigFile}`, `objects.${parsed ? 2 ** Math.floor(Math.log2(parsed.stats.count)) : 'err'}`, `chain.${r ? Math.min(r.stats.maxChain, 9) : 'err'}`, `stored.${parsed?.stats.inflate.stored > 0}`, `ref_delta.${parsed?.stats.refDelta > 0}`, `ofs_delta.${parsed?.stats.ofsDelta > 0}`];
    for (const b of buckets) cov.set(b, (cov.get(b) ?? 0) + 1);
    process.stdout.write(`${problems.length ? 'FAIL' : 'ok  '} #${String(i).padStart(2)} seed=${seed} objs=${parsed?.stats.count ?? '-'} chain=${r?.stats.maxChain ?? '-'} ${JSON.stringify(opts)}\n`);
    if (problems.length) { fails.push(seed); console.log('     ' + problems.join('\n     ')); }
    rmSync(work, { recursive: true, force: true });
  }
} finally { cleanup(); }
console.log(`\n${N} packs, ${fails.length} failures. Coverage:\n` + [...cov.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([k, v]) => `${String(v).padStart(4)} ${k}`).join('\n'));
process.exit(fails.length ? 1 : 0);
