// v2 negotiation: send haves in rounds without `done` until the server says ready (or we run out), then done.
// Returns the final fetchPack result plus the rounds' acks. `external` supplies thin-pack bases.
import { fail } from './errors.js';
import { finiteLimit } from './limits.js';
import { fetchPack } from './fetchpack.js';

const NEGOTIATE_BATCH = 16;
const NEGOTIATE_ROUNDS = 32;

export async function negotiate(t, { wants, haves = [], batch = NEGOTIATE_BATCH, maxRounds = NEGOTIATE_ROUNDS, ...opts }, { external, resolve } = {}) {
  const roundsCap = finiteLimit(maxRounds, 'maxNegotiateRounds');
  const batchCap = finiteLimit(batch, 'negotiateBatch');
  if (!Number.isInteger(roundsCap)) throw fail('bad_request', 'negotiate rounds must be an integer', { what: 'maxNegotiateRounds' });
  if (!Number.isInteger(batchCap) || batchCap < 1) throw fail('bad_request', 'negotiate batch must be a positive integer', { what: 'negotiateBatch' });
  const acked = new Set();
  const rounds = [];
  let ready = false, i = 0;
  for (let round = 0; round < roundsCap && i < haves.length && !ready; round++) {
    const sent = haves.slice(i, i + batchCap); i += batchCap;
    const r = await fetchPack(t, { ...opts, wants, haves: [...acked, ...sent], done: false }, { external, resolve });
    for (const a of r.acks) acked.add(a);
    rounds.push({ sent: sent.length, acks: r.acks, nak: r.nak, ready: r.ready, pack: !!r.parsed });
    ready = r.ready;
    if (r.parsed) return { ...r, rounds, common: [...acked] }; // server went straight to packfile
  }
  const r = await fetchPack(t, { ...opts, wants, haves: [...acked], done: true }, { external, resolve });
  return { ...r, rounds, common: [...acked] };
}
