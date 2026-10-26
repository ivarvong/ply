// v0 receive-pack: commands + thin pack in, report-status out. The request body and report parsing are pure; `push`
// is the one effect. Any failure after the body is on the wire is 'ambiguous' (the ref may have moved).
import { fail, ambiguousAfterPush } from './errors.js';
import { pkt, FLUSH, pktInit, pktStep } from './pktline.js';
import { td, concat } from './bytes.js';
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
import { frames, coded, clientSpan, proto, UA } from './transport.js';

export const ZERO_OID = '0'.repeat(OID_HEX_CHARS);

// commands: [{ ref, oldOid, newOid }] (create: oldOid = zeros; delete: newOid = zeros). A push with only deletes sends no pack.
export const pushBody = ({ commands, caps = ['report-status', `agent=${UA.replace(/ .*/, '')}`] }, pack) => {
  const lines = commands.map((c, i) => `${c.oldOid} ${c.newOid} ${c.ref}${i === 0 ? '\0' + caps.join(' ') : ''}\n`);
  return concat([...lines.map(l => pkt(l)), FLUSH, ...(pack ? [pack] : [])]);
};

// ---- report-status parsing (pure) ----
// @decoder parseReportStatus prefix=report
export function parseReportStatus(lines) {
  // Stryker disable next-line BooleanLiteral: the loop below always assigns r.ok again before the return
  const r = { unpack: null, refs: [], ok: false };
  for (const l of lines) {
    if (l.startsWith(UNPACK)) r.unpack = l.slice(UNPACK.length);
    else if (l.startsWith(OK_REF)) r.refs.push({ ref: l.slice(OK_REF.length), ok: true, options: {} });
    else if (l.startsWith(NG_REF)) { const sp = l.indexOf(' ', NG_REF.length); r.refs.push({ ref: l.slice(NG_REF.length, sp), ok: false, reason: l.slice(sp + 1), options: {} }); }
    else if (l.startsWith(OPTION) && r.refs.length) { const [k, v] = l.slice(OPTION.length).split(' '); r.refs[r.refs.length - 1].options[k] = v ?? true; } // report-status-v2
  }
  r.ok = r.unpack === 'ok' && r.refs.length > 0 && r.refs.every(x => x.ok);
  return r;
}
// A report is well-formed iff it has exactly one unpack line and exactly one status line per commanded ref, no extras.
export function checkReport(report, commands) {
  const want = new Set(commands.map(c => c.ref));
  const seen = new Map();
  for (const r of report.refs) { if (!want.has(r.ref)) return `status for unexpected ref ${r.ref}`; if (seen.has(r.ref)) return `duplicate status for ${r.ref}`; seen.set(r.ref, r); }
  for (const ref of want) if (!seen.has(ref)) return `no status for ${ref}`;
  if (report.unpack === null) return 'no unpack line';
  if (!/^[\x20-\x7e]+$/.test(report.unpack)) return `unreadable unpack status ${JSON.stringify(report.unpack)}`;
  for (const r of report.refs) if (!r.ok && !/^[\x20-\x7e]*$/.test(r.reason ?? '')) return `unreadable reason for ${r.ref}`;
  return null;
}
// retryable iff every failed ref failed on receive-pack's own ref update (stale old value, lock) or was an innocent
// member of an atomic push; a hook rejection anywhere makes the push non-retryable
// 'stale ref': Cloudflare Artifacts' only ref-update rejection (stale old oid, create over an existing ref, stale delete, and
// the innocent members of a multi-ref push, which it always treats as atomic) — observed 2026-10-23, see SAFETY.md
// 'incorrect old value provided': git ≥ 2.50 receive-pack (batched ref updates) reports a stale old oid
// under that name. 'bad ref': denyNonFastForwards could not parse a stale, unknown old oid.
const isCas = r => /^(failed to update ref|failed to lock|atomic push failure|bad ref|stale ref|incorrect old value provided)$/.test(r) || /fetch first|non-fast-forward|already exists/.test(r);
export const rejectionCode = report => {
  const reasons = report.refs.filter(r => !r.ok).map(r => r.reason);
  return report.unpack !== 'ok' ? 'push_rejected' : reasons.length && reasons.every(isCas) && reasons.some(r => r !== 'atomic push failure') ? 'cas_conflict' : 'push_rejected';
};
const bandLines = text => text.split(/\r?\n|\r/).map(l => l.trim()).filter(Boolean).slice(-REPORT_KEEP);

