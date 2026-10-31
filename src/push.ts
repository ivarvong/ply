// v0 receive-pack: commands + thin pack in, report-status out. Planning the request, reading the response stream,
// classifying the report and deciding the outcome are pure; `push` is the one effect. Any failure after the body is on
// the wire is 'ambiguous' (the ref may have moved).
import { fail, orThrow, ambiguousAfterPush } from './errors.js';
import type { ErrorOf, PlyError } from './errors.js';
import { ok, err, assertNever } from './result.js';
import type { Result } from './result.js';
import { pkt, FLUSH, pktInit, pktStep } from './pktline.js';
import { td, concat, decodeBytes, decodeChunk } from './bytes.js';
import { parseSideband } from './fetch.js';
import { SIDEBAND_PACK, SIDEBAND_PROGRESS, SIDEBAND_ERROR, OID_HEX_CHARS } from './format.js';
import { buildPack } from './pack.js';
import { frames, coded, clientSpan, UA } from './transport.js';
import { readLimit, limitExceeded } from './limits.js';
import type { Limits } from './limits.js';
import { validatePushRef, validateWire } from './validate.js';

/* oxlint-disable no-magic-numbers -- span tails and the short-oid display width are diagnostics, not wire-format facts */
const SHORT_OID = 8;
const BAND_TAIL = 4096;
const BAND_ATTR = 1024;
const REPORT_KEEP = 64;
/* oxlint-enable no-magic-numbers */
const UNPACK = 'unpack ';
const OK_REF = 'ok ';
const NG_REF = 'ng ';
const OID = new RegExp(`^[0-9a-f]{${OID_HEX_CHARS}}$`, 'u');

export const ZERO_OID: string = '0'.repeat(OID_HEX_CHARS);

// One ref update. create: oldOid = zeros; delete: newOid = zeros.
export type Command = { readonly ref: string; readonly oldOid: string; readonly newOid: string };
// At least one: push reads the first command for its span (an empty list is refused there, by a TypeError coded 'protocol').
export type Commands = readonly [Command, ...Command[]];
// A pkt-line frame as pktStep and the transports' frames() yield it.
export type { Frame } from './transport.js';
import type { Frame, Transport } from './transport.js';
import type { PktState } from './pktline.js';
import type { PackInput, BuiltEntry } from './pack.js';
// oxlint-disable-next-line import/max-dependencies -- the push path: framing, pack, transport, limits, validation, Result
import type { Span } from './otel.js';

// What send-pack.c send_pack() checks against the advertisement before it sends a byte, as a value: the `atomic` and
// `push-options` a push may ask for. receive-pack ignores an `atomic` it did not advertise (the refs land one by one)
// and reads unadvertised option lines as the pack, so the request builder takes these only from a CheckedCaps, which
// only receivecaps.ts checkPushCaps makes (from the server's advertisement). The brand is a type: nothing at run time.
declare const CHECKED: unique symbol;
export type CheckedCaps = { readonly atomic: boolean; readonly pushOptions: readonly string[]; readonly [CHECKED]: true };

// commands: [{ ref, oldOid, newOid }] (create: oldOid = zeros; delete: newOid = zeros). A push with only deletes sends no
// pack. The wire encoder: `caps` is sent as given (push builds it with requestCaps).
export const pushBody = ({ commands, caps = ['report-status', `agent=${UA.replace(/ .*/u, '')}`] }: { readonly commands: readonly Command[]; readonly caps?: readonly string[] }, pack?: Uint8Array | null): Uint8Array<ArrayBuffer> => {
  const lines = commands.map((c, i) => `${c.oldOid} ${c.newOid} ${c.ref}${i === 0 ? `\0${caps.join(' ')}` : ''}\n`);
  return concat([...lines.map(l => pkt(l)), FLUSH, ...(pack ? [pack] : [])]);
};

// ---- the push outcome (pure): wire → stream shape → report shape → outcome → Result, each a tagged union ----
// Principle (SAFETY.md I36): once the request body may have reached the server, ply says "landed" or "not landed" only on
// a report exactly as git's receive-pack writes it (builtin/receive-pack.c report/report_v2, cmd_receive_pack); every
// other post-send state is 'ambiguous'. Each step below is an allowlist: what it does not recognize falls to ambiguous.
// The space of responses and the expected outcome of each cell: test/space/push-outcome.space.js and SPACE.md.

