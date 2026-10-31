// v0 receive-pack capability advertisement (GET info/refs). Only needed to check optional capabilities (push-options)
// before relying on them; the v2 fetch path never needs it.
import { fail } from './errors.js';
import { td } from './bytes.js';
import { pktInit, pktStep } from './pktline.js';
import { coded, clientSpan, advertise } from './transport.js';
import { push } from './push.js';

export async function receiveCaps(t) {
  return coded('protocol', () => t.tracer.span('git.receive-pack advertise', clientSpan(t, { 'git.command': 'advertise', 'git.protocol.version': 0 }), async span => {
    const buf = await advertise(t, 'git-receive-pack', span);
    const { frames } = pktStep(pktInit(), buf);
    const caps = new Set();
    for (const f of frames) if (f.kind === 'data') { const line = td.decode(f.payload); const nul = line.indexOf('\0'); if (nul >= 0) { for (const c of line.slice(nul + 1).trim().split(' ')) caps.add(c); break; } }
    span.set({ 'git.receive.caps': [...caps] });
    return caps;
  }));
}

// push-options are not negotiable from the response: a server that does not advertise them reads our option lines
// as the pack and fails with "unpacker error". Check the advertisement first (one extra GET, only when options are used).
export async function pushWithOptions(t, opts) {
  if (opts.pushOptions?.length) { const caps = await receiveCaps(t); if (!caps.has('push-options')) throw fail('unsupported', 'server does not advertise push-options', { caps: [...caps] }); }
  return push(t, opts);
}
// ci/fast probe: whole-file mutation of every src file (reverted in the next commit)
