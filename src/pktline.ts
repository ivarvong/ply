// pkt-line framing. 4 hex length (inclusive) + payload. 0000 flush, 0001 delim, 0002 response-end.
// Decoder is a pure step function over an immutable state record. Errors are values: every function that can refuse
// returns a Result.
import type { ErrorOf } from './errors.js';
import { fail } from './errors.js';
import type { Err, Result } from './result.js';
import type { Input } from './absent.js';
import { ok } from './result.js';
import { te, concat, encodeBytes, HEXV } from './bytes.js';
import {
  PKT_LEN_HEX, PKT_HEX_BASE, PKT_FLUSH, PKT_DELIM, PKT_RESPONSE_END, PKT_LEN_INVALID,
  PKT_MAX_PAYLOAD, PKT_READ_MAX_PAYLOAD, PKT_LEN_SHIFTS,
} from './format.js';

type Protocol = ErrorOf<'protocol'>;
const proto = (msg: string): Err<Protocol> => fail('protocol', msg);

// The one pkt-line writer. A line longer than git's LARGE_PACKET_MAX is the caller's (a push option, a ref prefix, a
// want or filter: fields without a length rule of their own), refused before any byte is written, as git's
// format_packet dies "impossibly long line" (pkt-line.c). bad_request: no retry can make the line shorter.
export function pkt(payload: string | Uint8Array): Result<Uint8Array<ArrayBuffer>, ErrorOf<'bad_request'>> {
  // a ref name read from ls-refs may hold escaped bytes (#43): encodeBytes writes them back as the server sent them
  let p: Uint8Array;
  if (typeof payload === 'string') {
    const e = encodeBytes(payload, 'pkt-line');
    if (!e.ok) return e;
    p = e.value;
  } else p = payload;
  if (p.length > PKT_MAX_PAYLOAD) return fail('bad_request', `pkt-line payload too large: ${p.length} bytes, the most git frames is ${PKT_MAX_PAYLOAD}`, { what: 'pkt-line', got: p.length, max: PKT_MAX_PAYLOAD });
  const out = new Uint8Array(PKT_LEN_HEX + p.length);
  out.set(te.encode((p.length + PKT_LEN_HEX).toString(PKT_HEX_BASE).padStart(PKT_LEN_HEX, '0')));
  out.set(p, PKT_LEN_HEX);
  return ok(out);
}
export const FLUSH: Uint8Array = te.encode('0000');
export const DELIM: Uint8Array = te.encode('0001');

// delimAfter: the index of the line a delim packet follows (-1: none); flush: end with a flush packet.
export type PktsConfig = { readonly delimAfter: number; readonly flush: boolean };
export type PktsOptions = Input<PktsConfig>;
export function pkts(lines: ReadonlyArray<string | Uint8Array>, { delimAfter = -1, flush = true }: PktsOptions = {}): Result<Uint8Array<ArrayBuffer>, ErrorOf<'bad_request'>> {
  const parts: Uint8Array[] = [];
  for (const [i, l] of lines.entries()) {
    const framed = pkt(l);
    if (!framed.ok) return framed;
    parts.push(framed.value);
    if (i === delimAfter) parts.push(DELIM);
  }
  if (flush) parts.push(FLUSH);
  return ok(concat(parts));
}

export type PktState = {
  readonly carry: Uint8Array | null;
  readonly frames: number;
  readonly data: number;
  readonly flush: number;
  readonly delim: number;
  readonly end: number;
  readonly bytes: number;
  readonly maxPayload: number;
  readonly carryMax: number;
};
export type PktFrame =
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'end' }
  | { readonly kind: 'data'; readonly payload: Uint8Array };

export const pktInit = (): PktState => Object.freeze({
  carry: null, frames: 0, data: 0, flush: 0, delim: 0, end: 0, bytes: 0, maxPayload: 0, carryMax: 0,
});

