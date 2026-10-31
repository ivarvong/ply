// Rebase, squash, cherry-pick, revert: each is the three-way tree merge from merge.js with different arguments and a
// different commit on top (see the table in README). All are git operations over receive-pack; the branch update after a
// rebase is a non-fast-forward push with the old tip as the CAS.
//
//   op          base                 ours        theirs               commit
//   rebase      commit's parent tree new tip     commit tree          parent [new tip], author+message kept, committer now
//   squash      merge-base tree      target      branch tip tree      parent [target]
//   cherry-pick commit's parent tree target      commit tree          parent [target], author+message kept
//               (a root's parent is the empty tree)
//   revert      commit tree          target      commit's parent tree parent [target]
//               (a root's parent is the empty tree)
/* oxlint-disable eslint/require-await, typescript/promise-function-async -- each function keeps its async-ness (a sync throw stays sync); together the two rules forbid a function that forwards a promise */
import type { ValidatedIdent } from './validate.js';
import { thrown as fail, type Extra } from './errors.js';
import { lsRefs } from './lsrefs.js';
import { push } from './push.js';
import { operation } from './operation.js';
import { mergeBase, mergeTrees, blobMerger, uniqueObjects, attributeTree, attributeDrivers, validateAttributes, type AttributeSource, type Author, type Commit, type MergeBlob, type MergeOptions, type OpContext, type PackObject, type PushObject, type PushResult, type Refs, type Signer, type Transport, type TreeCache } from './merge.js';
import { parseCommit, encodeCommit, hashObject, ident, TYPE } from './objects.js';
import { validatePushRef, validateMessage } from './validate.js';
import { signCommit } from './sign.js';
import { short, commitAt, commitBytesAt, isOid, givenOid, assertCommit, stamp } from './mergeio.js';
import { limitError, requireLimit, LIMIT_REBASE_COMMITS } from './limits.js';

// The unconverted modules' functions as this module calls them (see merge.ts).
type Push = (t: Transport, o: { readonly ref: string; readonly oldOid: string; readonly newOid: string; readonly objects: readonly PushObject[] }) => Promise<PushResult>;
type Operation = <R>(op: string, url: string, opts: Readonly<Record<string, unknown>>, body: (ctx: OpContext) => Promise<R>) => Promise<R>;
type EncodeCommit = (c: { readonly tree: string; readonly parents: readonly string[]; readonly author: string; readonly committer: string; readonly encoding: string | null; readonly message: string | null; readonly extra: readonly string[] }) => Uint8Array<ArrayBuffer>;

// A merge_conflict's payload: Detail carries `conflicts`; reasons, commit and replayed are extras.
type ConflictDetail = Extra & { readonly conflicts: readonly string[] };

type Rediff = NonNullable<MergeOptions['rediff']>;

// Pure: headers to carry over when a commit is re-created. A signature does not survive a new tree/parent (git drops it).
export function carriedExtra(extra: readonly string[]): string[] {
  const out: string[] = []; let dropping = false;
  for (const l of extra) { if (l.startsWith('gpgsig')) { dropping = true; continue; } if (dropping && l.startsWith(' ')) continue; dropping = false; out.push(l); }
  return out;
}

export type ChainCommit = Commit & { readonly oid: string };
// Pure: the linear chain of commits from `base` (exclusive) to `tip`, oldest first; throws if a merge commit is in it.
export function linearChain(commits: ReadonlyMap<string, Commit>, tip: string, base: string | null, max: number = LIMIT_REBASE_COMMITS): ChainCommit[] {
  const chain: ChainCommit[] = [];
  // a commit in the chain has exactly one parent: the '' never stands
  for (let c = tip; c !== base; c = commits.get(c)?.parents[0] ?? '') {
    const info = commits.get(c);
    if (!info) throw fail('internal', `commit ${c} not in the fetched history`);
    if (info.parents.length !== 1) throw fail('not_linear', `${c} has ${info.parents.length} parents; only linear branches are rebased`);
    chain.push({ oid: c, ...info });
    if (chain.length > max) throw limitError('rebase chain', chain.length, max);
  }
  return chain.toReversed();
}

// What one rebase or pick shares across its transplants.
type Replay = {
  fetched: number;
  readonly rediff: Rediff;
  readonly attributes: AttributeSource;
  attrTree?: string | null;
  mergeBlob?: MergeBlob;
  contentMerged?: number;
};
type Sides = { readonly base: string | null | undefined; readonly ours: string | null | undefined; readonly theirs: string | null | undefined };
type NewCommit = { readonly parent: string; readonly author: string; readonly committer: string; readonly message: string | null; readonly encoding?: string | null; readonly extra?: readonly string[] };
// A6 pass: Transplant = ok | conflict, tagged.
type Transplant =
  | { readonly oid: string; readonly data: Uint8Array; readonly treeOid: string; readonly objects: PackObject[]; readonly conflicts?: never; readonly reasons?: never }
  | { readonly conflicts: string[]; readonly reasons: Record<string, string> };

