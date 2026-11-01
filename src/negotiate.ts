// v2 negotiation: send haves in rounds without `done` until the server says ready (or we run out), then done.
// Returns the final fetchPack result plus the rounds' acks. `external` supplies thin-pack bases.
import type { Transport } from './transport.js';
import type { FetchOpts } from './fetch.js';
import type { FetchPackExtra, FetchPackResult } from './fetchpack.js';
import type { ErrorOf } from './errors.js';
import type { Input } from './absent.js';
import type { Result } from './result.js';
import { fail, orThrow } from './errors.js';
import { checkLimit } from './limits.js';
import { fetchPack } from './fetchpack.js';
import { getOrElse, ok } from './result.js';
import { fromNullable, withDefaults } from './absent.js';

const NEGOTIATE_BATCH = 16;
const NEGOTIATE_ROUNDS = 32;

// The fetch arguments, plus the haves to offer in rounds of `batch` (at most `maxRounds` rounds).
export type NegotiateConfig = { readonly batch: number; readonly maxRounds: number };
export type NegotiateOpts = Omit<FetchOpts, 'done'> & Input<NegotiateConfig>;
export type Round = { readonly sent: number; readonly acks: readonly string[]; readonly nak: boolean; readonly ready: boolean; readonly pack: boolean };
export type NegotiateResult = FetchPackResult & { readonly rounds: Round[]; readonly common: string[] };

// The round count and batch size, checked before any request: finite non-negative numbers, the batch at least one.
type Caps = { readonly rounds: number; readonly batch: number };
function negotiateCaps(maxRounds: unknown, batch: unknown): Result<Caps, ErrorOf<'bad_request'>> {
  const rounds = checkLimit(maxRounds, 'maxNegotiateRounds');
  if (!rounds.ok) return rounds;
  const size = checkLimit(batch, 'negotiateBatch');
  if (!size.ok) return size;
  if (!Number.isInteger(rounds.value)) return fail('bad_request', 'negotiate rounds must be an integer', { what: 'maxNegotiateRounds' });
  if (!Number.isInteger(size.value) || size.value < 1) return fail('bad_request', 'negotiate batch must be a positive integer', { what: 'negotiateBatch' });
  return ok({ rounds: rounds.value, batch: size.value });
}

export async function negotiate(t: Transport, opts: NegotiateOpts, extra: Pick<FetchPackExtra, 'external' | 'resolve'> = {}): Promise<NegotiateResult> {
  const { wants, haves: givenHaves, batch: _batch, maxRounds: _maxRounds, ...rest } = opts;
  const { batch, maxRounds } = withDefaults(opts, { batch: NEGOTIATE_BATCH, maxRounds: NEGOTIATE_ROUNDS });
  const haves = getOrElse(fromNullable(givenHaves), []);
  const { external, resolve } = extra;
  const caps = orThrow(negotiateCaps(maxRounds, batch));
  const acked = new Set<string>();
  const rounds: Round[] = [];
  let i = 0, ready = false;
  for (let round = 0; round < caps.rounds && i < haves.length && !ready; round++) {
    const sent = haves.slice(i, i + caps.batch); i += caps.batch;
    // oxlint-disable-next-line no-await-in-loop -- each round's haves depend on the last round's acks
    const r = await fetchPack(t, { ...rest, wants, haves: [...acked, ...sent], done: false }, { external, resolve });
    for (const a of r.acks) acked.add(a);
    rounds.push({ sent: sent.length, acks: r.acks, nak: r.nak, ready: r.ready, pack: Boolean(r.parsed) });
    ready = r.ready;
    if (r.parsed) return { ...r, rounds, common: [...acked] }; // server went straight to packfile
  }
  const r = await fetchPack(t, { ...rest, wants, haves: [...acked], done: true }, { external, resolve });
  return { ...r, rounds, common: [...acked] };
}
