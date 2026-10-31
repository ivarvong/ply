// v2 capability discovery (GET info/refs with Git-Protocol: version=2). The edit path never needs it — v2 is asserted
// per request — but it is the only place the server says who it is: agent, object-format, and the `fetch=` features
// (shallow, filter, wait-for-done, ref-in-want...). Run it as a canary so a server-side change shows up as an attr diff.
// The advertisement is read as git's client reads it (connect.c); the space of advertisements and ply's answer to each
// is test/space/advertisement.space.js.
import { fail } from './errors.js';
import { td } from './bytes.js';
import { pktInit, pktStep, pktFinish, pktAttrs } from './pktline.js';
import { coded, clientSpan, advertise, proto } from './transport.js';

const SERVICE = '# service=';
const ERR = 'ERR ';
const VERSION_2 = 'version 2';
// parse_feature_value: features are separated by isspace()
const SPACE = /[ \t\n\v\f\r]+/;

// The capability lines of a v2 advertisement, as connect.c reads them: an optional "# service=…" pkt and its flush
// (remote-curl's smart-HTTP preamble; http-backend omits it for v2), "version 2" (discover_version), then capability
// lines up to a flush and nothing after it (process_capabilities_v2: "expected flush after capabilities"; over HTTP
// a pkt after that flush is read as the next response and refused). Returns the lines in order; throws otherwise.
// @decoder parseCapabilitiesV2 prefix=caps
export function parseCapabilitiesV2(frames) {
  const text = f => td.decode(f.payload).replace(/\n$/, '');
  let i = 0;
  if (frames[0]?.kind === 'data' && text(frames[0]).startsWith(SERVICE)) {
    // check_smart_http: "The header can include additional metadata lines, up until a packet flush marker"
    i = frames.findIndex(f => f.kind !== 'data');
    if (frames[i]?.kind !== 'flush') throw proto('advertisement: no flush after the service line');
    i++;
    // a header and nothing after it: the v2 lines, if any, were read as metadata (a preamble with no flush of its own),
    // and remote-curl refuses that response
    if (i >= frames.length) throw proto('advertisement: nothing after the service line');
  }
  const first = frames[i]?.kind === 'data' ? text(frames[i]) : '';
  if (first.startsWith(ERR)) throw fail('remote_error', `remote: ${first.slice(ERR.length)}`);
  if (first !== VERSION_2) throw fail('unsupported', `server did not answer protocol v2 (first line ${JSON.stringify(first)})`, { lines: [first] });
  const lines = [];
  for (i++; i < frames.length && frames[i].kind === 'data'; i++) lines.push(text(frames[i]));
  if (frames[i]?.kind !== 'flush') throw proto(`advertisement: expected flush after capabilities, got ${frames[i]?.kind ?? 'end of stream'}`);
  if (i !== frames.length - 1) throw proto(`advertisement: ${frames[i + 1].kind} after the capabilities' flush`);
  return lines;
}

// Lookups with git's semantics over the lines (first match wins, as connect.c walks server_capabilities_v2 in order):
//   has(key)       server_supports_v2: a line `key` or `key=…`
//   value(key)     server_feature_v2: the first line `key=…` (a bare `key` has no value: `object-format` alone is sha1)
//   features(key)  server_supports_feature: the first line `key` or `key=…`, its value split on whitespace, each name
//                  without its `=value` (parse_feature_value)
export const capLookup = lines => {
  const has = key => lines.some(l => l === key || l.startsWith(`${key}=`));
  const value = key => { const l = lines.find(x => x.startsWith(`${key}=`)); return l === undefined ? null : l.slice(key.length + 1); };
  const features = key => {
    const l = lines.find(x => x === key || x.startsWith(`${key}=`));
    return l === undefined ? [] : l.slice(key.length + 1).split(SPACE).filter(Boolean).map(f => f.split('=')[0]);
  };
  return { has, value, features };
};

export async function discover(t) {
  return coded('protocol', () => t.tracer.span('git.upload-pack discover', clientSpan(t, { 'git.command': 'discover', 'git.protocol.version': 2 }), async span => {
    const buf = await advertise(t, 'git-upload-pack', span);
    const { frames, state } = pktStep(pktInit(), buf);
    pktFinish(state);
    const lines = parseCapabilitiesV2(frames);
    const { has, value, features } = capLookup(lines);
    const caps = new Map();
    for (const l of lines) { const eq = l.indexOf('='); const k = eq < 0 ? l : l.slice(0, eq); if (!caps.has(k)) caps.set(k, eq < 0 ? '' : l.slice(eq + 1)); }
    const fetchFeatures = features('fetch');
    const info = {
      version: 2, agent: value('agent') ?? '', objectFormat: value('object-format') ?? 'sha1', caps,
      fetch: fetchFeatures, filter: fetchFeatures.includes('filter'), shallow: fetchFeatures.includes('shallow'), waitForDone: fetchFeatures.includes('wait-for-done'), refInWant: fetchFeatures.includes('ref-in-want'), sidebandAll: fetchFeatures.includes('sideband-all'),
      lsRefs: has('ls-refs'), lsRefsUnborn: features('ls-refs').includes('unborn'), serverOption: has('server-option'), bundleUri: has('bundle-uri'), sessionId: value('session-id') ?? '',
    };
    span.set({ ...pktAttrs(state), 'git.server.agent': info.agent, 'git.server.object_format': info.objectFormat, 'git.server.caps': [...caps.keys()], 'git.server.fetch': fetchFeatures, 'git.server.filter': info.filter, 'git.server.shallow': info.shallow, 'git.server.wait_for_done': info.waitForDone, 'git.server.ref_in_want': info.refInWant, 'git.server.ls_refs.unborn': info.lsRefsUnborn, 'git.server.server_option': info.serverOption, 'git.server.bundle_uri': info.bundleUri });
    // Every ply read is ls-refs then fetch: a server without either cannot serve ply (git: "server doesn't support '%s'").
    for (const need of ['ls-refs', 'fetch']) if (!has(need)) throw fail('unsupported', `server does not advertise ${need}`, { info });
    if (info.objectFormat !== 'sha1') throw fail('unsupported', `unsupported object-format ${info.objectFormat}`, { info });
    return info;
  }));
}
// ci/fast probe 2: whole-file mutation of every src file (reverted in the next commit)
