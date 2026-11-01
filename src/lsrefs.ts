// v2 ls-refs: the ref namespace, filtered by prefix. The one request that cannot be cached (it is the freshness source).
// The listing is read by a step function over frames (lsRefsStep, Result); lsRefs is the I/O edge and throws.
/* oxlint-disable require-unicode-regexp -- ASCII wire text; `u` costs a byte per literal */
import type { PlyError } from './errors.js';
import type { Span } from './otel.js';
import type { Frame, Transport } from './transport.js';
import type { Input } from './absent.js';
import type { Option, Result } from './result.js';
import { fail, orThrow } from './errors.js';
import { pkts } from './pktline.js';
import { decodeBytes } from './bytes.js';
import { limitExceeded, readLimit } from './limits.js';
import { validateWire } from './validate.js';
import { frames, coded, clientSpan, proto } from './transport.js';
import { OID_HEX_CHARS, SHA256_HEX_CHARS, PROTOCOL_V2 } from './format.js';
import { assertNever, err, ok } from './result.js';
// oxlint-disable-next-line import/max-dependencies -- the exchange joins the frame reader, the limits and the caller's options
import { fromNullable, readKey, withDefaults } from './absent.js';

/* oxlint-disable no-magic-numbers -- error previews and the span's ref sample are diagnostics, not wire-format facts */
const LINE_PREVIEW = 60;
const SPAN_REFS = 64;
/* oxlint-enable no-magic-numbers */
const ERR = 'ERR ';
const PEELED = 'peeled', SYMREF_TARGET = 'symref-target';

// connect.c process_ref_v2 reads an oid with parse_oid_hex_algop, which takes either case (hexval); the oid is kept
// lowercase, as git stores it in binary and writes it back lowercase.
const OID_SHA1 = new RegExp(`^[0-9a-fA-F]{${OID_HEX_CHARS}}$`);
const OID_SHA256 = new RegExp(`^[0-9a-fA-F]{${SHA256_HEX_CHARS}}$`);
const UNBORN = 'unborn';

// One ls-refs line, as connect.c process_ref_v2 reads it: split on every space, so a doubled space is an empty field.
// Returns { oid, name, peeled?, symref-target? }, or null for an `unborn <name> …` line (it is no ref: parseUnbornLine
// reads it).
// One listed ref. Only `peeled` and `symref-target` are kept from the attributes, and only when the line carries them
// (a key that is present or not: the readers in changes, merge and read test for it).
export type LsRef = { readonly oid: string; readonly name: string; readonly peeled?: string; readonly 'symref-target'?: string };
// An unborn HEAD: a symref to a branch that has no commit yet (an empty `git init --bare -b main` is
// `{ name: 'HEAD', target: 'refs/heads/main' }`). Only HEAD is ever reported, as git's client records only HEAD.
export type LsRefsUnborn = { readonly name: 'HEAD'; readonly target: string };
// head: the symref target of a born HEAD (null when HEAD is detached, unborn or not listed).
// unborn: the unborn HEAD, when the server listed one (it does only when the request says `unborn`); null otherwise.
export type LsRefsResult = { readonly refs: Map<string, LsRef>; readonly head: string | null; readonly unborn: LsRefsUnborn | null };

// @decoder parseLsRefLineResult prefix=ls-ref
export function parseLsRefLineResult(line: string): Result<LsRef | null, PlyError> {
  if (line.startsWith(ERR)) return fail('remote_error', `remote: ${line.slice(ERR.length)}`);
  const sp = line.indexOf(' ');
  // Stryker disable next-line EqualityOperator: a leading space still fails the oid check with this same malformed-line error
  if (sp < 0) return proto(`ls-refs: malformed line ${JSON.stringify(line.slice(0, LINE_PREVIEW))}`);
  const oid = line.slice(0, sp);
  if (oid === UNBORN) return ok(null);
  const rest = line.slice(sp + 1);
  const cut = rest.indexOf(' ');
  // git takes the second field as the name even when it is empty (`<oid> ` lists a ref named "")
  const name = cut < 0 ? rest : rest.slice(0, cut);
  // Empty tokens (doubled spaces) need no filter: they have no colon and the loop skips them.
  // Stryker disable next-line ArrayDeclaration: any token injected for a name with no attributes has no `key:` before its colon, so the loop skips it
  const attrs = cut < 0 ? [] : rest.slice(cut + 1).split(' ');
  if (OID_SHA256.test(oid)) return fail('unsupported', 'unsupported object-format: only sha1 repositories are supported');
  if (!OID_SHA1.test(oid)) return proto(`ls-refs: malformed line ${JSON.stringify(line.slice(0, LINE_PREVIEW))}`);
  // Only `symref-target:` and `peeled:` are kept, as connect.c process_ref_v2 reads them and skips everything else, so a
  // server attribute can never stand in for the parsed oid or name. A bad peeled oid is malformed (git: invalid ls-refs response).
  const rec: { -readonly [K in keyof LsRef]: LsRef[K] } = { oid: oid.toLowerCase(), name };
  for (const a of attrs) {
    const colon = a.indexOf(':');
    // Stryker disable next-line EqualityOperator: a token starting with ':' has the empty key, which is neither kept attribute
    if (colon < 0) continue;
    const key = a.slice(0, colon), value = a.slice(colon + 1);
    if (key === PEELED && !OID_SHA1.test(value)) return proto(`ls-refs: malformed line ${JSON.stringify(line.slice(0, LINE_PREVIEW))}`);
    if (key === PEELED) rec[key] = value.toLowerCase();
    else if (key === SYMREF_TARGET) rec[key] = value;
  }
  return ok(rec);
}
// @decoder parseLsRefLine prefix=ls-ref
export const parseLsRefLine = (line: string): LsRef | null => orThrow(parseLsRefLineResult(line));

