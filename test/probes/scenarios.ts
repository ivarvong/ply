// The differential probe scenarios, keyed by matrix behaviour (`<behaviour>#<variant>`), in priority order: the hard
// state transitions first (stale old ids, lost answers, contention, atomicity, refs moved under a push, size caps,
// non-fast-forward), then the plain transitions the hard ones are read against. Each is a pure plan; the runner
// (test/probes/runner.mjs) seeds a fresh repository per target, runs the steps, and stock git judges the result.
import type { CommitSpec, Expectation, Fault, FileSpec, FinalRef, Move, NonEmpty, ObjectSpec, OidExpr, Outcome, Push, RefAt, Scenario, StepExpect, TagSpec, Update } from './types.js';

const text = (path: string, s: string): FileSpec => ({ path, content: { tag: 'text', text: s } });
const noise = (path: string, seed: string, bytes: number): FileSpec => ({ path, content: { tag: 'noise', seed, bytes } });
const commit = (name: string, parents: readonly string[], files: readonly FileSpec[]): CommitSpec => ({ tag: 'commit', name, parents, files, message: name });
const tag = (name: string, target: string, tagName: string): TagSpec => ({ tag: 'annotated-tag', name, target, tagName, message: `tag ${tagName}` });
const ZERO: OidExpr = { tag: 'zero' };
const o = (name: string): OidExpr => ({ tag: 'obj', name });
const at = (ref: string, name: string): RefAt => ({ ref, at: name });
const upd = (ref: string, old: OidExpr, next: OidExpr): Update => ({ ref, old, new: next });
const move = (ref: string, to: OidExpr): Move => ({ ref, to });
const one = (outcome: Outcome, error: string | null): StepExpect => ({ outcome, error });
const both = (e: StepExpect): Expectation => ({ tag: 'one', ply: e, git: e });
const LANDED: Expectation = both(one('landed', null));
const finalAt = (ref: string, name: string): FinalRef => ({ tag: 'at', ref, at: name });
const absent = (ref: string): FinalRef => ({ tag: 'absent', ref });
const pushOf = (updates: NonEmpty<Update>, atomic = false): Push => ({ updates, atomic });
const MAIN = 'refs/heads/main';
const SIDE = 'refs/heads/side';

// base -- ff         (f.txt changed)
//      \- diverged   (g.txt added)
const CORE: readonly ObjectSpec[] = [
  commit('base', [], [text('f.txt', 'base\n'), text('dir/n.txt', 'nested\n')]),
  commit('ff', ['base'], [text('f.txt', 'ff\n')]),
  commit('diverged', ['base'], [text('g.txt', 'diverged\n')]),
];
const EXACT = { tag: 'exact' } as const;
const PLAIN = { referenceConfig: [], compare: EXACT } as const;
const SAME = { tag: 'same' } as const;
const NO_FAULT = { tag: 'none' } as const;
const step = (push: Push, fault: Fault = NO_FAULT) => ({ tag: 'push', push, fault, git: SAME }) as const;
const nonEmpty = <T>(xs: readonly T[]): NonEmpty<T> => {
  const [first, ...rest] = xs;
  if (first === undefined) throw new Error('nonEmpty: empty list');
  return [first, ...rest];
};

const CONTENDERS = 8;
const contenders = Array.from({ length: CONTENDERS }, (_, i) => commit(`c${i}`, ['base'], [text(`c${i}.txt`, `contender ${i}\n`)]));
const contenderNames = nonEmpty(contenders.map(c => c.name));