// 1. The stream. A step machine over the outer pkt frames, ending in
//    { tag: 'report', lines } — the report's pkt payloads, framed as git frames them, nothing before or after — or
//    { tag: 'broken', why, remote? } — anything else (band 3, an unknown band, a missing or extra flush, trailing data).
// git's shapes: plain — report pkts, flush (= the report's flush), end; side-band-64k — band 2 (progress, hook stderr)
// and empty band-1 keepalives, then the report pkts and their flush inside band 1, band 2 (post-receive), then the
// outer flush (cmd_receive_pack: packet_flush(1) when use_sideband), end.
export type Broken = { readonly tag: 'broken'; readonly why: string; readonly remote: string | undefined };
export type Reading = {
  readonly tag: 'reading';
  readonly sideband: boolean;
  readonly phase: 'report' | 'reported' | 'done';
  readonly inner: PktState;
  readonly lines: Uint8Array[];
  readonly band2: string;
  readonly band2Carry: Uint8Array;
  readonly band2Frames: number;
};
export type StreamReport = { readonly tag: 'report'; readonly lines: readonly Uint8Array[] };
export type StreamState = Reading | Broken | StreamReport;
const broken = (why: string, remote?: string): Broken => ({ tag: 'broken', why, remote });
// `lines` grows in place (a report can hold limits.maxReportLines lines): a state is not reused once stepped.
export const streamInit = (sideband: boolean): Reading => ({ tag: 'reading', sideband, phase: 'report', inner: pktInit(), lines: [], band2: '', band2Carry: new Uint8Array(0), band2Frames: 0 });
// @decoder streamStep prefix=stream
export function streamStep(st: StreamState, f: Frame): StreamState {
  // Stryker disable next-line ConditionalExpression: push stops stepping at the first non-reading state
  if (st.tag !== 'reading') return st;
  if (st.phase === 'done') return broken('data after the final flush');
  if (f.kind === 'flush') {
    if (!st.sideband || (st.phase === 'reported' && st.inner.carry === null)) return { ...st, phase: 'done' };
    return broken('flush before the report ended');
  }
  // Stryker disable next-line ConditionalExpression: a delim/end frame has no payload, so read as data it still breaks the stream or the report
  if (f.kind !== 'data') return broken(`${f.kind} packet`);
  if (!st.sideband) { st.lines.push(f.payload); return st; }
  const { band, body }: { readonly band: number; readonly body: Uint8Array } = parseSideband(f.payload);
  // decodeChunk: a character cut by a frame boundary is held for the next frame instead of decoding as two U+FFFD (#43)
  if (band === SIDEBAND_PROGRESS) { const d: { readonly text: string; readonly carry: Uint8Array } = decodeChunk(st.band2Carry, body); return { ...st, band2: (st.band2 + d.text).slice(-BAND_TAIL), band2Carry: d.carry, band2Frames: st.band2Frames + 1 }; }
  if (band === SIDEBAND_ERROR) return broken('band 3', td.decode(body).trim());
  if (band !== SIDEBAND_PACK) return broken(`bad sideband ${band}`);
  // an empty band-1 packet is copy_to_sideband's keepalive: sent while hooks run, before the report and after it (post-receive)
  if (body.length === 0) return st;
  // Stryker disable next-line ConditionalExpression: without it, band-1 bytes after the report's flush still break it (the loop below, or the carry at the outer flush)
  if (st.phase !== 'report') return broken('band 1 after the report');
  const r = pktStep(st.inner, body);
  let phase: Reading['phase'] = st.phase;
  for (const g of r.frames) {
    if (phase !== 'report') return broken('band 1 after the report');
    if (g.kind === 'flush') phase = 'reported';
    // Stryker disable next-line ConditionalExpression: a delim/end pkt has no payload; pushed as a line it is not LF-terminated, so the report is malformed
    else if (g.kind === 'data') st.lines.push(g.payload);
    else return broken(`${g.kind} packet in the report`);
  }
  return { ...st, inner: r.state, phase };
}
// Stryker disable next-line ConditionalExpression: a broken state has no phase, so it stays broken either way
export const streamFinish = (st: StreamState): Broken | StreamReport => {
  if (st.tag !== 'reading') return st;
  return st.phase === 'done' ? { tag: 'report', lines: st.lines } : broken('no final flush');
};

