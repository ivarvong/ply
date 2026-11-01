// describePack against packs git wrote. One cell is one pack (the product) or one limit probe on the representative.
// Window is not an axis: it equals depth, so a depth of 50 can actually chain, and 0 stays a non-delta pack.
export const CONTENTS = ['blob', 'commit', 'tag', 'history', 'fan'];
export const COMPRESSION = [0, 9];
export const OFS = [false, true];
export const DEPTH = [0, 1, 50];
export const THIN = [false, true];
// The five caps parse/resolve read, each at its boundary and one past it, plus a NaN cap and a missing cap.
export const LIMIT_NAMES = ['maxPackObjects', 'maxObjectSize', 'maxInflatedTotal', 'maxDeltaChain', 'maxDeltaResult'];
export const PACK_CELLS = CONTENTS.length * COMPRESSION.length * OFS.length * DEPTH.length * THIN.length;
export const LIMIT_PROBES = LIMIT_NAMES.length * 2 + 2;
export const CELL_COUNT = PACK_CELLS + LIMIT_PROBES;
// history, tight compression, OFS, the deep window: the pack the limit probes reuse. It is also one of the 120.
export const REPRESENTATIVE = { content: 'history', compression: 9, ofs: true, depth: 50, thin: false };
