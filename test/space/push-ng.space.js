// The push-ng space: every rejection reason git's receive-pack can write, as code. The reason axis is git v2.50.0's
// list itself (test/space/git-manifest.json, kind "reject": builtin/receive-pack.c's ng and unpack strings, extracted by
// scripts/git-manifest.mjs on the spaces branch). Each reason carries, as data: the stage of receive-pack that writes it
// (which decides what the other commands of the push get), the commands it can answer, and its class in ply's error
// taxonomy with the reason for it: what a caller can safely do next. The product is generic; the report git writes for a
// cell is derived from receive-pack.c (gitReport), checked against real git where git can be made to write it
// (push-ng.observed.js), and ply's outcome for every cell is checked against the class table (push-ng.test.js).
//
// git sources are v2.50.0 builtin/receive-pack.c: update(), execute_commands(), execute_commands_non_atomic(),
// execute_commands_atomic(), check_aliased_update_internal(), set_connectivity_errors(), reject_updates_to_hidden(),
// update_shallow_info(), read_proc_receive_report(), run_proc_receive_hook(), push_to_deploy(), unpack(), cmd_receive_pack().
import { readFileSync } from 'node:fs';
import { pkt, FLUSH } from '../../src/pktline.js';
import { concat, te } from '../../src/bytes.js';

const MANIFEST = JSON.parse(readFileSync(new URL('./git-manifest.json', import.meta.url), 'utf8'));
export const GIT_SOURCE = MANIFEST.git;
export const MANIFEST_REJECTS = MANIFEST.entries.filter(e => e.kind === 'reject');

export const ZERO = '0'.repeat(40);
// symbolic oids of the rendered (no-network) cells; the observed cells use real commits with the same roles
export const OID = { A: '4'.repeat(40), B: '1'.repeat(40), C: '2'.repeat(40), X: '3'.repeat(40), U: '5'.repeat(40), zero: ZERO };

// ---- the class table: what a caller can safely do next ----
// cas        cas_conflict (retry 'fresh'): nothing moved, and re-reading the ref can change the answer
// nff        not_fast_forward (retry 'no'): nothing moved; the server refuses this history whatever the ref's value
// rejected   push_rejected (retry 'no'): nothing moved; the same request is refused again until a person changes something
// ambiguous  ambiguous (retry 'read'): a proc-receive hook took the command and did not answer for it; it may have acted
// innocent   an atomic push's other members: the culprit's class decides
// unpack     an unpack failure: every command is "unpacker error"; nothing moved (push_rejected)
export const CLASSES = ['cas', 'nff', 'rejected', 'ambiguous', 'innocent', 'unpack'];
export const CODE = { cas: 'cas_conflict', nff: 'not_fast_forward', rejected: 'push_rejected', ambiguous: 'ambiguous', unpack: 'push_rejected' };

// ---- the stages: where in receive-pack the reason is written, and what that does to the other commands ----
// pre      per command, before the ref transaction (connectivity, hidden refs, aliases, shallow): the others go on, even
//          in an atomic push (git's atomic push splits)
// update   inside update(), per command: non-atomic, the others go on; atomic, the first failure stops the transaction
//          and every other command is "atomic push failure"
// commit   the per-ref transaction's commit (non-atomic): the others go on
// all      every command still without an error gets it (pre-receive, migrate, a failed atomic commit, push options)
// proc     a proc-receive hook's answer for its own command: the others go on; atomic, every other command still
//          without an error is "fail to run proc-receive hook" (run_proc_receive_hook returns -1 after any ng)
// procRun  the proc-receive hook could not be run or did not finish: non-atomic, its own commands; atomic, all
// unpack   unpack() failed: the unpack line carries the reason and every command is "unpacker error"
// none     never a command's own failure (the two consequences: "atomic push failure", "unpacker error")
export const STAGES = ['pre', 'update', 'commit', 'all', 'proc', 'procRun', 'unpack', 'none'];

const NON_DELETE = ['create', 'createExists', 'update', 'nonFF', 'stale', 'unknownOld'];
const ALL = [...NON_DELETE, 'delete'];
const EXISTING = ['createExists', 'update', 'nonFF', 'stale', 'unknownOld', 'delete'];
const ONE_CURRENT = 'a repository has one HEAD: one current branch per push';
const DERIVED_BEGIN = 'ref_store_transaction_begin() cannot fail in git v2.50.0 (refs.c: it only allocates)';

