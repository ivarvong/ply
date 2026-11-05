// Pure: the objects one edit commit is made of (new trees along the path, the commit, the blob as a delta), and a
// commit's bytes from its tree and parents. A caller's identity is validated here (a bad one is the Err validateIdent
// returns); a validated one is used as it is.
import { ident, encodeCommitOf, hashObject, treeReplaceOid, TYPE } from './objects.js';
import type { TreeEntry } from './objects.js';
import { spliceDelta } from './pack.js';
import type { PackInput } from './pack.js';
import { fromHex } from './sha1.js';
import { parseOid, type Oid } from './oid.js';
import type { ValidatedIdent } from './validate.js';
import { validateIdent, isValidatedIdent } from './validate.js';
import type { ErrorOf } from './errors.js';
import type { Input } from './absent.js';
import { fromNullable, fromNullish } from './absent.js';
import { andThen, getOrElse, matchOption, ok } from './result.js';
import type { Result } from './result.js';

// A caller's identity, before validateIdent. `time` overrides the commit's time for this person; `tz` defaults to UTC.
export type Author = { readonly name: string; readonly email: string } & Input<{ readonly tz: string; readonly time: number }>;
export type AuthorLike = Author | ValidatedIdent;
type BadRequest = ErrorOf<'bad_request'>;

function identLine(person: AuthorLike, time: number): Result<string, BadRequest> {
  if (isValidatedIdent(person)) return ident(person);
  const when = getOrElse(fromNullish(person.time), time);
  // tz: only the missing value means UTC (validateIdent's default); a null tz is the caller's, and refused there
  const tz = fromNullable(person.tz);
  return andThen(validateIdent(tz.tag === 'some' ? { name: person.name, email: person.email, time: when, tz: tz.value } : { name: person.name, email: person.email, time: when }), ident);
}
// The committer line: the author's when none is given.
const committerLine = (committer: AuthorLike | null, who: string, time: number): Result<string, BadRequest> =>
  matchOption(fromNullish(committer), { some: c => identLine(c, time), none: () => ok(who) });
// The author and committer lines, the author's first (its refusal wins).
function people(author: AuthorLike, committer: AuthorLike | null, time: number): Result<{ readonly who: string; readonly written: string }, BadRequest> {
  const who = identLine(author, time);
  if (!who.ok) return who;
  const written = committerLine(committer, who.value, time);
  return written.ok ? ok({ who: who.value, written: written.value }) : written;
}

export type Level = { readonly treeOid: string; readonly data: Uint8Array; readonly entry: TreeEntry };
export type BlobEditLite = { readonly oldOid: string; readonly newOid: string; readonly newLen: number; readonly delta: Uint8Array };

export type NewTree = { readonly type: number; readonly data: Uint8Array; readonly baseOid: string; readonly newOid: Oid; readonly newData: Uint8Array };
export type Built = {
  readonly trees: readonly NewTree[];
  readonly newTree: Oid;
  readonly commitData: Uint8Array;
  readonly newCommit: Oid;
  readonly objects: readonly PackInput[];
};
// The commit's people and words. `committer` null (or left out) is the author.
type Stamp = { readonly author: AuthorLike; readonly time: number; readonly message: string } & Input<{ readonly committer: AuthorLike | null }>;

export function buildCommitObjects({ levels, blob, oldCommit, author, committer = null, time, message }: Stamp & {
  readonly levels: readonly Level[];
  readonly blob: Pick<BlobEditLite, 'oldOid' | 'newOid' | 'delta' | 'newLen'>;
  readonly oldCommit: string;
}): Result<Built, BadRequest> {
  const trees: NewTree[] = [];
  // the new blob's id is parsed once, here: every tree above it is spliced from it
  const newBlob = parseOid(blob.newOid);
  if (!newBlob.ok) return newBlob;
  // and the parent's, once: the commit is written on it
  const parent = parseOid(oldCommit);
  if (!parent.ok) return parent;
  let child: Oid = newBlob.value;
  for (const { treeOid: oldOid, data, entry } of levels.toReversed()) {
    const newData: Uint8Array = treeReplaceOid(data, entry, child);
    const newOid = hashObject('tree', newData);
    const delta = spliceDelta({ baseLen: data.length, off: entry.oidOffset, oldLen: 20, insert: fromHex(child) }).delta;
    trees.unshift({ type: TYPE.TREE, data: delta, baseOid: oldOid, newOid, newData });
    child = newOid;
  }
  const lines = people(author, committer, time);
  if (!lines.ok) return lines;
  const body = message.endsWith('\n') ? message : `${message}\n`;
  const encoded = encodeCommitOf({ tree: child, parents: [parent.value], author: lines.value.who, committer: lines.value.written, message: body });
  if (!encoded.ok) return encoded;
  const commitData = encoded.value;
  const newCommit = hashObject('commit', commitData);
  const objects: PackInput[] = [
    { type: TYPE.COMMIT, data: commitData },
    ...trees.map((t): PackInput => ({ type: t.type, data: t.data, base: { tag: 'ref', oid: t.baseOid } })),
    blob.delta.length >= 4 ? { type: TYPE.BLOB, data: blob.delta, base: { tag: 'ref', oid: blob.oldOid } } : { type: TYPE.BLOB, data: new Uint8Array(blob.newLen) },
  ];
  return ok({ trees, newTree: child, commitData, newCommit, objects });
}

export function withCommitData(built: Built, commitData: Uint8Array): Built {
  const newCommit = hashObject('commit', commitData);
  return { ...built, commitData, newCommit, objects: [{ type: TYPE.COMMIT, data: commitData }, ...built.objects.slice(1)] };
}

export function buildCommitData({ tree, parents, author, committer = null, time, message }: Stamp & { readonly tree: Oid; readonly parents: readonly Oid[] }): Result<{ readonly data: Uint8Array; readonly oid: Oid }, BadRequest> {
  const lines = people(author, committer, time);
  if (!lines.ok) return lines;
  const body = message.endsWith('\n') ? message : `${message}\n`;
  const encoded = encodeCommitOf({ tree, parents, author: lines.value.who, committer: lines.value.written, message: body });
  if (!encoded.ok) return encoded;
  return ok({ data: encoded.value, oid: hashObject('commit', encoded.value) });
}
