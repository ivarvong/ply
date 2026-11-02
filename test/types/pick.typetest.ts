// empty: 'keep' cannot come back as outcome 'empty', and the default cannot come back as 'kept_empty'.
import type { PlyError } from '../../src/errors.js';
import type { Result } from '../../src/result.js';
import { cherryPick, revertCommit, pickCommit, type PickEmpty, type PickKept, type PickOk, type PickOutcome } from '../../src/rebase.js';

const url = 'https://example.test/r.git';
const commit = 'a'.repeat(40);
const committer = { name: 'Cid', email: 'cid@x' };

const kept: Promise<Result<PickKept | PickOk, PlyError>> = cherryPick(url, { commit, committer, empty: 'keep' });
const stopped: Promise<Result<PickEmpty | PickOk, PlyError>> = revertCommit(url, { commit, committer, empty: 'stop' });
const omitted: Promise<Result<PickEmpty | PickOk, PlyError>> = pickCommit(url, { commit, committer });
const wide: Promise<Result<PickOutcome, PlyError>> = pickCommit(url, { commit, committer, empty: 'stop' as 'stop' | 'keep' });
void kept; void stopped; void omitted; void wide;

type OutcomeOf<T> = T extends Promise<Result<infer R, PlyError>> ? R extends { readonly outcome: infer O } ? O : never : never;
const _keptOnly: OutcomeOf<typeof kept> = 'kept_empty';
const _stopOnly: OutcomeOf<typeof stopped> = 'empty';
void _keptOnly; void _stopOnly;

// @ts-expect-error -- 'keep' cannot come back as outcome 'empty'
const noEmptyOnKeep: OutcomeOf<typeof kept> = 'empty';
void noEmptyOnKeep;
// @ts-expect-error -- the default policy cannot come back as 'kept_empty'
const noKeepOnStop: OutcomeOf<typeof omitted> = 'kept_empty';
void noKeepOnStop;
