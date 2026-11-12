// Resumable transfer, the effects (#238): each function is one exchange with one outcome; the plan is transferplan.ts.
//
//   transferStatus(dst, plan, { ref })      ls-refs on the target and temp refs → the next step, or done
//   transferStep(dst, from, plan, step, { commit, ref })   one push: that batch's entries, read from the spool, plus its generated
//                                           objects; a batch moves the temp ref one temp commit on (compare-and-swap),
//                                           the final push creates the ref and deletes the temp ref (atomic)
//   runTransfer(dst, from, plan, opts)      the loop: status, step, status... until done or `maxSteps`. After every push
//                                           the refs are read back until they show it (settling: a host's ls-refs can
//                                           lag a push it acknowledged). A push that is not a clean ok (ambiguous,
//                                           rejected, partial) is judged by those refs: the step landed (by this push
//                                           or another runner's) is progress; it did not and the push was refused is
//                                           that refusal; it did not and the push was ambiguous is sent again, then
//                                           `ambiguous`; the refs could not be read is `ambiguous`
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
import { assertNever, ok, some, none, isSome, getOrElse } from './result.js';
import type { Input } from './absent.js';
import { at, mapGet, withDefaults } from './absent.js';
import { ZERO_OID } from './oid.js';
import type { TransferOpts, TransferPack, TransferPlan, TransferStepPlan, GeneratedObject, PlanExpect } from './transferplan.js';
import { checkTransferPlan, planFitsPack, planTransfer, rootCommit, tempFor, transferKey, TRANSFER_REF_PREFIX } from './transferplan.js';
import { packSubset } from './packsubset.js';
import { pushPackOutcome, pushWithOptions } from './receivecaps.js';
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
// A pause states two facts about the last push this run made, in two fields, because they can differ:
// `lastPush` is what the server answered THIS run's push: 'none' the run made no push; 'acknowledged' its report said
// ok; 'refused' the server refused it; 'unanswered' no report reached this run.
// `lastStep` is what the refs then showed of the step that push carried, whoever landed it: 'none' the run made no
// push; 'landed' the refs show the step (by this push or by another runner's: `lastPush: 'refused'` beside
// `lastStep: 'landed'` is another runner having landed it first); 'not_shown' they did not after `settle.reads` reads.
// 'max_steps' pauses only after a step shown landed (or no push); 'settling' is 'acknowledged' and 'not_shown'. A step
// whose outcome is unknown is never a pause: the run ends `ambiguous` (the push's own error is its `cause`).
export type LastPush = 'none' | 'acknowledged' | 'refused' | 'unanswered';
export type LastStep = 'none' | 'landed' | 'not_shown';
export type TransferRun =
  | { readonly tag: 'done'; readonly head: Oid; readonly pushes: number; readonly tempLeft: boolean }
  | { readonly tag: 'paused'; readonly step: number; readonly pushes: number; readonly reason: 'max_steps' | 'settling'; readonly lastPush: LastPush; readonly lastStep: LastStep };
// After a push, reads of the refs (at most `reads`, `delayMs` apart) until they show it.
export type SettleConfig = { readonly reads: number; readonly delayMs: number };
// maxSteps: pushes this run may make (default no limit); retries: sends of one step that may stay unsettled (default 2)
export type RunConfig = { readonly maxSteps: number; readonly retries: number; readonly settle: SettleConfig };
// with what the plan is held to (PlanExpect): the ref to create, named on every call, and the temp prefix the plan was
// made under when it is not the default
export type RunOpts = Input<RunConfig> & PlanExpect;
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