// One entry per manifest "reject" id. `commands`: the command shapes for which git writes this reason (others are
// impossible cells, see IMPOSSIBLE). `three`: true, or why three commands cannot all carry it. `pair`: the reason also
// marks the command its culprit aliases. `names`: ref names the reason needs instead of refs/heads/r<i>. `derived`: why
// no observed cell exists (otherwise push-ng.observed.js has a recipe for it). `next`: the justification of `cls`.
export const REASONS = [
  // --- unpack(): the unpack line; every command is "unpacker error" ---
  ...[
    ['eof before pack header was fully read', null],
    ['protocol error (pack signature mismatch detected)', null],
    ['protocol error (pack version unsupported)', null],
    ['unknown error in parse_pack_header', 'parse_pack_header() returns only the three errors above for a header it read; the default case is unreachable'],
    ['unable to create temporary object directory', null],
    ['unpack-objects abnormal exit', null],
    ['index-pack fork failed', 'start_command() failing to fork index-pack cannot be arranged from a request'],
    ['index-pack abnormal exit', null],
  ].map(([text, derived]) => ({ id: `receive-pack.c:reject:${text}`, stage: 'unpack', cls: 'unpack', commands: ALL, three: true, ...(derived ? { derived } : {}),
    next: 'the pack never entered the repository and no ref was touched: resending the same pack fails the same way; the caller needs a different pack or a repaired server' })),
  { id: 'receive-pack.c:reject:unpacker error', stage: 'none', cls: 'unpack', commands: [], three: true,
    next: 'written on every command exactly when unpack failed (execute_commands): the unpack line carries the cause; nothing moved' },

  // --- per command, before the transaction ---
  { id: 'receive-pack.c:reject:missing necessary objects', stage: 'pre', cls: 'rejected', commands: NON_DELETE, three: true,
    next: 'the pack does not complete the new commit\'s history (set_connectivity_errors); the same pack is refused again, so retrying it is futile; a fresh read does not repair a pack' },
  { id: 'receive-pack.c:reject:deny updating a hidden ref', stage: 'pre', cls: 'rejected', commands: NON_DELETE, three: true,
    next: 'receive.hideRefs covers the ref: the server never lets a client write it, whatever its value' },
  { id: 'receive-pack.c:reject:deny deleting a hidden ref', stage: 'pre', cls: 'rejected', commands: ['delete'], three: true,
    next: 'receive.hideRefs covers the ref: the server never lets a client delete it, whatever its value' },
  { id: 'receive-pack.c:reject:broken symref', stage: 'pre', cls: 'rejected', commands: EXISTING, three: true,
    next: 'the ref is a symbolic ref the server cannot resolve (a loop): no value of the old oid makes it writable; the repository needs repair' },
  { id: 'receive-pack.c:reject:inconsistent aliased update', stage: 'pre', cls: 'rejected', pair: true, commands: ['createExists', 'nonFF', 'stale', 'unknownOld', 'delete'], three: true,
    next: 'one push names a symbolic ref and its target with different updates: the request contradicts itself, and resending it is refused again' },
  { id: 'receive-pack.c:reject:shallow update not allowed', stage: 'pre', cls: 'rejected', commands: NON_DELETE, three: true,
    next: 'the pushed history ends at a shallow boundary the server lacks and receive.shallowUpdate is off: the same history is refused again (ply never sends shallow lines; a git client from a shallow clone does)' },

  // --- inside update() ---
  { id: 'receive-pack.c:reject:funny refname', stage: 'update', cls: 'rejected', commands: ['create', 'delete'], three: { delete: 'refs/@ is the one name validateRef accepts that check_refname_format refuses even with REFNAME_ALLOW_ONELEVEL (deletes)' },
    names: (i, cmd) => (cmd === 'delete' ? 'refs/@' : `refs/funny${i}`),
    next: 'the server refuses the ref name itself (check_refname_format): no retry can succeed; ply\'s validateRef lets refs/<one level> and refs/@ through, git does not' },
  { id: 'receive-pack.c:reject:branch is currently checked out', stage: 'update', cls: 'rejected', commands: ALL, three: ONE_CURRENT,
    next: 'receive.denyCurrentBranch refuses the non-bare repository\'s checked-out branch, whatever its value' },
  { id: 'receive-pack.c:reject:bad pack', stage: 'update', cls: 'rejected', commands: NON_DELETE, three: true,
    next: 'the new object is not in the repository after unpack (only with the connectivity check skipped): the same pack fails again' },
  { id: 'receive-pack.c:reject:deletion prohibited', stage: 'update', cls: 'rejected', commands: ['delete'], three: true,
    next: 'receive.denyDeletes: branch deletion is off on this server' },
  { id: 'receive-pack.c:reject:deletion of the current branch prohibited', stage: 'update', cls: 'rejected', commands: ['delete'], three: ONE_CURRENT,
    next: 'receive.denyDeleteCurrent refuses deleting HEAD\'s branch, whatever its value' },
  { id: 'receive-pack.c:reject:Invalid denyDeleteCurrent setting', stage: 'update', cls: 'rejected', commands: ['delete'], three: ONE_CURRENT,
    derived: 'parse_deny_action() maps every config value to a handled deny_action, so the switch\'s default is unreachable',
    next: 'a server misconfiguration: nothing a client resends can change it' },
  { id: 'receive-pack.c:reject:bad ref', stage: 'update', cls: 'cas', commands: ['unknownOld'], three: true,
    next: 'receive.denyNonFastForwards could not parse the old oid the command named: the server does not have it, so the ref is not at it (a stale read of a ref that has since been rewritten): a fresh read names an old oid it has (SAFETY.md I31)' },
  { id: 'receive-pack.c:reject:non-fast-forward', stage: 'update', cls: 'nff', commands: ['nonFF'], three: true,
    next: 'receive.denyNonFastForwards and the new commit does not descend from the old oid the command itself named: that is true of the request whatever the ref\'s value, so a fresh read of the ref cannot help; only a new commit that descends from it can (it was cas_conflict: rebase\'s non-fast-forward push looped on it)' },
  { id: 'receive-pack.c:reject:hook declined', stage: 'update', cls: 'rejected', commands: ALL, three: true,
    next: 'the update hook refused the ref: server policy, not a race' },
  { id: 'receive-pack.c:reject:failed to delete', stage: 'update', cls: 'rejected', commands: ['delete'], three: true,
    derived: 'ref_transaction_delete() queues a deletion and fails only on a name refname_is_safe() refuses, which check_refname_format (funny refname) refused first',
    next: 'the ref store would not queue the deletion: deterministic for this name' },
  { id: 'receive-pack.c:reject:shallow error', stage: 'update', cls: 'rejected', commands: NON_DELETE, three: true,
    derived: 'not arranged: with receive.shallowUpdate=true, a shallow line and a pack lacking a blob above the boundary, git v2.50.0 answered "ok" for one command (the ref moved to a commit whose tree lacks the blob) and, for three, "shallow error" on the first command, then a report without the others\' statuses (ply: ambiguous, a missing status)',
    next: 'receive.shallowUpdate is on and the history above the shallow boundary is incomplete (update_shallow_ref): the same pack fails again' },
  { id: 'receive-pack.c:reject:failed to update ref', stage: 'update', cls: 'cas', commands: NON_DELETE, three: true,
    derived: 'ref_transaction_update() queues an update and fails only on a name check_refname_format refuses, which funny refname refused first',
    next: 'the same text as the commit failure below, so the same class (the report cannot tell them apart)' },
  ...[
    // an unborn branch's empty index needs no refresh, so update-index takes no lock and read-tree is the first to fail (observed)
    ['Up-to-date check failed', EXISTING.filter(c => c !== 'delete'), 'update-index --refresh failed in the server\'s worktree (its index is locked)'],
    ['Working directory has unstaged changes', EXISTING.filter(c => c !== 'delete'), 'the server\'s worktree has unstaged changes'],
    ['Working directory has staged changes', NON_DELETE, 'the server\'s worktree has staged changes'],
    ['Could not update working tree to new HEAD', NON_DELETE, 'read-tree -u -m could not check out the new commit (an untracked file is in the way)'],
    ['push-to-checkout hook declined', NON_DELETE, 'the push-to-checkout hook refused'],
  ].map(([text, commands, why]) => ({ id: `receive-pack.c:reject:${text}`, stage: 'update', cls: 'rejected', commands, three: ONE_CURRENT,
    next: `receive.denyCurrentBranch=updateInstead: ${why}; the push is refused until someone changes the server's worktree` })),
  { id: 'receive-pack.c:reject:denyCurrentBranch = updateInstead needs a worktree', stage: 'update', cls: 'rejected', commands: NON_DELETE, three: ONE_CURRENT,
    derived: 'update() sets do_update_worktree only for a worktree that is not bare, so update_worktree() never sees a bare one',
    next: 'a server misconfiguration: nothing a client resends can change it' },

  // --- the transaction ---
  { id: 'receive-pack.c:reject:failed to update ref#2', stage: 'commit', cls: 'cas', atomic: 'off', commands: ['create', 'createExists', 'stale', 'unknownOld', 'gone'], three: true,
    names: (i, cmd) => (cmd === 'create' ? `refs/heads/r${i}/sub` : null),
    next: 'the ref is not at the old oid the command named (a stale read, a create over an existing ref, a concurrent writer holding the lock): a fresh read and a redo can land. Also written for a D/F conflict (create refs/heads/r0/sub beside refs/heads/r0, observed): a fresh retry is safe but cannot land there, and a caller\'s retry budget bounds it' },
  { id: 'receive-pack.c:reject:atomic transaction failed', stage: 'all', cls: 'cas', atomic: 'on', commands: ['create', 'createExists', 'stale', 'unknownOld', 'gone'], three: true,
    names: (i, cmd) => (cmd === 'create' ? `refs/heads/r${i}/sub` : null),
    next: 'an atomic push\'s single commit failed, which for a stale old oid is git v2.50.0\'s only report (every ref gets this text, none gets "failed to update ref", observed): the same lost race as above, so a fresh read and a redo can land (it was push_rejected: an atomic CAS loss was never retried)' },
  { id: 'receive-pack.c:reject:atomic push failure', stage: 'none', cls: 'innocent', commands: [], three: true,
    next: 'an atomic push\'s other members after one command failed inside update(): nothing moved, and the culprit\'s reason decides the class' },
  { id: 'receive-pack.c:reject:transaction failed to start', stage: 'commit', cls: 'rejected', atomic: 'off', commands: ALL, three: true, derived: DERIVED_BEGIN,
    next: 'the server could not open a ref transaction: a server fault, and nothing moved' },
  { id: 'receive-pack.c:reject:transaction failed to start#2', stage: 'all', cls: 'rejected', atomic: 'on', commands: ALL, three: true, derived: DERIVED_BEGIN,
    next: 'the server could not open a ref transaction: a server fault, and nothing moved' },

  // --- every pending command ---
  { id: 'receive-pack.c:reject:pre-receive hook declined', stage: 'all', cls: 'rejected', commands: ALL, three: true,
    next: 'the pre-receive hook refused the push: server policy, not a race' },
  { id: 'receive-pack.c:reject:unable to migrate objects to permanent storage', stage: 'all', cls: 'rejected', needsPack: true, commands: ALL, three: true,
    next: 'the server could not move the received objects out of quarantine (a storage fault): nothing moved, and a retry needs the server repaired' },
  { id: 'receive-pack.c:reject:inconsistent push options', stage: 'all', cls: 'rejected', commands: ALL, three: true,
    derived: 'needs a signed push (push-cert) whose push options differ from the request\'s; ply never sends a push certificate',
    next: 'the request contradicts its own certificate: resending it is refused again' },

  // --- proc-receive (receive.procReceiveRefs): a hook takes the command instead of receive-pack ---
  { id: 'receive-pack.c:reject:fail to run proc-receive hook', stage: 'procRun', cls: 'ambiguous', commands: ['create'], three: true,
    names: i => `refs/for/r${i}`,
    next: 'the hook could not be run, or did not finish after it was handed the command: it may have acted on the command (a review created) without saying, and the report cannot tell which; read before redoing' },
  { id: 'receive-pack.c:reject:proc-receive failed to report status', stage: 'proc', cls: 'ambiguous', commands: ['create'], three: true,
    names: i => `refs/for/r${i}`,
    next: 'the hook was handed the command and gave no status for it: it may have acted; read before redoing' },
  { id: 'receive-pack.c:reject:failed', stage: 'proc', cls: 'rejected', commands: ['create'], three: true,
    names: i => `refs/for/r${i}`,
    next: 'the proc-receive hook answered "ng <ref>" with no message: it refused the command, as an update hook does' },
];

