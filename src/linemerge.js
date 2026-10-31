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

import { LIMIT_MERGE_BLOB } from './limits.js';

const BINARY_SNIFF = 8000; // git's FIRST_FEW_BYTES: a NUL in the first 8000 bytes makes the merge binary (= conflict)
const MAX_CHAIN = 64;      // xhistogram.c max_chain_length

export const isBinary = bytes => { const n = Math.min(bytes.length, BINARY_SNIFF); for (let i = 0; i < n; i++) if (bytes[i] === 0) return true; return false; };

// Records: [start, end) byte offsets per line. Ids come from one classifier shared by all files of a merge, so id equality
// is content equality (git's minimal_perfect_hash).
export function records(bytes, classify) {
  const starts = [], ends = [], ids = [];
  let p = 0;
  while (p < bytes.length) {
    let e = bytes.indexOf(0x0a, p); e = e < 0 ? bytes.length : e + 1;
    starts.push(p); ends.push(e); ids.push(classify(bytes, p, e)); p = e;
  }
  return { bytes, starts, ends, ids, n: ids.length };
}
export function classifier() {
  const map = new Map();
  return (bytes, s, e) => {
    let key = ''; for (let i = s; i < e; i += 8192) key += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(e, i + 8192)));
    let id = map.get(key); if (id === undefined) { id = map.size + 1; map.set(key, id); } return id;
  };
}

// Thrown (not an Error: no stack to build) where we decline to answer: rediff 'undecided', or the hash-chain limit.
const undecided = detail => ({ undecided: true, detail });

// ---- xhistogram.c ----
// a, b: id arrays (0-based storage, 1-based line numbers as in C). Marks ch1 / ch2 (index = line - 1).
function histogramDiff(a, b, ch1, ch2) {
  const stack = [[1, a.length, 1, b.length]];
  while (stack.length) {
    const [line1, count1, line2, count2] = stack.pop();
    if (count1 <= 0 && count2 <= 0) continue;
    if (!count1) { for (let i = 0; i < count2; i++) ch2[line2 - 1 + i] = 1; continue; }
    if (!count2) { for (let i = 0; i < count1; i++) ch1[line1 - 1 + i] = 1; continue; }
    const { found, fallback, lcs } = findLcs(a, b, line1, count1, line2, count2);
    if (fallback) { classicDiff(a, b, line1, count1, line2, count2, ch1, ch2); continue; } // fall_back_to_classic_diff
    if (!found) { for (let i = 0; i < count1; i++) ch1[line1 - 1 + i] = 1; for (let i = 0; i < count2; i++) ch2[line2 - 1 + i] = 1; continue; }
    const end1 = line1 + count1 - 1, end2 = line2 + count2 - 1;
    stack.push([lcs.end1 + 1, end1 - lcs.end1, lcs.end2 + 1, end2 - lcs.end2]);
    stack.push([line1, lcs.begin1 - line1, line2, lcs.begin2 - line2]);
  }
}

