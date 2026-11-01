// Merge-base search cap (#143). The search starts at min(8, floor(cap)) and doubles, the last step clamped to
// floor(cap) (#79). A window that comes back still truncated attempts the next step: twice that window, or 1 when
// floor(cap) < 1 and nothing was fetched. `max` is the cap the caller passed, fractions included.
//   relation  fork: two branches off one root. ancestor: one tip is that many commits behind the other.
//             unrelated: two roots, no shared commit.
//   length    how many commits the answer sits behind each tip (1, 7, 8, 9, 15 — under, on, and past the first window)
//   cap       0, 0.5, 1, 7, 8, 9, 15.5, 16
// fork and ancestor settle once the window holds the child of the base (the base is named by both sides, #41).
// unrelated settles only when each root itself is in the window. For these three graphs that window is `length`.
export const RELATIONS = ['fork', 'ancestor', 'unrelated'];
export const LENGTHS = [1, 7, 8, 9, 15];
export const CAPS = [0, 0.5, 1, 7, 8, 9, 15.5, 16];

export function cells() {
  const out = [];
  for (const relation of RELATIONS) for (const length of LENGTHS) for (const cap of CAPS) {
    out.push({ id: `${relation}/${length}/${cap}`, relation, length, cap });
  }
  return out;
}

// The windows mergeBase actually fetches for this cap, in order. Empty when floor(cap) < 1.
export function windows(cap) {
  const top = Math.floor(cap);
  if (top < 1) return [];
  const out = [];
  let depth = Math.min(8, top);
  for (;;) {
    out.push(depth);
    if (depth >= top) return out;
    depth = Math.min(depth * 2, top);
  }
}

// What the cap must report. `fit` names the window that first reaches `need`; `capped` names got and max.
export function expectCap(cap, need) {
  const searched = windows(cap);
  const depth = searched.find(d => d >= need);
  if (depth !== undefined) return { tag: 'fit', depth };
  const last = searched.length === 0 ? 0 : searched[searched.length - 1];
  return { tag: 'capped', got: last === 0 ? 1 : last * 2, max: cap };
}
