// Resumable transfer, the effects (#238): each function is one exchange with one outcome; the plan is transferplan.ts.
//
//   transferStatus(dst, plan)               ls-refs on the target and temp refs → the next step, or done
//   transferStep(dst, from, plan, step)     one push: that batch's entries, read from the spool, plus its generated
//                                           objects; a batch moves the temp ref one temp commit on (compare-and-swap),
//                                           the final push creates the ref and deletes the temp ref (atomic)
//   runTransfer(dst, from, plan, opts)      the loop: status, step, status... until done or `maxSteps`. After every push
//                                           the refs are read back until they show it (settling: a host's ls-refs can
//                                           lag a push it acknowledged); an `ambiguous` push that never shows is sent
//                                           again, a refusal that the refs do not explain ends the run with its reason
//   copyTree(dst, from, opts)               planTransfer then runTransfer
//   sweepTransfers(dst, opts)               delete temp refs left by abandoned transfers
//
// The caller owns where the loop runs and the spool (a RangeSource over the fetched pack): a Worker that cannot finish
// in one request runs `maxSteps` steps, keeps the plan (plain JSON, checked against its hash) and resumes in the next.
// Nothing about progress is held locally: the next step is read from the destination every time, so a step that
// landed is never sent again (a replay would be `ng … stale ref` anyway: every update is a compare-and-swap).
//
// Spans (each under the transport's parent): git.transfer.run > git.transfer.status, git.transfer.step (> the push's
// wire spans), git.transfer.settle; git.transfer.sweep. Every one carries git.transfer.plan.hash and an outcome.
import type { PlyError } from './errors.js';
import { fail } from './errors.js';
import type { Option, Result } from './result.js';
import { ok, some, none, isSome, getOrElse } from './result.js';
import type { Input } from './absent.js';
import { at, mapGet, withDefaults } from './absent.js';
import { ZERO_OID } from './oid.js';
import type { TransferOpts, TransferPack, TransferPlan, TransferStepPlan, GeneratedObject } from './transferplan.js';
import { checkTransferPlan, planTransfer, rootCommit, tempFor, transferKey, TRANSFER_REF_PREFIX } from './transferplan.js';
import { packSubset } from './packsubset.js';
import { pushPack, pushWithOptions } from './receivecaps.js';
import { lsRefs } from './lsrefs.js';
import type { Span } from './otel.js';
import { KIND } from './otel.js';
import type { Transport, SpanOpts } from './transport.js';
import { spanned, withParent } from './transport.js';

type Oid = TransferPlan['head'];
type PlannedBatch = TransferPlan['pack']['batches'][number];
export type TransferNext = { readonly tag: 'step'; readonly step: number } | { readonly tag: 'done'; readonly head: Oid; readonly tempLeft: boolean };
// done: the ref is at the planned head; tempLeft: a temp ref is still on the destination (a non-atomic last push that
// did not delete it, or a host that kept it), for sweepTransfers. paused: `step` is next; 'max_steps' when this run used
// its pushes, 'settling' when the last push was acknowledged but the refs had not shown it after `settle.reads` reads.
export type TransferRun =
  | { readonly tag: 'done'; readonly head: Oid; readonly pushes: number; readonly tempLeft: boolean }
  | { readonly tag: 'paused'; readonly step: number; readonly pushes: number; readonly reason: 'max_steps' | 'settling' };
// After a push, reads of the refs (at most `reads`, `delayMs` apart) until they show it.
export type SettleConfig = { readonly reads: number; readonly delayMs: number };
// maxSteps: pushes this run may make (default no limit); retries: sends of one step that may stay unsettled (default 2)
export type RunConfig = { readonly maxSteps: number; readonly retries: number; readonly settle: SettleConfig };
export type RunOpts = Input<RunConfig>;
export type SweepOpts = Input<{ readonly prefix: string; readonly keep: readonly string[] }>;
// Measured on Cloudflare Artifacts (2026-11-10, n=64 pushes): the first ls-refs after every ack showed the push (reads
// p50 = p99 = max = 1; ls-refs p50 129 ms, max 448 ms), so 3 reads 200 ms apart cover every lag seen, with headroom.
export const SETTLE_DEFAULTS: SettleConfig = Object.freeze({ reads: 3, delayMs: 200 });

