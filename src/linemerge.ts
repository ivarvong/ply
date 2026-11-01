// Three-way line merge, ported from git's xdiff as merge-ort drives it (merge-ll.c: level XDL_MERGE_ZEALOUS, histogram
// diff, no indent heuristic, style merge, favor none). Pure: bytes in, { clean, data } | { clean: false, reason } out.
//
// Faithful parts: record splitting (lines keep their '\n'; a last line without one is a record), xhistogram.c (find_lcs /
// try_lcs / histogram_diff), xdl_change_compact (group sliding), xdl_build_script, xdl_do_merge (+ xdl_append_merge's
// fusing), the refinement outcome of xdl_refine_conflicts, and xdl_fill_merge_buffer for clean results.
// Classic Myers (xdiffi.c + xprepare.c's trim/cleanup, xdl_split's heuristics) is ported for both places git uses it in a
// merge: the histogram fallback for a region whose common lines all occur > 64 times (every version), and the 2.54+
// compaction re-diff (see `rediff`). The only 'undecided' left is the hash-chain limit, where git itself fails.
// The 64-record hash-chain limit in scanA is modelled exactly (buckets of the per-diff class index): git's merge fails
// there ("failed to execute internal merge"), so we answer 'undecided' — the 64/65 boundary is pinned against git.

import type { Option, Result } from './result.js';
import type { Input } from './absent.js';
import { LIMIT_MERGE_BLOB } from './limits.js';
import { ok, err, assertNever, getOrElse, none, some } from './result.js';
import { plyError } from './errors.js';
import { bytesToStr, popLast } from './attributes.js';
import { atOr, mapGet, withDefaults } from './absent.js';

// A file split into line records. `ids` are classifier ids: equal id, equal content.
export type Records = {
  readonly bytes: Uint8Array;
  readonly starts: number[];
  readonly ends: number[];
  readonly ids: number[];
  readonly n: number;
};
export type Classify = (bytes: Uint8Array, s: number, e: number) => number;
// What diffScript needs of a file: its ids and their count.
export type Lines = { readonly ids: ArrayLike<number>; readonly n: number };
export type Rediff = 'myers' | 'skip' | 'undecided';
export type Driver = 'text' | 'union' | 'binary';
// One change of a diff script, 0-based: base lines [i1, i1 + chg1) became side lines [i2, i2 + chg2).
export type Change = { i1: number; i2: number; chg1: number; chg2: number };
type Hunks = { readonly ours: number; readonly theirs: number };
// A clean merge; under merge=union, `unioned` counts the conflicts it resolved (present only when there were any).
export type MergeLinesResult =
  | { readonly clean: true; readonly data: Uint8Array; readonly hunks: Hunks }
  | { readonly clean: true; readonly data: Uint8Array; readonly hunks: Hunks; readonly unioned: number }
  | { readonly clean: false; readonly reason: 'binary (merge attribute)' | 'too large to merge' | 'binary' }
  | { readonly clean: false; readonly reason: 'content'; readonly conflicts: number }
  | { readonly clean: false; readonly reason: 'undecided'; readonly detail: string };
// Where we decline to answer (rediff 'undecided', or the hash-chain limit): the Err of a diff, a value (#80).
export type Undecided = { readonly undecided: true; readonly detail: string };
type Diffed<T> = Result<T, Undecided>;
const DONE: Diffed<null> = ok(null);
// compact's invariant: the two sides' change groups move in step (equal counts of unchanged lines). Broken, it is a
// programmer bug, so thrown, and typed (#80); the stack names the site.
const broken = (): Error => plyError('internal', 'linemerge: groups out of step');

const BINARY_SNIFF = 8000; // git's FIRST_FEW_BYTES: a NUL in the first 8000 bytes makes the merge binary (= conflict)
const MAX_CHAIN = 64;      // xhistogram.c max_chain_length

export const isBinary = (bytes: Uint8Array): boolean => { const n = Math.min(bytes.length, BINARY_SNIFF); for (let i = 0; i < n; i++) if (bytes[i] === 0) return true; return false; };

// Records: [start, end) byte offsets per line. Ids come from one classifier shared by all files of a merge, so id equality
// is content equality (git's minimal_perfect_hash).
export function records(bytes: Uint8Array, classify: Classify): Records {
  const starts: number[] = [];
  const ends: number[] = [];
  const ids: number[] = [];
  let p = 0;
  while (p < bytes.length) {
    let e = bytes.indexOf(0x0a, p); e = e < 0 ? bytes.length : e + 1;
    starts.push(p); ends.push(e); ids.push(classify(bytes, p, e)); p = e;
  }
  return { bytes, starts, ends, ids, n: ids.length };
}
export function classifier(): Classify {
  const map = new Map<string, number>();
  return (bytes, s, e) => {
    const key = bytesToStr(bytes.subarray(s, e)); // the line's bytes, one char per byte
    const known = mapGet(map, key); if (known.tag === 'some') return known.value;
    const id = map.size + 1; map.set(key, id); return id;
  };
}