// 2. The report. git's grammar, exactly: "unpack ok" or "unpack <one of unpack()'s failure strings>", then for each
// commanded ref exactly one "ok <ref>" or "ng <ref> <reason>" (reason: printable ASCII), every line ending in LF, and
// nothing else (report_v2's option lines come only from a proc-receive hook, which redirects the update: not modelled).
// A step machine over the report's lines, one parser (send-pack.c receive_unpack_status, then receive_status):
//   { tag: 'unpack' }                    — before the first line: it must be git's unpack line
//   { tag: 'refs', unpack, want, seen }  — after it: one well-formed status per commanded ref, each at most once
//   { tag: 'malformed', why }            — anything else (absorbing)
// and reportFinish's shapes:
//   { tag: 'statuses', refs }            — unpack ok, one status per commanded ref
//   { tag: 'unpackFailed', status, refs } — unpack failed and every ref is "ng <ref> unpacker error"
//   { tag: 'malformed', why }
// execute_commands: an unpack failure marks every command "unpacker error", and nothing else does.
export type RefStatus = { readonly ref: string; readonly ok: true; readonly reason: '' } | { readonly ref: string; readonly ok: false; readonly reason: string };
export type Malformed = { readonly tag: 'malformed'; readonly why: string };
export type ReportState =
  | { readonly tag: 'unpack'; readonly want: ReadonlySet<string> }
  | { readonly tag: 'refs'; readonly unpack: string; readonly want: ReadonlySet<string>; readonly seen: Map<string, RefStatus> }
  | Malformed;
export type ReportShape =
  | { readonly tag: 'statuses'; readonly refs: readonly RefStatus[] }
  | { readonly tag: 'unpackFailed'; readonly status: string; readonly refs: readonly RefStatus[] }
  | Malformed;
export const GIT_UNPACK_ERRORS: readonly string[] = Object.freeze([
  'eof before pack header was fully read', 'protocol error (pack signature mismatch detected)', 'protocol error (pack version unsupported)',
  'unknown error in parse_pack_header', 'unable to create temporary object directory', 'unpack-objects abnormal exit', 'index-pack fork failed',
  'index-pack abnormal exit',
]);
const UNPACKER_ERROR = 'unpacker error';
const malformed = (why: string): Malformed => ({ tag: 'malformed', why });
// Stryker disable next-line ConditionalExpression,EqualityOperator,ArrayDeclaration: reportStep calls it on "ng <rest>" only; with no space or a leading one, every split names no commanded ref
const splitOnce = (s: string, sep: string): readonly [string, string?] => { const i = s.indexOf(sep); return i < 0 ? [s] : [s.slice(0, i), s.slice(i + sep.length)]; };
export const reportInit = (commands: ReadonlyArray<{ readonly ref: string }>): ReportState => ({ tag: 'unpack', want: new Set(commands.map(c => c.ref)) });
// `seen` grows in place, as the stream's `lines` do: a state is not reused once stepped.
// @decoder reportStep prefix=report
export function reportStep(st: ReportState, payload: Uint8Array): ReportState {
  if (st.tag === 'malformed') return st;
  // A ref name is bytes (check_refname_format refuses only control bytes, space, ~ ^ : ? * [ and backslash, `..`, `@{` and the
  // dot/slash/.lock rules; any byte >= 0x80 is legal), and receive-pack echoes it as it got it. decodeBytes maps it to
  // the string the command was built from (encodeBytes is its inverse), so `ok <ref>` matches its command (#43).
  const l: string = decodeBytes(payload);
  const line = l.slice(0, l.length - 1);
  if (!l.endsWith('\n') || line.includes('\n')) return malformed('a line is not one LF-terminated line');
  switch (st.tag) {
    case 'unpack': {
      // '' (no unpack line) is neither "ok" nor one of git's failures
      const unpack = line.startsWith(UNPACK) ? line.slice(UNPACK.length) : '';
      return unpack === 'ok' || GIT_UNPACK_ERRORS.includes(unpack) ? { tag: 'refs', unpack, want: st.want, seen: new Map() } : malformed('no git unpack line first');
    }
    case 'refs': {
      const isOk = line.startsWith(OK_REF);
      if (!isOk && !line.startsWith(NG_REF)) return malformed('a line is not a ref status');
      // validateRef forbids spaces in a ref, so the first space after "ng <ref>" ends the ref name
      const rest = line.slice(OK_REF.length);
      const [ref, reason = ''] = isOk ? [rest] : splitOnce(rest, ' ');
      if (!st.want.has(ref)) return malformed('status for a ref not commanded');
      if (st.seen.has(ref)) return malformed(`two statuses for ${ref}`);
      if (isOk) st.seen.set(ref, { ref, ok: true, reason: '' });
      else if (/^[ -~]+$/u.test(reason)) st.seen.set(ref, { ref, ok: false, reason });
      else return malformed(`no readable reason for ${ref}`);
      return st;
    }
    default: return assertNever(st);
  }
}
export function reportFinish(st: ReportState): ReportShape {
  switch (st.tag) {
    case 'malformed': return st;
    case 'unpack': return malformed('no git unpack line first');
    case 'refs': {
      for (const ref of st.want) if (!st.seen.has(ref)) return malformed(`no status for ${ref}`);
      const refs = [...st.seen.values()];
      if (st.unpack !== 'ok') return refs.every(r => !r.ok && r.reason === UNPACKER_ERROR) ? { tag: 'unpackFailed', status: st.unpack, refs } : malformed('unpack failed, a ref is not "unpacker error"');
      if (refs.some(r => !r.ok && r.reason === UNPACKER_ERROR)) return malformed('"unpacker error" beside "unpack ok"');
      return { tag: 'statuses', refs };
    }
    default: return assertNever(st);
  }
}
// The driver: the report's pkt payloads (StreamReport.lines) against the commands sent.
// @decoder classifyReport prefix=report
export function classifyReport(payloads: readonly Uint8Array[], commands: ReadonlyArray<{ readonly ref: string }>): ReportShape {
  let st = reportInit(commands);
  for (const p of payloads) st = reportStep(st, p);
  return reportFinish(st);
}