const internal = (t: Transport, attrs: SpanOpts['attrs']): SpanOpts => ({ parent: t.parent, kind: KIND.INTERNAL, attrs, scrub: t.scrub });
const planAttrs = (plan: TransferPlan): SpanOpts['attrs'] => ({ 'git.transfer.plan.hash': plan.hash, 'git.transfer.steps': plan.steps.length });
const optionOr = (o: Option<Oid>, fallback: string): string => getOrElse<string>(o, fallback);
const optionOid = (o: Option<Oid>): string => optionOr(o, '');
// The step whose temp commit `oid` is (none: no step writes it).
function stepOf(plan: TransferPlan, oid: string): Option<number> {
  const found = plan.steps.findIndex(s => s.kind === 'batch' && s.temp === oid);
  return found < 0 ? none : some(found);
}

// Where the transfer stands on `dst`, from its refs alone.
export async function transferStatus(dst: Transport, plan: TransferPlan): Promise<Result<TransferNext, PlyError>> {
  const r = await spanned(dst, 'git.transfer.status', internal(dst, planAttrs(plan)), async (span: Span): Promise<Result<TransferNext, PlyError>> => {
    const listed = await lsRefs(withParent(dst, span), [plan.ref, plan.tempRef]);
    if (!listed.ok) return listed;
    const target = mapGet(listed.value.refs, plan.ref);
    const temp = mapGet(listed.value.refs, plan.tempRef);
    span.set({ 'git.transfer.status.target': isSome(target) ? target.value.oid : '', 'git.transfer.status.temp': isSome(temp) ? temp.value.oid : '' });
    if (isSome(target)) {
      if (target.value.oid !== plan.head) {
        span.set({ 'git.transfer.status.outcome': 'ref_taken' });
        return fail('cas_conflict', `transfer: ${plan.ref} already exists at ${target.value.oid}, not the planned ${plan.head}`, { expected: null, actual: target.value.oid, what: 'ref' });
      }
      span.set({ 'git.transfer.status.outcome': 'done', 'git.transfer.temp_left': isSome(temp) });
      return ok({ tag: 'done', head: plan.head, tempLeft: isSome(temp) });
    }
    const found = isSome(temp) ? stepOf(plan, temp.value.oid) : some(-1);
    if (found.tag === 'none') {
      span.set({ 'git.transfer.status.outcome': 'temp_foreign' });
      return fail('cas_conflict', `transfer: ${plan.tempRef} is at ${isSome(temp) ? temp.value.oid : ''}, which this plan never writes`, { expected: null, actual: isSome(temp) ? temp.value.oid : null, what: 'ref' });
    }
    span.set({ 'git.transfer.status.outcome': 'step', 'git.transfer.step': found.value + 1 });
    return ok({ tag: 'step', step: found.value + 1 });
  });
  return r;
}

// The objects a step adds to its batch: a batch's temp trees and commit, the final step's new commit.
type StepWork = { readonly s: TransferStepPlan; readonly batch: PlannedBatch; readonly objects: readonly GeneratedObject[] };
function generated(from: TransferPack, plan: TransferPlan, step: number, commit: Uint8Array): Result<StepWork, PlyError> {
  const sAt = at(plan.steps, step);
  const batchAt = at(plan.pack.batches, step);
  if (!isSome(sAt) || !isSome(batchAt)) return fail('bad_request', `transfer: step ${step} is not in the plan (${plan.steps.length} steps)`, { what: 'step' });
  const s = sAt.value;
  const batch = batchAt.value;
  if (s.kind === 'final') {
    const root = rootCommit(commit);
    if (!root.ok) return root;
    return root.value.commit.oid === plan.head ? ok({ s, batch, objects: [root.value.commit] }) : fail('bad_request', 'transfer: the commit does not give the planned head', { what: 'commit' });
  }
  const made = tempFor(from.resolved, batch.entries, { key: transferKey(plan), step, steps: plan.steps.length, prev: s.prev });
  if (!made.ok) return made;
  return made.value.commit.oid === s.temp ? ok({ s, batch, objects: made.value.objects }) : fail('bad_request', `transfer: step ${step}'s objects do not give the planned temp commit; the pack is not the one planned`, { what: 'pack' });
}

// A step's ref updates: a batch moves the temp ref (created when there is no prev); the final step creates the ref and,
// when there is a temp ref, deletes it in the same push.
type Command = { readonly ref: string; readonly oldOid: string; readonly newOid: string };
function commandsOf(plan: TransferPlan, s: TransferStepPlan): readonly [Command, ...Command[]] {
  if (s.kind === 'batch') return [{ ref: plan.tempRef, oldOid: optionOr(s.prev, ZERO_OID), newOid: s.temp }];
  const create: Command = { ref: plan.ref, oldOid: ZERO_OID, newOid: plan.head };
  return isSome(s.prev) ? [create, { ref: plan.tempRef, oldOid: s.prev.value, newOid: ZERO_OID }] : [create];
}

