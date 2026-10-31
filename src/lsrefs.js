// v2 ls-refs: the ref namespace, filtered by prefix. The one request that cannot be cached (it is the freshness source).
import { fail } from './errors.js';
import { pkts } from './pktline.js';
import { decodeBytes } from './bytes.js';
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

// connect.c process_ref_v2 reads an oid with parse_oid_hex_algop, which takes either case (hexval); the oid is kept
// lowercase, as git stores it in binary and writes it back lowercase.
const OID_SHA1 = new RegExp(`^[0-9a-fA-F]{${OID_HEX_CHARS}}$`);
const OID_SHA256 = new RegExp(`^[0-9a-fA-F]{${SHA256_HEX_CHARS}}$`);
const UNBORN = 'unborn';

// One ls-refs line, as connect.c process_ref_v2 reads it: split on every space, so a doubled space is an empty field.
// Returns { oid, name, peeled?, symref-target? }, or null for an `unborn <name> …` line (git records it only for the
// unborn HEAD of a clone that asked for it, which ply never does; it is no ref).
// @decoder parseLsRefLine prefix=ls-ref
export function parseLsRefLine(line) {
  if (line.startsWith(ERR)) throw fail('remote_error', `remote: ${line.slice(ERR.length)}`);
  const sp = line.indexOf(' ');
  // Stryker disable next-line EqualityOperator: a leading space still fails the oid check with this same malformed-line error
  if (sp < 0) throw proto(`ls-refs: malformed line ${JSON.stringify(line.slice(0, LINE_PREVIEW))}`);
  const oid = line.slice(0, sp);
  if (oid === UNBORN) return null;
  const rest = line.slice(sp + 1);
  const cut = rest.indexOf(' ');
  // git takes the second field as the name even when it is empty (`<oid> ` lists a ref named "")
  const name = cut < 0 ? rest : rest.slice(0, cut);
  // Empty tokens (doubled spaces) need no filter: they have no colon and the loop skips them.
  // Stryker disable next-line ArrayDeclaration: any token injected for a name with no attributes has no `key:` before its colon, so the loop skips it
  const attrs = cut < 0 ? [] : rest.slice(cut + 1).split(' ');
  if (OID_SHA256.test(oid)) throw fail('unsupported', 'unsupported object-format: only sha1 repositories are supported');
  if (!OID_SHA1.test(oid)) throw proto(`ls-refs: malformed line ${JSON.stringify(line.slice(0, LINE_PREVIEW))}`);
  // Only `symref-target:` and `peeled:` are kept, as connect.c process_ref_v2 reads them and skips everything else, so a
  // server attribute can never stand in for the parsed oid or name. A bad peeled oid is malformed (git: invalid ls-refs response).
  const rec = { oid: oid.toLowerCase(), name };
  for (const a of attrs) {
    const colon = a.indexOf(':');
    // Stryker disable next-line EqualityOperator: a token starting with ':' has the empty key, which is neither kept attribute
    if (colon < 0) continue;
    const key = a.slice(0, colon), value = a.slice(colon + 1);
    if (key === PEELED && !OID_SHA1.test(value)) throw proto(`ls-refs: malformed line ${JSON.stringify(line.slice(0, LINE_PREVIEW))}`);
    if (key === PEELED) rec[key] = value.toLowerCase();
    else if (key === SYMREF_TARGET) rec[key] = value;
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
      // A ref name is bytes (check-ref-format allows any byte >= 0x80): decodeBytes keeps them distinct and writable back,
      // and only the LF comes off, as connect.c's packet reader chomps it. trim() also ate a trailing U+FEFF or U+00A0 (#43).
      const line = decodeBytes(f.payload).replace(/\n$/, '');
      const rec = parseLsRefLine(line);
      // A name listed twice: git keeps both in its ref list and every lookup (find_ref_by_name) takes the first.
      if (rec === null || refs.has(rec.name)) continue;
      if (refs.size >= maxRefs) throw limitError('ls-refs lines', refs.size + 1, maxRefs);
      refs.set(rec.name, rec);
      if (rec.name === 'HEAD' && rec['symref-target']) head = rec['symref-target'];
    }
    if (!ended) throw proto('ls-refs: response ended without the terminating flush-pkt');
    span.set({ 'git.ls_refs.count': refs.size, 'git.ls_refs.refs': [...refs.values()].slice(0, SPAN_REFS).map(r => `${r.oid} ${r.name}`), 'git.ls_refs.head': head ?? '' });
    return { refs, head };
  }));
}
