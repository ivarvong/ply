# examples

Three CLI scripts that use ply as the git client from a machine with Node and no `git` binary. Each is a thin wrapper over
a first-class API; `test/examples.test.js` runs all three, as a user would, against `git http-backend` with the client's
`PATH` holding only `node`. A fourth, `recover-push.mjs`, takes no arguments and no account: it is a recovery recipe run
against a local `git http-backend` (see "Recovering from a conflict or a lost answer" below).

```sh
npm install                   # once, in a clone: builds dist/, which the examples import as `ply` (no build, no examples)
export PLY_TOKEN=…            # Basic auth (user PLY_USER, default x-access-token); or PLY_BEARER for Bearer
node examples/push-tree.mjs ./site https://host/repo.git --ref main --message "deploy"
node examples/checkout-tree.mjs https://host/repo.git ./out --ref main
node examples/push-repo.mjs ./repo https://host/repo.git main --tags
```

Credentials come from the environment only, never argv (argv shows up in `ps` and shell history). Author is
`GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL`.

- `push-tree.mjs <dir> <remote> [--ref main] [--message …]` — `pushDir` (`ply/tree-node`): the directory as one commit.
  Creates the ref with the zero old-oid, or updates it with its current head as the CAS. Prints the old → new commit,
  the objects sent and the pack bytes. The push is thin: whatever the previous commit already has is left out, so a
  repeat with one file changed sends that blob, the trees on its path and the commit; a repeat with nothing changed is
  a `noop` and sends nothing. `.git` is skipped; `.gitignore` is not read (give `pushDir` a `filter` for that).
- `checkout-tree.mjs <remote> <dir> [--ref main]` — `checkoutDir` (`ply/checkout-node`): a ref (default `HEAD`) into an
  absent or empty directory, laid out as `git clone` lays it out (`100755` executable, `120000` a symlink, a submodule
  an empty directory), every blob hash-checked as it streams. Prints the commit and the files, bytes and symlinks
  written. Three requests whatever the file count: ls-refs, a `blob:none` tree fetch, one fetch for the blobs.

- `push-repo.mjs <repo-dir> <remote> [refspec …] [--all] [--tags] [--force] [--dry-run] [--thin]` — `pushRepo`
  (`ply/repo-node`): `git push` of a local repository, history included, with ply reading `.git` itself. Refspecs are
  git's (`main`, `src:dst`, `+src:dst`, `:dst`); none pushes the current branch. Prints each ref's old → new (or
  `Everything up-to-date`, with nothing sent) and the objects, deltas and pack bytes. A non-fast-forward is refused
  before anything is sent (`not_fast_forward`) unless forced.

Measured by `test/examples.test.js` (9 files, 6 trees, two symlinks, an exec bit): create sends 16 objects / 4683 pack
bytes; a one-file change four directories deep sends 6 objects (1 blob, 4 trees, the commit) / 488 bytes; an unchanged
tree is a `noop`. The checkout is byte-identical to the source with modes, and so is `git clone` of the remote.

## Recovering from a conflict or a lost answer

```sh
node examples/recover-push.mjs    # no arguments, no account; needs `git` on PATH as the local server and the judge
```

`recover-push.mjs` is a consumer recipe, not an API: `applyOnce` applies one read-modify-write change (append a line to
`ledger.txt`) exactly once, whatever other writers and the network do. It starts `git http-backend` (`test/server.js`),
puts each race and fault in a fixed place (a gate in `fetchImpl`, or `test/proxy.js` dropping the receive-pack answer),
and judges the remote with git alone: `cat-file` for the bytes, `rev-list --parents` for the history, `merge-base
--is-ancestor`, `rev-list --grep` for how many commits an operation became, `fsck --strict`. `test/examples.test.js`
runs it.

| case | what happens | typed outcomes | what is asserted |
| --- | --- | --- | --- |
| 1 | two writers read the same tip and pin to it; the winner lands between the loser's read and its receive-pack | `cas_conflict` (`expected` the pin, `actual` the winner), then ok | both lines in the file, the winner's first; the loser's commit has the winner's as its parent |
| 1b | the same race with the loser unpinned (the contrast) | ok | ply redid the commit on the winner's tip and the winner's line is gone |
| 2 | the server applies the push; its answer is dropped | `ambiguous`, then `landed` from the history | one receive-pack request; one commit on the pin; the line once |
| 2b | the push never reaches the server | `ambiguous`, `not_landed`, then ok | the pinned retry is the only application |
| 3 | as 2, then another writer moves the ref | `ambiguous`, then `landed` | the tip is not our commit, our commit is its ancestor; one request; each line once |
| 3b | as 2, then the ref is rewritten without the pin | `ambiguous`, then `unknown` | nothing more is sent; the ref is as the rewrite left it |
| 3c | as 2, then our commit is merged in as a second parent | `ambiguous`, then `unknown` | nothing more is sent; git shows the commit had landed |

**Pinned and unpinned.** A pinned operation names the tip its change was computed from, and the ref moves only from
that tip: `commitChanges` with `head`, `editFile` / `pushTree` / `pushDir` with `head` and `strictHead: true`,
`deleteBranch` / `deleteTag` with `expected`, `push` with its `oldOid`. A ref that is elsewhere is `cas_conflict` and
ply does not redo it. Without the pin, `commitChanges`, `editFile` and `pushTree` take the tip as it is, and when their
push loses to another writer they read the ref again and redo the commit once on the new tip, by themselves. That is
right for a change that does not depend on what was read (an `edit` is matched again against the new content). For
bytes computed from an earlier read (a `write`, a `pushTree`) it replaces the other writer's content and answers ok:
case 1b. `ambiguous` is never redone by ply in these operations, pinned or not.

**What the recipe applies to.** One commit on one ref, made by a pinned operation whose commit the caller can
recognise afterwards. An `ambiguous` error does not carry the id of the commit that was pushed (the read-back of
`verify: true` is the exception: `error.expected`), so the recipe puts an `Operation-Id:` trailer in the message and
looks for a commit with that trailer whose one parent is the pin. It does not cover multi-ref pushes (`pushRepo`,
`push` with several commands: see `push_partial`), deletes, or unpinned calls: an unpinned call that was redone has
no pin to look above.

**What refs and history can and cannot establish.** `settle` reads the ref's first-parent history (`readLog`) and
answers whether the operation's commit is in it now. That is the question a retry depends on; it is not "did the
server ever apply my push". It answers `unknown`, and the recipe then sends nothing, when the pinned commit is not in
that history (the ref was rewritten, or the pin is more than the 50 commits read below the tip) or when a merge commit
is above the pin (a commit merged in as a second parent is reachable from the tip but not on the first-parent line).
`not_landed` is as final as the lost request is dead: a push still in flight on the server can land after the read, so
every retry is pinned to the tip it read and the history is read again before each one. A writer that reuses another
operation's id, or a trailer removed by a rewrite, defeats the match.
