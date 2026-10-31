#!/usr/bin/env node
// ply prod watch — one run of the end-to-end data loop. Read-only unless PLY_TOKEN and PROD_CANARY_REMOTE are set.
//
//   A. ply (the checkout at PLY_DIR, default ../ply) against live public hosts: ls-refs, commit, tree, blob.
//      Oracle: `git ls-remote` for ref oids on every host; GitHub REST (gh api) for tree entries and blob bytes.
//   B. the production Worker https://ply.ivar.workers.dev (ply-web): GET /, GET /view tree and blob pages.
//      Oracle: the same GitHub REST truth; plus parity with A (same oids, same entries).
//   C. with PLY_TOKEN: /v1/refs, /v1/commit, /v1/tree, /v1/read?trace=1 — bytes compared to the REST blob.
//
// Output: one JSON record on stdout (also appended to LOG, default ./log.jsonl) with `anomalies: []` when all is well.
// Exit code 0 always; the record is the signal. Every number that can be compared is compared, nothing is eyeballed.
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const execFile = promisify(execFileCb);
const PLY_DIR = process.env.PLY_DIR ?? resolve(import.meta.dirname, '../ply');
const LOG = process.env.LOG ?? resolve(import.meta.dirname, 'log.jsonl');
const PROD = process.env.PROD ?? 'https://ply.ivar.workers.dev';
const TOKEN = process.env.PLY_TOKEN ?? '';
const SLOW_MS = Number(process.env.SLOW_MS ?? 5000);          // a single ply operation or Worker page slower than this is an anomaly
const ply = await import(pathToFileURL(resolve(PLY_DIR, 'src/index.js')));
const { readCommit, listTree, readFile, lsRefs, createTransport, Tracer, arrayExporter, flattenLine } = ply;

const TARGETS = [
  { host: 'github.com', url: 'https://github.com/ivarvong/ply.git', ref: 'refs/heads/main', dir: 'src', file: 'package.json', rest: 'ivarvong/ply' },
  { host: 'gitlab.com', url: 'https://gitlab.com/gitlab-org/cli.git', ref: 'refs/heads/main', dir: 'cmd', file: 'go.mod' },
  { host: 'codeberg.org', url: 'https://codeberg.org/forgejo/forgejo.git', ref: 'refs/heads/forgejo', dir: 'cmd', file: 'go.mod' },
];

const run = { at: new Date().toISOString(), ply: (await execFile('git', ['-C', PLY_DIR, 'rev-parse', '--short', 'HEAD'])).stdout.trim(), targets: {}, prod: {}, anomalies: [] };
const bad = (where, what) => run.anomalies.push(`${where}: ${what}`);
const timed = async (label, fn) => { const t0 = performance.now(); try { return [await fn(), Math.round(performance.now() - t0)]; } finally { const ms = Math.round(performance.now() - t0); if (ms > SLOW_MS) bad(label, `${ms} ms (> ${SLOW_MS})`); } };
const wire = tracer => { const s = tracer.exporter.lines.flatMap(flattenLine).filter(x => x.attrs['git.request.bytes'] != null); return { rtt: s.length, out: s.reduce((a, x) => a + x.attrs['git.request.bytes'], 0), in: s.reduce((a, x) => a + (x.attrs['git.response.bytes'] ?? 0), 0), ms: s.map(x => Math.round(x.durationMs)) }; };
const sha1hex = async bytes => Buffer.from(await crypto.subtle.digest('SHA-1', bytes)).toString('hex');
const blobOid = async bytes => sha1hex(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), Buffer.from(bytes)]));
const gh = async path => JSON.parse((await execFile('gh', ['api', path], { maxBuffer: 64 << 20 })).stdout);

