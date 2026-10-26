// v2 ls-refs: the ref namespace, filtered by prefix. The one request that cannot be cached (it is the freshness source).
import { fail } from './errors.js';
import { pkts } from './pktline.js';
import { td } from './bytes.js';
import { limitError } from './limits.js';
import { frames, coded, clientSpan, proto } from './transport.js';
import { OID_HEX_CHARS, SHA256_HEX_CHARS, PROTOCOL_V2 } from './format.js';

/* oxlint-disable no-magic-numbers -- error previews and the span's ref sample are diagnostics, not wire-format facts */
const LINE_PREVIEW = 60;
const SPAN_REFS = 64;
/* oxlint-enable no-magic-numbers */
const ERR = 'ERR ';

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
  const attrs = cut < 0 ? [] : rest.slice(cut + 1).split(' ').filter(Boolean);
  if (OID_SHA256.test(oid)) throw fail('unsupported', 'unsupported object-format: only sha1 repositories are supported');
  if (!OID_SHA1.test(oid) || !name) throw proto(`ls-refs: malformed line ${JSON.stringify(line.slice(0, LINE_PREVIEW))}`);
  const rec = { oid, name };
  for (const a of attrs) { const colon = a.indexOf(':'); rec[colon < 0 ? a : a.slice(0, colon)] = colon < 0 ? '' : a.slice(colon + 1); }
  return rec;
}

export const lsRefsBody = (prefixes = [], { peel = true, symrefs = true } = {}) =>
  pkts(['command=ls-refs\n', ...[peel && 'peel\n', symrefs && 'symrefs\n'].filter(Boolean), ...prefixes.map(p => `ref-prefix ${p}\n`)], { delimAfter: 0 });

export async function lsRefs(t, prefixes = []) {
  return coded('protocol', () => t.tracer.span('git.upload-pack ls-refs', clientSpan(t, { 'git.command': 'ls-refs', 'git.protocol.version': PROTOCOL_V2, 'git.ls_refs.prefixes': prefixes }), async span => {
    const refs = new Map();
    let head = null;
    for await (const f of frames(t, 'git-upload-pack', lsRefsBody(prefixes), span)) {
      if (f.kind !== 'data') continue;
      const line = td.decode(f.payload).trim();
      const rec = parseLsRefLine(line);
      if (refs.size >= t.limits.maxRefs) throw limitError('ls-refs lines', refs.size + 1, t.limits.maxRefs);
      refs.set(rec.name, rec);
      if (rec.name === 'HEAD' && rec['symref-target']) head = rec['symref-target'];
    }
    span.set({ 'git.ls_refs.count': refs.size, 'git.ls_refs.refs': [...refs.values()].slice(0, SPAN_REFS).map(r => `${r.oid} ${r.name}`), 'git.ls_refs.head': head ?? '' });
    return { refs, head };
  }));
}
