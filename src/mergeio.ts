// The commit reads and names merge.ts and rebase.ts share. Internal: not a package entry, and kept out of merge.ts
// so the ./merge entry does not export them.
/* oxlint-disable eslint/require-await, typescript/promise-function-async -- as merge.ts: a function that forwards a promise */
import type { Transport } from './transport.js';
import type { Author, Commit } from './merge.js';
import type { ValidatedIdent } from './validate.js';
import type { ErrorOf, PlyError } from './errors.js';
import type { FetchedCommit } from './commit.js';
import type { Option, Result } from './result.js';
import { fail } from './errors.js';
import { fetchObject } from './fetch.js';
import { fetchCommit } from './commit.js';
import { parseCommit, TYPE } from './objects.js';
import { validateIdent, validateRef } from './validate.js';
import { parseOid, ZERO_OID } from './oid.js';
import { getOrElse, none, ok, some } from './result.js';
import { fromNullish } from './absent.js';

// a branch name as git's messages print it
export const short = (r: string): string => r.replace(/^refs\/heads\//u, '');
// Effect: one commit by oid (deepen 1: the commit alone), as bytes or parsed
export const commitBytesAt = async (t: Transport, oid: string): Promise<{ readonly data: Uint8Array }> => fetchObject(t, { oid, expectType: TYPE.COMMIT, deepen: 1 });
export const commitAt = async (t: Transport, oid: string): Promise<Commit> => parseCommit((await commitBytesAt(t, oid)).data, t.limits);

export const isOid = (s: string): boolean => parseOid(s).ok;
// A merge `from` or rebase `onto`, as read.js's resolveCommit takes a name (#103 item 4): a 40-hex commit id is taken as
// given (Some; the all-zero id names nothing), anything else is a ref name (validated; None: ask ls-refs).
export const givenOid = (name: string, what: string): Result<Option<string>, ErrorOf<'bad_request'>> => {
  if (!isOid(name)) { validateRef(name); return ok(none); }
  if (name === ZERO_OID) return fail('bad_request', `${what} must not be the zero oid`, { what });
  return ok(some(name));
};
// Effect: a given commit id is a commit on the server, fetched alone (deepen 1). fetchCommit's not_found (a commit
// miss: absent, or not a commit) is the caller's not_found, with that same miss. Every other code passes through: a
// corrupt pack stays pack_corrupt (retryable), and is not reported as a missing commit.
export const assertCommit = async (t: Transport, oid: string, what: string): Promise<Result<FetchedCommit, PlyError>> => {
  const r = await fetchCommit(t, oid);
  if (r.ok) return r;
  if (r.error.code !== 'not_found') return r;
  return fail('not_found', `${what} ${oid} is not a commit on the remote`, { what, miss: r.error.miss });
};
// A commit stamp: who and when, each stamp with its own time and zone (#103 item 4). `time` is the operation's, for a
// stamp that gives none (or null); an omitted zone is +0000. No stamp at all (null) is refused by validateIdent.
export const stamp = (p: Author | null, time: number): ValidatedIdent =>
  validateIdent(p === null ? { time } : { name: p.name, email: p.email, time: getOrElse(fromNullish(p.time), time), tz: p.tz });
