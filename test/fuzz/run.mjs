// Telemetry-steered fuzz loop against real git.
//   node test/fuzz/run.mjs [--n 200] [--seed 1] [--case <seed>] [--out fuzz-out]
// Every case: generate repo+edit from a seed (optionally steered toward an under-covered bucket),
// run editFile against git http-backend, check git's truth, bucketize the OTLP spans, steer.
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, fsckProblems } from '../server.js';
import { Rng } from './prng.js';
import { genCase, KNOBS } from './gen.js';
import { editFile } from '../../src/edit.js';
import { Tracer, flattenLine } from '../../src/otel.js';
import { jsonlExporter } from '../jsonl.mjs';
import { hashObject } from '../../src/objects.js';
import { concat } from '../../src/bytes.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? true] : []).filter(x => x.length));
const N = parseInt(args.n ?? process.env.FUZZ_N ?? '60', 10);
const SEED = parseInt(args.seed ?? process.env.SEED ?? String(Date.now() % 1e9), 10);
const OUT = args.out ?? 'fuzz-out';
const ONLY = args.case ? parseInt(args.case, 10) : null;
mkdirSync(OUT, { recursive: true });

// ---- coverage buckets derived from spans (the steering signal) ----
const log2b = v => (v <= 0 ? '0' : `2^${Math.floor(Math.log2(v))}`);
export function buckets(spans) {
  const b = new Set();
  const root = spans.find(s => s.name === 'git.edit');
  if (root) {
    b.add(`outcome.${root.attrs['git.edit.outcome']}`);
    b.add(`depth.${root.attrs['git.edit.path.depth']}`);
    b.add(`cache_hits.${root.attrs['git.edit.tree.cache_hits'] ?? 0}`);
    if (root.attrs['git.edit.push.ratio'] !== undefined) b.add(`push.ratio.${root.attrs['git.edit.push.ratio'] < 1 ? 'lt1' : root.attrs['git.edit.push.ratio'] < 10 ? 'lt10' : 'ge10'}`);
    b.add(`mem.max_single.${log2b(root.attrs['mem.alloc.max_single'] ?? 0)}`);
  }
  for (const s of spans) {
    const a = s.attrs;
    if (s.name === 'git.upload-pack fetch') {
      b.add(`fetch.filter.${a['git.fetch.filter'] || 'none'}`);
      if (a['git.pack.inflate.stored'] > 0) b.add('inflate.stored');
      if (a['git.pack.inflate.fixed'] > 0) b.add('inflate.fixed');
      if (a['git.pack.inflate.dynamic'] > 0) b.add('inflate.dynamic');
      if (a['git.pkt.carry.max'] > 0) b.add('pkt.carry');
      if (a['git.pkt.payload.max'] >= 65516) b.add('pkt.max_payload');
      if (a['http.response.chunks'] > 1) b.add('http.multi_chunk');
      if (a['git.sideband.band2.frames'] > 0) b.add('sideband.band2');
      if (a['git.fetch.shallow']?.length) b.add('fetch.shallow');
      if (a['git.pack.objects'] !== undefined) b.add(`pack.objects.${log2b(a['git.pack.objects'])}`);
      if (a['git.pack.chain.max'] > 0) b.add(`pack.chain.${a['git.pack.chain.max']}`);
    }
    if (s.name === 'git.edit.tree') {
      b.add(`tree.entries.${log2b(a['git.edit.tree.entries'])}`);
      b.add(`tree.mode.${a['git.edit.tree.entry.mode']}`);
      if (a['git.edit.tree.cache_hit']) b.add('tree.cache_hit');
      if (!a['git.edit.tree.entry.found']) b.add('tree.entry.missing');
    }
    if (s.name === 'git.edit.blob') {
      b.add(`blob.base_len.${log2b(a['git.edit.blob.base_len'])}`);
      if (a['git.edit.blob.scan.chunks'] > 1) b.add('scan.multi_chunk');
      if (a['git.edit.blob.scan.chunks'] > 8) b.add('scan.many_chunks');
      b.add(`scan.matches.${Math.min(3, a['git.edit.blob.scan.matches'])}`);
      const off = a['git.edit.blob.match_offset'], cm = a['git.edit.blob.scan.chunk.max'];
      if (off !== undefined && cm > 0 && off % cm > cm - 8) b.add('scan.match_crosses_chunk');
      if (a['git.edit.blob.delta.copy_ops'] >= 3) b.add('delta.copy_ops>=3');
      if (a['git.edit.blob.delta.insert_ops'] >= 2) b.add('delta.insert_ops>=2');
      if (a['git.edit.blob.delta.insert_ops'] === 0) b.add('delta.insert_ops=0');
      if (a['git.edit.blob.base_len'] === 0) b.add('blob.empty');
      if (a['git.edit.blob.new_len'] === 0) b.add('blob.new_empty');
      if (a['git.edit.blob.new_len'] < a['git.edit.blob.base_len']) b.add('blob.shrinks');
    }
    if (s.name === 'git.receive-pack') {
      b.add(`push.objects.${a['git.push.pack.objects']}`);
      b.add(`push.bytes.${log2b(a['git.push.pack.bytes'])}`);
      if (a['git.push.ng.reason']) b.add('push.ng');
    }
    if (s.status?.code === 2) b.add(`error.${a['error.type'] ?? 'unknown'}`);
  }
  return b;
}

