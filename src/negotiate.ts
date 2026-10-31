// v2 negotiation: send haves in rounds without `done` until the server says ready (or we run out), then done.
// Returns the final fetchPack result plus the rounds' acks. `external` supplies thin-pack bases.
import type { Transport } from './transport.js';
import type { FetchOpts } from './fetch.js';
import type { FetchPackExtra, FetchPackResult } from './fetchpack.js';
import { thrown as fail } from './errors.js';
import { finiteLimit } from './limits.js';
import { fetchPack } from './fetchpack.js';

const NEGOTIATE_BATCH = 16;
const NEGOTIATE_ROUNDS = 32;

// The fetch arguments, plus the haves to offer in rounds of `batch` (at most `maxRounds` rounds).
export type NegotiateOpts = Omit<FetchOpts, 'done'> & { readonly batch?: number; readonly maxRounds?: number };
export type Round = { readonly sent: number; readonly acks: readonly string[]; readonly nak: boolean; readonly ready: boolean; readonly pack: boolean };
export type NegotiateResult = FetchPackResult & { readonly rounds: Round[]; readonly common: string[] };

export async function negotiate(t: Transport, { wants, haves = [], batch = NEGOTIATE_BATCH, maxRounds = NEGOTIATE_ROUNDS, ...opts }: NegotiateOpts, { external, resolve }: Pick<FetchPackExtra, 'external' | 'resolve'> = {}): Promise<NegotiateResult> {
  const roundsCap = finiteLimit(maxRounds, 'maxNegotiateRounds');
  const batchCap = finiteLimit(batch, 'negotiateBatch');
  if (!Number.isInteger(roundsCap)) throw fail('bad_request', 'negotiate rounds must be an integer', { what: 'maxNegotiateRounds' });
  if (!Number.isInteger(batchCap) || batchCap < 1) throw fail('bad_request', 'negotiate batch must be a positive integer', { what: 'negotiateBatch' });
  const acked = new Set<string>();
  const rounds: Round[] = [];
  let i = 0, ready = false;
  for (let round = 0; round < roundsCap && i < haves.length && !ready; round++) {
    const sent = haves.slice(i, i + batchCap); i += batchCap;
    // oxlint-disable-next-line no-await-in-loop -- each round's haves depend on the last round's acks
    const r = await fetchPack(t, { ...opts, wants, haves: [...acked, ...sent], done: false }, { external, resolve });
    for (const a of r.acks) acked.add(a);
    rounds.push({ sent: sent.length, acks: r.acks, nak: r.nak, ready: r.ready, pack: Boolean(r.parsed) });
    ready = r.ready;
    if (r.parsed) return { ...r, rounds, common: [...acked] }; // server went straight to packfile
  }
  const r = await fetchPack(t, { ...opts, wants, haves: [...acked], done: true }, { external, resolve });
  return { ...r, rounds, common: [...acked] };
}