// What one push reads: the plan, the spool and the source commit's bytes (the final step rebuilds the new commit).
type StepInput = { readonly from: TransferPack; readonly plan: TransferPlan; readonly step: number; readonly commit: Uint8Array };
async function sendStep(dst: Transport, span: Span, { from, plan, step, commit }: StepInput): Promise<Result<{ readonly step: number }, PlyError>> {
  const checked = checkTransferPlan(plan);
  if (!checked.ok) return checked;
  if (from.pack.trailer !== plan.pack.trailer) return fail('bad_request', `transfer: the pack (trailer ${from.pack.trailer}) is not the planned one (${plan.pack.trailer})`, { what: 'pack' });
  const extras = generated(from, plan, step, commit);
  if (!extras.ok) return extras;
  const { s, batch, objects } = extras.value;
  span.set({ 'git.transfer.step.kind': s.kind, 'git.transfer.step.prev': optionOid(s.prev), 'git.transfer.batch.entries': batch.entries.length, 'git.transfer.batch.planned_bytes': batch.packBytes, 'git.transfer.generated.objects': objects.length });
  const subset = await packSubset(from.source, from.pack, batch.entries, { extras: objects.map(o => ({ type: o.type, data: o.data })), outsideBase: plan.pack.crossBatchRef ? 'ref' : 'refuse' });
  if (!subset.ok) return subset;
  span.set({ 'git.transfer.batch.bytes': subset.value.length, 'git.transfer.batch.objects': subset.value.count });
  const commands = commandsOf(plan, s);
  const pushed = await pushPack(dst, { commands, pack: subset.value.stream, length: subset.value.length, atomic: commands.length > 1 && plan.atomic });
  return pushed.ok ? ok({ step }) : pushed;
}

// One push: step `step` of `plan`, its entries read from `from.source`. `commit` is the source commit's bytes (the
// final step rebuilds the new commit from them). Every update is a compare-and-swap, so a step that already landed is
// refused by the server (`ng … stale ref`), never applied twice.
export async function transferStep(dst: Transport, from: TransferPack, plan: TransferPlan, step: number, commit: Uint8Array): Promise<Result<{ readonly step: number }, PlyError>> {
  const r = await spanned(dst, 'git.transfer.step', internal(dst, { ...planAttrs(plan), 'git.transfer.step': step }), async (span: Span): Promise<Result<{ readonly step: number }, PlyError>> => {
    const sent = await sendStep(withParent(dst, span), span, { from, plan, step, commit });
    span.set({ 'git.transfer.step.outcome': sent.ok ? 'landed' : sent.error.code });
    return sent;
  });
  return r;
}

const pause = async (ms: number): Promise<void> => { if (ms > 0) await new Promise<void>(resolve => { setTimeout(resolve, ms); }); };
// Settling: the refs read back after a push of `step` until they show it (the transfer past `step`, or done), at most
// `left` reads. 'moved' carries the status that showed it; 'still' the last one that did not.
type Settled = { readonly tag: 'moved'; readonly next: TransferNext } | { readonly tag: 'still'; readonly reads: number };
async function settleFrom(dst: Transport, plan: TransferPlan, step: number, cfg: SettleConfig, reads: number): Promise<Result<Settled, PlyError>> {
  if (reads >= cfg.reads) return ok({ tag: 'still', reads });
  if (reads > 0) await pause(cfg.delayMs);
  const next = await transferStatus(dst, plan);
  if (!next.ok) return next;
  if (next.value.tag === 'done' || next.value.step > step) return ok({ tag: 'moved', next: next.value });
  return settleFrom(dst, plan, step, cfg, reads + 1);
}
async function settle(dst: Transport, plan: TransferPlan, step: number, cfg: SettleConfig): Promise<Result<Settled, PlyError>> {
  const settled = await spanned(dst, 'git.transfer.settle', internal(dst, { ...planAttrs(plan), 'git.transfer.step': step }), async (span: Span): Promise<Result<Settled, PlyError>> => {
    const r = await settleFrom(withParent(dst, span), plan, step, cfg, 0);
    if (r.ok) span.set({ 'git.transfer.settle.outcome': r.value.tag, 'git.transfer.settle.reads': r.value.tag === 'still' ? r.value.reads : 0 });
    return r;
  });
  return settled;
}

// A refusal a lagging read can explain: the step was sent again because the refs had not shown it landing yet.
const refusedResend = (e: PlyError): boolean => e.code === 'cas_conflict' || e.code === 'not_fast_forward';