// An `unborn <name> …` line (the first field is `unborn`), as connect.c process_ref_v2 reads it: only a line naming HEAD
// counts, and its first `symref-target:` attribute is the target git records, replacing any earlier one (the last wins).
// Any other name, or a HEAD line with no target, records nothing: `prev` stands. An empty target is recorded as no
// unborn HEAD (null): git's clone takes one only when its target is a refs/heads/ name.
// @decoder parseUnbornLine prefix=ls-unborn
export function parseUnbornLine(line: string, prev: LsRefsUnborn | null = null): LsRefsUnborn | null {
  const [first, name, ...attrs] = line.split(' ');
  if (first !== UNBORN || name !== 'HEAD') return prev;
  const attr = fromNullable(attrs.find(a => a.startsWith(`${SYMREF_TARGET}:`)));
  if (attr.tag === 'none') return prev;
  const target = attr.value.slice(SYMREF_TARGET.length + 1);
  return target === '' ? null : { name, target };
}
export type UnbornReader = typeof parseUnbornLine;

// The request, in git's order (connect.c get_remote_refs): peel, symrefs, unborn, then the prefixes. `unborn` is sent
// only to a server whose advertisement lists `ls-refs=unborn` (git: server_supports_feature("ls-refs", "unborn")).
export type LsRefsBodyConfig = { readonly peel: boolean; readonly symrefs: boolean; readonly unborn: boolean };
export type LsRefsBodyOptions = Input<LsRefsBodyConfig>;
export const lsRefsBody = (prefixes: readonly string[] = [], options: LsRefsBodyOptions = {}): Uint8Array<ArrayBuffer> => {
  const { peel, symrefs, unborn } = withDefaults(options, { peel: true, symrefs: true, unborn: false });
  return pkts(['command=ls-refs\n', ...[peel && 'peel\n', symrefs && 'symrefs\n', unborn && 'unborn\n'].filter((x): x is string => typeof x === 'string'), ...prefixes.map(p => `ref-prefix ${p}\n`)], { delimAfter: 0 });
};