// git >= 2.51 (the era axis): execute_commands_non_atomic() runs one batched transaction with REF_TRANSACTION_ALLOW_FAILURE
// and reports each rejected ref by ref_transaction_error_msg() (refs.c on git master, 2026-10; CI runs git 2.56). The
// commit failure of "failed to update ref#2" becomes one of these texts, by cause; every other reason is unchanged.
export const BATCHED = [
  { text: 'incorrect old value provided', cls: 'cas', commands: ['stale', 'unknownOld'], next: 'REF_TRANSACTION_ERROR_INCORRECT_OLD_VALUE: the ref is not at the old oid the command named: a fresh read and a redo can land' },
  { text: 'reference already exists', cls: 'cas', commands: ['createExists'], next: 'REF_TRANSACTION_ERROR_CREATE_EXISTS: a create lost to another writer\'s create: a fresh read finds the ref and the redo is an update' },
  { text: 'reference does not exist', cls: 'cas', commands: ['gone'], next: 'REF_TRANSACTION_ERROR_NONEXISTENT_REF: the ref was deleted since the read: a fresh read finds it absent (it was push_rejected: git >= 2.51\'s stale update of a deleted ref was never re-read)' },
  { text: 'refname conflict', cls: 'rejected', commands: ['create'], next: 'REF_TRANSACTION_ERROR_NAME_CONFLICT: a D/F conflict (refs/heads/r0/sub beside refs/heads/r0): no value of the old oid makes the name free; git >= 2.51 tells it apart from a lost race, so ply need not retry it' },
  ...['invalid new value provided', 'expected symref but found regular ref', 'reference conflict due to case-insensitive filesystem', 'unknown failure'].map(text => ({ text, cls: 'rejected', commands: [], next: 'a batched rejection that is not a lost race (a bad new value, a symref expectation, a case-only clash, an unclassified failure): resending is refused again' })),
];
export const batchedText = cmd => BATCHED.find(b => b.commands.includes(cmd))?.text;

