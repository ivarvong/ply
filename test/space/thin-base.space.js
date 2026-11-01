// A thin pack's external REF base (#143). The base oid names one object git stored, and the hash header is
// `type SP size NUL body`, so the type is part of the oid. Axes:
//   base   the object git wrote and the pack deltas against: blob, tree, commit, tag
//   claim  the type the caller hands external(): the four stored types, the two delta types, 0, and 5
//   bytes  those exact bytes, or the same bytes with the last byte flipped
// Honest is claim === base and bytes exact. Every other cell is a buffer git would not store under that oid.
export const BASES = [
  { tag: 'blob', type: 3, name: 'blob' },
  { tag: 'tree', type: 2, name: 'tree' },
  { tag: 'commit', type: 1, name: 'commit' },
  { tag: 'tag', type: 4, name: 'tag' },
];

// git hash-object -t accepts the four stored names and refuses the rest (no --literally).
export const CLAIMS = [
  { tag: 'commit', type: 1, name: 'commit', stored: true },
  { tag: 'tree', type: 2, name: 'tree', stored: true },
  { tag: 'blob', type: 3, name: 'blob', stored: true },
  { tag: 'tag', type: 4, name: 'tag', stored: true },
  { tag: 'ofs_delta', type: 6, name: 'ofs_delta', stored: false },
  { tag: 'ref_delta', type: 7, name: 'ref_delta', stored: false },
  { tag: 'none', type: 0, name: '0', stored: false },
  { tag: 'reserved', type: 5, name: '5', stored: false },
];

export const BYTE_FORMS = [
  { tag: 'exact' },
  { tag: 'flipped' },
];

export function cells() {
  const out = [];
  for (const base of BASES) for (const claim of CLAIMS) for (const bytes of BYTE_FORMS) {
    out.push({
      id: `${base.tag}/${claim.tag}/${bytes.tag}`,
      base, claim, bytes,
      honest: claim.type === base.type && bytes.tag === 'exact',
    });
  }
  return out;
}

