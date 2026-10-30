# examples

Scripts that use ply as the git client from a machine with Node but no `git` binary. Both were checked against real
`git http-backend` (`test/server.js`) and behind the Artifacts-behaviour proxy (`test/proxy.js`, `blob:none` only):
`git fsck --strict` clean, `git clone` of the result identical to the source directory.

- `push-tree.mjs <dir> <remote.git> [refs/heads/main] [token]` — the directory as one commit. Creates the ref with the
  zero old-oid or updates it with the current head as the CAS; honours `.gitignore` (root and nested); leaves out every
  blob and tree the previous commit already has, so a one-file change ships that blob, the trees on its path and the
  commit; an unchanged tree is a `noop`. Symlinks and submodules are skipped on purpose.
- `checkout-tree.mjs <remote.git> <out-dir> [ref] [token]` — a ref into a directory via `readCommit`/`listTree`/`readFile`:
  every blob hash-checked as it streams, modes kept (`100755` → executable, `120000` → symlink).

Token: Artifacts and GitHub both take `auth: { user: 'x', token }` (Basic) or `{ bearer }`; the scripts use the former.

Round trips today: push ≈ 2 for a create, ≈ 7 for an update (the server-has walk is one `listTree` per directory);
checkout ≈ 3 + 2 per file. A library-level `pushTree` / `checkoutTree` would do the same in a fixed handful — see #11.
