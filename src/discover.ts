// v2 capability discovery (GET info/refs with Git-Protocol: version=2). The edit path never needs it — v2 is asserted
// per request — but it is the only place the server says who it is: agent, object-format, and the `fetch=` features
// (shallow, filter, wait-for-done, ref-in-want...). Run it as a canary so a server-side change shows up as an attr diff.
// The advertisement is read as git's client reads it (connect.c); the space of advertisements and ply's answer to each
// is test/space/advertisement.space.js.
import type { ErrorOf, Extra, PlyError } from './errors.js';
import type { Span } from './otel.js';
import type { Transport } from './transport.js';
import type { Result } from './result.js';
import { fail } from './errors.js';
import { assertNever, getOrElse, ok } from './result.js';
import { fromNullish } from './absent.js';
import { checkRequiredV2, decideObjectFormat, fetchFeatureFlags } from './closed.js';
import { pktInit, pktStep, pktFinish, pktAttrs } from './pktline.js';
import { asTransport, coded, clientSpan, advertise, spanned, learnFilter, learnShallow } from './transport.js';
import { capLookup, parseCapabilitiesV2 } from './caps.js';

export { capLookup, parseCapabilitiesV2 } from './caps.js';
export type { CapLookup, CapsV2Error } from './caps.js';

// What the server said about itself in its v2 advertisement.
export type DiscoverInfo = {
  readonly version: 2; readonly agent: string; readonly objectFormat: string; readonly caps: Map<string, string>;
  readonly fetch: readonly string[]; readonly filter: boolean; readonly shallow: boolean; readonly waitForDone: boolean; readonly refInWant: boolean; readonly sidebandAll: boolean;
  readonly lsRefs: boolean; readonly lsRefsUnborn: boolean; readonly serverOption: boolean; readonly bundleUri: boolean; readonly sessionId: string;
};

// Every ply read is ls-refs then fetch: a server without either cannot serve ply (git: "server doesn't support '%s'"),
// and ply reads sha1 repositories only.
function serverFits(info: DiscoverInfo, has: (key: string) => boolean): Result<DiscoverInfo, ErrorOf<'unsupported'>> {
  const required = checkRequiredV2(has);
  switch (required.tag) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an ad-hoc error field (errors.ts Extra); A3 moves it into Detail
    case 'missing': return fail('unsupported', `server does not advertise ${required.cap}`, { info } as Extra);
    case 'ok': {
      const decision = decideObjectFormat(info.objectFormat);
      switch (decision.tag) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above
        case 'refused': return fail('unsupported', `unsupported object-format ${decision.format}`, { info } as Extra);
        case 'ok': return ok(info);
      }
      // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
      return assertNever(decision);
    }
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(required);
}

// The exchange: the advertisement, read and held to what ply needs.
// oxlint-disable-next-line require-await -- async: a synchronous failure (an unusable transport) is a rejection, as it always was
export async function discover(t: Transport): Promise<Result<DiscoverInfo, PlyError>> {
  // oxlint-disable-next-line typescript/promise-function-async -- the exchange's promise, passed through (an async wrapper adds bytes, not behaviour)
  return coded('protocol', () => spanned(t, 'git.upload-pack discover', clientSpan(t, { 'git.command': 'discover', 'git.protocol.version': 2 }), async (span: Span): Promise<Result<DiscoverInfo, PlyError>> => {
    const buf = await advertise(t, 'git-upload-pack', span);
    if (!buf.ok) return buf;
    const stepped = pktStep(pktInit(), buf.value);
    if (!stepped.ok) return stepped;
    const { frames, state } = stepped.value;
    const finished = pktFinish(state);
    if (!finished.ok) return finished;
    const parsed = parseCapabilitiesV2(frames);
    if (!parsed.ok) return parsed;
    const lines = parsed.value;
    const { has, value, features } = capLookup(lines);
    const caps = new Map<string, string>();
    for (const l of lines) { const eq = l.indexOf('='); const k = eq < 0 ? l : l.slice(0, eq); if (!caps.has(k)) caps.set(k, eq < 0 ? '' : l.slice(eq + 1)); }
    const fetchFeatures = features('fetch');
    const fetchFlags = fetchFeatureFlags(fetchFeatures);
    const info: DiscoverInfo = {
      version: 2, agent: getOrElse(fromNullish(value('agent')), ''), objectFormat: getOrElse(fromNullish(value('object-format')), 'sha1'), caps,
      fetch: fetchFeatures, filter: fetchFlags.filter, shallow: fetchFlags.shallow, waitForDone: fetchFlags.waitForDone, refInWant: fetchFlags.refInWant, sidebandAll: fetchFlags.sidebandAll,
      lsRefs: has('ls-refs'), lsRefsUnborn: features('ls-refs').includes('unborn'), serverOption: has('server-option'), bundleUri: has('bundle-uri'), sessionId: getOrElse(fromNullish(value('session-id')), ''),
    };
    // The fetch path reads the same bit when a filtered fetch dies (fetch.ts filterUnadvertised); an advertisement in
    // hand answers it first. A host that stops (or starts) advertising `filter` is followed either way. A transport handed
    // in without a quirks record has no memory to keep it in (asTransport gives the view a fresh one).
    learnFilter(asTransport(t, t.limits), info.filter);
    // and whether it takes `deepen`: a single-object fetch adds depth 1 only for a server that lists `shallow` (objectAt)
    learnShallow(asTransport(t, t.limits), info.shallow);
    span.set({ ...pktAttrs(state), 'git.server.agent': info.agent, 'git.server.object_format': info.objectFormat, 'git.server.caps': [...caps.keys()], 'git.server.fetch': fetchFeatures, 'git.server.filter': info.filter, 'git.server.shallow': info.shallow, 'git.server.wait_for_done': info.waitForDone, 'git.server.ref_in_want': info.refInWant, 'git.server.ls_refs.unborn': info.lsRefsUnborn, 'git.server.server_option': info.serverOption, 'git.server.bundle_uri': info.bundleUri });
    return serverFits(info, has);
  }));
}
