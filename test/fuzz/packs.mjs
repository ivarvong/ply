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
import { unwrap } from '../unwrap.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? true] : []).filter(x => x.length));
const N = parseInt(args.n ?? '60', 10), SEED = parseInt(args.seed ?? String(Date.now() % 1e9), 10);
const { root, cleanup } = tmpRoot();
const cov = new Map(), fails = [];
let ran = 0, thinJudged = 0, fullJudged = 0, basesJudged = 0;
console.log(`packs: seed ${SEED}, n ${N}`);
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
      parsed = unwrap(parsePack(pack));
      const asked = new Map(); // every oid ply looked up outside the pack, with how often
      const external = oid => (asked.set(oid, (asked.get(oid) ?? 0) + 1), truth.has(oid) ? { type: { blob: 3, tree: 2, commit: 1, tag: 4 }[truth.get(oid).type], data: new Uint8Array(gitBuf(work, ['cat-file', truth.get(oid).type, oid])) } : undefined);
      r = unwrap(resolvePack(parsed, external));
      // the pack's own entry count (pack-format: a big-endian uint32 at bytes 8..11), read here, not by ply
      const header = Buffer.from(pack.buffer, pack.byteOffset, 12).readUInt32BE(8);
      if (r.objects.size !== header) problems.push(`resolved ${r.objects.size} objects, the pack header says ${header}`);
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
      // git's own listing of this pack, not ply's: offsets, chain depths and the exact object set. A thin pack is first
      // completed by `index-pack --fix-thin`, which appends each base the pack lacks after the pack's own entries and
      // moves none of them, so an entry at or past the original trailer (pack.length - 20) is an appended base and
      // every entry before it is an object of the pack as sent. A non-thin pack has nothing appended.
      const pdir = join(root, `vp${i}`); mkdirSync(pdir);
      const listed = join(pdir, opts.thin ? 'fixed.pack' : 'p.pack');
      if (opts.thin) gitBuf(work, ['index-pack', '--fix-thin', '--stdin', listed], pack);
      else { writeFileSync(listed, pack); git(work, ['index-pack', listed]); }
      const own = new Map(), appended = new Set();
      for (const l of git(work, ['verify-pack', '-v', listed]).split('\n').filter(l => /^[0-9a-f]{40} (commit|tree|blob|tag)/.test(l))) {
        const [oid, , , , offset, chain] = l.trim().split(/\s+/);
        if (+offset < pack.length - 20) own.set(oid, { offset: +offset, chain: chain ? +chain : 0 }); else appended.add(oid);
      }
      for (const [oid, g] of own) {
        const o = r.objects.get(oid);
        if (!o || o.offset !== g.offset || o.chain !== g.chain) { problems.push(`verify-pack offset/chain ${oid.slice(0, 8)}: git ${g.offset}/${g.chain}, ply ${o ? `${o.offset}/${o.chain}` : 'no such object'}`); break; }
      }
      for (const oid of r.objects.keys()) if (!own.has(oid)) { problems.push(`object ${oid} is not an entry of the pack in git's listing${appended.has(oid) ? ' (it is a base git appended)' : ''}`); break; }
      // the bases: ply must have asked for exactly the ones git had to append
      for (const oid of appended) if (!asked.has(oid)) { problems.push(`git appended base ${oid}, ply never asked for it`); break; }
      for (const oid of asked.keys()) if (!appended.has(oid)) { problems.push(`ply asked for base ${oid}, git did not need it`); break; }
      if (!opts.thin && appended.size) problems.push('git appended a base to a non-thin pack');
      if (opts.thin) thinJudged++; else fullJudged++;
      basesJudged += appended.size;
    } catch (e) { problems.push(`ERROR ${e.code ?? ''} ${e.message.slice(0, 120)}`); }
    const buckets = [`window.${opts.window}`, `depth.${opts.depth}`, `comp.${opts.compression}`, `ofs.${opts.ofs}`, `thin.${opts.thin}`, `sparse.${opts.sparse}`, `reuseDelta.${opts.reuseDelta}`, `reuseObject.${opts.reuseObject}`, `bigFile.${opts.bigFile}`, `objects.${parsed ? 2 ** Math.floor(Math.log2(parsed.stats.count)) : 'err'}`, `chain.${r ? Math.min(r.stats.maxChain, 9) : 'err'}`, `stored.${parsed?.stats.inflate.stored > 0}`, `ref_delta.${parsed?.stats.refDelta > 0}`, `ofs_delta.${parsed?.stats.ofsDelta > 0}`];
    for (const b of buckets) cov.set(b, (cov.get(b) ?? 0) + 1);
    process.stdout.write(`${problems.length ? 'FAIL' : 'ok  '} #${String(i).padStart(2)} seed=${seed} objs=${parsed?.stats.count ?? '-'} chain=${r?.stats.maxChain ?? '-'} ${JSON.stringify(opts)}\n`);
    ran++;
    if (problems.length) { fails.push(seed); console.log('     ' + problems.join('\n     ')); }
    rmSync(work, { recursive: true, force: true });
  }
} finally { cleanup(); }
console.log(`\n${ran} packs (seed ${SEED}), ${fails.length} failures${fails.length ? ` (case seeds ${fails.join(', ')})` : ''}; object set, offsets and chains equal to git verify-pack: ${fullJudged} whole, ${thinJudged} thin after index-pack --fix-thin (${basesJudged} appended bases). Coverage:\n` + [...cov.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([k, v]) => `${String(v).padStart(4)} ${k}`).join('\n'));
process.exit(fails.length ? 1 : 0);
