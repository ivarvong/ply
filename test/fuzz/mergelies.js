// The merge-base server behaviours (issue #18, #42): a server answering the commit-only `tree:0` + `deepen` walks of
// mergeBase with a cut history. Shared by test/fuzz/liar.mjs (`--op mergebase`, random DAGs) and
// test/mergebase-space.test.js (the enumerated outcome space).
import { buildPack } from '../../src/pack.js';
import { TYPE } from '../../src/objects.js';
import { concat, te } from '../../src/bytes.js';
import { Rng } from './prng.js';
import { reachableCommits } from './dag.js';

export const pktLine = s => { const b = typeof s === 'string' ? te.encode(s) : s; return concat([te.encode((b.length + 4).toString(16).padStart(4, '0')), b]); };
export const FLUSH = te.encode('0000');
// a v2 fetch response carrying exactly these objects (full, no deltas) as a sideband pack
export async function fetchResponse(objs, { shallow = [] } = {}) {
  const { pack } = await buildPack(objs);
  const parts = [];
  if (shallow.length) { parts.push(pktLine('shallow-info\n')); for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`)); parts.push(te.encode('0001')); }
  parts.push(pktLine('packfile\n'));
  for (let i = 0; i < pack.length; i += 65000) parts.push(pktLine(concat([Uint8Array.of(1), pack.subarray(i, Math.min(i + 65000, pack.length))])));
  parts.push(FLUSH);
  return concat(parts);
}

// ---- merge-base lies (issue #18) ----
// The request names one commit want, `filter tree:0` and `deepen N`; the honest answer is every commit within N of the
// want, with the commits at the cut as `shallow` lines (dag.js reachableCommits, calibrated against upload-pack). Each
// lie is a function of the request alone (a sub-Rng seeded from the want and the case, so concurrent fetches of `ours`
// and `theirs` cannot reorder the randomness) and answers without forwarding; `M.lied` counts the answers that were lies.
const fetchRequest = body => { const s = Buffer.from(body).toString('latin1'); return { want: /want ([0-9a-f]{40})\n/.exec(s)?.[1] ?? null, deepen: +(/deepen (\d+)\n/.exec(s)?.[1] ?? 0), filter: /filter ([^\n]+)\n/.exec(s)?.[1] ?? null }; };
const window = (M, want, deepen) => { const { commits, boundary } = reachableCommits(M.model, [want], { depth: deepen }); return { all: [...commits.keys()], boundary: [...boundary] }; };
const drop = (rng, list, k) => { const out = new Set(); const pool = [...list]; while (out.size < Math.min(k, pool.length)) out.add(pool[rng.int(0, pool.length - 1)]); return out; };
export const MERGE_LIES = {
  // control: forwarded untouched → the bases must be git's
  'mb:honest': () => null,
  // the issue: ancestors inside the window are omitted and no shallow line admits it. The pack still hash-verifies.
  'mb:omit-no-shallow': (M, rng, w) => { const gone = drop(rng, w.all.filter(c => c !== w.want), rng.int(1, 3)); return { keep: w.all.filter(c => !gone.has(c)), shallow: [], omitted: gone.size }; },
  // the honest shallow lines are sent, but commits elsewhere in the window are missing too
  'mb:omit-keep-shallow': (M, rng, w) => { const gone = drop(rng, w.all.filter(c => c !== w.want && !w.boundary.includes(c)), rng.int(1, 3)); return { keep: w.all.filter(c => !gone.has(c)), shallow: w.boundary, omitted: gone.size }; },
  // a consistent cut shallower than asked: one commit c declared shallow, everything only reachable through it dropped.
  // Not a contradiction of the protocol — a server may answer with less depth — so the client must deepen or give up typed.
  'mb:cut-shallower': (M, rng, w) => {
    const c = rng.pick(w.all.filter(x => x !== w.want)); if (!c) return null;
    const seen = new Set([w.want]); const st = [w.want];
    while (st.length) { const x = st.pop(); if (x === c) continue; for (const p of M.model.commits.get(x).parents) if (!seen.has(p) && w.all.includes(p)) { seen.add(p); st.push(p); } }
    return { keep: [...seen], shallow: [...new Set([...w.boundary.filter(b => seen.has(b) && b !== c), c])], omitted: w.all.length - seen.size };
  },
  // the want itself is missing from an otherwise honest pack
  'mb:omit-want': (M, rng, w) => ({ keep: w.all.filter(c => c !== w.want), shallow: w.boundary, omitted: 1 }),
  // an unrequested commit (from an unrelated repo) rides along in an otherwise honest pack
  'mb:extra-foreign': (M, rng, w) => ({ keep: w.all, shallow: w.boundary, extra: [M.decoy], omitted: 0 }),
  // a tree object in a tree:0 pack (the want's root tree). Main admits a well-formed, hash-verified tree in a commit-walk
  // pack (the blob:none fallback carries every tree for the same request; fetch.js checkWide, #47) and the walk reads
  // commits only, so this is not a contradiction: the answer must still be git's (or a typed error)
  'mb:tree-in-tree0': (M, rng, w) => ({ keep: w.all, shallow: w.boundary, extra: [{ type: TYPE.TREE, data: M.treeOf(w.want) }], omitted: 0 }),
};
export const mergeLie = (M, kind, seed) => ctx => {
  if (ctx.stage !== 'fetch' || ctx.phase !== 'request') return null;
  const { want, deepen, filter } = fetchRequest(ctx.reqBody);
  if (!want || !deepen || filter !== 'tree:0' || !M.model.commits.has(want)) return null;
  const rng = new Rng((seed ^ parseInt(want.slice(0, 8), 16) ^ (deepen * 2654435761)) >>> 0);
  if (kind !== 'mb:honest' && deepen === 1 && rng.bool(0.5)) return null; // let some of the three-commit fetches through
  const w = { ...window(M, want, deepen), want };
  const plan = MERGE_LIES[kind](M, rng, w);
  if (!plan || (plan.omitted === 0 && !plan.extra)) return null; // nothing to omit in a one-commit window: the honest answer
  M.lied++; M.omitted += plan.omitted;
  const objs = [...plan.keep.map(c => ({ type: TYPE.COMMIT, data: M.commitData.get(c) })), ...(plan.extra ?? [])];
  return { type: 'bytes', noForward: true, name: kind, bytes: fetchResponse(objs, { shallow: plan.shallow }) };
};

