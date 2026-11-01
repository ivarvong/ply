// Pure: the objects one edit commit is made of (new trees along the path, the commit, the blob as a delta), and a
// commit's bytes from its tree and parents. A caller's identity is validated here (validateIdent throws a PlyError for
// a bad one: these are public entries, which stay throwing until the Result cut-over); a validated one is used as it is.
import { ident, encodeCommit, hashObject, treeReplaceOid, TYPE } from './objects.js';
import type { TreeEntry } from './objects.js';
import { spliceDelta } from './pack.js';
import type { PackInput } from './pack.js';
import { fromHex } from './sha1.js';
import type { ValidatedIdent } from './validate.js';
import { validateIdent, isValidatedIdent } from './validate.js';
import type { Input } from './absent.js';
import { fromNullable, fromNullish } from './absent.js';
import { getOrElse, matchOption } from './result.js';

// A caller's identity, before validateIdent. `time` overrides the commit's time for this person; `tz` defaults to UTC.
export type Author = { readonly name: string; readonly email: string } & Input<{ readonly tz: string; readonly time: number }>;
export type AuthorLike = Author | ValidatedIdent;

function identLine(person: AuthorLike, time: number): string {
  if (isValidatedIdent(person)) return ident(person);
  const when = getOrElse(fromNullish(person.time), time);
  // tz: only the missing value means UTC (validateIdent's default); a null tz is the caller's, and refused there
  const tz = fromNullable(person.tz);
  return ident(validateIdent(tz.tag === 'some' ? { name: person.name, email: person.email, time: when, tz: tz.value } : { name: person.name, email: person.email, time: when }));
}
// The committer line: the author's when none is given.
const committerLine = (committer: AuthorLike | null, who: string, time: number): string =>
  matchOption(fromNullish(committer), { some: c => identLine(c, time), none: () => who });

export type Level = { readonly treeOid: string; readonly data: Uint8Array; readonly entry: TreeEntry };
export type BlobEditLite = { readonly oldOid: string; readonly newOid: string; readonly newLen: number; readonly delta: Uint8Array };

export type NewTree = { readonly type: number; readonly data: Uint8Array; readonly baseOid: string; readonly newOid: string; readonly newData: Uint8Array };
export type Built = {
  readonly trees: readonly NewTree[];
  readonly newTree: string;
  readonly commitData: Uint8Array;
  readonly newCommit: string;
  readonly objects: readonly PackInput[];
};
// The commit's people and words. `committer` null (or left out) is the author.
type Stamp = { readonly author: AuthorLike; readonly time: number; readonly message: string } & Input<{ readonly committer: AuthorLike | null }>;

export function buildCommitObjects({ levels, blob, oldCommit, author, committer = null, time, message }: Stamp & {
  readonly levels: readonly Level[];
  readonly blob: Pick<BlobEditLite, 'oldOid' | 'newOid' | 'delta' | 'newLen'>;
  readonly oldCommit: string;
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
  const written = committerLine(committer, who, time);
  const body = message.endsWith('\n') ? message : `${message}\n`;
  const commitData = encodeCommit({ tree: child, parents: [oldCommit], author: who, committer: written, message: body });
  const newCommit = hashObject('commit', commitData);
  const objects: PackInput[] = [
    { type: TYPE.COMMIT, data: commitData },
    ...trees.map(t => ({ type: t.type, data: t.data, baseOid: t.baseOid })),
    blob.delta.length >= 4 ? { type: TYPE.BLOB, data: blob.delta, baseOid: blob.oldOid } : { type: TYPE.BLOB, data: new Uint8Array(blob.newLen) },
  ];
  return { trees, newTree: child, commitData, newCommit, objects };
}

export function withCommitData(built: Built, commitData: Uint8Array): Built {
  const newCommit = hashObject('commit', commitData);
  return { ...built, commitData, newCommit, objects: [{ type: TYPE.COMMIT, data: commitData }, ...built.objects.slice(1)] };
}

export function buildCommitData({ tree, parents, author, committer = null, time, message }: Stamp & { readonly tree: string; readonly parents: readonly string[] }): { readonly data: Uint8Array; readonly oid: string } {
  const who = identLine(author, time);
  const written = committerLine(committer, who, time);
  const body = message.endsWith('\n') ? message : `${message}\n`;
  const commitData = encodeCommit({ tree, parents, author: who, committer: written, message: body });
  return { data: commitData, oid: hashObject('commit', commitData) };
}