// bucket → knob hints that are likely to reach it
const TARGETS = {
  'inflate.stored': { compression: '0' }, 'inflate.fixed': { blob: 'tiny' }, 'inflate.dynamic': { blob: 'text' },
  'scan.multi_chunk': { blob: 'big' }, 'scan.many_chunks': { blob: 'big' }, 'scan.match_crosses_chunk': { blob: 'big', pos: 'chunk16k' },
  'pkt.carry': { blob: 'big' }, 'pkt.max_payload': { blob: 'big' }, 'http.multi_chunk': { blob: 'big' },
  'delta.copy_ops>=3': { blob: 'big', pos: 'middle' }, 'delta.insert_ops>=2': { replace: 'over127' }, 'delta.insert_ops=0': { replace: 'empty' },
  'blob.empty': { blob: 'empty', pos: 'start', outcome: 'ok' }, 'blob.new_empty': { blob: 'empty', replace: 'empty', outcome: 'ok' }, 'blob.shrinks': { replace: 'shorter' },
  'tree.entries.2^4': { siblings: 'many' }, 'tree.entries.2^5': { siblings: 'many' }, 'tree.mode.100755': { mode: '100755', outcome: 'ok' }, 'tree.cache_hit': { outcome: 'ok' }, 'server.bitmap': { server: 'bitmap' }, 'server.midx-bitmap': { server: 'midx-bitmap' }, 'server.mixed': { server: 'mixed' }, 'server.packed': { server: 'packed' },
  'outcome.ok': { outcome: 'ok' }, 'outcome.noop': { replace: 'identical', outcome: 'ok' }, 'outcome.match_count': { outcome: 'zero_matches' }, 'outcome.not_found': { outcome: 'missing_path' }, 'outcome.cas_conflict': { outcome: 'cas_conflict' },
  'scan.matches.2': { outcome: 'two_matches' }, 'scan.matches.0': { outcome: 'zero_matches' },
  ...Object.fromEntries(KNOBS.depth.map(d => [`depth.${d}`, { depth: d }])),
  'fetch.shallow': { history: '2' }, 'push.ratio.lt1': { blob: 'big', replace: 'same' }, 'push.ratio.ge10': { blob: 'tiny', replace: 'huge' },
  'sortedge': { siblings: 'sortedge' }, 'compression.9': { compression: '9' }, 'compression.1': { compression: '1' },
};

// ---- one case ----
// One fast-import stream onto refs/heads/main: each commit adds/replaces `files` on top of the previous tree.
const te = new TextEncoder();
const cquote = p => '"' + [...te.encode(p)].map(b => b === 0x22 ? '\\"' : b === 0x5c ? '\\\\' : b < 0x20 || b >= 0x7f ? '\\' + b.toString(8).padStart(3, '0') : String.fromCharCode(b)).join('') + '"';
function commits(dir, list, fromExisting = false) {
  const parts = [];
  list.forEach(({ who, msg, files }, i) => {
    parts.push(te.encode(`commit refs/heads/main\ncommitter ${who} <${who}@x> now\ndata ${te.encode(msg).length}\n${msg}\n`));
    if (i === 0 && fromExisting) parts.push(te.encode('from refs/heads/main^0\n'));
    for (const [p, v] of Object.entries(files)) {
      const d = v.symlink ? te.encode(v.symlink) : typeof v.data === 'string' ? te.encode(v.data) : v.data;
      parts.push(te.encode(`M ${v.symlink ? '120000' : v.mode} inline ${cquote(p)}\ndata ${d.length}\n`), d, te.encode('\n'));
    }
  });
  parts.push(te.encode('done\n'));
  // core.ignorecase=false: `git init` sets it on macOS, and fast-import would then fold `A` into `a` (one entry, not two)
  gitBuf(dir, ['-c', 'core.ignorecase=false', 'fast-import', '--quiet', '--date-format=now', '--done'], concat(parts));
}