// (state, chunk) -> { state, frames: [{kind, payload?}] }. Carry is bounded by one max pkt: a length is checked
// (pktHeader) before the loop waits for its payload. A data payload is a copy, so a caller that keeps a frame keeps one
// frame and may drop the chunk it came in (peak: one chunk plus one frame, #172). Every slice below is inside a length
// the loop has already checked: nothing here can be short.
export type PktStepped = { frames: PktFrame[]; state: PktState };
// @decoder pktStep prefix=pkt
// oxlint-disable-next-line eslint/complexity -- one frame loop, a switch on the length
export function pktStep(st: PktState, chunk: Uint8Array): Result<PktStepped, Protocol> {
  const frames: PktFrame[] = [];
  const buf = st.carry ? concat([st.carry, chunk]) : chunk;
  let p = 0;
  let { data, flush, delim, end, maxPayload } = st;
  frame: while (buf.length - p >= PKT_LEN_HEX) {
    // the four length bytes are in buf (the loop), HEXV covers every byte value and PKT_LEN_SHIFTS has four entries:
    // every read here is in range, which noUncheckedIndexedAccess cannot see (`as number`, not the `!` src/ forbids)
    /* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style, no-magic-numbers -- in-range reads of the four length bytes at p, see above */
    const a = HEXV[buf[p] as number] as number;
    const b = HEXV[buf[p + 1] as number] as number;
    const c = HEXV[buf[p + 2] as number] as number;
    const d = HEXV[buf[p + 3] as number] as number;
    if ((a | b | c | d) < 0) return proto(`bad pkt-line length at byte ${st.bytes - (buf.length - chunk.length) + p}`);
    const len = (a << (PKT_LEN_SHIFTS[0] as number)) | (b << (PKT_LEN_SHIFTS[1] as number)) | (c << (PKT_LEN_SHIFTS[2] as number)) | d;
    /* oxlint-enable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style, no-magic-numbers */
    // git's packet_read_with_status, by length: the three control packets, the invalid 0003, then data
    switch (len) {
      case PKT_FLUSH: flush++; frames.push({ kind: 'flush' }); break;
      case PKT_DELIM: delim++; frames.push({ kind: 'delim' }); break;
      case PKT_RESPONSE_END: end++; frames.push({ kind: 'end' }); break;
      case PKT_LEN_INVALID: return proto(`invalid pkt-line length ${len}`);
      default: {
        // git's reader refuses a payload that does not fit its LARGE_PACKET_MAX buffer before reading it (pkt-line.c),
        // so the bound is checked before the loop waits for (and carries) the payload
        if (len - PKT_LEN_HEX > PKT_READ_MAX_PAYLOAD) return proto(`bad pkt-line length ${len - PKT_LEN_HEX}`);
        if (buf.length - p < len) break frame;
        const payload = buf.slice(p + PKT_LEN_HEX, p + len);
        data++;
        // Stryker disable next-line EqualityOperator: a payload equal to the current maximum leaves the maximum unchanged
        if (payload.length > maxPayload) maxPayload = payload.length;
        frames.push({ kind: 'data', payload });
        p += len - PKT_LEN_HEX;
      }
    }
    p += PKT_LEN_HEX;
  }
  const carry = p < buf.length ? buf.slice(p) : null;
  return ok({
    frames,
    state: Object.freeze({
      carry, data, flush, delim, end, maxPayload,
      frames: st.frames + frames.length,
      bytes: st.bytes + chunk.length,
      carryMax: Math.max(st.carryMax, carry ? carry.length : 0),
    }),
  });
}
// @decoder pktFinish prefix=pkt
export function pktFinish(st: PktState): Result<PktState, Protocol> {
  // pktStep carries null, never an empty array, when nothing is left
  return st.carry ? proto(`trailing ${st.carry.length} bytes after last pkt-line`) : ok(st);
}

export const pktAttrs = (st: PktState, prefix = 'git.pkt'): Record<string, number> => ({
  [`${prefix}.frames`]: st.frames, [`${prefix}.data`]: st.data, [`${prefix}.flush`]: st.flush,
  [`${prefix}.delim`]: st.delim, [`${prefix}.end`]: st.end, [`${prefix}.bytes`]: st.bytes,
  [`${prefix}.payload.max`]: st.maxPayload, [`${prefix}.carry.max`]: st.carryMax,
});
