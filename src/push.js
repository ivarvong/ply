// v0 receive-pack: commands + thin pack in, report-status out. The request body and report parsing are pure; `push`
// is the one effect. Any failure after the body is on the wire is 'ambiguous' (the ref may have moved).
import { fail, ambiguousAfterPush } from './errors.js';
import { pkt, FLUSH, pktInit, pktStep } from './pktline.js';
import { td, concat, decodeBytes, decodeChunk } from './bytes.js';
import { parseSideband } from './fetch.js';
import { SIDEBAND_PACK, SIDEBAND_PROGRESS, SIDEBAND_ERROR, OID_HEX_CHARS } from './format.js';

/* oxlint-disable no-magic-numbers -- span tails and the short-oid display width are diagnostics, not wire-format facts */
const SHORT_OID = 8;
const BAND_TAIL = 4096;
const BAND_ATTR = 1024;
const REPORT_KEEP = 64;
/* oxlint-enable no-magic-numbers */
const UNPACK = 'unpack ';
const OK_REF = 'ok ';
const NG_REF = 'ng ';
const OPTION = 'option ';
import { buildPack } from './pack.js';
import { frames, coded, clientSpan, UA } from './transport.js';
import { DEFAULT_LIMITS, limitError, requireLimit } from './limits.js';
import { validateRef, validateWire } from './validate.js';

export const ZERO_OID = '0'.repeat(OID_HEX_CHARS);

// commands: [{ ref, oldOid, newOid }] (create: oldOid = zeros; delete: newOid = zeros). A push with only deletes sends no pack.
export const pushBody = ({ commands, caps = ['report-status', `agent=${UA.replace(/ .*/, '')}`] }, pack) => {
  const lines = commands.map((c, i) => `${c.oldOid} ${c.newOid} ${c.ref}${i === 0 ? '\0' + caps.join(' ') : ''}\n`);
  return concat([...lines.map(l => pkt(l)), FLUSH, ...(pack ? [pack] : [])]);
};