// the manifest's text, line and function for each reason
const byId = new Map(MANIFEST_REJECTS.map(e => [e.id, e]));
for (const r of REASONS) { const e = byId.get(r.id); if (e) Object.assign(r, { text: e.text, line: e.line, fn: e.fn }); }
export const reasonByText = text => REASONS.filter(r => r.text === text);

// ---- the axes ----
// reason: the 42 reasons a command can fail with on its own (the two consequences ride along: "atomic push failure" on
// the atomic axis, "unpacker error" on the unpack reasons)
const REASON = { name: 'reason', doc: 'the reason git writes (git-manifest.json "reject")', variants: REASONS.filter(r => r.stage !== 'none').map(r => ({ tag: r.id.replace('receive-pack.c:reject:', ''), reason: r, why: `receive-pack.c:${r.line} ${r.fn}()` })) };
const COMMAND = { name: 'command', doc: 'the failing command\'s shape (old → new, and the ref on the server: at B, B a child of A, C a child of B, X a child of A)', variants: [
  { tag: 'create', old: 'zero', new: 'C', why: 'old = zeros, the ref absent' },
  { tag: 'createExists', old: 'zero', new: 'C', why: 'old = zeros, the ref at B: a create over an existing ref' },
  { tag: 'update', old: 'B', new: 'C', why: 'a fast-forward from the ref\'s value' },
  { tag: 'nonFF', old: 'B', new: 'X', why: 'from the ref\'s value to a commit that does not descend from it (rebase\'s push)' },
  { tag: 'stale', old: 'A', new: 'C', why: 'a stale old oid the server has: the ref moved from A to B since the read' },
  { tag: 'unknownOld', old: 'U', new: 'C', why: 'an old oid the server does not have (the ref was rewritten and the old commit is gone)' },
  { tag: 'delete', old: 'B', new: 'zero', why: 'new = zeros: a deletion (no pack when every command deletes)' },
  { tag: 'gone', old: 'B', new: 'C', why: 'a fast-forward from B, but the ref was deleted since the read (enumerated with the transaction\'s own failures, where it changes the text)' },
] };
const ATOMIC = { name: 'atomic', doc: 'the atomic capability', variants: [
  { tag: 'off', why: 'execute_commands_non_atomic(): one transaction per command' },
  { tag: 'on', why: 'execute_commands_atomic(): one transaction; a failure in update() makes every other command "atomic push failure"' },
] };
const REFS = { name: 'refs', doc: 'how many commands, and which fail', variants: [
  { tag: 'one', n: 1, why: 'one command, the culprit' },
  { tag: 'three', n: 3, why: 'three commands, every one a culprit' },
  { tag: 'mixed', n: 3, why: 'three commands: the middle one is the culprit, its neighbours fast-forward updates that would land alone' },
] };
const ERA = { name: 'era', doc: 'the git whose receive-pack answers', variants: [
  { tag: 'v2.50', why: 'git <= 2.50 (the manifest\'s v2.50.0): one ref transaction per command; a failed commit is "failed to update ref"' },
  { tag: 'v2.51+', why: 'git >= 2.51: one batched transaction with per-ref rejections, reported by ref_transaction_error_msg() (BATCHED)' },
] };
export const AXES = [REASON, COMMAND, ATOMIC, REFS, ERA];
export const axis = name => AXES.find(a => a.name === name);