// The class of one ng reason. git v2.50.0 receive-pack's own reasons are a table, each justified by what a caller can
// safely do next and judged by real git: test/space/push-ng.space.js (every reason × command × atomic × refs; SPACE.md).
//   cas        the ref is not where the command said (stale old oid, create over an existing ref, a held lock): fresh retry
//   nff        receive.denyNonFastForwards, and the new commit does not descend from the command's own old oid
//   ambiguous  a proc-receive hook was handed the command and did not answer for it: it may have acted
//   innocent   'atomic push failure', an atomic push's other members: the culprit's class decides
//   rejected   a refusal: resending the same request is refused again
// git >= 2.51 reports a non-atomic ref's failed update by cause (refs.c ref_transaction_error_msg): a stale old oid, a
// create over an existing ref and a ref deleted since the read are cas; 'refname conflict' (D/F) and the rest refuse.
// Every other git reason is a refusal (push_rejected). A reason git does not write is another host's: 'stale ref' is
// Cloudflare Artifacts' only ref-update rejection (stale old oid, create over an existing ref, stale delete, and the
// innocent members of a multi-ref push, which it always treats as atomic; observed 2026-10-23, SAFETY.md I31).
export type NgClass = 'cas' | 'nff' | 'innocent' | 'ambiguous' | 'rejected';
const NG_CLASS = new Map<string, NgClass>([['failed to update ref', 'cas'], ['atomic transaction failed', 'cas'], ['bad ref', 'cas'], ['incorrect old value provided', 'cas'], ['reference already exists', 'cas'], ['reference does not exist', 'cas'], ['non-fast-forward', 'nff'], ['atomic push failure', 'innocent'], ['proc-receive failed to report status', 'ambiguous'], ['fail to run proc-receive hook', 'ambiguous']]);
const HOST_CAS = /^(failed to lock|stale ref)$|fetch first|non-fast-forward|already exists/u;
export const ngClass = (reason: string): NgClass => NG_CLASS.get(reason) ?? (HOST_CAS.test(reason) ? 'cas' : 'rejected');

