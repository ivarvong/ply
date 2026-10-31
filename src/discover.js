// v2 capability discovery (GET info/refs with Git-Protocol: version=2). The edit path never needs it — v2 is asserted
// per request — but it is the only place the server says who it is: agent, object-format, and the `fetch=` features
// (shallow, filter, wait-for-done, ref-in-want...). Run it as a canary so a server-side change shows up as an attr diff.
import { fail } from './errors.js';
import { td } from './bytes.js';
import { pktInit, pktStep, pktFinish, pktAttrs } from './pktline.js';
import { coded, clientSpan, advertise } from './transport.js';

export async function discover(t) {
  return coded('protocol', () => t.tracer.span('git.upload-pack discover', clientSpan(t, { 'git.command': 'discover', 'git.protocol.version': 2 }), async span => {
    const buf = await advertise(t, 'git-upload-pack', span);
    const { frames, state } = pktStep(pktInit(), buf);
    pktFinish(state);
    const lines = frames.filter(f => f.kind === 'data').map(f => td.decode(f.payload).replace(/\n$/, '')).filter(l => !l.startsWith('# service='));
    if (lines[0] !== 'version 2') throw fail('unsupported', `server did not answer protocol v2 (first line ${JSON.stringify(lines[0] ?? '')})`, { lines });
    const caps = new Map();
    for (const l of lines.slice(1)) { const eq = l.indexOf('='); caps.set(eq < 0 ? l : l.slice(0, eq), eq < 0 ? '' : l.slice(eq + 1)); }
    const fetchFeatures = (caps.get('fetch') ?? '').split(' ').filter(Boolean);
    const info = {
      version: 2, agent: caps.get('agent') ?? '', objectFormat: caps.get('object-format') ?? 'sha1', caps,
      fetch: fetchFeatures, filter: fetchFeatures.includes('filter'), shallow: fetchFeatures.includes('shallow'), waitForDone: fetchFeatures.includes('wait-for-done'), refInWant: fetchFeatures.includes('ref-in-want'),
      lsRefsUnborn: (caps.get('ls-refs') ?? '').split(' ').includes('unborn'), serverOption: caps.has('server-option'), bundleUri: caps.has('bundle-uri'),
    };
    span.set({ ...pktAttrs(state), 'git.server.agent': info.agent, 'git.server.object_format': info.objectFormat, 'git.server.caps': [...caps.keys()], 'git.server.fetch': fetchFeatures, 'git.server.filter': info.filter, 'git.server.shallow': info.shallow, 'git.server.wait_for_done': info.waitForDone, 'git.server.ref_in_want': info.refInWant, 'git.server.ls_refs.unborn': info.lsRefsUnborn, 'git.server.server_option': info.serverOption, 'git.server.bundle_uri': info.bundleUri });
    if (info.objectFormat !== 'sha1') throw fail('unsupported', `unsupported object-format ${info.objectFormat}`, { info });
    return info;
  }));
}