// Effect: one transplant — three-way tree merge then a commit on `parent`. Returns { oid, data, treeOid, objects }.
// oxlint-disable-next-line eslint/max-params -- the merge sides, the commit, the signer and the shared replay state
async function transplant(t: Transport, cache: TreeCache, { base, ours, theirs }: Sides, { parent, author, committer, message, encoding = null, extra = [] }: NewCommit, signer: Signer | null, out: Replay): Promise<Transplant> {
  // attributes: 'ours' is the tree being built on (what a worktree rebase/cherry-pick reads); a ref resolves once
  const fixed = out.attributes !== null && !['ours', 'theirs', 'base'].includes(out.attributes);
  const attrTree = fixed ? (out.attrTree ??= await attributeTree(t, out.attributes, {})) : await attributeTree(t, out.attributes, { base, ours, theirs });
  const m = await mergeTrees(t, cache, { base, ours, theirs, mergeBlob: out.mergeBlob ??= blobMerger(t, { maxMergeBlobBytes: requireLimit(t.limits, 'maxMergeBlobBytes'), rediff: out.rediff }), driverFor: attrTree === null ? null : attributeDrivers(t, cache, attrTree) });
  out.fetched += m.fetched;
  if (m.conflicts.length > 0) return { conflicts: m.conflicts, reasons: m.reasons };
  const treeOid: string = m.oid ?? hashObject('tree', new Uint8Array(0));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the JS signature, typed above
  let data = (encodeCommit as unknown as EncodeCommit)({ tree: treeOid, parents: [parent], author, committer, encoding, message, extra });
  if (signer) data = await signCommit(data, signer);
  const oid: string = hashObject('commit', data);
  out.contentMerged = (out.contentMerged ?? 0) + m.contentMerged;
  return { oid, data, treeOid, objects: [...(m.oid === null ? [{ type: TYPE.TREE, data: new Uint8Array(0), oid: treeOid }] : []), ...m.objects, { type: TYPE.COMMIT, data, oid }] };
}

export type RebaseSpec = {
  readonly ref: string;
  readonly onto?: string;
  readonly committer?: Author;
  readonly author?: Author | null;
  readonly time?: number;
  readonly squash?: boolean;
  readonly message?: string | null;
};
// The operation options (auth, tracer, limits, …) pass through to operation(); these are the ones a replay reads.
export type RebaseOptions = {
  readonly cache?: TreeCache;
  readonly signer?: Signer | null;
  readonly rediff?: Rediff;
  readonly attributes?: AttributeSource;
  readonly [option: string]: unknown;
};
export type Replayed = { readonly from: string; readonly to: string; readonly tree: string };
export type RebaseOutcome =
  | { readonly outcome: 'up_to_date' | 'fast_forward'; readonly ref: string; readonly oid: string; readonly commits: 0 }
  | {
    readonly outcome: 'rebase' | 'squash';
    readonly ref: string;
    readonly oid: string;
    readonly oldTip: string;
    readonly onto: string;
    readonly base: string;
    readonly commits: number;
    readonly replayed: Replayed[];
    readonly dropped: string[];
    readonly pushBytes: number;
  };

