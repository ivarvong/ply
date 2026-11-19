// bench/compare (#323) as a correctness check, not a timing gate: the smallest matrix, one repetition, ply from src/.
// Nothing here asserts a duration, a memory figure or who wins; what is asserted is that every sample was verified,
// that the results have the documented shape, and that a bad sample is reported as a failure instead of being dropped.
import { test, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, tmpRoot } from './server.js';
import { buildFixture, runBenchmark, verifySample } from '../bench/compare/run.mjs';
import { CLIENT_IDS, MATRICES, SCHEMA, compare, quantile, renderMarkdown, stats, summarize, validateResults } from '../bench/compare/lib.mjs';

test('quantiles are the documented estimator: 1..10 has median 5.5, q1 3.25, q3 7.75', () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  expect(quantile(v, 0.5)).toBe(5.5);
  expect(stats([10, 1, 9, 2, 8, 3, 7, 4, 6, 5])).toEqual({ n: 10, median: 5.5, min: 1, max: 10, q1: 3.25, q3: 7.75 });
  expect(stats([null, undefined, NaN])).toBe(null);
});

test('a failed sample is counted and never enters a statistic; a loss is reported as ply-higher', () => {
  const s = (client, status, elapsedMs) => ({ cell: 'c', task: 'read', mode: 'fresh', client, rep: 0, status, reason: status === 'ok' ? undefined : 'boom', metrics: { elapsedMs, requests: 3 } });
  const summary = summarize([s('ply', 'ok', 30), s('ply', 'failed', 1), s('git-full', 'ok', 10), s('git-full', 'ok', 20)]);
  const ply = summary.find(r => r.client === 'ply');
  expect([ply.attempted, ply.accepted, ply.failed, ply.reasons]).toEqual([2, 1, 1, ['boom']]);
  expect(ply.metrics.elapsedMs).toMatchObject({ n: 1, median: 30 });
  const c = compare(summary).find(x => x.metric === 'elapsedMs');
  expect(c).toMatchObject({ against: 'git-full', ply: 30, other: 15, ratio: 2, verdict: 'ply-higher', separated: true });
});

