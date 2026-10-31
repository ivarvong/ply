// Rebase, squash, cherry-pick, revert: each is the three-way tree merge from merge.js with different arguments and a
// different commit on top (see the table in README). All are git operations over receive-pack; the branch update after a
// rebase is a non-fast-forward push with the old tip as the CAS.
//
//   op          base                 ours        theirs               commit
//   rebase      commit's parent tree new tip     commit tree          parent [new tip], author+message kept, committer now
//   squash      merge-base tree      target      branch tip tree      parent [target]
//   cherry-pick commit's parent tree target      commit tree          parent [target], author+message kept
//   revert      commit tree          target      commit's parent tree parent [target]
import { thrown as fail } from './errors.js';
import { lsRefs } from './lsrefs.js';
import { fetchObject } from './fetch.js';
import { push } from './push.js';
import { operation } from './operation.js';
import { mergeBase, mergeTrees, blobMerger, uniqueObjects, attributeTree, attributeDrivers, validateAttributes } from './merge.js';
import { parseCommit, encodeCommit, hashObject, ident, TYPE } from './objects.js';
import { validateRef, validatePushRef, validateIdent, validateMessage } from './validate.js';
import { signCommit } from './sign.js';
import { limitError, requireLimit, LIMIT_REBASE_COMMITS } from './limits.js';