// 3. The outcome. An exhaustive match on the report shape; 'ambiguous' is the only fallthrough. A refused ref carries
// its reason and the reason's class. Every ref refused is a rejection whose code is the classes' verdict: a refusal
// anywhere wins (push_rejected), then a non-fast-forward, then a lost compare-and-swap; 'innocent' members alone refuse.
//   { tag: 'landed' } | { tag: 'rejected', code, refs } | { tag: 'partial', landed, rejected } | { tag: 'ambiguous', why }
export type Refused = { readonly ref: string; readonly reason: string; readonly cls: NgClass };
export type RejectionCode = 'push_rejected' | 'not_fast_forward' | 'cas_conflict';
export type Outcome =
  | { readonly tag: 'landed' }
  | { readonly tag: 'rejected'; readonly code: RejectionCode; readonly refs: readonly Refused[] }
  | { readonly tag: 'partial'; readonly landed: readonly string[]; readonly rejected: readonly Refused[] }
  | { readonly tag: 'ambiguous'; readonly why: string };
const refused = (refs: readonly RefStatus[]): Refused[] => refs.flatMap(r => (r.ok ? [] : [{ ref: r.ref, reason: r.reason, cls: ngClass(r.reason) }]));
// every ref refused, none ambiguous: which rejection
export const rejectionCode = (ng: readonly Refused[]): RejectionCode => {
  const cls = new Set(ng.map(r => r.cls));
  if (cls.has('rejected')) return 'push_rejected';
  if (cls.has('nff')) return 'not_fast_forward';
  return cls.has('cas') ? 'cas_conflict' : 'push_rejected';
};
export function decideOutcome(shape: ReportShape | Broken, { atomic = false, pack = true }: { readonly atomic?: boolean; readonly pack?: boolean } = {}): Outcome {
  switch (shape.tag) {
    // receive-pack writes an unpack failure only after reading a pack (delete_only() skips unpack)
    case 'unpackFailed': return pack ? { tag: 'rejected', code: 'push_rejected', refs: refused(shape.refs) } : { tag: 'ambiguous', why: 'unpack failed but no pack was sent' };
    case 'statuses': {
      const ng = refused(shape.refs);
      if (ng.length === 0) return { tag: 'landed' };
      // a proc-receive hook took the command and did not answer for it: it may have acted (test/space/push-ng.space.js)
      const amb = ng.find(r => r.cls === 'ambiguous');
      if (amb) return { tag: 'ambiguous', why: `proc-receive: ${amb.reason}` };
      if (ng.length === shape.refs.length) return { tag: 'rejected', code: rejectionCode(ng), refs: ng };
      // atomic: all or none. A split is git-shaped only for refs refused before the transaction (hidden refs, observed);
      // ply does not claim a partial outcome for a push the caller made atomic (SPACE.md).
      if (atomic) return { tag: 'ambiguous', why: 'atomic push split: some refs ok, some ng' };
      return { tag: 'partial', landed: shape.refs.filter(r => r.ok).map(r => r.ref), rejected: ng };
    }
    case 'malformed':
    case 'broken': return { tag: 'ambiguous', why: shape.why };
    default: return assertNever(shape);
  }
}

// The report as classified (one parser: classifyReport), for the caller and the span: null when it was not git's.
export type PushReport = Exclude<ReportShape, Malformed>;

