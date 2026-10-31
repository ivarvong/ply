// v0 receive-pack capability advertisement (GET info/refs). Only needed to check optional capabilities (atomic,
// push-options) before relying on them; the v2 fetch path never needs it.
import { thrown as fail } from './errors.js';
import type { Extra } from './errors.js';
import { td } from './bytes.js';
import { pktInit, pktStep, pktFinish } from './pktline.js';
import { parseCapabilitiesV2 } from './discover.js';
import { coded, clientSpan, advertise } from './transport.js';
import { push } from './push.js';
import type { PushOptions, PushResult, PushTransport } from './push.js';

// A pkt-line frame as pktStep returns it (payload only on a data frame).
type Frame = { readonly kind: string; readonly payload?: Uint8Array };

// The index of the first frame after a smart-http "# service=<name>" header and its flush, 0 when there is none
// (remote-curl check_smart_http: the header's metadata lines run to the first flush).
function serviceHeaderEnd(frames: readonly Frame[]): number {
  if (frames[0]?.kind !== 'data' || !td.decode(frames[0].payload).startsWith('# service=')) return 0;
  const flush = frames.findIndex(f => f.kind !== 'data');
  if (flush < 0 || frames[flush]?.kind !== 'flush') throw fail('protocol', 'advertisement: no flush after the service header');
  return flush + 1;
}

// connect.c process_ref/process_shallow parse each oid with the hash the first line's object-format names (sha1 when
// absent), so a sha256 advertisement is read whole and pushCapsProblem names the need, as send-pack does.
const SHA1_HEX = 40;
const OID_HEX: ReadonlyMap<string, number> = new Map([['sha1', SHA1_HEX], ['sha256', 64]]);
const refLine = (n: number): RegExp => new RegExp(`^[0-9a-f]{${n}} [^ ]`, 'u');
const shallowLine = (n: number): RegExp => new RegExp(`^shallow [0-9a-f]{${n}}$`, 'u');
const LINE_PREVIEW = 60;

// The transport surface receiveCaps reads, beside push's.
export type CapsTransport = PushTransport;

// oxlint-disable-next-line eslint/require-await -- async so a synchronous throw rejects, as before
export async function receiveCaps(t: CapsTransport): Promise<Set<string>> {
  // oxlint-disable-next-line typescript/promise-function-async -- coded awaits it; async adds a wrapper and bytes
  return coded('protocol', () => t.tracer.span('git.receive-pack advertise', clientSpan(t, { 'git.command': 'advertise', 'git.protocol.version': 0 }), async (span): Promise<Set<string>> => {
    const buf: Uint8Array = await advertise(t, 'git-receive-pack', span);
    const { frames, state }: { readonly frames: readonly Frame[]; readonly state: unknown } = pktStep(pktInit(), buf);
    pktFinish(state);
    // connect.c get_remote_heads: ref lines up to the first flush, and nothing after it is read. The capabilities ride on
    // the first line (process_capabilities). A delim or response-end is "invalid packet"; the end of the response
    // before the flush (a cut advertisement) is "hung up"; a line that is neither "<oid> <ref>" nor "shallow <oid>" is
    // "protocol error: unexpected". Each used to be read as a complete advertisement.
    const caps = new Set<string>();
    const at = serviceHeaderEnd(frames);
    // A server asked with Git-Protocol: version=2 may answer the receive-pack GET with a v2 capability advertisement
    // (Cloudflare Artifacts does): it is held to the v2 shape (discover.js) and, as before, names no v0 capabilities.
    if (frames[at]?.kind === 'data' && td.decode(frames[at].payload).replace(/\n$/u, '') === 'version 2') { parseCapabilitiesV2(frames); span.set({ 'git.receive.caps': [] }); return caps; }
    let hex = SHA1_HEX;
    for (let k = at; ; k++) {
      const f = frames[k];
      if (!f) throw fail('protocol', 'receive-pack advertisement: no flush after the refs');
      if (f.kind === 'flush') break;
      if (f.kind !== 'data') throw fail('protocol', `receive-pack advertisement: invalid packet (${f.kind})`);
      const line = td.decode(f.payload).replace(/\n$/u, '');
      const nul = line.indexOf('\0');
      const head = nul < 0 ? line : line.slice(0, nul);
      if (k === at && nul >= 0) {
        for (const c of line.slice(nul + 1).trim().split(' ')) caps.add(c);
        const format = [...caps].find(c => c.startsWith('object-format='))?.slice('object-format='.length);
        hex = OID_HEX.get(format ?? '') ?? hex;
      }
      if (!refLine(hex).test(head) && !shallowLine(hex).test(head)) throw fail('protocol', `receive-pack advertisement: unexpected line ${JSON.stringify(head.slice(0, LINE_PREVIEW))}`);
    }
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
export function pushCapsProblem(caps: ReadonlySet<string>, { atomic = false, pushOptions = [] }: { readonly atomic?: boolean; readonly pushOptions?: readonly string[] } = {}): string | null {
  const format = [...caps].find(c => c.startsWith('object-format='))?.slice('object-format='.length) ?? 'sha1';
  if (format !== 'sha1') return `server repository is object-format ${format}`;
  if (atomic && !caps.has('atomic')) return 'server does not advertise atomic';
  if (pushOptions.length > 0 && !caps.has('push-options')) return 'server does not advertise push-options';
  return null;
}

// push(), after reading the advertisement when the push needs a capability (atomic, push-options): one extra GET, only then.
export async function pushWithOptions(t: CapsTransport, opts: PushOptions): Promise<PushResult> {
  if ((opts.atomic ?? false) || (opts.pushOptions?.length ?? 0) > 0) {
    const caps = await receiveCaps(t);
    const problem = pushCapsProblem(caps, opts);
    if (problem !== null) throw fail('unsupported', problem, { caps: [...caps] } as Extra & { readonly caps: readonly string[] });
  }
  return push(t, opts);
}
