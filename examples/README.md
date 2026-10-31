# examples

Two CLI scripts that use ply as the git client from a machine with Node and no `git` binary. Each is a thin wrapper over
a first-class API; `test/examples.test.js` runs both, as a user would, against `git http-backend` with the client's
`PATH` holding only `node`.

```sh
export PLY_TOKEN=…            # Basic auth (user PLY_USER, default x-access-token); or PLY_BEARER for Bearer
node examples/push-tree.mjs ./site https://host/repo.git --ref main --message "deploy"
node examples/checkout-tree.mjs https://host/repo.git ./out --ref main
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

Measured by `test/examples.test.js` (9 files, 6 trees, two symlinks, an exec bit): create sends 16 objects / 4683 pack
bytes; a one-file change four directories deep sends 6 objects (1 blob, 4 trees, the commit) / 488 bytes; an unchanged
tree is a `noop`. The checkout is byte-identical to the source with modes, and so is `git clone` of the remote.
