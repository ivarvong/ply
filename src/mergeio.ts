// The commit reads and names merge.ts and rebase.ts share. Internal: not a package entry, and kept out of merge.ts
// so the ./merge entry does not export them.
/* oxlint-disable eslint/require-await, typescript/promise-function-async -- as merge.ts: a function that forwards a promise */
import type { Transport } from './transport.js';
import type { Commit } from './merge.js';
import { fetchObject } from './fetch.js';
import { parseCommit, TYPE } from './objects.js';

// fetch.ts's JS-default signature, cast at the call (type-only; see merge.ts)
type FetchObject = (t: Transport, o: { readonly oid: string | null | undefined; readonly expectType: number; readonly deepen?: number }) => Promise<{ readonly data: Uint8Array }>;

// a branch name as git's messages print it
export const short = (r: string): string => r.replace(/^refs\/heads\//u, '');
// Effect: one commit by oid (deepen 1: the commit alone), as bytes or parsed
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the JS signature, typed above
export const commitBytesAt = async (t: Transport, oid: string | null | undefined): Promise<{ readonly data: Uint8Array }> => (fetchObject as unknown as FetchObject)(t, { oid, expectType: TYPE.COMMIT, deepen: 1 });
export const commitAt = async (t: Transport, oid: string | null | undefined): Promise<Commit> => parseCommit((await commitBytesAt(t, oid)).data, t.limits);