const undecided = (detail: string): Diffed<never> => err({ undecided: true, detail });
// Unknown (a JS caller) reads as 'skip'.
const rediffMode = (rediff: string): Rediff => (rediff === 'myers' || rediff === 'skip' || rediff === 'undecided' ? rediff : 'skip');
// false: the compaction must stop as undecided. true: myers ran, or skip left the group where it is.
function applyRediff(rediff: string, myers: () => void): boolean {
  const mode = rediffMode(rediff);
  switch (mode) {
    case 'undecided': return false;
    case 'myers': myers(); return true;
    case 'skip': return true;
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(mode);
}

// ---- xhistogram.c ----
type Rec = { ptr: number; cnt: number };
const NO_REC: Readonly<Rec> = { ptr: 0, cnt: 0 };
type Lcs = { begin1: number; end1: number; begin2: number; end2: number };
// find_lcs's outcomes: a common subsequence, none (every line differs), the classic-diff fallback (every common line
// occurs > 64 times), or the hash-chain limit where git's merge fails.
type Found = Lcs & { readonly tag: 'lcs' } | { readonly tag: 'none' } | { readonly tag: 'fallback' } | { readonly tag: 'chain-limit' };
/* oxlint-disable eslint/max-depth, eslint/complexity, eslint/max-params -- a line-for-line port of xhistogram.c's find_lcs / try_lcs */
function findLcs(a: Int32Array, b: Int32Array, line1: number, count1: number, line2: number, count2: number): Found {
  const END1 = line1 + count1 - 1;
  const END2 = line2 + count2 - 1;
  // Line numbers here are in range (1-based, within the region): the atOr fallbacks only satisfy the index type.
  const recs = new Map<number, Rec>(); // id → { ptr, cnt }  (scanA: ptr = first occurrence, NEXT_PTR chains forward)
  // oxlint-disable-next-line unicorn/no-new-array -- line_map, preallocated and filled top-down
  const lineMap = new Array<Rec>(count1);
  const next = new Int32Array(count1);
  for (let ptr = END1; ptr >= line1; ptr--) {
    const id = atOr(a, ptr - 1, 0);
    const rec = recs.get(id);
    if (rec) { next[ptr - line1] = rec.ptr; rec.ptr = ptr; rec.cnt = rec.cnt + 1; lineMap[ptr - line1] = rec; }
    else { const r = { ptr, cnt: 1 }; recs.set(id, r); lineMap[ptr - line1] = r; }
  }
  // scanA's other way out: a new distinct line landing in a hash bucket that already chains 64 distinct records makes
  // find_lcs fail (-1) and git's merge fail — never clean. Bucket = XDL_HASHLONG(class index, xdl_hashbits(count1)).
  if (recs.size > MAX_CHAIN) {
    let bits = 0; for (let v = 1; v < count1 && bits < 32; v *= 2) bits++; bits = bits || 1;
    const mask = 2 ** bits - 1;
    const load = new Map<number, number>();
    for (const id of recs.keys()) { const h = (id + Math.floor(id / 2 ** bits)) & mask; const l = getOrElse(mapGet(load, h), 0) + 1; if (l > MAX_CHAIN) return { tag: 'chain-limit' }; load.set(h, l); }
  }
  const CNT = (ptr: number): number => atOr(lineMap, ptr - line1, NO_REC).cnt;
  const NEXT = (ptr: number): number => atOr(next, ptr - line1, 0);
  const lcs = { tag: 'lcs' as const, begin1: 0, end1: 0, begin2: 0, end2: 0 };
  let cnt = MAX_CHAIN + 1;
  let hasCommon = false;
  for (let bPtr = line2; bPtr <= END2;) {
    let bNext = bPtr + 1;
    const rec = recs.get(atOr(b, bPtr - 1, 0));
    if (rec) {
      if (rec.cnt > cnt) { hasCommon = true; }
      else {
        hasCommon = true;
        let as = rec.ptr;
        for (;;) {
          const np0 = NEXT(as);
          let bs = bPtr;
          let ae = as;
          let be = bs;
          let rc = rec.cnt;
          while (line1 < as && line2 < bs && a[as - 2] === b[bs - 2]) { as--; bs--; if (rc > 1) rc = Math.min(rc, CNT(as)); }
          while (ae < END1 && be < END2 && a[ae] === b[be]) { ae++; be++; if (rc > 1) rc = Math.min(rc, CNT(ae)); }
          if (bNext <= be) bNext = be + 1;
          if (lcs.end1 - lcs.begin1 < ae - as || rc < cnt) { lcs.begin1 = as; lcs.begin2 = bs; lcs.end1 = ae; lcs.end2 = be; cnt = rc; }
          let np = np0;
          if (np === 0) break;
          let stop = false;
          while (np <= ae) { np = NEXT(np); if (np === 0) { stop = true; break; } }
          if (stop) break;
          as = np;
        }
      }
    }
    bPtr = bNext;
  }
  if (hasCommon && MAX_CHAIN < cnt) return { tag: 'fallback' };
  return lcs.begin1 === 0 && lcs.begin2 === 0 ? { tag: 'none' } : lcs;
}
/* oxlint-enable eslint/max-depth, eslint/complexity, eslint/max-params */

// ---- the classic diff, as xdl_fall_back_diff runs it on a histogram region: a fresh xdl_do_diff over the two line ranges
// with Myers — xprepare.c's xdl_trim_ends + xdl_cleanup_records (discarding lines with no match, and multi-match lines
// amid runs of them), then xdiffi.c's xdl_recs_cmp / xdl_split with git's heuristics (need_min off: merges do not set
// XDF_NEED_MINIMAL). Ids only need equality; class counts are per sub-range, as in the fresh environment.
// oxlint-disable-next-line eslint/no-param-reassign -- C's loop over its argument
const bogosqrt = (n: number): number => { let i = 1; for (; n > 0; n = Math.floor(n / 4)) i *= 2; return i; };
const SNAKE_CNT = 20;
const HEUR_MIN_COST = 256;
const MAX_COST_MIN = 256;
const K_HEUR = 4;
const MAX_EQLIMIT = 1024;
const SIMSCAN_WINDOW = 100;
const KPDIS_RUN = 4;
const LINE_MAX = Number.MAX_SAFE_INTEGER;
const DISCARD = 0;
const KEEP = 1;
const INVESTIGATE = 2;

function cleanMmatch(action: Uint8Array, i: number, len: number): boolean {
  let s = 0;
  let e = len - 1;
  if (i - s > SIMSCAN_WINDOW) s = i - SIMSCAN_WINDOW;
  if (e - i > SIMSCAN_WINDOW) e = i + SIMSCAN_WINDOW;
  let r: number;
  let rdis0 = 0;
  let rpdis0 = 1;
  let rdis1 = 0;
  let rpdis1 = 1;
  for (r = 1; i - r >= s; r++) { const x = action[i - r]; if (x === DISCARD) rdis0++; else if (x === INVESTIGATE) rpdis0++; else break; }
  if (rdis0 === 0) return false;
  for (r = 1; i + r <= e; r++) { const x = action[i + r]; if (x === DISCARD) rdis1++; else if (x === INVESTIGATE) rpdis1++; else break; }
  if (rdis1 === 0) return false;
  rdis1 += rdis0; rpdis1 += rpdis0;
  return rpdis1 * KPDIS_RUN < rpdis1 + rdis1;
}

type Split = { i1: number; i2: number; minLo: boolean; minHi: boolean };
type Box = [off1: number, lim1: number, off2: number, lim2: number, needMin: boolean];
/* oxlint-disable eslint/max-depth, eslint/complexity, eslint/max-params, eslint/no-param-reassign -- a line-for-line port of xdiffi.c's xdl_split / xdl_recs_cmp over C's argument list */
export function classicDiff(A: Int32Array, B: Int32Array, line1: number, count1: number, line2: number, count2: number, CH1: Uint8Array, CH2: Uint8Array): void {
  const a = A.subarray(line1 - 1, line1 - 1 + count1);
  const b = B.subarray(line2 - 1, line2 - 1 + count2);
  const n1 = a.length;
  const n2 = b.length;
  const ch1 = new Uint8Array(n1);
  const ch2 = new Uint8Array(n2);
  // Indexes into the id arrays below are in range: the atOr fallbacks only satisfy the index type.
  const len1 = new Map<number, number>();
  const len2 = new Map<number, number>();
  for (const x of a) len1.set(x, getOrElse(mapGet(len1, x), 0) + 1);
  for (const x of b) len2.set(x, getOrElse(mapGet(len2, x), 0) + 1);
  // xdl_trim_ends
  let i = 0;
  let lim = Math.min(n1, n2);
  for (; i < lim; i++) if (a[i] !== b[i]) break;
  const off = i; lim -= i;
  for (i = 0; i < lim; i++) if (a[n1 - 1 - i] !== b[n2 - 1 - i]) break;
  const dend1 = n1 - i - 1;
  const dend2 = n2 - i - 1;
  // xdl_cleanup_records
  const refs = (x: Int32Array, n: number, dend: number, other: ReadonlyMap<number, number>, ch: Uint8Array): Int32Array => {
    const len = dend - off + 1;
    const mlim = Math.min(bogosqrt(n), MAX_EQLIMIT);
    const action = new Uint8Array(Math.max(len, 0));
    for (let k = 0; k < len; k++) {
      const nm = getOrElse(mapGet(other, atOr(x, k + off, 0)), 0);
      const many = nm < mlim ? KEEP : INVESTIGATE;
      action[k] = nm === 0 ? DISCARD : many;
    }
    const ref: number[] = [];
    for (let k = 0; k < len; k++) {
      let act = action[k];
      if (act === INVESTIGATE) act = cleanMmatch(action, k, len) ? DISCARD : KEEP;
      if (act === KEEP) ref.push(k + off); else ch[k + off] = 1;
    }
    return Int32Array.from(ref);
  };
  const r1 = refs(a, n1, dend1, len2, ch1);
  const r2 = refs(b, n2, dend2, len1, ch2);
  const h1 = Int32Array.from(r1, k => atOr(a, k, 0));
  const h2 = Int32Array.from(r2, k => atOr(b, k, 0));
  // xdl_do_diff (Myers part)
  const nreff1 = r1.length;
  const nreff2 = r2.length;
  const ndiags = nreff1 + nreff2 + 3;
  const kvd = new Float64Array(2 * ndiags + 2);
  const F = nreff2 + 1;
  const Bk = ndiags + nreff2 + 1;
  const mxcost = Math.max(bogosqrt(ndiags), MAX_COST_MIN);
  const kf = (d: number): number => atOr(kvd, F + d, 0);
  const kb = (d: number): number => atOr(kvd, Bk + d, 0);
  const setF = (d: number, v: number): void => { kvd[F + d] = v; };
  const setB = (d: number, v: number): void => { kvd[Bk + d] = v; };
  const split = (off1: number, lim1: number, off2: number, lim2: number, needMin: boolean): Split => {
    const dmin = off1 - lim2;
    const dmax = lim1 - off2;
    const fmid = off1 - off2;
    const bmid = lim1 - lim2;
    const odd = (fmid - bmid) & 1;
    let fmin = fmid;
    let fmax = fmid;
    let bmin = bmid;
    let bmax = bmid;
    setF(fmid, off1); setB(bmid, lim1);
    for (let ec = 1; ; ec++) {
      let gotSnake = false;
      let i1: number;
      let i2: number;
      let prev1: number;
      if (fmin > dmin) setF(--fmin - 1, -1); else ++fmin;
      if (fmax < dmax) setF(++fmax + 1, -1); else --fmax;
      for (let d = fmax; d >= fmin; d -= 2) {
        i1 = kf(d - 1) >= kf(d + 1) ? kf(d - 1) + 1 : kf(d + 1);
        prev1 = i1; i2 = i1 - d;
        for (; i1 < lim1 && i2 < lim2 && h1[i1] === h2[i2]; i1++, i2++);
        if (i1 - prev1 > SNAKE_CNT) gotSnake = true;
        setF(d, i1);
        if (odd && bmin <= d && d <= bmax && kb(d) <= i1) return { i1, i2, minLo: true, minHi: true };
      }
      if (bmin > dmin) setB(--bmin - 1, LINE_MAX); else ++bmin;
      if (bmax < dmax) setB(++bmax + 1, LINE_MAX); else --bmax;
      for (let d = bmax; d >= bmin; d -= 2) {
        i1 = kb(d - 1) < kb(d + 1) ? kb(d - 1) : kb(d + 1) - 1;
        prev1 = i1; i2 = i1 - d;
        for (; i1 > off1 && i2 > off2 && h1[i1 - 1] === h2[i2 - 1]; i1--, i2--);
        if (prev1 - i1 > SNAKE_CNT) gotSnake = true;
        setB(d, i1);
        if (!odd && fmin <= d && d <= fmax && i1 <= kf(d)) return { i1, i2, minLo: true, minHi: true };
      }
      if (needMin) continue;
      if (gotSnake && ec > HEUR_MIN_COST) {
        // spl is Some exactly when best > 0
        let best = 0;
        let spl: Option<{ readonly i1: number; readonly i2: number }> = none;
        for (let d = fmax; d >= fmin; d -= 2) {
          const dd = d > fmid ? d - fmid : fmid - d; i1 = kf(d); i2 = i1 - d;
          const v = (i1 - off1) + (i2 - off2) - dd;
          if (v > K_HEUR * ec && v > best && off1 + SNAKE_CNT <= i1 && i1 < lim1 && off2 + SNAKE_CNT <= i2 && i2 < lim2) {
            for (let k = 1; h1[i1 - k] === h2[i2 - k]; k++) if (k === SNAKE_CNT) { best = v; spl = some({ i1, i2 }); break; }
          }
        }
        if (spl.tag === 'some') return { ...spl.value, minLo: true, minHi: false };
        best = 0;
        for (let d = bmax; d >= bmin; d -= 2) {
          const dd = d > bmid ? d - bmid : bmid - d; i1 = kb(d); i2 = i1 - d;
          const v = (lim1 - i1) + (lim2 - i2) - dd;
          if (v > K_HEUR * ec && v > best && off1 < i1 && i1 <= lim1 - SNAKE_CNT && off2 < i2 && i2 <= lim2 - SNAKE_CNT) {
            for (let k = 0; h1[i1 + k] === h2[i2 + k]; k++) if (k === SNAKE_CNT - 1) { best = v; spl = some({ i1, i2 }); break; }
          }
        }
        if (spl.tag === 'some') return { ...spl.value, minLo: false, minHi: true };
      }
      if (ec >= mxcost) {
        let fbest = -1;
        let fbest1 = -1;
        let bbest = LINE_MAX;
        let bbest1 = LINE_MAX;
        for (let d = fmax; d >= fmin; d -= 2) {
          i1 = Math.min(kf(d), lim1); i2 = i1 - d;
          if (lim2 < i2) { i1 = lim2 + d; i2 = lim2; }
          if (fbest < i1 + i2) { fbest = i1 + i2; fbest1 = i1; }
        }
        for (let d = bmax; d >= bmin; d -= 2) {
          i1 = Math.max(off1, kb(d)); i2 = i1 - d;
          if (i2 < off2) { i1 = off2 + d; i2 = off2; }
          if (i1 + i2 < bbest) { bbest = i1 + i2; bbest1 = i1; }
        }
        if ((lim1 + lim2) - bbest < fbest - (off1 + off2)) return { i1: fbest1, i2: fbest - fbest1, minLo: true, minHi: false };
        return { i1: bbest1, i2: bbest - bbest1, minLo: false, minHi: true };
      }
    }
  };
  // xdl_recs_cmp, with an explicit stack (each box marks its own records; the k-vectors are scratch, reinitialized per split)
  const stack: Box[] = [[0, nreff1, 0, nreff2, false]];
  for (let top = popLast(stack); top.tag === 'some'; top = popLast(stack)) {
    const box = top.value;
    let [off1, lim1, off2, lim2] = box;
    for (; off1 < lim1 && off2 < lim2 && h1[off1] === h2[off2]; off1++, off2++);
    for (; off1 < lim1 && off2 < lim2 && h1[lim1 - 1] === h2[lim2 - 1]; lim1--, lim2--);
    if (off1 === lim1) { for (; off2 < lim2; off2++) ch2[atOr(r2, off2, 0)] = 1; }
    else if (off2 === lim2) { for (; off1 < lim1; off1++) ch1[atOr(r1, off1, 0)] = 1; }
    else {
      const spl = split(off1, lim1, off2, lim2, box[4]);
      stack.push([spl.i1, lim1, spl.i2, lim2, spl.minHi], [off1, spl.i1, off2, spl.i2, spl.minLo]);
    }
  }
  CH1.set(ch1, line1 - 1); CH2.set(ch2, line2 - 1);
}
/* oxlint-enable eslint/max-depth, eslint/complexity, eslint/max-params, eslint/no-param-reassign */

// ---- xhistogram.c: histogram_diff ----
// a, b: id arrays (0-based storage, 1-based line numbers as in C). Marks ch1 / ch2 (index = line - 1).
type Region = [line1: number, count1: number, line2: number, count2: number];
function histogramDiff(a: Int32Array, b: Int32Array, ch1: Uint8Array, ch2: Uint8Array): Diffed<null> {
  const stack: Region[] = [[1, a.length, 1, b.length]];
  for (let top = popLast(stack); top.tag === 'some'; top = popLast(stack)) {
    const [line1, count1, line2, count2] = top.value;
    if (count1 <= 0 && count2 <= 0) continue;
    if (!count1) { for (let i = 0; i < count2; i++) ch2[line2 - 1 + i] = 1; continue; }
    if (!count2) { for (let i = 0; i < count1; i++) ch1[line1 - 1 + i] = 1; continue; }
    const found = findLcs(a, b, line1, count1, line2, count2);
    switch (found.tag) {
      case 'chain-limit': return undecided('histogram hash chain limit (git fails this merge)');
      case 'fallback': classicDiff(a, b, line1, count1, line2, count2, ch1, ch2); continue; // fall_back_to_classic_diff
      case 'none': for (let i = 0; i < count1; i++) ch1[line1 - 1 + i] = 1; for (let i = 0; i < count2; i++) ch2[line2 - 1 + i] = 1; continue;
      case 'lcs': stack.push([found.end1 + 1, line1 + count1 - 1 - found.end1, found.end2 + 1, line2 + count2 - 1 - found.end2], [line1, found.begin1 - line1, line2, found.begin2 - line2]); continue;
    }
    // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
    return assertNever(found);
  }
  return DONE;
}

// ---- xdl_change_compact (no indent heuristic: merges do not set it) ----
// ch: Uint8Array of n+2 with ch[0] and ch[n+1] as the -1 / n sentinels; C index i ↔ ch[i + 1].
type Group = { start: number; end: number };
/* oxlint-disable eslint/max-params, eslint/no-param-reassign, eslint/complexity, eslint/max-depth -- a line-for-line port of xdiffi.c's xdl_change_compact and its group helpers, which advance the group in place */
export function compact(ids: Int32Array, ch: Uint8Array, n: number, idsO: Int32Array, chO: Uint8Array, nO: number, rediff: Rediff): Diffed<null> {
  const C = (i: number): boolean => ch[i + 1] === 1;
  const CO = (i: number): boolean => chO[i + 1] === 1;
  const set = (i: number, v: number): void => { ch[i + 1] = v ? 1 : 0; };
  const g: Group = { start: 0, end: 0 };
  const go: Group = { start: 0, end: 0 };
  const init = (G: Group, c: (i: number) => boolean): void => { G.start = G.end = 0; while (c(G.end)) G.end++; };
  const nextG = (G: Group, c: (i: number) => boolean, nn: number): boolean => { if (G.end === nn) return false; G.start = G.end + 1; for (G.end = G.start; c(G.end); G.end++); return true; };
  const prevG = (G: Group, c: (i: number) => boolean): boolean => { if (G.start === 0) return false; G.end = G.start - 1; for (G.start = G.end; c(G.start - 1); G.start--); return true; };
  const slideDown = (): boolean => { if (g.end < n && ids[g.start] === ids[g.end]) { set(g.start++, 0); set(g.end++, 1); while (C(g.end)) g.end++; return true; } return false; };
  const slideUp = (): boolean => { if (g.start > 0 && ids[g.start - 1] === ids[g.end - 1]) { set(--g.start, 1); set(--g.end, 0); while (C(g.start - 1)) g.start--; return true; } return false; };
  init(g, C); init(go, CO);
  for (;;) {
    if (g.end !== g.start) {
      const orig = { start: g.start, end: g.end };
      let groupsize: number;
      let earliestEnd: number;
      let endMatchingOther: number;
      do {
        groupsize = g.end - g.start;
        endMatchingOther = -1;
        while (slideUp()) if (!prevG(go, CO)) throw broken();
        earliestEnd = g.end;
        if (go.end > go.start) endMatchingOther = g.end;
        for (;;) {
          if (!slideDown()) break;
          if (!nextG(go, CO, nO)) throw broken();
          if (go.end > go.start) endMatchingOther = g.end;
        }
      } while (groupsize !== g.end - g.start);
      if (g.end === earliestEnd) { /* no shifting was possible */ }
      else if (endMatchingOther !== -1) {
        while (go.end === go.start) { if (!slideUp()) throw broken(); if (!prevG(go, CO)) throw broken(); }
      }
      // histogram: a moved group facing a non-empty group on the other side is re-diffed with classic Myers in git.
      // A JS caller's unknown rediff reads as 'skip', as it always has (blobMerger refuses one before this).
      if (go.end !== go.start && (g.start !== orig.start || g.end !== orig.end) && !applyRediff(rediff, () => { classicDiff(ids, idsO, g.start + 1, g.end - g.start, go.start + 1, go.end - go.start, ch.subarray(1), chO.subarray(1)); })) return undecided('compaction needs the classic-diff fallback');
    }
    if (!nextG(g, C, n)) return DONE;
    if (!nextG(go, CO, nO)) throw broken();
  }
}
/* oxlint-enable eslint/max-params, eslint/no-param-reassign, eslint/complexity, eslint/max-depth */

// ---- xdl_build_script: ascending list of { i1, i2, chg1, chg2 } (0-based) ----
function buildScript(ch1: Uint8Array, n1: number, ch2: Uint8Array, n2: number): Change[] {
  const c1 = (i: number): boolean => i >= 0 && i < n1 && ch1[i + 1] === 1;
  const c2 = (i: number): boolean => i >= 0 && i < n2 && ch2[i + 1] === 1;
  const out: Change[] = [];
  for (let i1 = n1, i2 = n2; i1 >= 0 || i2 >= 0; i1--, i2--) {
    if (c1(i1 - 1) || c2(i2 - 1)) {
      const l1 = i1;
      const l2 = i2;
      while (c1(i1 - 1)) i1--;
      while (c2(i2 - 1)) i2--;
      out.push({ i1, i2, chg1: l1 - i1, chg2: l2 - i2 });
    }
  }
  return out.toReversed();
}

// diff base → side as git's script (histogram + compaction both ways + build)
// rediff: git 2.54 (yc/histogram-hunk-shift-fix) re-diffs a shifted group facing a non-empty one with Myers in
// xdl_change_compact (histogram only). Both behaviors are git's; pick the one to match:
//   'myers' (default) — git ≥ 2.54 (verified against master, 2.56: every merge and every diff hunk agrees);
//   'skip'  — git < 2.54 (verified against 2.43: every case agrees);
//   'undecided' — conflict wherever the two differ: right against any version.
function diffWith(base: Lines, side: Lines, rediff: Rediff): Diffed<Change[]> {
  const n1 = base.n;
  const n2 = side.n;
  const h1 = new Uint8Array(n1);
  const h2 = new Uint8Array(n2);
  // git classifies per diff: class index 0, 1, … in first-occurrence order over file1 (base) then file2 (side). The
  // histogram's hash table is keyed on that index, so the chain limit below depends on it — renumber to match.
  const local = new Map<number, number>();
  const renum = (ids: ArrayLike<number>): Int32Array => Int32Array.from(ids, id => { const known = mapGet(local, id); if (known.tag === 'some') return known.value; const k = local.size; local.set(id, k); return k; });
  const a = renum(base.ids);
  const b = renum(side.ids);
  const ch1 = new Uint8Array(n1 + 2);
  const ch2 = new Uint8Array(n2 + 2);
  const h = histogramDiff(a, b, h1, h2); if (!h.ok) return h;
  ch1.set(h1, 1); ch2.set(h2, 1);
  const c1 = compact(a, ch1, n1, b, ch2, n2, rediff); if (!c1.ok) return c1;
  const c2 = compact(b, ch2, n2, a, ch1, n1, rediff); if (!c2.ok) return c2;
  return ok(buildScript(ch1, n1, ch2, n2));
}
export type DiffConfig = { readonly rediff: Rediff };
export function diffScript(base: Lines, side: Lines, options: Input<DiffConfig> = {}): Diffed<Change[]> {
  return diffWith(base, side, withDefaults<DiffConfig>(options, { rediff: 'myers' }).rediff);
}

// ---- xdl_do_merge + xdl_append_merge ----
// A hunk of the merge: a conflict, a change on one side only (ours / theirs), or a conflict whose two sides refine to the
// same lines (identical, git's mode 4). git's bitmask modes 0/1/2/4; its 3 (both, ours then theirs) exists only as
// merge=union's reading of a conflict, in fill.
export type HunkKind = 'conflict' | 'ours' | 'theirs' | 'identical';
// A hunk by its ours / theirs ranges; xdl_do_merge's hunks (Merged) also carry the base range, which refinement drops.
type Hunk = { kind: HunkKind; i1: number; chg1: number; i2: number; chg2: number };
type Merged = Hunk & { i0: number; chg0: number };
// oxlint-disable-next-line eslint/max-params -- xdl_append_merge's argument list
function appendMerge(list: Merged[], kind: HunkKind, i0: number, chg0: number, i1: number, chg1: number, i2: number, chg2: number): void {
  const m = list.at(-1);
  if (m && (i1 <= m.i1 + m.chg1 || i2 <= m.i2 + m.chg2)) {
    if (kind !== m.kind) m.kind = 'conflict';
    m.chg0 = i0 + chg0 - m.i0; m.chg1 = i1 + chg1 - m.i1; m.chg2 = i2 + chg2 - m.i2;
  } else list.push({ kind, i0, chg0, i1, chg1, i2, chg2 });
}
const sameLines = (A: Records, i: number, B: Records, j: number, n: number): boolean => { for (let k = 0; k < n; k++) if (A.ids[i + k] !== B.ids[j + k]) return false; return true; };

function doMerge(base: Records, ours: Records, theirs: Records, s1: readonly Change[], s2: readonly Change[]): Merged[] {
  const c: Merged[] = [];
  let x = 0;
  let y = 0;
  // a script holds no holes: a change is missing only past its end
  for (let a = s1[x], b = s2[y]; a && b; a = s1[x], b = s2[y]) {
    if (a.i1 + a.chg1 < b.i1) { appendMerge(c, 'ours', a.i1, a.chg1, a.i2, a.chg2, b.i2 - b.i1 + a.i1, a.chg1); x++; continue; }
    if (b.i1 + b.chg1 < a.i1) { appendMerge(c, 'theirs', b.i1, b.chg1, a.i2 - a.i1 + b.i1, b.chg1, b.i2, b.chg2); y++; continue; }
    if (a.i1 !== b.i1 || a.chg1 !== b.chg1 || a.chg2 !== b.chg2 || !sameLines(ours, a.i2, theirs, b.i2, a.chg2)) {
      const off = a.i1 - b.i1;
      const ffo = off + a.chg1 - b.chg1;
      let i0 = a.i1;
      let i1 = a.i2;
      let i2 = b.i2;
      if (off > 0) { i0 -= off; i1 -= off; } else i2 += off;
      let chg0 = a.i1 + a.chg1 - i0;
      let chg1 = a.i2 + a.chg2 - i1;
      let chg2 = b.i2 + b.chg2 - i2;
      if (ffo < 0) { chg0 -= ffo; chg1 -= ffo; } else chg2 += ffo;
      appendMerge(c, 'conflict', i0, chg0, i1, chg1, i2, chg2);
    }
    const e1 = a.i1 + a.chg1;
    const e2 = b.i1 + b.chg1;
    if (e1 >= e2) y++;
    if (e2 >= e1) x++;
  }
  for (const a of s1.slice(x)) appendMerge(c, 'ours', a.i1, a.chg1, a.i2, a.chg2, a.i1 + theirs.n - base.n, a.chg1);
  for (const b of s2.slice(y)) appendMerge(c, 'theirs', b.i1, b.chg1, b.i1 + ours.n - base.n, b.chg1, b.i2, b.chg2);
  return c;
}

// ---- xdl_refine_conflicts: re-diff each conflict's two sides (a fresh environment over just those lines, histogram +
// compaction both ways); identical sides resolve, otherwise the conflict becomes the script's hunks ----
function refine(ours: Records, theirs: Records, c: readonly Hunk[], rediff: Rediff): Diffed<Hunk[]> {
  const out: Hunk[] = [];
  for (const m of c) {
    if (m.kind !== 'conflict' || m.chg1 === 0 || m.chg2 === 0) { out.push(m); continue; }
    const sub = (F: Records, i: number, n: number): Lines => ({ ids: F.ids.slice(i, i + n), n });
    const script = diffWith(sub(ours, m.i1, m.chg1), sub(theirs, m.i2, m.chg2), rediff);
    if (!script.ok) return script;
    if (script.value.length === 0) { out.push({ ...m, kind: 'identical' }); continue; }
    for (const x of script.value.toSorted((p, q) => p.i1 - q.i1)) out.push({ kind: 'conflict', i1: x.i1 + m.i1, chg1: x.chg1, i2: x.i2 + m.i2, chg2: x.chg2 });
  }
  return ok(out);
}

// ---- xdl_simplify_non_conflicts (level ZEALOUS: fuse two conflicts at most 3 lines apart, the gap included) ----
function simplify(c: readonly Hunk[]): Hunk[] {
  const out: Hunk[] = [];
  for (const m of c) {
    const prev = out.at(-1);
    if (prev && prev.kind === 'conflict' && m.kind === 'conflict' && m.i1 - (prev.i1 + prev.chg1) <= 3) { prev.chg1 = m.i1 + m.chg1 - prev.i1; prev.chg2 = m.i2 + m.chg2 - prev.i2; }
    else out.push({ ...m });
  }
  return out;
}

// ---- xdl_fill_merge_buffer without conflict output: clean results, and merge=union (every conflict → ours then theirs) ----
// is_eol_crlf / is_cr_needed: a union hunk whose ours side ends without a newline gets one, CRLF if the files use CRLF.
// Record indexes here are in range: the 0 fallback only satisfies the index type.
function eolCrlf(F: Records, i: number): number {
  const size = (k: number): number => atOr(F.ends, k, 0) - atOr(F.starts, k, 0);
  // record k's byte `back` from its end (git: the byte at size - back); -1 before the file's start
  const last = (k: number, back: number): number => atOr(F.bytes, atOr(F.ends, k, 0) - back, -1);
  if (i < F.n - 1) return size(i) > 1 && last(i, 2) === 13 ? 1 : 0;
  if (!F.n) return -1;
  if (size(i) && last(i, 1) === 10) return size(i) > 1 && last(i, 2) === 13 ? 1 : 0;
  if (!i) return -1;
  return size(i - 1) > 1 && last(i - 1, 2) === 13 ? 1 : 0;
}
function crNeeded(base: Records, ours: Records, theirs: Records, m: Hunk): boolean {
  let r = eolCrlf(ours, m.i1 ? m.i1 - 1 : 0);
  if (r) r = eolCrlf(theirs, m.i2 ? m.i2 - 1 : 0);
  if (r) r = eolCrlf(base, 0);
  return r === 1;
}
// oxlint-disable-next-line eslint/max-params -- xdl_fill_merge_buffer's argument list
function fill(base: Records, ours: Records, theirs: Records, c: readonly Hunk[], union: boolean): Uint8Array {
  const parts: Uint8Array[] = []; let size = 0;
  const push = (b: Uint8Array): void => { parts.push(b); size += b.length; };
  // oxlint-disable-next-line eslint/max-params -- (file, first, count) and the two newline flags
  const copy = (F: Records, i: number, n: number, needsCr = false, addNl = false): void => {
    if (n < 1) return;
    const s = atOr(F.starts, i, 0);
    const e = atOr(F.ends, i + n - 1, 0);
    push(F.bytes.subarray(s, e));
    if (addNl && (e === s || F.bytes[e - 1] !== 10)) push(needsCr ? Uint8Array.of(13, 10) : Uint8Array.of(10));
  };
  let i = 0;
  for (const m of c) {
    // merge=union reads a conflict as both sides, ours then theirs (git's XDL_MERGE_FAVOR_UNION)
    const kind = union && m.kind === 'conflict' ? 'both' : m.kind;
    switch (kind) {
      // a clean text merge holds no conflict; identical sides are ours, copied with the unchanged lines after them
      case 'conflict': case 'identical': continue;
      case 'ours':
      case 'theirs':
      case 'both':
        copy(ours, i, m.i1 - i);
        if (kind !== 'theirs') copy(ours, m.i1, m.chg1, crNeeded(base, ours, theirs, m), kind === 'both');
        if (kind !== 'ours') copy(theirs, m.i2, m.chg2);
        i = m.i1 + m.chg1;
        continue;
    }
    // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
    return assertNever(kind);
  }
  copy(ours, i, ours.n - i);
  const out = new Uint8Array(size); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const declined = ({ detail }: Undecided): MergeLinesResult => ({ clean: false, reason: 'undecided', detail });
// The merge. `maxBytes` bounds each input (git's MAX_XDIFF_SIZE is ~1 GiB; a Worker's is much smaller).
// driver: 'text' (git's default) | 'union' (merge=union: conflicts resolve to ours then theirs) | 'binary' (merge=binary,
// -merge: any two-sided change is a conflict). Binary content (a NUL in the first 8000 bytes) is a conflict whatever the
// driver, as in ll_xdl_merge.
function mergeText({ driver, base, ours, theirs, maxBytes, rediff }: { readonly driver: 'text' | 'union'; readonly base: Uint8Array; readonly ours: Uint8Array; readonly theirs: Uint8Array; readonly maxBytes: number; readonly rediff: Rediff }): MergeLinesResult {
  if (Math.max(base.length, ours.length, theirs.length) > maxBytes) return { clean: false, reason: 'too large to merge' };
  if ([base, ours, theirs].some(f => isBinary(f))) return { clean: false, reason: 'binary' };
  const cl = classifier();
  const B = records(base, cl);
  const O = records(ours, cl);
  const T = records(theirs, cl);
  const s1 = diffWith(B, O, rediff); if (!s1.ok) return declined(s1.error);
  const s2 = diffWith(B, T, rediff); if (!s2.ok) return declined(s2.error);
  const hunks = { ours: s1.value.length, theirs: s2.value.length };
  if (hunks.ours === 0) return { clean: true, data: theirs, hunks };
  if (hunks.theirs === 0) return { clean: true, data: ours, hunks };
  const r = refine(O, T, doMerge(B, O, T, s1.value, s2.value), rediff); if (!r.ok) return declined(r.error);
  const c = simplify(r.value);
  const conflicts = c.filter(m => m.kind === 'conflict').length;
  switch (driver) {
    case 'text': return conflicts ? { clean: false, reason: 'content', conflicts } : { clean: true, data: fill(B, O, T, c, false), hunks };
    case 'union': return { clean: true, data: fill(B, O, T, c, true), hunks, ...(conflicts ? { unioned: conflicts } : {}) };
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(driver);
}
export type MergeLinesConfig = { readonly maxBytes: number; readonly rediff: Rediff; readonly driver: Driver };
export function mergeLines(base: Uint8Array, ours: Uint8Array, theirs: Uint8Array, options: Input<MergeLinesConfig> = {}): MergeLinesResult {
  const { maxBytes, rediff, driver } = withDefaults<MergeLinesConfig>(options, { maxBytes: LIMIT_MERGE_BLOB, rediff: 'myers', driver: 'text' });
  switch (driver) {
    case 'binary': return { clean: false, reason: 'binary (merge attribute)' };
    case 'text':
    case 'union': return mergeText({ driver, base, ours, theirs, maxBytes, rediff });
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(driver);
}