const short = r => r.replace(/^refs\/heads\//, '');

// Pure: headers to carry over when a commit is re-created. A signature does not survive a new tree/parent (git drops it).
export function carriedExtra(extra) {
  const out = []; let dropping = false;
  for (const l of extra) { if (l.startsWith('gpgsig')) { dropping = true; continue; } if (dropping && l.startsWith(' ')) continue; dropping = false; out.push(l); }
  return out;
}

// Pure: the linear chain of commits from `base` (exclusive) to `tip`, oldest first; throws if a merge commit is in it.
export function linearChain(commits, tip, base, max = LIMIT_REBASE_COMMITS) {
  const chain = [];
  for (let c = tip; c !== base; c = commits.get(c).parents[0]) {
    const info = commits.get(c);
    if (!info) throw fail('internal', `commit ${c} not in the fetched history`);
    if (info.parents.length !== 1) throw fail('not_linear', `${c} has ${info.parents.length} parents; only linear branches are rebased`);
    chain.push({ oid: c, ...info });
    if (chain.length > max) throw limitError('rebase chain', chain.length, max);
  }
  return chain.reverse();
}

// Effect: one transplant — three-way tree merge then a commit on `parent`. Returns { oid, data, treeOid, objects }.
async function transplant(t, cache, { base, ours, theirs }, { parent, author, committer, message, encoding = null, extra = [] }, signer, out) {
  // attributes: 'ours' is the tree being built on (what a worktree rebase/cherry-pick reads); a ref resolves once
  const fixed = out.attributes !== null && !['ours', 'theirs', 'base'].includes(out.attributes);
  const attrTree = fixed ? (out.attrTree ??= await attributeTree(t, out.attributes, {})) : await attributeTree(t, out.attributes, { base, ours, theirs });
  const m = await mergeTrees(t, cache, { base, ours, theirs, mergeBlob: out.mergeBlob ??= blobMerger(t, { maxMergeBlobBytes: requireLimit(t.limits, 'maxMergeBlobBytes'), rediff: out.rediff }), driverFor: attrTree ? attributeDrivers(t, cache, attrTree) : null });
  out.fetched += m.fetched;
  if (m.conflicts.length) return { conflicts: m.conflicts, reasons: m.reasons };
  const treeOid = m.oid ?? hashObject('tree', new Uint8Array(0));
  let data = encodeCommit({ tree: treeOid, parents: [parent], author, committer, encoding, message: message === null ? null : message, extra });
  if (signer) data = await signCommit(data, signer);
  const oid = hashObject('commit', data);
  out.contentMerged = (out.contentMerged ?? 0) + m.contentMerged;
  return { oid, data, treeOid, objects: [...(m.oid === null ? [{ type: TYPE.TREE, data: new Uint8Array(0), oid: treeOid }] : []), ...m.objects, { type: TYPE.COMMIT, data, oid }] };
}

// Rebase `ref` onto `onto`'s head (or squash it into one commit). The branch is force-updated (CAS on its old tip).
export async function rebaseBranch(url, { ref, onto = 'refs/heads/main', committer, author, time = Math.floor(Date.now() / 1000), squash = false, message = null }, { cache = new Map(), signer = null, rediff = 'myers', attributes = null, ...opts } = {}) {
  validateAttributes(attributes); validatePushRef(ref, false); validateRef(onto);
  const committerPerson = validateIdent({ name: committer?.name, email: committer?.email, time, tz: committer?.tz });
  const authorPerson = author ? validateIdent({ name: author.name, email: author.email, time, tz: author.tz }) : null;
  if (message !== null) validateMessage(message);
  return operation('rebase', url, { ...opts, attrs: { 'git.rebase.ref': ref, 'git.rebase.onto': onto, 'git.rebase.squash': squash } }, async ({ t, root, outcome, limits }) => {
    const { refs } = await lsRefs(t, [ref, onto]);
    const tip = refs.get(ref)?.oid, target = refs.get(onto)?.oid;
    if (!tip) throw fail('not_found', `ref ${ref} not found`); if (!target) throw fail('not_found', `ref ${onto} not found`);
    root.set({ 'git.rebase.tip': tip, 'git.rebase.target': target });
    const { base, bases, commits } = await mergeBase(t, tip, target);
    if (bases.length === 0) throw fail('unrelated_histories', `${ref} and ${onto} share no common ancestor within the search depth`);
    // several merge bases mean the branch contains a merge of its own (the commit joining the bases is not in onto), so
    // its chain is not linear
    if (bases.length > 1) throw fail('not_linear', `${ref} and ${onto} have ${bases.length} merge bases (criss-cross history); rebase needs a linear branch`, { bases });
    root.set({ 'git.rebase.base': base });
    if (base === target) return outcome('up_to_date', { outcome: 'up_to_date', ref, oid: tip, commits: 0 });
    if (base === tip) { // the branch is behind: rebasing nothing onto target makes the branch equal to target
      await push(t, { ref, oldOid: tip, newOid: target, objects: [] });
      return outcome('fast_forward', { outcome: 'fast_forward', ref, oid: target, commits: 0 });
    }
    const chain = linearChain(commits, tip, base, requireLimit(limits, 'maxRebaseCommits'));
    root.set({ 'git.rebase.commits': chain.length });
    // The base may sit exactly at the window's cut: named by its children on both sides, never fetched (mergeBase needs
    // no more than that; #41). Its tree is the first replay's base, so fetch it; every chain commit is above it and in hand.
    if (!commits.has(base)) commits.set(base, parseCommit((await fetchObject(t, { oid: base, expectType: TYPE.COMMIT, deepen: 1 })).data, t.limits));
    const targetTree = parseCommit((await fetchObject(t, { oid: target, expectType: TYPE.COMMIT, deepen: 1 })).data, t.limits).tree;
    const who = ident(committerPerson);
    const out = { fetched: 0, rediff, attributes }; const objects = []; let cur = target, curTree = targetTree; const replayed = [], dropped = [];
    if (squash) {
      const first = chain[0], last = chain[chain.length - 1];
      const r = await transplant(t, cache, { base: commits.get(base).tree, ours: targetTree, theirs: last.tree }, { parent: target, author: authorPerson ? ident(authorPerson) : first.author, committer: who, message: message ?? chain.map(c => (c.message ?? '').replace(/\n+$/, '')).filter(Boolean).join('\n\n') + '\n', extra: [] }, signer, out);
      if (r.conflicts) throw fail('merge_conflict', `squash of ${short(ref)} onto ${short(onto)} conflicts: ${r.conflicts.slice(0, 8).join(', ')}`, { conflicts: r.conflicts });
      objects.push(...r.objects); cur = r.oid; replayed.push({ from: last.oid, to: r.oid, tree: r.treeOid });
    } else {
      for (const c of chain) {
        const r = await transplant(t, cache, { base: commits.get(c.parents[0]).tree, ours: curTree, theirs: c.tree }, { parent: cur, author: c.author, committer: who, message: c.message, encoding: c.encoding, extra: carriedExtra(c.extra) }, signer, out);
        if (r.conflicts) throw fail('merge_conflict', `replaying ${c.oid.slice(0, 8)} onto ${short(onto)} conflicts: ${r.conflicts.slice(0, 8).map(p => `${p} (${r.reasons[p]})`).join(', ')}`, { conflicts: r.conflicts, reasons: r.reasons, commit: c.oid, replayed });
        // git rebase --empty=drop (the default): a commit that did not start empty but becomes empty is dropped
        if (r.treeOid === curTree && c.tree !== commits.get(c.parents[0]).tree) { dropped.push(c.oid); continue; }
        objects.push(...r.objects); replayed.push({ from: c.oid, to: r.oid, tree: r.treeOid }); cur = r.oid; curTree = r.treeOid;
      }
    }
    root.set({ 'git.rebase.trees.fetched': out.fetched, 'git.rebase.objects': objects.length, 'git.rebase.dropped': dropped.length });
    const pushed = await push(t, { ref, oldOid: tip, newOid: cur, objects: uniqueObjects(objects) }); // non-fast-forward: the old tip is the CAS
    return outcome(squash ? 'squash' : 'rebase', { outcome: squash ? 'squash' : 'rebase', ref, oid: cur, oldTip: tip, onto: target, base, commits: chain.length, replayed, dropped, pushBytes: pushed.packBytes }, { 'git.rebase.new_tip': cur, 'git.rebase.push.bytes': pushed.packBytes });
  });
}

// Cherry-pick (`revert: false`) or revert (`revert: true`) one commit onto `ref`'s head.
export async function pickCommit(url, { ref = 'refs/heads/main', commit, committer, time = Math.floor(Date.now() / 1000), revert = false, message = null }, { cache = new Map(), signer = null, rediff = 'myers', attributes = null, ...opts } = {}) {
  validateAttributes(attributes); validatePushRef(ref, false);
  const committerPerson = validateIdent({ name: committer?.name, email: committer?.email, time, tz: committer?.tz });
  if (message !== null) validateMessage(message);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw fail('bad_request', 'commit must be a 40-hex oid');
  const op = revert ? 'revert' : 'cherry_pick', name = `git.${op}`;
  return operation(op, url, { ...opts, attrs: { [`${name}.ref`]: ref, [`${name}.commit`]: commit } }, async ({ t, root, outcome }) => {
    const { refs } = await lsRefs(t, [ref]);
    const target = refs.get(ref)?.oid; if (!target) throw fail('not_found', `ref ${ref} not found`);
    const [cT, cC] = await Promise.all([target, commit].map(oid => fetchObject(t, { oid, expectType: TYPE.COMMIT, deepen: 1 })));
    const tInfo = parseCommit(cT.data, t.limits), c = parseCommit(cC.data, t.limits);
    if (c.parents.length !== 1) throw fail('not_linear', `${commit} has ${c.parents.length} parents; only single-parent commits are picked`);
    const p = parseCommit((await fetchObject(t, { oid: c.parents[0], expectType: TYPE.COMMIT, deepen: 1 })).data, t.limits);
    const who = ident(committerPerson);
    const out = { fetched: 0, rediff, attributes };
    const subject = (c.message ?? '').split('\n')[0];
    const r = await transplant(t, cache,
      revert ? { base: c.tree, ours: tInfo.tree, theirs: p.tree } : { base: p.tree, ours: tInfo.tree, theirs: c.tree },
      { parent: target, author: revert ? who : c.author, committer: who, message: message ?? (revert ? `Revert "${subject}"\n\nThis reverts commit ${commit}.\n` : c.message), encoding: revert ? null : c.encoding, extra: revert ? [] : carriedExtra(c.extra) }, signer, out);
    if (r.conflicts) throw fail('merge_conflict', `${revert ? 'revert' : 'cherry-pick'} of ${commit.slice(0, 8)} onto ${short(ref)} conflicts: ${r.conflicts.slice(0, 8).join(', ')}`, { conflicts: r.conflicts });
    if (r.treeOid === tInfo.tree) return outcome('empty', { outcome: 'empty', ref, oid: target });
    const pushed = await push(t, { ref, oldOid: target, newOid: r.oid, objects: uniqueObjects(r.objects) });
    return outcome('ok', { outcome: 'ok', ref, oid: r.oid, tree: r.treeOid, onto: target, pushBytes: pushed.packBytes }, { [`${name}.new`]: r.oid, [`${name}.tree`]: r.treeOid, [`${name}.trees.fetched`]: out.fetched, [`${name}.push.bytes`]: pushed.packBytes });
  });
}
export const cherryPick = (url, spec, opts) => pickCommit(url, { ...spec, revert: false }, opts);
export const revertCommit = (url, spec, opts) => pickCommit(url, { ...spec, revert: true }, opts);
