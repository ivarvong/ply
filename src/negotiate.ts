// v2 negotiation: send haves in rounds without `done` until the server says ready (or we run out), then done.
// Returns the final fetchPack result plus the rounds' acks. `external` supplies thin-pack bases.
import type { Transport } from './transport.js';
import type { FetchOpts } from './fetch.js';
import type { FetchPackExtra, FetchPackResult } from './fetchpack.js';
import type { ErrorOf, PlyError } from './errors.js';
import type { Input } from './absent.js';
import type { Result } from './result.js';
import { fail } from './errors.js';
import { checkLimit } from './limits.js';
import { fetchPack } from './fetchpack.js';
import { fetchRequest } from './fetch.js';
import { parseOid } from './oid.js';
import type { Oid } from './oid.js';
import { getOrElse, ok } from './result.js';
import { fromNullable, withDefaults } from './absent.js';

const NEGOTIATE_BATCH = 16;
const NEGOTIATE_ROUNDS = 32;
// characters of a bad acknowledgment quoted in the refusal
const ACK_SHOWN = 60;

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

export async function negotiate(t: Transport, opts: NegotiateOpts, extra: Pick<FetchPackExtra, 'external' | 'resolve'> = {}): Promise<Result<NegotiateResult, PlyError>> {
  const { wants, haves: givenHaves, batch: _batch, maxRounds: _maxRounds, ...rest } = opts;
  const { batch, maxRounds } = withDefaults(opts, { batch: NEGOTIATE_BATCH, maxRounds: NEGOTIATE_ROUNDS });
  const { external, resolve } = extra;
  const checked = negotiateCaps(maxRounds, batch);
  if (!checked.ok) return checked;
  const caps = checked.value;
  // The whole command parsed once, every have with it (#156): a bad one is refused before the first round, not in the
  // round that would have sent it. The rounds send the parsed ids.
  const parsed = fetchRequest({ ...rest, wants, haves: getOrElse(fromNullable(givenHaves), []), done: false });
  if (!parsed.ok) return parsed;
  const { haves } = parsed.value;
  // what the server acknowledged: each an id, offered again as a have in every later round
  const acked = new Set<Oid>();
  const rounds: Round[] = [];
  let i = 0, ready = false;
  for (let round = 0; round < caps.rounds && i < haves.length && !ready; round++) {
    const sent = haves.slice(i, i + caps.batch); i += caps.batch;
    // oxlint-disable-next-line no-await-in-loop -- each round's haves depend on the last round's acks
    const fetched = await fetchPack(t, { ...rest, wants, haves: [...acked, ...sent], done: false }, { external, resolve });
    if (!fetched.ok) return fetched;
    const r = fetched.value;
    for (const a of r.acks) {
      const id = parseOid(a);
      if (!id.ok) return fail('protocol', `negotiate: the server acknowledged ${JSON.stringify(a.slice(0, ACK_SHOWN))}, not an object id`);
      acked.add(id.value);
    }
    rounds.push({ sent: sent.length, acks: r.acks, nak: r.nak, ready: r.ready, pack: Boolean(r.parsed) });
    ready = r.ready;
    if (r.parsed) return ok({ ...r, rounds, common: [...acked] }); // server went straight to packfile
  }
  const r = await fetchPack(t, { ...rest, wants, haves: [...acked], done: true }, { external, resolve });
  return r.ok ? ok({ ...r.value, rounds, common: [...acked] }) : r;
}
