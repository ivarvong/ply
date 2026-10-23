// v2 ls-refs: the ref namespace, filtered by prefix. The one request that cannot be cached (it is the freshness source).
import { fail } from './errors.js';
import { pkts } from './pktline.js';
import { td } from './bytes.js';
import { limitError } from './limits.js';
import { frames, coded, clientSpan, proto } from './transport.js';

export const lsRefsBody = (prefixes = [], { peel = true, symrefs = true } = {}) =>
  pkts(['command=ls-refs\n', ...[peel && 'peel\n', symrefs && 'symrefs\n'].filter(Boolean), ...prefixes.map(p => `ref-prefix ${p}\n`)], { delimAfter: 0 });

export async function lsRefs(t, prefixes = []) {
  return coded('protocol', () => t.tracer.span('git.upload-pack ls-refs', clientSpan(t, { 'git.command': 'ls-refs', 'git.protocol.version': 2, 'git.ls_refs.prefixes': prefixes }), async span => {
    const refs = new Map();
    let head = null;
    for await (const f of frames(t, 'git-upload-pack', lsRefsBody(prefixes), span)) {
      if (f.kind !== 'data') continue;
      const line = td.decode(f.payload).trim();
      if (line.startsWith('ERR ')) throw fail('remote_error', `remote: ${line.slice(4)}`);
      const [oid, name, ...attrs] = line.split(' ');
      if (/^[0-9a-f]{64}$/.test(oid)) throw fail('unsupported', 'unsupported object-format: only sha1 repositories are supported');
      if (!/^[0-9a-f]{40}$/.test(oid) || !name) throw proto(`ls-refs: malformed line ${JSON.stringify(line.slice(0, 60))}`);
      const rec = { oid, name };
      for (const a of attrs) { const [k, v] = a.split(':'); rec[k] = v; }
      if (refs.size >= t.limits.maxRefs) throw limitError('ls-refs lines', refs.size + 1, t.limits.maxRefs);
      refs.set(name, rec);
      if (name === 'HEAD' && rec['symref-target']) head = rec['symref-target'];
    }
    span.set({ 'git.ls_refs.count': refs.size, 'git.ls_refs.refs': [...refs.values()].slice(0, 64).map(r => `${r.oid} ${r.name}`), 'git.ls_refs.head': head ?? '' });
    return { refs, head };
  }));
}