// The listing as it is read: `open` until the flush that ends it, then `ended` (any frame after that is refused).
// `refs` grows in place as lines arrive (a copy per line would be quadratic in the ref count); `counted` is the names
// other than HEAD (HEAD is listed beside the refs, as git ls-remote shows it, and does not consume maxRefs: a repository
// of exactly maxRefs branches also has a HEAD line; refs/heads/HEAD is a branch and counts).
export type LsListing = {
  readonly tag: 'open' | 'ended';
  readonly refs: Map<string, LsRef>;
  readonly counted: number;
  readonly bytes: number;
  readonly head: string | null;
  readonly unborn: LsRefsUnborn | null;
};
export type LsCaps = { readonly maxBytes: number; readonly maxRefs: number; readonly unborn: Option<UnbornReader | null> };
export const lsInit = (): LsListing => ({ tag: 'open', refs: new Map(), counted: 0, bytes: 0, head: null, unborn: null });
// One frame of the listing. gitprotocol-v2 ls-refs: output = *ref flush-pkt.
export function lsRefsStep(st: LsListing, f: Frame, caps: LsCaps): Result<LsListing, PlyError> {
  switch (st.tag) {
    case 'ended': return proto(`ls-refs: ${f.kind} after the terminating flush-pkt`);
    case 'open': {
      if (f.kind === 'flush') return ok({ ...st, tag: 'ended' });
      if (f.kind !== 'data') return proto(`ls-refs: unexpected ${f.kind} in ref listing`);
      const bytes = st.bytes + f.payload.length;
      if (bytes > caps.maxBytes) return err(limitExceeded('ls-refs bytes', bytes, caps.maxBytes));
      // A ref name is bytes (check-ref-format allows any byte >= 0x80): decodeBytes keeps them distinct and writable back,
      // and only the LF comes off, as connect.c's packet reader chomps it. trim() also ate a trailing U+FEFF or U+00A0 (#43).
      const line = decodeBytes(f.payload).replace(/\n$/, '');
      const parsed = parseLsRefLineResult(line);
      if (!parsed.ok) return parsed;
      const rec = parsed.value;
      if (rec === null) {
        // oxlint-disable-next-line typescript/strict-boolean-expressions -- a reader the caller passed as null reads nothing
        const unborn = caps.unborn.tag === 'some' && caps.unborn.value ? caps.unborn.value(line, st.unborn) : st.unborn;
        return ok({ ...st, bytes, unborn });
      }
      // A name listed twice: git keeps both in its ref list and every lookup (find_ref_by_name) takes the first.
      if (st.refs.has(rec.name)) return ok({ ...st, bytes });
      let { counted } = st;
      if (rec.name !== 'HEAD') {
        if (counted >= caps.maxRefs) return err(limitExceeded('ls-refs lines', counted + 1, caps.maxRefs));
        counted += 1;
      }
      st.refs.set(rec.name, rec);
      // oxlint-disable-next-line typescript/strict-boolean-expressions -- an empty symref-target names no HEAD, as before
      const head = rec.name === 'HEAD' && rec['symref-target'] ? rec['symref-target'] : st.head;
      return ok({ ...st, bytes, counted, head });
    }
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(st.tag);
}
// git dies "expected flush after ref listing" (connect.c) when the flush is missing; a truncated listing must never
// read as "these are all the refs" (found by the calibration harness).
export function lsRefsEnd(st: LsListing): Result<LsRefsResult, PlyError> {
  switch (st.tag) {
    case 'open': return proto('ls-refs: response ended without the terminating flush-pkt');
    case 'ended': return ok({ refs: st.refs, head: st.head, unborn: st.unborn });
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(st.tag);
}

// The ls-refs exchange. `unborn` asks for the unborn HEAD and reads each unborn line (parseUnbornLine): the caller has
// checked the server advertises it (the public lsRefs in client.ts does, from the advertisement). Passed in, not
// imported, so a bundle that never asks (edit, read) carries no unborn reader. Without it an unborn line is skipped.
// async: a synchronous failure (a bad prefix, a missing limit) is a rejection, as it always was
// oxlint-disable-next-line require-await -- see above
export async function lsRefs(t: Transport, prefixes: readonly string[] = [], options: Input<{ readonly unborn: UnbornReader }> = {}): Promise<LsRefsResult> {
  for (const p of prefixes) validateWire(p, 'ref prefix');
  const maxBytes = orThrow(readLimit(t.limits, 'maxLsRefsBytes'));
  const maxRefs = orThrow(readLimit(t.limits, 'maxRefs'));
  // a reader given as null still asks, and reads nothing (as before)
  const caps: LsCaps = { maxBytes, maxRefs, unborn: readKey(options, 'unborn') };
  // oxlint-disable-next-line typescript/promise-function-async -- the span's promise, passed through (an async wrapper adds bytes, not behaviour)
  return coded('protocol', () => t.tracer.span('git.upload-pack ls-refs', clientSpan(t, { 'git.command': 'ls-refs', 'git.protocol.version': PROTOCOL_V2, 'git.ls_refs.prefixes': prefixes }), async (span: Span): Promise<LsRefsResult> => {
    let st = lsInit();
    for await (const f of frames(t, 'git-upload-pack', lsRefsBody(prefixes, { unborn: caps.unborn.tag === 'some' }), span)) st = orThrow(lsRefsStep(st, f, caps));
    const listed = orThrow(lsRefsEnd(st));
    span.set({ 'git.ls_refs.count': listed.refs.size, 'git.ls_refs.refs': [...listed.refs.values()].slice(0, SPAN_REFS).map(r => `${r.oid} ${r.name}`), 'git.ls_refs.head': listed.head === null ? '' : listed.head });
    return listed;
  }));
}