// 4. The Result. 'landed' is Ok; every other outcome is the PlyError a caller matches on, carrying the report and
// band 2. A rejection's message names the first refused ref's reason (git's report order; an unpack failure's refs
// are all "unpacker error", and there is at least one command).
export type PushError = ErrorOf<RejectionCode | 'push_partial' | 'ambiguous'>;
export type OutcomeContext = { readonly report: PushReport | null; readonly hookOutput: string; readonly remote: string | undefined; readonly commands: readonly Command[] };
export function outcomeResult(o: Outcome, { report, hookOutput, remote, commands }: OutcomeContext): Result<PushReport | null, PushError> {
  const extra = { report, hookOutput };
  switch (o.tag) {
    case 'landed': return ok(report);
    case 'rejected': {
      const message = `push rejected: ${o.refs[0]?.reason ?? ''}`;
      if (o.code !== 'cas_conflict') return fail(o.code, message, extra);
      // what the culprit's command said the ref was (null: absent); receive-pack does not say where it is (actual: null)
      const old = commands.find(c => c.ref === o.refs.find(r => r.cls === 'cas')?.ref)?.oldOid;
      return fail('cas_conflict', message, { ...extra, expected: old === undefined || old === ZERO_OID ? null : old, actual: null });
    }
    case 'partial': return fail('push_partial', `push partially applied: ${o.landed.join(', ')} updated; ${o.rejected.map(r => `${r.ref} (${r.reason})`).join(', ')} refused`, { ...extra, landed: o.landed, rejected: o.rejected });
    case 'ambiguous': return fail('ambiguous', `push outcome unknown: ${remote === undefined ? '' : `remote: ${remote}: `}${o.why}`, remote === undefined ? extra : { ...extra, original: 'remote_error' });
    default: return assertNever(o);
  }
}
const bandLines = (text: string): string[] => text.split(/\r?\n|\r/u).map(l => l.trim()).filter(Boolean).slice(-REPORT_KEEP);

// The transport surface push reads (http.js, sshgit.js and test doubles provide more).
export type PushSpan = {
  set(attrs: Readonly<Record<string, unknown>>): unknown;
  event(name: string, attrs: Readonly<Record<string, unknown>>): unknown;
};
export type PushTransport = Transport;
// One object for buildPack: { type, data, baseOid? } (pack.js).
export type PackObject = PackInput;
export type PackEntry = BuiltEntry;
// Single-ref form { ref, oldOid, newOid, objects } or multi-ref { commands: [...], objects }. Options:
//   sideband (default on): side-band-64k — the server's human-readable explanation of a rejection (hook stderr, GitHub's
//            GH006 text) arrives on band 2 and is recorded as git.push.remote.messages. Every receive-pack since 1.7 has it.
//   reportV2: report-status-v2 (per-ref option lines).
//   checked: atomic (all-or-nothing) and push options, as checked against the server's advertisement (receivecaps.ts
//            checkPushCaps; pushWithOptions and GitHttp.push do it).
export type PushOptions = {
  readonly ref?: string;
  readonly oldOid?: string;
  readonly newOid?: string;
  readonly objects?: readonly PackObject[];
  readonly commands?: Commands | null | undefined;
  readonly sideband?: boolean;
  readonly reportV2?: boolean;
  readonly checked?: CheckedCaps;
};
export type PushResult = { readonly report: PushReport | null; readonly packBytes: number; readonly entries: readonly PackEntry[]; readonly hookOutput: string };

// The request, planned before anything is built or sent (pure): every refusal here happens with nothing on the wire.
export type PushPlan = { readonly commands: Commands; readonly caps: readonly string[]; readonly checked: CheckedCaps | undefined; readonly needPack: boolean; readonly maxReportLines: number; readonly maxPack: number };
// The capabilities a push asks for; atomic and push-options only from a CheckedCaps.
export const requestCaps = (commands: readonly Command[], { sideband = true, reportV2 = false }: { readonly sideband?: boolean; readonly reportV2?: boolean }, checked?: CheckedCaps): string[] =>
  [reportV2 ? 'report-status-v2' : 'report-status', ...(sideband ? ['side-band-64k'] : []), ...(checked?.atomic === true ? ['atomic'] : []), ...(commands.some(c => c.newOid === ZERO_OID) ? ['delete-refs'] : []), ...((checked?.pushOptions.length ?? 0) > 0 ? ['push-options'] : []), `agent=${UA.replace(/ .*/u, '')}`];
