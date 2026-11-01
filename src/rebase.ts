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
//
// Inside, a step that can fail returns a Result; the exported entry points (rebaseBranch, pickCommit, cherryPick,
// revertCommit, linearChain) throw it at the public boundary.
/* oxlint-disable import/max-dependencies -- a replay drives ls-refs, the merge-base search, the tree merge, the object codecs and push */
/* oxlint-disable eslint/require-await, typescript/promise-function-async -- each function keeps its async-ness (a sync throw stays sync); together the two rules forbid a function that forwards a promise */
import type { ValidatedIdent } from './validate.js';
import type { ErrorOf, Extra, Miss, PlyError } from './errors.js';
import type { Option, Result } from './result.js';
import type { Input } from './absent.js';
import type { Rediff } from './linemerge.js';
import type { AttributeSource, Author, Commit, MergeBlob, OpContext, PackObject, PushObject, PushResult, Signer, Transport, TreeCache, Trees } from './merge.js';
import { fail, orThrow } from './errors.js';
import { assertNever, err, getOrElse, mapOption, none, ok, some } from './result.js';
import { at, mapGet, withDefaults } from './absent.js';
import { lsRefs } from './lsrefs.js';
import { push } from './push.js';
import { operation } from './operation.js';
import { mergeBaseResult, mergeTrees, blobMerger, uniqueObjects, attributeTreeResult, attributeDrivers, validateAttributes, operationOpts, refOid, NO_TREES } from './merge.js';
import { parseCommit, encodeCommit, hashObject, ident, TYPE } from './objects.js';
import { validatePushRef, validateMessage } from './validate.js';
import { signCommit } from './sign.js';
import { short, commitAt, commitBytesAt, isOid, givenOid, assertCommit, stamp } from './mergeio.js';
import { limitError, readLimit, LIMIT_REBASE_COMMITS } from './limits.js';

const refMiss = (ref: string): Miss => ({ kind: 'ref', ref, candidates: [ref] });

// push.ts takes a branded Refname; the ref here is validated (validatePushRef) as a plain string (see merge.ts).
type Push = (t: Transport, o: { readonly ref: string; readonly oldOid: string; readonly newOid: string; readonly objects: readonly PushObject[] }) => Promise<PushResult>;

// A merge_conflict's payload: Detail carries `conflicts`; reasons, commit and replayed are extras.
type ConflictDetail = Extra & { readonly conflicts: readonly string[] };

// Pure: headers to carry over when a commit is re-created. A signature does not survive a new tree/parent (git drops it).
export function carriedExtra(extra: readonly string[]): string[] {
  const out: string[] = []; let dropping = false;
  for (const l of extra) { if (l.startsWith('gpgsig')) { dropping = true; continue; } if (dropping && l.startsWith(' ')) continue; dropping = false; out.push(l); }
  return out;
}

export type ChainCommit = Commit & { readonly oid: string };
// Pure: the linear chain of commits from `base` (exclusive) to `tip`, oldest first; a merge commit in it is not_linear.
// Defined as `linearChain` and exported as linearChainResult, so its refusals keep the ids the decision inventory knows
// (linearChain#…, test/space/registry.js and ratchet.json); the throwing form is exported as linearChain.
function linearChain(commits: ReadonlyMap<string, Commit>, tip: string, base: string | null, max: number = LIMIT_REBASE_COMMITS): Result<ChainCommit[], PlyError> {
  const chain: ChainCommit[] = [];
  // a commit in the chain has exactly one parent: the '' never stands
  for (let c = tip; c !== base;) {
    const info = mapGet(commits, c);
    if (info.tag === 'none') return fail('internal', `commit ${c} not in the fetched history`);
    const { parents } = info.value;
    if (parents.length !== 1) return fail('not_linear', `${c} has ${parents.length} parents; only linear branches are rebased`);
    chain.push({ oid: c, ...info.value });
    if (chain.length > max) return err(limitError('rebase chain', chain.length, max));
    c = getOrElse(at(parents, 0), '');
  }
  return ok(chain.toReversed());
}
// The throwing form (the package's linearChain).
function linearChainOrThrow(commits: ReadonlyMap<string, Commit>, tip: string, base: string | null, max: number = LIMIT_REBASE_COMMITS): ChainCommit[] {
  return orThrow(linearChain(commits, tip, base, max));
}
export { linearChain as linearChainResult, linearChainOrThrow as linearChain };

