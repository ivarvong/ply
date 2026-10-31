// One commit object by oid. readCommit, the tree walk, and pickCommit's assertCommit all go through fetchCommit.
// It lives here so merge and rebase can use it without pulling read's blob stream (openBlob) into their bundle.
import { thrown, isPlyError } from './errors.js';
import type { CommitMiss, PlyError } from './errors.js';
import { ok, err as resultErr } from './result.js';
import type { Result } from './result.js';
import { fetchObject } from './fetch.js';
import { parseCommit, TYPE } from './objects.js';
import type { Commit } from './objects.js';
import { thrownCode, thrownReason } from './boundary.js';
import type { Transport } from './transport.js';

export type { CommitMiss };
// One commit object, hash-verified. `miss` on a not_found says why; every other code is the error fetchObject threw.
export type FetchedCommit = { readonly oid: string; readonly data: Uint8Array; readonly commit: Commit };
// Effect: the commit object alone (tree:0, deepen 1). An oid the server does not have is not_found `absent` (v2Step's
// not_our_ref). An object that arrived as a tree, blob, or tag is not_found `not_commit`. A corrupt pack stays
// pack_corrupt.
export async function fetchCommit(t: Transport, oid: string): Promise<Result<FetchedCommit, PlyError>> {
  try {
    const c = await fetchObject(t, { oid, filter: 'tree:0', deepen: 1, expectType: TYPE.COMMIT });
    return ok({ oid, data: c.data, commit: parseCommit(c.data, t.limits) });
  } catch (e) {
    if (thrownCode(e) === 'remote_error' && thrownReason(e) === 'not_our_ref') return resultErr(thrown('not_found', `commit ${oid} not found on the remote`, { miss: { kind: 'absent', oid } }));
    if (isPlyError(e)) return resultErr(e);
    throw e;
  }
}