// Single-ref form { ref, oldOid, newOid, objects } or multi-ref { commands: [...], objects }. Options:
//   sideband (default on): side-band-64k — the server's human-readable explanation of a rejection (hook stderr, GitHub's
//            GH006 text) arrives on band 2 and is recorded as git.push.remote.messages. Every receive-pack since 1.7 has it.
//   reportV2: report-status-v2 (per-ref option lines), atomic: all-or-nothing, pushOptions: strings — the caller must
//            have checked the advertisement for push-options (receivecaps.js); an unadvertised option is read as the pack.
export async function push(t, { ref, oldOid, newOid, objects = [], commands, sideband = true, reportV2 = false, atomic = false, pushOptions = [] }) {
  commands = commands ?? [{ ref, oldOid, newOid }];
  for (const c of commands) if (!new RegExp(`^[0-9a-f]{${OID_HEX_CHARS}}$`).test(c.oldOid) || !new RegExp(`^[0-9a-f]{${OID_HEX_CHARS}}$`).test(c.newOid)) throw fail('bad_request', 'push: oids must be 40-hex');
  const caps = [reportV2 ? 'report-status-v2' : 'report-status', ...(sideband ? ['side-band-64k'] : []), ...(atomic ? ['atomic'] : []), ...(commands.some(c => c.newOid === ZERO_OID) ? ['delete-refs'] : []), ...(pushOptions.length ? ['push-options'] : []), `agent=${UA.replace(/ .*/, '')}`];
  return coded('protocol', () => t.tracer.span('git.receive-pack', clientSpan(t, { 'git.command': 'receive-pack', 'git.protocol.version': 0, 'git.push.commands': commands.map(c => `${c.oldOid.slice(0, SHORT_OID)} ${c.newOid.slice(0, SHORT_OID)} ${c.ref}`), 'git.push.caps': caps, 'git.push.ref': commands[0].ref, 'git.push.old': commands[0].oldOid, 'git.push.new': commands[0].newOid }), async span => {
    const needPack = commands.some(c => c.newOid !== ZERO_OID);
    const { pack, entries } = needPack ? await buildPack(objects) : { pack: null, entries: [] };
    span.set({ 'git.push.pack.bytes': pack?.length ?? 0, 'git.push.pack.objects': entries.length, 'git.push.pack.thin': entries.some(e => e.baseOid), 'git.push.pack.compressed.bytes': entries.reduce((a, e) => a + e.compressed, 0), 'git.push.pack.raw.bytes': entries.reduce((a, e) => a + e.size, 0) });
    entries.forEach((e, i) => span.event('git.push.object', { 'git.object.index': i, 'git.object.type': e.typeName, 'git.object.size': e.size, 'git.object.compressed': e.compressed, 'git.object.base.oid': e.baseOid ?? '', 'git.object.bytes': e.bytes }));
    let body = pushBody({ commands, caps }, pack);
    if (pushOptions.length) { // push-options follow the command flush, then another flush, then the pack
      const head = body.subarray(0, body.length - (pack?.length ?? 0));
      body = concat([head, ...pushOptions.map(o => pkt(o + '\n')), FLUSH, ...(pack ? [pack] : [])]);
    }
    const lines = [];
    let band2 = '', band2Frames = 0, inner = pktInit();
    // The request body (commands + pack) is on the wire. From here, ANY failure to obtain a trustworthy report —
    // transport, HTTP status, wrong content-type, malformed framing, bad sideband, band-3 error — means the ref may
    // have moved: the outcome is 'ambiguous'. Only our own pre-send refusals keep their codes.
    const ambiguous = e => (['limit_exceeded', 'bad_request'].includes(e?.code) ? e : fail('ambiguous', `push outcome unknown: ${e?.message ?? e}`, { cause: e, original: e?.code }));
    try {
      for await (const f of frames(t, 'git-receive-pack', body, span)) {
        if (f.kind !== 'data') continue;
        if (!sideband) { lines.push(td.decode(f.payload).replace(/\n$/, '')); continue; }
        const { band, body: payload } = parseSideband(f.payload);
        if (band === SIDEBAND_PACK) { const r = pktStep(inner, payload); inner = r.state; for (const g of r.frames) if (g.kind === 'data') lines.push(td.decode(g.payload).replace(/\n$/, '')); }
        else if (band === SIDEBAND_PROGRESS) { band2Frames++; band2 = (band2 + td.decode(payload)).slice(-BAND_TAIL); }
        else if (band === SIDEBAND_ERROR) throw fail('remote_error', `remote: ${td.decode(payload).trim()}`);
        else throw proto(`receive-pack: bad sideband ${band}`);
      }
    } catch (e) { throw ambiguousAfterPush(e); }
    const report = parseReportStatus(lines);
    const remoteMessages = bandLines(band2);
    const malformed = checkReport(report, commands);
    if (malformed) {
      span.set({ 'git.push.report.lines': lines.slice(0, REPORT_KEEP), 'git.push.ok': false, 'git.push.ambiguous': malformed, 'git.push.remote.messages': remoteMessages });
      throw fail('ambiguous', `push outcome unknown: malformed report (${malformed})`, { report, hookOutput: band2 });
    }
    span.set({ 'git.push.report.lines': lines.slice(0, REPORT_KEEP), 'git.push.unpack': report.unpack ?? '', 'git.push.ok': report.ok, 'git.push.ng.reason': report.refs.find(r => !r.ok)?.reason ?? '', 'git.push.band2.frames': band2Frames, 'git.push.band2.tail': band2.slice(-BAND_ATTR), 'git.push.remote.messages': remoteMessages, 'git.push.refs.ok': report.refs.filter(r => r.ok).length, 'git.push.refs.ng': report.refs.filter(r => !r.ok).length });
    if (!report.ok) {
      const reason = report.refs.find(r => !r.ok)?.reason ?? report.unpack ?? 'unknown';
      throw fail(rejectionCode(report), `push rejected: ${reason}`, { report, hookOutput: band2 });
    }
    return { report, packBytes: pack?.length ?? 0, entries, hookOutput: band2 };
  }));
}
