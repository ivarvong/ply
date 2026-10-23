# process/ — the record behind the project

## logs/

| File | What | Code version |
|---|---|---|
| `npm-test-2026-10-20.txt` | the final `npm test`: 113/113 deterministic tests + 16 fuzz stages, 0 failures (29 min) | as exported |
| `coverage-2026-10-20.txt` | `npm run coverage`: 100% of 2,461 lines, seeds pinned | as exported |
| `linemerge-20k-2026-10-19.txt` | 20,000-seed line-merge campaign vs git 2.43: 13,906 non-trivial merges, 0 wrong | before the Myers port: the 59 "conservative" answers were the compaction re-diff, later resolved by the `rediff` option (0 conservative since) |
| `linemerge-big-2026-10-19.txt` | `--big` campaign (long low-variety files), 2,151 merges, 0 wrong | same as above |

## experiments/

One-off scripts that produced findings; each finding became a permanent test in `ply/test/`. They were run from
`/home/claude/ply` and import with absolute paths — adjust the paths to your checkout before running.

| Script | Finding | Now covered by |
|---|---|---|
| `criss.mjs` | criss-cross history: git builds a virtual merge base; picking one base gave `f=a` where git gives `f=x` | `merge.test.js` "merge bases decided by git" |
| `trap.mjs` | the old "closest ancestor" merge-base rule picked an ancestor of the true base on an ordinary history (git `f=r`, old ply `f=y`) — compares old vs new `merge.js` (needs the old file at `/tmp/oldmerge.js`) | same test, trap block |
| `rename-red.mjs` | rename/rename, rename/delete and directory-rename shapes where git conflicts and a rename-blind merge was clean | rename guards; `merge.test.js` |
| `chain.mjs` | histogram hash-chain limit: 64 colliding lines merge, 65 make git fail ("failed to execute internal merge") | `linemerge.test.js` |
| `sep.mjs` | search for the smallest input where git 2.54's compaction differs from older git (`a b c` → `c a a c`) | `linemerge.test.js` pinned case |
| `wm.mjs` | wildmatch against git's own `t/t3070-wildmatch.sh` vectors (needs a git source checkout): 380/380 | recorded in SAFETY.md (vectors not shipped: GPL) |
| `ug.mjs` | wanted tree that is also a commit root under `tree:N` (`NOT_USER_GIVEN`) — model vs `rev-list` | `test/fuzz/usergiven.mjs` |
| `attr-source.sh` | where `git merge-tree` in a bare repo reads `.gitattributes`: 2.43 from HEAD, 2.56 nowhere unless `attr.tree` | the `attributes` option; SAFETY.md I28 |

Usage of `attr-source.sh`: `bash attr-source.sh <git-binary> none|base|ours|theirs`.