// What one rebase or pick shares across its transplants: the trees fetched, the attribute tree of a fixed source (a ref
// or an oid, resolved once), the line merger (built once), the files merged by content.
type Replay = {
  fetched: number;
  readonly rediff: Rediff;
  readonly attributes: AttributeSource;
  attrTree: Option<string | null>;
  mergeBlob: Option<MergeBlob>;
  contentMerged: number;
};
const replay = (rediff: Rediff, attributes: AttributeSource): Replay => ({ fetched: 0, rediff, attributes, attrTree: none, mergeBlob: none, contentMerged: 0 });
type NewCommit = { readonly parent: string; readonly author: string; readonly committer: string; readonly message: string | null; readonly encoding: string | null; readonly extra: readonly string[] };
// One transplant: the commit written on the merged tree, or the merge's conflicts.
type Transplant =
  | { readonly kind: 'written'; readonly oid: string; readonly data: Uint8Array; readonly treeOid: string; readonly objects: PackObject[] }
  | { readonly kind: 'conflict'; readonly conflicts: string[]; readonly reasons: Record<string, string> };

// The attribute tree for one transplant: 'ours' is the tree being built on (what a worktree rebase/cherry-pick reads);
// a ref or an oid resolves once per replay.
async function attributeTreeFor(t: Transport, out: Replay, trees: Trees): Promise<Result<string | null, PlyError>> {
  const fixed = out.attributes !== null && !['ours', 'theirs', 'base'].includes(out.attributes);
  if (!fixed) return attributeTreeResult(t, out.attributes, trees);
  if (out.attrTree.tag === 'some') return ok(out.attrTree.value);
  const r = await attributeTreeResult(t, out.attributes, NO_TREES);
  if (r.ok) out.attrTree = some(r.value);
  return r;
}
// The replay's line merger, built on first use.
function mergerFor(t: Transport, out: Replay): Result<MergeBlob, PlyError> {
  if (out.mergeBlob.tag === 'some') return ok(out.mergeBlob.value);
  const cap = readLimit(t.limits, 'maxMergeBlobBytes');
  if (!cap.ok) return cap;
  const m = blobMerger(t, cap.value, out.rediff);
  if (m.ok) out.mergeBlob = some(m.value);
  return m;
}

// Effect: one transplant — three-way tree merge then a commit on `parent`.
// oxlint-disable-next-line eslint/max-params -- the merge sides, the commit, the signer and the shared replay state
async function transplant(t: Transport, cache: TreeCache, trees: Trees, { parent, author, committer, message, encoding, extra }: NewCommit, signer: Signer | null, out: Replay): Promise<Result<Transplant, PlyError>> {
  const attrTree = await attributeTreeFor(t, out, trees);
  if (!attrTree.ok) return attrTree;
  const mergeBlob = mergerFor(t, out);
  if (!mergeBlob.ok) return mergeBlob;
  const m = await mergeTrees(t, cache, { ...trees, mergeBlob: mergeBlob.value, driverFor: attrTree.value === null ? null : attributeDrivers(t, cache, attrTree.value) });
  out.fetched += m.fetched;
  if (m.conflicts.length > 0) return ok({ kind: 'conflict', conflicts: m.conflicts, reasons: m.reasons });
  const treeOid: string = m.oid === null ? hashObject('tree', new Uint8Array(0)) : m.oid;
  let data = encodeCommit({ tree: treeOid, parents: [parent], author, committer, encoding, message, extra });
  if (signer) data = await signCommit(data, signer);
  const oid: string = hashObject('commit', data);
  out.contentMerged += m.contentMerged;
  return ok({ kind: 'written', oid, data, treeOid, objects: [...(m.oid === null ? [{ type: TYPE.TREE, data: new Uint8Array(0), oid: treeOid }] : []), ...m.objects, { type: TYPE.COMMIT, data, oid }] });
}