// ---- A. ply against live hosts, with git and GitHub REST as the judges ----
for (const t of TARGETS) {
  const rec = run.targets[t.host] = {};
  try {
    const lr = (await execFile('git', ['ls-remote', t.url, t.ref])).stdout.trim().split('\t')[0];
    rec.oracleOid = lr;
    const tracer = new Tracer({ exporter: arrayExporter() }), quirks = {}, opts = { tracer, quirks, cache: new Map() };
    const [{ refs }] = await timed(`${t.host} ls-refs`, () => lsRefs(createTransport(t.url, { tracer, quirks }), [t.ref]));
    rec.plyOid = refs.get(t.ref)?.oid ?? null;
    if (rec.plyOid !== lr) bad(`${t.host} ls-refs`, `ply ${rec.plyOid} != git ls-remote ${lr}`);
    const [c] = await timed(`${t.host} readCommit`, () => readCommit(t.url, { ref: t.ref }, opts));
    rec.commit = c.oid; rec.tree = c.tree;
    if (c.oid !== lr) bad(`${t.host} readCommit`, `${c.oid} != ${lr}`);
    const [tree] = await timed(`${t.host} listTree`, () => listTree(t.url, { ref: c.oid, path: t.dir }, opts));
    rec.entries = tree.entries.length;
    const [f] = await timed(`${t.host} readFile`, () => readFile(t.url, { ref: c.oid, path: t.file }, opts));
    const bytes = new Uint8Array(await new Response(f.stream).arrayBuffer());
    rec.file = { path: t.file, mode: f.mode, size: bytes.length, oid: await blobOid(bytes) };
    if (f.size !== bytes.length) bad(`${t.host} readFile`, `declared ${f.size} streamed ${bytes.length}`);
    if (t.rest) {   // GitHub REST is an independent implementation of the same truth
      const ref = await gh(`repos/${t.rest}/git/ref/heads/${t.ref.replace('refs/heads/', '')}`);
      if (ref.object.sha !== c.oid) bad(`${t.host} REST`, `ref ${ref.object.sha} != ply ${c.oid}`);
      const commit = await gh(`repos/${t.rest}/git/commits/${c.oid}`);
      if (commit.tree.sha !== c.tree) bad(`${t.host} REST`, `tree ${commit.tree.sha} != ply ${c.tree}`);
      const root = await gh(`repos/${t.rest}/git/trees/${c.tree}`);
      const e = root.tree.find(x => x.path === t.file);
      if (!e || e.sha !== rec.file.oid || e.mode !== f.mode) bad(`${t.host} REST`, `blob ${t.file} REST ${e?.mode} ${e?.sha} != ply ${f.mode} ${rec.file.oid}`);
      const dirEntry = root.tree.find(x => x.path === t.dir);
      const sub = await gh(`repos/${t.rest}/git/trees/${dirEntry.sha}`);
      const mine = tree.entries.map(x => `${x.mode} ${x.oid} ${x.name}`).sort().join('\n');
      const theirs = sub.tree.map(x => `${x.mode === '040000' ? '40000' : x.mode} ${x.sha} ${x.path}`).sort().join('\n');
      if (mine !== theirs) bad(`${t.host} REST`, `tree ${t.dir} differs from ply's listing`);
      const blob = await gh(`repos/${t.rest}/git/blobs/${rec.file.oid}`);
      if (Buffer.from(blob.content, 'base64').compare(Buffer.from(bytes)) !== 0) bad(`${t.host} REST`, `blob bytes differ`);
      rec.restChecked = true;
    }
    rec.wire = wire(tracer);
  } catch (e) { rec.error = { code: e.code, message: String(e.message).slice(0, 200) }; bad(`${t.host} ply`, `${e.code ?? e.name}: ${String(e.message).slice(0, 120)}`); }
}

