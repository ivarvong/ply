// The pulls from the package entry (#172): the inflate pull, the pack-scan pull and sidebandStep, with their types,
// driven the way a consumer drives them, with no casts. `tsc --noEmit` must pass; every @ts-expect-error must still be an error.
import {
  inflateInit, inflateFeed, inflatePull, inflateEnd, inflateUnread, declaredBound, cappedBound, zlibWrap, rawWrap,
  parsePackInit, parsePackFeed, parsePackPull, parsePackEnd, packScanOpts, sidebandStep, v2Init, DEFAULT_LIMITS, WORK_BUDGET, workBudget,
  type InflateStream, type InflatePiece, type InflateStats, type PackScan, type PackPiece, type ObjBase, type Oid,
  type SidebandPiece,
} from '../../src/index.js';

declare const bytes: Uint8Array;

const opened = inflateInit({ bound: declaredBound(3), wrap: zlibWrap(true) });
if (opened.ok) {
  const st: InflateStream = opened.value;
  inflateFeed(st, bytes);
  const r = inflatePull(st);
  if (r.ok) {
    const piece: InflatePiece = r.value;
    switch (piece.kind) {
      case 'need': break;
      case 'chunk': { const b: Uint8Array = piece.bytes; void b; break; }
      case 'end': { const n: number = piece.consumed; const s: InflateStats = piece.stats; void n; void s; break; }
    }
  } else {
    const code: 'pack_corrupt' | 'limit_exceeded' | 'bad_request' = r.error.code;
    void code;
  }
  void inflateEnd(st); void inflateUnread(st);
}
void inflateInit({ bound: cappedBound(1024), wrap: rawWrap() });
// @ts-expect-error a bound is built by declaredBound or cappedBound, not a bare number
void inflateInit({ bound: 3, wrap: zlibWrap(true) });

const scanned = parsePackInit(packScanOpts(DEFAULT_LIMITS));
if (scanned.ok) {
  const st: PackScan = scanned.value;
  parsePackFeed(st, bytes);
  const r = parsePackPull(st);
  if (r.ok) {
    const piece: PackPiece = r.value;
    if (piece.kind === 'object') {
      const base: ObjBase = piece.base;
      if (base.tag === 'ref') { const id: Oid = base.oid; void id; }
      const size: number = piece.size;
      void size;
    }
  }
  void parsePackEnd(st);
}

void parsePackInit(packScanOpts(DEFAULT_LIMITS, true, WORK_BUDGET));
void parsePackInit(packScanOpts(DEFAULT_LIMITS, true, workBudget(8, true)));
void parsePackInit({ verify: true, limits: DEFAULT_LIMITS });
// @ts-expect-error a budget is built by workBudget or named by a preset, not a bare ratio
void parsePackInit(packScanOpts(DEFAULT_LIMITS, true, 32));

const sb = sidebandStep(v2Init(), { kind: 'data', payload: bytes }, 1024);
if (sb.ok) { const p: SidebandPiece = sb.value.piece; if (p.kind === 'pack') { const b: Uint8Array = p.body; void b; } }