// Rebase `ref` onto `onto`'s head (or squash it into one commit). The branch is force-updated (CAS on its old tip).
/* oxlint-disable eslint/complexity -- one operation's steps in order; the A6 pass makes the replay a RebaseState machine */
export async function rebaseBranch(url: string, { ref, onto = 'refs/heads/main', committer, author, time = Math.floor(Date.now() / 1000), squash = false, message = null }: RebaseSpec, { cache = new Map(), signer = null, rediff = 'myers', attributes = null, ...opts }: RebaseOptions = {}): Promise<RebaseOutcome> {
  validateAttributes(attributes); validatePushRef(ref, false); const ontoOid = givenOid(onto, 'onto');
  const committerPerson: ValidatedIdent = stamp(committer, time);
  const authorPerson: ValidatedIdent | null = author ? stamp(author, time) : null;
  if (message !== null) validateMessage(message);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the JS signature, typed above
  return (operation as unknown as Operation)('rebase', url, { ...opts, attrs: { 'git.rebase.ref': ref, 'git.rebase.onto': onto, 'git.rebase.squash': squash } }, async ({ t, root, outcome, limits }): Promise<RebaseOutcome> => {
    const { refs }: Refs = await lsRefs(t, ontoOid === null ? [ref, onto] : [ref]);
    const tip = refs.get(ref)?.oid;
    const target = ontoOid ?? refs.get(onto)?.oid;
    if (tip === undefined) throw fail('not_found', `ref ${ref} not found`); if (target === undefined) throw fail('not_found', `ref ${onto} not found`);
    if (ontoOid !== null) await assertCommit(t, ontoOid, 'onto');
    root.set({ 'git.rebase.tip': tip, 'git.rebase.target': target });
    const { bases, commits, verdict } = await mergeBase(t, tip, target);
    // several merge bases mean the branch contains a merge of its own (the commit joining the bases is not in onto),
    // so its chain is not linear
    if (verdict.tag === 'criss-cross') throw fail('not_linear', `${ref} and ${onto} have ${bases.length} merge bases (criss-cross history); rebase needs a linear branch`, { bases } as Extra & { readonly bases: readonly string[] });
    if (verdict.tag === 'unrelated') throw fail('unrelated_histories', `${ref} and ${onto} share no common ancestor within the search depth`);
    // only `found` is left: a verdict added without a base does not compile here
    const { base } = verdict;
    root.set({ 'git.rebase.base': base });
    if (base === target) return outcome('up_to_date', { outcome: 'up_to_date', ref, oid: tip, commits: 0 });
    if (base === tip) { // the branch is behind: rebasing nothing onto target makes the branch equal to target
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the JS signature, typed above
      await (push as unknown as Push)(t, { ref, oldOid: tip, newOid: target, objects: [] });
      return outcome('fast_forward', { outcome: 'fast_forward', ref, oid: target, commits: 0 });
    }
    const chain = linearChain(commits, tip, base, requireLimit(limits, 'maxRebaseCommits'));
    root.set({ 'git.rebase.commits': chain.length });
    // The base may sit exactly at the window's cut: named by its children on both sides, never fetched (mergeBase needs
    // no more than that; #41). Its tree is the first replay's base, so fetch it; every chain commit is above it and in hand.
    if (!commits.has(base)) commits.set(base, await commitAt(t, base));
    const targetTree: string = (await commitAt(t, target)).tree;
    const who: string = ident(committerPerson);
    // a chain commit's one parent is in hand (linearChain)
    const parentTree = (c: Commit): string | undefined => commits.get(c.parents[0] ?? '')?.tree;
    const out: Replay = { fetched: 0, rediff, attributes }; const objects: PackObject[] = []; let cur = target; let curTree = targetTree; const replayed: Replayed[] = []; const dropped: string[] = [];
    // tip !== base, so the chain has a commit
    const [first] = chain;
    const last = chain.at(-1);
    if (squash && first && last) {
      const r = await transplant(t, cache, { base: commits.get(base)?.tree, ours: targetTree, theirs: last.tree }, { parent: target, author: authorPerson ? ident(authorPerson) : first.author, committer: who, message: message ?? `${chain.map(c => (c.message ?? '').replace(/\n+$/u, '')).filter(Boolean).join('\n\n')}\n`, extra: [] }, signer, out);
      if (r.conflicts) throw fail('merge_conflict', `squash of ${short(ref)} onto ${short(onto)} conflicts: ${r.conflicts.slice(0, 8).join(', ')}`, { conflicts: r.conflicts, reasons: r.reasons } as ConflictDetail);
      objects.push(...r.objects); cur = r.oid; replayed.push({ from: last.oid, to: r.oid, tree: r.treeOid });
    } else {
      for (const c of chain) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each commit replays onto the one before it
        const r = await transplant(t, cache, { base: parentTree(c), ours: curTree, theirs: c.tree }, { parent: cur, author: c.author, committer: who, message: c.message, encoding: c.encoding, extra: carriedExtra(c.extra) }, signer, out);
        if (r.conflicts) throw fail('merge_conflict', `replaying ${c.oid.slice(0, 8)} onto ${short(onto)} conflicts: ${r.conflicts.slice(0, 8).map(p => `${p} (${r.reasons[p]})`).join(', ')}`, { conflicts: r.conflicts, reasons: r.reasons, commit: c.oid, replayed } as ConflictDetail);
        // git rebase --empty=drop (the default): a commit that did not start empty but becomes empty is dropped
        if (r.treeOid === curTree && c.tree !== parentTree(c)) { dropped.push(c.oid); continue; }
        objects.push(...r.objects); replayed.push({ from: c.oid, to: r.oid, tree: r.treeOid }); cur = r.oid; curTree = r.treeOid;
      }
    }
    root.set({ 'git.rebase.trees.fetched': out.fetched, 'git.rebase.objects': objects.length, 'git.rebase.dropped': dropped.length });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the JS signature, typed above
    const pushed = await (push as unknown as Push)(t, { ref, oldOid: tip, newOid: cur, objects: uniqueObjects(objects) }); // non-fast-forward: the old tip is the CAS
    return outcome(squash ? 'squash' : 'rebase', { outcome: squash ? 'squash' : 'rebase', ref, oid: cur, oldTip: tip, onto: target, base, commits: chain.length, replayed, dropped, pushBytes: pushed.packBytes }, { 'git.rebase.new_tip': cur, 'git.rebase.push.bytes': pushed.packBytes });
  });
}
/* oxlint-enable eslint/complexity */

