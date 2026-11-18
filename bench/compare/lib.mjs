// Pure parts of the ply-vs-native-git comparison (#323): the seeded fixture generator, the matrix, the client
// strategies with their exact commands, the statistics, the comparison, the schema check and the Markdown rendering.
// Nothing here touches the network, git or the clock, so test/bench-compare.test.js can check it directly.
import { createHash } from 'node:crypto';

export const SCHEMA = 'ply-bench-compare/1';
export const DEFAULT_SEED = 323;
export const REF = 'refs/heads/main';

// ---- the commit every client must produce -------------------------------------------------------------------------
// One author, one committer, one date, one message and one replacement, for ply and for git. With the same parent and
// the same tree, equal headers make the commit id equal, and run.mjs records whether the clients of a cell agreed.
export const POLICY = Object.freeze({
  author: Object.freeze({ name: 'Ply Bench', email: 'bench@example.invalid' }),
  committer: Object.freeze({ name: 'Ply Bench', email: 'bench@example.invalid' }),
  time: 1_750_000_000,
  tz: '+0000',
  message: 'bench: edit the target file',
  find: '@@PLY-BENCH-MARKER@@',
  replace: '@@EDITED-BY-THE-BENCHMARK@@',
});

// ---- seeded PRNG (mulberry32) and a string hash to derive per-cell streams -----------------------------------------
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashSeed(seed, label) {
  let h = 0x811c9dc5;
  for (const c of `${seed}:${label}`) h = Math.imul(h ^ c.codePointAt(0), 16777619) >>> 0;
  return h;
}

// ---- matrix --------------------------------------------------------------------------------------------------------
// One factor at a time around a base cell, so the default run is bounded: the base, two more history sizes, two more
// file sizes up to 32 MiB (where the clients' memory stops being runtime baseline), the other content kind and two more directory depths. `reused` marks the cells that also run the
// reused-state mode. `--full` widens every axis and runs the reused mode everywhere.
const KIB = 1024, MIB = 1024 * 1024;
const cell = (commits, fileBytes, content, depth, reused = false) => Object.freeze({
  id: `h${commits}-f${fileBytes >= MIB ? `${fileBytes / MIB}m` : `${fileBytes / KIB}k`}-${content}-d${depth}`,
  commits, fileBytes, content, depth, reused,
});
export const MATRICES = Object.freeze({
  smoke: [cell(6, 2 * KIB, 'text', 2, true)],
  default: [
    cell(200, 64 * KIB, 'text', 2, true),
    cell(20, 64 * KIB, 'text', 2),
    cell(2000, 64 * KIB, 'text', 2, true),
    cell(200, 4 * KIB, 'text', 2),
    cell(200, 4 * MIB, 'text', 2, true),
    cell(200, 32 * MIB, 'text', 2),
    cell(200, 64 * KIB, 'random', 2),
    cell(200, 64 * KIB, 'text', 1),
    cell(200, 64 * KIB, 'text', 8),
  ],
  full: [
    ...[20, 200, 2000, 20000].map(h => cell(h, 64 * KIB, 'text', 2, true)),
    ...[4 * KIB, 4 * MIB, 32 * MIB].map(f => cell(200, f, 'text', 2, true)),
    ...[64 * KIB, 4 * MIB, 32 * MIB].map(f => cell(200, f, 'random', 2, true)),
    ...[1, 8, 16].map(d => cell(200, 64 * KIB, 'text', d, true)),
    cell(2000, 4 * MIB, 'random', 8, true),
  ],
});

// ---- fixture -------------------------------------------------------------------------------------------------------
// A repository is a function of (seed, cell): `commits` commits on main, each rewriting one of BACKGROUND_FILES small
// files; the target file is rewritten in TARGET_REVISIONS of them (fewer when the history is shorter), the last of
// which is the head commit, so the reused-state mode's "one commit behind" clone lacks the current target blob.
export const BACKGROUND_FILES = 24;
export const BACKGROUND_BYTES = 1024;
export const TARGET_REVISIONS = 8;
export const targetPath = c => `${Array.from({ length: c.depth }, (_, i) => `d${i + 1}`).join('/')}${c.depth ? '/' : ''}target.dat`;
export const backgroundPath = i => `bg/${String(i % 4)}/file-${String(i).padStart(2, '0')}.txt`;

const WORDS = (() => {
  const r = prng(0x70_6c_79), out = [];
  for (let i = 0; i < 256; i++) {
    let w = '';
    for (let n = 3 + Math.floor(r() * 7); n > 0; n--) w += String.fromCharCode(97 + Math.floor(r() * 26));
    out.push(w);
  }
  return out;
})();
function fill(buf, kind, r) {
  if (kind === 'random') {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(r() * 256);
    return buf;
  }
  let i = 0, col = 0;
  while (i < buf.length) {
    const w = WORDS[Math.floor(r() * WORDS.length)];
    for (let k = 0; k < w.length && i < buf.length; k++) buf[i++] = w.charCodeAt(k);
    if (i >= buf.length) break;
    col += w.length + 1;
    if (col > 72) { buf[i++] = 10; col = 0; } else buf[i++] = 32;
  }
  buf[buf.length - 1] = 10;
  return buf;
}
const count = (hay, needle) => { let n = 0; for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++; return n; };

