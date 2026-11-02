// Delta compression for a pack being written: a copy/insert delta generator in the shape of git's diff-delta.c, and a
// planner that picks each object's base the way a history push wants it. Pure and Workers-safe; nothing here reads the
// wire. The edit path does not import it (spliceDelta is all a one-region edit needs).
//
//   encodeDelta(base, target, maxSize) → the delta (gitformat-pack "Deltified representation"), or null when the delta
//                                        would be maxSize bytes or more
//   planDeltas(objects, options)       → buildPack/push input: each tree and blob with a path is tried against the
//                                        previous object of the same type at the same path, then at the same file name
//                                        (a rename), then (thin, opt-in) the object the remote holds at that path
//
// encodeDelta indexes the base in non-overlapping 16-byte blocks (git's RABIN_WINDOW), at most 64 offsets per hash
// bucket (HASH_LIMIT), then walks the target with a rolling hash: a block hit is verified byte by byte and extended
// forward and back over the pending literals, and the longest match becomes a copy. What no block matches is inserted.
// The output is exactly what applyDelta (packresolve.ts) and git's patch_delta read. Deterministic: the same inputs
// give the same bytes.
//
// planDeltas is bounded: a delta chain is at most maxDepth deep (git's pack.depth default, 50; resolvePack's own bound
// is maxDeltaChain, 64), an object over maxBytes is stored whole, and a delta is kept only when it is under half the
// object less an object id (git's try_delta max_size), so a delta is never larger than the object it replaces. Bases
// precede their deltas in pack order, so an in-pack base is an OFS_DELTA (`baseIndex`); a thin base is a REF_DELTA
// (`baseOid`), and only a caller who knows the remote has that object passes one.
/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- the scan's indexed reads are in range of a checked length and say `as number` (free at run time, unlike an Option per byte; not the `!` src/ forbids), as packresolve.ts does */
import { concat } from './bytes.js';
import { copyOps, encodeVarint, insertOps } from './pack.js';
import type { PackInput } from './pack.js';
import { TYPE } from './objects.js';
import { DELTA_INSERT_MAX, DELTA_SIZE_MIN, OID_BYTES } from './format.js';
import type { Input } from './absent.js';
import { at, mapGet, withDefaults } from './absent.js';
import { getOrElse, mapOption } from './result.js';

/** git diff-delta.c RABIN_WINDOW: the base is indexed in blocks of this many bytes, and a copy is at least this long. */
export const DELTA_WINDOW = 16;
/** git diff-delta.c HASH_LIMIT: offsets kept per hash bucket, so a run of identical blocks cannot make a scan quadratic. */
export const DELTA_BUCKET_LIMIT = 64;
/** A match this long is taken without trying the bucket's other offsets. */
const GOOD_MATCH = 4096;
/** Polynomial rolling hash over one window (mod 2^32). PRIME_POW is PRIME^(WINDOW-1), the weight of the byte that leaves. */
const PRIME = 0x01_00_01_93;
const PRIME_POW = ((): number => { let p = 1; for (let i = 1; i < DELTA_WINDOW; i++) p = Math.imul(p, PRIME); return p; })();
const HASH_SPREAD = 15;
const MIN_TABLE = 16;
const NONE = -1;

const hashAt = (buf: Uint8Array, p: number): number => {
  let h = 0;
  for (let k = 0; k < DELTA_WINDOW; k++) h = (Math.imul(h, PRIME) + (buf[p + k] as number)) >>> 0;
  return h;
};
// Math.imul reads its operands mod 2^32, so the subtraction needs no wrap of its own
const roll = (h: number, out: number, inp: number): number => (Math.imul(h - Math.imul(out, PRIME_POW), PRIME) + inp) >>> 0;
const bucketOf = (h: number, mask: number): number => (h ^ (h >>> HASH_SPREAD)) & mask;

