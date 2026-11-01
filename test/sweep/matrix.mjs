// The product: one cell per (parameter value × operation) the harness can build a fixture for.
// Heaps are not an axis here. The driver runs every selected cell twice (default heap, then 128 MiB).
// `bytes` and `entries` are the fixture sizes the CI filter reads. A cell over 16 MiB or 65_536 entries,
// or one marked nightly, waits for `npm run sweep -- --full`.
import { DEFAULT_LIMITS } from '../../src/limits.js';
import { boundaryValues } from './boundary.mjs';

const MiB = 1024 * 1024;
export const CI_BYTES = 16 * MiB;
export const CI_ENTRIES = 65536;

// ply-web's pack budget, swept as an override so the wire edge is a cell and not a guess.
export const PLY_WEB_PACK = Object.freeze({
  maxPackBytes: 32 * MiB,
  maxObjectSize: 16 * MiB,
  maxInflatedTotal: 64 * MiB,
  maxHarvestBytes: 8 * MiB,
  maxDeltaResult: 16 * MiB,
});

const ok = Object.freeze({ status: 'ok' });
const refused = (code, extra = {}) => Object.freeze({ status: 'refused', code, ...extra });

/**
 * @typedef {object} Cell
 * @property {string} id
 * @property {string} param  Limits key this cell probes
 * @property {string} op
 * @property {number} [bytes]
 * @property {number} [entries]
 * @property {boolean} [nightly]  excluded from --ci even when bytes and entries are small
 * @property {boolean} [writes]
 * @property {string} [repo]
 * @property {string} [path]
 * @property {string} [ref]
 * @property {string} [from]
 * @property {number} [limit]
 * @property {string} [find]
 * @property {string} [replace]
 * @property {number} [nfiles]
 * @property {number} [size]
 * @property {string} [pack]  pack id under the fixture packs/ dir; the driver fills the path
 * @property {Record<string, number>} [limits]
 * @property {{ status: string, code?: string, got?: number, max?: number, what?: string }} [expect]
 * @property {string} [expectFrom]  driver fills `expect` (and sometimes `limits`) from the git oracle
 * @property {number} [history]  commits in the log fixture, for the readLog oracle
 */

/** @param {number} limit @param {(n: number) => boolean} [keep] */
function around(limit, keep = () => true) {
  return boundaryValues(limit).filter(n => n > 0 && keep(n));
}