export type RebaseSpecConfig = {
  readonly onto: string;
  readonly committer: Author | null;
  readonly author: Author | null;
  readonly time: number;
  readonly squash: boolean;
  readonly message: string | null;
};
export type RebaseSpec = Input<RebaseSpecConfig> & { readonly ref: string };
const rebaseSpecDefaults = (): RebaseSpecConfig => ({ onto: 'refs/heads/main', committer: null, author: null, time: Math.floor(Date.now() / 1000), squash: false, message: null });
// The operation options (auth, tracer, limits, …) pass through to operation(); these are the ones a replay reads.
export type RebaseConfig = {
  readonly cache: TreeCache;
  readonly signer: Signer | null;
  readonly rediff: Rediff;
  readonly attributes: AttributeSource;
};
export type RebaseOptions = Input<RebaseConfig> & Readonly<Record<string, unknown>>;
const rebaseDefaults = (): RebaseConfig => ({ cache: new Map(), signer: null, rediff: 'myers', attributes: null });
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
// The body runs as one Result-returning step inside the operation (an Err is thrown there, so the operation records its
// code on the root span); its refusals keep the names the decision inventory knows them by (rebaseBranch#…).
/* oxlint-disable eslint/complexity -- one operation's steps in order: refs, merge base, chain, replay, push */
export async function rebaseBranch(url: string, spec: RebaseSpec, options: RebaseOptions = {}): Promise<RebaseOutcome> {
  const { onto, committer, author, time, squash, message } = withDefaults(spec, rebaseSpecDefaults());
  const { ref } = spec;
  const { cache, signer, rediff, attributes: attributesGiven } = withDefaults(options, rebaseDefaults());
  const attributes = orThrow(validateAttributes(attributesGiven)); validatePushRef(ref, false); const ontoOid = orThrow(givenOid(onto, 'onto'));
  const committerPerson: ValidatedIdent = stamp(committer, time);
  const authorPerson: ValidatedIdent | null = author ? stamp(author, time) : null;
  if (message !== null) validateMessage(message);
  return operation('rebase', url, operationOpts(options, { 'git.rebase.ref': ref, 'git.rebase.onto': onto, 'git.rebase.squash': squash }), async ({ t, root, outcome, limits }: OpContext): Promise<RebaseOutcome> => orThrow(await (async (): Promise<Result<RebaseOutcome, PlyError>> => {
    const { refs } = await lsRefs(t, ontoOid.tag === 'none' ? [ref, onto] : [ref]);
    const tipAt = refOid(refs, ref);
    const targetAt = ontoOid.tag === 'some' ? ontoOid : refOid(refs, onto);
    if (tipAt.tag === 'none') return fail('not_found', `ref ${ref} not found`, { miss: refMiss(ref) });
    if (targetAt.tag === 'none') return fail('not_found', `ref ${onto} not found`, { miss: refMiss(onto) });
    const tip = tipAt.value;
    const target = targetAt.value;
    if (ontoOid.tag === 'some') { const c = await assertCommit(t, ontoOid.value, 'onto'); if (!c.ok) return c; }
    root.set({ 'git.rebase.tip': tip, 'git.rebase.target': target });
    const found = await mergeBaseResult(t, tip, target);
    if (!found.ok) return found;
    const { bases, commits, verdict } = found.value;
    // several merge bases mean the branch contains a merge of its own (the commit joining the bases is not in onto),
    // so its chain is not linear
    if (verdict.tag !== 'found') {
      switch (verdict.tag) {
        case 'criss-cross': return fail('not_linear', `${ref} and ${onto} have ${bases.length} merge bases (criss-cross history); rebase needs a linear branch`, { bases } as Extra & { readonly bases: readonly string[] });
        case 'unrelated': return fail('unrelated_histories', `${ref} and ${onto} share no common ancestor within the search depth`);
      }
      // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
      return assertNever(verdict);
    }
    const { base } = verdict;
    root.set({ 'git.rebase.base': base });
    if (base === target) return ok(outcome('up_to_date', { outcome: 'up_to_date', ref, oid: tip, commits: 0 }));
    if (base === tip) { // the branch is behind: rebasing nothing onto target makes the branch equal to target
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a validated ref as push's Refname (see Push)
      await (push as unknown as Push)(t, { ref, oldOid: tip, newOid: target, objects: [] });
      return ok(outcome('fast_forward', { outcome: 'fast_forward', ref, oid: target, commits: 0 }));
    }
    const maxCommits = readLimit(limits, 'maxRebaseCommits');
    if (!maxCommits.ok) return maxCommits;
    const chained = linearChain(commits, tip, base, maxCommits.value);
    if (!chained.ok) return chained;
    const chain = chained.value;
    root.set({ 'git.rebase.commits': chain.length });
    // The base may sit exactly at the window's cut: named by its children on both sides, never fetched (mergeBase needs
    // no more than that; #41). Its tree is the first replay's base, so fetch it; every chain commit is above it and in hand.
    if (!commits.has(base)) commits.set(base, await commitAt(t, base));
    const targetTree: string = (await commitAt(t, target)).tree;
    const who: string = ident(committerPerson);
    // a commit's tree by oid, among those in hand; a chain commit's one parent is in hand (linearChain)
    const treeOf = (oid: string): string | null => getOrElse(mapOption(mapGet(commits, oid), c => c.tree), null);
    const parentTree = (c: Commit): string | null => treeOf(getOrElse(at(c.parents, 0), ''));
    const out = replay(rediff, attributes); const objects: PackObject[] = []; let cur = target; let curTree = targetTree; const replayed: Replayed[] = []; const dropped: string[] = [];
    // tip !== base, so the chain has a commit
    const first = at(chain, 0);
    const last = at(chain, chain.length - 1);
    if (squash && first.tag === 'some' && last.tag === 'some') {
      const r = await transplant(t, cache, { base: treeOf(base), ours: targetTree, theirs: last.value.tree }, { parent: target, author: authorPerson ? ident(authorPerson) : first.value.author, committer: who, message: message === null ? `${chain.map(c => (c.message === null ? '' : c.message).replace(/\n+$/u, '')).filter(Boolean).join('\n\n')}\n` : message, encoding: null, extra: [] }, signer, out);
      if (!r.ok) return r;
      const w = r.value;
      if (w.kind === 'conflict') return fail('merge_conflict', `squash of ${short(ref)} onto ${short(onto)} conflicts: ${w.conflicts.slice(0, 8).join(', ')}`, { conflicts: w.conflicts, reasons: w.reasons } as ConflictDetail);
      objects.push(...w.objects); cur = w.oid; replayed.push({ from: last.value.oid, to: w.oid, tree: w.treeOid });
    } else {
      for (const c of chain) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each commit replays onto the one before it
        const r = await transplant(t, cache, { base: parentTree(c), ours: curTree, theirs: c.tree }, { parent: cur, author: c.author, committer: who, message: c.message, encoding: c.encoding, extra: carriedExtra(c.extra) }, signer, out);
        if (!r.ok) return r;
        const w = r.value;
        if (w.kind === 'conflict') return fail('merge_conflict', `replaying ${c.oid.slice(0, 8)} onto ${short(onto)} conflicts: ${w.conflicts.slice(0, 8).map(p => `${p} (${w.reasons[p]})`).join(', ')}`, { conflicts: w.conflicts, reasons: w.reasons, commit: c.oid, replayed } as ConflictDetail);
        // git rebase --empty=drop (the default): a commit that did not start empty but becomes empty is dropped
        if (w.treeOid === curTree && c.tree !== parentTree(c)) { dropped.push(c.oid); continue; }
        objects.push(...w.objects); replayed.push({ from: c.oid, to: w.oid, tree: w.treeOid }); cur = w.oid; curTree = w.treeOid;
      }
    }
    root.set({ 'git.rebase.trees.fetched': out.fetched, 'git.rebase.objects': objects.length, 'git.rebase.dropped': dropped.length });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a validated ref as push's Refname (see Push)
    const pushed = await (push as unknown as Push)(t, { ref, oldOid: tip, newOid: cur, objects: uniqueObjects(objects) }); // non-fast-forward: the old tip is the CAS
    return ok(outcome(squash ? 'squash' : 'rebase', { outcome: squash ? 'squash' : 'rebase', ref, oid: cur, oldTip: tip, onto: target, base, commits: chain.length, replayed, dropped, pushBytes: pushed.packBytes }, { 'git.rebase.new_tip': cur, 'git.rebase.push.bytes': pushed.packBytes }));
  })()));
}
/* oxlint-enable eslint/complexity */