// ---- B. the production Worker ----
const get = async (path, headers = {}) => {
  const t0 = performance.now();
  const res = await fetch(`${PROD}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  return { status: res.status, ms: Math.round(performance.now() - t0), text, h: Object.fromEntries(res.headers) };
};
try {
  const gh0 = run.targets['github.com'];
  const [root] = await timed('prod GET /', () => get('/'));
  run.prod.root = { status: root.status, ms: root.ms, cf: root.h['cf-ray'] ?? null };
  if (root.status !== 200 || !root.text.includes('ply')) bad('prod GET /', `status ${root.status}`);
  const [tree] = await timed('prod /view tree', () => get('/view/github.com/ivarvong/ply?path=src'));
  const want = tree.text.match(/want=([0-9a-f]{40})/)?.[1] ?? null;
  // ply-web's stable scraping contract (ply-web README "Machine-readable markup"): one li[data-oid] per tree entry, full oids.
  const shorts = [...tree.text.matchAll(/<li data-oid="([0-9a-f]{40})" data-mode="([0-7]{6})" data-type="(?:blob|tree|commit)" data-name="[^"]*">/g)].map(m => m[1]);
  run.prod.viewTree = { status: tree.status, ms: tree.ms, head: want, entries: shorts.length, timing: tree.h['server-timing'] ?? null, requestId: tree.h['x-ply-request-id'] ?? null, gitCalls: (tree.h['server-timing'] ?? '').split(',').length - 1 };
  if (tree.status !== 200) bad('prod /view tree', `status ${tree.status}`);
  if (gh0?.commit && want && want !== gh0.commit) bad('prod /view tree', `HEAD ${want} != ply/REST ${gh0.commit} (stale or lagging?)`);
  if (gh0?.entries && shorts.length !== gh0.entries) bad('prod /view tree', `${shorts.length} entries != ${gh0.entries}`);
  const [blob] = await timed('prod /view blob', () => get('/view/github.com/ivarvong/ply?path=package.json'));
  const oid = blob.text.match(/class="meta-k">blob<\/span> <span class="mono" title="([0-9a-f]{40})"/)?.[1] ?? null;
  const mode = blob.text.match(/class="meta-k">mode<\/span> <span class="mono">(\d+)</)?.[1] ?? null;
  run.prod.viewBlob = { status: blob.status, ms: blob.ms, oid, mode, timing: blob.h['server-timing'] ?? null };
  if (blob.status !== 200) bad('prod /view blob', `status ${blob.status}`);
  if (gh0?.file && oid && (oid !== gh0.file.oid || mode !== gh0.file.mode)) bad('prod /view blob', `${mode} ${oid} != ${gh0.file.mode} ${gh0.file.oid}`);
  for (const [k, v] of Object.entries({ 'content-security-policy': /default-src 'none'/, 'x-frame-options': /DENY/, 'cache-control': /no-store/ })) if (!v.test(blob.h[k] ?? '')) bad('prod headers', `${k}: ${blob.h[k]}`);
  // C. authenticated API, when a token is in the environment
  if (TOKEN) {
    const auth = { authorization: `Bearer ${TOKEN}` }, remote = 'remote=https://github.com/ivarvong/ply';
    const [refs] = await timed('prod /v1/refs', () => get(`/v1/refs?${remote}&prefix=refs/heads/main`, auth));
    const [commit] = await timed('prod /v1/commit', () => get(`/v1/commit?${remote}&ref=refs/heads/main&trace=1`, auth));
    const [read] = await timed('prod /v1/read', () => get(`/v1/read?${remote}&ref=refs/heads/main&path=package.json`, auth));
    run.prod.v1 = { refs: refs.status, commit: commit.status, read: read.status, readBlob: read.h['x-ply-blob'] ?? null, readTrace: read.h['x-ply-trace'] ?? null };
    for (const [n, r] of Object.entries({ refs, commit, read })) if (r.status !== 200) bad(`prod /v1/${n}`, `status ${r.status} ${r.text.slice(0, 120)}`);
    if (refs.status === 200 && JSON.parse(refs.text).refs?.['refs/heads/main'] !== gh0?.commit) bad('prod /v1/refs', `main != ${gh0?.commit}`);
    if (read.status === 200 && gh0?.file && (read.h['x-ply-blob'] !== gh0.file.oid || Buffer.byteLength(read.text) !== gh0.file.size)) bad('prod /v1/read', `blob ${read.h['x-ply-blob']} size ${Buffer.byteLength(read.text)} != ${gh0.file.oid} ${gh0.file.size}`);
    if (TOKEN && JSON.stringify(run).includes(TOKEN)) { run.anomalies.push('TOKEN LEAKED INTO THE RECORD'); }
  } else run.prod.v1 = 'skipped (no PLY_TOKEN)';
} catch (e) { run.prod.error = String(e.message).slice(0, 200); bad('prod', String(e.message).slice(0, 120)); }

// ---- trend: compare with the previous record ----
try {
  const prev = readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).at(-1);
  if (prev) {
    run.changes = [];
    if (prev.ply !== run.ply) run.changes.push(`ply checkout ${prev.ply} → ${run.ply}`);
    if (prev.targets['github.com']?.commit !== run.targets['github.com']?.commit) run.changes.push(`ivarvong/ply main ${prev.targets['github.com']?.commit?.slice(0, 7)} → ${run.targets['github.com']?.commit?.slice(0, 7)}`);
    const p = prev.prod.viewTree?.gitCalls, n = run.prod.viewTree?.gitCalls;
    if (p != null && n != null && p !== n) run.changes.push(`prod /view tree git calls ${p} → ${n}`);
  }
} catch { /* first run */ }
appendFileSync(LOG, JSON.stringify(run) + '\n');
console.log(JSON.stringify(run, null, 1));
