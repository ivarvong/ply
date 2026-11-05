// One commit object by oid. readCommit, the tree walk, and pickCommit's assertCommit all go through fetchCommit.
// It lives here so merge and rebase can use it without pulling read's blob stream (openBlob) into their bundle.
import { fail } from './errors.js';
import type { CommitMiss, PlyError } from './errors.js';
import { map } from './result.js';
import type { Result } from './result.js';
import { objectAt, objectId } from './fetch.js';
import type { Oid } from './oid.js';
import { parseCommit, TYPE } from './objects.js';
import type { Commit } from './objects.js';
import { thrownReasonIs } from './boundary.js';
import type { Transport } from './transport.js';

export type { CommitMiss };

// One commit object, hash-verified. A not_found carries Miss `{ kind: 'commit', miss }`; every other code is the error
// fetchObject returned.
export type FetchedCommit = { readonly oid: Oid; readonly data: Uint8Array; readonly commit: Commit };
// Effect: the commit object alone (tree:0, deepen 1). An oid the server does not have is not_found whose miss is
// `{ kind: 'commit', miss: { kind: 'absent' } }` (v2Step's not_our_ref). An object that arrived as a tree, blob, or tag
// is not_found `{ kind: 'commit', miss: { kind: 'not_commit' } }`. A corrupt pack stays pack_corrupt.
// fetchCommit of a parsed id: ply's own callers, which hold an Oid, start here.
export async function commitById(t: Transport, oid: Oid): Promise<Result<FetchedCommit, PlyError>> {
  const got = await objectAt(t, oid, { filter: 'tree:0', deepen: 1, expectType: TYPE.COMMIT });
  if (!got.ok) {
    if (got.error.code === 'remote_error' && thrownReasonIs(got.error, 'not_our_ref')) return fail('not_found', `commit ${oid} not found on the remote`, { miss: { kind: 'commit', miss: { kind: 'absent', oid } } });
    return got;
  }
  const { data } = got.value;
  return map(parseCommit(data, t.limits), commit => ({ oid, data, commit }));
}
// The caller's oid is parsed once (fetchObject's refusal: `fetchObject: oid must be 40-hex`, bad_request).
// oxlint-disable-next-line typescript/promise-function-async -- commitById's promise, passed through
export function fetchCommit(t: Transport, oid: string): Promise<Result<FetchedCommit, PlyError>> {
  const id = objectId(oid);
  return id.ok ? commitById(t, id.value) : Promise.resolve(id);
}
