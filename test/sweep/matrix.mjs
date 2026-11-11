// The product: one cell per (parameter value × operation) the harness can build a fixture for.
// Heaps are not an axis here. The driver runs every selected cell twice (default heap, then 128 MiB).
// `bytes` and `entries` are the fixture sizes the CI filter reads. A cell over 16 MiB or 65_536 entries,
// or one marked nightly, waits for `npm run sweep -- --full`.
import { DEFAULT_LIMITS, LIMIT_OBJECT_OVERHEAD, WORKER_LIMITS } from '../../src/limits.js';
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
 * @property {'workerd'} [runtime]  run once inside workerd (test/workerd/worker.mjs) instead of on the two node heaps
 * @property {string} [shim]  shim.mjs mode the request goes through (v0, v1, delay-<ms>, stall-<ms>, frame-<L>)
 * @property {number} [capDelta]  the cap is the oracle's measurement plus this (expectFrom objects, delta-result, harvest)
 * @property {number} [haveCount]  haves for a fetchPack cell: this many ancestors of main
 * @property {number} [wantCount]  wants for a fetchPack cell: main and this many minus one of its ancestors
 * @property {number} [deepen]
 * @property {boolean} [done]
 * @property {string} [filter]
 * @property {string} [local]  pushRepo's source repository (a fixture)
 * @property {Record<string, unknown>} [spec]  pushRepo's spec
 * @property {string} [store]  fetchThin's local object store (a fixture)
 * @property {string} [onto]  rebase target
 * @property {number} [rebased]  commits git must count from main to the rebased branch
 * @property {boolean} [thin]  the push must have sent a delta against the remote's objects
 * @property {number} [timeoutMs]  this cell's own kill timer, in place of SWEEP_TIMEOUT_MS
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
  // maxObjectSize on a fetched tree: the declared size is refused where the pack's object header is read (#156), before
  // a body byte; exactly the cap is allowed. tree-65536's tree is 65,536 entries of 36 bytes (`100644 eNNNNNNN\0` + id).
  const tree65536 = 65536 * 36;
  for (const [name, cap] of [['at', tree65536], ['under', tree65536 - 1]]) {
    add({
      id: `tree.object.listTree.65536.${name}`, param: 'maxObjectSize', op: 'listTree', repo: 'tree-65536', path: '',
      bytes: tree65536, entries: 65536, limits: { maxObjectSize: cap },
      expect: cap < tree65536 ? refused('limit_exceeded', { what: 'pack object size', got: tree65536, max: cap }) : ok,
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
  // The sum of the file bytes plus LIMIT_OBJECT_OVERHEAD per file, refused in fileEntries before the blobs are hashed.
  // 3 × 48 MiB is 144 MiB, past the cap. 100000 × 8 is 800 KB of payload, but 300 MB once each file pays its
  // overhead: refused, where counting payload only ran a 128 MiB heap out of memory (#142).
  const pushCap = DEFAULT_LIMITS.maxPushBytes;
  for (const [n, s] of [[1, MiB], [1, 16 * MiB], [10000, 64], [3, 48 * MiB], [100000, 8]]) {
    const total = n * (s + LIMIT_OBJECT_OVERHEAD);
    add({
      id: `push.total.${n}x${s}`, param: 'maxPushBytes', op: 'pushTree', repo: 'push-empty', writes: true,
      nfiles: n, size: s, bytes: total, entries: n,
      expect: total > pushCap ? refused('limit_exceeded', { what: 'push bytes' }) : (s > objCap ? refused('limit_exceeded', { what: 'object size' }) : ok),
    });
  }

  // ---- WORKER_LIMITS (src/limits.ts), the preset for a 128 MiB isolate. Every cell runs at 128 MiB too: each one
  // refuses or succeeds, none runs out of memory. The wire edge is the plyweb cells above (the same 32 MiB).
  const worker = { ...WORKER_LIMITS };
  const wPush = WORKER_LIMITS.maxPushBytes;
  for (const [n, s] of [[1, 16 * MiB], [10000, 64], [100000, 8]]) {
    const total = n * (s + LIMIT_OBJECT_OVERHEAD);
    add({
      id: `worker.push.total.${n}x${s}`, param: 'maxPushBytes', op: 'pushTree', repo: 'push-empty', writes: true,
      nfiles: n, size: s, bytes: n * s, entries: n, limits: worker,
      expect: total > wPush ? refused('limit_exceeded', { what: 'push bytes' }) : ok,
    });
  }
  add({
    id: 'worker.push.object.16777217', param: 'maxObjectSize', op: 'pushTree', repo: 'push-empty', writes: true,
    nfiles: 1, size: 16 * MiB + 1, bytes: 16 * MiB + 1, entries: 1, nightly: true, limits: worker,
    expect: refused('limit_exceeded', { what: 'object size' }),
  });
  for (const E of [WORKER_LIMITS.maxTreeEntries, WORKER_LIMITS.maxTreeEntries + 1]) {
    add({
      id: `worker.tree.listTree.${E}`, param: 'maxTreeEntries', op: 'listTree', repo: `tree-${E}`, path: '',
      bytes: E, entries: E, limits: worker,
      expect: E > WORKER_LIMITS.maxTreeEntries ? refused('limit_exceeded', { what: 'tree entries' }) : ok,
    });
  }
  // Many tiny objects: git index-pack accepts each pack (the fixture runs it); ply charges the overhead per object and
  // refuses past the budget, typed, where git accepts. The driver fills the expectation from verify-pack's count and sum.
  for (const [id, limits] of [['tiny-90000', undefined], ['tiny-20000', worker], ['tiny-90000', worker]]) {
    add({
      id: `${limits ? 'worker.' : ''}inflate.${id}`, param: 'maxInflatedTotal', op: 'pack', pack: id,
      bytes: Number(id.slice('tiny-'.length)) * 8, entries: Number(id.slice('tiny-'.length)), nightly: true, limits, expectFrom: 'charged',
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

  // ---- maxResolveWork: resolvePackRange of the chain git packed (d1-ofs: 80 revisions of a 2 KiB file, every delta one
  // deep). The two cells differ in this key alone; maxInflatedTotal is 0 in both because the bound applied is never
  // below it. A ceiling of 0 refuses the first delta read back (a delta inflates at least one byte); the default ceiling
  // (2 GiB) is four orders of magnitude past everything this pack declares.
  add({ id: 'resolve.work.default', param: 'maxResolveWork', op: 'resolveRange', pack: 'd1-ofs', bytes: 80 * 2048, entries: 80, limits: { maxInflatedTotal: 0, maxResolveWork: DEFAULT_LIMITS.maxResolveWork }, expect: ok });
  add({ id: 'resolve.work.zero', param: 'maxResolveWork', op: 'resolveRange', pack: 'd1-ofs', bytes: 80 * 2048, entries: 80, limits: { maxInflatedTotal: 0, maxResolveWork: 0 }, expect: refused('limit_exceeded', { what: 'resolve work bytes' }) });

  pass2(add);
  // ---- Every key, parsed where it enters (#156 parseLimits). A value that bounds nothing is refused when the client
  // is made, before any request, whichever operation would read it: lsRefs reads only maxRefs and maxLsRefsBytes, and
  // every key's cell is still refused there (the lazy read refused only the key the operation reached). A key left out
  // is the default: every other cell passes only the keys it sets (cell.mjs passes the record as written).
  // One null parses: maxResolveWork: null means derived (8 x the record's maxInflatedTotal), the same as leaving it out.
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    for (const [name, value] of [['negative', -1], ['null', null]]) {
      const expect = key === 'maxResolveWork' && value === null ? ok : refused('bad_request', { what: key });
      add({ id: `parse.${key}.${name}`, param: key, op: 'lsRefs', repo: 'refs-1', bytes: 200, entries: 1, limits: { [key]: value }, expect });
    }
  }
  add({ id: 'parse.none', param: 'maxRefs', op: 'lsRefs', repo: 'refs-1', bytes: 200, entries: 1, limits: {}, expect: ok });
  return cells;
}

// ---- The second pass (#144): the limits the first left `later`, and the wire: thin packs, protocol v0/v1, pkt-line
// lengths, capabilities, the request timer, and workerd. Override caps put a boundary in CI; the default boundary is
// a cell too wherever the fixture is affordable (nightly when it is not).
/** @param {(cell: Cell) => void} add */
function pass2(add) {
  const near = /** @type {const} */ ([['under', -1], ['at', 0], ['over', 1]]);

  // ---- maxPackObjects. parsePack refuses on the header's count, before the first object is inflated. The driver sets
  // the cap from verify-pack's object count (`capDelta` from it), so git's own count is the boundary.
  for (const [name, d] of near) {
    add({ id: `objects.pack.tiny-1000.cap-${name}`, param: 'maxPackObjects', op: 'pack', pack: 'tiny-1000', bytes: 8000, entries: 1003, capDelta: d, expectFrom: 'objects' });
  }
  // At the default 100 000: tiny-N holds N blobs, one tree per 1000 of them, the root tree and the commit, so
  // N = 99 897, 99 898, 99 899 are 99 999, 100 000 and 100 001 objects. The byte budget is raised so the count is
  // the cap that decides (at the default budget the overhead charge refuses first, #142).
  for (const n of [99897, 99898, 99899]) {
    add({ id: `objects.pack.tiny-${n}`, param: 'maxPackObjects', op: 'pack', pack: `tiny-${n}`, bytes: n * 8, entries: n, nightly: true, limits: { maxInflatedTotal: 1024 * MiB }, expectFrom: 'objects' });
  }
  // pushTree counts files against the same cap, before any blob is hashed.
  for (const n of [99, 100, 101]) {
    add({
      id: `objects.push.cap100.${n}`, param: 'maxPackObjects', op: 'pushTree', repo: 'push-empty', writes: true,
      nfiles: n, size: 8, bytes: n * 8, entries: n, limits: { maxPackObjects: 100 },
      expect: n > 100 ? refused('limit_exceeded', { what: 'files', got: 101, max: 100 }) : ok,
    });
  }
  for (const n of [100000, 100001]) {
    add({
      id: `objects.push.${n}`, param: 'maxPackObjects', op: 'pushTree', repo: 'push-empty', writes: true,
      nfiles: n, size: 8, bytes: n * 8, entries: n, nightly: true, limits: { maxPushBytes: 1024 * MiB },
      expect: n > DEFAULT_LIMITS.maxPackObjects ? refused('limit_exceeded', { what: 'files' }) : ok,
    });
  }

  // ---- maxSectionLines. git's upload-pack is the oracle: the driver sends it the same wants, haves and deepen and
  // counts the lines of each section it answers with (`expectFrom: 'sections'`). acknowledgments: one ACK per common
  // have, then `ready`; shallow-info: one line per wanted commit at the deepen boundary.
  const sectionCap = DEFAULT_LIMITS.maxSectionLines;
  for (const h of [6, 7, 8]) {
    add({ id: `section.acks.cap8.h${h}`, param: 'maxSectionLines', op: 'fetchPack', repo: 'log-1024', haveCount: h, done: false, bytes: 1024 * 8, entries: 1024, limits: { maxSectionLines: 8 }, expectFrom: 'sections' });
  }
  for (const h of [sectionCap - 2, sectionCap - 1, sectionCap]) {
    // CI keeps the pair that crosses the cap; the line below them is nightly (CI time budget)
    add({ id: `section.acks.h${h}`, param: 'maxSectionLines', op: 'fetchPack', repo: 'log-1024', haveCount: h, done: false, bytes: 1024 * 8, entries: 1024, nightly: h < sectionCap - 1, expectFrom: 'sections' });
  }
  for (const k of [7, 8, 9]) {
    add({ id: `section.shallow.cap8.k${k}`, param: 'maxSectionLines', op: 'fetchPack', repo: 'log-1024', wantCount: k, deepen: 1, filter: 'tree:0', bytes: 1024 * 8, entries: 1024, limits: { maxSectionLines: 8 }, expectFrom: 'sections' });
  }
  for (const k of [sectionCap - 1, sectionCap, sectionCap + 1]) {
    add({ id: `section.shallow.k${k}`, param: 'maxSectionLines', op: 'fetchPack', repo: 'log-1024', wantCount: k, deepen: 1, filter: 'tree:0', bytes: 1024 * 8, entries: 1024, nightly: k < sectionCap, expectFrom: 'sections' });
  }

  // ---- maxReportLines. pushRepo of every branch of branches-N to an empty repository: N commands, and receive-pack
  // answers one unpack line and one status per ref (N + 1 lines). The cap admits at least that many lines for the
  // commands sent (push.ts reportLineCap), so an honest report never trips it: a push of 8 under a cap of 8 lands.
  // git's refs after the push are the oracle (they must equal the local ones).
  for (const n of [6, 7, 8]) {
    add({
      id: `report.cap8.n${n}`, param: 'maxReportLines', op: 'pushRepo', repo: 'empty', local: `branches-${n}`, spec: { all: true }, writes: true,
      bytes: n * 64, entries: n, limits: { maxReportLines: 8 }, nightly: n === 6,
      expect: ok,
    });
  }
  // maxRefs allows as many commands as maxReportLines allows lines, and a report is one line more than its commands (#144).
  add({
    id: 'report.refs8.n8', param: 'maxReportLines', op: 'pushRepo', repo: 'empty', local: 'branches-8', spec: { all: true }, writes: true,
    bytes: 8 * 64, entries: 8, limits: { maxRefs: 8, maxReportLines: 8 }, expect: ok,
  });
  // The default cap equals maxRefs, so the largest push maxRefs allows (10 000 commands) has 10 001 report lines.
  const refCap = DEFAULT_LIMITS.maxRefs;
  for (const n of [refCap - 1, refCap, refCap + 1]) {
    add({
      id: `report.n${n}`, param: 'maxReportLines', op: 'pushRepo', repo: 'empty', local: `branches-${n}`, spec: { all: true }, writes: true,
      bytes: n * 64, entries: n, nightly: true,
      expect: n > refCap ? refused('limit_exceeded', { what: 'local refs' }) : ok,
    });
  }

  // ---- maxCommitParents. One octopus commit with N parents (git writes and walks any number). readLog parses it.
  for (const cap of [8, 9, 10]) {
    add({
      id: `parents.octo-9.cap${cap}`, param: 'maxCommitParents', op: 'readLog', repo: 'octo-9', limit: 1, history: 1,
      bytes: 9 * 64, entries: 10, limits: { maxCommitParents: cap },
      expect: 9 > cap ? refused('limit_exceeded', { what: 'commit parents', got: 9, max: cap }) : ok,
    });
  }
  const parentCap = DEFAULT_LIMITS.maxCommitParents;
  for (const n of [parentCap, parentCap + 1]) {
    add({
      id: `parents.octo-${n}`, param: 'maxCommitParents', op: 'readLog', repo: `octo-${n}`, limit: 1, history: 1,
      bytes: n * 64, entries: n + 1,
      expect: n > parentCap ? refused('limit_exceeded', { what: 'commit parents', got: n, max: parentCap }) : ok,
    });
  }

  // ---- maxRebaseCommits. rebaseBranch of feat (K commits) onto main (K commits) in mb-K. git's rev-list on the copy
  // is the oracle: K commits from main to feat, and main an ancestor of feat.
  for (const k of [7, 8, 9]) {
    add({
      id: `rebase.cap8.k${k}`, param: 'maxRebaseCommits', op: 'rebase', repo: `mb-${k}`, ref: 'refs/heads/feat', onto: 'refs/heads/main', writes: true,
      bytes: k * 16, entries: k * 2 + 1, limits: { maxRebaseCommits: 8 }, rebased: k, nightly: k === 7,
      expect: k > 8 ? refused('limit_exceeded', { what: 'rebase chain', got: 9, max: 8 }) : ok,
    });
  }
  // At the defaults the merge-base search (maxMergeDepth 1024) refuses a branch long before the rebase cap (10 000):
  // k = 1025 is refused by the search. The cap's own boundary needs a deeper search, so those cells raise it (nightly).
  for (const k of [DEFAULT_LIMITS.maxMergeDepth, DEFAULT_LIMITS.maxMergeDepth + 1]) {
    add({
      id: `rebase.k${k}`, param: 'maxRebaseCommits', op: 'rebase', repo: `mb-${k}`, ref: 'refs/heads/feat', onto: 'refs/heads/main', writes: true,
      // replaying 1024 commits is ~30 s (7 s of CPU; the rest is one tree fetch per commit), so the success is nightly
      bytes: k * 16, entries: k * 2 + 1, rebased: k, nightly: k <= DEFAULT_LIMITS.maxMergeDepth,
      expect: k > DEFAULT_LIMITS.maxMergeDepth ? refused('limit_exceeded', { what: 'merge-base search depth' }) : ok,
    });
  }
  const rebaseCap = DEFAULT_LIMITS.maxRebaseCommits;
  for (const k of [rebaseCap, rebaseCap + 1]) {
    add({
      id: `rebase.deep.k${k}`, param: 'maxRebaseCommits', op: 'rebase', repo: `mb-${k}`, ref: 'refs/heads/feat', onto: 'refs/heads/main', writes: true,
      // replaying 10 000 commits takes about 200 s on a loaded 4-core machine: past the default cell timeout
      bytes: k * 16, entries: k * 2 + 1, nightly: true, limits: { maxMergeDepth: 16384 }, rebased: k, timeoutMs: 900_000,
      expect: k > rebaseCap ? refused('limit_exceeded', { what: 'rebase chain', got: k, max: rebaseCap }) : ok,
    });
  }

  // ---- maxDeltaResult. The largest object git stored as a delta in the pack (fixtures read its size with cat-file)
  // is the boundary; the cap is set around it (`capDelta`).
  for (const [name, d] of near) {
    add({ id: `delta.result.d1-ofs.cap-${name}`, param: 'maxDeltaResult', op: 'pack', pack: 'd1-ofs', bytes: 80 * 2048, entries: 80, capDelta: d, expectFrom: 'delta-result' });
    add({ id: `delta.result.d64-ref.cap-${name}`, param: 'maxDeltaResult', op: 'pack', pack: 'd64-ref', bytes: 80 * 2048, entries: 80, capDelta: d, expectFrom: 'delta-result' });
  }

  // ---- maxHarvestBytes. A server without filters answers readLog's tree:0 with the whole window; ply keeps its
  // commits and trees up to the cap and drops the rest silently (a later want fetches again). Every cap is ok and
  // agrees with git; the boundary is the sum git reports for the repository's commits and trees (`capDelta`).
  for (const max of [0, 1]) {
    add({ id: `harvest.readLog.${max}`, param: 'maxHarvestBytes', op: 'readLog', repo: 'cap-nofilter--log-64', limit: 64, history: 64, bytes: 64 * 8, entries: 64, limits: { maxHarvestBytes: max }, expect: ok });
  }
  for (const [name, d] of near) {
    add({ id: `harvest.readLog.cap-${name}`, param: 'maxHarvestBytes', op: 'readLog', repo: 'cap-nofilter--log-64', limit: 64, history: 64, bytes: 64 * 8, entries: 64, capDelta: d, nightly: d !== 0, expectFrom: 'harvest' });
  }
  add({ id: 'harvest.readLog.default', param: 'maxHarvestBytes', op: 'readLog', repo: 'cap-nofilter--log-64', limit: 64, history: 64, bytes: 64 * 8, entries: 64, expect: ok });

  // ---- the exchange timers (#255), through the slow-server shim (shim.mjs). requestTimeoutMs is an opt-in total: a
  // cap of 1 s in CI covers the whole exchange, a stalled body included. firstByteTimeoutMs bounds a slow server (delay)
  // and idleTimeoutMs a stalled body (stall): 1 s caps in CI, each with the server well inside and well past it, and the
  // 60 s defaults nightly.
  const timeout = refused('timeout');
  for (const [mode, ms, expect] of [['delay', 200, ok], ['delay', 2500, timeout], ['stall', 200, ok], ['stall', 2500, timeout]]) {
    add({ id: `timeout.cap1000.lsRefs.${mode}-${ms}`, param: 'requestTimeoutMs', op: 'lsRefs', repo: 'refs-1', shim: `${mode}-${ms}`, bytes: 200, entries: 1, limits: { requestTimeoutMs: 1000 }, expect });
  }
  add({ id: 'timeout.cap1000.readFile.stall-2500', param: 'requestTimeoutMs', op: 'readFile', repo: 'blob-1048576', path: 'big.bin', shim: 'stall-2500', bytes: MiB, entries: 2, limits: { requestTimeoutMs: 1000 }, expect: timeout });
  for (const [ms, expect] of [[200, ok], [2500, timeout]]) {
    add({ id: `timeout.firstbyte1000.lsRefs.delay-${ms}`, param: 'firstByteTimeoutMs', op: 'lsRefs', repo: 'refs-1', shim: `delay-${ms}`, bytes: 200, entries: 1, limits: { firstByteTimeoutMs: 1000 }, expect });
    add({ id: `timeout.idle1000.lsRefs.stall-${ms}`, param: 'idleTimeoutMs', op: 'lsRefs', repo: 'refs-1', shim: `stall-${ms}`, bytes: 200, entries: 1, limits: { idleTimeoutMs: 1000 }, expect });
  }
  add({ id: 'timeout.idle1000.readFile.stall-2500', param: 'idleTimeoutMs', op: 'readFile', repo: 'blob-1048576', path: 'big.bin', shim: 'stall-2500', bytes: MiB, entries: 2, limits: { idleTimeoutMs: 1000 }, expect: timeout });
  const fCap = DEFAULT_LIMITS.firstByteTimeoutMs, iCap = DEFAULT_LIMITS.idleTimeoutMs;
  for (const [ms, expect] of [[fCap - 5000, ok], [fCap + 5000, timeout]]) {
    add({ id: `timeout.lsRefs.delay-${ms}`, param: 'firstByteTimeoutMs', op: 'lsRefs', repo: 'refs-1', shim: `delay-${ms}`, bytes: 200, entries: 1, nightly: true, expect });
  }
  for (const [ms, expect] of [[iCap - 5000, ok], [iCap + 5000, timeout]]) {
    add({ id: `timeout.lsRefs.stall-${ms}`, param: 'idleTimeoutMs', op: 'lsRefs', repo: 'refs-1', shim: `stall-${ms}`, bytes: 200, entries: 1, nightly: true, expect });
  }

  // ---- protocol v0 / v1: the server answers without v2 (the shim drops or downgrades Git-Protocol), so upload-pack
  // reads ply's `command=ls-refs` as a v0 request and answers nothing at all. ply speaks v2 only: the desired answer is
  // a typed refusal that says so (the empty answer sends ply to the advertisement, whose first line is not `version 2`:
  // `unsupported`, what 'protocol version'), not a misread advertisement. pushTree reads the ref through ls-refs first,
  // so it is refused the same way before receive-pack (which has no v2) is reached.
  const notV2 = refused('unsupported', { what: 'protocol version' });
  for (const v of ['v0', 'v1']) {
    add({ id: `proto.${v}.lsRefs`, param: 'maxRefs', op: 'lsRefs', repo: 'refs-1', shim: v, bytes: 200, entries: 1, expect: notV2 });
    add({ id: `proto.${v}.readFile`, param: 'maxPackBytes', op: 'readFile', repo: 'blob-1024', path: 'big.bin', shim: v, bytes: 1024, entries: 2, expect: notV2 });
    add({ id: `proto.${v}.pushTree`, param: 'maxPushBytes', op: 'pushTree', repo: 'push-empty', shim: v, writes: true, nfiles: 1, size: 64, bytes: 64, entries: 1, expect: notV2 });
  }

  // ---- pkt-line length. The shim re-frames the packfile section so every band-1 pkt-line is L bytes long; git's own
  // client through the same URL is the oracle (gitprotocol-common: 4 + data, at most 65520). `expectFrom: 'git-clone'`.
  // gitprotocol-common caps a pkt-line at 65520 bytes; git's client (2.4x) reads past that and refuses a total of 65524
  // (its buffer is LARGE_PACKET_MAX with room for a NUL). The documented 65520 / 65521 and git's measured 65523 / 65524
  // are all cells: ply has to agree with the client, not with the document.
  for (const L of [4096, 65519, 65520, 65521, 65522, 65523, 65524, 65525, 65535]) {
    add({ id: `pktline.frame-${L}.readFile`, param: 'maxPackBytes', op: 'readFile', repo: 'blob-65536', path: 'big.bin', shim: `frame-${L}`, bytes: 65536, entries: 2, nightly: [4096, 65519, 65522].includes(L), expectFrom: 'git-clone' });
  }
  // The smallest frames on a 1 KiB blob in CI (1000 frames). On 16, 32 and 64 KiB (nightly) the time per byte is the
  // cost of a frame: one byte per frame is 65 536 frames.
  for (const L of [4, 5, 6, 7]) {
    add({ id: `pktline.frame-${L}.readFile.1024`, param: 'maxPackBytes', op: 'readFile', repo: 'blob-1024', path: 'big.bin', shim: `frame-${L}`, bytes: 1024, entries: 2, expectFrom: 'git-clone' });
  }
  for (const S of [16384, 32768, 65536]) {
    add({ id: `pktline.frame-6.readFile.${S}`, param: 'maxPackBytes', op: 'readFile', repo: `blob-${S}`, path: 'big.bin', shim: 'frame-6', bytes: S, entries: 2, nightly: true, expectFrom: 'git-clone' });
  }

  // ---- capabilities: a server with one of ply's features turned off. Content checked against git when ply answers.
  add({ id: 'caps.nofilter.readFile', param: 'maxPackBytes', op: 'readFile', repo: 'cap-nofilter--blob-1024', path: 'big.bin', bytes: 1024, entries: 2, expect: ok });
  add({ id: 'caps.nofilter.listTree', param: 'maxTreeEntries', op: 'listTree', repo: 'cap-nofilter--depth-8', path: 'd/d/d', bytes: 64, entries: 8, expect: ok });
  add({ id: 'caps.nofilter.merge', param: 'maxMergeDepth', op: 'merge', repo: 'cap-nofilter--mb-8', from: 'refs/heads/feat', writes: true, bytes: 128, entries: 17, expect: ok });
  add({ id: 'caps.nosha.readFile', param: 'maxPathDepth', op: 'readFile', repo: 'cap-nosha--depth-8', path: 'd/d/d/d/d/d/d/f.txt', bytes: 64, entries: 8, expect: ok });
  add({ id: 'caps.reachable.readFile', param: 'maxPathDepth', op: 'readFile', repo: 'cap-reachable--depth-8', path: 'd/d/d/d/d/d/d/f.txt', bytes: 64, entries: 8, expect: ok });
  // receive-pack disabled: http-backend answers the POST 403 at its status line, and its advertisement 403 too, so receive-pack never ran: 'auth', never 'ambiguous'
  add({ id: 'caps.nopush.pushTree', param: 'maxPushBytes', op: 'pushTree', repo: 'cap-nopush--push-empty', writes: true, nfiles: 1, size: 64, bytes: 64, entries: 1, expect: refused('auth') });

  // ---- thin packs. Push: the remote has v1, the local repository v1 and v2; a thin push sends v2's blob as a
  // REF_DELTA against v1's, which git's receive-pack completes (index-pack --fix-thin). Fetch: the server deltas
  // against the haves and ply resolves the external bases from the local store. The oracle is git: refs equal after
  // the push and fsck clean; the fetched objects are exactly `git rev-list --objects v2 ^v1`.
  for (const thin of [true, false]) {
    add({ id: `thin.push.${thin ? 'thin' : 'full'}`, param: 'maxPushBytes', op: 'pushRepo', repo: 'thin-remote', local: 'thin-local', spec: { refspecs: ['main'], thin }, writes: true, bytes: 64 * 1024, entries: 2, thin, expect: ok });
  }
  add({ id: 'thin.fetch.external', param: 'maxDeltaChain', op: 'fetchThin', repo: 'thin-local', store: 'thin-remote', bytes: 64 * 1024, entries: 2, expectFrom: 'thin' });
  // The bases are not in the store: the pack cannot be completed, and that is a typed refusal, not a crash.
  add({ id: 'thin.fetch.missing-base', param: 'maxDeltaChain', op: 'fetchThin', repo: 'thin-local', store: 'empty', bytes: 64 * 1024, entries: 2, expectFrom: 'thin-missing', expect: refused('pack_corrupt') });

  // ---- workerd. The same operations inside the Workers runtime (test/workerd), one fresh workerd process per cell;
  // its peak RSS and CPU are the isolate's cost. The cells mirror node cells above, so the two runtimes can be read
  // side by side in the report.
  const wd = { runtime: 'workerd' };
  add({ ...wd, id: 'workerd.readFile.16777216', param: 'maxPackBytes', op: 'readFile', repo: 'blob-16777216', path: 'big.bin', bytes: 16 * MiB, entries: 2, expectFrom: 'wire' });
  add({ ...wd, id: 'workerd.readFile.cap1MiB.1048577', param: 'maxPackBytes', op: 'readFile', repo: 'blob-1048577', path: 'big.bin', bytes: MiB + 1, entries: 2, limits: { maxPackBytes: MiB }, expectFrom: 'wire' });
  add({ ...wd, id: 'workerd.listTree.65536', param: 'maxTreeEntries', op: 'listTree', repo: 'tree-65536', path: '', bytes: 65536, entries: 65536, expect: ok });
  add({ ...wd, id: 'workerd.worker.listTree.32769', param: 'maxTreeEntries', op: 'listTree', repo: `tree-${WORKER_LIMITS.maxTreeEntries + 1}`, path: '', bytes: 32769, entries: 32769, limits: worker(), expect: refused('limit_exceeded', { what: 'tree entries' }) });
  add({ ...wd, id: 'workerd.lsRefs.10000', param: 'maxRefs', op: 'lsRefs', repo: 'refs-10000', bytes: 400000, entries: 10000, expect: ok });
  add({ ...wd, id: 'workerd.lsRefs.10001', param: 'maxRefs', op: 'lsRefs', repo: 'refs-10001', bytes: 400040, entries: 10001, expect: refused('limit_exceeded', { what: 'ls-refs lines' }) });
  add({ ...wd, id: 'workerd.push.object.16777216', param: 'maxObjectSize', op: 'pushTree', repo: 'push-empty', writes: true, nfiles: 1, size: 16 * MiB, bytes: 16 * MiB, entries: 1, limits: worker(), expect: ok });
  add({ ...wd, id: 'workerd.push.total.10000x64', param: 'maxPushBytes', op: 'pushTree', repo: 'push-empty', writes: true, nfiles: 10000, size: 64, bytes: 640000, entries: 10000, limits: worker(), expect: ok });
  add({ ...wd, id: 'workerd.timeout.cap1000.stall-2500', param: 'requestTimeoutMs', op: 'lsRefs', repo: 'refs-1', shim: 'stall-2500', bytes: 200, entries: 1, limits: { requestTimeoutMs: 1000 }, expect: refused('timeout') });
  add({ ...wd, id: 'workerd.section.shallow.k1001', param: 'maxSectionLines', op: 'fetchPack', repo: 'log-1024', wantCount: 1001, deepen: 1, filter: 'tree:0', bytes: 1024 * 8, entries: 1024, expectFrom: 'sections' });
  add({ ...wd, id: 'workerd.parents.octo-10001', param: 'maxCommitParents', op: 'readLog', repo: 'octo-10001', limit: 1, history: 1, bytes: 10001 * 64, entries: 10002, expect: refused('limit_exceeded', { what: 'commit parents' }) });
  add({ ...wd, id: 'workerd.readFile.64MiB', param: 'maxObjectSize', op: 'readFile', repo: `blob-${DEFAULT_LIMITS.maxObjectSize}`, path: 'big.bin', bytes: DEFAULT_LIMITS.maxObjectSize, entries: 2, expectFrom: 'wire' });
}

const worker = () => ({ ...WORKER_LIMITS });

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