// What to do when the transplanted tree is the target's tree. 'stop' is git's default (report empty, write nothing).
// 'keep' is `git cherry-pick --keep-redundant-commits` (implies `--allow-empty`): write the commit on that tree.
// One policy covers both kinds git distinguishes — a commit that was empty, and one that became empty because the
// change is already applied — because both are the same tree here. git 2.43's `revert` has no `--allow-empty`; the
// commit it would write is what `git commit --allow-empty --no-edit` writes from the message revert prepared.
export type EmptyPolicy = 'stop' | 'keep';
export type PickSpec = {
  readonly ref?: string;
  readonly commit: string;
  readonly committer?: Author;
  // a revert's author (git: the one reverting); defaults to the committer. A cherry-pick keeps the commit's author.
  readonly author?: Author | null;
  readonly time?: number;
  readonly revert?: boolean;
  readonly message?: string | null;
  readonly empty?: EmptyPolicy;
};
type PickWritten = {
  readonly ref: string;
  readonly oid: string;
  readonly tree: string;
  readonly onto: string;
  readonly pushBytes: number;
};
export type PickEmpty = { readonly outcome: 'empty'; readonly ref: string; readonly oid: string };
export type PickKept = { readonly outcome: 'kept_empty' } & PickWritten;
export type PickOk = { readonly outcome: 'ok' } & PickWritten;
// 'stop' cannot keep, and 'keep' cannot stop: the policy is part of the result.
export type PickOutcome<E extends EmptyPolicy = EmptyPolicy> =
  [E] extends ['keep'] ? PickKept | PickOk : [E] extends ['stop'] ? PickEmpty | PickOk : PickEmpty | PickKept | PickOk;

function emptyPolicy(value: unknown): EmptyPolicy {
  if (value === undefined || value === 'stop') return 'stop';
  if (value === 'keep') return 'keep';
  // Own decision point: a three-statement function whose thrown fail() uses its parameter is recorded as a wrapper,
  // and the call site would be the decision instead of this check.
  const got = value;
  throw fail('bad_request', "empty must be 'stop' or 'keep'", { what: 'empty', got });
}

// A root's missing parent is the empty tree (mergeTrees' null). git's first parent of a parentless commit.
async function parentTreeAt(t: Transport, parents: readonly string[]): Promise<string | null> {
  const parentOid = parents[0];
  if (parentOid === undefined) return null;
  return (await commitAt(t, parentOid)).tree;
}

// 'stop' reports empty and writes nothing. 'keep' writes that same tree (`kept_empty`). A different tree is `ok`.
function writtenKind(sameTree: boolean, empty: EmptyPolicy): 'empty' | 'kept_empty' | 'ok' {
  if (!sameTree) return 'ok';
  if (empty === 'stop') return 'empty';
  return 'kept_empty';
}

