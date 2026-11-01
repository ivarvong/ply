// What each error code means and where it comes from. Documentation for humans and tooling; the runtime table is
// errors.ts (RETRY); `satisfies` makes the table exhaustive over Code at compile time, test/pure.test.js at run time.
import type { Code } from './errors.js';

export type CodeDoc = { readonly where: 'local' | 'remote' | 'net' | 'content'; readonly what: string };
export const CODE_DOCS: Readonly<Record<Code, CodeDoc>> = Object.freeze({
  bad_request: { where: 'local', what: 'an argument is malformed (ref, ident, path, oid, message, find, files: a duplicate or file/directory path; checkout: a non-empty dir, or a path that collides or would pass through a symlink)' },
  unsupported: { where: 'remote', what: 'the server lacks a capability we need (sha256 repo, no filter, push-options not advertised)' },
  network: { where: 'net', what: 'connection failed or dropped before a response was complete' },
  timeout: { where: 'net', what: 'the request exceeded limits.requestTimeoutMs' },
  aborted: { where: 'local', what: 'the caller\'s AbortSignal fired' },
  http: { where: 'remote', what: 'an HTTP status we do not classify further, including a 3xx ply is not following (the default; status, location). followRedirects initial rebases only the first info/refs GET' },
  auth: { where: 'remote', what: '401/403' },
  not_found: { where: 'remote', what: 'repository, ref, path or commit does not exist; miss.kind says which' },
  rate_limited: { where: 'remote', what: 'HTTP 429; retry after a delay' },
  upstream_5xx: { where: 'remote', what: 'HTTP 5xx' },
  not_git: { where: 'remote', what: 'the endpoint is not a git smart-HTTP server (wrong content-type)' },
  protocol: { where: 'remote', what: 'malformed pkt-line / v2 framing from the server' },
  pack_corrupt: { where: 'remote', what: 'a pack or object failed verification (hash, size, zlib, delta; an unwanted object; a tree naming one entry twice)' },
  remote_error: { where: 'remote', what: 'the server said ERR / band 3; reason not_our_ref when the text is upload-pack\'s not-our-ref' },
  limit_exceeded: { where: 'local', what: 'a limits.* bound was hit before allocation' },
  match_count: { where: 'content', what: 'find matched 0 or >1 times (exactly-one-match contract)' },
  lfs_pointer: { where: 'content', what: 'the blob is a Git LFS pointer (pass allowLfsPointer to edit it)' },
  cas_conflict: { where: 'remote', what: 'the ref moved under us (receive-pack compare-and-swap lost)' },
  push_rejected: { where: 'remote', what: 'a hook or policy refused the push; see hookOutput / remote messages' },
  push_partial: { where: 'remote', what: 'a non-atomic multi-ref push was partly applied: `landed` lists the refs updated, `rejected` the refs refused with their reasons' },
  merge_conflict: { where: 'content', what: 'both sides changed a path; `conflicts` lists them' },
  not_fast_forward: { where: 'content', what: 'fastForwardOnly was requested and a merge commit would be needed, or the server refuses non-fast-forward updates (receive.denyNonFastForwards) and the pushed commit does not descend from the old oid' },
  unrelated_histories: { where: 'content', what: 'no common ancestor within the search depth' },
  not_linear: { where: 'content', what: 'a merge commit in a chain that must be linear (rebase, pick)' },
  ambiguous: { where: 'remote', what: 'the push was sent and may have been applied, but no trustworthy confirmation was obtained' },
  internal: { where: 'local', what: 'an invariant of this library failed; please report' },
} satisfies Record<Code, CodeDoc>);