// The target at revision `rev` (0-based): the base bytes with the marker written once near the middle, then `rev`
// 48-byte regions overwritten (never the marker), so consecutive revisions delta well whatever the content kind.
// The unpatched bytes, kept for the one cell being generated (a 32 MiB fill is seconds of JavaScript, and every
// revision starts from it).
let baseMemo = { key: '', buf: Buffer.alloc(0) };
function baseContent(seed, c) {
  const key = `${seed}:${c.id}:${c.fileBytes}:${c.content}`;
  if (baseMemo.key !== key) baseMemo = { key, buf: fill(Buffer.alloc(c.fileBytes), c.content, prng(hashSeed(seed, `${c.id}:target`))) };
  return baseMemo.buf;
}
export function targetContent(seed, c, rev) {
  const marker = Buffer.from(POLICY.find);
  if (c.fileBytes < marker.length * 4) throw new Error(`cell ${c.id}: file too small for the marker`);
  const buf = Buffer.from(baseContent(seed, c));
  const at = Math.floor(c.fileBytes / 2);
  const patchRand = prng(hashSeed(seed, `${c.id}:patch`));
  for (let k = 1; k <= rev; k++) {
    const len = Math.min(48, Math.floor(c.fileBytes / 8));
    let off = Math.floor(patchRand() * (c.fileBytes - len - 1));
    if (off + len > at - 1 && off < at + marker.length + 1) off = 0;
    fill(buf.subarray(off, off + len), c.content, prng(hashSeed(seed, `${c.id}:patch:${k}`)));
    if (c.content === 'text') buf[off + len - 1] = 10;
  }
  if (c.content === 'text') { buf[at - 1] = 10; buf[at + marker.length] = 10; }
  marker.copy(buf, at);
  if (count(buf, marker) !== 1) throw new Error(`cell ${c.id} rev ${rev}: the marker must occur exactly once`);
  if (buf.includes(Buffer.from(POLICY.replace))) throw new Error(`cell ${c.id}: the replacement already occurs`);
  return buf;
}
export function editedContent(content) {
  const at = content.indexOf(POLICY.find);
  return Buffer.concat([content.subarray(0, at), Buffer.from(POLICY.replace), content.subarray(at + POLICY.find.length)]);
}
export function backgroundContent(seed, c, file, commit) {
  return fill(Buffer.alloc(BACKGROUND_BYTES), 'text', prng(hashSeed(seed, `${c.id}:bg:${file}:${commit}`)));
}
// Which commits (1-based) rewrite the target, ending with the last commit.
export function targetCommits(c) {
  const n = Math.min(TARGET_REVISIONS, c.commits);
  return Array.from({ length: n }, (_, k) => Math.max(k + 1, Math.round(((k + 1) * c.commits) / n)));
}
// The whole history as `git fast-import` input, yielded in pieces (a 32 MiB target is never joined to the rest).
export function* fastImportStream(seed, c) {
  const ident = stamp => `Fixture <fixture@example.invalid> ${1_700_000_000 + stamp * 60} +0000`;
  const revAt = new Map(targetCommits(c).map((n, k) => [n, k]));
  const file = (path, data) => [Buffer.from(`M 100644 inline ${path}\ndata ${data.length}\n`), data, Buffer.from('\n')];
  for (let n = 1; n <= c.commits; n++) {
    const msg = Buffer.from(`fixture ${c.id} commit ${n}\n`);
    yield Buffer.from(`commit ${REF}\nmark :${n}\nauthor ${ident(n)}\ncommitter ${ident(n)}\ndata ${msg.length}\n`);
    yield msg;
    if (n > 1) yield Buffer.from(`from :${n - 1}\n`);
    if (n === 1) for (let i = 0; i < BACKGROUND_FILES; i++) yield* file(backgroundPath(i), backgroundContent(seed, c, i, 0));
    else { const i = hashSeed(seed, `${c.id}:pick:${n}`) % BACKGROUND_FILES; yield* file(backgroundPath(i), backgroundContent(seed, c, i, n)); }
    if (revAt.has(n) || n === 1) yield* file(targetPath(c), targetContent(seed, c, revAt.get(n) ?? 0));
    yield Buffer.from('\n');
  }
  yield Buffer.from('done\n');
}
export const sha256 = buf => createHash('sha256').update(buf).digest('hex');

