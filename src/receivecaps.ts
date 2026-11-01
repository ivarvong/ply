// v0 receive-pack capability advertisement (GET info/refs). Only needed to check optional capabilities (atomic,
// push-options) before relying on them; the v2 fetch path never needs it. Parsing the advertisement and checking a
// push against it are pure; receiveCaps is the one effect.
import { fail, orThrow } from './errors.js';
import type { ErrorOf } from './errors.js';
import { ok, assertNever } from './result.js';
import { decideObjectFormat } from './closed.js';
import type { Result } from './result.js';
import { td } from './bytes.js';
import { pktInit, pktStep, pktFinish } from './pktline.js';
import { parseCapabilitiesV2 } from './discover.js';
import { coded, clientSpan, advertise } from './transport.js';
import { push } from './push.js';
import type { CheckedCaps, PushOptions, PushResult, PushTransport } from './push.js';

// A pkt-line frame as pktStep returns it (payload only on a data frame).
import type { Frame } from './transport.js';
import type { Span } from './otel.js';

type Protocol = ErrorOf<'protocol'>;

// The index of the first frame after a smart-http "# service=<name>" header and its flush, 0 when there is none
// (remote-curl check_smart_http: the header's metadata lines run to the first flush).
function serviceHeaderEnd(frames: readonly Frame[]): Result<number, Protocol> {
  if (frames[0]?.kind !== 'data' || !td.decode(frames[0].payload).startsWith('# service=')) return ok(0);
  const flush = frames.findIndex(f => f.kind !== 'data');
  if (flush < 0 || frames[flush]?.kind !== 'flush') return fail('protocol', 'advertisement: no flush after the service header');
  return ok(flush + 1);
}

// connect.c process_ref/process_shallow parse each oid with the hash the first line's object-format names (sha1 when
// absent), so a sha256 advertisement is read whole and checkPushCaps names the need, as send-pack does.
const SHA1_HEX = 40;
const OID_HEX: ReadonlyMap<string, number> = new Map([['sha1', SHA1_HEX], ['sha256', 64]]);
const refLine = (n: number): RegExp => new RegExp(`^[0-9a-f]{${n}} [^ ]`, 'u');
const shallowLine = (n: number): RegExp => new RegExp(`^shallow [0-9a-f]{${n}}$`, 'u');
const LINE_PREVIEW = 60;
const FORMAT = 'object-format=';
// The advertisement's object-format capability, if any.
const objectFormat = (caps: ReadonlySet<string>): string | undefined => [...caps].find(c => c.startsWith(FORMAT))?.slice(FORMAT.length);

// The transport surface receiveCaps reads, beside push's.
export type CapsTransport = PushTransport;

// Pure: the advertisement's pkt frames → its capabilities.
// connect.c get_remote_heads: ref lines up to the first flush, and nothing after it is read. The capabilities ride on
// the first line (process_capabilities). A delim or response-end is "invalid packet"; the end of the response
// before the flush (a cut advertisement) is "hung up"; a line that is neither "<oid> <ref>" nor "shallow <oid>" is
// "protocol error: unexpected". Each used to be read as a complete advertisement.
// @decoder parseReceiveAdvert prefix=advertisement
export function parseReceiveAdvert(frames: readonly Frame[]): Result<Set<string>, Protocol> {
  const caps = new Set<string>();
  const end = serviceHeaderEnd(frames);
  if (!end.ok) return end;
  const at = end.value;
  // A server asked with Git-Protocol: version=2 may answer the receive-pack GET with a v2 capability advertisement
  // (Cloudflare Artifacts does): it is held to the v2 shape (discover.ts, which throws until its A pass) and, as
  // before, names no v0 capabilities.
  if (frames[at]?.kind === 'data' && td.decode(frames[at].payload).replace(/\n$/u, '') === 'version 2') { parseCapabilitiesV2(frames); return ok(caps); }
  let hex = SHA1_HEX;
  for (let k = at; ; k++) {
    const f = frames[k];
    if (!f) return fail('protocol', 'receive-pack advertisement: no flush after the refs');
    if (f.kind === 'flush') break;
    if (f.kind !== 'data') return fail('protocol', `receive-pack advertisement: invalid packet (${f.kind})`);
    const line = td.decode(f.payload).replace(/\n$/u, '');
    const nul = line.indexOf('\0');
    const head = nul < 0 ? line : line.slice(0, nul);
    // Stryker disable next-line EqualityOperator: a first line starting with NUL has no ref, so it is refused below with or without its caps read
    if (k === at && nul >= 0) {
      for (const c of line.slice(nul + 1).trim().split(' ')) caps.add(c);
      // Stryker disable next-line StringLiteral,LogicalOperator: no object-format is a key OID_HEX lacks, which keeps sha1's width either way
      hex = OID_HEX.get(objectFormat(caps) ?? '') ?? hex;
    }
    if (!refLine(hex).test(head) && !shallowLine(hex).test(head)) return fail('protocol', `receive-pack advertisement: unexpected line ${JSON.stringify(head.slice(0, LINE_PREVIEW))}`);
  }
  return ok(caps);
}

