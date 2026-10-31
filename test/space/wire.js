// Shared wire helpers for the framing and pack spaces: a real http transport (src/http.js createTransport) over a fake
// fetch that answers with exactly the bytes a cell renders, so every cell goes through ply's own pkt-line reader
// (pktStep/pktFinish in the transport), its own consumers and its own error typing. No network, no server process.
import { createTransport } from '../../src/http.js';
import { Tracer } from '../../src/otel.js';
import { withLimits } from '../../src/limits.js';
import { isPlyCode } from '../../src/errors.js';

const te = new TextEncoder();
export const enc = s => (typeof s === 'string' ? te.encode(s) : s);
export const cat = parts => { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
// A pkt-line exactly as git's writer frames it (4 lower-case hex digits, inclusive length). No bound: cells build
// over-long frames on purpose.
export const frame = payload => { const p = enc(payload); return cat([te.encode((p.length + 4).toString(16).padStart(4, '0')), p]); };
export const FLUSH = te.encode('0000'), DELIM = te.encode('0001'), END = te.encode('0002');
export const band = (b, body) => frame(cat([Uint8Array.of(b), enc(body)]));

// responder(kind, service, body) -> { status?, contentType?, bytes } | undefined (404)
export function fakeFetch(responder) {
  return async (url, init = {}) => {
    const u = new URL(url);
    const adv = u.pathname.endsWith('/info/refs');
    const service = adv ? u.searchParams.get('service') : u.pathname.split('/').pop();
    const r = await responder(adv ? 'advertise' : 'post', service, init.body ?? null);
    if (!r) return new Response('not found', { status: 404 });
    const ct = r.contentType ?? `application/x-${service}-${adv ? 'advertisement' : 'result'}`;
    return new Response(r.bytes, { status: r.status ?? 200, headers: { 'content-type': ct } });
  };
}

export function transport(responder, limits = {}, extra = {}) {
  return createTransport('https://git.example/repo.git', { tracer: new Tracer(), fetchImpl: fakeFetch(responder), limits: withLimits(limits), ...extra });
}

// The outcome of an operation as a tagged union. `typed` holds only an error ply built with fail() (a code from its
// table, the plain Error class): a TypeError or RangeError that `coded()` stamped with a code is `untyped`, a bug.
export async function outcome(fn) {
  try { return { tag: 'ok', value: await fn() }; } catch (e) {
    if (!(e instanceof Error) || e.constructor !== Error || !isPlyCode(e.code)) return { tag: 'untyped', code: e?.code, name: e?.constructor?.name, message: String(e?.message ?? e) };
    return { tag: 'typed', code: e.code, message: e.message };
  }
}
export function outcomeSync(fn) {
  try { return { tag: 'ok', value: fn() }; } catch (e) {
    if (!(e instanceof Error) || e.constructor !== Error || !isPlyCode(e.code)) return { tag: 'untyped', code: e?.code, name: e?.constructor?.name, message: String(e?.message ?? e) };
    return { tag: 'typed', code: e.code, message: e.message };
  }
}

// A v2 fetch response: the given section lines, then `packfile` with the pack in band-1 frames of `chunk` bytes, a flush.
export function v2PackResponse(pack, { chunk = 8192, before = [] } = {}) {
  const frames = [...before.map(l => frame(l)), frame('packfile\n')];
  for (let i = 0; i < pack.length; i += chunk) frames.push(band(1, pack.subarray(i, i + chunk)));
  if (pack.length === 0) frames.push(band(1, new Uint8Array(0)));
  frames.push(FLUSH);
  return cat(frames);
}
