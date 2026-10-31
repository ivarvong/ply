// Hostile-server fuzz: compose 1–3 random mutations on a random exchange, run the edit, check the safety
// invariants against git. Reports which check caught what, so blind spots in detection show up as gaps.
//   node test/fuzz/hostile.mjs [--n 300] [--seed 1] [--case <seed>]
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { git, gitBuf, tmpRoot, makeBareRepo, startGitServer, commitFiles } from '../server.js';
import { startProxy } from '../proxy.js';
import { MUTATORS, MUTATOR_NAMES } from './mutate.js';
import { Rng } from './prng.js';
import { editFile } from '../../src/edit.js';
import { GitHttp } from '../../src/client.js';
import { TYPE } from '../../src/objects.js';
import { Tracer, arrayExporter, flattenLine } from '../../src/otel.js';
import { withLimits } from '../../src/limits.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? true] : []).filter(x => x.length));
const N = parseInt(args.n ?? '300', 10), SEED = parseInt(args.seed ?? String(Date.now() % 1e9), 10), ONLY = args.case ? parseInt(args.case, 10) : null;
const CODES = new Set(['pack_corrupt', 'protocol', 'network', 'timeout', 'aborted', 'not_git', 'auth', 'not_found', 'rate_limited', 'upstream_5xx', 'http', 'limit_exceeded', 'remote_error', 'match_count', 'cas_conflict', 'push_rejected', 'bad_request', 'unsupported', 'ambiguous']);
// 'push-sb' is a direct sideband push (side-band-64k + report-status-v2), the response path the edit pipeline does not use
const STAGES = [['ls-refs', 0], ['fetch', 0], ['fetch', 1], ['fetch', 2], ['fetch', 3], ['fetch', 4], ['receive-pack', 0], ['push-sb', 0]];
// which check caught it, from the message. 'bounds' is take()'s typed short read raised inside a frame parser, e.g. a
// pkt-line cut to 0004 in the packfile section has no band byte (git: "missing sideband designator"); case 2366521731.
const SITE = [['trailer', /trailer/], ['adler', /adler/], ['zlib_bound', /zlib stream longer/], ['size', /size|exceeds expected|streamed more|inflated \d+ !=/], ['pkt', /pkt-line/], ['huffman', /huffman|block type|invalid|distance|stored|repeat|end-of-block|unexpected end/], ['zlib_hdr', /zlib:/], ['delta', /delta/], ['limit', /exceeds limit/], ['v2', /v2:|no packfile|sideband/], ['remote', /remote:/], ['ls_refs', /ls-refs:/], ['unsupported', /unsupported/], ['pack_hdr', /signature|version|expected 1 object|object type|not in pack|truncated before object header|missing trailer|single-object pack is a delta|trailing bytes after object|served for want/], ['tree', /tree:|not found/], ['content_type', /content-type/], ['http', /HTTP \d/], ['report', /push rejected|unpack/], ['net', /network|aborted|timeout/], ['bounds', /^short read:/], ['ambiguous', /outcome unknown/]];

