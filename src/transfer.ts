// Resumable transfer, the effects (#238): each function is one exchange with one outcome; the plan is transferplan.ts.
//
//   transferStatus(dst, plan)               ls-refs on the target and temp refs → the next step, or done
//   transferStep(dst, from, plan, step)     one push: that batch's entries, read from the spool, plus its generated
//                                           objects; a batch moves the temp ref one temp commit on (compare-and-swap),
//                                           the final push creates the ref and deletes the temp ref (atomic)
//   runTransfer(dst, from, plan, opts)      the loop: status, step, status... until done or `maxSteps`; an `ambiguous`
//                                           push is settled by reading the refs back, a refusal ends it with its reason
//   copyTree(dst, from, opts)               planTransfer then runTransfer
//   sweepTransfers(dst, opts)               delete temp refs left by abandoned transfers
//
// The caller owns where the loop runs and the spool (a RangeSource over the fetched pack): a Worker that cannot finish
// in one request runs `maxSteps` steps, keeps the plan (plain JSON, checked against its hash) and resumes in the next.
// Nothing about progress is held locally: the next step is read from the destination every time, so a step that
// landed is never sent again (a replay would be `ng … stale ref` anyway: every update is a compare-and-swap).
import type { PlyError } from './errors.js';
import { fail } from './errors.js';
import type { Result } from './result.js';
import { ok, isSome } from './result.js';
import type { Input } from './absent.js';
import { at, mapGet, withDefaults } from './absent.js';
import { ZERO_OID } from './oid.js';
import type { TransferOpts, TransferPack, TransferPlan, TransferStepPlan, GeneratedObject } from './transferplan.js';
import { checkTransferPlan, planTransfer, rootCommit, tempFor, transferKey, TRANSFER_REF_PREFIX } from './transferplan.js';
import { packSubset } from './packsubset.js';
import { pushPack, pushWithOptions } from './receivecaps.js';
import { lsRefs } from './lsrefs.js';
import type { Transport } from './transport.js';

/* oxlint-disable no-await-in-loop -- a transfer is sequential by design: each step's status is read after the last push */

export type TransferNext = { readonly tag: 'step'; readonly step: number } | { readonly tag: 'done'; readonly head: string; readonly tempLeft: boolean };
export type TransferRun = { readonly tag: 'done'; readonly head: string; readonly pushes: number } | { readonly tag: 'paused'; readonly step: number; readonly pushes: number };
// maxSteps: pushes this run may make (default no limit); retries: sends of one step that may stay unsettled (default 2)
export type RunConfig = { readonly maxSteps: number; readonly retries: number };
export type RunOpts = Input<RunConfig>;
export type SweepOpts = Input<{ readonly prefix: string; readonly keep: readonly string[] }>;

// Where the transfer stands on `dst`, from its refs alone.
export async function transferStatus(dst: Transport, plan: TransferPlan): Promise<Result<TransferNext, PlyError>> {
  const listed = await lsRefs(dst, [plan.ref, plan.tempRef]);
  if (!listed.ok) return listed;
  const target = mapGet(listed.value.refs, plan.ref);
  const temp = mapGet(listed.value.refs, plan.tempRef);
  if (isSome(target)) {
    if (target.value.oid === plan.head) return ok({ tag: 'done', head: plan.head, tempLeft: isSome(temp) });
    return fail('cas_conflict', `transfer: ${plan.ref} already exists at ${target.value.oid}, not the planned ${plan.head}`, { expected: null, actual: target.value.oid, what: 'ref' });
  }
  if (!isSome(temp)) return ok({ tag: 'step', step: 0 });
  const found = plan.steps.findIndex(s => s.temp === temp.value.oid);
  if (found < 0) return fail('cas_conflict', `transfer: ${plan.tempRef} is at ${temp.value.oid}, which this plan never writes`, { expected: null, actual: temp.value.oid, what: 'ref' });
  return ok({ tag: 'step', step: found + 1 });
}

// The objects a step adds to its batch: a batch's temp trees and commit, the final step's new commit.
type StepWork = { readonly s: TransferStepPlan; readonly entries: readonly number[]; readonly objects: readonly GeneratedObject[] };
function generated(from: TransferPack, plan: TransferPlan, step: number, commit: Uint8Array): Result<StepWork, PlyError> {
  const sAt = at(plan.steps, step);
  const batchAt = at(plan.pack.batches, step);
  if (!isSome(sAt) || !isSome(batchAt)) return fail('bad_request', `transfer: step ${step} is not in the plan (${plan.steps.length} steps)`, { what: 'step' });
  const s = sAt.value;
  const batch = batchAt.value;
  if (s.kind === 'final') {
    const root = rootCommit(commit);
    if (!root.ok) return root;
    return root.value.commit.oid === plan.head ? ok({ s, entries: batch.entries, objects: [root.value.commit] }) : fail('bad_request', 'transfer: the commit does not give the planned head', { what: 'commit' });
  }
  const made = tempFor(from.resolved, batch.entries, { key: transferKey(plan), step, steps: plan.steps.length, prev: s.prev });
  if (!made.ok) return made;
  return made.value.commit.oid === s.temp ? ok({ s, entries: batch.entries, objects: made.value.objects }) : fail('bad_request', `transfer: step ${step}'s objects do not give the planned temp commit; the pack is not the one planned`, { what: 'pack' });
}

