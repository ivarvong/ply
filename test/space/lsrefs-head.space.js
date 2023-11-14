// ls-refs and maxRefs (#143). HEAD is a line git ls-remote prints beside the branches. It does not consume
// maxRefs. A branch named refs/heads/HEAD does. An unborn HEAD is not a ref line at all.
//   head     how HEAD is set: symref, detached, or unborn (a symbolic-ref whose target does not exist)
//   decoy    refs/heads/HEAD absent or present
//   n        other branches: 0, 1, 2, 10000, 10001
//   maxRefs  0, 2, and 10000 (LIMIT_REFS)
export const HEADS = ['symref', 'detached', 'unborn'];
export const DECOYS = [false, true];
export const NS = [0, 1, 2, 10000, 10001];
export const CAPS = [0, 2, 10000];

export function cells() {
  const out = [];
  for (const head of HEADS) for (const decoy of DECOYS) for (const n of NS) for (const maxRefs of CAPS) {
    out.push({ id: `${head}/${decoy ? 'decoy' : 'plain'}/${n}/${maxRefs}`, head, decoy, n, maxRefs });
  }
  return out;
}
