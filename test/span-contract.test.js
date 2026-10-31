// The telemetry contract (#35). Span names and attribute keys are public API: consumers build dashboards and alerts on
// them. Every public operation and the wire spans run against real git (http-backend), and the span tree each produces is reduced to its shape: names, kinds, parent/child structure, links, and
// attribute KEYS with their value types (never values). The shape must equal test/span-contract.json.
//
//   a span or key removed or renamed → this test fails, naming it: a breaking change (README "Telemetry contract")
//   a span or key added             → this test fails too, until the snapshot is regenerated and reviewed:
//                                      UPDATE_SPAN_CONTRACT=1 npx vitest run test/span-contract.test.js
//
// Shape rules. Siblings with the same name merge into one node (a fetch made three times is one `git.upload-pack fetch`
// node with the union of their keys), so a round-trip count is not part of the contract; their order in the file is by
// name. OTLP intValue and doubleValue are both `number` (a duration that happens to be whole encodes as an int). A span
// that follows another (README "Span lifetimes") is listed under that span's `followers`, not its `children`.
//
// Also here: the lifetime rule. In every trace above, no span starts before or ends after its parent; a span with no
// parent is either an operation root (it carries ply.isolate.invocation) or follows an exported span via a
// follows_from link.
import { test, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { git, tmpRoot, makeBareRepo, startGitServer } from './server.js';
import { Tracer, arrayExporter, KIND } from '../src/otel.js';
import { createTransport } from '../src/http.js';
import { editFile } from '../src/edit.js';
import { pushTree } from '../src/tree.js';
import { checkoutTree } from '../src/checkout.js';
import { readFile, listTree, readCommit } from '../src/read.js';
import { mergeBranch } from '../src/merge.js';
import { rebaseBranch, cherryPick, revertCommit } from '../src/rebase.js';
import { lsRefs } from '../src/lsrefs.js';
import { fetchPack } from '../src/fetchpack.js';
import { discover } from '../src/discover.js';
import { receiveCaps } from '../src/receivecaps.js';

const SNAPSHOT = new URL('./span-contract.json', import.meta.url);
const UPDATE = process.env.UPDATE_SPAN_CONTRACT === '1';
const author = { name: 'contract', email: 'contract@x' };
const KIND_NAME = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k]));

// ---- shape (pure) ----
const TYPE_OF = { stringValue: 'string', intValue: 'number', doubleValue: 'number', boolValue: 'boolean', arrayValue: 'array', bytesValue: 'bytes' };
const valueType = v => TYPE_OF[Object.keys(v)[0]] ?? 'unknown';
const spansOf = lines => lines.flatMap(l => l.resourceSpans.flatMap(rs => rs.scopeSpans.flatMap(ss => ss.spans)));
const linkKind = l => (l.attributes ?? []).find(a => a.key === 'ply.link')?.value.stringValue ?? '';

// raw OTLP spans → [root node]: { name, kind, attrs: {key: type}, links: [kind], children: [node], followers: [node] }
export function shape(spans, { skipRoot = null } = {}) {
  const byId = new Map(spans.map(s => [s.spanId, { s, children: [], followers: [] }]));
  const roots = [];
  for (const n of byId.values()) {
    const follows = n.s.links?.find(l => linkKind(l) === 'follows_from');
    const up = n.s.parentSpanId ? byId.get(n.s.parentSpanId) : follows ? byId.get(follows.spanId) : null;
    if (n.s.parentSpanId && !up) throw new Error(`span ${n.s.name} has a parent that was never exported`);
    if (up) (n.s.parentSpanId ? up.children : up.followers).push(n); else roots.push(n);
  }
  const merge = group => {
    const attrs = {}, links = new Set();
    for (const { s } of group) {
      for (const { key, value } of s.attributes) { const t = valueType(value); attrs[key] = attrs[key] && attrs[key] !== t ? [...new Set([...attrs[key].split('|'), t])].sort().join('|') : t; }
      for (const l of s.links ?? []) links.add(linkKind(l));
    }
    const node = { name: group[0].s.name, kind: [...new Set(group.map(({ s }) => KIND_NAME[s.kind]))].join('|'), attrs: Object.fromEntries(Object.entries(attrs).sort(([a], [b]) => (a < b ? -1 : 1))) };
    if (links.size) node.links = [...links].sort();
    const children = collapse(group.flatMap(g => g.children)), followers = collapse(group.flatMap(g => g.followers));
    if (children.length) node.children = children;
    if (followers.length) node.followers = followers;
    return node;
  };
  const collapse = nodes => {
    const by = new Map();
    for (const n of nodes) { const l = by.get(n.s.name); if (l) l.push(n); else by.set(n.s.name, [n]); }
    return [...by.keys()].sort().map(k => merge(by.get(k)));
  };
  const top = skipRoot ? roots.filter(r => r.s.name === skipRoot).flatMap(r => r.children) : roots;
  return collapse(top);
}

