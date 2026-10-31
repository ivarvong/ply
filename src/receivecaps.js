// v0 receive-pack capability advertisement (GET info/refs). Only needed to check optional capabilities (push-options)
// before relying on them; the v2 fetch path never needs it.
import { fail } from './errors.js';
import { td } from './bytes.js';
import { pktInit, pktStep, pktFinish } from './pktline.js';
import { parseCapabilitiesV2 } from './discover.js';
import { coded, clientSpan, advertise } from './transport.js';
import { push } from './push.js';

// The index of the first frame after a smart-http "# service=<name>" header and its flush, 0 when there is none
// (remote-curl check_smart_http: the header's metadata lines run to the first flush).
function serviceHeaderEnd(frames) {
  if (frames[0]?.kind !== 'data' || !td.decode(frames[0].payload).startsWith('# service=')) return 0;
  const flush = frames.findIndex(f => f.kind !== 'data');
  if (flush < 0 || frames[flush].kind !== 'flush') throw fail('protocol', 'advertisement: no flush after the service header');
  return flush + 1;
}

const REF_LINE = /^[0-9a-f]{40} [^ ]/;
const SHALLOW_LINE = /^shallow [0-9a-f]{40}$/;
const LINE_PREVIEW = 60;

export async function receiveCaps(t) {
  return coded('protocol', () => t.tracer.span('git.receive-pack advertise', clientSpan(t, { 'git.command': 'advertise', 'git.protocol.version': 0 }), async span => {
    const buf = await advertise(t, 'git-receive-pack', span);
    const { frames, state } = pktStep(pktInit(), buf);
    pktFinish(state);
    // connect.c get_remote_heads: ref lines up to the first flush, and nothing after it is read. The capabilities ride on
    // the first line (process_capabilities). A delim or response-end is "invalid packet"; the end of the response
    // before the flush (a cut advertisement) is "hung up"; a line that is neither "<oid> <ref>" nor "shallow <oid>" is
    // "protocol error: unexpected". Each used to be read as a complete advertisement.
    const caps = new Set();
    const at = serviceHeaderEnd(frames);
    // A server asked with Git-Protocol: version=2 may answer the receive-pack GET with a v2 capability advertisement
    // (Cloudflare Artifacts does): it is held to the v2 shape (discover.js) and, as before, names no v0 capabilities.
    if (frames[at]?.kind === 'data' && td.decode(frames[at].payload).replace(/\n$/, '') === 'version 2') { parseCapabilitiesV2(frames); span.set({ 'git.receive.caps': [] }); return caps; }
    for (let k = at; ; k++) {
      const f = frames[k];
      if (!f) throw fail('protocol', 'receive-pack advertisement: no flush after the refs');
      if (f.kind === 'flush') break;
      if (f.kind !== 'data') throw fail('protocol', `receive-pack advertisement: invalid packet (${f.kind})`);
      const line = td.decode(f.payload).replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const head = nul < 0 ? line : line.slice(0, nul);
      if (!REF_LINE.test(head) && !SHALLOW_LINE.test(head)) throw fail('protocol', `receive-pack advertisement: unexpected line ${JSON.stringify(head.slice(0, LINE_PREVIEW))}`);
      if (k === at && nul >= 0) for (const c of line.slice(nul + 1).trim().split(' ')) caps.add(c);
    }
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
