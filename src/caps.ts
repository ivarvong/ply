// The v2 capability advertisement as git's client reads it (connect.c): the lines, and git's lookups over them. Its own
// module so the fetch path can read one bit of it (does `fetch` take `filter`, fetch.ts) without discover's canary.
// discover.ts re-exports both; the space of advertisements and ply's answer to each is test/space/advertisement.space.js.
import type { ErrorOf, Extra } from './errors.js';
import type { Frame } from './transport.js';
import type { Option, Result } from './result.js';
import { fail, remoteQuoted, remoteText } from './errors.js';
import { flatMapOption, getOrElse, mapOption, none, ok, some } from './result.js';
import { at, atOr, fromNullable } from './absent.js';
import { td } from './bytes.js';
import { proto } from './transport.js';

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
// @decoder parseCapabilitiesV2 prefix=caps
export function parseCapabilitiesV2(frames: readonly Frame[]): Result<string[], CapsV2Error> {
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
  if (first.startsWith(ERR)) return fail('remote_error', `remote: ${remoteText(first.slice(ERR.length))}`);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an ad-hoc error field (errors.ts Extra); A3 moves it into Detail
  if (first !== VERSION_2) return fail('unsupported', `server did not answer protocol v2 (first line ${remoteQuoted(first)})`, { lines: [first] } as Extra);
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