// a shape → sorted lines, one per span and one per key: what the failure diff is made of
export function flatten(nodes, prefix = '') {
  const out = [];
  for (const n of nodes) {
    const p = `${prefix}${n.name}`;
    out.push(`${p} [${n.kind}]${n.links ? ` links=${n.links.join(',')}` : ''}`);
    for (const [k, t] of Object.entries(n.attrs)) out.push(`${p} · ${k}: ${t}`);
    out.push(...flatten(n.children ?? [], `${p} > `), ...flatten(n.followers ?? [], `${p} ~> `));
  }
  return out;
}

export function contractDiff(want, got) {
  const lines = [];
  for (const op of [...new Set([...Object.keys(want), ...Object.keys(got)])].sort()) {
    const w = new Set(flatten(want[op] ?? [])), g = new Set(flatten(got[op] ?? []));
    const removed = [...w].filter(x => !g.has(x)), added = [...g].filter(x => !w.has(x));
    if (!removed.length && !added.length) continue;
    lines.push(`${op}:`);
    for (const x of removed) lines.push(`  - ${x}`);
    for (const x of added) lines.push(`  + ${x}`);
  }
  return lines;
}

// no child outside its parent's [start, end]; every parentless span is an invocation root or follows an exported span
export function lifetimeViolations(spans) {
  const byId = new Map(spans.map(s => [s.spanId, s]));
  const bad = [];
  for (const s of spans) {
    const [start, end] = [BigInt(s.startTimeUnixNano), BigInt(s.endTimeUnixNano)];
    if (s.parentSpanId) {
      const p = byId.get(s.parentSpanId);
      if (!p) { bad.push(`${s.name}: parent never exported`); continue; }
      if (p.traceId !== s.traceId) bad.push(`${s.name}: parent in another trace`);
      if (start < BigInt(p.startTimeUnixNano)) bad.push(`${s.name} starts before its parent ${p.name}`);
      if (end > BigInt(p.endTimeUnixNano)) bad.push(`${s.name} ends ${Number(end - BigInt(p.endTimeUnixNano)) / 1e6} ms after its parent ${p.name}`);
      continue;
    }
    if (s.attributes.some(a => a.key === 'ply.isolate.invocation')) continue;
    const f = s.links?.find(l => linkKind(l) === 'follows_from');
    if (!f) bad.push(`${s.name}: parentless, not an operation root, and follows nothing`);
    else if (!byId.has(f.spanId)) bad.push(`${s.name}: follows a span that was never exported`);
    else if (byId.get(f.spanId).traceId === s.traceId) bad.push(`${s.name}: follows a span in its own trace (it should be a child)`);
  }
  return bad;
}

// ---- fixtures: real git behind http-backend ----
let root, cleanup, srv, n = 0;
before(async () => { ({ root, cleanup } = tmpRoot()); srv = await startGitServer(root); });
after(async () => { await srv?.close(); cleanup?.(); });

