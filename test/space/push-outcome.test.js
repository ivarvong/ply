// The push-outcome enumerator. Every cell of the space (push-outcome.space.js) is rendered, run through the real push
// path (`push()` over a fake transport, no network) and compared with the table's expected outcome. No randomness: the
// cells are the product of the axes, split across worker threads by index. Fails on any cell without an expected value
// or whose outcome differs; prints cells explored / total. PUSH_SPACE_WORKERS sets the worker count.
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import * as space from './push-outcome.space.js';
import { runPush, sameOutcome, label } from './harness.js';

// The first factor (in this order) that makes a cell differ from a clean single-fault-free report: names a disagreement.
export const cause = c => {
  if (c.event.tag !== 'clean' && c.event.tag !== 'progress' && c.event.tag !== 'keepalive') return `event:${c.event.tag}`;
  if (c.delivery.tag !== 'complete' && c.delivery.tag !== 'band1Split') return `delivery:${c.delivery.tag}`;
  if (c.unpack.tag !== 'ok') return `unpack:${c.unpack.tag}`;
  const tags = [...new Set(space.statuses(c).map(s => s.tag))].sort();
  if (c.format.tag.endsWith('Options')) return `format:${c.format.tag}+${tags.join('+')}`;
  return `statuses:${tags.join('+')}${c.atomic.tag === 'on' ? '/atomic' : ''}${c.commands.tag === 'deleteOnly' ? '/deleteOnly' : ''}`;
};

async function runShard(k, w) {
  const out = { explored: 0, missing: 0, outcomes: {}, wrong: {}, samples: {} };
  const todo = [];
  const quick = process.env.PUSH_SPACE === 'quick';
  Error.stackTraceLimit = 0; // speed: the stacks of the millions of expected errors are never read
  out.census = space.walk(c => { if (quick && space.deviations(c) > space.QUICK_DEVIATIONS) return; if ((out.explored++ % w) === k) todo.push(c); });
  out.total = out.explored;
  out.explored = 0;
  for (const c of todo) {
    let want;
    try { want = space.expected(c); } catch (e) { out.missing++; (out.samples.missing ??= []).push(`${space.cellId(c)}: ${e.message}`); continue; }
    if (!want || !want.tag) { out.missing++; continue; }
    const got = await runPush(space.render(c));
    out.explored++;
    out.outcomes[label(want)] = (out.outcomes[label(want)] ?? 0) + 1;
    if (!sameOutcome(want, got)) {
      const g = `${label(want)} -> ${label(got)} | ${cause(c)}`;
      out.wrong[g] = (out.wrong[g] ?? 0) + 1;
      const s = (out.samples[g] ??= []);
      if (s.length < 2) s.push(`${space.cellId(c)} :: got ${JSON.stringify(got)}`);
    }
  }
  return out;
}

