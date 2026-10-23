// pkt-line framing. 4 hex length (inclusive) + payload. 0000 flush, 0001 delim, 0002 response-end.
// Decoder is a pure step function over an immutable state record.
import { fail } from './errors.js';
import { te, concat } from './bytes.js';

export const MAX_PKT_PAYLOAD = 65516;
const proto = msg => fail('protocol', msg);

export function pkt(payload) {
  const p = typeof payload === 'string' ? te.encode(payload) : payload;
  if (p.length > MAX_PKT_PAYLOAD) throw new Error(`pkt-line payload too large: ${p.length}`);
  const out = new Uint8Array(4 + p.length);
  out.set(te.encode((p.length + 4).toString(16).padStart(4, '0')));
  out.set(p, 4);
  return out;
}
export const FLUSH = te.encode('0000');
export const DELIM = te.encode('0001');

export const pkts = (lines, { delimAfter = -1, flush = true } = {}) =>
  concat(lines.flatMap((l, i) => (i === delimAfter ? [pkt(l), DELIM] : [pkt(l)])).concat(flush ? [FLUSH] : []));

const HEXV = new Int8Array(256).fill(-1);
for (let i = 0; i < 16; i++) { HEXV['0123456789abcdef'.charCodeAt(i)] = i; HEXV['0123456789ABCDEF'.charCodeAt(i)] = i; }

export const pktInit = () => Object.freeze({
  carry: null, frames: 0, data: 0, flush: 0, delim: 0, end: 0, bytes: 0, maxPayload: 0, carryMax: 0,
});

// (state, chunk) -> { state, frames: [{kind, payload?}] }. Carry is bounded by one max pkt.
export function pktStep(st, chunk) {
  const frames = [];
  const buf = st.carry ? concat([st.carry, chunk]) : chunk;
  let p = 0, data = st.data, flush = st.flush, delim = st.delim, end = st.end, maxPayload = st.maxPayload;
  while (buf.length - p >= 4) {
    const a = HEXV[buf[p]], b = HEXV[buf[p + 1]], c = HEXV[buf[p + 2]], d = HEXV[buf[p + 3]];
    if ((a | b | c | d) < 0) throw proto(`bad pkt-line length at byte ${st.bytes - (buf.length - chunk.length) + p}`);
    const len = (a << 12) | (b << 8) | (c << 4) | d;
    if (len < 4) {
      if (len === 3) throw proto('invalid pkt-line length 3');
      const kind = len === 0 ? 'flush' : len === 1 ? 'delim' : 'end';
      if (kind === 'flush') flush++; else if (kind === 'delim') delim++; else end++;
      frames.push({ kind });
      p += 4;
      continue;
    }
    if (buf.length - p < len) break;
    const payload = buf.subarray(p + 4, p + len);
    data++;
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

export function pktFinish(st) {
  if (st.carry && st.carry.length) throw proto(`trailing ${st.carry.length} bytes after last pkt-line`);
  return st;
}

export const pktAttrs = (st, prefix = 'git.pkt') => ({
  [`${prefix}.frames`]: st.frames, [`${prefix}.data`]: st.data, [`${prefix}.flush`]: st.flush,
  [`${prefix}.delim`]: st.delim, [`${prefix}.end`]: st.end, [`${prefix}.bytes`]: st.bytes,
  [`${prefix}.payload.max`]: st.maxPayload, [`${prefix}.carry.max`]: st.carryMax,
});
