// pkt-line framing. 4 hex length (inclusive) + payload. 0000 flush, 0001 delim, 0002 response-end.
// Decoder is a pure step function over an immutable state record. Errors are values: the `…Result` functions return
// them; `pkt`, `pktStep` and `pktFinish` are the throwing forms for callers not yet on Result (docs/STACK.md).
import type { ErrorOf } from './errors.js';
import { fail, orThrow } from './errors.js';
import type { Err, Result } from './result.js';
import { ok, assertNever } from './result.js';
import { te, concat, encodeBytesResult, HEXV } from './bytes.js';
import {
  PKT_LEN_HEX, PKT_HEX_BASE, PKT_FLUSH, PKT_DELIM, PKT_RESPONSE_END, PKT_LEN_INVALID,
  PKT_MAX_PAYLOAD, PKT_READ_MAX_PAYLOAD, PKT_LEN_SHIFTS,
} from './format.js';

type Protocol = ErrorOf<'protocol'>;
const proto = (msg: string): Err<Protocol> => fail('protocol', msg);

// The one pkt-line writer. A line longer than git's LARGE_PACKET_MAX is the caller's (a push option, a ref prefix, a
// want or filter: fields without a length rule of their own), refused before any byte is written, as git's
// format_packet dies "impossibly long line" (pkt-line.c). bad_request: no retry can make the line shorter.
export function pktResult(payload: string | Uint8Array): Result<Uint8Array<ArrayBuffer>, ErrorOf<'bad_request'>> {
  // a ref name read from ls-refs may hold escaped bytes (#43): encodeBytes writes them back as the server sent them
  let p: Uint8Array;
  if (typeof payload === 'string') {
    const e = encodeBytesResult(payload, 'pkt-line');
    if (!e.ok) return e;
    p = e.value;
  } else p = payload;
  if (p.length > PKT_MAX_PAYLOAD) return fail('bad_request', `pkt-line payload too large: ${p.length} bytes, the most git frames is ${PKT_MAX_PAYLOAD}`, { what: 'pkt-line', got: p.length, max: PKT_MAX_PAYLOAD });
  const out = new Uint8Array(PKT_LEN_HEX + p.length);
  out.set(te.encode((p.length + PKT_LEN_HEX).toString(PKT_HEX_BASE).padStart(PKT_LEN_HEX, '0')));
  out.set(p, PKT_LEN_HEX);
  return ok(out);
}
export const pkt = (payload: string | Uint8Array): Uint8Array<ArrayBuffer> => orThrow(pktResult(payload));
export const FLUSH: Uint8Array = te.encode('0000');
export const DELIM: Uint8Array = te.encode('0001');

export type PktsOptions = { readonly delimAfter?: number; readonly flush?: boolean };
export const pkts = (lines: ReadonlyArray<string | Uint8Array>, { delimAfter = -1, flush = true }: PktsOptions = {}): Uint8Array<ArrayBuffer> =>
  concat(lines.flatMap((l, i) => (i === delimAfter ? [pkt(l), DELIM] : [pkt(l)])).concat(flush ? [FLUSH] : []));

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

// What the four length bytes say: git's packet_read_with_status (pkt-line.c) as a closed set. A non-hex byte (either
// case is hex) is "bad line length character"; 0000/0001/0002 are flush/delim/response-end; 0003 is "bad line length";
// a payload of LARGE_PACKET_MAX bytes or more (the packet_buffer it reads into) is "bad line length" too, so the
// longest frame git reads is 65523 bytes, three past the 65520 its writer emits. A length is classified, and so
// bounded, before the payload is waited for or sliced.
export type PktHeader =
  | { readonly tag: 'flush' } | { readonly tag: 'delim' } | { readonly tag: 'end' }
  | { readonly tag: 'data'; readonly len: number }
  | { readonly tag: 'bad_hex' } | { readonly tag: 'invalid'; readonly len: number } | { readonly tag: 'too_long'; readonly payload: number };
