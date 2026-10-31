// pkt-line framing. 4 hex length (inclusive) + payload. 0000 flush, 0001 delim, 0002 response-end.
// Decoder is a pure step function over an immutable state record.
import { fail } from './errors.js';
import { te, concat, take, encodeBytes } from './bytes.js';
import {
  PKT_LEN_HEX, PKT_HEX_BASE, PKT_FLUSH, PKT_DELIM, PKT_LEN_INVALID,
  PKT_DATA_MIN, PKT_MAX_PAYLOAD, PKT_LEN_SHIFTS, BYTE_VALUES,
} from './format.js';

export const MAX_PKT_PAYLOAD = PKT_MAX_PAYLOAD;
const proto = msg => fail('protocol', msg);

export function pkt(payload) {
  // a ref name read from ls-refs may hold escaped bytes (#43): encodeBytes writes them back as the server sent them
  const p = typeof payload === 'string' ? encodeBytes(payload, 'pkt-line') : payload;
  if (p.length > MAX_PKT_PAYLOAD) throw new Error(`pkt-line payload too large: ${p.length}`);
  const out = new Uint8Array(PKT_LEN_HEX + p.length);
  out.set(te.encode((p.length + PKT_LEN_HEX).toString(PKT_HEX_BASE).padStart(PKT_LEN_HEX, '0')));
  out.set(p, PKT_LEN_HEX);
  return out;
}
export const FLUSH = te.encode('0000');
export const DELIM = te.encode('0001');

export const pkts = (lines, { delimAfter = -1, flush = true } = {}) =>
  concat(lines.flatMap((l, i) => (i === delimAfter ? [pkt(l), DELIM] : [pkt(l)])).concat(flush ? [FLUSH] : []));

// oxlint-disable-next-line no-magic-numbers -- sentinel: this byte is not a hex digit
const HEXV = new Int8Array(BYTE_VALUES).fill(-1);
for (let i = 0; i < PKT_HEX_BASE; i++) { HEXV['0123456789abcdef'.charCodeAt(i)] = i; HEXV['0123456789ABCDEF'.charCodeAt(i)] = i; }

export const pktInit = () => Object.freeze({
  carry: null, frames: 0, data: 0, flush: 0, delim: 0, end: 0, bytes: 0, maxPayload: 0, carryMax: 0,
});

// (state, chunk) -> { state, frames: [{kind, payload?}] }. Carry is bounded by one max pkt.
// @decoder pktStep prefix=pkt
export function pktStep(st, chunk) {
  const frames = [];
  const buf = st.carry ? concat([st.carry, chunk]) : chunk;
  let p = 0, data = st.data, flush = st.flush, delim = st.delim, end = st.end, maxPayload = st.maxPayload;
  while (buf.length - p >= PKT_LEN_HEX) {
    // Stryker disable next-line StringLiteral: the loop already proved PKT_LEN_HEX bytes remain, so take() cannot throw
    const hex = take(buf, p, PKT_LEN_HEX, 'protocol');
    const a = HEXV[hex[0]], b = HEXV[hex[1]], c = HEXV[hex[2]], d = HEXV[hex[3]];
    if ((a | b | c | d) < 0) throw proto(`bad pkt-line length at byte ${st.bytes - (buf.length - chunk.length) + p}`);
    const len = (a << PKT_LEN_SHIFTS[0]) | (b << PKT_LEN_SHIFTS[1]) | (c << PKT_LEN_SHIFTS[2]) | d;
    if (len < PKT_DATA_MIN) {
      if (len === PKT_LEN_INVALID) throw proto('invalid pkt-line length 3');
      // 0, 1 and 2 are the only remaining lengths below PKT_DATA_MIN.
      const kind = len === PKT_FLUSH ? 'flush' : len === PKT_DELIM ? 'delim' : 'end';
      if (kind === 'flush') flush++; else if (kind === 'delim') delim++; else end++;
      frames.push({ kind });
      p += PKT_LEN_HEX;
      continue;
    }
    if (buf.length - p < len) break;
    // Stryker disable next-line StringLiteral: the length check already proved the payload bytes remain, so take() cannot throw
    const payload = take(buf, p + PKT_LEN_HEX, len - PKT_LEN_HEX, 'protocol');
    data++;
    // Stryker disable next-line EqualityOperator: a payload equal to the current maximum leaves the maximum unchanged
    if (payload.length > maxPayload) maxPayload = payload.length;
    frames.push({ kind: 'data', payload });
    p += len;
  }
  // Stryker disable next-line StringLiteral: p < buf.length means the remainder is in range, so take() cannot throw
  const carry = p < buf.length ? take(buf, p, buf.length - p, 'protocol').slice() : null;
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
export function pktFinish(st) {
  if (st.carry && st.carry.length) throw proto(`trailing ${st.carry.length} bytes after last pkt-line`);
  return st;
}

export const pktAttrs = (st, prefix = 'git.pkt') => ({
  [`${prefix}.frames`]: st.frames, [`${prefix}.data`]: st.data, [`${prefix}.flush`]: st.flush,
  [`${prefix}.delim`]: st.delim, [`${prefix}.end`]: st.end, [`${prefix}.bytes`]: st.bytes,
  [`${prefix}.payload.max`]: st.maxPayload, [`${prefix}.carry.max`]: st.carryMax,
});
