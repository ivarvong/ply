// v2 negotiation: send haves in rounds without `done` until the server says ready (or we run out), then done.
// Returns the final fetchPack result plus the rounds' acks. `external` supplies thin-pack bases.
import { fetchPack } from './fetchpack.js';

export async function negotiate(t, { wants, haves = [], batch = 16, maxRounds = 32, ...opts }, { external, resolve } = {}) {
  const acked = new Set();
  const rounds = [];
  let ready = false, i = 0;
  for (let round = 0; round < maxRounds && i < haves.length && !ready; round++) {
    const sent = haves.slice(i, i + batch); i += batch;
    const r = await fetchPack(t, { ...opts, wants, haves: [...acked, ...sent], done: false }, { external, resolve });
    for (const a of r.acks) acked.add(a);
    rounds.push({ sent: sent.length, acks: r.acks, nak: r.nak, ready: r.ready, pack: !!r.parsed });
    ready = r.ready;
    if (r.parsed) return { ...r, rounds, common: [...acked] }; // server went straight to packfile
  }
  const r = await fetchPack(t, { ...opts, wants, haves: [...acked], done: true }, { external, resolve });
  return { ...r, rounds, common: [...acked] };
}