async function runCase(ctx, seed, hints) {
  const rng = new Rng(seed);
  const c = genCase(rng, hints);
  const name = `c${seed}`;
  const bare = makeBareRepo(ctx.root, name);
  git(bare, ['config', 'core.compression', String(c.compression)]);
  git(bare, ['config', 'pack.compression', String(c.compression)]);
  const work = join(ctx.root, `w${seed}`); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  // Commits are built with `git fast-import`, never a checkout: case-only twins (`a/` beside `A`), valid in git, would
  // collide in a worktree on a case-insensitive filesystem (macOS) and crash the harness. Modes and symlinks go in as-is.
  const commit = (who, msg, files, fromExisting = false) => commits(work, [{ who, msg, files }], fromExisting);
  // history: earlier commits with a different version of the target so trees/blobs have ancestry
  const plan = [];
  for (let h = 1; h < c.history; h++) plan.push({ who: 'h', msg: `h${h}`, files: { ...(h === 1 ? c.files : {}), [`hist${h}.txt`]: { mode: '100644', data: rng.bytes(rng.int(0, 50)) } } });
  plan.push({ who: 'seed', msg: 'seed', files: c.files });
  commits(work, plan);
  git(work, ['push', '-q', bare, 'HEAD:refs/heads/main']);
  // server object-store shape: GitHub serves from packed, bitmapped, multi-pack-indexed stores
  switch (c.knobs.server) {
    case 'packed': git(bare, ['-c', 'repack.writeBitmaps=false', 'gc', '-q']); break;
    case 'bitmap': git(bare, ['-c', 'repack.writeBitmaps=true', 'gc', '-q']); break;
    case 'midx-bitmap': git(bare, ['-c', 'repack.writeBitmaps=false', 'gc', '-q']); git(bare, ['multi-pack-index', 'write', '--bitmap']); git(bare, ['config', 'core.multiPackIndex', 'true']); break;
    case 'mixed': git(bare, ['-c', 'repack.writeBitmaps=true', 'gc', '-q']); commit('l', 'late', { 'late.txt': { mode: '100644', data: 'late' } }, true); git(work, ['push', '-q', bare, 'HEAD:refs/heads/main']); break; // bitmapped pack + loose objects on top
  }
  const oldHead = git(bare, ['rev-parse', 'main']).trim();

  const lines = [];
  const tracer = new Tracer({ exporter: l => { lines.push(l); ctx.trace(l); }, resource: { 'fuzz.seed': seed } });
  // CAS conflict injection: move main between our ls-refs and our push.
  let raced = null;
  const fetchImpl = c.knobs.outcome === 'cas_conflict' ? async (url, init) => {
    if (url.endsWith('/git-receive-pack') && !raced) { commit('r', 'race', { 'race.txt': { mode: '100644', data: 'race' } }, true); git(work, ['push', '-q', bare, 'HEAD:refs/heads/main']); raced = git(bare, ['rev-parse', 'main']).trim(); }
    return fetch(url, init);
  } : undefined;
  const cache = new Map();
  let result = null, err = null;
  const t0 = performance.now();
  try {
    result = await editFile(`${ctx.url}/${name}.git`, { path: c.editPath, find: c.find, replace: c.replace, author: { name: 'fuzz', email: 'fuzz@x' }, message: `fuzz ${seed}` }, { tracer, cache, fetchImpl });
  } catch (e) { err = e; }
  const ms = performance.now() - t0;
  const spans = lines.flatMap(flattenLine);
  const head = git(bare, ['rev-parse', 'main']).trim();
  const problems = [];
  const outcome = err ? (err.code ?? 'error') : result?.noop ? 'noop' : 'ok';
  if (outcome !== c.expected) problems.push(`expected ${c.expected}, got ${outcome}: ${err?.message ?? ''}`);
  if (c.knobs.outcome === 'cas_conflict' && c.expected === 'ok' && !err) {
    const roots = spans.filter(s => s.name === 'git.edit').sort((a, b) => a.attrs['git.edit.attempt'] - b.attrs['git.edit.attempt']);
    if (result.attempt !== 1) problems.push(`race absorbed without a retry (attempt ${result.attempt})`);
    if (roots.length !== 2 || roots[0].attrs['git.edit.outcome'] !== 'cas_conflict' || roots[1].attrs['git.edit.outcome'] !== 'ok') problems.push(`roots ${roots.map(r => r.attrs['git.edit.outcome']).join(',')}, expected cas_conflict,ok`);
    if (roots[1] && (roots[1].links?.[0]?.spanId !== roots[0]?.spanId)) problems.push('retry root not linked to the lost attempt');
    if (result.oldCommit !== raced) problems.push(`retry parent ${result.oldCommit} is not the racer's commit ${raced}`);
  }
  if (c.expected === 'ok' && !err) {
    const expectedBlob = concat([c.blob.subarray(0, c.off), c.replace, c.blob.subarray(c.off + c.find.length)]);
    if (head !== result.newCommit) problems.push('ref not advanced to new commit');
    const got = gitBuf(bare, ['cat-file', 'blob', `main:${c.path}`]);
    if (!Buffer.from(got).equals(Buffer.from(expectedBlob))) problems.push('blob content mismatch');
    if (hashObject('blob', expectedBlob) !== result.newBlob) problems.push('newBlob oid mismatch');
    const base = raced ?? oldHead; // after an absorbed race the parent is the racer's commit
    const changed = git(bare, ['diff', '--name-only', '-z', base, head]).split('\0').filter(Boolean);
    if (changed.length !== 1 || changed[0] !== c.path) problems.push(`diff touched ${JSON.stringify(changed)}`);
    const log = git(bare, ['log', '-1', '--format=%P|%an|%ae|%s', head]).trim();
    if (log !== `${base}|fuzz|fuzz@x|fuzz ${seed}`) problems.push(`commit metadata ${log}`);
    if (git(bare, ['rev-parse', `${head}^{tree}`]).trim() !== result.newTree) problems.push('tree oid mismatch');
    const fsck = fsckProblems(bare); if (fsck.length) problems.push(`fsck: ${fsck.join(' | ')}`); // --no-dangling: receive-pack unpacks before the CAS, so a lost attempt leaves dangling objects by design
    const mode = git(bare, ['ls-tree', head, '--', c.path]).split(' ')[0]; if (mode !== c.files[c.path].mode) problems.push(`mode changed ${mode}`);
    // efficiency: push bytes bounded by the edit, not the file; memory O(1) in file size
    const depth = c.path.split('/').length;
    // commit ~220B + per-level tree delta ≤ 80B + blob delta: insert bytes + 1 op byte/127 + zlib block overhead + copy ops per 64K of base
    const bound = 220 + 80 * depth + c.replace.length + Math.ceil(c.replace.length / 127) + 5 * Math.ceil(c.replace.length / 16384) + 16 * Math.ceil(c.blob.length / 65536) + 40;
    if (result.pushBytes > bound) problems.push(`push ${result.pushBytes}B exceeds bound ${bound}B`);
    const root = spans.find(s => s.name === 'git.edit');
    const maxSingle = root.attrs['mem.alloc.max_single'];
    if (maxSingle > 70000 + c.find.length + c.replace.length) problems.push(`max single alloc ${maxSingle} not O(1)`);
    // second edit on the new head must hit the tree cache for every level
    const r2lines = []; const t2 = new Tracer({ exporter: l => r2lines.push(l) });
    try {
      const find2 = c.replace;
      const occ = find2.length ? countOcc(expectedBlob, find2) : 0;
      if (occ === 1) {
        const j = Buffer.from(expectedBlob).indexOf(Buffer.from(find2));
        const undoExpected = concat([expectedBlob.subarray(0, j), c.find, expectedBlob.subarray(j + find2.length)]);
        await editFile(`${ctx.url}/${name}.git`, { path: c.path, find: find2, replace: c.find, author: { name: 'fuzz', email: 'fuzz@x' }, message: 'undo' }, { tracer: t2, cache });
        const hits = r2lines.flatMap(flattenLine).find(s => s.name === 'git.edit').attrs['git.edit.tree.cache_hits'];
        if (hits !== depth) problems.push(`second edit cache hits ${hits} != ${depth}`);
        const back = gitBuf(bare, ['cat-file', 'blob', `main:${c.path}`]);
        if (!Buffer.from(back).equals(Buffer.from(undoExpected))) problems.push('second edit content mismatch');
        for (const l of r2lines) { ctx.trace(l); lines.push(l); }
      }
    } catch (e) { problems.push(`second edit failed: ${e.message}`); }
  } else {
    if (head !== (raced ?? oldHead)) problems.push('ref moved on failed/noop edit');
    if (c.expected === 'noop' && !err && spans.some(s => s.name === 'git.receive-pack')) problems.push('noop edit pushed');
  }
  rmSync(bare, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true });
  return { seed, knobs: c.knobs, hints, outcome, expected: c.expected, problems, ms, buckets: buckets(lines.flatMap(flattenLine)), blobLen: c.blob.length, pushBytes: result?.pushBytes, lines };
}
const countOcc = (hay, n) => { let c = 0, i = -1; const s = Buffer.from(hay), t = Buffer.from(n); while ((i = s.indexOf(t, i + 1)) >= 0) c++; return c; };

