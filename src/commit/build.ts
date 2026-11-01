import { ident, encodeCommit, hashObject, treeReplaceOid, TYPE } from '../objects.js';
import type { TreeEntry } from '../objects.js';
import { spliceDelta } from '../pack.js';
import { fromHex } from '../sha1.js';
import type { ValidatedIdent } from '../validate.js';
import { validateIdent, isValidatedIdent } from '../validate.js';

export type AuthorLike = { readonly name: string; readonly email: string; readonly tz?: string; readonly time?: number } | ValidatedIdent;

function identLine(person: AuthorLike, time: number): string {
  if (isValidatedIdent(person)) return ident(person);
  return ident(validateIdent({ name: person.name, email: person.email, time: person.time ?? time, tz: person.tz }));
}

export type Level = { readonly treeOid: string; readonly data: Uint8Array; readonly entry: TreeEntry };
export type BlobEditLite = { readonly oldOid: string; readonly newOid: string; readonly newLen: number; readonly delta: Uint8Array; readonly matchOffset?: number };

export type NewTree = { readonly type: number; readonly data: Uint8Array; readonly baseOid: string; readonly newOid: string; readonly newData: Uint8Array };
export type Built = {
  readonly trees: readonly NewTree[];
  readonly newTree: string;
  readonly commitData: Uint8Array;
  readonly newCommit: string;
  readonly objects: readonly { readonly type: number; readonly data: Uint8Array; readonly baseOid?: string }[];
};

export function buildCommitObjects({ levels, blob, oldCommit, author, committer, time, message }: {
  readonly levels: readonly Level[];
  readonly blob: Pick<BlobEditLite, 'oldOid' | 'newOid' | 'delta' | 'newLen'>;
  readonly oldCommit: string;
  readonly author: AuthorLike;
  readonly committer?: AuthorLike;
  readonly time: number;
  readonly message: string;
}): Built {
  const trees: NewTree[] = [];
  let child = blob.newOid;
  for (const { treeOid: oldOid, data, entry } of levels.toReversed()) {
    const newData: Uint8Array = treeReplaceOid(data, entry, child);
    const newOid = hashObject('tree', newData);
    const delta = spliceDelta({ baseLen: data.length, off: entry.oidOffset, oldLen: 20, insert: fromHex(child) }).delta;
    trees.unshift({ type: TYPE.TREE, data: delta, baseOid: oldOid, newOid, newData });
    child = newOid;
  }
  const who = identLine(author, time);
  const written = committer === undefined ? who : identLine(committer, time);
  // trailing newline by caller
  const commitData = encodeCommit({ tree: child, parents: [oldCommit], author: who, committer: written, message });
  const newCommit = hashObject('commit', commitData);
  const objects = [
    { type: TYPE.COMMIT, data: commitData },
    ...trees.map(t => ({ type: t.type, data: t.data, baseOid: t.baseOid })),
    blob.delta.length >= 4 ? { type: TYPE.BLOB, data: blob.delta, baseOid: blob.oldOid } : { type: TYPE.BLOB, data: new Uint8Array(blob.newLen) },
  ] as const;
  return { trees, newTree: child, commitData, newCommit, objects };
}

export function withCommitData(built: Built, commitData: Uint8Array): Built {
  const newCommit = hashObject('commit', commitData);
  return { ...built, commitData, newCommit, objects: [{ type: TYPE.COMMIT, data: commitData }, ...built.objects.slice(1)] };
}

export function buildCommitData({ tree, parents, author, committer, time, message }: {
  readonly tree: string; readonly parents: readonly string[]; readonly author: AuthorLike; readonly committer?: AuthorLike; readonly time: number; readonly message: string;
}): { readonly data: Uint8Array; readonly oid: string } {
  const who = identLine(author, time);
  const written = committer === undefined ? who : identLine(committer, time);
  const commitData = encodeCommit({ tree, parents, author: who, committer: written, message });
  return { data: commitData, oid: hashObject('commit', commitData) };
}

