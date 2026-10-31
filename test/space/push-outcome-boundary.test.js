// Inside-cell boundaries. For every cell with a definite expected outcome (landed, rejected, partial: the cells whose
// bytes git writes, and so the bytes a fault can corrupt), take its canonical response bytes and enumerate, exhaustively,
// every single-bit flip, every single-byte deletion, every single-byte insertion from ALPHABET at every position, and
// every truncation. Each mutant goes through the real push path. It must answer the cell's own outcome or 'ambiguous',
// never a different definite outcome; a rejection may only soften (cas_conflict → push_rejected: 'fresh' → 'no'), never
// harden. Enumeration, not sampling: no randomness. PUSH_SPACE_WORKERS sets the worker count.
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import * as space from './push-outcome.space.js';
import { runPush, sameOutcome } from './harness.js';

// structural bytes: NUL, the band-1/band-2 designators, LF, space, a pkt-length digit, a status letter, a non-text byte
export const ALPHABET = [0x00, 0x01, 0x02, 0x0a, 0x20, 0x30, 0x6f, 0xff];

// The distinct (request, response bytes) pairs of the definite cells, in product order.
export function bases() {
  const seen = new Map();
  space.walk(c => {
    const want = space.expected(c);
    if (!space.isDefinite(want)) return;
    const r = space.render(c);
    const key = `${JSON.stringify([r.commands, r.opts, r.limits])}|${Buffer.from(r.response.bytes).toString('hex')}`;
    if (!seen.has(key)) seen.set(key, { r, want, id: space.cellId(c) });
  });
  return [...seen.values()];
}

export function* mutants(b) {
  const n = b.length;
  for (let i = 0; i < n; i++) for (let bit = 0; bit < 8; bit++) { const m = b.slice(); m[i] ^= 1 << bit; yield ['flip', m]; }
  for (let i = 0; i < n; i++) yield ['delete', new Uint8Array([...b.subarray(0, i), ...b.subarray(i + 1)])];
  for (let i = 0; i <= n; i++) for (const a of ALPHABET) yield ['insert', new Uint8Array([...b.subarray(0, i), a, ...b.subarray(i)])];
  for (let i = 0; i < n; i++) yield ['truncate', b.slice(0, i)];
}

async function shard(k, w) {
  Error.stackTraceLimit = 0; // speed: the stacks of the millions of expected errors are never read
  const all = bases();
  const out = { bases: all.length, cases: 0, kinds: {}, same: 0, ambiguous: 0, softened: 0, violations: 0, byWant: {}, bad: [] };
  for (let j = k; j < all.length; j += w) {
    const { r, want, id } = all[j];
    for (const [kind, bytes] of mutants(r.response.bytes)) {
      out.cases++; out.kinds[kind] = (out.kinds[kind] ?? 0) + 1;
      const got = await runPush(r, { bytes, end: 'eof' });
      if (sameOutcome(want, got)) out.same++;
      else if (got.tag === 'ambiguous') out.ambiguous++;
      else if (want.tag === 'rejected' && want.code === 'cas_conflict' && got.tag === 'rejected' && got.code === 'push_rejected') out.softened++;
      else {
        out.violations++;
        const g = `${want.tag}${want.code ? `(${want.code})` : ''} -> ${got.tag}${got.code ? `(${got.code})` : ''} by ${kind}`;
        out.byWant[g] = (out.byWant[g] ?? 0) + 1;
        if (out.bad.length < 5) out.bad.push(`${id} ${kind}: want ${JSON.stringify(want)} got ${JSON.stringify(got)} bytes ${JSON.stringify(Buffer.from(bytes).toString('latin1'))}`);
      }
    }
  }
  return out;
}

if (!isMainThread) {
  shard(workerData.k, workerData.w).then(r => parentPort.postMessage(r));
} else {
  const { test } = await import('vitest');
  const assert = (await import('node:assert/strict')).default;
  test('push outcome boundaries: every single-byte mutant of every definite cell is its own outcome or ambiguous', { timeout: 1_800_000 }, async () => {
    const w = +(process.env.PUSH_SPACE_WORKERS ?? Math.min(4, availableParallelism()));
    const t0 = performance.now();
    const shards = await Promise.all(Array.from({ length: w }, (_, k) => new Promise((resolve, reject) => {
      const wk = new Worker(new URL(import.meta.url), { workerData: { k, w } });
      wk.once('message', resolve); wk.once('error', reject);
    })));
    const ms = performance.now() - t0;
    const sum = { cases: 0, kinds: {}, same: 0, ambiguous: 0, softened: 0, violations: 0, byWant: {}, bad: [] };
    for (const s of shards) {
      for (const k of ['cases', 'same', 'ambiguous', 'softened', 'violations']) sum[k] += s[k];
      for (const [k, v] of Object.entries(s.byWant)) sum.byWant[k] = (sum.byWant[k] ?? 0) + v;
      for (const [k, v] of Object.entries(s.kinds)) sum.kinds[k] = (sum.kinds[k] ?? 0) + v;
      sum.bad.push(...s.bad);
    }
    console.log(`  push-outcome boundaries: ${shards[0].bases} distinct definite cells (request, bytes); ${sum.cases} mutants ${JSON.stringify(sum.kinds)} in ${(ms / 1000).toFixed(1)} s on ${w} workers; own outcome ${sum.same}, ambiguous ${sum.ambiguous}, cas_conflict softened to push_rejected ${sum.softened}, violations ${sum.violations}`);
    for (const [g, n] of Object.entries(sum.byWant).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(8)}  ${g}`);
    for (const b of sum.bad.slice(0, 10)) console.log(`    e.g. ${b}`);
    assert.equal(sum.violations, 0);
  });
}