// ---- report-status parsing (pure) ----
// @decoder parseReportStatus prefix=report
export function parseReportStatus(lines, limits = DEFAULT_LIMITS) {
  const maxLines = requireLimit(limits, 'maxReportLines');
  if (lines.length > maxLines) throw limitError('report lines', lines.length, maxLines);
  // Stryker disable next-line BooleanLiteral: the loop below always assigns r.ok again before the return
  const r = { unpack: null, refs: [], ok: false };
  for (const l of lines) {
    if (l.startsWith(UNPACK)) {
      // send-pack.c receive_unpack_status reads one unpack line. A second is an invalid ref status, not a new status.
      if (r.unpack !== null) throw fail('protocol', 'report: duplicate unpack');
      r.unpack = l.slice(UNPACK.length);
    }
    else if (l.startsWith(OK_REF)) r.refs.push({ ref: l.slice(OK_REF.length), ok: true, options: Object.create(null) });
    else if (l.startsWith(NG_REF)) { const sp = l.indexOf(' ', NG_REF.length); r.refs.push({ ref: l.slice(NG_REF.length, sp), ok: false, reason: l.slice(sp + 1), options: Object.create(null) }); }
    else if (l.startsWith(OPTION) && r.refs.length) { const [k, v] = l.slice(OPTION.length).split(' '); r.refs[r.refs.length - 1].options[k] = v ?? true; } // report-status-v2; option names are the server's, so options has no prototype
  }
  r.ok = r.unpack === 'ok' && r.refs.length > 0 && r.refs.every(x => x.ok);
  return r;
}
// ---- the push outcome (pure): wire → stream shape → report shape → outcome, each a tagged union ----
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
const broken = (why, remote) => ({ tag: 'broken', why, remote });
// `lines` grows in place (a report can hold limits.maxReportLines lines): a state is not reused once stepped.
export const streamInit = sideband => ({ tag: 'reading', sideband, phase: 'report', inner: pktInit(), lines: [], band2: '', band2Carry: new Uint8Array(0), band2Frames: 0 });
// @decoder streamStep prefix=stream
export function streamStep(st, f) {
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
  const { band, body } = parseSideband(f.payload);
  // decodeChunk: a character cut by a frame boundary is held for the next frame instead of decoding as two U+FFFD (#43)
  if (band === SIDEBAND_PROGRESS) { const d = decodeChunk(st.band2Carry, body); return { ...st, band2: (st.band2 + d.text).slice(-BAND_TAIL), band2Carry: d.carry, band2Frames: st.band2Frames + 1 }; }
  if (band === SIDEBAND_ERROR) return broken('band 3', td.decode(body).trim());
  if (band !== SIDEBAND_PACK) return broken(`bad sideband ${band}`);
  // an empty band-1 packet is copy_to_sideband's keepalive: sent while hooks run, before the report and after it (post-receive)
  if (!body.length) return st;
  // Stryker disable next-line ConditionalExpression: without it, band-1 bytes after the report's flush still break it (the loop below, or the carry at the outer flush)
  if (st.phase !== 'report') return broken('band 1 after the report');
  const r = pktStep(st.inner, body);
  let phase = st.phase;
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
export const streamFinish = st => (st.tag !== 'reading' ? st : st.phase === 'done' ? { tag: 'report', lines: st.lines } : broken('no final flush'));

// 2. The report. git's grammar, exactly: "unpack ok" or "unpack <one of unpack()'s failure strings>", then for each
// commanded ref exactly one "ok <ref>" or "ng <ref> <reason>" (reason: printable ASCII), every line ending in LF, and
// nothing else (report_v2's option lines come only from a proc-receive hook, which redirects the update: not modelled).
//   { tag: 'statuses', refs: [{ ref, ok, reason }] }  — unpack ok, one well-formed status per commanded ref
//   { tag: 'unpackFailed', status }                    — unpack failed and every ref is "ng <ref> unpacker error"
//   { tag: 'malformed', why }                          — anything else
// execute_commands: an unpack failure marks every command "unpacker error", and nothing else does.
export const GIT_UNPACK_ERRORS = Object.freeze([
  'eof before pack header was fully read', 'protocol error (pack signature mismatch detected)', 'protocol error (pack version unsupported)',
  'unknown error in parse_pack_header', 'unable to create temporary object directory', 'unpack-objects abnormal exit', 'index-pack fork failed',
  'index-pack abnormal exit',
]);
const UNPACKER_ERROR = 'unpacker error';
const malformed = why => ({ tag: 'malformed', why });
// Stryker disable next-line ConditionalExpression,EqualityOperator,ArrayDeclaration: classifyReport calls it on "ng <rest>" only; with no space or a leading one, every split names no commanded ref
const splitOnce = (s, sep) => { const i = s.indexOf(sep); return i < 0 ? [s] : [s.slice(0, i), s.slice(i + sep.length)]; };
// @decoder classifyReport prefix=report
export function classifyReport(payloads, commands) {
  const lines = [];
  for (const p of payloads) {
    // A ref name is bytes (check_refname_format refuses only control bytes, space, ~ ^ : ? * [ and backslash, `..`, `@{` and the
    // dot/slash/.lock rules; any byte >= 0x80 is legal), and receive-pack echoes it as it got it. decodeBytes maps it to
    // the string the command was built from (encodeBytes is its inverse), so `ok <ref>` matches its command (#43).
    const l = decodeBytes(p);
    const body = l.slice(0, l.length - 1);
    if (!l.endsWith('\n') || body.includes('\n')) return malformed('a line is not one LF-terminated line');
    lines.push(body);
  }
  const unpack = lines[0]?.startsWith(UNPACK) ? lines[0].slice(UNPACK.length) : null;
  if (unpack !== 'ok' && !GIT_UNPACK_ERRORS.includes(unpack)) return malformed('no git unpack line first');
  const want = new Set(commands.map(c => c.ref));
  const seen = new Map();
  for (const l of lines.slice(1)) {
    const ok = l.startsWith(OK_REF);
    if (!ok && !l.startsWith(NG_REF)) return malformed('a line is not a ref status');
    // validateRef forbids spaces in a ref, so the first space after "ng <ref>" ends the ref name
    const rest = l.slice(OK_REF.length);
    const [ref, reason = ''] = ok ? [rest] : splitOnce(rest, ' ');
    if (!want.has(ref)) return malformed('status for a ref not commanded');
    if (seen.has(ref)) return malformed(`two statuses for ${ref}`);
    if (!ok && !/^[\x20-\x7e]+$/.test(reason)) return malformed(`no readable reason for ${ref}`);
    seen.set(ref, { ref, ok, reason });
  }
  for (const ref of want) if (!seen.has(ref)) return malformed(`no status for ${ref}`);
  const refs = [...seen.values()];
  if (unpack !== 'ok') return refs.every(r => !r.ok && r.reason === UNPACKER_ERROR) ? { tag: 'unpackFailed', status: unpack } : malformed('unpack failed, a ref is not "unpacker error"');
  if (refs.some(r => !r.ok && r.reason === UNPACKER_ERROR)) return malformed('"unpacker error" beside "unpack ok"');
  return { tag: 'statuses', refs };
}

// 3. The outcome. An exhaustive match on the report shape; 'ambiguous' is the only fallthrough.
//   { tag: 'landed' } | { tag: 'rejected', code } | { tag: 'partial', landed, rejected } | { tag: 'ambiguous', why }
export function decideOutcome(shape, { atomic = false, pack = true } = {}) {
  switch (shape.tag) {
    // receive-pack writes an unpack failure only after reading a pack (delete_only() skips unpack)
    case 'unpackFailed': return pack ? { tag: 'rejected', code: 'push_rejected' } : { tag: 'ambiguous', why: 'unpack failed but no pack was sent' };
    case 'statuses': {
      const ok = shape.refs.filter(r => r.ok), ng = shape.refs.filter(r => !r.ok);
      if (!ng.length) return { tag: 'landed' };
      // a proc-receive hook took the command and did not answer for it: it may have acted (test/space/push-ng.space.js)
      if (ng.some(r => ngClass(r.reason) === 'ambiguous')) return { tag: 'ambiguous', why: `proc-receive: ${ng.find(r => ngClass(r.reason) === 'ambiguous').reason}` };
      if (!ok.length) return { tag: 'rejected', code: rejectionCode({ unpack: 'ok', refs: ng }) };
      // atomic: all or none. A split is git-shaped only for refs refused before the transaction (hidden refs, observed);
      // ply does not claim a partial outcome for a push the caller made atomic (SPACE.md).
      if (atomic) return { tag: 'ambiguous', why: 'atomic push split: some refs ok, some ng' };
      return { tag: 'partial', landed: ok.map(r => r.ref), rejected: ng.map(r => ({ ref: r.ref, reason: r.reason })) };
    }
    default: return { tag: 'ambiguous', why: shape.why ?? `report shape ${shape.tag}` };
  }
}
// The class of one ng reason. git v2.50.0 receive-pack's own reasons are a table, each justified by what a caller can
// safely do next and judged by real git: test/space/push-ng.space.js (every reason × command × atomic × refs; SPACE.md).
//   cas        the ref is not where the command said (stale old oid, create over an existing ref, a held lock): fresh retry
//   nff        receive.denyNonFastForwards, and the new commit does not descend from the command's own old oid
//   ambiguous  a proc-receive hook was handed the command and did not answer for it: it may have acted
//   innocent   'atomic push failure', an atomic push's other members: the culprit's class decides
// git >= 2.51 reports a non-atomic ref's failed update by cause (refs.c ref_transaction_error_msg): a stale old oid, a
// create over an existing ref and a ref deleted since the read are cas; 'refname conflict' (D/F) and the rest refuse.
// Every other git reason is a refusal (push_rejected). A reason git does not write is another host's: 'stale ref' is
// Cloudflare Artifacts' only ref-update rejection (stale old oid, create over an existing ref, stale delete, and the
// innocent members of a multi-ref push, which it always treats as atomic; observed 2026-10-23, SAFETY.md I31).
const NG_CLASS = new Map([['failed to update ref', 'cas'], ['atomic transaction failed', 'cas'], ['bad ref', 'cas'], ['incorrect old value provided', 'cas'], ['reference already exists', 'cas'], ['reference does not exist', 'cas'], ['non-fast-forward', 'nff'], ['atomic push failure', 'innocent'], ['proc-receive failed to report status', 'ambiguous'], ['fail to run proc-receive hook', 'ambiguous']]);
const HOST_CAS = /^(failed to lock|stale ref)$|fetch first|non-fast-forward|already exists/;
const ngClass = r => NG_CLASS.get(r) ?? (HOST_CAS.test(r) ? 'cas' : 'rejected');
// all refs refused: a refusal anywhere wins, then a non-fast-forward, then a lost compare-and-swap
export const rejectionCode = report => {
  const cls = report.refs.filter(r => !r.ok).map(r => ngClass(r.reason));
  if (report.unpack !== 'ok' || cls.includes('rejected')) return 'push_rejected';
  if (cls.includes('ambiguous')) return 'ambiguous';
  return cls.includes('nff') ? 'not_fast_forward' : cls.includes('cas') ? 'cas_conflict' : 'push_rejected';
};
const bandLines = text => text.split(/\r?\n|\r/).map(l => l.trim()).filter(Boolean).slice(-REPORT_KEEP);

// Single-ref form { ref, oldOid, newOid, objects } or multi-ref { commands: [...], objects }. Options:
//   sideband (default on): side-band-64k — the server's human-readable explanation of a rejection (hook stderr, GitHub's
//            GH006 text) arrives on band 2 and is recorded as git.push.remote.messages. Every receive-pack since 1.7 has it.
//   reportV2: report-status-v2 (per-ref option lines), atomic: all-or-nothing, pushOptions: strings — the caller must
//            have checked the advertisement for atomic and push-options (receivecaps.js pushWithOptions, which GitHttp.push
//            uses): receive-pack ignores an unadvertised `atomic` (the refs land one by one) and reads unadvertised option
//            lines as the pack.
export async function push(t, { ref, oldOid, newOid, objects = [], commands, sideband = true, reportV2 = false, atomic = false, pushOptions = [] }) {
  commands = commands ?? [{ ref, oldOid, newOid }];
  const maxRefs = requireLimit(t.limits, 'maxRefs');
  if (commands.length > maxRefs) throw limitError('push commands', commands.length, maxRefs);
  for (const c of commands) {
    validateRef(c.ref);
    if (!new RegExp(`^[0-9a-f]{${OID_HEX_CHARS}}$`).test(c.oldOid) || !new RegExp(`^[0-9a-f]{${OID_HEX_CHARS}}$`).test(c.newOid)) throw fail('bad_request', 'push: oids must be 40-hex');
  }
  for (const o of pushOptions) validateWire(o, 'push option');
  requireLimit(t.limits, 'maxReportLines');
  requireLimit(t.limits, 'maxPackBytes');
  const caps = [reportV2 ? 'report-status-v2' : 'report-status', ...(sideband ? ['side-band-64k'] : []), ...(atomic ? ['atomic'] : []), ...(commands.some(c => c.newOid === ZERO_OID) ? ['delete-refs'] : []), ...(pushOptions.length ? ['push-options'] : []), `agent=${UA.replace(/ .*/, '')}`];
  return coded('protocol', () => t.tracer.span('git.receive-pack', clientSpan(t, { 'git.command': 'receive-pack', 'git.protocol.version': 0, 'git.push.commands': commands.map(c => `${c.oldOid.slice(0, SHORT_OID)} ${c.newOid.slice(0, SHORT_OID)} ${c.ref}`), 'git.push.caps': caps, 'git.push.ref': commands[0].ref, 'git.push.old': commands[0].oldOid, 'git.push.new': commands[0].newOid }), async span => {
    const needPack = commands.some(c => c.newOid !== ZERO_OID);
    const { pack, entries } = needPack ? await buildPack(objects) : { pack: null, entries: [] };
    span.set({ 'git.push.pack.bytes': pack?.length ?? 0, 'git.push.pack.objects': entries.length, 'git.push.pack.thin': entries.some(e => e.baseOid), 'git.push.pack.compressed.bytes': entries.reduce((a, e) => a + e.compressed, 0), 'git.push.pack.raw.bytes': entries.reduce((a, e) => a + e.size, 0) });
    entries.forEach((e, i) => span.event('git.push.object', { 'git.object.index': i, 'git.object.type': e.typeName, 'git.object.size': e.size, 'git.object.compressed': e.compressed, 'git.object.base.oid': e.baseOid ?? '', 'git.object.bytes': e.bytes }));
    // Refuse before the first byte is sent: a host with a push cap (Artifacts: 62–93 MiB) would otherwise take the whole
    // upload and answer 4xx. The measured size is the pack as built, so `got` is what the server would have received.
    const maxPack = requireLimit(t.limits, 'maxPackBytes');
    if (pack && pack.length > maxPack) throw limitError('push pack bytes', pack.length, maxPack);
    let body = pushBody({ commands, caps }, pack);
    if (pushOptions.length) { // push-options follow the command flush, then another flush, then the pack
      const head = body.subarray(0, body.length - (pack?.length ?? 0));
      body = concat([head, ...pushOptions.map(o => pkt(o + '\n')), FLUSH, ...(pack ? [pack] : [])]);
    }
    const maxReportLines = requireLimit(t.limits, 'maxReportLines');
    const maxReportBytes = requireLimit(t.limits, 'maxPackBytes');
    let reportBytes = 0, st = streamInit(sideband), reading = st; // reading: the last state still reading (band 2 lives there)
    // The request body (commands + pack) is on the wire. From here, every failure — transport, HTTP status, framing,
    // band 3, a limit — and every report that is not exactly git's is 'ambiguous': the ref may have moved.
    try {
      for await (const f of frames(t, 'git-receive-pack', body, span)) {
        reportBytes += f.payload?.length ?? 0;
        if (reportBytes > maxReportBytes) throw limitError('report bytes', reportBytes, maxReportBytes);
        st = streamStep(st, f);
        // Stryker disable next-line ConditionalExpression: a broken state has no lines, so reading on throws inside the try: ambiguous either way
        if (st.tag !== 'reading') break;
        reading = st;
        if (st.lines.length > maxReportLines) throw limitError('report lines', st.lines.length, maxReportLines);
      }
      st = streamFinish(st);
    } catch (e) { throw ambiguousAfterPush(e); }
    const band2 = reading.band2Carry.length ? (reading.band2 + td.decode(reading.band2Carry)).slice(-BAND_TAIL) : reading.band2;
    const lines = st.tag === 'report' ? st.lines.map(p => decodeBytes(p).replace(/\n$/, '')) : [];
    let report = null;
    try { report = parseReportStatus(lines, t.limits); } catch { /* a malformed report: the outcome below is ambiguous */ }
    const shape = st.tag === 'report' ? classifyReport(st.lines, commands) : st;
    const outcome = decideOutcome(shape, { atomic, pack: needPack });
    const remoteMessages = bandLines(band2);
    span.set({ 'git.push.report.lines': lines.slice(0, REPORT_KEEP), 'git.push.unpack': report?.unpack ?? '', 'git.push.ok': outcome.tag === 'landed', 'git.push.outcome': outcome.tag, 'git.push.ng.reason': report?.refs.find(r => !r.ok)?.reason ?? '', 'git.push.band2.frames': reading.band2Frames, 'git.push.band2.tail': band2.slice(-BAND_ATTR), 'git.push.remote.messages': remoteMessages, 'git.push.refs.ok': report?.refs.filter(r => r.ok).length ?? 0, 'git.push.refs.ng': report?.refs.filter(r => !r.ok).length ?? 0 });
    switch (outcome.tag) {
      case 'landed': break;
      case 'rejected': throw fail(outcome.code, `push rejected: ${report.refs.find(r => !r.ok)?.reason ?? report.unpack}`, { report, hookOutput: band2 });
      case 'partial': throw fail('push_partial', `push partially applied: ${outcome.landed.join(', ')} updated; ${outcome.rejected.map(r => `${r.ref} (${r.reason})`).join(', ')} refused`, { report, landed: outcome.landed, rejected: outcome.rejected, hookOutput: band2 });
      default:
        span.set({ 'git.push.ambiguous': outcome.why });
        throw fail('ambiguous', `push outcome unknown: ${shape.remote === undefined ? '' : `remote: ${shape.remote}: `}${outcome.why}`, { report, hookOutput: band2, ...(shape.remote === undefined ? {} : { original: 'remote_error' }) });
    }
    return { report, packBytes: pack?.length ?? 0, entries, hookOutput: band2 };
  }));
}
