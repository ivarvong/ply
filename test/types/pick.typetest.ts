// empty: 'keep' cannot come back as outcome 'empty', and the default cannot come back as 'kept_empty'.
import { cherryPick, revertCommit, pickCommit, type PickEmpty, type PickKept, type PickOk, type PickOutcome } from '../../src/rebase.js';

const url = 'https://example.test/r.git';
const commit = 'a'.repeat(40);
const committer = { name: 'Cid', email: 'cid@x' };

const kept: Promise<PickKept | PickOk> = cherryPick(url, { commit, committer, empty: 'keep' });
const stopped: Promise<PickEmpty | PickOk> = revertCommit(url, { commit, committer, empty: 'stop' });
const omitted: Promise<PickEmpty | PickOk> = pickCommit(url, { commit, committer });
const wide: Promise<PickOutcome> = pickCommit(url, { commit, committer, empty: 'stop' as 'stop' | 'keep' });
void kept; void stopped; void omitted; void wide;

type OutcomeOf<T> = T extends Promise<infer R> ? R extends { readonly outcome: infer O } ? O : never : never;
const _keptOnly: OutcomeOf<typeof kept> = 'kept_empty';
const _stopOnly: OutcomeOf<typeof stopped> = 'empty';
void _keptOnly; void _stopOnly;

// @ts-expect-error -- 'keep' cannot come back as outcome 'empty'
const noEmptyOnKeep: OutcomeOf<typeof kept> = 'empty';
void noEmptyOnKeep;
// @ts-expect-error -- the default policy cannot come back as 'kept_empty'
const noKeepOnStop: OutcomeOf<typeof omitted> = 'kept_empty';
void noKeepOnStop;