// Where a checked plan's transfer stands on `dst`, from its refs alone.
async function readStatus(dst: Transport, plan: TransferPlan): Promise<Result<TransferNext, PlyError>> {
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

// Where the transfer stands on `dst`, from its refs alone. The plan is checked first (checkTransferPlan): nothing is
// read for, and no answer is given from, a plan that does not pass.
export async function transferStatus(dst: Transport, plan: TransferPlan, expect: PlanExpect): Promise<Result<TransferNext, PlyError>> {
  const checked = checkTransferPlan(plan, expect);
  if (!checked.ok) return checked;
  const next = await readStatus(dst, checked.value);
  return next;
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
// Err: refused here, before any request to the destination (nothing can have landed). Ok: the push was made, and
// `pushed` is what it came to.
type Pushed = Result<{ readonly step: number }, PlyError>;
async function sendStep(dst: Transport, span: Span, { from, plan, step, commit }: StepInput): Promise<Result<{ readonly pushed: Pushed }, PlyError>> {
  const extras = generated(from, plan, step, commit);
  if (!extras.ok) return extras;
  const { s, batch, objects } = extras.value;
  span.set({ 'git.transfer.step.kind': s.kind, 'git.transfer.step.prev': optionOid(s.prev), 'git.transfer.batch.entries': batch.entries.length, 'git.transfer.batch.planned_bytes': batch.packBytes, 'git.transfer.generated.objects': objects.length });
  const subset = await packSubset(from.source, from.pack, batch.entries, { extras: objects.map(o => ({ type: o.type, data: o.data })), outsideBase: plan.pack.crossBatchRef ? 'ref' : 'refuse', resolved: from.resolved });
  if (!subset.ok) return subset;
  span.set({ 'git.transfer.batch.bytes': subset.value.length, 'git.transfer.batch.objects': subset.value.count });
  const commands = commandsOf(plan, s);
  const sent = await pushPackOutcome(dst, { commands, pack: subset.value.stream, length: subset.value.length, atomic: commands.length > 1 && plan.atomic });
  // pushPack says no push request was made (refused here, or the advertisement was not read): the failure as it is
  if (!sent.requested) return sent.result;
  return ok({ pushed: sent.result.ok ? ok({ step }) : sent.result });
}

// One push: step `step` of `plan` (checked, and held to the pack: planFitsPack), its entries read from `from.source`. `commit` is the source commit's bytes (the
// final step rebuilds the new commit from them). Every update is a compare-and-swap, so a step that already landed is
// refused by the server (`ng … stale ref`), never applied twice.
async function stepSpan(dst: Transport, input: StepInput): Promise<Result<{ readonly pushed: Pushed }, PlyError>> {
  const r = await spanned(dst, 'git.transfer.step', internal(dst, { ...planAttrs(input.plan), 'git.transfer.step': input.step }), async (span: Span): Promise<Result<{ readonly pushed: Pushed }, PlyError>> => {
    const sent = await sendStep(withParent(dst, span), span, input);
    const outcome: Pushed = sent.ok ? sent.value.pushed : sent;
    span.set({ 'git.transfer.step.outcome': outcome.ok ? 'landed' : outcome.error.code });
    if (sent.ok && !sent.value.pushed.ok) span.error(sent.value.pushed.error);
    return sent;
  });
  return r;
}
// The plan is checked first (checkTransferPlan). `given` is the source commit's bytes with what the plan is held to on
// this call (PlanExpect: the ref it creates, the temp prefix it was planned under). A call that names no ref (the bare
// bytes an earlier version took) is refused.
export type StepCommit = PlanExpect & { readonly commit: Uint8Array };
export async function transferStep(dst: Transport, from: TransferPack, plan: TransferPlan, step: number, given: StepCommit): Promise<Result<{ readonly step: number }, PlyError>> {
  const checked = checkTransferPlan(plan, given);
  if (!checked.ok) return checked;
  if (!(given.commit instanceof Uint8Array)) return fail('bad_request', 'transfer: `commit` is the source commit\'s bytes', { what: 'commit' });
  const fits = planFitsPack(checked.value, from.pack, from.resolved);
  if (!fits.ok) return fits;
  const r = await stepSpan(dst, { from, plan: checked.value, step, commit: given.commit });
  return r.ok ? r.value.pushed : r;
}

const pause = async (ms: number): Promise<void> => { if (ms > 0) await new Promise<void>(resolve => { setTimeout(resolve, ms); }); };
// readStatus fails two ways: the refs were read and show a state this plan cannot go on from (`cas_conflict`, which
// no read returns), or they could not be read.
const refsConflict = (e: PlyError): boolean => e.code === 'cas_conflict';
// Settling: the refs read back after a push of `step` until they show it (the transfer past `step`, or done), at most
// `cfg.reads` reads. 'moved' carries the status that showed it; 'still' the reads that did not; 'conflict' the refs
// show another writer's state; 'unread' a read failed: where the destination stands is not known.
type Settled =
  | { readonly tag: 'moved'; readonly next: TransferNext }
  | { readonly tag: 'still'; readonly reads: number }
  | { readonly tag: 'conflict'; readonly error: PlyError }
  | { readonly tag: 'unread'; readonly error: PlyError };
async function settleFrom(dst: Transport, plan: TransferPlan, step: number, cfg: SettleConfig, reads: number): Promise<Settled> {
  if (reads >= cfg.reads) return { tag: 'still', reads };
  if (reads > 0) await pause(cfg.delayMs);
  const next = await readStatus(dst, plan);
  if (!next.ok) return { tag: refsConflict(next.error) ? 'conflict' : 'unread', error: next.error };
  if (next.value.tag === 'done' || next.value.step > step) return { tag: 'moved', next: next.value };
  return settleFrom(dst, plan, step, cfg, reads + 1);
}
async function settle(dst: Transport, plan: TransferPlan, step: number, cfg: SettleConfig): Promise<Settled> {
  const settled = await spanned(dst, 'git.transfer.settle', internal(dst, { ...planAttrs(plan), 'git.transfer.step': step }), async (span: Span): Promise<Result<Settled, PlyError>> => {
    const r = await settleFrom(withParent(dst, span), plan, step, cfg, 0);
    span.set({ 'git.transfer.settle.outcome': r.tag, 'git.transfer.settle.reads': r.tag === 'still' ? r.reads : 0 });
    if (r.tag === 'conflict' || r.tag === 'unread') span.error(r.error);
    return ok(r);
  });
  // the span's function never fails; a tracer that does leaves the destination unread
  return settled.ok ? settled.value : { tag: 'unread', error: settled.error };
}

type Loop = { readonly pushes: number; readonly tries: number; readonly lastPush: LastPush; readonly lastStep: LastStep };
type Run = { readonly dst: Transport; readonly span: Span; readonly from: TransferPack; readonly plan: TransferPlan; readonly commit: Uint8Array; readonly cfg: RunConfig };
type Turn = { readonly step: number; readonly pushes: number; readonly tries: number };
// The step's outcome is unknown: its push's is, and the refs do not show it (or could not be read).
const unknown = (step: number, why: string, cause: PlyError): Result<TransferRun, PlyError> =>
  fail('ambiguous', `transfer: step ${step} ${why}`, { what: 'step', cause, original: cause.code });
// What the run does after a push and the refs read back: end with `result`, or go on from `next` (`tries`: sends of
// that step so far whose outcome is unknown).
type After = { readonly tag: 'end'; readonly result: Result<TransferRun, PlyError> } | { readonly tag: 'go'; readonly next: TransferNext; readonly tries: number; readonly lastStep: LastStep };
const end = (result: Result<TransferRun, PlyError>): After => ({ tag: 'end', result });

// A push the server acknowledged, then the refs: shown, the run goes on; not shown yet, a later run reads them again
// (never sent again on a lagging read); unread after the final push, the acknowledgement is the outcome (every command
// ok: the ref created, the temp ref deleted); unread after a batch, the read's failure (the transfer is not done).
function acknowledged(plan: TransferPlan, settled: Settled, { step, pushes }: Turn): After {
  switch (settled.tag) {
    case 'moved': return { tag: 'go', next: settled.next, tries: 0, lastStep: 'landed' };
    case 'still': return end(ok({ tag: 'paused', step, pushes, reason: 'settling', lastPush: 'acknowledged', lastStep: 'not_shown' }));
    case 'unread': return end(step === plan.steps.length - 1 ? ok({ tag: 'done', head: plan.head, pushes, tempLeft: false }) : { ok: false, error: settled.error });
    case 'conflict': return end({ ok: false, error: settled.error });
  }
  return assertNever(settled);
}
// A push that was not a clean ok (ambiguous, rejected, partial), judged by the destination: the step landed (this push
// or another runner's) is progress; the refs could not be read is ambiguous, carrying the push's own error; it did not
// land and the push was refused is that refusal; it did not land and the push was ambiguous is sent again, at most
// `retries` times and within `maxSteps`, then ambiguous (never a pause: the caller owns the retry policy).
function unclean(cfg: RunConfig, error: PlyError, settled: Settled, { step, pushes, tries }: Turn): After {
  const refused = error.code !== 'ambiguous';
  switch (settled.tag) {
    case 'moved': return { tag: 'go', next: settled.next, tries: 0, lastStep: 'landed' };
    case 'unread': return end(unknown(step, `was pushed (${error.code}) and the refs could not be read: whether it landed is not known`, error));
    case 'conflict': return end({ ok: false, error: refused ? error : settled.error });
    case 'still': {
      if (refused) return end({ ok: false, error });
      if (tries > cfg.retries) return end(unknown(step, `did not land after ${tries} tries`, error));
      if (pushes >= cfg.maxSteps) return end(unknown(step, `did not land: its push's outcome is not known and the refs do not show it (${tries} sent, maxSteps reached)`, error));
      return { tag: 'go', next: { tag: 'step', step }, tries, lastStep: 'not_shown' };
    }
  }
  return assertNever(settled);
}

// What the server answered a push this run made (`ambiguous` is ply's class for a push with no report).
function answered(pushed: Pushed): LastPush {
  if (pushed.ok) return 'acknowledged';
  return pushed.error.code === 'ambiguous' ? 'unanswered' : 'refused';
}
// One turn of the loop, then the next by recursion (each push waits on the status the last one left). `next` is where
// the destination stands; a pause here follows a landed push or none (an unknown one never reaches it).
async function turn(run: Run, next: TransferNext, st: Loop): Promise<Result<TransferRun, PlyError>> {
  const { dst, span, from, plan, commit, cfg } = run;
  if (next.tag === 'done') return ok({ tag: 'done', head: next.head, pushes: st.pushes, tempLeft: next.tempLeft });
  const { step } = next;
  if (st.pushes >= cfg.maxSteps) return ok({ tag: 'paused', step, pushes: st.pushes, reason: 'max_steps', lastPush: st.lastPush, lastStep: st.lastStep });
  const sent = await stepSpan(dst, { from, plan, step, commit });
  // refused here, before any request: nothing to read
  if (!sent.ok) return sent;
  const pushes = st.pushes + 1;
  span.set({ 'git.transfer.pushes': pushes });
  const settled = await settle(dst, plan, step, cfg.settle);
  const { pushed } = sent.value;
  const after = pushed.ok ? acknowledged(plan, settled, { step, pushes, tries: 0 }) : unclean(cfg, pushed.error, settled, { step, pushes, tries: st.tries + 1 });
  return after.tag === 'end' ? after.result : turn(run, after.next, { pushes, tries: after.tries, lastPush: answered(pushed), lastStep: after.lastStep });
}

// The loop (see the top of this file). The destination is the only commit point, so after every push the refs are read
// back (settle) and the run's result is what they show: see `acknowledged` and `unclean`. The plan is checked first
// (checkTransferPlan, held to `opts.tempPrefix` and `opts.ref`), and `commit` must give the planned head, so `done` is
// never answered from a plan that does not pass or for a head the caller's commit does not give.
export async function runTransfer(dst: Transport, from: TransferPack, stored: TransferPlan, commit: Uint8Array, opts: RunOpts): Promise<Result<TransferRun, PlyError>> {
  const cfg = withDefaults<RunConfig>(opts, { maxSteps: Number.POSITIVE_INFINITY, retries: 2, settle: SETTLE_DEFAULTS });
  const checked = checkTransferPlan(stored, opts);
  if (!checked.ok) return checked;
  // the same refusal transferStep gives, before any use of the bytes
  if (!(commit instanceof Uint8Array)) return fail('bad_request', 'transfer: `commit` is the source commit\'s bytes', { what: 'commit' });
  const plan = checked.value;
  const fits = planFitsPack(plan, from.pack, from.resolved);
  if (!fits.ok) return fits;
  const root = rootCommit(commit);
  if (!root.ok) return root;
  if (root.value.commit.oid !== plan.head) return fail('bad_request', 'transfer: the commit does not give the planned head', { what: 'commit' });
  const run = await spanned(dst, 'git.transfer.run', internal(dst, { ...planAttrs(plan), 'git.transfer.ref': plan.ref, 'git.transfer.head': plan.head }), async (span: Span): Promise<Result<TransferRun, PlyError>> => {
    const t = withParent(dst, span);
    const first = await readStatus(t, plan);
    const r = first.ok ? await turn({ dst: t, span, from, plan, commit, cfg }, first.value, { pushes: 0, tries: 0, lastPush: 'none', lastStep: 'none' }) : first;
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