// ---- impossible cells ----
const threeWhy = (r, cmd) => (r.three === true ? null : typeof r.three === 'string' ? r.three : r.three[cmd] ?? null);
export const IMPOSSIBLE = [
  { why: 'the reason is written only by the other execute_commands_* (atomic-only or non-atomic-only)', test: c => (c.reason.reason.atomic === 'off' && c.atomic.tag === 'on') || (c.reason.reason.atomic === 'on' && c.atomic.tag === 'off') },
  { why: 'git does not write the reason for this command shape (REASONS[].commands; `gone` is enumerated only with the transaction\'s own failures, where it changes the text)', test: c => !c.reason.reason.commands.includes(c.command.tag) },
  { why: 'three commands cannot all carry the reason (REASONS[].three)', test: c => c.refs.tag === 'three' && threeWhy(c.reason.reason, c.command.tag) !== null },
  { why: 'an aliased update needs a second command (the symref\'s target)', test: c => c.refs.tag === 'one' && c.reason.reason.pair },
  { why: 'a push whose every command deletes sends no pack: no unpack, nothing to migrate', test: c => c.refs.tag !== 'mixed' && c.command.tag === 'delete' && (c.reason.reason.stage === 'unpack' || c.reason.reason.needsPack) },
  { why: 'the batched transaction changes only the non-atomic commit failure: every other report is the same on both eras, enumerated once (v2.50)', test: c => c.era.tag === 'v2.51+' && c.reason.reason.id !== 'receive-pack.c:reject:failed to update ref#2' },
];