// Cherry-pick (`revert: false`) or revert (`revert: true`) one commit onto `ref`'s head.
// A root commit has no parent: git diffs it against the empty tree (mergeTrees' null), and revert does the same in
// reverse. A merge commit is refused; git cherry-picks one only with `-m` (a mainline ply does not take).
export function pickCommit(url: string, spec: PickSpec & { readonly empty: 'keep' }, opts?: RebaseOptions): Promise<PickKept | PickOk>;
export function pickCommit(url: string, spec: PickSpec & { readonly empty?: 'stop' }, opts?: RebaseOptions): Promise<PickEmpty | PickOk>;
export function pickCommit(url: string, spec: PickSpec, opts?: RebaseOptions): Promise<PickOutcome>;
export async function pickCommit(url: string, { ref = 'refs/heads/main', commit, committer, author, time = Math.floor(Date.now() / 1000), revert = false, message = null, empty: emptyGiven }: PickSpec, { cache = new Map(), signer = null, rediff = 'myers', attributes = null, ...opts }: RebaseOptions = {}): Promise<PickOutcome> {
  validateAttributes(attributes); validatePushRef(ref, false);
  const empty = emptyPolicy(emptyGiven);
  const committerPerson: ValidatedIdent = stamp(committer, time);
  const revertAuthor: ValidatedIdent = author ? stamp(author, time) : committerPerson;
  if (message !== null) validateMessage(message);
  if (!isOid(commit)) throw fail('bad_request', 'commit must be a 40-hex oid');
  const op = revert ? 'revert' : 'cherry_pick';
  const name = `git.${op}`;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the JS signature, typed above
  return (operation as unknown as Operation)(op, url, { ...opts, attrs: { [`${name}.ref`]: ref, [`${name}.commit`]: commit, [`${name}.empty`]: empty } }, async ({ t, outcome }): Promise<PickOutcome> => {
    const { refs }: Refs = await lsRefs(t, [ref]);
    const target = refs.get(ref)?.oid; if (target === undefined) throw fail('not_found', `ref ${ref} not found`);
    const [cT, cC] = await Promise.all([target, commit].map(oid => commitBytesAt(t, oid)));
    const tInfo: Commit = parseCommit(cT?.data ?? new Uint8Array(0), t.limits);
    const c: Commit = parseCommit(cC?.data ?? new Uint8Array(0), t.limits);
    if (c.parents.length > 1) throw fail('not_linear', `${commit} has ${c.parents.length} parents; only single-parent commits are picked`);
    const parentTree = await parentTreeAt(t, c.parents);
    const who: string = ident(committerPerson);
    const out: Replay = { fetched: 0, rediff, attributes };
    const subject = (c.message ?? '').split('\n')[0] ?? '';
    const r = await transplant(t, cache,
      revert ? { base: c.tree, ours: tInfo.tree, theirs: parentTree } : { base: parentTree, ours: tInfo.tree, theirs: c.tree },
      { parent: target, author: revert ? ident(revertAuthor) : c.author, committer: who, message: message ?? (revert ? `Revert "${subject}"\n\nThis reverts commit ${commit}.\n` : c.message), encoding: revert ? null : c.encoding, extra: revert ? [] : carriedExtra(c.extra) }, signer, out);
    if (r.conflicts) throw fail('merge_conflict', `${revert ? 'revert' : 'cherry-pick'} of ${commit.slice(0, 8)} onto ${short(ref)} conflicts: ${r.conflicts.slice(0, 8).join(', ')}`, { conflicts: r.conflicts, reasons: r.reasons } as ConflictDetail);
    const kind = writtenKind(r.treeOid === tInfo.tree, empty);
    if (kind === 'empty') return outcome('empty', { outcome: 'empty', ref, oid: target });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the JS signature, typed above
    const pushed = await (push as unknown as Push)(t, { ref, oldOid: target, newOid: r.oid, objects: uniqueObjects(r.objects) });
    return outcome(kind, { outcome: kind, ref, oid: r.oid, tree: r.treeOid, onto: target, pushBytes: pushed.packBytes }, { [`${name}.new`]: r.oid, [`${name}.tree`]: r.treeOid, [`${name}.trees.fetched`]: out.fetched, [`${name}.push.bytes`]: pushed.packBytes });
  });
}
type CherrySpec = Omit<PickSpec, 'revert'>;
export function cherryPick(url: string, spec: CherrySpec & { readonly empty: 'keep' }, opts?: RebaseOptions): Promise<PickKept | PickOk>;
export function cherryPick(url: string, spec: CherrySpec & { readonly empty?: 'stop' }, opts?: RebaseOptions): Promise<PickEmpty | PickOk>;
export function cherryPick(url: string, spec: CherrySpec, opts?: RebaseOptions): Promise<PickOutcome>;
export function cherryPick(url: string, spec: CherrySpec, opts?: RebaseOptions): Promise<PickOutcome> {
  return pickCommit(url, { ...spec, revert: false }, opts);
}
export function revertCommit(url: string, spec: CherrySpec & { readonly empty: 'keep' }, opts?: RebaseOptions): Promise<PickKept | PickOk>;
export function revertCommit(url: string, spec: CherrySpec & { readonly empty?: 'stop' }, opts?: RebaseOptions): Promise<PickEmpty | PickOk>;
export function revertCommit(url: string, spec: CherrySpec, opts?: RebaseOptions): Promise<PickOutcome>;
export function revertCommit(url: string, spec: CherrySpec, opts?: RebaseOptions): Promise<PickOutcome> {
  return pickCommit(url, { ...spec, revert: true }, opts);
}
