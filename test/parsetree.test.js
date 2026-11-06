// parseTree answers exactly what it answered before #207 (test/oracle/parsetree-ref.ts, the c91c9cf parser): the same
// entries (mode, name, oid, offsets) or the same refusal (code and message), on random trees built to reach every
// refusal: bad and canonicalized modes, missing separators, short ids, null ids, every .git/.gitmodules spelling,
// duplicates, order with directory keys, and the entry cap. The large run is test/fuzz/parsetree.mjs.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { rng } from './dotnames-corpus.js';
import { randomTree, judgeTrees } from './parsetree-corpus.js';

test('random trees: the same entries or the same refusal as before (seeded)', () => {
  const r = rng(Number(process.env.PARSETREE_SEED ?? 207));
  const n = process.env.MUTATION === '1' ? 4_000 : 40_000;
  const stats = { n: 0, accepted: 0, refused: {} };
  const bad = judgeTrees((function* () { for (let i = 0; i < n; i++) yield randomTree(r); })(), stats);
  assert.equal(bad, null, JSON.stringify(bad));
  // not vacuous: trees are accepted, and every refusal parseTree has is reached
  assert.ok(stats.accepted > n / 20, `${stats.accepted} accepted`);
  for (const why of ['tree: malformed entry', 'tree: empty mode', 'tree: malformed mode', 'tree: empty name', 'tree: zero-padded mode', 'tree: full pathname', 'tree: bad name', 'tree: large pathname', 'tree: null shaN', 'tree: .gitmodules is a symbolic link', 'tree: .gitmodules is not a blob', 'tree: .gitattributes is not a blob', 'tree: duplicate entry "…"', 'tree: not strictly sorted']) {
    assert.ok(stats.refused[why] > 0, `${why} never reached: ${JSON.stringify(stats.refused)}`);
  }
  assert.ok(Object.keys(stats.refused).some(k => k.startsWith('short read')), 'short read never reached');
  assert.ok(Object.keys(stats.refused).some(k => k.startsWith('tree entries')), 'entry cap never reached');
});