export function walk(visit = () => {}) {
  const census = { raw: AXES.reduce((n, a) => n * a.variants.length, 1), cells: 0, impossible: IMPOSSIBLE.map(() => 0) };
  const go = (i, cell) => {
    if (i === AXES.length) {
      const bad = IMPOSSIBLE.findIndex(r => r.test(cell));
      if (bad >= 0) { census.impossible[bad]++; return; }
      census.cells++; visit({ ...cell }); return;
    }
    for (const v of AXES[i].variants) go(i + 1, { ...cell, [AXES[i].name]: v });
  };
  go(0, {});
  return census;
}
export const cells = () => { const all = []; walk(c => all.push(c)); return all; };
export const cellId = c => `${c.reason.tag}/${c.command.tag}/atomic ${c.atomic.tag}/${c.refs.tag}/${c.era.tag}`;

// ---- the commands of a cell ----
// culprits: the commands that fail on their own. A pair reason's culprits alias command 0 (their symref's target).
export function culprits(c) {
  const pair = c.reason.reason.pair;
  return { one: [0], three: pair ? [1, 2] : [0, 1, 2], mixed: [1] }[c.refs.tag];
}
export function refNames(c) {
  const r = c.reason.reason, bad = new Set(culprits(c));
  return Array.from({ length: c.refs.n }, (_, i) => (bad.has(i) && r.names?.(i, c.command.tag)) || `refs/heads/r${i}`);
}
// commands as { ref, old, new } with symbolic oids (A B C X U zero); the innocents are fast-forwards B → C
export function commandsOf(c) {
  const bad = new Set(culprits(c)), names = refNames(c);
  return names.map((ref, i) => (bad.has(i) ? { ref, old: c.command.old, new: c.command.new } : { ref, old: 'B', new: 'C' }));
}