// oxlint-disable-next-line eslint/require-await -- async so a synchronous throw rejects, as before
export async function receiveCaps(t: CapsTransport): Promise<Set<string>> {
  // oxlint-disable-next-line typescript/promise-function-async -- coded awaits it; async adds a wrapper and bytes
  return coded('protocol', () => t.tracer.span('git.receive-pack advertise', clientSpan(t, { 'git.command': 'advertise', 'git.protocol.version': 0 }), async (span: Span): Promise<Set<string>> => {
    const { frames, state } = pktStep(pktInit(), await advertise(t, 'git-receive-pack', span));
    pktFinish(state);
    const caps = orThrow(parseReceiveAdvert(frames));
    span.set({ 'git.receive.caps': [...caps] });
    return caps;
  }));
}

// What a push asks of the server that send-pack.c send_pack() checks against the advertisement before it sends a byte:
// the repository's hash ("the receiving end does not support this repository's hash algorithm": ply is sha1-only, and an
// advertisement without object-format is sha1), `atomic` ("does not support --atomic push") and `push-options` ("does
// not support push options"). receive-pack ignores an `atomic` or `push-options` capability it did not advertise
// (builtin/receive-pack.c), so an unchecked atomic push lands ref by ref, and unchecked option lines are read as the
// pack ("unpacker error"): push takes them only as the CheckedCaps this makes.
export type PushWants = { readonly atomic?: boolean; readonly pushOptions?: readonly string[] };
export type CapsProblem =
  | { readonly tag: 'ok' }
  | { readonly tag: 'objectFormat'; readonly format: string }
  | { readonly tag: 'noAtomic' }
  | { readonly tag: 'noPushOptions' };
// Pure: ok, or the first unmet need. There is no null.
export function capsProblem(caps: ReadonlySet<string>, { atomic = false, pushOptions = [] }: PushWants = {}): CapsProblem {
  const advertised = objectFormat(caps);
  const decision = decideObjectFormat(typeof advertised === 'string' ? advertised : 'sha1');
  switch (decision.tag) {
    case 'refused': return { tag: 'objectFormat', format: decision.format };
    case 'ok': {
      if (atomic && !caps.has('atomic')) return { tag: 'noAtomic' };
      if (pushOptions.length > 0 && !caps.has('push-options')) return { tag: 'noPushOptions' };
      return { tag: 'ok' };
    }
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(decision);
}
const problemText = (p: Exclude<CapsProblem, { readonly tag: 'ok' }>): string => {
  switch (p.tag) {
    case 'objectFormat': return `server repository is object-format ${p.format}`;
    case 'noAtomic': return 'server does not advertise atomic';
    case 'noPushOptions': return 'server does not advertise push-options';
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(p);
};
// Pure: the push's atomic and push options, checked against the advertisement.
export function checkPushCaps(caps: ReadonlySet<string>, want: PushWants = {}): Result<CheckedCaps, ErrorOf<'unsupported'>> {
  const problem = capsProblem(caps, want);
  switch (problem.tag) {
    case 'objectFormat':
    case 'noAtomic':
    case 'noPushOptions':
      return fail('unsupported', problemText(problem), { caps: [...caps] });
    case 'ok':
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the one place a CheckedCaps is made: the brand is a type (push.ts)
      return ok({ atomic: want.atomic ?? false, pushOptions: want.pushOptions ?? [] } as CheckedCaps);
  }
  // Stryker disable next-line ConditionalExpression: unreachable, the compiler's exhaustiveness check
  return assertNever(problem);
}

// push(), after reading the advertisement when the push needs a capability (atomic, push-options): one extra GET, only then.
export type CheckedPushOptions = Omit<PushOptions, 'checked'> & PushWants;
export async function pushWithOptions(t: CapsTransport, { atomic = false, pushOptions = [], ...opts }: CheckedPushOptions): Promise<PushResult> {
  if (!atomic && pushOptions.length === 0) return push(t, opts);
  return push(t, { ...opts, checked: orThrow(checkPushCaps(await receiveCaps(t), { atomic, pushOptions })) });
}