test('a fixture is a function of the seed, and verification refuses wrong bytes and a wrong parent', () => {
  const { root, cleanup } = tmpRoot();
  try {
    const [cell] = MATRICES.smoke;
    for (const d of ['a', 'b', 'c']) mkdirSync(join(root, d));
    const a = buildFixture(join(root, 'a'), cell, 7), b = buildFixture(join(root, 'b'), cell, 7), c = buildFixture(join(root, 'c'), cell, 8);
    expect(a.head).toBe(b.head);
    expect(a.headSha256).toBe(b.headSha256);
    expect(c.head).not.toBe(a.head);
    // a read whose bytes are not the file: refused
    const wrong = join(root, 'wrong.bin');
    writeFileSync(wrong, 'not the file');
    const read = verifySample({ task: 'read', repoDir: a.dir, fixture: a, contentFile: wrong });
    expect(read.ok).toBe(false);
    expect(read.checks.filter(k => !k.ok).map(k => k.name)).toEqual(['content: the bytes the client produced are the file at the ref (sha256)']);
    // an "edit" that pushed nothing: parentage, content and scope all fail; fsck still passes
    const none = verifySample({ task: 'edit', repoDir: a.dir, fixture: a, contentFile: wrong });
    expect(none.ok).toBe(false);
    expect(none.checks.find(k => k.name.startsWith('parentage')).ok).toBe(false);
    expect(none.checks.find(k => k.name.startsWith('fsck')).ok).toBe(true);
    // a commit with the right content on the wrong parent (an empty commit in between): refused on parentage
    git(b.dir, ['update-ref', 'refs/heads/main', git(b.dir, ['commit-tree', '-m', 'between', '-p', b.head, `${b.head}^{tree}`], { env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' } }).trim()]);
    expect(verifySample({ task: 'read', repoDir: b.dir, fixture: b, contentFile: wrong }).checks.find(k => k.name.startsWith('parentage')).ok).toBe(false);
  } finally { cleanup(); }
});

// Fresh mode runs every client; reused mode runs ply and one git strategy of each shape (a working tree, a partial
// clone), since the other two differ from those only in their clone flags, which fresh mode already ran.
const REUSED = ['ply', 'git-shallow', 'git-shallow-partial'];
const SMOKE_SAMPLES = (CLIENT_IDS.length + REUSED.length) * 2;
test('smoke run: every client, both tasks, fresh and reused, one repetition; all verified; JSON as documented', async () => {
  const r = await runBenchmark({ matrix: 'smoke', reps: 1, ply: 'src', machine: 'test', only: (_cell, _task, mode, client) => mode === 'fresh' || REUSED.includes(client) });
  const failed = r.samples.filter(s => s.status !== 'ok').map(s => `${s.client} ${s.task}/${s.mode}: ${s.reason}`);
  expect(failed).toEqual([]);
  expect(r.schema).toBe(SCHEMA);
  expect(validateResults(JSON.parse(JSON.stringify(r)))).toEqual([]);
  expect(r.totals).toEqual({ samples: SMOKE_SAMPLES, accepted: SMOKE_SAMPLES, failed: 0, unsupported: 0 });
  // each (task, mode, client) ran, and each accepted sample carries its passed checks, fsck among them
  expect(r.summary.length).toBe(SMOKE_SAMPLES);
  for (const s of r.samples) {
    expect(s.verification.checks.every(c => c.ok)).toBe(true);
    expect(s.verification.checks.some(c => c.name.startsWith('fsck'))).toBe(true);
    expect(s.verification.checks.some(c => c.name.startsWith('parentage'))).toBe(true);
    expect(s.verification.checks.some(c => c.name.startsWith('content'))).toBe(true);
    expect(s.metrics.requests).toBeGreaterThan(0);
    expect(s.metrics.requestBytes).toBeGreaterThan(0);
    expect(s.metrics.fetchPackBytes).toBeGreaterThan(0);
    if (s.task === 'edit') expect(s.metrics.pushPackBytes).toBeGreaterThan(0); else expect(s.metrics.pushPackBytes).toBe(null);
    // memory is a measurement or an explicit "unavailable", never a guessed number
    if (s.memory.available) expect(s.metrics.peakPssBytes).toBeGreaterThan(0); else { expect(typeof s.memory.unavailable).toBe('string'); expect(s.metrics.peakPssBytes).toBe(null); }
  }
  // same parent, tree, author, committer, date and message: ply and every git strategy wrote the same commit
  expect(r.cells[0].commitAgreement).toMatchObject({ agreed: true, samples: SMOKE_SAMPLES / 2 });
  expect(r.source.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(r.config).toMatchObject({ seed: 323, repetitions: 1, matrix: 'smoke' });
  const md = renderMarkdown(r);
  for (const text of ['does not establish Cloudflare Workers memory', 'do not predict WAN latency', '## Where ply loses', '## Failures', '## Unsupported cells', 'n = 1 per cell']) expect(md).toContain(text);
  // the validator is not vacuous: an accepted sample with a failed check, or a missing caveat, is refused
  const bad = JSON.parse(JSON.stringify(r));
  bad.samples[0].verification.checks[0].ok = false;
  bad.caveats = bad.caveats.filter(c => !/WAN/.test(c));
  expect(validateResults(bad).length).toBe(2);
});

test('a server without uploadpack.allowFilter: the partial strategies are reported unsupported, not run unfiltered', async () => {
  const r = await runBenchmark({ matrix: 'smoke', reps: 1, ply: 'src', server: 'stock', clients: ['ply', 'git-partial', 'git-shallow-partial'], tasks: ['read'], modes: ['fresh'], memory: false });
  expect(r.server.filter).toBe(false);
  expect(Object.fromEntries(r.samples.map(s => [s.client, s.status]))).toEqual({ ply: 'ok', 'git-partial': 'unsupported', 'git-shallow-partial': 'unsupported' });
  expect(validateResults(JSON.parse(JSON.stringify(r)))).toEqual([]);
  expect(renderMarkdown(r)).toContain('does not advertise `filter`');
  // sampling off is stated, and no memory number appears
  for (const s of r.samples.filter(x => x.status === 'ok')) expect([s.memory.available, s.metrics.peakPssBytes, s.memory.unavailable]).toEqual([false, null, 'disabled (--no-memory)']);
});
