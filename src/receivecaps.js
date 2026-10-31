// v0 receive-pack capability advertisement (GET info/refs). Only needed to check optional capabilities (atomic,
// push-options) before relying on them; the v2 fetch path never needs it.
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

// What a push asks of the server that send-pack.c send_pack() checks against the advertisement before it sends a byte:
// the repository's hash ("the receiving end does not support this repository's hash algorithm": ply is sha1-only, and an
// advertisement without object-format is sha1), `atomic` ("does not support --atomic push") and `push-options` ("does
// not support push options"). Pure: the first unmet need as a string, or null.
// receive-pack ignores an `atomic` or `push-options` capability it did not advertise (builtin/receive-pack.c), so an
// unchecked atomic push lands ref by ref, and unchecked option lines are read as the pack ("unpacker error").
export function pushCapsProblem(caps, { atomic = false, pushOptions = [] } = {}) {
  const format = [...caps].find(c => c.startsWith('object-format='))?.slice('object-format='.length) ?? 'sha1';
  if (format !== 'sha1') return `server repository is object-format ${format}`;
  if (atomic && !caps.has('atomic')) return 'server does not advertise atomic';
  if (pushOptions.length && !caps.has('push-options')) return 'server does not advertise push-options';
  return null;
}

// push(), after reading the advertisement when the push needs a capability (atomic, push-options): one extra GET, only then.
export async function pushWithOptions(t, opts) {
  if (opts.atomic || opts.pushOptions?.length) {
    const caps = await receiveCaps(t);
    const problem = pushCapsProblem(caps, opts);
    if (problem) throw fail('unsupported', problem, { caps: [...caps] });
  }
  return push(t, opts);
}
