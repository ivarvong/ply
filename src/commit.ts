// One commit object by oid. readCommit, the tree walk, and pickCommit's assertCommit all go through fetchCommit.
// It lives here so merge and rebase can use it without pulling read's blob stream (openBlob) into their bundle.
// The read path's edge to modules not yet converted to Result (caughtErr, attempt, attemptSync) lives here for that reason:
// read, log and checkout all import this file.
import { fail, isPlyError } from './errors.js';
import type { CommitMiss, PlyError } from './errors.js';
import { ok, err } from './result.js';
import type { Err, Result } from './result.js';
import { fetchObject } from './fetch.js';
import { parseCommit, TYPE } from './objects.js';
import type { Commit } from './objects.js';
import { thrownCodeIs, thrownReasonIs } from './boundary.js';
import type { Transport } from './transport.js';

export type { CommitMiss };

// A caught value as an Err. One of ply's errors is the Err. Anything else was not built by ply (a platform bug, a
// caller's fake that throws something of its own) and propagates exactly as it was thrown: it is not a value this
// path can type, and wrapping it would change what the caller sees.
export function caughtErr(e: unknown): Err<PlyError> {
  if (isPlyError(e)) return err(e);
  throw e;
}
// The edge to a function of a module that still throws: its PlyError becomes an Err (caughtErr).
export async function attempt<T>(f: () => Promise<T>): Promise<Result<T, PlyError>> {
  try { return ok(await f()); } catch (e) { return caughtErr(e); }
}
export function attemptSync<T>(f: () => T): Result<T, PlyError> {
  try { return ok(f()); } catch (e) { return caughtErr(e); }
}

// One commit object, hash-verified. A not_found carries Miss `{ kind: 'commit', miss }`; every other code is the error
// fetchObject threw.
export type FetchedCommit = { readonly oid: string; readonly data: Uint8Array; readonly commit: Commit };
// Effect: the commit object alone (tree:0, deepen 1). An oid the server does not have is not_found whose miss is
// `{ kind: 'commit', miss: { kind: 'absent' } }` (v2Step's not_our_ref). An object that arrived as a tree, blob, or tag
// is not_found `{ kind: 'commit', miss: { kind: 'not_commit' } }`. A corrupt pack stays pack_corrupt.
export async function fetchCommit(t: Transport, oid: string): Promise<Result<FetchedCommit, PlyError>> {
  try {
    const c = await fetchObject(t, { oid, filter: 'tree:0', deepen: 1, expectType: TYPE.COMMIT });
    return ok({ oid, data: c.data, commit: parseCommit(c.data, t.limits) });
  } catch (e) {
    if (thrownCodeIs(e, 'remote_error') && thrownReasonIs(e, 'not_our_ref')) return fail('not_found', `commit ${oid} not found on the remote`, { miss: { kind: 'commit', miss: { kind: 'absent', oid } } });
    return caughtErr(e);
  }
}