// What to do when the transplanted tree is the target's tree. 'stop' is git's default (report empty, write nothing).
// 'keep' is `git cherry-pick --keep-redundant-commits` (implies `--allow-empty`): write the commit on that tree.
// One policy covers both kinds git distinguishes — a commit that was empty, and one that became empty because the
// change is already applied — because both are the same tree here. git 2.43's `revert` has no `--allow-empty`; the
// commit it would write is what `git commit --allow-empty --no-edit` writes from the message revert prepared.
export type EmptyPolicy = 'stop' | 'keep';
export type PickSpecConfig = {
  readonly ref: string;
  readonly committer: Author | null;
  // a revert's author (git: the one reverting); null: the committer. A cherry-pick keeps the commit's author.
  readonly author: Author | null;
  readonly time: number;
  readonly revert: boolean;
  readonly message: string | null;
  readonly empty: EmptyPolicy;
};
export type PickSpec = Input<PickSpecConfig> & { readonly commit: string };
const pickSpecDefaults = (): PickSpecConfig => ({ ref: 'refs/heads/main', committer: null, author: null, time: Math.floor(Date.now() / 1000), revert: false, message: null, empty: 'stop' });
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
// The spec with the default policy: empty left out, or 'stop'.
type Stopping<S> = Omit<S, 'empty'> & Input<{ readonly empty: 'stop' }>;