/** @type {Cell[]} */
function build() {
  /** @type {Cell[]} */
  const cells = [];
  const add = (/** @type {Cell} */ cell) => cells.push(cell);

  // ---- maxPackBytes: incompressible blob. The wire cap is the one readFile enforces; maxObjectSize does not.
  // Expectation comes from the pack git actually writes for that blob (fixtures record its size): band 1 is that
  // pack, so a blob a few KiB under the cap can still refuse. Guessing from the blob length misses the framing.
  const packCap = DEFAULT_LIMITS.maxPackBytes;
  for (const S of boundaryValues(packCap)) {
    add({
      id: `pack.readFile.${S}`, param: 'maxPackBytes', op: 'readFile', repo: `blob-${S}`, path: 'big.bin',
      bytes: S, entries: 2, expectFrom: 'wire',
    });
  }
  // The check itself, at a 1 MiB cap, so CI crosses the cap without a 128 MiB blob.
  const smallCap = MiB;
  for (const S of [0, 1, smallCap - 8192, smallCap - 1, smallCap, smallCap + 1]) {
    add({
      id: `pack.readFile.cap1MiB.${S}`, param: 'maxPackBytes', op: 'readFile', repo: `blob-${S}`, path: 'big.bin',
      bytes: S, entries: 2, limits: { maxPackBytes: smallCap }, expectFrom: 'wire',
    });
  }
  for (const S of [1, MiB, 16 * MiB]) {
    add({ id: `pack.listTree.sibling.${S}`, param: 'maxPackBytes', op: 'listTree', repo: `blob-${S}`, path: '', bytes: S, entries: 2, expect: ok });
    add({ id: `pack.readFile.sibling.${S}`, param: 'maxPackBytes', op: 'readFile', repo: `blob-${S}`, path: 'small.txt', bytes: S, entries: 2, expect: ok });
  }
  // ply-web's 32 MiB wire. The edges are the largest incompressible blobs that still fit (report: −16 KiB … −4 KiB).
  for (const S of [32 * MiB - 16384, 32 * MiB - 8192, 32 * MiB - 8191, 32 * MiB - 4096, 32 * MiB, 32 * MiB + 1]) {
    add({
      id: `pack.readFile.plyweb.${S}`, param: 'maxPackBytes', op: 'readFile', repo: `blob-${S}`, path: 'big.bin',
      bytes: S, entries: 2, limits: { ...PLY_WEB_PACK }, nightly: S > CI_BYTES, expectFrom: 'wire',
    });
  }

  // ---- maxTreeEntries ----
  for (const E of boundaryValues(DEFAULT_LIMITS.maxTreeEntries)) {
    add({
      id: `tree.listTree.${E}`, param: 'maxTreeEntries', op: 'listTree', repo: `tree-${E}`, path: '',
      bytes: E, entries: E, expect: E > DEFAULT_LIMITS.maxTreeEntries ? refused('limit_exceeded', { what: 'tree entries' }) : ok,
    });
  }
  for (const E of [1, 65536, 200000, 200001]) {
    if (E === 0) continue;
    const name = `e${String(E - 1).padStart(7, '0')}`;
    add({
      id: `tree.readFile.${E}`, param: 'maxTreeEntries', op: 'readFile', repo: `tree-${E}`, path: name,
      bytes: 1, entries: E, expect: E > DEFAULT_LIMITS.maxTreeEntries ? refused('limit_exceeded', { what: 'tree entries' }) : ok,
    });
  }

  // ---- maxPathDepth, maxPathComponent ----
  for (const D of around(DEFAULT_LIMITS.maxPathDepth)) {
    const path = D === 1 ? 'f.txt' : `${Array(D - 1).fill('d').join('/')}/f.txt`;
    add({
      id: `depth.path.${D}`, param: 'maxPathDepth', op: 'readFile', repo: `depth-${D}`, path,
      bytes: 5, entries: D, expect: D > DEFAULT_LIMITS.maxPathDepth ? refused('bad_request', { what: 'path' }) : ok,
    });
  }
  for (const L of around(DEFAULT_LIMITS.maxPathComponent)) {
    add({
      id: `depth.component.${L}`, param: 'maxPathComponent', op: 'readFile', repo: `comp-${L}`, path: 'a'.repeat(L),
      bytes: 1, entries: 1, expect: L > DEFAULT_LIMITS.maxPathComponent ? refused('bad_request', { what: 'path' }) : ok,
    });
  }

  // ---- maxMergeDepth: readLog's limit is bad_request past the cap; the search is limit_exceeded (merge-base). ----
  const depthCap = DEFAULT_LIMITS.maxMergeDepth;
  const logLimits = boundaryValues(depthCap).filter(L => L === 0 || L === 1 || L >= 512 || L === depthCap - 1 || L === depthCap || L === depthCap + 1 || L === depthCap * 2);
  const logHistories = [1, depthCap, depthCap * 2];
  for (const N of logHistories) {
    for (const L of logLimits) {
      if (N === 1 && L > 2 && L < depthCap) continue;
      if (N === depthCap && L > 2 && L < depthCap - 1 && L !== 512) continue;
      add({
        id: `depth.readLog.n${N}.l${L}`, param: 'maxMergeDepth', op: 'readLog', repo: `log-${N}`, limit: L, history: N,
        bytes: N * 8, entries: N,
        expect: L < 1 || L > depthCap ? refused('bad_request', { what: 'limit' }) : ok,
      });
    }
  }
  // Distance K commits past the common base on each side. Desired: past the cap, the error's `got` is the next
  // doubling step (cap * 2), not the cap itself. main reports the cap for both (ratchet).
  for (const K of around(depthCap)) {
    if (K > 2 && K < 512) continue;
    add({
      id: `depth.mergebase.k${K}`, param: 'maxMergeDepth', op: 'merge', repo: `mb-${K}`, from: 'refs/heads/feat', writes: true,
      bytes: K * 16, entries: K * 2 + 1,
      expect: K > depthCap ? refused('limit_exceeded', { what: 'merge-base search depth', got: depthCap * 2, max: depthCap }) : ok,
    });
  }

  // ---- maxRefs. Desired: HEAD does not count, so N == maxRefs is accepted. main counts HEAD (ratchet). ----
  for (const N of around(DEFAULT_LIMITS.maxRefs)) {
    add({
      id: `refs.lsRefs.${N}`, param: 'maxRefs', op: 'lsRefs', repo: `refs-${N}`,
      bytes: N * 40, entries: N,
      expect: N > DEFAULT_LIMITS.maxRefs ? refused('limit_exceeded', { what: 'ls-refs lines' }) : ok,
    });
  }
  for (const N of [1, DEFAULT_LIMITS.maxRefs]) {
    add({
      id: `refs.readFile.${N}`, param: 'maxRefs', op: 'readFile', repo: `refs-${N}`, path: 'f.txt', ref: 'main',
      bytes: 2, entries: N, expect: ok,
    });
  }
  // The byte cap, overridden: the default is the pack wire cap and a small listing never reaches it.
  for (const max of [0, 1]) {
    add({
      id: `refs.bytes.${max}`, param: 'maxLsRefsBytes', op: 'lsRefs', repo: 'refs-1',
      bytes: 200, entries: 1, limits: { maxLsRefsBytes: max },
      expect: refused('limit_exceeded', { what: 'ls-refs bytes' }),
    });
  }
  add({
    id: 'refs.bytes.room', param: 'maxLsRefsBytes', op: 'lsRefs', repo: 'refs-1',
    bytes: 200, entries: 1, limits: { maxLsRefsBytes: MiB }, expect: ok,
  });

  // ---- maxMergeBlobBytes. Exactly the cap is allowed (`>`), one byte over is a merge_conflict. ----
  const blobCap = DEFAULT_LIMITS.maxMergeBlobBytes;
  const mergeSizes = boundaryValues(blobCap).filter(S => S >= 1024 || S === blobCap - 1 || S === blobCap || S === blobCap + 1 || S === blobCap * 2);
  for (const S of mergeSizes) {
    add({
      id: `merge.blob.${S}`, param: 'maxMergeBlobBytes', op: 'merge', repo: `mblob-${S}`, from: 'refs/heads/feat', writes: true,
      bytes: S, entries: 1,
      expect: S > blobCap ? refused('merge_conflict') : ok,
    });
  }

  // ---- maxObjectSize via pushTree. Exactly the cap is allowed. ----
  const objCap = DEFAULT_LIMITS.maxObjectSize;
  for (const S of [0, 1, 1023, 1024, 1025]) {
    add({
      id: `push.object.cap1KiB.${S}`, param: 'maxObjectSize', op: 'pushTree', repo: 'push-empty', writes: true,
      nfiles: 1, size: S, bytes: S, entries: 1, limits: { maxObjectSize: 1024 },
      expect: S > 1024 ? refused('limit_exceeded', { what: 'object size' }) : ok,
    });
  }
  for (const S of [MiB, 16 * MiB, objCap, objCap + 1]) {
    add({
      id: `push.object.${S}`, param: 'maxObjectSize', op: 'pushTree', repo: 'push-empty', writes: true,
      nfiles: 1, size: S, bytes: S, entries: 1,
      expect: S > objCap ? refused('limit_exceeded', { what: 'object size' }) : ok,
    });
  }
  // No total-bytes cap today. Desired: the sum of the file bytes is bounded by the pack wire cap (128 MiB),
  // refused in validateTreeSpec before the blobs are copied into the pack. 3 × 48 MiB is 144 MiB (ratchet).
  const pushCap = DEFAULT_LIMITS.maxPackBytes;
  for (const [n, s] of [[1, MiB], [1, 16 * MiB], [10000, 64], [3, 48 * MiB], [100000, 8]]) {
    const total = n * s;
    add({
      id: `push.total.${n}x${s}`, param: 'maxPackBytes', op: 'pushTree', repo: 'push-empty', writes: true,
      nfiles: n, size: s, bytes: total, entries: n,
      expect: total > pushCap ? refused('limit_exceeded', { what: 'push bytes' }) : (s > objCap ? refused('limit_exceeded', { what: 'object size' }) : ok),
    });
  }

  // ---- editFile, through and past an object. The edit streams; these cells record the RSS, they do not invent a cap. ----
  for (const S of [MiB, 16 * MiB, objCap - 128, objCap + 128]) {
    add({
      id: `edit.file.${S}`, param: 'maxObjectSize', op: 'editFile', repo: `edit-${S}`, path: 'e.txt', writes: true,
      find: 'NEEDLE', replace: 'NEEDLX', bytes: S, entries: 1, expect: ok,
    });
  }

  // ---- maxDeltaChain. Short chains in CI; the depth-299 pack (the L ≥ 262 override) is nightly.
  // pack-objects --depth=65 on this 80-version file chains to about 61, still under the cap. Depth 80 is the
  // first request whose verify-pack chain passes 64, so CI actually crosses the limit. Expectation uses that
  // measured chain, not the requested depth.
  for (const D of [0, 1, 63, 64, 65, 80]) {
    for (const kind of ['ofs', 'ref']) {
      add({
        id: `delta.${kind}.d${D}`, param: 'maxDeltaChain', op: 'pack', pack: `d${D}-${kind}`,
        bytes: 80 * 2048, entries: 80, expectFrom: 'chain',
      });
    }
  }
  for (const D of [128, 256, 299]) {
    for (const kind of ['ofs', 'ref']) {
      add({
        id: `delta.${kind}.d${D}`, param: 'maxDeltaChain', op: 'pack', pack: `long-d${D}-${kind}`,
        bytes: 32 * MiB, entries: 300, nightly: true, expectFrom: 'chain',
      });
    }
  }
  // The chain git actually produced, against an overridden cap. expectFrom 'chain-limit' compares that chain to `limit`.
  add({
    id: 'delta.limit.64.d80-ofs', param: 'maxDeltaChain', op: 'pack', pack: 'd80-ofs',
    bytes: 80 * 2048, entries: 80, limits: { maxDeltaChain: 64 }, expectFrom: 'chain-limit',
  });
  add({
    id: 'delta.limit.80.d80-ofs', param: 'maxDeltaChain', op: 'pack', pack: 'd80-ofs',
    bytes: 80 * 2048, entries: 80, limits: { maxDeltaChain: 80 }, expectFrom: 'chain-limit',
  });
  add({
    id: 'delta.limit.long.d299-ofs', param: 'maxDeltaChain', op: 'pack', pack: 'long-d299-ofs',
    bytes: 32 * MiB, entries: 300, nightly: true, limits: { maxDeltaChain: 262 }, expectFrom: 'chain-limit',
  });

  // ---- maxInflatedTotal, on a tiny pack, at the sum, one under, and zero. The driver fills the sum. ----
  add({ id: 'inflate.at', param: 'maxInflatedTotal', op: 'pack', pack: 'inflate', bytes: 8192, entries: 8, expectFrom: 'inflated-at' });
  add({ id: 'inflate.under', param: 'maxInflatedTotal', op: 'pack', pack: 'inflate', bytes: 8192, entries: 8, expectFrom: 'inflated-under' });
  add({ id: 'inflate.zero', param: 'maxInflatedTotal', op: 'pack', pack: 'inflate', bytes: 8192, entries: 8, limits: { maxInflatedTotal: 0 }, expect: refused('limit_exceeded', { what: 'pack inflated bytes' }) });

  return cells;
}

const CELLS = build();

export function allCells() {
  return CELLS;
}

/** @param {Cell} cell */
export function isCi(cell) {
  if (cell.nightly) return false;
  return (cell.bytes ?? 0) <= CI_BYTES && (cell.entries ?? 0) <= CI_ENTRIES;
}

/**
 * @param {{ ci?: boolean, full?: boolean, filter?: string | null }} opts
 * @returns {Cell[]}
 */
export function selectCells({ ci = false, full = false, filter = null } = {}) {
  return CELLS.filter(cell => {
    if (filter && !cell.id.includes(filter)) return false;
    if (ci && !isCi(cell)) return false;
    if (!ci && !full && !isCi(cell)) return false;
    return true;
  });
}