type Loop = { readonly pushes: number; readonly unsettled: number; readonly last: number };
type Run = { readonly dst: Transport; readonly span: Span; readonly from: TransferPack; readonly plan: TransferPlan; readonly commit: Uint8Array; readonly cfg: RunConfig };
// One turn of the loop, then the next by recursion (each push waits on the status the last one left).
async function turn(run: Run, known: Option<TransferNext>, st: Loop): Promise<Result<TransferRun, PlyError>> {
  const { dst, span, from, plan, commit, cfg } = run;
  const read = known.tag === 'some' ? ok(known.value) : await transferStatus(dst, plan);
  if (!read.ok) return read;
  const next = read.value;
  if (next.tag === 'done') return ok({ tag: 'done', head: next.head, pushes: st.pushes, tempLeft: next.tempLeft });
  const { step } = next;
  if (st.pushes >= cfg.maxSteps) return ok({ tag: 'paused', step, pushes: st.pushes, reason: 'max_steps' });
  const unsettled = step === st.last ? st.unsettled + 1 : 0;
  if (unsettled > cfg.retries) return fail('ambiguous', `transfer: step ${step} did not land after ${unsettled} tries`, { what: 'step' });
  const sent = await transferStep(dst, from, plan, step, commit);
  const pushes = st.pushes + 1;
  span.set({ 'git.transfer.pushes': pushes });
  // a refusal no lagging read can explain, or a failure before the push went out: the run's answer
  if (!sent.ok && sent.error.code !== 'ambiguous' && !refusedResend(sent.error)) return sent;
  const settled = await settle(dst, plan, step, cfg.settle);
  if (!settled.ok) return settled;
  const loop = { pushes, unsettled, last: step };
  if (settled.value.tag === 'moved') return turn(run, some(settled.value.next), loop);
  // the refs still show `step`: acknowledged, a later run reads them again; refused, the refusal stands; ambiguous, send again
  if (sent.ok) return ok({ tag: 'paused', step, pushes, reason: 'settling' });
  if (sent.error.code !== 'ambiguous') return sent;
  return turn(run, none, loop);
}

// The loop (see the top of this file). After a push the refs are read back (settle) until they show it: an
// acknowledged push the refs never show pauses the run ('settling'), so the step is not sent again on a lagging read; an
// `ambiguous` push the refs do not show is sent again, at most `retries` times in a row; a refusal (a step sent again
// after a lagging read) stands only if the refs, settled, do not show the step landed.
export async function runTransfer(dst: Transport, from: TransferPack, plan: TransferPlan, commit: Uint8Array, opts: RunOpts = {}): Promise<Result<TransferRun, PlyError>> {
  const cfg = withDefaults<RunConfig>(opts, { maxSteps: Number.POSITIVE_INFINITY, retries: 2, settle: SETTLE_DEFAULTS });
  const run = await spanned(dst, 'git.transfer.run', internal(dst, { ...planAttrs(plan), 'git.transfer.ref': plan.ref, 'git.transfer.head': plan.head }), async (span: Span): Promise<Result<TransferRun, PlyError>> => {
    const r = await turn({ dst: withParent(dst, span), span, from, plan, commit, cfg }, none, { pushes: 0, unsettled: 0, last: -1 });
    if (r.ok) span.set({ 'git.transfer.outcome': r.value.tag === 'done' ? 'done' : `paused_${r.value.reason}`, 'git.transfer.pushes': r.value.pushes, 'git.transfer.temp_left': r.value.tag === 'done' && r.value.tempLeft });
    else span.set({ 'git.transfer.outcome': r.error.code });
    return r;
  });
  return run;
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
  const swept = await spanned(dst, 'git.transfer.sweep', internal(dst, { 'git.transfer.sweep.prefix': prefix, 'git.transfer.sweep.kept': kept.length }), async (span: Span): Promise<Result<readonly string[], PlyError>> => {
    const t = withParent(dst, span);
    const keep = new Set(kept);
    const listed = await lsRefs(t, [prefix]);
    if (!listed.ok) return listed;
    const gone = [...listed.value.refs.values()].filter(r => r.name.startsWith(prefix) && !keep.has(r.name));
    const deletes = gone.map(r => ({ ref: r.name, oldOid: r.oid, newOid: ZERO_OID }));
    span.set({ 'git.transfer.sweep.deleted': deletes.length });
    const head = at(deletes, 0);
    if (!isSome(head)) return ok([]);
    const pushed = await pushWithOptions(t, { commands: [head.value, ...deletes.slice(1)] });
    return pushed.ok ? ok(gone.map(r => r.name)) : pushed;
  });
  return swept;
}
