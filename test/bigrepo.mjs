// Build a large repo fast (no worktree: hash-object + mktree + commit-tree), then measure an edit against it.
//   node test/bigrepo.mjs [--commits 1000] [--headMB 50] [--totalGB 10] [--dir /tmp/bigrepo] [--reuse]
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Rng } from './fuzz/prng.js';
import { startGitServer } from './server.js';
import { editFile } from '../src/edit.js';
import { GitHttp } from '../src/client.js';
import { Tracer, arrayExporter, flattenLine } from '../src/otel.js';
import { defaultCapabilities } from '../src/capabilities.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? true] : []).filter(x => x.length));
const COMMITS = +(args.commits ?? 1000), HEAD_MB = +(args.headMB ?? 50), TOTAL_GB = +(args.totalGB ?? 10), DIR = args.dir ?? '/tmp/bigrepo';
const bare = join(DIR, 'big.git');
const git = (a, opt = {}) => execFileSync('git', ['-C', bare, ...a], { encoding: 'utf8', maxBuffer: 1 << 30, ...opt });
const rng = new Rng(2024);

if (!(args.reuse && existsSync(bare))) {
  rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  for (const [k, v] of [['uploadpack.allowFilter', 'true'], ['uploadpack.allowAnySHA1InWant', 'true'], ['http.receivepack', 'true'], ['receive.fsckObjects', 'true'], ['core.compression', '1'], ['pack.compression', '1'], ['gc.auto', '0']]) git(['config', k, v]);
  const t0 = Date.now();
  // Layout: 40 dirs × 25 files of source-ish text (~45 MB), plus a few "assets" that churn every commit (that is where the
  // 10 GB of history comes from: each commit rewrites ~10 MB of incompressible binary).
  const hashBlob = buf => { const r = spawnSync('git', ['-C', bare, 'hash-object', '-w', '--stdin'], { input: buf, maxBuffer: 1 << 30 }); if (r.status) throw new Error(r.stderr.toString()); return r.stdout.toString().trim(); };
  const src = {}; // dir -> [name, oid]
  const srcPerDir = Math.max(1, Math.round((HEAD_MB * 0.9 * 1024 * 1024) / 1000 / 1024)); // KB per source file (1000 files)
  for (let d = 0; d < 40; d++) { src[`src/mod${String(d).padStart(2, '0')}`] = []; for (let f = 0; f < 25; f++) { const kb = Math.max(1, srcPerDir); const text = Buffer.from(Array.from({ length: Math.ceil(kb * 1024 / 48) }, (_, i) => `line ${String(i).padStart(6)} of module ${String(d).padStart(2)} file ${String(f).padStart(2)}: xxxxxxxxxx\n`).join('')); src[`src/mod${String(d).padStart(2, '0')}`].push([`file${f}.ts`, hashBlob(text)]); } }
  const perCommitMB = (TOTAL_GB * 1024) / COMMITS; // churn per commit
  const assetCount = 4, assetMB = perCommitMB / assetCount;
  let parent = null, treeOidCache = null;
  const target = { dir: 'src/mod17', name: 'file9.ts' };
  const mktree = lines => execFileSync('git', ['-C', bare, 'mktree'], { input: lines.join('\n') + '\n', encoding: 'utf8' }).trim();
  const subtrees = {};
  for (const [dir, files] of Object.entries(src)) subtrees[dir] = mktree(files.map(([n, o]) => `100644 blob ${o}\t${n}`));
  let srcTree = mktree(Object.keys(src).map(d => `040000 tree ${subtrees[d]}\t${d.split('/')[1]}`));
  for (let c = 0; c < COMMITS; c++) {
    // churn: new random assets each commit (incompressible → history grows ~perCommitMB)
    const assets = []; for (let a = 0; a < assetCount; a++) assets.push([`asset${a}.bin`, hashBlob(rng.bytes(Math.floor(assetMB * 1024 * 1024)))]);
    // the target file changes every 50 commits so its blob has real history
    if (c % 50 === 0) { const i = src[target.dir].findIndex(([n]) => n === target.name); src[target.dir][i][1] = hashBlob(Buffer.from(`// revision ${c}\nMARK_${c}\n` + 'y'.repeat(srcPerDir * 1024))); subtrees[target.dir] = mktree(src[target.dir].map(([n, o]) => `100644 blob ${o}\t${n}`)); }
    if (c % 50 === 0) srcTree = mktree(Object.keys(src).map(d => `040000 tree ${subtrees[d]}\t${d.split('/')[1]}`));
    const srcT = srcTree;
    const assetsTree = mktree(assets.map(([n, o]) => `100644 blob ${o}\t${n}`));
    const root = mktree([`040000 tree ${srcT}\tsrc`, `040000 tree ${assetsTree}\tassets`, `100644 blob ${hashBlob(Buffer.from(`# big repo\ncommit ${c}\n`))}\tREADME.md`]);
    const env = { ...process.env, GIT_AUTHOR_NAME: 'big', GIT_AUTHOR_EMAIL: 'b@x', GIT_COMMITTER_NAME: 'big', GIT_COMMITTER_EMAIL: 'b@x', GIT_AUTHOR_DATE: `${1700000000 + c * 60} +0000`, GIT_COMMITTER_DATE: `${1700000000 + c * 60} +0000`, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false' };
    parent = execFileSync('git', ['-C', bare, 'commit-tree', root, ...(parent ? ['-p', parent] : []), '-m', `commit ${c}`], { env, encoding: 'utf8' }).trim();
    if (c % 100 === 0) process.stderr.write(`  commit ${c}/${COMMITS} ${((Date.now() - t0) / 1000) | 0}s\n`);
    if (c % 200 === 199) git(['repack', '-d', '-q']); // keep loose-object count sane
  }
  git(['update-ref', 'refs/heads/main', parent]);
  process.stderr.write(`  objects written in ${((Date.now() - t0) / 1000) | 0}s; gc + bitmaps + midx...\n`);
  const t1 = Date.now();
  git(['-c', 'repack.writeBitmaps=true', '-c', 'pack.window=0', 'gc', '-q', '--prune=now']);
  git(['multi-pack-index', 'write', '--bitmap']); git(['config', 'core.multiPackIndex', 'true']);
  process.stderr.write(`  gc in ${((Date.now() - t1) / 1000) | 0}s\n`);
}
const du = dir => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? du(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0);
const stats = { commits: +git(['rev-list', '--count', 'main']).trim(), packBytes: du(join(bare, 'objects/pack')), headTreeEntries: git(['ls-tree', '-r', 'main']).trim().split('\n').length, headBytes: git(['ls-tree', '-r', '-l', 'main']).trim().split('\n').reduce((n, l) => n + (+l.split(/\s+/)[3] || 0), 0), bitmaps: readdirSync(join(bare, 'objects/pack')).filter(f => f.endsWith('.bitmap')) };
console.log('repo:', JSON.stringify({ ...stats, packGB: (stats.packBytes / 2 ** 30).toFixed(2), headMB: (stats.headBytes / 2 ** 20).toFixed(1) }));

// ---- measure ----
const srv = await startGitServer(DIR);
const url = `${srv.url}/big.git`;
const head = git(['rev-parse', 'main']).trim();
const run = async (label, fn) => { const ex = arrayExporter(); const tracer = new Tracer({ exporter: ex }); const t0 = Date.now(); let r, err; try { r = await fn(tracer); } catch (e) { err = e; } const ms = Date.now() - t0; const spans = ex.lines.flatMap(flattenLine); const root = spans.find(s => s.name === 'git.edit') ?? spans[spans.length - 1]; const http = spans.filter(s => s.attrs['http.response.body.size'] !== undefined); console.log(`${label.padEnd(44)} ${String(ms).padStart(6)}ms  rtt=${http.length}  wire_in=${http.reduce((n, s) => n + s.attrs['http.response.body.size'], 0)}B  wire_out=${http.reduce((n, s) => n + (s.attrs['http.request.body.size'] ?? 0), 0)}B  max_alloc=${root?.attrs['mem.alloc.max_single'] ?? '-'}  alloc=${root?.attrs['mem.alloc.bytes'] ?? '-'}${err ? '  ERR ' + err.code + ' ' + err.message.slice(0, 60) : ''}`); return { r, spans, ms, http }; };

const cache = new Map();
const edit = (tracer, rev, c = new Map()) => editFile(url, { path: 'src/mod17/file9.ts', find: `MARK_${rev}`, replace: `EDITED_${rev}`, author: { name: 'e', email: 'e@x' }, message: 'edit' }, { capabilities: { ...defaultCapabilities(), tracer }, cache: c });
const lastRev = Math.floor((COMMITS - 1) / 50) * 50;
console.log('\n--- edit src/mod17/file9.ts (depth 3, 40-wide src dir, 25-wide leaf)');
const a = await run('cold (ls-refs + commit + 3 trees + blob + push)', t => edit(t, lastRev, cache));
console.log('    per-stage:', a.spans.filter(s => /upload-pack|receive-pack/.test(s.name)).map(s => `${s.name.replace('git.', '')}=${s.durationMs.toFixed(0)}ms/${s.attrs['http.response.body.size'] ?? s.attrs['http.request.body.size']}B`).join(' '));
git(['update-ref', 'refs/heads/main', head]); // undo for the next run
const b = await run('warm tree cache (same root tree → 0 tree fetches)', t => edit(t, lastRev, cache));
git(['update-ref', 'refs/heads/main', head]);
console.log('\n--- what the naive alternatives cost on this repo (server side, wire bytes)');
const c = new GitHttp(url, { capabilities: { ...defaultCapabilities(), tracer: new Tracer() } });
for (const [label, req] of [['blob:none (textbook blobless, depth 1)', { wants: [head], filter: 'blob:none', deepen: 1 }], ['tree:0 (our commit fetch)', { wants: [head], filter: 'tree:0', deepen: 1 }], ['combine:blob:none+tree:3 (one-shot trees to depth 3)', { wants: [head], filter: 'combine:blob:none+tree:3', deepen: 1 }], ['depth-1 full clone pack (what `git clone --depth 1` moves)', { wants: [head], deepen: 1 }]]) {
  const t0 = Date.now(); let n = 0, objs = 0; try { const r = await c.fetchPack(req); n = r.parsed.bytes; objs = r.parsed.stats.count; } catch (e) { console.log(label, 'ERR', e.message.slice(0, 80)); continue; }
  console.log(`${label.padEnd(60)} ${String(Date.now() - t0).padStart(6)}ms  ${String(n).padStart(10)}B  ${objs} objects`);
}
await srv.close();