function findLcs(a, b, line1, count1, line2, count2) {
  const END1 = line1 + count1 - 1, END2 = line2 + count2 - 1;
  const recs = new Map(); // id → { ptr, cnt }  (scanA: ptr = first occurrence, NEXT_PTR chains forward)
  const lineMap = new Array(count1), next = new Int32Array(count1);
  for (let ptr = END1; ptr >= line1; ptr--) {
    const id = a[ptr - 1];
    const rec = recs.get(id);
    if (rec) { next[ptr - line1] = rec.ptr; rec.ptr = ptr; rec.cnt = rec.cnt + 1; lineMap[ptr - line1] = rec; }
    else { const r = { ptr, cnt: 1 }; recs.set(id, r); lineMap[ptr - line1] = r; }
  }
  // scanA's other way out: a new distinct line landing in a hash bucket that already chains 64 distinct records makes
  // find_lcs fail (-1) and git's merge fail — never clean. Bucket = XDL_HASHLONG(class index, xdl_hashbits(count1)).
  if (recs.size > MAX_CHAIN) {
    let bits = 0; for (let v = 1; v < count1 && bits < 32; v *= 2) bits++; bits = bits || 1;
    const mask = 2 ** bits - 1, load = new Map();
    for (const id of recs.keys()) { const h = (id + Math.floor(id / 2 ** bits)) & mask; const l = (load.get(h) ?? 0) + 1; if (l > MAX_CHAIN) throw undecided('histogram hash chain limit (git fails this merge)'); load.set(h, l); }
  }
  const CNT = ptr => lineMap[ptr - line1].cnt;
  const NEXT = ptr => next[ptr - line1];
  const lcs = { begin1: 0, end1: 0, begin2: 0, end2: 0 };
  let cnt = MAX_CHAIN + 1, hasCommon = false;
  for (let bPtr = line2; bPtr <= END2;) {
    let bNext = bPtr + 1;
    const rec = recs.get(b[bPtr - 1]);
    if (rec) {
      if (rec.cnt > cnt) { hasCommon = true; }
      else {
        hasCommon = true;
        let as = rec.ptr;
        for (;;) {
          const np0 = NEXT(as);
          let bs = bPtr, ae = as, be = bs, rc = rec.cnt;
          while (line1 < as && line2 < bs && a[as - 2] === b[bs - 2]) { as--; bs--; if (1 < rc) rc = Math.min(rc, CNT(as)); }
          while (ae < END1 && be < END2 && a[ae] === b[be]) { ae++; be++; if (1 < rc) rc = Math.min(rc, CNT(ae)); }
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
  if (hasCommon && MAX_CHAIN < cnt) return { found: false, fallback: true, lcs };
  return { found: !(lcs.begin1 === 0 && lcs.begin2 === 0), fallback: false, lcs };
}

// ---- the classic diff, as xdl_fall_back_diff runs it on a histogram region: a fresh xdl_do_diff over the two line ranges
// with Myers — xprepare.c's xdl_trim_ends + xdl_cleanup_records (discarding lines with no match, and multi-match lines
// amid runs of them), then xdiffi.c's xdl_recs_cmp / xdl_split with git's heuristics (need_min off: merges do not set
// XDF_NEED_MINIMAL). Ids only need equality; class counts are per sub-range, as in the fresh environment.
const bogosqrt = n => { let i = 1; for (; n > 0; n = Math.floor(n / 4)) i *= 2; return i; };
const SNAKE_CNT = 20, HEUR_MIN_COST = 256, MAX_COST_MIN = 256, K_HEUR = 4, MAX_EQLIMIT = 1024, SIMSCAN_WINDOW = 100, KPDIS_RUN = 4;
const LINE_MAX = Number.MAX_SAFE_INTEGER;
const DISCARD = 0, KEEP = 1, INVESTIGATE = 2;

function cleanMmatch(action, i, len) {
  let s = 0, e = len - 1;
  if (i - s > SIMSCAN_WINDOW) s = i - SIMSCAN_WINDOW;
  if (e - i > SIMSCAN_WINDOW) e = i + SIMSCAN_WINDOW;
  let r, rdis0 = 0, rpdis0 = 1, rdis1 = 0, rpdis1 = 1;
  for (r = 1; i - r >= s; r++) { const x = action[i - r]; if (x === DISCARD) rdis0++; else if (x === INVESTIGATE) rpdis0++; else break; }
  if (rdis0 === 0) return false;
  for (r = 1; i + r <= e; r++) { const x = action[i + r]; if (x === DISCARD) rdis1++; else if (x === INVESTIGATE) rpdis1++; else break; }
  if (rdis1 === 0) return false;
  rdis1 += rdis0; rpdis1 += rpdis0;
  return rpdis1 * KPDIS_RUN < rpdis1 + rdis1;
}

export function classicDiff(A, B, line1, count1, line2, count2, CH1, CH2) {
  const a = A.subarray(line1 - 1, line1 - 1 + count1), b = B.subarray(line2 - 1, line2 - 1 + count2);
  const n1 = a.length, n2 = b.length, ch1 = new Uint8Array(n1), ch2 = new Uint8Array(n2);
  const len1 = new Map(), len2 = new Map();
  for (const x of a) len1.set(x, (len1.get(x) ?? 0) + 1);
  for (const x of b) len2.set(x, (len2.get(x) ?? 0) + 1);
  // xdl_trim_ends
  let i = 0, lim = Math.min(n1, n2);
  for (; i < lim; i++) if (a[i] !== b[i]) break;
  const off = i; lim -= i;
  for (i = 0; i < lim; i++) if (a[n1 - 1 - i] !== b[n2 - 1 - i]) break;
  const dend1 = n1 - i - 1, dend2 = n2 - i - 1;
  // xdl_cleanup_records
  const refs = (x, n, dend, other, ch) => {
    const len = dend - off + 1, mlim = Math.min(bogosqrt(n), MAX_EQLIMIT), action = new Uint8Array(Math.max(len, 0));
    for (let k = 0; k < len; k++) { const nm = other.get(x[k + off]) ?? 0; action[k] = nm === 0 ? DISCARD : nm < mlim ? KEEP : INVESTIGATE; }
    const ref = [];
    for (let k = 0; k < len; k++) {
      let act = action[k];
      if (act === INVESTIGATE) act = cleanMmatch(action, k, len) ? DISCARD : KEEP;
      if (act === KEEP) ref.push(k + off); else ch[k + off] = 1;
    }
    return Int32Array.from(ref);
  };
  const r1 = refs(a, n1, dend1, len2, ch1), r2 = refs(b, n2, dend2, len1, ch2);
  const h1 = Int32Array.from(r1, k => a[k]), h2 = Int32Array.from(r2, k => b[k]);
  // xdl_do_diff (Myers part)
  const nreff1 = r1.length, nreff2 = r2.length, ndiags = nreff1 + nreff2 + 3;
  const kvd = new Float64Array(2 * ndiags + 2), F = nreff2 + 1, Bk = ndiags + nreff2 + 1;
  const mxcost = Math.max(bogosqrt(ndiags), MAX_COST_MIN);
  const split = (off1, lim1, off2, lim2, needMin) => {
    const dmin = off1 - lim2, dmax = lim1 - off2, fmid = off1 - off2, bmid = lim1 - lim2, odd = (fmid - bmid) & 1;
    let fmin = fmid, fmax = fmid, bmin = bmid, bmax = bmid;
    const kf = d => kvd[F + d], kb = d => kvd[Bk + d], setF = (d, v) => { kvd[F + d] = v; }, setB = (d, v) => { kvd[Bk + d] = v; };
    setF(fmid, off1); setB(bmid, lim1);
    for (let ec = 1; ; ec++) {
      let gotSnake = false, i1, i2, prev1;
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
        let best = 0, spl = null;
        for (let d = fmax; d >= fmin; d -= 2) {
          const dd = d > fmid ? d - fmid : fmid - d; i1 = kf(d); i2 = i1 - d;
          const v = (i1 - off1) + (i2 - off2) - dd;
          if (v > K_HEUR * ec && v > best && off1 + SNAKE_CNT <= i1 && i1 < lim1 && off2 + SNAKE_CNT <= i2 && i2 < lim2) {
            for (let k = 1; h1[i1 - k] === h2[i2 - k]; k++) if (k === SNAKE_CNT) { best = v; spl = { i1, i2 }; break; }
          }
        }
        if (best > 0) return { ...spl, minLo: true, minHi: false };
        best = 0;
        for (let d = bmax; d >= bmin; d -= 2) {
          const dd = d > bmid ? d - bmid : bmid - d; i1 = kb(d); i2 = i1 - d;
          const v = (lim1 - i1) + (lim2 - i2) - dd;
          if (v > K_HEUR * ec && v > best && off1 < i1 && i1 <= lim1 - SNAKE_CNT && off2 < i2 && i2 <= lim2 - SNAKE_CNT) {
            for (let k = 0; h1[i1 + k] === h2[i2 + k]; k++) if (k === SNAKE_CNT - 1) { best = v; spl = { i1, i2 }; break; }
          }
        }
        if (best > 0) return { ...spl, minLo: false, minHi: true };
      }
      if (ec >= mxcost) {
        let fbest = -1, fbest1 = -1, bbest = LINE_MAX, bbest1 = LINE_MAX;
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
  const stack = [[0, nreff1, 0, nreff2, false]];
  while (stack.length) {
    let [off1, lim1, off2, lim2, needMin] = stack.pop();
    for (; off1 < lim1 && off2 < lim2 && h1[off1] === h2[off2]; off1++, off2++);
    for (; off1 < lim1 && off2 < lim2 && h1[lim1 - 1] === h2[lim2 - 1]; lim1--, lim2--);
    if (off1 === lim1) { for (; off2 < lim2; off2++) ch2[r2[off2]] = 1; }
    else if (off2 === lim2) { for (; off1 < lim1; off1++) ch1[r1[off1]] = 1; }
    else {
      const spl = split(off1, lim1, off2, lim2, needMin);
      stack.push([spl.i1, lim1, spl.i2, lim2, spl.minHi], [off1, spl.i1, off2, spl.i2, spl.minLo]);
    }
  }
  CH1.set(ch1, line1 - 1); CH2.set(ch2, line2 - 1);
}

// ---- xdl_change_compact (no indent heuristic: merges do not set it) ----
// ch: Uint8Array of n+2 with ch[0] and ch[n+1] as the -1 / n sentinels; C index i ↔ ch[i + 1].
function compact(ids, ch, n, idsO, chO, nO, rediff) {
  const C = i => ch[i + 1] === 1, CO = i => chO[i + 1] === 1;
  const set = (i, v) => { ch[i + 1] = v ? 1 : 0; };
  const g = { start: 0, end: 0 }, go = { start: 0, end: 0 };
  const init = (G, c) => { G.start = G.end = 0; while (c(G.end)) G.end++; };
  const nextG = (G, c, nn) => { if (G.end === nn) return false; G.start = G.end + 1; for (G.end = G.start; c(G.end); G.end++); return true; };
  const prevG = (G, c) => { if (G.start === 0) return false; G.end = G.start - 1; for (G.start = G.end; c(G.start - 1); G.start--); return true; };
  const slideDown = () => { if (g.end < n && ids[g.start] === ids[g.end]) { set(g.start++, 0); set(g.end++, 1); while (C(g.end)) g.end++; return true; } return false; };
  const slideUp = () => { if (g.start > 0 && ids[g.start - 1] === ids[g.end - 1]) { set(--g.start, 1); set(--g.end, 0); while (C(g.start - 1)) g.start--; return true; } return false; };
  init(g, C); init(go, CO);
  for (;;) {
    if (g.end !== g.start) {
      const orig = { start: g.start, end: g.end };
      let groupsize, earliestEnd, endMatchingOther;
      do {
        groupsize = g.end - g.start;
        endMatchingOther = -1;
        while (slideUp()) if (!prevG(go, CO)) throw new Error('internal: group sync broken sliding up');
        earliestEnd = g.end;
        if (go.end > go.start) endMatchingOther = g.end;
        for (;;) {
          if (!slideDown()) break;
          if (!nextG(go, CO, nO)) throw new Error('internal: group sync broken sliding down');
          if (go.end > go.start) endMatchingOther = g.end;
        }
      } while (groupsize !== g.end - g.start);
      if (g.end === earliestEnd) { /* no shifting was possible */ }
      else if (endMatchingOther !== -1) {
        while (go.end === go.start) { if (!slideUp()) throw new Error('internal: match disappeared'); if (!prevG(go, CO)) throw new Error('internal: group sync broken sliding to match'); }
      }
      // histogram: a moved group facing a non-empty group on the other side is re-diffed with classic Myers in git
      if (go.end !== go.start && (g.start !== orig.start || g.end !== orig.end)) {
        if (rediff === 'undecided') throw undecided('compaction needs the classic-diff fallback');
        // newer git: re-diff the merged group against the facing one with Myers (xdl_fall_back_diff on the two ranges)
        else if (rediff === 'myers') classicDiff(ids, idsO, g.start + 1, g.end - g.start, go.start + 1, go.end - go.start, ch.subarray(1), chO.subarray(1));
      }
    }
    if (!nextG(g, C, n)) break;
    if (!nextG(go, CO, nO)) throw new Error('internal: group sync broken moving to next group');
  }
}

// ---- xdl_build_script: ascending list of { i1, i2, chg1, chg2 } (0-based) ----
function buildScript(ch1, n1, ch2, n2) {
  const c1 = i => i >= 0 && i < n1 && ch1[i + 1] === 1, c2 = i => i >= 0 && i < n2 && ch2[i + 1] === 1;
  const out = [];
  for (let i1 = n1, i2 = n2; i1 >= 0 || i2 >= 0; i1--, i2--) {
    if (c1(i1 - 1) || c2(i2 - 1)) {
      const l1 = i1, l2 = i2;
      while (c1(i1 - 1)) i1--;
      while (c2(i2 - 1)) i2--;
      out.push({ i1, i2, chg1: l1 - i1, chg2: l2 - i2 });
    }
  }
  return out.reverse();
}

// diff base → side as git's script (histogram + compaction both ways + build)
// rediff: git 2.54 (yc/histogram-hunk-shift-fix) re-diffs a shifted group facing a non-empty one with Myers in
// xdl_change_compact (histogram only). Both behaviors are git's; pick the one to match:
//   'myers' (default) — git ≥ 2.54 (verified against master, 2.56: every merge and every diff hunk agrees);
//   'skip'  — git < 2.54 (verified against 2.43: every case agrees);
//   'undecided' — conflict wherever the two differ: right against any version.
export function diffScript(base, side, { rediff = 'myers' } = {}) {
  const n1 = base.n, n2 = side.n;
  const h1 = new Uint8Array(n1), h2 = new Uint8Array(n2);
  // git classifies per diff: class index 0, 1, … in first-occurrence order over file1 (base) then file2 (side). The
  // histogram's hash table is keyed on that index, so the chain limit below depends on it — renumber to match.
  const local = new Map(), renum = ids => Int32Array.from(ids, id => { let k = local.get(id); if (k === undefined) { k = local.size; local.set(id, k); } return k; });
  const a = renum(base.ids), b = renum(side.ids);
  histogramDiff(a, b, h1, h2);
  const ch1 = new Uint8Array(n1 + 2), ch2 = new Uint8Array(n2 + 2);
  ch1.set(h1, 1); ch2.set(h2, 1);
  compact(a, ch1, n1, b, ch2, n2, rediff);
  compact(b, ch2, n2, a, ch1, n1, rediff);
  return buildScript(ch1, n1, ch2, n2);
}

// ---- xdl_do_merge + xdl_append_merge (modes: 0 conflict, 1 ours, 2 theirs, 4 identical-resolved) ----
function appendMerge(list, mode, i0, chg0, i1, chg1, i2, chg2) {
  const m = list[list.length - 1];
  if (m && (i1 <= m.i1 + m.chg1 || i2 <= m.i2 + m.chg2)) {
    if (mode !== m.mode) m.mode = 0;
    m.chg0 = i0 + chg0 - m.i0; m.chg1 = i1 + chg1 - m.i1; m.chg2 = i2 + chg2 - m.i2;
  } else list.push({ mode, i0, chg0, i1, chg1, i2, chg2 });
}
const sameLines = (A, i, B, j, n) => { for (let k = 0; k < n; k++) if (A.ids[i + k] !== B.ids[j + k]) return false; return true; };

function doMerge(base, ours, theirs, s1, s2) {
  const c = [];
  let x = 0, y = 0;
  while (x < s1.length && y < s2.length) {
    const a = s1[x], b = s2[y];
    if (a.i1 + a.chg1 < b.i1) { appendMerge(c, 1, a.i1, a.chg1, a.i2, a.chg2, b.i2 - b.i1 + a.i1, a.chg1); x++; continue; }
    if (b.i1 + b.chg1 < a.i1) { appendMerge(c, 2, b.i1, b.chg1, a.i2 - a.i1 + b.i1, b.chg1, b.i2, b.chg2); y++; continue; }
    if (a.i1 !== b.i1 || a.chg1 !== b.chg1 || a.chg2 !== b.chg2 || !sameLines(ours, a.i2, theirs, b.i2, a.chg2)) {
      const off = a.i1 - b.i1, ffo = off + a.chg1 - b.chg1;
      let i0 = a.i1, i1 = a.i2, i2 = b.i2;
      if (off > 0) { i0 -= off; i1 -= off; } else i2 += off;
      let chg0 = a.i1 + a.chg1 - i0, chg1 = a.i2 + a.chg2 - i1, chg2 = b.i2 + b.chg2 - i2;
      if (ffo < 0) { chg0 -= ffo; chg1 -= ffo; } else chg2 += ffo;
      appendMerge(c, 0, i0, chg0, i1, chg1, i2, chg2);
    }
    const e1 = a.i1 + a.chg1, e2 = b.i1 + b.chg1;
    if (e1 >= e2) y++;
    if (e2 >= e1) x++;
  }
  for (; x < s1.length; x++) { const a = s1[x]; appendMerge(c, 1, a.i1, a.chg1, a.i2, a.chg2, a.i1 + theirs.n - base.n, a.chg1); }
  for (; y < s2.length; y++) { const b = s2[y]; appendMerge(c, 2, b.i1, b.chg1, b.i1 + ours.n - base.n, b.chg1, b.i2, b.chg2); }
  return c;
}

// ---- xdl_refine_conflicts: re-diff each conflict's two sides (a fresh environment over just those lines, histogram +
// compaction both ways); identical sides resolve (mode 4), otherwise the conflict becomes the script's hunks ----
function refine(ours, theirs, c, rediff) {
  const out = [];
  for (const m of c) {
    if (m.mode !== 0 || m.chg1 === 0 || m.chg2 === 0) { out.push(m); continue; }
    const sub = (F, i, n) => ({ ids: F.ids.slice(i, i + n), n });
    const script = diffScript(sub(ours, m.i1, m.chg1), sub(theirs, m.i2, m.chg2), { rediff }).sort((p, q) => p.i1 - q.i1);
    if (!script.length) { out.push({ ...m, mode: 4 }); continue; }
    for (const x of script) out.push({ mode: 0, i1: x.i1 + m.i1, chg1: x.chg1, i2: x.i2 + m.i2, chg2: x.chg2 });
  }
  return out;
}

// ---- xdl_simplify_non_conflicts (level ZEALOUS: fuse two conflicts at most 3 lines apart, the gap included) ----
function simplify(c) {
  const out = [];
  for (const m of c) {
    const prev = out[out.length - 1];
    if (prev && prev.mode === 0 && m.mode === 0 && m.i1 - (prev.i1 + prev.chg1) <= 3) { prev.chg1 = m.i1 + m.chg1 - prev.i1; prev.chg2 = m.i2 + m.chg2 - prev.i2; }
    else out.push({ ...m });
  }
  return out;
}

// ---- xdl_fill_merge_buffer without conflict output: clean results, and merge=union (every conflict → ours then theirs) ----
// is_eol_crlf / is_cr_needed: a union hunk whose ours side ends without a newline gets one, CRLF if the files use CRLF.
function eolCrlf(F, i) {
  const size = k => F.ends[k] - F.starts[k], byte = (k, off) => F.bytes[F.starts[k] + off];
  if (i < F.n - 1) return size(i) > 1 && byte(i, size(i) - 2) === 13 ? 1 : 0;
  if (!F.n) return -1;
  if (size(i) && byte(i, size(i) - 1) === 10) return size(i) > 1 && byte(i, size(i) - 2) === 13 ? 1 : 0;
  if (!i) return -1;
  return size(i - 1) > 1 && byte(i - 1, size(i - 1) - 2) === 13 ? 1 : 0;
}
function crNeeded(base, ours, theirs, m) {
  let r = eolCrlf(ours, m.i1 ? m.i1 - 1 : 0);
  if (r) r = eolCrlf(theirs, m.i2 ? m.i2 - 1 : 0);
  if (r) r = eolCrlf(base, 0);
  return r === 1;
}
function fill(base, ours, theirs, c, favor = 0) {
  const parts = []; let size = 0;
  const push = b => { parts.push(b); size += b.length; };
  const copy = (F, i, n, needsCr = false, addNl = false) => {
    if (n < 1) return;
    const s = F.starts[i], e = F.ends[i + n - 1]; push(F.bytes.subarray(s, e));
    if (addNl && (e === s || F.bytes[e - 1] !== 10)) push(needsCr ? Uint8Array.of(13, 10) : Uint8Array.of(10));
  };
  let i = 0;
  for (const m0 of c) {
    const mode = favor && !m0.mode ? favor : m0.mode;
    if (mode & 3) {
      copy(ours, i, m0.i1 - i);
      if (mode & 1) copy(ours, m0.i1, m0.chg1, crNeeded(base, ours, theirs, m0), (mode & 2) !== 0);
      if (mode & 2) copy(theirs, m0.i2, m0.chg2);
    } else continue;
    i = m0.i1 + m0.chg1;
  }
  copy(ours, i, ours.n - i);
  const out = new Uint8Array(size); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// The merge. `maxBytes` bounds each input (git's MAX_XDIFF_SIZE is ~1 GiB; a Worker's is much smaller).
// driver: 'text' (git's default) | 'union' (merge=union: conflicts resolve to ours then theirs) | 'binary' (merge=binary,
// -merge: any two-sided change is a conflict). Binary content (a NUL in the first 8000 bytes) is a conflict whatever the
// driver, as in ll_xdl_merge.
export function mergeLines(base, ours, theirs, { maxBytes = LIMIT_MERGE_BLOB, rediff = 'myers', driver = 'text' } = {}) {
  if (driver === 'binary') return { clean: false, reason: 'binary (merge attribute)' };
  if (base.length > maxBytes || ours.length > maxBytes || theirs.length > maxBytes) return { clean: false, reason: 'too large to merge' };
  if (isBinary(base) || isBinary(ours) || isBinary(theirs)) return { clean: false, reason: 'binary' };
  const cl = classifier();
  const B = records(base, cl), O = records(ours, cl), T = records(theirs, cl);
  try {
    const s1 = diffScript(B, O, { rediff }), s2 = diffScript(B, T, { rediff });
    if (!s1.length) return { clean: true, data: theirs, hunks: { ours: 0, theirs: s2.length } };
    if (!s2.length) return { clean: true, data: ours, hunks: { ours: s1.length, theirs: 0 } };
    const c = simplify(refine(O, T, doMerge(B, O, T, s1, s2), rediff));
    const conflicts = c.filter(m => m.mode === 0).length;
    if (conflicts && driver !== 'union') return { clean: false, reason: 'content', conflicts };
    return { clean: true, data: fill(B, O, T, c, driver === 'union' ? 3 : 0), hunks: { ours: s1.length, theirs: s2.length }, ...(conflicts ? { unioned: conflicts } : {}) };
  } catch (e) { if (e?.undecided === true) return { clean: false, reason: 'undecided', detail: e.detail }; throw e; }
}