// The base's block index: head[bucket] is the first block, next[block] the following one; -1 ends a chain.
type Index = { readonly head: Int32Array; readonly next: Int32Array; readonly mask: number };
function indexBase(base: Uint8Array): Index {
  const blocks = Math.floor(base.length / DELTA_WINDOW);
  let size = MIN_TABLE;
  while (size < blocks) size *= 2;
  const mask = size - 1;
  const head = new Int32Array(size).fill(NONE);
  const next = new Int32Array(blocks).fill(NONE);
  const count = new Uint8Array(size);
  // last block first, so each chain lists the lowest offsets first and the 64 kept are the earliest
  for (let b = blocks - 1; b >= 0; b--) {
    const k = bucketOf(hashAt(base, b * DELTA_WINDOW), mask);
    if ((count[k] as number) >= DELTA_BUCKET_LIMIT) {
      // a full bucket: this earlier block replaces the chain's last entry's place at the head (bounded, deterministic)
      next[b] = next[head[k] as number] as number;
      head[k] = b;
      continue;
    }
    next[b] = head[k] as number;
    head[k] = b;
    count[k] = (count[k] as number) + 1;
  }
  return { head, next, mask };
}

// An insert of n bytes costs n plus one opcode per 127.
const literalCost = (n: number): number => n + Math.ceil(n / DELTA_INSERT_MAX);
// The longest run of target bytes from `pos` that the base holds at an offset in the hash's bucket: [offset, length].
function longestMatch(base: Uint8Array, target: Uint8Array, pos: number, index: Index, h: number): readonly [number, number] {
  let bestLen = 0;
  let bestOff = 0;
  for (let b = index.head[bucketOf(h, index.mask)] as number; b !== NONE; b = index.next[b] as number) {
    const off = b * DELTA_WINDOW;
    const lim = Math.min(base.length - off, target.length - pos);
    let n = 0;
    while (n < lim && base[off + n] === target[pos + n]) n++;
    if (n > bestLen) { bestLen = n; bestOff = off; if (n >= GOOD_MATCH) break; }
  }
  return [bestOff, bestLen];
}

// The delta that rebuilds `target` from `base`, or null when it would be `maxSize` bytes or more (or the base is too
// short to index). maxSize defaults to the target's length: a delta that does not save a byte is not one.
export function encodeDelta(base: Uint8Array, target: Uint8Array, maxSize: number = target.length): Uint8Array<ArrayBuffer> | null {
  if (base.length < DELTA_WINDOW || target.length < DELTA_WINDOW) return null;
  const sizes = [encodeVarint(base.length), encodeVarint(target.length)];
  const parts: Uint8Array[] = [...sizes];
  let size = sizes.reduce((n, b) => n + b.length, 0);
  const emit = (ops: readonly Uint8Array[]): void => { for (const o of ops) { parts.push(o); size += o.length; } };
  const index = indexBase(base);
  let pos = 0;
  let lit = 0;
  let h = hashAt(target, 0);
  while (pos + DELTA_WINDOW <= target.length) {
    const [bestOff, bestLen] = longestMatch(base, target, pos, index, h);
    if (bestLen < DELTA_WINDOW) {
      if (size + literalCost(pos + 1 - lit) >= maxSize) return null;
      if (pos + DELTA_WINDOW < target.length) h = roll(h, target[pos] as number, target[pos + DELTA_WINDOW] as number);
      pos++;
      continue;
    }
    // extend the match back over literals not yet written
    let back = 0;
    while (pos - back > lit && bestOff - back > 0 && base[bestOff - back - 1] === target[pos - back - 1]) back++;
    if (pos - back > lit) emit(insertOps(target.subarray(lit, pos - back)));
    emit(copyOps(bestOff - back, bestLen + back));
    if (size >= maxSize) return null;
    pos += bestLen;
    lit = pos;
    if (pos + DELTA_WINDOW <= target.length) h = hashAt(target, pos);
  }
  if (target.length > lit) emit(insertOps(target.subarray(lit)));
  return size < maxSize && size >= DELTA_SIZE_MIN ? concat(parts) : null;
}

// ---- the planner ----
/** One object in pack order. `path` (the object's path in some commit's tree) makes a tree or blob a delta candidate. */
export type DeltaCandidate = { readonly type: number; readonly data: Uint8Array; readonly path: string | null };
/** A base the remote is known to hold: its id and bytes. */
export type ThinBase = { readonly oid: string; readonly data: Uint8Array };
export type DeltaPlanConfig = {
  // the longest chain a delta may end (git pack.depth); 0 stores everything whole
  readonly maxDepth: number;
  // an object larger than this is stored whole (the generator holds an index of the base beside both)
  readonly maxBytes: number;
  // the remote's object for (type, path), or null. Only for a remote that accepts thin packs; null: no thin bases.
  readonly thinBase: ((type: number, path: string) => ThinBase | null) | null;
};
export type DeltaPlanOptions = Input<DeltaPlanConfig>;
export type DeltaPlan = {
  readonly objects: PackInput[];
  // deltas against an earlier object of this pack (OFS_DELTA) and against a thin base (REF_DELTA)
  readonly ofs: number;
  readonly ref: number;
  // the bytes of every object as given, and of what the plan writes (before zlib)
  readonly rawBytes: number;
  readonly plannedBytes: number;
};
/** git pack.depth's default. */
export const DELTA_DEPTH = 50;
/** Objects larger than this are stored whole: the index of the base and the scan stay a bounded amount of work. */
export const DELTA_MAX_BYTES: number = 16 * 1024 * 1024;
/** A target smaller than this is not worth a delta's two size headers and an opcode. */
const MIN_TARGET = 64;