// ---- the report git writes for a cell (derived from receive-pack.c; push-ng.observed.js checks it against git) ----
// { unpack: 'ok' | <unpack reason>, refs: [{ ref, ok, reason }] }
export function gitReport(c) {
  const r = c.reason.reason, names = refNames(c), n = names.length, atomic = c.atomic.tag === 'on';
  const bad = new Set([...culprits(c), ...(r.pair ? [0] : [])]);
  const err = Array.from({ length: n }, () => null);
  const own = () => { for (const i of bad) err[i] = r.text; };
  const rest = text => { for (let i = 0; i < n; i++) if (err[i] === null) err[i] = text; };
  switch (r.stage) {
    case 'unpack': return { unpack: r.text, refs: names.map(ref => ({ ref, ok: false, reason: 'unpacker error' })) };
    case 'pre': own(); break;
    case 'commit': if (c.era.tag === 'v2.50') own(); else for (const i of bad) err[i] = batchedText(c.command.tag); break;
    case 'all': rest(r.text); break;
    case 'update':
      if (!atomic) own();
      else { err[Math.min(...bad)] = r.text; rest('atomic push failure'); }
      break;
    case 'proc': own(); if (atomic) rest('fail to run proc-receive hook'); break;
    case 'procRun': if (atomic) rest(r.text); else own(); break;
    default: throw new Error(`gitReport: stage ${r.stage} has no case`);
  }
  return { unpack: 'ok', refs: names.map((ref, i) => (err[i] === null ? { ref, ok: true } : { ref, ok: false, reason: err[i] })) };
}
export const reportLines = rep => [`unpack ${rep.unpack}\n`, ...rep.refs.map(x => (x.ok ? `ok ${x.ref}\n` : `ng ${x.ref} ${x.reason}\n`))];
// report-status without side-band: receive-pack's report() — one pkt per line, then a flush
export const reportBytes = rep => concat([...reportLines(rep).map(l => pkt(te.encode(l))), FLUSH]);

// ---- the expected outcome: from the class table only ----
// { tag: 'landed', refs } | { tag: 'rejected', code } | { tag: 'partial', landed, rejected } | { tag: 'ambiguous' }
const CLASS_OF = new Map();
for (const r of [...REASONS, ...BATCHED]) {
  if (CLASS_OF.has(r.text) && CLASS_OF.get(r.text) !== r.cls) throw new Error(`two classes for one text: ${r.text}`);
  CLASS_OF.set(r.text, r.cls);
}
export const classOf = text => { if (!CLASS_OF.has(text)) throw new Error(`no class for reason ${text}`); return CLASS_OF.get(text); };
export function outcomeOf(rep, { atomic }) {
  if (rep.unpack !== 'ok') return { tag: 'rejected', code: 'push_rejected' };
  const ok = rep.refs.filter(x => x.ok).map(x => x.ref), ng = rep.refs.filter(x => !x.ok);
  if (!ng.length) return { tag: 'landed', refs: ok };
  const cls = ng.map(x => classOf(x.reason));
  if (cls.includes('ambiguous')) return { tag: 'ambiguous' };
  if (ok.length) return atomic ? { tag: 'ambiguous' } : { tag: 'partial', landed: ok, rejected: ng.map(x => x.ref) };
  const code = cls.some(k => k === 'rejected' || k === 'unpack') ? 'push_rejected' : cls.includes('nff') ? 'not_fast_forward' : cls.includes('cas') ? 'cas_conflict' : 'push_rejected';
  return { tag: 'rejected', code };
}
export const expected = c => outcomeOf(gitReport(c), { atomic: c.atomic.tag === 'on' });

// ---- rendering for push() over the fake transport (test/space/harness.js) ----
export function render(c) {
  const commands = commandsOf(c).map(x => ({ ref: x.ref, oldOid: OID[x.old], newOid: OID[x.new] }));
  return {
    commands,
    opts: { sideband: false, reportV2: false, atomic: c.atomic.tag === 'on', pushOptions: [] },
    limits: { maxRefs: 8, maxReportLines: 16, maxPackBytes: 1 << 20 },
    response: { bytes: reportBytes(gitReport(c)), end: 'eof' },
  };
}
