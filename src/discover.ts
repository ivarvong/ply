// v2 capability discovery (GET info/refs with Git-Protocol: version=2). The edit path never needs it — v2 is asserted
// per request — but it is the only place the server says who it is: agent, object-format, and the `fetch=` features
// (shallow, filter, wait-for-done, ref-in-want...). Run it as a canary so a server-side change shows up as an attr diff.
// The advertisement is read as git's client reads it (connect.c); the space of advertisements and ply's answer to each
// is test/space/advertisement.space.js.
import type { ErrorOf, Extra } from './errors.js';
import type { Span } from './otel.js';
import type { Frame, Transport } from './transport.js';
import type { Option, Result } from './result.js';
import { fail, orThrow } from './errors.js';
import { assertNever, flatMapOption, getOrElse, mapOption, none, ok, some } from './result.js';
import { at, atOr, fromNullable, fromNullish } from './absent.js';
import { checkRequiredV2, decideObjectFormat, fetchFeatureFlags } from './closed.js';
import { td } from './bytes.js';
import { pktInit, pktStepResult, pktFinishResult, pktAttrs } from './pktline.js';
import { coded, clientSpan, advertise, proto } from './transport.js';

const SERVICE = '# service=';
const ERR = 'ERR ';
const VERSION_2 = 'version 2';
// parse_feature_value: features are separated by isspace()
// oxlint-disable-next-line require-unicode-regexp -- ASCII whitespace; `u` costs a byte
const SPACE = /[ \t\n\v\f\r]+/;

// The capability lines of a v2 advertisement, as connect.c reads them: an optional "# service=…" pkt and its flush
// (remote-curl's smart-HTTP preamble; http-backend omits it for v2), "version 2" (discover_version), then capability
// lines up to a flush and nothing after it (process_capabilities_v2: "expected flush after capabilities"; over HTTP
// a pkt after that flush is read as the next response and refused). Returns the lines in order, or the error.
type DataFrame = Extract<Frame, { readonly kind: 'data' }>;
// What a v2 advertisement can be refused with: a broken shape, the server's ERR line, an answer that is not v2.
export type CapsV2Error = ErrorOf<'protocol' | 'remote_error' | 'unsupported'>;
// oxlint-disable-next-line require-unicode-regexp -- ASCII text
const text = (f: DataFrame): string => td.decode(f.payload).replace(/\n$/, '');
// The data frame at `i`, if the frame there is one.
const dataAt = (frames: readonly Frame[], i: number): Option<DataFrame> => flatMapOption(at(frames, i), (f): Option<DataFrame> => (f.kind === 'data' ? some(f) : none));
// The kind of the frame at `i`, or 'end of stream' past the last one.
const kindAt = (frames: readonly Frame[], i: number): string => getOrElse(mapOption(at(frames, i), f => f.kind), 'end of stream');
// @decoder parseCapabilitiesV2Result prefix=caps
export function parseCapabilitiesV2Result(frames: readonly Frame[]): Result<string[], CapsV2Error> {
  let i = 0;
  const preamble = dataAt(frames, 0);
  if (preamble.tag === 'some' && text(preamble.value).startsWith(SERVICE)) {
    // check_smart_http: "The header can include additional metadata lines, up until a packet flush marker"
    i = frames.findIndex(f => f.kind !== 'data');
    if (kindAt(frames, i) !== 'flush') return proto('advertisement: no flush after the service line');
    i++;
    // a header and nothing after it: the v2 lines, if any, were read as metadata (a preamble with no flush of its own),
    // and remote-curl refuses that response
    if (i >= frames.length) return proto('advertisement: nothing after the service line');
  }
  const head = dataAt(frames, i);
  const first = head.tag === 'some' ? text(head.value) : '';
  if (first.startsWith(ERR)) return fail('remote_error', `remote: ${first.slice(ERR.length)}`);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an ad-hoc error field (errors.ts Extra); A3 moves it into Detail
  if (first !== VERSION_2) return fail('unsupported', `server did not answer protocol v2 (first line ${JSON.stringify(first)})`, { lines: [first] } as Extra);
  const lines: string[] = [];
  for (i++; ; i++) {
    const line = dataAt(frames, i);
    if (line.tag === 'none') break;
    lines.push(text(line.value));
  }
  if (kindAt(frames, i) !== 'flush') return proto(`advertisement: expected flush after capabilities, got ${kindAt(frames, i)}`);
  if (i !== frames.length - 1) return proto(`advertisement: ${kindAt(frames, i + 1)} after the capabilities' flush`);
  return ok(lines);
}
// @decoder parseCapabilitiesV2 prefix=caps
export const parseCapabilitiesV2 = (frames: readonly Frame[]): string[] => orThrow(parseCapabilitiesV2Result(frames));

// Lookups with git's semantics over the lines (first match wins, as connect.c walks server_capabilities_v2 in order):
//   has(key)       server_supports_v2: a line `key` or `key=…`
//   value(key)     server_feature_v2: the first line `key=…` (a bare `key` has no value: `object-format` alone is sha1)
//   features(key)  server_supports_feature: the first line `key` or `key=…`, its value split on whitespace, each name
//                  without its `=value` (parse_feature_value)
export type CapLookup = {
  readonly has: (key: string) => boolean;
  readonly value: (key: string) => string | null;
  readonly features: (key: string) => string[];
};
export const capLookup = (lines: readonly string[]): CapLookup => {
  const has = (key: string): boolean => lines.some(l => l === key || l.startsWith(`${key}=`));
  const value = (key: string): string | null => getOrElse(mapOption(fromNullable(lines.find(x => x.startsWith(`${key}=`))), l => l.slice(key.length + 1)), null);
  const features = (key: string): string[] => {
    const l = fromNullable(lines.find(x => x === key || x.startsWith(`${key}=`)));
    // split() returns at least one element
    return getOrElse(mapOption(l, x => x.slice(key.length + 1).split(SPACE).filter(Boolean).map(f => atOr(f.split('='), 0, ''))), []);
  };
  return { has, value, features };
};

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

// The I/O edge: the advertisement's errors are thrown.
// async: a synchronous failure is a rejection, as it always was
// oxlint-disable-next-line require-await -- see above
export async function discover(t: Transport): Promise<DiscoverInfo> {
  // oxlint-disable-next-line typescript/promise-function-async -- the span's promise, passed through (an async wrapper adds bytes, not behaviour)
  return coded('protocol', () => t.tracer.span('git.upload-pack discover', clientSpan(t, { 'git.command': 'discover', 'git.protocol.version': 2 }), async (span: Span): Promise<DiscoverInfo> => {
    const buf = await advertise(t, 'git-upload-pack', span);
    const { frames, state } = orThrow(pktStepResult(pktInit(), buf));
    orThrow(pktFinishResult(state));
    const lines = orThrow(parseCapabilitiesV2Result(frames));
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
    span.set({ ...pktAttrs(state), 'git.server.agent': info.agent, 'git.server.object_format': info.objectFormat, 'git.server.caps': [...caps.keys()], 'git.server.fetch': fetchFeatures, 'git.server.filter': info.filter, 'git.server.shallow': info.shallow, 'git.server.wait_for_done': info.waitForDone, 'git.server.ref_in_want': info.refInWant, 'git.server.ls_refs.unborn': info.lsRefsUnborn, 'git.server.server_option': info.serverOption, 'git.server.bundle_uri': info.bundleUri });
    return orThrow(serverFits(info, has));
  }));
}
