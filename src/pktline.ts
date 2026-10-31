// pkt-line framing. 4 hex length (inclusive) + payload. 0000 flush, 0001 delim, 0002 response-end.
// Decoder is a pure step function over an immutable state record.
import type { Thrown } from './errors.js';
import { thrown as fail } from './errors.js';
import { te, concat, encodeBytes } from './bytes.js';
import {
  PKT_LEN_HEX, PKT_HEX_BASE, PKT_FLUSH, PKT_DELIM, PKT_LEN_INVALID,
  PKT_DATA_MIN, PKT_MAX_PAYLOAD, PKT_READ_MAX_PAYLOAD, PKT_LEN_SHIFTS, BYTE_VALUES,
} from './format.js';

export const MAX_PKT_PAYLOAD: number = PKT_MAX_PAYLOAD;
const proto = (msg: string): Thrown => fail('protocol', msg);

// The one pkt-line writer. A line longer than git's LARGE_PACKET_MAX is the caller's (a push option, a ref prefix, a
// want or filter: fields without a length rule of their own), refused before any byte is written, as git's
// format_packet dies "impossibly long line" (pkt-line.c). bad_request: no retry can make the line shorter.
export function pkt(payload: string | Uint8Array): Uint8Array {
  // a ref name read from ls-refs may hold escaped bytes (#43): encodeBytes writes them back as the server sent them
  const p = typeof payload === 'string' ? encodeBytes(payload, 'pkt-line') : payload;
  if (p.length > MAX_PKT_PAYLOAD) throw fail('bad_request', `pkt-line payload too large: ${p.length} bytes, the most git frames is ${MAX_PKT_PAYLOAD}`, { what: 'pkt-line', got: p.length, max: MAX_PKT_PAYLOAD });
  const out = new Uint8Array(PKT_LEN_HEX + p.length);
  out.set(te.encode((p.length + PKT_LEN_HEX).toString(PKT_HEX_BASE).padStart(PKT_LEN_HEX, '0')));
  out.set(p, PKT_LEN_HEX);
  return out;
}
export const FLUSH: Uint8Array = te.encode('0000');
export const DELIM: Uint8Array = te.encode('0001');

export type PktsOptions = { readonly delimAfter?: number; readonly flush?: boolean };
export const pkts = (lines: ReadonlyArray<string | Uint8Array>, { delimAfter = -1, flush = true }: PktsOptions = {}): Uint8Array =>
  concat(lines.flatMap((l, i) => (i === delimAfter ? [pkt(l), DELIM] : [pkt(l)])).concat(flush ? [FLUSH] : []));

// oxlint-disable-next-line no-magic-numbers -- sentinel: this byte is not a hex digit
const NOT_HEX = -1;
const HEXV = new Int8Array(BYTE_VALUES).fill(NOT_HEX);
// PKT_LEN_SHIFTS has four entries (format.js); the defaults only satisfy the checker
const [SHIFT0 = 0, SHIFT1 = 0, SHIFT2 = 0] = PKT_LEN_SHIFTS;
// ASCII digits: a code unit is the code point
// oxlint-disable-next-line unicorn/prefer-code-point -- see above
for (let i = 0; i < PKT_HEX_BASE; i++) { HEXV['0123456789abcdef'.charCodeAt(i)] = i; HEXV['0123456789ABCDEF'.charCodeAt(i)] = i; }

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

// (state, chunk) -> { state, frames: [{kind, payload?}] }. Carry is bounded by one max pkt.
// The rules are git's reader, packet_read_with_status (pkt-line.c): a non-hex length byte (either case is hex) is "bad
// line length character"; 0000/0001/0002 are flush/delim/response-end; 0003 is "bad line length"; a payload of
// LARGE_PACKET_MAX bytes or more (the packet_buffer it reads into) is "bad line length" too, so the longest frame git
// reads is 65523 bytes, three past the 65520 its writer emits. Every slice below is inside a length the loop has
// already checked, so it is a view, not a bounded read: nothing here can be short.
// @decoder pktStep prefix=pkt
// oxlint-disable-next-line eslint/complexity -- one frame loop; the `??`s on in-range reads count as branches
export function pktStep(st: PktState, chunk: Uint8Array): { frames: PktFrame[]; state: PktState } {
  const frames: PktFrame[] = [];
  const buf = st.carry ? concat([st.carry, chunk]) : chunk;
  let p = 0;
  let { data, flush, delim, end, maxPayload } = st;
  while (buf.length - p >= PKT_LEN_HEX) {
    const h = buf.subarray(p, p + PKT_LEN_HEX);
    // h holds PKT_LEN_HEX bytes and HEXV covers every byte value: `?? -1` only satisfies the checker
    const a = HEXV[h[0] ?? 0] ?? NOT_HEX;
    const b = HEXV[h[1] ?? 0] ?? NOT_HEX;
    const c = HEXV[h[2] ?? 0] ?? NOT_HEX;
    const d = HEXV[h[3] ?? 0] ?? NOT_HEX;
    if ((a | b | c | d) < 0) throw proto(`bad pkt-line length at byte ${st.bytes - (buf.length - chunk.length) + p}`);
    const len = (a << SHIFT0) | (b << SHIFT1) | (c << SHIFT2) | d;
    if (len < PKT_DATA_MIN) {
      if (len === PKT_LEN_INVALID) throw proto('invalid pkt-line length 3');
      // 0, 1 and 2 are the only remaining lengths below PKT_DATA_MIN.
      let kind: 'flush' | 'delim' | 'end' = 'end';
      if (len === PKT_FLUSH) kind = 'flush';
      else if (len === PKT_DELIM) kind = 'delim';
      if (kind === 'flush') flush++; else if (kind === 'delim') delim++; else end++;
      frames.push({ kind });
      p += PKT_LEN_HEX;
      continue;
    }
    // git's reader refuses a payload that does not fit its LARGE_PACKET_MAX buffer before reading it (pkt-line.c)
    if (len - PKT_LEN_HEX > PKT_READ_MAX_PAYLOAD) throw proto(`bad pkt-line length ${len - PKT_LEN_HEX}`);
    if (buf.length - p < len) break;
    const payload = buf.subarray(p + PKT_LEN_HEX, p + len);
    data++;
    // Stryker disable next-line EqualityOperator: a payload equal to the current maximum leaves the maximum unchanged
    if (payload.length > maxPayload) maxPayload = payload.length;
    frames.push({ kind: 'data', payload });
    p += len;
  }
  const carry = p < buf.length ? buf.slice(p) : null;
  return {
    frames,
    state: Object.freeze({
      carry, data, flush, delim, end, maxPayload,
      frames: st.frames + frames.length,
      bytes: st.bytes + chunk.length,
      carryMax: Math.max(st.carryMax, carry ? carry.length : 0),
    }),
  };
}

// @decoder pktFinish prefix=pkt
export function pktFinish(st: PktState): PktState {
  if (st.carry && st.carry.length > 0) throw proto(`trailing ${st.carry.length} bytes after last pkt-line`);
  return st;
}

export const pktAttrs = (st: PktState, prefix = 'git.pkt'): Record<string, number> => ({
  [`${prefix}.frames`]: st.frames, [`${prefix}.data`]: st.data, [`${prefix}.flush`]: st.flush,
  [`${prefix}.delim`]: st.delim, [`${prefix}.end`]: st.end, [`${prefix}.bytes`]: st.bytes,
  [`${prefix}.payload.max`]: st.maxPayload, [`${prefix}.carry.max`]: st.carryMax,
});