// An untyped (JS) caller's atomic / pushOptions, which the type no longer has: refused rather than silently dropped.
type Unchecked = { readonly atomic?: unknown; readonly pushOptions?: { readonly length?: unknown } };
export function planPush(o: PushOptions, limits: Partial<Limits> | null | undefined): Result<PushPlan, ErrorOf<'bad_request' | 'limit_exceeded'>> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fields a JS caller may still pass; read loosely
  const legacy = o as Unchecked;
  if (!o.checked && (legacy.atomic === true || Number(legacy.pushOptions?.length) > 0)) return fail('bad_request', 'push: unchecked atomic or push options');
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the single-ref fields are checked just below: validatePushRef and the oid pattern refuse a missing one
  const commands: Commands = o.commands ?? [{ ref: o.ref, oldOid: o.oldOid, newOid: o.newOid } as Command];
  const maxRefs = readLimit(limits, 'maxRefs');
  if (!maxRefs.ok) return maxRefs;
  if (commands.length > maxRefs.value) return err(limitExceeded('push commands', commands.length, maxRefs.value));
  for (const c of commands) {
    validatePushRef(c.ref, c.newOid === ZERO_OID); // throws bad_request until validate.ts returns Result (A2)
    if (!OID.test(c.oldOid) || !OID.test(c.newOid)) return fail('bad_request', 'push: oids must be 40-hex');
  }
  for (const p of o.checked?.pushOptions ?? []) validateWire(p, 'push option'); // as validatePushRef
  // read once, before anything is built or sent: the same values bound the pack and the report
  const maxReportLines = readLimit(limits, 'maxReportLines');
  if (!maxReportLines.ok) return maxReportLines;
  const maxPack = readLimit(limits, 'maxPackBytes');
  if (!maxPack.ok) return maxPack;
  return ok({ commands, caps: requestCaps(commands, o, o.checked), checked: o.checked, needPack: commands.some(c => c.newOid !== ZERO_OID), maxReportLines: maxReportLines.value, maxPack: maxPack.value });
}
// The request body: commands, flush, then (push-options) the options and another flush, then the pack.
const requestBody = (plan: PushPlan, pack: Uint8Array | null): Uint8Array<ArrayBuffer> => {
  const options = plan.checked?.pushOptions ?? [];
  if (options.length === 0) return pushBody(plan, pack);
  return concat([pushBody(plan), ...options.map(p => pkt(`${p}\n`)), FLUSH, ...(pack ? [pack] : [])]);
};

// The read, the platform edge: whatever the transport throws (network, HTTP status, framing) and our own limits on the
// response end the read as `lost`; the stream otherwise ends as a report or broken. `reading` is the last reading state.
type Read = { readonly done: Broken | StreamReport; readonly reading: Reading } | { readonly cause: unknown };
async function readResponse(t: PushTransport, plan: PushPlan, body: Uint8Array<ArrayBuffer>, span: Span, sideband: boolean): Promise<Read> {
  let reportBytes = 0;
  let reading = streamInit(sideband);
  let st: StreamState = reading;
  let lost: { readonly cause: unknown } | null = null;
  try {
    for await (const f of frames(t, 'git-receive-pack', body, span)) {
      reportBytes += f.kind === 'data' ? f.payload.length : 0;
      if (reportBytes > plan.maxPack) { lost = { cause: limitExceeded('report bytes', reportBytes, plan.maxPack) }; break; }
      st = streamStep(st, f);
      // Stryker disable next-line ConditionalExpression: a broken state has no lines, so reading on fails the read: ambiguous either way
      if (st.tag !== 'reading') break;
      reading = st;
      if (st.lines.length > plan.maxReportLines) { lost = { cause: limitExceeded('report lines', st.lines.length, plan.maxReportLines) }; break; }
    }
  } catch (e) { lost = { cause: e }; }
  return lost ?? { done: streamFinish(st), reading };
}

// The span's view of the outcome, from the classified report (no second parser).
const outcomeAttrs = (done: Broken | StreamReport, report: PushReport | null, outcome: Outcome, band2Frames: number, band2: string): Record<string, unknown> => ({
  'git.push.report.lines': done.tag === 'report' ? done.lines.slice(0, REPORT_KEEP).map(p => decodeBytes(p).replace(/\n$/u, '')) : [],
  'git.push.unpack': (report && (report.tag === 'statuses' ? 'ok' : report.status)) ?? '', 'git.push.ok': outcome.tag === 'landed', 'git.push.outcome': outcome.tag,
  'git.push.ng.reason': report?.refs.find(x => !x.ok)?.reason ?? '', 'git.push.band2.frames': band2Frames, 'git.push.band2.tail': band2.slice(-BAND_ATTR),
  'git.push.remote.messages': bandLines(band2), 'git.push.refs.ok': report?.refs.filter(x => x.ok).length ?? 0, 'git.push.refs.ng': report?.refs.filter(x => !x.ok).length ?? 0,
});