const repo = () => {
  const name = `c${n++}`; const bare = makeBareRepo(root, name); const work = join(root, `w${name}`);
  mkdirSync(work); git(work, ['init', '-q', '-b', 'main']);
  return { bare, work, url: `${srv.url}/${name}.git` };
};
const G = ['-c', 'user.name=seed', '-c', 'user.email=seed@x', '-c', 'commit.gpgsign=false'];
// commit `files` on `branch` (created from `from`) and push it; null deletes a path. Returns the commit oid.
const commitOn = (r, branch, files, msg, from = branch) => {
  const exists = b => { try { git(r.work, ['rev-parse', '-q', '--verify', `refs/heads/${b}`]); return true; } catch { return false; } };
  if (exists(from)) git(r.work, ['checkout', '-q', '-B', branch, from]); else git(r.work, ['checkout', '-q', '-B', branch]);
  for (const [p, v] of Object.entries(files)) {
    if (v === null) { git(r.work, ['rm', '-q', p]); continue; }
    mkdirSync(join(r.work, p, '..'), { recursive: true }); writeFileSync(join(r.work, p), v);
  }
  git(r.work, ['add', '-A']); git(r.work, [...G, 'commit', '-q', '--allow-empty', '-m', msg]);
  git(r.work, ['push', '-q', '-f', r.bare, `HEAD:refs/heads/${branch}`]);
  return git(r.work, ['rev-parse', 'HEAD']).trim();
};
const seeded = () => { const r = repo(); r.base = commitOn(r, 'main', { 'a/b.txt': 'MARK\n', 'a/c.txt': 'c\n', 'big.bin': Buffer.alloc(200_000, 7), 'README.md': '# r\n' }, 'seed'); return r; };
const drain = async stream => { const rd = stream.getReader(); let bytes = 0; for (;;) { const { value, done } = await rd.read(); if (done) return bytes; bytes += value.length; } };
const traced = () => { const ex = arrayExporter(); return { tracer: new Tracer({ exporter: ex }), spans: () => spansOf(ex.lines) }; };

// one entry per public operation (and the wire layer): name → async ({ tracer }) => void, every stream drained
const SCENARIOS = {
  editFile: async ({ tracer }) => { const r = seeded(); await editFile(r.url, { path: 'a/b.txt', find: 'MARK', replace: 'DONE', author, message: 'edit' }, { tracer, verify: true }); },
  pushTree: async ({ tracer }) => { const r = seeded(); await pushTree(r.url, { files: { 'a/b.txt': 'NEW\n', 'a/c.txt': 'c\n', 'x/y.txt': 'y\n' }, author, message: 'deploy' }, { tracer, verify: true }); },
  checkoutTree: async ({ tracer }) => { const r = seeded(); const res = await checkoutTree(r.url, {}, { tracer }); for await (const f of res.files) if (f.stream) await drain(f.stream); },
  'checkoutTree(batch=1)': async ({ tracer }) => { const r = seeded(); const res = await checkoutTree(r.url, { path: 'a' }, { tracer, batch: 1 }); for await (const f of res.files) if (f.stream) await drain(f.stream); },
  readFile: async ({ tracer }) => { const r = seeded(); const res = await readFile(r.url, { path: 'a/b.txt' }, { tracer }); await drain(res.stream); },
  listTree: async ({ tracer }) => { const r = seeded(); await listTree(r.url, { path: 'a' }, { tracer }); },
  readCommit: async ({ tracer }) => { const r = seeded(); await readCommit(r.url, {}, { tracer }); },
  mergeBranch: async ({ tracer }) => {
    const r = seeded(); commitOn(r, 'feat', { 'f.txt': 'f\n' }, 'feat', 'main'); commitOn(r, 'main', { 'a/c.txt': 'c2\n' }, 'main moves');
    await mergeBranch(r.url, { ref: 'refs/heads/main', from: 'refs/heads/feat', author, message: 'merge feat' }, { tracer, verify: true });
  },
  rebaseBranch: async ({ tracer }) => {
    const r = seeded(); commitOn(r, 'feat', { 'f.txt': 'f\n' }, 'feat 1', 'main'); commitOn(r, 'feat', { 'g.txt': 'g\n' }, 'feat 2'); commitOn(r, 'main', { 'a/c.txt': 'c2\n' }, 'main moves');
    await rebaseBranch(r.url, { ref: 'refs/heads/feat', onto: 'refs/heads/main', committer: author }, { tracer });
  },
  cherryPick: async ({ tracer }) => {
    const r = seeded(); const pick = commitOn(r, 'feat', { 'f.txt': 'f\n' }, 'feat', 'main'); commitOn(r, 'main', { 'a/c.txt': 'c2\n' }, 'main moves');
    await cherryPick(r.url, { ref: 'refs/heads/main', commit: pick, committer: author }, { tracer });
  },
  revertCommit: async ({ tracer }) => {
    const r = seeded(); const bad = commitOn(r, 'main', { 'a/c.txt': 'c2\n' }, 'oops'); commitOn(r, 'main', { 'f.txt': 'f\n' }, 'later');
    await revertCommit(r.url, { ref: 'refs/heads/main', commit: bad, committer: author }, { tracer });
  },
  // the wire spans on their own, under a harness span that is not part of the contract
  wire: async ({ tracer }) => {
    const r = seeded(); const holder = tracer.start('contract.harness');
    const t = createTransport(r.url, { tracer, parent: holder });
    await discover(t); await receiveCaps(t);
    const { refs } = await lsRefs(t, ['refs/heads/main']);
    await fetchPack(t, { wants: [refs.get('refs/heads/main').oid], filter: 'blob:none', deepen: 1 });
    holder.end();
  },
};


