// fetchCommit's result and CommitMiss. tsc --noEmit must pass; every @ts-expect-error must still be an error.
import { fetchCommit, type CommitMiss, type FetchedCommit } from '../../src/read.js';
import { fail, type Reason } from '../../src/errors.js';
import { assertNever } from '../../src/result.js';
import type { Transport } from '../../src/transport.js';

declare const transport: Transport;
declare const oid: string;

const fetched = await fetchCommit(transport, oid);
if (fetched.ok) {
  const value: FetchedCommit = fetched.value;
  const tree: string = value.commit.tree;
  void value; void tree;
}

const reason: Reason = 'not_our_ref';
void reason;

// miss is optional: a missing ref is not_found with no commit classification
fail('not_found', 'ref main not found');

const label = (miss: CommitMiss): string => {
  switch (miss.kind) {
    case 'absent': return miss.oid;
    case 'not_commit': return miss.type;
    default: return assertNever(miss);
  }
};
void label;

if (!fetched.ok && fetched.error.code === 'not_found' && fetched.error.miss) {
  const text: string = label(fetched.error.miss);
  void text;
}

const incomplete = (miss: CommitMiss): string => {
  switch (miss.kind) {
    case 'absent': return miss.oid;
    // @ts-expect-error not exhaustive: not_commit is not handled
    default: return assertNever(miss);
  }
};
void incomplete;