// ---- clients and strategies ----------------------------------------------------------------------------------------
// Each native strategy is a list of argv steps run in order with no shell. Placeholders: {url} the repository under
// test, {prev} the same repository one commit behind (reused-state setup only), {dir} an empty directory for the clone,
// {path} the target path, {out} the file a read writes when the strategy has no working-tree copy. A step with
// `stdout` writes its standard output to that file. `setup` steps run before the timed steps and are not measured.
const GIT = 'git';
const sed = ['sed', '-i', `s/${POLICY.find}/${POLICY.replace}/`, '{dir}/{path}'];
const commit = [GIT, '-C', '{dir}', 'commit', '-q', '-a', '-m', POLICY.message];
const push = [GIT, '-C', '{dir}', 'push', '-q', 'origin', `HEAD:${REF}`];
const pull = [GIT, '-C', '{dir}', 'pull', '-q', '--ff-only', 'origin', 'main'];
const retarget = [GIT, '-C', '{dir}', 'remote', 'set-url', 'origin', '{url}'];
const sparse = [[GIT, '-C', '{dir}', 'sparse-checkout', 'set', '--no-cone', '/{path}'], [GIT, '-C', '{dir}', 'checkout', '-q', 'main']];
const catFile = rev => ({ argv: [GIT, '-C', '{dir}', 'cat-file', 'blob', `${rev}:{path}`], stdout: '{out}' });
const worktree = clone => ({
  read: { fresh: { steps: [clone('{url}')], content: '{dir}/{path}' }, reused: { setup: [clone('{prev}'), retarget], steps: [pull], content: '{dir}/{path}' } },
  edit: { fresh: { steps: [clone('{url}'), sed, commit, push] }, reused: { setup: [clone('{prev}'), retarget], steps: [pull, sed, commit, push] } },
});
const partial = clone => ({
  read: {
    fresh: { steps: [clone('{url}'), catFile('HEAD')], content: '{out}' },
    reused: { setup: [clone('{prev}'), catFile('HEAD'), retarget], steps: [[GIT, '-C', '{dir}', 'fetch', '-q', 'origin', 'main'], catFile('FETCH_HEAD')], content: '{out}' },
  },
  edit: {
    fresh: { steps: [clone('{url}'), ...sparse, sed, commit, push] },
    reused: { setup: [clone('{prev}'), ...sparse, retarget], steps: [pull, sed, commit, push] },
  },
});
export const CLIENTS = Object.freeze({
  ply: {
    label: 'ply',
    kind: 'ply',
    needsFilter: false,
    description: 'One fresh node process calling ply (readFile streamed to a file; editFile). Reused mode: the same process first performs the same task against the one-commit-behind copy (unmeasured warm-up: module load, JIT, a kept-alive connection, learned server quirks), then the measured call. ply keeps no repository state between calls; its optional pack cache is not exercised.',
  },
  'git-full': {
    label: 'git full clone', kind: 'git', needsFilter: false,
    description: 'Full clone with checkout. Reused mode: an existing full clone one commit behind, brought up to date with pull --ff-only.',
    tasks: worktree(u => [GIT, 'clone', '-q', u, '{dir}']),
  },
  'git-shallow': {
    label: 'git shallow (--depth 1)', kind: 'git', needsFilter: false,
    description: 'Shallow clone of the tip commit with checkout. Reused mode: an existing shallow clone one commit behind, pull --ff-only.',
    tasks: worktree(u => [GIT, 'clone', '-q', '--depth', '1', u, '{dir}']),
  },
  'git-partial': {
    label: 'git blobless partial', kind: 'git', needsFilter: true,
    description: 'Blobless partial clone (--filter=blob:none) with full commit and tree history and no checkout. Read: git cat-file fetches the one blob on demand. Edit: a non-cone sparse checkout of the one path, so only that blob is fetched.',
    tasks: partial(u => [GIT, 'clone', '-q', '--filter=blob:none', '--no-checkout', u, '{dir}']),
  },
  'git-shallow-partial': {
    label: 'git shallow + blobless', kind: 'git', needsFilter: true,
    description: 'Depth-1 blobless partial clone with no checkout: the leanest stock-git strategy measured. Read: cat-file fetches the one blob. Edit: non-cone sparse checkout of the one path.',
    tasks: partial(u => [GIT, 'clone', '-q', '--depth', '1', '--filter=blob:none', '--no-checkout', u, '{dir}']),
  },
});
export const CLIENT_IDS = Object.freeze(Object.keys(CLIENTS));
export const TASKS = Object.freeze(['read', 'edit']);
export const MODES = Object.freeze(['fresh', 'reused']);
// Environment every native git step runs in: no user or system config, no prompt, no background maintenance (a
// detached `git maintenance` would outlive the measured process tree and race the fixture reset), and the commit policy.
export const GIT_CLIENT_CONFIG = Object.freeze([['gc.auto', '0'], ['maintenance.auto', 'false'], ['credential.helper', ''], ['advice.detachedHead', 'false']]);
export function gitClientEnv(home, path) {
  const date = `${POLICY.time} ${POLICY.tz}`;
  return {
    PATH: path, HOME: home, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: POLICY.author.name, GIT_AUTHOR_EMAIL: POLICY.author.email, GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: POLICY.committer.name, GIT_COMMITTER_EMAIL: POLICY.committer.email, GIT_COMMITTER_DATE: date,
    GIT_CONFIG_COUNT: String(GIT_CLIENT_CONFIG.length),
    ...Object.fromEntries(GIT_CLIENT_CONFIG.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])),
  };
}
const subst = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
export const fillStep = (step, vars) => {
  const s = Array.isArray(step) ? { argv: step } : step;
  return { argv: s.argv.map(a => subst(a, vars)), ...(s.stdout ? { stdout: subst(s.stdout, vars) } : {}) };
};
// The commands as documentation: what the JSON's `strategies` and the README table show.
export function strategyCommands() {
  const show = step => { const s = Array.isArray(step) ? { argv: step } : step; return s.argv.map(a => (/[\s'"$*]/.test(a) ? `'${a}'` : a)).join(' ') + (s.stdout ? ` > ${s.stdout}` : ''); };
  const out = {};
  for (const [id, c] of Object.entries(CLIENTS)) {
    out[id] = { label: c.label, description: c.description, needsServerFilter: c.needsFilter, commands: null };
    if (c.kind !== 'git') continue;
    out[id].commands = {};
    for (const task of TASKS) {
      out[id].commands[task] = {};
      for (const mode of MODES) {
        const t = c.tasks[task][mode];
        out[id].commands[task][mode] = { setup: (t.setup ?? []).map(show), measured: t.steps.map(show), resultAt: t.content ?? 'the server repository' };
      }
    }
  }
  return out;
}

// ---- metrics -------------------------------------------------------------------------------------------------------
export const METRICS = Object.freeze([
  { key: 'elapsedMs', unit: 'ms', label: 'elapsed', lowerIsBetter: true, deterministic: false },
  { key: 'peakPssBytes', unit: 'bytes', label: 'peak PSS (tree)', lowerIsBetter: true, deterministic: false },
  { key: 'peakRssSumBytes', unit: 'bytes', label: 'peak RSS sum (tree)', lowerIsBetter: true, deterministic: false },
  { key: 'maxProcessHwmBytes', unit: 'bytes', label: 'largest process HWM', lowerIsBetter: true, deterministic: false },
  { key: 'requests', unit: 'count', label: 'HTTP requests', lowerIsBetter: true, deterministic: true },
  { key: 'requestBytes', unit: 'bytes', label: 'request bytes', lowerIsBetter: true, deterministic: true },
  { key: 'responseBytes', unit: 'bytes', label: 'response bytes', lowerIsBetter: true, deterministic: true },
  { key: 'fetchPackBytes', unit: 'bytes', label: 'fetched pack bytes', lowerIsBetter: true, deterministic: true },
  { key: 'pushPackBytes', unit: 'bytes', label: 'pushed pack bytes', lowerIsBetter: true, deterministic: true },
]);
export const METRIC_DEFINITIONS = Object.freeze({
  elapsedMs: 'Wall-clock milliseconds. Fresh mode, every client: from just before the first client process is spawned to the close of the last one, measured by bench/compare/measure.mjs (so it includes process start-up: node and module load for ply, every git child for git). Reused mode, git: the same, over the measured steps only (the set-up clone is not timed). Reused mode, ply: performance.now() around the one measured call inside the already-warm process, so it excludes process start-up; this models a long-lived service, and is not comparable with a fresh-mode figure.',
  peakPssBytes: 'Peak, over samples, of the sum of Pss from /proc/<pid>/smaps_rollup across every process in the client\'s session (the client is spawned as a session leader; git-remote-http, index-pack, pack-objects, sed and every other descendant inherit the session). PSS divides each shared page among all the processes mapping it, so the sum does not double-count the git binary or fork-shared pages inside the tree; but it also discounts pages shared with processes outside the tree (the node binary shared with the node processes of the harness, the git binary shared with the git processes of the server), so it understates a client that would otherwise run alone. Read it with peakRssSumBytes: the memory a tree needs lies between the two. It is sampled (interval reported per sample as memory.sampleIntervalMs), so it is a lower bound: a peak between two samples, or a process that lives shorter than one interval, is missed. The server (git http-backend and its children) and the harness are not in the session and are not counted. Linux only; null with memory.unavailable set elsewhere. ply reused mode: the peak covers the whole process, warm-up call included.',
  peakRssSumBytes: 'Peak, over the same samples, of the sum of Rss across the session\'s processes. Shared pages are counted once per process, so this is an upper bound for a multi-process client (git) and the plain RSS of a one-process client (ply). Sampled, like the PSS sum.',
  maxProcessHwmBytes: 'The largest VmHWM (the kernel\'s own per-process peak RSS, from /proc/<pid>/status) seen for any single process of the session. This is the figure `/usr/bin/time -v` or getrusage(RUSAGE_CHILDREN) would report (the largest process, not the sum); a lower bound for the same sampling reason, though tighter, since the kernel keeps the high-water mark between samples.',
  plySelfMaxRssBytes: 'ply only: process.resourceUsage().maxRSS read by the client process just before it exits (the kernel\'s exact ru_maxrss). Compared with maxProcessHwmBytes of the same sample it shows the sampler\'s shortfall.',
  requests: 'HTTP requests the server received for the repository under test during the measured steps.',
  requestBytes: 'Request line + request headers (rebuilt from the raw header list) + request body as received after transfer decoding, summed over those requests. A gzip-encoded body is counted compressed, as sent. Excludes chunked framing and TCP/IP.',
  responseBytes: 'Status line + response headers + response body as written by the server, summed over those requests. Excludes chunked framing and TCP/IP.',
  fetchPackBytes: 'Pack bytes downloaded: the sum of side-band channel 1 payloads after the `packfile` section header in protocol v2 upload-pack responses. null when no fetch response carried a pack, or a response could not be parsed.',
  pushPackBytes: 'Pack bytes uploaded: the receive-pack request body after the command list\'s flush packet (after gunzip when the client gzip-encoded the request). null for a read.',
});
export const CAVEATS = Object.freeze([
  'Loopback only: client and server share one machine and one kernel, with no latency, loss or bandwidth limit. These timings do not predict WAN latency; over a real network round trips and bytes weigh more and CPU weighs less. Use the request counts and byte totals, which do not depend on the link, to reason about that.',
  'This does not establish Cloudflare Workers memory usage. ply is measured here as a Node process (V8 heap, Node runtime, undici); a Worker isolate has a different baseline and a different accounting. bench/worker-mem measures that on the platform.',
  'Process memory is dominated by runtime baselines at these sizes: see baselines.nodeIdle for what a node process that imports ply and does nothing costs.',
  'The server is git http-backend behind a Node CGI shim on the same machine and competes with the clients for CPU. Hosted services (pack caches, bitmaps, CDNs) behave differently.',
  'Native git also leaves a usable local clone behind; ply leaves nothing. The tasks are equal in their effect on the server and in the bytes read, not in what remains on the client.',
  'Elapsed time includes whatever else the machine was doing; environment.loadavg records the load before and after the run.',
]);

// ---- statistics ----------------------------------------------------------------------------------------------------
// Quantiles by linear interpolation between order statistics (R type 7): the median of an even n is the mean of the
// two middle values; q1/q3 are the 25th and 75th percentiles. With n < 4 the quartiles say little: read min and max.
export function quantile(sorted, p) {
  if (!sorted.length) return null;
  const h = (sorted.length - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}
export function stats(values) {
  const v = values.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return { n: v.length, median: quantile(v, 0.5), min: v[0], max: v.at(-1), q1: quantile(v, 0.25), q3: quantile(v, 0.75) };
}

export const groupKey = s => `${s.cell}|${s.task}|${s.mode}|${s.client}`;
// One row per (cell, task, mode, client): counts of accepted, failed and unsupported samples and, per metric, the
// statistics of the accepted samples only. A failed sample contributes to `failed`, never to a statistic.
export function summarize(samples) {
  const groups = new Map();
  for (const s of samples) {
    const k = groupKey(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  return [...groups.values()].map(g => {
    const ok = g.filter(s => s.status === 'ok');
    const commits = [...new Set(ok.map(s => s.verification?.commit).filter(Boolean))];
    return {
      cell: g[0].cell, task: g[0].task, mode: g[0].mode, client: g[0].client,
      attempted: g.length, accepted: ok.length, failed: g.filter(s => s.status === 'failed').length,
      unsupported: g.filter(s => s.status === 'unsupported').length,
      reasons: [...new Set(g.filter(s => s.status !== 'ok').map(s => s.reason))],
      commits,
      metrics: Object.fromEntries(METRICS.map(m => [m.key, stats(ok.map(s => s.metrics?.[m.key]))])),
    };
  });
}
// ply against every native strategy, per metric. `ratio` is ply's median over git's (above 1: ply is higher, which is
// worse for every metric here). `separated` is true when the two [min, max] ranges do not overlap; a difference whose
// ranges overlap is reported but should not be read as a result. Equal medians are a tie.
export function compare(summary) {
  const out = [];
  const by = new Map(summary.map(r => [groupKey(r), r]));
  for (const p of summary.filter(r => r.client === 'ply')) {
    for (const r of summary.filter(x => x.client !== 'ply' && x.cell === p.cell && x.task === p.task && x.mode === p.mode)) {
      for (const m of METRICS) {
        const a = by.get(groupKey(p)).metrics[m.key], b = r.metrics[m.key];
        if (!a || !b) continue;
        const verdict = a.median === b.median ? 'tie' : a.median < b.median ? 'ply-lower' : 'ply-higher';
        out.push({
          cell: p.cell, task: p.task, mode: p.mode, metric: m.key, against: r.client,
          ply: a.median, other: b.median, ratio: b.median === 0 ? null : a.median / b.median,
          verdict, separated: a.max < b.min || b.max < a.min,
        });
      }
    }
  }
  return out;
}

// ---- schema --------------------------------------------------------------------------------------------------------
// The documented shape of the results JSON (bench/compare/README.md). Returns the problems found; [] means valid.
export function validateResults(r) {
  const bad = [];
  const need = (cond, msg) => { if (!cond) bad.push(msg); };
  const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const str = x => typeof x === 'string' && x.length > 0;
  const numOrNull = x => x === null || (typeof x === 'number' && Number.isFinite(x));
  need(isObj(r), 'results must be an object');
  if (!isObj(r)) return bad;
  need(r.schema === SCHEMA, `schema must be ${SCHEMA}`);
  need(str(r.generatedAt) && !Number.isNaN(Date.parse(r.generatedAt)), 'generatedAt must be an ISO date');
  need(isObj(r.source) && /^[0-9a-f]{40}$/.test(r.source.commit ?? '') && typeof r.source.dirty === 'boolean', 'source.commit (40 hex) and source.dirty');
  need(isObj(r.source) && (r.source.dirty ? /^[0-9a-f]{64}$/.test(r.source.dirtySha256 ?? '') : r.source.dirtySha256 === null), 'source.dirtySha256 names a dirty tree and is null for a clean one');
  need(isObj(r.environment) && str(r.environment.node) && str(r.environment.git), 'environment.node and environment.git');
  need(isObj(r.environment?.os) && str(r.environment.os.platform) && str(r.environment.os.release) && str(r.environment.os.arch), 'environment.os.{platform,release,arch}');
  need(Array.isArray(r.environment?.loadavg?.before) && Array.isArray(r.environment?.loadavg?.after), 'environment.loadavg.{before,after}');
  need(str(r.environment?.machine), 'environment.machine');
  need(isObj(r.config) && Number.isInteger(r.config.seed) && Number.isInteger(r.config.repetitions) && r.config.repetitions > 0 && str(r.config.matrix) && str(r.config.plyBuild), 'config.{seed,repetitions,matrix,plyBuild}');
  need(isObj(r.server) && str(r.server.kind) && isObj(r.server.gitConfig) && typeof r.server.filter === 'boolean', 'server.{kind,gitConfig,filter}');
  need(isObj(r.policy) && isObj(r.policy.author) && str(r.policy.message), 'policy');
  need(isObj(r.metricDefinitions) && METRICS.every(m => str(r.metricDefinitions[m.key])), 'metricDefinitions for every metric');
  need(Array.isArray(r.caveats) && r.caveats.some(c => /WAN/.test(c)) && r.caveats.some(c => /Workers/.test(c)), 'caveats must state the WAN and Workers limits');
  need(isObj(r.strategies) && CLIENT_IDS.every(id => isObj(r.strategies[id])), 'strategies for every client');
  need(isObj(r.baselines), 'baselines');
  need(Array.isArray(r.cells) && r.cells.length > 0, 'cells');
  for (const c of r.cells ?? []) need(str(c.id) && isObj(c.params) && isObj(c.fixture) && /^[0-9a-f]{40}$/.test(c.fixture.head ?? ''), `cell ${c.id}: id, params, fixture.head`);
  need(Array.isArray(r.samples) && r.samples.length > 0, 'samples');
  const cellIds = new Set((r.cells ?? []).map(c => c.id));
  for (const [i, s] of (r.samples ?? []).entries()) {
    const at = `samples[${i}]`;
    need(cellIds.has(s.cell) && TASKS.includes(s.task) && MODES.includes(s.mode) && CLIENT_IDS.includes(s.client) && Number.isInteger(s.rep), `${at}: cell, task, mode, client, rep`);
    need(['ok', 'failed', 'unsupported'].includes(s.status), `${at}: status`);
    if (s.status !== 'ok') { need(str(s.reason), `${at}: a ${s.status} sample states its reason`); continue; }
    need(isObj(s.verification) && s.verification.ok === true && Array.isArray(s.verification.checks) && s.verification.checks.every(c => c.ok === true), `${at}: an accepted sample passed every verification check`);
    need(isObj(s.metrics) && METRICS.every(m => numOrNull(s.metrics[m.key])), `${at}: every metric is a number or null`);
    need(typeof s.metrics?.elapsedMs === 'number' && Number.isInteger(s.metrics?.requests), `${at}: elapsedMs and requests are measured`);
    need(isObj(s.memory) && typeof s.memory.available === 'boolean' && (s.memory.available || str(s.memory.unavailable)), `${at}: memory.available, or the reason it is not`);
    need(s.memory?.available !== false || s.metrics.peakPssBytes === null, `${at}: no memory number without a measurement`);
  }
  need(Array.isArray(r.summary) && r.summary.length > 0, 'summary');
  for (const row of r.summary ?? []) need(row.attempted === row.accepted + row.failed + row.unsupported, `summary ${groupKey(row)}: attempted = accepted + failed + unsupported`);
  need(Array.isArray(r.comparisons), 'comparisons');
  need(isObj(r.totals) && ['samples', 'accepted', 'failed', 'unsupported'].every(k => Number.isInteger(r.totals[k])), 'totals');
  return bad;
}

// ---- rendering -----------------------------------------------------------------------------------------------------
const fmtBytes = b => (b === null || b === undefined ? 'n/a' : b >= 10 * MIB ? `${(b / MIB).toFixed(0)} MiB` : b >= MIB ? `${(b / MIB).toFixed(1)} MiB` : b >= 10 * KIB ? `${(b / KIB).toFixed(0)} KiB` : b >= KIB ? `${(b / KIB).toFixed(1)} KiB` : `${Math.round(b)} B`);
const fmtMs = v => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
const fmtOf = unit => (unit === 'ms' ? fmtMs : unit === 'bytes' ? fmtBytes : v => String(Math.round(v * 10) / 10));
const spread = (st, unit, deterministic) => {
  if (!st) return 'n/a';
  const f = fmtOf(unit);
  // the range is printed whenever it is visible at the printed precision
  return f(st.min) === f(st.max) ? f(st.median) : deterministic ? `${f(st.median)} (${f(st.min)}–${f(st.max)})` : `${f(st.median)} [${f(st.min)}–${f(st.max)}]`;
};
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');

export function renderMarkdown(r) {
  const L = [];
  const label = id => r.strategies[id]?.label ?? id;
  const dirty = r.source.dirty ? ` + uncommitted changes (sha256 ${r.source.dirtySha256.slice(0, 12)})` : ' (clean tree)';
  L.push('# ply vs native git: end-to-end comparison', '');
  L.push(`Generated ${r.generatedAt} by \`${r.command}\` from the results JSON (schema \`${r.schema}\`).`, '');
  L.push(table(['', ''], [
    ['source', `\`${r.source.commit}\`${dirty}`],
    ['ply build', r.config.plyBuild],
    ['matrix / seed / repetitions', `${r.config.matrix} / ${r.config.seed} / n = ${r.config.repetitions} per cell, client, task and mode`],
    ['node / git', `${r.environment.node} / ${r.environment.git}`],
    ['OS', `${r.environment.os.platform} ${r.environment.os.release} ${r.environment.os.arch}, ${r.environment.cpus.count} × ${r.environment.cpus.model}, ${fmtBytes(r.environment.totalMemBytes)} RAM`],
    ['machine', r.environment.machine],
    ['load average (1/5/15 min)', `before ${r.environment.loadavg.before.map(x => x.toFixed(2)).join(' ')}, after ${r.environment.loadavg.after.map(x => x.toFixed(2)).join(' ')}`],
    ['server', `${r.server.kind}; ${Object.entries(r.server.gitConfig).map(([k, v]) => `${k}=${v}`).join(', ')}`],
    ['samples', `${r.totals.samples} attempted: ${r.totals.accepted} accepted (verified), ${r.totals.failed} failed, ${r.totals.unsupported} unsupported`],
    ['wall time of the run', `${(r.durationMs / 1000).toFixed(0)} s`],
  ]), '');
  L.push('## Read this first', '');
  const load = Math.max(r.environment.loadavg.before[0], r.environment.loadavg.after[0], r.environment.loadavg.max1m ?? 0);
  if (load > r.environment.cpus.count / 2) L.push(`- **This run was measured under load**: the 1-minute load average reached ${load.toFixed(2)} on ${r.environment.cpus.count} CPUs, from work that is not part of the benchmark. Elapsed times here are inflated and noisy and are not quiet-machine figures; the request counts, byte totals and pack sizes do not depend on load.`);
  for (const c of r.caveats) L.push(`- ${c}`);
  L.push('');
  L.push('Cells show the **median** of the accepted samples; `[min–max]` follows when the samples differ. Byte and request counts are exact per sample and usually identical across repetitions. A sample is accepted only after the harness has checked the resulting bytes, the commit\'s parent and `git fsck --strict` on the server repository; failed samples are counted in the `ok/n` column and listed below, never averaged in.', '');

  const base = r.baselines;
  L.push('## Baselines', '');
  if (base.nodeIdle?.peakPssBytes) {
    const b = base.nodeIdle;
    L.push(`- A node process that imports the same ply modules and exits without doing anything (n = ${b.peakPssBytes.n}): peak RSS ${spread(b.peakRssSumBytes, 'bytes')}, peak PSS ${spread(b.peakPssBytes, 'bytes')}, largest-process HWM ${spread(b.maxProcessHwmBytes, 'bytes')}, self-reported maxRSS ${spread(b.plySelfMaxRssBytes, 'bytes')}, elapsed ${spread(b.elapsedMs, 'ms')} ms. Most of ply's process memory and fresh-mode time below is this runtime baseline, not ply's work.`);
    L.push(`- A node process with an empty script (n = ${base.nodeEmpty.peakPssBytes.n}): peak RSS ${spread(base.nodeEmpty.peakRssSumBytes, 'bytes')}, peak PSS ${spread(base.nodeEmpty.peakPssBytes, 'bytes')}, elapsed ${spread(base.nodeEmpty.elapsedMs, 'ms')} ms.`);
    L.push(`- RSS against PSS: node's PSS is far below its RSS because the node binary's pages are shared with the harness's own node processes (and any other node on the machine), and PSS divides shared pages among all their mappers, inside the measured tree or not. For a one-process client RSS is the figure to read; for git's several processes the RSS sum counts the git binary once per process and the PSS sum does not. The truth for a tree lies between the two columns.`);
    L.push(base.gitIdle.peakRssSumBytes?.median ? `- \`git --version\` (n = ${base.gitIdle.elapsedMs.n}): peak RSS ${spread(base.gitIdle.peakRssSumBytes, 'bytes')}, elapsed ${spread(base.gitIdle.elapsedMs, 'ms')} ms.` : `- \`git --version\` (n = ${base.gitIdle.elapsedMs?.n ?? 0}): elapsed ${spread(base.gitIdle.elapsedMs, 'ms')} ms; memory not resolved (the process is gone before the sampler's first complete sample, which is the sampler's blind spot stated in the metric definitions).`);
  } else L.push(`- Memory baselines unavailable: ${base.unavailable ?? 'not measured'}.`);
  if (base.samplerCheck) L.push(`- Sampler check: ${base.samplerCheck.summary}`);
  L.push('');

  L.push('## Fixtures', '');
  L.push(table(['cell', 'commits', 'target', 'content (zlib ratio)', 'depth', 'path', 'server pack', 'objects', 'head'],
    r.cells.map(c => [c.id, c.params.commits, fmtBytes(c.params.fileBytes), `${c.params.content} (${c.fixture.zlibRatio.toFixed(2)})`, c.params.depth, `\`${c.fixture.path}\``, fmtBytes(c.fixture.packBytes), c.fixture.objects, `\`${c.fixture.head.slice(0, 10)}\``])), '');

  for (const task of TASKS) for (const mode of MODES) {
    const rows = r.summary.filter(s => s.task === task && s.mode === mode);
    if (!rows.length) continue;
    L.push(`## ${task === 'read' ? 'Read one file at a ref' : 'Edit one file, commit, push'}: ${mode === 'fresh' ? 'fresh client' : 'reused state'}`, '');
    if (mode === 'reused') L.push('git: an existing clone one commit behind (set-up not measured), then fetch/pull and the task. ply: a warm process (one unmeasured call first); its elapsed time excludes process start-up and its memory covers the whole process. Do not compare these elapsed figures with the fresh tables.', '');
    const pack = task === 'read' ? ['fetchPackBytes'] : ['fetchPackBytes', 'pushPackBytes'];
    const cols = ['elapsedMs', 'peakRssSumBytes', 'peakPssBytes', 'maxProcessHwmBytes', 'requests', 'requestBytes', 'responseBytes', ...pack].map(k => METRICS.find(m => m.key === k));
    L.push(table(['cell', 'client', 'ok/n', 'elapsed ms', 'peak RSS sum, tree', 'peak PSS sum, tree', 'largest process HWM', 'requests', 'request bytes', 'response bytes', ...pack.map(k => (k === 'fetchPackBytes' ? 'fetched pack' : 'pushed pack'))],
      rows.map(s => [s.cell, label(s.client), s.unsupported === s.attempted ? 'unsupported' : `${s.accepted}/${s.attempted - s.unsupported}`, ...cols.map(m => spread(s.metrics[m.key], m.unit, m.deterministic))])), '');
  }

  const headline = ['elapsedMs', 'peakRssSumBytes', 'peakPssBytes', 'requests', 'requestBytes', 'responseBytes'];
  const name = k => METRICS.find(m => m.key === k).label;
  const line = c => `${c.cell} ${c.task}/${c.mode}: ${name(c.metric)} ${fmtOf(METRICS.find(m => m.key === c.metric).unit)(c.ply)} vs ${fmtOf(METRICS.find(m => m.key === c.metric).unit)(c.other)} for ${label(c.against)} (×${c.ratio === null ? '∞' : c.ratio.toFixed(2)}${c.separated ? '' : ', ranges overlap'})`;
  const leanest = r.comparisons.filter(c => c.against === 'git-shallow-partial' && headline.includes(c.metric));
  L.push('## Where ply loses', '');
  L.push('Every cell where ply\'s median is higher (worse) than the median of the leanest native strategy measured (`git shallow + blobless`), for elapsed time, peak memory (both sums), requests and HTTP bytes. "ranges overlap" means the two min–max ranges intersect, so the difference is not established by this run. The full list against every strategy and metric is `comparisons` in the JSON.', '');
  const losses = leanest.filter(c => c.verdict === 'ply-higher');
  if (losses.length) for (const c of losses) L.push(`- ${line(c)}`); else L.push(leanest.length ? '- None in this run.' : '- No comparison available (the leanest strategy has no accepted samples).');
  L.push('');
  const counts = id => { const cs = r.comparisons.filter(c => c.against === id && headline.includes(c.metric)); return [label(id), ...headline.map(k => { const m = cs.filter(c => c.metric === k); return `${m.filter(c => c.verdict === 'ply-lower').length} / ${m.filter(c => c.verdict === 'tie').length} / ${m.filter(c => c.verdict === 'ply-higher').length}`; })]; };
  L.push('## Score by strategy', '', 'Cells (cell × task × mode) where ply\'s median is lower / equal / higher than the strategy\'s. Lower is better for every metric.', '');
  L.push(table(['against', ...headline.map(name)], CLIENT_IDS.filter(id => id !== 'ply').map(counts)), '');

  const failed = r.samples.filter(s => s.status === 'failed');
  L.push('## Failures', '');
  if (failed.length) for (const s of failed) L.push(`- ${s.cell} ${s.task}/${s.mode} ${label(s.client)} rep ${s.rep}: ${s.reason}`); else L.push('- None: every attempted sample passed verification.');
  L.push('');
  const unsup = r.summary.filter(s => s.unsupported > 0);
  L.push('## Unsupported cells', '');
  if (unsup.length) for (const s of unsup) L.push(`- ${s.cell} ${s.task}/${s.mode} ${label(s.client)}: ${s.reasons.join('; ')}`); else L.push('- None.');
  L.push('');
  const disagree = r.cells.filter(c => c.commitAgreement && !c.commitAgreement.agreed);
  L.push('## Equivalence of the edit', '');
  L.push(disagree.length ? `- Clients produced different commit ids in: ${disagree.map(c => c.id).join(', ')} (see cells[].commitAgreement).` : '- In every cell, every accepted edit sample of every client produced the same commit id (same parent, tree, author, committer, date and message), listed per cell in `cells[].commitAgreement`.', '');

  L.push('## Strategies', '');
  for (const [id, s] of Object.entries(r.strategies)) {
    L.push(`**${s.label}** (\`${id}\`): ${s.description}`, '');
    if (!s.commands) continue;
    for (const task of TASKS) for (const mode of MODES) {
      const c = s.commands[task][mode];
      L.push(`- ${task}, ${mode}${c.setup.length ? ` (set-up, not measured: ${c.setup.map(x => `\`${x}\``).join('; ')})` : ''}: ${c.measured.map(x => `\`${x}\``).join('; ')}`);
    }
    L.push('');
  }
  L.push('## Metric definitions', '');
  for (const [k, v] of Object.entries(r.metricDefinitions)) L.push(`- \`${k}\`: ${v}`);
  L.push('');
  return L.join('\n');
}