// 66 MiB of incompressible content in three 22 MiB blobs: over a 64 MiB pack cap, each blob under a 32 MiB object cap.
const MIB = 1024 * 1024;
const BIG = commit('big', ['base'], [noise('big/a.bin', 'a', 22 * MIB), noise('big/b.bin', 'b', 22 * MIB), noise('big/c.bin', 'c', 22 * MIB)]);
const MANY = 50;

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'concurrency.stale-old-oid#race',
    description: 'Both clients read main at base; another writer moves main to diverged while the receive-pack request is held; the push base->ff must be refused and main stay at diverged.',
    seed: { objects: CORE, refs: [at(MAIN, 'base')] },
    steps: [step(pushOf([upd(MAIN, o('base'), o('ff'))]), { tag: 'race', moves: [move(MAIN, o('diverged'))] })],
    expect: [both(one('conflict', 'cas_conflict'))],
    final: [finalAt(MAIN, 'diverged')],
    ...PLAIN,
  },
  {
    id: 'concurrency.stale-old-oid#direct',
    description: 'ply sends a push whose old id (base) is already stale (main is at diverged): the server refuses it, main unchanged.',
    seed: { objects: CORE, refs: [at(MAIN, 'diverged')] },
    steps: [{ tag: 'push', push: pushOf([upd(MAIN, o('base'), o('ff'))]), fault: NO_FAULT, git: { tag: 'none', why: 'stock git checks --force-with-lease against its own advertisement and refuses client side ("stale info"); the race variant is its server-side form' } }],
    expect: [{ tag: 'one', ply: one('conflict', 'cas_conflict'), git: null }],
    final: [finalAt(MAIN, 'diverged')],
    ...PLAIN,
  },
  {
    id: 'interrupted.push-response-lost#cut',
    // stock git (libcurl) re-sends a request whose reused connection closed with no answer, so git's push is sent twice:
    // the replay meets the server's compare-and-swap (main is already ff) and is refused, and git's own retry finds
    // main up to date. ply sends once and says ambiguous. Both must leave main at ff with nothing applied twice.
    description: 'The server applies base->ff but its answer is cut: ply must report ambiguous, refs show the push landed, a naive retry is refused; stock git\'s transparent re-send must be refused by compare-and-swap.',
    seed: { objects: CORE, refs: [at(MAIN, 'base')] },
    steps: [step(pushOf([upd(MAIN, o('base'), o('ff'))]), { tag: 'cut-response' }), step(pushOf([upd(MAIN, o('base'), o('ff'))]))],
    expect: [{ tag: 'one', ply: one('ambiguous', 'ambiguous'), git: one('conflict', 'cas_conflict') }, { tag: 'one', ply: one('conflict', 'cas_conflict'), git: one('landed', null) }],
    final: [finalAt(MAIN, 'ff')],
    ...PLAIN,
  },
  {
    id: 'concurrency.empty-report-under-contention#distinct-refs',
    description: `${CONTENDERS} pushes at once to one repository, each creating its own branch: every one lands, or is reported ambiguous (never landed when it did not).`,
    seed: { objects: [...CORE, ...contenders], refs: [at(MAIN, 'base')] },
    steps: [{ tag: 'concurrent', pushes: nonEmpty(contenders.map(c => pushOf([upd(`refs/heads/p-${c.name}`, ZERO, o(c.name))]))), git: SAME }],
    expect: [{ tag: 'many', ply: contenders.map(() => 'landed' as const), git: contenders.map(() => 'landed' as const) }],
    final: contenders.map(c => finalAt(`refs/heads/p-${c.name}`, c.name)),
    ...PLAIN,
  },
  {
    id: 'concurrency.empty-report-under-contention#same-ref',
    description: `${CONTENDERS} pushes at once moving main from base to ${CONTENDERS} different commits: exactly one lands, the rest are refused as conflicts.`,
    seed: { objects: [...CORE, ...contenders], refs: [at(MAIN, 'base')] },
    steps: [{ tag: 'concurrent', pushes: nonEmpty(contenders.map(c => pushOf([upd(MAIN, o('base'), o(c.name))]))), git: SAME }],
    expect: [{ tag: 'many', ply: ['landed', ...contenders.slice(1).map(() => 'conflict' as const)], git: ['landed', ...contenders.slice(1).map(() => 'conflict' as const)] }],
    final: [{ tag: 'one-of', ref: MAIN, names: contenderNames }],
    referenceConfig: [],
    compare: { tag: 'winner-of', why: 'the winner of a same-ref race is not fixed; objects, trees and ancestry follow it' },
  },
  {
    id: 'push.atomic#all-land',
    description: 'An atomic push moving main and side base->ff: both land.',
    seed: { objects: CORE, refs: [at(MAIN, 'base'), at(SIDE, 'base')] },
    steps: [step(pushOf([upd(MAIN, o('base'), o('ff')), upd(SIDE, o('base'), o('ff'))], true))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'ff'), finalAt(SIDE, 'ff')],
    ...PLAIN,
  },
  {
    id: 'push.atomic#one-stale',
    description: 'An atomic push of main and side base->ff while another writer moves side to diverged: neither lands.',
    seed: { objects: CORE, refs: [at(MAIN, 'base'), at(SIDE, 'base')] },
    steps: [step(pushOf([upd(MAIN, o('base'), o('ff')), upd(SIDE, o('base'), o('ff'))], true), { tag: 'race', moves: [move(SIDE, o('diverged'))] })],
    expect: [both(one('conflict', 'cas_conflict'))],
    final: [finalAt(MAIN, 'base'), finalAt(SIDE, 'diverged')],
    ...PLAIN,
  },
  {
    id: 'push.non-atomic-partial#one-stale',
    description: 'A non-atomic push of main and side base->ff while another writer moves side to diverged: main lands, side is refused, the client says which.',
    seed: { objects: CORE, refs: [at(MAIN, 'base'), at(SIDE, 'base')] },
    steps: [step(pushOf([upd(MAIN, o('base'), o('ff')), upd(SIDE, o('base'), o('ff'))]), { tag: 'race', moves: [move(SIDE, o('diverged'))] })],
    expect: [both(one('partial', 'push_partial'))],
    final: [finalAt(MAIN, 'ff'), finalAt(SIDE, 'diverged')],
    ...PLAIN,
  },
  {
    id: 'concurrency.ref-created-between-read-and-push#race',
    description: 'A create of refs/heads/new (zero old id) while another writer creates it first: refused, the winner kept.',
    seed: { objects: CORE, refs: [at(MAIN, 'base')] },
    steps: [step(pushOf([upd('refs/heads/new', ZERO, o('ff'))]), { tag: 'race', moves: [move('refs/heads/new', o('diverged'))] })],
    expect: [both(one('conflict', 'cas_conflict'))],
    final: [finalAt(MAIN, 'base'), finalAt('refs/heads/new', 'diverged')],
    ...PLAIN,
  },
  {
    id: 'concurrency.ref-deleted-between-read-and-push#race',
    description: 'An update side base->ff while another writer deletes side: refused, side stays deleted.',
    seed: { objects: CORE, refs: [at(MAIN, 'base'), at(SIDE, 'base')] },
    steps: [step(pushOf([upd(SIDE, o('base'), o('ff'))]), { tag: 'race', moves: [move(SIDE, ZERO)] })],
    expect: [both(one('conflict', 'cas_conflict'))],
    final: [finalAt(MAIN, 'base'), absent(SIDE)],
    ...PLAIN,
  },
  {
    id: 'push.size-limits#pack-over-cap',
    description: 'A 66 MiB pack (three 22 MiB incompressible blobs) against a 64 MiB receive cap: refused, main unchanged.',
    seed: { objects: [...CORE, BIG], refs: [at(MAIN, 'base')] },
    steps: [step(pushOf([upd(MAIN, o('base'), o('big'))]))],
    // ply classifies limit_exceeded from Artifacts' wording only; git http-backend's refusal is "unpacker error" with the
    // reason on band 2, which stock git's stderr shows ("pack exceeds maximum allowed size")
    expect: [{ tag: 'one', ply: one('rejected', 'push_rejected'), git: one('rejected', 'limit_exceeded') }],
    final: [finalAt(MAIN, 'base')],
    ...PLAIN,
  },
  {
    id: 'push.non-fast-forward#with-old-id',
    description: 'A non-fast-forward update ff->diverged naming the current old id (a forced update with a lease): accepted.',
    seed: { objects: CORE, refs: [at(MAIN, 'ff')] },
    steps: [step(pushOf([upd(MAIN, o('ff'), o('diverged'))]))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'diverged')],
    ...PLAIN,
  },
  {
    id: 'push.fast-forward-update#plain',
    description: 'A fast-forward update base->ff with the current old id lands.',
    seed: { objects: CORE, refs: [at(MAIN, 'base')] },
    steps: [step(pushOf([upd(MAIN, o('base'), o('ff'))]))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'ff')],
    ...PLAIN,
  },
  {
    id: 'push.create-ref#plain',
    description: 'A create (zero old id) of refs/heads/new at ff lands.',
    seed: { objects: CORE, refs: [at(MAIN, 'base')] },
    steps: [step(pushOf([upd('refs/heads/new', ZERO, o('ff'))]))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'base'), finalAt('refs/heads/new', 'ff')],
    ...PLAIN,
  },
  {
    id: 'push.delete-ref#plain',
    description: 'A delete (zero new id) of side lands.',
    seed: { objects: CORE, refs: [at(MAIN, 'base'), at(SIDE, 'base')] },
    steps: [step(pushOf([upd(SIDE, o('base'), ZERO)]))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'base'), absent(SIDE)],
    ...PLAIN,
  },
  {
    id: 'push.first-commit-empty-repo#root',
    description: 'The first push to an empty repository creates main from a root commit; HEAD names main.',
    seed: { objects: CORE, refs: [] },
    steps: [step(pushOf([upd(MAIN, ZERO, o('base'))]))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'base')],
    ...PLAIN,
  },
  {
    id: 'tags.lightweight-create#plain',
    description: 'A lightweight tag refs/tags/v1 created at ff (sending ff\'s objects).',
    seed: { objects: CORE, refs: [at(MAIN, 'base')] },
    steps: [step(pushOf([upd('refs/tags/v1', ZERO, o('ff'))]))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'base'), finalAt('refs/tags/v1', 'ff')],
    ...PLAIN,
  },
  {
    id: 'tags.annotated-create#plain',
    description: 'An annotated tag object for base pushed as refs/tags/v1.',
    seed: { objects: [...CORE, tag('t1', 'base', 'v1')], refs: [at(MAIN, 'base')] },
    steps: [step(pushOf([upd('refs/tags/v1', ZERO, o('t1'))]))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'base'), finalAt('refs/tags/v1', 't1')],
    ...PLAIN,
  },
  {
    id: 'tags.delete#plain',
    description: 'A delete of refs/tags/v0.',
    seed: { objects: CORE, refs: [at(MAIN, 'base'), at('refs/tags/v0', 'base')] },
    steps: [step(pushOf([upd('refs/tags/v0', o('base'), ZERO)]))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'base'), absent('refs/tags/v0')],
    ...PLAIN,
  },
  {
    id: 'ancestry.merge-commit-push#two-parents',
    description: 'A two-parent merge of ff and diverged pushed onto main (base->merge): ancestry and merge bases as git computes them.',
    seed: { objects: [...CORE, commit('merge', ['ff', 'diverged'], [text('g.txt', 'diverged\n')])], refs: [at(MAIN, 'base'), at(SIDE, 'diverged')] },
    steps: [step(pushOf([upd(MAIN, o('base'), o('merge'))]))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'merge'), finalAt(SIDE, 'diverged')],
    ...PLAIN,
  },
  {
    id: 'push.many-ref-updates#fifty-creates',
    description: `One push creating ${MANY} branches at ff.`,
    seed: { objects: CORE, refs: [at(MAIN, 'base')] },
    steps: [step(pushOf(nonEmpty(Array.from({ length: MANY }, (_, i) => upd(`refs/heads/many/${String(i).padStart(2, '0')}`, ZERO, o('ff'))))))],
    expect: [LANDED],
    final: [finalAt(MAIN, 'base'), ...Array.from({ length: MANY }, (_, i) => finalAt(`refs/heads/many/${String(i).padStart(2, '0')}`, 'ff'))],
    ...PLAIN,
  },
];