const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const EMPTY = new Uint8Array(0);
type Base = { readonly index: number; readonly depth: number; readonly data: Uint8Array };
// The smallest delta of `o` against one of `bases` (in order: the first wins a tie) that keeps the chain within
// maxDepth and is under half the object less an object id (git try_delta's max_size); null when none is.
function bestDelta(o: DeltaCandidate, bases: readonly Base[], { maxDepth, maxBytes }: Pick<DeltaPlanConfig, 'maxDepth' | 'maxBytes'>): { readonly delta: Uint8Array; readonly index: number; readonly depth: number } | null {
  let best: { readonly delta: Uint8Array; readonly index: number; readonly depth: number } | null = null;
  let limit = Math.floor(o.data.length / 2) - OID_BYTES;
  for (const b of bases) {
    if (b.depth + 1 > maxDepth || b.data.length > maxBytes) continue;
    const delta = encodeDelta(b.data, o.data, limit);
    if (delta === null) continue;
    best = { delta, index: b.index, depth: b.depth + 1 };
    limit = delta.length;
  }
  return best;
}

// Each object's representation, in the order given. Commits and tags are stored whole, as git stores them in practice.
export function planDeltas(objects: readonly DeltaCandidate[], options: DeltaPlanOptions = {}): DeltaPlan {
  const { maxDepth, maxBytes, thinBase } = withDefaults<DeltaPlanConfig>(options, { maxDepth: DELTA_DEPTH, maxBytes: DELTA_MAX_BYTES, thinBase: null });
  const out: PackInput[] = [];
  const depth: number[] = [];
  const lastAt = new Map<string, number>();
  let ofs = 0;
  let ref = 0;
  let rawBytes = 0;
  let plannedBytes = 0;
  for (const [i, o] of objects.entries()) {
    rawBytes += o.data.length;
    let chosen: PackInput = { type: o.type, data: o.data };
    let chosenDepth = 0;
    const deltable = (o.type === TYPE.BLOB || o.type === TYPE.TREE) && o.data.length >= MIN_TARGET && o.data.length <= maxBytes && maxDepth > 0;
    if (deltable && o.path !== null) {
      const keys = [`${o.type} ${o.path}`, `${o.type} name ${fileName(o.path)}`];
      const bases = [...new Set(keys.map(k => getOrElse(mapGet(lastAt, k), NONE)).filter(j => j !== NONE))];
      const picked = bestDelta(o, bases.map(j => ({ index: j, depth: getOrElse(at(depth, j), 0), data: getOrElse(mapOption(at(objects, j), b => b.data), EMPTY) })), { maxDepth, maxBytes });
      if (picked !== null) { chosen = { type: o.type, data: picked.delta, baseIndex: picked.index }; chosenDepth = picked.depth; }
      // the first version of a path in this pack: the remote's own copy, when the caller vouches for thin packs
      const thin = thinBase !== null && bases.length === 0 ? thinBase(o.type, o.path) : null;
      if (thin !== null && thin.data.length <= maxBytes) {
        const delta = encodeDelta(thin.data, o.data, Math.floor(o.data.length / 2) - OID_BYTES);
        if (delta !== null) { chosen = { type: o.type, data: delta, baseOid: thin.oid }; chosenDepth = 1; }
      }
      for (const key of keys) lastAt.set(key, i);
    }
    if ('baseIndex' in chosen) ofs++;
    else if ('baseOid' in chosen) ref++;
    plannedBytes += chosen.data.length;
    depth.push(chosenDepth);
    out.push(chosen);
  }
  return { objects: out, ofs, ref, rawBytes, plannedBytes };
}