if (!isMainThread) {
  runShard(workerData.k, workerData.w).then(r => parentPort.postMessage(r));
} else {
  const { test } = await import('node:test');
  const assert = (await import('node:assert/strict')).default;

  test('every tag of every axis has a meaning and a renderer (the match is exhaustive)', () => {
    for (const a of space.AXES) {
      const tags = space.TAGS[a.name];
      assert.deepEqual(Object.keys(space.MEANING[a.name]).sort(), [...tags].sort(), `MEANING.${a.name} covers exactly its tags`);
      assert.equal(typeof space.RENDER[a.name], 'function', `RENDER.${a.name}`);
      for (const v of a.variants) assert.ok(v.why && v.why.length > 8, `${a.name}.${v.tag} cites why`);
    }
    // the odd ref of a mixed report ranges over the same union as `status`
    const odd = [...new Set(space.axis('spread').variants.filter(v => v.tag === 'mixed').map(v => v.odd.tag))].sort();
    assert.deepEqual(odd, [...space.STATUS_TAGS].sort());
  });

  test('src/push.js and the space agree on git\'s unpack failure strings', async () => {
    const { GIT_UNPACK_ERRORS } = await import('../../src/push.js');
    assert.deepEqual([...GIT_UNPACK_ERRORS], space.GIT_UNPACK_ERRORS);
  });

  test('cells observed from git: git\'s bytes are the cell\'s rendering, ply\'s outcome is the table\'s, the server agrees', { timeout: 300_000 }, async () => {
    const { observeAll } = await import('./push-outcome.observed.js');
    const obs = await observeAll();
    const ids = new Set();
    for (const o of obs) {
      ids.add(o.cellId);
      assert.notEqual(o.bytesMatch, false, `${o.name}: git wrote bytes the cell does not render`);
      assert.ok(o.eventMatch, `${o.name}: git's side-band extras ${JSON.stringify(o.sent)} are not event ${o.cell.event.tag}`);
      assert.ok(sameOutcome(o.expected, o.got), `${o.name}: table ${JSON.stringify(o.expected)}, ply ${JSON.stringify(o.got)} (${o.error})`);
      const all = o.cell.refs.n, moved = new Set(o.moved);
      if (o.expected.tag === 'landed') assert.equal(moved.size, all, `${o.name}: landed but moved ${o.moved}`);
      if (o.expected.tag === 'rejected') assert.equal(moved.size, 0, `${o.name}: rejected but moved ${o.moved}`);
      if (o.expected.tag === 'partial') assert.deepEqual([...moved].sort(), [...o.expected.landed].sort(), `${o.name}: partial`);
    }
    const truth = obs.filter(o => o.expected.tag === 'ambiguous').map(o => `${o.name}: moved [${o.moved.join(', ')}]`);
    console.log(`  push-outcome: ${obs.length} git scenarios, ${ids.size} distinct cells observed from git; ambiguous cells' truth: ${truth.join('; ')}`);
  });

  test('push outcome: every cell of the space through push(), against the table', { timeout: 600_000 }, async () => {
    const w = +(process.env.PUSH_SPACE_WORKERS ?? Math.min(4, availableParallelism()));
    const t0 = performance.now();
    const shards = await Promise.all(Array.from({ length: w }, (_, k) => new Promise((resolve, reject) => {
      const wk = new Worker(new URL(import.meta.url), { workerData: { k, w } });
      wk.once('message', resolve); wk.once('error', reject);
    })));
    const ms = performance.now() - t0;
    const census = shards[0].census, total = shards[0].total;
    assert.equal(Object.entries(census).filter(([k]) => k !== 'raw').reduce((n, [, v]) => n + v, 0), census.raw, 'the census accounts for every raw cell');
    const sum = { explored: 0, missing: 0, outcomes: {}, wrong: {}, samples: {} };
    for (const s of shards) {
      sum.explored += s.explored; sum.missing += s.missing;
      for (const [k, v] of Object.entries(s.outcomes)) sum.outcomes[k] = (sum.outcomes[k] ?? 0) + v;
      for (const [k, v] of Object.entries(s.wrong)) sum.wrong[k] = (sum.wrong[k] ?? 0) + v;
      for (const [k, v] of Object.entries(s.samples)) (sum.samples[k] ??= []).push(...v);
    }
    const wrong = Object.values(sum.wrong).reduce((a, b) => a + b, 0);
    console.log(`  push-outcome${process.env.PUSH_SPACE === 'quick' ? ` (quick: ≤ ${space.QUICK_DEVIATIONS} deviations, ${census.cells} cells in the space)` : ''}: cells explored ${sum.explored} / ${total} (raw product ${census.raw}) in ${(ms / 1000).toFixed(1)} s on ${w} workers; expected ${JSON.stringify(sum.outcomes)}; disagree ${wrong}`);
    for (const [g, n] of Object.entries(sum.wrong).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(8)}  ${g}\n              e.g. ${sum.samples[g][0]}`);
    if (process.env.PUSH_SPACE !== 'quick') {
      const doc = await import('../../scripts/space-md.mjs');
      assert.equal(doc.current(), doc.block({ census, outcomes: sum.outcomes }), 'SPACE.md is stale: run node scripts/space-md.mjs --write');
    }
    assert.equal(sum.missing, 0, 'cells without an expected outcome');
    assert.equal(sum.explored, total, 'every cell explored');
    assert.equal(wrong, 0, 'cells whose outcome differs from the table');
  });
}