// One push: step `step` of `plan`, its entries read from `from.source`. `commit` is the source commit's bytes (the
// final step rebuilds the new commit from them). Every update is a compare-and-swap, so a step that already landed is
// refused by the server (`ng … stale ref`), never applied twice.
export async function transferStep(dst: Transport, from: TransferPack, plan: TransferPlan, step: number, commit: Uint8Array): Promise<Result<{ readonly step: number }, PlyError>> {
  const checked = checkTransferPlan(plan);
  if (!checked.ok) return checked;
  if (from.pack.trailer !== plan.pack.trailer) return fail('bad_request', `transfer: the pack (trailer ${from.pack.trailer}) is not the planned one (${plan.pack.trailer})`, { what: 'pack' });
  const extras = generated(from, plan, step, commit);
  if (!extras.ok) return extras;
  const { s, entries, objects } = extras.value;
  const subset = await packSubset(from.source, from.pack, entries, { extras: objects.map(o => ({ type: o.type, data: o.data })), outsideBase: plan.pack.crossBatchRef ? 'ref' : 'refuse' });
  if (!subset.ok) return subset;
  const prev = s.prev === null ? ZERO_OID : s.prev;
  const first = s.kind === 'batch' && s.temp !== null ? { ref: plan.tempRef, oldOid: prev, newOid: s.temp } : { ref: plan.ref, oldOid: ZERO_OID, newOid: plan.head };
  const commands = s.kind === 'final' && s.prev !== null ? [first, { ref: plan.tempRef, oldOid: s.prev, newOid: ZERO_OID }] as const : [first] as const;
  const pushed = await pushPack(dst, { commands, pack: subset.value.stream, length: subset.value.length, atomic: s.kind === 'final' && s.prev !== null && plan.atomic });
  return pushed.ok ? ok({ step }) : pushed;
}

// The loop (see the top of this file). An `ambiguous` push (it may have landed) is settled by the next status read:
// if the refs moved the loop goes on, if not the step is sent again, at most `retries` times in a row.
export async function runTransfer(dst: Transport, from: TransferPack, plan: TransferPlan, commit: Uint8Array, opts: RunOpts = {}): Promise<Result<TransferRun, PlyError>> {
  const { maxSteps, retries } = withDefaults<RunConfig>(opts, { maxSteps: Number.POSITIVE_INFINITY, retries: 2 });
  let pushes = 0;
  let unsettled = 0;
  let last = -1;
  for (;;) {
    const next = await transferStatus(dst, plan);
    if (!next.ok) return next;
    if (next.value.tag === 'done') return ok({ tag: 'done', head: next.value.head, pushes });
    const { step } = next.value;
    if (pushes >= maxSteps) return ok({ tag: 'paused', step, pushes });
    unsettled = step === last ? unsettled + 1 : 0;
    if (unsettled > retries) return fail('ambiguous', `transfer: step ${step} did not land after ${unsettled} tries`, { what: 'step' });
    last = step;
    pushes++;
    const r = await transferStep(dst, from, plan, step, commit);
    if (!r.ok && r.error.code !== 'ambiguous') return r;
  }
}

// Plan and run in one call (a caller with the time to finish, or the first request of several: keep the plan it gives).
export async function copyTree(dst: Transport, from: TransferPack, opts: TransferOpts & RunOpts): Promise<Result<{ readonly plan: TransferPlan; readonly run: TransferRun }, PlyError>> {
  const plan = planTransfer(from.pack, from.resolved, opts);
  if (!plan.ok) return plan;
  const run = await runTransfer(dst, from, plan.value, opts.commit, opts);
  return run.ok ? ok({ plan: plan.value, run: run.value }) : run;
}

// Delete temp refs under `prefix` (default refs/ply/transfer/) but those in `keep`: what an abandoned transfer left.
export async function sweepTransfers(dst: Transport, opts: SweepOpts = {}): Promise<Result<readonly string[], PlyError>> {
  const { prefix, keep: kept } = withDefaults<{ readonly prefix: string; readonly keep: readonly string[] }>(opts, { prefix: TRANSFER_REF_PREFIX, keep: [] });
  const keep = new Set(kept);
  const listed = await lsRefs(dst, [prefix]);
  if (!listed.ok) return listed;
  const gone = [...listed.value.refs.values()].filter(r => r.name.startsWith(prefix) && !keep.has(r.name));
  const deletes = gone.map(r => ({ ref: r.name, oldOid: r.oid, newOid: ZERO_OID }));
  const head = at(deletes, 0);
  if (!isSome(head)) return ok([]);
  const pushed = await pushWithOptions(dst, { commands: [head.value, ...deletes.slice(1)] });
  return pushed.ok ? ok(gone.map(r => r.name)) : pushed;
}