export function pktHeader(h: Uint8Array): PktHeader {
  // h holds PKT_LEN_HEX bytes, HEXV covers every byte value and PKT_LEN_SHIFTS has four entries: every read here is in
  // range, which noUncheckedIndexedAccess cannot see; `as number` (not the `!` src/ forbids) costs nothing at runtime
  /* oxlint-disable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style -- in-range reads, see above */
  const a = HEXV[h[0] as number] as number;
  const b = HEXV[h[1] as number] as number;
  const c = HEXV[h[2] as number] as number;
  const d = HEXV[h[3] as number] as number;
  if ((a | b | c | d) < 0) return { tag: 'bad_hex' };
  const len = (a << (PKT_LEN_SHIFTS[0] as number)) | (b << (PKT_LEN_SHIFTS[1] as number)) | (c << (PKT_LEN_SHIFTS[2] as number)) | d;
  /* oxlint-enable typescript/no-unsafe-type-assertion, typescript/non-nullable-type-assertion-style */
  switch (len) {
    case PKT_FLUSH: return { tag: 'flush' };
    case PKT_DELIM: return { tag: 'delim' };
    case PKT_RESPONSE_END: return { tag: 'end' };
    case PKT_LEN_INVALID: return { tag: 'invalid', len };
    default: return len - PKT_LEN_HEX > PKT_READ_MAX_PAYLOAD ? { tag: 'too_long', payload: len - PKT_LEN_HEX } : { tag: 'data', len };
  }
}

// (state, chunk) -> { state, frames: [{kind, payload?}] }. Carry is bounded by one max pkt: a length is checked
// (pktHeader) before the loop waits for its payload. Every slice below is inside a length the loop has already
// checked, so it is a view, not a bounded read: nothing here can be short.
export type PktStepped = { frames: PktFrame[]; state: PktState };
// @decoder pktStepResult prefix=pkt
// oxlint-disable-next-line eslint/complexity -- one frame loop over an exhaustive switch
export function pktStepResult(st: PktState, chunk: Uint8Array): Result<PktStepped, Protocol> {
  const frames: PktFrame[] = [];
  const buf = st.carry ? concat([st.carry, chunk]) : chunk;
  let p = 0;
  let { data, flush, delim, end, maxPayload } = st;
  frame: while (buf.length - p >= PKT_LEN_HEX) {
    const h = pktHeader(buf.subarray(p, p + PKT_LEN_HEX));
    switch (h.tag) {
      case 'bad_hex': return proto(`bad pkt-line length at byte ${st.bytes - (buf.length - chunk.length) + p}`);
      case 'invalid': return proto(`invalid pkt-line length ${h.len}`);
      case 'too_long': return proto(`bad pkt-line length ${h.payload}`);
      case 'flush': flush++; frames.push({ kind: 'flush' }); p += PKT_LEN_HEX; break;
      case 'delim': delim++; frames.push({ kind: 'delim' }); p += PKT_LEN_HEX; break;
      case 'end': end++; frames.push({ kind: 'end' }); p += PKT_LEN_HEX; break;
      case 'data': {
        if (buf.length - p < h.len) break frame;
        const payload = buf.subarray(p + PKT_LEN_HEX, p + h.len);
        data++;
        // Stryker disable next-line EqualityOperator: a payload equal to the current maximum leaves the maximum unchanged
        if (payload.length > maxPayload) maxPayload = payload.length;
        frames.push({ kind: 'data', payload });
        p += h.len;
        break;
      }
      default: return assertNever(h);
    }
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
// @decoder pktStep prefix=pkt
export function pktStep(st: PktState, chunk: Uint8Array): PktStepped { return orThrow(pktStepResult(st, chunk)); }

// @decoder pktFinishResult prefix=pkt
export function pktFinishResult(st: PktState): Result<PktState, Protocol> {
  return st.carry && st.carry.length > 0 ? proto(`trailing ${st.carry.length} bytes after last pkt-line`) : ok(st);
}
// @decoder pktFinish prefix=pkt
export function pktFinish(st: PktState): PktState { return orThrow(pktFinishResult(st)); }

export const pktAttrs = (st: PktState, prefix = 'git.pkt'): Record<string, number> => ({
  [`${prefix}.frames`]: st.frames, [`${prefix}.data`]: st.data, [`${prefix}.flush`]: st.flush,
  [`${prefix}.delim`]: st.delim, [`${prefix}.end`]: st.end, [`${prefix}.bytes`]: st.bytes,
  [`${prefix}.payload.max`]: st.maxPayload, [`${prefix}.carry.max`]: st.carryMax,
});
