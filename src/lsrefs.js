// v2 ls-refs: the ref namespace, filtered by prefix. The one request that cannot be cached (it is the freshness source).
import { fail } from './errors.js';
import { pkts } from './pktline.js';
import { td } from './bytes.js';
import { limitError, requireLimit } from './limits.js';
import { validateWire } from './validate.js';
import { frames, coded, clientSpan, proto } from './transport.js';
import { OID_HEX_CHARS, SHA256_HEX_CHARS, PROTOCOL_V2 } from './format.js';

/* oxlint-disable no-magic-numbers -- error previews and the span's ref sample are diagnostics, not wire-format facts */
const LINE_PREVIEW = 60;
const SPAN_REFS = 64;
/* oxlint-enable no-magic-numbers */
const ERR = 'ERR ';
const PEELED = 'peeled', SYMREF_TARGET = 'symref-target';

const OID_SHA1 = new RegExp(`^[0-9a-f]{${OID_HEX_CHARS}}$`);
const OID_SHA256 = new RegExp(`^[0-9a-f]{${SHA256_HEX_CHARS}}$`);

// @decoder parseLsRefLine prefix=ls-ref
export function parseLsRefLine(line) {
  if (line.startsWith(ERR)) throw fail('remote_error', `remote: ${line.slice(ERR.length)}`);
  const sp = line.indexOf(' ');
  // Stryker disable next-line EqualityOperator: a leading space still fails the oid check with this same malformed-line error
  if (sp < 0) throw proto(`ls-refs: malformed line ${JSON.stringify(line.slice(0, LINE_PREVIEW))}`);
  const oid = line.slice(0, sp);
  const rest = line.slice(sp + 1);
  const cut = rest.indexOf(' ');
  const name = cut < 0 ? rest : rest.slice(0, cut);
  // Empty tokens (doubled spaces) need no filter: they have no colon and the loop skips them.
  // Stryker disable next-line EqualityOperator,ArrayDeclaration,ArithmeticOperator: a cut at 0 empties the name and throws before attrs is read; any token injected for a name with no attributes, or the one-char name tail that cut - 1 adds, has no `key:` before its colon, so the loop skips it
  const attrs = cut < 0 ? [] : rest.slice(cut + 1).split(' ');
  if (OID_SHA256.test(oid)) throw fail('unsupported', 'unsupported object-format: only sha1 repositories are supported');
  if (!OID_SHA1.test(oid) || !name) throw proto(`ls-refs: malformed line ${JSON.stringify(line.slice(0, LINE_PREVIEW))}`);
  // Only `symref-target:` and `peeled:` are kept, as connect.c process_ref_v2 reads them and skips everything else, so a
  // server attribute can never stand in for the parsed oid or name. A bad peeled oid is malformed (git: invalid ls-refs response).
  const rec = { oid, name };
  for (const a of attrs) {
    const colon = a.indexOf(':');
    // Stryker disable next-line EqualityOperator: a token starting with ':' has the empty key, which is neither kept attribute
    if (colon < 0) continue;
    const key = a.slice(0, colon), value = a.slice(colon + 1);
    if (key === PEELED && !OID_SHA1.test(value)) throw proto(`ls-refs: malformed line ${JSON.stringify(line.slice(0, LINE_PREVIEW))}`);
    if (key === PEELED || key === SYMREF_TARGET) rec[key] = value;
  }
  return rec;
}

export const lsRefsBody = (prefixes = [], { peel = true, symrefs = true } = {}) =>
  pkts(['command=ls-refs\n', ...[peel && 'peel\n', symrefs && 'symrefs\n'].filter(Boolean), ...prefixes.map(p => `ref-prefix ${p}\n`)], { delimAfter: 0 });

export async function lsRefs(t, prefixes = []) {
  for (const p of prefixes) validateWire(p, 'ref prefix');
  const maxBytes = requireLimit(t.limits, 'maxLsRefsBytes');
  const maxRefs = requireLimit(t.limits, 'maxRefs');
  return coded('protocol', () => t.tracer.span('git.upload-pack ls-refs', clientSpan(t, { 'git.command': 'ls-refs', 'git.protocol.version': PROTOCOL_V2, 'git.ls_refs.prefixes': prefixes }), async span => {
    const refs = new Map();
    let head = null;
    // gitprotocol-v2 ls-refs: output = *ref flush-pkt. git dies "expected flush after ref listing" (connect.c) when the
    // flush is missing; a truncated listing must never read as "these are all the refs" (found by the calibration harness).
    let ended = false;
    let bytes = 0;
    for await (const f of frames(t, 'git-upload-pack', lsRefsBody(prefixes), span)) {
      if (ended) throw proto(`ls-refs: ${f.kind} after the terminating flush-pkt`);
      if (f.kind === 'flush') { ended = true; continue; }
      if (f.kind !== 'data') throw proto(`ls-refs: unexpected ${f.kind} in ref listing`);
      bytes += f.payload.length;
      if (bytes > maxBytes) throw limitError('ls-refs bytes', bytes, maxBytes);
      const line = td.decode(f.payload).trim();
      const rec = parseLsRefLine(line);
      if (refs.size >= maxRefs) throw limitError('ls-refs lines', refs.size + 1, maxRefs);
      refs.set(rec.name, rec);
      if (rec.name === 'HEAD' && rec['symref-target']) head = rec['symref-target'];
    }
    if (!ended) throw proto('ls-refs: response ended without the terminating flush-pkt');
    span.set({ 'git.ls_refs.count': refs.size, 'git.ls_refs.refs': [...refs.values()].slice(0, SPAN_REFS).map(r => `${r.oid} ${r.name}`), 'git.ls_refs.head': head ?? '' });
    return { refs, head };
  }));
}