const { root, cleanup } = tmpRoot();
const srv = await startGitServer(root);
const FILE = 'a/b/c/target.txt', ORIG = 'before MARK after\n', EXPECTED = 'before XX after\n';
const codes = {}, sites = {}, byStage = {}, muts = {};
const fails = [];
let silentOk = 0;
try {
  const seeds = ONLY !== null ? [ONLY] : Array.from({ length: N }, (_, i) => (SEED * 7919 + i * 104729) >>> 0);
  for (let i = 0; i < seeds.length; i++) {
    const rng = new Rng(seeds[i]);
    const name = `h${i}`;
    const bare = makeBareRepo(root, name);
    const work = join(root, `w${i}`); mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
    commitFiles(work, bare, { [FILE]: ORIG, 'a/s.txt': 'x'.repeat(rng.int(0, 70000)), 'z.txt': 'z' }, 'one');
    const head = commitFiles(work, bare, { 'z.txt': 'z2' }, 'two');
    const [stage, k] = rng.pick(STAGES);
    const chain = Array.from({ length: rng.int(1, 3) }, () => rng.pick(MUTATOR_NAMES));
    const mseed = rng.u32();
    const proxyStage = stage === 'push-sb' ? 'receive-pack' : stage;
    const proxy = await startProxy(srv.url, ctx => {
      if (ctx.stage !== proxyStage || ctx.n !== k) return { type: 'pass' };
      const r = new Rng(mseed); let b = ctx.bytes;
      for (const m of chain) b = MUTATORS[m](r, b);
      return { type: 'bytes', bytes: b, name: chain.join('+'), chunks: rng.bool(0.3) ? Array.from({ length: 50 }, () => rng.int(1, 300)) : undefined };
    });
    const exporter = arrayExporter();
    const t0 = performance.now();
    let result = null, error = null;
    try {
      if (stage === 'push-sb') {
        // a commit prepared with git, pushed by us with sideband + report-status-v2 through the mutating proxy
        const w2 = join(root, `p${i}`); mkdirSync(w2); git(w2, ['clone', '-q', bare, '.']); writeFileSync(join(w2, FILE), EXPECTED); git(w2, ['add', '-A']); git(w2, ['-c', 'user.name=h', '-c', 'user.email=h@x', 'commit', '-q', '-m', 'sb']);
        const nxt = git(w2, ['rev-parse', 'HEAD']).trim();
        const objs = git(w2, ['rev-list', '--objects', '--no-object-names', nxt, '-n1', `^${head}`]).trim().split('\n').map(o => { const t = git(w2, ['cat-file', '-t', o]).trim(); return { type: TYPE[t.toUpperCase()], data: new Uint8Array(gitBuf(w2, ['cat-file', t, o])) }; });
        const c = new GitHttp(`${proxy.url}/${name}.git`, { tracer: new Tracer({ exporter }), limits: withLimits({ requestTimeoutMs: 3000 }) });
        const r = await c.push({ ref: 'refs/heads/main', oldOid: head, newOid: nxt, objects: objs, sideband: true, reportV2: true });
        result = { newCommit: nxt, report: r.report };
      } else result = await editFile(`${proxy.url}/${name}.git`, { path: FILE, find: 'MARK', replace: 'XX', author: { name: 'h', email: 'h@x' }, message: 'h' }, { tracer: new Tracer({ exporter }), limits: withLimits({ requestTimeoutMs: 3000 }) });
    } catch (e) { error = e; }
    const ms = performance.now() - t0;
    await proxy.close();
    const problems = [];
    const nowHead = git(bare, ['rev-parse', 'main']).trim();
    const content = gitBuf(bare, ['cat-file', 'blob', `main:${FILE}`]).toString();
    if (ms > 8000) problems.push(`took ${ms | 0}ms`);
    if (error) {
      if (!CODES.has(error.code)) problems.push(`untyped error ${error.code}: ${error.message}`);
      if (nowHead !== head) {
        if (stage !== 'receive-pack' && stage !== 'push-sb') problems.push('ref moved on error');
        else if (content !== EXPECTED) problems.push('ref moved to wrong content');
        else if (error.code !== 'ambiguous') problems.push(`ref moved but error is ${error.code}, not ambiguous`);
      }
      const root = exporter.lines.flatMap(flattenLine).find(s => s.name === 'git.edit');
      if (stage !== 'push-sb' && root?.attrs['git.edit.outcome'] !== error.code) problems.push(`outcome attr ${root?.attrs['git.edit.outcome']} != ${error.code}`);
      const site = SITE.find(([, re]) => re.test(error.message))?.[0] ?? 'other';
      sites[site] = (sites[site] ?? 0) + 1;
      if (site === 'other') problems.push(`unclassified detection: ${error.message}`);
    } else {
      if (nowHead !== result.newCommit) problems.push('success but ref != our commit');
      if (content !== EXPECTED) problems.push('success but wrong content');
      const fsck = git(bare, ['fsck', '--strict', '--no-dangling']).trim(); if (fsck) problems.push(`fsck ${fsck}`);
      silentOk++;
    }
    const code = error ? error.code : 'ok';
    codes[code] = (codes[code] ?? 0) + 1;
    byStage[`${stage}#${k}:${code}`] = (byStage[`${stage}#${k}:${code}`] ?? 0) + 1;
    for (const m of chain) muts[`${m}:${code}`] = (muts[`${m}:${code}`] ?? 0) + 1;
    process.stdout.write(`${problems.length ? 'FAIL' : 'ok  '} #${String(i).padStart(3)} seed=${seeds[i]} ${stage}#${k} ${chain.join('+').padEnd(32)} → ${code.padEnd(14)} ${String(ms | 0).padStart(5)}ms\n`);
    if (problems.length) { fails.push(seeds[i]); console.log('     ' + problems.join('\n     ') + `\n     repro: node test/fuzz/hostile.mjs --case ${seeds[i]}`); }
    rmSync(bare, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true });
  }
} finally { await srv.close(); cleanup(); }
const show = o => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${String(v).padStart(4)} ${k}`).join('\n');
console.log(`\n${N} cases, ${fails.length} failures, ${silentOk} git-verified successes (mutation hit nothing we read)\n\noutcomes:\n${show(codes)}\n\ndetection site:\n${show(sites)}\n\nmutator → outcome:\n${show(muts)}`);
process.exit(fails.length ? 1 : 0);