// The send, inside the span: build the pack, refuse an oversized one before the first byte, send, read, decide.
async function send(t: PushTransport, plan: PushPlan, objects: readonly PackObject[], sideband: boolean, span: Span): Promise<Result<PushResult, PlyError>> {
  const { pack, entries }: { readonly pack: Uint8Array | null; readonly entries: readonly PackEntry[] } = plan.needPack ? await buildPack(objects) : { pack: null, entries: [] };
  span.set({ 'git.push.pack.bytes': pack?.length ?? 0, 'git.push.pack.objects': entries.length, 'git.push.pack.thin': entries.some(e => Boolean(e.baseOid)), 'git.push.pack.compressed.bytes': entries.reduce((a, e) => a + e.compressed, 0), 'git.push.pack.raw.bytes': entries.reduce((a, e) => a + e.size, 0) });
  for (const [i, e] of entries.entries()) span.event('git.push.object', { 'git.object.index': i, 'git.object.type': e.typeName, 'git.object.size': e.size, 'git.object.compressed': e.compressed, 'git.object.base.oid': e.baseOid ?? '', 'git.object.bytes': e.bytes });
  // Refuse before the first byte is sent: a host with a push cap (Artifacts: 62–93 MiB) would otherwise take the whole
  // upload and answer 4xx. The measured size is the pack as built, so `got` is what the server would have received.
  if (pack && pack.length > plan.maxPack) return err(limitExceeded('push pack bytes', pack.length, plan.maxPack));
  // The request body (commands + pack) is on the wire from here. Every failure — transport, HTTP status, framing,
  // band 3, a limit — and every report that is not exactly git's is 'ambiguous': the ref may have moved.
  const r = await readResponse(t, plan, requestBody(plan, pack), span, sideband);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ambiguousAfterPush returns a PlyError: the cause itself when it already is an 'ambiguous' one, else a new one
  if ('cause' in r) return err(ambiguousAfterPush(r.cause) as PlyError);
  const { done, reading } = r;
  const band2 = reading.band2Carry.length > 0 ? (reading.band2 + td.decode(reading.band2Carry)).slice(-BAND_TAIL) : reading.band2;
  const shape: ReportShape | Broken = done.tag === 'report' ? classifyReport(done.lines, plan.commands) : done;
  const outcome = decideOutcome(shape, { atomic: plan.checked?.atomic ?? false, pack: plan.needPack });
  const report = shape.tag === 'malformed' || shape.tag === 'broken' ? null : shape;
  span.set(outcomeAttrs(done, report, outcome, reading.band2Frames, band2));
  if (outcome.tag === 'ambiguous') span.set({ 'git.push.ambiguous': outcome.why });
  const res = outcomeResult(outcome, { report, hookOutput: band2, remote: shape.tag === 'broken' ? shape.remote : undefined, commands: plan.commands });
  return res.ok ? ok({ report: res.value, packBytes: pack?.length ?? 0, entries, hookOutput: band2 }) : res;
}

// The effect. A refusal before the request (planPush) rejects with no span; everything after is under the span, whose
// error is the PlyError the Result carries (the public API throws it until the Result cut-over, docs/STACK.md).
// oxlint-disable-next-line eslint/require-await -- async so a refusal before the request rejects instead of throwing, as before
export async function push(t: PushTransport, opts: PushOptions): Promise<PushResult> {
  const plan = orThrow(planPush(opts, t.limits));
  const { commands, caps } = plan;
  // an empty list from an untyped caller has no first command: the TypeError below is coded 'protocol', as before
  const [first] = commands;
  // oxlint-disable-next-line typescript/promise-function-async -- coded awaits it; async adds a wrapper and bytes
  return coded('protocol', () => t.tracer.span('git.receive-pack', clientSpan(t, { 'git.command': 'receive-pack', 'git.protocol.version': 0, 'git.push.commands': commands.map(c => `${c.oldOid.slice(0, SHORT_OID)} ${c.newOid.slice(0, SHORT_OID)} ${c.ref}`), 'git.push.caps': caps, 'git.push.ref': first.ref, 'git.push.old': first.oldOid, 'git.push.new': first.newOid }), async (span: Span): Promise<PushResult> => orThrow(await send(t, plan, opts.objects ?? [], opts.sideband ?? true, span))));
}

