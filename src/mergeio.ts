// The commit reads and names merge.ts and rebase.ts share. Internal: not a package entry, and kept out of merge.ts
// so the ./merge entry does not export them.
/* oxlint-disable eslint/require-await, typescript/promise-function-async -- as merge.ts: a function that forwards a promise */
import type { Transport } from './transport.js';
import type { Author, Commit } from './merge.js';
import type { ValidatedIdent } from './validate.js';
import { thrown as fail } from './errors.js';
import { fetchObject } from './fetch.js';
import { parseCommit, TYPE } from './objects.js';
import { validateIdent, validateRef } from './validate.js';
import { parseOid, ZERO_OID } from './oid.js';

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
// Effect: a given commit id is a commit on the server, fetched alone (deepen 1). One the server does not have ('not our
// ref') or that is not a commit ('expected commit') is the caller's not_found, as read.js's fetchCommit maps them — not
// a corrupt pack mid-merge (pack_corrupt reads as retryable).
type Loose = { readonly message?: unknown } | null | undefined;
export const assertCommit = async (t: Transport, oid: string, what: string): Promise<unknown> => commitBytesAt(t, oid).catch((e: unknown) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a thrown value, read loosely (as errors.ts reads one)
  throw /expected commit|not our ref/u.test(String((e as Loose)?.message)) ? fail('not_found', `${what} ${oid} is not a commit on the remote`, { what }) : e;
});
// A commit stamp: who and when, each stamp with its own time and zone (#103 item 4). `time` is the operation's, for a
// stamp that gives none; an omitted zone is +0000.
export const stamp = (p: Partial<Author> | null | undefined, time: number): ValidatedIdent => validateIdent({ name: p?.name, email: p?.email, time: p?.time ?? time, tz: p?.tz });