async function record(scenarios) {
  const out = {}, all = [];
  for (const [name, run] of Object.entries(scenarios)) {
    const { tracer, spans } = traced();
    await run({ tracer });
    const s = spans(); all.push(...s);
    out[name] = shape(s, { skipRoot: name === 'wire' ? 'contract.harness' : null });
  }
  return { shapes: out, spans: all };
}

let recorded = null;
const recordAll = async () => (recorded ??= (async () => {
  return record(SCENARIOS);
})());

test('span contract: every operation\'s span tree (names, kinds, structure, links, attribute keys and types) equals test/span-contract.json', async () => {
  const { shapes } = await recordAll();
  if (UPDATE) { writeFileSync(SNAPSHOT, `${JSON.stringify(shapes, null, 2)}\n`); return; }
  assert.ok(existsSync(SNAPSHOT), 'no snapshot: run UPDATE_SPAN_CONTRACT=1 npx vitest run test/span-contract.test.js');
  const want = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  const diff = contractDiff(want, shapes);
  assert.deepEqual(diff, [], [
    'the span contract changed (- is in test/span-contract.json but no longer emitted: removing or renaming it is a breaking change; + is new: review it, then regenerate with UPDATE_SPAN_CONTRACT=1 npx vitest run test/span-contract.test.js):',
    ...diff,
  ].join('\n'));
  // the diff is set-based; the file must also be exactly what the generator writes (no hand edits, nothing reordered)
  assert.equal(readFileSync(SNAPSHOT, 'utf8'), `${JSON.stringify(shapes, null, 2)}\n`);
});

test('span contract: the snapshot covers every public operation, and the wire spans', async () => {
  const want = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  const names = new Set(flatten(Object.values(want).flat()).map(l => l.split(' [')[0].split(' · ')[0].split(/ (?:>|~>) /).at(-1)));
  for (const s of ['git.edit', 'git.push_tree', 'git.checkout', 'git.checkout.blobs', 'git.read', 'git.read.blob', 'git.ls_tree', 'git.read_commit', 'git.merge', 'git.rebase', 'git.cherry_pick', 'git.revert',
    'git.upload-pack ls-refs', 'git.upload-pack fetch', 'git.upload-pack discover', 'git.receive-pack', 'git.receive-pack advertise']) assert.ok(names.has(s), `${s} is not in the contract`);
});

test('span lifetimes: no span outlives its parent; a parentless span is an operation root or follows an exported one', async () => {
  const { spans } = await recordAll();
  assert.ok(spans.length > 50);
  assert.deepEqual(lifetimeViolations(spans), []);
});

test('span naming: the rules test/pure.test.js checks on one edit hold on every span above', async () => {
  const { spans } = await recordAll();
  const NAME = /^(git\.(upload-pack|receive-pack)( [a-z-]+)?|git\.[a-z_]+(\.[a-z_]+)?)$/;
  const KEY = /^(git|http|url|server|mem|error|ply|exception)\.[a-z0-9_.-]+$/;
  for (const s of spans.filter(x => x.name !== 'contract.harness')) {
    assert.match(s.name, NAME);
    for (const { key } of s.attributes) assert.match(key, KEY, `attr ${key} on ${s.name}`);
    if (!s.parentSpanId) assert.ok(s.attributes.some(a => a.key === `${s.name}.outcome`), `trace root ${s.name} has no ${s.name}.outcome`);
  }
});

