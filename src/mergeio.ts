// The commit reads and names merge.ts and rebase.ts share. Internal: not a package entry, and kept out of merge.ts
// so the ./merge entry does not export them.
/* oxlint-disable eslint/require-await, typescript/promise-function-async -- as merge.ts: a function that forwards a promise */
import type { Transport } from './transport.js';
import type { Author, Commit } from './merge.js';
import type { ValidatedIdent } from './validate.js';
import { thrown as fail, isPlyError } from './errors.js';
import type { Miss } from './errors.js';
import { fetchObject } from './fetch.js';
import { parseCommit, TYPE } from './objects.js';
import { validateIdent, validateRef } from './validate.js';
import { parseOid, ZERO_OID } from './oid.js';
import { thrownCode, thrownReason } from './boundary.js';

// fetch.ts's JS-default signature, cast at the call (type-only; see merge.ts)
type FetchObject = (t: Transport, o: { readonly oid: string | null | undefined; readonly expectType: number; readonly deepen?: number }) => Promise<{ readonly data: Uint8Array }>;

// a branch name as git's messages print it
export const short = (r: string): string => r.replace(/^refs\/heads\//u, '');
// Effect: one commit by oid (deepen 1: the commit alone), as bytes or parsed
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the JS signature, typed above
export const commitBytesAt = async (t: Transport, oid: string | null | undefined): Promise<{ readonly data: Uint8Array }> => (fetchObject as unknown as FetchObject)(t, { oid, expectType: TYPE.COMMIT, deepen: 1 });
export const commitAt = async (t: Transport, oid: string | null | undefined): Promise<Commit> => parseCommit((await commitBytesAt(t, oid)).data, t.limits);

export const isOid = (s: string): boolean => parseOid(s).ok;
// A merge `from` or rebase `onto`, as read.js's resolveCommit takes a name (#103 item 4): a 40-hex commit id is taken as
// given (returned; the all-zero id names nothing), anything else is a ref name (validated; null: ask ls-refs).
export const givenOid = (name: string, what: string): string | null => {
  if (!isOid(name)) { validateRef(name); return null; }
  if (name === ZERO_OID) throw fail('bad_request', `${what} must not be the zero oid`, { what });
  return name;
};
// The not_found a commit fetch already classified, or upload-pack's not_our_ref. Anything else (a corrupt pack) passes
// through: pack_corrupt stays retryable, and is not reported as a missing commit. One fail(), so the decision id stays.
const commitMiss = (e: unknown, oid: string): Miss | null => {
  if (isPlyError(e) && e.code === 'not_found' && e.miss.kind === 'commit') return e.miss;
  if (thrownCode(e) === 'remote_error' && thrownReason(e) === 'not_our_ref') return { kind: 'commit', miss: { kind: 'absent', oid } };
  return null;
};
// Effect: a given commit id is a commit on the server, fetched alone (deepen 1). One the server does not have, or that
// is not a commit, is the caller's not_found — the message names `what`, and the miss is the commit fetch's.
export const assertCommit = async (t: Transport, oid: string, what: string): Promise<unknown> => commitBytesAt(t, oid).catch((e: unknown) => {
  const miss = commitMiss(e, oid);
  if (miss === null) throw e;
  throw fail('not_found', `${what} ${oid} is not a commit on the remote`, { what, miss });
});
// A commit stamp: who and when, each stamp with its own time and zone (#103 item 4). `time` is the operation's, for a
// stamp that gives none; an omitted zone is +0000.
export const stamp = (p: Partial<Author> | null | undefined, time: number): ValidatedIdent => validateIdent({ name: p?.name, email: p?.email, time: p?.time ?? time, tz: p?.tz });