// A caller's empty policy, checked (a JS caller may pass anything).
function emptyPolicy(value: unknown): Result<EmptyPolicy, ErrorOf<'bad_request'>> {
  if (value === 'stop') return ok('stop');
  if (value === 'keep') return ok('keep');
  // Own decision point: a three-statement function whose fail() uses its parameter is recorded as a wrapper, and the
  // call site would be the decision instead of this check.
  const got = value;
  return fail('bad_request', "empty must be 'stop' or 'keep'", { what: 'empty', got });
}

// A root's missing parent is the empty tree (mergeTrees' null). git's first parent of a parentless commit.
async function parentTreeAt(t: Transport, parents: readonly string[]): Promise<string | null> {
  const parentOid = at(parents, 0);
  if (parentOid.tag === 'none') return null;
  return (await commitAt(t, parentOid.value)).tree;
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
// The body runs as one Result-returning step inside the operation, as rebaseBranch's does.
export function pickCommit(url: string, spec: PickSpec & { readonly empty: 'keep' }, ...options: [] | [RebaseOptions]): Promise<PickKept | PickOk>;
export function pickCommit(url: string, spec: Stopping<PickSpec>, ...options: [] | [RebaseOptions]): Promise<PickEmpty | PickOk>;
export function pickCommit(url: string, spec: PickSpec, ...options: [] | [RebaseOptions]): Promise<PickOutcome>;
export async function pickCommit(url: string, spec: PickSpec, options: RebaseOptions = {}): Promise<PickOutcome> {
  const { ref, committer, author, time, revert, message, empty: emptyGiven } = withDefaults(spec, pickSpecDefaults());
  const { commit } = spec;
  const { cache, signer, rediff, attributes: attributesGiven } = withDefaults(options, rebaseDefaults());
  const attributes = orThrow(validateAttributes(attributesGiven)); validatePushRef(ref, false);
  const empty = orThrow(emptyPolicy(emptyGiven));
  const committerPerson: ValidatedIdent = stamp(committer, time);
  const revertAuthor: ValidatedIdent = author ? stamp(author, time) : committerPerson;
  if (message !== null) validateMessage(message);
  orThrow(isOid(commit) ? ok(commit) : fail('bad_request', 'commit must be a 40-hex oid'));
  const op = revert ? 'revert' : 'cherry_pick';
  const name = `git.${op}`;
  return operation(op, url, operationOpts(options, { [`${name}.ref`]: ref, [`${name}.commit`]: commit, [`${name}.empty`]: empty }), async ({ t, outcome }: OpContext): Promise<PickOutcome> => orThrow(await (async (): Promise<Result<PickOutcome, PlyError>> => {
    const { refs } = await lsRefs(t, [ref]);
    const targetAt = refOid(refs, ref); if (targetAt.tag === 'none') return fail('not_found', `ref ${ref} not found`, { miss: refMiss(ref) });
    const target = targetAt.value;
    const [cT, cC] = await Promise.all([commitBytesAt(t, target), commitBytesAt(t, commit)]);
    const tInfo: Commit = parseCommit(cT.data, t.limits);
    const c: Commit = parseCommit(cC.data, t.limits);
    if (c.parents.length > 1) return fail('not_linear', `${commit} has ${c.parents.length} parents; only single-parent commits are picked`);
    const parentTree = await parentTreeAt(t, c.parents);
    const who: string = ident(committerPerson);
    const out = replay(rediff, attributes);
    const subject = getOrElse(at((c.message === null ? '' : c.message).split('\n'), 0), '');
    // the message git writes when none is given: revert's, or the picked commit's own
    const ownMessage = revert ? `Revert "${subject}"\n\nThis reverts commit ${commit}.\n` : c.message;
    const r = await transplant(t, cache,
      revert ? { base: c.tree, ours: tInfo.tree, theirs: parentTree } : { base: parentTree, ours: tInfo.tree, theirs: c.tree },
      { parent: target, author: revert ? ident(revertAuthor) : c.author, committer: who, message: message === null ? ownMessage : message, encoding: revert ? null : c.encoding, extra: revert ? [] : carriedExtra(c.extra) }, signer, out);
    if (!r.ok) return r;
    const w = r.value;
    if (w.kind === 'conflict') return fail('merge_conflict', `${revert ? 'revert' : 'cherry-pick'} of ${commit.slice(0, 8)} onto ${short(ref)} conflicts: ${w.conflicts.slice(0, 8).join(', ')}`, { conflicts: w.conflicts, reasons: w.reasons } as ConflictDetail);
    const kind = writtenKind(w.treeOid === tInfo.tree, empty);
    if (kind === 'empty') return ok(outcome('empty', { outcome: 'empty', ref, oid: target }));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a validated ref as push's Refname (see Push)
    const pushed = await (push as unknown as Push)(t, { ref, oldOid: target, newOid: w.oid, objects: uniqueObjects(w.objects) });
    return ok(outcome(kind, { outcome: kind, ref, oid: w.oid, tree: w.treeOid, onto: target, pushBytes: pushed.packBytes }, { [`${name}.new`]: w.oid, [`${name}.tree`]: w.treeOid, [`${name}.trees.fetched`]: out.fetched, [`${name}.push.bytes`]: pushed.packBytes }));
  })()));
}
type CherrySpec = Omit<PickSpec, 'revert'>;
export function cherryPick(url: string, spec: CherrySpec & { readonly empty: 'keep' }, ...options: [] | [RebaseOptions]): Promise<PickKept | PickOk>;
export function cherryPick(url: string, spec: Stopping<CherrySpec>, ...options: [] | [RebaseOptions]): Promise<PickEmpty | PickOk>;
export function cherryPick(url: string, spec: CherrySpec, ...options: [] | [RebaseOptions]): Promise<PickOutcome>;
export function cherryPick(url: string, spec: CherrySpec, ...options: [] | [RebaseOptions]): Promise<PickOutcome> {
  return pickCommit(url, { ...spec, revert: false }, ...options);
}
export function revertCommit(url: string, spec: CherrySpec & { readonly empty: 'keep' }, ...options: [] | [RebaseOptions]): Promise<PickKept | PickOk>;
export function revertCommit(url: string, spec: Stopping<CherrySpec>, ...options: [] | [RebaseOptions]): Promise<PickEmpty | PickOk>;
export function revertCommit(url: string, spec: CherrySpec, ...options: [] | [RebaseOptions]): Promise<PickOutcome>;
export function revertCommit(url: string, spec: CherrySpec, ...options: [] | [RebaseOptions]): Promise<PickOutcome> {
  return pickCommit(url, { ...spec, revert: true }, ...options);
}