test('span lifetimes: a blob read long after readFile returns is its own trace, linked both ways, and ends with the stream', async () => {
  const r = seeded(); const { tracer, spans } = traced();
  const res = await readFile(r.url, { path: 'big.bin' }, { tracer });
  const rootSpan = spans().find(s => s.name === 'git.read');
  assert.ok(rootSpan, 'the root is exported when readFile returns, before the stream is read');
  assert.equal(spans().find(s => s.name === 'git.read.blob'), undefined, 'the blob span is still open');
  await new Promise(ok => setTimeout(ok, 30));
  assert.equal(await drain(res.stream), 200_000);
  const blob = spans().find(s => s.name === 'git.read.blob');
  assert.equal(blob.parentSpanId, undefined); assert.notEqual(blob.traceId, rootSpan.traceId);
  assert.deepEqual(blob.links.map(l => [l.traceId, l.spanId, linkKind(l)]), [[rootSpan.traceId, rootSpan.spanId, 'follows_from']]);
  assert.deepEqual(rootSpan.links.map(l => [l.traceId, l.spanId, linkKind(l)]), [[blob.traceId, blob.spanId, 'followed_by']]);
  assert.ok(BigInt(blob.startTimeUnixNano) < BigInt(rootSpan.endTimeUnixNano), 'the stream is opened inside the operation');
  assert.ok(BigInt(blob.endTimeUnixNano) - BigInt(rootSpan.endTimeUnixNano) >= 30_000_000n, 'and ends with the read, after the root');
  assert.equal(blob.attributes.some(a => a.key === 'ply.isolate.invocation'), false, 'a follower is not an invocation');
  assert.deepEqual(lifetimeViolations(spans()), []);
});

test('span lifetimes: a cancelled blob stream ends its spans with outcome cancelled (before or after the bytes arrive)', async () => {
  const r = seeded();
  for (const [path, how] of [['a/b.txt', 'before-read'], ['big.bin', 'mid-read']]) {
    const { tracer, spans } = traced();
    const res = await readFile(r.url, { path }, { tracer });
    if (how === 'before-read') { await new Promise(ok => setTimeout(ok, 50)); await res.stream.cancel('done'); }
    else { const rd = res.stream.getReader(); await rd.read(); await rd.cancel('done'); }
    const blob = spans().find(s => s.name === 'git.read.blob');
    assert.ok(blob, `${how}: the blob span ended`);
    const attrs = Object.fromEntries(blob.attributes.map(a => [a.key, a.value]));
    assert.deepEqual([attrs['git.read.blob.outcome'], blob.status.code], [{ stringValue: 'cancelled' }, 1], how);
    await new Promise(ok => setTimeout(ok, 20)); // the aborted pump settles; it must not re-end or re-export anything
    assert.equal(spans().filter(s => s.name === 'git.read.blob').length, 1);
    assert.deepEqual(lifetimeViolations(spans()), [], how);
  }
});

test('span contract: the differ names removed, renamed and added keys and spans', () => {
  const base = { op: [{ name: 'git.x', kind: 'INTERNAL', attrs: { 'git.x.a': 'number', 'git.x.outcome': 'string' }, children: [{ name: 'git.x.y', kind: 'INTERNAL', attrs: {} }] }] };
  const renamed = structuredClone(base); delete renamed.op[0].attrs['git.x.a']; renamed.op[0].attrs['git.x.b'] = 'number';
  assert.deepEqual(contractDiff(base, renamed), ['op:', '  - git.x · git.x.a: number', '  + git.x · git.x.b: number']);
  const retyped = structuredClone(base); retyped.op[0].attrs['git.x.a'] = 'string';
  assert.deepEqual(contractDiff(base, retyped), ['op:', '  - git.x · git.x.a: number', '  + git.x · git.x.a: string']);
  const dropped = structuredClone(base); delete dropped.op[0].children;
  assert.deepEqual(contractDiff(base, dropped), ['op:', '  - git.x > git.x.y [INTERNAL]']);
  assert.deepEqual(contractDiff(base, structuredClone(base)), []);
});