// ---- loop ----
const { root, cleanup } = tmpRoot();
const srv = await startGitServer(root);
const traceOut = await jsonlExporter(join(OUT, 'trace.jsonl'));
const ctx = { root, url: srv.url, trace: traceOut };
const cov = new Map();
const fails = [];
const seen = [];
const steer = new Rng(SEED ^ 0xabcdef);
let totalMs = 0;
try {
  const seeds = ONLY !== null ? [ONLY] : Array.from({ length: N }, (_, i) => (SEED * 7919 + i * 104729) >>> 0);
  for (let i = 0; i < seeds.length; i++) {
    let hints = {};
    if (ONLY === null && i > 2) {
      const r = steer.float();
      if (r < 0.55) { // least-covered target
        const ranked = Object.keys(TARGETS).map(t => [t, cov.get(t) ?? 0]).sort((a, b) => a[1] - b[1]);
        const pool = ranked.slice(0, Math.max(3, Math.ceil(ranked.length / 4)));
        const [t] = steer.pick(pool); hints = { ...TARGETS[t], __target: t };
      } else if (r < 0.75 && seen.length) { // mutate a rare-bucket case
        const rare = seen.filter(s => [...s.buckets].some(b => (cov.get(b) ?? 0) <= 2));
        const parent = steer.pick(rare.length ? rare : seen);
        const knob = steer.pick(Object.keys(KNOBS));
        hints = { ...parent.knobs, [knob]: steer.pick(KNOBS[knob]), __target: `mutate:${parent.seed}:${knob}` };
      }
    }
    const r = await runCase(ctx, seeds[i], hints);
    totalMs += r.ms;
    for (const b of r.buckets) cov.set(b, (cov.get(b) ?? 0) + 1);
    for (const b of ['sortedge', 'compression.9', 'compression.1']) if ((b === 'sortedge' && r.knobs.siblings === 'sortedge') || b === `compression.${r.knobs.compression}`) cov.set(b, (cov.get(b) ?? 0) + 1);
    cov.set(`server.${r.knobs.server}`, (cov.get(`server.${r.knobs.server}`) ?? 0) + 1);
    seen.push({ seed: r.seed, knobs: r.knobs, buckets: r.buckets });
    const newB = [...r.buckets].filter(b => cov.get(b) === 1);
    const tag = r.problems.length ? 'FAIL' : 'ok  ';
    process.stdout.write(`${tag} #${String(i).padStart(3)} seed=${r.seed} ${r.outcome.padEnd(13)} ${String(r.ms | 0).padStart(5)}ms blob=${String(r.blobLen).padStart(7)} push=${String(r.pushBytes ?? '-').padStart(5)} ${hints.__target ? '← ' + hints.__target : ''}${newB.length ? '  NEW:' + newB.join(',') : ''}\n`);
    if (r.problems.length) {
      fails.push(r);
      const fp = join(OUT, `fail-${r.seed}.jsonl`);
      writeFileSync(fp, r.lines.map(l => JSON.stringify(l)).join('\n') + '\n');
      console.log(`     ${r.problems.join('\n     ')}\n     knobs=${JSON.stringify(r.knobs)}\n     repro: node test/fuzz/run.mjs --case ${r.seed}   trace: ${fp}`);
    }
  }
} finally {
  traceOut.close(); await srv.close(); cleanup();
}
console.log(`\n${seeds_len(seen)} cases, ${(totalMs / 1000).toFixed(1)}s edit time, ${fails.length} failures. Coverage (${cov.size} buckets):`);
const rows = [...cov.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
console.log(rows.map(([k, v]) => `${String(v).padStart(4)} ${k}`).join('\n'));
const unreached = Object.keys(TARGETS).filter(t => !cov.has(t));
if (unreached.length) console.log(`\nUNREACHED targets: ${unreached.join(', ')}`);
function seeds_len(s) { return s.length; }
process.exit(fails.length ? 1 : 0);
